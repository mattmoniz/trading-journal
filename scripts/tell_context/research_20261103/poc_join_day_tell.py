"""Are POC rotation joins a tell of the eventual kind of day? Pre-registration: docs/POC_JOIN_DAY_TELL_PREREG_20261104.md. Joins and 65-point rotations (export_poc_joins_20261104.mjs) vs the final RTH shape (exact 500-contract bars).
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/poc_join_day_tell.py"""
import os, sys, json, glob, datetime, collections
import numpy as np
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context')); import profile_shape as PS
EV = json.load(open(os.path.join(REPO, 'scratch', 'poc_join_day_tell_20261104', 'events.json'))); F = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json')))
RTH0, RTH1 = 55800.0, 79200.0; CUT, Q90, Q25 = 0.365, 0.61, 0.09; rng = np.random.default_rng(101)
SHP = {d: dict(bim=v['final']['bimod'], letter=v['final']['letter'], win='explore') for d, v in F.items()}
for p in sorted(glob.glob(os.path.join(REPO, 'scratch', 'volbars500_holdout_20261103', '*.bars.tsv'))):
    d = os.path.basename(p)[:10]; b = np.loadtxt(p, delimiter='\t', ndmin=2); v = np.loadtxt(p.replace('.bars.', '.vap.'), delimiter='\t', ndmin=2); ir = b[(b[:, 2] >= RTH0) & (b[:, 2] < RTH1), 0].astype(int)
    if len(ir) < 100: continue
    m = np.isin(v[:, 0].astype(int), ir); f = PS.features(v[m, 1], v[m, 2])
    if f: SHP[d] = dict(bim=f['bimod'], letter=PS.letter(f['va_mid']), win='holdout')
days = sorted(d for d in EV if d in SHP and not EV[d].get('skipped'))
def hm(s): return int(s[:2]) * 60 + int(s[3:5])
def cnt(lst, t): return sum(1 for x in lst if hm(x if isinstance(x, str) else x[0]) <= t)
rows = []
for d in days:
    j, r = EV[d]['joins'], EV[d]['rots']; s = SHP[d]
    rows.append(dict(d=d, win=s['win'], multi=s['bim'] >= CUT, pb=s['letter'] != 'D', sB=s['bim'] >= Q90, sD=(s['bim'] <= Q25 and s['letter'] == 'D'), letter=s['letter'], j_on=cnt(j, 569), j11=cnt(j, 660), j13=cnt(j, 780), jall=len(j), r_on=cnt(r, 569), r11=cnt(r, 660), r13=cnt(r, 780), rall=len(r),
                     nlong=sum(x[1] for x in j), first=(min(hm(x[0]) for x in j if hm(x[0]) >= 570) if any(hm(x[0]) >= 570 for x in j) else np.nan), wk=f'{d[:4]}-{datetime.date.fromisoformat(d).isocalendar()[1]}'))
import pandas as pd
R = pd.DataFrame(rows); print(f'{len(R)} days with joins data and a final shape (explore {int((R.win == "explore").sum())}, hold-out {int((R.win == "holdout").sum())}); join events {int(R.jall.sum())}, rotation legs {int(R.rall.sum())}; base rates: multi-hump {100*R.multi.mean():.0f}%, P/b {100*R.pb.mean():.0f}%, strong B {int(R.sB.sum())} strong D {int(R.sD.sum())}')
def auc(x, y):
    x = np.asarray(x, float); y = np.asarray(y, bool)
    if y.sum() == 0 or (~y).sum() == 0: return np.nan
    o = np.argsort(x, kind='mergesort'); rk = np.empty(len(x)); i = 0
    xs = x[o]
    while i < len(x):
        j = i
        while j + 1 < len(x) and xs[j + 1] == xs[i]: j += 1
        rk[o[i:j + 1]] = (i + j) / 2 + 1; i = j + 1
    return float((rk[y].sum() - y.sum() * (y.sum() + 1) / 2) / (y.sum() * (~y).sum()))
def wboot(df, fn, B=2000):
    g = {k: v.index.values for k, v in df.groupby('wk')}; keys = list(g); out = []
    for _ in range(B):
        ix = np.concatenate([g[keys[i]] for i in rng.integers(0, len(keys), len(keys))]); out.append(fn(df.loc[ix]))
    out = [o for o in out if not np.isnan(o)]; return float(np.quantile(out, .025)), float(np.quantile(out, .975))
