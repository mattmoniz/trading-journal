#!/usr/bin/env node
// One-time migration (idempotent): the watcher state log and the shadow context books (docs/TELL_WATCHER_AND_SHADOW_BOOKS_DESIGN_20261103.md). Checked first per docs/DB_MIGRATION_PROTOCOL.md: nothing similar exists
// (tell_context_fires holds the per-fire context, amt_tell_trades the tell's own trades). Both tables are written ONLY by scripts/tell_context/reader.py, place no orders and gate nothing. Timestamps are naive ET.
//   tell_watcher_states  append-only: one row per day-state CHANGE (state, previous state, evidence); the flip-flop rate per day is the watcher's stability gauge
//   tell_shadow_trades   one row per (tell fire, book A|B|C): hypothetical trade simulated with the tell's real exit code; lifecycle OPEN -> CLOSED, then frozen
import { query } from '../server/db.js';

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS tell_watcher_states (
      trade_date date NOT NULL,
      bar_idx integer NOT NULL,
      bar_end_et timestamp NOT NULL,
      state varchar(20) NOT NULL,                 -- UNKNOWN | BALANCE_FORMING | BALANCE_CONFIRMED | DRIVE_UP | DRIVE_DOWN
      prev_state varchar(20) NOT NULL,
      evidence jsonb NOT NULL,
      code_version varchar(16) NOT NULL,
      computed_at timestamp NOT NULL DEFAULT localtimestamp,
      PRIMARY KEY (trade_date, bar_idx)
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS tell_shadow_trades (
      tell_trade_id bigint NOT NULL,
      book varchar(1) NOT NULL,                   -- A = the tell's stop re-simulated (control), B = value-edge stop, C = flip when AGAINST
      trade_date date NOT NULL,
      direction smallint NOT NULL,
      label varchar(8),
      watcher_state varchar(20),
      followed_a boolean NOT NULL,                -- true when this book did not change the trade (UNKNOWN / not AGAINST / stop guard)
      guard text,
      entry_idx integer,
      exit_idx integer,
      entry_price numeric(10,2),
      stop_price numeric(10,2),
      status varchar(6) NOT NULL,
      exit_reason varchar(12),
      exit_points numeric(8,2),
      net_dollars numeric(9,2),
      broke boolean,
      mfe_points numeric(8,2),
      parity_ok boolean,                          -- book A only: reproduces the amt_tell_trades row on closed fires
      code_version varchar(16) NOT NULL,
      computed_at timestamp NOT NULL DEFAULT localtimestamp,
      updated_at timestamp NOT NULL DEFAULT localtimestamp,
      PRIMARY KEY (tell_trade_id, book)
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tst_trade_date ON tell_shadow_trades (trade_date)`);
  const a = (await query(`SELECT count(*)::int n FROM tell_watcher_states`)).rows[0].n, b = (await query(`SELECT count(*)::int n FROM tell_shadow_trades`)).rows[0].n;
  console.log('tell_watcher_states rows', a, '| tell_shadow_trades rows', b); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
