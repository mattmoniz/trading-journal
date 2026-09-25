// Daily self-recalibration for the tick-microstructure trend/efficiency-ratio fade-
// outcome finding (docs/TICK_MICROSTRUCTURE_PILOT_SPEC.md, RESEARCH_CLAIM
// tick_trend_efficiency_fade_outcome_provisional_20260923). PROVISIONAL as of first
// build: real test AUC=0.5368 (above random), but empirical p=0.10 (doesn't clear the
// conventional 0.05 bar) and 77.6% of the 353-trade test set concentrated in 5 of 10
// days -- a real day-clustering risk, not a confirmed finding.
//
// REWIRED 2026-09-24 per Opus Audit #14 (scratch/opus_audit_14_ml_strategy_results.md
// section 6 item 3 / section 7 step 0): a daily sliding-183-day-window retrain shares
// ~99% of its data day to day, so a chart of its own AUC history is ONE noisy
// measurement drawn repeatedly, not independent evidence -- and "promote once p<0.05
// shows up" while checking daily is optional stopping, which inflates the real false-
// positive rate no matter how honest each individual check is.
//
// This script now runs TWO things every day:
//   1. The sliding-window retrain (build_trade_level_dataset.py + train_fade_outcome_
//      model.py) -- kept for drift-tracking / the existing quick-check.html history
//      chart, but its result is recorded as INFORMATIONAL ONLY, never evidence toward
//      promoting or killing the claim.
//   2. score_frozen_model.py -- scores the ONE frozen model (frozen 2026-09-24, trained
//      through 2026-09-22, see scripts/tick_microstructure/artifacts/) against ONLY
//      genuinely new post-freeze trades. This is the canonical prospective-evidence
//      path. Per the pre-registered single look, its AUC is not a checkpoint to act on
//      until n_new_days >= 20 -- below that it's accumulation progress only.
//
// Per this codebase's own standing rule ("a next_recheck_due flag is not an auto-rerun
// unless the source script is actually wired into a cron file") -- this IS that wiring.
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

function parseTrainOutput(output) {
  const aucMatch = output.match(/REAL test AUC:\s*([\d.]+)/);
  const nullMeanMatch = output.match(/Null AUC:\s*mean=([\d.]+)/);
  const pValueMatch = output.match(/Fraction of null permutations >= real AUC:\s*([\d.]+)/);
  const testSetMatch = output.match(/Test set:\s*(\d+)\s*real trades,\s*(\d+)\s*distinct days/);
  const topFeatureMatch = output.match(/Feature importance \(gain\):\n\s*([a-z_]+):/);
  return {
    real_test_auc: aucMatch ? parseFloat(aucMatch[1]) : null,
    null_auc_mean: nullMeanMatch ? parseFloat(nullMeanMatch[1]) : null,
    empirical_p_value: pValueMatch ? parseFloat(pValueMatch[1]) : null,
    test_n_trades: testSetMatch ? parseInt(testSetMatch[1], 10) : null,
    test_n_days: testSetMatch ? parseInt(testSetMatch[2], 10) : null,
    top_feature: topFeatureMatch ? topFeatureMatch[1] : null,
  };
}

function parseFrozenScoreOutput(output) {
  const jsonLine = output.trim().split('\n').filter(Boolean).pop();
  try {
    return JSON.parse(jsonLine);
  } catch {
    return null;
  }
}

