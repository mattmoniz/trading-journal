// regime_adaptive_levels.mjs
// Regime-adaptive level performance system.
// Classifies each day into vol/dir/range regimes, backtests all 16 key levels
// per regime, stores results, and outputs a morning playbook.
//
// Idempotent — safe to run nightly.

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION    = 1;
const FADE_STOP     = 90;   // points
const FADE_TARGET   = 40;   // points
const TOUCH_PROX    = 8;    // proximity to count as "at level"
const DEBOUNCE_BARS = 15;   // min bars between touches on same level
const MFE_MAE_BARS  = 60;   // window for MFE/MAE tracking

// ────────────────────────────────────────────────────────────
//  STEP 0 — Load all data up front
// ────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════');
console.log('  REGIME-ADAPTIVE LEVEL PERFORMANCE SYSTEM');
console.log('═══════════════════════════════════════════════════════════════\n');

const t0 = Date.now();

// RTH bars (570..959 = 9:30..15:59 ET)
const barsRes = await query(`
  SELECT ts, ts::date::text as d,
    (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
    open::float, high::float, low::float, close::float,
    COALESCE(volume,0)::bigint as vol
  FROM price_bars_primary
  WHERE symbol = 'NQ'
    AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
  ORDER BY ts
`);
const barsByDate = {};
for (const b of barsRes.rows) (barsByDate[b.d] ??= []).push(b);
const allDates = Object.keys(barsByDate).sort();
console.log(`Loaded ${barsRes.rows.length.toLocaleString()} RTH bars across ${allDates.length} days (${allDates[0]} → ${allDates[allDates.length-1]})`);

// Overnight bars — for ON High/Low computation
const onRes = await query(`
  SELECT ts, ts::date::text as d,
    (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
    open::float, high::float, low::float, close::float
  FROM price_bars_primary
  WHERE symbol = 'NQ'
    AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) NOT BETWEEN 570 AND 959
  ORDER BY ts
`);
// Group overnight bars by the NEXT trading date (overnight belongs to next RTH session)
const onBarsByTradingDate = {};
{
  const tradingDatesSet = new Set(allDates);
  for (const b of onRes.rows) {
    // Overnight bars before 9:30 belong to that calendar day's RTH session
    // Overnight bars after 16:00 belong to the NEXT trading day's RTH session
    if (b.et_min < 570) {
      // Pre-market: belongs to today
      if (tradingDatesSet.has(b.d)) (onBarsByTradingDate[b.d] ??= []).push(b);
    } else {
      // Post-market: belongs to next trading day
      const idx = allDates.indexOf(b.d);
      if (idx >= 0 && idx < allDates.length - 1) {
        const nextDate = allDates[idx + 1];
        (onBarsByTradingDate[nextDate] ??= []).push(b);
      }
    }
  }
}

// DVL
const dvlRes = await query(`SELECT trade_date::text as d, poc::float, vah::float, val::float, session_high::float as sh, session_low::float as sl, session_close::float as sc FROM developing_value_log ORDER BY trade_date`);
const dvlMap = {};
const dvlDates = [];
for (const r of dvlRes.rows) { dvlMap[r.d] = r; dvlDates.push(r.d); }

// ACD
const acdRes = await query(`SELECT trade_date::text as d, or_high::float, or_low::float, daily_score::int FROM acd_daily_log ORDER BY trade_date`);
const acdMap = {};
for (const r of acdRes.rows) acdMap[r.d] = r;

console.log(`DVL: ${dvlRes.rows.length} days | ACD: ${acdRes.rows.length} days | ON bars: ${onRes.rows.length.toLocaleString()}\n`);

// ────────────────────────────────────────────────────────────
//  STEP 0b — Precompute daily session stats (range, ATR, etc.)
// ────────────────────────────────────────────────────────────
const dailyStats = {};
for (const d of allDates) {
  const bars = barsByDate[d];
  if (!bars || bars.length < 30) continue;
  const high = Math.max(...bars.map(b => b.high));
  const low  = Math.min(...bars.map(b => b.low));
  const range = high - low;
  const open  = bars[0].open;
  const close = bars[bars.length - 1].close;
  dailyStats[d] = { high, low, range, open, close, netMove: close - open };
}
const statDates = Object.keys(dailyStats).sort();

// ────────────────────────────────────────────────────────────
//  STEP 1 — Regime classification
// ────────────────────────────────────────────────────────────
console.log('STEP 1: Classifying regimes...');

// Rolling ATR, NL, range stats
function rollingATR(dates, stats, n) {
  const result = {};
  for (let i = 0; i < dates.length; i++) {
    if (i < n - 1) continue;
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += stats[dates[j]].range;
    result[dates[i]] = sum / n;
  }
  return result;
}

