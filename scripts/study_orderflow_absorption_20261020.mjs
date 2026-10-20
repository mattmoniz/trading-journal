// study_orderflow_absorption_20261020.mjs -- runs docs/ORDERFLOW_ABSORPTION_PREREG_20261020.md (committed 41bc514 before any outcome).
// Aggressor-flow effort vs result at a sweep: P1 (sellers absorbed at the turn -> longs work) and P2 (buyers stuffed into the level -> longs should step aside). Research only.
import { query } from '../server/db.js';
import { loadBars, sessionIndex, mean, sum, f, lb, addDay } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
const FROM = '2023-03-06', TO = '2026-10-16', LOADTO = '2026-10-20', SPLIT = '2025-06-01', WS = [3, 10, 30], NPAST = 60;
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const D = await loadBars(FROM, LOADTO), S = sessionIndex(D); const { H, L, C, TS } = D;
const idxOf = new Map(); for (let i = 0; i < TS.length; i++) idxOf.set(TS[i], i);
const BV = new Float64Array(TS.length), AV = new Float64Array(TS.length);
{ const r = await query(`SELECT ts::text ts, bid_volume::float b, ask_volume::float a FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - 200 AND ts < $2::date + 3 ORDER BY ts`, [FROM, LOADTO]); for (const x of r.rows) { const i = idxOf.get(x.ts); if (i != null) { BV[i] = x.b; AV[i] = x.a; } } }
const cs = (arr) => { const o = new Float64Array(arr.length + 1); for (let i = 0; i < arr.length; i++) o[i + 1] = o[i] + arr[i]; return o; }; const cB = cs(BV), cA = cs(AV);
const mod = (i) => +TS[i].slice(11, 13) * 60 + +TS[i].slice(14, 16);
const dates = S.dates.filter(d => d >= FROM && d <= TO && !isInsideNqRollWeek(d));
const sess = []; for (const d of dates) { const j = S.dates.indexOf(d); if (j < 1) continue; const pd = S.dates[j - 1]; if ((Date.parse(d) - Date.parse(pd)) / 864e5 > 4 || isInsideNqRollWeek(pd)) continue; const atr = S.atr20(d); if (!atr) continue;
  const [a, b] = S.rth.get(d), [pa, pb] = S.rth.get(pd), n0 = lb(TS, addDay(d, -1) + ' 18:00:00'), ib1 = lb(TS, d + ' 10:30:00'); if (a - n0 < 30) continue;
  const mm = (x, y) => { let lo = Infinity, hi = -Infinity; for (let i = x; i < y; i++) { if (L[i] < lo) lo = L[i]; if (H[i] > hi) hi = H[i]; } return [lo, hi]; };
  const [onl, onh] = mm(n0, a), [pdl, pdh] = mm(pa, pb), [ibl, ibh] = mm(a, ib1);
  sess.push({ d, a, b, n0, atr, arms: { RTH: { from: a, to: b, lastStart: 810, levels: { ONL: [onl, onh, 575], PDL: [pdl, pdh, 575], IBL: [ibl, ibh, 630] } }, GLX: { from: n0, to: a, levels: { PDL: [pdl, pdh, 0] } } } }); }
function detect(s, arm, level, sgn, startOff) { const A = s.arms[arm]; const lv = sgn * level, c = (i) => sgn * C[i], lo = (i) => sgn > 0 ? L[i] : -H[i]; let i0 = -1;
  for (let i = Math.max(A.from + (arm === 'RTH' ? Math.max(5, startOff - 570) : 30), A.from + 1); i < A.to; i++) { if (arm === 'RTH' && mod(i) > A.lastStart) break; if (c(i - 1) >= lv && lo(i) < lv) { i0 = i; break; } } if (i0 < 0) return null;
  let tr = -1; for (let j = i0; j < A.to; j++) if (c(j) >= lv) { tr = j; break; } return { d: s.d, arm, sgn, i0, tr, end: A.to }; }
// ---- flow features at a decision bar e for window W, frame sgn; ranks against the previous NPAST sessions at the same clock time
function pastIdx(e) { const t = TS[e], day = t.slice(0, 10), clock = t.slice(10), out = []; for (let k = 1; k <= 200 && out.length < NPAST; k++) { const j = idxOf.get(addDay(day, -k) + clock); if (j != null) out.push(j); } return out; }
const quant = (e, W) => ({ sell: cB[e + 1] - cB[e + 1 - W], buy: cA[e + 1] - cA[e + 1 - W], res: C[e] - C[e - W] });
function feats(e, sgn, W) { const cur = quant(e, W), past = pastIdx(e).filter(j => j - W >= 0).map(j => quant(j, W)); if (past.length < 30) return null;
  const rk = (x, arr) => arr.filter(v => v <= x).length / arr.length; const against = sgn > 0 ? 'sell' : 'buy', withs = sgn > 0 ? 'buy' : 'sell';
  const resToward = sgn * cur.res, pastToward = past.map(p => sgn * p.res);
  const rEffAg = rk(cur[against], past.map(p => p[against])), rEffWith = rk(cur[withs], past.map(p => p[withs])), rToward = rk(resToward, pastToward), rAway = 1 - rToward;
  return { absAgainst: rEffAg * rToward, absWith: rEffWith * rAway, raw: cur }; }
