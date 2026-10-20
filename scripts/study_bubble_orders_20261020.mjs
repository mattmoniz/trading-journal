// study_bubble_orders_20261020.mjs -- runs Addendum D of docs/BUBBLE_ABSORPTION_PREREG_20261020.md (committed 15cf045 before any outcome).
// Delta Dynamics Big Trades orders (same-side prints merged within 1 ms, user minimum 70) trapped under/over price at a sweep: P1c trapped opponents at the turn (+), P2c our-side trapped into the level (-), P3c big-order imbalance at the turn (+). RTH only. Research only.
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex, mean, sum, f, lb, addDay } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
const FROM = '2023-03-06', TO = '2026-10-16', LOADTO = '2026-10-20', SPLIT = '2025-06-01', WS = [3, 10, 30], NPAST = 60;
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const D = await loadBars(FROM, LOADTO), S = sessionIndex(D); const { H, L, C, TS } = D;
const idxOf = new Map(); for (let i = 0; i < TS.length; i++) idxOf.set(TS[i], i);
const BV = new Float64Array(TS.length), AV = new Float64Array(TS.length);
{ const r = await query(`SELECT ts::text ts, bid_volume::float b, ask_volume::float a FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - 200 AND ts < $2::date + 3 ORDER BY ts`, [FROM, LOADTO]); for (const x of r.rows) { const i = idxOf.get(x.ts); if (i != null) { BV[i] = x.b; AV[i] = x.a; } } }

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
// ---- Big Trades orders per session (scratch/orders_20261020/*.tsv from tick_microstructure/extract_cells_20261020.py): ORDERS[date] = [{s:'B'|'S', sec, v, p}] sorted by time
const ORDERS = new Map(); for (const fn of fs.readdirSync('scratch/orders_20261020')) { if (!fn.endsWith('.tsv')) continue; const d = fn.slice(0, 10), arr = []; for (const line of fs.readFileSync('scratch/orders_20261020/' + fn, 'utf8').split('\n')) { if (!line) continue; const [s, sec, v, p] = line.split('\t'); arr.push({ s, sec: +sec, v: +v, p: +p }); } arr.sort((a, b) => a.sec - b.sec); ORDERS.set(d, arr); }
console.log(`order files loaded ${ORDERS.size}`);
function pastIdx(e) { const t = TS[e], day = t.slice(0, 10), clock = t.slice(10), out = []; for (let k = 1; k <= 200 && out.length < NPAST; k++) { const j = idxOf.get(addDay(day, -k) + clock); if (j != null && ORDERS.has(addDay(day, -k))) out.push(j); } return out; }
const lbSec = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].sec < x) lo = m + 1; else hi = m; } return lo; };
// orders in the W minutes ending at bar e (minute m covers [m*60,(m+1)*60) ET seconds), frame sgn. opp = trapped opponents (long: sell orders with vwap below the close; short: buy orders above); ours = our side trapped (long: buy above; short: sell below); imb = big-order imbalance in our direction. weights = volume^2 (minVol filters orders)
function trapped(e, sgn, W, minVol = 0) { const d = TS[e].slice(0, 10), arr = ORDERS.get(d); if (!arr) return null; const m = mod(e), Cc = C[e]; let opp = 0, ours = 0, B2 = 0, S2 = 0;
  for (let i = lbSec(arr, (m - W + 1) * 60); i < arr.length && arr[i].sec < (m + 1) * 60; i++) { const o = arr[i]; if (o.v < minVol) continue; const w = o.v * o.v, isB = o.s === 'B'; if (isB) B2 += w; else S2 += w;
    if (sgn > 0) { if (!isB && o.p < Cc) opp += w; if (isB && o.p > Cc) ours += w; } else { if (isB && o.p > Cc) opp += w; if (!isB && o.p < Cc) ours += w; } }
  const tot = B2 + S2; return { opp, ours, imb: tot ? sgn * (B2 - S2) / tot : 0 }; }
function feats(e, sgn, W, minVol = 0) { if (W > mod(e) - 569) return null; const cur = trapped(e, sgn, W, minVol); if (!cur) return null; const past = pastIdx(e).filter(j => mod(j) - 569 >= W); if (past.length < 30) return null; const pv = past.map(j => trapped(j, sgn, W, minVol)).filter(Boolean); if (pv.length < 30) return null;
  const rk = (x, arr) => arr.filter(v => v <= x).length / arr.length; return { opp: rk(cur.opp, pv.map(p => p.opp)), ours: rk(cur.ours, pv.map(p => p.ours)), imb: rk(cur.imb, pv.map(p => p.imb)) }; }
