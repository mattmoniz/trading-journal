"""Addendum A3 of docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md: scaled rotation threshold R* = 0.1786 x ADR (65 points at ADR 364). Usage: venv/bin/python scripts/tell_context/research_20261103/ovn_orderflow_scaled.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ovn_sim import sim, load_days, SLIP
from block_stats import bootmean, bootdiff
DAY = load_days(); rng = np.random.default_rng(211); dates = sorted(DAY); rr = {}; C = 65 / 364.0; GRID = np.arange(20, 201, 10)
for d in dates:
    x = DAY[d]; m = np.array(x['m']); k = (m >= 570) & (m < 960); rr[d] = float(np.max(np.array(x['h'])[k]) - np.min(np.array(x['l'])[k])) if k.sum() > 300 else np.nan
rows = []
for i, dte in enumerate(dates):
    x = DAY[dte]; prior = [rr[p] for p in dates[max(0, i - 20):i] if np.isfinite(rr[p])]
    if len(prior) < 15: continue
    adr = float(np.median(prior)); net = x['ask'] - x['bid']; tot = x['ask'] + x['bid']
    if tot <= 0 or net == 0: continue
    rstar = C * adr; g = int(GRID[np.argmin(np.abs(GRID - rstar))]); d = 1 if net > 0 else -1; m = np.array(x['m']); j0 = int(np.argmax(m >= 0)); en = x['o'][j0]
    nl = sim(x, 1, en + SLIP, 400, 870)[0]; ns = sim(x, -1, en - SLIP, 400, 870)[0]; mom = np.sign(x['c_pre'] - x['open18']) or 1
    rows.append(dict(d=dte, dir=d, adr=adr, rstar=rstar, grid=g, legs65=x['legs'], legs_s=x['legs_grid'][str(g)], flow=nl if d == 1 else ns, mom=nl if mom == 1 else ns, L=nl, S=ns, st150=sim(x, d, en + d * SLIP, 150, 870)[0], st200=sim(x, d, en + d * SLIP, 200, 870)[0], st300=sim(x, d, en + d * SLIP, 300, 870)[0]))
R = pd.DataFrame(rows); R['yr'] = R.d.str[:4]; R['on_s'] = R.legs_s >= 6; R['on_65'] = R.legs65 >= 6; half = R.d.sort_values().iloc[len(R) // 2]; R['half'] = np.where(R.d < half, 1, 2)
print(f'{len(R)} nights; split at {half}; median ADR by year: ' + ', '.join(f'{y} {g.adr.median():.0f} pts (R* {g.rstar.median():.0f})' for y, g in R.groupby('yr')))
print('legs by midnight, fixed 65 vs scaled R*: median by year ' + ', '.join(f'{y} {g.legs65.median():.0f} vs {g.legs_s.median():.0f}' for y, g in R.groupby('yr')))
a, b = R[R.on_s], R[~R.on_s]; ca = bootmean(a.flow.values, a.d.values, rng, B=2000); cd = bootdiff(a.flow.values, a.d.values, b.flow.values, b.d.values, rng); h = [a[a.half == k].flow.mean() - b[b.half == k].flow.mean() for k in (1, 2)]
print(f'\nT1 SCALED legs >= 6: ON N={len(a)} mean {a.flow.mean():+.1f} CI [{ca[0]:+.0f}, {ca[1]:+.0f}] win {100*(a.flow>0).mean():.0f}% | OFF N={len(b)} mean {b.flow.mean():+.1f} | ON minus OFF {a.flow.mean() - b.flow.mean():+.1f} CI [{cd[0]:+.0f}, {cd[1]:+.0f}] halves {h[0]:+.0f}/{h[1]:+.0f}  -> ' + ('LEAD' if cd[0] > 0 and min(h) > 0 else 'not shown'))
a65 = R[R.on_65]; print(f'   (fixed 65: ON N={len(a65)} mean {a65.flow.mean():+.1f}; overlap: {int((R.on_s & R.on_65).sum())} nights are ON under both; scaled-only {int((R.on_s & ~R.on_65).sum())}, fixed-only {int((~R.on_s & R.on_65).sum())})')
E = R[R.on_s & (R.yr < '2026')]; P = []
for _ in range(4000):
    s = rng.random(len(E)) < .5; P.append(np.where(s, E.L, E.S).mean())
P = np.array(P); print(f'T2 SCALED ON nights of 2023-2025 only: N={len(E)} flow-sign trade mean {E.flow.mean():+.1f} win {100*(E.flow>0).mean():.0f}%  | random-direction placebo {P.mean():+.1f} (sd {P.std():.1f}); observed above {100*(P < E.flow.mean()).mean():.1f}% of draws' + (f'  CI [{bootmean(E.flow.values, E.d.values, rng, B=1500)[0]:+.0f}, {bootmean(E.flow.values, E.d.values, rng, B=1500)[1]:+.0f}]' if len(E) >= 20 else '  (N<20)'))
cm = bootmean((a.flow - a.mom).values, a.d.values, rng, B=2000); print(f'T3 on the scaled ON nights: flow-sign trade {a.flow.mean():+.1f} minus following the overnight price move {a.mom.mean():+.1f} = {(a.flow - a.mom).mean():+.1f} CI [{cm[0]:+.0f}, {cm[1]:+.0f}]')
print('\nBY YEAR (ON N, flow-sign mean): fixed 65 vs scaled')
for y, g in R.groupby('yr'): print(f'  {y}: nights {len(g):3d} | fixed65 ON {int(g.on_65.sum()):3d} mean {g[g.on_65].flow.mean() if g.on_65.any() else float("nan"):+7.1f} | scaled ON {int(g.on_s.sum()):3d} mean {g[g.on_s].flow.mean() if g.on_s.any() else float("nan"):+7.1f}')
print('\nSTOP SWEEP inside the scaled ON set (mean / worst): ' + '; '.join(f'{lab} {a[col].mean():+.0f} / {a[col].min():+.0f}' for lab, col in (('150', 'st150'), ('200', 'st200'), ('300', 'st300'))) + f'; 400 {a.flow.mean():+.0f} / {a.flow.min():+.0f}')
R.to_csv(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'scratch', 'ovn_orderflow_20261104', 'rows_scaled.csv'), index=False)
