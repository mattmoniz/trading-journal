// study_poc_join_edge_blowthrough_20261028.mjs -- runs the PRE-REGISTERED test in docs/POC_JOIN_BLOWN_THROUGH_AT_EDGE_PREREG_20261028.md (committed 32d0c36 before any outcome).
// Question: when a POC join fires near an edge on its stop side and that edge is then broken and held, does the break continue more than other held breaks of the same edge?
// Do not add arms/cells here. Edges come from bars (never level_prices). Run: node scripts/study_poc_join_edge_blowthrough_20261028.mjs [--census]
import { query } from '../server/db.js';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { loadBars, sessionIndex, buildEvents, fwd, lb, ub, addDay, mean, sum, f } from './lib/pocJoinLoader.mjs';

const FROM = '2023-03-06', TO = '2026-10-27', SPLIT = '2025-06-01', HOLD = 15, HZ = [30, 60, 120, 240], CENSUS = process.argv.includes('--census');
const D = await loadBars(FROM, TO), { T, TS, O, H, L, C } = D, SI = sessionIndex(D);
const events = (await buildEvents(D, FROM, TO)).filter(e => e.d <= TO);
const hl = (a, b, minBars) => { if (b - a < minBars) return null; let hi = -Infinity, lo = Infinity; for (let i = a; i < b; i++) { if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i]; } return { hi, lo }; };
const lvCache = new Map();
function levelsFor(d) {                                   // every level is built from bars that exist before it is used
  if (lvCache.has(d)) return lvCache.get(d); const prev = addDay(d, -1), aOn = lb(TS, prev + ' 18:00:00');
  const on = hl(aOn, lb(TS, d + ' 09:30:00'), 300), ib = hl(lb(TS, d + ' 09:30:00'), lb(TS, d + ' 10:30:00'), 50), gib = hl(aOn, lb(TS, prev + ' 19:00:00'), 40);
  const j = lb(SI.dates, d) - 1, pr = j >= 0 ? SI.rth.get(SI.dates[j]) : null, pd = pr ? hl(pr[0], pr[1], 300) : null, A = SI.atr20(d);
  const o = { A, ONH: on?.hi, ONL: on?.lo, IBH: ib?.hi, IBL: ib?.lo, GIBH: gib?.hi, GIBL: gib?.lo, PDH: pd?.hi, PDL: pd?.lo }; lvCache.set(d, o); return o;
}
const at = (d, hhmm) => lb(TS, d + ' ' + hhmm), atPrev = (d, hhmm) => lb(TS, addDay(d, -1) + ' ' + hhmm);
const ARMS = [
  { name: 'RTH-ONH/ONL', sess: 'RTH', hiK: 'ONH', loK: 'ONL', cs: d => at(d, '09:30:00'), ce: d => at(d, '15:30:00'), se: d => at(d, '16:00:00') - 1, kn: d => at(d, '09:30:00') },
  { name: 'RTH-IB', sess: 'RTH', hiK: 'IBH', loK: 'IBL', cs: d => at(d, '10:30:00'), ce: d => at(d, '15:30:00'), se: d => at(d, '16:00:00') - 1, kn: d => at(d, '10:30:00') },
  { name: 'RTH-PD', sess: 'RTH', hiK: 'PDH', loK: 'PDL', cs: d => at(d, '09:30:00'), ce: d => at(d, '15:30:00'), se: d => at(d, '16:00:00') - 1, kn: d => at(d, '09:30:00') },
  { name: 'GLX-PD', sess: 'GLX', hiK: 'PDH', loK: 'PDL', cs: d => atPrev(d, '18:00:00'), ce: d => at(d, '09:15:00'), se: d => at(d, '09:30:00') - 1, kn: d => atPrev(d, '18:00:00') },
  { name: 'GLX-GIB', sess: 'GLX', hiK: 'GIBH', loK: 'GIBL', cs: d => atPrev(d, '19:00:00'), ce: d => at(d, '09:15:00'), se: d => at(d, '09:30:00') - 1, kn: d => atPrev(d, '19:00:00') },
];
const modAt = (i) => +TS[i].slice(11, 13) * 60 + +TS[i].slice(14, 16);
const sessOf = (m) => (m >= 570 && m < 960) ? 'RTH' : (m >= 1080 || m < 570) ? 'GLX' : null;
const q = (sorted, p) => { const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos); return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo); };
const era = (d) => d < SPLIT ? 'PRE' : 'POST';
// outcome: signed move from the entry-bar open (index ei, epoch ep) to the close h minutes later, in ATR20; null if it runs past the session end or hits a data gap
function outAt(ei, ep, entryPx, sgn, h, se, A) { const k = ub(T, ep + h - 1) - 1; if (k > se || k <= ei || T[k] < ep + h - 1 - 2) return null; return sgn * (C[k] - entryPx) / A; }
// first close beyond `lvl` in direction dir in [i0,i1); held = HOLD further closes all beyond. Returns {b0, held}
function firstBreak(lvl, dir, i0, i1) { for (let b = i0; b < i1; b++) { if (dir > 0 ? C[b] > lvl : C[b] < lvl) { if (b + HOLD + 1 >= T.length || T[b + HOLD] - T[b] !== HOLD) return { b0: b, held: false, gap: true }; let held = true; for (let k = b + 1; k <= b + HOLD; k++) if (dir > 0 ? C[k] <= lvl : C[k] >= lvl) { held = false; break; } return { b0: b, held }; } } return null; }

