"""Vacuum bar-6 DETERIORATING exit (docs/VACUUM_BAR6_EXIT_PREREG_20261110.md). Arms: A = live rule (stop 2.5 x EMA10 TR, 30-bar hold), B = exit at the bar-6 close if DETERIORATING, C = stop moved to the bar-6 close if DETERIORATING; each also on the opposite direction (placebo).
Stages: test | build (events to CSV, prints COUNTS only) | null (sign-flip gate) | run (counted cells + descriptives; look logged first by log_look_bar6.mjs).   Usage: ulimit -v 4000000; venv/bin/python scripts/vacuum_sim/vacuum_bar6_exit.py <stage>"""
import os, sys, csv, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import unified_exit_lock as U
import vacuum_take_look as T
sys.path.insert(0, os.path.join(U.ROOT, 'scripts', 'vacuum_live')); from bar6_status import bar6     # the one shared implementation (also used by the live detector)
G = U.G
OUT = os.path.join(U.ROOT, 'scratch', 'vacuum_bar6_exit_20261110'); os.makedirs(OUT, exist_ok=True)
COST, DRAWS, MIN_N, MIN_DAYS = 2.0, 10000, 100, 60; SEEDS = {('V_RTH', 'T1'): 3301, ('V_RTH', 'T2'): 3302, ('V_GBX', 'T1'): 3303, ('V_GBX', 'T2'): 3304}

def _bars(spec, n=40):
    o = np.full(n, 100.0); h = np.full(n, 100.5); l = np.full(n, 99.5); c = np.full(n, 100.0)
    for k, (a, b, d_, e) in spec.items(): o[k], h[k], l[k], c[k] = a, b, d_, e
    return o, h, l, c

def unit_tests():
    ok = True
    def chk(name, cond, got=''):
        nonlocal ok; ok &= bool(cond); print(('PASS ' if cond else 'FAIL ') + name, '' if cond else got)
    # entry bar index 1 -> bars 0..6 are indices 1..7. DETERIORATING long: low of 95 made at bar 4 (index 5), not stopped (sd 20, stop 80); bar 6 (index 7) closes 96
    o, h, l, c = _bars({5: (100, 100.5, 95, 97), 7: (97, 98, 96, 96)}); r = bar6(o, h, l, c, 1, 30, 1, 20.0)
    chk('1 deteriorating long (worst bar idx 4): B exits at the bar-6 close 96: net -4 - 2 = -6', r['status'] == 'DETERIORATING' and abs(r['b'] + 6.0) < 1e-9, r)
    o, h, l, c = _bars({2: (100, 100.5, 95, 97), 4: (97, 99, 96, 98), 7: (98, 99, 97, 98)}); r = bar6(o, h, l, c, 1, 30, 1, 20.0)
    chk('2 recovering long (worst bar idx 1): holds, B = A', r['status'] == 'RECOVERING' and r['a'] == r['b'] == r['cc'], r)
    o, h, l, c = _bars({3: (100, 100.5, 70, 75)}); r = bar6(o, h, l, c, 1, 30, 1, 20.0)
    chk('3 stopped on bar 2 (before bar 6): status NA, all arms equal', r['status'] == 'NA' and r['a'] == r['b'] == r['cc'], r)
    o, h, l, c = _bars({5: (100, 100.5, 95, 97)}); r = bar6(o, h, l, c, 1, 5, 1, 20.0)
    chk('4 flat reached before bar 6 (last = 5 < entry+6): NA', r['status'] == 'NA', r)
    o, h, l, c = _bars({5: (100, 105, 99.5, 103), 7: (103, 104, 102, 104)}); r = bar6(o, h, l, c, 1, 30, -1, 20.0)
    chk('5 deteriorating short (worst high 105 at bar idx 4): B exits at close 104: net -4 - 2 = -6', r['status'] == 'DETERIORATING' and abs(r['b'] + 6.0) < 1e-9, r)
    # arm C: deteriorating long, bar-6 close 96 -> stop 96; bar 8 (index 9) low 94.5 with open 96.4 above the stop -> fill 96 - 0.25: net -4.25 - 2
    o, h, l, c = _bars({5: (100, 100.5, 95, 97), 7: (97, 98, 96.2, 96), 9: (96.4, 97, 94.5, 95)}); r = bar6(o, h, l, c, 1, 30, 1, 20.0)
    chk('6 arm C stops at the bar-6 close: fill 95.75, net -6.25', abs(r['cc'] + 6.25) < 1e-9, r)
    o, h, l, c = _bars({5: (100, 100.5, 95, 97), 7: (97, 98, 96.2, 96), 9: (93, 94, 92, 93)}); r = bar6(o, h, l, c, 1, 30, 1, 20.0)
    chk('7 arm C gap through the new stop fills at the open - 0.25: 92.75, net -7.25 - 2 = -9.25', abs(r['cc'] + 9.25) < 1e-9, r)
    rng = np.random.default_rng(2); md = 0.0
    for _ in range(300):
        n = 45; cl = 100 + np.cumsum(rng.normal(0, 3, n)); op = np.r_[100, cl[:-1]]; hi = np.maximum(op, cl) + rng.uniform(0, 3, n); lo = np.minimum(op, cl) - rng.uniform(0, 3, n); g = int(rng.choice([-1, 1])); sd = float(rng.uniform(8, 25))
        md = max(md, abs(bar6(op, hi, lo, cl, 1, 31, g, sd)['a'] - T.walk(op, hi, lo, cl, 1, 31, g, sd)['net_stop']))
    chk('8 arm A equals vacuum_take_look.walk on 300 random paths', md < 1e-9, md)
    print('ALL PASS' if ok else 'SOME FAILED'); return ok

