"""Row 44 amendment A3 (docs/CAPITULATION_SPEED_EXIT_PREREG_20261110.md): the sealed 2025-05-17..2026-06-14 look at the reversed RTH speed lead. Reuses capitulation_speed_depthera.one_pass with the window swapped.
Stages: count (outcome-blind) | regress (window = the spent depth era; must reproduce A2: 64 climaxes, 23 extreme-fast, D = -0.03) | run (sealed window; only through log_look_speed_sealed.mjs after the count gate)."""
import os, sys, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_speed_depthera as D
G = D.G
SEALED = ('2025-05-17', '2026-06-14'); SPENT = ('2026-06-15', '2026-10-09')
def setwin(w, out):
    D.DEPTH_FROM, D.DEPTH_TO = w; D.OUT = out; os.makedirs(out, exist_ok=True)
def halves(rows):
    r = [x for x in rows if x['track'] == 'RTH' and x['f0'] is not None]; ds = sorted({x['date'] for x in r}); mid = ds[len(ds) // 2]
    for nm, sel in (('first half', [x for x in r if x['date'] < mid]), ('second half', [x for x in r if x['date'] >= mid])):
        fa = [x['f0'] for x in sel if x['fast']]; nf = [x['f0'] for x in sel if not x['fast']]
        if fa and nf: print(f'  chronological check {nm}: extreme-fast {np.mean(fa):+.2f} (N {len(fa)}) | not fast {np.mean(nf):+.2f} (N {len(nf)}) | D {np.mean(fa) - np.mean(nf):+.2f}')
if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'count': setwin(SEALED, os.path.join(G.ROOT, 'scratch', 'capitulation_speed_sealed_20261110')); D.count()
    elif st == 'regress': setwin(SPENT, os.path.join(G.ROOT, 'scratch', 'capitulation_speed_sealed_20261110', 'regress')); D.run(); halves(json.load(open(os.path.join(D.OUT, 'depthera_rows.json'))))
    elif st == 'run': setwin(SEALED, os.path.join(G.ROOT, 'scratch', 'capitulation_speed_sealed_20261110')); D.run(); halves(json.load(open(os.path.join(D.OUT, 'depthera_rows.json'))))
    else: print(__doc__)
