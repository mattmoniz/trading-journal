// =============================================================================
// data_sanity_audit.mjs — standing check for the class of bug found repeatedly
// 2026-07-17: physically-impossible values and constants that should be uniform but
// silently aren't. Every check below exists because a real, previously-undetected bug
// of exactly that shape was found manually this session (see docs/OPEN_THREADS.md):
//   - MAE/MFE ES-symbol contamination: 430 rows with "11,000+ point" excursions,
//     physically impossible for NQ, sitting undetected since the underlying bug was
//     introduced (no one had re-derived these numbers from scratch until this session).
//   - update_optimal_stops.mjs's DEFAULT_DPP=5: defended by a comment claiming a
//     "verified bimodal $5/$2 split" that was false -- every setup_type actually
//     resolves to the same ~$2/pt, uniform, not bimodal.
// This script institutionalizes the kind of skeptical re-derivation that caught both --
// run it periodically (recommended: weekly, alongside run_weekly_backtests.sh) so the
// NEXT instance of this bug class gets caught by a standing check instead of requiring
// another multi-hour manual session.
//
// Exit code 0 = clean. Exit code 1 = at least one anomaly found (for cron/CI use).
// =============================================================================

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const MIN_N = 20; // CLAUDE.md hard floor -- don't flag a setup_type on thin data
let anomalyCount = 0;

function flag(msg) {
  console.log(`  🔴 ${msg}`);
  anomalyCount++;
}
function ok(msg) {
  console.log(`  ✅ ${msg}`);
}

console.log('='.repeat(80));
console.log('DATA SANITY AUDIT —', new Date().toISOString());
console.log('='.repeat(80));

