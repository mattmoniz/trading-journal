/**
 * Auto-shadow / auto-promote setup types based on accumulated performance.
 * UNIFIED suppression system — the ONLY suppression source. acd.js hardcoded
 * suppressedFades set was removed 2026-07-09; all suppression flows through here.
 *
 * SUPPRESS: real_n≥20, real EV<-$5/trade (no WR gate — catches high-WR structural losers)
 * PROMOTE:  currently suppressed AND recent 90-day real_n≥15, real WR≥52%, real EV>$0 → restore to ACTIVE
 *
 * SUPPRESS/PROMOTE both gate on REAL (origin_status IN ('ACTIVE','SHADOW')) EV/WR/N as of
 * 2026-08-10 — not the all-time/blended figures. Fixed the same day CAM_S2_FADE_SHORT was
 * found firing live ACTIVE on all-time blended EV=+$1.37 (76% synthetic BACKFILL/UNKNOWN)
 * while its real recent-90d EV was -$8.02 (N=22, 100% of its real history) — the SUPPRESS
 * check had never used real_n/real_ev at all despite this file computing real_n since
 * 2026-07-20 for exactly this class of contamination. Root-cause fix per direct user
 * instruction ("fix the cron, don't build an override") rather than a manual one-time flip
 * or a precedence/override mechanism layered on top — this makes CAM_S2 (and likely other
 * types never individually audited) self-demote on the very next run, and self-correct again
 * automatically once real EV genuinely recovers, same as everything else in this file.
 * PROMOTE's real_n gate (previously a separate, looser PROMOTE_MIN_REAL_N=5 floor stacked on
 * top of a blended-N/WR/EV check) is now just real_n/real_wr/real_ev directly at the same
 * PROMOTE_MIN_N=15 bar as everything else in this decision — a real recovery needs 15 real
 * trades, not 5 real trades padded out to 15 with synthetic ones.
 *
 * Shadow setups still resolve (TARGET_HIT/STOP_HIT) so data keeps accumulating.
 * When a suppressed setup recovers statistically it automatically comes back live.
 *
 * Writes signal_type='SETUP_STATUS' rows to performance_audit.
 * acd.js reads _suppressedSetups at startup — new setups of suppressed types
 * insert as status='SHADOW' with suppression_reason='PERFORMANCE_BELOW_THRESHOLD'.
 *
 * Run:  node scripts/backtest_setup_status.mjs
 * Cron: Sunday 10:30 PM ET (run_weekly_backtests.sh), also run_daily_calibration.sh (Mon-Fri
 *       8:20 PM ET — verified directly against the live crontab 2026-08-10, not assumed;
 *       CLAUDE.md's own "4:20pm ET" reference for this cron is stale/wrong, separate from
 *       today's fix)
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { CONDITIONAL_VARIANTS, getBetClass } from '../server/config/setupTypes.js';

const SIGNAL_TYPE = 'SETUP_STATUS';

// Thresholds — EV-only gate catches high-WR structural losers that a WR threshold misses
const SUPPRESS_MIN_N   = 20;   // N≥20 satisfies the hard floor from CLAUDE.md
const SUPPRESS_MAX_EV  = -5;   // EV below -$5/trade (sole condition — no WR gate)

// The "real trade" predicate — excludes synthetic BACKFILL/UNKNOWN origin_status rows and
// MTM/RECOVERY_MTM resolutions (never a real bar-by-bar resolution). ONE shared constant, used
// by both the main gate's queries below AND the DOW sub-pass — this exact duplication (the DOW
// pass had its own un-synced copy of this filter) is what let the DOW gate miss the main gate's
// 2026-08-10 real-data-scoping fix for weeks (OPEN_DECISION
// setup_status_dow_gate_93pct_synthetic_never_rescoped, fixed 2026-08-17). Any future query
// needing "is this a real, resolvable trade" must reuse this string, not hand-roll a copy.
// ib_window_stale_basis exclusion added 2026-08-19 (OPEN_DECISION
// ib_bullbear_window_fix_recalibration_needed): flags real trades whose classification
// changed under the 2026-08-12 IB-window correction (30-min -> 60-min) -- currently 31
// IB_BEARISH rows, backfilled via scripts/backfill_ib_window_stale_exclusion_20260819.mjs.
// NULL/false for every other row (this column is not written by any live INSERT path, only
// that one-time backfill script), so this clause is a no-op for every setup_type except the
// ones actually tagged.
export const REAL_TRADE_FILTER = `origin_status IN ('ACTIVE','SHADOW') AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM')) AND ib_window_stale_basis IS NOT TRUE`;

// bet_class-level SUPPRESS override — roadmap Phase 8 I6/user-authorized 2026-08-11 action,
// following the file's own established philosophy (see header: "fix the cron, don't build
// an override... self-correct again automatically"). This is NOT a bolt-on override applied
// after the fact — it's one more condition feeding the same recommendation decision below,
// re-evaluated fresh every run exactly like SUPPRESS/PROMOTE/THIN_N already are.
//
// Why this exists: VALUE_FADE (the roadmap's Setup A consolidation, ~166 setup_types) tests
// real, MTM-clean EV negative at N=1,238+ (RESEARCH_CLAIM value_fade_stage3_reconciliation) --
// decisive by this codebase's own N>=20 standard, just measured at the bet_class level
// instead of per-type. A day-type decomposition found the aggregate is dragged down by
// firing on TREND/TURBULENT days (BALANCE alone is real-EV-positive, N=605, EV=+$7.18 --
// RESEARCH_CLAIM value_fade_daytype_conditioned_ev_balance_positive) -- but that finding
// CANNOT be acted on with a live per-fire gate: the only ground-truth day-type source
// (acd_daily_log.day_type) is null all day until the 20:20 ET nightly cron, and the only
// live-estimate alternative was already tested as a fade-suppression gate input and found
// NET HARMFUL (2026-08-03, OPEN_DECISION dtclass_null_all_day_neuters_multiple_live_gates,
// RESOLVED: N=440, net delta -$3,238.60, 70.6% FPR specifically on fade-touch moments).
// Given no reliable live day-type signal exists, this operates as a bet_class-wide batch
// decision instead -- fully retrospective (no live time-of-day dependency), enforced
// through the SAME already-live, already-day-type-blind _suppressedSetups mechanism every
// other SUPPRESS decision already uses. The real cost (documented, not hidden): this
// necessarily also suppresses on BALANCE days, where VALUE_FADE is genuinely positive --
// the honest trade-off given no way to distinguish BALANCE from TREND/TURBULENT live.
//
// Design reviewed with DeepSeek before writing (scratch/deepseek_response.md, 2026-08-11):
// - Threshold is bet_class-generic (a Set, not a single hardcoded name) so a future
//   bet_class showing the same pattern gets the same protection without a new code path --
//   but only VALUE_FADE is enabled today, since it's the only bet_class with real evidence
//   of this shape (CONTINUATION_LEGACY/GLOBEX_LEVEL are real-EV-positive as of this run).
// - N floor is 200, not the per-type SUPPRESS_MIN_N=20 -- this override can suppress many
//   individual types at once (currently ~15-19 live VALUE_FADE types), so it needs a much
//   higher bar than a single type's own thin-data floor.
// - Threshold is EV<0 (strictly negative), not the individual per-type SUPPRESS_MAX_EV=-5 --
//   VALUE_FADE's clean pooled EV (~-$1 to -$3/trade) never actually clears -5, but a
//   1,000+-trade pooled sample smooths out the per-type noise that -5 exists to filter, so a
//   less extreme bar is appropriate at this N.
// - Escape hatch: a VALUE_FADE type whose OWN real EV is already non-negative (>=0) is NOT
//   suppressed by this override, regardless of the bet_class aggregate -- a type that's
//   already independently proving itself shouldn't be punished for its siblings' losses.
//   This only affects types that were headed for the implicit 'ACTIVE'/unchanged branch
//   below (realN>=20, realEv>=-5, i.e. individually "not clearly bad") -- a type already
//   being SUPPRESSed or THIN_N on its own doesn't need this override, it's already
//   SHADOW-only either way.
const BET_CLASS_SUPPRESS_ENABLED = new Set(['VALUE_FADE']);
const BET_CLASS_SUPPRESS_MIN_N   = 200;
const BET_CLASS_SUPPRESS_MAX_EV  = 0;

const PROMOTE_WINDOW_DAYS = 90;
// 2026-08-10: PROMOTE_MIN_N/WR/EV now apply to REAL (origin_status IN ('ACTIVE','SHADOW'))
// stats directly, not blended -- 15 real trades in the last 90 days is what signals a
// recovery, not 15 blended trades where as few as 5 could be real (the old
// PROMOTE_MIN_REAL_N=5 floor, now redundant and removed: real_n>=15 already implies
// real_n>=5). Same root-cause fix as the SUPPRESS gate below -- see the file header.
const PROMOTE_MIN_N    = 15;
const PROMOTE_MIN_WR   = 0.52;
const PROMOTE_MIN_EV   = 0;    // any positive real EV

// Setup types that are day-type conditional — their overall EV blends good and bad day types
// and therefore can't be evaluated as a single suppress/promote decision. These are managed
// by DAY_TYPE_ALPHA in acd.js, which applies per-(setup_type × day_type) sizing adjustments.
const DAY_TYPE_CONDITIONAL = new Set([
  // IB_BULLISH/IB_BEARISH REMOVED 2026-08-31 -- see MANUAL_SUPPRESS_OVERRIDE below. Their
  // DAY_TYPE_CONDITIONAL treatment assumed a real day-type interaction exists to condition on;
  // this session's audit (docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md) found the "good
  // bucket" has flipped 3 times across independent audits -- the signature of noise being
  // re-discovered as signal, not a real effect -- which is exactly why this carve-out kept
  // giving them a pass (at least one bucket always happens to clear the -$5 bar) despite
  // negative all-time blended EV. If a genuinely new DAY_TYPE_CONDITIONAL candidate shows up,
  // add it here as its own entry with its own justification -- don't reuse this comment.
]);

// Deliberate, human-reviewed manual suppression -- NOT a threshold the automatic SUPPRESS/
// PROMOTE/THIN_N logic below computed (that stays the default path for everything else per
// CLAUDE.md's "Unified suppression pipeline" hard rule), and NOT the same axis as
// CAPITAL_EXPOSURE_OVERRIDE (setupEligibility.js -- that's specifically for a type whose WR/EV
// clears the bar but whose stop/target calibration is known-thin). This is a THIRD, narrower
// axis: a type user-confirmed dead based on a full qualitative audit that a blended-EV/N
// threshold can't capture on its own.
//
// IB_BULLISH/IB_BEARISH, added 2026-08-31 (user-confirmed, "dump them both", following
// docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md's full audit): the live signal
// (computeIbBullBear()) never tested the setups' own named thesis (break-and-retest of the IB
// boundary, then drive) -- it's a same-instant midpoint-position + order-flow snapshot with no
// break/retest/drive logic at all. The proposed real-thesis replacement (Idea 1) was tested at
// its cheapest kill-gate (a placebo/level-swap test, Gemini mine-and-run, independently
// re-verified) and came back clean negative -- the real IB boundary did not outperform an
// economically meaningless midpoint or an arbitrary shifted level. Two other real negatives
// already exist in this codebase for this same shape of idea (OPEN_TEST_DRIVE_LONG/SHORT,
// EV -$29.54/-$14.74/trade; the structural-breakout-retest engine, 0/8). IB_BULLISH was also
// separately already SHADOW-only since 2026-08-19 via CAPITAL_EXPOSURE_OVERRIDE (day-clustered
// stop/target calibration) -- a second, independent red flag.
// REVISIT: only if a materially different mechanism/anchor is designed, tested from scratch,
// and clears this codebase's standard rigor bar (chronological OOS, plateau, computeRigor,
// real N≥20) -- not by this file's own automatic recovery logic, which this override
// deliberately bypasses. Remove the entry only after that fresh work, not because a routine
// scan stops flagging it.
const MANUAL_SUPPRESS_OVERRIDE = new Map([
  ['IB_BULLISH', { reason: 'no_real_thesis_tested_plus_placebo_test_negative', addedDate: '2026-08-31' }],
  ['IB_BEARISH', { reason: 'no_real_thesis_tested_plus_placebo_test_negative', addedDate: '2026-08-31' }],
]);

async function run() {
  console.log('[backtest_setup_status] Starting...');
  // SQL CURRENT_DATE (DB server runs in America/New_York), not JS toISOString() (UTC) — the
  // two disagree once past 8PM ET, which silently excluded MOMENTUM_60m_60m_TREND from the
  // /api/performance-audit/unified "latest run" join. Same class of bug Gemini caught in
  // backtest_minute_bar_scan.mjs 2026-07-14, found here independently the same day while
  // verifying the Unified Signal Table actually showed the new setup.
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);

  // All-time stats per setup_type (includes SHADOW rows — they still resolve). real_n
  // counts only ACTIVE/SHADOW-origin trades -- added 2026-07-20 alongside the PROMOTE
  // fix. n itself blends in BACKFILL (synthetic, never fired live) and UNKNOWN-origin
  // (pre-2026-07-09, unrecoverable provenance) rows -- confirmed live that of all 9,734
  // TARGET_HIT/STOP_HIT rows, only 101 (1%) are real. The SUPPRESS_MIN_N=20 floor below
  // was already being checked against this blended n, silently satisfying this
  // codebase's own N>=20 hard floor with synthetic data for the vast majority of the
  // live roster (all 73 non-suppressed setup_types had real_n<20, most had real_n=0).
  // See CLAUDE.md / OPEN_DECISION setup_status_calibration_ignores_origin_status_backfill.
  //
  // TIME_EXPIRED added to every resolution filter in this file 2026-08-03 (all 6 sites --
  // this query, recentQ, dtConditionalQ, perTradeQ, dowQ, dowTradesQ): this exclusion
  // dates to the file's original commit, correct at the time (TIME_EXPIRED trades had
  // NULL actual_pnl then) but stale since the 2026-07-20 mark-to-market fix gave them real
  // P&L -- a sibling script (targetCalibrationService.js) was fixed for the identical
  // reason the very next day, this one never was. Confirmed live: 1,384 TIME_EXPIRED
  // trades system-wide, 1,363 with valid actual_pnl (avg +$9.18), ~7% of all resolved
  // trades, silently missing from every setup_type's N/real_n/EV. Win-rate formula
  // deliberately left unchanged (stays strict resolution='TARGET_HIT', not actual_pnl>0)
  // to match the existing convention in analyze_execution_efficiency.mjs -- WR answers
  // "did this resolve decisively in our favor," EV/N carry the P&L question. Gemini
  // design-critiqued before this change (scratch/gemini_review_time_expired_setup_status_fix.md).
  // MTM/RECOVERY_MTM exclusion added to real_n/real_ev/real_wr 2026-08-11 (found via
  // preflight_backtest_assertions.mjs check [8] while building the VALUE_FADE bet_class
  // override; OPEN_DECISION setup_status_realev_mtm_exclusion_needs_dedicated_pass, now
  // resolved). Blast radius was verified BEFORE applying, not assumed: a full before/after
  // reconstruction (Gemini dispatch, cross-checked directly by Claude against the live DB --
  // both independently landed on the same 2 flips) found only GLOBEX_VWAP_FADE_LONG
  // (SUPPRESS -> ACTIVE, real EV -$7.22 -> -$1.67 clean) and IB_HIGH_FADE_LONG (ACTIVE ->
  // THIN_N, real N 20 -> 18 clean, below the floor) change status system-wide -- both
  // reviewed and judged acceptable (GLOBEX_VWAP_FADE_LONG's clean EV is still barely above
  // the existing -$5 SUPPRESS_MAX_EV bar, the same bar every other setup_type in this system
  // is already held to; IB_HIGH_FADE_LONG's flip is the conservative direction). Only real_n/
  // real_ev/real_wr (already origin_status-scoped) changed here -- the blended n/ev/wr columns
  // deliberately still include everything (BACKFILL, MTM, all of it), matching their own
  // documented purpose as the unfiltered population view.
  const allTimeQ = await query(`
    SELECT
      setup_type,
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE ${REAL_TRADE_FILTER}) AS real_n,
      AVG((resolution='TARGET_HIT')::int)::float AS wr,
      AVG(actual_pnl)::float AS ev,
      AVG(actual_pnl) FILTER (WHERE ${REAL_TRADE_FILTER})::float AS real_ev,
      SUM(actual_pnl)::float AS total_pnl
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND actual_pnl IS NOT NULL
    GROUP BY setup_type
    ORDER BY setup_type
  `);

  // Recent 90-day stats (to detect recovery). real_n counts only ACTIVE/SHADOW-origin,
  // MTM/RECOVERY_MTM-excluded trades within the same window -- added 2026-07-20 after
  // FLOOR_S1_FADE_LONG promoted to live purely on 15 BACKFILL-origin (synthetic) trades
  // averaging +$8.33, overriding 115 real-backtest trades that were rigor-confirmed negative
  // in all 3 chronological thirds (-$12.63/-$12.63/-$3.92, never once positive, -$1,113
  // total). The PROMOTE gate never checked provenance, so a recovery could be entirely
  // fabricated. MTM exclusion added 2026-08-11, same pass/reasoning as allTimeQ above.
  const recentQ = await query(`
    SELECT
      setup_type,
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE ${REAL_TRADE_FILTER}) AS real_n,
      AVG((resolution='TARGET_HIT')::int)::float AS wr,
      AVG(actual_pnl)::float AS ev,
      AVG((resolution='TARGET_HIT')::int) FILTER (WHERE ${REAL_TRADE_FILTER})::float AS real_wr,
      AVG(actual_pnl) FILTER (WHERE ${REAL_TRADE_FILTER})::float AS real_ev
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND actual_pnl IS NOT NULL
      AND trade_date >= CURRENT_DATE - 90
    GROUP BY setup_type
  `);
  const recent = {};
  for (const r of recentQ.rows) recent[r.setup_type] = r;

  // bet_class-level pooled real, MTM-clean EV/N for the SUPPRESS_ENABLED bet_classes (see
  // BET_CLASS_SUPPRESS_ENABLED above). Computed inline, not read from BET_CLASS_STATUS --
  // DeepSeek design critique (scratch/deepseek_response.md): backtest_bet_class_status.mjs
  // runs AFTER this script in run_weekly_backtests.sh, so reading its table here would see
  // last week's number on every weekly run, and this script also runs DAILY (Mon-Fri, via
  // run_daily_calibration.sh) while backtest_bet_class_status.mjs is weekly-only -- reading
  // its table on a daily run would read up-to-6-day-stale data. An inline query keeps this
  // check fresh on every run this script itself runs, matching the "self-correct every run"
  // convention already established for SUPPRESS/PROMOTE above.
  const betClassPooledQ = BET_CLASS_SUPPRESS_ENABLED.size > 0 ? await query(`
    SELECT bet_class, COUNT(*) AS n, AVG(actual_pnl)::float AS ev
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND actual_pnl IS NOT NULL
      AND ${REAL_TRADE_FILTER}
      AND bet_class = ANY($1)
    GROUP BY bet_class
  `, [[...BET_CLASS_SUPPRESS_ENABLED]]) : { rows: [] };
  const betClassPooled = {};
  for (const r of betClassPooledQ.rows) betClassPooled[r.bet_class] = { n: +r.n, ev: +r.ev };
  for (const bc of BET_CLASS_SUPPRESS_ENABLED) {
    const pooled = betClassPooled[bc];
    const triggered = pooled && pooled.n >= BET_CLASS_SUPPRESS_MIN_N && pooled.ev < BET_CLASS_SUPPRESS_MAX_EV;
    console.log(`  [bet_class override] ${bc}: pooled real clean N=${pooled?.n ?? 0} EV=$${pooled?.ev != null ? pooled.ev.toFixed(2) : 'n/a'} -- ${triggered ? 'TRIGGERED (suppressing constituent types without their own proven positive EV)' : 'not triggered'}`);
  }

  // Current SETUP_STATUS rows — what's already suppressed
  const currentStatusQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit
    WHERE signal_type = $1
    ORDER BY signal_name, run_date DESC
  `, [SIGNAL_TYPE]);
  const currentStatus = {};
  for (const r of currentStatusQ.rows) currentStatus[r.signal_name] = r.recommendation;

  // Per-day-type breakdown for DAY_TYPE_CONDITIONAL types (2026-07-14) — blended EV is
  // meaningless for these (mixes profitable and unprofitable day-types by design), but
  // DAY_TYPE_MANAGED isn't a real floor either if EVERY day-type bucket is bad. Found via
  // the IB_BULLISH incident (docs/OPEN_THREADS.md): fired live at negative blended EV
  // (-$27.81/trade, N=106) because this block previously skipped the standard SUPPRESS
  // check unconditionally for these two types. Reuses SUPPRESS_MIN_N/SUPPRESS_MAX_EV —
  // no new thresholds.
  const dtConditionalQ = await query(`
    SELECT s.setup_type, dl.day_type, COUNT(*) AS n, AVG(s.actual_pnl)::float AS ev
    FROM active_setups s
    JOIN acd_daily_log dl ON dl.trade_date = s.trade_date
    WHERE s.setup_type = ANY($1)
      AND s.resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND s.actual_pnl IS NOT NULL
      AND dl.day_type IS NOT NULL
    GROUP BY s.setup_type, dl.day_type
  `, [[...DAY_TYPE_CONDITIONAL]]);
  const dtBreakdown = {};
  for (const r of dtConditionalQ.rows) {
    if (!dtBreakdown[r.setup_type]) dtBreakdown[r.setup_type] = [];
    dtBreakdown[r.setup_type].push({ dayType: r.day_type, n: +r.n, ev: +r.ev });
  }

  // Rigor diagnostics added 2026-07-14 (same checks applied to the minute-bar scanner):
  // day-clustering (catches N inflated by a handful of sessions — this is exactly the bug
  // found in the CAM_R4/CAM_S3 investigation) and 3-way chronological EV-sign stability.
  // Informational only — does NOT feed into SUPPRESS/PROMOTE logic below, so this doesn't
  // silently change which setups are live. Surfaces as new fields in `notes` for review.
  const perTradeQ = await query(`
    SELECT setup_type, trade_date::text AS trade_date, actual_pnl::float AS pnl, fired_at
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL
    ORDER BY setup_type, fired_at ASC
  `);
  const tradesByType = new Map();
  for (const r of perTradeQ.rows) {
    if (!tradesByType.has(r.setup_type)) tradesByType.set(r.setup_type, []);
    tradesByType.get(r.setup_type).push(r);
  }
  // Centralized 2026-07-14 into server/services/rigorDiagnostics.js — was one of 3 independent
  // copies of this same logic written the same day. NOTE: the shared version requires >=5
  // events per third (was >=3 here) for the stability check to run at all — a deliberate
  // consistency fix, matching the other 2 callers, slightly stricter than before.
  function rigorDiagnostics(type) {
    const trades = tradesByType.get(type) || [];
    const rigor = computeRigor(trades, { dateField: 'trade_date', pnlFn: t => t.pnl });
    return { distinctDates: rigor.distinctDates, top5DayPct: rigor.top5DayPct, stable: rigor.stable, thirds: rigor.thirds, boundaryStraddle: rigor.boundaryStraddle, zScores: rigor.zScores, zTrend: rigor.zTrend };
  }

  // Distinct-day floor for NEW promotions (2026-09-04, user-requested general fix — not
  // specific to the cluster-sibling-touch-credit mechanism, applies to every setup_type's
  // promotion decision equally). Reuses computeRigor()'s existing clustered flag
  // (top5DayPct>50) rather than inventing a new threshold — the SAME definition already used
  // to gate SETUP_STATUS_DOW's SUPPRESS decision (rigor.clean, which itself requires
  // !clustered). Root problem: real_n alone can't distinguish "20 trades across 20 different
  // days" from "20 trades from 5 days that each happened to generate several" -- confirmed
  // live today on GLOBEX_VWAP_MAGNET_LONG (real_n=98, only 4 distinct days) with ZERO
  // cluster-sibling involvement, so this is a pre-existing gap the promotion gate has for
  // every data source, not something unique to the new sibling-credit rows.
  //
  // Computed on the REAL-only population (REAL_TRADE_FILTER-scoped) specifically, matching
  // realN/realEv being what actually drives the promotion decision — the blended
  // rigorDiagnostics() above (all origins pooled) is a different, less relevant population for
  // this specific check.
  const perTradeRealQ = await query(`
    SELECT setup_type, trade_date::text AS trade_date, actual_pnl::float AS pnl, fired_at
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL AND ${REAL_TRADE_FILTER}
    ORDER BY setup_type, fired_at ASC
  `);
  const realTradesByType = new Map();
  for (const r of perTradeRealQ.rows) {
    if (!realTradesByType.has(r.setup_type)) realTradesByType.set(r.setup_type, []);
    realTradesByType.get(r.setup_type).push(r);
  }
  function realRigorDiagnostics(type) {
    const trades = realTradesByType.get(type) || [];
    const rigor = computeRigor(trades, { dateField: 'trade_date', pnlFn: t => t.pnl });
    return { distinctDates: rigor.distinctDates, top5DayPct: rigor.top5DayPct, clustered: rigor.clustered };
  }

  // Automated version of the classification Gemini did by hand 2026-07-14 for the 26 unstable
  // setups (scratch/unstable_active_setups_20260714.json / docs/OPEN_THREADS.md) — the logic
  // itself was simple rule-based comparison, not real judgment, so it's encoded here to run
  // every week without a manual dispatch. "Unstable" (3-way sign flip) does NOT mean "losing" —
  // it can mean genuinely improving. This classifies which is which. Informational only, same
  // as the rest of `rigor` — does not feed SUPPRESS/PROMOTE.
  function classifyTrend(overallEv, thirds, rec90) {
    if (!thirds) return null; // not enough trades for a 3-way split at all
    const sameSignAsOverall = [thirds.ev1, thirds.ev2, thirds.ev3].every(v => Math.sign(v) === Math.sign(overallEv));
    if (sameSignAsOverall) return 'STABLE';
    const rec90N = rec90 ? +rec90.n : 0;
    const rec90Ev = rec90 ? +rec90.ev : null;
    if (rec90N < 5) return 'THIN'; // matches Gemini's own N<=5 "too thin to classify" cutoff
    const trendingDown = thirds.ev1 > 0 && thirds.ev3 < 0;
    const trendingUp = thirds.ev1 < 0 && thirds.ev3 > 0;
    if (trendingDown && rec90Ev < 0) return 'DEGRADING';
    if (trendingUp && rec90Ev > 0) return 'IMPROVING';
    if (Math.sign(overallEv) === Math.sign(rec90Ev)) return 'NOISY_BUT_STABLE';
    return 'AMBIGUOUS';
  }

  const results = [];
  let suppressed = 0, promoted = 0, unchanged = 0;

  let skippedConditional = 0;
  for (const r of allTimeQ.rows) {
    const type   = r.setup_type;

    // conditional_variant_setup_status_daily_overwrite_race (OPEN_DECISION): this generic
    // blind GROUP-BY-setup_type scan can't replicate a real entry-condition filter a
    // dedicated CONDITIONAL_VARIANTS script uses (e.g. WPP_FADE_SHORT_GAP_UP's
    // open_below_wpp) — writing a SETUP_STATUS row here for such a type would silently
    // overwrite the dedicated script's correct, differently-populated row with a wrong one
    // computed from the unfiltered population. Skip entirely; see setupTypes.js's
    // skipGenericSetupStatus comment for the full incident and why _TRAIL variants are NOT
    // skipped here (they have no competing SETUP_STATUS writer).
    if (CONDITIONAL_VARIANTS[type]?.skipGenericSetupStatus) {
      skippedConditional++;
      continue;
    }

    const n      = +r.n;
    const realN  = +r.real_n;
    const wr     = +r.wr;
    const ev     = +r.ev;
    const rec90  = recent[type];
    const wasSuppressed = currentStatus[type] === 'SUPPRESS';
    // Distinct-day floor scope: only gates a NEW promotion (wasn't already live-eligible),
    // never demotes something already ACTIVE/PROMOTE off this check alone -- matches the
    // agreed scope (cheaper, safer, mirrors the SETUP_STATUS_DOW precedent's own scope).
    const wasLiveEligible = ['ACTIVE', 'PROMOTE'].includes(currentStatus[type]);

    // Manual suppress override (see MANUAL_SUPPRESS_OVERRIDE above) — a deliberate,
    // human-reviewed kill that bypasses this file's own automatic recommendation logic
    // entirely, including the recovery/PROMOTE path. Checked first, before any other branch.
    if (MANUAL_SUPPRESS_OVERRIDE.has(type)) {
      const override = MANUAL_SUPPRESS_OVERRIDE.get(type);
      suppressed++;
      console.log(`  SUPPRESS ${type.padEnd(38)} manual override: ${override.reason} (added ${override.addedDate})`);
      results.push({ type, n, realN, wr, ev, totalPnl: +r.total_pnl, recommendation: 'SUPPRESS', rec90, manualOverride: override });
      continue;
    }

    // Day-type conditional setups: skip the blended-EV suppress/promote check — managed
    // per-day-type by DAY_TYPE_ALPHA / the dtClass checks in acd.js instead. But still apply
    // a real floor: if EVERY day-type bucket with enough data (N>=SUPPRESS_MIN_N) is below
    // breakeven, there's no good day-type left for this setup to fire on, so fall through to
    // the standard SUPPRESS — same bar as everything else, just computed per-bucket first.
    if (DAY_TYPE_CONDITIONAL.has(type)) {
      const buckets = dtBreakdown[type] || [];
      const bucketsWithData = buckets.filter(b => b.n >= SUPPRESS_MIN_N);
      const anyGoodBucket = bucketsWithData.some(b => b.ev >= SUPPRESS_MAX_EV);
      let rec;
      if (bucketsWithData.length > 0 && !anyGoodBucket) {
        rec = 'SUPPRESS';
        suppressed++;
        console.log(`  SUPPRESS ${type.padEnd(38)} all day-type buckets below bar: ${bucketsWithData.map(b => `${b.dayType} N=${b.n} EV=$${b.ev.toFixed(0)}`).join(', ')}`);
      } else {
        // Found 2026-07-16 (long-tail setup-type audit, docs/OPEN_THREADS.md): this used to
        // set 'ACTIVE' when recovering from a prior SUPPRESS (wasSuppressed=true), which
        // silently bypasses the whole point of DAY_TYPE_CONDITIONAL -- these types are NEVER
        // actually unconditional, they're always gated per-day-type by the hardcoded nulling
        // in acd.js (~line 3945: BALANCE nulls both, TURBULENT nulls IB_BULLISH, TREND nulls
        // IB_BEARISH). Confirmed live regression: IB_BULLISH flipped SUPPRESS (2026-07-14,
        // correct, see the incident writeup) -> ACTIVE (2026-07-15) purely because its TREND
        // bucket's EV ticked from -$16.24 to -$2.94 (still negative, still N=33, just barely
        // above the -$5 bar) -- a single noisy recalibration, not a real recovery, yet the
        // 'ACTIVE' label told the Unified Signal Table (and anyone reading it) this was a
        // fully-vetted, unconditionally-firing setup at blended EV=-$29/trade. Always
        // 'DAY_TYPE_MANAGED' now, matching IB_BEARISH's (never-suppressed) label -- accurately
        // reflects that the per-day-type carve-out, not this script, is what's actually gating
        // it, and that carve-out's own bucket EVs still need reading before trusting the fire.
        rec = 'DAY_TYPE_MANAGED';
        unchanged++;
      }
      results.push({ type, n, wr, ev, totalPnl: +r.total_pnl, recommendation: rec, rec90, dayTypeBreakdown: buckets });
      continue;
    }

    let recommendation = 'ACTIVE';
    let betClassOverride = null;
    // 2026-08-10 root-cause fix (see file header): SUPPRESS/PROMOTE both gate on REAL
    // (origin_status-filtered) EV/WR/N now, never blended. realEv/rec90Real* are null only
    // when their filtered row count is 0 (AVG(...) FILTER returns NULL on zero matches).
    const realEv = r.real_ev != null ? +r.real_ev : null;
    const rec90RealN  = rec90 && rec90.real_n  != null ? +rec90.real_n  : 0;
    const rec90RealWr = rec90 && rec90.real_wr != null ? +rec90.real_wr : null;
    const rec90RealEv = rec90 && rec90.real_ev != null ? +rec90.real_ev : null;

    const promoteRecoveryQualifies = wasSuppressed && rec90RealN >= PROMOTE_MIN_N && rec90RealWr != null && rec90RealWr >= PROMOTE_MIN_WR && rec90RealEv != null && rec90RealEv > PROMOTE_MIN_EV;
    const newPromotionRealRigor = (!wasLiveEligible && promoteRecoveryQualifies) ? realRigorDiagnostics(type) : null;
    if (promoteRecoveryQualifies && newPromotionRealRigor?.clustered) {
      // Distinct-day floor (2026-09-04): clears every existing PROMOTE bar but the real
      // trades behind it are concentrated in too few distinct days (top5DayPct>50) to trust
      // as broad evidence yet -- stays SUPPRESS, not a silent block (logged plainly), and
      // will promote normally once genuinely new days accumulate and this clears on its own.
      recommendation = 'SUPPRESS';
      suppressed++;
      console.log(`  SUPPRESS ${type.padEnd(38)} PROMOTE bar cleared but DAY_CLUSTERED (real top5DayPct=${newPromotionRealRigor.top5DayPct}%, distinctDates=${newPromotionRealRigor.distinctDates}) — held back pending broader evidence`);
    } else if (promoteRecoveryQualifies) {
      // Recovery detected — promote back to live
      recommendation = 'PROMOTE';
      promoted++;
      console.log(`  PROMOTE  ${type.padEnd(38)} all: N=${n} (real=${realN}) EV=$${ev.toFixed(0)} (real=$${realEv != null ? realEv.toFixed(0) : 'n/a'})  recent90 real: N=${rec90RealN} WR=${(rec90RealWr*100).toFixed(1)}% EV=$${rec90RealEv.toFixed(0)}`);
    } else if (realN >= SUPPRESS_MIN_N && realEv != null && realEv < SUPPRESS_MAX_EV) {
      recommendation = 'SUPPRESS';
      suppressed++;
      const tag = wasSuppressed ? '(already suppressed)' : '← NEW';
      console.log(`  SUPPRESS ${type.padEnd(38)} real N=${realN} real EV=$${realEv.toFixed(0)} (blended N=${n} EV=$${ev.toFixed(0)}) ${tag}`);
    } else if (n < SUPPRESS_MIN_N) {
      // CLAUDE.md hard rule: N<20 → SHADOW until enough data to evaluate.
      // acd.js reads THIN_N the same as SUPPRESS — inserts new setups as SHADOW.
      // Auto-clears when N reaches 20 and EV qualifies (next weekly run).
      recommendation = 'THIN_N';
      console.log(`  THIN_N   ${type.padEnd(38)} N=${n} EV=$${ev.toFixed(0)} — shadow until N≥20`);
    } else if (realN < SUPPRESS_MIN_N) {
      // Blended n clears the N>=20 floor, but real_n (ACTIVE/SHADOW-origin only, excluding
      // BACKFILL/UNKNOWN) doesn't -- the blended count was satisfying this codebase's own
      // N>=20 hard floor with synthetic data. Found 2026-07-20: all 73 then-non-suppressed
      // setup_types had real_n<20 (most had real_n=0) despite blended n often being 100+.
      // Same THIN_N/SHADOW treatment as the low-blended-n case above -- not a harsher
      // suppression, just honest about what's actually been validated. Auto-clears the
      // same way once real_n reaches 20 (next weekly run reads fresh origin_status counts).
      recommendation = 'THIN_N';
      console.log(`  THIN_N   ${type.padEnd(38)} N=${n} (real=${realN}) EV=$${ev.toFixed(0)} — blended N clears the floor, real N doesn't`);
    } else {
      // bet_class-level override (see BET_CLASS_SUPPRESS_ENABLED above) — only reached for
      // a type that just cleared every individual bar (real N≥20, real EV≥-$5): "not
      // clearly bad on its own," which is exactly the population this override exists to
      // catch, since a type sitting between -$5 and $0 real EV looks individually fine
      // while its whole bet_class pools decisively negative. Escape hatch: a type whose OWN
      // real EV is already non-negative (≥0) is left alone regardless of the bet_class
      // aggregate — it's independently proving itself, not being carried by noise.
      const betClass = getBetClass(type);
      const pooled = BET_CLASS_SUPPRESS_ENABLED.has(betClass) ? betClassPooled[betClass] : null;
      const betClassTriggered = pooled && pooled.n >= BET_CLASS_SUPPRESS_MIN_N && pooled.ev < BET_CLASS_SUPPRESS_MAX_EV;
      const ownEvProvenPositive = realEv != null && realEv >= 0;
      if (betClassTriggered && !ownEvProvenPositive) {
        recommendation = 'SUPPRESS';
        suppressed++;
        betClassOverride = { bet_class: betClass, pooled_real_clean_n: pooled.n, pooled_real_clean_ev: +pooled.ev.toFixed(2) };
        const tag = wasSuppressed ? '(already suppressed)' : '← NEW';
        console.log(`  SUPPRESS ${type.padEnd(38)} bet_class override: ${betClass} pooled real clean N=${pooled.n} EV=$${pooled.ev.toFixed(2)} (own real N=${realN} EV=$${realEv != null ? realEv.toFixed(2) : 'n/a'}, not independently positive) ${tag}`);
      } else if (wasSuppressed) {
        // Dead-zone fallthrough fix (2026-09-03, active_selection_edge_lost_deadzone_bug_20260903,
        // DeepSeek-reviewed + independently re-verified): a previously-SUPPRESSed type that fails
        // to clear the full PROMOTE bar must NOT silently fall through to the unreassigned default
        // 'ACTIVE' — that let real EV merely recovering into (-5, 0) (still negative), or a
        // recent-90d real WR/N miss, un-suppress a setup without ever meeting the stricter recovery
        // bar. Retain SUPPRESS explicitly instead. No purgatory risk: real_n/rec90RealN pool
        // ACTIVE+SHADOW origin (REAL_TRADE_FILTER), so a retained-SUPPRESS type keeps accumulating
        // real trades toward PROMOTE from its SHADOW fires alone.
        recommendation = 'SUPPRESS';
        suppressed++;
        console.log(`  SUPPRESS ${type.padEnd(38)} retained (failed PROMOTE recovery bar): real EV=$${realEv != null ? realEv.toFixed(2) : 'n/a'}  recent90 real N=${rec90RealN} WR=${rec90RealWr != null ? (rec90RealWr * 100).toFixed(1) : 'n/a'}% EV=$${rec90RealEv != null ? rec90RealEv.toFixed(2) : 'n/a'}`);
      } else if (!wasLiveEligible && realRigorDiagnostics(type).clustered) {
        // Distinct-day floor (2026-09-04): clears real_n/real_ev bars for the FIRST time but
        // the real trades are concentrated in too few distinct days (top5DayPct>50) -- same
        // check and same reasoning as the PROMOTE-recovery gate above, applied to the more
        // common THIN_N -> ACTIVE path. Stays THIN_N (not a new status), self-clears once
        // genuinely new days accumulate. Never applies to a type already ACTIVE/PROMOTE.
        const rr = realRigorDiagnostics(type);
        recommendation = 'THIN_N';
        console.log(`  THIN_N   ${type.padEnd(38)} real N/EV bars cleared but DAY_CLUSTERED (real top5DayPct=${rr.top5DayPct}%, distinctDates=${rr.distinctDates}) — held back pending broader evidence`);
      } else {
        unchanged++;
      }
    }

    results.push({ type, n, realN, wr, ev, realEv, totalPnl: +r.total_pnl, recommendation, rec90, betClassOverride });
  }

  console.log(`\n  ${suppressed} suppressed, ${promoted} promoted, ${unchanged} active/unchanged, ${skippedConditional} skipped (owned by a dedicated CONDITIONAL_VARIANTS script)`);

  // Write to performance_audit — always write every evaluated type so the session-start
  // coverage check can verify all active setup_types have been assessed this week.
  let written = 0, flaggedClustered = 0, flaggedUnstable = 0;
  const trendCounts = { DEGRADING: 0, IMPROVING: 0, NOISY_BUT_STABLE: 0, THIN: 0, AMBIGUOUS: 0 };
  for (const r of results) {
    const rigor = rigorDiagnostics(r.type);
    if (rigor.top5DayPct != null && rigor.top5DayPct > 50) flaggedClustered++;
    if (rigor.stable === false) flaggedUnstable++;
    const trend = rigor.stable === false ? classifyTrend(r.ev, rigor.thirds, r.rec90) : null;
    if (trend && trend in trendCounts) trendCounts[trend]++;
    const notes = JSON.stringify({
      all_time_n:  r.n,
      all_time_real_n: r.realN ?? null,
      all_time_wr: +(r.wr * 100).toFixed(1),
      all_time_ev: +r.ev.toFixed(2),
      // real_ev (origin_status-filtered) is what SUPPRESS actually gates on as of 2026-08-10
      // -- surfaced here so the decision is auditable from the row alone, not just inferred.
      all_time_real_ev: r.realEv != null ? +r.realEv.toFixed(2) : null,
      total_pnl:   +r.totalPnl.toFixed(2),
      recent_90d:  r.rec90 ? {
        n: +r.rec90.n, real_n: r.rec90.real_n != null ? +r.rec90.real_n : null,
        wr: +(+r.rec90.wr * 100).toFixed(1), ev: +(+r.rec90.ev).toFixed(2),
        // real_wr/real_ev (origin_status-filtered) are what PROMOTE actually gates on.
        real_wr: r.rec90.real_wr != null ? +(+r.rec90.real_wr * 100).toFixed(1) : null,
        real_ev: r.rec90.real_ev != null ? +(+r.rec90.real_ev).toFixed(2) : null,
      } : null,
      rigor: { distinct_dates: rigor.distinctDates, top5_day_pct: rigor.top5DayPct, three_way_stable: rigor.stable, thirds: rigor.thirds, boundary_straddle: rigor.boundaryStraddle, z_scores: rigor.zScores, z_trend: rigor.zTrend, trend },
      ...(r.dayTypeBreakdown ? { day_type_breakdown: r.dayTypeBreakdown.map(b => ({ day_type: b.dayType, n: b.n, ev: +b.ev.toFixed(2) })) } : {}),
      // bet_class_override (roadmap Phase 8 I6, 2026-08-11) -- present only when this
      // type's own real N/EV cleared the individual bar but the whole bet_class's pooled
      // real-clean EV was negative at N>=200 (see BET_CLASS_SUPPRESS_ENABLED). Distinguishes
      // "suppressed on its own record" from "suppressed because its family loses" for anyone
      // reading this row later.
      ...(r.betClassOverride ? { bet_class_override: r.betClassOverride } : {}),
    });
    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
      VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size    = EXCLUDED.sample_size,
        win_rate       = EXCLUDED.win_rate,
        ev_per_trade   = EXCLUDED.ev_per_trade,
        total_pnl      = EXCLUDED.total_pnl,
        recommendation = EXCLUDED.recommendation,
        notes          = EXCLUDED.notes
    `, [today, SIGNAL_TYPE, r.type, r.n, r.wr, r.ev, r.totalPnl, r.recommendation, notes]);
    written++;
  }

  // Apply directly to active_setups: flip unresolved rows
  // SUPPRESS: flip ACTIVE unresolved → SHADOW
  const suppressList = results.filter(r => r.recommendation === 'SUPPRESS').map(r => r.type);
  if (suppressList.length) {
    const res = await query(`
      UPDATE active_setups
      SET status = 'SHADOW', suppression_reason = 'PERFORMANCE_BELOW_THRESHOLD'
      WHERE setup_type = ANY($1)
        AND status = 'ACTIVE'
        AND resolution IS NULL
    `, [suppressList]);
    if (res.rowCount) console.log(`  Applied SHADOW to ${res.rowCount} open ACTIVE rows`);
  }

  // PROMOTE: flip SHADOW (performance-reason only) unresolved → ACTIVE
  const promoteList = results.filter(r => r.recommendation === 'PROMOTE').map(r => r.type);
  if (promoteList.length) {
    const res = await query(`
      UPDATE active_setups
      SET status = 'ACTIVE', suppression_reason = NULL
      WHERE setup_type = ANY($1)
        AND status = 'SHADOW'
        AND suppression_reason = 'PERFORMANCE_BELOW_THRESHOLD'
        AND resolution IS NULL
    `, [promoteList]);
    if (res.rowCount) console.log(`  Promoted ${res.rowCount} open SHADOW rows back to ACTIVE`);
  }

  console.log(`\n[backtest_setup_status] ${written} rows written → performance_audit SETUP_STATUS`);
  console.log(`[rigor diagnostics] ${flaggedClustered} setup_types have >50% of N from their top-5 trade dates (day-clustering risk) | ${flaggedUnstable} setup_types fail the 3-way chronological sign-stability check (informational only, not auto-suppressed)`);
  console.log(`[trend classification] of the ${flaggedUnstable} unstable: ${trendCounts.DEGRADING} DEGRADING | ${trendCounts.IMPROVING} IMPROVING | ${trendCounts.NOISY_BUT_STABLE} NOISY_BUT_STABLE | ${trendCounts.THIN} THIN | ${trendCounts.AMBIGUOUS} AMBIGUOUS`);

  // ── Per-DOW suppression (SETUP_STATUS_DOW) ────────────────────────────────
  // For each (DOW, setup_type) with N≥20 and EV<-$5 that isn't ALREADY globally suppressed,
  // write a SETUP_STATUS_DOW row. acd.js loads today's DOW rows into _dowSuppressToday.
  // DOW_TYPE_CONDITIONAL setups (IB_BULLISH/IB_BEARISH) are excluded — they use the
  // candidates path and aren't gated by _dowSuppressToday in the level-fade engine.
  //
  // Rigor gate added 2026-07-28: found on audit (user asked "why did we gate these by
  // DOW, should we pause it") that this pass had NEVER had computeRigor applied to it,
  // unlike every other statistical pipeline in this codebase (the main per-setup_type
  // SUPPRESS/PROMOTE check above already gets it) — a real gap given ~180
  // (setup_type x weekday) cells get tested every run at a thin N>=20 floor with zero
  // multiple-comparison correction. Direct audit of the 39 cells live at the time: only
  // 10 (26%) were chronologically stable and non-clustered; IB_BEARISH_DOW_1 had 68% of
  // its N sitting in just 5 days (a handful of bad Mondays, not a real Monday effect).
  // Fix: a candidate must ALSO pass computeRigor's `clean` bit (stable + not clustered)
  // to actually gate live firing — same standard, not a new one, just finally applied
  // here too. A candidate that clears N/EV but fails rigor still gets a real, visible
  // row (recommendation='ACTIVE', notes carry the rigor stats) rather than silently
  // vanishing, so it's trackable and self-heals to SUPPRESS the moment a future run's
  // fresh population passes rigor (this recomputes from scratch every run, nothing is
  // carried over from a prior decision).
  console.log('\n[backtest_setup_status] Computing per-DOW suppression...');
  const DOW_SIGNAL_TYPE = 'SETUP_STATUS_DOW';
  const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const globalSuppress = new Set(results.filter(r => r.recommendation === 'SUPPRESS').map(r => r.type));

  // 2026-08-17 fix (OPEN_DECISION setup_status_dow_gate_93pct_synthetic_never_rescoped): this
  // sub-pass never got the main gate's 2026-08-10 origin_status-scoping fix. Confirmed live: of
  // the 267 (setup_type, dow) cells clearing blended N>=20, only 8 also clear real_n>=20 (135
  // have real_n=0) -- the same "deciding a live SUPPRESS gate on ~93% synthetic BACKFILL data"
  // bug the main gate already had fixed, just never migrated here. Now mirrors the main gate's
  // real_n/real_ev three-way branch (THIN_N below the real-N floor, never SUPPRESS on blended
  // alone) -- see CLAUDE.md's origin_status hard rule and the main gate's realN/realEv logic
  // above (~line 366) for the identical pattern this reuses.
  const dowQ = await query(`
    SELECT
      EXTRACT(DOW FROM trade_date)::int AS dow,
      setup_type,
      COUNT(*) AS n,
      AVG((resolution='TARGET_HIT')::int)::float AS wr,
      AVG(actual_pnl)::float AS ev,
      SUM(actual_pnl)::float AS total_pnl,
      COUNT(*) FILTER (WHERE ${REAL_TRADE_FILTER}) AS real_n,
      AVG((resolution='TARGET_HIT')::int) FILTER (WHERE ${REAL_TRADE_FILTER})::float AS real_wr,
      AVG(actual_pnl) FILTER (WHERE ${REAL_TRADE_FILTER})::float AS real_ev
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND actual_pnl IS NOT NULL
    GROUP BY 1, 2
    HAVING COUNT(*) >= ${SUPPRESS_MIN_N}
    ORDER BY 1, 2
  `);

  // Per-(setup_type, dow) trade list for the rigor check — one query, not one per
  // candidate (this file already has ~180 candidates to check). Rigor is now computed on the
  // REAL-only population (realTradesByTypeDow), since that's what actually gates SUPPRESS below
  // -- computing rigor on the blended population while gating on real N/EV would check the
  // day-clustering of a population that isn't the one deciding the outcome. tradesByTypeDow
  // (blended) is kept only for the notes JSON's informational blended-rigor readout.
  const dowTradesQ = await query(`
    SELECT setup_type, EXTRACT(DOW FROM trade_date)::int AS dow,
           trade_date::text AS trade_date, actual_pnl::float AS pnl,
           (${REAL_TRADE_FILTER}) AS is_real
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL
    ORDER BY setup_type, dow, trade_date ASC
  `);
  const tradesByTypeDow = new Map();
  const realTradesByTypeDow = new Map();
  for (const r of dowTradesQ.rows) {
    const key = `${r.setup_type}_${r.dow}`;
    if (!tradesByTypeDow.has(key)) tradesByTypeDow.set(key, []);
    tradesByTypeDow.get(key).push(r);
    if (r.is_real) {
      if (!realTradesByTypeDow.has(key)) realTradesByTypeDow.set(key, []);
      realTradesByTypeDow.get(key).push(r);
    }
  }

  let dowSuppressed = 0, dowWritten = 0, dowThinN = 0;
  const newDowSuppress = new Set();
  for (const r of dowQ.rows) {
    const dow = +r.dow;
    const type = r.setup_type;
    const n = +r.n, ev = +r.ev, wr = +r.wr;
    const realN = +r.real_n;
    const realEv = r.real_ev != null ? +r.real_ev : null;
    const realWr = r.real_wr != null ? +r.real_wr : null;

    // Skip globally suppressed (already handled) and Sun/Sat.
    // DAY_TYPE_CONDITIONAL (IB_BULLISH/IB_BEARISH) are NOT skipped here — they are excluded from
    // global suppression, but per-DOW suppression is valid and needed for them.
    // acd.js checks _dowSuppressToday for IB types when building the candidates array.
    if (globalSuppress.has(type) || dow === 0 || dow === 6) continue;

    const signalName = `${type}_DOW_${dow}`;
    const realTrades = realTradesByTypeDow.get(`${type}_${dow}`) || [];
    const blendedTrades = tradesByTypeDow.get(`${type}_${dow}`) || [];
    // Rigor gates the decision on the REAL population only (see comment above); blended rigor
    // is informational-only, carried in notes for continuity with the pre-fix rows.
    const rigor = computeRigor(realTrades, { dateField: 'trade_date', pnlFn: t => t.pnl });
    const blendedRigor = computeRigor(blendedTrades, { dateField: 'trade_date', pnlFn: t => t.pnl });

    // realN>=20 AND realEv qualifies (<-$5) but rigor isn't clean — "would have suppressed on
    // the numbers alone, held back by rigor." Distinct from realN>=20 with realEv not even
    // negative enough to consider (genuinely fine, not merely rigor-blocked).
    const evWouldSuppress = realN >= SUPPRESS_MIN_N && realEv != null && realEv < SUPPRESS_MAX_EV;

    let recommendation, shouldSuppress = false;
    if (realN < SUPPRESS_MIN_N) {
      // Same THIN_N treatment as the main gate's realN<SUPPRESS_MIN_N branch: blended N cleared
      // the floor, real N doesn't — honest "not enough real data yet," not a suppression.
      // Expected to be the outcome for most cells today (real data is thin at this weekday
      // granularity) — this is the correct, intended effect of the fix, not a malfunction.
      recommendation = 'THIN_N';
      dowThinN++;
    } else if (evWouldSuppress && rigor.clean === true) {
      recommendation = 'SUPPRESS';
      shouldSuppress = true;
    } else {
      recommendation = 'ACTIVE';
    }

    const notes = JSON.stringify({
      dow, dow_name: DOW_NAMES[dow], setup_type: type,
      n, wr: +(wr*100).toFixed(1), ev: +ev.toFixed(2),
      real_n: realN, real_wr: realWr != null ? +(realWr*100).toFixed(1) : null, real_ev: realEv != null ? +realEv.toFixed(2) : null,
      rigor: { distinctDates: rigor.distinctDates, top5DayPct: rigor.top5DayPct, clustered: rigor.clustered, stable: rigor.stable, boundaryStraddle: rigor.boundaryStraddle, zScores: rigor.zScores, zTrend: rigor.zTrend, clean: rigor.clean },
      // stable===null (real_n<15, too thin for the 3-way chronological check) is "not
      // computable," distinct from stable===false ("computed, failed") — surfaced explicitly so
      // a THIN_N/ACTIVE row doesn't read later as "failed rigor" when rigor was never evaluable.
      ...(rigor.stable === null ? { rigor_insufficient: true } : {}),
      blended_rigor: { distinctDates: blendedRigor.distinctDates, top5DayPct: blendedRigor.top5DayPct, clustered: blendedRigor.clustered, stable: blendedRigor.stable, boundaryStraddle: blendedRigor.boundaryStraddle, zScores: blendedRigor.zScores, zTrend: blendedRigor.zTrend, clean: blendedRigor.clean },
      // failed_rigor: numbers alone would suppress (real_n/real_ev qualify) but rigor blocked it
      // — only meaningful when recommendation stayed ACTIVE despite evWouldSuppress being true.
      ...(recommendation === 'ACTIVE' && evWouldSuppress ? { failed_rigor: true } : {}),
    });

    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
      VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size    = EXCLUDED.sample_size,
        win_rate       = EXCLUDED.win_rate,
        ev_per_trade   = EXCLUDED.ev_per_trade,
        total_pnl      = EXCLUDED.total_pnl,
        recommendation = EXCLUDED.recommendation,
        notes          = EXCLUDED.notes
    `, [today, DOW_SIGNAL_TYPE, signalName, n, wr, ev, +r.total_pnl, recommendation, notes]);

    if (shouldSuppress) {
      console.log(`  DOW_SUPPRESS ${DOW_NAMES[dow].padEnd(4)} ${type.padEnd(38)} real N=${realN} real EV=$${realEv.toFixed(0)} (blended N=${n} EV=$${ev.toFixed(0)}) rigor=clean`);
      newDowSuppress.add(signalName);
      dowSuppressed++;
    } else if (recommendation === 'THIN_N') {
      console.log(`  DOW_THIN_N   ${DOW_NAMES[dow].padEnd(4)} ${type.padEnd(38)} N=${n} (real=${realN}) EV=$${ev.toFixed(0)} — blended N clears the floor, real N doesn't`);
    } else {
      console.log(`  DOW_RIGOR_FAIL ${DOW_NAMES[dow].padEnd(4)} ${type.padEnd(38)} real N=${realN} real EV=$${realEv != null ? realEv.toFixed(0) : 'n/a'} (blended N=${n} EV=$${ev.toFixed(0)}) rigor=${rigor.clustered ? 'clustered' : rigor.stable === null ? 'insufficient' : 'unstable'} (top5day%=${rigor.top5DayPct})`);
    }
    dowWritten++;
  }

  // Clear any stale DOW suppression rows that no longer qualify (set to ACTIVE)
  // Any signal_name matching DOW pattern that ISN'T in this run's suppress set → write ACTIVE
  // Reuses the SAME newDowSuppress set built in the loop above (now rigor-gated) — this
  // used to independently recompute its own copy of the N/EV qualification check here,
  // which would have silently missed the rigor gate and kept clearing/reinstating cells
  // inconsistently with the main loop's decision. One computation, not two.
  const currentDowQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit
    WHERE signal_type = $1
    ORDER BY signal_name, run_date DESC
  `, [DOW_SIGNAL_TYPE]);

  for (const row of currentDowQ.rows) {
    if (row.recommendation === 'SUPPRESS' && !newDowSuppress.has(row.signal_name)) {
      // Was suppressed, no longer qualifies — write ACTIVE to clear it
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
        VALUES ($1, 0, $2, $3, 0, 0, 0, 0, 'ACTIVE', '{"cleared":"no_longer_qualifies"}')
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET recommendation='ACTIVE', notes='{"cleared":"no_longer_qualifies"}'
      `, [today, DOW_SIGNAL_TYPE, row.signal_name]);
      console.log(`  DOW_CLEARED ${row.signal_name} (no longer qualifies)`);
      dowWritten++;
    }
  }

  console.log(`\n[backtest_setup_status] ${dowSuppressed} DOW-specific suppressions (real-N gated) | ${dowThinN} THIN_N (real N below floor) | ${dowWritten} rows written → SETUP_STATUS_DOW`);
  await pool.end();
}

// Guarded 2026-08-19 (found live: exporting REAL_TRADE_FILTER for
// backtest_ib_window_reclassification_impact.mjs to import caused THIS ENTIRE SCRIPT to
// execute as an import side effect -- a real, unintended live write of 247 rows to
// SETUP_STATUS_DOW, plus a pool.end() that then killed every subsequent query in the
// importing script. Same guard pattern already used by update_optimal_stops.mjs (which
// documents the exact same reasoning) -- `node scripts/backtest_setup_status.mjs` still runs
// normally; `import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs'` no longer does.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(e => { console.error('[backtest_setup_status] ERROR:', e.message); process.exit(1); });
}
