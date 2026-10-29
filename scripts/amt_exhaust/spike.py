"""Spike exhaustion, marks only (PREREG_SPIKE.md frozen)."""
import numpy as np
M = 5; K = 30; RET = 5; Q = 90; REFRACT = 15; WIN = 15; N = 390

def thrust(a, m=M):
    """Per bar t: upward-thrust size (bar t is the highest high of the last m bars and the lowest low came before it) and downward-thrust size (mirror)."""
    h, l = a['h'], a['l']; up = np.zeros(N); dn = np.zeros(N)
    for t in range(m - 1, N):
        hw = h[t - m + 1:t + 1]; lw = l[t - m + 1:t + 1]
        if np.isnan(hw).any() or np.isnan(lw).any(): continue
        if h[t] >= np.max(hw) and int(np.argmin(lw)) < m - 1: up[t] = h[t] - np.min(lw)
        if l[t] <= np.min(lw) and int(np.argmax(hw)) < m - 1: dn[t] = np.max(hw) - l[t]
    return dict(up=up, dn=dn)

def thresholds(stats, si, q=Q, back=20):
    if si < back: return None
    out = np.full(N, np.nan)
    for t in range(M, N):
        a0, b0 = max(0, t - WIN), min(N, t + WIN + 1)
        v = np.concatenate([np.concatenate([stats[j]['up'][a0:b0], stats[j]['dn'][a0:b0]]) for j in range(si - back, si)]); v = v[v > 0]
        if len(v) >= 20: out[t] = np.percentile(v, q)
    return out

def detect(a, st, thr, m=M, k=K, ret=RET):
    h, l, c = a['h'], a['l'], a['c']; out = []; last = {1: -10 ** 6, -1: -10 ** 6}
    for t in range(max(m, k + m), N):
        if np.isnan(thr[t]): continue
        for D, size in ((-1, st['up'][t]), (1, st['dn'][t])):                     # D = direction of the (unscored) fade: -1 after a spike HIGH, +1 after a spike LOW
            if size < thr[t] or size <= 0 or t < last[D] + REFRACT: continue
            if D == -1:
                ext = h[t]; base = float(np.min(l[t - m + 1:t + 1]))
                if not ext > np.max(h[t - m - k + 1:t - m + 1]): continue
                mid = (ext + base) / 2.0
            else:
                ext = l[t]; base = float(np.max(h[t - m + 1:t + 1]))
                if not ext < np.min(l[t - m - k + 1:t - m + 1]): continue
                mid = (ext + base) / 2.0
            u = None; strong = False
            for x in range(t + 1, min(N, t + ret + 1)):
                if np.isnan(c[x]): break
                if (D == -1 and h[x] > ext) or (D == 1 and l[x] < ext): u = None; break      # the spike kept extending: a later bar is the peak
                if u is None and ((D == -1 and c[x] < mid) or (D == 1 and c[x] > mid)): u = x
                if (D == -1 and c[x] <= base) or (D == 1 and c[x] >= base): strong = True
                if u is not None and x >= t + ret: break
            if u is None: continue
            out.append(dict(dir=D, t=t, u=u, ext=float(ext), base=base, strong=strong, size=float(size))); last[D] = t
    return out
