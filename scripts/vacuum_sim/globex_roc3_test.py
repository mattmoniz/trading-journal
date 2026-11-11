"""Row 36 (prereg docs/GLOBEX_ROC3_VACUUM_PREREG_20261110.md): the live vacuum rule on the Globex track with ROC length 10 (arm A) against 3 (arm B). Same code path as the live shadow: v2.continuous + v2.feats with features.L_ROC set,
shadow.calc_outcome for the 30-bar hold. Stages: build (events + outcomes to a CSV, prints COUNTS only), null (sign-flip Monte Carlo of the statistics pipeline), run (the 5 counted tests + descriptives; the look is logged first by
scripts/log_look_globex_roc3.mjs), validate (event keys of arm A against vacuum_live_events for one live date; no outcome compared).
Usage: globex_roc3_test.py build|null|run|validate [date]"""
import os, sys, glob, csv, json, collections, datetime
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(ROOT, 'scripts', 'vacuum_live'))
import features as Fm
import v2
import shadow as SH           # the live module: calc_outcome, onset (hr-022: reuse, never re-implement)
OUT = os.path.join(ROOT, 'scratch', 'globex_roc3_20261110'); os.makedirs(OUT, exist_ok=True)
GBX_END, LIM, HOLD, COST, B = 55500.0, 55790.0, 30, 2.0, 3000
SEEDS = dict(T1=201, T2=202, T3=203, T4=204, T5=205); MIN_N, MIN_DAYS = 100, 60

def arm_events(P, n0, F, etr, close, hold=None):
    """Mirror of shadow.Live.analyse for the GBX track: onset of (|Z| > Z_ROC and sign(Z) == sign(ROC)), window = current session and bar END <= 09:25 ET, one position at a time (30-bar lock). Returns candidate list + the baseline bars."""
    n = len(P['c']); en = P['en']; idx = np.arange(n); z = F['zroc']; roc = F['roc']
    ok = (idx >= n0) & ~np.isnan(z); prev_ok = np.r_[False, ~np.isnan(z[:-1])]; dd = np.where(roc > 0, 1, np.where(roc < 0, -1, 0))
    c0u = ~np.isnan(z) & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd); on0 = SH.onset(c0u) & prev_ok
    gw = ok & (en <= GBX_END); out = []; lock = -1; hold = HOLD if hold is None else hold      # hold = the lock length in bars (row 39 passes its own; default = the live 30)
    for a in np.where(on0 & gw)[0]:
        taken = a >= lock
        if taken: lock = a + hold
        out.append(dict(a=int(a), k=int(a - n0), dr=int(dd[a]), taken=bool(taken)))
    return out, gw & (dd != 0), dd

