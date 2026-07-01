// =============================================================================
// COMPREHENSIVE LEVEL FADE MAE/MFE AUDIT
// Bar-by-bar replay over 180 days. For each level touch, simulates a fade trade
// and computes full MAE/MFE distributions, optimal stop/target, and EV.
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

  // 2. Developing value log
  const vaQ = await query(`
    SELECT trade_date::text as d, poc::float, vah::float, val::float,
      session_high::float as sh, session_low::float as sl, session_close::float as sc
    FROM developing_value_log
    ORDER BY trade_date
  `);
  const vaByDate = {};
  for (const r of vaQ.rows) vaByDate[r.d] = r;
  console.log(`  Value area: ${vaQ.rows.length} days`);

  // 3. ACD daily log (day type, OR levels)
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

// ─── Level Definitions ───────────────────────────────────────────────────────

function getLevels(date, priorDate, vaByDate, acdByDate, barsByDate) {
  const pdVA = vaByDate[priorDate];
  if (!pdVA) return [];

  const levels = [];

  // 1. PD_POC
  if (pdVA.poc) levels.push({ name: 'PD_POC', value: pdVA.poc, availableAt: 570 });
  // 2. PD_VAH
  if (pdVA.vah) levels.push({ name: 'PD_VAH', value: pdVA.vah, availableAt: 570 });
  // 3. PD_VAL
  if (pdVA.val) levels.push({ name: 'PD_VAL', value: pdVA.val, availableAt: 570 });

  // 4. Floor Pivot, R1, S1 from prior day's H/L/C
  if (pdVA.sh && pdVA.sl && pdVA.sc) {
    const pivot = (pdVA.sh + pdVA.sl + pdVA.sc) / 3;
    const r1 = 2 * pivot - pdVA.sl;
    const s1 = 2 * pivot - pdVA.sh;
    levels.push({ name: 'FLOOR_PIVOT', value: pivot, availableAt: 570 });
    levels.push({ name: 'FLOOR_R1', value: r1, availableAt: 570 });
    levels.push({ name: 'FLOOR_S1', value: s1, availableAt: 570 });
  }

  // 5. OR_HIGH, OR_LOW — computed from first 5 bars (9:30-9:35)
  const bars = barsByDate[date];
  if (bars && bars.length >= 5) {
    const orBars = bars.filter(b => b.et_min >= 570 && b.et_min < 575);
    if (orBars.length > 0) {
      const orHigh = Math.max(...orBars.map(b => b.high));
      const orLow = Math.min(...orBars.map(b => b.low));
      // OR levels only valid AFTER OR closes (et_min >= 575)
      levels.push({ name: 'OR_HIGH', value: orHigh, availableAt: 575 });
      levels.push({ name: 'OR_LOW', value: orLow, availableAt: 575 });
    }
  }

  // 6. IB_HIGH, IB_LOW — computed from first 60 bars (9:30-10:30)
  if (bars && bars.length >= 60) {
    const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
    if (ibBars.length >= 30) {
      const ibHigh = Math.max(...ibBars.map(b => b.high));
      const ibLow = Math.min(...ibBars.map(b => b.low));
      // IB levels only valid AFTER IB closes (et_min >= 630)
      levels.push({ name: 'IB_HIGH', value: ibHigh, availableAt: 630 });
      levels.push({ name: 'IB_LOW', value: ibLow, availableAt: 630 });
    }
  }

  return levels;
}

// ─── Replay Engine ───────────────────────────────────────────────────────────

