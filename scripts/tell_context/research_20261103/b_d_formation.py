"""Descriptive (hindsight, features and raw 500-bar prices/times only): how and when a B and a D FORM through the RTH day. Pre-registration: docs/B_D_FORMATION_STUDY_PREREG_20261103.md (ledger family b_d_formation_20261103).
Per session: the developing profile after every 30 minutes (width, value area, humps, hump separation), where each area builds and in what order, visits across the thirds and crossings of the thin zone, time (TPO) and volume per area,
the watcher state at checkpoints. Groups come from the FINAL profile (shared scripts/tell_context/profile_shape.py). Writes the per-session rows to scratch/tell_context_20261103/b_d_formation_rows.json.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/b_d_formation.py"""
import os, sys, glob, json
import numpy as np
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context')); import profile_shape as PS, watcher as W
ROOT = os.path.join(REPO, 'scratch', 'volbars500_full_20261028'); OUT = os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json')
CUT = json.load(open(os.path.join(REPO, 'scripts', 'tell_context', 'shape_cuts.json')))['bimod_top_tercile_cut']
RTH0, RTH1 = 55800.0, 79200.0; BRK = 1800.0; NB = PS.NB
CPS = [RTH0 + BRK * k for k in range(1, 13)]                 # 10:00 ... 15:30 ET
CPN = [f'{9 + (30 + 30 * k) // 60}:{(30 + 30 * k) % 60:02d}' for k in range(1, 13)]
GRID = [RTH0 + 600.0 * k for k in range(6, 39)]              # 10:30 ... 15:50 every 10 minutes (the first moment a second hump is seen)
BLOCKS = [('open-11:00', RTH0 + 5400), ('11:00-13:00', RTH0 + 12600), ('13:00-close', RTH1 + 1)]

def block(t): return next(i for i, (_, e) in enumerate(BLOCKS) if t < e)
def wmedian(t, w):
    if w.sum() <= 0: return float('nan')
    o = np.argsort(t); c = np.cumsum(w[o]); return float(t[o][np.searchsorted(c, 0.5 * c[-1])])
def binof(px, lo, hi): return np.minimum(((px - lo) / (hi - lo) * NB).astype(int), NB - 1)

