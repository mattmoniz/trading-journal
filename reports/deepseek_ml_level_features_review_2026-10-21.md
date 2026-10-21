# DESIGN/METHOD CRITIQUE — six level-distance ML inputs (VERIFIED = read file:line; INFERRED = not directly opened)
Files read: mlLiveVetoGate.js, export_ml_level_distance_features_20261021.mjs, scoring_service.py, dataset.py, ML_LEVEL_DISTANCE_FEATURES_PREREG_20261021.md, mlFeatureSnapshot.js.

## 1. LOOKAHEAD / POINT-IN-TIME

### (a) level_prices PW rows + Globex trade_date semantics
- VERIFIED: level_prices.computed_at is written `NOW()` at cron write time (scripts/compute_levels.js:545,548), i.e. it records WHEN compute_levels ran, not a level "as-of" time. compute_levels runs Sun 21:30 ET (upcoming Mon), Mon-Fri 08:00 and 11:00 (ARCHITECTURE.md:80-82).
- VERIFIED: the export reads PW_VAH/PW_VAL/PW_HIGH/PW_LOW by trade_date with NO computed_at filter (export_ml_level_distance_features_20261021.mjs:8) — it uses the CURRENT, final level_prices table.
- Therefore YES: for Globex-hours candidates (trade_date = NEXT trading day) the Monday row is first written Sun 21:30 ET, i.e. AFTER Globex fires in Sun 18:00–21:30. The export assigns those rows a PW value that live capture at that fire minute would compute as NULL. This is an availability/train-serve skew, NOT a value-level leak: the PW value itself is backward-looking (prior calendar week, frozen before the session). INFERRED the PW value is stable across recomputation (prior week is closed) — but this must be confirmed against compute_levels.js's exact "prior week" definition before claiming it.
- Net: computed_at IS after fire time for a slice of Globex rows, and the export ignores it. Point-in-time is violated in AVAILABILITY, not in VALUE.

### (b) ONH/ONL for 16:00–18:00 and Globex fires
- VERIFIED RTH branch (export:15): fires minute∈[570,1080) = 09:30–18:00 get high/low of bars [day 00:00, day 09:30) — fully known at 09:30, so 16:00–18:00 fires are SAFE (pre-09:30 range).
- VERIFIED Globex branch (export:16): high/low of bars [prev-day 18:00, fi) with k<fi (strictly before fire) and ≥10 bars — developing value, no lookahead.
- BUT the plan says "same as the live StopSweep definition (acd.js ~5520)"; the export is a hand-rolled reimplementation (export:13-16), not a call to the live function. INFERRED StopSweep's real boundary may differ (e.g. midnight-vs-18:00 start, or a different pre-09:30 window). The offline result only transfers if live capture reproduces THIS exact logic, not StopSweep's.

### (c) Export vs what live capture could compute
- VERIFIED ATR20 mismatch: export uses `S.atr20(d)` from pocJoinLoader's sessionIndex (export:9), NOT `getRollingRthRange` as the plan/prereg claim (PREREG:5). Two different ATR definitions; one of the two stated definitions is wrong. Must reconcile before trusting the offline numbers.
- VERIFIED timezone/DST: export slices `fired_at::text` by string position (export:12: `day=slice(0,10)`, `minute=slice(11,13)*60+slice(14,16)`) and applies ET boundaries 570/1080 to it with no tz conversion. If the DB session renders timestamptz in UTC (typical), the boundaries are applied to a UTC clock → 4–5h off around DST. INFERRED (server TZ not confirmed) but the slicing is fragile by construction and will not match live (which uses real ET minute).
- VERIFIED ATR fallback `atrDate(r.d)||atrDate(day)` (export:9,12) keys ATR20 by trade_date or calendar day, not strictly "previous 20 completed sessions as of fire minute"; for RTH fires before close this can differ from a strict PIT ATR20.

## 2. PARITY AND BREAKAGE

Code paths building/consuming the feature dict:
1. Live inline: computeInlineFeatures (mlLiveVetoGate.js:114-143) → computePriorDayLevelFeatures + computeDevelopingValueFeatures; then scoreMlVetoGateInner flattens with pd_/intraday_ prefixes + migration one-hots + existing cols and POSTs {features, is_rth} (mlLiveVetoGate.js:185-200).
2. Stored snapshot: mlFeatureSnapshot.js computePriorDayLevelFeatures(:36-59) / computeDevelopingValueFeatures(:94-116); written by backfill_ml_pd_features.mjs, backfill_ml_intraday_features.mjs, and the 60s retrospective mlFireTimeScoring.js (all reuse the same functions).
3. Training read: dataset.py flattens the STORED JSONB (build_feature_dict :216-226) via explicit lists PD_FEATURE_KEYS(:38-41), INTRADAY_FEATURE_KEYS(:42-45), MIGRATION_CATEGORIES(:48). A missing key becomes a real NaN column, not a silent gap (dataset.py:33-37).
4. Scoring: scoring_service.py POST /score → score_candidate(bundle, features, threshold) (:128); score_candidate raises on a genuinely missing key → 422 (:128-133); required keys come from the bundle's feature_list (loaded via load_model), not a hardcoded list.
5. Silo/UI readers (mlSiloService.js etc.) are read-only and don't validate keys.

Breakage matrix (the asymmetry):
- NEW bundle needs six keys, OLD capture lacks them → dataset.py yields NaN columns for the ~7500 unbackfilled rows (silently trains on missingness), and live scoring returns 422 → mlLiveVetoGate's `!res.ok` path force-SHADOWs the candidate (mlLiveVetoGate.js:207-212) with only telemetry (noteFailClosed). Silent mass-suppression, not a wrong score.
- OLD bundle receives EXTRA keys → INFERRED harmless: LightGBM predict selects the trained columns; score_candidate only raises on MISSING keys (:129-131). Extra JSONB keys are ignored by dataset.py's explicit lists too.
- The minutes_from_open precedent is VERIFIED at mlLiveVetoGate.js:180-185: `undefined` was dropped by JSON.stringify → scorer 422 → force SHADOW. Exact same failure class applies to any of the six keys that computeInlineFeatures forgets to emit.

