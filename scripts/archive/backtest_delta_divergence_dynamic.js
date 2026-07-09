/**
 * Delta-Price Divergence Backtest with Dynamic Thresholds
 *
 * Tests whether delta-price divergence snaps back, using:
 * - Dynamic thresholds (% of developing range, not fixed points)
 * - Multiple rolling windows (15, 30, 60 min)
 * - Day-type classification (TREND, BALANCE, CHOP, POST_FLUSH)
 * - Acceleration detection
 *
 * Prior finding: fixed-point thresholds => 50% snap-back (coin flip).
 * Hypothesis: dynamic thresholds + day-type context reveals edge.
 */

import { query } from '../server/db.js';

// ── CONFIG ──────────────────────────────────────────────────────────────────
const RTH_START = 570;  // 9:30 ET
const RTH_END   = 959;  // 15:59 ET
const IB_END    = 630;  // 10:30 ET (60 min after open)
const LOOKBACK_MONTHS = 36; // go back far enough to get all available delta data (~Nov 2023)

const ROLLING_WINDOWS = [15, 30, 60]; // minutes
const SNAP_HORIZONS  = [15, 30, 60];  // minutes after divergence peak

const STRETCH_BUCKETS = [
  { label: '5-10%',  lo: 0.05, hi: 0.10 },
  { label: '10-20%', lo: 0.10, hi: 0.20 },
  { label: '20-30%', lo: 0.20, hi: 0.30 },
  { label: '30%+',   lo: 0.30, hi: Infinity },
];

const SIGMA_BUCKETS = [
  { label: '1-1.5σ', lo: 1.0, hi: 1.5 },
  { label: '1.5-2σ', lo: 1.5, hi: 2.0 },
  { label: '2-3σ',   lo: 2.0, hi: 3.0 },
  { label: '3σ+',    lo: 3.0, hi: Infinity },
];

// ── HELPERS ──────────────────────────────────────────────────────────────────
function minuteOfDay(ts) {
  return ts.getUTCHours() * 60 + ts.getUTCMinutes();
}

function bucketLabel(val, buckets) {
  for (const b of buckets) {
    if (val >= b.lo && val < b.hi) return b.label;
  }
  return null;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

// ── LOAD DATA ───────────────────────────────────────────────────────────────
async function loadMinuteBars() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - LOOKBACK_MONTHS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  console.log(`Loading 1-min bars from ${cutoffStr} to present (RTH only)...`);

  const res = await query(`
    SELECT
      date_trunc('minute', ts) AS minute_ts,
      ts::date AS trade_date,
      EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int AS min_of_day,
      (array_agg(open ORDER BY ts))[1]::float AS open,
      MAX(high)::float AS high,
      MIN(low)::float AS low,
      (array_agg(close ORDER BY ts DESC))[1]::float AS close,
      SUM(volume)::int AS volume,
      SUM(bid_volume)::int AS bid_vol,
      SUM(ask_volume)::int AS ask_vol
    FROM price_bars_primary
    WHERE ts::date >= $1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND ${RTH_END}
      AND (bid_volume > 0 OR ask_volume > 0)
      AND symbol = 'NQ'
    GROUP BY date_trunc('minute', ts), ts::date,
             EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int
    ORDER BY minute_ts
  `, [cutoffStr]);

  console.log(`  Loaded ${res.rows.length} minute bars`);
  return res.rows;
}

async function loadPriorDayRanges() {
  const res = await query(`
    SELECT trade_date, (session_high - session_low)::float AS day_range
    FROM developing_value_log
    WHERE session_high IS NOT NULL AND session_low IS NOT NULL
    ORDER BY trade_date
  `);
  const map = new Map();
  for (const r of res.rows) map.set(r.trade_date, r.day_range);
  return map;
}

// ── ORGANIZE BY DAY ─────────────────────────────────────────────────────────
function groupByDay(rows) {
  const days = new Map();
  for (const r of rows) {
    const key = r.trade_date;
    if (!days.has(key)) days.set(key, []);
    days.get(key).push({
      ts: new Date(r.minute_ts),
      minOfDay: r.min_of_day,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      bidVol: r.bid_vol,
      askVol: r.ask_vol,
      delta: r.ask_vol - r.bid_vol,
    });
  }
  // Sort each day's bars
  for (const [, bars] of days) {
    bars.sort((a, b) => a.ts - b.ts);
  }
  return days;
}

