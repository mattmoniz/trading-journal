"""Row 43 (prereg docs/CAPITULATION_FAIL_FORK_PREREG_20261110.md): the user's capitulation FAIL (it keeps going with little bounce) vs BOUNCE, at a major level, traded as a causal fork. Stages: test | build | null | run.
Climaxes = row 42's events_raw.csv. Reuses globex_roc3_test (G), capitulation_reengage (CR: OUT dir, flags), shadow.calc_outcome."""
import os, sys, csv, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_reengage as CR
G, Fm, v2, SH = CR.G, CR.Fm, CR.v2, CR.SH
IN = CR.OUT; OUT = os.path.join(G.ROOT, 'scratch', 'capitulation_fail_20261110'); os.makedirs(OUT, exist_ok=True)
MAJOR = ('PD_HIGH', 'PD_LOW', 'PD_VAH', 'PD_VAL', 'PW_HIGH', 'PW_LOW', 'PW_VAH', 'PW_VAL'); W, MINH, KEEP = 30, 60, 600; TOL_MULT = 0.5

def resolve_fork(s, a, x, tol, bstar, h, l, last):
    """Bars a+1..last. s = climax direction (-1 selling). bounce(j) = excursion AGAINST s from x. Returns (label, j, max bounce before the fail/end). FAIL: a bar trades beyond x by > tol while the bounce so far < bstar. BOUNCED: bounce reaches bstar first. Both in one bar: AMBIGUOUS."""
    best = 0.0
    for j in range(a + 1, last + 1):
        bj = (h[j] - x) if s < 0 else (x - l[j]); fj = (l[j] < x - tol) if s < 0 else (h[j] > x + tol)
        if fj and bj >= bstar: return 'AMBIGUOUS', j, best
        if fj: return 'FAIL', j, best
        best = max(best, bj)
        if best >= bstar: return 'BOUNCED', j, best
    return 'DRIFT', None, best

def unit_tests():
    ok = True
    def chk(name, got, want):
        nonlocal ok; good = got[0] == want[0] and got[1] == want[1]; ok &= good; print(('PASS ' if good else 'FAIL ') + name, '' if good else f'got {got} want {want}')
    n = 40; x = 100.0; h = np.full(n, 101.0); l = np.full(n, 99.5)     # selling climax: x = 100 is the low; bounce = high - 100
    hh = h.copy(); hh[8] = 106.0; chk('1 bounce reaches b* = 5 at bar 8 -> BOUNCED', resolve_fork(-1, 5, x, 0.5, 5.0, hh, l, 30), ('BOUNCED', 8))
    ll = l.copy(); ll[7] = 99.0; chk('2 new low 99 < 100 - 0.5 at bar 7 with a small bounce -> FAIL', resolve_fork(-1, 5, x, 0.5, 5.0, h, ll, 30), ('FAIL', 7))
    ll3 = l.copy(); ll3[7] = 99.0; hh3 = h.copy(); hh3[7] = 106.0; chk('3 both in one bar -> AMBIGUOUS', resolve_fork(-1, 5, x, 0.5, 5.0, hh3, ll3, 30), ('AMBIGUOUS', 7))
    chk('4 neither inside the window -> DRIFT', resolve_fork(-1, 5, x, 0.5, 5.0, h, l, 30), ('DRIFT', None))
    hs = np.full(n, 100.5); ls = np.full(n, 99.0); ls[9] = 94.0; chk('5 buying climax (s=+1, x = 100 high): bounce = x - low = 6 >= 5 at bar 9 -> BOUNCED', resolve_fork(1, 5, x, 0.5, 5.0, hs, ls, 30), ('BOUNCED', 9))
    hs2 = hs.copy(); hs2[6] = 101.0; chk('6 buying climax: high 101 > 100 + 0.5 at bar 6 -> FAIL', resolve_fork(1, 5, x, 0.5, 5.0, hs2, ls.copy() * 0 + 99.5, 30), ('FAIL', 6))
    chk('7 a poke of 0.4 below x (tol 0.5) is not a fail', resolve_fork(-1, 5, x, 0.5, 5.0, h, np.where(np.arange(n) == 7, 99.6, l), 30), ('DRIFT', None))
    print('ALL PASS' if ok else 'SOME FAILED'); return ok


