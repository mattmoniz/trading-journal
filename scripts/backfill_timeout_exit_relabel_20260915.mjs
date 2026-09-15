// One-time migration for OPEN_DECISION real_trade_filter_mtm_exclusion_undercounts_20260914.
// Relabels historical POC_ROTATION_JOIN_LONG/SHORT and IB_LOW_PNR_SHORT rows that resolved via
// their designed 60min/hold-to-close timeout (resolution='TIME_EXPIRED',
// resolution_method='MARK_TO_MARKET') to the new resolution_method='TIMEOUT_EXIT' -- the same
// relabel resolveSetups.js's live code now writes going forward (server/services/
// resolveSetups.js, the POC_ROTATION_JOIN and IB_LOW_PNR branches). Without this backfill, only
// FUTURE fires would get the corrected label and REAL_TRADE_FILTER would keep undercounting the
// 27/27 historical rows that motivated this fix in the first place.
//
// Deliberately scoped to ONLY these two setup_type families' TIME_EXPIRED/MARK_TO_MARKET rows --
// per DeepSeek's design critique, every OTHER setup_type's MARK_TO_MARKET rows are a genuine
// "ran out of session time" case (the generic force-close in resolveSetups.js/setupExpiry.js)
// and must stay excluded. FAILED_SWEEP_REVERSAL_LONG/SHORT is explicitly NOT touched here --
// its 0-for-117 TARGET_HIT rate is evidence of a miscalibrated target, not a designed timeout
// exit, and relabeling it would re-open the exact distortion (uncapped MTM P&L with no stop)
// REAL_TRADE_FILTER's 2026-08-11 exclusion was built to prevent. See that OPEN_DECISION's
// resolution text (once resolved) for the target-calibration follow-up this should get instead.
//
// Per docs/DB_MIGRATION_PROTOCOL.md: dry-run first (default), backup before the UPDATE,
// --commit required to actually write.
import { query } from '../server/db.js';

const TARGET_TYPES = ['POC_ROTATION_JOIN_LONG', 'POC_ROTATION_JOIN_SHORT', 'IB_LOW_PNR_SHORT'];
const COMMIT = process.argv.includes('--commit');
const BACKUP_TABLE = 'active_setups_timeout_exit_relabel_backup_20260915';

async function main() {
  const check = await query(`
    SELECT id, setup_type, trade_date::text, origin_status, resolution, resolution_method, actual_pnl
    FROM active_setups
    WHERE setup_type = ANY($1) AND resolution = 'TIME_EXPIRED' AND resolution_method = 'MARK_TO_MARKET'
    ORDER BY id
  `, [TARGET_TYPES]);
  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} -- ${check.rows.length} rows matched (setup_type IN ${JSON.stringify(TARGET_TYPES)}, resolution='TIME_EXPIRED', resolution_method='MARK_TO_MARKET')`);
  const byType = {};
  for (const r of check.rows) byType[r.setup_type] = (byType[r.setup_type] || 0) + 1;
  console.log('By setup_type:', byType);
  const byOrigin = {};
  for (const r of check.rows) byOrigin[r.origin_status] = (byOrigin[r.origin_status] || 0) + 1;
  console.log('By origin_status:', byOrigin);

  if (!check.rows.length) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  if (!COMMIT) {
    console.log(`[dry-run] Would create backup table ${BACKUP_TABLE} with ${check.rows.length} rows.`);
    console.log(`[dry-run] Would UPDATE ${check.rows.length} rows SET resolution_method='TIMEOUT_EXIT'.`);
    console.log('Re-run with --commit to actually write.');
    process.exit(0);
    return;
  }

  const ids = check.rows.map(r => r.id);
  await query(`
    CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} AS
    SELECT * FROM active_setups WHERE id = ANY($1) AND false
  `, [ids]);
  await query(`INSERT INTO ${BACKUP_TABLE} SELECT * FROM active_setups WHERE id = ANY($1)`, [ids]);
  const backupCount = await query(`SELECT COUNT(*)::int n FROM ${BACKUP_TABLE}`);
  console.log(`Backed up ${backupCount.rows[0].n} rows to ${BACKUP_TABLE}.`);

  const upd = await query(`
    UPDATE active_setups SET resolution_method = 'TIMEOUT_EXIT', updated_at = NOW()
    WHERE id = ANY($1) RETURNING id
  `, [ids]);
  console.log(`Updated ${upd.rows.length} rows.`);

  const verify = await query(`SELECT COUNT(*)::int n FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'TIMEOUT_EXIT'`, [TARGET_TYPES]);
  console.log(`Verify: ${verify.rows[0].n} rows now show resolution_method='TIMEOUT_EXIT' for these 3 setup_types.`);
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
