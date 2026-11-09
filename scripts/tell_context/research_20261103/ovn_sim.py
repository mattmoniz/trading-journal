"""Overnight order-flow trade simulation shared by the variation study and its controls (docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md, hr-022)."""
import os, json
import numpy as np
SLIP, DPP, COMM = 0.25, 2.0, 2.0
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
def load_days(): return json.load(open(os.path.join(REPO, 'scratch', 'ovn_orderflow_20261104', 'days.json')))
def sim(x, d, entry, stop_pts, exit_m):
    """Entry at the 00:00 bar; V1-style management: a stop beyond the market fills at the bar open, a touched stop fills at its price minus 1 tick, exit at the open of the bar at exit_m minus 1 tick."""
    m, o, h, l = np.array(x['m']), np.array(x['o']), np.array(x['h']), np.array(x['l']); stop = None if not np.isfinite(stop_pts) else entry - d * stop_pts
    for j in range(len(m)):
        if m[j] >= exit_m: px, why = o[j] - d * SLIP, 'EXIT'; break
        if stop is not None:
            if j > 0 and d * (o[j] - stop) <= 0: px, why = o[j] - d * SLIP, 'STOP_GAP'; break
            if (d == 1 and l[j] <= stop) or (d == -1 and h[j] >= stop): px, why = stop - d * SLIP, 'STOP'; break
    else: px, why = float(x['c'][-1]), 'EOS'
    return ((px - entry) * d) * DPP - COMM, why
