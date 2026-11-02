"""Path tree of PREREG_PATH_STRUCTURE.md on 500-volume bars. Pure market behaviour: no fills, no costs, no slippage. Reference P = close of bar i, distance k, levels U1 = P + k, D1 = P - k.
Touch: first bar after i (within W1 of bar i's end, before the 15:55 flatten bar) whose range reaches U1 or D1; a bar reaching both is AMBIG. After a touch at bar j only bars STRICTLY AFTER j are examined (within W2 of bar j's end).
first_hit(): generic first passage after the touch bar: target level vs stop level (revert/extend is target = P, stop = the next level 2k from P)."""
import os, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'amt_vbars'))
import trade as T
FLAT = T.FLAT_S

def _window(S, j0, t0, W):
    """index range [j0, jend) of bars that start before the flatten bar and end within W seconds of t0."""
    end, start = S['end'], S['start']; jend = int(np.searchsorted(end, t0 + W, side='right')); jf = int(np.searchsorted(start, FLAT, side='left'))
    return j0, max(j0, min(jend, jf, len(end)))

def touch(S, i, k, W1=1800.0):
    """(side +1/-1, touch bar j) | ('AMBIG', j) | (None, None). No touch inside the window = (None, None)."""
    a, b = _window(S, i + 1, S['end'][i], W1)
    if b <= a: return None, None
    P = S['c'][i]; hu = S['h'][a:b] >= P + k; hd = S['l'][a:b] <= P - k; any_ = hu | hd
    if not any_.any(): return None, None
    n = int(np.argmax(any_)); j = a + n
    if hu[n] and hd[n]: return 'AMBIG', j
    return (1 if hu[n] else -1), j

def first_hit(S, j, target, stop, side, W2=1800.0):
    """After a touch at bar j on `side`: first of target / stop among bars after j within W2 of bar j's end. Returns 'TARGET' | 'STOP' | 'TIMEOUT' | 'AMBIG'. For side +1 the target lies below the touch level (reversion) and the stop above it."""
    a, b = _window(S, j + 1, S['end'][j], W2)
    if b <= a: return 'TIMEOUT'
    h, l = S['h'][a:b], S['l'][a:b]
    if side == 1: tg, sp = l <= target, h >= stop
    else: tg, sp = h >= target, l <= stop
    any_ = tg | sp
    if not any_.any(): return 'TIMEOUT'
    n = int(np.argmax(any_))
    if tg[n] and sp[n]: return 'AMBIG'
    return 'TARGET' if tg[n] else 'STOP'

def resolve(S, i, j, side, k, W2=1800.0):
    """REVERT (back to P) / EXTEND (to the next level, 2k from P) / TIMEOUT / AMBIG after a touch at bar j."""
    P = S['c'][i]; up = side == 1
    r = first_hit(S, j, P, P + side * 2 * k, side, W2)
    return {'TARGET': 'REVERT', 'STOP': 'EXTEND'}.get(r, r)

def same_bar_flags(S, i, j, side, k):
    """does the touch bar's own range already reach P (a revert the later-bar rule cannot see) or the next level?"""
    P = S['c'][i]
    if side == 1: return bool(S['l'][j] <= P), bool(S['h'][j] >= P + 2 * k)
    return bool(S['h'][j] >= P), bool(S['l'][j] <= P - 2 * k)

def run_length(S, i, j, side, k, W2=1800.0):
    """maximum excursion beyond the touch level (in units of k) from the touch bar until the bar that reverts to P (exclusive) or the window end (inclusive of an extension bar); None when the revert bar is ambiguous."""
    P = S['c'][i]; a, b = _window(S, j + 1, S['end'][j], W2); h, l = S['h'], S['l']; lvl = P + side * k
    if side == 1: rv = l[a:b] <= P
    else: rv = h[a:b] >= P
    stop = b if not rv.any() else a + int(np.argmax(rv))
    hi = h[j:stop].max() if side == 1 else None; lo = l[j:stop].min() if side == -1 else None
    return float(((hi - lvl) if side == 1 else (lvl - lo)) / k)
