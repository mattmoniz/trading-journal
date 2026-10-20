// study_poc_join_circuit_breaker_20261020.mjs -- runs docs/POC_JOIN_CIRCUIT_BREAKER_PREREG_20261020.md (committed 8f6746c before any outcome).
// Trigger T1: two consecutive CLOSED joins of the same trade date (by exit time) both lost; T2: both lost AND both VWAP-opposed. Breaker window = (exit time of the 2nd loss, +D minutes], D in {2,5,15,30}; joins entering inside are SKIPPED.
// Causal: a join that E1 closes at the next join's entry bar is not "closed" before that entry (strict >), so it can never be skipped by the loss it caused. States come from the UNGATED stream (stated limitation).
import { loadBars, sessionIndex, buildEvents, fwd, simE1, mean, sum, f, lb, addDay, rnd } from './lib/pocJoinLoader.mjs';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01', DURS = [2, 5, 15, 30], K = 60;
const D = await loadBars(FROM, TO), S = sessionIndex(D), events = await buildEvents(D, FROM, TO, { R: 65, rMode: 'fixed' });
const vcache = new Map(); const vwapOf = (d) => { if (vcache.has(d)) return vcache.get(d); const a = lb(D.TS, addDay(d, -1) + ' 18:00:00'), b = lb(D.TS, d + ' 17:00:00'); const bars = []; for (let i = a; i < b; i++) bars.push({ high: D.H[i], low: D.L[i], close: D.C[i], volume: D.V[i] }); const o = { a, vw: bars.length ? computeRunningVwapSeries(bars) : [] }; vcache.set(d, o); return o; };
const smp = new Map(), cutc = new Map(); const samples = (d) => { if (smp.has(d)) return smp.get(d); const { vw } = vwapOf(d), s = []; for (let t = K; t < vw.length; t += 15) s.push(Math.abs(vw[t] - vw[t - K])); smp.set(d, s); return s; };
const flatCut = (d) => { if (cutc.has(d)) return cutc.get(d); const j = lb(S.dates, d), prior = S.dates.slice(Math.max(0, j - 20), j); let out = null; if (prior.length === 20) { const v = prior.flatMap(samples).sort((x, y) => x - y); out = v.length ? v[Math.floor((v.length - 1) / 3)] : null; } cutc.set(d, out); return out; };
const J = []; for (let i = 0; i < events.length; i++) { const w = fwd(D, events, i); if (!w) continue; const e = events[i], sim = simE1(D, e, w[0], w[1]);
  const { vw } = vwapOf(e.d), t = e.trig - e.a, c = flatCut(e.d); let opposed = false; if (t >= K && c && vw[t] != null && vw[t - K] != null) { const sl = vw[t] - vw[t - K]; opposed = (e.long && sl < -c) || (!e.long && sl > c); }
  const m = +D.TS[e.ei].slice(11, 13) * 60 + +D.TS[e.ei].slice(14, 16);
  J.push({ d: e.d, ep: e.ep, ei: e.ei, exitT: D.T[sim.k], pnl: sim.pnl, opposed, era: e.d < SPLIT ? 'PRE' : 'POST', session: m >= 570 && m < 960 ? 'RTH' : 'GLOBEX' }); }
console.log(`joins ${J.length}; mean ${f(mean(J.map(j => j.pnl)), 2)}; total ${f(sum(J.map(j => j.pnl)), 0)}`);
function triggers(kind) { const out = []; const byD = new Map(); for (const j of J) (byD.get(j.d) || byD.set(j.d, []).get(j.d)).push(j);
  for (const [d, a] of byD) { const c = [...a].sort((x, y) => x.exitT - y.exitT); for (let i = 1; i < c.length; i++) { const p = c[i - 1], q = c[i]; if (p.pnl < 0 && q.pnl < 0 && (kind === 'T1' || (p.opposed && q.opposed))) out.push({ d, t: q.exitT }); } } return out; }
