"""Hand-traced tests of bracket_limit.limit_bracket (synthetic 1-minute bars; P = 100, k = 10 -> buy limit 90, sell limit 110, stop 80/120, target 100; $2/pt, $2 round trip, 0.25 slip, 0.25 tick). Plus one mutation check.
Usage: ../../venv/bin/python test_bracket_limit.py"""
import inspect, numpy as np, bracket_limit as BL

def sess(bars, t0=60000.0):
    """bars = [(o,h,l,c)], bar 0 is the reference bar i = 0 (close P)."""
    a = np.array(bars, float); n = len(a); end = t0 + 60.0 * np.arange(1, n + 1)
    return dict(o=a[:, 0], h=a[:, 1], l=a[:, 2], c=a[:, 3], end=end, start=end - 60.0)

REF = (100, 100, 100, 100); K, W = 10.0, 1800.0
def run(fn, *bars, **kw): return fn(sess([REF, *bars]), 0, kw.get('k', K), kw.get('W', W))

def tests(fn):
    out = {}
    out['no fill inside both limits'] = run(fn, (100, 105, 95, 100), (100, 108, 92, 100))[0] is None
    out['touching the limit is NOT a fill (needs one tick through)'] = run(fn, (95, 96, 90.0, 95))[0] is None
    r = run(fn, (95, 96, 89.75, 92), (92, 100.25, 91, 100)); out['long fill then target next bar = +10 pts'] = r[0] == 10 * 2 - 2 and not r[1]
    r = run(fn, (95, 96, 89.75, 92), (92, 99.75, 91, 95), (95, 96, 79.5, 85)); out['long fill then stop: loss k + slip'] = r[0] == -(10 + 0.25) * 2 - 2
    r = run(fn, (95, 96, 89.75, 92), (92, 100.25, 79, 90)); out['stop and target in the same bar -> stop (worst case)'] = r[0] == -(10 + 0.25) * 2 - 2
    r = run(fn, (95, 111, 89, 100)); out['both limits in one bar -> ambiguous worst case, best case = target'] = r[0] == -(10 + 0.25) * 2 - 2 and r[1] and r[2] == 10 * 2 - 2
    r = run(fn, (95, 96, 78, 79)); out['stop traded in the fill bar -> stopped'] = r[0] == -(10 + 0.25) * 2 - 2
    r = run(fn, (78, 79, 70, 75)); out['gap open below the stop on the fill bar -> exit at the open, one tick adverse'] = r[0] == ((78 - 0.25) - 90) * 2 - 2
    r = run(fn, (85, 86, 70, 75)); out['open above the stop, low through it -> exit at the stop'] = r[0] == ((80 - 0.25) - 90) * 2 - 2
    b = [(95, 96, 89.75, 92)] + [(92, 95, 91, 93)] * 29 + [(92, 95, 91, 93.5)]
    r = run(fn, *b); out['time exit at close less one tick (fill bar end + 1800 s)'] = abs(r[0] - (((93.5 - 0.25) - 90) * 2 - 2)) < 1e-9
    r = run(fn, (105, 110.25, 104, 109), (109, 109.5, 99.75, 101)); out['short fill at 110 then target 100 = +10 pts'] = r[0] == 10 * 2 - 2
    r = run(fn, (105, 110.25, 104, 109), (109, 121, 108, 120)); out['short fill then stop at 120'] = r[0] == -(10 + 0.25) * 2 - 2
    out['window expired before any fill'] = run(fn, *([(100, 101, 99, 100)] * 31), (95, 96, 85, 90))[0] is None
    return out

res = tests(BL.limit_bracket); bad = [k for k, v in res.items() if not v]
for k, v in res.items(): print(('ok   ' if v else 'FAIL ') + k)
src = inspect.getsource(BL.limit_bracket).replace('Lb - TICK', 'Lb'); ns = dict(vars(BL)); exec(src, ns)
mut = tests(ns['limit_bracket']); caught = [k for k, v in mut.items() if not v]
print(f'mutation (limit fills on a mere touch): caught by {len(caught)} test(s): {caught}')
assert not bad, bad; assert caught, 'the tick-through mutation was not caught'
print('all bracket_limit tests passed')
