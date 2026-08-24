// Calibrates the live SHORT entry-pressure sizeMultiplier boost and persists it to
// performance_audit (signal_type='ENTRY_PRESSURE_SHORT') for acd.js's
// sizeMultiplier IIFE to read — same read-once-per-poll-then-cache convention already used
// for DELTA_CONFIRMATION_CALIB and WIDER_TARGET_PRESSURE_GATE.
//
// Origin: RESEARCH_CLAIM pressure_entry_sizing_direction_asymmetric (2026-08-24). SHORT
// entries with high pre-entry selling pressure (dirImbalance at the last fully-completed
// bar before fired_at) genuinely replicated out-of-sample (train EV=+$8.08 N=22, test
// EV=+$33.41 N=23, both above their neutral baseline) — the LONG-side "avoid high buying
// pressure" finding did NOT replicate (inverted train-vs-test) and is deliberately excluded
// here, SHORT only.
//
// No-static-thresholds: threshold = top-tercile of real SHORT level-fade trades' entry-bar
// dirImbalance (same top-tercile convention as WIDER_TARGET_PRESSURE_GATE, not re-derived
// as a rolling Z-score live — the backtest's rolling-Z framing was for detecting the effect,
// this raw top-tercile cutoff is what the live code can cheaply read without an expensive
// per-poll historical re-walk).
//
// "Track if it starts to hurt us" (explicit user instruction, 2026-08-24): bump is
// FLOORED AT 0 if the real EV lift at/above the threshold isn't clearly positive on this
// run — the live factor shrinks toward inert automatically on a bad recalibration, it never
// keeps applying a stale positive boost off old data. Re-run weekly (run_weekly_backtests.sh)
// so the boost tracks the real, growing population rather than freezing at ship time.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeDirImbalance } from '../server/services/entryPressureService.js';

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, fired_at, actual_pnl::float as actual_pnl, resolution
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT', 'STOP_HIT') AND origin_status IN ('ACTIVE','SHADOW')
      AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL
      AND setup_type NOT LIKE '%VWAP%' AND setup_type NOT LIKE '%GLOBEX%'
      AND setup_type NOT LIKE '%OVERNIGHT%' AND setup_type LIKE '%FADE%'
  `);
  const shortTrades = tradesRes.rows.filter(t => inferDirection(t.setup_type) === 'SHORT');
  console.log(`Loaded ${shortTrades.length} real SHORT level-fade trades.`);

  const barsRes = await query(`
    SELECT ts, extract(epoch from ts)*1000 as ts_ms,
      COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;
  console.log(`Loaded ${allBars.length} bars.`);

  function lastCompletedBarBefore(firedAtMs) {
    const flooredMs = Math.floor(firedAtMs / 60000) * 60000;
    let lo = 0, hi = allBars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allBars[mid].ts_ms < flooredMs) lo = mid + 1; else hi = mid;
    }
    return lo > 0 ? allBars[lo - 1] : null;
  }

  const enriched = [];
  for (const t of shortTrades) {
    const bar = lastCompletedBarBefore(new Date(t.fired_at).getTime());
    if (!bar) continue;
    const p = computeDirImbalance(bar.bid_volume, bar.ask_volume, false);
    if (p === null) continue;
    enriched.push({ ...t, pressure: p });
  }
  console.log(`Computed entry pressure for ${enriched.length} trades.`);

  const sorted = [...enriched].sort((a, b) => a.pressure - b.pressure);
  const threshold = sorted[Math.floor(sorted.length * 2 / 3)]?.pressure ?? null;

  if (threshold == null || enriched.length < 20) {
    console.log('Not enough real data to calibrate (N<20) — writing a disabled (bump=0) row.');
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
      VALUES (CURRENT_DATE, 0, 'ENTRY_PRESSURE_SHORT', 'THRESHOLD', $1, $2)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
    `, [enriched.length, JSON.stringify({ threshold: null, bump: 0, reason: 'insufficient_n' })]);
    console.log('DONE');
    process.exit(0);
  }

  const above = enriched.filter(t => t.pressure >= threshold);
  const below = enriched.filter(t => t.pressure < threshold);
  const evAbove = above.reduce((s, t) => s + t.actual_pnl, 0) / above.length;
  const evBelow = below.reduce((s, t) => s + t.actual_pnl, 0) / below.length;
  const lift = evAbove - evBelow;

  // Modest, conservative mapping from real $ lift to a sizeMultiplier bump — matches the
  // existing IIFE's own scale (its factors range +0.10 to +0.50) rather than inventing a
  // new scale. Capped at 0.15 (the same size as this file's other single-factor order-flow
  // bonuses, e.g. "buyersAtLevel || sellersAtLevel") given N is still thin. Floored at 0
  // (no boost) whenever the real lift isn't clearly positive -- this is the actual
  // "track if it starts to hurt us" mechanism: a future bad recalibration zeroes this out
  // automatically, no code change needed.
  const bump = lift > 0 ? Math.min(0.15, +(lift / 100).toFixed(2)) : 0;

  console.log(`Threshold=${threshold.toFixed(4)} N=${enriched.length} (above=${above.length} EV=$${evAbove.toFixed(2)}, below=${below.length} EV=$${evBelow.toFixed(2)}) lift=$${lift.toFixed(2)} -> bump=${bump}`);

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes)
    VALUES (CURRENT_DATE, 0, 'ENTRY_PRESSURE_SHORT', 'THRESHOLD', $1, $2, $3, $4)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size = EXCLUDED.sample_size, win_rate = EXCLUDED.win_rate,
          ev_per_trade = EXCLUDED.ev_per_trade, notes = EXCLUDED.notes
  `, [
    enriched.length,
    above.length ? above.filter(t => t.resolution === 'TARGET_HIT').length / above.length : null,
    lift,
    JSON.stringify({ threshold, bump, n_above: above.length, n_below: below.length, ev_above: evAbove, ev_below: evBelow, method: 'top_tercile_dirImbalance_1bar_pre_entry' }),
  ]);

  console.log('DONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
