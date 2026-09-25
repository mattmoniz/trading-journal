"""Freeze the tick_trend_efficiency_fade_outcome model, per Opus Audit #14 (2026-09-24),
step 0 of the recommended build order (scratch/opus_audit_14_ml_strategy_results.md section 6
item 3 / section 7 step 0): daily-retrained AUC snapshots share ~99% of their underlying data
(a sliding 183-day window retrained from scratch each day), so a history of them is ONE noisy
measurement drawn many times, not many independent measurements -- and "promote once p<0.05
shows up" on that history is optional stopping.

This script trains ONE model on all real data available today, saves it as a frozen artifact
(model + feature list + training cutoff date), and does not run again. It exists to be run
exactly once per freeze decision, not on a schedule. The prospectively-honest way to use this
finding going forward is score_frozen_model.py, which scores ONLY genuinely-new post-freeze
rows against this frozen model -- never retrains it.

RE-FROZEN 2026-09-24 (same day as the first freeze) after completing Opus Audit #14's Step 1
comparison matrix, which the first freeze predates: LOGISTIC regression on TICK_SIGNED features
(direction-signed order-flow features added, per section 2.3) beat LightGBM out-of-fold
(AUC 0.5783 vs 0.5480) AND cleared the day-block permutation null at p=0.025 (200 permutations)
-- the first freeze had used LightGBM on the pre-Step-1 unsigned feature set, which the audit's
own "simplest model first, complex model only if it beats the baseline" rule (section 8) says
should never have been the canonical choice once a simpler model wins. Re-freezing under a
materially better, properly-chosen model is exactly the kind of deliberate, explicit,
once-per-decision re-freeze this script's own refuse-to-overwrite guard exists to gate --
not a routine event. The scaler is saved alongside the model since logistic regression needs
its own fitted StandardScaler at score time (LightGBM did not).

Run manually: venv/bin/python3 scripts/tick_microstructure/freeze_model.py
"""
import json
import sys
from datetime import datetime, timezone

import joblib
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from train_fade_outcome_model import RANDOM_SEED, TICK_SIGNED_COLS, load_data

ARTIFACT_DIR = '/home/mmoniz/trading-journal/scripts/tick_microstructure/artifacts'
MODEL_PATH = f'{ARTIFACT_DIR}/frozen_fade_outcome_model.pkl'
SCALER_PATH = f'{ARTIFACT_DIR}/frozen_fade_outcome_scaler.pkl'
META_PATH = f'{ARTIFACT_DIR}/frozen_fade_outcome_model.json'


def main():
    import os
    os.makedirs(ARTIFACT_DIR, exist_ok=True)

    if os.path.exists(META_PATH):
        with open(META_PATH) as f:
            existing = json.load(f)
        print(f"A frozen model already exists (frozen {existing['frozen_at_et']}, "
              f"training cutoff {existing['training_cutoff_date']}).")
        print("Refusing to overwrite -- delete the artifact files manually first if a "
              "deliberate re-freeze is intended (this should be a rare, explicit decision, "
              "not something a script does automatically).")
        sys.exit(1)

    feature_cols = TICK_SIGNED_COLS
    df = load_data().dropna(subset=feature_cols + ['label'])
    training_cutoff_date = str(df['trade_date'].max())
    print(f"Training frozen model (LogisticRegression, TICK_SIGNED features) on "
          f"{len(df):,} real fade-fire rows through {training_cutoff_date} "
          f"({df['trade_date'].nunique()} distinct days)")

    scaler = StandardScaler()
    X = scaler.fit_transform(df[feature_cols])
    model = LogisticRegression(max_iter=1000, random_state=RANDOM_SEED)
    model.fit(X, df['label'])

    joblib.dump(model, MODEL_PATH)
    joblib.dump(scaler, SCALER_PATH)
    meta = {
        'frozen_at_et': datetime.now(timezone.utc).astimezone().isoformat(),
        'training_cutoff_date': training_cutoff_date,
        'n_training_rows': len(df),
        'n_training_days': int(df['trade_date'].nunique()),
        'feature_cols': feature_cols,
        'model_type': 'logistic',
        'random_seed': RANDOM_SEED,
        'source_claim': 'tick_trend_efficiency_fade_outcome_provisional_20260923',
        'reason_for_choice': (
            'Opus Audit #14 Step 1 comparison matrix (2026-09-24): LogisticRegression on '
            'TICK_SIGNED beat LightGBM out-of-fold (AUC 0.5783 vs 0.5480) and cleared the '
            '200-permutation day-block null at p=0.025. LightGBM on the pre-Step-1 unsigned '
            'feature set (the first freeze, same day, since superseded) never earned its '
            'complexity over a logistic baseline.'
        ),
        'note': ('Frozen per Opus Audit #14 evaluation-protocol fix. Score with '
                 'score_frozen_model.py against post-freeze days only -- this file is '
                 'canonical prospective evidence, the daily sliding-window retrain in '
                 'recheck_tick_trend_fade_finding.mjs is informational only.'),
    }
    with open(META_PATH, 'w') as f:
        json.dump(meta, f, indent=2)

    print(f"Frozen model saved: {MODEL_PATH}")
    print(f"Scaler saved: {SCALER_PATH}")
    print(f"Metadata saved: {META_PATH}")
    print(f"Training cutoff: {training_cutoff_date} -- only rows with trade_date > this "
          f"count as genuinely prospective evidence going forward.")


if __name__ == '__main__':
    main()
