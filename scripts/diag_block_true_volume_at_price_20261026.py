"""Current 3-month block profile (this file stores real prices, no x100 scaling; run with venv/bin/python) from REAL tick volume-at-price (Sierra .scid), to test whether the mismatch with the user's Sierra lines
(POC ~29,779.75, VAH label 30,925.5, VAL ~28,970-29,000) is our spread-the-bar-over-H-L allocation. Chunked memmap read, only the window needed."""
import numpy as np, datetime, sys
from zoneinfo import ZoneInfo
F = '/mnt/c/SierraChart-DTC/Data/NQZ26.scid'
dt = np.dtype([('t', '<i8'), ('o', '<f4'), ('h', '<f4'), ('l', '<f4'), ('c', '<f4'), ('n', '<u4'), ('v', '<u4'), ('b', '<u4'), ('a', '<u4')])
mm = np.memmap(F, dtype=dt, mode='r', offset=56)
EPOCH = datetime.datetime(1899, 12, 30, tzinfo=ZoneInfo('UTC'))
def us(y, m, d, H, M=0):
    et = datetime.datetime(y, m, d, H, M, tzinfo=ZoneInfo('America/New_York'))
    return int((et.astimezone(ZoneInfo('UTC')) - EPOCH) / datetime.timedelta(microseconds=1))
def first_at_or_after(t):
    lo, hi = 0, len(mm)
    while lo < hi:
        mid = (lo + hi) // 2
        if mm[mid]['t'] < t: lo = mid + 1
        else: hi = mid
    return lo
print('records', len(mm), 'first', EPOCH + datetime.timedelta(microseconds=int(mm[0]['t'])), 'last', EPOCH + datetime.timedelta(microseconds=int(mm[-1]['t'])))
def profile(start_us, end_us=None):
    i0 = first_at_or_after(start_us); i1 = len(mm) if end_us is None else first_at_or_after(end_us); acc = {}
    for s in range(i0, i1, 4_000_000):
        ch = np.asarray(mm[s:min(i1, s + 4_000_000)]); c = ch['c']; ok = (c > 1e4) & (c < 1e5) & (ch['v'] > 0); px = np.round(c[ok].astype(np.float64) * 4) / 4; vol = ch['v'][ok].astype(np.int64)
        u, inv = np.unique(px, return_inverse=True); sums = np.bincount(inv, weights=vol)
        for p, v in zip(u, sums): acc[p] = acc.get(p, 0) + v
    ks = sorted(acc); tot = sum(acc.values()); poc = max(ks, key=lambda k: acc[k]); step = 0.25; lo = hi = poc; cum = acc[poc]; g = lambda k: acc.get(round(k, 2), 0)
    while cum < 0.7 * tot:
        up = g(hi + step) + g(hi + 2 * step); dn = g(lo - step) + g(lo - 2 * step)
        if up == 0 and dn == 0: break
        if up >= dn: hi += step; cum += g(hi)
        else: lo -= step; cum += g(lo)
    return dict(records=i1 - i0, total_vol=int(tot), VAL=lo, POC=poc, VAH=hi)
print('user chart: POC 29779.75, VAH label 30925.5, VAL ~28970-29000')
for lab, st in [('Oct 1 session (Sep 30 18:00 ET)', us(2026, 9, 30, 18)), ('Oct 2 session (Oct 1 18:00 ET)', us(2026, 10, 1, 18)), ('Oct 5 session (Oct 4 18:00 ET)', us(2026, 10, 4, 18))]:
    print(lab, profile(st)); sys.stdout.flush()
