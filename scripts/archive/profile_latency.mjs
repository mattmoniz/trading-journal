import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { computeProfile } from '../server/services/developingValueService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

async function main() {
  const tradeDate = '2026-06-19';
  const asOfFull = '2026-06-19 16:00:00';

  console.log('⏱️ Starting profile latency test...');

  // Measure Query 1 (bars)
  const t0 = Date.now();
  const barsQ = await pool.query(`
    SELECT ts, open::float, high::float, low::float, close::float,
           volume::int, bid_volume::int, ask_volume::int
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date = $1
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
      AND ts <= $2
    ORDER BY ts
  `, [tradeDate, asOfFull]);
  const t1 = Date.now();
  console.log(`- Query bars took: ${t1 - t0}ms (rows: ${barsQ.rows.length})`);

  // Measure Query 2 (developing value history)
  const t2 = Date.now();
  const pocHistoryQ = await pool.query(`
    SELECT poc::float, migration_dir_vs_prior as mig FROM developing_value_log
    WHERE trade_date < $1
    ORDER BY trade_date DESC LIMIT 3
  `, [tradeDate]);
  const t3 = Date.now();
  console.log(`- Query POC history took: ${t3 - t2}ms`);

  // Measure computeProfile calculation
  const bars = barsQ.rows;
  const t4 = Date.now();
  const devProfile = computeProfile(bars);
  const t5 = Date.now();
  console.log(`- computeProfile took: ${t5 - t4}ms (TICK = 0.25)`);

  // Test with TICK = 1.0 point
  const TICK_FAST = 1.0;
  const roundFast = p => Math.round(p / TICK_FAST) * TICK_FAST;
  const t6 = Date.now();
  const volMap = {};
  for (const b of bars) {
    const h = b.high, l = b.low, v = b.volume;
    if (!(h >= l)) continue;
    const levels = Math.max(1, Math.round((h - l) / TICK_FAST) + 1);
    const vpl = v / levels;
    for (let p = l; p <= h + TICK_FAST / 2; p += TICK_FAST) {
      const lvl = roundFast(p);
      volMap[lvl] = (volMap[lvl] || 0) + vpl;
    }
  }
  const entries = Object.entries(volMap).map(([p, v]) => ({ price: parseFloat(p), volume: v })).sort((a,b)=>a.price-b.price);
  const t7 = Date.now();
  console.log(`- computeProfile fast loop took: ${t7 - t6}ms (TICK = 1.0)`);

  await pool.end();
}

main().catch(console.error);
