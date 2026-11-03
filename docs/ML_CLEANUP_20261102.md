# ML cleanup, 2026-11-02 (user: "Can we clear up any ML items that aren't useful or working?" then "If it's useful keep it but if not...")
Rule applied: keep an item only if it feeds a decision, answers an open question that new data can still change, or is the monitor for something still running. Everything below was judged from the recorded claims and live state, not from memory. Nothing live changed: no server file was edited (nodemon watches `server/` and would restart the server and disarm Sim1), no order path touched.

## Removed or stopped (and why)
| Item | Evidence | Action |
|---|---|---|
| Binary model (frozen tick-trend fade) tab + daily recheck | Frozen model scored on 2,678 new trades over 25 days: AUC 0.5228 (claim `tick_trend_efficiency_fade_outcome_provisional_20260923`); sliding-window retrain AUC 0.5205, permutation p 0.16. Barely above chance, day-clustered over 25 days, no pre-registered dollar bar met | quick-check tab removed; daily step `recheck_tick_trend_fade_finding.mjs` removed |
| Ordinal reach_R model tab + daily recheck | Spearman 0.0299, 200-permutation p 0.345, calibration not monotone, 1,228 trades / 12 days (claim `ordinal_reach_r_track_b_harness_20260924`); the all-setups variant was negative | tab removed; daily step `recheck_ordinal_reach_r_finding.mjs` removed |
| Propensity table | `SETUP_PROPENSITY_SCREEN` rows are one snapshot from 2026-09-24 (215 rows, never recomputed, last_run 09-24), shown on the phone as if current; not an ML model | tab removed |
| ML gate + step-trail coupling daily recheck | N=47, CI [-3.15,+20.78] includes zero, both halves individually unvalidated (claim `ml_metalabel_gate_plus_step_trail_exit_coupling`) | daily step removed |
| ML probability-sizing pretest daily recheck | Spearman 0.083, not monotone, HIGH-confidence tercile worst (claim `ml_metalabel_probability_sizing_pretest`); the user trades exactly 1 MNQ so sizing by score has no use | daily step removed |
| Globex-split daily recheck | Globex TAKE +$23.67 (N=141, CI excludes zero) but the sign flipped in one retrain earlier (claim `ml_metalabel_globex_specific_discrimination`); the weekly unseen scorecard now reports by session | daily step removed |
| Pre-registered ML ranking test daily step | Ran once, verdict FAIL (claim `ml_ranking_test_result_20261027`): top pick +$16.34 per window but beats random in 56% of windows, bar was 60%; "ML is dropped as a ranker; scores stay as logging only" | daily step removed (script kept as the record of the test) |
| 27-input model path | Already retired in code: new models train on 4 inputs (`dataset.py`, `feature_cols(full=True)` only for research) | no action needed |

## Kept, and why
- Meta-Labeler chain (daily `train.py`, `run_silo_scoring.py`, `recalibrate_ml_walkforward.mjs`; weekly checkpoint promotion and `ml_unseen_scorecard.mjs`; the quick-check Meta-Labeler panel and the React ML view): it still scores every candidate (log only, `ML_VETO_GATE.enforce=false`) and the unseen scorecard needs 20 unseen days (3 so far) to judge it. This is the one open question that new data can still answer. Proposed sunset if the scorecard has not passed by end of December 2026: pending user decision `ml_metalabeler_chain_sunset_20261102`.
- Forecast service and regime gauge (volatility nowcast, shadow): they measure size not direction, but they are collecting forward data and are cheap.

## Left in place on purpose (needs a server restart, so batched)
The three history/propensity routes in `server/routes/setups.js` (`tick-trend-fade-history`, `ordinal-reach-r-history`, `propensity-screen`, `frozen-model-dollar-illustration`) and the scripts above (`recheck_*`, `recalibrate_ml_step_trail_comparison.mjs`, `recalibrate_ml_probability_sizing_pretest.mjs`, `recalibrate_ml_globex_split.mjs`, `report_tick_trend_fade_history.mjs`, `scripts/tick_microstructure/*` frozen-model scorers) are now unscheduled and unreferenced by any page. Editing `server/` restarts the server and disarms Sim1, so deleting them waits for the next planned restart (OPEN_THREADS follow-up).
