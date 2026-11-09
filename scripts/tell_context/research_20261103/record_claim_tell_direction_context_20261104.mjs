// Records the claim for docs/TELL_AS_DIRECTION_CONTEXT_PREREG_20261104.md (look 173, NOT SHOWN). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'tell_direction_context_not_shown_20261104',
  claimText: 'Pre-registered (ledger look 173, 3 counted tests, 3,150 declustered ACTIVE+SHADOW fires on 73 dates, RTH 10:00-14:30, 2026-07-09..10-19, day-block CI 98.33 percent): the side of the active tell (latest V1 tell entry within 60 minutes, from the replay) does NOT sort shadow fires: AGREE minus AGAINST -4.21 per fire [-24.43, +14.30] (detectable 22.7; halves -24.71 / +7.42; placebo gate 10.22 not beaten), AGREE minus NONE -2.07 [-14.15, +9.67], AGAINST minus NONE +2.14 [-10.28, +14.85]; the sign flips with the window (30 minutes +3.55, any earlier tell today -9.32). Uncounted observation near the detectable floor: fires on the momentum side of the previous 60 minutes do worse than fires against it (-10.36 per fire, N 1,462 vs 1,651), consistent with the pool being mostly fades. Not tested: Globex fires, live tell fires, the tell as a size or stay-out context.',
  sourceFile: 'scripts/tell_context/research_20261103/tell_direction_context.py',
  sourceDate: '2026-11-04', sampleSize: 3150, rigorStatus: 'day_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'A longer span of live tell fires (the live detector runs since 2026-10-28) or a pre-registered momentum-versus-fade look; re-running this window will not change it.',
  extra: { looks: [173], prereg: 'docs/TELL_AS_DIRECTION_CONTEXT_PREREG_20261104.md', counted_tests: 3 },
});
console.log('claim recorded'); process.exit(0);
