import numpy as np, sys
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_absorb'); import absorb as A
def synth(n=390):
    r = np.random.default_rng(1); c = 100 + np.cumsum(r.normal(0, 0.05, n)); o = np.r_[c[0], c[:-1]]
    return dict(o=o, h=np.maximum(o, c) + 0.05, l=np.minimum(o, c) - 0.05, c=c, v=np.full(n, 100.0), dl=r.normal(0, 5, n))
def thr_flat(st):  # permissive trailing thresholds for the unit test: effort threshold low, result threshold high
    t = {k: np.full(390, np.nan) for k in ('sells', 'buys', 'anet', 'dhalf')}
    for k in t: t[k][A.K:] = {'sells': 500.0, 'buys': 500.0, 'anet': 0.6, 'dhalf': 20.0}[k]  # anet is the LAST-HALF progress threshold (Amendment 2)
    return t
atr = np.full(390, 0.3)
# 1) heavy selling, price pinned flat with two defended lows, then closes up: BULLISH event
a = synth(); a['c'][:] = 100.0; a['o'][:] = 100.0; a['h'][:] = 100.2; a['l'][:] = 99.9; a['dl'][:] = -4.0; a['v'][:] = 100.0
for i in (110, 125): a['l'][i] = 99.5                       # two separated tries at the low
a['c'][131] = 100.15; a['dl'][131] = 8; a['h'][131] = 100.3 # price leaves up with positive delta
st = A.window_stats(a); ev = A.detect(a, st, thr_flat(st), atr)
assert any(e['dir'] == 1 and e['u'] == 131 and e['tries'] >= 2 for e in ev), ev
# 2) same but price drifts down hard through the window (reward for sellers): no event
b = synth(); b['c'] = 100 - np.arange(390) * 0.2; b['o'] = np.r_[b['c'][0], b['c'][:-1]]; b['h'] = b['o'] + 0.1; b['l'] = b['c'] - 0.1; b['dl'][:] = -4.0
st = A.window_stats(b); assert not [e for e in A.detect(b, st, thr_flat(st), atr) if e['dir'] == 1]
# 3) the defended low breaks before confirmation: no event
a2 = {k: v.copy() for k, v in a.items()}; a2['l'][128] = 99.0
st = A.window_stats(a2); assert not [e for e in A.detect(a2, st, thr_flat(st), atr) if e['dir'] == 1 and e['u'] == 131]
# 4) mirror: heavy buying pinned, two tries at the high, closes down: BEARISH
m = synth(); m['c'][:] = 100.0; m['o'][:] = 100.0; m['h'][:] = 100.1; m['l'][:] = 99.8; m['dl'][:] = 4.0
for i in (110, 125): m['h'][i] = 100.5
m['c'][131] = 99.85; m['dl'][131] = -8; m['l'][131] = 99.7
st = A.window_stats(m); ev = A.detect(m, st, thr_flat(st), atr); assert any(e['dir'] == -1 and e['u'] == 131 for e in ev), ev
print('absorb tests ok')
