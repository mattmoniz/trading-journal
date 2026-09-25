"""Illustrative $ backtest for the frozen tick_trend_efficiency_fade_outcome model
(2026-09-24, user request: "can we apply that backtest" after asking why the binary/ordinal
model charts don't look like the Meta-Labeler's All-vs-Approved dollar equity curve).

WHAT THIS IS AND ISN'T -- read before citing this anywhere:
- Uses the SAME chronological day-blocked test split (day_blocked_split(), 70/15/15,
  1-day embargo) that freeze_model.py's own docstring cites as the validation behind the
  freeze decision (LogisticRegression/TICK_SIGNED, AUC=0.5783, p=0.025). This is NOT new
  evidence -- it's a dollar-denominated view of the identical held-out days already
  summarized as that AUC number. A good-looking $ curve here confirms nothing beyond what
  the AUC already said.
- This is explicitly NOT the frozen model's genuine prospective evidence. That's
  score_frozen_model.py, scored only on real rows after the freeze date, gated behind a
  pre-registered 20-distinct-day floor before it counts as a checkpoint (see that script's
  own docstring -- currently at 1/20 days). That evidence keeps accumulating automatically
  via the daily cron; this script neither touches nor substitutes for it.

Trains a fresh model on the pre-test days only (same feature set / model config / seed as
freeze_model.py) and predicts on the held-out test days. predicted_take = predicted
probability of TARGET_HIT >= 0.5. Writes {id, predicted_take, predicted_proba} for every
test-set trade -- deliberately NOT actual_pnl/fired_at, so the serving endpoint always joins
against active_setups live and can never go stale if a row's resolution is later corrected.

Deterministic given the data snapshot + RANDOM_SEED -- safe to re-run, not scheduled. This is
a one-time illustrative artifact tied to a fixed historical split, not a live signal with its
own recheck cadence (the daily binary/ordinal history charts already cover that).

Run manually: venv/bin/python3 scripts/tick_microstructure/backtest_frozen_model_dollar_illustration.py
"""
import json
import os

from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from train_fade_outcome_model import (
    TICK_SIGNED_COLS, RANDOM_SEED, EMBARGO_DAYS,
    load_data, day_blocked_split,
)

ARTIFACT_PATH = os.path.join(
    os.path.dirname(__file__), 'artifacts', 'frozen_model_test_set_predictions.json'
)


def main():
    df = load_data()
    train_days, _val_days, test_days = day_blocked_split(df, embargo_days=EMBARGO_DAYS)
    sub = df.dropna(subset=TICK_SIGNED_COLS + ['label'])
    train_df = sub[sub['trade_date'].isin(train_days)]
    test_df = sub[sub['trade_date'].isin(test_days)]

    if len(train_df) < 20 or len(test_df) < 5:
        print(f"Too thin to build an illustration (train={len(train_df)}, test={len(test_df)}).")
        return

    scaler = StandardScaler()
    X_train = scaler.fit_transform(train_df[TICK_SIGNED_COLS])
    X_test = scaler.transform(test_df[TICK_SIGNED_COLS])
    model = LogisticRegression(max_iter=1000, random_state=RANDOM_SEED)
    model.fit(X_train, train_df['label'])
    proba = model.predict_proba(X_test)[:, 1]

    out_rows = [
        {'id': int(row_id), 'predicted_take': bool(p >= 0.5), 'predicted_proba': float(p)}
        for row_id, p in zip(test_df['id'], proba)
    ]

    os.makedirs(os.path.dirname(ARTIFACT_PATH), exist_ok=True)
    with open(ARTIFACT_PATH, 'w') as f:
        json.dump({
            'n_train_days': int(train_df['trade_date'].nunique()),
            'n_test_days': int(test_df['trade_date'].nunique()),
            'n_test_trades': len(out_rows),
            'rows': out_rows,
        }, f, indent=2)

    n_take = sum(r['predicted_take'] for r in out_rows)
    print(f"Wrote {len(out_rows)} test-set predictions ({test_df['trade_date'].nunique()} "
          f"distinct test days, trained on {train_df['trade_date'].nunique()} prior days) "
          f"to {ARTIFACT_PATH}")
    print(f"Predicted-take rate: {n_take}/{len(out_rows)} ({100 * n_take / len(out_rows):.1f}%)")


if __name__ == '__main__':
    main()
