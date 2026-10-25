// GLOBEX_FLUSH family: walk-forward calibration, realistic fills, mirrored placebo. Prereg (committed first): docs/GLOBEX_FLUSH_WALKFORWARD_PREREG_20261026.md
//   node scripts/study_globex_flush_walkforward_20261026.mjs [--no-record]
// The trigger/sequence/setup construction is a verbatim port of the Globex section of scripts/backtest_flush_patterns.mjs; helpers come from scripts/lib/flushStudyLib.mjs.
import { query } from '../server/db.js';
import { computeBalanceAndResolution, computeEntryPace } from '../server/services/flushMechanics.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { mean, money, percentile, pearson, loadLevels, simulateExit, realistic, loadBarsWithVolZ } from './lib/flushStudyLib.mjs';
import { recordClaim } from './record_claim.mjs';

const SPARSE_FROM = '2025-09-28', SPARSE_TO = '2025-11-19', MIN_PRIOR_BUCKET = 15;
const BUCKETS = [['UP', 'UP', 'CONTINUATION'], ['DOWN', 'UP', 'REVERSAL'], ['DOWN', 'DOWN', 'CONTINUATION'], ['UP', 'DOWN', 'REVERSAL']];
const typeOf = (depDir, resDir, mode) => (mode === 'CONTINUATION' ? `GLOBEX_FLUSH_${resDir === 'UP' ? 'LONG' : 'SHORT'}` : `GLOBEX_FLUSH_REVERSAL_${resDir === 'UP' ? 'LONG' : 'SHORT'}`);
const addDay = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// tier calibration from a set of events (same rule as the backtest): pace tercile cutoff, volume-building medians, tier targets = p75 MFE of the tier (>= 8) else the population median MFE
function calibrate(events) {
  const paces = events.filter((s) => s.pace !== null).map((s) => s.pace).sort((a, b) => a - b), withVol = events.filter((s) => s.avgVolZ !== null && s.volZTrend !== null);
  const paceT2 = paces.length ? percentile(paces, 2 / 3) : Infinity;
  const avMed = withVol.length ? percentile(withVol.map((s) => s.avgVolZ).sort((a, b) => a - b), 0.5) : Infinity, trMed = withVol.length ? percentile(withVol.map((s) => s.volZTrend).sort((a, b) => a - b), 0.5) : Infinity;
  const scoreOf = (s) => { let sc = 0; if (s.pace !== null && s.pace <= paceT2) sc++; if (s.avgVolZ !== null && s.volZTrend !== null && s.avgVolZ > avMed && s.volZTrend > trMed) sc++; return sc; };
  const tierTargets = {}; for (const sc of [0, 1, 2]) { const tb = events.filter((s) => scoreOf(s) === sc); tierTargets[sc] = tb.length >= 8 ? percentile(tb.map((s) => s.mfe), 0.75) : percentile(events.map((s) => s.mfe), 0.5); }
  return { scoreOf, tierTargets };
}

