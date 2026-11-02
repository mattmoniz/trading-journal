"""Serving-side features and model application for the live busy-or-quiet forecast (docs/FORECAST_SERVICE_20261102.md). The feature DEFINITIONS are those of the study (run_p2b.py / run_p3.py row_features):
activity features only (no tell feature), causal, from completed 500-volume bars with end <= ts. test_forecast_features.py proves serving == training on sampled explore rows."""
import numpy as np
import vbars as V
STATE_FROM = V.RTH_OPEN
CONT = ['A_now', 'rth_range_so_far_atr', 'overnight_range_atr', 'minutes_since_rth_open', 'rr15', 'rr30', 'rr60']
FEATURE_NAMES = CONT + [f'bucket_{b}' for b in range(1, 10)] + [f'dow_{w}' for w in range(1, 5)]

def activity_row(ctx, ts, dow):
    """dict of the model's raw inputs at session-seconds ts (floored to the minute by the caller), or None when no usable state (no complete bar after 09:30, no pace, an empty rr window)."""
    S = ctx['S']; end, comp = S['end'], S['comp']
    ok = np.where(comp & (end <= ts) & (end >= STATE_FROM))[0]
    if len(ok) == 0 or ts < STATE_FROM: return None
    i0 = int(ok[-1]); A = float(ctx['A'][i0])
    rt = (end <= ts) & (end >= STATE_FROM) & comp
    if not np.isfinite(A) or not rt.any(): return None
    r = dict(i0=i0, A_now=A, rth_range_so_far_atr=float((S['h'][rt].max() - S['l'][rt].min()) / ctx['atr']), overnight_range_atr=float((ctx['onh'] - ctx['onl']) / ctx['atr']),
             minutes_since_rth_open=float((ts - STATE_FROM) / 60.0), dow=int(dow), bucket=int((ts - V.DEC_FIRST) // 1800))
    for M in (15, 30, 60):
        w = comp & (end <= ts) & (end > ts - M * 60.0)
        if not w.any(): return None
        r[f'rr{M}'] = float((S['h'][w].max() - S['l'][w].min()) / ctx['atr'])
    return r

def vector(row):
    """design vector in FEATURE_NAMES order (fixed one-hot levels, bucket 0 and Monday as the dropped bases)."""
    return np.array([row[c] for c in CONT] + [float(row['bucket'] == b) for b in range(1, 10)] + [float(row['dow'] == w) for w in range(1, 5)], dtype=float)

def predict(params, row):
    """log-travel forecast from stored params {mu, sd, coef, ym}; returns (log_forecast, forecast_in_ATR_units)."""
    z = (vector(row) - np.array(params['mu'])) / np.array(params['sd']); lf = float(params['ym'] + z @ np.array(params['coef']))
    return lf, float(np.exp(lf))
