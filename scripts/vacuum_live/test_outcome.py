"""Unit tests of calc_outcome (the hard-flat clamp and the V0 stop) on hand-made bars with known answers."""
import sys, os, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import shadow as S
ok = True
def chk(name, cond, got=''): 
    global ok; ok &= bool(cond); print(('PASS ' if cond else 'FAIL ') + name, '' if cond else got)
n = 100; en = np.arange(n) * 10.0; o = np.full(n, 100.0); h = np.full(n, 101.0); l = np.full(n, 99.0); c = np.full(n, 100.0)
c[40] = 110.0                                           # bar a+30 for a=10
r = S.calc_outcome(en, o, h, l, c, 10, 1, 2.0, 1e9, n)
chk('1 plain 30-bar hold: fwd +10, net -2 + 10 = +8', r['fwd'] == 10.0 and r['net_nostop'] == 8.0 and r['note'] == 'hold', r)
l2 = l.copy(); l2[15] = 94.0                            # stop = 100 - 2.5*2 = 95; bar 15 low 94 -> stopped at 95 - 0.25
r = S.calc_outcome(en, o, h, l2, c, 10, 1, 2.0, 1e9, n)
chk('2 V0 stop hit: net = (94.75 - 100) - 2 = -7.25', abs(r['net_stop25'] + 7.25) < 1e-9 and r['note'].endswith('+stop'), r)
lim = en[20] + 1.0                                      # cutoff after bar 20: bars 21+ are past the hard flat
r = S.calc_outcome(en, o, h, l, c, 10, 1, 2.0, lim, n)
chk('3 hard-flat clamp: exit at bar 20, not 40; note flat-clamped', r['note'].startswith('flat-clamped') and r['fwd'] == 0.0, r)
r = S.calc_outcome(en[:30], o[:30], h[:30], l[:30], c[:30], 10, 1, 2.0, 1e9, 30)
chk('4 exit bar not yet complete -> None', r is None, r)
lim = en[10] + 1.0                                      # cutoff before the entry bar a+1 = 11
r = S.calc_outcome(en, o, h, l, c, 10, 1, 2.0, lim, n)
chk('5 cutoff passed before the entry bar -> NOENTRY', isinstance(r, tuple) and r[0] == 'NOENTRY', r)
c2 = c.copy(); c2[40] = 90.0
r = S.calc_outcome(en, o, h, l, c2, 10, -1, 2.0, 1e9, n)
chk('6 short: price 100 -> 90 is +10 gross, +8 net', r['fwd'] == 10.0 and r['net_nostop'] == 8.0, r)
print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
