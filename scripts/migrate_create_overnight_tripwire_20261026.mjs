// 2026-10-26: tables for the overnight tripwire (docs/OVERNIGHT_TRIPWIRE_20261026.md). Idempotent.
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS overnight_checkpoint_stats (
  trade_date date NOT NULL, checkpoint_min integer NOT NULL, volume bigint NOT NULL, legs integer NOT NULL,
  PRIMARY KEY (trade_date, checkpoint_min))`);
await query(`CREATE TABLE IF NOT EXISTS tripwire_events (
  id serial PRIMARY KEY, trade_date date NOT NULL, level varchar(10) NOT NULL, fired_at timestamp without time zone NOT NULL DEFAULT (NOW() AT TIME ZONE 'America/New_York'),
  elapsed_min integer NOT NULL, vol_rank numeric, legs_rank numeric, vol_ratio numeric, legs integer, notified boolean NOT NULL DEFAULT false, notify_note text,
  UNIQUE (trade_date, level))`);
console.log('ok'); process.exit(0);
