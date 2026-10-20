// study_poc_join_vwap_slope_gate_20261020.mjs -- runs the PRE-REGISTERED VWAP-slope direction gate (docs/POC_JOIN_VWAP_SLOPE_GATE_PREREG_20261020.md, committed 01faffe before any outcome).
// Primary: fire only ALIGNED joins (long when the session VWAP slopes up over the last 60 min, short when it slopes down; flat cut = rolling 33rd percentile of |slope| over the previous 20 RTH dates). Secondary tables are exploratory only.
import fs from 'fs';
import { loadBars, sessionIndex, buildEvents, fwd, simE1, mean, sum, f, lb, addDay, rnd } from './lib/pocJoinLoader.mjs';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01', K = Number(process.env.SLOPE_K) || 60;
const D = await loadBars(FROM, TO), S = sessionIndex(D), events = await buildEvents(D, FROM, TO, { R: 65, rMode: 'fixed' });
const vcache = new Map();
function vwapOf(d) { if (vcache.has(d)) return vcache.get(d); const a = lb(D.TS, addDay(d, -1) + ' 18:00:00'), b = lb(D.TS, d + ' 17:00:00'); const bars = []; for (let i = a; i < b; i++) bars.push({ high: D.H[i], low: D.L[i], close: D.C[i], volume: D.V[i] }); const out = { a, vw: bars.length ? computeRunningVwapSeries(bars) : [] }; vcache.set(d, out); return out; }
const absSamples = new Map(); function samples(d) { if (absSamples.has(d)) return absSamples.get(d); const { vw } = vwapOf(d), s = []; for (let t = K; t < vw.length; t += 15) s.push(Math.abs(vw[t] - vw[t - K])); absSamples.set(d, s); return s; }
const cutCache = new Map(); function flatCut(d) { if (cutCache.has(d)) return cutCache.get(d); const j = lb(S.dates, d), prior = S.dates.slice(Math.max(0, j - 20), j); let out = null; if (prior.length === 20) { const v = prior.flatMap(samples).sort((x, y) => x - y); out = v.length ? v[Math.floor((v.length - 1) / 3)] : null; } cutCache.set(d, out); return out; }
const rows = []; let undefinedN = 0;
for (let i = 0; i < events.length; i++) { const w = fwd(D, events, i); if (!w) continue; const e = events[i], t = e.trig - e.a, { vw } = vwapOf(e.d), c = flatCut(e.d); if (t < K || !c || vw[t] == null || vw[t - K] == null) { undefinedN++; continue; }
  const simK = simE1(D, e, w[0], w[1]); const slope = vw[t] - vw[t - K], cls = slope > c ? 'UP' : slope < -c ? 'DOWN' : 'FLAT', m = +D.TS[e.ei].slice(11, 13) * 60 + +D.TS[e.ei].slice(14, 16);
  const aligned = (e.long && cls === 'UP') || (!e.long && cls === 'DOWN'), opposed = (e.long && cls === 'DOWN') || (!e.long && cls === 'UP');
  rows.push({ d: e.d, month: e.d.slice(0, 7), long: e.long, cls, aligned, opposed, flat: cls === 'FLAT', session: m >= 570 && m < 960 ? 'RTH' : 'GLOBEX', era: e.d < SPLIT ? 'PRE' : 'POST', ei: e.ei, exitK: simK.k, pnl: simK.pnl, pnlFlip: simE1(D, e, w[0], w[1], { long: !e.long }).pnl, priceAbove: D.C[e.trig] > vw[t] }); }
