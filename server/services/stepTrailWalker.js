// Pure, single-bar step function for the step-trail runner extension mechanism (Opus Audit
// #12, docs/OPUS_AUDIT_PROMPT_12.md / scratch/opus_audit_12_results.md, 2026-09-04). Extracted
// per this codebase's own "export the real function, never reimplement" rule, same convention
// as server/services/widerTargetWalker.js/breakevenTrailWalker.js — exercised by its own
// synthetic test (scripts/test_step_trail_walker_synthetic.mjs), not a separate simulation
// that could silently diverge from live.
//
// WHAT THIS DOES, IN ONE SENTENCE: once a trade reaches the existing live 1.5x wider target
// (server/services/widerTargetWalker.js's WIDER_TARGET_MULT), instead of banking there it
// snaps the stop up to just below that level and keeps trailing forward in fixed-size steps,
// letting the trade run further if it keeps going — same "original stop never moves until
// something is actually locked in" philosophy as the wider-target mechanism, extended one
// stage further.
//
// COMPOSITION, NOT REIMPLEMENTATION: everything up through the wider-target hit (T1 arrival,
// the maxBarsToT1 eligibility window, the pressure gate, the original-stop-never-moves risk
// shape) is handled by calling the REAL, live stepWiderTarget() directly — this file adds
// exactly one new capability: what happens at the moment stepWiderTarget() would have
// resolved TARGET_HIT/WIDER_TARGET_HIT. Every other resolution stepWiderTarget() can produce
// (STOP_HIT before or after arming, TARGET_HIT/PRICE_CLEAN, TARGET_HIT/BANKED_LOW_PRESSURE,
// TIME_EXPIRED before or after arming) passes straight through unchanged. This means a bugfix
// to stepWiderTarget()'s own logic (the pressure gate, the session-end boundary, the Globex
// fixes) is automatically inherited here with zero duplicated risk.
//
// THE V1 BUG THIS DESIGN SPECIFICALLY GUARDS AGAINST (found 2026-09-04, scratch/
// step1_ratchet.mjs): an early version left `currentStop` frozen at the ORIGINAL stop from
// the moment of arming until a FULL EXTRA step past the wider-target crossing — zero
// incremental protection for that entire stretch, ~91pt average giveback measured. The fix
// (also present in scratch/step1_ratchet_v2.mjs/v3.mjs, lifted here verbatim, not re-derived):
// the instant the wider target is crossed, `currentStop` snaps IMMEDIATELY to
// (widerTarget - stepSize) for LONG / (widerTarget + stepSize) for SHORT, via
// Math.max/Math.min against the original stop so the snap can only ever be an improvement,
// never a regression. scripts/test_step_trail_walker_synthetic.mjs's regression-guard test
// asserts this snap happens on the SAME bar the wider target is hit, not a bar later.
//
// state shape: { inner: <stepWiderTarget's own state, {widening:boolean}>, ratcheting:
//   boolean, currentStop: number|null, highestMfe: number|null }. Initial state:
//   { inner: { widening: false }, ratcheting: false, currentStop: null, highestMfe: null }.
// bar: same shape stepWiderTarget expects — { ts, mod, high, low, close } (+ bid_volume/
//   ask_volume if a pressureThreshold is supplied, matching stepWiderTarget's own contract).
// params: everything stepWiderTarget() takes (entry, stop, t1, widerTarget, long, barCount,
//   maxBarsToT1, firedMod, pressureReading, pressureThreshold) PLUS `stepSize` — the ratchet
//   step size in PRICE POINTS, already computed by the caller from a calibrated fraction times
//   an effective base distance (scripts/calibrate_step_trail_fraction.mjs writes both; this
//   function has no opinion on how stepSize was derived, matching stepWiderTarget's own
//   convention of taking `widerTarget` pre-computed rather than a multiplier).
// Returns { state: <next state>, resolution: null | { resolution, method, priceAtRes } }.
// `resolution` reuses stepWiderTarget's own vocabulary for every pass-through case; the two
// NEW outcomes this file can produce are always labelled `resolution: 'TARGET_HIT'` (the
// ratchet stop can only ever sit at or above a price the trade already reached, so exiting
// there is always a win relative to the original entry, never a loss) with a
// STEP_TRAIL_-prefixed method string so downstream analysis can tell them apart from the
// plain wider-target outcomes.
import { stepWiderTarget } from './widerTargetWalker.js';
import { isPastMechanismSessionEnd } from './sessionBoundary.js';

