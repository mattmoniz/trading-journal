"""Row 42 (prereg docs/CAPITULATION_DEFENDED_REENGAGE_PREREG_20261110.md): capitulation climax at a defended pivot, BOUNCE vs CONTINUE vs RESUME.
Stages: events (outcome-blind: the climax list) | check DATE (parity with the live turn_signal_events table, keys only) | (later: null | run).
Reuses globex_roc3_test (Fm, v2, SH), turn_signal.turn_events, the live ext_cut rule (67th percentile of earlier Stage-1 extensions, last 600, >= 60)."""
import os, sys, csv, glob, json, collections, datetime
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import globex_roc3_test as G
import turn_signal as TS
Fm, v2, SH = G.Fm, G.v2, G.SH
OUT = os.path.join(G.ROOT, 'scratch', 'capitulation_reengage_20261110'); os.makedirs(OUT, exist_ok=True)
LOCK, MINCUT, KEEP = 30, 60, 600

def ts_et(date, sec):
    d = datetime.date.fromisoformat(date); t0 = datetime.datetime(d.year, d.month, d.day, 18, 0, 0) - datetime.timedelta(days=1)
    return (t0 + datetime.timedelta(seconds=float(sec))).strftime('%Y-%m-%d %H:%M:%S')

def session_events(S, hist, s1_hist, adr20):
    """S: session dict; hist: {'RTH': [...], 'GBX': [...]} prior track-sessions; s1_hist: {'RTH': [ext...], 'GBX': [...]} earlier sessions' Stage-1 extensions. Returns (climaxes, this session's S1 ext values per track, P, n0, F10) or None."""
    prs = {}
    for name in ('RTH', 'GBX'):
        prev = hist[name][-Fm.K_PRIOR:]
        if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
    if len(prs) < 2: return None
    return prs

def build_events():
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; s1_hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []; counts = collections.Counter()
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = session_events(S, hist, s1_hist, None)
        if prs is not None:
            rt = hist['RTH'][-20:]; adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt])) if len(rt) >= 10 else None
            P, n0, reset = v2.continuous(prevS, S); Fm.L_ROC = 10; F = v2.feats(P, n0, reset, prs, close); en, h, l = P['en'], P['h'], P['l']
            F['etr'] = Fm.ema(F['tr']); evs = TS.turn_events(P, n0, F, close, adr20); cuts = {tr: (float(np.percentile(s1_hist[tr][-KEEP:], 67)) if len(s1_hist[tr][-KEEP:]) >= MINCUT else None) for tr in ('RTH', 'GBX')}; lock = {'RTH': -1, 'GBX': -1}
            for e in evs:
                if e['kind'] != 'S1_SPIKE' or e['ext'] is None or np.isnan(e['ext']): continue
                tr, a = e['track'], e['a']; counts[(tr, 'spikes')] += 1
                if tr == 'GBX' and en[a] < 1800.0: continue
                if cuts[tr] is None: counts[(tr, 'burnin')] += 1; continue
                if e['ext'] < cuts[tr] or a < lock[tr]: continue
                lock[tr] = a + LOCK; counts[(tr, 'climax')] += 1
                ext_px = float(h[a] if e['dir'] > 0 else l[a]); ext5 = float(h[max(a - 4, n0):a + 1].max() if e['dir'] > 0 else l[max(a - 4, n0):a + 1].min())
                rows.append(dict(date=S['date'], track=tr, k=int(a - n0), dir=int(e['dir']), ext=round(float(e['ext']), 4), cut=round(cuts[tr], 4), strict=int(bool(e['strict'])), end_sec=round(float(en[a]), 3), ts_et=ts_et(S['date'], en[a]), px=ext_px, px5=ext5))
            for e in evs:                                     # this session's Stage-1 extensions feed LATER sessions' cutoffs only
                if e['kind'] in ('S1_CLUSTER', 'S1_SPIKE') and e['ext'] is not None and not np.isnan(e['ext']): s1_hist[e['track']].append(float(e['ext']))
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    with open(os.path.join(OUT, 'events_raw.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print('climaxes', {tr: sum(1 for r in rows if r['track'] == tr) for tr in ('RTH', 'GBX')}, 'raw counts', {f'{a}|{b}': v for (a, b), v in sorted(counts.items())})
    for tr in ('RTH', 'GBX'):
        r = [x for x in rows if x['track'] == tr]; print(f'  {tr}: {len(r)} climaxes on {len({x["date"] for x in r})} days; by year', dict(collections.Counter(x['date'][:4] for x in r)), 'strict', sum(x['strict'] for x in r))

def check(date):
    """Parity of the S1_SPIKE / S1_CLUSTER / S2 events (tr, bar, kind, dir) of one live date against turn_signal_events; keys only, no outcome."""
    import persist
    PRI = os.path.join(G.ROOT, 'scratch', 'argon_vacuum_live', 'priors'); files = sorted(f for f in glob.glob(os.path.join(PRI, '*.bars.tsv')) if os.path.basename(f)[:10] < date)[-24:]
    hist = {'RTH': [], 'GBX': []}; prev = None
    for f in files:
        S = Fm.load_full(f)
        if S is None: continue
        for name, T in Fm.track_split(S).items(): hist[name].append(T)
        prev = S
    cur = Fm.load_full(os.path.join(PRI, f'{date}.bars.tsv')); close = Fm.EARLY_CLOSE if date in Fm.EARLY else Fm.CLOSE; prs = {n: Fm.priors_of(hist[n][-Fm.K_PRIOR:]) for n in ('RTH', 'GBX')}
    rt = hist['RTH'][-20:]; adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt])); P, n0, reset = v2.continuous(prev, cur); Fm.L_ROC = 10; F = v2.feats(P, n0, reset, prs, close); F['etr'] = Fm.ema(F['tr'])
    mine = {(e['track'], e['a'] - n0, e['kind'], e['dir']) for e in TS.turn_events(P, n0, F, close, adr20)}
    cu = persist.connect().cursor(); cu.execute("select track, bar_idx, kind, direction from turn_signal_events where trade_date=%s", (date,)); live = {(a, int(b), c, int(d)) for a, b, c, d in cu.fetchall()}
    print(f'check {date}: mine {len(mine)} live {len(live)} identical {mine == live}; only mine {sorted(mine - live)[:6]}; only live {sorted(live - mine)[:6]}')


