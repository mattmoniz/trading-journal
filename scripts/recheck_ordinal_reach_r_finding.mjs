// Daily self-recalibration for the ordinal "how far will it run" (reach_R) fade-outcome
// finding (RESEARCH_CLAIM ordinal_reach_r_track_b_harness_20260924), mirroring
// recheck_tick_trend_fade_finding.mjs's own protocol exactly -- same freeze-the-canonical-
// evidence discipline (Opus Audit #14, section 6): a daily-retrained Spearman/p-value is
// informational drift-tracking only, never itself the evidence a decision leans on.
//
// FADE-ONLY, tick-based (build_trade_level_dataset.py / train_ordinal_model.py) -- NOT the
// all-setups bar-only variant, which was tested 2026-09-24 and found negative (Spearman
// -0.1997, fails the permutation null). Only the fade-specific, tick-based version showed a
// real signal (Spearman 0.2875, p<0.005 on 200 permutations) and is worth tracking daily.
import { execSync } from 'child_process';
import { recordClaim } from './record_claim.mjs';
import { query } from '../server/db.js';

const REPO = '/home/mmoniz/trading-journal';
const VENV_PY = `${REPO}/venv/bin/python3`;

function runPython(script, args = []) {
  return execSync(`${VENV_PY} ${REPO}/scripts/tick_microstructure/${script} ${args.join(' ')}`, {
    cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 50,
  });
}

function parseOrdinalOutput(output) {
  const rhoMatch = output.match(/REAL: Spearman\(expected_bucket, actual_bucket\) = ([\-\d.]+) \(p=([\d.]+)\)/);
  const nullMatch = output.match(/Fraction of null \|Spearman\| >= real \|Spearman\| \([\-\d.]+\): ([\d.]+) \(empirical p-value\)/);
  const monotoneMatch = output.match(/Monotone: (True|False)/);
  const trainMatch = output.match(/Train: (\d+) rows \/ (\d+) days, Test: (\d+) rows \/ (\d+) days/);
  return {
    real_spearman: rhoMatch ? parseFloat(rhoMatch[1]) : null,
    spearman_pvalue: rhoMatch ? parseFloat(rhoMatch[2]) : null,
    permutation_empirical_p: nullMatch ? parseFloat(nullMatch[1]) : null,
    calibration_monotone: monotoneMatch ? monotoneMatch[1] === 'True' : null,
    test_n_trades: trainMatch ? parseInt(trainMatch[3], 10) : null,
    test_n_days: trainMatch ? parseInt(trainMatch[4], 10) : null,
  };
}

async function main() {
  console.log('=== Rechecking ordinal_reach_r_track_b_harness, ' + new Date().toISOString() + ' ===');

  console.log('Re-running build_trade_level_dataset.py (fade-only, tick-based, real fade-fire join)...');
  const buildOut = runPython('build_trade_level_dataset.py');
  console.log(buildOut);

  console.log('Re-running train_ordinal_model.py (200-permutation null)...');
  const trainOut = runPython('train_ordinal_model.py');
  console.log(trainOut);

  const parsed = parseOrdinalOutput(trainOut);
  if (parsed.real_spearman == null) {
    console.error('FAILED to parse ordinal train output -- not updating the claim (avoid recording garbage).');
    process.exit(1);
  }

  const { rows: dateRows } = await query(`SELECT CURRENT_DATE::text as today`);
  const todayEt = dateRows[0].today;

  const excludesZero = parsed.permutation_empirical_p != null && parsed.permutation_empirical_p < 0.05;

  await recordClaim({
    slug: 'ordinal_reach_r_track_b_harness_20260924',
    claimText: [
      `AUTO-RECHECKED ${todayEt} via scripts/recheck_ordinal_reach_r_finding.mjs`,
      `(daily via run_daily_calibration.sh). FADE-ONLY, tick-based. Real Spearman=`,
      `${parsed.real_spearman}, 200-permutation empirical p=${parsed.permutation_empirical_p ?? 'not re-parsed'},`,
      `calibration monotone=${parsed.calibration_monotone}, test set ${parsed.test_n_trades} trades`,
      `across ${parsed.test_n_days} days.`,
      excludesZero
        ? 'Clears the 200-permutation null (p<0.05) -- still PROVISIONAL, not auto-promoted (human review required per this codebase\'s own recordClaim status vocabulary).'
        : 'Does not clear the 200-permutation null this run -- informational, day-to-day noise is expected on a sliding-window retrain (see the standing "daily retrain isn\'t independent evidence" convention).',
    ].join(' '),
    sourceFile: 'scripts/recheck_ordinal_reach_r_finding.mjs',
    sourceDate: todayEt,
    sampleSize: parsed.test_n_trades,
    winRate: null,
    evPerTrade: null,
    rigorStatus: excludesZero ? 'clears_null_this_run' : 'informational_daily_retrain',
    status: 'PROVISIONAL',
    extra: parsed,
  });

  console.log('Recheck complete, claim updated.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