def session(p):
    b = np.loadtxt(p, delimiter='\t', ndmin=2); v = np.loadtxt(p.replace('.bars.', '.vap.'), delimiter='\t', ndmin=2)
    end_all, h_all, l_all, c_all = b[:, 2], b[:, 4], b[:, 5], b[:, 6]
    rth = (end_all >= RTH0) & (end_all < RTH1)
    if rth.sum() < 100: return None
    shown = W.run(end_all, h_all, l_all, c_all)['shown']
    ib = b[rth]; idx = ib[:, 0].astype(int); start, end, op, hh, ll, cc = ib[:, 1], ib[:, 2], ib[:, 3], ib[:, 4], ib[:, 5], ib[:, 6]
    vm = np.isin(v[:, 0].astype(int), idx); vv = v[vm]; vv = vv[np.argsort(vv[:, 0], kind='stable')]; vidx = vv[:, 0].astype(int); px, vol = vv[:, 1], vv[:, 2]
    f = PS.features(px, vol)
    if f is None: return None
    lo, hi = f['lo'], f['hi']; ext = hi - lo; r = dict(final=dict(ext=ext, ext_pct=100 * ext / op[0], va_share=f['vah'] - f['val'], bimod=f['bimod'], humps=f['humps'], va_mid=f['va_mid'], letter=PS.letter(f['va_mid']), poc_pos=f['poc_pos']), open=float(op[0]))
    def upto(t):
        n = int(np.searchsorted(end, t, side='right'))
        return n, int(np.searchsorted(vidx, idx[n - 1], side='right')) if n else 0
    dev = {}
    for k, t in zip(CPN, CPS):
        n, m = upto(t); g = PS.features(px[:m], vol[:m]) if n >= 20 and m else None
        if g is None: dev[k] = None; continue
        e = g['hi'] - g['lo']; pk = g['peaks']; dev[k] = dict(ext=e, ext_pct=100 * e / op[0], va_share=g['vah'] - g['val'], bimod=g['bimod'], humps=g['humps'], sep=(abs(pk[0] - pk[1]) / NB * e if len(pk) >= 2 else 0.0), state=shown[int(np.searchsorted(end_all, t, side='right')) - 1])
    r['dev'] = dev
    first2 = None; below = None
    for t in GRID:
        n, m = upto(t); g = PS.features(px[:m], vol[:m]) if n >= 20 and m else None
        if g is None: continue
        if first2 is None and g['humps'] >= 2: first2 = (t - RTH0) / 60
        if g['bimod'] < CUT: below = t
    r['first_second_hump_min'] = first2; r['flag_settled_min'] = None if below is None else ((below + 600 - RTH0) / 60 if below < GRID[-1] else None)
    # where the areas build: the final profile's two highest peaks, split at the thin zone (trough bin)
    pk, tr = f['peaks'], f['trough']
    if len(pk) >= 2 and tr is not None:
        pb = binof(px, lo, hi); area = np.where(pb < tr, 0, np.where(pb > tr, 2, 1))              # 0 lower area, 1 thin zone, 2 upper area
        bar_of_row = np.searchsorted(idx, vidx); av = np.zeros((3, len(idx)))
        for a in range(3): np.add.at(av[a], bar_of_row[area == a], vol[area == a])
        tmid = (start + end) / 2; med = {a: wmedian(tmid, av[a]) for a in (0, 2)}; tot = {a: float(av[a].sum()) for a in (0, 2)}
        up_first = med[2] < med[0]; same = block(med[0]) == block(med[2])
        r['areas'] = dict(order=('same_block' if same else ('top_then_bottom' if up_first else 'bottom_then_top')), gap_h=abs(med[2] - med[0]) / 3600, blocks=[BLOCKS[block(med[0])][0], BLOCKS[block(med[2])][0]],
                          larger='upper' if tot[2] >= tot[0] else 'lower', vol_share_thin=float(av[1].sum() / av.sum()), upper_vol_share=tot[2] / (tot[0] + tot[2]))
        # TPO: one mark per price row (final bins) per 30-minute bracket from the bar highs and lows
        br = ((end - RTH0) // BRK).astype(int); lo_b, hi_b = binof(ll, lo, hi), binof(hh, lo, hi); seen = set(); Tb = np.zeros((3, 13))
        for i in range(len(idx)):
            for rr in range(lo_b[i], hi_b[i] + 1):
                if (br[i], rr) not in seen:
                    seen.add((br[i], rr)); a = 0 if rr < tr else (2 if rr > tr else 1); Tb[a, min(br[i], 12)] += 1
        Vb = np.zeros((3, 13)); np.add.at(Vb, (area, np.minimum(br[bar_of_row], 12)), vol)
        sm_a = 0 if tot[0] <= tot[2] else 2                                                       # the smaller (second) area by volume
        def tfrac(M, q): c = np.cumsum(M[sm_a]) / max(M[sm_a].sum(), 1e-9); return float((np.searchsorted(c, q) + 1) * 30)
        r['tpo'] = dict(second_vol25=tfrac(Vb, .25), second_vol50=tfrac(Vb, .5), second_tpo25=tfrac(Tb, .25), second_tpo50=tfrac(Tb, .5), tpo_larger='upper' if Tb[2].sum() >= Tb[0].sum() else 'lower', agree=bool((Tb[2].sum() >= Tb[0].sum()) == (tot[2] >= tot[0])))
        # visits: close of each bar across the final thirds, and crossings of the thin zone
        z = np.where((cc - lo) / ext < 1 / 3, 0, np.where((cc - lo) / ext > 2 / 3, 2, 1)); dur = end - start; seq = [int(z[0])]
        for x in z[1:]:
            if x != seq[-1]: seq.append(int(x))
        direct = sum(1 for a, c2 in zip(seq, seq[1:]) if abs(a - c2) == 2)
        tp = lo + (tr + 0.5) / NB * ext; side = np.sign(cc - tp); side = np.where(side == 0, 1, side); cr = np.where(side[1:] != side[:-1])[0]
        hrs = (end[-1] - start[0]) / 3600
        outer = [(i, int(z[i])) for i in range(len(z)) if z[i] != 1]; sw = []                         # swings between the outer thirds, ignoring the middle (hysteresis); traversal = last bar in one outer third to first bar in the other
        for (i0, a), (i1, c2) in zip(outer, outer[1:]):
            if a != c2: sw.append((float((end[i1] - end[i0]) / 60), float((end[i1] - RTH0) / 60)))
        r['visits'] = dict(n_visits=len(seq), direct_jumps=direct, mid_time_share=float(dur[z == 1].sum() / dur.sum()), mid_bar_share=float((z == 1).mean()), crossings=int(len(cr)), cross_per_h=float(len(cr) / hrs),
                           min_per_cross=(float(np.median(np.diff(end[cr + 1])) / 60) if len(cr) >= 2 else None), first_cross_min=(float((end[cr[0] + 1] - RTH0) / 60) if len(cr) else None), swings=len(sw), trav_min=[x[0] for x in sw], trav_at_min=[x[1] for x in sw])
    return r

rows = {}
for p in sorted(glob.glob(ROOT + '/*.bars.tsv')):
    d = os.path.basename(p)[:10]
    if d > '2025-05-16': continue
    s = session(p)
    if s: rows[d] = s
D = sorted(rows)
for i, d in enumerate(D):                                                   # prior-20-session average range, for width in ADR units
    prev = [rows[x]['final']['ext'] for x in D[max(0, i - 20):i]]; rows[d]['adr20'] = float(np.mean(prev)) if len(prev) >= 10 else None
json.dump(rows, open(OUT, 'w')); print(len(rows), 'sessions ->', OUT)
