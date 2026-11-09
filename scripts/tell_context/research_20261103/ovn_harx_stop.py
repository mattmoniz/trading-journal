"""HAR-X-scaled stop on the overnight order-flow trade (docs/OVN_HARX_STOP_PREREG_20261104.md). 3 counted tests. Reuses the real sim() of ovn_sim.py (hr-022).
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/ovn_harx_stop.py   (look 172 is logged first, hr-023)"""
import os, sys, datetime
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ovn_sim import sim, load_days, SLIP, REPO
rng = np.random.default_rng(20261104); WARM, STEP, B, NPLC = 120, 5, 4000, 300; CIQ = (0.835, 99.165); MIN_STOP = 20.0; EXIT_M = 870
D = load_days(); dates = sorted(D); X = {}
for d in dates:
    x = D[d]; X[d] = dict(m=np.array(x['m']), o=np.array(x['o'], float), h=np.array(x['h'], float), l=np.array(x['l'], float), c=np.array(x['c'], float))
rth = {d: float(X[d]['h'][X[d]['m'] >= 570].max() - X[d]['l'][X[d]['m'] >= 570].min()) for d in dates}
win = {d: float(X[d]['h'][X[d]['m'] < EXIT_M].max() - X[d]['l'][X[d]['m'] < EXIT_M].min()) for d in dates}
R = pd.read_csv(os.path.join(REPO, 'scratch', 'ovn_orderflow_20261104', 'rows_allnights.csv')).set_index('d')
rows = []
for i, d in enumerate(dates):
    if i < 22 or d not in R.index: continue
    adr = float(np.median([rth[x] for x in dates[i - 20:i]])); lag = lambda k: np.log(rth[dates[i - k]] / adr)
    pre = float(D[d]['hi_pre'] - D[d]['lo_pre'])
    rows.append(dict(d=d, i=i, adr=adr, har_d=lag(1), har_w=np.mean([lag(k) for k in range(1, 6)]), har_m=np.mean([lag(k) for k in range(1, 23)]), ln_on=np.log(max(pre, 1.0) / adr), y=np.log(win[d] / adr),
                     wd=datetime.date.fromisoformat(d).weekday(), dir=int(R.loc[d, 'dir']), legs=int(R.loc[d, 'legs']), wk=datetime.date.fromisoformat(d).strftime('%G-%V')))
T = pd.DataFrame(rows); N = len(T)
for k in (1, 2, 3, 4): T[f'wd{k}'] = (T.wd == k).astype(float)
Xm = lambda cols: T[cols].values.astype(float); y = T.y.values; sc = np.arange(N) >= WARM


def walk_ols(Xa, y):
    p = np.full(len(y), np.nan); A = np.column_stack([np.ones(len(y)), Xa])
    for i0 in range(WARM, len(y), STEP): w = np.linalg.lstsq(A[:i0], y[:i0], rcond=None)[0]; sl = slice(i0, min(i0 + STEP, len(y))); p[sl] = A[sl] @ w
    return p


p_h = walk_ols(Xm(['har_d', 'har_w', 'har_m', 'ln_on']), y); p_b = walk_ols(Xm(['wd1', 'wd2', 'wd3', 'wd4', 'har_d']), y)
mse = lambda p: float(np.nanmean(((y - p) ** 2)[sc])); print(f'{N} nights, {int(sc.sum())} scored (from night {WARM}); MSE of the log window range: HAR-X {mse(p_h):.4f}, baseline {mse(p_b):.4f}, ADR-only {float(np.mean((y[sc] - np.nanmean(y[:WARM])) ** 2)):.4f}')
W = dict(HARX=T.adr.values * np.exp(p_h), BASE=T.adr.values * np.exp(p_b), ADR=T.adr.values.copy())


def stops(width, S):
    c = S / np.nanmean(width[sc]); return np.maximum(c * width, MIN_STOP)


def run(stop_arr):
    net = np.full(N, np.nan); why = np.empty(N, object)
    for k in np.where(sc)[0]:
        x = X[T.d.iloc[k]]; dr = int(T.dir.iloc[k]); n_, w_ = sim(x, dr, x['o'][0] + dr * SLIP, float(stop_arr[k]), EXIT_M); net[k] = n_; why[k] = w_
    return net, why


ARMS = {}
for S in (400, 300):
    ARMS[f'FIXED{S}'] = run(np.full(N, float(S)))
    for nm in ('HARX', 'BASE', 'ADR'): ARMS[f'{nm}{S}'] = run(stops(W[nm], S))
wkb = {k: np.where((T.wk.values == k) & sc)[0] for k in sorted(set(T.wk.values[sc]))}; keys = list(wkb)


def boot(v, mask=None):
    g = {k: np.where((T.wk.values == k) & sc & (mask if mask is not None else True))[0] for k in keys}; ks = [k for k in keys if len(g[k])]; out = np.empty(B)
    for b in range(B): out[b] = np.nanmean(v[np.concatenate([g[ks[j]] for j in rng.integers(0, len(ks), len(ks))])])
    return np.percentile(out, CIQ), float(out.std())


