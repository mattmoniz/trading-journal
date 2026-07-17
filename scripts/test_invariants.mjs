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
 */

import pg from 'pg';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { inferDirection, CONDITIONAL_VARIANTS, CONTEXTUAL_DIRECTION_TYPES } from '../server/config/setupTypes.js';
import { sweepOptimalStopAndTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';

config();
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

let failures = 0;
let warnings = 0;

const fail  = (msg) => { console.log(`  FAIL  ${msg}`); failures++; };
const warn  = (msg) => { console.log(`  WARN  ${msg}`); warnings++; };
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

    for (const [variantType, meta] of Object.entries(CONDITIONAL_VARIANTS)) {
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
    const orphaned = [...allOptTypes].filter(t => !allSsTypes.has(t));

    if (orphaned.length === 0) {
      ok(`all ${allOptTypes.size} OPTIMAL_STOP types have a SETUP_STATUS row`);
    } else {
      for (const t of orphaned) {
        warn(`${t}: has OPTIMAL_STOP but no SETUP_STATUS — stale calibration data`);
      }
    }

    // ── 5. ev_per_trade actually matches a fresh re-simulation of its own stop/target ──
    console.log('\n[5] OPTIMAL_STOP.ev_per_trade matches its own optimal_stop/optimal_target');

    const latestOptRows = await client.query(`
      SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target, ev_per_trade
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
      SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float
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
      const { stopDpp, targetDpp } = dppByType[row.signal_name] || { stopDpp: DEFAULT_DPP, targetDpp: DEFAULT_DPP };
      const stored = { stop: parseFloat(row.optimal_stop), target: parseFloat(row.optimal_target), ev: parseFloat(row.ev_per_trade) };

      const maeCandidates = [
        { value: stats.p25_mae, pct: 0.25 }, { value: stats.p40_mae, pct: 0.40 },
        { value: stats.p50_mae, pct: 0.50 }, { value: stats.p60_mae, pct: 0.60 },
        { value: stats.p75_mae, pct: 0.75 },
      ].map(c => ({ ...c, value: parseFloat(c.value) })).filter(c => !isNaN(c.value) && c.value > 0);
      const p75mfe = Math.round(parseFloat(stats.p75_mfe) || 35);
      const swept = sweepOptimalStopAndTarget(trades, maeCandidates, p75mfe, stopDpp, targetDpp);
      evChecked++;

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

    // ── Summary ──────────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(50)}`);
    if (failures === 0 && warnings === 0) {
      console.log('ALL INVARIANTS PASS\n');
    } else {
      if (failures > 0) console.log(`${failures} FAILURE(S) — fix before deploying`);
      if (warnings > 0) console.log(`${warnings} WARNING(S) — review`);
      console.log('');
    }

  } finally {
    client.release();
    await pool.end();
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
