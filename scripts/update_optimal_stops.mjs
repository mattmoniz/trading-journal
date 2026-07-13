// =============================================================================
// Compute per-setup-type optimal stops AND targets from active_setups MAE/MFE.
// Run weekly (Sunday) and daily (4:20 PM ET) after backfill_mae_mfe.
//
// Stop + Target: joint EV sweep, per setup_type (2026-07-13). Stop candidates = this
//   type's own MAE percentiles (p25/p40/p50/p60/p75/p90 — all data-derived, no fixed
//   point grid); target candidates = TARGET_SWEEP capped at p75_mfe. Picks whichever
//   (stop, target) pair maximizes:
//   EV = mean over trades of: -stop*2 if mae>stop; +target*2 if mfe>=target; else actual_pnl.
//
//   Previously stop was hardcoded to p75_mae with only target swept, and a separate
//   special-cased block re-swept stops for just IB_BULLISH/IB_BEARISH. A 2026-07-13 audit
//   found no setup-agnostic rule holds (p50_mae beats p75_mae for only 28/66 types with the
//   corrected formula, not 69/70 as an earlier flawed simulation claimed — that run wrongly
//   counted mae<=stop-but-mfe<target trades as automatic losses instead of actual_pnl) — so
//   every type now gets its own swept stop instead of a blanket rule or a type-specific carve-out.
//
//   First attempt at this swept the stop over a flat 20-150pt grid instead of percentiles.
//   That let several types (IB_BEARISH, BRACKET_BREAKOUT_LONG, C_STANDALONE_DOWN,
//   OPEN_TEST_DRIVE_SHORT) jump to stops near the 150pt ceiling — a stop that wide almost
//   never triggers, so it inflates in-sample EV without actually reducing risk (classic
//   overfitting to a finite sample). Caught before it stayed live, reverted, and replaced
//   with this percentile-anchored version: candidates are always tied to that type's real
//   MAE distribution shape, so the sweep can't wander to a value unrelated to the data.
//
// Writes signal_type='OPTIMAL_STOP' rows — one per setup_type direction.
// The live path reads these via liveStats._opt[setup_type].
// =============================================================================

import { query } from '../server/db.js';

// Minimum N before we trust a computed optimal stop
const MIN_N = 20;
const DEFAULT_STOP = 65;
const DEFAULT_TARGET = 35;

// Target sweep range (pts) — all setup types, not just IB. Always capped at p75_mfe
// per-type below, so it can't select a target beyond what the type's own MFE data supports.
const TARGET_SWEEP = [10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100, 120, 150];

// Run EV sweep for targets — finds T1 that maximizes expected value given a fixed stop.
// Simulates: if MAE > stop → -stop, elif MFE >= T → +T, else → actual_pnl (expired/partial).
//
// maxT caps the sweep at p75_mfe so we never select a target that >75% of trades can't reach.
// Without this cap, high T values saturate to actual_pnl and look artificially optimal.
//
// Returns { target, ev }, or null if fewer than MIN_N trades or no candidates ≤ maxT.
function sweepOptimalTarget(trades, stop, maxT = 150) {
  if (trades.length < MIN_N) return null;
  const candidates = TARGET_SWEEP.filter(T => T <= maxT);
  if (candidates.length === 0) return null;
  let bestT = null, bestEV = -Infinity;
  for (const T of candidates) {
    let evSum = 0;
    for (const t of trades) {
      const mae = +t.mae_points, mfe = +t.mfe_points;
      if (mae > stop)    evSum += -stop * 2;
      else if (mfe >= T) evSum += T * 2;
      else               evSum += +t.actual_pnl;
    }
    const ev = evSum / trades.length;
    if (ev > bestEV) { bestEV = ev; bestT = T; }
  }
  return { target: bestT, ev: bestEV };
}

