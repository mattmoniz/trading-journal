import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { computeCase } from '../server/services/caseEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

// Setup database connection pool
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

// Hijack database query to print execution times
const originalQuery = pool.query;
pool.query = async function(text, params) {
  const start = Date.now();
  const res = await originalQuery.apply(this, [text, params]);
  const duration = Date.now() - start;
  const cleanText = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : 'non-string';
  const display = cleanText.length > 90 ? cleanText.slice(0, 90) + '...' : cleanText;
  console.log(`⏱️ Query: "${display}" took ${duration}ms`);
  return res;
};

// Replace global query helper with our pool query to hook it
import * as db from '../server/db.js';
const originalDbQuery = db.query;
// Note: caseEngine imports query from '../db.js', but since es modules are cached, we might need to hook the pg pool instead.
// Let's hook the pg pool which is used by db.js.

async function main() {
  const tradeDate = '2026-06-19';
  const asOfFull = '16:00';

  console.log('🏁 Starting computeCase latency profiling...');
  const t0 = Date.now();
  await computeCase(tradeDate, asOfFull);
  const t1 = Date.now();
  console.log(`\n🏁 Entire computeCase completed in ${t1 - t0}ms\n`);
  
  await pool.end();
}

main().catch(console.error);