// ---------------------------------------------------------------------------
// Check 1: MAE/MFE outliers, self-calibrating (no hardcoded point threshold).
// Flags any value more than 10x the table's own p95 -- catches the ES-contamination
// shape (a handful of values orders of magnitude beyond everything else) without
// hardcoding what "too big" means, since a genuine NQ excursion ceiling isn't a fixed
// number and shouldn't be guessed.
// ---------------------------------------------------------------------------
console.log('\n[1] MAE/MFE outlier check (self-calibrating, 10x p95)');
{
  const p95Row = await query(`
    SELECT
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY mae_points) as p95_mae,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY mfe_points) as p95_mfe
    FROM active_setups WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL
  `);
  const { p95_mae, p95_mfe } = p95Row.rows[0];
  const maeCeiling = p95_mae * 10;
  const mfeCeiling = p95_mfe * 10;
  const bad = await query(`
    SELECT setup_type, COUNT(*) as n, MAX(mae_points) as max_mae, MAX(mfe_points) as max_mfe
    FROM active_setups
    WHERE mae_points > $1 OR mfe_points > $2
    GROUP BY setup_type ORDER BY n DESC
  `, [maeCeiling, mfeCeiling]);
  if (bad.rows.length === 0) {
    ok(`No MAE/MFE values exceed 10x p95 (ceiling: MAE>${maeCeiling.toFixed(0)}pt, MFE>${mfeCeiling.toFixed(0)}pt)`);
  } else {
    for (const row of bad.rows) {
      flag(`${row.setup_type}: N=${row.n} rows with MAE/MFE beyond 10x p95 (max MAE=${row.max_mae}, max MFE=${row.max_mfe}) — check for symbol contamination or a computation bug, same shape as the 2026-07-17 ES-contamination incident`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: implied $/pt uniformity across setup_types, compared against the canonical
// LIVE_INSTRUMENT constant (not a self-derived threshold -- this is a data-integrity
// check against a known physical fact already established as ground truth elsewhere in
// this codebase, not a trading decision threshold, so comparing against the constant
// directly is consistent with CLAUDE.md's own P&L hard rule, not a violation of the
// separate no-static-thresholds rule).
// ---------------------------------------------------------------------------
console.log(`\n[2] Implied $/pt uniformity check (expected: $${LIVE_INSTRUMENT.dollarsPerPoint}/pt, MNQ)`);
{
  const rows = await query(`
    SELECT setup_type, n, stop_dpp FROM (
      SELECT setup_type,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(entry_zone_low - stop_level), 0))
          FILTER (WHERE replay_resolution = 'STOP_HIT') AS stop_dpp,
        COUNT(*) FILTER (WHERE replay_resolution = 'STOP_HIT') AS n
      FROM active_setups
      WHERE status='RESOLVED' AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
        AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
      GROUP BY setup_type
    ) x WHERE n >= $1
  `, [MIN_N]);
  const expected = LIVE_INSTRUMENT.dollarsPerPoint;
  const tolerance = 0.10; // ±10% -- generous enough to absorb the $1 flat commission's
  // effect on shorter-stop setup_types, tight enough to catch a real wrong constant
  // (the actual DEFAULT_DPP=5 bug was 150% off, not 10%).
  const bad = rows.rows.filter(r => Math.abs(+r.stop_dpp - expected) / expected > tolerance);
  if (bad.length === 0) {
    ok(`All ${rows.rows.length} setup_types with N>=${MIN_N} STOP_HIT trades resolve to ~$${expected}/pt (within ±${tolerance * 100}%)`);
  } else {
    for (const row of bad) {
      flag(`${row.setup_type}: implied $/pt = $${(+row.stop_dpp).toFixed(2)} (N=${row.n}), expected ~$${expected} — check for a wrong $/pt constant somewhere in this type's calibration path, same shape as the 2026-07-17 DEFAULT_DPP=5 incident`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3: price_bars_primary symbol distribution -- alert on any symbol beyond the
// established set. The ES-contamination bug's root cause was a one-off ES data batch
// existing in this table at all; this check would have caught it immediately, before
// any downstream MAE/MFE computation ever touched it.
// ---------------------------------------------------------------------------
console.log('\n[3] price_bars_primary symbol check');
{
  const KNOWN_SYMBOLS = new Set(['NQ']); // the only symbol any live resolution path should model; see instruments.js
  const r = await query(`SELECT symbol, COUNT(*) as n, MIN(ts::date) as min_d, MAX(ts::date) as max_d FROM price_bars_primary GROUP BY symbol`);
  const unexpected = r.rows.filter(row => !KNOWN_SYMBOLS.has(row.symbol));
  if (unexpected.length === 0) {
    ok(`Only known symbol(s) present: ${r.rows.map(row => row.symbol).join(', ')}`);
  } else {
    for (const row of unexpected) {
      flag(`Unexpected symbol '${row.symbol}' in price_bars_primary: ${row.n} rows, ${row.min_d} to ${row.max_d} — any query without an explicit symbol='NQ' filter over this date range will silently mix instruments, same root cause as the 2026-07-17 ES-contamination incident`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 4: basic bounds sanity on performance_audit -- win_rate must be a genuinely
// impossible value (negative, or >100) to flag, NOT just outside [0,1]. Found while
// building this check (2026-07-17): performance_audit.win_rate is NOT uniformly scaled
// -- most signal_types store it as a 0-1 decimal, but RESEARCH_CLAIM and
// LEVEL_FADE_AUDIT store it as a 0-100 percentage in the SAME column. That's a real,
// separate SSOT inconsistency worth knowing about (flagged below as informational, not
// as an anomaly -- fixing the underlying unit mismatch is out of scope for this check),
// but it means "outside [0,1]" alone produces false positives. Only a value that's
// impossible under BOTH conventions (negative, or >100) is a genuine bounds violation.
// sample_size must be non-negative under any convention.
// ---------------------------------------------------------------------------
console.log('\n[4] performance_audit bounds check');
{
  const r = await query(`
    SELECT signal_type, signal_name, run_date, win_rate, sample_size
    FROM performance_audit
    WHERE (win_rate IS NOT NULL AND (win_rate < 0 OR win_rate > 100))
       OR (sample_size IS NOT NULL AND sample_size < 0)
    ORDER BY run_date DESC LIMIT 20
  `);
  if (r.rows.length === 0) {
    ok('No genuinely impossible win_rate (negative or >100) or negative sample_size found');
  } else {
    for (const row of r.rows) {
      flag(`${row.signal_type}/${row.signal_name} (${row.run_date}): win_rate=${row.win_rate}, sample_size=${row.sample_size} — impossible under any scaling convention`);
    }
  }
  const mixedScale = await query(`
    SELECT DISTINCT signal_type FROM performance_audit
    WHERE win_rate IS NOT NULL AND win_rate > 1 AND win_rate <= 100
  `);
  if (mixedScale.rows.length > 0) {
    console.log(`  ℹ️  INFORMATIONAL (not an anomaly, a known inconsistency): ${mixedScale.rows.map(r => r.signal_type).join(', ')} store win_rate as 0-100 percentage while most other signal_types use 0-1 decimal, in the same column. Not fixed as part of this check -- be aware when comparing win_rate across signal_types.`);
  }
}

// ---------------------------------------------------------------------------
// Check 5: multi-day bar-data gaps in price_bars_primary. Found 2026-07-23 while auditing
// a Gemini-authored "400pt move" ZigZag detector: 3 gaps of exactly 1470.8h (~61 days) —
// 2024-09-20→2024-11-20, 2024-12-20→2025-02-19, 2025-03-21→2025-05-21 — plus 1 shorter one
// (224.6h) with NO real bars at all in between. A pivot/trend detector that spans one of
// these void periods reads the price difference across the gap as a continuous, real
// "move" — 6 of 28 candidate "≥400pt moves" in that analysis turned out to span an
// abnormal gap (3 of those 6 were the massive ~61-day voids; the underlying finding
// survived once excluded, but only because it happened to be checked — nothing before
// this flagged the gaps existed at all). Self-calibrating (10x p99), same convention as
// Check 1 — a static hour count was tried first and produced ~80 false positives on
// perfectly normal 72-96h weekend/holiday closures that exist throughout the older
// history (p95=72h, p99=96h observed); real anomalies (224.6h, 1470.8h) sit far beyond
// that with a clean separation, so this only fires on genuine multi-week+ voids.
// ---------------------------------------------------------------------------
console.log('\n[5] price_bars_primary multi-day gap check (NQ)');
{
  const allGaps = await query(`
    WITH b AS (SELECT ts, LEAD(ts) OVER (ORDER BY ts) as next_ts FROM price_bars_primary WHERE symbol='NQ')
    SELECT EXTRACT(EPOCH FROM (next_ts - ts))/3600.0 as gap_hours
    FROM b WHERE next_ts IS NOT NULL AND next_ts - ts > interval '30 minutes'
    ORDER BY gap_hours
  `);
  const hours = allGaps.rows.map(r => Number(r.gap_hours));
  const p99Idx = Math.floor(hours.length * 0.99);
  const p99 = hours[Math.min(p99Idx, hours.length - 1)] ?? 0;
  const cutoffHours = Math.max(p99 * 10, 120); // floor of 120h in case history is too short/uniform for p99 to be meaningful

  const r = await query(`
    WITH b AS (
      SELECT ts, LEAD(ts) OVER (ORDER BY ts) as next_ts
      FROM price_bars_primary WHERE symbol='NQ'
    )
    SELECT ts as gap_start, next_ts as gap_end, EXTRACT(EPOCH FROM (next_ts - ts))/3600.0 as gap_hours
    FROM b WHERE next_ts - ts > ($1 || ' hours')::interval
    ORDER BY gap_hours DESC
  `, [cutoffHours]);
  if (r.rows.length === 0) {
    ok(`No gaps beyond ${cutoffHours.toFixed(0)}h (10x p99=${p99.toFixed(1)}h) found in NQ bar history`);
  } else {
    for (const row of r.rows) {
      flag(`Gap ${row.gap_start.toISOString()} → ${row.gap_end.toISOString()} (${Number(row.gap_hours).toFixed(1)}h, no bars at all in between, vs a normal-closure ceiling of ~${cutoffHours.toFixed(0)}h) — any trend/move/regime detector scanning across this window will silently bridge the void and misread it as continuous price action`);
    }
  }
}

console.log('\n' + '='.repeat(80));
console.log(anomalyCount === 0 ? '✅ CLEAN — no anomalies found.' : `🔴 ${anomalyCount} anomaly group(s) found — review above before trusting related figures.`);
console.log('='.repeat(80));

process.exit(anomalyCount === 0 ? 0 : 1);
