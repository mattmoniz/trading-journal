// study_sweep_scalefree_20261020.mjs -- runs docs/SWEEP_RECLAIM_SCALEFREE_PREREG_20261020.md (committed 096798b before any outcome).
// First penetration of a level, reclaim at ANY later time in the session, depth = percentile rank vs the level family's own prior depths, outcome = symmetric race scaled by the sweep's own depth.  Research only.
import { query } from '../server/db.js';
import { loadBars, sessionIndex, mean, sum, f, lb, addDay } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01', TOPQ = 0.8, MINPRIOR = 60;
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const D = await loadBars(FROM, TO), S = sessionIndex(D); const { H, L, C, TS } = D;
const mod = (i) => +TS[i].slice(11, 13) * 60 + +TS[i].slice(14, 16);
const dates = S.dates.filter(d => d >= FROM && d <= TO && !isInsideNqRollWeek(d));
const sess = []; for (const d of dates) { const j = S.dates.indexOf(d); if (j < 1) continue; const pd = S.dates[j - 1]; if ((Date.parse(d) - Date.parse(pd)) / 864e5 > 4 || isInsideNqRollWeek(pd)) continue; const atr = S.atr20(d); if (!atr) continue;
  const [a, b] = S.rth.get(d), [pa, pb] = S.rth.get(pd), n0 = lb(TS, addDay(d, -1) + ' 18:00:00'), ib1 = lb(TS, d + ' 10:30:00'); if (a - n0 < 30) continue;
  const mm = (x, y) => { let lo = Infinity, hi = -Infinity; for (let i = x; i < y; i++) { if (L[i] < lo) lo = L[i]; if (H[i] > hi) hi = H[i]; } return [lo, hi]; };
  const [onl, onh] = mm(n0, a), [pdl, pdh] = mm(pa, pb), [ibl, ibh] = mm(a, ib1);
  sess.push({ d, a, b, n0, atr, arms: { RTH: { from: a, to: b, lastStart: 810, levels: { ONL: [onl, onh, 575], PDL: [pdl, pdh, 575], IBL: [ibl, ibh, 630] } }, GLX: { from: n0, to: a, lastStart: null, levels: { PDL: [pdl, pdh, 0], } } } }); }
console.log(`sessions ${sess.length}`);
// ---- detection over [from,to): first penetration, reclaim at any later bar; depth at resolution (reclaim or end of window)
function detect(s, arm, level, sgn, startOff, Qs) { const A = s.arms[arm]; const lv = sgn * level, c = (i) => sgn * C[i], lo = (i) => sgn > 0 ? L[i] : -H[i];
  let first = A.from + (arm === 'RTH' ? Math.max(5, startOff - 570) : 30); let i0 = -1;
  for (let i = Math.max(first, A.from + 1); i < A.to; i++) { if (arm === 'RTH' && mod(i) > A.lastStart) break; if (c(i - 1) >= lv && lo(i) < lv) { i0 = i; break; } } if (i0 < 0) return null;
  let tr = -1, mn = Infinity; for (let j = i0; j < A.to; j++) { if (lo(j) < mn) mn = lo(j); if (c(j) >= lv) { tr = j; break; } }
  const depth = (lv - mn) / s.atr, dpts = lv - mn; const ev = { d: s.d, arm, sgn, i0, tr, depth, dpts, reclaim: tr >= 0, ttr: tr >= 0 ? tr - i0 : null, end: A.to };
  if (tr >= 0) { const E = C[tr]; for (const q of Qs) { let r = 'n'; for (let j = tr + 1; j < A.to; j++) { const upHit = sgn > 0 ? H[j] >= E + q * dpts : L[j] <= E - q * dpts, dnHit = sgn > 0 ? L[j] <= E - q * dpts : H[j] >= E + q * dpts; if (upHit && dnHit) { r = 'b'; break; } if (upHit) { r = 'w'; break; } if (dnHit) { r = 'l'; break; } } ev['r' + q] = r; } }
  return ev; }