// Joint stop+target sweep. Corrected simulation (2026-07-13 audit): a trade where
// mae <= stop AND mfe < target never actually got stopped or hit target — it
// expired/partial — so it falls through to actual_pnl, NOT an automatic loss.
// (Prior Gemini analysis on 2026-07-10 miscounted that case as a loss, which
// wrongly favored tighter stops for 69/70 setups; re-derived directly against the
// DB with this fix, only 28/66 setups actually favor p50_mae over p75_mae — no
// blanket rule holds, so this must be swept per setup_type, not hardcoded.)
//
// Stop candidates are percentiles of THIS TYPE'S OWN mae_points distribution
// (p25/p40/p50/p60/p75/p90, passed in from the caller's query) — not a fixed point
// grid. A flat grid let the sweep pick stops unrelated to the actual data (e.g. 150pt
// for a type whose real MAE tops out around p90≈100), which overfits: a stop that
// almost never triggers looks great on realized EV without reducing real risk.
// Percentile-anchoring keeps every candidate tied to that type's real distribution shape.
function sweepOptimalStopAndTarget(trades, maePercentiles, maxT) {
  if (trades.length < MIN_N) return null;
  const stopCandidates = [...new Set(maePercentiles.map(Math.round))].sort((a, b) => a - b);
  let best = null;
  for (const S of stopCandidates) {
    const swept = sweepOptimalTarget(trades, S, maxT);
    if (!swept) continue;
    if (!best || swept.ev > best.ev) best = { stop: S, target: swept.target, ev: swept.ev };
  }
  return best;
}

