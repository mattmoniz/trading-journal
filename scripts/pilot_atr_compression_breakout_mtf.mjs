// Multi-timeframe ATR-compression breakout backtest.
//
// CORRECTED 2026-08-11 (Opus consultation 6, docs/OPUS_AUDIT_PROMPT_6.md /
// scratch/opus_audit_6_results.md) after this script's original "skip the same-bar stop
// check, can't resolve intrabar ordering without tick data" rationale was found to be
// WRONG: the 60/30/15-min bars here are aggregated from 1-min bars we already have, and
// resolving fill order at 1-min granularity (a 60x/30x/15x improvement over assuming it
// away) dropped the 60-min headline EV from a fantasy +$65.84/trade to a real band of
// +$5.10 to +$27.14/trade (t=0.20 to 0.89 -- statistically indistinguishable from zero).
// 89% of entry bars had a low already below the stop level; the "no same-bar stop" version
// gave 89% of trades a free pass through a bar that would have stopped them out. Also fixed
// a spec deviation Opus found: the source rule is "buy the NEXT bar at Open+2xATR(20)" --
// the code anchored the offset to the SIGNAL bar's own open (prevBar.open), not the entry
// bar's own open (bar.open). Both fixes verified independently (re-ran Opus's own audit
// scripts and reproduced every number exactly) before porting into this cron'd script.
//
// Usage: node scripts/pilot_atr_compression_breakout_mtf.mjs <barMinutes>
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const BAR_MIN = parseInt(process.argv[2] || '60', 10);
if (![15, 30, 60].includes(BAR_MIN)) {
  console.error('barMinutes must be 15, 30, or 60');
  process.exit(1);
}

