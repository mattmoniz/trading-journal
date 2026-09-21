"""Batch driver: scores every real, fully-featured candidate (whole roster, per the user's
explicit request -- not just the 9 currently-ACTIVE setup_types) against the LATEST trained
model, and persists verdicts to ml_verdicts. Idempotent per model_version (UNIQUE
(active_setup_id, model_version), ON CONFLICT DO NOTHING) -- re-running never duplicates,
and re-training a new model naturally produces a full fresh set of verdicts under its own
version without touching prior models' history.

This is deliberately a periodic BATCH job (same pattern as every other calibration script
in this codebase, run_daily_calibration.sh), not a live inline call -- it's scoring
ALREADY-RESOLVED real trades, which is fundamentally retrospective, not something a live
in-the-moment decision needs. Run manually or wire into run_daily_calibration.sh once this
is verified: python3 run_silo_scoring.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe
from score import load_model, score_candidate


def get_latest_model(conn):
    cur = conn.cursor()
    cur.execute("""
        SELECT model_version, model_path, approval_threshold,
            approval_threshold_rth, approval_threshold_globex
        FROM ml_models ORDER BY trained_at DESC LIMIT 1
    """)
    row = cur.fetchone()
    if not row:
        raise RuntimeError("No trained model found in ml_models -- run train.py first.")
    return {
        'model_version': row[0], 'model_path': row[1], 'approval_threshold': float(row[2]),
        # Within-session (RTH/Globex) thresholds, 2026-09-21 (DeepSeek review finding 2-4) --
        # a single pooled cutoff sits between the two sessions' score distributions, so on a
        # hot RTH day every RTH trade clears it and every Globex trade doesn't, regardless of
        # within-session quality. Fall back to the pooled threshold for either session if a
        # model was trained before this fix (or had too few VAL rows in one session) --
        # never crash the batch job over a NULL column from an older model_version.
        'approval_threshold_rth': float(row[3]) if row[3] is not None else float(row[2]),
        'approval_threshold_globex': float(row[4]) if row[4] is not None else float(row[2]),
    }


def main():
    conn = get_connection()
    latest = get_latest_model(conn)
    print(f"Scoring against model_version={latest['model_version']} "
          f"(RTH threshold={latest['approval_threshold_rth']:.4f}, "
          f"Globex threshold={latest['approval_threshold_globex']:.4f})")

    bundle = load_model(latest['model_path'])
    df, feature_cols = fetch_training_dataframe(conn)
    print(f"Candidates (real, pooled, fully-featured, whole roster): {len(df)}")

    cur = conn.cursor()
    cur.execute(
        "SELECT active_setup_id FROM ml_verdicts WHERE model_version = %s",
        (latest['model_version'],),
    )
    already_scored = {r[0] for r in cur.fetchall()}
    to_score = df[~df['id'].isin(already_scored)]
    print(f"Already scored under this model_version: {len(already_scored)}")
    print(f"To score: {len(to_score)}")

    written = 0
    for _, row in to_score.iterrows():
        features = {col: row[col] for col in feature_cols}
        # Within-session threshold -- rank RTH trades against RTH's own cutoff, Globex
        # against Globex's own (see get_latest_model()'s comment). row['is_rth_int'] is
        # always present (a real, non-nullable generated column, per dataset.py's own
        # comment), never missing/null.
        threshold = latest['approval_threshold_rth'] if row['is_rth_int'] else latest['approval_threshold_globex']
        result = score_candidate(bundle, features, threshold)
        cur.execute("""
            INSERT INTO ml_verdicts (active_setup_id, model_version, probability, verdict)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (active_setup_id, model_version) DO NOTHING
        """, (int(row['id']), latest['model_version'], result['probability'], result['verdict']))
        written += 1

    conn.commit()
    print(f"Wrote {written} verdicts.")

    cur.execute("""
        SELECT verdict, COUNT(*) FROM ml_verdicts WHERE model_version = %s GROUP BY verdict
    """, (latest['model_version'],))
    for verdict, count in cur.fetchall():
        print(f"  {verdict}: {count}")


if __name__ == '__main__':
    main()
