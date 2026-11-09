"""Range forecast as a simulated approve/veto of the tell's explore trades. Pre-registration: docs/RANGE_MODEL_TELL_FILTER_PREREG_20261105.md (ledger look 178, 3 counted tests).
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/range_tell_filter.py"""
import os, numpy as np, pandas as pd
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); OUT = os.path.join(REPO, 'scratch', 'range_tell_filter_20261105'); os.makedirs(OUT, exist_ok=True)
RTH0, DEC, SEED_N, NB, NP, ALPHA = 55800.0, (60, 120, 210), 40, 4000, 1000, 0.0167
rng = np.random.default_rng(20261105)
TR = pd.read_csv(os.path.join(REPO, 'scratch/tell_context_20261103/tell_stop_placement_rows.csv'), usecols=['date', 'end_sec', 'A', 'B', 'C']); TR['m'] = (TR.end_sec - RTH0) / 60
def match(m):
    for d in DEC:
        if d <= m < d + 60: return d
    return -1
TR['D'] = TR.m.apply(match); WF = pd.read_csv(os.path.join(REPO, 'scratch/structure_model_20261105/rows_walkforward.csv')); WF = WF[WF.scored == 1].copy()
assert not WF.duplicated(['date', 'T']).any()
def exp_rank(v):
    """percentile of each value among STRICTLY earlier values (NaN until SEED_N earlier values exist)"""
    r = np.full(len(v), np.nan)
    for i in range(SEED_N, len(v)): r[i] = np.mean(v[:i] < v[i])
    return r
def ranked(col, shift=0):
    parts = []
    for T in DEC:
        g = WF[WF['T'] == T].sort_values('date').reset_index(drop=True); v = g[col].values
        if shift: v = np.roll(v, shift)
        parts.append(pd.DataFrame({'date': g.date, 'D': T, 'rk_' + col: exp_rank(v)}))
    return pd.concat(parts)
def tercile(rk): return np.where(rk >= 2 / 3, 'WIDE', np.where(rk <= 1 / 3, 'NARROW', 'MIDDLE'))
M = TR[TR.D > 0].merge(WF[['date', 'T']].rename(columns={'T': 'D'}), on=['date', 'D'])
for c in ('p2', 'p3', 'p0', 'y'): M = M.merge(ranked(c), on=['date', 'D'], how='left')
n_all = len(M); M = M.dropna(subset=['rk_p2', 'rk_p3']).copy(); print(f'matched {n_all}, after the {SEED_N}-day rank seeding {len(M)} trades on {M.date.nunique()} dates')
for c in ('p2', 'p3', 'p0', 'y'): M['g_' + c] = tercile(M['rk_' + c].values)
print('time-of-day mix by group (p2), share of trades per decision minute:'); print(pd.crosstab(M.g_p2, M.D, normalize='index').round(2).to_string())
dates = np.array(sorted(M.date.unique())); di = {d: i for i, d in enumerate(dates)}; M['di'] = M.date.map(di); ND = len(dates)
def per_date(df, mask):
    s = np.zeros(ND); n = np.zeros(ND); x = df[mask]; np.add.at(s, x.di.values, x.A.values); np.add.at(n, x.di.values, 1); return s, n
def contrast_arrays(g, book='A'):
    return per_date(M, M[g] == 'WIDE'), per_date(M, M[g] == 'NARROW')
def stat_ratio(w, nr, idx): return w[0][idx].sum() / max(w[1][idx].sum(), 1) - nr[0][idx].sum() / max(nr[1][idx].sum(), 1)
def boot(fn):
    draws = np.array([fn(rng.integers(0, ND, ND)) for _ in range(NB)]); return draws
W2, N2 = contrast_arrays('g_p2'); W3, N3 = contrast_arrays('g_p3')
full = np.arange(ND); t1 = stat_ratio(W2, N2, full); t2c = stat_ratio(W3, N3, full)
b1 = boot(lambda ix: stat_ratio(W2, N2, ix)); b2 = boot(lambda ix: stat_ratio(W2, N2, ix) - stat_ratio(W3, N3, ix))
# T3: per DAY dollars, approved (WIDE + MIDDLE) minus all matched trades = minus the vetoed (NARROW) day sums
allS, allN = per_date(M, M.A.notna()); vetoS = N2[0]; t3 = -vetoS.mean(); b3 = boot(lambda ix: -vetoS[ix].mean())
lo, hi = 100 * ALPHA / 2, 100 * (1 - ALPHA / 2)
print(f'\nDETECTABLE EFFECT (2.8 x bootstrap SE), dollars: T1 {2.8 * b1.std():.1f} per trade, T2 {2.8 * b2.std():.1f} per trade, T3 {2.8 * b3.std():.1f} per day (printed before any result is read)')
ci = lambda b: f'[{np.percentile(b, lo):+.2f}, {np.percentile(b, hi):+.2f}]'
print(f'\nGroup sizes (p2): ' + ', '.join(f'{k} {v}' for k, v in M.g_p2.value_counts().items()))
print(f'T1 WIDE minus NARROW (p2): {t1:+.2f} per trade {ci(b1)}')
print(f'T2 control: the same contrast on the hard baseline p3 {t2c:+.2f}; model minus baseline {t1 - t2c:+.2f} {ci(b2)}')
print(f'T3 approved minus all, per DAY: {t3:+.2f} {ci(b3)}  (per trade: approved {M[M.g_p2 != "NARROW"].A.mean():+.2f} vs all {M.A.mean():+.2f}; vetoed NARROW {M[M.g_p2 == "NARROW"].A.mean():+.2f})')
# placebo: circular shift of the p2 series within each decision minute by >= 10 scored days, re-rank, recompute the T1 contrast
def placebo_once():
    sh = int(rng.integers(10, 340)); r = ranked('p2', sh).rename(columns={'rk_p2': 'rk_s'}); X = M[['date', 'D', 'A']].merge(r, on=['date', 'D'], how='left').dropna(subset=['rk_s']); g = tercile(X.rk_s.values)
    return X.A[g == 'WIDE'].mean() - X.A[g == 'NARROW'].mean()