// ── DAY-TYPE CLASSIFICATION ─────────────────────────────────────────────────
function classifyDayType(bars) {
  // Find IB close bar (minute 630 = 10:30)
  const ibBars = bars.filter(b => b.minOfDay <= IB_END);
  if (ibBars.length < 30) return 'UNKNOWN'; // not enough data

  const ibHigh = Math.max(...ibBars.map(b => b.high));
  const ibLow  = Math.min(...ibBars.map(b => b.low));
  const ibRange = ibHigh - ibLow;
  if (ibRange < 1) return 'UNKNOWN';

  // Efficiency ratio: net directional movement / total range
  const ibOpen  = ibBars[0].open;
  const ibClose = ibBars[ibBars.length - 1].close;
  const netMove = Math.abs(ibClose - ibOpen);
  const er = netMove / ibRange;

  if (er > 0.30) return 'TREND';
  if (er < 0.15) return 'CHOP';
  return 'BALANCE';
}

function tagPostFlush(dateStr, dayRanges) {
  // Prior day range > 1.5x 20-day avg range
  const dates = [...dayRanges.keys()].sort();
  const idx = dates.indexOf(dateStr);
  if (idx < 21) return false;

  const priorDate = dates[idx - 1];
  const priorRange = dayRanges.get(priorDate);
  if (!priorRange) return false;

  // 20-day avg range (days idx-21 to idx-2)
  let sum = 0, cnt = 0;
  for (let i = Math.max(0, idx - 21); i < idx - 1; i++) {
    const r = dayRanges.get(dates[i]);
    if (r) { sum += r; cnt++; }
  }
  if (cnt < 10) return false;
  const avgRange = sum / cnt;
  return priorRange > avgRange * 1.5;
}

// ── DIVERGENCE DETECTION ────────────────────────────────────────────────────
function computeDivergences(bars, windowSize) {
  const signals = [];
  if (bars.length < windowSize + 1) return signals;

  // Pre-compute developing range at each bar
  let devHigh = -Infinity, devLow = Infinity;
  const devRangeAt = [];
  for (let i = 0; i < bars.length; i++) {
    devHigh = Math.max(devHigh, bars[i].high);
    devLow  = Math.min(devLow, bars[i].low);
    devRangeAt[i] = devHigh - devLow;
  }

  // Rolling cumulative delta and price for windows
  // For each bar i, compute window [i-windowSize+1 .. i]
  const cumDelta = new Array(bars.length);
  cumDelta[0] = bars[0].delta;
  for (let i = 1; i < bars.length; i++) {
    cumDelta[i] = cumDelta[i - 1] + bars[i].delta;
  }

  // Track trailing 30-min price swings for sigma calculation
  const priceSwings = []; // absolute price change over 30-min windows
  const SWING_WINDOW = 30;

  for (let i = windowSize; i < bars.length; i++) {
    const startIdx = i - windowSize;

    // Price change over window
    const priceChange = bars[i].close - bars[startIdx].close;

    // Delta change over window
    const deltaInWindow = cumDelta[i] - (startIdx > 0 ? cumDelta[startIdx - 1] : 0);

    // Developing range at this point
    const devRange = devRangeAt[i];
    if (devRange < 50) continue; // skip when range too small (< 50 pts, ~first 10 min noise)

    // Must be at least 30 min into session for developing range to be meaningful
    if (i < 30) continue;

    // Track price swings for sigma
    if (i >= SWING_WINDOW) {
      const swing = Math.abs(bars[i].close - bars[i - SWING_WINDOW].close);
      priceSwings.push(swing);
      if (priceSwings.length > 60) priceSwings.shift(); // trailing 60 swings
    }

    // Divergence: price and delta moving in opposite directions
    const absPriceChange = Math.abs(priceChange);
    const priceStretch = absPriceChange / devRange; // as % of developing range

    // Compute sigma of this price move relative to trailing swings
    let sigma = 0;
    if (priceSwings.length >= 10) {
      const sd = stddev(priceSwings);
      if (sd > 0) sigma = absPriceChange / sd;
    }

    // Check for divergence
    let divType = null;

    // BULLISH divergence: price down/flat, delta up (buying into weakness)
    if (priceChange < 0 && deltaInWindow > 0) {
      divType = 'BULLISH';
    }
    // BEARISH divergence: price up/flat, delta down (selling into strength)
    else if (priceChange > 0 && deltaInWindow < 0) {
      divType = 'BEARISH';
    }

    if (!divType) continue;

    // Minimum thresholds: price must have moved at least 5% of dev range
    // and delta must be meaningfully divergent
    if (priceStretch < 0.05) continue;

    // Delta magnitude threshold: at least 500 contracts divergent
    if (Math.abs(deltaInWindow) < 500) continue;

    // Check delta acceleration: is delta rate increasing?
    // Compare delta in second half of window vs first half
    const midIdx = startIdx + Math.floor(windowSize / 2);
    const deltaFirstHalf = cumDelta[midIdx] - (startIdx > 0 ? cumDelta[startIdx - 1] : 0);
    const deltaSecondHalf = deltaInWindow - deltaFirstHalf;
    const accelerating = (divType === 'BULLISH' && deltaSecondHalf > deltaFirstHalf && deltaFirstHalf > 0)
                      || (divType === 'BEARISH' && deltaSecondHalf < deltaFirstHalf && deltaFirstHalf < 0);

    signals.push({
      barIdx: i,
      ts: bars[i].ts,
      minOfDay: bars[i].minOfDay,
      divType,
      priceChange,
      deltaInWindow,
      priceStretch,
      sigma,
      devRange,
      priceAtSignal: bars[i].close,
      accelerating,
    });
  }

  return signals;
}