half = np.array_split(np.where(sc)[0], 2); regime = (T.legs.values >= 6) & sc
print(f'scored nights {int(sc.sum())}; nights with 6+ rotation legs among them: {int(regime.sum())}')
print('\nARMS (400-point family): mean $/trade | win% | mean win | mean loss | stop-out share | worst | 5th pct night | mean stop')
for nm in ('FIXED400', 'HARX400', 'BASE400', 'ADR400'):
    n_, w_ = ARMS[nm]; v = n_[sc]; st = np.array([str(z).startswith('STOP') for z in w_[sc]]); sp = {'FIXED400': np.full(N, 400.0), 'HARX400': stops(W['HARX'], 400), 'BASE400': stops(W['BASE'], 400), 'ADR400': stops(W['ADR'], 400)}[nm][sc]
    print(f'  {nm:9s} {v.mean():+8.2f} | {100 * (v > 0).mean():3.0f}% | {v[v > 0].mean():+7.1f} | {v[v <= 0].mean():+7.1f} | {100 * st.mean():3.0f}% | {v.min():+8.1f} | {np.percentile(v, 5):+8.1f} | {sp.mean():6.0f}')
d1 = ARMS['HARX400'][0] - ARMS['FIXED400'][0]; d2 = ARMS['HARX400'][0] - ARMS['BASE400'][0]; d3 = d1
tests = [('T1 HARX minus FIXED400 (all scored nights)', d1, None), ('T2 HARX minus BASEWIDTH (all scored nights)', d2, None), ('T3 HARX minus FIXED400 (6+ rotation legs nights)', d3, regime)]
res = []
for lab, d, m in tests:
    ci, se = boot(d, m); res.append((lab, d, m, ci, se))
print('\nDETECTABLE (2.8 x SE) dollars per trade, printed before the verdicts: ' + '; '.join(f'{r[0][:2]} {2.8 * r[4]:.1f}' for r in res))
plc = []
for _ in range(NPLC):
    sh = int(rng.integers(10, N - 10)); Ws = np.roll(W['HARX'], sh); n_, _w = run(stops(Ws, 400)); plc.append(float(np.nanmean((n_ - ARMS['FIXED400'][0])[sc])))
plc = np.array(plc); gate = max(0.0, float(np.quantile(plc - plc.mean(), 0.975)))
print(f'PLACEBO (width circularly shifted, {NPLC} draws): mean improvement {plc.mean():+.2f}, gate {gate:.2f}')
print('\nCOUNTED TESTS (CI 98.33% week-block):')
for lab, d, m, ci, se in res:
    mm = (m if m is not None else sc); obs = float(np.nanmean(d[mm])); hv = [float(np.nanmean(d[h][mm[h]])) if mm[h].any() else np.nan for h in half]
    ok = dict(ci_lower_above_0=ci[0] > 0, both_halves_positive=bool(min(hv) > 0)); 
    if lab.startswith('T1'): ok['placebo_gate_beaten'] = obs > gate
    print(f'  {lab}: {obs:+.2f} CI [{ci[0]:+.2f}, {ci[1]:+.2f}] halves {hv[0]:+.2f} / {hv[1]:+.2f}\n      conditions {ok} => ' + ('LEAD' if all(ok.values()) else 'NOT SHOWN'))
print('\nREPORTED (not counted):')
print('  300-point family, mean $/trade: ' + ', '.join(f'{k} {np.nanmean(ARMS[k][0][sc]):+.2f}' for k in ('FIXED300', 'HARX300', 'BASE300', 'ADR300')))
print(f'  ADR400 minus FIXED400 {np.nanmean((ARMS["ADR400"][0] - ARMS["FIXED400"][0])[sc]):+.2f}; BASE400 minus FIXED400 {np.nanmean((ARMS["BASE400"][0] - ARMS["FIXED400"][0])[sc]):+.2f}; HARX400 minus ADR400 {np.nanmean((ARMS["HARX400"][0] - ARMS["ADR400"][0])[sc]):+.2f}')
yr = np.array([x[:4] for x in T.d]); print('  T1 by year (mean paired $, N): ' + '; '.join(f'{u} {np.nanmean(d1[sc & (yr == u)]):+.1f} (N={int((sc & (yr == u)).sum())})' for u in sorted(set(yr[sc]))))
print(f'  stop width spread: SD / mean of the HAR-X stop {np.std(stops(W["HARX"], 400)[sc]) / 400:.2f}; corr(HAR-X width, baseline width) {np.corrcoef(W["HARX"][sc], W["BASE"][sc])[0, 1]:.2f}')
print(f'  regime nights: FIXED400 {np.nanmean(ARMS["FIXED400"][0][regime]):+.1f}, HARX400 {np.nanmean(ARMS["HARX400"][0][regime]):+.1f}, BASE400 {np.nanmean(ARMS["BASE400"][0][regime]):+.1f} (N={int(regime.sum())})')