function replayDay(date, bars, levels, dayType, devRange) {
  const touches = [];
  const touchedLevels = new Set(); // track first touch per level name
  const retouchTracker = {};       // track retouches separately

  for (let i = 10; i < bars.length; i++) {
    const bar = bars[i];

    for (const level of levels) {
      // Skip if bar is before level's available time
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

      // Compute delta state at touch
      const touchDelta = Number(bar.ask_vol) - Number(bar.bid_vol);
      // Delta opposing = exhaustion (selling into support fade = buy signal, etc.)
      const deltaOpposing = fromBelow ? touchDelta < 0 : touchDelta > 0;

      // AM vs PM
      const isAM = bar.et_min < 720; // 12:00 ET = minute 720

      // Build forward bar path: per-bar favorable/adverse excursion relative to entry
      // fwdBars[j] = { fav: max favorable move on this bar, adv: max adverse move on this bar }
      const fwdBars = [];
      let mfe30 = 0, mae30 = 0, mfe60 = 0, mae60 = 0;
      let timeToPeakMFE30 = 0, timeToPeakMFE60 = 0;
      let fadeSuccess30 = false;

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
          if (!fadeSuccess30 && favOnBar >= FADE_TARGET) fadeSuccess30 = true;
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
        isFirstTouch,
        isAM,
        dayType: dayType || 'UNKNOWN',
        devRange,
        deltaOpposing,
        mfe30, mae30, mfe60, mae60,
        timeToPeakMFE30, timeToPeakMFE60,
        fadeSuccess30,
        fwdBars, // full forward path for optimizer
      });
    }
  }

  return touches;
}

// ─── Optimal Stop/Target Optimizer (bar-by-bar simulation) ──────────────────

function simulateTrade(touch, stop, target, horizon = MFE_HORIZON_SHORT) {
  // Walk forward bar by bar. On each bar, check if stop or target is hit.
  // Conservative: if BOTH are hit on same bar, stop wins (worst case).
  const bars = touch.fwdBars;
  const limit = Math.min(horizon, bars.length);
  for (let j = 0; j < limit; j++) {
    const b = bars[j];
    const stopHit = b.adv >= stop;
    const targetHit = b.fav >= target;
    if (stopHit && targetHit) {
      // Same bar: conservative = loss
      return 'LOSS';
    }
    if (stopHit) return 'LOSS';
    if (targetHit) return 'WIN';
  }
  // Neither hit within horizon — scratch (close at last bar's close-relative)
  return 'SCRATCH';
}

