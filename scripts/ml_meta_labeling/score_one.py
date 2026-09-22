"""Fire-time scoring for ONE real trade -- the piece that makes the ML silo something
closer to real-time instead of a once-daily batch report (2026-09-21, user: "why isnt ml
tagging every trade thats gets fired? Isnt that the point? To study it and make decisions?").

The key distinction this script exists to act on: the LABEL (does this eventually swing
big) fundamentally cannot exist until real future time has passed -- no system can know
that instantly, and this script does not try. But the SCORE (TAKE/VETO against the
already-trained model) only needs the trade's FEATURES, which are lookahead-safe and
knowable the instant the trade fires. There was never a technical reason scoring had to
wait for the nightly batch -- only that nothing invoked it more often. This script is that
missing invocation, one real trade at a time.

Deliberately the SAME score_candidate()/build_feature_dict() this whole thread has used
since day one (score.py, dataset.py) -- no new scoring logic, just a new, more frequent
caller. Read-only against ml_pd_features/ml_intraday_features (does not compute them --
score_new_fires.mjs computes those immediately at fire time, this script only runs once
they already exist), writes exactly one row to ml_verdicts, idempotent via the same
ON CONFLICT (active_setup_id, model_version) DO NOTHING as run_silo_scoring.py.

Run: venv/bin/python3 score_one.py <active_setup_id>
Prints one JSON line to stdout: {"scored": true, "probability":..., "verdict":...} or
{"scored": false, "reason": "..."} -- score_new_fires.mjs reads this to log/confirm.
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import EXISTING_FEATURE_COLS, build_feature_dict
from score import load_model, score_candidate


def main():
    if len(sys.argv) != 2:
        print(json.dumps({'scored': False, 'reason': 'usage: score_one.py <active_setup_id>'}))
        sys.exit(1)
    active_setup_id = int(sys.argv[1])

    conn = get_connection()
    cur = conn.cursor()

    # is_rth_int REVERTED as a training feature 2026-09-22 (matches dataset.py's own
    # EXISTING_FEATURE_COLS comment) -- selected here only as METADATA now, for the
    # within-session threshold selection below, never passed into `features`/model input.
    cur.execute(f"""
        SELECT ml_pd_features, ml_intraday_features, is_rth::int AS is_rth_int, {', '.join(EXISTING_FEATURE_COLS)}
        FROM active_setups WHERE id = %s
    """, (active_setup_id,))
    row = cur.fetchone()
    if not row:
        print(json.dumps({'scored': False, 'reason': f'active_setup_id {active_setup_id} not found'}))
        sys.exit(0)

    col_names = ['ml_pd_features', 'ml_intraday_features', 'is_rth_int'] + EXISTING_FEATURE_COLS
    row_dict = dict(zip(col_names, row))
    if row_dict['ml_pd_features'] is None or row_dict['ml_intraday_features'] is None:
        print(json.dumps({'scored': False, 'reason': 'features not computed yet'}))
        sys.exit(0)

    existing = {c: row_dict[c] for c in EXISTING_FEATURE_COLS}
    features = build_feature_dict(row_dict['ml_pd_features'], row_dict['ml_intraday_features'], existing)

    cur.execute("""
        SELECT model_version, model_path, approval_threshold, approval_threshold_rth, approval_threshold_globex
        FROM ml_models ORDER BY trained_at DESC LIMIT 1
    """)
    model_row = cur.fetchone()
    if not model_row:
        print(json.dumps({'scored': False, 'reason': 'no trained model yet'}))
        sys.exit(0)
    model_version, model_path, approval_threshold, approval_threshold_rth, approval_threshold_globex = model_row

    bundle = load_model(model_path)
    # Guard against a feature-set drift between when this model was trained and now (e.g. a
    # new EXISTING_FEATURE_COLS entry added but this model predates it) -- score_candidate()
    # already raises on a missing key, this just gives a clearer reason than a raw traceback.
    missing = [c for c in bundle['feature_cols'] if c not in features]
    if missing:
        print(json.dumps({'scored': False, 'reason': f'feature set mismatch vs {model_version}: missing {missing}'}))
        sys.exit(0)

    # Within-session threshold, matching run_silo_scoring.py's own logic exactly (FIXED
    # 2026-09-22 -- this script previously used the pooled threshold unconditionally, a real
    # gap: fire-time TAKE/VETO tags were being judged against a threshold that sits between
    # RTH's and Globex's own score distributions, the exact "score distribution shifts as a
    # whole on a trending day" issue item 3's own finding describes). Falls back to the pooled
    # threshold for an older model trained before this fix (NULL column), never crashes.
    session_threshold = (
        float(approval_threshold_rth) if row_dict['is_rth_int'] and approval_threshold_rth is not None
        else float(approval_threshold_globex) if not row_dict['is_rth_int'] and approval_threshold_globex is not None
        else float(approval_threshold)
    )
    result = score_candidate(bundle, features, session_threshold)

    cur.execute("""
        INSERT INTO ml_verdicts (active_setup_id, model_version, probability, verdict)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (active_setup_id, model_version) DO NOTHING
    """, (active_setup_id, model_version, result['probability'], result['verdict']))
    conn.commit()

    print(json.dumps({'scored': True, 'active_setup_id': active_setup_id, 'model_version': model_version, **result}))


if __name__ == '__main__':
    main()
