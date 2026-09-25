"""Survival-style target: for each bucket, "how long until price next moves +-K*ATR20
from here" -- replacing the earlier (abandoned) fixed-horizon-return design per DeepSeek's
recommendation, since it naturally covers "a couple minutes to 48 hours" without an
arbitrary horizon grid, and handles "hasn't moved yet" as right-censoring instead of
forcing every row into a fixed-width label.

Two things this module deliberately does NOT decide on its own, because DeepSeek's
review flagged both as real, consequential choices rather than implementation details --
flag to the user, don't silently pick:

1. Clock-time vs trading-time. This uses genuine wall-clock elapsed time between bucket
   timestamps (including the overnight Globex gap and weekends) -- the simpler, more
   conservative option. A trading-time version (excluding the daily maintenance gap and
   weekend closure) would need real session-calendar bookkeeping and is a real, separate
   design choice, not a refinement of this one.
2. K (the move-size threshold, in ATR20 units). Bigger K = fewer real qualifying events
   = a thinner, sparser target with less effective statistical power, even though the
   input tick stream is enormous. summarize_events() reports the real count of realized
   (uncensored) events, not just row count, so that tradeoff is visible, not hidden.

stream_survival_targets() is the memory-bounded version -- built 2026-09-23 after the
original list-based compute_survival_targets() (kept below for small/single-day use)
was chained into a pipeline that tried to hold 6 months of data in memory at once and
crashed the host VM. Because a move can take up to max_horizon_hours to resolve, this
only ever needs to hold that much data in flight (roughly 2 trading days' worth of
buckets at this pilot's grain, not 6 months) -- a `pending` queue bounded by the horizon,
not by the dataset size.
"""
import datetime
from collections import deque

MAX_HORIZON_HOURS = 48


def stream_survival_targets(feature_row_iter, atr_for_date, k_values, max_horizon_hours=MAX_HORIZON_HOURS):
    """feature_row_iter: an iterable (generator) of feature dicts from
    features.compute_features(), needs 'ts_et' and 'close'. atr_for_date: a callable
    atr_for_date(date) -> float or None. k_values: list of K multipliers to resolve
    SIMULTANEOUSLY in one pass over the data (cheaper than one pass per K).

    Yields (feature_row, targets_dict) pairs as each row's targets become fully resolved
    for ALL k_values (either a real event or right-censored) -- NOT necessarily in the
    same order rows were read, since a later row's threshold can be crossed before an
    earlier row's. Caller should write rows to disk as they arrive rather than assume
    order; each yielded row carries its own 'ts_et' for later sorting if needed.

    Memory bound: `pending` holds at most (max_horizon_hours worth of buckets), never the
    whole dataset -- this is the actual fix for the OOM crash, not just "smaller lists."
    """
    max_horizon = datetime.timedelta(hours=max_horizon_hours)
    pending = deque()  # each: dict with row, origin_ts, origin_price, thresholds{k: val}, resolved{k: result}
    last_ts = None

    for row in feature_row_iter:
        current_ts = row['ts_et']
        current_price = row['close']
        last_ts = current_ts

        still_pending = deque()
        for p in pending:
            elapsed = current_ts - p['origin_ts']
            move = current_price - p['origin_price']
            for k in k_values:
                if k in p['resolved']:
                    continue
                threshold = p['thresholds'][k]
                if threshold is None:
                    continue
                if move >= threshold:
                    p['resolved'][k] = {
                        'time_to_event_seconds': elapsed.total_seconds(),
                        'event_direction': 'UP', 'censored': False,
                    }
                elif move <= -threshold:
                    p['resolved'][k] = {
                        'time_to_event_seconds': elapsed.total_seconds(),
                        'event_direction': 'DOWN', 'censored': False,
                    }
                elif elapsed > max_horizon:
                    p['resolved'][k] = {
                        'time_to_event_seconds': max_horizon.total_seconds(),
                        'event_direction': None, 'censored': True,
                    }
            if len(p['resolved']) == len(k_values):
                yield p['row'], p['resolved']
            else:
                still_pending.append(p)
        pending = still_pending

        atr20 = atr_for_date(current_ts.date())
        thresholds = {k: (k * atr20 if atr20 is not None else None) for k in k_values}
        # A row with no ATR available (too early in price_bars_primary's history) can
        # never resolve any k -- resolve it immediately as "unusable" rather than let it
        # sit in `pending` forever consuming memory for no reason.
        if atr20 is None:
            yield row, {k: None for k in k_values}
        else:
            pending.append({
                'row': row, 'origin_ts': current_ts, 'origin_price': current_price,
                'thresholds': thresholds, 'resolved': {},
            })

    # End of stream -- anything still pending is censored using the last real timestamp
    # seen, per the original single-day function's own convention.
    for p in pending:
        elapsed = last_ts - p['origin_ts']
        follow_up = min(elapsed, max_horizon)
        for k in k_values:
            if k not in p['resolved']:
                p['resolved'][k] = {
                    'time_to_event_seconds': follow_up.total_seconds(),
                    'event_direction': None, 'censored': True,
                }
        yield p['row'], p['resolved']


