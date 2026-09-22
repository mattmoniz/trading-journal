#!/usr/bin/env node
// DAILY self-recalibration for the ML meta-labeling walk-forward finding -- wired into
// run_daily_calibration.sh (nightly), NOT run_weekly_backtests.sh. CORRECTED 2026-09-22
// (user-caught: "I thought we were recalibrating daily now for ML?" -- this file's own
// header/claimText previously said "Weekly" throughout, stale from before it was moved
// into the daily cron; only 1 historical performance_audit row existed at the time this
// was caught, since it had only been wired in and run once manually on 2026-09-21 --
// the first real automatic nightly run lands the next time run_daily_calibration.sh
// fires). Runs walkforward.py fresh (more real folds every NIGHT as more trades resolve
// and get labeled -- the 3 daily-scheduled backfill scripts in run_daily_calibration.sh
// keep ml_extended_label/ml_pd_features/ml_intraday_features growing), computes the
// day-blocked bootstrap CI on the fresh result via the real shared function (never
// hand-rolled -- server/services/rigorDiagnostics.js's dayBlockedBootstrapCI()), and
// records the outcome via recordClaim() -- never a hand-written INSERT, per this
// codebase's own standing rule.
//
// This is what turns the walk-forward finding from a one-off manual check into a
// real, self-recalibrating RESEARCH_CLAIM per this codebase's "no dead ends" rule:
// persisted (performance_audit), has a recheck path (this script, DAILY cron, not
// compute-once-and-forget), and the status (PROVISIONAL vs CONFIRMED) updates itself
// as real N grows instead of staying frozen at whatever it read on 2026-09-21.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { recordClaim } from './record_claim.mjs';
import { dayBlockedBootstrapCI, collapseClusterSiblings } from '../server/services/rigorDiagnostics.js';
import { query } from '../server/db.js';
import { ML_CLAIM_DISTINCT_DATES_FLOOR } from '../server/services/mlSiloService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const WALKFORWARD_PY = path.join(__dirname, 'ml_meta_labeling', 'walkforward.py');
const RESULTS_JSON = path.join(REPO_ROOT, 'scratch', 'walkforward_results.json');

