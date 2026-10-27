// RUN: docs/TRADE_GEOMETRY_SWEEP_DEPTH_PREREG_20261027.md (committed before this ran). Mode 1 deduplicated book, same 60/40 split.
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { emOf } from './lib/floorEngine.mjs';
import { loadTradeSet } from './lib/vbpTradeSet.mjs';
import { perf, quant, mean } from './lib/vbpTrendFilter.mjs';
const { NQ, T, dates, cutDate, sessEnd } = await loadTradeSet();
const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d)), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : 'n/a'), usd = (x) => (Number.isFinite(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(0) : 'n/a'), usd1 = (x) => (Number.isFinite(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(1) : 'n/a');
const md = (h, rows) => { console.log('| ' + h.join(' | ') + ' |'); console.log('|' + h.map(() => '---').join('|') + '|'); for (const r of rows) console.log('| ' + r.join(' | ') + ' |'); };
const hdr = (s) => console.log('\n### ' + s + '\n');
const ITER = 3000;
// ---------------------------------------------------------------- Mode 1 book (rebuilt; must reproduce 1,723 / Hold-Out DD 2,357)
T.sort((a, b) => (a.td < b.td ? -1 : a.td > b.td ? 1 : a.t - b.t || Math.abs(a.entry - a.lvl) - Math.abs(b.entry - b.lvl) || a.id - b.id)); T.forEach((x, i) => { x.ord = i; x.dir = x.tradeDir; x.exp = Math.min(x.ea ? (NQ.byEm.get(emOf(x.ea.slice(0, 16) + ':00')) ?? sessEnd.get(x.td)) : sessEnd.get(x.td), sessEnd.get(x.td)); x.TD = Math.abs(x.t1 - x.entry); x.s = Math.max(0, (x.entry - x.lvl) * x.dir); });
const book = []; { const maxExit = new Map(); for (const x of T) { const key = x.td + '|' + x.dir; if (maxExit.has(key) && x.t <= maxExit.get(key)) continue; book.push(x); maxExit.set(key, Math.max(maxExit.get(key) ?? -1, x.te)); } }
const isTrain = (x) => x.td <= cutDate, SPL = [['Train 60%', isTrain], ['Hold-Out 40%', (x) => !isTrain(x)]];
const curve = (list) => perf([...list].sort((a, b) => a.ex - b.ex || a.ord - b.ord).map((x) => x.pnl));
console.log(`# Geometry / sweep-depth study -- run output. Mode 1 book ${book.length} trades (expected 1723); Hold-Out DD of the stored P&L ${usd(curve(book.filter((x) => !isTrain(x)).map((x) => ({ pnl: x.pnl, ex: x.te, ord: x.ord }))).dd)} (expected $2357); Train ${book.filter(isTrain).length}, Hold-Out ${book.filter((x) => !isTrain(x)).length}; buckets A ${book.filter((x) => x.bucket === 'A').length} B ${book.filter((x) => x.bucket === 'B').length} C ${book.filter((x) => x.bucket === 'C').length}`);
// ---------------------------------------------------------------- stats helpers
function groupDays(items) { const g = new Map(); for (const it of items) { const o = g.get(it.td) || g.set(it.td, { s: 0, n: 0 }).get(it.td); o.s += it.v; o.n++; } return [...g.values()]; }
function ciMean(items, seed) { if (items.length < 5) return { lo: NaN, hi: NaN }; const g = groupDays(items), r = mulberry32(hashSeed(seed)), d = []; for (let it = 0; it < ITER; it++) { let s = 0, n = 0; for (let k = 0; k < g.length; k++) { const o = g[Math.floor(r() * g.length)]; s += o.s; n += o.n; } if (n) d.push(s / n); } d.sort((a, b) => a - b); return { lo: d[Math.floor(0.025 * d.length)], hi: d[Math.min(d.length - 1, Math.floor(0.975 * d.length))] }; }
// ---------------------------------------------------------------- PART 1: post-stop path of Bucket C stop-outs
const clockOfIdx = (i) => +NQ.T[i].slice(11, 13) * 60 + +NQ.T[i].slice(14, 16);
const dayIdx = new Set(T.map((x) => x.td)), byClock = new Map(); for (let i = 0; i < NQ.n; i++) { const td = NQ.TD[i]; if (!dayIdx.has(td) || !sessEnd.has(td) || i >= sessEnd.get(td) || NQ.T[i].slice(0, 10) !== td) continue; const c = clockOfIdx(i); if (c < 570 || c >= 960) continue; (byClock.get(c) || byClock.set(c, []).get(c)).push(i); }
function post(ref, d, SD, from, end, M, entryOff, tgtOff) { const to = Math.min(end, from + M - 1); if (to < from) return null; let hi = -Infinity, lo = Infinity; for (let i = from; i <= to; i++) { if (NQ.H[i] > hi) hi = NQ.H[i]; if (NQ.L[i] < lo) lo = NQ.L[i]; } const adv = d > 0 ? ref - lo : hi - ref, fav = d > 0 ? hi - ref : ref - lo; return { cont: Math.max(0, adv) / SD, rev: Math.max(0, fav) / SD, ent: fav >= entryOff ? 1 : 0, tgt: fav >= tgtOff ? 1 : 0 }; }
function part1() {
  hdr('Table 1 -- Post-stop path of stop-outs in the Mode 1 book (bars strictly after t_exit, capped at 15:59; R = multiples of the stop distance). Reversion = travel back in the fade\'s favor from Stop_Price; Continuation = further travel against it.');
  const rows = [], rowsX = [];
  for (const [nm, fn] of SPL) for (const bk of ['C', 'B']) { const S = book.filter((x) => x.bucket === bk && fn(x) && x.te < sessEnd.get(x.td));
    for (const M of [5, 15, 30]) { const R = S.map((x) => ({ x, ...post(x.stop, x.dir, x.stopDist, x.te + 1, sessEnd.get(x.td), M, x.stopDist, x.stopDist + x.TD) })); const q4 = (a) => [f2(quant(a, .25), 2), f2(quant(a, .5), 2), f2(quant(a, .75), 2), f2(mean(a), 2)].join(' / ');
      rows.push([nm, 'Bucket ' + bk, M + 'm', R.length, q4(R.map((r) => r.cont)), q4(R.map((r) => r.rev)), pc(mean(R.map((r) => r.ent))), pc(mean(R.map((r) => r.tgt)))]);
      if (bk === 'C') { const rng = mulberry32(hashSeed(`p1${nm}${M}`)), ex = { ent: [], tgt: [], rc: [], cont: [], rev: [] }, plb = { ent: [], cont: [], rev: [] };
        for (const r of R) { const x = r.x, c0 = clockOfIdx(x.te); let se = 0, st = 0, sc = 0, sv = 0, n = 0; for (let t = 0; t < 4000 && n < 30; t++) { const bucket = byClock.get(c0 + Math.floor(rng() * 61) - 30); if (!bucket) continue; const b = bucket[Math.floor(rng() * bucket.length)]; if (NQ.TD[b] === x.td) continue; const p = post(NQ.C[b], x.dir, x.stopDist, b + 1, sessEnd.get(NQ.TD[b]), M, x.stopDist, x.stopDist + x.TD); if (!p) continue; se += p.ent; st += p.tgt; sc += p.cont; sv += p.rev; n++; }
          if (n) { ex.ent.push({ td: x.td, v: r.ent - se / n }); ex.tgt.push({ td: x.td, v: r.tgt - st / n }); ex.rc.push({ td: x.td, v: (r.rev - r.cont) - (sv - sc) / n }); plb.ent.push(se / n); plb.cont.push(sc / n); plb.rev.push(sv / n); } }
        const ci = (a, s) => ciMean(a, s), e1 = ci(ex.ent, `e1${nm}${M}`), e2 = ci(ex.tgt, `e2${nm}${M}`), e3 = ci(ex.rc, `e3${nm}${M}`);
        rowsX.push([nm, M + 'm', R.length, `${pc(mean(plb.ent))} (mean cont ${f2(mean(plb.cont))}R, rev ${f2(mean(plb.rev))}R)`, `${pc(mean(ex.ent.map((z) => z.v)))} [${pc(e1.lo)}, ${pc(e1.hi)}]`, `${pc(mean(ex.tgt.map((z) => z.v)))} [${pc(e2.lo)}, ${pc(e2.hi)}]`, `${f2(mean(ex.rc.map((z) => z.v)))}R [${f2(e3.lo)}, ${f2(e3.hi)}]`]); } } }
  md(['Sample', 'Bucket', 'Post-stop window', 'n', 'Continuation_R p25 / med / p75 / mean', 'Reversion_R p25 / med / p75 / mean', '% back to Entry', '% back to Target'], rows);
  hdr('Table 1b -- Bucket C excess over the random-time placebo (same clock +/-30 min on other dates, same direction and stop distance; 30 draws per trade); date-blocked 95% intervals');
  md(['Sample', 'Window', 'n', 'Placebo % reaching the entry distance', 'Excess % back to Entry [95% CI]', 'Excess % back to Target [95% CI]', 'Excess (Reversion_R - Continuation_R) [95% CI]'], rowsX);
}
part1();
// ---------------------------------------------------------------- ENGINE
function engine(x, o) { // o: {d, mode 'imm'|'limit', P, stop, tgt}
  const end = x.exp, d = o.d; let fb = x.t;
  if (o.mode === 'limit') { fb = -1; for (let i = x.t + 1; i <= Math.min(x.t + 15, end); i++) if (d > 0 ? NQ.L[i] <= o.P - 0.25 : NQ.H[i] >= o.P + 0.25) { fb = i; break; } if (fb < 0) return { filled: false }; }
  const fin = (px, ex, kind) => ({ filled: true, ex, kind, gross: (px - o.P) * d * 2 });
  if (d > 0 ? NQ.L[fb] <= o.stop : NQ.H[fb] >= o.stop) return fin(o.stop, fb, 'STOP');
  for (let i = fb + 1; i <= end; i++) { const op = NQ.O[i];
    if (d > 0 ? op <= o.stop : op >= o.stop) return fin(op, i, 'STOP'); if (d > 0 ? NQ.L[i] <= o.stop : NQ.H[i] >= o.stop) return fin(o.stop, i, 'STOP');
    if (d > 0 ? op >= o.tgt : op <= o.tgt) return fin(op, i, 'TGT'); if (d > 0 ? NQ.H[i] >= o.tgt : NQ.L[i] <= o.tgt) return fin(o.tgt, i, 'TGT'); }
  return fin(NQ.C[end], end, 'EXP');
}
const geom = (x, d, v) => { const ref = x.entry, SD = x.stopDist, TD = x.TD, s = x.s;
  switch (v.k) {
    case 'ctl': return { d, mode: 'imm', P: ref, stop: ref - d * SD * (v.S || 1), tgt: ref + d * TD * (v.T || 1) };
    case 'v1a': { if (s === 0) return { d, mode: 'imm', P: ref, stop: ref - d * SD, tgt: ref + d * TD }; const P = ref - d * s; return { d, mode: 'limit', P, stop: P - d * SD, tgt: ref + d * TD }; }
    case 'v1b': { if (s === 0) return { d, mode: 'imm', P: ref, stop: ref - d * SD, tgt: ref + d * TD }; const P = ref - d * s; return { d, mode: 'limit', P, stop: P - d * SD, tgt: P + d * TD }; }
    case 'v2': { const P = ref - d * 0.5 * SD; return { d, mode: 'limit', P, stop: ref - d * SD, tgt: ref + d * TD }; }
    case 'v3': { const Q = ref - d * SD; return { d, mode: 'limit', P: Q, stop: Q - d * SD, tgt: Q + d * v.m * SD }; } } };
function runAll(S, v, mirrored) { return S.map((x) => { const r = engine(x, geom(x, mirrored ? -x.dir : x.dir, v)); return { x, ...r, pnl: r.filled ? r.gross - 1 : null, pnl4: r.filled ? r.gross - 4 : null, pnlFlat: r.filled ? (r.kind === 'EXP' ? 0 : r.gross - 1) : null }; }); }
function summ(R, total, seed) { const F = R.filter((r) => r.filled), p = perf([...F].sort((a, b) => a.ex - b.ex || a.x.ord - b.x.ord).map((r) => r.pnl)), ci = ciMean(F.map((r) => ({ td: r.x.td, v: r.pnl })), seed); return { fill: F.length / total, n: F.length, wr: p.wr, pf: p.pf, mean: p.avg, ci, mean4: mean(F.map((r) => r.pnl4)), meanFlat: mean(F.map((r) => r.pnlFlat)), net: p.net, dd: p.dd, F, ci4: ciMean(F.map((r) => ({ td: r.x.td, v: r.pnl4 })), seed + '4') }; }
// ---------------------------------------------------------------- PART 2: entry-depth variants
const VARS = [['V1a at-level limit, target PRICE fixed', { k: 'v1a' }], ['V1b at-level limit, target DISTANCE fixed', { k: 'v1b' }], ['V2 mid-sweep limit (half stop distance)', { k: 'v2' }], ['V3 second mouse 1.0R', { k: 'v3', m: 1 }], ['V3 second mouse 1.5R', { k: 'v3', m: 1.5 }]];
const fmtRow = (nm, sm, N) => [nm, `${sm.n} / ${N} (${pc(sm.fill)})`, pc(sm.wr), f2(sm.pf), `${usd1(sm.mean)} [${usd1(sm.ci.lo)}, ${usd1(sm.ci.hi)}]`, `${usd1(sm.mean4)} [${usd1(sm.ci4.lo)}, ${usd1(sm.ci4.hi)}]`, usd1(sm.meanFlat), usd(sm.net), usd(sm.dd)];
hdr('Table 2 -- Entry-depth variants on the Mode 1 book. Primary engine marks unresolved trades to the 15:59 close; "flat-0 mean" is the stored baseline convention (unresolved = 0 dollars). Mean at $4 = gross - $4 per filled trade.');
const pass2 = [];
for (const [nm, fn] of SPL) { const S = book.filter(fn), N = S.length, rows = [];
  const stored = { n: N, fill: 1, wr: S.filter((x) => x.pnl > 0).length / N, pf: perf([...S].sort((a, b) => a.te - b.te || a.ord - b.ord).map((x) => x.pnl)).pf, mean: mean(S.map((x) => x.pnl)), ci: ciMean(S.map((x) => ({ td: x.td, v: x.pnl })), 'st' + nm), mean4: mean(S.map((x) => (x.resolution === 'TIME_EXPIRED' ? 0 : x.pnl + 1) - 4)), ci4: ciMean(S.map((x) => ({ td: x.td, v: (x.resolution === 'TIME_EXPIRED' ? 0 : x.pnl + 1) - 4 })), 'st4' + nm), meanFlat: mean(S.map((x) => x.pnl)), net: S.reduce((a, x) => a + x.pnl, 0), dd: curve(S.map((x) => ({ pnl: x.pnl, ex: x.te, ord: x.ord }))).dd };
  rows.push(fmtRow('Stored baseline (flat-0 expiry)', stored, N)); const ctlR = runAll(S, { k: 'ctl' }), ctl = summ(ctlR, N, 'ctl' + nm); rows.push(fmtRow('Control: baseline re-simulated, same engine', ctl, N));
  const extra = [];
  for (const [vn, v] of VARS) { const R = runAll(S, v), sm = summ(R, N, vn + nm), Rm = runAll(S, v, true), pm = summ(Rm, N, 'm' + vn + nm), filledOrd = new Set(R.filter((r) => r.filled).map((r) => r.x.ord));
    rows.push(fmtRow(vn, sm, N)); const ctlSame = ctlR.filter((r) => filledOrd.has(r.x.ord)).reduce((a, r) => a + r.pnl, 0), ctlUn = ctlR.filter((r) => !filledOrd.has(r.x.ord)).reduce((a, r) => a + r.pnl, 0), varNet = sm.net;
    extra.push([vn, sm.n, usd(ctlSame), usd(varNet), usd(ctlUn), `${usd(varNet + ctlUn)} vs control ${usd(ctl.net)}`, `${pc(pm.fill)} fill, mean ${usd1(pm.mean)}, mean@$4 ${usd1(pm.mean4)}, PF ${f2(pm.pf)}, net ${usd(pm.net)}`]);
    if (nm.startsWith('Hold')) pass2.push({ vn, lo4: sm.ci4.lo, mean4: sm.mean4, mirr4: pm.mean4, net: varNet, ctlNet: ctl.net, n: sm.n }); }
  console.log(`\n**${nm}** (${N} trades)`); md(['Row', 'Filled / Mode 1 trades (fill rate)', 'Win rate (filled)', 'Profit factor', 'Mean PnL per filled trade [95% CI]', 'Mean at $4 fee+slippage [95% CI]', 'Flat-0 mean', 'Total net ($)', 'Max DD ($)'], rows);
  console.log(`\nMissed-fill accounting and mirrored placebo (${nm}): control P&L split into the trades the variant fills vs the ones it misses (a missed trade earns 0 in the variant)`);
  md(['Variant', 'Filled', 'Control PnL on the SAME filled trades', 'Variant PnL on them', 'Control PnL on the trades the variant MISSES', 'Variant book total (missed = 0)', 'Control book total', 'Mirrored-geometry placebo'], extra.map((e) => [e[0], e[1], e[2], e[3], e[4], e[3], usd(ctl.net), e[6]])); }
for (const p of pass2) console.log(`Counted test (Hold-Out) ${p.vn}: mean@$4 ${usd1(p.mean4)} lower bound ${usd1(p.lo4)} (needs > 0); mirrored placebo mean@$4 ${usd1(p.mirr4)}; variant total net ${usd(p.net)} (missed trades earn 0) vs control ${usd(p.ctlNet)} (needs higher) -> ${p.lo4 > 0 && p.mean4 > p.mirr4 && p.net > p.ctlNet ? 'PASSES' : 'DOES NOT PASS'}`);
// ---------------------------------------------------------------- PART 3: stop width x target scale
hdr('Table 3 -- Stop-width x target-scale sweep on the Control geometry (stop = S x SD, target = T x TD from the baseline trigger). Fit on Train by mean PnL at the $4 fee; only the frozen cell counts. Mirrored = same distances, direction reversed.');
const CELLS = [{ S: 1, T: 1 }]; for (const S of [1.25, 1.5, 2.0]) for (const T of [1.0, 1.25, 1.5]) CELLS.push({ S, T });
const tr = book.filter(isTrain), ho = book.filter((x) => !isTrain(x)), res3 = CELLS.map((c) => { const o = { c }; for (const [nm, S] of [['tr', tr], ['ho', ho]]) { o[nm] = summ(runAll(S, { k: 'ctl', S: c.S, T: c.T }), S.length, `p3${nm}${c.S}${c.T}`); o[nm + 'm'] = summ(runAll(S, { k: 'ctl', S: c.S, T: c.T }, true), S.length, `p3m${nm}${c.S}${c.T}`); } return o; });
const best = res3.slice(1).reduce((b, o) => (o.tr.mean4 > b.tr.mean4 ? o : b), res3[1]);
md(['S (stop x)', 'T (target x)', 'Train mean / @$4 / PF / net / DD', 'Hold-Out mean / @$4 / PF / net / DD', 'Hold-Out win rate', 'Hold-Out flat-0 mean', 'Mirrored placebo Hold-Out mean@$4'], res3.map((o) => [o.c.S + (o.c.S === 1 ? ' (control)' : '') + (o === best ? ' *' : ''), o.c.T, `${usd1(o.tr.mean)} / ${usd1(o.tr.mean4)} / ${f2(o.tr.pf)} / ${usd(o.tr.net)} / ${usd(o.tr.dd)}`, `${usd1(o.ho.mean)} / ${usd1(o.ho.mean4)} / ${f2(o.ho.pf)} / ${usd(o.ho.net)} / ${usd(o.ho.dd)}`, pc(o.ho.wr), usd1(o.ho.meanFlat), usd1(o.hom.mean4)]));
console.log(`Frozen Train-best cell: S=${best.c.S}, T=${best.c.T}. Hold-Out: mean ${usd1(best.ho.mean)} [${usd1(best.ho.ci.lo)}, ${usd1(best.ho.ci.hi)}], mean@$4 ${usd1(best.ho.mean4)} [${usd1(best.ho.ci4.lo)}, ${usd1(best.ho.ci4.hi)}]; control Hold-Out mean@$4 ${usd1(res3[0].ho.mean4)}; mirrored ${usd1(best.hom.mean4)} -> ${best.ho.ci4.lo > 0 && best.ho.mean4 > res3[0].ho.mean4 && best.ho.mean4 > best.hom.mean4 ? 'PASSES' : 'DOES NOT PASS'}`);
// ---------------------------------------------------------------- PART 4: live roster deduplication audit
hdr('Table 4 -- Live/recorded roster (outside the simulation): raw vs primary-only vs Mode 1 deduplicated (no overlapping open same-direction row per trade date). Model P&L (actual_pnl); realized-curve drawdown ordered by resolved_at.');
const live = (await query(`SELECT id, trade_date::text td, setup_type, fired_at::text fa, resolved_at::text ra, stop_level::float stop, t1_level::float t1, actual_pnl::float pnl, origin_status os, is_rth, is_cluster_primary prim FROM active_setups WHERE origin_status IN ('ACTIVE','SHADOW') AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND resolution_method IS DISTINCT FROM 'NO_PRICE_DATA' AND fired_at IS NOT NULL AND resolved_at IS NOT NULL AND resolved_at >= fired_at ORDER BY trade_date, fired_at, id`)).rows.map((r) => ({ ...r, dir: (() => { const d = resolveDirection({ setup_type: r.setup_type, stop_level: r.stop, t1_level: r.t1 }); return d === 'LONG' ? 1 : d === 'SHORT' ? -1 : 0; })() })).filter((r) => r.dir !== 0);
console.log(`live rows with a P&L, direction and both timestamps: ${live.length} (ACTIVE ${live.filter((r) => r.os === 'ACTIVE').length}, SHADOW ${live.filter((r) => r.os === 'SHADOW').length}); dates ${live[0].td} to ${live[live.length - 1].td}`);
const mode1 = (rows) => { const acc = [], mx = new Map(); for (const r of rows) { const k = r.td + '|' + r.dir; if (mx.has(k) && r.fa <= mx.get(k)) continue; acc.push(r); mx.set(k, !mx.has(k) || r.ra > mx.get(k) ? r.ra : mx.get(k)); } return acc; };
const stat = (rows) => { const p = perf([...rows].sort((a, b) => (a.ra < b.ra ? -1 : a.ra > b.ra ? 1 : a.id - b.id)).map((r) => r.pnl)); return [rows.length, usd(p.net), usd1(p.avg), usd(p.dd), f2(p.pf)]; };
const rows4 = []; for (const [sn, fl] of [['all sessions', () => true], ['RTH only', (r) => r.is_rth]]) for (const [bn, bf] of [['ACTIVE (live-visible)', (r) => r.os === 'ACTIVE'], ['ACTIVE excluding POC_ROTATION_JOIN', (r) => r.os === 'ACTIVE' && !r.setup_type.startsWith('POC_ROTATION_JOIN')], ['ACTIVE + SHADOW (all real-time rows)', () => true]]) {
  const raw = live.filter((r) => fl(r) && bf(r)), prim = raw.filter((r) => r.prim !== false), m1raw = mode1(raw), m1prim = mode1(prim);
  rows4.push([sn, bn, 'raw (every row)', ...stat(raw), '-']); rows4.push([sn, bn, 'primary-only (is_cluster_primary)', ...stat(prim), `${raw.length - prim.length} sibling rows`]); rows4.push([sn, bn, 'Mode 1 on raw', ...stat(m1raw), `${raw.length - m1raw.length} stacked (${pc((raw.length - m1raw.length) / raw.length)})`]); rows4.push([sn, bn, 'Mode 1 on primary-only', ...stat(m1prim), `${prim.length - m1prim.length} stacked beyond primary (${pc((prim.length - m1prim.length) / prim.length)})`]); }
md(['Scope', 'Book', 'Version', 'Rows', 'Net ($)', 'Mean/trade ($)', 'Max DD ($)', 'PF', 'Duplicates removed'], rows4);
process.exit(0);
