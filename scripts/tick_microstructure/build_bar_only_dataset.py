"""Bar-only version of build_trade_level_dataset.py, covering the FULL real setup roster
(not fade-only), per explicit user request 2026-09-24: "point the how far will it run model
and apply it to ALL setups. Isn't that the point for learning."

Deliberately does NOT touch the tick pipeline (multiday_stream/bucketize/features) -- per
this same session's own Step-1 finding (TICK_SIGNED vs BAR_CONTROL AUC 0.5481 vs 0.5480,
effectively tied), the tick infrastructure doesn't earn its cost for this question. Building
"apply to ALL setups" on top of the tick pipeline would have directly contradicted that
finding (caught by the user mid-run, killed the tick rebuild before it finished). This script
only ever queries price_bars_primary and price bars around each fire -- no ~7min tick-stream
scan, no bucketizer, no order-flow feature computer.

Output columns: id, setup_type, resolution, label, actual_pnl, dir, reach_r, reach_r_bucket,
bar_ofi_15, bar_efficiency_ratio_15, bar_realized_vol_15. Reuses load_real_fade_fires(),
get_directions(), fetch_bar_control_features(), compute_reach_r() directly from
build_trade_level_dataset.py -- no duplicated logic, per this codebase's own "share modules"
rule.
"""
import os
import sys
import csv
import time
import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'ml_meta_labeling'))
from db import get_connection
from build_trade_level_dataset import (
    load_real_fade_fires, get_directions, fetch_bar_control_features, compute_reach_r,
    BAR_CONTROL_COLS, DEFAULT_LOOKBACK_DAYS,
)

OUT_PATH = '/home/mmoniz/trading-journal/scratch/bar_only_all_setups_outcomes.csv'


def main():
    end_date = datetime.date.today()
    start_date = end_date - datetime.timedelta(days=DEFAULT_LOOKBACK_DAYS)

    t0 = time.time()
    fires = load_real_fade_fires(start_date, end_date)
    print(f"Real setup fires in range (ALL setup_types): {len(fires)} "
          f"(STOP_HIT={sum(1 for f in fires if f['resolution']=='STOP_HIT')}, "
          f"TARGET_HIT={sum(1 for f in fires if f['resolution']=='TARGET_HIT')})")

    print("Resolving trade direction via the canonical inferDirection()...")
    direction_map = get_directions([f['setup_type'] for f in fires])
    n_no_dir = sum(1 for f in fires if direction_map.get(f['setup_type']) is None)
    print(f"Direction resolved for {len(fires) - n_no_dir}/{len(fires)} rows "
          f"({n_no_dir} setup_types have no inferrable direction)")

    print(f"Fetching bar-level control features (cheap, no tick streaming)...")
    conn = get_connection()
    try:
        bar_control = fetch_bar_control_features(conn, [f['fired_at_et'] for f in fires])
    finally:
        conn.close()
    print(f"  ...done, elapsed={time.time()-t0:.0f}s")

    print(f"Computing ordinal reach_R target (RTH-only)...")
    conn = get_connection()
    try:
        reach_r_map = compute_reach_r(conn, fires)
    finally:
        conn.close()
    print(f"reach_R computed for {len(reach_r_map)}/{len(fires)} rows (RTH-only + sufficient forward bars)")
    print(f"Total elapsed: {time.time()-t0:.0f}s")

    fieldnames = ['id', 'fired_at_et', 'trade_date', 'setup_type', 'resolution', 'label',
                  'actual_pnl', 'dir', 'reach_r', 'reach_r_bucket'] + BAR_CONTROL_COLS
    with open(OUT_PATH, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for fire in fires:
            direction = direction_map.get(fire['setup_type'])
            dir_num = 1 if direction == 'LONG' else (-1 if direction == 'SHORT' else None)
            reach = reach_r_map.get(fire['id'])
            out = {
                'id': fire['id'],
                'fired_at_et': fire['fired_at_et'].isoformat(),
                'trade_date': fire['fired_at_et'].date().isoformat(),
                'setup_type': fire['setup_type'],
                'resolution': fire['resolution'],
                'label': 1 if fire['resolution'] == 'TARGET_HIT' else 0,
                'actual_pnl': fire['actual_pnl'],
                'dir': dir_num,
                'reach_r': reach['reach_r'] if reach else None,
                'reach_r_bucket': reach['reach_r_bucket'] if reach else None,
            }
            for col in BAR_CONTROL_COLS:
                out[col] = bar_control.get(fire['fired_at_et'], {}).get(col)
            writer.writerow(out)

    print(f"Wrote {len(fires)} rows to {OUT_PATH}")


if __name__ == '__main__':
    main()
