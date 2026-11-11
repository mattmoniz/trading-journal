"""Row 37 (prereg docs/GLOBEX_ROC_LENGTH_SWEEP_PREREG_20261110.md): the row-36 Globex expansion rule at ROC length L = 1..20. Reuses globex_roc3_test (arm_events, calc_outcome via shadow, bootstrap). Stages: build | null | run."""
import os, sys, csv, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import globex_roc3_test as G
Fm, v2, SH = G.Fm, G.v2, G.SH
OUT = os.path.join(G.ROOT, 'scratch', 'globex_roc_sweep_20261110'); os.makedirs(OUT, exist_ok=True); LS = list(range(1, 21))

def build():
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []; ns = 0
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2:
            rt = hist['RTH'][-20:]; adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt])) if len(rt) >= 10 else float('nan')
            P, n0, reset = v2.continuous(prevS, S); n = len(P['c']); ns += 1
            for L in LS:
                Fm.L_ROC = L
                try: F = v2.feats(P, n0, reset, prs, close)
                finally: Fm.L_ROC = 10
                etr = Fm.ema(F['tr']); evs, _, _ = G.arm_events(P, n0, F, etr, close); en, o, h, l, c = P['en'], P['o'], P['h'], P['l'], P['c']
                for e in evs:
                    if not e['taken']: continue
                    oc = SH.calc_outcome(en, o, h, l, c, e['a'], e['dr'], float(etr[e['a']]), G.LIM, n, n0=n0)
                    if oc is None or isinstance(oc, tuple): continue
                    rows.append(dict(date=S['date'], L=L, dr=e['dr'], hour=int(Fm.hour_et(np.array([en[e['a']]]))[0]), adr20=round(adr20, 2), fwd=oc['fwd'], net_stop=oc['net_stop25']))
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    with open(os.path.join(OUT, 'events.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print('sessions', ns, 'taken events per L:', {L: sum(1 for r in rows if r['L'] == L) for L in LS})

def load():
    out = collections.defaultdict(list)
    for r in csv.DictReader(open(os.path.join(OUT, 'events.csv'))): out[int(r['L'])].append(dict(date=r['date'], hour=int(r['hour']), adr20=float(r['adr20']), fwd=float(r['fwd']), net_stop=float(r['net_stop'])))
    return out

def cells(ev, cost, draws, flip=None):
    res = {}
    for L in LS:
        sg = lambda x: x['fwd'] * (flip[x['date']] if flip else 1)
        for kind, f in (('C', lambda x: sg(x) - cost), ('R', lambda x: -sg(x) - cost)):
            v = [(x['date'], f(x)) for x in ev[L]]
            res[(kind, L)] = None if len(v) < G.MIN_N or len({d for d, _ in v}) < G.MIN_DAYS else G.boot_mean(v, (300 if kind == 'C' else 400) + L, draws)
    assert len(res) == 40
    return res

def null_gate(iters=200):
    ev = load(); dates = sorted({x['date'] for L in LS for x in ev[L]}); rng = np.random.default_rng(778); passes = 0
    for it in range(iters):
        flip = {d: int(rng.choice([-1, 1])) for d in dates}; res = cells(ev, 0.0, 1000, flip); keep, m = G.holm(res); passes += bool(keep)
    rate = passes / iters; print(f'NULL GATE: {iters} iterations, 40 cells, family-wise false-pass {rate:.3f} (required <= 0.10)'); json.dump(dict(rate=rate, ok=rate <= 0.10), open(os.path.join(OUT, 'null_gate.json'), 'w'))

def run():
    assert json.load(open(os.path.join(OUT, 'null_gate.json')))['ok']; ev = load(); res = cells(ev, G.COST, G.B); keep, m = G.holm(res)
    print(f'COUNTED: 40 cells ({m} passed the gate), cost {G.COST} pt, Holm 0.10 survivors: {sorted(keep) or "none"}')
    print('  L  events/sess   pre-cost mean  median |  C net [CI]  p      |  R net [CI]  p      | MDE_C | thirds(pre-cost)')
    nsess = len({x['date'] for x in ev[10]}); best = {}
    for L in LS:
        e = ev[L]; pre = np.mean([x['fwd'] for x in e]); med = np.median([x['fwd'] for x in e]); c = res[('C', L)]; r = res[('R', L)]
        ds = sorted({x['date'] for x in e}); th = [np.mean([x['fwd'] for x in e if x['date'] in set(t)]) for t in np.array_split(np.array(ds), 3)]
        mde = G.mde(c, e) if c else float('nan')
        print(f' {L:2d}  {len(e) / nsess:5.2f}  N {len(e):5d}  {pre:+6.2f}  {med:+6.2f} | {c["mean"]:+6.2f} [{c["lo"]:+.2f},{c["hi"]:+.2f}] p {c["p"]:.3f} | {r["mean"]:+6.2f} [{r["lo"]:+.2f},{r["hi"]:+.2f}] p {r["p"]:.3f} | {mde:.4f} | {th[0]:+.2f} {th[1]:+.2f} {th[2]:+.2f}')
    for kind in ('C', 'R'):
        bl = max((L for L in LS), key=lambda L: res[(kind, L)]['mean']); e = ev[bl]; v = [(1 if kind == 'C' else -1) * x['fwd'] - G.COST for x in e]; cnt = collections.Counter(x['date'] for x in e)
        print(f'BEST {kind}: L={bl} mean {np.mean(v):+.2f} median {np.median(v):+.2f} top-5-days share {sum(c for _, c in cnt.most_common(5)) / len(e):.3f} Holm {"PASS" if (kind, bl) in keep else "no"}')
    json.dump(dict(survivors=[list(k) for k in sorted(keep)], res={f'{k[0]}{k[1]}': v for k, v in res.items()}), open(os.path.join(OUT, 'summary.json'), 'w'), indent=1)

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    {'build': build, 'null': null_gate, 'run': run}.get(st, lambda: print(__doc__))()
