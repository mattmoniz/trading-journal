// Round 2 of the same-day repair (repair_early_touch_backfill_cluster_tagging_20260908.mjs).
// That script's marker (historical_avg_pnl IS NOT NULL AND size_multiplier IS NULL AND
// cluster_touch_id IS NULL) missed a real subset: the early-touch-backfill loop
// (server/routes/acd.js ~line 7936, feeding the `backfilledTouches` array) sets
// historical_avg_pnl from the touched level's own calibrated EV (`lv.ev`) -- for a THIN_N type
// with no calibration yet (exactly the OR-length family this was caught on:
// OR15_MID_FADE_SHORT/OR30_MID_FADE_SHORT sharing a price+timestamp today), `lv.ev` is itself
// null, so historical_avg_pnl lands null too and round 1's marker silently skipped these rows.
// User-caught live: "why did the OR trades today have the same execution prices."
//
// More complete marker: every row from this mechanism carries the literal
// `t1_label LIKE '%(backfilled early touch)%'` suffix (server/routes/acd.js line ~7987),
// regardless of whether the touched level had a real calibrated EV -- this is a superset of
// round 1's population, not a different one (round 1's 43 already-tagged rows are excluded via
// `cluster_touch_id IS NULL`).
//
// Same protocol as round 1: dry-run + count first (default), --apply to write, backup before
// any write.
import { query } from '../server/db.js';
import { randomUUID } from 'crypto';

const APPLY = process.argv.includes('--apply');

async function main() {
  const batchesRes = await query(`
    WITH bf AS (
      SELECT id, trade_date, fired_at, setup_type
      FROM active_setups
      WHERE t1_label LIKE '%(backfilled early touch)%' AND cluster_touch_id IS NULL
    )
    SELECT trade_date, fired_at, array_agg(id ORDER BY id) as ids, array_agg(setup_type ORDER BY id) as types
    FROM bf GROUP BY trade_date, fired_at HAVING COUNT(*) >= 2
    ORDER BY trade_date, fired_at
  `);

  console.log(`Found ${batchesRes.rows.length} backfill batches (round 2 marker, 2+ untagged rows sharing the same trade_date+fired_at).`);
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

  const allIds = batchesRes.rows.flatMap(b => b.ids);
  await query(`
    CREATE TABLE active_setups_early_touch_backfill_cluster_repair_round2_backup_20260908 AS
    SELECT * FROM active_setups WHERE id = ANY($1)
  `, [allIds]);
  console.log(`Backed up ${allIds.length} rows to active_setups_early_touch_backfill_cluster_repair_round2_backup_20260908.`);

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

  const check = await query(`
    SELECT id, setup_type, is_cluster_primary, cluster_touch_id FROM active_setups WHERE id = ANY($1) ORDER BY id
  `, [batchesRes.rows[0].ids]);
  console.log('\nVerification (first batch):');
  console.table(check.rows);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