function rollingNL(dates, n) {
  // NL(n) = sum of daily_score over last n days
  const result = {};
  for (let i = 0; i < dates.length; i++) {
    if (i < n - 1) continue;
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const score = acdMap[dates[j]]?.daily_score;
      if (score != null) sum += score;
    }
    result[dates[i]] = sum;
  }
  return result;
}

// Compute rolling σ for a series
function rollingSigma(seriesMap, dates, lookback) {
  // For each date, compute mean and stdev of the series over `lookback` prior values
  const vals = [];
  const result = {};
  for (const d of dates) {
    if (seriesMap[d] == null) continue;
    vals.push({ d, v: seriesMap[d] });
    if (vals.length < lookback) continue;
    const window = vals.slice(-lookback);
    const mean = window.reduce((s, x) => s + x.v, 0) / window.length;
    const variance = window.reduce((s, x) => s + (x.v - mean) ** 2, 0) / window.length;
    const stdev = Math.sqrt(variance);
    result[d] = { mean, stdev, current: seriesMap[d] };
  }
  return result;
}

const atr5  = rollingATR(statDates, dailyStats, 5);
const atr20 = rollingATR(statDates, dailyStats, 20);
const nl10  = rollingNL(statDates, 10);

// For volatility regime: ATR(5) vs ATR(20), classified using rolling σ of ATR(20)
// We compute the ratio ATR5/ATR20 and classify with rolling σ of that ratio
const atrRatio = {};
for (const d of statDates) {
  if (atr5[d] != null && atr20[d] != null && atr20[d] > 0) {
    atrRatio[d] = atr5[d] / atr20[d];
  }
}
const atrRatioSigma = rollingSigma(atrRatio, statDates, 60);

// For directional regime: NL(10) classified using rolling σ
const nl10Sigma = rollingSigma(nl10, statDates, 60);

// For range regime: today's range vs 20-day avg range, classified using rolling σ
const rangeVsAvg = {};
for (const d of statDates) {
  if (atr20[d] != null && atr20[d] > 0) {
    rangeVsAvg[d] = dailyStats[d].range / atr20[d];
  }
}
const rangeRatioSigma = rollingSigma(rangeVsAvg, statDates, 60);

// Classify each day
const regimeMap = {};
let classifiedCount = 0;

for (const d of statDates) {
  const atrS  = atrRatioSigma[d];
  const nlS   = nl10Sigma[d];
  const rngS  = rangeRatioSigma[d];
  if (!atrS || !nlS || !rngS) continue;

  const volZ   = atrS.stdev > 0 ? (atrS.current - atrS.mean) / atrS.stdev : 0;
  const dirZ   = nlS.stdev > 0 ? (nlS.current - nlS.mean) / nlS.stdev : 0;
  const rangeZ = rngS.stdev > 0 ? (rngS.current - rngS.mean) / rngS.stdev : 0;

  const volRegime   = volZ > 0.5 ? 'EXPANDING' : volZ < -0.5 ? 'CONTRACTING' : 'NORMAL';
  const dirRegime   = dirZ > 1.0 ? 'BULLISH'   : dirZ < -1.0 ? 'BEARISH'     : 'NEUTRAL';
  const rangeRegime = rangeZ > 1.0 ? 'WIDE'    : rangeZ < -1.0 ? 'NARROW'    : 'NORMAL';

  regimeMap[d] = { volRegime, dirRegime, rangeRegime, volZ, dirZ, rangeZ };
  classifiedCount++;
}

console.log(`  Classified ${classifiedCount} days into regimes.`);

// Show regime distribution
const volDist  = { EXPANDING: 0, CONTRACTING: 0, NORMAL: 0 };
const dirDist  = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
const rngDist  = { WIDE: 0, NARROW: 0, NORMAL: 0 };
for (const r of Object.values(regimeMap)) {
  volDist[r.volRegime]++;
  dirDist[r.dirRegime]++;
  rngDist[r.rangeRegime]++;
}
console.log(`  Volatility: EXPANDING=${volDist.EXPANDING} NORMAL=${volDist.NORMAL} CONTRACTING=${volDist.CONTRACTING}`);
console.log(`  Direction:  BULLISH=${dirDist.BULLISH} NEUTRAL=${dirDist.NEUTRAL} BEARISH=${dirDist.BEARISH}`);
console.log(`  Range:      WIDE=${rngDist.WIDE} NORMAL=${rngDist.NORMAL} NARROW=${rngDist.NARROW}\n`);


// ────────────────────────────────────────────────────────────
//  STEP 1b — Level definitions
// ────────────────────────────────────────────────────────────
// Precompute prior-day VA, floor pivots, OR, IB, ON for each date

function getPriorDVL(d, n) {
  const idx = dvlDates.indexOf(d);
  return idx >= n ? dvlMap[dvlDates[idx - n]] : null;
}

