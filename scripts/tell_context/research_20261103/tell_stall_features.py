"""Kill test for the trade-watcher idea (docs/TELL_STALL_FEATURES_KILL_TEST_PREREG_20261104.md): do NOW-versus-LATELY tape readings at the first stall minute of the 1,760 explore tell entries separate the next 60 minutes' continuation from reversal? Reads ONLY date, dir and ehr of the entry rows plus 1-minute bars; no V1 result column.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_stall_features.py   (look 162 is logged first, hr-023)"""
import os, sys, json
import numpy as np, pandas as pd
from scipy.stats import rankdata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stall_lib import REPO, NOW, LATE_W, HORIZON, MAXWAIT, B, load_bars, load_entries, walk, stall_L, find_stall, outcome_y, rho_boot as _rho_boot
rng = np.random.default_rng(20261104)
FEATS = ['VOL', 'ADV_SHARE', 'RPC', 'EFFORT', 'PULLBACK']
PCT = float(sys.argv[1]) if len(sys.argv) > 1 else 75.0                        # stall = no new extreme for the PCT-th percentile of the gaps; 75 = first run, 90 = amendment A1 (CI then Bonferroni over 10 tests)
CIQ = (0.5, 99.5) if PCT == 75.0 else (0.25, 99.75)
TAG = '' if PCT == 75.0 else f'_p{int(PCT)}'

BAR = load_bars(); E = load_entries(BAR)
print(f'{len(E)} entries with a bar session')
L, gaps = stall_L(E, BAR, PCT)
print(f'gaps between successive new extremes: N={len(gaps)} median {np.median(gaps):.0f} p{PCT:.0f} {np.percentile(gaps, PCT):.1f} p90 {np.percentile(gaps, 90):.0f} minutes -> L = {L} minutes (stall = no new extreme for L minutes)')


def feats(b, t, d, W):
    """Causal readings at minute t (bars up to and including t). NOW = last 5 minutes, LATELY = the W minutes before that."""
    n0, l0 = t - NOW + 1, t - NOW + 1 - W
    if l0 < 0 or np.isnan(b['c'][l0:t + 1]).any(): return None
    s = max(np.nanmedian(b['h'][:t + 1] - b['l'][:t + 1]), 0.25)
    sl_n, sl_l = slice(n0, t + 1), slice(l0, n0)
    vn, vl = b['v'][sl_n], b['v'][sl_l]
    adv = (lambda sl: (b['b'][sl].sum() if d == 1 else b['a'][sl].sum()) / (b['b'][sl].sum() + b['a'][sl].sum()))
    rpc = lambda sl: (b['h'][sl] - b['l'][sl]).sum() / b['v'][sl].sum()
    eff = lambda sl, c1, c0, n: b['v'][sl].mean() / (abs(c1 - c0) / n + s)
    return dict(VOL=np.log(vn.mean() / vl.mean()), ADV_SHARE=adv(sl_n) - adv(sl_l), RPC=np.log(rpc(sl_n) / rpc(sl_l)),
                EFFORT=np.log(eff(sl_n, b['c'][t], b['c'][n0 - 1], NOW) / eff(sl_l, b['c'][n0 - 1], b['c'][l0 - 1] if l0 > 0 else b['o'][0], W)), s=s)


def build(W):
    rows = []
    for k, r in enumerate(E.itertuples()):
        b = BAR[r.date]; d = int(r.dir); st = find_stall(b, r.em, d, L)
        if st is None or st[0] + HORIZON > 385: rows.append(None); continue
        ts, best, _ = st; f = feats(b, ts, d, W)
        if f is None: rows.append(None); continue
        c0 = b['c'][ts]
        f.update(PULLBACK=((best - c0) if d == 1 else (c0 - best)) / f['s'], y=outcome_y(b, ts, d, f['s']), ts=ts, k=k)
        rows.append(f)
    return rows


def placebo(rows, W):
    """The same features at the same minute-of-session from a random OTHER date (PULLBACK: another date's entry value)."""
    dates = list(BAR.keys()); out = []
    ok = [i for i, f in enumerate(rows) if f]
    for i, f in enumerate(rows):
        if not f: out.append(None); continue
        r = E.iloc[i]; g = None
        for _ in range(50):
            d2 = dates[rng.integers(len(dates))]
            if d2 == r.date: continue
            g = feats(BAR[d2], f['ts'], int(r.dir), W)
            if g: break
        j = ok[rng.integers(len(ok))]
        while E.date.iloc[j] == r.date: j = ok[rng.integers(len(ok))]
        if g: g['PULLBACK'] = rows[j]['PULLBACK']
        out.append(g)
    return out


