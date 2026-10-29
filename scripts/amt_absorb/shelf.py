"""Shelf marks (PREREG_SHELF.md frozen). Pure functions."""
import numpy as np
W = 25; Q = 25; TRY_GAP = 3; MERGE_GAP = 3; WIN = 15; N = 390

def ranges(a, w=W):
    h, l = a['h'], a['l']; R = np.full(N, np.nan)
    for t in range(w - 1, N):
        hw = h[t - w + 1:t + 1]; lw = l[t - w + 1:t + 1]
        if np.isnan(hw).any() or np.isnan(lw).any(): continue
        R[t] = np.max(hw) - np.min(lw)
    return R

def thresholds(Rs, si, q=Q, back=20, w=W):
    if si < back: return None
    out = np.full(N, np.nan)
    for t in range(w - 1, N):
        a0, b0 = max(0, t - WIN), min(N, t + WIN + 1)
        v = np.concatenate([Rs[j][a0:b0] for j in range(si - back, si)]); v = v[np.isfinite(v)]
        if len(v) >= 20: out[t] = np.percentile(v, q)
    return out

def _tries(mask):
    idx = np.flatnonzero(mask)
    return 0 if len(idx) == 0 else 1 + int(np.sum(np.diff(idx) >= TRY_GAP))

def shelves(a, R, thr, atr, w=W):
    """Merged shelf intervals: dict(t0 first window start, tc first qualifying bar (confirmation), t1 last qualifying bar, hi, lo (range of the confirming window), tries)."""
    h, l = a['h'], a['l']; q = np.zeros(N, bool); info = {}
    for t in range(w - 1, N):
        if np.isnan(R[t]) or np.isnan(thr[t]) or np.isnan(atr[t]) or R[t] > thr[t]: continue
        w0 = t - w + 1; hi = float(np.max(h[w0:t + 1])); lo = float(np.min(l[w0:t + 1]))
        tr = max(_tries(h[w0:t + 1] >= hi - atr[t]), _tries(l[w0:t + 1] <= lo + atr[t]))
        if tr >= 2: q[t] = True; info[t] = (hi, lo, tr)
    out = []; t = w - 1
    while t < N:
        if not q[t]: t += 1; continue
        tc = t; last = t; u = t + 1
        while u < N and u <= last + MERGE_GAP + 1:
            if q[u]: last = u
            u += 1
        hi, lo, tr = info[tc]
        out.append(dict(t0=tc - w + 1, tc=tc, t1=last, hi=hi, lo=lo, tries=tr)); t = last + 1
    return out

def breaks(a, shelf, o0, scan=20):
    """Stage 2: first close beyond the confirming window's high/low within `scan` bars of confirmation. Returns dict(u, brk (+1 up / -1 down), with_drift) or None."""
    c = a['c']; tc = shelf['tc']
    for u in range(tc + 1, min(N, tc + scan + 1)):
        if np.isnan(c[u]): break
        if c[u] > shelf['hi'] or c[u] < shelf['lo']:
            b = 1 if c[u] > shelf['hi'] else -1; dsign = 1 if c[u] > o0 else -1
            return dict(u=u, brk=b, with_drift=(b == dsign))
    return None
