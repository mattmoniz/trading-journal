"""Hyperparameter sweep for the ML meta-labeling model (item 5 of the 2026-09-21 DeepSeek
ML silo review, OPEN_DECISION ml_silo_deepseek_followup_review_parked_20260921). The
original hyperparameters (n_estimators=300, max_depth=5, learning_rate=0.05, num_leaves=15,
min_child_samples=20) were hardcoded once, duplicated 3x, and never swept -- this runs a
small, deliberately non-exhaustive candidate list (matching this codebase's own convention,
e.g. calibrate_step_trail_fraction.mjs's CANDIDATE_FRACS, not a full grid search) through
the SAME real walk-forward logic (walkforward.py's run_walkforward_folds(), imported not
reimplemented) and judges each candidate the SAME way item 6's revalidation will: the live
selection mechanism's (`verdict`, threshold-based -- NOT online_rank_verdict, which item 3
already confirmed negative and closed) real P&L on real out-of-sample folds, never raw
training accuracy/AUC (which would just reward overfitting to this specific population).

'current' (DEFAULT_HYPERPARAMS) is always included as one of the candidates, scored by the
exact same method as every other candidate in the same pass -- per this codebase's own
standing rule that a baseline must be computed the same way as the candidates being
compared against it, not read from a stale/differently-derived number.

Writes per-trade, per-candidate results to scratch/ml_hyperparams_sweep_results.json (same
convention as walkforward.py's own scratch/walkforward_results.json) for
scripts/recalibrate_ml_hyperparams_sweep.mjs to compute real day-blocked bootstrap CIs and
decide a winner -- CI/rigor math stays in JS (server/services/rigorDiagnostics.js), never
hand-rolled a second time in Python, matching walkforward.py's own established split.

Run manually: venv/bin/python3 scripts/sweep_ml_hyperparams.py
"""
import sys
import os
import json
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'ml_meta_labeling'))
from db import get_connection
from dataset import fetch_training_dataframe
from hyperparams import DEFAULT_HYPERPARAMS
from walkforward import run_walkforward_folds

# Small, deliberately non-exhaustive candidate list -- varying the parameters most likely
# to matter for a model this size (~2,500-3,900 rows per fold's training set): tree depth/
# leaf count (model capacity) and learning_rate/n_estimators (how aggressively it fits).
# min_child_samples held fixed at 20 across all candidates (already a real, considered
# regularization floor, not swept blind). 'current' is DEFAULT_HYPERPARAMS verbatim -- the
# live baseline, scored by this exact same method, not assumed to already be correct.
CANDIDATES = [
    {'name': 'current', **DEFAULT_HYPERPARAMS},
    {'name': 'shallower_fewer_leaves', 'n_estimators': 300, 'max_depth': 3, 'learning_rate': 0.05, 'num_leaves': 8, 'min_child_samples': 20},
    {'name': 'more_regularized', 'n_estimators': 300, 'max_depth': 4, 'learning_rate': 0.05, 'num_leaves': 10, 'min_child_samples': 30},
    {'name': 'slower_more_trees', 'n_estimators': 600, 'max_depth': 5, 'learning_rate': 0.03, 'num_leaves': 15, 'min_child_samples': 20},
    {'name': 'faster_fewer_trees', 'n_estimators': 150, 'max_depth': 5, 'learning_rate': 0.08, 'num_leaves': 15, 'min_child_samples': 20},
]


def main():
    conn = get_connection()
    df, feature_cols = fetch_training_dataframe(conn)
    fired_dt = pd.to_datetime(df['fired_at'], format='mixed')
    df = df.assign(_fired_dt=fired_dt).sort_values('_fired_dt').reset_index(drop=True)
    print(f"Full dataset: {len(df)} rows, spanning {df['_fired_dt'].min()} to {df['_fired_dt'].max()}")

    ids = tuple(df['id'].tolist())
    pnl_q = pd.read_sql(f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {ids}", conn)
    df = df.merge(pnl_q, on='id')

    all_candidate_rows = []
    summary_rows = []
    for cand in CANDIDATES:
        name = cand['name']
        hp = {k: v for k, v in cand.items() if k != 'name'}
        print(f"\n{'='*60}\nCandidate: {name}  {hp}\n{'='*60}")
        fold_results, fold_summaries, skipped = run_walkforward_folds(df, feature_cols, hp)
        if not fold_results:
            print(f"  SKIPPED -- no folds had enough training data.")
            continue
        all_folds = pd.concat(fold_results, ignore_index=True)
        all_folds['candidate'] = name
        all_candidate_rows.append(all_folds)

        take = all_folds[all_folds['verdict'] == 'TAKE']
        aucs = [f['fold_auc'] for f in fold_summaries if f['fold_auc'] is not None]
        avg_auc = sum(aucs) / len(aucs) if aucs else None
        print(f"  Folds={len(fold_summaries)}  TAKE N={len(take)}  TAKE P&L=${take['actual_pnl'].sum():.2f}  "
              f"WR={100*(take['actual_pnl']>0).mean():.1f}%  fold-avg AUC={avg_auc:.4f}" if avg_auc is not None else "  (no AUC)")
        summary_rows.append({
            'candidate': name, 'hyperparams': hp,
            'folds': len(fold_summaries), 'take_n': len(take),
            'take_pnl': round(float(take['actual_pnl'].sum()), 2),
            'take_wr': round(100 * (take['actual_pnl'] > 0).mean(), 1) if len(take) else None,
            'avg_auc': round(avg_auc, 4) if avg_auc is not None else None,
        })

    if not all_candidate_rows:
        print("No candidate produced any folds -- nothing to compare.")
        sys.exit(1)

    combined = pd.concat(all_candidate_rows, ignore_index=True)
    out_path = os.path.join(os.path.dirname(__file__), '..', 'scratch', 'ml_hyperparams_sweep_results.json')
    combined.to_json(out_path, orient='records', date_format='iso')
    print(f"\nPer-trade, per-candidate results written to {out_path}")

    summary_path = os.path.join(os.path.dirname(__file__), '..', 'scratch', 'ml_hyperparams_sweep_summary.json')
    with open(summary_path, 'w') as f:
        json.dump(summary_rows, f, indent=2)
    print(f"Summary written to {summary_path}")

    print(f"\n{'Candidate':<24}{'FoldsN':>8}{'TakeN':>8}{'TakePnL':>12}{'WR':>7}{'AUC':>7}")
    for s in summary_rows:
        print(f"{s['candidate']:<24}{s['folds']:>8}{s['take_n']:>8}{s['take_pnl']:>12.2f}"
              f"{s['take_wr']:>6.1f}%{s['avg_auc']:>7.3f}" if s['take_wr'] is not None else f"{s['candidate']:<24} (no takes)")


if __name__ == '__main__':
    main()
