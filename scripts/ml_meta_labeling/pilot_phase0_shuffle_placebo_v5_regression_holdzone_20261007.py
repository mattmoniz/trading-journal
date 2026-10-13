"""Phase 0 pretest, v5: regression-on-EV-gap + explicit hold-zone, per DeepSeek's QA review of
v1-v4 (same day, 2026-10-07). DeepSeek's verdict: the test chain (v1-v4) was methodologically
sound, but TWO real gaps existed in what was actually tested:

  Gap A -- train/in-sample AUC was never reported, so there's no ceiling diagnostic: is the
  ~0.55-0.58 validation AUC already close to what the features can ever deliver, or is there
  real headroom being lost to overfitting/nonstationarity?

  Gap B -- v3/v4's binary shrink(0.8x)/widen(1.4x) framing structurally forbids "hold at 1.0x"
  (today's pooled-best action). A model forced to ALWAYS deviate is fighting both extremes
  (each worse than 1.0x on average) instead of only deviating when it has real evidence. The
  confidence-filtered follow-up in v4 DROPPED uncertain trades from the reported EV instead of
  correctly DEPLOYING 1.0x on them -- not the same test.

This script fixes both:
  1. Reports TRAIN (in-sample) AUC alongside validation AUC, using the v4-style binary
     classifier, as the ceiling check.
  2. Reframes as REGRESSION: predict the continuous, magnitude-aware target
     diff = ev_1.4 - ev_0.8 (not the lossy binary argmax label). Threshold is swept on a
     held-out validation slice (same no-leakage discipline as v3's hyperparameter sweep) --
     only deviate from 1.0x when |predicted diff| clears the threshold; HOLD (use ev_1.0)
     otherwise. Evaluated over ALL out-of-fold trades, including the holds, against (a) the
     always-hold-1.0x baseline and (b) a day-block-shuffled placebo of the same regression+
     threshold pipeline.

Run manually: ./venv/bin/python3 scripts/ml_meta_labeling/pilot_phase0_shuffle_placebo_v5_regression_holdzone_20261007.py
"""
import sys
import os
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
BEST_BINARY_HP = {'n_estimators': 300, 'max_depth': 5, 'learning_rate': 0.03, 'num_leaves': 31}  # from v4's sweep


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


def bootstrap_ci_from_rows(rows_with_date_and_val, val_key, seed=RNG_SEED):
    d = {}
    for r in rows_with_date_and_val:
        d.setdefault(r['date'], []).append(r[val_key])
    d = {k: np.array(v) for k, v in d.items()}
    return day_blocked_bootstrap_ci(d, seed=seed)


