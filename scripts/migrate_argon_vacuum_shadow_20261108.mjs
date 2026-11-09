#!/usr/bin/env node
// One-time idempotent migration: live SHADOW log for the Argon liquidity-vacuum pullback (candidate Q4-4; docs/ARGON_VACUUM_LIVE_SHADOW_DESIGN_20261108.md).
// Checked first per docs/DB_MIGRATION_PROTOCOL.md: information_schema has no argon_vacuum_* tables; CREATE IF NOT EXISTS only, no ALTER of any existing table, no backfill. Timestamps are naive ET.
//   argon_vacuum_shadow           one row per trigger per arm (CAND = the spec's pullback-reclaim, FFC = FAST_FLOW_CONTROL). Decision columns frozen at insert (decision_hash); outcome columns fill once.
//   argon_vacuum_shadow_sessions  per session integrity + heartbeat facts
import { query } from '../server/db.js';
await query(`
  CREATE TABLE IF NOT EXISTS argon_vacuum_shadow (
    id bigserial PRIMARY KEY,
    arm varchar(4) NOT NULL,
    trade_date date NOT NULL,
    bar_idx integer NOT NULL,
    direction smallint NOT NULL,
    fired_at timestamp NOT NULL,
    bar_start_sec numeric(10,3), bar_end_sec numeric(10,3),
    entry_ref numeric(10,2) NOT NULL,
    init_risk_pts numeric(8,2),
    max_pb_bars integer,
    priors jsonb NOT NULL,
    feat jsonb,
    decision_hash varchar(16) NOT NULL,
    code_version jsonb NOT NULL,
    detected_at timestamp NOT NULL,
    late_min numeric(8,1),
    fwd_10 numeric(8,2), fwd_30 numeric(8,2), fwd_60 numeric(8,2),
    mfe_30 numeric(8,2), mae_30 numeric(8,2),
    outcome_at timestamp,
    UNIQUE (arm, trade_date, bar_idx, direction)
  )`);
await query(`CREATE INDEX IF NOT EXISTS idx_avs_date ON argon_vacuum_shadow (trade_date, arm)`);
await query(`
  CREATE TABLE IF NOT EXISTS argon_vacuum_shadow_sessions (
    trade_date date PRIMARY KEY,
    contract varchar(8), tick_file text, state varchar(10),
    n_bars integer, n_rth_bars integer, n_cand integer, n_ffc integer, priors_n integer,
    last_tick_at timestamp, heartbeat_at timestamp, bars_sha256 varchar(64), notes jsonb
  )`);
await query(`CREATE TABLE IF NOT EXISTS argon_vacuum_shadow_alarms (id bigserial PRIMARY KEY, at timestamp NOT NULL DEFAULT NOW(), kind varchar(30) NOT NULL, detail jsonb)`);
const r = await query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'argon_vacuum%' ORDER BY 1`);
console.log(r.rows.map(x => x.table_name).join(', ')); process.exit(0);
