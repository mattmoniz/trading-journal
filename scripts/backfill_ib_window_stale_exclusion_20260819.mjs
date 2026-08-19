// One-time migration for OPEN_DECISION ib_bullbear_window_fix_recalibration_needed.
// Tags the 31 real IB_BEARISH trades whose classification changes under the corrected
// 60-min IB window (confirmed via scripts/backtest_ib_window_reclassification_impact.mjs,
// independently re-verified by DeepSeek, user-approved to proceed 2026-08-19 despite the
// affected population clustering on 3 distinct days) so backtest_setup_status.mjs's
// REAL_TRADE_FILTER can exclude them from real_n/real_ev going forward.
//
// Per docs/DB_MIGRATION_PROTOCOL.md: dry-run first (default), backup before the UPDATE,
// --commit required to actually write.
import { query } from '../server/db.js';

const AFFECTED_IDS = [
  65317, 65323, 65358, 65485, 65468, 65448, 65433, 65416, 65330, 65569,
  65526, 65497, 65578, 65390, 65651, // 2026-07-20 (15 rows, became ineligible)
  89410, 89030, 88836, 88762, 89086, 88786, 89066, // 2026-08-07 (7 rows, flipped bullish)
  92209, 91907, 92572, 92858, 93199, 93054, 93305, 93223, 93559, // 2026-08-11 (9 rows, became ineligible)
];
const COMMIT = process.argv.includes('--commit');
const BACKUP_TABLE = 'active_setups_ib_window_backfill_backup_20260819';

async function main() {
  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} -- ${AFFECTED_IDS.length} target row IDs`);

  // Verify the target rows are exactly what's expected before touching anything.
  const check = await query(`
    SELECT id, setup_type, trade_date::text, origin_status, resolution
    FROM active_setups WHERE id = ANY($1)
  `, [AFFECTED_IDS]);
  const wrongType = check.rows.filter(r => r.setup_type !== 'IB_BEARISH');
  if (check.rows.length !== AFFECTED_IDS.length || wrongType.length > 0) {
    console.error(`FATAL: expected ${AFFECTED_IDS.length} IB_BEARISH rows, found ${check.rows.length} rows (${wrongType.length} wrong setup_type). Aborting.`);
    process.exit(1);
  }
  console.log(`Verified: all ${check.rows.length} target IDs are real IB_BEARISH rows.`);

  const colExists = await query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name='active_setups' AND column_name='ib_window_stale_basis'
  `);
  if (colExists.rows.length === 0) {
    if (!COMMIT) {
      console.log('[dry-run] Would run: ALTER TABLE active_setups ADD COLUMN ib_window_stale_basis boolean;');
    } else {
      await query(`ALTER TABLE active_setups ADD COLUMN ib_window_stale_basis boolean`);
      console.log('Added column active_setups.ib_window_stale_basis.');
    }
  } else {
    console.log('Column ib_window_stale_basis already exists (re-run after a prior commit).');
  }

  if (!COMMIT) {
    console.log(`[dry-run] Would create backup table ${BACKUP_TABLE} with ${AFFECTED_IDS.length} rows.`);
    console.log(`[dry-run] Would UPDATE ${AFFECTED_IDS.length} rows SET ib_window_stale_basis=true.`);
    console.log('Re-run with --commit to actually write.');
    process.exit(0);
    return;
  }

  await query(`
    CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} AS
    SELECT * FROM active_setups WHERE id = ANY($1) AND false
  `, [AFFECTED_IDS]); // create empty shell with matching structure if not exists
  await query(`INSERT INTO ${BACKUP_TABLE} SELECT * FROM active_setups WHERE id = ANY($1)`, [AFFECTED_IDS]);
  const backupCount = await query(`SELECT COUNT(*)::int n FROM ${BACKUP_TABLE}`);
  console.log(`Backed up ${backupCount.rows[0].n} rows to ${BACKUP_TABLE}.`);

  const upd = await query(`
    UPDATE active_setups SET ib_window_stale_basis=true, updated_at=NOW()
    WHERE id = ANY($1) RETURNING id
  `, [AFFECTED_IDS]);
  console.log(`Updated ${upd.rows.length} rows.`);

  const verify = await query(`
    SELECT COUNT(*)::int n FROM active_setups WHERE ib_window_stale_basis=true AND setup_type='IB_BEARISH'
  `);
  console.log(`Verify: ${verify.rows[0].n} IB_BEARISH rows now flagged ib_window_stale_basis=true.`);
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