Safest order + rollback:
(1) Put the six-key computation in ONE shared JS module (export-the-real-function rule), called by BOTH computeInlineFeatures and the snapshot/backfill path — never two copies.
(2) Snapshot path first: add keys to mlFeatureSnapshot.js + the backfills, backfill ~7500 rows, verify counts.
(3) Then computeInlineFeatures, so live matches.
(4) Then dataset.py lists + build_feature_dict.
(5) Train RESEARCH-only (feature-flagged), do NOT promote; gate is already log-only (ML_VETO_GATE.enforce=false → scoreMlVetoGate returns shadow:false, mlLiveVetoGate.js:163-165).
Rollback = re-point ml_models.is_checkpoint to the prior bundle (scoring_service re-reads it per request, :51-52) and drop the six keys from dataset.py. Extra JSONB keys on capture are inert; the backfill is idempotent (UPDATE ... WHERE key IS NULL pattern) so keys can be left or nulled.

## 3. STATISTICAL CASE
- Per the frozen rule (PREREG:13) a set ADDS VALUE only if AUC beats its control by >2 null SD AND the 99% day-blocked P&L interval is above zero AND both fold halves positive. ONH+ONL AUC +6.5 SD passes the AUC leg but its P&L interval [-0.89,+1.50] includes zero → correctly NOT SHOWN. Prior-week four +1.2 SD → noise. All six +3.8 SD → also not shown. So under the repo's own pre-registered rule NOTHING is shown and nothing should be wired.
- "AUC beyond noise band but dollars indistinguishable" is exactly the trap PREREG:12 itself names: missing-value patterns alone move AUC up to +0.01. A feature that lifts ranking AUC but not the decision boundary into money is not an edge — it is either a missingness artifact or a ranking-only improvement with no economic content.
- Wiring all six is not justified: the prior-week four failed outright (+1.2 SD). Collinearity: PW_HIGH/PW_VAH/PW_LOW/PW_VAL are four distances from four near-duplicate weekly levels (high≈VAH side, low≈VAL side), constant within a week → they mainly encode "which week", redundant with existing pd_* distances and with each other; LightGBM tolerates it for prediction but it inflates the test surface and makes importances meaningless.
- ATR20 scaling is defensible in principle (vol-regime standardization), but (i) the export's ATR20 is sessionIndex.atr20, not the claimed getRollingRthRange, and (ii) a weekly-fixed level divided by a slowly-moving 20-session mean is near-constant within a week — which is why the PW four are weak.
- Multiple testing: this is 1 of ~10 candidate sets (day type, normalized flow, rotation gate, setup family, pace, dollar-trained target — all failed). The null-column control corrects for within-set column count, NOT for the ~10-set family. A Bonferroni/Deflated-Sharpe across the family shrinks 6.5 SD materially. The 6.5 SD is encouraging for ONH+ONL only, and even that fails the P&L leg.

## 4. WORTH DOING / NOT DOING
- The single check that must precede wiring: prove the live checkpoint predicts unseen P&L. It currently doesn't (approvals−random 0.00/trade, Spearman(score,pnl)=0.006). Any new feature is measured as "improvement over a baseline that adds nothing" — i.e. improvement over noise — until that is fixed.
- Cheaper alternative: use ONH/ONL/PW levels as a deterministic TAG or RULE ("entry within X ATR of ONH → flag/skip"), not a model input. The ONH/ONL fades already exist as separate setup_types in the population, so a rule/tag can be evaluated on the existing roster with no retrain, no 7500-row backfill, no scorer-contract change.
- Recommendation: DO NOT wire now. Fix/verify checkpoint value first. If unfixable, a model-input change is pointless. If fixed, wire ONH+ONL only (the only arm that cleared AUC) and re-run the frozen P&L rule; drop the prior-week four.

## 5. MINIMAL WIRING SPEC (only if #4 gate passes)
Files: (1) shared module (new or mlFeatureSnapshot.js) exporting computeLevelDistanceFeatures({entry, tradeDate, firedAtET, bars, isRth}) — ATR20 via getRollingRthRange(beforeDate=fire date), ONH/ONL via the EXPORTED StopSweep definition, PW via level_prices with an explicit availability rule for Globex (decide: null if row's computed_at is after fire time). (2) mlLiveVetoGate.js computeInlineFeatures → call it; emit all six keys (any missing key = 422 → silent SHADOW). (3) mlFeatureSnapshot.js + backfill_ml_pd_features.mjs / backfill_ml_intraday_features.mjs / mlFireTimeScoring.js → write the six keys into ONE chosen JSONB blob (decide pd_ vs intraday_ prefix and make dataset.py match). (4) dataset.py feature lists + build_feature_dict. (5) No scoring_service change (it is key-driven). Retrain nightly; do NOT promote; unseen-scorecard + promote_weekly_checkpoint.py decide.
Parity test that MUST pass before the backfill is trusted: sample ~50 historical rows spanning RTH, 16:00–18:00, Globex, and DST transition dates; compute all six features two ways — (a) the new shared JS function fed bars strictly < fired_at, and (b) the export script's exact logic — and assert bitwise equality of every value AND the null pattern on every row. Also assert (c) shared ONH/ONL == acd.js StopSweep on the sample, and (d) shared ATR20 == getRollingRthRange. Any mismatch means the offline result does not transfer and the backfill/retrain is invalid.
