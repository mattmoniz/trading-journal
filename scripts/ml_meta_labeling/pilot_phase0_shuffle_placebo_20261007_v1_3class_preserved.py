"""Phase 0 pretest, part 2 of 2: shuffle-placebo screen for the proposed ML-learned
stop/target idea (scoped 2026-10-07, DeepSeek design critique same day, part 1 --
the constant-multiplier grid -- in scripts/pilot_ml_phase1_constant_multiplier_grid_20261007.mjs,
RESEARCH_CLAIM ml_phase1_constant_multiplier_grid_no_room_20261007: no flat multiplier beats
OPTIMAL_STOP's 1.0x).

Question: does a genuine per-touch model (using the SAME real features as the meta-labeler)
beat a model trained on the SAME features but with labels shuffled across days -- i.e., is
there real per-touch signal, or does any apparent "skill" come only from the model's average
widening tendency (the thing the constant-multiplier grid already tested and found nothing)?

Method, per CLAUDE.md's own standing convention ("prefer this codebase's own day-block LABEL
permutation convention over inventing a feature-shuffle control" -- a feature-shuffle control
can leak signal through correlated features even when null-trained):
  - Label = argmax EV among {0.8x, 1.0x, 1.2x, 1.4x} per real trade (from part 1's precomputed
    bar-walk EVs, scratch/ml_phase0_pertrade_ev_20261007.csv), collapsed to 3 ordinal classes
    (shrink/hold/widen), deployed multiplier mapping shrink->0.8 hold->1.0 widen->1.2 (a fixed,
    bounded single value per class -- never two independent stop/target multipliers, per
    DeepSeek's explicit warning against reintroducing the asymmetric-geometry placebo trap).
  - Real features: the exact same ~24-feature set the live meta-labeler trains on
    (dataset.py's feature_cols()/build_feature_dict()), joined by id to the trades that
    cleared part 1's filters (REAL_TRADE_FILTER + OPTIMAL_STOP baseline present + ML feature
    snapshot present) -- N=3,899, 78 distinct dates.
  - 3-fold expanding walk-forward (chronological, PURGE_DAYS=3 gap between train and test,
    matching walkforward.py's own convention) -- NOT a single train/test split.
  - Per fold: train a real LightGBM multiclass model on (real features, real labels); ALSO
    train the identical model type on (real features, labels permuted BY WHOLE TRADE_DATE --
    i.e. which day's real labels got assigned to which day's rows is shuffled, preserving
    each day's own label as a block rather than shuffling individual trades, since trades on
    the same day are correlated) over the SAME train rows. Score both on the SAME held-out
    test rows. Map each model's predicted class to its deployed multiplier, look up that
    trade's REAL (unshuffled) ground-truth EV at that multiplier from part 1's CSV.
  - Pool the out-of-fold real-model-selected EV and shuffled-model-selected EV across all 3
    folds (every trade scored exactly once by each). Day-blocked bootstrap 95% CI on the
    per-trade paired difference (real - shuffled).

Gate (DeepSeek's own words): "If the real model's EV doesn't beat the shuffled model's,
there is no skill." Combined with part 1 (no constant beats 1.0x either), a negative result
here is the full 2-part kill condition for Phase 1 as scoped.

Run manually: python3 scripts/ml_meta_labeling/pilot_phase0_shuffle_placebo_20261007.py
"""
import sys
import os
import numpy as np
import pandas as pd
import lightgbm as lgb

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import feature_cols, build_feature_dict, EXISTING_FEATURE_COLS
from hyperparams import load_hyperparams

CSV_PATH = '/home/mmoniz/trading-journal/scratch/ml_phase0_pertrade_ev_20261007.csv'
PURGE_DAYS = 3
N_FOLDS = 3
DEPLOYED_MULT = {0: 0.8, 1: 1.0, 2: 1.2}  # shrink / hold / widen
RNG_SEED = 20261007


def multiplier_to_class(m):
    if m == 0.8:
        return 0
    if m == 1.0:
        return 1
    return 2  # 1.2 or 1.4 both collapse to "widen"


def label_row(row):
    # argmax EV among the 4 real-walked multipliers, tie-break preferring the multiplier
    # closest to 1.0 (hold) -- a tie is most naturally "no reason to deviate."
    options = [(0.8, row['ev_0.8']), (1.0, row['ev_1.0']), (1.2, row['ev_1.2']), (1.4, row['ev_1.4'])]
    max_ev = max(v for _, v in options)
    tied = [m for m, v in options if v == max_ev]
    best_m = min(tied, key=lambda m: abs(m - 1.0))
    return multiplier_to_class(best_m)


