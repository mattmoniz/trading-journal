"""RTH high-rotation-regime flow-sign trade (docs/RTH_REGIME_FLOW_PREREG_20261104.md). 3 counted tests. Reuses the real sim() of ovn_sim.py (hr-022).
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/rth_regime_flow.py   (look 174 is logged first, hr-023)"""
import os, sys, json, csv, datetime
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ovn_sim import sim, load_days, SLIP, REPO
rng = np.random.default_rng(20261104); B, NPLC = 4000, 1000; CIQ = (0.835, 99.165); EXIT_M = 955; LAST_EXPLORE = '2025-05-16'; SCALE_C = 0.1786
D = load_days(); dates = sorted(D); LG = json.load(open(os.path.join(REPO, 'scratch', 'ovn_orderflow_20261104', 'rth_legs_by_11.json')))
X = {d: dict(m=np.array(D[d]['m']), o=np.array(D[d]['o'], float), h=np.array(D[d]['h'], float), l=np.array(D[d]['l'], float), c=np.array(D[d]['c'], float)) for d in dates}
rth = {d: float(X[d]['h'][X[d]['m'] >= 570].max() - X[d]['l'][X[d]['m'] >= 570].min()) for d in dates}


def legs_series(scaled):
    cnt = []; adrs = []
    for i, d in enumerate(dates):
        adr = float(np.median([rth[x] for x in dates[i - 20:i]])) if i >= 20 else np.nan; adrs.append(adr)
        if d not in LG: cnt.append(np.nan); continue
        if scaled:
            if i < 20: cnt.append(np.nan); continue
            g = min(range(20, 201, 10), key=lambda k: abs(k - SCALE_C * adr)); cnt.append(LG[d]['legs'][str(g)])
        else: cnt.append(LG[d]['legs']['65'])
    return np.array(cnt, float), np.array(adrs)


def qualifying(cnt):
    q = np.zeros(len(cnt), bool)
    for i in range(len(cnt)):
        prior = cnt[:i][~np.isnan(cnt[:i])]
        q[i] = len(prior) >= 60 and cnt[i] == cnt[i] and cnt[i] >= np.percentile(prior, 90)
    return q


def flow_sign(d):
    fp = os.path.join(REPO, 'scratch', 'updown_1m_20261104', d + '.csv')
    if not os.path.exists(fp): return None
    net = 0
    for r in csv.DictReader(open(fp)):
        if r['ts'][:10] == d and '09:30' <= r['ts'][11:16] < '11:00': net += int(r['up_vol']) - int(r['down_vol'])
    return int(np.sign(net))


def trade(d, dr, stop_pts):
    x = X[d]; j0 = int(np.where(x['m'] == 660)[0][0]); xs = {k: v[j0:] for k, v in x.items()}; return sim(xs, dr, xs['o'][0] + dr * SLIP, stop_pts, EXIT_M)[0]


cnt_s, adr = legs_series(True); q_s = qualifying(cnt_s); cnt_f, _ = legs_series(False); q_f = qualifying(cnt_f)
rows = []
for i, d in enumerate(dates):
    if d > LAST_EXPLORE or i < 20 or not q_s[i] and np.isnan(cnt_s[i]): continue
    fs = flow_sign(d)
    if fs is None or fs == 0 or np.isnan(cnt_s[i]): continue
    mom = int(np.sign(X[d]['c'][X[d]['m'] == 659][0] - X[d]['o'][X[d]['m'] == 570][0])) or 1
    if len(cnt_s[:i][~np.isnan(cnt_s[:i])]) < 60: continue
    L = {f: trade(d, 1, f * adr[i]) for f in (0.5, 1.0, 1.5)}; S = {f: trade(d, -1, f * adr[i]) for f in (0.5, 1.0, 1.5)}
    rows.append(dict(d=d, q=bool(q_s[i]), qf=bool(q_f[i]), fs=fs, mom=mom, adr=adr[i], L=L[1.0], S=S[1.0], L05=L[0.5], S05=S[0.5], L15=L[1.5], S15=S[1.5], wk=datetime.date.fromisoformat(d).strftime('%G-%V'), yr=d[:4]))
T = pd.DataFrame(rows); Q = T[T.q].reset_index(drop=True); O = T[~T.q].reset_index(drop=True)
for df in (T, Q, O):
    df['flow'] = np.where(df.fs == 1, df.L, df.S); df['rand'] = (df.L + df.S) / 2; df['momr'] = np.where(df.mom == 1, df.L, df.S)
print(f'{len(T)} scored explore days (tick flow known, at least 60 earlier days); QUALIFYING (scaled legs, expanding 90th pct): {len(Q)} days ({100 * len(Q) / len(T):.0f}%); by year: ' + ', '.join(f'{y} {int((Q.yr == y).sum())}' for y in sorted(Q.yr.unique())) + f'; fixed-65 qualifying among them: {int(T.qf.sum())} (sensitivity only, drift)')
if len(Q) < 40: print('FEWER THAN 40 qualifying days: the pre-registered rule says do not run the test'); sys.exit(0)


def wboot(v, wk):
    g = list(pd.Series(np.arange(len(v))).groupby(wk).apply(np.array).values); out = np.empty(B)
    for b in range(B): out[b] = v[np.concatenate([g[j] for j in rng.integers(0, len(g), len(g))])].mean()
    return np.percentile(out, CIQ), float(out.std())