const QS = [1, 2, 3], FAM = (arm, lvl, sgn) => `${arm}|${lvl}|${sgn}`;
// ---- real pass in date order: prior-depth distributions per family, rank at event time, p80 snapshot after each event
const fam = new Map(); const events = [];
for (const s of sess) for (const arm of ['RTH', 'GLX']) for (const lvl of Object.keys(s.arms[arm].levels)) for (const sgn of [1, -1]) { const k = FAM(arm, lvl, sgn); const F = fam.get(k) || fam.set(k, { depths: [], dates: [], p80: [] }).get(k);
  const e = detect(s, arm, s.arms[arm].levels[lvl][sgn > 0 ? 0 : 1], sgn, s.arms[arm].levels[lvl][2], QS); if (!e) continue; e.lvl = lvl;
  const n = F.depths.length; if (n >= MINPRIOR) { let c = 0; for (const x of F.depths) if (x <= e.depth) c++; e.rank = c / n; const sorted = [...F.depths].sort((a, b) => a - b); e.top = e.depth >= sorted[Math.floor(n * TOPQ)]; } else { e.rank = null; e.top = false; }
  F.depths.push(e.depth); F.dates.push(s.d); const sorted2 = [...F.depths].sort((a, b) => a - b); F.p80.push(sorted2[Math.floor(sorted2.length * TOPQ)]); events.push(e); }
const ev = (arm) => events.filter(e => e.arm === arm && e.rank != null);
console.log(`events total ${events.length}; with a rank (>=${MINPRIOR} prior in the family) RTH ${ev('RTH').length}, Globex ${ev('GLX').length}`);
const score = (e, q) => e['r' + q] === 'w' ? 1 : e['r' + q] === 'l' ? -1 : 0;
const Sstat = (E, q) => E.length ? sum(E.map(e => score(e, q))) / E.length : NaN;
const pct = (a, b) => b ? (100 * a / b).toFixed(0) + '%' : 'n/a'; const quart = (a) => { const t = a.filter(x => x != null).sort((x, y) => x - y); return t.length ? [t[Math.floor(t.length * .25)], t[Math.floor(t.length * .5)], t[Math.floor(t.length * .75)]] : []; };
function dci(E, q, n = 2000) { const by = new Map(); for (const e of E) (by.get(e.d) || by.set(e.d, []).get(e.d)).push(score(e, q)); const ds = [...by.values()]; if (!ds.length) return [NaN, NaN]; const o = []; for (let b = 0; b < n; b++) { let s = 0, c = 0; for (let k = 0; k < ds.length; k++) { const g = ds[Math.floor(rnd() * ds.length)]; for (const x of g) { s += x; c++; } } o.push(s / c); } o.sort((a, b) => a - b); return [o[Math.floor(n * .025)], o[Math.floor(n * .975)]]; }
// ---- descriptive by rank band (reclaim share and timing are outcomes of the sweep, reported for every band)
for (const arm of ['RTH', 'GLX']) { console.log(`\n=== ${arm}: all first penetrations with a rank, by depth-rank band and side (low sweeps = sgn +1, high sweeps = sgn -1) ===`);
  for (const sgn of [1, -1]) for (const [lo, hi, nm] of [[0, .5, '[0,.5)'], [.5, .8, '[.5,.8)'], [.8, 1.01, '[.8,1]']]) { const A = ev(arm).filter(e => e.sgn === sgn && e.rank >= lo && e.rank < hi), R = A.filter(e => e.reclaim); const q = quart(R.map(e => e.ttr));
    console.log(`${sgn > 0 ? 'LOW ' : 'HIGH'} ${nm.padEnd(8)} n ${String(A.length).padStart(4)} reclaim ${pct(R.length, A.length).padStart(4)} | time to reclaim (min) quartiles ${q.join('/')} | race score S at q=1 ${f(Sstat(R, 1), 2)} q=2 ${f(Sstat(R, 2), 2)} q=3 ${f(Sstat(R, 3), 2)} (n reclaim ${R.length}; resolved q=2 ${pct(R.filter(e => e.r2 === 'w' || e.r2 === 'l').length, R.length)})`); } }
