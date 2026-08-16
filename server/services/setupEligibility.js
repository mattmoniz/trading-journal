import { query } from '../db.js';

// Canonical "is this setup_type currently allowed to fire ACTIVE" source. Every live insert
// path must call this instead of reimplementing its own N/EV threshold check -- see
// docs/PROMOTION_PIPELINE_STRUCTURAL_FIX_SPEC.md. Mirrors the exact SQL already used to
// build server/routes/acd.js's liveStats._suppressedSetups/_dowSuppressToday (extracted from
// there, not reinvented) -- SUPPRESS/THIN_N both cause SHADOW-only, ACTIVE/PROMOTE allow ACTIVE.
// `.catch(() => ({ rows: [] }))` on both queries matches the original inline call sites'
// fail-open-on-DB-error posture for the REST of the request (a transient DB blip here must not
// 500 the whole setup-detection response) -- but note this pairs with isLiveEligible()'s own
// fail-CLOSED default below: an empty knownTypes Set from a caught error means every setup_type
// reads as "unknown" and therefore ineligible, not eligible. Availability is preserved; the
// suppression decision itself still fails safe.
export async function computeSuppressionSets(todayDowInt) {
  const [setupStatusQ, dowStatusQ] = await Promise.all([
    query(`
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
  return {
    status: isLive ? 'ACTIVE' : 'SHADOW',
    reason: isLive ? null : (row.recommendation === 'THIN_N' ? 'NEW_SIGNAL_UNDER_LIVE_EVALUATION' : 'PERFORMANCE_BELOW_THRESHOLD'),
    liveN: row.sample_size, liveEv: row.ev,
  };
}
