// study_sweep_reclaim_20261020.mjs -- runs docs/SWEEP_RECLAIM_MINUTE_PREREG_20261020.md (committed 06b3e3d before any outcome).
// First penetration of a defended low (mirror: high) in RTH, reclaim within M minutes, forward adjusted return vs time-of-day drift, shifted-level placebo, hold-out.  Research only.
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex, mean, sum, f, lb, addDay } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
const argv = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01';
const M = +(argv.M || 15), DQ = +(argv.dq || 50), QUIET = argv.quiet === '1', KS = [30, 60, 120, 240];
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const log = (...a) => { if (!QUIET) console.log(...a); };
const D = await loadBars(FROM, TO), S = sessionIndex(D); const { H, L, C, TS } = D;
const mod = (i) => +TS[i].slice(11, 13) * 60 + +TS[i].slice(14, 16);
const dates = S.dates.filter(d => d >= FROM && d <= TO && !isInsideNqRollWeek(d));
// ---- session geometry and levels (all known before the event)
const sess = []; for (const d of dates) { const j = S.dates.indexOf(d); if (j < 1) continue; const pd = S.dates[j - 1]; if ((Date.parse(d) - Date.parse(pd)) / 864e5 > 4 || isInsideNqRollWeek(pd)) continue; const atr = S.atr20(d); if (!atr) continue;
  const [a, b] = S.rth.get(d), [pa, pb] = S.rth.get(pd), n0 = lb(TS, addDay(d, -1) + ' 18:00:00'), ib1 = lb(TS, d + ' 10:30:00');
  const mm = (x, y, fnL, fnH) => { let lo = Infinity, hi = -Infinity; for (let i = x; i < y; i++) { if (L[i] < lo) lo = L[i]; if (H[i] > hi) hi = H[i]; } return [lo, hi]; };
  if (a - n0 < 30) continue; const [onl, onh] = mm(n0, a), [pdl, pdh] = mm(pa, pb), [ibl, ibh] = mm(a, ib1);
  sess.push({ d, a, b, atr, ib1, lv: { ONL: [onl, onh, 575], PDL: [pdl, pdh, 575], IBL: [ibl, ibh, 630] } }); }
log(`sessions used ${sess.length}`);
// ---- time-of-day drift tables (long direction), ATR units
const drift = {}; for (const k of KS) { const s1 = new Float64Array(32), n1 = new Float64Array(32); for (const s of sess) for (let i = s.a; i + k < s.b; i++) { const bk = Math.floor((mod(i) - 570) / 30); s1[bk] += (C[i + k] - C[i]) / s.atr; n1[bk]++; } drift[k] = Array.from(s1, (v, q) => n1[q] ? v / n1[q] : 0); }
const bucket = (i) => Math.floor((mod(i) - 570) / 30);
// ---- event detection; sgn +1 = low sweep (long), -1 = high sweep (short, mirror)
function detect(s, level, sgn, startMin, Mm) { const lv = sgn * level, c = (i) => sgn * C[i], lo = (i) => sgn > 0 ? L[i] : -H[i];
  let i0 = -1; for (let i = Math.max(s.a + 5, s.a + startMin - 570); i < s.b; i++) { if (mod(i) > 810) break; if (c(i - 1) >= lv && lo(i) < lv) { i0 = i; break; } }
  if (i0 < 0) return null; let td = -1, mn = Infinity;
  for (let j = i0; j <= i0 + Mm && j < s.b; j++) { if (lo(j) < mn) mn = lo(j); if (c(j) >= lv) { td = j; break; } }
  const cls = td >= 0 ? 'RECLAIM' : 'NO_RECLAIM'; if (td < 0) { td = i0 + Mm; if (td >= s.b) return null; for (let j = i0; j <= td; j++) mn = Math.min(mn, lo(j)); }
  const ev = { d: s.d, sgn, cls, i0, td, depth: (lv - mn) / s.atr, atr: s.atr, tod: mod(td) };
  for (const k of KS) { if (td + k < s.b) { ev['R' + k] = sgn * (C[td + k] - C[td]) / s.atr; ev['A' + k] = ev['R' + k] - sgn * drift[k][bucket(td)]; } }
  return ev; }
