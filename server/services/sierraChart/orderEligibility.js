// The real-order gate -- the ONE choke point every real-order insert path must call
// before submitting anything to Sierra Chart's DTC server. NOT part of the portable
// seam (dtcClient.js/killSwitch.js) -- this file is trading-journal-specific by design,
// since "is this setup_type allowed to trade" only makes sense in terms of this app's
// own performance_audit/SETUP_STATUS data.
//
// Built on computeSuppressionSets() DIRECTLY, never getCanonicalLiveStatus()/
// isLiveEligible() -- those two honor SUPPRESS_ALL_DISABLED (a temporary, explicitly
// scoped-as-simulation-only research override to make the app's own internal
// SHADOW/ACTIVE tracking show "everything," see CLAUDE.md's SUPPRESS_ALL_DISABLED
// "Where to look" entry) and would silently let a confirmed-dead setup_type place a
// REAL order the instant that flag is ever turned back on for research purposes. This
// file must never be able to inherit that override -- computeSuppressionSets() itself
// has no knowledge of it either, by design, which is exactly why it's the right
// building block here (see CLAUDE.md's "getCanonicalLiveStatus()/isLiveEligible() are
// not safe for a 'should this be recommended' report" convention).
//
// Real-money-adjacent decision, made explicitly with the user 2026-09-28 (not a default
// picked silently): the FULL PROMOTE_ALL_MODE roster (241 setup_types, SUPPRESS/THIN_N
// excluded) is eligible for a real order in this first build, not a narrower
// pre-PROMOTE_ALL_MODE "Live" list. This is a materially larger real-order surface than
// this codebase has ever used for anything before real capital was on the line via this
// path -- if PROMOTE_ALL_MODE is ever narrowed/reverted for its OWN (unrelated) reason,
// re-confirm this file's exposure hasn't silently widened or narrowed as a side effect.
//
// Single in-process source of truth for the kill switch: this file and
// server/routes/sierraChart.js both import the SAME `killSwitch` instance below (module
// singleton, one state file) rather than each constructing their own KillSwitch -- so
// the dashboard and the real order-eligibility check can never observe different states
// at the same instant.

import path from 'path';
import { query } from '../../db.js';
import { computeSuppressionSets } from '../setupEligibility.js';
import { KillSwitch } from './killSwitch.js';

export const KILL_SWITCH_STATE_PATH = path.join(process.cwd(), 'scratch', 'sierra_chart_kill_switch.json');
export const killSwitch = new KillSwitch({ stateFilePath: KILL_SWITCH_STATE_PATH });

function todayEtDowInt() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
}

/**
 * ENTRY-ONLY. This gate must NEVER be used to decide whether an EXIT/flatten order can
 * go out (flagged by DeepSeek review, 2026-09-29) -- arming/halting the kill switch
 * controls whether the app opens NEW risk, not whether it can close existing risk.
 * Wiring an exit through this function would mean halting the kill switch mid-trade
 * blocks flattening, which is backwards (flattening is de-risking, exactly what you'd
 * still want to happen while halted). Exit placement (placeExitOrder in
 * reconciliation.js) intentionally does not call this function at all.
 *
 * The single real-order eligibility check for ENTRIES. Returns { eligible: boolean, reason: string }.
 * Checks, in order (cheapest/most-likely-to-block first):
 *   1. Kill switch armed? (a global halt always wins, regardless of setup quality)
 *   2. SETUP_STATUS says SUPPRESS/THIN_N for this setup_type?
 *   3. SETUP_STATUS_DOW says SUPPRESS for this setup_type today?
 *   4. Does this active_setups row already have a real order placed for it? (idempotency
 *      -- the DB's own partial unique index on order_placements(setup_id) WHERE
 *      purpose='ENTRY' is the actual hard guarantee; this is a cheap pre-check so a
 *      caller doesn't waste a DTC round-trip on something the DB would reject anyway)
 */
export async function isOrderEligible(setupType, setupId) {
  if (!killSwitch.isArmed()) {
    return { eligible: false, reason: 'kill switch not armed' };
  }

  const { suppressedSetups, dowSuppressToday } = await computeSuppressionSets(todayEtDowInt());
  if (suppressedSetups.has(setupType)) {
    return { eligible: false, reason: `SETUP_STATUS suppresses ${setupType} (SUPPRESS or THIN_N)` };
  }
  if (dowSuppressToday.has(setupType)) {
    return { eligible: false, reason: `SETUP_STATUS_DOW suppresses ${setupType} today` };
  }

  if (setupId != null) {
    const existing = await query(
      `SELECT 1 FROM order_placements WHERE setup_id = $1 AND purpose = 'ENTRY' LIMIT 1`,
      [setupId]
    );
    if (existing.rows.length > 0) {
      return { eligible: false, reason: `order_placements already has an ENTRY order for setup_id=${setupId}` };
    }
  }

  return { eligible: true, reason: null };
}
