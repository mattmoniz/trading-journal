# Pre-registration: train the gate on dollars instead of the 2.5x hit — 2026-10-20

Written and committed BEFORE any arm is run. Origin: `OPEN_DECISION ml_gate_label_vs_dollars_target_20261020`; the user asked how to use time of day best and delegated the next steps. Context read before writing this (descriptive, not tests): by time of day the 2.5x hit rate falls (RTH 21-24 percent early, about 13 percent late) while the dollar win rate is flat (43-47 percent) and realized P&L is not helped by a longer target in any time bucket (replays at 2.5x/5x/10x vs actual: every day-blocked interval crosses zero; 5x/10x mostly worse). So time of day is not shown to be a gate or an exit lever; its use is as a model input. The gate, though, is trained on a label (2.5x hit) that points the opposite way from dollars in early RTH.

## Data and machinery
Identical to `docs/ML_SIMPLE_RULE_AND_FAMILY_PREREG_20261020.md`: same 7,300 rows, 27-input research baseline, expanding 7-day folds, 3-day purge, 500-row minimum, hyperparameters from `ML_HYPERPARAMS`, sample weights, approval = score at or above the 75th percentile of the fold's training scores per session type (pooled fallback below 20 rows), policy P&L per trade over every test trade (missing P&L counts 0). Only the training target changes.

## Arms
- **M0:** current model (target = 2.5x hit, binary).
- **D1:** LightGBM regressor on realized `actual_pnl` (rows with missing P&L count 0), the target clipped to the 1st and 99th percentile of the fold's training P&L (derived per fold). Score = predicted P&L.
- **D2:** binary classifier on "dollar win" = `actual_pnl > 0`. Score = predicted probability.
- Same 27 inputs in all arms. Reference lines: take everything, and random approval of the same fraction.

## Comparisons and rules (frozen)
Two comparisons, D1 vs M0 and D2 vs M0, on the paired per-trade policy-P&L difference, day-blocked bootstrap 99 percent interval (2000 draws), sign in the first and second half of the folds. DOLLAR TARGET HELPS if the interval lies above zero with both halves positive. Otherwise it is not shown. AUC is reported against both labels (2.5x hit and dollar win) for information only; AUC against the dollar-win label is not comparable to the existing AUC numbers. Intervals are expected to be wide (about +-1 to 2 dollars per trade); "not shown" will not mean "equal".

## Known limits
Roster-churn confound; the in-sample training score distribution sets the threshold (same as the live mechanism), which can differ in shape between a regressor and a classifier and change the approved fraction, so the approved count is reported for every arm; not DeepSeek-reviewed; the fold structure is shared, the model class is not (a regression objective with the same tree hyperparameters).
