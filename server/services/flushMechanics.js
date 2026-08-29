// Shared flush/balance/resolution mechanics for RTH_FLUSH and GLOBEX_FLUSH -- validated
// research: docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md sec 4.4-4.14. Both the historical
// calibration script (scripts/backtest_flush_patterns.mjs) and the two live detectors
// (server/services/rthFlushDetector.js, globexFlushDetector.js) import this so the mechanism
// is identical between backtest and live -- per CLAUDE.md's "export the real function, never
// reimplement" rule.
//
// Mechanism (user's own design requirement, tested and validated both RTH and Globex):
// after a triggering event (a big move, or a structural break), the next
// BALANCE_ESTABLISH_BARS bars form a consolidation range. The trade enters when price closes
// beyond that range by RESOLUTION_THRESHOLD points, and the stop sits at the OPPOSITE edge of
// the balance range (structural, not a fixed point distance) -- confirmed to cost nothing on
// RTH and to be the difference between broken and working on Globex (sec 4.6).

export const BALANCE_ESTABLISH_BARS = 30;
export const RESOLUTION_THRESHOLD = 50;

/**
 * bars: chronological array of bars STRICTLY AFTER the trigger bar, each {ts, high, low, close}.
 * Returns null if not enough bars yet or no resolution found within the given array, else:
 *   { resolutionIdx, resolutionDir: 'UP'|'DOWN', entryPrice, stopPrice, balanceHigh, balanceLow }
 * resolutionIdx is the index within `bars` (0-based) where the resolution bar sits.
 *
 * entryPrice is the resolution bar's own CLOSE, not the bare threshold (balanceHigh+50 /
 * balanceLow-50) -- found in DeepSeek code review (2026-08-27, F3): the threshold price has
 * already been passed by construction the instant the resolution bar closes (that's the firing
 * condition), so using it as the fill assumes a price the market had already left behind, a
 * one-sided optimistic bias on every single trade (overshoot is always >=0, never favorable).
 * The resolution bar's own close is the honest "what you could actually have gotten" fill,
 * known at the exact instant the decision is made -- no lookahead, no slippage assumption needed
 * beyond "the market gives you its own last print."
 */
export function computeBalanceAndResolution(bars) {
  if (bars.length <= BALANCE_ESTABLISH_BARS) return null;
  let balanceHigh = -Infinity, balanceLow = Infinity;
  for (let i = 0; i < BALANCE_ESTABLISH_BARS; i++) {
    balanceHigh = Math.max(balanceHigh, bars[i].high);
    balanceLow = Math.min(balanceLow, bars[i].low);
  }
  for (let i = BALANCE_ESTABLISH_BARS; i < bars.length; i++) {
    const b = bars[i];
    if (b.close > balanceHigh + RESOLUTION_THRESHOLD) {
      return { resolutionIdx: i, resolutionDir: 'UP', entryPrice: b.close, stopPrice: balanceLow, balanceHigh, balanceLow };
    }
    if (b.close < balanceLow - RESOLUTION_THRESHOLD) {
      return { resolutionIdx: i, resolutionDir: 'DOWN', entryPrice: b.close, stopPrice: balanceHigh, balanceHigh, balanceLow };
    }
  }
  return null;
}

/**
 * Pace from session open to the entry bar, points/minute -- known entirely at entry time
 * (sec 4.11), no lookahead. openPrice/openTs from the session's own first bar.
 */
export function computeEntryPace(openPrice, openTs, entryPrice, entryTs) {
  const elapsedMin = (new Date(entryTs).getTime() - new Date(openTs).getTime()) / 60000;
  if (elapsedMin <= 0) return null;
  return Math.abs(entryPrice - openPrice) / elapsedMin;
}
