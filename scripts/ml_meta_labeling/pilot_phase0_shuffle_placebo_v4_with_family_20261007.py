"""Phase 0 pretest, v3: binary shrink(0.8x)/widen(1.4x) framing + a real hyperparameter sweep,
after v1 (3-class, buggy label collapse) and v2 (4-class, corrected but severely imbalanced --
1.0x/1.2x each ~4% of labels) both failed to beat their own shuffled placebo, while an oracle
check (RESEARCH_CLAIM ml_phase1_oracle_bound_real_room_20261007) showed a large, clean, genuinely
per-touch real gap (+$33.65/trade) exists between perfect hindsight and the 1.0x baseline.

Two changes from v2:
  1. Binary label: widen=1 if ev_1.4 > ev_0.8 else shrink=0. Drops 1.0x/1.2x as label targets
     (they were rarely optimal -- 152+159 of 3899 trades, ~8% combined -- and are what made v2's
     4-class problem severely imbalanced). The binary split is close to balanced (53%/47%).
     Deployed value: 0.8x or 1.4x exactly, same ground-truth EV lookup as before.
  2. A real hyperparameter sweep (small grid, picked on a held-out validation slice carved out
     of fold 1's own training data -- never touches any of the 3 walk-forward test folds, so
     the sweep itself can't leak into the reported out-of-fold result), instead of reusing the
     TAKE/VETO binary classifier's own hyperparameters unchanged.

Same 3-fold expanding walk-forward (PURGE_DAYS=3) + day-block label-permutation shuffle-placebo
as v1/v2, same real bar-walked ground-truth EV lookup.

Run manually: ./venv/bin/python3 scripts/ml_meta_labeling/pilot_phase0_shuffle_placebo_v3_binary_sweep_20261007.py
"""
import sys
import os
import itertools
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import feature_cols, build_feature_dict, EXISTING_FEATURE_COLS

CSV_PATH = '/home/mmoniz/trading-journal/scratch/ml_phase0_pertrade_ev_20261007.csv'
PURGE_DAYS = 3
N_FOLDS = 3
RNG_SEED = 20261007

# Small, deliberately modest grid -- this is still a Phase-0-style cheap screen, not a
# production sweep. 12 combos, evaluated by validation AUC on a held-out slice.
PARAM_GRID = {
    'n_estimators': [100, 300],
    'max_depth': [3, 5],
    'learning_rate': [0.03, 0.1],
    'num_leaves': [15, 31],
}


def label_row_binary(row):
    return 1 if row['ev_1.4'] > row['ev_0.8'] else 0


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
    return means[int(iters * 0.025)], means[int(iters * 0.975)]


def sweep_hyperparams(X_train_val, y_train_val, val_frac=0.2):
    n = len(X_train_val)
    split = int(n * (1 - val_frac))
    X_tr, X_val = X_train_val.iloc[:split], X_train_val.iloc[split:]
    y_tr, y_val = y_train_val[:split], y_train_val[split:]
    best = None
    keys = list(PARAM_GRID.keys())
    combos = list(itertools.product(*PARAM_GRID.values()))
    print(f'Sweeping {len(combos)} hyperparameter combinations on a held-out validation slice (train={len(X_tr)}, val={len(X_val)})...')
    for combo in combos:
        params = dict(zip(keys, combo))
        model = lgb.LGBMClassifier(
            n_estimators=params['n_estimators'], max_depth=params['max_depth'],
            learning_rate=params['learning_rate'], num_leaves=params['num_leaves'],
            min_child_samples=20, objective='binary', verbosity=-1, random_state=RNG_SEED,
        )
        model.fit(X_tr, y_tr)
        proba = model.predict_proba(X_val)[:, 1]
        try:
            auc = roc_auc_score(y_val, proba)
        except ValueError:
            auc = 0.5
        if best is None or auc > best[1]:
            best = (params, auc)
    print(f'Best: {best[0]} (validation AUC={best[1]:.4f})\n')
    return best[0]


