// Records the descriptive claim for docs/TELL_HOLDOUT_BY_QUARTER_PREREG_20261104.md (look 165). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'tell_holdout_by_quarter_20261104',
  claimText: 'Descriptive (ledger look 165, 0 counted tests; the hold-out look was already spent in look 143): static tell V1 replay net per entry by calendar quarter, 3,246 entries 2023-04..2026-10. Quarter means -15.0..+22.0 per entry with detectable effects of 14-48 dollars per quarter; one of 15 quarter CIs excludes 0 (2025Q4, -15.04), about what chance gives; hold-out negative in 5 of 7 quarters, explore in 5 of 9; first four quarters -2.73 vs last four -6.33; pooled about -2.0 per entry, indistinguishable from 0. The weakness is NOT a recent decline: the replay mean is near 0 across the whole timeline. Live Stage 2 (31 linked sim trades, 5 dates, -748 model P&L, about -24 per trade) is inside the noise of the replay.',
  sourceFile: 'scripts/tell_context/research_20261103/tell_holdout_by_quarter.py',
  sourceDate: '2026-11-04', sampleSize: 3246, rigorStatus: 'day_blocked_bootstrap_descriptive', status: 'PROVISIONAL',
  unblockCondition: 'Forward Stage 2 evidence: 150 linked trades and 60 dates (pre-registered floor, docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md section 10); until then the replay says no resolvable edge either way.',
  extra: { looks: [165], prereg: 'docs/TELL_HOLDOUT_BY_QUARTER_PREREG_20261104.md', counted_tests: 0 },
});
console.log('claim recorded'); process.exit(0);
