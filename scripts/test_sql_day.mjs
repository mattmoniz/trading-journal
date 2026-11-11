// F11 (Fable audit 2026-11-10): the range form of the day predicate returns the same rows as `ts::date = X` on price_bars_primary. Read-only. Run: node scripts/test_sql_day.mjs
import assert from 'node:assert/strict';
import { query } from '../server/db.js';
import { dayEq } from '../server/lib/sqlDay.js';
const dates = (await query(`SELECT DISTINCT ts::date::text d FROM price_bars_dedup_hist WHERE symbol='NQ' AND ts >= '2026-05-01' AND ts < '2026-11-01' ORDER BY 1`)).rows.map((r) => r.d);
const pick = [dates[0], dates[Math.floor(dates.length / 3)], dates[Math.floor(dates.length / 2)], dates[dates.length - 1], '2026-11-09', '2026-11-10'];
const agg = `count(*)::int n, MAX(high)::float h, MIN(low)::float l, SUM(volume)::bigint v, MIN(ts)::text t0, MAX(ts)::text t1`;
for (const d of pick) {
  const a = (await query(`SELECT ${agg} FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1`, [d])).rows[0];
  const b = (await query(`SELECT ${agg} FROM price_bars_primary WHERE symbol='NQ' AND ${dayEq('ts', '$1')}`, [d])).rows[0];
  assert.deepEqual(b, a, `day ${d}`);
}
console.log(`day predicate identical on ${pick.length} dates`); process.exit(0);