def wboot_contrast(a, wa, b, wb):
    ga = list(pd.Series(np.arange(len(a))).groupby(wa).apply(np.array).values); gb = list(pd.Series(np.arange(len(b))).groupby(wb).apply(np.array).values); out = np.empty(B)
    for k in range(B): out[k] = a[np.concatenate([ga[j] for j in rng.integers(0, len(ga), len(ga))])].mean() - b[np.concatenate([gb[j] for j in rng.integers(0, len(gb), len(gb))])].mean()
    return np.percentile(out, CIQ), float(out.std())


d1 = (Q.flow - Q.rand).values; d2 = (Q.flow - Q.momr).values; d3q = (Q.flow - Q.rand).values; d3o = (O.flow - O.rand).values; dal = (Q.flow - Q.L).values; ab = Q.flow.values
c1, s1 = wboot(d1, Q.wk.values); c2, s2 = wboot(d2, Q.wk.values); c3, s3 = wboot_contrast(d3q, Q.wk.values, d3o, O.wk.values); ca, sa = wboot(ab, Q.wk.values); cal, sal = wboot(dal, Q.wk.values)
print(f'\nDETECTABLE (2.8 x SE) dollars per trade, printed before the verdicts: T1 {2.8 * s1:.0f}; T2 {2.8 * s2:.0f}; T3 {2.8 * s3:.0f}; absolute mean {2.8 * sa:.0f}')
half = len(Q) // 2; pl = []
for _ in range(NPLC):
    sh = int(rng.integers(3, len(Q) - 3)); fs2 = np.roll(Q.fs.values, sh); pl.append(float((np.where(fs2 == 1, Q.L.values, Q.S.values) - Q.rand.values).mean()))
pl = np.array(pl); gate = max(0.0, float(np.quantile(pl - pl.mean(), 0.975))); print(f'PLACEBO (flow sign shifted across qualifying days, {NPLC} draws): mean {pl.mean():+.1f}, gate {gate:.1f}')
print('\nCOUNTED TESTS (CI 98.33% week-block):')
for lab, d, ci in (('T1 flow-sign minus RANDOM direction (qualifying days)', d1, c1), ('T2 flow-sign minus PRICE MOMENTUM (qualifying days)', d2, c2)):
    h1, h2 = d[:half].mean(), d[half:].mean(); ok = dict(ci_lower_above_0=bool(ci[0] > 0), both_halves_positive=bool(min(h1, h2) > 0))
    if lab.startswith('T1'): ok['placebo_beaten'] = bool(d.mean() > gate)
    print(f'  {lab}: {d.mean():+.1f} per trade CI [{ci[0]:+.1f}, {ci[1]:+.1f}] halves {h1:+.1f} / {h2:+.1f}\n      conditions {ok} => ' + ('LEAD' if all(ok.values()) else 'NOT SHOWN'))
t3 = d3q.mean() - d3o.mean(); print(f'  T3 regime contrast (flow minus random: qualifying {d3q.mean():+.1f} vs other days {d3o.mean():+.1f}, N {len(Q)} / {len(O)}): {t3:+.1f} CI [{c3[0]:+.1f}, {c3[1]:+.1f}] => ' + ('LEAD' if c3[0] > 0 else 'NOT SHOWN'))
print('\nADDITIONAL CONDITIONS and REPORTED (not counted):')
print(f'  ABSOLUTE mean of the flow-sign trade on qualifying days: {ab.mean():+.1f} per trade CI [{ca[0]:+.1f}, {ca[1]:+.1f}] (must be above 0); win rate {100 * (ab > 0).mean():.0f}%; worst {ab.min():+.0f}')
print(f'  flow-sign minus ALWAYS LONG: {dal.mean():+.1f} CI [{cal[0]:+.1f}, {cal[1]:+.1f}]; always long {Q.L.mean():+.1f}, random {Q.rand.mean():+.1f}, momentum sign {Q.momr.mean():+.1f}, flow sign {Q.flow.mean():+.1f}')
print(f'  other days: flow {O.flow.mean():+.1f}, random {O.rand.mean():+.1f}, momentum {O.momr.mean():+.1f}')
print('  by year (qualifying days; flow minus random): ' + '; '.join(f'{y} {(Q[Q.yr == y].flow - Q[Q.yr == y].rand).mean():+.0f} (N={int((Q.yr == y).sum())})' for y in sorted(Q.yr.unique())))
for f, (a, b) in ((0.5, ('L05', 'S05')), (1.5, ('L15', 'S15'))):
    fl = np.where(Q.fs == 1, Q[a], Q[b]); print(f'  stop {f} x ADR: flow {fl.mean():+.1f}, random {((Q[a] + Q[b]) / 2).mean():+.1f}, flow minus random {(fl - (Q[a] + Q[b]) / 2).mean():+.1f}')
Qf = T[T.qf]; flf = np.where(Qf.fs == 1, Qf.L, Qf.S); print(f'  sensitivity, fixed-65 qualifying days (N {len(Qf)}, the drifting definition): flow {flf.mean():+.1f}, random {((Qf.L + Qf.S) / 2).mean():+.1f}')
print(f'  agreement of the flow sign with the momentum sign on qualifying days: {100 * (Q.fs == Q.mom).mean():.0f}%')
