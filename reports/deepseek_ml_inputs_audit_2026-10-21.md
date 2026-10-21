# ML input audit — final answer (VERIFIED = file:line read today; INFERRED = reasoning or brief, not re-verified here)

## 1. How inputs are handled — flaws

(a) Point-in-time correctness (training vs live)
- Training flattens STORED snapshots (ml_pd_features/ml_intraday_features, dataset.py:141-174); live recomputes the SAME features inline (mlLiveVetoGate.js:114-143) and PERSISTS ONLY THE VERDICT, not the vector it used (persistGateVerdict ON CONFLICT DO NOTHING, mlLiveVetoGate.js:253-259). Live-vs-training feature parity is therefore unverifiable for any gated row. VERIFIED.
- Bar boundary: live gate uses ts < NOW() (mlLiveVetoGate.js:124-127); the 60s retrospective scorer keys on ts < fired_at. Two different instants; usually identical bars, but any late run of the 60s pass vs a bar close shifts barsInSessionSoFar/recentDelta15Bars/sessionCumulativeDelta by one. Real smell, low magnitude. VERIFIED.
- Intraday session boundary is chosen by the call-site isRth flag (RTH 570 / Globex 1080, mlLiveVetoGate.js:87-88) while the stored snapshot's boundary comes from the row's is_rth column (mlFeatureSnapshot.js:88-92). If the two disagree, live and training bars differ. Two sources exist (VERIFIED); divergence INFERRED.
- EXISTING_FEATURE_COLS (nl30/confluence/minutes_from_open, dataset.py:92-94) are read off the row in training but passed as call-site args live (mlLiveVetoGate.js:185). Two bugs already caught in this hand-off (Globex minutes_from_open null, the 422 missing-key) prove it is fragile; nl30 is null for Globex in both paths (OK) but any new call site omitting nl30/confluence reproduces the same bug class. VERIFIED.
- Prior-day distances use trade_date < candidate (strictly prior day) — clean (mlFeatureSnapshot.js:36-58). VERIFIED.
- ATR enters only the un-shipped B-arm candidates (range/ATR20 ranked vs prior 60 sessions, docs/ML_INPUT_ABLATION_PREREG_20261020.md:12), not the live 22; its rolling 60-session baseline is the main point-in-time risk there. INFERRED.
- Sparsity: nl30 90% missing, confluence 31%, minutes_from_open 25% (dataset.py:58); LightGBM handles NaN natively (dataset.py:59-60), so a 90%-missing feature can still earn importance on its 10% present slice — sparse-signal illusion. VERIFIED.
- Column-count discrepancy: feature_cols(full=True) yields 24 (9 PD + 7 intraday + 3 migration + 3 existing + 2 direction; dataset.py:38-48,113,131-138), not the brief's "27"; 3 earlier-dropped cols (touch_quality_vol_z, is_rth_int per dataset.py:65-91) may account for the gap. Live list = 22 after TRIMMED_COLS (dataset.py:120). VERIFIED for 22/24.

(b) Label vs objective
- Label = "2.5x target (entry ± 2.5*(t1-entry)) hit before stop within 60 bars; stop wins ties; TIME=0" (mlExtendedLabelWalker.js:34-35,49-82). It predicts a RELATIVE home-run shape, not dollars. VERIFIED.
- User cares about actual_pnl after the REAL exit (stop/t1, extendTarget for STACK_VOL_BREAK_LIVE). A trade can hit 2.5x then round-trip to a real loss, or take 1x never reaching 2.5x → label 0. 2.5x/60-bar are fixed methodology constants (mlExtendedLabelWalker.js:28-33), not fitted to the real exit. VERIFIED.
- Consequence: the model optimizes AUC on a proxy the user never trades; Spearman(score,pnl)=0.006 on unseen trades is the expected symptom if the proxy is weakly/not correlated with dollars.

(c) Population / siblings / duplicates / junk
- REAL_TRADE_FILTER (dataset.py:23-28) has NO time-of-day clause → does not exclude 16:00-18:00 fires pre-2026-09-16 (brief). Clause verified absent; existence of such rows INFERRED. Those rows sit in the 4-6pm dead zone the gate itself skips (mlLiveVetoGate.js:8-10) yet still train the model.
- Cluster siblings are now KEPT (REAL_TRADE_FILTER, not POOLED; dataset.py:13-22, ~1760 siblings). Training down-weights them 1/group (dataset.py:242-261), but walkforward fold AUC is computed on the RAW fold rows INCLUDING all siblings (walkforward.py:160-162) → correlated siblings counted as independent samples, inflating fold AUC. CI-collapse lives JS-side in rigorDiagnostics, not in AUC. VERIFIED.
- Pooled roster vs live mix: model trains on all setup_types pooled (dataset.py:194-205); live trades differ structurally (level-fade vs momentum vs sweep) and the roster churned + PROMOTE_ALL_MODE over the window (brief). Train distribution ≠ live distribution at any instant. INFERRED.

