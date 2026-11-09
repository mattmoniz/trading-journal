"""Part C of docs/IB_TIGHTEN_LEVELS_PREREG_20261104.md: do the PRIOR session's profile levels (volume POC / VAH / VAL, TPO POC / VAH / VAL by the TradingView TPO rules, poor highs / lows, single-print zones, prior high / low) attract price more than equal-distance random levels?
Explore. Event = a level of the prior RTH profile; reach = today's price trades through it between 09:35 and 16:00 (also by 12:00); control = every other day's reach of a level at the same distance from ITS open in units of ITS prior-20 median RTH range. Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/carried_levels.py"""
import os, sys, json, glob
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context')); import profile_shape as PS
from block_stats import bootmean
ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028'); RTH0, RTH1 = 55800.0, 79200.0; TICK = 0.25; rng = np.random.default_rng(139)
B1 = json.load(open(os.path.join(REPO, 'scratch', 'carried_levels_20261104', 'rth_1m.json'))); F = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json')))
from tpo_lib import tpo, unfinished
days = [d for d in sorted(B1) if len(B1[d]['m']) >= 380]; day = {}
for d in days:
    b = {k: np.array(v, float) for k, v in B1[d].items()}; day[d] = dict(m=b['m'], o=b['o'], h=b['h'], l=b['l'], open=float(b['o'][0]), rng=float(b['h'].max() - b['l'].min()))
p = os.path.join(ROOT); vol = {}
for d in days:
    f = f'{ROOT}/{d}.bars.tsv'
    if not os.path.exists(f): continue
    bb = np.loadtxt(f, delimiter='\t', ndmin=2); vv = np.loadtxt(f.replace('.bars.', '.vap.'), delimiter='\t', ndmin=2); ir = bb[(bb[:, 2] >= RTH0) & (bb[:, 2] < RTH1), 0].astype(int); ft = PS.features(vv[np.isin(vv[:, 0].astype(int), ir), 1], vv[np.isin(vv[:, 0].astype(int), ir), 2])
    if ft: e = ft['hi'] - ft['lo']; vol[d] = dict(poc=ft['lo'] + ft['poc_pos'] * e, vah=ft['lo'] + ft['vah'] * e, val=ft['lo'] + ft['val'] * e)
adr = {}
for i, d in enumerate(days):
    prev = [day[x]['rng'] for x in days[max(0, i - 20):i]]; adr[d] = float(np.median(prev)) if len(prev) >= 15 else None
for d in days:
    t = day[d]; k = t['m'] >= 5; t['mh'] = t['h'][k].max(); t['ml'] = t['l'][k].min(); k2 = k & (t['m'] <= 150); t['mh12'] = t['h'][k2].max(); t['ml12'] = t['l'][k2].min()
    if adr[d]: t['up'] = (t['mh'] - t['open']) / adr[d]; t['dn'] = (t['open'] - t['ml']) / adr[d]; t['up12'] = (t['mh12'] - t['open']) / adr[d]; t['dn12'] = (t['open'] - t['ml12']) / adr[d]
V = [d for d in days if adr[d]]; UP = np.array([day[d]['up'] for d in V]); DN = np.array([day[d]['dn'] for d in V]); UP12 = np.array([day[d]['up12'] for d in V]); DN12 = np.array([day[d]['dn12'] for d in V]); idx = {d: i for i, d in enumerate(V)}
def control(d, u, by12=False):
    """mean over the other days of: price reaches open + u x ADR (u > 0 up, u < 0 down)."""
    a = (UP12 if by12 else UP) if u > 0 else (DN12 if by12 else DN); r = (a >= abs(u)).astype(float); i = idx[d]; return float((r.sum() - r[i]) / (len(r) - 1))
