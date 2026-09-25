"""Downstream LightGBM model for the tick-microstructure pilot -- the actual ML step,
per docs/TICK_MICROSTRUCTURE_PILOT_SPEC.md section 5c item 1. Matches Track A's own
tooling (LightGBM, not a neural net) and DeepSeek's recommendation to prove a hand-
feature baseline before ever considering a learned representation.

Target: binary classification, "did a real >=1.0x ATR20 move happen within 48h of this
bucket" (K=1.0 chosen deliberately -- ~63%/37% real split, the most balanced and most
economically meaningful of the three K values already computed; K=0.25/0.5 are so close
to always-true that a classifier would trivially learn to always predict yes). Censored
rows (no event within 48h) are the real, correct negative class -- not dropped, not
approximated, since binary classification handles right-censoring naturally here (the
question IS "did a move happen," not "exactly when").

Validation discipline, per DeepSeek's corrections to the original design:
- Day-blocked, not row-blocked, splits -- a trading day is the atomic unit.
- A real embargo between train/val/test: >= the survival horizon (48h = 2 days) PLUS the
  longest feature lookback (500-bucket 'long' window, which can span a large chunk of a
  session) -- 3 full trading days embargoed on each side of every split boundary.
- A day-block permutation null (shuffle which days' labels go with which days' features,
  preserving within-day structure) -- NOT a row-shuffle, which would destroy the
  autocorrelation this data actually has and produce an artificially easy null.
- Effective-N reported as real distinct days AND real event counts, not row counts.
"""
import sys
import os
import json
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

DATA_PATH = '/home/mmoniz/trading-journal/scratch/tick_microstructure_dataset_6mo.csv'
TARGET_K = '1.0'
EMBARGO_DAYS = 3
N_PERMUTATIONS = 200  # Opus Audit #14 (2026-09-24): standardized to >=200, matching
                       # train_fade_outcome_model.py -- this script's own result (AUC=0.4563,
                       # 90% of 30 perms already beat it) was already decisively negative, so
                       # not re-run for this alone, but the constant should not drift back to
                       # a weaker default for any future use of this file.
RANDOM_SEED = 20260923

FEATURE_COLS = [
    'order_flow_imbalance', 'elapsed_seconds', 'price_impact_per_contract',
    'same_side_run_length', 'n_trades', 'volume',
    'trailing_ofi_mean_short', 'trailing_ofi_mean_medium', 'trailing_ofi_mean_long',
    'trailing_elapsed_mean_short', 'trailing_elapsed_mean_medium', 'trailing_elapsed_mean_long',
    'realized_micro_vol_short', 'realized_micro_vol_medium', 'realized_micro_vol_long',
]


def load_data():
    df = pd.read_csv(DATA_PATH, parse_dates=['ts_et'])
    df['label'] = (df[f'censored_k{TARGET_K}'] == False).astype(int)  # noqa: E712
    df = df.dropna(subset=FEATURE_COLS + ['label'])
    return df


def day_blocked_split(df, embargo_days=EMBARGO_DAYS, train_frac=0.7, val_frac=0.15):
    days = sorted(df['trade_date'].unique())
    n = len(days)
    n_train = int(n * train_frac)
    n_val = int(n * val_frac)

    train_days = set(days[:n_train])
    # Embargo: drop the last EMBARGO_DAYS of train and the first EMBARGO_DAYS of val/test
    # from whichever side they're adjacent to, so no split boundary has < embargo_days
    # of real gap between blocks.
    val_start = n_train + embargo_days
    val_end = n_train + n_val
    test_start = val_end + embargo_days

    train_days = set(days[:max(0, n_train - embargo_days)])
    val_days = set(days[val_start:val_end]) if val_start < val_end else set()
    test_days = set(days[test_start:]) if test_start < n else set()

    return train_days, val_days, test_days


def train_and_eval(df, train_days, test_days, feature_cols=FEATURE_COLS, seed=RANDOM_SEED):
    train_df = df[df['trade_date'].isin(train_days)]
    test_df = df[df['trade_date'].isin(test_days)]
    if len(train_df) == 0 or len(test_df) == 0 or test_df['label'].nunique() < 2:
        return None

    model = lgb.LGBMClassifier(
        n_estimators=200, max_depth=5, learning_rate=0.05,
        random_state=seed, verbosity=-1,
    )
    model.fit(train_df[feature_cols], train_df['label'])
    proba = model.predict_proba(test_df[feature_cols])[:, 1]
    auc = roc_auc_score(test_df['label'], proba)
    return auc, model