export function stepStepTrail(state, bar, params) {
  const { long, stop, stepSize, firedMod } = params;

  if (!state.ratcheting) {
    const inner = stepWiderTarget(state.inner, bar, params);

    if (!inner.resolution) {
      // Still walking phase 1 (not yet armed) or phase 2 (armed, watching for the wider
      // target) — nothing for this file to do yet.
      return { state: { inner: inner.state, ratcheting: false, currentStop: null, highestMfe: null }, resolution: null };
    }

    if (inner.resolution.method !== 'WIDER_TARGET_HIT') {
      // Every other resolution (STOP_HIT/SAME_BAR_STOP_FIRST, STOP_HIT/PRICE_CLEAN,
      // TARGET_HIT/BANKED_LOW_PRESSURE, TARGET_HIT/PRICE_CLEAN, TIME_EXPIRED/MARK_TO_MARKET,
      // STOP_HIT/WIDER_STOP_HIT, TIME_EXPIRED/WIDER_TIME_EXPIRED) is a real exit that never
      // reached the wider target at all — pass through unchanged, nothing to extend.
      return { state: { inner: inner.state, ratcheting: false, currentStop: null, highestMfe: null }, resolution: inner.resolution };
    }

    // The wider target was just hit — this is the ONE moment this file intercepts. Instead
    // of resolving TARGET_HIT/WIDER_TARGET_HIT, begin ratcheting: snap the stop immediately
    // (same bar, not a bar later — the exact fix for the v1 giveback bug documented above).
    const widerTarget = params.widerTarget;
    const snapped = long ? widerTarget - stepSize : widerTarget + stepSize;
    const currentStop = long ? Math.max(stop, snapped) : Math.min(stop, snapped);
    return {
      state: { inner: inner.state, ratcheting: true, currentStop, highestMfe: widerTarget },
      resolution: null,
    };
  }

  // Ratcheting phase — genuinely new logic, no equivalent in stepWiderTarget().
  const isSessionEnd = isPastMechanismSessionEnd(bar.mod, firedMod);
  const stopHit = long ? bar.low <= state.currentStop : bar.high >= state.currentStop;
  if (stopHit) {
    return {
      state,
      resolution: { resolution: 'TARGET_HIT', method: 'STEP_TRAIL_STOP_HIT', priceAtRes: state.currentStop },
    };
  }

  let { currentStop, highestMfe } = state;
  // Multi-step-in-one-bar handling: a single bar can leap past several step boundaries (a
  // fast bar on a real trend day) — floor division advances highestMfe/currentStop by every
  // step actually earned that bar, not just one, matching scratch/step1_ratchet_v3.mjs's
  // runArmB() exactly.
  if (long) {
    if (bar.high >= highestMfe + stepSize) {
      const steps = Math.floor((bar.high - highestMfe) / stepSize);
      highestMfe += steps * stepSize;
      currentStop += steps * stepSize;
    }
  } else {
    if (bar.low <= highestMfe - stepSize) {
      const steps = Math.floor((highestMfe - bar.low) / stepSize);
      highestMfe -= steps * stepSize;
      currentStop -= steps * stepSize;
    }
  }

  const nextState = { inner: state.inner, ratcheting: true, currentStop, highestMfe };
  if (isSessionEnd) {
    return {
      state: nextState,
      resolution: { resolution: 'TARGET_HIT', method: 'STEP_TRAIL_TIME_EXPIRED', priceAtRes: bar.close },
    };
  }
  return { state: nextState, resolution: null };
}
