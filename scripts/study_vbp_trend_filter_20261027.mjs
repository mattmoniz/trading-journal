// RUN: docs/VBP_TREND_FILTER_PREREG_20261027.md (committed before this ran). Prints Tables 1-5 plus the audit layer (4a, 4b, placebo).
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { loadBars, prep, indexBars, emOf, SPARSE } from './lib/floorEngine.mjs';
import { FEATS, GROUP1, GROUP2, VETO_HI, features, regression, mean, quant, mannWhitneyP, perf } from './lib/vbpTrendFilter.mjs';
const LEVEL_MODE = process.env.LEVEL_MODE || 'level'; // 'level' = pre-registered (L = structural_level_touched); 'entry' = POST-HOC sensitivity (L = the fade's entry price)
const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d)), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : 'n/a'), usd = (x) => (Number.isFinite(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(0) : 'n/a');
const md = (h, rows) => { console.log('| ' + h.join(' | ') + ' |'); console.log('|' + h.map(() => '---').join('|') + '|'); for (const r of rows) console.log('| ' + r.join(' | ') + ' |'); };
const hdr = (s) => console.log('\n### ' + s + '\n');
// ---------------------------------------------------------------- load
const REAL_FLAGS = `ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE`;
const raw = (await query(`SELECT id, setup_type, trade_date::text td, fired_at::text fa, entry_zone_low::float entry, stop_level::float stop, t1_level::float t1, structural_level_touched::float lvl, mfe_points::float mfe, actual_pnl::float pnl, resolution
  FROM active_setups WHERE origin_status='BACKFILL' AND is_rth AND setup_type LIKE '%FADE%' AND setup_type NOT LIKE '%OVERNIGHT%' AND structural_level_touched IS NOT NULL AND (is_cluster_primary IS NULL OR is_cluster_primary)
   AND ${REAL_FLAGS} AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL AND fired_at::time >= '09:35' AND fired_at::time < '16:00' ORDER BY fired_at, id`)).rows;
const minTd = raw[0].td, maxTd = raw[raw.length - 1].td;
const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, minTd.slice(0, 8) + '01', maxTd)));
const sessStart = new Map(), sessEnd = new Map();
for (let i = 0; i < NQ.n; i++) { const c = +NQ.T[i].slice(11, 13) * 60 + +NQ.T[i].slice(14, 16); if (NQ.T[i].slice(0, 10) !== NQ.TD[i]) continue; if (c >= 570 && c < 960) { if (!sessStart.has(NQ.TD[i])) sessStart.set(NQ.TD[i], i); sessEnd.set(NQ.TD[i], i); } }
const drop = { roll: 0, sparse: 0, noDir: 0, noBar: 0, entryMismatch: 0, gap: 0, noFeat: 0 }; const T = [];
for (const r of raw) {
  if (isInsideNqRollWeek(r.td)) { drop.roll++; continue; } if (SPARSE(r.td)) { drop.sparse++; continue; }
  const dir = resolveDirection({ setup_type: r.setup_type, stop_level: r.stop, t1_level: r.t1 }); if (!dir) { drop.noDir++; continue; } const tradeDir = dir === 'LONG' ? 1 : -1;
  const t = NQ.byEm.get(emOf(r.fa.slice(0, 16) + ':00')), s = sessStart.get(r.td); if (t === undefined || s === undefined) { drop.noBar++; continue; }
  if (NQ.EM[t] - NQ.EM[s] !== t - s) { drop.gap++; continue; }
  if (!(r.entry >= NQ.L[t] - 0.5 && r.entry <= NQ.H[t] + 0.5)) { drop.entryMismatch++; continue; }
  if (LEVEL_MODE === 'entry') r.lvl = r.entry; const F = features(NQ, s, t, r.lvl, tradeDir); if (!F) { drop.noFeat++; continue; }
  const stopDist = Math.abs(r.entry - r.stop), bucket = r.pnl > 0 ? 'A' : r.resolution !== 'STOP_HIT' ? 'FLAT' : r.mfe >= 0.5 * stopDist ? 'B' : 'C';
  T.push({ ...r, t, s, tradeDir, F, stopDist, bucket, clk: +r.fa.slice(11, 13) * 60 + +r.fa.slice(14, 16) });
}
console.log(`# VbP + kinematics veto filter -- run output (population: BACKFILL RTH level fades; strategy SIMULATION, not an account record)`);
console.log(`raw rows ${raw.length}; dropped ${JSON.stringify(drop)}; trades used ${T.length} on ${new Set(T.map((x) => x.td)).size} dates ${T[0].td}..${T[T.length - 1].td}`);
const bc = (b) => T.filter((x) => x.bucket === b); console.log(`buckets: A ${bc('A').length}, B ${bc('B').length}, C ${bc('C').length}, FLAT(time-expired, pnl 0) ${bc('FLAT').length}; baseline net ${usd(perf(T.map((x) => x.pnl)).net)}`);
{ const g = T.map((x) => Math.abs(x.entry - x.lvl) / x.F.ATR), pf = (fn) => pc(T.filter(fn).length / T.length);
  console.log(`LEVEL_MODE=${LEVEL_MODE}. Degeneracy diagnostics: |entry - L| / ATR median ${f2(quant(g, .5))}, p75 ${f2(quant(g, .75))}; Taper ratio exactly 1.000 (no volume in either slice) ${pf((x) => x.F.Approach_Vol_Taper_Ratio === 1)}; Doorstep density < 0.001 ${pf((x) => x.F.Doorstep_HVN_Density < 0.001)}; RVWAP spread exactly 0 (30- and 60-bar windows identical, before ~10:00) ${pf((x) => x.F.RVWAP_Spread_Against === 0)}; dPOC migration exactly 0 ${pf((x) => x.F.dPOC_Migration_30 === 0)}`); }