async function main() {
  const { rows: [{ today }] } = await query('SELECT CURRENT_DATE::text as today');

  console.log('Running walkforward.py (fresh expanding-window folds against current real data)...');
  let stdout;
  try {
    stdout = execFileSync(path.join(REPO_ROOT, 'venv', 'bin', 'python3'), [WALKFORWARD_PY], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (err) {
    // walkforward.py sys.exit(1)s when there isn't yet enough training data for even
    // one fold -- not an error in this wrapper, just "too early, nothing to record yet."
    console.log('walkforward.py did not produce a result (insufficient data for any fold yet) -- skipping this week.');
    console.log(err.stdout || err.message);
    return;
  }
  console.log(stdout);

  const rows = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8'));
  const take = rows.filter(r => r.verdict === 'TAKE');
  const all = rows;
  if (take.length < 5) {
    console.log(`Only ${take.length} ML-approved trades across all folds -- too thin to record a fresh claim, skipping.`);
    return;
  }

  // Collapse correlated cluster siblings to one representative event each before the CI math
  // runs (2026-09-22, OPEN_DECISION ml_silo_deepseek_followup_review_parked_20260921) -- each
  // sibling still trains/scores individually above, this only affects reported confidence.
  const takeEvents = collapseClusterSiblings(take.map(r => ({ date: r.trade_date, pnl: r.actual_pnl, cluster_touch_id: r.cluster_touch_id })));
  const allEvents = collapseClusterSiblings(all.map(r => ({ date: r.trade_date, pnl: r.actual_pnl, cluster_touch_id: r.cluster_touch_id })));
  const takeCi = dayBlockedBootstrapCI(takeEvents, 'ml_walkforward_ML_APPROVED_TAKE', { dateField: 'date', iters: 5000 });
  const allCi = dayBlockedBootstrapCI(allEvents, 'ml_walkforward_ALL_TRADES_BASELINE', { dateField: 'date', iters: 5000 });

  const takeN = take.length;
  const takePnl = take.reduce((s, r) => s + r.actual_pnl, 0);
  const takeWr = 100 * take.filter(r => r.actual_pnl > 0).length / takeN;
  const takeDistinctDates = new Set(take.map(r => r.trade_date)).size;
  const allN = all.length;
  const allPnl = all.reduce((s, r) => s + r.actual_pnl, 0);
  const allWr = 100 * all.filter(r => r.actual_pnl > 0).length / allN;
  const foldsCount = new Set(all.map(r => r.fold_start)).size;

  const takeExcludesZero = takeCi.lo > 0 || takeCi.hi < 0;
  // FIXED 2026-09-22 (OPEN_DECISION ml_thread_ci_gate_and_cleanup_backlog_20260921, F2):
  // excludesZero alone doesn't rule out a thin/day-clustered population producing a false
  // CONFIRMED -- require real day-spread too, not just N/folds.
  const status = (takeExcludesZero && takeDistinctDates >= ML_CLAIM_DISTINCT_DATES_FLOOR) ? 'CONFIRMED' : 'PROVISIONAL';

  console.log(`\nML-approved: N=${takeN}, distinctDates=${takeDistinctDates}, P&L=$${takePnl.toFixed(2)}, `
    + `CI=[$${takeCi.lo.toFixed(2)}, $${takeCi.hi.toFixed(2)}], excludesZero=${takeExcludesZero}`);
  console.log(`All trades:  N=${allN}, P&L=$${allPnl.toFixed(2)}, CI=[$${allCi.lo.toFixed(2)}, $${allCi.hi.toFixed(2)}]`);
  console.log(`Recording as status=${status}...`);

  const claimText = `Daily-recalibrated walk-forward validation (re-run nightly via run_daily_calibration.sh; `
    + `internal expanding-window folds are 7 days wide -- FOLD_DAYS in walkforward.py, a methodology `
    + `parameter, not the outer recheck cadence; approval threshold derived from each fold's own TRAINING set to avoid lookahead) of the ML `
    + `meta-labeling model, auto-refreshed by scripts/recalibrate_ml_walkforward.mjs. `
    + `${foldsCount} real out-of-sample folds. All-trades N=${allN} P&L=${allPnl.toFixed(2)} `
    + `WR=${allWr.toFixed(1)} percent (day-blocked bootstrap 95pct CI on mean PnL/trade `
    + `[${allCi.lo.toFixed(2)},${allCi.hi.toFixed(2)}]) vs ML-approved N=${takeN} P&L=${takePnl.toFixed(2)} `
    + `WR=${takeWr.toFixed(1)} percent, distinctDates=${takeDistinctDates} (day-blocked bootstrap 95pct CI `
    + `on mean PnL/trade [${takeCi.lo.toFixed(2)},${takeCi.hi.toFixed(2)}], excludes zero: ${takeExcludesZero}). `
    + `Diagnostic is dayBlockedBootstrapCI(), not computeRigor()'s 3-way chronological tercile check, `
    + `per this codebase's own standing caveat that a fixed 3-way split is an unfair bar when every `
    + `trading day differs in character. Status flips to CONFIRMED automatically once the ML-approved `
    + `CI excludes zero AND distinctDates clears the ${ML_CLAIM_DISTINCT_DATES_FLOOR}-day floor (fixed `
    + `2026-09-22, OPEN_DECISION ml_thread_ci_gate_and_cleanup_backlog_20260921 F2 -- excludesZero alone `
    + `could false-CONFIRM a thin/day-clustered population) -- this run's CI ${takeExcludesZero ? 'DOES' : 'does NOT'} `
    + `exclude zero, and distinctDates=${takeDistinctDates} ${takeDistinctDates >= ML_CLAIM_DISTINCT_DATES_FLOOR ? 'DOES' : 'does NOT'} clear the floor.`;

  // MUST be awaited -- found 2026-09-22 investigating why a manual re-run's fresh numbers
  // (N=263, tighter CI) never showed up in performance_audit even though the script printed
  // "Claim recorded.": this call was fire-and-forget (no `await`), so `main()`'s own promise
  // resolved right after the synchronous console.log below, and `main().then(() =>
  // process.exit(0))` at the bottom of this file killed the process while recordClaim()'s
  // INSERT was still in flight -- no error, just a silently aborted write. This is a race,
  // not a guaranteed failure (the very first manual run on 2026-09-21 DID land, presumably
  // because the DB round-trip happened to finish before process.exit() fired that time) --
  // which is what made it look like "the script works" until a slower run exposed it.
  await recordClaim({
    slug: 'ml_metalabel_walkforward_directionally_positive_unstable',
    claimText,
    sourceFile: 'scripts/recalibrate_ml_walkforward.mjs',
    sourceDate: today,
    sampleSize: takeN,
    winRate: +takeWr.toFixed(1),
    evPerTrade: +(takePnl / takeN).toFixed(2),
    rigorStatus: takeExcludesZero
      ? `day_blocked_bootstrap_CI_excludes_zero_${takeDistinctDates}_distinct_dates`
      : `day_blocked_bootstrap_CI_crosses_zero_${takeDistinctDates}_distinct_dates`,
    status,
    unblockCondition: takeExcludesZero
      ? 'CI already excludes zero -- keep monitoring for continued stability as more folds accumulate.'
      : 'More real folds accumulate -- recheck the day-blocked bootstrap CI nightly (this script does so '
        + 'automatically via run_daily_calibration.sh); a CI that excludes zero is the bar for promoting this beyond PROVISIONAL.',
  });
  console.log('Claim recorded.');
}

main().then(() => process.exit(0));
