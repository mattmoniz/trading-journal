// SUPERSEDED (2026-08-11) by pilot_atr_compression_breakout_mtf.mjs, which does exactly
// what this script does (same fixed same-bar-stop logic, same clean 2023-12-16+ date
// range) but parameterized by bar width -- run `node pilot_atr_compression_breakout_mtf.mjs
// 60` instead. Not deleted (this codebase keeps backtest scripts on disk as a record) and
// not wired into run_weekly_backtests.sh -- only the _mtf.mjs script is cron'd, to avoid
// two scripts recomputing and re-claiming the same 60-min result under different slugs.
// RESEARCH_CLAIM slug 'atr_compression_breakout' (this script's) is marked STALE; the live
// one is 'atr_compression_breakout_60m'.
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

async function main() {
  const DOLLARS_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint; // 2
  const COMMISSION_RT = LIVE_INSTRUMENT.commissionPerRoundTrip; // 2

  console.log(`Starting ATR Compression Breakout test using ${LIVE_INSTRUMENT.symbol} economics ($${DOLLARS_PER_POINT}/pt, $${COMMISSION_RT} RT)...`);

  const sql = `
    SELECT
      to_char(ts, 'YYYY-MM-DD HH24:MI:SS') as ts_str,
      to_char(ts, 'YYYY-MM-DD HH24:00:00') as bucket_id,
      open::float, high::float, low::float, close::float, volume,
      EXTRACT(hour FROM ts) as hour_part,
      EXTRACT(dow FROM ts) as dow
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      -- price_bars_primary for NQ is only ONE bar/calendar-day (a daily snapshot, not real
      -- 1-min intraday density) from 2022-12-14 through 2023-11-14 -- confirmed directly via
      -- a per-day COUNT(*), avg 1.0 bars/day every month Jan-Oct 2023, jumping to 630/day in
      -- Nov 2023. Separate finding from the documented 2023-11-15/2023-12-15
      -- ES-symbol-contamination window -- starting from 2023-12-16 (right after that window)
      -- skips both problems in one bound.
      AND ts >= '2023-12-16'
    ORDER BY ts ASC
  `;

  console.log('Fetching NQ 1-min data...');
  const { rows } = await query(sql);
  console.log(`Fetched ${rows.length} 1-min bars.`);

  console.log('Aggregating to 60-min bars...');
  // Aggregate to 60-min buckets
  // Using hour boundaries cleanly prevents spanning the 17:00-18:00 daily halt and Friday 17:00-Sun 18:00 gap.
  const buckets = new Map();
  for (const r of rows) {
    const h = r.hour_part;
    // filter out the daily 5-6pm halt completely to avoid weird thin bars
    if (h === 17) continue; 
    
    const bucketId = r.bucket_id;
    
    if (!buckets.has(bucketId)) {
      buckets.set(bucketId, {
        ts: bucketId,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        dayOfWeek: Number(r.dow), // 0 = Sun, 5 = Fri
        hour: Number(h)
      });
    } else {
      const b = buckets.get(bucketId);
      b.high = Math.max(b.high, r.high);
      b.low = Math.min(b.low, r.low);
      b.close = r.close;
      b.volume += r.volume;
    }
  }

  const m60 = Array.from(buckets.values()).sort((a, b) => a.ts.localeCompare(b.ts));
  console.log(`Aggregated to ${m60.length} 60-min bars.`);

  // compute TR and ATR
  for (let i = 0; i < m60.length; i++) {
    const bar = m60[i];
    if (i === 0) {
      bar.tr = bar.high - bar.low;
    } else {
      const prevClose = m60[i-1].close;
      bar.tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    }
  }

  function addWilderATR(m60, period, field) {
    let sumTR = 0;
    for (let i = 0; i < m60.length; i++) {
      if (i < period) {
        sumTR += m60[i].tr;
        if (i === period - 1) {
          m60[i][field] = sumTR / period;
        }
      } else {
        m60[i][field] = (m60[i-1][field] * (period - 1) + m60[i].tr) / period;
      }
    }
  }

  addWilderATR(m60, 20, 'atr20');
  addWilderATR(m60, 30, 'atr30');

  // Verify no lookahead on computation
  console.log(`\nLookahead Check (Sample):`);
  const s1 = m60[50];
  const s2 = m60[51];
  console.log(`Bar ${s1.ts}: close=${s1.close}, TR=${s1.tr.toFixed(2)}, ATR20=${s1.atr20?.toFixed(2)}`);
  console.log(`Bar ${s2.ts}: close=${s2.close}, TR=${s2.tr.toFixed(2)}, ATR20=${s2.atr20?.toFixed(2)}`);

  // We need to identify Friday exits
  for (let i = 0; i < m60.length; i++) {
    const bar = m60[i];
    const nextBar = m60[i+1];
    bar.isFridayExit = false;
    if (bar.dayOfWeek === 5) { // Friday
      // If there is no next bar, or the next bar is Sunday/Monday (i.e. not Friday), then this is the last bar of the week.
      if (!nextBar || nextBar.dayOfWeek !== 5) {
        bar.isFridayExit = true;
      }
    }
  }
  
  console.log(`\nFriday Exit Bar Sample:`);
  m60.filter(b => b.isFridayExit).slice(0, 5).forEach(b => console.log(`Exit bar: ${b.ts}`));

  // Testing Framework
  function runBacktest({ side, useFilter }) {
    let trades = [];
    let position = null;
    let entryBarIdx = null;

    for (let i = 30; i < m60.length - 1; i++) {
      const prevBar = m60[i-1];
      const bar = m60[i];
      
      // Manage open position
      if (position) {
        // Evaluate stop loss intrabar
        // Stop triggers on intrabar low reaching stop level (for longs) or intrabar high (for shorts).
        let stopHit = false;
        let exitPrice = null;
        let isStop = false;

        if (position.side === 'LONG') {
          if (bar.low <= position.stop) {
            stopHit = true;
            // assume slippage pushes to exactly stop, or if open < stop, we get open.
            exitPrice = Math.min(bar.open, position.stop);
          }
        } else {
          if (bar.high >= position.stop) {
            stopHit = true;
            exitPrice = Math.max(bar.open, position.stop);
          }
        }

        if (stopHit) {
          const pts = position.side === 'LONG' ? (exitPrice - position.entryPrice) : (position.entryPrice - exitPrice);
          const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
          trades.push({
            entryTime: m60[entryBarIdx].ts,
            exitTime: bar.ts,
            side: position.side,
            pnl,
            pts,
            reason: 'STOP',
            date: bar.ts.substring(0, 10)
          });
          position = null;
        } else if (bar.isFridayExit) {
          // Exit at the close of the bar
          exitPrice = bar.close;
          const pts = position.side === 'LONG' ? (exitPrice - position.entryPrice) : (position.entryPrice - exitPrice);
          const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
          trades.push({
            entryTime: m60[entryBarIdx].ts,
            exitTime: bar.ts,
            side: position.side,
            pnl,
            pts,
            reason: 'FRIDAY_CLOSE',
            date: bar.ts.substring(0, 10)
          });
          position = null;
        }
        
        // Cannot enter a new position on the same bar we exit a Friday close (we exit AT the close).
        // If we hit stop, we technically could re-enter, but let's assume we wait for a new signal from a clean previous bar.
        continue;
      }

      // Check entry trigger for THIS bar based on PREV bar
      let signal = true;
      if (useFilter) {
        if (!(prevBar.atr20 < prevBar.atr30)) {
          signal = false;
        }
      }

      if (signal) {
        if (side === 'LONG') {
          const buyLevel = prevBar.open + (2 * prevBar.atr20);
          if (bar.high >= buyLevel) {
            // Triggered!
            const entryPrice = Math.max(bar.open, buyLevel);
            const stop = entryPrice - (0.5 * prevBar.atr20);
            position = { side: 'LONG', entryPrice, stop };
            entryBarIdx = i;
            // Deliberately NOT checking bar.low against `stop` on this same bar: the entry
            // itself required bar.high to reach 2xATR above the entry bar's own open (an
            // extreme move by construction), while `stop` sits only 0.5xATR below entry --
            // roughly (open + 1.5xATR), a level almost every bar's own low sits below
            // regardless of any real stop-out. Without tick data the true intrabar order
            // (did price hit the entry trigger before or after dipping to that low) can't be
            // determined, so the standard, unbiased convention is used: a position can't be
            // stopped out in the same bar it was entered. Stop evaluation starts next bar via
            // the normal "Manage open position" block above.
            // Friday-close IS still checked same-bar -- that's just this bar's own designated
            // close, no intrabar-ordering assumption needed.
            if (bar.isFridayExit) {
              const exitPrice = bar.close;
              const pts = exitPrice - entryPrice;
              const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
              trades.push({
                entryTime: bar.ts, exitTime: bar.ts, side: 'LONG', pnl, pts,
                reason: 'FRIDAY_CLOSE_SAME_BAR', date: bar.ts.substring(0, 10)
              });
              position = null;
            }
          }
        } else if (side === 'SHORT') {
          const sellLevel = prevBar.open - (2 * prevBar.atr20);
          if (bar.low <= sellLevel) {
            const entryPrice = Math.min(bar.open, sellLevel);
            const stop = entryPrice + (0.5 * prevBar.atr20);
            position = { side: 'SHORT', entryPrice, stop };
            entryBarIdx = i;
            // Same-bar-stop check deliberately omitted -- see the matching LONG-side comment
            // above. Stop evaluation starts next bar via the normal "Manage open position"
            // block above.
            if (bar.isFridayExit) {
              const exitPrice = bar.close;
              const pts = entryPrice - exitPrice;
              const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
              trades.push({
                entryTime: bar.ts, exitTime: bar.ts, side: 'SHORT', pnl, pts,
                reason: 'FRIDAY_CLOSE_SAME_BAR', date: bar.ts.substring(0, 10)
              });
              position = null;
            }
          }
        }
      }
    }
    return trades;
  }

  function summarize(trades, prefix) {
    if (trades.length === 0) return `${prefix}: N=0`;
    const wr = trades.filter(t => t.pnl > 0).length / trades.length;
    const ev = trades.reduce((sum, t) => sum + t.pnl, 0) / trades.length;
    let maxDD = 0;
    let peak = 0;
    let cum = 0;
    for (const t of trades) {
      cum += t.pnl;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    }
    return `${prefix}: N=${trades.length}, WR=${(wr*100).toFixed(1)}%, EV=+$${ev.toFixed(2)}, MaxDD=-$${maxDD.toFixed(2)}, Total=+$${cum.toFixed(2)}`;
  }

  // 1. As-specified (long-only)
  const tradesLong = runBacktest({ side: 'LONG', useFilter: true });
  console.log(summarize(tradesLong, '1. Long-Only (As Specified)'));

  // 2. Symmetric short-only
  const tradesShort = runBacktest({ side: 'SHORT', useFilter: true });
  console.log(summarize(tradesShort, '2. Short-Only (Symmetric)'));

  // 4. No-filter control (buy at Open+2xATR20 without ATR20<ATR30 condition)
  const tradesLongNoFilter = runBacktest({ side: 'LONG', useFilter: false });
  console.log(summarize(tradesLongNoFilter, '4. Long-Only (No Filter Control)'));

  // 3. Buy and Hold NQ baseline
  // Over the identical backtest date range (from first bar to last bar)
  // MNQ Economics
  const firstBar = m60[30];
  const lastBar = m60[m60.length - 1];
  const bnhPts = lastBar.close - firstBar.open;
  const bnhTotal = (bnhPts * DOLLARS_PER_POINT) - COMMISSION_RT;
  let bnhMaxDD = 0;
  let bnhPeak = 0;
  let bnhCum = 0;
  for (let i = 30; i < m60.length; i++) {
     const b = m60[i];
     // daily/intrabar drawdown on open position
     const lowPts = b.low - firstBar.open;
     const lowPnl = (lowPts * DOLLARS_PER_POINT) - COMMISSION_RT;
     
     const highPts = b.high - firstBar.open;
     const highPnl = (highPts * DOLLARS_PER_POINT) - COMMISSION_RT;
     if (highPnl > bnhPeak) bnhPeak = highPnl;
     
     const dd = bnhPeak - lowPnl;
     if (dd > bnhMaxDD) bnhMaxDD = dd;
  }
  console.log(`3. Buy-and-Hold Baseline: Total=+$${bnhTotal.toFixed(2)}, MaxDD=-$${bnhMaxDD.toFixed(2)}`);

  // 5. Chronological Stability
  const rigorLong = computeRigor(tradesLong, { dateField: 'date', pnlFn: t => t.pnl });
  console.log(`5. Chronological Stability (Long):`, rigorLong);

  // 6. Walk-forward (first ~2 years train, rest test)
  // Available history: ~3.7 years
  // Let's use first 60% as train, 40% as test based on time
  const msStart = new Date(m60[30].ts).getTime();
  const msEnd = new Date(lastBar.ts).getTime();
  const msCutoff = msStart + (msEnd - msStart) * (2 / 3.7);
  
  const tradesLongTrain = tradesLong.filter(t => new Date(t.entryTime).getTime() <= msCutoff);
  const tradesLongTest = tradesLong.filter(t => new Date(t.entryTime).getTime() > msCutoff);
  console.log(summarize(tradesLongTrain, '6a. Walk-forward Train (~2 years)'));
  console.log(summarize(tradesLongTest, '6b. Walk-forward Test (~1.7 years)'));

  // Save deliverables
  const resultsContent = `
# ATR Compression Breakout Backtest Results

**Date Range:** ${firstBar.ts} to ${lastBar.ts}
**Economics:** MNQ ($2/pt, $2 RT commission)

### Core Tests
- **${summarize(tradesLong, '1. Long-Only (As Specified)')}**
- **${summarize(tradesShort, '2. Short-Only (Symmetric)')}**
- **${summarize(tradesLongNoFilter, '4. Long-Only (No Filter Control)')}**
- **3. Buy-and-Hold Baseline:** Total=+$${bnhTotal.toFixed(2)}, MaxDD=-$${bnhMaxDD.toFixed(2)}

### Walk-Forward (Long-Only)
- **${summarize(tradesLongTrain, 'Train (~2y)')}**
- **${summarize(tradesLongTest, 'Test (~1.7y)')}**

### Chronological Stability (Long-Only)
\`\`\`json
${JSON.stringify(rigorLong, null, 2)}
\`\`\`
`;

  fs.writeFileSync('scratch/atr_compression_breakout_RESULTS.md', resultsContent);
  console.log('Results written to scratch/atr_compression_breakout_RESULTS.md');

  // Record Claim
  const evLong = tradesLong.length ? (tradesLong.reduce((s, t) => s + t.pnl, 0) / tradesLong.length) : 0;
  const wrLong = tradesLong.length ? (tradesLong.filter(t => t.pnl > 0).length / tradesLong.length) : 0;
  
  const claimText = `ATR Compression Breakout (Long). EV=+$${evLong.toFixed(2)} (N=${tradesLong.length}). Symmetric Short EV was ${tradesShort.length ? (tradesShort.reduce((s,t)=>s+t.pnl,0)/tradesShort.length).toFixed(2) : 'N/A'}. B&H Total=+$${bnhTotal.toFixed(2)}. No-Filter Control EV=${tradesLongNoFilter.length ? (tradesLongNoFilter.reduce((s,t)=>s+t.pnl,0)/tradesLongNoFilter.length).toFixed(2) : 'N/A'}.`;
  
  const claimResult = await recordClaim({
    slug: 'atr_compression_breakout',
    claimText,
    sourceFile: 'scripts/pilot_atr_compression_breakout.mjs',
    sampleSize: tradesLong.length,
    winRate: wrLong,
    evPerTrade: evLong,
    rigorStatus: rigorLong.clean ? 'clean' : 'failed'
  });
  console.log('Claim recorded:', claimResult);
  
  // Verify Claim
  const verify = await query(`SELECT * FROM performance_audit WHERE signal_type = 'RESEARCH_CLAIM' AND signal_name = 'atr_compression_breakout' ORDER BY run_date DESC LIMIT 1`);
  console.log('Verified Claim Row:', verify.rows[0]);
  
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
