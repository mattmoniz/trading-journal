#!/usr/bin/env node
// Rigor pass for scripts/sweep_ml_hyperparams.py's raw output (item 5, ML silo review).
// The Python sweep already ran 5 hyperparameter candidates through the REAL walk-forward
// logic (walkforward.py's run_walkforward_folds(), same method for every candidate
// including 'current' -- baseline computed the same way as the candidates, per this
// codebase's standing rule). This script does what that raw ranking table can't: per this
// codebase's own "the cell a grid search picks as best needs its own day-clustering/CI
// check" rule, a candidate that merely has the biggest raw TAKE P&L in one pass is not
// automatically trustworthy -- it needs the SAME day-blocked bootstrap CI + distinctDates
// floor + cluster-sibling collapse that gates every other CONFIRMED/PROVISIONAL claim in
// this codebase (matching recalibrate_ml_walkforward.mjs's own exact standard).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dayBlockedBootstrapCI, collapseClusterSiblings } from '../server/services/rigorDiagnostics.js';
import { ML_CLAIM_DISTINCT_DATES_FLOOR } from '../server/services/mlSiloService.js';
import { recordClaim } from './record_claim.mjs';
import { query } from '../server/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const RESULTS_PATH = path.join(REPO_ROOT, 'scratch', 'ml_hyperparams_sweep_results.json');

// Plateau tolerance, matching calibrate_step_trail_fraction.mjs's own convention exactly
// (same rationale: don't just take the single best-by-EV cell, prefer a candidate that's
// robustly on the plateau of good options -- a lone spike is much more likely to be noise).
const PLATEAU_TOLERANCE = 0.30;

