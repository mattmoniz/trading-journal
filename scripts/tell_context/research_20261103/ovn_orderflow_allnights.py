"""Addendum A1 of docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md: the order-flow trade on ALL nights, to give the variants a data-derived basis. Usage: venv/bin/python scripts/tell_context/research_20261103/ovn_orderflow_allnights.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ovn_sim import sim, load_days, SLIP
from block_stats import bootmean, bootdiff
DAY = load_days(); rng = np.random.default_rng(191); dates = sorted(DAY); rngs = {}
for d in dates:
    x = DAY[d]; m = np.array(x['m']); k = (m >= 570) & (m < 960); rngs[d] = float(np.max(np.array(x['h'])[k]) - np.min(np.array(x['l'])[k])) if k.sum() > 300 else np.nan
rows = []
for i, dte in enumerate(dates):
    x = DAY[dte]; prior = [rngs[p] for p in dates[max(0, i - 20):i] if np.isfinite(rngs[p])]; net = x['ask'] - x['bid']; tot = x['ask'] + x['bid']
    if len(prior) < 15 or tot <= 0 or net == 0: continue
    adr = float(np.median(prior)); d = 1 if net > 0 else -1; m = np.array(x['m']); j0 = int(np.argmax(m >= 0)); en = x['o'][j0]
    nl, _ = sim(x, 1, en + SLIP, 400, 870); ns, _ = sim(x, -1, en - SLIP, 400, 870); k = (m >= 570) & (m < 960); ii = np.where(k)[0]
    rows.append(dict(d=dte, dir=d, flow=abs(net) / tot, chase=d * (x['c_pre'] - x['open18']) / adr, legs=x['legs'], L=nl, S=ns, chosen=nl if d == 1 else ns, hit=float(np.sign(x['c'][ii[-1]] - x['o'][ii[0]]) == d)))
R = pd.DataFrame(rows); R['yr'] = R.d.str[:4]
print(f'{len(R)} nights with a flow sign (2023-03..2026-11); LONG {int((R.dir == 1).sum())} / SHORT {int((R.dir == -1).sum())}; the market (always LONG) {R.L.mean():+.1f}, always SHORT {R.S.mean():+.1f} dollars per trade')
c = bootmean(R.chosen.values, R.d.values, rng, B=2000); P = np.array([np.where(rng.random(len(R)) < .5, R.L, R.S).mean() for _ in range(3000)])
print(f'\nT5 ALL NIGHTS: flow-sign trade mean {R.chosen.mean():+.1f} dollars CI [{c[0]:+.1f}, {c[1]:+.1f}]  win {100*(R.chosen>0).mean():.0f}%  RTH-direction hit {100*R.hit.mean():.1f}%  | random-direction placebo {P.mean():+.1f} (sd {P.std():.1f}); observed above {100*(P < R.chosen.mean()).mean():.1f}% of draws')
a, b = R[R.legs >= 6], R[R.legs < 6]; cd = bootdiff(a.chosen.values, a.d.values, b.chosen.values, b.d.values, rng)
print(f'T6 legs >= 6 (N={len(a)}) {a.chosen.mean():+.1f} minus legs < 6 (N={len(b)}) {b.chosen.mean():+.1f}: {a.chosen.mean() - b.chosen.mean():+.1f}  day-block CI [{cd[0]:+.0f}, {cd[1]:+.0f}]')
def tab(title, groups):
    print('\n' + title)
    for lab, g in groups:
        if len(g) == 0: continue
        cc = bootmean(g.chosen.values, g.d.values, rng, B=800); print(f'  {lab:34s} N={len(g):4d}  mean {g.chosen.mean():+7.1f} CI [{cc[0]:+.0f}, {cc[1]:+.0f}]  win {100*(g.chosen>0).mean():3.0f}%  hit {100*g.hit.mean():3.0f}%' + ('  (N<20)' if len(g) < 20 else ''))
tab('BY ROTATION COUNT BY MIDNIGHT', [(f'{lo}-{hi} legs', R[(R.legs >= lo) & (R.legs <= hi)]) for lo, hi in ((0, 2), (3, 5), (6, 9), (10, 14), (15, 999))])
q = np.quantile(R.flow, [.2, .4, .6, .8]); tab('BY FLOW STRENGTH (quintiles of |flow share|; cuts over all nights)', [(f'quintile {i+1} (|flow| {lo:.1%}-{hi:.1%})', R[(R.flow >= lo) & (R.flow <= hi if i == 4 else R.flow < hi)]) for i, (lo, hi) in enumerate(zip([0] + list(q), list(q) + [1]))])
t = np.quantile(R.chase, [1 / 3, 2 / 3]); tab('BY THE MOVE ALREADY MADE IN THE TRADE DIRECTION SINCE 18:00 (ADR units; terciles over all nights)', [(f'tercile {i+1} ({lo:+.2f} to {hi:+.2f} ADR)', R[(R.chase >= lo) & (R.chase <= hi if i == 2 else R.chase < hi)]) for i, (lo, hi) in enumerate(zip([-9] + list(t), list(t) + [9]))])
tab('THE 1.0 ADR CHASE CUT AND ITS MIRROR', [('chased > 1.0 ADR', R[R.chase > 1.0]), ('moved against the trade, < -0.5 ADR', R[R.chase < -0.5]), ('between', R[(R.chase >= -0.5) & (R.chase <= 1.0)])])
tab('BY YEAR', [(y, g) for y, g in R.groupby('yr')]); tab('LONG vs SHORT', [('LONG nights', R[R.dir == 1]), ('SHORT nights', R[R.dir == -1])])
big = R[(R.legs >= 6)]; print('\nINSIDE the legs >= 6 nights: flow strength by tercile of |flow| (N 87): ' + ', '.join(f'{g.chosen.mean():+.0f} (N={len(g)})' for _, g in big.groupby(pd.qcut(big.flow, 3, duplicates="drop"))))
R.to_csv(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'scratch', 'ovn_orderflow_20261104', 'rows_allnights.csv'), index=False)
