# Training dataset extraction for the meta-labeling model.
#
# REAL_TRADE_FILTER below is a hand-mirrored copy of scripts/backtest_setup_status.mjs's
# own JS-exported constant -- there is no cross-language import mechanism in this repo, so
# this is a KNOWN, deliberate duplication (unlike everywhere else in this codebase, where
# "export the real function" means literally reusing the same JS function). Kept in sync
# manually; if backtest_setup_status.mjs's REAL_TRADE_FILTER text ever changes, this must
# be updated to match. Current text as of 2026-09-21:
#   REAL_TRADE_FILTER = origin_status IN ('ACTIVE','SHADOW') AND (resolution_method IS NULL
#     OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM')) AND
#     ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE
#
# CORRECTED 2026-09-21 (user request: "I think I want it to assess at individual levels"):
# was POOLED_TRADE_FILTER (REAL_TRADE_FILTER + "AND is_cluster_primary"), which silently
# excluded ~1,760 real cluster-sibling touches (~35% of the real population) from ever
# being trained on or scored. Per REAL_TRADE_FILTER/POOLED_TRADE_FILTER's own header
# comment in backtest_setup_status.mjs: POOLED_TRADE_FILTER is for a CROSS-setup_type
# aggregate consumer (avoids double/triple-counting one touch event once per cluster
# member); a PER-row consumer that scores each candidate on its own setup_type/features --
# exactly what this model does -- should use REAL_TRADE_FILTER, since there's no
# within-type double-count to guard against and excluding siblings just throws away real,
# independently-labeled training/scoring rows for no reason.
REAL_TRADE_FILTER = """
    origin_status IN ('ACTIVE','SHADOW')
    AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM'))
    AND ib_window_stale_basis IS NOT TRUE
    AND stale_entry_price_basis IS NOT TRUE
"""

import numpy as np
import pandas as pd

# The exact feature columns pulled out of the ml_pd_features/ml_intraday_features JSONB
# blobs (server/services/mlFeatureSnapshot.js's own field names) -- kept as an explicit list
# here (not `SELECT *` on the JSON) so a schema change in either JSONB shape fails loudly
# (a missing key becomes a real NaN column, not a silent gap) rather than silently
# reshaping the training matrix.
PD_FEATURE_KEYS = [
    'distToPdHigh', 'distToPdLow', 'distToPdClose', 'distToPdPoc', 'distToPdVah', 'distToPdVal',
    'pdRange', 'pocDeltaVsPrior', 'vaOverlapPctVsPrior',
]
INTRADAY_FEATURE_KEYS = [
    'distToDevPoc', 'distToDevVah', 'distToDevVal', 'distToDevVwap',
    'sessionCumulativeDelta', 'recentDelta15Bars', 'barsInSessionSoFar',
]
# migrationDirVsPrior is categorical (HOLDING/HIGHER/LOWER) -- one-hot encoded separately,
# not included in the plain numeric key lists above.
MIGRATION_CATEGORIES = ['HOLDING', 'HIGHER', 'LOWER']

