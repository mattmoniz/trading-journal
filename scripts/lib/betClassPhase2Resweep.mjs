/**
 * Shared core for the roster-rebuild roadmap's Phase 2 "consolidated resweep" — pool every
 * real trade for one bet_class, sweep stop/target on the uncensored bar-history surface
 * (reusing update_optimal_stops.mjs's shared chronological primitives), and walk-forward
 * validate against a flat volatility-scaled default. Extracted 2026-08-11 after being
 * written once for bet_class='VALUE_FADE' (scripts/backtest_value_fade_bet_class_phase2.mjs)
 * and about to be hand-copied a second time for 'CONTINUATION_LEGACY' — the exact
 * "share modules instead of reimplementing" pattern CLAUDE.md documents being caught (and
 * missed) repeatedly elsewhere in this codebase. Both bet_class scripts are now thin
 * wrappers that supply their own Stage 0 pre-registration text and call this.
 *
 * See scripts/backtest_value_fade_bet_class_phase2.mjs's original header for the full
 * Stage 0 methodology writeup (population/exit/gates/pre-registered thresholds) — this
 * module implements that methodology generically, parameterized on bet_class.
 */

import { query } from '../../server/db.js';
import pool from '../../server/db.js';
import { LIVE_INSTRUMENT } from '../../server/config/instruments.js';
import { inferDirection } from '../../server/config/setupTypes.js';
import { makeBarIndex } from '../../server/services/targetCalibrationService.js';
import { computeRigor } from '../../server/services/rigorDiagnostics.js';
import {
  precomputeCrossovers, computeEvAtStopTargetChronological,
  sweepOptimalStopAndTargetChronological, uncensoredMaeCandidates,
  computeVolatilityDefaultRatios, TARGET_SWEEP, DEFAULT_DPP,
} from '../update_optimal_stops.mjs';
import { recordClaim } from '../record_claim.mjs';

const MIN_N = 20;
const FOLD_DAYS = 7; // weekly folds -- real history is only weeks long so far, not months
const MAX_T = TARGET_SWEEP[TARGET_SWEEP.length - 1]; // 150pt, same ceiling used everywhere else
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

function cumulativeStats(pnls) {
  let cum = 0, peak = 0, maxDD = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  return { totalPnl: +cum.toFixed(2), maxDrawdown: +maxDD.toFixed(2), returnToDD: maxDD > 0 ? +(cum / maxDD).toFixed(2) : null };
}

