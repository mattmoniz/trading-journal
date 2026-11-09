"""A3 (docs/IMBALANCE_BREAKOUT_PREREG_20261104.md section 13): per-bar diagonal imbalances and stacks on 1000 / 2000 / 5000 / 10000-contract volume bars (exact merges of the 500-contract bars) over the same 10,000-contract window ending at the decision bar. Reads the A2 event table (date, t = end of the decision bar, d, y, volr ...), writes imbalance_events_a3.csv with the per-size features; statistics are in imbalance_sizes_stats.py."""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from imbalance_lib import load, agg, imbalances, stacks, REPO, WIN
SIZES = (1000, 2000, 5000, 10000); MAX_EARLIER, MIN_EARLIER = 300, 10


def size_features(S, dj, d, V):
    g = V // 500; K = WIN // g; ws = dj - WIN + 1; out = {}
    earlier = []; e = ws - 1
    while e - g + 1 >= 0 and len(earlier) < MAX_EARLIER: earlier.append(agg(S, e - g + 1, e)); e -= g
    if len(earlier) < MIN_EARLIER: return None
    a = np.concatenate([x[1][x[1] > 0] for x in earlier]); b = np.concatenate([x[2][x[2] > 0] for x in earlier]); minb, mins = float(np.median(a)), float(np.median(b)); cells = []
    for R in (3, 4):
        sa = so = bars = 0
        for m in range(K):
            i1 = dj - m * g; i0 = i1 - g + 1; lo, ask, bid = agg(S, i0, i1); buy, sell = imbalances(ask, bid, R, minb, mins); al, op = (buy, sell) if d == 1 else (sell, buy); na = stacks(al); sa += na; so += stacks(op); bars += int(na > 0)
            if R == 3: cells.append(int(((ask + bid) > 0).sum()))
        out.update({f'bsa{R}_{V}': sa, f'bso{R}_{V}': so, f'bnet{R}_{V}': sa - so, f'bbars{R}_{V}': bars})
    out[f'cells_{V}'] = float(np.mean(cells)); out[f'minvol_{V}'] = minb; return out


if __name__ == '__main__':
    E = pd.read_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'imbalance_events_a2.csv')); keep = []
    for d, g in E.groupby('date'):
        S = load(d)
        for k, r in g.iterrows():
            dj = int(np.searchsorted(S['end'], r.t))
            assert abs(S['end'][dj] - r.t) < 1e-6, (d, r.t)
            row = {}
            for V in SIZES:
                f = size_features(S, dj, int(r.d), V)
                if f is None: row = None; break
                row.update(f)
            if row is not None: keep.append({**r.to_dict(), **row})
    A = pd.DataFrame(keep); A.to_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'imbalance_events_a3.csv'), index=False); print(len(E), 'events in the A2 table;', len(A), 'with enough earlier bars at every size')
    print(A[[c for c in A.columns if c.startswith('bsa3_') or c.startswith('cells_')]].describe().round(2).T[['mean', 'std', 'max']].to_string())
