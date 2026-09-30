// calibrate_touch_orderflow_pressure.mjs
// ═══════════════════════════════════════════════════════════════════════
// Self-recalibrating cutoff for server/services/touchOrderflowPressureShadow.js's
// SHADOW-only tag. Weekly (run_weekly_backtests.sh). Never hardcodes the cutoff --
// derives it, then WALK-FORWARD VALIDATES it (chronological first-half train, second-
// half test) before writing recommendation='GATE'. If the test half doesn't hold up,
// writes 'NO_GATE' instead and the shadow tagger stays disabled (fail-closed).
//
// Backing research: scratch/orderflow_touch_time_entry_selection_phase0_20260927.mjs +
// scratch/orderflow_touch_time_walkforward_sim_20260927.mjs (the one-time proof this
// pattern is real). This script is the ongoing, self-recalibrating version of that
// one-time check -- see RESEARCH_CLAIM orderflow_touch_time_adverse_pressure_worse_
// outcome_20260927.
//
// Output: performance_audit signal_type='TOUCH_ORDERFLOW_PRESSURE_CALIB', signal_name='_GLOBAL'
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import { POOLED_TRADE_FILTER } from './backtest_setup_status.mjs';
import { resolveDirection } from '../server/config/setupTypes.js';
import { computeApproachOrderflow } from '../server/services/touchOrderflowPressureShadow.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const MIN_N = 20;
const MIN_DISTINCT_DATES = 20;

