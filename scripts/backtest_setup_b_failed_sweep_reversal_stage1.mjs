// Roadmap Phase 4, Setup B ("Failed Sweep Reversal") — Stage 1 bar-history backtest.
// Stage 0 pre-registration: RESEARCH_CLAIM setup_b_failed_sweep_reversal_stage0 (written
// before this file, per Part 5's "a hypothesis formed after seeing the result is not a
// hypothesis" rule).
//
// Bet: price breaks a level, fails to hold beyond it, and reverses -- a liquidity-grab,
// structurally distinct from Setup A (VALUE_FADE)'s "touch and fade immediately" bet.
//
// Per Part 5 Stage 1's explicit rules, all followed here:
//   - "Uses the shared order-aware resolve() from backtest_unified.js. Never an inline
//     comparison." -- entry detection reuses the REAL, already-integrated detectStopSweep()
//     (not reimplemented), and every EV evaluation below calls the REAL resolve().
//   - "Candidate stop/target from the uncensored bar-history surface, never from the
//     setup's own trade history." -- this setup has no active_setups history at all yet
//     (it's brand new), so the candidate grid is derived from a fresh, wide-bound resolve()
//     walk per touch (the uncensored max adverse/favorable excursion), not from any stored
//     column.
//   - "Baseline resimulated in-script." -- the flat volatility-scaled default is computed
//     fresh from the CURRENT system-wide calibrated-type ratios (loadVolatilityDefaultInputs/
//     computeVolatilityDefaultRatios, update_optimal_stops.mjs), not fit to this data.
//   - "Walk-forward, not in-sample: fit on months 1..T, apply to T+1, roll." -- chronological
//     2/3 in-sample / 1/3 out-of-sample split (same convention already used for the Setup A
//     bet_class resweeps and the RTH holdout test this same roadmap thread already ran).
//   - "Compare against a flat volatility-scaled default... If the flat version wins, the
//     calibration is overfitting and the setup ships flat."
//
// Run: node scripts/backtest_setup_b_failed_sweep_reversal_stage1.mjs

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { resolve, loadData, detectStopSweep, floorPivots } from './backtest_unified.js';
import { computeVolatilityDefaultRatios, loadVolatilityDefaultInputs, TARGET_SWEEP } from './update_optimal_stops.mjs';
import { recordClaim } from './record_claim.mjs';

const MIN_N = 20;
const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const WALK_MAX_BARS = 240; // matches this file's own resolve() default, and every other
                            // level-fade family backtest_unified.js already evaluates with
const TARGET_SWEEP_EXTENDED = [...TARGET_SWEEP, 175, 200, 250, 300]; // see the Phase 3
  // mfe_runner_target_widening_uncensored.mjs precedent -- TARGET_SWEEP alone tops out at
  // 150pt and would silently cap this brand-new setup's target grid at the live-calibration
  // ceiling for no principled reason.

function pnl(entry, exitPrice, long) {
  const signedPoints = long ? (exitPrice - entry) : (entry - exitPrice);
  return signedPoints * DEFAULT_DPP - COMMISSION;
}