// fresh breaks (Amendment 1): a close beyond lvl after >= REARM consecutive closes not beyond it (window start counts as armed); one event per excursion, held or not
const REARM = 30;
function freshBreaks(lvl, dir, i0, i1) { const out = []; let inside = REARM; for (let b = i0; b < i1; b++) { const beyond = dir > 0 ? C[b] > lvl : C[b] < lvl;
  if (!beyond) { inside++; continue; } if (inside >= REARM) { if (b + HOLD + 1 >= T.length || T[b + HOLD] - T[b] !== HOLD) { inside = 0; continue; } let held = true; for (let k = b + 1; k <= b + HOLD; k++) if (dir > 0 ? C[k] <= lvl : C[k] >= lvl) { held = false; break; } out.push({ b0: b, held }); } inside = 0; } return out; }
// ---- joins per arm (edge on the stop side) ----
const arm = new Map(ARMS.map(a => [a.name, { a, joins: [], excl: 0 }]));
for (let i = 0; i < events.length; i++) {
  const e = events[i], m = modAt(e.ei), s = sessOf(m); if (!s) continue; const lv = levelsFor(e.d); if (!lv.A) continue; const w = fwd(D, events, i), last = w ? w[1] : -1;
  for (const a of ARMS) { if (a.sess !== s) continue; const R = arm.get(a.name); if (e.ei < a.kn(e.d) || e.ei > a.se(e.d)) continue;
    const lvl = e.long ? lv[a.loK] : lv[a.hiK]; if (lvl == null) continue; const dist = (e.long ? e.entry - lvl : lvl - e.entry) / lv.A; if (dist < 0) { R.excl++; continue; }
    R.joins.push({ i, d: e.d, long: e.long, ei: e.ei, ep: e.ep, entry: e.entry, A: lv.A, dist, lvl, last, se: a.se(e.d), a }); } }
// ---- real-row match (sanity) ----
const real = (await query(`SELECT to_char(fired_at,'YYYY-MM-DD HH24:MI') m, setup_type FROM active_setups WHERE setup_type LIKE 'POC_ROTATION_JOIN%' AND fired_at >= '2026-09-01' AND fired_at < '2026-10-28'`)).rows;
const realKeys = new Set(real.map(r => r.m + '|' + (r.setup_type.endsWith('LONG') ? 'L' : 'S')));
const evWin = events.filter(e => TS[e.ei] >= '2026-09-01' && TS[e.ei] < '2026-10-28'), evKeys = new Set(evWin.map(e => TS[e.ei].slice(0, 16) + '|' + (e.long ? 'L' : 'S')));
let mt = 0; for (const k of realKeys) if (evKeys.has(k)) mt++;
console.log(`window ${FROM}..${TO}; join events ${events.length}; real POC_ROTATION_JOIN rows 2026-09-01..10-27: ${realKeys.size} distinct (minute,dir); replay events same window: ${evKeys.size}; real rows matched by a replay event: ${mt} (${(100 * mt / (realKeys.size || 1)).toFixed(0)}%), replay events matched by a real row: ${[...evKeys].filter(k => realKeys.has(k)).length}`);

