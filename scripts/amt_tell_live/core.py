"""Live tell evaluator core. The decisions are the RESEARCH functions: scripts/amt_vbars/vbars.py + trade.py are imported literally (the CLAUDE.md rule 'export the real function, never reimplement'),
nothing is ported. This module only (1) builds the session arrays from the live bars, (2) derives the baseline inputs from the prior sessions the way run_trade.py does, (3) replays trade.simulate
on the session so far, with the still-filling bar appended as an INCOMPLETE final bar, and (4) re-derives the logged decision details at each signal bar.

Why a replay and not an incremental port: simulate() is a pure function of the bars up to the decision bar (the entry is the NEXT bar's open, so the forming bar's first tick is the entry bar), the research numbers
were produced by it, and a stateless replay is idempotent across restarts. Closed trades are final; a trade whose last bar is the forming bar is OPEN. Decisions made on the forming bar itself are
discarded by construction (a 'pending' exit set there would execute on a bar that does not exist yet, so the trade is reported as open)."""
import os, sys, hashlib, subprocess
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'amt_vbars'))
sys.path.insert(0, HERE)
import vbars as V, trade as T
from barbuilder import session_arrays

MIN_PRIOR = 15           # run_trade.py: at least 15 usable prior ranges, and per clock hour at least 15 prior sessions
PRIOR_N = 20
BOOKS = ('V1', 'V3')


def code_version():
    """git blob hashes of the research files the decisions come from, recorded on every logged row so a later change to them is visible."""
    out = {}
    for f in ('vbars.py', 'trade.py'):
        p = os.path.join(HERE, '..', 'amt_vbars', f)
        out[f] = hashlib.sha256(open(p, 'rb').read()).hexdigest()[:12]
    return out


def baseline_inputs(prior_stats):
    """prior_stats = [(rth_range, {clock_hour: mean_seconds_per_bar}), ...] for the PRIOR sessions, oldest first (the last 20 are used). Returns (atr20, base_hour) or None -- same rule as run_trade.py."""
    prior = prior_stats[-PRIOR_N:]
    if len(prior) < PRIOR_N: return None
    rngs = [r for r, _ in prior if not np.isnan(r)]
    if len(rngs) < MIN_PRIOR: return None
    base = {h: float(np.mean([hm[h] for _, hm in prior if h in hm])) for h in range(24) if sum(h in hm for _, hm in prior) >= MIN_PRIOR}
    return float(np.mean(rngs)), base


def build_ctx(bars, d, prior_stats):
    """bars = [(bar_dict, complete_flag)] for the session so far (the last may be the incomplete forming bar). Returns ctx or None (no usable baseline / thin overnight)."""
    inp = baseline_inputs(prior_stats)
    if inp is None or not bars: return None
    S = session_arrays(bars, d)
    return T.prep(S, inp[0], inp[1])


def replay(ctx, books=BOOKS, final=False):
    """{book: [trade dicts]} from trade.simulate on ctx, plus a funnel report. A trade is OPEN when its exit is the end-of-data fallback ('EOS') on the last bar -- unless final=True (the session's data has ended:
    a half session, a feed outage, the 17:00 close), when the research's own convention applies and the EOS exit at the last close is the trade's closed outcome (trade.run_position)."""
    n = ctx['n']; out = {}; rep_all = {}
    for b in books:
        rep = dict(fires=0, skip=0, trades=0, fallback=0)
        tr = T.simulate(ctx, b, rep)
        for t in tr: t['open'] = (not final) and (t['reason'] == 'EOS' and t['xj'] == n - 1)
        out[b] = tr; rep_all[b] = rep
    return out, rep_all


def decision_details(ctx, t):
    """Re-derive, at the signal bar t['sig'], the values the live log stores next to the trade: the five component values, the node ladder and the stop's LVN. Read-only, uses the research helpers."""
    S = ctx['S']; i = t['sig']; d = t['dir']; prof = T.Prof(ctx); P = prof.upto(i)
    left = T.left_nodes(ctx, P, i, d); ns = sorted(left, key=lambda x: -x[1] if d == 1 else x[0])
    lt = [(a, b, V.node_time(S, (a, b), i)) for a, b in left]
    return dict(
        A=float(ctx['A'][i]), fast=bool(ctx['fast'][i]), flip=bool(ctx['flip'][i]), osc=bool(ctx['osc'][i]), strides=bool(ctx[f'strides{d}'][i]),
        L=int(V.ladder_len(lt, d)), nodes_left=[[int(a), int(b)] for a, b in ns], n_nodes_total=len(V.nodes_of(P, ctx['lo_bin'])),
        sig_end_sec=float(S['end'][i]), sig_close=float(S['c'][i]))


def stats_of_session(bars, d):
    """(rth_range, {hour: mean_seconds_per_bar}) for a FINISHED session, from the same function the research used (vbars.session_stats)."""
    return V.session_stats(session_arrays(bars, d))
