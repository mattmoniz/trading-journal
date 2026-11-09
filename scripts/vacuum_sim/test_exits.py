"""Unit tests of trade_exit / fade_exit on hand-made paths with known answers (run before any outcome is read)."""
import sys, os, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import depth_tell2 as D
def mk(o, h, l, c, roc=None, zq=None, ratio=None, etr=2.0):
    n = len(c); roc = np.full(n, 10.0) if roc is None else np.array(roc, float); zq = np.full(n, 2.5) if zq is None else np.array(zq, float); ratio = np.full(n, 1.0) if ratio is None else np.array(ratio, float)
    P = dict(o=np.array(o, float), h=np.array(h, float), l=np.array(l, float), c=np.array(c, float)); F = dict(etr=np.full(n, etr), roc=roc, zroc=zq, ratio=ratio); return P, F, np.array(c, float)
ok = True
def check(name, got, want):
    global ok; good = (got == want) if not isinstance(want, tuple) else (got is not None and got[0] == want[0] and abs(got[1] - want[1]) < 1e-9 and got[2] == want[2]); ok &= bool(good); print(('PASS ' if good else 'FAIL ') + name, '' if good else f'got {got} want {want}')
base = [100.0] * 8
# 1. long, signal bar 0, entry bar 1 at open 100, stop = 100 - 2.5*2 = 95; ROC10 falls <= 0 on bar 4 -> exit 'zero' at close 101
P, F, e20 = mk(o=[100] * 8, h=[101] * 8, l=[99] * 8, c=[100, 100, 100, 100, 101, 100, 100, 100], roc=[10, 10, 10, 10, 0, 10, 10, 10]); e20[:] = 100.0
check('1 zero-cross exit', D.trade_exit(P, F, 0, 1, 1, 7, e20, 95.0, 0.1), (4, 101.0, 'zero'))
# 2. stop hit on a later bar, opens above the stop -> fill exactly at the stop 95
P, F, e20 = mk(o=[100, 100, 100, 99, 99, 99, 99, 99], h=[101, 101, 101, 100, 100, 100, 100, 100], l=[99, 99, 99, 94, 98, 98, 98, 98], c=[100, 100, 100, 96, 98, 98, 98, 98]); e20[:] = 100.0
check('2 stop fill at stop', D.trade_exit(P, F, 0, 1, 1, 7, e20, 95.0, 0.1), (3, 94.75, 'stop'))
# 3. gap down: bar 3 opens at 93 below the stop 95 -> fill at the open 93 (never better than market)
P, F, e20 = mk(o=[100, 100, 100, 93, 93, 93, 93, 93], h=[101, 101, 101, 94, 94, 94, 94, 94], l=[99, 99, 99, 92, 92, 92, 92, 92], c=[100, 100, 100, 93, 93, 93, 93, 93]); e20[:] = 100.0
check('3 gap fills at open', D.trade_exit(P, F, 0, 1, 1, 7, e20, 95.0, 0.1), (3, 92.75, 'stop'))
# 4. stop hit INSIDE the entry bar -> fill at the stop
P, F, e20 = mk(o=[100, 100, 100, 100], h=[101, 101, 101, 101], l=[99, 94, 99, 99], c=[100, 96, 100, 100]); e20[:] = 100.0
check('4 entry-bar stop', D.trade_exit(P, F, 0, 1, 1, 3, e20, 95.0, 0.1), (1, 94.75, 'stop'))
# 5. short mirror: entry open 100, stop = 105, bar 2 high 106, opens below -> fill at 105
P, F, e20 = mk(o=[100, 100, 100, 100], h=[101, 101, 106, 101], l=[99, 99, 99, 99], c=[100, 100, 104, 100], roc=[-10, -10, -10, -10], zq=[-2.5] * 4); e20[:] = 100.0
check('5 short stop', D.trade_exit(P, F, 0, 1, -1, 3, e20, 105.0, 0.1), (2, 105.25, 'stop'))
# 6. hook: ratio peaks then falls 0.3 (> 0.25 x sd 1.0) while trend-side Z_ROC <= 1.8 -> exit 'hook' at close
P, F, e20 = mk(o=[100] * 6, h=[101] * 6, l=[99] * 6, c=[100, 100, 100, 100, 100, 100], zq=[2.5, 2.5, 2.5, 1.7, 1.7, 1.7], ratio=[1.0, 1.4, 1.5, 1.2, 1.2, 1.2]); e20[:] = 100.0
check('6 hook fires', D.trade_exit(P, F, 0, 1, 1, 5, e20, 95.0, 1.0), (3, 100.0, 'hook'))
# 7. unsigned-Ratio trap: price reverses sharply but the Ratio keeps rising -> NO hook; only the stop/structure can exit (here the stop)
P, F, e20 = mk(o=[100, 100, 100, 99, 97, 95, 94, 94], h=[101, 101, 100, 99, 98, 96, 95, 95], l=[99, 99, 98, 96, 94, 93, 93, 93], c=[100, 100, 99, 97, 95, 94, 94, 94], zq=[2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5], ratio=[1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7], roc=[10] * 8); e20[:] = 100.0
r = D.trade_exit(P, F, 0, 1, 1, 7, e20, 95.0, 1.0); check('7 reversal exits by stop / structure / retrace, never by the hook', r is not None and r[2] in ('stop', 'structure', 'retrace'), True); print('   (exit reason on this path:', r[2], 'at bar', r[0], ')')
# 8. fade: push long (dr=1) to extreme 110; confirmation bar b=2; entry short at open[3]=108; stop = 110 + 0.5*2 = 111; ROC<=0 on bar 6 -> exit at close 104
P, F, e20 = mk(o=[100, 105, 109, 108, 107, 106, 105, 105], h=[101, 110, 110, 109, 108, 107, 106, 106], l=[99, 104, 107, 107, 105, 104, 103, 103], c=[100, 109, 108, 107, 106, 105, 104, 104], roc=[10, 10, 10, 8, 6, 4, 0, -5])
check('8 fade zero-cross exit', D.fade_exit(P, F, 1, 2, 1, 7, 110.0), (6, 104.0, -1, 108.0)[:2] + (-1,) if False else None) if False else None
got = D.fade_exit(P, F, 1, 2, 1, 7, 110.0); good = got is not None and got[0] == 6 and abs(got[1] - 104.0) < 1e-9 and got[2] == -1 and abs(got[3] - 108.0) < 1e-9; ok &= bool(good); print(('PASS ' if good else 'FAIL ') + '8 fade zero-cross exit', got)
# 9. fade stop: bar 4 high 112 >= stop 111 -> fill at the stop 111 (opens at 107 below it)
P, F, e20 = mk(o=[100, 105, 109, 108, 107, 106], h=[101, 110, 110, 109, 112, 107], l=[99, 104, 107, 107, 105, 104], c=[100, 109, 108, 107, 108, 106], roc=[10] * 6)
got = D.fade_exit(P, F, 1, 2, 1, 5, 110.0); good = got is not None and got[0] == 4 and abs(got[1] - 111.25) < 1e-9; ok &= bool(good); print(('PASS ' if good else 'FAIL ') + '9 fade stop fill', got)
# 10. fade entry already beyond the stop -> no trade
P, F, e20 = mk(o=[100, 105, 109, 112, 107], h=[101, 110, 110, 113, 108], l=[99, 104, 107, 111, 105], c=[100, 109, 108, 112, 106], roc=[10] * 5)
got = D.fade_exit(P, F, 1, 2, 1, 4, 110.0); good = got is not None and got[0] == 3 and abs(got[1] - 112.25) < 1e-9 and abs(got[3] - 112.0) < 1e-9; ok &= bool(good); print(('PASS ' if good else 'FAIL ') + '10 gap beyond the stop at the entry open = immediate stop-out at that open (+1 tick), not skipped', got)
print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
