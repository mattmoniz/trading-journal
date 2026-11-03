"""Descriptive RTH vs Globex comparison from the saved labeled event tables (no new test). Usage: python compare_sessions.py"""
import sys; sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/tape_companion')
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.pipeline import make_pipeline
TAPE = ['vol_ratio', 'delta30', 'delta120', 'cumdelta', 'tussle']; PRICE = ['approach_speed', 'dwell_frac', 'penetration', 'bounce_so_far']
D = {s: pd.read_csv(f'/home/mmoniz/trading-journal/scratch/tape_hold_slice_labeled_{s}_s5.csv') for s in ('RTH', 'GLOBEX')}
print(f"{'':28}{'RTH':>12}{'GLOBEX':>12}")
def row(nm, f): print(f'{nm:28}' + ''.join(f'{f(D[s]):>12}' for s in ('RTH', 'GLOBEX')))
row('evaluable events', lambda d: len(d)); row('dates', lambda d: d.date.nunique()); row('events per date (median)', lambda d: int(d.groupby('date').size().median()))
row('scale (points, 5-min range)', lambda d: round(d.scale.median(), 1)); row('HOLD share', lambda d: round((d.y == 1).mean(), 3)); row('SLICE share', lambda d: round((d.y == 0).mean(), 3)); row('NEITHER share', lambda d: round(d.y.isna().mean(), 3))
row('mean vol_ratio (log)', lambda d: round(d.vol_ratio.mean(), 3)); row('mean tussle', lambda d: round(d.tussle.mean(), 3)); row('mean dwell_frac', lambda d: round(d.dwell_frac.mean(), 3))
print('\nstandardised logistic coefficients on HOLD (full-sample, DESCRIPTIVE not out-of-sample; HOLD vs SLICE only); positive = flow/price toward the bounce side goes with HOLD')
cols = PRICE + TAPE; out = {}
for s, d in D.items():
    d = d[d.y.notna()]; m = make_pipeline(SimpleImputer(strategy='median'), StandardScaler(), LogisticRegression(C=0.1, max_iter=500)).fit(d[cols].values, d.y.values); out[s] = m[-1].coef_[0]
for k, c in enumerate(cols): print(f'{c:18}{out["RTH"][k]:>+10.3f}{out["GLOBEX"][k]:>+10.3f}' + ('   <-- SIGN FLIP' if np.sign(out['RTH'][k]) != np.sign(out['GLOBEX'][k]) and min(abs(out['RTH'][k]), abs(out['GLOBEX'][k])) > 0.03 else ''))