const R30 = (e) => { let hi = -Infinity, lo = Infinity; for (let i = e - 29; i <= e; i++) { if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i]; } return hi - lo; };
function race(e, sgn, end, q) { const E = C[e], r = q * R30(e); for (let j = e + 1; j < end; j++) { const up = sgn > 0 ? H[j] >= E + r : L[j] <= E - r, dn = sgn > 0 ? L[j] <= E - r : H[j] >= E + r; if (up && dn) return 0; if (up) return 1; if (dn) return -1; } return 0; }
// ---- build events
const evs = []; for (const s of sess) for (const arm of ['RTH']) for (const lvl of Object.keys(s.arms[arm].levels)) for (const sgn of [1, -1]) { const e = detect(s, arm, s.arms[arm].levels[lvl][sgn > 0 ? 0 : 1], sgn, s.arms[arm].levels[lvl][2]); if (!e || e.i0 < 40) continue; e.lvl = lvl; e.month = s.d.slice(0, 7);
  e.p2 = {}; e.p2m = {}; for (const W of WS) { const ft = feats(e.i0, sgn, W); if (ft) e.p2['W' + W] = ft.ours; const fm = feats(e.i0, sgn, W, 70); if (fm) e.p2m['W' + W] = fm.ours; } e.s2 = { q1: race(e.i0, sgn, e.end, 1), q05: race(e.i0, sgn, e.end, .5), q2: race(e.i0, sgn, e.end, 2) };
  if (e.tr >= 0) { e.p1 = {}; e.p3 = {}; e.p1m = {}; e.p3m = {}; for (const W of WS) { const ft = feats(e.tr, sgn, W); if (ft) { e.p1['W' + W] = ft.opp; e.p3['W' + W] = ft.imb; } const fm = feats(e.tr, sgn, W, 70); if (fm) { e.p1m['W' + W] = fm.opp; e.p3m['W' + W] = fm.imb; } } e.s1 = { q1: race(e.tr, sgn, e.end, 1), q05: race(e.tr, sgn, e.end, .5), q2: race(e.tr, sgn, e.end, 2) }; } evs.push(e); }
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
  const thr = sign > 0 ? nulls[Math.floor(nulls.length * .9833)] : nulls[Math.floor(nulls.length * .0167)];
  const by = new Map(); pool.forEach((e, i) => (by.get(e.d) || by.set(e.d, []).get(e.d)).push(i)); const ds = [...by.values()], boots = [];
  for (let b = 0; b < 1000; b++) { const idx = []; for (let k = 0; k < ds.length; k++) idx.push(...ds[Math.floor(rnd() * ds.length)]); boots.push(spearman(idx.map(i => pool[i][key]['W' + argW]), idx.map(i => score[i]))); } boots.sort((a, b) => a - b);
  const exI = pool.map((e, i) => i).filter(i => pool[i].d < SPLIT), hoI = pool.map((e, i) => i).filter(i => pool[i].d >= SPLIT); const sp = (I) => I.length > 20 ? spearman(I.map(i => pool[i][key]['W' + argW]), I.map(i => score[i])) : NaN;
  const tot = [...pool].sort((a, b) => a[key]['W' + argW] - b[key]['W' + argW]); const third = Math.floor(tot.length / 3), lo3 = tot.slice(0, third), hi3 = tot.slice(-third); const ms = (a) => mean(a.map(e => e[sk]['q' + q]));
  console.log(`${name}: n ${out.n} | Spearman by W ${WS.map(W => `${W}m ${f(per[W], 3)}`).join(' ')} | ${sign > 0 ? 'max' : 'min'} ${f(real, 3)} at W=${argW}, null ${sign > 0 ? '98.3th' : '1.7th'} ${f(thr, 3)} ${sign > 0 ? (real > thr ? 'PASS' : 'fail') : (real < thr ? 'PASS' : 'fail')} | CI at W ${f(boots[25], 3)}..${f(boots[975], 3)} | explore ${f(sp(exI), 3)} hold-out ${f(sp(hoI), 3)} | top-third mean score ${f(ms(hi3), 3)} bottom-third ${f(ms(lo3), 3)}`);
  return { real, thr, argW, ci: [boots[25], boots[975]], ex: sp(exI), ho: sp(hoI), per }; }
const verdict = (name, lowRes, highRes, sign) => { if (!lowRes || !highRes) return; const ok1 = sign > 0 ? lowRes.real > lowRes.thr : lowRes.real < lowRes.thr, ok2 = sign > 0 ? lowRes.ci[0] > 0 : lowRes.ci[1] < 0, ok3 = Math.sign(lowRes.ex) === sign && Math.sign(lowRes.ho) === sign, ok4 = Math.sign(highRes.per[lowRes.argW]) === sign;
  console.log(`  => ${name}: (i) beats null ${ok1 ? 'PASS' : 'FAIL'} ; (ii) CI excludes 0 in predicted direction ${ok2 ? 'PASS' : 'FAIL'} ; (iii) same sign both halves ${ok3 ? 'PASS' : 'FAIL'} ; (iv) mirror frame same sign ${ok4 ? 'PASS' : 'FAIL'} => ${ok1 && ok2 && ok3 && ok4 ? 'SUPPORTED' : 'NOT SHOWN'}`); };
