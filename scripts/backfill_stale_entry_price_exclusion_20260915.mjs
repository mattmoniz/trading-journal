// One-time migration for OPEN_DECISION globex_vwap_fade_stale_price_after_restart_20260914.
// Tags the 9 real active_setups rows confirmed (DeepSeek 3rd pass, 2026-09-15) to have a
// corrupted entry price from two DISTINCT, now-understood mechanisms:
//   - Mechanism A (2 rows, 07-12/07-13): fired while the Globex market was closed over a
//     weekend, price_bars_primary's "get current price" idiom fell back to Friday's frozen
//     closing bar. Already fixed in code (isGlobexWeekClosed(), added 2026-08-20) -- these
//     2 rows are the historical casualties that predate the fix.
//   - Mechanism B (7 rows, 08-19): level_prices had no row for the real prior trading days
//     (08-17/08-18/08-19 -- a developing_value_log gap, fixed same day as this script via
//     scripts/compute_levels.js's self-heal), so the RTH `lp.PD_VAH ?? pdVAH` lookup served
//     a stale-but-present 08-14/08-16 value (30257/30156.5) instead of the correct 08-18-
//     derived value (29665/29566) -- a ~590-700pt error.
// Explicitly EXCLUDES (confirmed NOT bugs, per the same investigation):
//   - 2026-08-17 (113777, WEEKLY_OPEN_FADE_LONG) and 2026-08-26 (114396/114400 and ~15 more)
//     -- correctly-computed prior-day/prior-week LEVEL values that are >24h old BY DESIGN,
//     misflagged by the scan's naive "any bar within 30min" heuristic (a scan methodology
//     flaw DeepSeek identified, not a data bug).
//   - 2026-09-03 (114884, MPP_FADE_SHORT) -- confirmed exact match against level_prices.MPP,
//     same false-positive class as 08-26.
// Deliberately does NOT touch:
//   - 2026-09-14/09-15 rows -- Mechanism C (a live, ACTIVELY RACING contract-calendar bug,
//     per DeepSeek's own observation that price_bars_contract_calendar's bar_count was
//     changing DURING the investigation). Repairing historical entries for a bug that hasn't
//     stopped producing new ones yet would need re-doing; that's tracked as its own HIGH
//     OPEN_DECISION, not folded into this one-time backfill.
//   - 2026-09-07 (114987/114988/114989, PD_POC/3M_POC/PW_POC_FADE_SHORT[_OVERNIGHT]) -- a
//     smaller (~12-13pt) discrepancy against level_prices that doesn't cleanly match either
//     mechanism above; flagged separately, not resolved, not included in this backfill.
//
// Per docs/DB_MIGRATION_PROTOCOL.md: dry-run first (default), backup before the UPDATE,
// --commit required to actually write.
import { query } from '../server/db.js';

const AFFECTED_IDS = [
  35204, 35205,                                            // Mechanism A -- weekend closure
  113784, 113785, 113786, 113789, 113790, 113791, 113792,  // Mechanism B -- stale level_prices, 2026-08-19
];
const COMMIT = process.argv.includes('--commit');
const BACKUP_TABLE = 'active_setups_stale_entry_price_backup_20260915';

async function main() {
  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} -- ${AFFECTED_IDS.length} target row IDs`);

  const check = await query(`
    SELECT id, setup_type, trade_date::text, origin_status, resolution, actual_pnl
    FROM active_setups WHERE id = ANY($1)
  `, [AFFECTED_IDS]);
  if (check.rows.length !== AFFECTED_IDS.length) {
    console.error(`FATAL: expected ${AFFECTED_IDS.length} rows, found ${check.rows.length}. Aborting.`);
    process.exit(1);
  }
  console.log(`Verified: all ${check.rows.length} target IDs exist.`);
  console.table(check.rows);

  const colExists = await query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name='active_setups' AND column_name='stale_entry_price_basis'
  `);
  if (colExists.rows.length === 0) {
    if (!COMMIT) {
      console.log('[dry-run] Would run: ALTER TABLE active_setups ADD COLUMN stale_entry_price_basis boolean;');
    } else {
      await query(`ALTER TABLE active_setups ADD COLUMN stale_entry_price_basis boolean`);
      console.log('Added column active_setups.stale_entry_price_basis.');
    }
  } else {
    console.log('Column stale_entry_price_basis already exists (re-run after a prior commit).');
  }

  if (!COMMIT) {
    console.log(`[dry-run] Would create backup table ${BACKUP_TABLE} with ${AFFECTED_IDS.length} rows.`);
    console.log(`[dry-run] Would UPDATE ${AFFECTED_IDS.length} rows SET stale_entry_price_basis=true.`);
    console.log('Re-run with --commit to actually write.');
    process.exit(0);
    return;
  }

  await query(`
    CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} AS
    SELECT * FROM active_setups WHERE id = ANY($1) AND false
  `, [AFFECTED_IDS]);
  await query(`INSERT INTO ${BACKUP_TABLE} SELECT * FROM active_setups WHERE id = ANY($1)`, [AFFECTED_IDS]);
  const backupCount = await query(`SELECT COUNT(*)::int n FROM ${BACKUP_TABLE}`);
  console.log(`Backed up ${backupCount.rows[0].n} rows to ${BACKUP_TABLE}.`);

  const upd = await query(`
    UPDATE active_setups SET stale_entry_price_basis=true, updated_at=NOW()
    WHERE id = ANY($1) RETURNING id
  `, [AFFECTED_IDS]);
  console.log(`Updated ${upd.rows.length} rows.`);

  const verify = await query(`SELECT COUNT(*)::int n FROM active_setups WHERE stale_entry_price_basis=true`);
  console.log(`Verify: ${verify.rows[0].n} rows now flagged stale_entry_price_basis=true.`);
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
