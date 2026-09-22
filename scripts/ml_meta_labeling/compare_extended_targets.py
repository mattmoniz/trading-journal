"""Exploratory comparison, NOT part of the production pipeline (2026-09-21, user request:
"Can we also test the model on 5x targets and 10x targets as well as the 2.5x? Just to
see"). Trains 3 separate models -- one per extended-target label definition (2.5x, 5x,
10x) -- on the SAME real features/population, using the SAME chronological train/val/test
split logic as train.py (imported, not reimplemented), and reports each one's Test AUC plus
the tercile-by-probability breakdown (avg real P&L / win rate / STOP_HIT rate) that
diagnosed the 2.5x model's own label-target mismatch: HIGH-confidence trades stop out on
their own real, tighter stop far more often than LOW/MID (49.4% vs ~38%), because "likely to
eventually reach a big move" and "likely to survive to its own real, closer stop" pull in
opposite directions.

Question this answers: does a WIDER extended target make that mismatch better, worse, or
unchanged? A wider target should, if anything, sharpen the model's focus on genuinely
higher-conviction setups (fewer, but more decisive, moves) -- OR it could make the mismatch
worse (an even more volatility-seeking signature, even more prone to stopping out on the
real, tight exit). This script measures it rather than guessing.

Deliberately does NOT persist to ml_models/ml_verdicts -- exploratory only, not a live
model. Run manually: python3 compare_extended_targets.py (from the venv).
"""
import sys
import os
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe, compute_sample_weights
from train import chronological_split
from hyperparams import load_hyperparams

VARIANTS = [
    {'label': '2.5x (production)', 'column': 'ml_extended_label'},
    {'label': '5x', 'column': 'ml_extended_label_5x'},
    {'label': '10x', 'column': 'ml_extended_label_10x'},
]


def tercile_breakdown(test_with_pnl, test_proba, threshold):
    approved = test_with_pnl[test_with_pnl['ml_proba'] >= threshold].sort_values('ml_proba').reset_index(drop=True)
    n = len(approved)
    if n < 9:
        return None
    third = n // 3
    buckets = [approved.iloc[:third], approved.iloc[third:2 * third], approved.iloc[2 * third:]]
    labels = ['LOW', 'MID', 'HIGH']
    rows = []
    for label, b in zip(labels, buckets):
        stop_rate = 100 * (b['resolution'] == 'STOP_HIT').sum() / len(b)
        rows.append({
            'bucket': label, 'n': len(b),
            'avg_pnl': round(b['actual_pnl'].mean(), 2),
            'wr': round(100 * (b['actual_pnl'] > 0).mean(), 1),
            'stop_rate': round(stop_rate, 1),
        })
    return rows


def run_variant(conn, variant):
    label_col = variant['column']
    df, feature_cols = fetch_training_dataframe(conn, label_column=label_col)
    print(f"\n{'='*70}\n{variant['label']}  (label_column={label_col})\n{'='*70}")
    print(f"Full dataset: {len(df)} rows, label rate={df['label'].mean():.3f}")

    train, val, test = chronological_split(df)
    print(f"Train={len(train)}  Val={len(val)}  Test={len(test)}")
    if len(train) < 500 or len(val) < 50 or len(test) < 50:
        print("SKIPPED -- insufficient data yet for this target width (need train>=500, val>=50, test>=50).")
        return None
    if not (0.05 <= train['label'].mean() <= 0.95):
        print(f"SKIPPED -- train label rate {train['label'].mean():.3f} outside [0.05, 0.95], degenerate.")
        return None

    hp = load_hyperparams(conn)
    model = lgb.LGBMClassifier(
        **hp,
        objective='binary', random_state=42, verbose=-1,
    )
    # Sample weights (2026-09-22, matches train.py's own fix, OPEN_DECISION
    # ml_silo_deepseek_followup_review_parked_20260921) -- correlated cluster siblings
    # down-weighted so one real market moment doesn't teach the model N independent lessons.
    train_weight = compute_sample_weights(train)
    model.fit(
        train[feature_cols], train['label'], sample_weight=train_weight,
        eval_set=[(val[feature_cols], val['label'])],
        callbacks=[lgb.early_stopping(stopping_rounds=30, verbose=False)],
    )

    val_proba = model.predict_proba(val[feature_cols])[:, 1]
    threshold = float(np.percentile(val_proba, 75))

    test_proba = model.predict_proba(test[feature_cols])[:, 1]
    test_auc = roc_auc_score(test['label'], test_proba)

    test_ids = tuple(test['id'].tolist())
    pnl_q = pd.read_sql(
        f"SELECT id, actual_pnl::float AS actual_pnl, resolution FROM active_setups WHERE id IN {test_ids}",
        conn,
    )
    test_with_pnl = test.merge(pnl_q, on='id')
    test_with_pnl['ml_proba'] = test_proba
    approved = test_with_pnl[test_with_pnl['ml_proba'] >= threshold]

    all_pnl = test_with_pnl['actual_pnl'].sum()
    approved_pnl = approved['actual_pnl'].sum()
    print(f"Test AUC: {test_auc:.4f}  (threshold={threshold:.4f}, from VAL)")
    print(f"  ALL {len(test_with_pnl)} test trades:      P&L=${all_pnl:.2f}  WR={100*test_with_pnl['actual_pnl'].gt(0).mean():.1f}%")
    print(f"  ML-approved {len(approved)} trades:         P&L=${approved_pnl:.2f}  WR={100*approved['actual_pnl'].gt(0).mean():.1f}%")

    tercile = tercile_breakdown(test_with_pnl, test_proba, threshold)
    if tercile:
        print("  Tercile breakdown (within ML-approved, by probability):")
        for row in tercile:
            print(f"    {row['bucket']:5s} N={row['n']:3d}  avgP&L=${row['avg_pnl']:8.2f}  WR={row['wr']:5.1f}%  STOP_HIT rate={row['stop_rate']:5.1f}%")
    else:
        print("  (too few approved trades for a tercile breakdown)")

    return {
        'variant': variant['label'], 'n_full': len(df), 'label_rate': round(df['label'].mean(), 3),
        'train_n': len(train), 'val_n': len(val), 'test_n': len(test),
        'test_auc': round(test_auc, 4), 'threshold': round(threshold, 4),
        'all_pnl': round(all_pnl, 2), 'approved_n': len(approved), 'approved_pnl': round(approved_pnl, 2),
        'tercile': tercile,
    }


def main():
    conn = get_connection()
    results = []
    for variant in VARIANTS:
        r = run_variant(conn, variant)
        if r:
            results.append(r)

    print(f"\n\n{'='*70}\nSUMMARY\n{'='*70}")
    print(f"{'Variant':<18}{'N':>7}{'LabelRate':>11}{'TestAUC':>9}{'AllPnL':>12}{'ApprN':>7}{'ApprPnL':>12}{'TopHIGHStopRate':>18}")
    for r in results:
        high_stop = r['tercile'][2]['stop_rate'] if r['tercile'] else float('nan')
        print(f"{r['variant']:<18}{r['n_full']:>7}{r['label_rate']:>11.3f}{r['test_auc']:>9.4f}"
              f"{r['all_pnl']:>12.2f}{r['approved_n']:>7}{r['approved_pnl']:>12.2f}{high_stop:>18.1f}")


if __name__ == '__main__':
    main()