// Precompute all levels per date
const levelsByDate = {};
for (const d of allDates) {
  const bars = barsByDate[d];
  if (!bars || bars.length < 30) continue;

  const pd = getPriorDVL(d, 1);
  const acd = acdMap[d];

  // OR (from ACD or computed from bars)
  let orH = acd?.or_high ?? null;
  let orL = acd?.or_low ?? null;
  if (orH == null) {
    const orBars = bars.filter(b => b.et_min >= 570 && b.et_min < 575);
    if (orBars.length > 0) {
      orH = Math.max(...orBars.map(b => b.high));
      orL = Math.min(...orBars.map(b => b.low));
    }
  }

  // IB (first 60 min: 9:30-10:29)
  const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
  const ibH = ibBars.length > 0 ? Math.max(...ibBars.map(b => b.high)) : null;
  const ibL = ibBars.length > 0 ? Math.min(...ibBars.map(b => b.low))  : null;

  // Floor Pivots
  let floorP = null, floorR1 = null, floorS1 = null;
  if (pd?.sh != null && pd?.sl != null && pd?.sc != null) {
    floorP  = (pd.sh + pd.sl + pd.sc) / 3;
    floorR1 = 2 * floorP - pd.sl;
    floorS1 = 2 * floorP - pd.sh;
  }

  // Overnight High/Low
  const onBars = onBarsByTradingDate[d] || [];
  const onH = onBars.length > 0 ? Math.max(...onBars.map(b => b.high)) : null;
  const onL = onBars.length > 0 ? Math.min(...onBars.map(b => b.low))  : null;

  // RTH VWAP (developing through the day — we use it as a reference, not a static level)
  // For fade testing we compute VWAP up to the bar being tested, but for simplicity
  // we use the prior day's VWAP as the static reference level for today's fades
  let pdVwap = null;
  {
    const prevDIdx = allDates.indexOf(d) - 1;
    if (prevDIdx >= 0) {
      const prevBars = barsByDate[allDates[prevDIdx]];
      if (prevBars && prevBars.length > 0) {
        let cpv = 0, cv = 0;
        for (const b of prevBars) {
          const tp = (b.high + b.low + b.close) / 3;
          cpv += tp * b.vol; cv += b.vol;
        }
        if (cv > 0) pdVwap = cpv / cv;
      }
    }
  }

  levelsByDate[d] = {
    OR_HIGH:     orH,
    OR_LOW:      orL,
    IB_HIGH:     ibH,
    IB_LOW:      ibL,
    PD_POC:      pd?.poc ?? null,
    PD_VAH:      pd?.vah ?? null,
    PD_VAL:      pd?.val ?? null,
    PD_HIGH:     pd?.sh  ?? null,
    PD_LOW:      pd?.sl  ?? null,
    FLOOR_PIVOT: floorP,
    FLOOR_R1:    floorR1,
    FLOOR_S1:    floorS1,
    ON_HIGH:     onH,
    ON_LOW:      onL,
    PD_VWAP:     pdVwap,
    OR_MID:      orH != null && orL != null ? (orH + orL) / 2 : null,
  };
}

const LEVEL_NAMES = [
  'OR_HIGH', 'OR_LOW', 'OR_MID',
  'IB_HIGH', 'IB_LOW',
  'PD_POC', 'PD_VAH', 'PD_VAL', 'PD_HIGH', 'PD_LOW',
  'FLOOR_PIVOT', 'FLOOR_R1', 'FLOOR_S1',
  'ON_HIGH', 'ON_LOW',
  'PD_VWAP',
];
console.log(`Defined ${LEVEL_NAMES.length} levels for testing.\n`);


// ────────────────────────────────────────────────────────────
//  STEP 2 — Backtest each level with fade logic
// ────────────────────────────────────────────────────────────
console.log('STEP 2: Backtesting all levels...');

// For each level on each day, find first-touch fade entries and track outcomes
// Trade logic: price approaches level, we fade it (short at resistance, long at support)
// Stop = 90 pts, Target = 40 pts

// Result structure: { level, date, dir, entry, outcome, pnl, mfe, mae, regime }
const allTrades = [];

