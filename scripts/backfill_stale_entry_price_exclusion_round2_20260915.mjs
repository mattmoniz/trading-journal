// Round 2 of the stale-entry-price backfill (see backfill_stale_entry_price_exclusion_20260915.mjs
// for round 1 -- the 9 rows from Mechanisms A/B). This round covers Mechanism C: the
// price_bars_contract_calendar roll-race (OPEN_DECISION
// contract_calendar_roll_race_stale_price_20260915, fixed in commit b377401). Deliberately
// deferred until the underlying code fix shipped and was verified live -- repairing these
// while the race was still active would have needed redoing.
//
// 54 rows confirmed via a fresh re-run of scratch/systemic_stale_price_scan_v2_20260915.mjs
// AFTER the code fix landed (all 54 fired BEFORE the fix's restart -- confirmed no new severe
// rows have fired since; the scan's most recent flagged row is 121890 at 2026-09-15 10:02:30,
// well before the fix went live around 12:30pm ET the same day). 4 are origin_status='ACTIVE'
// (121242/121684 FLOOR_R1_FADE_LONG STOP_HIT -$76 each, 121779 GLOBEX_VWAP_MAGNET_SHORT
// INVALIDATED -$2.50, 121851 OR5_HIGH_FADE_SHORT INVALIDATED -$40.50 -- the real dollar losses
// this whole investigation was originally about), 50 are SHADOW-origin.
//
// Per docs/DB_MIGRATION_PROTOCOL.md: dry-run first (default), backup before the UPDATE,
// --commit required to actually write.
import { query } from '../server/db.js';

const AFFECTED_IDS = [
  121226,121227,121228,121237,121238,121242,121243,121244,121245,121247,121248,121274,121296,
  121297,121299,121308,121309,121316,121326,121327,121330,121351,121358,121392,121478,121488,
  121615,121621,121684,121685,121686,121690,121754,121777,121778,121779,121780,121782,121801,
  121826,121827,121833,121835,121836,121845,121846,121847,121848,121850,121851,121852,121853,
  121855,121890,
];
const COMMIT = process.argv.includes('--commit');
const BACKUP_TABLE = 'active_setups_stale_entry_price_round2_backup_20260915';

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
  const alreadyFlagged = await query(`SELECT id FROM active_setups WHERE id = ANY($1) AND stale_entry_price_basis IS TRUE`, [AFFECTED_IDS]);
  if (alreadyFlagged.rows.length > 0) {
    console.error(`FATAL: ${alreadyFlagged.rows.length} of these IDs are already flagged stale_entry_price_basis=true -- re-run would double-backup. Aborting: ${alreadyFlagged.rows.map(r=>r.id).join(',')}`);
    process.exit(1);
  }
  console.log(`Verified: all ${check.rows.length} target IDs exist and are not yet flagged.`);
  const byOrigin = {};
  for (const r of check.rows) byOrigin[r.origin_status] = (byOrigin[r.origin_status]||0)+1;
  console.log('By origin_status:', byOrigin);

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
  console.log(`Verify: ${verify.rows[0].n} rows now flagged stale_entry_price_basis=true (round 1 + round 2 combined).`);
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
