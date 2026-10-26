// ES corroboration (family A) and canary (family C) study: docs/ES_CORROBORATION_PREREG_20261026.md (+ Amendment 1).  node scripts/study_es_corroboration_20261026.mjs [--record]
import fs from 'fs';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
const B = 2000, NPERM = 300, MIN_N = 100, MIN_DAYS = 40, Q = 0.10, PRACTICAL = 0.02, SEED = 'esc';
const ev = JSON.parse(fs.readFileSync(new URL('../scratch/level_touch_events_20261026.json', import.meta.url))).rows, ef = JSON.parse(fs.readFileSync(new URL('../scratch/es_features_20261026.json', import.meta.url)));
const fmap = new Map(ef.rows.map((r) => [`${r.d}|${r.gi}`, r])), LS = ef.LS, KS = ef.KS;
const rows = ev.filter((r) => r.ret60 !== null && fmap.has(`${r.d}|${r.gi}`)).map((r) => ({ ...r, ...fmap.get(`${r.d}|${r.gi}`), w: 1 / r.nLevels }));
const days = [...new Set(rows.map((r) => r.d))].sort(), cut = days[Math.floor(days.length * 0.6) - 1], isExp = (r) => r.d <= cut, exp = rows.filter(isExp), ho = rows.filter((r) => !isExp(r));
const fx = (x, d = 3) => (x == null || Number.isNaN(x) ? ' n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const quant = (a, p) => { const s = [...a].sort((x, y) => x - y), pos = (s.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
const ols = (xs, ys) => { let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; } return sxy / sxx; };   // slope-only, per the prereg
console.log(`STATE COUNTS touches with ES features and ret60: ${rows.length} on ${days.length} days; explore = days <= ${cut} (${days.filter((d) => d <= cut).length} days, ${exp.length} touches), hold-out ${ho.length} touches; by f short ${rows.filter((r) => r.f < 0).length} long ${rows.filter((r) => r.f > 0).length}`);
const sd = Math.sqrt(rows.reduce((s, r) => s + (r.ret60 - rows.reduce((a, x) => a + x.ret60, 0) / rows.length) ** 2, 0) / (rows.length - 1)); console.log(`POWER pooled SD of ret60 ${sd.toFixed(3)} ATR; for two terciles of ~${Math.round(exp.length / 6)} explore touches the naive 95% half-width is ~${(1.96 * sd * Math.sqrt(2 / (exp.length / 6))).toFixed(3)} ATR60 (day clustering widens it); practical bar ${PRACTICAL} ATR60 (~10 dollars)\n`);

