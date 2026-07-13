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
 */

import pg from 'pg';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { inferDirection, CONDITIONAL_VARIANTS, CONTEXTUAL_DIRECTION_TYPES } from '../server/config/setupTypes.js';

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
