// =============================================================================
// PRIOR DAY IB / OR / SESSION MID LEVEL FADE AUDIT
// Bar-by-bar replay over 180 days. Tests PD_IB_HIGH, PD_IB_LOW, PD_IB_MID,
// PD_OR_HIGH, PD_OR_LOW, PD_OR_MID, PD_SESSION_MID as fade levels.
// Includes: touch frequency, confluence with today's IB, inside/outside range.
// =============================================================================

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;   // $2/pt NQ micro
const COMMISSION = 1;       // $1 round trip
const DLL = 400;            // daily loss limit
const PROX = 10;            // 10pt proximity = "touch"
const FADE_TARGET = 20;     // default 20pt target for WR calc
const MFE_HORIZON_SHORT = 30;
const MFE_HORIZON_LONG = 60;
const WINDOW_DAYS = 180;
const DLL_MAX_STOP = Math.floor((DLL / 2 - COMMISSION) / PNL_PER_POINT); // 99pt

// ─── Helpers ─────────────────────────────────────────────────────────────────

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function pctiles(arr) {
  return {
    p10: percentile(arr, 10),
    p25: percentile(arr, 25),
    p50: percentile(arr, 50),
    p75: percentile(arr, 75),
    p90: percentile(arr, 90),
  };
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function pad(s, n) { return String(s).padStart(n); }
function padR(s, n) { return String(s).padEnd(n); }
function fmt(v, d = 1) { return v.toFixed(d); }

// ─── Load All Data ───────────────────────────────────────────────────────────

async function loadData() {
  console.log('Loading data...');

  // 1. RTH bars for last 180+ trading days (need prior day for computing levels)
  const barsQ = await query(`
    SELECT ts, ts::date::text as d,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float, volume::bigint as vol,
      COALESCE(ask_volume, 0)::bigint as ask_vol,
      COALESCE(bid_volume, 0)::bigint as bid_vol
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND ts::date >= CURRENT_DATE - ($1 + 30) * INTERVAL '1 day'
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `, [WINDOW_DAYS]);

  const barsByDate = {};
  for (const b of barsQ.rows) {
    (barsByDate[b.d] ??= []).push(b);
  }
  const allDates = Object.keys(barsByDate).sort();
  console.log(`  Bars: ${barsQ.rows.length} across ${allDates.length} days`);

  // 2. Developing value log (session_high, session_low)
  const vaQ = await query(`
    SELECT trade_date::text as d, poc::float, vah::float, val::float,
      session_high::float as sh, session_low::float as sl, session_close::float as sc
    FROM developing_value_log
    ORDER BY trade_date
  `);
  const vaByDate = {};
  for (const r of vaQ.rows) vaByDate[r.d] = r;
  console.log(`  Value area: ${vaQ.rows.length} days`);

  // 3. ACD daily log (OR levels, day type)
  const acdQ = await query(`
    SELECT trade_date::text as d, or_high::float, or_low::float, day_type, daily_score
    FROM acd_daily_log
    ORDER BY trade_date
  `);
  const acdByDate = {};
  for (const r of acdQ.rows) acdByDate[r.d] = r;
  console.log(`  ACD: ${acdQ.rows.length} days`);

  // Determine 180-day window
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const tradingDates = allDates.filter(d => d >= cutoffStr);
  console.log(`  Trading days in window: ${tradingDates.length} (cutoff ${cutoffStr})`);

  return { barsByDate, allDates, vaByDate, acdByDate, tradingDates };
}

// ─── Compute Prior Day IB/OR from bars ───────────────────────────────────────

function computePriorDayLevels(priorDate, barsByDate, vaByDate) {
  const bars = barsByDate[priorDate];
  if (!bars || bars.length < 30) return null;

  // Prior day IB: first 60 minutes (9:30-10:30 = et_min 570-629)
  const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
  if (ibBars.length < 30) return null;

  const pdIBHigh = Math.max(...ibBars.map(b => b.high));
  const pdIBLow = Math.min(...ibBars.map(b => b.low));
  const pdIBMid = (pdIBHigh + pdIBLow) / 2;

  // Prior day OR: first 5 minutes (9:30-9:35 = et_min 570-574)
  const orBars = bars.filter(b => b.et_min >= 570 && b.et_min < 575);
  let pdORHigh = null, pdORLow = null, pdORMid = null;
  if (orBars.length > 0) {
    pdORHigh = Math.max(...orBars.map(b => b.high));
    pdORLow = Math.min(...orBars.map(b => b.low));
    pdORMid = (pdORHigh + pdORLow) / 2;
  }

  // Prior day session mid
  const pdVA = vaByDate[priorDate];
  let pdSessionMid = null;
  if (pdVA && pdVA.sh && pdVA.sl) {
    pdSessionMid = (pdVA.sh + pdVA.sl) / 2;
  }

  return { pdIBHigh, pdIBLow, pdIBMid, pdORHigh, pdORLow, pdORMid, pdSessionMid };
}

// ─── Level Definitions ───────────────────────────────────────────────────────

function getPDLevels(priorDate, barsByDate, vaByDate) {
  const pd = computePriorDayLevels(priorDate, barsByDate, vaByDate);
  if (!pd) return [];

  const levels = [];

  // All PD levels available at open (570)
  levels.push({ name: 'PD_IB_HIGH', value: pd.pdIBHigh, availableAt: 570 });
  levels.push({ name: 'PD_IB_LOW', value: pd.pdIBLow, availableAt: 570 });
  levels.push({ name: 'PD_IB_MID', value: pd.pdIBMid, availableAt: 570 });

  if (pd.pdORHigh != null) {
    levels.push({ name: 'PD_OR_HIGH', value: pd.pdORHigh, availableAt: 570 });
    levels.push({ name: 'PD_OR_LOW', value: pd.pdORLow, availableAt: 570 });
    levels.push({ name: 'PD_OR_MID', value: pd.pdORMid, availableAt: 570 });
  }

  if (pd.pdSessionMid != null) {
    levels.push({ name: 'PD_SESSION_MID', value: pd.pdSessionMid, availableAt: 570 });
  }

  return levels;
}

// ─── Replay Engine ───────────────────────────────────────────────────────────

function replayDay(date, bars, levels, dayType, devRange, todayIBHigh, todayIBLow) {
  const touches = [];
  const touchedLevels = new Set();
  const retouchTracker = {};

  // Track developing range for inside/outside analysis
  let devHigh = -Infinity;
  let devLow = Infinity;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Update developing range
    devHigh = Math.max(devHigh, bar.high);
    devLow = Math.min(devLow, bar.low);

    // Skip first 10 bars for entry (need lookback for direction)
    if (i < 10) continue;

    for (const level of levels) {
      if (bar.et_min < level.availableAt) continue;

      const dist = bar.close - level.value;
      if (Math.abs(dist) > PROX) continue;

      const isFirstTouch = !touchedLevels.has(level.name);
      const lastRetouchBar = retouchTracker[level.name] ?? -999;

      // Debounce: require 10+ bars between touches of same level
      if (i - lastRetouchBar < 10) continue;

      // Determine approach direction from prior 5 bars
      const lookback = Math.min(5, i);
      const priorCloses = bars.slice(i - lookback, i).map(b => b.close);
      const priorAvg = mean(priorCloses);
      const fromBelow = priorAvg < level.value - 3;
      const fromAbove = priorAvg > level.value + 3;
      if (!fromBelow && !fromAbove) continue;

      // Fade direction: approach from below = SHORT (expect rejection), from above = LONG
      const fadeDir = fromBelow ? 'SHORT' : 'LONG';
      const entryPx = bar.close;
      const entryIdx = i;

      // Delta state at touch
      const touchDelta = Number(bar.ask_vol) - Number(bar.bid_vol);
      const deltaOpposing = fromBelow ? touchDelta < 0 : touchDelta > 0;

      // AM vs PM
      const isAM = bar.et_min < 720; // 12:00 ET = minute 720

      // Time-of-day bucket
      const todBucket = Math.floor(bar.et_min / 30) * 30;

      // Is level inside or outside today's developing range?
      const levelInsideRange = level.value >= devLow && level.value <= devHigh;

      // Confluence: is this PD_IB level near today's IB level? (within 30pt)
      let confluenceWithTodayIB = false;
      if (todayIBHigh != null && todayIBLow != null) {
        if (level.name === 'PD_IB_HIGH' && Math.abs(level.value - todayIBHigh) <= 30) {
          confluenceWithTodayIB = true;
        }
        if (level.name === 'PD_IB_LOW' && Math.abs(level.value - todayIBLow) <= 30) {
          confluenceWithTodayIB = true;
        }
      }

      // Build forward bar path
      const fwdBars = [];
      let mfe30 = 0, mae30 = 0, mfe60 = 0, mae60 = 0;
      let timeToPeakMFE30 = 0, timeToPeakMFE60 = 0;
      let fadeSuccess10 = false, fadeSuccess20 = false, fadeSuccess30 = false, fadeSuccess40 = false;

      for (let j = 1; j <= MFE_HORIZON_LONG && (entryIdx + j) < bars.length; j++) {
        const futureBar = bars[entryIdx + j];
        let favOnBar, advOnBar;
        if (fadeDir === 'LONG') {
          favOnBar = futureBar.high - entryPx;
          advOnBar = entryPx - futureBar.low;
        } else {
          favOnBar = entryPx - futureBar.low;
          advOnBar = futureBar.high - entryPx;
        }
        fwdBars.push({ fav: favOnBar, adv: advOnBar });

        if (j <= MFE_HORIZON_SHORT) {
          if (favOnBar > mfe30) { mfe30 = favOnBar; timeToPeakMFE30 = j; }
          mae30 = Math.max(mae30, advOnBar);
          if (!fadeSuccess10 && favOnBar >= 10) fadeSuccess10 = true;
          if (!fadeSuccess20 && favOnBar >= 20) fadeSuccess20 = true;
          if (!fadeSuccess30 && favOnBar >= 30) fadeSuccess30 = true;
          if (!fadeSuccess40 && favOnBar >= 40) fadeSuccess40 = true;
        }
        if (favOnBar > mfe60) { mfe60 = favOnBar; timeToPeakMFE60 = j; }
        mae60 = Math.max(mae60, advOnBar);
      }

      touchedLevels.add(level.name);
      retouchTracker[level.name] = i;

      touches.push({
        date,
        levelName: level.name,
        levelValue: level.value,
        fadeDir,
        entryPx,
        entryBarIdx: i,
        entryMinute: bar.et_min,
        todBucket,
        isFirstTouch,
        isAM,
        dayType: dayType || 'UNKNOWN',
        devRange,
        deltaOpposing,
        levelInsideRange,
        confluenceWithTodayIB,
        mfe30, mae30, mfe60, mae60,
        timeToPeakMFE30, timeToPeakMFE60,
        fadeSuccess10, fadeSuccess20, fadeSuccess30, fadeSuccess40,
        fwdBars,
      });
    }
  }

  return touches;
}

