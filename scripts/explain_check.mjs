#!/usr/bin/env node
// Check a query BEFORE it ships (2026-10-19): does it read a whole big table?
//   node scripts/explain_check.mjs "SELECT ... WHERE ts >= $1" '2026-10-01'      (parameters after the SQL, in order)
//   node scripts/explain_check.mjs --file path/to/query.sql [params...]
// Runs EXPLAIN (it does not execute the query) and lists every full scan of a "big" table -- the tables that together hold 90% of the database bytes, the
// same data-derived definition scripts/data_growth_check.mjs uses -- plus filters that wrap the column in a cast (e.g. ts::date), which stop an index being used.
// A full scan of a big table is not always wrong (a once-a-night job may be fine), but on anything that runs every poll or page load it is the thing that
// gets slower as the table grows. Exit code 1 when one is found, so it can gate a script.
import fs from 'node:fs';
import { query } from '../server/db.js';
const args = process.argv.slice(2);
let sql;
if (args[0] === '--file') { sql = fs.readFileSync(args[1], 'utf8'); args.splice(0, 2); } else sql = args.shift();
if (!sql) { console.error('usage: explain_check.mjs "<sql>" [params...]  |  --file query.sql [params...]'); process.exit(2); }
const params = args;
const tabs = (await query(`SELECT c.relname, pg_total_relation_size(c.oid)::float/1048576 mb, c.reltuples::bigint rows FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','m') AND NOT c.relispartition ORDER BY 2 DESC`)).rows;
const total = tabs.reduce((a, t) => a + t.mb, 0);
const big = new Map(); let cum = 0;
for (const t of tabs) { if (cum / total >= 0.9) break; big.set(t.relname, t); cum += t.mb; }
const plan = (await query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
const hits = [], casts = [];
(function walk(n) {
  if (n['Node Type'] === 'Seq Scan' && n['Relation Name']) {
    const rel = n['Relation Name'];
    const parent = [...big.keys()].find(b => rel === b || rel.startsWith(b + '_'));   // partitions count as their parent
    if (parent) hits.push({ rel, parent, rows: n['Plan Rows'], filter: n['Filter'] || null });
    if (n['Filter'] && /\)::date|::date\b|date_trunc|EXTRACT\(/i.test(n['Filter'])) casts.push({ rel, filter: n['Filter'] });
  }
  for (const c of n['Plans'] || []) walk(c);
})(plan.Plan);
console.log(`planned cost ${plan.Plan['Total Cost']}, planned rows ${plan.Plan['Plan Rows']}`);
if (!hits.length) console.log('OK: no full scan of a big table.');
const byParent = new Map();
for (const h of hits) { const e = byParent.get(h.parent) || { n: 0, filter: h.filter }; e.n++; byParent.set(h.parent, e); }
for (const [parent, e] of byParent) console.log(`FULL SCAN of ${parent}${e.n > 1 ? ` (${e.n} partitions)` : ''} (${big.get(parent).mb.toFixed(0)} MB, ~${Number(big.get(parent).rows).toLocaleString()} rows). Filter: ${e.filter || '(none)'}`);
for (const f of new Set(casts.map(c => c.filter))) console.log(`  note: this filter wraps a column in a cast/function, which prevents an index: ${f.slice(0, 200)}`);
if (hits.length) console.log('If this runs on every poll/page load: bound it (date range on the raw column), cache it for the day (getCached DAY_CACHE_TTL), or add an index.');
process.exit(hits.length ? 1 : 0);
