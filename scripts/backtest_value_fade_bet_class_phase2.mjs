/**
 * Roster-rebuild roadmap Phase 2 — Setup A (Value Fade) consolidation.
 * scratch/MASTER_OPUS_ROSTER_REBUILD_ROADMAP.md Part 3 "Setup A" / Part 6 "Phase 2".
 *
 * STAGE 0 PRE-REGISTRATION (written before this script was run — see Part 5 Stage 0,
 * "a hypothesis formed after seeing the result is not a hypothesis." Setup A is a
 * consolidation of an already-running roster, not a from-scratch idea, so this is
 * necessarily somewhat retrospective — but the specific numeric question below had not
 * been asked at bet_class-pooled N before this script existed):
 *
 *   Bet: price returns to established value (any of the ~166 existing *_FADE-family
 *     level types, pooled as ONE bet_class='VALUE_FADE' population) after extending
 *     away from it.
 *   Mechanism: mean reversion. Expected to work on BALANCE days, expected to lose on
 *     TREND days (roadmap 1.3/3-A) — day_type_at_fire tagging just shipped today
 *     (2026-08-10) so this run cannot condition on it yet; see the regime-coverage
 *     section below.
 *   Entry/exit/gates: entry = whatever the live candidate array already fires on
 *     (unchanged by this script); exit = a stop/target pair swept from the UNCENSORED
 *     bar-history surface (server/services/targetCalibrationService.js /
 *     update_optimal_stops.mjs's shared chronological-sweep primitives — imported, not
 *     reimplemented, per roadmap Part 7 failure-mode #1 and CLAUDE.md's "export the
 *     real function" rule), never derived from the setup's own already-resolved
 *     mae_points/mfe_points (right-censored by whatever stop was live at the time).
 *   Population: origin_status IN ('ACTIVE','SHADOW') only — BACKFILL/UNKNOWN excluded,
 *     per CLAUDE.md's standing origin_status rule.
 *   Pre-registered success threshold: a walk-forward out-of-sample EV > $0/trade that
 *     (a) beats the flat volatility-scaled default (computeVolatilityDefaultRatios —
 *     "if the flat version wins, the calibration is overfitting and the setup ships
 *     flat," roadmap Stage 1) and (b) is sign-stable across the 3 chronological thirds
 *     of the OOS sample (computeRigor, imported).
 *   Pre-registered kill condition: OOS EV <= $0/trade under BOTH the calibrated and
 *     flat arms — i.e. the fade thesis does not hold at bet_class-pooled N even at an
 *     affordable (noise-floor-respecting, non-overfit) stop. This would corroborate,
 *     not just repeat, the existing raw finding (real EV=-$2.49/trade, unswept,
 *     RESEARCH_CLAIM bet_class_value_fade_phase2_readiness) at a properly calibrated
 *     stop/target instead of whatever each setup_type's own live params happened to be.
 *   Known limitation, stated up front rather than discovered after: real
 *     (origin_status-filtered) history only spans ~5 weeks (origin_status tracking
 *     itself only began 2026-07-17, and VALUE_FADE's own real rows start 2026-07-08) —
 *     nowhere near the roadmap's "months 1..T, roll" framing, which assumes a much
 *     longer history. This run uses WEEKLY (not monthly) walk-forward folds as the
 *     closest honest analog given the actual data available, explicitly flagged as
 *     thin (~4-5 OOS folds) rather than silently forcing a monthly cadence that would
 *     produce 0-1 real folds. Re-run at monthly cadence once real history extends past
 *     a few months — this script's fold width is a named constant, not hardcoded logic,
 *     specifically so that re-run is a one-line change.
 *   Correlation: N/A for this run — Setup A is the pre-existing base roster, not being
 *     compared against a sibling Setup B-F yet (those don't exist).
 *
 * What this script does NOT do: it does not touch any live stop/target lookup, does not
 * change what fires live, and does not retire any individual setup_type. It answers the
 * roadmap's Phase 2 checkpoint question ("a defensible number for VALUE_FADE EV at an
 * affordable stop, from real data, with N in the hundreds") and persists it so the next
 * decision (start Setup B, wire a bet_class-level live calibration, or stop here) has a
 * real number to act on. See OPEN_DECISION bet_class_phase2_consolidated_resweep_not_started.
 *
 * Writes performance_audit rows with signal_type='BET_CLASS_RESWEEP', signal_name=
 * 'VALUE_FADE', and a RESEARCH_CLAIM (value_fade_bet_class_phase2_stage1_backtest).
 * Run: node scripts/backtest_value_fade_bet_class_phase2.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { makeBarIndex, WALK_WINDOW_BARS } from '../server/services/targetCalibrationService.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import {
  precomputeCrossovers, computeEvAtStopTargetChronological,
  sweepOptimalStopAndTargetChronological, uncensoredMaeCandidates,
  computeVolatilityDefaultRatios, percentileOf, TARGET_SWEEP, DEFAULT_DPP,
} from './update_optimal_stops.mjs';
import { recordClaim } from './record_claim.mjs';

const MIN_N = 20;
const FOLD_DAYS = 7; // weekly folds — see Stage 0 note above on why not monthly yet
const MAX_T = TARGET_SWEEP[TARGET_SWEEP.length - 1]; // 150pt, same ceiling used everywhere else
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

function cumulativeStats(pnls) {
  let cum = 0, peak = 0, maxDD = 0;
  const curve = [];
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    curve.push(cum);
  }
  const total = cum;
  return { totalPnl: +total.toFixed(2), maxDrawdown: +maxDD.toFixed(2), returnToDD: maxDD > 0 ? +(total / maxDD).toFixed(2) : null };
}

async function run() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  console.log(`[bet_class_phase2] VALUE_FADE consolidated resweep — ${today}\n`);

  // ── 1. Population: real VALUE_FADE trades, same shape as update_optimal_stops.mjs's
  // rawByTypeExpanded (mae/mfe sanity bound, origin_status-filtered), scoped to
  // bet_class='VALUE_FADE' and pooled across every setup_type rather than grouped.
  const tradesQ = await query(`
    SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float,
      fired_at, entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
      AND origin_status IN ('ACTIVE', 'SHADOW')
      AND bet_class = 'VALUE_FADE'
    ORDER BY fired_at ASC
  `);

  let trades = tradesQ.rows.map(t => ({ ...t, direction: inferDirection(t.setup_type), entry: t.entry_zone_high ?? t.entry_zone_low }));
  const totalFetched = trades.length;
  const noDirection = trades.filter(t => !t.direction).length;
  trades = trades.filter(t => t.direction && t.entry != null);
  console.log(`Loaded ${totalFetched} real VALUE_FADE trades; ${noDirection} dropped (no inferable direction, e.g. ZONE_EDGE_FADE); ${trades.length} usable.`);

  // ── 2. Bar history + barIdx attachment.
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));
  const firstIndexAfter = makeBarIndex(allBars);
  for (const t of trades) t.barIdx = firstIndexAfter(new Date(t.fired_at).getTime());
  const beforeBarFilter = trades.length;
  trades = trades.filter(t => t.barIdx < allBars.length);
  console.log(`${allBars.length} NQ bars loaded; ${beforeBarFilter - trades.length} trades dropped (fired after last available bar); ${trades.length} usable.\n`);

  // ── 3. Noise floor (same convention as update_optimal_stops.mjs).
  const medianBarRangeRes = await query(`
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (high - low)) as median_range
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW() - INTERVAL '30 days'
  `);
  const medianBarRange = +medianBarRangeRes.rows[0].median_range;
  const NOISE_FLOOR_PT = 1.5 * medianBarRange;
  console.log(`Median 1-min NQ bar range (trailing 30d): ${medianBarRange.toFixed(2)}pt. Noise floor: ${NOISE_FLOOR_PT.toFixed(2)}pt.\n`);

  // ── 4. Full-sample (in-sample) uncensored sweep — the direct "what is the EV of
  // VALUE_FADE at an affordable stop, at a sample size that can answer it" number.
  const fullMaeCandidates = uncensoredMaeCandidates(trades, allBars, NOISE_FLOOR_PT);
  const inSample = sweepOptimalStopAndTargetChronological(trades, allBars, fullMaeCandidates, MAX_T, DEFAULT_DPP, DEFAULT_DPP, COMMISSION);
  console.log('In-sample (full-N, uncensored, chronological) sweep:', inSample);

  // ── 5. Flat volatility-scaled default — current system-wide ratio, NOT fit to this
  // data (that's what makes it "flat"), evaluated against the exact same OOS trades as
  // the calibrated arm below for a fair comparison.
  const priorRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type = 'OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const priorStoredByType = {};
  for (const p of priorRes.rows) priorStoredByType[p.signal_name] = { stop: p.optimal_stop != null ? +p.optimal_stop : null, target: p.optimal_target != null ? +p.optimal_target : null };
  const realNRes = await query(`
    SELECT setup_type, COUNT(*) n FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
    GROUP BY setup_type
  `);
  const realNByType = Object.fromEntries(realNRes.rows.map(r => [r.setup_type, +r.n]));
  const { volScaleRatio, targetStopRatio, canComputeVolDefault, qualifyingCount } =
    computeVolatilityDefaultRatios({ priorStoredByType, realNByType, medianBarRange, minN: MIN_N });
  let flatStop = null, flatTarget = null;
  if (canComputeVolDefault) {
    flatStop = Math.round(volScaleRatio * medianBarRange);
    flatTarget = Math.round(flatStop * targetStopRatio);
  }
  console.log(`Flat volatility-scaled default: ${canComputeVolDefault ? `stop=${flatStop}pt target=${flatTarget}pt (from ${qualifyingCount} qualifying types)` : 'UNAVAILABLE (no qualifying types)'}\n`);

  // ── 6. Weekly walk-forward. minDate anchors week 0; fold w evaluates trades fired in
  // [minDate + w*FOLD_DAYS, minDate + (w+1)*FOLD_DAYS) using a fit trained on every trade
  // strictly BEFORE that window (roadmap: "fit on months 1..T, apply to T+1, roll").
  const minTs = trades[0].fired_at instanceof Date ? trades[0].fired_at.getTime() : new Date(trades[0].fired_at).getTime();
  const weekOf = (t) => Math.floor(((t.fired_at instanceof Date ? t.fired_at.getTime() : new Date(t.fired_at).getTime()) - minTs) / (FOLD_DAYS * 86400000));
  for (const t of trades) t.weekIdx = weekOf(t);
  const maxWeek = Math.max(...trades.map(t => t.weekIdx));

  const oos = []; // { date, calibratedPnl, flatPnl, foldStop, foldTarget, usedFlatForCalibrated }
  const foldLog = [];
  for (let w = 1; w <= maxWeek; w++) {
    const trainTrades = trades.filter(t => t.weekIdx < w);
    const testTrades = trades.filter(t => t.weekIdx === w);
    if (!testTrades.length) continue;
    let fit = null;
    if (trainTrades.length >= MIN_N) {
      const trainMaeCandidates = uncensoredMaeCandidates(trainTrades, allBars, NOISE_FLOOR_PT);
      fit = sweepOptimalStopAndTargetChronological(trainTrades, allBars, trainMaeCandidates, MAX_T, DEFAULT_DPP, DEFAULT_DPP, COMMISSION);
    }
    const usedFlatForCalibrated = !!(!fit || fit.insufficientBarData);
    const calStop = usedFlatForCalibrated ? flatStop : fit.stop;
    const calTarget = usedFlatForCalibrated ? flatTarget : fit.target;
    foldLog.push({ week: w, trainN: trainTrades.length, testN: testTrades.length, fitStop: calStop, fitTarget: calTarget, usedFlatForCalibrated });
    if (calStop == null || calTarget == null) continue; // no fit AND no flat default available -- skip fold entirely

    for (const t of testTrades) {
      const stopSet = flatStop != null ? [...new Set([calStop, flatStop])] : [calStop];
      const targetSet = flatTarget != null ? [...new Set([calTarget, flatTarget])] : [calTarget];
      const cx = precomputeCrossovers(t, allBars, stopSet, targetSet);
      if (!cx) continue;
      const calibratedPnl = computeEvAtStopTargetChronological(cx, calStop, calTarget, DEFAULT_DPP, DEFAULT_DPP, COMMISSION);
      const flatPnl = flatStop != null ? computeEvAtStopTargetChronological(cx, flatStop, flatTarget, DEFAULT_DPP, DEFAULT_DPP, COMMISSION) : null;
      oos.push({ date: t.fired_at instanceof Date ? t.fired_at.toISOString().slice(0, 10) : new Date(t.fired_at).toISOString().slice(0, 10), setup_type: t.setup_type, calibratedPnl, flatPnl, foldStop: calStop, foldTarget: calTarget, usedFlatForCalibrated });
    }
  }
  console.log(`Walk-forward folds (${FOLD_DAYS}-day width): ${foldLog.length} folds, ${oos.length} OOS trade evaluations.`);
  console.table(foldLog);

  const calPnls = oos.map(o => o.calibratedPnl);
  const flatPnls = oos.filter(o => o.flatPnl != null).map(o => o.flatPnl);
  const walkForwardEv = mean(calPnls);
  const walkForwardWr = calPnls.length ? calPnls.filter(p => p > 0).length / calPnls.length : null;
  const flatEv = flatPnls.length ? mean(flatPnls) : null;
  const flatWr = flatPnls.length ? flatPnls.filter(p => p > 0).length / flatPnls.length : null;
  const calStats = cumulativeStats(calPnls);
  const flatStats = flatPnls.length ? cumulativeStats(flatPnls) : null;

  const rigor = computeRigor(oos, { dateField: 'date', pnlFn: o => o.calibratedPnl });
  const flatRigor = flatPnls.length ? computeRigor(oos.filter(o => o.flatPnl != null), { dateField: 'date', pnlFn: o => o.flatPnl }) : null;

  // ── 7. Regime-tag coverage (I1 shipped today — expect near-zero on this historical
  // population; reported honestly per Stage 0, not backfilled per roadmap I1's own rule).
  const regimeCovQ = await query(`
    SELECT COUNT(*) n, COUNT(*) FILTER (WHERE day_type_at_fire IS NOT NULL) tagged
    FROM active_setups WHERE bet_class='VALUE_FADE' AND origin_status IN ('ACTIVE','SHADOW')
  `);
  const regimeCoverage = regimeCovQ.rows[0];

  console.log('\n=== RESULTS ===');
  console.log(`In-sample full-N sweep: stop=${inSample?.stop} target=${inSample?.target} EV=$${inSample?.ev?.toFixed(2)} (N=${inSample?.n})`);
  console.log(`Walk-forward OOS (calibrated): N=${calPnls.length} EV=$${walkForwardEv?.toFixed(2)} WR=${(walkForwardWr * 100).toFixed(1)}% total=$${calStats.totalPnl} maxDD=$${calStats.maxDrawdown} retToDD=${calStats.returnToDD}`);
  console.log(`Walk-forward OOS (flat default ${flatStop}/${flatTarget}): N=${flatPnls.length} EV=$${flatEv?.toFixed(2)} WR=${flatWr != null ? (flatWr * 100).toFixed(1) + '%' : 'n/a'} total=$${flatStats?.totalPnl} maxDD=$${flatStats?.maxDrawdown} retToDD=${flatStats?.returnToDD}`);
  console.log(`Rigor (calibrated): clean=${rigor.clean} top5DayPct=${rigor.top5DayPct} thirds=${JSON.stringify(rigor.thirds)}`);
  console.log(`Rigor (flat): clean=${flatRigor?.clean} top5DayPct=${flatRigor?.top5DayPct}`);
  console.log(`Regime-tag coverage: ${regimeCoverage.tagged}/${regimeCoverage.n} (${(100 * regimeCoverage.tagged / regimeCoverage.n).toFixed(1)}%) — expected near-zero, I1 shipped today`);

  const calibratedBeatsFlat = flatEv == null || walkForwardEv > flatEv;
  const bothNegative = walkForwardEv <= 0 && (flatEv == null || flatEv <= 0);
  let recommendation;
  if (bothNegative) recommendation = 'NEGATIVE_EV_BOTH_ARMS';
  else if (calibratedBeatsFlat && walkForwardEv > 0) recommendation = 'SHIP_CALIBRATED';
  else if (!calibratedBeatsFlat && flatEv > 0) recommendation = 'SHIP_FLAT';
  else recommendation = 'AMBIGUOUS';
  console.log(`\nVerdict: ${recommendation}`);

  // ── 8. Persist.
  const notes = {
    stage0_bet_class: 'VALUE_FADE',
    population: { totalFetched, noDirectionDropped: noDirection, usable: trades.length, dateRange: [trades[0]?.fired_at, trades[trades.length - 1]?.fired_at] },
    noiseFloorPt: +NOISE_FLOOR_PT.toFixed(2), medianBarRangePt: +medianBarRange.toFixed(2),
    inSample: inSample ? { stop: inSample.stop, target: inSample.target, ev: +inSample.ev.toFixed(2), n: inSample.n } : null,
    flatDefault: canComputeVolDefault ? { stop: flatStop, target: flatTarget, qualifyingCount } : null,
    walkForward: {
      foldDays: FOLD_DAYS, folds: foldLog.length, foldLog,
      calibrated: { n: calPnls.length, ev: walkForwardEv != null ? +walkForwardEv.toFixed(2) : null, wr: walkForwardWr != null ? +(walkForwardWr * 100).toFixed(1) : null, ...calStats, rigor: { clean: rigor.clean, top5DayPct: rigor.top5DayPct, thirds: rigor.thirds } },
      flat: flatPnls.length ? { n: flatPnls.length, ev: +flatEv.toFixed(2), wr: +(flatWr * 100).toFixed(1), ...flatStats, rigor: { clean: flatRigor.clean, top5DayPct: flatRigor.top5DayPct, thirds: flatRigor.thirds } } : null,
    },
    regimeCoverage: { n: +regimeCoverage.n, tagged: +regimeCoverage.tagged },
    limitation: `Real history spans only ~${Math.round((trades[trades.length-1].fired_at - trades[0].fired_at) / 86400000)} days (origin_status tracking began 2026-07-17) -- weekly folds used instead of the roadmap's monthly framing; ${foldLog.length} OOS folds is thin, revisit at monthly cadence once real history extends past a few months.`,
    recommendation,
  };

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
    VALUES ($1, 0, 'BET_CLASS_RESWEEP', 'VALUE_FADE', $2, $3, $4, $5, $6, $7)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size=$2, win_rate=$3, ev_per_trade=$4, total_pnl=$5, recommendation=$6, notes=$7
  `, [today, calPnls.length, walkForwardWr != null ? +(walkForwardWr * 100).toFixed(1) : null, walkForwardEv != null ? +walkForwardEv.toFixed(2) : null, calStats.totalPnl, recommendation, JSON.stringify(notes)]);

  await recordClaim({
    slug: 'value_fade_bet_class_phase2_stage1_backtest',
    claimText: `Roadmap Phase 2 Stage 1 backtest for bet_class=VALUE_FADE (${trades.length} real, origin_status-filtered trades, ${today}). In-sample full-N uncensored chronological sweep: stop=${inSample?.stop}pt target=${inSample?.target}pt EV=$${inSample?.ev?.toFixed(2)}/trade (N=${inSample?.n}) -- this is the roadmap's "172-398pt question... at a sample size that can answer it," answered. Weekly walk-forward (${foldLog.length} OOS folds, real history only spans ~5 weeks so monthly folds aren't yet meaningful): calibrated arm N=${calPnls.length} EV=$${walkForwardEv?.toFixed(2)}/trade, flat-volatility-default arm (stop=${flatStop}/target=${flatTarget}) EV=$${flatEv != null ? flatEv.toFixed(2) : 'n/a'}/trade. Verdict: ${recommendation}. Chronological stability (calibrated arm): ${rigor.clean === true ? 'clean' : rigor.clean === false ? 'UNSTABLE/clustered' : 'n/a'} (top5day%=${rigor.top5DayPct}). Regime-tag coverage ${regimeCoverage.tagged}/${regimeCoverage.n} -- near-zero as expected since day_type_at_fire tagging (roadmap I1) shipped the same day, so this run cannot yet condition on BALANCE-vs-TREND; re-run once regime-tagged real N accumulates. Deliberately does NOT change any live stop/target -- answers Phase 2's checkpoint question only. See OPEN_DECISION bet_class_phase2_consolidated_resweep_not_started for the next decision this unblocks.`,
    sourceFile: 'scripts/backtest_value_fade_bet_class_phase2.mjs',
    sourceDate: today,
    sampleSize: calPnls.length,
    winRate: walkForwardWr != null ? +(walkForwardWr * 100).toFixed(1) : null,
    evPerTrade: walkForwardEv,
    rigorStatus: rigor.clean === true ? 'chronologically_stable' : rigor.clean === false ? 'unstable_clustered_thin_history' : 'not_checked',
    status: 'PROVISIONAL', // thin OOS fold count (~5 weekly folds) -- not CONFIRMED-grade yet, revisit at monthly cadence
  });

  console.log('\n[bet_class_phase2] wrote performance_audit BET_CLASS_RESWEEP row + RESEARCH_CLAIM. Done.');
  await pool.end();
}

run().catch(e => { console.error('[bet_class_phase2] ERROR:', e); process.exit(1); });