pl = np.array([placebo_once() for _ in range(NP)]); pl = pl[~np.isnan(pl)]
thr = np.percentile(pl, 97.5) if t1 > 0 else np.percentile(pl, 2.5); beat = (t1 > thr) if t1 > 0 else (t1 < thr)
print(f'PLACEBO T1 (circular shift, {len(pl)} draws): mean {pl.mean():+.2f}, 2.5th {np.percentile(pl, 2.5):+.2f}, 97.5th {np.percentile(pl, 97.5):+.2f}; real beyond its own-side threshold: {beat}')
med = np.median(np.arange(ND)); h = [full[full <= med], full[full > med]]; hv = [stat_ratio(W2, N2, ix) for ix in h]
print(f'HALVES T1: first half {hv[0]:+.2f} ({dates[h[0][0]]}..{dates[h[0][-1]]}), second half {hv[1]:+.2f}; same sign: {np.sign(hv[0]) == np.sign(hv[1]) != 0}')
verdict = (np.percentile(b1, lo) > 0 or np.percentile(b1, hi) < 0) and beat and np.sign(hv[0]) == np.sign(hv[1]) and np.sign(t1 - t2c) == np.sign(t1) and np.sign(t1) != 0
print('\nVERDICT (prereg section 4): ' + ('LEAD' if verdict else 'NOT SHOWN') + f'  [CI excludes 0: {np.percentile(b1, lo) > 0 or np.percentile(b1, hi) < 0}; placebo beaten: {beat}; halves same sign: {np.sign(hv[0]) == np.sign(hv[1])}; T2 same sign as T1: {np.sign(t1 - t2c) == np.sign(t1)}]')
print('\n--- REPORTED, NOT COUNTED ---')
def prof(x): return dict(n=len(x), mean=round(x.mean(), 2), win=round((x > 0).mean(), 3), avg_win=round(x[x > 0].mean(), 1) if (x > 0).any() else None, avg_loss=round(x[x <= 0].mean(), 1) if (x <= 0).any() else None, worst=round(x.min(), 1))
for g in ('WIDE', 'MIDDLE', 'NARROW'): print('book A', g, prof(M.A[M.g_p2 == g]))
print('(stop-out share is not in the book-A rows; win rate / mean win / mean loss / worst loss shown instead)')
for b in ('B', 'C'): print(f'book {b} WIDE minus NARROW: {M[b][M.g_p2 == "WIDE"].mean() - M[b][M.g_p2 == "NARROW"].mean():+.2f}')
for c in ('p0', 'y'): g = M['g_' + c]; print(f'{"oracle (realized next-hour range)" if c == "y" else c} WIDE minus NARROW: {M.A[g == "WIDE"].mean() - M.A[g == "NARROW"].mean():+.2f}')
for D in DEC: x = M[M.D == D]; print(f'by decision minute {D}: n {len(x)}, WIDE minus NARROW {x.A[x.g_p2 == "WIDE"].mean() - x.A[x.g_p2 == "NARROW"].mean():+.2f}')
M['yr'] = M.date.str[:4]
for y, x in M.groupby('yr'): print(f'by year {y}: n {len(x)}, WIDE minus NARROW {x.A[x.g_p2 == "WIDE"].mean() - x.A[x.g_p2 == "NARROW"].mean():+.2f}')
print('trades per date: share of dates with more than one matched trade', round((allN > 1).mean(), 3))
C = M.sort_values(['date', 'end_sec']).copy(); C['ALL'] = C.A.cumsum(); C['APPROVED'] = (C.A * (C.g_p2 != 'NARROW')).cumsum(); C['VETOED'] = (C.A * (C.g_p2 == 'NARROW')).cumsum()
C[['date', 'D', 'g_p2', 'A', 'ALL', 'APPROVED', 'VETOED']].to_csv(os.path.join(OUT, 'curves.csv'), index=False); print('final cumulative dollars: ALL %.0f, APPROVED %.0f, VETOED %.0f (curves.csv)' % (C.ALL.iloc[-1], C.APPROVED.iloc[-1], C.VETOED.iloc[-1]))
