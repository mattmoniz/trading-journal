import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

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
  const res = await pool.query(`
    SELECT
      COUNT(*) as total_trades,
      COUNT(*) FILTER (WHERE hit_t1_first) as wins,
      COUNT(*) FILTER (WHERE hit_stop AND NOT COALESCE(hit_t1_first,false)) as losses,
      COUNT(*) FILTER (WHERE NOT COALESCE(hit_t1,false) AND NOT COALESCE(hit_stop,false)) as no_exit,
      MIN(trade_date)::text as start_date,
      MAX(trade_date)::text as end_date
    FROM setup_outcome_backtest
    WHERE trade_date >= '2025-06-20' AND trade_date <= '2026-06-20'
  `);
  console.log("Trades from 2025-06-20 to 2026-06-20:");
  console.table(res.rows);
  await pool.end();
}

main().catch(console.error);