const vals = (rows, f) => rows.map((x) => x.F[f]).filter(Number.isFinite);
// ---------------------------------------------------------------- TABLE 1
hdr('Table 1 -- Feature distribution matrix (25th / median / 75th / mean) by bucket, Mann-Whitney A vs C (descriptive: trades are correlated within days)');
const A = bc('A'), B = bc('B'), C = bc('C');
md(['Feature', 'A p25', 'A med', 'A p75', 'A mean', 'B p25', 'B med', 'B p75', 'B mean', 'C p25', 'C med', 'C p75', 'C mean', 'med(A)-med(C)', 'MWU p (A vs C)'],
  FEATS.map((f) => { const row = [f]; for (const X of [A, B, C]) { const v = vals(X, f); row.push(f2(quant(v, .25), 3), f2(quant(v, .5), 3), f2(quant(v, .75), 3), f2(mean(v), 3)); } row.push(f2(quant(vals(A, f), .5) - quant(vals(C, f), .5), 3), (() => { const p = mannWhitneyP(vals(A, f), vals(C, f)); return Number.isFinite(p) ? (p < 1e-4 ? '<1e-4' : p.toFixed(4)) : 'n/a'; })()); return row; }));
console.log(`(valid counts: dPOC_Migration_30 A ${vals(A, FEATS[0]).length}/${A.length}, C ${vals(C, FEATS[0]).length}/${C.length}; the others are defined for all trades)`);
// ---------------------------------------------------------------- TABLE 2
hdr('Table 2 -- Time-of-day steamroll breakdown');
const wins = [['09:30-10:30', 570, 630], ['10:30-13:30', 630, 810], ['13:30-16:00', 810, 960]];
md(['Window', 'Trades', 'A (winners)', 'A %', 'C (steamrolls)', 'C %', 'Baseline PF'], wins.map(([nm, a, b]) => { const X = T.filter((x) => x.clk >= a && x.clk < b), p = perf(X.map((x) => x.pnl)); return [nm, X.length, X.filter((x) => x.bucket === 'A').length, pc(X.filter((x) => x.bucket === 'A').length / X.length), X.filter((x) => x.bucket === 'C').length, pc(X.filter((x) => x.bucket === 'C').length / X.length), f2(p.pf)]; }));
// ---------------------------------------------------------------- fitting machinery
const dates = [...new Set(T.map((x) => x.td))].sort(), cutDate = dates[Math.floor(0.6 * dates.length) - 1];
function sweepOne(rows, f, maxKill = 0.15) { // closed form: the most aggressive cutoff that keeps the A-kill share <= maxKill
  const a = vals(rows.filter((x) => x.bucket === 'A'), f).sort((x, y) => x - y), c = vals(rows.filter((x) => x.bucket === 'C'), f); const hi = VETO_HI[f]; if (a.length < 20 || c.length < 20) return null;
  const k = Math.floor(maxKill * a.length); const cut = hi ? a[a.length - 1 - k] : a[k]; // veto x > cut (hi) or x < cut (lo): kills at most k winners (ties may kill fewer)
  const veto = (x) => (hi ? x > cut : x < cut), killA = a.filter(veto).length / a.length, blockC = c.filter(veto).length / c.length;
  return { f, cut, killA, blockC, ratio: killA > 0 ? blockC / killA : (blockC > 0 ? Infinity : NaN) };
}
const fitRules = (rows) => {
  const S75 = quant(vals(rows.filter((x) => x.bucket === 'A'), 'LRMA_Slope_Against'), .75), sw = FEATS.map((f) => sweepOne(rows, f)).filter(Boolean).sort((p, q) => (q.ratio - p.ratio) || 0);
  const g1 = sw.filter((s) => GROUP1.includes(s.f)).slice(0, 2), g2 = sw.filter((s) => GROUP2.includes(s.f)).slice(0, 1), picks = [...g1, ...g2].map((s) => s.f);
  const Aall = rows.filter((x) => x.bucket === 'A'); let share = 0.15, cuts = null;
  for (; share >= 0.005; share -= 0.01) { cuts = picks.map((f) => sweepOne(rows, f, share)); const kill = Aall.filter((x) => cuts.some((c) => c && ((VETO_HI[c.f] ? x.F[c.f] > c.cut : x.F[c.f] < c.cut)))).length / Aall.length; if (kill <= 0.20) break; }
  return { S75, sw, picks, cuts, share };
};
const flag = (x, f, fit, rule) => { const F = x.F; const g = (k) => F[k]; switch (rule) {
  case 1: return g('dPOC_Migration_30') > 0.5 || g('Doorstep_HVN_Density') > 0.30 || g('Rolling_POC_Stretch_60') < 0.35;
  case 2: return g('Approach_Vol_Taper_Ratio') > 1.25 && g('RVWAP_Spread_Against') > 0.15;
  case 3: return g('LRMA_Slope_Against') > fit.S75 && g('R_Squared_20') > 0.65 && g('LRMA_Stretch_Against') < 0.60;
  case 4: return fit.cuts.some((c) => c && (VETO_HI[c.f] ? g(c.f) > c.cut : g(c.f) < c.cut));
  case 123: return flag(x, f, fit, 1) || flag(x, f, fit, 2) || flag(x, f, fit, 3); } };