def summarize_stream_events(results_iter, k_values):
    """results_iter: an iterable of (row, targets_dict) pairs from
    stream_survival_targets(). Consumes it fully (for a standalone summary call) --
    the real pipeline should tee this into disk-writing instead of calling both. Real
    event count, not row count, per the effective-N discipline."""
    counts = {k: {'n_rows': 0, 'n_usable': 0, 'n_real_events': 0, 'n_up': 0, 'n_down': 0} for k in k_values}
    for row, targets in results_iter:
        for k in k_values:
            t = targets.get(k)
            counts[k]['n_rows'] += 1
            if t is None:
                continue
            counts[k]['n_usable'] += 1
            if not t['censored']:
                counts[k]['n_real_events'] += 1
                if t['event_direction'] == 'UP':
                    counts[k]['n_up'] += 1
                else:
                    counts[k]['n_down'] += 1
    for k in k_values:
        c = counts[k]
        c['event_rate'] = c['n_real_events'] / c['n_usable'] if c['n_usable'] else 0.0
    return counts


# ---------------------------------------------------------------------------------------
# Original list-based version -- kept for small/single-day ad hoc checks only. Do NOT
# chain this into any multi-week/multi-month pipeline; use stream_survival_targets above.
# ---------------------------------------------------------------------------------------

def compute_survival_targets(feature_rows, atr_for_date, k, max_horizon_hours=MAX_HORIZON_HOURS):
    """feature_rows: a materialized LIST (not a generator) of feature dicts, small/single-
    day use only. atr_for_date: a fixed float OR a callable atr_for_date(date) -> float."""
    atr_lookup = atr_for_date if callable(atr_for_date) else (lambda _d: atr_for_date)
    n = len(feature_rows)
    out = [None] * n
    max_horizon = datetime.timedelta(hours=max_horizon_hours)

    for i in range(n):
        origin_ts = feature_rows[i]['ts_et']
        origin_price = feature_rows[i]['close']
        atr20 = atr_lookup(origin_ts.date())
        if atr20 is None:
            out[i] = None
            continue
        threshold = k * atr20
        event_dir = None
        event_ts = None

        for j in range(i + 1, n):
            future_ts = feature_rows[j]['ts_et']
            if future_ts - origin_ts > max_horizon:
                break
            move = feature_rows[j]['close'] - origin_price
            if move >= threshold:
                event_dir = 'UP'
                event_ts = future_ts
                break
            if move <= -threshold:
                event_dir = 'DOWN'
                event_ts = future_ts
                break

        if event_dir is not None:
            out[i] = {
                'time_to_event_seconds': (event_ts - origin_ts).total_seconds(),
                'event_direction': event_dir,
                'censored': False,
            }
        else:
            last_ts = feature_rows[-1]['ts_et']
            follow_up = min(last_ts - origin_ts, max_horizon)
            out[i] = {
                'time_to_event_seconds': follow_up.total_seconds(),
                'event_direction': None,
                'censored': True,
            }

    return out


def summarize_events(targets):
    """Effective-N reporting -- real event count, not row count. None entries (no ATR20
    available for that origin day) are excluded, not counted as censored."""
    usable = [t for t in targets if t is not None]
    n_total = len(usable)
    n_events = sum(1 for t in usable if not t['censored'])
    n_up = sum(1 for t in usable if t['event_direction'] == 'UP')
    n_down = sum(1 for t in usable if t['event_direction'] == 'DOWN')
    return {
        'n_rows': n_total,
        'n_rows_no_atr': len(targets) - n_total,
        'n_real_events': n_events,
        'n_censored': n_total - n_events,
        'n_up_events': n_up,
        'n_down_events': n_down,
        'event_rate': n_events / n_total if n_total else 0.0,
    }