for (const d of allDates) {
  const bars = barsByDate[d];
  const levels = levelsByDate[d];
  const regime = regimeMap[d];
  if (!bars || bars.length < 30 || !levels || !regime) continue;

  for (const levelName of LEVEL_NAMES) {
    const levelPrice = levels[levelName];
    if (levelPrice == null) continue;

    // Determine start bar: IB levels start after IB close, OR levels after OR close
    let startMinute = 575; // default: after first 5 min
    if (levelName.startsWith('IB')) startMinute = 630; // after IB close
    else if (levelName.startsWith('OR')) startMinute = 575; // after OR close

    const startIdx = bars.findIndex(b => b.et_min >= startMinute);
    if (startIdx < 0) continue;

    let lastTradeBar = -DEBOUNCE_BARS - 1;

    // Only first touch for fade (most reliable signal)
    let touched = false;

    for (let i = Math.max(startIdx, 5); i < bars.length - 1; i++) {
      if (touched) break; // first touch only
      if (i - lastTradeBar < DEBOUNCE_BARS) continue;

      // Check if price is at the level
      if (Math.abs(bars[i].close - levelPrice) > TOUCH_PROX) continue;

      // Determine approach direction from prior 5 bars
      const lookback = bars.slice(Math.max(0, i - 5), i);
      if (lookback.length < 3) continue;
      const priorAvg = lookback.reduce((s, b) => s + b.close, 0) / lookback.length;
      const fromBelow = priorAvg < levelPrice - 3;
      const fromAbove = priorAvg > levelPrice + 3;
      if (!fromBelow && !fromAbove) continue;

      // Fade direction
      const fadeDir = fromBelow ? 'SHORT' : 'LONG';
      const entryPx = bars[i].close;

      // Track MFE, MAE, and outcome
      let mfe = 0, mae = 0;
      let outcome = 'OPEN';
      let exitPx = entryPx;

      for (let j = i + 1; j < Math.min(i + MFE_MAE_BARS, bars.length); j++) {
        let excursion, adverse;
        if (fadeDir === 'SHORT') {
          excursion = entryPx - bars[j].low;  // short profits from price going down
          adverse   = bars[j].high - entryPx; // short loses from price going up
        } else {
          excursion = bars[j].high - entryPx; // long profits from price going up
          adverse   = entryPx - bars[j].low;  // long loses from price going down
        }
        if (excursion > mfe) mfe = excursion;
        if (adverse > mae)   mae = adverse;

        // Check stop
        if (adverse >= FADE_STOP) {
          outcome = 'LOSS';
          exitPx = fadeDir === 'SHORT' ? entryPx + FADE_STOP : entryPx - FADE_STOP;
          break;
        }
        // Check target
        if (excursion >= FADE_TARGET) {
          outcome = 'WIN';
          exitPx = fadeDir === 'SHORT' ? entryPx - FADE_TARGET : entryPx + FADE_TARGET;
          break;
        }
      }

      // If still open after MFE_MAE_BARS, mark to market
      if (outcome === 'OPEN') {
        const lastBar = bars[Math.min(i + MFE_MAE_BARS - 1, bars.length - 1)];
        exitPx = lastBar.close;
        const mtm = fadeDir === 'SHORT' ? entryPx - exitPx : exitPx - entryPx;
        outcome = mtm > 0 ? 'WIN' : 'LOSS';
      }

      const rawPnl = fadeDir === 'SHORT' ? entryPx - exitPx : exitPx - entryPx;
      const pnl = rawPnl * PNL_PER_POINT - COMMISSION;

      allTrades.push({
        level: levelName,
        date: d,
        dir: fadeDir,
        entry: entryPx,
        exit: exitPx,
        outcome,
        pnl,
        mfe,
        mae,
        volRegime: regime.volRegime,
        dirRegime: regime.dirRegime,
        rangeRegime: regime.rangeRegime,
      });

      lastTradeBar = i;
      touched = true;
    }
  }
}

console.log(`  Total trades: ${allTrades.length}\n`);

// ────────────────────────────────────────────────────────────
//  STEP 2b — Compute performance by level × regime
// ────────────────────────────────────────────────────────────
function computeStats(trades) {
  if (trades.length === 0) return null;
  const wins = trades.filter(t => t.outcome === 'WIN').length;
  const wr = wins / trades.length;
  const ev = trades.reduce((s, t) => s + t.pnl, 0) / trades.length;
  const avgMfe = trades.reduce((s, t) => s + t.mfe, 0) / trades.length;
  const avgMae = trades.reduce((s, t) => s + t.mae, 0) / trades.length;
  return {
    n: trades.length,
    wins,
    wr: +(wr * 100).toFixed(1),
    ev: +ev.toFixed(2),
    avgMfe: +avgMfe.toFixed(1),
    avgMae: +avgMae.toFixed(1),
    totalPnl: +trades.reduce((s, t) => s + t.pnl, 0).toFixed(2),
  };
}

// Overall stats per level
const overallByLevel = {};
for (const level of LEVEL_NAMES) {
  const trades = allTrades.filter(t => t.level === level);
  overallByLevel[level] = computeStats(trades);
}

// Stats per level × single regime dimension
const regimeDims = ['volRegime', 'dirRegime', 'rangeRegime'];
const regimeValues = {
  volRegime:   ['EXPANDING', 'CONTRACTING', 'NORMAL'],
  dirRegime:   ['BULLISH', 'BEARISH', 'NEUTRAL'],
  rangeRegime: ['WIDE', 'NARROW', 'NORMAL'],
};

