// study_rotation_gate_scale_regime_20261020.mjs -- runs docs/ROTATION_GATE_SCALE_REGIME_PREREG_20261020.md (committed 0c5739a before any scale/regime result).
// Stage 1 (EXPLORE, trade dates < 2025-01-01): for each regime cell (VOL tercile x DRIVING/BALANCED) and each rotation scale k (R = k x ATR20), AGREE-minus-DISAGREE; mechanical choice of k per cell (or OFF).
// Stage 2 (HOLD-OUT, >= 2025-01-01): the adaptive gate exactly as chosen, vs ALL, vs the fixed-65 gate. The hold-out is not printed before the selection is printed.
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex, mean, sum, f, lb, addDay, rnd } from './lib/pocJoinLoader.mjs';
import { detectRotationLegs } from '../server/services/rotationDetector.js';
const FROM = '2023-03-06', TO = '2026-10-16', HOLD = '2025-01-01', PROX = 15, KS = [0.10, 0.15, 0.20, 0.30, 0.45];
const GATE = { OR5: 575, OR10: 580, OR15: 585, OR30: 600, IB: 630 }; const formGate = (n) => { for (const k of Object.keys(GATE)) if (n.startsWith(k + '_')) return GATE[k]; return 575; };
const D = await loadBars(FROM, TO), S = sessionIndex(D);
const opt = new Map((await query(`SELECT DISTINCT ON (signal_name) signal_name, ROUND(COALESCE(optimal_stop,p75_mae))::int stp, ROUND(COALESCE(optimal_target,p50_mfe))::int tgt FROM performance_audit WHERE signal_type='OPTIMAL_STOP' ORDER BY signal_name, run_date DESC, id DESC`)).rows.filter(r => r.stp > 0 && r.tgt > 0).map(r => [r.signal_name, r]));
const LV = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND price IS NOT NULL AND level_name <> 'RTH_VWAP'`, [FROM, TO])).rows) (LV.get(r.d) || LV.set(r.d, []).get(r.d)).push(r);
const mod = (gi) => +D.TS[gi].slice(11, 13) * 60 + +D.TS[gi].slice(14, 16);
function simTrade(gi, endIdx, long, entry, stp, tgt) { const { O, H, L, C } = D, stopP = long ? entry - stp : entry + stp, tgtP = long ? entry + tgt : entry - tgt;
  for (let k = gi + 1; k <= endIdx; k++) { if (long ? L[k] <= stopP : H[k] >= stopP) { const fill = long ? Math.min(stopP, O[k]) : Math.max(stopP, O[k]); return (long ? fill - entry : entry - fill) * 2 - 2; }
    if (long ? H[k] >= tgtP : L[k] <= tgtP) { const fill = long ? Math.max(tgtP, O[k]) : Math.min(tgtP, O[k]); return (long ? fill - entry : entry - fill) * 2 - 2; } }
  return (long ? D.C[endIdx] - entry : entry - D.C[endIdx]) * 2 - 2; }
const legCache = new Map(); function legsOf(d, R) { const key = d + '|' + R; if (legCache.has(key)) return legCache.get(key); const a = lb(D.TS, addDay(d, -1) + ' 18:00:00'), b = lb(D.TS, d + ' 17:00:00'); const bars = []; for (let i = a; i < b; i++) bars.push({ high: D.H[i], low: D.L[i] }); const out = { a, legs: bars.length ? detectRotationLegs(bars, R) : [] }; legCache.set(key, out); return out; }
const rotDir = (d, R, gi) => { const { a, legs } = legsOf(d, R); let dir = null; for (const l of legs) { if (a + l.idx <= gi) dir = l.dir; else break; } return dir; };
// regime machinery (point-in-time)
const atrDate = new Map(S.dates.map(d => [d, S.atr20(d)])); const devCache = new Map();
function devRatio(d, off) { let arr = devCache.get(d); if (!arr) { const [a, b] = S.rth.get(d), A = atrDate.get(d); arr = []; let hi = -Infinity, lo = Infinity; for (let i = a; i < b; i++) { hi = Math.max(hi, D.H[i]); lo = Math.min(lo, D.L[i]); arr.push(A ? (hi - lo) / A : null); } devCache.set(d, arr); } return arr[off]; }
const volCut = new Map(); function volTercile(d) { let c = volCut.get(d); if (!c) { const j = lb(S.dates, d), prior = S.dates.slice(Math.max(0, j - 250), j).map(x => atrDate.get(x)).filter(x => x != null).sort((x, y) => x - y); c = prior.length >= 100 ? [prior[Math.floor(prior.length / 3)], prior[Math.floor(2 * prior.length / 3)]] : null; volCut.set(d, c); } const A = atrDate.get(d); return c && A ? (A <= c[0] ? 'LOW' : A <= c[1] ? 'MID' : 'HIGH') : null; }
const drvCut = new Map(); function driving(d, off) { const key = d + '|' + off; let q = drvCut.get(key); if (q === undefined) { const j = lb(S.dates, d), prior = S.dates.slice(Math.max(0, j - 60), j), v = prior.map(p => devRatio(p, off)).filter(x => x != null).sort((x, y) => x - y); q = v.length >= 40 ? v[Math.floor(0.67 * (v.length - 1))] : null; drvCut.set(key, q); } const r = devRatio(d, off); return q != null && r != null ? r >= q : null; }
const T = []; let skipped = 0;
for (let di = 0; di < S.dates.length; di++) { const d = S.dates[di]; if (d < FROM || d > TO) continue; const atr = atrDate.get(d), L = LV.get(d); if (!atr || !L) continue; const [a, b] = S.rth.get(d); const prev = S.dates[di - 1], pdc = L.find(x => x.n === 'PD_CLOSE');
  if (pdc && prev && Math.abs(pdc.p - D.C[S.rth.get(prev)[1] - 1]) > 0.1 * atr) { skipped++; continue; } const vt = volTercile(d); if (!vt) continue; const pdh = L.find(x => x.n === 'PD_HIGH')?.p, pdl = L.find(x => x.n === 'PD_LOW')?.p;
  for (const lev of L) { if (!opt.has(lev.n + '_FADE_LONG') && !opt.has(lev.n + '_FADE_SHORT')) continue; const g = formGate(lev.n);
    for (let gi = a + 5; gi < b; gi++) { if (mod(gi) < Math.max(575, g)) continue; if (Math.abs(D.C[gi] - lev.p) > PROX) continue;
      const long = !(D.C[gi - 5] < D.C[gi]), type = `${lev.n}_FADE_${long ? 'LONG' : 'SHORT'}`, o = opt.get(type); if (!o) break; const entry = D.C[gi], drv = driving(d, gi - a); if (drv == null) break;
      const tag = {}; for (const k of KS) { const dr = rotDir(d, k * atr, gi); tag['k' + k] = dr == null ? null : (dr === 'UP') === long; } const d65 = rotDir(d, 65, gi); tag.fixed65 = d65 == null ? null : (d65 === 'UP') === long;
      T.push({ d, long, pnl: simTrade(gi, b - 1, long, entry, o.stp, o.tgt), plc: simTrade(gi, b - 1, !long, entry, o.stp, o.tgt), vt, drv, cell: vt + (drv ? '_DRIVING' : '_BALANCED'), pdx: !!((pdh != null && D.C[gi] > pdh) || (pdl != null && D.C[gi] < pdl)), tag, yr: d.slice(0, 4), half: d < HOLD ? 'EXPLORE' : 'HOLDOUT' }); break; } } }
console.log(`touches ${T.length} (explore ${T.filter(t => t.half === 'EXPLORE').length}, hold-out ${T.filter(t => t.half === 'HOLDOUT').length}); roll days skipped ${skipped}`);
function boot(arr, stat, n = 1000) { const by = new Map(); for (const r of arr) (by.get(r.d) || by.set(r.d, []).get(r.d)).push(r); const ds = [...by.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(...ds[(rnd() * ds.length) | 0]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((x, y) => x - y); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const adStat = (key) => (p) => mean(p.filter(t => t.tag[key] === true).map(t => t.pnl)) - mean(p.filter(t => t.tag[key] === false).map(t => t.pnl));
const EX = T.filter(t => t.half === 'EXPLORE'), HO = T.filter(t => t.half === 'HOLDOUT'), CELLS = ['LOW', 'MID', 'HIGH'].flatMap(v => [v + '_BALANCED', v + '_DRIVING']);
console.log('\n=== STAGE 1: EXPLORE half -- AGREE minus DISAGREE per trade by regime cell and scale k (R = k x ATR20; fixed-65 shown for reference). N = AGREE/DISAGREE. ===');
console.log('cell'.padEnd(14), ['fixed65', ...KS.map(k => 'k=' + k)].map(s => s.padStart(20)).join(''));
const choice = {}; for (const cell of CELLS) { const sub = EX.filter(t => t.cell === cell); const cols = []; let best = null;
  for (const key of ['fixed65', ...KS.map(k => 'k' + k)]) { const a = sub.filter(t => t.tag[key] === true), g = sub.filter(t => t.tag[key] === false); const d = a.length && g.length ? mean(a.map(t => t.pnl)) - mean(g.map(t => t.pnl)) : NaN; cols.push((f(d, 1) + ` (${a.length}/${g.length})`).padStart(20)); if (key !== 'fixed65' && a.length >= 300 && g.length >= 300 && d > 0 && (!best || d > best.d)) best = { key, d }; }
  choice[cell] = best ? best.key : 'OFF'; console.log(cell.padEnd(14), cols.join('')); }
const pooled = KS.map(k => { const a = EX.filter(t => t.tag['k' + k] === true), g = EX.filter(t => t.tag['k' + k] === false); return { key: 'k' + k, d: mean(a.map(t => t.pnl)) - mean(g.map(t => t.pnl)) }; }).sort((x, y) => y.d - x.d); const single = pooled[0].key;
console.log('pooled explore AGREE-DISAGREE by k:', pooled.map(p => p.key + ' ' + f(p.d, 1)).join(' | ')); console.log('\nCHOSEN per cell (mechanical):', JSON.stringify(choice), '| best single k pooled:', single);
fs.writeFileSync('scratch/rotation_gate_scale_regime_touches_20261020.json', JSON.stringify(T.map(t => ({ d: t.d, long: t.long, pnl: t.pnl, plc: t.plc, vt: t.vt, drv: t.drv, pdx: t.pdx, tag: t.tag, yr: t.yr, half: t.half }))));
fs.writeFileSync('scratch/rotation_gate_scale_regime_choice_20261020.json', JSON.stringify({ choice, single }));
// ---- STAGE 2
const adaptKeep = (t) => { const c = choice[t.cell]; return c === 'OFF' ? true : t.tag[c] === true; }, singleKeep = (t) => t.tag[single] === true, fixedKeep = (t) => t.tag.fixed65 === true;
const keptStat = (keep) => (p) => mean(p.filter(keep).map(t => t.pnl)) - mean(p.map(t => t.pnl));
console.log('\n=== STAGE 2: HOLD-OUT (2025-01-01..2026-10-16) ==='); const allM = mean(HO.map(t => t.pnl));
const rep = (label, keep, pop = HO) => { const K = pop.filter(keep), [lo, hi] = boot(pop, keptStat(keep), 1000); console.log(`${label.padEnd(26)} kept ${String(K.length).padStart(5)} of ${String(pop.length).padStart(5)} | kept mean ${f(mean(K.map(t => t.pnl)), 2).padStart(7)} vs ALL ${f(mean(pop.map(t => t.pnl)), 2)} | kept-minus-ALL ${f(mean(K.map(t => t.pnl)) - mean(pop.map(t => t.pnl)), 2)} [${f(lo, 1)},${f(hi, 1)}] | flipped(kept) ${f(mean(K.map(t => t.plc)), 2)}`); return { n: K.length, m: mean(K.map(t => t.pnl)), diff: mean(K.map(t => t.pnl)) - mean(pop.map(t => t.pnl)), lo, hi, flip: mean(K.map(t => t.plc)), tot: sum(K.map(t => t.pnl)), top5: sum([...K].sort((x, y) => y.pnl - x.pnl).slice(0, 5).map(t => t.pnl)) }; };
const AD = rep('ADAPTIVE (cell-chosen k)', adaptKeep), SG = rep('single scaled gate ' + single, singleKeep), FX = rep('fixed 65 (AGREE-only)', fixedKeep); const A25 = rep('adaptive 2025', adaptKeep, HO.filter(t => t.yr === '2025')), A26 = rep('adaptive 2026', adaptKeep, HO.filter(t => t.yr === '2026'));
rep('no gate (reference)', () => true);
// paired difference adaptive vs fixed65 (kept-minus-all)
const pairStat = (p) => keptStat(adaptKeep)(p) - keptStat(fixedKeep)(p); const [plo, phi] = boot(HO, pairStat, 1000);
// placebo: random keep of the same size within cell x direction
const cellDir = new Map(); HO.forEach((t, i) => { const k = t.cell + (t.long ? 'L' : 'S'); (cellDir.get(k) || cellDir.set(k, []).get(k)).push(i); }); const keepIdx = HO.map(adaptKeep); let ge = 0; const NP = 1500;
for (let p = 0; p < NP; p++) { let s = 0, n = 0; for (const idx of cellDir.values()) { const nk = idx.filter(i => keepIdx[i]).length; if (!nk) continue; const arr = [...idx]; for (let i = arr.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [arr[i], arr[j]] = [arr[j], arr[i]]; } for (let i = 0; i < nk; i++) { s += HO[arr[i]].pnl; n++; } } if (s / n >= AD.m) ge++; }
const pplc = ge / NP; console.log(`adaptive minus fixed65 (kept-minus-ALL) paired CI [${f(plo, 1)},${f(phi, 1)}]; random-keep placebo p ${pplc.toFixed(4)}`);
const byCell = CELLS.map(c => { const sub = HO.filter(t => t.cell === c), K = sub.filter(adaptKeep); return `${c} ${choice[c]} kept ${K.length}/${sub.length} ${f(mean(K.map(t => t.pnl)), 1)} vs all ${f(mean(sub.map(t => t.pnl)), 1)}`; }); console.log('\nby cell (hold-out, informational):\n  ' + byCell.join('\n  '));
const pdxA = HO.filter(t => t.pdx), pdxB = HO.filter(t => !t.pdx); console.log(`\ninformational: fixed65 AGREE-DISAGREE hold-out when price is BEYOND PDH/PDL ${f(adStat('fixed65')(pdxA), 1)} (n ${pdxA.length}) vs inside ${f(adStat('fixed65')(pdxB), 1)} (n ${pdxB.length})`);
const P = (ok, t) => console.log((ok ? 'PASS ' : 'FAIL ') + t); console.log('\n=== PRE-REGISTERED CRITERIA (hold-out) ===');
P(AD.n >= 1500, `1. N kept ${AD.n}`); P(AD.diff > 0 && AD.lo > 0 && A25.diff > 0 && A26.diff > 0, `2. adaptive kept-minus-ALL ${f(AD.diff, 2)} [${f(AD.lo, 1)},${f(AD.hi, 1)}], 2025 ${f(A25.diff, 2)}, 2026 ${f(A26.diff, 2)}`);
P(AD.diff > FX.diff && plo > 0, `3. beats fixed-65 (${f(AD.diff, 2)} vs ${f(FX.diff, 2)}), paired CI [${f(plo, 1)},${f(phi, 1)}]`); P(pplc <= 0.05, `4. random-keep placebo p ${pplc.toFixed(4)}`); P(AD.m > AD.flip && A25.m > A25.flip && A26.m > A26.flip, `5. beats flipped placebo overall/2025/2026`);
P(AD.tot > 0 && AD.top5 / AD.tot < 0.5, `6. total ${f(AD.tot, 0)}, top-5 share ${AD.tot > 0 ? (100 * AD.top5 / AD.tot).toFixed(0) + '%' : 'non-positive'}`); console.log(`informational: adaptive KEPT mean ${f(AD.m, 2)} (above zero? ${AD.m > 0})`); process.exit(0);
