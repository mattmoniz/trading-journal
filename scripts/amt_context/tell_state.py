"""Causal tell state at a clock time, for the roster-context study (docs/SCOPE_ROSTER_CONTEXT_EXPANSION_FORECAST_20261102.md, P0).
Reuses the research functions literally (scripts/amt_vbars/vbars.py + trade.py via amt_tell_live/core.py): nothing is re-implemented, so the tell means exactly what the live detector means.
State at time ts uses ONLY completed 500-volume bars with end <= ts. Valid only for ts >= 09:30 ET (before it the research overnight range looks ahead: core.py PREOPEN note).
No outcome label is read here (no mfe/mae/fwd), so this module needs no look-ledger entry; the study scripts that read outcomes do."""
import os, sys, datetime
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'amt_vbars')); sys.path.insert(0, os.path.join(HERE, '..', 'amt_tell_live'))
import vbars as V, trade as T, core

LOOKBACKS_MIN = (5, 15, 30, 60)
STATE_FROM = V.RTH_OPEN          # 09:30 ET in seconds since the 18:00 open


def et_to_session_sec(hhmm_or_dt):
    """'HH:MM[:SS]' or datetime -> seconds since the 18:00 ET session open, FLOORED to the minute (a setup built on 1-minute bars knows nothing newer than the last completed minute)."""
    if isinstance(hhmm_or_dt, datetime.datetime): h, m = hhmm_or_dt.hour, hhmm_or_dt.minute
    else: p = str(hhmm_or_dt).split(':'); h, m = int(p[0]), int(p[1])
    return float(((h * 3600 + m * 60) - 18 * 3600) % 86400)


def bar_flags(ctx, upto=None, leak=0):
    """Per completed bar i (end >= 09:30): c4[d] components met (0-4), tell_on[d] = the research TELL5 at bar i for direction d while price is still inside the boundary (the same gate trade.simulate applies).
    Only bars <= upto are touched. leak is ONLY for the mutation test of the parity harness (it makes the function look `leak` bars ahead); it must stay 0."""
    S = ctx['S']; n = ctx['n']; end = S['end']; comp = S['comp']; hi_i = n - 1 if upto is None else min(upto, n - 1)
    c4 = {1: np.full(n, -1), -1: np.full(n, -1)}; on = {1: np.zeros(n, bool), -1: np.zeros(n, bool)}; prof = T.Prof(ctx)
    for i in range(V.MOVE_N, hi_i + 1 + leak if leak else hi_i + 1):
        if i >= n: break
        if not comp[i] or end[i] < STATE_FROM: continue
        for d in (1, -1):
            c4[d][i] = int(ctx['fast'][i]) + int(ctx['flip'][i]) + int(ctx['osc'][i]) + int(ctx[f'strides{d}'][i])
            if not T.inside_range(ctx, i, d): continue
            _, t5 = T.ncomp_at(ctx, prof, i, d, need_nodes=False)
            on[d][i] = bool(t5)
    return c4, on


def state_at(ctx, ts_sec, leak=0):
    """Tell state at ts_sec (seconds since 18:00 ET). Returns a dict of plain floats/bools/None, or None when no complete bar exists at or after 09:30 by ts."""
    S = ctx['S']; end, comp = S['end'], S['comp']
    ok = np.where(comp & (end <= ts_sec + (leak * 60.0 if leak else 0.0)) & (end >= STATE_FROM))[0]
    if len(ok) == 0 or ts_sec < STATE_FROM: return None
    i0 = int(ok[-1]); c4, on = bar_flags(ctx, upto=i0)
    tell_any = on[1] | on[-1]; idx = np.where(tell_any[:i0 + 1])[0]
    out = dict(i0=i0, bar_end_sec=float(end[i0]), age_of_last_bar_s=float(ts_sec - end[i0]),
               tell_now=bool(tell_any[i0]), c4max_now=int(max(c4[1][i0], c4[-1][i0])),
               A_now=float(ctx['A'][i0]), minutes_since_rth_open=float((ts_sec - STATE_FROM) / 60.0))
    for N in LOOKBACKS_MIN:
        lo = ts_sec - N * 60.0; sel = idx[(end[idx] > lo)]
        out[f'tell_any_{N}m'] = bool(len(sel) > 0); out[f'tell_bars_{N}m'] = int(len(sel))
    out['minutes_since_last_tell'] = float((ts_sec - end[idx[-1]]) / 60.0) if len(idx) else None
    rt = (end <= ts_sec) & (end >= STATE_FROM) & comp
    out['rth_range_so_far_atr'] = float((S['h'][rt].max() - S['l'][rt].min()) / ctx['atr']) if rt.any() else None
    out['overnight_range_atr'] = float((ctx['onh'] - ctx['onl']) / ctx['atr'])
    return out


def sessions_and_contexts(max_date='2025-05-16'):
    """(sessions, {date: ctx}, {date: (atr20, base_hour)}) for the explore sessions with a usable 20-session baseline, built exactly like run_trade.py / core.baseline_inputs."""
    import glob
    dates = sorted(os.path.basename(p)[:10] for p in glob.glob(V.ROOT + '/*.bars.tsv')); dates = [d for d in dates if d <= max_date]
    sess, stats = {}, {}
    for d in dates:
        try: S = V.load_session(d)
        except Exception: continue
        sess[d] = S; stats[d] = V.session_stats(S)
    ks = sorted(sess); ctxs = {}; inputs = {}
    for k, d in enumerate(ks):
        if k < 20: continue
        inp = core.baseline_inputs([stats[p] for p in ks[k - 20:k]])
        if inp is None: continue
        c = T.prep(sess[d], inp[0], inp[1])
        if c is not None: ctxs[d] = c; inputs[d] = inp
    return sess, ctxs, inputs


def prefix_session(S, i0):
    """The session as it would look with only bars 0..i0 present (all marked complete): per-bar arrays cut, volume-at-price rows kept only for bars <= i0."""
    P = dict(S); n = i0 + 1
    for k in ('idx', 'start', 'end', 'o', 'h', 'l', 'c', 'vol', 'bid', 'ask', 'comp'): P[k] = S[k][:n].copy()
    m = S['vi'] <= i0
    for k in ('vi', 'vp', 'vv'): P[k] = S[k][m].copy()
    P['comp'][:] = True
    return P
