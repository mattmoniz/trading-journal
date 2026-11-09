"""HAR benchmark for the day-width forecast (docs/HAR_WIDTH_BENCHMARK_PREREG_20261104.md). Explore only, 2 counted tests. Reads the session table written by daytype_forecast.py --dump.
walk_ridge below is the same algorithm as daytype_forecast.walk_ridge (parity printed against the day forecast's own T2 improvement).
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/har_width_benchmark.py   (look logged first, hr-023)"""
import os, warnings
import numpy as np, pandas as pd
warnings.filterwarnings('ignore')
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); rng = np.random.default_rng(20261104)
WARM, STEP, ALPHAS, DRAWS, B = 120, 5, (0.01, 0.1, 1, 10, 100), 200, 2000; CIQ = (1.25, 98.75)
T = pd.read_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'daytype_forecast_table.csv'))
T['rng'] = T.adr * np.exp(T.lrr)                                                    # RTH range in points, recovered from the table's own columns
lr = lambda k: np.log(T.rng.shift(k)) - np.log(T.adr)                               # ln(range of day t-k / ADR_t)
T['har_d'] = lr(1); T['har_w'] = sum(lr(k) for k in range(1, 6)) / 5; T['har_m'] = sum(lr(k) for k in range(1, 23)) / 22; T['ln_on'] = np.log(T.on_rng.clip(lower=1e-3))
R = T.iloc[22:].reset_index(drop=True); N = len(R); sc = np.arange(N) >= WARM; wk = R.wk.values; y = R.lrr.values
BASE = ['wd1', 'wd2', 'wd3', 'wd4', 'pd_rng']; BIG = ['chg5', 'chg20', 'pos20', 'streak', 'delta5', 'up_unf', 'dn_unf', 'n_unf']; PRI = ['pd_mid', 'pd_bim', 'pd_imb', 'open_va']; OVN = ['on_rng', 'on_net', 'on_drv', 'on_dl']
S0 = BASE + BIG + PRI + OVN; HAR = ['har_d', 'har_w', 'har_m']; HARX = HAR + ['ln_on']; X = lambda cols: R[cols].values.astype(float)
print(f'{N} sessions after dropping the first 22; scored from index {WARM}: {int(sc.sum())} sessions')


def ridge_fit(Xt, yt, a):
    mu, sd = Xt.mean(0), Xt.std(0) + 1e-9; Z = (Xt - mu) / sd; yc = yt.mean(); w = np.linalg.solve(Z.T @ Z + a * np.eye(Z.shape[1]), Z.T @ (yt - yc)); return mu, sd, yc, w


def walk_ridge(Xm, y, alphas=None):
    p = np.full(len(y), np.nan); used = []
    for bi, i0 in enumerate(range(WARM, len(y), STEP)):
        if alphas is not None: a = alphas[bi]
        else:
            cuts = np.linspace(0, i0, 7).astype(int); best = (1e18, 1.0)
            for aa in ALPHAS:
                e = 0.0
                for k in range(1, 6):
                    tr, va = slice(0, cuts[k]), slice(cuts[k], cuts[k + 1]); mu, sd, yc, w = ridge_fit(Xm[tr], y[tr], aa); e += float(np.mean((y[va] - yc - ((Xm[va] - mu) / sd) @ w) ** 2))
                if e < best[0]: best = (e, aa)
            a = best[1]
        used.append(a); mu, sd, yc, w = ridge_fit(Xm[:i0], y[:i0], a); sl = slice(i0, min(i0 + STEP, len(y))); p[sl] = yc + ((Xm[sl] - mu) / sd) @ w
    return p, used


def walk_ols(Xm, y):
    p = np.full(len(y), np.nan); Xa = np.column_stack([np.ones(len(y)), Xm])
    for i0 in range(WARM, len(y), STEP): w = np.linalg.lstsq(Xa[:i0], y[:i0], rcond=None)[0]; sl = slice(i0, min(i0 + STEP, len(y))); p[sl] = Xa[sl] @ w
    return p


def wboot(v):
    g = {k: np.where((wk == k) & sc)[0] for k in sorted(set(wk[sc]))}; keys = list(g); out = [float(np.mean(v[np.concatenate([g[keys[j]] for j in rng.integers(0, len(keys), len(keys))])])) for _ in range(B)]
    return float(np.quantile(out, CIQ[0] / 100)), float(np.quantile(out, CIQ[1] / 100))


