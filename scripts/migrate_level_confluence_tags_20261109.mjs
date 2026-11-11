#!/usr/bin/env node
// One-time idempotent migration (CREATE IF NOT EXISTS only, docs/DB_MIGRATION_PROTOCOL.md): append-only level-confluence tags for every fire of the market setups (register row 33, docs/LEVEL_CONFLUENCE_TAGS_PREREG_20261109.md).
import { query } from '../server/db.js';
await query(`
  CREATE TABLE IF NOT EXISTS level_confluence_tags (
    setup varchar(8) NOT NULL,                      -- TELL | VACUUM | TURN
    source_id bigint NOT NULL,                      -- amt_tell_trades.id | vacuum_live_events.id | turn_signal_events.id
    fired_at timestamp NOT NULL, trade_date date NOT NULL, track varchar(4), direction smallint NOT NULL,
    price numeric(10,2) NOT NULL, adr20 numeric(9,2), n_levels smallint,
    ahead_name varchar(12), ahead_price numeric(10,2), ahead_dist_adr numeric(8,4), ahead_defended boolean,     -- nearest Tier-1 level in the trade direction
    behind_name varchar(12), behind_price numeric(10,2), behind_dist_adr numeric(8,4), behind_cross_min numeric(6,1),   -- nearest level behind; minutes since a minute bar closed on its far side (NULL = none in 30 min)
    any_name varchar(12), any_price numeric(10,2), any_dist_adr numeric(8,4), any_side smallint, any_defended boolean,
    pivot_hi_live boolean, pivot_lo_live boolean,   -- fire price sits in the band of a live, confirmed swing pivot (HIGH / LOW)
    extra jsonb, code_version varchar(16) NOT NULL, computed_at timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY (setup, source_id)
  )`);
await query(`CREATE INDEX IF NOT EXISTS idx_lct_fired ON level_confluence_tags (fired_at)`);
const r = await query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='level_confluence_tags'`); console.log(r.rows[0].n, 'columns'); process.exit(0);