async function main() {
  if (!fs.existsSync(RESULTS_PATH)) {
    console.log('No sweep results found -- run scripts/sweep_ml_hyperparams.py first.');
    process.exit(0);
  }
  const rows = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
  const byCandidate = new Map();
  for (const r of rows) {
    if (r.verdict !== 'TAKE') continue;
    if (!byCandidate.has(r.candidate)) byCandidate.set(r.candidate, []);
    byCandidate.get(r.candidate).push(r);
  }

  const results = [];
  for (const [candidate, takeRows] of byCandidate) {
    const events = collapseClusterSiblings(
      takeRows.map(r => ({ date: r.trade_date, pnl: r.actual_pnl, cluster_touch_id: r.cluster_touch_id })),
      { dateField: 'date', clusterField: 'cluster_touch_id' },
    );
    const distinctDates = new Set(takeRows.map(r => r.trade_date)).size;
    const ci = dayBlockedBootstrapCI(events, `ml_hyperparams_sweep_${candidate}`, { dateField: 'date', iters: 5000 });
    const excludesZero = ci.lo > 0 || ci.hi < 0;
    const n = takeRows.length;
    const totalPnl = takeRows.reduce((s, r) => s + r.actual_pnl, 0);
    const meanPnl = n ? totalPnl / n : 0;
    const winRate = n ? +(100 * takeRows.filter(r => r.actual_pnl > 0).length / n).toFixed(1) : null;
    results.push({
      candidate, n, totalPnl: +totalPnl.toFixed(2), meanPnl: +meanPnl.toFixed(2), winRate,
      distinctDates, clean: excludesZero && distinctDates >= ML_CLAIM_DISTINCT_DATES_FLOOR,
      excludesZero, ciLo: +ci.lo.toFixed(2), ciHi: +ci.hi.toFixed(2),
    });
  }

  results.sort((a, b) => b.meanPnl - a.meanPnl);
  console.log('\nCandidate                   N  distinctDates   meanPnl        CI            clean');
  for (const r of results) {
    console.log(
      `${r.candidate.padEnd(26)} ${String(r.n).padStart(4)} ${String(r.distinctDates).padStart(13)} `
      + `$${r.meanPnl.toFixed(2).padStart(8)}   [$${r.ciLo.toFixed(2)}, $${r.ciHi.toFixed(2)}]   ${r.clean ? 'CLEAN' : 'not clean'}`
    );
  }

  const current = results.find(r => r.candidate === 'current');
  if (!current) {
    console.log('\nNo "current" baseline in results -- cannot compare. Aborting without a decision.');
    process.exit(1);
  }

  // A candidate only counts as a real win if it (a) clears the SAME rigor bar 'current'
  // would need to clear (CI excludes zero AND distinctDates>=floor), and (b) beats
  // current's own meanPnl by more than noise -- the plateau tolerance, applied here as
  // "is current itself within tolerance of the best candidate," not just "did anything
  // numerically edge out current."
  const bestClean = results.filter(r => r.clean).sort((a, b) => b.meanPnl - a.meanPnl)[0];
  let winner = current;
  let reason = 'current is the only clean candidate, or no candidate beats it outside the plateau tolerance';

  if (bestClean && bestClean.candidate !== 'current') {
    const currentOnPlateau = current.clean && current.meanPnl >= bestClean.meanPnl * (1 - PLATEAU_TOLERANCE);
    if (!currentOnPlateau) {
      winner = bestClean;
      reason = `bestClean (${bestClean.candidate}) clears CI+distinctDates and current is NOT on its plateau (current meanPnl=$${current.meanPnl.toFixed(2)} vs bestClean=$${bestClean.meanPnl.toFixed(2)}, tolerance=${PLATEAU_TOLERANCE * 100}%)`;
    } else {
      reason = `current is within ${PLATEAU_TOLERANCE * 100}% of the best clean candidate (${bestClean.candidate}) -- staying on current rather than chasing a marginal, unrobust gain`;
    }
  } else if (!current.clean && bestClean) {
    winner = bestClean;
    reason = `current itself does not clear CI+distinctDates; bestClean (${bestClean.candidate}) does`;
  } else if (!bestClean) {
    reason = 'NO candidate clears CI excludes-zero + distinctDates floor -- staying on current, nothing here is trustworthy enough to switch to';
  }

  console.log(`\nDecision: ${winner.candidate}`);
  console.log(`Reason: ${reason}`);

  const summaryPath = path.join(REPO_ROOT, 'scratch', 'ml_hyperparams_sweep_summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const winnerHp = summary.find(s => s.candidate === winner.candidate)?.hyperparams;
  if (!winnerHp) {
    console.log('Could not find winner hyperparams in summary file -- aborting without writing.');
    process.exit(1);
  }
  const { rows: [{ today }] } = await query('SELECT CURRENT_DATE::text as today');

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes)
    VALUES (CURRENT_DATE, 0, 'ML_HYPERPARAMS', 'CURRENT', $1, $2, $3, $4)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size = EXCLUDED.sample_size, win_rate = EXCLUDED.win_rate,
          ev_per_trade = EXCLUDED.ev_per_trade, notes = EXCLUDED.notes
  `, [
    winner.n, winner.winRate, winner.meanPnl,
    JSON.stringify({
      hyperparams: winnerHp, candidate: winner.candidate, method: 'sweep_5_candidates_walkforward_dayblocked_bootstrap',
      all_results: results, decision_reason: reason, swept_at: new Date().toISOString(),
    }),
  ]);
  console.log(`\nWrote ML_HYPERPARAMS/CURRENT = ${winner.candidate} to performance_audit.`);

  await recordClaim({
    slug: 'ml_hyperparams_sweep_item5_20260922',
    claimText: `Item 5 (2026-09-21 DeepSeek ML silo review): swept 5 LightGBM hyperparameter candidates `
      + `(including 'current', DEFAULT_HYPERPARAMS, scored by the exact same method) through the real `
      + `walk-forward logic (run_walkforward_folds(), 7 real folds, 3,805 trades), judged by day-blocked `
      + `bootstrap CI + distinctDates on each candidate's own TAKE population, matching `
      + `recalibrate_ml_walkforward.mjs's own standard -- never raw AUC or raw P&L alone. `
      + `Results: ${results.map(r => `${r.candidate}: N=${r.n}, meanPnl=$${r.meanPnl.toFixed(2)}, distinctDates=${r.distinctDates}, CI=[$${r.ciLo.toFixed(2)},$${r.ciHi.toFixed(2)}], ${r.clean ? 'CLEAN' : 'not clean'}`).join(' | ')}. `
      + `Decision: ${winner.candidate} (${reason}).`,
    sourceFile: 'scripts/sweep_ml_hyperparams.py',
    sourceDate: today,
    sampleSize: winner.n,
    winRate: null,
    evPerTrade: winner.meanPnl,
    rigorStatus: winner.clean ? 'dayblocked_bootstrap_CI_excludes_zero' : 'dayblocked_bootstrap_CI_crosses_zero_kept_current',
    status: winner.clean ? 'CONFIRMED' : 'PROVISIONAL',
  });
  console.log('Claim recorded.');
}

main().catch(err => { console.error(err); process.exit(1); });