// ── SNAP-BACK MEASUREMENT ───────────────────────────────────────────────────
function measureSnapBacks(signals, bars, horizons) {
  const results = [];

  for (const sig of signals) {
    const i = sig.barIdx;
    const entry = sig.priceAtSignal;
    const devRange = sig.devRange;

    const snapResult = { ...sig, snapBacks: {} };

    for (const h of horizons) {
      const targetIdx = i + h;
      if (targetIdx >= bars.length) {
        snapResult.snapBacks[h] = null; // not enough data
        continue;
      }

      const futurePrice = bars[targetIdx].close;
      const priceMove = futurePrice - entry;

      // For BULLISH divergence: snap-back = price goes UP
      // For BEARISH divergence: snap-back = price goes DOWN
      const favorable = (sig.divType === 'BULLISH' && priceMove > 0)
                     || (sig.divType === 'BEARISH' && priceMove < 0);

      // Magnitude as % of developing range at signal time
      const magnitude = Math.abs(priceMove) / devRange;

      // Check max adverse excursion within the horizon
      let maxAdverse = 0;
      let maxFavorable = 0;
      for (let j = i + 1; j <= targetIdx && j < bars.length; j++) {
        const move = bars[j].close - entry;
        if (sig.divType === 'BULLISH') {
          maxAdverse = Math.min(maxAdverse, move);
          maxFavorable = Math.max(maxFavorable, move);
        } else {
          maxAdverse = Math.max(maxAdverse, move); // adverse = up for bearish
          maxFavorable = Math.min(maxFavorable, move);
        }
      }

      snapResult.snapBacks[h] = {
        favorable,
        magnitude,
        ptsMove: Math.abs(priceMove),
        maxAdversePts: Math.abs(maxAdverse),
        maxFavorablePts: Math.abs(maxFavorable),
        favorableDir: favorable,
      };
    }

    results.push(snapResult);
  }

  return results;
}

// ── DEDUP SIGNALS ───────────────────────────────────────────────────────────
function dedupSignals(signals, minGapMinutes = 15) {
  // When divergence persists over many bars, we get many similar signals.
  // Keep only the PEAK divergence within each cluster.
  if (signals.length === 0) return [];

  const sorted = [...signals].sort((a, b) => a.ts - b.ts);
  const deduped = [];
  let cluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].ts - cluster[cluster.length - 1].ts) / 60000;
    if (gap <= minGapMinutes && sorted[i].divType === cluster[0].divType) {
      cluster.push(sorted[i]);
    } else {
      // Pick peak of cluster (max stretch)
      cluster.sort((a, b) => b.priceStretch - a.priceStretch);
      deduped.push(cluster[0]);
      cluster = [sorted[i]];
    }
  }
  // Last cluster
  cluster.sort((a, b) => b.priceStretch - a.priceStretch);
  deduped.push(cluster[0]);

  return deduped;
}

