import numpy as np, sys
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_exhaust'); import spike as S
def flat(n=390):
    c = np.full(n, 100.0); return dict(o=c.copy(), h=c + 0.1, l=c - 0.1, c=c.copy())
thr = np.full(390, np.nan); thr[S.M:] = 2.0
a = flat()
for i, (lo, hi) in enumerate([(100, 100.5), (100.5, 101.5), (101.5, 103), (103, 105), (105, 107)]):   # 5-bar upward thrust ending at bar 100+4
    a['l'][100 + i] = lo; a['h'][100 + i] = hi; a['c'][100 + i] = hi - 0.1
a['h'][105], a['l'][105], a['c'][105] = 103.2, 102.9, 103.0; a['h'][106], a['l'][106], a['c'][106] = 100.9, 100.2, 100.4   # comes right back: through the midpoint (about 103.5? no: 103.0 < mid) then the base
st = S.thrust(a); ev = S.detect(a, st, thr)
assert any(e['dir'] == -1 and e['t'] == 104 and e['strong'] for e in ev), ev
b = flat()
for i, (lo, hi) in enumerate([(100, 100.5), (100.5, 101.5), (101.5, 103), (103, 105), (105, 107)]): b['l'][100 + i] = lo; b['h'][100 + i] = hi; b['c'][100 + i] = hi - 0.1
b['c'][105:] = 106.5; b['h'][105:] = 106.7; b['l'][105:] = 106.3
st = S.thrust(b); assert not S.detect(b, st, thr), 'no return, no mark'
m = flat()
for i, (lo, hi) in enumerate([(99.5, 100), (98.5, 99.5), (97, 98.5), (95, 97), (93, 95)]): m['l'][100 + i] = lo; m['h'][100 + i] = hi; m['c'][100 + i] = lo + 0.1
m['h'][105], m['l'][105], m['c'][105] = 97.2, 96.9, 97.0; m['h'][106], m['l'][106], m['c'][106] = 99.9, 99.5, 99.7; st = S.thrust(m); ev = S.detect(m, st, thr)
assert any(e['dir'] == 1 and e['t'] == 104 for e in ev), ev
print('spike tests ok')