// ---- tests: feature definitions ----
const tests = [];
for (const L of LS) { const b = ols(exp.map((r) => r['aE' + L]).filter((x) => x != null), exp.filter((r) => r['aE' + L] != null).map((r) => r['aN' + L])); tests.push({ fam: 'A', id: `A_L${L}`, resid: (r) => r['aN' + L] - b * r['aE' + L], nq: (r) => r['aN' + L], slope: b, ok: (r) => r['aN' + L] != null && r['aE' + L] != null }); }
for (const k of KS) { const d = ols(exp.map((r) => r['nN' + k]), exp.map((r) => r['nE' + k])); tests.push({ fam: 'C', id: `C_k${k}`, resid: (r) => r['nE' + k] - d * r['nN' + k], nq: (r) => r['nN' + k], slope: d, ok: () => true }); }
tests.push({ fam: 'D', id: 'D_ext', resid: (r) => r.xE, nq: (r) => r.xN, slope: 0, ok: (r) => r.xE != null && r.xN != null });   // Amendment 2: ES at its own extreme, stratified by NQ's own extremity
const tercile = (vals) => [quant(vals, 1 / 3), quant(vals, 2 / 3)];
function prep(t, f) {   // cuts from explore only, per f
  const e = exp.filter((r) => r.f === f && t.ok(r)), rc = tercile(e.map(t.resid)), nc = tercile(e.map(t.nq)), te = (r) => (t.resid(r) >= rc[1] ? 'T' : t.resid(r) <= rc[0] ? 'B' : null), nt = (r) => (t.nq(r) >= nc[1] ? 2 : t.nq(r) <= nc[0] ? 0 : 1);
  return { arm: (r) => (r.f === f && t.ok(r) ? te(r) : null), strat: (r) => `${nt(r)}|${r.bucket}|${r.fam}`, rc, nc };
}
function stratDiff(rowsIn, arm, strat, val = (r) => r.ret60, resample = null) {   // weighted per-trade means within strata, strata-weighted by arm size
  const S = new Map(); for (const r of rowsIn) { const a = arm(r); if (!a) continue; const k = strat(r); let s = S.get(k); if (!s) S.set(k, (s = { T: [0, 0], B: [0, 0] })); s[a][0] += r.w; s[a][1] += r.w * val(r); }
  let num = 0, den = 0; for (const s of S.values()) if (s.T[0] > 0 && s.B[0] > 0) { const w = s.T[0] + s.B[0]; num += w * (s.T[1] / s.T[0] - s.B[1] / s.B[0]); den += w; } return den ? num / den : NaN;
}
function bootDiff(rowsIn, arm, strat, key) {
  const byDay = new Map(); for (const r of rowsIn) { if (!arm(r)) continue; (byDay.get(r.d) || byDay.set(r.d, []).get(r.d)).push(r); }
  const ds = [...byDay.values()], rnd = mulberry32(hashSeed(key)), out = [], pt = stratDiff(rowsIn, arm, strat);
  for (let i = 0; i < B; i++) { const pick = []; for (let j = 0; j < ds.length; j++) for (const r of ds[Math.floor(rnd() * ds.length)]) pick.push(r); const v = stratDiff(pick, arm, strat); if (!Number.isNaN(v)) out.push(v); }
  out.sort((a, b) => a - b); return { pt, out, ci: out.length ? [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]] : [NaN, NaN] };
}
const p2 = (d) => (d.length ? Math.max(1 / d.length, Math.min(1, 2 * Math.min(d.filter((x) => x >= 0).length / d.length, d.filter((x) => x <= 0).length / d.length))) : NaN);
const p1 = (d, sign) => (d.length ? Math.max(1 / d.length, (sign > 0 ? d.filter((x) => x <= 0).length : d.filter((x) => x >= 0).length) / d.length) : NaN);
const bh = (items) => { const s = items.filter((i) => i.p != null).sort((a, b) => a.p - b.p), m = s.length; let km = -1; s.forEach((it, i) => { if (it.p <= ((i + 1) / m) * Q) km = i; }); s.forEach((it, i) => { it.bh = i <= km; }); };
const res = [];
for (const t of tests) for (const f of [-1, 1]) {
  const P = prep(t, f), ex = exp.filter((r) => P.arm(r)), hh = ho.filter((r) => P.arm(r)), cnt = (rs, a) => ({ n: rs.filter((r) => P.arm(r) === a).length, d: new Set(rs.filter((r) => P.arm(r) === a).map((r) => r.d)).size });
  const cT = cnt(ex, 'T'), cB = cnt(ex, 'B'), under = cT.n < MIN_N || cB.n < MIN_N || cT.d < MIN_DAYS || cB.d < MIN_DAYS;
  const be = bootDiff(ex, P.arm, P.strat, `${SEED}e|${t.id}|${f}`), bo = bootDiff(hh, P.arm, P.strat, `${SEED}h|${t.id}|${f}`), allDiff = stratDiff([...ex, ...hh], P.arm, P.strat);
  // reference: NQ's own move (same terciles of t.nq), stratified by bucket x family only
  const nqc = tercile(exp.filter((r) => r.f === f && t.ok(r)).map(t.nq)), ref = { arm: (r) => (r.f === f && t.ok(r) ? (t.nq(r) >= nqc[1] ? 'T' : t.nq(r) <= nqc[0] ? 'B' : null) : null), strat: (r) => `${r.bucket}|${r.fam}` }, refDiff = stratDiff(rows, ref.arm, ref.strat);
  const unstrat = stratDiff([...ex, ...hh], P.arm, () => 'all');
  // absolute means of the two arms (all data)
  const wm = (a) => { const x = [...ex, ...hh].filter((r) => P.arm(r) === a); return x.reduce((s, r) => s + r.w * r.ret60, 0) / x.reduce((s, r) => s + r.w, 0); };
  // permutation sanity: shuffle the ES-derived component among touches with the same minute of day and f (different days); recompute the explore stratified difference
  const rnd = mulberry32(hashSeed(`${SEED}perm|${t.id}|${f}`)), grp = new Map(); for (const r of ex.filter((x) => x.f === f && t.ok(x))) (grp.get(r.mod) || grp.set(r.mod, []).get(r.mod)).push(r);
  const esKeys = t.fam === 'A' ? [`aE${t.id.slice(3)}`] : t.fam === 'D' ? ['xE'] : [`nE${t.id.slice(3)}`], nulls = [];
  for (let i = 0; i < NPERM; i++) { const sw = new Map(); for (const g of grp.values()) { const idx = g.map((_, j) => j); for (let j = idx.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [idx[j], idx[k]] = [idx[k], idx[j]]; } g.forEach((r, j) => sw.set(r, g[idx[j]])); }
    const pr = ex.filter((r) => P.arm(r) || true).map((r) => { const o = sw.get(r); return o ? { ...r, [esKeys[0]]: o[esKeys[0]] } : r; }); const pa = (r) => (r.f === f && t.ok(r) ? (t.resid(r) >= P.rc[1] ? 'T' : t.resid(r) <= P.rc[0] ? 'B' : null) : null); nulls.push(stratDiff(pr, pa, P.strat)); }
  const ppm = nulls.filter((x) => Math.abs(x) >= Math.abs(be.pt)).length / nulls.length;
  res.push({ ...{ fam: t.fam, id: t.id, f }, under, exN: [cT.n, cB.n], exDays: [cT.d, cB.d], expDiff: be.pt, expCI: be.ci, p: under ? null : p2(be.out), hoDiff: bo.pt, hoCI: bo.ci, hoP1: p1(bo.out, Math.sign(be.pt)), allDiff, unstrat, refDiff, absTop: wm('T'), absBot: wm('B'), permP: ppm, slope: t.slope });
}
for (const fam of ['A', 'C', 'D']) bh(res.filter((r) => r.fam === fam));
for (const r of res) { const hyp = r.expDiff > 0; r.dir = hyp ? 'hypothesis' : 'OPPOSITE'; r.shown = !r.under && r.bh && Math.sign(r.hoDiff) === Math.sign(r.expDiff) && r.hoP1 < 0.05 && Math.abs(r.hoDiff) >= 0.5 * Math.abs(r.expDiff); r.practical = r.shown && Math.abs(r.allDiff) >= PRACTICAL;
  console.log(`${r.fam} ${r.id} f=${r.f < 0 ? 'short' : 'long '}: explore arms N ${r.exN.join('/')} days ${r.exDays.join('/')}${r.under ? ' UNDERPOWERED' : ''} | explore diff ${fx(r.expDiff)} CI [${fx(r.expCI[0])},${fx(r.expCI[1])}] p=${r.p == null ? 'n/a' : r.p.toFixed(3)} BH=${r.bh ? 'yes' : 'no'} | hold-out ${fx(r.hoDiff)} CI [${fx(r.hoCI[0])},${fx(r.hoCI[1])}] p1=${r.hoP1.toFixed(3)} | all-data ${fx(r.allDiff)} unstrat ${fx(r.unstrat)} | NQ-only ref ${fx(r.refDiff)} | abs ret60 top ${fx(r.absTop)} / bottom ${fx(r.absBot)} | perm p ${r.permP.toFixed(3)} | ${r.shown ? 'SHOWN (' + r.dir + (r.practical ? ', above practical bar' : ', below practical bar') + ')' : 'NOT SHOWN'}`); }
