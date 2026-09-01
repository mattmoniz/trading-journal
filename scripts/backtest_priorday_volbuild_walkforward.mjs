// Follow-up (2026-09-01, user: "chase it"), NOT a re-verification of an existing finding -- the
// original momentum-context fade-filter work (docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md sec
// 6b) found PRIOR_DAY_OR_DEVELOPING levels (PD_POC/VAH/VAL, VWAP, pivots, prior-week/year, 3-month)
// show almost no fade-quality effect ($2.17/trade, pooled binary median split) -- explicitly left
// as "a genuinely open, unsolved question" for this half of the roster.
//
// New lead: a separate, much larger RUN/HELD bar-level test (RESEARCH_CLAIM
// volume_building_run_held_by_level_formation_type, N=28,984) found PRIOR_DAY_OR_DEVELOPING shows
// the CLEANEST, most stable volume-building relationship of any family tested -- the opposite of
// where the fade-quality signal looked strongest (SAME_DAY_FORMING). Does that clean RUN/HELD
// signal translate into real fade P&L here, the way a tercile split (not the original binary
// median) revealed it for SAME_DAY_FORMING? Reuses scripts/lib/volbuildWalkforwardTercile.mjs
// verbatim -- same no-lookahead walk-forward methodology, just a different formationType.
import { runVolbuildWalkforwardTercile } from './lib/volbuildWalkforwardTercile.mjs';

runVolbuildWalkforwardTercile({
  formationType: 'PRIOR_DAY_OR_DEVELOPING',
  familyLabel: 'PRIOR_DAY_OR_DEVELOPING (PD_POC/VAH/VAL, VWAP, pivots, etc)',
  claimSlug: 'prior_day_volbuild_top_tercile_fade_quality',
  sourceFile: 'scripts/backtest_priorday_volbuild_walkforward.mjs',
}).then(() => { console.log('\nDone.'); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
