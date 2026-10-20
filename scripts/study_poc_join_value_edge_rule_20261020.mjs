// study_poc_join_value_edge_rule_20261020.mjs -- runs the PRE-REGISTERED single rule in docs/POC_JOIN_VALUE_EDGE_RULE_PREREG_20261020.md (committed 9f0ad20 before any outcome was computed).
// Rule: a join passes if its leg ANCHOR lies within 0.15 x ATR20 of PD_VAL (LONG join) / PD_VAH (SHORT join). Outcome = realistic-fill live-exit E1 P&L. Placebos: flipped direction; PD levels shifted +/-0.3/0.6 ATR20.
// Do not add rules/cells here; sensitivity at 0.10/0.25 is printed as sensitivity only. Independent Gemini build: scratch/gemini_poc_join_value_edge_rule.mjs.
import fs from 'fs';
import { query } from '../server/db.js';
import { detectSignalEvents } from '../server/services/pocRotationService.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01', PROX = 0.15, SHIFTS = [-0.6, -0.3, 0.3, 0.6];
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; }, mean = (a) => a.length ? sum(a) / a.length : NaN, f = (x, d = 1) => (x == null || Number.isNaN(x) ? ' n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const epoch = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16)) / 60000;
const addDay = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const T = [], TS = [], O = [], H = [], Lw = [], C = [];
{ let cur = new Date(FROM + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 200); const end = new Date(TO + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 3);
  while (cur < end) { const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
    for (const x of (await query(`SELECT ts::text ts, open::float o, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows) { TS.push(x.ts); T.push(epoch(x.ts)); O.push(x.o); H.push(x.h); Lw.push(x.l); C.push(x.c); }
    cur = nxt; } }
const lb = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
const ub = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; };
const rc = new Map(); const rthRange = (d) => { if (rc.has(d)) return rc.get(d); const a = lb(TS, d + ' 09:30:00'), b = lb(TS, d + ' 16:00:00'); let r = null; if (b - a > 200) { let hi = -Infinity, lo = Infinity; for (let i = a; i < b; i++) { hi = Math.max(hi, H[i]); lo = Math.min(lo, Lw[i]); } r = hi - lo; } rc.set(d, r); return r; };
const atr20 = (d) => { const xs = []; let k = 1; while (xs.length < 20 && k < 60) { const r = rthRange(addDay(d, -k)); if (r != null) xs.push(r); k++; } return xs.length === 20 ? mean(xs) : null; };
const dates = (await query(`SELECT DISTINCT trade_date::text d FROM developing_value_log WHERE trade_date >= $1::date AND trade_date <= $2::date ORDER BY d`, [FROM, TO])).rows.map(r => r.d).filter(d => !isInsideNqRollWeek(d));
const PD = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND level_name IN ('PD_VAH','PD_VAL')`, [FROM, TO])).rows) (PD.get(r.d) || PD.set(r.d, {}).get(r.d))[r.n] = r.p;
const events = [];
for (const d of dates) {
  const a = lb(TS, addDay(d, -1) + ' 18:00:00'), b = lb(TS, d + ' 17:00:00'); const bars = []; for (let i = a; i < b; i++) bars.push({ ts: TS[i], open: O[i], high: H[i], low: Lw[i], close: C[i] });
  if (bars.length < 100 || bars.length < 0.9 * (T[b - 1] - T[a] + 1)) continue;
  const th = (await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) m FROM price_bars_primary WHERE symbol='NQ' AND ts < $1::date AND ts >= $1::date - interval '180 days'`, [d])).rows[0]?.m; const theta = th ? Math.max(0.25, +th) : 6.75;
  const A = atr20(d), pd = PD.get(d); const { all_signal } = detectSignalEvents(65, 'standard', theta, [{ t: d, bars }], 'fixed');
  for (const ev of all_signal) { if (ev.entry_idx == null) continue; const ei = a + ev.entry_idx, long = ev.direction === 'UP', ls = a + ev.leg_start;
    events.push({ d, ep: T[ei], ei, entry: O[ei], long, A, anchor: long ? Lw[ls] : H[ls], vah: pd?.PD_VAH, val: pd?.PD_VAL, era: d < SPLIT ? 'PRE' : 'POST' }); }
}
events.sort((x, y) => x.ep - y.ep);
function simE1(e, long, fi, last) {            // realistic-fill E1 in direction `long`
  let stop = long ? e.entry - 100 : e.entry + 100, armed = false;
  for (let k = fi; k <= last; k++) { if (!armed && k - fi >= 60) { armed = true; stop = e.entry; }
    if (long ? Lw[k] <= stop : H[k] >= stop) { const fill = long ? Math.min(stop, O[k]) : Math.max(stop, O[k]); return (long ? fill - e.entry : e.entry - fill) * 2 - 2; } }
  return (long ? C[last] - e.entry : e.entry - C[last]) * 2 - 2; }
const rows = [];
for (let i = 0; i < events.length; i++) { const e = events[i], bound = Math.min(e.ep + 1440, i + 1 < events.length ? events[i + 1].ep : Infinity), fi = ub(T, e.ep), last = ub(T, bound) - 1;
  if (last - fi + 1 < 2 || !e.A || e.vah == null || e.val == null) continue;
  const edge = e.long ? e.val : e.vah, hit = (shift, px) => Math.abs(e.anchor - (edge + shift * e.A)) <= px * e.A;
  rows.push({ ...e, pnl: simE1(e, e.long, fi, last), pnlFlip: simE1(e, !e.long, fi, last), pass: hit(0, PROX), pass10: hit(0, 0.10), pass25: hit(0, 0.25), shifted: SHIFTS.filter(s => hit(s, PROX)).length }); }
console.log(`events (usable: ATR20 + PD_VAL/VAH present) ${rows.length}; passing ${rows.filter(r => r.pass).length} (long ${rows.filter(r => r.pass && r.long).length}, short ${rows.filter(r => r.pass && !r.long).length}); PRE all/pass ${rows.filter(r => r.era === 'PRE').length}/${rows.filter(r => r.pass && r.era === 'PRE').length}, POST ${rows.filter(r => r.era === 'POST').length}/${rows.filter(r => r.pass && r.era === 'POST').length}`);
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
// day-blocked bootstrap of a statistic over per-day aggregates: fn(list of day groups) -> number
function boot(arr, stat, n = 2000) { const by = new Map(); for (const r of arr) (by.get(r.d) || by.set(r.d, []).get(r.d)).push(r); const ds = [...by.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(...ds[(rnd() * ds.length) | 0]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const passMinusAll = (pick) => mean(pick.filter(r => r.pass).map(r => r.pnl)) - mean(pick.map(r => r.pnl));
const realMinusShift = (pick) => mean(pick.filter(r => r.pass).map(r => r.pnl)) - (sum(pick.map(r => r.shifted * r.pnl)) / sum(pick.map(r => r.shifted)));
const section = (label, sub) => { const P = sub.filter(r => r.pass), pm = mean(P.map(r => r.pnl)), allm = mean(sub.map(r => r.pnl)), [lo, hi] = boot(sub, passMinusAll), big = (a) => a.filter(r => r.pnl >= 100).length / a.length;
  const srt = [...P].sort((x, y) => y.pnl - x.pnl), top5 = sum(srt.slice(0, 5).map(r => r.pnl)) / sum(P.map(r => r.pnl)), flipM = mean(P.map(r => r.pnlFlip)), shM = sum(sub.map(r => r.shifted * r.pnl)) / sum(sub.map(r => r.shifted));
  console.log(`\n${label}: N all ${sub.length}, N pass ${P.length}, days(pass) ${new Set(P.map(r => r.d)).size}`);
  console.log(`  mean pnl: pass ${f(pm, 2)}  all ${f(allm, 2)}  pass-minus-all ${f(pm - allm, 2)} CI [${f(lo, 1)},${f(hi, 1)}]`);
  console.log(`  P(pnl>=+100): pass ${(100 * big(P)).toFixed(1)}%  all ${(100 * big(sub)).toFixed(1)}% | sum captured by pass ${(100 * sum(P.map(r => r.pnl)) / sum(sub.map(r => r.pnl))).toFixed(0)}% of total | top-5 share of pass total ${(100 * top5).toFixed(0)}%`);
  console.log(`  placebo 1 (flipped direction, same entries): pass-set mean ${f(flipM, 2)} | placebo 2 (shifted PD levels, pooled): mean ${f(shM, 2)}`);
  return { n: P.length, diff: pm - allm, lo, hi, flipM, pm, top5, bigPass: big(P), bigAll: big(sub), shM }; };
const all = section('OVERALL', rows), pre = section('PRE (<2025-06-01)', rows.filter(r => r.era === 'PRE')), post = section('POST (>=2025-06-01)', rows.filter(r => r.era === 'POST'));
const [dlo, dhi] = boot(rows, realMinusShift); console.log(`\nreal-level pass mean minus shifted-level pass mean: ${f(all.pm - all.shM, 2)}  CI [${f(dlo, 1)},${f(dhi, 1)}]`);
console.log('\nSENSITIVITY ONLY (not for selection): proximity 0.10 -> N pass', rows.filter(r => r.pass10).length, 'mean', f(mean(rows.filter(r => r.pass10).map(r => r.pnl)), 2), '| 0.25 -> N pass', rows.filter(r => r.pass25).length, 'mean', f(mean(rows.filter(r => r.pass25).map(r => r.pnl)), 2));
const P = (ok, txt) => console.log((ok ? 'PASS ' : 'FAIL ') + txt);
console.log('\n=== PRE-REGISTERED CRITERIA ===');
P(pre.n >= 60 && post.n >= 60, `1. N pass >= 60 in each era (PRE ${pre.n}, POST ${post.n})`);
P(pre.diff > 0 && post.diff > 0 && all.lo > 0, `2. pass-minus-all > 0 in both eras (PRE ${f(pre.diff, 2)}, POST ${f(post.diff, 2)}) and overall CI excludes zero ([${f(all.lo, 1)},${f(all.hi, 1)}])`);
P(dlo > 0, `3. real-minus-shifted-level CI excludes zero ([${f(dlo, 1)},${f(dhi, 1)}])`);
P(all.pm > all.flipM && pre.pm > pre.flipM && post.pm > post.flipM, `4. pass mean beats its flipped-direction placebo overall/PRE/POST (${f(all.pm, 1)} vs ${f(all.flipM, 1)}; ${f(pre.pm, 1)} vs ${f(pre.flipM, 1)}; ${f(post.pm, 1)} vs ${f(post.flipM, 1)})`);
P(all.top5 < 0.5, `5. top-5 share of the passing set's total < 50% (${(100 * all.top5).toFixed(0)}%)`);
P(all.bigPass > all.bigAll, `6. P(pnl>=+100) of passing > all (${(100 * all.bigPass).toFixed(1)}% vs ${(100 * all.bigAll).toFixed(1)}%)`);
fs.writeFileSync('scratch/poc_join_value_edge_rows_20261020.json', JSON.stringify(rows)); process.exit(0);