// ── AGGREGATE RESULTS ───────────────────────────────────────────────────────
function aggregateResults(allResults, horizons) {
  // Key: window_dayType_stretchBucket_divType
  const agg = new Map();

  for (const r of allResults) {
    const stretchBucket = bucketLabel(r.priceStretch, STRETCH_BUCKETS);
    const sigmaBucket = bucketLabel(r.sigma, SIGMA_BUCKETS);
    if (!stretchBucket) continue;

    // Use pipe separator to avoid POST_FLUSH splitting issues
    const keys = [
      // By stretch bucket
      `${r.windowSize}|${r.dayType}|${stretchBucket}|${r.divType}`,
      // Overall by window + day type
      `${r.windowSize}|${r.dayType}|ALL|${r.divType}`,
      // Overall by window
      `${r.windowSize}|ALL|ALL|${r.divType}`,
      // By acceleration
      `${r.windowSize}|${r.dayType}|${stretchBucket}|${r.divType}|${r.accelerating ? 'ACCEL' : 'STEADY'}`,
    ];

    // Add sigma-based key
    if (sigmaBucket) {
      keys.push(`${r.windowSize}|${r.dayType}|sigma_${sigmaBucket}|${r.divType}`);
    }

    for (const key of keys) {
      if (!agg.has(key)) {
        agg.set(key, { signals: [], key });
      }
      agg.get(key).signals.push(r);
    }
  }

  // Compute stats for each bucket
  const stats = [];
  for (const [key, bucket] of agg) {
    const n = bucket.signals.length;
    if (n < 3) continue; // skip tiny samples

    const parts = key.split('|');
    const stat = {
      key,
      window: parseInt(parts[0]),
      dayType: parts[1],
      stretch: parts[2],
      divType: parts[3],
      accel: parts.length > 4 ? parts[4] : null,
      n,
    };

    for (const h of horizons) {
      const withData = bucket.signals.filter(s => s.snapBacks[h] !== null);
      const favorable = withData.filter(s => s.snapBacks[h]?.favorable);

      stat[`snap_${h}_rate`] = withData.length > 0 ? favorable.length / withData.length : 0;
      stat[`snap_${h}_n`] = withData.length;
      stat[`snap_${h}_avgMag`] = withData.length > 0
        ? withData.reduce((a, s) => a + (s.snapBacks[h]?.magnitude || 0), 0) / withData.length
        : 0;
      stat[`snap_${h}_avgPts`] = withData.length > 0
        ? withData.reduce((a, s) => a + (s.snapBacks[h]?.ptsMove || 0), 0) / withData.length
        : 0;
      stat[`snap_${h}_avgMAE`] = withData.length > 0
        ? withData.reduce((a, s) => a + (s.snapBacks[h]?.maxAdversePts || 0), 0) / withData.length
        : 0;
      stat[`snap_${h}_avgMFE`] = withData.length > 0
        ? withData.reduce((a, s) => a + (s.snapBacks[h]?.maxFavorablePts || 0), 0) / withData.length
        : 0;

      // False signal rate: divergence where price continues against delta past the horizon
      // (not just doesn't snap back, but actively moves further in wrong direction)
      const falseSignals = withData.filter(s => {
        if (!s.snapBacks[h]) return false;
        return !s.snapBacks[h].favorable && s.snapBacks[h].ptsMove > s.devRange * 0.05;
      });
      stat[`false_${h}_rate`] = withData.length > 0 ? falseSignals.length / withData.length : 0;
    }

    stats.push(stat);
  }

  return stats;
}

// ── EXPECTED VALUE CALC ─────────────────────────────────────────────────────
function computeEV(stats, horizon) {
  // For each stat row, compute EV with dynamic stop and target
  return stats.map(s => {
    const rate = s[`snap_${horizon}_rate`];
    const avgMFE = s[`snap_${horizon}_avgMFE`];
    const avgMAE = s[`snap_${horizon}_avgMAE`];
    const avgPts = s[`snap_${horizon}_avgPts`];
    const n = s[`snap_${horizon}_n`];

    if (!n || n < 5) return { ...s, ev: null };

    // Simple EV: (winRate * avgWin) - (lossRate * avgLoss)
    // Using MFE as proxy for avg win, MAE as proxy for avg loss
    const ev = (rate * avgMFE) - ((1 - rate) * avgMAE);

    return { ...s, [`ev_${horizon}`]: ev, [`rr_${horizon}`]: avgMFE / (avgMAE || 1) };
  });
}

