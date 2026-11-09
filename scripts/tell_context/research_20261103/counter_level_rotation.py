"""Counter-level rotation test. Pre-registration: docs/COUNTER_LEVEL_ROTATION_PREREG_20261104.md. Explore window, raw 500-bar prices only. Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/counter_level_rotation.py"""
import os, sys, glob, json, collections
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context'))
import watcher as W
from block_stats import bootmean
ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028'); RTH0, RTH1 = 55800.0, 79200.0; F = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json')))
rng = np.random.default_rng(83); KC = 20
bim = np.array([F[d]['final']['bimod'] for d in F]); Q25 = float(np.quantile(bim, .25))
S = {}
for p in sorted(glob.glob(ROOT + '/*.bars.tsv')):
    d = os.path.basename(p)[:10]
    if d > '2025-05-16' or d not in F: continue
    b = np.loadtxt(p, delimiter='\t', ndmin=2); end = b[:, 2]
    if ((end >= RTH0) & (end < RTH1)).sum() < 100: continue
    S[d] = dict(end=end, h=b[:, 4], l=b[:, 5], c=b[:, 6], shown=W.run(end, b[:, 4], b[:, 5], b[:, 6])['shown'])
D = sorted(S); print(len(D), 'sessions')
def outcome(h, l, c, k, d, tgt, entry):
    """path from bar k+1 to the end: reach, minutes (None), adverse excursion before reaching (or over the whole path if never)."""
    hh, ll = h[k + 1:], l[k + 1:]
    if len(hh) == 0: return None
    if d == -1: reach = np.where(ll <= tgt)[0]; adv = hh - entry
    else: reach = np.where(hh >= tgt)[0]; adv = entry - ll
    j = reach[0] if len(reach) else None
    return (j is not None, j, float(adv[:(j + 1 if j is not None else len(adv))].max()))
elig = {d: np.where((S[d]['end'] >= RTH0 + 1800) & (S[d]['end'] <= RTH1 - 1800))[0] for d in D}
ev = []
for i, d in enumerate(D):
    s = S[d]; e, h, l, c = s['end'], s['h'], s['l'], s['c']; on = e <= RTH0; rth = (e >= RTH0) & (e < RTH1)
    if on.sum() < 5: continue
    levels = {'ON': (h[on].max(), l[on].min(), RTH0 + 1800)}; ib = rth & (e <= RTH0 + 3600)
    if ib.sum() >= 5: levels['IB'] = (h[ib].max(), l[ib].min(), RTH0 + 3600)
    if i > 0:
        q = S[D[i - 1]]; pr = (q['end'] >= RTH0) & (q['end'] < RTH1)
        if pr.sum() >= 100: levels['PD'] = (q['h'][pr].max(), q['l'][pr].min(), RTH0 + 1800)
    for pair, (U, L, t0) in levels.items():
        for side in (-1, 1):                                                               # -1: touch of U, target L (DOWN); +1: touch of L, target U (UP)
            ks = [k for k in elig[d] if e[k] >= t0 and ((h[k] >= U) if side == -1 else (l[k] <= L))]
            if not ks: continue
            k = ks[0]; entry = float(c[k]); tgt = L if side == -1 else U; dist = abs(entry - tgt)
            if dist <= 0: continue
            o = outcome(h, l, c, k, side, tgt, entry)
            if o is None: continue
            ctr = []
            for _ in range(KC):
                for _try in range(20):
                    jd = D[int(rng.integers(0, len(D)))]
                    if jd == d: continue
                    cs = S[jd]; cand = elig[jd][np.abs(cs['end'][elig[jd]] - e[k]) <= 1800]
                    if len(cand) == 0: continue
                    kk = int(cand[int(rng.integers(0, len(cand)))]); en = float(cs['c'][kk]); oc = outcome(cs['h'], cs['l'], cs['c'], kk, side, en + side * dist, en)
                    if oc is not None: ctr.append(oc); break
            if not ctr: continue
            st = s['shown'][k]; ev.append(dict(d=d, pair=pair, side=side, dist=dist, reach=o[0], mins=(None if o[1] is None else float((e[k + 1 + o[1]] - e[k]) / 60)), adv=o[2], c_reach=float(np.mean([x[0] for x in ctr])), c_adv=float(np.median([x[2] for x in ctr])), c_adv_reach=(float(np.median([x[2] for x in ctr if x[0]])) if any(x[0] for x in ctr) else np.nan),
                           strongD=(F[d]['final']['bimod'] <= Q25 and F[d]['final']['letter'] == 'D'), letter=F[d]['final']['letter'], bal=str(st).startswith('BALANCE')))
import pandas as pd
E = pd.DataFrame(ev); E['diff'] = E.reach.astype(float) - E.c_reach
print(f'{len(E)} events; per pair: ' + ', '.join(f'{p} {int((E.pair == p).sum())}' for p in ('ON', 'PD', 'IB')) + f'; median distance to the counter level {E.dist.median():.0f} pts')
def line(name, g):
    if len(g) == 0: return f'  {name}: N=0'
    c = bootmean(g['diff'].values, g.d.values, rng, B=2000); r = g[g.reach]
    return (f'  {name:22s} N={len(g):4d} days={g.d.nunique():3d}  events reach the counter level {100*g.reach.mean():3.0f}%  controls {100*g.c_reach.mean():3.0f}%  paired diff {g["diff"].mean():+.3f} CI [{c[0]:+.3f}, {c[1]:+.3f}]  |  adverse excursion (median, like-for-like): ALL paths events {g.adv.median():5.1f} vs controls {g.c_adv.median():5.1f}; REACHERS only events {r.adv.median() if len(r) else float("nan"):5.1f} vs control reachers {r.c_adv_reach.median() if len(r) else float("nan"):5.1f}; reachers take {r.mins.median() if len(r) else float("nan"):4.0f} min' + ('  (N<20)' if len(g) < 20 else ''))
print('\nT1-T3 by pair (both directions pooled)')
for p in ('ON', 'PD', 'IB'): print(line(p, E[E.pair == p]))
print('\nT4 ON events: strong-D days vs other days')
print(line('ON strong D', E[(E.pair == 'ON') & E.strongD])); print(line('ON other days', E[(E.pair == 'ON') & ~E.strongD]))
print('\nContext (uncounted)')
for p in ('ON', 'PD', 'IB'):
    for sd, lab in ((-1, 'DOWN (touch upper)'), (1, 'UP (touch lower)')): print(line(f'{p} {lab}', E[(E.pair == p) & (E.side == sd)]))
for p in ('ON',):
    print(line('ON balance at touch', E[(E.pair == p) & E.bal])); print(line('ON drive at touch', E[(E.pair == p) & ~E.bal]))
    for lt in 'DPb': print(line(f'ON final letter {lt}', E[(E.pair == p) & (E.letter == lt)]))
E.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'counter_level_rotation_rows.csv'), index=False)
