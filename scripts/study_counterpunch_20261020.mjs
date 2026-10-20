// study_counterpunch_20261020.mjs -- runs docs/COUNTERPUNCH_PREREG_20261020.md (committed 7c533d5 before any outcome).
// Part A: rebound after the hindsight low by drop-size band. Part B: point-in-time bullish 4h reversal bar inside a p90 selloff episode vs the same bar outside episodes.  Research only.
import { loadBars, sessionIndex, mean, sum, f, lb, addDay } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
const argv = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01', WARM = 750;
const HB = +(argv.hb || 18), PCT = +(argv.pct || 90), QUIET = argv.quiet === '1';
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; const log = (...a) => { if (!QUIET) console.log(...a); };
const D = await loadBars(FROM, TO), S = sessionIndex(D);
const startHour = (h) => (h >= 22 || h < 2) ? 22 : h >= 18 ? 18 : h < 6 ? 2 : h < 10 ? 6 : h < 14 ? 10 : 14;
const B = []; { let cur = null; for (let i = 0; i < D.TS.length; i++) { const ts = D.TS[i]; if (ts < FROM + ' 00:00:00' || ts > TO + ' 23:59:59') continue; const h = +ts.slice(11, 13); if (h === 17) continue; const sh = startHour(h); let sd = ts.slice(0, 10); if (sh === 22 && h < 2) sd = addDay(sd, -1); const key = sd + ' ' + sh;
  if (!cur || cur.key !== key) { cur = { key, sd, H: -Infinity, L: Infinity, n: 0 }; B.push(cur); } cur.n++; if (D.H[i] > cur.H) cur.H = D.H[i]; if (D.L[i] < cur.L) cur.L = D.L[i]; cur.O ??= D.O[i]; cur.C = D.C[i]; cur.endTs = ts; } }
const X = B.filter(b => b.n >= 30); const N = X.length;
for (const b of X) { b.date = b.sd; b.atr = S.atr20(b.endTs.slice(0, 10)); b.roll = isInsideNqRollWeek(b.sd) || isInsideNqRollWeek(b.endTs.slice(0, 10)); }
// ---- DROP series and episode machine (parameterized by trigger percentile); returns per-bar state and episode records
const DROP = new Array(N).fill(null); for (let i = 11; i < N; i++) { const b = X[i]; if (b.roll || !b.atr) continue; let hh = -Infinity, ok = true; for (let k = i - 11; k <= i; k++) { if (X[k].roll) { ok = false; break; } if (X[k].H > hh) hh = X[k].H; } if (ok) DROP[i] = { v: (hh - b.C) / b.atr, hh }; }
function machine(P) { const PH = new Array(N).fill(false), EP = new Array(N).fill(-1), CC = new Array(N).fill(null), eps = []; const hist = []; let active = false, L = 0, tL = 0, cur = null;
  for (let i = 0; i < N; i++) { const b = X[i]; if (b.roll || !b.atr) { if (active && cur) { cur.end = i; } active = false; continue; }
    let thr = null, rank = null; if (DROP[i] && hist.length >= WARM) { const w = hist.slice(-1500).sort((a, c) => a - c); thr = w[Math.floor(w.length * P / 100)]; let lo = 0; while (lo < w.length && w[lo] <= DROP[i].v) lo++; rank = lo / w.length; } if (DROP[i]) hist.push(DROP[i].v);
    if (!active) { if (thr != null && DROP[i].v >= thr) { active = true; L = b.L; tL = i; cur = { id: eps.length, trig: i, rank, hh: DROP[i].hh, Lf: b.L, tLf: i, end: null }; eps.push(cur); } }
    else { if (b.L < L) { L = b.L; tL = i; cur.Lf = L; cur.tLf = i; } }
    if (active) { const c = i - tL; if (c > 41) { active = false; cur.end = i; } else { CC[i] = c; EP[i] = cur.id; PH[i] = true; } } }
  return { PH, EP, CC, eps }; }
