// ACD Service — extracted computation functions from server/index.js
// These functions were previously defined inline in index.js

import { query } from '../db.js';
import { getGLine } from './queries.js';

// Helper: minutes from bar timestamp
function minsFromBar(ts) {
  const d = new Date(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// Compute ACD signals from NQ price bars for a given date
export async function computeACDFromBars(date, orMinutes, aMultiplier, sustainMinutes) {
  const orEndMin = 9 * 60 + 30 + orMinutes;
  const sessionEndMin = 11 * 60;

  const bars = await query(`
    SELECT ts, open, high, low, close
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND ts >= ($1::date + time '09:30:00')
      AND ts <  ($1::date + time '16:15:00')
    ORDER BY ts ASC
  `, [date]);

  if (bars.rows.length === 0) return null;

  // Opening Range
  const orBars = bars.rows.filter(b => minsFromBar(b.ts) < orEndMin);
  if (orBars.length === 0) return null;
  const orHigh = Math.max(...orBars.map(b => parseFloat(b.high)));
  const orLow  = Math.min(...orBars.map(b => parseFloat(b.low)));
  const orRange = orHigh - orLow;
  if (orRange === 0) return null;

  const aUp   = orHigh + orRange * aMultiplier;
  const aDown = orLow  - orRange * aMultiplier;

  // A signal detection (09:30+orMin to 11:00)
  const postOrBars = bars.rows.filter(b => {
    const m = minsFromBar(b.ts);
    return m >= orEndMin && m < sessionEndMin;
  });

  let aUpReachedMin = null, aDownReachedMin = null;
  let aUpFired = false, aDownFired = false, aUpTime = null, aDownTime = null;

  for (const bar of postOrBars) {
    const barMin = minsFromBar(bar.ts);
    const h = parseFloat(bar.high), l = parseFloat(bar.low);

    if (!aDownReachedMin) {
      if (aUpReachedMin === null && h >= aUp) aUpReachedMin = barMin;
      if (aUpReachedMin !== null) {
        if (l < orHigh) { aUpReachedMin = null; }
        else if (barMin - aUpReachedMin >= sustainMinutes) {
          aUpFired = true;
          aUpTime = new Date(bar.ts).toISOString().slice(11, 16);
          break;
        }
      }
    }

    if (!aUpReachedMin) {
      if (aDownReachedMin === null && l <= aDown) aDownReachedMin = barMin;
      if (aDownReachedMin !== null) {
        if (h > orLow) { aDownReachedMin = null; }
        else if (barMin - aDownReachedMin >= sustainMinutes) {
          aDownFired = true;
          aDownTime = new Date(bar.ts).toISOString().slice(11, 16);
          break;
        }
      }
    }
  }

  // C signal (bar closing above OR High or below OR Low, after 10:00)
  const lateBars = bars.rows.filter(b => minsFromBar(b.ts) >= 10 * 60);
  let cUpConfirmed = false, cDownConfirmed = false;
  for (const bar of lateBars) {
    const c = parseFloat(bar.close);
    if (aUpFired   && c > orHigh) { cUpConfirmed   = true; break; }
    if (aDownFired && c < orLow)  { cDownConfirmed = true; break; }
  }

  // Session close
  const sessionClose = parseFloat(bars.rows[bars.rows.length - 1]?.close) || null;
  const sessionHigh  = Math.max(...bars.rows.map(b => parseFloat(b.high)));
  const sessionLow   = Math.min(...bars.rows.map(b => parseFloat(b.low)));

  // Score
  let score = 0;
  if (aUpFired   && cUpConfirmed)   score =  4;
  else if (aUpFired)                score =  1;
  else if (aDownFired && cDownConfirmed) score = -4;
  else if (aDownFired)              score = -1;

  const aUpLevel   = Math.round(aUp   * 100) / 100;
  const aDownLevel = Math.round(aDown * 100) / 100;

  return { date, orHigh, orLow, orRange, aUpLevel, aDownLevel, aUpFired, aUpTime, aDownFired, aDownTime, cUpConfirmed, cDownConfirmed, score, sessionClose, sessionHigh, sessionLow };
}

// Get best ACD parameters from risk_settings or backtest results
export async function getBestACDParams() {
  try {
    const s = await query('SELECT acd_or_minutes, acd_a_multiplier, acd_sustain_minutes FROM risk_settings ORDER BY id LIMIT 1');
    if (s.rows[0]?.acd_a_multiplier) {
      return { orMins: parseInt(s.rows[0].acd_or_minutes) || 5, aMult: parseFloat(s.rows[0].acd_a_multiplier) || 0.25, sustainMins: parseInt(s.rows[0].acd_sustain_minutes) || 5 };
    }
    // Fall back to best from backtest results
    const best = await query(`SELECT or_minutes, a_multiplier, sustain_minutes FROM acd_backtest_results ORDER BY ev_per_signal DESC NULLS LAST LIMIT 1`);
    if (best.rows.length) return { orMins: best.rows[0].or_minutes, aMult: parseFloat(best.rows[0].a_multiplier), sustainMins: best.rows[0].sustain_minutes };
  } catch(e) {}
  return { orMins: 5, aMult: 0.25, sustainMins: 5 };
}

// Save setup events from a completed session's bar scan
export async function saveSetupEvents(date, timeline, orH, orL, aUp, aDown, sessionHigh, sessionLow) {
  if (!timeline || timeline.length === 0) return;
  const orEndMin = 9 * 60 + 35;
  for (const ev of timeline) {
    try {
      const [hh, mm] = ev.time.split(':').map(Number);
      const minsFromOR = hh * 60 + mm - orEndMin;
      // Normalize setup type (strip attempt suffix for consistency)
      const setupType = ev.event.replace(/ \(attempt \d+\)$/, '').replace(/ \(re-test \d+\)$/, '');
      await query(`
        INSERT INTO acd_setup_events
          (trade_date, setup_type, fired_time, fired_price, minutes_from_or, or_high, or_low, a_up_level, a_down_level, session_high, session_low)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (trade_date, setup_type, fired_time) DO NOTHING
      `, [date, setupType, ev.time + ':00', ev.price, minsFromOR, orH, orL, aUp, aDown, sessionHigh, sessionLow]);
    } catch(e) { /* skip duplicates */ }
  }
}

// Compute structural context levels for a given historical date
// Returns: { gLine, pwHigh, pwLow, pmVAH, pmVAL }
export async function getStructuralLevels(date) {
  const [yr, mo, dy] = date.split('-').map(Number);

  // G-Line: CME weekly open — single definition in services/queries.js
  const gLine = await getGLine(date);

  // Prior week RTH high/low (9:30–16:00, not pre-market)
  const pwQ = await query(`
    SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low
    FROM price_bars_primary WHERE symbol='NQ'
      AND ts::date >= date_trunc('week', ($1::text)::date) - INTERVAL '7 days'
      AND ts::date <  date_trunc('week', ($1::text)::date)
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
      AND EXTRACT(hour FROM ts) < 16
  `, [date]);
  const pwHigh = pwQ.rows[0]?.pw_high || null;
  const pwLow  = pwQ.rows[0]?.pw_low  || null;

  // Prior month value area — volume profile from prior calendar month's RTH bars
  const pmStart = new Date(Date.UTC(yr, mo - 2, 1)).toISOString().split('T')[0]; // 1st of prior month
  const pmEnd   = new Date(Date.UTC(yr, mo - 1, 1)).toISOString().split('T')[0]; // 1st of current month
  const pmVpQ = await query(`
    WITH vp AS (
      SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
      FROM price_bars_primary WHERE symbol='NQ'
        AND ts >= $1::date AND ts < $2::date
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
        AND EXTRACT(hour FROM ts) < 16
      GROUP BY ROUND(low/0.25)*0.25
    ), total AS (SELECT SUM(vol) as t FROM vp),
    poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
    SELECT p.poc_px::float as poc,
      (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv
        FROM vp WHERE px >= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
      (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv
        FROM vp WHERE px <= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
    FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
  `, [pmStart, pmEnd]);
  const pmVAH = pmVpQ.rows[0]?.vah || null;
  const pmVAL = pmVpQ.rows[0]?.val || null;

  return { gLine, pwHigh, pwLow, pmVAH, pmVAL };
}

// Scan a single session's RTH bars for structural level events (G-Line, PW, PM)
export async function scanStructuralEvents(date) {
  try {
    const { gLine, pwHigh, pwLow, pmVAH, pmVAL } = await getStructuralLevels(date);
    if (!gLine && !pwHigh && !pwLow && !pmVAH && !pmVAL) return;

    const acdRow = await query(`SELECT or_high::float, or_low::float, a_up_level::float, a_down_level::float FROM acd_daily_log WHERE trade_date=$1`, [date]);
    if (!acdRow.rows.length) return;
    const { or_high: orH, or_low: orL, a_up_level: aUp, a_down_level: aDown } = acdRow.rows[0];

    const bars = await query(`
      SELECT ts, high::float, low::float, close::float,
             EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as bar_min
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 575 AND 959
      ORDER BY ts
    `, [date]);
    if (!bars.rows.length) return;

    const sessionHigh = Math.max(...bars.rows.map(b => b.high));
    const sessionLow  = Math.min(...bars.rows.map(b => b.low));
    const timeline = [];

    let gLineTouched = false, gLineLost = false, gLineReclaimed = false;
    let pwHighTouched = false, pwHighBroken = false;
    let pwLowTouched  = false, pwLowBroken  = false;
    let pmVAHTouched  = false, pmVAHBroken  = false;
    let pmVALTouched  = false, pmVALBroken  = false;

    for (const bar of bars.rows) {
      const t = new Date(bar.ts).toISOString().slice(11, 16);
      const { high: hi, low: lo, close: cl } = bar;

      if (gLine) {
        if (!gLineTouched && lo <= gLine && hi >= gLine) {
          gLineTouched = true;
          timeline.push({ time: t, event: 'G-Line tested', price: gLine });
        }
        if (!gLineLost && cl < gLine) {
          gLineLost = true;
          timeline.push({ time: t, event: 'G-Line lost', price: cl });
        }
        if (gLineLost && !gLineReclaimed && cl > gLine) {
          gLineReclaimed = true;
          timeline.push({ time: t, event: 'G-Line reclaimed', price: cl });
        }
      }

      if (pwHigh) {
        if (!pwHighTouched && hi >= pwHigh) {
          pwHighTouched = true;
          timeline.push({ time: t, event: 'PW High tested', price: pwHigh });
        }
        if (!pwHighBroken && cl > pwHigh) {
          pwHighBroken = true;
          timeline.push({ time: t, event: 'PW High broken', price: cl });
        }
      }

      if (pwLow) {
        if (!pwLowTouched && lo <= pwLow) {
          pwLowTouched = true;
          timeline.push({ time: t, event: 'PW Low tested', price: pwLow });
        }
        if (!pwLowBroken && cl < pwLow) {
          pwLowBroken = true;
          timeline.push({ time: t, event: 'PW Low broken', price: cl });
        }
      }

      if (pmVAH) {
        if (!pmVAHTouched && hi >= pmVAH) {
          pmVAHTouched = true;
          timeline.push({ time: t, event: 'PM VAH tested', price: pmVAH });
        }
        if (!pmVAHBroken && cl > pmVAH) {
          pmVAHBroken = true;
          timeline.push({ time: t, event: 'PM VAH broken', price: cl });
        }
      }

      if (pmVAL) {
        if (!pmVALTouched && lo <= pmVAL) {
          pmVALTouched = true;
          timeline.push({ time: t, event: 'PM VAL tested', price: pmVAL });
        }
        if (!pmVALBroken && cl < pmVAL) {
          pmVALBroken = true;
          timeline.push({ time: t, event: 'PM VAL broken', price: cl });
        }
      }
    }

    await saveSetupEvents(date, timeline, orH, orL, aUp, aDown, sessionHigh, sessionLow);
    return timeline.length;
  } catch(e) {
    console.error(`scanStructuralEvents error for ${date}:`, e.message);
    return 0;
  }
}

// Run timeline scan for a historical date and save events
export async function scanAndSaveSetupEvents(date) {
  try {
    const logged = await query(`SELECT or_high, or_low, a_up_level, a_down_level FROM acd_daily_log WHERE trade_date=$1`, [date]);
    if (!logged.rows.length || !logged.rows[0].or_high) return;
    const { or_high, or_low, a_up_level, a_down_level } = logged.rows[0];
    const orH = parseFloat(or_high), orL = parseFloat(or_low);
    const aUp = parseFloat(a_up_level), aDown = parseFloat(a_down_level);
    const orEndMin = 9 * 60 + 35;
    const rthEndMin = 16 * 60;

    const bars = await query(`
      SELECT ts, high::float, low::float, close::float,
             EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as bar_min
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN $2 AND $3
      ORDER BY ts
    `, [date, orEndMin, rthEndMin]);
    if (!bars.rows.length) return;

    const postOR = bars.rows;
    const sessionHigh = Math.max(...postOR.map(b => b.high));
    const sessionLow  = Math.min(...postOR.map(b => b.low));

    let aUpTouchTime = null, aUpFiredTimeline = false, aDownFiredTimeline = false;
    let failedAUpCount = 0, failedADownCount = 0;
    let aDownTouchTime = null, cUpLogged = false, cDownLogged = false;
    let aUpCooldown = 0, aDownCooldown = 0;
    const timeline = [];

    for (const bar of postOR) {
      const t = new Date(bar.ts).toISOString().slice(11, 16);
      const bm = bar.bar_min;

      if (aUpCooldown > 0) aUpCooldown--;
      if (aDownCooldown > 0) aDownCooldown--;

      if (!aDownFiredTimeline) {
        if (!aUpFiredTimeline) {
          if (!aUpTouchTime && aUpCooldown === 0 && bar.high >= aUp) { aUpTouchTime = t; timeline.push({ time: t, event: failedAUpCount > 0 ? `A Up tested (re-test ${failedAUpCount+1})` : 'A Up tested', price: aUp }); }
          if (aUpTouchTime) {
            if (bar.low < orH) { failedAUpCount++; timeline.push({ time: t, event: `Failed A Up${failedAUpCount > 1 ? ` (attempt ${failedAUpCount})` : ''}`, price: bar.close }); aUpTouchTime = null; aUpCooldown = 15; }
            else if (bm - (parseInt(aUpTouchTime.split(':')[0])*60+parseInt(aUpTouchTime.split(':')[1])) >= 5) { aUpFiredTimeline = true; timeline.push({ time: t, event: 'A Up fired', price: aUp }); aUpTouchTime = 'fired'; }
          }
        } else {
          if (bar.low < orH && aUpTouchTime !== 'reversed') { aUpTouchTime = 'reversed'; failedAUpCount++; timeline.push({ time: t, event: `Failed A Up${failedAUpCount > 1 ? ` (attempt ${failedAUpCount})` : ''}`, price: bar.close }); aUpCooldown = 15; }
          else if (aUpCooldown === 0 && aUpTouchTime === 'reversed' && bar.high >= aUp) { aUpTouchTime = t; timeline.push({ time: t, event: `A Up tested (re-test ${failedAUpCount+1})`, price: aUp }); }
          else if (aUpTouchTime && aUpTouchTime !== 'reversed' && aUpTouchTime !== 'fired' && bar.low < orH) { failedAUpCount++; timeline.push({ time: t, event: `Failed A Up (attempt ${failedAUpCount})`, price: bar.close }); aUpTouchTime = 'reversed'; aUpCooldown = 15; }
        }
      }
      if (!aUpFiredTimeline && !aDownFiredTimeline) {
        if (!aDownTouchTime && aDownCooldown === 0 && bar.low <= aDown) { aDownTouchTime = t; timeline.push({ time: t, event: failedADownCount > 0 ? `A Down tested (re-test ${failedADownCount+1})` : 'A Down tested', price: aDown }); }
        if (aDownTouchTime) {
          if (bar.high > orL) { failedADownCount++; timeline.push({ time: t, event: `Failed A Down${failedADownCount > 1 ? ` (attempt ${failedADownCount})` : ''}`, price: bar.close }); aDownTouchTime = null; aDownCooldown = 15; }
          else if (bm - (parseInt(aDownTouchTime.split(':')[0])*60+parseInt(aDownTouchTime.split(':')[1])) >= 5) { aDownFiredTimeline = true; timeline.push({ time: t, event: 'A Down fired', price: aDown }); aDownTouchTime = null; }
        }
      }
      if (!cUpLogged && bar.close > orH) { cUpLogged = true; timeline.push({ time: t, event: aUpFiredTimeline ? 'C Up confirmed' : 'C Up (no A)', price: bar.close }); }
      if (!cDownLogged && bar.close < orL) { cDownLogged = true; timeline.push({ time: t, event: aDownFiredTimeline ? 'C Down confirmed' : 'C Down (no A)', price: bar.close }); }
    }

    await saveSetupEvents(date, timeline, orH, orL, aUp, aDown, sessionHigh, sessionLow);
    // Also scan structural levels (G-Line, PW, PM) for this session
    await scanStructuralEvents(date);
  } catch(e) { /* silent */ }
}

// Compute just the OR and A levels from the first 5 bars after 9:30
export async function computeORLevelsOnly(date, aMult) {
  try {
    const orBars = await query(`
      SELECT high::float, low::float
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 574
      ORDER BY ts
    `, [date]);
    if (orBars.rows.length === 0) return null;
    const orHigh = Math.max(...orBars.rows.map(b => b.high));
    const orLow  = Math.min(...orBars.rows.map(b => b.low));
    const orRange = orHigh - orLow;
    if (orRange === 0) return null;
    const aUpLevel   = Math.round((orHigh + orRange * aMult) * 100) / 100;
    const aDownLevel = Math.round((orLow  - orRange * aMult) * 100) / 100;
    await query(`
      INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (trade_date) DO UPDATE SET
        or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6
      WHERE acd_daily_log.or_high IS NULL
    `, [date, orHigh, orLow, aMult, aUpLevel, aDownLevel]);
    return { orHigh, orLow, aUpLevel, aDownLevel };
  } catch(e) { return null; }
}
