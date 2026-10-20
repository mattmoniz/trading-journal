// study_rotation_gate_roster_replay_20261020.mjs -- runs docs/ROTATION_GATE_ROSTER_REPLAY_PREREG_20261020.md (committed 7758670 before any gate outcome on this population).
// RTH level-fade touches replayed over 3.5 years (as study_roster_replay_20261019.mjs) with REALISTIC fills, each tagged AGREE/DISAGREE with the direction of the in-progress 65pt rotation leg at the touch (rotationDetector.detectRotationLegs on the 18:00-anchored detector session; verified equivalent to the live gate's detectSignalEvents all_leg_records.at(-1).direction on random samples first).
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex, mean, sum, f, lb, addDay, rnd } from './lib/pocJoinLoader.mjs';
import { detectRotationLegs } from '../server/services/rotationDetector.js';
import { detectSignalEvents } from '../server/services/pocRotationService.js';
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01', PROX = 15;
const GATE = { OR5: 575, OR10: 580, OR15: 585, OR30: 600, IB: 630 }; const formGate = (n) => { for (const k of Object.keys(GATE)) if (n.startsWith(k + '_')) return GATE[k]; return 575; };
const D = await loadBars(FROM, TO), S = sessionIndex(D);
const opt = new Map((await query(`SELECT DISTINCT ON (signal_name) signal_name, ROUND(COALESCE(optimal_stop,p75_mae))::int stp, ROUND(COALESCE(optimal_target,p50_mfe))::int tgt FROM performance_audit WHERE signal_type='OPTIMAL_STOP' ORDER BY signal_name, run_date DESC, id DESC`)).rows.filter(r => r.stp > 0 && r.tgt > 0).map(r => [r.signal_name, r]));
const LV = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND price IS NOT NULL AND level_name <> 'RTH_VWAP'`, [FROM, TO])).rows) (LV.get(r.d) || LV.set(r.d, []).get(r.d)).push(r);
const mod = (gi) => +D.TS[gi].slice(11, 13) * 60 + +D.TS[gi].slice(14, 16);
function simTrade(gi, endIdx, long, entry, stp, tgt) { const { O, H, L, C } = D, stopP = long ? entry - stp : entry + stp, tgtP = long ? entry + tgt : entry - tgt;
  for (let k = gi + 1; k <= endIdx; k++) { if (long ? L[k] <= stopP : H[k] >= stopP) { const fill = long ? Math.min(stopP, O[k]) : Math.max(stopP, O[k]); return (long ? fill - entry : entry - fill) * 2 - 2; }
    if (long ? H[k] >= tgtP : L[k] <= tgtP) { const fill = long ? Math.max(tgtP, O[k]) : Math.min(tgtP, O[k]); return (long ? fill - entry : entry - fill) * 2 - 2; } }
  return (long ? D.C[endIdx] - entry : entry - D.C[endIdx]) * 2 - 2; }
const legCache = new Map(); function legsOf(d) { if (legCache.has(d)) return legCache.get(d); const a = lb(D.TS, addDay(d, -1) + ' 18:00:00'), b = lb(D.TS, d + ' 17:00:00'); const bars = []; for (let i = a; i < b; i++) bars.push({ high: D.H[i], low: D.L[i] }); const out = { a, legs: bars.length ? detectRotationLegs(bars, 65) : [] }; legCache.set(d, out); return out; }
const rotDir = (d, gi) => { const { a, legs } = legsOf(d); let dir = null; for (const l of legs) { if (a + l.idx <= gi) dir = l.dir; else break; } return dir; };   // 'UP'|'DOWN'|null
const trades = []; let skipped = 0, noLeg = 0; const touches = [];
for (let di = 0; di < S.dates.length; di++) { const d = S.dates[di]; if (d < FROM || d > TO) continue; const atr = S.atr20(d), L = LV.get(d); if (!atr || !L) continue; const [a, b] = S.rth.get(d); const prev = S.dates[di - 1], pdc = L.find(x => x.n === 'PD_CLOSE');
  if (pdc && prev && Math.abs(pdc.p - D.C[S.rth.get(prev)[1] - 1]) > 0.1 * atr) { skipped++; continue; }
  for (const lev of L) { if (!opt.has(lev.n + '_FADE_LONG') && !opt.has(lev.n + '_FADE_SHORT')) continue; const g = formGate(lev.n);
    for (let gi = a + 5; gi < b; gi++) { if (mod(gi) < Math.max(575, g)) continue; if (Math.abs(D.C[gi] - lev.p) > PROX) continue;
      const long = !(D.C[gi - 5] < D.C[gi]), type = `${lev.n}_FADE_${long ? 'LONG' : 'SHORT'}`, o = opt.get(type); if (!o) break; const entry = D.C[gi];
      touches.push({ d, gi, long, type, lvl: lev.n }); trades.push({ d, type, long, pnl: simTrade(gi, b - 1, long, entry, o.stp, o.tgt), plc: simTrade(gi, b - 1, !long, entry, o.stp, o.tgt), rd: rotDir(d, gi), era: d < SPLIT ? 'PRE' : 'POST', yr: d.slice(0, 4) }); break; } } }
console.log(`roll/mismatch days skipped ${skipped}; replayed touches ${trades.length}`);
// ---- equivalence check vs the live gate's detectSignalEvents(all_leg_records.at(-1).direction), random (date, bar) samples
{ let seed = 99; const r2 = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; let ok = 0, bad = 0, nulls = 0; const sample = []; for (let k = 0; k < 220; k++) sample.push(touches[Math.floor(r2() * touches.length)]);
  for (const t of sample) { const a = lb(D.TS, addDay(t.d, -1) + ' 18:00:00'), bars = []; for (let i = a; i <= t.gi; i++) bars.push({ ts: D.TS[i], open: D.O[i], high: D.H[i], low: D.L[i], close: D.C[i], volume: D.V[i] });
    const { all_leg_records } = detectSignalEvents(65, 'standard', 6.75, [{ t: t.d, bars }], 'fixed'); const live = all_leg_records.length ? all_leg_records[all_leg_records.length - 1].direction : null, mine = rotDir(t.d, t.gi); if (live == null && mine == null) { nulls++; ok++; } else if (live === mine) ok++; else bad++; }
  console.log(`equivalence check vs live gate logic on ${sample.length} random touches: match ${ok} (both-null ${nulls}), MISMATCH ${bad}`); if (bad > 0) { console.log('STOP: direction logic is not equivalent to the live gate; fix before reporting.'); process.exit(1); } }
const T = trades.filter(t => t.rd), ag = (t) => (t.rd === 'UP') === t.long; for (const t of T) t.agree = ag(t);
console.log(`tagged (a 65pt leg already confirmed) ${T.length} of ${trades.length}; untagged ${trades.length - T.length}`);
function boot(arr, stat, n = 2000) { const by = new Map(); for (const r of arr) (by.get(r.d) || by.set(r.d, []).get(r.d)).push(r); const ds = [...by.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(...ds[(rnd() * ds.length) | 0]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((x, y) => x - y); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const diffStat = (p) => mean(p.filter(t => t.agree).map(t => t.pnl)) - mean(p.filter(t => !t.agree).map(t => t.pnl));
const row = (label, sub) => { const a = sub.filter(t => t.agree), d = sub.filter(t => !t.agree), [lo, hi] = boot(sub, diffStat, 1200); console.log(`${label.padEnd(12)} AGREE ${String(a.length).padStart(5)} ${f(mean(a.map(t => t.pnl)), 2).padStart(7)} | DISAGREE ${String(d.length).padStart(5)} ${f(mean(d.map(t => t.pnl)), 2).padStart(7)} | AGREE-DISAGREE ${f(diffStat(sub), 2)} [${f(lo, 1)},${f(hi, 1)}] | AGREE flipped ${f(mean(a.map(t => t.plc)), 2)}`); return { na: a.length, nd: d.length, diff: diffStat(sub), lo, hi, am: mean(a.map(t => t.pnl)), flip: mean(a.map(t => t.plc)) }; };
console.log('\n=== RESULTS (RTH level-fade replay, realistic fills) ==='); const O = row('OVERALL', T), pre = row('PRE', T.filter(t => t.era === 'PRE')), post = row('POST', T.filter(t => t.era === 'POST'));
for (const y of ['2023', '2024', '2025', '2026']) row(y, T.filter(t => t.yr === y));
const A = T.filter(t => t.agree), [alo, ahi] = boot(A, p => mean(p.map(t => t.pnl)), 1500);
const groups = new Map(); T.forEach((t, i) => { const k = t.long ? 'L' : 'S'; (groups.get(k) || groups.set(k, []).get(k)).push(i); });
// permutation strata = trade DIRECTION only (pre-registered date x direction strata are nearly homogeneous -- on a trending day every long touch has the same label -- so that null barely moved and every permutation tied the observed value, p=1.0000; implementation correction; the verdict does not depend on it; the day-blocked CIs carry the day clustering)
const obs = diffStat(T); let ge = 0; const NP = 1500, lab = T.map(t => t.agree);
for (let p = 0; p < NP; p++) { const sh = T.map(t => ({ ...t })); for (const idx of groups.values()) { const l = idx.map(i => lab[i]); for (let i = l.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [l[i], l[j]] = [l[j], l[i]]; } idx.forEach((i, k) => { sh[i].agree = l[k]; }); } if (diffStat(sh) >= obs) ge++; }
const pperm = ge / NP, tot = sum(A.map(t => t.pnl)), top5 = tot > 0 ? sum([...A].sort((x, y) => y.pnl - x.pnl).slice(0, 5).map(t => t.pnl)) / tot : Infinity;
console.log(`\nAGREE-only roster mean ${f(mean(A.map(t => t.pnl)), 2)} CI [${f(alo, 1)},${f(ahi, 1)}] (ALL tagged ${f(mean(T.map(t => t.pnl)), 2)}); permutation p ${pperm.toFixed(4)}; AGREE total ${f(tot, 0)}, top-5 share ${Number.isFinite(top5) ? (100 * top5).toFixed(0) + '%' : 'non-positive total'}`);
console.log(`size rule (AGREE x1, DISAGREE x0.5) total ${f(sum(A.map(t => t.pnl)) + 0.5 * sum(T.filter(t => !t.agree).map(t => t.pnl)), 0)} vs ALL ${f(sum(T.map(t => t.pnl)), 0)} vs AGREE-only ${f(tot, 0)}`);
const P = (ok, t) => console.log((ok ? 'PASS ' : 'FAIL ') + t); console.log('\n=== PRE-REGISTERED CRITERIA ===');
P(O.na >= 2000 && O.nd >= 2000, `1. N AGREE ${O.na}, DISAGREE ${O.nd}`); P(O.diff > 0 && O.lo > 0 && pre.diff > 0 && post.diff > 0, `2. AGREE-DISAGREE ${f(O.diff, 2)} [${f(O.lo, 1)},${f(O.hi, 1)}] PRE ${f(pre.diff, 2)} POST ${f(post.diff, 2)}`); P(pperm <= 0.05, `3. permutation p ${pperm.toFixed(4)}`);
P(O.am > O.flip && pre.am > pre.flip && post.am > post.flip, `4. AGREE beats flipped placebo overall/PRE/POST`); P(top5 < 0.5, `5. top-5 share of a positive AGREE total (${Number.isFinite(top5) ? (100 * top5).toFixed(0) + '%' : 'non-positive'})`);
fs.writeFileSync('scratch/rotation_gate_replay_rows_20261020.json', JSON.stringify(T.map(t => ({ d: t.d, type: t.type, long: t.long, agree: t.agree, pnl: t.pnl, plc: t.plc, era: t.era })))); process.exit(0);
