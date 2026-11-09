// Records the claim for docs/TELL_FLOOR_TARGET_PREREG_20261105.md (look 179, NOT SHOWN). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'tell_floor_target_not_shown_20261105',
  claimText: 'Pre-registered (ledger look 179, 3 counted tests, 1,451 scored tell explore entries on 399 dates, day-block CI 98.33 percent): a limit target at the nearest structure level at least F points ahead (F = causal median MFE of earlier V1 winners, 52.8-72.9 points) does NOT help the tell: STRUCT minus V1 -4.44 per entry [-10.20, +0.51] (detectable 6.23; halves -1.24 / -6.74), STRUCT minus a plain distance-F target -1.06 [-4.26, +2.27], stops <= 100 points -2.98 [-8.62, +1.99]. The target was reached on 259 entries (17.8 percent). The runner group (stops over 100 points, 85 entries) loses -24.89 per entry (V1 +52.74). Same sign at floors x0.75 and x1.5. Not tested: partial exits with a runner, a target with a trailing stop, the hold-out era, Globex.',
  sourceFile: 'scripts/tell_context/research_20261103/tell_floor_target.py',
  sourceDate: '2026-11-04', sampleSize: 1451, rigorStatus: 'day_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'A pre-registered partial-exit (floor-preserving runner) test, or the hold-out era extraction and one frozen look; re-running this window will not change it.',
  extra: { looks: [179], prereg: 'docs/TELL_FLOOR_TARGET_PREREG_20261105.md', counted_tests: 3 },
});
console.log('claim recorded'); process.exit(0);
