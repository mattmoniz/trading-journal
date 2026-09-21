"""True walk-forward validation, not a single train/test split. train.py's single
chronological split gives one number that could be a lucky or unlucky draw from one
specific test window -- this retrains repeatedly over an EXPANDING window and scores each
successive period out-of-sample, so the reported P&L is the sum of many genuinely
independent out-of-sample folds, not one.

Correctness point this script gets right that the single-split train.py does NOT: the
approval_threshold for each fold is derived from that fold's own TRAINING set's predicted
probabilities, never from the fold being scored. train.py's single-split version computes
its threshold from the TEST set's own score distribution -- a defensible one-shot backtest
simplification, but a real methodological gap for anything claiming to simulate "what would
have actually happened live," where you'd only ever know your training-period score
distribution at decision time, never the future fold's.

Deliberately NOT integrated into ml_models/ml_verdicts (the live-facing "current model"
tables that server/services/mlSiloService.js reads) -- this is a VALIDATION run, answering
"does this approach hold up across multiple independent periods," not a model meant to
serve live scoring. Results are written to scratch/walkforward_results.json (per-trade,
with real IDs) so Claude can independently re-verify day-clustering/chronological stability
via the REAL computeRigor() function (server/services/rigorDiagnostics.js) rather than
hand-rolling that check a second time in Python.

Run manually: python3 walkforward.py
"""
import sys
import os
import json
import numpy as np
import pandas as pd
import lightgbm as lgb
from datetime import timedelta

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe

PURGE_DAYS = 3
FOLD_DAYS = 7
MIN_TRAIN_N = 500
APPROVAL_PERCENTILE = 75  # matches train.py's single-split choice, for comparability


def main():
    conn = get_connection()
    df, feature_cols = fetch_training_dataframe(conn)
    fired_dt = pd.to_datetime(df['fired_at'], format='mixed')
    df = df.assign(_fired_dt=fired_dt).sort_values('_fired_dt').reset_index(drop=True)
    print(f"Full dataset: {len(df)} rows, spanning {df['_fired_dt'].min()} to {df['_fired_dt'].max()}")

    # Pull real actual_pnl for every candidate row up front (dataset.py's own frame doesn't
    # carry it, kept lean on purpose) -- one query, not one per fold.
    ids = tuple(df['id'].tolist())
    pnl_q = pd.read_sql(f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {ids}", conn)
    df = df.merge(pnl_q, on='id')

    start = df['_fired_dt'].min()
    end = df['_fired_dt'].max()
    fold_start = start

    fold_results = []
    fold_summaries = []
    skipped_thin_train = 0

    while fold_start < end:
        fold_end = fold_start + timedelta(days=FOLD_DAYS)
        purge_boundary = fold_start - timedelta(days=PURGE_DAYS)

        train_mask = df['_fired_dt'] < purge_boundary
        fold_mask = (df['_fired_dt'] >= fold_start) & (df['_fired_dt'] < fold_end)

        train = df[train_mask]
        fold = df[fold_mask]

        if len(fold) == 0:
            fold_start = fold_end
            continue
        if len(train) < MIN_TRAIN_N or not (0.05 <= train['label'].mean() <= 0.95 if len(train) else False):
            skipped_thin_train += len(fold)
            fold_start = fold_end
            continue

        model = lgb.LGBMClassifier(
            n_estimators=300, max_depth=5, learning_rate=0.05,
            num_leaves=15, min_child_samples=20,
            objective='binary', random_state=42, verbose=-1,
        )
        model.fit(train[feature_cols], train['label'])

        # Threshold from the TRAINING set's own scores -- never the fold being scored.
        train_proba = model.predict_proba(train[feature_cols])[:, 1]
        threshold = float(np.percentile(train_proba, APPROVAL_PERCENTILE))

        fold_proba = model.predict_proba(fold[feature_cols])[:, 1]
        fold_out = fold[['id', 'setup_type', 'fired_at', 'trade_date', 'actual_pnl']].copy()
        fold_out['probability'] = fold_proba
        fold_out['verdict'] = np.where(fold_proba >= threshold, 'TAKE', 'VETO')
        fold_out['fold_start'] = fold_start.strftime('%Y-%m-%d')
        fold_results.append(fold_out)

        take = fold_out[fold_out['verdict'] == 'TAKE']
        fold_summaries.append({
            'fold_start': fold_start.strftime('%Y-%m-%d'), 'fold_end': fold_end.strftime('%Y-%m-%d'),
            'train_n': len(train), 'fold_n': len(fold), 'threshold': round(threshold, 4),
            'all_pnl': round(float(fold_out['actual_pnl'].sum()), 2),
            'take_n': len(take), 'take_pnl': round(float(take['actual_pnl'].sum()), 2),
        })
        fold_start = fold_end

    if not fold_results:
        print("No folds had enough training data -- cannot walk forward yet.")
        sys.exit(1)

    all_folds = pd.concat(fold_results, ignore_index=True)
    print(f"\n{len(fold_summaries)} folds scored, {skipped_thin_train} rows skipped (insufficient training data yet)")
    print(f"\n{'Fold':<12}{'TrainN':>8}{'FoldN':>7}{'Thresh':>8}{'AllPnL':>12}{'TakeN':>7}{'TakePnL':>12}")
    for f in fold_summaries:
        print(f"{f['fold_start']:<12}{f['train_n']:>8}{f['fold_n']:>7}{f['threshold']:>8.3f}"
              f"{f['all_pnl']:>12.2f}{f['take_n']:>7}{f['take_pnl']:>12.2f}")

    total_all_pnl = all_folds['actual_pnl'].sum()
    take_rows = all_folds[all_folds['verdict'] == 'TAKE']
    total_take_pnl = take_rows['actual_pnl'].sum()
    total_n = len(all_folds)
    take_n = len(take_rows)

    print(f"\n=== WALK-FORWARD TOTALS ({total_n} trades across {len(fold_summaries)} folds) ===")
    print(f"All trades:   N={total_n}, P&L=${total_all_pnl:.2f}, WR={100*all_folds['actual_pnl'].gt(0).mean():.1f}%")
    print(f"ML-approved:  N={take_n}, P&L=${total_take_pnl:.2f}, WR={100*take_rows['actual_pnl'].gt(0).mean():.1f}%")

    out_path = os.path.join(os.path.dirname(__file__), '..', '..', 'scratch', 'walkforward_results.json')
    all_folds.to_json(out_path, orient='records', date_format='iso')
    print(f"\nPer-trade results written to {out_path} for independent rigor verification (computeRigor()).")


if __name__ == '__main__':
    main()
