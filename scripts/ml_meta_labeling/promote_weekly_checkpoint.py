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

This is not a blind swap. Before promoting, it scores every real trade that fired since
the CURRENT checkpoint was promoted through BOTH the current checkpoint and the candidate
(newest-trained) model, and reports the real EV difference -- the actual "did retraining
this week help or hurt" number, computed on real, already-resolved outcomes, not a
backtest re-simulation. Promotion happens regardless of the sign (this is a stability fix,
not a gate -- a week is too short a sample to condition promotion on; see the printed
report's own honesty about N). The report is what a weekly review reads, not a blocker.
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

    # Real trades that fired since the CURRENT checkpoint was set -- these are the only
    # trades whose real, already-known outcome can honestly judge "did this week's
    # retraining help," since anything older was already live-scored under the checkpoint
    # (or an even earlier one) and re-litigating it would just be in-sample hindsight.
    cur = conn.cursor()
    cur.execute(f"""
        SELECT id, ml_pd_features, ml_intraday_features, is_rth::int AS is_rth_int,
            actual_pnl::float, {', '.join(EXISTING_FEATURE_COLS)}
        FROM active_setups
        WHERE {REAL_TRADE_FILTER}
            AND fired_at >= %s
            AND actual_pnl IS NOT NULL
            AND ml_pd_features IS NOT NULL AND ml_intraday_features IS NOT NULL
    """, (checkpoint['trained_at'],))
    cols = ['id', 'ml_pd_features', 'ml_intraday_features', 'is_rth_int', 'actual_pnl'] + EXISTING_FEATURE_COLS
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    checkpoint_bundle = load_model(checkpoint['model_path'])
    candidate_bundle = load_model(candidate['model_path'])

    ckpt_take, ckpt_veto, cand_take, cand_veto, agree, flip = [], [], [], [], 0, []
    for row in rows:
        ckpt_result = score_row_under(checkpoint_bundle, checkpoint['approval_threshold_rth'], checkpoint['approval_threshold_globex'], row)
        cand_result = score_row_under(candidate_bundle, candidate['approval_threshold_rth'], candidate['approval_threshold_globex'], row)
        if ckpt_result is None or cand_result is None:
            continue
        (ckpt_take if ckpt_result['verdict'] == 'TAKE' else ckpt_veto).append(row['actual_pnl'])
        (cand_take if cand_result['verdict'] == 'TAKE' else cand_veto).append(row['actual_pnl'])
        if ckpt_result['verdict'] == cand_result['verdict']:
            agree += 1
        else:
            flip.append(row['actual_pnl'])

    n = len(rows)
    n_comparable = len(ckpt_take) + len(ckpt_veto)

    def ev(lst):
        return round(sum(lst) / len(lst), 2) if lst else None

    report = {
        'checkpoint_model_version': checkpoint['model_version'],
        'candidate_model_version': candidate['model_version'],
        'checkpoint_test_auc': checkpoint['test_auc'],
        'candidate_test_auc': candidate['test_auc'],
        'real_trades_since_checkpoint': n,
        'n_comparable': n_comparable,
        'checkpoint_take_n': len(ckpt_take), 'checkpoint_take_ev': ev(ckpt_take),
        'checkpoint_veto_n': len(ckpt_veto), 'checkpoint_veto_ev': ev(ckpt_veto),
        'candidate_take_n': len(cand_take), 'candidate_take_ev': ev(cand_take),
        'candidate_veto_n': len(cand_veto), 'candidate_veto_ev': ev(cand_veto),
        'agreement_rate': round(agree / n_comparable, 3) if n_comparable else None,
        'flip_n': len(flip), 'flip_ev': ev(flip),
    }

    print(json.dumps(report, indent=2))
    if n_comparable < 20:
        print(f"NOTE: only {n_comparable} comparable real trades since last promotion -- this "
              f"comparison is too thin to draw a real conclusion from (this codebase's own "
              f"N>=20 floor). Promoting anyway per design (weekly cadence is not gated on a "
              f"single week's thin sample), but do not treat this week's numbers as decisive.")

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
