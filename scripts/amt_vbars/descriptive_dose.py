"""DESCRIPTIVE ONLY (not pre-registered): break rate and signed 60-min move by number of tell components met, strata-matched, and TELL5 by direction / decision hour."""
import numpy as np, pandas as pd
df = pd.read_csv('decision_points_explore.csv')
print('by number of components met (0-5):')
for k, g in df.groupby('ncomp'):
    print(f"  {int(k)}: N={len(g):5d} dates={g.date.nunique():3d} break {100*g.brk.mean():5.1f}% signed60 {g.fwd.mean():+.4f}")
print('\nwithin distance strata (break rate):')
for s in range(3):
    g = df[df.stratum == s]; t5 = g[g.ncomp == 5]; mv = g[g.moving & (g.ncomp < 5)]
    print(f"  stratum {s}: TELL5 N={len(t5):4d} break {100*t5.brk.mean():5.1f}% | moving-only N={len(mv):5d} break {100*mv.brk.mean():5.1f}% | signed60 {t5.fwd.mean():+.4f} vs {mv.fwd.mean():+.4f}")
t5 = df[df.ncomp == 5]
print('\nTELL5 by direction:'); [print(f"  dir {d:+d}: N={len(g)} break {100*g.brk.mean():.1f}% signed60 {g.fwd.mean():+.4f}") for d, g in t5.groupby('dir')]
t5 = t5.assign(hour=((64800 + t5.t) % 86400 // 3600).astype(int))
print('TELL5 by decision hour (ET):'); [print(f"  {h:02d}h: N={len(g)} break {100*g.brk.mean():.1f}% signed60 {g.fwd.mean():+.4f}") for h, g in t5.groupby('hour')]