ev = []
for i, d in enumerate(V):
    j = days.index(d)
    if j == 0: continue
    pd_ = days[j - 1]; t = day[d]; q = day[pd_]; tp = tpo(q['m'], q['o'], q['h'], q['l']); lv = {}
    if pd_ in vol: lv.update({'PD_POC': vol[pd_]['poc'], 'PD_VAH': vol[pd_]['vah'], 'PD_VAL': vol[pd_]['val']})
    lv['PD_HIGH'] = float(q['h'].max()); lv['PD_LOW'] = float(q['l'].min())
    if tp:
        rs, lo_ = tp['rs'], tp['lo']; lv['TPO_POC'] = lo_ + (tp['poc'] + 0.5) * rs; lv['TPO_VAH'] = lo_ + (tp['vah'] + 1) * rs; lv['TPO_VAL'] = lo_ + tp['val'] * rs
        ph, pl, zones = unfinished(tp)
        if ph is not None: lv['POOR_HIGH'] = ph
        if pl is not None: lv['POOR_LOW'] = pl
        if zones: lv['SINGLE_PRINT'] = min([e for z in zones for e in z], key=lambda e: abs(e - t['open']))
    for nm, L in lv.items():
        dd = L - t['open']
        if abs(dd) < 1: continue
        u = dd / adr[d]; reach = (t['up'] if dd > 0 else t['dn']) >= abs(u); reach12 = (t['up12'] if dd > 0 else t['dn12']) >= abs(u)
        ev.append(dict(d=d, lvl=nm, dist_u=abs(u), reach=float(reach), c=control(d, u), reach12=float(reach12), c12=control(d, u, True)))
E = pd.DataFrame(ev); E['diff'] = E.reach - E.c; E['diff12'] = E.reach12 - E.c12
print(f'{len(V)} usable days; {len(E)} level events; per level: ' + ', '.join(f'{k} {int(v)}' for k, v in E.lvl.value_counts().items()))
def line(name, g):
    if len(g) == 0: return f'  {name:22s} N=0'
    c = bootmean(g['diff'].values, g.d.values, rng, B=2000); c2 = bootmean(g['diff12'].values, g.d.values, rng, B=1000)
    return f'  {name:22s} N={len(g):4d} days={g.d.nunique():3d}  reach by close: level {100*g.reach.mean():3.0f}% vs controls {100*g.c.mean():3.0f}%  paired diff {g["diff"].mean():+.3f} CI [{c[0]:+.3f}, {c[1]:+.3f}]  | by 12:00: {100*g.reach12.mean():3.0f}% vs {100*g.c12.mean():3.0f}% diff {g.diff12.mean():+.3f} CI [{c2[0]:+.3f}, {c2[1]:+.3f}]' + ('  (N<20)' if len(g) < 20 else '')
print('\nCOUNTED')
print(line('T1 PD volume POC/VAH/VAL', E[E.lvl.isin(['PD_POC', 'PD_VAH', 'PD_VAL'])])); print(line('T2 poor high / low', E[E.lvl.isin(['POOR_HIGH', 'POOR_LOW'])])); print(line('T3 single-print zones', E[E.lvl == 'SINGLE_PRINT']))
print('\nBY LEVEL (uncounted)')
for k in ('PD_POC', 'PD_VAH', 'PD_VAL', 'TPO_POC', 'TPO_VAH', 'TPO_VAL', 'PD_HIGH', 'PD_LOW', 'POOR_HIGH', 'POOR_LOW', 'SINGLE_PRINT'): print(line(k, E[E.lvl == k]))
print('\nNEAR vs FAR (distance tercile of all events; uncounted): attraction by distance')
q = np.quantile(E.dist_u, [1 / 3, 2 / 3])
for lab, m in (('near', E.dist_u <= q[0]), ('middle', (E.dist_u > q[0]) & (E.dist_u <= q[1])), ('far', E.dist_u > q[1])): print(line(lab + f' (<= {q[0]:.2f}/{q[1]:.2f} ADR)', E[m]))
E.to_csv(os.path.join(REPO, 'scratch', 'carried_levels_20261104', 'events.csv'), index=False)
