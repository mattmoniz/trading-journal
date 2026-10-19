#!/usr/bin/env node
// Migration 2026-10-19: table_growth, one row per (week, table) written by scripts/data_growth_check.mjs. New table, nothing existing touched. Idempotent.
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS table_growth (
  id bigserial PRIMARY KEY,
  captured_at timestamptz NOT NULL DEFAULT now(),
  relname varchar(100) NOT NULL,
  mb numeric, est_rows bigint, seq_scan bigint, seq_tup_read bigint, idx_scan bigint, n_dead_tup bigint
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_table_growth_rel ON table_growth (relname, captured_at DESC)`);
console.log('table_growth ready');
process.exit(0);
