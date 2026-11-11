import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve .env by this file's own location, not process.cwd() -- a bare `node some_script.mjs`
// cron entry (no `cd` first) runs with cwd=$HOME, not the repo root, so the default
// dotenv.config() silently finds nothing and DB_PASSWORD ends up undefined. Found 2026-10-13:
// 3 cron scripts (catchup_price_bars.mjs, check_price_bars_freshness.mjs,
// check_order_lifecycle_health.mjs) had been failing every single run since 2026-10-11 with
// "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string" -- registered, firing
// on schedule, silently useless the whole time. Every shell-script cron entry already avoids
// this by `cd`-ing to the repo first; this fixes it at the source so no future bare-node
// script needs to remember to do the same.
const __repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(__repoRoot, '.env') });

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
let loggedFirstConnect = false;
pool.on('connect', (client) => {
  client.query('SET work_mem = \'64MB\'').catch(() => {});
  // JIT off per connection (2026-10-19). Postgres' JIT compiles machine code for any query whose planner cost is high, and the
  // price_bars_primary VIEW's plans always look expensive -- measured on the live DB: the prior-day IB query took 1,635 ms with JIT and
  // 276 ms without (identical rows); the other hot queries were unchanged. Results never depend on JIT, and `SET jit = on` (or deleting
  // this line) restores the old behaviour.
  client.query('SET jit = off').catch(() => {});
  if (!loggedFirstConnect || process.env.DEBUG_SQL === '1') { loggedFirstConnect = true; console.log('✅ Connected to PostgreSQL database'); }
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
  process.exit(-1);
});

// In-process query profiler (2026-10-19). Logging every query was too noisy and logging only slow ones hides the fast-but-constant ones,
// so this keeps ONE counter per query SHAPE (literals/numbers/lists collapsed): calls, total ms, max ms, since process start. Read it
// at GET /api/diag/query-profile. Cost: one Map update per query (no I/O). Not in the Cloudflare tunnel allowlist, so local-only.
const profile = new Map();
const PROFILE_STARTED_AT = Date.now();
function shapeOf(text) {
  return text.replace(/\s+/g, ' ').trim().replace(/'[^']*'/g, "'?'").replace(/\$\d+/g, '$?').replace(/\b\d+(\.\d+)?\b/g, '#').replace(/\(\s*(?:[#$?']+\s*,\s*)+[#$?']+\s*\)/g, '(...)').slice(0, 140);
}
function recordProfile(text, ms) {
  const k = shapeOf(text);
  const e = profile.get(k);
  if (e) { e.calls++; e.totalMs += ms; if (ms > e.maxMs) e.maxMs = ms; }
  else if (profile.size < 2000) profile.set(k, { calls: 1, totalMs: ms, maxMs: ms });
}
export function getQueryProfile({ top = 25 } = {}) {
  const rows = [...profile.entries()].map(([shape, e]) => ({ shape, calls: e.calls, totalMs: Math.round(e.totalMs), avgMs: Math.round(e.totalMs / e.calls), maxMs: e.maxMs }));
  const totalMs = rows.reduce((a, r) => a + r.totalMs, 0), totalCalls = rows.reduce((a, r) => a + r.calls, 0);
  return { sinceMs: Date.now() - PROFILE_STARTED_AT, totalCalls, totalMs, byTotalMs: rows.sort((a, b) => b.totalMs - a.totalMs).slice(0, top) };
}

// Optional query interceptor (Fable audit F32/F27, 2026-11-11): the golden detection replay (scripts/replay/) records every statement and its rows at THIS boundary and later answers
// them from the recording. null in the server (one null check per query); only the replay scripts set it. fn(text, params, realQuery) must return a pg-shaped result.
let _interceptor = null;
export function setQueryInterceptor(fn) { _interceptor = fn; }
export const query = async (text, params) => {
  if (_interceptor) return _interceptor(text, params, realQuery);
  return realQuery(text, params);
};
const realQuery = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    recordProfile(text, duration);
    // Log only SLOW queries by default (>= SQL_LOG_SLOW_MS, 500ms); DEBUG_SQL=1 restores the old log-everything
    // behaviour. 2026-10-19: logging every query (800-3000 lines/minute) kept journald to ~20 hours of history, which
    // destroyed the evidence for an 18:33 Sunday signal investigation. Errors are always logged (catch below).
    const slowMs = Number(process.env.SQL_LOG_SLOW_MS) || 500;
    if (process.env.NODE_ENV !== 'production' && (process.env.DEBUG_SQL === '1' || duration >= slowMs)) {
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
