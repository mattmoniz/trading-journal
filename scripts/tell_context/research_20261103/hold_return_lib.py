"""Shared functions of the hold-or-return test (docs/B_D_HOLD_OR_RETURN_PREREG_20261103.md and the 13:30 sealed prereg): load a session, classify HELD / RETURNED / STAYED at a decision time from bars completed by T only, and the stats (risk difference, Mantel-Haenszel, week-block bootstrap, within-month permutation). One implementation for the explore run and the sealed run (hr-022)."""
import os, sys, glob, json, datetime, itertools
import numpy as np
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context')); import profile_shape as PS
ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028'); RTH0, RTH1 = 55800.0, 79200.0
CUT = json.load(open(os.path.join(REPO, 'scripts', 'tell_context', 'shape_cuts.json')))['bimod_top_tercile_cut']
rng = np.random.default_rng(11)

def secs(hh): return RTH0 + (hh - 9.5) * 3600.0
def load(p):
    b = np.loadtxt(p, delimiter='\t', ndmin=2); v = np.loadtxt(p.replace('.bars.', '.vap.'), delimiter='\t', ndmin=2); m = (b[:, 2] >= RTH0) & (b[:, 2] < RTH1)
    if m.sum() < 100: return None
    x = b[m]; idx = x[:, 0].astype(int); vv = v[np.isin(v[:, 0].astype(int), idx)]; vv = vv[np.argsort(vv[:, 0], kind='stable')]
    return dict(end=x[:, 2], h=x[:, 4], l=x[:, 5], c=x[:, 6], idx=idx, vidx=vv[:, 0].astype(int), px=vv[:, 1], vol=vv[:, 2])

def classify(S, T, back, hold, mfac):
    """-> dict(cls in STAYED/HELD/RETURNED/NA, side, outside_share, flag_at_T) from bars completed by T only."""
    end = S['end']; n0 = int(np.searchsorted(end, secs(T) - back * 60, side='right')); nT = int(np.searchsorted(end, secs(T), side='right'))
    if n0 < 20 or nT <= n0: return dict(cls='NA')
    m0 = int(np.searchsorted(S['vidx'], S['idx'][n0 - 1], side='right')); mT = int(np.searchsorted(S['vidx'], S['idx'][nT - 1], side='right'))
    f = PS.features(S['px'][:m0], S['vol'][:m0]); g = PS.features(S['px'][:mT], S['vol'][:mT])
    if f is None or g is None: return dict(cls='NA')
    ext = f['hi'] - f['lo']; val, vah = f['lo'] + f['val'] * ext, f['lo'] + f['vah'] * ext; margin = mfac * float(np.median(S['h'][:n0] - S['l'][:n0]))
    cc = S['c'][n0:nT]; e = end[n0:nT]; up = cc > vah + margin; dn = cc < val - margin; dep = np.where(up | dn)[0]; flag = bool(g['bimod'] >= CUT)
    if not len(dep): return dict(cls='STAYED', flag=flag)
    side = 'UP' if up[dep[0]] else 'DOWN'; last = e > secs(T) - hold * 60
    held = bool(last.any() and (np.all(cc[last] > vah) if side == 'UP' else np.all(cc[last] < val)))
    wid = vah - val; exc = float(((cc - vah).max() if side == 'UP' else (val - cc).max()) / max(wid, 1e-9))     # furthest close beyond the frozen edge in the window, in value-area widths (known by T)
    pr, vl = S['px'][m0:mT], S['vol'][m0:mT]; outs = float(vl[(pr > vah) if side == 'UP' else (pr < val)].sum() / max(vl.sum(), 1e-9))
    return dict(cls='HELD' if held else 'RETURNED', side=side, outside=outs, flag=flag, exc=exc)

def week(d): y, w, _ = datetime.date.fromisoformat(d).isocalendar(); return f'{y}-{w}'
def rd(rows, key='y'):
    h = [r[key] for r in rows if r['cls'] == 'HELD']; t = [r[key] for r in rows if r['cls'] == 'RETURNED']
    return (np.mean(h) - np.mean(t)) if h and t else np.nan
def mh(rows, key=lambda r: (r['flag'], r['xb'])):          # Mantel-Haenszel weighted risk difference; strata = developing flag at T x tercile of the excursion size (amendment A1)
    num = den = 0.0
    for k in set(key(r) for r in rows):
        h = [r['y'] for r in rows if r['cls'] == 'HELD' and key(r) == k]; t = [r['y'] for r in rows if r['cls'] == 'RETURNED' and key(r) == k]
        if h and t: w = len(h) * len(t) / (len(h) + len(t)); num += w * (np.mean(h) - np.mean(t)); den += w
    return num / den if den else np.nan
def boot(rows, fn, B=2000):
    wk = {}; [wk.setdefault(r['week'], []).append(r) for r in rows]; keys = list(wk); out = []
    for _ in range(B):
        pick = rng.choice(len(keys), len(keys)); s = [r for i in pick for r in wk[keys[i]]]; v = fn(s)
        if not np.isnan(v): out.append(v)
    return (float(np.quantile(out, .025)), float(np.quantile(out, .975))) if len(out) > 100 else (np.nan, np.nan)
def perm(rows, B=2000):
    obs = rd(rows); mon = {}; [mon.setdefault(r['date'][:7], []).append(i) for i, r in enumerate(rows)]; ys = np.array([r['y'] for r in rows]); cnt = 0
    for _ in range(B):
        yy = ys.copy()
        for ix in mon.values(): yy[ix] = rng.permutation(yy[ix])
        s = [dict(r, y=int(yy[i])) for i, r in enumerate(rows)]; cnt += abs(rd(s)) >= abs(obs) - 1e-12
    return (cnt + 1) / (B + 1)


def pack_rows(Cd, dates, target):
    """HELD/RETURNED rows with the target, week key and the excursion tercile (terciles over the departed sample of the feature known at T; no outcome used)."""
    rows = [dict(Cd[d], date=d, week=week(d), y=target(d)) for d in dates if Cd[d]['cls'] in ('HELD', 'RETURNED')]
    cuts = np.quantile([r['exc'] for r in rows], [1 / 3, 2 / 3])
    for r in rows: r['xb'] = int(np.searchsorted(cuts, r['exc']))
    return rows
