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
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe, compute_sample_weights
from hyperparams import load_hyperparams

PURGE_DAYS = 3
FOLD_DAYS = 7
MIN_TRAIN_N = 500
APPROVAL_PERCENTILE = 75  # matches train.py's single-split choice, for comparability
MIN_SPLIT_N = 20  # matches train.py's own within-session floor for approval_threshold_rth/globex
# Minimum SAME-DAY-SESSION candidates seen so far before an online rank is trusted -- below
# this, a candidate's rank is essentially "1st/2nd of the day," meaningless, not a real
# ranking. Same discipline as run_silo_scoring.py's own MIN_COHORT_N, deliberately smaller
# here (3 vs 5) because this is an EXPANDING, causal count (rows seen SO FAR that day, not
# the day's eventual full total) -- a stricter floor would starve most candidates of ever
# getting a real rank at all, since the day's first several candidates always start at zero.
MIN_ONLINE_COHORT = 3
ONLINE_RANK_TOP_QUARTILE = 0.75  # matches mlSiloService.js's DAY_RANK_TOP_QUARTILE


def compute_online_rank(fold_df):
    """Causal, expanding within-(trade_date, is_rth_int) percentile rank -- the ONLY
    ranking definition a genuinely live system could ever compute, since it only ranks
    each candidate against candidates from the SAME day and session that fired strictly
    EARLIER (never later ones, which is what a naive full-fold or full-day rank would
    leak). This simulates "what would a live within-day-relative-ranking selection rule
    have actually done" -- distinct from run_silo_scoring.py's compute_day_rank_pct(),
    which is retrospective/full-day and deliberately NOT used here, since a walk-forward
    validation must faithfully simulate what would have happened live, not a hindsight
    view (item 3's own Q2 answer: the batch full-day rank and the live expanding rank are
    two different, both-legitimate questions -- this function answers the live one).

    Returns fold_df with two new columns added: `online_rank_pct` (float in [0,1], NaN
    below MIN_ONLINE_COHORT) and `online_cohort_so_far` (int, candidates seen before this
    one in the same day+session, always populated).
    """
    fold_df = fold_df.sort_values('_fired_dt').reset_index(drop=True)
    online_rank_pct = np.full(len(fold_df), np.nan)
    online_cohort_so_far = np.zeros(len(fold_df), dtype=int)

    for (_trade_date, _is_rth), group in fold_df.groupby(['trade_date', 'is_rth_int']):
        seen_proba = []
        for idx in group.index:  # group.index preserves the _fired_dt-sorted order from above
            cohort_n = len(seen_proba)
            online_cohort_so_far[idx] = cohort_n
            if cohort_n >= MIN_ONLINE_COHORT:
                this_proba = fold_df.at[idx, 'probability']
                # Fraction of already-seen candidates this one beats -- a genuine
                # percentile rank among strictly-prior same-day-session candidates only.
                online_rank_pct[idx] = float(np.mean(np.array(seen_proba) < this_proba))
            seen_proba.append(fold_df.at[idx, 'probability'])

    fold_df['online_rank_pct'] = online_rank_pct
    fold_df['online_cohort_so_far'] = online_cohort_so_far
    return fold_df


