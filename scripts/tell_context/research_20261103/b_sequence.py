"""Descriptive (hindsight, features only): is the sequence 'a D-like balance first, then a quick move out (a drive), then a second area building' found in the watcher's state history before a given time, and how does that line up with the final multi-hump flag and the strongest B days? Usage: venv/bin/python scripts/tell_context/research_20261103/b_sequence.py"""
import os, sys, glob, json, collections
import numpy as np
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context')); import watcher as W
ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028'); J = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'shapes.json')))
CUT = json.load(open(os.path.join(REPO, 'scripts', 'tell_context', 'shape_cuts.json')))['bimod_top_tercile_cut']
CHECK = {'12:00': 55800 + 150 * 60, '13:00': 55800 + 210 * 60, '14:00': 55800 + 270 * 60}
rows = []
for p in sorted(glob.glob(ROOT + '/*.bars.tsv')):
    d = os.path.basename(p)[:10]
    if d > '2025-05-16' or d not in J: continue
    b = np.loadtxt(p, delimiter='\t', ndmin=2); end, h, l, c = b[:, 2], b[:, 4], b[:, 5], b[:, 6]
    if (end >= 55800).sum() < 100: continue
    r = W.run(end, h, l, c); shown = r['shown']; row = dict(d=d, multi=J[d]['bimod'] >= CUT, bim=J[d]['bimod'])
    for k, t in CHECK.items():
        i = int(np.searchsorted(end, t, side='right')) - 1; seq = [x for x in shown[:i + 1] if x != 'UNKNOWN']; names = []
        for x in seq:
            g = 'BAL' if x.startswith('BALANCE') else 'DRV'
            if not names or names[-1] != g: names.append(g)
        first = names[0] if names else None
        # B sequence: balance, then a drive, then balance or building again (a second area)
        bseq = any(names[j:j + 3] == ['BAL', 'DRV', 'BAL'] for j in range(len(names)))
        row['b' + k] = bseq; row['first' + k] = first
    rows.append(row)
n = len(rows); q90 = float(np.quantile([x['bim'] for x in rows], 0.9)); print(n, 'sessions; multi-hump', sum(x['multi'] for x in rows), f'({100*sum(x["multi"] for x in rows)/n:.0f}%); strong B (top decile) cut {q90:.2f}')
for k in CHECK:
    for name, sel in (('balance -> drive -> balance again (the B sequence)', lambda x: x['b' + k]), ('no such sequence', lambda x: not x['b' + k])):
        g = [x for x in rows if sel(x)]
        if g: print(f'  by {k}: {name:52s} N={len(g):3d}  ended multi-hump {100*sum(x["multi"] for x in g)/len(g):3.0f}%   strong B (top decile) {100*sum(x["bim"] >= q90 for x in g)/len(g):3.0f}%')
print('\nwhat the day started as (the first state group) vs final multi-hump, at 13:00:')
for first in ('BAL', 'DRV'):
    g = [x for x in rows if x['first13:00'] == first]
    if g: print(f'  starts as {first}: N={len(g):3d}  multi-hump {100*sum(x["multi"] for x in g)/len(g):3.0f}%  strong B {100*sum(x["bim"] >= q90 for x in g)/len(g):3.0f}%')
