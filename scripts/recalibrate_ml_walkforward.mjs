#!/usr/bin/env node
// Weekly self-recalibration for the ML meta-labeling walk-forward finding. Runs
// walkforward.py fresh (more real folds every week as more trades resolve and get
// labeled -- the 3 daily-scheduled backfill scripts in run_daily_calibration.sh keep
// ml_extended_label/ml_pd_features/ml_intraday_features growing), computes the
// day-blocked bootstrap CI on the fresh result via the real shared function (never
// hand-rolled -- server/services/rigorDiagnostics.js's dayBlockedBootstrapCI()), and
// records the outcome via recordClaim() -- never a hand-written INSERT, per this
// codebase's own standing rule.
//
// This is what turns the walk-forward finding from a one-off manual check into a
// real, self-recalibrating RESEARCH_CLAIM per this codebase's "no dead ends" rule:
// persisted (performance_audit), has a recheck path (this script, weekly cron, not
// compute-once-and-forget), and the status (PROVISIONAL vs CONFIRMED) updates itself
// as real N grows instead of staying frozen at whatever it read on 2026-09-21.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { recordClaim } from './record_claim.mjs';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { query } from '../server/db.js';

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

  const takeEvents = take.map(r => ({ date: r.trade_date, pnl: r.actual_pnl }));
  const allEvents = all.map(r => ({ date: r.trade_date, pnl: r.actual_pnl }));
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
  const status = takeExcludesZero ? 'CONFIRMED' : 'PROVISIONAL';

  console.log(`\nML-approved: N=${takeN}, distinctDates=${takeDistinctDates}, P&L=$${takePnl.toFixed(2)}, `
    + `CI=[$${takeCi.lo.toFixed(2)}, $${takeCi.hi.toFixed(2)}], excludesZero=${takeExcludesZero}`);
  console.log(`All trades:  N=${allN}, P&L=$${allPnl.toFixed(2)}, CI=[$${allCi.lo.toFixed(2)}, $${allCi.hi.toFixed(2)}]`);
  console.log(`Recording as status=${status}...`);

  const claimText = `Weekly-recalibrated walk-forward validation (expanding-window retrain every 7 days, `
    + `approval threshold derived from each fold's own TRAINING set to avoid lookahead) of the ML `
    + `meta-labeling model, auto-refreshed by scripts/recalibrate_ml_walkforward.mjs. `
    + `${foldsCount} real out-of-sample folds. All-trades N=${allN} P&L=${allPnl.toFixed(2)} `
    + `WR=${allWr.toFixed(1)} percent (day-blocked bootstrap 95pct CI on mean PnL/trade `
    + `[${allCi.lo.toFixed(2)},${allCi.hi.toFixed(2)}]) vs ML-approved N=${takeN} P&L=${takePnl.toFixed(2)} `
    + `WR=${takeWr.toFixed(1)} percent, distinctDates=${takeDistinctDates} (day-blocked bootstrap 95pct CI `
    + `on mean PnL/trade [${takeCi.lo.toFixed(2)},${takeCi.hi.toFixed(2)}], excludes zero: ${takeExcludesZero}). `
    + `Diagnostic is dayBlockedBootstrapCI(), not computeRigor()'s 3-way chronological tercile check, `
    + `per this codebase's own standing caveat that a fixed 3-way split is an unfair bar when every `
    + `trading day differs in character. Status flips to CONFIRMED automatically once the ML-approved `
    + `CI excludes zero -- this run's CI ${takeExcludesZero ? 'DOES' : 'does NOT'} exclude zero.`;

  recordClaim({
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
      : 'More real folds accumulate -- recheck the day-blocked bootstrap CI weekly (this script does so '
        + 'automatically); a CI that excludes zero is the bar for promoting this beyond PROVISIONAL.',
  });
  console.log('Claim recorded.');
}

main().then(() => process.exit(0));
