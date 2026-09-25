"""Real ML training target, per explicit user direction 2026-09-23 (not another
informational badge): join real active_setups FADE-type outcomes to the tick-derived
trend/path-quality features at the exact moment each one fired, then train a classifier
predicting STOP_HIT vs TARGET_HIT. Trade-level (matching Track A's own shape), not
per-bucket -- avoids the circularity trap of training on a label built from the same kind
of data as the features (a real, independent label: what actually happened to a real
trade), and is far better statistically powered (2,285 real fade fires vs the earlier
per-bucket classifier's much noisier 48h-horizon target).

Streams the full tick pipeline ONCE across the whole date range (memory-safe, per the
existing streaming discipline) and only WRITES a row when a real fade fire's timestamp is
reached -- avoids materializing or saving the full ~700k-row bucket dataset when only
~2,285 rows are actually needed.
"""
import sys
import os
import csv
import json
import math
import time
import argparse
import resource
import subprocess
import datetime

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'ml_meta_labeling'))
from multiday_stream import stream_trades
from bucketize import bucketize
from features import compute_features, WINDOW_SCALES
from db import get_connection

DEFAULT_LOOKBACK_DAYS = 183  # ~6 months -- a fixed WINDOW, not a fixed pair of dates, so
# a later re-run genuinely slides forward and picks up new real fade fires instead of
# silently reprocessing the same historical range forever. (Real bug found and fixed
# 2026-09-23, before this was even wired into the weekly recheck cron: the original
# version hardcoded END_DATE to a literal 2026-09-23 date, which would have made the
# weekly self-recheck a no-op re-running the identical window every time.)
END_DATE = datetime.date.today()
START_DATE = END_DATE - datetime.timedelta(days=DEFAULT_LOOKBACK_DAYS)
GRAIN_TYPE = 'volume'
GRAIN_THRESHOLD = 100
TIME_CAP_SECONDS = 60
OUT_PATH = '/home/mmoniz/trading-journal/scratch/tick_trend_fade_outcomes.csv'

FEATURE_COLS = [
    'order_flow_imbalance', 'elapsed_seconds', 'price_impact_per_contract',
    'same_side_run_length', 'n_trades', 'volume',
] + [f'trailing_ofi_mean_{n}' for n in WINDOW_SCALES] \
  + [f'trailing_elapsed_mean_{n}' for n in WINDOW_SCALES] \
  + [f'realized_micro_vol_{n}' for n in WINDOW_SCALES] \
  + [f'ofi_abs_mean_{n}' for n in WINDOW_SCALES] \
  + [f'efficiency_ratio_{n}' for n in WINDOW_SCALES] \
  + [f'net_move_signed_{n}' for n in WINDOW_SCALES] \
  + ['ofi_divergence_short_long', 'vol_divergence_short_long', 'pace_divergence_short_long']

# Opus Audit #14 (2026-09-24) Step 1: direction-signed versions of the directional
# features above (OPEN_DECISION ml_direction_signed_features_untested_20260924). Signing
# convention: value * dir, where dir=+1 for a real LONG trade / -1 for SHORT (from the
# canonical inferDirection(), never reimplemented -- see get_directions.mjs). A positive
# signed value means "this feature points the same way as the trade," negative means
# "against it." efficiency_ratio_* (always >=0 by construction) is NOT signed directly --
# instead net_move_signed_* carries the market's own raw sign, and the signed-toward-trade
# version below re-derives the correct signed magnitude from the already-computed
# unsigned ratio, per the audit's own §2.3 recipe.
SIGNED_FEATURE_COLS = ['signed_ofi', 'signed_ofi_divergence_short_long'] \
  + [f'signed_trailing_ofi_mean_{n}' for n in WINDOW_SCALES] \
  + [f'signed_efficiency_toward_trade_{n}' for n in WINDOW_SCALES]

