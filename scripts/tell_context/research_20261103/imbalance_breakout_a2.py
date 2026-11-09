"""PER-BAR footprint tests for docs/IMBALANCE_BREAKOUT_PREREG_20261104.md sections 11 and A2b: T4 rho(BNET3, y), T5 rho(BNET4, y), T6 rank contrast initiative vs absorption among fast-tape events. Reads imbalance_events_a2.csv (imbalance_events.py --a2). Family total 6 counted tests, CI 99.17 percent. Same bootstrap and placebo scheme as imbalance_breakout.py.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/imbalance_breakout_a2.py   (look 170 is logged first, hr-023)"""
import os, sys
import numpy as np, pandas as pd
from scipy.stats import rankdata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stall_lib import REPO, rho_boot
rng = np.random.default_rng(20261104); B, NPLC = 4000, 1000; CIQ = (0.417, 99.583)                              # Bonferroni 0.05 / 6
E = pd.read_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'imbalance_events_a2.csv')).sort_values(['date', 't']).reset_index(drop=True); N = len(E)
E['hv_cut'] = [np.median(E.volr.values[:i]) if i >= 30 else np.nan for i in range(N)]; E['bn_cut'] = [np.median(E.bnet3.values[:i]) if i >= 30 else np.nan for i in range(N)]
E['hv'] = E.volr >= E.hv_cut; E['init'] = E.bnet3 > E.bn_cut; ok = E.hv_cut.notna().values; y = E.y.values; yr = rankdata(y) / N - 0.5
print(f'{N} breakout events on {E.date.nunique()} sessions; events with the expanding cuts: {int(ok.sum())}')
print('\nDESCRIPTIVE (per-bar footprint, 20-bar windows): aligned stacks per window mean ' + f'{E.bsa3.mean():.1f} (3:1), {E.bsa4.mean():.1f} (4:1); opposed {E.bso3.mean():.1f}, {E.bso4.mean():.1f}; bars with an aligned stack per window {E.bbars3.mean():.1f} of 20; windows with >= 1 aligned stack {100 * (E.bsa3 > 0).mean():.0f}% (3:1), {100 * (E.bsa4 > 0).mean():.0f}% (4:1); share of aligned stacks beyond the level {E.bloc3.mean():.2f}; MINVOL median {E.bminvol.median():.0f} contracts')
print(f'  mean y by tercile of BNET3 (low->high): ' + ' '.join(f'{v:+.2f}' for v in E.groupby(pd.qcut(E.bnet3.rank(method="first"), 3, labels=False)).y.mean().values) + '; by LEVEL TYPE rho(BNET3, y): ' + '; '.join(f'{lt} {np.corrcoef(rankdata(g.bnet3), rankdata(g.y))[0, 1]:+.3f} (N={len(g)})' for lt, g in E.groupby('ltype')))
dates = sorted(E.date.unique()); half = E.date.isin(dates[len(dates) // 2:]).values; grp = {k: np.where((E.ltype == k[0]).values & (E.d == k[1]).values)[0] for k in {(a, b) for a, b in zip(E.ltype, E.d)}}
cand = [grp[(l, d_)][E.date.values[grp[(l, d_)]] != dt] for l, d_, dt in zip(E.ltype, E.d, E.date)]
def pick(): return np.array([c[int(u * len(c))] if len(c) else i for i, (c, u) in enumerate(zip(cand, rng.random(N)))])
def rank_contrast(m, init, v=None):
    v = yr if v is None else v; a, b = m & E.hv.values & init, m & E.hv.values & ~init; return float(v[a].mean() - v[b].mean()) if a.sum() >= 5 and b.sum() >= 5 else np.nan
def boot_contrast(m, init):
    idx = list(pd.Series(np.where(m)[0]).groupby(E.date.values[m]).apply(np.array).values); out = np.empty(B); hv = E.hv.values
    for k in range(B):
        p = np.concatenate([idx[j] for j in rng.integers(0, len(idx), len(idx))]); a, b = yr[p][hv[p] & init[p]], yr[p][hv[p] & ~init[p]]; out[k] = (a.mean() - b.mean()) if len(a) >= 5 and len(b) >= 5 else np.nan
    return np.nanpercentile(out, CIQ), float(np.nanstd(out))
res = {}
for name, col in (('T4 BNET3', 'bnet3'), ('T5 BNET4', 'bnet4')):
    x = E[col].values; rho, ci, se = rho_boot(x, y, E.date.values, rng, CIQ, B); pr = np.array([np.corrcoef(rankdata(x[pick()]), rankdata(y))[0, 1] for _ in range(NPLC)])
    res[name] = (rho, ci, se, np.corrcoef(rankdata(x[~half]), rankdata(y[~half]))[0, 1], np.corrcoef(rankdata(x[half]), rankdata(y[half]))[0, 1], np.percentile(np.abs(pr), 97.5))
init = E.init.values; ci6, se6 = boot_contrast(ok, init); c6 = rank_contrast(ok, init); pc = np.array([rank_contrast(ok, init[pk]) if False else (lambda pk: (lambda a, b: (yr[a].mean() - yr[b].mean()) if a.sum() >= 5 and b.sum() >= 5 else np.nan)(ok & E.hv.values[pk] & init[pk], ok & E.hv.values[pk] & ~init[pk]))(pick()) for _ in range(NPLC)])
res['T6 rank contrast'] = (c6, ci6, se6, rank_contrast(ok & ~half, init), rank_contrast(ok & half, init), np.nanpercentile(np.abs(pc), 97.5))
print('\nDETECTABLE (2.8 x SE), printed before the verdicts: ' + '; '.join(f'{k}: {2.8 * v[2]:.3f}' for k, v in res.items()) + ' (rho for T4/T5; normalised-rank units for T6)')
print('\nCOUNTED TESTS (family of 6, CI 99.17% day-block; placebo = feature of a random event of another date, same level type and direction):')
for k, (c, ci, se, h1, h2, p97) in res.items():
    lead = (ci[0] > 0 or ci[1] < 0) and np.sign(h1) == np.sign(h2) == np.sign(c) and abs(c) > p97
    print(f'  {k:18s} stat {c:+.3f} CI [{ci[0]:+.3f}, {ci[1]:+.3f}] | halves {h1:+.3f} / {h2:+.3f} | placebo 97.5th pct of |stat| {p97:.3f} => ' + ('LEAD' if lead else 'NOT SHOWN'))
print('\nREPORTED (not counted):')
print(f'  controls: rho(VOLR, y) {np.corrcoef(rankdata(E.volr), rankdata(y))[0, 1]:+.3f}, rho(window range / s, y) {np.corrcoef(rankdata(E.rng_s), rankdata(y))[0, 1]:+.3f}; rho(BNET3, y) within VOLR terciles: ' + ' '.join(f'{np.corrcoef(rankdata(g.bnet3), rankdata(g.y))[0, 1]:+.3f}' for _, g in E.groupby(pd.qcut(E.volr.rank(method="first"), 3, labels=False))))
print('  rho(BNET3, y) by level type and direction (N): ' + '; '.join(f'{k[0]}{"+" if k[1] == 1 else "-"} {np.corrcoef(rankdata(E.bnet3.values[v]), rankdata(y[v]))[0, 1]:+.3f} (N={len(v)})' for k, v in sorted(grp.items())) + '  [nine looks in all, uncorrected; read as noise unless they replicate]')
print(f'  old cell: at least one aligned stack among fast-tape events: N={int((ok & E.hv.values & (E.bsa3.values > 0)).sum())} vs none: N={int((ok & E.hv.values & (E.bsa3.values == 0)).sum())}; rho(share of aligned stacks beyond the level, y) {np.corrcoef(rankdata(E.bloc3[E.bloc3.notna()]), rankdata(y[E.bloc3.notna().values]))[0, 1]:+.3f} (N={int(E.bloc3.notna().sum())})')
print('  initiative / absorption cells (fast tape; N, mean y): ' + '; '.join(f'{("initiative" if it else "absorption")}: N={len(g)} y {g.y.mean():+.2f}' for it, g in E[ok & E.hv.values].groupby('init')))
