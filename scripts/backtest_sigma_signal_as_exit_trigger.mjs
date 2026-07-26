// Direct follow-up to the user's question (2026-07-26): "did we test a backtested exit-now
// using the [big-move/sigma] signals to see total PnL impact?" We hadn't -- bar6_checkpoint's
// exit rule was tested this way, but BIGMOVE_LIVE_SIGNAL and the sigma-continuation signal were
// only ever built as descriptive/predictive market-state signals, never as exit triggers on an
// EXISTING open trade. This tests the sigma-continuation signal specifically (the more directly
// actionable of the two, since it says something about DIRECTION, not just "today is volatile").
//
// Scope: LONG trades only. The validated research (sigma_continuation_down_moves) only tested
// DOWN moves -- a down-move continuation signal is a real, validated adverse-direction signal
// for a LONG position. Applying it to SHORT positions would require the untested mirror
// (up-move continuation), which we do not have -- deliberately excluded, not assumed to work.
//
// Confound check (per this codebase's own "confound checklist for comparison backtests"):
// does exiting early on this SPECIFIC signal beat holding, or would exiting early at
// approximately the same point in a trade's life help regardless of any real signal? Built a
// blind control arm (fixed exit at the median signal-trigger offset, applied to ALL trades
// whether or not the real signal fired) specifically to rule this out -- matches the
// "entry-price-only control arm" precedent (backtest_engagement_confirmation_entry.mjs),
// applied to exit timing instead of entry timing.
//
// Reuses the exact validated sigma methodology (100-bar rolling log-return stdev, 60min
// lookback, gap-guarded) from scripts/backtest_sigma_continuation.mjs -- computed ONCE across
// the whole bar history, not re-derived per trade.

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const SIG_WIN = 100, H = 60, GAP_CUTOFF = 45, SIGMA_THRESHOLD = 2.0;

function summarize(rows, field) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: '0.0', total: '0.00', ev: '0.00', avgWin: 'n/a', avgLoss: 'n/a' };
  const wins = rows.filter(r => r[field] > 0);
  const losses = rows.filter(r => r[field] <= 0);
  const total = rows.reduce((s, r) => s + r[field], 0);
  return {
    n, wr: (wins.length / n * 100).toFixed(1), total: total.toFixed(2), ev: (total / n).toFixed(2),
    avgWin: wins.length ? (wins.reduce((s, r) => s + r[field], 0) / wins.length).toFixed(2) : 'n/a',
    avgLoss: losses.length ? (losses.reduce((s, r) => s + r[field], 0) / losses.length).toFixed(2) : 'n/a',
  };
}

