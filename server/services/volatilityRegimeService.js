// Live volatility regime monitor (Phase 2).
//
// Mirrors the methodology validated in scripts/volatility_regime_backtest.js
// (Phase 1 report-only backtest):
//   - "morning vol" = sample stdev of 5-min log-returns over 9:30-10:30 ET
//   - z-score vs trailing-20-session baseline of that SAME measure
//   - regime: HIGH-VOL-DIRECTIONAL / HIGH-VOL-CHOP / NORMAL-VOL / LOW-VOL
//     (z>=+1 / z<=-1 thresholds, trend_str>=0.50 split for HIGH-VOL)
//
// Texture metrics: avg 1-min bar range vs baseline, efficiency ratio,
// reversal rate, choppiness index — computed on full RTH session (9:30 to now).
//
// Does not write to any table and does not affect setup detection/resolution.

import { query } from '../db.js';

const N_BASELINE = 60;
const MORNING_END_MIN = 630; // 10:30 ET
const RTH_START_MIN = 570;   // 9:30 ET
const HIGH_THRESH = 1.0;
const LOW_THRESH = -1.0;
const TREND_STR_THRESH = 0.50;
const TREND_LOOKBACK_BARS = 3; // 3 x 5-min = 15 min

function fiveMinBars(oneMinBars) {
  const buckets = {};
  for (const b of oneMinBars) {
    const bucket = Math.floor(b.et_min / 5) * 5;
    if (!buckets[bucket]) buckets[bucket] = { et_min: bucket, open: b.open, high: b.high, low: b.low, close: b.close };
    else {
      const x = buckets[bucket];
      x.high = Math.max(x.high, b.high);
      x.low = Math.min(x.low, b.low);
      x.close = b.close;
    }
  }
  return Object.values(buckets).sort((a, b) => a.et_min - b.et_min);
}

function stdevLogReturns(bars) {
  if (bars.length < 3) return null;
  const rets = [];
  for (let i = 1; i < bars.length; i++) {
    const c0 = bars[i - 1].close, c1 = bars[i].close;
    if (c0 > 0 && c1 > 0) rets.push(Math.log(c1 / c0));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

function getPercentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function classifyRegime(morningVol, baseline, trendStr, isMorningComplete) {
  if (morningVol == null || !baseline || baseline.pct80 == null || baseline.pct20 == null) return null;

  if (morningVol >= baseline.pct80) {
    return trendStr >= TREND_STR_THRESH ? 'HIGH-VOL-DIRECTIONAL' : 'HIGH-VOL-CHOP';
  }
  if (morningVol <= baseline.pct20) {
    return 'LOW-VOL';
  }
  return 'NORMAL-VOL';
}

// Kaufman efficiency ratio, reversal rate, choppiness index on 1-min bars.
function computeTextureMetrics(bars) {
  if (!bars || bars.length < 3) return null;
  const sorted = [...bars].sort((a, b) => a.et_min - b.et_min);

  const avgBarRange = sorted.reduce((s, b) => s + (b.high - b.low), 0) / sorted.length;

  const closes = sorted.map(b => b.close);
  const netMove = Math.abs(closes[closes.length - 1] - closes[0]);
  const sumMoves = closes.slice(1).reduce((s, c, i) => s + Math.abs(c - closes[i]), 0);
  const efficiencyRatio = sumMoves > 0 ? netMove / sumMoves : 0;

  let reversals = 0;
  for (let i = 2; i < closes.length; i++) {
    const d1 = closes[i - 1] - closes[i - 2];
    const d2 = closes[i] - closes[i - 1];
    if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2)) reversals++;
  }
  const reversalRate = closes.length > 2 ? reversals / (closes.length - 2) : 0;

  // Choppiness index: 100 * log10(sumTR / sessionRange) / log10(n)
  // Theoretical range [0, 100]. >61.8 = coiling/choppy; <38.2 = strongly trending.
  const sessionHigh = Math.max(...sorted.map(b => b.high));
  const sessionLow = Math.min(...sorted.map(b => b.low));
  const sessionRange = sessionHigh - sessionLow;
  const sumTR = sorted.reduce((s, b) => s + (b.high - b.low), 0);
  const n = sorted.length;
  const choppinessIndex = sessionRange > 0 && n > 1
    ? 100 * Math.log10(sumTR / sessionRange) / Math.log10(n)
    : null;

  return { avgBarRange, sessionRange, efficiencyRatio, reversalRate, choppinessIndex, barCount: n };
}

