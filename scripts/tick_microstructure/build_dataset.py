"""Full hand-feature + survival-target dataset build, per DeepSeek's recommended sequence
(scratch/deepseek_response.md, 2026-09-23 review): the hand-feature baseline + full
validation machinery FIRST, no neural encoder yet.

MEMORY-SAFE VERSION, rewritten 2026-09-23 after the original list-materializing version
(list(stream_trades(...)), list(bucketize(...)), a list-returning compute_features())
crashed the host WSL VM (6.2GB total RAM) attempting a 6-month run -- tens of millions of
Python objects held in memory simultaneously. This version chains everything as
generators: read one trade -> fold into a bucket -> emit a feature row -> resolve its
survival target once enough future data has passed -> write it to disk -> discard it.
The only bounded, non-trivial memory the streaming survival target holds is roughly
max_horizon_hours worth of buckets "in flight" (a couple thousand rows), not the dataset.

Usage: python3 scripts/tick_microstructure/build_dataset.py [--days N] [--out PATH]
  --days N restricts to the most recent N days (for a quick correctness/memory check
  before trusting a full run) -- defaults to the full configured 6-month range.
"""
import sys
import os
import datetime
import csv
import time
import argparse
import resource

sys.path.insert(0, os.path.dirname(__file__))
from multiday_stream import stream_trades, get_schedule_summary
from bucketize import bucketize
from features import compute_features
from survival_target import stream_survival_targets
from atr import get_rolling_atr20

FULL_START_DATE = datetime.date(2026, 3, 24)
FULL_END_DATE = datetime.date(2026, 9, 23)
GRAIN_TYPE = 'volume'
GRAIN_THRESHOLD = 100
TIME_CAP_SECONDS = 60
WINDOW_SCALES = {'short': 20, 'medium': 100, 'long': 500}
K_VALUES = [0.25, 0.5, 1.0]
DEFAULT_OUT_PATH = '/home/mmoniz/trading-journal/scratch/tick_microstructure_dataset_6mo.csv'

FIELDNAMES = [
    'ts_et', 'trade_date', 'close', 'order_flow_imbalance', 'elapsed_seconds',
    'price_impact_per_contract', 'same_side_run_length', 'n_trades', 'volume',
] + [f'trailing_ofi_mean_{name}' for name in WINDOW_SCALES] \
  + [f'trailing_elapsed_mean_{name}' for name in WINDOW_SCALES] \
  + [f'realized_micro_vol_{name}' for name in WINDOW_SCALES] \
  + [f'time_to_event_k{k}' for k in K_VALUES] \
  + [f'event_direction_k{k}' for k in K_VALUES] \
  + [f'censored_k{k}' for k in K_VALUES]


def peak_rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0  # KB -> MB on Linux


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=None)
    parser.add_argument('--out', type=str, default=DEFAULT_OUT_PATH)
    args = parser.parse_args()

    end_date = FULL_END_DATE
    start_date = FULL_START_DATE if args.days is None else (end_date - datetime.timedelta(days=args.days))

    print(f"Range: {start_date} to {end_date}")
    print(f"Schedule: {get_schedule_summary(start_date, end_date)}")

    trade_stream = stream_trades(start_date, end_date)
    bucket_stream = bucketize(trade_stream, GRAIN_TYPE, GRAIN_THRESHOLD, time_cap_seconds=TIME_CAP_SECONDS)
    feature_stream = compute_features(bucket_stream, window_scales=WINDOW_SCALES)
    ready_stream = (f for f in feature_stream if f['has_full_trailing_window'])
    target_stream = stream_survival_targets(ready_stream, get_rolling_atr20, K_VALUES, max_horizon_hours=48)

    t0 = time.time()
    n_written = 0
    n_skipped_no_atr = 0
    distinct_days = set()
    last_progress_print = t0

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()

        for row, targets in target_stream:
            if any(t is None for t in targets.values()):
                n_skipped_no_atr += 1
                continue
            out_row = {
                'ts_et': row['ts_et'].isoformat(),
                'trade_date': row['ts_et'].date().isoformat(),
                'close': row['close'],
                'order_flow_imbalance': row['order_flow_imbalance'],
                'elapsed_seconds': row['elapsed_seconds'],
                'price_impact_per_contract': row['price_impact_per_contract'],
                'same_side_run_length': row['same_side_run_length'],
                'n_trades': row['n_trades'],
                'volume': row['volume'],
            }
            for name in WINDOW_SCALES:
                out_row[f'trailing_ofi_mean_{name}'] = row[f'trailing_ofi_mean_{name}']
                out_row[f'trailing_elapsed_mean_{name}'] = row[f'trailing_elapsed_mean_{name}']
                out_row[f'realized_micro_vol_{name}'] = row[f'realized_micro_vol_{name}']
            for k in K_VALUES:
                t = targets[k]
                out_row[f'time_to_event_k{k}'] = t['time_to_event_seconds']
                out_row[f'event_direction_k{k}'] = t['event_direction'] or ''
                out_row[f'censored_k{k}'] = t['censored']
            writer.writerow(out_row)
            n_written += 1
            distinct_days.add(row['ts_et'].date())

            now = time.time()
            if now - last_progress_print > 15:
                print(f"  ...{n_written:,} rows written, {len(distinct_days)} distinct days, "
                      f"peak RSS so far: {peak_rss_mb():.0f} MB, elapsed {now - t0:.0f}s")
                last_progress_print = now

    elapsed = time.time() - t0
    print(f"Done. {n_written:,} rows written to {args.out}")
    print(f"Skipped (no ATR20 available yet): {n_skipped_no_atr:,}")
    print(f"Distinct trading days represented: {len(distinct_days)}")
    print(f"Elapsed: {elapsed:.1f}s, peak RSS: {peak_rss_mb():.0f} MB")


if __name__ == '__main__':
    main()
