"""Cost-of-risk curve (docs/TELL_RISK_CAP_COST_CURVE_PREREG_20261104.md): the tell stop capped at C points on the 1,760 explore entries, V1 management otherwise unchanged. Descriptive, no verdict.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_risk_cap_curve.py   (look logged first, hr-023)"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, REPO, T
from watcher_stop_lib import run_dyn

CAPS = (40, 60, 80, 100, 150, 200); H10, H11 = 57600.0, 61200.0
rng = np.random.default_rng(20261104)


def extra(S, allb, sig, t, ctxf):
    ctx = S['_ctx']; d = int(t['dir']); ei = int(t['ei']); risk = float(t['risk']); end_i = S['end'][sig]
    out = dict(ehr=float(S['start'][ei]), risk=risk)
    v1 = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i)[0]; out.update(v1_net=v1['net'], v1_why=v1['reason'])
    for c in CAPS:
        if risk > c: tr = run_dyn(ctx, T.Prof(ctx), ei, d, c, end_i)[0]; out.update({f'c{c}_net': tr['net'], f'c{c}_why': tr['reason'], f'c{c}_capped': True})
        else: out.update({f'c{c}_net': v1['net'], f'c{c}_why': v1['reason'], f'c{c}_capped': False})
    return out


def boot(x, days, B=4000):
    x = np.asarray(x, float); s = pd.Series(x).groupby(days).agg(['sum', 'count']); sm, ct = s['sum'].values, s['count'].values; m = np.empty(B)
    for b in range(B): p = rng.integers(0, len(sm), len(sm)); m[b] = sm[p].sum() / ct[p].sum()
    return np.percentile(m, [2.5, 97.5])


R, bad = replay_rows(extra)
R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_risk_cap_rows.csv'), index=False)
print(f'{len(R)} entries ({bad} without an entry bar); PARITY v1 vs the file: max |diff| {np.abs(R["v1_net"] - R.csv_net).max():.4f}, trades differing by more than 0.01: {int((np.abs(R["v1_net"] - R.csv_net) > 0.01).sum())}')
print(f'tell stop distance (points): median {R.risk.median():.0f}, p75 {R.risk.quantile(.75):.0f}, p90 {R.risk.quantile(.9):.0f}, p95 {R.risk.quantile(.95):.0f}, p99 {R.risk.quantile(.99):.0f}, max {R.risk.max():.0f}; share over 100 points {100 * (R.risk > 100).mean():.1f}%, over 200 {100 * (R.risk > 200).mean():.1f}%')
def day_stats(col): dn = R.groupby('date')[col].sum(); cum = dn.sort_index().cumsum(); return dn.min(), float((cum - cum.cummax()).min())
cols = [('V1 (no cap)', 'v1_net', None)] + [(f'cap {c} pts', f'c{c}_net', c) for c in CAPS]
print('\nTHE CURVE (all 1,760 entries; dollars; one contract):')
print('  cap          capped   mean/trade   diff vs V1 [95% CI]        total given up   win%   avg win  avg loss   worst   p1     p5    worst day   max drawdown')
for lab, col, c in cols:
    x = R[col]; d = (x - R.v1_net).values; ci = boot(d, R.date.values) if c else (0, 0); wd, dd = day_stats(col); capd = R[f'c{c}_capped'].mean() * 100 if c else 0.0
    print(f'  {lab:11s} {capd:5.1f}%  {x.mean():+8.2f}   {d.mean():+7.2f} [{ci[0]:+6.2f}, {ci[1]:+6.2f}]   {R.v1_net.sum() - x.sum():+10.0f}   {100 * (x > 0).mean():4.0f}  {x[x > 0].mean():+7.1f}  {x[x <= 0].mean():+7.1f}  {x.min():+7.1f} {x.quantile(.01):+6.1f} {x.quantile(.05):+6.1f}  {wd:+9.0f}  {dd:+9.0f}')
print('\nPROFIT GIVEN UP BY BUCKET OF THE TELL STOP (sum of V1 net minus capped net; N trades capped):')
for lab, m in (('under 50', R.risk < 50), ('50 to 100', (R.risk >= 50) & (R.risk < 100)), ('over 100', R.risk >= 100)):
    print(f'  {lab:9s} (N={int(m.sum()):4d}, V1 profit {R.v1_net[m].sum():+7.0f}) ' + '  '.join(f'cap {c}: {R.v1_net[m].sum() - R[f"c{c}_net"][m].sum():+6.0f}' for c in CAPS))
print('\nCOST PER DOLLAR OF RISK REMOVED (profit given up / reduction in the worst loss; / reduction in the 1st-percentile loss):')
for c in CAPS:
    gu = R.v1_net.sum() - R[f'c{c}_net'].sum(); dw = R[f'c{c}_net'].min() - R.v1_net.min(); d1 = R[f'c{c}_net'].quantile(.01) - R.v1_net.quantile(.01)
    print(f'  cap {c:3d}: given up {gu:+7.0f}; worst loss {R.v1_net.min():+.0f} -> {R[f"c{c}_net"].min():+.0f} ({dw:+.0f}) => {gu / dw if dw > 0 else float("nan"):6.1f} per $ of worst loss; p1 {R.v1_net.quantile(.01):+.0f} -> {R[f"c{c}_net"].quantile(.01):+.0f} ({d1:+.0f}) => {gu / d1 if d1 > 0 else float("nan"):6.1f} per $')
fh = (R.ehr >= H10) & (R.ehr < H11); print('\nBY ENTRY HOUR (descriptive): mean diff vs V1 per trade')
for lab, m in (('10:00-10:59', fh), ('11:00 on', ~fh)): g = R[m]; print(f'  {lab:12s} N={len(g):4d}  V1 {g.v1_net.mean():+6.2f}' + ''.join(f'  cap {c}: {(g[f"c{c}_net"] - g.v1_net).mean():+6.2f}' for c in CAPS))
