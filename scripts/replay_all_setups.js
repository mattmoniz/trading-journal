// Part 2 (full scope) replay: ALL setup-detection rules from server/routes/acd.js
// GET /api/acd/setup-detection, replayed bar-by-bar across all historical sessions
// under the CURRENT rules. REPORT ONLY — does not touch live tables/logic.
//
// Mirrors acd.js ~2150-2920:
//  - Per-bar timeline simulation (9:35-13:00 ET) replicating the A/C fired-state
//    machine (5-min sustain + cooldown), G-Line lost/reclaimed, PW High/Low
//    tested/broken — these drive aUpFired/aDownFired/cUpConf/cDownConf and the
//    FAILED_AUCTION timeline conditions.
//  - Priority-ordered setup evaluation each bar: TRT_LONG_V2/SHORT_V2 > OTD >
//    TRT_MAH > TRT > IB_BULLISH/BEARISH > OPEN_DRIVE > FAILED_AUCTION >
//    BRACKET_BREAKOUT > VALUE_AREA_RESPONSIVE > C_STANDALONE
//  - First-detection-per-type-per-day persistence (mirrors active_setups insert)
//  - Resolution via price walk to T1/stop with same-bar tiebreak, expiry per
//    EXPIRY_WINDOW (acd.js ~2795-2822)

import pg from 'pg';
import fs from 'fs';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const EXPIRY_WINDOW = {
  TRT_SHORT: 50, TRT_LONG: 50, TRT_SHORT_V2: 50, TRT_LONG_V2: 50, TRT_MAH_SHORT: 50, TRT_MAH_LONG: 50,
  OPEN_TEST_DRIVE_SHORT: 45, OPEN_TEST_DRIVE_LONG: 45,
  IB_BULLISH: null, IB_BEARISH: null,
  OPEN_DRIVE_LONG: null, OPEN_DRIVE_SHORT: null,
  C_STANDALONE_UP: null, C_STANDALONE_DOWN: null,
  FAILED_AUCTION_SHORT: 30, FAILED_AUCTION_LONG: 30,
  VALUE_AREA_RESPONSIVE_SHORT: null, VALUE_AREA_RESPONSIVE_LONG: null,
  BRACKET_BREAKOUT_LONG: 960, BRACKET_BREAKOUT_SHORT: 960,
};
const SESSION_END = 780; // 13:00 ET hard cap for non-bracket setups
const EOD = 960; // 16:00 ET for bracket breakout expiry

const t1Guard = (direction, entry, ...candidates) => {
  const isLong = direction === 'LONG';
  for (const c of candidates) {
    if (c != null && isFinite(c) && (isLong ? c > entry : c < entry)) return Math.round(c);
  }
  return null;
};
const t1GuardLabeled = (direction, entry, ...candidates) => {
  const isLong = direction === 'LONG';
  for (const cand of candidates) {
    const c = cand?.value;
    if (c != null && isFinite(c) && (isLong ? c > entry : c < entry)) return { value: Math.round(c), label: cand.label };
  }
  return { value: null, label: 'NO_VIABLE_TARGET' };
};

// ── 1. Sessions ──────────────────────────────────────────────────────────────
const sessionsQ = await q(`
  SELECT trade_date::text, or_high::float as or_high, or_low::float as or_low,
         a_up_level::float as a_up_level, a_down_level::float as a_down_level,
         daily_score::float as daily_score, day_type,
         COUNT(*) OVER (ORDER BY trade_date ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) as bracket_n,
         MAX(or_high::float) OVER (ORDER BY trade_date ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) as bracket_top,
         MIN(or_low::float) OVER (ORDER BY trade_date ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) as bracket_bot,
         SUM(daily_score::float) OVER (ORDER BY trade_date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) as nl30
  FROM acd_daily_log
  WHERE or_high IS NOT NULL AND or_low IS NOT NULL AND trade_date < CURRENT_DATE
  ORDER BY trade_date
`);
const sessions = sessionsQ.rows;

// nl30State + isMahBull/isMahBear: needs each day's own nl30 plus the prior 10 days' nl30 values
for (let i = 0; i < sessions.length; i++) {
  const nl30 = sessions[i].nl30 != null ? Number(sessions[i].nl30) : 0;
  sessions[i].nl30 = nl30;
  sessions[i].nl30State = nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING';
}
for (let i = 0; i < sessions.length; i++) {
  const prior10 = sessions.slice(Math.max(0, i - 10), i);
  const bullSessions = prior10.filter(s => s.nl30 > 9).length;
  const bearSessions = prior10.filter(s => s.nl30 < -9).length;
  sessions[i].isMahBull = sessions[i].nl30 > 15 && bullSessions >= 10;
  sessions[i].isMahBear = sessions[i].nl30 < -15 && bearSessions >= 10;
}

