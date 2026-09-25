// Pure, single-bar step function for the T1-floor runner mechanism (2026-09-25, SHADOW-only,
// observation logging). Per this codebase's own "export the real function, never reimplement"
// rule, same convention as widerTargetWalker.js's stepWiderTarget() / stepTrailWalker.js's
// stepStepTrail() / pitchCatchWalker.js's stepPitchCatch().
//
// WHAT THIS DOES, IN ONE SENTENCE: once a real trade reaches its calibrated target (T1) via the
// plain PRICE_CLEAN path -- the "slow" majority the existing wider-target/step-trail mechanism's
// fast+pressure gate never even considers -- bank T1 as a permanent floor (the win can never be
// given back) and let a runner ride toward 1.5x, same WIDER_TARGET_MULT this codebase already
// uses elsewhere.
//
// Backing research: RESEARCH_CLAIM t1floor_runner_positive_slow_population_20260925 (real
// bar-by-bar simulation, N=264, mean +$8.26/trade vs banking flat at T1, day-blocked CI
// [$5.50,$10.75] -- survives an adversarial stress test excluding the dominant setup_type AND
// the top 5 days at once, N=157, +$4.34/trade, CI [$2.62,$6.60], still excludes zero). Emerged
// directly from a DeepSeek code review of an earlier, DIFFERENT test (bail-at-entry gating,
// found negative) that pointed out the earlier test never actually tried this shape -- see that
// claim's text for the full account. Distinct from the existing wider-target mechanism's
// original-stop shape (which CAN give back the T1 win) -- the floor here is what makes this a
// genuinely new, untested-until-now shape, not a re-run of an already-rejected idea.
//
// PROVISIONAL, not yet: independently re-reviewed by DeepSeek (only the earlier, DIFFERENT
// scripts got reviewed), chronologically train/test split, or checked against a data-derived
// (vs fixed 1.5x) target. This is exactly why it ships as SHADOW-parallel observation logging
// (never touches real resolution/actual_pnl/stop_level) rather than anything live -- per user
// direction 2026-09-25 ("this will not need a 20 day test period if it looks good, we'll just
// track it"), matching the exact precedent already set for stepTrailWalker.js/pitchCatchWalker.js.
//
// This is a MODIFICATION TO THE EXIT of existing, already-live setup_types -- not a new
// setup_type, no new entry criteria. Applies to any real trade that reaches T1 via the plain
// (non-wider-target-armed) path, which is the majority of real T1 hits system-wide.
//
// state: {} (no arming phase -- the runner starts the instant the real trade resolves via
//   PRICE_CLEAN, unlike step-trail/pitch-catch which wait for the EXISTING wider-target
//   mechanism to arm first)
// bar: { ts: string (ET wall-clock text), mod: int (ET minutes), high, low, close }
// params: { t1, ft, long, firedMod } -- ft is the runner's target (entry + mult*(t1-entry)),
//   already computed by the caller. The floor stop is always exactly t1 (never the original,
//   further-adverse stop_level) -- that's the entire point of "the win can never be given back."
// Returns { state, resolution: null | { resolution, method, priceAtRes } }
import { isPastMechanismSessionEnd } from './sessionBoundary.js';

export function stepT1FloorRunner(state, bar, { t1, ft, long, firedMod }) {
  const isSessionEnd = isPastMechanismSessionEnd(bar.mod, firedMod);
  const floorHit = long ? bar.low <= t1 : bar.high >= t1;
  const ftHit = long ? bar.high >= ft : bar.low <= ft;

  // Conservative same-bar ordering: floor first (worst case for the runner -- matches every
  // other walker's own stop-first convention on a same-bar conflict). Since the floor sits
  // exactly at t1 (the already-real, already-won price), "hitting" it costs nothing beyond the
  // banked win itself -- there is no additional downside to be conservative ABOUT here, but the
  // ordering is kept consistent with the rest of this codebase's walkers for auditability.
  if (floorHit && ftHit) {
    return { state, resolution: { resolution: 'TARGET_HIT', method: 'T1_FLOOR_HIT', priceAtRes: t1 } };
  }
  if (floorHit) {
    return { state, resolution: { resolution: 'TARGET_HIT', method: 'T1_FLOOR_HIT', priceAtRes: t1 } };
  }
  if (ftHit) {
    return { state, resolution: { resolution: 'TARGET_HIT', method: 'T1_FLOOR_RUNNER_HIT', priceAtRes: ft } };
  }
  if (isSessionEnd) {
    // Mark-to-market at session close -- the caller floors this at the banked T1 win when
    // computing $ (see t1FloorPnlFromResolution below), matching the backtest's own
    // Math.max(mtmPnl, floorPnl) convention. The step function itself only reports the raw
    // price; it has no $ conversion logic (same separation of concerns as every other walker).
    return { state, resolution: { resolution: 'TIME_EXPIRED', method: 'T1_FLOOR_MARK_TO_MARKET', priceAtRes: bar.close } };
  }
  return { state, resolution: null };
}

// $ conversion for a stepT1FloorRunner resolution, applying the floor guarantee at the dollar
// level for the MARK_TO_MARKET case (a session-end MTM price can print BELOW t1 intrabar even
// though the floor stop already fired first in every OTHER case -- this only matters for the
// rare row that never got walked far enough to hit either the floor or the runner target before
// running out of bars, e.g. a same-poll partial walk; the completion pass always walks to a real
// terminal outcome, so this is a defensive floor, not the primary mechanism).
export function t1FloorPnlFromResolution(resolution, { entry, t1, long, dollarsPerPoint, commission }) {
  const rawPts = long ? resolution.priceAtRes - entry : entry - resolution.priceAtRes;
  const rawPnl = rawPts * dollarsPerPoint - commission;
  if (resolution.method !== 'T1_FLOOR_MARK_TO_MARKET') return rawPnl;
  const floorPts = Math.abs(t1 - entry);
  const floorPnl = floorPts * dollarsPerPoint - commission;
  return Math.max(rawPnl, floorPnl);
}