const maxHigh = (a, b) => { let m = -Infinity; for (let k = a; k <= b; k++) { if (X[k].roll) return null; if (X[k].H > m) m = X[k].H; } return m; };
// ---- Part A
log('=== Part A: rebound from the hindsight episode low, by drop-size band (ATR20 units; fraction = rebound / preceding drop) ===');
const bands = { 'ordinary [p50,p70)': [], 'medium [p70,p90)': [], 'big >=p90': [] };
for (const P of [50, 70, 90]) { const { eps } = machine(P); for (const e of eps) { if (e.rank == null) continue; const key = e.rank >= 0.9 ? 'big >=p90' : e.rank >= 0.7 ? 'medium [p70,p90)' : 'ordinary [p50,p70)'; if ((P === 90 && key !== 'big >=p90') || (P === 70 && key !== 'medium [p70,p90)') || (P === 50 && key !== 'ordinary [p50,p70)')) continue;
    const atr = X[e.tLf].atr, drop = e.hh - e.Lf; if (drop <= 0) continue; const r = { drop: drop / atr, date: X[e.tLf].date };
    for (const h of [6, 18, 30]) { if (e.tLf + h >= N) { r['R' + h] = null; continue; } const m = maxHigh(e.tLf + 1, e.tLf + h); r['R' + h] = m == null ? null : (m - e.Lf) / atr; r['F' + h] = m == null ? null : (m - e.Lf) / drop; } bands[key].push(r); } }
const med = (a) => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
for (const [k, a] of Object.entries(bands)) { const g = (h, fn) => fn(a.map(r => r['R' + h]).filter(x => x != null)); const fr = a.map(r => r.F18).filter(x => x != null);
  log(`${k.padEnd(20)} N ${String(a.length).padStart(3)} median drop ${f(med(a.map(r => r.drop)), 2)} ATR | median rebound 1d ${f(med(a.map(r => r.R6)), 2)} 3d ${f(med(a.map(r => r.R18)), 2)} 5d ${f(med(a.map(r => r.R30)), 2)} ATR | median fraction of drop (3d) ${f(med(fr), 2)} | share rebound>=0.5 of drop in 3d ${(100 * fr.filter(x => x >= 0.5).length / fr.length).toFixed(0)}% | share rebound>=1 ATR in 3d ${(100 * a.map(r => r.R18).filter(x => x != null && x >= 1).length / a.filter(r => r.R18 != null).length).toFixed(0)}%`); }
// ---- Part B
const { PH, EP, CC, eps } = machine(PCT);
const isRev = (i) => i > 0 && !X[i].roll && !X[i - 1].roll && X[i].atr && X[i].L < X[i - 1].L && X[i].C > X[i - 1].H;
function outcome(i) { if (i + HB >= N) return null; let ok = true, hi = -Infinity, lo = Infinity, race = 'neither'; const e = X[i].C, a = X[i].atr;
  for (let k = i + 1; k <= i + HB; k++) { if (X[k].roll) { ok = false; break; } hi = Math.max(hi, X[k].H); lo = Math.min(lo, X[k].L); if (race === 'neither') { const up = X[k].H >= e + a, dn = X[k].L <= e - a; if (up && dn) race = 'both'; else if (up) race = 'win'; else if (dn) race = 'loss'; } }
  if (!ok) return null; return { R: (X[i + HB].C - e) / a, U: (hi - e) / a, D: (e - lo) / a, race, date: X[i].date }; }
const evI = [], seen = new Set(); for (let i = 0; i < N; i++) { if (PH[i] && CC[i] <= 17 && isRev(i)) { const o = outcome(i); if (!o) continue; o.ep = EP[i]; o.first = !seen.has(EP[i]); seen.add(EP[i]); o.i = i; evI.push(o); } }
const ctrlI = []; for (let i = 0; i < N; i++) if (!PH[i] && isRev(i)) { const o = outcome(i); if (o) { o.i = i; ctrlI.push(o); } }
const allI = []; for (let i = 0; i < N; i++) if (!X[i].roll && X[i].atr) { const o = outcome(i); if (o) allI.push(o); }
const first = evI.filter(o => o.first); const pf = (a, k) => mean(a.map(o => o[k]));
log(`\n=== Part B: bullish 4h reversal bar, entry at its close, ${HB} bars (3 days) forward, ATR20 units ===`);
log(`episodes ${eps.length}; episode reversal events: first-per-episode ${first.length} (episodes with one ${new Set(first.map(o => o.ep)).size}), all in episode c<=17: ${evI.length}; control reversal bars (no episode) ${ctrlI.length}; all bars ${allI.length}`);
const row = (n, a) => log(`${n.padEnd(34)} n ${String(a.length).padStart(5)} meanR ${f(pf(a, 'R'), 3)} meanU ${f(pf(a, 'U'), 2)} meanD ${f(pf(a, 'D'), 2)} race +1ATR first ${(100 * a.filter(o => o.race === 'win').length / a.length).toFixed(0)}% / -1ATR first ${(100 * a.filter(o => o.race === 'loss').length / a.length).toFixed(0)}% / both-in-bar ${(100 * a.filter(o => o.race === 'both').length / a.length).toFixed(0)}%`);
row('episode reversal (first per ep)', first); row('episode reversal (all c<=17)', evI); row('control reversal (no episode)', ctrlI); row('all bars', allI);
function ci(E, C0, n = 2000) { const by = new Map(); for (const o of E) (by.get(o.ep) || by.set(o.ep, []).get(o.ep)).push(o.R); const Ee = [...by.values()]; const bd = new Map(); for (const o of C0) (bd.get(o.date) || bd.set(o.date, []).get(o.date)).push(o.R); const Dd = [...bd.values()]; const out = [];
  for (let b = 0; b < n; b++) { let s1 = 0, c1 = 0, s2 = 0, c2 = 0; for (let k = 0; k < Ee.length; k++) for (const x of Ee[Math.floor(rnd() * Ee.length)]) { s1 += x; c1++; } for (let k = 0; k < Dd.length; k++) for (const x of Dd[Math.floor(rnd() * Dd.length)]) { s2 += x; c2++; } out.push(s1 / c1 - s2 / c2); } out.sort((a, b) => a - b); return [out[Math.floor(n * .025)], out[Math.floor(n * .975)]]; }