// All regime combos: level × vol × dir × range
const allCombos = [];
for (const level of LEVEL_NAMES) {
  for (const vol of regimeValues.volRegime) {
    for (const dir of regimeValues.dirRegime) {
      for (const rng of regimeValues.rangeRegime) {
        const trades = allTrades.filter(t =>
          t.level === level &&
          t.volRegime === vol &&
          t.dirRegime === dir &&
          t.rangeRegime === rng
        );
        const stats = computeStats(trades);
        const overall = overallByLevel[level];
        let vsOverall = 'NORMAL';
        if (stats && overall) {
          const diff = stats.wr - overall.wr;
          if (diff > 5) vsOverall = 'OUTPERFORMING';
          else if (diff < -5) vsOverall = 'DEGRADING';
        }
        allCombos.push({
          level, volRegime: vol, dirRegime: dir, rangeRegime: rng,
          stats, vsOverall,
        });
      }
    }
  }
}

// Also compute level × vol×dir combos (2D cross) for more populated buckets
const volDirCombos = [];
for (const level of LEVEL_NAMES) {
  for (const vol of regimeValues.volRegime) {
    for (const dir of regimeValues.dirRegime) {
      const trades = allTrades.filter(t =>
        t.level === level && t.volRegime === vol && t.dirRegime === dir
      );
      const stats = computeStats(trades);
      const overall = overallByLevel[level];
      let vsOverall = 'NORMAL';
      if (stats && overall) {
        const diff = stats.wr - overall.wr;
        if (diff > 5) vsOverall = 'OUTPERFORMING';
        else if (diff < -5) vsOverall = 'DEGRADING';
      }
      volDirCombos.push({
        level, volRegime: vol, dirRegime: dir,
        stats, vsOverall,
      });
    }
  }
}

// Print overall stats
console.log('═══ OVERALL LEVEL PERFORMANCE (all regimes) ═══');
console.log('Level'.padEnd(14) + 'N'.padStart(5) + 'WR%'.padStart(7) + 'EV$/trade'.padStart(11) + 'AvgMFE'.padStart(8) + 'AvgMAE'.padStart(8));
console.log('─'.repeat(53));
const sortedOverall = LEVEL_NAMES
  .filter(l => overallByLevel[l])
  .sort((a, b) => overallByLevel[b].ev - overallByLevel[a].ev);

for (const level of sortedOverall) {
  const s = overallByLevel[level];
  if (!s) continue;
  console.log(
    level.padEnd(14) +
    String(s.n).padStart(5) +
    `${s.wr}%`.padStart(7) +
    `$${s.ev}`.padStart(11) +
    `${s.avgMfe}`.padStart(8) +
    `${s.avgMae}`.padStart(8)
  );
}

// Print regime breakdown for each level
console.log('\n═══ LEVEL PERFORMANCE BY REGIME (vol x dir, N >= 5) ═══\n');
for (const level of sortedOverall) {
  const overall = overallByLevel[level];
  if (!overall) continue;
  console.log(`── ${level} (overall: ${overall.wr}% WR, $${overall.ev}/trade, N=${overall.n}) ──`);

  const combos = volDirCombos.filter(c => c.level === level && c.stats && c.stats.n >= 5);
  if (combos.length === 0) { console.log('  (insufficient data per regime)'); continue; }

  combos.sort((a, b) => b.stats.ev - a.stats.ev);
  for (const c of combos) {
    const flag = c.vsOverall === 'OUTPERFORMING' ? ' +++' : c.vsOverall === 'DEGRADING' ? ' ---' : '';
    const diff = (c.stats.wr - overall.wr).toFixed(1);
    const sign = parseFloat(diff) >= 0 ? '+' : '';
    console.log(
      `  ${c.volRegime}/${c.dirRegime}`.padEnd(28) +
      `N=${String(c.stats.n).padStart(3)}` +
      `  ${c.stats.wr}% WR (${sign}${diff}pp)` +
      `  $${c.stats.ev}/trade${flag}`
    );
  }
  console.log('');
}


// ────────────────────────────────────────────────────────────
//  STEP 3 — Current regime
// ────────────────────────────────────────────────────────────
console.log('\n═══ STEP 3: CURRENT REGIME ═══');

