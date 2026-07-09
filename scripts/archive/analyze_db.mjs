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
    SELECT setup_type, count(*), min(trade_date)::text as min_date, max(trade_date)::text as max_date
    FROM active_setups
    GROUP BY setup_type
    ORDER BY count DESC
  `);
  console.log("Distinct setup types in active_setups:");
  console.table(res.rows);

  const outcomeRes = await pool.query(`
    SELECT setup_type, count(*), min(trade_date)::text as min_date, max(trade_date)::text as max_date
    FROM setup_outcome_backtest
    GROUP BY setup_type
    ORDER BY count DESC
  `);
  console.log("\nDistinct setup types in setup_outcome_backtest:");
  console.table(outcomeRes.rows);

  await pool.end();
}

main().catch(console.error);