const LV = ['ONL', 'PDL', 'IBL'];
function allEvents(Mm, shift = null) { const out = []; for (const s of sess) for (const nm of LV) for (const sgn of [1, -1]) { let level = s.lv[nm][sgn > 0 ? 0 : 1]; const start = s.lv[nm][2]; if (shift) level += (rnd() < 0.5 ? -1 : 1) * (0.25 + 0.75 * rnd()) * s.atr; const e = detect(s, level, sgn, start, Mm); if (e) { e.lvl = nm; out.push(e); } } return out; }
const evs = allEvents(M);
const thr = (() => { const x = evs.filter(e => e.d < SPLIT).map(e => e.depth).sort((a, b) => a - b); return x[Math.floor(x.length * DQ / 100)]; })();
const sel = (E, o = {}) => E.filter(e => (o.sgn == null || e.sgn === o.sgn) && (o.cls == null || e.cls === o.cls) && e.depth >= thr && (o.lvl == null || e.lvl === o.lvl) && (o.test == null || o.test(e)));
const mn = (E, k) => mean(E.filter(e => e['A' + k] != null).map(e => e['A' + k]));
function dci(E, k, n = 2000) { const by = new Map(); for (const e of E) if (e['A' + k] != null) (by.get(e.d) || by.set(e.d, []).get(e.d)).push(e['A' + k]); const ds = [...by.values()]; if (!ds.length) return [NaN, NaN]; const o = []; for (let b = 0; b < n; b++) { let s = 0, c = 0; for (let q = 0; q < ds.length; q++) { const g = ds[Math.floor(rnd() * ds.length)]; for (const x of g) { s += x; c++; } } o.push(s / c); } o.sort((a, b) => a - b); return [o[Math.floor(n * .025)], o[Math.floor(n * .975)]]; }
function dciDiff(A, B, k, n = 1500) { const g = (E) => { const by = new Map(); for (const e of E) if (e['A' + k] != null) (by.get(e.d) || by.set(e.d, []).get(e.d)).push(e['A' + k]); return by; }; const ga = g(A), gb = g(B), days = [...new Set([...ga.keys(), ...gb.keys()])]; const o = [];
  for (let b = 0; b < n; b++) { let sa = 0, ca = 0, sb = 0, cb = 0; for (let q = 0; q < days.length; q++) { const d = days[Math.floor(rnd() * days.length)]; for (const x of ga.get(d) || []) { sa += x; ca++; } for (const x of gb.get(d) || []) { sb += x; cb++; } } if (ca && cb) o.push(sa / ca - sb / cb); } o.sort((a, b) => a - b); return [o[Math.floor(o.length * .025)], o[Math.floor(o.length * .975)]]; }