// ---- cutoffs, held breaks, SIGNAL / CONTROL ----
const dayBoot = (g1, g2, key, tag, n = 2000) => {          // CI of mean(g1)-mean(g2) (or mean(g1) if g2 null) resampling whole trading days; per-event means
  const by = new Map(); const add = (arr, k) => { for (const r of arr) { const v = key(r); if (v == null) continue; let o = by.get(r.d); if (!o) by.set(r.d, o = [0, 0, 0, 0]); o[k * 2] += v; o[k * 2 + 1]++; } };
  add(g1, 0); if (g2) add(g2, 1); const days = [...by.values()], r = mulberry32(hashSeed(tag)), out = [];
  for (let b = 0; b < n; b++) { let s1 = 0, c1 = 0, s2 = 0, c2 = 0; for (let k = 0; k < days.length; k++) { const o = days[(r() * days.length) | 0]; s1 += o[0]; c1 += o[1]; s2 += o[2]; c2 += o[3]; } if (!c1 || (g2 && !c2)) continue; out.push(s1 / c1 - (g2 ? s2 / c2 : 0)); }
  out.sort((x, y) => x - y); return out.length ? [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]] : null; };
const pm = (rows, key) => { const v = rows.map(key).filter(x => x != null); return v.length ? mean(v) : NaN; };
const distinct = (rows, key) => new Set(rows.filter(r => key(r) != null).map(r => r.d)).size;
const R2 = [];
for (const [name, R] of arm) { const a = R.a, ds = R.joins.map(j => j.dist).sort((x, y) => x - y); R.q33 = ds.length ? q(ds, 1 / 3) : NaN; R.q67 = ds.length ? q(ds, 2 / 3) : NaN;
  for (const j of R.joins) { j.near = j.dist <= R.q33; j.far = j.dist > R.q67; }
  const nearJ = R.joins.filter(j => j.near);
  // held breaks of every arm level, one per level per day per side
  const days = [...new Set(events.map(e => e.d))].sort(); R.breaks = []; R.breaks0 = [];
  const mk = (d, dir, fb, lvl, lv, into) => { if (!fb.held) return; const eb = fb.b0 + HOLD, ei = eb + 1; if (ei > a.se(d)) return; const ep = T[ei], px = O[ei]; const out = {}; for (const h of HZ) out[h] = outAt(ei, ep, px, dir, h, a.se(d), lv.A);
    const sig = nearJ.some(j => j.d === d && j.long === (dir < 0) && j.ei < fb.b0 && fb.b0 <= j.last && j.lvl === lvl); into.push({ d, era: era(d), dir, b0: fb.b0, sig, out }); };
  for (const d of days) { const lv = levelsFor(d); if (!lv.A) continue;
    for (const dir of [1, -1]) { const lvl = dir > 0 ? lv[a.hiK] : lv[a.loK]; if (lvl == null) continue; const i0 = a.cs(d), i1 = a.ce(d); if (i1 - i0 < 30) continue;
      const f0 = firstBreak(lvl, dir, i0, i1); if (f0) mk(d, dir, f0, lvl, lv, R.breaks0); for (const fb of freshBreaks(lvl, dir, i0, i1)) mk(d, dir, fb, lvl, lv, R.breaks); } } }

