"""Vacuum location test (docs/VACUUM_LOCATION_PREREG_20261110.md). Stages: count (states only, no outcomes) | run. Uses scratch/vacuum_ml_20261110/{trades.csv,pd_levels.csv}.
Usage: ulimit -v 5000000; venv/bin/python scripts/vacuum_sim/vacuum_location.py count ; ... run"""
import os, sys, glob, collections
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import globex_roc3_test as G
Fm, VM = G.Fm, G.v2
OUT = os.path.join(G.ROOT, 'scratch', 'vacuum_ml_20261110')
def boot(day_of, vals, B=3000, seed=1):
    days, inv = np.unique(day_of, return_inverse=True); s = np.bincount(inv, weights=vals); c = np.bincount(inv).astype(float); rng = np.random.default_rng(seed); n = len(days)
    idx = rng.integers(0, n, (B, n)); m = s[idx].sum(1) / c[idx].sum(1); return float(vals.mean()), float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5)), float((1 + np.sum(m <= 0)) / (B + 1))
def boot_diff(day_of, vals, grp, B=3000, seed=2):
    days, inv = np.unique(day_of, return_inverse=True); n = len(days)
    sa = np.bincount(inv, weights=vals * grp, minlength=n); ca = np.bincount(inv, weights=grp.astype(float), minlength=n); sb = np.bincount(inv, weights=vals * ~grp, minlength=n); cb = np.bincount(inv, weights=(~grp).astype(float), minlength=n)
    rng = np.random.default_rng(seed); idx = rng.integers(0, n, (B, n)); m = sa[idx].sum(1) / ca[idx].sum(1) - sb[idx].sum(1) / cb[idx].sum(1); d0 = vals[grp].mean() - vals[~grp].mean()
    return float(d0), float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5)), float((1 + np.sum(m <= 0)) / (B + 1))
def features():
    T = pd.read_csv(os.path.join(OUT, 'trades.csv')); L = pd.read_csv(os.path.join(OUT, 'pd_levels.csv')); lev = {(r.d, r.n): r.p for r in L.itertuples()}
    want = collections.defaultdict(list)
    for r in T.itertuples(): want[r.date].append(r)
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE); hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2 and S['date'] in want:
            rt = hist['RTH'][-20:]; adr20 = float(np.mean([T_['h'].max() - T_['l'].min() for T_ in rt])) if len(rt) >= 10 else np.nan
            P, n0, reset = VM.continuous(prevS, S); Fm.L_ROC = 10; c, o = P['c'], P['o']
            poc, vah, val = lev.get((S['date'], 'PD_POC')), lev.get((S['date'], 'PD_VAH')), lev.get((S['date'], 'PD_VAL'))
            for r in want[S['date']]:
                a, ei, last, s = int(r.a), int(r.ei), int(r.last), int(r.s); cl = float(c[a])
                m = abs(cl - poc) / adr20 if poc is not None and adr20 == adr20 and adr20 > 0 else np.nan
                inside = (val is not None and vah is not None and val <= cl <= vah); openair = (s == 1 and vah is not None and cl > vah) or (s == -1 and val is not None and cl < val)
                e4, e14 = min(ei + 4, last), min(ei + 14, last)
                rows.append(dict(tid=r.tid, date=r.date, track=r.track, s=s, m=m, inside=bool(inside), openair=bool(openair), pre_early=s * (float(c[a - 3]) - float(c[a - 10])), pre_late=s * (cl - float(c[a - 3])), post1=s * (float(c[e4]) - float(o[ei])), post2=s * (float(c[e14]) - float(c[e4])), post3=s * (float(c[last]) - float(c[e14]))))
        for name, T_ in tsp.items(): hist[name].append(T_)
        prevS = S
    R = pd.DataFrame(rows); T = T.rename(columns={'n2.5': 'n25'}); R = R.merge(T[['tid', 'n25', 'a']], on='tid'); R['gross'] = R.n25 + 2.0
    R = R.sort_values(['track', 'tid']).reset_index(drop=True); R['state'] = 'NA'
    for tr in ('RTH', 'GBX'):
        ix = R.index[R.track == tr]; med = pd.Series(R.loc[ix, 'm']).shift(1).rolling(250, min_periods=250).median(); okm = med.notna() & R.loc[ix, 'm'].notna()
        A = okm & R.loc[ix, 'openair'] & (R.loc[ix, 'm'] >= med); R.loc[ix[okm], 'state'] = 'B'; R.loc[ix[A], 'state'] = 'A'
    return R
