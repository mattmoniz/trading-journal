// Pure, single-bar step function for the breakeven-then-trail exit mechanism
// (docs/SCALEOUT_RUNNER_SPEC.md). Extracted 2026-08-10 (roster-rebuild roadmap Phase 3,
// I4) from server/routes/acd.js's resolveSetupsByPrice() inline trail branch (was lines
// ~686-739) so the exact live logic can be exercised by a synthetic-price-path test
// without reimplementing it — per this codebase's own "export the real function, never
// reimplement live-derived logic inline in a backtest" rule. resolveSetupsByPrice()
// calls this once per bar and merges the result back into its own loop state; nothing
// about the resolution/priceAtRes/method semantics changed in the extraction — verified
// byte-behavior-identical against the pre-extraction inline version via
// scripts/test_breakeven_trail_walker_synthetic.mjs.
//
import { isPastMechanismSessionEnd } from './sessionBoundary.js';

// state: { armedAt: string|null, peakPrice: number|null, trailStopPrice: number|null }
// bar: { ts: string (ET wall-clock text), mod: int (ET minutes, already computed by every
//   caller's bar query), high, low, close }
// params: { entry, stop, t1, trailWidth, long, firedMod } — firedMod is the trade's own
//   fired_at time-of-day in ET minutes (server/services/sessionBoundary.js's firedAtToMod()),
//   REQUIRED so session-end can be judged correctly for a Globex-origin trade, not just an RTH
//   one (found 2026-08-30 alongside the identical bug in widerTargetWalker.js -- see
//   isPastMechanismSessionEnd()'s own header for the incident).
// Returns { state: <next state>, resolution: null | { resolution, method, priceAtRes } }
export function stepBreakevenTrail(state, bar, { entry, stop, t1, trailWidth, long, firedMod }) {
  const isSessionEnd = isPastMechanismSessionEnd(bar.mod, firedMod);
  let newState = state;
  let resolution = null;

  if (state.armedAt == null) {
    const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
    const stopHit = long ? bar.low <= stop : bar.high >= stop;

    if (t1Hit && stopHit) {
      resolution = { resolution: 'STOP_HIT', method: 'SAME_BAR_STOP_FIRST', priceAtRes: stop };
    } else if (t1Hit) {
      // Arm: snap stop to breakeven, anchor the trail to this bar's favorable extreme.
      const armedAt = bar.ts;
      const peakPrice = long ? bar.high : bar.low;
      const trailStopPrice = entry;
      newState = { armedAt, peakPrice, trailStopPrice };
      const sameBarBreach = long ? bar.low <= trailStopPrice : bar.high >= trailStopPrice;
      if (sameBarBreach) {
        resolution = { resolution: 'TRAIL_EXIT', method: 'SAME_BAR_ARM_STOP', priceAtRes: trailStopPrice };
      }
    } else if (stopHit) {
      resolution = { resolution: 'STOP_HIT', method: 'PRICE_CLEAN', priceAtRes: stop };
    }
  } else {
    let { peakPrice, trailStopPrice } = state;
    if (long && bar.high > peakPrice) peakPrice = bar.high;
    if (!long && bar.low < peakPrice) peakPrice = bar.low;
    const rawTrail = long ? peakPrice - trailWidth : peakPrice + trailWidth;
    const candidateStop = long ? Math.max(entry, rawTrail) : Math.min(entry, rawTrail);
    // Ratchet only — never loosens once armed.
    if (long && candidateStop > trailStopPrice) trailStopPrice = candidateStop;
    if (!long && candidateStop < trailStopPrice) trailStopPrice = candidateStop;
    newState = { armedAt: state.armedAt, peakPrice, trailStopPrice };
    const trailHit = long ? bar.low <= trailStopPrice : bar.high >= trailStopPrice;
    if (trailHit) {
      resolution = { resolution: 'TRAIL_EXIT', method: 'BREAKEVEN_TRAIL_HIT', priceAtRes: trailStopPrice };
    }
  }

  if (!resolution && isSessionEnd) {
    resolution = { resolution: 'TIME_EXPIRED', method: 'TRAIL_TIME_EXPIRED', priceAtRes: bar.close };
  }

  return { state: newState, resolution };
}