const fitAll = fitRules(T);
// ---------------------------------------------------------------- TABLE 3
hdr(`Table 3 -- Constrained single-feature sweep (cutoff that blocks the most steamrolls (C) while killing <= 15% of winners (A)); ranked by blocked%/killed%. A random feature scores about 1.0.`);
md(['Rank', 'Feature', 'Group', 'Veto when', 'Cutoff', 'Steamrolls blocked %', 'Winners sacrificed %', 'Ratio'], fitAll.sw.map((s, i) => [i + 1, s.f, GROUP1.includes(s.f) ? 'Vol-by-Price' : 'Kinematic', VETO_HI[s.f] ? '>' : '<', f2(s.cut, 3), pc(s.blockC), pc(s.killA), f2(s.ratio)]));
console.log(`S_75 (75th percentile of Bucket A LRMA_Slope_Against) = ${f2(fitAll.S75, 4)}; Rule 4 picks (top 2 Vol-by-Price + top 1 Kinematic): ${fitAll.picks.join(', ')}; per-feature A-kill share used ${pc(fitAll.share)}`);
// ---------------------------------------------------------------- TABLE 4
const ORDER = (X) => [...X].sort((p, q) => (p.fa < q.fa ? -1 : p.fa > q.fa ? 1 : p.id - q.id));
const RULES = [['0. Unfiltered Baseline', null], ['1. Rule 1 Only (Volume Profile Migration/HVN)', 1], ['2. Rule 2 Only (Approach Volume Taper)', 2], ['3. Rule 3 Only (LRMA Grind vs. Spike)', 3], ['4. Rules 1 + 2 + 3 Combined', 123], ['5. Rule 4 (Data-Driven Optimal Composite)', 4]];
const nA = A.length, nC = C.length;
function t4rows(rows, fit, nAr, nCr) { return RULES.map(([nm, r]) => { const veto = (x) => r != null && flag(x, null, fit, r); const kept = ORDER(rows.filter((x) => !veto(x))), p = perf(kept.map((x) => x.pnl)), vA = rows.filter((x) => x.bucket === 'A' && veto(x)).length, vC = rows.filter((x) => x.bucket === 'C' && veto(x)).length;
  return [nm, p.n, pc(p.wr), f2(p.pf), usd(p.net), usd(p.dd), `${usd(p.avg)} / ${f2(p.sharpe, 3)}`, `${vC} (${pc(vC / nCr)})`, `${vA} (${pc(vA / nAr)})`]; }); }
