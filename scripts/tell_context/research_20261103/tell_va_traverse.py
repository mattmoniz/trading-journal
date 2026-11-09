"""Do the tell's edge fades travel across the value area on balance (D) days? Descriptive, hindsight day shape, read-only. Definition fixed BEFORE reading (user, 2026-11-04: 'a D day should go from around VAL to VAH and vice versa'):
edge fades = tell trades labelled AGREES (entered at or beyond a value-area edge, trading toward value; label from context_at_fire); target distance = distance from the entry to the OPPOSITE edge of the developing value area at the fire; the trade 'reached' a fraction f of the traverse if its max favourable excursion (until its own exit) was >= f x that distance. Groups: final letter / multi-hump / strong B / strong D.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_va_traverse.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F, REPO
from block_stats import bootmean
rng = np.random.default_rng(71)
def extra(S, allb, sig, t, ctxf): return dict(val=ctxf.get('val'), vah=ctxf.get('vah'), tail=ctxf.get('tail'), mfe=float(t['mfe']), pts=float(t['pts']), reason=t['reason'], risk=float(t['risk']), entry=float(t['entry']))
R, bad = replay_rows(extra)
q = lambda x, p: float(np.quantile(x, p)); bim = np.array([F[d]['final']['bimod'] for d in F]); q90, q25 = q(bim, .9), q(bim, .25)
E = R[(R.label == 'AGREES') & R.val.notna()].copy(); E['dist'] = np.where(E.dir == -1, E.entry - E.val, E.vah - E.entry); E = E[E.dist > 0].copy(); E['width'] = E.vah - E.val
E['reach50'] = E.mfe >= 0.5 * E.dist; E['reach100'] = E.mfe >= E.dist; E['frac'] = E.mfe / E.dist; E['realfrac'] = E.pts / E.dist
E['sB'] = E.bim >= q90; E['sD'] = (E.bim <= q25) & (E.letter == 'D')
print(f'{len(R)} tell trades; {int((R.label == "AGREES").sum())} AGREES (edge fades); {len(E)} with a positive distance to the opposite edge; median distance {E.dist.median():.1f} pts, median VA width {E.width.median():.1f} pts, median risk {E.risk.median():.1f}')
def row(name, g):
    if len(g) == 0: print(f'  {name:16s} N=0'); return
    c = bootmean(g.A.values, g.date.values, rng, B=1000)
    print(f'  {name:16s} N={len(g):4d} days={g.date.nunique():3d}  MFE reached 50% of the traverse {100*g.reach50.mean():3.0f}%  reached the OPPOSITE EDGE {100*g.reach100.mean():3.0f}%  median MFE/distance {g.frac.median():.2f}  median realized/distance {g.realfrac.median():+.2f}  tell mean ${g.A.mean():+.1f} CI [{c[0]:+.0f}, {c[1]:+.0f}]  exits: ' + ', '.join(f'{k} {100*v:.0f}%' for k, v in g.reason.value_counts(normalize=True).head(3).items()) + ('  (N<20)' if len(g) < 20 else ''))
print('\nEDGE FADES (AGREES) by final day shape')
row('ALL', E)
for lab, m in (('strong D', E.sD), ('letter D', E.letter == 'D'), ('letter P', E.letter == 'P'), ('letter b', E.letter == 'b'), ('multi-hump', E.final_multi == True), ('not multi-hump', E.final_multi == False), ('strong B', E.sB)): row(lab, E[m])
print('\nSAME, split by fire time (the traverse needs time): before 12:00 / from 12:00')
for lab, m in (('strong D', E.sD), ('letter D', E.letter == 'D'), ('multi-hump', E.final_multi == True)):
    row(lab + ' <12:00', E[m & (E.end_sec < 55800 + 9000)]); row(lab + ' >=12:00', E[m & (E.end_sec >= 55800 + 9000)])
print('\nWhy not complete? For strong-D edge fades that did NOT reach the opposite edge: exit reasons, and share stopped before reaching 50%:')
g = E[E.sD & ~E.reach100]; print(f'  N={len(g)}: ' + ', '.join(f'{k} {100*v:.0f}%' for k, v in g.reason.value_counts(normalize=True).items()) + f'; stopped with MFE < 50% of the traverse: {100*((g.reason == "STOP") & (g.mfe < 0.5 * g.dist)).mean():.0f}%; risk median {g.risk.median():.1f} vs distance median {g.dist.median():.1f}')
E.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_va_traverse_rows.csv'), index=False)
