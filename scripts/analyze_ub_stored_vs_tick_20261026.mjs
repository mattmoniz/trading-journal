// Paired unified-backtest comparison: the 24 level-fade setup types on the PD/PW/PM/3M VAH/VAL/POC families, run on matched stored-level and tick-level tables
// (scripts/build_tick_level_tables_20261026.mjs, scripts/backtest_unified.js with UB_LEVELS_TABLE/UB_DUMP). Same detectors, same exits, same dates; only those 12 level values differ.
// Reports per type and per family: trades, mean $ per trade, win rate under each version, trades unique to each, and the date-blocked CI of (tick - stored) mean per trade.
import fs from 'fs';
import { diffCI, dc } from './lib/exitSim.mjs';
const A = JSON.parse(fs.readFileSync('scratch/ub_stored_20261026.json')), B = JSON.parse(fs.readFileSync('scratch/ub_tick_20261026.json'));
const types = Object.keys({ ...A, ...B }).filter((x) => /^(PD|PW|PM|3M)_(VAH|VAL|POC)_(LONG|SHORT)$/.test(x)).sort();
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN), f = (x, d = 1) => (Number.isNaN(x) ? '  n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const wr = (a) => (a.length ? (100 * a.filter((t) => t.pnl > 0).length / a.length).toFixed(0) + '%' : 'n/a');
const rows = [], byFam = {};
for (const t of types) {
  const a = A[t] || [], b = B[t] || [], ka = new Set(a.map((x) => x.date)), kb = new Set(b.map((x) => x.date)), onlyA = a.filter((x) => !kb.has(x.date)).length, onlyB = b.filter((x) => !ka.has(x.date)).length;
  rows.push({ t, na: a.length, nb: b.length, ma: mean(a.map((x) => x.pnl)), mb: mean(b.map((x) => x.pnl)), wa: wr(a), wb: wr(b), onlyA, onlyB });
  const fam = t.split('_')[0]; (byFam[fam] ||= { a: [], b: [] }); byFam[fam].a.push(...a); byFam[fam].b.push(...b);
}
console.log('type              | stored N  $/trade  WR  | tick N  $/trade  WR  | stored-only  tick-only | status proxy (N>=20 and $/trade>0)');
for (const r of rows) { const sa = r.na >= 20 && r.ma > 0, sb = r.nb >= 20 && r.mb > 0; console.log(`${r.t.padEnd(17)} | ${String(r.na).padStart(5)} ${f(r.ma).padStart(7)} ${r.wa.padStart(4)} | ${String(r.nb).padStart(5)} ${f(r.mb).padStart(7)} ${r.wb.padStart(4)} | ${String(r.onlyA).padStart(5)} ${String(r.onlyB).padStart(5)} | ${sa ? 'keep' : 'drop'} -> ${sb ? 'keep' : 'drop'}${sa !== sb ? '   <== FLIPS' : ''}`); }
console.log('\nBY FAMILY and POOLED (mean $ per trade; difference = tick minus stored with date-blocked 95% CI, arms resampled by date)');
const all = { a: [], b: [] }; for (const [fam, o] of Object.entries(byFam)) { all.a.push(...o.a); all.b.push(...o.b); }
for (const [fam, o] of [...Object.entries(byFam), ['ALL 4 FAMILIES', all]]) { const A1 = o.a.map((x) => ({ day: x.date, v: x.pnl })), B1 = o.b.map((x) => ({ day: x.date, v: x.pnl })), c = A1.length > 5 && B1.length > 5 ? diffCI(B1, A1, fam) : { lo: NaN, hi: NaN };
  console.log(`${fam.padEnd(15)} stored N ${String(o.a.length).padStart(5)} ${f(mean(A1.map((x) => x.v))).padStart(7)} | tick N ${String(o.b.length).padStart(5)} ${f(mean(B1.map((x) => x.v))).padStart(7)} | tick-stored ${f(mean(B1.map((x) => x.v)) - mean(A1.map((x) => x.v)))} [${f(c.lo)},${f(c.hi)}]  (${dc(A1)} / ${dc(B1)} dates)`); }
