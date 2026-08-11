// scripts/repair_commission_1_to_2_20260811.mjs
//
// One-time historical repair for the 2026-08-11 commission bug fix (see
// server/config/instruments.js, CLAUDE.md hard rule, OPEN_DECISION
// commission_constant_corrected_1_to_2_20260811). MNQ commissionPerRoundTrip was
// hardcoded as $1 (should be $2: $1/side x2) since this system's inception. Every
// historical actual_pnl computed via the standard live resolution formula
// (acd.js's resolveSetupsByPrice()/expireStaleSetups(), and
// repair_dead_end_shadow_rows_20260727.mjs's RETROACTIVE_REPAIR rows, which imports
// the same constant) subtracted exactly $1 commission where $2 was correct -- a flat,
// uniform -$1 undercharge on every affected row, confirmed via direct code read of
// every formula branch (all subtract COMMISSION once, no proportional/scaled usage).
//
// Scope: ONLY origin_status IN ('ACTIVE','SHADOW') (real/shadow-live trades, not
// synthetic BACKFILL data -- those rows were written by separate one-off scripts with
// their own possibly-different constants and are out of scope here), resolution IN
// ('TARGET_HIT','STOP_HIT') (TIME_EXPIRED trades resolve via MARK_TO_MARKET, already
// excluded below and computed by a different mechanism not audited here), and
// resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM') (this codebase's standing
// exclusion for uncapped mark-to-market exits -- never pooled into clean EV anyway, and
// not verified here to use the same flat-commission formula).
//
// This is the exact population backtest_setup_status.mjs's real_n/real_ev reads, so
// correcting it is what's actually required to make the constant fix flow through to
// live SUPPRESS/PROMOTE gating -- simply re-running that script does NOT do this on its
// own, since it only averages already-stored actual_pnl.
//
// Usage: node scripts/repair_commission_1_to_2_20260811.mjs --dry-run
//        node scripts/repair_commission_1_to_2_20260811.mjs --apply

import { query } from '../server/db.js';

const APPLY = process.argv.includes('--apply');

const SCOPE_WHERE = `
  resolution IN ('TARGET_HIT','STOP_HIT')
  AND actual_pnl IS NOT NULL
  AND origin_status IN ('ACTIVE','SHADOW')
  AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM'))
`;

async function main() {
  const before = await query(`
    SELECT COUNT(*) n, SUM(actual_pnl)::float total, AVG(actual_pnl)::float avg_pnl
    FROM active_setups WHERE ${SCOPE_WHERE}
  `);
  console.log('Scoped population (before):', before.rows[0]);

  const byMethod = await query(`
    SELECT resolution_method, COUNT(*) n FROM active_setups WHERE ${SCOPE_WHERE}
    GROUP BY resolution_method ORDER BY n DESC
  `);
  console.log('By resolution_method:', JSON.stringify(byMethod.rows));

  if (!APPLY) {
    console.log('\n--dry-run only. No changes made. Re-run with --apply to execute.');
    console.log(`Would subtract exactly $1 from ${before.rows[0].n} rows' actual_pnl.`);
    process.exit(0);
  }

  console.log('\nBacking up affected rows to active_setups_commission_repair_backup_20260811...');
  await query(`
    CREATE TABLE IF NOT EXISTS active_setups_commission_repair_backup_20260811 AS
    SELECT * FROM active_setups WHERE ${SCOPE_WHERE}
  `);
  const backupCount = await query(`SELECT COUNT(*) n FROM active_setups_commission_repair_backup_20260811`);
  console.log('Backup rows:', backupCount.rows[0].n);

  if (Number(backupCount.rows[0].n) !== Number(before.rows[0].n)) {
    console.error('ABORT: backup row count does not match scoped population count. Not applying.');
    process.exit(1);
  }

  const result = await query(`
    UPDATE active_setups SET actual_pnl = actual_pnl - 1, updated_at = NOW()
    WHERE ${SCOPE_WHERE}
  `);
  console.log('Rows updated:', result.rowCount);

  const after = await query(`
    SELECT COUNT(*) n, SUM(actual_pnl)::float total, AVG(actual_pnl)::float avg_pnl
    FROM active_setups WHERE ${SCOPE_WHERE}
  `);
  console.log('Scoped population (after):', after.rows[0]);
  console.log('Delta avg_pnl (should be exactly -1.00):', (after.rows[0].avg_pnl - before.rows[0].avg_pnl).toFixed(4));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
