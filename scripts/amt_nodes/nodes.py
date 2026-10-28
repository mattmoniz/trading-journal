"""Node ladder before the breakout (PREREG.md frozen). Pure functions, EXPLORE only."""
import sys
import numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_s1')
import engine as E

NB, BAR, DEC_LO, DEC_HI, HORIZON, FWD, FLAT, IB_END = 13, 30, 2, 7, 120, 60, 385, 60


def bracket_pocs(a):
    """POC of each completed 30-minute bracket (np.nan when the bracket has no usable bars)."""
    out = np.full(NB, np.nan)
    for b in range(NB):
        sl = slice(b * BAR, (b + 1) * BAR); seg = dict(h=a['h'][sl], l=a['l'][sl], v=a['v'][sl])
        if np.isfinite(seg['h']).sum() < 10: continue
        p = E.profile(seg)
        if p is not None: out[b] = p[2]
    return out


def atr20(sessions_by_date, d):
    ks = sorted(sessions_by_date); i = ks.index(d)
    if i < 20: return np.nan
    return float(np.mean([np.nanmax(sessions_by_date[k]['h']) - np.nanmin(sessions_by_date[k]['l']) for k in ks[i - 20:i]]))


def flow3(a, b):
    """(total volume, net delta) over the 90 one-minute bars of brackets b-2..b."""
    sl = slice((b - 2) * BAR, (b + 1) * BAR)
    return float(np.nansum(a['v'][sl])), float(np.nansum(a['dl'][sl]))


def ladder(poc, cl, b, d, S):
    """d=+1: POC[b-2] + S <= POC[b-1], POC[b-1] + S <= POC[b], and bracket-b close beyond its node."""
    if b < 2 or np.isnan(poc[b - 2:b + 1]).any() or np.isnan(cl[b]): return False
    s1, s2 = d * (poc[b - 1] - poc[b - 2]), d * (poc[b] - poc[b - 1])
    return s1 >= S and s2 >= S and d * (cl[b] - poc[b]) > 0


def points(S_sess, atr, S):
    """All decision points of one session: list of dicts with flags for both directions."""
    a = S_sess['a']; o, h, l, c = a['o'], a['h'], a['l'], a['c']
    if np.isnan(atr): return []
    ibh = float(np.nanmax(h[:IB_END])); ibl = float(np.nanmin(l[:IB_END])); onh, onl = S_sess.get('onh'), S_sess.get('onl')
    poc = bracket_pocs(a); cl = np.array([c[min(389, (b + 1) * BAR - 1)] for b in range(NB)])
    out = []
    for b in range(DEC_LO, DEC_HI + 1):
        dec_end = (b + 1) * BAR; last = dec_end - 1
        if np.isnan(c[last]) or dec_end >= 390 or np.isnan(o[dec_end]): continue
        hz = range(dec_end, min(dec_end + HORIZON, FLAT))
        for d in (1, -1):
            seen = c[IB_END:dec_end]; seen = seen[~np.isnan(seen)]
            if len(seen) and (np.any(seen > ibh) if d == 1 else np.any(seen < ibl)): continue   # already left the IB in this direction
            bd = ibh if d == 1 else ibl; dist = d * (bd - c[last]) / atr
            win = c[list(hz)]; win = win[~np.isnan(win)]
            brk = bool(len(win) and (np.any(win > bd) if d == 1 else np.any(win < bd)))
            cb = (max(ibh, onh) if (d == 1 and onh is not None) else (min(ibl, onl) if (d == -1 and onl is not None) else None))
            brk2 = bool(len(win) and cb is not None and (np.any(win > cb) if d == 1 else np.any(win < cb))) if cb is not None else None
            j = dec_end + FWD - 1; fwd = d * (c[j] - o[dec_end]) / atr if j < 390 and not np.isnan(c[j]) else np.nan
            lad = ladder(poc, cl, b, d, S)
            mom = (not lad) and (not np.isnan(cl[b - 2])) and d * (cl[b] - cl[b - 2]) >= S
            v3, n3 = flow3(a, b)
            out.append(dict(date=S_sess['d'], b=b, dir=d, dist=dist, brk=brk, brk2=brk2, fwd=fwd, ladder=lad, mom=mom, vol3=v3, net3=n3))
    return out
