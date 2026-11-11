"""Unit test of ohlc_fill.ohlc_updates (no database). Run: venv/bin/python scripts/vacuum_live/test_ohlc_fill.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from ohlc_fill import ohlc_updates
o = np.array([1., 2, 3, 4, 5]); h = o + 0.5; l = o - 0.5; c = o + 0.25
u = ohlc_updates(7, 1, 1, o, h, l, c, 5)                                  # signal bar index n0 + k = 2, next bar 3 exists
assert len(u) == 2 and u[0][1] == (3.0, 3.5, 2.5, 7) and u[1][1] == (4.5, 3.5, 4.25, 7), u
u = ohlc_updates(8, 3, 1, o, h, l, c, 5)                                  # signal bar 4 is the last complete bar: no next bar yet
assert len(u) == 1 and u[0][1] == (5.0, 5.5, 4.5, 8), u
assert ohlc_updates(9, 4, 1, o, h, l, c, 5) == []                          # signal bar index 5 does not exist yet
assert all('IS NULL' in s for s, _ in ohlc_updates(7, 1, 1, o, h, l, c, 5))  # fill-once guards
print('ohlc_fill tests passed')
