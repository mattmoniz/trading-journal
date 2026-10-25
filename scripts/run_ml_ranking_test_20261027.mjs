// Runs the pre-registered ML ranking test once its window has closed (docs/ML_RANKING_TEST_ADDENDUM_20261025.md).
// Wired into run_daily_calibration.sh; does nothing before 2026-10-28 or once the result is recorded. Never changes live behavior.
//   node scripts/run_ml_ranking_test_20261027.mjs [--force] [--dry]     --dry: run and print, record nothing (code test only)
import { execFileSync } from 'child_process';
import fs from 'fs';
import { query } from '../server/db.js';
import { recordClaim } from './record_claim.mjs';
import { resolveDecision } from './flag_decision.mjs';
const SLUG = 'ml_ranking_test_result_20261027', RUN_FROM = '2026-10-28';
const money = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
async function main() {
  const force = process.argv.includes('--force'), dry = process.argv.includes('--dry');
  const today = (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;
  if (!force && today < RUN_FROM) { console.log(`ranking test not due (runs from ${RUN_FROM}, today ${today})`); return; }
  if (!force && (await query(`SELECT 1 FROM performance_audit WHERE signal_type='RESEARCH_CLAIM' AND signal_name=$1 LIMIT 1`, [SLUG])).rows.length) { console.log('ranking test already recorded'); return; }
  execFileSync('./venv/bin/python', ['scripts/ml_meta_labeling/ranking_test_20261027.py', ...(dry ? ['--window-end', today] : [])], { stdio: 'inherit', cwd: process.cwd(), timeout: 600000 });
  const r = JSON.parse(fs.readFileSync('scratch/ml_ranking_test_result_20261027.json', 'utf8')), p = r.primary, s = r.secondary;
  const L = (a) => `${a.arm}: ${a.n_windows} windows, top pick minus window mean ${money(a.mean_diff)} per window${a.ci95 ? ` (95% CI ${money(a.ci95[0])}..${money(a.ci95[1])})` : ''}, beats random in ${a.beats} (${a.beats_share == null ? 'n/a' : (100 * a.beats_share).toFixed(0)}%)`;
  const verdict = r.pass ? 'PASS' : 'FAIL';
  const text = `Pre-registered ML ranking test (decision ml_ranking_preregistered_test_20261027, addendum docs/ML_RANKING_TEST_ADDENDUM_20261025.md). Model trained only on trades fired before ${r.cutoff} (minus purge); test = primary ACTIVE trades fired ${r.window[0]}..${r.window[1]} (${r.scored_trades} scored of ${r.candidate_trades_in_window}; ${r.unscorable_no_features} lacked a feature snapshot), 5-minute chain windows of 2+ trades. ${L(p)}. Information only: ${L(s)}. Pass bar: >=20 windows, mean >= +$5, beats random in >=60% of windows. VERDICT: ${verdict}.${r.pass ? '' : ' ML is dropped as a ranker; scores stay as logging only.'}`;
  console.log(text);
  if (dry) { console.log('DRY RUN: nothing recorded'); return; }
  await recordClaim({ slug: SLUG, claimText: text, sourceFile: 'scripts/ml_meta_labeling/ranking_test_20261027.py', sourceDate: today, sampleSize: p.n_windows, evPerTrade: p.mean_diff, rigorStatus: 'preregistered_addendum_window_closed', status: 'CONFIRMED' });
  await resolveDecision('ml_ranking_preregistered_test_20261027', `RESOLVED ${today}: ${verdict}. ${text}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
