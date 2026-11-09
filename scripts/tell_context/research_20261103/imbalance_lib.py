"""Footprint helpers for docs/IMBALANCE_BREAKOUT_PREREG_20261104.md: load a session's 500-contract bars and per-bar price cells, aggregate a run of bars into a window footprint, find diagonal imbalances and stacks. Pure functions, explore data only."""
import os, json
import numpy as np
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028')
TICK = 0.25; RTH0, IB1, RTH1 = 55800.0, 59400.0, 79200.0; WIN = 20                       # seconds since the 18:00 open: 09:30, 10:30, 16:00; window = 20 bars


def explore_dates():
    F = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json')))
    return [d for d in sorted(F) if os.path.exists(f'{ROOT}/{d}.bars.tsv') and os.path.exists(f'{ROOT}/{d}.vap.tsv')]


def load(d):
    b = np.loadtxt(f'{ROOT}/{d}.bars.tsv', delimiter='\t', ndmin=2); v = np.loadtxt(f'{ROOT}/{d}.vap.tsv', delimiter='\t', ndmin=2); bi = v[:, 0].astype(int)
    ptr = np.searchsorted(bi, np.arange(len(b) + 1)); S = dict(d=d, start=b[:, 1], end=b[:, 2], o=b[:, 3], h=b[:, 4], l=b[:, 5], c=b[:, 6], vol=b[:, 7], n=len(b))
    S['bin'] = np.round(v[:, 1] / TICK).astype(int); S['bid'] = v[:, 3]; S['ask'] = v[:, 4]; S['ptr'] = ptr; return S


def agg(S, i0, i1):
    """Window footprint over bars i0..i1 inclusive: (lowest bin, ask array, bid array)."""
    a, b = S['ptr'][i0], S['ptr'][i1 + 1]; bins = S['bin'][a:b]; lo = int(bins.min()); n = int(bins.max()) - lo + 1
    ask = np.bincount(bins - lo, weights=S['ask'][a:b], minlength=n); bid = np.bincount(bins - lo, weights=S['bid'][a:b], minlength=n); return lo, ask, bid


def imbalances(ask, bid, R, minbuy, minsell):
    """Boolean arrays (buy, sell) per price bin: buy at P if ask(P) >= R x bid(P-1) and ask(P) >= minbuy; sell at P if bid(P) >= R x ask(P+1) and bid(P) >= minsell."""
    buy = np.zeros(len(ask), bool); sell = np.zeros(len(ask), bool)
    buy[1:] = (ask[1:] >= R * bid[:-1]) & (ask[1:] >= minbuy) & (ask[1:] > 0); sell[:-1] = (bid[:-1] >= R * ask[1:]) & (bid[:-1] >= minsell) & (bid[:-1] > 0); return buy, sell


def stacks(flag, k=3):
    """Number of runs of at least k consecutive True values."""
    if not flag.any(): return 0
    x = np.concatenate([[0], flag.astype(int), [0]]); d = np.diff(x); s = np.where(d == 1)[0]; e = np.where(d == -1)[0]; return int(((e - s) >= k).sum())


def stack_runs(flag, k=3):
    """(start, end) index pairs (inclusive) of runs of at least k consecutive True values."""
    if not flag.any(): return []
    x = np.concatenate([[0], flag.astype(int), [0]]); d = np.diff(x); st = np.where(d == 1)[0]; en = np.where(d == -1)[0]; return [(int(a), int(b) - 1) for a, b in zip(st, en) if b - a >= k]
