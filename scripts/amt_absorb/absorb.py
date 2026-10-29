"""Persistent absorption detector, marks only (PREREG.md frozen). Pure functions; threshold precompute mirrors scripts/amt_exhaust/exhaust.py."""
import sys
import numpy as np
K = 20; Q_EFFORT = 50; Q_RESULT = 25; TRY_GAP = 3; CONFIRM = 10; WIN = 15; N = 390

def window_stats(a, k=K):
    """Per bar t (window t-k+1..t): selling volume, buying volume, net delta, |net close move| over k bars."""
    v, dl, c = a['v'], a['dl'], a['c']; ask = (v + dl) / 2.0; bid = (v - dl) / 2.0
    sells = np.full(N, np.nan); buys = np.full(N, np.nan); dsum = np.full(N, np.nan); anet = np.full(N, np.nan); d1 = np.full(N, np.nan); d2 = np.full(N, np.nan); h = k // 2
    for t in range(k, N):
        if np.isnan(c[t]) or np.isnan(c[t - k]) or np.isnan(c[t - h]): continue
        sells[t] = np.nansum(bid[t - k + 1:t + 1]); buys[t] = np.nansum(ask[t - k + 1:t + 1]); dsum[t] = np.nansum(dl[t - k + 1:t + 1])
        d1[t] = np.nansum(dl[t - k + 1:t - h + 1]); d2[t] = np.nansum(dl[t - h + 1:t + 1]); anet[t] = abs(c[t] - c[t - h])   # anet = progress over the LAST HALF (Amendment 2)
    return dict(sells=sells, buys=buys, dsum=dsum, anet=anet, d1=d1, d2=d2, dabs=np.fmin(np.abs(d1), np.abs(d2)))

def thresholds(stats, si, k=K, back=20):
    """75th pct of selling/buying volume and 25th pct of |net move| from the prior `back` sessions at the same bar +/- WIN. None until si >= back."""
    if si < back: return None
    out = {n: np.full(N, np.nan) for n in ('sells', 'buys', 'anet', 'dhalf')}
    for key, q in (('sells', Q_EFFORT), ('buys', Q_EFFORT), ('anet', Q_RESULT)):
        M = np.array([stats[j][key] for j in range(si - back, si)])
        for t in range(k, N):
            blk = M[:, max(0, t - WIN):min(N, t + WIN + 1)]
            if np.isfinite(blk).any(): out[key][t] = np.nanpercentile(blk, q)
    for t in range(k, N):                                                            # trailing median of |half-window net delta|, both halves pooled
        vals = np.concatenate([np.abs(np.array([stats[j][n][max(0, t - WIN):min(N, t + WIN + 1)] for j in range(si - back, si)]).ravel()) for n in ('d1', 'd2')])
        if np.isfinite(vals).any(): out['dhalf'][t] = np.nanpercentile(vals, 50)
    return out

def _tries(mask):
    idx = np.where(mask)[0]
    if len(idx) == 0: return 0
    return 1 + int(np.sum(np.diff(idx) >= TRY_GAP))

def detect(a, st, thr, atr, k=K, confirm=CONFIRM, dominance=True):
    """Returns events: dict(dir=+1 leave up after absorbed selling / -1 leave down after absorbed buying, t0, t, u, wlo, whi, tries, mid, band)."""
    h, l, c, dl = a['h'], a['l'], a['c'], a['dl']; out = []; block = {1: -1, -1: -1}
    for t in range(k, N):
        if np.isnan(thr['anet'][t]) or np.isnan(st['anet'][t]) or np.isnan(atr[t]): continue
        if st['anet'][t] > thr['anet'][t]: continue                                     # no reward
        w0 = t - k + 1; whi = float(np.nanmax(h[w0:t + 1])); wlo = float(np.nanmin(l[w0:t + 1])); mid = (whi + wlo) / 2.0
        for D, eff, thr_eff in ((1, st['sells'], thr['sells']), (-1, st['buys'], thr['buys'])):
            if w0 <= block[D] or np.isnan(eff[t]) or np.isnan(thr_eff[t]): continue
            if eff[t] < thr_eff[t] or np.sign(st['d1'][t]) != -D or np.sign(st['d2'][t]) != -D or (dominance and not (abs(st['d1'][t]) >= thr['dhalf'][t] and abs(st['d2'][t]) >= thr['dhalf'][t])): continue   # persistent pressure by the side being absorbed, in both halves
            tries = _tries(l[w0:t + 1] <= wlo + atr[t]) if D == 1 else _tries(h[w0:t + 1] >= whi - atr[t])
            if tries < 2: continue                                                      # kept getting defended
            for u in range(t + 1, min(N, t + confirm + 1)):
                if np.isnan(c[u]): break
                if (D == 1 and l[u] < wlo) or (D == -1 and h[u] > whi): break          # the defended extreme broke: not absorption
                if ((D == 1 and c[u] > mid) or (D == -1 and c[u] < mid)) and np.sign(dl[u]) == D:
                    out.append(dict(dir=D, t0=w0, t=t, u=u, wlo=wlo, whi=whi, tries=tries, mid=mid, band=(wlo, wlo + float(atr[t])) if D == 1 else (whi - float(atr[t]), whi))); block[D] = u; break
    return out


def detect_both(a, st, thr, atr, k=K):
    """STRONG events (dominance test) plus WEAK events (looser version, not overlapping a same-direction strong event). Each event gets 'strong' True/False."""
    strong = detect(a, st, thr, atr, k, dominance=True); loose = detect(a, st, thr, atr, k, dominance=False)
    for e in strong: e['strong'] = True
    weak = []
    for e in loose:
        if any(s['dir'] == e['dir'] and not (e['t'] < s['t0'] or e['t0'] > s['u']) for s in strong): continue
        e['strong'] = False; weak.append(e)
    return sorted(strong + weak, key=lambda e: e['u'])
