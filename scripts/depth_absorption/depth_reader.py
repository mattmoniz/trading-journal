"""Canonical Sierra Chart .depth market-depth reader.

Format confirmed via Sierra Chart's own documentation (sierrachart.com,
MarketDepthDataFileFormat page) plus direct byte-level verification against real files
in this repo, 2026-09-23 -- not guessed, per this codebase's standing "do not guess on
Sierra Chart specifics" rule.

Header (verified 64 bytes, empirically -- matches offset-4 header_size field): 4-byte
magic "SCDD", then header_size(u32), record_size(u32), version(u32), rest reserved/zero.

Record (24 bytes, matches Sierra Chart's documented s_MarketDepthFileRecord exactly):
  DateTime(int64, microseconds since 1899-12-30 UTC), Command(u8), Flags(u8),
  NumOrders(u16), Price(f32), Quantity(u32), Reserved(u32).

Commands: NO_COMMAND=0, CLEAR_BOOK=1, ADD_BID=2, ADD_ASK=3, MODIFY_BID=4, MODIFY_ASK=5,
DELETE_BID=6, DELETE_ASK=7. Flags: FLAG_END_OF_BATCH=0x01.

Price scale: same 100x factor as .scid, verified empirically 2026-09-23 (a real bid
level at 2026-09-22 00:00:00.001 ET read 3085150.0 raw -> 30851.50 real points, sitting
correctly just below that exact minute's real bar price of 30872.75 from
price_bars_primary). Reuses scid_reader.py's SCID_PRICE_SCALE constant, not a second
copy of the same number.

.depth files are organized ONE FILE PER CONTRACT PER DAY (e.g. "NQZ6.CME.2026-09-22.depth"),
unlike .scid's one-file-per-contract-lifetime -- a real full order-book snapshot is
written at the start of the file (and every 10 minutes thereafter per Sierra Chart's own
docs) via CLEAR_BOOK + a batch of ADD_BID/ADD_ASK records terminated by FLAG_END_OF_BATCH.
"""
import struct
import datetime
import sys
import os
from zoneinfo import ZoneInfo
from dataclasses import dataclass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tick_microstructure'))
from scid_reader import SCID_PRICE_SCALE

UTC = ZoneInfo('UTC')
ET = ZoneInfo('America/New_York')
DEPTH_EPOCH = datetime.datetime(1899, 12, 30, tzinfo=UTC)

CLEAR_BOOK = 1
ADD_BID = 2
ADD_ASK = 3
MODIFY_BID = 4
MODIFY_ASK = 5
DELETE_BID = 6
DELETE_ASK = 7
FLAG_END_OF_BATCH = 0x01

RECORD_STRUCT = struct.Struct('<qBBHfII')
RECORD_SIZE = 24


@dataclass
class DepthRecord:
    ts_utc: datetime.datetime
    ts_et: datetime.datetime
    command: int
    flags: int
    num_orders: int
    price: float  # already divided by SCID_PRICE_SCALE -- real NQ points
    quantity: int


def read_depth_records(filepath):
    """Yields DepthRecord objects in file order (already chronological)."""
    with open(filepath, 'rb') as f:
        header = f.read(16)
        magic, header_size, record_size, version = struct.unpack('<4sIII', header)
        if magic != b'SCDD':
            raise ValueError(f"{filepath}: unexpected magic {magic!r}, expected b'SCDD' -- format assumption may be wrong")
        if record_size != RECORD_SIZE:
            raise ValueError(f"{filepath}: record_size={record_size}, expected {RECORD_SIZE} -- format assumption may be wrong")
        f.seek(header_size)
        while True:
            chunk = f.read(RECORD_SIZE * 50_000)
            if not chunk:
                return
            n = len(chunk) // RECORD_SIZE
            for dt_us, cmd, flags, numorders, price, qty, _reserved in RECORD_STRUCT.iter_unpack(chunk[:n * RECORD_SIZE]):
                dt_utc = DEPTH_EPOCH + datetime.timedelta(microseconds=dt_us)
                yield DepthRecord(
                    ts_utc=dt_utc, ts_et=dt_utc.astimezone(ET), command=cmd, flags=flags,
                    num_orders=numorders, price=price / SCID_PRICE_SCALE, quantity=qty,
                )


