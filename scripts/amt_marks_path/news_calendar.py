"""Historical high-impact release calendar (NFP / CPI / FOMC), candidate dates from the public schedules, VERIFIED against the market reaction (a volume spike at the release minute in price_bars_primary). Usage: ../../venv/bin/python news_calendar.py"""
import sys, numpy as np, pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
from db import get_connection
NFP = '2023-03-10 2023-04-07 2023-05-05 2023-06-02 2023-07-07 2023-08-04 2023-09-01 2023-10-06 2023-11-03 2023-12-08 2024-01-05 2024-02-02 2024-03-08 2024-04-05 2024-05-03 2024-06-07 2024-07-05 2024-08-02 2024-09-06 2024-10-04 2024-11-01 2024-12-06 2025-01-10 2025-02-07 2025-03-07 2025-04-04 2025-05-02'.split()
CPI = '2023-03-14 2023-04-12 2023-05-10 2023-06-13 2023-07-12 2023-08-10 2023-09-13 2023-10-12 2023-11-14 2023-12-12 2024-01-11 2024-02-13 2024-03-12 2024-04-10 2024-05-15 2024-06-12 2024-07-11 2024-08-14 2024-09-11 2024-10-10 2024-11-13 2024-12-11 2025-01-15 2025-02-12 2025-03-12 2025-04-10 2025-05-13'.split()
FOMC = '2023-03-22 2023-05-03 2023-06-14 2023-07-26 2023-09-20 2023-11-01 2023-12-13 2024-01-31 2024-03-20 2024-05-01 2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18 2025-01-29 2025-03-19 2025-05-07'.split()
CAND = [(d, 'NFP', '08:30') for d in NFP] + [(d, 'CPI', '08:30') for d in CPI] + [(d, 'FOMC', '14:00') for d in FOMC]
def minute_table(minute):
    """date -> (volume, range) of the 1-minute bar at `minute` for every date with data 2023-02..2025-06 (NQ, price_bars_primary)."""
    conn = get_connection(); cur = conn.cursor(); cur.execute("SET statement_timeout='180s'")
    cur.execute("SELECT ts::date, volume::float, (high-low)::float FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2023-01-15' AND ts < '2025-06-30' AND ts::time = %s::time ORDER BY ts", (minute,))
    out = {str(r[0]): (r[1], r[2]) for r in cur.fetchall()}; conn.close(); return out
def verify():
    res = []; tabs = {m: minute_table(m) for m in ('08:30', '14:00')}
    for d, typ, m in CAND:
        tab = tabs[m]; dates = sorted(tab); i = dates.index(d) if d in tab else None
        if i is None or i < 20: res.append((d, typ, m, None, None)); continue
        prior = [tab[x][0] for x in dates[i - 20:i] if x not in {c[0] for c in CAND}]; base = np.median(prior) if prior else np.nan
        res.append((d, typ, m, tab[d][0] / base if base else np.nan, tab[d][1]))
    return res
if __name__ == '__main__':
    res = verify(); bad = [r for r in res if r[3] is None or not r[3] >= 2.5]
    print(f'candidates {len(res)}; volume at the release minute vs the median of the prior 20 sessions at that minute: median ratio {np.nanmedian([r[3] for r in res if r[3] is not None]):.1f}x; below 2.5x or missing: {len(bad)}')
    for r in res: print(f"  {r[0]} {r[1]:5s} {r[2]} ratio {('n/a' if r[3] is None else f'{r[3]:5.1f}x')} range {('n/a' if r[4] is None else f'{r[4]:6.1f}')}{'   <== CHECK' if r in bad else ''}")
