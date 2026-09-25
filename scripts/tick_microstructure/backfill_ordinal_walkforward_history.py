"""Walk-forward historical backfill for the ordinal "how far will it run" (reach_R) daily-
history chart -- same purpose and discipline as
backfill_tick_trend_walkforward_history.py's own header (read that first), applied to the
ordinal model (train_ordinal_model.py's OrderedModel/fit_and_predict()) instead of the binary
one. RTH-only, fade-setups only, tick-derived features -- matches the live daily recheck's own
scope exactly.

Written under its own distinct signal_type/signal_name (ML_WALKFORWARD_BACKTEST /
ordinal_reach_r_walkforward), never the live recheck's RESEARCH_CLAIM /
ordinal_reach_r_track_b_harness_20260924 -- same collision-avoidance rule as the binary script.

Run manually: venv/bin/python3 scripts/tick_microstructure/backfill_ordinal_walkforward_history.py
"""
import json

import psycopg2
from scipy.stats import spearmanr

from train_fade_outcome_model import load_data, day_blocked_split, EMBARGO_DAYS
from train_ordinal_model import ORDINAL_FEATURES, fit_and_predict

MIN_DAYS_FOR_SPLIT = 25
MIN_TRAIN_ROWS = 30
MIN_TEST_ROWS = 10


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
    rth_df = df.dropna(subset=ORDINAL_FEATURES + ['reach_r_bucket']).copy()
    rth_df['reach_r_bucket'] = rth_df['reach_r_bucket'].astype(int)
    all_days = sorted(rth_df['trade_date'].unique())
    print(f"{len(all_days)} distinct real RTH days with a reach_R bucket "
          f"({all_days[0]} to {all_days[-1]})")

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
        sub = rth_df[rth_df['trade_date'] <= cutoff]
        train_days, _val_days, test_days = day_blocked_split(sub, embargo_days=EMBARGO_DAYS)
        train_df = sub[sub['trade_date'].isin(train_days)]
        test_df = sub[sub['trade_date'].isin(test_days)]
        if len(train_df) < MIN_TRAIN_ROWS or len(test_df) < MIN_TEST_ROWS:
            continue
        try:
            expected_bucket, _res = fit_and_predict(train_df, test_df, ORDINAL_FEATURES)
        except Exception as e:
            print(f"  {cutoff}: fit failed ({e}), skipping")
            continue
        rho, pval = spearmanr(expected_bucket, test_df['reach_r_bucket'])

        notes_json = json.dumps({
            'as_of_date': str(cutoff),
            'spearman': float(rho),
            'spearman_pvalue': float(pval),
            'n_train_rows': int(len(train_df)),
            'n_test_rows': int(len(test_df)),
            'n_test_days': int(test_df['trade_date'].nunique()),
            'walkforward': True,
        })
        cursor.execute("""
            INSERT INTO performance_audit (
                run_date, window_days, signal_type, signal_name, sample_size, notes
            ) VALUES (%s, 0, 'ML_WALKFORWARD_BACKTEST', 'ordinal_reach_r_walkforward', %s, %s)
            ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
                sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
        """, (cutoff, int(len(test_df)), notes_json))
        n_written += 1

    print(f"Wrote {n_written} walk-forward historical points "
          f"(as-of dates {all_days[MIN_DAYS_FOR_SPLIT]} through {all_days[-1]})")


if __name__ == '__main__':
    main()
