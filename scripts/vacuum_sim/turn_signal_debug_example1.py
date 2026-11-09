"""Debug of the recall check: why does the frozen turn-signal definition not flag the trader's 2026-11-05 18:19 selling-climax example (session file 2026-11-06, Globex, 19 minutes after the reopen)?
Prints, for the bars around that time (seconds since 18:00 ET), the quantities each condition uses. Proxy Ratio (the live-era files have no depth). Reads only the already-seen example session."""
import sys, os, glob
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2
import turn_signal_phase1 as T

srcs = {}
for pat in ('scratch/volbars500_holdout_20261103/*.bars.tsv', 'scratch/amt_tell_live/*.split.bars.tsv', 'scratch/argon_vacuum_live/priors/*.bars.tsv'):
    for p in glob.glob(os.path.join(Fm.ROOT, pat)): srcs.setdefault(os.path.basename(p)[:10], p)
files = [srcs[d] for d in sorted(srcs) if d >= '2026-08-01']
for d, P, n0, F, close, adr in T.sessions_proxy(files, only={'2026-11-06'}, upto='2026-11-06'):
    en, c = P['en'], P['c']; idx = np.arange(len(c))
    print(f'session {d}: n0 {n0}, bars {len(c)}, first current en {en[n0]:.0f}s, ADR20 {adr}')
    sel = np.where((idx >= n0) & (en >= 900) & (en <= 1700))[0]
    print('  clock     en   close    dur  fast  zroc    zr   roc   pace')
    for k in sel[::max(1, len(sel) // 60)]:
        print(f'  {T.hhmm(en[k])} {en[k]:6.0f} {c[k]:8.1f} {F["dur"][k]:5.1f}  {int(F["user_fast"][k])}   {F["zroc"][k]:6.2f} {F["zr"][k]:6.2f} {F["roc"][k]:6.0f} {F["pace"][k]:5.2f}')
    zs = F['zroc'][sel]; zr = F['zr'][sel]
    print(f'  in this window: max |zroc| {np.nanmax(np.abs(zs)):.2f}, max zr {np.nanmax(zr):.2f}, fast bars {int(F["user_fast"][sel].sum())} of {len(sel)}')
