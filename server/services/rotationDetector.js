// Canonical "did price make a real swing" detector -- extracted 2026-09-16 (user request,
// after asking "how many points per rotation" / "does it match what I see on screen" about
// morningBrief.js's live Session/CHOP chip) so any future feature that needs "how many real
// price swings happened, and how big" has one obvious, shared, already-validated place to
// import from, instead of writing a 5th independent copy.
//
// This is the SAME core reversal rule as pocRotationService.js's detectSignalEvents() --
// running_high/running_low tracked from each bar's own high/low (never close), a reversal
// confirmed the moment price moves >= R points away from the running extreme in the opposite
// direction. R=65 is that file's own "validated construction" (poc_rotation_join_fade_levels_
// med50_fixed) -- the exact threshold that already gates the real, live POC_ROTATION_JOIN_LONG/
// SHORT setup -- reused here rather than guessed, per this codebase's "export the real
// function, never reimplement" rule.
//
// Before this existed, the same "count real swings" idea had been independently reimplemented
// 3 separate times, only one of which (detectSignalEvents(), inside pocRotationService.js)
// used real intrabar highs/lows:
//   1. morningBrief.js's classifySessionChar() (the live Session/CHOP chip + Session Trend
//      History popup) -- 5-min-bucketed CLOSE-only, threshold = ATR20*0.15 (a guessed,
//      volatility-scaled number, 39pt on the day this was found).
//   2. patternScannerService.js's detectRotationProfile() -- ALSO 5-min-bucketed close-only,
//      feeding session_analysis.rotations_65pt (the "65pt" name suggests it once intended to
//      match this file's real threshold, but never adopted the real intrabar-high/low logic).
//      Deliberately NOT repointed at this shared detector yet -- it feeds nightly pattern-
//      mining thresholds (patternScannerService.js's own `rotations_65pt >= 15` cutoff) tuned
//      against its own close-only counting convention; switching methodology would silently
//      change how often those patterns fire. Flag before touching.
//   3. morningBrief.js's getTrailingRotations() (the 90-day mean/std baseline the CHOP/
//      EXTREME_CHOP labels are judged against) used to read session_analysis.rotations_65pt --
//      i.e. copy #2's output -- meaning the live chip (copy #1's close-only, ATR-scaled count)
//      was being compared against a baseline computed by a DIFFERENT method entirely. Fixed
//      the same session: both sides of that comparison now go through THIS function.
// Confirmed live the close-only version undercounts real swings: 29 of 80 five-minute buckets
// on the day this was found had an intrabar high-low range bigger than the close-based
// threshold (several 100pt+), none of which ever registered as a rotation.
//
// `bars` must be ordered chronologically and each carry numeric `high`/`low` fields (NOT
// just `close`) -- this is fully causal (only ever compares up to the current bar, matching
// this codebase's "no lookahead in backtests/replays" rule), so it's safe to call on a
// bars-so-far slice for a live, in-progress session.
export const ROTATION_LEG_THRESHOLD = 65;

export function detectRotationLegs(bars, R = ROTATION_LEG_THRESHOLD) {
  if (!bars.length) return [];
  const legs = [];
  let running_high = bars[0].high, running_high_idx = 0;
  let running_low = bars[0].low, running_low_idx = 0;
  let pivot_is_low = null; // null until the first leg confirms, matching detectSignalEvents()

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.high > running_high) { running_high = bar.high; running_high_idx = i; }
    if (bar.low < running_low) { running_low = bar.low; running_low_idx = i; }

    let confirmed = null;
    if (pivot_is_low === null) {
      if (running_high - bar.low >= R) {
        confirmed = { dir: 'DOWN', anchorIdx: running_high_idx, idx: i, size: Math.round(running_high - bar.low) };
        pivot_is_low = false;
      } else if (bar.high - running_low >= R) {
        confirmed = { dir: 'UP', anchorIdx: running_low_idx, idx: i, size: Math.round(bar.high - running_low) };
        pivot_is_low = true;
      }
    } else if (pivot_is_low === true) {
      if (running_high - bar.low >= R) {
        confirmed = { dir: 'DOWN', anchorIdx: running_high_idx, idx: i, size: Math.round(running_high - bar.low) };
        pivot_is_low = false;
      }
    } else {
      if (bar.high - running_low >= R) {
        confirmed = { dir: 'UP', anchorIdx: running_low_idx, idx: i, size: Math.round(bar.high - running_low) };
        pivot_is_low = true;
      }
    }

    if (confirmed) {
      legs.push(confirmed);
      running_high = bar.high; running_low = bar.low;
      running_high_idx = i; running_low_idx = i;
    }
  }
  return legs;
}
