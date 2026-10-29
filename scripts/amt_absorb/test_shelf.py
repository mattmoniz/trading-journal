import numpy as np, sys
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_absorb'); import shelf as SH
n = 390; r = np.random.default_rng(3)
c = 100 + np.cumsum(r.normal(0, 0.3, n)); o = np.r_[c[0], c[:-1]]; a = dict(o=o, h=np.maximum(o, c) + 0.1, l=np.minimum(o, c) - 0.1, c=c)
a['c'][100:140] = 100.0; a['o'][100:140] = 100.0; a['h'][100:140] = 100.1; a['l'][100:140] = 99.9
for i in (105, 125): a['h'][i] = 100.5                                  # two separate tests of the high band
a['l'][110] = 99.5; a['l'][130] = 99.5
R = SH.ranges(a); thr = np.full(390, np.nan); thr[SH.W - 1:] = 1.2; atr = np.full(390, 0.3)
sh = SH.shelves(a, R, thr, atr); assert any(s['t0'] <= 105 and s['tc'] >= 120 and s['tries'] >= 2 for s in sh), sh
a['c'][141] = 101.0; sh2 = SH.shelves(a, SH.ranges(a), thr, atr); b = SH.breaks(a, [s for s in sh2 if s['tc'] >= 120][0], a['o'][0]); assert b is None or b['brk'] in (1, -1)
print('shelf tests ok')
