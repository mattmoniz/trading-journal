// Third and final pass of the 2026-07-16 trades dedup (see repair_trades_timezone_shift.mjs,
// repair_trades_dedupe_20260609_batch.mjs, repair_trades_dedupe_20260422_batch.mjs for the
// first two). After those, 3,769 rows across the table's full history (back to 2024-11-18)
// still exact-match another row on (account, direction, quantity, pnl, entry_time, exit_time)
// — two big clusters (self-duplicates within the 2026-03-11 and 2026-04-22 mass-import
// batches) plus a long scattered tail across 36 other dates. Root cause of the scattered
// tail not individually investigated — this is a single generic pass across the whole
// table rather than a per-date fix, since the duplicate signature (account + direction +
// quantity + exact pnl to the cent + entry/exit time to the second) is reliable regardless
// of which date/batch produced it.
//
// Deliberately excludes NULL-pnl / zero-duration (entry_time == exit_time) rows — those
// look like a different, lower-confidence case (possibly non-fill activity-log-style
// markers, not real duplicated trades) and are left untouched pending separate review.
import { query } from '../server/db.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  const { rows: idsRows } = await query(`
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY custom_fields->>'account', direction, quantity, pnl, entry_time, exit_time
        ORDER BY id
      ) as rn
      FROM trades
      WHERE pnl IS NOT NULL AND entry_time != exit_time
    ) t WHERE rn > 1
  `);
  const ids = idsRows.map(r => r.id);
  console.log(`Found ${ids.length} duplicate rows to remove (keeping the lowest id in each group).`);

  const { rows: screenshotCheck } = await query(
    `SELECT trade_id, COUNT(*) FROM trade_screenshots WHERE trade_id = ANY($1::int[]) GROUP BY trade_id`, [ids]
  );
  if (screenshotCheck.length > 0) {
    console.warn(`⚠️ ${screenshotCheck.length} of these rows have attached screenshots — excluding them from deletion, needs manual review:`);
    console.warn(screenshotCheck.map(r => r.trade_id));
  }
  const screenshotIds = new Set(screenshotCheck.map(r => r.trade_id));
  const safeIds = ids.filter(id => !screenshotIds.has(id));

  if (!DRY_RUN) {
    const { rowCount } = await query(`DELETE FROM trades WHERE id = ANY($1::int[])`, [safeIds]);
    console.log(`Deleted ${rowCount} duplicate rows (${ids.length - safeIds.length} skipped due to screenshots).`);
  } else {
    console.log(`[DRY RUN] Would delete ${safeIds.length} rows (${ids.length - safeIds.length} would be skipped due to screenshots).`);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