// ── 2. G-Line and Prior-Week High/Low per week ──────────────────────────────
const gLineQ = await q(`
  SELECT (date_trunc('week', ts::date) + interval '1 day')::date::text as week_start,
         (array_agg(open ORDER BY ts ASC))[1]::float as g_line
  FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) >= 18
  GROUP BY date_trunc('week', ts::date)
`);
const gLineByWeek = {};
for (const r of gLineQ.rows) gLineByWeek[r.week_start] = r.g_line;

const pwQ = await q(`
  SELECT (date_trunc('week', ts::date) + interval '7 days')::date::text as week_start,
         MAX(high)::float as pw_high, MIN(low)::float as pw_low
  FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
  GROUP BY date_trunc('week', ts::date)
`);
const pwByWeek = {};
for (const r of pwQ.rows) pwByWeek[r.week_start] = { pwHigh: r.pw_high, pwLow: r.pw_low };

function weekStartOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

// ── 3. All RTH bars (9:30-16:00, etMin 570-960), deduped by ts ──────────────
const firstDate = sessions[0].trade_date;
const lastDate = sessions[sessions.length - 1].trade_date;
const barsQ = await q(`
  SELECT DISTINCT ON (ts) ts, ts::date::text as d,
    (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
    open::float, high::float, low::float, close::float,
    COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol
  FROM price_bars WHERE symbol='NQ' AND ts::date BETWEEN $1 AND $2
    AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 960
  ORDER BY ts, id DESC
`, [firstDate, lastDate]);
const barsByDate = {};
for (const b of barsQ.rows) {
  (barsByDate[b.d] ??= []).push(b);
}
for (const d in barsByDate) barsByDate[d].sort((a, b) => a.et_min - b.et_min);

