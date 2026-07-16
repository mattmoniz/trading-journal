// Second half of the 2026-07-16 trades-timezone repair (see repair_trades_timezone_shift.mjs
// for part 1). Run ONLY after that script has completed successfully.
//
// On 2026-06-09 at 11:00 AM, 4,100 already-imported pre-06-09 trades got re-imported
// through the (by-then ambient-timezone-buggy) parser, creating a shifted duplicate of
// each. After repair_trades_timezone_shift.mjs corrects the originals onto the same
// convention the duplicates already had, each pair becomes byte-identical on
// (account, direction, quantity, pnl, entry_time, exit_time). This deletes the duplicate
// copy (the one created in the 2026-06-09 10:00-12:00 batch), keeping the original.
//
// Matching is done entirely in SQL (not per-row JS round-trips through `pg`'s Date-object
// serialization for `timestamp without time zone`, which produced spurious zero matches
// when tried — safer and simpler to let Postgres compare its own native values directly).
import { query } from '../server/db.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  const { rows: matchCount } = await query(`
    WITH batch AS (
      SELECT id, entry_time, exit_time, custom_fields->>'account' as account, direction, quantity, pnl
      FROM trades WHERE created_at >= '2026-06-09 10:00' AND created_at < '2026-06-09 12:00'
    )
    SELECT COUNT(DISTINCT b.id) as n
    FROM batch b
    JOIN trades o ON o.custom_fields->>'account' = b.account
      AND o.direction = b.direction AND o.quantity = b.quantity AND o.pnl = b.pnl
      AND o.entry_time = b.entry_time AND o.exit_time = b.exit_time
      AND o.created_at < '2026-06-09'
      AND o.id != b.id
  `);
  const n = parseInt(matchCount[0].n, 10);
  console.log(`Found ${n} batch rows with a now-exact-matching original.`);

  if (n !== 4100) {
    console.warn(`⚠️ Expected 4100 based on prior verification — got ${n}. Stopping without deleting; investigate before re-running.`);
    return;
  }

  const { rows: idsRows } = await query(`
    WITH batch AS (
      SELECT id, entry_time, exit_time, custom_fields->>'account' as account, direction, quantity, pnl
      FROM trades WHERE created_at >= '2026-06-09 10:00' AND created_at < '2026-06-09 12:00'
    )
    SELECT DISTINCT b.id
    FROM batch b
    JOIN trades o ON o.custom_fields->>'account' = b.account
      AND o.direction = b.direction AND o.quantity = b.quantity AND o.pnl = b.pnl
      AND o.entry_time = b.entry_time AND o.exit_time = b.exit_time
      AND o.created_at < '2026-06-09'
      AND o.id != b.id
  `);
  const ids = idsRows.map(r => r.id);

  if (!DRY_RUN) {
    const { rowCount } = await query(`DELETE FROM trades WHERE id = ANY($1::int[])`, [ids]);
    console.log(`Deleted ${rowCount} duplicate rows.`);
  } else {
    console.log(`[DRY RUN] Would delete ${ids.length} rows.`);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
