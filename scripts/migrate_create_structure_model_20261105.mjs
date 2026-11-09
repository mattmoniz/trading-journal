#!/usr/bin/env node
// One-time migration (idempotent): the forward log of the next-hour RANGE shadow model (docs/STRUCTURE_SHADOW_MODEL_DESIGN_20261105.md). Checked first per docs/DB_MIGRATION_PROTOCOL.md: nothing similar exists (forecast_points holds the 30-minute ACTIVITY forecast,
// regime_outlook the 09:25 day outlook; this is a different target: the next 60 minutes' high-low at four fixed decision times). Written ONLY by scripts/structure_model/run_nightly.py; places no orders, gates nothing, reads no trade or P&L. Timestamps are naive ET.
//   structure_model_rows  one row per (trade date, decision minute): the frozen model's prediction (made from data before the decision minute, by a model artifact fitted BEFORE the session) and, once the hour has ended, the realized label.
import { query } from '../server/db.js';
await query(`
  CREATE TABLE IF NOT EXISTS structure_model_rows (
    trade_date date NOT NULL,
    decision_min smallint NOT NULL,              -- minutes since 09:30 ET: 60 = 10:30, 120 = 11:30, 210 = 13:00, 300 = 14:30
    model_version varchar(60) NOT NULL,          -- the frozen champion artifact that predicted this row
    code_hash varchar(16) NOT NULL,              -- scripts/structure_model/features.py at prediction time (a feature change shows up here)
    predicted_at timestamp NOT NULL DEFAULT localtimestamp,
    adr double precision NOT NULL,               -- the median RTH range of the 20 sessions before the day (points)
    features jsonb NOT NULL,                     -- the M2 feature vector (the next refit trains on it)
    pred_ln double precision NOT NULL,           -- champion prediction of ln(next-hour range / ADR)
    base_ln double precision NOT NULL,           -- the HAR-X + clock baseline's prediction of the same
    base2_ln double precision,                   -- the HARD baseline: HAR-X + clock + the last-30-minute range and the range so far (two plain intraday persistence terms); the forward looks are judged against THIS one
    y double precision,                          -- the realized ln(next-hour range / ADR), attached after the hour ends
    realized_pts double precision,
    labelled_at timestamp,
    PRIMARY KEY (trade_date, decision_min)
  )`);
await query(`ALTER TABLE structure_model_rows ADD COLUMN IF NOT EXISTS base2_ln double precision`);      // 2026-11-05 amendment, before any forward row existed (the table was empty)
console.log('structure_model_rows ready'); process.exit(0);
