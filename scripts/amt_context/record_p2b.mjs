import { recordClaim } from '../record_claim.mjs';
await recordClaim({
  slug: 'roster_context_tell_adds_nothing_beyond_range_20261102',
  claimText: 'Roster-context study Amendment 2 control H3b2 (committed BEFORE the run; explore only; same walk-forward ridge for E_30, 23,624 out-of-sample rows on 396 dates; ledger look 38). With recent realized range (rr15, rr30, rr60 in ATR20 units) added to the activity set of both models: out-of-sample Spearman baseline 0.263, no-tell model 0.647, full model with tell features 0.649. Tell increment +0.0023 (day-blocked CI -0.0024..+0.0072, permutation p 0.115, halves +0.0034/+0.0022) = NOT PASSED. Under the pre-registered reading rule: once recent realized range is controlled, the tell adds nothing measurable for E_30 (the earlier +0.0155 of H3b was recent volatility carried by the tell features); the tell is a volatility marker for this target. Adding recent range also lifts the forecast itself from 0.603 to about 0.649. NOT SHOWN: any tell-specific information about expansion, anything in dollars, any side. Resolution: effects of the tell above about 0.007 rank correlation would have been seen.',
  sourceFile: 'scripts/amt_context/run_p2b_output.txt', sourceDate: '2026-11-02', sampleSize: 23624, evPerTrade: null, rigorStatus: 'explore_only_null_for_tell_increment_forecast_works', status: 'PROVISIONAL',
});
process.exit(0);
