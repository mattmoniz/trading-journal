import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// CORRECTED 2026-08-19 (OPEN_DECISION db_naive_timestamp_columns_actually_store_et_not_utc,
// RESOLVED): the comment below was WRONG and sat uncorrected in committed code for months --
// TIMESTAMP WITHOUT TIME ZONE columns in this DB actually store ET wall-clock, not UTC
// (confirmed via a live round-trip: INSERT NOW() at 09:15:05 ET stored the literal text
// "2026-08-19 09:15:05", because this Postgres instance has TimeZone=America/New_York set at
// the SERVER level -- every timestamptz value implicitly cast into a naive column is
// converted to ET wall-clock before the zone is dropped). Appending 'Z' below deliberately
// mislabels those ET digits as UTC -- NOT a fix for node-postgres's local-time default, but a
// digit-preservation trick: any code that only ever reads the result back out via UTC getters
// (.getUTCHours()/.toISOString() etc, never .getHours()/.getDate()) gets the correct ET
// wall-clock digits back, regardless of the machine's own ambient timezone. This is safe for
// DISPLAY/digit-extraction but NOT for genuine cross-instant arithmetic (elapsed-time math,
// hours-old checks) -- see the naive_timestamp_epoch_mixing_systematic_audit_needed writeup
// (docs/OPEN_THREADS.md) for the parallel ::text-cast-then-bare-new-Date() convention used
// elsewhere in this codebase for that case, which depends on the PROCESS's ambient timezone
// actually being America/New_York (asserted at startup below, server/index.js).
pg.types.setTypeParser(1114, (val) => val ? new Date(val + 'Z') : null);

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of Date objects
// so they don't get timezone-shifted when serialized to JSON.
pg.types.setTypeParser(1082, (val) => val);

const { Pool } = pg;

// Create PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  // Raised from 20 to 60 (2026-07-15): after parallelizing the Morning Prep endpoints'
  // internal queries with Promise.all, a single real page load fires ~7 endpoints
  // concurrently, each now requesting ~15-20 connections at once (~100+ simultaneous
  // requests, bursty for a second or two) — a 20-connection pool queued most of them,
  // showing up as ~3.7-4.2s per endpoint under concurrent load despite each being
  // ~1.3-1.8s in isolation. Postgres max_connections=100 with ~26 in use baseline
  // (this app + gemini_readonly + manual psql/scripts + the 60s server-autonomous
  // poller), so 60 leaves headroom without exhausting max_connections.
  max: 60, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  // Raised from 2000 to 8000 (2026-07-15) alongside the pool-size bump above: at
  // max=20/timeout=2000, the burst of ~100+ simultaneous connection requests from one
  // real page load caused real "timeout exceeded when trying to connect" errors (seen
  // in scratch/server_errors.jsonl on auction-read/scalp-playbook during concurrent-load
  // testing) instead of just queueing. A short burst of contention should make a request
  // wait, not fail outright.
  connectionTimeoutMillis: 8000,
});

// Bump work_mem per-connection so large sorts (e.g. GROUP BY on trades) stay in memory
pool.on('connect', (client) => {
  client.query('SET work_mem = \'64MB\'').catch(() => {});
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
  process.exit(-1);
});

// Helper function to execute queries
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'production') {
      const cleanText = text.replace(/\s+/g, ' ').trim();
      const display = cleanText.length > 120 ? cleanText.slice(0, 120) + '...' : cleanText;
      console.log('Executed query', { query: display, duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
};

// Get a client from the pool for transactions
export const getClient = () => pool.connect();

export default pool;
