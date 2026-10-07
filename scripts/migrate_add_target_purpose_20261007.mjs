#!/usr/bin/env node
// Migration for the OCO bracket build (2026-10-07). Widens order_placements_purpose_check to allow a
// fourth value, 'TARGET', and adds idx_order_placements_one_target_per_setup -- mirrors the STOP
// purpose's own migration (scripts/migrate_sierra_chart_reconciliation_and_stop_20260929.mjs), one real
// target order per setup, ever, DB-enforced. 'TARGET' is 6 characters, well inside purpose's VARCHAR(10).
// No tracked migration-file system in this codebase -- this script IS the migration record, per
// docs/DB_MIGRATION_PROTOCOL.md. Checked first (per the protocol): the real constraint, via
// pg_get_constraintdef, currently reads CHECK (purpose IN ('ENTRY','EXIT','STOP')).
import { query } from '../server/db.js';

async function indexExists(name) {
  const r = await query(`SELECT 1 FROM pg_indexes WHERE indexname=$1`, [name]);
  return r.rows.length > 0;
}

async function main() {
  const purposeCheck = await query(`
    SELECT pg_get_constraintdef(oid) as def FROM pg_constraint
    WHERE conrelid = 'order_placements'::regclass AND conname = 'order_placements_purpose_check'
  `);
  console.log('current constraint:', purposeCheck.rows[0]?.def);
  const currentlyAllowsTarget = purposeCheck.rows[0]?.def?.includes("'TARGET'");
  if (!currentlyAllowsTarget) {
    await query(`ALTER TABLE order_placements DROP CONSTRAINT order_placements_purpose_check`);
    await query(`ALTER TABLE order_placements ADD CONSTRAINT order_placements_purpose_check CHECK (purpose IN ('ENTRY','EXIT','STOP','TARGET'))`);
    console.log('widened order_placements_purpose_check to allow TARGET');
  } else {
    console.log('order_placements_purpose_check already allows TARGET -- skipping');
  }

  if (!(await indexExists('idx_order_placements_one_target_per_setup'))) {
    await query(`
      CREATE UNIQUE INDEX idx_order_placements_one_target_per_setup
      ON order_placements(setup_id) WHERE purpose = 'TARGET'
    `);
    console.log('added idx_order_placements_one_target_per_setup');
  } else {
    console.log('idx_order_placements_one_target_per_setup already exists -- skipping');
  }

  console.log('done');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