fs.writeFileSync('scratch/poc_join_vwap_rows_20261020.json', JSON.stringify(rows));
console.log(`slope window ${K} min. joins with a defined class ${rows.length} (undefined/early ${undefinedN}). Classes: UP ${rows.filter(r => r.cls === 'UP').length}, DOWN ${rows.filter(r => r.cls === 'DOWN').length}, FLAT ${rows.filter(r => r.flat).length}; aligned ${rows.filter(r => r.aligned).length}, opposed ${rows.filter(r => r.opposed).length}`);
function boot(arr, stat, n = 2000) { const by = new Map(); for (const r of arr) (by.get(r.d) || by.set(r.d, []).get(r.d)).push(r); const ds = [...by.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(...ds[(rnd() * ds.length) | 0]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const pa = (pick) => mean(pick.filter(r => r.aligned).map(r => r.pnl)) - mean(pick.map(r => r.pnl)), ao = (pick) => mean(pick.filter(r => r.aligned).map(r => r.pnl)) - mean(pick.filter(r => r.opposed).map(r => r.pnl));
const big = (a) => a.filter(r => r.pnl >= 100).length / a.length;
function section(label, sub) { const A = sub.filter(r => r.aligned), Op = sub.filter(r => r.opposed), Fl = sub.filter(r => r.flat), am = mean(A.map(r => r.pnl)), all = mean(sub.map(r => r.pnl)), [lo, hi] = boot(sub, pa, 1200);
  const srt = [...A].sort((x, y) => y.pnl - x.pnl), tot = sum(A.map(r => r.pnl)), top5 = tot > 0 ? sum(srt.slice(0, 5).map(r => r.pnl)) / tot : Infinity;   // guard (DeepSeek 2026-10-20): a non-positive total can never satisfy a concentration criterion
  console.log(`${label.padEnd(10)} N all ${String(sub.length).padStart(4)} | aligned ${String(A.length).padStart(4)} ${f(am, 1).padStart(7)} | opposed ${String(Op.length).padStart(4)} ${f(mean(Op.map(r => r.pnl)), 1).padStart(7)} | flat ${String(Fl.length).padStart(4)} ${f(mean(Fl.map(r => r.pnl)), 1).padStart(7)} | all ${f(all, 1).padStart(6)} | aligned-all ${f(am - all, 1)} [${f(lo, 1)},${f(hi, 1)}] | flipped ${f(mean(A.map(r => r.pnlFlip)), 1)} | P>=100 ${(100 * big(A)).toFixed(0)}%/${(100 * big(sub)).toFixed(0)}% | top5 ${Number.isFinite(top5) ? (100 * top5).toFixed(0) + '%' : 'n/a (total<=0)'}`);
  return { n: A.length, diff: am - all, lo, hi, am, flip: mean(A.map(r => r.pnlFlip)), top5, bigA: big(A), bigAll: big(sub), nOp: Op.length, opM: mean(Op.map(r => r.pnl)) }; }
console.log('\n=== PRIMARY (slope window ' + K + ') ===');
const O = section('OVERALL', rows), pre = section('PRE', rows.filter(r => r.era === 'PRE')), post = section('POST', rows.filter(r => r.era === 'POST')), rth = section('RTH', rows.filter(r => r.session === 'RTH')), glx = section('GLOBEX', rows.filter(r => r.session === 'GLOBEX'));
const [alo, ahi] = boot(rows, ao, 1500);
// permutation: shuffle class labels within month x session
const groups = new Map(); rows.forEach((r, i) => { const k = r.month + r.session + (r.long ? 'L' : 'S');   // shuffle labels WITHIN direction (DeepSeek 2026-10-20: keeps long/short composition fixed)
   (groups.get(k) || groups.set(k, []).get(k)).push(i); });
const obs = pa(rows); let ge = 0; const NP = 2000; const cls = rows.map(r => r.cls);
for (let p = 0; p < NP; p++) { const sh = rows.map(r => ({ ...r })); for (const idx of groups.values()) { const labs = idx.map(i => cls[i]); for (let i = labs.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [labs[i], labs[j]] = [labs[j], labs[i]]; } idx.forEach((i, k) => { sh[i].cls = labs[k]; sh[i].aligned = (sh[i].long && labs[k] === 'UP') || (!sh[i].long && labs[k] === 'DOWN'); }); } if (pa(sh) >= obs) ge++; }
const pperm = ge / NP; console.log(`\naligned minus opposed (overall): ${f(O.am - O.opM, 1)} CI [${f(alo, 1)},${f(ahi, 1)}] | permutation p (aligned-all >= observed ${f(obs, 2)}): ${pperm.toFixed(4)}`);
console.log('\n=== EXPLORATORY (descriptive only) ===');
for (const [lab, fn] of [['FLAT all', r => r.flat], ['FLAT RTH', r => r.flat && r.session === 'RTH'], ['FLAT GLOBEX', r => r.flat && r.session === 'GLOBEX'], ['FLAT PRE', r => r.flat && r.era === 'PRE'], ['FLAT POST', r => r.flat && r.era === 'POST'], ['price-side aligned', r => (r.long && r.priceAbove) || (!r.long && !r.priceAbove)], ['price-side opposed', r => (r.long && !r.priceAbove) || (!r.long && r.priceAbove)]]) { const a = rows.filter(fn); console.log(lab.padEnd(20), 'N', String(a.length).padStart(5), 'mean', f(mean(a.map(r => r.pnl)), 1).padStart(7), 'P>=100', (100 * big(a)).toFixed(0) + '%'); }
const P = (ok, t) => console.log((ok ? 'PASS ' : 'FAIL ') + t);
console.log('\n=== PRE-REGISTERED CRITERIA ===');
P(O.n >= 150 && rth.n >= 50 && glx.n >= 50 && pre.n >= 50 && post.n >= 50, `1. N aligned (overall ${O.n}, RTH ${rth.n}, GLOBEX ${glx.n}, PRE ${pre.n}, POST ${post.n})`);
P(O.diff > 0 && O.lo > 0 && pre.diff > 0 && post.diff > 0 && rth.diff > 0 && glx.diff > 0, `2. aligned-minus-all positive overall with CI above zero and in PRE/POST/RTH/GLOBEX (${f(O.diff, 1)} [${f(O.lo, 1)},${f(O.hi, 1)}]; PRE ${f(pre.diff, 1)} POST ${f(post.diff, 1)} RTH ${f(rth.diff, 1)} GLOBEX ${f(glx.diff, 1)})`);
P(alo > 0, `3. aligned minus opposed CI above zero ([${f(alo, 1)},${f(ahi, 1)}])`);
P(pperm <= 0.05, `4. permutation p <= 0.05 (${pperm.toFixed(4)})`);
P(O.am > O.flip && pre.am > pre.flip && post.am > post.flip, `5. aligned beats flipped-direction placebo overall/PRE/POST`);
P(O.top5 < 0.5, `6. top-5 share < 50% of a POSITIVE total (${Number.isFinite(O.top5) ? (100 * O.top5).toFixed(0) + '%' : 'total<=0'})`);
P(O.bigA > O.bigAll, `7. P(pnl>=+100) aligned > all (${(100 * O.bigA).toFixed(1)}% vs ${(100 * O.bigAll).toFixed(1)}%)`);
process.exit(0);