def day_blocked_bootstrap_ci(diffs_by_date, iters=2000, seed=RNG_SEED):
    rng = np.random.default_rng(seed)
    date_groups = list(diffs_by_date.values())
    n_groups = len(date_groups)
    means = np.empty(iters)
    for i in range(iters):
        idx = rng.integers(0, n_groups, n_groups)
        resampled = np.concatenate([date_groups[j] for j in idx])
        means[i] = resampled.mean()
    means.sort()
    lo = means[int(iters * 0.025)]
    hi = means[int(iters * 0.975)]
    return lo, hi


def main():
    print('=== Phase 0 pretest part 2: shuffle-placebo screen ===\n')

    ev_df = pd.read_csv(CSV_PATH)
    ev_df['label'] = ev_df.apply(label_row, axis=1)
    print(f'Loaded {len(ev_df)} trades with ground-truth EV at each multiplier.')
    print(f"Real label distribution: shrink={sum(ev_df['label']==0)}, hold={sum(ev_df['label']==1)}, widen={sum(ev_df['label']==2)}\n")

    conn = get_connection()
    ids = tuple(int(i) for i in ev_df['id'])
    query = f"""
        SELECT id, fired_at::text AS fired_at, trade_date::text AS trade_date,
            entry_zone_low::float AS entry_zone_low, stop_level::float AS stop_level,
            ml_pd_features, ml_intraday_features,
            {', '.join(EXISTING_FEATURE_COLS)}
        FROM active_setups
        WHERE id IN %(ids)s
    """
    feat_df = pd.read_sql(query, conn, params={'ids': ids})
    conn.close()
    print(f'Fetched real features for {len(feat_df)} of those trades.')

    feat_df['is_long'] = feat_df['stop_level'] < feat_df['entry_zone_low']
    cols = feature_cols()
    flattened = feat_df.apply(
        lambda row: build_feature_dict(
            row['ml_pd_features'], row['ml_intraday_features'],
            {c: row[c] for c in EXISTING_FEATURE_COLS},
            is_long=row['is_long'],
        ),
        axis=1, result_type='expand',
    )
    for c in cols:
        feat_df[c] = flattened[c]

    df = feat_df.merge(ev_df[['id', 'label', 'ev_0.8', 'ev_1.0', 'ev_1.2', 'ev_1.4']], on='id', how='inner')
    df['_fired_dt'] = pd.to_datetime(df['fired_at'], format='mixed')
    df = df.sort_values('_fired_dt').reset_index(drop=True)
    print(f'Merged dataset: {len(df)} rows, {df["trade_date"].nunique()} distinct dates.\n')

    conn2 = get_connection()
    hp = load_hyperparams(conn2)
    conn2.close()
    print(f'Hyperparams: {hp}\n')

    unique_dates = sorted(df['trade_date'].unique())
    n_dates = len(unique_dates)
    # Expanding folds: first 40% of dates seed the initial training set; the remaining 60%
    # is split into N_FOLDS roughly-equal test chunks, each trained on everything strictly
    # before (that chunk's start - PURGE_DAYS).
    seed_end = int(n_dates * 0.40)
    remaining = unique_dates[seed_end:]
    chunk_size = max(1, len(remaining) // N_FOLDS)
    fold_test_dates = []
    for i in range(N_FOLDS):
        start = i * chunk_size
        end = (i + 1) * chunk_size if i < N_FOLDS - 1 else len(remaining)
        if start >= len(remaining):
            break
        fold_test_dates.append(remaining[start:end])

    rng = np.random.default_rng(RNG_SEED)
    real_rows = []   # {id, date, ev}
    shuf_rows = []

    for fold_i, test_dates in enumerate(fold_test_dates):
        test_dates_set = set(test_dates)
        test_start = pd.to_datetime(min(test_dates))
        purge_start = test_start - pd.Timedelta(days=PURGE_DAYS)
        train_mask = df['_fired_dt'] < purge_start
        test_mask = df['trade_date'].isin(test_dates_set)
        train_df = df[train_mask]
        test_df = df[test_mask]
        if len(train_df) < 100 or len(test_df) < 10:
            print(f'Fold {fold_i+1}: skipped (train={len(train_df)}, test={len(test_df)}, too thin)')
            continue

        X_train = train_df[cols]
        y_train = train_df['label'].values
        X_test = test_df[cols]

        # REAL model.
        real_model = lgb.LGBMClassifier(
            n_estimators=hp['n_estimators'], max_depth=hp['max_depth'],
            learning_rate=hp['learning_rate'], num_leaves=hp['num_leaves'],
            min_child_samples=hp['min_child_samples'], objective='multiclass',
            num_class=3, verbosity=-1, random_state=RNG_SEED,
        )
        real_model.fit(X_train, y_train)
        real_pred = real_model.predict(X_test)

        # SHUFFLED model: permute labels BY WHOLE trade_date block within the train set
        # (day-block permutation, not a flat row shuffle -- preserves within-day label
        # correlation structure, matching this codebase's standing day-block-permutation
        # convention rather than a naive i.i.d. row shuffle).
        train_dates_unique = train_df['trade_date'].unique()
        shuffled_dates = rng.permutation(train_dates_unique)
        date_map = dict(zip(train_dates_unique, shuffled_dates))
        # Build a day->label-sequence lookup from the REAL assignment, then reassign by the
        # permuted day mapping (day A's rows get day map[A]'s real label sequence, truncated/
        # cycled to match day A's own row count -- preserves each day's real label mix overall
        # while breaking which SPECIFIC day's features go with which day's true labels).
        real_labels_by_date = {d: train_df.loc[train_df['trade_date'] == d, 'label'].values for d in train_dates_unique}
        shuffled_y = np.empty(len(train_df), dtype=int)
        train_df_reset = train_df.reset_index(drop=True)
        for d in train_dates_unique:
            idx = train_df_reset.index[train_df_reset['trade_date'] == d].tolist()
            src_labels = real_labels_by_date[date_map[d]]
            for k, row_idx in enumerate(idx):
                shuffled_y[row_idx] = src_labels[k % len(src_labels)]

        shuf_model = lgb.LGBMClassifier(
            n_estimators=hp['n_estimators'], max_depth=hp['max_depth'],
            learning_rate=hp['learning_rate'], num_leaves=hp['num_leaves'],
            min_child_samples=hp['min_child_samples'], objective='multiclass',
            num_class=3, verbosity=-1, random_state=RNG_SEED,
        )
        shuf_model.fit(X_train, shuffled_y)
        shuf_pred = shuf_model.predict(X_test)

        for i, (_, row) in enumerate(test_df.iterrows()):
            real_m = DEPLOYED_MULT[real_pred[i]]
            shuf_m = DEPLOYED_MULT[shuf_pred[i]]
            real_rows.append({'id': row['id'], 'date': row['trade_date'], 'ev': row[f'ev_{real_m}']})
            shuf_rows.append({'id': row['id'], 'date': row['trade_date'], 'ev': row[f'ev_{shuf_m}']})

        real_class_dist = np.bincount(real_pred, minlength=3)
        shuf_class_dist = np.bincount(shuf_pred, minlength=3)
        print(f'Fold {fold_i+1}: train N={len(train_df)}, test N={len(test_df)}, test dates {test_dates[0]}..{test_dates[-1]}')
        print(f'  real pred classes  shrink/hold/widen = {real_class_dist}')
        print(f'  shuffled pred classes shrink/hold/widen = {shuf_class_dist}')

    real_df = pd.DataFrame(real_rows)
    shuf_df = pd.DataFrame(shuf_rows)
    print(f'\nTotal out-of-fold evaluations: {len(real_df)}\n')

    if len(real_df) < 20:
        print('FATAL: fewer than 20 out-of-fold evaluations, cannot proceed.')
        sys.exit(1)

    merged = real_df.merge(shuf_df, on=['id', 'date'], suffixes=('_real', '_shuf'))
    merged['diff'] = merged['ev_real'] - merged['ev_shuf']

    print('--- Pooled EV (real-model-selected vs shuffled-model-selected multiplier) ---')
    print(f"  Real model:     mean ${merged['ev_real'].mean():.2f}/trade, N={len(merged)}")
    print(f"  Shuffled model: mean ${merged['ev_shuf'].mean():.2f}/trade, N={len(merged)}")
    mean_diff = merged['diff'].mean()
    print(f'  Paired mean diff (real - shuffled): ${mean_diff:.2f}/trade\n')

    diffs_by_date = {}
    for _, row in merged.iterrows():
        diffs_by_date.setdefault(row['date'], []).append(row['diff'])
    diffs_by_date = {k: np.array(v) for k, v in diffs_by_date.items()}
    lo, hi = day_blocked_bootstrap_ci(diffs_by_date)
    excludes_zero = lo > 0 or hi < 0
    print(f'Day-blocked bootstrap 95% CI on paired diff: [${lo:.2f}, ${hi:.2f}]{"  <<< excludes zero" if excludes_zero else ""}\n')

    print('=== VERDICT ===')
    if excludes_zero and mean_diff > 0:
        print('Real per-touch model beats the day-block-shuffled placebo with a CI excluding zero.')
        print('This IS evidence of real per-touch signal, independent of the constant-multiplier')
        print('finding (part 1) -- worth a closer look before dismissing Phase 1.')
    elif excludes_zero and mean_diff < 0:
        print('Real model is REAL AND WORSE than the shuffled placebo -- a genuine warning sign,')
        print('not just a null result.')
    else:
        print('No real per-touch skill detected -- the real model does not beat the day-block-')
        print('shuffled placebo (CI crosses zero). Combined with part 1 (no constant multiplier')
        print('beats 1.0x either), this clears DeepSeek\'s FULL 2-part kill gate for Phase 1 as')
        print('scoped: neither average widening NOR per-touch variation shows real signal in this')
        print('population. Recommendation: do not build the Phase 1 model.')


if __name__ == '__main__':
    main()
