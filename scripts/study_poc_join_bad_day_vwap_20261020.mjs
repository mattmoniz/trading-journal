// study_poc_join_bad_day_vwap_20261020.mjs -- runs the PRE-REGISTERED bad-day VWAP-gate test (docs/POC_JOIN_BAD_DAY_VWAP_PREREG_20261020.md, committed 772d043 before any outcome in this subset).
// STATE for an entry = realized E1 P&L of earlier joins of the same trade date whose exit bar index is STRICTLY BEFORE this entry bar (fixed 2026-10-20: <= let a join held to the next entry be marked at that bar's close, a one-bar lookahead affecting 41 percent of joins); BAD = state <= -400. Rule: in BAD state fire only VWAP-ALIGNED joins.
// Input: scratch/poc_join_vwap_rows_20261020.json (written by study_poc_join_vwap_slope_gate_20261020.mjs). Independent Gemini build: scratch/gemini_poc_join_bad_day_vwap.mjs.
import fs from 'fs';
import { mean, sum, f } from './lib/pocJoinLoader.mjs';
const R = JSON.parse(fs.readFileSync('scratch/poc_join_vwap_rows_20261020.json')).sort((a, b) => a.ei - b.ei);
const byDate = new Map(); for (const r of R) (byDate.get(r.d) || byDate.set(r.d, []).get(r.d)).push(r);
for (const r of R) r.state = sum((byDate.get(r.d)).filter(x => x.ei < r.ei && x.exitK < r.ei).map(x => x.pnl));
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
function boot(arr, stat, n = 2000) { const by = new Map(); for (const r of arr) (by.get(r.d) || by.set(r.d, []).get(r.d)).push(r); const ds = [...by.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(...ds[(rnd() * ds.length) | 0]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const pa = (p) => mean(p.filter(r => r.aligned).map(r => r.pnl)) - mean(p.map(r => r.pnl)), ao = (p) => mean(p.filter(r => r.aligned).map(r => r.pnl)) - mean(p.filter(r => r.opposed).map(r => r.pnl));
const big = (a) => a.filter(r => r.pnl >= 100).length / a.length;
function analyze(label, thr, print = true) { const S = R.filter(r => r.state <= thr); const A = S.filter(r => r.aligned), Op = S.filter(r => r.opposed);
  const seg = (name, sub) => { const a = sub.filter(r => r.aligned); if (a.length < 5) return { n: a.length, diff: NaN }; const all = mean(sub.map(r => r.pnl)), am = mean(a.map(r => r.pnl)); const [lo, hi] = boot(sub, pa, 1000); if (print) console.log(`  ${name.padEnd(8)} N all ${String(sub.length).padStart(4)} aligned ${String(a.length).padStart(3)} ${f(am, 1).padStart(7)} | opposed ${String(sub.filter(r => r.opposed).length).padStart(3)} ${f(mean(sub.filter(r => r.opposed).map(r => r.pnl)), 1).padStart(7)} | all ${f(all, 1).padStart(6)} | aligned-all ${f(am - all, 1)} [${f(lo, 1)},${f(hi, 1)}] | flipped ${f(mean(a.map(r => r.pnlFlip)), 1)}`); return { n: a.length, diff: am - all, lo, hi, am, flip: mean(a.map(r => r.pnlFlip)) }; };
  if (print) console.log(`\n${label}: state <= ${thr}: joins ${S.length} on ${new Set(S.map(r => r.d)).size} dates (aligned ${A.length} on ${new Set(A.map(r => r.d)).size} dates, opposed ${Op.length}, flat ${S.filter(r => r.flat).length})`);
  const O = seg('OVERALL', S), pre = seg('PRE', S.filter(r => r.era === 'PRE')), post = seg('POST', S.filter(r => r.era === 'POST')), rth = seg('RTH', S.filter(r => r.session === 'RTH')), glx = seg('GLOBEX', S.filter(r => r.session === 'GLOBEX'));
  return { S, A, Op, O, pre, post, rth, glx }; }
const M = analyze('PRIMARY', -400);
const [alo, ahi] = boot(M.S, ao, 2000), srt = [...M.A].sort((x, y) => y.pnl - x.pnl), totA = sum(M.A.map(r => r.pnl)), top5 = totA > 0 ? sum(srt.slice(0, 5).map(r => r.pnl)) / totA : Infinity;   // guard (DeepSeek 2026-10-20)
// permutation: shuffle UP/DOWN/FLAT labels within session x era in the bad-state subset
const groups = new Map(); M.S.forEach((r, i) => { const k = r.session + r.era + (r.long ? 'L' : 'S'); (groups.get(k) || groups.set(k, []).get(k)).push(i); });
const obs = pa(M.S); let ge = 0; const NP = 2000, cls = M.S.map(r => r.cls);
for (let p = 0; p < NP; p++) { const sh = M.S.map(r => ({ ...r })); for (const idx of groups.values()) { const labs = idx.map(i => cls[i]); for (let i = labs.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [labs[i], labs[j]] = [labs[j], labs[i]]; } idx.forEach((i, k) => { sh[i].aligned = (sh[i].long && labs[k] === 'UP') || (!sh[i].long && labs[k] === 'DOWN'); }); } if (pa(sh) >= obs) ge++; }
const pperm = ge / NP;
console.log(`\naligned minus opposed: ${f(M.O.am - mean(M.Op.map(r => r.pnl)), 1)} CI [${f(alo, 1)},${f(ahi, 1)}] | permutation p ${pperm.toFixed(4)} | P(>=+100) aligned ${(100 * big(M.A)).toFixed(0)}% vs all ${(100 * big(M.S)).toFixed(0)}% | top-5 share of aligned total ${Number.isFinite(top5) ? (100 * top5).toFixed(0) + '%' : 'n/a (total<=0)'}`);
console.log(`bad-state totals: all joins ${f(sum(M.S.map(r => r.pnl)), 0)} dollars over ${M.S.length} joins; aligned-only ${f(sum(M.A.map(r => r.pnl)), 0)} over ${M.A.length}`);
console.log('\nSENSITIVITY ONLY:'); analyze('sens', -300); analyze('sens', -500);
// hindsight descriptive: trade dates whose FINAL total <= -400
const dayTot = new Map([...byDate].map(([d, a]) => [d, sum(a.map(r => r.pnl))])), bad = [...dayTot].filter(([, t]) => t <= -400).map(([d]) => d), BD = R.filter(r => bad.includes(r.d));
console.log(`\nHINDSIGHT (not tradeable): ${bad.length} trade dates ended <= -400: all joins total ${f(sum(BD.map(r => r.pnl)), 0)} over ${BD.length}; aligned-only ${f(sum(BD.filter(r => r.aligned).map(r => r.pnl)), 0)} over ${BD.filter(r => r.aligned).length}; opposed-only ${f(sum(BD.filter(r => r.opposed).map(r => r.pnl)), 0)} over ${BD.filter(r => r.opposed).length}; flat ${f(sum(BD.filter(r => r.flat).map(r => r.pnl)), 0)} over ${BD.filter(r => r.flat).length}`);
const P = (ok, t) => console.log((ok ? 'PASS ' : 'FAIL ') + t);
console.log('\n=== PRE-REGISTERED CRITERIA ===');
P(M.A.length >= 60 && new Set(M.A.map(r => r.d)).size >= 25, `1. aligned N ${M.A.length} on ${new Set(M.A.map(r => r.d)).size} dates`);
P(M.O.diff > 0 && M.O.lo > 0, `2. aligned minus all ${f(M.O.diff, 1)} CI [${f(M.O.lo, 1)},${f(M.O.hi, 1)}]`);
P(alo > 0, `3. aligned minus opposed CI [${f(alo, 1)},${f(ahi, 1)}]`);
P(pperm <= 0.05, `4. permutation p ${pperm.toFixed(4)}`);
P(M.O.am > M.O.flip && M.pre.am > M.pre.flip && M.post.am > M.post.flip, `5. beats flipped placebo overall/PRE/POST (${f(M.O.am, 1)} vs ${f(M.O.flip, 1)}; ${f(M.pre.am, 1)} vs ${f(M.pre.flip, 1)}; ${f(M.post.am, 1)} vs ${f(M.post.flip, 1)})`);
P(top5 < 0.5, `6. top-5 share of a POSITIVE aligned total (${Number.isFinite(top5) ? (100 * top5).toFixed(0) + '%' : 'total<=0 -> cannot pass'})`);
P(M.rth.diff >= 0 && M.glx.diff >= 0, `7. aligned minus all >= 0 in RTH (${f(M.rth.diff, 1)}) and GLOBEX (${f(M.glx.diff, 1)})`);
process.exit(0);
