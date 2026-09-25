"""ATR20 lookup for the tick-microstructure pilot's survival target (time to next
+-K*ATR move). Reuses this codebase's EXISTING canonical ATR20 definition exactly --
server/services/levelProximityService.js's getRollingATR() -- rather than inventing a
different (e.g. classic Wilder true-range) ATR that would silently disagree with every
other %ATR-based threshold already in this codebase. That definition: the trailing
20-session average of each RTH session's own (max(high)-min(low)) range, NQ only.

Per that same file's own header: dates in the first ~20 trading days of price_bars_primary
history have no prior 20-day window to average -- returns None for those rather than
guessing a fallback figure (this pilot has no live-display need for a fallback the way the
original JS caller does, so it can simply skip those dates instead of substituting a
flat point value).
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'ml_meta_labeling'))
from db import get_connection

ATR_WINDOW_DAYS = 20

_cache = {}


def get_rolling_atr20(session_date_str):
    """session_date_str: 'YYYY-MM-DD' (ET trading date). Matches getRollingATR(logDate)'s
    SQL exactly: strictly BEFORE session_date_str, RTH bars only (570-959 min of day)."""
    if session_date_str in _cache:
        return _cache[session_date_str]
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT AVG(range)::float as atr, COUNT(*)::int as n FROM (
                    SELECT ts::date as d, (MAX(high) - MIN(low)) as range
                    FROM price_bars_primary
                    WHERE symbol='NQ' AND ts::date < %s
                      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
                    GROUP BY ts::date
                    ORDER BY d DESC LIMIT {ATR_WINDOW_DAYS}
                ) recent
            """, (session_date_str,))
            atr, n = cur.fetchone()
    finally:
        conn.close()
    result = atr if (atr is not None and n >= ATR_WINDOW_DAYS) else None
    _cache[session_date_str] = result
    return result
