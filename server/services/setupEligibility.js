import { query } from '../db.js';

// Stop/target calibration methods that carry NO per-type validated information -- a
// placeholder default, not a real computed optimum. Shared with scripts/update_optimal_stops.mjs
// (the writer) so this reader can never drift out of sync with what the writer actually stamps.
export const PLACEHOLDER_STOP_METHODS = new Set(['volatility-scaled-default', 'p75mae-real-fallback']);
export function isPlaceholderStopMethod(method) {
  return PLACEHOLDER_STOP_METHODS.has(method);
}

// Diagnostic only -- NOT auto-wired into any live gate. Reports whether a setup_type's
// current OPTIMAL_STOP is a placeholder (never genuinely swept) or a genuinely-swept value
// built on a severely day-clustered real sample. A first version of this file DID wire this
// generically into getCanonicalLiveStatus() below and was caught before shipping: 96 of the
// 101 currently ACTIVE/PROMOTE setup_types run on 'volatility-scaled-default' right now --
// that's this codebase's normal, accepted, real-N-still-growing state (see CLAUDE.md's own
// "CURRENT STATE... every live setup_type's STOP is sized from a population that has never
// been filtered for synthetic data" entry), not a defect. Auto-gating on it would have forced
// ~95% of the live roster to SHADOW. Separately, gating live ACTIVE/SUPPRESS on
// computeRigor()'s `clustered` bit specifically contradicts this codebase's own standing rule
// (CLAUDE.md "Rigor diagnostics are standing, not one-off": rigor diagnostics are
// informational and must NOT feed suppression decisions, with exactly one deliberate,
// separately-reviewed exception already made for SETUP_STATUS_DOW). Kept as an exported
// diagnostic because it's genuinely useful for exactly the kind of one-off, human-reviewed
// capital-exposure call CAPITAL_EXPOSURE_OVERRIDE below documents -- query it when deciding
// whether to add or remove an override entry, don't wire it to auto-decide.
export async function getStopCalibrationConfidence(signalName) {
  const { rows } = await query(`
    SELECT DISTINCT ON (signal_name) notes
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND signal_name=$1
    ORDER BY signal_name, run_date DESC
  `, [signalName]);
  const row = rows[0];
  if (!row || !row.notes) return { unvalidated: false, reason: null, method: null, clustered: null };
  let notes = {};
  try { notes = typeof row.notes === 'string' ? JSON.parse(row.notes) : row.notes; } catch (_) { return { unvalidated: false, reason: null, method: null, clustered: null }; }
  const method = notes.method ?? null;
  const clustered = notes.rigor?.clustered ?? null;
  if (isPlaceholderStopMethod(method)) {
    return { unvalidated: true, reason: 'STOP_NEVER_SWEPT', method, clustered };
  }
  if (clustered === true) {
    return { unvalidated: true, reason: 'STOP_DAY_CLUSTERED', method, clustered };
  }
  return { unvalidated: false, reason: null, method, clustered };
}