// ── REPORT ──────────────────────────────────────────────────────────────────
function printReport(stats, allResults) {
  console.log('\n' + '='.repeat(100));
  console.log('DELTA-PRICE DIVERGENCE BACKTEST — DYNAMIC THRESHOLDS');
  console.log('='.repeat(100));

  // Data summary
  const days = new Set(allResults.map(r => r.dayDate));
  const dayTypes = {};
  for (const r of allResults) {
    dayTypes[r.dayType] = (dayTypes[r.dayType] || 0);
  }
  // Count unique days per type
  const dayTypeDays = {};
  for (const r of allResults) {
    const k = r.dayType;
    if (!dayTypeDays[k]) dayTypeDays[k] = new Set();
    dayTypeDays[k].add(r.dayDate);
  }

  console.log(`\nData: ${days.size} trading days, ${allResults.length} divergence signals`);
  console.log('Day types (by signal count):');
  for (const [dt, s] of Object.entries(dayTypeDays)) {
    const sigs = allResults.filter(r => r.dayType === dt).length;
    console.log(`  ${dt}: ${s.size} days, ${sigs} signals`);
  }

  // ── SECTION 1: Best window by overall snap-back rate ──
  console.log('\n' + '-'.repeat(100));
  console.log('SECTION 1: OVERALL SNAP-BACK RATE BY WINDOW SIZE');
  console.log('-'.repeat(100));

  const overallStats = stats.filter(s => s.dayType === 'ALL' && s.stretch === 'ALL' && !s.accel);
  overallStats.sort((a, b) => a.window - b.window);

  console.log('\n' + padR('Window', 8) + padR('Type', 10) + padR('N', 6)
    + padR('Snap15%', 10) + padR('Snap30%', 10) + padR('Snap60%', 10)
    + padR('AvgPts15', 10) + padR('AvgPts30', 10) + padR('AvgPts60', 10));

  for (const s of overallStats) {
    console.log(
      padR(s.window + 'min', 8) + padR(s.divType, 10) + padR(s.n, 6)
      + padR(pct(s.snap_15_rate), 10) + padR(pct(s.snap_30_rate), 10) + padR(pct(s.snap_60_rate), 10)
      + padR(pts(s.snap_15_avgPts), 10) + padR(pts(s.snap_30_avgPts), 10) + padR(pts(s.snap_60_avgPts), 10)
    );
  }

  // ── SECTION 2: By day type ──
  console.log('\n' + '-'.repeat(100));
  console.log('SECTION 2: SNAP-BACK BY DAY TYPE (all stretch buckets combined)');
  console.log('-'.repeat(100));

  const dayTypeStats = stats.filter(s => s.dayType !== 'ALL' && s.stretch === 'ALL' && !s.accel);
  dayTypeStats.sort((a, b) => a.window - b.window || a.dayType.localeCompare(b.dayType));

  console.log('\n' + padR('Window', 8) + padR('DayType', 12) + padR('DivType', 10) + padR('N', 6)
    + padR('Snap15%', 10) + padR('Snap30%', 10) + padR('Snap60%', 10)
    + padR('False15%', 10) + padR('False30%', 10) + padR('False60%', 10));

  for (const s of dayTypeStats) {
    console.log(
      padR(s.window + 'min', 8) + padR(s.dayType, 12) + padR(s.divType, 10) + padR(s.n, 6)
      + padR(pct(s.snap_15_rate), 10) + padR(pct(s.snap_30_rate), 10) + padR(pct(s.snap_60_rate), 10)
      + padR(pct(s.false_15_rate), 10) + padR(pct(s.false_30_rate), 10) + padR(pct(s.false_60_rate), 10)
    );
  }

  // ── SECTION 3: By stretch bucket × day type ──
  console.log('\n' + '-'.repeat(100));
  console.log('SECTION 3: SNAP-BACK BY STRETCH BUCKET x DAY TYPE');
  console.log('-'.repeat(100));

  for (const w of ROLLING_WINDOWS) {
    console.log(`\n  === ${w}-min Window ===`);
    const wStats = stats.filter(s =>
      s.window === w && s.dayType !== 'ALL' && s.stretch !== 'ALL'
      && !s.stretch.startsWith('sigma') && !s.accel && s.n >= 5
    );
    wStats.sort((a, b) => a.dayType.localeCompare(b.dayType) || a.stretch.localeCompare(b.stretch));

    console.log('  ' + padR('DayType', 12) + padR('Stretch', 10) + padR('DivType', 10) + padR('N', 6)
      + padR('Snap15%', 10) + padR('Snap30%', 10) + padR('Snap60%', 10)
      + padR('AvgMag30', 10) + padR('MAE30', 10) + padR('MFE30', 10));

    for (const s of wStats) {
      console.log('  ' +
        padR(s.dayType, 12) + padR(s.stretch, 10) + padR(s.divType, 10) + padR(s.n, 6)
        + padR(pct(s.snap_15_rate), 10) + padR(pct(s.snap_30_rate), 10) + padR(pct(s.snap_60_rate), 10)
        + padR(pct(s.snap_30_avgMag), 10) + padR(pts(s.snap_30_avgMAE), 10) + padR(pts(s.snap_30_avgMFE), 10)
      );
    }
  }

  // ── SECTION 4: Sigma-based buckets ──
  console.log('\n' + '-'.repeat(100));
  console.log('SECTION 4: SIGMA-BASED STRETCH BUCKETS');
  console.log('-'.repeat(100));

  for (const w of ROLLING_WINDOWS) {
    const sigStats = stats.filter(s =>
      s.window === w && s.stretch.startsWith('sigma_') && !s.accel && s.n >= 5
    );
    if (sigStats.length === 0) continue;

    console.log(`\n  === ${w}-min Window ===`);
    sigStats.sort((a, b) => a.dayType.localeCompare(b.dayType) || a.stretch.localeCompare(b.stretch));

    console.log('  ' + padR('DayType', 12) + padR('Sigma', 10) + padR('DivType', 10) + padR('N', 6)
      + padR('Snap15%', 10) + padR('Snap30%', 10) + padR('Snap60%', 10)
      + padR('AvgPts30', 10));

    for (const s of sigStats) {
      console.log('  ' +
        padR(s.dayType, 12) + padR(s.stretch.replace('sigma_', ''), 10) + padR(s.divType, 10) + padR(s.n, 6)
        + padR(pct(s.snap_15_rate), 10) + padR(pct(s.snap_30_rate), 10) + padR(pct(s.snap_60_rate), 10)
        + padR(pts(s.snap_30_avgPts), 10)
      );
    }
  }

  // ── SECTION 5: Acceleration test ──
  console.log('\n' + '-'.repeat(100));
  console.log('SECTION 5: ACCELERATING vs STEADY DIVERGENCE');
  console.log('-'.repeat(100));

  const accelStats = stats.filter(s => s.accel !== null && s.n >= 5);
  accelStats.sort((a, b) => a.window - b.window || a.dayType.localeCompare(b.dayType)
    || a.stretch.localeCompare(b.stretch) || a.accel.localeCompare(b.accel));

  console.log('\n' + padR('Window', 8) + padR('DayType', 12) + padR('Stretch', 10)
    + padR('DivType', 10) + padR('Accel?', 8) + padR('N', 6)
    + padR('Snap15%', 10) + padR('Snap30%', 10) + padR('Snap60%', 10));

  for (const s of accelStats) {
    console.log(
      padR(s.window + 'min', 8) + padR(s.dayType, 12) + padR(s.stretch, 10)
      + padR(s.divType, 10) + padR(s.accel, 8) + padR(s.n, 6)
      + padR(pct(s.snap_15_rate), 10) + padR(pct(s.snap_30_rate), 10) + padR(pct(s.snap_60_rate), 10)
    );
  }

  // ── SECTION 6: Expected Value Rankings ──
  console.log('\n' + '-'.repeat(100));
  console.log('SECTION 6: EXPECTED VALUE RANKINGS (30-min horizon)');
  console.log('-'.repeat(100));

  const evStats = computeEV(stats, 30)
    .filter(s => s.ev_30 !== undefined && s.ev_30 !== null && s.n >= 10 && !s.accel && !s.stretch.startsWith('sigma'))
    .sort((a, b) => (b.ev_30 || 0) - (a.ev_30 || 0));

  console.log('\n' + padR('Combo', 50) + padR('N', 6) + padR('WR%', 8)
    + padR('AvgMFE', 10) + padR('AvgMAE', 10) + padR('R:R', 8) + padR('EV/trade', 10));

  for (const s of evStats.slice(0, 20)) {
    const label = `${s.window}min_${s.dayType}_${s.stretch}_${s.divType}`;
    console.log(
      padR(label, 50) + padR(s.n, 6) + padR(pct(s.snap_30_rate), 8)
      + padR(pts(s.snap_30_avgMFE), 10) + padR(pts(s.snap_30_avgMAE), 10)
      + padR((s.rr_30 || 0).toFixed(2), 8) + padR(pts(s.ev_30), 10)
    );
  }

  // ── SECTION 7: Post-flush analysis ──
  console.log('\n' + '-'.repeat(100));
  console.log('SECTION 7: POST-FLUSH DAY DIVERGENCE');
  console.log('-'.repeat(100));

  const postFlushStats = stats.filter(s => s.dayType === 'POST_FLUSH' && !s.accel);
  if (postFlushStats.length === 0) {
    console.log('\n  No post-flush signals with sufficient sample size');
  } else {
    postFlushStats.sort((a, b) => a.window - b.window);
    console.log('\n' + padR('Window', 8) + padR('Stretch', 10) + padR('DivType', 10) + padR('N', 6)
      + padR('Snap15%', 10) + padR('Snap30%', 10) + padR('Snap60%', 10));
    for (const s of postFlushStats) {
      console.log(
        padR(s.window + 'min', 8) + padR(s.stretch, 10) + padR(s.divType, 10) + padR(s.n, 6)
        + padR(pct(s.snap_15_rate), 10) + padR(pct(s.snap_30_rate), 10) + padR(pct(s.snap_60_rate), 10)
      );
    }
  }

  // ── SECTION 8: Key Findings ──
  console.log('\n' + '='.repeat(100));
  console.log('KEY FINDINGS & PRACTICAL TAKEAWAYS');
  console.log('='.repeat(100));

  // Find the best combination
  const bestByDayType = {};
  for (const dt of ['BALANCE', 'TREND', 'CHOP']) {
    const dtStats = evStats.filter(s => s.dayType === dt && s.stretch !== 'ALL');
    if (dtStats.length > 0) bestByDayType[dt] = dtStats[0];
  }

  for (const [dt, best] of Object.entries(bestByDayType)) {
    if (!best) continue;
    console.log(`\n  ${dt} days (best combo): ${best.window}min window, ${best.stretch} stretch, ${best.divType}`);
    console.log(`    Win rate: ${pct(best.snap_30_rate)}, Avg MFE: ${pts(best.snap_30_avgMFE)}, Avg MAE: ${pts(best.snap_30_avgMAE)}`);
    console.log(`    R:R: ${(best.rr_30 || 0).toFixed(2)}, EV/trade: ${pts(best.ev_30)} pts, N=${best.n}`);
  }

  // BALANCE vs TREND comparison at the 30-min window level
  console.log('\n  ── BALANCE vs TREND (overall, 30-min window) ──');
  const bal30 = stats.find(s => s.window === 30 && s.dayType === 'BALANCE' && s.stretch === 'ALL' && !s.accel);
  const tre30 = stats.find(s => s.window === 30 && s.dayType === 'TREND' && s.stretch === 'ALL' && !s.accel);
  if (bal30 && tre30) {
    console.log(`    BALANCE: ${pct(bal30.snap_30_rate)} snap-back (N=${bal30.n})`);
    console.log(`    TREND:   ${pct(tre30.snap_30_rate)} snap-back (N=${tre30.n})`);
    const diff = bal30.snap_30_rate - tre30.snap_30_rate;
    console.log(`    Difference: ${(diff * 100).toFixed(1)}pp — ${diff > 0.05 ? 'BALANCE CLEARLY BETTER' : diff > 0 ? 'Slight BALANCE edge' : 'NO edge for BALANCE'}`);
  }

  // Acceleration impact
  console.log('\n  ── ACCELERATION IMPACT ──');
  const accelGroups = {};
  for (const s of accelStats) {
    const key = `${s.window}_${s.dayType}_${s.stretch}_${s.divType}`;
    if (!accelGroups[key]) accelGroups[key] = {};
    accelGroups[key][s.accel] = s;
  }
  let accelBetter = 0, accelWorse = 0, accelSame = 0;
  for (const [key, group] of Object.entries(accelGroups)) {
    if (group.ACCEL && group.STEADY) {
      const diff = group.ACCEL.snap_30_rate - group.STEADY.snap_30_rate;
      if (diff > 0.05) accelBetter++;
      else if (diff < -0.05) accelWorse++;
      else accelSame++;
    }
  }
  console.log(`    Accelerating better: ${accelBetter} combos, Worse: ${accelWorse}, Same: ${accelSame}`);
  if (accelBetter > accelWorse) {
    console.log('    Conclusion: Accelerating divergence DOES predict better snap-backs');
  } else if (accelWorse > accelBetter) {
    console.log('    Conclusion: Accelerating divergence DOES NOT help — may indicate exhaustion');
  } else {
    console.log('    Conclusion: No clear difference — acceleration is NOT a useful filter');
  }

  // Optimal stretch
  console.log('\n  ── OPTIMAL STRETCH % ──');
  for (const w of ROLLING_WINDOWS) {
    const wEvStats = evStats.filter(s => s.window === w && s.dayType !== 'ALL' && s.stretch !== 'ALL');
    if (wEvStats.length > 0) {
      const best = wEvStats[0];
      console.log(`    ${w}min: Best = ${best.dayType} ${best.stretch} ${best.divType} — WR ${pct(best.snap_30_rate)}, EV ${pts(best.ev_30)}, N=${best.n}`);
    }
  }
}