// Trailing-20-session baseline of morning vol AND avg 1-min bar range, ending before `todayET`.
async function getMorningVolBaseline(todayET) {
  const barsQ = await query(`
    SELECT DISTINCT ON (ts) ts::date::text as d,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN $2 AND $3
    ORDER BY ts, id DESC
  `, [todayET, RTH_START_MIN, MORNING_END_MIN]);

  const fullBarsQ = await query(`
    SELECT ts::date::text as d, COUNT(*) as n
    FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN ${RTH_START_MIN} AND 959
    GROUP BY ts::date
  `, [todayET]);
  const fullCounts = {};
  for (const r of fullBarsQ.rows) fullCounts[r.d] = Number(r.n);

  const barsByDate = {};
  for (const b of barsQ.rows) (barsByDate[b.d] ??= []).push(b);

  const dates = Object.keys(barsByDate).filter(d => (fullCounts[d] || 0) >= 200).sort();
  const recentDates = dates.slice(-N_BASELINE);

  const vols = [];
  const avgBarRanges = [];
  const sessionRanges = [];
  for (const d of recentDates) {
    const bars = barsByDate[d].sort((a, b) => a.et_min - b.et_min);
    const five = fiveMinBars(bars);
    const vol = stdevLogReturns(five);
    if (vol != null) vols.push(vol);
    if (bars.length > 0) {
      avgBarRanges.push(bars.reduce((s, b) => s + (b.high - b.low), 0) / bars.length);
      const hi = Math.max(...bars.map(b => b.high));
      const lo = Math.min(...bars.map(b => b.low));
      sessionRanges.push(hi - lo);
    }
  }
  if (vols.length < 2) return null;
  const mean = vols.reduce((s, x) => s + x, 0) / vols.length;
  const sd = Math.sqrt(vols.reduce((s, x) => s + (x - mean) ** 2, 0) / (vols.length - 1));
  const pct80 = getPercentile(vols, 0.80);
  const pct20 = getPercentile(vols, 0.20);
  const avgBarRangeMean = avgBarRanges.length > 0
    ? avgBarRanges.reduce((s, x) => s + x, 0) / avgBarRanges.length
    : null;
  const avgSessionRangeMean = sessionRanges.length > 0
    ? sessionRanges.reduce((s, x) => s + x, 0) / sessionRanges.length
    : null;
  return { mean, sd, pct80, pct20, n: vols.length, avgBarRangeMean, avgSessionRangeMean };
}

export async function computeLiveVolatilityRegime() {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin = nowET.getHours() * 60 + nowET.getMinutes();

  if (etMin < RTH_START_MIN) {
    return { available: false, reason: 'pre-market — RTH not open yet' };
  }

  const baseline = await getMorningVolBaseline(todayET);
  if (!baseline) {
    return { available: false, reason: 'insufficient history for baseline' };
  }
  if (baseline.n < N_BASELINE) {
    return { available: false, reason: `baseline has only ${baseline.n} of ${N_BASELINE} sessions` };
  }

  // Load all RTH bars from 9:30 to now — used for both vol z-score and texture metrics
  const allBarsQ = await query(`
    SELECT DISTINCT ON (ts)
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN $2 AND $3
    ORDER BY ts, id DESC
  `, [todayET, RTH_START_MIN, etMin]);
  const allRTHBars = allBarsQ.rows.sort((a, b) => a.et_min - b.et_min);

  // Morning window subset (9:30–10:30 ET) for vol z-score
  const oneMin = allRTHBars.filter(b => b.et_min <= MORNING_END_MIN);

  if (oneMin.length < 15) {
    return {
      available: false,
      reason: `not enough bars yet today (${oneMin.length} 1-min bars, need >=15 for a 5-min stdev)`,
      etMin,
    };
  }

  const five = fiveMinBars(oneMin);
  const morningVol = stdevLogReturns(five);
  if (morningVol == null) {
    return { available: false, reason: 'not enough 5-min bars yet for stdev', etMin };
  }

  const z = (morningVol - baseline.mean) / baseline.sd;

  const sessOpen = oneMin[0].open;
  const sessHigh = Math.max(...oneMin.map(b => b.high));
  const sessLow = Math.min(...oneMin.map(b => b.low));
  const sessClose = oneMin[oneMin.length - 1].close;
  const range = sessHigh - sessLow;
  const trendStr = range > 0 ? Math.abs(sessClose - sessOpen) / range : 0;

  const regime = classifyRegime(morningVol, baseline, trendStr, etMin >= MORNING_END_MIN);

  // Rolling z history (one point per 5-min bar, once >=3 bars are available)
  const history = [];
  for (let i = 3; i <= five.length; i++) {
    const vol = stdevLogReturns(five.slice(0, i));
    if (vol == null) continue;
    history.push({ etMin: five[i - 1].et_min, z: (vol - baseline.mean) / baseline.sd });
  }

  let trend = 'insufficient data';
  if (history.length > TREND_LOOKBACK_BARS) {
    const latest = history[history.length - 1].z;
    const prior = history[history.length - 1 - TREND_LOOKBACK_BARS].z;
    const delta = latest - prior;
    if (delta <= -0.1) trend = 'settling down';
    else if (delta >= 0.1) trend = 'ramping up';
    else trend = 'flat';
  }

  // Morning window range (9:30-10:30) for apples-to-apples comparison with baseline
  const morningHigh = oneMin.length > 0 ? Math.max(...oneMin.map(b => b.high)) : null;
  const morningLow = oneMin.length > 0 ? Math.min(...oneMin.map(b => b.low)) : null;
  const morningRange = morningHigh != null && morningLow != null ? morningHigh - morningLow : null;

  // Texture metrics on full RTH session (9:30 to now, not capped at morning)
  const textureRaw = computeTextureMetrics(allRTHBars);
  const texture = textureRaw ? {
    ...textureRaw,
    baselineAvgBarRange: baseline.avgBarRangeMean,
    barRangePct: baseline.avgBarRangeMean && textureRaw.avgBarRange
      ? (textureRaw.avgBarRange / baseline.avgBarRangeMean - 1) * 100
      : null,
    morningRange,
    baselineMorningRange: baseline.avgSessionRangeMean,
    morningRangePct: baseline.avgSessionRangeMean && morningRange != null
      ? (morningRange / baseline.avgSessionRangeMean - 1) * 100
      : null,
  } : null;

  return {
    available: true,
    etMin,
    morningComplete: etMin >= MORNING_END_MIN,
    morningVol,
    baselineMean: baseline.mean,
    baselineSd: baseline.sd,
    baselineN: baseline.n,
    baselinePct80: baseline.pct80,
    baselinePct20: baseline.pct20,
    dynamicHighThresh: baseline.pct80,
    dynamicLowThresh: baseline.pct20,
    z,
    trendStr,
    regime,
    trend,
    history,
    texture,
  };
}