# Opus Audit #14 Step 1: "a bar-level control for B ... If the bar version matches the
# tick version, the tick pipeline is redundant for this question." Recomputes the same
# shape of features (OFI-analog, efficiency ratio, realized vol) from price_bars_primary
# 1-minute bars (which carry bid_volume/ask_volume) over the trailing 15 bars ending at
# floor(fired_at) -- NOT reusing the tick pipeline at all, a genuinely independent source.
BAR_CONTROL_WINDOW_MIN = 15
BAR_CONTROL_COLS = ['bar_ofi_15', 'bar_efficiency_ratio_15', 'bar_realized_vol_15']


def get_directions(setup_types):
    """Canonical LONG/SHORT resolution via the real inferDirection() (server/config/
    setupTypes.js) -- called through get_directions.mjs rather than reimplementing the
    LONG/SHORT/BULLISH/BEARISH/_UP/_DOWN regex logic in Python, per this codebase's own
    'export the real function, never reimplement live-derived classification logic
    inline' rule."""
    unique_types = sorted(set(setup_types))
    proc = subprocess.run(
        ['node', os.path.join(os.path.dirname(__file__), 'get_directions.mjs')],
        input='\n'.join(unique_types), capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'get_directions.mjs failed: {proc.stderr}')
    return json.loads(proc.stdout)


def fetch_bar_control_features(conn, fired_at_et_list):
    """For each real fire, pulls the trailing BAR_CONTROL_WINDOW_MIN 1-minute NQ bars
    ending at or before floor(fired_at) and computes the bar-level control features.
    One query per fire (n~2,300) -- cheap point lookups against an indexed ts column,
    not worth batching for this population size."""
    from zoneinfo import ZoneInfo
    ET = ZoneInfo('America/New_York')
    out = {}
    with conn.cursor() as cur:
        for fired_at_et in fired_at_et_list:
            floor_min = fired_at_et.replace(second=0, microsecond=0)
            cur.execute("""
                SELECT close, bid_volume, ask_volume
                FROM price_bars_primary
                WHERE symbol = 'NQ' AND ts <= %s
                ORDER BY ts DESC
                LIMIT %s
            """, (floor_min.replace(tzinfo=None), BAR_CONTROL_WINDOW_MIN))
            bars = cur.fetchall()[::-1]  # chronological order
            if len(bars) < BAR_CONTROL_WINDOW_MIN:
                out[fired_at_et] = {c: None for c in BAR_CONTROL_COLS}
                continue
            closes = [float(b[0]) for b in bars]
            bid_vols = [float(b[1] or 0) for b in bars]
            ask_vols = [float(b[2] or 0) for b in bars]
            bar_ofi_15 = sum(a - bd for a, bd in zip(ask_vols, bid_vols))
            net_move = abs(closes[-1] - closes[0])
            gross_path = sum(abs(closes[i] - closes[i - 1]) for i in range(1, len(closes)))
            bar_eff = (net_move / gross_path) if gross_path > 0 else None
            sq_rets = []
            for i in range(1, len(closes)):
                if closes[i - 1] > 0 and closes[i] > 0:
                    sq_rets.append(math.log(closes[i] / closes[i - 1]) ** 2)
            bar_vol = sum(sq_rets) if sq_rets else None
            out[fired_at_et] = {
                'bar_ofi_15': bar_ofi_15,
                'bar_efficiency_ratio_15': bar_eff,
                'bar_realized_vol_15': bar_vol,
            }
    return out