def show(name, fn, df=R):
    v = fn(df); c = wboot(df, fn); print(f'  {name:62s} {v:+.3f}  week-block CI [{c[0]:+.3f}, {c[1]:+.3f}]'); return v, c
print('\nT1-T4 (AUC 0.5 = no information)')
a1 = show('T1 AUC joins by 13:00 -> final multi-hump', lambda d: auc(d.j13, d.multi) - 0.5)
a2 = show('T2 AUC joins by 11:00 -> P/b vs D', lambda d: auc(d.j11, d.pb) - 0.5)
a3 = show('T3a AUC rotations by 13:00 -> final multi-hump (baseline)', lambda d: auc(d.r13, d.multi) - 0.5)
a3b = show('T3 joins minus rotations (AUC difference), multi-hump at 13:00', lambda d: auc(d.j13, d.multi) - auc(d.r13, d.multi))
def t4(d):
    a, b = d[d.j13 >= 2], d[d.j13 == 0]
    return (a.multi.mean() - b.multi.mean()) if len(a) >= 5 and len(b) >= 5 else np.nan
a4 = show('T4 share ending multi-hump: >=2 joins by 13:00 minus 0 joins', t4)
print('  (values above are AUC - 0.5 for T1-T3a)')
print('\nPRINTED (uncounted): final shape by number of joins')
for t, col in (('by 11:00', 'j11'), ('by 13:00', 'j13'), ('whole session', 'jall')):
    print(f' joins {t}:')
    for k in (0, 1, 2, 3):
        g = R[(R[col] == k) if k < 3 else (R[col] >= 3)]
        if len(g): print(f'   {k if k<3 else "3+"} joins: N={len(g):4d} days  multi-hump {100*g.multi.mean():3.0f}%  P/b {100*g.pb.mean():3.0f}%  letter D {100*(g.letter=="D").mean():3.0f}%  strongB {100*g.sB.mean():3.0f}%  strongD {100*g.sD.mean():3.0f}%' + ('  (N<20)' if len(g) < 20 else ''))
print(' rotations (R=65 legs) by 13:00, same view:')
for lo, hi in ((0, 5), (6, 9), (10, 14), (15, 99)):
    g = R[(R.r13 >= lo) & (R.r13 <= hi)]
    if len(g): print(f'   {lo}-{hi} legs: N={len(g):4d}  multi-hump {100*g.multi.mean():3.0f}%  P/b {100*g.pb.mean():3.0f}%')
print(' direction mix of the whole-session joins (days with >=2 joins):')
g = R[R.jall >= 2]
for lab, m in (('all long', g.nlong == g.jall), ('all short', g.nlong == 0), ('mixed', (g.nlong > 0) & (g.nlong < g.jall))): x = g[m]; print(f'   {lab:9s} N={len(x):4d}  multi-hump {100*x.multi.mean():3.0f}%  P/b {100*x.pb.mean():3.0f}%  letter D {100*(x.letter=="D").mean():3.0f}%')
print(' first RTH join time terciles (days with a join after 09:30):')
g = R[R['first'].notna()]; q = np.quantile(g['first'], [1 / 3, 2 / 3])
for lab, m in (('early', g['first'] <= q[0]), ('middle', (g['first'] > q[0]) & (g['first'] <= q[1])), ('late', g['first'] > q[1])): x = g[m]; print(f'   {lab:6s} (first join {int(x["first"].min())//60}:{int(x["first"].min())%60:02d}-{int(x["first"].max())//60}:{int(x["first"].max())%60:02d}) N={len(x):4d} multi-hump {100*x.multi.mean():3.0f}%  P/b {100*x.pb.mean():3.0f}%')
print(' overnight joins (before 09:30, known at the open):')
for k in (0, 1, 2):
    x = R[(R.j_on == k) if k < 2 else (R.j_on >= 2)]; print(f'   {k if k<2 else "2+"} joins: N={len(x):4d} multi-hump {100*x.multi.mean():3.0f}%  P/b {100*x.pb.mean():3.0f}%')
print('\nBY WINDOW (T1, T2 AUC - 0.5)')
for w in ('explore', 'holdout'):
    d = R[R.win == w]; print(f'  {w:8s} N={len(d):4d}  T1 {auc(d.j13, d.multi) - 0.5:+.3f}  T2 {auc(d.j11, d.pb) - 0.5:+.3f}  rotations->multi {auc(d.r13, d.multi) - 0.5:+.3f}  joins->range-proxy(rall) corr {np.corrcoef(d.jall, d.rall)[0,1]:+.2f}')