// ---- Spearman of rank vs race score (no cut at all), RTH lows
function spearman(x, y) { const rk = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; }; const a = rk(x), b = rk(y), ma = mean(a), mb = mean(b); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < a.length; i++) { sxy += (a[i] - ma) * (b[i] - mb); sxx += (a[i] - ma) ** 2; syy += (b[i] - mb) ** 2; } return sxy / Math.sqrt(sxx * syy); }
for (const sgn of [1, -1]) { const R = ev('RTH').filter(e => e.sgn === sgn && e.reclaim); const rho = spearman(R.map(e => e.rank), R.map(e => score(e, 2))); const by = new Map(); R.forEach((e, i) => (by.get(e.d) || by.set(e.d, []).get(e.d)).push(i)); const ds = [...by.values()], o = [];
  for (let b = 0; b < 1000; b++) { const idx = []; for (let k = 0; k < ds.length; k++) idx.push(...ds[Math.floor(rnd() * ds.length)]); o.push(spearman(idx.map(i => R[i].rank), idx.map(i => score(R[i], 2)))); } o.sort((a, b) => a - b); console.log(`Spearman(depth rank, race score q=2) RTH ${sgn > 0 ? 'lows' : 'highs'} n ${R.length}: ${f(rho, 3)} [${f(o[25], 3)},${f(o[975], 3)}]`); }