def load_real_fade_fires(start_date, end_date):
    """Real, clean setup outcomes across the FULL real roster -- STOP_HIT/TARGET_HIT only,
    real (not synthetic) origin, cluster-primary only (per the standing hard rule against
    double-counting a single real touch's confluence siblings). Broadened 2026-09-24 from
    fade-only (2,384 real rows) to every real setup_type (3,369 rows, +41%) per explicit user
    request: "point the how far will it run model and apply it to ALL setups... isn't that
    the point for learning." Kept the function name (fade-only naming is now stale but
    changing it would ripple through several call sites for no functional reason) --
    documented here instead."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, fired_at, setup_type, resolution, is_rth,
                    entry_zone_low, entry_zone_high, stop_level, actual_pnl
                FROM active_setups
                WHERE resolution IN ('STOP_HIT', 'TARGET_HIT')
                  AND origin_status IN ('ACTIVE', 'SHADOW')
                  AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
                  AND fired_at >= %s AND fired_at <= %s
                  AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL
                ORDER BY fired_at
            """, (start_date, end_date))
            rows = cur.fetchall()
    finally:
        conn.close()
    # active_setups.fired_at is `timestamp without time zone` -- verified directly
    # (psycopg2 returns it with tzinfo=None, raw digits e.g. "19:55:00" for a real
    # 7:55pm ET fire) that it stores ET wall-clock digits DIRECTLY, not UTC, matching
    # this codebase's own standing naive-timestamp convention (the DB session runs in
    # America/New_York). Attach ET tzinfo directly -- do NOT treat this as UTC and
    # convert, which would silently shift every fire by 4-5 hours before matching.
    from zoneinfo import ZoneInfo
    ET = ZoneInfo('America/New_York')
    return [
        {
            'id': r[0], 'fired_at_et': r[1].replace(tzinfo=ET), 'setup_type': r[2],
            'resolution': r[3], 'is_rth': r[4],
            'entry': (float(r[5]) + float(r[6])) / 2, 'stop': float(r[7]),
            'actual_pnl': float(r[8]) if r[8] is not None else None,
        }
        for r in rows
    ]


# Opus Audit #14 (2026-09-24) section 2.3 / OPEN_DECISION item 3 ("upgrade Track B to the
# one ordinal target"): reach_R = max favorable excursion in R, BEFORE the -1R stop is
# touched, within H bars (stop-first on a same-bar tie, matching every existing walker).
# Uncensored beyond the ORIGINAL target -- a trade that would have hit T1 and kept running
# still gets credit for its real MFE, not capped at 1R. A trade that never gets stopped
# within H bars gets its real MFE up to that point (no censoring at H either, matching the
# audit's "a trade that times out gets its real MFE bucket, nothing censored away").
REACH_R_H_BARS = 240  # RTH; Globex would need its own H (not built here -- RTH-only pilot)
REACH_R_BUCKET_EDGES = [0.5, 1.0, 1.5, 2.0, 3.0]  # -> 6 buckets: <0.5, 0.5-1, 1-1.5, 1.5-2, 2-3, >=3


def reach_r_bucket(reach_r):
    for i, edge in enumerate(REACH_R_BUCKET_EDGES):
        if reach_r < edge:
            return i
    return len(REACH_R_BUCKET_EDGES)