# ---------------------------------------------------------------- outcomes (stage C): arms, stats
ARMS = ('BOUNCE', 'CONTINUE', 'RESUME'); B_DRAWS = 3000
def load_flags():
    fl = {(r['date'], r['track'], int(r['k'])): r for r in csv.DictReader(open(os.path.join(OUT, 'events_flags.csv')))}
    return [dict(r, flag=fl[(r['date'], r['track'], int(r['k']))]) for r in csv.DictReader(open(os.path.join(OUT, 'events_raw.csv')))]

def build_outcomes():
    ev = load_flags(); by_date = collections.defaultdict(list)
    for e in ev: by_date[e['date']].append(e)
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []; drops = collections.Counter()
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE
        if S['date'] in by_date:
            prs = {n: Fm.priors_of(hist[n][-Fm.K_PRIOR:]) for n in ('RTH', 'GBX')}; rt = hist['RTH'][-20:]; adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt]))
            P, n0, reset = v2.continuous(prevS, S); n = len(P['c']); Fm.L_ROC = 10; F10 = v2.feats(P, n0, reset, prs, close); Fm.L_ROC = 3
            try: F3 = v2.feats(P, n0, reset, prs, close)
            finally: Fm.L_ROC = 10
            etr = Fm.ema(F10['tr']); en, o, h, l, c = P['en'], P['o'], P['h'], P['l'], P['c']; z3 = F3['zroc']
            for e in by_date[S['date']]:
                s = int(e['dir']); a = n0 + int(e['k']); tr = e['track']; lim = G.LIM if tr == 'GBX' else close - 300.0; wend = 55500.0 if tr == 'GBX' else close - 600.0
                x1 = float(e['px5']); j10 = slice(a + 1, min(a + 11, n)); held = int((l[j10].min() >= x1 - 0.5 * etr[a]) if s < 0 else (h[j10].max() <= x1 + 0.5 * etr[a])) if a + 1 < n else 1
                base = dict(date=S['date'], track=tr, defended=int(e['flag']['defended']), pivot_live=int(e['flag']['pivot_live']), strict=int(e['strict']), hour=int(Fm.hour_et(np.array([e['end_sec']], float))[0]), ext=float(e['ext']), adr20=adr20, held10=held)
                for arm, dr in (('BOUNCE', -s), ('CONTINUE', s)):
                    oc = SH.calc_outcome(en, o, h, l, c, a, dr, float(etr[a]), lim, n, n0=n0)
                    if oc is None or isinstance(oc, tuple): drops[(tr, arm)] += 1; continue
                    rows.append(dict(base, arm=arm, dr=dr, fwd=oc['fwd'], net_stop=oc['net_stop25'], px_exit=float(o[a + 1]), px_entry=float(o[a + 1])))
                started = False; trig = None
                for j in range(a + 1, min(a + LOCK, n - 2) + 1):
                    if en[j] > wend or np.isnan(z3[j]): break
                    m = -s * z3[j]
                    if not started:
                        if m > 0: started = True
                    elif m <= 0: trig = j; break
                if trig is None: drops[(tr, 'RESUME-no-trigger')] += 1; continue
                oc = SH.calc_outcome(en, o, h, l, c, trig, s, float(etr[trig]), lim, n, n0=n0)
                if oc is None or isinstance(oc, tuple): drops[(tr, 'RESUME')] += 1; continue
                rows.append(dict(base, arm='RESUME', dr=s, fwd=oc['fwd'], net_stop=oc['net_stop25'], px_exit=float(o[a + 1]), px_entry=float(o[trig + 1])))
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    with open(os.path.join(OUT, 'outcomes.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print('rows by arm and track (counts only):', {f'{t}|{a}': sum(1 for r in rows if r['track'] == t and r['arm'] == a) for t in ('RTH', 'GBX') for a in ARMS}, 'drops', dict(drops))

def load_out():
    return [dict(date=r['date'], track=r['track'], defended=int(r['defended']), pivot_live=int(r['pivot_live']), strict=int(r['strict']), hour=int(r['hour']), adr20=float(r['adr20']), held10=int(r['held10']), arm=r['arm'], fwd=float(r['fwd']), net_stop=float(r['net_stop']), dr=int(r['dr']), px_exit=float(r['px_exit']), px_entry=float(r['px_entry'])) for r in csv.DictReader(open(os.path.join(OUT, 'outcomes.csv')))]

TESTS = [(tr, nm) for tr in ('RTH', 'GBX') for nm in ('D-BOUNCE', 'D-CONTINUE', 'D-RESUME', 'D-DIFF')] + [(tr, nm) for tr in ('RTH', 'GBX') for nm in ('A-BOUNCE', 'A-CONTINUE', 'A-RESUME')]; assert len(TESTS) == 14
def cells(ev, cost, draws, flip=None):
    res = {}
    for k, (tr, nm) in enumerate(TESTS):
        sub = lambda arm, d=None: [x for x in ev if x['track'] == tr and x['arm'] == arm and (d is None or x['defended'] == d)]
        val = lambda xs: [(x['date'], x['fwd'] * (flip[x['date']] if flip else 1) - cost) for x in xs]
        kind, arm = nm.split('-'); arm = {'BOUNCE': 'BOUNCE', 'CONTINUE': 'CONTINUE', 'RESUME': 'RESUME', 'DIFF': 'BOUNCE'}[arm]
        if kind == 'D' and nm.endswith('DIFF'): a, b = val(sub('BOUNCE', 1)), val(sub('BOUNCE', 0)); n_ok = len(a) >= G.MIN_N and len(b) >= G.MIN_N and len({d for d, _ in a}) >= G.MIN_DAYS
        else: a = val(sub(arm, 1 if kind == 'D' else None)); b = None; n_ok = len(a) >= G.MIN_N and len({d for d, _ in a}) >= G.MIN_DAYS
        seed = 1100 + k
        res[(tr, nm)] = None if not n_ok else (G.boot_diff(a, b, seed, draws) if b is not None else G.boot_mean(a, seed, draws))
    return res

def null_gate(iters=1000, alpha=0.10, seed=786):
    ev = load_out(); dates = sorted({x['date'] for x in ev}); rng = np.random.default_rng(seed); passes = 0
    for it in range(iters):
        flip = {d: int(rng.choice([-1, 1])) for d in dates}; keep, m = G.holm(cells(ev, 0.0, 1000, flip), alpha); passes += bool(keep)
    rate = passes / iters; print(f'NULL GATE: 14 tests, {iters} iterations, Holm {alpha}: family-wise false-pass {rate:.3f} (required <= 0.10)'); json.dump(dict(rate=rate, ok=rate <= 0.10, alpha=alpha, iters=iters), open(os.path.join(OUT, 'null_gate.json'), 'w'))

def run():
    ng = json.load(open(os.path.join(OUT, 'null_gate.json'))); assert ng['ok']; ALPHA = ng['alpha']; ev = load_out(); res = cells(ev, G.COST, B_DRAWS); keep, m = G.holm(res, ALPHA)
    print(f'COUNTED: 14 tests ({m} passed the gate), cost {G.COST} pt, Holm {ALPHA} survivors: {sorted(keep) or "none"}')
    print('  track test         N    days   mean net [CI]   p    t  MDE')
    for (tr, nm) in TESTS:
        r = res[(tr, nm)]
        if r is None: print(f'  {tr} {nm:12s} PARKED (gate: >= 100 events and >= 60 days)'); continue
        sub = [x for x in ev if x['track'] == tr and x['arm'] == ('BOUNCE' if nm.endswith('DIFF') else nm.split('-')[1])]
        print(f'  {tr} {nm:12s} {r["n"]:5d} {r["days"]:4d}  {r["mean"]:+7.2f} [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} t {r["t"]:+.2f} MDE {G.mde(r, sub):.4f}  Holm {"PASS" if (tr, nm) in keep else "no"}')
    json.dump(dict(survivors=[list(k) for k in sorted(keep)], res={'_'.join(k): v for k, v in res.items()}), open(os.path.join(OUT, 'summary.json'), 'w'), indent=1)
    print('\nDESCRIPTIVE (never counted). pre-cost mean signed 30-bar change; CONTINUE pre-cost = the value of STAYING IN from the climax')
    for tr in ('RTH', 'GBX'):
        for arm in ARMS:
            for lab, f in (('ALL', lambda x: True), ('DEFENDED', lambda x: x['defended'] == 1), ('not defended', lambda x: x['defended'] == 0), ('pivot-live', lambda x: x['pivot_live'] == 1), ('strict', lambda x: x['strict'] == 1), ('held10', lambda x: x['held10'] == 1), ('not held10', lambda x: x['held10'] == 0)):
                sub = [x for x in ev if x['track'] == tr and x['arm'] == arm and f(x)]
                if len(sub) >= 5: print(f'  {tr} {arm:8s} {lab:13s} N {len(sub):4d}  pre-cost {np.mean([x["fwd"] for x in sub]):+7.2f}  median {np.median([x["fwd"] for x in sub]):+7.2f}  net {np.mean([x["fwd"] - G.COST for x in sub]):+7.2f}  V0-stop net {np.mean([x["net_stop"] for x in sub]):+7.2f}')
        for arm in ARMS:
            sub = [x for x in ev if x['track'] == tr and x['arm'] == arm]
            if not sub: continue
            ds = sorted({x['date'] for x in sub}); th = [np.mean([x['fwd'] - G.COST for x in sub if x['date'] in set(q)]) for q in np.array_split(np.array(ds), 3)]
            yrs = ', '.join(f'{y} {np.mean([x["fwd"] - G.COST for x in sub if x["date"][:4] == y]):+.2f} (N {sum(1 for x in sub if x["date"][:4] == y)})' for y in sorted({x["date"][:4] for x in sub})); cnt = collections.Counter(x['date'] for x in sub)
            print(f'  {tr} {arm:8s} thirds {[round(float(q), 2) for q in th]} | by year {yrs} | top-5-days share {sum(c_ for _, c_ in cnt.most_common(5)) / len(sub):.3f}')

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'events': build_events()
    elif st == 'check': check(sys.argv[2])
    elif st == 'outcomes': build_outcomes()
    elif st == 'null': null_gate(int(sys.argv[2]) if len(sys.argv) > 2 else 1000, float(sys.argv[3]) if len(sys.argv) > 3 else 0.10, int(sys.argv[4]) if len(sys.argv) > 4 else 786)
    elif st == 'run': run()
    else: print(__doc__)
