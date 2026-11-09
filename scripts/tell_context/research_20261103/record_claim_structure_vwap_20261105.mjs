// Records the claim for docs/STRUCTURE_MODEL_VWAP_PREREG_20261105.md (look 177, NOT SHOWN). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'structure_model_vwap_not_shown_20261105',
  claimText: 'Pre-registered (ledger look 177, 2 counted tests, explore, 1,424 scored rows on 356 days at 10:30, 11:30, 13:00, 14:30, week-block CI 97.5 percent, circular-shift placebo): the RTH VWAP and Globex VWAP (signed and absolute distance in ADR, their spread, the RTH distance in sigma) add NOTHING to the market-structure model: for the next-hour RANGE -0.76 percent of the M2 loss (CI [-0.00226, +0.00008], detectable 1.1 percent), for the next-hour DIRECTION -0.37 percent of the FULL loss (CI [-0.00080, +0.00024], detectable 0.9 percent). Filter view (uncounted): the direction skew above vs below the Globex VWAP is about 0.03 ADR an hour (below costs and the detectable effect); the visible pattern is volatility (below either VWAP the next hour range is about 22-24 percent larger) but it is already carried by the price-movement and now-versus-lately groups. No filter proposed; VWAP stays a display context.',
  sourceFile: 'scripts/tell_context/research_20261103/structure_model_stepA.py',
  sourceDate: '2026-11-05', sampleSize: 1424, rigorStatus: 'week_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'Other VWAP definitions (weekly, monthly, anchored) or VWAP bands as a level-touch input, pre-registered; re-running this design will not change it.',
  extra: { looks: [177], prereg: 'docs/STRUCTURE_MODEL_VWAP_PREREG_20261105.md', counted_tests: 2 },
});
console.log('claim recorded'); process.exit(0);