async function main() {
  const maxDateRow = await query(`SELECT MAX(trade_date)::text as max_date FROM active_setups`);
  const maxDate = maxDateRow.rows[0].max_date;

  console.log('Loading 2yr bar history for sigma precomputation...');
  const barsRes = await query(`
    SELECT ts, close::float FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::date - interval '2 years'
    ORDER BY ts ASC
  `, [maxDate]);
  const bars = barsRes.rows.map((r, i, arr) => {
    const gapMin = i === 0 ? Infinity : (new Date(r.ts).getTime() - new Date(arr[i - 1].ts).getTime()) / 60000;
    return { ts: new Date(r.ts).getTime(), close: r.close, gapMin };
  });

  console.log('Computing down-move sigma magnitude at every bar (gap-guarded)...');
  const sigmaMag = new Array(bars.length).fill(null); // null or NaN = no valid down-move reading
  let volWindow = [], sumLogRet = 0, sumSqLogRet = 0;
  for (let i = 1; i < bars.length; i++) {
    const gapMin = bars[i].gapMin;
    const logRet = Math.log(bars[i].close / bars[i - 1].close);
    if (gapMin > GAP_CUTOFF) { volWindow = []; sumLogRet = 0; sumSqLogRet = 0; }
    else {
      volWindow.push(logRet);
      sumLogRet += logRet; sumSqLogRet += logRet * logRet;
      if (volWindow.length > SIG_WIN) { const rm = volWindow.shift(); sumLogRet -= rm; sumSqLogRet -= rm * rm; }
    }
    if (volWindow.length === SIG_WIN && i >= H) {
      let lookbackHasGap = false;
      for (let j = i - H + 1; j <= i; j++) { if (bars[j].gapMin > GAP_CUTOFF) { lookbackHasGap = true; break; } }
      if (!lookbackHasGap) {
        const mean = sumLogRet / SIG_WIN;
        const variance = Math.max(0, sumSqLogRet / SIG_WIN - mean * mean);
        const stdDevLogRet = Math.sqrt(variance);
        if (stdDevLogRet > 0) {
          const moveInPoints = bars[i].close - bars[i - H].close;
          const expectedMove = bars[i].close * stdDevLogRet * Math.sqrt(H);
          if (moveInPoints < 0) sigmaMag[i] = Math.abs(moveInPoints) / expectedMove;
        }
      }
    }
  }
  const tsToIdx = new Map();
  for (let i = 0; i < bars.length; i++) tsToIdx.set(bars[i].ts, i);

  console.log('Loading LONG trades in trailing 365 days...');
  const tradesQ = await query(`
    SELECT trade_date::text as trade_date, fired_at, setup_type, origin_status,
           actual_pnl::float as actual_pnl, bars_to_resolution,
           entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE trade_date >= $1::date - interval '365 days' AND trade_date <= $1::date
      AND actual_pnl IS NOT NULL AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND (mae_points IS NULL OR mae_points::float <= 300) AND (mfe_points IS NULL OR mfe_points::float <= 300)
      AND entry_zone_low IS NOT NULL AND bars_to_resolution IS NOT NULL AND bars_to_resolution > 0
    ORDER BY trade_date ASC, fired_at ASC
  `, [maxDate]);
  const longTrades = tradesQ.rows.filter(t => directionFromType(t.setup_type) === 'LONG');
  console.log(`${longTrades.length} LONG trades match the population filter.`);

  const results = [];
  let noBarIdx = 0;
  for (const t of longTrades) {
    const entryIdx = tsToIdx.get(new Date(t.fired_at).getTime());
    if (entryIdx == null) { noBarIdx++; continue; }
    const resolutionIdx = entryIdx + t.bars_to_resolution;
    const hi = t.entry_zone_high != null ? t.entry_zone_high : t.entry_zone_low;
    const entry = (t.entry_zone_low + hi) / 2;

    let triggerOffset = null;
    for (let off = 1; off < t.bars_to_resolution && entryIdx + off < bars.length; off++) {
      const mag = sigmaMag[entryIdx + off];
      if (mag != null && mag >= SIGMA_THRESHOLD) { triggerOffset = off; break; }
    }
    results.push({ ...t, entryIdx, resolutionIdx, entry, triggerOffset });
  }
  console.log(`${noBarIdx} trades skipped (entry bar not found in bar history).`);

  const triggered = results.filter(r => r.triggerOffset != null);
  console.log(`Signal fired before original resolution on ${triggered.length} of ${results.length} trades.`);

  // Blind control offset: fixed at the MEDIAN real trigger offset (not signal-dependent),
  // applied to every trade regardless of whether the real signal fired -- tests whether
  // "exit at approximately this point" alone explains any improvement.
  const offsets = triggered.map(r => r.triggerOffset).sort((a, b) => a - b);
  const blindOffset = offsets.length ? offsets[Math.floor(offsets.length / 2)] : null;
  console.log(`Blind control offset (median real trigger offset): ${blindOffset} bars.`);

  for (const r of results) {
    r.pnlBaseline = r.actual_pnl;
    r.pnlSignalGated = r.actual_pnl;
    if (r.triggerOffset != null) {
      const exitBar = bars[r.entryIdx + r.triggerOffset];
      r.pnlSignalGated = (exitBar.close - r.entry) * PNL_PER_POINT - COMMISSION;
    }
    r.pnlBlindGated = r.actual_pnl;
    if (blindOffset != null && blindOffset < r.bars_to_resolution && r.entryIdx + blindOffset < bars.length) {
      const exitBar = bars[r.entryIdx + blindOffset];
      r.pnlBlindGated = (exitBar.close - r.entry) * PNL_PER_POINT - COMMISSION;
    }
  }

  const md = [];
  md.push('# Sigma-Continuation Signal as an Exit Trigger — LONG Trades Only\n');
  md.push(`Window: trailing 365 days ending ${maxDate}. LONG trades only (down-move continuation is the validated adverse direction for a long).\n`);
  md.push(`Population: N=${results.length}. Signal fired before original resolution on ${triggered.length} (${(triggered.length / results.length * 100).toFixed(1)}%).\n`);

  const base = summarize(results, 'pnlBaseline');
  const gated = summarize(results, 'pnlSignalGated');
  const blind = summarize(results, 'pnlBlindGated');
  md.push('## Whole population (baseline vs signal-gated vs blind-control)');
  md.push(`- Baseline (hold to original outcome): N=${base.n}, WR=${base.wr}%, Total=$${base.total}, EV/trade=$${base.ev}, avgWin=$${base.avgWin}, avgLoss=$${base.avgLoss}`);
  md.push(`- Signal-gated (exit when sigma signal fires): WR=${gated.wr}%, Total=$${gated.total}, EV/trade=$${gated.ev}, avgWin=$${gated.avgWin}, avgLoss=$${gated.avgLoss}`);
  md.push(`- Blind control (exit at fixed bar ${blindOffset}, no signal): WR=${blind.wr}%, Total=$${blind.total}, EV/trade=$${blind.ev}, avgWin=$${blind.avgWin}, avgLoss=$${blind.avgLoss}`);
  md.push(`- **Signal-gated vs baseline: $${(Number(gated.total) - Number(base.total)).toFixed(2)}**`);
  md.push(`- **Blind control vs baseline: $${(Number(blind.total) - Number(base.total)).toFixed(2)}** (if this is similar to the signal-gated diff above, the effect is likely structural/mechanical, not signal-driven)\n`);

  const trig = triggered;
  const trigBase = summarize(trig, 'pnlBaseline');
  const trigGated = summarize(trig, 'pnlSignalGated');
  const trigBlind = summarize(trig, 'pnlBlindGated');
  md.push('## Only trades where the signal actually fired (the real population this rule would act on)');
  md.push(`- Baseline: N=${trigBase.n}, WR=${trigBase.wr}%, Total=$${trigBase.total}, EV/trade=$${trigBase.ev}`);
  md.push(`- Signal-gated: WR=${trigGated.wr}%, Total=$${trigGated.total}, EV/trade=$${trigGated.ev}`);
  md.push(`- Blind control (same trades, fixed-bar exit instead): WR=${trigBlind.wr}%, Total=$${trigBlind.total}, EV/trade=$${trigBlind.ev}`);
  md.push(`- **Signal-gated vs baseline: $${(Number(trigGated.total) - Number(trigBase.total)).toFixed(2)}**`);
  md.push(`- **Blind control vs baseline: $${(Number(trigBlind.total) - Number(trigBase.total)).toFixed(2)}**\n`);

  md.push('## Origin-status breakdown (whole population)');
  for (const origin of ['ACTIVE', 'SHADOW', 'BACKFILL', 'UNKNOWN']) {
    const subset = results.filter(r => r.origin_status === origin);
    if (subset.length === 0) continue;
    const b = summarize(subset, 'pnlBaseline'), g = summarize(subset, 'pnlSignalGated');
    md.push(`- **${origin}**: N=${subset.length}, baseline=$${b.total}, signal-gated=$${g.total}, diff=$${(Number(g.total) - Number(b.total)).toFixed(2)}`);
  }

  const report = md.join('\n');
  fs.writeFileSync('scratch/sigma_signal_exit_trigger_RESULTS.md', report);
  console.log(report);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
