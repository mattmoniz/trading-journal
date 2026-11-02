import { recordClaim } from '../record_claim.mjs';
await recordClaim({
  slug: 'roster_context_forecast_vs_fade_excursion_null_20261102',
  claimText: 'Roster-context Amendment 4 (committed before the run; look id 40; explore only; descriptive): on the 1,507 evaluated BACKFILL fade rows the 30-minute busy-forecast does NOT track the size of the trades own excursion. By forecast third mean mfe+mae is 73.7 / 75.3 / 74.6 points (low/mid/high), mean |pnl| 90.8 / 91.4 / 93.6 dollars; Spearman(forecast, mfe+mae) -0.026 (day-blocked CI -0.161..+0.107), halves +0.236 / -0.182; Spearman(forecast, |pnl|) -0.006. NOT SHOWN: any link between the 30-minute travel forecast and these trades. A likely but UNTESTED reason: mean excursion is about 74 points, far more than a typical 30-minute range, so the fades are held much longer than the forecast horizon (horizon mismatch). Resolution: correlations of about 0.13 or more in magnitude would have been seen. H4 (skip busy fades) stays NOT PASSED.',
  sourceFile: 'scripts/amt_context/run_p3b_output.txt', sourceDate: '2026-11-02', sampleSize: 1507, evPerTrade: null, rigorStatus: 'explore_only_descriptive_null_horizon_mismatch_untested', status: 'PROVISIONAL',
});
process.exit(0);
