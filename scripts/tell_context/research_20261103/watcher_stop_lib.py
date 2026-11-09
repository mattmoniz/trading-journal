"""Stop management shared by the watcher-stop studies (docs/WATCHER_STOP_PREREG_20261104.md, docs/IB_TIGHTEN_LEVELS_PREREG_20261104.md): `run_dyn` = trade.run_position (V1) with a stop that is ALWAYS present and may be re-set after each completed bar,
the initial-balance (IB) day-type state at a bar, and the cached watcher state series per session (hr-022: one implementation)."""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import T, REPO
import watcher as W
RTH0, RTH1 = 55800.0, 79200.0; TOL = 0.1
ADV = {1: ('DRIVE_DOWN', 'DRIVE_DOWN_BUILDING'), -1: ('DRIVE_UP', 'DRIVE_UP_BUILDING')}
_SHOWN = {}; ENDS = {}
def shown_of(S):
    """The displayed watcher state per bar of a loaded session (cached by date)."""
    d = S['d']
    if d not in _SHOWN: _SHOWN[d] = W.run(S['end'], S['h'], S['l'], S['c'])['shown']; ENDS[d] = S['end']
    return _SHOWN[d]
def ib_state_at(S, j):
    """IB day-type state known after the completed bar j: NORMAL / VARIATION / TREND / NEUTRAL, or None before the IB (first RTH hour) is complete. IB = RTH bars completed by 10:30; a side is extended beyond TOL x IBR; VARIATION <= 2 IBR, TREND beyond."""
    end, h, l = S['end'], S['h'], S['l']
    if end[j] < RTH0 + 3600: return None
    rth = (end >= RTH0) & (end <= end[j]); ib = (end >= RTH0) & (end <= RTH0 + 3600)
    if ib.sum() < 5: return None
    ibh, ibl = h[ib].max(), l[ib].min(); ibr = ibh - ibl
    if ibr <= 0: return None
    xu = max(0.0, h[rth].max() - ibh) / ibr; xd = max(0.0, ibl - l[rth].min()) / ibr; su, sd = xu > TOL, xd > TOL
    if not su and not sd: return 'NORMAL'
    if su and sd: return 'NEUTRAL'
    return 'VARIATION' if max(xu, xd) <= 2.0 else 'TREND'
CAP_PTS = 100.0                                                    # account-risk convention (user's prop account: $2k trailing loss): a WIDENED stop is never farther than 100 points ($200 per MNQ); a node stop already beyond it is kept as built
def dist(m, s, cap=CAP_PTS):
    """Stop distance for multiple m of the node distance s: tightening is m x s; widening is capped at `cap` points (but never below the node distance itself)."""
    return m * s if (m <= 1 or cap is None) else max(s, min(m * s, cap))
def run_dyn(ctx, prof, ei, d, stop_dist, entry_time, state_at=None, mult0=1.0, widen=False, tighten=False, cap=CAP_PTS, trail_k=None, scale=None, target=None, exit_at_sec=None, stop_fn=None):
    """V1 management (identical to trade.run_position) with the stop at mult0 x stop_dist from the entry, re-set by `state_at(j)` after each completed bar j (effective from bar j+1): widen=True -> BALANCE_CONFIRMED moves it to 2.0 x (once, never after a tighten);
    tighten=True -> a DRIVE against the position moves it to 0.5 x (once, permanent). Returns (trade dict, widened, tightened). With the defaults it reproduces the static stop at mult0."""
    S = ctx['S']; o, h, l, c, end, start = S['o'], S['h'], S['l'], S['c'], S['end'], S['start']; n = ctx['n']
    entry = o[ei] + d * T.SLIP; s = stop_dist; stop = entry - d * dist(mult0, s, cap); broke = False; pend = None; mfe = 0.0; widened = tightened = False; best = None                                                  # best = the best favourable extreme since entry, for the optional trailing stop (docs/TELL_HOLD_VALUE_TRAIL_PREREG_20261104.md)
    for j in range(ei, n):
        px = why = None
        if pend is not None: px, why = o[j] - d * T.SLIP, pend; pend = None
        elif start[j] >= T.FLAT_S: px, why = o[j] - d * T.SLIP, 'EOD'
        elif exit_at_sec is not None and start[j] >= exit_at_sec: px, why = o[j] - d * T.SLIP, 'EVENT'                                  # a structure event (docs/TELL_STRUCTURE_EXIT_ARMS_PREREG_20261104.md): market exit at the open of the first bar after it
        elif j > ei and d * (o[j] - stop) <= 0: px, why = o[j] - d * T.SLIP, 'STOP_GAP'
        elif (d == 1 and l[j] <= stop) or (d == -1 and h[j] >= stop): px, why = stop - d * T.SLIP, 'STOP'
        elif target is not None and ((d == 1 and h[j] >= target + T.TICK) or (d == -1 and l[j] <= target - T.TICK)): px, why = target, 'TARGET'      # limit fill at the target after a touch beyond it by a tick; the stop is checked first on a bar touching both
        if px is not None: return T._trade(ctx, ei, j, d, entry, px, why, stop, broke, mfe), widened, tightened
        mfe = max(mfe, d * ((h[j] if d == 1 else l[j]) - entry))
        bd = T.boundary(ctx, j, d)
        if not broke and ((c[j] > bd) if d == 1 else (c[j] < bd)): broke = True
        if not broke and end[j] - entry_time >= T.TIMEOUT_S: pend = 'TIMEOUT'
        elif broke:
            nc, _ = T.ncomp_at(ctx, prof, j, d, need_nodes=True)
            if nc <= 2: pend = 'FADE'
        if stop_fn is not None:                                                                                                  # a caller-supplied stop update after each completed bar (docs/TELL_LEG_PROFILE_STOP_AND_FLOOR_EXITS_PREREG_20261104.md): stop_fn(j, best, stop) returns a candidate stop or None; effective next bar, never looser
            bp = h[j] if d == 1 else l[j]; best = bp if best is None else (max(best, bp) if d == 1 else min(best, bp)); cand = stop_fn(j, best, stop)
            if cand is not None: stop = max(stop, cand) if d == 1 else min(stop, cand)
        if trail_k is not None:                                                                                                  # trailing stop: k x scale behind the best extreme through bar j, effective from bar j+1, never looser than the current stop
            bp = h[j] if d == 1 else l[j]; best = bp if best is None else (max(best, bp) if d == 1 else min(best, bp)); ts = best - d * trail_k * scale; stop = max(stop, ts) if d == 1 else min(stop, ts)
        if state_at is not None:
            st = state_at(j)
            if tighten and not tightened and st in ADV[d]: stop = entry - d * 0.5 * s; tightened = True
            elif widen and not widened and not tightened and st == 'BALANCE_CONFIRMED': stop = entry - d * dist(2.0, s, cap); widened = True
    j = n - 1; return T._trade(ctx, ei, j, d, entry, c[j], 'EOS', stop, broke, mfe), widened, tightened
