/**
 * test_invariants.mjs — executable verification of setup type system invariants.
 *
 * Run after any change touching acd.js, setups.js, or the level-fade pipeline:
 *   node scripts/test_invariants.mjs
 *
 * Exits 0 = all clear. Exits 1 = failures found (print to stdout, CI-friendly).
 *
 * WHAT IT CHECKS:
 *
 * 1. CONDITIONAL_VARIANTS coverage
 *    Every entry in CONDITIONAL_VARIANTS must have:
 *    - SETUP_STATUS row in performance_audit (calibration exists)
 *    - OPTIMAL_STOP row in performance_audit (stop/target data exists)
 *    - inferDirection(variantType) === entry.direction (inference is correct)
 *    - The backtest script exists on disk (script won't silently disappear)
 *
 * 2. ACTIVE setup types have stop/target data
 *    Every ACTIVE SETUP_STATUS row must have a matching OPTIMAL_STOP row.
 *    Catches: setup fires live but acd.js falls back to constants because OPTIMAL_STOP
 *    row was never written or was accidentally deleted.
 *
 * 3. No direction inference failures on live types
 *    inferDirection() must return non-null for every setup type fired in the last 30 days.
 *    Catches: a new type was added whose name doesn't follow any known pattern.
 *
 * 4. resolveSetupType() self-consistency
 *    For every CONDITIONAL_VARIANTS entry, the baseType must be suppressed in the latest
 *    SETUP_STATUS run (otherwise both the base and the variant would fire simultaneously).
 *
 * 5. OPTIMAL_STOP.ev_per_trade actually matches its own optimal_stop/optimal_target
 *    Re-simulates each row's stored EV using the REAL production formula (imported from
 *    update_optimal_stops.mjs, not hand-copied here) applied to that row's own stored
 *    optimal_stop/optimal_target. Catches a stored "derived" field silently drifting from
 *    the values it's supposed to describe -- the general shape of the 2026-07-17 bug where
 *    ev_per_trade quietly kept reporting a raw historical average for 8+ days after the
 *    EV-sweep feature was added on top of it without rewiring that field. General lesson:
 *    whenever a script both COMPUTES a value (the sweep) and separately STORES/DISPLAYS a
 *    number labeled as describing it (ev_per_trade), that pairing needs its own standing
 *    check -- a code review catches "does this line look right," not "does this field's
 *    long-declared meaning still hold after a later feature was bolted on."
 *    2026-07-19: a row whose `notes` marks it method:'corrected-resim' is re-derived via
 *    computeCorrectedTarget() (server/services/targetCalibrationService.js) instead of
 *    sweepOptimalStopAndTarget() -- same principle, different production function, since
 *    update_optimal_stops.mjs now has two possible target-selection paths.
 *
 * 6. UNCALIBRATED_SHADOW_TYPES entries genuinely have no SETUP_STATUS row
 *    Re-checks every entry in server/config/setupTypes.js's UNCALIBRATED_SHADOW_TYPES
 *    against live SETUP_STATUS. Catches an entry that's picked up a real row since it was
 *    added -- if left in place, it would keep hiding that type forever even after a
 *    PROMOTE recommendation, since nothing else ever prunes a hardcoded Set. Pruned this
 *    list from 27 to 5 entries 2026-07-17 after finding 22 were already stale.
 *
 * 7. No dead-end active_setups rows (added 2026-07-27)
 *    A generic, standing tripwire for the whole bug class found this session: 3 separate
 *    INSERT paths (suppressed-near-level audit, CASCADE_BREAKER logging,
 *    minuteBarSignalDetector.js's momentum poller) silently produced rows with no way to
 *    ever reach a real resolved outcome -- caught only because the user asked a pointed
 *    question about one week's numbers, not by anything automated. This check doesn't
 *    depend on knowing which code path is at fault: (a) FAILs if any real row from the last
 *    30 days has no entry/stop/target at all (structurally unresolvable), (b) WARNs on any
 *    resolved-but-actual_pnl-null row not already explained by a known, deliberately-deferred
 *    gap (SESSION_CLOSED, PRE_ENTRY invalidation).
 *
 * 8. Live-fired stop/target actually matches current calibration (added 2026-08-02)
 *    Checks 2 and 5 above both stop at "does an OPTIMAL_STOP row exist / is it internally
 *    self-consistent" -- neither one verifies the LIVE FIRING CODE actually reads that row.
 *    Found this session, only after a direct user question: VWAP_MAGNET_LONG/SHORT and the
 *    RTH-hours half of GLOBEX_VWAP_MAGNET_LONG/SHORT (server/routes/acd.js's
 *    vwapMagnetSetup/globexVwapMagnetRTH blocks) use a hand-typed 30pt stop / 20pt target
 *    that has NEVER read OPTIMAL_STOP at all, on this system's single highest-volume live
 *    setup family (~230 fires/week) -- a live, current "no static thresholds" violation that
 *    every existing check passed cleanly, because they all check for the calibration row's
 *    EXISTENCE/self-consistency, not its CONSUMPTION. This check instead pulls each live
 *    (non-SUPPRESS/THIN_N) setup_type's most recent real (ACTIVE/SHADOW-origin) fired
 *    trades, computes the ACTUAL stop/target distance used (|stop_level - entry|,
 *    |t1_level - entry|), and WARNs if the current OPTIMAL_STOP stop/target never appears
 *    (within a small tolerance) among them -- the exact signature of a setup whose live code
 *    path bypasses calibration entirely. WARN, not FAIL: a real setup can legitimately run a
 *    scale-out/multi-leg exit where t1_level reflects only the first leg, which won't match
 *    a single-target OPTIMAL_STOP row for a benign reason -- this check surfaces the
 *    discrepancy for human review rather than assuming it's always a bug, matching this
 *    codebase's own "not everything unstable is a bug" convention elsewhere.
 *
 * 9. Live setup_types aren't silently falling back to raw percentiles (added 2026-08-03)
 *    Check 2 only verifies an OPTIMAL_STOP ROW exists for an ACTIVE type -- it doesn't verify
 *    that row's optimal_stop/optimal_target columns are actually populated (non-NULL). A row
 *    can exist with those columns NULL (the sweep never produced a value for it), and
 *    acd.js's own COALESCE(optimal_stop, p75_mae)/COALESCE(optimal_target, p50_mfe) will
 *    silently trade that live setup off the raw pre-sweep percentile instead -- an
 *    uncalibrated fallback value, with nothing surfacing that the substitution happened.
 *    Built from a Claude+DeepSeek critique/debate session (2026-08-03) investigating why a
 *    system-wide "stop:target ratio" figure computed against the raw p75_mae/p50_mfe columns
 *    looked drastically worse than the real EV-swept optimal_stop/optimal_target (median
 *    ratio ~1.67 vs ~0.72 across the same rows) -- see RESEARCH_CLAIM
 *    stop_target_ratio_9729_finding_was_measurement_artifact. This check WARNs on any live
 *    (non-SUPPRESS/THIN_N) setup_type with a NULL optimal_stop/optimal_target, and -- since an
 *    automated check can't stop a FUTURE ad-hoc analysis script from confusing the two column
 *    pairs the way the original 2026-07-29 finding likely did -- always prints the aggregate
 *    population's median stop:target ratio under BOTH methodologies side by side, so that
 *    divergence is visible every single run rather than requiring a from-scratch investigation
 *    to rediscover it.
 *
 * 13. Aggregate OPTIMAL_STOP distribution hasn't shifted materially, and no live stop sits
 *    inside real market noise (added 2026-08-04). The transferable lesson from the same
 *    incident as check 12: a data-CORRECTNESS fix (restricting computeCorrectedTarget()'s
 *    population to origin_status IN ('ACTIVE','SHADOW'), the right change on its own terms)
 *    silently rewrote live risk parameters on ~130 setups two days later, through two layers
 *    of indirection, with nothing connecting the data fix to the live stop values. Per-type
 *    circuit breakers (check 12) catch an individual type moving too far too fast; this check
 *    catches the SYSTEM-WIDE symptom even when no single day-over-day type change looks
 *    alarming on its own. Two parts: (a) any live (non-SUPPRESS/THIN_N) type whose current
 *    optimal_stop sits below 1.5x the market's own real median 1-min NQ bar range (computed
 *    fresh from price_bars_primary, not hardcoded -- this exact floor concept already exists
 *    in this codebase for trailing-stop candidate widths, just never applied to the base stop
 *    sweep itself) is flagged directly -- this alone would have caught GLOBEX_VWAP_FADE_LONG's
 *    8pt stop before it was found by hand; (b) the population's aggregate median optimal_stop
 *    is compared against its own value from ~7 days ago (same performance_audit history, no
 *    new table), WARNing on a large aggregate swing that no single per-type check would
 *    necessarily flag on its own.
 *
 * 12. OPTIMAL_STOP circuit breaker never sits in a TRIPPED (pct_change_exceeded) state
 *    unresolved (added 2026-08-04). update_optimal_stops.mjs's circuit breaker
 *    (applyCircuitBreaker()) rejects a freshly-computed stop/target that moved too far from
 *    its own prior value off too little new data, freezing at the prior value instead --
 *    built the same night GLOBEX_VWAP_FADE_LONG's live optimal_stop was found oscillating
 *    83pt<->8pt (inside normal 1-min NQ bar noise) across consecutive runs, both under the
 *    guarded AND unguarded calibration methods. `reason:'min_delta_n_not_met'` is normal,
 *    expected, everyday behavior (most types don't gain enough real N day to day to even
 *    attempt a recalibration) and does NOT fail here. `reason:'pct_change_exceeded'` means
 *    the breaker actually caught something -- the sweep tried to move a stop/target by more
 *    than 35% off a population that had grown enough to qualify, and got rejected. This FAILs
 *    loudly on any setup_type whose LATEST OPTIMAL_STOP row has `circuitBreaker.tripped ===
 *    true` -- a tripped breaker is exactly the kind of thing this file's own standing rule
 *    (a routine check's own output is not itself an investigation) says must never sit
 *    silently in a log nobody reads. See OPEN_DECISION
 *    optimal_stop_100pct_unguarded_fallback_needs_new_formula for the still-open root cause.
 *
 * 15. Fire-time regime tagging (roadmap Phase 1, I1) no-lookahead guard (added 2026-08-10)
 *    Three checks on active_setups.day_type_at_fire/vol_bucket_at_fire, populated at insert
 *    by server/routes/acd.js's computeFireTags(): (a) getVolBucketAtFire()'s source has a
 *    strict upper time bound (ts::date < $1) on its price_bars_primary query -- static, so
 *    it can't be fooled by a code path that hasn't fired yet; (b) a structural guarantee
 *    that no RTH-session row ever has a non-UNKNOWN day_type_at_fire, since
 *    acd_daily_log.day_type for that SAME trade_date is only ever written by
 *    derive_day_types.js at 20:20 ET, always after RTH close -- a violation is proof of a
 *    real lookahead leak; (c) determinism -- getVolBucketAtFire(tradeDate) excludes the
 *    whole trade_date from its own rolling window, so a fresh re-derivation via the REAL
 *    exported function must exactly reproduce what was stored at insert time.
 *
 * 16. Non-fire logging (roadmap Phase 1, I2) gated_candidates table health (added 2026-08-10)
 *    Confirms the table exists (FAILs if it's been dropped/reverted) and WARNs if any
 *    gate_name shows up that isn't in this check's own known list -- a new gate wired in
 *    without updating this list, or a typo that silently fragments what should be one
 *    gate_name into two. Prints the last-7-days per-gate row count every run so the
 *    aggregate volume is visible without a manual query.
 *
 * 17. bet_class coverage (roadmap Phase 1, I3) (added 2026-08-10)
 *    (a) Every real setup_type resolves to a real bet_class via getBetClass() (none
 *    UNCLASSIFIED); (b) the STORED active_setups.bet_class column matches a fresh
 *    re-derivation (WARN on drift -- expected if setupTypes.js's classification changed
 *    since a row was tagged, otherwise a wiring bug); (c) BET_CLASS_STATUS rows exist in
 *    performance_audit and are fresh (weekly cron via backtest_bet_class_status.mjs).
 */

import pg from 'pg';
import fs, { existsSync } from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { inferDirection, CONDITIONAL_VARIANTS, CONTEXTUAL_DIRECTION_TYPES, UNCALIBRATED_SHADOW_TYPES, getBetClass, BET_CLASSES, BET_CLASS_STAGE, ROSTER_CAP, assertRosterCapNotExceeded } from '../server/config/setupTypes.js';
import { sweepOptimalStopAndTarget, DEFAULT_DPP, computeStopTargetForType, computeVolatilityDefaultRatios } from './update_optimal_stops.mjs';
import { computeCorrectedTarget, makeBarIndex } from '../server/services/targetCalibrationService.js';
import { getVolBucketAtFire } from '../server/routes/acd.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { listClaims } from './record_claim.mjs';
import { CAPITAL_EXPOSURE_OVERRIDE } from '../server/services/setupEligibility.js';

config();
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

// This script has run daily since 2026-07-17 (run_daily_calibration.sh, 8:20pm ET Mon-Fri)
// but its own comment there said "non-zero exit is non-gating... read the output" -- nothing
// ever did. A new FAIL/WARN could sit silently in scratch/daily_calibration.log forever,
// the exact "checked but never surfaced" gap this whole script exists to prevent for OTHER
// parts of the system. Fixed 2026-08-02 (direct user request: "it should run daily" / "or
// live... i dunno" -- daily is the right cadence here, nothing this script checks changes
// faster than once/day since calibration itself only updates nightly) by self-alerting on
// every run, matching audit_setup_latency.mjs's established convention -- same file, same format.
const ALERTS_FILE = path.resolve('scratch/gemini_alerts.txt');
function nowET() {
  return new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).replace(',', '');
}

let failures = 0;
let warnings = 0;
const failMsgs = [];
const warnMsgs = [];

const fail  = (msg) => { console.log(`  FAIL  ${msg}`); failures++; failMsgs.push(msg); };
const warn  = (msg) => { console.log(`  WARN  ${msg}`); warnings++; warnMsgs.push(msg); };
const ok    = (msg) => { console.log(`  ok    ${msg}`); };