def compute_reach_r(conn, fires):
    """One forward bar-by-bar walk per fire (RTH only, H=240 bars). Returns
    {fire_id: {'reach_r': float, 'reach_r_bucket': int, 'mae_r': float,
    'fav_peak_bar': int, 'adv_peak_bar': int}}.

    mae_r (2026-09-24, DeepSeek path-distribution proposal, Opus Audit #14 follow-on):
    max ADVERSE excursion in R, tracked continuously across the SAME H-bar walk that already
    computes reach_r (MFE) -- UNCENSORED at the -1R stop, unlike reach_r's own walk which
    stops crediting new favorable moves once the stop is touched (stop-first tie-break). A
    trade that stops out at exactly -1R still has a real bar-by-bar adverse path before that
    point (e.g., -0.3R, -0.6R, -0.95R) -- mae_r captures the worst point actually reached,
    capped at 1.0 R once the stop is touched (can't have a real, tradeable adverse excursion
    beyond the point the position would have been closed). fav_peak_bar/adv_peak_bar are the
    bar-index (0-based, within the H-bar window) each peak occurred at -- a stable, useful
    input for a future time-to-peak quantile model, cheap to capture alongside the R values
    even though this pass doesn't fit that model yet.
    """
    from zoneinfo import ZoneInfo
    ET = ZoneInfo('America/New_York')
    out = {}
    with conn.cursor() as cur:
        for f in fires:
            if not f.get('is_rth'):
                continue  # RTH-only pilot, matching build_trade_forward_path.mjs's own scope
            entry, stop = f['entry'], f['stop']
            R = abs(entry - stop)
            if not (R > 0):
                continue
            direction = 1 if entry > stop else -1  # LONG if stop is below entry
            floor_min = f['fired_at_et'].replace(second=0, microsecond=0, tzinfo=None)
            cur.execute("""
                SELECT high, low FROM price_bars_primary
                WHERE symbol = 'NQ' AND ts >= %s
                ORDER BY ts ASC LIMIT %s
            """, (floor_min, REACH_R_H_BARS))
            bars = cur.fetchall()
            if len(bars) < 5:
                continue
            max_fav_r = 0.0
            max_adv_r = 0.0
            fav_peak_bar = 0
            adv_peak_bar = 0
            for bar_idx, (hi, lo) in enumerate(bars):
                hi, lo = float(hi), float(lo)
                fav = (hi - entry) if direction == 1 else (entry - lo)
                adv = (entry - lo) if direction == 1 else (hi - entry)
                adv_r_this_bar = min(adv / R, 1.0)  # capped at the stop -- no real excursion past it
                if adv_r_this_bar > max_adv_r:
                    max_adv_r = adv_r_this_bar
                    adv_peak_bar = bar_idx
                # Stop-first on a same-bar tie (matching every existing walker): check the
                # stop BEFORE crediting this bar's favorable excursion -- a bar that touches
                # both the stop and a new favorable high can't be ordered intrabar from
                # 1-minute OHLC alone, so the conservative assumption is the stop went first
                # and this bar's own favorable move is never credited.
                if adv / R >= 1.0:
                    break
                if fav / R > max_fav_r:
                    max_fav_r = fav / R
                    fav_peak_bar = bar_idx
            out[f['id']] = {
                'reach_r': max_fav_r, 'reach_r_bucket': reach_r_bucket(max_fav_r),
                'mae_r': max_adv_r, 'fav_peak_bar': fav_peak_bar, 'adv_peak_bar': adv_peak_bar,
            }
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=None)
    args = parser.parse_args()
    end_date = END_DATE
    start_date = START_DATE if args.days is None else (end_date - datetime.timedelta(days=args.days))

    fires = load_real_fade_fires(start_date, end_date)
    print(f"Real setup fires in range (ALL setup_types, broadened 2026-09-24): {len(fires)} "
          f"(STOP_HIT={sum(1 for f in fires if f['resolution']=='STOP_HIT')}, "
          f"TARGET_HIT={sum(1 for f in fires if f['resolution']=='TARGET_HIT')})")
    if not fires:
        print("No fires -- nothing to do.")
        return

    fire_idx = 0
    n_fires = len(fires)
    matched = []
    last_feature_row = None

    trade_stream = stream_trades(start_date, end_date)
    bucket_stream = bucketize(trade_stream, GRAIN_TYPE, GRAIN_THRESHOLD, time_cap_seconds=TIME_CAP_SECONDS)
    feature_stream = compute_features(bucket_stream)

    t0 = time.time()
    n_rows_seen = 0
    for row in feature_stream:
        n_rows_seen += 1
        if row['has_full_trailing_window']:
            last_feature_row = row
        # Advance past any fires that are before this row's timestamp with no matching
        # bucket yet available -- shouldn't happen often, but don't silently mismatch.
        while fire_idx < n_fires and fires[fire_idx]['fired_at_et'] <= row['ts_et']:
            fire = fires[fire_idx]
            if last_feature_row is not None:
                matched.append((fire, last_feature_row))
            fire_idx += 1
        if fire_idx >= n_fires:
            break
        if n_rows_seen % 100_000 == 0:
            print(f"  ...{n_rows_seen:,} bucket rows scanned, {fire_idx}/{n_fires} fires matched, "
                  f"peak RSS={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024:.0f}MB, "
                  f"elapsed={time.time()-t0:.0f}s")

    print(f"Matched {len(matched)} / {n_fires} real fires to a feature row "
          f"({n_fires - len(matched)} had no ready bucket yet -- typically very early in the range)")

    print("Resolving trade direction via the canonical inferDirection() (Opus Audit #14 Step 1)...")
    direction_map = get_directions([fire['setup_type'] for fire, _ in matched])
    n_no_dir = sum(1 for fire, _ in matched if direction_map.get(fire['setup_type']) is None)
    print(f"Direction resolved for {len(matched) - n_no_dir}/{len(matched)} rows "
          f"({n_no_dir} setup_types have no inferrable direction)")

    print(f"Fetching bar-level control features ({BAR_CONTROL_WINDOW_MIN}-min price_bars_primary window per fire)...")
    conn = get_connection()
    try:
        bar_control = fetch_bar_control_features(conn, [fire['fired_at_et'] for fire, _ in matched])
    finally:
        conn.close()

    print(f"Computing ordinal reach_R target (Opus Audit #14 section 2.3, RTH-only, H={REACH_R_H_BARS} bars)...")
    conn = get_connection()
    try:
        reach_r_map = compute_reach_r(conn, [fire for fire, _ in matched])
    finally:
        conn.close()
    print(f"reach_R computed for {len(reach_r_map)}/{len(matched)} rows (RTH-only + sufficient forward bars)")

    fieldnames = ['id', 'fired_at_et', 'setup_type', 'resolution', 'label', 'actual_pnl', 'dir',
                  'reach_r', 'reach_r_bucket', 'mae_r', 'fav_peak_bar', 'adv_peak_bar'] \
        + FEATURE_COLS + SIGNED_FEATURE_COLS + BAR_CONTROL_COLS
    with open(OUT_PATH, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for fire, feat in matched:
            direction = direction_map.get(fire['setup_type'])
            dir_num = 1 if direction == 'LONG' else (-1 if direction == 'SHORT' else None)
            reach = reach_r_map.get(fire['id'])
            out = {
                'id': fire['id'],
                'fired_at_et': fire['fired_at_et'].isoformat(),
                'setup_type': fire['setup_type'],
                'resolution': fire['resolution'],
                'label': 1 if fire['resolution'] == 'TARGET_HIT' else 0,
                'actual_pnl': fire['actual_pnl'],
                'dir': dir_num,
                'reach_r': reach['reach_r'] if reach else None,
                'reach_r_bucket': reach['reach_r_bucket'] if reach else None,
                'mae_r': reach['mae_r'] if reach else None,
                'fav_peak_bar': reach['fav_peak_bar'] if reach else None,
                'adv_peak_bar': reach['adv_peak_bar'] if reach else None,
            }
            for col in FEATURE_COLS:
                out[col] = feat.get(col)

            # Direction-signed features (Opus Audit #14 section 2.3) -- null when
            # direction can't be inferred, never silently defaulted to +1.
            if dir_num is not None:
                ofi = feat.get('order_flow_imbalance')
                out['signed_ofi'] = ofi * dir_num if ofi is not None else None
                ofi_div = feat.get('ofi_divergence_short_long')
                out['signed_ofi_divergence_short_long'] = ofi_div * dir_num if ofi_div is not None else None
                for n in WINDOW_SCALES:
                    tofi = feat.get(f'trailing_ofi_mean_{n}')
                    out[f'signed_trailing_ofi_mean_{n}'] = tofi * dir_num if tofi is not None else None
                    eff = feat.get(f'efficiency_ratio_{n}')
                    nms = feat.get(f'net_move_signed_{n}')
                    if eff is not None and nms is not None:
                        market_sign = 1 if nms > 0 else (-1 if nms < 0 else 0)
                        out[f'signed_efficiency_toward_trade_{n}'] = eff * market_sign * dir_num
                    else:
                        out[f'signed_efficiency_toward_trade_{n}'] = None
            else:
                for col in SIGNED_FEATURE_COLS:
                    out[col] = None

            for col in BAR_CONTROL_COLS:
                out[col] = bar_control.get(fire['fired_at_et'], {}).get(col)

            writer.writerow(out)

    print(f"Wrote {len(matched)} rows to {OUT_PATH}")
    print(f"Total elapsed: {time.time()-t0:.1f}s, peak RSS: {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024:.0f}MB")


if __name__ == '__main__':
    main()