def run_walkforward_folds(df, feature_cols, hp):
    """The real fold loop, extracted 2026-09-22 (item 5, hyperparameter sweep) so
    scripts/sweep_ml_hyperparams.py can call the SAME real walk-forward logic once per
    candidate hyperparameter set, per this codebase's "export the real function, never
    reimplement" rule -- a sweep script hand-rolling a second copy of this loop is exactly
    the duplication risk that rule exists to prevent (a fix/safety-net landing in one copy
    and not the other). `df` must already have `_fired_dt`/`actual_pnl` merged in (see
    main()'s own setup below) -- this function does no DB I/O itself, matching score.py's
    "no DB access in the reusable core" convention.

    Returns (fold_results: list[DataFrame], fold_summaries: list[dict], skipped_thin_train: int).
    """
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
            **hp,
            objective='binary', random_state=42, verbose=-1,
        )
        # Sample weights (2026-09-22, matches train.py's own fix, OPEN_DECISION
        # ml_silo_deepseek_followup_review_parked_20260921) -- recomputed fresh per fold against
        # THIS fold's own train subset, not a whole-dataset count, so it stays correct as the
        # expanding window grows.
        train_weight = compute_sample_weights(train)
        model.fit(train[feature_cols], train['label'], sample_weight=train_weight)

        # Threshold from the TRAINING set's own scores -- never the fold being scored.
        # Within-session split (RTH vs Globex), matching train.py's/run_silo_scoring.py's
        # already-shipped 2026-09-21/22 fix -- FIXED HERE 2026-09-22 (item 3 of the ML
        # silo review, DeepSeek Q1: this script's threshold mechanism had NOT been updated
        # when that fix landed elsewhere, so its own verdict was silently stale relative to
        # what's actually live -- a single pooled threshold sits between the RTH and Globex
        # score distributions, reproducing the exact same cross-session contamination the
        # live fix already closed). Falls back to the pooled threshold for a session with
        # too few training rows this fold (MIN_SPLIT_N), same guard train.py uses.
        train_proba = model.predict_proba(train[feature_cols])[:, 1]
        pooled_threshold = float(np.percentile(train_proba, APPROVAL_PERCENTILE))
        train_rth_proba = train_proba[train['is_rth_int'].values.astype(bool)]
        train_globex_proba = train_proba[~train['is_rth_int'].values.astype(bool)]
        threshold_rth = float(np.percentile(train_rth_proba, APPROVAL_PERCENTILE)) if len(train_rth_proba) >= MIN_SPLIT_N else pooled_threshold
        threshold_globex = float(np.percentile(train_globex_proba, APPROVAL_PERCENTILE)) if len(train_globex_proba) >= MIN_SPLIT_N else pooled_threshold

        # Fold-averaged AUC (2026-09-22, item 3 Q1) -- threshold-FREE, so it answers "does
        # the raw score have any signal" independent of whichever selection mechanism
        # (fixed threshold vs. online rank) is used to pick TAKE/VETO. Guards against a
        # degenerate fold (a single class in the fold's own label) where AUC is undefined.
        fold_auc = None
        if fold['label'].nunique() > 1:
            fold_auc = float(roc_auc_score(fold['label'], model.predict_proba(fold[feature_cols])[:, 1]))

        fold_proba = model.predict_proba(fold[feature_cols])[:, 1]
        fold_out = fold[['id', 'setup_type', 'fired_at', 'trade_date', 'is_rth_int', 'cluster_touch_id', 'actual_pnl', '_fired_dt']].copy()
        fold_out['probability'] = fold_proba
        session_threshold = np.where(fold_out['is_rth_int'].values.astype(bool), threshold_rth, threshold_globex)
        fold_out['verdict'] = np.where(fold_proba >= session_threshold, 'TAKE', 'VETO')
        fold_out['fold_start'] = fold_start.strftime('%Y-%m-%d')

        # Online rank verdict -- the mechanism item 3 actually validates the value of
        # (see compute_online_rank()'s own header). Kept as a SEPARATE column alongside
        # the threshold-based `verdict`, never overwriting it, so this script can report
        # both mechanisms' P&L side by side for a direct comparison.
        fold_out = compute_online_rank(fold_out)
        fold_out['online_rank_verdict'] = np.where(
            fold_out['online_rank_pct'] >= ONLINE_RANK_TOP_QUARTILE, 'TAKE', 'VETO'
        )
        fold_results.append(fold_out)

        take = fold_out[fold_out['verdict'] == 'TAKE']
        online_take = fold_out[fold_out['online_rank_verdict'] == 'TAKE']
        fold_summaries.append({
            'fold_start': fold_start.strftime('%Y-%m-%d'), 'fold_end': fold_end.strftime('%Y-%m-%d'),
            'train_n': len(train), 'fold_n': len(fold),
            'threshold_rth': round(threshold_rth, 4), 'threshold_globex': round(threshold_globex, 4),
            'fold_auc': round(fold_auc, 4) if fold_auc is not None else None,
            'all_pnl': round(float(fold_out['actual_pnl'].sum()), 2),
            'take_n': len(take), 'take_pnl': round(float(take['actual_pnl'].sum()), 2),
            'online_take_n': len(online_take), 'online_take_pnl': round(float(online_take['actual_pnl'].sum()), 2),
        })
        fold_start = fold_end

    return fold_results, fold_summaries, skipped_thin_train


