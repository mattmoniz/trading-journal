"""DESCRIPTIVE ONLY (not pre-registered, in-sample on explore): what a target at k x the stop distance would have done to the V1 tell trades, from each trade's own max favorable excursion before its exit (mfe is recorded before the original exit, so mfe >= target means the target was reached first; stop-bar excursions are not counted, which is conservative)."""
import numpy as np, pandas as pd
d = pd.read_csv('trades_V1_explore.csv'); COMM, DPP, TICK = 2.0, 2.0, 0.25
print(f"V1 tell trades N={len(d)}: long {int((d.dir==1).sum())} short {int((d.dir==-1).sum())}; mean net long {d[d.dir==1].net.mean():+.2f} short {d[d.dir==-1].net.mean():+.2f}")
print(f"risk (pts) median {d.risk.median():.1f}; share of trades with risk > 50: {100*(d.risk>50).mean():.0f}%, > 100: {100*(d.risk>100).mean():.0f}%")
def with_target(g, k, fixed=None):
    tgt = (g.risk * k) if fixed is None else pd.Series(fixed, index=g.index)
    hit = g.mfe >= tgt + TICK
    net = np.where(hit, tgt * DPP - COMM, g.net)
    return hit.mean(), float(np.mean(net)), float(np.mean(g.net))
print('\nTarget = k x stop distance (R-multiple), all trades:')
for k in (0.5, 1, 1.5, 2, 3, 4):
    h, m, base = with_target(d, k); print(f"  k={k:<3}: reached {100*h:4.1f}% | mean net with target {m:+7.2f} vs without {base:+7.2f}")
print('\nBy stop-distance bucket (risk pts): no target / k=1 / k=2 / k=3')
bk = pd.cut(d.risk, [0, 15, 30, 60, 100, 1000], labels=['<=15', '15-30', '30-60', '60-100', '>100'])
for b, g in d.groupby(bk, observed=True):
    r = [with_target(g, k)[1] for k in (1, 2, 3)]
    print(f"  {str(b):7s} N={len(g):4d} WR {100*(g.net>0).mean():4.1f}% broke {100*g.broke.mean():4.1f}% no target {g.net.mean():+7.2f} | k=1 {r[0]:+7.2f} (reach {100*with_target(g,1)[0]:.0f}%) k=2 {r[1]:+7.2f} (reach {100*with_target(g,2)[0]:.0f}%) k=3 {r[2]:+7.2f} (reach {100*with_target(g,3)[0]:.0f}%)")
print('\nSkipping wide stops (what the cap would remove), no target:')
for cap in (50, 80, 100, 150):
    g = d[d.risk <= cap]; print(f"  cap <= {cap:3d} pts: N={len(g):4d} mean {g.net.mean():+6.2f} total {g.net.sum():+8.0f} | removed N={len(d)-len(g):3d} mean {d[d.risk>cap].net.mean():+7.2f} total {d[d.risk>cap].net.sum():+8.0f}")
