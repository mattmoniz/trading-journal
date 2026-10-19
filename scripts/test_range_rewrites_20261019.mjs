#!/usr/bin/env node
// Standing equivalence check for the 2026-10-19 A2 rewrites (docs/PRICE_BARS_AND_STARTUP_SPEED_SPEC.md): every `ts::date` predicate that was turned into a
// half-open raw-column range must return exactly the same rows as the original. Each case is [name, oldSql, newSql, params]; the check runs both over several
// dates (a normal weekday, a Monday, a DST-change week, a roll week, today) and compares JSON of the full result. Exit 1 on any difference.
import { query } from '../server/db.js';
const dates = (await query(`SELECT d::text FROM (SELECT CURRENT_DATE d UNION SELECT DATE '2026-03-09' UNION SELECT DATE '2026-03-16' UNION SELECT DATE '2025-11-03' UNION SELECT DATE '2025-11-10' UNION SELECT DATE '2026-09-14' UNION SELECT DATE '2026-06-15' UNION SELECT CURRENT_DATE-3) x ORDER BY d`)).rows.map(r => r.d);
const cases = [];
export function addCase(name, oldSql, newSql, mapParams = d => [d]) { cases.push({ name, oldSql, newSql, mapParams }); }
const mod = await import('./range_rewrite_cases_20261019.mjs');
mod.register(addCase);
// Exact equality, except numbers may differ by 1e-9 relative: a different plan sums floats in a different order (seen: 4e-16 on AVG/STDDEV).
function sameVal(x, y) {
  if (typeof x === 'number' && typeof y === 'number') return x === y || Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return JSON.stringify(x) === JSON.stringify(y);
}
function sameRows(a, b) {
  if (a.length !== b.length) return false;
  return a.every((r, i) => Object.keys(r).length === Object.keys(b[i]).length && Object.keys(r).every(k => sameVal(r[k], b[i][k])));
}
let bad = 0;
for (const c of cases) {
  for (const d of dates) {
    const p = c.mapParams(d);
    const t0 = Date.now(); const a = (await query(c.oldSql, p)).rows; const t1 = Date.now();
    const b = (await query(c.newSql, p)).rows; const t2 = Date.now();
    const same = sameRows(a, b);
    if (!same) bad++;
    console.log(`${same ? 'OK  ' : 'DIFF'} ${c.name} ${d} rows=${a.length} old=${t1 - t0}ms new=${t2 - t1}ms`);
  }
}
console.log(bad ? `${bad} DIFFERENCES` : 'all rewrites identical');
process.exit(bad ? 1 : 0);
