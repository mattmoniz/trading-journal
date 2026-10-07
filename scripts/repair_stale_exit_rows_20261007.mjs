// One-time repair (2026-10-07, wiring item 8). EXIT rows 127681/127693 read OPEN in the app while
// the broker shows no matching exit and the account was flat. Backs up the rows, then marks them
// UNRESOLVED_BROKER_ABSENT (not a fill, not a cancel, which the broker does not confirm).
// Usage: node scripts/repair_stale_exit_rows_20261007.mjs [--apply]   (default is dry run)
import { query } from '../server/db.js';

const apply = process.argv.includes('--apply');
const IDS = [4, 16];
const BACKUP = 'order_placements_stale_exit_backup_20261007';

const rows = await query(`SELECT * FROM order_placements WHERE id = ANY($1) AND purpose = 'EXIT' AND status = 'OPEN' AND filled_quantity = 0`, [IDS]);
console.log(`matched ${rows.rows.length} of ${IDS.length} expected rows:`, rows.rows.map(r => [r.id, r.setup_id, r.status]));
if (rows.rows.length !== IDS.length) { console.error('ABORT: expected rows not in the expected state.'); process.exit(1); }
if (!apply) { console.log('dry run -- rerun with --apply to back up and update.'); process.exit(0); }

await query('BEGIN');
try {
  await query(`CREATE TABLE IF NOT EXISTS ${BACKUP} AS SELECT * FROM order_placements WHERE false`);
  await query(`INSERT INTO ${BACKUP} SELECT * FROM order_placements WHERE id = ANY($1)`, [IDS]);
  const upd = await query(`UPDATE order_placements SET status = 'UNRESOLVED_BROKER_ABSENT' WHERE id = ANY($1) AND purpose = 'EXIT' AND status = 'OPEN' AND filled_quantity = 0`, [IDS]);
  if (upd.rowCount !== IDS.length) throw new Error(`updated ${upd.rowCount}, expected ${IDS.length}`);
  await query('COMMIT');
  console.log(`updated ${upd.rowCount} rows; backup in ${BACKUP}`);
} catch (err) {
  await query('ROLLBACK');
  console.error('ROLLED BACK:', err.message);
  process.exit(1);
}
process.exit(0);
