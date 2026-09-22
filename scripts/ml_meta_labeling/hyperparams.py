"""Shared LightGBM hyperparameters for the meta-labeling model -- single source of truth,
replacing 3 identical hardcoded copies in train.py/walkforward.py/compare_extended_targets.py
(item 5 of the 2026-09-21 DeepSeek ML silo review, OPEN_DECISION
ml_silo_deepseek_followup_review_parked_20260921).

Reads the latest calibrated value from performance_audit (signal_type='ML_HYPERPARAMS'),
same convention as scripts/calibrate_step_trail_fraction.mjs's STEP_TRAIL_FRACTION --
per this codebase's no-static-thresholds hard rule, a value chosen once and never
rechecked is a standing audit target, not a fact. Falls back to DEFAULT_HYPERPARAMS
(the original hardcoded values, unchanged) if no sweep has ever run yet, so every one
of the 3 consumers works identically to before this file existed until
scripts/sweep_ml_hyperparams.py actually runs and picks a winner.
"""
import json

# The original, pre-sweep hardcoded values -- kept as the floor/fallback, not deleted,
# so a fresh checkout or a DB with no ML_HYPERPARAMS row yet trains identically to before.
DEFAULT_HYPERPARAMS = {
    'n_estimators': 300, 'max_depth': 5, 'learning_rate': 0.05,
    'num_leaves': 15, 'min_child_samples': 20,
}


def load_hyperparams(conn):
    """Returns the latest calibrated hyperparameter dict, or DEFAULT_HYPERPARAMS if
    scripts/sweep_ml_hyperparams.py has never run. Never raises -- a missing/malformed
    row falls back to the default rather than crashing training."""
    cur = conn.cursor()
    cur.execute("""
        SELECT notes FROM performance_audit
        WHERE signal_type = 'ML_HYPERPARAMS' AND signal_name = 'CURRENT'
        ORDER BY run_date DESC LIMIT 1
    """)
    row = cur.fetchone()
    if not row:
        return dict(DEFAULT_HYPERPARAMS)
    try:
        notes = json.loads(row[0]) if isinstance(row[0], str) else row[0]
        params = notes.get('hyperparams')
        if not params or not all(k in params for k in DEFAULT_HYPERPARAMS):
            return dict(DEFAULT_HYPERPARAMS)
        return params
    except (ValueError, AttributeError, TypeError):
        return dict(DEFAULT_HYPERPARAMS)