log(`events (first penetrations, all classes) ${evs.length}; depth threshold p${DQ} of explore = ${thr.toFixed(3)} ATR20; M=${M}`);
log(`counts: low RECLAIM ${evs.filter(e => e.sgn > 0 && e.cls === 'RECLAIM').length} / NO_RECLAIM ${evs.filter(e => e.sgn > 0 && e.cls === 'NO_RECLAIM').length}; high RECLAIM ${evs.filter(e => e.sgn < 0 && e.cls === 'RECLAIM').length} / NO_RECLAIM ${evs.filter(e => e.sgn < 0 && e.cls === 'NO_RECLAIM').length}`);
// ---- H1
const P = sel(evs, { sgn: 1, cls: 'RECLAIM' }), Pm = sel(evs, { sgn: -1, cls: 'RECLAIM' });
const k0 = 120, real = mn(P, k0), [lo, hi] = dci(P, k0), ex = P.filter(e => e.d < SPLIT), ho = P.filter(e => e.d >= SPLIT);
const placebos = []; for (let r = 0; r < 200; r++) { const pe = sel(allEvents(M, true), { sgn: 1, cls: 'RECLAIM' }); placebos.push(mn(pe, k0)); } placebos.sort((a, b) => a - b); const p95 = placebos[Math.floor(placebos.length * .95)];
const bySess = new Map(); for (const e of P) if (e.A120 != null) bySess.set(e.d, (bySess.get(e.d) || 0) + e.A120); const sums = [...bySess.values()].sort((a, b) => b - a); const total = sum(sums), tot5 = total - sums.slice(0, 5).reduce((a, b) => a + b, 0);
const c1 = lo > 0, c2 = real > p95, c3 = mn(ex, k0) > 0 && mn(ho, k0) >= 0.5 * mn(ex, k0), c4 = tot5 > 0, c5 = mn(Pm, k0) > 0;
if (QUIET) { console.log(`SENS M=${M} dq=${DQ}: low-reclaim n ${P.length} mean adjR120 ${f(real, 3)} [${f(lo, 3)},${f(hi, 3)}] placebo95 ${f(p95, 3)} explore ${f(mn(ex, k0), 3)} holdout ${f(mn(ho, k0), 3)} mirror ${f(mn(Pm, k0), 3)} (n ${Pm.length}) => ${c1 && c2 && c3 && c4 && c5 ? 'SUPPORTED' : 'NOT'}`); process.exit(0); }
log(`\n=== H1: qualifying RECLAIM low sweeps (long), adjR(120) in ATR20 units ===`);
log(`n ${P.length} events over ${bySess.size} sessions; mean raw R120 ${f(mean(P.filter(e => e.R120 != null).map(e => e.R120)), 3)}, drift-adjusted ${f(real, 3)}  CI [${f(lo, 3)},${f(hi, 3)}]`);
log(`placebo (200 shifted-level draws) median ${f(placebos[100], 3)} 95th ${f(p95, 3)} 99th ${f(placebos[198], 3)}; real ${c2 ? 'EXCEEDS' : 'does not exceed'} the 95th`);
log(`explore n ${ex.length} mean ${f(mn(ex, k0), 3)} | hold-out n ${ho.length} mean ${f(mn(ho, k0), 3)} ; total ${f(total, 1)} ATR, without best 5 sessions ${f(tot5, 1)} ; mirror (high sweeps, short) n ${Pm.length} mean ${f(mn(Pm, k0), 3)}`);
log(`criteria: (i) CI lower>0 ${c1 ? 'PASS' : 'FAIL'} ; (ii) beats placebo 95th ${c2 ? 'PASS' : 'FAIL'} ; (iii) both halves positive, hold-out>=half explore ${c3 ? 'PASS' : 'FAIL'} ; (iv) positive without best 5 sessions ${c4 ? 'PASS' : 'FAIL'} ; (v) mirror positive ${c5 ? 'PASS' : 'FAIL'}  => ${c1 && c2 && c3 && c4 && c5 ? 'SUPPORTED' : 'NOT SUPPORTED'}`);
log('\n=== secondary ===');
for (const k of KS) log(`k=${k}: low-reclaim adjR ${f(mn(P, k), 3)} (n ${P.filter(e => e['A' + k] != null).length}) | mirror ${f(mn(Pm, k), 3)}`);
for (const sg of [1, -1]) { const R = sel(evs, { sgn: sg, cls: 'RECLAIM' }), N = sel(evs, { sgn: sg, cls: 'NO_RECLAIM' }); const [dl, dh] = dciDiff(R, N, 120); log(`${sg > 0 ? 'LOW ' : 'HIGH'} sweeps: RECLAIM n ${R.length} adjR120 ${f(mn(R, 120), 3)} vs NO_RECLAIM n ${N.length} ${f(mn(N, 120), 3)}  diff ${f(mn(R, 120) - mn(N, 120), 3)} [${f(dl, 3)},${f(dh, 3)}]`); }
for (const nm of LV) { const A = sel(evs, { sgn: 1, cls: 'RECLAIM', lvl: nm }); const [fl, fh] = dci(A, 120, 1000); log(`family ${nm}: low-reclaim n ${A.length} adjR120 ${f(mn(A, 120), 3)} [${f(fl, 3)},${f(fh, 3)}] ; mirror n ${sel(evs, { sgn: -1, cls: 'RECLAIM', lvl: nm }).length} ${f(mn(sel(evs, { sgn: -1, cls: 'RECLAIM', lvl: nm }), 120), 3)}`); }
const early = sel(evs, { sgn: 1, cls: 'RECLAIM', test: e => e.tod < 660 }), late = sel(evs, { sgn: 1, cls: 'RECLAIM', test: e => e.tod >= 660 }); log(`time of day: before 11:00 n ${early.length} ${f(mn(early, 120), 3)} | after n ${late.length} ${f(mn(late, 120), 3)}`);
// ---- descriptive link to real FAILED_SWEEP_REVERSAL_LONG fires
const fsr = (await query(`SELECT to_char(fired_at,'YYYY-MM-DD') d, to_char(fired_at,'HH24:MI') t, actual_pnl::float pnl FROM active_setups WHERE setup_type='FAILED_SWEEP_REVERSAL_LONG' AND actual_pnl IS NOT NULL AND origin_status IN ('ACTIVE','SHADOW') AND (is_cluster_primary IS NULL OR is_cluster_primary=true) AND is_rth AND trade_date >= '2026-08-11'`)).rows;
let hit = [], miss = []; for (const r of fsr) { const tm = +r.t.slice(0, 2) * 60 + +r.t.slice(3); const m = P.some(e => e.d === r.d && Math.abs(e.tod - tm) <= 20) || evs.some(e => e.sgn > 0 && e.cls === 'RECLAIM' && e.d === r.d && Math.abs(e.tod - tm) <= 20); (m ? hit : miss).push(r.pnl); }
log(`real FAILED_SWEEP_REVERSAL_LONG fires since 2026-08-11 (RTH): ${fsr.length}; coincide with a RECLAIM low-sweep event (same session, +-20min): ${hit.length} mean ${f(mean(hit))} ; do not coincide: ${miss.length} mean ${f(mean(miss))}  (descriptive only)`);
process.exit(0);
