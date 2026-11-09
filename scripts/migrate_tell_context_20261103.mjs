#!/usr/bin/env node
// One-time migration (idempotent): the append-only context log of the live tell (docs/TELL_CONTEXT_OVERLAY_SCOPE_20261103.md). Checked first per docs/DB_MIGRATION_PROTOCOL.md: no existing table carries
// this (amt_tell_trades holds the decision and outcome of each fire, nothing about where it sat in the day's value area). One row per amt_tell_trades.id with bar_rule='split', written once by
// scripts/tell_context/reader.py (never updated: a stored context is a frozen record of what the reader saw at the fire). All timestamps are naive ET like the rest of the amt_tell_* tables.
// It places no orders and gates nothing; the label is a display and learning value, NOT VALIDATED.
import { query } from '../server/db.js';

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS tell_context_fires (
      tell_trade_id bigint PRIMARY KEY,
      trade_date date NOT NULL,
      book varchar(4) NOT NULL,
      direction smallint NOT NULL,
      fired_at timestamp NOT NULL,
      entry_price numeric(10,2) NOT NULL,
      sig_idx integer NOT NULL,
      label varchar(8) NOT NULL,                      -- AGREES | AGAINST | NEUTRAL | UNKNOWN
      reason text,                                    -- why UNKNOWN
      rth_minutes integer,
      val numeric(10,2), poc numeric(10,2), vah numeric(10,2),
      location numeric(7,3),                          -- (entry - VAL) / (VAH - VAL), developing RTH 70 percent value area
      tail varchar(10), near_edge varchar(6),
      shape_letter varchar(1), multi_hump boolean, humps integer, va_mid numeric(5,2), poc_pos numeric(5,2), bimodality numeric(5,2),
      up_broken boolean, down_broken boolean, opposite_broken boolean,
      nearest_lvn jsonb, lvns_within_near jsonb,
      context jsonb NOT NULL,                         -- the full context_at_fire() result
      code_version varchar(16) NOT NULL,              -- hash of scripts/tell_context/context.py + shape_cuts.json
      computed_at timestamp NOT NULL,
      late_min numeric(8,1)                           -- minutes between the fire and the moment this row was computed
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tcf_trade_date ON tell_context_fires (trade_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tcf_label ON tell_context_fires (label)`);
  const r = await query(`SELECT count(*)::int n FROM tell_context_fires`);
  console.log('tell_context_fires ready, rows:', r.rows[0].n);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
