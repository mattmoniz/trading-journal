"""Regression test for the 2026-11-09 calc_outcome bug: with the CONTINUOUS arrays the daemon passes (previous session first, current session after), the previous session's late bars made `passed` True for every RTH event and the outcome was
finalized at the latest bar. Usage: venv/bin/python scripts/vacuum_live/test_outcome_continuous.py [path/to/shadow.py]   (default: the live daemon file; it FAILS on the unpatched file and PASSES on the fixed one)"""
import sys, os, importlib.util, numpy as np
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shadow.py')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('shadow_under_test', path); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
ok = True
def chk(name, cond, got=''):
    global ok; ok &= bool(cond); print(('PASS ' if cond else 'FAIL ') + name, '' if cond else got)
prev = np.arange(0, 82800, 25.0); n0 = len(prev)                          # a full previous session: its bars at 15:55-17:00 are beyond the RTH cutoff
def arrays(cur_n):
    cur = 55800.0 + np.arange(cur_n) * 25.0; en = np.concatenate([prev, cur]); n = len(en); o = np.full(n, 100.0); h = o + 1; l = o - 1; c = o.copy(); return en, o, h, l, c, n
lim = 79200 - 300.0; a = n0 + 60
en, o, h, l, c, n = arrays(80)                                           # signal bar 60 into the session, only 80 bars exist: bar a+30 does NOT exist yet
r = S.calc_outcome(en, o, h, l, c, a, 1, 2.0, lim, n, **({'n0': n0} if 'n0' in S.calc_outcome.__code__.co_varnames else {}))
chk('1 continuous arrays, 30th bar not complete -> None (the bug returned a flat-clamped outcome)', r is None, r)
en, o, h, l, c, n = arrays(100); c[a + 30 - n0 + n0] = 100.0
r = S.calc_outcome(en, o, h, l, c, a, 1, 2.0, lim, n, **({'n0': n0} if 'n0' in S.calc_outcome.__code__.co_varnames else {}))
chk('2 continuous arrays, 30th bar complete -> a plain hold outcome', isinstance(r, dict) and r['note'] == 'hold', r)
cur_n = 300; en, o, h, l, c, n = arrays(cur_n); lim2 = en[n0 + 100] + 1.0; a2 = n0 + 90                              # hard flat after current bar 100, signal at 90: clamp at bar 100, 10 bars after
r = S.calc_outcome(en, o, h, l, c, a2, 1, 2.0, lim2, n, **({'n0': n0} if 'n0' in S.calc_outcome.__code__.co_varnames else {}))
chk('3 a real hard-flat clamp inside the current session still clamps', isinstance(r, dict) and r['note'].startswith('flat-clamped'), r)
print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