async function main() {
  console.log('=== Rechecking tick_trend_efficiency_fade_outcome, ' + new Date().toISOString() + ' ===');

  console.log('Re-running build_trade_level_dataset.py (real fade-fire join)...');
  const buildOut = runPython('build_trade_level_dataset.py');
  console.log(buildOut);

  console.log('Re-running train_fade_outcome_model.py...');
  const trainOut = runPython('train_fade_outcome_model.py');
  console.log(trainOut);

  const parsed = parseTrainOutput(trainOut);
  if (parsed.real_test_auc == null) {
    console.error('FAILED to parse train output -- not updating the claim (avoid recording garbage).');
    process.exit(1);
  }

  console.log('Scoring the FROZEN model against genuinely new post-freeze trades (canonical prospective evidence)...');
  const frozenOut = runPython('score_frozen_model.py');
  console.log(frozenOut);
  const frozen = parseFrozenScoreOutput(frozenOut);

  // Real trading-day date, per this codebase's own standing rule: never derive it from
  // JS new Date()/toISOString() (UTC-based, silently a full day off from the DB's own
  // America/New_York "today" once past ~8pm ET) -- always from SQL CURRENT_DATE. Real
  // bug caught by the Opus ML-strategy audit (2026-09-24) before it ever hit the
  // pre-commit hook's own scan for this exact pattern.
  const { rows: dateRows } = await query(`SELECT CURRENT_DATE::text as today`);
  const todayEt = dateRows[0].today;

  // Real day-clustering re-check (not parsed from stdout -- recomputed directly here so
  // this doesn't silently drift if the Python script's own printed format ever changes).
  const { rows } = await query(
    `SELECT COUNT(DISTINCT setup_type) as n_types, COUNT(*) as n_total FROM active_setups
     WHERE setup_type LIKE '%_FADE_%' AND resolution IN ('STOP_HIT','TARGET_HIT')
       AND origin_status IN ('ACTIVE','SHADOW') AND (is_cluster_primary IS NULL OR is_cluster_primary = true)`
  );

  // Status NEVER auto-changes based on either number below -- that's a human call per
  // this codebase's own recordClaim status vocabulary (CONFIRMED means independently
  // re-verified, not "a script's own number crossed a line"). The frozen-model floor
  // check below is reported, never acted on by this script.
  const status = 'PROVISIONAL';
  const floorMet = frozen?.prospective_floor_met === true;

  await recordClaim({
    slug: 'tick_trend_efficiency_fade_outcome_provisional_20260923',
    claimText: [
      `AUTO-RECHECKED ${todayEt} via scripts/recheck_tick_trend_fade_finding.mjs`,
      `(daily via run_daily_calibration.sh).`,
      `INFORMATIONAL (sliding 183-day window, retrained from scratch -- NOT independent`,
      `evidence per Opus Audit #14, 2026-09-24): real test AUC=${parsed.real_test_auc},`,
      `empirical p-value=${parsed.empirical_p_value ?? 'not re-parsed'} (n_permutations=200),`,
      `test set ${parsed.test_n_trades} trades across ${parsed.test_n_days} days, top`,
      `feature by gain: ${parsed.top_feature}. Total real fade fires in population now:`,
      `${rows[0]?.n_total ?? 'unknown'}.`,
      `CANONICAL PROSPECTIVE EVIDENCE (frozen model, trained through 2026-09-22, never`,
      `retrained): ${frozen ? `${frozen.n_new_days} new distinct days / ${frozen.n_new_trades} new trades accumulated since freeze` + (frozen.frozen_auc != null ? `, frozen-model AUC on that new data=${frozen.frozen_auc.toFixed(4)}` : ' (not enough new data to score yet)') : 'scoring failed to parse'}.`,
      floorMet
        ? 'Pre-registered floor (>=20 new distinct days) IS NOW MET -- this is the single pre-registered look. Needs a human review, not an automatic status change.'
        : `Pre-registered floor (>=20 new distinct days) not yet met (${frozen?.n_new_days ?? 0}/20) -- the frozen-model AUC above is accumulation progress only, not a checkpoint to act on. Full original methodology: docs/TICK_MICROSTRUCTURE_PILOT_SPEC.md.`,
    ].join(' '),
    sourceFile: 'scripts/recheck_tick_trend_fade_finding.mjs',
    sourceDate: todayEt,
    sampleSize: parsed.test_n_trades,
    winRate: null,
    evPerTrade: null,
    rigorStatus: floorMet ? 'prospective_floor_met_needs_human_review' : 'accumulating_prospective_days',
    status,
    extra: { sliding_window: parsed, frozen_model: frozen },
  });

  console.log('Recheck complete, claim updated.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
