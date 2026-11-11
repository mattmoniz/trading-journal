"""Row 39 (prereg docs/GLOBEX_BAR_SIZE_PREREG_20261110.md): the live Globex rule on 100/125-contract bars (500 = within-pass control), ROC length 3 and 10, hold = 30 bars or contract-matched. Stages: build | null | run.
Reuses globex_roc3_test (arm_events with a hold lock, bootstrap, Holm, hour groups) and shadow.calc_outcome."""
import os, sys, csv, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import globex_roc3_test as G
Fm, v2, SH = G.Fm, G.v2, G.SH
SIZES = [int(s) for s in os.environ.get('BS_SIZES', '100,125').split(',')]          # tested bar sizes (row 39: 100,125; row 41: 1000,2000); 500 is always the within-pass control
SEED0 = int(os.environ.get('BS_SEED0', '600')); ALPHA0 = float(os.environ.get('BS_ALPHA', '0.10'))
OUT = os.path.join(G.ROOT, 'scratch', os.environ.get('BS_TAG', 'globex_barsize_20261110')); os.makedirs(OUT, exist_ok=True)
DIR = lambda s: os.path.join(G.ROOT, 'scratch', f'volbars{s}_globex_20261110')
CONTRACTS_MATCH = 15000                       # the 500V rule's 30-bar hold in contracts
RUNS = [(s, L) for s in SIZES for L in (3, 10)] + [(500, 3), (500, 5), (500, 10)]    # (size, L); 500 = control (descriptive)
def holds(size): return {'HB': 30, 'HC': CONTRACTS_MATCH // size}
CELLS = [(s, L, h) for s in SIZES for L in (3, 10) for h in ('HB', 'HC')]; assert len(CELLS) == 8
def load_bars(path, size):
    rows = []
    for ln in open(path):
        p = ln.rstrip('\n').split('\t')
        if len(p) < 12 or p[11] != '1' or float(p[7]) != size: continue
        rows.append([float(x) for x in p[1:7]] + [float(p[7]), float(p[8]), float(p[9]), float(p[10])])
    if not rows: return None
    a = np.array(rows).T; return dict(st=a[0], en=a[1], o=a[2], h=a[3], l=a[4], c=a[5], v=a[6], bid=a[7], ask=a[8], ntr=a[9])

def build():
    adr = {r['date']: float(r['adr20']) for r in csv.DictReader(open(os.path.join(G.ROOT, 'scratch', 'globex_roc3_20261110', 'events.csv'))) if r['adr20'] not in ('', 'nan')}
    dates = sorted(os.path.basename(p)[:10] for p in glob.glob(os.path.join(DIR(500), '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE); rows = []; nsess = collections.Counter()
    for size in SIZES + [500]:
        hist = []; prevS = None
        for d in dates:
            fp = os.path.join(DIR(size), d + '.bars.tsv')
            if not os.path.exists(fp): continue
            S = load_bars(fp, size)
            if S is None: continue
            S['date'] = d
            if len(hist) >= Fm.K_PRIOR and prevS is not None:
                pr = Fm.priors_of(hist[-Fm.K_PRIOR:]); prs = {'GBX': pr, 'RTH': pr}; P, n0, reset = v2.continuous(prevS, S); n = len(P['c']); en, o, h, l, c = P['en'], P['o'], P['h'], P['l'], P['c']; nsess[size] += 1
                for (sz, L) in RUNS:
                    if sz != size: continue
                    Fm.L_ROC = L
                    try: F = v2.feats(P, n0, reset, prs, Fm.CLOSE)
                    finally: Fm.L_ROC = 10
                    etr = Fm.ema(F['tr'])
                    for hl, hb in (holds(size) if size != 500 else {'HB': 30}).items():
                        evs, _, _ = G.arm_events(P, n0, F, etr, Fm.CLOSE, hold=hb)
                        for e in evs:
                            if not e['taken']: continue
                            oc = SH.calc_outcome(en, o, h, l, c, e['a'], e['dr'], float(etr[e['a']]), G.LIM, n, hold=hb, n0=n0)
                            if oc is None or isinstance(oc, tuple): continue
                            rows.append(dict(date=d, size=size, L=L, h=hl, dr=e['dr'], hour=int(Fm.hour_et(np.array([en[e['a']]]))[0]), first30=int(en[e['a']] <= 1800.0), fast=int(F['acc'][e['a']] <= 0.65), adr20=adr.get(d, float('nan')), fwd=oc['fwd'], net_stop=oc['net_stop25']))
            hist.append(S); prevS = S
    with open(os.path.join(OUT, 'events.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print('sessions scored per size', dict(nsess))
    for (sz, L) in RUNS:
        for hl in (holds(sz) if sz != 500 else {'HB': 30}):
            r = [x for x in rows if x['size'] == sz and x['L'] == L and x['h'] == hl]; print(f'  size {sz} L {L} {hl}: taken {len(r)} on {len({x["date"] for x in r})} days, {len(r) / max(nsess[sz], 1):.1f} per session')

def load():
    return [dict(date=r['date'], size=int(r['size']), L=int(r['L']), h=r['h'], hour=int(r['hour']), first30=int(r['first30']), fast=int(r['fast']), adr20=float(r['adr20']), fwd=float(r['fwd']), net_stop=float(r['net_stop'])) for r in csv.DictReader(open(os.path.join(OUT, 'events.csv')))]

def cells(ev, cost, draws, flip=None):
    res = {}
    for k, (s, L, h) in enumerate(CELLS):
        sub = [x for x in ev if x['size'] == s and x['L'] == L and x['h'] == h]
        for kind, base in (('C', SEED0), ('R', SEED0 + 100)):
            v = [(x['date'], ((1 if kind == 'C' else -1) * x['fwd'] * (flip[x['date']] if flip else 1)) - cost) for x in sub]
            res[(kind, s, L, h)] = None if len(v) < G.MIN_N or len({d for d, _ in v}) < G.MIN_DAYS else G.boot_mean(v, base + k, draws)
    assert len(res) == 16
    return res

def null_gate(iters=200, alpha=0.10, seed=780):
    ev = load(); dates = sorted({x['date'] for x in ev}); rng = np.random.default_rng(seed); passes = 0
    for it in range(iters):
        flip = {d: int(rng.choice([-1, 1])) for d in dates}; keep, m = G.holm(cells(ev, 0.0, 1000, flip), alpha); passes += bool(keep)
    rate = passes / iters; print(f'NULL GATE: 16 cells, {iters} iterations, Holm {alpha}: family-wise false-pass {rate:.3f} (required <= 0.10)'); json.dump(dict(rate=rate, ok=rate <= 0.10, alpha=alpha, iters=iters), open(os.path.join(OUT, 'null_gate.json'), 'w'))

def run():
    ng = json.load(open(os.path.join(OUT, 'null_gate.json'))); assert ng['ok']; ALPHA = ng.get('alpha', 0.10); ev = load(); res = cells(ev, G.COST, G.B); keep, m = G.holm(res, ALPHA); groups, _ = G.hour_groups()
    print(f'COUNTED: 16 cells ({m} passed the gate), cost {G.COST} pt, Holm {ALPHA} survivors: {sorted(keep) or "none"}')
    print('  size  L  hold   N     ev/sess  pre-cost mean  median | C net [CI] p | R net [CI] p | MDE | thirds(pre-cost)')
    nsess = {s: len({x['date'] for x in ev if x['size'] == s}) for s in SIZES + [500]}
    for (s, L, h) in CELLS + [(500, L, 'HB') for L in (3, 5, 10)]:
        sub = [x for x in ev if x['size'] == s and x['L'] == L and x['h'] == h]
        if not sub: continue
        pre = np.mean([x['fwd'] for x in sub]); med = np.median([x['fwd'] for x in sub]); ds = sorted({x['date'] for x in sub}); th = [np.mean([x['fwd'] for x in sub if x['date'] in set(t)]) for t in np.array_split(np.array(ds), 3)]
        c = res.get(('C', s, L, h)) or G.boot_mean([(x['date'], x['fwd'] - G.COST) for x in sub], 11); r = res.get(('R', s, L, h)) or G.boot_mean([(x['date'], -x['fwd'] - G.COST) for x in sub], 12)
        mde = G.mde(c, sub); tag = '' if s != 500 else ' (control, descriptive)'
        print(f'  {s:3d} {L:2d} {h}  {len(sub):5d}  {len(sub) / nsess[s]:5.1f}  {pre:+7.2f} {med:+7.2f} | {c["mean"]:+6.2f} [{c["lo"]:+.2f},{c["hi"]:+.2f}] p {c["p"]:.3f} | {r["mean"]:+6.2f} [{r["lo"]:+.2f},{r["hi"]:+.2f}] p {r["p"]:.3f} | {mde:.4f} | {th[0]:+.2f} {th[1]:+.2f} {th[2]:+.2f}{tag}')
    print('\nDESCRIPTIVE splits (continuation net, points; never counted)')
    for (s, L, h) in CELLS:
        sub = [x for x in ev if x['size'] == s and x['L'] == L and x['h'] == h]
        if not sub: continue
        parts = []
        for lab, f in (('SLOW', lambda x: x['hour'] in groups['SLOW']), ('MID', lambda x: x['hour'] in groups['MID']), ('FAST', lambda x: x['hour'] in groups['FAST']), ('fast-tape', lambda x: x['fast']), ('slow-tape', lambda x: not x['fast']), ('ex-first30', lambda x: not x['first30'])):
            v = [x['fwd'] - G.COST for x in sub if f(x)]; parts.append(f'{lab} {np.mean(v):+.2f} (N {len(v)})' if v else f'{lab} none')
        yrs = ', '.join(f'{y} {np.mean([x["fwd"] - G.COST for x in sub if x["date"][:4] == y]):+.2f}' for y in sorted({x['date'][:4] for x in sub}))
        print(f'  {s}V L{L} {h}: ' + ' | '.join(parts) + f' | by year {yrs}')
    json.dump(dict(survivors=[list(k) for k in sorted(keep)], res={'_'.join(map(str, k)): v for k, v in res.items()}), open(os.path.join(OUT, 'summary.json'), 'w'), indent=1)

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'null': null_gate(int(sys.argv[2]) if len(sys.argv) > 2 else 200, float(sys.argv[3]) if len(sys.argv) > 3 else 0.10, int(sys.argv[4]) if len(sys.argv) > 4 else 780)
    else: {'build': build, 'run': run}.get(st, lambda: print(__doc__))()
