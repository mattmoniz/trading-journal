// Records the claim for docs/STRUCTURE_MODEL_STEP_A_PREREG_20261104.md (look 175: T1 LEAD, T2 and T3 NOT SHOWN). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'structure_model_stepA_20261104',
  claimText: 'Pre-registered (ledger look 175, 3 counted tests incl. amendment A1, explore, 476 complete days / 1,904 rows at 10:30, 11:30, 13:00 and 14:30, 1,424 scored rows on 356 days, week-block CI, circular-shift placebo): the next-hour range (ln of the high-low over the next 60 minutes / ADR) is predictable from intraday price-movement state and now-versus-lately readings beyond HAR-X + clock: +24.88 percent of the baseline loss, CI [+0.03525, +0.05537], both halves positive, placebo gate beaten (LEAD; detectable 7.0 percent). Auction-structure principles (prior-day high/low and value-area position, balance streak, unfinished business, gap, 5/20-day context) add NOTHING (-1.10 percent, CI includes 0); the extra overnight picture (net move, drive, delta share, V extents, overnight legs) slightly hurts (-1.86 percent). Strongest inputs: tick volume of the last 30 minutes vs its 20-session norm, scaled rotation legs so far, position in the day range. A linear ridge beats a gradient-boosted challenger at this N (+24.1 vs +18.2 percent). This is a volatility-state forecast of a RANGE, not a direction or a trade.',
  sourceFile: 'scripts/tell_context/research_20261103/structure_model_stepA.py',
  sourceDate: '2026-11-05', sampleSize: 1424, rigorStatus: 'week_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'Forward shadow data (nightly retrain, weekly scorecard); the sealed hold-out needs tick data for the later era; re-running the explore sample will not change it.',
  extra: { looks: [175], prereg: 'docs/STRUCTURE_MODEL_STEP_A_PREREG_20261104.md', counted_tests: 3 },
});
console.log('claim recorded'); process.exit(0);
