// Records the claim for docs/STRUCTURE_MODEL_DIRECTION_PREREG_20261104.md (look 176, NOT SHOWN after a lookahead bug was found and fixed). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'structure_model_direction_not_shown_20261104',
  claimText: 'Pre-registered (ledger look 176, 3 counted tests, explore, 1,424 scored rows on 356 days at 10:30, 11:30, 13:00, 14:30, week-block CI 98.33 percent, circular-shift placebo): the DIRECTION of the next hour (close-to-close in ADR units) is NOT predictable from price action, support / resistance distances (prior-day high/low, overnight high/low, IB high/low), the overnight picture and tick order flow: rho(full ridge, y_dir) +0.0225 [-0.0523, +0.0927] (placebo gate 0.0601), full over momentum-only -0.0009 [-0.0020, +0.0001], top-third predicted-range regime rho +0.0302 [-0.0771, +0.1343]; detectable rho 0.083. A FIRST RUN showed a spurious T3 LEAD (rho +0.387 at 10:30) caused by a lookahead bug (c[T-61] at T=60 is the last bar of the day); found by the audit and fixed before the record; the buggy output is kept. The sign rule made +3.40 per decision row [-4.09, +11.27] after costs, momentum +3.65, always long -0.71. Support and resistance as a reaction at a touch (reverse vs break) is untested.',
  sourceFile: 'scripts/tell_context/research_20261103/structure_model_stepA.py',
  sourceDate: '2026-11-05', sampleSize: 1424, rigorStatus: 'week_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'A level-touch reaction design (reverse vs break at a structural touch), pre-registered, or forward shadow data; re-running this hour-direction design will not change it.',
  extra: { looks: [176], prereg: 'docs/STRUCTURE_MODEL_DIRECTION_PREREG_20261104.md', counted_tests: 3, lookahead_bug_found_and_fixed: true },
});
console.log('claim recorded'); process.exit(0);
