// RUN: docs/POST_ENTRY_DEDUP_BAILOUT_PREREG_20261027.md (committed before this ran). Parts 1-4 on the same 5,324 trades / 336 dates / 60-40 split as the t-1 study.
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadTradeSet } from './lib/vbpTradeSet.mjs';
import { perf, quant, mean } from './lib/vbpTrendFilter.mjs';
const { NQ, T, dates, cutDate, sessEnd } = await loadTradeSet();
const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d)), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : 'n/a'), usd = (x) => (Number.isFinite(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(0) : 'n/a'), usd1 = (x) => (Number.isFinite(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(1) : 'n/a');
const md = (h, rows) => { console.log('| ' + h.join(' | ') + ' |'); console.log('|' + h.map(() => '---').join('|') + '|'); for (const r of rows) console.log('| ' + r.join(' | ') + ' |'); };
const hdr = (s) => console.log('\n### ' + s + '\n');
const ITER = 3000, PL = 2000;
// ---------------------------------------------------------------- sort + ids
T.sort((a, b) => (a.td < b.td ? -1 : a.td > b.td ? 1 : a.t - b.t || Math.abs(a.entry - a.lvl) - Math.abs(b.entry - b.lvl) || a.id - b.id)); T.forEach((x, i) => { x.ord = i; x.dir = x.tradeDir; });
const isTrain = (x) => x.td <= cutDate, SPL = [['Full', () => true], ['Train 60%', isTrain], ['Hold-Out 40%', (x) => !isTrain(x)]];
console.log(`# Post-entry study -- run output. Population: ${T.length} BACKFILL RTH level fades (strategy SIMULATION), ${dates.length} dates; Train through ${cutDate}: ${T.filter(isTrain).length} trades; Hold-Out ${T.filter((x) => !isTrain(x)).length}`);
// ---------------------------------------------------------------- helpers
function groupDays(items) { const g = new Map(); for (const it of items) { const o = g.get(it.td) || g.set(it.td, { s: 0, n: 0, sv: 0, nv: 0 }).get(it.td); o.s += it.v; o.n++; if (it.f) { o.sv += it.v; o.nv++; } } return [...g.values()]; }
function ciMean(items, seed) { if (items.length < 5) return { lo: NaN, hi: NaN }; const g = groupDays(items), r = mulberry32(hashSeed(seed)), d = []; for (let it = 0; it < ITER; it++) { let s = 0, n = 0; for (let k = 0; k < g.length; k++) { const o = g[Math.floor(r() * g.length)]; s += o.s; n += o.n; } if (n) d.push(s / n); } d.sort((a, b) => a - b); return { lo: d[Math.floor(0.025 * d.length)], hi: d[Math.min(d.length - 1, Math.floor(0.975 * d.length))] }; }
function ciDiff(items, seed) { // items {td, v, f}: mean(f) - mean(all), date-blocked
  if (items.filter((x) => x.f).length < 5) return { lo: NaN, hi: NaN }; const g = groupDays(items), r = mulberry32(hashSeed(seed)), d = []; for (let it = 0; it < ITER; it++) { let s = 0, n = 0, sv = 0, nv = 0; for (let k = 0; k < g.length; k++) { const o = g[Math.floor(r() * g.length)]; s += o.s; n += o.n; sv += o.sv; nv += o.nv; } if (nv && n) d.push(sv / nv - s / n); } d.sort((a, b) => a - b); return { lo: d[Math.floor(0.025 * d.length)], hi: d[Math.min(d.length - 1, Math.floor(0.975 * d.length))] }; }
const band = (arr) => ({ lo: quant(arr, 0.05), hi: quant(arr, 0.95), m: mean(arr) });
function randSubsetMeans(vals, k, seed, iters = PL) { const r = mulberry32(hashSeed(seed)), out = []; if (!k || !vals.length) return out; for (let it = 0; it < iters; it++) { let s = 0; for (let j = 0; j < k; j++) s += vals[Math.floor(r() * vals.length)]; out.push(s / k); } return out; }
const curve = (list) => perf([...list].sort((a, b) => a.ex - b.ex || a.ord - b.ord).map((x) => x.pnl)); // realized curve: ordered by exit bar
const baseList = (S) => S.map((x) => ({ pnl: x.pnl, ex: x.te, ord: x.ord }));
const bucketCounts = (S) => { const c = { A: 0, B: 0, C: 0 }; for (const x of S) if (c[x.bucket] != null) c[x.bucket]++; return c; };
// ---------------------------------------------------------------- PART 1: deduplication
function dedup(mode) {
  if (mode === 0) return [...T]; const acc = [], maxExit = new Map(), takenBy = new Map();
  for (const x of T) { const key = x.td + '|' + x.dir; let veto = false;
    if (mode === 1) veto = maxExit.has(key) && x.t <= maxExit.get(key);
    else { const L = takenBy.get(key) || []; veto = L.some((p) => x.t - p.t <= 5 && Math.abs(x.lvl - p.lvl) <= 0.5 * x.ATR); }
    if (veto) continue; acc.push(x); maxExit.set(key, Math.max(maxExit.get(key) ?? -1, x.te)); (takenBy.get(key) || takenBy.set(key, []).get(key)).push(x); }
  return acc;
}
const BOOKS = { 0: dedup(0), 1: dedup(1), 2: dedup(2) };
hdr('Table 1 -- Deduplication impact (Mode 0 raw; Mode 1 no overlapping open same-direction trade; Mode 2 5-minute level-zone cooldown). Win rate = trades with Net_PnL > 0. DD = true realized-curve drawdown.');
{ const rows = []; for (const m of [0, 1, 2]) for (const [nm, fn] of SPL) { const S = BOOKS[m].filter(fn), c = bucketCounts(S), p = curve(baseList(S)); rows.push([`Mode ${m}`, nm, S.length, `${c.A} (${pc(c.A / S.length)})`, `${c.B} (${pc(c.B / S.length)})`, `${c.C} (${pc(c.C / S.length)})`, pc(p.wr), f2(p.pf), usd(p.net), usd1(p.avg), usd(p.dd)]); }
  md(['Mode', 'Sample', 'Total Trades', 'Bucket A', 'Bucket B', 'Bucket C', 'Win Rate %', 'Profit Factor', 'Net PnL ($)', 'Mean PnL/Trade ($)', 'True Chrono Max DD ($)'], rows); }
hdr('Table 1b -- Are the removed duplicates below-average trades? removed mean vs Mode-0 mean (date-blocked 95% interval of the difference) and random-removal placebo (same count, 5th-95th pct of random-subset mean; remaining-book drawdown under random removal)');
{ const rows = []; for (const m of [1, 2]) for (const [nm, fn] of SPL) { const all = BOOKS[0].filter(fn), keptSet = new Set(BOOKS[m].map((x) => x.ord)), removed = all.filter((x) => !keptSet.has(x.ord)), items = all.map((x) => ({ td: x.td, v: x.pnl, f: !keptSet.has(x.ord) })), d = ciDiff(items, `dd1b${m}${nm}`), mAll = mean(all.map((x) => x.pnl)), mRem = mean(removed.map((x) => x.pnl));
    const pb = band(randSubsetMeans(all.map((x) => x.pnl), removed.length, `pl1b${m}${nm}`, 1000)); const r = mulberry32(hashSeed(`pldd${m}${nm}`)), dds = []; for (let it = 0; it < 300; it++) { const idx = new Set(); while (idx.size < removed.length) idx.add(Math.floor(r() * all.length)); dds.push(curve(baseList(all.filter((_, i) => !idx.has(i)))).dd); }
    const actualDD = curve(baseList(BOOKS[m].filter(fn))).dd, db = band(dds);
    rows.push([`Mode ${m}`, nm, removed.length, `${usd1(mRem)} vs ${usd1(mAll)}`, `[${usd1(d.lo)}, ${usd1(d.hi)}]`, `${usd1(pb.lo)} to ${usd1(pb.hi)}`, usd(actualDD), `${usd(db.lo)} to ${usd(db.hi)}`]); }
  md(['Mode', 'Sample', 'Removed n', 'Removed mean vs all-trade mean', 'Diff 95% interval', 'Random-removal mean band', 'Actual remaining DD', 'Random-removal DD band'], rows); }
// ---------------------------------------------------------------- PART 2: circuit breaker
function circuit(book, W) { const acc = [], vet = [], ev = new Map();
  for (const x of book) { const key = x.td + '|' + x.dir, E = ev.get(key) || []; if (E.some((e) => e < x.t && x.t <= e + W)) { vet.push(x); continue; } acc.push(x); if (x.bucket === 'C') (ev.get(key) || ev.set(key, []).get(key)).push(x.te); }
  return { acc, vet }; }
function part2(book, label) {
  hdr(`Table 2 -- First-blood circuit breaker on ${label}. W swept on Train; W* = highest Train remaining-book net. Hold-Out rows for W != W* are descriptive only.`);
  const Ws = [15, 30, 45, 60, 390], res = {}; for (const W of Ws) res[W] = circuit(book, W);
  const trainNet = (W) => curve(baseList(res[W].acc.filter(isTrain))).net, Wstar = Ws.reduce((b, w) => (trainNet(w) > trainNet(b) ? w : b), Ws[0]);
  const rows = []; for (const [nm, fn] of SPL.slice(1)) for (const W of Ws) { const B = book.filter(fn), vet = res[W].vet.filter(fn), rem = res[W].acc.filter(fn), items = B.map((x) => ({ td: x.td, v: x.pnl, f: res[W].vet.includes(x) })), mV = mean(vet.map((x) => x.pnl)), mB = mean(B.map((x) => x.pnl)), ci = ciMean(vet.map((x) => ({ td: x.td, v: x.pnl })), `c2m${label}${nm}${W}`), d = ciDiff(items, `c2d${label}${nm}${W}`), pb = band(randSubsetMeans(B.map((x) => x.pnl), vet.length, `c2p${label}${nm}${W}`)), rp = curve(baseList(rem));
    rows.push([nm, W + (W === 390 ? ' (rest of session)' : '') + (W === Wstar ? ' *' : ''), `${vet.length} (${pc(vet.length / B.length)})`, `${usd1(mV)} [${usd1(ci.lo)}, ${usd1(ci.hi)}]`, usd1(mB), `${usd1(mV - mB)} [${usd1(d.lo)}, ${usd1(d.hi)}]`, `${usd1(pb.lo)} to ${usd1(pb.hi)}`, usd(rp.net), f2(rp.pf)]); }
  md(['Sample', 'W (min)', 'Vetoed (n, %)', 'Vetoed mean PnL [95% CI]', 'Book baseline mean', 'Vetoed minus baseline [95% CI]', 'Random-veto placebo band (5th-95th)', 'Remaining book Net', 'Remaining book PF'], rows);
  const b = book.filter((x) => !isTrain(x)), v = res[Wstar].vet.filter((x) => !isTrain(x)), items = b.map((x) => ({ td: x.td, v: x.pnl, f: res[Wstar].vet.includes(x) })), d = ciDiff(items, `c2pass${label}`), pb = band(randSubsetMeans(b.map((x) => x.pnl), v.length, `c2ppass${label}`)), netB = curve(baseList(b)).net, netR = curve(baseList(res[Wstar].acc.filter((x) => !isTrain(x)))).net;
  console.log(`Counted test (frozen W*=${Wstar}, Hold-Out): vetoed minus baseline ${usd1(mean(v.map((x) => x.pnl)) - mean(b.map((x) => x.pnl)))}, upper 97.5% bound ${usd1(d.hi)} (needs < 0); vetoed mean ${usd1(mean(v.map((x) => x.pnl)))} vs placebo 5th pct ${usd1(pb.lo)}; remaining-book net ${usd(netR)} vs book ${usd(netB)} -> ${d.hi < 0 && mean(v.map((x) => x.pnl)) < pb.lo && netR > netB ? 'PASSES' : 'DOES NOT PASS'}`);
  return Wstar;
}
// ---------------------------------------------------------------- PART 3: absorption bailout
function pathState(x, k) { // completed bars [t+1 .. t+k] only; null if the trade already exited on/before bar t+k or t+k leaves the session
  x.ps ||= {}; if (x.ps[k] !== undefined) return x.ps[k]; const i = x.t + k; if (!(x.te > i) || i > sessEnd.get(x.td)) return (x.ps[k] = null);
  let hi = -Infinity, lo = Infinity; for (let j = x.t + 1; j <= i; j++) { if (NQ.H[j] > hi) hi = NQ.H[j]; if (NQ.L[j] < lo) lo = NQ.L[j]; }
  const d = x.dir; return (x.ps[k] = { i, mfe: Math.max(0, (d > 0 ? hi - x.entry : x.entry - lo) / x.stopDist), ur: (d * (NQ.C[i] - x.entry)) / x.stopDist, bail: d * (NQ.C[i] - x.entry) * 2 - 1 });
}
const GRID = []; for (const k of [2, 3, 4]) for (const X of [0.05, 0.10, 0.15, 0.25]) for (const Y of [0.10, 0.20, 0.35, 0.50]) GRID.push({ k, X, Y });
const modSet = (S, c) => S.filter((x) => { const p = pathState(x, c.k); return p && p.mfe <= c.X && p.ur <= -c.Y; });
const impSum = (M, k) => M.reduce((s, x) => s + (pathState(x, k).bail - x.pnl), 0);
function part3(book, label) {
  hdr(`Table 3A -- Path separation at bar k on ${label} (trades still open at the close of bar t_entry+k; MFE_k and Unrealized_R_k in R of the stop distance, bars t+1..t+k only; Full sample)`);
  const q3 = (v) => [f2(quant(v, .25), 3), f2(quant(v, .5), 3), f2(quant(v, .75), 3)].join(' / '), rows = [], rows2 = [];
  for (const k of [1, 2, 3, 5]) { const open = book.filter((x) => pathState(x, k)); for (const b of ['A', 'C']) { const S = open.filter((x) => x.bucket === b); rows.push([k, b === 'A' ? 'Winners (A)' : 'Steamrolls (C)', S.length, q3(S.map((x) => pathState(x, k).mfe)), q3(S.map((x) => pathState(x, k).ur))]); }
    const sub = open.filter((x) => { const p = pathState(x, k); return p.mfe < 0.15 && p.ur < -0.20; }); for (const [nm, S] of [['all open at k', open], ['MFE_k<0.15 & UR_k<-0.20', sub]]) rows2.push([k, nm, S.length, pc(S.filter((x) => x.pnl > 0).length / S.length), usd1(mean(S.map((x) => x.pnl))), pc(S.filter((x) => x.bucket === 'C').length / S.length)]); }
  md(['k', 'Eventual bucket', 'Open n', 'MFE_k p25 / med / p75', 'Unrealized_R_k p25 / med / p75'], rows); console.log(''); md(['k', 'Subset', 'n', 'Eventual win rate', 'Mean eventual PnL', 'Share eventually C'], rows2);
  // Table 3B
  const tr = book.filter(isTrain), ho = book.filter((x) => !isTrain(x)); const cell = GRID.map((c) => { const Mt = modSet(tr, c), Mh = modSet(ho, c); return { ...c, nT: Mt.length, sT: impSum(Mt, c.k), nH: Mh.length, sH: impSum(Mh, c.k) }; });
  const best = cell.reduce((b, c) => (c.sT > b.sT ? c : b), cell[0]);
  hdr(`Table 3B -- Bailout grid on ${label}: Train objective = sum over modified trades of (bailout PnL - original PnL). Hold-Out columns shown for transparency; ONLY the frozen Train-best cell counts. (* = frozen)`);
  md(['k', 'X (MFE<=)', 'Y (UR<=-)', 'Train n mod', 'Train saved-minus-forgone ($)', 'Train per modified', 'Hold-Out n mod', 'Hold-Out total ($)', 'Hold-Out per modified'], cell.map((c) => [c.k, c.X, c.Y, c.nT, usd(c.sT) + (c === best ? ' *' : ''), usd1(c.sT / c.nT), c.nH, usd(c.sH), usd1(c.sH / c.nH)]));
  console.log(`Frozen Train-best cell: k*=${best.k}, X*=${best.X}, Y*=${best.Y} (Train improvement ${usd(best.sT)} on ${best.nT} modified trades)`);
  // selection null (Train): best-of-48 improvement under random same-size bailouts
  const r = mulberry32(hashSeed('sel' + label)), elig = {}; for (const k of [2, 3, 4]) elig[k] = tr.filter((x) => pathState(x, k)).map((x) => pathState(x, k).bail - x.pnl);
  const mx = []; for (let rep = 0; rep < 500; rep++) { let m = -Infinity; for (const c of cell) { const pool = elig[c.k], n = Math.min(c.nT, pool.length); let s = 0; const used = new Set(); while (used.size < n) { const j = Math.floor(r() * pool.length); if (!used.has(j)) { used.add(j); s += pool[j]; } } if (s > m) m = s; } mx.push(m); }
  const sel = band(mx), selP = mx.filter((v) => v >= best.sT).length / mx.length; console.log(`Selection null (Train best-of-48 under random same-size bailouts, 500 reps): 5th-95th pct ${usd(sel.lo)} to ${usd(sel.hi)}; actual Train max ${usd(best.sT)}; P(null max >= actual) = ${f2(selP, 3)}`);
  const out = [], c = best;
  for (const [nm, S] of [['Train 60%', tr], ['Hold-Out 40%', ho]]) { const M = modSet(S, c), Ms = new Set(M.map((x) => x.ord)), dl = M.map((x) => ({ td: x.td, v: pathState(x, c.k).bail - x.pnl })), ci = ciMean(dl, `p3ci${label}${nm}`), orig = mean(M.map((x) => x.pnl)), nw = mean(M.map((x) => pathState(x, c.k).bail));
    const open = S.filter((x) => pathState(x, c.k)).map((x) => pathState(x, c.k).bail - x.pnl), pb = band(randSubsetMeans(open, M.length, `p3pl${label}${nm}`));
    const newList = S.map((x) => (Ms.has(x.ord) ? { pnl: pathState(x, c.k).bail, ex: pathState(x, c.k).i, ord: x.ord } : { pnl: x.pnl, ex: x.te, ord: x.ord })), p1 = curve(newList), p0 = curve(baseList(S));
    out.push([nm, M.length, usd1(orig), usd1(nw), `${usd1(mean(dl.map((z) => z.v)))} [${usd1(ci.lo)}, ${usd1(ci.hi)}]`, `${usd1(pb.lo)} to ${usd1(pb.hi)} (mean ${usd1(pb.m)})`, `${usd(p1.net)} vs ${usd(p0.net)}`, `${f2(p1.pf)} vs ${f2(p0.pf)}`]); out[out.length - 1].ci = ci; out[out.length - 1].pb = pb; }
  hdr(`Table 3B (frozen rule k*=${c.k} X*=${c.X} Y*=${c.Y}) on ${label}`);
  md(['Sample', 'Trades modified', 'Original mean PnL of modified', 'Bailout mean PnL of modified', 'Net improvement per modified [95% CI]', 'Random-bailout placebo band (5th-95th)', 'Full book Net: after vs before', 'Full book PF: after vs before'], out);
  const H = out[1], impH = H[4]; console.log(`Counted test (Hold-Out): improvement per modified lower bound ${usd1(H.ci.lo)} (needs > 0); placebo 95th pct ${usd1(H.pb.hi)}; selection-null P ${f2(selP, 3)} (needs < 0.05) -> ${H.ci.lo > 0 && parseFloat(String(H[4]).split(' ')[0].replace('$', '').replace('-$', '-')) > H.pb.hi && selP < 0.05 ? 'PASSES' : 'DOES NOT PASS'}`);
  return best;
}
// ---------------------------------------------------------------- PART 4: post-entry flip
function flipSim(dF, entry, R, mult, from, end, entryBar) {
  const stop = entry - dF * R, tgt = entry + dF * mult * R;
  if (entryBar != null && (dF > 0 ? NQ.L[entryBar] <= stop : NQ.H[entryBar] >= stop)) return { pnl: -R * 2 - 1, ex: entryBar };
  for (let i = from; i <= end; i++) { const o = NQ.O[i];
    if (dF > 0 ? o <= stop : o >= stop) return { pnl: (o - entry) * dF * 2 - 1, ex: i }; if (dF > 0 ? NQ.L[i] <= stop : NQ.H[i] >= stop) return { pnl: -R * 2 - 1, ex: i };
    if (dF > 0 ? o >= tgt : o <= tgt) return { pnl: (o - entry) * dF * 2 - 1, ex: i }; if (dF > 0 ? NQ.H[i] >= tgt : NQ.L[i] <= tgt) return { pnl: mult * R * 2 - 1, ex: i }; }
  return { pnl: (NQ.C[end] - entry) * dF * 2 - 1, ex: end };
}
const stratum = (x) => (x.clk < 600 ? '09' : x.clk < 660 ? '10' : x.clk < 780 ? '11-12' : '13+');
function part4(book, label, rule) {
  hdr(`Table 4 -- Post-entry flip vs random-flip placebo on ${label} (Variant A: bailout flip at Close[t+k*] with the frozen Part-3 rule k*=${rule.k} X*=${rule.X} Y*=${rule.Y}; Variant B: stop-through flip at Stop_Price at t_exit for accepted Bucket C stop-outs; B+C supplement flips every stop-out)`);
  const rows = [];
  for (const [nm, fn] of SPL.slice(1)) {
    const S = book.filter(fn), Msel = modSet(S, rule), Ms = new Set(Msel.map((x) => x.ord)), poolA = S.filter((x) => pathState(x, rule.k) && x.t + rule.k + 1 <= sessEnd.get(x.td)), poolB = S.filter((x) => x.resolution === 'STOP_HIT');
    const sims = { A: {}, B: {} };
    for (const mult of [1.0, 1.5]) { sims.A[mult] = new Map(poolA.map((x) => [x.ord, flipSim(-x.dir, NQ.C[x.t + rule.k], x.stopDist, mult, x.t + rule.k + 1, sessEnd.get(x.td), null)])); sims.B[mult] = new Map(poolB.map((x) => [x.ord, flipSim(-x.dir, x.stop, x.stopDist, mult, x.te + 1, sessEnd.get(x.td), x.te)])); }
    const variants = [['A bailout flip', 'A', Msel.filter((x) => sims.A[1.0].has(x.ord)), poolA], ['B stop-through flip (C only)', 'B', S.filter((x) => x.bucket === 'C'), poolB], ['B+C all stop-outs (supplement)', 'B', poolB, poolB]];
    for (const [vn, kind, set, pool] of variants) for (const mult of [1.0, 1.5]) {
      const F = set.map((x) => ({ x, ...sims[kind][mult].get(x.ord) })), vals = F.map((f) => f.pnl), ci = ciMean(F.map((f) => ({ td: f.x.td, v: f.pnl })), `p4${label}${nm}${vn}${mult}`);
      const byS = new Map(); for (const f of F) byS.set(stratum(f.x), (byS.get(stratum(f.x)) || 0) + 1); const poolBy = new Map(); for (const x of pool) (poolBy.get(stratum(x)) || poolBy.set(stratum(x), []).get(stratum(x))).push(sims[kind][mult].get(x.ord).pnl);
      const r = mulberry32(hashSeed(`p4pl${label}${nm}${vn}${mult}`)), dm = []; for (let it = 0; it < 1000; it++) { let s = 0, n = 0; for (const [sk, c] of byS) { const P = poolBy.get(sk); if (!P || !P.length) continue; for (let j = 0; j < c; j++) { s += P[Math.floor(r() * P.length)]; n++; } } if (n) dm.push(s / n); }
      const pb = band(dm); const base = kind === 'A' ? S.map((x) => (Ms.has(x.ord) ? { pnl: pathState(x, rule.k).bail, ex: pathState(x, rule.k).i, ord: x.ord } : { pnl: x.pnl, ex: x.te, ord: x.ord })) : baseList(S), comb = curve([...base, ...F.map((f, j) => ({ pnl: f.pnl, ex: f.ex, ord: 1e6 + j }))]), b0 = curve(base);
      rows.push([nm, vn, mult + 'R', F.length, pc(F.filter((f) => f.pnl > 0).length / F.length), `${usd1(mean(vals))} [${usd1(ci.lo)}, ${usd1(ci.hi)}]`, `${usd1(pb.lo)} to ${usd1(pb.hi)} (mean ${usd1(pb.m)})`, `${usd(comb.net)} / ${f2(comb.pf)} (book alone ${usd(b0.net)} / ${f2(b0.pf)})`]);
      rows[rows.length - 1].meta = { nm, vn, mult, lo: ci.lo, phi: pb.hi, mean: mean(vals), n: F.length };
    } }
  md(['Sample', 'Variant', 'Target', 'Flip Count', 'Flip Win Rate', 'Flip Mean PnL [95% CI]', 'Random-flip placebo band (5th-95th)', 'Combined Book Net / PF'], rows);
  for (const r of rows) if (r.meta.nm.startsWith('Hold') && !r.meta.vn.includes('supplement')) console.log(`Counted test (Hold-Out) ${r.meta.vn} ${r.meta.mult}R: mean ${usd1(r.meta.mean)} lower bound ${usd1(r.meta.lo)} (needs > 0), placebo 95th pct ${usd1(r.meta.phi)} -> ${r.meta.lo > 0 && r.meta.mean > r.meta.phi ? 'PASSES' : 'DOES NOT PASS'} (n=${r.meta.n})`);
}
for (const m of [1, 0]) { const book = BOOKS[m], label = m === 1 ? 'MODE 1 BOOK (primary)' : 'MODE 0 RAW BOOK (secondary)'; console.log('\n\n' + '='.repeat(110) + '\n## ' + label + ` (${book.length} trades)\n`); part2(book, label); const rule = part3(book, label); part4(book, label, rule); }
process.exit(0);
