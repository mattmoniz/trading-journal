#!/usr/bin/env node
// Self-recalibrating research claim for the ML-gate + step-trail-exit coupling (2026-09-21,
// user's explicit "next step" request: "ML gates entry, a validated trail mechanism decides
// how far to let it run"). Reuses the real getStepTrailComparison() (never reimplemented --
// same function server/routes/mlSilo.js serves live), computes a day-blocked bootstrap CI on
// the per-trade delta (trail_pnl - normal_pnl) via the real shared dayBlockedBootstrapCI(),
// and records the result via recordClaim() -- never a hand-written INSERT.
//
// Deliberately NOT a claim that either mechanism is validated -- this model's own
// walk-forward CI still crosses zero, and step_trail_shadow's own RESEARCH_CLAIM
// (step_trail_runner_shadow_parallel_20260904) is PROVISIONAL, not promoted. This is a
// research comparison of what COMBINING them would look like, nothing more.
import { query } from '../server/db.js';
import { getLatestModel, getStepTrailComparison } from '../server/services/mlSiloService.js';
import { dayBlockedBootstrapCI, collapseClusterSiblings } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

async function main() {
  const { rows: [{ today }] } = await query('SELECT CURRENT_DATE::text as today');
  const model = await getLatestModel();
  if (!model) { console.log('No trained model yet -- skipping.'); process.exit(0); }

  const result = await getStepTrailComparison(model.model_version, 'test');
  if (!result || result.n < 5) {
    console.log(`Only ${result?.n ?? 0} ML-approved trades with a step_trail_shadow yet -- too thin to record, skipping.`);
    process.exit(0);
  }

  // Collapse correlated cluster siblings before the CI math (2026-09-22, OPEN_DECISION
  // ml_silo_deepseek_followup_review_parked_20260921) -- doesn't change what fires/scores.
  const deltaEvents = collapseClusterSiblings(
    result.rows.map(r => ({ date: r.trade_date, pnl: r.trail_pnl - r.normal_pnl, cluster_touch_id: r.cluster_touch_id })),
  );
  const ci = dayBlockedBootstrapCI(deltaEvents, 'ml_step_trail_delta', { dateField: 'date', iters: 5000 });
  const distinctDates = new Set(result.rows.map(r => r.trade_date)).size;
  const excludesZero = ci.lo > 0 || ci.hi < 0;

  console.log(`N=${result.n}, distinctDates=${distinctDates}`);
  console.log(`Normal exit total: $${result.normalTotal} | Step-trail hypothetical total: $${result.trailTotal}`);
  console.log(`Delta (trail - normal) day-blocked bootstrap 95% CI: [$${ci.lo.toFixed(2)}, $${ci.hi.toFixed(2)}], excludesZero=${excludesZero}`);

  const claimText = `Research comparison (auto-refreshed by scripts/recalibrate_ml_step_trail_comparison.mjs) `
    + `of "ML gates entry (verdict=TAKE), step-trail mechanism decides the exit" vs. "ML gates `
    + `entry, normal fixed exit" -- both pieces individually still unvalidated on their own `
    + `(this model's walk-forward CI crosses zero; step_trail_shadow's own RESEARCH_CLAIM is `
    + `PROVISIONAL). Out-of-sample N=${result.n} ML-approved trades with a real step_trail_shadow `
    + `hypothetical, ${distinctDates} distinct dates: normal-exit total=$${result.normalTotal}, `
    + `step-trail-hypothetical total=$${result.trailTotal}, delta day-blocked bootstrap 95pct CI `
    + `on mean delta/trade [${ci.lo.toFixed(2)},${ci.hi.toFixed(2)}], excludes zero: ${excludesZero}. `
    + `Genuinely thin (N<30) -- directional only, not yet a basis for anything.`;

  await recordClaim({
    slug: 'ml_metalabel_gate_plus_step_trail_exit_coupling',
    claimText,
    sourceFile: 'scripts/recalibrate_ml_step_trail_comparison.mjs',
    sourceDate: today,
    sampleSize: result.n,
    winRate: null,
    evPerTrade: +((result.trailTotal - result.normalTotal) / result.n).toFixed(2),
    rigorStatus: excludesZero
      ? `day_blocked_bootstrap_CI_excludes_zero_${distinctDates}_distinct_dates`
      : `day_blocked_bootstrap_CI_crosses_zero_thin_N_${distinctDates}_distinct_dates`,
    status: 'PROVISIONAL',
    unblockCondition: 'Needs BOTH underlying mechanisms (this model AND step-trail) to individually '
      + 'clear their own validation bar first -- this coupling comparison existing and looking '
      + 'directionally positive is not itself a reason to promote either one. Recheck as N grows.',
  });
  console.log('Claim recorded.');
}

main().then(() => process.exit(0));
