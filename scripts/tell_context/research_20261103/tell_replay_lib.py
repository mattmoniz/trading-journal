"""Shared replay of the tell's explore trades (docs/TELL_TRADES_BY_DAY_SHAPE_PREREG_20261103.md): for every trade of scripts/amt_vbars/trades_V1_explore.csv rebuild the session context, the live context label at the fire and the three shadow books (the live code,
hr-022), and attach the day-shape fields. `extra(S, allb, sig, t, ctxf)` may add more per-fire columns (used by tell_poc_shift.py). Usage: from tell_replay_lib import replay_rows; R, bad = replay_rows()"""
import os, sys, json, glob
import numpy as np, pandas as pd
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
for p in ('scripts/amt_vbars', 'scripts/amt_tell_live', 'scripts/tell_context'): sys.path.insert(0, os.path.join(REPO, p))
import vbars as V, trade as T, shadow as SH
from context import context_at_fire
F = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json'))); CUT = json.load(open(os.path.join(REPO, 'scripts', 'tell_context', 'shape_cuts.json')))['bimod_top_tercile_cut']
TR = pd.read_csv(os.path.join(REPO, 'scripts', 'amt_vbars', 'trades_V1_explore.csv')); RTH0 = 55800.0; CPN = [f'{9 + (30 + 30 * k) // 60}:{(30 + 30 * k) % 60:02d}' for k in range(1, 13)]

def bars_dicts(S, upto):
    vap = {}
    for i, p, v in zip(S['vi'], S['vp'], S['vv']): vap.setdefault(int(i), {})[p * V.TICK] = (float(v), 0.0, 0.0)
    return [dict(end=float(S['end'][i]), h=float(S['h'][i]), l=float(S['l'][i]), c=float(S['c'][i]), o=float(S['o'][i]), vap=vap.get(int(S['idx'][i]), {})) for i in range(upto + 1)]
# ---- stats context for every session (as run_trade.py) and the three books per fire
HOLD_ROOT = os.path.join(REPO, 'scratch', 'volbars500_holdout_20261103'); EXPL_ROOT = V.ROOT


def _load(root, dates):
    V.ROOT = root; out, st = {}, {}
    try:
        for d in dates:
            try: out[d] = V.load_session(d); st[d] = V.session_stats(out[d])
            except Exception as e: print(f'  [tell_replay_lib] session {d} could not be loaded: {type(e).__name__}', flush=True)
    finally: V.ROOT = EXPL_ROOT
    return out, st


def replay_rows(extra=None, window='explore', only=None):
    """window 'explore' = the trades of the 2026-10-28 file; 'explore_sim' = the same simulation re-run here (regression check that this path reproduces the file); 'sealed' = the hold-out sessions after 2025-05-16 (bars built for it; prior-20 statistics of the first sessions come from the end of the explore window)."""
    names = lambda root: sorted(os.path.basename(p)[:10] for p in glob.glob(root + '/*.bars.tsv'))
    ke = [d for d in names(EXPL_ROOT) if d <= '2025-05-16']
    if window == 'sealed': sess, stats = _load(EXPL_ROOT, ke[-25:]); s2, t2 = _load(HOLD_ROOT, [d for d in names(HOLD_ROOT) if d > '2025-05-16']); sess.update(s2); stats.update(t2)
    else: sess, stats = _load(EXPL_ROOT, ke)
    ks = sorted(sess); rows = []; bad = 0; rep = dict(fires=0, skip=0, trades=0, fallback=0)
    todo = sorted(set(TR['date'])) if window == 'explore' else [d for d in ks if (d > '2025-05-16') == (window == 'sealed')]
    if only is not None: todo = [d for d in todo if d in only]                      # optional subset of dates (the priors still come from every session)
    for d in todo:
        i = ks.index(d)
        if i < 20: continue
        prior = ks[i - 20:i]; rngs = [stats[p][0] for p in prior if not np.isnan(stats[p][0])]
        if len(rngs) < 15: continue
        base = {h: float(np.mean([stats[p][1][h] for p in prior if h in stats[p][1]])) for h in range(24) if sum(h in stats[p][1] for p in prior) >= 15}
        ctx = T.prep(sess[d], float(np.mean(rngs)), base); S = sess[d]
        if ctx is None or (window == 'explore' and d not in F): continue
        trs = TR[TR['date'] == d] if window == 'explore' else pd.DataFrame(T.simulate(ctx, 'V1', rep))
        allb = bars_dicts(S, len(S['end']) - 1); S['_ctx'] = ctx                       # lets an `extra` hook re-run the position logic for this session
        for _, t in trs.iterrows():
            sig = int(t['sig']); ctxf = context_at_fire(allb[:sig + 1], float(t['entry']), int(t['dir']))
            fire = dict(sig_idx=sig, direction=int(t['dir']), tell_stop=float(t['stop']), label=ctxf.get('label'), val=ctxf.get('val'), vah=ctxf.get('vah'), range20=ctxf.get('range20'))
            out = SH.simulate_fire(ctx, fire, final=True)
            if out is None: bad += 1; continue
            sec = float(S['end'][sig]); k = int((sec - RTH0) // 1800); cp = CPN[k - 1] if 1 <= k <= 12 else None; fd = F.get(d); dv = fd['dev'].get(cp) if (fd and cp) else None
            rows.append(dict(date=d, label=ctxf.get('label'), csv_net=float(t['net']), A=out['A']['net'], B=out['B']['net'], C=out['C']['net'], final_multi=(fd['final']['bimod'] >= CUT) if fd else np.nan, bim=fd['final']['bimod'] if fd else np.nan,
                             letter=fd['final']['letter'] if fd else None, seen_multi=bool(dv and dv['bimod'] >= CUT), cp=cp, sig=sig, dir=int(t['dir']), ei=int(t['ei']), end_sec=sec, poc_now=ctxf.get('poc'),
                             **(extra(S, allb, sig, t, ctxf) if extra else {})))
    return pd.DataFrame(rows), bad
