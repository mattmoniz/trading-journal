"""Hand-engineered microstructure features over the Stage-1 bucket series (per DeepSeek's
Q5 recommendation: build and validate this BEFORE any self-supervised encoder -- it's the
correct null hypothesis, it's zero new infra, and it's the baseline any learned embedding
would have to beat). Every feature here is trailing-only (computable from bucket i and
earlier) -- no feature may read bucket i+1 or later, since these get fed straight into a
survival model whose whole point is predicting the future from the past.

MULTI-TIMEFRAME, added 2026-09-23 (user's own catch: the feature set was multifaceted --
several different signal types -- but every one of them looked at only a single lookback
window, so the model could see "is flow one-sided right now" but never compare that
against "has it also been one-sided for the last few hours," the way a trader checks a
short chart against a longer one before trusting it). Every trailing stat below is now
computed at SHORT/MEDIUM/LONG window sizes (in bucket counts, not wall-clock time --
consistent with this whole design's point of using volume-triggered buckets so a fixed
bucket COUNT already represents a comparable amount of real trading activity, unlike a
fixed clock-time window would).

Each feature has a plain-English microstructure meaning (per the design's own "auditable,
nameable" requirement) -- see each function's docstring.
"""
from collections import deque
import math

WINDOW_SCALES = {'short': 20, 'medium': 100, 'long': 500}


class _RollingSum:
    """Fixed-length rolling sum with O(1) update -- avoids re-summing the whole window
    on every bucket, which matters once windows get into the hundreds (500-bucket
    realized-vol would otherwise be O(n*500))."""
    def __init__(self, maxlen):
        self.maxlen = maxlen
        self.buf = deque()
        self.total = 0.0

    def add(self, value):
        self.buf.append(value)
        self.total += value
        if len(self.buf) > self.maxlen:
            self.total -= self.buf.popleft()

    @property
    def full(self):
        return len(self.buf) == self.maxlen

    @property
    def mean(self):
        return self.total / len(self.buf) if self.buf else None


