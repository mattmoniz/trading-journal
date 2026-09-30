#!/usr/bin/env node
// Migration for the two approved-but-not-yet-built Sierra Chart items scoped in
// docs/OPEN_THREADS.md's 2026-09-29 "reconciliation cadence + a real broker-side stop"
// entry. No tracked migration-file system in this codebase -- this script IS the
// migration record, per docs/DB_MIGRATION_PROTOCOL.md.
//
// Checked first (per the protocol): confirmed via pg_constraint that order_placements'
// real CHECK constraint name is `order_placements_purpose_check`, currently
// `CHECK (purpose IN ('ENTRY','EXIT'))` -- not guessed from server/schema.sql, which can
// drift. No existing table already does "append-only reconciliation-finding log" --
// order_placements_updates is per-order, not per-reconciliation-run, so this is a new,
// non-duplicate table.
//
// Item 1 (reconciliation cadence): `sierra_chart_reconciliation_log` -- an append-only
// history of every runReconciliation() result (see reconciliation.js), not just the
// single in-memory `lastReconciliationReport`/`lastInvariantCheck` connectionManager.js
// held before this. Matches this codebase's own standing "a column that only stores the
// single latest message makes forensic repair impossible" lesson (see this same file's
// order_placements_updates precedent, added earlier the same day for the identical
// reason) -- applied here before the gap can recur, not after.
//
// Item 2 (real broker-side stop): widens order_placements_purpose_check to allow a
// third value, 'STOP', and adds idx_order_placements_one_stop_per_setup (mirrors
// idx_order_placements_one_entry_per_setup's pattern -- one real stop order per setup,
// ever, DB-enforced) so a retried/duplicated stop-placement attempt can never create a
// second live stop for the same setup.

import { query } from '../server/db.js';

async function indexExists(name) {
  const r = await query(`SELECT 1 FROM pg_indexes WHERE indexname=$1`, [name]);
  return r.rows.length > 0;
}

async function tableExists(name) {
  const r = await query(`SELECT to_regclass('public.' || $1) as t`, [name]);
  return !!r.rows[0].t;
}

async function main() {
  // ---- Item 1: reconciliation log -------------------------------------------------
  if (!(await tableExists('sierra_chart_reconciliation_log'))) {
    await query(`
      CREATE TABLE sierra_chart_reconciliation_log (
        id SERIAL PRIMARY KEY,
        checked_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
        trigger VARCHAR(20) NOT NULL CHECK (trigger IN ('LOGON','TERMINAL_TRANSITION','PERIODIC','MANUAL')),
        reconciliation_clean BOOLEAN,
        unknown_to_app_count INTEGER,
        stale_in_app_count INTEGER,
        invariant_checked BOOLEAN,
        invariant_match BOOLEAN,
        broker_net NUMERIC,
        expected_net NUMERIC,
        report JSONB NOT NULL
      )
    `);
    await query(`CREATE INDEX idx_sierra_chart_reconciliation_log_checked_at ON sierra_chart_reconciliation_log(checked_at)`);
    console.log('created sierra_chart_reconciliation_log');
  } else {
    console.log('sierra_chart_reconciliation_log already exists -- skipping');
  }

  // ---- Item 2: real broker-side stop -----------------------------------------------
  const purposeCheck = await query(`
    SELECT pg_get_constraintdef(oid) as def FROM pg_constraint
    WHERE conrelid = 'order_placements'::regclass AND conname = 'order_placements_purpose_check'
  `);
  const currentlyAllowsStop = purposeCheck.rows[0]?.def?.includes("'STOP'");
  if (!currentlyAllowsStop) {
    await query(`ALTER TABLE order_placements DROP CONSTRAINT order_placements_purpose_check`);
    await query(`ALTER TABLE order_placements ADD CONSTRAINT order_placements_purpose_check CHECK (purpose IN ('ENTRY','EXIT','STOP'))`);
    console.log('widened order_placements_purpose_check to allow STOP');
  } else {
    console.log('order_placements_purpose_check already allows STOP -- skipping');
  }

  if (!(await indexExists('idx_order_placements_one_stop_per_setup'))) {
    await query(`
      CREATE UNIQUE INDEX idx_order_placements_one_stop_per_setup
      ON order_placements(setup_id) WHERE purpose = 'STOP'
    `);
    console.log('added idx_order_placements_one_stop_per_setup');
  } else {
    console.log('idx_order_placements_one_stop_per_setup already exists -- skipping');
  }

  console.log('done');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
