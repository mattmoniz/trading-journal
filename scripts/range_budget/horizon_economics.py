"""Horizon economics (2026-11-02): for each prediction horizon, the move size, the correlation a signal needs to cover costs, the number of independent observations the explore data holds, and the correlation that many observations can resolve. Descriptive arithmetic on the explore minute bars (no outcome-conditioned selection, no hold-out). Gross $ per trade for a signal with correlation rho to the move = rho x SD(move) x 0.8 x $2/pt (the 0.8 is the mean |z| of a normal signal, a standard approximation); cost = 1.25 points ($2.50 round trip + slip, as in every study here).
Usage: ../../venv/bin/python horizon_economics.py"""
import json, numpy as np
b = json.load(open('/home/mmoniz/trading-journal/scratch/range_budget_bars_20261102.json'))['bars']; dates = sorted(b); COST = 1.25; ndays = len(dates)
print(f'explore days {ndays}; cost {COST} points per trade')
print('horizon | SD of move (pts) | gross $/trade at corr 0.05 | break-even corr | independent obs in explore | smallest corr resolvable (2 SE) | ratio resolvable/break-even')
for h in (5, 15, 30, 60, 120, 240):
    r = []
    for d in dates:
        c = np.array(b[d]['c'])
        for k in range(30, 390 - h + 1, max(h, 15)): r.append(c[k + h - 1] - c[k - 1])
    r = np.array(r); sd = r.std(); be = COST / (0.8 * sd); nind = ndays * (360 // h if h <= 360 else 1); res = 2 / np.sqrt(nind)
    print(f'{h:4d}m | {sd:7.1f} | {0.05 * sd * 0.8 * 2:6.2f} | {be:.4f} | {nind:6d} | {res:.4f} | {res / be:5.1f}x')
dc = np.array([np.array(b[dates[i]]['c'])[-1] - np.array(b[dates[i - 1]]['c'])[-1] for i in range(1, ndays)]); sd = dc.std()
print(f'daily close-to-close | {sd:7.1f} | {0.05 * sd * 0.8 * 2:6.2f} | {COST / (0.8 * sd):.4f} | {ndays - 1:6d} | {2 / np.sqrt(ndays - 1):.4f} | {(2 / np.sqrt(ndays - 1)) / (COST / (0.8 * sd)):5.1f}x')
