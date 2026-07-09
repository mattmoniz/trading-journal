// =============================================================================
// ROLLING MULTI-DAY IB COMPOSITE LEVEL FADE AUDIT
// Tests rolling 3/5/10-day IB composites vs single-day IB baselines.
// Hypothesis: multi-day IB mids smooth extreme days → better fade levels.
// =============================================================================

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION = 1;
const DLL = 400;
const PROX = 10;
const MFE_HORIZON_SHORT = 30;
const MFE_HORIZON_LONG = 60;
const WINDOW_DAYS = 180;
const DLL_MAX_STOP = Math.floor((DLL / 2 - COMMISSION) / PNL_PER_POINT); // 99pt

// Rolling windows to test
const ROLLING_WINDOWS = [1, 3, 5, 10];

// ─── Helpers ────────────────────────────────────────────────────────────────

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
function median(arr) { return percentile(arr, 50); }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function pad(s, n) { return String(s).padStart(n); }
function padR(s, n) { return String(s).padEnd(n); }
function fmt(v, d = 1) { return v.toFixed(d); }

// ─── Load Data ──────────────────────────────────────────────────────────────

async function loadData() {
  console.log('Loading data...');

  // RTH 1-min bars (extra 30 days for rolling lookback)
  const barsQ = await query(`
    SELECT ts, ts::date::text as d,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float, volume::bigint as vol
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

  // Developing value log (POC, session high/low)
  const vaQ = await query(`
    SELECT trade_date::text as d, poc::float, vah::float, val::float,
      session_high::float as sh, session_low::float as sl
    FROM developing_value_log
    ORDER BY trade_date
  `);
  const vaByDate = {};
  for (const r of vaQ.rows) vaByDate[r.d] = r;
  console.log(`  Value area: ${vaQ.rows.length} days`);

  // ACD daily log (day type)
  const acdQ = await query(`
    SELECT trade_date::text as d, or_high::float, or_low::float, day_type
    FROM acd_daily_log
    ORDER BY trade_date
  `);
  const acdByDate = {};
  for (const r of acdQ.rows) acdByDate[r.d] = r;
  console.log(`  ACD: ${acdQ.rows.length} days`);

  // Determine window
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const tradingDates = allDates.filter(d => d >= cutoffStr);
  console.log(`  Trading days in window: ${tradingDates.length} (cutoff ${cutoffStr})`);

  return { barsByDate, allDates, vaByDate, acdByDate, tradingDates };
}

// ─── Compute per-day IB/OR/Session stats ────────────────────────────────────

function computeDayStats(date, barsByDate, vaByDate, acdByDate) {
  const bars = barsByDate[date];
  if (!bars || bars.length < 30) return null;

  // IB: 9:30-10:30 (et_min 570-629)
  const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
  if (ibBars.length < 30) return null;
  const ibHigh = Math.max(...ibBars.map(b => b.high));
  const ibLow = Math.min(...ibBars.map(b => b.low));
  const ibMid = (ibHigh + ibLow) / 2;
  const ibWidth = ibHigh - ibLow;

  // OR: 9:30-9:35 (et_min 570-574)
  const orBars = bars.filter(b => b.et_min >= 570 && b.et_min < 575);
  let orHigh = null, orLow = null, orMid = null;
  if (orBars.length > 0) {
    orHigh = Math.max(...orBars.map(b => b.high));
    orLow = Math.min(...orBars.map(b => b.low));
    orMid = (orHigh + orLow) / 2;
  }

  // Session range
  const sessionHigh = Math.max(...bars.map(b => b.high));
  const sessionLow = Math.min(...bars.map(b => b.low));
  const sessionMid = (sessionHigh + sessionLow) / 2;
  const sessionRange = sessionHigh - sessionLow;

  // POC from developing_value_log
  const va = vaByDate[date];
  const poc = va?.poc ?? null;

  return {
    date, ibHigh, ibLow, ibMid, ibWidth,
    orHigh, orLow, orMid,
    sessionHigh, sessionLow, sessionMid, sessionRange,
    poc,
  };
}

// ─── Compute rolling composite levels ───────────────────────────────────────

function computeRollingLevels(priorDayStats, windowSize) {
  // priorDayStats: array of day stats for the N prior trading days
  if (priorDayStats.length < windowSize) return null;
  const window = priorDayStats.slice(-windowSize);

  // Rolling IB composite
  const rollingIBHigh = Math.max(...window.map(d => d.ibHigh));
  const rollingIBLow = Math.min(...window.map(d => d.ibLow));
  const rollingIBMid = (rollingIBHigh + rollingIBLow) / 2;

  // Median IB mid (less outlier-sensitive)
  const medianIBMid = median(window.map(d => d.ibMid));

  // Rolling IB width
  const rollingIBWidth = rollingIBHigh - rollingIBLow;

  // Rolling OR composite (only if all days have OR data)
  const orDays = window.filter(d => d.orHigh != null);
  let rollingORMid = null;
  if (orDays.length === windowSize) {
    const rollingORHigh = Math.max(...orDays.map(d => d.orHigh));
    const rollingORLow = Math.min(...orDays.map(d => d.orLow));
    rollingORMid = (rollingORHigh + rollingORLow) / 2;
  }

  // Rolling session mid
  const rollingSessionHigh = Math.max(...window.map(d => d.sessionHigh));
  const rollingSessionLow = Math.min(...window.map(d => d.sessionLow));
  const rollingSessionMid = (rollingSessionHigh + rollingSessionLow) / 2;

  // Rolling POC (average)
  const pocDays = window.filter(d => d.poc != null);
  const rollingPOC = pocDays.length > 0 ? mean(pocDays.map(d => d.poc)) : null;

  // Average of individual IB widths (for compression detection)
  const avgIBWidth = mean(window.map(d => d.ibWidth));

  return {
    windowSize,
    rollingIBHigh, rollingIBLow, rollingIBMid,
    medianIBMid,
    rollingIBWidth, avgIBWidth,
    rollingORMid,
    rollingSessionMid,
    rollingPOC,
  };
}

// ─── Build level set for a trading day ──────────────────────────────────────

function buildLevels(allDayStats, dateIdx, windows) {
  const levels = [];

  for (const w of windows) {
    // For window=1, just use the single prior day
    if (dateIdx < w) continue;
    const priorStats = allDayStats.slice(dateIdx - w, dateIdx);
    const rolling = computeRollingLevels(priorStats, w);
    if (!rolling) continue;

    const wLabel = w === 1 ? '1D' : `${w}D`;

    levels.push({ name: `IB_HIGH_${wLabel}`, value: rolling.rollingIBHigh, window: w, availableAt: 570 });
    levels.push({ name: `IB_LOW_${wLabel}`, value: rolling.rollingIBLow, window: w, availableAt: 570 });
    levels.push({ name: `IB_MID_${wLabel}`, value: rolling.rollingIBMid, window: w, availableAt: 570 });

    if (w > 1) {
      levels.push({ name: `MEDIAN_IB_MID_${wLabel}`, value: rolling.medianIBMid, window: w, availableAt: 570 });
    }

    // Only compute OR/Session/POC composites for 5-day window (and 1-day baseline)
    if (w === 5 || w === 1) {
      if (rolling.rollingORMid != null) {
        levels.push({ name: `OR_MID_${wLabel}`, value: rolling.rollingORMid, window: w, availableAt: 570 });
      }
      levels.push({ name: `SESSION_MID_${wLabel}`, value: rolling.rollingSessionMid, window: w, availableAt: 570 });
      if (rolling.rollingPOC != null) {
        levels.push({ name: `POC_AVG_${wLabel}`, value: rolling.rollingPOC, window: w, availableAt: 570 });
      }
    }
  }

  return levels;
}

// ─── Replay Engine ──────────────────────────────────────────────────────────

function replayDay(date, bars, levels, dayStats, priorDayStats, allRollingData) {
  const touches = [];
  const touchedLevels = new Set();
  const retouchTracker = {};

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (i < 10) continue; // skip first 10 bars for lookback

    for (const level of levels) {
      if (bar.et_min < level.availableAt) continue;

      const dist = bar.close - level.value;
      if (Math.abs(dist) > PROX) continue;

      const isFirstTouch = !touchedLevels.has(level.name);
      const lastRetouchBar = retouchTracker[level.name] ?? -999;
      if (i - lastRetouchBar < 10) continue; // debounce

      // Approach direction from prior 5 bars
      const lookback = Math.min(5, i);
      const priorCloses = bars.slice(i - lookback, i).map(b => b.close);
      const priorAvg = mean(priorCloses);
      const fromBelow = priorAvg < level.value - 3;
      const fromAbove = priorAvg > level.value + 3;
      if (!fromBelow && !fromAbove) continue;

      const fadeDir = fromBelow ? 'SHORT' : 'LONG';
      const entryPx = bar.close;
      const entryIdx = i;
      const isAM = bar.et_min < 720;

      // Bar-by-bar forward path
      const fwdBars = [];
      let mfe30 = 0, mae30 = 0, mfe60 = 0, mae60 = 0;
      let timeToPeakMFE30 = 0;
      let fadeSuccess10 = false, fadeSuccess20 = false, fadeSuccess30 = false, fadeSuccess40 = false;

      for (let j = 1; j <= MFE_HORIZON_LONG && (entryIdx + j) < bars.length; j++) {
        const fb = bars[entryIdx + j];
        let fav, adv;
        if (fadeDir === 'LONG') {
          fav = fb.high - entryPx;
          adv = entryPx - fb.low;
        } else {
          fav = entryPx - fb.low;
          adv = fb.high - entryPx;
        }
        fwdBars.push({ fav, adv });

        if (j <= MFE_HORIZON_SHORT) {
          if (fav > mfe30) { mfe30 = fav; timeToPeakMFE30 = j; }
          mae30 = Math.max(mae30, adv);
          if (!fadeSuccess10 && fav >= 10) fadeSuccess10 = true;
          if (!fadeSuccess20 && fav >= 20) fadeSuccess20 = true;
          if (!fadeSuccess30 && fav >= 30) fadeSuccess30 = true;
          if (!fadeSuccess40 && fav >= 40) fadeSuccess40 = true;
        }
        if (fav > mfe60) mfe60 = fav;
        mae60 = Math.max(mae60, adv);
      }

      touchedLevels.add(level.name);
      retouchTracker[level.name] = i;

      // Get rolling IB width for this day (for compression analysis)
      const rollingIBWidth = allRollingData?.[level.window]?.rollingIBWidth ?? null;
      const avgIBWidth = allRollingData?.[level.window]?.avgIBWidth ?? null;

      // Was prior session extreme? (>2 sigma range)
      const priorSessionRange = priorDayStats?.sessionRange ?? null;

      touches.push({
        date,
        levelName: level.name,
        levelValue: level.value,
        window: level.window,
        fadeDir,
        entryPx,
        entryBarIdx: i,
        entryMinute: bar.et_min,
        isFirstTouch,
        isAM,
        mfe30, mae30, mfe60, mae60,
        timeToPeakMFE30,
        fadeSuccess10, fadeSuccess20, fadeSuccess30, fadeSuccess40,
        fwdBars,
        rollingIBWidth,
        avgIBWidth,
        priorSessionRange,
      });
    }
  }
  return touches;
}

// ─── Trade Simulator ────────────────────────────────────────────────────────

function simulateTrade(touch, stop, target, horizon = MFE_HORIZON_SHORT) {
  const bars = touch.fwdBars;
  const limit = Math.min(horizon, bars.length);
  for (let j = 0; j < limit; j++) {
    const b = bars[j];
    if (b.adv >= stop && b.fav >= target) return 'LOSS'; // conservative
    if (b.adv >= stop) return 'LOSS';
    if (b.fav >= target) return 'WIN';
  }
  return 'SCRATCH';
}

function optimizeStopTarget(touches, maxStopOverride = null) {
  if (!touches.length) return { bestStop: 0, bestTarget: 0, bestEV: -Infinity, bestWR: 0, bestN: 0 };
  const maes = touches.map(t => t.mae30);
  const mfes = touches.map(t => t.mfe30);
  const maxStop = maxStopOverride ?? Math.max(percentile(maes, 95), 100);
  const maxTarget = Math.max(percentile(mfes, 90), 80);

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
        bestEV = ev; bestStop = stop; bestTarget = target; bestWR = wr; bestN = n;
      }
    }
  }
  return { bestStop, bestTarget, bestEV, bestWR, bestN };
}

function optimizeDLL(touches) {
  return optimizeStopTarget(touches, DLL_MAX_STOP);
}

function fadeWRAtStop(touches, stop, target) {
  if (!touches.length) return { wr: 0, n: 0, ev: 0 };
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
  return { wr, n, ev: totalPnL / n };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(160));
  console.log('ROLLING MULTI-DAY IB COMPOSITE LEVEL FADE AUDIT');
  console.log(`Window: ${WINDOW_DAYS} days | Proximity: ${PROX}pt | Rolling windows: ${ROLLING_WINDOWS.join(', ')} days`);
  console.log(`PNL/pt: $${PNL_PER_POINT} | Commission: $${COMMISSION} | DLL: $${DLL} | DLL max stop: ${DLL_MAX_STOP}pt`);
  console.log('='.repeat(160));

  const { barsByDate, allDates, vaByDate, acdByDate, tradingDates } = await loadData();

  // ─── Pre-compute per-day stats for all dates ──────────────────────────────
  console.log('\nComputing per-day IB/OR/Session stats...');
  const allDayStats = [];
  const dayStatsByDate = {};
  for (const d of allDates) {
    const stats = computeDayStats(d, barsByDate, vaByDate, acdByDate);
    if (stats) {
      allDayStats.push(stats);
      dayStatsByDate[d] = stats;
    }
  }
  console.log(`  Computed stats for ${allDayStats.length} days`);

  // Pre-compute session range stats for extreme-day detection
  const allRanges = allDayStats.map(d => d.sessionRange);
  const rangeMean = mean(allRanges);
  const rangeStd = stdev(allRanges);
  const extremeThreshold = rangeMean + 2 * rangeStd;
  console.log(`  Session range: mean=${fmt(rangeMean)}pt, std=${fmt(rangeStd)}pt, 2-sigma=${fmt(extremeThreshold)}pt`);

  // ─── Level stability tracking ─────────────────────────────────────────────
  // Track how much rolling IB mid moves day-to-day
  const stabilityData = {}; // window -> array of daily changes
  for (const w of ROLLING_WINDOWS) stabilityData[w] = [];

  let prevRollingMids = {};

  // ─── Touch frequency tracking ─────────────────────────────────────────────
  const touchFreq = {}; // levelName -> { daysWithTouch, totalDays }

  // ─── Replay ───────────────────────────────────────────────────────────────
  console.log('\nReplaying bar-by-bar...');
  const allTouches = [];
  let dayCount = 0;

  for (const date of tradingDates) {
    const bars = barsByDate[date];
    if (!bars || bars.length < 30) continue;

    const dateIdx = allDayStats.findIndex(d => d.date === date);
    if (dateIdx < 1) continue;

    const todayStats = allDayStats[dateIdx];
    const priorDayStats = allDayStats[dateIdx - 1];

    // Build all rolling levels for this day
    const levels = buildLevels(allDayStats, dateIdx, ROLLING_WINDOWS);
    if (levels.length === 0) continue;

    // Collect rolling data per window for width analysis
    const allRollingForDay = {};
    for (const w of ROLLING_WINDOWS) {
      if (dateIdx >= w) {
        const priorStats = allDayStats.slice(dateIdx - w, dateIdx);
        const rolling = computeRollingLevels(priorStats, w);
        if (rolling) {
          allRollingForDay[w] = rolling;

          // Track stability (daily move of rolling mid)
          const prevMid = prevRollingMids[w];
          if (prevMid != null) {
            stabilityData[w].push(Math.abs(rolling.rollingIBMid - prevMid));
          }
          prevRollingMids[w] = rolling.rollingIBMid;
        }
      }
    }

    // Track touch frequency
    for (const level of levels) {
      if (!touchFreq[level.name]) touchFreq[level.name] = { daysWithTouch: 0, totalDays: 0 };
      touchFreq[level.name].totalDays++;
      const touched = bars.some(b =>
        Math.abs(b.close - level.value) <= PROX ||
        (b.low <= level.value + PROX && b.high >= level.value - PROX)
      );
      if (touched) touchFreq[level.name].daysWithTouch++;
    }

    // Annotate each touch with extreme-day flag
    const touches = replayDay(date, bars, levels, todayStats, priorDayStats, allRollingForDay);

    // Add extreme-day flag
    for (const t of touches) {
      t.priorDayExtreme = priorDayStats && priorDayStats.sessionRange > extremeThreshold;
      t.dayType = acdByDate[date]?.day_type || 'UNKNOWN';
    }

    allTouches.push(...touches);
    dayCount++;

    if (dayCount % 30 === 0) {
      console.log(`  ${dayCount} days replayed, ${allTouches.length} touches so far...`);
    }
  }

  console.log(`\nReplay complete: ${dayCount} days, ${allTouches.length} total touches\n`);

  // ─── Group touches ────────────────────────────────────────────────────────
  const byLevel = {};
  for (const t of allTouches) {
    (byLevel[t.levelName] ??= []).push(t);
  }

  // ==========================================================================
  // 1. TOUCH FREQUENCY
  // ==========================================================================
  console.log('='.repeat(160));
  console.log('TOUCH FREQUENCY: % of days price reaches each level');
  console.log('='.repeat(160));

  // Group by base level type for comparison
  const levelGroups = {};
  for (const [name, freq] of Object.entries(touchFreq)) {
    const pct = freq.totalDays > 0 ? (freq.daysWithTouch / freq.totalDays * 100) : 0;
    const base = name.replace(/_\d+D$/, '');
    if (!levelGroups[base]) levelGroups[base] = [];
    levelGroups[base].push({ name, pct, ...freq });
  }

  for (const [base, entries] of Object.entries(levelGroups)) {
    console.log(`  ${base}:`);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`    ${padR(e.name, 22)} ${pad(e.daysWithTouch, 4)} / ${pad(e.totalDays, 4)} days = ${pad(fmt(e.pct), 5)}%`);
    }
  }

  // ==========================================================================
  // 2. LEVEL STABILITY: How much does each rolling mid move per day?
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('LEVEL STABILITY: Daily movement of rolling IB MID (lower = more stable reference)');
  console.log('='.repeat(160));

  const stabilityHeader = [
    padR('Window', 10),
    pad('Mean Move', 10),
    pad('Median', 8),
    pad('P75', 8),
    pad('P90', 8),
    pad('Max', 8),
    pad('Days', 5),
  ].join(' | ');
  console.log(stabilityHeader);
  console.log('-'.repeat(stabilityHeader.length));

  for (const w of ROLLING_WINDOWS) {
    const moves = stabilityData[w];
    if (!moves.length) continue;
    const row = [
      padR(`${w}-day`, 10),
      pad(fmt(mean(moves)), 10),
      pad(fmt(median(moves)), 8),
      pad(fmt(percentile(moves, 75)), 8),
      pad(fmt(percentile(moves, 90)), 8),
      pad(fmt(Math.max(...moves)), 8),
      pad(moves.length, 5),
    ].join(' | ');
    console.log(row);
  }

  // ==========================================================================
  // 3. IB WIDTH OVER TIME: Rolling IB width distribution
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('ROLLING IB WIDTH DISTRIBUTION: Composite IB range across windows');
  console.log('='.repeat(160));

  for (const w of ROLLING_WINDOWS) {
    const widths = [];
    for (let i = w; i < allDayStats.length; i++) {
      const window = allDayStats.slice(i - w, i);
      const ibHigh = Math.max(...window.map(d => d.ibHigh));
      const ibLow = Math.min(...window.map(d => d.ibLow));
      widths.push(ibHigh - ibLow);
    }
    if (widths.length > 0) {
      console.log(`  ${w}-day IB width:  Mean=${fmt(mean(widths))}pt  Median=${fmt(median(widths))}pt  P25=${fmt(percentile(widths, 25))}pt  P75=${fmt(percentile(widths, 75))}pt  P90=${fmt(percentile(widths, 90))}pt`);
    }
  }

  // ==========================================================================
  // 4. PER-LEVEL DETAILED ANALYSIS
  // ==========================================================================

  const summaryRows = [];

  // Focus on IB_MID variants for the core comparison, plus all other levels
  const levelOrder = [
    'IB_MID_1D', 'IB_MID_3D', 'IB_MID_5D', 'IB_MID_10D',
    'MEDIAN_IB_MID_3D', 'MEDIAN_IB_MID_5D', 'MEDIAN_IB_MID_10D',
    'IB_HIGH_1D', 'IB_HIGH_3D', 'IB_HIGH_5D', 'IB_HIGH_10D',
    'IB_LOW_1D', 'IB_LOW_3D', 'IB_LOW_5D', 'IB_LOW_10D',
    'OR_MID_1D', 'OR_MID_5D',
    'SESSION_MID_1D', 'SESSION_MID_5D',
    'POC_AVG_1D', 'POC_AVG_5D',
  ];

  const levelsToProcess = levelOrder.filter(l => byLevel[l] && byLevel[l].length > 0);

  for (const levelName of levelsToProcess) {
    const touches = byLevel[levelName];
    const n = touches.length;
    if (n < 5) continue;

    const firstTouches = touches.filter(t => t.isFirstTouch);
    const retouches = touches.filter(t => !t.isFirstTouch);

    // Fade WR at multiple targets
    const wr10 = touches.filter(t => t.fadeSuccess10).length / n * 100;
    const wr20 = touches.filter(t => t.fadeSuccess20).length / n * 100;
    const wr30 = touches.filter(t => t.fadeSuccess30).length / n * 100;
    const wr40 = touches.filter(t => t.fadeSuccess40).length / n * 100;

    const maes30 = touches.map(t => t.mae30);
    const mfes30 = touches.map(t => t.mfe30);
    const maeP = pctiles(maes30);
    const mfeP = pctiles(mfes30);
    const maeP60 = pctiles(touches.map(t => t.mae60));
    const mfeP60 = pctiles(touches.map(t => t.mfe60));

    const avgTimeToPeak = mean(touches.map(t => t.timeToPeakMFE30));

    const mfeMaeRatio = maeP.p50 > 0 ? mfeP.p50 / maeP.p50 : Infinity;

    // Optimization
    const opt = optimizeStopTarget(touches);
    const optDLL = optimizeDLL(touches);
    const dollarRisk = opt.bestStop * PNL_PER_POINT + COMMISSION;

    // Fade at specific stop/target combos
    const fade90_10 = fadeWRAtStop(touches, 90, 10);
    const fade90_20 = fadeWRAtStop(touches, 90, 20);
    const fade90_30 = fadeWRAtStop(touches, 90, 30);
    const fade90_40 = fadeWRAtStop(touches, 90, 40);

    summaryRows.push({
      levelName, n,
      nFirst: firstTouches.length,
      nRetouch: retouches.length,
      window: touches[0]?.window ?? 1,
      wr10, wr20, wr30, wr40,
      maeP, mfeP, maeP60, mfeP60,
      mfeMaeRatio,
      avgTimeToPeak,
      opt, optDLL, dollarRisk,
      fade90_10, fade90_20, fade90_30, fade90_40,
      touches, firstTouches, retouches,
    });
  }

  // ==========================================================================
  // 5. MASTER COMPARISON TABLE (sorted by DLL EV)
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('MASTER COMPARISON TABLE (sorted by DLL-safe EV)');
  console.log('='.repeat(160));

  const hdr = [
    padR('Level', 24), pad('Win', 4), pad('N', 5),
    pad('WR10', 6), pad('WR20', 6), pad('WR30', 6), pad('WR40', 6),
    pad('MAE P50', 8), pad('MAE P90', 8),
    pad('MFE P50', 8), pad('MFE P90', 8),
    pad('MFE/MAE', 8),
    pad('DLL Stp', 8), pad('DLL Tgt', 8), pad('DLL WR', 7), pad('DLL EV', 8),
    pad('Tch%', 6),
  ].join(' | ');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  const sorted = [...summaryRows].sort((a, b) => b.optDLL.bestEV - a.optDLL.bestEV);

  for (const r of sorted) {
    const freq = touchFreq[r.levelName];
    const touchPct = freq && freq.totalDays > 0 ? (freq.daysWithTouch / freq.totalDays * 100) : 0;
    const ratio = r.mfeMaeRatio === Infinity ? 99 : r.mfeMaeRatio;
    const row = [
      padR(r.levelName, 24), pad(r.window, 4), pad(r.n, 5),
      pad(fmt(r.wr10) + '%', 6), pad(fmt(r.wr20) + '%', 6), pad(fmt(r.wr30) + '%', 6), pad(fmt(r.wr40) + '%', 6),
      pad(fmt(r.maeP.p50), 8), pad(fmt(r.maeP.p90), 8),
      pad(fmt(r.mfeP.p50), 8), pad(fmt(r.mfeP.p90), 8),
      pad(fmt(ratio, 2) + 'x', 8),
      pad(fmt(r.optDLL.bestStop) + 'pt', 8), pad(fmt(r.optDLL.bestTarget) + 'pt', 8),
      pad(fmt(r.optDLL.bestWR * 100) + '%', 7), pad('$' + fmt(r.optDLL.bestEV, 2), 8),
      pad(fmt(touchPct) + '%', 6),
    ].join(' | ');
    console.log(row);
  }

  // ==========================================================================
  // 6. KEY QUESTION 1: Does 5-day IB MID outperform 1-day IB MID?
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('Q1: DOES 5-DAY IB MID OUTPERFORM 1-DAY IB MID?');
  console.log('='.repeat(160));

  const ibMid1D = summaryRows.find(r => r.levelName === 'IB_MID_1D');
  const ibMid5D = summaryRows.find(r => r.levelName === 'IB_MID_5D');

  if (ibMid1D && ibMid5D) {
    const compare = (label, a, b) => {
      console.log(`  ${padR(label, 16)} 1D: ${pad(fmt(a), 8)}   5D: ${pad(fmt(b), 8)}   Delta: ${pad(fmt(b - a, 2), 8)}  ${b > a ? '5D WINS' : b < a ? '1D WINS' : 'TIE'}`);
    };
    compare('N', ibMid1D.n, ibMid5D.n);
    compare('WR@20pt', ibMid1D.wr20, ibMid5D.wr20);
    compare('WR@30pt', ibMid1D.wr30, ibMid5D.wr30);
    compare('MAE P50', ibMid1D.maeP.p50, ibMid5D.maeP.p50);
    compare('MAE P90', ibMid1D.maeP.p90, ibMid5D.maeP.p90);
    compare('MFE P50', ibMid1D.mfeP.p50, ibMid5D.mfeP.p50);
    compare('MFE/MAE', ibMid1D.mfeMaeRatio === Infinity ? 99 : ibMid1D.mfeMaeRatio,
                        ibMid5D.mfeMaeRatio === Infinity ? 99 : ibMid5D.mfeMaeRatio);
    compare('DLL EV', ibMid1D.optDLL.bestEV, ibMid5D.optDLL.bestEV);
    compare('Opt EV', ibMid1D.opt.bestEV, ibMid5D.opt.bestEV);
    const f1 = touchFreq['IB_MID_1D'], f5 = touchFreq['IB_MID_5D'];
    if (f1 && f5) {
      compare('Touch %', f1.daysWithTouch / f1.totalDays * 100, f5.daysWithTouch / f5.totalDays * 100);
    }
  }

  // ==========================================================================
  // 7. KEY QUESTION 2: Median vs Mean (composite min/max)
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('Q2: MEDIAN IB MID vs COMPOSITE (min/max) IB MID — less outlier-sensitive?');
  console.log('='.repeat(160));

  for (const w of [3, 5, 10]) {
    const composite = summaryRows.find(r => r.levelName === `IB_MID_${w}D`);
    const med = summaryRows.find(r => r.levelName === `MEDIAN_IB_MID_${w}D`);
    if (!composite || !med) continue;

    console.log(`\n  --- ${w}-DAY WINDOW ---`);
    const cmp = (label, a, b) => {
      console.log(`    ${padR(label, 16)} Composite: ${pad(fmt(a), 8)}   Median: ${pad(fmt(b), 8)}   ${b > a ? 'MEDIAN WINS' : b < a ? 'COMPOSITE WINS' : 'TIE'}`);
    };
    cmp('N', composite.n, med.n);
    cmp('WR@20pt', composite.wr20, med.wr20);
    cmp('MAE P50', composite.maeP.p50, med.maeP.p50);
    cmp('MFE P50', composite.mfeP.p50, med.mfeP.p50);
    cmp('DLL EV', composite.optDLL.bestEV, med.optDLL.bestEV);
  }

  // ==========================================================================
  // 8. KEY QUESTION 3: Which window is best? 3 vs 5 vs 10
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('Q3: BEST WINDOW — 1D vs 3D vs 5D vs 10D IB MID');
  console.log('='.repeat(160));

  const ibMidLevels = summaryRows.filter(r => r.levelName.match(/^IB_MID_\d+D$/));
  if (ibMidLevels.length > 0) {
    const hdr3 = [
      padR('Level', 16), pad('N', 5),
      pad('WR10', 6), pad('WR20', 6), pad('WR30', 6),
      pad('MAE P50', 8), pad('MFE P50', 8), pad('MFE/MAE', 8),
      pad('DLL EV', 8), pad('Opt EV', 8),
      pad('Touch%', 7),
    ].join(' | ');
    console.log(hdr3);
    console.log('-'.repeat(hdr3.length));

    for (const r of ibMidLevels.sort((a, b) => a.window - b.window)) {
      const freq = touchFreq[r.levelName];
      const touchPct = freq ? (freq.daysWithTouch / freq.totalDays * 100) : 0;
      const ratio = r.mfeMaeRatio === Infinity ? 99 : r.mfeMaeRatio;
      const row = [
        padR(r.levelName, 16), pad(r.n, 5),
        pad(fmt(r.wr10) + '%', 6), pad(fmt(r.wr20) + '%', 6), pad(fmt(r.wr30) + '%', 6),
        pad(fmt(r.maeP.p50), 8), pad(fmt(r.mfeP.p50), 8), pad(fmt(ratio, 2) + 'x', 8),
        pad('$' + fmt(r.optDLL.bestEV, 2), 8), pad('$' + fmt(r.opt.bestEV, 2), 8),
        pad(fmt(touchPct) + '%', 7),
      ].join(' | ');
      console.log(row);
    }

    const bestWindow = ibMidLevels.sort((a, b) => b.optDLL.bestEV - a.optDLL.bestEV)[0];
    console.log(`\n  BEST WINDOW: ${bestWindow.levelName} (DLL EV=$${fmt(bestWindow.optDLL.bestEV, 2)})`);
  }

  // ==========================================================================
  // 9. KEY QUESTION 4: IB Width as signal — narrow = compression
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('Q4: IB WIDTH AS SIGNAL — Does narrow rolling IB (compression) improve fades?');
  console.log('='.repeat(160));

  for (const w of [3, 5, 10]) {
    const levelName = `IB_MID_${w}D`;
    const touches = byLevel[levelName];
    if (!touches || touches.length < 20) continue;

    const touchesWithWidth = touches.filter(t => t.rollingIBWidth != null);
    if (touchesWithWidth.length < 20) continue;

    const widths = touchesWithWidth.map(t => t.rollingIBWidth);
    const medianWidth = median(widths);

    const narrow = touchesWithWidth.filter(t => t.rollingIBWidth <= medianWidth);
    const wide = touchesWithWidth.filter(t => t.rollingIBWidth > medianWidth);

    if (narrow.length < 8 || wide.length < 8) continue;

    const narrowWR20 = narrow.filter(t => t.fadeSuccess20).length / narrow.length * 100;
    const wideWR20 = wide.filter(t => t.fadeSuccess20).length / wide.length * 100;
    const narrowOpt = optimizeDLL(narrow);
    const wideOpt = optimizeDLL(wide);
    const narrowMAE = median(narrow.map(t => t.mae30));
    const wideMAE = median(wide.map(t => t.mae30));
    const narrowMFE = median(narrow.map(t => t.mfe30));
    const wideMFE = median(wide.map(t => t.mfe30));

    console.log(`\n  ${w}-DAY IB_MID (split at median width ${fmt(medianWidth)}pt):`);
    console.log(`    NARROW (<=median): N=${pad(narrow.length, 4)}  WR20=${fmt(narrowWR20)}%  MAE P50=${fmt(narrowMAE)}  MFE P50=${fmt(narrowMFE)}  DLL EV=$${fmt(narrowOpt.bestEV, 2)}`);
    console.log(`    WIDE   (>median):  N=${pad(wide.length, 4)}  WR20=${fmt(wideWR20)}%  MAE P50=${fmt(wideMAE)}  MFE P50=${fmt(wideMFE)}  DLL EV=$${fmt(wideOpt.bestEV, 2)}`);
    console.log(`    ${narrowOpt.bestEV > wideOpt.bestEV ? 'NARROW WINS: compression improves fades' : 'WIDE WINS: expansion improves fades (or width is not a filter)'}`);

    // Q25 vs Q75 for more extreme split
    const q25Width = percentile(widths, 25);
    const q75Width = percentile(widths, 75);
    const veryNarrow = touchesWithWidth.filter(t => t.rollingIBWidth <= q25Width);
    const veryWide = touchesWithWidth.filter(t => t.rollingIBWidth >= q75Width);

    if (veryNarrow.length >= 5 && veryWide.length >= 5) {
      const vnWR = veryNarrow.filter(t => t.fadeSuccess20).length / veryNarrow.length * 100;
      const vwWR = veryWide.filter(t => t.fadeSuccess20).length / veryWide.length * 100;
      console.log(`    EXTREME: Very narrow (<=P25 ${fmt(q25Width)}pt): N=${veryNarrow.length} WR20=${fmt(vnWR)}%  |  Very wide (>=P75 ${fmt(q75Width)}pt): N=${veryWide.length} WR20=${fmt(vwWR)}%`);
    }
  }

  // ==========================================================================
  // 10. KEY QUESTION 5: Stability already covered in section 2
  // ==========================================================================

  // ==========================================================================
  // 11. KEY QUESTION 6: Extreme day impact — 1-day vs rolling after >2σ sessions
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('Q6: EXTREME DAY IMPACT — After >2-sigma prior session, does rolling outperform 1-day?');
  console.log(`    2-sigma threshold: ${fmt(extremeThreshold)}pt range`);
  console.log('='.repeat(160));

  // Count extreme days
  const extremeDayCount = allTouches.filter(t => t.priorDayExtreme).length;
  const normalDayCount = allTouches.filter(t => !t.priorDayExtreme).length;
  console.log(`  Touches after extreme prior day: ${extremeDayCount}`);
  console.log(`  Touches after normal prior day: ${normalDayCount}\n`);

  for (const baseName of ['IB_MID', 'IB_HIGH', 'IB_LOW']) {
    const oneDLevel = `${baseName}_1D`;
    const fiveDLevel = `${baseName}_5D`;
    const oneD = byLevel[oneDLevel]?.filter(t => t.priorDayExtreme) ?? [];
    const fiveD = byLevel[fiveDLevel]?.filter(t => t.priorDayExtreme) ?? [];
    const oneD_normal = byLevel[oneDLevel]?.filter(t => !t.priorDayExtreme) ?? [];
    const fiveD_normal = byLevel[fiveDLevel]?.filter(t => !t.priorDayExtreme) ?? [];

    console.log(`  ${baseName}:`);
    if (oneD.length >= 3 || fiveD.length >= 3) {
      const wr1 = oneD.length > 0 ? (oneD.filter(t => t.fadeSuccess20).length / oneD.length * 100) : 0;
      const wr5 = fiveD.length > 0 ? (fiveD.filter(t => t.fadeSuccess20).length / fiveD.length * 100) : 0;
      const mae1 = oneD.length > 0 ? median(oneD.map(t => t.mae30)) : 0;
      const mae5 = fiveD.length > 0 ? median(fiveD.map(t => t.mae30)) : 0;
      console.log(`    EXTREME prior day:  1D: N=${pad(oneD.length, 3)} WR20=${fmt(wr1)}% MAE_P50=${fmt(mae1)}  |  5D: N=${pad(fiveD.length, 3)} WR20=${fmt(wr5)}% MAE_P50=${fmt(mae5)}  |  ${wr5 > wr1 ? '5D WINS' : '1D WINS'}`);
    } else {
      console.log(`    EXTREME prior day:  1D: N=${oneD.length}  5D: N=${fiveD.length}  (insufficient data)`);
    }

    if (oneD_normal.length >= 5 && fiveD_normal.length >= 5) {
      const wr1n = oneD_normal.filter(t => t.fadeSuccess20).length / oneD_normal.length * 100;
      const wr5n = fiveD_normal.filter(t => t.fadeSuccess20).length / fiveD_normal.length * 100;
      console.log(`    NORMAL prior day:   1D: N=${pad(oneD_normal.length, 3)} WR20=${fmt(wr1n)}%  |  5D: N=${pad(fiveD_normal.length, 3)} WR20=${fmt(wr5n)}%  |  ${wr5n > wr1n ? '5D WINS' : '1D WINS'}`);
    }
  }

  // ==========================================================================
  // 12. KEY QUESTION 7: Compare ALL rolling levels to 1-day equivalents
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('Q7: ROLLING vs 1-DAY — Is rolling ALWAYS better?');
  console.log('='.repeat(160));

  const baseLevels = ['IB_HIGH', 'IB_LOW', 'IB_MID', 'OR_MID', 'SESSION_MID', 'POC_AVG'];
  for (const base of baseLevels) {
    const oneD = summaryRows.find(r => r.levelName === `${base}_1D`);
    if (!oneD) continue;

    console.log(`\n  ${base}:`);
    const variants = summaryRows.filter(r => r.levelName.startsWith(base + '_') && r.levelName !== `${base}_1D`);
    if (variants.length === 0) {
      console.log(`    No rolling variants computed`);
      continue;
    }

    const cmpHdr = [
      padR('Level', 24), pad('N', 5), pad('WR20', 6), pad('MAE P50', 8), pad('MFE P50', 8), pad('DLL EV', 8), pad('vs 1D EV', 9),
    ].join(' | ');
    console.log(`    ${cmpHdr}`);
    console.log(`    ${'-'.repeat(cmpHdr.length)}`);

    // Print 1D baseline first
    const freq1 = touchFreq[oneD.levelName];
    console.log(`    ${[
      padR(oneD.levelName + ' (base)', 24), pad(oneD.n, 5), pad(fmt(oneD.wr20) + '%', 6),
      pad(fmt(oneD.maeP.p50), 8), pad(fmt(oneD.mfeP.p50), 8),
      pad('$' + fmt(oneD.optDLL.bestEV, 2), 8), pad('---', 9),
    ].join(' | ')}`);

    for (const v of variants.sort((a, b) => a.window - b.window)) {
      const evDelta = v.optDLL.bestEV - oneD.optDLL.bestEV;
      const row = [
        padR(v.levelName, 24), pad(v.n, 5), pad(fmt(v.wr20) + '%', 6),
        pad(fmt(v.maeP.p50), 8), pad(fmt(v.mfeP.p50), 8),
        pad('$' + fmt(v.optDLL.bestEV, 2), 8),
        pad((evDelta >= 0 ? '+' : '') + '$' + fmt(evDelta, 2), 9),
      ].join(' | ');
      console.log(`    ${row}  ${evDelta > 0 ? 'ROLLING WINS' : evDelta < 0 ? '1D WINS' : 'TIE'}`);
    }
  }

  // ==========================================================================
  // 13. KEY QUESTION 8: Touch frequency comparison
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('Q8: TOUCH FREQUENCY — More frequent = more opportunities');
  console.log('='.repeat(160));

  const freqHdr = [padR('Level', 24), pad('Touch%', 7), pad('Days', 5), pad('N touches', 10)].join(' | ');
  console.log(freqHdr);
  console.log('-'.repeat(freqHdr.length));

  const freqSorted = Object.entries(touchFreq)
    .filter(([name]) => summaryRows.some(r => r.levelName === name))
    .sort((a, b) => (b[1].daysWithTouch / b[1].totalDays) - (a[1].daysWithTouch / a[1].totalDays));

  for (const [name, freq] of freqSorted) {
    const pct = freq.totalDays > 0 ? (freq.daysWithTouch / freq.totalDays * 100) : 0;
    const nTouches = byLevel[name]?.length ?? 0;
    console.log([padR(name, 24), pad(fmt(pct) + '%', 7), pad(freq.totalDays, 5), pad(nTouches, 10)].join(' | '));
  }

  // ==========================================================================
  // 14. PER-LEVEL CONTEXT SPLITS (first touch vs retouch, AM vs PM)
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('CONTEXT SPLITS: First touch vs retouch, AM vs PM (top levels only)');
  console.log('='.repeat(160));

  // Only do context splits for IB_MID variants and top performers
  const contextLevels = summaryRows
    .filter(r => r.n >= 20)
    .sort((a, b) => b.optDLL.bestEV - a.optDLL.bestEV)
    .slice(0, 10);

  for (const r of contextLevels) {
    console.log(`\n  ${r.levelName} (N=${r.n}):`);

    // First touch vs retouch
    if (r.nFirst >= 8 && r.nRetouch >= 8) {
      const firstWR = r.firstTouches.filter(t => t.fadeSuccess20).length / r.nFirst * 100;
      const retouchWR = r.retouches.filter(t => t.fadeSuccess20).length / r.nRetouch * 100;
      const firstOpt = optimizeDLL(r.firstTouches);
      const retouchOpt = optimizeDLL(r.retouches);
      console.log(`    First touch:  N=${pad(r.nFirst, 4)}  WR20=${fmt(firstWR)}%  DLL EV=$${fmt(firstOpt.bestEV, 2)}`);
      console.log(`    Retouch:      N=${pad(r.nRetouch, 4)}  WR20=${fmt(retouchWR)}%  DLL EV=$${fmt(retouchOpt.bestEV, 2)}`);
    }

    // AM vs PM
    const am = r.touches.filter(t => t.isAM);
    const pm = r.touches.filter(t => !t.isAM);
    if (am.length >= 8 && pm.length >= 8) {
      const amWR = am.filter(t => t.fadeSuccess20).length / am.length * 100;
      const pmWR = pm.filter(t => t.fadeSuccess20).length / pm.length * 100;
      const amOpt = optimizeDLL(am);
      const pmOpt = optimizeDLL(pm);
      console.log(`    AM (9:30-12): N=${pad(am.length, 4)}  WR20=${fmt(amWR)}%  DLL EV=$${fmt(amOpt.bestEV, 2)}`);
      console.log(`    PM (12-4):    N=${pad(pm.length, 4)}  WR20=${fmt(pmWR)}%  DLL EV=$${fmt(pmOpt.bestEV, 2)}`);
    }

    // Day type
    for (const dt of ['TREND', 'BALANCE', 'TURBULENT']) {
      const dtTouches = r.touches.filter(t => t.dayType === dt);
      if (dtTouches.length >= 8) {
        const dtWR = dtTouches.filter(t => t.fadeSuccess20).length / dtTouches.length * 100;
        const dtOpt = optimizeDLL(dtTouches);
        console.log(`    ${padR(dt + ':', 14)} N=${pad(dtTouches.length, 4)}  WR20=${fmt(dtWR)}%  DLL EV=$${fmt(dtOpt.bestEV, 2)}`);
      }
    }
  }

  // ==========================================================================
  // 15. PER-LEVEL MAE/MFE DISTRIBUTIONS
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('MAE/MFE DISTRIBUTIONS (30-bar and 60-bar horizons)');
  console.log('='.repeat(160));

  const distHdr = [
    padR('Level', 24),
    pad('MAE P25', 8), pad('MAE P50', 8), pad('MAE P75', 8), pad('MAE P90', 8),
    pad('MFE P25', 8), pad('MFE P50', 8), pad('MFE P75', 8), pad('MFE P90', 8),
  ].join(' | ');
  console.log('  30-bar horizon:');
  console.log(`  ${distHdr}`);
  console.log(`  ${'-'.repeat(distHdr.length)}`);

  for (const r of sorted) {
    const row = [
      padR(r.levelName, 24),
      pad(fmt(r.maeP.p25), 8), pad(fmt(r.maeP.p50), 8), pad(fmt(r.maeP.p75), 8), pad(fmt(r.maeP.p90), 8),
      pad(fmt(r.mfeP.p25), 8), pad(fmt(r.mfeP.p50), 8), pad(fmt(r.mfeP.p75), 8), pad(fmt(r.mfeP.p90), 8),
    ].join(' | ');
    console.log(`  ${row}`);
  }

  console.log('\n  60-bar horizon:');
  console.log(`  ${distHdr}`);
  console.log(`  ${'-'.repeat(distHdr.length)}`);

  for (const r of sorted) {
    const row = [
      padR(r.levelName, 24),
      pad(fmt(r.maeP60.p25), 8), pad(fmt(r.maeP60.p50), 8), pad(fmt(r.maeP60.p75), 8), pad(fmt(r.maeP60.p90), 8),
      pad(fmt(r.mfeP60.p25), 8), pad(fmt(r.mfeP60.p50), 8), pad(fmt(r.mfeP60.p75), 8), pad(fmt(r.mfeP60.p90), 8),
    ].join(' | ');
    console.log(`  ${row}`);
  }

  // ==========================================================================
  // 16. FADE WR AT 90pt STOP TABLE
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('FADE WR AT 90pt STOP / MULTIPLE TARGETS');
  console.log('='.repeat(160));

  const fadeHdr = [
    padR('Level', 24), pad('N', 5),
    pad('WR@10', 7), pad('EV@10', 7),
    pad('WR@20', 7), pad('EV@20', 7),
    pad('WR@30', 7), pad('EV@30', 7),
    pad('WR@40', 7), pad('EV@40', 7),
  ].join(' | ');
  console.log(fadeHdr);
  console.log('-'.repeat(fadeHdr.length));

  for (const r of sorted) {
    const row = [
      padR(r.levelName, 24), pad(r.n, 5),
      pad(fmt(r.fade90_10.wr * 100) + '%', 7), pad('$' + fmt(r.fade90_10.ev, 2), 7),
      pad(fmt(r.fade90_20.wr * 100) + '%', 7), pad('$' + fmt(r.fade90_20.ev, 2), 7),
      pad(fmt(r.fade90_30.wr * 100) + '%', 7), pad('$' + fmt(r.fade90_30.ev, 2), 7),
      pad(fmt(r.fade90_40.wr * 100) + '%', 7), pad('$' + fmt(r.fade90_40.ev, 2), 7),
    ].join(' | ');
    console.log(row);
  }

  // ==========================================================================
  // 17. STORE IN performance_audit
  // ==========================================================================
  console.log('\n\nStoring results in performance_audit...');

  await query(`DELETE FROM performance_audit WHERE signal_type = 'ROLLING_IB_AUDIT'`);

  for (const r of sorted) {
    const freq = touchFreq[r.levelName];
    const touchPct = freq && freq.totalDays > 0 ? (freq.daysWithTouch / freq.totalDays * 100) : 0;

    await query(`
      INSERT INTO performance_audit (
        run_date, window_days, signal_type, signal_name,
        sample_size, win_rate, ev_per_trade, total_pnl,
        avg_mfe, p50_mfe, p75_mfe,
        avg_mae, p50_mae, p75_mae, p90_mae,
        avg_duration_min,
        optimal_stop, optimal_target, optimal_ev,
        recommendation, notes
      ) VALUES (
        CURRENT_DATE, $1, 'ROLLING_IB_AUDIT', $2,
        $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12, $13,
        $14,
        $15, $16, $17,
        $18, $19
      )
    `, [
      WINDOW_DAYS,
      r.levelName,
      r.n,
      r.wr20,
      r.optDLL.bestEV,
      r.optDLL.bestEV * r.n,
      mean(r.touches.map(t => t.mfe30)),
      r.mfeP.p50,
      r.mfeP.p75,
      mean(r.touches.map(t => t.mae30)),
      r.maeP.p50,
      r.maeP.p75,
      r.maeP.p90,
      r.avgTimeToPeak,
      r.optDLL.bestStop,
      r.optDLL.bestTarget,
      r.optDLL.bestEV,
      r.optDLL.bestEV > 0 ? 'DLL_TRADEABLE' : 'NOT_TRADEABLE',
      JSON.stringify({
        fadeWR: { wr10: r.wr10, wr20: r.wr20, wr30: r.wr30, wr40: r.wr40 },
        fadeAt90Stop: {
          wr10: r.fade90_10.wr * 100, ev10: r.fade90_10.ev,
          wr20: r.fade90_20.wr * 100, ev20: r.fade90_20.ev,
          wr30: r.fade90_30.wr * 100, ev30: r.fade90_30.ev,
          wr40: r.fade90_40.wr * 100, ev40: r.fade90_40.ev,
        },
        window: r.window,
        firstTouchCount: r.nFirst,
        retouchCount: r.nRetouch,
        touchFrequencyPct: touchPct,
        mfeMaeRatio: r.mfeMaeRatio === Infinity ? null : r.mfeMaeRatio,
        maeP60: r.maeP60,
        mfeP60: r.mfeP60,
        dllConstrained: {
          stop: r.optDLL.bestStop,
          target: r.optDLL.bestTarget,
          wr: r.optDLL.bestWR,
          ev: r.optDLL.bestEV,
        },
        unConstrained: {
          stop: r.opt.bestStop,
          target: r.opt.bestTarget,
          wr: r.opt.bestWR,
          ev: r.opt.bestEV,
        },
      }),
    ]);
  }

  console.log(`Stored ${sorted.length} rows in performance_audit with signal_type='ROLLING_IB_AUDIT'.`);

  // ==========================================================================
  // 18. FINAL RECOMMENDATIONS
  // ==========================================================================
  console.log('\n' + '='.repeat(160));
  console.log('FINAL RECOMMENDATIONS');
  console.log('='.repeat(160));

  // Best IB_MID variant
  const bestIBMid = summaryRows
    .filter(r => r.levelName.match(/IB_MID/))
    .sort((a, b) => b.optDLL.bestEV - a.optDLL.bestEV)[0];
  if (bestIBMid) {
    console.log(`\n  BEST IB MID variant: ${bestIBMid.levelName}`);
    console.log(`    DLL EV: $${fmt(bestIBMid.optDLL.bestEV, 2)}/trade  Stop=${fmt(bestIBMid.optDLL.bestStop)}pt  Target=${fmt(bestIBMid.optDLL.bestTarget)}pt  WR=${fmt(bestIBMid.optDLL.bestWR * 100)}%`);
    const f = touchFreq[bestIBMid.levelName];
    if (f) console.log(`    Touch frequency: ${fmt(f.daysWithTouch / f.totalDays * 100)}% of days`);
  }

  // Best overall level
  const bestOverall = sorted[0];
  if (bestOverall) {
    console.log(`\n  BEST OVERALL level: ${bestOverall.levelName}`);
    console.log(`    DLL EV: $${fmt(bestOverall.optDLL.bestEV, 2)}/trade  Stop=${fmt(bestOverall.optDLL.bestStop)}pt  Target=${fmt(bestOverall.optDLL.bestTarget)}pt  WR=${fmt(bestOverall.optDLL.bestWR * 100)}%`);
  }

  // Rolling vs 1-day verdict
  console.log('\n  ROLLING vs 1-DAY VERDICT:');
  let rollingWins = 0, oneDayWins = 0;
  for (const base of ['IB_HIGH', 'IB_LOW', 'IB_MID']) {
    const oneD = summaryRows.find(r => r.levelName === `${base}_1D`);
    if (!oneD) continue;
    for (const w of [3, 5, 10]) {
      const rolling = summaryRows.find(r => r.levelName === `${base}_${w}D`);
      if (!rolling) continue;
      if (rolling.optDLL.bestEV > oneD.optDLL.bestEV) rollingWins++;
      else oneDayWins++;
    }
  }
  console.log(`    Rolling wins: ${rollingWins} comparisons`);
  console.log(`    1-Day wins:   ${oneDayWins} comparisons`);
  console.log(`    ${rollingWins > oneDayWins ? 'ROLLING composites generally outperform 1-day levels' : rollingWins < oneDayWins ? '1-DAY levels generally outperform rolling composites' : 'MIXED — no clear winner; use context-specific filters'}`);

  // Positive EV levels
  const posEV = sorted.filter(r => r.optDLL.bestEV > 0);
  if (posEV.length > 0) {
    console.log(`\n  POSITIVE EV LEVELS (DLL-safe):`);
    for (const r of posEV) {
      const freq = touchFreq[r.levelName];
      const touchPct = freq ? fmt(freq.daysWithTouch / freq.totalDays * 100) : '?';
      console.log(`    ${padR(r.levelName, 24)} EV=$${fmt(r.optDLL.bestEV, 2)}  WR=${fmt(r.optDLL.bestWR * 100)}%  Stop=${fmt(r.optDLL.bestStop)}pt  Tgt=${fmt(r.optDLL.bestTarget)}pt  Touch=${touchPct}%`);
    }
  }

  const negEV = sorted.filter(r => r.optDLL.bestEV <= 0);
  if (negEV.length > 0) {
    console.log(`\n  NEGATIVE EV LEVELS (avoid):`);
    for (const r of negEV) {
      console.log(`    ${padR(r.levelName, 24)} EV=$${fmt(r.optDLL.bestEV, 2)}  N=${r.n}`);
    }
  }

  console.log('\n' + '='.repeat(160));
  console.log('ROLLING IB COMPOSITE AUDIT COMPLETE');
  console.log('='.repeat(160));
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
