// Mechanism decomposition study: docs/MECHANISM_DECOMPOSITION_PREREG_20261026.md (+ amendments). Reads scratch/level_touch_events_20261026.json (scripts/build_level_touch_events_20261026.mjs).
//   node scripts/study_mechanism_20261026.mjs [--record]
import fs from 'fs';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const SEL = '2026-07-09', ERA = '2025-06-01', B = 2000, MIN_N = 100, MIN_DAYS = 40, Q = 0.10;
const E = JSON.parse(fs.readFileSync(new URL('../scratch/level_touch_events_20261026.json', import.meta.url)));
const all = E.rows, out = all.filter((r) => r.excess !== null);
const fx = (x, d = 3) => (x == null || Number.isNaN(x) ? ' n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const uniq = (a) => [...new Set(a)];
const allDays = uniq(all.map((r) => r.d)).sort(), cut = allDays[Math.floor(allDays.length * 0.6) - 1], isExp = (r) => r.d <= cut;
const W = (r) => 1 / r.nLevels, ONE = () => 1;   // 1/nLevels only for pooled Test 1 (Amendment 1 item 4)
const quant = (a, p) => { const s = [...a].sort((x, y) => x - y); const pos = (s.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };

// per-day sufficient statistics for two arms; bootstrap resamples days and pools trades per arm (per-trade weighted mean, never day-weighted)
function dayStats(rows, arm, val, wt) {
  const m = new Map(); for (const r of rows) { const a = arm(r); if (!a) continue; let s = m.get(r.d); if (!s) m.set(r.d, (s = { w: { A: 0, B: 0 }, x: { A: 0, B: 0 }, n: { A: 0, B: 0 } })); const w = wt(r); s.w[a] += w; s.x[a] += w * val(r); s.n[a]++; }
  return [...m.values()];
}
function boot(ds, seedKey, mode) {   // mode 'diff' = mean(A) - mean(B); 'one' = mean(A)
  const rnd = mulberry32(hashSeed(seedKey)), draws = [], n = ds.length; if (!n) return { draws, pt: NaN };
  const est = (idx) => { let wa = 0, xa = 0, wb = 0, xb = 0; for (const i of idx) { wa += ds[i].w.A; xa += ds[i].x.A; wb += ds[i].w.B; xb += ds[i].x.B; } return mode === 'one' ? (wa ? xa / wa : NaN) : (wa && wb ? xa / wa - xb / wb : NaN); };
  const pt = est(ds.map((_, i) => i));
  for (let k = 0; k < B; k++) { const idx = Array.from({ length: n }, () => Math.floor(rnd() * n)); const v = est(idx); if (!Number.isNaN(v)) draws.push(v); }
  draws.sort((a, b) => a - b); return { draws, pt };
}
const ci = (d) => (d.length ? [d[Math.floor(0.025 * d.length)], d[Math.min(d.length - 1, Math.floor(0.975 * d.length))]] : [NaN, NaN]);
const p2 = (d) => { if (!d.length) return NaN; const g = d.filter((x) => x >= 0).length / d.length, l = d.filter((x) => x <= 0).length / d.length; return Math.max(1 / d.length, Math.min(1, 2 * Math.min(g, l))); };
const p1 = (d, sign) => (!d.length ? NaN : Math.max(1 / d.length, (sign > 0 ? d.filter((x) => x <= 0).length : d.filter((x) => x >= 0).length) / d.length));
const bh = (items) => { const s = items.filter((i) => i.p != null).sort((a, b) => a.p - b.p), m = s.length; let kmax = -1; s.forEach((it, i) => { if (it.p <= ((i + 1) / m) * Q) kmax = i; }); s.forEach((it, i) => { it.bh = i <= kmax; }); return items; };
const dayCount = (rows) => uniq(rows.map((r) => r.d)).length;

// ================= state counts first =================
console.log(`STATE COUNTS  rows ${all.length} on ${allDays.length} days; with ret60+control ${out.length}; explore = days <= ${cut} (${allDays.filter((d) => d <= cut).length} days), hold-out ${allDays.filter((d) => d > cut).length} days`);
console.log('by f', { short: all.filter((r) => r.f < 0).length, long: all.filter((r) => r.f > 0).length }, 'by family', Object.fromEntries(uniq(all.map((r) => r.fam)).map((fm) => [fm, all.filter((r) => r.fam === fm).length])));
const claim = {};
{ // ---- POWER, stated before any mean (Amendment 1 item 6) ----
  const ex = out.map((r) => r.excess), mu = ex.reduce((a, b) => a + b, 0) / ex.length, sd = Math.sqrt(ex.reduce((a, b) => a + (b - mu) ** 2, 0) / (ex.length - 1)), atrMed = quant(out.map((r) => r.atr), 0.5);
  console.log(`POWER  pooled SD of excess_A ${sd.toFixed(3)} ATR, median ATR20 ${atrMed.toFixed(1)} pt => 1 ATR = $${(atrMed * 2).toFixed(0)} per trade; no-60min-horizon touches ${all.length - out.length} (all after 15:00)`);
  for (const [lvl, f] of [['IB_HIGH', -1], ['WS1', 1], ['IB_LOW', 1], ['WR1', -1]]) { const x = out.filter((r) => r.lvl === lvl && r.f === f && r.d < SEL), dd = dayCount(x), hw = (1.96 * sd) / Math.sqrt(dd), usd = hw * atrMed * 2, nb = x.filter((r) => r.excessB !== null).length;
    console.log(`  ${lvl} f=${f}: N=${x.length} days=${dd} | expected 95% half-width ${hw.toFixed(3)} ATR = $${usd.toFixed(1)}/trade ${usd >= 14 ? '=> UNDERPOWERED FOR THE CLAIMED +14 (a null here is "could not be resolved")' : '=> can resolve +14'} | control-B coverage ${nb}/${x.length}`); }
  const rk = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Array(a.length); o.forEach(([, i], k) => { r[i] = k; }); return r; }, ra = rk(out.map((r) => r.nLevels)), rb = rk(ex), ma = ra.reduce((a, b) => a + b, 0) / ra.length;
  let cn = 0, da = 0, db = 0; for (let i = 0; i < ra.length; i++) { cn += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; }
  console.log(`  rank corr(nLevels, excess_A) = ${(cn / Math.sqrt(da * db)).toFixed(3)} (printed per Amendment 1 item 4)\n`);
}

// ================= Test 0 =================
console.log('\nTEST 0  out-of-window replication (replay dates before ' + SEL + '), per-trade mean excess ret60 in ATR (control = same-session same-bucket same-direction random bars)');
const t0 = [];
for (const [lvl, f, tag] of [['IB_HIGH', -1, 'SURVIVOR'], ['WS1', 1, 'SURVIVOR'], ['IB_LOW', 1, 'MIRROR'], ['WR1', -1, 'MIRROR']]) {
  const pre = out.filter((r) => r.lvl === lvl && r.f === f && r.d < SEL), post = out.filter((r) => r.lvl === lvl && r.f === f && r.d >= SEL);
  const arm = () => 'A', val = (r) => r.excess, one = () => 1;
  const ds = dayStats(pre, arm, val, one), bt = boot(ds, `T0|${lvl}|${f}`, 'one'), c = ci(bt.draws);
  const dd = uniq(pre.map((r) => r.d)).sort(), mid = dd[Math.floor(dd.length / 2) - 1];
  const h1 = pre.filter((r) => r.d <= mid), h2 = pre.filter((r) => r.d > mid), mean = (a, v) => (a.length ? a.reduce((s, r) => s + v(r), 0) / a.length : NaN);
  const pt = mean(pre, val), m1 = mean(h1, val), m2 = mean(h2, val), pnl = mean(pre, (r) => r.pnlSym);
  let verdict = 'NOT REPLICATED'; if (c[1] < 0) verdict = 'REVERSES'; else if (c[0] > 0 && m1 > 0 && m2 > 0) verdict = 'REPLICATES'; else if (pt > 0 && m1 > 0 && m2 > 0) verdict = 'DIRECTIONAL';
  const bB = boot(dayStats(pre.filter((r) => r.excessB !== null), arm, (r) => r.excessB, one), `T0B|${lvl}|${f}`, 'one'), cB = ci(bB.draws), nB = pre.filter((r) => r.excessB !== null).length;
  const hci = (rows, k) => ci(boot(dayStats(rows, arm, val, one), `T0H${k}|${lvl}|${f}`, 'one').draws);
  const halfCI = [hci(h1, 1), hci(h2, 2)], pre25 = pre.filter((r) => r.d < ERA), post25 = pre.filter((r) => r.d >= ERA);
  const years = Object.fromEntries(uniq(pre.map((r) => r.d.slice(0, 4))).sort().map((y) => { const z = pre.filter((r) => r.d.startsWith(y)); return [y, `${fx(mean(z, val))} (N=${z.length})`]; }));
  const row = { lvl, f, tag, n: pre.length, days: dd.length, mean: pt, ci: c, halfWidth: (c[1] - c[0]) / 2, h1: m1, h2: m2, halfCI, controlB: { n: nB, mean: bB.pt, ci: cB }, era: { pre: mean(pre25, val), post: mean(post25, val) }, years, pnlSym: pnl, inWindowN: post.length, inWindowMean: mean(post, val), verdict };
  t0.push(row);
  console.log(`  ${tag} ${lvl} f=${f}: N=${row.n} days=${row.days} | excess ${fx(pt)} CI [${fx(c[0])},${fx(c[1])}] (smallest resolvable ~${fx(row.halfWidth)}) | halves ${fx(m1)} / ${fx(m2)} | symPnl ${fx(pnl, 1)}/trade | in-window (>=${SEL}) N=${post.length} excess ${fx(row.inWindowMean)} | ${tag === 'SURVIVOR' ? 'VERDICT ' + verdict : '(descriptive)'}`);
  console.log(`      half CIs [${fx(halfCI[0][0])},${fx(halfCI[0][1])}] / [${fx(halfCI[1][0])},${fx(halfCI[1][1])}] | era pre-${ERA.slice(0, 7)} ${fx(row.era.pre)} (N=${pre25.length}) post ${fx(row.era.post)} (N=${post25.length}) | control B: N=${nB} excess ${fx(bB.pt)} CI [${fx(cB[0])},${fx(cB[1])}] ${tag === 'SURVIVOR' ? (cB[0] > 0 ? '=> LEVEL-SPECIFIC' : nB < 30 ? '=> B too thin to say' : '=> not shown level-specific (fading an extreme?)') : ''} | by year ${JSON.stringify(years)}`);
}
claim.test0 = t0;

// ================= Test 1 =================
console.log('\nTEST 1  pooled axes, explore -> hold-out (difference of weighted per-trade mean excess; weights 1/nLevels)');
const expRows = out.filter(isExp), hoRows = out.filter((r) => !isExp(r));
const t1 = [];
for (const f of [-1, 1]) {
  const ee = expRows.filter((r) => r.f === f && r.e !== null).map((r) => r.e), lo = quant(ee, 1 / 3), hi = quant(ee, 2 / 3);
  const tests = [{ id: `E_${f < 0 ? 'short' : 'long'}`, armFn: (r) => (r.e === null ? null : r.e >= hi ? 'A' : r.e <= lo ? 'B' : null), label: `e top tercile (>=${hi.toFixed(3)}) minus bottom (<=${lo.toFixed(3)})` },
    { id: `B_${f < 0 ? 'short' : 'long'}`, armFn: (r) => (r.beyond ? 'A' : 'B'), label: 'beyond prior-day range minus inside' },
    { id: `X_${f < 0 ? 'short' : 'long'}`, armFn: (r) => (r.newExt ? 'A' : 'B'), label: 'touch bar makes a new session extreme minus not' }];
  const mid = out.filter((r) => r.f === f && r.e !== null && r.e > lo && r.e < hi), top = out.filter((r) => r.f === f && r.e !== null && r.e >= hi), bot = out.filter((r) => r.f === f && r.e !== null && r.e <= lo), wm = (a) => a.reduce((s2, r) => s2 + W(r) * r.excess, 0) / a.reduce((s2, r) => s2 + W(r), 0);
  console.log(`  E middle-tercile (descriptive, all days) f=${f}: bottom ${fx(wm(bot))} / middle ${fx(wm(mid))} / top ${fx(wm(top))} => ${(wm(top) > wm(mid) && wm(mid) > wm(bot)) ? 'monotonic up' : (wm(top) < wm(mid) && wm(mid) < wm(bot)) ? 'monotonic down' : 'NOT monotonic'}`);
  for (const t of tests) {
    const arm = (r) => (r.f === f ? t.armFn(r) : null), ex = expRows.filter((r) => arm(r)), ho = hoRows.filter((r) => arm(r));
    const cnt = (rows, a) => ({ n: rows.filter((r) => arm(r) === a).length, days: dayCount(rows.filter((r) => arm(r) === a)) });
    const ca = cnt(ex, 'A'), cb = cnt(ex, 'B'), under = ca.n < MIN_N || cb.n < MIN_N || ca.days < MIN_DAYS || cb.days < MIN_DAYS;
    const be = boot(dayStats(ex, arm, (r) => r.excess, W), `T1e|${t.id}`, 'diff'), bh_ = boot(dayStats(ho, arm, (r) => r.excess, W), `T1h|${t.id}`, 'diff');
    // stratified difference inside family x bucket strata over ALL outcome rows of this test
    const strata = new Map(); for (const r of [...ex, ...ho]) { const a = arm(r); const k = r.fam + '|' + r.bucket; let s = strata.get(k); if (!s) strata.set(k, (s = { A: { w: 0, x: 0 }, B: { w: 0, x: 0 } })); s[a].w += W(r); s[a].x += W(r) * r.excess; }
    let num = 0, den = 0; for (const s of strata.values()) if (s.A.w > 0 && s.B.w > 0) { const wgt = s.A.w + s.B.w; num += wgt * (s.A.x / s.A.w - s.B.x / s.B.w); den += wgt; }
    const strat = den ? num / den : NaN, signE = Math.sign(be.pt);
    const item = { id: t.id, label: t.label, exploreN: [ca.n, cb.n], exploreDays: [ca.days, cb.days], under, expDiff: be.pt, expCI: ci(be.draws), p: under ? null : p2(be.draws), hoDiff: bh_.pt, hoCI: ci(bh_.draws), hoP1: p1(bh_.draws, signE), strat };
    t1.push(item);
  }
}
bh(t1);
for (const it of t1) {
  it.shown = !it.under && it.bh && Math.sign(it.hoDiff) === Math.sign(it.expDiff) && it.hoP1 < 0.05 && Math.sign(it.strat) === Math.sign(it.expDiff) && Math.abs(it.strat) >= 0.5 * Math.abs(it.expDiff);
  console.log(`  ${it.id}: ${it.label} | explore arms N ${it.exploreN.join('/')} days ${it.exploreDays.join('/')}${it.under ? ' UNDERPOWERED' : ''} | explore diff ${fx(it.expDiff)} CI [${fx(it.expCI[0])},${fx(it.expCI[1])}] p=${it.p == null ? 'n/a' : it.p.toFixed(3)} BH=${it.bh ? 'yes' : 'no'} | hold-out ${fx(it.hoDiff)} CI [${fx(it.hoCI[0])},${fx(it.hoCI[1])}] one-sided p=${it.hoP1.toFixed(3)} | stratified ${fx(it.strat)} | ${it.shown ? 'SHOWN' : 'NOT SHOWN'}`);
}
claim.test1 = t1;

// ================= Test 2 =================
console.log('\nTEST 2  family x direction, weighted mean excess ret60 (vs 0)');
const t2 = [];
for (const fam of uniq(all.map((r) => r.fam)).sort()) for (const f of [-1, 1]) {
  const arm = (r) => (r.fam === fam && r.f === f ? 'A' : null), ex = expRows.filter((r) => arm(r)), ho = hoRows.filter((r) => arm(r));
  const under = ex.length < MIN_N || dayCount(ex) < MIN_DAYS, be = boot(dayStats(ex, arm, (r) => r.excess, ONE), `T2e|${fam}|${f}`, 'one'), bho = boot(dayStats(ho, arm, (r) => r.excess, ONE), `T2h|${fam}|${f}`, 'one');
  t2.push({ id: `${fam}_${f < 0 ? 'short' : 'long'}`, exploreN: ex.length, exploreDays: dayCount(ex), hoN: ho.length, under, expMean: be.pt, expCI: ci(be.draws), p: under ? null : p2(be.draws), hoMean: bho.pt, hoCI: ci(bho.draws), hoP1: p1(bho.draws, Math.sign(be.pt)) });
}
bh(t2);
for (const it of t2) { it.shown = !it.under && it.bh && Math.sign(it.hoMean) === Math.sign(it.expMean) && it.hoP1 < 0.05;
  console.log(`  ${it.id.padEnd(22)} explore N=${String(it.exploreN).padStart(4)} days=${String(it.exploreDays).padStart(3)}${it.under ? ' UNDERPOWERED' : ''} mean ${fx(it.expMean)} CI [${fx(it.expCI[0])},${fx(it.expCI[1])}] p=${it.p == null ? 'n/a' : it.p.toFixed(3)} BH=${it.bh ? 'yes' : 'no'} | hold-out N=${it.hoN} mean ${fx(it.hoMean)} one-sided p=${it.hoP1.toFixed(3)} | ${it.shown ? 'SHOWN' : 'NOT SHOWN'}`); }
claim.test2 = t2;

// ================= era split for anything SHOWN =================
for (const it of [...t1, ...t2].filter((x) => x.shown)) console.log(`SHOWN ${it.id}: era check requires a manual follow-up split (pre/post ${ERA}); long/short already separate by construction`);
fs.writeFileSync(new URL('../scratch/mechanism_study_results_20261026.json', import.meta.url), JSON.stringify(claim));
if (process.argv.includes('--record')) {
  const t0s = t0.filter((x) => x.tag === 'SURVIVOR').map((x) => `${x.lvl} f=${x.f}: ${x.verdict} (N=${x.n}, ${x.days} days, excess ${fx(x.mean)} ATR, CI ${fx(x.ci[0])}..${fx(x.ci[1])}, halves ${fx(x.h1)}/${fx(x.h2)})`).join('; ');
  const sh = [...t1, ...t2].filter((x) => x.shown).map((x) => x.id).join(', ') || 'none';
  await recordClaim({ slug: 'mechanism_decomposition_survivors_20261026', claimText: `Mechanism decomposition (prereg docs/MECHANISM_DECOMPOSITION_PREREG_20261026.md). Test 0, out-of-window replication of the roster survivors on replay dates before ${SEL}: ${t0s}. Test 1 and 2 SHOWN cells: ${sh}. Full tables in scratch/mechanism_study_results_20261026.json.`, sourceFile: 'scripts/study_mechanism_20261026.mjs', sourceDate: '2026-10-25', sampleSize: t0.reduce((s, x) => s + x.n, 0), rigorStatus: 'preregistered_explore_holdout_bh_matched_control', status: 'PROVISIONAL' });
  console.log('claim recorded');
}
process.exit(0);
