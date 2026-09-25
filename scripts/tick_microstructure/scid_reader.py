"""Canonical Sierra Chart .scid tick reader — single source of truth.

Extracted 2026-09-23 per DeepSeek design review (scratch/deepseek_response.md, the
6-month tick-microstructure pilot review): two existing scripts
(scripts/backtest_mnq_structural_trailing.py, scripts/backtest_poc_realtick_convergence_pilot.py)
each hand-rolled their own partial .scid parsing loop. Neither correctly handled the
unbundled-sub-trade sentinel (see below) -- this module is the first correct,
shared implementation, not a third copy.

Format confirmed via Sierra Chart's own documentation (sierrachart.com/index.php?page=doc/
IntradayDataFileFormat.php), NOT guessed, per this codebase's standing "do not guess on
Sierra Chart specifics" rule -- and cross-checked by directly parsing real bytes from
NQU6.CME.scid before trusting any of this.

Record layout (40 bytes, little-endian): DateTime(int64 microseconds since 1899-12-30
UTC), Open(float32), High(float32), Low(float32), Close(float32), NumTrades(uint32),
TotalVolume(uint32), BidVolume(uint32), AskVolume(uint32).

For a genuine single-trade tick record (this codebase's data is tick-level throughout,
not time-aggregated): Open == 0.0 marks SINGLE_TRADE_WITH_BID_ASK -- High holds the ask
price, Low holds the bid price, Close holds the actual trade price. TWO special sentinel
values in Open (FIRST_SUB_TRADE_OF_UNBUNDLED_TRADE = -1.99900095e+37,
LAST_SUB_TRADE_OF_UNBUNDLED_TRADE = -1.99900197e+37) mark a single real exchange trade
that Sierra Chart split into multiple sub-records -- these must be merged back into ONE
logical trade (summed volume) before any trade-size or trade-count feature is computed,
or a large trade silently inflates NumTrades/undercounts true size per fill.

Timestamps are UTC (confirmed against docs and against
backtest_mnq_structural_trailing.py's own header, which documents a real, previously
shipped bug: an earlier script assumed a fixed UTC-4 offset and silently broke every
winter when the real ET offset is UTC-5). This module always does real IANA timezone
conversion via zoneinfo (DST-correct automatically) -- never a hardcoded offset.
"""
import struct
import datetime
from zoneinfo import ZoneInfo
from dataclasses import dataclass

UTC = ZoneInfo('UTC')
ET = ZoneInfo('America/New_York')
SCID_EPOCH = datetime.datetime(1899, 12, 30, tzinfo=UTC)

# Raw .scid price fields are NQ points x 100 -- verified empirically 2026-09-23, not
# assumed: NQU6.CME.scid's raw Close at 2026-09-10 14:30:00.000 ET was 2915775.0, and
# price_bars_primary's real bar at that exact same timestamp shows open=29157.7500 --
# an exact 100x match. Every raw price field must be divided by this before use.
SCID_PRICE_SCALE = 100.0

# Sierra Chart's own documented sentinel values -- see this module's docstring for the
# source. Compared with a tolerance since these are float32-round-tripped-through-struct.
FIRST_SUB_TRADE = -1.99900095e+37
LAST_SUB_TRADE = -1.99900197e+37
_SENTINEL_TOL = 1e30  # anything more negative than -1e30 is a sentinel, not a real price

RECORD_STRUCT = struct.Struct('<qffffIIII')
RECORD_SIZE = 40


@dataclass
class Trade:
    ts_utc: datetime.datetime   # real UTC instant
    ts_et: datetime.datetime    # same instant, converted via zoneinfo (DST-correct)
    price: float
    size: int          # TotalVolume, already merged across unbundled sub-trades
    num_sub_trades: int  # how many raw .scid records this logical trade merged from
    aggressor: str      # 'BUY' (hit the ask) / 'SELL' (hit the bid) / 'UNKNOWN'


def _to_et(dt_utc):
    return dt_utc.astimezone(ET)


_TS_STRUCT = struct.Struct('<q')  # just the 8-byte timestamp field of a record


def _record_ts_utc(f, header_size, idx):
    f.seek(header_size + idx * RECORD_SIZE)
    dt_us = _TS_STRUCT.unpack(f.read(8))[0]
    return SCID_EPOCH + datetime.timedelta(microseconds=dt_us)


def _seek_index_for_date(f, header_size, n_records, start_date):
    """Binary search over record index for the first record whose ET date is >=
    start_date. Records are monotonically non-decreasing in timestamp (an append-only
    trade log), so this is a valid binary search. Errs conservative (a few records
    early rather than late) -- the caller's own per-record date filter is the real
    correctness boundary, this is purely a speed optimization so a query for a date
    near the end of a multi-month file doesn't have to linearly scan everything before
    it."""
    lo, hi = 0, n_records
    while lo < hi:
        mid = (lo + hi) // 2
        ts = _record_ts_utc(f, header_size, mid)
        if _to_et(ts).date() < start_date:
            lo = mid + 1
        else:
            hi = mid
    return max(0, lo - 1000)  # back off a bit; the linear date filter handles precision