const T4H = ['Rule', 'Total Trades', 'Win Rate %', 'Profit Factor', 'Net PnL ($)', 'Max Drawdown ($)', 'Avg Trade ($) / per-trade Sharpe', 'Steamrolls Blocked', 'Winners Killed'];
hdr('Table 4 -- Backtest performance comparison (FULL SAMPLE, in-sample: S_75, Table 3 cutoffs and Rule 4 were fit on these same trades)'); md(T4H, t4rows(T, fitAll, nA, nC));
// ---------------------------------------------------------------- bootstrap + audit tables
const ITERS = 2000;
function diffCI(rows, veto, seed) { // mean(vetoed) - mean(all), date-blocked bootstrap
  const g = new Map(); for (const x of rows) (g.get(x.td) || g.set(x.td, []).get(x.td)).push([x.pnl, veto(x) ? 1 : 0]); const keys = [...g.keys()], rng = mulberry32(hashSeed(seed)), d = [];
  for (let it = 0; it < ITERS; it++) { let sa = 0, na = 0, sv = 0, nv = 0; for (let k = 0; k < keys.length; k++) for (const [p, v] of g.get(keys[Math.floor(rng() * keys.length)])) { sa += p; na++; if (v) { sv += p; nv++; } } if (nv) d.push(sv / nv - sa / na); }
  d.sort((a, b) => a - b); return { lo: d[Math.floor(0.025 * d.length)], hi: d[Math.min(d.length - 1, Math.floor(0.975 * d.length))] }; }
function placeboP(rows, veto, seed, iters = 2000) { const idx = rows.map((x, i) => (veto(x) ? i : -1)).filter((i) => i >= 0), k = idx.length; if (!k) return NaN; const obs = mean(idx.map((i) => rows[i].pnl)), rng = mulberry32(hashSeed(seed)); let le = 0; for (let it = 0; it < iters; it++) { let s = 0; for (let j = 0; j < k; j++) s += rows[Math.floor(rng() * rows.length)].pnl; if (s / k <= obs) le++; } return le / iters; }
function t4a(rows, fit, label) { hdr(`Table 4a -- Does the veto remove BELOW-average trades? (${label}) vetoed avg minus all-trade avg, date-blocked 95% interval; random-veto placebo P(random subset avg <= vetoed avg)`);
  md(['Rule', 'Vetoed n', 'Vetoed avg', 'All-trade avg', 'Diff', '95% interval of diff', 'Placebo P'], RULES.slice(1).map(([nm, r]) => { const veto = (x) => flag(x, null, fit, r), V = rows.filter(veto), all = mean(rows.map((x) => x.pnl)), c = V.length >= 10 ? diffCI(rows, veto, 'vbpTF-' + label + r) : { lo: NaN, hi: NaN }; return [nm, V.length, usd(mean(V.map((x) => x.pnl))), usd(all), usd(mean(V.map((x) => x.pnl)) - all), `[${usd(c.lo)}, ${usd(c.hi)}]`, f2(placeboP(rows, veto, 'vbpPl-' + label + r), 3)]; })); }
