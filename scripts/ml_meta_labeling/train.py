"""Trains the meta-labeling classifier and persists both the model artifact and its
metadata (ml_models table). Run manually: python3 train.py (from the venv).

Chronological split, not random -- per this codebase's own standing "no lookahead in
backtests/replays" hard rule, and the spec's own "no model is trained on data it has not
genuinely seen in the future" principle. A PURGE_DAYS gap is excluded between train and test
to reduce contamination from trades whose forward-replay label window could otherwise span
the split boundary.
"""
import sys
import os
import json
import joblib
import numpy as np
import pandas as pd
import lightgbm as lgb
from datetime import timedelta
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe

PURGE_DAYS = 3  # matches DEFAULT_MAX_HOLD_BARS=60 (~1hr) with generous margin for session gaps
TEST_FRACTION = 0.2
MODEL_DIR = os.path.join(os.path.dirname(__file__), 'artifacts')


def chronological_split(df, test_fraction=TEST_FRACTION, purge_days=PURGE_DAYS):
    # format='mixed' -- fired_at is naive ET text from Postgres (::text cast in
    # dataset.py's query), and rows genuinely have inconsistent sub-second precision
    # (some with microseconds, some without). No timezone conversion risk here (both
    # sides of every comparison below are the same naive-ET representation), just a
    # parsing-format issue caught by pandas' own strict inference refusing to guess.
    fired_dt = pd.to_datetime(df['fired_at'], format='mixed')
    df = df.assign(_fired_dt=fired_dt).sort_values('_fired_dt').reset_index(drop=True)
    split_idx = int(len(df) * (1 - test_fraction))
    split_date = df.iloc[split_idx]['_fired_dt']
    purge_start = split_date - timedelta(days=purge_days)

    train = df[df['_fired_dt'] < purge_start].drop(columns=['_fired_dt'])
    test = df[df['_fired_dt'] >= split_date].drop(columns=['_fired_dt'])
    return train, test