const lastDate = statDates[statDates.length - 1];
const currentRegime = regimeMap[lastDate];
if (!currentRegime) {
  console.log('Cannot determine current regime (insufficient data).');
} else {
  console.log(`Most recent trading day: ${lastDate}`);
  console.log(`Current regime: ${currentRegime.volRegime} / ${currentRegime.dirRegime} / ${currentRegime.rangeRegime}`);
  console.log(`  Vol Z-score:   ${currentRegime.volZ.toFixed(2)}`);
  console.log(`  Dir Z-score:   ${currentRegime.dirZ.toFixed(2)}`);
  console.log(`  Range Z-score: ${currentRegime.rangeZ.toFixed(2)}\n`);

  // Find matching combos for current regime (vol×dir)
  const currentVolDir = volDirCombos.filter(c =>
    c.volRegime === currentRegime.volRegime &&
    c.dirRegime === currentRegime.dirRegime &&
    c.stats && c.stats.n >= 5
  ).sort((a, b) => b.stats.ev - a.stats.ev);

  // Also find exact 3D matches
  const current3D = allCombos.filter(c =>
    c.volRegime === currentRegime.volRegime &&
    c.dirRegime === currentRegime.dirRegime &&
    c.rangeRegime === currentRegime.rangeRegime &&
    c.stats && c.stats.n >= 5
  ).sort((a, b) => b.stats.ev - a.stats.ev);

  // Use vol×dir for robustness (larger N), annotate with 3D data where available
  const topLevels = currentVolDir.filter(c => c.stats.ev > 0);
  const avoidLevels = currentVolDir.filter(c => c.stats.ev <= 0 || c.vsOverall === 'DEGRADING');
  const noData = LEVEL_NAMES.filter(l => !currentVolDir.find(c => c.level === l));

  console.log(`In ${currentRegime.volRegime}/${currentRegime.dirRegime} regime, top levels (positive EV):`);
  for (const c of topLevels.slice(0, 8)) {
    const overall = overallByLevel[c.level];
    const diff = (c.stats.wr - overall.wr).toFixed(1);
    const sign = parseFloat(diff) >= 0 ? '+' : '';
    console.log(`  ${c.level.padEnd(14)} ${c.stats.wr}% WR (${sign}${diff}pp vs overall)  $${c.stats.ev}/trade  N=${c.stats.n}`);
  }

  if (avoidLevels.length > 0) {
    console.log(`\nAVOID in this regime (negative EV or degrading):`);
    for (const c of avoidLevels) {
      const overall = overallByLevel[c.level];
      const diff = (c.stats.wr - overall.wr).toFixed(1);
      console.log(`  ${c.level.padEnd(14)} ${c.stats.wr}% WR (${diff}pp)  $${c.stats.ev}/trade  N=${c.stats.n}`);
    }
  }

  if (noData.length > 0) {
    console.log(`\nNO DATA in this regime (N < 5):`);
    console.log(`  ${noData.join(', ')}`);
  }

  // 3D exact match info
  if (current3D.length > 0) {
    console.log(`\nExact 3D regime match (${currentRegime.volRegime}/${currentRegime.dirRegime}/${currentRegime.rangeRegime}):`);
    for (const c of current3D.slice(0, 5)) {
      console.log(`  ${c.level.padEnd(14)} ${c.stats.wr}% WR  $${c.stats.ev}/trade  N=${c.stats.n}  [${c.vsOverall}]`);
    }
  } else {
    console.log(`\nNo levels with N >= 5 in exact 3D regime — using vol×dir breakdown above.`);
  }
}


// ────────────────────────────────────────────────────────────
//  STEP 4 — Regime transition detection
// ────────────────────────────────────────────────────────────
console.log('\n═══ STEP 4: REGIME TRANSITIONS (last 20 trading days) ═══\n');

const last20 = statDates.slice(-20);
const regimeHistory = last20.map(d => ({ d, ...regimeMap[d] })).filter(r => r.volRegime);

// Show regime history
console.log('Date        Vol          Dir          Range');
console.log('─'.repeat(55));
for (const r of regimeHistory) {
  console.log(`${r.d}  ${r.volRegime.padEnd(13)} ${r.dirRegime.padEnd(13)} ${r.rangeRegime}`);
}

// Detect transitions
let lastVol = null, lastDir = null, lastRng = null;
let lastVolChange = null, lastDirChange = null, lastRngChange = null;
for (const r of regimeHistory) {
  if (lastVol && r.volRegime !== lastVol) lastVolChange = { date: r.d, from: lastVol, to: r.volRegime };
  if (lastDir && r.dirRegime !== lastDir) lastDirChange = { date: r.d, from: lastDir, to: r.dirRegime };
  if (lastRng && r.rangeRegime !== lastRng) lastRngChange = { date: r.d, from: lastRng, to: r.rangeRegime };
  lastVol = r.volRegime; lastDir = r.dirRegime; lastRng = r.rangeRegime;
}

console.log('\nRecent regime shifts:');
if (lastVolChange) console.log(`  Volatility: ${lastVolChange.from} → ${lastVolChange.to} on ${lastVolChange.date}`);
else console.log('  Volatility: stable over last 20 days');
if (lastDirChange) console.log(`  Direction:  ${lastDirChange.from} → ${lastDirChange.to} on ${lastDirChange.date}`);
else console.log('  Direction:  stable over last 20 days');
if (lastRngChange) console.log(`  Range:      ${lastRngChange.from} → ${lastRngChange.to} on ${lastRngChange.date}`);
else console.log('  Range:      stable over last 20 days');

// Analyze regime stability (count consecutive days in current regime)
const currentCombo = regimeHistory.length > 0
  ? `${regimeHistory[regimeHistory.length-1].volRegime}/${regimeHistory[regimeHistory.length-1].dirRegime}`
  : 'UNKNOWN';
