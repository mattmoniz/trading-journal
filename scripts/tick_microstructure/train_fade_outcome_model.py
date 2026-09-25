"""Real ML training target: does the trend/path-quality state of the market AT THE MOMENT
a real fade setup fires predict whether it resolves STOP_HIT vs TARGET_HIT? Trained on
real fade-setup outcomes (docs/TICK_MICROSTRUCTURE_PILOT_SPEC.md), features from
scripts/tick_microstructure/build_trade_level_dataset.py.

Same validation discipline as the earlier (negative) per-bucket model: day-blocked split,
a real embargo, and a day-block permutation null -- but day-blocked here means blocked by
which DAY each fire happened on (not bucket timestamps), since the unit of analysis is now
the trade, matching how this codebase evaluates every other setup_type.

REWRITTEN 2026-09-24 per Opus Audit #14 Step 1 (scratch/opus_audit_14_ml_strategy_results.md
section 2.4 / OPEN_DECISION ml_direction_signed_features_untested_20260924): runs a real
comparison matrix on IDENTICAL day-blocked folds --
  (a) TICK_UNSIGNED (original feature set) vs TICK_SIGNED (+ direction-signed features)
      -- pass/kill: signed >= unsigned on out-of-fold AUC.
  (b) TICK_SIGNED vs BAR_CONTROL (bar-level-only features from price_bars_primary, not the
      tick pipeline at all) -- pass/kill: if bar matches tick within CI, tick is redundant
      for this question.
  (c) LightGBM vs a plain logistic-regression baseline on each feature set, per the
      external-input self-critique Opus Audit #14 agreed with (section 8): "simplest model
      first," complex model must beat the baseline on the SAME folds to earn its place.
"""
import sys
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

DATA_PATH = '/home/mmoniz/trading-journal/scratch/tick_trend_fade_outcomes.csv'
EMBARGO_DAYS = 1  # trade-level split -- no 48h-forward-looking target this time, so the
                   # only real leakage risk is the trailing feature windows (up to 500
                   # buckets, well under a day), not a long forward horizon.
N_PERMUTATIONS = 200  # Opus Audit #14 (2026-09-24): 30 was a first-pass minimum, not a
                       # target -- a p-value this close to 0.05 (currently ~0.10) needs a
                       # finer null distribution to be trustworthy at all.
RANDOM_SEED = 20260923

WINDOW_SCALES = ('short', 'medium', 'long')

TICK_UNSIGNED_COLS = [
    'order_flow_imbalance', 'elapsed_seconds', 'price_impact_per_contract',
    'same_side_run_length', 'n_trades', 'volume',
] + [f'trailing_ofi_mean_{n}' for n in WINDOW_SCALES] \
  + [f'trailing_elapsed_mean_{n}' for n in WINDOW_SCALES] \
  + [f'realized_micro_vol_{n}' for n in WINDOW_SCALES] \
  + [f'ofi_abs_mean_{n}' for n in WINDOW_SCALES] \
  + [f'efficiency_ratio_{n}' for n in WINDOW_SCALES] \
  + ['ofi_divergence_short_long', 'vol_divergence_short_long', 'pace_divergence_short_long']

SIGNED_ONLY_COLS = ['signed_ofi', 'signed_ofi_divergence_short_long'] \
  + [f'signed_trailing_ofi_mean_{n}' for n in WINDOW_SCALES] \
  + [f'signed_efficiency_toward_trade_{n}' for n in WINDOW_SCALES]

TICK_SIGNED_COLS = TICK_UNSIGNED_COLS + SIGNED_ONLY_COLS + ['dir']

BAR_CONTROL_COLS = ['bar_ofi_15', 'bar_efficiency_ratio_15', 'bar_realized_vol_15', 'dir']

FEATURE_SETS = {
    'TICK_UNSIGNED': TICK_UNSIGNED_COLS,
    'TICK_SIGNED': TICK_SIGNED_COLS,
    'BAR_CONTROL': BAR_CONTROL_COLS,
}

# Kept for backward compat with freeze_model.py / score_frozen_model.py, which train the
# single canonical frozen artifact on the richest available real feature set.
FEATURE_COLS = TICK_SIGNED_COLS


def load_data():
    df = pd.read_csv(DATA_PATH)
    # Mixed EDT/EST offsets (-04:00 / -05:00) across the 6-month range make pandas'
    # default parse_dates fall back to object dtype -- parse as UTC explicitly, then
    # convert back to ET for date-grouping (the real trading-day boundary).
    df['fired_at_et'] = pd.to_datetime(df['fired_at_et'], format='ISO8601', utc=True).dt.tz_convert('America/New_York')
    df['trade_date'] = df['fired_at_et'].dt.date
    return df


