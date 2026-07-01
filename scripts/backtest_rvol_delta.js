import { query } from '../server/db.js';

// ============================================================
// RELATIVE VOLUME & CUMULATIVE DELTA BACKTEST
// ============================================================
// Analyzes ~1 year of NQ 1-min bars for volume and delta behavior.
// RTH: 9:30 AM (minute 570) to 3:59 PM (minute 959) ET
// Hour boundaries: 10:00 (600), 11:00 (660), 12:00 (720),
//   1:00 PM (780), 2:00 PM (840), 3:00 PM (900), close (960)
// ============================================================

const RTH_START = 570; // 9:30
const RTH_END = 959;   // 15:59

const HOUR_BOUNDARIES = [600, 660, 720, 780, 840, 900, 960]; // minutes
const HOUR_LABELS = ['10:00', '11:00', '12:00', '1:00 PM', '2:00 PM', '3:00 PM', 'Close'];

async function main() {
  console.log('='.repeat(80));
  console.log('NQ RELATIVE VOLUME & CUMULATIVE DELTA BACKTEST');
  console.log('='.repeat(80));

  // ─── Fetch all RTH bars for the past year ───
  const barsResult = await query(`
    SELECT
      ts::date AS trade_date,
      EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int AS minute_of_day,
      open::float, high::float, low::float, close::float,
      volume::int,
      COALESCE(bid_volume, 0)::int AS bid_vol,
      COALESCE(ask_volume, 0)::int AS ask_vol
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND ts >= NOW() - INTERVAL '1 year'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND ${RTH_END}
    ORDER BY ts
  `);

  console.log(`\nLoaded ${barsResult.rows.length} RTH bars\n`);

  // ─── Group bars by day ───
  const dayMap = new Map(); // date_str -> { bars[], dayOpen, dayHigh, dayLow, dayClose }

  for (const bar of barsResult.rows) {
    const dateStr = bar.trade_date;
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, {
        bars: [],
        dayOpen: null, dayHigh: -Infinity, dayLow: Infinity, dayClose: null,
        hourlyVolume: {},    // minute_boundary -> cumulative volume
        hourlyDelta: {},     // minute_boundary -> cumulative delta
        totalVolume: 0,
        totalDelta: 0,
        totalBuyVol: 0,
        totalSellVol: 0,
      });
    }
    const day = dayMap.get(dateStr);
    day.bars.push(bar);

    if (day.dayOpen === null) day.dayOpen = bar.open;
    if (bar.high > day.dayHigh) day.dayHigh = bar.high;
    if (bar.low < day.dayLow) day.dayLow = bar.low;
    day.dayClose = bar.close;

    day.totalVolume += bar.volume;

    // Delta: use actual bid/ask volume if available, else estimate
    let barDelta;
    if (bar.ask_vol > 0 || bar.bid_vol > 0) {
      barDelta = bar.ask_vol - bar.bid_vol;
    } else {
      barDelta = bar.close >= bar.open ? bar.volume : -bar.volume;
    }
    day.totalDelta += barDelta;
    day.totalBuyVol += (bar.ask_vol > 0 || bar.bid_vol > 0) ? bar.ask_vol : (bar.close >= bar.open ? bar.volume : 0);
    day.totalSellVol += (bar.ask_vol > 0 || bar.bid_vol > 0) ? bar.bid_vol : (bar.close < bar.open ? bar.volume : 0);

    // Compute cumulative volume and delta at each hour boundary
    for (const boundary of HOUR_BOUNDARIES) {
      if (bar.minute_of_day < boundary) {
        if (!day.hourlyVolume[boundary]) day.hourlyVolume[boundary] = 0;
        if (!day.hourlyDelta[boundary]) day.hourlyDelta[boundary] = 0;
        day.hourlyVolume[boundary] += bar.volume;
        day.hourlyDelta[boundary] += barDelta;
      }
    }
  }

  // Convert to sorted array
  const days = [...dayMap.entries()]
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date < b.date ? -1 : 1);

  console.log(`Total trading days: ${days.length}`);
  console.log(`Date range: ${days[0]?.date} to ${days[days.length - 1]?.date}\n`);

  // ─── SECTION 1: RELATIVE VOLUME DISTRIBUTION ───
  console.log('='.repeat(80));
  console.log('1. RELATIVE VOLUME DISTRIBUTION');
  console.log('='.repeat(80));

  // Compute 90-day trailing average for each hour boundary
  const rvolBuckets = {
    '<0.7x': 0, '0.7-0.9x': 0, '0.9-1.1x': 0,
    '1.1-1.3x': 0, '1.3-1.5x': 0, '1.5-2.0x': 0, '>2.0x': 0
  };
  const rvolByHour = {};
  for (const label of HOUR_LABELS) {
    rvolByHour[label] = { '<0.7x': 0, '0.7-0.9x': 0, '0.9-1.1x': 0,
      '1.1-1.3x': 0, '1.3-1.5x': 0, '1.5-2.0x': 0, '>2.0x': 0, total: 0 };
  }

  let rvolSampleCount = 0;
  const allEndOfDayRvols = [];

  for (let i = 90; i < days.length; i++) {
    const day = days[i];

    for (let h = 0; h < HOUR_BOUNDARIES.length; h++) {
      const boundary = HOUR_BOUNDARIES[h];
      const label = HOUR_LABELS[h];
      const cumVol = day.hourlyVolume[boundary] || 0;
      if (cumVol === 0) continue;

      // 90-day trailing average for this boundary
      let trailSum = 0, trailCount = 0;
      for (let j = i - 90; j < i; j++) {
        const vol = days[j]?.hourlyVolume?.[boundary] || 0;
        if (vol > 0) { trailSum += vol; trailCount++; }
      }
      if (trailCount < 20) continue;

      const avg = trailSum / trailCount;
      const rvol = cumVol / avg;

      let bucket;
      if (rvol < 0.7) bucket = '<0.7x';
      else if (rvol < 0.9) bucket = '0.7-0.9x';
      else if (rvol < 1.1) bucket = '0.9-1.1x';
      else if (rvol < 1.3) bucket = '1.1-1.3x';
      else if (rvol < 1.5) bucket = '1.3-1.5x';
      else if (rvol < 2.0) bucket = '1.5-2.0x';
      else bucket = '>2.0x';

      rvolBuckets[bucket]++;
      rvolByHour[label][bucket]++;
      rvolByHour[label].total++;
      rvolSampleCount++;

      // Track end-of-day RVol
      if (boundary === 960) {
        allEndOfDayRvols.push({ date: day.date, rvol });
      }
    }
  }

  console.log('\nOverall RVol Distribution (all hours combined):');
  console.log(`  Sample size: ${rvolSampleCount} measurements\n`);
  for (const [bucket, count] of Object.entries(rvolBuckets)) {
    const pct = ((count / rvolSampleCount) * 100).toFixed(1);
    const bar = '#'.repeat(Math.round(pct));
    console.log(`  ${bucket.padEnd(10)} ${String(count).padStart(5)}  (${pct}%)  ${bar}`);
  }

  console.log('\nRVol Distribution by Hour:');
  for (const label of HOUR_LABELS) {
    const data = rvolByHour[label];
    if (data.total === 0) continue;
    console.log(`\n  ${label} (n=${data.total}):`);
    for (const bucket of Object.keys(rvolBuckets)) {
      const pct = ((data[bucket] / data.total) * 100).toFixed(1);
      console.log(`    ${bucket.padEnd(10)} ${String(data[bucket]).padStart(4)}  (${pct}%)`);
    }
  }

  // End-of-day RVol stats
  if (allEndOfDayRvols.length > 0) {
    const sorted = allEndOfDayRvols.map(r => r.rvol).sort((a, b) => a - b);
    const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
    const std = Math.sqrt(variance);
    const p10 = sorted[Math.floor(sorted.length * 0.10)];
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p50 = sorted[Math.floor(sorted.length * 0.50)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const p90 = sorted[Math.floor(sorted.length * 0.90)];

    console.log(`\n\nEnd-of-Day RVol Statistics (n=${allEndOfDayRvols.length}):`);
    console.log(`  Mean:   ${mean.toFixed(3)}`);
    console.log(`  StdDev: ${std.toFixed(3)}`);
    console.log(`  P10:    ${p10.toFixed(3)}`);
    console.log(`  P25:    ${p25.toFixed(3)}`);
    console.log(`  Median: ${p50.toFixed(3)}`);
    console.log(`  P75:    ${p75.toFixed(3)}`);
    console.log(`  P90:    ${p90.toFixed(3)}`);
    console.log(`  Min:    ${sorted[0].toFixed(3)}`);
    console.log(`  Max:    ${sorted[sorted.length - 1].toFixed(3)}`);
  }

  // ─── SECTION 2: EXTREME VOLUME DAYS ───
  console.log('\n\n' + '='.repeat(80));
  console.log('2. EXTREME VOLUME DAYS (RVol >= 1.5x at any hour)');
  console.log('='.repeat(80));

  const extremeDays = [];
  for (let i = 90; i < days.length; i++) {
    const day = days[i];
    let maxRvol = 0;
    let maxRvolHour = '';

    for (let h = 0; h < HOUR_BOUNDARIES.length; h++) {
      const boundary = HOUR_BOUNDARIES[h];
      const cumVol = day.hourlyVolume[boundary] || 0;
      if (cumVol === 0) continue;

      let trailSum = 0, trailCount = 0;
      for (let j = i - 90; j < i; j++) {
        const vol = days[j]?.hourlyVolume?.[boundary] || 0;
        if (vol > 0) { trailSum += vol; trailCount++; }
      }
      if (trailCount < 20) continue;

      const avg = trailSum / trailCount;
      const rvol = cumVol / avg;
      if (rvol > maxRvol) {
        maxRvol = rvol;
        maxRvolHour = HOUR_LABELS[h];
      }
    }

    if (maxRvol >= 1.5) {
      const range = day.dayHigh - day.dayLow;
      const direction = day.dayClose > day.dayOpen ? 'UP' : day.dayClose < day.dayOpen ? 'DOWN' : 'FLAT';
      const bodyPct = Math.abs(day.dayClose - day.dayOpen) / range * 100;
      const dayType = bodyPct > 50 ? 'TREND' : 'BALANCE';

      extremeDays.push({
        date: day.date,
        maxRvol: maxRvol.toFixed(2),
        peakHour: maxRvolHour,
        range: range.toFixed(2),
        direction,
        dayType,
        open: day.dayOpen.toFixed(2),
        close: day.dayClose.toFixed(2),
        totalVol: day.totalVolume,
      });
    }
  }

  console.log(`\nDays with RVol >= 1.5x: ${extremeDays.length}\n`);
  console.log('Date       | MaxRVol | Peak   | Range   | Dir  | Type    | Volume');
  console.log('-'.repeat(80));
  for (const d of extremeDays) {
    console.log(`${d.date} | ${d.maxRvol.padStart(6)}x | ${d.peakHour.padEnd(6)} | ${d.range.padStart(7)} | ${d.direction.padEnd(4)} | ${d.dayType.padEnd(7)} | ${d.totalVol.toLocaleString()}`);
  }

  // Stats on extreme days
  if (extremeDays.length > 0) {
    const upDays = extremeDays.filter(d => d.direction === 'UP').length;
    const downDays = extremeDays.filter(d => d.direction === 'DOWN').length;
    const trendDays = extremeDays.filter(d => d.dayType === 'TREND').length;
    console.log(`\nExtreme day breakdown:`);
    console.log(`  UP: ${upDays} (${(upDays / extremeDays.length * 100).toFixed(1)}%)`);
    console.log(`  DOWN: ${downDays} (${(downDays / extremeDays.length * 100).toFixed(1)}%)`);
    console.log(`  TREND: ${trendDays} (${(trendDays / extremeDays.length * 100).toFixed(1)}%)`);
    console.log(`  BALANCE: ${extremeDays.length - trendDays} (${((extremeDays.length - trendDays) / extremeDays.length * 100).toFixed(1)}%)`);
  }

  // ─── SECTION 3: CUMULATIVE DELTA DISTRIBUTION ───
  console.log('\n\n' + '='.repeat(80));
  console.log('3. CUMULATIVE DELTA DISTRIBUTION');
  console.log('='.repeat(80));

  // Check if we have real bid/ask data
  const hasBidAsk = days.some(d => d.bars.some(b => b.ask_vol > 0 || b.bid_vol > 0));
  console.log(`\nDelta source: ${hasBidAsk ? 'Actual bid/ask volume (order flow)' : 'Estimated (close vs open)'}`);

  const allDeltas = days.filter((_, i) => i >= 90).map(d => d.totalDelta);
  const deltaMean = allDeltas.reduce((s, v) => s + v, 0) / allDeltas.length;
  const deltaVariance = allDeltas.reduce((s, v) => s + (v - deltaMean) ** 2, 0) / allDeltas.length;
  const deltaStd = Math.sqrt(deltaVariance);
  const deltaSorted = [...allDeltas].sort((a, b) => a - b);

  console.log(`\nEnd-of-Day CumDelta Statistics (n=${allDeltas.length}):`);
  console.log(`  Mean:    ${Math.round(deltaMean).toLocaleString()}`);
  console.log(`  StdDev:  ${Math.round(deltaStd).toLocaleString()}`);
  console.log(`  1-sigma: +/-${Math.round(deltaStd).toLocaleString()} (range: ${Math.round(deltaMean - deltaStd).toLocaleString()} to ${Math.round(deltaMean + deltaStd).toLocaleString()})`);
  console.log(`  2-sigma: +/-${Math.round(2 * deltaStd).toLocaleString()} (range: ${Math.round(deltaMean - 2 * deltaStd).toLocaleString()} to ${Math.round(deltaMean + 2 * deltaStd).toLocaleString()})`);
  console.log(`  P5:      ${Math.round(deltaSorted[Math.floor(deltaSorted.length * 0.05)]).toLocaleString()}`);
  console.log(`  P10:     ${Math.round(deltaSorted[Math.floor(deltaSorted.length * 0.10)]).toLocaleString()}`);
  console.log(`  P25:     ${Math.round(deltaSorted[Math.floor(deltaSorted.length * 0.25)]).toLocaleString()}`);
  console.log(`  Median:  ${Math.round(deltaSorted[Math.floor(deltaSorted.length * 0.50)]).toLocaleString()}`);
  console.log(`  P75:     ${Math.round(deltaSorted[Math.floor(deltaSorted.length * 0.75)]).toLocaleString()}`);
  console.log(`  P90:     ${Math.round(deltaSorted[Math.floor(deltaSorted.length * 0.90)]).toLocaleString()}`);
  console.log(`  P95:     ${Math.round(deltaSorted[Math.floor(deltaSorted.length * 0.95)]).toLocaleString()}`);
  console.log(`  Min:     ${Math.round(deltaSorted[0]).toLocaleString()}`);
  console.log(`  Max:     ${Math.round(deltaSorted[deltaSorted.length - 1]).toLocaleString()}`);

  // Delta distribution buckets
  const deltaBuckets = [
    { label: '< -2sigma', test: d => d < deltaMean - 2 * deltaStd },
    { label: '-2s to -1s', test: d => d >= deltaMean - 2 * deltaStd && d < deltaMean - deltaStd },
    { label: '-1s to 0', test: d => d >= deltaMean - deltaStd && d < 0 },
    { label: '0 to +1s', test: d => d >= 0 && d < deltaMean + deltaStd },
    { label: '+1s to +2s', test: d => d >= deltaMean + deltaStd && d < deltaMean + 2 * deltaStd },
    { label: '> +2sigma', test: d => d >= deltaMean + 2 * deltaStd },
  ];

  console.log('\nDelta Distribution (sigma-based):');
  for (const bucket of deltaBuckets) {
    const count = allDeltas.filter(bucket.test).length;
    const pct = (count / allDeltas.length * 100).toFixed(1);
    console.log(`  ${bucket.label.padEnd(12)} ${String(count).padStart(4)}  (${pct}%)`);
  }

  // Fixed-threshold distribution
  const fixedBuckets = [
    { label: '< -20K', min: -Infinity, max: -20000 },
    { label: '-20K to -10K', min: -20000, max: -10000 },
    { label: '-10K to -5K', min: -10000, max: -5000 },
    { label: '-5K to 0', min: -5000, max: 0 },
    { label: '0 to 5K', min: 0, max: 5000 },
    { label: '5K to 10K', min: 5000, max: 10000 },
    { label: '10K to 20K', min: 10000, max: 20000 },
    { label: '> 20K', min: 20000, max: Infinity },
  ];

  console.log('\nDelta Distribution (fixed thresholds):');
  for (const b of fixedBuckets) {
    const count = allDeltas.filter(d => d >= b.min && d < b.max).length;
    const pct = (count / allDeltas.length * 100).toFixed(1);
    const bar = '#'.repeat(Math.round(pct));
    console.log(`  ${b.label.padEnd(14)} ${String(count).padStart(4)}  (${pct}%)  ${bar}`);
  }

  // Delta-Price Divergence
  console.log('\nDelta-Price Divergences (positive delta + down day, or negative delta + up day):');
  const divergences = [];
  const daysAfter90 = days.filter((_, i) => i >= 90);

  for (let i = 0; i < daysAfter90.length - 1; i++) {
    const day = daysAfter90[i];
    const nextDay = daysAfter90[i + 1];
    const priceDir = day.dayClose > day.dayOpen ? 'UP' : 'DOWN';
    const deltaDir = day.totalDelta > 0 ? 'POSITIVE' : 'NEGATIVE';

    if ((priceDir === 'UP' && deltaDir === 'NEGATIVE') || (priceDir === 'DOWN' && deltaDir === 'POSITIVE')) {
      const nextDir = nextDay.dayClose > nextDay.dayOpen ? 'UP' : 'DOWN';
      const nextChange = ((nextDay.dayClose - nextDay.dayOpen) / nextDay.dayOpen * 100);
      divergences.push({
        date: day.date,
        priceDir,
        deltaDir,
        delta: day.totalDelta,
        nextDate: nextDay.date,
        nextDir,
        nextChange,
      });
    }
  }

  console.log(`  Total divergence days: ${divergences.length} / ${daysAfter90.length} (${(divergences.length / daysAfter90.length * 100).toFixed(1)}%)\n`);

  // Positive delta + down day
  const posDeltaDownPrice = divergences.filter(d => d.deltaDir === 'POSITIVE' && d.priceDir === 'DOWN');
  const nextDayUpAfterPosDelta = posDeltaDownPrice.filter(d => d.nextDir === 'UP').length;
  console.log(`  Positive delta + DOWN day (bullish divergence): ${posDeltaDownPrice.length} days`);
  console.log(`    Next day UP:   ${nextDayUpAfterPosDelta} (${(nextDayUpAfterPosDelta / posDeltaDownPrice.length * 100).toFixed(1)}%)`);
  console.log(`    Next day DOWN: ${posDeltaDownPrice.length - nextDayUpAfterPosDelta} (${((posDeltaDownPrice.length - nextDayUpAfterPosDelta) / posDeltaDownPrice.length * 100).toFixed(1)}%)`);

  // Negative delta + up day
  const negDeltaUpPrice = divergences.filter(d => d.deltaDir === 'NEGATIVE' && d.priceDir === 'UP');
  const nextDayDownAfterNegDelta = negDeltaUpPrice.filter(d => d.nextDir === 'DOWN').length;
  console.log(`\n  Negative delta + UP day (bearish divergence): ${negDeltaUpPrice.length} days`);
  console.log(`    Next day DOWN: ${nextDayDownAfterNegDelta} (${(nextDayDownAfterNegDelta / negDeltaUpPrice.length * 100).toFixed(1)}%)`);
  console.log(`    Next day UP:   ${negDeltaUpPrice.length - nextDayDownAfterNegDelta} (${((negDeltaUpPrice.length - nextDayDownAfterNegDelta) / negDeltaUpPrice.length * 100).toFixed(1)}%)`);

  // Avg next-day move
  const avgNextAfterBullDiv = posDeltaDownPrice.reduce((s, d) => s + d.nextChange, 0) / posDeltaDownPrice.length;
  const avgNextAfterBearDiv = negDeltaUpPrice.reduce((s, d) => s + d.nextChange, 0) / negDeltaUpPrice.length;
  console.log(`\n  Avg next-day move after bullish divergence: ${avgNextAfterBullDiv >= 0 ? '+' : ''}${avgNextAfterBullDiv.toFixed(3)}%`);
  console.log(`  Avg next-day move after bearish divergence: ${avgNextAfterBearDiv >= 0 ? '+' : ''}${avgNextAfterBearDiv.toFixed(3)}%`);

  // ─── SECTION 4: BUY/SELL RATIO ───
  console.log('\n\n' + '='.repeat(80));
  console.log('4. BUY/SELL VOLUME RATIO DISTRIBUTION');
  console.log('='.repeat(80));

  const ratios = daysAfter90.map(d => {
    if (d.totalSellVol === 0) return { date: d.date, ratio: 99 };
    return { date: d.date, ratio: d.totalBuyVol / d.totalSellVol };
  });

  const ratioValues = ratios.map(r => r.ratio).sort((a, b) => a - b);
  const ratioMean = ratioValues.reduce((s, v) => s + v, 0) / ratioValues.length;
  const ratioVariance = ratioValues.reduce((s, v) => s + (v - ratioMean) ** 2, 0) / ratioValues.length;
  const ratioStd = Math.sqrt(ratioVariance);

  console.log(`\nBuy/Sell Ratio Statistics (n=${ratioValues.length}):`);
  console.log(`  Mean:    ${ratioMean.toFixed(3)}`);
  console.log(`  StdDev:  ${ratioStd.toFixed(3)}`);
  console.log(`  P5:      ${ratioValues[Math.floor(ratioValues.length * 0.05)].toFixed(3)}`);
  console.log(`  P10:     ${ratioValues[Math.floor(ratioValues.length * 0.10)].toFixed(3)}`);
  console.log(`  P25:     ${ratioValues[Math.floor(ratioValues.length * 0.25)].toFixed(3)}`);
  console.log(`  Median:  ${ratioValues[Math.floor(ratioValues.length * 0.50)].toFixed(3)}`);
  console.log(`  P75:     ${ratioValues[Math.floor(ratioValues.length * 0.75)].toFixed(3)}`);
  console.log(`  P90:     ${ratioValues[Math.floor(ratioValues.length * 0.90)].toFixed(3)}`);
  console.log(`  P95:     ${ratioValues[Math.floor(ratioValues.length * 0.95)].toFixed(3)}`);
  console.log(`  Min:     ${ratioValues[0].toFixed(3)}`);
  console.log(`  Max:     ${ratioValues[ratioValues.length - 1].toFixed(3)}`);

  const ratioBuckets = [
    { label: '< 0.85', min: 0, max: 0.85 },
    { label: '0.85 - 0.90', min: 0.85, max: 0.90 },
    { label: '0.90 - 0.95', min: 0.90, max: 0.95 },
    { label: '0.95 - 1.00', min: 0.95, max: 1.00 },
    { label: '1.00 - 1.05', min: 1.00, max: 1.05 },
    { label: '1.05 - 1.10', min: 1.05, max: 1.10 },
    { label: '1.10 - 1.15', min: 1.10, max: 1.15 },
    { label: '> 1.15', min: 1.15, max: Infinity },
  ];

  console.log('\nBuy/Sell Ratio Distribution:');
  for (const b of ratioBuckets) {
    const count = ratioValues.filter(r => r >= b.min && r < b.max).length;
    const pct = (count / ratioValues.length * 100).toFixed(1);
    const bar = '#'.repeat(Math.round(pct));
    console.log(`  ${b.label.padEnd(14)} ${String(count).padStart(4)}  (${pct}%)  ${bar}`);
  }

  // What does extreme ratio predict?
  console.log('\nExtreme Ratio Days & Next-Day Outcome:');
  for (const threshold of [0.90, 0.85, 1.10, 1.15]) {
    const isLow = threshold < 1.0;
    const filtered = [];
    for (let i = 0; i < ratios.length - 1; i++) {
      const match = isLow ? ratios[i].ratio < threshold : ratios[i].ratio > threshold;
      if (match) {
        const nextDay = daysAfter90[i + 1];
        const nextPctChange = (nextDay.dayClose - nextDay.dayOpen) / nextDay.dayOpen * 100;
        filtered.push({ date: ratios[i].date, ratio: ratios[i].ratio, nextPctChange });
      }
    }
    if (filtered.length > 0) {
      const avgNext = filtered.reduce((s, d) => s + d.nextPctChange, 0) / filtered.length;
      const nextUpPct = (filtered.filter(d => d.nextPctChange > 0).length / filtered.length * 100).toFixed(1);
      console.log(`  Ratio ${isLow ? '<' : '>'} ${threshold}: ${filtered.length} days, next-day avg: ${avgNext >= 0 ? '+' : ''}${avgNext.toFixed(3)}%, next-day UP: ${nextUpPct}%`);
    }
  }

  // ─── SECTION 5: LAST-HOUR DELTA TREND ───
  console.log('\n\n' + '='.repeat(80));
  console.log('5. LAST-HOUR DELTA SHIFT & NEXT-DAY PREDICTION');
  console.log('='.repeat(80));

  // Compute last-hour delta (3 PM to close) vs session delta pace
  const lastHourData = [];
  for (let i = 0; i < daysAfter90.length - 1; i++) {
    const day = daysAfter90[i];
    const nextDay = daysAfter90[i + 1];

    // Session delta up to 3 PM
    const deltaTo3PM = day.hourlyDelta[900] || 0;
    // Full session delta
    const fullDelta = day.totalDelta;
    // Last-hour delta
    const lastHourDelta = fullDelta - deltaTo3PM;

    // Session hours: 9:30 to 3:00 = 5.5 hours, last hour = 1 hour
    // Hourly pace = deltaTo3PM / 5.5
    const sessionPace = deltaTo3PM / 5.5;
    // Is last hour significantly different from pace?
    const lastHourDeviation = lastHourDelta - sessionPace;

    const nextDayChange = (nextDay.dayClose - nextDay.dayOpen) / nextDay.dayOpen * 100;
    const nextDayDir = nextDay.dayClose > nextDay.dayOpen ? 'UP' : 'DOWN';

    lastHourData.push({
      date: day.date,
      sessionPace,
      lastHourDelta,
      lastHourDeviation,
      nextDayChange,
      nextDayDir,
    });
  }

  // Compute sigma for last-hour deviation
  const devValues = lastHourData.map(d => d.lastHourDeviation);
  const devMean = devValues.reduce((s, v) => s + v, 0) / devValues.length;
  const devStd = Math.sqrt(devValues.reduce((s, v) => s + (v - devMean) ** 2, 0) / devValues.length);

  console.log(`\nLast-Hour Delta Deviation from Session Pace (n=${lastHourData.length}):`);
  console.log(`  Mean deviation: ${Math.round(devMean).toLocaleString()}`);
  console.log(`  StdDev:         ${Math.round(devStd).toLocaleString()}`);

  // Buckets: strong bullish shift (>1.5sigma), moderate bullish (0.5-1.5), neutral, moderate bearish, strong bearish
  const shiftBuckets = [
    { label: 'Strong Sell Shift (< -1.5s)', test: d => d.lastHourDeviation < devMean - 1.5 * devStd },
    { label: 'Moderate Sell Shift (-0.5s to -1.5s)', test: d => d.lastHourDeviation >= devMean - 1.5 * devStd && d.lastHourDeviation < devMean - 0.5 * devStd },
    { label: 'Neutral (-0.5s to +0.5s)', test: d => d.lastHourDeviation >= devMean - 0.5 * devStd && d.lastHourDeviation < devMean + 0.5 * devStd },
    { label: 'Moderate Buy Shift (+0.5s to +1.5s)', test: d => d.lastHourDeviation >= devMean + 0.5 * devStd && d.lastHourDeviation < devMean + 1.5 * devStd },
    { label: 'Strong Buy Shift (> +1.5s)', test: d => d.lastHourDeviation >= devMean + 1.5 * devStd },
  ];

  console.log('\nLast-Hour Shift → Next-Day Outcome:');
  for (const bucket of shiftBuckets) {
    const matching = lastHourData.filter(bucket.test);
    if (matching.length < 3) continue;
    const nextUp = matching.filter(d => d.nextDayDir === 'UP').length;
    const avgNext = matching.reduce((s, d) => s + d.nextDayChange, 0) / matching.length;
    console.log(`\n  ${bucket.label}: ${matching.length} days`);
    console.log(`    Next day UP:   ${nextUp} (${(nextUp / matching.length * 100).toFixed(1)}%)`);
    console.log(`    Next day DOWN: ${matching.length - nextUp} (${((matching.length - nextUp) / matching.length * 100).toFixed(1)}%)`);
    console.log(`    Avg next move: ${avgNext >= 0 ? '+' : ''}${avgNext.toFixed(3)}%`);
  }

  // Also test: raw last-hour delta direction
  console.log('\nRaw Last-Hour Delta Direction → Next-Day:');
  const strongBuyLastHr = lastHourData.filter(d => d.lastHourDelta > 2000);
  const strongSellLastHr = lastHourData.filter(d => d.lastHourDelta < -2000);
  for (const [label, group] of [['Last-hour delta > +2K', strongBuyLastHr], ['Last-hour delta < -2K', strongSellLastHr]]) {
    if (group.length > 0) {
      const nextUp = group.filter(d => d.nextDayDir === 'UP').length;
      const avgNext = group.reduce((s, d) => s + d.nextDayChange, 0) / group.length;
      console.log(`\n  ${label}: ${group.length} days`);
      console.log(`    Next day UP:   ${nextUp} (${(nextUp / group.length * 100).toFixed(1)}%)`);
      console.log(`    Avg next move: ${avgNext >= 0 ? '+' : ''}${avgNext.toFixed(3)}%`);
    }
  }

  // ─── SECTION 6: PRACTICAL THRESHOLDS ───
  console.log('\n\n' + '='.repeat(80));
  console.log('6. PRACTICAL THRESHOLD RECOMMENDATIONS');
  console.log('='.repeat(80));

  // RVol thresholds
  console.log('\n--- RELATIVE VOLUME ---');
  if (allEndOfDayRvols.length > 0) {
    const rvSorted = allEndOfDayRvols.map(r => r.rvol).sort((a, b) => a - b);
    const rvMean = rvSorted.reduce((s, v) => s + v, 0) / rvSorted.length;
    const rvStd = Math.sqrt(rvSorted.reduce((s, v) => s + (v - rvMean) ** 2, 0) / rvSorted.length);

    console.log(`\n  Current thresholds vs data:`);
    console.log(`    < 0.7x (low):    ${allEndOfDayRvols.filter(r => r.rvol < 0.7).length} days (${(allEndOfDayRvols.filter(r => r.rvol < 0.7).length / allEndOfDayRvols.length * 100).toFixed(1)}%)`);
    console.log(`    0.7x - 1.2x:     ${allEndOfDayRvols.filter(r => r.rvol >= 0.7 && r.rvol < 1.2).length} days (${(allEndOfDayRvols.filter(r => r.rvol >= 0.7 && r.rvol < 1.2).length / allEndOfDayRvols.length * 100).toFixed(1)}%) - current "normal"`);
    console.log(`    >= 1.2x (elev):  ${allEndOfDayRvols.filter(r => r.rvol >= 1.2).length} days (${(allEndOfDayRvols.filter(r => r.rvol >= 1.2).length / allEndOfDayRvols.length * 100).toFixed(1)}%)`);
    console.log(`    >= 1.5x (high):  ${allEndOfDayRvols.filter(r => r.rvol >= 1.5).length} days (${(allEndOfDayRvols.filter(r => r.rvol >= 1.5).length / allEndOfDayRvols.length * 100).toFixed(1)}%)`);

    // Suggested
    const p15 = rvSorted[Math.floor(rvSorted.length * 0.15)];
    const p80 = rvSorted[Math.floor(rvSorted.length * 0.80)];
    const p90 = rvSorted[Math.floor(rvSorted.length * 0.90)];
    const p95 = rvSorted[Math.floor(rvSorted.length * 0.95)];

    console.log(`\n  Data-driven percentiles:`);
    console.log(`    P15 (low threshold):  ${p15.toFixed(2)}x`);
    console.log(`    P80 (elevated):       ${p80.toFixed(2)}x`);
    console.log(`    P90 (high):           ${p90.toFixed(2)}x`);
    console.log(`    P95 (extreme):        ${p95.toFixed(2)}x`);

    console.log(`\n  RECOMMENDATION:`);
    console.log(`    Low:      < ${Math.round(p15 * 100) / 100}x (P15) ${p15 < 0.75 ? '-- current 0.7x is close, OK' : `-- adjust from 0.7x to ${p15.toFixed(1)}x`}`);
    console.log(`    Elevated: >= ${p80.toFixed(1)}x (P80) ${Math.abs(p80 - 1.2) < 0.15 ? '-- current 1.2x is close, OK' : `-- adjust from 1.2x to ${p80.toFixed(1)}x`}`);
    console.log(`    High:     >= ${p90.toFixed(1)}x (P90) ${Math.abs(p90 - 1.5) < 0.15 ? '-- current 1.5x is close, OK' : `-- adjust from 1.5x to ${p90.toFixed(1)}x`}`);
  }

  // CumDelta thresholds
  console.log('\n--- CUMULATIVE DELTA ---');
  const absDeltaSorted = allDeltas.map(d => Math.abs(d)).sort((a, b) => a - b);
  const deltaP50 = deltaSorted[Math.floor(deltaSorted.length * 0.50)];
  const deltaP25 = deltaSorted[Math.floor(deltaSorted.length * 0.25)];
  const deltaP75 = deltaSorted[Math.floor(deltaSorted.length * 0.75)];
  const absDeltaP50 = absDeltaSorted[Math.floor(absDeltaSorted.length * 0.50)];
  const absDeltaP75 = absDeltaSorted[Math.floor(absDeltaSorted.length * 0.75)];
  const absDeltaP90 = absDeltaSorted[Math.floor(absDeltaSorted.length * 0.90)];

  console.log(`\n  Current thresholds: > 5K = buying (green), < -5K = selling (red)`);
  console.log(`    Days with delta > +5K:  ${allDeltas.filter(d => d > 5000).length} (${(allDeltas.filter(d => d > 5000).length / allDeltas.length * 100).toFixed(1)}%)`);
  console.log(`    Days with delta < -5K:  ${allDeltas.filter(d => d < -5000).length} (${(allDeltas.filter(d => d < -5000).length / allDeltas.length * 100).toFixed(1)}%)`);
  console.log(`    Days in neutral [-5K,+5K]: ${allDeltas.filter(d => d >= -5000 && d <= 5000).length} (${(allDeltas.filter(d => d >= -5000 && d <= 5000).length / allDeltas.length * 100).toFixed(1)}%)`);

  console.log(`\n  Data-driven thresholds (based on signed delta):`);
  console.log(`    P25 (sell threshold): ${Math.round(deltaP25).toLocaleString()}`);
  console.log(`    Median:               ${Math.round(deltaP50).toLocaleString()}`);
  console.log(`    P75 (buy threshold):  ${Math.round(deltaP75).toLocaleString()}`);
  console.log(`\n  Data-driven thresholds (absolute value):`);
  console.log(`    |delta| P50 (half of days exceed): ${Math.round(absDeltaP50).toLocaleString()}`);
  console.log(`    |delta| P75 (notable):             ${Math.round(absDeltaP75).toLocaleString()}`);
  console.log(`    |delta| P90 (extreme):             ${Math.round(absDeltaP90).toLocaleString()}`);
  console.log(`    1-sigma:                           ${Math.round(deltaStd).toLocaleString()}`);

  console.log(`\n  RECOMMENDATION:`);
  const suggestedDelta = Math.round(Math.abs(deltaP75) / 1000) * 1000;
  const suggestedDeltaExtreme = Math.round(absDeltaP90 / 1000) * 1000;
  console.log(`    Moderate buy/sell: +/-${suggestedDelta.toLocaleString()} (P75 magnitude)`);
  console.log(`    Strong buy/sell:   +/-${suggestedDeltaExtreme.toLocaleString()} (P90 magnitude)`);
  console.log(`    Current 5K threshold captures ${(allDeltas.filter(d => Math.abs(d) > 5000).length / allDeltas.length * 100).toFixed(1)}% of days as "directional" -- ${Math.abs(5000 - suggestedDelta) < 3000 ? 'reasonable' : 'needs adjustment'}`);

  // Buy/Sell ratio thresholds
  console.log('\n--- BUY/SELL RATIO ---');
  console.log(`\n  Data-driven thresholds:`);
  console.log(`    P10 (strong selling): ${ratioValues[Math.floor(ratioValues.length * 0.10)].toFixed(3)}`);
  console.log(`    P25 (selling):        ${ratioValues[Math.floor(ratioValues.length * 0.25)].toFixed(3)}`);
  console.log(`    Median:               ${ratioValues[Math.floor(ratioValues.length * 0.50)].toFixed(3)}`);
  console.log(`    P75 (buying):         ${ratioValues[Math.floor(ratioValues.length * 0.75)].toFixed(3)}`);
  console.log(`    P90 (strong buying):  ${ratioValues[Math.floor(ratioValues.length * 0.90)].toFixed(3)}`);

  console.log('\n' + '='.repeat(80));
  console.log('END OF REPORT');
  console.log('='.repeat(80));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