# Existing active_setups columns already snapshotted at detection time (per the DeepSeek
# Phase 0 critique's own finding -- about half the spec's ~35 features are already stored)
# -- reused directly, not recomputed. CORRECTED 2026-09-21 after directly measuring real
# coverage across the full pooled training population (never assume, per this codebase's
# own standing discipline): `rvol_20d_at_detection`/`or_range_at_detection` are 100%
# missing here -- both are Setup-D-only fields (OPENING_DRIVE_15MIN_LONG/SHORT), null for
# every other setup_type, so across the whole roster they're pure noise -- EXCLUDED, not
# included as DeepSeek's critique assumed. The remaining 3 are genuinely sparse but not
# empty (`nl30_at_detection` 90% missing, `confluence_score_at_detection` 31% missing,
# `minutes_from_open` 25% missing) -- kept, since LightGBM natively handles missing values
# via its own split-direction learning rather than needing imputation, but this sparsity is
# real and worth remembering when reading feature importances later (a sparse feature can
# still show up as "important" on the rows where it exists without being broadly useful).
# regime_pos_*/size_factors_at_detection deferred to a later iteration, same reasoning.
#
# `touch_quality_vol_z` REMOVED 2026-09-21 (DeepSeek full-review finding #1, independently
# verified against resolveSetups.js/touchQuality.js before acting): it is NOT snapshotted at
# detection time despite this file's own prior comment claiming so -- it's written during
# trade RESOLUTION from the max volume z-score across bars AFTER fired_at (touchQuality.js's
# post-touch reaction window). Training on it is a real lookahead leak -- the model could
# learn "loud volume after entry -> TARGET", which is unknowable at the moment a live
# candidate would actually be scored. Also unrecoverable at promotion time: a live scorer
# has no post-entry bars yet, so this feature could never be populated outside a backtest.
# `is_rth_int` added 2026-09-21, REVERTED 2026-09-22 (OPEN_DECISION
# ml_silo_deepseek_followup_review_parked_20260921, item 1). Original motivation (user:
# "Globex is killing me every which way... make a distinction between time of day/Globex...
# which trades to fire") was real, not a guess -- splitting the model's out-of-sample results
# by is_rth found real-looking discrimination (RTH TAKE avg=$22.18 vs GLOBEX TAKE avg=$42.19,
# N=15, thin). DeepSeek's full-code-review flagged this as likely noise: adding the feature
# flipped the thin Globex TAKE bucket's sign on the very next retrain (was +$42.19/N=15, then
# -$35.50/N=14) -- a sign flip at N<20 either side is itself the signature of noise, not a
# real improvement. Re-tested 2026-09-22 (scratch/compare_is_rth_int_20260922.py) once real
# Globex N had grown, per DeepSeek's own stated condition for revisiting: a walk-forward
# WITH-vs-WITHOUT comparison still showed Globex TAKE thin (N=14 vs N=20, still under this
# codebase's own N>=20 floor) and the average swung wildly ($14.86 -> $41.49) from removing
# just this one feature -- the same instability signature, not resolved by more data. RTH was
# essentially a wash either way ($10.66 vs $10.49/trade). Reverted per DeepSeek's original
# recommendation -- a feature with no stable demonstrated benefit stays out, matching this
# codebase's own "no static thresholds/unproven inputs" discipline. `is_rth` itself remains
# available as a real, non-nullable GENERATED boolean column (server/schema.sql,
# [9:30,16:00) ET) if a future session wants to re-test this with a larger real Globex
# population -- the column isn't gone, just not currently a training feature.
EXISTING_FEATURE_COLS = [
    'nl30_at_detection', 'confluence_score_at_detection', 'minutes_from_open',
]


def feature_cols():
    """The full ordered feature column list -- same shape fetch_training_dataframe() returns
    as its second value, but callable without a DB connection/query. Used internally by
    fetch_training_dataframe() itself (single source of truth for the column list). Fire-
    time scoring (score_one.py) deliberately does NOT use this -- it reads the feature list
    off the persisted model bundle instead (bundle['feature_cols']), which is the more
    correct source there: it reflects exactly what THAT specific model was trained on, and
    stays correct even if this list changes for a later-trained model."""
    return (
        [f'pd_{k}' for k in PD_FEATURE_KEYS]
        + [f'intraday_{k}' for k in INTRADAY_FEATURE_KEYS]
        + [f'pd_migration_{c}' for c in MIGRATION_CATEGORIES]
        + EXISTING_FEATURE_COLS
    )


def build_feature_dict(pd_features: dict, intraday_features: dict, existing: dict) -> dict:
    """Single-row equivalent of fetch_training_dataframe()'s own flattening logic, extracted
    2026-09-21 so score_one.py (fire-time scoring, see its own header) uses the EXACT SAME
    flattening as batch training -- never a second hand-rolled copy. pd_features/
    intraday_features are the raw ml_pd_features/ml_intraday_features JSONB dicts;
    existing is a dict with the EXISTING_FEATURE_COLS keys already resolved (is_rth already
    cast to is_rth_int by the caller, matching fetch_training_dataframe()'s own SQL-side cast).
    Missing keys become None -- LightGBM handles this identically to a NaN from the batch
    path, same native split-direction handling either way."""
    pd_features = pd_features or {}
    intraday_features = intraday_features or {}
    out = {}
    for key in PD_FEATURE_KEYS:
        out[f'pd_{key}'] = pd_features.get(key)
    for key in INTRADAY_FEATURE_KEYS:
        out[f'intraday_{key}'] = intraday_features.get(key)
    migration = pd_features.get('migrationDirVsPrior')
    for cat in MIGRATION_CATEGORIES:
        out[f'pd_migration_{cat}'] = int(migration == cat)
    for col in EXISTING_FEATURE_COLS:
        out[col] = existing.get(col)
    return out


