"""Overnight inventory vs the first hour of the RTH day (docs/OVERNIGHT_INVENTORY_PREREG_20261104.md). Explore only, 2 counted tests, one observation per session. Features use ticks through 09:29 only; the outcome is read after.
NOTE (2026-11-04, found after the run): the sign-permutation placebo below is INVALID by construction (permuting s flips S and R together, so the contrast is almost constant = -(m1+m2); its 97.5th percentile of 0.011 is not a null). The verdicts rest on the week-block CIs; see the prereg RESULT section.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/overnight_inventory.py   (look 166 is logged first, hr-023)"""
import os, sys, csv, datetime
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stall_lib import REPO, load_bars
rng = np.random.default_rng(20261104); B, NPERM = 4000, 1000; CIQ = (1.25, 98.75)            # Bonferroni 0.05 / 2
BAR = load_bars(); dates = sorted(BAR); udir = os.path.join(REPO, 'scratch', 'updown_1m_20261104')


def overnight(d):
    """(I, vwap, n_minutes) from the per-minute up/down file: minutes before 09:30 of the trade date (the file starts at 18:00 of the previous calendar day)."""
    fp = os.path.join(udir, d + '.csv')
    if not os.path.exists(fp): return None
    up = dn = pv = vv = 0.0; n = 0
    for r in csv.DictReader(open(fp)):
        if r['ts'][:10] == d and r['ts'][11:16] >= '09:30': break
        u, k, v = int(r['up_vol']), int(r['down_vol']), int(r['volume']); up += u; dn += k; pv += float(r['close']) * v; vv += v; n += 1
    if n < 200 or up + dn == 0 or vv == 0: return None
    return (up - dn) / (up + dn), pv / vv, n


rows = []; excl = dict(early=0, no_ticks=0, no_bars=0)
rng_by = {d: float(np.nanmax(BAR[d]['h']) - np.nanmin(BAR[d]['l'])) for d in dates}
for i, d in enumerate(dates):
    if i < 20: excl['early'] += 1; continue
    ov = overnight(d)
    if ov is None: excl['no_ticks'] += 1; continue
    b = BAR[d]; pb = BAR[dates[i - 1]]
    if np.isnan(b['o'][0]) or np.isnan(b['c'][59]) or np.isnan(b['c'][29]): excl['no_bars'] += 1; continue
    pc = pb['c'][~np.isnan(pb['c'])][-1]; adr = float(np.median([rng_by[x] for x in dates[i - 20:i]]))
    I, vw, _ = ov; s = 1 if I > 0 else -1 if I < 0 else 0
    if s == 0: continue
    op = float(b['o'][0]); hi60 = np.nanmax(b['h'][:60]); lo60 = np.nanmin(b['l'][:60])
    rows.append(dict(date=d, I=I, s=s, vwap=vw, open=op, adr=adr, gap=(op - pc) / adr, D=(vw - op) / adr, S=s * (vw - op) / adr,
                     R=-s * (b['c'][59] - op) / adr, R30=-s * (b['c'][29] - op) / adr, filled=bool(lo60 <= pc <= hi60)))
R = pd.DataFrame(rows); R['wk'] = pd.to_datetime(R.date).dt.strftime('%G-%V')
print(f'{len(R)} sessions (excluded: {excl}); S>0 (underwater at the open) {int((R.S > 0).sum())}, S<0 (validated) {int((R.S < 0).sum())}; long inventory {int((R.s == 1).sum())}, short {int((R.s == -1).sum())}')


def contrast(df, s=None, S=None, Rv=None):
    S = df.S.values if S is None else S; Rv = df.R.values if Rv is None else Rv
    a, b = Rv[S > 0], Rv[S < 0]
    return (a.mean() - b.mean()) if len(a) > 5 and len(b) > 5 else np.nan