let streakDays = 0;
for (let i = regimeHistory.length - 1; i >= 0; i--) {
  if (`${regimeHistory[i].volRegime}/${regimeHistory[i].dirRegime}` === currentCombo) streakDays++;
  else break;
}
console.log(`\nCurrent vol×dir regime (${currentCombo}) streak: ${streakDays} days`);
if (streakDays <= 3) console.log('  ⚠ NEW regime — levels may behave differently. Use smaller size.');
else if (streakDays >= 10) console.log('  Established regime — level signals more reliable.');

// Transition analysis: how do levels perform in first 5 days after a regime change?
const transitionTrades = [];
const stableTrades = [];
for (const t of allTrades) {
  const dIdx = statDates.indexOf(t.date);
  if (dIdx < 5) continue;
  // Check if regime changed in the 5 days before this trade
  let recentChange = false;
  const currentR = regimeMap[t.date];
  for (let j = dIdx - 5; j < dIdx; j++) {
    const priorR = regimeMap[statDates[j]];
    if (priorR && currentR && (priorR.volRegime !== currentR.volRegime || priorR.dirRegime !== currentR.dirRegime)) {
      recentChange = true;
      break;
    }
  }
  if (recentChange) transitionTrades.push(t);
  else stableTrades.push(t);
}

const transStats = computeStats(transitionTrades);
const stableStats = computeStats(stableTrades);
console.log(`\nTransition vs Stable regime performance:`);
if (transStats) console.log(`  During transitions (first 5 days): ${transStats.wr}% WR, $${transStats.ev}/trade, N=${transStats.n}`);
if (stableStats) console.log(`  During stable regime:              ${stableStats.wr}% WR, $${stableStats.ev}/trade, N=${stableStats.n}`);


// ────────────────────────────────────────────────────────────
//  STEP 5 — Create and populate level_regime_performance table
// ────────────────────────────────────────────────────────────
console.log('\n═══ STEP 5: Storing results in level_regime_performance ═══');

await query(`
  CREATE TABLE IF NOT EXISTS level_regime_performance (
    id SERIAL PRIMARY KEY,
    level_name VARCHAR(30),
    vol_regime VARCHAR(15),
    dir_regime VARCHAR(15),
    range_regime VARCHAR(15),
    sample_size INT,
    win_rate NUMERIC,
    ev_per_trade NUMERIC,
    avg_mfe NUMERIC,
    avg_mae NUMERIC,
    vs_overall VARCHAR(15),
    last_computed DATE DEFAULT CURRENT_DATE,
    UNIQUE(level_name, vol_regime, dir_regime, range_regime)
  )
`);

// Upsert all combos (including those with n < 5 for completeness)
let inserted = 0, skipped = 0;
for (const c of allCombos) {
  if (!c.stats) { skipped++; continue; }
  await query(`
    INSERT INTO level_regime_performance
      (level_name, vol_regime, dir_regime, range_regime, sample_size, win_rate, ev_per_trade, avg_mfe, avg_mae, vs_overall, last_computed)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_DATE)
    ON CONFLICT (level_name, vol_regime, dir_regime, range_regime)
    DO UPDATE SET
      sample_size = EXCLUDED.sample_size,
      win_rate = EXCLUDED.win_rate,
      ev_per_trade = EXCLUDED.ev_per_trade,
      avg_mfe = EXCLUDED.avg_mfe,
      avg_mae = EXCLUDED.avg_mae,
      vs_overall = EXCLUDED.vs_overall,
      last_computed = CURRENT_DATE
  `, [
    c.level, c.volRegime, c.dirRegime, c.rangeRegime,
    c.stats.n, c.stats.wr, c.stats.ev, c.stats.avgMfe, c.stats.avgMae, c.vsOverall,
  ]);
  inserted++;
}
console.log(`  Upserted ${inserted} rows, skipped ${skipped} (no trades).\n`);


// ────────────────────────────────────────────────────────────
//  STEP 6 — API endpoint JSON payload
// ────────────────────────────────────────────────────────────
console.log('═══ STEP 6: API ENDPOINT PAYLOAD ═══\n');

// Generate the payload that /api/level-regime-performance would return
const currentR = currentRegime || { volRegime: 'NORMAL', dirRegime: 'NEUTRAL', rangeRegime: 'NORMAL' };

// Query: for the current vol×dir regime, return ranked levels
const payloadLevels = volDirCombos
  .filter(c =>
    c.volRegime === currentR.volRegime &&
    c.dirRegime === currentR.dirRegime &&
    c.stats && c.stats.n >= 5
  )
  .sort((a, b) => b.stats.ev - a.stats.ev)
  .map(c => ({
    level: c.level,
    regime: `${c.volRegime}/${c.dirRegime}`,
    sample_size: c.stats.n,
    win_rate: c.stats.wr,
    ev_per_trade: c.stats.ev,
    avg_mfe: c.stats.avgMfe,
    avg_mae: c.stats.avgMae,
    vs_overall: c.vsOverall,
    overall_wr: overallByLevel[c.level]?.wr ?? null,
  }));