const RL = evs.filter(e => e.arm === 'RTH' && e.sgn > 0), RH = evs.filter(e => e.arm === 'RTH' && e.sgn < 0);
const rec = (e) => e.tr >= 0;
console.log('\n=== P1c (turn): trapped opponent orders under price at the reclaim, predicted + ===');
const a1 = analyze('P1c RTH lows (primary)', RL.filter(rec), 'p1', 's1', 1, +1), a1h = analyze('P1c RTH highs (mirror)', RH.filter(rec), 'p1', 's1', 1, +1); verdict('P1c', a1, a1h, +1);
console.log('\n=== P2c (step aside): our-side trapped orders into the level (first-penetration bar), predicted - ===');
const a2 = analyze('P2c RTH lows (primary)', RL, 'p2', 's2', 1, -1), a2h = analyze('P2c RTH highs (mirror)', RH, 'p2', 's2', 1, -1); verdict('P2c', a2, a2h, -1);
console.log('\n=== P3c (turn): big-order imbalance in our direction at the reclaim, predicted + ===');
const a3 = analyze('P3c RTH lows (primary)', RL.filter(rec), 'p3', 's1', 1, +1), a3h = analyze('P3c RTH highs (mirror)', RH.filter(rec), 'p3', 's1', 1, +1); verdict('P3c', a3, a3h, +1);
console.log('\n--- sensitivity: only orders >= 70 (the user setting), same statistics ---');
analyze('P1c >=70 lows', RL.filter(rec), 'p1m', 's1', 1, +1); analyze('P2c >=70 lows', RL, 'p2m', 's2', 1, -1); analyze('P3c >=70 lows', RL.filter(rec), 'p3m', 's1', 1, +1);
console.log('--- q sensitivity (primary features) ---'); for (const q of ['05', 2]) { analyze(`P1c q=${q}`, RL.filter(rec), 'p1', 's1', q, +1); analyze(`P2c q=${q}`, RL, 'p2', 's2', q, -1); analyze(`P3c q=${q}`, RL.filter(rec), 'p3', 's1', q, +1); }
console.log('\n=== EXPLORATORY (not pre-registered): P2c as a GATE. Both frames pooled (each frame in its own direction); top third vs bottom third of the our-side-trapped rank; mean race score from the penetration bar; day-block CI of the difference ===');
{ const pool = [...RL, ...RH].filter(e => e.p2 && WS.every(W => e.p2['W' + W] != null)); analyze('P2c pooled frames', pool, 'p2', 's2', 1, -1);
  for (const W of WS) { const srt = [...pool].sort((a, b) => a.p2['W' + W] - b.p2['W' + W]), t = Math.floor(srt.length / 3), lo3 = srt.slice(0, t), hi3 = srt.slice(-t); const ms = (a) => mean(a.map(e => e.s2.q1)); const dayMap = (a) => { const m = new Map(); for (const e of a) (m.get(e.d) || m.set(e.d, []).get(e.d)).push(e.s2.q1); return m; }; const gl = dayMap(lo3), gh = dayMap(hi3), days = [...new Set([...gl.keys(), ...gh.keys()])], o = [];
    for (let b = 0; b < 2000; b++) { let sl = 0, cl = 0, sh = 0, ch = 0; for (let k = 0; k < days.length; k++) { const d = days[Math.floor(rnd() * days.length)]; for (const x of gl.get(d) || []) { sl += x; cl++; } for (const x of gh.get(d) || []) { sh += x; ch++; } } if (cl && ch) o.push(sh / ch - sl / cl); } o.sort((a, b) => a - b);
    const half = (arr, fn) => mean(arr.filter(fn).map(e => e.s2.q1)); const ex = (e) => e.d < SPLIT;
    console.log(`W=${W}m: n ${pool.length} | top-third (our side trapped) mean score ${f(ms(hi3), 3)} (n ${hi3.length}) vs bottom third ${f(ms(lo3), 3)} (n ${lo3.length}) | diff ${f(ms(hi3) - ms(lo3), 3)} CI [${f(o[50], 3)},${f(o[1950], 3)}] | explore diff ${f(half(hi3, ex) - half(lo3, ex), 3)} hold-out diff ${f(half(hi3, e => !ex(e)) - half(lo3, e => !ex(e)), 3)}`); } }
process.exit(0);
