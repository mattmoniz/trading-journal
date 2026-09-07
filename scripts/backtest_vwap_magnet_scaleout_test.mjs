// scripts/backtest_vwap_magnet_scaleout_test.mjs
// ═══════════════════════════════════════════════════════════════════════
// Clean, confound-controlled A/B: does a 2-leg scale-out (bank half at the
// calibrated T1, run the rest toward VWAP with a breakeven stop) beat the
// flat-T1 mechanism VWAP_MAGNET_LONG/SHORT actually use live?
//
// Both arms are built from the SAME trigger population (findVwapMagnetTriggers,
// shared inside backtest_unified.js) and the SAME calibrated stop/T1 distance
// (loadData()'s vwapMagnetCalib, sourced from performance_audit's OPTIMAL_STOP
// rows -- the same source acd.js's live INSERT reads). The only thing that
// differs between the two arms is the exit mechanism -- confound checklist
// item 1 ("do the two compared arms differ ONLY in the hypothesis variable").
//
// Why this needed a dedicated script rather than trusting backtest_unified.js's
// old numbers: OPEN_DECISION backtest_unified_detectors_systemic_divergence_20260907
// found detectVwapMagnet's scale-out simulation was ALSO still using a stale,
// pre-2026-08-02 hardcoded stop=30/target=20 -- so its EV number was confounded
// with an outdated entry geometry, not a clean read on the exit mechanism alone.
// backtest_unified.js has since been fixed to read live calibration for its own
// (flat, matches-live) production run; this script reuses those same fixed,
// exported functions (detectVwapMagnet, detectVwapMagnetScaleOut, resolve,
// resolveScaleOut, loadData) rather than reimplementing any of them.
//
// Not wired into anything live -- pure research. Writes a RESEARCH_CLAIM per
// direction via scripts/record_claim.mjs (CLAUDE.md hard rule: every tested
// research/exploratory claim gets recorded, positive or negative).
// ═══════════════════════════════════════════════════════════════════════

import {
  loadData, detectVwapMagnet, detectVwapMagnetScaleOut, resolve, resolveScaleOut, aggregate,
} from './backtest_unified.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { query } from '../server/db.js';

