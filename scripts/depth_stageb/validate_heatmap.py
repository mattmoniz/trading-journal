"""Validation of extract_heatmap.py against the independent Node per-second summary (scratch/depth_persec_20261021): best bid/ask, size at best, 10-tick depth must agree. Usage: python validate_heatmap.py DATE [DATE...]"""
import sys, glob, numpy as np
OUT = '/home/mmoniz/trading-journal/scratch/depth_stageb_20261102'; DP = '/home/mmoniz/trading-journal/scratch/depth_persec_20261021'; R = 20
for date in sys.argv[1:]:
    f = sorted(glob.glob(f'{DP}/{date}.*.tsv'))
    if not f: print(date, 'no node summary'); continue
    a = np.loadtxt(max(f, key=lambda p: len(open(p).readlines())), delimiter='\t'); z = np.load(f'{OUT}/{date}.npz'); sec = a[:, 0].astype(int) - 34200; ok = (sec >= 0) & (sec < len(z['bb'])); a = a[ok]; sec = sec[ok]
    bb, ba, sz = z['bb'][sec], z['ba'][sec], z['sz'][sec]; valid = (bb >= 0) & (ba >= 0)
    mb, ma = (bb / 4.0), (ba / 4.0); n = valid.sum()
    eq = lambda x, y: float(np.mean(np.isclose(x[valid], y[valid], atol=1e-6)))
    szb = sz[:, R]; sza = np.array([sz[i, R + (ba[i] - bb[i])] if 0 <= ba[i] - bb[i] <= R else -1 for i in range(len(sec))])
    b10 = sz[:, R - 9:R + 1].sum(1); a10 = np.array([sz[i, R + (ba[i] - bb[i]):R + (ba[i] - bb[i]) + 10].sum() if 0 <= ba[i] - bb[i] <= R - 10 + 1 else -1 for i in range(len(sec))])
    print(f'{date}: seconds compared {n}; best bid match {eq(mb, a[:, 1]):.4f}, best ask {eq(ma, a[:, 2]):.4f}, size at best bid {eq(szb, a[:, 3]):.4f}, size at best ask {eq(sza, a[:, 4]):.4f}, 10-tick bid depth {eq(b10, a[:, 5]):.4f}, 10-tick ask depth {eq(a10, a[:, 6]):.4f}')
