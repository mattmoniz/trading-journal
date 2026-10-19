#!/usr/bin/env node
// Migration 2026-10-19: daily_rth_stats, one row per COMPLETED NQ RTH session (09:30-15:59 ET, minute-of-day 570-959 -- the exact window getRollingATR(),
// caseEngine.getOpenGaps() and /acd/gap-context already use). Replaces ~300 ms view scans, repeated ~173 times after every restart, with a 20-row indexed read.
// Spec: docs/PRICE_BARS_AND_STARTUP_SPEED_SPEC.md (Part B1). New table, nothing existing touched. Idempotent.
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS daily_rth_stats (
  trade_date date PRIMARY KEY,
  rth_high numeric(12,4) NOT NULL,
  rth_low numeric(12,4) NOT NULL,
  rth_range numeric(12,4) NOT NULL,
  n_bars integer NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now()
)`);
console.log('daily_rth_stats ready');
process.exit(0);
