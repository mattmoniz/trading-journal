"""Tests of checkpoints.py (synthetic days). Includes the no-lookahead property: decision features at a checkpoint do not change when later bars change; plus one mutation (a feature that peeks one bar ahead) that the test must catch.
Usage: ../../venv/bin/python test_checkpoints.py"""
import inspect, numpy as np, checkpoints as CP
rng = np.random.default_rng(3)
def day(): 
    c = 100 + np.cumsum(rng.normal(0, 1, 390)); h = c + rng.uniform(0, 1, 390); l = c - rng.uniform(0, 1, 390); return h, l, c
def tests(fn):
    t = {}; h, l, c = day(); a = fn(h, l, c, 10.0)
    t['ten checkpoints'] = all(len(v) == 10 for v in a.values())
    i = 59; t['range so far at k=60 uses bars 0..59'] = abs(a['rng_atr'][1] - (h[:60].max() - l[:60].min()) / 10.0) < 1e-12
    t['loc in [0,1]'] = bool(np.all((a['loc'] >= 0) & (a['loc'] <= 1)))
    t['y60 at k=60 = close[119]-close[59]'] = abs(a['y60'][1] - (c[119] - c[59]) / 10.0) < 1e-12
    t['yclose uses the last bar'] = abs(a['yclose'][0] - (c[-1] - c[29]) / 10.0) < 1e-12
    h2, l2, c2 = h.copy(), l.copy(), c.copy(); h2[60:] += 50; l2[60:] += 50; c2[60:] += 50; b = fn(h2, l2, c2, 10.0)
    t['no lookahead: features at k=60 unchanged when bars >= 60 change'] = abs(b['rng_atr'][1] - a['rng_atr'][1]) < 1e-12 and abs(b['loc'][1] - a['loc'][1]) < 1e-12
    hh = np.full(390, 100.0); ll = np.full(390, 99.0); cc = np.full(390, 99.5); hh[100] = 105; d = fn(hh, ll, cc, 10.0)
    t['extension flag: a later high above the running high sets extH'] = d['extH'][2] == 1.0 and d['extH'][3] == 0.0
    return t
res = tests(CP.checkpoints); bad = [k for k, v in res.items() if not v]
for k, v in res.items(): print(('ok   ' if v else 'FAIL ') + k)
src = inspect.getsource(CP.checkpoints).replace("cumH = np.maximum.accumulate(h)", "cumH = np.maximum.accumulate(np.roll(h, -1))"); ns = dict(vars(CP)); exec(src, ns); mut = tests(ns['checkpoints']); caught = [k for k, v in mut.items() if not v]
print(f'mutation (running high peeks one bar ahead): caught by {len(caught)} test(s): {caught}'); assert not bad, bad; assert caught; print('all checkpoint tests passed')