def compute_features(buckets, window_scales=None):
    """buckets: an iterable of Bucket objects (bucketize.bucketize() output, typically a
    generator spanning many real days), already in chronological order. A GENERATOR --
    yields one feature dict per bucket as it's consumed, holding only bounded rolling
    state (at most `max(window_scales)` buckets' worth), never the full history. (Was a
    list-returning function that materialized everything at once -- changed 2026-09-23
    after that pattern, chained across this whole pipeline, caused a real WSL VM OOM
    crash on a 6-month run. See build_dataset.py's header for the full incident.)

    window_scales: dict of {name: bucket_count}, default WINDOW_SCALES (short=20,
    medium=100, long=500). 'has_full_trailing_window' is True only once the LARGEST
    scale has enough history -- callers must check it, not treat null as zero. (A row
    could have a full 'short' window while 'medium'/'long' are still None -- those
    fields are individually null until their own window fills, checked separately if a
    caller wants partial-window rows; the pipeline default drops any row where the
    largest scale isn't full yet, matching the original single-window behavior.)
    """
    scales = window_scales or WINDOW_SCALES
    max_window = max(scales.values())

    price_hist = deque(maxlen=max_window + 1)
    ofi_sums = {name: _RollingSum(w) for name, w in scales.items()}
    elapsed_sums = {name: _RollingSum(w) for name, w in scales.items()}
    sq_ret_sums = {name: _RollingSum(w) for name, w in scales.items()}
    abs_ret_sums = {name: _RollingSum(w) for name, w in scales.items()}  # gross path, for efficiency ratio
    ofi_abs_sums = {name: _RollingSum(w) for name, w in scales.items()}  # |OFI|, doesn't cancel in chop
    run_sign = 0
    run_length = 0

    for b in buckets:
        prev_close = price_hist[-1] if price_hist else None
        price_hist.append(b.close)

        # 1. Order-flow imbalance -- already computed per-bucket in Bucket itself.
        ofi = b.order_flow_imbalance
        for name in scales:
            ofi_sums[name].add(ofi)
            ofi_abs_sums[name].add(abs(ofi))  # magnitude -- doesn't cancel to ~0 in two-sided chop
            # the way the signed mean above does (per DeepSeek's Q3 review, 2026-09-23).

        # 2. Trade-arrival intensity -- how long this bucket took to fill. A short
        # elapsed_seconds means trades are arriving fast (active market); a long one
        # (up toward the time cap) means the market is quiet.
        for name in scales:
            elapsed_sums[name].add(b.elapsed_seconds)

        # Single-step squared log return, fed into each scale's rolling sum for
        # realized micro-volatility (sum of squared returns over that window).
        if prev_close is not None and prev_close > 0 and b.close > 0:
            sq_ret = math.log(b.close / prev_close) ** 2
        else:
            sq_ret = 0.0
        for name in scales:
            sq_ret_sums[name].add(sq_ret)

        # Absolute per-bucket price change -- feeds the gross path length used by
        # efficiency ratio below (net move over a window / gross distance traveled to
        # get there). Computed on BUCKET closes deliberately, not raw ticks -- raw-tick
        # gross path is dominated by bid/ask-bounce noise and makes efficiency look near-
        # zero regardless of real trend/chop (found and corrected 2026-09-23 checking
        # this against a real example before trusting it -- see the pilot spec's own
        # "real-data correction" entry).
        abs_ret = abs(b.close - prev_close) if prev_close is not None else 0.0
        for name in scales:
            abs_ret_sums[name].add(abs_ret)

        # 3. Price impact per contract -- how much price moved per unit of volume this
        # bucket. A large move on small volume = thin/fragile liquidity; a large volume
        # with little price move = deep/resilient liquidity (classic Kyle's-lambda-style
        # intuition, computed per-bucket rather than via a full regression for
        # simplicity at this stage). Single-scale -- it's already a per-bucket ratio,
        # not something that benefits from a longer lookback the way a mean/sum does.
        price_impact = (b.price_range / b.volume) if b.volume > 0 else None

        # 4. Same-side run persistence -- consecutive buckets whose order flow leans the
        # same direction (using a sign of OFI with a small deadband so noise doesn't
        # flip the sign every bucket). Single-scale by construction -- it IS a length,
        # not a stat to average over a window.
        sign = 1 if ofi > 0.05 else (-1 if ofi < -0.05 else 0)
        if sign != 0 and sign == run_sign:
            run_length += 1
        elif sign != 0:
            run_sign = sign
            run_length = 1
        else:
            run_length = 0
        same_side_run = run_length if run_sign != 0 else 0

        row = {
            'ts_et': b.end_ts_et,
            'close': b.close,
            'order_flow_imbalance': ofi,
            'elapsed_seconds': b.elapsed_seconds,
            'price_impact_per_contract': price_impact,
            'same_side_run_length': same_side_run,
            'n_trades': b.n_trades,
            'volume': b.volume,
        }
        for name, w in scales.items():
            full = ofi_sums[name].full  # all rolling sums for a scale fill together
            row[f'trailing_ofi_mean_{name}'] = ofi_sums[name].mean if full else None
            row[f'trailing_elapsed_mean_{name}'] = elapsed_sums[name].mean if full else None
            row[f'realized_micro_vol_{name}'] = sq_ret_sums[name].total if full else None
            row[f'ofi_abs_mean_{name}'] = ofi_abs_sums[name].mean if full else None

            # Efficiency ratio: net move over the window / gross bucket-to-bucket path
            # traveled to get there. High (-> 1) = trending/efficient; low (-> 0) = chop
            # (whipsaws back and forth, net displacement small relative to distance
            # covered). Primary trend-strength signal per the user's chosen direction
            # (2026-09-23) -- prioritized over pure chop detection after checking this
            # exact metric against a real example: this morning's real 18-setup fade
            # stopout cluster measured 0.116 (MORE efficient/trending than a same-day
            # quiet contrast window's 0.053), confirming it was a real trend running
            # through fade levels, not chop.
            if full and len(price_hist) > w:
                window_start_price = price_hist[-(w + 1)]
                net_move_signed = b.close - window_start_price  # market-signed (raw), NOT
                # yet by trade direction -- a consumer multiplies by its own dir (+1
                # long/-1 short) to get "was the trend running toward or away from this
                # trade" (Opus Audit #14 section 2.3: "efficiency_ratio_* (uses
                # abs(net_move)) -- keep unsigned AND add a signed-toward-the-trade
                # version"). Reuses the SAME window_start_price/gross_path this function
                # already computes for efficiency_ratio -- just keeps the sign.
                net_move = abs(net_move_signed)
                gross_path = abs_ret_sums[name].total
                row[f'efficiency_ratio_{name}'] = (net_move / gross_path) if gross_path > 0 else None
                row[f'net_move_signed_{name}'] = net_move_signed
            else:
                row[f'efficiency_ratio_{name}'] = None
                row[f'net_move_signed_{name}'] = None

        # Cross-scale divergence -- "is the recent read diverging from the backdrop,"
        # per DeepSeek's Q3 review: a depth-5 tree barely forms this interaction on its
        # own from the raw per-scale columns, so it's fed explicitly.
        row['has_full_trailing_window'] = ofi_sums[max(scales, key=lambda n: scales[n])].full
        if row['has_full_trailing_window']:
            row['ofi_divergence_short_long'] = row['trailing_ofi_mean_short'] - row['trailing_ofi_mean_long']
            row['vol_divergence_short_long'] = row['realized_micro_vol_short'] - row['realized_micro_vol_long']
            row['pace_divergence_short_long'] = row['trailing_elapsed_mean_short'] - row['trailing_elapsed_mean_long']
        else:
            row['ofi_divergence_short_long'] = None
            row['vol_divergence_short_long'] = None
            row['pace_divergence_short_long'] = None

        yield row
