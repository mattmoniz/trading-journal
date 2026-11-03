import { recordClaim } from './record_claim.mjs';
const src = 'docs/ML_CLEANUP_20261102.md', d = '2026-11-02';
const fin = (slug, text, n) => recordClaim({ slug, claimText: 'FINAL, daily recheck retired 2026-11-02 (docs/ML_CLEANUP_20261102.md). ' + text, sourceFile: src, sourceDate: d, sampleSize: n, rigorStatus: 'retired_final', status: 'CONFIRMED' });
await fin('tick_trend_efficiency_fade_outcome_provisional_20260923', 'Not useful: the frozen model scored 2,678 new trades over 25 distinct days at AUC 0.5228 (the pre-registered single look, floor of 20 days met); the sliding-window retrain gave AUC 0.5205, permutation p 0.16. Barely above chance and day-clustered; no dollar bar was met. Tab and daily job removed.', 2678);
await fin('ordinal_reach_r_track_b_harness_20260924', 'Not useful: Spearman 0.0299, 200-permutation p 0.345, calibration not monotone, 1,228 trades over 12 days; the all-setups variant was negative. Tab and daily job removed.', 1228);
await fin('ml_metalabel_gate_plus_step_trail_exit_coupling', 'Not shown: N=47 ML-approved trades with a step-trail hypothetical, delta CI [-3.15,+20.78] includes zero; neither piece is validated. Daily recheck removed.', 47);
await fin('ml_metalabel_probability_sizing_pretest', 'Negative and moot: Spearman 0.083 between probability and P&L, not monotone, HIGH tercile worst; the user trades exactly 1 MNQ so score-based sizing cannot be used. Daily recheck removed.', 881);
await fin('ml_metalabel_globex_specific_discrimination', 'Unresolved and noisy: Globex TAKE +$23.67 per trade (N=141, 15 days, CI [4.89,51.91]) but the sign flipped with one retrain at N<20 earlier. No longer rechecked daily; the weekly unseen scorecard reports by session. Not a basis for wiring.', 141);
process.exit(0);
