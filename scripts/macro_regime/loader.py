"""
Loader for the NQ Macro-Regime Auction Classifier audit.

Builds the two raw dicts run_classifier.run_full_pipeline_audit() expects, from the same
`price_bars_primary` view the rest of this codebase reads (symbol='NQ', RTH 09:30-15:59 ET,
1-minute, OPEN-time stamped -- verified: bar 09:30 carries the open-auction volume spike,
bar 15:59 the close).

compute_va_fn is a line-for-line Python port of server/services/developingValueService.js
`computeProfile()` (the codebase's single reference volume-profile implementation: each bar's
volume is spread evenly across its own H-L tick range, VA grown from the POC toward whichever
side has more volume next until `pct` of total volume is enclosed). It is cross-checked
against the real JS function by `crosscheck_va_node.mjs` -- do not "improve" it independently.
"""
import sys
import datetime
import numpy as np
import pandas as pd

sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
from db import get_connection  # noqa: E402

TICK = 0.25
# Pinned (never "through today"): the table grows while we work, so every run of this study must
# see the identical population. END is exclusive; 2026-10-27 was a still-forming session when pinned.
DEFAULT_START = '2023-01-01'
DEFAULT_END = '2026-10-27'


def compute_va_fn(session_df: pd.DataFrame, pct: float = 0.70) -> dict:
    """Port of computeProfile(). Returns {'vah','val'} (NaN when the profile is degenerate)."""
    vol_map = {}
    for h, l, v in zip(session_df['High'].to_numpy(float), session_df['Low'].to_numpy(float),
                       session_df['Volume'].to_numpy(float)):
        if not (h >= l):
            continue
        lo = int(round(l / TICK))
        hi = int(round(h / TICK))
        levels = max(1, int(round((h - l) / TICK)) + 1)
        vpl = v / levels
        # JS walks p = l; p <= h + TICK/2; p += TICK and rounds each p to a tick: ticks lo..hi
        for t in range(lo, hi + 1):
            vol_map[t] = vol_map.get(t, 0.0) + vpl
    keys = sorted(vol_map)
    if len(keys) < 3:
        return {'vah': float('nan'), 'val': float('nan')}
    vols = [vol_map[k] for k in keys]
    total = 0.0
    for v in vols:          # explicit left-to-right sum (Python 3.12 sum() is compensated; JS reduce is not)
        total += v
    max_vol = max(vols)
    poc = vols.index(max_vol)
    va_vol = vols[poc]
    up, dn = poc + 1, poc - 1
    n = len(vols)
    while va_vol < total * pct and (up < n or dn >= 0):
        up_add = vols[up] if up < n else 0
        dn_add = vols[dn] if dn >= 0 else 0
        if up_add >= dn_add and up < n:
            va_vol += up_add
            up += 1
        elif dn >= 0:
            va_vol += dn_add
            dn -= 1
        else:
            va_vol += up_add
            up += 1
    vah = keys[up - 1] * TICK if (up - 1) < n else keys[poc] * TICK
    val = keys[dn + 1] * TICK if (dn + 1) >= 0 else keys[poc] * TICK
    return {'vah': float(vah), 'val': float(val)}


def _month_starts(start: str, end: str):
    s = pd.Timestamp(start).replace(day=1)
    e = pd.Timestamp(end)
    while s < e:
        nxt = s + pd.offsets.MonthBegin(1)
        yield max(s, pd.Timestamp(start)), min(nxt, e)
        s = nxt


def load_raw_sessions(start: str = DEFAULT_START, end: str = DEFAULT_END) -> dict:
    """{'YYYY-MM-DD': DataFrame[Open,High,Low,Close,Volume] indexed by tz-naive ET minute stamps}."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SET statement_timeout='120s'")
    frames = []
    for lo, hi in _month_starts(start, end):          # bounded both ends, chunked by month
        cur.execute("""
            SELECT ts, open::float, high::float, low::float, close::float, volume::float
            FROM price_bars_primary
            WHERE symbol = 'NQ' AND ts >= %s AND ts < %s
              AND ts::time >= '09:30' AND ts::time < '16:00'
            ORDER BY ts
        """, (lo.to_pydatetime(), hi.to_pydatetime()))
        rows = cur.fetchall()
        if rows:
            frames.append(pd.DataFrame(rows, columns=['ts', 'Open', 'High', 'Low', 'Close', 'Volume']))
    conn.close()
    df = pd.concat(frames, ignore_index=True)
    if df['ts'].duplicated().any():
        raise RuntimeError("duplicate timestamps in price_bars_primary RTH read")
    df['ts'] = pd.to_datetime(df['ts'])
    df['d'] = df['ts'].dt.strftime('%Y-%m-%d')
    sessions = {}
    for d, g in df.groupby('d', sort=True):
        sessions[d] = g.drop(columns='d').set_index('ts').sort_index()[['Open', 'High', 'Low', 'Close', 'Volume']]
    return sessions


def session_is_complete_prior(df: pd.DataFrame) -> bool:
    """A session may serve as a prior-VA source only if it is a whole RTH (or early-close) session:
    starts 09:30, runs to at least 12:59 (early close), and has <=2% missing minutes."""
    if len(df) == 0:
        return False
    first, last = df.index[0], df.index[-1]
    if first.time() != datetime.time(9, 30) or last.time() < datetime.time(12, 59):
        return False
    span = int((last - first).total_seconds() // 60) + 1
    return len(df) >= 0.98 * span


def build_prior_va_dict(sessions: dict, pct: float = 0.70, max_gap_days: int = 5):
    """prior_va[d] = VA(previous session in the loaded set), only if that session is complete and at
    most max_gap_days calendar days earlier (covers weekends + holiday long weekends). Else NaN."""
    dates = sorted(sessions.keys(), key=pd.Timestamp)
    prior = {}
    stats = {'ok': 0, 'no_prior': 0, 'prior_incomplete': 0, 'prior_gap': 0, 'prior_degenerate': 0}
    for i, d in enumerate(dates):
        nan = {'vah': np.nan, 'val': np.nan}
        if i == 0:
            prior[d] = nan; stats['no_prior'] += 1; continue
        p = dates[i - 1]
        if (pd.Timestamp(d) - pd.Timestamp(p)).days > max_gap_days:
            prior[d] = nan; stats['prior_gap'] += 1; continue
        if not session_is_complete_prior(sessions[p]):
            prior[d] = nan; stats['prior_incomplete'] += 1; continue
        va = compute_va_fn(sessions[p], pct=pct)
        if np.isnan(va['vah']):
            prior[d] = nan; stats['prior_degenerate'] += 1; continue
        prior[d] = va; stats['ok'] += 1
    return prior, stats
