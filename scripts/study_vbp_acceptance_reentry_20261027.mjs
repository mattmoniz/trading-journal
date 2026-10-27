// RUN ONCE. Tests A, D', B, C of docs/VBP_ACCEPTANCE_REENTRY_PREREG_20261027.md (+ Amendments 1-3). Counts were frozen in Amendment 3 before this ran.
// Counted-cell statistic = EXPLORE half (earlier 60% of an arm's event dates); hold-out and full sample are reported beside it. One-sided 97.5% bound = 2.5th (or 97.5th) percentile of a date-block bootstrap.
// Rule fixed before the run for A's second criterion: the HIGH arm's excess over blind same-clock same-direction entries must also have its one-sided 97.5% lower bound above 0.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, mean } from './lib/floorEngine.mjs';
import { build4h, pinnedLimit } from './lib/fourHourLevels.mjs';
import { getDailyProfiles } from '../server/services/tickVolumeProfile.js';
import { loadCells, buildSessions, sessionEvents, valueAreaEvent, emOfStart } from './lib/vbpProfiles.mjs';
const END = process.env.STUDY_END || '2026-10-23', ITERS = 3000, NDR = 30;
const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', END))), { h4 } = build4h(NQ), LIM = pinnedLimit(NQ, END);
const linesBy = JSON.parse(fs.readFileSync('scratch/defended_lines_by_date_20261026.json'));
const cells = await loadCells('2023-03-06', END), { sessions } = buildSessions(cells, new Set(NQ.TD.filter((d) => d <= END)));
const f = (x, d = 3) => (x == null || !Number.isFinite(x) ? ' n/a ' : (x >= 0 ? '+' : '') + x.toFixed(d));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))]; };
const el = (c) => (c >= 1080 ? c - 1080 : c + 360), clockOfIdx = (i) => +NQ.T[i].slice(11, 13) * 60 + +NQ.T[i].slice(14, 16);
function fwd(i0, dir, H4, h) { const j = NQ.byEm.get(NQ.EM[i0] + h - 1); return j === undefined || i0 == null ? null : ((NQ.C[j] - NQ.O[i0]) * dir) / H4; }
function mae(i0, dir, H4, h) { let m = 0; for (let t = 0; t < h; t++) { const j = NQ.byEm.get(NQ.EM[i0] + t); if (j === undefined) return null; m = Math.max(m, dir > 0 ? NQ.O[i0] - NQ.L[j] : NQ.H[j] - NQ.O[i0]); } return m / H4; }
function blockBoot(items, statFn, seed, iters = ITERS) { const g = new Map(); for (const x of items) (g.get(x.td) || g.set(x.td, []).get(x.td)).push(x); const keys = [...g.keys()], r = mulberry32(hashSeed(seed)), d = []; for (let it = 0; it < iters; it++) { const pool = []; for (let k = 0; k < keys.length; k++) pool.push(...g.get(keys[Math.floor(r() * keys.length)])); const v = statFn(pool); if (Number.isFinite(v)) d.push(v); } d.sort((a, b) => a - b); return { lo: d[Math.floor(0.025 * d.length)], hi: d[Math.min(d.length - 1, Math.floor(0.975 * d.length))] }; }
// stratified weighted difference: items {td, stratum, flag:'a'|'b'|null, v}; weights = a+b counts per stratum
const stratDiff = (items) => { const S = new Map(); for (const x of items) { if (!x.flag || x.v == null) continue; const o = S.get(x.stratum) || S.set(x.stratum, { a: [], b: [] }).get(x.stratum); o[x.flag].push(x.v); } let num = 0, den = 0; for (const s of S.values()) if (s.a.length && s.b.length) { const w = s.a.length + s.b.length; num += w * (mean(s.a) - mean(s.b)); den += w; } return den ? num / den : NaN; };
const split = (items) => { const dates = [...new Set(items.map((e) => e.td))].sort(), cut = dates[Math.floor(0.6 * dates.length) - 1]; return { cut, ex: items.filter((e) => e.td <= cut), ho: items.filter((e) => e.td > cut) }; };
// ---- session geometry and blind-entry pools per arm
const armInfo = {}; for (const sess of ['RTH', 'GLOBEX']) { const S = sessions.filter((x) => x.sess === sess && x.td <= END && h4[x.td]), tds = new Set(S.map((x) => x.td)), endIdx = new Map(S.map((x) => [x.td, NQ.byEm.get(emOfStart(x.starts[x.starts.length - 1]) + 29)])), byEl = new Map();
  for (let i = 0; i < Math.min(NQ.n, LIM - 3000); i++) { const td = NQ.TD[i]; if (!tds.has(td)) continue; const c = clockOfIdx(i); const inSess = sess === 'RTH' ? c >= 570 && c < 960 && NQ.T[i].slice(0, 10) === td : (c >= 1080 || (c < 570 && NQ.T[i].slice(0, 10) === td)); if (!inSess) continue; const k = el(c); (byEl.get(k) || byEl.set(k, []).get(k)).push(i); }
  armInfo[sess] = { tds, endIdx, byEl }; }
