// Records the claim for docs/OVERNIGHT_INVENTORY_PREREG_20261104.md (look 166, NOT SHOWN). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'overnight_inventory_not_shown_20261104',
  claimText: 'Pre-registered (ledger looks 166 and 167 incl. amendment A1 after DeepSeek round V; counted T1 and T3, T2 UNTESTABLE; explore, 501 sessions): overnight INVENTORY (net up/down-tick volume share, side s) against its cost basis (overnight VWAP) vs the RTH open. Stress S>0 (open on the wrong side of the basis) in 98 sessions, S<0 in 403. First-hour rotation against the inventory, S>0 minus S<0: -0.013 ADR, week-block CI [-0.119, +0.093], halves +0.026 / -0.053, detectable 0.131 ADR (about 27 points at the explore-era median ADR of 205): NOT SHOWN; continuous regression (A1, valid circular-shift placebo) b(s x D) +0.009 CI [-0.225, +0.249], halves +0.194 / -0.116: NOT SHOWN. T2 (extreme inventory) is UNTESTABLE, not a null (6 of 150 extreme sessions open underwater: the share underwater falls 36.5 / 18 / 4.2 percent across |I| terciles, extreme one-sided flow almost always validates at the open). The first sign-permutation placebo was invalid by construction and is ignored (replaced in A1); the gap-fill descriptive (61 vs 35 percent) is a gap-size artifact (within gap tertiles 72 vs 72, 44 vs 37, 25 vs 6). Other inventory definitions, 2026 and a trade are untested.',
  sourceFile: 'scripts/tell_context/research_20261103/overnight_inventory.py',
  sourceDate: '2026-11-04', sampleSize: 501, rigorStatus: 'week_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'A different definition of inventory from the user (how they read the overnight profile) pre-registered first, or 2026 data via one sealed look; re-running this definition will not change it.',
  extra: { looks: [166, 167], prereg: 'docs/OVERNIGHT_INVENTORY_PREREG_20261104.md', counted_tests: 2, untestable: 1 },
});
console.log('claim recorded'); process.exit(0);
