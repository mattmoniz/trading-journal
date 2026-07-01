// =============================================================================
// MIDPOINT LEVEL FADE MAE/MFE AUDIT
// Bar-by-bar replay over 180 days. Tests OR_MID, IB_MID, SESSION_MID, VWAP,
// PD_MID, and OR_MID_AFTER_IB for fade/scalp viability.
// Includes: magnet effect, bounce vs break, time-of-day profile, scalp sizing.
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

  // 2. Developing value log (has session_high, session_low)
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

// ─── Midpoint Level Definitions ──────────────────────────────────────────────

function getMidpointLevels(date, priorDate, vaByDate, acdByDate, barsByDate) {
  const levels = [];
  const bars = barsByDate[date];
  if (!bars || bars.length < 30) return levels;

  // 1. OR_MID — midpoint of 5-min opening range
  const orBars = bars.filter(b => b.et_min >= 570 && b.et_min < 575);
  let orHigh = null, orLow = null, orMid = null;
  if (orBars.length > 0) {
    orHigh = Math.max(...orBars.map(b => b.high));
    orLow = Math.min(...orBars.map(b => b.low));
    orMid = (orHigh + orLow) / 2;
    levels.push({ name: 'OR_MID', value: orMid, availableAt: 575, isDynamic: false });
  }

  // 2. IB_MID — midpoint of initial balance (first 60 minutes)
  const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
  if (ibBars.length >= 30) {
    const ibHigh = Math.max(...ibBars.map(b => b.high));
    const ibLow = Math.min(...ibBars.map(b => b.low));
    const ibMid = (ibHigh + ibLow) / 2;
    levels.push({ name: 'IB_MID', value: ibMid, availableAt: 630, isDynamic: false });
  }

  // 3. SESSION_MID — developing midpoint; computed per bar (special handling in replay)
  levels.push({ name: 'SESSION_MID', value: null, availableAt: 580, isDynamic: true });

  // 4. VWAP — volume-weighted average price, computed per bar (special handling in replay)
  levels.push({ name: 'VWAP', value: null, availableAt: 575, isDynamic: true });

  // 5. PD_MID — prior day session midpoint
  const pdVA = vaByDate[priorDate];
  if (pdVA && pdVA.sh && pdVA.sl) {
    const pdMid = (pdVA.sh + pdVA.sl) / 2;
    levels.push({ name: 'PD_MID', value: pdMid, availableAt: 570, isDynamic: false });
  }

  // 6. OR_MID_AFTER_IB — OR midpoint tested AFTER IB forms (same value as OR_MID, but only valid after 10:30)
  if (orMid !== null) {
    levels.push({ name: 'OR_MID_AFTER_IB', value: orMid, availableAt: 630, isDynamic: false });
  }

  return levels;
}

// ─── Replay Engine ───────────────────────────────────────────────────────────

