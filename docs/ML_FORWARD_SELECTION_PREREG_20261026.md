# ML: cut to 4 inputs and build up (forward selection) — pre-registration (2026-10-25)

User decision 2026-10-25: "Why not cut the ML to 4 and build from there. I'm done being conservative." The ML meta-labeling model is log-only (`ML_VETO_GATE.enforce=false`), so this is a training-side change with no live trading effect. Committed BEFORE the selection run.

## Base (4 inputs)
`intraday_barsInSessionSoFar`, `minutes_from_open`, `intraday_recentDelta15Bars`, `drv_recentDeltaAligned15Bars` — the two groups whose removal moved fold AUC beyond the null band in `ml_input_ablation_and_candidates_20261020` (time in session -0.030, recent 15-bar delta -0.020). Everything else is a candidate to earn its way back.

## Candidate groups (14)
A1 prior-day level distances (6), A2 prior-day structure (3), A3 value migration (3), A4 developing-level distances (4), A5 session cumulative delta, A8 nl30, A9 confluence score, A10 trade direction, B1 day type (2), B2 order flow vs normal (2), B3 rotation gate and chop (3), L1 overnight high/low distances (2), L2 prior-week level distances (4), FAM setup family (native categorical). Same definitions and CSV exports as the earlier ablations.

## Procedure (greedy, same machinery as `ablation_new_features_20261020.py`)
Same population, 9-fold walk-forward, purge, hyperparameters, sample weights and approval mechanism (`walkforward.py` via `run_arm`). Each round, for every remaining candidate G: ARM = current set + G; CONTROL = current set + matching random columns (a random normal column per column of G with the same blank pattern; for FAM a shuffled-family column); noise band = SD of fold-averaged AUC over 8 null-column arms on the current set. Gain = ARM AUC − CONTROL AUC; z = gain / null SD; dollar diff = ARM policy per trade − CONTROL policy per trade (point estimate; day-blocked 99% CI reported, never required, because dollar intervals are about +/-1 per trade and cannot separate any model variant).
**Accept** the single candidate with the largest z among those with z >= 2 AND dollar diff >= 0. Repeat until no candidate qualifies or 6 rounds. Not conservative by design (user directive), but not blind: a candidate that raises AUC and lowers dollars is rejected.

## Report and caveats (frozen)
Per round: the full table (ARM AUC, CONTROL AUC, z, dollar diff and CI). Final: the selected model's fold AUC and policy per trade next to M0 (27 inputs, AUC 0.5859, +0.51), the 22-input model, the 17-input model (0.5986, +0.31) and the 4-input base. Forking paths: 14 candidates x up to 6 rounds on ONE walk-forward population, so the selected set is optimistic; the in-sample walk-forward AUC is not the verdict. The verdict is forward: the selected model is trained as the new checkpoint candidate and judged by the weekly unseen-trade scorecard (`ml_unseen_scorecard.mjs`) and the pre-registered ranking test (`ml_ranking_preregistered_test_20261027`); the roster-churn confound applies.

## What changes in the repo if run (training/logging side only)
`dataset.py`: `feature_cols()` returns the selected list (research can still pass `full=True` for the 27); nightly `train.py` models, the weekly walk-forward and checkpoint candidates train on it; the live checkpoint is swapped to a model trained on the selected set (log-only gate, reversible); `build_feature_dict()` keeps capturing every input so any group can be restored.
