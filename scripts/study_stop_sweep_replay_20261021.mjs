// Runs docs/STOP_SWEEP_REPLAY_PREREG_20261021.md (committed 0be4245 before any outcome was computed). Research only; nothing live reads it.
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex, lb } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI, mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
const FROM = '2023-03-06', TO = '2026-10-20', SPLIT = '2025-06-01', POKE = 3, LOOK = 10, MIN_BARS = 30, CONF = 30, EXT_MIN = 3, EXT_MAX = 50, BOUNCE = 15, BUF = 5, TGT_LIVE = 30;
const SWEEP = [['ONL', 'LOW'], ['ONH', 'HIGH'], ['PD_LOW', 'LOW'], ['PD_HIGH', 'HIGH'], ['IB_LOW', 'LOW'], ['IB_HIGH', 'HIGH']];
const CONFN = ['PD_VAH', 'PD_VAL', 'PD_POC', 'FLOOR_S1', 'FLOOR_R1', 'FLOOR_PIVOT', 'PW_LOW', 'PW_HIGH', 'PW_VAH', 'PW_VAL'];
const NAMES = [...new Set([...SWEEP.map((x) => x[0]), ...CONFN])];
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const D = await loadBars(FROM, TO), S = sessionIndex(D); const idxOf = new Map(); for (let i = 0; i < D.TS.length; i++) idxOf.set(D.TS[i], i);
const lvl = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE level_name = ANY($1) AND trade_date >= $2 AND trade_date <= $3`, [NAMES, FROM, TO])).rows) { if (!lvl.has(r.d)) lvl.set(r.d, {}); lvl.get(r.d)[r.n] = r.p; }
// Addendum: sweep levels rebuilt from bars exactly as the live code defines them (calendar-day pre-09:30 bars, prior RTH range, 09:30-10:29 IB)
for (const d of S.dates) { if (!lvl.has(d)) continue; const [a] = S.rth.get(d), o = lb(D.TS, d + ' 00:00:00'); let onl = Infinity, onh = -Infinity; for (let k = o; k < a; k++) { if (D.L[k] < onl) onl = D.L[k]; if (D.H[k] > onh) onh = D.H[k]; } const L0 = lvl.get(d); if (onl < Infinity) { L0.ONL = onl; L0.ONH = onh; } else { delete L0.ONL; delete L0.ONH; }
  const j = S.dates.indexOf(d); if (j > 0) { const [pa, pb] = S.rth.get(S.dates[j - 1]); let lo = Infinity, hi = -Infinity; for (let k = pa; k < pb; k++) { if (D.L[k] < lo) lo = D.L[k]; if (D.H[k] > hi) hi = D.H[k]; } L0.PD_LOW = lo; L0.PD_HIGH = hi; }
  let il = Infinity, ih = -Infinity; for (let k = a; k < a + 60; k++) { if (D.L[k] < il) il = D.L[k]; if (D.H[k] > ih) ih = D.H[k]; } L0.IB_LOW = il; L0.IB_HIGH = ih; }
const bad = (d) => (d >= '2025-09-28' && d <= '2025-11-19') || isInsideNqRollWeek(d);
const sessions = S.dates.filter((d) => d >= FROM && d <= TO && !bad(d) && lvl.has(d));
function simGen(i, entry, long, sd, tgtDist, exitIdx) { const stop = long ? entry - sd : entry + sd, tgt = tgtDist ? (long ? entry + tgtDist : entry - tgtDist) : null; let mfe = 0;
  for (let k = i + 1; k <= exitIdx; k++) { if (long ? D.L[k] <= stop : D.H[k] >= stop) { const fill = long ? Math.min(stop, D.O[k]) : Math.max(stop, D.O[k]); const pts = long ? fill - entry : entry - fill; return { how: 'STOP', pts, mfeR: mfe / sd, R: pts / sd }; }
    if (tgt != null && (long ? D.H[k] >= tgt : D.L[k] <= tgt)) { const fill = long ? Math.max(tgt, D.O[k]) : Math.min(tgt, D.O[k]); const pts = long ? fill - entry : entry - fill; return { how: 'TARGET', pts, mfeR: mfe / sd, R: pts / sd }; }
    const fav = long ? D.H[k] - entry : entry - D.L[k]; if (fav > mfe) mfe = fav; }
  const pts = long ? D.C[exitIdx] - entry : entry - D.C[exitIdx]; return { how: 'TIME', pts, mfeR: mfe / sd, R: pts / sd }; }
const raceR = (o, k) => (o.mfeR >= k ? k : o.R);
function run(minBars) { const ev = [];
  for (const d of sessions) { const [a] = S.rth.get(d), L = lvl.get(d), end = idxOf.get(d + ' 15:55:00') ?? lb(D.TS, d + ' 15:55:00'), exitIdx = idxOf.get(d + ' 15:58:00') ?? (lb(D.TS, d + ' 15:58:00') - 1), ibStart = idxOf.get(d + ' 10:31:00') ?? lb(D.TS, d + ' 10:31:00'), openU = { L: -1, S: -1 }, prev = {}, atr = S.atr20(d);
    for (let i = a + minBars; i <= end; i++) { let lo = Infinity, hi = -Infinity; for (let k = i - LOOK + 1; k <= i; k++) { if (D.L[k] < lo) lo = D.L[k]; if (D.H[k] > hi) hi = D.H[k]; }
      const now = {}; let fired = null;
      for (const [n, side] of SWEEP) { const p = L[n]; if (p == null) continue; if ((n === 'IB_LOW' || n === 'IB_HIGH') && i < ibStart) { now[n] = null; continue; }
        if (!CONFN.some((c) => c !== n && L[c] != null && Math.abs(L[c] - p) <= CONF)) { now[n] = null; continue; }
        let key = null, ext = 0, extreme = null;
        if (side === 'LOW') { if (lo < p - POKE && D.C[i] > p) { ext = p - lo; if (ext > EXT_MIN && ext < EXT_MAX && D.C[i] - lo > BOUNCE) { key = n + 'L'; extreme = lo; } } }
        else { if (hi > p + POKE && D.C[i] < p) { ext = hi - p; if (ext > EXT_MIN && ext < EXT_MAX && hi - D.C[i] > BOUNCE) { key = n + 'S'; extreme = hi; } } }
        now[n] = key; if (key && !fired && prev[n] !== key) fired = { n, long: side === 'LOW', extreme, ext }; }
      for (const [n] of SWEEP) prev[n] = now[n] ?? null;
      if (!fired || exitIdx <= i) continue; const dir = fired.long ? 'L' : 'S'; if (i <= openU[dir]) continue;
      const entry = D.C[i], stopPx = fired.long ? fired.extreme - BUF : fired.extreme + BUF, sd = Math.abs(entry - stopPx); if (sd <= 0) continue;
      const v1 = simGen(i, entry, fired.long, sd, TGT_LIVE, exitIdx), v2 = simGen(i, entry, fired.long, sd, null, exitIdx), f1 = simGen(i, entry, !fired.long, sd, TGT_LIVE, exitIdx), f2 = simGen(i, entry, !fired.long, sd, null, exitIdx);
      openU[dir] = v2.how === 'STOP' ? i + 1 : exitIdx; const mins = +D.TS[i].slice(11, 13) * 60 + +D.TS[i].slice(14, 16);
      const e = { d, i, ts: D.TS[i], mins, name: fired.n, long: fired.long, entry, sd, ext: fired.ext, v1how: v1.how, v1: v1.pts * 2 - 2, f1: f1.pts * 2 - 2, v2how: v2.how, v2: v2.pts * 2 - 2, f2: f2.pts * 2 - 2, mfeR: v2.mfeR, fmfeR: f2.mfeR, R: v2.R, fR: f2.R, r2: raceR(v2, 2), r3: raceR(v2, 3), r5: raceR(v2, 5), r1: raceR(v2, 1), fr1: raceR(f2, 1), fr2: raceR(f2, 2), fr3: raceR(f2, 3), fr5: raceR(f2, 5), early: mins < 630 }; ev.push(e);
      // v2 position is open until stopped or close; approximate with stop bar unknown -> use simple rule: block same direction until exit (conservative)
      openU[dir] = exitIdx; } }
  return ev; }
const A = run(MIN_BARS), B = run(5);
const f1 = (x) => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(1) : 'n/a', f2 = (x) => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : 'n/a';
console.log(`sessions ${sessions.length}; live-gated replay events ${A.length} over ${new Set(A.map((e) => e.d)).size} days (long ${A.filter((e) => e.long).length}, short ${A.filter((e) => !e.long).length}); early-start (09:35) events ${B.length}`);
// fidelity
const rr = (await query(`SELECT setup_type, fired_at::text f, resolution, actual_pnl::float p FROM active_setups WHERE setup_type LIKE 'STOP_SWEEP%' AND trade_date >= '2026-07-10' AND fired_at::time < '16:00' AND actual_pnl IS NOT NULL`)).rows.map((r) => ({ d: r.f.slice(0, 10), m: +r.f.slice(11, 13) * 60 + +r.f.slice(14, 16), long: r.setup_type.endsWith('LONG'), res: r.resolution, p: r.p }));
const rep = A.filter((e) => e.d >= '2026-07-10'); const near = (x, arr, tol) => arr.filter((y) => y.d === x.d && y.long === x.long && Math.abs(y.m - x.m) <= tol);
const repM = rep.map((e) => ({ d: e.d, m: e.mins, long: e.long, how: e.v1how }));
let agree = 0, nm = 0; for (const r of rr) { const c = near(r, repM, 10)[0]; if (c) { nm++; const cls = { STOP_HIT: 'STOP', TARGET_HIT: 'TARGET', TIME_EXPIRED: 'TIME' }[r.res]; if (cls === c.how) agree++; } }
console.log(`FIDELITY: real RTH StopSweep rows since 2026-07-10 ${rr.length} (mean ${f1(mean(rr.map((r) => r.p)))}); replay events ${rep.length} (V1 mean ${f1(mean(rep.map((e) => e.v1)))}); real rows with a replay event within 10 min ${(nm / rr.length * 100).toFixed(0)}%, replay events with a real row ${(rep.filter((e) => near({ d: e.d, m: e.mins, long: e.long }, rr, 10).length).length / rep.length * 100).toFixed(0)}%; outcome class agrees on ${agree} of ${nm} matched`);
fs.writeFileSync('scratch/stop_sweep_replay_events_20261021.json', JSON.stringify(A));
// stats
const ci1 = (ev, key, f) => ev.length > 1 ? dayBlockedBootstrapCI(ev.map((e) => ({ date: e.d, pnl: e[f] })), key) : { lo: NaN, hi: NaN };
const pairCI = (ev, key, fa, fb) => ev.length > 1 ? dayBlockedBootstrapCI(ev.map((e) => ({ date: e.d, pnl: e[fa] - e[fb] })), key) : { lo: NaN, hi: NaN };
const diffCI = (X, Y, key, f) => { const days = [...new Set([...X, ...Y].map((e) => e.d))], gx = new Map(), gy = new Map(); for (const e of X) (gx.get(e.d) || gx.set(e.d, []).get(e.d)).push(e[f]); for (const e of Y) (gy.get(e.d) || gy.set(e.d, []).get(e.d)).push(e[f]); const rng = mulberry32(hashSeed(key)), o = [];
  for (let b = 0; b < 2000; b++) { let sx = 0, nx = 0, sy = 0, ny = 0; for (let k = 0; k < days.length; k++) { const d = days[Math.floor(rng() * days.length)]; for (const x of gx.get(d) || []) { sx += x; nx++; } for (const x of gy.get(d) || []) { sy += x; ny++; } } if (nx && ny) o.push(sx / nx - sy / ny); } o.sort((p, q) => p - q); return { lo: o[Math.floor(0.025 * o.length)], hi: o[Math.floor(0.975 * o.length)] }; };
const EX = A.filter((e) => e.d <= '2025-05-31'), HO = A.filter((e) => e.d >= SPLIT);
const line = (nm, ev) => { if (!ev.length) { console.log(nm.padEnd(30), 'none'); return; } const c1 = ci1(ev, nm + 'v1', 'v1'), c2 = ci1(ev, nm + 'v2', 'v2'); const st = ev.filter((e) => e.v1how === 'TARGET').length / ev.length, sp = ev.filter((e) => e.v1how === 'STOP').length / ev.length;
  console.log(`${nm.padEnd(30)} n ${String(ev.length).padStart(4)} ${String(new Set(ev.map((e) => e.d)).size).padStart(3)}d | V1(live exit) ${f1(mean(ev.map((e) => e.v1))).padStart(6)} [${f1(c1.lo)},${f1(c1.hi)}] tgt ${(st * 100).toFixed(0)}% stop ${(sp * 100).toFixed(0)}% | V2(stop,hold) ${f1(mean(ev.map((e) => e.v2))).padStart(6)} [${f1(c2.lo)},${f1(c2.hi)}] meanR ${f2(mean(ev.map((e) => e.R)))} | P(+3R before stop) ${(ev.filter((e) => e.mfeR >= 3).length / ev.length * 100).toFixed(1)}% P(+5R) ${(ev.filter((e) => e.mfeR >= 5).length / ev.length * 100).toFixed(1)}% | median risk ${[...ev].map((e) => e.sd).sort((p, q) => p - q)[ev.length >> 1].toFixed(0)}pts`); };
console.log('\n=== the live StopSweep rule replayed ==='); line('ALL', A); line('explore', EX); line('hold-out', HO); line('LONG', A.filter((e) => e.long)); line('SHORT', A.filter((e) => !e.long));
console.log('by level:'); for (const [n] of SWEEP) line('  ' + n, A.filter((e) => e.name === n));
console.log('\n=== S1 flipped-direction placebo (mirrored distances) ===');
const FL = A.map((e) => ({ ...e, v2: e.f2, v1: e.f1, mfeR: e.fmfeR, R: e.fR })); line('placebo ALL', FL);
const s1 = {}; for (const [per, set] of [['explore', EX], ['hold-out', HO]]) { const c2 = pairCI(set, 'S1d' + per, 'v2', 'f2'), c3 = pairCI(set, 'S1r3' + per, 'r3', 'fr3'), c1 = pairCI(set, 'S1v1' + per, 'v1', 'f1'); s1[per] = { d: mean(set.map((e) => e.v2 - e.f2)), lo2: c2.lo, hi2: c2.hi, r3: mean(set.map((e) => e.r3 - e.fr3)), lo3: c3.lo, hi3: c3.hi };
  console.log(`${per.padEnd(9)} real minus flipped: V2 dollars ${f1(s1[per].d)} CI95 [${f1(c2.lo)},${f1(c2.hi)}] | R-race k=3 expectancy ${f2(s1[per].r3)} R CI95 [${f2(c3.lo)},${f2(c3.hi)}] | V1 dollars ${f1(mean(set.map((e) => e.v1 - e.f1)))} [${f1(c1.lo)},${f1(c1.hi)}]`); }
for (const k of [1, 2, 3, 5]) console.log(`  R-race k=${k}: real expectancy ${f2(mean(A.map((e) => e['r' + k])))} R vs flipped ${f2(mean(A.map((e) => e['fr' + k])))} R (no-skill gambler's-ruin value with zero drift = 0)`);
console.log(`S1 verdict: ${(s1.explore.lo2 > 0 && s1['hold-out'].lo2 > 0 && s1.explore.lo3 > 0 && s1['hold-out'].lo3 > 0) ? 'SUPPORTED' : 'NOT SHOWN'}`);
console.log('\n=== S2 timing: entered 10:00-10:30 vs later (IB-level events excluded) ===');
const noIB = (e) => e.name !== 'IB_LOW' && e.name !== 'IB_HIGH'; const s2 = {};
for (const [per, set] of [['explore', EX], ['hold-out', HO]]) { const X = set.filter(noIB).filter((e) => e.early), Y = set.filter(noIB).filter((e) => !e.early); line(`  ${per} early`, X); line(`  ${per} later`, Y); const cR = diffCI(X, Y, 'S2R' + per, 'R'), c3 = diffCI(X, Y, 'S2r3' + per, 'r3'); s2[per] = { dR: mean(X.map((e) => e.R)) - mean(Y.map((e) => e.R)), loR: cR.lo, hiR: cR.hi, d3: mean(X.map((e) => e.r3)) - mean(Y.map((e) => e.r3)), lo3: c3.lo, hi3: c3.hi }; console.log(`  ${per} early minus later: meanR ${f2(s2[per].dR)} CI95 [${f2(cR.lo)},${f2(cR.hi)}] | k=3 expectancy ${f2(s2[per].d3)} CI95 [${f2(c3.lo)},${f2(c3.hi)}]`); }
console.log(`S2 verdict: ${(s2.explore.loR > 0 && s2['hold-out'].loR > 0 && s2.explore.lo3 > 0 && s2['hold-out'].lo3 > 0) ? 'TIMING MATTERS' : 'NOT SHOWN'}`);
console.log('\n=== S3 exploratory: events from 09:35 (live 30-bar gate removed) ==='); line('early-start ALL', B); line('  09:35-10:00 only', B.filter((e) => e.mins < 600)); line('  10:00 on (same as live gate)', B.filter((e) => e.mins >= 600));
const B9 = B.filter((e) => e.mins < 600); if (B9.length > 20) { const FLB = B9.map((e) => ({ ...e })); const c = dayBlockedBootstrapCI(B9.map((e) => ({ date: e.d, pnl: e.v2 - e.f2 })), 'S3'); console.log(`  09:35-10:00 real minus flipped V2 dollars ${f1(mean(B9.map((e) => e.v2 - e.f2)))} CI95 [${f1(c.lo)},${f1(c.hi)}]`); }
process.exit(0);
