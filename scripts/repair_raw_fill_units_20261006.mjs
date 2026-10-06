// Repair (2026-10-06, user-approved): converts order_placements.avg_fill_price rows still holding the
// broker's RAW integer price (e.g. 3043725) to real prices, rounded to the MNQ tick. Backs the rows up
// first, in the same transaction. Idempotent: only rows still above 1,000,000 are touched.
import { getClient, query } from '../server/db.js';
import { applyPriceMultiplier, toTickPrice } from '../server/services/sierraChart/priceMultiplier.js';
const MULT = 0.00999999776482582;
const BACKUP = 'order_placements_rawunit_repair_backup_20261006';
const c = await getClient();
try {
  await c.query('BEGIN');
  await c.query(`CREATE TABLE IF NOT EXISTS ${BACKUP} AS SELECT * FROM order_placements WHERE avg_fill_price > 1000000 AND submitted_at >= '2026-09-28' WITH NO DATA`);
  const ins = await c.query(`INSERT INTO ${BACKUP} SELECT * FROM order_placements WHERE avg_fill_price > 1000000 AND submitted_at >= '2026-09-28' AND id NOT IN (SELECT id FROM ${BACKUP})`);
  const rows = (await c.query(`SELECT id, avg_fill_price::float AS raw FROM order_placements WHERE avg_fill_price > 1000000 AND submitted_at >= '2026-09-28' ORDER BY id`)).rows;
  for (const r of rows) {
    const fixed = toTickPrice(applyPriceMultiplier(r.raw, MULT));
    await c.query(`UPDATE order_placements SET avg_fill_price = $2 WHERE id = $1`, [r.id, fixed]);
  }
  await c.query('COMMIT');
  console.log(`backed up ${ins.rowCount} row(s); converted ${rows.length} row(s).`);
} catch (e) {
  await c.query('ROLLBACK'); console.error('ROLLED BACK:', e.message); process.exit(1);
} finally { c.release?.(); }
const left = await query(`SELECT count(*)::int n FROM order_placements WHERE avg_fill_price > 1000000`);
console.log('rows still in raw units:', left.rows[0].n);
process.exit(0);
