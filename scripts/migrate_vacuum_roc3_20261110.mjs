#!/usr/bin/env node
// 2026-11-10 (row 36 forward arm): SHADOW log of the Globex ROC3 variant of the vacuum expansion rule (docs/GLOBEX_ROC3_VACUUM_PREREG_20261110.md section 9). CREATE IF NOT EXISTS only, own table so the consumers of
// vacuum_live_events (order wiring, capitulation overlay, level tags, the card) never see these rows. Log only: nothing reads this table to place an order. Column `roc3` holds the ROC length-3 value.
import { query } from '../server/db.js';
await query(`
  CREATE TABLE IF NOT EXISTS vacuum_roc3_events (
    id bigserial PRIMARY KEY,
    trade_date date NOT NULL, track varchar(4) NOT NULL, bar_idx integer NOT NULL, direction smallint NOT NULL,
    fired_at timestamp NOT NULL, bar_end_sec numeric(10,3), signal_close numeric(10,2) NOT NULL, entry_open numeric(10,2),
    zroc numeric(7,3), roc3 numeric(9,2), etr numeric(8,2), dur numeric(9,2), zr_proxy numeric(7,3),
    taken boolean NOT NULL, decision_hash varchar(16) NOT NULL, detected_at timestamp NOT NULL, late_min numeric(8,1),
    fwd30 numeric(9,2), net_nostop numeric(9,2), net_stop25 numeric(9,2), mfe30 numeric(9,2), mae30 numeric(9,2), outcome_at timestamp,
    exit_note varchar(24), ctx jsonb,
    UNIQUE (trade_date, track, bar_idx, direction)
  )`);
await query(`CREATE INDEX IF NOT EXISTS idx_vr3_date ON vacuum_roc3_events (trade_date, track)`);
const r = await query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='vacuum_roc3_events'`); console.log('vacuum_roc3_events columns', r.rows[0].n);
process.exit(0);
