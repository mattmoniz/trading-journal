"""Bar-level snapshot features and outcomes of docs/EVENT_SNAPSHOT_STUDY_20261102.md. Every feature uses bars completed at or before the event bar i only; the outcome uses bars after it.
A day is a dict of arrays: start,end,o,h,l,c,vol,bid,ask,comp,ntr, vap_i,vap_px,vap_tot (volume at price per bar), onh, onl, atr."""
import numpy as np
RTH_OPEN = 55800.0
FEATURES = ['delta1', 'delta3', 'delta10', 'ddiv10', 'ddiv20', 'abs3', 'pace10', 'ntr3', 'lot3', 'edge10', 'loc', 'dist_ahead', 'dist_behind', 'c4', 'ladder']

def direction(day, i):
    """pre-event direction p: sign of the price change over the last 10 bars (0 = none)."""
    return int(np.sign(day['c'][i] - day['c'][i - 10])) if i >= 10 else 0

def features(day, i, p, c4, ladder):
    c, h, l, vol, bid, ask, ntr, start, end = (day[k] for k in ('c', 'h', 'l', 'vol', 'bid', 'ask', 'ntr', 'start', 'end'))
    if i < 20 or p == 0: return None
    ash = lambda a, b: p * (ask[a:b].sum() - bid[a:b].sum()) / vol[a:b].sum()
    f = dict(delta1=ash(i, i + 1), delta3=ash(i - 2, i + 1), delta10=ash(i - 9, i + 1))
    for w in (10, 20): f[f'ddiv{w}'] = ash(i - w // 2 + 1, i + 1) - ash(i - w + 1, i - w // 2 + 1)
    rng = h - l; f['abs3'] = rng[i - 2:i + 1].mean() / np.median(rng[:i + 1]); dur = end - start; f['pace10'] = dur[i - 9:i + 1].mean() / dur[:i + 1].mean()
    f['ntr3'] = float(ntr[i - 2:i + 1].mean()); f['lot3'] = float(vol[i - 2:i + 1].sum() / ntr[i - 2:i + 1].sum())
    ext = h[i - 9:i + 1].max() if p > 0 else l[i - 9:i + 1].min(); m = (day['vap_i'] >= i - 9) & (day['vap_i'] <= i); px, tot = day['vap_px'][m], day['vap_tot'][m]; near = (px >= ext - 0.25) if p > 0 else (px <= ext + 0.25)
    f['edge10'] = float(tot[near].sum() / tot.sum())
    rt = end[:i + 1] >= RTH_OPEN; H, L = h[:i + 1][rt].max(), l[:i + 1][rt].min(); loc = (c[i] - L) / (H - L) if H > L else np.nan; f['loc'] = loc if p > 0 else 1 - loc
    f['dist_ahead'] = ((day['onh'] - c[i]) if p > 0 else (c[i] - day['onl'])) / day['atr']; f['dist_behind'] = ((c[i] - day['onl']) if p > 0 else (day['onh'] - c[i])) / day['atr']
    f['c4'] = float(c4); f['ladder'] = float(ladder); return f

def outcomes(day, i, p):
    """continuation scores y (ATR units, + = the pre-event move continued) at 15/30/60 minutes and the raw signed move; None when the window is incomplete."""
    end, comp, c = day['end'], day['comp'], day['c']; t0 = end[i]; out = {}
    for h in (15, 30, 60):
        if end[comp].max() < t0 + h * 60 - 60: return None
        w = np.where(comp & (end > t0) & (end <= t0 + h * 60))[0]
        if len(w) == 0: return None
        mv = (c[w[-1]] - c[i]) / day['atr']; out[f'y{h}'] = p * mv; out[f'up{h}'] = mv
    return out