// betClass: 'VALUE_FADE' | 'CONTINUATION_LEGACY'. claimSlug/scriptFile/decisionSlug/
// mechanismNote/regimeNote: per-bet_class strings for the Stage 0 write-up embedded in the
// persisted RESEARCH_CLAIM (each caller supplies its own -- the mechanism/regime dependence
// genuinely differ between a mean-reversion and a continuation bet, this module doesn't
// guess at that text).
export async function runBetClassPhase2Resweep({ betClass, claimSlug, scriptFile, decisionSlug, mechanismNote, regimeNote }) {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  console.log(`[bet_class_phase2] ${betClass} consolidated resweep — ${today}\n`);

  // ── 1. Population.
  const tradesQ = await query(`
    SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float,
      fired_at, entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
      AND origin_status IN ('ACTIVE', 'SHADOW')
      AND bet_class = $1
    ORDER BY fired_at ASC
  `, [betClass]);

  let trades = tradesQ.rows.map(t => ({ ...t, direction: inferDirection(t.setup_type), entry: t.entry_zone_high ?? t.entry_zone_low }));
  const totalFetched = trades.length;
  const noDirection = trades.filter(t => !t.direction).length;
  trades = trades.filter(t => t.direction && t.entry != null);
  console.log(`Loaded ${totalFetched} real ${betClass} trades; ${noDirection} dropped (no inferable direction); ${trades.length} usable.`);

  if (trades.length < MIN_N) {
    console.log(`\n[bet_class_phase2] ${betClass}: only ${trades.length} usable trades (< MIN_N=${MIN_N}) -- too thin to resweep. Skipping.`);
    await pool.end();
    return { skipped: true, reason: 'insufficient_usable_trades', n: trades.length };
  }

  // ── 2. Bar history + barIdx attachment.
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));
  const firstIndexAfter = makeBarIndex(allBars);
  for (const t of trades) t.barIdx = firstIndexAfter(new Date(t.fired_at).getTime());
  const beforeBarFilter = trades.length;
  trades = trades.filter(t => t.barIdx < allBars.length);
  console.log(`${allBars.length} NQ bars loaded; ${beforeBarFilter - trades.length} trades dropped (fired after last available bar); ${trades.length} usable.\n`);

  // ── 3. Noise floor.
  const medianBarRangeRes = await query(`
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (high - low)) as median_range
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW() - INTERVAL '30 days'
  `);
  const medianBarRange = +medianBarRangeRes.rows[0].median_range;
  const NOISE_FLOOR_PT = 1.5 * medianBarRange;
  console.log(`Median 1-min NQ bar range (trailing 30d): ${medianBarRange.toFixed(2)}pt. Noise floor: ${NOISE_FLOOR_PT.toFixed(2)}pt.\n`);

  // ── 4. Full-sample (in-sample) uncensored sweep.
  const fullMaeCandidates = uncensoredMaeCandidates(trades, allBars, NOISE_FLOOR_PT);
  const inSample = sweepOptimalStopAndTargetChronological(trades, allBars, fullMaeCandidates, MAX_T, DEFAULT_DPP, DEFAULT_DPP, COMMISSION);
  console.log('In-sample (full-N, uncensored, chronological) sweep:', inSample);

  // ── 5. Flat volatility-scaled default -- current system-wide ratio, not fit to this data.
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

  // ── 6. Weekly walk-forward.
  const minTs = trades[0].fired_at instanceof Date ? trades[0].fired_at.getTime() : new Date(trades[0].fired_at).getTime();
  const weekOf = (t) => Math.floor(((t.fired_at instanceof Date ? t.fired_at.getTime() : new Date(t.fired_at).getTime()) - minTs) / (FOLD_DAYS * 86400000));
  for (const t of trades) t.weekIdx = weekOf(t);
  const maxWeek = Math.max(...trades.map(t => t.weekIdx));

  const oos = [];
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
    if (calStop == null || calTarget == null) continue;

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

  // ── 7. Regime-tag coverage.
  const regimeCovQ = await query(`
    SELECT COUNT(*) n, COUNT(*) FILTER (WHERE day_type_at_fire IS NOT NULL) tagged
    FROM active_setups WHERE bet_class=$1 AND origin_status IN ('ACTIVE','SHADOW')
  `, [betClass]);
  const regimeCoverage = regimeCovQ.rows[0];

  console.log('\n=== RESULTS ===');
  console.log(`In-sample full-N sweep: stop=${inSample?.stop} target=${inSample?.target} EV=$${inSample?.ev?.toFixed(2)} (N=${inSample?.n})`);
  console.log(`Walk-forward OOS (calibrated): N=${calPnls.length} EV=$${walkForwardEv?.toFixed(2)} WR=${(walkForwardWr * 100).toFixed(1)}% total=$${calStats.totalPnl} maxDD=$${calStats.maxDrawdown} retToDD=${calStats.returnToDD}`);
  console.log(`Walk-forward OOS (flat default ${flatStop}/${flatTarget}): N=${flatPnls.length} EV=$${flatEv?.toFixed(2)} WR=${flatWr != null ? (flatWr * 100).toFixed(1) + '%' : 'n/a'} total=$${flatStats?.totalPnl} maxDD=$${flatStats?.maxDrawdown} retToDD=${flatStats?.returnToDD}`);
  console.log(`Rigor (calibrated): clean=${rigor.clean} top5DayPct=${rigor.top5DayPct} thirds=${JSON.stringify(rigor.thirds)}`);
  console.log(`Rigor (flat): clean=${flatRigor?.clean} top5DayPct=${flatRigor?.top5DayPct}`);
  console.log(`Regime-tag coverage: ${regimeCoverage.tagged}/${regimeCoverage.n} (${(100 * regimeCoverage.tagged / regimeCoverage.n).toFixed(1)}%) — expected near-zero, I1 shipped 2026-08-10`);

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
    stage0_bet_class: betClass,
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
    limitation: `Real history spans only ~${Math.round((trades[trades.length-1].fired_at - trades[0].fired_at) / 86400000)} days -- weekly folds used instead of the roadmap's monthly framing; ${foldLog.length} OOS folds is thin, revisit at monthly cadence once real history extends past a few months.`,
    recommendation,
  };

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
    VALUES ($1, 0, 'BET_CLASS_RESWEEP', $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size=$3, win_rate=$4, ev_per_trade=$5, total_pnl=$6, recommendation=$7, notes=$8
  `, [today, betClass, calPnls.length, walkForwardWr != null ? +(walkForwardWr * 100).toFixed(1) : null, walkForwardEv != null ? +walkForwardEv.toFixed(2) : null, calStats.totalPnl, recommendation, JSON.stringify(notes)]);

  await recordClaim({
    slug: claimSlug,
    claimText: `Roadmap Phase 2 Stage 1 backtest for bet_class=${betClass} (${trades.length} real, origin_status-filtered trades, ${today}). ${mechanismNote} In-sample full-N uncensored chronological sweep: stop=${inSample?.stop}pt target=${inSample?.target}pt EV=$${inSample?.ev?.toFixed(2)}/trade (N=${inSample?.n}). Weekly walk-forward (${foldLog.length} OOS folds, real history is only a few weeks so monthly folds aren't yet meaningful): calibrated arm N=${calPnls.length} EV=$${walkForwardEv?.toFixed(2)}/trade, flat-volatility-default arm (stop=${flatStop}/target=${flatTarget}) EV=$${flatEv != null ? flatEv.toFixed(2) : 'n/a'}/trade. Verdict: ${recommendation}. Chronological stability (calibrated arm): ${rigor.clean === true ? 'clean' : rigor.clean === false ? 'UNSTABLE/clustered' : 'n/a'} (top5day%=${rigor.top5DayPct}). ${regimeNote} Deliberately does NOT change any live stop/target -- answers Phase 2's checkpoint question only.${decisionSlug ? ` See OPEN_DECISION ${decisionSlug}.` : ''}`,
    sourceFile: scriptFile,
    sourceDate: today,
    sampleSize: calPnls.length,
    winRate: walkForwardWr != null ? +(walkForwardWr * 100).toFixed(1) : null,
    evPerTrade: walkForwardEv,
    rigorStatus: rigor.clean === true ? 'chronologically_stable' : rigor.clean === false ? 'unstable_clustered_thin_history' : 'not_checked',
    status: 'PROVISIONAL',
  });

  console.log(`\n[bet_class_phase2] ${betClass}: wrote performance_audit BET_CLASS_RESWEEP row + RESEARCH_CLAIM. Done.`);
  await pool.end();
  return { skipped: false, recommendation, walkForwardEv, flatEv, rigorClean: rigor.clean, n: calPnls.length };
}
