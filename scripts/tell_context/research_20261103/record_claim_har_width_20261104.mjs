// Records the claim for docs/HAR_WIDTH_BENCHMARK_PREREG_20261104.md (look 168, NOT SHOWN). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'har_width_benchmark_not_shown_20261104',
  claimText: 'Pre-registered (ledger look 168, 2 counted tests, explore, 356 scored sessions, week-block CI 97.5 percent): a standard HAR-X volatility model (daily / weekly / monthly realized range of the RTH session plus the overnight range, OLS) predicts the log range ratio better than the day forecast baseline (+14.0 percent of its loss) and at least as well as the stage-0 day-width forecast: stage 0 vs HAR-X -0.00684 (-4.4 percent of the HAR-X loss), CI [-0.0185, +0.0044]; adding the stage-0 features to HAR-X -0.00157 (-1.0 percent), CI [-0.0092, +0.0059]; both NOT SHOWN, detectable 4.1 percent. HAR-X beats the baseline with a CI that excludes 0 (+14.0 percent, [+0.0097, +0.0429]); stage 0 has NO DETECTABLE INCREMENT beyond it (an interpretation, not a proof: the earlier +10.7 percent width lead looks like persistence plus the overnight range over a weak baseline). The HAR-X width multiplier varies about 21 percent (SD / mean), of which the baseline own 16 percent is persistence. The stage-0 forecast is retired as a stop-scaling input; HAR-X is the width reference.',
  sourceFile: 'scripts/tell_context/research_20261103/har_width_benchmark.py',
  sourceDate: '2026-11-04', sampleSize: 356, rigorStatus: 'week_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'Range is the only volatility proxy here; realized variance from ticks or a different target could change the HAR numbers; a stop test using HAR-X needs its own pre-registration and the user go. Re-running this model comparison will not change it.',
  extra: { looks: [168], corrections: 'round W wording A1', prereg: 'docs/HAR_WIDTH_BENCHMARK_PREREG_20261104.md', counted_tests: 2 },
});
console.log('claim recorded'); process.exit(0);
