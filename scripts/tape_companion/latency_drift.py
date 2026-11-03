"""Descriptive: how far does price drift over a delay of D seconds (signal -> order), from the per-second tape of the same 108 sampled explore sessions. No outcomes. Usage: python latency_drift.py"""
import sys; sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/tape_companion')
import numpy as np, lib, os
V = '/home/mmoniz/trading-journal/scratch/volbars500_full_20261028'
dates = sorted(f[:10] for f in os.listdir(V) if f.endswith('.bars.tsv') and f[:10] <= '2025-05-16')[::5]
DEL = (1, 5, 15, 30, 60); out = {s: {d: [] for d in DEL} for s in ('RTH', 'GLOBEX')}
for d in dates:
    for sess in (lib.RTH, lib.GLOBEX):
        try: A = lib.load_day(d, sess)
        except Exception: continue
        p = A['last']; lo, hi = sess.first_ok, sess.last_ok
        for D in DEL: out[sess.name][D].append(np.abs(p[lo + D:hi] - p[lo:hi - D])[::10])
print('absolute price drift over the delay, in POINTS (MNQ: 1 point = 2 dollars); an order delayed by D seconds can be filled that far from the price at the signal, in either direction')
print(f"{'':8}{'delay':>6}{'mean':>8}{'p50':>8}{'p90':>8}{'p95':>8}{'p99':>8}{'mean $':>9}")
for s in out:
    for D in DEL:
        x = np.concatenate(out[s][D]); print(f"{s:8}{D:>5}s{x.mean():>8.2f}{np.percentile(x,50):>8.2f}{np.percentile(x,90):>8.2f}{np.percentile(x,95):>8.2f}{np.percentile(x,99):>8.2f}{x.mean()*2:>9.2f}")
