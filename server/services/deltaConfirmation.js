// Cumulative delta confirmation — shared classification logic reused by both the live
// resolution path (server/routes/acd.js) and the rolling calibration script
// (scripts/calibrate_delta_confirmation.mjs), matching the same "shared module, don't
// reimplement" convention as computeBar6Checkpoint (maeMfeReplay.js).
//
// Built 2026-07-28 from RESEARCH_CLAIM cumulative_delta_confirms_breakout_beyond_price_alone
// and cumulative_delta_confirms_fades_stronger_than_breakout: holding price action equal
// (both groups tick to a new favorable extreme within K bars of entry), whether cumulative
// delta (running sum of ask_volume-bid_volume, sign-flipped for direction) also builds
// alongside it splits a real WR/EV gap — validated for both STACK_VOL_BREAK_LIVE-style
// breakout continuations and real level-fade setups, at K=10.
//
// Purely informational — this function only classifies, it does not gate entry or adjust
// targets. Both of those were tested separately and failed
// (pre_entry_cumulative_delta_no_entry_edge, target_extension_on_confirmation_not_actionable).

const K_BARS = 10;

/**
 * Classify a trade's post-entry order-flow confirmation state.
 * bars: ordered array of 1-min bars STARTING AFTER the entry bar (i.e. already "bars
 *   since entry", matching resolveSetupsByPrice()'s own `bars.rows` convention —
 *   `sharedBarsRows.filter(b => b.ts > row.fired_at)`, strictly greater-than, so the
 *   entry bar itself is never included) — each with { high, low, ask_volume, bid_volume }.
 * direction: 'LONG' | 'SHORT'
 * entryPrice: the trade's entry price.
 * threshold: the calibrated cumulative-delta floor (25th percentile of positive deltas
 *   for this category — read from performance_audit, never hardcoded here).
 * Returns null if fewer than K_BARS bars are available since entry.
 */
function classifyDeltaConfirmation(bars, direction, entryPrice, threshold) {
  if (!bars || bars.length < K_BARS) return null;
  const window = bars.slice(0, K_BARS);

  let cumDelta = 0;
  let newExtreme = false;
  for (const b of window) {
    const delta = (b.ask_volume || 0) - (b.bid_volume || 0);
    cumDelta += (direction === 'LONG' ? delta : -delta);
    if (direction === 'LONG' && b.high > entryPrice) newExtreme = true;
    if (direction === 'SHORT' && b.low < entryPrice) newExtreme = true;
  }

  const strongDelta = cumDelta >= threshold;
  // DIVERGENCE (strongDelta && !newExtreme) folds into NO_EFFORT for the live badge --
  // both prior tests found it too thin to distinguish reliably (N=0-11 historically),
  // and the live population will be even thinner per-category early on.
  let state;
  if (strongDelta && newExtreme) state = 'CONFIRMATION';
  else if (!strongDelta && newExtreme) state = 'PRICE_ONLY_CONTROL';
  else state = 'NO_EFFORT';

  return { state, cumDelta, newExtreme, kBars: K_BARS };
}

/** Which calibration category a setup_type belongs to, or null if not covered yet.
 * Scope matches exactly what's been validated:
 * - 'FADE': real RTH level-fade setup_types (RESEARCH_CLAIM
 *   cumulative_delta_confirms_fades_stronger_than_breakout).
 * - 'FADE_GLOBEX': `_OVERNIGHT`-suffixed fade variants — a SEPARATE category, not folded
 *   into 'FADE', because Globex has a genuinely different volume scale (calibrated floor
 *   p25=31 vs RTH's p25=143 at K=10 — confirmed, not assumed) (RESEARCH_CLAIM
 *   cumulative_delta_confirms_globex_fades_too).
 * - 'BREAKOUT': STACK_VOL_BREAK_LIVE's RTH breakout-continuation entries (RESEARCH_CLAIM
 *   cumulative_delta_confirms_breakout_beyond_price_alone).
 * Deliberately does NOT cover the "OTHER" session-structure family (IB_BULLISH, TRT,
 * C_STANDALONE, OPEN_DRIVE, BRACKET_BREAKOUT, VALUE_AREA_RESPONSIVE, VWAP_MAGNET,
 * STOP_SWEEP) — tested and found NOT validated (RESEARCH_CLAIM
 * cumulative_delta_other_family_too_thin_not_validated: N far too thin for most of these
 * setup_types, and the one family with real N, BRACKET_BREAKOUT, showed no effect at all,
 * contradicting the initial "generalizes universally" claim). Extend this function only
 * once a category clears its own validated RESEARCH_CLAIM with real N, not preemptively. */
function getDeltaConfirmationCategory(setupType) {
  if (/^STACK_VOL_BREAK_LIVE_(LONG|SHORT)$/.test(setupType)) return 'BREAKOUT';
  if (setupType.endsWith('_OVERNIGHT')) {
    return /_FADE_(LONG|SHORT)_OVERNIGHT$/.test(setupType) ? 'FADE_GLOBEX' : null;
  }
  if (/_FADE_(LONG|SHORT)(_TRAIL)?(_GAP_(UP|DOWN))?$/.test(setupType)) return 'FADE';
  return null;
}

export { classifyDeltaConfirmation, getDeltaConfirmationCategory, K_BARS };