// ─── Optimal Stop/Target Optimizer ──────────────────────────────────────────

function simulateTrade(touch, stop, target, horizon = MFE_HORIZON_SHORT) {
  const bars = touch.fwdBars;
  const limit = Math.min(horizon, bars.length);
  for (let j = 0; j < limit; j++) {
    const b = bars[j];
    const stopHit = b.adv >= stop;
    const targetHit = b.fav >= target;
    if (stopHit && targetHit) return 'LOSS'; // conservative: same-bar = loss
    if (stopHit) return 'LOSS';
    if (targetHit) return 'WIN';
  }
  return 'SCRATCH';
}

function optimizeStopTarget(touches, maxStopOverride = null) {
  if (!touches.length) return { bestStop: 0, bestTarget: 0, bestEV: 0, bestWR: 0, bestN: 0 };
  const maes30 = touches.map(t => t.mae30);
  const mfes30 = touches.map(t => t.mfe30);
  const maxStop = maxStopOverride ?? Math.max(percentile(maes30, 95), 100);
  const maxTarget = Math.max(percentile(mfes30, 90), 80);

  let bestEV = -Infinity, bestStop = 0, bestTarget = 0, bestWR = 0, bestN = 0;

  for (let stop = 10; stop <= maxStop; stop += 5) {
    for (let target = 10; target <= maxTarget; target += 5) {
      let wins = 0, losses = 0, scratches = 0;
      for (const t of touches) {
        const result = simulateTrade(t, stop, target);
        if (result === 'WIN') wins++;
        else if (result === 'LOSS') losses++;
        else scratches++;
      }
      const n = wins + losses + scratches;
      const totalPnL = wins * (target * PNL_PER_POINT - COMMISSION)
                     - losses * (stop * PNL_PER_POINT + COMMISSION)
                     - scratches * COMMISSION;
      const ev = totalPnL / n;
      const wr = wins / (wins + losses || 1);
      if (ev > bestEV) {
        bestEV = ev;
        bestStop = stop;
        bestTarget = target;
        bestWR = wr;
        bestN = n;
      }
    }
  }

  return { bestStop, bestTarget, bestEV, bestWR, bestN };
}