// Deliberate, human-reviewed capital-exposure overrides -- NOT a WR/EV suppression list (that
// stays 100% owned by backtest_setup_status.mjs's automatic SETUP_STATUS pipeline per CLAUDE.md's
// "Unified suppression pipeline" hard rule) and NOT a generic auto-detected rule (see
// getStopCalibrationConfidence()'s header for why that overreaches). This is a DIFFERENT,
// narrower axis: a setup_type whose WR/EV clears the bar but whose underlying stop/target
// calibration is specifically known-thin in a way real capital shouldn't be sized against yet.
// Added 2026-08-19 (OPEN_DECISION optimal_stop_circuit_breaker_retripped_20260812), acting on
// 2 independent DeepSeek reviews recommending exposure management over trusting either number:
//   - GLOBEX_VWAP_FADE_LONG: real N=25-26, just below MIN_SWEEPABLE_N=27 -- its PRIOR stop was
//     discovered 2026-08-18 to have been silently using a self-referential censored fallback
//     that looked calibrated but wasn't (see docs/OPEN_THREADS.md); even post-fix it's on the
//     honest-but-unvalidated volatility-scaled-default placeholder, one type among ~94 others
//     in that same state -- what's specific to THIS one is the just-discovered prior
//     contamination, not the placeholder state itself.
//   - IB_BULLISH: genuinely swept (method='chronological-sweep-real'), but 97.1% day-clustered
//     -- only 7 distinct real trading days behind its entire calibration, an extreme outlier
//     even among the small number of other genuinely-swept-but-clustered types.
// REVISIT: each entry names its own real-N/clustering condition to re-check before removing --
// query getStopCalibrationConfidence(type) directly; do not remove an entry just because it
// stops showing up in a routine scan, confirm the condition that added it has actually cleared.
// This is a small, explicit, dated exception list (same shape as REFIRE_COOLDOWN_MINUTES
// elsewhere in acd.js) -- add to it only after the same deliberate-review bar these 2 cleared,
// not as a default response to any future thin-N/clustered finding.
export const CAPITAL_EXPOSURE_OVERRIDE = new Map([
  ['GLOBEX_VWAP_FADE_LONG', { reason: 'STOP_NEVER_SWEPT', addedDate: '2026-08-19', revisitWhen: 'real N clears MIN_SWEEPABLE_N (27) with a genuinely-swept, non-placeholder OPTIMAL_STOP method' }],
  ['IB_BULLISH', { reason: 'STOP_DAY_CLUSTERED', addedDate: '2026-08-19', revisitWhen: 'computeRigor().clustered is false on a fresh sweep (i.e. real trading days spread out past the current 7-day, 97.1%-top5 concentration)' }],
]);

// Canonical "is this setup_type currently allowed to fire ACTIVE" source. Every live insert
// path must call this instead of reimplementing its own N/EV threshold check -- see
// docs/PROMOTION_PIPELINE_STRUCTURAL_FIX_SPEC.md. Mirrors the exact SQL already used to
// build server/routes/acd.js's liveStats._suppressedSetups/_dowSuppressToday (extracted from
// there, not reinvented) -- SUPPRESS/THIN_N both cause SHADOW-only, ACTIVE/PROMOTE allow ACTIVE.
// `.catch(() => ({ rows: [] }))` on the DOW query matches the original inline call site's
// fail-open-on-DB-error posture for the REST of the request (a transient DB blip here must not
// 500 the whole setup-detection response) -- but note this pairs with isLiveEligible()'s own
// fail-CLOSED default below: an empty knownTypes Set from a caught error means every setup_type
// reads as "unknown" and therefore ineligible, not eligible. Availability is preserved; the
// suppression decision itself still fails safe.
//
// `setupStatusRows` (optional): pass the caller's own already-fetched SETUP_STATUS rows
// (signal_name, recommendation -- extra columns are fine, ignored) to skip this function's own
// SETUP_STATUS query entirely. FIXED 2026-08-16 (DeepSeek 2nd-pass QA): acd.js's caller also
// needs the fuller SETUP_STATUS row shape (sample_size/win_rate/ev_per_trade) for its own
// _setupStats map and was fetching that separately -- this function used to always re-query
// SETUP_STATUS on top of that, meaning _setupStats and _suppressedSetups/knownTypes could in
// principle come from two different query instants (a race window of milliseconds, since both
// read the same latest-row-per-signal_name shape) instead of provably the same rows, undermining
// this whole fix's "one source of truth" premise. Pass the rows through instead when the caller
// already has them.
export async function computeSuppressionSets(todayDowInt, setupStatusRows = null) {
  const [setupStatusQ, dowStatusQ] = await Promise.all([
    setupStatusRows ? Promise.resolve({ rows: setupStatusRows }) : query(`
      SELECT DISTINCT ON (signal_name) signal_name, recommendation
      FROM performance_audit WHERE signal_type = 'SETUP_STATUS'
      ORDER BY signal_name, run_date DESC
    `).catch(() => ({ rows: [] })),
    query(`
      SELECT DISTINCT ON (signal_name) signal_name, recommendation
      FROM performance_audit WHERE signal_type = 'SETUP_STATUS_DOW' AND signal_name LIKE $1
      ORDER BY signal_name, run_date DESC
    `, [`%_DOW_${todayDowInt}`]).catch(() => ({ rows: [] })),
  ]);
  const suppressedSetups = new Set();
  const knownTypes = new Set();
  for (const r of setupStatusQ.rows) {
    knownTypes.add(r.signal_name);
    if (r.recommendation === 'SUPPRESS' || r.recommendation === 'THIN_N') suppressedSetups.add(r.signal_name);
  }
  const dowSuppressToday = new Set();
  for (const r of dowStatusQ.rows) {
    if (r.recommendation === 'SUPPRESS') dowSuppressToday.add(r.signal_name.replace(/_DOW_\d+$/, ''));
  }
  return { suppressedSetups, dowSuppressToday, knownTypes };
}

