import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

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
  A_UP_STRONG: null, A_DOWN_STRONG: null,
  A_UP_WEAK: null, A_DOWN_WEAK: null,
  C_PAIRED_LONG: null, C_PAIRED_SHORT: null,
  C_REVERSAL_LONG: null, C_REVERSAL_SHORT: null,
  ABSORPTION_LONG: 20,
  COIL_SURGE_LONG: 10,
  COIL_SURGE_SHORT: 10,
  EMA_SNAPBACK_LONG: 15,
  EMA_SNAPBACK_SHORT: 15,
};

const EOD = 960;

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

function resampleTo5Min(oneMinBars) {
  const fiveMin = {};
  const counts = {};
  for (const b of oneMinBars) {
    const bk = Math.floor(b.et_min / 5) * 5;
    if (!fiveMin[bk]) {
      fiveMin[bk] = { open: b.open, high: b.high, low: b.low, close: b.close, et_min: bk };
    } else {
      fiveMin[bk].high = Math.max(fiveMin[bk].high, b.high);
      fiveMin[bk].low = Math.min(fiveMin[bk].low, b.low);
      fiveMin[bk].close = b.close;
    }
    counts[bk] = (counts[bk] || 0) + 1;
  }
  return { fb: Object.values(fiveMin), counts };
}

