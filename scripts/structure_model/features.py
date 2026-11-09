"""Shared feature and model code for the next-hour RANGE shadow model (docs/STRUCTURE_SHADOW_MODEL_DESIGN_20261105.md). ONE code path for the nightly job and the parity test (CLAUDE.md hr-022): the feature definitions are the ones of the research script
scripts/tell_context/research_20261103/structure_model_stepA.py (step A, claim structure_model_stepA_20261104); scripts/structure_model/test_parity.py reproduces the research rows from this module (the research script keeps its own copy, guarded by that test).
Pure functions: no database, no files. Inputs are plain arrays (minute 0 = 09:30 ET, 390 RTH minutes)."""
import hashlib, os
import numpy as np
TIMES = (60, 120, 210, 300)                      # decision minutes since 09:30 = 10:30, 11:30, 13:00, 14:30
SCALE_C = 0.1786                                  # the live 65-point leg in ADR units (65 / 364): the rotation-leg size is scaled to the market (the fixed size drifts with the price level)
CLK = ['c120', 'c210', 'c300']; HAR = ['har_d', 'har_w', 'har_m', 'ln_on']
D = ['rs', 'ln_ib', 'ext_up', 'ext_dn', 'pos', 'age', 'legs']; C = ['r30', 'v30', 'imb30']
M2_COLS = CLK + HAR + D + C; BASE_COLS = CLK + HAR; PERSIST_COLS = CLK + HAR + ['r30', 'rs']     # PERSIST = the HARD baseline: HAR-X + clock + the last-30-minute range and the range so far (two plain intraday persistence terms)
ALPHAS = (0.1, 1, 10, 100)


def leg_grid_size(adr):
    """The reversal size (20..200 step 10) nearest to SCALE_C x ADR: the size at which `legs` must be counted."""
    return min(range(20, 201, 10), key=lambda z: abs(z - SCALE_C * adr))


def har_features(rng22, adr, on_rng_pts):
    """rng22: the RTH ranges (points) of the 22 sessions BEFORE the day, oldest first. on_rng_pts: the overnight (18:00-09:29) high-low in points."""
    lag = lambda k: float(np.log(rng22[-k] / adr))
    return dict(har_d=lag(1), har_w=float(np.mean([lag(k) for k in range(1, 6)])), har_m=float(np.mean([lag(k) for k in range(1, 23)])), ln_on=float(np.log(max(on_rng_pts / adr, 1e-3))))


def feature_rows(b, adr, har, k, prior, legs):
    """The four decision rows of one day (a dict per decision time), using ONLY data before the decision minute.
    b: dict o/h/l/c arrays (390, minute 0 = 09:30). k: dict up/dn/vol tick arrays (390) of the day. prior: list of the 20 sessions before the day, each a dict h/l/vol arrays (390).
    legs: {T: number of confirmed rotation legs on the minutes before T at the size leg_grid_size(adr)}. har: from har_features()."""
    rows = []
    for T in TIMES:
        if np.isnan(b['h'][:T]).any() or np.isnan(b['l'][:T]).any() or np.isnan(b['c'][:T]).any() or np.isnan(k['vol'][T - 30:T]).any(): raise ValueError(f'missing minutes before the decision minute {T}')
        h, l, c = b['h'][:T], b['l'][:T], b['c'][:T]; hi, lo = h.max(), l.min(); ibh, ibl = b['h'][:60].max(), b['l'][:60].min(); ibr = max(ibh - ibl, 0.25)
        last = max(int(np.where(h == hi)[0][-1]), int(np.where(l == lo)[0][-1]))
        r30 = float(np.log((b['h'][T - 30:T].max() - b['l'][T - 30:T].min()) / np.median([np.nanmax(p['h'][T - 30:T]) - np.nanmin(p['l'][T - 30:T]) for p in prior])))
        v30 = float(np.log(np.nansum(k['vol'][T - 30:T]) / np.median([np.nansum(p['vol'][T - 30:T]) for p in prior])))
        up, dn = float(np.nansum(k['up'][T - 30:T])), float(np.nansum(k['dn'][T - 30:T])); cl = c[-1]
        rows.append(dict(T=T, c120=float(T == 120), c210=float(T == 210), c300=float(T == 300), **har,
                         rs=float(np.log((hi - lo) / adr)), ln_ib=float(np.log(ibr / adr)), ext_up=float(max(0.0, (b['h'][60:T].max() - ibh) / ibr)) if T > 60 else 0.0, ext_dn=float(max(0.0, (ibl - b['l'][60:T].min()) / ibr)) if T > 60 else 0.0,
                         pos=float((cl - lo) / max(hi - lo, 0.25)), age=float((T - 1 - last) / T), legs=float(legs[T] / (T / 60)), r30=r30, v30=v30, imb30=float(abs(up - dn) / max(up + dn, 1.0))))
    return rows


def label(b, T, adr):
    """The label of a decision row: ln((highest high - lowest low of the NEXT 60 minutes) / ADR). Needs the bars T..T+59."""
    return float(np.log((np.max(b['h'][T:T + 60]) - np.min(b['l'][T:T + 60])) / adr))


def _ridge(Xt, yt, a):
    mu, sd = Xt.mean(0), Xt.std(0) + 1e-9; Z = (Xt - mu) / sd; yc = yt.mean(); w = np.linalg.solve(Z.T @ Z + a * np.eye(Z.shape[1]), Z.T @ (yt - yc)); return mu, sd, yc, w


def fit(X, y, day_idx):
    """Ridge with the penalty chosen by time-ordered inner CV over days (the research recipe). Returns a JSON-able model dict."""
    best = (1e18, 1.0); cuts = np.linspace(0, day_idx.max() + 1, 7).astype(int)
    for a in ALPHAS:
        e = 0.0
        for f in range(1, 6):
            tr = day_idx < cuts[f]; va = (day_idx >= cuts[f]) & (day_idx < cuts[f + 1])
            if tr.sum() < 20 or va.sum() < 5: continue
            mu, sd, yc, w = _ridge(X[tr], y[tr], a); e += float(np.mean((y[va] - yc - ((X[va] - mu) / sd) @ w) ** 2))
        if e < best[0]: best = (e, a)
    mu, sd, yc, w = _ridge(X, y, best[1]); return dict(alpha=best[1], mu=mu.tolist(), sd=sd.tolist(), yc=float(yc), w=w.tolist())


def predict(model, X):
    return model['yc'] + ((np.asarray(X, float) - np.array(model['mu'])) / np.array(model['sd'])) @ np.array(model['w'])


def code_hash():
    """Short hash of this file: stored with every prediction so a feature change is visible in the data (the repo's code_version convention)."""
    return hashlib.sha1(open(os.path.abspath(__file__), 'rb').read()).hexdigest()[:16]
