// study_poc_join_multiday_value_20261020.mjs -- EXPLORATORY (user question 2026-10-20): where is a POC join relative to the rolling 3/5/10-session composite value area, and is it breaking out of the area it has been in
// or staying inside the larger value? Classes use the join direction: position of the LEG ANCHOR and of the ENTRY vs the composite VA of the prior N RTH sessions (computeProfile from developingValueService.js, point-in-time: sessions strictly before the trade date).
// position normalized by the join direction: -1 = behind the area (below for a long), 0 = inside, +1 = ahead of it. (anchor,entry): (-1,-1) APPROACH, (-1,0) ENTERING, (-1,+1) TRAVERSING, (0,0) CONTAINED, (0,+1) BREAKOUT, (+1,+1) EXTENDED.
// Outcome = realistic-fill live exit E1 P&L (same as the pre-registered rule test). Exploratory: reports cell counts, era split, tail metric, and ONE target idea (take profit at the far edge ahead, same stop/breakeven) -- every positive cell is a lead needing its own pre-registration + placebo.
import fs from 'fs';
import { query } from '../server/db.js';
import { detectSignalEvents } from '../server/services/pocRotationService.js';
import { computeProfile } from '../server/services/developingValueService.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01', WINS = [3, 5, 10];
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; }, mean = (a) => a.length ? sum(a) / a.length : NaN, f = (x, d = 1) => (x == null || Number.isNaN(x) ? ' n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const epoch = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16)) / 60000;
const addDay = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const T = [], TS = [], O = [], H = [], Lw = [], C = [], V = [];
{ let cur = new Date(FROM + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 60); const end = new Date(TO + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 3);
  while (cur < end) { const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
    for (const x of (await query(`SELECT ts::text ts, open::float o, high::float h, low::float l, close::float c, COALESCE(volume,0)::float v FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows) { TS.push(x.ts); T.push(epoch(x.ts)); O.push(x.o); H.push(x.h); Lw.push(x.l); C.push(x.c); V.push(x.v); }
    cur = nxt; } }
const lb = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
const ub = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; };
// RTH session index: list of dates with a real RTH session, and a per-date [a,b) index range
const allDays = []; { const seen = new Set(); for (let i = 0; i < TS.length; i++) { const d = TS[i].slice(0, 10); if (!seen.has(d)) { seen.add(d); allDays.push(d); } } }
const rthIdx = new Map(); for (const d of allDays) { const a = lb(TS, d + ' 09:30:00'), b = lb(TS, d + ' 16:00:00'); if (b - a > 300) rthIdx.set(d, [a, b]); }
const rthDates = [...rthIdx.keys()].sort();
const vaCache = new Map(); function va(d, N) { const k = d + '|' + N; if (vaCache.has(k)) return vaCache.get(k); const j = lb(rthDates, d); const prior = rthDates.slice(Math.max(0, j - N), j); let out = null; if (prior.length === N) { const bars = []; for (const p of prior) { const [a, b] = rthIdx.get(p); for (let i = a; i < b; i++) bars.push({ high: H[i], low: Lw[i], volume: V[i] }); } const pr = computeProfile(bars); out = pr ? { vah: pr.vah, val: pr.val, poc: pr.poc } : null; } vaCache.set(k, out); return out; }
const dates = (await query(`SELECT DISTINCT trade_date::text d FROM developing_value_log WHERE trade_date >= $1::date AND trade_date <= $2::date ORDER BY d`, [FROM, TO])).rows.map(r => r.d).filter(d => !isInsideNqRollWeek(d));
const events = [];
for (const d of dates) {
  const a = lb(TS, addDay(d, -1) + ' 18:00:00'), b = lb(TS, d + ' 17:00:00'); const bars = []; for (let i = a; i < b; i++) bars.push({ ts: TS[i], open: O[i], high: H[i], low: Lw[i], close: C[i] });
  if (bars.length < 100 || bars.length < 0.9 * (T[b - 1] - T[a] + 1)) continue;
  const th = (await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) m FROM price_bars_primary WHERE symbol='NQ' AND ts < $1::date AND ts >= $1::date - interval '180 days'`, [d])).rows[0]?.m; const theta = th ? Math.max(0.25, +th) : 6.75;
  const { all_signal } = detectSignalEvents(65, 'standard', theta, [{ t: d, bars }], 'fixed');
  for (const ev of all_signal) { if (ev.entry_idx == null) continue; const ei = a + ev.entry_idx, long = ev.direction === 'UP', ls = a + ev.leg_start; events.push({ d, ep: T[ei], ei, entry: O[ei], long, anchor: long ? Lw[ls] : H[ls], era: d < SPLIT ? 'PRE' : 'POST' }); }
}
events.sort((x, y) => x.ep - y.ep);
function simE1(e, fi, last, tp) {      // realistic E1; optional take-profit tp (price) ahead; returns {pnl, exitK}
  const long = e.long; let stop = long ? e.entry - 100 : e.entry + 100, armed = false;
  for (let k = fi; k <= last; k++) { if (!armed && k - fi >= 60) { armed = true; stop = e.entry; }
    if (long ? Lw[k] <= stop : H[k] >= stop) { const fill = long ? Math.min(stop, O[k]) : Math.max(stop, O[k]); return { pnl: (long ? fill - e.entry : e.entry - fill) * 2 - 2, k }; }
    if (tp != null && (long ? H[k] >= tp : Lw[k] <= tp)) { const fill = long ? Math.max(tp, O[k]) : Math.min(tp, O[k]); return { pnl: (long ? fill - e.entry : e.entry - fill) * 2 - 2, k }; } }
  return { pnl: (long ? C[last] - e.entry : e.entry - C[last]) * 2 - 2, k: last }; }
const rows = [];
for (let i = 0; i < events.length; i++) { const e = events[i], bound = Math.min(e.ep + 1440, i + 1 < events.length ? events[i + 1].ep : Infinity), fi = ub(T, e.ep), last = ub(T, bound) - 1; if (last - fi + 1 < 2) continue;
  const base = simE1(e, fi, last, null); let mfe = 0; for (let k = fi; k <= base.k; k++) mfe = Math.max(mfe, e.long ? H[k] - e.entry : e.entry - Lw[k]);
  const r = { ...e, pnl: base.pnl, mfe, w: {} };
  for (const N of WINS) { const v = va(e.d, N); if (!v) continue; const sg = e.long ? 1 : -1, pos = (p) => (p > v.vah ? 1 : p < v.val ? -1 : 0) * sg, a = pos(e.anchor), en = pos(e.entry);
    const cls = { '-1,-1': 'APPROACH', '-1,0': 'ENTERING', '-1,1': 'TRAVERSING', '0,0': 'CONTAINED', '0,1': 'BREAKOUT', '1,1': 'EXTENDED' }[a + ',' + en] || 'OTHER';
    const edge = en === -1 ? (e.long ? v.val : v.vah) : en === 0 ? (e.long ? v.vah : v.val) : null, dist = edge != null ? Math.abs(edge - e.entry) : null;
    let tpPnl = r.pnl; if (edge != null && dist >= 1) tpPnl = simE1(e, fi, last, edge).pnl;
    r.w[N] = { cls, dist, reached: edge != null && mfe >= dist, tpPnl, width: v.vah - v.val }; }
  rows.push(r); }
console.log(`events ${rows.length}; VA windows ${WINS.join('/')} sessions`);
let seed = 4242; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
function ci(arr, fn, n = 1000) { const by = new Map(); for (const r of arr) (by.get(r.d) || by.set(r.d, []).get(r.d)).push(fn(r)); const ds = [...by.values()], S = ds.map(sum), Cn = ds.map(x => x.length), o = []; for (let b = 0; b < n; b++) { let s = 0, c = 0; for (let k = 0; k < ds.length; k++) { const j = (rnd() * ds.length) | 0; s += S[j]; c += Cn[j]; } if (c) o.push(s / c); } o.sort((a, b) => a - b); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const allM = mean(rows.map(r => r.pnl)); console.log(`ALL joins: N ${rows.length}, mean E1 ${f(allM, 2)}, P(>=+100) ${(100 * rows.filter(r => r.pnl >= 100).length / rows.length).toFixed(1)}%`);
let cells = 0;
for (const N of WINS) { console.log(`\n=== ${N}-session composite value area ===`); console.log('class'.padEnd(11), '    N  days   mean E1  [CI vs zero]     P>=100  top5%  | PRE mean (n)    POST mean (n)   | reach-edge%  tp-at-edge mean  tp-E1');
  for (const cls of ['APPROACH', 'ENTERING', 'TRAVERSING', 'CONTAINED', 'BREAKOUT', 'EXTENDED']) { const arr = rows.filter(r => r.w[N]?.cls === cls); cells++; if (arr.length < 40) { console.log(cls.padEnd(11), `thin N=${arr.length}`); continue; }
    const [lo, hi] = ci(arr, r => r.pnl), srt = [...arr].sort((x, y) => y.pnl - x.pnl), top5 = 100 * sum(srt.slice(0, 5).map(r => r.pnl)) / sum(arr.map(r => r.pnl)), pre = arr.filter(r => r.era === 'PRE'), post = arr.filter(r => r.era === 'POST'), withEdge = arr.filter(r => r.w[N].dist != null);
    console.log(cls.padEnd(11), String(arr.length).padStart(5), String(new Set(arr.map(r => r.d)).size).padStart(5), f(mean(arr.map(r => r.pnl)), 1).padStart(9) + (lo > 0 ? '*' : hi < 0 ? '!' : ' '), `[${f(lo, 0)},${f(hi, 0)}]`.padEnd(14), (100 * arr.filter(r => r.pnl >= 100).length / arr.length).toFixed(0).padStart(5) + '%', top5.toFixed(0).padStart(5) + '% |', f(mean(pre.map(r => r.pnl)), 1).padStart(6), `(${pre.length})`.padEnd(6), f(mean(post.map(r => r.pnl)), 1).padStart(6), `(${post.length})`.padEnd(6), '|', withEdge.length ? (100 * withEdge.filter(r => r.w[N].reached).length / withEdge.length).toFixed(0).padStart(6) + '%' : '   n/a', withEdge.length ? f(mean(withEdge.map(r => r.w[N].tpPnl)), 1).padStart(14) : '', withEdge.length ? f(mean(withEdge.map(r => r.pnl)), 1).padStart(8) : ''); } }
console.log(`\ncells examined: ${cells} (+ the target column). All EXPLORATORY: a cell is only a lead if both eras agree in sign, the CI excludes zero, top-5 share < 50% and it beats a shifted-value-area placebo (not yet run).`);
fs.writeFileSync('scratch/poc_join_multiday_rows_20261020.json', JSON.stringify(rows)); process.exit(0);