async function main() {
  console.log('Computing optimal stops + EV-sweep targets from active_setups MAE/MFE data...');

  // 0. Mark corrupted MAE/MFE rows as BAD_DATA so they're excluded from all analysis.
  //    Opus audit 2026-07-07: 303/304 rows from 2023 have mae or mfe > 300pt (max 11,766pt).
  //    Root cause: bad bar data in price_bars_primary for Nov–Dec 2023 (price_at_resolution IS NULL).
  //    300pt is the clear boundary — 2024+ data is clean (0/1083 bad in 2024).
  const badRows = await query(`
    UPDATE active_setups
    SET replay_resolution = 'BAD_DATA'
    WHERE (mae_points > 300 OR mfe_points > 300)
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
    RETURNING id
  `);
  if (badRows.rows.length > 0) console.log(`Marked ${badRows.rows.length} corrupted MAE/MFE rows as BAD_DATA`);

  // 1. Compute p75_mae (optimal stop) and p50_mfe (optimal target) per setup_type
  //    Only resolved trades with clean MAE data; exclude EXPIRED (they inflate MAE/MFE)
  //    Excludes BAD_DATA rows (mae/mfe > 300pt from 2023 corruption).
  const statsRes = await query(`
    SELECT
      setup_type,
      COUNT(*)                                                                            AS n,
      ROUND(100.0 * SUM(CASE WHEN actual_pnl > 0 THEN 1 ELSE 0 END)/COUNT(*)::numeric, 1) AS wr,
      ROUND(AVG(actual_pnl)::numeric, 0)                                                 AS ev,
      ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p25_mae,
      ROUND(PERCENTILE_CONT(0.40) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p40_mae,
      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p50_mae,
      ROUND(PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p60_mae,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p75_mae,
      ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p90_mae,
      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mfe_points)::numeric, 1)       AS p50_mfe,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mfe_points)::numeric, 1)       AS p75_mfe
    FROM active_setups
    WHERE mae_points     IS NOT NULL
      AND mfe_points     IS NOT NULL
      AND actual_pnl     IS NOT NULL
      AND mae_points     <= 300
      AND mfe_points     <= 300
      AND status         = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
    GROUP BY setup_type
    HAVING COUNT(*) >= ${MIN_N}
    ORDER BY setup_type
  `);

  const rows = statsRes.rows;
  console.log(`Found ${rows.length} setup types with N≥${MIN_N}`);

  // 1b. Fetch all raw trades in one query for the target sweep
  const rawRes = await query(`
    SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND status = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
  `);
  const rawByType = {};
  for (const t of rawRes.rows) {
    if (!rawByType[t.setup_type]) rawByType[t.setup_type] = [];
    rawByType[t.setup_type].push(t);
  }
  console.log(`Loaded ${rawRes.rows.length} raw trades for EV target sweep`);

  let upserted = 0;
  for (const r of rows) {
    const p75mae    = parseFloat(r.p75_mae) || DEFAULT_STOP;
    const p75mfe    = Math.round(parseFloat(r.p75_mfe) || DEFAULT_TARGET);
    // Capped at p75 — NOT p90. Opus audit (2026-07-13) found the EV sim checks `mae > stop`
    // before checking the target, with no knowledge of chronological order within the trade.
    // At p90, trades whose real mae landed in the 76th-90th percentile range get "rescued"
    // into simulated wins whenever mfe happened to clear the target *at any point* in the bar
    // walk, regardless of whether target was actually reached before the real (tighter,
    // historical) stop would have triggered. IB_BEARISH: 8 such trades scored as +$100 wins
    // in the sim, but their real average actual_pnl was -$97.80 (they lost) — this artifact,
    // not genuine edge, is what pushed IB_BEARISH to a 150pt stop and BRACKET_BREAKOUT_LONG to
    // 165pt. This is the exact same failure mode sweepOptimalTarget's `maxT` cap already guards
    // against for targets (see its comment: "high T values saturate to actual_pnl and look
    // artificially optimal") — p90 just wasn't capped symmetrically for stops when the stop
    // sweep was added. p75 still isn't perfectly immune (same bias at lower magnitude, per the
    // audit) but the artifact was concentrated at p90 in practice (7/66 types landed there).
    const maePercentiles = [r.p25_mae, r.p40_mae, r.p50_mae, r.p60_mae, r.p75_mae]
      .map(parseFloat).filter(v => !isNaN(v) && v > 0);
    const trades    = rawByType[r.setup_type] || [];
    const swept     = sweepOptimalStopAndTarget(trades, maePercentiles, p75mfe);
    const optStop   = swept ? swept.stop : Math.round(p75mae);
    const optTarget = swept ? swept.target : Math.round(parseFloat(r.p50_mfe) || DEFAULT_TARGET);
    const targetMethod = swept ? 'EV-sweep' : 'p50_mfe fallback';

    await query(`
      INSERT INTO performance_audit (
        run_date, window_days, signal_type, signal_name,
        sample_size, win_rate, ev_per_trade,
        p50_mae, p75_mae, p50_mfe, p75_mfe,
        optimal_stop, optimal_target
      ) VALUES (
        CURRENT_DATE, 9999, 'OPTIMAL_STOP', $1,
        $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10
      )
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size    = EXCLUDED.sample_size,
        win_rate       = EXCLUDED.win_rate,
        ev_per_trade   = EXCLUDED.ev_per_trade,
        p50_mae        = EXCLUDED.p50_mae,
        p75_mae        = EXCLUDED.p75_mae,
        p50_mfe        = EXCLUDED.p50_mfe,
        p75_mfe        = EXCLUDED.p75_mfe,
        optimal_stop   = EXCLUDED.optimal_stop,
        optimal_target = EXCLUDED.optimal_target
    `, [
      r.setup_type,
      parseInt(r.n),
      parseFloat(r.wr) / 100,
      parseFloat(r.ev),
      parseFloat(r.p50_mae),
      parseFloat(r.p75_mae),
      parseFloat(r.p50_mfe),
      parseFloat(r.p75_mfe),
      optStop,
      optTarget,
    ]);

    upserted++;
    console.log(`  ${r.setup_type.padEnd(40)} stop=${optStop}pt  t1=${optTarget}pt(${targetMethod})  WR=${r.wr}%  N=${r.n}  EV=$${r.ev}`);
  }

  console.log(`\nDone. ${upserted} rows upserted into performance_audit (signal_type=OPTIMAL_STOP).`);
  console.log('Every setup_type now gets its own stop swept across its own MAE percentiles (p25/p40/p50/p60/p75/p90), not a blanket p75_mae rule.');
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