def day_blocked_split(df, embargo_days=EMBARGO_DAYS, train_frac=0.7, val_frac=0.15):
    days = sorted(df['trade_date'].unique())
    n = len(days)
    n_train = int(n * train_frac)
    n_val = int(n * val_frac)
    val_start = n_train + embargo_days
    val_end = n_train + n_val
    test_start = val_end + embargo_days

    train_days = set(days[:max(0, n_train - embargo_days)])
    val_days = set(days[val_start:val_end]) if val_start < val_end else set()
    test_days = set(days[test_start:]) if test_start < n else set()
    return train_days, val_days, test_days


def train_and_eval(df, feature_cols, train_days, test_days, model_type='lgbm', seed=RANDOM_SEED):
    sub = df.dropna(subset=feature_cols + ['label'])
    train_df = sub[sub['trade_date'].isin(train_days)]
    test_df = sub[sub['trade_date'].isin(test_days)]
    if len(train_df) < 20 or len(test_df) < 5 or test_df['label'].nunique() < 2:
        return None
    if model_type == 'lgbm':
        model = lgb.LGBMClassifier(n_estimators=150, max_depth=4, learning_rate=0.05, random_state=seed, verbosity=-1)
        model.fit(train_df[feature_cols], train_df['label'])
        proba = model.predict_proba(test_df[feature_cols])[:, 1]
    elif model_type == 'logistic':
        scaler = StandardScaler()
        X_train = scaler.fit_transform(train_df[feature_cols])
        X_test = scaler.transform(test_df[feature_cols])
        model = LogisticRegression(max_iter=1000, random_state=seed)
        model.fit(X_train, train_df['label'])
        proba = model.predict_proba(X_test)[:, 1]
    else:
        raise ValueError(model_type)
    auc = roc_auc_score(test_df['label'], proba)
    return auc, model, len(train_df), len(test_df), test_df['trade_date'].nunique()


def day_block_permutation_null(df, feature_cols, train_days, test_days, model_type='lgbm', n_perms=N_PERMUTATIONS, seed=RANDOM_SEED):
    sub = df.dropna(subset=feature_cols + ['label'])
    rng = np.random.RandomState(seed)
    all_days = sorted(train_days | test_days)
    day_labels = {d: sub.loc[sub['trade_date'] == d, 'label'].values for d in all_days}
    null_aucs = []

    for _ in range(n_perms):
        shuffled = list(all_days)
        rng.shuffle(shuffled)
        mapping = dict(zip(all_days, shuffled))
        perm_df = sub[sub['trade_date'].isin(all_days)].copy()
        perm_df['perm_label'] = 0
        for real_day, donor_day in mapping.items():
            mask = perm_df['trade_date'] == real_day
            block = day_labels[donor_day]
            if mask.sum() == len(block):
                perm_df.loc[mask, 'perm_label'] = block
            else:
                idx = rng.randint(0, len(block), size=mask.sum())
                perm_df.loc[mask, 'perm_label'] = block[idx]
        train_p = perm_df[perm_df['trade_date'].isin(train_days)]
        test_p = perm_df[perm_df['trade_date'].isin(test_days)]
        if len(train_p) < 20 or test_p['perm_label'].nunique() < 2:
            continue
        if model_type == 'lgbm':
            model = lgb.LGBMClassifier(n_estimators=150, max_depth=4, learning_rate=0.05, random_state=seed, verbosity=-1)
            model.fit(train_p[feature_cols], train_p['perm_label'])
            proba = model.predict_proba(test_p[feature_cols])[:, 1]
        else:
            scaler = StandardScaler()
            X_train = scaler.fit_transform(train_p[feature_cols])
            X_test = scaler.transform(test_p[feature_cols])
            model = LogisticRegression(max_iter=1000, random_state=seed)
            model.fit(X_train, train_p['perm_label'])
            proba = model.predict_proba(X_test)[:, 1]
        null_aucs.append(roc_auc_score(test_p['perm_label'], proba))
    return null_aucs


