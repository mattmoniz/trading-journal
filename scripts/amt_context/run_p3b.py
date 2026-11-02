"""Amendment 4 of PREREG_ROSTER_CONTEXT.md: does the forecast track the size of the fade trades' own excursions? EXPLORE only, descriptive. READS OUTCOMES -> look logged first by log_look_p3b.mjs.  Usage: ../../venv/bin/python run_p3b.py"""
import sys; sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import numpy as np, pandas as pd
from scipy.stats import rankdata
from db import get_connection
SEED, BOOT = 20261102, 3000
E = pd.read_csv('p3_rows.csv'); conn = get_connection(); cur = conn.cursor()
cur.execute("SELECT id, mfe_points::float, mae_points::float FROM active_setups WHERE id = ANY(%s)", (E.id.astype(int).tolist(),)); X = pd.DataFrame(cur.fetchall(), columns=['id', 'mfe', 'mae']); conn.close()
E = E.merge(X, on='id', how='left'); print(f'rows {len(E)}, with mfe/mae {int(E.mfe.notna().sum())}, missing {int(E.mfe.isna().sum())}'); E = E.dropna(subset=['mfe', 'mae']).copy()
E['exc'] = E.mfe + E.mae; E['abs'] = E.pnl.abs(); rng = np.random.default_rng(SEED)
def sp(a, b): return float(np.corrcoef(rankdata(a), rankdata(b))[0, 1])
print('\nby forecast third (H4 expanding thirds): N, mean excursion mfe+mae (points), mean mfe, mean mae, mean |pnl| ($)')
for t in ('low', 'mid', 'high'):
    g = E[E.third == t]; print(f'  {t:4s} N={len(g):4d} exc {g.exc.mean():7.2f}  mfe {g.mfe.mean():7.2f}  mae {g.mae.mean():7.2f}  |pnl| {g["abs"].mean():7.2f}')
by = {d: np.where(E.date.values == d)[0] for d in E.date.unique()}; ks = list(by); v = []
for _ in range(BOOT):
    ix = np.concatenate([by[ks[j]] for j in rng.integers(0, len(ks), len(ks))]); v.append(sp(E.fc.values[ix], E.exc.values[ix]))
med = np.sort(E.date.unique())[E.date.nunique() // 2]; h1, h2 = (E.date <= med).values, (E.date > med).values
print(f'\nSpearman(forecast, mfe+mae) = {sp(E.fc.values, E.exc.values):+.4f}, day-blocked 95% CI [{np.percentile(v, 2.5):+.4f}, {np.percentile(v, 97.5):+.4f}], halves {sp(E.fc.values[h1], E.exc.values[h1]):+.4f} / {sp(E.fc.values[h2], E.exc.values[h2]):+.4f}')
print(f'Spearman(forecast, |pnl|) = {sp(E.fc.values, E["abs"].values):+.4f}')