def rho_boot(x, y, days): return _rho_boot(x, y, days, rng, CIQ)


rows = build(LATE_W); ok = [i for i, f in enumerate(rows) if f]
print(f'stall found with a full 60-minute horizon and enough history: {len(ok)} of {len(E)} entries ({len(E) - len(ok)} excluded: no stall within {MAXWAIT} min, too close to 15:55, or too little history)')
R = pd.DataFrame([rows[i] for i in ok]); R['date'] = E.date.values[ok]; R['ehr'] = E.ehr.values[ok]
P = pd.DataFrame([g if g else {k: np.nan for k in FEATS} for g in (placebo(rows, LATE_W)[i] for i in ok)])
print(f'stall minute (minutes after 09:30) median {R.ts.median():.0f}; typical bar s median {R.s.median():.2f} points; y median {R.y.median():+.2f} (positive = continues)')
dates = sorted(R.date.unique()); half = R.date.isin(dates[len(dates) // 2:]).values
print('\nDETECTABLE rho (2.8 x day-block SE) per feature, printed before the verdicts:')
res = {}
for f in FEATS:
    ok2 = R[f].notna().values & P[f].notna().values
    rho, ci, se = rho_boot(R[f].values[ok2], R.y.values[ok2], R.date.values[ok2]); prho, pci, pse = rho_boot(P[f].values[ok2], R.y.values[ok2], R.date.values[ok2])
    h1 = np.corrcoef(rankdata(R[f].values[ok2 & ~half]), rankdata(R.y.values[ok2 & ~half]))[0, 1]; h2 = np.corrcoef(rankdata(R[f].values[ok2 & half]), rankdata(R.y.values[ok2 & half]))[0, 1]
    res[f] = (rho, ci, se, prho, pci, h1, h2, int(ok2.sum())); print(f'  {f:10s} SE {se:.3f} detectable |rho| {2.8 * se:.3f}  (N={int(ok2.sum())})')
print('\nCOUNTED TESTS (Spearman rho feature vs y, CI Bonferroni, day-block; placebo = same feature from another date):')
for f, (rho, ci, se, prho, pci, h1, h2, n) in res.items():
    lead = (ci[0] > 0 or ci[1] < 0) and np.sign(h1) == np.sign(h2) == np.sign(rho) and abs(rho) > abs(prho) and pci[0] <= 0 <= pci[1]
    print(f'  {f:10s} rho {rho:+.3f} CI [{ci[0]:+.3f}, {ci[1]:+.3f}] | placebo rho {prho:+.3f} CI [{pci[0]:+.3f}, {pci[1]:+.3f}] | halves {h1:+.3f} / {h2:+.3f} => ' + ('LEAD' if lead else 'NOT SHOWN'))
print('\nREPORTED (not counted): rho by entry hour; W sensitivity; quintile means of y')
fh = ((R.ehr >= 57600) & (R.ehr < 61200)).values
for f in FEATS:
    a = pd.Series(R[f]).notna().values
    print(f'  {f:10s} 10:00-10:59 rho {np.corrcoef(rankdata(R[f][a & fh]), rankdata(R.y[a & fh]))[0, 1]:+.3f} (N={int((a & fh).sum())}) | later {np.corrcoef(rankdata(R[f][a & ~fh]), rankdata(R.y[a & ~fh]))[0, 1]:+.3f} (N={int((a & ~fh).sum())})')
for W in (10, 30):
    r2 = build(W); ok3 = [i for i, g in enumerate(r2) if g]; X = pd.DataFrame([r2[i] for i in ok3])
    print(f'  W={W}: N={len(X)} ' + ' '.join(f'{f} {np.corrcoef(rankdata(X[f]), rankdata(X.y))[0, 1]:+.3f}' for f in FEATS))
for f in FEATS:
    q = pd.qcut(R[f], 5, labels=False, duplicates='drop'); print(f'  {f:10s} mean y by quintile (low->high): ' + ' '.join(f'{v:+.2f}' for v in R.groupby(q).y.mean().values))
R.drop(columns=['k']).to_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', f'stall_features_rows{TAG}.csv'), index=False)
