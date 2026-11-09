"""Per-minute UP-TICK and DOWN-TICK volume exactly as Sierra Chart's 'Cumulative Delta Bars - Up/Down Tick Volume' study defines them (docs: sierrachart.com StudiesReference ID=323, fetched 2026-11-04):
uptick volume = volume that traded at a HIGHER price than the previous trade, downtick = at a LOWER price; an unchanged price takes the classification of the previous non-unchanged trade. Classification is by TRADE PRICE, not bid/ask (this differs from ask-minus-bid delta, which is the bid_volume / ask_volume columns of price_bars_primary).
The previous-trade state is carried across minutes and days of the file. The first trade after the start of the scan has no previous price and is left unclassified.
Usage: python3 updown_tick_delta.py <file.scid> <start YYYY-MM-DD ET> <end YYYY-MM-DD ET> <out.csv> [price_scale]
Output columns: ts (ET minute), up_vol, down_vol, unclassified_vol, volume, close."""
import sys, csv, datetime
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/tick_microstructure')
from scid_reader import read_ticks, SCID_PRICE_SCALE

def minute_updown(filepath, start, end, price_scale=1.0):
    """Yield one dict per ET minute with trades. price_scale multiplies the price read_ticks returns (1.0 when read_ticks already scaled it)."""
    prev_px, direction, cur, cur_m = None, 0, None, None
    for t in read_ticks(filepath, start_date=start, end_date=end):
        px = t.price * price_scale; m = t.ts_et.replace(second=0, microsecond=0, tzinfo=None)
        if m != cur_m:
            if cur is not None: yield cur
            cur_m = m; cur = dict(ts=m, up_vol=0, down_vol=0, unclassified_vol=0, volume=0, close=px)
        if prev_px is not None:
            if px > prev_px: direction = 1
            elif px < prev_px: direction = -1
        d = direction if prev_px is not None else 0
        if d == 1: cur['up_vol'] += t.size
        elif d == -1: cur['down_vol'] += t.size
        else: cur['unclassified_vol'] += t.size
        cur['volume'] += t.size; cur['close'] = px; prev_px = px
    if cur is not None: yield cur

if __name__ == '__main__':
    fp, start, end, out = sys.argv[1], datetime.date.fromisoformat(sys.argv[2]), datetime.date.fromisoformat(sys.argv[3]), sys.argv[4]
    scale = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
    n = 0
    with open(out, 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['ts', 'up_vol', 'down_vol', 'unclassified_vol', 'volume', 'close'])
        for r in minute_updown(fp, start, end, scale):
            if n == 0: assert 5000 < r['close'] < 60000, f"price {r['close']} outside the plausible NQ range: wrong price scale?"
            w.writerow([r['ts'].strftime('%Y-%m-%d %H:%M:%S'), r['up_vol'], r['down_vol'], r['unclassified_vol'], r['volume'], f"{r['close']:.2f}"]); n += 1
    print(f'{n} minutes -> {out}')
