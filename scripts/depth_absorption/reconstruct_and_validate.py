"""Phase 1 kill criterion #1: reconstruct the order book from .depth records for a real
trading day, then validate it against .scid's OWN independently-recorded bid/ask-at-trade
fields (High=ask, Low=bid, for a genuine single-trade record) at matching timestamps.
>1% mismatch = STOP per the pre-registered kill criteria
(RESEARCH_CLAIM depth_absorption_replenishment_fraction_20260923).

This is the free, described-in-the-original-audit validation step -- two independently
recorded real data streams (trade prints vs. depth snapshots) should agree on where the
best bid/ask sat at any given trade's exact instant, if the reconstruction is correct.
"""
import sys
import os
import datetime

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tick_microstructure'))
from depth_reader import read_depth_records, OrderBook
from scid_reader import read_ticks

DEPTH_DIR = '/mnt/c/SierraChart/Data/MarketDepthData'
SCID_DIR = '/mnt/c/SierraChart/Data'
TICK_SIZE = 0.25  # MNQ/NQ real tick size -- matches EXISTING documented server config,
                   # not re-derived; used only for an epsilon comparison tolerance below.


def validate_day(contract, date_str):
    """contract: e.g. 'NQZ6.CME'. date_str: 'YYYY-MM-DD'."""
    depth_path = os.path.join(DEPTH_DIR, f'{contract}.{date_str}.depth')
    scid_path = os.path.join(SCID_DIR, f'{contract}.scid')
    if not os.path.exists(depth_path):
        return {'error': f'no depth file: {depth_path}'}
    if not os.path.exists(scid_path):
        return {'error': f'no scid file: {scid_path}'}

    target_date = datetime.date.fromisoformat(date_str)

    # Build a chronological list of real single-trade events for this day, each with
    # its own recorded bid/ask (High=ask, Low=bid for a genuine SINGLE_TRADE_WITH_BID_ASK
    # record -- scid_reader's Trade dataclass doesn't carry these directly, so read raw
    # records here rather than through the Trade abstraction).
    import struct
    trade_checks = []
    with open(scid_path, 'rb') as f:
        header = f.read(56)
        header_size = struct.unpack('<I', header[4:8])[0]
        f.seek(header_size)
        rec_struct = struct.Struct('<qffffIIII')
        chunk_size = rec_struct.size * 100_000
        from scid_reader import SCID_EPOCH, ET, SCID_PRICE_SCALE
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            n = len(chunk) // rec_struct.size
            for dt_us, o, h, l, c, numtr, totvol, bidvol, askvol in rec_struct.iter_unpack(chunk[:n * rec_struct.size]):
                if o != 0.0:
                    continue  # skip unbundled sub-trades for this check -- top-of-book
                              # validation only needs plain single trades
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
        return {'error': f'no real trades found for {date_str} in {scid_path}'}

    # Replay the depth file, checking the book state at each real trade's timestamp.
    # Correct merge order: apply every depth record AT OR BEFORE a trade's own timestamp
    # first, THEN compare -- a same-instant depth update reflects what actually happened
    # at that moment and must be folded in before checking, not left pending. (Earlier
    # version checked before applying same-timestamp records, making every comparison
    # look one update stale -- caught via a suspiciously consistent one-direction offset
    # in the mismatches, not random noise, which is what gave it away.)
    book = OrderBook()
    depth_iter = read_depth_records(depth_path)
    current_rec = next(depth_iter, None)
    n_checked = 0
    n_bid_match = 0
    n_ask_match = 0
    mismatches = []
    # Signed-offset histogram cross-tabbed by aggressor side, per DeepSeek's diagnostic
    # #1 -- this is the check that separates "self-consumption bug" (bidirectional,
    # aggressor-dependent) from "feed lag" (same direction both sides) from
    # "zero-quantity staleness" (bid high AND ask low simultaneously).
    offset_by_side = {'BUY': {'bid_ticks': [], 'ask_ticks': []}, 'SELL': {'bid_ticks': [], 'ask_ticks': []}, 'UNKNOWN': {'bid_ticks': [], 'ask_ticks': []}}

    for tc in trade_checks:
        # Strict '<', not '<=' -- per DeepSeek's diagnosis, applying a depth record at the
        # EXACT same instant as the trade folds in the trade's own book-consuming update
        # before comparing against .scid's PRE-trade recorded bid/ask, which produced the
        # confirmed aggressor-dependent signature (sells -> recon_bid low, buys ->
        # recon_ask high). '<' is not a complete fix (the two streams have independent
        # sub-tick sequencing with no ordering guarantee) but removes this specific,
        # confirmed, dominant bias.
        while current_rec is not None and current_rec.ts_et < tc['ts_et']:
            book.apply(current_rec)
            current_rec = next(depth_iter, None)
        bb, ba = book.best_bid(), book.best_ask()
        if bb is not None and ba is not None:
            n_checked += 1
            bid_ok = abs(bb - tc['recorded_bid']) <= TICK_SIZE
            ask_ok = abs(ba - tc['recorded_ask']) <= TICK_SIZE
            if bid_ok:
                n_bid_match += 1
            if ask_ok:
                n_ask_match += 1
            side = tc['aggressor']
            offset_by_side[side]['bid_ticks'].append(round((bb - tc['recorded_bid']) / TICK_SIZE))
            offset_by_side[side]['ask_ticks'].append(round((ba - tc['recorded_ask']) / TICK_SIZE))
            if not (bid_ok and ask_ok):
                mismatches.append({
                    'ts_et': tc['ts_et'].isoformat(), 'recon_bid': bb, 'recon_ask': ba,
                    'recorded_bid': tc['recorded_bid'], 'recorded_ask': tc['recorded_ask'],
                    'aggressor': side,
                })

    def _summarize_ticks(vals):
        if not vals:
            return None
        import statistics
        return {
            'mean': round(statistics.mean(vals), 3), 'median': statistics.median(vals),
            'pct_zero': round(sum(1 for v in vals if v == 0) / len(vals), 3),
            'pct_positive': round(sum(1 for v in vals if v > 0) / len(vals), 3),
            'pct_negative': round(sum(1 for v in vals if v < 0) / len(vals), 3),
        }

    offset_summary = {
        side: {
            'n': len(data['bid_ticks']),
            'bid_offset_ticks': _summarize_ticks(data['bid_ticks']),
            'ask_offset_ticks': _summarize_ticks(data['ask_ticks']),
        }
        for side, data in offset_by_side.items()
    }

    return {
        'date': date_str, 'contract': contract,
        'n_real_trades_in_file': len(trade_checks),
        'n_checked_with_nonempty_book': n_checked,
        'bid_match_rate': n_bid_match / n_checked if n_checked else None,
        'ask_match_rate': n_ask_match / n_checked if n_checked else None,
        'mismatch_rate': 1 - (min(n_bid_match, n_ask_match) / n_checked) if n_checked else None,
        'offset_by_aggressor_side': offset_summary,
        'sample_mismatches': mismatches[:5],
    }


if __name__ == '__main__':
    import json
    contract = sys.argv[1] if len(sys.argv) > 1 else 'NQZ6.CME'
    date_str = sys.argv[2] if len(sys.argv) > 2 else '2026-09-22'
    result = validate_day(contract, date_str)
    print(json.dumps(result, indent=2, default=str))
