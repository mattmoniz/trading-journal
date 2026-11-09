"""Delta at the stall (docs/TELL_STALL_DELTA_PREREG_20261104.md): do three up/down-tick delta readings (Sierra's rule, cumulative sum reset 18:00 ET) at the first stall minute (L = 11) of the 1,760 explore tell entries separate the next 60 minutes' continuation from reversal? Reads only date, dir, ehr of the entries plus bars and the per-minute up/down volume; shares stall_lib.py with tell_stall_features.py.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_stall_delta.py   (the look is logged first, hr-023)"""
import os, sys, csv
import numpy as np, pandas as pd
from scipy.stats import rankdata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stall_lib import REPO, NOW, LATE_W, HORIZON, load_bars, load_entries, stall_L, find_stall, outcome_y, rho_boot
rng = np.random.default_rng(20261104)
FEATS = ['DSHARE', 'SINCE_EXT', 'DIV']; CIQ = (0.835, 99.165)            # Bonferroni 0.05 / 3
BAR = load_bars(); E = load_entries(BAR)
L, gaps = stall_L(E, BAR, 90); L3, _ = stall_L(E, BAR, 75)
print(f'{len(E)} entries; stall L = {L} minutes (p90 of the gaps; the first test used the same), sensitivity L = {L3}')

UD = {}                                                              # date -> dict(up, dn, cum) per RTH minute (cum = cumulative net up/down-tick volume since 18:00 of the previous calendar day, end of minute)
udir = os.path.join(REPO, 'scratch', 'updown_1m_20261104')
for d in sorted(BAR):
    fp = os.path.join(udir, d + '.csv')
    if not os.path.exists(fp): continue
    up = np.full(390, np.nan); dn = np.full(390, np.nan); cum = np.full(390, np.nan); c = 0.0
    for r in csv.DictReader(open(fp)):
        c += int(r['up_vol']) - int(r['down_vol']); hh, mm = int(r['ts'][11:13]), int(r['ts'][14:16]); m = hh * 60 + mm - 570
        if r['ts'][:10] == d and 0 <= m < 390: up[m] = int(r['up_vol']); dn[m] = int(r['down_vol']); cum[m] = c
    s = pd.Series(cum).ffill().values
    if np.isnan(s[0]): continue
    UD[d] = dict(up=np.nan_to_num(up), dn=np.nan_to_num(dn), cum=s)
print(f'{len(UD)} of {len(BAR)} bar dates have extracted ticks; {int(E.date.isin(UD).sum())} of {len(E)} entries are on them')


def feats(date, em, e, ts, d, W=LATE_W):
    u = UD[date]; up, dn, cum = u['up'], u['dn'], u['cum']; cd = d * cum
    n0, l0 = ts - NOW + 1, ts - NOW + 1 - W
    if l0 < 0: return None
    share = lambda a, b: d * (up[a:b].sum() - dn[a:b].sum()) / max(1.0, up[a:b].sum() + dn[a:b].sum())
    net = up - dn; r5 = np.array([net[k - 4:k + 1].sum() for k in range(4, ts + 1)])
    scale5 = max(float(np.median(np.abs(r5))), 1.0)
    return dict(DSHARE=share(n0, ts + 1) - share(l0, n0), SINCE_EXT=(cd[ts] - cd[e]) / scale5, DIV=(cd[e] - cd[em:e + 1].max()) / scale5)


def build(Lx, W=LATE_W):
    rows = []
    for k, r in enumerate(E.itertuples()):
        if r.date not in UD: rows.append(None); continue
        b = BAR[r.date]; d = int(r.dir); st = find_stall(b, r.em, d, Lx)
        if st is None or st[0] + HORIZON > 385: rows.append(None); continue
        ts, best, e = st; f = feats(r.date, r.em, e, ts, d, W)
        if f is None: rows.append(None); continue
        sc = max(np.nanmedian(b['h'][:ts + 1] - b['l'][:ts + 1]), 0.25)
        f.update(y=outcome_y(b, ts, d, sc), ts=ts, e=e, k=k); rows.append(f)
    return rows


