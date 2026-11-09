// Flush S1' study: skip events whose (stop-50)/ADR20 is above the expanding direction-stratified p80. PRE-REGISTERED and FROZEN:
//   docs/FLUSH_BOX_WIDTH_SKIP_PREREG_20261109.md (+ amendment A1: NQ roll weeks excluded). Look 202 (ref flush_box_width_skip_20261109_look1) was logged BEFORE this ran.
//   node scripts/study_flush_box_width_skip_20261109.mjs [--no-record]
// Exits are the study library's realistic() arm (next-bar open, gap-aware structural stop, session-end exit). Target = median MFE of strictly EARLIER events of the same
// group+direction (walk-forward, >= 20 earlier). Paired d_i = -P&L_i when skipped else 0, averaged over ALL eligible events. EXPLORE window only (<= 2025-05-16); sealed untouched.
import { loadLevels, loadBarsWithVolZ, groupBarsByDate, groupRthByDate, loadFollowingLevels, makeAdrBefore, buildRthBlindEvents, buildGlobexBlindEventsLive, percentile, mean } from './lib/flushStudyLib.mjs';
import { buildGroupRows } from './lib/flushBoxWidthRows.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const EXPLORE_END = '2025-05-16', FAMILY_ALPHA = 0.10, DRAWS = 1000, BOOT = 5000, TRUNC = -1000;
const groupOf = (e) => (e.session === 'RTH' ? 'RTH' : e.mode === 'CONTINUATION' ? 'GLOBEX_CONT' : 'GLOBEX_REV');
const money = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function boot(xs, seed) { const r = rng(seed), n = xs.length, m = []; for (let b = 0; b < BOOT; b++) { let s = 0; for (let i = 0; i < n; i++) s += xs[Math.floor(r() * n)]; m.push(s / n); } m.sort((a, b) => a - b); return m; }
const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };

