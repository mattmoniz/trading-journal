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
 */

import pg from 'pg';
import fs, { existsSync } from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { inferDirection, CONDITIONAL_VARIANTS, CONTEXTUAL_DIRECTION_TYPES, UNCALIBRATED_SHADOW_TYPES } from '../server/config/setupTypes.js';
import { sweepOptimalStopAndTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';
import { computeCorrectedTarget } from '../server/services/targetCalibrationService.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

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
          fail(`${variantType}: no BREAKEVEN_TRAIL_TEST row '${meta.trailSignalName}' — run ${meta.backtestScript}`);
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

    let evChecked = 0, evMismatches = 0;
    for (const row of latestOptRows.rows) {
      const trades = tradesByType[row.signal_name];
      const stats = statsByType[row.signal_name];
      if (!trades || trades.length < 20 || !stats) continue; // same MIN_N floor as update_optimal_stops.mjs
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

      const maeCandidates = [
        { value: stats.p25_mae, pct: 0.25 }, { value: stats.p40_mae, pct: 0.40 },
        { value: stats.p50_mae, pct: 0.50 }, { value: stats.p60_mae, pct: 0.60 },
        { value: stats.p75_mae, pct: 0.75 },
      ].map(c => ({ ...c, value: parseFloat(c.value) })).filter(c => !isNaN(c.value) && c.value > 0);
      const p75mfe = Math.round(parseFloat(stats.p75_mfe) || 35);
      const swept = sweepOptimalStopAndTarget(trades, maeCandidates, p75mfe, stopDpp, targetDpp);
      evChecked++;

      // 2026-07-19: if the stored row was produced via the corrected-resim path, re-derive
      // it via computeCorrectedTarget() instead of trusting the EV-sweep result alone --
      // matches update_optimal_stops.mjs's own two-step process exactly (EV-sweep first to
      // get the (stop, anchor-target) pair, THEN the corrected-resim override on top).
      let usedNotes = null;
      try { usedNotes = JSON.parse(row.notes); } catch { /* not JSON / no notes -- normal case */ }
      if (usedNotes?.method === 'corrected-resim') {
        if (!swept) {
          fail(`${row.signal_name}: stored notes claim method='corrected-resim' but a fresh EV-sweep returns null (no valid stop/target pair) -- the corrected-resim override should never have been reachable without a swept base to anchor from`);
          evMismatches++;
          continue;
        }
        const direction = inferDirection(row.signal_name);
        const expandedTrades = tradesByTypeExpanded[row.signal_name] || [];
        const corrected = direction ? computeCorrectedTarget({
          trades: expandedTrades, allBars, stop: swept.stop, oldTarget: swept.target,
          long: direction === 'LONG', pnlPerPoint: DEFAULT_DPP, commission: LIVE_INSTRUMENT.commissionPerRoundTrip,
        }) : { exclusionReason: 'no_direction' };
        if (corrected.exclusionReason) {
          fail(`${row.signal_name}: stored notes claim method='corrected-resim' but a fresh re-derivation now excludes it (${corrected.exclusionReason}) -- either the row is stale (re-run update_optimal_stops.mjs) or the override logic has drifted`);
          evMismatches++;
        } else {
          const evOk = closeEnough(stored.ev, corrected.fullEv);
          const targetOk = stored.target === corrected.bestTarget;
          const stopOk = stored.stop === swept.stop;
          if (!evOk || !targetOk || !stopOk) {
            fail(`${row.signal_name}: stored (corrected-resim) stop=${stored.stop}/target=${stored.target}/ev=$${stored.ev.toFixed(2)} but a fresh re-derivation gives stop=${swept.stop}/target=${corrected.bestTarget}/ev=$${corrected.fullEv.toFixed(2)}`);
            evMismatches++;
          }
        }
        continue;
      }

      if (swept) {
        // Sweep succeeded -- stored row must match the REAL sweep result exactly (small
        // tolerance only for trade-count drift since the OPTIMAL_STOP row was last written).
        const evOk = closeEnough(stored.ev, swept.ev);
        const targetOk = stored.target === swept.target;
        const stopOk = stored.stop === swept.stop;
        if (!evOk || !targetOk || !stopOk) {
          fail(`${row.signal_name}: stored stop=${stored.stop}/target=${stored.target}/ev=$${stored.ev.toFixed(2)} but a fresh sweep gives stop=${swept.stop}/target=${swept.target}/ev=$${swept.ev.toFixed(2)} — ev_per_trade (or the sweep itself) may have drifted from production (see docs/OPEN_THREADS.md, 2026-07-17)`);
          evMismatches++;
        }
      } else {
        // Thin-tail gate rejected every candidate -- the ONLY legitimate fallback: stop/
        // target = rounded p75_mae/p50_mfe, ev = raw AVG(actual_pnl). Verify against that
        // exact fallback, not a loose "matches something plausible" check.
        const rawAvg = parseFloat(stats.raw_avg);
        const evOk = closeEnough(stored.ev, rawAvg, 1, 0.02);
        if (!evOk) {
          fail(`${row.signal_name}: thin-tail fallback case (no sweep candidate had enough trades) but stored ev_per_trade=$${stored.ev.toFixed(2)} doesn't match the raw average $${rawAvg.toFixed(2)} it should have fallen back to — ev_per_trade's write path may have drifted (see docs/OPEN_THREADS.md, 2026-07-17)`);
          evMismatches++;
        }
      }
    }
    if (evChecked > 0 && evMismatches === 0) {
      ok(`all ${evChecked} OPTIMAL_STOP rows' ev_per_trade match a fresh re-simulation of their own stop/target`);
    } else if (evChecked === 0) {
      warn('no OPTIMAL_STOP rows had enough matching trade data to re-verify ev_per_trade this run');
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

    // ── 8. Live-fired stop/target actually matches current calibration ─────────────
    console.log('\n[8] Live-fired stop/target matches current OPTIMAL_STOP calibration');
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
        const { rows: optRows } = await client.query(`
          SELECT DISTINCT ON (signal_name) signal_name, optimal_stop::float as stop, optimal_target::float as target
          FROM performance_audit WHERE signal_type = 'OPTIMAL_STOP' AND signal_name = ANY($1)
          ORDER BY signal_name, run_date DESC
        `, [liveNames]);
        const optByName = Object.fromEntries(optRows.map(r => [r.signal_name, r]));

        let checkedCount = 0, mismatchCount = 0;
        for (const type of liveNames) {
          const opt = optByName[type];
          if (!opt || opt.stop == null || opt.target == null) continue; // check [2] already covers missing OPTIMAL_STOP rows

          const { rows: recent } = await client.query(`
            SELECT ABS(stop_level::float - COALESCE(entry_zone_high::float, entry_zone_low::float)) as stop_dist,
              ABS(t1_level::float - COALESCE(entry_zone_high::float, entry_zone_low::float)) as target_dist
            FROM active_setups
            WHERE setup_type = $1 AND origin_status IN ('ACTIVE','SHADOW')
              AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
            ORDER BY fired_at DESC LIMIT $2
          `, [type, RECENT_N]);
          if (recent.length < 3) continue; // too thin to draw a conclusion either way

          checkedCount++;
          // Require BOTH stop AND target to match -- "either one matches" is too lenient and
          // produces a real false negative: VWAP_MAGNET_LONG's hardcoded 30pt stop happened to
          // coincidentally equal its current calibrated stop (both 30), masking that its target
          // (hardcoded 20 vs calibrated 30) never matches at all. A genuinely-wired setup should
          // track BOTH legs of its own calibration, not just one by chance.
          const stopMatches = recent.some(r => Math.abs(r.stop_dist - opt.stop) <= TOLERANCE_PT);
          const targetMatches = recent.some(r => Math.abs(r.target_dist - opt.target) <= TOLERANCE_PT);
          if (!stopMatches || !targetMatches) {
            mismatchCount++;
            const sampleStops = [...new Set(recent.map(r => r.stop_dist))].slice(0, 3).join(',');
            const sampleTargets = [...new Set(recent.map(r => r.target_dist))].slice(0, 3).join(',');
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
            warn(`${type}: current calibration says stop=${opt.stop}/target=${opt.target}, but the ${mismatchedLeg} never matches across the last ${recent.length} real fired trades -- actual stop distances seen: ${sampleStops}, target distances: ${sampleTargets}.${caveat}`);
          }
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
      const weeklyCron = fs.readFileSync(path.resolve('scripts/run_weekly_backtests.sh'), 'utf8');
      const dailyCron = fs.readFileSync(path.resolve('scripts/run_daily_calibration.sh'), 'utf8');
      const scheduled = weeklyCron + dailyCron;

      // Detail goes to a dedicated scratch file, NOT one warn()/alert line per claim --
      // the historical backlog is large (~100+ pre-existing one-off scratch/pilot scripts,
      // most of them legitimately settled findings that don't need a standing recheck) and
      // dumping all of them into scratch/gemini_alerts.txt every run would drown out real
      // signal there. Only a single aggregate count enters the routine WARN/alert stream --
      // read the detail file when you actually want to triage the backlog, not every run.
      const unscheduled = [];
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
      }
      const detailFile = path.resolve('scratch/research_claim_unscheduled.txt');
      if (unscheduled.length === 0) {
        ok('every RESEARCH_CLAIM source script is wired into a recurring cron');
        if (existsSync(detailFile)) fs.unlinkSync(detailFile);
      } else {
        fs.writeFileSync(detailFile,
          `${unscheduled.length} RESEARCH_CLAIM source script(s) not found in run_weekly_backtests.sh or run_daily_calibration.sh, as of ${nowET()} ET.\n` +
          `Most of these are legitimately settled/rejected one-time findings that don't need a standing recheck -- this is a triage list, not a to-do list.\n` +
          `Only add a script to one of those two cron files if it's still an open/PROVISIONAL question that should keep re-checking itself as real data accumulates.\n\n` +
          unscheduled.join('\n') + '\n');
        warn(`${unscheduled.length} of ${seenSourceFiles.size} distinct RESEARCH_CLAIM source scripts are not wired into a recurring cron -- full list in ${detailFile} (not printed here individually, mostly expected for settled findings)`);
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
