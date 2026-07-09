#!/usr/bin/env node
/**
 * Flush Day Overextension Analysis — NQ Futures
 *
 * Deep backtest: identifies flush days (adaptive thresholds), computes daily
 * overextension metrics, finds pre-flush signatures, builds a composite
 * risk score, and assesses current flush risk for tomorrow.
 */

// Suppress DB query logging
process.env.NODE_ENV = 'production';

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION = 1;

// ─── Helper functions ───────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function pct(num, den) {
  return den === 0 ? 0 : (num / den * 100);
}

function fmt(n, dec = 1) {
  if (n == null || isNaN(n)) return 'N/A';
  return Number(n).toFixed(dec);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  FLUSH DAY OVEREXTENSION ANALYSIS — NQ FUTURES');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Step 1: Get all RTH daily OHLCV ──────────────────────────────────────
  const dailyRes = await query(`
    SELECT
      ts::date as trade_date,
      (array_agg(open ORDER BY ts))[1]::float as rth_open,
      MAX(high)::float as rth_high,
      MIN(low)::float as rth_low,
      (array_agg(close ORDER BY ts DESC))[1]::float as rth_close,
      SUM(volume) as rth_volume
    FROM price_bars_primary
    WHERE contract LIKE 'NQ%'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    GROUP BY ts::date
    ORDER BY ts::date
  `);
  const days = dailyRes.rows;
  console.log(`Total RTH trading days: ${days.length} (${days[0].trade_date} to ${days[days.length-1].trade_date})\n`);

  // ── Step 1b: Get overnight (globex) ranges ──────────────────────────────
  const overnightRes = await query(`
    SELECT
      trade_date,
      MAX(on_high)::float as on_high,
      MIN(on_low)::float as on_low
    FROM (
      SELECT ts::date as trade_date, high as on_high, low as on_low
      FROM price_bars_primary
      WHERE contract LIKE 'NQ%'
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 570
      UNION ALL
      SELECT (ts::date + interval '1 day')::date as trade_date, high as on_high, low as on_low
      FROM price_bars_primary
      WHERE contract LIKE 'NQ%'
        AND EXTRACT(hour FROM ts) >= 18
    ) sub
    GROUP BY trade_date
    ORDER BY trade_date
  `);
  const overnightMap = new Map();
  for (const r of overnightRes.rows) {
    overnightMap.set(r.trade_date, { high: r.on_high, low: r.on_low, range: r.on_high - r.on_low });
  }

  // ── Step 1c: Get ACD daily data ─────────────────────────────────────────
  const acdRes = await query(`
    SELECT trade_date, daily_score, or_high::float, or_low::float,
           a_up_fired, a_down_fired, a_up_time, a_down_time
    FROM acd_daily_log
    ORDER BY trade_date
  `);
  const acdMap = new Map();
  const acdArr = acdRes.rows;
  for (const r of acdArr) acdMap.set(r.trade_date, r);

  // ── Step 1d: Get developing value log ───────────────────────────────────
  const dvlRes = await query(`
    SELECT trade_date, poc::float, vah::float, val::float,
           session_high::float, session_low::float, session_close::float,
           poc_delta_vs_prior::float, migration_dir_vs_prior
    FROM developing_value_log
    ORDER BY trade_date
  `);
  const dvlMap = new Map();
  const dvlArr = dvlRes.rows;
  for (const r of dvlArr) dvlMap.set(r.trade_date, r);

  // ── Step 2: Compute daily stats and tag flush days (ADAPTIVE) ───────────
  const LOOKBACK = 50; // trailing window for adaptive thresholds

  for (const d of days) {
    d.range = d.rth_high - d.rth_low;
    d.net_move = d.rth_close - d.rth_open;
  }

  // Adaptive flush: range > 1.5x trailing-50 p90 range, OR |net| > 1.5x trailing-50 p90 |net|
  // Also apply absolute minimums: range >= 400 AND net >= 250 (to avoid tagging tiny-range days during low-vol periods)
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (i >= LOOKBACK) {
      const trailingRanges = days.slice(i - LOOKBACK, i).map(x => x.range);
      const trailingNets = days.slice(i - LOOKBACK, i).map(x => Math.abs(x.net_move));
      trailingRanges.sort((a, b) => a - b);
      trailingNets.sort((a, b) => a - b);
      const p90range = trailingRanges[Math.floor(0.9 * (LOOKBACK - 1))];
      const p90net = trailingNets[Math.floor(0.9 * (LOOKBACK - 1))];
      d.trail_p90_range = p90range;
      d.trail_p90_net = p90net;

      d.is_flush = (d.range > p90range * 1.5 && d.range >= 400) ||
                   (Math.abs(d.net_move) > p90net * 1.5 && Math.abs(d.net_move) >= 250);
    } else {
      d.is_flush = false;
    }
    d.flush_dir = d.is_flush ? (d.net_move < 0 ? 'DOWN' : 'UP') : null;
  }

  const flushDays = days.filter(d => d.is_flush);
  const dateIdx = new Map();
  days.forEach((d, i) => dateIdx.set(d.trade_date, i));

  console.log('════════════════════════════════════════════════════════════════');
  console.log('  SECTION 1: FLUSH DAY IDENTIFICATION (Adaptive: >1.5x trailing p90)');
  console.log('════════════════════════════════════════════════════════════════\n');
  console.log(`Flush days found: ${flushDays.length} out of ${days.length} trading days (${fmt(pct(flushDays.length, days.length))}%)\n`);
  console.log(`${'Date'.padEnd(12)} ${'Dir'.padEnd(5)} ${'Range'.padStart(8)} ${'Net Move'.padStart(10)} ${'Open'.padStart(10)} ${'Close'.padStart(10)} ${'vs p90R'.padStart(8)} ${'vs p90N'.padStart(8)}`);
  console.log('─'.repeat(80));
  for (const d of flushDays) {
    const rRatio = d.trail_p90_range ? fmt(d.range / d.trail_p90_range, 2) + 'x' : '-';
    const nRatio = d.trail_p90_net ? fmt(Math.abs(d.net_move) / d.trail_p90_net, 2) + 'x' : '-';
    console.log(`${d.trade_date.toString().padEnd(12)} ${(d.flush_dir||'').padEnd(5)} ${fmt(d.range,1).padStart(8)} ${fmt(d.net_move,1).padStart(10)} ${fmt(d.rth_open,2).padStart(10)} ${fmt(d.rth_close,2).padStart(10)} ${rRatio.padStart(8)} ${nRatio.padStart(8)}`);
  }

  const flushDown = flushDays.filter(d => d.flush_dir === 'DOWN');
  const flushUp = flushDays.filter(d => d.flush_dir === 'UP');
  console.log(`\nFlush DOWN: ${flushDown.length}  |  Flush UP: ${flushUp.length}`);
  console.log(`Average flush range: ${fmt(mean(flushDays.map(d => d.range)))} pts`);
  console.log(`Average flush |net move|: ${fmt(mean(flushDays.map(d => Math.abs(d.net_move))))} pts`);
  console.log(`Median flush range: ${fmt(percentile(flushDays.map(d => d.range), 50))} pts`);

  // ── Step 3: Compute daily overextension metrics ─────────────────────────

  // Pre-compute ACD index for faster NL30 lookups
  const acdDateIdx = new Map();
  acdArr.forEach((r, i) => acdDateIdx.set(r.trade_date, i));

  // Pre-compute DVL index
  const dvlDateIdx = new Map();
  dvlArr.forEach((r, i) => dvlDateIdx.set(r.trade_date, i));

  for (let i = 0; i < days.length; i++) {
    const d = days[i];

    // (a) Price vs 20-day SMA z-score
    if (i >= 20) {
      const closes20 = days.slice(i - 19, i + 1).map(x => x.rth_close);
      const sma20 = mean(closes20);
      const std20 = std(closes20);
      d.z_sma20 = std20 > 0 ? (d.rth_close - sma20) / std20 : 0;
    }

    // (b) Price vs Weekly VWAP z-score
    const dow = new Date(d.trade_date + 'T12:00:00').getDay();
    let weekStartIdx = i;
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      const jDow = new Date(days[j].trade_date + 'T12:00:00').getDay();
      if (jDow === 1 || j === 0) { weekStartIdx = j; break; }
      if (j < i && jDow > dow) { weekStartIdx = j + 1; break; }
      weekStartIdx = j;
    }
    let vwapNum = 0, vwapDen = 0;
    for (let j = weekStartIdx; j <= i; j++) {
      const typical = (days[j].rth_high + days[j].rth_low + days[j].rth_close) / 3;
      vwapNum += typical * Number(days[j].rth_volume);
      vwapDen += Number(days[j].rth_volume);
    }
    d.weekly_vwap = vwapDen > 0 ? vwapNum / vwapDen : d.rth_close;
    d.dist_weekly_vwap = d.rth_close - d.weekly_vwap;

    if (i >= 30) {
      const dists = days.slice(i - 29, i + 1).map(x => x.dist_weekly_vwap || 0);
      const stdDist = std(dists);
      d.z_weekly_vwap = stdDist > 0 ? d.dist_weekly_vwap / stdDist : 0;
    }

    // (c) Price vs 50-day SMA z-score
    if (i >= 50) {
      const closes50 = days.slice(i - 49, i + 1).map(x => x.rth_close);
      const sma50 = mean(closes50);
      const std50 = std(closes50);
      d.z_sma50 = std50 > 0 ? (d.rth_close - sma50) / std50 : 0;
    }

    // (d) ATR compression ratio — ATR(5) / ATR(20) using PRIOR days only (not today)
    if (i >= 21) {
      const ranges20 = days.slice(i - 20, i).map(x => x.range);
      const ranges5 = days.slice(i - 5, i).map(x => x.range);
      const atr5 = mean(ranges5);
      const atr20 = mean(ranges20);
      d.atr_ratio = atr20 > 0 ? atr5 / atr20 : 1;
    }

    // (e) Consecutive directional days
    if (i > 0) {
      const dir = d.rth_close > days[i-1].rth_close ? 1 : -1;
      let consec = 1;
      for (let j = i - 1; j > 0; j--) {
        const jDir = days[j].rth_close > days[j-1].rth_close ? 1 : -1;
        if (jDir === dir) consec++;
        else break;
      }
      d.consec_dir = dir * consec;
    } else {
      d.consec_dir = 0;
    }

    // (f) NL30 level and trajectory
    const acdIdx = acdDateIdx.get(d.trade_date);
    if (acdIdx != null) {
      const start = Math.max(0, acdIdx - 29);
      d.nl30 = 0;
      for (let j = start; j <= acdIdx; j++) d.nl30 += (acdArr[j].daily_score || 0);

      if (acdIdx >= 5) {
        let nl30_5ago = 0;
        const start5 = Math.max(0, acdIdx - 5 - 29);
        for (let j = start5; j <= acdIdx - 5; j++) nl30_5ago += (acdArr[j].daily_score || 0);
        d.nl30_5ago = nl30_5ago;
        d.nl30_delta5 = d.nl30 - nl30_5ago;
      }
    }

    // (g) Daily range percentile vs last 20 days (prior days only)
    if (i >= 20) {
      const ranges20 = days.slice(i - 20, i).map(x => x.range);
      const belowCount = ranges20.filter(r => r <= d.range).length;
      d.range_pct = belowCount / ranges20.length * 100;
    }

    // (h) POC drift — cumulative POC displacement over last 5 sessions
    const dvlIdx = dvlDateIdx.get(d.trade_date);
    if (dvlIdx != null && dvlIdx >= 5) {
      let pocDrift = 0;
      for (let j = dvlIdx - 4; j <= dvlIdx; j++) {
        pocDrift += dvlArr[j].poc - dvlArr[j-1].poc;
      }
      d.poc_drift_5d = pocDrift;
      d.poc = dvlArr[dvlIdx].poc;
    } else if (dvlIdx != null) {
      d.poc = dvlArr[dvlIdx].poc;
    }

    // (i) Gap frequency — how many of last 5 days had gaps > 50pt
    if (i >= 1) {
      let gapCount = 0;
      for (let j = Math.max(1, i - 4); j <= i; j++) {
        const gap = Math.abs(days[j].rth_open - days[j-1].rth_close);
        if (gap > 50) gapCount++;
      }
      d.gap_freq_5d = gapCount;
    }

    // (j) Overnight range vs prior RTH range ratio
    const onData = overnightMap.get(d.trade_date);
    if (onData && i > 0) {
      const priorRange = days[i-1].range;
      d.on_rth_ratio = priorRange > 0 ? onData.range / priorRange : 0;
      d.on_range = onData.range;
    }
  }

  // ── Step 4: Analyze each metric — flush-eve vs all days ─────────────────
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SECTION 2: METRIC DISTRIBUTIONS — ALL DAYS vs DAY BEFORE FLUSH');
  console.log('════════════════════════════════════════════════════════════════\n');

  const flushEveIndices = new Set();
  for (const f of flushDays) {
    const idx = dateIdx.get(f.trade_date);
    if (idx > 0) flushEveIndices.add(idx - 1);
  }

  const metrics = [
    { key: 'z_sma20', name: 'Price vs 20-SMA Z-score', absVal: true, higher_means_risk: true },
    { key: 'z_weekly_vwap', name: 'Price vs Weekly VWAP Z-score', absVal: true, higher_means_risk: true },
    { key: 'z_sma50', name: 'Price vs 50-SMA Z-score', absVal: true, higher_means_risk: true },
    { key: 'atr_ratio', name: 'ATR(5)/ATR(20) Ratio', absVal: false, higher_means_risk: true },
    { key: 'consec_dir', name: 'Consecutive Directional Days', absVal: true, higher_means_risk: true },
    { key: 'nl30', name: 'NL30 (30-day Number Line)', absVal: true, higher_means_risk: true },
    { key: 'nl30_delta5', name: 'NL30 5-Day Change', absVal: true, higher_means_risk: true },
    { key: 'range_pct', name: 'Range Percentile vs 20d', absVal: false, higher_means_risk: true },
    { key: 'poc_drift_5d', name: 'POC Drift 5-Day (pts)', absVal: true, higher_means_risk: true },
    { key: 'gap_freq_5d', name: 'Gap Freq (>50pt, last 5d)', absVal: false, higher_means_risk: true },
    { key: 'on_rth_ratio', name: 'Overnight/Prior RTH Ratio', absVal: false, higher_means_risk: true },
  ];

  const metricResults = [];
  const MIN_DATA = LOOKBACK; // only analyze days where flush detection is active

  for (const m of metrics) {
    const allVals = [];
    const eveVals = [];
    for (let i = MIN_DATA; i < days.length; i++) {
      const v = days[i][m.key];
      if (v == null) continue;
      const val = m.absVal ? Math.abs(v) : v;
      allVals.push(val);
      if (flushEveIndices.has(i)) eveVals.push(val);
    }

    if (allVals.length < 30 || eveVals.length < 3) {
      console.log(`  ${m.name}: insufficient data (all=${allVals.length}, pre-flush=${eveVals.length})`);
      continue;
    }

    const allMean = mean(allVals);
    const allStd = std(allVals);
    const eveMean = mean(eveVals);
    const separation = allStd > 0 ? (eveMean - allMean) / allStd : 0;

    console.log(`  ▸ ${m.name}`);
    console.log(`    All days (N=${allVals.length}):  mean=${fmt(allMean, 2)}  std=${fmt(allStd, 2)}  p50=${fmt(percentile(allVals, 50), 2)}  p75=${fmt(percentile(allVals, 75), 2)}  p90=${fmt(percentile(allVals, 90), 2)}`);
    console.log(`    Pre-flush (N=${eveVals.length}): mean=${fmt(eveMean, 2)}  std=${fmt(std(eveVals), 2)}  p50=${fmt(percentile(eveVals, 50), 2)}  p75=${fmt(percentile(eveVals, 75), 2)}  p90=${fmt(percentile(eveVals, 90), 2)}`);
    console.log(`    Separation: ${fmt(separation, 3)}σ  (pre-flush mean is ${separation > 0 ? 'HIGHER' : 'LOWER'} than all-day mean)`);

    // Find optimal threshold — sweep percentiles and optimize F1
    let bestThresh = null, bestF1 = 0, bestPrecision = 0, bestRecall = 0;

    for (let pctile = 50; pctile <= 95; pctile += 2.5) {
      const thresh = percentile(allVals, pctile);
      let tp = 0, fp = 0, fn = 0;

      for (let i = MIN_DATA; i < days.length - 2; i++) {
        const v = days[i][m.key] != null ? (m.absVal ? Math.abs(days[i][m.key]) : days[i][m.key]) : null;
        if (v == null) continue;

        const exceeds = m.higher_means_risk ? v >= thresh : v <= thresh;
        const flushSoon = (i + 1 < days.length && days[i + 1].is_flush) ||
                          (i + 2 < days.length && days[i + 2].is_flush);

        if (exceeds && flushSoon) tp++;
        else if (exceeds && !flushSoon) fp++;
        else if (!exceeds && flushSoon) fn++;
      }

      const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
      const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
      const f1 = prec + rec > 0 ? 2 * prec * rec / (prec + rec) : 0;

      if (f1 > bestF1) {
        bestF1 = f1;
        bestThresh = thresh;
        bestPrecision = prec * 100;
        bestRecall = rec * 100;
      }
    }

    // Compute hit rates at best threshold
    let hits1d = 0, hits2d = 0, triggers = 0;
    for (let i = MIN_DATA; i < days.length - 2; i++) {
      const v = days[i][m.key] != null ? (m.absVal ? Math.abs(days[i][m.key]) : days[i][m.key]) : null;
      if (v == null) continue;
      const exceeds = m.higher_means_risk ? v >= bestThresh : v <= bestThresh;
      if (exceeds) {
        triggers++;
        if (i + 1 < days.length && days[i + 1].is_flush) hits1d++;
        if ((i + 1 < days.length && days[i + 1].is_flush) || (i + 2 < days.length && days[i + 2].is_flush)) hits2d++;
      }
    }

    console.log(`    Best threshold: ${fmt(bestThresh, 2)}`);
    console.log(`    Triggers: ${triggers}  |  Hit 1d: ${hits1d} (${fmt(pct(hits1d, triggers))}%)  |  Hit 2d: ${hits2d} (${fmt(pct(hits2d, triggers))}%)`);
    console.log(`    Precision: ${fmt(bestPrecision)}%  |  Recall: ${fmt(bestRecall)}%  |  F1: ${fmt(bestF1, 3)}`);
    console.log();

    metricResults.push({
      ...m,
      separation: Math.abs(separation),
      bestThresh,
      bestF1,
      hits2dRate: pct(hits2d, triggers),
      triggers,
      hits2d,
      precision: bestPrecision,
      recall: bestRecall,
    });
  }

  // ── Step 5: Composite flush risk score ──────────────────────────────────
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  SECTION 3: COMPOSITE FLUSH RISK SCORE');
  console.log('════════════════════════════════════════════════════════════════\n');

  // Rank by separation
  metricResults.sort((a, b) => b.separation - a.separation);
  console.log('Metric ranking by separation power (pre-flush vs all-day):');
  for (let i = 0; i < metricResults.length; i++) {
    const m = metricResults[i];
    console.log(`  ${i + 1}. ${m.name.padEnd(35)} sep=${fmt(m.separation, 3)}σ  F1=${fmt(m.bestF1, 3)}  prec=${fmt(m.precision)}%  rec=${fmt(m.recall)}%  trig=${m.triggers}`);
  }

  // Pick top 5 by F1
  const topMetrics = [...metricResults].sort((a, b) => b.bestF1 - a.bestF1).slice(0, 5);
  console.log('\nTop 5 discriminators (by F1) for composite score:');
  for (const m of topMetrics) {
    console.log(`  -> ${m.name} (F1=${fmt(m.bestF1, 3)}, thresh=${fmt(m.bestThresh, 2)}, prec=${fmt(m.precision)}%)`);
  }

  // Compute composite
  for (let i = MIN_DATA; i < days.length; i++) {
    let score = 0;
    for (const m of topMetrics) {
      const v = days[i][m.key] != null ? (m.absVal ? Math.abs(days[i][m.key]) : days[i][m.key]) : null;
      if (v == null) continue;
      const exceeds = m.higher_means_risk ? v >= m.bestThresh : v <= m.bestThresh;
      if (exceeds) score++;
    }
    days[i].flush_risk = score;
  }

  console.log('\nComposite score distribution:');
  console.log(`${'Score'.padStart(6)} ${'Count'.padStart(7)} ${'%Days'.padStart(7)} ${'Flush1d'.padStart(9)} ${'Flush2d'.padStart(9)} ${'P(flush48h)'.padStart(13)} ${'FalsePos'.padStart(10)}`);
  console.log('─'.repeat(70));

  for (let s = 0; s <= 5; s++) {
    const scoreDays = days.filter(d => d.flush_risk === s);
    let flush1d = 0, flush2d = 0;
    for (const d of scoreDays) {
      const idx = dateIdx.get(d.trade_date);
      if (idx + 1 < days.length && days[idx + 1].is_flush) flush1d++;
      if ((idx + 1 < days.length && days[idx + 1].is_flush) || (idx + 2 < days.length && days[idx + 2].is_flush)) flush2d++;
    }
    const cnt = scoreDays.length;
    console.log(`${String(s).padStart(6)} ${String(cnt).padStart(7)} ${fmt(pct(cnt, days.length)).padStart(7)} ${String(flush1d).padStart(9)} ${String(flush2d).padStart(9)} ${(fmt(pct(flush2d, cnt)) + '%').padStart(13)} ${(fmt(pct(cnt - flush2d, cnt)) + '%').padStart(10)}`);
  }

  // ── Step 6: Cascade signal analysis ─────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SECTION 4: CASCADE SIGNAL ANALYSIS (First 15 Min of Flush)');
  console.log('════════════════════════════════════════════════════════════════\n');

  // Batch query all first-15-min bars for flush dates
  const flushDateStrings = flushDays.map(f => f.trade_date);
  const first15AllRes = await query(`
    SELECT ts::date as trade_date, ts, open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE contract LIKE 'NQ%'
      AND ts::date = ANY($1::date[])
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 584
    ORDER BY ts
  `, [flushDateStrings]);
  const first15ByDate = new Map();
  for (const bar of first15AllRes.rows) {
    const key = bar.trade_date;
    if (!first15ByDate.has(key)) first15ByDate.set(key, []);
    first15ByDate.get(key).push(bar);
  }

  for (const f of flushDays) {
    const idx = dateIdx.get(f.trade_date);
    const priorDay = idx > 0 ? days[idx - 1] : null;
    const acd = acdMap.get(f.trade_date);
    const bars15 = first15ByDate.get(f.trade_date) || [];

    if (bars15.length === 0) continue;

    const high15 = Math.max(...bars15.map(b => b.high));
    const low15 = Math.min(...bars15.map(b => b.low));
    const range15 = high15 - low15;

    let levelsBreached = 0;
    const levels = [];

    if (acd) {
      if (acd.or_high && low15 < acd.or_low) { levelsBreached++; levels.push('OR_LOW'); }
      if (acd.or_low && high15 > acd.or_high) { levelsBreached++; levels.push('OR_HIGH'); }
    }
    if (priorDay) {
      if (low15 < priorDay.rth_low) { levelsBreached++; levels.push('PD_LOW'); }
      if (high15 > priorDay.rth_high) { levelsBreached++; levels.push('PD_HIGH'); }
      const gLine = (priorDay.rth_high + priorDay.rth_low) / 2;
      if ((f.flush_dir === 'DOWN' && low15 < gLine) || (f.flush_dir === 'UP' && high15 > gLine)) {
        levelsBreached++;
        levels.push('G_LINE');
      }
    }

    let aSignalMinutes = 'N/A';
    if (acd) {
      if (f.flush_dir === 'DOWN' && acd.a_down_fired && acd.a_down_time) {
        const parts = acd.a_down_time.split(':');
        aSignalMinutes = (parseInt(parts[0]) * 60 + parseInt(parts[1])) - 570;
      } else if (f.flush_dir === 'UP' && acd.a_up_fired && acd.a_up_time) {
        const parts = acd.a_up_time.split(':');
        aSignalMinutes = (parseInt(parts[0]) * 60 + parseInt(parts[1])) - 570;
      }
    }

    f.levels_breached_15m = levelsBreached;
    f.level_names = levels;
    f.a_signal_minutes = aSignalMinutes;
    f.range_15m = range15;

    console.log(`  ${f.trade_date} (${f.flush_dir}) | Range: ${fmt(f.range)}pt | Net: ${fmt(f.net_move)}pt`);
    console.log(`    15min: range=${fmt(range15)}pt | Levels: ${levelsBreached} [${levels.join(', ')}] | A signal: ${typeof aSignalMinutes === 'number' ? aSignalMinutes + 'min' : aSignalMinutes}`);
  }

  // Correlations
  const flushWithData = flushDays.filter(d => d.levels_breached_15m != null);
  if (flushWithData.length >= 3) {
    console.log('\n  Cascade Correlations:');
    const grp = [
      { label: '3+ levels in 15min', days: flushWithData.filter(d => d.levels_breached_15m >= 3) },
      { label: '2 levels in 15min', days: flushWithData.filter(d => d.levels_breached_15m === 2) },
      { label: '0-1 levels in 15min', days: flushWithData.filter(d => d.levels_breached_15m < 2) },
    ];
    for (const g of grp) {
      if (g.days.length === 0) continue;
      console.log(`    ${g.label}: ${g.days.length} days, avg range ${fmt(mean(g.days.map(d => d.range)))}pt, avg |net| ${fmt(mean(g.days.map(d => Math.abs(d.net_move))))}pt`);
    }

    const withA = flushWithData.filter(d => typeof d.a_signal_minutes === 'number');
    if (withA.length > 0) {
      const fastA = withA.filter(d => d.a_signal_minutes <= 15);
      const slowA = withA.filter(d => d.a_signal_minutes > 15);
      console.log(`    A signal data: ${withA.length} days`);
      if (fastA.length > 0) console.log(`      Fast A (<=15min): ${fastA.length} days, avg range ${fmt(mean(fastA.map(d => d.range)))}pt`);
      if (slowA.length > 0) console.log(`      Slow A (>15min):  ${slowA.length} days, avg range ${fmt(mean(slowA.map(d => d.range)))}pt`);
    }

    // 15min range as predictor
    const r15 = flushWithData.map(d => d.range_15m);
    const med15 = percentile(r15, 50);
    const big15 = flushWithData.filter(d => d.range_15m >= med15);
    const small15 = flushWithData.filter(d => d.range_15m < med15);
    console.log(`\n    15min range as magnitude predictor (median ${fmt(med15)}pt):`);
    console.log(`      Big first 15min (>=${fmt(med15)}pt): ${big15.length} days, avg session range ${fmt(mean(big15.map(d => d.range)))}pt`);
    console.log(`      Small first 15min (<${fmt(med15)}pt): ${small15.length} days, avg session range ${fmt(mean(small15.map(d => d.range)))}pt`);
  }

  // ── Step 7: Pre-flush signature analysis ──────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SECTION 5: PRE-FLUSH SIGNATURES (T-2, T-1, Flush Day)');
  console.log('════════════════════════════════════════════════════════════════\n');

  const sigKeys = ['z_sma20', 'z_weekly_vwap', 'z_sma50', 'atr_ratio', 'consec_dir', 'nl30', 'range_pct', 'poc_drift_5d', 'gap_freq_5d', 'on_rth_ratio'];

  for (const f of flushDays) {
    const idx = dateIdx.get(f.trade_date);
    if (idx < 2) continue;

    const t2 = days[idx - 2];
    const t1 = days[idx - 1];

    console.log(`  ${f.trade_date} (${f.flush_dir}) — Range: ${fmt(f.range)}pt, Net: ${fmt(f.net_move)}pt`);
    for (const key of sigKeys) {
      const v2 = t2[key] != null ? fmt(t2[key], 2) : '  -';
      const v1 = t1[key] != null ? fmt(t1[key], 2) : '  -';
      const vf = f[key] != null ? fmt(f[key], 2) : '  -';
      const label = (metrics.find(m => m.key === key)?.name || key).substring(0, 30);
      console.log(`    ${label.padEnd(32)} T-2=${v2.padStart(8)}  T-1=${v1.padStart(8)}  Day=${vf.padStart(8)}`);
    }
    console.log();
  }

  // Aggregate pre-flush patterns
  console.log('  ── Aggregate Pre-Flush Patterns (T-1 day) ──');
  const preFlushDays = [];
  for (const f of flushDays) {
    const idx = dateIdx.get(f.trade_date);
    if (idx > 0 && idx > MIN_DATA) preFlushDays.push(days[idx - 1]);
  }

  if (preFlushDays.length >= 3) {
    for (const key of sigKeys) {
      const vals = preFlushDays.filter(d => d[key] != null).map(d => d[key]);
      if (vals.length < 3) continue;
      const label = (metrics.find(m => m.key === key)?.name || key);
      console.log(`    ${label.padEnd(35)} mean=${fmt(mean(vals), 2)}  |abs|=${fmt(mean(vals.map(v => Math.abs(v))), 2)}  p50=${fmt(percentile(vals, 50), 2)}  [${fmt(Math.min(...vals), 2)} .. ${fmt(Math.max(...vals), 2)}]`);
    }
  }

  // Pattern frequency
  console.log('\n  ── Pattern Frequency ──');
  const pfm = preFlushDays.filter(d => d.z_sma20 != null);
  const allDaysInRange = days.filter((d, i) => i >= MIN_DATA && d.z_sma20 != null);
  if (pfm.length > 0) {
    const patterns = [
      { name: '|z_sma20| > 1.5', fn: d => Math.abs(d.z_sma20) > 1.5 },
      { name: '|z_sma50| > 1.5', fn: d => d.z_sma50 != null && Math.abs(d.z_sma50) > 1.5 },
      { name: 'ATR ratio > 1.3 (hot)', fn: d => d.atr_ratio != null && d.atr_ratio > 1.3 },
      { name: 'ATR ratio < 0.7 (compressed)', fn: d => d.atr_ratio != null && d.atr_ratio < 0.7 },
      { name: '|Consec dir| >= 3', fn: d => Math.abs(d.consec_dir || 0) >= 3 },
      { name: '|Consec dir| >= 5', fn: d => Math.abs(d.consec_dir || 0) >= 5 },
      { name: '|NL30| >= 15 (extended)', fn: d => Math.abs(d.nl30 || 0) >= 15 },
      { name: '|NL30| >= 20 (very extended)', fn: d => Math.abs(d.nl30 || 0) >= 20 },
      { name: 'Range pct > 80 (volatile)', fn: d => d.range_pct != null && d.range_pct > 80 },
      { name: 'Range pct < 25 (quiet)', fn: d => d.range_pct != null && d.range_pct < 25 },
      { name: '|POC drift| > 300', fn: d => Math.abs(d.poc_drift_5d || 0) > 300 },
      { name: '|POC drift| > 500', fn: d => Math.abs(d.poc_drift_5d || 0) > 500 },
      { name: 'Gap freq >= 3', fn: d => (d.gap_freq_5d || 0) >= 3 },
      { name: 'ON/RTH ratio > 1.0', fn: d => (d.on_rth_ratio || 0) > 1.0 },
    ];

    console.log(`  ${'Pattern'.padEnd(40)} ${'PreFlush'.padStart(10)} ${'AllDays'.padStart(10)} ${'Lift'.padStart(7)}`);
    console.log('  ' + '─'.repeat(70));
    for (const p of patterns) {
      const pfCount = pfm.filter(p.fn).length;
      const allCount = allDaysInRange.filter(p.fn).length;
      const pfRate = pct(pfCount, pfm.length);
      const allRate = pct(allCount, allDaysInRange.length);
      const lift = allRate > 0 ? pfRate / allRate : 0;
      console.log(`  ${p.name.padEnd(40)} ${(fmt(pfRate) + '%').padStart(10)} ${(fmt(allRate) + '%').padStart(10)} ${fmt(lift, 2).padStart(7)}x`);
    }
  }

  // ── Step 8: Current readings & tomorrow's risk ─────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SECTION 6: CURRENT READINGS — FLUSH RISK FOR JUNE 26, 2026');
  console.log('════════════════════════════════════════════════════════════════\n');

  const todayIdx = dateIdx.get('2026-06-25');
  const today = todayIdx != null ? days[todayIdx] : null;

  if (today) {
    console.log(`  Today (June 25): Open=${fmt(today.rth_open, 2)} Close=${fmt(today.rth_close, 2)} Range=${fmt(today.range)} Net=${fmt(today.net_move)}`);
    console.log(`  Today IS a flush day: ${today.is_flush ? 'YES (' + today.flush_dir + ')' : 'NO'}\n`);

    console.log('  Current Overextension Metrics:');
    console.log('  ' + '─'.repeat(70));

    const sortedMetrics = [...metricResults].sort((a, b) => b.separation - a.separation);
    for (const m of sortedMetrics) {
      const v = today[m.key];
      const absV = v != null ? Math.abs(v) : null;
      const displayV = v != null ? (m.absVal ? `${fmt(v, 2)} (|${fmt(absV, 2)}|)` : fmt(v, 2)) : 'N/A';
      const isTop = topMetrics.find(t => t.key === m.key);
      const testVal = m.absVal ? absV : v;
      const exceedsThresh = testVal != null && isTop ?
        (m.higher_means_risk ? testVal >= m.bestThresh : testVal <= m.bestThresh) : false;
      const flag = exceedsThresh ? ' <<< TRIGGERED' : '';
      const topMark = isTop ? '[TOP5] ' : '       ';
      console.log(`    ${topMark}${m.name.padEnd(35)} ${displayV.padStart(22)}  (thresh=${fmt(m.bestThresh, 2)})${flag}`);
    }

    // Composite
    const currentRisk = today.flush_risk || 0;
    const sameScrDays = days.filter(d => d.flush_risk === currentRisk);
    let flush2dAtScore = 0;
    for (const d of sameScrDays) {
      const di = dateIdx.get(d.trade_date);
      if ((di + 1 < days.length && days[di + 1].is_flush) || (di + 2 < days.length && days[di + 2].is_flush)) flush2dAtScore++;
    }
    const flushProb = pct(flush2dAtScore, sameScrDays.length);
    const baseRate = pct(flushDays.length, days.length);
    const lift = baseRate > 0 ? flushProb / baseRate : 0;

    console.log('\n  ' + '═'.repeat(70));
    console.log(`  >>> COMPOSITE FLUSH RISK SCORE: ${currentRisk}/5 <<<`);
    console.log(`  Historical P(flush within 48h) at score ${currentRisk}: ${fmt(flushProb)}% (${flush2dAtScore}/${sameScrDays.length} days)`);
    console.log(`  Base rate: ${fmt(baseRate)}%  |  Lift: ${fmt(lift, 2)}x`);

    let assessment;
    if (currentRisk >= 4) assessment = 'ELEVATED — multiple overextension signals converging. High probability of outsized directional move within 48 hours.';
    else if (currentRisk === 3) assessment = 'MODERATE-HIGH — several extension indicators flagging. Heightened vigilance warranted.';
    else if (currentRisk === 2) assessment = 'MODERATE — some extension present but not extreme. Standard risk management.';
    else if (currentRisk === 1) assessment = 'LOW-MODERATE — minimal extension. Flush unlikely but not impossible.';
    else assessment = 'LOW — no significant overextension detected.';

    console.log(`\n  Based on current readings, flush risk is ${currentRisk}/5 — ${assessment}`);

    if (today.is_flush) {
      console.log(`\n  NOTE: June 25 WAS itself a flush day (${today.flush_dir}, ${fmt(today.range)}pt range).`);
      let b2b = 0;
      for (let i = 1; i < days.length; i++) {
        if (days[i].is_flush && days[i-1].is_flush) b2b++;
      }
      console.log(`  Back-to-back flush days: ${b2b} out of ${flushDays.length} flush days (${fmt(pct(b2b, flushDays.length))}%)`);

      // What happens day after a flush?
      const postFlush = [];
      for (const f of flushDays) {
        const fi = dateIdx.get(f.trade_date);
        if (fi + 1 < days.length) {
          const next = days[fi + 1];
          postFlush.push({
            dir: f.flush_dir,
            nextRange: next.range,
            nextNet: next.net_move,
            nextFlush: next.is_flush,
            reversal: (f.flush_dir === 'DOWN' && next.net_move > 0) || (f.flush_dir === 'UP' && next.net_move < 0),
          });
        }
      }
      const reversals = postFlush.filter(p => p.reversal);
      const continuations = postFlush.filter(p => !p.reversal);
      console.log(`  Day after flush: ${postFlush.length} samples`);
      console.log(`    Reversal (opposite direction): ${reversals.length} (${fmt(pct(reversals.length, postFlush.length))}%)`);
      console.log(`    Continuation (same direction):  ${continuations.length} (${fmt(pct(continuations.length, postFlush.length))}%)`);
      console.log(`    Avg next-day range: ${fmt(mean(postFlush.map(p => p.nextRange)))}pt  |  Avg next-day |net|: ${fmt(mean(postFlush.map(p => Math.abs(p.nextNet))))}pt`);

      // Specifically for DOWN flush days
      const postDown = postFlush.filter(p => p.dir === 'DOWN');
      if (postDown.length > 0) {
        const revDown = postDown.filter(p => p.reversal);
        console.log(`    After DOWN flush specifically: ${revDown.length}/${postDown.length} reversed (${fmt(pct(revDown.length, postDown.length))}%)`);
      }
    }

    // Last 10 days
    console.log('\n  Last 10 Days of Key Metrics:');
    console.log(`  ${'Date'.padEnd(12)} ${'Range'.padStart(7)} ${'Net'.padStart(8)} ${'Flush?'.padStart(7)} ${'z20'.padStart(6)} ${'zVWAP'.padStart(6)} ${'ATR_R'.padStart(6)} ${'Cons'.padStart(5)} ${'NL30'.padStart(5)} ${'GapF'.padStart(5)} ${'Score'.padStart(6)}`);
    console.log('  ' + '─'.repeat(85));
    for (let i = Math.max(MIN_DATA, todayIdx - 9); i <= todayIdx; i++) {
      const d = days[i];
      const flushTag = d.is_flush ? d.flush_dir.substring(0, 2) : '  ';
      console.log(`  ${d.trade_date.toString().padEnd(12)} ${fmt(d.range).padStart(7)} ${fmt(d.net_move).padStart(8)} ${flushTag.padStart(7)} ${(d.z_sma20 != null ? fmt(d.z_sma20, 2) : '-').padStart(6)} ${(d.z_weekly_vwap != null ? fmt(d.z_weekly_vwap, 2) : '-').padStart(6)} ${(d.atr_ratio != null ? fmt(d.atr_ratio, 2) : '-').padStart(6)} ${String(d.consec_dir || 0).padStart(5)} ${(d.nl30 != null ? String(d.nl30) : '-').padStart(5)} ${(d.gap_freq_5d != null ? String(d.gap_freq_5d) : '-').padStart(5)} ${(d.flush_risk != null ? String(d.flush_risk) : '-').padStart(6)}`);
    }
  } else {
    console.log('  WARNING: June 25, 2026 not found in data.');
  }

  // ── Sweet spot analysis ─────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SECTION 7: SWEET SPOT — WARNING THRESHOLD vs FALSE ALARMS');
  console.log('════════════════════════════════════════════════════════════════\n');

  const totalMonths = (days.length - MIN_DATA) / 21;

  console.log(`  ${'Threshold'.padEnd(14)} ${'Warnings'.padStart(9)} ${'Caught'.padStart(8)} ${'Missed'.padStart(8)} ${'Recall'.padStart(8)} ${'Precision'.padStart(11)} ${'FP/month'.padStart(10)}`);
  console.log('  ' + '─'.repeat(72));

  for (let thresh = 1; thresh <= 5; thresh++) {
    const warnings = days.filter(d => d.flush_risk != null && d.flush_risk >= thresh);
    let caught = 0;

    for (const f of flushDays) {
      const fIdx = dateIdx.get(f.trade_date);
      for (let look = 1; look <= 2; look++) {
        if (fIdx - look >= MIN_DATA && days[fIdx - look].flush_risk != null && days[fIdx - look].flush_risk >= thresh) {
          caught++;
          break;
        }
      }
    }

    const missed = flushDays.length - caught;
    const fp = warnings.length - caught;
    const fpPerMonth = fp / totalMonths;

    console.log(`  Score >= ${thresh}     ${String(warnings.length).padStart(9)} ${String(caught).padStart(8)} ${String(missed).padStart(8)} ${(fmt(pct(caught, flushDays.length)) + '%').padStart(8)} ${(fmt(pct(caught, warnings.length)) + '%').padStart(11)} ${fmt(fpPerMonth, 1).padStart(10)}`);
  }

  // ── P&L Impact ──────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SECTION 8: FLUSH DAY P&L IMPACT');
  console.log('════════════════════════════════════════════════════════════════\n');

  const nonFlush = days.filter(d => !d.is_flush && dateIdx.get(d.trade_date) >= MIN_DATA);
  const avgFlushRange = mean(flushDays.map(d => d.range));
  const avgFlushNet = mean(flushDays.map(d => Math.abs(d.net_move)));
  const maxFlushRange = Math.max(...flushDays.map(d => d.range));
  const avgNormalRange = mean(nonFlush.map(d => d.range));

  console.log(`  Flush day avg range:  ${fmt(avgFlushRange)} pts ($${fmt(avgFlushRange * PNL_PER_POINT)} per contract)`);
  console.log(`  Flush day avg |net|:  ${fmt(avgFlushNet)} pts ($${fmt(avgFlushNet * PNL_PER_POINT)} per contract)`);
  console.log(`  Flush day max range:  ${fmt(maxFlushRange)} pts ($${fmt(maxFlushRange * PNL_PER_POINT)} per contract)`);
  console.log(`  Normal day avg range: ${fmt(avgNormalRange)} pts`);
  console.log(`  Flush/Normal ratio:   ${fmt(avgFlushRange / avgNormalRange, 2)}x`);
  console.log(`  Flush frequency:      ~1 every ${fmt((days.length - MIN_DATA) / flushDays.length, 0)} trading days`);

  console.log('\n  Flush days by month:');
  const monthCounts = {};
  for (const f of flushDays) {
    const ym = f.trade_date.substring(0, 7);
    monthCounts[ym] = (monthCounts[ym] || 0) + 1;
  }
  for (const [month, cnt] of Object.entries(monthCounts).sort()) {
    console.log(`    ${month}: ${'█'.repeat(cnt)} (${cnt})`);
  }

  // Clustering analysis
  console.log('\n  Flush day clustering:');
  let clusters = 0, clusterSize = 0, maxCluster = 0, inCluster = false;
  const clusterSizes = [];
  for (let i = 0; i < days.length; i++) {
    if (days[i].is_flush) {
      if (i > 0 && days[i-1].is_flush) {
        clusterSize++;
      } else {
        if (inCluster) { clusterSizes.push(clusterSize); }
        clusterSize = 1;
        clusters++;
        inCluster = true;
      }
      maxCluster = Math.max(maxCluster, clusterSize);
    } else {
      if (inCluster) { clusterSizes.push(clusterSize); inCluster = false; }
    }
  }
  if (inCluster) clusterSizes.push(clusterSize);

  console.log(`    Total flush clusters: ${clusters}`);
  console.log(`    Isolated (single day): ${clusterSizes.filter(s => s === 1).length}`);
  console.log(`    Multi-day clusters: ${clusterSizes.filter(s => s > 1).length} (sizes: ${clusterSizes.filter(s => s > 1).join(', ')})`);
  console.log(`    Max consecutive flush days: ${maxCluster}`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  ANALYSIS COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════');

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