async function main() {
  const sessionsQ = await q(`
    SELECT trade_date::text, or_high::float as or_high, or_low::float as or_low,
           a_up_level::float as a_up_level, a_down_level::float as a_down_level,
           daily_score::float as daily_score, day_type,
           COUNT(*) OVER (ORDER BY trade_date ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) as bracket_n,
           MAX(or_high::float) OVER (ORDER BY trade_date ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) as bracket_top,
           MIN(or_low::float) OVER (ORDER BY trade_date ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) as bracket_bot,
           SUM(daily_score::float) OVER (ORDER BY trade_date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) as nl30
    FROM acd_daily_log
    WHERE or_high IS NOT NULL AND or_low IS NOT NULL 
      AND trade_date >= '2025-06-20' AND trade_date <= '2026-06-20'
    ORDER BY trade_date
  `);
  const sessions = sessionsQ.rows;

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

  // G-Line and Week bounds
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
    const dow = d.getUTCDay();
    const diffToMonday = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + diffToMonday);
    return d.toISOString().slice(0, 10);
  }

  // Load Developing Value logs
  const dvLogQ = await q(`
    SELECT trade_date::text as trade_date, vah::float as vah, val::float as val, poc::float as poc,
           migration_dir_vs_prior
    FROM developing_value_log
    ORDER BY trade_date
  `);
  const dvLogs = dvLogQ.rows;

  function getDevelopingValueFor(dateStr) {
    const idx = dvLogs.findIndex(r => r.trade_date === dateStr);
    if (idx === -1) {
      const nearestIdx = dvLogs.findIndex((r, i) => r.trade_date < dateStr && (i === dvLogs.length - 1 || dvLogs[i+1].trade_date >= dateStr));
      return { pd1: dvLogs[nearestIdx] || null, pd2: dvLogs[nearestIdx - 1] || null, pd3: dvLogs[nearestIdx - 2] || null };
    }
    return { pd1: dvLogs[idx - 1] || null, pd2: dvLogs[idx - 2] || null, pd3: dvLogs[idx - 3] || null };
  }

  // Load Bars
  const minDate = sessions[0].trade_date;
  const maxDate = sessions[sessions.length - 1].trade_date;
  const barsQ = await q(`
    SELECT DISTINCT ON (ts) ts, ts::date::text as d,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float,
      COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol
    FROM price_bars WHERE symbol='NQ' AND ts::date BETWEEN $1 AND $2
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 960
    ORDER BY ts, id DESC
  `, [minDate, maxDate]);
  const barsByDate = {};
  for (const b of barsQ.rows) {
    (barsByDate[b.d] ??= []).push(b);
  }
  for (const d in barsByDate) barsByDate[d].sort((a, b) => a.et_min - b.et_min);

  const allFiredSetups = [];

  for (let sessIdx = 0; sessIdx < sessions.length; sessIdx++) {
    const sess = sessions[sessIdx];
    const trade_date = sess.trade_date;
    const orH = sess.or_high, orL = sess.or_low;
    const orRange = orH - orL;
    const aUp = sess.a_up_level, aDown = sess.a_down_level;
    const nl30 = sess.nl30, nl30State = sess.nl30State, isMahBull = sess.isMahBull, isMahBear = sess.isMahBear;
    const bracketN = Number(sess.bracket_n), bracketTop = sess.bracket_top, bracketBot = sess.bracket_bot;

    const { pd1, pd2, pd3 } = getDevelopingValueFor(trade_date);
    const pdVAH = pd1?.vah ?? null, pdVAL = pd1?.val ?? null, pdPOC = pd1?.poc ?? null;
    const pd2VAH = pd2?.vah ?? null, pd2VAL = pd2?.val ?? null;

    const ws = weekStartOf(trade_date);
    const gLine = gLineByWeek[ws] ?? null;
    const pw = pwByWeek[ws] ?? { pwHigh: null, pwLow: null };
    const pwHigh = pw.pwHigh, pwLow = pw.pwLow;

    const dayBars = barsByDate[trade_date] || [];
    if (dayBars.length < 50) continue;

    const ibBarsFull = dayBars.filter(b => b.et_min >= 570 && b.et_min <= 599);
    const first15Full = dayBars.filter(b => b.et_min >= 570 && b.et_min <= 585);

    const orMid = (orH + orL) / 2;
    const liveOpenVsPrior = (pdVAH != null && pdVAL != null)
      ? (orMid > pdVAH ? 'ABOVE_VALUE' : orMid < pdVAL ? 'BELOW_VALUE' : 'INSIDE_VALUE')
      : null;

    let dayPriorFailedDir = null;
    let aUpFired = false, aDownFired = false, aUpHeld = false;
    let aUpTouchTime = null, aDownTouchTime = null;
    let aUpCooldown2 = 0, aDownCooldown2 = 0;
    let cUpConf = false, cDownConf = false;
    let gLineLost = false, gLineReclaimed = false;
    let pwHighTested = false, pwHighBroken = false, pwLowTested = false, pwLowBroken = false;
    let sessionHigh = -Infinity, sessionLow = Infinity;
    const firedToday = new Set();
    const barsSoFar = [];

    for (let barIdx = 0; barIdx < dayBars.length; barIdx++) {
      const bar = dayBars[barIdx];
      const m = bar.et_min;
      barsSoFar.push(bar);

      if (m <= 959) { sessionHigh = Math.max(sessionHigh, bar.high); sessionLow = Math.min(sessionLow, bar.low); }

      let cumPV = 0, cumTV = 0;
      for (const b of barsSoFar) {
        const tp = (b.high + b.low + b.close) / 3;
        const v = b.ask_vol + b.bid_vol;
        cumPV += tp * (v || 1);
        cumTV += (v || 1);
      }
      const liveVwap = cumTV > 0 ? cumPV / cumTV : null;

      if (m >= 575) {
        if (aUpCooldown2 > 0) aUpCooldown2--;
        if (aDownCooldown2 > 0) aDownCooldown2--;

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
        if (!aUpHeld) {
          if (aDownTouchTime === null && aDownCooldown2 === 0 && bar.low <= aDown) aDownTouchTime = m;
          if (aDownTouchTime !== null && !aDownFired) {
            if (bar.high > orL) { aDownTouchTime = null; aDownCooldown2 = 15; }
            else if (m - aDownTouchTime >= 5) { aDownFired = true; aDownTouchTime = null; }
          }
        }
        if (!cUpConf && bar.close > orH) cUpConf = true;
        if (!cDownConf && bar.close < orL) cDownConf = true;
        if (gLine != null) {
          if (!gLineLost && bar.close < gLine) gLineLost = true;
          if (gLineLost && !gLineReclaimed && bar.close > gLine) gLineReclaimed = true;
        }
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

      const { fb, counts } = resampleTo5Min(barsSoFar);
      
      let emaSnapSetup = null;
      if (fb.length >= 14) {
        const poppedFb = [...fb];
        if (poppedFb.length > 0 && counts[poppedFb[poppedFb.length - 1].et_min] < 5) poppedFb.pop();
        if (poppedFb.length >= 14) {
          const fc = poppedFb.map(b => b.close), fh = poppedFb.map(b => b.high), fl = poppedFb.map(b => b.low);
          const ema9 = new Array(fc.length).fill(null);
          const ek = 2 / 10;
          ema9[8] = fc.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
          for (let i = 9; i < fc.length; i++) ema9[i] = fc[i] * ek + ema9[i - 1] * (1 - ek);
          const tr = fc.map((c, i) => i === 0 ? fh[i] - fl[i] : Math.max(fh[i] - fl[i], Math.abs(fh[i] - fc[i - 1]), Math.abs(fl[i] - fc[i - 1])));
          const atr = new Array(fc.length).fill(null);
          atr[13] = tr.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
          for (let i = 14; i < fc.length; i++) atr[i] = tr[i] * (2 / 15) + atr[i - 1] * (1 - 2 / 15);
          const last = fc.length - 1;
          if (ema9[last] != null && atr[last] != null && atr[last] > 0.5) {
            const dev = fc[last] - ema9[last];
            const devATR = Math.abs(dev) / atr[last];
            if (devATR >= 2.0) {
              const isLong = dev < 0;
              const stopDist = Math.round(atr[last]);
              const emaVal = Math.round(ema9[last] * 100) / 100;
              emaSnapSetup = {
                type: isLong ? 'EMA_SNAPBACK_LONG' : 'EMA_SNAPBACK_SHORT',
                direction: isLong ? 'LONG' : 'SHORT',
                entry: currentPrice,
                stop: isLong ? currentPrice - stopDist : currentPrice + stopDist,
                target: emaVal,
                targetLabel: '9 EMA',
                frozenLevel: emaVal,
                resolutionType: 'EMA_REVERT'
              };
            }
          }
        }
      }

      let absorptionSetup = null;
      if (fb.length >= 20 && sess.day_type === 'BALANCE') {
        const poppedFb = [...fb];
        if (poppedFb.length > 0 && counts[poppedFb[poppedFb.length - 1].et_min] < 5) poppedFb.pop();
        if (poppedFb.length >= 20) {
          const fc = poppedFb.map(b => b.close), fh = poppedFb.map(b => b.high), fl = poppedFb.map(b => b.low);
          const absRsi = new Array(fc.length).fill(null);
          let aag = 0, aal = 0;
          for (let i = 1; i <= 14; i++) { const d = fc[i] - fc[i-1]; aag += d > 0 ? d : 0; aal += d < 0 ? -d : 0; }
          aag /= 14; aal /= 14;
          absRsi[14] = aal === 0 ? 100 : 100 - 100 / (1 + aag / aal);
          for (let i = 15; i < fc.length; i++) {
            const d = fc[i] - fc[i-1]; aag = (aag * 13 + (d > 0 ? d : 0)) / 14; aal = (aal * 13 + (d < 0 ? -d : 0)) / 14;
            absRsi[i] = aal === 0 ? 100 : 100 - 100 / (1 + aag / aal);
          }
          const AW = 15;
          const last = fc.length - 1;
          if (last >= AW + 5 && absRsi[last] != null && absRsi[last - AW] != null) {
            const wb = poppedFb.slice(last - AW, last + 1);
            const wH = Math.max(...wb.map(b => b.high)), wL = Math.min(...wb.map(b => b.low));
            const wRange = wH - wL;
            const rsiDrift = absRsi[last] - absRsi[last - AW];
            const priceDrift = fc[last] - fc[last - AW];
            const priceFlat = Math.abs(priceDrift) < wRange * 0.3;
            const lowCluster = wb.filter(b => Math.abs(b.low - wL) < 5).length;
            const isBullAbsorption = lowCluster >= 4 && rsiDrift > 5 && priceFlat;
            if (isBullAbsorption) {
              const stopDist = 25;
              const targetDist = 40;
              absorptionSetup = {
                type: 'ABSORPTION_LONG',
                direction: 'LONG',
                entry: currentPrice,
                stop: currentPrice - stopDist,
                target: currentPrice + targetDist,
                targetLabel: '40pt Runner',
                resolutionType: 'STANDARD'
              };
            }
          }
        }
      }

      let coilSurgeSetup = null;
      if (barsSoFar.length >= 60) {
        const cbars = barsSoFar;
        const cRW = 15;
        const ci = cbars.length - 1;
        let cHi = -Infinity, cLo = Infinity;
        for (let j = ci - cRW + 1; j <= ci; j++) { cHi = Math.max(cHi, cbars[j].high); cLo = Math.min(cLo, cbars[j].low); }
        const rangeOk = (cHi - cLo) < 40;
        if (rangeOk) {
          const cbs = Math.max(0, ci - cRW - 20), cbe = ci - cRW;
          if (cbe - cbs >= 10) {
            const baselineAvgVol = cbars.slice(cbs, cbe).reduce((s, b) => s + (b.ask_vol + b.bid_vol || 0), 0) / (cbe - cbs);
            const recentAvgVol = cbars.slice(ci - cRW + 1, ci + 1).reduce((s, b) => s + (b.ask_vol + b.bid_vol || 0), 0) / cRW;
            const volumeDriedUp = baselineAvgVol > 0 && (recentAvgVol / baselineAvgVol) < 0.40;
            const lastBar = cbars[cbars.length - 1];
            const lastVol = lastBar.ask_vol + lastBar.bid_vol;
            const volumeSurge = baselineAvgVol > 0 && lastVol >= baselineAvgVol * 2.5;
            const nearBoundary = lastBar.high >= cHi - 10 || lastBar.low <= cLo + 10;
            if (volumeDriedUp && volumeSurge && nearBoundary && liveVwap != null) {
              const dist = currentPrice - liveVwap;
              const isLong = dist < 0;
              const targetDist = Math.abs(dist);
              if (targetDist >= 8) {
                const stopDist = Math.max(15, isLong ? currentPrice - (cLo - 5) : (cHi + 5) - currentPrice);
                const dayTypeOk = (sess.day_type === 'TREND' || (isLong && nl30 > 9) || (!isLong && nl30 < -9));
                if (dayTypeOk) {
                  coilSurgeSetup = {
                    type: isLong ? 'COIL_SURGE_LONG' : 'COIL_SURGE_SHORT',
                    direction: isLong ? 'LONG' : 'SHORT',
                    entry: currentPrice,
                    stop: isLong ? currentPrice - stopDist : currentPrice + stopDist,
                    target: liveVwap,
                    targetLabel: 'RTH VWAP',
                    frozenLevel: liveVwap,
                    resolutionType: 'VWAP_REVERT'
                  };
                }
              }
            }
          }
        }
      }

      let active = null;
      const isNL30Counter = (dir) => (dir === 'LONG' && nl30State === 'BEARISH') || (dir === 'SHORT' && nl30State === 'BULLISH');
      const suppressIfCounter = (setup) => (setup && !isNL30Counter(setup.direction)) ? setup : null;

      if (!active) active = suppressIfCounter(emaSnapSetup);
      if (!active) active = absorptionSetup;
      if (!active) active = coilSurgeSetup;

      if (!active && aDownFired && !cDownConf && !cUpConf && orL != null && currentPrice > orL &&
          !firedToday.has('TRT_LONG_V2') && !firedToday.has('TRT_LONG')) {
        const stop = +(aDown - 12).toFixed(0);
        const t1 = t1GuardLabeled('LONG', currentPrice, { value: pdVAH, label: 'Prior Day VAH' }, { value: orH + orRange, label: 'OR Measured Move' });
        active = { type: 'TRT_LONG_V2', direction: 'LONG', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
      }
      if (!active && aUpFired && !cUpConf && !cDownConf && orH != null && currentPrice < orH &&
          !firedToday.has('TRT_SHORT_V2') && !firedToday.has('TRT_SHORT')) {
        const stop = +(aUp + 12).toFixed(0);
        const t1 = t1GuardLabeled('SHORT', currentPrice, { value: pdVAL, label: 'Prior Day VAL' }, { value: orL - orRange, label: 'OR Measured Move' });
        active = { type: 'TRT_SHORT_V2', direction: 'SHORT', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
      }
      if (!active && aUpFired && nl30 >= -9 &&
          !firedToday.has('A_UP_STRONG') && !firedToday.has('A_UP_WEAK') && !firedToday.has('TRT_LONG') && !firedToday.has('TRT_LONG_V2')) {
        const stop = orL != null ? +orL.toFixed(0) : null;
        const t1 = t1GuardLabeled('LONG', currentPrice, { value: pdVAH, label: 'Prior Day VAH' }, { value: orH + orRange, label: 'OR Measured Move' });
        active = { type: 'A_UP_STRONG', direction: 'LONG', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
      }
      if (!active && aDownFired && nl30 <= 9 &&
          !firedToday.has('A_DOWN_STRONG') && !firedToday.has('A_DOWN_WEAK') && !firedToday.has('TRT_SHORT') && !firedToday.has('TRT_SHORT_V2')) {
        const stop = orH != null ? +orH.toFixed(0) : null;
        const t1 = t1GuardLabeled('SHORT', currentPrice, { value: pdVAL, label: 'Prior Day VAL' }, { value: orL - orRange, label: 'OR Measured Move' });
        active = { type: 'A_DOWN_STRONG', direction: 'SHORT', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
      }
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
            active = { type: 'OPEN_TEST_DRIVE_SHORT', direction: 'SHORT', entry: currentPrice, stop: probeHigh, target: t1, targetLabel: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Range Extension', resolutionType: 'STANDARD' };
          } else if (otdLongSignaled && currentPrice > orH) {
            const t1 = t1Guard('LONG', currentPrice, pdVAH, currentPrice + orRange * 1.5);
            active = { type: 'OPEN_TEST_DRIVE_LONG', direction: 'LONG', entry: currentPrice, stop: probeLow, target: t1, targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'Composite VAH', resolutionType: 'STANDARD' };
          }
        }
      }
      if (!active && aUpFired && nl30 < -9 &&
          !firedToday.has('A_UP_STRONG') && !firedToday.has('A_UP_WEAK') && !firedToday.has('TRT_LONG') && !firedToday.has('TRT_LONG_V2')) {
        const stop = orL != null ? +orL.toFixed(0) : null;
        const t1 = t1GuardLabeled('LONG', currentPrice, { value: pdVAH, label: 'Prior Day VAH' }, { value: orH + orRange * 0.5, label: 'OR Half Measured Move' });
        active = { type: 'A_UP_WEAK', direction: 'LONG', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
      }
      if (!active && aDownFired && nl30 > 9 &&
          !firedToday.has('A_DOWN_STRONG') && !firedToday.has('A_DOWN_WEAK') && !firedToday.has('TRT_SHORT') && !firedToday.has('TRT_SHORT_V2')) {
        const stop = orH != null ? +orH.toFixed(0) : null;
        const t1 = t1GuardLabeled('SHORT', currentPrice, { value: pdVAL, label: 'Prior Day VAL' }, { value: orL - orRange * 0.5, label: 'OR Half Measured Move' });
        active = { type: 'A_DOWN_WEAK', direction: 'SHORT', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
      }
      if (!active && (isMahBull || isMahBear)) {
        if (isMahBull && aUpFired && cUpConf && orL != null && aUp != null && currentPrice < orL && currentPrice < aUp) {
          const stop = +(aUp + 12).toFixed(0);
          const t1 = t1GuardLabeled('SHORT', currentPrice, { value: pdVAL, label: 'Prior Day VAL' }, { value: orL - orRange, label: 'OR Measured Move' });
          active = { type: 'TRT_MAH_SHORT', direction: 'SHORT', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
        } else if (isMahBear && aDownFired && cDownConf && orH != null && aDown != null && currentPrice > orH && currentPrice > aDown) {
          const stop = +(aDown - 12).toFixed(0);
          const t1 = t1GuardLabeled('LONG', currentPrice, { value: pdVAH, label: 'Prior Day VAH' }, { value: orH + orRange, label: 'OR Measured Move' });
          active = { type: 'TRT_MAH_LONG', direction: 'LONG', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
        }
      }
      if (!active) {
        if (aUpFired && cUpConf && orL != null && aUp != null && currentPrice < orL && currentPrice < aUp) {
          const stop = +(aUp + 12).toFixed(0);
          const t1 = t1GuardLabeled('SHORT', currentPrice, { value: pdVAL, label: 'Prior Day VAL' }, { value: orL - orRange, label: 'OR Measured Move' });
          active = { type: 'TRT_SHORT', direction: 'SHORT', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
        } else if (aDownFired && cDownConf && orH != null && aDown != null && currentPrice > orH && currentPrice > aDown) {
          const stop = +(aDown - 12).toFixed(0);
          const t1 = t1GuardLabeled('LONG', currentPrice, { value: pdVAH, label: 'Prior Day VAH' }, { value: orH + orRange, label: 'OR Measured Move' });
          active = { type: 'TRT_LONG', direction: 'LONG', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
        }
      }
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
              const stop = isBull ? ibLow - 2 : ibHigh + 2;
              const t1raw = isBull
                ? (pdVAH && pdVAH > currentPrice ? Math.round(pdVAH) : Math.round(ibHigh + orRange * 0.5))
                : (pdVAL && pdVAL < currentPrice ? Math.round(pdVAL) : Math.round(ibLow - orRange * 0.5));
              active = { type: isBull ? 'IB_BULLISH' : 'IB_BEARISH', direction: isBull ? 'LONG' : 'SHORT', entry: currentPrice, stop, target: t1raw, targetLabel: 'IB target', resolutionType: 'STANDARD' };
            }
          }
        }
      }
      if (!active && liveOpeningCallType === 'OPEN_DRIVE' &&
          !firedToday.has('OPEN_DRIVE_LONG') && !firedToday.has('OPEN_DRIVE_SHORT')) {
        const nearOrHigh = Math.abs(currentPrice - orH) <= 15 && currentPrice >= orH - 15 && currentPrice <= orH + 5;
        const nearOrLow = Math.abs(currentPrice - orL) <= 15 && currentPrice <= orL + 15 && currentPrice >= orL - 5;
        const isBull = nearOrHigh && nl30State !== 'BEARISH';
        const isBear = nearOrLow && nl30State !== 'BULLISH';
        if (isBull || isBear) {
          const stop = isBull ? orL - 2 : orH + 2;
          const t1 = isBull
            ? t1Guard('LONG', currentPrice, orH + orRange, currentPrice + orRange)
            : t1Guard('SHORT', currentPrice, orL - orRange, currentPrice - orRange);
          active = { type: isBull ? 'OPEN_DRIVE_LONG' : 'OPEN_DRIVE_SHORT', direction: isBull ? 'LONG' : 'SHORT', entry: currentPrice, stop, target: t1, targetLabel: 'OR Measured Move', resolutionType: 'STANDARD' };
        }
      }
      if (!active && aUpFired && cUpConf && !firedToday.has('C_PAIRED_LONG')) {
        const stop = orL != null ? +orL.toFixed(0) : null;
        const t1 = t1GuardLabeled('LONG', currentPrice, { value: pdVAH, label: 'Prior Day VAH' }, { value: orH + orRange * 1.5, label: 'OR Measured Move 1.5x' });
        active = { type: 'C_PAIRED_LONG', direction: 'LONG', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
      }
      if (!active && aDownFired && cDownConf && !firedToday.has('C_PAIRED_SHORT')) {
        const stop = orH != null ? +orH.toFixed(0) : null;
        const t1 = t1GuardLabeled('SHORT', currentPrice, { value: pdVAL, label: 'Prior Day VAL' }, { value: orL - orRange * 1.5, label: 'OR Measured Move 1.5x' });
        active = { type: 'C_PAIRED_SHORT', direction: 'SHORT', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
      }
      if (!active && aDownFired && cUpConf && !firedToday.has('C_REVERSAL_LONG')) {
        const stop = sessionLow && isFinite(sessionLow) ? +sessionLow.toFixed(0) : (orL != null ? +orL.toFixed(0) : null);
        const t1 = t1GuardLabeled('LONG', currentPrice, { value: pdVAH, label: 'Prior Day VAH' }, { value: orH + orRange, label: 'OR Measured Move' });
        active = { type: 'C_REVERSAL_LONG', direction: 'LONG', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
      }
      if (!active && aUpFired && cDownConf && !firedToday.has('C_REVERSAL_SHORT')) {
        const stop = sessionHigh && isFinite(sessionHigh) ? +sessionHigh.toFixed(0) : (orH != null ? +orH.toFixed(0) : null);
        const t1 = t1GuardLabeled('SHORT', currentPrice, { value: pdVAL, label: 'Prior Day VAL' }, { value: orL - orRange, label: 'OR Measured Move' });
        active = { type: 'C_REVERSAL_SHORT', direction: 'SHORT', entry: currentPrice, stop, target: t1.value, targetLabel: t1.label, resolutionType: 'STANDARD' };
      }
      if (!active && !firedToday.has('FAILED_AUCTION_LONG') && !firedToday.has('FAILED_AUCTION_SHORT')) {
        if (pwHighTested && !pwHighBroken && currentPrice < (orH || currentPrice + 50)) {
          const t1 = t1Guard('SHORT', currentPrice, pdVAL, currentPrice - orRange * 0.5);
          active = { type: 'FAILED_AUCTION_SHORT', direction: 'SHORT', entry: currentPrice, stop: currentPrice + orRange * 0.3, target: t1, targetLabel: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Extension', resolutionType: 'STANDARD' };
        } else if (pwLowTested && !pwLowBroken && currentPrice > (orL || currentPrice - 50)) {
          const t1 = t1Guard('LONG', currentPrice, pdVAH, currentPrice + orRange * 0.5);
          active = { type: 'FAILED_AUCTION_LONG', direction: 'LONG', entry: currentPrice, stop: currentPrice - orRange * 0.3, target: t1, targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Extension', resolutionType: 'STANDARD' };
        } else if (gLineLost && gLineReclaimed) {
          const t1 = t1Guard('LONG', currentPrice, pdVAH, currentPrice + orRange * 0.5);
          active = { type: 'FAILED_AUCTION_LONG', direction: 'LONG', entry: currentPrice, stop: currentPrice - orRange * 0.5, target: t1, targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Extension', resolutionType: 'STANDARD' };
        }
      }
      if (!active && bracketN >= 3 && pdVAH != null && pdVAL != null &&
          !firedToday.has('BRACKET_BREAKOUT_LONG') && !firedToday.has('BRACKET_BREAKOUT_SHORT')) {
        const breakingUp = bracketTop != null && currentPrice > bracketTop + 5 && nl30State === 'BULLISH';
        const breakingDown = bracketBot != null && currentPrice < bracketBot - 5 && nl30State === 'BEARISH';
        if (breakingUp || breakingDown) {
          const isBull = breakingUp;
          const stop = isBull ? bracketTop - 5 : bracketBot + 5;
          const t1 = isBull
            ? t1Guard('LONG', currentPrice, pdVAH + (pdVAH - pdVAL), pdVAH, currentPrice + orRange)
            : t1Guard('SHORT', currentPrice, pdVAL - (pdVAH - pdVAL), pdVAL, currentPrice - orRange);
          active = { type: isBull ? 'BRACKET_BREAKOUT_LONG' : 'BRACKET_BREAKOUT_SHORT', direction: isBull ? 'LONG' : 'SHORT', entry: currentPrice, stop, target: t1, targetLabel: 'Value Area Extension', resolutionType: 'STANDARD' };
        }
      }
      if (!active && liveOpenVsPrior === 'INSIDE_VALUE' && liveOpeningCallType !== 'OPEN_DRIVE' && pdVAH != null && pdVAL != null &&
          !firedToday.has('VALUE_AREA_RESPONSIVE_LONG') && !firedToday.has('VALUE_AREA_RESPONSIVE_SHORT')) {
        const nearVAH = Math.abs(currentPrice - pdVAH) <= 20;
        const nearVAL = Math.abs(currentPrice - pdVAL) <= 20;
        if (nearVAH || nearVAL) {
          const isFade = nearVAH;
          const stop = isFade ? pdVAH + 8 : pdVAL - 8;
          const t1 = isFade
            ? t1Guard('SHORT', currentPrice, pdPOC, pdVAL, currentPrice - orRange * 0.5)
            : t1Guard('LONG', currentPrice, pdPOC, pdVAH, currentPrice + orRange * 0.5);
          active = { type: isFade ? 'VALUE_AREA_RESPONSIVE_SHORT' : 'VALUE_AREA_RESPONSIVE_LONG', direction: isFade ? 'SHORT' : 'LONG', entry: currentPrice, stop, target: t1, targetLabel: 'Prior Day POC', resolutionType: 'STANDARD' };
        }
      }
      if (!active && !aUpFired && !aDownFired &&
          !firedToday.has('C_STANDALONE_UP') && !firedToday.has('C_STANDALONE_DOWN')) {
        if (currentPrice > orH) {
          const t1 = t1Guard('LONG', currentPrice, pdVAH, currentPrice + orRange);
          active = { type: 'C_STANDALONE_UP', direction: 'LONG', entry: currentPrice, stop: orL - 4, target: t1, targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Range Extension', resolutionType: 'STANDARD' };
        } else if (currentPrice < orL) {
          const t1 = t1Guard('SHORT', currentPrice, pdVAL, currentPrice - orRange);
          active = { type: 'C_STANDALONE_DOWN', direction: 'SHORT', entry: currentPrice, stop: orH + 4, target: t1, targetLabel: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Range Extension', resolutionType: 'STANDARD' };
        }
      }

      if (active && !firedToday.has(active.type)) {
        const isLong = active.direction === 'LONG';
        const riskOk = active.stop == null || (isLong ? active.stop < active.entry : active.stop > active.entry);
        if (riskOk) {
          let t1 = active.target;
          if (t1 != null) {
            if ((isLong && t1 <= active.entry) || (!isLong && t1 >= active.entry)) {
              t1 = null;
            }
          }

          if (t1 != null) {
            firedToday.add(active.type);
            
            const levelNear = (lvl, dist = 25) => lvl != null && Math.abs(currentPrice - lvl) <= dist;
            const matches = [
              levelNear(pdVAH) && 'PD-1 VAH',
              levelNear(pdVAL) && 'PD-1 VAL',
              levelNear(pdPOC) && 'PD-1 POC',
              levelNear(pd2VAH) && 'PD-2 VAH',
              levelNear(pd2VAL) && 'PD-2 VAL',
              levelNear(pwLow) && 'PW Low',
              levelNear(pwHigh) && 'PW High',
              levelNear(orMid) && 'OR Mid',
            ].filter(Boolean);

            const confluenceCount = matches.length;
            const ibBars = ibBarsFull.filter(b => b.et_min <= m);
            let isNearAntiConfluence = false;
            if (ibBars.length >= 3) {
              const ibHigh = Math.max(...ibBars.map(b => b.high));
              const ibLow = Math.min(...ibBars.map(b => b.low));
              if (Math.abs(currentPrice - ibHigh) <= 15 || Math.abs(currentPrice - ibLow) <= 15) {
                isNearAntiConfluence = true;
              }
            }

            const isNL30AlignedVal = (active.direction === 'LONG' && nl30 > 9) || (active.direction === 'SHORT' && nl30 < -9);
            const isNL30CounterVal = (active.direction === 'LONG' && nl30 < -9) || (active.direction === 'SHORT' && nl30 > 9);
            const isTightORVal = orRange != null && orRange < 47.5;
            const isWideORVal = orRange != null && orRange > 91.5;

            let isDeathSequence = false;
            if (dayPriorFailedDir === active.direction && (active.type === 'C_STANDALONE_UP' || active.type === 'C_STANDALONE_DOWN')) {
              isDeathSequence = true;
            }

            const isSnapOrAbs = active.type.startsWith('EMA_SNAPBACK') || active.type === 'ABSORPTION_LONG';
            const nearHighProbLevel = levelNear(pd2VAH) || levelNear(pd2VAL) || levelNear(pwLow);
            const hasHighConviction = isSnapOrAbs || nearHighProbLevel || confluenceCount >= 2;

            const setupRecord = {
              trade_date,
              type: active.type,
              direction: active.direction,
              firedEtMin: m,
              entry: active.entry,
              stop: active.stop,
              target: t1,
              resolutionType: active.resolutionType,
              frozenLevel: active.frozenLevel ?? null,
              dayType: sess.day_type,
              confluenceCount,
              confluenceLevels: matches,
              isNearAntiConfluence,
              isNL30Aligned: isNL30AlignedVal,
              isNL30Counter: isNL30CounterVal,
              isTightOR: isTightORVal,
              isWideOR: isWideORVal,
              isDeathSequence,
              hasHighConviction,
              resolution: 'EXPIRED',
              pnlPoints: 0,
              stopPoints: isLong ? active.entry - active.stop : active.stop - active.entry,
            };

            const expiryWindow = EXPIRY_WINDOW[active.type];
            let expiryMin;
            if (active.type.startsWith('BRACKET_BREAKOUT')) expiryMin = EOD;
            else if (expiryWindow != null) expiryMin = Math.min(m + expiryWindow, 960);
            else expiryMin = 960;

            const remainingBars = dayBars.slice(barIdx + 1);
            let resolved = false;

            if (active.resolutionType === 'EMA_REVERT') {
              const entryDist = Math.abs(active.entry - active.frozenLevel);
              for (const b of remainingBars) {
                if (b.et_min > expiryMin) break;
                const stopHit = isLong ? b.low <= active.stop : b.high >= active.stop;
                const reverted = Math.abs(b.close - active.frozenLevel) < entryDist * 0.5;

                if (stopHit) {
                  setupRecord.resolution = 'STOP_HIT';
                  setupRecord.pnlPoints = isLong ? active.stop - active.entry : active.entry - active.stop;
                  resolved = true;
                  dayPriorFailedDir = active.direction;
                  break;
                } else if (reverted) {
                  setupRecord.resolution = 'TARGET_HIT';
                  setupRecord.pnlPoints = Math.abs(b.close - active.entry);
                  resolved = true;
                  break;
                }
              }
              if (!resolved) {
                const lastBar = remainingBars.find(b => b.et_min === expiryMin) || remainingBars[remainingBars.length - 1] || bar;
                setupRecord.resolution = 'EXPIRED';
                setupRecord.pnlPoints = isLong ? lastBar.close - active.entry : active.entry - lastBar.close;
              }
            }
            else if (active.resolutionType === 'VWAP_REVERT') {
              const entryDist = Math.abs(active.entry - active.frozenLevel);
              for (const b of remainingBars) {
                if (b.et_min > expiryMin) break;
                const stopHit = isLong ? b.low <= active.stop : b.high >= active.stop;
                const reverted = Math.abs(b.close - active.frozenLevel) < entryDist * 0.5;

                if (stopHit) {
                  setupRecord.resolution = 'STOP_HIT';
                  setupRecord.pnlPoints = isLong ? active.stop - active.entry : active.entry - active.stop;
                  resolved = true;
                  dayPriorFailedDir = active.direction;
                  break;
                } else if (reverted) {
                  setupRecord.resolution = 'TARGET_HIT';
                  setupRecord.pnlPoints = Math.abs(b.close - active.entry);
                  resolved = true;
                  break;
                }
              }
              if (!resolved) {
                const lastBar = remainingBars.find(b => b.et_min === expiryMin) || remainingBars[remainingBars.length - 1] || bar;
                setupRecord.resolution = 'EXPIRED';
                setupRecord.pnlPoints = isLong ? lastBar.close - active.entry : active.entry - lastBar.close;
              }
            }
            else {
              for (const b of remainingBars) {
                if (b.et_min > expiryMin) break;
                const t1Hit = isLong ? b.high >= t1 : b.low <= t1;
                const stopHit = isLong ? b.low <= active.stop : b.high >= active.stop;

                if (t1Hit && stopHit) {
                  const towardT1 = isLong ? (bar.open > active.entry) : (bar.open < active.entry);
                  setupRecord.resolution = towardT1 ? 'TARGET_HIT' : 'STOP_HIT';
                  setupRecord.pnlPoints = towardT1 
                    ? Math.abs(t1 - active.entry) 
                    : (isLong ? active.stop - active.entry : active.entry - active.stop);
                  if (!towardT1) dayPriorFailedDir = active.direction;
                  resolved = true;
                  break;
                } else if (t1Hit) {
                  setupRecord.resolution = 'TARGET_HIT';
                  setupRecord.pnlPoints = Math.abs(t1 - active.entry);
                  resolved = true;
                  break;
                } else if (stopHit) {
                  setupRecord.resolution = 'STOP_HIT';
                  setupRecord.pnlPoints = isLong ? active.stop - active.entry : active.entry - active.stop;
                  dayPriorFailedDir = active.direction;
                  resolved = true;
                  break;
                }
              }
              if (!resolved) {
                const lastBar = remainingBars.find(b => b.et_min === expiryMin) || remainingBars[remainingBars.length - 1] || bar;
                setupRecord.resolution = 'EXPIRED';
                setupRecord.pnlPoints = isLong ? lastBar.close - active.entry : active.entry - lastBar.close;
              }
            }

            allFiredSetups.push(setupRecord);
          }
        }
      }
    }
  }

  const expMap = {};
  for (const t of allFiredSetups) {
    const key = `${t.type}|${t.dayType || 'UNKNOWN'}`;
    if (!expMap[key]) expMap[key] = [];
    expMap[key].push(t.pnlPoints);
  }

  const dtExpectancies = {};
  for (const [key, pnls] of Object.entries(expMap)) {
    const avg = pnls.reduce((s, v) => s + v, 0) / pnls.length;
    dtExpectancies[key] = { n: pnls.length, avgPts: avg };
  }

  const optimizedSim = runPropSimulation(allFiredSetups, 'optimized', dtExpectancies);
  console.log(`Total Trades Taken in Day-Type Optimized Sizing: ${optimizedSim.totalTrades}`);

  // Analyze PnL contribution by Setup Type
  const performanceByType = {};
  for (const t of optimizedSim.results) {
    if (!performanceByType[t.type]) {
      performanceByType[t.type] = { count: 0, wins: 0, losses: 0, netPnl: 0 };
    }
    const stat = performanceByType[t.type];
    stat.count++;
    stat.netPnl += t.pnl;
    if (t.resolution === 'TARGET_HIT') {
      stat.wins++;
    } else {
      stat.losses++;
    }
  }

  const outputRows = Object.entries(performanceByType).map(([type, stat]) => ({
    'Setup Type': type,
    'Trades': stat.count,
    'Win Rate': ((stat.wins / stat.count) * 100).toFixed(1) + '%',
    'Net PnL (USD)': '$' + stat.netPnl.toFixed(2),
    'pnlRaw': stat.netPnl
  })).sort((a, b) => b.pnlRaw - a.pnlRaw);

  console.log('\n=== PERFORMANCE BY SETUP TYPE (DAY-TYPE OPTIMIZED SIZING) ===');
  console.table(outputRows.map(r => {
    const { pnlRaw, ...rest } = r;
    return rest;
  }));

  await pool.end();
}

function runPropSimulation(trades, sizingType, dtExpectancies) {
  let equity = 2000;
  let maxEquity = 2000;
  let drawdownThreshold = 500;
  let isDrawdownFrozen = false;
  let blown = false;
  let blownDate = null;
  
  let wins = 0;
  let losses = 0;
  let totalTrades = 0;
  let grossWins = 0;
  let grossLosses = 0;

  let lastDay = null;
  let dayClosedPnl = 0;
  let dllHits = 0;
  let dayStopFired = false;
  
  const results = [];
  
  for (const trade of trades) {
    if (blown) continue;

    if (trade.trade_date !== lastDay) {
      lastDay = trade.trade_date;
      dayClosedPnl = 0;
      dayStopFired = false;
    }

    if (dayStopFired && sizingType !== 'baseline') {
      continue; 
    }
    
    let size = 0;
    
    if (sizingType === 'baseline') {
      size = 1;
    } else {
      const isNegativeEdge = 
        trade.type === 'IB_BULLISH' ||
        trade.type === 'C_STANDALONE_UP' ||
        trade.type === 'VALUE_AREA_RESPONSIVE_LONG' ||
        trade.type === 'TRT_SHORT' ||
        trade.isNL30Counter || 
        (trade.isTightOR && (trade.type === 'BRACKET_BREAKOUT_LONG' || trade.type === 'OPEN_TEST_DRIVE_LONG')) ||
        (trade.isWideOR && (trade.type === 'TRT_SHORT' || trade.type === 'TRT_LONG')) ||
        trade.isNearAntiConfluence ||
        trade.isDeathSequence;
        
      if (isNegativeEdge) {
        size = 0;
      } else {
        const baseSize = Math.max(1, Math.floor(equity / 1000));
        
        if (sizingType === 'proper') {
          size = Math.min(10, baseSize);
        } else if (sizingType === 'aggressive') {
          if (trade.hasHighConviction) {
            size = Math.min(15, baseSize * 2);
          } else {
            size = Math.min(10, baseSize);
          }
        } else if (sizingType === 'optimized') {
          const key = `${trade.type}|${trade.dayType || 'UNKNOWN'}`;
          const exp = dtExpectancies[key];
          
          if (!exp || exp.avgPts <= 0) {
            size = 0;
          } else if (exp.avgPts > 15 && trade.hasHighConviction) {
            size = Math.min(15, baseSize * 2);
          } else {
            size = Math.min(10, baseSize);
          }
        }
      }
    }
    
    if (size === 0) continue;
    
    const pointValue = 2;
    const commission = 1.50;
    
    let tradePnl = 0;
    if (trade.resolution === 'TARGET_HIT') {
      tradePnl = (trade.pnlPoints * pointValue) * size - (commission * size);
      grossWins += tradePnl;
      wins++;
    } else if (trade.resolution === 'STOP_HIT') {
      tradePnl = (trade.pnlPoints * pointValue) * size - (commission * size);
      grossLosses += Math.abs(tradePnl);
      losses++;
    } else {
      tradePnl = (trade.pnlPoints * pointValue) * size - (commission * size);
      if (tradePnl > 0) {
        grossWins += tradePnl;
        wins++;
      } else {
        grossLosses += Math.abs(tradePnl);
        losses++;
      }
    }
    
    equity += tradePnl;
    dayClosedPnl += tradePnl;
    totalTrades++;
    
    const currentDLL = sizingType === 'baseline' ? Infinity : Math.max(400, Math.floor(equity / 2000) * 400);
    if (dayClosedPnl <= -currentDLL && sizingType !== 'baseline') {
      dayStopFired = true;
      dllHits++;
    }

    if (equity > maxEquity) {
      maxEquity = equity;
      if (!isDrawdownFrozen) {
        drawdownThreshold = maxEquity - 1500;
        if (maxEquity >= 5000) {
          isDrawdownFrozen = true;
          drawdownThreshold = 3500;
        }
      }
    }
    
    let activeThreshold = drawdownThreshold;
    if (sizingType === 'baseline') {
      activeThreshold = maxEquity - 1500;
    }

    if (equity <= activeThreshold) {
      blown = true;
      blownDate = trade.trade_date;
      equity = 0;
    }
    
    results.push({
      trade_date: trade.trade_date,
      type: trade.type,
      direction: trade.direction,
      size,
      pnl: tradePnl,
      equity,
      resolution: trade.resolution,
      maePoints: trade.maePoints,
    });
  }
  
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins;
  const maxDrawdown = maxEquity - equity;
  
  return {
    blown,
    blownDate,
    finalEquity: equity,
    maxEquity,
    maxDrawdown,
    totalTrades,
    wins,
    losses,
    winRate: totalTrades > 0 ? wins / totalTrades : 0,
    profitFactor,
    dllHits,
    results
  };
}

main().catch(console.error);
