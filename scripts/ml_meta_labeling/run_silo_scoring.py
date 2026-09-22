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
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe
from score import load_model, score_candidate

# Within-(day x session) relative-ranking diagnostic, added 2026-09-22 (item 3 of the
# 2026-09-21 DeepSeek ML silo review -- OPEN_DECISION
# ml_silo_deepseek_followup_review_parked_20260921, resolved via a focused DeepSeek
# design-critique follow-up dispatched the same day). This is a RETROSPECTIVE, BATCH-ONLY
# diagnostic answering "on this day, in this session (RTH/Globex), did this candidate
# rank above its peers" -- deliberately does NOT redefine or replace `verdict`
# (TAKE/VETO), which stays exactly what it already is: probability >= the frozen,
# within-session threshold, unchanged, in both this batch path AND score_one.py's
# fire-time path. The whole point of keeping these as two separate, separately-named
# fields (never letting one silently overwrite the other) is that they answer two
# genuinely different questions: `verdict` is "does this clear an absolute bar," while
# `day_rank_pct` is "how does this compare to its own day's peers" -- the second
# question is the fix for the review's original finding (a strongly-trending day pushes
# every candidate's score up together, so 11/11 TAKE reflected the day, not per-candidate
# quality; ranking against SAME-DAY peers cancels that shift out by construction, no
# classifier needed).
#
# Ranked within (trade_date, is_rth) specifically, NOT within trade_date alone -- RTH and
# Globex score distributions sit apart for the same reason the within-session approval
# thresholds exist (dataset.py/get_latest_model()'s own comment) -- mixing them into one
# day-rank would recreate the exact cross-session contamination the 2026-09-21 threshold
# fix already closed.
#
# MIN_COHORT_N: below this many candidates in a (day, session) cohort, a percentile rank
# is close to meaningless ("rank 1 of 2" tells you almost nothing) -- emit NULL rather
# than a misleadingly precise-looking number, same discipline as this codebase's other
# thin-population floors (ML_CLAIM_DISTINCT_DATES_FLOOR, the N>=20 SUPPRESS_MIN_N floor,
# `take.length < 5` skip in recalibrate_ml_walkforward.mjs). day_cohort_n itself is
# always populated even below the floor -- it's a real, always-computable count and is
# informative on its own ("this day only had 3 real candidates"), only the RANK becomes
# unreliable at low N, not the count.
MIN_COHORT_N = 5


def compute_day_rank_pct(conn, model_version):
    """Recomputes day_rank_pct/day_cohort_n for EVERY verdict under model_version (not
    just newly-scored rows this run) -- a rank is a property of the WHOLE day's cohort
    under this model, so re-deriving it fresh each run (rather than only for new rows)
    keeps every row's rank correct even as later same-day candidates get scored in a
    subsequent run. Idempotent and cheap relative to the scoring pass itself (no model
    inference, just a rank over already-scored probabilities)."""
    cur = conn.cursor()
    cur.execute("""
        SELECT v.id AS verdict_id, v.probability::float, a.trade_date::text AS trade_date,
            a.is_rth::int AS is_rth_int
        FROM ml_verdicts v
        JOIN active_setups a ON a.id = v.active_setup_id
        WHERE v.model_version = %s
    """, (model_version,))
    rows = cur.fetchall()
    if not rows:
        print("No verdicts to rank yet.")
        return

    df = pd.DataFrame(rows, columns=['verdict_id', 'probability', 'trade_date', 'is_rth_int'])
    df['day_cohort_n'] = df.groupby(['trade_date', 'is_rth_int'])['verdict_id'].transform('count')
    df['day_rank_pct'] = df.groupby(['trade_date', 'is_rth_int'])['probability'].rank(pct=True)
    # Below the floor, the rank itself is unreliable -- null it, but keep the real count.
    df.loc[df['day_cohort_n'] < MIN_COHORT_N, 'day_rank_pct'] = None

    for _, row in df.iterrows():
        cur.execute(
            "UPDATE ml_verdicts SET day_rank_pct = %s, day_cohort_n = %s WHERE id = %s",
            (
                float(row['day_rank_pct']) if pd.notna(row['day_rank_pct']) else None,
                int(row['day_cohort_n']),
                int(row['verdict_id']),
            ),
        )
    conn.commit()
    below_floor = int((df['day_cohort_n'] < MIN_COHORT_N).sum())
    print(f"Ranked {len(df)} verdicts within (trade_date, is_rth) cohorts "
          f"({below_floor} below MIN_COHORT_N={MIN_COHORT_N}, day_rank_pct left NULL for those).")


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

    compute_day_rank_pct(conn, latest['model_version'])


if __name__ == '__main__':
    main()
