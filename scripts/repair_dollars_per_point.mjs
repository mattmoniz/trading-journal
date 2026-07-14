// repair_dollars_per_point.mjs
//
// Fixes a $/pt error found 2026-07-14 while investigating the update_optimal_stops.mjs
// fix: scripts/archive/backfill_level_fades.js (source of every resolution_method='BACKFILL'
// row in active_setups, propagated into every repair_*.mjs script written today) used
// `PT = 5; // $ per NQ point` -- but the live resolution path (server/routes/acd.js ~line 155)
// is explicit: `const PNL_PER_POINT = 2; // MNQ = $2/point`, and $2/pt is the real, correct
// value for a Micro E-mini Nasdaq contract (verified against real CME specs). $5/pt matches
// neither MNQ ($2) nor standard NQ ($20) -- an uncaught error in the archived script, not a
// deliberate convention. User confirmed $2/pt (MNQ) is correct.
//
// This does NOT require re-running any of today's detection/resolution logic -- the point
// distances (stop_level, t1_level, entry_zone_low) are all still correct, only the dollar
// conversion applied to them was wrong. Rescales actual_pnl directly from those stored point
// distances using the correct $2/pt, $1 commission (matching acd.js's live COMMISSION=1)
// formula. Verified this reconstructs the exact original (wrong) values before running for
// real: TARGET_HIT actual_pnl == ROUND(t1Dist*5-5,2), STOP_HIT actual_pnl == ROUND(-stopDist*5-5,2)
// for every spot-checked row.
//
// Scope: only resolution_method='BACKFILL' rows. Confirmed via direct query that
// resolution_method='PRICE_CLEAN' (200 rows, the live-resolved path) and NULL/SAME_BAR_STOP_FIRST
// (1,308 rows, pre-existing) already correctly imply ~$2/pt -- not touched by this script.
//
// Run: node scripts/repair_dollars_per_point.mjs [--dry-run]

import { query } from '../server/db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const DPP = 2;   // $ per point, MNQ -- matches acd.js's live PNL_PER_POINT
const COMM = 1;  // $ round-trip commission -- matches acd.js's live COMMISSION

console.log(`Repair $/pt for BACKFILL rows${DRY_RUN ? ' [DRY RUN]' : ''}`);

if (!DRY_RUN) {
  await query(`DROP TABLE IF EXISTS active_setups_pnl_rescale_backup_20260714`);
  await query(`
    CREATE TABLE active_setups_pnl_rescale_backup_20260714 AS
    SELECT id, setup_type, resolution, actual_pnl FROM active_setups WHERE resolution_method = 'BACKFILL'
  `);
  const cnt = await query(`SELECT COUNT(*) FROM active_setups_pnl_rescale_backup_20260714`);
  console.log(`Backed up ${cnt.rows[0].count} rows`);
}

// Preview: how many rows, and the magnitude of change, before touching anything
const previewRes = await query(`
  SELECT
    COUNT(*) FILTER (WHERE resolution IN ('TARGET_HIT','STOP_HIT'))                        AS n_affected,
    ROUND(AVG(actual_pnl) FILTER (WHERE resolution='TARGET_HIT')::numeric, 2)               AS avg_old_target_pnl,
    ROUND(AVG(ABS(t1_level - entry_zone_low) * ${DPP} - ${COMM}) FILTER (WHERE resolution='TARGET_HIT')::numeric, 2) AS avg_new_target_pnl,
    ROUND(AVG(actual_pnl) FILTER (WHERE resolution='STOP_HIT')::numeric, 2)                 AS avg_old_stop_pnl,
    ROUND(AVG(-ABS(entry_zone_low - stop_level) * ${DPP} - ${COMM}) FILTER (WHERE resolution='STOP_HIT')::numeric, 2) AS avg_new_stop_pnl
  FROM active_setups
  WHERE resolution_method = 'BACKFILL'
    AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
`);
console.log('Preview:', JSON.stringify(previewRes.rows[0], null, 2));

if (!DRY_RUN) {
  const res = await query(`
    UPDATE active_setups
    SET actual_pnl = CASE
        WHEN resolution = 'TARGET_HIT' THEN ROUND((ABS(t1_level - entry_zone_low) * ${DPP} - ${COMM})::numeric, 2)
        WHEN resolution = 'STOP_HIT'   THEN ROUND((-ABS(entry_zone_low - stop_level) * ${DPP} - ${COMM})::numeric, 2)
        ELSE actual_pnl
      END
    WHERE resolution_method = 'BACKFILL'
      AND resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
  `);
  console.log(`Updated ${res.rowCount} rows`);
}

process.exit(0);