class OrderBook:
    """Maintains live bid/ask levels {price: (quantity, num_orders)} by replaying
    DepthRecord commands in order. This is the "resync-anchored replay" pattern DeepSeek
    recommended: a CLEAR_BOOK wipes state cleanly (matches Sierra Chart's own 10-minute
    resnapshot cadence), so any single corrupted/missed command's damage is bounded to
    at most one snapshot interval, never the whole session.

    CRITICAL, found 2026-09-23 via a hand-traced validation mismatch: a CLEAR_BOOK is
    immediately followed by a BATCH of ADD_BID/ADD_ASK records (often dozens, all at the
    same timestamp) that together rebuild the full snapshot -- terminated by a record
    with Flags & FLAG_END_OF_BATCH set. Applying each record in that batch directly and
    exposing best_bid()/best_ask() mid-batch means any check made during a rebuild sees a
    HALF-REBUILT book (e.g. some bid levels restored, no ask side yet at all) -- this is
    exactly what caused an apparent ~11-22% top-of-book mismatch rate against real .scid
    trades before this fix. The batch must be applied atomically: buffer it, commit only
    once FLAG_END_OF_BATCH is seen, so a query either sees the complete OLD book or the
    complete NEW one, never a partial state."""

    def __init__(self):
        self.bids = {}  # price -> (quantity, num_orders)
        self.asks = {}
        self._in_batch = False
        self._batch_bids = None
        self._batch_asks = None

    def apply(self, rec: DepthRecord):
        if rec.command == CLEAR_BOOK:
            # Start (or restart) a buffered rebuild -- don't touch the live book yet.
            self._in_batch = True
            self._batch_bids = {}
            self._batch_asks = {}
        elif self._in_batch:
            self._apply_to(self._batch_bids, self._batch_asks, rec)
            if rec.flags & FLAG_END_OF_BATCH:
                # Commit atomically -- the live book jumps straight from old to new.
                self.bids = self._batch_bids
                self.asks = self._batch_asks
                self._in_batch = False
                self._batch_bids = None
                self._batch_asks = None
        else:
            self._apply_to(self.bids, self.asks, rec)

    @staticmethod
    def _apply_to(bids, asks, rec: DepthRecord):
        # Fix, 2026-09-23, per DeepSeek code review: a MODIFY down to quantity==0 must be
        # treated as a removal, not stored as a zero-size level. Sierra Chart's own docs
        # don't guarantee the feed always sends a formal DELETE for depletion -- a
        # zero-qty level left in the dict was silently winning max()/min() in
        # best_bid()/best_ask() below, producing a real, wrong (widened) top-of-book.
        if rec.command in (ADD_BID, MODIFY_BID):
            if rec.quantity > 0:
                bids[rec.price] = (rec.quantity, rec.num_orders)
            else:
                bids.pop(rec.price, None)
        elif rec.command in (ADD_ASK, MODIFY_ASK):
            if rec.quantity > 0:
                asks[rec.price] = (rec.quantity, rec.num_orders)
            else:
                asks.pop(rec.price, None)
        elif rec.command == DELETE_BID:
            bids.pop(rec.price, None)
        elif rec.command == DELETE_ASK:
            asks.pop(rec.price, None)

    def best_bid(self):
        # Defensive filter, kept even with the zero-qty fix above -- best_bid()/best_ask()
        # must never trust a stale zero-size key regardless of how it got there.
        live = [p for p, (qty, _n) in self.bids.items() if qty > 0]
        return max(live) if live else None

    def best_ask(self):
        live = [p for p, (qty, _n) in self.asks.items() if qty > 0]
        return min(live) if live else None
