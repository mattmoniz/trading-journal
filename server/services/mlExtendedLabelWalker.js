// Pure triple-barrier label computation for the DeepSeek meta-labeling filter thread
// (docs/1. Deepseek_ML_Meta_Labeling_SPEC.md, Section 4). Extracted per this codebase's own
// "export the real function, never reimplement" rule -- same shape as
// widerTargetWalker.js's stepWiderTarget() (pure step function, no DB/live-state access),
// but simpler: a single, flat triple-barrier with no arm/widen phase, matching the spec's
// own Section 4.3 `label_signal()` exactly (tie-break: stop wins on same-bar conflict,
// TIME barrier at a fixed bar count).
//
// This is a RESEARCH LABEL, not a live trade-management decision -- it is computed AFTER a
// real trade has already resolved through this codebase's own real exit mechanism (stop_level/
// t1_level, whatever resolveSetupsByPrice() actually decided), walking price_bars_primary
// forward from the trade's own entry independently of that real resolution. It never writes
// to, reads from, or influences stop_level/t1_level/resolution/actual_pnl/extend_target_level/
// extend_decision (a completely separate, already-live STACK_VOL_BREAK_LIVE-only mechanism --
// see resolveSetups.js's own extendTarget branch, not to be confused with this).
//
// Per the DeepSeek Phase 0 design critique (2026-09-20/21, scratch/deepseek_response.md):
// the spec's own EXIT_TARGET_TYPE=EXTENDED setting ("the single most impactful choice in the
// document" per the spec's own Section 15) cannot be read off active_setups.mfe_points --
// that field is truncated the instant this codebase's own REAL (flat, non-extended) target
// resolves, so it has never observed genuine post-target continuation
// (OPEN_DECISION optimal_target_blind_to_post_resolution_continuation). This function is the
// fix: an independent forward replay past the real resolution point, computing the spec's own
// EXTENDED barrier (a multiple of the setup's own real calibrated t1_level distance from
// entry) against real price_bars_primary bars, with its own fixed time barrier -- decoupled
// from whatever the live mechanism actually did.
//
// EXTENDED_TARGET_MULT is a METHODOLOGY parameter (what the ML label is trying to predict),
// not a live trading threshold -- CLAUDE.md's no-static-thresholds hard rule targets live
// entries/stops/targets/signal triggers, not a fixed definition of what "a good outcome"
// means for a training label. Same category as widerTargetWalker.js's own
// `WIDER_TARGET_MULT = 1.5` named constant. Value matches the spec's own explicit suggestion
// ("~2.5x your current target").
export const EXTENDED_TARGET_MULT = 2.5;
export const DEFAULT_MAX_HOLD_BARS = 60; // spec Section 0's own suggested default

// bars: ascending-ts array of { high, low, close } for price_bars_primary rows strictly
//   after the trade's own entry timestamp (caller's responsibility to fetch/slice/bound this
//   query -- see backfill_ml_extended_label.mjs for the real bounded query).
// params: { entry, stop, extendedTarget, long, maxHoldBars = DEFAULT_MAX_HOLD_BARS }
//   entry/stop are the setup's OWN real entry_zone_high??entry_zone_low / stop_level (the
//   real calibrated risk this trade actually carried) -- NOT the spec's own generic fixed-
//   tick defaults. extendedTarget is precomputed by the caller as
//   entry +/- EXTENDED_TARGET_MULT * (t1_level - entry) (long/short respectively), so this
//   function stays a pure barrier-walk with no config-reading of its own.
// Returns null if fewer than 1 forward bar was available (can't label yet -- not a real
// TIME_EXPIRED, genuinely insufficient data, matching the spec's own `len(forward) < 2` guard
// loosely -- 1 bar minimum here since maxHoldBars itself already bounds the walk).
export function computeExtendedLabel(bars, { entry, stop, extendedTarget, long, maxHoldBars = DEFAULT_MAX_HOLD_BARS }) {
  if (!bars || bars.length === 0) return null;
  const forward = bars.slice(0, maxHoldBars);

  let mfe = 0, mae = 0;
  for (let i = 0; i < forward.length; i++) {
    const bar = forward[i];
    const barsHeld = i + 1;
    mfe = Math.max(mfe, long ? bar.high - entry : entry - bar.low);
    mae = Math.max(mae, long ? entry - bar.low : bar.high - entry);

    const stopHit = long ? bar.low <= stop : bar.high >= stop;
    const targetHit = long ? bar.high >= extendedTarget : bar.low <= extendedTarget;

    // Tie-break: stop wins on a same-bar conflict, matching the spec's own Section 4.4
    // mandatory rule and every existing walker in this file's own family
    // (widerTargetWalker.js/stepTrailWalker.js/pitchCatchWalker.js all check stop first).
    if (stopHit) {
      return { exitReason: 'STOP', exitPrice: stop, barsHeld, mfe: round1(mfe), mae: round1(mae), label: 0 };
    }
    if (targetHit) {
      return { exitReason: 'TARGET', exitPrice: extendedTarget, barsHeld, mfe: round1(mfe), mae: round1(mae), label: 1 };
    }
  }

  const last = forward[forward.length - 1];
  return {
    exitReason: 'TIME',
    exitPrice: last.close,
    barsHeld: forward.length,
    mfe: round1(mfe), mae: round1(mae),
    label: 0,
  };
}

function round1(x) { return Math.round(x * 10) / 10; }