const real = pf(first, 'R') - pf(ctrlI, 'R'), [lo, hi] = ci(first, ctrlI);
const startIdx = new Map(eps.map(e => [e.id, e.trig])); const placebos = [];
for (let r = 0; r < 200; r++) { const vals = []; for (const e of eps) { const off = (20 + Math.floor(rnd() * 101)) * 6 * (rnd() < 0.5 ? -1 : 1); for (let k = e.trig + off; k <= e.trig + off + 17; k++) { if (k > 0 && k + HB < N && !PH[k] && isRev(k)) { const o = outcome(k); if (o) vals.push(o.R); break; } } } if (vals.length) placebos.push(mean(vals) - pf(ctrlI, 'R')); } placebos.sort((a, b) => a - b); const p95 = placebos[Math.floor(placebos.length * .95)];
const ex = first.filter(o => o.date < SPLIT), ho = first.filter(o => o.date >= SPLIT), cEx = ctrlI.filter(o => o.date < SPLIT), cHo = ctrlI.filter(o => o.date >= SPLIT);
const dEx = pf(ex, 'R') - pf(cEx, 'R'), dHo = pf(ho, 'R') - pf(cHo, 'R'); let worstD = Infinity; for (const e of new Set(first.map(o => o.ep))) { const d = pf(first.filter(o => o.ep !== e), 'R') - pf(ctrlI, 'R'); if (d < worstD) worstD = d; }
const c1 = lo > 0, c2 = real > p95, c3 = dEx > 0 && dHo >= 0.5 * dEx, c4 = worstD > 0;
if (QUIET) { console.log(`SENS hb=${HB} pct=${PCT}: first n ${first.length} dR ${f(real, 3)} [${f(lo, 3)},${f(hi, 3)}] placebo95 ${f(p95, 3)} explore ${f(dEx, 3)} holdout ${f(dHo, 3)} dropbest ${f(worstD, 3)} => ${c1 && c2 && c3 && c4 ? 'SUPPORTED' : 'NOT'} | race win ${(100 * first.filter(o => o.race === 'win').length / first.length).toFixed(0)}% loss ${(100 * first.filter(o => o.race === 'loss').length / first.length).toFixed(0)}% vs control win ${(100 * ctrlI.filter(o => o.race === 'win').length / ctrlI.length).toFixed(0)}% loss ${(100 * ctrlI.filter(o => o.race === 'loss').length / ctrlI.length).toFixed(0)}%`); process.exit(0); }
log(`\nPRIMARY dR (episode first reversal minus control reversal) ${f(real, 3)} ATR20  CI [${f(lo, 3)},${f(hi, 3)}]  placebo(200) median ${f(placebos[100], 3)} 95th ${f(p95, 3)}`);
log(`explore ${f(dEx, 3)} (n ${ex.length}) | hold-out ${f(dHo, 3)} (n ${ho.length}) | without best episode ${f(worstD, 3)}`);
log(`criteria: (i) CI lower>0 ${c1 ? 'PASS' : 'FAIL'} ; (ii) beats placebo 95th ${c2 ? 'PASS' : 'FAIL'} ; (iii) both halves positive, hold-out>=half explore ${c3 ? 'PASS' : 'FAIL'} ; (iv) positive without best episode ${c4 ? 'PASS' : 'FAIL'} => ${c1 && c2 && c3 && c4 ? 'SUPPORTED' : 'NOT SUPPORTED'}`);
// secondary (pre-registered as reported-only): race win rate (+1 ATR before -1 ATR) first-reversal-in-episode vs control reversal, episode-clustered bootstrap, halves
{ const wr = (a) => a.filter(o => o.race === 'win').length / a.length, lr = (a) => a.filter(o => o.race === 'loss').length / a.length; const byE = new Map(); for (const o of first) byE.set(o.ep, o); const E = [...byE.values()]; const out = [];
  for (let b = 0; b < 2000; b++) { const t = []; for (let k = 0; k < E.length; k++) t.push(E[Math.floor(rnd() * E.length)]); const c = []; const days = [...new Set(ctrlI.map(o => o.date))]; const bd = new Map(); for (const o of ctrlI) (bd.get(o.date) || bd.set(o.date, []).get(o.date)).push(o); for (let k = 0; k < days.length; k++) c.push(...bd.get(days[Math.floor(rnd() * days.length)])); out.push((wr(t) - lr(t)) - (wr(c) - lr(c))); } out.sort((a, b) => a - b);
  log(`
SECONDARY race (win% - loss%): episode first reversal ${f(100 * (wr(first) - lr(first)), 0)} pts vs control reversal ${f(100 * (wr(ctrlI) - lr(ctrlI)), 0)} pts ; diff ${f(100 * ((wr(first) - lr(first)) - (wr(ctrlI) - lr(ctrlI))), 0)} pts CI [${f(100 * out[Math.floor(out.length * .025)], 0)},${f(100 * out[Math.floor(out.length * .975)], 0)}] ; explore win ${(100 * wr(ex)).toFixed(0)}% loss ${(100 * lr(ex)).toFixed(0)}% (n ${ex.length}) | hold-out win ${(100 * wr(ho)).toFixed(0)}% loss ${(100 * lr(ho)).toFixed(0)}% (n ${ho.length}) | control explore win ${(100 * wr(cEx)).toFixed(0)}% loss ${(100 * lr(cEx)).toFixed(0)}% | control hold-out win ${(100 * wr(cHo)).toFixed(0)}% loss ${(100 * lr(cHo)).toFixed(0)}%`);
  const xs = [...first].sort((a, b) => a.i - b.i); log('first reversal events by date: ' + xs.map(o => X[o.i].date + (o.race === 'win' ? '+' : o.race === 'loss' ? '-' : '0')).join(' ')); }
