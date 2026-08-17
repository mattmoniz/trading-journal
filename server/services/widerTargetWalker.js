// Pure, single-bar step function for the wider-target-on-fast-resolving-trades mechanism
// (docs/OPEN_THREADS.md 2026-08-17, OPEN_DECISION runner_wider_target_mechanism_build_spec).
// Extracted per this codebase's own "export the real function, never reimplement" rule so
// the exact live logic is exercised by scripts/test_wider_target_walker_synthetic.mjs, same
// convention as server/services/breakevenTrailWalker.js's stepBreakevenTrail() (its own
// header explains the reasoning — mirrored here, not re-derived).
//
// Design, per DeepSeek's phase-0 critique (docs/OPEN_THREADS.md 2026-08-17): the ORIGINAL
// stop is never moved once the wider-target state arms — this is the same risk shape as the
// already-live extendTarget mechanism (STACK_VOL_BREAK_LIVE_*'s bank-vs-extend branch in
// resolveSetupsByPrice(), acd.js ~658-716), NOT the T1-floor shape (mathematically
// tautological — proven empirically 0/292 negative deltas in
// scratch/velocity_wider_target_t1floor_vs_origstop.mjs — and therefore deliberately not
// built). barCount is 1-based and passed in by the caller (resolveSetupsByPrice() already
// increments it once per bar before dispatching to any branch) — this matches exactly how
// `bars_to_resolution` gets written (UPDATE ... bars_to_resolution=$10 <- barCount), so
// "eligible within maxBarsToT1" here is bit-identical to the backtested
// `bars_to_resolution<=4` population, no separate 0-based translation needed.
//
// state: { widening: boolean }
// bar: { ts: string (ET wall-clock text, HH in bar.ts.slice(11,13)), high, low, close }
// params: { entry, stop, t1, widerTarget, long, barCount, maxBarsToT1 }
// Returns { state: <next state>, resolution: null | { resolution, method, priceAtRes } }
export function stepWiderTarget(state, bar, { entry, stop, t1, widerTarget, long, barCount, maxBarsToT1 }) {
  const isSessionEnd = bar.ts.slice(11, 13) >= '16';
  let newState = state;
  let resolution = null;

  if (!state.widening) {
    const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
    const stopHit = long ? bar.low <= stop : bar.high >= stop;

    if (t1Hit && stopHit) {
      // Conservative: assume stop hit first (worst case) — same convention as the plain
      // fixed-target branch and extendTarget's own pre-arm phase.
      resolution = { resolution: 'STOP_HIT', method: 'SAME_BAR_STOP_FIRST', priceAtRes: stop };
    } else if (stopHit) {
      resolution = { resolution: 'STOP_HIT', method: 'PRICE_CLEAN', priceAtRes: stop };
    } else if (t1Hit) {
      if (barCount <= maxBarsToT1) {
        // Fast arrival, eligible — arm the wider-target continuation. Stop stays exactly
        // where it already was (never moves) — the whole point of building the
        // original-stop shape, not the T1-floor shape.
        newState = { widening: true };
      } else {
        // T1 reached, but not fast enough to qualify — bank normally, same outcome as if
        // this mechanism didn't apply at all. Reuses the plain branch's own method string
        // (not a new one) since this IS behaviorally a plain TARGET_HIT.
        resolution = { resolution: 'TARGET_HIT', method: 'PRICE_CLEAN', priceAtRes: t1 };
      }
    }
    if (!resolution && isSessionEnd) {
      resolution = { resolution: 'TIME_EXPIRED', method: 'MARK_TO_MARKET', priceAtRes: bar.close };
    }
  } else {
    const widerHit = long ? bar.high >= widerTarget : bar.low <= widerTarget;
    const stopHit = long ? bar.low <= stop : bar.high >= stop;
    // Stop-first on same-bar conflict, matching every other branch's conservative convention.
    if (stopHit) {
      resolution = { resolution: 'STOP_HIT', method: 'WIDER_STOP_HIT', priceAtRes: stop };
    } else if (widerHit) {
      resolution = { resolution: 'TARGET_HIT', method: 'WIDER_TARGET_HIT', priceAtRes: widerTarget };
    } else if (isSessionEnd) {
      resolution = { resolution: 'TIME_EXPIRED', method: 'WIDER_TIME_EXPIRED', priceAtRes: bar.close };
    }
  }

  return { state: newState, resolution };
}
