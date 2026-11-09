// Records the claim for docs/RTH_REGIME_FLOW_PREREG_20261104.md (look 174, NOT SHOWN, underpowered). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'rth_regime_flow_not_shown_20261104',
  claimText: 'Pre-registered (ledger look 174, 3 counted tests, explore tick dates, 67 qualifying high-rotation mornings of 439 scored days, scaled legs by 11:00 at or above the expanding 90th percentile, week-block CI 98.33 percent): entering at 11:00 in the sign of the 09:30-11:00 up/down-tick flow with a 1 x ADR stop and a 15:55 exit does NOT show a direction edge: flow minus random +24.0 per trade [-69.4, +116.0] (placebo gate 140.1 not beaten), flow minus price momentum -41.3 [-188.0, +83.0], regime contrast +14.2 [-78.9, +111.1]; absolute mean +48.0 [-51.0, +134.9]. UNDERPOWERED: the detectable effect was about 110-160 dollars per trade, so it cannot say the mechanism is absent. Uncounted hint: on qualifying days the price-momentum sign (+89 per trade) did better than the flow sign (+48). The 2025-05..2026-10 era (where the regime is common) has no tick extraction; the overnight forward race remains the route.',
  sourceFile: 'scripts/tell_context/research_20261103/rth_regime_flow.py',
  sourceDate: '2026-11-04', sampleSize: 67, rigorStatus: 'week_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'A tick extraction of 2025-05 to 2026-10 (about 66 more qualifying days) and ONE sealed look, or a forward shadow arm; re-running the explore sample will not change it.',
  extra: { looks: [174], prereg: 'docs/RTH_REGIME_FLOW_PREREG_20261104.md', counted_tests: 3 },
});
console.log('claim recorded'); process.exit(0);
