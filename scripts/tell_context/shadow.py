"""Shadow context books (docs/TELL_WATCHER_AND_SHADOW_BOOKS_DESIGN_20261103.md section 2 + amendment A1). Hypothetical variants of each live tell fire, simulated on the same completed bars with the tell's REAL exit code
(`trade.run_position`, V1 rules) and only the stop (book B) or the direction and stop (book C) changed; book A is the tell's own stop re-simulated through the same function (the entry-price-only control, checked for parity
against the amt_tell_trades row). Pure and read-only: no orders, no database. Fills follow the tell's convention (entry at the next bar open plus one tick against, a gapped stop fills at the bar open, 2 dollars per point,
2 dollars commission). All rules are CONVENTIONS awaiting the pre-registered backtest; nothing is validated and nothing is gated."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'amt_tell_live'))
import numpy as np
import core
from core import T

K_BUFFER = 1.0               # stop buffer beyond the value edge, in units of the 20-bar median range (v1: one arm; the grid comes later)
BOOKS = ('A', 'B', 'C')
STOP_BOOKS = ('D', 'E', 'F')          # forward STOP-PLACEMENT books (docs/TELL_STOP_PLACEMENT_ARMS_PREREG_20261104.md, decision tell_stop_placement_forward_shadow_20261104): D = LVN behind the 4th left-behind node, E = the V1 rule on 4-tick coarse nodes (Sierra-style), F = beyond the running RTH extreme
STOP_BOOKS_FROM_DATE = '2026-11-05'   # forward-only boundary (prereg section 7, DeepSeek round S): no D/E/F row is ever written for a session before this trade date; if the deploying restart slips past 2026-11-04's close, move it to the first session after the restart
COARSE_BIN = 4                        # ticks per bin for book E (1 point); one stated value, not tuned (prereg section 2)


def edge_stop(d, entry, val, vah, rth_hi, rth_lo, r20, k=K_BUFFER):
    """Stop beyond the value edge on the adverse side of a trade in direction d. A short is wrong above the value area (VAH, or the day's high so far when it entered above the VAH);
    a long is wrong below it (VAL, or the day's low so far when it entered below the VAL)."""
    if d == -1: return (vah if entry <= vah else rth_hi) + k * r20
    return (val if entry >= val else rth_lo) - k * r20


def _valid(S, ei, d, stop):
    return d * (S['o'][ei] + d * T.SLIP - stop) > 0                     # the tell's own guard (trade.simulate): the stop must be on the adverse side of the fill


def _run(ctx, ei, d, stop, end_i, final):
    S = ctx['S']; n = ctx['n']; tr = T.run_position(ctx, T.Prof(ctx), ei, d, stop, 'V1', end_i)        # a fresh Prof per run: it only moves forward and a shared one would leak later bars
    is_open = (not final) and tr['reason'] == 'EOS' and tr['xj'] == n - 1
    return dict(direction=d, entry=tr['entry'], stop=float(stop), status='OPEN' if is_open else 'CLOSED', exit_reason=None if is_open else tr['reason'], pts=tr['pts'], net=tr['net'],
                broke=tr['broke'], mfe=tr['mfe'], entry_idx=int(ei), exit_idx=int(tr['xj']))


def simulate_fire(ctx, fire, final=False):
    """fire = dict(sig_idx, direction, tell_stop, label, val, vah, range20). Returns {'A':..., 'B':..., 'C':...} (each with followed_a / guard) or None while the entry bar does not exist yet."""
    S = ctx['S']; i = int(fire['sig_idx']); ei = i + 1
    if ei >= ctx['n']: return None
    d = int(fire['direction']); end_i = S['end'][i]
    a = _run(ctx, ei, d, fire['tell_stop'], end_i, final); a['followed_a'] = True; a['guard'] = None; out = {'A': a}
    rth = S['end'][:i + 1] >= core.V.RTH_OPEN
    hi = float(S['h'][:i + 1][rth].max()) if rth.any() else None; lo = float(S['l'][:i + 1][rth].min()) if rth.any() else None
    have = fire.get('label') not in (None, 'UNKNOWN') and fire.get('val') is not None and fire.get('range20') is not None and hi is not None
    entry = float(S['o'][ei]) + d * T.SLIP
    for book in ('B', 'C'):
        if not have: out[book] = dict(a, guard='no value area yet (label UNKNOWN): follows the tell'); continue
        if book == 'C' and fire['label'] != 'AGAINST': out[book] = dict(a, guard=None); continue         # C only flips AGAINST fires; every other fire follows the tell
        dd = d if book == 'B' else -d
        stop = edge_stop(dd, float(S['o'][ei]) + dd * T.SLIP, fire['val'], fire['vah'], hi, lo, fire['range20'])
        if not _valid(S, ei, dd, stop): out[book] = dict(a, guard='stop not on the adverse side of the fill: follows the tell'); continue
        r = _run(ctx, ei, dd, stop, end_i, final); r['followed_a'] = False; r['guard'] = None; out[book] = r
    return out


def node_stop(ctx, P, sig, d, k):
    """Stop price one tick beyond the lowest-volume bin behind the k-th left-behind node (nearest first, the tell's own definition), or None when fewer than k nodes were left behind. P = the profile up to the signal bar."""
    left = T.left_nodes(ctx, P, sig, d)
    if len(left) < k: return None
    r = T.stop_price(ctx, P, sig, d, k)
    return None if r is None else float(r[0])


def coarse_stop(ctx, P, sig, d, b=COARSE_BIN):
    """The tell's own rule (LVN behind the second node) on a profile aggregated into b-tick bins before the node search, so a thin bump counts the way it does on a Sierra volume profile. None when fewer than two coarse nodes were left behind."""
    lo = ctx['lo_bin']; lo4 = lo // b; idx = (np.arange(len(P)) + lo) // b - lo4
    P4 = np.zeros(int(idx.max()) + 1); np.add.at(P4, idx, P)
    cur = float(ctx['S']['c'][sig]); nds = core.V.nodes_of(P4, lo4)
    left = [(a, c) for a, c in nds if (d == 1 and (c + 1) * b * T.TICK < cur) or (d == -1 and a * b * T.TICK > cur)]
    if len(left) < 2: return None
    ns = sorted(left, key=lambda x: -x[1] if d == 1 else x[0])
    kb, _ = T.lvn_behind(P4, lo4, ns, 1, d)
    return float(kb * b * T.TICK - T.TICK if d == 1 else (kb * b + b) * T.TICK)


def extreme_stop(S, sig, d, tell_stop):
    """One tick beyond the running RTH extreme up to the signal bar (the high for a short, the low for a long), never closer than the tell's own stop (the farther of the two). None before the first RTH bar."""
    rth = S['start'][:sig + 1] >= core.V.RTH_OPEN
    if not rth.any(): return None
    if d == -1: return max(float(S['h'][:sig + 1][rth].max()) + T.TICK, float(tell_stop))
    return min(float(S['l'][:sig + 1][rth].min()) - T.TICK, float(tell_stop))


STOP_BOOK_WHY = dict(D='fewer than 4 nodes left behind: follows the tell', E='fewer than 2 coarse nodes left behind: follows the tell', F='no RTH bar yet: follows the tell')


def simulate_stop_books(ctx, fire, final=False, a=None):
    """Forward stop-placement books for one live tell fire: the SAME entry and the tell's real exit code (trade.run_position, V1), only the stop differs. fire = dict(sig_idx, direction, tell_stop). Returns {'D':..., 'E':..., 'F':...}
    (each with followed_a / guard like simulate_fire) or None while the entry bar does not exist yet. A book whose stop cannot be built, or would sit on the wrong side of the fill, follows the tell and says why. Pure and read-only: no orders."""
    S = ctx['S']; i = int(fire['sig_idx']); ei = i + 1
    if ei >= ctx['n']: return None
    d = int(fire['direction']); end_i = S['end'][i]; tell_stop = float(fire['tell_stop']); P = T.Prof(ctx).upto(i)
    if a is None: a = _run(ctx, ei, d, tell_stop, end_i, final)               # book A (the tell's own stop) is passed in by the reader so it is not simulated twice
    stops = dict(D=node_stop(ctx, P, i, d, 4), E=coarse_stop(ctx, P, i, d), F=extreme_stop(S, i, d, tell_stop)); out = {}
    for book, st in stops.items():
        if st is None: out[book] = dict(a, followed_a=True, guard=STOP_BOOK_WHY[book]); continue
        if not _valid(S, ei, d, st): out[book] = dict(a, followed_a=True, guard='stop not on the adverse side of the fill: follows the tell'); continue
        if abs(st - tell_stop) < 1e-9: out[book] = dict(a, followed_a=True, guard=None); continue                 # same stop as the tell (the extreme was closer): nothing changed
        r = _run(ctx, ei, d, st, end_i, final); r['followed_a'] = False; r['guard'] = None; out[book] = r
    return out


def parity(a, db_row):
    """Book A must reproduce the tell's own closed row (same bars, same function). Returns (ok, why); ok is None while either side is still open (nothing to compare yet)."""
    if a['status'] != 'CLOSED' or db_row.get('status') != 'CLOSED': return None, 'not compared (open)'
    if abs(a['net'] - float(db_row['net_dollars'])) > 0.011 or a['exit_reason'] != db_row.get('exit_reason'): return False, 'A net %.2f %s vs tell %.2f %s' % (a['net'], a['exit_reason'], float(db_row['net_dollars']), db_row.get('exit_reason'))
    return True, 'ok'
