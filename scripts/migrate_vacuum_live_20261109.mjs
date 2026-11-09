#!/usr/bin/env node
// One-time idempotent migration: live SHADOW log of the user's ORIGINAL expansion rule (Q4-5; docs/VACUUM_COMMON_SIM_PREREG_20261108.md A5-A10). CREATE IF NOT EXISTS only (docs/DB_MIGRATION_PROTOCOL.md): no ALTER, no backfill. Naive ET timestamps.
import { query } from '../server/db.js';
await query(`
  CREATE TABLE IF NOT EXISTS vacuum_live_events (
    id bigserial PRIMARY KEY,
    trade_date date NOT NULL, track varchar(4) NOT NULL, bar_idx integer NOT NULL, direction smallint NOT NULL,
    fired_at timestamp NOT NULL, bar_end_sec numeric(10,3), signal_close numeric(10,2) NOT NULL, entry_open numeric(10,2),
    zroc numeric(7,3), roc10 numeric(9,2), etr numeric(8,2), dur numeric(9,2), zr_proxy numeric(7,3),
    taken boolean NOT NULL, decision_hash varchar(16) NOT NULL, detected_at timestamp NOT NULL, late_min numeric(8,1),
    fwd30 numeric(9,2), net_nostop numeric(9,2), net_stop25 numeric(9,2), mfe30 numeric(9,2), mae30 numeric(9,2), outcome_at timestamp,
    UNIQUE (trade_date, track, bar_idx, direction)
  )`);
await query(`CREATE INDEX IF NOT EXISTS idx_vle_date ON vacuum_live_events (trade_date, track)`);
await query(`ALTER TABLE vacuum_live_events ADD COLUMN IF NOT EXISTS ctx jsonb`); await query(`ALTER TABLE vacuum_live_events ADD COLUMN IF NOT EXISTS exit_note varchar(24)`);   // context fields logged with every fire; outcome note (e.g. flat-clamped)
const r = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='vacuum_live_events' ORDER BY ordinal_position`);
console.log(r.rows.length, 'columns'); process.exit(0);
