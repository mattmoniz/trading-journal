import numpy as np
import vbars as V

def test_nodes():
    P = np.zeros(40); P[5:36] = 1.0; P[10:14] = [3, 6, 9, 5]                    # one fat peak in a flat profile (median 1)
    nd = V.nodes_of(P, 100); assert len(nd) == 1 and nd[0] == (110, 113), nd   # bins 10..13 above the median-1 plateau; plateau bins at the median stop the walk
    P2 = P.copy(); P2[25:29] = [4, 8, 7, 4]; nd = V.nodes_of(P2, 0); assert len(nd) == 2
    P3 = np.zeros(40); P3[5:36] = 1.0; P3[12] = 9; assert V.nodes_of(P3, 0) == []   # a single spike is narrower than 3 bins: dropped

def test_ladder():
    assert V.ladder_len([(0, 3, 5.0), (10, 13, 9.0), (20, 23, 14.0)], 1) == 3        # time increases with price
    assert V.ladder_len([(0, 3, 14.0), (10, 13, 9.0), (20, 23, 5.0)], 1) == 1        # older node is higher: no ladder
    assert V.ladder_len([(0, 3, 14.0), (10, 13, 9.0), (20, 23, 5.0)], -1) == 3       # downward: price descending, time increasing
    assert V.ladder_len([], 1) == 0

def test_clock():
    assert V.clock_hour(0.0) == 18 and V.clock_hour(55800.0) == 9 and V.clock_hour(86399.0 - 64800 + 64800 - 1) in (17, 18)

if __name__ == '__main__':
    for k, f in list(globals().items()):
        if k.startswith('test_'): f(); print('ok', k)
