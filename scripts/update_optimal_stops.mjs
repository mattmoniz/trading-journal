// =============================================================================
// Compute per-setup-type optimal stops AND targets from active_setups MAE/MFE.
// Run weekly (Sunday) and daily (4:20 PM ET) after backfill_mae_mfe.
//
// Stop: p75_mae (statistical) + EV sweep override for IB types
// Target: EV sweep across 15 candidate values — finds T1 that maximizes EV
//   EV(T) = hit_rate(T) × T×2 - miss_rate(T) × stop×2
//   where hit_rate(T) = fraction of trades where MFE ≥ T and MAE ≤ stop
//   This outperforms mechanical p50_mfe when MFE distribution is bimodal.
// T2: p75_mfe (runner target — 75% of trades reach this level)
//
// Writes signal_type='OPTIMAL_STOP' rows — one per setup_type direction.
// The live path reads these via liveStats._opt[setup_type].
// =============================================================================

import { query } from '../server/db.js';

// Minimum N before we trust a computed optimal stop
const MIN_N = 20;
const DEFAULT_STOP = 65;
const DEFAULT_TARGET = 35;

// Target sweep range (pts) — all setup types, not just IB
const TARGET_SWEEP = [10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100, 120, 150];

// Run EV sweep for targets — finds T1 that maximizes expected value given a fixed stop.
// Simulates: if MAE > stop → -stop, elif MFE >= T → +T, else → actual_pnl (expired/partial).
//
// maxT caps the sweep at p75_mfe so we never select a target that >75% of trades can't reach.
// Without this cap, high T values saturate to actual_pnl and look artificially optimal.
//
// Returns the optimal T in points, or null if fewer than MIN_N trades or no candidates ≤ maxT.
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
  return bestT;
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
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p75_mae,
      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p50_mae,
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
    const optStop   = Math.round(parseFloat(r.p75_mae) || DEFAULT_STOP);
    const p75mfe    = Math.round(parseFloat(r.p75_mfe) || DEFAULT_TARGET);
    const trades    = rawByType[r.setup_type] || [];
    const swept     = sweepOptimalTarget(trades, optStop, p75mfe);
    const optTarget = swept || Math.round(parseFloat(r.p50_mfe) || DEFAULT_TARGET);
    const targetMethod = swept ? 'EV-sweep' : 'p50_mfe';

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

  // ── Stop sweep for IB_BULLISH / IB_BEARISH ──────────────────────────────────
  // These setups benefit from tight stops (sweep research 2026-07-05 showed EV
  // improved dramatically at 50pt vs p75_mae ~113pt for BULLISH). Re-derive the
  // optimal stop dynamically so it updates as more trade data accumulates.
  // Uses actual MAE/MFE to simulate each stop candidate: if MAE > S → stopped at -S,
  // if MFE >= target → +target, else → actual_pnl.
  const IB_SWEEP_TYPES = ['IB_BULLISH', 'IB_BEARISH'];
  const STOP_RANGE = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];

  console.log('\nRunning stop sweep for IB_BULLISH and IB_BEARISH...');
  for (const setupType of IB_SWEEP_TYPES) {
    const tradesQ = await query(`
      SELECT mae_points::float, mfe_points::float, actual_pnl::float, resolution
      FROM active_setups
      WHERE setup_type = $1
        AND mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
        AND mae_points <= 300 AND mfe_points <= 300
        AND status = 'RESOLVED'
        AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
    `, [setupType]);

    if (tradesQ.rows.length < MIN_N) {
      console.log(`  ${setupType} — N=${tradesQ.rows.length} below minimum, skip sweep`);
      continue;
    }

    // Stop sweep: simulate each stop candidate using p75_mfe as an approximate target.
    // We'll then re-run target sweep using the optimal stop to get the true best T1.
    const mfeValues = tradesQ.rows.map(r => +r.mfe_points).sort((a, b) => a - b);
    const p75mfe = mfeValues[Math.floor(mfeValues.length * 0.75)] || DEFAULT_TARGET;

    let bestStop = null, bestStopEV = -Infinity;
    const sweepLog = [];
    for (const S of STOP_RANGE) {
      let evSum = 0;
      for (const r of tradesQ.rows) {
        const mae = +r.mae_points, mfe = +r.mfe_points;
        if (mae > S)          evSum += -S * 2;
        else if (mfe >= p75mfe) evSum += p75mfe * 2;
        else                  evSum += +r.actual_pnl;
      }
      const ev = evSum / tradesQ.rows.length;
      sweepLog.push({ S, ev });
      if (ev > bestStopEV) { bestStopEV = ev; bestStop = S; }
    }

    // Target sweep using the sweep-optimal stop, capped at p75_mfe to avoid ceiling artifact
    const sweepTarget = sweepOptimalTarget(tradesQ.rows, bestStop, p75mfe) || p75mfe;

    console.log(`  ${setupType} stop-sweep (approx target=${p75mfe}pt, N=${tradesQ.rows.length}):`);
    sweepLog.forEach(({ S, ev }) => {
      const marker = S === bestStop ? ' ← OPTIMAL' : '';
      console.log(`    stop=${S}pt → EV=$${ev.toFixed(0)}${marker}`);
    });
    console.log(`  ${setupType} target-sweep (stop=${bestStop}pt) → optimal T1=${sweepTarget}pt`);

    // Upsert with sweep-optimal stop AND sweep-optimal target (overrides main loop row)
    const base = rows.find(r => r.setup_type === setupType);
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
      setupType,
      base ? parseInt(base.n) : tradesQ.rows.length,
      base ? parseFloat(base.wr) / 100 : 0,
      base ? parseFloat(base.ev) : bestStopEV,
      base ? parseFloat(base.p50_mae) : null,
      base ? parseFloat(base.p75_mae) : null,
      base ? parseFloat(base.p50_mfe) : null,
      base ? parseFloat(base.p75_mfe) : null,
      bestStop,    // EV-sweep stop (not p75_mae)
      sweepTarget, // EV-sweep target (not p75_mfe)
    ]);
    console.log(`  → Upserted OPTIMAL_STOP for ${setupType}: stop=${bestStop}pt t1=${sweepTarget}pt`);
  }

  console.log('\nStop sweep complete.');
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
