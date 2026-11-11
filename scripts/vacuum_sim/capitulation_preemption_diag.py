"""ROW 30 REPLAY, Argon Q7 step 1 (pre-emption diagnostic; look 223). For each signalled row of capitulation_replay_phase1 (first same-direction EXTENDED thrust inside the row's life):
how far had price travelled from the row's entry (price_at_detection) toward its t1 level, and past its stop, at the CLOSE of the thrust bar? Reads price levels and bar closes only, no P&L, no resolution price.
Sealed windows untouched (asserted by the Phase 1 builders). Usage: ../../venv/bin/python capitulation_preemption_diag.py"""
import os, sys, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, context_exit_phase1 as P1
import capitulation_replay_phase1 as C
import capitulation_replay_lib as L_
ev = L_.build_events(); close = {(e['date'], e['t']): e['c'] for e in ev}
D = C.OUTD; rows = json.load(open(os.path.join(D, 'replay_phase1_rows.json'))); raw = {r['id']: r for r in json.load(open(os.path.join(D, 'rows.json')))}
lv = {r['id']: r for r in json.load(open(os.path.join(D, 'row_levels.json')))}
res = []; skipped = collections.Counter()
for r in rows:
    if not r['ext']: continue
    L = lv.get(r['id']); c = close.get(tuple(r['sig']))
    if L is None or c is None or None in (L['p0'], L['stp'], L['t1']): skipped['missing'] += 1; continue
    side = -1 if '_SHORT' in raw[r['id']]['setup_type'] else 1
    tgt = side * (L['t1'] - L['p0']); stp = side * (L['p0'] - L['stp']); mv = side * (c - L['p0'])
    if tgt <= 0 or stp <= 0: skipped['bad_geometry'] += 1; continue
    res.append(dict(id=r['id'], bc=r['bc'], corpus=r['corpus'], td=r['td'], sig=tuple(r['sig']), prog=mv / tgt, past_stop=mv <= -stp, tgt_pts=tgt, stp_pts=stp, mv=mv))
json.dump(res, open(os.path.join(D, 'preemption_rows.json'), 'w'))
lines = []
def say(s=''): print(s); lines.append(s)
say(f'signalled rows with usable geometry {len(res)}; skipped {dict(skipped)}')
say('prog = (close of the first extended thrust bar - entry) in the trade direction / (t1 - entry). >=1 means price is already at/through t1 on the thrust bar; <0 against the position.')
say(f'{"group":28s}{"N":>6s}{"indep":>6s}{"prog p25/50/75":>20s}{">=0.75":>8s}{">=1.0":>8s}{"<0":>8s}{"past stop":>10s}')
def line(name, g):
    if not g: return
    p = np.array([x['prog'] for x in g]); ind = {x['sig'] for x in g}
    say(f'{name:28s}{len(g):6d}{len(ind):6d}   {np.quantile(p,.25):5.2f}/{np.quantile(p,.5):5.2f}/{np.quantile(p,.75):5.2f}{100*np.mean(p>=.75):7.1f}%{100*np.mean(p>=1):7.1f}%{100*np.mean(p<0):7.1f}%{100*np.mean([x["past_stop"] for x in g]):9.1f}%')
line('ALL', res)
for bc in ('VALUE_FADE', 'GLOBEX_LEVEL', 'CONTINUATION_LEGACY', 'FAILED_SWEEP_REVERSAL'):
    for co in ('ALL', 'EXPLORE', 'G2026'):
        line(f'{bc[:18]} {co}', [x for x in res if x['bc'] == bc and (co == 'ALL' or x['corpus'] == co)])
# distinct-thrust version (one row per thrust, first row) for the headline cells
for bc in ('VALUE_FADE', 'GLOBEX_LEVEL'):
    seen = {}; 
    for x in res:
        if x['bc'] == bc: seen.setdefault(x['sig'], x)
    line(f'{bc[:12]} one per thrust', list(seen.values()))
say('\nthrust size vs bracket (points): median thrust-bar progress in points = median(mv); median target distance / stop distance')
for bc in ('VALUE_FADE', 'GLOBEX_LEVEL'):
    g = [x for x in res if x['bc'] == bc]
    if g: say(f'  {bc}: mv median {np.median([x["mv"] for x in g]):.1f} pt, target {np.median([x["tgt_pts"] for x in g]):.1f} pt, stop {np.median([x["stp_pts"] for x in g]):.1f} pt')
open(os.path.join(D, 'preemption_output.txt'), 'w').write('\n'.join(lines))