def week_boot(df):
    wk = df.groupby('wk').indices; keys = list(wk); idx = [wk[k] for k in keys]; m = np.empty(B)
    for k in range(B):
        p = np.concatenate([idx[j] for j in rng.integers(0, len(idx), len(idx))]); m[k] = contrast(df.iloc[p])
    return np.nanpercentile(m, CIQ), float(np.nanstd(m))


R['mv'] = -R.R * R.s                                                                      # (close - open) / ADR, the signed first-hour move
def perm_null(df):
    return np.array([contrast(df, S=sp * df.D.values, Rv=-sp * df.mv.values) for sp in (rng.permutation(df.s.values) for _ in range(NPERM))])


I_abs = R.I.abs().values; ext = np.zeros(len(R), bool)
for k in range(60, len(R)): ext[k] = I_abs[k] >= np.percentile(I_abs[:k], 67)
tests = [('T1 all sessions', R), ('T2 extreme inventory (expanding 67th pct)', R[ext])]
half_cut = R.date.iloc[len(R) // 2]
print('\nDETECTABLE contrast (2.8 x week-block SE), printed before the verdicts:'); res = []
for lab, df in tests:
    ci, se = week_boot(df); res.append((lab, df, ci, se)); print(f'  {lab:42s} N={len(df):4d} (S>0 {int((df.S > 0).sum())}, S<0 {int((df.S < 0).sum())}) SE {se:.3f} detectable {2.8 * se:.3f} ADR')
print('\nCOUNTED TESTS: mean R (S>0) minus mean R (S<0), ADR units; CI 97.5% week-block; placebo = sign-permuted contrast')
for lab, df, ci, se in res:
    c = contrast(df); h1 = contrast(df[df.date < half_cut]); h2 = contrast(df[df.date >= half_cut]); pn = perm_null(df); p97 = np.nanpercentile(np.abs(pn), 97.5)
    lead = (ci[0] > 0 or ci[1] < 0) and np.sign(h1) == np.sign(h2) == np.sign(c) and abs(c) > p97
    print(f'  {lab:42s} contrast {c:+.3f} CI [{ci[0]:+.3f}, {ci[1]:+.3f}] | halves {h1:+.3f} / {h2:+.3f} | placebo 97.5th pct of |contrast| {p97:.3f} (permuted mean {np.nanmean(pn):+.3f}) => ' + ('LEAD' if lead else 'NOT SHOWN'))
print('\nREPORTED (not counted):')
print(f'  mean R by stress quintile (low = validated ... high = underwater): ' + ' '.join(f'{v:+.3f}' for v in R.groupby(pd.qcut(R.S.rank(method="first"), 5, labels=False)).R.mean().values))
print(f'  first 30 minutes: S>0 minus S<0 contrast {contrast(R, Rv=R.R30.values):+.3f}')
print(f'  inventory sign alone: mean R long inventory {R[R.s == 1].R.mean():+.3f} (N={int((R.s == 1).sum())}), short {R[R.s == -1].R.mean():+.3f} (N={int((R.s == -1).sum())}); stress sign alone: mean R S>0 {R[R.S > 0].R.mean():+.3f}, S<0 {R[R.S < 0].R.mean():+.3f}; overall mean R {R.R.mean():+.3f}')
g = R.copy(); g['aligned'] = np.sign(g.gap) == g.s
for lab, m in (('gap aligned with inventory', g.aligned & (g.gap != 0)), ('gap against inventory', ~g.aligned & (g.gap != 0))):
    x = g[m]; print(f'  gap-fill within the first hour, {lab}: N={len(x)} fill {100 * x.filled.mean():.0f}% (S>0: {100 * x[x.S > 0].filled.mean():.0f}% N={int((x.S > 0).sum())}; S<0: {100 * x[x.S < 0].filled.mean():.0f}% N={int((x.S < 0).sum())})')
R.drop(columns=['wk']).to_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'overnight_inventory_rows.csv'), index=False)
