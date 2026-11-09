// Records the claim for docs/OVN_HARX_STOP_PREREG_20261104.md (look 172, NOT SHOWN). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'ovn_harx_stop_not_shown_20261104',
  claimText: 'Pre-registered (ledger look 172, 3 counted tests, 736 scored nights of the overnight flow-sign trade, 2023-03..2026-11, week-block CI 98.33 percent; not sealed, the 2026 outcomes of the base trade were already read): a stop scaled by the HAR-X width forecast (causal at 00:00, overnight range so far) with the mean stop held at 400 points does NOT beat the fixed 400-point stop (-0.41 per trade, CI [-8.96, +7.46], placebo gate 7.67 not beaten), does NOT beat the baseline-width control (-2.31, [-6.85, +1.94]) and changes nothing on the 87 nights with 6+ rotation legs (+3.17, [-43.75, +52.74]; fixed +239.1, HAR-X +242.3). Any width scaling is about +1 to +2 per trade, inside the noise. RISK: scaled stops reach much wider on high-width nights, so the worst night is -1,970 (HAR-X) vs -802 (fixed), about the whole 2,000 dollar trailing floor; the 5th percentile night improves slightly (-672 vs -802). A tighten-only / capped scaled stop is untested. The width-scaled-stop idea is closed for this trade.',
  sourceFile: 'scripts/tell_context/research_20261103/ovn_harx_stop.py',
  sourceDate: '2026-11-04', sampleSize: 736, rigorStatus: 'week_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'A capped or tighten-only scaled stop, pre-registered with its own look, or the forward race (a WIDTH arm in ovnArms); re-running this design will not change it.',
  extra: { looks: [172], prereg: 'docs/OVN_HARX_STOP_PREREG_20261104.md', counted_tests: 3 },
});
console.log('claim recorded'); process.exit(0);