(d) Nightly retrain / drift
- train.py retrains nightly with a NEW timestamped version (train.py:224) on a single chronological 60/20/20 split (train.py:39-58), threshold from VAL (train.py:151), within-session thresholds from VAL (train.py:176-177). Live serving uses the PROMOTED model via the weekly gate, so live can be up to a week stale. VERIFIED (nightly timestamp + weekly promotion), INFERRED on the staleness window.
- Not a sliding window (one split over all history) and walkforward is EXPANDING (walkforward.py:111-116); with ~40 distinct real days the effective N is tiny and nightly retrains jitter — the is_rth sign-flip at N<20 (dataset.py:73-91) is the canonical instability.

(e) Why held-out AUC ≠ unseen-trade result
- AUC is on the 2.5x LABEL; the unseen check is on actual_pnl — different targets (b). VERIFIED.
- Fold AUC includes correlated siblings as independent (c) → optimistic. VERIFIED.
- Operating point: AUC 0.5889 is a mild rank signal in the body; the policy only takes the top ~25% within session (walkforward.py:168), where the score can be flat while AUC looks nonzero.
- Non-stationarity: the unseen window postdates the training mix and had roster churn → stale population.
- enforce=false (mlLiveVetoGate.js:99) means the live gate never actually vetoes, so "policy minus random = 0.00" reflects a score with no monotone dollar signal, not necessarily a broken pipeline.

## 2. What we may be missing (ranked)
1. Setup-family / setup_type identity + interactions (pooled model averages structurally different trades). Test: add setup_type one-hot or train per family; pre-register family-stratified policy P&L + AUC.
2. Realized R-multiple regression target (actual_pnl/risk, or MFE-derived R net of exit) instead of the 2.5x binary — directly the dollar objective. Test: swap label_column for a regression y, keep features/folds.
3. Label-dollar bridge diagnostic (correlation of label AND score with actual_pnl) — cheapest, see section 3.
4. Time since level formed + touch count. Test: derive 2 cols from developing_value_log/touch history, walkforward.
5. Approach speed / path shape (bars since swing, velocity, straight-line vs choppy). Test: 2-3 cols from bars before fired_at.
6. Trailing same-setup performance / loss-cluster (stateful streak). Test: lag features of recent same-setup P&L/verdicts.
7. Session regime + calendar/event (day-of-week, FOMC/CPI, rollover). Test: categorical flags.
8. Cross-instrument context (ES/NQ divergence, breadth). Needs new data; pretest before wiring.
9. Order-book depth from Sierra .depth (~3.5 months). Test: pretest on the 3.5-month slice only.
10. Promote the ranking-among-simultaneous-candidates mechanism to live (online_rank_verdict already exists, walkforward.py:54-88, but is not the live mechanism). Test: ship behind a kill-switch with enforce=false.

## 3. Why every added input fails
Most likely: label mismatch (the 2.5x hit has weak/no dollar link) plus tiny true signal (~0.089 AUC above chance) with ~40 independent days, so any new input is indistinguishable from noise (null SD 0.0028, docs addendum A:30; only time-in-session + recent-15-bar carry AUC, docs addendum B:35-40). Secondary: population non-stationarity (roster churn) and sibling-inflated baseline AUC make "0.5889 to 0.5997" look real when the ONH/ONL policy CI still crosses zero (scratch/ml_level_distance_20261021.txt:4). The B-arms all gained ~equal AUC because their columns are blank on Globex = a disguised RTH flag (docs addendum A:32) — the gain was a missing-value/session artifact, not feature content.

Single diagnostic: compute Spearman(score, actual_pnl) AND Spearman(label, actual_pnl) on the walkforward folds with siblings collapsed and day-blocked. If label-to-pnl is about 0, the label is wrong and no input will help (stop adding inputs); if label-to-pnl is positive but score-to-pnl is about 0, the model cannot learn its own label (features/leakage); if both are positive in-sample but about 0 out-of-sample, it is non-stationarity.

## 4. Next three experiments
1. The section-3 diagnostic (sibling-collapsed, day-blocked label-to-pnl and score-to-pnl). Success criterion: it cleanly separates label-mismatch from non-stationarity from feature-uselessness. Decision: gates whether to keep hunting inputs at all — if label-to-pnl is about 0 we stop adding inputs and reframe the target.
2. R-multiple regression / expected-value reframe. Success: Spearman(score, actual_pnl/risk) on unseen folds > 0.1 with day-blocked 95% CI excluding 0, AND policy P&L/trade > 0. Decision: aligns the objective to dollars; if it works the gate selects profitable trades, not home-run shapes.
3. Per-family models or setup_type feature. Success: family-stratified policy P&L beats pooled by > 2 null SD AND the worst family improves. Decision: changes WHICH families fire — the actual lever the gate controls.
