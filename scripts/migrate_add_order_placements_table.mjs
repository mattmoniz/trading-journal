#!/usr/bin/env node
// One-time migration: create `order_placements`, the real-order audit/reconciliation
// table for the Sierra Chart DTC automation build (docs/OPEN_THREADS.md's 2026-09-28
// "Sierra Chart order-placement connection" entry). No tracked migration-file system in
// this codebase -- this script IS the migration record, per docs/DB_MIGRATION_PROTOCOL.md.
//
// Checked first (per the protocol's "check for something similar already existing"
// step): grepped server/schema.sql for any existing order/fill table -- none exists.
// This is a brand-new table, not a duplicate.
//
// Design notes:
// - `client_order_id` is UNIQUE -- the DTC ClientOrderID this app generates is the real
//   idempotency key; a retried insert with the same id can never create a second row.
// - The partial unique index on (setup_id) WHERE purpose='ENTRY' enforces, at the DB
//   level, that a given active_setups row can only ever get ONE real entry order --
//   matches this codebase's existing "bare unique index, ON CONFLICT DO NOTHING" idiom
//   used for active_setups' own touch-instant dedup, rather than trusting application
//   logic alone to never race.
// - `status VARCHAR(32)` (widened from an initial VARCHAR(20) the same day, caught by
//   DeepSeek design review before any real order existed): DTC's OrderStatusEnum names
//   include `PENDING_CANCEL_REPLACE` (22 chars), which overflowed the original 20-char
//   column -- would have thrown on the very first real cancel-replace update. See
//   CLAUDE.md's standing "VARCHAR(N) literal overflow risk" convention -- check a
//   hardcoded string against its column's ACTUAL declared width, not by eye.
// - `server_order_id` (added right after table creation, confirmed via Sierra Chart's
//   own DTCProtocol.h) is REQUIRED for cancellation -- CANCEL_ORDER identifies the order
//   to cancel by ServerOrderID only, not the ClientOrderID this app generates. That value
//   only ever arrives later, via an ORDER_UPDATE echoing it back -- captured/updated by
//   reconciliation.js as it comes in, not known at submission time.
// - `environment_service` captures the DTC LOGON_RESPONSE's own `Service` field
//   (e.g. "rithmic_v2.trading") AT THE TIME OF SUBMISSION -- every real order
//   permanently records which account context it believed it was trading against,
//   not just today's assumption. This is the audit trail for the exact question asked
//   before this table existed: "which account is this."
// - Naive timestamps, no explicit zone conversion -- this Postgres instance has
//   TimeZone=America/New_York set server-side (see server/db.js's header comment), so
//   `now()` already returns ET wall-clock digits, matching every other table's
//   `created_at`/`fired_at`-style columns.

import { query } from '../server/db.js';

async function main() {
  const existing = await query(`SELECT to_regclass('public.order_placements') as t`);
  if (existing.rows[0].t) {
    console.log('order_placements already exists -- nothing to do.');
    return;
  }

  await query(`
    CREATE TABLE order_placements (
      id SERIAL PRIMARY KEY,
      setup_id INTEGER REFERENCES active_setups(id),
      purpose VARCHAR(10) NOT NULL CHECK (purpose IN ('ENTRY','EXIT')),
      client_order_id VARCHAR(40) NOT NULL,
      symbol VARCHAR(20) NOT NULL,
      exchange VARCHAR(20) NOT NULL,
      side VARCHAR(4) NOT NULL CHECK (side IN ('BUY','SELL')),
      order_type VARCHAR(10) NOT NULL,
      quantity INTEGER NOT NULL,
      price1 NUMERIC,
      price2 NUMERIC,
      trade_account VARCHAR(60),
      environment_service VARCHAR(60),
      status VARCHAR(32) NOT NULL DEFAULT 'SUBMITTED',
      server_order_id VARCHAR(64),
      filled_quantity INTEGER NOT NULL DEFAULT 0,
      avg_fill_price NUMERIC,
      reject_reason TEXT,
      submitted_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
      last_update_at TIMESTAMP WITHOUT TIME ZONE,
      raw_last_order_update JSONB,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
      position_open BOOLEAN NOT NULL DEFAULT FALSE,
      latest_transaction_time DOUBLE PRECISION
    );
  `);

  await query(`CREATE UNIQUE INDEX idx_order_placements_client_order_id ON order_placements(client_order_id);`);
  await query(`CREATE INDEX idx_order_placements_setup_id ON order_placements(setup_id);`);
  await query(`CREATE INDEX idx_order_placements_server_order_id ON order_placements(server_order_id);`);
  await query(`
    CREATE UNIQUE INDEX idx_order_placements_one_entry_per_setup
    ON order_placements(setup_id) WHERE purpose = 'ENTRY';
  `);
  // Added 2026-09-29 (same day, after a real double-flatten-race concern) -- see
  // scripts/migrate_order_placements_safety_fixes_20260929.mjs for the full incident this
  // and the two indexes/columns below were built to fix. Folded into this original
  // creation script too so a FRESH install gets the complete, correct schema from the
  // start, not just the live DB (which was patched via that follow-up migration).
  await query(`
    CREATE UNIQUE INDEX idx_order_placements_one_live_exit_per_setup
    ON order_placements(setup_id) WHERE purpose = 'EXIT' AND status IN
      ('PENDING_SUBMIT','SUBMITTED','ORDER_SENT','PENDING_OPEN','OPEN','PARTIALLY_FILLED','PENDING_CANCEL','PENDING_CANCEL_REPLACE','FILLED');
  `);
  await query(`
    CREATE UNIQUE INDEX idx_order_placements_one_open_position
    ON order_placements ((1)) WHERE purpose = 'ENTRY' AND position_open = TRUE;
  `);
  await query(`
    CREATE TABLE order_placements_updates (
      id SERIAL PRIMARY KEY,
      client_order_id VARCHAR(40) NOT NULL,
      raw_message JSONB NOT NULL,
      received_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX idx_order_placements_updates_client_order_id ON order_placements_updates(client_order_id);`);

  console.log('order_placements created with 6 indexes + order_placements_updates.');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
