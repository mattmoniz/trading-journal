// RUN: docs/SWEEP_RECLAIM_ENGINE_PREREG_20261027.md (+ Amendment 1), committed before any trade was generated.
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { query } from '../server/db.js';
import { getDailyProfiles } from '../server/services/tickVolumeProfile.js';
import { loadTradeSet } from './lib/vbpTradeSet.mjs';
import { profile, pocOf, perf, quant, mean } from './lib/vbpTrendFilter.mjs';
const { NQ, dates, cutDate } = await loadTradeSet();
const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d)), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : 'n/a'), usd1 = (x) => (Number.isFinite(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(1) : 'n/a'), usd = (x) => (Number.isFinite(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(0) : 'n/a');
const md = (h, rows) => { console.log('| ' + h.join(' | ') + ' |'); console.log('|' + h.map(() => '---').join('|') + '|'); for (const r of rows) console.log('| ' + r.join(' | ') + ' |'); };
const hdr = (s) => console.log('\n### ' + s + '\n');
const FEE = 4, ITER = 2000;
// ---------------------------------------------------------------- sessions, previous session, levels
const clk = (i) => +NQ.T[i].slice(11, 13) * 60 + +NQ.T[i].slice(14, 16), sess = new Map();
for (let i = 0; i < NQ.n; i++) { const td = NQ.TD[i]; if (NQ.T[i].slice(0, 10) !== td) continue; const c = clk(i); if (c < 570 || c >= 960) continue; let o = sess.get(td); if (!o) sess.set(td, (o = { td, s: i, e: i, hi: -Infinity, lo: Infinity, n: 0, ibh: -Infinity, ibl: Infinity, ib: -1 })); o.e = i; o.n++; o.hi = Math.max(o.hi, NQ.H[i]); o.lo = Math.min(o.lo, NQ.L[i]); if (c < 630) { o.ibh = Math.max(o.ibh, NQ.H[i]); o.ibl = Math.min(o.ibl, NQ.L[i]); } else if (o.ib < 0) o.ib = i; }
const done = [...sess.values()].filter((o) => o.n >= 330 && o.e - o.s + 1 === o.n).sort((a, b) => (a.td < b.td ? -1 : 1)), pos = new Map(done.map((o, i) => [o.td, i]));
const dayDiff = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5, prevOf = (td) => { const i = pos.get(td); if (i === undefined || i === 0) return null; const p = done[i - 1]; return dayDiff(p.td, td) <= 5 ? p : null; };
const prof = await getDailyProfiles(query, { startDate: '2023-10-01', endDate: '2026-07-31', session: 'rth' });
const DATES = dates.filter((d) => pos.has(d) && prevOf(d)), TRAIN = DATES.filter((d) => d <= cutDate), HOLD = DATES.filter((d) => d > cutDate);
console.log(`# Sweep + Reclaim engine -- run output. Dates used ${DATES.length} of ${dates.length} (skipped for missing RTH bars or previous session: ${dates.length - DATES.length}); Train ${TRAIN.length} (through ${cutDate}), Hold-Out ${HOLD.length}.`);
function levelsFor(td) { const s = sess.get(td), pd = prevOf(td), L = [{ n: 'PDH', p: pd.hi, st: s.s + 5 }, { n: 'PDL', p: pd.lo, st: s.s + 5 }], pf = prof[pd.td]; if (pf) L.push({ n: 'VAH', p: pf.vah, st: s.s + 5 }, { n: 'VAL', p: pf.val, st: s.s + 5 }, { n: 'POC', p: pf.poc, st: s.s + 5 }); if (s.ib > 0) L.push({ n: 'IB_High', p: s.ibh, st: s.ib }, { n: 'IB_Low', p: s.ibl, st: s.ib }); return L.filter((l) => Number.isFinite(l.p)); }
const LV = new Map(DATES.map((d) => [d, levelsFor(d)]));
// ---------------------------------------------------------------- helpers: ATR, developing value area
const atr14 = (s, t) => { const a = Math.max(s, t - 14); let sum = 0, n = 0; for (let i = a; i < t; i++) { const pc = i > s ? NQ.C[i - 1] : null; sum += pc == null ? NQ.H[i] - NQ.L[i] : Math.max(NQ.H[i] - NQ.L[i], Math.abs(NQ.H[i] - pc), Math.abs(NQ.L[i] - pc)); n++; } return Math.max(1, n ? sum / n : 1); };
function devVA(s, jm1) { const m = profile(NQ, s, jm1); if (!m.size) return null; const ks = [...m.keys()], lo0 = Math.min(...ks), hi0 = Math.max(...ks), get = (k) => m.get(k) || 0, tot = [...m.values()].reduce((a, b) => a + b, 0); const poc = pocOf(m); let pk = Math.floor(poc), lo = pk, hi = pk, acc = get(pk);
  while (acc < 0.7 * tot && (hi < hi0 || lo > lo0)) { const up = get(hi + 1) + get(hi + 2), dn = get(lo - 1) + get(lo - 2); if (hi < hi0 && (lo <= lo0 || up >= dn)) { hi++; acc += get(hi); } else { lo--; acc += get(lo); } } return { poc, mid: (lo + hi + 1) / 2 }; }
// ---------------------------------------------------------------- candidate generator (state machine)
function candidates(td, levels, cfg) {
  const { s, e } = sess.get(td), out = [];
  for (const L of levels) for (const dir of [-1, 1]) { let t = Math.max(L.st, s + 5);
    while (t <= e - 1) {
      const sweep = dir < 0 ? NQ.H[t] > L.p && NQ.C[t - 1] <= L.p : NQ.L[t] < L.p && NQ.C[t - 1] >= L.p; if (!sweep) { t++; continue; }
      let j = -1; for (let k = t + 1; k <= Math.min(t + cfg.K, e - 1); k++) { const cross = cfg.touch ? (dir < 0 ? NQ.L[k] <= L.p : NQ.H[k] >= L.p) : (dir < 0 ? NQ.C[k] < L.p : NQ.C[k] > L.p); if (cross) { j = k; break; } }
      if (j < 0) { t += cfg.K + 1; continue; }
      const atr = atr14(s, t), fill = cfg.touch ? (dir < 0 ? Math.min(L.p, NQ.O[j]) : Math.max(L.p, NQ.O[j])) : NQ.C[j], upto = cfg.touch && !cfg.literal ? j - 1 : j;
      let ext = dir < 0 ? -Infinity : Infinity; for (let i = t; i <= upto; i++) ext = dir < 0 ? Math.max(ext, NQ.H[i]) : Math.min(ext, NQ.L[i]);
      const buf = cfg.touch ? Math.max(2, 0.25 * atr) : 0.25 * atr, stop = dir < 0 ? ext + buf : ext - buf, SD = Math.abs(fill - stop);
      t = j + 1; if (!(dir < 0 ? stop > fill : stop < fill)) continue;
      if (cfg.touch ? SD > 1.5 * atr : (SD < 10 || SD > 35)) continue;
      let tgt = fill + dir * (cfg.R || 1) * SD;
      if (cfg.structural) { const v = j - 1 - s + 1 >= 5 ? devVA(s, j - 1) : null; let st = null; if (v) { if ((v.poc - fill) * dir > 0) st = v.poc; else if ((v.mid - fill) * dir > 0) st = v.mid; } tgt = st != null && Math.abs(st - fill) >= SD ? st : fill + dir * SD; }
      out.push({ td, lvl: L.n, dir, t: j - 0, j, fill, stop, tgt, SD, TD: Math.abs(tgt - fill), atr, dist: Math.abs(fill - L.p) }); } }
  return out; }
// ---------------------------------------------------------------- trade simulation
function simulate(c, cfg, startIdx) {
  const { e } = sess.get(c.td), d = c.dir, st = c.stop, tg = c.tgt, fin = (px, ex, kind) => ({ ex, kind, gross: (px - c.fill) * d * 2 });
  if (cfg.touch && startIdx === undefined && (d > 0 ? NQ.L[c.j] <= st : NQ.H[c.j] >= st)) return fin(st, c.j, 'STOP');
  for (let i = (startIdx ?? c.j) + 1; i <= e; i++) { const op = NQ.O[i]; if (d > 0 ? op <= st : op >= st) return fin(op, i, 'STOP'); if (d > 0 ? NQ.L[i] <= st : NQ.H[i] >= st) return fin(st, i, 'STOP'); if (d > 0 ? op >= tg : op <= tg) return fin(op, i, 'TGT'); if (d > 0 ? NQ.H[i] >= tg : NQ.L[i] <= tg) return fin(tg, i, 'TGT'); }
  return fin(NQ.C[e], e, 'EXP'); }
function book(cands, cfg, noFillBarCheck) { // Mode 1 pooled across levels; per date and direction
  const out = [], byTd = new Map(); for (const c of cands) (byTd.get(c.td) || byTd.set(c.td, []).get(c.td)).push(c);
  for (const [td, L] of byTd) { L.sort((a, b) => a.j - b.j || a.dist - b.dist || (a.lvl < b.lvl ? -1 : 1)); const mx = { '-1': -1, '1': -1 }; for (const c of L) { if (c.j <= mx[c.dir]) continue; const r = simulate(c, cfg, noFillBarCheck ? c.j : undefined); mx[c.dir] = r.ex; out.push({ ...c, ...r, p4: r.gross - FEE, p1: r.gross - 1 }); } }
  return out; }
const run = (dts, cfg, levelFn) => { const cs = []; for (const d of dts) cs.push(...candidates(d, levelFn ? levelFn(d) : LV.get(d), cfg)); return book(cs, cfg, false); };
// ---------------------------------------------------------------- statistics
function ciMean(items, seed) { if (items.length < 5) return { lo: NaN, hi: NaN }; const g = new Map(); for (const it of items) { const o = g.get(it.td) || g.set(it.td, { s: 0, n: 0 }).get(it.td); o.s += it.v; o.n++; } const G = [...g.values()], r = mulberry32(hashSeed(seed)), d = []; for (let it = 0; it < ITER; it++) { let s = 0, n = 0; for (let k = 0; k < G.length; k++) { const o = G[Math.floor(r() * G.length)]; s += o.s; n += o.n; } if (n) d.push(s / n); } d.sort((a, b) => a - b); return { lo: d[Math.floor(0.025 * d.length)], hi: d[Math.min(d.length - 1, Math.floor(0.975 * d.length))] }; }
const curveOf = (T, k) => perf([...T].sort((a, b) => a.ex - b.ex).map((x) => x[k]));
function metrics(T, label) { const p = curveOf(T, 'p4'), p1 = curveOf(T, 'p1'), ci = ciMean(T.map((x) => ({ td: x.td, v: x.p4 })), 'm' + label); return { n: T.length, wr: p.wr, pf: p.pf, net: p.net, avg: p.avg, dd: p.dd, avg1: p1.avg, net1: p1.net, ci }; }
const mrow = (nm, m) => [nm, m.n, pc(m.wr), f2(m.pf), usd(m.net), `${usd1(m.avg)} [${usd1(m.ci.lo)}, ${usd1(m.ci.hi)}]`, usd(m.dd), usd1(m.avg1)];
const MH = ['Sample', 'Total trades', 'Win rate', 'Profit factor', 'Net PnL @$4', 'Mean PnL/trade @$4 [95% CI]', 'Max drawdown', 'Mean @$1 (reference)'];
function geom(T) { const sd = mean(T.map((x) => x.SD)), td = mean(T.map((x) => x.TD)), be = (sd * 2 + FEE) / ((sd * 2 + FEE) + (td * 2 - FEE)); return `avg stop ${f2(sd, 1)} pts, avg target ${f2(td, 1)} pts (avg ${f2(mean(T.map((x) => x.TD / x.SD)), 2)}R), fee = ${pc(mean(T.map((x) => FEE / (2 * x.SD))))} of 1R on average, break-even win rate at the average geometry ${pc(be)}, observed ${pc(T.filter((x) => x.p4 > 0).length / T.length)}; target hit ${pc(T.filter((x) => x.kind === 'TGT').length / T.length)}, stopped ${pc(T.filter((x) => x.kind === 'STOP').length / T.length)}, time exit ${pc(T.filter((x) => x.kind === 'EXP').length / T.length)}; long ${T.filter((x) => x.dir > 0).length} / short ${T.filter((x) => x.dir < 0).length}`; }
const SPECS = { A: { name: 'Spec A (bar-close reclaim, 10-35 pt stop band, 1.5R target)', touch: false, structural: false, K: 3, R: 1.5 }, B: { name: 'Spec B / "Argon" (intrabar touch fill, buffer max(2, 0.25 ATR), 1.5 ATR guardrail, structural target with 1R floor)', touch: true, structural: true, K: 3, literal: false } };
// ---------------------------------------------------------------- placebos
const bucket = new Map(); for (const d of HOLD) { const { s, e } = sess.get(d); for (let i = s + 5; i <= e - 1; i++) { const c = clk(i); (bucket.get(c) || bucket.set(c, []).get(c)).push(i); } }
function placeboBook(list, cfgForSim) { // list of {td,dir,fill,SD,TD,j}
  const byTd = new Map(); for (const c of list) (byTd.get(c.td) || byTd.set(c.td, []).get(c.td)).push(c); const out = [];
  for (const [td, L] of byTd) { L.sort((a, b) => a.j - b.j); const mx = { '-1': -1, '1': -1 }; for (const c of L) { if (c.j <= mx[c.dir]) continue; const cc = { ...c, stop: c.fill - c.dir * c.SD, tgt: c.fill + c.dir * c.TD }; const r = simulate(cc, cfgForSim, c.j); mx[c.dir] = r.ex; out.push({ ...cc, ...r, p4: r.gross - FEE, p1: r.gross - 1 }); } } return out; }
const pstat = (arr, real) => { const m = arr.map((x) => x.avg), pf = arr.map((x) => x.pf).filter(Number.isFinite); return [`${usd1(quant(m, .05))} to ${usd1(quant(m, .95))} (median ${usd1(quant(m, .5))})`, f2(quant(arr.map((x) => x.n), .5), 0), f2(quant(pf, .5)), pc(m.filter((v) => v >= real).length / m.length)]; };
function placebos(real, cfg, seed, reps3) {
  const rng = mulberry32(hashSeed(seed)), P1 = [], P2 = [], P3 = [];
  for (let r = 0; r < 300; r++) { const l1 = [], l2 = []; for (const t of real) { const c = clk(t.j); let i = -1; for (let a = 0; a < 40 && i < 0; a++) { const b = bucket.get(c + Math.floor(rng() * 61) - 30); if (b) i = b[Math.floor(rng() * b.length)]; } if (i >= 0) l1.push({ td: NQ.TD[i], dir: t.dir, fill: NQ.C[i], SD: t.SD, TD: t.TD, j: i }); l2.push({ td: t.td, dir: rng() < 0.5 ? -1 : 1, fill: t.fill, SD: t.SD, TD: t.TD, j: t.j }); } P1.push(metrics0(placeboBook(l1, cfg))); P2.push(metrics0(placeboBook(l2, cfg))); }
  for (let r = 0; r < reps3; r++) { const lf = (d) => { const pd = prevOf(d), rg = (pd.hi - pd.lo) * 0.5; return LV.get(d).map((l) => ({ ...l, p: l.p + (rng() * 2 - 1) * rg })); }; P3.push(metrics0(run(HOLD, cfg, lf))); }
  return { P1, P2, P3 }; }
const metrics0 = (T) => { const p = curveOf(T, 'p4'); return { n: T.length, avg: p.avg, pf: p.pf }; };
// ---------------------------------------------------------------- run both specs
const result = {};
for (const key of ['B', 'A']) {
  const cfg = SPECS[key]; hdr(`${cfg.name}`);
  const trT = run(TRAIN, cfg), hoT = run(HOLD, cfg), mt = metrics(trT, key + 'tr'), mh = metrics(hoT, key + 'ho'); result[key] = { cfg, hoT, mh };
  md(MH, [mrow('In-sample Train', mt), mrow('Out-of-sample Hold-Out', mh)]);
  console.log(`\nTrain geometry: ${geom(trT)}\nHold-Out geometry: ${geom(hoT)}`);
  md(['Hold-Out split', 'Trades', 'Mean @$4', 'Win rate', 'Net @$4'], [...['PDH', 'PDL', 'VAH', 'VAL', 'POC', 'IB_High', 'IB_Low'].map((n) => ['level ' + n, ...(() => { const S = hoT.filter((x) => x.lvl === n); return [S.length, usd1(mean(S.map((x) => x.p4))), pc(S.filter((x) => x.p4 > 0).length / S.length), usd(S.reduce((a, x) => a + x.p4, 0))]; })()]), ...[['long', 1], ['short', -1]].map(([n, d]) => ['direction ' + n, ...(() => { const S = hoT.filter((x) => x.dir === d); return [S.length, usd1(mean(S.map((x) => x.p4))), pc(S.filter((x) => x.p4 > 0).length / S.length), usd(S.reduce((a, x) => a + x.p4, 0))]; })()])]);
  // sensitivity
  const grid = key === 'A' ? [2, 3, 5].flatMap((K) => [1, 1.5, 2].map((R) => ({ K, R, label: `K=${K}, R=${R}` }))) : [2, 3, 5].flatMap((K) => [false, true].map((lit) => ({ K, literal: lit, label: `K=${K}, ${lit ? 'spec-literal stop (uses the fill bar full extreme: lookahead-optimistic)' : 'no-lookahead stop'}` })));
  const gr = grid.map((g) => { const c2 = { ...cfg, ...g }, a = metrics0(run(TRAIN, c2)), b = run(HOLD, c2), mb = metrics(b, 'g' + g.label); return { g, tr: a, ho: mb }; }); const bestG = gr.filter((r) => !r.g.literal).reduce((b, r) => (r.tr.avg > b.tr.avg ? r : b), gr.find((r) => !r.g.literal));
  console.log(`\nSensitivity grid (descriptive; only the spec cell counts; the frozen Train-best ${key === 'B' ? 'no-lookahead ' : ''}cell is marked *):`); md(['Cell', 'Train trades / mean @$4', 'Hold-Out trades / mean @$4 [95% CI]'], gr.map((r) => [r.g.label + (r === bestG ? ' *' : ''), `${r.tr.n} / ${usd1(r.tr.avg)}`, `${r.ho.n} / ${usd1(r.ho.avg)} [${usd1(r.ho.ci.lo)}, ${usd1(r.ho.ci.hi)}]`]));
  const pb = placebos(hoT, cfg, 'plc' + key, 100); result[key].pb = pb;
  console.log('\nRandom-entry placebos on Hold-Out (same stop / target geometry, same fee, same Mode 1); distribution of the mean PnL per trade @$4 over the runs:');
  md(['Placebo', 'Runs', 'Placebo mean/trade (5th-95th pct)', 'Median trades', 'Median PF', 'Share of runs >= the real engine'], [['REAL ' + key, 1, `${usd1(mh.avg)} [${usd1(mh.ci.lo)}, ${usd1(mh.ci.hi)}]`, mh.n, f2(mh.pf), '-'], ['P1 random entry times (same direction & geometry)', pb.P1.length, ...pstat(pb.P1, mh.avg)], ['P2 random direction (same entry bars)', pb.P2.length, ...pstat(pb.P2, mh.avg)], ['P3 random levels (full state machine re-run)', pb.P3.length, ...pstat(pb.P3, mh.avg)]]);
  const sep = (arr) => arr.map((x) => x.avg).filter((v) => v >= mh.avg).length / arr.length, p95 = (arr) => quant(arr.map((x) => x.avg), 0.95);
  console.log(`\nPass rule (Hold-Out): lower bound ${usd1(mh.ci.lo)} > 0 ? ${mh.ci.lo > 0}; mean ${usd1(mh.avg)} above the 95th percentile of P1 (${usd1(p95(pb.P1))}) ${mh.avg > p95(pb.P1)}, P2 (${usd1(p95(pb.P2))}) ${mh.avg > p95(pb.P2)}, P3 (${usd1(p95(pb.P3))}) ${mh.avg > p95(pb.P3)} -> ${mh.ci.lo > 0 && mh.avg > p95(pb.P1) && mh.avg > p95(pb.P2) && mh.avg > p95(pb.P3) ? 'PASSES' : 'DOES NOT PASS (NOT SHOWN)'}`);
}
if (process.env.TRACE) { const tm = (i) => NQ.T[i].slice(11, 16); const T = result.B.hoT.filter((x, i) => i % 700 === 3).slice(0, 4); for (const x of T) { console.log(`\nTRACE ${x.td} ${x.lvl} dir ${x.dir > 0 ? 'LONG' : 'SHORT'}: sweep bar t=${tm(x.t === x.j ? x.j : x.j)} fill bar j=${tm(x.j)} fill ${x.fill} stop ${x.stop} (SD ${x.SD.toFixed(1)}) target ${x.tgt} (TD ${x.TD.toFixed(1)}) exit ${tm(x.ex)} ${x.kind} gross ${x.gross.toFixed(1)}`); for (let i = x.j - 4; i <= Math.min(x.ex, x.j + 6); i++) console.log(`   ${tm(i)} O ${NQ.O[i]} H ${NQ.H[i]} L ${NQ.L[i]} C ${NQ.C[i]}${i === x.j ? '  <- fill bar' : ''}${i === x.ex ? '  <- exit bar' : ''}`); } }
process.exit(0);
