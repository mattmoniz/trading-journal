"""Context features for the spike marks (PREREG_STAGE3.md), PREFIX-SAFE: every element at bar u depends only on bars <= u of today plus lookup baselines from PRIOR sessions. One code path for research and the future live shadow service."""
import numpy as np
N = 390

def session_series(a):
    """Series whose element u uses only bars 0..u: cumulative volume, high-low range of the last 30 bars ending at u, running session range."""
    h, l, v = a['h'], a['l'], np.nan_to_num(a['v']); cum = np.cumsum(v); r30 = np.full(N, np.nan); rng = np.full(N, np.nan)
    hh = np.fmax.accumulate(np.nan_to_num(h, nan=-np.inf)); ll = np.fmin.accumulate(np.nan_to_num(l, nan=np.inf))
    for u in range(N):
        w0 = max(0, u - 29); hw = h[w0:u + 1]; lw = l[w0:u + 1]
        if np.isfinite(hw).any() and np.isfinite(lw).any(): r30[u] = np.nanmax(hw) - np.nanmin(lw)
        if np.isfinite(hh[u]) and np.isfinite(ll[u]) and hh[u] > -np.inf: rng[u] = hh[u] - ll[u]
    return dict(cum=cum, r30=r30, rng=rng)

def baselines(prior_series):
    """Same-bar medians over the prior sessions' series (the lookup artifact: computed offline once per day, read live)."""
    return {k: np.nanmedian(np.array([q[k] for q in prior_series]), axis=0) for k in ('cum', 'r30', 'rng')}

def loc3(x, hi, lo): return 1 if x > hi else (-1 if x < lo else 0)

def features_at(series, u, base, ctx):
    """ctx: dict(on=dict(hi,lo,vol,vah,val), prior_vah, prior_val, atr, prior_close, o0, c_u, D, size, thr_t, on_vol_median). Returns the feature dict or None when a ratio is not usable."""
    rvol = series['cum'][u] / max(base['cum'][u], 1.0); volnow = series['r30'][u] / max(base['r30'][u], 1e-9); rngr = series['rng'][u] / max(base['rng'][u], 1e-9)
    if not np.all(np.isfinite([rvol, volnow, rngr])) or min(rvol, volnow, rngr) <= 0: return None
    on = ctx['on']; atr = ctx['atr']; c = ctx['c_u']; onv = ctx['on_vol_median']
    return dict(rvol=rvol, volnow=volnow, rngr=rngr, es=float(np.mean(np.log([rvol, volnow, rngr]))), on_pos=loc3(c, on['hi'], on['lo']), on_va=loc3(c, on['vah'], on['val']) if np.isfinite(on['vah']) else 0,
                va_pos=loc3(c, ctx['prior_vah'], ctx['prior_val']), on_range_rel=(on['hi'] - on['lo']) / atr, on_vol_rel=on['vol'] / onv if onv else np.nan, gap_rel=(ctx['o0'] - ctx['prior_close']) / atr,
                drift_w=(c - ctx['o0']) / atr * (-ctx['D']), size_ratio=ctx['size'] / ctx['thr_t'])
