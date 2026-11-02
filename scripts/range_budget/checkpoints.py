"""Checkpoint features and outcomes of docs/RANGE_BUDGET_PREREG_20261102.md for ONE RTH day of 390 one-minute bars. Decision features at checkpoint k use bars 0..k-1 ONLY; outcomes use bars k.. (strictly later).
Checkpoints k = 30, 60, ..., 300 bars after the open (10:00 .. 14:30)."""
import numpy as np
KS = tuple(range(30, 301, 30))

def checkpoints(h, l, c, atr):
    """dict of arrays over the 10 checkpoints: rng_atr (range so far / atr), loc, y30, y60, yclose (signed forward returns in ATR units from the checkpoint close), extH/extL (next 60 minutes trade beyond the running high / low)."""
    h, l, c = np.asarray(h, float), np.asarray(l, float), np.asarray(c, float); cumH = np.maximum.accumulate(h); cumL = np.minimum.accumulate(l); out = {k: [] for k in ('rng_atr', 'loc', 'y30', 'y60', 'yclose', 'extH', 'extL')}
    for k in KS:
        i = k - 1; H, L, C = cumH[i], cumL[i], c[i]; rg = H - L
        out['rng_atr'].append(rg / atr); out['loc'].append((C - L) / rg if rg > 0 else np.nan)
        out['y30'].append((c[i + 30] - C) / atr); out['y60'].append((c[i + 60] - C) / atr); out['yclose'].append((c[-1] - C) / atr)
        out['extH'].append(float(h[i + 1:i + 61].max() > H)); out['extL'].append(float(l[i + 1:i + 61].min() < L))
    return {k: np.array(v) for k, v in out.items()}
