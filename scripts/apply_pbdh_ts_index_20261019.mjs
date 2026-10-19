#!/usr/bin/env node
// One-time, measured creation of idx_pbdh_ts (A1 in docs/PRICE_BARS_AND_STARTUP_SPEED_SPEC.md). Plain CREATE INDEX (CONCURRENTLY is not allowed on a materialized
// view): takes a SHARE lock, so readers keep working but the nightly REFRESH would wait -- therefore it refuses to run in the 20:00-21:30 ET calibration window or
// while a REFRESH is running. Records the day-query timing before and after. Rollback: DROP INDEX idx_pbdh_ts. Idempotent.
import { query } from '../server/db.js';
const hm = (await query(`SELECT (EXTRACT(hour FROM now())*60 + EXTRACT(minute FROM now()))::int AS m`)).rows[0].m;
if (hm >= 20 * 60 && hm < 21 * 60 + 30) { console.error('refusing: inside the 20:00-21:30 ET nightly calibration window'); process.exit(1); }
const busy = await query(`SELECT 1 FROM pg_stat_activity WHERE query ILIKE 'REFRESH MATERIALIZED VIEW%' AND pid <> pg_backend_pid()`);
if (busy.rowCount) { console.error('refusing: a REFRESH MATERIALIZED VIEW is running'); process.exit(1); }
const Q = `SELECT ts, close FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 3 AND ts < CURRENT_DATE - 2`;
async function time(label) {
  const times = [];
  for (let i = 0; i < 5; i++) { const r = await query(`EXPLAIN (ANALYZE, TIMING OFF) ${Q}`); times.push(Number(/Execution Time: ([\d.]+)/.exec(r.rows.map(x => x['QUERY PLAN']).join('\n'))[1])); }
  times.sort((a, b) => a - b); console.log(`${label}: day query median ${times[2].toFixed(1)} ms (runs: ${times.map(t => t.toFixed(0)).join(', ')})`);
}
const maxPlan = async () => (await query(`EXPLAIN SELECT max(ts) FROM price_bars_dedup_hist`)).rows.map(x => x['QUERY PLAN']).join(' | ').slice(0, 160);
await time('BEFORE'); console.log('max(ts) plan before:', await maxPlan());
const t0 = Date.now();
await query(`CREATE INDEX IF NOT EXISTS idx_pbdh_ts ON price_bars_dedup_hist (ts)`);
await query(`ANALYZE price_bars_dedup_hist`);
console.log(`index built + analyzed in ${Date.now() - t0} ms`);
await time('AFTER '); console.log('max(ts) plan after: ', await maxPlan());
process.exit(0);