async function main() {
  const noRecord = process.argv.includes('--no-record');
  const { getLevelsForDate } = await loadLevels();
  const allBars = await loadBarsWithVolZ('2023-01-15');
  allBars.forEach((b, i) => { b._idx = i; });
  const rthDates = new Set(), barsByDate = new Map();
  for (const b of allBars) { const d = b.ts.toISOString().slice(0, 10); if (b.mod >= 570 && b.mod <= 959) rthDates.add(d); (barsByDate.get(d) || barsByDate.set(d, []).get(d)).push(b); }
  const departures = [];
  for (const date of [...rthDates].sort()) {
    const lv = getLevelsForDate(date), val = lv?.PD_VAL, vah = lv?.PD_VAH; if (val == null || vah == null) continue;
    for (const b of barsByDate.get(date).filter((x) => x.mod >= 959 && x.mod <= 989)) {
      if (b.close < val) { departures.push({ date, dir: 'DOWN', departurePrice: b.close, globalIdx: b._idx }); break; }
      if (b.close > vah) { departures.push({ date, dir: 'UP', departurePrice: b.close, globalIdx: b._idx }); break; }
    }
  }
  const setups = [];
  for (const dep of departures) {
    const seq = []; for (let i = dep.globalIdx; i < allBars.length; i++) { const b = allBars[i]; if (i > dep.globalIdx && b.mod >= 570 && b.mod <= 959) break; seq.push(b); }
    if (seq.length < 60) continue;
    const res = computeBalanceAndResolution(seq.slice(1)); if (!res) continue;
    const entryIdx = 1 + res.resolutionIdx, entryBar = seq[entryIdx], pace = computeEntryPace(dep.departurePrice, seq[0].ts, res.entryPrice, entryBar.ts);
    let mfe = 0; for (let i = entryIdx + 1; i < seq.length; i++) { const b = seq[i], fav = res.resolutionDir === 'UP' ? b.high - res.entryPrice : res.entryPrice - b.low; if (fav > mfe) mfe = fav; }
    const volZs = seq.slice(1, entryIdx + 1).map((b) => b.volZ).filter((v) => v !== null);
    const avgVolZ = volZs.length >= 5 ? mean(volZs) : null, volZTrend = volZs.length >= 5 ? pearson(Array.from({ length: volZs.length }, (_, i) => i), volZs) : null;
    setups.push({ date: dep.date, entryDate: entryBar.ts.toISOString().slice(0, 10), departureDir: dep.dir, resolutionDir: res.resolutionDir, mode: dep.dir === res.resolutionDir ? 'CONTINUATION' : 'REVERSAL',
      entryPrice: res.entryPrice, stopPrice: res.stopPrice, entryIdx, sessBars: seq, pace, mfe, avgVolZ, volZTrend });
  }
  console.log(`departure days ${departures.length}; resolved Globex setups (all dates, backtest-exact) ${setups.length}`);

  // ---- ARM A: backtest procedure (per-bucket in-sample calibration) on all dates ----
  const aRes = [];
  for (const [dd, rd, mode] of BUCKETS) {
    const bucket = setups.filter((s) => s.departureDir === dd && s.resolutionDir === rd); if (bucket.length < 15) continue;
    const cal = calibrate(bucket), r = bucket.map((s) => ({ date: s.date, ...simulateExit(s, cal.tierTargets[cal.scoreOf(s)]) }));
    aRes.push(...r); console.log(`ARM A ${typeOf(dd, rd, mode).padEnd(30)} N=${r.length} WR=${(100 * r.filter((x) => x.win).length / r.length).toFixed(1)}% EV ${money(mean(r.map((x) => x.pnl)))}`);
  }
  console.log(`ARM A pooled N=${aRes.length} EV ${money(mean(aRes.map((r) => r.pnl)))}`);

  // ---- filtered set for B/C/D ----
  const kept = setups.filter((s) => s.date >= '2023-03-06' && !(s.date >= SPARSE_FROM && s.date <= SPARSE_TO) && !isInsideNqRollWeek(s.date) && !isInsideNqRollWeek(s.entryDate) && !isInsideNqRollWeek(addDay(s.date, 1)));
  console.log(`filtered setups: ${kept.length} of ${setups.length}`);
  const B = [], C = [], Dp = []; let dropped = 0;
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i], prior = kept.slice(0, i).filter((p) => p.departureDir === s.departureDir && p.resolutionDir === s.resolutionDir);
    if (prior.length < MIN_PRIOR_BUCKET) { dropped++; continue; }
    const cal = calibrate(prior), tgt = cal.tierTargets[cal.scoreOf(s)];
    const b0 = simulateExit(s, tgt), c = realistic(s, tgt, false), d = realistic(s, tgt, true); if (!c || !d) continue;
    const key = typeOf(s.departureDir, s.resolutionDir, s.mode);
    B.push({ date: s.date, key, win: b0.pnl > 0, pnl: b0.pnl }); C.push({ date: s.date, key, ...c, tgt, entryDate: s.entryDate, dir: s.resolutionDir }); Dp.push({ date: s.date, key, ...d });
  }
  console.log(`walk-forward events scored ${C.length} (${dropped} dropped: fewer than ${MIN_PRIOR_BUCKET} prior events in their bucket)`);
  const ci = (arr, seed) => (arr.length >= 4 ? dayBlockedBootstrapCI(arr.map((r) => ({ date: r.date, pnl: r.pnl })), seed, { iters: 3000 }) : { lo: null, hi: null });
  const rep = (label, arr) => { if (!arr.length) return null; const c2 = ci(arr, 'gflush|' + label), o = { label, n: arr.length, wr: arr.filter((r) => r.win).length / arr.length, ev: mean(arr.map((r) => r.pnl)), lo: c2.lo, hi: c2.hi }; console.log(`${label.padEnd(36)} N=${String(o.n).padStart(3)} WR=${(100 * o.wr).toFixed(1)}% EV ${money(o.ev)} CI [${money(o.lo)}, ${money(o.hi)}]`); return o; };
  console.log('\n--- ARM B (walk-forward, ideal fills) / ARM C (walk-forward, realistic fills) / ARM D (mirrored placebo) ---');
  const res = {}; for (const [lab, arr] of [['B', B], ['C', C], ['D placebo', Dp]]) { res[lab] = rep(`${lab} pooled`, arr); for (const k of [...new Set(arr.map((r) => r.key))].sort()) rep(`${lab} ${k}`, arr.filter((r) => r.key === k)); }
  const diff = C.map((r, i) => ({ date: r.date, pnl: r.pnl - Dp[i].pnl })), dci = ci(diff, 'gflush|CminusD');
  const sorted = [...C].sort((a, b) => (a.date < b.date ? -1 : 1)), mid = sorted.length >> 1, h1 = mean(sorted.slice(0, mid).map((r) => r.pnl)), h2 = mean(sorted.slice(mid).map((r) => r.pnl));
  console.log(`C minus D: ${money(mean(diff.map((r) => r.pnl)))} CI [${money(dci.lo)}, ${money(dci.hi)}]; C halves ${money(h1)} / ${money(h2)}`);
  const years = {}; for (const r of C) (years[r.date.slice(0, 4)] ||= []).push(r); for (const [y, a] of Object.entries(years)) rep(`C ${y}`, a);
  const byDay = new Map(); for (const r of C) byDay.set(r.date, (byDay.get(r.date) || 0) + r.pnl); const v = [...byDay.values()].map(Math.abs).sort((a, b) => b - a), tot = v.reduce((s, x) => s + x, 0), top5 = tot ? 100 * v.slice(0, 5).reduce((s, x) => s + x, 0) / tot : null;
  console.log(`top-5-day share of |C P&L|: ${top5?.toFixed(1)}%`);
  const verdict = res['C'].lo > 0 && dci.lo > 0 && h1 > 0 && h2 > 0 ? 'SURVIVES' : 'NOT SHOWN'; console.log(`VERDICT (frozen rule, pooled): ${verdict}`);

  // ---- live comparison ----
  const live = (await query(`SELECT id, setup_type, trade_date::text d, fired_at::text fa, origin_status, actual_pnl::float pnl FROM active_setups WHERE setup_type LIKE 'GLOBEX_FLUSH%' AND origin_status IN ('ACTIVE','SHADOW') AND actual_pnl IS NOT NULL ORDER BY fired_at`)).rows;
  console.log(`\nLIVE GLOBEX_FLUSH rows ${live.length}${live.length ? ` (first ${live[0].fa.slice(0, 10)}, last ${live[live.length - 1].fa.slice(0, 10)})` : ''}`);
  const pairs = [];
  for (const l of live) { const want = l.setup_type.endsWith('LONG') ? 'UP' : 'DOWN', fd = l.fa.slice(0, 10); /* exact bucket: LONG vs REVERSAL_LONG are different setups */ void want; const m = C.find((c) => c.key === l.setup_type && (Math.abs((new Date(c.entryDate) - new Date(fd)) / 86400000) <= 1)); if (m) pairs.push({ live: l.pnl, sim: m.pnl, type: l.setup_type, d: fd }); }
  console.log(`live rows matched to a replay event (same setup type within 1 day): ${pairs.length} of ${live.length}; live mean ${money(mean(pairs.map((p) => p.live)))} vs arm C simulated mean ${money(mean(pairs.map((p) => p.sim)))}; all live mean ${money(mean(live.map((l) => l.pnl)))}`);
  if (!noRecord) {
    await recordClaim({ slug: 'globex_flush_walkforward_20261026', sourceFile: 'scripts/study_globex_flush_walkforward_20261026.mjs', sourceDate: '2026-10-26', sampleSize: C.length, evPerTrade: res['C'].ev, rigorStatus: 'preregistered_walkforward_realistic_fills_mirrored_placebo_pooled_4_buckets', status: 'PROVISIONAL',
      claimText: `GLOBEX_FLUSH family walk-forward (prereg docs/GLOBEX_FLUSH_WALKFORWARD_PREREG_20261026.md). The stored backtest calibrates each of 4 buckets on its own population (self-referential) and predates the 2026-10-19 rebuild. Walk-forward calibration (prior events of the same bucket only), entry next-bar open, structural stop price with gap fills: pooled N=${C.length} (${dropped} dropped for the 15-prior minimum), WR ${(100 * res['C'].wr).toFixed(1)}%, EV ${money(res['C'].ev)} CI [${money(res['C'].lo)}, ${money(res['C'].hi)}]; ideal-fill walk-forward EV ${money(res['B'].ev)}; mirrored placebo ${money(res['D placebo'].ev)}; C minus D ${money(mean(diff.map((r) => r.pnl)))} CI [${money(dci.lo)}, ${money(dci.hi)}]; halves ${money(h1)} / ${money(h2)}; top-5-day share ${top5?.toFixed(1)}%. VERDICT under the frozen pooled rule: ${verdict}. Per-bucket results are descriptive (4 buckets). Live: ${live.length} rows, ${pairs.length} matched, live mean ${money(mean(pairs.map((p) => p.live)))} vs simulated ${money(mean(pairs.map((p) => p.sim)))}.` });
    console.log('claim recorded');
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