async function main() {
  const client = await pool.connect();
  try {

    // ── 1. CONDITIONAL_VARIANTS coverage ────────────────────────────────────────
    console.log('\n[1] Conditional variant calibration coverage');

    // Latest SETUP_STATUS row per signal_name
    const ssRows = await client.query(`
      SELECT DISTINCT ON (signal_name) signal_name, recommendation
      FROM performance_audit
      WHERE signal_type = 'SETUP_STATUS'
      ORDER BY signal_name, run_date DESC
    `);
    const setupStatus = Object.fromEntries(ssRows.rows.map(r => [r.signal_name, r.recommendation]));

    // Latest OPTIMAL_STOP row per signal_name
    const osRows = await client.query(`
      SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target
      FROM performance_audit
      WHERE signal_type = 'OPTIMAL_STOP'
      ORDER BY signal_name, run_date DESC
    `);
    const optStops = Object.fromEntries(osRows.rows.map(r => [r.signal_name, r]));

    // Trail-mechanism variants (docs/SCALEOUT_RUNNER_SPEC.md — `trailSignalName` set)
    // don't follow the fixed-stop/fixed-target SETUP_STATUS+OPTIMAL_STOP convention: the
    // exit itself is dynamic, calibrated instead via signal_type='BREAKEVEN_TRAIL_TEST'
    // (trail width, not a stop/target pair). They also genuinely have zero SETUP_STATUS
    // history until real live-resolved trades accumulate — server/routes/acd.js forces
    // status='SHADOW' at insert time unconditionally for these regardless of
    // SETUP_STATUS (verified directly in the INSERT block, not assumed), so an absent
    // SETUP_STATUS row is an expected bootstrap state, not a miscalibration.
    const trailRows = await client.query(`
      SELECT DISTINCT ON (signal_name) signal_name, notes FROM performance_audit
      WHERE signal_type = 'BREAKEVEN_TRAIL_TEST' ORDER BY signal_name, run_date DESC
    `);
    const trailCalib = Object.fromEntries(trailRows.rows.map(r => [r.signal_name, r]));

    for (const [variantType, meta] of Object.entries(CONDITIONAL_VARIANTS)) {
      if (meta.trailSignalName) {
        const tc = trailCalib[meta.trailSignalName];
        if (!tc) {
          // Downgraded from FAIL to WARN 2026-08-20 (resolves OPEN_DECISION
          // pd_poc_fade_long_trail_lost_breakeven_trail_baseline): a missing row here is
          // OBSERVATIONALLY IDENTICAL whether the backtest was never run, or was run and
          // the setup_type legitimately failed testTrailForPopulation()'s own guardrail
          // funnel (noPullbackData/thinTail/noPlateauPass/failedOosOrBaseline/notRigorClean
          // -- scripts/lib/breakevenTrailCore.mjs) -- the script only ever INSERTs a row
          // for actual survivors. Directly confirmed 2026-08-20 for PD_POC_FADE_LONG_TRAIL
          // specifically (Tier A: noPullbackData, Tier B: failedOosOrBaseline -- both
          // legitimate methodology failures, re-run by hand against current data), and
          // breakeven_trail_zero_real_survivors_20260816 already found this is currently
          // the state for ALL 6 wired trail variants fleet-wide, not a per-type anomaly --
          // hard-FAILing on an already-known, expected, currently-universal state every
          // single run is noise, not signal. WARN keeps this visible without false urgency;
          // still worth a look if it EVER becomes just 1-2 of 6 rather than all of them.
          warn(`${variantType}: no BREAKEVEN_TRAIL_TEST row '${meta.trailSignalName}' -- expected under the current guardrail funnel (see breakeven_trail_zero_real_survivors_20260816), not necessarily a stale/broken script. Re-run ${meta.backtestScript} if you want to confirm this run's specific funnel-exit reason.`);
        } else {
          const notes = typeof tc.notes === 'string' ? JSON.parse(tc.notes) : tc.notes;
          ok(`${variantType}: BREAKEVEN_TRAIL_TEST trail=${notes?.trail}pt (backtest OOS EV $${notes?.oosEv?.toFixed(2)})`);
        }
        if (!setupStatus[variantType]) {
          ok(`${variantType}: no SETUP_STATUS row yet — expected pre-live-data bootstrap state (forced SHADOW at insert regardless)`);
        } else {
          ok(`${variantType}: SETUP_STATUS = ${setupStatus[variantType]} (live data accumulating)`);
        }
      } else {
        // a) SETUP_STATUS exists
        if (!setupStatus[variantType]) {
          fail(`${variantType}: no SETUP_STATUS row in performance_audit — run ${meta.backtestScript}`);
        } else {
          ok(`${variantType}: SETUP_STATUS = ${setupStatus[variantType]}`);
        }

        // b) OPTIMAL_STOP exists
        if (!optStops[variantType]) {
          fail(`${variantType}: no OPTIMAL_STOP row in performance_audit — run ${meta.backtestScript}`);
        } else {
          const os = optStops[variantType];
          ok(`${variantType}: OPTIMAL_STOP stop=${os.optimal_stop}pt target=${os.optimal_target}pt`);
        }
      }

      // c) inferDirection matches declared direction
      const inferred = inferDirection(variantType);
      if (inferred !== meta.direction) {
        fail(`${variantType}: inferDirection() returned '${inferred}', expected '${meta.direction}' — update inferDirection() or the registry`);
      } else {
        ok(`${variantType}: inferDirection() = ${inferred} ✓`);
      }

      // d) backtest script exists on disk
      if (!existsSync(meta.backtestScript)) {
        fail(`${variantType}: backtest script not found: ${meta.backtestScript}`);
      } else {
        ok(`${variantType}: backtest script exists`);
      }

      // e) baseType is suppressed (not accidentally ACTIVE)
      const baseRec = setupStatus[meta.baseType];
      if (baseRec === 'ACTIVE') {
        warn(`${variantType}: baseType '${meta.baseType}' is ACTIVE in SETUP_STATUS — both base and variant would fire simultaneously. Suppress the base or remove the variant.`);
      } else if (!baseRec) {
        warn(`${variantType}: baseType '${meta.baseType}' has no SETUP_STATUS row — suppression state unknown`);
      } else {
        ok(`${variantType}: baseType '${meta.baseType}' recommendation = ${baseRec} (not active) ✓`);
      }
    }

    // ── 2. ACTIVE types have OPTIMAL_STOP data ──────────────────────────────────
    console.log('\n[2] ACTIVE setup types have OPTIMAL_STOP data');

    const activeTypes = ssRows.rows
      .filter(r => r.recommendation === 'ACTIVE')
      .map(r => r.signal_name);

    for (const type of activeTypes) {
      if (!optStops[type]) {
        fail(`${type}: ACTIVE in SETUP_STATUS but no OPTIMAL_STOP row — acd.js falls back to constants`);
      }
    }
    if (activeTypes.every(t => optStops[t])) {
      ok(`all ${activeTypes.length} ACTIVE types have OPTIMAL_STOP data`);
    }

    // ── 3. Direction inference on recently-fired types ───────────────────────────
    console.log('\n[3] inferDirection() handles all setup types fired in last 30 days');

    const recentTypes = await client.query(`
      SELECT DISTINCT setup_type FROM active_setups
      WHERE fired_at >= NOW() - INTERVAL '30 days'
      ORDER BY setup_type
    `);

    const unknownDir = [];
    for (const { setup_type } of recentTypes.rows) {
      const dir = inferDirection(setup_type);
      if (dir === null && !CONTEXTUAL_DIRECTION_TYPES.has(setup_type)) unknownDir.push(setup_type);
    }

    if (unknownDir.length === 0) {
      ok(`all ${recentTypes.rows.length} recently-fired types have known direction (contextual types excluded)`);
    } else {
      for (const t of unknownDir) {
        warn(`${t}: inferDirection() = null — add to CONTEXTUAL_DIRECTION_TYPES if direction is row-level, or fix the type name suffix`);
      }
    }

    // ── 4. No orphaned OPTIMAL_STOP rows ────────────────────────────────────────
    console.log('\n[4] No OPTIMAL_STOP rows missing a SETUP_STATUS counterpart');

    const allOptTypes = new Set(osRows.rows.map(r => r.signal_name));
    const allSsTypes  = new Set(ssRows.rows.map(r => r.signal_name));
    // Day-type-conditioned OPTIMAL_STOP sub-keys (2026-08-03, scripts/backtest_ib_daytype_stop_target.mjs)
    // are deliberately NOT real setup_types -- they're a `{setup_type}_{day_type}` calibration
    // refinement (matching backtest_day_type_alpha.js's own naming convention), read by acd.js's
    // ibOpt lookup as a day-type-first override before falling back to the blended row. SETUP_STATUS
    // (SUPPRESS/ACTIVE/THIN_N) is scoped to real setup_types only -- these sub-keys legitimately have
    // no counterpart there, as long as the BASE setup_type itself does.
    const DAY_TYPES = ['BALANCE', 'TREND', 'TURBULENT'];
    const orphaned = [...allOptTypes].filter(t => {
      if (allSsTypes.has(t)) return false;
      const dayTypeSuffix = DAY_TYPES.find(dt => t.endsWith(`_${dt}`));
      if (dayTypeSuffix && allSsTypes.has(t.slice(0, -(dayTypeSuffix.length + 1)))) return false;
      return true;
    });

    if (orphaned.length === 0) {
      ok(`all ${allOptTypes.size} OPTIMAL_STOP types have a SETUP_STATUS row (or are a day-type sub-key of one)`);
    } else {
      for (const t of orphaned) {
        warn(`${t}: has OPTIMAL_STOP but no SETUP_STATUS — stale calibration data`);
      }
    }

    // ── 5. ev_per_trade actually matches a fresh re-simulation of its own stop/target ──
    console.log('\n[5] OPTIMAL_STOP.ev_per_trade matches its own optimal_stop/optimal_target');

    const latestOptRows = await client.query(`
      SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target, ev_per_trade, notes
      FROM performance_audit
      WHERE signal_type = 'OPTIMAL_STOP'
      ORDER BY signal_name, run_date DESC
    `);

    // Same trade/percentile/dpp filters as update_optimal_stops.mjs's own statsRes/rawRes/
    // dppRes queries -- if those ever change, this must change with them, or this check
    // starts comparing apples to oranges the same way the original bug did. This check
    // doesn't just spot-check a formula at one point (that had a real blind spot: a bug
    // that ALWAYS writes the raw average would trivially "match" a loose fallback check
    // every time) -- it fully re-derives what optimal_stop/optimal_target/ev_per_trade
    // SHOULD be via the real sweepOptimalStopAndTarget(), and requires an exact match (or
    // the documented thin-tail-gate fallback, verified as actually null, not assumed).
    const statsRes5 = await client.query(`
      SELECT setup_type,
        ROUND(AVG(actual_pnl)::numeric, 0) AS raw_avg,
        ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY mae_points)::numeric, 1) AS p25_mae,
        ROUND(PERCENTILE_CONT(0.40) WITHIN GROUP (ORDER BY mae_points)::numeric, 1) AS p40_mae,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mae_points)::numeric, 1) AS p50_mae,
        ROUND(PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY mae_points)::numeric, 1) AS p60_mae,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mae_points)::numeric, 1) AS p75_mae,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mfe_points)::numeric, 1) AS p75_mfe
      FROM active_setups
      WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
        AND mae_points <= 300 AND mfe_points <= 300
        AND status = 'RESOLVED' AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
      GROUP BY setup_type
      HAVING COUNT(*) >= 20
    `);
    const statsByType = Object.fromEntries(statsRes5.rows.map(r => [r.setup_type, r]));

    const tradesRes = await client.query(`
      SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float,
        fired_at, entry_zone_low::float, entry_zone_high::float
      FROM active_setups
      WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
        AND mae_points <= 300 AND mfe_points <= 300
        AND status = 'RESOLVED'
        AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
    `);
    const tradesByType = {};
    for (const t of tradesRes.rows) {
      (tradesByType[t.setup_type] ||= []).push(t);
    }

    // Day-type-conditioned OPTIMAL_STOP sub-keys (2026-08-03, scripts/backtest_ib_daytype_stop_target.mjs)
    // need their own population, keyed `{setup_type}_{day_type}`, joined the same way that
    // script does -- otherwise check [5] silently skips them (tradesByType['IB_BEARISH_TURBULENT']
    // is undefined since no active_setups row has that literal setup_type), and a future drift
    // in that script's own ev_per_trade write path would go undetected, the exact bug class
    // this check exists to catch (see the optStopQ p75_mae incident, 2026-08-03).
    const dtStatsRes = await client.query(`
      SELECT a.setup_type || '_' || d.day_type as signal_name,
        ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY a.mae_points)::numeric, 1) AS p25_mae,
        ROUND(PERCENTILE_CONT(0.40) WITHIN GROUP (ORDER BY a.mae_points)::numeric, 1) AS p40_mae,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY a.mae_points)::numeric, 1) AS p50_mae,
        ROUND(PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY a.mae_points)::numeric, 1) AS p60_mae,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY a.mae_points)::numeric, 1) AS p75_mae,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY a.mfe_points)::numeric, 1) AS p75_mfe
      FROM active_setups a
      JOIN acd_daily_log d ON d.trade_date = a.trade_date
      WHERE a.mae_points IS NOT NULL AND a.mfe_points IS NOT NULL AND a.actual_pnl IS NOT NULL
        AND a.mae_points <= 300 AND a.mfe_points <= 300
        AND a.status = 'RESOLVED' AND a.replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
        AND d.day_type IS NOT NULL
      GROUP BY a.setup_type, d.day_type
      HAVING COUNT(*) >= 20
    `);
    for (const r of dtStatsRes.rows) statsByType[r.signal_name] = r;

    const dtTradesRes = await client.query(`
      SELECT a.setup_type || '_' || d.day_type as cell_key,
        a.mae_points::float, a.mfe_points::float, a.actual_pnl::float,
        a.fired_at, a.entry_zone_low::float, a.entry_zone_high::float
      FROM active_setups a
      JOIN acd_daily_log d ON d.trade_date = a.trade_date
      WHERE a.mae_points IS NOT NULL AND a.mfe_points IS NOT NULL AND a.actual_pnl IS NOT NULL
        AND a.mae_points <= 300 AND a.mfe_points <= 300
        AND a.status = 'RESOLVED' AND a.replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
        AND d.day_type IS NOT NULL
    `);
    for (const t of dtTradesRes.rows) (tradesByType[t.cell_key] ||= []).push(t);

    // Bars + expanded (TIME_EXPIRED-inclusive) trade population for corrected-resim
    // re-derivation -- matches update_optimal_stops.mjs's own rawByTypeExpanded exactly
    // (TIME_EXPIRED trades ARE included here, unlike the replay_resolution-filtered
    // tradesByType above used for the old EV-sweep check -- a TIME_EXPIRED trade can be
    // correctly re-evaluated by computeCorrectedTarget's own bar walk). Only loaded if at
    // least one row actually needs it, since this check runs frequently and most rows won't.
    const needsBars = latestOptRows.rows.some(r => { try { return JSON.parse(r.notes)?.method === 'corrected-resim'; } catch { return false; } });
    let allBars = [];
    let tradesByTypeExpanded = {};
    if (needsBars) {
      const barsRes5 = await client.query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
      allBars = barsRes5.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
      const expandedRes = await client.query(`
        SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float,
          fired_at, entry_zone_low::float, entry_zone_high::float
        FROM active_setups
        WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
          AND mae_points <= 300 AND mfe_points <= 300
          AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
          AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
        ORDER BY fired_at ASC
      `);
      for (const t of expandedRes.rows) (tradesByTypeExpanded[t.setup_type] ||= []).push(t);
    }

    const dppRes = await client.query(`
      SELECT setup_type,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(entry_zone_low - stop_level), 0))
          FILTER (WHERE replay_resolution = 'STOP_HIT')   AS stop_dpp,
        COUNT(*) FILTER (WHERE replay_resolution = 'STOP_HIT')   AS n_stop,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(t1_level - entry_zone_low), 0))
          FILTER (WHERE replay_resolution = 'TARGET_HIT') AS target_dpp,
        COUNT(*) FILTER (WHERE replay_resolution = 'TARGET_HIT') AS n_target
      FROM active_setups
      WHERE status = 'RESOLVED' AND entry_zone_low IS NOT NULL
        AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
      GROUP BY setup_type
    `);
    const dppByType = {};
    for (const r of dppRes.rows) {
      dppByType[r.setup_type] = {
        stopDpp:   (+r.n_stop >= 20 && r.stop_dpp != null) ? +r.stop_dpp : DEFAULT_DPP,
        targetDpp: (+r.n_target >= 20 && r.target_dpp != null) ? +r.target_dpp : DEFAULT_DPP,
      };
    }

    const closeEnough = (a, b, tolAbs = 3, tolRel = 0.1) => {
      const absDiff = Math.abs(a - b);
      return absDiff <= tolAbs || absDiff <= tolRel * Math.max(Math.abs(a), Math.abs(b));
    };

    // Real (origin_status-filtered) population, mirroring update_optimal_stops.mjs's
    // rawResReal exactly (2026-08-09) -- replaces the blended tradesByType/statsByType this
    // check used to re-derive against above, which stopped meaning anything the moment that
    // script's own methodology switched to real-only data + a chronological sweep +
    // volatility-scaled default the same day. This check's own header comment already
    // demanded this ("if those ever change, this must change with them") -- confirmed live:
    // without this fix, 128 of 123 rows FAILed the moment the re-baseline landed, all
    // comparing against the now-obsolete blended methodology, not a real drift.
    const realTradesRes5 = await client.query(`
      SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float,
        fired_at, entry_zone_low::float, entry_zone_high::float
      FROM active_setups
      WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
        AND mae_points <= 300 AND mfe_points <= 300
        AND status = 'RESOLVED'
        AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
        AND origin_status IN ('ACTIVE', 'SHADOW')
      ORDER BY fired_at ASC
    `);
    const realTradesByType = {};
    for (const t of realTradesRes5.rows) (realTradesByType[t.setup_type] ||= []).push(t);

    // Real, day-type-joined population -- mirrors backtest_ib_daytype_stop_target.mjs's own
    // tradesRes query exactly (2026-08-10 fix, resolves day_type_alpha_stop_needs_origin_status_filter).
    // Merged into the SAME realTradesByType map under cell_key ('IB_BEARISH_TURBULENT' etc.) so the
    // main loop below can verify day-type sub-key rows via computeStopTargetForType() too, instead
    // of unconditionally skipping them (the pre-fix state, when that script used blended data and
    // there was no shared methodology to re-derive against).
    const realDtTradesRes = await client.query(`
      SELECT a.setup_type || '_' || d.day_type as cell_key,
        a.mae_points::float, a.mfe_points::float, a.actual_pnl::float,
        a.fired_at, a.entry_zone_low::float, a.entry_zone_high::float
      FROM active_setups a
      JOIN acd_daily_log d ON d.trade_date = a.trade_date
      WHERE a.mae_points IS NOT NULL AND a.mfe_points IS NOT NULL AND a.actual_pnl IS NOT NULL
        AND a.mae_points <= 300 AND a.mfe_points <= 300
        AND a.status = 'RESOLVED' AND a.replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
        AND a.origin_status IN ('ACTIVE', 'SHADOW')
        AND d.day_type IS NOT NULL
      ORDER BY a.fired_at ASC
    `);
    for (const t of realDtTradesRes.rows) (realTradesByType[t.cell_key] ||= []).push(t);

    const medianBarRangeRes5 = await client.query(`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (high - low)) as median_range
      FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW() - INTERVAL '30 days'
    `);
    const medianBarRange5 = +medianBarRangeRes5.rows[0].median_range;
    const NOISE_FLOOR_PT5 = 1.5 * medianBarRange5;

    // Reuse allBars if the corrected-resim block above already loaded it; otherwise load now
    // -- computeStopTargetForType's chronological-sweep path needs it regardless of whether
    // any row uses corrected-resim.
    if (!needsBars) {
      const barsRes5b = await client.query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
      allBars = barsRes5b.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
    }
    const firstIndexAfter5 = makeBarIndex(allBars);

    // volScaleRatio/targetStopRatio: same "median of currently-qualifying types' own ratio"
    // formula as update_optimal_stops.mjs, using the CURRENT stored rows as "prior" --
    // matches what a production run right now would compute. Self-referential BY DESIGN
    // (see that file's own comment on this) -- which is exactly why volatility-scaled-
    // default rows get a STRUCTURAL check below, not an exact-match one: the ratio is a
    // moving target across time as the qualifying population evolves, so two computations
    // minutes apart can legitimately produce different (both correct) values. Confirmed
    // live during the 2026-08-09 re-baseline: re-deriving this ratio right after a real run
    // shifted it 2.61x -> 3.02x purely from the prior stored values changing, zero code bug.
    // Extracted into computeVolatilityDefaultRatios() 2026-08-10 (this was a hand-copy of
    // update_optimal_stops.mjs's own logic -- the 3rd copy in 6 days, caught before a 4th).
    const priorStoredByType5 = {};
    const realNByType5 = {};
    for (const row of latestOptRows.rows) {
      priorStoredByType5[row.signal_name] = { stop: parseFloat(row.optimal_stop), target: parseFloat(row.optimal_target) };
      realNByType5[row.signal_name] = (realTradesByType[row.signal_name] || []).length;
    }
    const { volScaleRatio: volScaleRatio5, targetStopRatio: targetStopRatio5, ceilingRatio: ceilingRatio5, canComputeVolDefault: canComputeVolDefault5 } =
      computeVolatilityDefaultRatios({ priorStoredByType: priorStoredByType5, realNByType: realNByType5, medianBarRange: medianBarRange5 });

    let evChecked = 0, evMismatches = 0;
    for (const row of latestOptRows.rows) {
      // Day-type-suffixed rows (e.g. 'IB_BEARISH_TURBULENT') have no dppByType entry of
      // their own -- $/pt is an instrument/setup_type property, not day-type-dependent,
      // and backtest_ib_daytype_stop_target.mjs deliberately reuses the BASE setup_type's
      // dpp (not DEFAULT_DPP) for exactly this reason. Strip the day-type suffix before
      // looking up, or this would re-derive against the wrong $/pt and false-FAIL every
      // day-type row.
      const _dtSuffix = ['BALANCE', 'TREND', 'TURBULENT'].find(dt => row.signal_name.endsWith(`_${dt}`));
      const _dppKey = _dtSuffix ? row.signal_name.slice(0, -(_dtSuffix.length + 1)) : row.signal_name;
      const { stopDpp, targetDpp } = dppByType[_dppKey] || { stopDpp: DEFAULT_DPP, targetDpp: DEFAULT_DPP };
      const stored = { stop: parseFloat(row.optimal_stop), target: parseFloat(row.optimal_target), ev: parseFloat(row.ev_per_trade) };

      let usedNotes = null;
      try { usedNotes = JSON.parse(row.notes); } catch { /* not JSON / no notes -- normal case */ }

      // Circuit breaker (2026-08-04, applyCircuitBreaker() in update_optimal_stops.mjs) can
      // deliberately hold the stored row at a PRIOR value instead of whatever a fresh
      // computation gives right now -- that's the mechanism working as designed (see check
      // [12]/[13] and CLAUDE.md's circuit-breaker entry), not the drift bug this check
      // exists to catch. WARN instead of silently skipping (still visible, not swallowed).
      if (usedNotes?.circuitBreaker && usedNotes.circuitBreaker.reason === 'min_delta_n_not_met') {
        continue; // routine, expected on most types most days -- not worth a WARN every run
      }
      if (usedNotes?.circuitBreaker && (usedNotes.circuitBreaker.reason === 'pct_change_exceeded' || usedNotes.circuitBreaker.reason?.startsWith('manual_revert'))) {
        const cb = usedNotes.circuitBreaker;
        warn(`${row.signal_name}: stored stop=${stored.stop}/target=${stored.target}/ev=$${stored.ev.toFixed(2)} differs from a fresh computation -- EXPECTED, held by the circuit breaker (reason=${cb.reason}${cb.reason === 'pct_change_exceeded' ? `, attempted stop=${cb.attemptedStop}/target=${cb.attemptedTarget}` : ''}), not an unresolved drift bug.`);
        continue;
      }
      if (usedNotes?.circuitBreaker?.reason === 'bypassed_for_rebaseline_20260809') {
        // The one-time re-baseline itself -- accepted whatever was freshly computed at that
        // moment unconditionally, by design (see docs/DECISIONS_LOG.md). Not comparable to
        // "a fresh computation right now" in the same way normal rows are, for the same
        // self-referential-ratio reason volatility-scaled-default rows get a structural
        // check below rather than an exact one. Skip silently -- this is a known, one-time,
        // already-reviewed state, not something to keep re-flagging every run.
        continue;
      }

      // Rows produced by a DIFFERENT script than update_optimal_stops.mjs's main per-type
      // loop -- day-type sub-keys (backtest_ib_daytype_stop_target.mjs, e.g.
      // IB_BEARISH_TURBULENT) and conditional-variant/dedicated-script rows (e.g.
      // WPP_FADE_SHORT_GAP_UP via backtest_wpp_short_gap.mjs, MONTHLY_VWAP_FADE_LONG/SHORT,
      // MOMENTUM_60m_60m_BALANCE_FADE -- the last documented in CLAUDE.md as an orphaned
      // calibration row with zero active_setups history under that literal name at all).
      // None of these have a literal active_setups.setup_type match, so both
      // tradesByType[name] (the old BLENDED population, still computed above for exactly
      // this purpose) and realTradesByType[name] are empty for them -- generalized signal
      // "this signal_name isn't part of the main population update_optimal_stops.mjs
      // iterates over at all," not day-type-suffix-specific. Comparing these against
      // computeStopTargetForType would silently fall to the SAME generic volatility-scaled-
      // default for every one of them regardless of their real content -- the wrong
      // standard, not a real drift. Skip rather than mis-verify; each has its own dedicated
      // script that would need its own origin_status audit, out of today's scope.
      // Also requires tradesByType[name].length >= 20 (not just "some entry exists"),
      // matching update_optimal_stops.mjs's own `HAVING COUNT(*) >= MIN_N` gate on the
      // BLENDED population that decides whether a signal_name is in its `rows` iteration
      // list AT ALL. Found live: MONTHLY_VWAP_FADE_LONG/SHORT have some blended trades (so
      // tradesByType has an entry) but fewer than 20 -- statsRes's own HAVING clause has
      // therefore never once included them, so NEITHER the old NOR the new
      // update_optimal_stops.mjs has ever touched their stored row (both show run_date
      // 2026-07-19, notes=null, untouched even by today's re-baseline) -- a stale, orphaned
      // row this check can't meaningfully re-verify against either methodology.
      //
      // Day-type sub-keys are a DIFFERENT case as of 2026-08-10: backtest_ib_daytype_stop_target.mjs
      // now shares the exact same computeStopTargetForType() methodology (canComputeVolDefault
      // forced false), so a day-type row with real touches CAN be meaningfully re-verified --
      // gate it on realTradesByType (the real, origin_status+day_type-joined population) instead
      // of the blended tradesByType/MIN_N gate the non-day-type branch below still needs. A
      // day-type row with zero real touches (still possible -- e.g. IB_BULLISH_TURBULENT, real
      // N=1) has nothing to re-derive against and is correctly left as a stale/orphaned row from
      // before this fix, same treatment as the MONTHLY_VWAP case above.
      if (_dtSuffix) {
        if (!realTradesByType[row.signal_name] || realTradesByType[row.signal_name].length === 0) continue;
      } else if (!tradesByType[row.signal_name] || tradesByType[row.signal_name].length < 20) {
        continue;
      }

      const direction = inferDirection(row.signal_name);
      const realTradesStop = realTradesByType[row.signal_name] || [];
      evChecked++;

      if (usedNotes?.method === 'volatility-scaled-default') {
        // Self-referential ratio (see comment above qualifyingRatios5) -- verify the row is
        // INTERNALLY CONSISTENT with the volatility-default formula and this check's own
        // structural expectations, not that it exactly reproduces a ratio that's legitimately
        // expected to have moved since the row was written.
        const okFloor = stored.stop >= NOISE_FLOOR_PT5 - 0.5; // small float-rounding slack
        const okEvNull = row.ev_per_trade == null || isNaN(stored.ev);
        const okRatio = stored.target > 0 && stored.stop > 0;
        if (!okFloor || !okEvNull || !okRatio) {
          fail(`${row.signal_name}: method=volatility-scaled-default but fails a structural check -- stop=${stored.stop} (floor=${NOISE_FLOOR_PT5.toFixed(1)}, okFloor=${okFloor}), ev_per_trade should be null (got ${row.ev_per_trade}, okEvNull=${okEvNull}), target=${stored.target} (okRatio=${okRatio})`);
          evMismatches++;
        }
        continue;
      }

      const decision5 = computeStopTargetForType({
        realTradesStop, direction, allBars, firstIndexAfter: firstIndexAfter5, stopDpp, targetDpp,
        noiseFloorPt: NOISE_FLOOR_PT5, volScaleRatio: volScaleRatio5, targetStopRatio: targetStopRatio5,
        ceilingRatio: ceilingRatio5, medianBarRange: medianBarRange5,
        // Day-type sub-keys always force canComputeVolDefault=false here, matching
        // backtest_ib_daytype_stop_target.mjs's own call exactly (it deliberately never gives a
        // thin day-type bucket a synthetic default -- see that script's header comment) --
        // using the main population's canComputeVolDefault5 instead would wrongly vol-default
        // a thin-but-nonzero-real-N day-type row (e.g. IB_BEARISH_BALANCE real N=11) that the
        // real script actually skipped, producing a false mismatch against its stale stored row.
        canComputeVolDefault: _dtSuffix ? false : canComputeVolDefault5,
      });
      if (decision5.targetMethod === 'insufficient_data_no_fallback') {
        // Only reachable on a genuinely first-ever run (no type anywhere clears the real-N
        // floor yet) -- can't meaningfully re-verify without replicating the old blended
        // fallback this codebase is deliberately moving away from. Skip, not fail.
        continue;
      }

      // 2026-07-19: if the stored row was produced via the corrected-resim path, re-derive
      // it via computeCorrectedTarget() instead of trusting the sweep result alone --
      // matches update_optimal_stops.mjs's own two-step process exactly (real sweep first
      // to get the (stop, anchor-target) pair, THEN the corrected-resim override on top).
      if (usedNotes?.method === 'corrected-resim') {
        const expandedTrades = tradesByTypeExpanded[row.signal_name] || [];
        const corrected = direction ? computeCorrectedTarget({
          trades: expandedTrades, allBars, stop: decision5.optStop, oldTarget: decision5.optTarget,
          long: direction === 'LONG', pnlPerPoint: DEFAULT_DPP, commission: LIVE_INSTRUMENT.commissionPerRoundTrip,
        }) : { exclusionReason: 'no_direction' };
        if (corrected.exclusionReason) {
          fail(`${row.signal_name}: stored notes claim method='corrected-resim' but a fresh re-derivation now excludes it (${corrected.exclusionReason}) -- either the row is stale (re-run update_optimal_stops.mjs) or the override logic has drifted`);
          evMismatches++;
        } else {
          const evOk = closeEnough(stored.ev, corrected.fullEv);
          const targetOk = stored.target === corrected.bestTarget;
          const stopOk = stored.stop === decision5.optStop;
          if (!evOk || !targetOk || !stopOk) {
            fail(`${row.signal_name}: stored (corrected-resim) stop=${stored.stop}/target=${stored.target}/ev=$${stored.ev.toFixed(2)} but a fresh re-derivation gives stop=${decision5.optStop}/target=${corrected.bestTarget}/ev=$${corrected.fullEv.toFixed(2)}`);
            evMismatches++;
          }
        }
        continue;
      }

      // Real sweep (chronological-sweep-real / EV-sweep-real / p75mae-real-fallback) --
      // stored row must match the SAME function's fresh output exactly.
      const evOk = decision5.optEV != null && closeEnough(stored.ev, decision5.optEV);
      const targetOk = stored.target === decision5.optTarget;
      const stopOk = stored.stop === decision5.optStop;
      if (!evOk || !targetOk || !stopOk) {
        fail(`${row.signal_name}: stored stop=${stored.stop}/target=${stored.target}/ev=$${stored.ev.toFixed(2)} but a fresh computeStopTargetForType() gives stop=${decision5.optStop}/target=${decision5.optTarget}/ev=$${decision5.optEV != null ? decision5.optEV.toFixed(2) : 'n/a'} (method=${decision5.targetMethod}) — ev_per_trade (or the sweep itself) may have drifted from production`);
        evMismatches++;
      }
    }
    if (evChecked > 0 && evMismatches === 0) {
      ok(`all ${evChecked} OPTIMAL_STOP rows' ev_per_trade match a fresh re-simulation of their own stop/target`);
    } else if (evChecked === 0) {
      // Distinguish "nothing to check" (rare, a real gap worth a WARN) from "everything is
      // currently in a known-skip state" (2026-08-09: the day this branch was first hit for
      // real -- every row had just been written by the one-time re-baseline bypass, so ALL
      // 123 were correctly skipped by the bypassed_for_rebaseline_20260809 check above, not
      // because trade data was missing). The second case is expected and temporary --
      // check [5] resumes real verification the moment a normal (non-bypassed) run holds or
      // accepts a row through the regular circuit-breaker path instead.
      warn('no OPTIMAL_STOP rows were checked this run -- either genuinely no matching trade data, or (more likely right after a one-time re-baseline) every row is still tagged with a skip-worthy circuitBreaker reason (bypassed_for_rebaseline_20260809, min_delta_n_not_met, etc.) from the last write. Not itself evidence of a problem -- re-run after the next normal (non-bypassed) update_optimal_stops.mjs invocation to get real coverage again.');
    }

    // ── 6. UNCALIBRATED_SHADOW_TYPES hasn't quietly picked up a real SETUP_STATUS row ──
    console.log('\n[6] UNCALIBRATED_SHADOW_TYPES still genuinely uncalibrated');
    // This list (server/config/setupTypes.js) exists only for setup_types with NO
    // SETUP_STATUS row at all -- once a type is calibrated, getShadowSetupTypes()'s live
    // query already handles it correctly (SUPPRESS/THIN_N hidden, PROMOTE/ACTIVE shown).
    // An entry left here after calibration is dead weight at best; at worst it permanently
    // hides a type that later earns PROMOTE, since nothing else ever removes an entry from
    // a hardcoded Set. Found 2026-07-17: 22 of 27 entries already had real rows (all
    // correctly SUPPRESS/THIN_N that day, so no visible bug then) -- pruned to 5. This
    // check exists so the pruned version can't silently regress the same way.
    {
      const { rows: statusRows } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name, recommendation
        FROM performance_audit WHERE signal_type='SETUP_STATUS'
        ORDER BY signal_name, run_date DESC
      `);
      const calibrated = new Map(statusRows.map(r => [r.signal_name, r.recommendation]));
      const stale = [...UNCALIBRATED_SHADOW_TYPES].filter(t => calibrated.has(t));
      if (stale.length === 0) {
        ok(`all ${UNCALIBRATED_SHADOW_TYPES.size} UNCALIBRATED_SHADOW_TYPES entries genuinely have no SETUP_STATUS row`);
      } else {
        for (const t of stale) {
          fail(`UNCALIBRATED_SHADOW_TYPES has '${t}' but it now has a real SETUP_STATUS row (recommendation=${calibrated.get(t)}) — remove it from server/config/setupTypes.js's UNCALIBRATED_SHADOW_TYPES; the live getShadowSetupTypes() query already covers it correctly`);
        }
      }
    }

    // 7. No dead-end active_setups rows
    //    Added 2026-07-27 after finding 3 separate INSERT paths (the suppressed-near-level
    //    audit, CASCADE_BREAKER logging, minuteBarSignalDetector.js's momentum poller) that
    //    silently produced rows with no way to ever reach a real resolved outcome -- caught
    //    only because the user asked a pointed question about a specific week's numbers, not
    //    by anything automated. This check is the actual fix: a standing, generic tripwire
    //    for this whole bug class, not just a one-time audit of the 3 paths found so far.
    //    Any FUTURE insert path that forgets entry/stop/target/expires_at trips part (a);
    //    any resolution path that forgets to compute actual_pnl trips part (b) -- neither
    //    depends on knowing which specific code path caused it.
    console.log('\n[7] No dead-end active_setups rows (structural + resolved-but-no-outcome)');
    {
      // (a) Real (ACTIVE/SHADOW-origin) rows from the last 30 days missing entry/stop/target
      // entirely -- structurally can never be walked by resolveSetupsByPrice(), guaranteed to
      // eventually dead-end via the NO_EXPIRY_SET backstop with no actual_pnl. This is the
      // exact shape of all 3 bugs just fixed -- a FAIL here means a new instance exists.
      const { rows: structural } = await client.query(`
        SELECT setup_type, suppression_reason, COUNT(*) as n
        FROM active_setups
        WHERE origin_status IN ('ACTIVE','SHADOW') AND trade_date >= CURRENT_DATE - 30
          AND entry_zone_low IS NULL AND stop_level IS NULL AND t1_level IS NULL
        GROUP BY 1, 2 ORDER BY 3 DESC
      `);
      if (structural.length === 0) {
        ok('no real rows in the last 30 days are missing entry/stop/target entirely');
      } else {
        for (const r of structural) {
          fail(`${r.setup_type} (suppression_reason=${r.suppression_reason ?? 'null'}): ${r.n} row(s) in the last 30 days with no entry/stop/target at all -- can never resolve, will dead-end via NO_EXPIRY_SET with no actual_pnl. Find and fix the INSERT path that produced these.`);
        }
      }

      // (b) Real rows that DID resolve but have no actual_pnl -- excludes the two categories
      // already known and deliberately deferred (documented in CLAUDE.md/OPEN_THREADS.md):
      // INVALIDATED+PRE_ENTRY (no real entry occurred, correctly null by design) and
      // SESSION_CLOSED (OPEN_DECISION invalidated_session_closed_setups_never_get_actual_pnl,
      // not yet fixed, tracked separately). Anything ELSE in this bucket is a NEW pattern to
      // investigate, not yet explained by a known, already-flagged gap.
      const { rows: resolvedDead } = await client.query(`
        SELECT resolution, resolution_method, COUNT(*) as n, MIN(trade_date)::text as oldest, MAX(trade_date)::text as newest
        FROM active_setups
        WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution IS NOT NULL AND actual_pnl IS NULL
          AND trade_date >= CURRENT_DATE - 30
          AND NOT (resolution = 'INVALIDATED' AND invalidation_timing = 'PRE_ENTRY')
          AND resolution != 'SESSION_CLOSED'
        GROUP BY 1, 2 ORDER BY 3 DESC
      `);
      if (resolvedDead.length === 0) {
        ok('no unexplained resolved-but-no-actual_pnl rows in the last 30 days (beyond the known SESSION_CLOSED/PRE_ENTRY gaps)');
      } else {
        for (const r of resolvedDead) {
          warn(`${r.n} row(s) resolved=${r.resolution} resolution_method=${r.resolution_method ?? 'null'} with actual_pnl=NULL (${r.oldest} to ${r.newest}) -- not one of the already-known/deferred categories (SESSION_CLOSED, PRE_ENTRY invalidation). If resolution_method is null and predates 2026-07-20, this may be historical debris from before the TIME_EXPIRED mark-to-market fix, never backfilled -- otherwise investigate as a new gap.`);
        }
      }
    }

    // ── 8. Live-fired stop/target actually matches POINT-IN-TIME calibration ───────
    // FIXED 2026-08-05 (real methodology flaw, flagged by external review, confirmed against
    // CAM_R1_FADE_SHORT's own OPTIMAL_STOP history -- 66pt in early July, drifted to 24pt
    // mid-July, 25pt now): this check used to compare every one of the last 10 real fired
    // trades against a single LATEST OPTIMAL_STOP snapshot, regardless of when each trade
    // actually fired. Calibration legitimately changes over time (daily/weekly recalibration
    // runs), so a trade fired weeks ago under an older, since-superseded calibration value can
    // manufacture a "mismatch" against today's snapshot even though the live code correctly
    // read whatever calibration was live AT THE TIME it fired -- a false hardcode signature for
    // a genuinely well-wired setup. Fixed to a point-in-time join: each fired trade is now
    // compared against the OPTIMAL_STOP row that was actually live on its own fired_at date
    // (most recent run_date <= that date), the same no-lookahead discipline this codebase
    // already requires of every backtest/replay script, just applied to this diagnostic too.
    console.log('\n[8] Live-fired stop/target matches POINT-IN-TIME OPTIMAL_STOP calibration');
    {
      const TOLERANCE_PT = 2; // small rounding slack, not a "static threshold" for sizing/entries -- just a float-compare tolerance
      const RECENT_N = 10;

      const { rows: liveTypes } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name, recommendation
        FROM performance_audit WHERE signal_type = 'SETUP_STATUS'
        ORDER BY signal_name, run_date DESC
      `);
      const liveRows = liveTypes.filter(r => !['SUPPRESS', 'THIN_N'].includes(r.recommendation));
      const liveNames = liveRows.map(r => r.signal_name);
      const recByName = Object.fromEntries(liveRows.map(r => [r.signal_name, r.recommendation]));

      if (liveNames.length === 0) {
        warn('no live (non-SUPPRESS/THIN_N) setup_types found -- check [8] has nothing to verify this run');
      } else {
        // Full history per type now, not just the latest row -- needed for the point-in-time lookup.
        const { rows: optHistRows } = await client.query(`
          SELECT signal_name, run_date, optimal_stop::float as stop, optimal_target::float as target
          FROM performance_audit WHERE signal_type = 'OPTIMAL_STOP' AND signal_name = ANY($1)
            AND optimal_stop IS NOT NULL AND optimal_target IS NOT NULL
          ORDER BY signal_name, run_date ASC
        `, [liveNames]);
        const optHistByName = {};
        for (const r of optHistRows) (optHistByName[r.signal_name] ||= []).push(r);
        // Latest-per-type still used to report "current calibration says" in the warning text,
        // and to skip types with no calibration row at all (check [2] already covers that gap).
        const optByName = {};
        for (const r of optHistRows) optByName[r.signal_name] = r; // ASC order -> last write wins -> latest

        let checkedCount = 0, mismatchCount = 0, skippedNoHistoryAtFire = 0;
        for (const type of liveNames) {
          const opt = optByName[type];
          const hist = optHistByName[type] || [];
          if (!opt) continue; // check [2] already covers missing OPTIMAL_STOP rows

          const { rows: recent } = await client.query(`
            SELECT fired_at,
              ABS(stop_level::float - COALESCE(entry_zone_high::float, entry_zone_low::float)) as stop_dist,
              ABS(t1_level::float - COALESCE(entry_zone_high::float, entry_zone_low::float)) as target_dist
            FROM active_setups
            WHERE setup_type = $1 AND origin_status IN ('ACTIVE','SHADOW')
              AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
            ORDER BY fired_at DESC LIMIT $2
          `, [type, RECENT_N]);
          if (recent.length < 3) continue; // too thin to draw a conclusion either way

          // Point-in-time join: for each trade, find the calibration row live on its own
          // fired_at date. FIXED 2026-08-05 (found while building the Opus row-level export,
          // same night): run_date <= firedDate is wrong -- run_date is a DATE column with no
          // time component, but the daily calibration cron writes its row at 4:20pm ET
          // (run_daily_calibration.sh), so a `<=` same-day match credits a fire from EARLIER
          // THAT SAME DAY (confirmed live: 3 real fires at 04:20-07:52 ET on 2026-08-03 were
          // matched against that day's OWN 4:20pm calibration run, which didn't exist yet at
          // fire time) with calibration that hadn't been computed yet -- a real lookahead
          // bug, the exact class of error this codebase's own no-lookahead rule exists to
          // catch. Since run_date has no time-of-day to compare against precisely, the
          // defensible fix is strictly `<` (never same-day) -- conservative (a legitimate
          // late-day match after the real 4:20pm cron gets slightly stale-attributed to the
          // prior day instead), but never credits calibration before it existed, which is
          // the worse direction of error. A trade that fired before this type's first-ever
          // OPTIMAL_STOP row can't be judged against anything -- skip it, same convention as
          // check [10]'s "absent row != THIN_N row" handling elsewhere.
          const withContemporaneous = [];
          for (const r of recent) {
            const firedDate = r.fired_at.toISOString().slice(0, 10);
            let asOf = null;
            for (const h of hist) { if (h.run_date < firedDate) asOf = h; else break; }
            if (!asOf) { skippedNoHistoryAtFire++; continue; }
            withContemporaneous.push({ ...r, asOf });
          }
          if (withContemporaneous.length < 3) continue; // too thin post-join to draw a conclusion

          checkedCount++;
          // Require BOTH stop AND target to match -- "either one matches" is too lenient and
          // produces a real false negative: VWAP_MAGNET_LONG's hardcoded 30pt stop happened to
          // coincidentally equal its current calibrated stop (both 30), masking that its target
          // (hardcoded 20 vs calibrated 30) never matches at all. A genuinely-wired setup should
          // track BOTH legs of its own calibration, not just one by chance.
          const stopMatches = withContemporaneous.some(r => Math.abs(r.stop_dist - r.asOf.stop) <= TOLERANCE_PT);
          const targetMatches = withContemporaneous.some(r => Math.abs(r.target_dist - r.asOf.target) <= TOLERANCE_PT);
          if (!stopMatches || !targetMatches) {
            mismatchCount++;
            const sampleStops = [...new Set(withContemporaneous.map(r => r.stop_dist))].slice(0, 3).join(',');
            const sampleTargets = [...new Set(withContemporaneous.map(r => r.target_dist))].slice(0, 3).join(',');
            const mismatchedLeg = !stopMatches && !targetMatches ? 'stop AND target' : !stopMatches ? 'stop' : 'target';
            // DAY_TYPE_MANAGED types (IB_BULLISH/IB_BEARISH) deliberately use a per-day-type
            // bucket mechanism instead of a single blended OPTIMAL_STOP row -- a mismatch here
            // is expected, not evidence of a hardcode, so the message says so instead of
            // asserting a bug that isn't there. Still surfaced (not skipped) since the day-type
            // bucket wiring itself has never had an equivalent check -- a future real gap there
            // would otherwise go just as unnoticed as this whole check class did before today.
            const caveat = recByName[type] === 'DAY_TYPE_MANAGED'
              ? ` NOTE: this type is DAY_TYPE_MANAGED -- it may legitimately read a per-day-type calibration bucket instead of this single blended OPTIMAL_STOP row, so this mismatch is NOT necessarily a hardcode bug. Verify against the day-type-specific stop/target logic before concluding anything.`
              : ` This is the signature of a live code path that never reads OPTIMAL_STOP for its ${mismatchedLeg} (a hardcoded value, or a different field entirely) -- verify the actual INSERT/setup-construction code for this type before assuming the calibration is simply stale.`;
            warn(`${type}: current calibration says stop=${opt.stop}/target=${opt.target}, but the ${mismatchedLeg} never matches its OWN CONTEMPORANEOUS calibration across the last ${withContemporaneous.length} real fired trades (each compared against whatever OPTIMAL_STOP was live on its own fired_at date, not today's snapshot) -- actual stop distances seen: ${sampleStops}, target distances: ${sampleTargets}.${caveat}`);
          }
        }
        if (skippedNoHistoryAtFire > 0) {
          console.log(`  (info: ${skippedNoHistoryAtFire} recent fire(s) predated their setup_type's first OPTIMAL_STOP row -- excluded from the point-in-time comparison, not counted as a mismatch either way)`);
        }
        if (checkedCount > 0 && mismatchCount === 0) {
          ok(`all ${checkedCount} live setup_types with enough recent real trades show their calibrated stop/target actually in use`);
        } else if (checkedCount === 0) {
          warn('no live setup_type had >=3 recent real trades with entry/stop/target populated -- check [8] had nothing to verify this run');
        }
      }
    }

    // ── 9. Live types aren't silently falling back to raw percentiles ──────────────
    console.log('\n[9] Live setup_types use their own EV-swept stop/target, not the raw percentile fallback');
    {
      const { rows: fullOpt } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name,
          optimal_stop::float AS stop, optimal_target::float AS target,
          p75_mae::float AS raw_stop, p50_mfe::float AS raw_target
        FROM performance_audit WHERE signal_type = 'OPTIMAL_STOP'
        ORDER BY signal_name, run_date DESC
      `);

      const liveTypes = new Set(
        ssRows.rows.filter(r => !['SUPPRESS', 'THIN_N'].includes(r.recommendation)).map(r => r.signal_name)
      );

      let nullCount = 0;
      for (const row of fullOpt) {
        if (!liveTypes.has(row.signal_name)) continue;
        if (row.stop == null || row.target == null) {
          nullCount++;
          warn(`${row.signal_name}: live (non-SUPPRESS/THIN_N) but optimal_stop/optimal_target is NULL -- acd.js's COALESCE falls back to raw p75_mae/p50_mfe (${row.raw_stop}/${row.raw_target}), an uncalibrated pre-sweep value, with nothing surfacing the substitution.`);
        }
      }
      if (nullCount === 0) ok('all live setup_types have a real (non-fallback) optimal_stop/optimal_target');

      // Standing paper trail: report both methodologies' aggregate ratio side by side so a
      // future session can't accidentally quote one as if it were the other (see the
      // 2026-08-03 incident this check was built from in the header comment above).
      const ratio = (a, b) => (a != null && b != null && b !== 0) ? a / b : null;
      const median = (arr) => {
        const s = arr.filter(x => x != null).sort((a, b) => a - b);
        return s.length ? s[Math.floor(s.length / 2)] : null;
      };
      const fmt = (n) => n == null ? 'n/a' : n.toFixed(2);
      const liveOpt = fullOpt.filter(r => liveTypes.has(r.signal_name));

      const realAll = fullOpt.map(r => ratio(r.stop, r.target));
      const rawAll  = fullOpt.map(r => ratio(r.raw_stop, r.raw_target));
      const realLive = liveOpt.map(r => ratio(r.stop, r.target));
      const rawLive  = liveOpt.map(r => ratio(r.raw_stop, r.raw_target));

      ok(`population stop:target ratio (n=${fullOpt.length}) -- EV-sweep (real, load-bearing) median=${fmt(median(realAll))}, raw-percentile (NOT load-bearing, never quote as "the calibration") median=${fmt(median(rawAll))}`);
      ok(`live-firing-only (n=${liveOpt.length}) -- EV-sweep median=${fmt(median(realLive))}, raw-percentile median=${fmt(median(rawLive))}`);
    }

    // ── 10. RESEARCH_CLAIM scripts are wired to actually keep re-checking themselves ──
    // Added 2026-08-04, direct user question ("why isn't this being applied to all setups
    // for when they reach 20 N?" re: recordClaim()'s 30-day next_recheck_due being a FLAG,
    // not an auto-rerun). SETUP_STATUS/OPTIMAL_STOP already recompute automatically for
    // every live setup_type because backtest_setup_status.mjs is a generic scan (no
    // hardcoded list) run on a cron -- RESEARCH_CLAIM findings don't get that for free
    // because each is backed by a bespoke one-off script, but several (calibrate_
    // delta_confirmation.mjs, scan_regime_combinations.mjs, backtest_pd2_2dpoc_complete.mjs,
    // and now backtest_vwap_reclaim_hold_phase1.mjs/_globex_phase1.mjs) already use the
    // established fix: just add the script to run_weekly_backtests.sh (or
    // run_daily_calibration.sh) like any other calibration script, so it keeps recomputing
    // against fresh data on a schedule -- the promotion decision still stays a human call,
    // only the RECOMPUTE becomes automatic. This check verifies that pattern was actually
    // followed for every claim, not just the ones someone remembered to wire -- WARN-only,
    // since a real fraction of RESEARCH_CLAIM rows are legitimately one-time, settled
    // investigations (e.g. a definitively-rejected idea where no future data would change
    // the conclusion) that don't need a standing recheck. Read each WARN and judge; this
    // is a diagnostic surface, not a mandate to wire every single one.
    console.log('\n[10] RESEARCH_CLAIM source scripts wired into a recurring cron (not just a 30-day flag)');
    {
      const { rows: claimRows } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name, notes
        FROM performance_audit
        WHERE signal_type = 'RESEARCH_CLAIM'
        ORDER BY signal_name, run_date DESC
      `);
      // Fixed 2026-08-10: this used to read only the 2 "main" cron files, but 3 more
      // (run_confluence_backtest.sh, run_context_analysis.sh, run_session_bias.sh) are also
      // real, live crontab entries -- confirmed via `crontab -l` directly, not assumed. A
      // script scheduled only via one of those 3 was a false positive in the "unscheduled"
      // list (confluence_exhaustion_interaction's own claim text already said
      // "weekly-rechecked" while this check still flagged its source script as unscheduled --
      // caught while triaging the roadmap's "cron the claim scripts" item). Reads every
      // scripts/run_*.sh file present on disk rather than a hardcoded list of 5, so a future
      // 6th cron file doesn't silently reintroduce this same gap.
      const cronFiles = fs.readdirSync(path.resolve('scripts')).filter(f => /^run_.*\.sh$/.test(f));
      const scheduled = cronFiles.map(f => fs.readFileSync(path.resolve('scripts', f), 'utf8')).join('\n');

      // Detail goes to a dedicated scratch file, NOT one warn()/alert line per claim --
      // the historical backlog is large (~100+ pre-existing one-off scratch/pilot scripts,
      // most of them legitimately settled findings that don't need a standing recheck) and
      // dumping all of them into scratch/gemini_alerts.txt every run would drown out real
      // signal there. Only a single aggregate count enters the routine WARN/alert stream --
      // read the detail file when you actually want to triage the backlog, not every run.
      const unscheduled = [];
      const missingOnDisk = [];
      const seenSourceFiles = new Set();
      for (const row of claimRows) {
        let parsed;
        try { parsed = JSON.parse(row.notes); } catch { continue; }
        const sourceFile = parsed.source_file;
        if (!sourceFile || seenSourceFiles.has(sourceFile)) continue; // report once per script, not once per (K,dir)-style slug family
        seenSourceFiles.add(sourceFile);
        const scriptName = sourceFile.split('/').pop();
        if (!scheduled.includes(scriptName)) {
          unscheduled.push(`${row.signal_name} -> ${sourceFile}`);
        }
        // Added 2026-08-30 (DeepSeek code review round 4, finding S10): a claim's stored
        // source_file was never checked against the actual filesystem -- a typo'd or renamed
        // path (found live: poc_rotation_join_confirm_2close.mjs's recordClaim() cited a
        // sourceFile that had never existed) passed this whole loop silently, since the only
        // check here is cron-scheduling, not existence. `source_file` is sometimes a single
        // path, sometimes a "path1, path2" or "path + description" compound string (multiple
        // real files/services credited together) -- self-caught while building this check
        // (initial version treated the whole compound string as one path and flagged real,
        // existing files as missing) -- so each comma/plus-separated token that itself looks
        // like a real repo-relative path is checked independently, and only a token that both
        // looks like a path AND doesn't resolve gets flagged. A hand-typed attribution to a
        // since-deleted one-off script (record_claim.mjs --add at the CLI, no recordClaim() call
        // to grep for) is a legitimate, deliberate case -- still flagged here, since the point is
        // "does this path exist," not "was it written programmatically."
        const candidatePaths = sourceFile.split(/,| \+ /).map(s => s.trim()).filter(s => /^(scripts|server)\//.test(s));
        const missingTokens = candidatePaths.filter(p => !existsSync(path.resolve(p.split(' ')[0])));
        if (candidatePaths.length > 0 && missingTokens.length === candidatePaths.length) {
          missingOnDisk.push(`${row.signal_name} -> ${sourceFile}`);
        }
      }
      if (missingOnDisk.length === 0) {
        ok('every RESEARCH_CLAIM source_file that looks like a live script path actually exists on disk');
      } else {
        for (const line of missingOnDisk) {
          warn(`RESEARCH_CLAIM source_file does not exist on disk: ${line} -- either a typo in the recordClaim() call, or the script was renamed/deleted after this claim was recorded (re-point it, or accept it's now an untracked-methodology claim like the genuinely-orphaned poc_rotation ones)`);
        }
      }
      const detailFile = path.resolve('scratch/research_claim_unscheduled.txt');
      if (unscheduled.length === 0) {
        ok('every RESEARCH_CLAIM source script is wired into a recurring cron');
        if (existsSync(detailFile)) fs.unlinkSync(detailFile);
      } else {
        fs.writeFileSync(detailFile,
          `${unscheduled.length} RESEARCH_CLAIM source script(s) not found in any of scripts/run_*.sh (${cronFiles.join(', ')}), as of ${nowET()} ET.\n` +
          `Most of these are legitimately settled/rejected one-time findings that don't need a standing recheck -- this is a triage list, not a to-do list.\n` +
          `Only add a script to one of these cron files if it's still an open/PROVISIONAL question that should keep re-checking itself as real data accumulates.\n\n` +
          unscheduled.join('\n') + '\n');
        warn(`${unscheduled.length} of ${seenSourceFiles.size} distinct RESEARCH_CLAIM source scripts are not wired into a recurring cron -- full list in ${detailFile} (not printed here individually, mostly expected for settled findings)`);
      }
    }

    // ── 11. Parked RESEARCH_CLAIM unblock conditions ──────────────────────────────
    // Added 2026-08-04, direct Opus feedback relayed by the user: "revisit as N grows" with
    // nothing watching N is a note in a drawer, not a plan -- the gap isn't memory (check [10]
    // already guarantees the CLAIM itself can't be silently forgotten), it's that a claim can be
    // deferred with no MACHINE-CHECKABLE condition for when it's no longer blocked. This check
    // does two things for every current RESEARCH_CLAIM: (a) FAILs loudly if a claim's own
    // recorded unblockCondition (see recordClaim()'s JSDoc, scripts/record_claim.mjs) is now
    // actually met -- e.g. real N has grown past the threshold the claim itself named -- so a
    // deferred finding surfaces for action the moment it's actionable, not whenever a future
    // session happens to remember to look; (b) WARNs (not fails) on any claim whose rigor_status
    // string suggests a data-volume block (contains "DATA_LIMITED" or "THIN") but carries no
    // unblockCondition at all -- per the convention this check exists to enforce, a deferral
    // needs a named, checkable condition or it isn't a deferral, it's a decision that was never
    // made. Currently only the 'min_real_n_per_type' unblockCondition shape is supported; a
    // future claim needing a different shape should extend this check, not invent an unchecked one.
    console.log('\n[11] Parked RESEARCH_CLAIM unblock conditions');
    {
      const claims = await listClaims();
      let unblockedCount = 0, unnamedCount = 0;
      for (const c of claims) {
        const n = c.notes || {};
        const uc = n.unblock_condition;
        if (uc && uc.type === 'min_real_n_per_type') {
          const { rows: nRows } = await client.query(`
            SELECT setup_type, COUNT(*) as real_n
            FROM active_setups
            WHERE setup_type = ANY($1) AND origin_status IN ('ACTIVE','SHADOW')
              AND resolution IN ('TARGET_HIT','STOP_HIT')
            GROUP BY setup_type
          `, [uc.setupTypes]);
          const ns = uc.setupTypes.map(t => {
            const r = nRows.find(x => x.setup_type === t);
            return r ? +r.real_n : 0;
          }).sort((a, b) => a - b);
          const medianN = ns.length ? ns[Math.floor(ns.length / 2)] : 0;
          if (medianN >= uc.minN) {
            unblockedCount++;
            fail(`${c.slug}: unblock condition MET -- median real N across ${uc.setupTypes.length} tracked setup_types is now ${medianN} (threshold ${uc.minN}). Re-run the referenced diagnostic (${n.source_file}) -- this claim's "wait for data" state is over.`);
          }
        } else if (!uc && /DATA_LIMITED|THIN/i.test(n.rigor_status || '') && n.status !== 'CONFIRMED') {
          unnamedCount++;
          warn(`${c.slug}: rigor_status ("${n.rigor_status}") suggests a data-volume deferral but no unblockCondition was recorded -- per convention, add one (recordClaim()'s unblockCondition param) so this can be watched automatically instead of relying on a future session noticing.`);
        }
      }
      if (unblockedCount === 0 && unnamedCount === 0) ok('no parked claims are unblocked, and every data-limited claim names a checkable condition');
      else if (unblockedCount === 0) ok(`no parked claims are unblocked yet (${unnamedCount} claim(s) flagged above for missing an unblock condition)`);
    }

    console.log('\n[12] OPTIMAL_STOP circuit breaker never sits TRIPPED unresolved');
    {
      const { rows: cbRows } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name, notes, optimal_stop::float as optimal_stop,
               optimal_target::float as optimal_target
        FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
        ORDER BY signal_name, run_date DESC
      `);
      let trippedCount = 0;
      for (const row of cbRows) {
        let n; try { n = JSON.parse(row.notes); } catch (_) { n = null; }
        const cb = n?.circuitBreaker;
        if (cb?.tripped && cb.reason !== 'manual_revert_20260804') {
          trippedCount++;
          fail(`${row.signal_name}: circuit breaker TRIPPED (reason=${cb.reason}) -- attempted stop=${cb.attemptedStop}/target=${cb.attemptedTarget} rejected, currently frozen at stop=${row.optimal_stop}/target=${row.optimal_target} (prior stop=${cb.priorStop}/target=${cb.priorTarget}, stopPctChange=${cb.stopPctChange}, targetPctChange=${cb.targetPctChange}). This means the sweep is trying to move this stop/target by more than ${cb.maxPctChange * 100}% -- investigate before manually clearing (see optimal_stop_100pct_unguarded_fallback_needs_new_formula), don't just re-run and let it silently keep failing.`);
        }
      }
      if (trippedCount === 0) ok('no OPTIMAL_STOP row is currently sitting in a tripped circuit-breaker state');
    }

    // ── 12b. OPTIMAL_STOP circuit breaker deadlock (deltaN < 0 can never clear the gate) ──
    // Resolves OPEN_DECISION optimal_stop_circuit_breaker_n_count_unreconciled_drop (Opus Audit
    // 9 root cause, 2026-08-19/20): a row frozen with reason='min_delta_n_not_met' is routine
    // and expected when a growing population is just a few trades short (deltaN >= 0, < required)
    // -- check [5] already WARNs/skips appropriately for that, INCLUDING the deltaN===0 flat case
    // (a large healthy population sitting exactly at its baseline is not broken, it just needs
    // ordinary organic growth same as deltaN>0). Only deltaN < 0 means real N has SHRUNK below
    // the stored baseline -- structurally unable to ever clear minDeltaNRequired() without the
    // baseline itself moving, which (before the 2026-08-19/20 fix to update_optimal_stops.mjs's
    // frozen-branch return) it could never do on its own. This is distinct from check [12]
    // (TRIPPED, a different reason) and from check [5]'s per-row EV-drift concern -- a dedicated
    // check because "the gate is structurally unreachable" is a different class of problem than
    // "the gate hasn't been cleared yet." Boundary corrected 2026-08-20 (DeepSeek code review of
    // commit ee0f6d8, Q4): the original `deltaN <= 0` condition misclassified flat-but-healthy
    // rows (deltaN===0, e.g. VWAP_MAGNET_LONG/SHORT at the time of this fix) as "deadlocked" --
    // confirmed live, both FAILed under the old boundary despite being large, growing-normally
    // populations. Since R1 (the Math.min ratchet) makes a real deltaN<0 deadlock self-healing
    // the next time this script runs, this check is now closer to a one-time cleanup inventory
    // than a standing structural alarm -- kept as FAIL (not downgraded to WARN) because a NEW
    // deltaN<0 case appearing after R1 shipped would mean the ratchet itself has a bug, which is
    // worth catching loudly.
    console.log('\n[12b] OPTIMAL_STOP circuit breaker deadlock -- deltaN < 0 can never clear the gate');
    {
      const { rows: cbRows2 } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name, notes
        FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
        ORDER BY signal_name, run_date DESC
      `);
      const { rows: liveEligibleRows } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name, recommendation
        FROM performance_audit WHERE signal_type='SETUP_STATUS'
        ORDER BY signal_name, run_date DESC
      `);
      // Corrected 2026-08-20 (DeepSeek review, Q8.1): "live-eligible" here used to mean purely
      // "SETUP_STATUS recommendation says so", ignoring CAPITAL_EXPOSURE_OVERRIDE entirely -- so
      // a type this SAME commit (R2) demoted to SHADOW via the override (e.g. PD_POC_FADE_SHORT)
      // would still get flagged here as "live-eligible but deadlocked", reading as a fresh
      // regression when it's actually already safely SHADOW-forced. Exclude override members from
      // the FAIL-tier set; call them out separately, informationally, since their OPTIMAL_STOP
      // being deadlocked is still worth knowing about (it's part of why some overrides can't
      // self-clear), just not at FAIL severity.
      const liveEligible = new Set(liveEligibleRows.filter(r => ['ACTIVE', 'PROMOTE', 'DAY_TYPE_MANAGED'].includes(r.recommendation) && !CAPITAL_EXPOSURE_OVERRIDE.has(r.signal_name)).map(r => r.signal_name));
      const overrideEligible = new Set(liveEligibleRows.filter(r => ['ACTIVE', 'PROMOTE', 'DAY_TYPE_MANAGED'].includes(r.recommendation) && CAPITAL_EXPOSURE_OVERRIDE.has(r.signal_name)).map(r => r.signal_name));
      let deadlocked = 0, deadlockedLiveEligible = [], deadlockedOverride = [];
      for (const row of cbRows2) {
        let n; try { n = JSON.parse(row.notes); } catch (_) { n = null; }
        const cb = n?.circuitBreaker;
        if (cb?.reason === 'min_delta_n_not_met' && cb.deltaN != null && cb.deltaN < 0) {
          deadlocked++;
          if (liveEligible.has(row.signal_name)) deadlockedLiveEligible.push({ signal_name: row.signal_name, ...cb });
          else if (overrideEligible.has(row.signal_name)) deadlockedOverride.push({ signal_name: row.signal_name, ...cb });
        }
      }
      if (deadlockedOverride.length > 0) {
        for (const r of deadlockedOverride) {
          console.log(`  INFO  ${r.signal_name}: live-eligible by SETUP_STATUS recommendation but currently SHADOW-forced via CAPITAL_EXPOSURE_OVERRIDE -- its OPTIMAL_STOP is ALSO deadlocked (baselineN=${r.baselineN}, currentN=${r.currentN}, deltaN=${r.deltaN}), not currently a live-capital concern but relevant to when the override's revisitWhen condition can ever be met.`);
        }
      }
      if (deadlocked === 0) {
        ok('no OPTIMAL_STOP row is deadlocked (deltaN < 0 under a min_delta_n_not_met freeze)');
      } else {
        warn(`${deadlocked} OPTIMAL_STOP row(s) deadlocked (min_delta_n_not_met with deltaN < 0) across the whole table -- their real N has SHRUNK below their last accepted recalibration baseline, so the gate they must clear was unreachable as of their last run. Not necessarily a bug by itself (a genuinely rare-touch type can sit here indefinitely) -- see the live-eligible FAILs below for the cases that actually matter. Since the 2026-08-19/20 Math.min ratchet fix, this should self-heal the NEXT time this script runs for each row -- if a row still shows here across two consecutive runs post-fix, the ratchet itself likely has a bug.`);
        for (const r of deadlockedLiveEligible) {
          fail(`${r.signal_name}: live-eligible (ACTIVE/PROMOTE/DAY_TYPE_MANAGED, not on CAPITAL_EXPOSURE_OVERRIDE) but its OPTIMAL_STOP is deadlocked -- baselineN=${r.baselineN}, currentN=${r.currentN}, deltaN=${r.deltaN}, needs deltaN>=${r.minDeltaNRequired}. This type's stop/target cannot self-correct until its real N grows past the frozen baseline. Check whether a recent bulk delete/reclassification of active_setups (a repair script, a cascade-breaker fix) collapsed its real N without re-baselining this counter -- see the 2026-08-19/20 fix to update_optimal_stops.mjs's applyCircuitBreaker() frozen-branch lastRecalibratedN handling.`);
        }
      }
    }

    console.log('\n[13] Aggregate OPTIMAL_STOP distribution -- noise-floor check + week-over-week shift');
    {
      // Market's own real noise floor, computed fresh (no static threshold) -- same convention
      // already established in this codebase for trailing-stop candidate widths, applied here
      // to the base stop sweep for the first time.
      const { rows: barRows } = await client.query(`
        SELECT (high::float - low::float) AS rng
        FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW() - interval '30 days'
      `);
      const ranges = barRows.map(r => r.rng).filter(x => x != null).sort((a, b) => a - b);
      const medianBarRange = ranges.length ? ranges[Math.floor(ranges.length / 2)] : null;
      const noiseFloor = medianBarRange != null ? medianBarRange * 1.5 : null;

      const liveTypes = new Set(
        ssRows.rows.filter(r => !['SUPPRESS', 'THIN_N'].includes(r.recommendation)).map(r => r.signal_name)
      );
      const { rows: curOpt } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name, optimal_stop::float AS stop, run_date
        FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
        ORDER BY signal_name, run_date DESC
      `);

      let noiseFloorHits = 0;
      if (noiseFloor != null) {
        for (const row of curOpt) {
          if (!liveTypes.has(row.signal_name) || row.stop == null) continue;
          if (row.stop < noiseFloor) {
            noiseFloorHits++;
            fail(`${row.signal_name}: live optimal_stop=${row.stop}pt sits below ${noiseFloor.toFixed(1)}pt (1.5x the real trailing-30-day median 1-min NQ bar range, ${medianBarRange.toFixed(1)}pt) -- this stop is inside normal single-bar noise and will likely get clipped on nearly every trade. Investigate before trusting it, same signature as the GLOBEX_VWAP_FADE_LONG 8pt incident this check was built from.`);
          }
        }
      }
      if (noiseFloorHits === 0) ok(`no live optimal_stop sits inside the real market noise floor (${noiseFloor != null ? noiseFloor.toFixed(1) + 'pt' : 'n/a'})`);

      // Week-over-week aggregate median shift, live types only.
      const median = (arr) => { const s = arr.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
      const { rows: weekAgoOpt } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name, optimal_stop::float AS stop
        FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND run_date <= CURRENT_DATE - interval '7 days'
        ORDER BY signal_name, run_date DESC
      `);
      const curLiveStops = curOpt.filter(r => liveTypes.has(r.signal_name)).map(r => r.stop);
      const weekAgoLiveStops = weekAgoOpt.filter(r => liveTypes.has(r.signal_name)).map(r => r.stop);
      const curMedian = median(curLiveStops), weekAgoMedian = median(weekAgoLiveStops);
      if (curMedian != null && weekAgoMedian != null && weekAgoMedian > 0) {
        const pctShift = Math.abs(curMedian - weekAgoMedian) / weekAgoMedian;
        if (pctShift > 0.20) {
          warn(`Live-type aggregate median optimal_stop shifted ${(pctShift * 100).toFixed(0)}% over the last 7 days (${weekAgoMedian}pt -> ${curMedian}pt) -- worth checking whether a recent change to what data feeds calibration (an origin_status/population filter, a guardrail change) is behind a system-wide shift, not just per-type noise.`);
        } else {
          ok(`live-type aggregate median optimal_stop stable over 7 days (${weekAgoMedian}pt -> ${curMedian}pt, ${(pctShift * 100).toFixed(1)}% shift)`);
        }
      } else {
        ok('not enough 7-day-old history yet to compare aggregate median shift');
      }
    }

    // ── 14. Standing docs-size cap (added 2026-08-05) ───────────────────────────────
    // An external audit found CLAUDE.md (219KB) + OPEN_THREADS.md (386KB, despite
    // scripts/archive_open_threads.mjs already existing to prevent exactly this) had grown to
    // ~152K combined tokens -- past the point where a session can hold both in working memory,
    // which is the documented mechanism behind at least one real rediscovery-from-scratch
    // incident this session (volatility clustering, confirmed 2026-07-23, re-derived 2026-08-04).
    // A convention written inside a 55K-token file is a rule nobody reads; only a check that
    // fires every night is guaranteed to be seen. This does not enforce a redesign of CLAUDE.md's
    // structure (that's a real, separate editorial project, not a mechanical fix) -- it only
    // keeps the SIZE regression from being invisible the way it was before.
    console.log('\n[14] Standing docs-size cap');
    {
      const CLAUDE_MD_MAX_LINES = 300;
      const CLAUDE_MD_MAX_KB = 40; // the line cap alone is gameable by long single-line paragraphs
      const OPEN_THREADS_MAX_KB = 250;
      const claudeMdPath = path.resolve('CLAUDE.md');
      const openThreadsPath = path.resolve('docs/OPEN_THREADS.md');
      if (existsSync(claudeMdPath)) {
        const lines = fs.readFileSync(claudeMdPath, 'utf8').split('\n').length;
        const kb = fs.statSync(claudeMdPath).size / 1024;
        if (lines > CLAUDE_MD_MAX_LINES || kb > CLAUDE_MD_MAX_KB) {
          warn(`CLAUDE.md is ${lines} lines / ${kb.toFixed(0)}KB (caps: ${CLAUDE_MD_MAX_LINES} lines, ${CLAUDE_MD_MAX_KB}KB -- the KB cap is the one that actually matters here, since long individual paragraphs can pass a line-count cap while still costing real context) -- this is a known, not-yet-executed restructuring (split into docs/ per-topic files, keep only hard rules + a pointer index here), not something this check can fix by itself. WARN, not FAIL, since forcing this line-by-line tonight would risk losing hard-won context faster than a careful split would.`);
        } else {
          ok(`CLAUDE.md within size cap (${lines}/${CLAUDE_MD_MAX_LINES} lines, ${kb.toFixed(0)}/${CLAUDE_MD_MAX_KB}KB)`);
        }
      }
      if (existsSync(openThreadsPath)) {
        const kb = fs.statSync(openThreadsPath).size / 1024;
        if (kb > OPEN_THREADS_MAX_KB) {
          warn(`docs/OPEN_THREADS.md is ${kb.toFixed(0)}KB (cap ${OPEN_THREADS_MAX_KB}KB) -- run node scripts/archive_open_threads.mjs --apply (now wired into run_daily_calibration.sh as of 2026-08-05, so this should self-correct within a day; a WARN here means it's still catching up or the cron didn't run).`);
        } else {
          ok(`docs/OPEN_THREADS.md within size cap (${kb.toFixed(0)}/${OPEN_THREADS_MAX_KB}KB)`);
        }
      }
    }

    console.log('\n[15] Fire-time regime tagging (roadmap Phase 1, I1) -- no-lookahead guard');
    {
      // (a) Source-level check that getVolBucketAtFire's population query has a strict
      // upper time bound -- the exact guard I1's own spec item calls for ("fails if any
      // regime field's source query lacks an upper time bound"). Static, not a live
      // query, so it can't be fooled by a code path that happens not to have fired yet.
      const acdSrc = fs.readFileSync(path.resolve('server/routes/acd.js'), 'utf8');
      const volBucketFnMatch = acdSrc.match(/export async function getVolBucketAtFire[\s\S]*?\n}\n/);
      if (!volBucketFnMatch) {
        fail('getVolBucketAtFire() not found in server/routes/acd.js -- I1 regime tagging may have been removed or renamed without updating this check');
      } else if (!/ts::date\s*<\s*\$1/.test(volBucketFnMatch[0])) {
        fail('getVolBucketAtFire() no longer has a strict upper time bound (ts::date < $1) on its price_bars_primary query -- this is the exact no-lookahead guard I1 was built to enforce; a query missing this could let a fire-time tag see data from AFTER the trade_date it is tagging');
      } else {
        ok('getVolBucketAtFire() query has a strict upper time bound (ts::date < $1)');
      }

      // (b) Structural guarantee, not a data check: acd_daily_log.day_type is only ever
      // written by derive_day_types.js at 20:20 ET (run_daily_calibration.sh) -- RTH
      // fires (9:30-16:00 ET) always happen before that, every day, so ANY RTH-session
      // active_setups row with a non-UNKNOWN day_type_at_fire is proof of a lookahead
      // leak (e.g. a future edit that swaps in a live estimate without updating this
      // guard, or a timezone bug in how trade_date/session get set at insert time).
      const rthLeak = await client.query(`
        SELECT id, trade_date, fired_at::text, day_type_at_fire
        FROM active_setups
        WHERE session = 'RTH' AND day_type_at_fire IS NOT NULL AND day_type_at_fire != 'UNKNOWN'
        ORDER BY fired_at DESC LIMIT 5
      `).catch(() => ({ rows: [] }));
      if (rthLeak.rows.length > 0) {
        fail(`${rthLeak.rows.length}+ RTH-session active_setups row(s) have a non-UNKNOWN day_type_at_fire (e.g. id=${rthLeak.rows[0].id}, trade_date=${rthLeak.rows[0].trade_date}, day_type_at_fire=${rthLeak.rows[0].day_type_at_fire}) -- acd_daily_log.day_type for that SAME trade_date cannot legitimately be known before derive_day_types.js's 20:20 ET run, which is always after RTH close. This is a real lookahead leak, not a stale-value quirk.`);
      } else {
        ok('no RTH-session row has a non-UNKNOWN day_type_at_fire (structurally impossible without lookahead)');
      }

      // (c) Determinism re-derivation: getVolBucketAtFire(tradeDate) excludes the WHOLE
      // trade_date from its own rolling window, so its output for any past date is fixed
      // forever -- re-deriving it today via the REAL exported function (not a hand-copy)
      // must reproduce exactly what was stored at insert time. A mismatch means either a
      // non-deterministic bug or a historical price_bars_primary correction that silently
      // changed a past tag -- either way worth surfacing, not silently trusting the stored
      // value forever.
      // FIXED 2026-08-31: the sample used to include the CURRENT trade_date, which is not a
      // real determinism test -- getVolBucketAtFire()'s rolling window reads bars from prior
      // days right up to "now," so re-deriving TODAY's own bucket later in the same session
      // can legitimately land in a different bucket as more of today's own bars accumulate
      // (confirmed live: the sole mismatch this check ever found was trade_date=today,
      // stored=ABOVE_AVG vs fresh=AVG, re-derived hours later same day -- not a historical
      // price_bars_primary correction, just an inherently moving target). Excluding today
      // keeps this a genuine test of "does a PAST, settled tag reproduce," which is what the
      // check's own docstring above claims to verify.
      const sample = await client.query(`
        SELECT DISTINCT trade_date::text, vol_bucket_at_fire
        FROM active_setups
        WHERE vol_bucket_at_fire IS NOT NULL AND trade_date < CURRENT_DATE
        ORDER BY trade_date DESC LIMIT 20
      `).catch(() => ({ rows: [] }));
      if (sample.rows.length === 0) {
        ok('no vol_bucket_at_fire rows yet to re-derive (expected immediately after this field was added -- will self-populate as new setups fire)');
      } else {
        let mismatches = 0;
        for (const r of sample.rows) {
          const fresh = await getVolBucketAtFire(r.trade_date);
          if (fresh !== r.vol_bucket_at_fire) mismatches++;
        }
        if (mismatches > 0) {
          fail(`${mismatches}/${sample.rows.length} sampled vol_bucket_at_fire values don't match a fresh re-derivation via the real getVolBucketAtFire() -- either a non-deterministic bug or price_bars_primary was corrected after these rows were tagged.`);
        } else {
          ok(`all ${sample.rows.length} sampled vol_bucket_at_fire values reproduce exactly via a fresh re-derivation (deterministic, no lookahead)`);
        }
      }
    }

    console.log('\n[16] Non-fire logging (roadmap Phase 1, I2) -- gated_candidates table health');
    {
      const KNOWN_GATE_NAMES = new Set([
        'GLOBEX_ALREADY_FIRED_TODAY', 'OTD_HARDCODED_KILL', 'IB_DAYTYPE_REAL_N_FLOOR',
        'RISK_CHECK_MAIN', 'RISK_CHECK_SHADOW', 'DIRECTIONAL_CONFLICT_STAND_ASIDE',
        'C_STANDALONE_DEATH_SEQUENCE', 'C_STANDALONE_POC_COUNTER',
        // Added 2026-08-20 (verify_shadowcandidates_refire_cooldown_fix_live) -- the
        // 2026-08-19 machine-gun-refire fix (commit b919990) wired REFIRE_COOLDOWN_MINUTES
        // into the shadowCandidates insert path for the first time; this is that gate's
        // name, first observed live 2026-08-20 during real RTH hours.
        'REFIRE_COOLDOWN_SHADOW',
        // Found missing 2026-08-20 while adding the entry above -- this gate has been live
        // since the 2026-08-12 cluster-fallback fix (the directional-EV-sorted candidate
        // walk in the level-fade primary-selection path, acd.js ~7058-7100) and has been
        // silently WARNing this check for over a week (1637 real hits in the last 7 days
        // alone) without anyone noticing, since nothing was watching for a stray-vs-real
        // new gate name distinction until this session's own fix was being applied.
        'LEVEL_FADE_CLUSTER_FALLBACK_SKIP',
      ]);
      const tableCheck = await client.query(`
        SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='gated_candidates') as exists
      `).catch(() => ({ rows: [{ exists: false }] }));
      if (!tableCheck.rows[0].exists) {
        fail('gated_candidates table does not exist -- I2 (non-fire logging) has been reverted or never migrated on this DB');
      } else {
        const rows = await client.query(`
          SELECT gate_name, COUNT(*)::int as n, MAX(evaluated_at)::text as latest
          FROM gated_candidates
          WHERE evaluated_at > NOW() - INTERVAL '7 days'
          GROUP BY gate_name ORDER BY n DESC
        `).catch(() => ({ rows: [] }));
        const unknownGates = rows.rows.filter(r => !KNOWN_GATE_NAMES.has(r.gate_name));
        if (unknownGates.length > 0) {
          warn(`gated_candidates has gate_name value(s) not in this check's known list: ${unknownGates.map(r => r.gate_name).join(', ')} -- either a new gate was wired (update KNOWN_GATE_NAMES here) or a typo produced a stray gate_name that will never aggregate cleanly with its siblings.`);
        }
        if (rows.rows.length === 0) {
          ok('gated_candidates table exists, no rows in the last 7 days yet (expected immediately after this table was added)');
        } else {
          ok(`gated_candidates: ${rows.rows.length} distinct gate(s) logged in the last 7 days -- ${rows.rows.map(r => `${r.gate_name}=${r.n}`).join(', ')}`);
        }
      }
    }

    console.log('\n[17] bet_class coverage (roadmap Phase 1, I3)');
    {
      // (a) Every distinct setup_type in active_setups must resolve to a bet_class other
      // than UNCLASSIFIED via getBetClass() -- the real function, not a hand-copy. Catches
      // a new setup_type added without updating CONTINUATION_TYPES/MEAN_REVERSION_OVERRIDE_
      // TYPES (the '_FADE' substring default rule already covers the large majority, so
      // this should only ever flag a genuinely new, non-fade-named setup_type).
      const typesRes = await client.query(`SELECT DISTINCT setup_type FROM active_setups`);
      const unclassified = typesRes.rows.map(r => r.setup_type).filter(t => getBetClass(t) === 'UNCLASSIFIED');
      if (unclassified.length > 0) {
        warn(`${unclassified.length} real setup_type(s) resolve to UNCLASSIFIED via getBetClass(): ${unclassified.join(', ')} -- add to CONTINUATION_TYPES or MEAN_REVERSION_OVERRIDE_TYPES in server/config/setupTypes.js (see inferStrategyFamily()'s own docs for the classification method) rather than leaving them pooled with neither real bucket.`);
      } else {
        ok(`all ${typesRes.rows.length} real setup_types resolve to a real bet_class (none UNCLASSIFIED)`);
      }

      // (b) The STORED bet_class column shouldn't silently drift from what getBetClass()
      // would compute today -- a mismatch means either a setup_type was reclassified in
      // setupTypes.js after some rows were already tagged (expected to happen occasionally,
      // WARN not FAIL) or the INSERT-site wiring has a bug feeding the wrong value.
      const storedRes = await client.query(`
        SELECT setup_type, bet_class, COUNT(*)::int as n
        FROM active_setups WHERE bet_class IS NOT NULL
        GROUP BY setup_type, bet_class
      `);
      const drifted = storedRes.rows.filter(r => getBetClass(r.setup_type) !== r.bet_class);
      if (drifted.length > 0) {
        warn(`${drifted.length} (setup_type, stored bet_class) combination(s) don't match a fresh getBetClass() re-derivation (e.g. ${drifted[0].setup_type}: stored=${drifted[0].bet_class}, fresh=${getBetClass(drifted[0].setup_type)}, ${drifted[0].n} row(s)) -- expected if setupTypes.js's classification changed since those rows were tagged; re-run the backfill (see the 2026-08-10 bet_class backfill in docs/OPEN_THREADS.md) if this is unexpected drift, not a deliberate reclassification.`);
      } else {
        ok(`all ${storedRes.rows.length} (setup_type, bet_class) combinations match a fresh getBetClass() re-derivation`);
      }

      // (c) BET_CLASS_STATUS rows exist and are fresh (weekly cron) -- confirms the
      // aggregation layer is actually running, not just built once and forgotten.
      const statusRes = await client.query(`
        SELECT signal_name, run_date::text, sample_size FROM performance_audit
        WHERE signal_type = 'BET_CLASS_STATUS'
        ORDER BY run_date DESC LIMIT ${BET_CLASSES.length}
      `).catch(() => ({ rows: [] }));
      if (statusRes.rows.length === 0) {
        warn('no BET_CLASS_STATUS rows in performance_audit yet -- run node scripts/backtest_bet_class_status.mjs (now wired into run_weekly_backtests.sh)');
      } else {
        const latestRunDate = statusRes.rows[0].run_date;
        const daysSince = Math.floor((Date.now() - new Date(latestRunDate).getTime()) / 86400000);
        if (daysSince > 9) {
          warn(`latest BET_CLASS_STATUS run_date is ${latestRunDate} (${daysSince} days ago) -- expected weekly (run_weekly_backtests.sh), check the cron actually ran.`);
        } else {
          ok(`BET_CLASS_STATUS fresh as of ${latestRunDate} (${daysSince}d ago) -- ${statusRes.rows.map(r => `${r.signal_name}=N${r.sample_size}`).join(', ')}`);
        }
      }
    }

    console.log('\n[18] Roster cap enforcement (roadmap Phase 8, I7)');
    {
      // (a) BET_CLASS_STAGE must have an entry for every non-UNCLASSIFIED bet_class, and no
      // entry for a bet_class that doesn't exist -- the two-registry sync risk DeepSeek's
      // design critique flagged explicitly (scratch/deepseek_response.md, 2026-08-11).
      const nonUnclassified = BET_CLASSES.filter(c => c !== 'UNCLASSIFIED');
      const missingStage = nonUnclassified.filter(c => !(c in BET_CLASS_STAGE));
      const orphanStage = Object.keys(BET_CLASS_STAGE).filter(c => !BET_CLASSES.includes(c));
      if (missingStage.length > 0) {
        warn(`BET_CLASS_STAGE is missing an entry for: ${missingStage.join(', ')} -- every real bet_class needs a stage (LEGACY_LIVE / SHADOW / STAGE_4_ACTIVE) or roster-cap counting silently excludes it.`);
      }
      if (orphanStage.length > 0) {
        warn(`BET_CLASS_STAGE has stale entr(y/ies) for bet_class(es) no longer in BET_CLASSES: ${orphanStage.join(', ')} -- remove from server/config/setupTypes.js.`);
      }
      if (missingStage.length === 0 && orphanStage.length === 0) {
        ok(`BET_CLASS_STAGE covers all ${nonUnclassified.length} non-UNCLASSIFIED bet_classes, no orphans`);
      }

      // (b) The cap itself -- re-derive via the real exported assertion, not a hand-copy.
      // This is the recurring enforcement layer; the module-load call in setupTypes.js is
      // the startup guard, this is what catches it on every routine self-check in between
      // process restarts.
      try {
        const liveClasses = assertRosterCapNotExceeded();
        ok(`roster cap OK: ${liveClasses.length}/${ROSTER_CAP} live bet_classes (${liveClasses.join(', ')})`);
      } catch (e) {
        fail(`roster cap exceeded: ${e.message}`);
      }
    }

    console.log('\n[19] Correlation monitor freshness (roadmap Phase 8, I5)');
    {
      const corrRes = await client.query(`
        SELECT signal_type, run_date::text, COUNT(*)::int as n_pairs
        FROM performance_audit
        WHERE signal_type IN ('CORRELATION_MONITOR_BET_CLASS', 'CORRELATION_MONITOR_SETUP_TYPE')
        GROUP BY signal_type, run_date
        ORDER BY run_date DESC
      `).catch(() => ({ rows: [] }));
      if (corrRes.rows.length === 0) {
        warn('no CORRELATION_MONITOR_* rows in performance_audit yet -- run node scripts/monitor_bet_correlation.mjs (now wired into run_weekly_backtests.sh)');
      } else {
        const latestRunDate = corrRes.rows[0].run_date;
        const daysSince = Math.floor((Date.now() - new Date(latestRunDate).getTime()) / 86400000);
        if (daysSince > 9) {
          warn(`latest CORRELATION_MONITOR run_date is ${latestRunDate} (${daysSince} days ago) -- expected weekly (run_weekly_backtests.sh), check the cron actually ran.`);
        } else {
          ok(`CORRELATION_MONITOR fresh as of ${latestRunDate} (${daysSince}d ago) -- ${corrRes.rows.filter(r => r.run_date === latestRunDate).map(r => `${r.signal_type}=${r.n_pairs} pair(s)`).join(', ')}`);
        }
      }
    }

    // ── 20. Reachability: every ACTIVE/PROMOTE-rated setup_type must have fired ACTIVE at least
    //    once, given a fair chance to do so. Empirical proxy for "is there a live insert path
    //    that actually checks SETUP_STATUS for this type" -- avoids maintaining a hand-written
    //    map from setup_type to insert path, which would itself be exactly the kind of
    //    hand-maintained list this check exists to make unnecessary. See
    //    docs/PROMOTION_PIPELINE_STRUCTURAL_FIX_SPEC.md for the full design rationale.
    console.log('\n[20] Reachability: ACTIVE/PROMOTE-rated setup_types can actually fire ACTIVE');
    {
      const { rows: firstPromoted } = await client.query(`
        SELECT signal_name, MIN(run_date) as first_active_date
        FROM performance_audit
        WHERE signal_type='SETUP_STATUS' AND recommendation IN ('ACTIVE','PROMOTE')
        GROUP BY signal_name
        HAVING MIN(run_date) <= CURRENT_DATE - 30
      `);
      const { rows: latestStatus } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name, recommendation
        FROM performance_audit WHERE signal_type='SETUP_STATUS'
        ORDER BY signal_name, run_date DESC
      `);
      const currentlyActive = new Map(latestStatus.map(r => [r.signal_name, r.recommendation]));
      const { rows: everFired } = await client.query(`
        SELECT DISTINCT setup_type FROM active_setups WHERE origin_status = 'ACTIVE'
      `);
      const everFiredSet = new Set(everFired.map(r => r.setup_type));
      // A SETUP_STATUS signal_name can be a POOLED family name (e.g. 'MOMENTUM_60m_60m_TREND',
      // no _LONG/_SHORT suffix) while the real fired setup_type carries a directional suffix
      // (found via DeepSeek QA of the promotion-pipeline structural fix, 2026-08-16) -- an exact
      // string match would report a permanent false positive for any such family even once it's
      // genuinely firing. Generic, no hand-maintained family list: also treat a signal_name as
      // "fired" if any real fired setup_type starts with `${signal_name}_`.
      const hasFiredPooled = (signalName) => everFiredSet.has(signalName)
        || [...everFiredSet].some(t => t.startsWith(`${signalName}_`));
      const stuck = firstPromoted
        .filter(r => ['ACTIVE', 'PROMOTE'].includes(currentlyActive.get(r.signal_name)))
        .filter(r => !hasFiredPooled(r.signal_name));
      // STOP_SWEEP_LONG/SHORT are DELIBERATELY excluded from the shadowCandidates live-eligibility
      // flip (acd.js's STOP_SWEEP_PAUSED Set) despite being rated ACTIVE -- OPEN_DECISION
      // stop_sweep_long_calibrated_target_pause_or_keep, resolved to PAUSED 2026-08-05 pending a
      // target re-calibration. They will WARN here forever until that decision resolves -- that's
      // expected, not a bug to re-investigate (found via DeepSeek 2nd-pass QA of the
      // promotion-pipeline structural fix, 2026-08-16: the first version of this check gave no
      // hint that these two are a known, deliberate exception).
      const KNOWN_PAUSED_TYPES = new Set(['STOP_SWEEP_LONG', 'STOP_SWEEP_SHORT']);
      if (stuck.length === 0) {
        ok('every setup_type rated ACTIVE/PROMOTE for 30+ days has fired origin_status=ACTIVE at least once');
      } else {
        for (const r of stuck) {
          const pausedNote = KNOWN_PAUSED_TYPES.has(r.signal_name)
            ? ` -- KNOWN, EXPECTED: deliberately paused via acd.js's STOP_SWEEP_PAUSED Set (OPEN_DECISION stop_sweep_long_calibrated_target_pause_or_keep, PAUSED since 2026-08-05), not a bug.`
            : '';
          warn(`${r.signal_name}: rated ${currentlyActive.get(r.signal_name)} since ${r.first_active_date} (30+ days ago) but has ZERO real origin_status='ACTIVE' rows ever -- likely reachable only through a hardcoded-SHADOW insert path (see shadowCandidates in acd.js) or a poller gate that never checks SETUP_STATUS at all. Verify which insert path this setup_type actually goes through before assuming it's a bug -- a genuinely rare-touch level can also produce this pattern.${pausedNote}`);
        }
      }
    }

    // ── 21. Trail-mechanism variants must not silently fall back to fixed-stop/fixed-target ──
    // Resolves OPEN_DECISION acd_trail_null_fallback_silent (2026-08-03, confirmed happening
    // 2026-08-04): a CONDITIONAL_VARIANTS entry with trailSignalName reads its calibrated trail
    // width from a BREAKEVEN_TRAIL_TEST performance_audit row at insert time (acd.js's
    // isTrailMechanism/runnerTrailWidth block and its audit-branch mirror). When no calibration
    // row exists yet, runner_trail_width silently resolves to null and the row is treated as an
    // ordinary fixed-stop/fixed-target trade under a _TRAIL label -- no error, no log, nothing
    // to catch it. This check surfaces exactly that: any trail-mechanism setup_type with real
    // recent fires where runner_trail_width was never populated.
    console.log('\n[21] Trail-mechanism variants have a populated runner_trail_width on real fires');
    {
      const trailTypes = Object.entries(CONDITIONAL_VARIANTS)
        .filter(([, v]) => v.trailSignalName)
        .map(([type]) => type);
      if (trailTypes.length === 0) {
        ok('no CONDITIONAL_VARIANTS entries carry a trailSignalName');
      } else {
        const { rows: trailFires } = await client.query(`
          SELECT setup_type,
                 COUNT(*) as n,
                 COUNT(*) FILTER (WHERE runner_trail_width IS NULL) as null_width_n
          FROM active_setups
          WHERE setup_type = ANY($1) AND origin_status IN ('ACTIVE','SHADOW')
            AND fired_at >= CURRENT_DATE - 14
          GROUP BY setup_type
        `, [trailTypes]);
        const withGap = trailFires.filter(r => parseInt(r.null_width_n) > 0);
        if (trailFires.length === 0) {
          ok('no real trail-mechanism fires in the last 14 days to check');
        } else if (withGap.length === 0) {
          ok(`all ${trailFires.length} trail-mechanism type(s) with real fires in the last 14 days had runner_trail_width populated`);
        } else {
          for (const r of withGap) {
            warn(`${r.setup_type}: ${r.null_width_n}/${r.n} real fires in the last 14 days had runner_trail_width IS NULL -- silently downgraded to a plain fixed-stop/fixed-target trade instead of the breakeven-trail mechanism. Check whether its BREAKEVEN_TRAIL_TEST calibration row (signal_name='${CONDITIONAL_VARIANTS[r.setup_type]?.trailSignalName}') is missing or stale -- run scripts/backtest_breakeven_trail.mjs.`);
          }
        }
      }
    }

    // ── 22. origin_status matches status for every still-unresolved row ──────────
    // Resolves OPEN_DECISION no_invariant_checks_origin_status_matches_status_at_insert
    // (2026-08-09). origin_status is immutable-at-insert and bound to whatever `status` was
    // AT THAT MOMENT (always 'ACTIVE' or 'SHADOW' for a freshly-inserted row -- see
    // ARCHITECTURE.md's origin_status entry) -- but status itself later transitions to
    // RESOLVED/EXPIRED/etc as the setup resolves, so a resolved row's status no longer tells
    // us what it was at insert time. A static SQL-text parser (grep every INSERT INTO
    // active_setups block, verify origin_status/status bind to the same literal) was
    // considered and rejected as too fragile (see the decision's own text) -- this uses real
    // data instead: any row STILL in status IN ('ACTIVE','SHADOW') has not been touched since
    // insert, so origin_status must equal status exactly, no exceptions. Directly catches the
    // feared regression (a new/edited INSERT site that sets status but forgets origin_status,
    // or sets them to different values) the moment it fires live, without needing to parse SQL
    // text at all. Population can legitimately be 0 depending on when this runs (this table
    // cycles fast -- most setups resolve same-session) -- that's an honest "nothing to check
    // right now," not a check that silently does nothing.
    console.log('\n[22] origin_status matches status for every still-unresolved row');
    {
      const { rows: mismatches } = await client.query(`
        SELECT id, setup_type, status, origin_status, fired_at::text as fired_at
        FROM active_setups WHERE status IN ('ACTIVE','SHADOW') AND origin_status IS DISTINCT FROM status
        ORDER BY fired_at DESC LIMIT 20
      `);
      const { rows: [{ n: unresolvedN }] } = await client.query(`
        SELECT COUNT(*) as n FROM active_setups WHERE status IN ('ACTIVE','SHADOW')
      `);
      if (parseInt(unresolvedN) === 0) {
        ok('no currently-unresolved (ACTIVE/SHADOW) rows to check right now -- not a failure, just nothing in flight at this moment');
      } else if (mismatches.length === 0) {
        ok(`all ${unresolvedN} currently-unresolved row(s) have origin_status matching status`);
      } else {
        for (const r of mismatches) {
          fail(`active_setups id=${r.id} (${r.setup_type}, fired_at=${r.fired_at}): status='${r.status}' but origin_status='${r.origin_status}' -- these must match for any still-unresolved row. Find the INSERT site that produced this and check it binds origin_status to the same value as status.`);
        }
      }
    }

    console.log('\n[23] OPTIMAL_STOP implausible-skew candidates flagged with no prior baseline');
    {
      // Added 2026-08-30 alongside applyCircuitBreaker()'s new plausibility gate (DeepSeek code
      // review, same day): the gate's two "no prior to compare against" paths still ACCEPT an
      // implausibly-skewed first-ever calibration, just with a console.error at write time --
      // which only reaches whoever happens to read that day's cron stdout, not the "impossible to
      // miss every session" standard this codebase holds itself to elsewhere (DTM_WATCH, SHADOW
      // VALIDATION, etc.). This check makes those flags durable instead of scrolling into a log.
      const { rows } = await client.query(`
        SELECT DISTINCT ON (signal_name) signal_name, notes::jsonb as notes
        FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
          AND notes IS NOT NULL AND notes ~ '^\\s*\\{.*\\}\\s*$' AND notes !~ '\\}\\s*\\{'
        ORDER BY signal_name, run_date DESC
      `);
      const flagged = rows.filter(r => {
        const reason = r.notes?.circuitBreaker?.reason;
        return reason === 'no_prior_baseline_implausible_skew_flagged' || reason === 'prior_was_placeholder_implausible_skew_flagged';
      });
      if (flagged.length === 0) {
        ok('no setup_type currently carries an unresolved implausible-skew-with-no-prior flag');
      } else {
        for (const r of flagged) {
          const cb = r.notes.circuitBreaker;
          warn(`${r.signal_name}: accepted a first-ever/post-placeholder calibration at an implausible skew (${cb.attemptedSkew}x vs cutoff ${cb.plausibleSkewCutoff}x, reason=${cb.reason}) because there was no prior value to freeze back to. Re-derive by hand or wait for more real N to produce a saner candidate -- don't let this sit past one recheck.`);
        }
      }
    }

    // ── Summary ──────────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(50)}`);
    if (failures === 0 && warnings === 0) {
      console.log('ALL INVARIANTS PASS\n');
    } else {
      if (failures > 0) console.log(`${failures} FAILURE(S) — fix before deploying`);
      if (warnings > 0) console.log(`${warnings} WARNING(S) — review`);
      console.log('');
    }

    // Self-alert on every run (cron or manual) so a new FAIL/WARN can't sit silently in a
    // log file nobody reads -- see the ALERTS_FILE comment near the top for why this was added.
    if (failures > 0 || warnings > 0) {
      const ts = nowET();
      const lines = [
        ...failMsgs.map(m => `[${ts} ET] [INVARIANT_FAIL] ${m}\n`),
        ...warnMsgs.map(m => `[${ts} ET] [INVARIANT_WARN] ${m}\n`),
      ];
      fs.appendFileSync(ALERTS_FILE, lines.join(''));
      console.log(`⚠ ${lines.length} alert line(s) written to scratch/gemini_alerts.txt`);
    }

  } finally {
    client.release();
    await pool.end();
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
