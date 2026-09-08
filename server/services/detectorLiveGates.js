// Shared live-safety-gate checkpoint for the 3 service-poller detectors
// (minuteBarSignalDetector.js/rthFlushDetector.js/globexFlushDetector.js) that had ZERO
// exposure to any of acd.js's live-safety gates -- flagged as "the single biggest un-closed
// gap" in docs/UNIFIED_LIVE_GATE_CHECKPOINT_SPEC.md, WARNed every run by
// scripts/test_invariants.mjs check [24] since 2026-09-02. Built 2026-09-07 after a
// DeepSeek design critique (scratch/deepseek_response.md as of this date) corrected the
// original 4-gate proposal down to 2.
//
// DELIBERATELY EXCLUDES isCrossDirectionFastFlip()/isPostWinOppositeFamilyBlocked()
// (both acd.js exports), NOT an oversight -- DeepSeek's review proved both are
// STRUCTURALLY UNREACHABLE for all 3 of today's real callers, for the same underlying
// reason isInRefireCooldown() is also correctly excluded (see each detector's own
// `_cache.firedToday`/`alreadyFired` fire-once-per-trade_date-across-ALL-its-own-types
// design): both gates only ever look for "the OPPOSITE direction of the SAME family
// fired earlier TODAY" -- but if any row (any type, any direction) from one of these
// pollers had already fired today, that poller's OWN fire-once guard would already have
// returned before ever reaching this function. Verified directly against each file's
// fire-once logic before excluding, not assumed from the critique alone. Unlike
// isInRefireCooldown() (excluded from acd.js's own call convention entirely), these two
// ARE real, working, already-imported-elsewhere gates (server/services/ibLowPnrDetector.js
// already imports and calls both) -- they're excluded HERE specifically because they can
// never fire for THESE 3 callers, not because the gates themselves are unsound. If a
// future detector with a DIFFERENT (non-fire-once, or same-day-multi-direction) design
// ever needs this checkpoint, re-derive whether they're actually reachable for it before
// assuming this same exclusion applies -- don't copy this file's exclusion list blindly.
//
// The 2 gates kept DO real work today:
//   - CAPITAL_EXPOSURE_OVERRIDE: pure future-proofing (currently empty for all 3 families),
//     but these detectors' own getLiveStatus() never consulted it at all -- if a family is
//     ever added to that map, this closes the gap on day one instead of needing a second
//     wiring pass discovered late.
//   - isOppositeDirectionOpen(): roster-wide, NOT trade_date-scoped, so it's the one gate
//     that genuinely protects against a real scenario these detectors can hit -- e.g. a
//     GLOBEX_FLUSH_REVERSAL_LONG firing while an unrelated real ACTIVE SHORT position
//     (from a completely different setup_type/detector) is still open, including across a
//     midnight boundary these detectors' own trade_date scoping can't see.
//
// Order matches acd.js's own canonical sequence at its 2 real chains (RTH main path,
// Globex) exactly, minus the 2 excluded gates: exposure override, then
// isOppositeDirectionOpen. Force-SHADOW, never skip -- same "keep the row, degrade its
// status" convention every other live gate in this codebase uses, so real outcome data
// keeps accumulating on exactly what's held back.
import { isOppositeDirectionOpen } from '../routes/acd.js';
import { CAPITAL_EXPOSURE_OVERRIDE } from './setupEligibility.js';

export async function checkStandardLiveGates({ direction, setupType }) {
  // Guard against a future caller passing an unresolved direction -- isOppositeDirectionOpen
  // already no-ops on falsy `direction` (acd.js:348), but be explicit here rather than rely
  // on that internal guard, matching DeepSeek's review point on the directional gates'
  // silent non-'LONG'-means-'SHORT' coercion elsewhere in this checkpoint family.
  if (direction !== 'LONG' && direction !== 'SHORT') return { forceShadow: false, reason: null };

  const exposureOverride = CAPITAL_EXPOSURE_OVERRIDE.get(setupType);
  if (exposureOverride) return { forceShadow: true, reason: exposureOverride.reason };

  if (await isOppositeDirectionOpen(direction)) {
    return { forceShadow: true, reason: 'OPPOSITE_DIRECTION_OPEN' };
  }

  return { forceShadow: false, reason: null };
}
