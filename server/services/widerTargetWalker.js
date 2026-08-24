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
// Named constants (extracted 2026-08-17, DeepSeek code-review of the per-trade
// counterfactual endpoint build) -- previously three independent `1.5` literals at the
// live INSERT sites (acd.js ~8293/8680/8825) and a `maxBarsToT1: 4` literal at the live
// resolveSetupsByPrice() call site (acd.js ~813), with no single named source. All 4
// sites plus the new counterfactual endpoint now import these instead.
export const WIDER_TARGET_MULT = 1.5;
export const MAX_BARS_TO_T1_FOR_WIDER = 4;

// Pressure gate (2026-08-24, RESEARCH_CLAIM wider_target_pressure_gate_vs_always_extend):
// buying/selling imbalance at the T1-touch bar predicts whether extending past T1 helps or
// hurts — confirmed on real data through a confound-controlled check (survives controlling
// for day volatility and setup_type/bet_class composition) and a genuine out-of-sample split
// (held up on chronologically later data never used to derive the threshold, most cleanly at
// the top tier: loss rate 4.5% in-sample vs 5.4% out-of-sample). Speed alone (how many bars
// it took to reach T1) was tested FIRST and did NOT show a clean signal — this gate is
// pressure-only, not a speed gate, per that finding. `pressureReading`/`pressureThreshold`
// are both optional (default null) so a caller that doesn't have a calibrated threshold yet
// gets the pre-2026-08-24 always-extend behavior unchanged — this is purely additive.
//
// state: { widening: boolean }
// bar: { ts: string (ET wall-clock text, HH in bar.ts.slice(11,13)), high, low, close }
// params: { entry, stop, t1, widerTarget, long, barCount, maxBarsToT1, pressureReading,
//   pressureThreshold } — pressureReading is the dirImbalance value AT THE T1-TOUCH BAR
//   (favorable-minus-adverse volume as a fraction of total, already computed by the caller);
//   pressureThreshold is the calibrated cutoff (read from performance_audit
//   signal_type='WIDER_TARGET_PRESSURE_GATE' by the caller, never hardcoded here).
// Returns { state: <next state>, resolution: null | { resolution, method, priceAtRes } }
export function stepWiderTarget(state, bar, { entry, stop, t1, widerTarget, long, barCount, maxBarsToT1, pressureReading = null, pressureThreshold = null }) {
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
      // !isSessionEnd guard added 2026-08-18 (B2, DeepSeek-QA'd fix — docs/OPEN_THREADS.md
      // 2026-08-18): without it, a T1 hit that qualifies as "fast" (barCount<=maxBarsToT1)
      // AND lands on/after the 16:00 RTH-close bar would both arm (newState.widening=true)
      // AND fall through to the isSessionEnd check just below, which — seeing `resolution`
      // still null — would ALSO set a TIME_EXPIRED/MARK_TO_MARKET resolution in the same
      // return, violating this function's own documented {state, resolution} contract (never
      // both a real state transition and a resolution at once). DeepSeek independently
      // confirmed TARGET_HIT/PRICE_CLEAN (not a mark-to-market) is the correct outcome here:
      // T1 genuinely printed and mark-to-market could misprice it below T1; the plain
      // (non-flagged) branch already resolves a 16:00 T1-hit as TARGET_HIT/PRICE_CLEAN with
      // no special case, and declining to arm must not change that; this IS behaviorally a
      // plain TARGET_HIT either way (too slow, or fast-but-no-session-time-left-to-benefit).
      const pressureGateOk = pressureThreshold == null || pressureReading == null
        || pressureReading >= pressureThreshold;
      if (barCount <= maxBarsToT1 && !isSessionEnd && pressureGateOk) {
        // Fast arrival, eligible, AND (if a calibrated threshold was supplied) pressure
        // confirms — arm the wider-target continuation. Stop stays exactly where it already
        // was (never moves) — the whole point of building the original-stop shape, not the
        // T1-floor shape.
        newState = { widening: true };
      } else if (barCount <= maxBarsToT1 && !isSessionEnd) {
        // Fast and in-session, but pressure didn't confirm — bank now rather than extend
        // blindly. Distinct method string from the plain bank below so this specific outcome
        // stays analyzable (RESEARCH_CLAIM wider_target_pressure_gate_vs_always_extend).
        resolution = { resolution: 'TARGET_HIT', method: 'BANKED_LOW_PRESSURE', priceAtRes: t1 };
      } else {
        // T1 reached, but not fast enough to qualify (or no session time left to benefit
        // from arming) — bank normally, same outcome as if this mechanism didn't apply at
        // all. Reuses the plain branch's own method string (not a new one) since this IS
        // behaviorally a plain TARGET_HIT.
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