function replayDay(date, bars, levels, dayType, devRange) {
  const touches = [];
  const touchedLevels = new Set();
  const retouchTracker = {};

  // Developing session state for dynamic levels
  let sessionHigh = -Infinity;
  let sessionLow = Infinity;
  let cumVWAP = 0;       // cumulative (price * volume)
  let cumVol = 0;         // cumulative volume

  // Magnet tracking: for each level, track if price was within 50pt at some point
  // and whether it eventually touched
  const magnetApproaches = {};

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Update developing session state
    sessionHigh = Math.max(sessionHigh, bar.high);
    sessionLow = Math.min(sessionLow, bar.low);
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    const barVol = Number(bar.vol) || 1;
    cumVWAP += typicalPrice * barVol;
    cumVol += barVol;

    // Compute current dynamic level values
    const currentSessionMid = (sessionHigh + sessionLow) / 2;
    const currentVWAP = cumVol > 0 ? cumVWAP / cumVol : bar.close;

    // Skip first 10 bars for entry (need lookback)
    if (i < 10) continue;

    for (const level of levels) {
      if (bar.et_min < level.availableAt) continue;

      // Resolve dynamic level value
      let levelValue;
      if (level.isDynamic) {
        if (level.name === 'SESSION_MID') levelValue = currentSessionMid;
        else if (level.name === 'VWAP') levelValue = currentVWAP;
        else continue;
      } else {
        levelValue = level.value;
      }
      if (levelValue === null || levelValue === undefined) continue;

      // Magnet tracking: approach within 50pt
      const distToLevel = Math.abs(bar.close - levelValue);
      if (distToLevel <= 50 && distToLevel > PROX) {
        if (!magnetApproaches[level.name]) {
          magnetApproaches[level.name] = { approached: 0, touched: 0 };
        }
        // Only count unique approach episodes (reset when price moves away > 80pt)
        const lastApproachBar = magnetApproaches[level.name]._lastApproachBar ?? -999;
        if (i - lastApproachBar > 15) {
          magnetApproaches[level.name].approached++;
          magnetApproaches[level.name]._lastApproachBar = i;
          magnetApproaches[level.name]._currentApproachTouched = false;
        }
      }

      const dist = bar.close - levelValue;
      if (Math.abs(dist) > PROX) continue;

      // Mark magnet approach as touched
      if (magnetApproaches[level.name] && !magnetApproaches[level.name]._currentApproachTouched) {
        magnetApproaches[level.name].touched++;
        magnetApproaches[level.name]._currentApproachTouched = true;
      }

      const isFirstTouch = !touchedLevels.has(level.name);
      const lastRetouchBar = retouchTracker[level.name] ?? -999;

      // Debounce: require 10+ bars between touches of same level
      if (i - lastRetouchBar < 10) continue;

      // Determine approach direction from prior 5 bars
      const lookback = Math.min(5, i);
      const priorCloses = bars.slice(i - lookback, i).map(b => b.close);
      const priorAvg = mean(priorCloses);
      const fromBelow = priorAvg < levelValue - 3;
      const fromAbove = priorAvg > levelValue + 3;
      if (!fromBelow && !fromAbove) continue;

      // Fade direction
      const fadeDir = fromBelow ? 'SHORT' : 'LONG';
      const entryPx = bar.close;
      const entryIdx = i;

      // Delta state at touch
      const touchDelta = Number(bar.ask_vol) - Number(bar.bid_vol);
      const deltaOpposing = fromBelow ? touchDelta < 0 : touchDelta > 0;

      // AM vs PM
      const isAM = bar.et_min < 720;

      // Time-of-day bucket (30-min intervals)
      const todBucket = Math.floor(bar.et_min / 30) * 30;

      // Build forward bar path
      const fwdBars = [];
      let mfe30 = 0, mae30 = 0, mfe60 = 0, mae60 = 0;
      let timeToPeakMFE30 = 0, timeToPeakMFE60 = 0;
      let fadeSuccess10 = false, fadeSuccess20 = false, fadeSuccess30 = false, fadeSuccess40 = false;

      // Track bounce vs break: does price move 20pt+ through the level? (break)
      // Or does it reverse from the level? (bounce)
      let maxPenetration = 0; // how far through level price goes

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

        // Track penetration through the level (adverse direction)
        maxPenetration = Math.max(maxPenetration, advOnBar);

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

      // Bounce = fade succeeded (MFE >= 15pt), Break = price went 20pt+ through
      const isBounce = mfe30 >= 15;
      const isBreak = maxPenetration >= 20;

      touchedLevels.add(level.name);
      retouchTracker[level.name] = i;

      touches.push({
        date,
        levelName: level.name,
        levelValue,
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
        mfe30, mae30, mfe60, mae60,
        timeToPeakMFE30, timeToPeakMFE60,
        fadeSuccess10, fadeSuccess20, fadeSuccess30, fadeSuccess40,
        isBounce, isBreak, maxPenetration,
        fwdBars,
      });
    }
  }

  return { touches, magnetApproaches };
}

// ─── Optimal Stop/Target Optimizer ──────────────────────────────────────────