def main():
    print('=== Phase 0 pretest v4: binary shrink/widen + sweep + setup_type family feature ===\n')
    print('(v3 never gave the model setup_type/family as an input at all -- carried as')
    print('metadata only. A diagnostic showed widen-rate spreads from 11.5% to 60.7% across')
    print('setup families, a real pattern the model structurally could not have used.)\n')

    ev_df = pd.read_csv(CSV_PATH)
    ev_df['label'] = ev_df.apply(label_row_binary, axis=1)
    print(f'Loaded {len(ev_df)} trades.')
    print(f"Binary label distribution: shrink(0)={sum(ev_df['label']==0)}, widen(1)={sum(ev_df['label']==1)}\n")

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

    df = feat_df.merge(ev_df[['id', 'label', 'ev_0.8', 'ev_1.4', 'setup_type']], on='id', how='inner')
    df['_fired_dt'] = pd.to_datetime(df['fired_at'], format='mixed')
    df = df.sort_values('_fired_dt').reset_index(drop=True)

    # NEW in v4: setup family as a real input feature, native LightGBM categorical (pandas
    # 'category' dtype -- LGBMClassifier's sklearn wrapper auto-detects and splits on it
    # directly, no manual target-encoding/leakage risk since it's just the category identity,
    # not a precomputed historical rate).
    df['family'] = df['setup_type'].str.replace(r'_(LONG|SHORT)(_.*)?$', '', regex=True).astype('category')
    cols = cols + ['family']

    print(f'Merged dataset: {len(df)} rows, {df["trade_date"].nunique()} distinct dates, {df["family"].nunique()} families.\n')

    unique_dates = sorted(df['trade_date'].unique())
    n_dates = len(unique_dates)
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

    # Sweep hyperparameters ONCE, using only fold-1's own training data (strictly before any
    # test fold), so the sweep itself cannot leak into the reported out-of-fold comparison.
    fold1_test_start = pd.to_datetime(min(fold_test_dates[0]))
    fold1_purge_start = fold1_test_start - pd.Timedelta(days=PURGE_DAYS)
    sweep_pool = df[df['_fired_dt'] < fold1_purge_start]
    best_hp = sweep_hyperparams(sweep_pool[cols], sweep_pool['label'].values)

    rng = np.random.default_rng(RNG_SEED)
    real_rows = []
    shuf_rows = []

    for fold_i, test_dates in enumerate(fold_test_dates):
        test_dates_set = set(test_dates)
        test_start = pd.to_datetime(min(test_dates))
        purge_start = test_start - pd.Timedelta(days=PURGE_DAYS)
        train_df = df[df['_fired_dt'] < purge_start]
        test_df = df[df['trade_date'].isin(test_dates_set)]
        if len(train_df) < 100 or len(test_df) < 10:
            print(f'Fold {fold_i+1}: skipped (train={len(train_df)}, test={len(test_df)})')
            continue

        X_train, y_train = train_df[cols], train_df['label'].values
        X_test = test_df[cols]

        real_model = lgb.LGBMClassifier(
            n_estimators=best_hp['n_estimators'], max_depth=best_hp['max_depth'],
            learning_rate=best_hp['learning_rate'], num_leaves=best_hp['num_leaves'],
            min_child_samples=20, objective='binary', verbosity=-1, random_state=RNG_SEED,
        )
        real_model.fit(X_train, y_train)
        real_pred = real_model.predict(X_test)
        real_proba = real_model.predict_proba(X_test)[:, 1]

        train_dates_unique = train_df['trade_date'].unique()
        shuffled_dates = rng.permutation(train_dates_unique)
        date_map = dict(zip(train_dates_unique, shuffled_dates))
        real_labels_by_date = {d: train_df.loc[train_df['trade_date'] == d, 'label'].values for d in train_dates_unique}
        train_df_reset = train_df.reset_index(drop=True)
        shuffled_y = np.empty(len(train_df), dtype=int)
        for d in train_dates_unique:
            idx = train_df_reset.index[train_df_reset['trade_date'] == d].tolist()
            src_labels = real_labels_by_date[date_map[d]]
            for k, row_idx in enumerate(idx):
                shuffled_y[row_idx] = src_labels[k % len(src_labels)]

        shuf_model = lgb.LGBMClassifier(
            n_estimators=best_hp['n_estimators'], max_depth=best_hp['max_depth'],
            learning_rate=best_hp['learning_rate'], num_leaves=best_hp['num_leaves'],
            min_child_samples=20, objective='binary', verbosity=-1, random_state=RNG_SEED,
        )
        shuf_model.fit(X_train, shuffled_y)
        shuf_pred = shuf_model.predict(X_test)

        for i, (_, row) in enumerate(test_df.iterrows()):
            real_ev = row['ev_1.4'] if real_pred[i] == 1 else row['ev_0.8']
            shuf_ev = row['ev_1.4'] if shuf_pred[i] == 1 else row['ev_0.8']
            real_rows.append({'id': row['id'], 'date': row['trade_date'], 'ev': real_ev, 'proba': real_proba[i]})
            shuf_rows.append({'id': row['id'], 'date': row['trade_date'], 'ev': shuf_ev})

        print(f'Fold {fold_i+1}: train N={len(train_df)}, test N={len(test_df)}, dates {test_dates[0]}..{test_dates[-1]}')
        print(f'  real pred: shrink={sum(real_pred==0)} widen={sum(real_pred==1)}  |  shuffled pred: shrink={sum(shuf_pred==0)} widen={sum(shuf_pred==1)}')

    real_df = pd.DataFrame(real_rows)
    shuf_df = pd.DataFrame(shuf_rows)
    print(f'\nTotal out-of-fold evaluations: {len(real_df)}\n')

    if len(real_df) < 20:
        print('FATAL: too few evaluations.')
        sys.exit(1)

    merged = real_df.merge(shuf_df, on=['id', 'date'], suffixes=('_real', '_shuf'))
    merged['diff'] = merged['ev_real'] - merged['ev_shuf']

    print('--- Pooled EV (real-model vs shuffled-placebo selected multiplier) ---')
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

    # Also compare vs the plain 1.0x baseline (not just vs shuffle), for direct comparability
    # to part 1/the oracle check.
    baseline_ev = ev_df.set_index('id').loc[merged['id'], 'ev_1.0'].values
    merged['diff_vs_baseline'] = merged['ev_real'].values - baseline_ev
    diffs_by_date_b = {}
    for (_, row), b in zip(merged.iterrows(), merged['diff_vs_baseline']):
        diffs_by_date_b.setdefault(row['date'], []).append(b)
    diffs_by_date_b = {k: np.array(v) for k, v in diffs_by_date_b.items()}
    lo_b, hi_b = day_blocked_bootstrap_ci(diffs_by_date_b, seed=RNG_SEED + 1)
    excl_b = lo_b > 0 or hi_b < 0
    print(f'Real model vs 1.0x baseline: mean diff ${merged["diff_vs_baseline"].mean():.2f}/trade, CI=[${lo_b:.2f}, ${hi_b:.2f}]{"  <<< excludes zero" if excl_b else ""}\n')

    print('=== VERDICT ===')
    if excludes_zero and mean_diff > 0:
        print('Real model beats the shuffled placebo with a CI excluding zero -- real per-touch')
        print('signal detected. ', end='')
        if excl_b and merged['diff_vs_baseline'].mean() > 0:
            print('It ALSO beats the 1.0x baseline with a CI excluding zero -- a genuine candidate.')
        else:
            print('Does NOT yet clearly beat the 1.0x baseline though -- real but not yet enough.')
    elif excludes_zero and mean_diff < 0:
        print('Real model is confirmed WORSE than the shuffled placebo again -- same failure')
        print('shape as v2, even after simplifying the label and sweeping hyperparameters.')
    else:
        print('No confirmed difference from the shuffled placebo (CI crosses zero) -- still no')
        print('clear per-touch signal captured by this model, even simplified and swept.')

    # Confidence-filtered follow-up: the blind "act on every prediction" rule above tests a
    # different question than "does the model add value where it is CONFIDENT" -- a modest
    # AUC (~0.55-0.58, confirmed to plateau rather than keep climbing with more training data,
    # per the separate train-size-vs-AUC check) can still carry real value if restricted to its
    # most confident predictions, the same way the live TAKE/VETO meta-labeler only acts above
    # a probability threshold rather than on every candidate.
    print('\n--- Confidence-filtered follow-up: does restricting to the model\'s most confident')
    print('    predictions (top/bottom quartile of predicted probability) show a real edge')
    print('    that the blind act-on-everything rule above washes out? ---')
    for q in [0.25, 0.15, 0.10]:
        lo_cut = merged['proba'].quantile(q)
        hi_cut = merged['proba'].quantile(1 - q)
        confident = merged[(merged['proba'] <= lo_cut) | (merged['proba'] >= hi_cut)]
        if len(confident) < 50:
            print(f'  quartile={q}: too few confident rows ({len(confident)}), skipping')
            continue
        diffs_by_date_c = {}
        for _, row in confident.iterrows():
            diffs_by_date_c.setdefault(row['date'], []).append(row['diff'])
        diffs_by_date_c = {k: np.array(v) for k, v in diffs_by_date_c.items()}
        lo_c, hi_c = day_blocked_bootstrap_ci(diffs_by_date_c, seed=RNG_SEED + 2)
        excl_c = lo_c > 0 or hi_c < 0
        mean_c = confident['diff'].mean()
        print(f'  top/bottom {q*100:.0f}% confident (N={len(confident)}): mean diff vs shuffled ${mean_c:.2f}/trade, CI=[${lo_c:.2f},${hi_c:.2f}]{"  <<< excludes zero" if excl_c else ""}')
        mean_cb = confident['diff_vs_baseline'].mean()
        diffs_by_date_cb = {}
        for _, row in confident.iterrows():
            diffs_by_date_cb.setdefault(row['date'], []).append(row['diff_vs_baseline'])
        diffs_by_date_cb = {k: np.array(v) for k, v in diffs_by_date_cb.items()}
        lo_cb, hi_cb = day_blocked_bootstrap_ci(diffs_by_date_cb, seed=RNG_SEED + 3)
        excl_cb = lo_cb > 0 or hi_cb < 0
        print(f'                              mean diff vs 1.0x baseline ${mean_cb:.2f}/trade, CI=[${lo_cb:.2f},${hi_cb:.2f}]{"  <<< excludes zero" if excl_cb else ""}')


if __name__ == '__main__':
    main()