async function main() {
  const { barsByDate, dates, vwapStdByDate, vwapStdFallback, vwapMagnetCalib } = await loadData();
  // Trading-day date from the DB's own America/New_York clock, not JS's UTC
  // toISOString() -- the two disagree once past 8PM ET (CLAUDE.md hard rule).
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);

  const flatTrades = { LONG: [], SHORT: [] };
  const scaleOutTrades = { LONG: [], SHORT: [] };

  console.log('\nRunning flat-T1 vs 2-leg-scale-out detection on identical trigger population...');
  for (let di = 5; di < dates.length; di++) {
    const date = dates[di];
    const bars = barsByDate.get(date);
    if (!bars || !bars.length) continue;
    const vwapStd = vwapStdByDate.get(date);

    for (const fire of detectVwapMagnet(bars, vwapStd, vwapStdFallback, vwapMagnetCalib)) {
      const res = resolve(bars, fire.entryIdx, fire.direction, fire.entry, fire.stop, fire.target);
      flatTrades[fire.direction].push({ date, ...fire, ...res });
    }
    for (const fire of detectVwapMagnetScaleOut(bars, vwapStd, vwapStdFallback, vwapMagnetCalib)) {
      const res = resolveScaleOut(bars, fire.entryIdx, fire.direction, fire.entry, fire.t1Target, fire.target, fire.stop);
      scaleOutTrades[fire.direction].push({ date, ...fire, ...res });
    }
  }

  console.log('\n── VWAP MAGNET: FLAT T1 (live mechanism) vs 2-LEG SCALE-OUT (research) ──');
  for (const dir of ['LONG', 'SHORT']) {
    const flatN = flatTrades[dir].length, scaleN = scaleOutTrades[dir].length;
    if (flatN !== scaleN) {
      console.warn(`  WARNING: ${dir} flat N=${flatN} != scale-out N=${scaleN} -- both arms call the same findVwapMagnetTriggers(), populations should be identical. Investigate before trusting this comparison.`);
    }

    const flatStats = aggregate(flatTrades[dir]);
    const scaleStats = aggregate(scaleOutTrades[dir]);
    const flatRigor = computeRigor(flatTrades[dir], { dateField: 'date', pnlFn: t => t.pnl });
    const scaleRigor = computeRigor(scaleOutTrades[dir], { dateField: 'date', pnlFn: t => t.pnl });
    const delta = (scaleStats?.evPerTrade ?? 0) - (flatStats?.evPerTrade ?? 0);

    console.log(`\n${dir} (calib stop=${vwapMagnetCalib[dir]?.stop ?? 'fallback-30'}pt, T1=${vwapMagnetCalib[dir]?.target ?? 'fallback-20'}pt):`);
    console.log(`  FLAT (live):  N=${flatStats?.n ?? 0}  WR=${flatStats?.wr != null ? (flatStats.wr * 100).toFixed(1) + '%' : 'N/A'}  EV=$${flatStats?.evPerTrade?.toFixed(2) ?? 'N/A'}  stable=${flatRigor.stable}  clustered=${flatRigor.clustered} (top5=${flatRigor.top5DayPct}%)`);
    console.log(`  SCALE-OUT:    N=${scaleStats?.n ?? 0}  WR=${scaleStats?.wr != null ? (scaleStats.wr * 100).toFixed(1) + '%' : 'N/A'}  EV=$${scaleStats?.evPerTrade?.toFixed(2) ?? 'N/A'}  stable=${scaleRigor.stable}  clustered=${scaleRigor.clustered} (top5=${scaleRigor.top5DayPct}%)`);
    console.log(`  DELTA (scale-out minus flat): $${delta.toFixed(2)}/trade`);

    // "Positive" bar: scale-out beats flat, on a real sample, and the scale-out arm's own
    // chronological stability isn't just a day-clustering artifact -- matches this codebase's
    // standing N>=20 + not-clustered floor before anything gets called decisive.
    const positive = delta > 0 && (flatStats?.n ?? 0) >= 20 && !scaleRigor.clustered;

    await recordClaim({
      slug: `vwap_magnet_${dir.toLowerCase()}_scaleout_vs_flat_20260907`,
      claimText: `VWAP_MAGNET_${dir}: confound-controlled A/B of a 2-leg scale-out (bank half at calibrated T1=${vwapMagnetCalib[dir]?.target ?? 20}pt, run the rest toward VWAP w/ breakeven stop, capped at 100pt) against the flat-T1 mechanism live actually uses -- SAME trigger population (N=${flatStats?.n ?? 0} flat / N=${scaleStats?.n ?? 0} scale-out) and SAME calibrated stop=${vwapMagnetCalib[dir]?.stop ?? 30}pt/T1 for both arms, differing only in exit mechanism. Flat EV=$${flatStats?.evPerTrade?.toFixed(2)}/trade (WR=${flatStats?.wr != null ? (flatStats.wr * 100).toFixed(1) + '%' : 'N/A'}, stable=${flatRigor.stable}, clustered=${flatRigor.clustered}); scale-out EV=$${scaleStats?.evPerTrade?.toFixed(2)}/trade (WR=${scaleStats?.wr != null ? (scaleStats.wr * 100).toFixed(1) + '%' : 'N/A'}, stable=${scaleRigor.stable}, clustered=${scaleRigor.clustered}). Delta=$${delta.toFixed(2)}/trade. ${positive
        ? 'Scale-out beats flat on a real, non-clustered sample -- worth designing as a SHADOW-parallel observation mechanism (same precedent as step-trail/pitch-catch) before ever touching live P&L or wiring runner_trail_width/extend_target_level for this setup.'
        : 'Scale-out does NOT clear the bar (beats flat AND N>=20 AND not day-clustered) once the prior hardcoded-stop confound is removed -- do not build this live. backtest_unified.js\'s own detectVwapMagnet has already been reconciled to the flat mechanism (matches live exactly, reads the same OPTIMAL_STOP calibration).'}`,
      sourceFile: 'scripts/backtest_vwap_magnet_scaleout_test.mjs',
      sourceDate: today,
      sampleSize: flatStats?.n ?? 0,
      winRate: scaleStats?.wr ?? null,
      evPerTrade: delta,
      rigorStatus: scaleRigor.clustered ? 'clustered' : (scaleRigor.stable ? 'clean' : 'unstable'),
      status: positive ? 'PROVISIONAL' : 'REJECTED',
      extra: {
        flatEv: flatStats?.evPerTrade ?? null, scaleOutEv: scaleStats?.evPerTrade ?? null,
        flatN: flatStats?.n ?? 0, scaleOutN: scaleStats?.n ?? 0,
        flatRigor, scaleRigor,
      },
    });
  }

  console.log('\nRESEARCH_CLAIM rows written for both directions. Run `node scripts/record_claim.mjs --list` to view.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
