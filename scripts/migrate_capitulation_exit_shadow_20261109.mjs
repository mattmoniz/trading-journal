#!/usr/bin/env node
// One-time idempotent migration (CREATE IF NOT EXISTS only, docs/DB_MIGRATION_PROTOCOL.md): forward SHADOW log of the capitulation-exit overlay (register row 30, docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md). One row per active_setups row (setup_id). Nothing here touches active_setups.
import { query } from '../server/db.js';
await query(`
  CREATE TABLE IF NOT EXISTS capitulation_exit_shadow (
    setup_id integer PRIMARY KEY,
    setup_type varchar(60) NOT NULL, side smallint NOT NULL, bet_class varchar(24), origin_status varchar(12), session_track varchar(4),
    fired_at timestamp NOT NULL, resolved_at timestamp, entry_px numeric(10,2), actual_pnl numeric(10,2),
    forward boolean NOT NULL,                       -- fired at or after the logger's forward start (prereg); false = descriptive retro rows, never counted toward the floor
    at_boundary boolean, boundary_name varchar(12), boundary_dist_adr numeric(7,4), adr20 numeric(9,2),
    pivot_live boolean, pivot_tests integer, pivot_dist numeric(9,2),
    sig_event_id bigint, sig_fired_at timestamp, sig_ext numeric(8,4), sig_cutoff numeric(8,4), sig_exit_px numeric(10,2),
    virt_pnl numeric(10,2), delta_pnl numeric(10,2),
    state varchar(12) NOT NULL,                     -- OPEN (row not resolved yet), NO_SIGNAL, SIGNAL
    code_version varchar(16) NOT NULL, computed_at timestamp NOT NULL DEFAULT now(), tags_at timestamp NOT NULL DEFAULT now()
  )`);
await query(`CREATE INDEX IF NOT EXISTS idx_ces_fired ON capitulation_exit_shadow (fired_at)`);
const r = await query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='capitulation_exit_shadow'`); console.log(r.rows[0].n, 'columns'); process.exit(0);
