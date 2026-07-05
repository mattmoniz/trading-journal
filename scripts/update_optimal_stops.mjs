// =============================================================================
// Compute per-setup-type optimal stops from active_setups MAE data and persist
// to performance_audit. Run weekly after backfill_mae_mfe or the main audit.
//
// Writes signal_type='OPTIMAL_STOP' rows — one per setup_type direction.
// The live path reads these to set stop/target distances dynamically.
// =============================================================================

import { query } from '../server/db.js';

// Minimum N before we trust a computed optimal stop
const MIN_N = 20;
const DEFAULT_STOP = 65;
const DEFAULT_TARGET = 35;

async function main() {
  console.log('Computing optimal stops from active_setups MAE data...');

  // 1. Compute p75_mae (optimal stop) and p50_mfe (optimal target) per setup_type
  //    Only resolved trades with clean MAE data; exclude EXPIRED (they inflate MAE/MFE)
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
      AND status         = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
    GROUP BY setup_type
    HAVING COUNT(*) >= ${MIN_N}
    ORDER BY setup_type
  `);

  const rows = statsRes.rows;
  console.log(`Found ${rows.length} setup types with N≥${MIN_N}`);

  let upserted = 0;
  for (const r of rows) {
    const optStop   = Math.round(parseFloat(r.p75_mae) || DEFAULT_STOP);
    const optTarget = Math.round(parseFloat(r.p50_mfe) || DEFAULT_TARGET);

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
    console.log(`  ${r.setup_type.padEnd(40)} stop=${optStop}pt  t1=${optTarget}pt  WR=${r.wr}%  N=${r.n}  EV=$${r.ev}`);
  }

  console.log(`\nDone. ${upserted} rows upserted into performance_audit (signal_type=OPTIMAL_STOP).`);
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