def build():
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None; rows = []; base = []; ns = collections.Counter(); noentry = collections.Counter()
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2:
            rt = hist['RTH'][-20:]; adr20 = float(np.mean([T['h'].max() - T['l'].min() for T in rt])) if len(rt) >= 10 else float('nan')
            P, n0, reset = v2.continuous(prevS, S); n = len(P['c']); ns[S['date'][:4]] += 1
            for arm, L in (('A10', 10), ('B3', 3)):
                Fm.L_ROC = L
                try: F = v2.feats(P, n0, reset, prs, close)
                finally: Fm.L_ROC = 10
                etr = Fm.ema(F['tr']); evs, bmask, dd = arm_events(P, n0, F, etr, close)
                en, o, h, l, c = P['en'], P['o'], P['h'], P['l'], P['c']
                for e in evs:
                    hr = int(Fm.hour_et(np.array([en[e['a']]]))[0]); r = dict(date=S['date'], arm=arm, k=e['k'], dr=e['dr'], taken=int(e['taken']), hour=hr, first30=int(en[e['a']] <= 1800.0), adr20=round(adr20, 2), fwd='', net='', net_stop='', mfe='', mae='', note='')
                    if e['taken']:
                        oc = SH.calc_outcome(en, o, h, l, c, e['a'], e['dr'], float(etr[e['a']]), LIM, n, n0=n0)
                        if oc is None or isinstance(oc, tuple): noentry[arm] += 1; continue
                        r.update(fwd=oc['fwd'], net=oc['net_nostop'], net_stop=oc['net_stop25'], mfe=oc['mfe'], mae=oc['mae'], note=oc['note'])
                    rows.append(r)
                # unconditional continuation baseline: every in-window bar with a full 30-bar path inside the Globex session, signed by this arm's ROC sign, entry Open[a+1], exit Close[a+30]
                inside = np.where((en <= LIM) & (np.arange(n) >= n0))[0]; flat = int(inside.max()) if len(inside) else -1
                for a in np.where(bmask & (np.arange(n) >= n0))[0]:
                    if a + HOLD <= flat: base.append((S['date'], arm, int(dd[a]) * (float(c[a + HOLD]) - float(o[a + 1]))))
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    with open(os.path.join(OUT, 'events.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    with open(os.path.join(OUT, 'baseline.csv'), 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['date', 'arm', 'fwd']); w.writerows(base)
    print('sessions scored per year', dict(ns), 'NOENTRY dropped', dict(noentry))
    for arm in ('A10', 'B3'):
        r = [x for x in rows if x['arm'] == arm]; t = [x for x in r if x['taken']]; tt = [x for x in t if x['net'] != '']
        print(f'{arm}: candidates {len(r)}, taken {len(t)}, scored {len(tt)} on {len({x["date"] for x in tt})} days')

def load():
    ev = list(csv.DictReader(open(os.path.join(OUT, 'events.csv')))); out = []
    for r in ev:
        if r['taken'] == '1' and r['net'] != '':
            out.append(dict(date=r['date'], arm=r['arm'], dr=int(r['dr']), hour=int(r['hour']), first30=int(r['first30']), adr20=float(r['adr20']), fwd=float(r['fwd']), net_stop=float(r['net_stop']), mfe=float(r['mfe']), mae=float(r['mae'])))
    return out

def hour_groups():
    """The 15 Globex ET hours ranked by the median bar duration of the explore Globex bars (a property of the clock, outcome-free). 5 slowest = SLOW, 5 fastest = FAST."""
    d = collections.defaultdict(list)
    for p in sorted(glob.glob(os.path.join(Fm.BARS, '*.bars.tsv'))):
        if os.path.basename(p)[:10] > Fm.LAST_EXPLORE: continue
        S = Fm.load_full(p)
        if S is None: continue
        m = S['en'] <= GBX_END; hr = Fm.hour_et(S['en'][m]); du = (S['en'] - S['st'])[m]
        for h_, x in zip(hr, du): d[int(h_)].append(x)
    med = {h_: float(np.median(v)) for h_, v in d.items() if h_ in (18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8)}
    order = sorted(med, key=lambda h_: -med[h_]); assert len(order) == 15, order
    return {'SLOW': set(order[:5]), 'MID': set(order[5:10]), 'FAST': set(order[10:])}, med

def by_day(vals):
    """vals: list of (date, value). Returns dates, per-day sum, per-day n."""
    d = collections.defaultdict(lambda: [0.0, 0])
    for dt, v in vals: d[dt][0] += v; d[dt][1] += 1
    ds = sorted(d); return ds, np.array([d[x][0] for x in ds]), np.array([d[x][1] for x in ds], float)

def boot_mean(vals, seed, draws=B):
    """one-sided day-blocked bootstrap of sum/N > 0. Returns dict(mean, lo, hi, p, n, days, t, se)."""
    ds, S, N = by_day(vals)
    if N.sum() == 0: return None
    rng = np.random.default_rng(seed); idx = rng.integers(0, len(ds), (draws, len(ds))); m = S[idx].sum(1) / np.maximum(N[idx].sum(1), 1)
    mean = S.sum() / N.sum(); se = float(m.std()); return dict(mean=float(mean), lo=float(np.quantile(m, .025)), hi=float(np.quantile(m, .975)), p=float((1 + (m <= 0).sum()) / (draws + 1)), n=int(N.sum()), days=len(ds), t=float(mean / se) if se > 0 else float('nan'), se=se)

def boot_diff(a, b, seed, draws=B):
    dates = sorted({x[0] for x in a} | {x[0] for x in b}); pos = {d_: i for i, d_ in enumerate(dates)}; A = np.zeros((len(dates), 2)); Bm = np.zeros((len(dates), 2))
    for d_, v in a: A[pos[d_]] += (v, 1)
    for d_, v in b: Bm[pos[d_]] += (v, 1)
    if A[:, 1].sum() == 0 or Bm[:, 1].sum() == 0: return None
    rng = np.random.default_rng(seed); idx = rng.integers(0, len(dates), (draws, len(dates)))
    sa, na, sb, nb = A[idx, 0].sum(1), A[idx, 1].sum(1), Bm[idx, 0].sum(1), Bm[idx, 1].sum(1); ok = (na > 0) & (nb > 0); m = sa[ok] / na[ok] - sb[ok] / nb[ok]
    mean = A[:, 0].sum() / A[:, 1].sum() - Bm[:, 0].sum() / Bm[:, 1].sum(); se = float(m.std())
    return dict(mean=float(mean), lo=float(np.quantile(m, .025)), hi=float(np.quantile(m, .975)), p=float((1 + (m <= 0).sum()) / (len(m) + 1)), n=int(A[:, 1].sum()), nb=int(Bm[:, 1].sum()), days=len(dates), t=float(mean / se) if se > 0 else float('nan'), se=se)

def counted(ev, groups, cost, draws=B, flip=None):
    """The 5 counted tests. ev: scored events; flip: {date: +-1} (null gate). Returns {name: result or None (parked)}."""
    def sg(x): return x['fwd'] * (flip[x['date']] if flip else 1)
    bB = [x for x in ev if x['arm'] == 'B3']; bA = [x for x in ev if x['arm'] == 'A10']
    cells = dict(
        T1=('mean', [(x['date'], sg(x) - cost) for x in bB]),
        T2=('mean', [(x['date'], -sg(x) - cost) for x in bB]),
        T3=('diff', [(x['date'], sg(x)) for x in bB], [(x['date'], sg(x)) for x in bA]),
        T4=('mean', [(x['date'], sg(x) - cost) for x in bB if x['hour'] in groups['SLOW']]),
        T5=('mean', [(x['date'], sg(x) - cost) for x in bB if x['hour'] in groups['FAST']]))
    assert len(cells) == 5
    res = {}
    for name, c in cells.items():
        v = c[1]
        if len(v) < MIN_N or len({d_ for d_, _ in v}) < MIN_DAYS or (c[0] == 'diff' and (len(c[2]) < MIN_N)): res[name] = None; continue
        res[name] = boot_diff(c[1], c[2], SEEDS[name], draws) if c[0] == 'diff' else boot_mean(v, SEEDS[name], draws)
    return res

def holm(res, alpha=0.10):
    live = sorted((r['p'], n) for n, r in res.items() if r is not None); m = len(live); keep = set()
    for rank, (p, n) in enumerate(live):
        if p <= alpha / (m - rank): keep.add(n)
        else: break
    return keep, m

def roll_dates():
    skip = set(json.load(open(os.path.join(ROOT, 'scratch', 'capitulation_replay_20261109', 'roll_week_dates.json')))); prev = None
    for p in sorted(glob.glob(os.path.join(Fm.BARS, '*.bars.tsv'))):
        if os.path.basename(p)[:10] > Fm.LAST_EXPLORE: continue
        S = Fm.load_full(p)
        if S is None: continue
        if prev is not None and abs(S['o'][0] - prev['c'][-1]) > 150:
            d0 = datetime.date.fromisoformat(S['date'])
            for k in range(-5, 2): skip.add((d0 + datetime.timedelta(days=k)).isoformat())
        prev = S
    return skip

def null_gate(iters=200):
    ev = load(); groups, _ = hour_groups(); dates = sorted({x['date'] for x in ev}); rng = np.random.default_rng(777); passes = 0; fam = []
    for it in range(iters):
        flip = {d_: int(rng.choice([-1, 1])) for d_ in dates}; res = counted(ev, groups, 0.0, draws=1000, flip=flip); keep, m = holm(res); passes += bool(keep); fam.append(sorted(keep))
    rate = passes / iters; print(f'NULL GATE: {iters} iterations (day sign flips, cost 0, 1000 draws), family-wise false-pass rate {rate:.3f} (required <= 0.10); cells that passed: {collections.Counter(sum(fam, []))}')
    json.dump(dict(iters=iters, rate=rate, ok=rate <= 0.10), open(os.path.join(OUT, 'null_gate.json'), 'w')); return rate

def mde(r, ev_cell):
    adr = float(np.mean([x['adr20'] for x in ev_cell if x['adr20'] == x['adr20']])) if ev_cell else float('nan')
    return 2.93 * r['se'] / adr if adr == adr and adr > 0 else float('nan')

def run():
    assert json.load(open(os.path.join(OUT, 'null_gate.json')))['ok'], 'null gate not passed'
    ev = load(); groups, med = hour_groups(); print('hour groups (ET hour: median bar s):', {k: sorted(v) for k, v in groups.items()}, {h_: round(m, 0) for h_, m in sorted(med.items())})
    res = counted(ev, groups, COST); keep, m = holm(res); bB = [x for x in ev if x['arm'] == 'B3']; bA = [x for x in ev if x['arm'] == 'A10']
    cell_ev = dict(T1=bB, T2=bB, T3=bB, T4=[x for x in bB if x['hour'] in groups['SLOW']], T5=[x for x in bB if x['hour'] in groups['FAST']])
    print(f'\nCOUNTED (cost {COST} pt; points; Holm 0.10 over m={m} cells that passed the gate)')
    names = dict(T1='ROC3 continuation net', T2='ROC3 reversion net', T3='ROC3 - ROC10 signed 30-bar change (pre-cost)', T4='ROC3 continuation net, SLOW hours', T5='ROC3 continuation net, FAST hours')
    for k in ('T1', 'T2', 'T3', 'T4', 'T5'):
        r = res[k]
        if r is None: print(f'  {k} {names[k]}: PARKED (gate: >= {MIN_N} events and >= {MIN_DAYS} days)'); continue
        print(f'  {k} {names[k]}: {r["mean"]:+.2f} pt [{r["lo"]:+.2f}, {r["hi"]:+.2f}] one-sided p {r["p"]:.4f} t {r["t"]:+.2f} N {r["n"]} ({r["days"]} days) MDE {mde(r, cell_ev[k]):.4f} ADR20  Holm {"PASS" if k in keep else "no"}')
    json.dump(dict(res=res, holm=sorted(keep), m=m), open(os.path.join(OUT, 'summary.json'), 'w'), indent=1)
    print('\nDESCRIPTIVE (never counted)')
    def line(label, vals):
        r = boot_mean(vals, 11)
        if r: print(f'  {label}: {r["mean"]:+.2f} [{r["lo"]:+.2f}, {r["hi"]:+.2f}] N {r["n"]} days {r["days"]}')
        else: print(f'  {label}: none')
    for arm, sub in (('A10', bA), ('B3', bB)):
        line(f'{arm} continuation net (all Globex)', [(x['date'], x['fwd'] - COST) for x in sub]); line(f'{arm} reversion net', [(x['date'], -x['fwd'] - COST) for x in sub])
        line(f'{arm} continuation net with the V0 2.5xEMA10(TR) stop', [(x['date'], x['net_stop']) for x in sub])
        for g in ('SLOW', 'MID', 'FAST'): line(f'{arm} continuation net {g} hours', [(x['date'], x['fwd'] - COST) for x in sub if x['hour'] in groups[g]])
        line(f'{arm} continuation net excluding the first 30 min after 18:00', [(x['date'], x['fwd'] - COST) for x in sub if not x['first30']])
        rd = roll_dates(); line(f'{arm} continuation net excluding roll weeks', [(x['date'], x['fwd'] - COST) for x in sub if x['date'] not in rd])
        ds = sorted({x['date'] for x in sub}); thirds = np.array_split(np.array(ds), 3)
        print(f'  {arm} thirds (chronological, continuation net, points): ' + ' | '.join(f'{np.mean([x["fwd"] - COST for x in sub if x["date"] in set(t)]):+.2f} (N {sum(1 for x in sub if x["date"] in set(t))})' for t in thirds))
        print(f'  {arm} by year: ' + ', '.join(f'{y}: {np.mean([x["fwd"] - COST for x in sub if x["date"][:4] == y]):+.2f} (N {sum(1 for x in sub if x["date"][:4] == y)})' for y in sorted({x["date"][:4] for x in sub})))
        cnt = collections.Counter(x['date'] for x in sub); top5 = sum(v for _, v in cnt.most_common(5)) / max(len(sub), 1); print(f'  {arm} top-5-days share of N: {top5:.3f}; events per session {len(sub) / max(len({x["date"] for x in sub}), 1):.2f}')
    base = collections.defaultdict(list)
    for r in csv.DictReader(open(os.path.join(OUT, 'baseline.csv'))): base[r['arm']].append((r['date'], float(r['fwd'])))
    for arm, sub in (('A10', bA), ('B3', bB)):
        bm = np.mean([v for _, v in base[arm]]); em = np.mean([x['fwd'] for x in sub]); print(f'  {arm} baseline (every in-window bar, same sign rule, 30 bars, pre-cost) {bm:+.2f} pt over {len(base[arm])} bars; events pre-cost {em:+.2f}; event minus baseline {em - bm:+.2f}')

def validate(date):
    import persist
    # arm A events for one live date from the live priors folder, compared by key (bar_idx, direction, taken) to vacuum_live_events GBX; NO outcome compared
    PRI = os.path.join(ROOT, 'scratch', 'argon_vacuum_live', 'priors'); files = sorted(f for f in glob.glob(os.path.join(PRI, '*.bars.tsv')) if os.path.basename(f)[:10] < date)[-24:]
    hist = {'RTH': [], 'GBX': []}; prev = None
    for f in files:
        S = Fm.load_full(f)
        if S is None: continue
        for name, T in Fm.track_split(S).items(): hist[name].append(T)
        prev = S
    cur = Fm.load_full(os.path.join(PRI, f'{date}.bars.tsv')); close = Fm.EARLY_CLOSE if date in Fm.EARLY else Fm.CLOSE
    prs = {n: Fm.priors_of(hist[n][-Fm.K_PRIOR:]) for n in ('RTH', 'GBX')}; P, n0, reset = v2.continuous(prev, cur); F = v2.feats(P, n0, reset, prs, close); etr = Fm.ema(F['tr']); evs, _, _ = arm_events(P, n0, F, etr, close)
    mine = {(e['k'], e['dr'], e['taken']) for e in evs}
    cu = persist.connect().cursor(); cu.execute("select bar_idx, direction, taken from vacuum_live_events where trade_date=%s and track='GBX'", (date,)); live = {(int(a), int(b), bool(c)) for a, b, c in cu.fetchall()}
    print(f'validate {date}: mine {len(mine)} live {len(live)} identical {mine == live}; only mine {sorted(mine - live)}; only live {sorted(live - mine)}')

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'build': build()
    elif st == 'null': null_gate()
    elif st == 'run': run()
    elif st == 'validate': validate(sys.argv[2])
    else: print(__doc__)
