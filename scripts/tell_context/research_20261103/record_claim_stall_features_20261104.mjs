// Records the claim for docs/TELL_STALL_FEATURES_KILL_TEST_PREREG_20261104.md (looks 162 and 163, both NOT SHOWN). hr-024: via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'tell_stall_features_not_shown_20261104',
  claimText: 'Pre-registered kill test (ledger looks 162 and 163, 10 counted tests, explore only, 1,760 tell entries, day-block bootstrap, other-date placebo): NOW-versus-LATELY tape readings at the first stall minute (volume NOW 5 min / LATELY 20 min, adverse volume share, range per contract, volume per point of net move, pullback depth in typical bars) do NOT separate continuation from reversal over the next 60 minutes. Stall = no new favourable extreme for L minutes: L = 3 (p75 of gaps, 1,760 entries) all five rho within -0.03..+0.06, CIs include 0 (99 percent); L = 11 (p90, amendment A1, 1,752 entries) all five rho within -0.02..+0.014, CIs include 0 (Bonferroni over 10); placebos (same features from another date) are the same size; W = 10 and 30 the same; detectable |rho| about 0.07. This tests readings alone on the tell entries; it does NOT test the user\'s visual stall read, delta, or their labels. Step 0 of docs/TRADE_WATCHER_MARKS_AND_LABELS_SCOPE_20261104.md (scope amendment A1, DeepSeek round T).',
  sourceFile: 'scripts/tell_context/research_20261103/tell_stall_features.py',
  sourceDate: '2026-11-04', sampleSize: 1752, rigorStatus: 'day_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'Only a different kind of evidence reopens it: the user\'s blind labels (scope steps 3-4) or an up/down-tick delta that reproduces their Sierra pane; a re-run of the same features on more of the same entries will not.',
  extra: { looks: [162, 163], prereg: 'docs/TELL_STALL_FEATURES_KILL_TEST_PREREG_20261104.md', counted_tests: 10 },
});
console.log('claim recorded'); process.exit(0);
