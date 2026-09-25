"""Score the frozen tick_trend_efficiency_fade_outcome model against genuinely NEW (post-
freeze) real fade-fire rows only -- never retrains. This is the canonical prospective-evidence
path per Opus Audit #14: a daily sliding-window retrain shares ~99% of its data day to day and
its own AUC history is not independent evidence; this script's AUC, computed only on rows the
frozen model has never seen, is.

Pre-registered single look (Opus Audit #14 section 6 item 2, adapted from the roster's own
>=20-distinct-day / >=200-trade rule): do not treat this script's AUC as a promotion signal
until n_new_days >= 20. Below that, it reports accumulation progress only -- printing an AUC
before then is informational, not a checkpoint to act on, and checking it daily and stopping
the first time it looks good is exactly the optional-stopping trap this script exists to avoid.

Run manually or from recheck_tick_trend_fade_finding.mjs:
  venv/bin/python3 scripts/tick_microstructure/score_frozen_model.py
"""
import json
import sys

import joblib
import numpy as np
from sklearn.metrics import roc_auc_score

from train_fade_outcome_model import load_data

# Deliberately does NOT import FEATURE_COLS from train_fade_outcome_model -- that constant
# changed shape 2026-09-24 (Opus Audit #14 Step 1 added signed/bar-control columns) AFTER
# this model was frozen. The frozen artifact must always be scored with the EXACT feature
# list it was trained on (saved in its own meta.json at freeze time), never whatever the
# live training script's column list happens to be today -- otherwise a future feature-set
# change would silently break scoring (wrong column count/order) or, worse, silently
# succeed while feeding the model features in a different meaning than it was trained on.

ARTIFACT_DIR = '/home/mmoniz/trading-journal/scripts/tick_microstructure/artifacts'
MODEL_PATH = f'{ARTIFACT_DIR}/frozen_fade_outcome_model.pkl'
SCALER_PATH = f'{ARTIFACT_DIR}/frozen_fade_outcome_scaler.pkl'
META_PATH = f'{ARTIFACT_DIR}/frozen_fade_outcome_model.json'
PROSPECTIVE_DAY_FLOOR = 20  # Opus Audit #14 section 6 item 2 -- the single pre-registered look


def main():
    try:
        with open(META_PATH) as f:
            meta = json.load(f)
    except FileNotFoundError:
        print("NO_FROZEN_MODEL: run freeze_model.py once first.")
        sys.exit(1)

    model = joblib.load(MODEL_PATH)
    scaler = joblib.load(SCALER_PATH) if meta.get('model_type') == 'logistic' else None
    cutoff = meta['training_cutoff_date']
    feature_cols = meta['feature_cols']

    df = load_data()
    new_df = df[df['trade_date'].astype(str) > cutoff].dropna(subset=feature_cols + ['label'])
    n_new_days = new_df['trade_date'].nunique()
    n_new_trades = len(new_df)

    print(f"Frozen model trained through {cutoff} ({meta['n_training_days']} days, "
          f"{meta['n_training_rows']} rows)")
    print(f"Post-freeze data available: {n_new_trades} real trades across {n_new_days} "
          f"distinct new days")

    result = {
        'training_cutoff_date': cutoff,
        'n_new_days': int(n_new_days),
        'n_new_trades': int(n_new_trades),
        'prospective_floor_met': bool(n_new_days >= PROSPECTIVE_DAY_FLOOR),
        'frozen_auc': None,
        'label_balance_ok': None,
    }

    if n_new_trades < 5 or new_df['label'].nunique() < 2:
        print("Insufficient post-freeze data to score yet (need >=5 trades, both labels "
              "present). Not an error -- this is expected immediately after freezing.")
        print(json.dumps(result))
        return

    X_new = scaler.transform(new_df[feature_cols]) if scaler is not None else new_df[feature_cols]
    proba = model.predict_proba(X_new)[:, 1]
    auc = roc_auc_score(new_df['label'], proba)
    result['frozen_auc'] = float(auc)
    result['label_balance_ok'] = True

    print(f"FROZEN-MODEL prospective AUC on new data: {auc:.4f}")
    if n_new_days < PROSPECTIVE_DAY_FLOOR:
        print(f"Below the pre-registered floor ({n_new_days}/{PROSPECTIVE_DAY_FLOOR} distinct "
              f"new days) -- this number is accumulation progress, NOT a checkpoint to act on. "
              f"Do not promote or kill the claim based on this AUC until the floor is met.")
    else:
        print(f"Floor met ({n_new_days} >= {PROSPECTIVE_DAY_FLOOR} distinct new days) -- this "
              f"is now the single pre-registered look. A human should review it once, not the "
              f"script auto-deciding.")

    print(json.dumps(result))


if __name__ == '__main__':
    main()
