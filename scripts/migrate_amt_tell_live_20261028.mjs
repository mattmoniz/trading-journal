#!/usr/bin/env node
// One-time migration (idempotent): tables for the live 500-contract-bar node-ladder tell detector (docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md).
// Checked first per docs/DB_MIGRATION_PROTOCOL.md: no existing table carries this (only amt_daily_state, an unrelated daily-state tracker); information_schema confirmed no amt_tell_* tables.
// All timestamps are naive ET (`timestamp without time zone`, this DB's TimeZone is America/New_York), written by the sidecar from tick UTC instants converted with zoneinfo, never from JS Date parsing.
//   amt_tell_trades        one row per virtual trade per (bar rule, book V1|V3): immutable decision columns + decision_hash, lifecycle columns (OPEN -> CLOSED, then frozen), the excursion path from entry
//   amt_tell_sessions      per (session, bar rule): integrity facts (ticks, contracts, volume vs price_bars_primary, bar hash, backwards-timestamp count) and heartbeat
//   amt_tell_session_stats per finished session: RTH range and mean seconds-per-bar by clock hour (the 20-session baseline the tell's activity component needs; persisted so a restart needs no replay of 20 sessions)
//   amt_tell_alarms        append-only log of integrity alarms (decision drift, stale tick file, volume mismatch, file rewrite, ...)
import { query } from '../server/db.js';

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS amt_tell_trades (
      id bigserial PRIMARY KEY,
      trade_date date NOT NULL,
      bar_rule varchar(8) NOT NULL,
      book varchar(4) NOT NULL,
      sig_idx integer NOT NULL,
      direction smallint NOT NULL,
      fired_at timestamp NOT NULL,
      entry_idx integer NOT NULL,
      entry_at timestamp,
      entry_price numeric(10,2) NOT NULL,
      stop_price numeric(10,2) NOT NULL,
      risk_points numeric(8,2) NOT NULL,
      stop_fallback boolean NOT NULL,
      details jsonb NOT NULL,
      decision_hash varchar(16) NOT NULL,
      code_version jsonb NOT NULL,
      status varchar(8) NOT NULL,
      exit_idx integer,
      exit_bar_start timestamp,
      exit_reason varchar(12),
      exit_points numeric(8,2),
      net_dollars numeric(9,2),
      broke boolean,
      mfe_points numeric(8,2),
      path jsonb,
      detected_at timestamp NOT NULL,
      late_min numeric(8,1),
      updated_at timestamp NOT NULL,
      CONSTRAINT amt_tell_trades_uq UNIQUE (trade_date, bar_rule, book, sig_idx)
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_amt_tell_trades_date ON amt_tell_trades (trade_date DESC, bar_rule, book)`);
  await query(`
    CREATE TABLE IF NOT EXISTS amt_tell_sessions (
      trade_date date NOT NULL,
      bar_rule varchar(8) NOT NULL,
      contract varchar(10),
      tick_file text,
      state varchar(12) NOT NULL,
      n_bars integer,
      last_tick_at timestamp,
      n_trades bigint,
      contracts bigint,
      rth_contracts bigint,
      db_rth_contracts bigint,
      vol_diff_pct numeric(7,2),
      tail_backwards integer,
      baseline_n integer,
      bars_sha256 varchar(64),
      eval_ms integer,
      updated_at timestamp NOT NULL,
      PRIMARY KEY (trade_date, bar_rule)
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS amt_tell_session_stats (
      trade_date date NOT NULL,
      bar_rule varchar(8) NOT NULL,
      rth_range double precision,
      hour_mean jsonb NOT NULL,
      n_bars integer NOT NULL,
      validated boolean NOT NULL,
      built_at timestamp NOT NULL,
      PRIMARY KEY (trade_date, bar_rule)
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS amt_tell_alarms (
      id bigserial PRIMARY KEY,
      at timestamp NOT NULL,
      kind varchar(30) NOT NULL,
      detail jsonb NOT NULL
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_amt_tell_alarms_at ON amt_tell_alarms (at DESC)`);
  const t = await query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'amt_tell_%' ORDER BY 1`);
  console.log('tables:', t.rows.map(r => r.table_name).join(', '));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