// ── 4. Prior-day value area (VPOC) per session ──────────────────────────────
async function getPriorDayVA(tradeDate) {
  const priorDayQ = await q(`SELECT MAX(ts::date)::text as d FROM price_bars WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [tradeDate]);
  const priorDay = priorDayQ.rows[0]?.d;
  if (!priorDay) return { pdVAH: null, pdVAL: null, pdPOC: null };
  const vaQ = await q(`
    WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
    total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
    SELECT p.poc_px::float as poc,
      (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
      (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
    FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
  `, [priorDay]);
  if (!vaQ.rows[0]) return { pdVAH: null, pdVAL: null, pdPOC: null };
  return { pdVAH: vaQ.rows[0].vah, pdVAL: vaQ.rows[0].val, pdPOC: vaQ.rows[0].poc };
}

// ── 5. Per-session simulation ────────────────────────────────────────────────
const fired = []; // { trade_date, type, direction, firedAt(etMin), entry, stop, t1, t1Label }
const noViable = [];
const rejected = []; // integrity-guard rejections (negative-risk stop)

for (const sess of sessions) {
  const trade_date = sess.trade_date;
  const orH = sess.or_high, orL = sess.or_low;
  const orRange = orH - orL;
  const aUp = sess.a_up_level, aDown = sess.a_down_level;
  const nl30 = sess.nl30, nl30State = sess.nl30State, isMahBull = sess.isMahBull, isMahBear = sess.isMahBear;
  const bracketN = Number(sess.bracket_n), bracketTop = sess.bracket_top, bracketBot = sess.bracket_bot;

  const { pdVAH, pdVAL, pdPOC } = await getPriorDayVA(trade_date);

  const ws = weekStartOf(trade_date);
  const gLine = gLineByWeek[ws] ?? null;
  const pw = pwByWeek[ws] ?? { pwHigh: null, pwLow: null };
  const pwHigh = pw.pwHigh, pwLow = pw.pwLow;

  const dayBars = barsByDate[trade_date] || [];
  if (dayBars.length < 10) continue; // not enough data for a meaningful session

  const ibBarsFull = dayBars.filter(b => b.et_min >= 570 && b.et_min <= 599);
  const first15Full = dayBars.filter(b => b.et_min >= 570 && b.et_min <= 585);

  // liveOpenVsPrior — static once orH/orL/pdVAH/pdVAL known
  const orMid = (orH + orL) / 2;
  const liveOpenVsPrior = (pdVAH != null && pdVAL != null)
    ? (orMid > pdVAH ? 'ABOVE_VALUE' : orMid < pdVAL ? 'BELOW_VALUE' : 'INSIDE_VALUE')
    : null;

  // ── Dynamic state ──
  let aUpFired = false, aDownFired = false, aUpHeld = false;
  let aUpTouchTime = null, aDownTouchTime = null;
  let aUpCooldown2 = 0, aDownCooldown2 = 0;
  let cUpConf = false, cDownConf = false;
  let gLineLost = false, gLineReclaimed = false;
  let pwHighTested = false, pwHighBroken = false, pwLowTested = false, pwLowBroken = false;
  let sessionHigh = -Infinity, sessionLow = Infinity;
  const firedToday = new Set();

  for (const bar of dayBars) {
    const m = bar.et_min;
    if (m > SESSION_END) break; // no new entries after 13:00 ET

    // sessionHigh/Low over 570-959
    if (m <= 959) { sessionHigh = Math.max(sessionHigh, bar.high); sessionLow = Math.min(sessionLow, bar.low); }

    // ── A/C/G-Line/PW timeline (postOR bars, m>=575) ──
    if (m >= 575) {
      if (aUpCooldown2 > 0) aUpCooldown2--;
      if (aDownCooldown2 > 0) aDownCooldown2--;

      // A Up path
      if (!aDownFired) {
        if (!aUpFired) {
          if (aUpTouchTime === null && aUpCooldown2 === 0 && bar.high >= aUp) aUpTouchTime = m;
          if (aUpTouchTime !== null) {
            if (bar.low < orH) { aUpTouchTime = null; aUpCooldown2 = 15; }
            else if (m - aUpTouchTime >= 5) { aUpFired = true; aUpHeld = true; aUpTouchTime = null; }
          }
        } else {
          if (bar.low < orH && aUpTouchTime !== 'reversed') { aUpTouchTime = 'reversed'; aUpHeld = false; }
          else if (aUpTouchTime === 'reversed' && bar.high >= aUp) { aUpTouchTime = m; }
          else if (aUpTouchTime !== null && aUpTouchTime !== 'reversed' && bar.low < orH) { aUpTouchTime = 'reversed'; }
        }
      }
      // A Down path
      if (!aUpHeld) {
        if (aDownTouchTime === null && aDownCooldown2 === 0 && bar.low <= aDown) aDownTouchTime = m;
        if (aDownTouchTime !== null && !aDownFired) {
          if (bar.high > orL) { aDownTouchTime = null; aDownCooldown2 = 15; }
          else if (m - aDownTouchTime >= 5) { aDownFired = true; aDownTouchTime = null; }
        }
      }
      // C confirmations
      if (!cUpConf && bar.close > orH) cUpConf = true;
      if (!cDownConf && bar.close < orL) cDownConf = true;
      // G-Line
      if (gLine != null) {
        if (!gLineLost && bar.close < gLine) gLineLost = true;
        if (gLineLost && !gLineReclaimed && bar.close > gLine) gLineReclaimed = true;
      }
      // PW High/Low
      if (pwHigh != null) {
        if (!pwHighTested && !pwHighBroken && bar.high >= pwHigh) pwHighTested = true;
        if (!pwHighBroken && bar.close > pwHigh) pwHighBroken = true;
      }
      if (pwLow != null) {
        if (!pwLowTested && !pwLowBroken && bar.low <= pwLow) pwLowTested = true;
        if (!pwLowBroken && bar.close < pwLow) pwLowBroken = true;
      }
    }

    const currentPrice = bar.close;

    // liveOpeningCallType (stable once first15 has >=5 bars)
    const first15 = first15Full.filter(b => b.et_min <= m);
    let liveOpeningCallType = null;
    if (first15.length >= 5) {
      const h15 = Math.max(...first15.map(b => b.high));
      const l15 = Math.min(...first15.map(b => b.low));
      const lastPx = first15[first15.length - 1].close;
      const ext = orRange * 0.3, ext50 = orRange * 0.5;
      const aboveOR = h15 - orH, belowOR = orL - l15;
      if (aboveOR > ext && belowOR > ext) liveOpeningCallType = 'OPEN_TEST_DRIVE';
      else if (aboveOR > ext50 && belowOR < ext * 0.3) liveOpeningCallType = 'OPEN_DRIVE';
      else if (belowOR > ext50 && aboveOR < ext * 0.3) liveOpeningCallType = 'OPEN_DRIVE';
      else if ((aboveOR > ext || belowOR > ext) && Math.abs(lastPx - (orH + orL) / 2) < orRange * 0.4) liveOpeningCallType = 'OPEN_REJECTION_REVERSE';
      else liveOpeningCallType = 'OPEN_AUCTION';
    }

    // ── Priority-ordered setup evaluation ──
    let active = null;

    // SETUP 0a: TRT_LONG_V2
    if (!active && aDownFired && !cDownConf && !cUpConf && orL != null && currentPrice > orL &&
        !firedToday.has('TRT_LONG_V2') && !firedToday.has('TRT_LONG')) {
      const stop = +(aDown - 12).toFixed(0);
      const t1 = t1GuardLabeled('LONG', currentPrice, { value: pdVAH, label: 'Prior Day VAH' }, { value: orH + orRange, label: 'OR Measured Move' });
      active = { type: 'TRT_LONG_V2', direction: 'LONG', entry: +currentPrice.toFixed(0), stop, t1: t1.value, t1Label: t1.label };
    }
    // SETUP 0b: TRT_SHORT_V2
    if (!active && aUpFired && !cUpConf && !cDownConf && orH != null && currentPrice < orH &&
        !firedToday.has('TRT_SHORT_V2') && !firedToday.has('TRT_SHORT')) {
      const stop = +(aUp + 12).toFixed(0);
      const t1 = t1GuardLabeled('SHORT', currentPrice, { value: pdVAL, label: 'Prior Day VAL' }, { value: orL - orRange, label: 'OR Measured Move' });
      active = { type: 'TRT_SHORT_V2', direction: 'SHORT', entry: +currentPrice.toFixed(0), stop, t1: t1.value, t1Label: t1.label };
    }
    // SETUP 0c: OPEN TEST DRIVE
    if (!active && !firedToday.has('OPEN_TEST_DRIVE_SHORT') && !firedToday.has('OPEN_TEST_DRIVE_LONG')) {
      const otdBars = ibBarsFull.filter(b => b.et_min >= 570 && b.et_min <= 584 && b.et_min <= m);
      if (otdBars.length >= 3) {
        const openPx = otdBars[0].open;
        const upProbe = Math.max(...otdBars.map(b => b.high)) - openPx;
        const downProbe = openPx - Math.min(...otdBars.map(b => b.low));
        const probeHigh = Math.max(...otdBars.map(b => b.high));
        const probeLow = Math.min(...otdBars.map(b => b.low));
        const otdShortSignaled = upProbe >= 10 && otdBars.some(b => b.close < orL);
        const otdLongSignaled = downProbe >= 10 && otdBars.some(b => b.close > orH);
        if (otdShortSignaled && currentPrice < orL) {
          const t1 = t1Guard('SHORT', currentPrice, pdVAL, currentPrice - orRange * 1.5);
          active = { type: 'OPEN_TEST_DRIVE_SHORT', direction: 'SHORT', entry: +currentPrice.toFixed(0), stop: +probeHigh.toFixed(0), t1, t1Label: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Range Extension' };
        } else if (otdLongSignaled && currentPrice > orH) {
          const t1 = t1Guard('LONG', currentPrice, pdVAH, currentPrice + orRange * 1.5);
          active = { type: 'OPEN_TEST_DRIVE_LONG', direction: 'LONG', entry: +currentPrice.toFixed(0), stop: +probeLow.toFixed(0), t1, t1Label: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'Composite VAH' };
        }
      }
    }
    // SETUP 1: TRT + MAH
    if (!active && (isMahBull || isMahBear)) {
      if (isMahBull && aUpFired && cUpConf && orL != null && aUp != null && currentPrice < orL && currentPrice < aUp) {
        const stop = +(aUp + 12).toFixed(0);
        const t1 = t1GuardLabeled('SHORT', currentPrice, { value: pdVAL, label: 'Prior Day VAL' }, { value: orL - orRange, label: 'OR Measured Move' });
        active = { type: 'TRT_MAH_SHORT', direction: 'SHORT', entry: +currentPrice.toFixed(0), stop, t1: t1.value, t1Label: t1.label };
      } else if (isMahBear && aDownFired && cDownConf && orH != null && aDown != null && currentPrice > orH && currentPrice > aDown) {
        const stop = +(aDown - 12).toFixed(0);
        const t1 = t1GuardLabeled('LONG', currentPrice, { value: pdVAH, label: 'Prior Day VAH' }, { value: orH + orRange, label: 'OR Measured Move' });
        active = { type: 'TRT_MAH_LONG', direction: 'LONG', entry: +currentPrice.toFixed(0), stop, t1: t1.value, t1Label: t1.label };
      }
    }
    // SETUP 2: TRT (classic)
    if (!active) {
      if (aUpFired && cUpConf && orL != null && aUp != null && currentPrice < orL && currentPrice < aUp) {
        const stop = +(aUp + 12).toFixed(0);
        const t1 = t1GuardLabeled('SHORT', currentPrice, { value: pdVAL, label: 'Prior Day VAL' }, { value: orL - orRange, label: 'OR Measured Move' });
        active = { type: 'TRT_SHORT', direction: 'SHORT', entry: +currentPrice.toFixed(0), stop, t1: t1.value, t1Label: t1.label };
      } else if (aDownFired && cDownConf && orH != null && aDown != null && currentPrice > orH && currentPrice > aDown) {
        const stop = +(aDown - 12).toFixed(0);
        const t1 = t1GuardLabeled('LONG', currentPrice, { value: pdVAH, label: 'Prior Day VAH' }, { value: orH + orRange, label: 'OR Measured Move' });
        active = { type: 'TRT_LONG', direction: 'LONG', entry: +currentPrice.toFixed(0), stop, t1: t1.value, t1Label: t1.label };
      }
    }
    // SETUP 3: IB CONFIRMATION
    if (!active && m >= 600) {
      const ibBars = ibBarsFull.filter(b => b.et_min <= m);
      if (ibBars.length >= 3) {
        const ibHigh = Math.max(...ibBars.map(b => b.high));
        const ibLow = Math.min(...ibBars.map(b => b.low));
        const ibMid = (ibHigh + ibLow) / 2;
        const ibClose = ibBars[ibBars.length - 1].close;
        const totalAsk = ibBars.reduce((s, b) => s + b.ask_vol, 0);
        const totalBid = ibBars.reduce((s, b) => s + b.bid_vol, 0);
        const ibBullish = ibClose > ibMid && totalAsk > totalBid;
        const ibBearish = ibClose < ibMid && totalBid > totalAsk;
        if ((ibBullish || ibBearish) && !firedToday.has('IB_BULLISH') && !firedToday.has('IB_BEARISH')) {
          const isBull = ibBullish;
          const priceSide = isBull ? currentPrice > ibMid : currentPrice < ibMid;
          if (priceSide) {
            const stop = isBull ? +(ibLow - 2).toFixed(0) : +(ibHigh + 2).toFixed(0);
            const t1raw = isBull
              ? (pdVAH && pdVAH > currentPrice ? Math.round(pdVAH) : Math.round(ibHigh + orRange * 0.5))
              : (pdVAL && pdVAL < currentPrice ? Math.round(pdVAL) : Math.round(ibLow - orRange * 0.5));
            active = { type: isBull ? 'IB_BULLISH' : 'IB_BEARISH', direction: isBull ? 'LONG' : 'SHORT', entry: +currentPrice.toFixed(0), stop, t1: t1raw, t1Label: 'IB target', _rawT1: true };
          }
        }
      }
    }
    // SETUP 4: OPEN DRIVE
    if (!active && liveOpeningCallType === 'OPEN_DRIVE' &&
        !firedToday.has('OPEN_DRIVE_LONG') && !firedToday.has('OPEN_DRIVE_SHORT')) {
      const nearOrHigh = Math.abs(currentPrice - orH) <= 15 && currentPrice >= orH - 15 && currentPrice <= orH + 5;
      const nearOrLow = Math.abs(currentPrice - orL) <= 15 && currentPrice <= orL + 15 && currentPrice >= orL - 5;
      const isBull = nearOrHigh && nl30State !== 'BEARISH';
      const isBear = nearOrLow && nl30State !== 'BULLISH';
      if (isBull || isBear) {
        const stop = isBull ? +(orL - 2).toFixed(0) : +(orH + 2).toFixed(0);
        const t1 = isBull
          ? t1Guard('LONG', currentPrice, orH + orRange, currentPrice + orRange)
          : t1Guard('SHORT', currentPrice, orL - orRange, currentPrice - orRange);
        active = { type: isBull ? 'OPEN_DRIVE_LONG' : 'OPEN_DRIVE_SHORT', direction: isBull ? 'LONG' : 'SHORT', entry: +currentPrice.toFixed(0), stop, t1, t1Label: 'OR Measured Move' };
      }
    }
    // SETUP 6: FAILED AUCTION
    if (!active && !firedToday.has('FAILED_AUCTION_LONG') && !firedToday.has('FAILED_AUCTION_SHORT')) {
      if (pwHighTested && !pwHighBroken && currentPrice < (orH || currentPrice + 50)) {
        const t1 = t1Guard('SHORT', currentPrice, pdVAL, currentPrice - orRange * 0.5);
        active = { type: 'FAILED_AUCTION_SHORT', direction: 'SHORT', entry: +currentPrice.toFixed(0), stop: +(currentPrice + orRange * 0.3).toFixed(0), t1, t1Label: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Extension' };
      } else if (pwLowTested && !pwLowBroken && currentPrice > (orL || currentPrice - 50)) {
        const t1 = t1Guard('LONG', currentPrice, pdVAH, currentPrice + orRange * 0.5);
        active = { type: 'FAILED_AUCTION_LONG', direction: 'LONG', entry: +currentPrice.toFixed(0), stop: +(currentPrice - orRange * 0.3).toFixed(0), t1, t1Label: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Extension' };
      } else if (gLineLost && gLineReclaimed) {
        const t1 = t1Guard('LONG', currentPrice, pdVAH, currentPrice + orRange * 0.5);
        active = { type: 'FAILED_AUCTION_LONG', direction: 'LONG', entry: +currentPrice.toFixed(0), stop: +(currentPrice - orRange * 0.5).toFixed(0), t1, t1Label: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Extension', _variant: 'G_LINE_RECLAIM' };
      }
    }
    // SETUP 7: BRACKET BREAKOUT
    if (!active && bracketN >= 3 && pdVAH != null && pdVAL != null &&
        !firedToday.has('BRACKET_BREAKOUT_LONG') && !firedToday.has('BRACKET_BREAKOUT_SHORT')) {
      const breakingUp = bracketTop != null && currentPrice > bracketTop + 5 && nl30State === 'BULLISH';
      const breakingDown = bracketBot != null && currentPrice < bracketBot - 5 && nl30State === 'BEARISH';
      if (breakingUp || breakingDown) {
        const isBull = breakingUp;
        const stop = +(isBull ? (bracketTop - 5) : (bracketBot + 5)).toFixed(0);
        const t1 = isBull
          ? t1Guard('LONG', currentPrice, pdVAH + (pdVAH - pdVAL), pdVAH, currentPrice + orRange)
          : t1Guard('SHORT', currentPrice, pdVAL - (pdVAH - pdVAL), pdVAL, currentPrice - orRange);
        active = { type: isBull ? 'BRACKET_BREAKOUT_LONG' : 'BRACKET_BREAKOUT_SHORT', direction: isBull ? 'LONG' : 'SHORT', entry: +currentPrice.toFixed(0), stop, t1, t1Label: 'Value Area Extension' };
      }
    }
    // SETUP 8: VALUE AREA RESPONSIVE
    if (!active && liveOpenVsPrior === 'INSIDE_VALUE' && liveOpeningCallType !== 'OPEN_DRIVE' && pdVAH != null && pdVAL != null &&
        !firedToday.has('VALUE_AREA_RESPONSIVE_LONG') && !firedToday.has('VALUE_AREA_RESPONSIVE_SHORT')) {
      const nearVAH = Math.abs(currentPrice - pdVAH) <= 20;
      const nearVAL = Math.abs(currentPrice - pdVAL) <= 20;
      if (nearVAH || nearVAL) {
        const isFade = nearVAH;
        const stop = +(isFade ? (pdVAH + 8) : (pdVAL - 8)).toFixed(0);
        const t1 = isFade
          ? t1Guard('SHORT', currentPrice, pdPOC, pdVAL, currentPrice - orRange * 0.5)
          : t1Guard('LONG', currentPrice, pdPOC, pdVAH, currentPrice + orRange * 0.5);
        active = { type: isFade ? 'VALUE_AREA_RESPONSIVE_SHORT' : 'VALUE_AREA_RESPONSIVE_LONG', direction: isFade ? 'SHORT' : 'LONG', entry: +currentPrice.toFixed(0), stop, t1, t1Label: 'Prior Day POC' };
      }
    }
    // SETUP 9: C STANDALONE
    if (!active && !aUpFired && !aDownFired &&
        !firedToday.has('C_STANDALONE_UP') && !firedToday.has('C_STANDALONE_DOWN')) {
      if (currentPrice > orH) {
        const t1 = t1Guard('LONG', currentPrice, pdVAH, currentPrice + orRange);
        active = { type: 'C_STANDALONE_UP', direction: 'LONG', entry: +currentPrice.toFixed(0), stop: +(orL - 4).toFixed(0), t1, t1Label: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Range Extension' };
      } else if (currentPrice < orL) {
        const t1 = t1Guard('SHORT', currentPrice, pdVAL, currentPrice - orRange);
        active = { type: 'C_STANDALONE_DOWN', direction: 'SHORT', entry: +currentPrice.toFixed(0), stop: +(orH + 4).toFixed(0), t1, t1Label: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Range Extension' };
      }
    }

    if (active && !firedToday.has(active.type)) {
      const isLong = active.direction === 'LONG';

      // Integrity guard (mirrors acd.js priority-selection fix): a setup must not
      // fire with the stop on the wrong side of entry (non-positive risk). Reject
      // entirely — do not mark firedToday, so a later bar can still produce a valid
      // fire for this type.
      const riskOk = active.stop == null || (isLong ? active.stop < active.entry : active.stop > active.entry);
      if (!riskOk) {
        rejected.push({ trade_date, type: active.type, direction: active.direction, reason: 'negative-risk', entry: active.entry, stop: active.stop, t1: active.t1 });
        active = null;
      }

      if (active) {
        // Final safety guard (mirrors acd.js ~2832-2841): T1 must be STRICTLY on the
        // correct side of entry (rounded) — T1 == entry (zero reward, rounding
        // collision) is nulled out by the same <= / >= check as a wrong-side T1,
        // and the setup persists with NO_VIABLE_TARGET (stop only) instead of a
        // fake TARGET_HIT.
        let t1 = active.t1;
        let zeroReward = false;
        if (t1 != null) {
          if ((isLong && t1 <= active.entry) || (!isLong && t1 >= active.entry)) {
            zeroReward = (t1 === active.entry);
            t1 = null;
          }
        }

        firedToday.add(active.type);
        if (t1 == null) {
          noViable.push({ trade_date, type: active.type, entry: active.entry, stop: active.stop, t1: active.t1, zeroReward });
        } else {
          fired.push({
            trade_date, type: active.type, direction: active.direction,
            firedEtMin: m, entry: active.entry, stop: active.stop, t1,
            dayType: sess.day_type,
          });
        }
      }
    }
  }
}

// ── 6. Resolution ─────────────────────────────────────────────────────────────
for (const f of fired) {
  const dayBars = barsByDate[f.trade_date] || [];
  const isLong = f.direction === 'LONG';
  const isBracket = f.type.startsWith('BRACKET_BREAKOUT');
  const windowMins = EXPIRY_WINDOW[f.type];
  let expiryMin;
  if (isBracket) expiryMin = EOD;
  else if (windowMins != null) expiryMin = Math.min(f.firedEtMin + windowMins, SESSION_END);
  else expiryMin = SESSION_END;

  const resBars = dayBars.filter(b => b.et_min > f.firedEtMin && b.et_min <= expiryMin);
  let resolution = 'EXPIRED', method = null, pnl = null;
  for (const bar of resBars) {
    const t1Hit = isLong ? bar.high >= f.t1 : bar.low <= f.t1;
    const stopHit = isLong ? bar.low <= f.stop : bar.high >= f.stop;
    if (t1Hit && stopHit) {
      const towardT1 = isLong ? (bar.open > f.entry) : (bar.open < f.entry);
      resolution = towardT1 ? 'TARGET_HIT' : 'STOP_HIT'; method = 'SAME_BAR_TIEBREAK'; break;
    } else if (t1Hit) { resolution = 'TARGET_HIT'; method = 'PRICE_CLEAN'; break; }
    else if (stopHit) { resolution = 'STOP_HIT'; method = 'PRICE_CLEAN'; break; }
  }
  if (resolution === 'TARGET_HIT') pnl = (isLong ? (f.t1 - f.entry) : (f.entry - f.t1)) * 5 - 5;
  else if (resolution === 'STOP_HIT') pnl = (isLong ? (f.stop - f.entry) : (f.entry - f.stop)) * 5 - 5;
  if (pnl != null) pnl = Math.round(pnl * 100) / 100;

  f.resolution = resolution; f.method = method; f.pnl = pnl;
  f.riskPts = isLong ? f.entry - f.stop : f.stop - f.entry;
  f.rewardPts = isLong ? f.t1 - f.entry : f.entry - f.t1;
}

// ── 7. Report ─────────────────────────────────────────────────────────────────
console.log(`Sessions evaluated: ${sessions.length}`);
console.log(`Total setups fired: ${fired.length}`);
console.log(`No-viable-target (T1 guard rejected, incl. zero-reward): ${noViable.length}`);
console.log(`Rejected by integrity guard (negative-risk stop): ${rejected.length}`);

const byType = {};
for (const f of fired) (byType[f.type] ??= []).push(f);

console.log(`\n=== By setup type ===`);
const allTypes = Object.keys(EXPIRY_WINDOW);
for (const type of allTypes) {
  const rows = byType[type] || [];
  if (!rows.length) { console.log(`${type.padEnd(28)} fired 0 times`); continue; }
  const hits = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const stops = rows.filter(r => r.resolution === 'STOP_HIT').length;
  const expired = rows.filter(r => r.resolution === 'EXPIRED').length;
  const decided = hits + stops;
  const wr = decided ? (hits / decided * 100).toFixed(1) : 'n/a';
  const avgRisk = rows.reduce((s, r) => s + r.riskPts, 0) / rows.length;
  const avgReward = rows.reduce((s, r) => s + r.rewardPts, 0) / rows.length;
  const tiebreaks = rows.filter(r => r.method === 'SAME_BAR_TIEBREAK').length;
  const flag = decided < 20 ? '  [LIMITED SAMPLE n<20]' : '';
  console.log(`${type.padEnd(28)} fired=${String(rows.length).padEnd(4)} TARGET_HIT=${String(hits).padEnd(3)} STOP_HIT=${String(stops).padEnd(3)} EXPIRED=${String(expired).padEnd(3)} winRate=${wr}% (n=${decided}) avgRisk=${avgRisk.toFixed(0)}pt avgReward=${avgReward.toFixed(0)}pt tiebreaks=${tiebreaks}${flag}`);
  // Sanity flags
  if (rows.some(r => r.riskPts <= 0)) console.log(`  WARNING: non-positive risk in ${rows.filter(r=>r.riskPts<=0).length} fires`);
  if (rows.some(r => r.rewardPts <= 0)) console.log(`  WARNING: non-positive reward in ${rows.filter(r=>r.rewardPts<=0).length} fires`);
  if (wr !== 'n/a' && (hits/decided === 0 || hits/decided === 1) && decided >= 5) console.log(`  WARNING: ${wr}% win rate at n=${decided} (0% or 100%)`);
}

if (noViable.length) {
  console.log(`\nNo-viable-target detail (T1 null or zero-reward, setup still fires stop-only):`);
  const nvByType = {};
  for (const r of noViable) nvByType[r.type] = (nvByType[r.type]||0)+1;
  for (const [t,c] of Object.entries(nvByType)) console.log(`  ${t}: ${c}`);
  const zeroReward = noViable.filter(r => r.zeroReward);
  if (zeroReward.length) {
    console.log(`  of which zero-reward (rounded T1 == entry): ${zeroReward.length}`);
    for (const r of zeroReward) console.log(`    ${r.trade_date} ${r.type} entry=${r.entry} t1=${r.t1}`);
  }
}

if (rejected.length) {
  console.log(`\nIntegrity-guard rejections (negative-risk stop — setup did not fire):`);
  const rejByType = {};
  for (const r of rejected) rejByType[r.type] = (rejByType[r.type]||0)+1;
  for (const [t,c] of Object.entries(rejByType)) console.log(`  ${t}: ${c}`);
  for (const r of rejected) console.log(`    ${r.trade_date} ${r.type} entry=${r.entry} stop=${r.stop} (risk=${r.direction==='LONG' ? (r.entry-r.stop) : (r.stop-r.entry)})`);
}

// ── Part 3: cross-reference by ground-truth day type ──
console.log(`\n\n=== PART 3: cross-reference by ground-truth day type (all fired setups) ===`);
function summarize(rows, label) {
  const decided = rows.filter(r => r.resolution === 'TARGET_HIT' || r.resolution === 'STOP_HIT');
  const hits = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const stops = rows.filter(r => r.resolution === 'STOP_HIT').length;
  const expired = rows.filter(r => r.resolution === 'EXPIRED').length;
  const wr = decided.length ? (hits/decided.length*100).toFixed(1) : 'n/a';
  const flag = decided.length < 20 ? '  [LIMITED SAMPLE n<20]' : '';
  console.log(`  ${label.padEnd(28)} n=${String(rows.length).padEnd(4)} TARGET_HIT=${String(hits).padEnd(3)} STOP_HIT=${String(stops).padEnd(3)} EXPIRED=${String(expired).padEnd(3)} winRate(decided)=${wr}% (n=${decided.length})${flag}`);
}
console.log(`\nAll setups combined, by day type:`);
for (const dt of ['TREND', 'BALANCE', 'TURBULENT', null]) {
  const subset = fired.filter(r => r.dayType === dt);
  if (subset.length) summarize(subset, dt || '(no day_type)');
}
console.log(`\nPer setup type, by day type (only types with n>=10 overall):`);
for (const type of allTypes) {
  const rows = byType[type] || [];
  if (rows.length < 10) continue;
  console.log(`\n  ${type}:`);
  for (const dt of ['TREND', 'BALANCE', 'TURBULENT']) {
    const subset = rows.filter(r => r.dayType === dt);
    if (subset.length) summarize(subset, `  ${dt}`);
  }
}

fs.writeFileSync('/tmp/all_setups_replay.json', JSON.stringify(fired, null, 2));
await pool.end();