def placebo(rows):
    """The same features on the same minute positions (em, e, ts) from a random other date that has ticks."""
    dates = list(UD.keys()); out = []
    for i, f in enumerate(rows):
        if not f: out.append(None); continue
        r = E.iloc[i]; g = None
        for _ in range(50):
            d2 = dates[rng.integers(len(dates))]
            if d2 == r.date: continue
            g = feats(d2, int(r.em), int(f['e']), int(f['ts']), int(r.dir))
            if g: break
        out.append(g)
    return out


rows = build(L); ok = [i for i, f in enumerate(rows) if f]
print(f'entries with a stall, a full 60-minute horizon, history and extracted ticks: {len(ok)} of {len(E)} ({len(E) - len(ok)} excluded)')
R = pd.DataFrame([rows[i] for i in ok]); R['date'] = E.date.values[ok]; R['ehr'] = E.ehr.values[ok]
PL = placebo(rows); P = pd.DataFrame([PL[i] if PL[i] else {k: np.nan for k in FEATS} for i in ok])
print(f'stall minute median {R.ts.median():.0f} after the open; y median {R.y.median():+.2f} (positive = continues)')
dates = sorted(R.date.unique()); half = R.date.isin(dates[len(dates) // 2:]).values
print('\nDETECTABLE rho (2.8 x day-block SE) per feature, printed before the verdicts:'); res = {}
for f in FEATS:
    a = R[f].notna().values & P[f].notna().values
    rho, ci, se = rho_boot(R[f].values[a], R.y.values[a], R.date.values[a], rng, CIQ); prho, pci, _ = rho_boot(P[f].values[a], R.y.values[a], R.date.values[a], rng, CIQ)
    h1 = np.corrcoef(rankdata(R[f].values[a & ~half]), rankdata(R.y.values[a & ~half]))[0, 1]; h2 = np.corrcoef(rankdata(R[f].values[a & half]), rankdata(R.y.values[a & half]))[0, 1]
    res[f] = (rho, ci, prho, pci, h1, h2); print(f'  {f:10s} SE {se:.3f} detectable |rho| {2.8 * se:.3f}  (N={int(a.sum())})')
print('\nCOUNTED TESTS (Spearman rho feature vs y, CI 98.33% Bonferroni, day-block; placebo = same feature from another date):')
for f, (rho, ci, prho, pci, h1, h2) in res.items():
    lead = (ci[0] > 0 or ci[1] < 0) and np.sign(h1) == np.sign(h2) == np.sign(rho) and abs(rho) > abs(prho) and pci[0] <= 0 <= pci[1]
    print(f'  {f:10s} rho {rho:+.3f} CI [{ci[0]:+.3f}, {ci[1]:+.3f}] | placebo rho {prho:+.3f} CI [{pci[0]:+.3f}, {pci[1]:+.3f}] | halves {h1:+.3f} / {h2:+.3f} => ' + ('LEAD' if lead else 'NOT SHOWN'))
print('\nREPORTED (not counted): rho by entry hour; L = 3; DSHARE at W = 10 and 30; mean y by quintile')
fh = ((R.ehr >= 57600) & (R.ehr < 61200)).values
for f in FEATS: print(f'  {f:10s} 10:00-10:59 rho {np.corrcoef(rankdata(R[f][fh]), rankdata(R.y[fh]))[0, 1]:+.3f} (N={int(fh.sum())}) | later {np.corrcoef(rankdata(R[f][~fh]), rankdata(R.y[~fh]))[0, 1]:+.3f} (N={int((~fh).sum())})')
r3 = [g for g in build(L3) if g]; X = pd.DataFrame(r3); print(f'  L={L3}: N={len(X)} ' + ' '.join(f'{f} {np.corrcoef(rankdata(X[f]), rankdata(X.y))[0, 1]:+.3f}' for f in FEATS))
for W in (10, 30):
    rw = [g for g in build(L, W) if g]; X = pd.DataFrame(rw); print(f'  W={W}: N={len(X)} DSHARE {np.corrcoef(rankdata(X.DSHARE), rankdata(X.y))[0, 1]:+.3f}')
for f in FEATS:
    q = pd.qcut(R[f].rank(method='first'), 5, labels=False); print(f'  {f:10s} mean y by quintile (low->high): ' + ' '.join(f'{v:+.2f}' for v in R.groupby(q).y.mean().values))
R.drop(columns=['k']).to_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'stall_delta_rows.csv'), index=False)
