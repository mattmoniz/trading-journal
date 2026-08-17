// One-off investigative script (not scheduled) for the 2026-08-12 "how do we diagnose a
// poor performance day" thread. Two parts:
//   1. Worst real (origin_status='ACTIVE') trades ranked by actual_pnl, with the context
//      needed to tell variance-loss from structural-loss (setup_type, sizeMultiplier,
//      day_type, MAE/MFE, bar6_checkpoint).
//   2. MAE/MFE integrity check: analyze_execution_efficiency.mjs and every downstream
//      consumer (OPTIMAL_STOP, bar6_checkpoint, this script's own Part 1) trust the STORED
//      mae_points/mfe_points columns as ground truth. This independently re-derives them
//      from the real 1-min bars via the canonical replayBars()/computeMaeMfe()
//      (server/services/maeMfeReplay.js -- same function the live resolution path uses,
//      per CLAUDE.md's "export the real function" rule) and diffs against the stored
//      value, on real (ACTIVE/SHADOW) rows only.
//
// Run: node scripts/audit_worst_trades_maemfe.mjs

import { query } from '../server/db.js';
import { computeMaeMfe } from '../server/services/maeMfeReplay.js';

const MISMATCH_TOLERANCE_PTS = 0.5; // float/rounding slack, not a real discrepancy below this

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

async function main() {
  console.log('=== Part 1: Worst real trades (origin_status=ACTIVE, resolved) ===\n');

  const worstRes = await query(`
    SELECT a.setup_type, a.trade_date::text, a.fired_at, a.resolution, a.actual_pnl::float,
           a.mae_points::float, a.mfe_points::float, a.size_multiplier::float,
           a.entry_zone_low::float, a.entry_zone_high::float, a.stop_level::float, a.t1_level::float,
           a.bar6_checkpoint, a.confluence_score_at_detection, d.day_type
    FROM active_setups a
    LEFT JOIN acd_daily_log d ON a.trade_date = d.trade_date
    WHERE a.origin_status = 'ACTIVE' AND a.status = 'RESOLVED' AND a.actual_pnl IS NOT NULL
    ORDER BY a.actual_pnl ASC
    LIMIT 20
  `);

  for (const r of worstRes.rows) {
    console.log(`  $${r.actual_pnl.toFixed(2).padStart(8)}  ${r.trade_date}  ${r.setup_type.padEnd(30)} ` +
      `res=${(r.resolution ?? '?').padEnd(11)} dayType=${(r.day_type ?? '?').padEnd(10)} ` +
      `mult=${r.size_multiplier ?? '?'} mae=${r.mae_points ?? '?'}pt mfe=${r.mfe_points ?? '?'}pt ` +
      `bar6=${r.bar6_checkpoint ?? '—'} confl=${r.confluence_score_at_detection ?? 0}`);
  }

  const realized = worstRes.rows.map(r => r.actual_pnl);
  console.log(`\n  Worst-20 mean: $${mean(realized)?.toFixed(2)}  Worst single: $${realized[0]?.toFixed(2)}`);

  // Setup_type concentration among the worst 20 -- is it spread out or one repeat offender?
  const bySetup = {};
  for (const r of worstRes.rows) bySetup[r.setup_type] = (bySetup[r.setup_type] ?? 0) + 1;
  console.log('  Setup_type concentration in worst-20:', JSON.stringify(bySetup));

  console.log('\n=== Part 2: MAE/MFE integrity check (stored vs re-derived from real bars) ===\n');

  const realRows = await query(`
    SELECT setup_type, trade_date::text, fired_at, entry_zone_low::float, entry_zone_high::float,
           stop_level::float, t1_level::float, mae_points::float, mfe_points::float,
           resolution, replay_resolution, actual_pnl::float
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND status = 'RESOLVED'
      AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
  `);
  console.log(`  Checking ${realRows.rows.length} real resolved rows with stored MAE/MFE...\n`);

  let checked = 0, skippedNoData = 0, mismatches = [];
  const maeDiffs = [], mfeDiffs = [];

  for (const r of realRows.rows) {
    const fresh = await computeMaeMfe(query, r);
    if (!fresh) { skippedNoData++; continue; }
    checked++;
    const maeDiff = fresh.mae - r.mae_points;
    const mfeDiff = fresh.mfe - r.mfe_points;
    maeDiffs.push(maeDiff);
    mfeDiffs.push(mfeDiff);
    if (Math.abs(maeDiff) > MISMATCH_TOLERANCE_PTS || Math.abs(mfeDiff) > MISMATCH_TOLERANCE_PTS) {
      mismatches.push({ ...r, freshMae: fresh.mae, freshMfe: fresh.mfe, maeDiff, mfeDiff, freshResolution: fresh.replayResolution });
    }
  }

  console.log(`  Checked: ${checked}  Skipped (no bar data): ${skippedNoData}  Mismatches (>${MISMATCH_TOLERANCE_PTS}pt): ${mismatches.length}\n`);
  console.log(`  MAE diff: mean=${mean(maeDiffs)?.toFixed(3)}pt  |max|=${Math.max(...maeDiffs.map(Math.abs)).toFixed(2)}pt`);
  console.log(`  MFE diff: mean=${mean(mfeDiffs)?.toFixed(3)}pt  |max|=${Math.max(...mfeDiffs.map(Math.abs)).toFixed(2)}pt\n`);

  if (mismatches.length) {
    console.log('  --- Mismatches (worst 15 by |maeDiff|+|mfeDiff|) ---');
    mismatches.sort((a, b) => (Math.abs(b.maeDiff) + Math.abs(b.mfeDiff)) - (Math.abs(a.maeDiff) + Math.abs(a.mfeDiff)));
    for (const m of mismatches.slice(0, 15)) {
      console.log(`    ${m.trade_date} ${m.setup_type.padEnd(30)} stored(mae=${m.mae_points},mfe=${m.mfe_points}) ` +
        `fresh(mae=${m.freshMae.toFixed(1)},mfe=${m.freshMfe.toFixed(1)}) diff(mae=${m.maeDiff.toFixed(1)},mfe=${m.mfeDiff.toFixed(1)}) ` +
        `storedRes=${m.resolution} storedReplayRes=${m.replay_resolution ?? '—'} freshRes=${m.freshResolution}`);
    }
  } else {
    console.log('  No mismatches beyond tolerance -- stored MAE/MFE matches a fresh bar-by-bar re-derivation.');
  }

  // Cross-check: are any of the worst-20 trades from Part 1 among the mismatches?
  const worstDates = new Set(worstRes.rows.map(r => `${r.trade_date}|${r.setup_type}`));
  const worstMismatches = mismatches.filter(m => worstDates.has(`${m.trade_date}|${m.setup_type}`));
  console.log(`\n  Of the worst-20 trades from Part 1, ${worstMismatches.length} have a MAE/MFE mismatch.`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
