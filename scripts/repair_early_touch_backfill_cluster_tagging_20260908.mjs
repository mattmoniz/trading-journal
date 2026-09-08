// Repairs historical EARLY_TOUCH_BACKFILL rows that were inserted before this same-day fix
// (server/routes/acd.js's backfill loop, ~line 8891) started generating cluster_touch_id/
// is_cluster_primary -- found live by the user asking "did you check all clusters, what about
// 9:30am" after the quick-check.html Net P&L fix. That earlier fix corrected overcounting from
// the OTHER 3 insert paths (main candidate, sibling touch-credit, suppressed-audit); this repair
// covers the 4th, previously-undiscovered gap: multiple levels backfilled together in one poll
// (most commonly at the session open, when price already sits inside several levels' zones
// before regular per-poll detection gets a chance to run) never got tagged as a cluster at all,
// so every one of them counts as an independent "primary" row in any is_cluster_primary-aware
// aggregation -- including the just-fixed quick-check.html stats.
//
// Marker for a backfill-origin row: historical_avg_pnl IS NOT NULL (only this insert path sets
// it) AND size_multiplier IS NULL (rules out the main candidate path, which also sets
// historical_avg_pnl) AND cluster_touch_id IS NULL (not already tagged, i.e. predates the fix).
// A "batch" = 2+ such rows sharing the exact same (trade_date, fired_at) -- these were all
// inserted together in the same poll's backfilledTouches loop. First row by id (insertion
// order, matching the live fix's btIdx===0 convention) is tagged primary; the rest get
// is_cluster_primary=false + a shared new cluster_touch_id.
//
// Per docs/DB_MIGRATION_PROTOCOL.md: dry-run + count first (default), --apply to write,
// backup table created before any write.
import { query } from '../server/db.js';
import { randomUUID } from 'crypto';

const APPLY = process.argv.includes('--apply');

async function main() {
  const batchesRes = await query(`
    WITH bf AS (
      SELECT id, trade_date, fired_at, setup_type
      FROM active_setups
      WHERE historical_avg_pnl IS NOT NULL AND size_multiplier IS NULL AND cluster_touch_id IS NULL
    )
    SELECT trade_date, fired_at, array_agg(id ORDER BY id) as ids, array_agg(setup_type ORDER BY id) as types
    FROM bf GROUP BY trade_date, fired_at HAVING COUNT(*) >= 2
    ORDER BY trade_date, fired_at
  `);

  console.log(`Found ${batchesRes.rows.length} backfill batches (2+ untagged rows sharing the same trade_date+fired_at).`);
  let totalRows = 0;
  for (const b of batchesRes.rows) {
    totalRows += b.ids.length;
    console.log(`  ${b.trade_date} ${b.fired_at.toISOString ? b.fired_at.toISOString() : b.fired_at}: ${b.ids.length} rows -- ${b.types.join(', ')}`);
  }
  console.log(`Total rows to tag: ${totalRows}`);

  if (!APPLY) {
    console.log('\nDRY RUN ONLY -- re-run with --apply to write. No backup or changes made yet.');
    process.exit(0);
  }

  // Backup before any write, per DB_MIGRATION_PROTOCOL.md.
  const allIds = batchesRes.rows.flatMap(b => b.ids);
  await query(`
    CREATE TABLE active_setups_early_touch_backfill_cluster_repair_backup_20260908 AS
    SELECT * FROM active_setups WHERE id = ANY($1)
  `, [allIds]);
  console.log(`Backed up ${allIds.length} rows to active_setups_early_touch_backfill_cluster_repair_backup_20260908.`);

  let updated = 0;
  for (const b of batchesRes.rows) {
    const touchId = randomUUID();
    const primaryId = b.ids[0];
    const siblingIds = b.ids.slice(1);
    await query(`UPDATE active_setups SET cluster_touch_id=$2, is_cluster_primary=true WHERE id=$1`, [primaryId, touchId]);
    if (siblingIds.length) {
      await query(`UPDATE active_setups SET cluster_touch_id=$2, is_cluster_primary=false WHERE id = ANY($1)`, [siblingIds, touchId]);
    }
    updated += b.ids.length;
  }
  console.log(`\nApplied: ${updated} rows tagged across ${batchesRes.rows.length} batches.`);

  // Verify: read back one batch to confirm.
  const check = await query(`
    SELECT id, setup_type, is_cluster_primary, cluster_touch_id FROM active_setups WHERE id = ANY($1) ORDER BY id
  `, [batchesRes.rows[0].ids]);
  console.log('\nVerification (first batch):');
  console.table(check.rows);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