p0, a0 = walk_ridge(X(BASE), y); p1 = walk_ols(X(HAR), y); p2 = walk_ols(X(HARX), y); p3, a3 = walk_ridge(X(S0), y); p4, a4 = walk_ridge(X(HARX + S0), y)
L = {k: (y - p) ** 2 for k, p in (('M0 baseline', p0), ('M1 HAR', p1), ('M2 HAR-X', p2), ('M3 stage 0', p3), ('M4 HAR-X + stage 0', p4))}
b0 = float(np.nanmean(L['M0 baseline'][sc])); b2 = float(np.nanmean(L['M2 HAR-X'][sc]))
print('\nLOSS (mean squared error of the log range ratio, scored sessions):')
for k, v in L.items(): m = float(np.nanmean(v[sc])); print(f'  {k:20s} {m:.4f}  ({100 * (b0 - m) / b0:+.1f}% vs M0 baseline, {100 * (b2 - m) / b2:+.1f}% vs M2 HAR-X)')
print(f'PARITY: M3 stage 0 over M0 baseline {100 * (b0 - float(np.nanmean(L["M3 stage 0"][sc]))) / b0:+.1f}% (the day forecast reported +10.7% on its own, slightly longer sample)')
# placebo for T2: shift the stage-0 columns circularly (penalties reused), improvement of M4-with-shifted-columns over M2
Xs0 = X(HARX + S0); idx = list(range(len(HARX), Xs0.shape[1])); plc = []
for _ in range(DRAWS):
    lag = int(rng.integers(10, N - 10)); Xs = Xs0.copy(); Xs[:, idx] = np.roll(Xs0[:, idx], lag, axis=0); pp, _ = walk_ridge(Xs, y, a4); plc.append(float(np.nanmean((L['M2 HAR-X'] - (y - pp) ** 2)[sc])))
plc = np.array(plc); gate = max(0.0, float(np.quantile(plc - plc.mean(), .975))); det = 2.8 * float(plc.std())
print(f'\nDETECTABLE improvement (2.8 x placebo SD): {100 * det / b2:.1f}% of the M2 HAR-X loss')
half = np.array_split(np.where(sc)[0], 2)
for lab, d in (('T1 M3 stage 0 vs M2 HAR-X (positive = our forecast is better)', L['M2 HAR-X'] - L['M3 stage 0']), ('T2 M4 (HAR-X + stage 0) vs M2 HAR-X (positive = stage 0 adds)', L['M2 HAR-X'] - L['M4 HAR-X + stage 0'])):
    obs = float(np.nanmean(d[sc])); ci = wboot(d); hv = [float(np.nanmean(d[h])) for h in half]
    ok = dict(ci_lower_above_0=ci[0] > 0, same_sign_both_halves=min(hv) > 0) if lab.startswith('T1') else dict(ci_lower_above_0=ci[0] > 0, above_zero_centred_placebo=obs > gate, same_sign_both_halves=min(hv) > 0)
    print(f'  {lab}: improvement {obs:+.5f} ({100 * obs / b2:+.2f}% of the HAR-X loss) CI97.5 [{ci[0]:+.5f}, {ci[1]:+.5f}] halves {hv[0]:+.5f}/{hv[1]:+.5f}' + (f' placebo gate {gate:+.5f}' if lab.startswith('T2') else '') + f'\n      conditions {ok} => ' + ('LEAD' if all(ok.values()) else 'NOT SHOWN'))
d10 = L['M0 baseline'] - L['M1 HAR']; print(f'\nPRINTED (uncounted): M1 HAR vs M0 baseline {100 * float(np.nanmean(d10[sc])) / b0:+.1f}% of the baseline loss, CI [{wboot(d10)[0]:+.5f}, {wboot(d10)[1]:+.5f}] (does the standard model beat the forecast baseline?)')
for lab, p in (('M0 baseline', p0), ('M2 HAR-X', p2), ('M3 stage 0', p3), ('M4 HAR-X + stage 0', p4)):
    w = np.exp(p[sc]); print(f'  implied width multiplier exp(prediction): {lab:20s} mean {w.mean():.3f}, SD {w.std():.3f} ({100 * w.std() / w.mean():.0f}% of the mean)  -> a stop scaled by it would vary by about that much')
print(f'  correlation of M3 and M2 predictions {np.corrcoef(p3[sc], p2[sc])[0, 1]:.3f}; M4 and M2 {np.corrcoef(p4[sc], p2[sc])[0, 1]:.3f}')
# added after DeepSeek round W (uncounted, appended last so every earlier printed number is unchanged): the interval for 'HAR-X beats the forecast baseline'
d20 = L['M0 baseline'] - L['M2 HAR-X']; ci20 = wboot(d20); print(f'\nAFTER ROUND W (uncounted): M2 HAR-X vs M0 baseline {100 * float(np.nanmean(d20[sc])) / b0:+.1f}% of the baseline loss, week-block CI97.5 [{ci20[0]:+.5f}, {ci20[1]:+.5f}]')