const R30 = (e) => { let hi = -Infinity, lo = Infinity; for (let i = e - 29; i <= e; i++) { if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i]; } return hi - lo; };
function race(e, sgn, end, q) { const E = C[e], r = q * R30(e); for (let j = e + 1; j < end; j++) { const up = sgn > 0 ? H[j] >= E + r : L[j] <= E - r, dn = sgn > 0 ? L[j] <= E - r : H[j] >= E + r; if (up && dn) return 0; if (up) return 1; if (dn) return -1; } return 0; }
// ---- build events
const evs = []; for (const s of sess) for (const arm of ['RTH', 'GLX']) for (const lvl of Object.keys(s.arms[arm].levels)) for (const sgn of [1, -1]) { const e = detect(s, arm, s.arms[arm].levels[lvl][sgn > 0 ? 0 : 1], sgn, s.arms[arm].levels[lvl][2]); if (!e || e.i0 < 40) continue; e.lvl = lvl; e.month = s.d.slice(0, 7);
  e.p2 = {}; for (const W of WS) { const ft = feats(e.i0, sgn, W); if (ft) e.p2['W' + W] = ft.absWith; } e.s2 = { q1: race(e.i0, sgn, e.end, 1), q05: race(e.i0, sgn, e.end, .5), q2: race(e.i0, sgn, e.end, 2) };
  if (e.tr >= 0) { e.p1 = {}; for (const W of WS) { const ft = feats(e.tr, sgn, W); if (ft) e.p1['W' + W] = ft.absAgainst; } e.s1 = { q1: race(e.tr, sgn, e.end, 1), q05: race(e.tr, sgn, e.end, .5), q2: race(e.tr, sgn, e.end, 2) }; } evs.push(e); }
console.log(`events ${evs.length}: RTH ${evs.filter(e => e.arm === 'RTH').length} (lows ${evs.filter(e => e.arm === 'RTH' && e.sgn > 0).length}), GLX ${evs.filter(e => e.arm === 'GLX').length}; reclaiming ${evs.filter(e => e.tr >= 0).length}`);
// ---- Spearman utilities (feature ranks fixed; scores have 3 categories -> fixed category ranks)
function avgRanks(a) { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; }
const pear = (a, b) => { const ma = mean(a), mb = mean(b); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < a.length; i++) { sxy += (a[i] - ma) * (b[i] - mb); sxx += (a[i] - ma) ** 2; syy += (b[i] - mb) ** 2; } return sxy / Math.sqrt(sxx * syy); };
const spearman = (x, y) => pear(avgRanks(x), avgRanks(y));
function analyze(name, E, key, sk, q, sign, extra = {}) { // key 'p1'|'p2', sk 's1'|'s2'
  const out = { name }; const pool = E.filter(e => e[key] && WS.every(W => e[key]['W' + W] != null)); out.n = pool.length; if (pool.length < 40) { console.log(`${name}: too few events (${pool.length})`); return null; }
  const score = pool.map(e => e[sk]['q' + q]); const per = {}; for (const W of WS) per[W] = spearman(pool.map(e => e[key]['W' + W]), score);
  const stat = (p) => sign > 0 ? Math.max(...WS.map(W => p[W])) : Math.min(...WS.map(W => p[W])); const real = stat(per), argW = WS.find(W => per[W] === real);
  // null: permute scores within arm|month strata, recompute the max/min over W using fixed feature ranks
  const fr = {}; for (const W of WS) fr[W] = avgRanks(pool.map(e => e[key]['W' + W])); const cat = avgRanks(score); const strata = new Map(); pool.forEach((e, i) => (strata.get(e.arm + e.month) || strata.set(e.arm + e.month, []).get(e.arm + e.month)).push(i));
  const nulls = []; for (let b = 0; b < 1000; b++) { const perm = cat.slice(); for (const g of strata.values()) { const vals = g.map(i => cat[i]); for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; } g.forEach((i, k) => perm[i] = vals[k]); } const pp = {}; for (const W of WS) pp[W] = pear(fr[W], perm); nulls.push(stat(pp)); } nulls.sort((a, b) => a - b);
  const thr = sign > 0 ? nulls[Math.floor(nulls.length * .975)] : nulls[Math.floor(nulls.length * .025)];
  const by = new Map(); pool.forEach((e, i) => (by.get(e.d) || by.set(e.d, []).get(e.d)).push(i)); const ds = [...by.values()], boots = [];
  for (let b = 0; b < 1000; b++) { const idx = []; for (let k = 0; k < ds.length; k++) idx.push(...ds[Math.floor(rnd() * ds.length)]); boots.push(spearman(idx.map(i => pool[i][key]['W' + argW]), idx.map(i => score[i]))); } boots.sort((a, b) => a - b);
  const exI = pool.map((e, i) => i).filter(i => pool[i].d < SPLIT), hoI = pool.map((e, i) => i).filter(i => pool[i].d >= SPLIT); const sp = (I) => I.length > 20 ? spearman(I.map(i => pool[i][key]['W' + argW]), I.map(i => score[i])) : NaN;
  const tot = [...pool].sort((a, b) => a[key]['W' + argW] - b[key]['W' + argW]); const third = Math.floor(tot.length / 3), lo3 = tot.slice(0, third), hi3 = tot.slice(-third); const ms = (a) => mean(a.map(e => e[sk]['q' + q]));
  console.log(`${name}: n ${out.n} | Spearman by W ${WS.map(W => `${W}m ${f(per[W], 3)}`).join(' ')} | ${sign > 0 ? 'max' : 'min'} ${f(real, 3)} at W=${argW}, null ${sign > 0 ? '97.5th' : '2.5th'} ${f(thr, 3)} ${sign > 0 ? (real > thr ? 'PASS' : 'fail') : (real < thr ? 'PASS' : 'fail')} | CI at W ${f(boots[25], 3)}..${f(boots[975], 3)} | explore ${f(sp(exI), 3)} hold-out ${f(sp(hoI), 3)} | top-third mean score ${f(ms(hi3), 3)} bottom-third ${f(ms(lo3), 3)}`);
  return { real, thr, argW, ci: [boots[25], boots[975]], ex: sp(exI), ho: sp(hoI), per }; }
