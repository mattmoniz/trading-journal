"""Descriptive (hindsight, features only): the watcher's displayed state at fixed clock times versus the session's FINAL RTH shape letter. Letter = value-area midpoint thirds (D/P/b); MULTI = bimodality in the top third.
Inputs: scratch/tell_context_20261103/shapes.json (final RTH profile features per explore session, from shapes.py) and the explore bar files. Usage: venv/bin/python scripts/tell_context/research_20261103/watcher_vs_final_shape.py"""
import os, sys, glob, json, collections
import numpy as np
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context')); import watcher as W
ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028'); J = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'shapes.json')))
CUT = json.load(open(os.path.join(REPO, 'scripts', 'tell_context', 'shape_cuts.json')))['bimod_top_tercile_cut']
CHECK = {'11:00': 55800 + 90 * 60, '12:00': 55800 + 150 * 60, '13:00': 55800 + 210 * 60}
def letter(f):
    m = (f['val'] + f['vah']) / 2; return 'b' if m < 1 / 3 else ('P' if m > 2 / 3 else 'D')
rows = []
for p in sorted(glob.glob(ROOT + '/*.bars.tsv')):
    d = os.path.basename(p)[:10]
    if d > '2025-05-16' or d not in J: continue
    b = np.loadtxt(p, delimiter='\t', ndmin=2); end, h, l, c = b[:, 2], b[:, 4], b[:, 5], b[:, 6]
    if (end >= 55800).sum() < 100: continue
    r = W.run(end, h, l, c); st = {}; out = {}
    for k, t in CHECK.items():
        i = int(np.searchsorted(end, t, side='right')) - 1; st[k] = r['shown'][i] if i >= 0 else 'UNKNOWN'
        e = r['evidence'][i] if i >= 0 else {}; out[k] = (e.get('up_fights'), e.get('down_fights'))
    f = J[d]; rows.append(dict(d=d, letter=letter(f), multi=f['bimod'] >= CUT, n_changes=r['n_changes'], **{'s' + k: v for k, v in st.items()}, **{'f' + k: v for k, v in out.items()}))
n = len(rows); print(n, 'sessions; final letters', dict(collections.Counter(x['letter'] for x in rows)), '| multi-hump', sum(x['multi'] for x in rows))
base = collections.Counter(x['letter'] for x in rows)
for k in CHECK:
    print(f'\n== state at {k} ET -> final letter (row shares) ==')
    tab = collections.defaultdict(collections.Counter)
    for x in rows: tab[x['s' + k]][x['letter']] += 1
    for stt in ('DRIVE_UP', 'DRIVE_UP_BUILDING', 'DRIVE_DOWN', 'DRIVE_DOWN_BUILDING', 'BALANCE_CONFIRMED', 'BALANCE_FORMING', 'UNKNOWN'):
        c = tab.get(stt, collections.Counter()); t = sum(c.values())
        if t: print(f'  {stt:18s} N={t:3d}  D {100*c["D"]/t:3.0f}%  P {100*c["P"]/t:3.0f}%  b {100*c["b"]/t:3.0f}%   (base D {100*base["D"]/n:.0f}% P {100*base["P"]/n:.0f}% b {100*base["b"]/n:.0f}%)')
    mu = collections.defaultdict(lambda: [0, 0])
    for x in rows: mu[x['s' + k]][0] += x['multi']; mu[x['s' + k]][1] += 1
    print('  multi-hump share by state:', {s: f'{100*a/b:.0f}% of {b}' for s, (a, b) in mu.items() if b >= 10}, '| overall', f'{100*sum(x["multi"] for x in rows)/n:.0f}%')
print('\nstate changes per session: median', np.median([x['n_changes'] for x in rows]), 'p90', np.quantile([x['n_changes'] for x in rows], 0.9))

