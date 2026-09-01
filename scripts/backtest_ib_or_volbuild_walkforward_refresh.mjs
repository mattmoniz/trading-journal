// Re-verification of the parked SAME_DAY_FORMING momentum-context fade filter
// (docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md sec 6b, original N=324, walk-forward
// $11.95-12.19/trade gap) at the current, much larger real N. Thin wrapper around
// scripts/lib/volbuildWalkforwardAtTouch.mjs (shared with the PRIOR_DAY_OR_DEVELOPING
// follow-up, scripts/backtest_priorday_volbuild_walkforward.mjs) -- see that file's header for
// the corrected AT-TOUCH/quartile methodology and why it replaced the original smoothed-backdrop/
// tercile version (real user-caught methodology bugs, not a style preference). Wired into
// run_weekly_backtests.sh as a standing recheck, not a one-off.
import { runVolbuildWalkforwardAtTouch } from './lib/volbuildWalkforwardAtTouch.mjs';

runVolbuildWalkforwardAtTouch({
  formationType: 'SAME_DAY_FORMING',
  familyLabel: 'SAME_DAY_FORMING (IB/OR family)',
  claimSlug: 'same_day_forming_volbuild_quartile_fade_quality',
  sourceFile: 'scripts/backtest_ib_or_volbuild_walkforward_refresh.mjs',
}).then(() => { console.log('\nDone.'); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
