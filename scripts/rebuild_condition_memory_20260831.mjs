// One-time rebuild of condition_memory (resolves OPEN_DECISION
// condition_memory_needs_rebuild_not_backfill). Historical occurrences/wins/losses/total_pnl
// were inflated up to ~6x by a since-removed redundant setInterval that called
// updateConditionMemory() multiple times per day (fixed 2026-08-19 with an idempotency guard
// on `last_seen`). The guard prevents NEW corruption but does nothing to un-corrupt the
// counters already accumulated before it existed -- confirmed live: sum(occurrences)=1088
// across 31 rows vs. only 343 real qualifying daily_performance_log rows (~3.2x inflated in
// aggregate, worse in some buckets than others depending on how many times each specific date
// got double-processed before the fix).
//
// Rebuild strategy (not a backfill/patch): wipe condition_memory and replay every qualifying
// daily_performance_log date chronologically through the now-idempotent updateConditionMemory().
// This can only produce a correct result because the pipeline gap that stalled
// daily_performance_log itself was fixed earlier the same session (2026-08-03/08-12 backfilled) --
// rebuilding from a source that was itself still broken would just re-encode a fresh gap, per
// this decision's own original sequencing note.
import { query } from '../server/db.js';
import { updateConditionMemory } from '../server/services/patternMemoryUpdate.js';

async function main() {
  const before = await query(`SELECT COUNT(*) as rows, SUM(occurrences) as sum_occ FROM condition_memory`);
  console.log(`Before: ${before.rows[0].rows} rows, sum(occurrences)=${before.rows[0].sum_occ}`);

  const datesRes = await query(`
    SELECT trade_date::text as trade_date FROM daily_performance_log
    WHERE sufficient_session_data = true
    ORDER BY trade_date ASC
  `);
  console.log(`Replaying ${datesRes.rows.length} qualifying dates chronologically...`);

  await query(`DELETE FROM condition_memory`);

  let processed = 0;
  for (const row of datesRes.rows) {
    await updateConditionMemory(row.trade_date);
    processed++;
  }
  console.log(`Replayed ${processed} dates.`);

  const after = await query(`SELECT COUNT(*) as rows, SUM(occurrences) as sum_occ, MIN(first_seen) as min_fs, MAX(last_seen) as max_ls FROM condition_memory`);
  console.log(`After: ${after.rows[0].rows} rows, sum(occurrences)=${after.rows[0].sum_occ}, first_seen=${after.rows[0].min_fs}, last_seen=${after.rows[0].max_ls}`);

  const expected = datesRes.rows.length;
  const actual = parseInt(after.rows[0].sum_occ);
  if (actual !== expected) {
    console.error(`MISMATCH: expected sum(occurrences)=${expected} (one per qualifying date), got ${actual}. Investigate before trusting the rebuild.`);
    process.exit(1);
  }
  console.log(`VERIFIED: sum(occurrences)=${actual} exactly matches ${expected} qualifying daily_performance_log dates -- no double-counting, no dropped dates.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
