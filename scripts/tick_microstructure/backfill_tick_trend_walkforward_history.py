"""Walk-forward historical backfill for the tick_trend_efficiency_fade_outcome daily-history
chart (2026-09-24, user request: "I thought you were adding backtest historical data" -- the
live daily-recheck chart only started accumulating today and had just 1-2 points).

Retroactively simulates what the SAME methodology the live recheck uses (day_blocked_split()
+ train_and_eval() with TICK_SIGNED features / logistic regression, train_fade_outcome_model.py)
would have reported if run as of each of many past dates -- walking an "as of" cutoff forward
through real history, each time bounding the dataset to trade_date <= cutoff and re-deriving a
fresh chronological train/test split from scratch within that window.

WHAT THIS IS AND ISN'T:
- A real, computed-not-fabricated historical trajectory -- every point is a genuine day-blocked
  train/test AUC on real data, just as of a different historical "today."
- Computed once, in a single retrospective batch, using data we already have in full. This is
  DIFFERENT from the live daily recheck (which peeks forward one real day at a time going
  forward, and whose own history is explicitly informational/non-independent per the standing
  "optional stopping" convention) -- there's no peeking or stopping-early risk here, since
  nothing is being decided from it, it's a hindsight visualization of already-known outcomes.
- NOT a substitute for the frozen model's pre-registered 20-distinct-day PROSPECTIVE evidence
  floor (score_frozen_model.py) -- that's the only number that should ever gate a promote/kill
  decision on this model. This script's output is for the chart only.
- Written under its OWN distinct signal_type/signal_name (ML_WALKFORWARD_BACKTEST /
  tick_trend_fade_outcome_walkforward), never the live recheck's RESEARCH_CLAIM /
  tick_trend_efficiency_fade_outcome_provisional_20260923 -- per the standing "a backtest
  reference must never collide with the live pipeline's own signal_name" rule (this exact
  collision shape bit RTH_FLUSH/SETUP_STATUS on 2026-09-14).

Deterministic given the data snapshot + fixed seed -- safe to re-run, not scheduled (the
underlying historical days don't change; re-running only matters if the feature pipeline itself
changes upstream).

Run manually: venv/bin/python3 scripts/tick_microstructure/backfill_tick_trend_walkforward_history.py
"""
import json
import sys

import psycopg2

from train_fade_outcome_model import (
    TICK_SIGNED_COLS, RANDOM_SEED, EMBARGO_DAYS, load_data, day_blocked_split, train_and_eval,
)

MIN_DAYS_FOR_SPLIT = 20  # below this, day_blocked_split() can't produce a valid train+test pair


def load_env():
    env_vars = {}
    with open('/home/mmoniz/trading-journal/.env', 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                key, val = line.split('=', 1)
                env_vars[key] = val
    return env_vars


def main():
    df = load_data()
    all_days = sorted(df['trade_date'].unique())
    print(f"{len(all_days)} distinct real days available ({all_days[0]} to {all_days[-1]})")

    env_vars = load_env()
    conn = psycopg2.connect(
        host=env_vars.get('DB_HOST', 'localhost'), port=env_vars.get('DB_PORT', '5432'),
        dbname=env_vars.get('DB_NAME', 'trading_journal'), user=env_vars.get('DB_USER', 'trader'),
        password=env_vars.get('DB_PASSWORD', 'trader123'))
    conn.autocommit = True
    cursor = conn.cursor()

    n_written = 0
    for i in range(MIN_DAYS_FOR_SPLIT, len(all_days)):
        cutoff = all_days[i]
        sub = df[df['trade_date'] <= cutoff]
        train_days, _val_days, test_days = day_blocked_split(sub, embargo_days=EMBARGO_DAYS)
        result = train_and_eval(sub, TICK_SIGNED_COLS, train_days, test_days, model_type='logistic')
        if result is None:
            continue
        auc, _model, n_train, n_test, n_test_days = result

        notes_json = json.dumps({
            'as_of_date': str(cutoff),
            'test_auc': float(auc),
            'n_train_rows': int(n_train),
            'n_test_rows': int(n_test),
            'n_test_days': int(n_test_days),
            'walkforward': True,
        })
        cursor.execute("""
            INSERT INTO performance_audit (
                run_date, window_days, signal_type, signal_name, sample_size, notes
            ) VALUES (%s, 0, 'ML_WALKFORWARD_BACKTEST', 'tick_trend_fade_outcome_walkforward', %s, %s)
            ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
                sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
        """, (cutoff, int(n_test), notes_json))
        n_written += 1

    print(f"Wrote {n_written} walk-forward historical points "
          f"(as-of dates {all_days[MIN_DAYS_FOR_SPLIT]} through {all_days[-1]})")


if __name__ == '__main__':
    main()