async function run() {
  console.log('Loading real decisive touches...');
  const touches = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at::text as fired_at,
           stop_level, t1_level, actual_pnl::float as pnl, resolution
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT') AND actual_pnl IS NOT NULL AND ${POOLED_TRADE_FILTER}
    ORDER BY fired_at
  `);
  console.log(`  ${touches.rows.length} real decisive touches`);

  const events = [];
  for (const t of touches.rows) {
    const dir = resolveDirection(t);
    if (!dir) continue;
    const measure = await computeApproachOrderflow({ direction: dir, beforeTs: t.fired_at });
    if (!measure) continue;
    events.push({ date: t.trade_date, pnl: t.pnl, netAdverseDelta: measure.netAdverseDelta, setupType: t.setup_type });
  }
  console.log(`  ${events.length} events with usable approach-window bar history`);

  const dates = [...new Set(events.map(e => e.date))].sort();
  console.log(`  ${dates.length} distinct real dates (${dates[0]} to ${dates[dates.length - 1]})`);

  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  // Walk-forward: derive the cutoff from the FIRST half of real dates only, validate
  // against the SECOND half (never used to pick the threshold).
  const mid = Math.floor(dates.length / 2);
  const trainDates = new Set(dates.slice(0, mid));
  const testDates = new Set(dates.slice(mid));
  const trainEvents = events.filter(e => trainDates.has(e.date));
  const testEvents = events.filter(e => testDates.has(e.date));

  const trainSorted = [...trainEvents].sort((a, b) => a.netAdverseDelta - b.netAdverseDelta);
  const trainThird = Math.floor(trainSorted.length / 3);
  // softCutoffCandidate added 2026-09-29 (DeepSeek design-critique audit): the live tagger's
  // wouldHalfSize used to just copy wouldSkip (no independent soft tier at all -- see
  // touchOrderflowPressureShadow.js's own header for the incident). This derives a genuine
  // 3-tier structure (bottom third = favorable, middle third = soft/half-size, top third =
  // hard/skip) from the SAME already-derived tercile boundaries, rather than picking an
  // arbitrary percentile -- soft = the 1/3 boundary, hard = the existing 2/3 boundary.
  const softCutoffCandidate = trainSorted[trainThird]?.netAdverseDelta;
  const cutoffCandidate = trainSorted[2 * trainThird]?.netAdverseDelta;

  let recommendation = 'NO_GATE';
  let testFlaggedN = 0, testFlaggedEv = null, testUnflaggedEv = null, testDistinctDates = 0, rigor = null;
  let softRecommendation = 'NO_SOFT_GATE';
  let testMidN = 0, testMidEv = null, testLowEv = null;
  if (cutoffCandidate != null) {
    const testFlagged = testEvents.filter(e => e.netAdverseDelta >= cutoffCandidate);
    const testUnflagged = testEvents.filter(e => e.netAdverseDelta < cutoffCandidate);
    testFlaggedN = testFlagged.length;
    testDistinctDates = new Set(testFlagged.map(e => e.date)).size;
    if (testFlagged.length > 0 && testUnflagged.length > 0) {
      testFlaggedEv = mean(testFlagged.map(e => e.pnl));
      testUnflaggedEv = mean(testUnflagged.map(e => e.pnl));
      rigor = computeRigor(testFlagged, { dateField: 'date', pnlFn: e => e.pnl });
      const holds = testFlaggedN >= MIN_N && testDistinctDates >= MIN_DISTINCT_DATES && testFlaggedEv < testUnflaggedEv;
      if (holds) recommendation = 'GATE';
    }
  }
  // Soft-tier walk-forward check: the middle tercile only earns a half-size penalty (rather
  // than being folded into "favorable") if its held-out test EV genuinely sits BETWEEN the low
  // tercile's and the hard-flagged tercile's -- i.e. real, monotonic degradation across all
  // three tiers, not noise. testMidN/testMidEv reused as the soft tier's own stored numbers.
  if (softCutoffCandidate != null && cutoffCandidate != null && softCutoffCandidate < cutoffCandidate) {
    const testLow = testEvents.filter(e => e.netAdverseDelta < softCutoffCandidate);
    const testMid = testEvents.filter(e => e.netAdverseDelta >= softCutoffCandidate && e.netAdverseDelta < cutoffCandidate);
    testMidN = testMid.length;
    if (testLow.length > 0 && testMid.length > 0 && testFlaggedEv != null) {
      testLowEv = mean(testLow.map(e => e.pnl));
      testMidEv = mean(testMid.map(e => e.pnl));
      const monotonic = testLowEv > testMidEv && testMidEv > testFlaggedEv;
      if (monotonic && testMidN >= MIN_N) softRecommendation = 'SOFT_GATE';
    }
  }
  console.log(`\nTRAIN N=${trainEvents.length} (${trainDates.size} dates) -> hard cutoff=${cutoffCandidate?.toFixed(1)}, soft cutoff=${softCutoffCandidate?.toFixed(1)}`);
  console.log(`TEST (held out): flagged N=${testFlaggedN}/${testDistinctDates} dates, EV=$${testFlaggedEv?.toFixed(2)} vs unflagged EV=$${testUnflaggedEv?.toFixed(2)}`);
  console.log(`TEST soft tier: mid N=${testMidN}, EV low=$${testLowEv?.toFixed(2)} / mid=$${testMidEv?.toFixed(2)} / high(hard)=$${testFlaggedEv?.toFixed(2)}`);
  console.log(`Recommendation: ${recommendation} (soft: ${softRecommendation})`);

  // Final cutoffs for the LIVE tagger: recompute on the FULL population (train+test) now
  // that walk-forward validation has passed -- more data, same tercile method.
  const fullSorted = [...events].sort((a, b) => a.netAdverseDelta - b.netAdverseDelta);
  const fullThird = Math.floor(fullSorted.length / 3);
  const finalCutoff = fullSorted[2 * fullThird]?.netAdverseDelta ?? null;
  const finalSoftCutoff = fullSorted[fullThird]?.netAdverseDelta ?? null;

  const runDate = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
    VALUES ($1, 0, 'TOUCH_ORDERFLOW_PRESSURE_CALIB', '_GLOBAL', $2, $3, $4, $5)
    ON CONFLICT (run_date, window_days, signal_type, signal_name)
    DO UPDATE SET sample_size=$2, ev_per_trade=$3, recommendation=$4, notes=$5
  `, [
    runDate, events.length, testFlaggedEv, recommendation,
    JSON.stringify({
      cutoff: finalCutoff, trainCutoff: cutoffCandidate, distinctDates: dates.length,
      testFlaggedN, testDistinctDates, testFlaggedEv, testUnflaggedEv,
      rigor: rigor ? { distinctDates: rigor.distinctDates, top5DayPct: rigor.top5DayPct, clustered: rigor.clustered, stable: rigor.stable } : null,
      softCutoff: finalSoftCutoff, softTrainCutoff: softCutoffCandidate, softRecommendation,
      testMidN, testLowEv, testMidEv,
    }),
  ]);
  console.log(`\nWrote TOUCH_ORDERFLOW_PRESSURE_CALIB/_GLOBAL: recommendation=${recommendation}, live cutoff=${finalCutoff?.toFixed(1)}, soft=${softRecommendation}/${finalSoftCutoff?.toFixed(1)}`);
}

run().then(() => { console.log('\nDone.'); process.exit(0); })
  .catch(err => { console.error('Fatal:', err); process.exit(1); });