// ---- Part C (addendum C of the prereg): size = fraction of each event's own drop, timing = whole CDF, no fixed horizon / ATR
const HC = 30;
function evC(i, q) { if (i + HC >= N || i < 11) return null; let hh = -Infinity; for (let k = i - 11; k <= i + HC; k++) { if (X[k].roll) return null; if (k <= i && X[k].H > hh) hh = X[k].H; } const E = X[i].C; if (E >= hh) return null; const tgt = E + q * (hh - E); let T = Infinity; for (let k = 1; k <= HC; k++) if (X[i + k].H >= tgt) { T = k; break; } return { T, date: X[i].date, ep: EP[i], i, dropATR: (hh - E) / X[i].atr }; }
const cdf = (a, h) => a.filter(o => o.T <= h).length / a.length; const maxD = (a, b) => { let m = -Infinity; for (let h = 1; h <= HC; h++) m = Math.max(m, cdf(a, h) - cdf(b, h)); return m; };
const medT = (a) => { const t = a.map(o => o.T).sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
const firstIdx = first.map(o => o.i), ctrlIdx = ctrlI.map(o => o.i);
log('\n=== Part C: scale-free counterpunch (target = fraction q of the way from entry back to the pre-drop high; time = first 4h bar reaching it within 30 bars = 5 days) ===');
const resC = {};
for (const q of [0.25, 0.5, 0.75, 1.0]) { const A = firstIdx.map(i => evC(i, q)).filter(Boolean), Cc = ctrlIdx.map(i => evC(i, q)).filter(Boolean); const real = maxD(A, Cc);
  const placebos = []; for (let r = 0; r < 200; r++) { const pl = []; for (const e of eps) { const off = (20 + Math.floor(rnd() * 101)) * 6 * (rnd() < 0.5 ? -1 : 1); for (let k = e.trig + off; k <= e.trig + off + 17; k++) { if (k > 11 && k + HC < N && !PH[k] && isRev(k)) { const o = evC(k, q); if (o) pl.push(o); break; } } } if (pl.length >= 10) placebos.push(maxD(pl, Cc)); } placebos.sort((a, b) => a - b); const p95 = placebos[Math.floor(placebos.length * .95)];
  const exA = A.filter(o => o.date < SPLIT), hoA = A.filter(o => o.date >= SPLIT), exC = Cc.filter(o => o.date < SPLIT), hoC = Cc.filter(o => o.date >= SPLIT);
  const posShare = (a, b) => { let c = 0; for (let h = 1; h <= HC; h++) if (cdf(a, h) - cdf(b, h) > 0) c++; return c / HC; };
  let worst = Infinity; for (const e of new Set(A.map(o => o.ep))) worst = Math.min(worst, maxD(A.filter(o => o.ep !== e), Cc));
  const curve = [1, 3, 6, 12, 18, 24, 30].map(h => `${h}:${(100 * (cdf(A, h) - cdf(Cc, h))).toFixed(0)}`).join(' ');
  resC[q] = { real, p95, ps1: posShare(exA, exC), ps2: posShare(hoA, hoC), worst };
  log(`q=${q}: n episode ${A.length} / control ${Cc.length} | reached within 30 bars: ${(100 * cdf(A, 30)).toFixed(0)}% vs ${(100 * cdf(Cc, 30)).toFixed(0)}% | median bars to reach ${medT(A)} vs ${medT(Cc)} | CDF gap (pts) at h ${curve} | maxD ${f(real, 3)} placebo95 ${f(p95, 3)} ${real > p95 ? 'EXCEEDS' : 'no'} | D>0 share explore ${(100 * resC[q].ps1).toFixed(0)}% hold-out ${(100 * resC[q].ps2).toFixed(0)}% | worst-case dropping one episode ${f(worst, 3)}`); }
{ const r = resC[0.5]; const ci1 = r.real > r.p95, ci2 = r.ps1 >= 0.7 && r.ps2 >= 0.7, ci3 = r.worst > 0, ci4 = [0.25, 0.75, 1.0].every(q => resC[q].real > 0);
  log(`Part C criteria: (i) maxD beats placebo 95th ${ci1 ? 'PASS' : 'FAIL'} ; (ii) D(h)>0 for >=70% of h in both halves ${ci2 ? 'PASS' : 'FAIL'} ; (iii) positive after dropping the best episode ${ci3 ? 'PASS' : 'FAIL'} ; (iv) q 0.25/0.75/1.0 all positive ${ci4 ? 'PASS' : 'FAIL'} => ${ci1 && ci2 && ci3 && ci4 ? 'SUPPORTED' : 'NOT SUPPORTED'}`); }
// ---- Part C2 (EXPLORATORY post-hoc correction, not a verdict): control reversal bars matched on drop size (ATR) to the episode events' own range, because the pre-registered Part C control had much smaller drops
{ const A5 = firstIdx.map(i => evC(i, 0.5)).filter(Boolean), C5 = ctrlIdx.map(i => evC(i, 0.5)).filter(Boolean); const ds = A5.map(o => o.dropATR).sort((a, b) => a - b); const lo = ds[Math.floor(ds.length * 0.1)], hi = ds[Math.floor(ds.length * 0.9)];
  const med = (a) => { const t = [...a].sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
  log(`\n=== Part C2 (exploratory): drop sizes (ATR20) episode median ${med(ds).toFixed(2)} [p10 ${lo.toFixed(2)}, p90 ${hi.toFixed(2)}] vs all control reversal bars median ${med(C5.map(o => o.dropATR)).toFixed(2)} ===`);
  const Cm = C5.filter(o => o.dropATR >= lo && o.dropATR <= hi); log(`size-matched controls: ${Cm.length} of ${C5.length}; non-episode bars (PH false) with a drop that large are mostly the tail right after episodes expire`);
  if (Cm.length >= 15) for (const q of [0.25, 0.5, 0.75, 1.0]) { const A = firstIdx.map(i => evC(i, q)).filter(Boolean).filter(o => o.dropATR >= lo && o.dropATR <= hi), Cc = ctrlIdx.map(i => evC(i, q)).filter(Boolean).filter(o => o.dropATR >= lo && o.dropATR <= hi); log(`q=${q}: episode n ${A.length} reached ${(100 * cdf(A, 30)).toFixed(0)}% median bars ${medT(A)} | matched control n ${Cc.length} reached ${(100 * cdf(Cc, 30)).toFixed(0)}% median bars ${medT(Cc)} | maxD ${f(maxD(A, Cc), 3)}`); } }
const sessOf = (i) => { const h = +X[i].key.slice(11); return h >= 10 && h < 17 ? 'RTHish(10,14)' : 'other'; }; void sessOf;
process.exit(0);
