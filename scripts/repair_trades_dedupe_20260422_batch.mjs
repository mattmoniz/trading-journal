// Separate duplication issue from the June-9 timezone-shift bug, found while verifying
// that repair (2026-07-16). 1,168 rows created in the 2026-04-22 batch are exact
// duplicates (same account/direction/quantity/pnl/entry_time/exit_time, no time offset)
// of a row from the original 2026-03-11 mass-import. Root cause not investigated (likely
// a re-run backfill/import script) — this only removes the duplicate copies, keeping the
// earlier (2026-03-11) original.
import { query } from '../server/db.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  const { rows: idsRows } = await query(`
    SELECT DISTINCT b.id
    FROM trades a
    JOIN trades b ON b.custom_fields->>'account' = a.custom_fields->>'account'
      AND b.direction = a.direction AND b.quantity = a.quantity AND b.pnl = a.pnl
      AND b.entry_time = a.entry_time AND b.exit_time = a.exit_time
      AND b.id != a.id
    WHERE a.created_at >= '2026-03-11' AND a.created_at < '2026-03-12'
      AND b.created_at >= '2026-04-22' AND b.created_at < '2026-04-23'
  `);
  const ids = idsRows.map(r => r.id);
  console.log(`Found ${ids.length} April-22 duplicate rows (expected 1168).`);

  if (ids.length !== 1168) {
    console.warn(`⚠️ Count mismatch — stopping without deleting; investigate before re-running.`);
    return;
  }

  const { rows: screenshotCheck } = await query(
    `SELECT COUNT(*) as n FROM trade_screenshots WHERE trade_id = ANY($1::int[])`, [ids]
  );
  if (parseInt(screenshotCheck[0].n, 10) > 0) {
    console.warn(`⚠️ ${screenshotCheck[0].n} of these rows have attached screenshots — stopping, needs manual review.`);
    return;
  }

  if (!DRY_RUN) {
    const { rowCount } = await query(`DELETE FROM trades WHERE id = ANY($1::int[])`, [ids]);
    console.log(`Deleted ${rowCount} duplicate rows.`);
  } else {
    console.log(`[DRY RUN] Would delete ${ids.length} rows.`);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
