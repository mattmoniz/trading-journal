"""Signal-bar and next-bar OHLC for vacuum_live_events (secondary arms S2 wick and S3 stall of docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md, amendments A2/A3). Pure: returns the SQL statements to run, so it is unit-tested without a
database. Fill-once semantics (`... IS NULL` guards), forward only, informational columns (NOT part of the decision hash). Not imported by the live daemon until the patched shadow.py is applied."""
def ohlc_updates(rid, k, n0, o, h, l, c, nb):
    """rid: event id; k: bar index within the session; n0: offset of the session in the continuous arrays; o,h,l,c: continuous arrays of COMPLETE bars; nb: number of complete bars. Returns [(sql, params), ...]."""
    a = n0 + k; out = []
    if 0 <= a < nb:
        out.append(("UPDATE vacuum_live_events SET sig_open=%s, sig_high=%s, sig_low=%s WHERE id=%s AND sig_high IS NULL", (float(o[a]), float(h[a]), float(l[a]), rid)))
    if 0 <= a and a + 1 < nb:
        out.append(("UPDATE vacuum_live_events SET nxt_high=%s, nxt_low=%s, nxt_close=%s WHERE id=%s AND nxt_close IS NULL", (float(h[a + 1]), float(l[a + 1]), float(c[a + 1]), rid)))
    return out