def build():
    rows = []; cnt = collections.Counter()
    for e in U.vacuum_onsets():
        o, h, l, c, ei, last, s, sd = e['o'], e['h'], e['l'], e['c'], e['ei'], e['last'], e['s'], e['sd']
        r = bar6(o, h, l, c, ei, last, s, sd); p = bar6(o, h, l, c, ei, last, -s, sd)
        rows.append(dict(date=e['date'], pop=e['pop'], s=s, hour=int(U.Fm.hour_et(np.array([e['en'][e['a']]]))[0]), st_r=r['status'], a_r=r['a'], db_r=r['b'] - r['a'], dc_r=r['cc'] - r['a'], st_p=p['status'], a_p=p['a'], db_p=p['b'] - p['a'], dc_p=p['cc'] - p['a'], rawA=r['a']))
        cnt[(e['pop'], r['status'])] += 1
    with open(os.path.join(OUT, 'events.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    for pop in ('V_RTH', 'V_GBX'):
        print(pop, {k[1]: v for k, v in cnt.items() if k[0] == pop}, 'deteriorating days', len({r['date'] for r in rows if r['pop'] == pop and r['st_r'] == 'DETERIORATING'}))

def load():
    out = []
    for r in csv.DictReader(open(os.path.join(OUT, 'events.csv'))):
        for k in ('a_r', 'db_r', 'dc_r', 'a_p', 'db_p', 'dc_p', 'rawA'): r[k] = float(r[k])
        r['s'] = int(r['s']); r['hour'] = int(r['hour']); out.append(r)
    return out

def two_sided(r, draws):
    if r is None: return None
    p1 = r['p']; r['p'] = min(1.0, 2 * min(p1, 1 - p1 + 1.0 / (draws + 1))); return r

def cells(rows, flip=None, draws=DRAWS):
    res = {}
    for pop in ('V_RTH', 'V_GBX'):
        R = [r for r in rows if r['pop'] == pop]; f = lambda r: flip[r['date']] if flip else 1; det = [r for r in R if r['st_r'] == 'DETERIORATING']
        ok = len(det) >= MIN_N and len({r['date'] for r in det}) >= MIN_DAYS
        t1 = G.boot_mean([(r['date'], r['db_r'] * f(r)) for r in R], SEEDS[(pop, 'T1')], draws) if ok else None
        t2 = G.boot_mean([(r['date'], (r['db_r'] - r['db_p']) * f(r)) for r in R], SEEDS[(pop, 'T2')], draws) if ok else None
        for k, r in (('T1', t1), ('T2', t2)): res[(pop, k)] = two_sided(r, draws)
    return res

def null_gate(iters=1000, alpha=0.10, seed=777):
    rows = load(); dates = sorted({r['date'] for r in rows}); rng = np.random.default_rng(seed); passes = 0
    for it in range(iters):
        flip = {d: int(rng.choice([-1, 1])) for d in dates}; keep, m = G.holm({f'{a}{b}': v for (a, b), v in cells(rows, flip, 1000).items()}, alpha); passes += bool(keep)
    rate = passes / iters; print(f'NULL GATE: 4 cells, {iters} iterations, Holm {alpha}: family-wise false-pass {rate:.3f} (required <= 0.10)'); json.dump(dict(rate=rate, ok=rate <= 0.10), open(os.path.join(OUT, 'null_gate.json'), 'w'))

def fmt(r, two=True):
    return 'n/a (parked)' if r is None else f'{r["mean"]:+.3f} [{r["lo"]:+.3f}, {r["hi"]:+.3f}]' + (f' two-sided p {r["p"]:.3f}' if two else '')

def run():
    ng = json.load(open(os.path.join(OUT, 'null_gate.json'))); assert ng['ok'], 'null gate failed'
    rows = load(); res = cells(rows); keep, m = G.holm({f'{a}{b}': v for (a, b), v in res.items()}, 0.10)
    print(f'COUNTED: 4 cells ({m} passed the gate of >= {MIN_N} DETERIORATING trades on >= {MIN_DAYS} days), Holm 0.10 survivors: {sorted(keep) or "none"}')
    for pop, label in (('V_RTH', 'RTH'), ('V_GBX', 'GLOBEX')):
        R = [r for r in rows if r['pop'] == pop]; dates = sorted({r['date'] for r in R}); half = set(dates[len(dates) // 2:]); det = [r for r in R if r['st_r'] == 'DETERIORATING']
        print(f'\n=== {label}: {len(R)} trades, {len(dates)} days; status: ' + ', '.join(f'{k} {sum(1 for r in R if r["st_r"] == k)}' for k in ('DETERIORATING', 'RECOVERING', 'NA')) + ' ===')
        for k, nm in (('T1', 'T1 arm B minus arm A, all trades (pt per trade)'), ('T2', 'T2 the same minus the opposite-direction placebo')):
            r = res[(pop, k)]; print(f'  {nm}: {fmt(r)}' + ('' if r is None else f'  N {r["n"]}  MDE {2.93 * r["se"]:.3f}  Holm {"PASS" if f"{pop}{k}" in keep else "no"}'))
        print('  descriptive (uncounted):')
        for nm, S in (('DETERIORATING', det), ('RECOVERING', [r for r in R if r['st_r'] == 'RECOVERING']), ('NA', [r for r in R if r['st_r'] == 'NA'])):
            if len(S) < 20: print(f'    {nm}: N {len(S)} (below 20)'); continue
            print(f'    {nm:13s} N {len(S):5d}: arm A net {np.mean([r["a_r"] for r in S]):+.2f}, B minus A {np.mean([r["db_r"] for r in S]):+.2f}, C minus A {np.mean([r["dc_r"] for r in S]):+.2f}   | placebo (opposite direction, its own status): A {np.mean([r["a_p"] for r in S]):+.2f}')
        dp = [r for r in R if r['st_p'] == 'DETERIORATING']
        if len(dp) >= 20: print(f'    placebo DETERIORATING (opposite direction) N {len(dp)}: B minus A {np.mean([r["db_p"] for r in dp]):+.2f}, C minus A {np.mean([r["dc_p"] for r in dp]):+.2f}')
        if det:
            print(f'    ARM C on all trades: {fmt(G.boot_mean([(r["date"], r["dc_r"]) for r in R], 3350 + len(R) % 7, 4000), False)} (placebo {np.mean([r["dc_p"] for r in R]):+.3f})')
        for nm, sg in (('long', 1), ('short', -1)):
            S = [r for r in R if r['s'] == sg]; print(f'    B minus A, {nm} (N {len(S)}): {fmt(G.boot_mean([(r["date"], r["db_r"]) for r in S], 3360 + sg, 4000), False)}')
        for nm, sel in (('first half', lambda r: r['date'] not in half), ('second half', lambda r: r['date'] in half)):
            S = [r for r in R if sel(r)]; print(f'    B minus A, {nm} (N {len(S)}): {fmt(G.boot_mean([(r["date"], r["db_r"]) for r in S], 3370 + len(S) % 11, 4000), False)}')
        byd = collections.Counter(); [byd.__setitem__(r['date'], byd[r['date']] + r['db_r']) for r in R]; tot = sum(abs(x) for x in byd.values())
        print(f'    top-5-days share of |daily sum of B minus A|: {sum(sorted((abs(x) for x in byd.values()), reverse=True)[:5]) / max(tot, 1e-9):.2f}')
    json.dump({f'{a}{b}': v for (a, b), v in res.items()}, open(os.path.join(OUT, 'summary.json'), 'w'), indent=1, default=str)

def globex_split():
    """Amendment A1: Globex only, by entry clock block of the signal bar (hour ET of the bar end). Descriptive."""
    rows = [r for r in load() if r['pop'] == 'V_GBX']; blocks = (('18:00-19:59 reopen', (18, 19)), ('20:00-23:59', (20, 21, 22, 23)), ('00:00-05:59', (0, 1, 2, 3, 4, 5)), ('06:00-09:25', (6, 7, 8, 9)))
    print(f'GLOBEX only: {len(rows)} trades; B / C = exit at the bar-6 close / stop to the bar-6 close if DETERIORATING, minus the live 30-bar hold (pt per trade, all trades in the block)')
    for nm, hrs in blocks:
        S = [r for r in rows if r['hour'] in hrs]
        if len(S) < 20: print(f'  {nm}: N {len(S)} (below 20, nothing read)'); continue
        det = [r for r in S if r['st_r'] == 'DETERIORATING']
        b = G.boot_mean([(r['date'], r['db_r']) for r in S], 3401 + len(S) % 13, 4000); cc = G.boot_mean([(r['date'], r['dc_r']) for r in S], 3402 + len(S) % 13, 4000); pl = G.boot_mean([(r['date'], r['db_p']) for r in S], 3403 + len(S) % 13, 4000)
        print(f'  {nm:19s} N {len(S):4d} days {b["days"]:3d} deteriorating {len(det):4d}: B minus A {fmt(b, False)} | C minus A {fmt(cc, False)} | placebo B minus A {fmt(pl, False)} | live exit A net {np.mean([r["a_r"] for r in S]):+.2f}, on deteriorating {np.mean([r["a_r"] for r in det]) if det else float("nan"):+.2f}')

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'test': sys.exit(0 if unit_tests() else 1)
    elif st == 'build': build()
    elif st == 'null': null_gate()
    elif st == 'run': run()
    elif st == 'globex_split': globex_split()
    else: print(__doc__)