// mechanical-link audit: does the residual feature still track NQ's own move or time of day?
console.log('\nAUDIT correlation of the divergence feature with NQ own move / minute of day (explore, should be near 0):');
for (const t of tests) { const e = exp.filter(t.ok), r1 = e.map(t.resid), r2 = e.map(t.nq), r3 = e.map((r) => r.mod), cor = (a, b) => { const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); }; console.log(`  ${t.id}: slope ${fx(t.slope)}  corr(resid, NQ move) ${fx(cor(r1, r2))}  corr(resid, minute of day) ${fx(cor(r1, r3))}`); }
// informational filter read (family A, L=15): ES confirming = bottom tercile of r
{ const t = tests.find((x) => x.id === 'A_L15'); for (const f of [-1, 1]) { const P = prep(t, f), x = rows.filter((r) => r.f === f && t.ok(r)), conf = x.filter((r) => t.resid(r) <= P.rc[0]), rest = x.filter((r) => t.resid(r) > P.rc[0]), m = (a, v) => a.reduce((s, r) => s + r.w * v(r), 0) / a.reduce((s, r) => s + r.w, 0);
  console.log(`FILTER READ f=${f < 0 ? 'short' : 'long'} A_L15: ES-confirming (bottom third) N=${conf.length} abs ret60 ${fx(m(conf, (r) => r.ret60))}, symPnl ${fx(m(conf, (r) => r.pnlSym), 1)} | rest N=${rest.length} abs ret60 ${fx(m(rest, (r) => r.ret60))}, symPnl ${fx(m(rest, (r) => r.pnlSym), 1)} | dropping the confirming third changes the per-trade mean ret60 by ${fx(m(rest, (r) => r.ret60) - m(x, (r) => r.ret60))} and removes ${(100 * conf.length / x.length).toFixed(0)}% of trades`); } }
fs.writeFileSync(new URL('../scratch/es_corroboration_results_20261026.json', import.meta.url), JSON.stringify(res));
if (process.argv.includes('--record')) {
  const sh = res.filter((r) => r.shown).map((r) => `${r.id}/${r.f < 0 ? 'short' : 'long'} ${r.dir} diff ${fx(r.allDiff)} (${r.practical ? 'above' : 'below'} the practical bar)`).join('; ') || 'none';
  await recordClaim({ slug: 'es_corroboration_canary_nq_level_touches_20261026', claimText: `Pre-registered (docs/ES_CORROBORATION_PREREG_20261026.md + Amendments 1 and 2) test of ES as corroboration (family A, approach divergence at 5/15/60 min), as a canary (family C, ES turning first over 1/3 min) and ES at its own day extreme (family D) at 18,719 NQ level touches on 691 days: stratified top-minus-bottom tercile contrast of ret60, day-blocked bootstrap, explore/hold-out, BH within family. SHOWN cells: ${sh}. Full table in scratch/es_corroboration_results_20261026.json.`, sourceFile: 'scripts/study_es_corroboration_20261026.mjs', sourceDate: '2026-10-25', sampleSize: rows.length, rigorStatus: 'preregistered_explore_holdout_bh_permutation_nq_only_reference', status: 'PROVISIONAL' }); console.log('claim recorded'); }
process.exit(0);