t4a(T, fitAll, 'FULL in-sample');
// hold-out
const train = T.filter((x) => x.td <= cutDate), test = T.filter((x) => x.td > cutDate), fitTr = fitRules(train);
hdr(`Table 4b -- HOLD-OUT: everything fitted on trade dates <= ${cutDate} (${train.length} trades), applied to the later ${test.length} trades. Rule 4 picks on train: ${fitTr.picks.join(', ')}; S_75(train) ${f2(fitTr.S75, 4)}`);
md(T4H, t4rows(test, fitTr, test.filter((x) => x.bucket === 'A').length, test.filter((x) => x.bucket === 'C').length)); t4a(test, fitTr, 'HOLD-OUT'); 
console.log('\nTrain-fitted Table 3 (for stability against the full-sample one above):'); md(['Rank', 'Feature', 'Cutoff', 'C blocked', 'A killed', 'Ratio'], fitTr.sw.map((s, i) => [i + 1, s.f, f2(s.cut, 3), pc(s.blockC), pc(s.killA), f2(s.ratio)]));
// ---------------------------------------------------------------- STEP 4 flip
const eod = (d) => sessEnd.get(d);
function simFlip(x, mode, variant) { // mode: 1, 1.5, 2 (R target) or 'trail'; variant: 'touch' | 'break'
  const d = -x.tradeDir, end = eod(x.td); let eIdx, entry; const R = x.stopDist; if (!(R > 0)) return null;
  if (variant === 'touch') { eIdx = x.t; entry = x.entry; const stop0 = entry - d * R; if (d > 0 ? NQ.L[eIdx] <= stop0 : NQ.H[eIdx] >= stop0) return { pnl: -R * 2 - 1, t: x.fa }; eIdx = x.t + 1; }
  else { let j = null; for (let k = x.t; k < Math.min(x.t + 30, end); k++) if (d > 0 ? NQ.C[k] > x.lvl : NQ.C[k] < x.lvl) { j = k; break; } if (j == null || j + 1 > end) return null; eIdx = j + 1; entry = NQ.O[eIdx]; }
  const stop = entry - d * R, tgt = mode === 'trail' ? null : entry + d * mode * R; let exit = null;
  for (let i = eIdx; i <= end; i++) {
    if (d > 0 ? NQ.O[i] <= stop : NQ.O[i] >= stop) { exit = NQ.O[i]; break; } if (d > 0 ? NQ.L[i] <= stop : NQ.H[i] >= stop) { exit = stop; break; }
    if (tgt != null) { if (d > 0 ? NQ.O[i] >= tgt : NQ.O[i] <= tgt) { exit = NQ.O[i]; break; } if (d > 0 ? NQ.H[i] >= tgt : NQ.L[i] <= tgt) { exit = tgt; break; } }
    else if (i - x.s >= 19) { const rg = regression(NQ, i - 19, i); if (d > 0 ? NQ.C[i] < rg.end : NQ.C[i] > rg.end) { exit = i + 1 <= end ? NQ.O[i + 1] : NQ.C[i]; break; } }
    if (i === end) exit = NQ.C[i];
  }
  return { pnl: (exit - entry) * d * 2 - 1, t: x.fa };
}
function t5(rows, fit, label, seed) {
  const veto = (x) => flag(x, null, fit, 4), V = rows.filter(veto), K = rows.filter((x) => !veto(x)); const base = perf(ORDER(rows).map((x) => x.pnl)), keptP = perf(ORDER(K).map((x) => x.pnl));
  hdr(`Table 5 -- Breakout flip of the Rule-4-vetoed trades (${label}); vetoed ${V.length}; baseline net ${usd(base.net)}, PF ${f2(base.pf)}, DD ${usd(base.dd)}; filtered fades only (no flips) net ${usd(keptP.net)}, PF ${f2(keptP.pf)}, DD ${usd(keptP.dd)}`);
  const rowsOut = [];
  for (const variant of ['touch', 'break']) for (const mode of [1, 1.5, 2, 'trail']) {
    const res = V.map((x) => simFlip(x, mode, variant)).filter(Boolean), p = perf(res.map((r) => r.pnl)); const comb = [...K.map((x) => ({ t: x.fa, pnl: x.pnl })), ...res].sort((a, b) => (a.t < b.t ? -1 : 1)), cp = perf(comb.map((r) => r.pnl));
    const rng = mulberry32(hashSeed(seed + variant + mode)), pl = []; for (let it = 0; it < 100; it++) { const draw = []; for (let j = 0; j < V.length; j++) draw.push(rows[Math.floor(rng() * rows.length)]); const rr = draw.map((x) => simFlip(x, mode, variant)).filter(Boolean); pl.push(rr.reduce((s, r) => s + r.pnl, 0) / Math.max(1, rr.length)); }
    rowsOut.push([variant === 'touch' ? 'at touch (spec)' : 'break-confirmed', mode === 'trail' ? 'LRMA trail' : mode + 'R', res.length, pc(p.wr), f2(p.pf), usd(p.net), usd(p.avg), `${usd(mean(pl))} (p5 ${usd(quant(pl, .05))}, p95 ${usd(quant(pl, .95))})`, usd(cp.net), f2(cp.pf), usd(cp.dd)]); }
  md(['Entry', 'Exit', 'Flipped Trades', 'Breakout Win Rate', 'Breakout PF', 'Breakout Net PnL', 'Avg per flip', 'Random-subset flip avg (placebo)', 'Combined Net', 'Combined PF', 'Combined Max DD'], rowsOut);
}
t5(T, fitAll, 'FULL in-sample', 'vbpT5'); t5(test, fitTr, 'HOLD-OUT, train-fitted Rule 4', 'vbpT5h');
process.exit(0);
