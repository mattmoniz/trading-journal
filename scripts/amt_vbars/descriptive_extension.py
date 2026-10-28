"""DESCRIPTIVE ONLY (not pre-registered): after the tell, how far does price go for and against the trade within 60 minutes, and how far does it extend beyond the range once it breaks? TELL5 vs moving-only, within distance strata."""
import numpy as np, pandas as pd
df = pd.read_csv('decision_points_explore.csv'); df['tell'] = df.ncomp == 5; df['mv'] = df.moving & (df.ncomp < 5)
ATR = 290.0   # rough ATR20 in points, only to give a feel for the units
def row(g): return f"N={len(g):5d} MFE {g.mfe.mean():.4f} MAE {g.mae.mean():.4f} (pts~ {g.mfe.mean()*ATR:4.1f}/{g.mae.mean()*ATR:4.1f}) MFE>MAE {100*(g.mfe>g.mae).mean():4.1f}% in profit at 60m {100*(g.fwd>0).mean():4.1f}% break {100*g.brk.mean():4.1f}%"
for s in (None, 0, 1, 2):
    g = df if s is None else df[df.stratum == s]
    print(('ALL strata' if s is None else f'stratum {s} (0 = nearest the boundary)'))
    print('  TELL5      ', row(g[g.tell])); print('  moving-only', row(g[g.mv]))
print('\nGIVEN A BREAK (extension beyond the range edge within 60 minutes, ATR20 units):')
for s in (None, 0, 1, 2):
    g = df if s is None else df[df.stratum == s]; a, b = g[g.tell & g.brk], g[g.mv & g.brk]
    print(f"  {'ALL' if s is None else 'stratum '+str(s):10s} TELL5 breaks N={len(a):4d} mean ext {a.ext.mean():.4f} (~{a.ext.mean()*ATR:.1f} pts) median {a.ext.median():.4f} fwd60 {a.fwd.mean():+.4f} | moving-only breaks N={len(b):5d} mean ext {b.ext.mean():.4f} (~{b.ext.mean()*ATR:.1f} pts) median {b.ext.median():.4f} fwd60 {b.fwd.mean():+.4f}")
