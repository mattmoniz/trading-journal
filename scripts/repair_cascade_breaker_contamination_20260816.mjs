// repair_cascade_breaker_contamination_20260816.mjs
//
// Resolves OPEN_DECISION cascade_breaker_historical_rows_need_repair (HIGH). The
// 2026-08-16 live-firing audit (F1, commit 303b181) fixed the cascade-breaker "audit"
// insert going forward -- it now writes a terminal, level-less marker instead of a
// full resolvable row -- but did NOT touch the 1,072 already-inserted CASCADE_BREAKER
// rows from before that fix. Those rows still have the OLD shape (real entry/stop/
// target, resolved via the normal price-walk with genuine actual_pnl) and are still
// counted by backtest_setup_status.mjs's real_n/real_ev query
// (origin_status IN ('ACTIVE','SHADOW') AND resolution IN ('TARGET_HIT','STOP_HIT',
// 'TIME_EXPIRED')) for every setup_type they touched -- e.g. RTH_VWAP_FADE_LONG had
// 53 of its "real" trades be phantom cascade-breaker audit rows, not real fires.
//
// These rows were never a real fire decision (suppression_reason='CASCADE_BREAKER' is
// logging-only, never shown to the user as a live alert) and contribute nothing except
// contamination -- per the OPEN_DECISION's own framing, deletion (not migrate-in-place)
// is the cleaner fix. Full provenance is preserved via the backup table.
//
// Run: node scripts/repair_cascade_breaker_contamination_20260816.mjs [--dry-run]

import { query } from '../server/db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BACKUP_TABLE = 'active_setups_cascade_breaker_repair_backup_20260816';
const TIMELINE_BACKUP_TABLE = 'trade_timeline_events_cascade_breaker_repair_backup_20260816';

async function main() {
  const targets = await query(`
    SELECT id, setup_type, status, resolution, resolution_method, origin_status, actual_pnl::float
    FROM active_setups
    WHERE suppression_reason = 'CASCADE_BREAKER'
    ORDER BY setup_type, id
  `);
  console.log(`Found ${targets.rows.length} CASCADE_BREAKER rows${DRY_RUN ? ' [DRY RUN]' : ''}`);

  // Matches backtest_setup_status.mjs's real_n filter exactly: origin_status IN
  // ('ACTIVE','SHADOW') AND resolution IN (...) AND resolution_method NOT IN
  // ('MARK_TO_MARKET','RECOVERY_MTM') -- rows already MTM-resolved don't count toward
  // real_n today, so deleting them doesn't change real_n (still correct to remove them,
  // just not part of the "how many real_n change" number below).
  const byType = {};
  let countsTowardRealN = 0;
  for (const r of targets.rows) {
    byType[r.setup_type] = (byType[r.setup_type] ?? 0) + 1;
    const inRealN = ['ACTIVE', 'SHADOW'].includes(r.origin_status)
      && ['TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED'].includes(r.resolution)
      && !['MARK_TO_MARKET', 'RECOVERY_MTM'].includes(r.resolution_method);
    if (inRealN) countsTowardRealN++;
  }
  console.log(`  ${countsTowardRealN} of these currently count toward SETUP_STATUS's real_n/real_ev`);
  console.log('  Top affected setup_types:');
  Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .forEach(([t, n]) => console.log(`    ${t}: ${n}`));

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes made. Re-run without --dry-run to execute.');
    return;
  }

  await query(`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} AS
    SELECT * FROM active_setups WHERE suppression_reason = 'CASCADE_BREAKER'`);
  const backupCount = await query(`SELECT COUNT(*) as n FROM ${BACKUP_TABLE}`);
  console.log(`\nBacked up ${backupCount.rows[0].n} rows to ${BACKUP_TABLE}`);
  if (Number(backupCount.rows[0].n) !== targets.rows.length) {
    throw new Error(`Backup count (${backupCount.rows[0].n}) doesn't match target count (${targets.rows.length}) -- aborting delete`);
  }

  // Discovered running this script (not anticipated from the original audit): every one
  // of the 1,072 CASCADE_BREAKER rows has a matching trade_timeline_events row (FK
  // trade_timeline_events.setup_id -> active_setups.id), t1_label carrying the literal
  // "(cascade breaker audit)" string -- meaning these phantom rows were reaching the
  // Session Timeline sidebar via the generic dropToTimeline() call inside
  // resolveSetupsByPrice() (any row that resolves gets dropped to the timeline
  // regardless of insert path), not just contaminating real_n. Worth a user-facing note:
  // this repair also removes 1,072 stale Session Timeline entries dated in the past.
  await query(`CREATE TABLE IF NOT EXISTS ${TIMELINE_BACKUP_TABLE} AS
    SELECT t.* FROM trade_timeline_events t
    JOIN active_setups a ON t.setup_id = a.id
    WHERE a.suppression_reason = 'CASCADE_BREAKER'`);
  const timelineBackupCount = await query(`SELECT COUNT(*) as n FROM ${TIMELINE_BACKUP_TABLE}`);
  console.log(`Backed up ${timelineBackupCount.rows[0].n} matching trade_timeline_events rows to ${TIMELINE_BACKUP_TABLE}`);

  const delTimeline = await query(`
    DELETE FROM trade_timeline_events
    WHERE setup_id IN (SELECT id FROM active_setups WHERE suppression_reason = 'CASCADE_BREAKER')
  `);
  console.log(`Deleted ${delTimeline.rowCount} rows from trade_timeline_events`);

  const del = await query(`DELETE FROM active_setups WHERE suppression_reason = 'CASCADE_BREAKER'`);
  console.log(`Deleted ${del.rowCount} rows from active_setups`);

  const remaining = await query(`SELECT COUNT(*) as n FROM active_setups WHERE suppression_reason = 'CASCADE_BREAKER'`);
  console.log(`Remaining CASCADE_BREAKER rows in active_setups: ${remaining.rows[0].n} (expect 0)`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