def main():
    df = load_data()
    print(f"Loaded {len(df):,} real fade-fire rows, {df['trade_date'].nunique()} distinct days")
    print(f"Label balance: TARGET_HIT={df['label'].sum()} / STOP_HIT={(df['label']==0).sum()} "
          f"(base rate={df['label'].mean():.3f})")
    print(f"Rows with resolved direction: {df['dir'].notna().sum()}/{len(df)}")

    train_days, val_days, test_days = day_blocked_split(df)
    print(f"\nTrain days: {len(train_days)}, Val days: {len(val_days)}, Test days: {len(test_days)}")

    results = {}
    for set_name, cols in FEATURE_SETS.items():
        for model_type in ('lgbm', 'logistic'):
            r = train_and_eval(df, cols, train_days, test_days, model_type=model_type)
            key = f"{set_name}_{model_type}"
            if r is None:
                print(f"{key}: FAILED (insufficient data after dropna on this feature set)")
                results[key] = None
                continue
            auc, model, n_train, n_test, n_test_days = r
            results[key] = {'auc': auc, 'model': model, 'n_train': n_train, 'n_test': n_test, 'n_test_days': n_test_days}
            print(f"{key}: AUC={auc:.4f} (n_train={n_train}, n_test={n_test}, test_days={n_test_days})")

    print("\n=== Comparison summary (Opus Audit #14 Step 1 pass/kill criteria) ===")
    tu = results.get('TICK_UNSIGNED_lgbm')
    ts = results.get('TICK_SIGNED_lgbm')
    bc = results.get('BAR_CONTROL_lgbm')
    if tu and ts:
        print(f"Signed vs unsigned (LightGBM): {ts['auc']:.4f} vs {tu['auc']:.4f} "
              f"-> {'SIGNED WINS' if ts['auc'] >= tu['auc'] else 'unsigned wins'} "
              f"(delta={ts['auc']-tu['auc']:+.4f})")
    if ts and bc:
        print(f"Tick-signed vs bar-control (LightGBM): {ts['auc']:.4f} vs {bc['auc']:.4f} "
              f"-> delta={ts['auc']-bc['auc']:+.4f} "
              f"({'tick pipeline earns its keep' if abs(ts['auc']-bc['auc']) > 0.02 else 'roughly equivalent -- tick may be redundant for this question'})")
    for set_name in FEATURE_SETS:
        lg = results.get(f'{set_name}_logistic')
        gb = results.get(f'{set_name}_lgbm')
        if lg and gb:
            print(f"{set_name}: LightGBM {gb['auc']:.4f} vs logistic baseline {lg['auc']:.4f} "
                  f"-> {'LightGBM earns its complexity' if gb['auc'] > lg['auc'] + 0.01 else 'logistic baseline is competitive -- LightGBM not clearly earning its complexity'}")

    # Permutation null run on BOTH TICK_SIGNED variants -- fixed 2026-09-24 after a DeepSeek
    # code-review of this file correctly found that ONLY the lgbm null was ever committed
    # here, even though the canonical FROZEN model is logistic (it beat lgbm on out-of-fold
    # AUC: 0.5783 vs 0.5480). The logistic null (p=0.025) had actually been run and used to
    # justify the freeze decision, but only via an uncommitted one-off python -c command --
    # DeepSeek couldn't see that from the repo alone, correctly flagged the claim as
    # unreproducible, and was right to: an ephemeral command is not evidence a future session
    # (or a reviewer) can verify. This now commits BOTH nulls so "p=0.025 belongs to the
    # logistic model" is checkable from this file alone, not asserted from memory.
    if ts:
        print(f"\nRunning day-block permutation null on TICK_SIGNED/lgbm ({N_PERMUTATIONS} permutations)...")
        null_aucs = np.array(day_block_permutation_null(df, TICK_SIGNED_COLS, train_days, test_days, model_type='lgbm'))
        print(f"Null AUC: mean={null_aucs.mean():.4f}, std={null_aucs.std():.4f}, "
              f"p5={np.percentile(null_aucs,5):.4f}, p95={np.percentile(null_aucs,95):.4f}")
        pct_beats = (null_aucs >= ts['auc']).mean()
        print(f"Fraction of null permutations >= real AUC: {pct_beats:.3f} (empirical p-value)")

    ts_logistic = results.get('TICK_SIGNED_logistic')
    if ts_logistic:
        print(f"\nRunning day-block permutation null on TICK_SIGNED/logistic -- THE CANONICAL FROZEN MODEL ({N_PERMUTATIONS} permutations)...")
        null_aucs_logistic = np.array(day_block_permutation_null(df, TICK_SIGNED_COLS, train_days, test_days, model_type='logistic'))
        print(f"Null AUC: mean={null_aucs_logistic.mean():.4f}, std={null_aucs_logistic.std():.4f}, "
              f"p5={np.percentile(null_aucs_logistic,5):.4f}, p95={np.percentile(null_aucs_logistic,95):.4f}")
        pct_beats_logistic = (null_aucs_logistic >= ts_logistic['auc']).mean()
        print(f"Fraction of null permutations >= real AUC (LOGISTIC, canonical): {pct_beats_logistic:.3f} (empirical p-value)")

        # REAL test AUC / Test set line kept in this exact format for
        # recheck_tick_trend_fade_finding.mjs's parseTrainOutput() regex to keep matching
        # after this rewrite.
        print(f"\nREAL test AUC: {ts['auc']:.4f}")
        test_df = df.dropna(subset=TICK_SIGNED_COLS + ['label'])
        test_df = test_df[test_df['trade_date'].isin(test_days)]
        print(f"Test set: {len(test_df)} real trades, {test_df['trade_date'].nunique()} distinct days, "
              f"{test_df['label'].sum()} TARGET_HIT / {(test_df['label']==0).sum()} STOP_HIT")

        print("\nFeature importance (gain):")
        for feat, imp in sorted(zip(TICK_SIGNED_COLS, ts['model'].feature_importances_), key=lambda x: -x[1]):
            print(f"  {feat}: {imp}")


if __name__ == '__main__':
    main()