async function main() {
  const noRecord = process.argv.includes('--no-record');
  const { getLevelsForDate } = await loadLevels();
  const allBars = await loadBarsWithVolZ('1900-01-01');
  const barsByDate = groupBarsByDate(allBars), rthByDate = groupRthByDate(allBars), adrBefore = makeAdrBefore(rthByDate);
  let events = [...buildRthBlindEvents(rthByDate, getLevelsForDate, adrBefore), ...buildGlobexBlindEventsLive(barsByDate, await loadFollowingLevels(), adrBefore)]
    .filter((e) => e.date <= EXPLORE_END && e.adr).sort((a, b) => a.date.localeCompare(b.date) || a.entryTs - b.entryTs);
  const rolled = events.filter((e) => isInsideNqRollWeek(e.date));
  events = events.filter((e) => !isInsideNqRollWeek(e.date));
  const results = [];
  for (const g of ['RTH', 'GLOBEX_CONT', 'GLOBEX_REV']) {
    const ev = events.filter((e) => groupOf(e) === g), rows = buildGroupRows(ev);
    const N = rows.length, flagged = rows.filter((r) => r.skip), d = rows.map((r) => (r.skip ? -r.pnl : 0)), dT = rows.map((r) => (r.skip ? -Math.max(r.pnl, TRUNC) : 0)), dM = rows.map((r) => (r.skip ? -r.mir : 0));
    const bm = boot(d, 11 + N), mean_d = mean(d);
    // control 1: same number of skips per fire-time tercile drawn from the NON-flagged events
    const cuts = [percentile(rows.map((r) => r.fireMin), 1 / 3), percentile(rows.map((r) => r.fireMin), 2 / 3)], terc = (r) => (r.fireMin <= cuts[0] ? 0 : r.fireMin <= cuts[1] ? 1 : 2);
    const pools = [0, 1, 2].map((t) => rows.filter((r) => !r.skip && terc(r) === t)), need = [0, 1, 2].map((t) => flagged.filter((r) => terc(r) === t).length), r2 = rng(99 + N), rand = [];
    for (let k = 0; k < DRAWS; k++) { let s = 0; for (let t = 0; t < 3; t++) { const pool = pools[t].slice(); for (let j = 0; j < Math.min(need[t], pool.length); j++) { const i = Math.floor(r2() * (pool.length - j)); s -= pool[i].pnl; pool[i] = pool[pool.length - 1 - j]; } } rand.push(s / N); }
    rand.sort((a, b) => a - b);
    const diffPlacebo = d.map((x, i) => x - dM[i]), bp = boot(diffPlacebo, 31 + N);
    const dates = rows.map((r) => r.date), mid = dates[Math.floor(dates.length / 2)], h1 = mean(d.filter((_, i) => rows[i].date <= mid)), h2 = mean(d.filter((_, i) => rows[i].date > mid));
    const sub = (dir) => { const x = d.filter((_, i) => rows[i].dir === dir); return { n: x.length, m: mean(x), se: sd(x) / Math.sqrt(x.length) }; }, L = sub('LONG'), S = sub('SHORT');
    const inconclusive = L.m * S.m < 0 && Math.abs(L.m) > 0.5 * L.se && Math.abs(S.m) > 0.5 * S.se;
    const worstB0 = Math.min(...rows.map((r) => r.pnl)), worstS1 = Math.min(...rows.filter((r) => !r.skip).map((r) => r.pnl));
    results.push({ g, N, skipped: flagged.length, mean_d, meanT: mean(dT), p: bm.filter((x) => x <= 0).length / BOOT, bm, ci: dayBlockedBootstrapCI(d.map((x, i) => ({ date: rows[i].date + '|' + i, pnl: x })), 'flush_box_width_skip_' + g),
      randP95: q(rand, 0.95), randMean: mean(rand), placeboMean: mean(dM), diffPlaceboLo: q(bp, 0.05), h1, h2, L, S, inconclusive, worstB0, worstS1, skippedMean: mean(flagged.map((r) => r.pnl)), skippedMedian: percentile(flagged.map((r) => r.pnl), 0.5), b0Mean: mean(rows.map((r) => r.pnl)) });
  }
  const order = results.slice().sort((a, b) => a.p - b.p);
  order.forEach((r, i) => { r.holmAlpha = FAMILY_ALPHA / (order.length - i); r.lbHolm = q(r.bm, r.holmAlpha); });
  console.log(`roll-week events excluded: ${rolled.length} (${['RTH', 'GLOBEX_CONT', 'GLOBEX_REV'].map((g) => g + ' ' + rolled.filter((e) => groupOf(e) === g).length).join(', ')})\n`);
  for (const r of results) {
    const checks = [['eligible >= 150', r.N >= 150], ['Holm lower bound > 0', r.lbHolm > 0], ['prop-truncated mean > 0', r.meanT > 0], ['beats random-skip p95', r.mean_d > r.randP95], ['beats placebo (lb > 0)', r.diffPlaceboLo > 0], ['both halves >= 0', r.h1 >= 0 && r.h2 >= 0], ['not inconclusive', !r.inconclusive], ['worst loss not worse than B0', r.worstS1 >= r.worstB0]];
    const verdict = r.inconclusive ? 'INCONCLUSIVE (regime-confounded)' : checks.every((c) => c[1]) ? 'PASS' : 'NOT SHOWN';
    r.verdict = verdict;
    console.log(`${r.g}: N ${r.N}, skipped ${r.skipped} (${(100 * r.skipped / r.N).toFixed(0)}%). take-all mean ${money(r.b0Mean)}/event; skipped events mean ${money(r.skippedMean)} (median ${money(r.skippedMedian)})`);
    console.log(`  paired mean ${money(r.mean_d)} (95% CI ${money(r.ci.lo)}..${money(r.ci.hi)}), one-sided p ${r.p.toFixed(3)}, Holm alpha ${r.holmAlpha.toFixed(3)} lower bound ${money(r.lbHolm)}; prop-truncated ${money(r.meanT)}`);
    console.log(`  random-skip control mean ${money(r.randMean)} p95 ${money(r.randP95)}; placebo paired mean ${money(r.placeboMean)}, arm-minus-placebo 5% bound ${money(r.diffPlaceboLo)}; halves ${money(r.h1)} / ${money(r.h2)}; LONG ${money(r.L.m)} (n ${r.L.n}, se ${r.L.se.toFixed(1)}) SHORT ${money(r.S.m)} (n ${r.S.n}, se ${r.S.se.toFixed(1)}); worst loss B0 ${money(r.worstB0)} / S1' ${money(r.worstS1)}`);
    console.log('  checks: ' + checks.map((c) => `${c[1] ? 'ok' : 'FAIL'} ${c[0]}`).join('; ') + `\n  VERDICT ${verdict}\n`);
  }
  if (!noRecord) {
    await recordClaim({ slug: 'flush_box_width_skip_20261109', sourceFile: 'scripts/study_flush_box_width_skip_20261109.mjs', sourceDate: '2026-11-09', sampleSize: results.reduce((s, r) => s + r.N, 0),
      claimText: 'RESULT of the frozen prereg docs/FLUSH_BOX_WIDTH_SKIP_PREREG_20261109.md (explore <= 2025-05-16, roll weeks excluded). ' + results.map((r) => `${r.g}: N ${r.N}, skipped ${r.skipped}, paired ${money(r.mean_d)} [${money(r.ci.lo)}, ${money(r.ci.hi)}], Holm lb ${money(r.lbHolm)}, vs random p95 ${money(r.randP95)} -> ${r.verdict}`).join(' | '),
      rigorStatus: results.every((r) => r.verdict === 'PASS') ? 'passed_prereg' : 'not_shown_or_inconclusive', status: 'PROVISIONAL' });
    console.log('claim recorded');
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