// ---- H1
const P = ev('RTH').filter(e => e.sgn === 1 && e.reclaim && e.top), Pm = ev('RTH').filter(e => e.sgn === -1 && e.reclaim && e.top);
const real = Sstat(P, 2), [lo, hi] = dci(P, 2); const ex = P.filter(e => e.d < SPLIT), ho = P.filter(e => e.d >= SPLIT);
const bySess = new Map(); for (const e of P) bySess.set(e.d, (bySess.get(e.d) || 0) + score(e, 2)); const sums = [...bySess.values()].sort((a, b) => b - a), tot5 = sum(sums) - sums.slice(0, 5).reduce((a, b) => a + b, 0);
const placebos = []; for (let r = 0; r < 200; r++) { const pe = []; for (const s of sess) for (const lvl of Object.keys(s.arms.RTH.levels)) { const F = fam.get(FAM('RTH', lvl, 1)); const m = F.dates.filter(x => x < s.d).length; if (m < MINPRIOR) continue; const sh = (rnd() < 0.5 ? -1 : 1) * (0.25 + 0.75 * rnd()) * s.atr; const e = detect(s, 'RTH', s.arms.RTH.levels[lvl][0] + sh, 1, s.arms.RTH.levels[lvl][2], [2]); if (e && e.reclaim && e.depth >= F.p80[m - 1]) pe.push(e); } placebos.push(Sstat(pe, 2)); } placebos.sort((a, b) => a - b); const p95 = placebos[Math.floor(placebos.length * .95)];
const c1 = lo > 0, c2 = real > p95, c3 = Sstat(ex, 2) > 0 && Sstat(ho, 2) >= 0.5 * Sstat(ex, 2), c4 = tot5 > 0, c5 = Sstat(Pm, 2) > 0, c6 = Sstat(P, 1) > 0 && Sstat(P, 3) > 0;
console.log(`\n=== H1: RTH low-level sweeps in the top depth band (rank>=.8) that reclaim; symmetric race scaled by own depth ===`);
console.log(`n ${P.length} over ${bySess.size} sessions; S(q=2) ${f(real, 3)} CI [${f(lo, 3)},${f(hi, 3)}]; wins ${pct(P.filter(e => e.r2 === 'w').length, P.length)} losses ${pct(P.filter(e => e.r2 === 'l').length, P.length)} neither ${pct(P.filter(e => e.r2 === 'n' || e.r2 === 'b').length, P.length)}`);
console.log(`placebo (200 shifted-level draws) median ${f(placebos[100], 3)} 95th ${f(p95, 3)}; explore ${f(Sstat(ex, 2), 3)} (n ${ex.length}) hold-out ${f(Sstat(ho, 2), 3)} (n ${ho.length}); without best 5 sessions total score ${tot5}; mirror highs S ${f(Sstat(Pm, 2), 3)} (n ${Pm.length}); q=1 ${f(Sstat(P, 1), 3)} q=3 ${f(Sstat(P, 3), 3)}`);
console.log(`criteria: (i) CI lower>0 ${c1 ? 'PASS' : 'FAIL'} ; (ii) beats placebo 95th ${c2 ? 'PASS' : 'FAIL'} ; (iii) both halves positive, hold-out>=half explore ${c3 ? 'PASS' : 'FAIL'} ; (iv) positive without best 5 sessions ${c4 ? 'PASS' : 'FAIL'} ; (v) mirror positive ${c5 ? 'PASS' : 'FAIL'} ; (vi) q=1 and q=3 positive ${c6 ? 'PASS' : 'FAIL'} => ${c1 && c2 && c3 && c4 && c5 && c6 ? 'SUPPORTED' : 'NOT SUPPORTED'}`);
{ const Pg = ev('GLX').filter(e => e.sgn === 1 && e.reclaim && e.top), Pgm = ev('GLX').filter(e => e.sgn === -1 && e.reclaim && e.top); const [gl, gh] = dci(Pg, 2, 2000); const gp = []; const F0 = (lvl, sg) => fam.get(FAM('GLX', lvl, sg));
  for (let r = 0; r < 200; r++) { const pe = []; for (const s of sess) { const F = F0('PDL', 1); const m = F.dates.filter(x => x < s.d).length; if (m < MINPRIOR) continue; const sh = (rnd() < 0.5 ? -1 : 1) * (0.25 + 0.75 * rnd()) * s.atr; const e = detect(s, 'GLX', s.arms.GLX.levels.PDL[0] + sh, 1, 0, [2]); if (e && e.reclaim && e.depth >= F.p80[m - 1]) pe.push(e); } gp.push(Sstat(pe, 2)); } gp.sort((a, b) => a - b);
  const gex = Pg.filter(e => e.d < SPLIT), gho = Pg.filter(e => e.d >= SPLIT);
  console.log(`\nGlobex arm (EXPLORATORY, prior-day RTH low only, top band, reclaim): n ${Pg.length} S(q=2) ${f(Sstat(Pg, 2), 3)} CI [${f(gl, 3)},${f(gh, 3)}] wins ${pct(Pg.filter(e => e.r2 === 'w').length, Pg.length)} losses ${pct(Pg.filter(e => e.r2 === 'l').length, Pg.length)} | placebo median ${f(gp[100], 3)} 95th ${f(gp[190], 3)} 99th ${f(gp[197], 3)} | explore ${f(Sstat(gex, 2), 3)} (n ${gex.length}) hold-out ${f(Sstat(gho, 2), 3)} (n ${gho.length}) | q=1 ${f(Sstat(Pg, 1), 3)} q=3 ${f(Sstat(Pg, 3), 3)} | mirror prior-day high n ${Pgm.length} S ${f(Sstat(Pgm, 2), 3)}`);
  console.log('Globex events: ' + Pg.map(e => `${e.d}${e.r2 === 'w' ? '+' : e.r2 === 'l' ? '-' : '0'}`).join(' ')); }
// ---- descriptive link to real FAILED_SWEEP_REVERSAL_LONG fires
const fsr = (await query(`SELECT to_char(fired_at,'YYYY-MM-DD') d, to_char(fired_at,'HH24:MI') t, actual_pnl::float pnl FROM active_setups WHERE setup_type='FAILED_SWEEP_REVERSAL_LONG' AND actual_pnl IS NOT NULL AND origin_status IN ('ACTIVE','SHADOW') AND (is_cluster_primary IS NULL OR is_cluster_primary=true) AND is_rth AND trade_date >= '2026-08-11'`)).rows;
const hit = [], miss = []; for (const r of fsr) { const tm = +r.t.slice(0, 2) * 60 + +r.t.slice(3); const m = P.some(e => e.d === r.d && Math.abs(mod(e.tr) - tm) <= 20); (m ? hit : miss).push(r.pnl); }
console.log(`real FAILED_SWEEP_REVERSAL_LONG fires since 2026-08-11: ${fsr.length}; coincide with a top-band reclaim event (+-20 min) ${hit.length} mean ${f(mean(hit))}; others ${miss.length} mean ${f(mean(miss))} (descriptive only)`);
process.exit(0);
