"""Opus Audit #14 (2026-09-24) section 4.2 -- the one bounded (<=2h), decisive diagnostic
recommended before permanently parking Track C: split reconstruct_and_validate.py's
mismatch rate by whether each trade happened in a QUIET moment (>=1s since the last depth
update on either side, in an otherwise flat market) vs. a BUSY moment.

Logic per the audit: "if quiet moments match cleanly, parsing/scaling/semantics are fine and
the remaining error is cross-stream ordering [between two independently timestamped feeds,
which can't be eliminated by construction]. If quiet moments ALSO mismatch, something basic
is wrong" (a real parsing/scaling/semantics bug, not just ordering ambiguity).

This is a read-only diagnostic -- reuses reconstruct_and_validate.py's exact book-building
logic verbatim (same '<' merge rule, same OrderBook), just buckets the output by quietness
instead of reporting one aggregate number.
"""
import sys
import os
import datetime
import struct
import statistics

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tick_microstructure'))
from depth_reader import read_depth_records, OrderBook
from scid_reader import SCID_EPOCH, ET, SCID_PRICE_SCALE

DEPTH_DIR = '/mnt/c/SierraChart/Data/MarketDepthData'
SCID_DIR = '/mnt/c/SierraChart/Data'
TICK_SIZE = 0.25
QUIET_THRESHOLD_SEC = 1.0


def run(contract, date_str):
    depth_path = os.path.join(DEPTH_DIR, f'{contract}.{date_str}.depth')
    scid_path = os.path.join(SCID_DIR, f'{contract}.scid')
    target_date = datetime.date.fromisoformat(date_str)

    trade_checks = []
    with open(scid_path, 'rb') as f:
        header = f.read(56)
        header_size = struct.unpack('<I', header[4:8])[0]
        f.seek(header_size)
        rec_struct = struct.Struct('<qffffIIII')
        chunk_size = rec_struct.size * 100_000
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            n = len(chunk) // rec_struct.size
            for dt_us, o, h, l, c, numtr, totvol, bidvol, askvol in rec_struct.iter_unpack(chunk[:n * rec_struct.size]):
                if o != 0.0:
                    continue
                dt_utc = SCID_EPOCH + datetime.timedelta(microseconds=dt_us)
                ts_et = dt_utc.astimezone(ET)
                if ts_et.date() != target_date:
                    if ts_et.date() > target_date:
                        break
                    continue
                trade_checks.append({
                    'ts_et': ts_et,
                    'recorded_ask': h / SCID_PRICE_SCALE,
                    'recorded_bid': l / SCID_PRICE_SCALE,
                    'aggressor': 'BUY' if askvol > bidvol else ('SELL' if bidvol > askvol else 'UNKNOWN'),
                })
            else:
                continue
            break

    if not trade_checks:
        return {'error': f'no real trades found for {date_str}'}

    book = OrderBook()
    depth_iter = read_depth_records(depth_path)
    current_rec = next(depth_iter, None)
    last_applied_ts = None

    buckets = {'QUIET': {'n': 0, 'bid_ok': 0, 'ask_ok': 0}, 'BUSY': {'n': 0, 'bid_ok': 0, 'ask_ok': 0}}

    for tc in trade_checks:
        while current_rec is not None and current_rec.ts_et < tc['ts_et']:
            book.apply(current_rec)
            last_applied_ts = current_rec.ts_et
            current_rec = next(depth_iter, None)
        bb, ba = book.best_bid(), book.best_ask()
        if bb is None or ba is None:
            continue

        quiet = (
            last_applied_ts is not None
            and (tc['ts_et'] - last_applied_ts).total_seconds() >= QUIET_THRESHOLD_SEC
            and (current_rec is None or (current_rec.ts_et - tc['ts_et']).total_seconds() >= QUIET_THRESHOLD_SEC)
        )
        key = 'QUIET' if quiet else 'BUSY'
        buckets[key]['n'] += 1
        if abs(bb - tc['recorded_bid']) <= TICK_SIZE:
            buckets[key]['bid_ok'] += 1
        if abs(ba - tc['recorded_ask']) <= TICK_SIZE:
            buckets[key]['ask_ok'] += 1

    result = {'date': date_str, 'contract': contract, 'quiet_threshold_sec': QUIET_THRESHOLD_SEC}
    for key, b in buckets.items():
        result[key] = {
            'n': b['n'],
            'bid_match_rate': round(b['bid_ok'] / b['n'], 4) if b['n'] else None,
            'ask_match_rate': round(b['ask_ok'] / b['n'], 4) if b['n'] else None,
            'mismatch_rate': round(1 - min(b['bid_ok'], b['ask_ok']) / b['n'], 4) if b['n'] else None,
        }
    return result


if __name__ == '__main__':
    import json
    contract = sys.argv[1] if len(sys.argv) > 1 else 'NQZ6.CME'
    date_str = sys.argv[2] if len(sys.argv) > 2 else '2026-09-22'
    print(json.dumps(run(contract, date_str), indent=2))