function padR(s, n) { return String(s).padEnd(n); }
function pct(v) { return v != null ? (v * 100).toFixed(1) + '%' : 'N/A'; }
function pts(v) { return v != null ? v.toFixed(1) : 'N/A'; }

// ── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Delta-Price Divergence Backtest — Dynamic Thresholds');
  console.log('Testing 3 windows x 4 day types x 4 stretch buckets\n');

  const [minuteBars, dayRanges] = await Promise.all([
    loadMinuteBars(),
    loadPriorDayRanges(),
  ]);

  const days = groupByDay(minuteBars);
  console.log(`\nProcessing ${days.size} trading days...\n`);

  // Compute 20-day avg range for post-flush tagging
  const sortedDates = [...days.keys()].sort();
  const dayRangeArr = [];
  const avgRangeMap = new Map();
  for (const d of sortedDates) {
    const bars = days.get(d);
    const hi = Math.max(...bars.map(b => b.high));
    const lo = Math.min(...bars.map(b => b.low));
    dayRangeArr.push({ date: d, range: hi - lo });
    if (dayRangeArr.length >= 21) {
      const slice = dayRangeArr.slice(-21, -1);
      avgRangeMap.set(d, slice.reduce((a, b) => a + b.range, 0) / slice.length);
    }
  }

  const allResults = [];
  let dayTypeCounts = { TREND: 0, BALANCE: 0, CHOP: 0, POST_FLUSH: 0, UNKNOWN: 0 };

  for (const [dateStr, bars] of days) {
    if (bars.length < 60) continue; // skip short days

    let dayType = classifyDayType(bars);

    // Check post-flush
    const dateIdx = sortedDates.indexOf(dateStr);
    let isPostFlush = false;
    if (dateIdx > 0 && avgRangeMap.has(dateStr)) {
      const priorBars = days.get(sortedDates[dateIdx - 1]);
      if (priorBars) {
        const priorHi = Math.max(...priorBars.map(b => b.high));
        const priorLo = Math.min(...priorBars.map(b => b.low));
        const priorRange = priorHi - priorLo;
        const avgRange = avgRangeMap.get(dateStr);
        if (avgRange && priorRange > avgRange * 1.5) {
          isPostFlush = true;
        }
      }
    }

    dayTypeCounts[dayType] = (dayTypeCounts[dayType] || 0) + 1;
    if (isPostFlush) dayTypeCounts.POST_FLUSH++;

    for (const windowSize of ROLLING_WINDOWS) {
      let signals = computeDivergences(bars, windowSize);
      signals = dedupSignals(signals, windowSize); // dedup gap = window size

      const snapResults = measureSnapBacks(signals, bars, SNAP_HORIZONS);

      for (const r of snapResults) {
        r.windowSize = windowSize;
        r.dayType = dayType;
        r.dayDate = dateStr;
        r.isPostFlush = isPostFlush;
        allResults.push(r);

        // Also add a POST_FLUSH variant if applicable
        if (isPostFlush) {
          allResults.push({ ...r, dayType: 'POST_FLUSH' });
        }
      }
    }
  }

  console.log('Day type distribution:');
  for (const [dt, n] of Object.entries(dayTypeCounts)) {
    console.log(`  ${dt}: ${n} days`);
  }
  console.log(`\nTotal divergence signals: ${allResults.length}`);

  const stats = aggregateResults(allResults, SNAP_HORIZONS);

  printReport(stats, allResults);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
