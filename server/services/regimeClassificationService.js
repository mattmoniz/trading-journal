// Generic statistical helpers, shared across scripts that need mean/std/percentile
// without pulling in a stats library.
//
// This file used to also hold Regime A/B/C (directional trend / price-stretch /
// trend-persistence) classification + a conditioned sizing multiplier built on top of
// them (extracted 2026-07-18 after being hand-copied 3x in one night). That
// methodology was tested the same day and FAILED: non-overlapping-window re-testing
// found Regime A/B's buckets underpowered on this codebase's ~410-day history; a
// 200-permutation placebo test found Regime C's persistence-decay pattern
// indistinguishable from a shuffled null; an independent PELT changepoint ground
// truth found Regime A's label transitions align with real structural breaks WORSE
// than chance. See docs/REGIME_DETECTION_SPEC.md Section 8.1 for the full account and
// the resolved `regime_detection_methodology_needs_validation` OPEN_DECISION.
// Confirmed 2026-09-02: zero live callers anywhere (server/ or scripts/) ever picked
// up the regime functions themselves — removed as dead code (see git history for the
// removed buildRegimeMap()/buildPostRotationFlagMap()/buildVolRegimeMap()/
// conditionedMultiplier() if resurrecting this line of research). The 3 math helpers
// below are still real, still used (scripts/backfill_unified_levels.mjs), kept.

export function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

export function std(arr, m) {
  if (arr.length < 2) return 0;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx), w = idx - lo;
  return hi >= sorted.length ? sorted[lo] : sorted[lo] * (1 - w) + sorted[hi] * w;
}

