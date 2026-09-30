#!/usr/bin/env node
// Follow-up migration to order_placements, 2026-09-29 -- fixes for a confirmed real bug
// found the first night this system traded for real (docs/OPEN_THREADS.md's 2026-09-28
// Sierra Chart entry, "2026-09-29 continuation" section has the full incident). DeepSeek
// design-reviewed before this was written -- see that same doc section for the critique.
//
// Root problem being fixed: `getBrokerReportedPosition()`'s fallback in
// reconciliation.js's placeExitOrder() read the ACCOUNT'S NET AGGREGATE position for a
// symbol (all this app's setups trade the same single MNQ contract) and attributed it to
// whichever setup was being checked -- misattributing another setup's real position when
// more than one was open at once. Confirmed live: a real flatten was submitted for
// setup_id 127687 (whose own entry never filled) using a quantity that belonged to a
// different setup entirely.
//
// This migration adds the DB-level pieces the fix needs -- see reconciliation.js/
// orderSweep.js for how they're used:
//
// 1. `position_open BOOLEAN` on ENTRY rows + a singleton partial unique index --
//    enforces "at most one real position open across the whole account at a time" as a
//    real DB constraint, not an app-level check (which has its own TOCTOU race). This is
//    both a real product rule (the user trades exactly 1 MNQ contract at a time) AND what
//    makes the broker's aggregate position unambiguous again -- with genuinely only one
//    position ever open, "the account's net position" IS that one setup's position.
// 2. `latest_transaction_time` (SCDateTime double, from DTC's own `LatestTransactionDateTime`)
//    -- used by handleOrderUpdate()'s terminal-state lattice (FILLED/PARTIALLY_FILLED are
//    absorbing and can never be overwritten by a CANCELED/REJECTED message regardless of
//    timestamp; timestamp ordering is only a secondary guard for non-terminal states).
//    NEVER compare this to Date.now() or any wall-clock value -- only to another
//    LatestTransactionDateTime.
// 3. `order_placements_updates` -- an append-only log of every real ORDER_UPDATE message
//    received, keyed by client_order_id. `raw_last_order_update` on the main table only
//    ever holds the SINGLE latest message (overwritten each time) -- DeepSeek's review
//    caught that this makes "reconstruct what really happened" impossible after the fact,
//    which is exactly what blocked a clean repair of last night's records. This table
//    exists so that gap can't recur.

import { query } from '../server/db.js';

async function columnExists(table, column) {
  const r = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return r.rows.length > 0;
}

async function indexExists(name) {
  const r = await query(`SELECT 1 FROM pg_indexes WHERE indexname=$1`, [name]);
  return r.rows.length > 0;
}

async function main() {
  if (!(await columnExists('order_placements', 'position_open'))) {
    await query(`ALTER TABLE order_placements ADD COLUMN position_open BOOLEAN NOT NULL DEFAULT FALSE`);
    console.log('added position_open');
  }
  if (!(await columnExists('order_placements', 'latest_transaction_time'))) {
    await query(`ALTER TABLE order_placements ADD COLUMN latest_transaction_time DOUBLE PRECISION`);
    console.log('added latest_transaction_time');
  }
  if (!(await indexExists('idx_order_placements_one_open_position'))) {
    // Singleton idiom: a unique index on a constant expression with a partial predicate
    // enforces "at most one row where the predicate holds," across the WHOLE table, not
    // per setup_id -- exactly the system-wide invariant needed here.
    await query(`
      CREATE UNIQUE INDEX idx_order_placements_one_open_position
      ON order_placements ((1)) WHERE purpose = 'ENTRY' AND position_open = TRUE
    `);
    console.log('added idx_order_placements_one_open_position (singleton constraint)');
  }
  const updatesTable = await query(`SELECT to_regclass('public.order_placements_updates') as t`);
  if (!updatesTable.rows[0].t) {
    await query(`
      CREATE TABLE order_placements_updates (
        id SERIAL PRIMARY KEY,
        client_order_id VARCHAR(40) NOT NULL,
        raw_message JSONB NOT NULL,
        received_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX idx_order_placements_updates_client_order_id ON order_placements_updates(client_order_id)`);
    console.log('created order_placements_updates (append-only ORDER_UPDATE log)');
  }

  // checkPositionInvariant()'s expected-net calculation only sums rows AFTER the most
  // recent baseline row here -- reset once, 2026-09-29, after confirming the account was
  // genuinely flat via a direct broker query, because the pre-fix historical rows (ids
  // 1-18) contain corrupted status/side data from the aggregate-misattribution bug this
  // whole migration fixes, and can't be forensically reconstructed (raw_last_order_update
  // only ever held the single latest message per row, not a sequence). User's explicit
  // decision: accept the verified-flat baseline and start the invariant check clean from
  // there, rather than attempt an unreliable historical repair. A fresh install has no
  // history to poison, so this table starts empty (baseline_order_id effectively 0) --
  // only the live DB got an actual baseline row inserted, via a one-off script at the time.
  const baselineTable = await query(`SELECT to_regclass('public.order_placements_invariant_baseline') as t`);
  if (!baselineTable.rows[0].t) {
    await query(`
      CREATE TABLE order_placements_invariant_baseline (
        id SERIAL PRIMARY KEY,
        baseline_order_id INTEGER NOT NULL,
        set_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
        reason TEXT NOT NULL
      )
    `);
    console.log('created order_placements_invariant_baseline (empty -- no reset needed on a fresh install)');
  }

  console.log('done');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
