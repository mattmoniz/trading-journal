"""Weekly ML silo checkpoint promotion + real-numbers before/after comparison.

Built 2026-09-29 as the direct fix for RESEARCH_CLAIM
ml_verdict_instability_from_daily_retrain_20260929: train.py retrains a genuinely new
model_version every night (scripts/run_daily_calibration.sh, a deliberate 2026-09-21
design choice), and every consumer of "the current model" picked whichever was newest --
so 26.2% of real scored trades (1,381 of 5,276) had their TAKE/VETO verdict flip purely on
which day they happened to be scored, with no real signal behind the flip (the flipping
population's own mean real PnL was -$7.88/trade -- worse than either stable group, not
informative).

Design (see migrate_add_ml_models_checkpoint_20260929.mjs's header for the schema side):
train.py keeps retraining nightly -- that history (ml_models.trained_at/test_auc) IS the
drift-tracking signal. Every live/display consumer (score_one.py, run_silo_scoring.py,
mlSiloService.js, mlFireTimeScoring.js) now reads ml_models.is_checkpoint instead of
trained_at DESC, and ONLY this script ever changes which row that is -- once a week,
via run_weekly_backtests.sh (Sunday 22:30pm ET).

This is not a blind swap. Promotion is GATED (2026-10-05): it scores real, already-resolved
trades fired at/after the candidate's own test_start_at through both the live checkpoint and
the candidate, as policies on the same trades (pnl if TAKE, else 0). It promotes only if the
candidate clears the rule in PROMOTE_* constants and the paired day-blocked CI excludes zero;
otherwise it records action='held' and leaves is_checkpoint unchanged.
Persisted to performance_audit (signal_type='ML_CHECKPOINT_PROMOTION', signal_name=
model_version being promoted TO) so it's queryable/discoverable per this codebase's
standing no-dead-ends rule, not just console output that scrolls off scratch/weekly_backtests.log.

Run: venv/bin/python3 scripts/ml_meta_labeling/promote_weekly_checkpoint.py
"""
import sys
import os
import json
from datetime import date

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import EXISTING_FEATURE_COLS, build_feature_dict, REAL_TRADE_FILTER
from score import load_model, score_candidate
import numpy as np

PROMOTE_MIN_UNSEEN_TRADES = 60
PROMOTE_MIN_DISTINCT_DAYS = 20
PROMOTE_MIN_UNSEEN_TAKE_N = 20


def get_model_row(conn, where_clause, params=()):
    cur = conn.cursor()
    cur.execute(f"""
        SELECT model_version, model_path, trained_at::text, approval_threshold,
            approval_threshold_rth, approval_threshold_globex, test_auc::float
        FROM ml_models WHERE {where_clause}
    """, params)
    row = cur.fetchone()
    if not row:
        return None
    return {
        'model_version': row[0], 'model_path': row[1], 'trained_at': row[2],
        'approval_threshold': float(row[3]),
        'approval_threshold_rth': float(row[4]) if row[4] is not None else float(row[3]),
        'approval_threshold_globex': float(row[5]) if row[5] is not None else float(row[3]),
        'test_auc': row[6],
    }


def score_row_under(bundle, threshold_rth, threshold_globex, row_dict):
    existing = {c: row_dict[c] for c in EXISTING_FEATURE_COLS}
    features = build_feature_dict(row_dict['ml_pd_features'], row_dict['ml_intraday_features'], existing)
    missing = [c for c in bundle['feature_cols'] if c not in features]
    if missing:
        return None
    threshold = threshold_rth if row_dict['is_rth_int'] else threshold_globex
    return score_candidate(bundle, features, threshold)


