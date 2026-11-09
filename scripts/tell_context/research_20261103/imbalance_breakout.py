"""Statistics for docs/IMBALANCE_BREAKOUT_PREREG_20261104.md (sections 5-6 and amendment A1). Reads scratch/watcher_marks_20261104/imbalance_events.csv (built by imbalance_events.py). 3 counted tests, explore only.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/imbalance_breakout.py   (look 169 is logged first, hr-023)"""
import os, sys
import numpy as np, pandas as pd
from scipy.stats import rankdata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stall_lib import REPO, rho_boot
rng = np.random.default_rng(20261104); B, NPLC = 4000, 1000; CIQ = (0.835, 99.165)
E = pd.read_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'imbalance_events.csv')).sort_values(['date', 't']).reset_index(drop=True); N = len(E)
E['hv_cut'] = [np.median(E.volr.values[:i]) if i >= 30 else np.nan for i in range(N)]; E['rt_cut'] = [np.median(E.rate3.values[:i]) if i >= 30 else np.nan for i in range(N)]
E['hv'] = E.volr >= E.hv_cut; E['init'] = E.rate3 > E.rt_cut; E['has_stack'] = E.sa3 > 0; ok = E.hv_cut.notna().values
print(f'{N} breakout events on {E.date.nunique()} sessions; level types {dict(E.ltype.value_counts())}; up {int((E.d == 1).sum())} / down {int((E.d == -1).sum())}; events with an expanding cut (>= 30 earlier): {int(ok.sum())}')
print('\nDESCRIPTIVE (what do imbalances look like in these windows):')
print(f'  windows with at least one ALIGNED stack: 3:1 {100 * (E.sa3 > 0).mean():.1f}%, 4:1 {100 * (E.sa4 > 0).mean():.1f}%; OPPOSED stack: 3:1 {100 * (E.so3 > 0).mean():.1f}%, 4:1 {100 * (E.so4 > 0).mean():.1f}%; aligned imbalance prices per window: mean {E.nal3.mean():.1f} (3:1), {E.nal4.mean():.1f} (4:1); opposed {E.nop3.mean():.1f}, {E.nop4.mean():.1f}')
print(f'  share of aligned imbalance prices located BEYOND the broken level (windows with any): mean {E.loc3.mean():.2f}; RATE3 mean {E.rate3.mean():+.4f}, sd {E.rate3.std():.4f}; VOLR median {E.volr.median():.2f}')
print(f'  mean y overall {E.y.mean():+.2f} (median {E.y.median():+.2f}); mean y by tercile of RATE3 (low->high): ' + ' '.join(f'{v:+.2f}' for v in E.groupby(pd.qcut(E.rate3.rank(method="first"), 3, labels=False)).y.mean().values) + '; by tercile of VOLR: ' + ' '.join(f'{v:+.2f}' for v in E.groupby(pd.qcut(E.volr.rank(method="first"), 3, labels=False)).y.mean().values))
F = E[ok]; print('  cells among events with cuts (N, mean y): ' + '; '.join(f'{("fast" if hv else "slow")} + {("initiative" if it else "no initiative")}: N={len(g)} y {g.y.mean():+.2f}' for (hv, it), g in F.groupby(['hv', 'init'])))
dates = sorted(E.date.unique()); half = E.date.isin(dates[len(dates) // 2:]).values; grp = {k: np.where((E.ltype == k[0]).values & (E.d == k[1]).values)[0] for k in {(a, b) for a, b in zip(E.ltype, E.d)}}


def day_idx(mask): return list(pd.Series(np.where(mask)[0]).groupby(E.date.values[mask]).apply(np.array).values)


def contrast(y, hv, it, m):
    a = m & hv & it; b = m & hv & ~it
    return float(y[a].mean() - y[b].mean()) if a.sum() >= 5 and b.sum() >= 5 else np.nan


def boot_contrast(m, it_arr):
    idx = day_idx(m); y = E.y.values; hv = E.hv.values; out = np.empty(B)
    for k in range(B):
        p = np.concatenate([idx[j] for j in rng.integers(0, len(idx), len(idx))]); mm = np.zeros(N, bool); mm[p] = True
        a, b = y[p][hv[p] & it_arr[p]], y[p][hv[p] & ~it_arr[p]]; out[k] = (a.mean() - b.mean()) if len(a) >= 5 and len(b) >= 5 else np.nan
    return np.nanpercentile(out, CIQ), float(np.nanstd(out))


def placebo_picks():
    """For every event a random event of ANOTHER date with the same level type and direction."""
    cand = [grp[(l, d_)][E.date.values[grp[(l, d_)]] != dt] for l, d_, dt in zip(E.ltype, E.d, E.date)]
    return lambda: np.array([c[int(u * len(c))] if len(c) else i for i, (c, u) in enumerate(zip(cand, rng.random(N)))])


pick = placebo_picks(); y = E.y.values; M = ok.copy(); res = {}
for name, col in (('T1 RATE3', 'rate3'), ('T2 RATE4', 'rate4')):
    x = E[col].values; rho, ci, se = rho_boot(x, y, E.date.values, rng, CIQ, B); pr = np.array([np.corrcoef(rankdata(x[pick()]), rankdata(y))[0, 1] for _ in range(NPLC)])
    h1, h2 = (np.corrcoef(rankdata(x[~half]), rankdata(y[~half]))[0, 1], np.corrcoef(rankdata(x[half]), rankdata(y[half]))[0, 1]); res[name] = (rho, ci, se, h1, h2, np.percentile(np.abs(pr), 97.5))
it = E.init.values; ci3, se3 = boot_contrast(M, it); c3 = contrast(y, E.hv.values, it, M); pc = []
for _ in range(NPLC):
    pk = pick(); pc.append(contrast(y, E.hv.values[pk], it[pk], M))
pc = np.array(pc); h1c, h2c = contrast(y, E.hv.values, it, M & ~half), contrast(y, E.hv.values, it, M & half); res['T3 contrast'] = (c3, ci3, se3, h1c, h2c, np.nanpercentile(np.abs(pc), 97.5))
print('\nDETECTABLE (2.8 x SE), printed before the verdicts: ' + '; '.join(f'{k}: {2.8 * v[2]:.3f}' + (' rho' if k != 'T3 contrast' else ' y-units (s)') for k, v in res.items()))
print('\nCOUNTED TESTS (CI 98.33% Bonferroni 3, day-block; placebo = feature taken from a random event of another date, same level type and direction):')
for k, (c, ci, se, h1, h2, p97) in res.items():
    lead = (ci[0] > 0 or ci[1] < 0) and np.sign(h1) == np.sign(h2) == np.sign(c) and abs(c) > p97
    print(f'  {k:12s} stat {c:+.3f} CI [{ci[0]:+.3f}, {ci[1]:+.3f}] | halves {h1:+.3f} / {h2:+.3f} | placebo 97.5th pct of |stat| {p97:.3f} => ' + ('LEAD' if lead else 'NOT SHOWN'))
print('\nREPORTED (not counted):')
print(f'  controls: rho(VOLR, y) {np.corrcoef(rankdata(E.volr), rankdata(y))[0, 1]:+.3f}, rho(window range / s, y) {np.corrcoef(rankdata(E.rng_s), rankdata(y))[0, 1]:+.3f}; rho(RATE3, y) within VOLR terciles: ' + ' '.join(f'{np.corrcoef(rankdata(g.rate3), rankdata(g.y))[0, 1]:+.3f}' for _, g in E.groupby(pd.qcut(E.volr.rank(method="first"), 3, labels=False))))
print('  rho(RATE3, y) by LEVEL TYPE and direction (N): ' + '; '.join(f'{k[0]}{"+" if k[1] == 1 else "-"} {np.corrcoef(rankdata(E.rate3.values[v]), rankdata(y[v]))[0, 1]:+.3f} (N={len(v)})' for k, v in sorted(grp.items())))
print('  by level type: ' + '; '.join(f'{lt}: rho {np.corrcoef(rankdata(g.rate3), rankdata(g.y))[0, 1]:+.3f} N={len(g)}' for lt, g in E.groupby('ltype')))
cs = contrast(y, E.hv.values, E.has_stack.values, M); n1 = int((M & E.hv.values & E.has_stack.values).sum()); print(f'  T3 with an aligned STACK (3:1) as the initiative cell: contrast {cs:+.3f} (N initiative {n1}; undefined below 5)')
print(f'  LOC: rho(share of aligned imbalances beyond the level, y) {np.corrcoef(rankdata(E.loc3[E.loc3.notna()]), rankdata(y[E.loc3.notna().values]))[0, 1]:+.3f} (N={int(E.loc3.notna().sum())}); FAIL rate {100 * E.fail.mean():.0f}% (too loose to use)')
