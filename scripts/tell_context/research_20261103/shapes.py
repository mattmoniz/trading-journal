"""Profile-shape measures per RTH session: POC position, skew, bimodality, 70% value area; features only (no outcome labels)."""
import glob, os, json, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import profile_shape as PS
RTH0, RTH1 = 55800.0, 79200.0
NB = 40                                              # bins across the session's own RTH range (scale-free)

def features(px, vol):
    f = PS.features(px, vol)
    return None if f is None else dict(lo=f['lo'], hi=f['hi'], P=f['P'], poc_pos=f['poc_pos'], skew=f['skew'], bimod=f['bimod'], val=f['val'], vah=f['vah'])

def load(path_bars, path_vap):
    b = np.loadtxt(path_bars, delimiter='\t', ndmin=2); v = np.loadtxt(path_vap, delimiter='\t', ndmin=2)
    rth = (b[:, 2] >= RTH0) & (b[:, 2] < RTH1); idx = set(b[rth, 0].astype(int).tolist())
    m = np.isin(v[:, 0].astype(int), list(idx)); return v[m, 1], v[m, 2]

out = {}
for p in sorted(glob.glob('/home/mmoniz/trading-journal/scratch/volbars500_full_20261028/*.bars.tsv')):
    d = os.path.basename(p)[:10]
    if d > '2025-05-16': continue
    px, vol = load(p, p.replace('.bars.', '.vap.'))
    if len(px) < 50: continue
    f = features(px, vol)
    if f: out[d] = f
for d in ('2026-10-30', '2026-11-02'):
    r = '/home/mmoniz/trading-journal/scratch/amt_tell_live/%s.split.' % d
    px, vol = load(r + 'bars.tsv', r + 'vap.tsv'); out[d] = features(px, vol)
sp = json.load(open(sys.argv[1])); R = {int(k): v for k, v in sp['R'].items()}
out['2026-11-03 (so far, 12:52)'] = features(list(R.keys()), list(R.values()))
json.dump(out, open(sys.argv[2], 'w')); print(len(out), 'sessions')