def main():
    conn = get_connection()

    checkpoint = get_model_row(conn, "is_checkpoint = true")
    candidate = get_model_row(conn, "model_version = (SELECT model_version FROM ml_models ORDER BY trained_at DESC LIMIT 1)")

    if checkpoint is None:
        print("No checkpoint set -- nothing to compare against. Promoting candidate directly as the first checkpoint.")
        if candidate is None:
            print("No trained models exist at all -- run train.py first.")
            sys.exit(1)
        cur = conn.cursor()
        cur.execute("UPDATE ml_models SET is_checkpoint = true WHERE model_version = %s", (candidate['model_version'],))
        conn.commit()
        print(f"Promoted {candidate['model_version']} as the first checkpoint.")
        sys.exit(0)

    if candidate['model_version'] == checkpoint['model_version']:
        print(f"No new model trained since last promotion -- checkpoint stays {checkpoint['model_version']}.")
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
            VALUES (%s, 7, 'ML_CHECKPOINT_PROMOTION', 'LATEST', 0, %s)
            ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET notes = EXCLUDED.notes
        """, (date.today(), json.dumps({
            'checkpoint_model_version': checkpoint['model_version'],
            'candidate_model_version': candidate['model_version'],
            'action': 'no_op_same_model',
        })))
        conn.commit()
        sys.exit(0)

    print(f"Current checkpoint: {checkpoint['model_version']} (trained {checkpoint['trained_at']}, test_auc={checkpoint['test_auc']})")
    print(f"Candidate (newest): {candidate['model_version']} (trained {candidate['trained_at']}, test_auc={candidate['test_auc']})")

    # Trades the candidate never saw in training or testing (fired at/after its test_start_at).
    cur = conn.cursor()
    cur.execute("SELECT test_start_at FROM ml_models WHERE model_version = %s", (candidate['model_version'],))
    cand_test_start = cur.fetchone()[0]
    if cand_test_start is None:
        print("HELD: candidate has no test_start_at, so no unseen window can be defined. Checkpoint stays live.")
        cur.execute("""
            INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
            VALUES (%s, 7, 'ML_CHECKPOINT_PROMOTION', 'LATEST', 0, %s)
            ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
                sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
        """, (date.today(), json.dumps({'candidate_model_version': candidate['model_version'],
                                        'checkpoint_model_version': checkpoint['model_version'],
                                        'action': 'held', 'reason': 'candidate_test_start_at_null'})))
        conn.commit()
        return
    cur.execute(f"""
        SELECT id, ml_pd_features, ml_intraday_features, is_rth::int AS is_rth_int,
            actual_pnl::float, fired_at, {', '.join(EXISTING_FEATURE_COLS)}
        FROM active_setups
        WHERE {REAL_TRADE_FILTER}
            AND fired_at >= %s
            AND actual_pnl IS NOT NULL
            AND ml_pd_features IS NOT NULL AND ml_intraday_features IS NOT NULL
    """, (cand_test_start,))
    cols = ['id', 'ml_pd_features', 'ml_intraday_features', 'is_rth_int', 'actual_pnl', 'fired_at'] + EXISTING_FEATURE_COLS
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    checkpoint_bundle = load_model(checkpoint['model_path'])
    candidate_bundle = load_model(candidate['model_path'])

    # Both models are compared as POLICIES on the SAME universe of unseen trades: a trade
    # contributes its real P&L if the model says TAKE, else 0. Comparing only each model's own
    # TAKE set would reward a pickier model for selectivity, not accuracy.
    agree, flip, universe = 0, [], []
    for row in rows:
        ckpt_result = score_row_under(checkpoint_bundle, checkpoint['approval_threshold_rth'], checkpoint['approval_threshold_globex'], row)
        cand_result = score_row_under(candidate_bundle, candidate['approval_threshold_rth'], candidate['approval_threshold_globex'], row)
        if ckpt_result is None or cand_result is None:
            continue
        pnl = row['actual_pnl']
        universe.append({
            'date': row['fired_at'].date(), 'pnl': pnl,
            'cand_take': cand_result['verdict'] == 'TAKE', 'ckpt_take': ckpt_result['verdict'] == 'TAKE',
        })
        if ckpt_result['verdict'] == cand_result['verdict']:
            agree += 1
        else:
            flip.append(pnl)

    n_comparable = len(universe)
    days = sorted({u['date'] for u in universe})
    cand_val = [u['pnl'] if u['cand_take'] else 0.0 for u in universe]
    ckpt_val = [u['pnl'] if u['ckpt_take'] else 0.0 for u in universe]
    cand_mean = float(np.mean(cand_val)) if universe else None
    ckpt_mean = float(np.mean(ckpt_val)) if universe else None

    rng = np.random.default_rng(0)
    diff_ci = [None, None]
    if universe:
        by_day = {}
        for u, cv, kv in zip(universe, cand_val, ckpt_val):
            by_day.setdefault(u['date'], []).append(cv - kv)
        day_keys = list(by_day)
        boots = []
        for _ in range(2000):
            pick = rng.choice(day_keys, len(day_keys))
            vals = np.concatenate([by_day[k] for k in pick])
            boots.append(vals.mean())
        diff_ci = [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))]

    def ev(lst):
        return round(sum(lst) / len(lst), 2) if lst else None

    cand_take_n = sum(1 for u in universe if u['cand_take'])
    report = {
        'checkpoint_model_version': checkpoint['model_version'],
        'candidate_model_version': candidate['model_version'],
        'checkpoint_test_auc': checkpoint['test_auc'],
        'candidate_test_auc': candidate['test_auc'],
        'unseen_window_from': str(cand_test_start),
        'n_comparable': n_comparable,
        'distinct_days': len(days),
        'candidate_take_n': cand_take_n,
        'candidate_policy_mean': round(cand_mean, 2) if cand_mean is not None else None,
        'checkpoint_policy_mean': round(ckpt_mean, 2) if ckpt_mean is not None else None,
        'paired_diff_day_blocked_ci': [round(x, 2) if x is not None else None for x in diff_ci],
        'agreement_rate': round(agree / n_comparable, 3) if n_comparable else None,
        'flip_n': len(flip), 'flip_ev': ev(flip),
        'promotion_rule': (f'promote only if unseen comparable trades >= {PROMOTE_MIN_UNSEEN_TRADES}, '
                           f'distinct days >= {PROMOTE_MIN_DISTINCT_DAYS}, candidate TAKE count >= {PROMOTE_MIN_UNSEEN_TAKE_N}, '
                           f'candidate policy mean > 0 and > checkpoint policy mean, and the day-blocked CI on the '
                           f'paired difference excludes zero; all on trades fired at/after candidate test_start_at'),
    }
    gate_pass = (n_comparable >= PROMOTE_MIN_UNSEEN_TRADES
                 and len(days) >= PROMOTE_MIN_DISTINCT_DAYS
                 and cand_take_n >= PROMOTE_MIN_UNSEEN_TAKE_N
                 and cand_mean is not None and cand_mean > 0
                 and cand_mean > ckpt_mean
                 and diff_ci[0] is not None and diff_ci[0] > 0)
    print(json.dumps(report, indent=2))
    if not gate_pass:
        print(f"HELD: candidate {candidate['model_version']} did not clear the promotion gate on unseen trades. "
              f"Checkpoint {checkpoint['model_version']} stays live.")
        cur.execute("""
            INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
            VALUES (%s, 7, 'ML_CHECKPOINT_PROMOTION', 'LATEST', %s, %s)
            ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
                sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
        """, (date.today(), n_comparable, json.dumps({**report, 'action': 'held'})))
        conn.commit()
        return

    cur.execute("UPDATE ml_models SET is_checkpoint = false WHERE is_checkpoint = true")
    cur.execute("UPDATE ml_models SET is_checkpoint = true WHERE model_version = %s", (candidate['model_version'],))
    cur.execute("""
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
        VALUES (%s, 7, 'ML_CHECKPOINT_PROMOTION', 'LATEST', %s, %s)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
            sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
    """, (date.today(), n_comparable, json.dumps({**report, 'action': 'promoted'})))
    conn.commit()
    print(f"Promoted {candidate['model_version']} as the new checkpoint.")


if __name__ == '__main__':
    main()
