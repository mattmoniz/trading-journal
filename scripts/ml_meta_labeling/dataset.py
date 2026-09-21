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
EXISTING_FEATURE_COLS = [
    'nl30_at_detection', 'confluence_score_at_detection', 'minutes_from_open',
]


def fetch_training_dataframe(conn):
    """Pulls every real, fully-featured (label + both feature snapshots present) row and
    flattens it into a pandas DataFrame ready for training. No lookahead risk here beyond
    what's already guaranteed by the label/feature columns themselves (see
    mlExtendedLabelWalker.js / mlFeatureSnapshot.js's own headers) -- this function is pure
    SQL + flattening, no additional computation."""
    query = f"""
        SELECT id, setup_type, fired_at::text AS fired_at, trade_date::text AS trade_date,
            ml_extended_label, ml_pd_features, ml_intraday_features,
            {', '.join(EXISTING_FEATURE_COLS)}
        FROM active_setups
        WHERE {REAL_TRADE_FILTER}
            AND ml_extended_label IS NOT NULL
            AND ml_pd_features IS NOT NULL
            AND ml_intraday_features IS NOT NULL
        ORDER BY fired_at ASC
    """
    df = pd.read_sql(query, conn)

    df['label'] = df['ml_extended_label'].apply(lambda x: x.get('label'))

    for key in PD_FEATURE_KEYS:
        df[f'pd_{key}'] = df['ml_pd_features'].apply(lambda x, k=key: x.get(k))
    for key in INTRADAY_FEATURE_KEYS:
        df[f'intraday_{key}'] = df['ml_intraday_features'].apply(lambda x, k=key: x.get(k))

    migration = df['ml_pd_features'].apply(lambda x: x.get('migrationDirVsPrior'))
    for cat in MIGRATION_CATEGORIES:
        df[f'pd_migration_{cat}'] = (migration == cat).astype(int)

    feature_cols = (
        [f'pd_{k}' for k in PD_FEATURE_KEYS]
        + [f'intraday_{k}' for k in INTRADAY_FEATURE_KEYS]
        + [f'pd_migration_{c}' for c in MIGRATION_CATEGORIES]
        + EXISTING_FEATURE_COLS
    )
    meta_cols = ['id', 'setup_type', 'fired_at', 'trade_date']

    return df[meta_cols + feature_cols + ['label']], feature_cols