def fetch_training_dataframe(conn, label_column='ml_extended_label'):
    """Pulls every real, fully-featured (label + both feature snapshots present) row and
    flattens it into a pandas DataFrame ready for training. No lookahead risk here beyond
    what's already guaranteed by the label/feature columns themselves (see
    mlExtendedLabelWalker.js / mlFeatureSnapshot.js's own headers) -- this function is pure
    SQL + flattening, no additional computation.

    label_column, added 2026-09-21 (user request: "test the model on 5x/10x targets as well
    as the 2.5x, just to see") -- defaults to the production 2.5x label so train.py's own
    call is unchanged; pass 'ml_extended_label_5x'/'ml_extended_label_10x' (added by
    backfill_ml_extended_label_wider.mjs) for the exploratory wider-target comparison
    (compare_extended_targets.py). Same features/population either way -- only the outcome
    definition changes."""
    # is_rth_int kept as METADATA only (not a training feature -- reverted 2026-09-22, see
    # EXISTING_FEATURE_COLS' own comment above) -- still useful for RTH/Globex segmentation in
    # analysis scripts without needing to be re-derived. cluster_touch_id is the same pattern:
    # present in the returned frame, never in feature_cols()/cols.
    query = f"""
        SELECT id, setup_type, fired_at::text AS fired_at, trade_date::text AS trade_date,
            cluster_touch_id, is_rth::int AS is_rth_int,
            {label_column}, ml_pd_features, ml_intraday_features,
            {', '.join(EXISTING_FEATURE_COLS)}
        FROM active_setups
        WHERE {REAL_TRADE_FILTER}
            AND {label_column} IS NOT NULL
            AND ml_pd_features IS NOT NULL
            AND ml_intraday_features IS NOT NULL
        ORDER BY fired_at ASC
    """
    df = pd.read_sql(query, conn)

    df['label'] = df[label_column].apply(lambda x: x.get('label'))

    cols = feature_cols()
    flattened = df.apply(
        lambda row: build_feature_dict(
            row['ml_pd_features'], row['ml_intraday_features'],
            {c: row[c] for c in EXISTING_FEATURE_COLS},
        ),
        axis=1, result_type='expand',
    )
    for c in cols:
        df[c] = flattened[c]

    # cluster_touch_id added 2026-09-22 (OPEN_DECISION ml_silo_deepseek_followup_review_parked_
    # 20260921) -- NOT a model feature (never in feature_cols/cols), carried through purely as
    # metadata for two downstream uses: (1) rigorDiagnostics.js's collapseClusterSiblings()
    # collapses correlated cluster siblings to one representative event each before computing a
    # CONFIDENCE INTERVAL (JS side, reporting only); (2) compute_sample_weights() below
    # down-weights correlated siblings during TRAINING itself (Python side). Neither touches
    # live scoring or which candidates fire -- every sibling still gets its own real P&L and
    # fires individually, per the user's explicit preference (2026-09-22: "I do like the pnl
    # when siblings fire separately").
    meta_cols = ['id', 'setup_type', 'fired_at', 'trade_date', 'cluster_touch_id', 'is_rth_int']

    return df[meta_cols + cols + ['label']], cols


def compute_sample_weights(df: pd.DataFrame) -> pd.Series:
    """Per-row LightGBM sample_weight: a real, correlated confluence-cluster touch (85.7%
    sibling win/loss agreement, measured 2026-09-22 -- see OPEN_DECISION
    ml_silo_deepseek_followup_review_parked_20260921) should not teach the model N independent
    lessons for one real market moment repeated N times. Each cluster's siblings split a total
    weight of 1.0 evenly (1/group_size each); a non-clustered row (cluster_touch_id is null)
    keeps full weight 1.0, since it genuinely is one independent event.

    Computed fresh against whatever rows are ACTUALLY passed in (the caller's own current
    train/fold subset) -- never a fixed global cluster size -- so a walk-forward fold that only
    contains a subset of a cluster's real siblings (shouldn't normally happen, since siblings
    share the same trade_date/near-identical fired_at and folds are >=7 days wide, but this
    stays correct even if it ever did) still sums to a fair per-fold weight rather than reusing
    a stale whole-dataset count.

    Does NOT change training/scoring POPULATION, which columns get returned, or any real
    active_setups row -- purely an additional array handed to model.fit(sample_weight=...).
    """
    group_sizes = df['cluster_touch_id'].map(df['cluster_touch_id'].value_counts())
    return np.where(df['cluster_touch_id'].isna(), 1.0, 1.0 / group_sizes).astype(float)