function optimizeStopTarget(touches) {
  const maes30 = touches.map(t => t.mae30);
  const mfes30 = touches.map(t => t.mfe30);
  const maxStop = Math.max(percentile(maes30, 90), 60);
  const maxTarget = Math.max(percentile(mfes30, 90), 80);

  let bestEV = -Infinity, bestStop = 0, bestTarget = 0, bestWR = 0, bestN = 0;

  // Sweep with finer granularity for stops (5pt steps), coarser for targets (5pt)
  for (let stop = 10; stop <= maxStop; stop += 5) {
    for (let target = 10; target <= maxTarget; target += 5) {
      let wins = 0, losses = 0, scratches = 0;
      for (const t of touches) {
        const result = simulateTrade(t, stop, target);
        if (result === 'WIN') wins++;
        else if (result === 'LOSS') losses++;
        else scratches++;
      }
      // Scratches are break-even minus commission
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

function optimizeStopTargetDLL(touches, maxDollarRisk = DLL / 2) {
  // Same as above but cap stop so dollar risk stays within DLL/2
  const maxStop = Math.floor((maxDollarRisk - COMMISSION) / PNL_PER_POINT);
  const mfes30 = touches.map(t => t.mfe30);
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

  const dollarRisk = bestStop * PNL_PER_POINT + COMMISSION;
  return { bestStop, bestTarget, bestEV, bestWR, bestN, dollarRisk };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(130));
  console.log('COMPREHENSIVE LEVEL FADE MAE/MFE AUDIT');
  console.log(`Window: ${WINDOW_DAYS} days | Proximity: ${PROX}pt | Fade target: ${FADE_TARGET}pt`);
  console.log(`PNL/pt: $${PNL_PER_POINT} | Commission: $${COMMISSION} | DLL: $${DLL}`);
  console.log('='.repeat(130));

  const { barsByDate, allDates, vaByDate, acdByDate, tradingDates } = await loadData();

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

    // Compute levels
    const levels = getLevels(date, priorDate, vaByDate, acdByDate, barsByDate);
    if (levels.length === 0) continue;

    // Replay
    const touches = replayDay(date, bars, levels, dayType, devRange);
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

  // ─── Per-level analysis ───────────────────────────────────────────────────
  const summaryRows = [];

  for (const [levelName, touches] of Object.entries(byLevel)) {
    const firstTouches = touches.filter(t => t.isFirstTouch);
    const retouches = touches.filter(t => !t.isFirstTouch);

    const n = touches.length;
    const nFirst = firstTouches.length;
    const nRetouch = retouches.length;

    const fadeWR = touches.filter(t => t.fadeSuccess30).length / n * 100;
    const fadeWRFirst = nFirst > 0 ? firstTouches.filter(t => t.fadeSuccess30).length / nFirst * 100 : 0;

    const maes30 = touches.map(t => t.mae30);
    const mfes30 = touches.map(t => t.mfe30);
    const maes60 = touches.map(t => t.mae60);
    const mfes60 = touches.map(t => t.mfe60);

    const maeP = pctiles(maes30);
    const mfeP = pctiles(mfes30);
    const maeP60 = pctiles(maes60);
    const mfeP60 = pctiles(mfes60);

    // Avg time to peak MFE
    const avgTimeToPeak = mean(touches.map(t => t.timeToPeakMFE30));

    // MFE/MAE ratio at each percentile
    const mfeMaeRatios = {
      p25: maeP.p25 > 0 ? mfeP.p25 / maeP.p25 : Infinity,
      p50: maeP.p50 > 0 ? mfeP.p50 / maeP.p50 : Infinity,
      p75: maeP.p75 > 0 ? mfeP.p75 / maeP.p75 : Infinity,
    };

    // Optimal stop/target (unconstrained)
    const opt = optimizeStopTarget(touches);
    const dollarRisk = opt.bestStop * PNL_PER_POINT + COMMISSION;
    const dllCompatible = dollarRisk <= (DLL / 2); // can take 2 trades/day

    // DLL-constrained optimization (stop capped at $200 risk = 99pt)
    const optDLL = optimizeStopTargetDLL(touches);

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
      fadeWR, fadeWRFirst,
      maeP, mfeP, maeP60, mfeP60,
      maePctOfRange, mfePctOfRange,
      mfeMaeRatios, avgTimeToPeak,
      opt, dollarRisk, dllCompatible,
      optDLL,
    });

    // ─── Print detailed report per level ─────────────────────────────────
    console.log('='.repeat(130));
    console.log(`  ${levelName}  |  N=${n} (first=${nFirst}, retouch=${nRetouch})  |  Fade WR(20pt/30bar)=${fmt(fadeWR)}%  |  Avg time to peak MFE: ${fmt(avgTimeToPeak, 0)} bars`);
    console.log('='.repeat(130));

    // MAE distribution
    console.log(`  MAE 30-bar:  P10=${fmt(maeP.p10)}  P25=${fmt(maeP.p25)}  P50=${fmt(maeP.p50)}  P75=${fmt(maeP.p75)}  P90=${fmt(maeP.p90)}`);
    console.log(`  MFE 30-bar:  P10=${fmt(mfeP.p10)}  P25=${fmt(mfeP.p25)}  P50=${fmt(mfeP.p50)}  P75=${fmt(mfeP.p75)}  P90=${fmt(mfeP.p90)}`);
    console.log(`  MAE 60-bar:  P10=${fmt(maeP60.p10)}  P25=${fmt(maeP60.p25)}  P50=${fmt(maeP60.p50)}  P75=${fmt(maeP60.p75)}  P90=${fmt(maeP60.p90)}`);
    console.log(`  MFE 60-bar:  P10=${fmt(mfeP60.p10)}  P25=${fmt(mfeP60.p25)}  P50=${fmt(mfeP60.p50)}  P75=${fmt(mfeP60.p75)}  P90=${fmt(mfeP60.p90)}`);
    console.log(`  MFE/MAE:     P25=${fmt(mfeMaeRatios.p25, 2)}x  P50=${fmt(mfeMaeRatios.p50, 2)}x  P75=${fmt(mfeMaeRatios.p75, 2)}x`);
    if (maePctOfRange) {
      console.log(`  MAE %range:  P10=${fmt(maePctOfRange.p10)}%  P25=${fmt(maePctOfRange.p25)}%  P50=${fmt(maePctOfRange.p50)}%  P75=${fmt(maePctOfRange.p75)}%  P90=${fmt(maePctOfRange.p90)}%`);
      console.log(`  MFE %range:  P10=${fmt(mfePctOfRange.p10)}%  P25=${fmt(mfePctOfRange.p25)}%  P50=${fmt(mfePctOfRange.p50)}%  P75=${fmt(mfePctOfRange.p75)}%  P90=${fmt(mfePctOfRange.p90)}%`);
    }

    // Optimal stop/target
    console.log(`  OPTIMAL:     Stop=${fmt(opt.bestStop)}pt  Target=${fmt(opt.bestTarget)}pt  WR=${fmt(opt.bestWR * 100)}%  EV=$${fmt(opt.bestEV, 2)}/trade  Dollar risk=$${fmt(dollarRisk, 2)}  DLL OK=${dllCompatible ? 'YES' : 'NO'}`);
    console.log(`  DLL-SAFE:    Stop=${fmt(optDLL.bestStop)}pt  Target=${fmt(optDLL.bestTarget)}pt  WR=${fmt(optDLL.bestWR * 100)}%  EV=$${fmt(optDLL.bestEV, 2)}/trade  Dollar risk=$${fmt(optDLL.dollarRisk, 2)}`);

    // ─── Context splits (if N >= 30) ─────────────────────────────────────
    if (n >= 30) {
      console.log('');
      console.log(`  --- Context Splits ---`);

      // First touch vs retouch
      if (nFirst >= 10 && nRetouch >= 10) {
        const firstMAE = pctiles(firstTouches.map(t => t.mae30));
        const firstMFE = pctiles(firstTouches.map(t => t.mfe30));
        const retouchMAE = pctiles(retouches.map(t => t.mae30));
        const retouchMFE = pctiles(retouches.map(t => t.mfe30));
        const firstWR = firstTouches.filter(t => t.fadeSuccess30).length / nFirst * 100;
        const retouchWR = retouches.filter(t => t.fadeSuccess30).length / nRetouch * 100;
        const firstOpt = optimizeStopTarget(firstTouches);
        const retouchOpt = optimizeStopTarget(retouches);
        console.log(`  First touch:   N=${pad(nFirst, 4)}  WR=${pad(fmt(firstWR), 6)}%  MAE P50=${pad(fmt(firstMAE.p50), 6)}  MFE P50=${pad(fmt(firstMFE.p50), 6)}  OptEV=$${fmt(firstOpt.bestEV, 2)}`);
        console.log(`  Retouch:       N=${pad(nRetouch, 4)}  WR=${pad(fmt(retouchWR), 6)}%  MAE P50=${pad(fmt(retouchMAE.p50), 6)}  MFE P50=${pad(fmt(retouchMFE.p50), 6)}  OptEV=$${fmt(retouchOpt.bestEV, 2)}`);
      }

      // AM vs PM
      const amTouches = touches.filter(t => t.isAM);
      const pmTouches = touches.filter(t => !t.isAM);
      if (amTouches.length >= 10 && pmTouches.length >= 10) {
        const amMAE = pctiles(amTouches.map(t => t.mae30));
        const amMFE = pctiles(amTouches.map(t => t.mfe30));
        const pmMAE = pctiles(pmTouches.map(t => t.mae30));
        const pmMFE = pctiles(pmTouches.map(t => t.mfe30));
        const amWR = amTouches.filter(t => t.fadeSuccess30).length / amTouches.length * 100;
        const pmWR = pmTouches.filter(t => t.fadeSuccess30).length / pmTouches.length * 100;
        const amOpt = optimizeStopTarget(amTouches);
        const pmOpt = optimizeStopTarget(pmTouches);
        console.log(`  AM (9:30-12):  N=${pad(amTouches.length, 4)}  WR=${pad(fmt(amWR), 6)}%  MAE P50=${pad(fmt(amMAE.p50), 6)}  MFE P50=${pad(fmt(amMFE.p50), 6)}  OptEV=$${fmt(amOpt.bestEV, 2)}`);
        console.log(`  PM (12-4):     N=${pad(pmTouches.length, 4)}  WR=${pad(fmt(pmWR), 6)}%  MAE P50=${pad(fmt(pmMAE.p50), 6)}  MFE P50=${pad(fmt(pmMFE.p50), 6)}  OptEV=$${fmt(pmOpt.bestEV, 2)}`);
      }

      // Day type
      for (const dt of ['TREND', 'BALANCE', 'TURBULENT']) {
        const dtTouches = touches.filter(t => t.dayType === dt);
        if (dtTouches.length >= 10) {
          const dtMAE = pctiles(dtTouches.map(t => t.mae30));
          const dtMFE = pctiles(dtTouches.map(t => t.mfe30));
          const dtWR = dtTouches.filter(t => t.fadeSuccess30).length / dtTouches.length * 100;
          const dtOpt = optimizeStopTarget(dtTouches);
          console.log(`  ${padR(dt + ':', 13)}  N=${pad(dtTouches.length, 4)}  WR=${pad(fmt(dtWR), 6)}%  MAE P50=${pad(fmt(dtMAE.p50), 6)}  MFE P50=${pad(fmt(dtMFE.p50), 6)}  OptEV=$${fmt(dtOpt.bestEV, 2)}`);
        }
      }

      // Delta state: opposing vs aligned
      const deltaOpp = touches.filter(t => t.deltaOpposing);
      const deltaAli = touches.filter(t => !t.deltaOpposing);
      if (deltaOpp.length >= 10 && deltaAli.length >= 10) {
        const oppMAE = pctiles(deltaOpp.map(t => t.mae30));
        const oppMFE = pctiles(deltaOpp.map(t => t.mfe30));
        const aliMAE = pctiles(deltaAli.map(t => t.mae30));
        const aliMFE = pctiles(deltaAli.map(t => t.mfe30));
        const oppWR = deltaOpp.filter(t => t.fadeSuccess30).length / deltaOpp.length * 100;
        const aliWR = deltaAli.filter(t => t.fadeSuccess30).length / deltaAli.length * 100;
        const oppOpt = optimizeStopTarget(deltaOpp);
        const aliOpt = optimizeStopTarget(deltaAli);
        console.log(`  Delta oppose:  N=${pad(deltaOpp.length, 4)}  WR=${pad(fmt(oppWR), 6)}%  MAE P50=${pad(fmt(oppMAE.p50), 6)}  MFE P50=${pad(fmt(oppMFE.p50), 6)}  OptEV=$${fmt(oppOpt.bestEV, 2)}`);
        console.log(`  Delta aligned: N=${pad(deltaAli.length, 4)}  WR=${pad(fmt(aliWR), 6)}%  MAE P50=${pad(fmt(aliMAE.p50), 6)}  MFE P50=${pad(fmt(aliMFE.p50), 6)}  OptEV=$${fmt(aliOpt.bestEV, 2)}`);
      }
    }

    console.log('');
  }

  // ─── Summary Table (Unconstrained) ─────────────────────────────────────────
  console.log('\n' + '='.repeat(150));
  console.log('RANKED SUMMARY — UNCONSTRAINED OPTIMAL (sorted by EV)');
  console.log('='.repeat(150));

  const hdr = [
    padR('Level', 14),
    pad('N', 5),
    pad('1st', 4),
    pad('FadeWR', 7),
    pad('MAE P50', 8),
    pad('MAE P75', 8),
    pad('MFE P50', 8),
    pad('MFE P75', 8),
    pad('OptStop', 8),
    pad('OptTgt', 7),
    pad('OptWR', 6),
    pad('EV$/tr', 8),
    pad('$Risk', 6),
    pad('DLL', 4),
    pad('Avg Peak', 9),
  ].join(' | ');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  summaryRows.sort((a, b) => b.opt.bestEV - a.opt.bestEV);

  for (const r of summaryRows) {
    const row = [
      padR(r.levelName, 14),
      pad(r.n, 5),
      pad(r.nFirst, 4),
      pad(fmt(r.fadeWR) + '%', 7),
      pad(fmt(r.maeP.p50), 8),
      pad(fmt(r.maeP.p75), 8),
      pad(fmt(r.mfeP.p50), 8),
      pad(fmt(r.mfeP.p75), 8),
      pad(fmt(r.opt.bestStop), 8),
      pad(fmt(r.opt.bestTarget), 7),
      pad(fmt(r.opt.bestWR * 100) + '%', 6),
      pad('$' + fmt(r.opt.bestEV, 2), 8),
      pad('$' + fmt(r.dollarRisk, 0), 6),
      pad(r.dllCompatible ? 'YES' : 'NO', 4),
      pad(fmt(r.avgTimeToPeak, 0) + 'bar', 9),
    ].join(' | ');
    console.log(row);
  }

  // ─── DLL-Constrained Summary Table ────────────────────────────────────────
  console.log('\n' + '='.repeat(150));
  console.log('RANKED SUMMARY — DLL-SAFE OPTIMAL (stop capped at $200 risk, sorted by EV)');
  console.log('='.repeat(150));

  const hdr2 = [
    padR('Level', 14),
    pad('N', 5),
    pad('FadeWR', 7),
    pad('DLL Stop', 9),
    pad('DLL Tgt', 8),
    pad('DLL WR', 7),
    pad('DLL EV', 8),
    pad('$Risk', 6),
    pad('MAE P50', 8),
    pad('MFE P50', 8),
    pad('MFE/MAE', 8),
    pad('Avg Peak', 9),
  ].join(' | ');
  console.log(hdr2);
  console.log('-'.repeat(hdr2.length));

  const dllSorted = [...summaryRows].sort((a, b) => b.optDLL.bestEV - a.optDLL.bestEV);

  for (const r of dllSorted) {
    const d = r.optDLL;
    const row = [
      padR(r.levelName, 14),
      pad(r.n, 5),
      pad(fmt(r.fadeWR) + '%', 7),
      pad(fmt(d.bestStop) + 'pt', 9),
      pad(fmt(d.bestTarget) + 'pt', 8),
      pad(fmt(d.bestWR * 100) + '%', 7),
      pad('$' + fmt(d.bestEV, 2), 8),
      pad('$' + fmt(d.dollarRisk, 0), 6),
      pad(fmt(r.maeP.p50), 8),
      pad(fmt(r.mfeP.p50), 8),
      pad(fmt(r.mfeMaeRatios.p50, 2) + 'x', 8),
      pad(fmt(r.avgTimeToPeak, 0) + 'bar', 9),
    ].join(' | ');
    console.log(row);
  }

  // ─── Store results in performance_audit ────────────────────────────────
  console.log('\nStoring results in performance_audit...');

  // Clear prior runs of this type
  await query(`DELETE FROM performance_audit WHERE signal_type = 'LEVEL_FADE_AUDIT'`);

  for (const r of summaryRows) {
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
        CURRENT_DATE, $1, 'LEVEL_FADE_AUDIT', $2,
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
      r.fadeWR,
      r.opt.bestEV,
      r.opt.bestEV * r.n, // total PnL over sample
      mean(allTouches.filter(t => t.levelName === r.levelName).map(t => t.mfe30)),
      r.mfeP.p50,
      r.mfeP.p75,
      mean(allTouches.filter(t => t.levelName === r.levelName).map(t => t.mae30)),
      r.maeP.p50,
      r.maeP.p75,
      r.maeP.p90,
      r.avgTimeToPeak, // using bars as proxy for minutes (1-min bars)
      r.opt.bestStop,
      r.opt.bestTarget,
      r.opt.bestEV,
      r.mfePctOfRange?.p50 ?? null,
      r.maePctOfRange?.p50 ?? null,
      r.optDLL.bestEV > 0 ? 'DLL_TRADEABLE' : (r.dllCompatible ? 'DLL_COMPATIBLE' : 'NEEDS_WIDER_STOP'),
      JSON.stringify({
        firstTouchWR: r.fadeWRFirst,
        nFirst: r.nFirst,
        nRetouch: r.nRetouch,
        dollarRiskUnconstrained: r.dollarRisk,
        mfeMaeRatioP50: r.mfeMaeRatios.p50,
        maeP60: r.maeP60,
        mfeP60: r.mfeP60,
        dllConstrained: {
          stop: r.optDLL.bestStop,
          target: r.optDLL.bestTarget,
          wr: r.optDLL.bestWR,
          ev: r.optDLL.bestEV,
          dollarRisk: r.optDLL.dollarRisk,
        },
      }),
    ]);
  }

  console.log(`Stored ${summaryRows.length} rows in performance_audit.`);

  // ─── Final DLL Actionable Summary ──────────────────────────────────────
  console.log('\n' + '='.repeat(150));
  console.log('DLL TRADEABLE LEVELS ($400 DLL, max $200/trade risk, sorted by DLL-constrained EV)');
  console.log('='.repeat(150));

  const dllTradeable = dllSorted.filter(r => r.optDLL.bestEV > 0);
  const dllNegEV = dllSorted.filter(r => r.optDLL.bestEV <= 0);

  if (dllTradeable.length > 0) {
    console.log('\n  POSITIVE EV at DLL-safe stops:');
    for (const r of dllTradeable) {
      const d = r.optDLL;
      const tradesPerDay = Math.floor(DLL / d.dollarRisk);
      const dailyEV = d.bestEV * Math.min(tradesPerDay, 2);
      console.log(`  ${padR(r.levelName, 14)} Stop=${fmt(d.bestStop)}pt($${fmt(d.dollarRisk, 0)})  Tgt=${fmt(d.bestTarget)}pt  WR=${fmt(d.bestWR * 100)}%  EV=$${fmt(d.bestEV, 2)}/trade  MaxTrades/day=${tradesPerDay}  DailyEV=$${fmt(dailyEV, 2)}  N=${r.n}`);
    }
  } else {
    console.log('\n  No levels have positive EV at DLL-safe stop sizes.');
  }

  if (dllNegEV.length > 0) {
    console.log('\n  NEGATIVE EV at DLL-safe stops (need wider stops):');
    for (const r of dllNegEV) {
      const d = r.optDLL;
      const u = r.opt;
      console.log(`  ${padR(r.levelName, 14)} DLL: Stop=${fmt(d.bestStop)}pt EV=$${fmt(d.bestEV, 2)}  |  Unconstrained: Stop=${fmt(u.bestStop)}pt($${fmt(r.dollarRisk, 0)}) EV=$${fmt(u.bestEV, 2)}  Need ${fmt(r.dollarRisk - DLL/2, 0)} more $ risk headroom`);
    }
  }

  console.log('\n' + '='.repeat(150));
  console.log('AUDIT COMPLETE');
  console.log('='.repeat(150));
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
