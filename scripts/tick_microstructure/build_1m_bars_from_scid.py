"""Build 1-minute OHLCV bars (ET wall-clock minute) directly from a raw Sierra Chart .scid file.

Added 2026-10-05 for the Sep-Nov 2025 bad-bar repair (docs/DB_BACKUP_CATALOG.md, the
price_bars_nqh26_sep_nov2025 entry; KNOWN_ISSUES item 16). Record decoding is delegated to
scripts/tick_microstructure/scid_reader.py (the canonical reader) -- this file only aggregates.

Validated 2026-10-05 against Sierra Chart's own 1-minute text export (NQZ5.CME.scid_BarData.txt)
over 4,545 overlapping minutes: Open/High/Low/Close match exactly on every minute; Volume, bid,
ask and trade count match on all but 2 minutes (a 53-contract difference, 2025-11-19 16:35).

Usage: python3 build_1m_bars_from_scid.py <file.scid> <start YYYY-MM-DD ET> <end YYYY-MM-DD ET> <out.csv>
"""
import sys, csv, datetime
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/tick_microstructure')
from scid_reader import _raw_records, _to_et, SCID_PRICE_SCALE, FIRST_SUB_TRADE, LAST_SUB_TRADE, _SENTINEL_TOL

filepath, start, end, out = sys.argv[1], datetime.date.fromisoformat(sys.argv[2]), datetime.date.fromisoformat(sys.argv[3]), sys.argv[4]
bars, order = {}, []
n_rec = 0
for dt_utc, o, h, l, c, numtr, totvol, bidvol, askvol in _raw_records(filepath, start_date=start):
    ts = _to_et(dt_utc)
    if ts.date() < start: continue
    if ts.date() > end: break
    # Price convention: only ordinary single-trade (Open==0) and sentinel records carry the trade price in Close.
    # Non-sentinel Open values are real anomalies in this data (scid_reader raises on them) -> count and stop.
    if not (o == 0.0 or abs(o - FIRST_SUB_TRADE) < _SENTINEL_TOL or abs(o - LAST_SUB_TRADE) < _SENTINEL_TOL):
        raise SystemExit(f'anomalous record at {ts}: open={o}')
    n_rec += 1
    px = c / SCID_PRICE_SCALE
    m = ts.replace(second=0, microsecond=0)
    b = bars.get(m)
    if b is None:
        b = {'o': px, 'h': px, 'l': px, 'c': px, 'vol': 0, 'trades': 0, 'bid': 0, 'ask': 0}
        bars[m] = b; order.append(m)
    b['h'] = max(b['h'], px); b['l'] = min(b['l'], px); b['c'] = px
    b['vol'] += totvol; b['trades'] += numtr; b['bid'] += bidvol; b['ask'] += askvol
with open(out, 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['ts','open','high','low','close','volume','num_trades','bid_volume','ask_volume'])
    for m in sorted(order):
        b = bars[m]
        w.writerow([m.strftime('%Y-%m-%d %H:%M:%S'), f"{b['o']:.2f}", f"{b['h']:.2f}", f"{b['l']:.2f}", f"{b['c']:.2f}", b['vol'], b['trades'], b['bid'], b['ask']])
print(f'records={n_rec} minutes={len(order)} -> {out}')
