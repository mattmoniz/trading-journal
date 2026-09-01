// Re-verification of the parked SAME_DAY_FORMING momentum-context fade filter
// (docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md sec 6b, original N=324, walk-forward
// $11.95-12.19/trade gap) at the current, much larger real N. Thin wrapper around
// scripts/lib/volbuildWalkforwardTercile.mjs (shared with the PRIOR_DAY_OR_DEVELOPING
// follow-up, scripts/backtest_priorday_volbuild_walkforward.mjs) -- see that file for the
// full no-lookahead walk-forward + tercile methodology and the exact-zero-third rigor-check
// bugfix note. Wired into run_weekly_backtests.sh as a standing recheck, not a one-off.
import { runVolbuildWalkforwardTercile } from './lib/volbuildWalkforwardTercile.mjs';

runVolbuildWalkforwardTercile({
  formationType: 'SAME_DAY_FORMING',
  familyLabel: 'SAME_DAY_FORMING (IB/OR family)',
  claimSlug: 'same_day_forming_volbuild_top_tercile_fade_quality',
  sourceFile: 'scripts/backtest_ib_or_volbuild_walkforward_refresh.mjs',
}).then(() => { console.log('\nDone.'); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
