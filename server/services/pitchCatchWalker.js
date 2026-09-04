// Pure, single-bar step function for the "Pitch and Catch" mechanism (user idea, 2026-09-04
// — bank the first leg at the existing live 1.5x wider target, then watch for a real,
// confirmed pullback that finds support, then take a SEPARATE fresh re-entry for a second
// leg). Extracted per this codebase's own "export the real function, never reimplement" rule,
// same convention as stepTrailWalker.js/widerTargetWalker.js.
//
// STATUS AS OF 2026-09-04: NOT VALIDATED. Tested 6 different ways on the real setup-gated
// population (full population, wide/structural stop sweep, momentum snapshot at re-entry, a
// 9:45-11am time window, CVD trend into the pause, a regime+RVol+settle-speed combined
// filter) — every one negative or fragile under stress-testing (day-clustering, top-day
// exclusion). A much larger bar-level backtest (no setup-gating at all, N=3049 vs the setup-
// gated N~60-430) also came back negative in every cut, both directions. This is
// observation-only, tracked at the user's explicit request specifically BECAUSE it has not
// been validated — "if it's not good then the N will stay low" — never gate/size a real
// trade off this. See RESEARCH_CLAIM pitch_and_catch_forward_tracking_20260904 for the full
// evidence trail and the recheck condition.
//
// COMPOSITION: everything through the wider-target hit reuses the real live stepWiderTarget()
// (via the exact same pattern as stepTrailWalker.js) — this file adds 3 new phases on top:
// (1) watch for a CONFIRMED pullback (3 consecutive closes retracing >=15% of the original
// leg — a real, held retracement, not a same-bar wick); (2) once confirmed, compute the
// regime/volume filter conditions (RVol of the settle window vs the first leg, bars-to-
// confirm, daily ADX) and decide whether this specific instance qualifies as a "clean"
// pitch-and-catch setup (calibrated thresholds, never hardcoded — see
// scripts/calibrate_pitch_catch_filter.mjs); (3) if it qualifies, simulate a genuinely fresh
// re-entry (its own entry, stop, target) as a real bar-by-bar walk, never touching the
// original trade's own resolution/stop/actual_pnl in any way.
//
// state shape: { inner: <stepWiderTarget's own state>, phase: 'ARMING'|'WATCHING_PULLBACK'|
//   'REENTERED'|'DONE', runningPeak, belowCount, pullbackExtreme, confirmBar (bar index proxy
//   via a counter, not a real DB index -- see barIdx below), settleBarVols (array, for RVol),
//   firstLegAvgVol, reentry: { entryPrice, stopPrice, targetPrice } | null }.
// Initial state: { inner: { widening: false }, phase: 'ARMING', firstLegVolSum: 0,
//   firstLegVolCount: 0, runningPeak: null, belowCount: 0, pullbackExtreme: null,
//   settleBarVols: [], firstLegAvgVol: null, reentry: null }.
// bar: stepWiderTarget's own shape PLUS bid_volume/ask_volume (always, not just when a
//   pressure threshold is supplied — this file needs raw volume for RVol regardless).
// params: everything stepWiderTarget() takes, PLUS `filterCalib` — the calibrated
//   { rvolLo, rvolHi, minBarsToConfirm, adxThreshold } object (null disables re-entry
//   entirely, matching stepTrailWalker's null-calib no-op convention) and `dailyAdx` — the
//   PRIOR day's close-of-day ADX value for this trade's own trade_date (no lookahead,
//   supplied by the caller exactly like pressureReading/pressureThreshold already are).
// Returns { state, resolution: null | { resolution, method, priceAtRes, qualified } } —
// `qualified` distinguishes "confirmed pullback but filtered out" (never re-entered) from a
// real re-entry attempt, so a caller can tell the two apart without re-deriving the filter.
import { stepWiderTarget } from './widerTargetWalker.js';
import { isPastMechanismSessionEnd } from './sessionBoundary.js';

function barVol(bar) { return (bar.bid_volume || 0) + (bar.ask_volume || 0); }

