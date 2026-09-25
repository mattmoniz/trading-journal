"""Event-triggered (volume/trade-count) bucketing of a Trade stream into an order-flow
micro-series -- Stage 1 of the tick-microstructure pilot (docs/OPEN_THREADS.md 2026-09-23
entry has the full design; see scratch/deepseek_response.md for the review this
implements). Fixed wall-clock bucketing was rejected: the order-flow-imbalance feature
is a per-trade +1/-1 signal, and a thin bucket (a handful of trades during quiet Globex
hours) makes it nearly meaningless -- an event-triggered bucket keeps the amount of real
market activity per bucket roughly constant instead.

A hard time cap force-closes a bucket that's been open too long (the overnight dead
zone can otherwise leave one bucket "open" for hours) -- per the design review.
"""
from dataclasses import dataclass, field


@dataclass
class Bucket:
    start_ts_et: object
    end_ts_et: object = None
    n_trades: int = 0
    volume: int = 0
    buy_volume: int = 0
    sell_volume: int = 0
    open: float = None
    high: float = float('-inf')
    low: float = float('inf')
    close: float = None
    n_unbundled_merges: int = 0
    closed_reason: str = None  # 'threshold' or 'time_cap'

    def add(self, trade):
        if self.open is None:
            self.open = trade.price
        self.high = max(self.high, trade.price)
        self.low = min(self.low, trade.price)
        self.close = trade.price
        self.n_trades += 1
        self.volume += trade.size
        if trade.aggressor == 'BUY':
            self.buy_volume += trade.size
        elif trade.aggressor == 'SELL':
            self.sell_volume += trade.size
        if trade.num_sub_trades > 1:
            self.n_unbundled_merges += 1
        self.end_ts_et = trade.ts_et

    @property
    def elapsed_seconds(self):
        return (self.end_ts_et - self.start_ts_et).total_seconds()

    @property
    def order_flow_imbalance(self):
        denom = self.buy_volume + self.sell_volume
        return (self.buy_volume - self.sell_volume) / denom if denom > 0 else 0.0

    @property
    def price_range(self):
        return self.high - self.low

    def as_dict(self):
        return {
            'start_ts_et': self.start_ts_et, 'end_ts_et': self.end_ts_et,
            'elapsed_seconds': self.elapsed_seconds, 'n_trades': self.n_trades,
            'volume': self.volume, 'buy_volume': self.buy_volume,
            'sell_volume': self.sell_volume, 'order_flow_imbalance': self.order_flow_imbalance,
            'open': self.open, 'high': self.high, 'low': self.low, 'close': self.close,
            'price_range': self.price_range, 'n_unbundled_merges': self.n_unbundled_merges,
            'closed_reason': self.closed_reason,
        }


def bucketize(trades, grain_type, threshold, time_cap_seconds=60):
    """grain_type: 'volume' (cumulative TotalVolume) or 'trades' (cumulative trade count)
    or 'fixed_time' (threshold is ignored, time_cap_seconds IS the bucket width -- the
    naive reproducible control). Yields Bucket objects, oldest first."""
    bucket = None
    for trade in trades:
        if bucket is None:
            bucket = Bucket(start_ts_et=trade.ts_et)

        # Time-cap check BEFORE adding, so a huge overnight gap doesn't get silently
        # absorbed into one bucket spanning hours.
        if bucket.n_trades > 0 and (trade.ts_et - bucket.start_ts_et).total_seconds() >= time_cap_seconds:
            bucket.closed_reason = 'time_cap'
            yield bucket
            bucket = Bucket(start_ts_et=trade.ts_et)

        bucket.add(trade)

        if grain_type == 'fixed_time':
            if bucket.elapsed_seconds >= time_cap_seconds:
                bucket.closed_reason = 'threshold'
                yield bucket
                bucket = None
        elif grain_type == 'volume':
            if bucket.volume >= threshold:
                bucket.closed_reason = 'threshold'
                yield bucket
                bucket = None
        elif grain_type == 'trades':
            if bucket.n_trades >= threshold:
                bucket.closed_reason = 'threshold'
                yield bucket
                bucket = None
        else:
            raise ValueError(f"unknown grain_type: {grain_type}")

    if bucket is not None and bucket.n_trades > 0:
        bucket.closed_reason = 'end_of_stream'
        yield bucket
