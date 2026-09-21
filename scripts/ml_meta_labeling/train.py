"""Trains the meta-labeling classifier and persists both the model artifact and its
metadata (ml_models table). Run manually: python3 train.py (from the venv).

Chronological split, not random -- per this codebase's own standing "no lookahead in
backtests/replays" hard rule, and the spec's own "no model is trained on data it has not
genuinely seen in the future" principle. A PURGE_DAYS gap is excluded between each
consecutive split boundary to reduce contamination from trades whose forward-replay label
window could otherwise span it.

THREE-WAY split (train / val / test), not train/test. Fixed 2026-09-21 after a DeepSeek
full-code-review found the original two-way split's TEST set was reused three times during
training -- for LightGBM early-stopping's own loss-based model selection, for picking the
approval_threshold percentile, and for the reported AUC/P&L -- so "out of sample" was
overstated; the model had effectively seen the test set's loss curve. Now: VAL is used for
early stopping and threshold selection (the model/decision-maker gets to look at it), TEST is
touched exactly once, at the very end, to report the final honest number.
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
VAL_FRACTION = 0.2  # carved out of the remaining 0.8 -- train ends up ~60%
MODEL_DIR = os.path.join(os.path.dirname(__file__), 'artifacts')


def chronological_split(df, test_fraction=TEST_FRACTION, val_fraction=VAL_FRACTION, purge_days=PURGE_DAYS):
    # format='mixed' -- fired_at is naive ET text from Postgres (::text cast in
    # dataset.py's query), and rows genuinely have inconsistent sub-second precision
    # (some with microseconds, some without). No timezone conversion risk here (both
    # sides of every comparison below are the same naive-ET representation), just a
    # parsing-format issue caught by pandas' own strict inference refusing to guess.
    fired_dt = pd.to_datetime(df['fired_at'], format='mixed')
    df = df.assign(_fired_dt=fired_dt).sort_values('_fired_dt').reset_index(drop=True)
    n = len(df)
    test_split_idx = int(n * (1 - test_fraction))
    val_split_idx = int(n * (1 - test_fraction - val_fraction))
    test_split_date = df.iloc[test_split_idx]['_fired_dt']
    val_split_date = df.iloc[val_split_idx]['_fired_dt']
    test_purge_start = test_split_date - timedelta(days=purge_days)
    val_purge_start = val_split_date - timedelta(days=purge_days)

    train = df[df['_fired_dt'] < val_purge_start].drop(columns=['_fired_dt'])
    val = df[(df['_fired_dt'] >= val_split_date) & (df['_fired_dt'] < test_purge_start)].drop(columns=['_fired_dt'])
    test = df[df['_fired_dt'] >= test_split_date].drop(columns=['_fired_dt'])
    return train, val, test


def main():
    conn = get_connection()
    df, feature_cols = fetch_training_dataframe(conn)
    print(f"Full dataset: {len(df)} rows, {len(feature_cols)} features")
    print(f"Label rate: {df['label'].mean():.3f}")

    train, val, test = chronological_split(df)
    print(f"Train: {len(train)} rows ({train['fired_at'].min()} to {train['fired_at'].max()})")
    print(f"Val:   {len(val)} rows ({val['fired_at'].min()} to {val['fired_at'].max()})")
    print(f"Test:  {len(test)} rows ({test['fired_at'].min()} to {test['fired_at'].max()})")
    # Persisted so any later comparison (the silo dashboard) can honestly separate
    # in-sample rows (the model has already seen these, so its verdict on them is
    # artificially confident -- an overfitting-biased comparison, not a real one) from
    # genuinely out-of-sample test rows, rather than re-deriving the split boundary or
    # silently conflating the two populations. test_start_at is TEST's own start (the only
    # rows never touched during training/threshold-selection) -- val rows are in-sample for
    # threshold-selection purposes even though the model's gradient never trained on them.
    train_end_at = train['fired_at'].max()
    test_start_at = test['fired_at'].min()
    print(f"Purge gap: {PURGE_DAYS} days excluded at each split boundary")

    # Section 4.6-style minimum-dataset gate (this codebase's own "never fabricate a stat"
    # discipline, applied to model training rather than a hand-written stat) -- refuse to
    # proceed rather than silently train and report a meaningless model.
    if len(train) < 500 or len(val) < 50 or len(test) < 50:
        print(f"ABORT: insufficient data (train={len(train)}, val={len(val)}, test={len(test)}). "
              f"Need train>=500, val>=50, test>=50.")
        sys.exit(1)
    if not (0.05 <= train['label'].mean() <= 0.95):
        print(f"ABORT: train label rate {train['label'].mean():.3f} outside [0.05, 0.95] -- degenerate.")
        sys.exit(1)

    X_train, y_train = train[feature_cols], train['label']
    X_val, y_val = val[feature_cols], val['label']
    X_test, y_test = test[feature_cols], test['label']

    model = lgb.LGBMClassifier(
        n_estimators=300, max_depth=5, learning_rate=0.05,
        num_leaves=15, min_child_samples=20,
        objective='binary', random_state=42, verbose=-1,
    )
    # VAL, not TEST, drives early stopping -- TEST must stay untouched until the single
    # final report below (DeepSeek review finding #2: reusing TEST here was model-selection
    # leakage on the "out of sample" number).
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(stopping_rounds=30, verbose=False)],
    )

    # PERCENTILE thresholds, not absolute probability cutoffs -- caught before trusting the
    # result: with a 16% base rate, this model's raw output never reaches 0.5 (max observed
    # 0.43), so an absolute >=0.5/0.6/0.7 cutoff silently approves ZERO trades every time, a
    # degenerate, uninformative result. Ranking by score and taking the top N% is the correct
    # lens for an imbalanced classifier without a separately calibrated probability (this
    # model has none yet). Swept and chosen on VAL, never TEST (same leakage fix as above).
    val_proba = model.predict_proba(X_val)[:, 1]
    val_ids = tuple(val['id'].tolist())
    val_pnl_q = pd.read_sql(
        f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {val_ids}",
        conn,
    )
    val_with_pnl = val.merge(val_pnl_q, on='id')
    val_with_pnl['ml_proba'] = val_proba
    print(f"\n--- Threshold selection on VAL ({len(val_with_pnl)} rows, never seen by TEST report below) ---")
    print(f"  all {len(val_with_pnl)} val trades: P&L=${val_with_pnl['actual_pnl'].sum():.2f}, "
          f"WR={100*val_with_pnl['actual_pnl'].gt(0).mean():.1f}%")
    for pct in [50, 25, 10]:
        cutoff = np.percentile(val_proba, 100 - pct)
        approved = val_with_pnl[val_with_pnl['ml_proba'] >= cutoff]
        ml_pnl = approved['actual_pnl'].sum()
        ml_wr = 100 * approved['actual_pnl'].gt(0).mean() if len(approved) else float('nan')
        print(f"  top {pct}% by score (proba>={cutoff:.3f}): {len(approved)} trades | "
              f"P&L=${ml_pnl:.2f} | WR={ml_wr:.1f}%")

    # Chosen approval threshold, persisted (not hardcoded elsewhere) so score.py's live-
    # facing function can produce a real TAKE/VETO verdict for a SINGLE new candidate,
    # where a percentile can't be computed in isolation. top-25% kept as the standing
    # balanced choice (matches the original single-split run's own pick) -- a judgment call
    # worth revisiting once more data accumulates, not a permanent constant.
    approval_threshold = float(np.percentile(val_proba, 75))
    print(f"\nPersisted approval threshold (top-25% cutoff, from VAL): {approval_threshold:.4f}")

    # WITHIN-SESSION thresholds (2026-09-21, DeepSeek review finding 2-4) -- a single
    # GLOBAL 75th-percentile cutoff sits between the RTH and Globex score distributions
    # (RTH WR 52.8%/positive EV vs Globex WR 37.6%/negative EV, a ~15pt gap `is_rth` can
    # split on near the root), so on any day RTH runs hot every RTH trade clears the frozen
    # cutoff and every Globex trade doesn't -- the batch verdict degenerates into "is this
    # RTH" rather than genuine within-session quality ranking, and it structurally starves
    # recalibrate_ml_globex_split.mjs's own Globex TAKE population (see that script's
    # header). Deriving the cutoff SEPARATELY within each session (still from VAL, still
    # frozen at train time, same no-lookahead discipline as approval_threshold above) gives
    # each session its own ~25% TAKE rate and makes "does ML discriminate within Globex"
    # finally answerable. Used only by run_silo_scoring.py's batch path -- score_one.py's
    # fire-time path (a single row, no cohort to rank against) deliberately keeps using the
    # pooled `approval_threshold` above; this is an accepted, documented divergence, not an
    # oversight.
    val_is_rth = X_val['is_rth_int'].astype(bool)
    val_proba_rth = val_proba[val_is_rth.values]
    val_proba_globex = val_proba[~val_is_rth.values]
    approval_threshold_rth = float(np.percentile(val_proba_rth, 75)) if len(val_proba_rth) >= 20 else None
    approval_threshold_globex = float(np.percentile(val_proba_globex, 75)) if len(val_proba_globex) >= 20 else None
    print(f"Within-session thresholds -- RTH (n={len(val_proba_rth)}): "
          f"{approval_threshold_rth}, Globex (n={len(val_proba_globex)}): {approval_threshold_globex}")

    # TEST touched exactly once, here, using the threshold already frozen from VAL above --
    # this is the honest, final, "genuinely never seen until this line" number.
    test_proba = model.predict_proba(X_test)[:, 1]
    test_auc = roc_auc_score(y_test, test_proba)
    test_ids = tuple(test['id'].tolist())
    pnl_q = pd.read_sql(
        f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {test_ids}",
        conn,
    )
    test_with_pnl = test.merge(pnl_q, on='id')
    test_with_pnl['ml_proba'] = test_proba
    approved_test = test_with_pnl[test_with_pnl['ml_proba'] >= approval_threshold]
    print(f"\n--- Final TEST report ({len(test_with_pnl)} rows, touched once, this section only) ---")
    print(f"Test AUC: {test_auc:.4f}")
    all_pnl = test_with_pnl['actual_pnl'].sum()
    print(f"  all {len(test_with_pnl)} test trades: P&L=${all_pnl:.2f}, WR={100*test_with_pnl['actual_pnl'].gt(0).mean():.1f}%")
    ml_pnl = approved_test['actual_pnl'].sum()
    ml_wr = 100 * approved_test['actual_pnl'].gt(0).mean() if len(approved_test) else float('nan')
    print(f"  ML-approved (proba>={approval_threshold:.3f}, VAL-frozen threshold): "
          f"{len(approved_test)} trades | P&L=${ml_pnl:.2f} | WR={ml_wr:.1f}%")

    # Within-session TEST report -- confirms the fix actually produces a real ~25% TAKE
    # rate in EACH session, not just RTH, before trusting the new thresholds.
    test_is_rth = X_test['is_rth_int'].astype(bool).values
    for label, mask, thresh in [
        ('RTH', test_is_rth, approval_threshold_rth),
        ('Globex', ~test_is_rth, approval_threshold_globex),
    ]:
        sub = test_with_pnl[mask]
        if thresh is None or len(sub) == 0:
            print(f"  [{label}] n={len(sub)} -- threshold unavailable (too few VAL rows), skipped")
            continue
        take_rate = 100 * (sub['ml_proba'] >= thresh).mean()
        approved_sub = sub[sub['ml_proba'] >= thresh]
        sub_wr = 100 * approved_sub['actual_pnl'].gt(0).mean() if len(approved_sub) else float('nan')
        print(f"  [{label}] n={len(sub)}, threshold={thresh:.3f}, TAKE rate={take_rate:.1f}%, "
              f"TAKE n={len(approved_sub)} P&L=${approved_sub['actual_pnl'].sum():.2f} WR={sub_wr:.1f}%")

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
            approval_threshold, approval_threshold_rth, approval_threshold_globex,
            train_end_at, test_start_at, notes)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (
        model_version, len(train), len(test),
        float(train['label'].mean()), float(test['label'].mean()), float(test_auc),
        json.dumps(feature_cols),
        json.dumps({
            'top_features': top_features, 'purge_days': PURGE_DAYS,
            'val_n': len(val), 'val_positive_rate': float(val['label'].mean()),
            'split': 'three-way (train/val/test), threshold+early-stopping on VAL, TEST touched once',
            'val_n_rth': int(val_is_rth.sum()), 'val_n_globex': int((~val_is_rth).sum()),
        }),
        model_path, approval_threshold, approval_threshold_rth, approval_threshold_globex,
        train_end_at, test_start_at,
        'Retrained 2026-09-21 after DeepSeek full-review findings #1 (touch_quality_vol_z '
        'lookahead leak, dropped) and #2 (test-set reuse for early-stopping/threshold, fixed '
        'via a proper train/val/test split). Full-roster scope per user request 2026-09-21. '
        'Within-session (RTH/Globex) thresholds added same day, second DeepSeek review '
        'finding 2-4 -- see recalibrate_ml_globex_split.mjs / docs/OPEN_THREADS.md.',
    ))
    conn.commit()
    print(f"Model metadata persisted to ml_models (version={model_version})")


if __name__ == '__main__':
    main()