VARIANTS = ((1.0, 1.0), (0.5, 1.0), (2.0, 1.0), (1.0, 0.5), (1.0, 2.0))      # (b* multiplier, tol multiplier): the first is the registered base; the rest are descriptive sensitivities
def load_levels():
    cu = SH.persist.connect().cursor(); cu.execute("SELECT trade_date::text, level_name, price::float FROM level_prices WHERE level_name = ANY(%s) AND trade_date BETWEEN '2023-03-06' AND '2025-05-16'", (list(MAJOR),)); L = collections.defaultdict(list)
    for d, nm, px in cu.fetchall(): L[d].append(px)
    return L

def build():
    ev = CR.load_flags(); by_date = collections.defaultdict(list)
    for e in ev: by_date[e['date']].append(e)
    L = load_levels(); files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []; cnt = collections.Counter(); bh = {'RTH': [], 'GBX': []}; dh = {'RTH': [], 'GBX': []}
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; new_b = collections.defaultdict(list); new_d = collections.defaultdict(list)
        if S['date'] in by_date:
            prs = {n: Fm.priors_of(hist[n][-Fm.K_PRIOR:]) for n in ('RTH', 'GBX')}; rt = hist['RTH'][-20:]; adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt]))
            P, n0, reset = v2.continuous(prevS, S); n = len(P['c']); Fm.L_ROC = 10; F = v2.feats(P, n0, reset, prs, close); etr = Fm.ema(F['tr']); en, o, h, l, c = P['en'], P['o'], P['h'], P['l'], P['c']
            for e in by_date[S['date']]:
                s = int(e['dir']); a = n0 + int(e['k']); tr = e['track']; lim = G.LIM if tr == 'GBX' else close - 300.0; wend = 55500.0 if tr == 'GBX' else close - 600.0
                x = float(e['px5']); tol0 = TOL_MULT * float(etr[a]); last = a
                while last + 1 <= min(a + W, n - 2) and en[last + 1] <= wend: last += 1
                _, _, btot = resolve_fork(s, a, x, tol0, float('inf'), h, l, last); new_b[tr].append(btot / adr20)
                lv = L.get(S['date']); dist = min(abs(x - q) for q in lv) / adr20 if lv else None
                if dist is not None: new_d[tr].append(dist)
                bs = float(np.median(bh[tr][-KEEP:])) if len(bh[tr][-KEEP:]) >= MINH else None; dcut = float(np.percentile(dh[tr][-KEEP:], 100 / 3)) if len(dh[tr][-KEEP:]) >= MINH else None
                if bs is None or dcut is None: cnt[(tr, 'burnin')] += 1; continue
                row = dict(date=S['date'], track=tr, dir=s, adr20=round(adr20, 2), dist=round(dist, 4) if dist is not None else '', at_level=int(dist is not None and dist <= dcut), defended=int(e['flag']['defended']), pivot_live=int(e['flag']['pivot_live']), strict=int(e['strict']), label='', arm='', joff='', fwd='', net_stop='', px_exit='', px_entry='')
                labs = []
                for mb, mt in VARIANTS:
                    lab, j, _ = resolve_fork(s, a, x, tol0 * mt, bs * mb * adr20, h, l, last); labs.append(lab)
                    if (mb, mt) == (1.0, 1.0):
                        row['label'] = lab
                        if lab in ('FAIL', 'BOUNCED'):
                            dr = s if lab == 'FAIL' else -s; oc = SH.calc_outcome(en, o, h, l, c, j, dr, float(etr[j]), lim, n, n0=n0)
                            if oc is None or isinstance(oc, tuple): cnt[(tr, 'entry-dropped')] += 1
                            else: row.update(arm='F' if lab == 'FAIL' else 'B', joff=int(j - a), fwd=oc['fwd'], net_stop=oc['net_stop25'], px_exit=float(o[a + 1]), px_entry=float(o[j + 1]))
                row['variants'] = '|'.join(labs); rows.append(row)
        for tr in ('RTH', 'GBX'): bh[tr] += new_b[tr]; dh[tr] += new_d[tr]
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    with open(os.path.join(OUT, 'events_fork.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print('burn-in / drops', dict(cnt))
    for tr in ('RTH', 'GBX'):
        r = [x for x in rows if x['track'] == tr]; print(f'  {tr}: {len(r)} climaxes with cutoffs; at-level {sum(x["at_level"] for x in r)}; labels', dict(collections.Counter(x['label'] for x in r)), '; F entries', sum(1 for x in r if x['arm'] == 'F'), 'B entries', sum(1 for x in r if x['arm'] == 'B'), '; at-level F', sum(1 for x in r if x['arm'] == 'F' and x['at_level']), 'at-level B', sum(1 for x in r if x['arm'] == 'B' and x['at_level']))

def load_fork():
    out = []
    for r in csv.DictReader(open(os.path.join(OUT, 'events_fork.csv'))):
        out.append(dict(date=r['date'], track=r['track'], dir=int(r['dir']), adr20=float(r['adr20']), at_level=int(r['at_level']), has_dist=r['dist'] != '', defended=int(r['defended']), pivot_live=int(r['pivot_live']), strict=int(r['strict']), label=r['label'], arm=r['arm'], fwd=float(r['fwd']) if r['fwd'] != '' else None, net_stop=float(r['net_stop']) if r['net_stop'] != '' else None, px_exit=float(r['px_exit']) if r['px_exit'] != '' else None, px_entry=float(r['px_entry']) if r['px_entry'] != '' else None, variants=r['variants'].split('|')))
    return out

TESTS = [(tr, nm) for tr in ('RTH', 'GBX') for nm in ('FAIL-ENTRY-AT-LEVEL', 'BOUNCE-ENTRY-AT-LEVEL', 'FAIL-ENTRY-ALL', 'BOUNCE-ENTRY-ALL', 'FAIL-SHARE')]; assert len(TESTS) == 10
def cells(ev, cost, draws, flip=None, perm=None):
    res = {}
    for k, (tr, nm) in enumerate(TESTS):
        e_tr = [(i, x) for i, x in enumerate(ev) if x['track'] == tr]; seed = 1300 + k
        if nm == 'FAIL-SHARE':
            el = [(i, x) for i, x in e_tr if x['has_dist'] and x['label'] in ('FAIL', 'BOUNCED', 'DRIFT')]
            al = lambda i, x: (perm[i] if perm is not None else x['at_level'])
            a = [(x['date'], 1.0 if x['label'] == 'FAIL' else 0.0) for i, x in el if al(i, x)]; b = [(x['date'], 1.0 if x['label'] == 'FAIL' else 0.0) for i, x in el if not al(i, x)]
            if len(a) < G.MIN_N or len(b) < G.MIN_N or len({d for d, _ in a}) < G.MIN_DAYS: res[(tr, nm)] = None; continue
            r = G.boot_diff(a, b, seed, draws); p1 = r['p']; r = dict(r, p=min(1.0, 2 * min(p1, 1 - p1 + 1.0 / (draws + 1)))); res[(tr, nm)] = r; continue
        arm = 'F' if nm.startswith('FAIL') else 'B'; at = nm.endswith('AT-LEVEL')
        vals = [(x['date'], x['fwd'] * (flip[x['date']] if flip else 1) - cost) for i, x in e_tr if x['arm'] == arm and (not at or x['at_level'])]
        res[(tr, nm)] = None if len(vals) < G.MIN_N or len({d for d, _ in vals}) < G.MIN_DAYS else G.boot_mean(vals, seed, draws)
    return res

def null_gate(iters=1000, alpha=0.10, seed=787):
    ev = load_fork(); dates = sorted({x['date'] for x in ev}); rng = np.random.default_rng(seed); passes = 0
    idx_by_tr = {tr: [i for i, x in enumerate(ev) if x['track'] == tr and x['has_dist']] for tr in ('RTH', 'GBX')}
    for it in range(iters):
        flip = {d: int(rng.choice([-1, 1])) for d in dates}; perm = {i: ev[i]['at_level'] for i in range(len(ev))}
        for tr, ids in idx_by_tr.items():
            vals = [ev[i]['at_level'] for i in ids]; rng.shuffle(vals); perm.update(dict(zip(ids, vals)))
        keep, m = G.holm(cells(ev, 0.0, 1000, flip, perm), alpha); passes += bool(keep)
    rate = passes / iters; print(f'NULL GATE: 10 tests, {iters} iterations, Holm {alpha}: family-wise false-pass {rate:.3f} (required <= 0.10)'); json.dump(dict(rate=rate, ok=rate <= 0.10, alpha=alpha, iters=iters), open(os.path.join(OUT, 'null_gate.json'), 'w'))

def run():
    ng = json.load(open(os.path.join(OUT, 'null_gate.json'))); assert ng['ok']; ALPHA = ng['alpha']; ev = load_fork(); res = cells(ev, G.COST, G.B); keep, m = G.holm(res, ALPHA)
    print(f'COUNTED: 10 tests ({m} passed the gate), cost {G.COST} pt, Holm {ALPHA} survivors: {sorted(keep) or "none"}')
    for (tr, nm) in TESTS:
        r = res[(tr, nm)]
        if r is None: print(f'  {tr} {nm:22s} PARKED (gate: >= 100 events and >= 60 days)'); continue
        print(f'  {tr} {nm:22s} N {r["n"]:4d} days {r["days"]:4d}  {r["mean"]:+7.3f} [{r["lo"]:+.3f}, {r["hi"]:+.3f}] p {r["p"]:.3f} t {r["t"]:+.2f}  Holm {"PASS" if (tr, nm) in keep else "no"}' + ('   (share difference, two-sided p)' if nm == 'FAIL-SHARE' else ''))
    json.dump(dict(survivors=[list(k) for k in sorted(keep)], res={'_'.join(k): v for k, v in res.items()}), open(os.path.join(OUT, 'summary.json'), 'w'), indent=1)
    print('\nDESCRIPTIVE (never counted)')
    for tr in ('RTH', 'GBX'):
        e = [x for x in ev if x['track'] == tr]
        for lab, f in (('all', lambda x: True), ('AT-LEVEL', lambda x: x['at_level'] == 1 and x['has_dist']), ('away', lambda x: x['at_level'] == 0 and x['has_dist']), ('strict defended pivot', lambda x: x['defended'] == 1), ('pivot-live', lambda x: x['pivot_live'] == 1)):
            sub = [x for x in e if f(x)]
            if not sub: continue
            c = collections.Counter(x['label'] for x in sub); nn = len(sub)
            print(f'  {tr} {lab:22s} N {nn:4d}: FAIL {c["FAIL"] / nn:.0%} ({c["FAIL"]})  BOUNCED {c["BOUNCED"] / nn:.0%} ({c["BOUNCED"]})  DRIFT {c["DRIFT"] / nn:.0%}  AMBIGUOUS {c["AMBIGUOUS"] / nn:.0%}')
        for arm, name in (('F', 'FAIL entry (continue with the move)'), ('B', 'BOUNCED entry (join the bounce)')):
            for lab, f in (('all', lambda x: True), ('AT-LEVEL', lambda x: x['at_level'] == 1)):
                sub = [x for x in e if x['arm'] == arm and f(x)]
                if len(sub) >= 5: print(f'  {tr} {name:36s} {lab:9s} N {len(sub):4d} pre-cost {np.mean([x["fwd"] for x in sub]):+7.2f} median {np.median([x["fwd"] for x in sub]):+7.2f} net {np.mean([x["fwd"] - G.COST for x in sub]):+7.2f} V0-stop net {np.mean([x["net_stop"] for x in sub]):+7.2f}')
            sub = [x for x in e if x['arm'] == arm]
            if sub:
                ds = sorted({x['date'] for x in sub}); th = [np.mean([x['fwd'] - G.COST for x in sub if x['date'] in set(q)]) for q in np.array_split(np.array(ds), 3)]; yrs = ', '.join(f'{y} {np.mean([x["fwd"] - G.COST for x in sub if x["date"][:4] == y]):+.2f} (N {sum(1 for x in sub if x["date"][:4] == y)})' for y in sorted({x["date"][:4] for x in sub}))
                print(f'     {tr} {arm} thirds {[round(float(q), 2) for q in th]} | by year {yrs}')
        for vi, (mb, mt) in enumerate(VARIANTS):
            c = collections.Counter(x['variants'][vi] for x in e if x['has_dist']); nn = sum(c.values()); print(f'  {tr} sensitivity b* x{mb} tol x{mt}: FAIL {c["FAIL"] / nn:.0%} BOUNCED {c["BOUNCED"] / nn:.0%} DRIFT {c["DRIFT"] / nn:.0%} AMBIGUOUS {c["AMBIGUOUS"] / nn:.0%}')

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'test': unit_tests()
    elif st == 'build': build()
    elif st == 'null': null_gate(int(sys.argv[2]) if len(sys.argv) > 2 else 1000, float(sys.argv[3]) if len(sys.argv) > 3 else 0.10, int(sys.argv[4]) if len(sys.argv) > 4 else 787)
    elif st == 'run': run()
    else: print(__doc__)
