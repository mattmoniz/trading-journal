"""The reusable per-candidate scoring function. THIS is the function a future live
integration (Section 7's Python microservice) would import and wrap in a Flask endpoint --
built as a clean, standalone function now specifically so that promotion later doesn't
require a rewrite, per the user's explicit request to build with integration in mind.

No DB access, no batch-loop logic here on purpose -- those live in run_silo_scoring.py
(the batch driver) and the future live service respectively, so this core function stays
usable by both without modification.
"""
import joblib
import pandas as pd


def load_model(model_path):
    """Loads a model bundle saved by train.py. Returns {model, feature_cols}."""
    return joblib.load(model_path)


def score_candidate(model_bundle, features: dict, approval_threshold: float):
    """Scores ONE candidate. `features` must have every key in model_bundle['feature_cols']
    (missing keys are fine -- LightGBM handles them as NaN -- but an unexpected SHAPE
    mismatch, e.g. wrong feature_cols entirely, will raise, which is correct: a silent
    shape mismatch would produce a meaningless score with no error, exactly the kind of
    failure mode this codebase's own hard rules warn about elsewhere.

    Returns {probability, verdict} -- verdict is 'TAKE' if probability clears the model's
    own persisted approval_threshold (from ml_models, never hardcoded here), else 'VETO'.
    """
    model = model_bundle['model']
    feature_cols = model_bundle['feature_cols']
    # Named DataFrame, not a bare positional list -- LightGBM was trained on named columns
    # (dataset.py's DataFrame), so scoring with a plain list relies on the caller getting
    # positional order exactly right with no way to catch a mistake. This makes a
    # feature-order bug loud (a KeyError from the dict) instead of a silent wrong score.
    row = pd.DataFrame([{col: features.get(col) for col in feature_cols}], columns=feature_cols)
    probability = float(model.predict_proba(row)[0][1])
    verdict = 'TAKE' if probability >= approval_threshold else 'VETO'
    return {'probability': probability, 'verdict': verdict}
