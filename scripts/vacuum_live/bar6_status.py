"""Bar-6 checkpoint of the liquidity pull (formerly 'vacuum') trade: the single shared implementation (research scripts/vacuum_sim/vacuum_bar6_exit.py and the live detector scripts/vacuum_live/shadow.py both import it, cv-077).
Rule = computeBar6Checkpoint (server/services/maeMfeReplay.js) on 500-volume bars, bar 0 = the entry bar: the worst adverse bar index over bars 0..6 is <= 2 -> RECOVERING, >= 3 -> DETERIORATING; 'NA' when the trade was stopped on or before bar 6 or the hard flat came first.
Arms (points per trade, net of the 2.0 cost): A = the live exit (stop 2.5 x EMA10 TR, 30-bar hold), B = exit at the bar-6 close if DETERIORATING, C = stop moved to the bar-6 close if DETERIORATING. Docs: docs/VACUUM_BAR6_EXIT_PREREG_20261110.md. Pure numpy; no I/O."""
import numpy as np
COST, HOLD = 2.0, 30

def hold_net(o, h, l, c, ei, last, g, sd, cost=COST):
    """Net points of the live exit: initial stop sd behind Open[ei] (fill at the stop, or the open if gapped, one tick worse), else the close of bar `last`."""
    entry = float(o[ei]); stop = entry - g * sd
    for t in range(ei, last + 1):
        if (g == 1 and l[t] <= stop) or (g == -1 and h[t] >= stop):
            px = (stop if t == ei else (min(stop, float(o[t])) if g == 1 else max(stop, float(o[t])))) - g * 0.25; return g * (px - entry) - cost
    return g * (float(c[last]) - entry) - cost

def last_bar(en, a, lim, n_bars, n0=0, hold=HOLD):
    """Index of the last bar of the hold for a signal at bar a (same clamping as shadow.calc_outcome), or None while it does not exist yet / no entry."""
    cur = en[n0:n_bars]; inside = n0 + np.where(cur <= lim)[0]; passed = bool(np.any(cur > lim)); flat = int(inside.max()) if len(inside) else -1; target = a + hold
    if target < n_bars and en[target] <= lim: return target
    if passed: return None if flat < a + 1 else min(target, flat)
    return None

def bar6(o, h, l, c, ei, last, g, sd, cost=COST):
    """dict(status, close6, a, b, cc): status in {'NA', 'RECOVERING', 'DETERIORATING'}; close6 = close of bar 6 (None for NA); a / b / cc = net points of arms A / B / C."""
    a = hold_net(o, h, l, c, ei, last, g, sd, cost); t6 = ei + 6
    if last < t6: return dict(status='NA', close6=None, a=a, b=a, cc=a)
    entry = float(o[ei]); stop = entry - g * sd
    for t in range(ei, t6 + 1):                                  # stopped on or before bar 6: the checkpoint never happens
        if (g == 1 and l[t] <= stop) or (g == -1 and h[t] >= stop): return dict(status='NA', close6=None, a=a, b=a, cc=a)
    worst = [(entry - float(l[t])) if g == 1 else (float(h[t]) - entry) for t in range(ei, t6 + 1)]; widx = int(np.argmax(worst))      # first bar holding the largest adverse excursion
    st = 'RECOVERING' if widx <= 2 else 'DETERIORATING'
    if st == 'RECOVERING': return dict(status=st, close6=float(c[t6]), a=a, b=a, cc=a)
    b = g * (float(c[t6]) - entry) - cost
    nstop = max(stop, float(c[t6])) if g == 1 else min(stop, float(c[t6])); cc = None
    for t in range(t6 + 1, last + 1):
        if (g == 1 and l[t] <= nstop) or (g == -1 and h[t] >= nstop):
            px = (min(nstop, float(o[t])) if g == 1 else max(nstop, float(o[t]))) - g * 0.25; cc = g * (px - entry) - cost; break
    if cc is None: cc = g * (float(c[last]) - entry) - cost
    return dict(status=st, close6=float(c[t6]), a=a, b=b, cc=cc)
