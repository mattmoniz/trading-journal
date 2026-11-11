"""Row 44 (prereg docs/CAPITULATION_SPEED_EXIT_PREREG_20261110.md): extreme bar speed at a capitulation climax as an EXIT signal. Stages: build | null | run. Climaxes = row 42 events_raw.csv; pace = features.pace_cdf (share of prior same-hour bars at least as fast)."""
import os, sys, csv, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import capitulation_reengage as CR
G, Fm, v2, SH = CR.G, CR.Fm, CR.v2, CR.SH
OUT = os.path.join(G.ROOT, 'scratch', 'capitulation_speed_20261110'); os.makedirs(OUT, exist_ok=True); MINH, KEEP = 60, 600

def build():
    ev = CR.load_flags(); by_date = collections.defaultdict(list)
    for e in ev: by_date[e['date']].append(e)
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []; ph = {'RTH': [], 'GBX': []}; cnt = collections.Counter()
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; newp = collections.defaultdict(list)
        if S['date'] in by_date:
            prs = {n: Fm.priors_of(hist[n][-Fm.K_PRIOR:]) for n in ('RTH', 'GBX')}; rt = hist['RTH'][-20:]; adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt]))
            P, n0, reset = v2.continuous(prevS, S); n = len(P['c']); Fm.L_ROC = 10; F = v2.feats(P, n0, reset, prs, close); etr = Fm.ema(F['tr']); en, o, h, l, c = P['en'], P['o'], P['h'], P['l'], P['c']
            for e in by_date[S['date']]:
                s = int(e['dir']); a = n0 + int(e['k']); tr = e['track']; lim = G.LIM if tr == 'GBX' else close - 300.0
                pw = F['pace'][max(a - 4, n0):a + 1]; dw = F['dur'][max(a - 4, n0):a + 1]
                if np.all(np.isnan(pw)): cnt[(tr, 'no-pace')] += 1; continue
                pace5 = float(np.nanmin(pw)); pace_a = float(F['pace'][a]) if not np.isnan(F['pace'][a]) else float('nan'); newp[tr].append(pace5)
                cut33 = float(np.percentile(ph[tr][-KEEP:], 100 / 3)) if len(ph[tr][-KEEP:]) >= MINH else None; cut10 = float(np.percentile(ph[tr][-KEEP:], 10)) if len(ph[tr][-KEEP:]) >= MINH else None
                if cut33 is None: cnt[(tr, 'burnin')] += 1; continue
                oc = SH.calc_outcome(en, o, h, l, c, a, s, float(etr[a]), lim, n, n0=n0)
                if oc is None or isinstance(oc, tuple): cnt[(tr, 'dropped')] += 1; continue
                rows.append(dict(date=S['date'], track=tr, k=int(e['k']), end_sec=float(e['end_sec']), dir=s, adr20=round(adr20, 2), defended=int(e['flag']['defended']), pivot_live=int(e['flag']['pivot_live']), pace5=round(pace5, 4), pace_a=round(pace_a, 4) if pace_a == pace_a else '', dur_min5=round(float(np.nanmin(dw)), 2), dur_a=round(float(F['dur'][a]), 2),
                                 fast=int(pace5 <= cut33), fast10=int(cut10 is not None and pace5 <= cut10), fwd=oc['fwd'], net_stop=oc['net_stop25']))
        for tr in ('RTH', 'GBX'): ph[tr] += newp[tr]
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    with open(os.path.join(OUT, 'events_speed.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print('dropped / burn-in', dict(cnt))
    for tr in ('RTH', 'GBX'):
        r = [x for x in rows if x['track'] == tr]; print(f'  {tr}: {len(r)} climaxes scored, extreme-fast {sum(x["fast"] for x in r)} on {len({x["date"] for x in r if x["fast"]})} days, fastest decile {sum(x["fast10"] for x in r)}')

def load():
    return [dict(date=r['date'], track=r['track'], dir=int(r['dir']), adr20=float(r['adr20']), defended=int(r['defended']), pivot_live=int(r['pivot_live']), pace5=float(r['pace5']), dur_min5=float(r['dur_min5']), dur_a=float(r['dur_a']), fast=int(r['fast']), fast10=int(r['fast10']), fwd=float(r['fwd']), net_stop=float(r['net_stop'])) for r in csv.DictReader(open(os.path.join(OUT, 'events_speed.csv')))]

TESTS = [(tr, nm) for tr in ('RTH', 'GBX') for nm in ('T1-EXIT-VALUE-FAST', 'T2-BOUNCE-NET-FAST', 'T3-FAST-MINUS-NOTFAST')]; assert len(TESTS) == 6
def cells(ev, cost, draws, flip=None):
    res = {}
    for k, (tr, nm) in enumerate(TESTS):
        e = [x for x in ev if x['track'] == tr]; v = lambda x, c: -x['fwd'] * (flip[x['date']] if flip else 1) - c; seed = 1500 + k
        fa = [(x['date'], v(x, cost if nm.startswith('T2') else 0.0)) for x in e if x['fast']]; no = [(x['date'], v(x, 0.0)) for x in e if not x['fast']]
        if nm.startswith('T3'): ok = len(fa) >= G.MIN_N and len(no) >= G.MIN_N and len({d for d, _ in fa}) >= G.MIN_DAYS; res[(tr, nm)] = G.boot_diff(fa, no, seed, draws) if ok else None
        else: ok = len(fa) >= G.MIN_N and len({d for d, _ in fa}) >= G.MIN_DAYS; res[(tr, nm)] = G.boot_mean(fa, seed, draws) if ok else None
    return res

def null_gate(iters=1000, alpha=0.10, seed=788):
    ev = load(); dates = sorted({x['date'] for x in ev}); rng = np.random.default_rng(seed); passes = 0
    for it in range(iters):
        flip = {d: int(rng.choice([-1, 1])) for d in dates}; keep, m = G.holm(cells(ev, 0.0, 1000, flip), alpha); passes += bool(keep)
    rate = passes / iters; print(f'NULL GATE: 6 tests, {iters} iterations, Holm {alpha}: family-wise false-pass {rate:.3f} (required <= 0.10)'); json.dump(dict(rate=rate, ok=rate <= 0.10, alpha=alpha, iters=iters), open(os.path.join(OUT, 'null_gate.json'), 'w'))

def run():
    ng = json.load(open(os.path.join(OUT, 'null_gate.json'))); assert ng['ok']; ALPHA = ng['alpha']; ev = load(); res = cells(ev, G.COST, G.B); keep, m = G.holm(res, ALPHA)
    print(f'COUNTED: 6 tests ({m} passed the gate), Holm {ALPHA} survivors: {sorted(keep) or "none"}')
    for (tr, nm) in TESTS:
        r = res[(tr, nm)]
        if r is None: print(f'  {tr} {nm:24s} PARKED (gate: >= 100 events and >= 60 days)'); continue
        sub = [x for x in ev if x['track'] == tr]
        print(f'  {tr} {nm:24s} N {r["n"]:4d} days {r["days"]:4d}  {r["mean"]:+7.2f} [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} t {r["t"]:+.2f} MDE {G.mde(r, sub):.4f}  Holm {"PASS" if (tr, nm) in keep else "no"}')
    json.dump(dict(survivors=[list(k) for k in sorted(keep)], res={'_'.join(k): v for k, v in res.items()}), open(os.path.join(OUT, 'summary.json'), 'w'), indent=1)
    print('\nDESCRIPTIVE (never counted). v = exit value = minus the 30-bar stay-in change (pre-cost); positive = staying in lost')
    for tr in ('RTH', 'GBX'):
        e = [x for x in ev if x['track'] == tr]
        for lab, f in (('all', lambda x: True), ('EXTREME-FAST (lowest tercile)', lambda x: x['fast'] == 1), ('not fast', lambda x: x['fast'] == 0), ('fastest decile', lambda x: x['fast10'] == 1), ('strict defended pivot', lambda x: x['defended'] == 1)):
            sub = [x for x in e if f(x)]
            if len(sub) >= 5: print(f'  {tr} {lab:30s} N {len(sub):4d} exit value {np.mean([-x["fwd"] for x in sub]):+7.2f} median {np.median([-x["fwd"] for x in sub]):+7.2f} | bar seconds: fastest-bar median {np.median([x["dur_min5"] for x in sub]):.1f} s, climax-bar median {np.median([x["dur_a"] for x in sub]):.1f} s')
        pc = np.array([x['pace5'] for x in e]); qs = np.quantile(pc, [0, 1 / 3, 2 / 3, 1]); print(f'  {tr} dose-response by PACE5 tercile of the whole sample (fast, mid, slow): ' + ', '.join(f'{np.mean([-x["fwd"] for x in e if lo <= x["pace5"] <= hi]):+.2f} (N {sum(1 for x in e if lo <= x["pace5"] <= hi)})' for lo, hi in ((qs[0], qs[1]), (qs[1], qs[2]), (qs[2], qs[3]))))
        fs = [x for x in e if x['fast']]
        if len(fs) >= 10:
            ds = sorted({x['date'] for x in fs}); th = [np.mean([-x['fwd'] for x in fs if x['date'] in set(q)]) for q in np.array_split(np.array(ds), 3)]
            yrs = ', '.join(f'{y} {np.mean([-x["fwd"] for x in fs if x["date"][:4] == y]):+.2f} (N {sum(1 for x in fs if x["date"][:4] == y)})' for y in sorted({x["date"][:4] for x in fs}))
            print(f'     {tr} extreme-fast thirds {[round(float(q), 2) for q in th]} | by year {yrs}')

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'build': build()
    elif st == 'null': null_gate(int(sys.argv[2]) if len(sys.argv) > 2 else 1000, float(sys.argv[3]) if len(sys.argv) > 3 else 0.10, int(sys.argv[4]) if len(sys.argv) > 4 else 788)
    elif st == 'run': run()
    else: print(__doc__)
