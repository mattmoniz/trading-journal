import { query } from '../db.js';
import { REAL_TRADE_FILTER } from '../../scripts/backtest_setup_status.mjs';

// Stop/target calibration methods that carry NO per-type validated information -- a
// placeholder default, not a real computed optimum. Shared with scripts/update_optimal_stops.mjs
// (the writer) so this reader can never drift out of sync with what the writer actually stamps.
export const PLACEHOLDER_STOP_METHODS = new Set(['volatility-scaled-default', 'p75mae-real-fallback']);
export function isPlaceholderStopMethod(method) {
  return PLACEHOLDER_STOP_METHODS.has(method);
}

// Found 2026-08-19 investigating promotion_pipeline_remaining_stuck_types: SETUP_STATUS is
// NOT one uniform trust tier (getCanonicalLiveStatus()'s own header below already warns
// about this generically -- this is where that warning gets teeth). These setup_types'
// ONLY writer is a bar-history BACKTEST SIMULATION script, never backtest_setup_status.mjs
// (the real-forward writer) -- confirmed live: WPP_FADE_SHORT_GAP_UP's latest SETUP_STATUS
// row (source=backtest_wpp_short_gap.mjs) says ACTIVE/N=30, while its real active_setups
// history is exactly 1 row, SHADOW-origin. A prior fix (conditional_variant_setup_status_
// daily_overwrite_race, 2026-08-10) taught backtest_setup_status.mjs's generic scanner to
// SKIP this signal_name entirely (skipGenericSetupStatus in CONDITIONAL_VARIANTS) -- so
// unlike an ordinary type, this is not "stale until the next real-forward run," it will
// NEVER organically get overwritten by real data; the dedicated bar-history script owns it
// permanently. Trusting its ACTIVE recommendation at face value would fire it live on zero
// real forward validation -- the exact regression minuteBarSignalDetector.js's own
// getLiveStatus() header documents being caught and reverted for MOMENTUM_60m_60m_TREND.
// MOMENTUM_60m_60m_TREND/_BALANCE_FADE are listed here too even though the TREND family
// already has its own hand-rolled real-N check in minuteBarSignalDetector.js (this list
// makes computeSuppressionSets()/getCanonicalLiveStatus() independently safe for them too,
// belt-and-suspenders -- harmless overlap, not a conflicting second mechanism, since both
// converge on the same real_n>=20 answer from the same active_setups data).
export const BACKTEST_DERIVED_SETUP_STATUS_TYPES = new Set([
  'WPP_FADE_SHORT_GAP_UP',   // scripts/backtest_wpp_short_gap.mjs
  'MOMENTUM_60m_60m_TREND',        // scripts/backtest_momentum60_daytype.mjs
  'MOMENTUM_60m_60m_BALANCE_FADE', // scripts/backtest_momentum60_daytype.mjs
]);

// Real (non-BACKFILL/UNKNOWN, non-mark-to-market) resolved N/EV for a setup_type, computed
// directly from active_setups -- NEVER from a SETUP_STATUS row, since that's exactly what's
// untrustworthy for BACKTEST_DERIVED_SETUP_STATUS_TYPES. Reuses REAL_TRADE_FILTER (the
// canonical real-trade predicate, scripts/backtest_setup_status.mjs) and the same
// resolution/actual_pnl gate minuteBarSignalDetector.js's own getLiveStatus() uses -- not
// reimplemented, matching this codebase's export-the-real-function rule.
async function getRealForwardStats(setupType) {
  const { rows } = await query(`
    SELECT COUNT(*) as n, AVG(actual_pnl)::float as ev
    FROM active_setups
    WHERE setup_type = $1 AND ${REAL_TRADE_FILTER}
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL
  `, [setupType]);
  return { n: +rows[0].n, ev: rows[0].ev != null ? +rows[0].ev : null };
}