console.log('\n=== CENSUS (no outcomes) ===');
console.log('arm            joins(valid) excl(dist<0)  q33(ATR20) q67   NEAR FAR | FRESH held breaks  SIGNAL(N,days)  CONTROL(N,days) | day-first: SIGNAL N, all N');
for (const [name, R] of arm) { const S = R.breaks.filter(b => b.sig), Cn = R.breaks.filter(b => !b.sig);
  console.log(`${name.padEnd(14)} ${String(R.joins.length).padStart(6)} ${String(R.excl).padStart(10)}  ${R.q33.toFixed(3).padStart(9)} ${R.q67.toFixed(3)} ${String(R.joins.filter(j => j.near).length).padStart(5)} ${String(R.joins.filter(j => j.far).length).padStart(4)} | ${String(R.breaks.length).padStart(6)}   ${String(S.length).padStart(5)} ${String(new Set(S.map(b => b.d)).size).padStart(4)}    ${String(Cn.length).padStart(5)} ${String(new Set(Cn.map(b => b.d)).size).padStart(4)} | ${R.breaks0.filter(b => b.sig).length}, ${R.breaks0.length}`); }
if (CENSUS) process.exit(0);

// ---- Test 2 (primary) ----
const verdicts = [];
for (const [setKey, setLab] of [['breaks', 'TEST 2 (PRIMARY, Amendment 1 fresh breaks)'], ['breaks0', 'TEST 2-orig (day-first breaks, expected UNDERPOWERED, not counted)']]) {
console.log(`\n=== ${setLab}: held break after a NEAR join blown through (SIGNAL) minus other held breaks of the same edge (CONTROL), signed move in ATR20 ===`);
for (const [name, R] of arm) { const S = R[setKey].filter(b => b.sig), Cn = R[setKey].filter(b => !b.sig); console.log(`\n-- ${name}: SIGNAL N=${S.length} (${new Set(S.map(b => b.d)).size} days), CONTROL N=${Cn.length}`);
  const res = {};
  for (const h of HZ) { const k = r => r.out[h]; const s = S.filter(r => k(r) != null), c = Cn.filter(r => k(r) != null); const diff = pm(S, k) - pm(Cn, k); const ci = dayBoot(S, Cn, k, name + 'D' + h), ciS = dayBoot(S, null, k, name + 'S' + h);
    const pre = pm(S.filter(r => r.era === 'PRE'), k) - pm(Cn.filter(r => r.era === 'PRE'), k), post = pm(S.filter(r => r.era === 'POST'), k) - pm(Cn.filter(r => r.era === 'POST'), k);
    res[h] = { diff, ci, ciS, sm: pm(S, k), pre, post, n: s.length };
    console.log(`  +${String(h).padStart(3)}m  SIGNAL n=${String(s.length).padStart(3)} mean ${f(pm(S, k), 3)} CI ${ciS ? `[${f(ciS[0], 3)},${f(ciS[1], 3)}]` : 'n/a'} | CONTROL n=${String(c.length).padStart(4)} mean ${f(pm(Cn, k), 3)} | diff ${f(diff, 3)} CI ${ci ? `[${f(ci[0], 3)},${f(ci[1], 3)}]` : 'n/a'} | PRE ${f(pre, 3)} POST ${f(post, 3)}`); }
  for (const [lab, longJ] of [['long join -> break DOWN', true], ['short join -> break UP', false]]) { const S2 = S.filter(b => (b.dir < 0) === longJ), C2 = Cn.filter(b => (b.dir < 0) === longJ); console.log(`  ${lab}: SIGNAL n=${S2.length} +60 ${f(pm(S2, r => r.out[60]), 3)} vs CONTROL n=${C2.length} ${f(pm(C2, r => r.out[60]), 3)}`); }
  const byDay = new Map(); for (const r of S) if (r.out[60] != null) byDay.set(r.d, (byDay.get(r.d) || 0) + r.out[60]); const dv = [...byDay.values()].sort((x, y) => y - x), tot = sum(dv), top5 = sum(dv.slice(0, 5)); const share = tot > 0 ? top5 / tot : NaN;
  const c1 = S.length >= 40 && new Set(S.map(b => b.d)).size >= 30, ex = (x) => x.ci && x.ci[0] > 0, c2 = ex(res[60]) && ex(res[120]) && res[60].diff > 0 && res[120].diff > 0, c3 = res[60].ciS && res[60].ciS[0] > 0, c4 = [60, 120].every(h => res[h].pre > 0 && res[h].post > 0), c5 = tot > 0 && share < 0.5;
  const half = res[60].ci ? (res[60].ci[1] - res[60].ci[0]) / 2 : NaN;
  console.log(`  criteria: 1 N>=40&days>=30 ${c1} | 2 diff>0 CI>0 at +60,+120 ${c2} | 3 signal mean CI>0 ${!!c3} | 4 PRE&POST>0 ${c4} | 5 top5 share<50% ${c5} (share ${f(100 * share, 0)}%) | resolution of the +60 diff CI half-width ${half.toFixed(3)} ATR20`);
  verdicts.push({ name, set: setKey, pass: c1 && c2 && c3 && c4 && c5, under: !c1, n: S.length, d60: res[60].diff, ci60: res[60].ci, half }); } }

