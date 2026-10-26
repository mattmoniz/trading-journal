// New tables only (nothing existing is altered, so no backup needed; DB_MIGRATION_PROTOCOL.md):
//   volume_at_price_daily(trade_date DATE, price NUMERIC(9,2), vol_all INT, vol_rth INT)  one row per traded 0.25 price per trade date, from the tick files
//   volume_at_price_days(trade_date DATE PK, tick_volume BIGINT, db_volume BIGINT, source TEXT, loaded_at)  reconciliation audit, one row per loaded date
// vol_all = whole trade-date session (18:00 ET prior day to 17:00 ET), vol_rth = 09:30-16:00 ET part; Globex = vol_all - vol_rth.
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS volume_at_price_daily (trade_date DATE NOT NULL, price NUMERIC(9,2) NOT NULL, vol_all INTEGER NOT NULL, vol_rth INTEGER NOT NULL, PRIMARY KEY (trade_date, price))`);
await query(`CREATE TABLE IF NOT EXISTS volume_at_price_days (trade_date DATE PRIMARY KEY, tick_volume BIGINT NOT NULL, db_volume BIGINT NOT NULL, source TEXT, loaded_at TIMESTAMP DEFAULT NOW())`);
console.log('created');
process.exit(0);