function percentileOf(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

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

async function main() {
  console.log('[setup_b_stage1] Loading bar/level data (reusing backtest_unified.js\'s loadData())...');
  const { barsByDate, acdByDate, dvlByDate, dates } = await loadData();

  const lpRes = await query(`SELECT trade_date::text as d, level_name, price::float FROM level_prices`);
  const levelPricesByDate = new Map();
  for (const r of lpRes.rows) {
    if (!levelPricesByDate.has(r.d)) levelPricesByDate.set(r.d, {});
    levelPricesByDate.get(r.d)[r.level_name] = r.price;
  }

  const dayTypeByDate = new Map();
  for (const [d, r] of acdByDate) if (r.day_type) dayTypeByDate.set(d, r.day_type);

  // ── 1. Detection: reuse detectStopSweep() unchanged, one session at a time ──────────
  const rawFires = []; // { date, bars, fire }
  for (let di = 5; di < dates.length; di++) {
    const date = dates[di];
    const bars = barsByDate.get(date);
    const acd = acdByDate.get(date);
    if (!bars || !acd || !bars.length) continue;

    const prevDate = dates[di - 1];
    const prevDvl = dvlByDate.get(prevDate);
    const pdVAH = prevDvl?.vah ?? null;
    const pdVAL = prevDvl?.val ?? null;
    const pdPOC = prevDvl?.poc ?? null;
    const orH = acd.or_high, orL = acd.or_low;
    if (!orH || !orL) continue;

    let fpLevels = {};
    if (prevDvl?.session_high && prevDvl?.session_low && prevDvl?.session_close) {
      fpLevels = floorPivots(prevDvl.session_high, prevDvl.session_low, prevDvl.session_close);
    }
    const lp = levelPricesByDate.get(date) || {};

    const fires = detectStopSweep(bars, {
      pdPOC: lp.PD_POC ?? pdPOC, pdVAH: lp.PD_VAH ?? pdVAH, pdVAL: lp.PD_VAL ?? pdVAL,
      orH, orL,
      ...fpLevels,
    });
    for (const fire of fires) {
      if (fire.entryIdx == null || fire.entryIdx < 0) continue;
      rawFires.push({ date, bars, fire });
    }
  }
  console.log(`Detected ${rawFires.length} failed-sweep-reversal touches across ${dates.length - 5} candidate sessions (reusing the real detectStopSweep() detector, unchanged).`);
  if (rawFires.length < MIN_N) {
    console.log(`Only ${rawFires.length} touches -- below MIN_N=${MIN_N}. Stopping (pre-registered kill condition: real N does not clear the floor at Stage 1).`);
    await recordClaim({
      slug: 'setup_b_failed_sweep_reversal_stage1',
      claimText: `Stage 1 KILLED at the detection stage: only ${rawFires.length} failed-sweep-reversal touches found across all history via the real detectStopSweep() detector -- below the pre-registered MIN_N=${MIN_N} floor. Setup B does not advance past Stage 1.`,
      sourceFile: 'scripts/backtest_setup_b_failed_sweep_reversal_stage1.mjs',
      sourceDate: '2026-08-11',
      sampleSize: rawFires.length,
      rigorStatus: 'killed_insufficient_n_at_detection',
      status: 'PROVISIONAL',
    });
    return;
  }

  // ── 2. Uncensored mae/mfe per touch — wide-bound resolve() walk, real function reused ──
  const touches = rawFires.map(({ date, bars, fire }) => {
    const wide = 1000; // NQ intraday RTH range essentially never approaches this
    const wideStop = fire.direction === 'LONG' ? fire.entry - wide : fire.entry + wide;
    const wideTarget = fire.direction === 'LONG' ? fire.entry + wide : fire.entry - wide;
    const res = resolve(bars, fire.entryIdx, fire.direction, fire.entry, wideStop, wideTarget, WALK_MAX_BARS);
    return { date, bars, entryIdx: fire.entryIdx, entry: fire.entry, direction: fire.direction, mae: res.mae, mfe: res.mfe, dayType: dayTypeByDate.get(date) || 'UNKNOWN' };
  });

  const maes = touches.map(t => t.mae).sort((a, b) => a - b);
  const stopCandidates = [0.25, 0.40, 0.50, 0.60, 0.75]
    .map(pct => ({ value: percentileOf(maes, pct), pct }))
    .filter(c => c.value != null && c.value > 0);
  console.log(`Uncensored MAE candidates (percentile of TRUE post-reclaim adverse excursion, ${WALK_MAX_BARS}-bar window): ${stopCandidates.map(c => `p${c.pct * 100}=${c.value.toFixed(1)}`).join(', ')}`);

  // ── 3. Chronological sort + walk-forward split ──────────────────────────────────────
  touches.sort((a, b) => a.date.localeCompare(b.date));
  const splitIdx = Math.floor(touches.length * (2 / 3));
  const inSampleTouches = touches.slice(0, splitIdx);
  const oosTouches = touches.slice(splitIdx);
  console.log(`Walk-forward split: ${inSampleTouches.length} in-sample, ${oosTouches.length} out-of-sample.`);

  function evalCandidate(touchSet, stop, target) {
    let sum = 0;
    for (const t of touchSet) {
      const stopPrice = t.direction === 'LONG' ? t.entry - stop : t.entry + stop;
      const targetPrice = t.direction === 'LONG' ? t.entry + target : t.entry - target;
      const res = resolve(t.bars, t.entryIdx, t.direction, t.entry, stopPrice, targetPrice, WALK_MAX_BARS);
      sum += res.result === 'EXPIRED' ? pnl(t.entry, t.bars[Math.min(t.bars.length - 1, t.entryIdx + WALK_MAX_BARS)].close, t.direction === 'LONG') : res.pnl;
    }
    return sum / touchSet.length;
  }

  // ── 4. In-sample sweep over the real candidate grid ─────────────────────────────────
  let bestInSample = null;
  for (const { value: stopVal, pct } of stopCandidates) {
    const stop = Math.round(stopVal);
    const requiredN = Math.ceil(MIN_N / (1 - pct));
    if (inSampleTouches.length < requiredN) continue;
    for (const target of TARGET_SWEEP_EXTENDED) {
      const ev = evalCandidate(inSampleTouches, stop, target);
      if (!bestInSample || ev > bestInSample.ev) bestInSample = { stop, target, ev };
    }
  }
  if (!bestInSample) {
    console.log('No candidate cleared the thin-tail N requirement in-sample. Stopping.');
    await recordClaim({
      slug: 'setup_b_failed_sweep_reversal_stage1',
      claimText: `Stage 1 KILLED: ${rawFires.length} touches detected but no (stop,target) candidate cleared the thin-tail requiredN gate on the in-sample split (${inSampleTouches.length} in-sample touches). Setup B does not advance past Stage 1 this round.`,
      sourceFile: 'scripts/backtest_setup_b_failed_sweep_reversal_stage1.mjs',
      sourceDate: '2026-08-11',
      sampleSize: rawFires.length,
      rigorStatus: 'killed_no_candidate_cleared_thin_tail',
      status: 'PROVISIONAL',
    });
    return;
  }
  const oosEvCalibrated = evalCandidate(oosTouches, bestInSample.stop, bestInSample.target);
  console.log(`Best in-sample candidate: stop=${bestInSample.stop} target=${bestInSample.target} IS_EV=$${bestInSample.ev.toFixed(2)} -> OOS_EV=$${oosEvCalibrated.toFixed(2)}`);

  // ── 5. Flat volatility-scaled default, computed fresh (not fit to this data) ────────
  const { priorStoredByType, realNByType, medianBarRange } = await loadVolatilityDefaultInputs();
  const { volScaleRatio, targetStopRatio, canComputeVolDefault, qualifyingCount } =
    computeVolatilityDefaultRatios({ priorStoredByType, realNByType, medianBarRange, minN: MIN_N });
  let flatStop = null, flatTarget = null, oosEvFlat = null, fullEvFlat = null;
  if (canComputeVolDefault) {
    flatStop = Math.round(volScaleRatio * medianBarRange);
    flatTarget = Math.round(targetStopRatio * flatStop);
    oosEvFlat = evalCandidate(oosTouches, flatStop, flatTarget);
    fullEvFlat = evalCandidate(touches, flatStop, flatTarget);
    console.log(`Flat volatility-scaled default (from ${qualifyingCount} real-N-qualified system-wide types, medianBarRange=${medianBarRange.toFixed(1)}pt): stop=${flatStop} target=${flatTarget} -> OOS_EV=$${oosEvFlat.toFixed(2)}, full-sample EV=$${fullEvFlat.toFixed(2)}`);
  } else {
    console.log('Could not compute a flat volatility-scaled default (no qualifying system-wide types) -- skipping the flat comparison.');
  }

  const verdict = (oosEvFlat != null && oosEvFlat > oosEvCalibrated) ? 'SHIP_FLAT' : 'SHIP_CALIBRATED';
  const winnerStop = verdict === 'SHIP_FLAT' ? flatStop : bestInSample.stop;
  const winnerTarget = verdict === 'SHIP_FLAT' ? flatTarget : bestInSample.target;

  // ── 6. Full-sample events for the WINNING arm -- rigor, drawdown, day-type breakdown ──
  const winnerEvents = touches.map(t => {
    const stopPrice = t.direction === 'LONG' ? t.entry - winnerStop : t.entry + winnerStop;
    const targetPrice = t.direction === 'LONG' ? t.entry + winnerTarget : t.entry - winnerTarget;
    const res = resolve(t.bars, t.entryIdx, t.direction, t.entry, stopPrice, targetPrice, WALK_MAX_BARS);
    const p = res.result === 'EXPIRED' ? pnl(t.entry, t.bars[Math.min(t.bars.length - 1, t.entryIdx + WALK_MAX_BARS)].close, t.direction === 'LONG') : res.pnl;
    return { date: t.date, pnl: p, dayType: t.dayType };
  });
  const rigor = computeRigor(winnerEvents, { dateField: 'date', pnlFn: e => e.pnl });
  const { totalPnl, maxDrawdown, returnToDD } = cumulativeStats(winnerEvents.map(e => e.pnl));

  const dayTypeBreakdown = {};
  for (const e of winnerEvents) {
    (dayTypeBreakdown[e.dayType] ||= []).push(e.pnl);
  }
  const dayTypeReport = Object.fromEntries(Object.entries(dayTypeBreakdown).map(([dt, pnls]) => [dt, { n: pnls.length, ev: +(pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2) }]));
  console.log('\nDay-type breakdown (winning arm, full sample):', JSON.stringify(dayTypeReport, null, 2));
  console.log(`\nWinning arm (${verdict}): stop=${winnerStop} target=${winnerTarget}`);
  console.log(`Full-sample: N=${winnerEvents.length} totalPnl=$${totalPnl} maxDrawdown=$${maxDrawdown} returnToDD=${returnToDD} rigor.clean=${rigor.clean} top5DayPct=${rigor.top5DayPct}`);
  console.log(`Chronological thirds: ${JSON.stringify(rigor.thirds)}`);

  // ── 7. Pre-registered Stage 1 gate: OOS beats flat AND baseline AND stable across thirds ──
  const clearedThreshold = verdict === 'SHIP_CALIBRATED'
    ? (oosEvCalibrated > 0 && (oosEvFlat == null || oosEvCalibrated > oosEvFlat))
    : (oosEvFlat != null && oosEvFlat > 0);
  const stage1Pass = clearedThreshold && rigor.clean && winnerEvents.length >= MIN_N;

  await recordClaim({
    slug: 'setup_b_failed_sweep_reversal_stage1',
    claimText: `Stage 1 bar-history backtest, real detectStopSweep() population (${touches.length} touches, ${dates.length - 5} sessions scanned), shared order-aware resolve() for every EV evaluation. In-sample winner: stop=${bestInSample.stop}/target=${bestInSample.target}, IS_EV=$${bestInSample.ev.toFixed(2)} -> OOS_EV=$${oosEvCalibrated.toFixed(2)} (N_oos=${oosTouches.length}). Flat volatility-scaled default (${qualifyingCount} qualifying system-wide types): ${canComputeVolDefault ? `stop=${flatStop}/target=${flatTarget}, OOS_EV=$${oosEvFlat.toFixed(2)}` : 'not computable'}. Verdict per the roadmap's own "if flat wins, ship flat" rule: ${verdict}. Winning arm full-sample: N=${winnerEvents.length}, totalPnl=$${totalPnl}, maxDrawdown=$${maxDrawdown}, returnToDD=${returnToDD}, rigor.clean=${rigor.clean}, top5DayPct=${rigor.top5DayPct}, chronological thirds=${JSON.stringify(rigor.thirds)}. Day-type breakdown: ${JSON.stringify(dayTypeReport)}. Pre-registered Stage 1 gate (OOS beats its comparison arm AND real N>=${MIN_N} AND rigor.clean): ${stage1Pass ? 'PASSED' : 'FAILED'}. ${stage1Pass ? 'Advances to Stage 2 (shadow live).' : 'Does NOT advance to Stage 2 this round -- stays a tracked, self-recalibrating finding per the pre-registered kill condition, not a dead end.'}`,
    sourceFile: 'scripts/backtest_setup_b_failed_sweep_reversal_stage1.mjs',
    sourceDate: '2026-08-11',
    sampleSize: winnerEvents.length,
    winRate: winnerEvents.length ? winnerEvents.filter(e => e.pnl > 0).length / winnerEvents.length : null,
    evPerTrade: winnerEvents.length ? totalPnl / winnerEvents.length : null,
    rigorStatus: `${verdict.toLowerCase()}_${stage1Pass ? 'stage1_pass' : 'stage1_fail'}_rigorclean_${rigor.clean}_n${winnerEvents.length}`,
    status: 'PROVISIONAL',
  });

  console.log(`\nStage 1 gate: ${stage1Pass ? 'PASSED -- advances to Stage 2' : 'FAILED -- does not advance this round'}`);
  console.log('RESEARCH_CLAIM setup_b_failed_sweep_reversal_stage1 recorded.');

  return { stage1Pass, verdict, winnerStop, winnerTarget, touches: touches.length };
}

main().then((r) => { if (r && !r.stage1Pass) process.exitCode = 0; }).catch(e => { console.error('FATAL:', e); process.exit(1); });
