"""Addendum A4 of docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md: the order-flow sign from the tick-built bar files vs the database ask / bid split. Usage: venv/bin/python scripts/tell_context/research_20261103/ovn_orderflow_tickflow.py"""
import os, sys, glob
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from block_stats import bootmean
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); rng = np.random.default_rng(223)
R = pd.read_csv(os.path.join(REPO, 'scratch', 'ovn_orderflow_20261104', 'rows_scaled.csv'))
paths = {}
for root in ('volbars500_full_20261028', 'volbars500_holdout_20261103'):
    for p in glob.glob(os.path.join(REPO, 'scratch', root, '*.bars.tsv')): paths[os.path.basename(p)[:10]] = p
tick = {}
for d in R.d:
    p = paths.get(d)
    if not p: continue
    b = np.loadtxt(p, delimiter='\t', ndmin=2); k = b[:, 2] <= 10800.0                              # bars completed by 21:00 ET (seconds since the 18:00 open)
    if k.sum() < 5: continue
    net = float((b[k, 9] - b[k, 8]).sum())
    if net != 0: tick[d] = 1 if net > 0 else -1
R = R[R.d.isin(tick)].copy(); R['dt'] = R.d.map(tick); R['flow_t'] = np.where(R.dt == 1, R.L, R.S); R['agree'] = R.dt == R.dir; R['yr'] = R.d.str[:4]
print(f'{len(R)} nights with a tick-flow sign (of the {len(pd.read_csv(os.path.join(REPO, "scratch", "ovn_orderflow_20261104", "rows_scaled.csv")))} with a database sign)')
print('\nT1 SIGN AGREEMENT database vs tick flow, by year: ' + ', '.join(f'{y} {100*g.agree.mean():.0f}% (N={len(g)})' for y, g in R.groupby('yr')) + f'; overall {100*R.agree.mean():.0f}%')
R['q'] = R.d.str[:4] + 'Q' + ((R.d.str[5:7].astype(int) - 1) // 3 + 1).astype(str); print('   by quarter: ' + ', '.join(f'{q} {100*g.agree.mean():.0f}%' for q, g in R.groupby('q')))
print('\nBASELINE with the TICK flow sign (stop 400, exit 14:30): legs >= 6 nights (fixed 65), by year: database sign vs tick sign')
for y, g in R.groupby('yr'):
    on = g[g.legs65 >= 6]
    if len(on): print(f'  {y}: legs>=6 N={len(on):3d} | DB-flow mean {on.flow.mean():+7.1f} | TICK-flow mean {on.flow_t.mean():+7.1f} (win {100*(on.flow_t>0).mean():.0f}%)')
    else: print(f'  {y}: legs>=6 N=  0')
E = R[(R.legs65 >= 6) & (R.d < '2025-11-01')]; P = np.array([np.where(rng.random(len(E)) < .5, E.L, E.S).mean() for _ in range(4000)])
if len(E) >= 5: print(f'\nT2 legs >= 6 nights 2023-05..2025-10 with the TICK sign: N={len(E)} mean {E.flow_t.mean():+.1f} win {100*(E.flow_t>0).mean():.0f}% | random-direction placebo {P.mean():+.1f} (sd {P.std():.1f}); observed above {100*(P < E.flow_t.mean()).mean():.1f}% of draws')
S = R[R.legs65 >= 6]; print(f'legs >= 6 nights, all years with tick flow: N={len(S)} mean {S.flow_t.mean():+.1f} (DB sign {S.flow.mean():+.1f}); all nights with the tick sign: mean {R.flow_t.mean():+.1f} N={len(R)}')
print('\nthe scaled ON nights with the tick sign by year: ' + ', '.join(f'{y} N={int(g.legs_s.ge(6).sum())} mean {g[g.legs_s >= 6].flow_t.mean() if g.legs_s.ge(6).any() else float("nan"):+.0f}' for y, g in R.groupby('yr')))
