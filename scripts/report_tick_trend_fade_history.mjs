// Shows the day-by-day trend of the tick-trend/efficiency-ratio fade-outcome finding
// (RESEARCH_CLAIM tick_trend_efficiency_fade_outcome_provisional_20260923) across every
// historical daily recheck (scripts/recheck_tick_trend_fade_finding.mjs, wired into
// run_daily_calibration.sh) -- not just the latest snapshot. A single day's AUC/p-value
// clearing (or missing) a bar means little on its own; whether the number is STABLE
// across many days is the real reliability signal, matching this codebase's own standing
// day-blocked-stability discipline applied to a finding's own history instead of just
// its underlying trade population.
//
// Usage: node scripts/report_tick_trend_fade_history.mjs
import { query } from '../server/db.js';

const SLUG = 'tick_trend_efficiency_fade_outcome_provisional_20260923';

async function main() {
  const { rows } = await query(`
    SELECT run_date, sample_size, notes
    FROM performance_audit
    WHERE signal_type = 'RESEARCH_CLAIM' AND signal_name = $1
    ORDER BY run_date ASC
  `, [SLUG]);

  if (rows.length === 0) {
    console.log(`No history yet for ${SLUG} -- has the daily recheck run at least once?`);
    return;
  }

  console.log(`=== History for ${SLUG} (${rows.length} recorded runs) ===\n`);
  console.log('run_date     | test_auc | empirical_p | test_n | test_days | top_feature');
  console.log('-------------|----------|-------------|--------|-----------|------------------------');

  const aucs = [];
  const pvals = [];
  for (const r of rows) {
    const n = JSON.parse(r.notes);
    const auc = n.real_test_auc;
    const p = n.empirical_p_value;
    if (typeof auc === 'number') aucs.push(auc);
    if (typeof p === 'number') pvals.push(p);
    console.log(
      `${String(r.run_date).slice(0, 10).padEnd(12)} | ` +
      `${(auc ?? '?').toString().padEnd(8)} | ` +
      `${(p ?? '?').toString().padEnd(11)} | ` +
      `${(r.sample_size ?? '?').toString().padEnd(6)} | ` +
      `${(n.test_n_days ?? '?').toString().padEnd(9)} | ` +
      `${n.top_feature ?? '?'}`
    );
  }

  if (aucs.length >= 2) {
    const mean = aucs.reduce((a, b) => a + b, 0) / aucs.length;
    const variance = aucs.reduce((a, b) => a + (b - mean) ** 2, 0) / aucs.length;
    const std = Math.sqrt(variance);
    const nBelow05 = aucs.filter(a => a < 0.5).length;
    console.log(`\nAUC across ${aucs.length} runs: mean=${mean.toFixed(4)}, std=${std.toFixed(4)}, ` +
      `min=${Math.min(...aucs).toFixed(4)}, max=${Math.max(...aucs).toFixed(4)}`);
    console.log(`Runs where AUC dropped below random (0.5): ${nBelow05} / ${aucs.length} ` +
      `(${(100 * nBelow05 / aucs.length).toFixed(0)}%)`);
    console.log(nBelow05 / aucs.length > 0.3
      ? '=> UNSTABLE: AUC flips sides of random too often to trust yet, regardless of any single day\'s p-value.'
      : '=> Reasonably consistent so far -- keep watching, this alone is not confirmation.');
  } else {
    console.log('\nNeed at least 2 recorded runs to judge stability -- check back after the daily cron has run a few more times.');
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
