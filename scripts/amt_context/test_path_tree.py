"""Hand-traced tests of path_tree (synthetic 1-minute bars; P = 100 at bar 0, k = 10: U1 110, D1 90, U2 120, D2 80). Plus one mutation (a revert counted from the touch bar itself).
Usage: ../../venv/bin/python test_path_tree.py"""
import inspect, numpy as np, path_tree as PT

def sess(bars, t0=60000.0):
    a = np.array(bars, float); n = len(a); end = t0 + 60.0 * np.arange(1, n + 1)
    return dict(o=a[:, 0], h=a[:, 1], l=a[:, 2], c=a[:, 3], end=end, start=end - 60.0)
REF = (100, 100, 100, 100); K = 10.0
def S_(*bars): return sess([REF, *bars])

def tests(pt):
    t = {}
    S = S_((100, 105, 95, 100), (100, 108, 92, 100)); t['no touch inside +-k'] = pt.touch(S, 0, K) == (None, None)
    S = S_((100, 110, 99, 109)); t['touching exactly k is a touch (market statistic, no tick rule)'] = pt.touch(S, 0, K) == (1, 1)
    S = S_((100, 101, 90, 91)); t['down touch'] = pt.touch(S, 0, K) == (-1, 1)
    S = S_((100, 111, 89, 100)); t['both sides in one bar -> AMBIG touch'] = pt.touch(S, 0, K) == ('AMBIG', 1)
    S = S_((100, 100, 99, 99), *([(99, 100, 98, 99)] * 31), (100, 112, 99, 111)); t['touch after the 30-minute window is not a touch'] = pt.touch(S, 0, K) == (None, None)
    S = S_((105, 111, 104, 110), (110, 111, 99.5, 100)); t['up touch then revert to P in a later bar'] = pt.resolve(S, 0, 1, 1, K) == 'REVERT'
    S = S_((105, 111, 104, 110), (110, 121, 109, 120)); t['up touch then extend to 120'] = pt.resolve(S, 0, 1, 1, K) == 'EXTEND'
    S = S_((105, 111, 104, 110), (110, 121, 99, 100)); t['later bar reaches both P and 120 -> AMBIG'] = pt.resolve(S, 0, 1, 1, K) == 'AMBIG'
    S = S_((105, 111, 99, 100)); t['revert inside the touch bar is NOT counted (later bars only)'] = pt.resolve(S, 0, 1, 1, K) == 'TIMEOUT'
    S = S_((105, 111, 99, 100)); t['same-bar flags see it'] = pt.same_bar_flags(S, 0, 1, 1, K) == (True, False)
    S = S_((95, 96, 89, 90), (90, 100.5, 91, 100)); t['down touch then revert to P'] = pt.resolve(S, 0, 1, -1, K) == 'REVERT'
    S = S_((95, 96, 89, 90), (90, 92, 79, 80)); t['down touch then extend to 80'] = pt.resolve(S, 0, 1, -1, K) == 'EXTEND'
    S = S_((105, 111, 104, 110), *([(110, 114, 108, 110)] * 31)); t['neither within 30 minutes -> TIMEOUT'] = pt.resolve(S, 0, 1, 1, K) == 'TIMEOUT'
    S = S_((105, 111, 104, 110), (110, 116, 108, 112), (112, 118, 110, 111), (111, 112, 99, 100)); t['run length: max beyond the touch level before the revert bar = 0.8k'] = abs(pt.run_length(S, 0, 1, 1, K) - 0.8) < 1e-9
    S = S_((105, 111, 104, 110), (110, 112, 104, 105)); t['asymmetric: target 0.5k below the touch hits first'] = pt.first_hit(S, 1, 105, 120, 1) == 'TARGET'
    return t

res = tests(PT); bad = [k for k, v in res.items() if not v]
for k, v in res.items(): print(('ok   ' if v else 'FAIL ') + k)
src = inspect.getsource(PT.resolve).replace("first_hit(S, j, P, P + side * 2 * k, side, W2)", "first_hit(S, j - 1, P, P + side * 2 * k, side, W2)"); ns = dict(vars(PT)); exec(src, ns); m = dict(vars(PT)); m['resolve'] = ns['resolve']
class M: pass
mod = M(); [setattr(mod, k, v) for k, v in m.items()]; mut = tests(mod); caught = [k for k, v in mut.items() if not v]
print(f'mutation (revert examined from the touch bar): caught by {len(caught)} test(s): {caught}')
assert not bad, bad; assert caught, 'mutation not caught'; print('all path_tree tests passed')
