"""Static tell V1 replay net per entry by calendar quarter (docs/TELL_HOLDOUT_BY_QUARTER_PREREG_20261104.md). Descriptive, 0 counted tests. Reads date and csv_net only.
Usage: venv/bin/python scripts/tell_context/research_20261103/tell_holdout_by_quarter.py"""
import os
import numpy as np, pandas as pd
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); T = os.path.join(REPO, 'scratch', 'tell_context_20261103')
rng = np.random.default_rng(20261104)
A = pd.read_csv(os.path.join(T, 'tell_hold_value_trail_rows.csv'), usecols=['date', 'csv_net']); A['win'] = 'explore'
B = pd.read_csv(os.path.join(T, 'watcher_stop_sealed_rows_sealed.csv'), usecols=['date', 'csv_net']); B['win'] = 'hold-out'
R = pd.concat([A, B], ignore_index=True); R['q'] = pd.PeriodIndex(pd.to_datetime(R.date), freq='Q').astype(str)

def boot(g, B_=4000):
    s = g.groupby('date').csv_net.agg(['sum', 'count']); sm, ct = s['sum'].values, s['count'].values; m = np.empty(B_)
    for b in range(B_): p = rng.integers(0, len(sm), len(sm)); m[b] = sm[p].sum() / ct[p].sum()
    return np.percentile(m, [2.5, 97.5]), float(np.std(m))
print(f"{'quarter':8s} {'window':9s} {'N':>5s} {'days':>5s} {'mean/entry':>11s} {'95% CI (day-block)':>22s} {'detectable':>11s} {'win%':>5s}")
rows = []
for q, g in R.groupby('q'):
    ci, se = boot(g); w = 'both' if g.win.nunique() > 1 else g.win.iloc[0]; rows.append((q, g.csv_net.mean(), len(g)))
    print(f'{q:8s} {w:9s} {len(g):5d} {g.date.nunique():5d} {g.csv_net.mean():+11.2f} [{ci[0]:+7.1f}, {ci[1]:+7.1f}] {2.8 * se:11.1f} {100 * (g.csv_net > 0).mean():5.0f}')
df = pd.DataFrame(rows, columns=['q', 'mean', 'n']); print()
print(f'first four quarters mean {np.average(df["mean"][:4], weights=df.n[:4]):+.2f}; last four {np.average(df["mean"][-4:], weights=df.n[-4:]):+.2f}')
for w in ('explore', 'hold-out'):
    g = R[R.win == w]; qs = g.groupby('q').csv_net.mean(); ci, se = boot(g)
    print(f'{w}: {len(g)} entries, mean {g.csv_net.mean():+.2f}, CI [{ci[0]:+.1f}, {ci[1]:+.1f}], quarters negative {int((qs < 0).sum())} of {len(qs)}')