def main():
    conn = get_connection()
    hp = load_hyperparams(conn)  # loaded once, not per-fold -- same value used across every fold
    print(f"Hyperparameters (from ML_HYPERPARAMS if calibrated, else DEFAULT_HYPERPARAMS): {hp}")
    df, feature_cols = fetch_training_dataframe(conn)
    fired_dt = pd.to_datetime(df['fired_at'], format='mixed')
    df = df.assign(_fired_dt=fired_dt).sort_values('_fired_dt').reset_index(drop=True)
    print(f"Full dataset: {len(df)} rows, spanning {df['_fired_dt'].min()} to {df['_fired_dt'].max()}")

    # Pull real actual_pnl for every candidate row up front (dataset.py's own frame doesn't
    # carry it, kept lean on purpose) -- one query, not one per fold.
    ids = tuple(df['id'].tolist())
    pnl_q = pd.read_sql(f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {ids}", conn)
    df = df.merge(pnl_q, on='id')

    fold_results, fold_summaries, skipped_thin_train = run_walkforward_folds(df, feature_cols, hp)

    if not fold_results:
        print("No folds had enough training data -- cannot walk forward yet.")
        sys.exit(1)

    all_folds = pd.concat(fold_results, ignore_index=True)
    print(f"\n{len(fold_summaries)} folds scored, {skipped_thin_train} rows skipped (insufficient training data yet)")
    print(f"\n{'Fold':<12}{'TrainN':>8}{'FoldN':>7}{'AUC':>7}{'TakeN':>7}{'TakePnL':>10}{'OnlN':>6}{'OnlPnL':>10}")
    for f in fold_summaries:
        auc_str = f"{f['fold_auc']:.3f}" if f['fold_auc'] is not None else '  n/a'
        print(f"{f['fold_start']:<12}{f['train_n']:>8}{f['fold_n']:>7}{auc_str:>7}"
              f"{f['take_n']:>7}{f['take_pnl']:>10.2f}{f['online_take_n']:>6}{f['online_take_pnl']:>10.2f}")

    total_all_pnl = all_folds['actual_pnl'].sum()
    take_rows = all_folds[all_folds['verdict'] == 'TAKE']
    total_take_pnl = take_rows['actual_pnl'].sum()
    online_take_rows = all_folds[all_folds['online_rank_verdict'] == 'TAKE']
    total_online_take_pnl = online_take_rows['actual_pnl'].sum()
    total_n = len(all_folds)
    take_n = len(take_rows)
    online_take_n = len(online_take_rows)

    # Fold-averaged AUC (2026-09-22, item 3 Q1) -- the PERMANENT threshold-free "does the
    # raw score have signal at all" gate this script now always reports, decoupled from
    # whichever selection mechanism (fixed threshold vs. online rank) is being compared
    # below. A future session should never have to re-derive whether the score itself has
    # signal separately from whether a given cutoff mechanism is contaminated -- this
    # number answers the first question every single run, permanently.
    fold_aucs = [f['fold_auc'] for f in fold_summaries if f['fold_auc'] is not None]
    avg_auc = sum(fold_aucs) / len(fold_aucs) if fold_aucs else None

    print(f"\n=== WALK-FORWARD TOTALS ({total_n} trades across {len(fold_summaries)} folds) ===")
    print(f"Fold-averaged AUC (threshold-free signal check): {avg_auc:.4f}" if avg_auc is not None else "Fold-averaged AUC: n/a (no fold had both classes)")
    print(f"All trades:            N={total_n}, P&L=${total_all_pnl:.2f}, WR={100*all_folds['actual_pnl'].gt(0).mean():.1f}%")
    print(f"ML-approved (thresh):  N={take_n}, P&L=${total_take_pnl:.2f}, WR={100*take_rows['actual_pnl'].gt(0).mean():.1f}% "
          f"-- verdict, the LIVE mechanism (probability >= frozen within-session threshold)")
    print(f"ML-approved (online):  N={online_take_n}, P&L=${total_online_take_pnl:.2f}, WR={100*online_take_rows['actual_pnl'].gt(0).mean():.1f}% "
          f"-- online_rank_verdict, the item-3 candidate (top {100*(1-ONLINE_RANK_TOP_QUARTILE):.0f}% within same-day-session, causal)")
    print("\nBoth mechanisms are reported for direct comparison -- this script does NOT decide which one is")
    print("\"official.\" recalibrate_ml_walkforward.mjs still validates `verdict` (the live mechanism) until")
    print("item 6's own clean revalidation explicitly decides whether online_rank_verdict should replace it.")

    out_path = os.path.join(os.path.dirname(__file__), '..', '..', 'scratch', 'walkforward_results.json')
    all_folds.to_json(out_path, orient='records', date_format='iso')
    print(f"\nPer-trade results written to {out_path} for independent rigor verification (computeRigor()).")


if __name__ == '__main__':
    main()