// ---- Test 1 (supporting): join works worse near the edge? ----
console.log('\n=== TEST 1 (SUPPORTING): with-join signed move, NEAR minus FAR (negative = join weaker at the edge), ATR20 ===');
for (const [name, R] of arm) { console.log(`\n-- ${name}: NEAR ${R.joins.filter(j => j.near).length}, FAR ${R.joins.filter(j => j.far).length}`);
  const withOut = R.joins.map(j => ({ d: j.d, near: j.near, far: j.far, long: j.long, o: Object.fromEntries(HZ.map(h => [h, outAt(j.ei, j.ep, j.entry, j.long ? 1 : -1, h, j.se, j.A)])) }));
  for (const grp of [['all', () => true], ['long joins', r => r.long], ['short joins', r => !r.long]]) for (const h of [60, 120, 240]) { const k = r => r.o[h], N = withOut.filter(r => r.near && grp[1](r)), Fa = withOut.filter(r => r.far && grp[1](r)); const ci = dayBoot(N, Fa, k, name + grp[0] + 'T1' + h);
    if (grp[0] === 'all' || h === 60) console.log(`  ${grp[0].padEnd(11)} +${String(h).padStart(3)}m NEAR ${f(pm(N, k), 3)} (n=${N.filter(r => k(r) != null).length}) FAR ${f(pm(Fa, k), 3)} (n=${Fa.filter(r => k(r) != null).length}) diff ${f(pm(N, k) - pm(Fa, k), 3)} CI ${ci ? `[${f(ci[0], 3)},${f(ci[1], 3)}]` : 'n/a'}`); }
  const hb = (grp) => { let n = 0, c = 0; for (const j of R.joins.filter(grp)) { const dir = j.long ? -1 : 1, lv = levelsFor(j.d), lvl = j.lvl; const fb = firstBreak(lvl, dir, j.ei + 1, Math.min(j.last + 1, j.a.ce(j.d))); n++; if (fb && fb.held) c++; } return `${c}/${n} (${(100 * c / (n || 1)).toFixed(1)}%)`; };
  console.log(`  descriptive: held break of the edge inside the join's life: NEAR ${hb(j => j.near)} vs FAR ${hb(j => j.far)}`); }
console.log('\n=== VERDICT ===');
for (const v of verdicts) console.log(`[${v.set === 'breaks' ? 'primary' : 'orig'}] ${v.name}: ${v.pass ? 'SHOWS a blown-through-join breakout sign (lead for one frozen second look)' : v.under ? 'UNDERPOWERED (N=' + v.n + ')' : 'NOT SHOWN'}; +60 SIGNAL-CONTROL ${f(v.d60, 3)} ATR20 CI ${v.ci60 ? `[${f(v.ci60[0], 3)},${f(v.ci60[1], 3)}]` : 'n/a'}`);
console.log(`primary passes ${verdicts.filter(v => v.set === 'breaks' && v.pass).length} of 5`);
process.exit(0);