function skippedSet(trigs, dur, jlist) { const sk = new Set(); for (const tr of trigs) for (let i = 0; i < jlist.length; i++) { const j = jlist[i]; if (j.ep > tr.t && j.ep <= tr.t + dur) sk.add(i); } return sk; }
const jl = [...J].sort((x, y) => x.ep - y.ep);
function boot(stat, n = 1500) { const by = new Map(); jl.forEach((j, i) => (by.get(j.d) || by.set(j.d, []).get(j.d)).push(i)); const ds = [...by.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(...ds[(rnd() * ds.length) | 0]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const P = (ok, t) => console.log((ok ? 'PASS ' : 'FAIL ') + t);
const bigW = (a) => a.filter(j => j.pnl >= 100).length, bigL = (a) => a.filter(j => j.pnl <= -150).length;
for (const kind of ['T1', 'T2']) { const trigs = triggers(kind); console.log(`\n===== ${kind}: ${trigs.length} triggers =====`);
  for (const dur of DURS) { const sk = skippedSet(trigs, dur, jl), Sj = jl.filter((_, i) => sk.has(i)), Kj = jl.filter((_, i) => !sk.has(i)); if (Sj.length < 5) { console.log(`D=${dur}: only ${Sj.length} skipped`); continue; }
    const diff = (pick) => { const s = pick.filter(i => sk.has(i)), k = pick.filter(i => !sk.has(i)); return mean(s.map(i => jl[i].pnl)) - mean(k.map(i => jl[i].pnl)); }; const [lo, hi] = boot(diff);
    // placebo: slide each trigger to a random time within the same trade date's join span
    const spans = new Map(); for (const j of jl) { const s = spans.get(j.d) || { lo: j.ep, hi: j.ep }; s.lo = Math.min(s.lo, j.ep); s.hi = Math.max(s.hi, j.ep); spans.set(j.d, s); } const obsTot = sum(Sj.map(j => j.pnl)); let le = 0; const NP = 1000;
    for (let p = 0; p < NP; p++) { const tr2 = trigs.map(tr => { const sp = spans.get(tr.d); return { d: tr.d, t: sp ? sp.lo + rnd() * (sp.hi - sp.lo) : tr.t }; }); const sk2 = skippedSet(tr2, dur, jl); let tot = 0; for (const i of sk2) tot += jl[i].pnl; if (tot <= obsTot) le++; }
    const pp = le / NP; const sorted = [...Sj].sort((x, y) => x.pnl - y.pnl), top5neg = sum(sorted.slice(0, 5).map(j => j.pnl)) / sum(Sj.map(j => j.pnl));
    const bySub = (fn) => { const s = Sj.filter(fn), k = Kj.filter(fn); return s.length >= 10 ? f(mean(s.map(j => j.pnl)) - mean(k.map(j => j.pnl)), 1) + `(n${s.length})` : 'thin'; };
    console.log(`D=${String(dur).padStart(2)}min skipped ${String(Sj.length).padStart(4)} | mean(S) ${f(mean(Sj.map(j => j.pnl)), 1).padStart(7)} vs kept ${f(mean(Kj.map(j => j.pnl)), 1)} all ${f(mean(jl.map(j => j.pnl)), 1)} | S-minus-kept ${f(mean(Sj.map(j => j.pnl)) - mean(Kj.map(j => j.pnl)), 1)} [${f(lo, 1)},${f(hi, 1)}] | total(S) ${f(obsTot, 0)} (breaker effect ${f(-obsTot, 0)}) | placebo p ${pp.toFixed(3)} | big winners skipped ${bigW(Sj)} vs big losers avoided ${bigL(Sj)} | PRE ${bySub(j => j.era === 'PRE')} POST ${bySub(j => j.era === 'POST')} RTH ${bySub(j => j.session === 'RTH')} GLOBEX ${bySub(j => j.session === 'GLOBEX')}`);
    const helps = Sj.length >= 60 && mean(Sj.map(j => j.pnl)) < mean(Kj.map(j => j.pnl)) && hi < 0 && obsTot < 0 && pp <= 0.05;
    P(helps, `${kind} D=${dur}: criteria 1-3 (N>=60, S worse than kept with CI below zero, total(S)<0, placebo p<=0.05)${obsTot < 0 ? '; top-5 losses share ' + (100 * top5neg).toFixed(0) + '%' : ''}`); } }
process.exit(0);
