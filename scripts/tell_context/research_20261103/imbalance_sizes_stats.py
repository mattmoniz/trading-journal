"""A3 statistics (docs/IMBALANCE_BREAKOUT_PREREG_20261104.md section 13 and A3b): rho(BNET3 at each volume-bar size, y); family of 10 counted tests, CI 99.5 percent, day-block, other-date placebo. Reads imbalance_events_a3.csv (imbalance_sizes.py). Same bootstrap / placebo scheme as imbalance_breakout_a2.py.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/imbalance_sizes_stats.py   (look 171 is logged first, hr-023)"""
import os, sys
import numpy as np, pandas as pd
from scipy.stats import rankdata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stall_lib import REPO, rho_boot
rng = np.random.default_rng(20261104); B, NPLC = 4000, 1000; CIQ = (0.25, 99.75); SIZES = (1000, 2000, 5000, 10000)                  # Bonferroni 0.05 / 10
E = pd.read_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'imbalance_events_a3.csv')).sort_values(['date', 't']).reset_index(drop=True); N = len(E); y = E.y.values; yr = rankdata(y) / N - 0.5
E['hv_cut'] = [np.median(E.volr.values[:i]) if i >= 30 else np.nan for i in range(N)]; E['hv'] = E.volr >= E.hv_cut; ok = E.hv_cut.notna().values
print(f'{N} breakout events on {E.date.nunique()} sessions with at least 10 earlier bars at every size; events with the fast-tape cut: {int(ok.sum())}')
dates = sorted(E.date.unique()); half = E.date.isin(dates[len(dates) // 2:]).values; grp = {k: np.where((E.ltype == k[0]).values & (E.d == k[1]).values)[0] for k in {(a, b) for a, b in zip(E.ltype, E.d)}}
cand = [grp[(l, d_)][E.date.values[grp[(l, d_)]] != dt] for l, d_, dt in zip(E.ltype, E.d, E.date)]
def pick(): return np.array([c[int(u * len(c))] if len(c) else i for i, (c, u) in enumerate(zip(cand, rng.random(N)))])
print('\nDESCRIPTIVE per bar size (window = the same 10,000 contracts): ' )
for V in SIZES: print(f'  {V:6d}v: bars in the window {20 // (V // 500):2d}, occupied price cells per bar {E[f"cells_{V}"].mean():6.1f}, MINVOL median {E[f"minvol_{V}"].median():4.0f}, aligned stacks per window {E[f"bsa3_{V}"].mean():5.2f} (4:1 {E[f"bsa4_{V}"].mean():5.2f}), opposed {E[f"bso3_{V}"].mean():5.2f}; windows with >= 1 aligned stack {100 * (E[f"bsa3_{V}"] > 0).mean():3.0f}% (4:1 {100 * (E[f"bsa4_{V}"] > 0).mean():3.0f}%)')
res = {}
for V in SIZES:
    x = E[f'bnet3_{V}'].values; rho, ci, se = rho_boot(x, y, E.date.values, rng, CIQ, B); pr = np.array([np.corrcoef(rankdata(x[pick()]), rankdata(y))[0, 1] for _ in range(NPLC)])
    res[V] = (rho, ci, se, np.corrcoef(rankdata(x[~half]), rankdata(y[~half]))[0, 1], np.corrcoef(rankdata(x[half]), rankdata(y[half]))[0, 1], np.percentile(np.abs(pr), 97.5))
print('\nDETECTABLE rho (2.8 x SE), printed before the verdicts: ' + '; '.join(f'{V}v {2.8 * v[2]:.3f}' for V, v in res.items()))
print('\nCOUNTED TESTS (family of 10, CI 99.5% day-block; placebo = feature of a random event of another date, same level type and direction):')
for V, (c, ci, se, h1, h2, p97) in res.items():
    lead = (ci[0] > 0 or ci[1] < 0) and np.sign(h1) == np.sign(h2) == np.sign(c) and abs(c) > p97
    print(f'  rho(BNET3, y) at {V:5d}v: {c:+.3f} CI [{ci[0]:+.3f}, {ci[1]:+.3f}] | halves {h1:+.3f} / {h2:+.3f} | placebo 97.5th pct of |rho| {p97:.3f} => ' + ('LEAD' if lead else 'NOT SHOWN'))
print('\nREPORTED (not counted):')
for V in SIZES:
    c = E[f'bnet3_{V}'].expanding(min_periods=30).median().shift(1).values; init = E[f'bnet3_{V}'].values > c; m = ok & ~np.isnan(c) & E.hv.values
    a, b = m & init, m & ~init; rc = (yr[a].mean() - yr[b].mean()) if a.sum() >= 5 and b.sum() >= 5 else np.nan
    print(f'  {V:6d}v: 4:1 rho {np.corrcoef(rankdata(E[f"bnet4_{V}"]), rankdata(y))[0, 1]:+.3f}; fast-tape initiative minus absorption (rank units) {rc:+.3f} (N {int(a.sum())} vs {int(b.sum())}); rho by level type: ' + ', '.join(f'{lt} {np.corrcoef(rankdata(g[f"bnet3_{V}"]), rankdata(g.y))[0, 1]:+.3f}' for lt, g in E.groupby('ltype')))
print(f'  controls: rho(VOLR, y) {np.corrcoef(rankdata(E.volr), rankdata(y))[0, 1]:+.3f}, rho(window range / s, y) {np.corrcoef(rankdata(E.rng_s), rankdata(y))[0, 1]:+.3f}')