def main():
    print('=== Phase 0 pretest v5: train-AUC ceiling check + regression-on-EV-gap with hold-zone ===\n')
    print('Per DeepSeek QA (2026-10-07): v1-v4 methodology is sound, but (a) never reported an')
    print('in-sample AUC ceiling, and (b) never let the model actually HOLD at 1.0x -- it was')
    print('always forced to deviate. This fixes both.\n')

    ev_df = pd.read_csv(CSV_PATH)
    ev_df['diff'] = ev_df['ev_1.4'] - ev_df['ev_0.8']
    ev_df['widen_label'] = (ev_df['diff'] > 0).astype(int)

    conn = get_connection()
    ids = tuple(int(i) for i in ev_df['id'])
    q = f"""SELECT id, fired_at::text AS fired_at, trade_date::text AS trade_date,
        entry_zone_low::float AS entry_zone_low, stop_level::float AS stop_level,
        ml_pd_features, ml_intraday_features, {', '.join(EXISTING_FEATURE_COLS)}
        FROM active_setups WHERE id IN %(ids)s"""
    feat_df = pd.read_sql(q, conn, params={'ids': ids})
    conn.close()

    feat_df['is_long'] = feat_df['stop_level'] < feat_df['entry_zone_low']
    cols = feature_cols()
    flattened = feat_df.apply(
        lambda row: build_feature_dict(
            row['ml_pd_features'], row['ml_intraday_features'],
            {c: row[c] for c in EXISTING_FEATURE_COLS}, is_long=row['is_long'],
        ), axis=1, result_type='expand',
    )
    for c in cols:
        feat_df[c] = flattened[c]

    df = feat_df.merge(ev_df[['id', 'diff', 'widen_label', 'ev_0.8', 'ev_1.0', 'ev_1.4', 'setup_type']], on='id', how='inner')
    df['family'] = df['setup_type'].str.replace(r'_(LONG|SHORT)(_.*)?$', '', regex=True).astype('category')
    cols = cols + ['family']
    df['_fired_dt'] = pd.to_datetime(df['fired_at'], format='mixed')
    df = df.sort_values('_fired_dt').reset_index(drop=True)
    print(f'Merged dataset: {len(df)} rows, {df["trade_date"].nunique()} distinct dates.\n')

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

    # ---- PART 1: TRAIN-AUC CEILING CHECK (DeepSeek Gap A) ----
    print('--- Part 1: train (in-sample) vs validation AUC ceiling check ---')
    fold1_test_start = pd.to_datetime(min(fold_test_dates[0]))
    fold1_purge_start = fold1_test_start - pd.Timedelta(days=PURGE_DAYS)
    sweep_pool = df[df['_fired_dt'] < fold1_purge_start]
    split = int(len(sweep_pool) * 0.8)
    tr, val = sweep_pool.iloc[:split], sweep_pool.iloc[split:]
    ceiling_model = lgb.LGBMClassifier(
        n_estimators=BEST_BINARY_HP['n_estimators'], max_depth=BEST_BINARY_HP['max_depth'],
        learning_rate=BEST_BINARY_HP['learning_rate'], num_leaves=BEST_BINARY_HP['num_leaves'],
        min_child_samples=20, objective='binary', verbosity=-1, random_state=RNG_SEED,
    )
    ceiling_model.fit(tr[cols], tr['widen_label'])
    train_auc = roc_auc_score(tr['widen_label'], ceiling_model.predict_proba(tr[cols])[:, 1])
    val_auc = roc_auc_score(val['widen_label'], ceiling_model.predict_proba(val[cols])[:, 1])
    print(f'  train N={len(tr)}: in-sample AUC={train_auc:.4f}')
    print(f'  val   N={len(val)}: held-out AUC={val_auc:.4f}')
    gap = train_auc - val_auc
    print(f'  gap (train - val) = {gap:.4f}')
    if train_auc < 0.60:
        print('  -> train AUC is ALSO near-chance: the features genuinely do not separate the')
        print('     label even with unlimited capacity to overfit. This is close to the real')
        print('     ceiling for these features -- not an overfitting/tuning problem.')
    elif gap > 0.15:
        print('  -> large train/val gap: real overfitting, not a dead label -- more')
        print('     regularization/data could plausibly still help.')
    else:
        print('  -> train AUC is higher but gap is moderate -- ambiguous, worth a second look.')
    print()

    # ---- PART 2: REGRESSION + HOLD-ZONE (DeepSeek Gap B) ----
    print('--- Part 2: regression on EV gap (ev_1.4 - ev_0.8) + hold-zone, evaluated on ALL trades ---')

    # Sweep the hold-zone threshold on the SAME validation slice (never touches test folds).
    reg_sweep = lgb.LGBMRegressor(
        n_estimators=BEST_BINARY_HP['n_estimators'], max_depth=BEST_BINARY_HP['max_depth'],
        learning_rate=BEST_BINARY_HP['learning_rate'], num_leaves=BEST_BINARY_HP['num_leaves'],
        min_child_samples=20, verbosity=-1, random_state=RNG_SEED,
    )
    reg_sweep.fit(tr[cols], tr['diff'])
    val_pred = reg_sweep.predict(val[cols])

    def ev_for_threshold(pred, frame, thresh):
        action_ev = np.where(pred > thresh, frame['ev_1.4'].values,
                      np.where(pred < -thresh, frame['ev_0.8'].values, frame['ev_1.0'].values))
        return action_ev.mean()

    print('  Sweeping hold-zone threshold on validation slice:')
    always_hold_val = val['ev_1.0'].mean()
    print(f'    always-hold baseline (val): ${always_hold_val:.2f}/trade')
    thresholds = [0, np.percentile(np.abs(val_pred), 50), np.percentile(np.abs(val_pred), 70),
                  np.percentile(np.abs(val_pred), 85), np.percentile(np.abs(val_pred), 95)]
    best_thresh, best_val_ev = None, -1e9
    for th in thresholds:
        ev = ev_for_threshold(val_pred, val, th)
        n_deviate = (np.abs(val_pred) > th).sum()
        print(f'    threshold={th:.2f} (deviate on {n_deviate}/{len(val)} = {100*n_deviate/len(val):.0f}%): val EV=${ev:.2f}/trade')
        if ev > best_val_ev:
            best_val_ev, best_thresh = ev, th
    print(f'  Best threshold from validation: {best_thresh:.2f}\n')

    # Now the real 3-fold walk-forward with this fixed threshold, + day-block shuffle placebo.
    rng = np.random.default_rng(RNG_SEED)
    real_rows, shuf_rows, hold_rows = [], [], []

    for fold_i, test_dates in enumerate(fold_test_dates):
        test_dates_set = set(test_dates)
        test_start = pd.to_datetime(min(test_dates))
        purge_start = test_start - pd.Timedelta(days=PURGE_DAYS)
        train_df = df[df['_fired_dt'] < purge_start]
        test_df = df[df['trade_date'].isin(test_dates_set)]
        if len(train_df) < 100 or len(test_df) < 10:
            print(f'Fold {fold_i+1}: skipped (train={len(train_df)}, test={len(test_df)})')
            continue

        reg_model = lgb.LGBMRegressor(
            n_estimators=BEST_BINARY_HP['n_estimators'], max_depth=BEST_BINARY_HP['max_depth'],
            learning_rate=BEST_BINARY_HP['learning_rate'], num_leaves=BEST_BINARY_HP['num_leaves'],
            min_child_samples=20, verbosity=-1, random_state=RNG_SEED,
        )
        reg_model.fit(train_df[cols], train_df['diff'])
        pred = reg_model.predict(test_df[cols])

        # Day-block shuffle the REGRESSION TARGET across training days (same convention as v1-v4).
        train_dates_unique = train_df['trade_date'].unique()
        shuffled_dates = rng.permutation(train_dates_unique)
        date_map = dict(zip(train_dates_unique, shuffled_dates))
        real_diffs_by_date = {d: train_df.loc[train_df['trade_date'] == d, 'diff'].values for d in train_dates_unique}
        train_df_reset = train_df.reset_index(drop=True)
        shuffled_diff = np.empty(len(train_df))
        for d in train_dates_unique:
            idx = train_df_reset.index[train_df_reset['trade_date'] == d].tolist()
            src = real_diffs_by_date[date_map[d]]
            for k, row_idx in enumerate(idx):
                shuffled_diff[row_idx] = src[k % len(src)]
        shuf_model = lgb.LGBMRegressor(
            n_estimators=BEST_BINARY_HP['n_estimators'], max_depth=BEST_BINARY_HP['max_depth'],
            learning_rate=BEST_BINARY_HP['learning_rate'], num_leaves=BEST_BINARY_HP['num_leaves'],
            min_child_samples=20, verbosity=-1, random_state=RNG_SEED,
        )
        shuf_model.fit(train_df[cols], shuffled_diff)
        shuf_pred = shuf_model.predict(test_df[cols])

        for i, (_, row) in enumerate(test_df.iterrows()):
            p, sp = pred[i], shuf_pred[i]
            real_ev = row['ev_1.4'] if p > best_thresh else (row['ev_0.8'] if p < -best_thresh else row['ev_1.0'])
            shuf_ev = row['ev_1.4'] if sp > best_thresh else (row['ev_0.8'] if sp < -best_thresh else row['ev_1.0'])
            real_rows.append({'id': row['id'], 'date': row['trade_date'], 'ev': real_ev})
            shuf_rows.append({'id': row['id'], 'date': row['trade_date'], 'ev': shuf_ev})
            hold_rows.append({'id': row['id'], 'date': row['trade_date'], 'ev': row['ev_1.0']})

        n_dev = int((np.abs(pred) > best_thresh).sum())
        print(f'Fold {fold_i+1}: train N={len(train_df)}, test N={len(test_df)}, deviated on {n_dev}/{len(test_df)} ({100*n_dev/len(test_df):.0f}%)')

    print(f'\nTotal out-of-fold evaluations: {len(real_rows)}\n')
    real_mean = np.mean([r['ev'] for r in real_rows])
    shuf_mean = np.mean([r['ev'] for r in shuf_rows])
    hold_mean = np.mean([r['ev'] for r in hold_rows])
    print('--- Pooled EV across ALL out-of-fold trades (including holds) ---')
    print(f'  Always-hold (1.0x, every trade):        ${hold_mean:.2f}/trade')
    print(f'  Real model (deviate-when-confident):    ${real_mean:.2f}/trade')
    print(f'  Shuffled-target placebo (same policy):  ${shuf_mean:.2f}/trade')

    merged_diff = [{'date': r['date'], 'diff': r['ev'] - s['ev']} for r, s in zip(real_rows, shuf_rows)]
    lo, hi = bootstrap_ci_from_rows(merged_diff, 'diff', seed=RNG_SEED)
    excl = lo > 0 or hi < 0
    print(f'\n  Real vs shuffled: mean diff ${real_mean - shuf_mean:.2f}/trade, CI=[${lo:.2f},${hi:.2f}]{"  <<< excludes zero" if excl else ""}')

    merged_vs_hold = [{'date': r['date'], 'diff': r['ev'] - h['ev']} for r, h in zip(real_rows, hold_rows)]
    lo_h, hi_h = bootstrap_ci_from_rows(merged_vs_hold, 'diff', seed=RNG_SEED + 1)
    excl_h = lo_h > 0 or hi_h < 0
    print(f'  Real vs always-hold: mean diff ${real_mean - hold_mean:.2f}/trade, CI=[${lo_h:.2f},${hi_h:.2f}]{"  <<< excludes zero" if excl_h else ""}')

    print('\n=== VERDICT ===')
    if excl and (real_mean - shuf_mean) > 0 and excl_h and (real_mean - hold_mean) > 0:
        print('Real model with a proper hold-zone beats BOTH the shuffled placebo AND always-hold,')
        print('both with CIs excluding zero -- a genuine, confirmed per-touch edge.')
    elif excl and (real_mean - shuf_mean) < 0:
        print('Real model confirmed WORSE than shuffle again, even with the hold-zone fix -- same')
        print('negative shape as before, now with a cleaner test design.')
    else:
        print('No confirmed edge even with the hold-zone correctly implemented (CI crosses zero).')
        print('Combined with the train-AUC ceiling check above, this is the most honest version')
        print('of "no demonstrated usable edge" reached so far.')


if __name__ == '__main__':
    main()