async function main() {
  const DOLLARS_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
  const COMMISSION_RT = LIVE_INSTRUMENT.commissionPerRoundTrip;

  console.log(`Starting ATR Compression Breakout test (${BAR_MIN}-min bars) using ${LIVE_INSTRUMENT.symbol} economics ($${DOLLARS_PER_POINT}/pt, $${COMMISSION_RT} RT)...`);

  const sql = `
    SELECT
      to_char(ts, 'YYYY-MM-DD HH24:MI:SS') as ts_str,
      open::float, high::float, low::float, close::float, volume,
      EXTRACT(hour FROM ts)::int as hour_part,
      EXTRACT(minute FROM ts)::int as minute_part,
      EXTRACT(dow FROM ts)::int as dow
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      -- price_bars_primary for NQ is only ONE bar/calendar-day before 2023-11-15 (see
      -- docs/KNOWN_ISSUES.md item 13) -- starting from 2023-12-16 (right after the
      -- documented ES-contamination window) skips both problems at once.
      AND ts >= '2023-12-16'
    ORDER BY ts ASC
  `;

  console.log('Fetching NQ 1-min data...');
  const { rows } = await query(sql);
  console.log(`Fetched ${rows.length} 1-min bars.`);

  console.log(`Aggregating to ${BAR_MIN}-min bars (keeping 1-min rows per bucket for fill resolution)...`);
  const buckets = new Map();
  for (const r of rows) {
    const h = r.hour_part;
    if (h === 17) continue;
    const bucketMin = Math.floor(r.minute_part / BAR_MIN) * BAR_MIN;
    const bucketId = `${r.ts_str.substring(0, 10)} ${String(h).padStart(2, '0')}:${String(bucketMin).padStart(2, '0')}:00`;

    if (!buckets.has(bucketId)) {
      buckets.set(bucketId, {
        ts: bucketId,
        open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
        dayOfWeek: r.dow, mins: [r],
      });
    } else {
      const b = buckets.get(bucketId);
      b.high = Math.max(b.high, r.high);
      b.low = Math.min(b.low, r.low);
      b.close = r.close;
      b.volume += r.volume;
      b.mins.push(r);
    }
  }

  const mBars = Array.from(buckets.values()).sort((a, b) => a.ts.localeCompare(b.ts));
  console.log(`Aggregated to ${mBars.length} ${BAR_MIN}-min bars.`);
  const minCounts = mBars.map(b => b.mins.length).sort((a, b) => a - b);
  const fullBar = BAR_MIN; // 1-min rows per bucket when fully dense
  console.log(`1-min rows/bucket: p10=${minCounts[Math.floor(minCounts.length*0.1)]} p50=${minCounts[Math.floor(minCounts.length*0.5)]} full=${(minCounts.filter(c=>c>=fullBar).length/minCounts.length*100).toFixed(1)}%`);

  for (let i = 0; i < mBars.length; i++) {
    const bar = mBars[i];
    if (i === 0) {
      bar.tr = bar.high - bar.low;
    } else {
      const prevClose = mBars[i - 1].close;
      bar.tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    }
  }

  function addWilderATR(bars, period, field) {
    let sumTR = 0;
    for (let i = 0; i < bars.length; i++) {
      if (i < period) {
        sumTR += bars[i].tr;
        if (i === period - 1) bars[i][field] = sumTR / period;
      } else {
        bars[i][field] = (bars[i - 1][field] * (period - 1) + bars[i].tr) / period;
      }
    }
  }
  addWilderATR(mBars, 20, 'atr20');
  addWilderATR(mBars, 30, 'atr30');

  for (let i = 0; i < mBars.length; i++) {
    const bar = mBars[i];
    const nextBar = mBars[i + 1];
    bar.isFridayExit = false;
    if (bar.dayOfWeek === 5) {
      if (!nextBar || nextBar.dayOfWeek !== 5) bar.isFridayExit = true;
    }
  }

  // Resolve the entry bar's own fill using its underlying 1-min bars: did the stop level
  // get touched in the SAME minute the entry triggered (ambiguous -- can't order it without
  // tick data even at 1-min resolution) or a LATER minute (unambiguous same-bar stop)?
  // Returns null if the bar never actually crosses the stop level at all (no ambiguity).
  function resolveEntryFill(bar, triggerLevel, stop, isLong) {
    let entered = false;
    for (const m of bar.mins) {
      if (!entered) {
        if ((isLong && m.high >= triggerLevel) || (!isLong && m.low <= triggerLevel)) {
          entered = true;
          const stopTouchedNow = isLong ? m.low <= stop : m.high >= stop;
          if (stopTouchedNow) return 'AMBIG';
        }
      } else {
        const stopTouched = isLong ? m.low <= stop : m.high >= stop;
        if (stopTouched) return 'UNAMBIG';
      }
    }
    return null;
  }

  // ambigMode: 'pessimistic' (ambiguous same-minute tie counts as a stop-out) or
  // 'optimistic' (ambiguous tie survives) -- report BOTH, never just one, per Opus's
  // finding that picking either end and presenting it as "the" number overclaims precision
  // the data can't support.
  function runBacktest({ side, useFilter, ambigMode }) {
    let trades = [];
    let position = null;
    let entryBarIdx = null;
    let ambigCount = 0, unambigCount = 0, degradedCount = 0;

    for (let i = 30; i < mBars.length - 1; i++) {
      const prevBar = mBars[i - 1];
      const bar = mBars[i];

      if (position) {
        let stopHit = false, exitPrice = null;
        if (position.side === 'LONG') {
          if (bar.low <= position.stop) { stopHit = true; exitPrice = Math.min(bar.open, position.stop); }
        } else {
          if (bar.high >= position.stop) { stopHit = true; exitPrice = Math.max(bar.open, position.stop); }
        }

        if (stopHit) {
          const pts = position.side === 'LONG' ? (exitPrice - position.entryPrice) : (position.entryPrice - exitPrice);
          const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
          trades.push({ entryTime: mBars[entryBarIdx].ts, exitTime: bar.ts, side: position.side, pnl, pts, reason: 'STOP', date: bar.ts.substring(0, 10) });
          position = null;
        } else if (bar.isFridayExit) {
          exitPrice = bar.close;
          const pts = position.side === 'LONG' ? (exitPrice - position.entryPrice) : (position.entryPrice - exitPrice);
          const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
          trades.push({ entryTime: mBars[entryBarIdx].ts, exitTime: bar.ts, side: position.side, pnl, pts, reason: 'FRIDAY_CLOSE', date: bar.ts.substring(0, 10) });
          position = null;
        }
        continue;
      }

      let signal = true;
      if (useFilter && !(prevBar.atr20 < prevBar.atr30)) signal = false;
      if (!signal) continue;

      // Spec fix: offset anchors to the ENTRY bar's own open ("buy the next bar at
      // Open+2xATR(20)"), not the signal bar's open -- ATR itself still comes from the
      // completed signal bar (prevBar), the only one fully known at signal time.
      if (side === 'LONG') {
        const buyLevel = bar.open + (2 * prevBar.atr20);
        if (bar.high >= buyLevel) {
          const entryPrice = Math.max(bar.open, buyLevel);
          const stop = entryPrice - (0.5 * prevBar.atr20);

          let sameBarOut = false;
          if (bar.low <= stop) {
            if (bar.mins.length < BAR_MIN / 2) degradedCount++;
            const res = resolveEntryFill(bar, buyLevel, stop, true);
            if (res === 'AMBIG') { ambigCount++; sameBarOut = ambigMode === 'pessimistic'; }
            else if (res === 'UNAMBIG') { unambigCount++; sameBarOut = true; }
          }
          if (sameBarOut) {
            const pts = stop - entryPrice;
            trades.push({ entryTime: bar.ts, exitTime: bar.ts, side: 'LONG', pnl: (pts * DOLLARS_PER_POINT) - COMMISSION_RT, pts, reason: 'STOP_SAMEBAR', date: bar.ts.substring(0, 10) });
            continue;
          }

          position = { side: 'LONG', entryPrice, stop };
          entryBarIdx = i;
          if (bar.isFridayExit) {
            const exitPrice = bar.close;
            const pts = exitPrice - entryPrice;
            trades.push({ entryTime: bar.ts, exitTime: bar.ts, side: 'LONG', pnl: (pts * DOLLARS_PER_POINT) - COMMISSION_RT, pts, reason: 'FRIDAY_CLOSE_SAME_BAR', date: bar.ts.substring(0, 10) });
            position = null;
          }
        }
      } else if (side === 'SHORT') {
        const sellLevel = bar.open - (2 * prevBar.atr20);
        if (bar.low <= sellLevel) {
          const entryPrice = Math.min(bar.open, sellLevel);
          const stop = entryPrice + (0.5 * prevBar.atr20);

          let sameBarOut = false;
          if (bar.high >= stop) {
            if (bar.mins.length < BAR_MIN / 2) degradedCount++;
            const res = resolveEntryFill(bar, sellLevel, stop, false);
            if (res === 'AMBIG') { ambigCount++; sameBarOut = ambigMode === 'pessimistic'; }
            else if (res === 'UNAMBIG') { unambigCount++; sameBarOut = true; }
          }
          if (sameBarOut) {
            const pts = entryPrice - stop;
            trades.push({ entryTime: bar.ts, exitTime: bar.ts, side: 'SHORT', pnl: (pts * DOLLARS_PER_POINT) - COMMISSION_RT, pts, reason: 'STOP_SAMEBAR', date: bar.ts.substring(0, 10) });
            continue;
          }

          position = { side: 'SHORT', entryPrice, stop };
          entryBarIdx = i;
          if (bar.isFridayExit) {
            const exitPrice = bar.close;
            const pts = entryPrice - exitPrice;
            trades.push({ entryTime: bar.ts, exitTime: bar.ts, side: 'SHORT', pnl: (pts * DOLLARS_PER_POINT) - COMMISSION_RT, pts, reason: 'FRIDAY_CLOSE_SAME_BAR', date: bar.ts.substring(0, 10) });
            position = null;
          }
        }
      }
    }
    return { trades, ambigCount, unambigCount, degradedCount };
  }

  function summarize(trades, prefix) {
    if (trades.length === 0) return `${prefix}: N=0`;
    const wr = trades.filter(t => t.pnl > 0).length / trades.length;
    const ev = trades.reduce((sum, t) => sum + t.pnl, 0) / trades.length;
    const sd = Math.sqrt(trades.reduce((s, t) => s + (t.pnl - ev) ** 2, 0) / Math.max(1, trades.length - 1));
    const tstat = sd > 0 ? ev / (sd / Math.sqrt(trades.length)) : 0;
    let maxDD = 0, peak = 0, cum = 0;
    for (const t of trades) {
      cum += t.pnl;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    }
    return `${prefix}: N=${trades.length}, WR=${(wr * 100).toFixed(1)}%, EV=$${ev.toFixed(2)}, t=${tstat.toFixed(2)}, MaxDD=-$${maxDD.toFixed(2)}, Total=$${cum.toFixed(2)}`;
  }

  const pess = runBacktest({ side: 'LONG', useFilter: true, ambigMode: 'pessimistic' });
  const opt = runBacktest({ side: 'LONG', useFilter: true, ambigMode: 'optimistic' });
  console.log(summarize(pess.trades, '1a. Long-Only PESSIMISTIC (ambig=stop)'));
  console.log(summarize(opt.trades, '1b. Long-Only OPTIMISTIC (ambig=survive)'));
  console.log(`   ambig=${pess.ambigCount} unambig=${pess.unambigCount} degraded=${pess.degradedCount}`);

  const shortPess = runBacktest({ side: 'SHORT', useFilter: true, ambigMode: 'pessimistic' });
  const shortOpt = runBacktest({ side: 'SHORT', useFilter: true, ambigMode: 'optimistic' });
  console.log(summarize(shortPess.trades, '2a. Short-Only PESSIMISTIC'));
  console.log(summarize(shortOpt.trades, '2b. Short-Only OPTIMISTIC'));

  const noFilterPess = runBacktest({ side: 'LONG', useFilter: false, ambigMode: 'pessimistic' });
  const noFilterOpt = runBacktest({ side: 'LONG', useFilter: false, ambigMode: 'optimistic' });
  console.log(summarize(noFilterPess.trades, '4a. No-Filter Control PESSIMISTIC'));
  console.log(summarize(noFilterOpt.trades, '4b. No-Filter Control OPTIMISTIC'));

  const firstBar = mBars[30];
  const lastBar = mBars[mBars.length - 1];
  const bnhPts = lastBar.close - firstBar.open;
  const bnhTotal = (bnhPts * DOLLARS_PER_POINT) - COMMISSION_RT;
  let bnhMaxDD = 0, bnhPeak = 0;
  for (let i = 30; i < mBars.length; i++) {
    const b = mBars[i];
    const lowPnl = ((b.low - firstBar.open) * DOLLARS_PER_POINT) - COMMISSION_RT;
    const highPnl = ((b.high - firstBar.open) * DOLLARS_PER_POINT) - COMMISSION_RT;
    if (highPnl > bnhPeak) bnhPeak = highPnl;
    const dd = bnhPeak - lowPnl;
    if (dd > bnhMaxDD) bnhMaxDD = dd;
  }
  console.log(`3. Buy-and-Hold Baseline: Total=$${bnhTotal.toFixed(2)}, MaxDD=-$${bnhMaxDD.toFixed(2)}`);

  const rigorPess = computeRigor(pess.trades, { dateField: 'date', pnlFn: t => t.pnl });
  const rigorOpt = computeRigor(opt.trades, { dateField: 'date', pnlFn: t => t.pnl });
  console.log(`5. Chronological Stability (pessimistic):`, rigorPess);
  console.log(`5. Chronological Stability (optimistic):`, rigorOpt);

  const msStart = new Date(firstBar.ts).getTime();
  const msEnd = new Date(lastBar.ts).getTime();
  const msCutoff = msStart + (msEnd - msStart) * (2 / 3.7);
  const trainPess = pess.trades.filter(t => new Date(t.entryTime).getTime() <= msCutoff);
  const testPess = pess.trades.filter(t => new Date(t.entryTime).getTime() > msCutoff);
  console.log(summarize(trainPess, '6a. Walk-forward Train, pessimistic (~2y)'));
  console.log(summarize(testPess, '6b. Walk-forward Test, pessimistic (~1.7y)'));

  // Winner concentration (pessimistic population -- the more defensible bound)
  const winners = pess.trades.filter(t => t.pnl > 0).sort((a, b) => b.pnl - a.pnl);
  const totalPnl = pess.trades.reduce((s, t) => s + t.pnl, 0);
  const top1Pct = winners.length && totalPnl !== 0 ? (winners[0].pnl / totalPnl * 100) : null;
  const top3Pct = winners.length && totalPnl !== 0 ? (winners.slice(0, 3).reduce((s, t) => s + t.pnl, 0) / totalPnl * 100) : null;

  const resultsContent = `
# ATR Compression Breakout Backtest Results (${BAR_MIN}-min bars) -- CORRECTED FILL ENGINE

**Date Range:** ${firstBar.ts} to ${lastBar.ts}
**Economics:** MNQ ($2/pt, $2 RT commission)
**Fill resolution**: entry-bar same-bar-stop ambiguity resolved via the underlying 1-min
bars where possible (ambig=${pess.ambigCount} same-minute ties, unambig=${pess.unambigCount}
later-minute stops, degraded=${pess.degradedCount} entry bars with <50% of expected 1-min density).
Two bounds reported -- do not treat either as "the" number, the true value sits between them.

### Long-Only (the tested direction)
- **${summarize(pess.trades, 'PESSIMISTIC (ambiguous ties = stop)')}**
- **${summarize(opt.trades, 'OPTIMISTIC (ambiguous ties = survive)')}**
- Winner concentration (pessimistic): ${winners.length} winners of ${pess.trades.length}${top1Pct !== null ? `, top1=${top1Pct.toFixed(0)}% of total P&L, top3=${top3Pct.toFixed(0)}%` : ''}

### Short-Only (symmetric)
- **${summarize(shortPess.trades, 'PESSIMISTIC')}**
- **${summarize(shortOpt.trades, 'OPTIMISTIC')}**

### No-Filter Control
- **${summarize(noFilterPess.trades, 'PESSIMISTIC')}**
- **${summarize(noFilterOpt.trades, 'OPTIMISTIC')}**

### Buy-and-Hold Baseline
Total=$${bnhTotal.toFixed(2)}, MaxDD=-$${bnhMaxDD.toFixed(2)}

### Walk-Forward (Long-Only, pessimistic)
- **${summarize(trainPess, 'Train (~2y)')}**
- **${summarize(testPess, 'Test (~1.7y)')}**

### Chronological Stability
Pessimistic: \`${JSON.stringify(rigorPess)}\`
Optimistic: \`${JSON.stringify(rigorOpt)}\`
`;

  fs.writeFileSync(`scratch/atr_compression_breakout_${BAR_MIN}m_RESULTS.md`, resultsContent);
  console.log(`Results written to scratch/atr_compression_breakout_${BAR_MIN}m_RESULTS.md`);

  const evPess = pess.trades.length ? (pess.trades.reduce((s, t) => s + t.pnl, 0) / pess.trades.length) : 0;
  const evOpt = opt.trades.length ? (opt.trades.reduce((s, t) => s + t.pnl, 0) / opt.trades.length) : 0;
  const wrPess = pess.trades.length ? (pess.trades.filter(t => t.pnl > 0).length / pess.trades.length) : 0;

  const claimText = `ATR Compression Breakout, ${BAR_MIN}-min bars, CORRECTED fill engine (1-min-resolved same-bar stops, spec-fixed entry anchor). Long-only band: pessimistic EV=$${evPess.toFixed(2)} (N=${pess.trades.length}, WR=${(wrPess*100).toFixed(1)}%) to optimistic EV=$${evOpt.toFixed(2)} (N=${opt.trades.length}). ${winners.length} winners of ${pess.trades.length} pessimistic trades${top1Pct !== null ? `, top winner=${top1Pct.toFixed(0)}% of total P&L` : ''}. No-filter control (pessimistic) EV=$${noFilterPess.trades.length ? (noFilterPess.trades.reduce((s,t)=>s+t.pnl,0)/noFilterPess.trades.length).toFixed(2) : 'N/A'} (N=${noFilterPess.trades.length}). B&H Total=$${bnhTotal.toFixed(2)}. Supersedes the pre-correction claim from the same session (fantasy no-same-bar-stop version), which was fixed by Opus consultation 6 (docs/OPUS_AUDIT_PROMPT_6.md) -- 89% of entry bars had a low already below the stop, and the "can't resolve without tick data" rationale for skipping the same-bar check was wrong given 1-min bars were already available.`;

  await recordClaim({
    slug: `atr_compression_breakout_${BAR_MIN}m`,
    claimText,
    sourceFile: 'scripts/pilot_atr_compression_breakout_mtf.mjs',
    sampleSize: pess.trades.length,
    winRate: wrPess,
    evPerTrade: evPess,
    rigorStatus: rigorPess.clean ? 'clean' : 'failed',
    status: 'PROVISIONAL',
  });
  console.log('Claim recorded.');

  const verify = await query(`SELECT signal_name, sample_size, win_rate, ev_per_trade FROM performance_audit WHERE signal_type = 'RESEARCH_CLAIM' AND signal_name = $1 ORDER BY run_date DESC LIMIT 1`, [`atr_compression_breakout_${BAR_MIN}m`]);
  console.log('Verified Claim Row:', verify.rows[0]);

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
