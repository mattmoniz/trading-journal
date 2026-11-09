// Records the claim for docs/TELL_STALL_DELTA_PREREG_20261104.md (look 164, NOT SHOWN). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'tell_stall_delta_not_shown_20261104',
  claimText: 'Pre-registered (ledger look 164, 3 counted tests, CI 98.33 percent, explore, 1,752 of the 1,760 tell entries, stall L = 11 minutes): Sierra up/down-tick delta (trade-price rule, cumulative sum reset 18:00 ET, reproduces the user pane: 621 at 11:24 and about 1,180 at 10:46 on 2026-11-04, confirmed close by the user) at the first stall does NOT separate continuation from reversal over the next 60 minutes: flow share now vs lately rho +0.011 [-0.047, +0.069]; flow since the extreme +0.032 [-0.033, +0.097]; divergence at the extreme -0.009 [-0.069, +0.058]; other-date placebos the same size; detectable |rho| about 0.07. Minute-scale only; the seconds-scale touch pattern (one-day descriptive, nine hand-picked pivots) and the user picture read are untested. Step 0b of docs/TRADE_WATCHER_MARKS_AND_LABELS_SCOPE_20261104.md.',
  sourceFile: 'scripts/tell_context/research_20261103/tell_stall_delta.py',
  sourceDate: '2026-11-04', sampleSize: 1752, rigorStatus: 'day_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'Only different evidence reopens it: a seconds-scale aggressor-volume study over many pre-defined extremes (not hand-picked pivots), or the user blind labels; a re-run of these three minute-scale readings will not.',
  extra: { looks: [164], prereg: 'docs/TELL_STALL_DELTA_PREREG_20261104.md', counted_tests: 3 },
});
console.log('claim recorded'); process.exit(0);
