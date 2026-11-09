"""Controls for the overnight order-flow baseline (docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md, a control added after the baseline looked strongly positive; written before it was run): direction mix and drift, a random-direction placebo, a circular-shift placebo of the flow sign against the nights, by year / direction, and the sign hit rate.
Usage: venv/bin/python scripts/tell_context/research_20261103/ovn_orderflow_controls.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ovn_sim import sim, load_days, SLIP
from block_stats import bootmean
DAY = load_days(); R = pd.read_csv(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'scratch', 'ovn_orderflow_20261104', 'rows.csv')); rng = np.random.default_rng(179)
long_, short_ = [], []
for d in R.d:
    x = DAY[d]; m = np.array(x['m']); j0 = int(np.argmax(m >= 0)); long_.append(sim(x, 1, x['o'][j0] + SLIP, 400, 870)[0]); short_.append(sim(x, -1, x['o'][j0] - SLIP, 400, 870)[0])
R['L'] = long_; R['S'] = short_; R['chosen'] = np.where(R.dir == 1, R.L, R.S); R['opp'] = np.where(R.dir == 1, R.S, R.L)
print(f'{len(R)} qualifying nights; direction mix: LONG {int((R.dir == 1).sum())} / SHORT {int((R.dir == -1).sum())}')
print(f'  chosen direction mean {R.chosen.mean():+.1f}; the OPPOSITE of the flow {R.opp.mean():+.1f}; always LONG {R.L.mean():+.1f}; always SHORT {R.S.mean():+.1f}  (stop 400, exit 14:30, dollars per trade)')
mean_obs = R.chosen.mean(); P = np.array([np.where(rng.random(len(R)) < .5, R.L, R.S).mean() for _ in range(5000)])
print(f'RANDOM-DIRECTION PLACEBO (same nights, same stop and exit, 5000 draws): placebo mean {P.mean():+.1f} sd {P.std():.1f}; observed {mean_obs:+.1f} is above {100*(P < mean_obs).mean():.1f}% of the draws (p about {(P >= mean_obs).mean():.4f})')
sg = np.where(R.dir == 1, 1, -1); out = []
for lag in range(5, len(R) - 5):
    s2 = np.roll(sg, lag); out.append(np.where(s2 == 1, R.L, R.S).mean())
out = np.array(out); print(f'CIRCULAR-SHIFT PLACEBO (the flow-sign series shifted against the nights by 5..{len(R) - 6} nights, keeps the LONG/SHORT mix): placebo mean {out.mean():+.1f} sd {out.std():.1f}; observed {mean_obs:+.1f} above {100*(out < mean_obs).mean():.1f}% of the shifts')
print('\nBY YEAR and BY DIRECTION (chosen direction, stop 400, exit 14:30)')
for y, g in R.groupby(R.d.str[:4]): print(f'  {y}: N={len(g):3d} mean {g.chosen.mean():+7.1f} win {100*(g.chosen>0).mean():3.0f}%  hit {100*g.hit.mean():3.0f}%  (LONG {int((g.dir == 1).sum())}, SHORT {int((g.dir == -1).sum())})')
for lab, dr in (('LONG nights', 1), ('SHORT nights', -1)): g = R[R.dir == dr]; c = bootmean(g.chosen.values, g.d.values, rng, B=1500); print(f'  {lab}: N={len(g)} mean {g.chosen.mean():+7.1f} CI [{c[0]:+.0f}, {c[1]:+.0f}] win {100*(g.chosen>0).mean():3.0f}%  hit {100*g.hit.mean():3.0f}%')
R['q'] = R.d.str[:4] + 'Q' + ((R.d.str[5:7].astype(int) - 1) // 3 + 1).astype(str); qm = R.groupby('q').chosen.agg(['count', 'mean']); print('\nBY QUARTER (N, mean): ' + '; '.join(f'{q} {int(r["count"])} {r["mean"]:+.0f}' for q, r in qm.iterrows()) + f'  -> quarters positive {int((qm["mean"] > 0).sum())} of {len(qm)}')
print(f'\nSIGN HIT RATE: flow sign predicted the RTH direction on {int(R.hit.sum())} of {len(R)} nights ({100*R.hit.mean():.0f}%); one-sided binomial p about {1 - __import__("math").erf(0) if False else ""}', end='')
from math import comb
n, k = len(R), int(R.hit.sum()); p = sum(comb(n, i) for i in range(k, n + 1)) / 2 ** n; print(f'{p:.3f}')
print(f'  and the RTH direction itself on these nights: up on {100*(R.rth_dir > 0).mean():.0f}% (drift check)')
