"""Debug (real depth): the quantities around the trader's 2026-11-05 18:19 selling climax and the 2026-11-06 04:36 high, session file 2026-11-06 (Globex). Reads only that already-seen session."""
import sys, os
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import turn_signal_phase1 as T

for d, P, n0, F, close, adr in T.sessions_real(lo='2026-10-12', hi='2026-11-06', only={'2026-11-06'}):
    en, c = P['en'], P['c']; idx = np.arange(len(c)); zr = F['zr']; z = F['zroc']
    print(f'session {d}: n0 {n0}, current bars {len(c) - n0}, NaN zr among current bars {int(np.isnan(zr[n0:]).sum())}, first non-NaN zr at {T.hhmm(en[n0 + int(np.argmax(~np.isnan(zr[n0:])))])}')
    for lab, a, b in (('18:19 selling climax', 1000, 1700), ('04:36 buying exhaustion', 38000, 38500)):
        sel = np.where((idx >= n0) & (en >= a) & (en <= b))[0]
        print(f' --- {lab}: bars {len(sel)}; max zr {np.nanmax(zr[sel]):.2f}; max |zroc| {np.nanmax(np.abs(z[sel])):.2f}; fast bars {int(F["user_fast"][sel].sum())}')
        for k in sel[::max(1, len(sel) // 24)]:
            print(f'   {T.hhmm(en[k])} close {c[k]:8.1f} dur {F["dur"][k]:5.1f} fast {int(F["user_fast"][k])} zroc {z[k]:6.2f} zr {zr[k]:6.2f}')
