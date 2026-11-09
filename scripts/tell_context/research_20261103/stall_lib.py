"""Shared pieces of the stall tests (docs/TELL_STALL_FEATURES_KILL_TEST_PREREG_20261104.md and docs/TELL_STALL_DELTA_PREREG_20261104.md): the 1-minute RTH bars, the explore entries (date, dir, ehr only), the stall rule, the 60-minute outcome and the day-block Spearman bootstrap. Extracted 2026-11-04 so the delta test reuses the exact code of the first test (cv-079)."""
import os, json
import numpy as np, pandas as pd
from scipy.stats import rankdata

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
NOW, LATE_W, HORIZON, MAXWAIT, B = 5, 20, 60, 120, 4000
RTH_OPEN_SEC = 55800                                 # ehr is seconds since the 18:00 Globex start; 09:30 = 55800


def load_bars():
    D = json.load(open(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'rth_1m_flow.json'))); BAR = {}
    for d, x in D.items():
        a = {k: np.full(390, np.nan) for k in ('o', 'h', 'l', 'c', 'v', 'b', 'a')}
        for i, m in enumerate(x['m']):
            for k in a: a[k][m] = x[k][i]
        BAR[d] = a
    return BAR


def load_entries(BAR):
    E = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_hold_value_trail_rows.csv'), usecols=['date', 'dir', 'ehr'])
    E['em'] = ((E.ehr - RTH_OPEN_SEC) // 60).astype(int)
    return E[(E.em >= 0) & (E.em < 380) & E.date.isin(BAR.keys())].reset_index(drop=True)


def walk(b, em, d):
    """Entry at the open of minute em; yield (minute, new_extreme_flag, best) up to MAXWAIT minutes."""
    best = b['o'][em]; out = []
    for j in range(em, min(em + MAXWAIT, 389) + 1):
        if np.isnan(b['h'][j]): continue
        p = b['h'][j] if d == 1 else b['l'][j]
        new = (p > best) if d == 1 else (p < best)
        if new: best = p
        out.append((j, new, best))
    return out


def stall_L(E, BAR, pct):
    """L = the pct-th percentile of the gaps (minutes) between successive new extremes, pooled over all entries' first MAXWAIT minutes."""
    gaps = []
    for r in E.itertuples():
        last = r.em
        for j, new, _ in walk(BAR[r.date], r.em, r.dir):
            if new: gaps.append(j - last); last = j
    gaps = np.array(gaps)
    return int(np.ceil(np.percentile(gaps, pct))), gaps


def find_stall(b, em, d, L):
    """First minute t* with no new extreme for L minutes. Returns (t*, best, e) where e is the minute of the last new extreme (em if none), or None."""
    last = em
    for j, new, bst in walk(b, em, d):
        if new: last = j
        if j - last >= L: return j, bst, last
    return None


def outcome_y(b, ts, d, s):
    """(max favourable - max adverse excursion over the next HORIZON minutes, from the close at ts, in the trade's direction) / s."""
    c0 = b['c'][ts]; hi = np.nanmax(b['h'][ts + 1:ts + HORIZON + 1]); lo = np.nanmin(b['l'][ts + 1:ts + HORIZON + 1])
    fav, adv = ((hi - c0), (c0 - lo)) if d == 1 else ((c0 - lo), (hi - c0))
    return (fav - adv) / s


def rho_boot(x, y, days, rng, q, n_boot=B):
    rx, ry = rankdata(x), rankdata(y); rho = np.corrcoef(rx, ry)[0, 1]
    idx = pd.Series(np.arange(len(x))).groupby(days).apply(np.array).values; m = np.empty(n_boot)
    for k in range(n_boot):
        p = np.concatenate(idx[rng.integers(0, len(idx), len(idx))]); m[k] = np.corrcoef(rx[p], ry[p])[0, 1]
    return rho, np.percentile(m, q), float(np.std(m))
