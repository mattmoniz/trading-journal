# Pre-registration: does the ML gate beat a simple time-of-day rule, and does setup family help it — 2026-10-20

Written and committed BEFORE any arm is run. Origin: `OPEN_DECISION ml_model_next_steps_baseline_family_pace_20261020` (user, in order: (1) test a simple time-of-day rule against the model, if the rule does as well the model adds nothing; (2) check whether setup type is a model input; (3) add pace and see whether it beats the simple rule). This document covers steps 1 and 2. Step 3 (pace) gets its own addendum, written before its arm is run. Research only, offline, nothing wired, the live model and its nightly training are untouched.

## Fact check for step 2 (read from code, not a test)
`scripts/ml_meta_labeling/dataset.py::feature_cols()` has no setup type or family column. `setup_type` is carried as metadata only. The earlier Phase 1 pilot (`pilot_phase0_shuffle_placebo_v4_with_family_20261007.py`) did give the model a family input, but that model predicted a stop/target multiplier, not the live TAKE/VETO gate. So the live gate has never been tested with family.

## Data and machinery (identical to `docs/ML_INPUT_ABLATION_PREREG_20261020.md`)
Same rows (`fetch_training_dataframe(full_features=True)`, the 27-input research baseline = the live checkpoint's input list), same expanding 7-day folds with 3-day purge and 500-row minimum, same LightGBM hyperparameters, same sample weights, same approval rule (a fold row is approved when its score is at or above the 75th percentile of the fold's TRAINING scores, computed separately for RTH and Globex, falling back to pooled below 20 rows), same policy metric (P&L per trade over every test-fold trade, a vetoed trade counts 0, missing `actual_pnl` counts 0), same fold-averaged AUC against the 2.5x label. Rules are scored by exactly the same fold loop, so rows line up one-to-one with the model arms.

## Step 1: simple rules (fitted on each fold's training rows only)
- **Time axis (point-in-time):** minutes since the session opened, from `fired_at` (naive ET digits): RTH `minute_of_day - 570`; Globex `(minute_of_day - 1080) mod 1440`. Bin edges are the 5 interior sextiles of the training rows of the SAME session type (6 bins), recomputed every fold.
- **R1 time rule:** score = shrunk mean training `actual_pnl` of the row's time bin, within its session type.
- **R2 time x flow rule:** cell = time bin x tercile of `drv_recentDeltaAligned15Bars` (terciles from training rows of the same session type; a missing value is its own cell). Score = shrunk mean training `actual_pnl` of the cell.
- **R3 family rule (step 2 comparison):** score = shrunk mean training `actual_pnl` of the row's setup family (family = `setup_type` with the trailing `_LONG`/`_SHORT` and anything after removed, the same definition the v4 pilot used). Families unseen in training get the session mean.
- **Shrinkage:** score = (sum of cell P&L + k x session-type training mean) / (cell n + k), with k = the median cell size in that fold's training rows (derived from the data, no constant).
- Approval uses the same 75th-percentile-of-training-scores mechanism as the model. Because a rule score takes few distinct values, ties at the threshold approve the whole tied cell; the approved count is reported for every arm.
- Reference lines printed for context: take-everything policy P&L (the all-trades mean) and random approval of the same fraction (all-trades mean x approved fraction).

## Step 2: model arms
- **M0:** the 27-input baseline (same as the ablation baseline). **M22:** the live-trimmed 22-input list, shown for reference.
- **F1:** M0 plus `family` as a native LightGBM categorical (category set = every family in the whole dataset, so later folds see consistent codes).
- **F2:** only time-in-session and recent-15-bar delta (the two groups that carried the AUC in the ablation: `intraday_barsInSessionSoFar`, `minutes_from_open`, `intraday_recentDelta15Bars`, `drv_recentDeltaAligned15Bars`) plus `family`.
- **Noise bands:** 8 null arms = M0 plus one pure-noise numeric column (as in the ablation) give the SD for comparisons not involving family. 8 shuffled-family arms = M0 plus a `family` column whose values are randomly permuted across rows (same cardinality and frequency, no link to outcome) give the SD used for F1 and F2 (a high-cardinality categorical can raise or lower AUC by chance alone). F2 is compared to M0 using the larger of the two SDs.

## Comparisons and decision rules (frozen)
Comparisons made: M0 vs R1, M0 vs R2, M0 vs R3, F1 vs M0, F2 vs M0 = 5. All intervals are day-blocked bootstrap 99 percent (resample trading days, 2000 draws) on the paired per-trade policy-P&L difference, with the sign reported in the first and second half of the folds.
- **Step 1 verdict, model vs rule (M0 minus rule):** MODEL ADDS if the fold-AUC gain is above 2 noise SD AND the policy interval lies above zero. RULE IS AS GOOD if neither the AUC gap exceeds 2 noise SD nor the interval excludes zero (the user's reading: the model is not adding anything the rule does not). RULE IS BETTER if the model's AUC is below the rule's by more than 2 noise SD or the interval lies below zero. "As good" is not evidence of equality: the intervals are wide (about +-1 dollar per trade) and the report must say what could not be shown.
- **Step 2 verdict (arm minus M0):** FAMILY HELPS if the AUC gain is above 2 shuffled-family SD AND the policy interval lies above zero with both halves positive. Otherwise research-only.
- Any result is recorded with `recordClaim()`; nothing changes live whatever the result.

## Known limits (stated in advance)
Roster-churn confound (pooled window, many setup types appear mid-window); family is correlated with time of day and direction by construction; the 75th-percentile approval fraction is fixed by the live mechanism, not tuned for either arm; the scripts are not DeepSeek-reviewed; rules and the model are scored on identical rows so a family that is only in the test fold (never in training) falls back to the session mean for the rule and to LightGBM's unseen-category handling for the model.