function optimizeDLL(touches) {
  // DLL-safe: cap stop at 95pt ($191 risk) per task spec
  const maxStop = 95;
  const result = optimizeStopTarget(touches, maxStop);
  const dollarRisk = result.bestStop * PNL_PER_POINT + COMMISSION;
  return { ...result, dollarRisk };
}

// Fade WR at specific stop/target combos for comparison
function fadeWRAtStop(touches, stop, target) {
  if (!touches.length) return { wr: 0, n: 0, wins: 0, losses: 0, scratches: 0, ev: 0 };
  let wins = 0, losses = 0, scratches = 0;
  for (const t of touches) {
    const result = simulateTrade(t, stop, target);
    if (result === 'WIN') wins++;
    else if (result === 'LOSS') losses++;
    else scratches++;
  }
  const n = wins + losses + scratches;
  const wr = wins / (wins + losses || 1);
  const totalPnL = wins * (target * PNL_PER_POINT - COMMISSION)
                 - losses * (stop * PNL_PER_POINT + COMMISSION)
                 - scratches * COMMISSION;
  const ev = totalPnL / n;
  return { wr, n, wins, losses, scratches, ev };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(150));
  console.log('PRIOR DAY IB / OR / SESSION MID LEVEL FADE AUDIT');
  console.log(`Window: ${WINDOW_DAYS} days | Proximity: ${PROX}pt | Fade target: ${FADE_TARGET}pt`);
  console.log(`PNL/pt: $${PNL_PER_POINT} | Commission: $${COMMISSION} | DLL: $${DLL}`);
  console.log('Levels: PD_IB_HIGH, PD_IB_LOW, PD_IB_MID, PD_OR_HIGH, PD_OR_LOW, PD_OR_MID, PD_SESSION_MID');
  console.log('='.repeat(150));

  const { barsByDate, allDates, vaByDate, acdByDate, tradingDates } = await loadData();

  // ─── Touch frequency tracking ─────────────────────────────────────────────
  const touchFreq = {}; // level -> { daysWithTouch, totalDays }
  for (const name of ['PD_IB_HIGH', 'PD_IB_LOW', 'PD_IB_MID', 'PD_OR_HIGH', 'PD_OR_LOW', 'PD_OR_MID', 'PD_SESSION_MID']) {
    touchFreq[name] = { daysWithTouch: 0, totalDays: 0 };
  }

  // ─── Confluence tracking ──────────────────────────────────────────────────
  const confluenceDays = { PD_IB_HIGH: 0, PD_IB_LOW: 0, totalDays: 0 };

  // ─── Replay all days ──────────────────────────────────────────────────────
  console.log('\nReplaying bar-by-bar...');
  const allTouches = [];
  let dayCount = 0;

  for (const date of tradingDates) {
    const bars = barsByDate[date];
    if (!bars || bars.length < 30) continue;

    // Find prior trading day
    const dateIdx = allDates.indexOf(date);
    if (dateIdx < 1) continue;
    const priorDate = allDates[dateIdx - 1];

    // Get day type
    const acd = acdByDate[date];
    const dayType = acd?.day_type || 'UNKNOWN';

    // Get developing range for normalization
    const va = vaByDate[date];
    const devRange = va ? (va.sh - va.sl) : null;

    // Compute PD levels
    const levels = getPDLevels(priorDate, barsByDate, vaByDate);
    if (levels.length === 0) continue;

    // Compute today's IB for confluence check
    const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
    let todayIBHigh = null, todayIBLow = null;
    if (ibBars.length >= 30) {
      todayIBHigh = Math.max(...ibBars.map(b => b.high));
      todayIBLow = Math.min(...ibBars.map(b => b.low));
    }

    // Track confluence days
    confluenceDays.totalDays++;
    const pdLevels = computePriorDayLevels(priorDate, barsByDate, vaByDate);
    if (pdLevels && todayIBHigh != null) {
      if (Math.abs(pdLevels.pdIBHigh - todayIBHigh) <= 30) confluenceDays.PD_IB_HIGH++;
      if (Math.abs(pdLevels.pdIBLow - todayIBLow) <= 30) confluenceDays.PD_IB_LOW++;
    }

    // Track touch frequency per level
    for (const name of Object.keys(touchFreq)) {
      const lev = levels.find(l => l.name === name);
      if (lev) {
        touchFreq[name].totalDays++;
        // Check if price touches this level today
        const touched = bars.some(b => Math.abs(b.close - lev.value) <= PROX ||
          (b.low <= lev.value + PROX && b.high >= lev.value - PROX));
        if (touched) touchFreq[name].daysWithTouch++;
      }
    }

    // Replay
    const touches = replayDay(date, bars, levels, dayType, devRange, todayIBHigh, todayIBLow);
    allTouches.push(...touches);
    dayCount++;

    if (dayCount % 30 === 0) {
      console.log(`  ${dayCount} days replayed, ${allTouches.length} touches so far...`);
    }
  }

  console.log(`\nReplay complete: ${dayCount} days, ${allTouches.length} total touches\n`);

  // ─── Group by level name ──────────────────────────────────────────────────
  const byLevel = {};
  for (const t of allTouches) {
    (byLevel[t.levelName] ??= []).push(t);
  }

  // ==========================================================================
  // 1. TOUCH FREQUENCY — How often does price reach each PD level?
  // ==========================================================================
  console.log('='.repeat(150));
  console.log('TOUCH FREQUENCY: What % of days does price reach each prior-day level?');
  console.log('='.repeat(150));
  for (const [name, freq] of Object.entries(touchFreq)) {
    const pct = freq.totalDays > 0 ? (freq.daysWithTouch / freq.totalDays * 100) : 0;
    console.log(`  ${padR(name, 18)} Days with touch: ${pad(freq.daysWithTouch, 4)} / ${pad(freq.totalDays, 4)}  = ${fmt(pct)}%`);
  }
  console.log('');

  // ==========================================================================
  // 2. CONFLUENCE: PD_IB_HIGH near today's IB_HIGH
  // ==========================================================================
  console.log('='.repeat(150));
  console.log('CONFLUENCE: How often are PD IB levels near today\'s IB levels (within 30pt)?');
  console.log('='.repeat(150));
  const confHighPct = confluenceDays.totalDays > 0 ? (confluenceDays.PD_IB_HIGH / confluenceDays.totalDays * 100) : 0;
  const confLowPct = confluenceDays.totalDays > 0 ? (confluenceDays.PD_IB_LOW / confluenceDays.totalDays * 100) : 0;
  console.log(`  PD_IB_HIGH near today IB_HIGH: ${confluenceDays.PD_IB_HIGH} / ${confluenceDays.totalDays} days = ${fmt(confHighPct)}%`);
  console.log(`  PD_IB_LOW near today IB_LOW:   ${confluenceDays.PD_IB_LOW} / ${confluenceDays.totalDays} days = ${fmt(confLowPct)}%`);
  console.log('');

  // ==========================================================================
  // 3. PER-LEVEL DETAILED ANALYSIS
  // ==========================================================================

  const summaryRows = [];

  for (const [levelName, touches] of Object.entries(byLevel)) {
    const firstTouches = touches.filter(t => t.isFirstTouch);
    const retouches = touches.filter(t => !t.isFirstTouch);

    const n = touches.length;
    const nFirst = firstTouches.length;
    const nRetouch = retouches.length;

    // Multi-target fade WR
    const wr10 = touches.filter(t => t.fadeSuccess10).length / n * 100;
    const wr20 = touches.filter(t => t.fadeSuccess20).length / n * 100;
    const wr30 = touches.filter(t => t.fadeSuccess30).length / n * 100;
    const wr40 = touches.filter(t => t.fadeSuccess40).length / n * 100;

    const maes30 = touches.map(t => t.mae30);
    const mfes30 = touches.map(t => t.mfe30);
    const maes60 = touches.map(t => t.mae60);
    const mfes60 = touches.map(t => t.mfe60);

    const maeP = pctiles(maes30);
    const mfeP = pctiles(mfes30);
    const maeP60 = pctiles(maes60);
    const mfeP60 = pctiles(mfes60);

    const avgTimeToPeak = mean(touches.map(t => t.timeToPeakMFE30));

    const mfeMaeRatios = {
      p25: maeP.p25 > 0 ? mfeP.p25 / maeP.p25 : Infinity,
      p50: maeP.p50 > 0 ? mfeP.p50 / maeP.p50 : Infinity,
      p75: maeP.p75 > 0 ? mfeP.p75 / maeP.p75 : Infinity,
    };

    // Optimal unconstrained
    const opt = optimizeStopTarget(touches);
    const dollarRisk = opt.bestStop * PNL_PER_POINT + COMMISSION;
    const dllCompatible = dollarRisk <= (DLL / 2);

    // DLL-constrained (95pt stop max = $191 risk)
    const optDLL = optimizeDLL(touches);

    // 90pt stop fade WR at multiple targets (comparison with prior audit)
    const fade90_10 = fadeWRAtStop(touches, 90, 10);
    const fade90_20 = fadeWRAtStop(touches, 90, 20);
    const fade90_30 = fadeWRAtStop(touches, 90, 30);
    const fade90_40 = fadeWRAtStop(touches, 90, 40);

    // MAE as % of developing range
    const touchesWithRange = touches.filter(t => t.devRange && t.devRange > 0);
    const maePctOfRange = touchesWithRange.length > 0
      ? pctiles(touchesWithRange.map(t => (t.mae30 / t.devRange) * 100))
      : null;
    const mfePctOfRange = touchesWithRange.length > 0
      ? pctiles(touchesWithRange.map(t => (t.mfe30 / t.devRange) * 100))
      : null;

    summaryRows.push({
      levelName, n, nFirst, nRetouch,
      wr10, wr20, wr30, wr40,
      maeP, mfeP, maeP60, mfeP60,
      maePctOfRange, mfePctOfRange,
      mfeMaeRatios, avgTimeToPeak,
      opt, dollarRisk, dllCompatible,
      optDLL,
      fade90_10, fade90_20, fade90_30, fade90_40,
    });

    // ─── Print detailed report per level ─────────────────────────────────
    console.log('='.repeat(150));
    console.log(`  ${levelName}  |  N=${n} (first=${nFirst}, retouch=${nRetouch})  |  Peak MFE: ${fmt(avgTimeToPeak, 0)} bars`);
    console.log('='.repeat(150));

    // Fade WR at multiple targets
    console.log(`  Fade WR (30-bar):  10pt=${fmt(wr10)}%  20pt=${fmt(wr20)}%  30pt=${fmt(wr30)}%  40pt=${fmt(wr40)}%`);
    console.log(`  @90pt stop:        10pt=${fmt(fade90_10.wr * 100)}%(EV$${fmt(fade90_10.ev,2)})  20pt=${fmt(fade90_20.wr * 100)}%(EV$${fmt(fade90_20.ev,2)})  30pt=${fmt(fade90_30.wr * 100)}%(EV$${fmt(fade90_30.ev,2)})  40pt=${fmt(fade90_40.wr * 100)}%(EV$${fmt(fade90_40.ev,2)})`);

    // MAE/MFE distributions
    console.log(`  MAE 30-bar:  P25=${fmt(maeP.p25)}  P50=${fmt(maeP.p50)}  P75=${fmt(maeP.p75)}  P90=${fmt(maeP.p90)}`);
    console.log(`  MFE 30-bar:  P25=${fmt(mfeP.p25)}  P50=${fmt(mfeP.p50)}  P75=${fmt(mfeP.p75)}  P90=${fmt(mfeP.p90)}`);
    console.log(`  MAE 60-bar:  P25=${fmt(maeP60.p25)}  P50=${fmt(maeP60.p50)}  P75=${fmt(maeP60.p75)}  P90=${fmt(maeP60.p90)}`);
    console.log(`  MFE 60-bar:  P25=${fmt(mfeP60.p25)}  P50=${fmt(mfeP60.p50)}  P75=${fmt(mfeP60.p75)}  P90=${fmt(mfeP60.p90)}`);
    console.log(`  MFE/MAE:     P25=${fmt(mfeMaeRatios.p25, 2)}x  P50=${fmt(mfeMaeRatios.p50, 2)}x  P75=${fmt(mfeMaeRatios.p75, 2)}x`);
    if (maePctOfRange) {
      console.log(`  MAE %range:  P25=${fmt(maePctOfRange.p25)}%  P50=${fmt(maePctOfRange.p50)}%  P75=${fmt(maePctOfRange.p75)}%  P90=${fmt(maePctOfRange.p90)}%`);
      console.log(`  MFE %range:  P25=${fmt(mfePctOfRange.p25)}%  P50=${fmt(mfePctOfRange.p50)}%  P75=${fmt(mfePctOfRange.p75)}%  P90=${fmt(mfePctOfRange.p90)}%`);
    }

    // Optimization results
    console.log(`  OPTIMAL:     Stop=${fmt(opt.bestStop)}pt  Target=${fmt(opt.bestTarget)}pt  WR=${fmt(opt.bestWR * 100)}%  EV=$${fmt(opt.bestEV, 2)}/trade  $Risk=$${fmt(dollarRisk, 0)}  DLL=${dllCompatible ? 'YES' : 'NO'}`);
    console.log(`  DLL-SAFE:    Stop=${fmt(optDLL.bestStop)}pt  Target=${fmt(optDLL.bestTarget)}pt  WR=${fmt(optDLL.bestWR * 100)}%  EV=$${fmt(optDLL.bestEV, 2)}/trade  $Risk=$${fmt(optDLL.dollarRisk, 0)}`);

    // ─── Context Splits ─────────────────────────────────────────────────
    if (n >= 20) {
      console.log('');
      console.log(`  --- Context Splits ---`);

      // First touch vs retouch
      if (nFirst >= 8 && nRetouch >= 8) {
        const firstWR = firstTouches.filter(t => t.fadeSuccess20).length / nFirst * 100;
        const retouchWR = retouches.filter(t => t.fadeSuccess20).length / nRetouch * 100;
        const firstMAE = pctiles(firstTouches.map(t => t.mae30));
        const firstMFE = pctiles(firstTouches.map(t => t.mfe30));
        const retouchMAE = pctiles(retouches.map(t => t.mae30));
        const retouchMFE = pctiles(retouches.map(t => t.mfe30));
        const firstOpt = optimizeStopTarget(firstTouches);
        const retouchOpt = optimizeStopTarget(retouches);
        console.log(`  First touch:   N=${pad(nFirst, 4)}  WR20=${pad(fmt(firstWR), 5)}%  MAE P50=${pad(fmt(firstMAE.p50), 6)}  MFE P50=${pad(fmt(firstMFE.p50), 6)}  OptEV=$${fmt(firstOpt.bestEV, 2)}`);
        console.log(`  Retouch:       N=${pad(nRetouch, 4)}  WR20=${pad(fmt(retouchWR), 5)}%  MAE P50=${pad(fmt(retouchMAE.p50), 6)}  MFE P50=${pad(fmt(retouchMFE.p50), 6)}  OptEV=$${fmt(retouchOpt.bestEV, 2)}`);
      }

      // AM vs PM
      const amTouches = touches.filter(t => t.isAM);
      const pmTouches = touches.filter(t => !t.isAM);
      if (amTouches.length >= 8 && pmTouches.length >= 8) {
        const amWR = amTouches.filter(t => t.fadeSuccess20).length / amTouches.length * 100;
        const pmWR = pmTouches.filter(t => t.fadeSuccess20).length / pmTouches.length * 100;
        const amOpt = optimizeStopTarget(amTouches);
        const pmOpt = optimizeStopTarget(pmTouches);
        console.log(`  AM (9:30-12):  N=${pad(amTouches.length, 4)}  WR20=${pad(fmt(amWR), 5)}%  OptEV=$${fmt(amOpt.bestEV, 2)}  (${fmt(amOpt.bestStop)}stop/${fmt(amOpt.bestTarget)}tgt)`);
        console.log(`  PM (12-4):     N=${pad(pmTouches.length, 4)}  WR20=${pad(fmt(pmWR), 5)}%  OptEV=$${fmt(pmOpt.bestEV, 2)}  (${fmt(pmOpt.bestStop)}stop/${fmt(pmOpt.bestTarget)}tgt)`);
      }

      // Day type
      for (const dt of ['TREND', 'BALANCE', 'TURBULENT']) {
        const dtTouches = touches.filter(t => t.dayType === dt);
        if (dtTouches.length >= 8) {
          const dtWR = dtTouches.filter(t => t.fadeSuccess20).length / dtTouches.length * 100;
          const dtOpt = optimizeStopTarget(dtTouches);
          console.log(`  ${padR(dt + ':', 13)}  N=${pad(dtTouches.length, 4)}  WR20=${pad(fmt(dtWR), 5)}%  OptEV=$${fmt(dtOpt.bestEV, 2)}  (${fmt(dtOpt.bestStop)}stop/${fmt(dtOpt.bestTarget)}tgt)`);
        }
      }

      // Delta state: opposing vs aligned
      const deltaOpp = touches.filter(t => t.deltaOpposing);
      const deltaAli = touches.filter(t => !t.deltaOpposing);
      if (deltaOpp.length >= 8 && deltaAli.length >= 8) {
        const oppWR = deltaOpp.filter(t => t.fadeSuccess20).length / deltaOpp.length * 100;
        const aliWR = deltaAli.filter(t => t.fadeSuccess20).length / deltaAli.length * 100;
        const oppOpt = optimizeStopTarget(deltaOpp);
        const aliOpt = optimizeStopTarget(deltaAli);
        console.log(`  Delta oppose:  N=${pad(deltaOpp.length, 4)}  WR20=${pad(fmt(oppWR), 5)}%  OptEV=$${fmt(oppOpt.bestEV, 2)}`);
        console.log(`  Delta aligned: N=${pad(deltaAli.length, 4)}  WR20=${pad(fmt(aliWR), 5)}%  OptEV=$${fmt(aliOpt.bestEV, 2)}`);
      }

      // Inside vs outside developing range
      const insideTouches = touches.filter(t => t.levelInsideRange);
      const outsideTouches = touches.filter(t => !t.levelInsideRange);
      if (insideTouches.length >= 5 && outsideTouches.length >= 5) {
        const insideWR = insideTouches.filter(t => t.fadeSuccess20).length / insideTouches.length * 100;
        const outsideWR = outsideTouches.filter(t => t.fadeSuccess20).length / outsideTouches.length * 100;
        const insideOpt = optimizeStopTarget(insideTouches);
        const outsideOpt = optimizeStopTarget(outsideTouches);
        console.log(`  Inside dev:    N=${pad(insideTouches.length, 4)}  WR20=${pad(fmt(insideWR), 5)}%  OptEV=$${fmt(insideOpt.bestEV, 2)}`);
        console.log(`  Outside dev:   N=${pad(outsideTouches.length, 4)}  WR20=${pad(fmt(outsideWR), 5)}%  OptEV=$${fmt(outsideOpt.bestEV, 2)}`);
      }

      // Confluence with today's IB (only for PD_IB_HIGH / PD_IB_LOW)
      if (levelName === 'PD_IB_HIGH' || levelName === 'PD_IB_LOW') {
        const confTouches = touches.filter(t => t.confluenceWithTodayIB);
        const noConfTouches = touches.filter(t => !t.confluenceWithTodayIB);
        if (confTouches.length >= 3) {
          const confWR = confTouches.filter(t => t.fadeSuccess20).length / confTouches.length * 100;
          const confMFE = pctiles(confTouches.map(t => t.mfe30));
          const confMAE = pctiles(confTouches.map(t => t.mae30));
          console.log(`  CONFLUENCE:    N=${pad(confTouches.length, 4)}  WR20=${pad(fmt(confWR), 5)}%  MAE P50=${pad(fmt(confMAE.p50), 6)}  MFE P50=${pad(fmt(confMFE.p50), 6)}`);
          if (confTouches.length >= 8) {
            const confOpt = optimizeStopTarget(confTouches);
            console.log(`                 OptEV=$${fmt(confOpt.bestEV, 2)} (${fmt(confOpt.bestStop)}stop/${fmt(confOpt.bestTarget)}tgt)`);
          }
        }
        if (noConfTouches.length >= 3) {
          const noConfWR = noConfTouches.filter(t => t.fadeSuccess20).length / noConfTouches.length * 100;
          const noConfMFE = pctiles(noConfTouches.map(t => t.mfe30));
          const noConfMAE = pctiles(noConfTouches.map(t => t.mae30));
          console.log(`  NO CONFLUENCE: N=${pad(noConfTouches.length, 4)}  WR20=${pad(fmt(noConfWR), 5)}%  MAE P50=${pad(fmt(noConfMAE.p50), 6)}  MFE P50=${pad(fmt(noConfMFE.p50), 6)}`);
        }
      }
    }

    console.log('');
  }

  // ==========================================================================
  // 4. FADE WR AT 90pt STOP — COMPARISON TABLE
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('FADE WR AT 90pt STOP / MULTIPLE TARGETS (comparison with prior PD_POC/PD_VAH/PD_VAL audit)');
  console.log('Prior audit reference: PD_POC 75-82% WR at 90pt stop with positive EV');
  console.log('='.repeat(160));

  const hdr0 = [
    padR('Level', 18),
    pad('N', 5),
    pad('WR@10pt', 8),
    pad('EV@10', 7),
    pad('WR@20pt', 8),
    pad('EV@20', 7),
    pad('WR@30pt', 8),
    pad('EV@30', 7),
    pad('WR@40pt', 8),
    pad('EV@40', 7),
  ].join(' | ');
  console.log(hdr0);
  console.log('-'.repeat(hdr0.length));

  for (const r of summaryRows) {
    const row = [
      padR(r.levelName, 18),
      pad(r.n, 5),
      pad(fmt(r.fade90_10.wr * 100) + '%', 8),
      pad('$' + fmt(r.fade90_10.ev, 2), 7),
      pad(fmt(r.fade90_20.wr * 100) + '%', 8),
      pad('$' + fmt(r.fade90_20.ev, 2), 7),
      pad(fmt(r.fade90_30.wr * 100) + '%', 8),
      pad('$' + fmt(r.fade90_30.ev, 2), 7),
      pad(fmt(r.fade90_40.wr * 100) + '%', 8),
      pad('$' + fmt(r.fade90_40.ev, 2), 7),
    ].join(' | ');
    console.log(row);
  }

  // ==========================================================================
  // 5. SUMMARY TABLES
  // ==========================================================================

  // ─── Unconstrained Summary ────────────────────────────────────────────────
  console.log('\n' + '='.repeat(160));
  console.log('RANKED SUMMARY -- UNCONSTRAINED OPTIMAL (sorted by EV)');
  console.log('='.repeat(160));

  const hdr1 = [
    padR('Level', 18),
    pad('N', 5),
    pad('1st', 4),
    pad('WR20', 6),
    pad('MAE P50', 8),
    pad('MAE P75', 8),
    pad('MAE P90', 8),
    pad('MFE P50', 8),
    pad('MFE P75', 8),
    pad('MFE P90', 8),
    pad('Stop', 5),
    pad('Tgt', 5),
    pad('OptWR', 6),
    pad('EV$/tr', 8),
    pad('$Risk', 6),
    pad('DLL', 4),
    pad('Peak', 5),
  ].join(' | ');
  console.log(hdr1);
  console.log('-'.repeat(hdr1.length));

  summaryRows.sort((a, b) => b.opt.bestEV - a.opt.bestEV);

  for (const r of summaryRows) {
    const row = [
      padR(r.levelName, 18),
      pad(r.n, 5),
      pad(r.nFirst, 4),
      pad(fmt(r.wr20) + '%', 6),
      pad(fmt(r.maeP.p50), 8),
      pad(fmt(r.maeP.p75), 8),
      pad(fmt(r.maeP.p90), 8),
      pad(fmt(r.mfeP.p50), 8),
      pad(fmt(r.mfeP.p75), 8),
      pad(fmt(r.mfeP.p90), 8),
      pad(fmt(r.opt.bestStop), 5),
      pad(fmt(r.opt.bestTarget), 5),
      pad(fmt(r.opt.bestWR * 100) + '%', 6),
      pad('$' + fmt(r.opt.bestEV, 2), 8),
      pad('$' + fmt(r.dollarRisk, 0), 6),
      pad(r.dllCompatible ? 'YES' : 'NO', 4),
      pad(fmt(r.avgTimeToPeak, 0) + 'b', 5),
    ].join(' | ');
    console.log(row);
  }

  // ─── DLL-Constrained Summary ──────────────────────────────────────────────
  console.log('\n' + '='.repeat(160));
  console.log('RANKED SUMMARY -- DLL-SAFE OPTIMAL (stop capped at 95pt / $191 risk, sorted by EV)');
  console.log('='.repeat(160));

  const hdr2 = [
    padR('Level', 18),
    pad('N', 5),
    pad('WR20', 6),
    pad('DLL Stop', 9),
    pad('DLL Tgt', 8),
    pad('DLL WR', 7),
    pad('DLL EV', 8),
    pad('$Risk', 6),
    pad('MAE P50', 8),
    pad('MFE P50', 8),
    pad('MFE/MAE', 8),
  ].join(' | ');
  console.log(hdr2);
  console.log('-'.repeat(hdr2.length));

  const dllSorted = [...summaryRows].sort((a, b) => b.optDLL.bestEV - a.optDLL.bestEV);
  for (const r of dllSorted) {
    const d = r.optDLL;
    const ratio = r.mfeMaeRatios.p50 === Infinity ? 99 : r.mfeMaeRatios.p50;
    const row = [
      padR(r.levelName, 18),
      pad(r.n, 5),
      pad(fmt(r.wr20) + '%', 6),
      pad(fmt(d.bestStop) + 'pt', 9),
      pad(fmt(d.bestTarget) + 'pt', 8),
      pad(fmt(d.bestWR * 100) + '%', 7),
      pad('$' + fmt(d.bestEV, 2), 8),
      pad('$' + fmt(d.dollarRisk, 0), 6),
      pad(fmt(r.maeP.p50), 8),
      pad(fmt(r.mfeP.p50), 8),
      pad(fmt(ratio, 2) + 'x', 8),
    ].join(' | ');
    console.log(row);
  }

  // ==========================================================================
  // 6. STORE IN performance_audit
  // ==========================================================================
  console.log('\nStoring results in performance_audit...');

  await query(`DELETE FROM performance_audit WHERE signal_type = 'PD_IB_AUDIT'`);

  for (const r of summaryRows) {
    const touches = byLevel[r.levelName];
    await query(`
      INSERT INTO performance_audit (
        run_date, window_days, signal_type, signal_name,
        sample_size, win_rate, ev_per_trade, total_pnl,
        avg_mfe, p50_mfe, p75_mfe,
        avg_mae, p50_mae, p75_mae, p90_mae,
        avg_duration_min,
        optimal_stop, optimal_target, optimal_ev,
        mfe_range_pct, mae_range_pct,
        recommendation, notes
      ) VALUES (
        CURRENT_DATE, $1, 'PD_IB_AUDIT', $2,
        $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12, $13,
        $14,
        $15, $16, $17,
        $18, $19,
        $20, $21
      )
    `, [
      WINDOW_DAYS,
      r.levelName,
      r.n,
      r.wr20,
      r.opt.bestEV,
      r.opt.bestEV * r.n,
      mean(touches.map(t => t.mfe30)),
      r.mfeP.p50,
      r.mfeP.p75,
      mean(touches.map(t => t.mae30)),
      r.maeP.p50,
      r.maeP.p75,
      r.maeP.p90,
      r.avgTimeToPeak,
      r.opt.bestStop,
      r.opt.bestTarget,
      r.opt.bestEV,
      r.mfePctOfRange?.p50 ?? null,
      r.maePctOfRange?.p50 ?? null,
      r.optDLL.bestEV > 0 ? 'DLL_TRADEABLE' : (r.dllCompatible ? 'DLL_COMPATIBLE' : 'NEEDS_WIDER_STOP'),
      JSON.stringify({
        fadeWR: { wr10: r.wr10, wr20: r.wr20, wr30: r.wr30, wr40: r.wr40 },
        fadeAt90Stop: {
          wr10: r.fade90_10.wr * 100, wr20: r.fade90_20.wr * 100,
          wr30: r.fade90_30.wr * 100, wr40: r.fade90_40.wr * 100,
          ev10: r.fade90_10.ev, ev20: r.fade90_20.ev,
          ev30: r.fade90_30.ev, ev40: r.fade90_40.ev,
        },
        firstTouchCount: r.nFirst,
        retouchCount: r.nRetouch,
        dollarRiskUnconstrained: r.dollarRisk,
        mfeMaeRatioP50: r.mfeMaeRatios.p50 === Infinity ? null : r.mfeMaeRatios.p50,
        maeP60: r.maeP60,
        mfeP60: r.mfeP60,
        maePctOfRange: r.maePctOfRange,
        mfePctOfRange: r.mfePctOfRange,
        dllConstrained: {
          stop: r.optDLL.bestStop,
          target: r.optDLL.bestTarget,
          wr: r.optDLL.bestWR,
          ev: r.optDLL.bestEV,
          dollarRisk: r.optDLL.dollarRisk,
        },
        touchFrequency: touchFreq[r.levelName] ?? null,
        confluence: (r.levelName === 'PD_IB_HIGH' || r.levelName === 'PD_IB_LOW')
          ? {
              confluenceDays: confluenceDays[r.levelName] ?? 0,
              totalDays: confluenceDays.totalDays,
              confluencePct: confluenceDays.totalDays > 0
                ? ((confluenceDays[r.levelName] ?? 0) / confluenceDays.totalDays * 100)
                : 0,
              // Confluence subset performance
              confTouches: touches.filter(t => t.confluenceWithTodayIB).length,
              confWR20: touches.filter(t => t.confluenceWithTodayIB).length > 0
                ? (touches.filter(t => t.confluenceWithTodayIB && t.fadeSuccess20).length /
                   touches.filter(t => t.confluenceWithTodayIB).length * 100)
                : null,
              noConfTouches: touches.filter(t => !t.confluenceWithTodayIB).length,
              noConfWR20: touches.filter(t => !t.confluenceWithTodayIB).length > 0
                ? (touches.filter(t => !t.confluenceWithTodayIB && t.fadeSuccess20).length /
                   touches.filter(t => !t.confluenceWithTodayIB).length * 100)
                : null,
            }
          : null,
        contextSplits: {
          insideRange: {
            n: touches.filter(t => t.levelInsideRange).length,
            wr20: touches.filter(t => t.levelInsideRange).length > 0
              ? (touches.filter(t => t.levelInsideRange && t.fadeSuccess20).length /
                 touches.filter(t => t.levelInsideRange).length * 100)
              : null,
          },
          outsideRange: {
            n: touches.filter(t => !t.levelInsideRange).length,
            wr20: touches.filter(t => !t.levelInsideRange).length > 0
              ? (touches.filter(t => !t.levelInsideRange && t.fadeSuccess20).length /
                 touches.filter(t => !t.levelInsideRange).length * 100)
              : null,
          },
        },
      }),
    ]);
  }

  console.log(`Stored ${summaryRows.length} rows in performance_audit with signal_type='PD_IB_AUDIT'.`);

  // ==========================================================================
  // 7. FINAL DLL-COMPATIBLE RECOMMENDATIONS
  // ==========================================================================
  console.log('\n' + '='.repeat(150));
  console.log('FINAL DLL-COMPATIBLE RECOMMENDATIONS ($400 DLL, 95pt max stop = $191 risk)');
  console.log('='.repeat(150));

  const posEV = dllSorted.filter(r => r.optDLL.bestEV > 0);
  const negEV = dllSorted.filter(r => r.optDLL.bestEV <= 0);

  if (posEV.length > 0) {
    console.log('\n  POSITIVE EV at DLL-safe stops:');
    for (const r of posEV) {
      const d = r.optDLL;
      const tradesPerDay = Math.floor(DLL / d.dollarRisk);
      const dailyEV = d.bestEV * Math.min(tradesPerDay, 2);
      const freq = touchFreq[r.levelName];
      const freqStr = freq ? `Touch ${fmt(freq.daysWithTouch / freq.totalDays * 100)}% of days` : '';
      console.log(`  ${padR(r.levelName, 18)} Stop=${fmt(d.bestStop)}pt($${fmt(d.dollarRisk, 0)})  Tgt=${fmt(d.bestTarget)}pt  WR=${fmt(d.bestWR * 100)}%  EV=$${fmt(d.bestEV, 2)}/trade  MaxTrades/day=${tradesPerDay}  DailyEV=$${fmt(dailyEV, 2)}  |  ${freqStr}  |  N=${r.n}`);
    }
  } else {
    console.log('\n  No levels have positive EV at DLL-safe stop sizes.');
  }

  if (negEV.length > 0) {
    console.log('\n  NEGATIVE EV at DLL-safe stops:');
    for (const r of negEV) {
      const d = r.optDLL;
      const u = r.opt;
      console.log(`  ${padR(r.levelName, 18)} DLL: Stop=${fmt(d.bestStop)}pt EV=$${fmt(d.bestEV, 2)}  |  Unconstrained: Stop=${fmt(u.bestStop)}pt($${fmt(r.dollarRisk, 0)}) EV=$${fmt(u.bestEV, 2)}  |  N=${r.n}`);
    }
  }

  // ==========================================================================
  // 8. COMPARISON WITH PRIOR AUDIT LEVELS
  // ==========================================================================
  console.log('\n' + '='.repeat(150));
  console.log('COMPARISON WITH PRIOR AUDIT (PD_POC, PD_VAH, PD_VAL: 75-82% WR at 90pt stop)');
  console.log('='.repeat(150));

  console.log('\n  Prior audit reference (90pt stop / 20pt target):');
  console.log('  PD_POC:  ~75-82% WR, positive EV');
  console.log('  PD_VAH:  ~75-82% WR, positive EV');
  console.log('  PD_VAL:  ~75-82% WR, positive EV');
  console.log('');
  console.log('  This audit (90pt stop / 20pt target):');
  for (const r of summaryRows) {
    const f = r.fade90_20;
    const verdict = f.wr >= 0.75 ? 'MATCHES prior audit quality'
      : f.wr >= 0.65 ? 'MODERATE - below PD_POC/VAH/VAL tier'
      : f.wr >= 0.55 ? 'WEAK - marginal edge only'
      : 'NO EDGE at this config';
    console.log(`  ${padR(r.levelName, 18)} WR=${fmt(f.wr * 100)}%  EV=$${fmt(f.ev, 2)}  N=${f.n}  --> ${verdict}`);
  }

  // ==========================================================================
  // 9. KEY FINDINGS
  // ==========================================================================
  console.log('\n' + '='.repeat(150));
  console.log('KEY FINDINGS');
  console.log('='.repeat(150));

  // Best level by DLL EV
  const bestDLL = dllSorted[0];
  console.log(`\n  Best DLL-safe level: ${bestDLL.levelName} (EV=$${fmt(bestDLL.optDLL.bestEV, 2)} at ${fmt(bestDLL.optDLL.bestStop)}pt stop / ${fmt(bestDLL.optDLL.bestTarget)}pt target)`);

  // Best level by unconstrained EV
  const bestUnc = summaryRows[0];
  console.log(`  Best unconstrained:  ${bestUnc.levelName} (EV=$${fmt(bestUnc.opt.bestEV, 2)} at ${fmt(bestUnc.opt.bestStop)}pt stop / ${fmt(bestUnc.opt.bestTarget)}pt target)`);

  // Most frequently touched
  const freqEntries = Object.entries(touchFreq).sort((a, b) =>
    (b[1].daysWithTouch / b[1].totalDays) - (a[1].daysWithTouch / a[1].totalDays));
  console.log(`  Most touched level:  ${freqEntries[0][0]} (${fmt(freqEntries[0][1].daysWithTouch / freqEntries[0][1].totalDays * 100)}% of days)`);
  console.log(`  Least touched level: ${freqEntries[freqEntries.length - 1][0]} (${fmt(freqEntries[freqEntries.length - 1][1].daysWithTouch / freqEntries[freqEntries.length - 1][1].totalDays * 100)}% of days)`);

  // IB levels: how do they compare to OR levels?
  const ibLevels = summaryRows.filter(r => r.levelName.startsWith('PD_IB'));
  const orLevels = summaryRows.filter(r => r.levelName.startsWith('PD_OR'));
  if (ibLevels.length > 0 && orLevels.length > 0) {
    const ibAvgEV = mean(ibLevels.map(r => r.optDLL.bestEV));
    const orAvgEV = mean(orLevels.map(r => r.optDLL.bestEV));
    console.log(`\n  PD_IB levels avg DLL EV: $${fmt(ibAvgEV, 2)}`);
    console.log(`  PD_OR levels avg DLL EV: $${fmt(orAvgEV, 2)}`);
    console.log(`  ${ibAvgEV > orAvgEV ? 'PD_IB' : 'PD_OR'} levels are stronger on average`);
  }

  console.log('\n' + '='.repeat(150));
  console.log('PD IB / OR FADE AUDIT COMPLETE');
  console.log('='.repeat(150));
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