def count():
    R = features(); print('classified states (no outcomes read):')
    for tr in ('RTH', 'GBX'):
        for st in ('A', 'B', 'NA'):
            g = R[(R.track == tr) & (R.state == st)]; print(f'  {tr} state {st}: {len(g)} triggers on {g.date.nunique()} days')
    print('inside prior-day value area:', {tr: int(R[R.track == tr].inside.sum()) for tr in ('RTH', 'GBX')})
def run():
    R = features(); rng = np.random.default_rng(7); print('DESCRIPTIVE DRIFT DECOMPOSITION (gross points signed with the trade direction; day-blocked mean [95% interval]):')
    for tr in ('RTH', 'GBX'):
        for lab, g in (('all', R[R.track == tr]), ('inside prior-day value', R[(R.track == tr) & R.inside]), ('outside prior-day value', R[(R.track == tr) & ~R.inside])):
            out = []
            for w in ('pre_early', 'pre_late', 'post1', 'post2', 'post3'):
                m, lo, hi, _ = boot(g.date.values, g[w].values, seed=3); out.append(f'{w} {m:+.2f} [{lo:+.1f},{hi:+.1f}]')
            print(f'  {tr:4s} {lab:24s} N {len(g):5d} | ' + ' | '.join(out))
    print('\nCOUNTED STRUCTURAL SPLIT (outcome = live-rule result, gross of the 2.0 pt cost):')
    for tr in ('RTH', 'GBX'):
        D = R[(R.track == tr) & (R.state != 'NA')]; A = D[D.state == 'A']; B = D[D.state == 'B']; gate = len(A) >= 100 and A.date.nunique() >= 60 and len(B) >= 100 and B.date.nunique() >= 60
        print(f'\n{tr}: State A {len(A)} trades on {A.date.nunique()} days, State B {len(B)} on {B.date.nunique()}; power gate {"MET" if gate else "NOT MET"}')
        if len(A) == 0 or len(B) == 0: continue
        grp = (D.state == 'A').values; d0, lo, hi, p = boot_diff(D.date.values, D.gross.values, grp, seed=51 if tr == 'RTH' else 52)
        print(f'   L1 State A minus State B gross mean: {d0:+.3f} pt/trade [{lo:+.3f}, {hi:+.3f}], one-sided p {p:.4f} | A {A.gross.mean():+.3f}, B {B.gross.mean():+.3f} (net of 2.0: A {A.gross.mean() - 2:+.3f}, B {B.gross.mean() - 2:+.3f})')
        # L2: random-direction placebo at the State A timestamps: flipping the sign of each outcome is not exact (the stop side changes); the placebo uses the signed 30-bar drift without the stop as the null centre
        flips = np.array([np.mean(A.gross.values * rng.choice([-1, 1], len(A))) for _ in range(1000)]); obs = A.gross.mean()
        print(f'   L2 State A mean {obs:+.3f} vs random-sign placebo mean {flips.mean():+.3f} (sd {flips.std():.3f}); one-sided p {(1 + np.sum(flips >= obs)) / 1001:.4f}  [sign-flip approximation of the random-direction placebo]')
if __name__ == '__main__':
    {'count': count, 'run': run}.get(sys.argv[1] if len(sys.argv) > 1 else '', lambda: print(__doc__))()
