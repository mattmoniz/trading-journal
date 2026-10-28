"""DESCRIPTIVE entry-window sensitivity of the live tell (user question 2026-10-28: why 10:00?). NOT a pre-registered test: the 10:00-14:30 window is the frozen research window, every number here is seen on explore data
(2023-03..2025-05-16, hold-out untouched), and a window chosen from this table would need its own frozen prereg and a sealed look. Re-simulates trade.simulate (the research function) with trade.ENTRY_FROM/ENTRY_TO changed.
Limit: prep() computes the overnight high/low over the WHOLE night, so a window starting before 09:30 would look ahead; only windows starting at 09:30 or later are valid here (Globex needs new causal code, decision amt_tell_globex_arm_untested_20261028).
Usage: ../../venv/bin/python window_sensitivity.py"""
import numpy as np
import vbars as V, trade as T, overflow_sensitivity as O, run_trade as RT

H = lambda h, m=0: float(((h - 18) % 24) * 3600 + m * 60)       # seconds since the 18:00 open for a clock time (RTH hours are 09:30+ -> 55800+)
def sec(h, m=0): return float(55800 + (h - 9) * 3600 + (m - 30) * 60)   # 09:30 = 55800
WINDOWS = [('09:30-10:00', sec(9, 30), sec(10, 0)), ('09:30-14:30', sec(9, 30), sec(14, 30)), ('10:00-14:30 (frozen research)', sec(10, 0), sec(14, 30)), ('10:30-14:30', sec(10, 30), sec(14, 30)),
           ('10:00-13:00', sec(10, 0), sec(13, 0)), ('10:00-15:30', sec(10, 0), sec(15, 30)), ('11:00-14:30', sec(11, 0), sec(14, 30))]

def main():
    rng = np.random.default_rng(20261028)
    V.ROOT = O.SPLIT; sess, stats = O.load_all(O.SPLIT); ctxs = O.contexts(sess, stats)
    print(f'usable sessions {len(ctxs)} (split reading, explore only)\n')
    for book in ('V1', 'V3'):
        print(f'=== book {book} ===')
        for name, a, b in WINDOWS:
            T.ENTRY_FROM, T.ENTRY_TO = a, b; tr = []
            for d, c in ctxs.items(): tr += [dict(t, date=d) for t in T.simulate(c, book)]
            if len(tr) < 20: print(f'  {name:32s} N={len(tr)} (too few)'); continue
            m = RT.metrics(tr); lo, hi = RT.ci(tr, rng); brk = np.mean([t['broke'] for t in tr]) * 100
            print(f"  {name:32s} N={m['n']:5d} mean {m['mean']:+7.2f}/trade CI [{lo:+7.2f},{hi:+7.2f}] WR {m['wr']:4.1f}% broke {brk:4.1f}% long {sum(t['dir'] == 1 for t in tr)} short {sum(t['dir'] == -1 for t in tr)}")
    # by signal hour within the frozen window (same trades as the baseline)
    T.ENTRY_FROM, T.ENTRY_TO = sec(10, 0), sec(14, 30)
    for book in ('V1', 'V3'):
        tr = []
        for d, c in ctxs.items():
            for t in T.simulate(c, book): t = dict(t, date=d); t['hour'] = int(((c['S']['end'][t['sig']] + 64800) % 86400) // 3600); tr.append(t)
        print(f'\n--- {book}, frozen window, by signal hour (ET) ---')
        for h in sorted({t['hour'] for t in tr}):
            g = [t for t in tr if t['hour'] == h]; lo, hi = RT.ci(g, rng) if len(g) >= 20 else (float('nan'), float('nan'))
            print(f"  {h:02d}:00-{h:02d}:59  N={len(g):4d} mean {np.mean([t['net'] for t in g]):+7.2f} CI [{lo:+7.2f},{hi:+7.2f}] WR {100 * np.mean([t['net'] > 0 for t in g]):4.1f}%")
    print('\nDescriptive only. Every window above was seen on explore data; the frozen research window is 10:00-14:30. A different window needs its own pre-registration and the single sealed hold-out look.')

if __name__ == '__main__':
    main()
