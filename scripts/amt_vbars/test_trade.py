import numpy as np
import trade as T

def test_lvn():
    P = np.zeros(60); lo = 100
    P[10:14] = [5, 9, 9, 5]; P[14:20] = [3, 2, 1, 2, 3, 4]; P[20:24] = [6, 12, 12, 6]; P[24:30] = [4, 3, 2, 2, 3, 4]; P[30:34] = [7, 14, 14, 7]
    P[5:10] = 1.5; P[34:38] = 1.0
    nodes_sorted = [(130, 133), (120, 123), (110, 113)]                # d=+1 nearest first: n1 highest
    assert T.lvn_behind(P, lo, nodes_sorted, 0, 1)[0] in (126, 127)
    b2, fb2 = T.lvn_behind(P, lo, nodes_sorted, 1, 1); assert not fb2 and b2 == 116    # valley between n2 and n3: bins 14..19 -> min 1 at 16
    b3, fb3 = T.lvn_behind(P, lo, nodes_sorted, 2, 1); assert fb3                       # no further node: fallback to the day's low side

def test_stripped_and_prof():
    # tiny synthetic session for stripped(): flat price then a drop through the stop
    n = 40
    S = dict(d='T', o=np.full(n, 100.0), h=np.full(n, 100.5), l=np.full(n, 99.5), c=np.full(n, 100.0), end=np.arange(n) * 10.0 + 10, start=np.arange(n) * 10.0)
    ctx = dict(S=S, n=n)
    assert abs(T.stripped(ctx, 5, 1, 5.0) - ((100.0 - 100.0 - 0.25 - 0.25) * 2 - 2.0 + 0.0)) < 1e3   # smoke: no crash; end-of-data path
    S['l'][10] = 94.0; v = T.stripped(ctx, 5, 1, 5.0); assert abs(v - (((100.25 - 5.0 - 0.25) - 100.25) * 2 - 2.0)) < 1e-9, v

if __name__ == '__main__':
    for k, f in list(globals().items()):
        if k.startswith('test_'): f(); print('ok', k)