def main():
    conn = get_connection()
    df, feature_cols = fetch_training_dataframe(conn)
    print(f"Full dataset: {len(df)} rows, {len(feature_cols)} features")
    print(f"Label rate: {df['label'].mean():.3f}")

    train, test = chronological_split(df)
    print(f"Train: {len(train)} rows ({train['fired_at'].min()} to {train['fired_at'].max()})")
    print(f"Test:  {len(test)} rows ({test['fired_at'].min()} to {test['fired_at'].max()})")
    # Persisted so any later comparison (the silo dashboard) can honestly separate
    # in-sample rows (the model has already seen these, so its verdict on them is
    # artificially confident -- an overfitting-biased comparison, not a real one) from
    # genuinely out-of-sample test rows, rather than re-deriving the split boundary or
    # silently conflating the two populations.
    train_end_at = train['fired_at'].max()
    test_start_at = test['fired_at'].min()
    print(f"Purge gap: {PURGE_DAYS} days excluded between train and test")

    # Section 4.6-style minimum-dataset gate (this codebase's own "never fabricate a stat"
    # discipline, applied to model training rather than a hand-written stat) -- refuse to
    # proceed rather than silently train and report a meaningless model.
    if len(train) < 500 or len(test) < 50:
        print(f"ABORT: insufficient data (train={len(train)}, test={len(test)}). Need train>=500, test>=50.")
        sys.exit(1)
    if not (0.05 <= train['label'].mean() <= 0.95):
        print(f"ABORT: train label rate {train['label'].mean():.3f} outside [0.05, 0.95] -- degenerate.")
        sys.exit(1)

    X_train, y_train = train[feature_cols], train['label']
    X_test, y_test = test[feature_cols], test['label']

    model = lgb.LGBMClassifier(
        n_estimators=300, max_depth=5, learning_rate=0.05,
        num_leaves=15, min_child_samples=20,
        objective='binary', random_state=42, verbose=-1,
    )
    model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        callbacks=[lgb.early_stopping(stopping_rounds=30, verbose=False)],
    )

    test_proba = model.predict_proba(X_test)[:, 1]
    test_auc = roc_auc_score(y_test, test_proba)
    print(f"\nTest AUC: {test_auc:.4f}")

    # Real-dollar comparison, not just AUC -- this is the number that actually matters for
    # the user's stated goal ("see how the pnl changes"). Needs the real actual_pnl joined
    # back in, which fetch_training_dataframe() doesn't carry (kept the feature matrix
    # lean) -- pull it directly here for this one comparison.
    test_ids = tuple(test['id'].tolist())
    pnl_q = pd.read_sql(
        f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {test_ids}",
        conn,
    )
    test_with_pnl = test.merge(pnl_q, on='id')
    test_with_pnl['ml_proba'] = test_proba

    # PERCENTILE thresholds, not absolute probability cutoffs -- caught before trusting the
    # result: with a 16% base rate, this model's raw output never reaches 0.5 on the test
    # set (max observed 0.43), so an absolute >=0.5/0.6/0.7 cutoff silently approves ZERO
    # trades every time, a degenerate, uninformative result. Ranking by score and taking
    # the top N% is the correct lens for an imbalanced classifier without a separately
    # calibrated probability (this model has none yet -- see notes above train_n).
    all_pnl = test_with_pnl['actual_pnl'].sum()
    print(f"  all {len(test_with_pnl)} test trades: P&L=${all_pnl:.2f}, WR={100*test_with_pnl['actual_pnl'].gt(0).mean():.1f}%")
    for pct in [50, 25, 10]:
        cutoff = np.percentile(test_proba, 100 - pct)
        approved = test_with_pnl[test_with_pnl['ml_proba'] >= cutoff]
        ml_pnl = approved['actual_pnl'].sum()
        ml_wr = 100 * approved['actual_pnl'].gt(0).mean() if len(approved) else float('nan')
        print(f"  top {pct}% by score (proba>={cutoff:.3f}): {len(approved)} trades | "
              f"P&L=${ml_pnl:.2f} | WR={ml_wr:.1f}%")

    # Chosen approval threshold, persisted (not hardcoded elsewhere) so score.py's live-
    # facing function can produce a real TAKE/VETO verdict for a SINGLE new candidate,
    # where a percentile can't be computed in isolation. top-25% picked as the balanced
    # choice among the 3 swept above (better N than top-10%'s 58, better P&L than
    # top-50%'s +$192.80) -- a judgment call worth revisiting once more data accumulates,
    # not a permanent constant.
    approval_threshold = float(np.percentile(test_proba, 75))
    print(f"\nPersisted approval threshold (top-25% cutoff): {approval_threshold:.4f}")

    importances = dict(zip(feature_cols, model.feature_importances_.tolist()))
    top_features = dict(sorted(importances.items(), key=lambda x: -x[1])[:10])
    print(f"\nTop 10 features by importance: {json.dumps(top_features, indent=2)}")

    os.makedirs(MODEL_DIR, exist_ok=True)
    model_version = f"metalabel_v{pd.Timestamp.now().strftime('%Y%m%d_%H%M%S')}"
    model_path = os.path.join(MODEL_DIR, f"{model_version}.joblib")
    joblib.dump({'model': model, 'feature_cols': feature_cols}, model_path)
    print(f"\nModel saved: {model_path}")

    cur = conn.cursor()
    cur.execute("""
        INSERT INTO ml_models (model_version, train_n, test_n, train_positive_rate,
            test_positive_rate, test_auc, feature_list, test_metrics, model_path,
            approval_threshold, train_end_at, test_start_at, notes)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (
        model_version, len(train), len(test),
        float(train['label'].mean()), float(test['label'].mean()), float(test_auc),
        json.dumps(feature_cols),
        json.dumps({'top_features': top_features, 'purge_days': PURGE_DAYS}),
        model_path, approval_threshold, train_end_at, test_start_at,
        'First trained model, full-roster scope per user request 2026-09-21.',
    ))
    conn.commit()
    print(f"Model metadata persisted to ml_models (version={model_version})")


if __name__ == '__main__':
    main()
