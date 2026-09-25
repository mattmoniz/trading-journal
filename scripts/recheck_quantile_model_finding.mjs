// Daily self-recalibration for the MAE/MFE quantile path-distribution gating finding
// (RESEARCH_CLAIM mae_mfe_quantile_pathdist_gate_20260924), mirroring
// recheck_ordinal_reach_r_finding.mjs's own protocol exactly -- same freeze-the-canonical-
// evidence discipline: a daily-retrained Spearman/p-value history is informational
// drift-tracking, never itself the evidence a decision leans on. Built specifically to give
// this claim the recheck path test_invariants.mjs's check [11] flagged it as missing
// ("rigor_status suggests a data-volume deferral but no unblockCondition was recorded") --
// the real fix for "only 8 distinct test days" is accumulating more real days over time via
// this daily recheck, not forcing an ill-fitting min_real_n_per_type unblockCondition onto a
// finding that isn't scoped to one setup_type.
//
// FADE-ONLY, RTH-only, tick-based -- same scope as train_quantile_model.py itself.
import { execSync } from 'child_process';
import { recordClaim } from './record_claim.mjs';
import { query } from '../server/db.js';

const REPO = '/home/mmoniz/trading-journal';
const VENV_PY = `${REPO}/venv/bin/python3`;

function runPython(script) {
  return execSync(`${VENV_PY} ${REPO}/scripts/tick_microstructure/${script}`, {
    cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 50,
  });
}

function parseOutput(output) {
  const mfeMatch = output.match(/\[MFE\] Spearman\(predicted q[\d.]+, actual reach_r\) = ([\-\d.]+) \(p=([\d.]+)\)/);
  const maeMatch = output.match(/\[MAE\] Spearman\(predicted q[\d.]+, actual mae_r\) = ([\-\d.]+) \(p=([\d.]+)\)/);
  const mfeNullMatch = output.match(/Real MFE Spearman \([\-\d.]+\) empirical p-value: ([\d.]+)/);
  const maeNullMatch = output.match(/Real MAE Spearman \([\-\d.]+\) empirical p-value: ([\d.]+)/);
  const testMatch = output.match(/Test: (\d+) rows \/ (\d+) days/);
  const gateMatch = output.match(/GATE VERDICT[\s\S]*?(PASS|FAIL)/);
  return {
    mfe_spearman: mfeMatch ? parseFloat(mfeMatch[1]) : null,
    mfe_pvalue: mfeMatch ? parseFloat(mfeMatch[2]) : null,
    mfe_null_empirical_p: mfeNullMatch ? parseFloat(mfeNullMatch[1]) : null,
    mae_spearman: maeMatch ? parseFloat(maeMatch[1]) : null,
    mae_pvalue: maeMatch ? parseFloat(maeMatch[2]) : null,
    mae_null_empirical_p: maeNullMatch ? parseFloat(maeNullMatch[1]) : null,
    test_n_trades: testMatch ? parseInt(testMatch[1], 10) : null,
    test_n_days: testMatch ? parseInt(testMatch[2], 10) : null,
    gate: gateMatch ? gateMatch[1] : null,
  };
}

async function main() {
  console.log('=== Rechecking mae_mfe_quantile_pathdist_gate, ' + new Date().toISOString() + ' ===');

  console.log('Re-running build_trade_level_dataset.py (fade-only, tick-based)...');
  const buildOut = runPython('build_trade_level_dataset.py');
  console.log(buildOut);

  console.log('Re-running train_quantile_model.py...');
  const trainOut = runPython('train_quantile_model.py');
  console.log(trainOut);

  const parsed = parseOutput(trainOut);
  if (parsed.mfe_spearman == null && parsed.mae_spearman == null) {
    console.error('FAILED to parse quantile model output -- not updating the claim.');
    process.exit(1);
  }

  const { rows: dateRows } = await query(`SELECT CURRENT_DATE::text as today`);
  const todayEt = dateRows[0].today;

  const mfeClears = parsed.mfe_null_empirical_p != null && parsed.mfe_null_empirical_p < 0.05;
  const maeClears = parsed.mae_null_empirical_p != null && parsed.mae_null_empirical_p < 0.05;

  await recordClaim({
    slug: 'mae_mfe_quantile_pathdist_gate_20260924',
    claimText: [
      `AUTO-RECHECKED ${todayEt} via scripts/recheck_quantile_model_finding.mjs (daily via`,
      `run_daily_calibration.sh). MFE Spearman=${parsed.mfe_spearman}, null empirical`,
      `p=${parsed.mfe_null_empirical_p ?? 'not re-parsed'}. MAE Spearman=${parsed.mae_spearman},`,
      `null empirical p=${parsed.mae_null_empirical_p ?? 'not re-parsed'}. Test set`,
      `${parsed.test_n_trades} trades across ${parsed.test_n_days} distinct days.`,
      (mfeClears || maeClears)
        ? 'At least one direction still clears the 200-permutation null (p<0.05) -- still PROVISIONAL, not auto-promoted (human review required).'
        : 'Neither direction clears the null this run -- informational, day-to-day noise is expected on a sliding-window retrain.',
    ].join(' '),
    sourceFile: 'scripts/recheck_quantile_model_finding.mjs',
    sourceDate: todayEt,
    sampleSize: parsed.test_n_trades,
    winRate: null, evPerTrade: null,
    rigorStatus: (mfeClears || maeClears) ? 'clears_null_this_run' : 'informational_daily_retrain',
    status: 'PROVISIONAL',
    extra: parsed,
  });

  console.log('Recheck complete, claim updated.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
