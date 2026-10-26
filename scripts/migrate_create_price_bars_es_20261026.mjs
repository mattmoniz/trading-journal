// Creates the ES (E-mini S&P) 1-minute bar tables, deliberately SEPARATE from price_bars/price_bars_primary (NQ). ES rows in price_bars once leaked into NQ queries that lacked a symbol filter
// (data_sanity_audit's standing ES flag), so ES gets its own tables and nothing existing reads them. New tables only: nothing to back up. Idempotent.
//   node scripts/migrate_create_price_bars_es_20261026.mjs
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS price_bars_es (
  contract text NOT NULL, ts timestamp without time zone NOT NULL,   -- ts = naive ET wall-clock minute, the same convention as price_bars
  open numeric(12,4) NOT NULL, high numeric(12,4) NOT NULL, low numeric(12,4) NOT NULL, close numeric(12,4) NOT NULL,
  volume integer NOT NULL DEFAULT 0, num_trades integer NOT NULL DEFAULT 0, bid_volume integer NOT NULL DEFAULT 0, ask_volume integer NOT NULL DEFAULT 0,
  PRIMARY KEY (contract, ts))`);
await query(`CREATE INDEX IF NOT EXISTS idx_price_bars_es_ts ON price_bars_es (ts)`);
await query(`CREATE TABLE IF NOT EXISTS es_front_calendar (
  trade_date date PRIMARY KEY, contract text NOT NULL, is_roll_day boolean NOT NULL DEFAULT false,   -- is_roll_day: the front contract changed on this date, so a return spanning the previous close to this date's first bar crosses a basis break
  basis text NOT NULL, rth_volume_front bigint, rth_volume_leader bigint, leader_contract text)`);
await query(`CREATE OR REPLACE VIEW price_bars_es_front AS
  SELECT c.trade_date, b.contract, b.ts, b.open, b.high, b.low, b.close, b.volume, b.num_trades, b.bid_volume, b.ask_volume
  FROM price_bars_es b JOIN es_front_calendar c ON c.trade_date = (b.ts + interval '6 hours')::date AND c.contract = b.contract`);   // trade_date: bars at/after 18:00 ET belong to the NEXT date's session
console.log('ok: price_bars_es, es_front_calendar, price_bars_es_front');
process.exit(0);