function simulateTrade(touch, stop, target, horizon = MFE_HORIZON_SHORT) {
  const bars = touch.fwdBars;
  const limit = Math.min(horizon, bars.length);
  for (let j = 0; j < limit; j++) {
    const b = bars[j];
    const stopHit = b.adv >= stop;
    const targetHit = b.fav >= target;
    if (stopHit && targetHit) return 'LOSS'; // conservative
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
  // DLL-safe: cap stop so dollar risk <= DLL/2 = $200 => max stop 99pt
  const maxStop = Math.floor((DLL / 2 - COMMISSION) / PNL_PER_POINT);
  const result = optimizeStopTarget(touches, maxStop);
  const dollarRisk = result.bestStop * PNL_PER_POINT + COMMISSION;
  return { ...result, dollarRisk };
}

function optimizeScalp(touches) {
  // Scalp: target 15-30pt, stop 20-50pt
  if (!touches.length) return { bestStop: 0, bestTarget: 0, bestEV: 0, bestWR: 0, bestN: 0, dollarRisk: 0 };
  let bestEV = -Infinity, bestStop = 0, bestTarget = 0, bestWR = 0, bestN = 0;

  for (let stop = 20; stop <= 50; stop += 5) {
    for (let target = 15; target <= 30; target += 5) {
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

// Fade WR at specific target with a 90pt stop (for comparison with prior audit)
function fadeWRAtStop90(touches, target) {
  if (!touches.length) return { wr: 0, n: 0 };
  let wins = 0, losses = 0, scratches = 0;
  for (const t of touches) {
    const result = simulateTrade(t, 90, target);
    if (result === 'WIN') wins++;
    else if (result === 'LOSS') losses++;
    else scratches++;
  }
  const n = wins + losses + scratches;
  const wr = wins / (wins + losses || 1);
  return { wr, n, wins, losses, scratches };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(140));
  console.log('MIDPOINT LEVEL FADE MAE/MFE AUDIT');
  console.log(`Window: ${WINDOW_DAYS} days | Proximity: ${PROX}pt | Fade target: ${FADE_TARGET}pt`);
  console.log(`PNL/pt: $${PNL_PER_POINT} | Commission: $${COMMISSION} | DLL: $${DLL}`);
  console.log('Levels: OR_MID, IB_MID, SESSION_MID, VWAP, PD_MID, OR_MID_AFTER_IB');
  console.log('='.repeat(140));

  const { barsByDate, allDates, vaByDate, acdByDate, tradingDates } = await loadData();

  // ─── Replay all days ──────────────────────────────────────────────────────
  console.log('\nReplaying bar-by-bar...');
  const allTouches = [];
  const allMagnetData = {}; // level -> { approached, touched }
  let dayCount = 0;

  for (const date of tradingDates) {
    const bars = barsByDate[date];
    if (!bars || bars.length < 30) continue;

    const dateIdx = allDates.indexOf(date);
    if (dateIdx < 1) continue;
    const priorDate = allDates[dateIdx - 1];

    const acd = acdByDate[date];
    const dayType = acd?.day_type || 'UNKNOWN';

    const va = vaByDate[date];
    const devRange = va ? (va.sh - va.sl) : null;

    const levels = getMidpointLevels(date, priorDate, vaByDate, acdByDate, barsByDate);
    if (levels.length === 0) continue;

    const { touches, magnetApproaches } = replayDay(date, bars, levels, dayType, devRange);
    allTouches.push(...touches);

    // Aggregate magnet data
    for (const [name, data] of Object.entries(magnetApproaches)) {
      if (!allMagnetData[name]) allMagnetData[name] = { approached: 0, touched: 0 };
      allMagnetData[name].approached += data.approached;
      allMagnetData[name].touched += data.touched;
    }

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
  // 1. MAGNET EFFECT
  // ==========================================================================
  console.log('='.repeat(140));
  console.log('MAGNET EFFECT: When price approaches within 50pt, how often does it reach the midpoint?');
  console.log('='.repeat(140));
  for (const [name, data] of Object.entries(allMagnetData)) {
    const pct = data.approached > 0 ? (data.touched / data.approached * 100) : 0;
    console.log(`  ${padR(name, 18)} Approaches: ${pad(data.approached, 4)}  Touches: ${pad(data.touched, 4)}  Magnet Rate: ${fmt(pct)}%`);
  }
  console.log('');

  // ==========================================================================
  // 2. BOUNCE VS BREAK
  // ==========================================================================
  console.log('='.repeat(140));
  console.log('BOUNCE VS BREAK: At touch, does price fade (bounce 15pt+) or break through (20pt+)?');
  console.log('='.repeat(140));
  for (const [name, touches] of Object.entries(byLevel)) {
    const n = touches.length;
    const bounces = touches.filter(t => t.isBounce).length;
    const breaks = touches.filter(t => t.isBreak).length;
    const both = touches.filter(t => t.isBounce && t.isBreak).length;
    const neither = touches.filter(t => !t.isBounce && !t.isBreak).length;
    console.log(`  ${padR(name, 18)} N=${pad(n, 4)}  Bounce: ${pad(bounces, 4)} (${fmt(bounces/n*100)}%)  Break: ${pad(breaks, 4)} (${fmt(breaks/n*100)}%)  Both: ${pad(both, 3)}  Neither: ${pad(neither, 3)}`);
  }
  console.log('');

  // ==========================================================================
  // 3. TIME-OF-DAY PROFILE
  // ==========================================================================
  console.log('='.repeat(140));
  console.log('TIME-OF-DAY PROFILE: Touch frequency and fade WR by 30-min bucket');
  console.log('='.repeat(140));

  const todBucketLabels = {
    570: '9:30', 600: '10:00', 630: '10:30', 660: '11:00', 690: '11:30',
    720: '12:00', 750: '12:30', 780: '1:00', 810: '1:30', 840: '2:00',
    870: '2:30', 900: '3:00', 930: '3:30'
  };

  for (const [name, touches] of Object.entries(byLevel)) {
    console.log(`\n  --- ${name} ---`);
    const todGroups = {};
    for (const t of touches) {
      (todGroups[t.todBucket] ??= []).push(t);
    }
    const sortedBuckets = Object.keys(todGroups).map(Number).sort((a, b) => a - b);
    for (const bucket of sortedBuckets) {
      const grp = todGroups[bucket];
      const wr10 = grp.filter(t => t.fadeSuccess10).length / grp.length * 100;
      const wr20 = grp.filter(t => t.fadeSuccess20).length / grp.length * 100;
      const wr30 = grp.filter(t => t.fadeSuccess30).length / grp.length * 100;
      const avgMFE = mean(grp.map(t => t.mfe30));
      const avgMAE = mean(grp.map(t => t.mae30));
      const label = todBucketLabels[bucket] || `${bucket}m`;
      console.log(`  ${padR(label, 6)} N=${pad(grp.length, 4)}  WR10=${pad(fmt(wr10), 5)}%  WR20=${pad(fmt(wr20), 5)}%  WR30=${pad(fmt(wr30), 5)}%  avgMFE=${pad(fmt(avgMFE), 6)}  avgMAE=${pad(fmt(avgMAE), 6)}`);
    }
  }
  console.log('');

  // ==========================================================================
  // 4. PER-LEVEL DETAILED ANALYSIS
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

    // DLL-constrained
    const optDLL = optimizeDLL(touches);

    // Scalp optimization (15-30pt target, 20-50pt stop)
    const optScalp = optimizeScalp(touches);

    // 90pt stop fade WR (for comparison with prior audit)
    const fade90_10 = fadeWRAtStop90(touches, 10);
    const fade90_20 = fadeWRAtStop90(touches, 20);
    const fade90_30 = fadeWRAtStop90(touches, 30);
    const fade90_40 = fadeWRAtStop90(touches, 40);

    // Bounce/break rates
    const bounceRate = touches.filter(t => t.isBounce).length / n * 100;
    const breakRate = touches.filter(t => t.isBreak).length / n * 100;

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
      optDLL, optScalp,
      fade90_10, fade90_20, fade90_30, fade90_40,
      bounceRate, breakRate,
    });

    // ─── Print detailed report per level ─────────────────────────────────
    console.log('='.repeat(140));
    console.log(`  ${levelName}  |  N=${n} (first=${nFirst}, retouch=${nRetouch})  |  Bounce: ${fmt(bounceRate)}%  Break: ${fmt(breakRate)}%  |  Peak MFE: ${fmt(avgTimeToPeak, 0)} bars`);
    console.log('='.repeat(140));

    // Fade WR at multiple targets
    console.log(`  Fade WR:     10pt=${fmt(wr10)}%  20pt=${fmt(wr20)}%  30pt=${fmt(wr30)}%  40pt=${fmt(wr40)}%  (30-bar horizon)`);
    console.log(`  @90pt stop:  10pt=${fmt(fade90_10.wr * 100)}%  20pt=${fmt(fade90_20.wr * 100)}%  30pt=${fmt(fade90_30.wr * 100)}%  40pt=${fmt(fade90_40.wr * 100)}%`);

    // MAE/MFE distributions
    console.log(`  MAE 30-bar:  P10=${fmt(maeP.p10)}  P25=${fmt(maeP.p25)}  P50=${fmt(maeP.p50)}  P75=${fmt(maeP.p75)}  P90=${fmt(maeP.p90)}`);
    console.log(`  MFE 30-bar:  P10=${fmt(mfeP.p10)}  P25=${fmt(mfeP.p25)}  P50=${fmt(mfeP.p50)}  P75=${fmt(mfeP.p75)}  P90=${fmt(mfeP.p90)}`);
    console.log(`  MAE 60-bar:  P10=${fmt(maeP60.p10)}  P25=${fmt(maeP60.p25)}  P50=${fmt(maeP60.p50)}  P75=${fmt(maeP60.p75)}  P90=${fmt(maeP60.p90)}`);
    console.log(`  MFE 60-bar:  P10=${fmt(mfeP60.p10)}  P25=${fmt(mfeP60.p25)}  P50=${fmt(mfeP60.p50)}  P75=${fmt(mfeP60.p75)}  P90=${fmt(mfeP60.p90)}`);
    console.log(`  MFE/MAE:     P25=${fmt(mfeMaeRatios.p25, 2)}x  P50=${fmt(mfeMaeRatios.p50, 2)}x  P75=${fmt(mfeMaeRatios.p75, 2)}x`);
    if (maePctOfRange) {
      console.log(`  MAE %range:  P25=${fmt(maePctOfRange.p25)}%  P50=${fmt(maePctOfRange.p50)}%  P75=${fmt(maePctOfRange.p75)}%  P90=${fmt(maePctOfRange.p90)}%`);
      console.log(`  MFE %range:  P25=${fmt(mfePctOfRange.p25)}%  P50=${fmt(mfePctOfRange.p50)}%  P75=${fmt(mfePctOfRange.p75)}%  P90=${fmt(mfePctOfRange.p90)}%`);
    }

    // Optimization results
    console.log(`  OPTIMAL:     Stop=${fmt(opt.bestStop)}pt  Target=${fmt(opt.bestTarget)}pt  WR=${fmt(opt.bestWR * 100)}%  EV=$${fmt(opt.bestEV, 2)}/trade  $Risk=$${fmt(dollarRisk, 0)}  DLL=${dllCompatible ? 'YES' : 'NO'}`);
    console.log(`  DLL-SAFE:    Stop=${fmt(optDLL.bestStop)}pt  Target=${fmt(optDLL.bestTarget)}pt  WR=${fmt(optDLL.bestWR * 100)}%  EV=$${fmt(optDLL.bestEV, 2)}/trade  $Risk=$${fmt(optDLL.dollarRisk, 0)}`);
    console.log(`  SCALP:       Stop=${fmt(optScalp.bestStop)}pt  Target=${fmt(optScalp.bestTarget)}pt  WR=${fmt(optScalp.bestWR * 100)}%  EV=$${fmt(optScalp.bestEV, 2)}/trade  $Risk=$${fmt(optScalp.dollarRisk, 0)}`);

    // ─── Context splits ─────────────────────────────────────────────────
    if (n >= 30) {
      console.log('');
      console.log(`  --- Context Splits ---`);

      // First touch vs retouch
      if (nFirst >= 10 && nRetouch >= 10) {
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
      if (amTouches.length >= 10 && pmTouches.length >= 10) {
        const amWR = amTouches.filter(t => t.fadeSuccess20).length / amTouches.length * 100;
        const pmWR = pmTouches.filter(t => t.fadeSuccess20).length / pmTouches.length * 100;
        const amOpt = optimizeStopTarget(amTouches);
        const pmOpt = optimizeStopTarget(pmTouches);
        const amScalp = optimizeScalp(amTouches);
        const pmScalp = optimizeScalp(pmTouches);
        console.log(`  AM (9:30-12):  N=${pad(amTouches.length, 4)}  WR20=${pad(fmt(amWR), 5)}%  OptEV=$${fmt(amOpt.bestEV, 2)}  ScalpEV=$${fmt(amScalp.bestEV, 2)} (${fmt(amScalp.bestStop)}/${fmt(amScalp.bestTarget)})`);
        console.log(`  PM (12-4):     N=${pad(pmTouches.length, 4)}  WR20=${pad(fmt(pmWR), 5)}%  OptEV=$${fmt(pmOpt.bestEV, 2)}  ScalpEV=$${fmt(pmScalp.bestEV, 2)} (${fmt(pmScalp.bestStop)}/${fmt(pmScalp.bestTarget)})`);
      }

      // Day type
      for (const dt of ['TREND', 'BALANCE', 'TURBULENT']) {
        const dtTouches = touches.filter(t => t.dayType === dt);
        if (dtTouches.length >= 10) {
          const dtWR = dtTouches.filter(t => t.fadeSuccess20).length / dtTouches.length * 100;
          const dtOpt = optimizeStopTarget(dtTouches);
          console.log(`  ${padR(dt + ':', 13)}  N=${pad(dtTouches.length, 4)}  WR20=${pad(fmt(dtWR), 5)}%  OptEV=$${fmt(dtOpt.bestEV, 2)}  (${fmt(dtOpt.bestStop)}stop/${fmt(dtOpt.bestTarget)}tgt)`);
        }
      }

      // Delta state
      const deltaOpp = touches.filter(t => t.deltaOpposing);
      const deltaAli = touches.filter(t => !t.deltaOpposing);
      if (deltaOpp.length >= 10 && deltaAli.length >= 10) {
        const oppWR = deltaOpp.filter(t => t.fadeSuccess20).length / deltaOpp.length * 100;
        const aliWR = deltaAli.filter(t => t.fadeSuccess20).length / deltaAli.length * 100;
        const oppOpt = optimizeStopTarget(deltaOpp);
        const aliOpt = optimizeStopTarget(deltaAli);
        console.log(`  Delta oppose:  N=${pad(deltaOpp.length, 4)}  WR20=${pad(fmt(oppWR), 5)}%  OptEV=$${fmt(oppOpt.bestEV, 2)}`);
        console.log(`  Delta aligned: N=${pad(deltaAli.length, 4)}  WR20=${pad(fmt(aliWR), 5)}%  OptEV=$${fmt(aliOpt.bestEV, 2)}`);
      }
    }

    console.log('');
  }

  // ==========================================================================
  // 5. SUMMARY TABLES
  // ==========================================================================

  // ─── Fade WR at 90pt stop (comparison with prior audit) ───────────────────
  console.log('\n' + '='.repeat(160));
  console.log('FADE WR AT 90pt STOP / MULTIPLE TARGETS (comparison with prior key-level audit)');
  console.log('='.repeat(160));

  const hdr0 = [
    padR('Level', 18),
    pad('N', 5),
    pad('WR@10pt', 8),
    pad('WR@20pt', 8),
    pad('WR@30pt', 8),
    pad('WR@40pt', 8),
    pad('Bounce%', 8),
    pad('Break%', 7),
    pad('MAE P50', 8),
    pad('MFE P50', 8),
  ].join(' | ');
  console.log(hdr0);
  console.log('-'.repeat(hdr0.length));

  for (const r of summaryRows) {
    const row = [
      padR(r.levelName, 18),
      pad(r.n, 5),
      pad(fmt(r.fade90_10.wr * 100) + '%', 8),
      pad(fmt(r.fade90_20.wr * 100) + '%', 8),
      pad(fmt(r.fade90_30.wr * 100) + '%', 8),
      pad(fmt(r.fade90_40.wr * 100) + '%', 8),
      pad(fmt(r.bounceRate) + '%', 8),
      pad(fmt(r.breakRate) + '%', 7),
      pad(fmt(r.maeP.p50), 8),
      pad(fmt(r.mfeP.p50), 8),
    ].join(' | ');
    console.log(row);
  }

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
    pad('MFE P50', 8),
    pad('MFE P75', 8),
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
      pad(fmt(r.mfeP.p50), 8),
      pad(fmt(r.mfeP.p75), 8),
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
  console.log('RANKED SUMMARY -- DLL-SAFE OPTIMAL (stop capped at $200 risk, sorted by EV)');
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
    pad('MFE/MAE', 8),
  ].join(' | ');
  console.log(hdr2);
  console.log('-'.repeat(hdr2.length));

  const dllSorted = [...summaryRows].sort((a, b) => b.optDLL.bestEV - a.optDLL.bestEV);
  for (const r of dllSorted) {
    const d = r.optDLL;
    const row = [
      padR(r.levelName, 18),
      pad(r.n, 5),
      pad(fmt(r.wr20) + '%', 6),
      pad(fmt(d.bestStop) + 'pt', 9),
      pad(fmt(d.bestTarget) + 'pt', 8),
      pad(fmt(d.bestWR * 100) + '%', 7),
      pad('$' + fmt(d.bestEV, 2), 8),
      pad('$' + fmt(d.dollarRisk, 0), 6),
      pad(fmt(r.mfeMaeRatios.p50 === Infinity ? 99 : r.mfeMaeRatios.p50, 2) + 'x', 8),
    ].join(' | ');
    console.log(row);
  }

  // ─── Scalp Summary ────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(160));
  console.log('SCALP OPTIMIZATION (target 15-30pt, stop 20-50pt, sorted by EV)');
  console.log('='.repeat(160));

  const hdr3 = [
    padR('Level', 18),
    pad('N', 5),
    pad('Scalp Stop', 11),
    pad('Scalp Tgt', 10),
    pad('Scalp WR', 9),
    pad('Scalp EV', 9),
    pad('$Risk', 6),
    pad('DLL Trades', 11),
    pad('Daily EV', 9),
  ].join(' | ');
  console.log(hdr3);
  console.log('-'.repeat(hdr3.length));

  const scalpSorted = [...summaryRows].sort((a, b) => b.optScalp.bestEV - a.optScalp.bestEV);
  for (const r of scalpSorted) {
    const s = r.optScalp;
    const tradesPerDay = s.dollarRisk > 0 ? Math.floor(DLL / s.dollarRisk) : 0;
    const dailyEV = s.bestEV * Math.min(tradesPerDay, 3);
    const row = [
      padR(r.levelName, 18),
      pad(r.n, 5),
      pad(fmt(s.bestStop) + 'pt', 11),
      pad(fmt(s.bestTarget) + 'pt', 10),
      pad(fmt(s.bestWR * 100) + '%', 9),
      pad('$' + fmt(s.bestEV, 2), 9),
      pad('$' + fmt(s.dollarRisk, 0), 6),
      pad(tradesPerDay + '/day', 11),
      pad('$' + fmt(dailyEV, 2), 9),
    ].join(' | ');
    console.log(row);
  }

  // ==========================================================================
  // 6. STORE IN performance_audit
  // ==========================================================================
  console.log('\nStoring results in performance_audit...');

  await query(`DELETE FROM performance_audit WHERE signal_type = 'MIDPOINT_FADE_AUDIT'`);

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
        CURRENT_DATE, $1, 'MIDPOINT_FADE_AUDIT', $2,
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
      r.wr20, // WR at 20pt fade
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
        },
        bounceRate: r.bounceRate,
        breakRate: r.breakRate,
        firstTouchCount: r.nFirst,
        retouchCount: r.nRetouch,
        dollarRiskUnconstrained: r.dollarRisk,
        mfeMaeRatioP50: r.mfeMaeRatios.p50 === Infinity ? null : r.mfeMaeRatios.p50,
        maeP60: r.maeP60,
        mfeP60: r.mfeP60,
        dllConstrained: {
          stop: r.optDLL.bestStop,
          target: r.optDLL.bestTarget,
          wr: r.optDLL.bestWR,
          ev: r.optDLL.bestEV,
          dollarRisk: r.optDLL.dollarRisk,
        },
        scalpOptimal: {
          stop: r.optScalp.bestStop,
          target: r.optScalp.bestTarget,
          wr: r.optScalp.bestWR,
          ev: r.optScalp.bestEV,
          dollarRisk: r.optScalp.dollarRisk,
        },
        magnetEffect: allMagnetData[r.levelName] ? {
          approaches: allMagnetData[r.levelName].approached,
          touches: allMagnetData[r.levelName].touched,
          magnetRate: allMagnetData[r.levelName].approached > 0
            ? (allMagnetData[r.levelName].touched / allMagnetData[r.levelName].approached * 100)
            : null,
        } : null,
      }),
    ]);
  }

  console.log(`Stored ${summaryRows.length} rows in performance_audit.`);

  // ==========================================================================
  // 7. FINAL ACTIONABLE SUMMARY
  // ==========================================================================
  console.log('\n' + '='.repeat(140));
  console.log('FINAL DLL-COMPATIBLE RECOMMENDATIONS ($400 DLL)');
  console.log('='.repeat(140));

  const posEV = dllSorted.filter(r => r.optDLL.bestEV > 0);
  const negEV = dllSorted.filter(r => r.optDLL.bestEV <= 0);

  if (posEV.length > 0) {
    console.log('\n  POSITIVE EV at DLL-safe stops:');
    for (const r of posEV) {
      const d = r.optDLL;
      const s = r.optScalp;
      const tradesPerDay = Math.floor(DLL / d.dollarRisk);
      const dailyEV = d.bestEV * Math.min(tradesPerDay, 2);
      const magnet = allMagnetData[r.levelName];
      const magnetStr = magnet ? `Magnet ${fmt(magnet.touched/magnet.approached*100)}%` : '';
      console.log(`  ${padR(r.levelName, 18)} DLL: ${fmt(d.bestStop)}stop/${fmt(d.bestTarget)}tgt WR=${fmt(d.bestWR*100)}% EV=$${fmt(d.bestEV,2)}  |  Scalp: ${fmt(s.bestStop)}/${fmt(s.bestTarget)} WR=${fmt(s.bestWR*100)}% EV=$${fmt(s.bestEV,2)}  |  Bounce=${fmt(r.bounceRate)}% Break=${fmt(r.breakRate)}%  |  ${magnetStr}  |  N=${r.n}`);
    }
  }

  if (negEV.length > 0) {
    console.log('\n  NEGATIVE EV at DLL-safe stops:');
    for (const r of negEV) {
      const d = r.optDLL;
      const u = r.opt;
      console.log(`  ${padR(r.levelName, 18)} DLL: EV=$${fmt(d.bestEV,2)}  |  Unconstrained: ${fmt(u.bestStop)}stop/$${fmt(r.dollarRisk,0)} EV=$${fmt(u.bestEV,2)}  |  Bounce=${fmt(r.bounceRate)}% Break=${fmt(r.breakRate)}%  |  N=${r.n}`);
    }
  }

  // ─── Practical Recommendations ────────────────────────────────────────────
  console.log('\n' + '='.repeat(140));
  console.log('PRACTICAL RECOMMENDATIONS');
  console.log('='.repeat(140));

  console.log('\n  METHODOLOGY NOTES:');
  console.log('  - Midpoints are MEAN REVERSION levels, not support/resistance');
  console.log('  - Higher bounce rates indicate stronger mean-reversion character');
  console.log('  - Higher magnet rates indicate price is drawn to these levels');
  console.log('  - Scalp sizing (15-30pt target) is specifically for quick entries at these levels');
  console.log('  - OR_MID_AFTER_IB tests the key scalp: OR mid retested after IB establishes range');
  console.log('');

  // Sort by scalp EV for the final ranking
  const scalpRank = [...summaryRows].sort((a, b) => b.optScalp.bestEV - a.optScalp.bestEV);
  console.log('  SCALP RANKING (best quick-entry levels):');
  for (let i = 0; i < scalpRank.length; i++) {
    const r = scalpRank[i];
    const s = r.optScalp;
    const viable = s.bestEV > 0 ? 'VIABLE' : 'AVOID';
    console.log(`  ${i+1}. ${padR(r.levelName, 18)} ${viable}  Scalp ${fmt(s.bestStop)}/${fmt(s.bestTarget)} WR=${fmt(s.bestWR*100)}% EV=$${fmt(s.bestEV,2)}  |  Bounce=${fmt(r.bounceRate)}%  |  90pt fade WR: 10pt=${fmt(r.fade90_10.wr*100)}% 20pt=${fmt(r.fade90_20.wr*100)}% 30pt=${fmt(r.fade90_30.wr*100)}% 40pt=${fmt(r.fade90_40.wr*100)}%`);
  }

  console.log('\n' + '='.repeat(140));
  console.log('MIDPOINT FADE AUDIT COMPLETE');
  console.log('='.repeat(140));
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
