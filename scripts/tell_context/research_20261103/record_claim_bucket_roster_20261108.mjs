// Records the claim for docs/BUCKET_ROSTER_PREREG_20261108.md (look 181, NOT SHOWN). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'bucket_roster_not_shown_20261108',
  claimText: 'Pre-registered (ledger look 181, 2 counted tests, walk-forward over 79 scored days 2026-08-07..2026-11-06, 262 setup types, rosters rebuilt as of each day, declustered fires, day-block CI 97.5 percent): a session x time-block partial-pooling promotion arm (empirical-Bayes cells, 80 percent posterior lower bound above 0, five buckets) does NOT beat the pooled live roster rule: BUCKET minus POOLED -64.47 per active day [-156.78, +11.18] (detectable 105.5; halves -94.90 / -35.41) and -4.22 per trade [-25.23, +14.01]; BUCKET took 296 trades at -12.36 per trade against POOLED 109 at -8.14 and take-all 6,490 at -2.51. Exploratory, not counted: POOLED minus take-all -5.62 per trade [-19.89, +8.23], BUCKET minus take-all -9.85 [-21.47, -1.89]. Retrospective, a lead at most; forward re-run at 60 and 120 days stays the kill test. Not tested: a stricter bound, a two-bucket RTH/Globex split, longer history.',
  sourceFile: 'scripts/backtest_bucket_roster.mjs',
  sourceDate: '2026-11-08', sampleSize: 296, rigorStatus: 'day_blocked_bootstrap_walkforward_prereg', status: 'PROVISIONAL',
  unblockCondition: 'node scripts/backtest_bucket_roster.mjs --first-forward 2026-11-09 at 60 and 120 forward days; re-running the retrospective window will not change it.',
  extra: { looks: [181], prereg: 'docs/BUCKET_ROSTER_PREREG_20261108.md', counted_tests: 2 },
});
console.log('claim recorded'); process.exit(0);