function blindEntries(sess, e, rng) { const { byEl, tds } = armInfo[sess], out = [], ek = el(e.clk); for (let t = 0; t < 4000 && out.length < NDR; t++) { const b = byEl.get(ek + Math.floor(rng() * 61) - 30); if (!b) continue; const i = b[Math.floor(rng() * b.length)]; if (NQ.TD[i] === e.td || !h4[NQ.TD[i]]) continue; out.push(i); } return out; }
const reach = (i0, dir, target, endIdx) => { for (let i = i0; i <= endIdx; i++) { if (dir > 0 ? NQ.H[i] >= target : NQ.L[i] <= target) return 1; } return 0; };
const hdr = (s) => console.log('\n' + '='.repeat(100) + '\n' + s);

// ---- events
const all = []; for (const s of sessions) { if (s.td > END) continue; const r = sessionEvents(NQ, cells, s, h4, linesBy, LIM); all.push(...r.events); }
const out = {};
// =================================================== TEST A
for (const sess of ['RTH', 'GLOBEX']) {
  const E = all.filter((e) => e.sess === sess), d33 = q(E.map((e) => e.dens), 1 / 3), d67 = q(E.map((e) => e.dens), 2 / 3), s33 = q(E.map((e) => e.dist), 1 / 3), s67 = q(E.map((e) => e.dist), 2 / 3), rng = mulberry32(hashSeed('vbpA-blind-' + sess));
  for (const e of E) { e.flag = e.dens >= d67 ? 'a' : e.dens <= d33 ? 'b' : null; e.stratum = e.dist <= s33 ? 0 : e.dist <= s67 ? 1 : 2; e.m60 = fwd(e.i0, e.dir, e.H4, 60); e.m240 = fwd(e.i0, e.dir, e.H4, 240); const bl = blindEntries(sess, e, rng).map((i) => fwd(i, e.dir, h4[NQ.TD[i]], 60)).filter((x) => x != null); e.blind60 = bl.length >= 10 ? mean(bl) : null; e.reent2 = [1, 2].some((m) => e.closeP[e.j + m] != null && (e.dir > 0 ? e.closeP[e.j + m] <= e.edgeP : e.closeP[e.j + m] >= e.edgeP)); }
  const { cut, ex, ho } = split(E); const rep = (X, nm) => { const it = X.map((e) => ({ td: e.td, stratum: e.stratum, flag: e.flag, v: e.m60 })); const p = stratDiff(it), c = X.length >= 20 ? blockBoot(it, stratDiff, 'vbpA-' + sess + nm) : { lo: NaN, hi: NaN }; const H = X.filter((e) => e.flag === 'a' && e.m60 != null), L = X.filter((e) => e.flag === 'b' && e.m60 != null); return { p, c, nH: H.length, nL: L.length, mH: mean(H.map((e) => e.m60)), mL: mean(L.map((e) => e.m60)) }; };
  hdr(`TEST A ${sess}: events ${E.length}; explore through ${cut}`);
  for (const [nm, X] of [['EXPLORE (counted)', ex], ['HOLD-OUT', ho], ['FULL', E]]) { const r = rep(X, nm); console.log(`  ${nm.padEnd(18)} HIGH-LOW stratified 60m diff ${f(r.p)}  97.5% one-sided lower ${f(r.c.lo)} (upper ${f(r.c.hi)})   HIGH n=${r.nH} mean ${f(r.mH)}  LOW n=${r.nL} mean ${f(r.mL)}`); if (nm.startsWith('EXPLORE')) out['A_' + sess] = r; }
  const exH = ex.filter((e) => e.flag === 'a' && e.m60 != null && e.blind60 != null), exL = ex.filter((e) => e.flag === 'b' && e.m60 != null && e.blind60 != null);
  const exc = (X, nm) => { const it = X.map((e) => ({ td: e.td, v: e.m60 - e.blind60 })); const m = mean(it.map((x) => x.v)); const c = blockBoot(it, (p) => mean(p.map((x) => x.v)), 'vbpAex-' + sess + nm); console.log(`  ${nm} excess over blind (explore) n=${it.length}: ${f(m)}  lower ${f(c.lo)} upper ${f(c.hi)}`); return { m, c }; };
  out['A_' + sess + '_excHigh'] = exc(exH, 'HIGH'); exc(exL, 'LOW');
  const s240 = (X) => stratDiff(X.map((e) => ({ td: e.td, stratum: e.stratum, flag: e.flag, v: e.m240 }))); console.log(`  240m sensitivity HIGH-LOW (explore ${f(s240(ex))}, hold-out ${f(s240(ho))}, full ${f(s240(E))})`);
  for (const [nm, d] of [['up', 1], ['down', -1]]) { const X = E.filter((e) => e.dir === d); console.log(`  ${nm} only HIGH-LOW full: ${f(stratDiff(X.map((e) => ({ td: e.td, stratum: e.stratum, flag: e.flag, v: e.m60 }))))} (n ${X.length})`); }
  const rt = (fl) => { const X = E.filter((e) => e.flag === fl); return X.length ? (100 * X.filter((e) => e.reent2).length / X.length).toFixed(1) : 'n/a'; }; console.log(`  descriptive: share re-entering the node within 2 cells  HIGH ${rt('a')}%  LOW ${rt('b')}%`);
  const poc = E.filter((e) => e.pocNear), np = E.filter((e) => !e.pocNear); const dd = (X) => stratDiff(X.map((e) => ({ td: e.td, stratum: e.stratum, flag: e.flag, v: e.m60 }))); console.log(`  descriptive: HIGH-LOW on POC-coincident nodes ${f(dd(poc))} (n ${poc.length}), non-POC nodes ${f(dd(np))} (n ${np.length})`);
  out['cuts_' + sess] = { d33, d67 }; out['E_' + sess] = E;
}
// =================================================== TEST D'
for (const sess of ['RTH', 'GLOBEX']) {
  const E = out['E_' + sess], { d67, d33 } = out['cuts_' + sess], rows = []; // rows: {td, kind:'S1'|'CTL', m, v, mae, gave}
  for (const e of E) { if (e.openIdx[e.j] == null) continue; let s1 = null;
    for (const l of e.later) { const back = e.dir > 0 ? l.close <= e.edgeP : l.close >= e.edgeP; if (back && s1 == null) { s1 = l.m; const io = e.openIdx[l.j]; if (io != null) { const v = fwd(io, e.dir, e.H4, 60); if (v != null) { const profit = (l.close - NQ.O[e.i0]) * e.dir; let gave = null; if (profit > 0) { gave = 0; for (let t = 0; t < 60; t++) { const jj = NQ.byEm.get(NQ.EM[io] + t); if (jj === undefined) { gave = null; break; } if (e.dir > 0 ? NQ.L[jj] <= NQ.O[e.i0] : NQ.H[jj] >= NQ.O[e.i0]) { gave = 1; break; } } } rows.push({ td: e.td, kind: 'S1', m: l.m, v, mae: mae(io, e.dir, e.H4, 60), gave }); } } }
      const outAll = e.later.filter((z) => z.m <= l.m).every((z) => (e.dir > 0 ? z.close > e.edgeP : z.close < e.edgeP)); if (outAll) { const io = e.openIdx[l.j]; if (io != null) { const v = fwd(io, e.dir, e.H4, 60); if (v != null) rows.push({ td: e.td, kind: 'CTL', m: l.m, v, mae: mae(io, e.dir, e.H4, 60) }); } } }
    const s2 = e.later.find((l) => (e.dir > 0 ? l.close > e.edgeP : l.close < e.edgeP) && l.dens != null); if (s2 && e.openIdx[s2.j] != null) { const v = fwd(e.openIdx[s2.j], e.dir, e.H4, 60); if (v != null) rows.push({ td: e.td, kind: s2.dens >= d67 ? 'S2H' : s2.dens <= d33 ? 'S2L' : 'S2M', m: s2.m, v }); } }
  const stat = (R, ka, kb) => { const it = R.filter((r) => r.kind === ka || r.kind === kb).map((r) => ({ td: r.td, stratum: r.m, flag: r.kind === ka ? 'a' : 'b', v: r.v })); return stratDiff(it); };
  const { cut, ex, ho } = split(E); const exTd = new Set(ex.map((e) => e.td)), hoTd = new Set(ho.map((e) => e.td)); hdr(`TEST D' ${sess}: positions ${E.length}; S1 rows ${rows.filter((r) => r.kind === 'S1').length}; control rows ${rows.filter((r) => r.kind === 'CTL').length}; explore through ${cut}`);
  for (const [nm, set] of [['EXPLORE (counted)', exTd], ['HOLD-OUT', hoTd], ['FULL', null]]) { const R = set ? rows.filter((r) => set.has(r.td)) : rows, it = R.filter((r) => r.kind === 'S1' || r.kind === 'CTL').map((r) => ({ td: r.td, stratum: r.m, flag: r.kind === 'S1' ? 'a' : 'b', v: r.v })), p = stratDiff(it), c = blockBoot(it, stratDiff, 'vbpDp-' + sess + nm); console.log(`  ${nm.padEnd(18)} S1(re-entered) minus still-outside, incremental 60m signed move: ${f(p)}  97.5% one-sided UPPER ${f(c.hi)} (lower ${f(c.lo)})`); if (nm.startsWith('EXPLORE')) out['Dp_' + sess] = { p, c }; }
  const S1 = rows.filter((r) => r.kind === 'S1'), CT = rows.filter((r) => r.kind === 'CTL'); console.log(`  descriptive (full): S1 mean ${f(mean(S1.map((r) => r.v)))} (n ${S1.length}) MAE median ${f(q(S1.filter((r) => r.mae != null).map((r) => r.mae), 0.5))}; controls mean ${f(mean(CT.map((r) => r.v)))} (n ${CT.length}) MAE median ${f(q(CT.filter((r) => r.mae != null).map((r) => r.mae), 0.5))}`);
  const gv = S1.filter((r) => r.gave != null); console.log(`  descriptive: S1 positions in open profit at the decision ${gv.length}; fully given back within 60m: ${gv.length ? (100 * gv.filter((r) => r.gave).length / gv.length).toFixed(1) : 'n/a'}%`);
  for (const m of [1, 2, 3, 4]) { const a = S1.filter((r) => r.m === m), b = CT.filter((r) => r.m === m); console.log(`   offset ${m}: S1 n=${a.length} mean ${f(mean(a.map((r) => r.v)))}   controls n=${b.length} mean ${f(mean(b.map((r) => r.v)))}`); }
  const s2d = stat(rows, 'S2H', 'S2L'), s2it = rows.filter((r) => r.kind === 'S2H' || r.kind === 'S2L').map((r) => ({ td: r.td, stratum: r.m, flag: r.kind === 'S2H' ? 'a' : 'b', v: r.v })), s2c = blockBoot(s2it, stratDiff, 'vbpS2-' + sess); console.log(`  descriptive S2 (first outside cell after entry): HIGH-density minus LOW-density incremental 60m ${f(s2d)} [${f(s2c.lo)},${f(s2c.hi)}]  (HIGH n ${rows.filter((r) => r.kind === 'S2H').length}, LOW n ${rows.filter((r) => r.kind === 'S2L').length})`);
}
// =================================================== TEST B
const prof = await getDailyProfiles(query, { startDate: '2023-01-01', endDate: END, session: 'rth' }), pdays = Object.keys(prof).sort(), prior = new Map(pdays.map((d, i) => [d, pdays[i - 1]]));
for (const sess of ['RTH', 'GLOBEX']) {
  const evs = []; for (const s of sessions.filter((x) => x.sess === sess && x.td <= END)) { const p = prior.get(s.td); if (!p) continue; if (!h4[s.td]) continue; /* no H4 yet (first 20 trade days): excluded as in Tests A, C, D' (fixed after the first run, which had let these events in) */ const r = valueAreaEvent(NQ, s, prof, p, LIM); if (r.ev) evs.push(r.ev); }
  const rng = mulberry32(hashSeed('vbpB-blind-' + sess)); const { endIdx } = armInfo[sess];
  for (const e of evs) { e.H4 = h4[e.td]; e.reach = reach(e.i0, e.dir, e.far, e.endIdx); e.m60 = fwd(e.i0, e.dir, e.H4, 60); const dH = e.dist / e.H4, bl = [];
    for (const i of blindEntries(sess, e, rng)) { const H = h4[NQ.TD[i]], ei = endIdx.get(NQ.TD[i]); if (!H || ei == null || i > ei) continue; bl.push(reach(i, e.dir, NQ.O[i] + e.dir * dH * H, ei)); } e.blindReach = bl.length >= 10 ? mean(bl) : null; e.mirror = reach(e.i0, -e.dir, e.entry - e.dir * e.dist, e.endIdx); }
  const { cut, ex, ho } = split(evs); hdr(`TEST B ${sess}: events ${evs.length}; explore through ${cut} (${ex.length} events), hold-out ${ho.length}`);
  for (const [nm, X] of [['EXPLORE (counted)', ex], ['HOLD-OUT', ho], ['FULL', evs]]) { const Z = X.filter((e) => e.blindReach != null), it = Z.map((e) => ({ td: e.td, v: e.reach - e.blindReach })), m = mean(it.map((x) => x.v)), c = it.length >= 10 ? blockBoot(it, (p) => mean(p.map((x) => x.v)), 'vbpB-' + sess + nm) : { lo: NaN, hi: NaN }; console.log(`  ${nm.padEnd(18)} far-boundary reach ${f(100 * mean(Z.map((e) => e.reach)), 1)}% vs matched blind ${f(100 * mean(Z.map((e) => e.blindReach)), 1)}%   diff ${f(100 * m, 1)} pts  97.5% one-sided lower ${f(100 * c.lo, 1)} (n ${Z.length}, ${new Set(Z.map((e) => e.td)).size} dates)`); if (nm.startsWith('EXPLORE')) out['B_' + sess] = { m, c, n: Z.length }; }
  console.log(`  descriptive: signed 60m move toward the far boundary mean ${f(mean(evs.filter((e) => e.m60 != null).map((e) => e.m60)))} (H4 units); mirrored-target reach ${(100 * mean(evs.map((e) => e.mirror))).toFixed(1)}%`);
}
// =================================================== TEST C (non-POC nodes)
for (const sess of ['RTH', 'GLOBEX']) {
  const E = out['E_' + sess].filter((e) => !e.pocNear && e.j + 1 < e.n && e.closeP[e.j + 1] != null && e.openIdx[e.j + 1] != null), rng = mulberry32(hashSeed('vbpC-blind-' + sess)), { endIdx } = armInfo[sess];
  for (const e of E) { e.back = e.dir > 0 ? e.closeP[e.j + 1] <= e.edgeP : e.closeP[e.j + 1] >= e.edgeP; const io = e.openIdx[e.j + 1], fd = -e.dir; e.cm60 = fwd(io, fd, e.H4, 60); e.cmae = mae(io, fd, e.H4, 60); const entry = NQ.O[io], dist = (entry - e.node.peakP) * e.dir; e.cDist = dist; e.creach = dist > 0 ? reach(io, fd, e.node.peakP, endIdx.get(e.td)) : null;
    if (dist > 0) { const bl = []; for (const i of blindEntries(sess, { ...e, clk: e.clk + 30 }, rng)) { const H = h4[NQ.TD[i]], ei = endIdx.get(NQ.TD[i]); if (!H || ei == null || i > ei) continue; bl.push(reach(i, fd, NQ.O[i] + fd * (dist / e.H4) * H, ei)); } e.cBlind = bl.length >= 10 ? mean(bl) : null; } }
  const { cut, ex, ho } = split(E); hdr(`TEST C ${sess} (non-POC nodes): events ${E.length}; explore through ${cut}`);
  const diff = (X) => { const A = X.filter((e) => e.back && e.cm60 != null).map((e) => ({ td: e.td, v: e.cm60 })), B = X.filter((e) => !e.back && e.cm60 != null).map((e) => ({ td: e.td, v: e.cm60 })); return { A, B }; };
  for (const [nm, X] of [['EXPLORE (counted)', ex], ['HOLD-OUT', ho], ['FULL', E]]) { const { A, B } = diff(X), items = [...A.map((x) => ({ ...x, g: 'a' })), ...B.map((x) => ({ ...x, g: 'b' }))], st = (p) => mean(p.filter((x) => x.g === 'a').map((x) => x.v)) - mean(p.filter((x) => x.g === 'b').map((x) => x.v)), p = st(items), c = A.length >= 10 && B.length >= 10 ? blockBoot(items, st, 'vbpC-' + sess + nm) : { lo: NaN, hi: NaN }; console.log(`  ${nm.padEnd(18)} fade toward peak, signed 60m: back-inside ${f(mean(A.map((x) => x.v)))} (n ${A.length}) minus no-back-inside ${f(mean(B.map((x) => x.v)))} (n ${B.length}) = ${f(p)}  97.5% one-sided lower ${f(c.lo)}`); if (nm.startsWith('EXPLORE')) out['C_' + sess] = { p, c }; }
  const R = E.filter((e) => e.back && e.creach != null), Rb = R.filter((e) => e.cBlind != null); console.log(`  descriptive (back-inside, full): peak reach ${(100 * mean(R.map((e) => e.creach))).toFixed(1)}% vs matched blind ${(100 * mean(Rb.map((e) => e.cBlind))).toFixed(1)}% (n ${Rb.length}); MAE median ${f(q(E.filter((e) => e.back && e.cmae != null).map((e) => e.cmae), 0.5))} p90 ${f(q(E.filter((e) => e.back && e.cmae != null).map((e) => e.cmae), 0.9))}`);
}
fs.writeFileSync('scratch/vbp_run_summary_20261027.json', JSON.stringify(Object.fromEntries(Object.entries(out).filter(([k]) => !k.startsWith('E_'))), null, 1));
process.exit(0);
