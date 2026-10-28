"""DESCRIPTIVE ONLY (not pre-registered): explore trades split by how far beyond the zone the signal bar was (terciles from the signal population itself) and by direction."""
import numpy as np, pandas as pd
for name in ('signal', 'control'):
    d = pd.read_csv(f'trades_{name}_explore.csv'); q = d.dist.quantile([1/3, 2/3]).values
    d['bucket'] = np.where(d.dist <= q[0], 'near', np.where(d.dist <= q[1], 'mid', 'far'))
    print(f'\n{name}: distance terciles cut at {q[0]:.1f} / {q[1]:.1f} pts beyond the zone')
    for b, g in d.groupby('bucket'):
        print(f"  {b:5s} N={len(g):5d} WR {100*(g.net>0).mean():.1f}% mean ${g.net.mean():+.2f} ({g.pts.mean():+.2f} pts/contract) fwd15 {g.fwd15.mean():+.2f}  days {g.date.nunique()}")
    for dr, g in d.groupby('dir'): print(f"  dir {int(dr):+d} N={len(g)} mean ${g.net.mean():+.2f} fwd15 {g.fwd15.mean():+.2f}")