const payload = {
  regime: {
    volatility: currentR.volRegime,
    direction: currentR.dirRegime,
    range: currentR.rangeRegime,
    as_of: lastDate,
    streak_days: streakDays,
  },
  levels: payloadLevels,
  meta: {
    total_trades_analyzed: allTrades.length,
    date_range: `${allDates[0]} to ${allDates[allDates.length-1]}`,
    stop_pts: FADE_STOP,
    target_pts: FADE_TARGET,
  },
};

console.log('Sample API response for /api/level-regime-performance:');
console.log(JSON.stringify(payload, null, 2));


// ────────────────────────────────────────────────────────────
//  STEP 7 — Nightly update mechanism
// ────────────────────────────────────────────────────────────
console.log('\n═══ STEP 7: NIGHTLY UPDATE ═══');
console.log('This script is idempotent (upsert logic). Schedule via cron:');
console.log('');
console.log('  # Add to crontab (runs at 5:30 PM ET on weekdays after market close):');
console.log('  30 17 * * 1-5 cd /home/mmoniz/trading-journal && node scripts/regime_adaptive_levels.mjs >> logs/regime_update.log 2>&1');
console.log('');


// ────────────────────────────────────────────────────────────
//  STEP 8 — Morning prep playbook
// ────────────────────────────────────────────────────────────
console.log('\n');
console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log(`║  MORNING LEVEL PLAYBOOK                                        ║`);
console.log(`║  Regime: ${currentR.volRegime} / ${currentR.dirRegime} / ${currentR.rangeRegime}`.padEnd(65) + '║');
console.log(`║  As of: ${lastDate}    Streak: ${streakDays} days in this vol×dir regime`.padEnd(65) + '║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

// Categorize levels for the current vol×dir regime
const currentLevels = volDirCombos
  .filter(c =>
    c.volRegime === currentR.volRegime &&
    c.dirRegime === currentR.dirRegime &&
    c.stats && c.stats.n >= 5
  )
  .sort((a, b) => b.stats.ev - a.stats.ev);

const leanInto = currentLevels.filter(c => c.vsOverall === 'OUTPERFORMING' && c.stats.ev > 0);
const standard = currentLevels.filter(c => c.vsOverall === 'NORMAL' && c.stats.ev > 0);
const avoid = currentLevels.filter(c => c.vsOverall === 'DEGRADING' || c.stats.ev <= 0);
const noDataLevels = LEVEL_NAMES.filter(l => !currentLevels.find(c => c.level === l));

let rank = 1;

if (leanInto.length > 0) {
  console.log('LEAN INTO (outperforming in this regime):');
  for (const c of leanInto) {
    const overall = overallByLevel[c.level];
    const diff = (c.stats.wr - overall.wr).toFixed(0);
    console.log(`  ${String(rank++).padStart(2)}. ${c.level.padEnd(14)} — ${c.stats.wr}% WR (+${diff}pp vs overall), $${c.stats.ev}/trade, N=${c.stats.n}`);
  }
  console.log('');
}

if (standard.length > 0) {
  console.log('STANDARD (performing at baseline):');
  for (const c of standard) {
    const overall = overallByLevel[c.level];
    const diff = (c.stats.wr - overall.wr).toFixed(0);
    const sign = parseFloat(diff) >= 0 ? '+' : '';
    console.log(`  ${String(rank++).padStart(2)}. ${c.level.padEnd(14)} — ${c.stats.wr}% WR (${sign}${diff}pp), $${c.stats.ev}/trade, N=${c.stats.n}`);
  }
  console.log('');
}

if (avoid.length > 0) {
  console.log('AVOID (degrading in this regime):');
  for (const c of avoid) {
    const overall = overallByLevel[c.level];
    const diff = (c.stats.wr - overall.wr).toFixed(0);
    console.log(`   - ${c.level.padEnd(14)} — ${c.stats.wr}% WR (${diff}pp), $${c.stats.ev}/trade, N=${c.stats.n}`);
  }
  console.log('');
}

if (noDataLevels.length > 0) {
  console.log('INSUFFICIENT DATA (N < 5 in this regime):');
  console.log(`   ${noDataLevels.join(', ')}`);
  console.log('');
}

// Summary stats
console.log('─'.repeat(66));
if (transStats && stableStats) {
  if (streakDays <= 3) {
    console.log(`NOTE: Regime is NEW (${streakDays} days). During transitions, fades historically`);
    console.log(`run ${transStats.wr}% WR vs ${stableStats.wr}% in stable regimes. Consider reduced size.`);
  } else {
    console.log(`Regime is ESTABLISHED (${streakDays} days). Level signals at full reliability.`);
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nCompleted in ${elapsed}s.`);

process.exit(0);
