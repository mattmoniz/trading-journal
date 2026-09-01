// Follow-up (2026-09-01, user: "chase it"), NOT a re-verification of an existing finding -- the
// original momentum-context fade-filter work (docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md sec
// 6b) found PRIOR_DAY_OR_DEVELOPING levels (PD_POC/VAH/VAL, VWAP, pivots, prior-week/year, 3-month)
// show almost no fade-quality effect ($2.17/trade, pooled binary median split) -- explicitly left
// as "a genuinely open, unsolved question" for this half of the roster.
//
// First test here (tercile of a smoothed 30-bar backdrop) found a clean negative -- but a user
// challenge caught 2 real methodology problems (wrong measure: smoothed backdrop instead of
// at-touch compositeStrength; wrong bucket count: tercile instead of quartile, inconsistent with
// the RUN/HELD test this whole thread is chasing). Corrected version (see
// scripts/lib/volbuildWalkforwardAtTouch.mjs's header for the full story): still NOT a clean
// positive -- U-shaped, unstable (Q4 EV=$3.14/trade but declining over chronological thirds,
// 63.5% day-clustering). Genuinely inconclusive, not confirmed-negative and not confirmed-positive.
// Do not re-run this with yet another ad hoc bucket/measure choice looking for a positive --
// that's exactly the multiple-comparisons fishing risk this correction round already flagged.
// If revisited, it needs a real reason (more real N accumulating naturally via the weekly
// recheck), not a new cut.
import { runVolbuildWalkforwardAtTouch } from './lib/volbuildWalkforwardAtTouch.mjs';

runVolbuildWalkforwardAtTouch({
  formationType: 'PRIOR_DAY_OR_DEVELOPING',
  familyLabel: 'PRIOR_DAY_OR_DEVELOPING (PD_POC/VAH/VAL, VWAP, pivots, etc)',
  claimSlug: 'prior_day_volbuild_quartile_fade_quality',
  sourceFile: 'scripts/backtest_priorday_volbuild_walkforward.mjs',
}).then(() => { console.log('\nDone.'); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
