import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

async function main() {
  console.log('=== NQ RECENT LOOKBACK WINDOW COMPARISON (30, 60, 90 vs. All-Time) ===');
  
  // Fetch NQ RTH bars
  const barsQ = await query(`
    SELECT DISTINCT ON (ts)
      ts::date::text as trade_date,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float, volume::float
    FROM price_bars
    WHERE symbol='NQ'
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts, id DESC
  `);

  const sessions = {};
  for (const bar of barsQ.rows) {
    if (!sessions[bar.trade_date]) sessions[bar.trade_date] = [];
    sessions[bar.trade_date].push(bar);
  }

  const sortedDates = Object.keys(sessions).sort();
  const sessionData = [];

  for (const date of sortedDates) {
    const bars = sessions[date].sort((a, b) => a.et_min - b.et_min);
    if (bars.length < 300) continue;

    const open = bars[0].open;
    const close = bars[bars.length - 1].close;
    const high = Math.max(...bars.map(b => b.high));
    const low = Math.min(...bars.map(b => b.low));
    const range = high - low;

    // OR5 Range
    const or5Bars = bars.filter(b => b.et_min >= 570 && b.et_min <= 574);
    const or5High = or5Bars.length ? Math.max(...or5Bars.map(b => b.high)) : null;
    const or5Low = or5Bars.length ? Math.min(...or5Bars.map(b => b.low)) : null;
    const or5Range = (or5High && or5Low) ? or5High - or5Low : null;

    // OR30 Range
    const or30Bars = bars.filter(b => b.et_min >= 570 && b.et_min <= 599);
    const or30High = or30Bars.length ? Math.max(...or30Bars.map(b => b.high)) : null;
    const or30Low = or30Bars.length ? Math.min(...or30Bars.map(b => b.low)) : null;
    const or30Range = (or30High && or30Low) ? or30High - or30Low : null;

    const highBar = bars.find(b => b.high === high);
    const lowBar = bars.find(b => b.low === low);
    const highTime = highBar ? highBar.et_min : null;
    const lowTime = lowBar ? lowBar.et_min : null;

    const morningBars = bars.filter(b => b.et_min >= 570 && b.et_min < 720);
    const morningHigh = morningBars.length ? Math.max(...morningBars.map(b => b.high)) : null;
    const morningLow = morningBars.length ? Math.min(...morningBars.map(b => b.low)) : null;

    sessionData.push({
      date, open, close, high, low, range,
      or5Range, or30High, or30Low, or30Range,
      morningHigh, morningLow, highTime, lowTime
    });
  }

  const windows = [30, 60, 90, sessionData.length];

  console.log(`\nComparison across last 30, 60, 90 sessions vs. All-Time (${sessionData.length} sessions):\n`);

  // Fixed all-time thresholds for OR5
  const Q1_LIMIT = 47.5;
  const Q4_LIMIT = 91.5;

  for (const w of windows) {
    const subset = sessionData.slice(-w);
    const label = w === sessionData.length ? `All-Time (${w}d)` : `Last ${w}d`;

    // 1. Gaps
    let gapUps = 0, gapUpsFilled = 0;
    let gapDowns = 0, gapDownsFilled = 0;
    let insideOpens = 0, sweepHighRejections = 0, sweepLowRejections = 0;

    for (let i = 1; i < subset.length; i++) {
      const prev = subset[i - 1];
      const curr = subset[i];
      if (curr.open > prev.high) {
        gapUps++;
        if (curr.low <= prev.high) gapUpsFilled++;
      } else if (curr.open < prev.low) {
        gapDowns++;
        if (curr.high >= prev.low) gapDownsFilled++;
      } else {
        insideOpens++;
        if (curr.morningHigh > prev.high && curr.close < prev.high) sweepHighRejections++;
        if (curr.morningLow < prev.low && curr.close > prev.low) sweepLowRejections++;
      }
    }

    const gapUpFillPct = gapUps > 0 ? (gapUpsFilled / gapUps * 100).toFixed(1) : 'n/a';
    const gapDownFillPct = gapDowns > 0 ? (gapDownsFilled / gapDowns * 100).toFixed(1) : 'n/a';
    const sweepPct = insideOpens > 0 ? ((sweepHighRejections + sweepLowRejections) / insideOpens * 100).toFixed(1) : 'n/a';

    // 2. 10:00 AM Reversal Window
    let pivotCount = 0;
    for (const s of subset) {
      const isHighInWindow = s.highTime >= 595 && s.highTime <= 605;
      const isLowInWindow = s.lowTime >= 595 && s.lowTime <= 605;
      if (isHighInWindow || isLowInWindow) pivotCount++;
    }
    const pivotPct = (pivotCount / subset.length * 100).toFixed(1);

    // 3. OR5 size behaviors (Tight vs Wide)
    const tightOR = subset.filter(s => s.or5Range != null && s.or5Range < Q1_LIMIT);
    const wideOR = subset.filter(s => s.or5Range != null && s.or5Range >= Q4_LIMIT);

    const tightBreakoutRun = tightOR.filter(s => {
      if (!s.or30Range) return false;
      return Math.max(s.high - s.or30High, s.or30Low - s.low) >= 2.5 * s.or30Range;
    });
    const tightTrendDays = tightOR.filter(s => (s.high - s.close < 0.15 * s.range || s.close - s.low < 0.15 * s.range) && s.range > 220);

    const wideBreakoutRun = wideOR.filter(s => {
      if (!s.or30Range) return false;
      return Math.max(s.high - s.or30High, s.or30Low - s.low) >= 2.5 * s.or30Range;
    });
    const wideTrendDays = wideOR.filter(s => (s.high - s.close < 0.15 * s.range || s.close - s.low < 0.15 * s.range) && s.range > 220);

    const tightRunPct = tightOR.length > 0 ? (tightBreakoutRun.length / tightOR.length * 100).toFixed(1) : 'n/a';
    const tightTrendPct = tightOR.length > 0 ? (tightTrendDays.length / tightOR.length * 100).toFixed(1) : 'n/a';
    const wideRunPct = wideOR.length > 0 ? (wideBreakoutRun.length / wideOR.length * 100).toFixed(1) : 'n/a';
    const wideTrendPct = wideOR.length > 0 ? (wideTrendDays.length / wideOR.length * 100).toFixed(1) : 'n/a';

    console.log(`--- ${label.toUpperCase()} ---`);
    console.log(`  Gaps Fill Rate:     Gap Up: ${gapUpFillPct}% (n=${gapUps}) | Gap Down: ${gapDownFillPct}% (n=${gapDowns})`);
    console.log(`  Inside Open Sweeps:  ${sweepPct}% failed sweep rate (n=${insideOpens} inside opens)`);
    console.log(`  10:00 AM Pivot:     ${pivotPct}% of sessions printed high/low in 9:55-10:05`);
    console.log(`  Tight OR (<47.5pt):  OR30 Breakout Follow-through: ${tightRunPct}% | Trend Day: ${tightTrendPct}% (n=${tightOR.length})`);
    console.log(`  Wide OR (>91.5pt):   OR30 Breakout Follow-through: ${wideRunPct}% | Trend Day: ${wideTrendPct}% (n=${wideOR.length})`);
    console.log('');
  }
}

main().catch(console.error);