def _raw_records(filepath, start_date=None):
    """Yields raw (dt_utc, open, high, low, close, num_trades, total_vol, bid_vol,
    ask_vol) tuples. Reads the ACTUAL header_size field (bytes 4:8) rather than
    assuming a fixed 56-byte header -- matches backtest_mnq_structural_trailing.py's
    already-correct pattern, not a guess. If start_date is given, binary-searches to a
    nearby byte offset first instead of scanning from the beginning of the file --
    matters a lot once files span many months (this codebase's NQ contract files are
    ~1.2-2GB / 25-30M records each)."""
    with open(filepath, 'rb') as f:
        header = f.read(56)
        if len(header) < 56:
            return
        header_size = struct.unpack('<I', header[4:8])[0]
        if start_date is not None:
            file_size = f.seek(0, 2)
            n_records = (file_size - header_size) // RECORD_SIZE
            start_idx = _seek_index_for_date(f, header_size, n_records, start_date)
            f.seek(header_size + start_idx * RECORD_SIZE)
        else:
            f.seek(header_size)
        chunk_records = 200_000
        chunk_bytes = chunk_records * RECORD_SIZE
        while True:
            chunk = f.read(chunk_bytes)
            if not chunk:
                return
            n = len(chunk) // RECORD_SIZE
            for dt_us, o, h, l, c, numtr, totvol, bidvol, askvol in RECORD_STRUCT.iter_unpack(chunk[:n * RECORD_SIZE]):
                dt_utc = SCID_EPOCH + datetime.timedelta(microseconds=dt_us)
                yield dt_utc, o, h, l, c, numtr, totvol, bidvol, askvol


def read_ticks(filepath, start_date=None, end_date=None):
    """Yields Trade objects, one per real logical trade -- unbundled sub-trades already
    merged, timestamps already ET-converted. start_date/end_date (datetime.date, ET-based)
    optionally bound the scan without loading the whole file into memory first.

    Any record whose Open is neither 0.0 nor a known sentinel is a real anomaly (this
    codebase's data is confirmed tick-level throughout, so this should not occur) --
    counted and raised at the end rather than silently skipped, per the standing
    "do not guess/do not silently swallow anomalies" discipline.
    """
    pending_unbundled = None  # accumulates size across FIRST_SUB_TRADE...LAST_SUB_TRADE
    unknown_open_count = 0

    for dt_utc, o, h, l, c, numtr, totvol, bidvol, askvol in _raw_records(filepath, start_date=start_date):
        ts_et = _to_et(dt_utc)
        if start_date is not None and ts_et.date() < start_date:
            continue
        if end_date is not None and ts_et.date() > end_date:
            break

        aggressor = 'BUY' if askvol > bidvol else ('SELL' if bidvol > askvol else 'UNKNOWN')

        if o == 0.0:
            # Ordinary single trade -- Close is the trade price.
            if pending_unbundled is not None:
                # A FIRST_SUB_TRADE with no matching LAST_SUB_TRADE before a normal
                # record is itself an anomaly -- flush what we have rather than drop it.
                yield pending_unbundled
                pending_unbundled = None
            yield Trade(dt_utc, ts_et, c / SCID_PRICE_SCALE, totvol, 1, aggressor)

        elif abs(o - FIRST_SUB_TRADE) < _SENTINEL_TOL:
            pending_unbundled = Trade(dt_utc, ts_et, c / SCID_PRICE_SCALE, totvol, 1, aggressor)

        elif abs(o - LAST_SUB_TRADE) < _SENTINEL_TOL:
            if pending_unbundled is not None:
                pending_unbundled.size += totvol
                pending_unbundled.num_sub_trades += 1
                # Aggressor/price of the merged logical trade: keep the FIRST sub-trade's
                # price/side (the trade that actually initiated it), matching the
                # convention this codebase already uses elsewhere for "which side started
                # this" rather than re-deriving a new rule here.
                yield pending_unbundled
                pending_unbundled = None
            else:
                # LAST with no FIRST seen -- anomaly, emit standalone rather than drop.
                yield Trade(dt_utc, ts_et, c / SCID_PRICE_SCALE, totvol, 1, aggressor)
        else:
            unknown_open_count += 1

    if pending_unbundled is not None:
        yield pending_unbundled

    if unknown_open_count > 0:
        raise ValueError(
            f"{filepath}: {unknown_open_count} records had an Open value that was "
            f"neither 0.0 nor a known unbundled-trade sentinel -- this data was assumed "
            f"tick-level throughout; investigate before trusting any output from this file."
        )