// true = this type's SETUP_STATUS 'ACTIVE'/'PROMOTE' recommendation is trustworthy enough
// to fire live on. For an ordinary type this is always true (its SETUP_STATUS row already
// came from real-forward data by construction). For a BACKTEST_DERIVED_SETUP_STATUS_TYPES
// member, only true once real forward N>=20 with EV not below the standard -$5 floor --
// same bar backtest_setup_status.mjs applies everywhere else, just computed by hand because
// the normal writer will never run for these signal_names.
export async function hasRealForwardClearance(setupType) {
  if (!BACKTEST_DERIVED_SETUP_STATUS_TYPES.has(setupType)) return true;
  const { n, ev } = await getRealForwardStats(setupType);
  return n >= 20 && !(ev != null && ev < -5);
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
  ['GLOBEX_VWAP_FADE_LONG', { reason: 'STOP_NEVER_SWEPT', addedDate: '2026-08-19', revisitWhen: 'getStopCalibrationConfidence() returns unvalidated:false -- real N clears MIN_SWEEPABLE_N (27) with a genuinely-swept, non-placeholder OPTIMAL_STOP method AND the fresh sweep is not itself day-clustered (rigor.clustered!==true) -- both conditions, not just the N/method one (flagged 2026-08-19, DeepSeek review of commit 47da9ed: the original wording named only the method condition, not the clustering check the diagnostic actually applies)' }],
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
  // Found 2026-08-19 (promotion_pipeline_remaining_stuck_types): an ACTIVE/PROMOTE
  // recommendation from a BACKTEST_DERIVED_SETUP_STATUS_TYPES member is NOT the same
  // guarantee it is for every other type -- its SETUP_STATUS row can never be organically
  // replaced by real-forward data (the writer is a bar-history simulation script, not
  // backtest_setup_status.mjs), so trusting it here would let the type fire ACTIVE with
  // zero real validation, forever. Only check the small handful in the list -- one query
  // per candidate, not a blanket per-poll cost.
  for (const t of BACKTEST_DERIVED_SETUP_STATUS_TYPES) {
    if (knownTypes.has(t) && !suppressedSetups.has(t) && !(await hasRealForwardClearance(t))) {
      suppressedSetups.add(t);
    }
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
// FIXED 2026-08-19 (DeepSeek code review of commit 47da9ed, same-day): this used to check
// only the WR/EV-driven suppression sets, missing CAPITAL_EXPOSURE_OVERRIDE entirely --
// shadowCandidates' promotion INSERT (acd.js ~8881, the RTH-hours 24hr-VWAP-fade touch of
// GLOBEX_VWAP_FADE_LONG/SHORT, a THIRD insert path for these exact setup_type names beyond
// the 2 the override commit actually covered) calls isLiveEligible() directly, so a type on
// the override list could still reach origin_status='ACTIVE' through this path even though
// getCanonicalLiveStatus() (the Globex-hours path) correctly blocked it. Confirmed live:
// GLOBEX_VWAP_FADE_LONG has SETUP_STATUS recommendation=ACTIVE, so pre-this-fix
// isLiveEligible() returned true here regardless of the override. Checking the override in
// THIS canonical function (rather than patching the one known call site) means any future
// caller gets it for free, per this function's own "every live insert path must call this
// instead of reimplementing" contract.
export function isLiveEligible(setupType, { suppressedSetups, dowSuppressToday, knownTypes }) {
  return knownTypes.has(setupType) && !suppressedSetups.has(setupType) && !dowSuppressToday.has(setupType)
    && !CAPITAL_EXPOSURE_OVERRIDE.has(setupType);
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
  // WR/EV cleared -- still check whether this row itself is trustworthy (see
  // BACKTEST_DERIVED_SETUP_STATUS_TYPES's header: some SETUP_STATUS rows can never be
  // organically replaced by real-forward data). No current caller of this function is on
  // that list, but the whole point of a canonical function is that a FUTURE caller gets
  // this protection automatically without having to know to ask for it.
  if (!(await hasRealForwardClearance(signalName))) {
    const real = await getRealForwardStats(signalName);
    return { status: 'SHADOW', reason: 'NEW_SIGNAL_UNDER_LIVE_EVALUATION', liveN: real.n, liveEv: real.ev };
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
