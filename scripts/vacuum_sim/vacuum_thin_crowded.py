"""Vacuum item 2 (docs/VACUUM_THIN_VS_CROWDED_PREREG_20261110.md): thrust pace (fast = crowded / institutional, slow = thin) vs the extra favourable run over a direction-blind placebo, RTH and Globex apart.
Stages: build (events to CSV, prints COUNTS only: no outcome) | null (sign-flip gate of the 4-cell pipeline) | run (counted cells + descriptives; the look is logged first by scripts/vacuum_sim/log_look_thin.mjs).
Usage: ulimit -v 4000000; venv/bin/python scripts/vacuum_sim/vacuum_thin_crowded.py build|null|run"""
import os, sys, csv, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import unified_exit_lock as U
import vacuum_take_look as T
G = U.G
OUT = os.path.join(U.ROOT, 'scratch', 'vacuum_thin_crowded_20261110'); os.makedirs(OUT, exist_ok=True)
KEEP, MINH, DRAWS = 600, 60, 10000; SEEDS = {('V_RTH', 'T1'): 3201, ('V_RTH', 'T2'): 3202, ('V_GBX', 'T1'): 3203, ('V_GBX', 'T2'): 3204}; MIN_N, MIN_DAYS = 100, 60

def build():
    rows = []; hist = {'V_RTH': [], 'V_GBX': []}; cnt = collections.Counter()
    for e in U.vacuum_onsets():
        pop = e['pop']; pw = e['pace_win']
        if np.all(np.isnan(pw)): cnt[(pop, 'no-pace')] += 1; continue
        tp = float(np.nanmean(pw)); h = hist[pop][-KEEP:]
        if len(h) < MINH: hist[pop].append(tp); cnt[(pop, 'burnin')] += 1; continue
        c33, c67 = float(np.percentile(h, 100 / 3)), float(np.percentile(h, 200 / 3)); hist[pop].append(tp)
        o, hh, l, c, ei, last, s, sd = e['o'], e['h'], e['l'], e['c'], e['ei'], e['last'], e['s'], e['sd']
        r = T.walk(o, hh, l, c, ei, last, s, sd); p = T.walk(o, hh, l, c, ei, last, -s, sd); cls = 'FAST' if tp <= c33 else ('SLOW' if tp >= c67 else 'MID')
        hr = int(U.Fm.hour_et(np.array([e['en'][e['a']]]))[0]); dmean = float(np.nanmean(e['dur_win']))
        rows.append(dict(date=e['date'], pop=pop, s=s, hour=hr, cls=cls, tp=round(tp, 4), dur=round(dmean, 2), sd=sd, extra=(r['mfe_pre'] - p['mfe_pre']) / 2.0 / sd, r_net=r['net_stop'], p_net=p['net_stop'], k1=(r['br'][1.0][0] - p['br'][1.0][0]) / 2.0))
        cnt[(pop, cls)] += 1
    with open(os.path.join(OUT, 'events.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    for pop in ('V_RTH', 'V_GBX'):
        d = {k[1]: v for k, v in cnt.items() if k[0] == pop}; days = {c: len({r['date'] for r in rows if r['pop'] == pop and r['cls'] == c}) for c in ('FAST', 'MID', 'SLOW')}
        print(f'{pop}: counts {d}; days per class {days}')
    return rows

def load():
    out = []
    for r in csv.DictReader(open(os.path.join(OUT, 'events.csv'))):
        for k in ('tp', 'dur', 'sd', 'extra', 'r_net', 'p_net', 'k1'): r[k] = float(r[k])
        r['s'] = int(r['s']); r['hour'] = int(r['hour']); out.append(r)
    return out

def two_sided(r):
    if r is None: return None
    d = DRAWS if r.get('draws') is None else r['draws']; p1 = r['p']; r['p'] = min(1.0, 2 * min(p1, 1 - p1 + 1.0 / (d + 1))); return r

def cells(rows, flip=None, draws=DRAWS):
    res = {}
    for pop in ('V_RTH', 'V_GBX'):
        R = [r for r in rows if r['pop'] == pop]; f = lambda r: r['extra'] * (flip[r['date']] if flip else 1)
        fa = [(r['date'], f(r)) for r in R if r['cls'] == 'FAST']; sl = [(r['date'], f(r)) for r in R if r['cls'] == 'SLOW']
        ok = len(fa) >= MIN_N and len({d for d, _ in fa}) >= MIN_DAYS
        t1 = G.boot_mean(fa, SEEDS[(pop, 'T1')], draws) if ok else None; t2 = G.boot_diff(fa, sl, SEEDS[(pop, 'T2')], draws) if ok and len(sl) >= MIN_N and len({d for d, _ in sl}) >= MIN_DAYS else None
        for k, r in (('T1', t1), ('T2', t2)):
            if r is not None: r['draws'] = draws; two_sided(r)
            res[(pop, k)] = r
    return res

def null_gate(iters=1000, alpha=0.10, seed=4321):
    rows = load(); dates = sorted({r['date'] for r in rows}); rng = np.random.default_rng(seed); passes = 0
    for it in range(iters):
        flip = {d: int(rng.choice([-1, 1])) for d in dates}; res = {f'{a}{b}': v for (a, b), v in cells(rows, flip, 1000).items()}; keep, m = G.holm(res, alpha); passes += bool(keep)
    rate = passes / iters; print(f'NULL GATE: 4 cells, {iters} iterations, Holm {alpha}: family-wise false-pass {rate:.3f} (required <= 0.10)'); json.dump(dict(rate=rate, ok=rate <= 0.10), open(os.path.join(OUT, 'null_gate.json'), 'w'))

def fmt(r, two=True):
    return 'n/a (parked)' if r is None else f'{r["mean"]:+.3f} [{r["lo"]:+.3f}, {r["hi"]:+.3f}] ' + (f'two-sided p {r["p"]:.3f}' if two else f'(one-sided p of mean <= 0: {r["p"]:.3f})')

def run():
    ng = json.load(open(os.path.join(OUT, 'null_gate.json'))); assert ng['ok'], 'null gate failed'
    rows = load(); res = cells(rows); keep, m = G.holm({f'{a}{b}': v for (a, b), v in res.items()}, 0.10)
    print(f'COUNTED: 4 cells ({m} passed the gate of >= {MIN_N} onsets on >= {MIN_DAYS} days), Holm 0.10 survivors: {sorted(keep) or "none"}')
    for pop, label in (('V_RTH', 'RTH'), ('V_GBX', 'GLOBEX')):
        R = [r for r in rows if r['pop'] == pop]; dates = sorted({r['date'] for r in R}); half = set(dates[len(dates) // 2:])
        print(f'\n=== {label}: {len(R)} scored onsets after burn-in, {len(dates)} days ===')
        for k, nm in (('T1', 'T1 FAST extra run (stop units)'), ('T2', 'T2 FAST minus SLOW extra run')):
            r = res[(pop, k)]; print(f'  {nm}: {fmt(r)}' + ('' if r is None else f'  N {r["n"]}' + (f' vs {r["nb"]}' if 'nb' in r else '') + f'  MDE {2.93 * r["se"]:.3f}  Holm {"PASS" if f"{pop}{k}" in keep else "no"}'))
        print('  descriptive (uncounted), extra run in stop units / live stop-hold net pts / bracket k=1 excess; each with a day-blocked interval on the extra run:')
        for cls in ('FAST', 'MID', 'SLOW'):
            S = [r for r in R if r['cls'] == cls]
            if len(S) < 20: print(f'    {cls}: N {len(S)} (below 20, nothing read)'); continue
            e = G.boot_mean([(r['date'], r['extra']) for r in S], 3300 + len(S), 4000)
            print(f'    {cls:4s} N {len(S):5d} days {e["days"]:3d}: extra {fmt(e, False)} | net {np.mean([r["r_net"] for r in S]):+.2f} (placebo {np.mean([r["p_net"] for r in S]):+.2f}) | k1 excess {np.mean([r["k1"] for r in S]):+.2f} | thrust dur median {np.median([r["dur"] for r in S]):.1f} s, pace median {np.median([r["tp"] for r in S]):.3f}')
        for nm, sg in (('long', 1), ('short', -1)):
            S = [r for r in R if r['cls'] == 'FAST' and r['s'] == sg]
            if len(S) >= 20: print(f'    FAST {nm}: N {len(S)} extra {fmt(G.boot_mean([(r["date"], r["extra"]) for r in S], 3400 + sg, 4000), False)}')
        for nm, sel in (('first half', lambda r: r['date'] not in half), ('second half', lambda r: r['date'] in half)):
            S = [r for r in R if r['cls'] == 'FAST' and sel(r)]
            if len(S) >= 20: print(f'    FAST {nm}: N {len(S)} extra {fmt(G.boot_mean([(r["date"], r["extra"]) for r in S], 3500 + len(S), 4000), False)}')
        hrs = sorted({r['hour'] for r in R}); print('    class share by hour (FAST/MID/SLOW %): ' + '; '.join(f'{h}h ' + '/'.join(f'{100 * np.mean([r["cls"] == c for r in R if r["hour"] == h]):.0f}' for c in ('FAST', 'MID', 'SLOW')) for h in hrs if sum(1 for r in R if r['hour'] == h) >= 50))
        if pop == 'V_RTH':
            for nm, sel in (('FAST 9:35-10:30', lambda r: r['hour'] in (9, 10)), ('FAST other hours', lambda r: r['hour'] not in (9, 10))):
                S = [r for r in R if r['cls'] == 'FAST' and sel(r)]
                if len(S) >= 20: print(f'    {nm}: N {len(S)} extra {fmt(G.boot_mean([(r["date"], r["extra"]) for r in S], 3600 + len(S), 4000), False)}')
    json.dump({f'{a}{b}': v for (a, b), v in res.items()}, open(os.path.join(OUT, 'summary.json'), 'w'), indent=1, default=str)

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'build': build()
    elif st == 'null': null_gate(int(sys.argv[2]) if len(sys.argv) > 2 else 1000)
    elif st == 'run': run()
    else: print(__doc__)