export function stepPitchCatch(state, bar, params) {
  const { long, firedMod, filterCalib, dailyAdx } = params;

  if (state.phase === 'ARMING') {
    // Accumulate this leg's own volume every bar (regardless of whether the mechanism ever
    // arms) so a real firstLegAvgVol is ready the moment the wider target is hit -- computed
    // in parallel with, not instead of, the composed stepWiderTarget() call below.
    const firstLegVolSum = (state.firstLegVolSum || 0) + barVol(bar);
    const firstLegVolCount = (state.firstLegVolCount || 0) + 1;
    const inner = stepWiderTarget(state.inner, bar, params);
    if (!inner.resolution) {
      return { state: { ...state, inner: inner.state, firstLegVolSum, firstLegVolCount }, resolution: null };
    }
    if (inner.resolution.method !== 'WIDER_TARGET_HIT') {
      // Every other outcome never reached the wider target -- nothing to catch, pass through.
      return { state: { ...state, inner: inner.state, phase: 'DONE' }, resolution: inner.resolution };
    }
    // Wider target hit -- start watching for a confirmed pullback from here.
    return {
      state: {
        ...state, inner: inner.state, phase: 'WATCHING_PULLBACK',
        runningPeak: params.widerTarget, belowCount: 0, pullbackExtreme: null,
        firstLegAvgVol: firstLegVolCount > 0 ? firstLegVolSum / firstLegVolCount : null, settleBarVols: [],
      },
      resolution: null,
    };
  }

  if (state.phase === 'WATCHING_PULLBACK') {
    let { runningPeak, belowCount, pullbackExtreme } = state;
    const origDist = Math.abs(params.widerTarget - params.entry) / 1.5; // recover the T1 distance
    if (long) {
      runningPeak = Math.max(runningPeak, bar.close);
      const retrace = runningPeak - bar.close;
      if (retrace / origDist >= 0.15) {
        belowCount++;
        pullbackExtreme = pullbackExtreme == null ? bar.low : Math.min(pullbackExtreme, bar.low);
      } else { belowCount = 0; pullbackExtreme = null; }
    } else {
      runningPeak = Math.min(runningPeak, bar.close);
      const retrace = bar.close - runningPeak;
      if (retrace / origDist >= 0.15) {
        belowCount++;
        pullbackExtreme = pullbackExtreme == null ? bar.high : Math.max(pullbackExtreme, bar.high);
      } else { belowCount = 0; pullbackExtreme = null; }
    }
    const settleBarVols = belowCount > 0 ? [...state.settleBarVols, barVol(bar)] : [];

    if (belowCount < 3) {
      const isSessionEnd = isPastMechanismSessionEnd(bar.mod, firedMod);
      if (isSessionEnd) return { state: { ...state, phase: 'DONE' }, resolution: null }; // never confirmed, nothing to log
      return { state: { ...state, runningPeak, belowCount, pullbackExtreme, settleBarVols }, resolution: null };
    }

    // Confirmed (3 consecutive closes). Evaluate the calibrated filter -- fail closed if no
    // calibration exists yet, matching every other calibrated gate in this codebase.
    if (filterCalib == null || dailyAdx == null) {
      return { state: { ...state, phase: 'DONE' }, resolution: { resolution: 'TARGET_HIT', method: 'PNC_UNQUALIFIED_NO_CALIB', priceAtRes: bar.close, qualified: false } };
    }
    const rvol = state.firstLegAvgVol > 0 ? (settleBarVols.reduce((s, v) => s + v, 0) / settleBarVols.length) / state.firstLegAvgVol : null;
    const barsToConfirm = settleBarVols.length;
    const qualifies = rvol != null && rvol >= filterCalib.rvolLo && rvol < filterCalib.rvolHi
      && barsToConfirm >= filterCalib.minBarsToConfirm && dailyAdx > filterCalib.adxThreshold;

    if (!qualifies) {
      return { state: { ...state, phase: 'DONE' }, resolution: { resolution: 'TARGET_HIT', method: 'PNC_UNQUALIFIED_FILTER', priceAtRes: bar.close, qualified: false } };
    }
    // Qualifies -- enter the hypothetical re-entry at THIS bar's close.
    const targetPrice = runningPeak + (long ? 1 : -1) * 1.5 * origDist;
    return {
      state: { ...state, phase: 'REENTERED', reentry: { entryPrice: bar.close, stopPrice: params.origStop, targetPrice } },
      resolution: null,
    };
  }

  if (state.phase === 'REENTERED') {
    const { entryPrice, stopPrice, targetPrice } = state.reentry;
    const stopHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
    const targetHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
    if (stopHit) return { state: { ...state, phase: 'DONE' }, resolution: { resolution: 'STOP_HIT', method: 'PNC_REENTRY_STOP', priceAtRes: stopPrice, qualified: true, entryPrice } };
    if (targetHit) return { state: { ...state, phase: 'DONE' }, resolution: { resolution: 'TARGET_HIT', method: 'PNC_REENTRY_TARGET', priceAtRes: targetPrice, qualified: true, entryPrice } };
    const isSessionEnd = isPastMechanismSessionEnd(bar.mod, firedMod);
    if (isSessionEnd) return { state: { ...state, phase: 'DONE' }, resolution: { resolution: 'TIME_EXPIRED', method: 'PNC_REENTRY_TIME_EXPIRED', priceAtRes: bar.close, qualified: true, entryPrice } };
    return { state, resolution: null };
  }

  return { state, resolution: null }; // DONE -- nothing further to do
}