const verdict = (name, lowRes, highRes, sign) => { if (!lowRes || !highRes) return; const ok1 = sign > 0 ? lowRes.real > lowRes.thr : lowRes.real < lowRes.thr, ok2 = sign > 0 ? lowRes.ci[0] > 0 : lowRes.ci[1] < 0, ok3 = Math.sign(lowRes.ex) === sign && Math.sign(lowRes.ho) === sign, ok4 = Math.sign(highRes.per[lowRes.argW]) === sign;
  console.log(`  => ${name}: (i) beats null ${ok1 ? 'PASS' : 'FAIL'} ; (ii) CI excludes 0 in predicted direction ${ok2 ? 'PASS' : 'FAIL'} ; (iii) same sign both halves ${ok3 ? 'PASS' : 'FAIL'} ; (iv) mirror frame same sign ${ok4 ? 'PASS' : 'FAIL'} => ${ok1 && ok2 && ok3 && ok4 ? 'SUPPORTED' : 'NOT SHOWN'}`); };
const RL = evs.filter(e => e.arm === 'RTH' && e.sgn > 0), RH = evs.filter(e => e.arm === 'RTH' && e.sgn < 0), GL = evs.filter(e => e.arm === 'GLX');
console.log('\n=== P1 (turn): Spearman(sellers-absorbed score at the reclaim, race score from the reclaim), long frame RTH; predicted > 0 ===');
const p1l = analyze('P1 RTH lows (primary)', RL.filter(e => e.tr >= 0), 'p1', 's1', 1, +1), p1h = analyze('P1 RTH highs (mirror)', RH.filter(e => e.tr >= 0), 'p1', 's1', 1, +1); verdict('P1', p1l, p1h, +1);
for (const q of ['05', '2']) { const qq = q === '05' ? 0.5 : 2; analyze(`  P1 RTH lows q=${qq}`, RL.filter(e => e.tr >= 0), 'p1', 's1', q === '05' ? '05' : 2, +1); }
console.log('\n=== P2 (step aside): Spearman(buyers-stuffed score into the level, race score from the penetration bar), long frame RTH; predicted < 0 ===');
const p2l = analyze('P2 RTH lows (primary)', RL, 'p2', 's2', 1, -1), p2h = analyze('P2 RTH highs (mirror)', RH, 'p2', 's2', 1, -1); verdict('P2', p2l, p2h, -1);
console.log('\n--- Globex arm (exploratory) ---'); analyze('P1 Globex (both frames)', GL.filter(e => e.tr >= 0), 'p1', 's1', 1, +1); analyze('P2 Globex (both frames)', GL, 'p2', 's2', 1, -1);
// ---- worked illustration: 2026-10-20 (the user's example, outside the test sample)
console.log('\n=== Worked illustration 2026-10-20 (long frame; ABS_against = aggressive-sell effort absorbed with price holding/up, ABS_with = aggressive-buy effort stuffed with price down; ranks 0-1 vs the previous 60 sessions at the same clock time) ===');
for (const t of ['09:40', '09:42', '09:44', '09:45', '09:46', '09:48', '09:50']) { const e = idxOf.get(`2026-10-20 ${t}:00`); if (e == null) continue; const row = WS.map(W => { const ft = feats(e, 1, W); return ft ? `${W}m against ${ft.absAgainst.toFixed(2)} with ${ft.absWith.toFixed(2)} (sell ${ft.raw.sell}, buy ${ft.raw.buy}, price ${ft.raw.res >= 0 ? '+' : ''}${ft.raw.res})` : `${W}m n/a`; }).join(' | '); console.log(`${t}  close ${C[e]}  ${row}`); }
process.exit(0);