// FIXED 2026-08-16 (DeepSeek QA of the promotion-pipeline structural fix, same session): this
// originally inferred eligibility purely from set-membership in suppressedSetups/dowSuppressToday
// -- meaning a setup_type with NO SETUP_STATUS row at all (never calibrated, or a transient query
// failure) was "not suppressed" and therefore treated as live-eligible, the exact fail-open
// "fundamental" bug class this whole fix exists to close, just relocated into the new gate
// itself. Now requires the setup_type to have a KNOWN row before it can be eligible -- absent
// from SETUP_STATUS entirely defaults to ineligible (SHADOW), matching getCanonicalLiveStatus's
// own fail-closed "no row -> SHADOW" behavior below, so the two halves of this fix agree on the
// "no data" case instead of disagreeing.
export function isLiveEligible(setupType, { suppressedSetups, dowSuppressToday, knownTypes }) {
  return knownTypes.has(setupType) && !suppressedSetups.has(setupType) && !dowSuppressToday.has(setupType);
}

// Canonical resolved-trade eligibility check for standalone pollers -- currently used by acd.js's
// getOvernightLevelLiveStatus/getStackVolBreakLiveStatus (see
// docs/PROMOTION_PIPELINE_STRUCTURAL_FIX_SPEC.md Layer 3). Reads the real SETUP_STATUS row
// instead of recomputing N/EV from active_setups by hand, so TIME_EXPIRED handling, real_n
// scoping, and every other SETUP_STATUS refinement apply here automatically. signalName must be
// the EXACT performance_audit.signal_name this family is calibrated under (both current callers
// use the exact fired setup_type -- their existing convention, unchanged).
//
// IMPORTANT, found by DeepSeek QA 2026-08-16: SETUP_STATUS is NOT one uniform trust tier. Some
// rows come from backtest_setup_status.mjs (real forward active_setups trades); others (e.g.
// backtest_momentum60_daytype.mjs, backtest_wpp_short_gap.mjs) come from a bar-history BACKTEST
// SIMULATION, never from real trades. Before pointing any new caller at this function, confirm
// which script actually WRITES the target signal_name's row -- a backtest-derived row would let
// a detector fire ACTIVE on its first-ever real touch with zero forward validation, exactly the
// regression this check caught in an earlier version of the minuteBarSignalDetector.js migration
// (reverted same session -- see that file's getLiveStatus() for the full writeup).
export async function getCanonicalLiveStatus(signalName) {
  const { rows } = await query(`
    SELECT recommendation, sample_size, ev_per_trade::float as ev
    FROM performance_audit WHERE signal_type='SETUP_STATUS' AND signal_name=$1
    ORDER BY run_date DESC LIMIT 1
  `, [signalName]);
  const row = rows[0];
  if (!row) return { status: 'SHADOW', reason: 'NEW_SIGNAL_UNDER_LIVE_EVALUATION', liveN: 0, liveEv: null };
  const isLive = row.recommendation === 'ACTIVE' || row.recommendation === 'PROMOTE';
  if (!isLive) {
    return {
      status: 'SHADOW',
      reason: row.recommendation === 'THIN_N' ? 'NEW_SIGNAL_UNDER_LIVE_EVALUATION' : 'PERFORMANCE_BELOW_THRESHOLD',
      liveN: row.sample_size, liveEv: row.ev,
    };
  }
  // WR/EV cleared -- still check the deliberate, human-reviewed capital-exposure override list
  // above (NOT a generic calibration-confidence auto-check -- see CAPITAL_EXPOSURE_OVERRIDE's
  // own header for why an automatic version of this was tried and reverted).
  const override = CAPITAL_EXPOSURE_OVERRIDE.get(signalName);
  if (override) {
    return { status: 'SHADOW', reason: override.reason, liveN: row.sample_size, liveEv: row.ev };
  }
  return { status: 'ACTIVE', reason: null, liveN: row.sample_size, liveEv: row.ev };
}
