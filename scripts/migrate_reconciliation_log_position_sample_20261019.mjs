#!/usr/bin/env node
// Migration 2026-10-19. connectionManager.js's 15s position sampler writes trigger='POSITION_SAMPLE' (15 chars, inside trigger's VARCHAR(20)), but
// sierra_chart_reconciliation_log_trigger_check only allowed LOGON/TERMINAL_TRANSITION/PERIODIC/MANUAL, so every sampler write failed
// ("position sample failed: ... violates check constraint") from the first real position change (2026-10-18 23:29) onward. The sampler's rows are the
// intended source for brokerPnlResolver's broker-position history and the flat-close estimate (both read broker_net, never the trigger), so the fix is to widen
// the constraint, not to relabel the rows. Same pattern as scripts/migrate_add_target_purpose_20261007.mjs. Idempotent. No data is touched.
import { query } from '../server/db.js';
async function main() {
  const r = await query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='sierra_chart_reconciliation_log'::regclass AND conname='sierra_chart_reconciliation_log_trigger_check'`);
  console.log('current constraint:', r.rows[0]?.def);
  if (r.rows[0]?.def?.includes("'POSITION_SAMPLE'")) { console.log('already allows POSITION_SAMPLE -- skipping'); return; }
  await query('BEGIN');
  try {
    await query(`ALTER TABLE sierra_chart_reconciliation_log DROP CONSTRAINT sierra_chart_reconciliation_log_trigger_check`);
    await query(`ALTER TABLE sierra_chart_reconciliation_log ADD CONSTRAINT sierra_chart_reconciliation_log_trigger_check CHECK (trigger IN ('LOGON','TERMINAL_TRANSITION','PERIODIC','MANUAL','POSITION_SAMPLE'))`);
    await query('COMMIT');
  } catch (e) { await query('ROLLBACK'); throw e; }
  const after = await query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='sierra_chart_reconciliation_log'::regclass AND conname='sierra_chart_reconciliation_log_trigger_check'`);
  console.log('widened ->', after.rows[0].def);
}
main().then(() => process.exit(0)).catch((e) => { console.error('Migration failed:', e); process.exit(1); });
