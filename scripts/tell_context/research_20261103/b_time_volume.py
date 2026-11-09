"""Descriptive (hindsight, features only): does adding TIME at price (a TPO built from the 500-bar highs/lows in 30-minute brackets) to VOLUME at price find a second area (a B) earlier than volume alone?
Developing score at 11:00 / 12:00 / 13:00 ET from the bars up to that time; compared (AUC, Mann-Whitney) with the final multi-hump flag (bimodality in the top third) and the strongest B days (top decile).
Usage: venv/bin/python scripts/tell_context/research_20261103/b_time_volume.py   (streams one session at a time; use ulimit -v 4000000)"""
import os, sys, glob, json
import numpy as np
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028'); J = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'shapes.json')))
CUT = json.load(open(os.path.join(REPO, 'scripts', 'tell_context', 'shape_cuts.json')))['bimod_top_tercile_cut']
CHECK = {'11:00': 55800 + 90 * 60, '12:00': 55800 + 150 * 60, '13:00': 55800 + 210 * 60}
BRACKET = 1800.0; MIN_SEP = 4

def score(prof):
    """B score of a 1-D activity profile (smoothed): (1 - trough / smaller peak) x (smaller / larger) of the two highest peaks at least MIN_SEP rows apart."""
    sm = prof.astype(float).copy()
    for j in range(1, len(sm) - 1): sm[j] = prof[j - 1:j + 2].mean()
    pk = sorted([j for j in range(1, len(sm) - 1) if sm[j] >= sm[j - 1] and sm[j] > sm[j + 1]], key=lambda j: -sm[j]); sel = []
    for j in pk:
        if all(abs(j - k) >= MIN_SEP for k in sel): sel.append(j)
        if len(sel) == 2: break
    if len(sel) < 2: return 0.0
    a, b = sorted(sel); small, big = min(sm[a], sm[b]), max(sm[a], sm[b]); return float(max(0.0, 1 - sm[a:b + 1].min() / small) * small / big)

def auc(pos, neg):
    if not len(pos) or not len(neg): return float('nan')
    x = np.concatenate([pos, neg]); r = np.argsort(np.argsort(x)) + 1.0; r = np.array([r[x == v].mean() for v in x]); return float((r[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))

rows = []
for p in sorted(glob.glob(ROOT + '/*.bars.tsv')):
    d = os.path.basename(p)[:10]
    if d > '2025-05-16' or d not in J: continue
    b = np.loadtxt(p, delimiter='\t', ndmin=2); v = np.loadtxt(p.replace('.bars.', '.vap.'), delimiter='\t', ndmin=2)
    rth = (b[:, 2] >= 55800) & (b[:, 2] < 79200)
    if rth.sum() < 100: continue
    idx = b[:, 0].astype(int); start, end, hh, ll = b[:, 1], b[:, 2], b[:, 4], b[:, 5]; row = dict(d=d, multi=J[d]['bimod'] >= CUT, bim=J[d]['bimod'])
    for k, t in CHECK.items():
        m = rth & (end <= t)
        if m.sum() < 30: row['v' + k] = row['t' + k] = row['a' + k] = np.nan; continue
        bw = float(np.median(hh[m] - ll[m])) / 5.0; lo = float(ll[m].min()); n = int((hh[m].max() - lo) / bw) + 2
        sel = np.isin(v[:, 0].astype(int), idx[m]); V = np.zeros(n); np.add.at(V, np.minimum(((v[sel, 1] - lo) / bw).astype(int), n - 1), v[sel, 2])
        T = np.zeros(n); seen = {}
        for i in np.where(m)[0]:
            br = int((end[i] - 55800) // BRACKET); a = int((ll[i] - lo) / bw); z = int((hh[i] - lo) / bw)
            for r in range(a, z + 1):
                if (br, r) not in seen: seen[(br, r)] = 1; T[r] += 1                     # one mark per price row per 30-minute bracket: the TPO count
        A = 0.5 * (V / max(V.max(), 1e-9) + T / max(T.max(), 1e-9))
        row['v' + k] = score(V); row['t' + k] = score(T); row['a' + k] = score(A)
    rows.append(row)
n = len(rows); q90 = float(np.quantile([x['bim'] for x in rows], 0.9)); print(n, 'sessions; multi-hump', sum(x['multi'] for x in rows), '| strong B cut', round(q90, 2))
print('AUC of the DEVELOPING score for the final label (0.5 = no information):')
for k in CHECK:
    ok = [x for x in rows if not np.isnan(x['v' + k])]
    for tgt, f in (('final multi-hump', lambda x: x['multi']), ('strong B (top decile)', lambda x: x['bim'] >= q90)):
        pos = [x for x in ok if f(x)]; neg = [x for x in ok if not f(x)]
        print(f'  at {k} -> {tgt:22s} N+={len(pos):3d}/N-={len(neg):3d}   volume only {auc(np.array([x["v"+k] for x in pos]), np.array([x["v"+k] for x in neg])):.3f}   time (TPO) only {auc(np.array([x["t"+k] for x in pos]), np.array([x["t"+k] for x in neg])):.3f}   time + volume {auc(np.array([x["a"+k] for x in pos]), np.array([x["a"+k] for x in neg])):.3f}')