def day_block_permutation_null(df, train_days, val_days, test_days, real_auc, n_perms=N_PERMUTATIONS, seed=RANDOM_SEED):
    """Shuffle labels AT THE DAY LEVEL (not row level) -- assign each day's real set of
    labels to a randomly different day, preserving within-day label structure and
    day-to-day autocorrelation, then retrain/evaluate. This is the corrected null
    DeepSeek's review specified -- a row-shuffle would destroy real autocorrelation and
    make the null artificially easy to beat."""
    rng = np.random.RandomState(seed)
    train_test_days = sorted(train_days | test_days)
    null_aucs = []

    day_label_blocks = {d: df.loc[df['trade_date'] == d, 'label'].values for d in train_test_days}

    for i in range(n_perms):
        shuffled_days = list(train_test_days)
        rng.shuffle(shuffled_days)
        day_mapping = dict(zip(train_test_days, shuffled_days))

        perm_df = df[df['trade_date'].isin(train_test_days)].copy()
        perm_df['perm_label'] = perm_df['trade_date'].map(lambda d: None)
        for real_day, shuffled_day in day_mapping.items():
            mask = perm_df['trade_date'] == real_day
            block = day_label_blocks[shuffled_day]
            if mask.sum() == len(block):
                perm_df.loc[mask, 'perm_label'] = block
            else:
                # Day lengths differ -- resample the donor block to fit (rare edge case).
                idx = rng.randint(0, len(block), size=mask.sum())
                perm_df.loc[mask, 'perm_label'] = block[idx]

        train_p = perm_df[perm_df['trade_date'].isin(train_days)]
        test_p = perm_df[perm_df['trade_date'].isin(test_days)]
        if test_p['perm_label'].nunique() < 2:
            continue
        model = lgb.LGBMClassifier(n_estimators=200, max_depth=5, learning_rate=0.05, random_state=seed, verbosity=-1)
        model.fit(train_p[FEATURE_COLS], train_p['perm_label'].astype(int))
        proba = model.predict_proba(test_p[FEATURE_COLS])[:, 1]
        null_aucs.append(roc_auc_score(test_p['perm_label'].astype(int), proba))

    return null_aucs


def main():
    df = load_data()
    print(f"Loaded {len(df):,} rows, {df['trade_date'].nunique()} distinct days")
    print(f"Target: K={TARGET_K} event within 48h -- real event rate: {df['label'].mean():.3f}")

    train_days, val_days, test_days = day_blocked_split(df)
    print(f"Train days: {len(train_days)}, Val days: {len(val_days)}, Test days: {len(test_days)} "
          f"(embargo={EMBARGO_DAYS} days at each boundary)")

    result = train_and_eval(df, train_days, test_days)
    if result is None:
        print("FAILED: insufficient data or single-class test set")
        return
    real_auc, model = result
    test_df = df[df['trade_date'].isin(test_days)]
    print(f"\nREAL test AUC: {real_auc:.4f}")
    print(f"Test set: {len(test_df):,} rows, {test_df['trade_date'].nunique()} distinct days, "
          f"{test_df['label'].sum():,} real events / {len(test_df):,} rows")

    print(f"\nRunning day-block permutation null ({N_PERMUTATIONS} permutations)...")
    null_aucs = day_block_permutation_null(df, train_days, val_days, test_days, real_auc)
    null_aucs = np.array(null_aucs)
    print(f"Null AUC distribution: mean={null_aucs.mean():.4f}, std={null_aucs.std():.4f}, "
          f"p5={np.percentile(null_aucs, 5):.4f}, p95={np.percentile(null_aucs, 95):.4f}")
    pct_null_beats_real = (null_aucs >= real_auc).mean()
    print(f"Fraction of null permutations >= real AUC: {pct_null_beats_real:.3f} "
          f"(this is an empirical p-value -- low = real signal, high = looks like noise)")

    print("\nFeature importance (gain):")
    importance = sorted(zip(FEATURE_COLS, model.feature_importances_), key=lambda x: -x[1])
    for feat, imp in importance:
        print(f"  {feat}: {imp}")

    result_summary = {
        'real_test_auc': float(real_auc),
        'null_auc_mean': float(null_aucs.mean()),
        'null_auc_std': float(null_aucs.std()),
        'null_auc_p95': float(np.percentile(null_aucs, 95)),
        'empirical_p_value': float(pct_null_beats_real),
        'test_n_rows': int(len(test_df)),
        'test_n_days': int(test_df['trade_date'].nunique()),
        'test_n_real_events': int(test_df['label'].sum()),
        'feature_importance': {f: float(i) for f, i in importance},
    }
    with open('/home/mmoniz/trading-journal/scratch/tick_microstructure_model_result.json', 'w') as f:
        json.dump(result_summary, f, indent=2)
    print("\nSaved result summary to scratch/tick_microstructure_model_result.json")


if __name__ == '__main__':
    main()
