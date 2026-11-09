"""Ceiling check for tell_va_traverse.py (definition fixed before reading): for each tell edge fade (label AGREES), IGNORE the tell's stop and follow the raw price path after the entry bar to the end of RTH: does price ever reach the OPPOSITE edge of the developing value area (the fire's val/vah), how long does it take, and how far does it go AGAINST the entry first (the stop that would have been needed)? By final day shape. Descriptive, hindsight. Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_va_traverse_path.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F
RTH1 = 79200.0
def extra(S, allb, sig, t, ctxf):
    d = int(t['dir']); e = float(t['entry']); ei = int(t['ei']); v, h = ctxf.get('val'), ctxf.get('vah')
    if v is None: return dict(tgt=np.nan)
    tgt = v if d == -1 else h; end = S['end']; m = (np.arange(len(end)) >= ei) & (end <= RTH1); hi, lo = S['h'][m], S['l'][m]; ee = end[m]
    if len(hi) == 0: return dict(tgt=np.nan)
    fav = (e - lo) if d == -1 else (hi - e); adv = (hi - e) if d == -1 else (e - lo)
    hit = np.where(fav >= abs(e - tgt))[0]; half = np.where(fav >= 0.5 * abs(e - tgt))[0]
    mae_to = lambda k: float(np.max(adv[:k + 1])) if len(k_ := [k]) else np.nan
    return dict(tgt=float(tgt), dist=abs(e - tgt), ceil_mfe=float(fav.max()), reach_close=bool(len(hit)), reach_half_close=bool(len(half)), mins_to_edge=float((ee[hit[0]] - end[ei]) / 60) if len(hit) else np.nan,
                mae_before_edge=float(adv[:hit[0] + 1].max()) if len(hit) else np.nan, mae_before_half=float(adv[:half[0] + 1].max()) if len(half) else np.nan, risk_t=float(t['risk']))
R, bad = replay_rows(extra)
q = lambda x, p: float(np.quantile(x, p)); bim = np.array([F[d]['final']['bimod'] for d in F]); q90, q25 = q(bim, .9), q(bim, .25)
E = R[(R.label == 'AGREES') & R.tgt.notna()].copy(); E['sD'] = (E.bim <= q25) & (E.letter == 'D'); E['sB'] = E.bim >= q90
print(f'{len(E)} edge fades (AGREES); median distance to the opposite edge {E.dist.median():.0f} pts; the tell\'s median stop {E.risk_t.median():.1f} pts')
def row(name, g):
    if len(g) == 0: return
    r = g[g.reach_close]
    print(f'  {name:16s} N={len(g):4d}  price EVER reaches the opposite edge by the close {100*g.reach_close.mean():3.0f}%  halfway {100*g.reach_half_close.mean():3.0f}%  | of those that reach it: median {r.mins_to_edge.median() if len(r) else float("nan"):5.0f} min, adverse excursion first: median {r.mae_before_edge.median() if len(r) else float("nan"):5.1f} pts, 75th pct {r.mae_before_edge.quantile(.75) if len(r) else float("nan"):5.1f}  (tell stop median {g.risk_t.median():.1f}); share of reachers whose adverse excursion stayed within the tell stop {100*(r.mae_before_edge <= r.risk_t).mean() if len(r) else float("nan"):3.0f}%' + ('  (N<20)' if len(g) < 20 else ''))
print('\nCEILING (stop ignored) by final day shape')
row('ALL', E)
for lab, m in (('strong D', E.sD), ('letter D', E.letter == 'D'), ('letter P', E.letter == 'P'), ('letter b', E.letter == 'b'), ('multi-hump', E.final_multi == True), ('not multi-hump', E.final_multi == False), ('strong B', E.sB)): row(lab, E[m])
print('\nstrong D by fire time'); row('strong D <12:00', E[E.sD & (E.end_sec < 55800 + 9000)]); row('strong D >=12:00', E[E.sD & (E.end_sec >= 55800 + 9000)])
