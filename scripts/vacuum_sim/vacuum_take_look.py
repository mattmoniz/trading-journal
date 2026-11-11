"""Vacuum item 1 (docs/VACUUM_TAKE_PREREG_20261110.md): is there anything to take? Favourable vs adverse run of every taken live-rule onset on explore, against a direction-blind placebo (the same bars, both directions).
Stages: test (synthetic walkers + parity of the walker's stop fill with sim_vac) | run (the look; the ledger look is logged first by scripts/vacuum_sim/log_look_take.mjs).   Usage: ulimit -v 4000000; venv/bin/python scripts/vacuum_sim/vacuum_take_look.py test|run"""
import os, sys, csv, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import unified_exit_lock as U          # vacuum_onsets(), sim_vac(), G (boot helpers)
G = U.G
OUT = os.path.join(U.ROOT, 'scratch', 'vacuum_take_look_20261110'); os.makedirs(OUT, exist_ok=True)
KS = (0.5, 1.0, 1.5, 2.0, 3.0); COST = 2.0; DRAWS = 10000; SEEDS = {'V_RTH': 3101, 'V_GBX': 3102}

def walk(o, h, l, c, ei, last, g, sd, ks=KS, cost=COST):
    """Direction g (+1 long, -1 short) from Open[ei]; initial stop sd away, no lock. Returns dict(mfe_pre, mae, mfe_all, stopped, net_stop (the plain stop/hold result), br {k: (net, outcome)})."""
    entry = float(o[ei]); stop = entry - g * sd; mfe_pre = 0.0; mae = 0.0; stopped = False; br = {}; net_stop = None
    for t in range(ei, last + 1):
        adv = g * (entry - (float(l[t]) if g == 1 else float(h[t]))); mae = max(mae, adv)
        if (g == 1 and l[t] <= stop) or (g == -1 and h[t] >= stop):
            px = (stop if t == ei else (min(stop, float(o[t])) if g == 1 else max(stop, float(o[t])))) - g * 0.25; net_stop = g * (px - entry) - cost; stopped = True
            for k in ks:
                if k not in br: br[k] = (net_stop, 'STOP')           # a bar touching both stop and target counts as STOP
            mae = min(mae, sd); break
        exc = g * ((float(h[t]) if g == 1 else float(l[t])) - entry); mfe_pre = max(mfe_pre, exc)
        for k in ks:
            if k not in br and exc >= k * sd: br[k] = (k * sd - cost, 'TARGET')
    tout = g * (float(c[last]) - entry) - cost
    if not stopped: net_stop = tout
    for k in ks:
        if k not in br: br[k] = (tout, 'TIME')
    mfe_all = max(g * ((float(h[t]) if g == 1 else float(l[t])) - entry) for t in range(ei, last + 1))
    return dict(mfe_pre=mfe_pre, mae=mae, mfe_all=mfe_all, stopped=stopped, net_stop=net_stop, br=br)

def _bars(spec, n=40):
    o = np.full(n, 100.0); h = np.full(n, 100.5); l = np.full(n, 99.5); c = np.full(n, 100.0)
    for k, (a, b, d_, e) in spec.items(): o[k], h[k], l[k], c[k] = a, b, d_, e
    return o, h, l, c

def unit_tests():
    ok = True
    def chk(name, cond, got=''):
        nonlocal ok; ok &= bool(cond); print(('PASS ' if cond else 'FAIL ') + name, '' if cond else got)
    # 1 straight to the target: long, sd 10, bar 3 high 112 (k=1 target 110 hit, k=1.5 target 115 not)
    o, h, l, c = _bars({3: (100, 112, 99.5, 111)}); w = walk(o, h, l, c, 1, 10, 1, 10.0)
    chk('1 target k=1 hit on bar 3: net 10 - 2 = 8, TARGET; k=1.5 not reached -> TIME close 100: -2', w['br'][1.0] == (8.0, 'TARGET') and w['br'][1.5] == (-2.0, 'TIME'), w['br'])
    chk('2 mfe_pre = 12 (no stop), stopped False, mae 0.5', abs(w['mfe_pre'] - 12.0) < 1e-9 and not w['stopped'] and abs(w['mae'] - 0.5) < 1e-9, w)
    # 3 straight to the stop: long, sd 10, bar 4 low 85 -> stop 90 filled at 89.75 (open 100 above): net -10.25 - 2
    o, h, l, c = _bars({4: (100, 100.5, 85, 88)}); w = walk(o, h, l, c, 1, 10, 1, 10.0)
    chk('3 stop hit: net -12.25 for every k, mfe_pre 0.5 (bars before the stop bar), mae capped at sd 10', abs(w['net_stop'] + 12.25) < 1e-9 and all(v == (w['net_stop'], 'STOP') for v in w['br'].values()) and abs(w['mfe_pre'] - 0.5) < 1e-9 and abs(w['mae'] - 10.0) < 1e-9, w)
    # 4 both in one bar -> STOP
    o, h, l, c = _bars({4: (100, 115, 85, 100)}); w = walk(o, h, l, c, 1, 10, 1, 10.0)
    chk('4 bar touches both stop and target: STOP for k=1 and 1.5', w['br'][1.0][1] == 'STOP' and w['br'][1.5][1] == 'STOP', w['br'])
    # 5 gap through the stop: bar 4 opens at 80 -> fill 80 - 0.25
    o, h, l, c = _bars({4: (80, 81, 78, 79)}); w = walk(o, h, l, c, 1, 10, 1, 10.0)
    chk('5 gap through the stop fills at the open - 0.25: net -20.25 - 2 = -22.25', abs(w['net_stop'] + 22.25) < 1e-9, w['net_stop'])
    # 6 short mirror of 1
    o, h, l, c = _bars({3: (100, 100.5, 88, 89)}); w = walk(o, h, l, c, 1, 10, -1, 10.0)
    chk('6 short: target 90 hit on bar 3 -> net 8, mfe_pre 12', w['br'][1.0] == (8.0, 'TARGET') and abs(w['mfe_pre'] - 12.0) < 1e-9, w)
    # 7 neither: time exit at last close
    o, h, l, c = _bars({9: (100, 100.5, 99.5, 103)}); w = walk(o, h, l, c, 1, 9, 1, 10.0)
    chk('7 neither level: time exit close 103 -> net 1.0 for k=3', w['br'][3.0] == (1.0, 'TIME') and not w['stopped'], w)
    # 8 parity of the no-lock stop/hold result with sim_vac on random paths
    rng = np.random.default_rng(1); md = 0.0
    for _ in range(300):
        n = 40; cl = 100 + np.cumsum(rng.normal(0, 3, n)); op = np.r_[100, cl[:-1]]; hi = np.maximum(op, cl) + rng.uniform(0, 3, n); lo = np.minimum(op, cl) - rng.uniform(0, 3, n); g = int(rng.choice([-1, 1])); sd = float(rng.uniform(5, 25))
        a = walk(op, hi, lo, cl, 1, 30, g, sd)['net_stop']; b = U.sim_vac(op, hi, lo, cl, 1, 30, g, sd, None)[0]; md = max(md, abs(a - b))
    chk('8 stop/hold result equals unified_exit_lock.sim_vac on 300 random paths', md < 1e-9, md)
    print('ALL PASS' if ok else 'SOME FAILED'); return ok

def collect():
    rows = []
    for e in U.vacuum_onsets():
        o, h, l, c, ei, last, s, sd = e['o'], e['h'], e['l'], e['c'], e['ei'], e['last'], e['s'], e['sd']
        r = walk(o, h, l, c, ei, last, s, sd); p = walk(o, h, l, c, ei, last, -s, sd)
        row = dict(date=e['date'], pop=e['pop'], s=s, sd=sd, r_mfe=r['mfe_pre'], p_mfe=p['mfe_pre'], r_mae=r['mae'], p_mae=p['mae'], r_mfe_all=r['mfe_all'], p_mfe_all=p['mfe_all'], r_stopped=int(r['stopped']), p_stopped=int(p['stopped']), r_net=r['net_stop'], p_net=p['net_stop'])
        for k in KS:
            row[f'r_br{k}'], row[f'r_bo{k}'] = r['br'][k]; row[f'p_br{k}'], row[f'p_bo{k}'] = p['br'][k]
        rows.append(row)
    with open(os.path.join(OUT, 'trades.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    return rows

def ci(vals, seed, draws=DRAWS):
    r = G.boot_mean(vals, seed, draws); return r

def fmt(r, unit=''):
    return 'n/a' if r is None else f'{r["mean"]:+.3f}{unit} [{r["lo"]:+.3f}, {r["hi"]:+.3f}]'

def size_check(vals, seed, iters=200):
    dates = sorted({d for d, _ in vals}); rng = np.random.default_rng(seed); cover = 0
    for it in range(iters):
        flip = {d: int(rng.choice([-1, 1])) for d in dates}; r = G.boot_mean([(d, v * flip[d]) for d, v in vals], seed + it, 1000); cover += (r['lo'] <= 0 <= r['hi'])
    return cover / iters

def run(rows=None):
    rows = rows or collect(); out = {}
    for pop, label in (('V_RTH', 'RTH'), ('V_GBX', 'GLOBEX')):
        R = [r for r in rows if r['pop'] == pop]; n = len(R); dates = sorted({r['date'] for r in R}); half = set(dates[len(dates) // 2:])
        ex = lambda r: (r['r_mfe'] - r['p_mfe']) / 2.0 / r['sd']
        vals = [(r['date'], ex(r)) for r in R]; P = ci(vals, SEEDS[pop]); out[pop] = dict(n=n, days=len(dates), P=P)
        print(f'\n=== {label}: {n} trades on {len(dates)} days (explore) ===')
        print(f'PRIMARY  extra favourable run (MFE_pre in stop units) of the vacuum direction over a direction-blind placebo: {fmt(P, " sd")}  one-sided p {P["p"]:.3f}  MDE {2.93 * P["se"]:.3f} sd')
        h1 = [(d, v) for d, v in vals if d not in half]; h2 = [(d, v) for d, v in vals if d in half]; print(f'  halves: first {fmt(ci(h1, SEEDS[pop] + 1))}  second {fmt(ci(h2, SEEDS[pop] + 2))}')
        for nm, sg in (('long', 1), ('short', -1)): print(f'  {nm:5s} (N {sum(1 for r in R if r["s"] == sg)}): {fmt(ci([(r["date"], ex(r)) for r in R if r["s"] == sg], SEEDS[pop] + 3 + (sg > 0)))}')
        thirds = np.array_split(np.array(dates), 3); print('  thirds by date: ' + ' / '.join(fmt(ci([(r['date'], ex(r)) for r in R if r['date'] in set(t)], SEEDS[pop] + 7 + i)) for i, t in enumerate(thirds)))
        byd = collections.Counter(); [byd.__setitem__(d, byd[d] + v) for d, v in vals]; tot = sum(abs(x) for x in byd.values()); print(f'  top-5-days share of |daily sum|: {sum(sorted((abs(x) for x in byd.values()), reverse=True)[:5]) / max(tot, 1e-9):.2f}')
        a = lambda key: np.array([r[key] for r in R], float); sd = a('sd')
        print(f'  mean MFE_pre / sd: real {np.mean(a("r_mfe") / sd):.3f}, opposite {np.mean(a("p_mfe") / sd):.3f}  (median {np.median(a("r_mfe") / sd):.3f} / {np.median(a("p_mfe") / sd):.3f});  in points: real {a("r_mfe").mean():.2f}, opposite {a("p_mfe").mean():.2f}, sd median {np.median(sd):.1f}')
        print(f'  mean MAE (capped at the stop) / sd: real {np.mean(a("r_mae") / sd):.3f}, opposite {np.mean(a("p_mae") / sd):.3f};  stopped share: real {a("r_stopped").mean():.3f}, opposite {a("p_stopped").mean():.3f}')
        print(f'  whole-hold MFE (calc_outcome convention) in points: real {a("r_mfe_all").mean():.2f}, opposite {a("p_mfe_all").mean():.2f};  share MFE_pre >= 1 sd: real {np.mean(a("r_mfe") >= sd):.3f}, opposite {np.mean(a("p_mfe") >= sd):.3f}')
        print(f'  stop/hold result (no take-profit, the live exit) net pts per trade: real {fmt(ci([(r["date"], r["r_net"]) for r in R], SEEDS[pop] + 20))}, opposite {fmt(ci([(r["date"], r["p_net"]) for r in R], SEEDS[pop] + 21))}')
        print('  TAKE-PROFIT BRACKETS (target k x stop, stop 1 x, 30-bar hold, tie = STOP), net pts per trade after 2.0 cost; excess = real minus placebo (mean of both directions):')
        for k in KS:
            ev = [(r['date'], (r[f'r_br{k}'] - r[f'p_br{k}']) / 2.0) for r in R]; E = ci(ev, SEEDS[pop] + 30 + int(k * 10))
            wr = np.mean([r[f'r_bo{k}'] == 'TARGET' for r in R]); wp = np.mean([r[f'p_bo{k}'] == 'TARGET' for r in R]); st = np.mean([r[f'r_bo{k}'] == 'STOP' for r in R]); tm = np.mean([r[f'r_bo{k}'] == 'TIME' for r in R])
            print(f'    k {k:3.1f}: target-first real {wr:.3f} vs opposite {wp:.3f} (driftless {1 / (1 + k):.3f}); real stop {st:.3f} time {tm:.3f};  net real {np.mean([r[f"r_br{k}"] for r in R]):+.2f}, opposite {np.mean([r[f"p_br{k}"] for r in R]):+.2f}, excess {fmt(E)}')
        out[pop]['size_check'] = size_check(vals, SEEDS[pop] + 500); print(f'  sign-flip size check (interval covers zero in 200 flips): {out[pop]["size_check"]:.3f} (required >= 0.90)')
    json.dump(out, open(os.path.join(OUT, 'summary.json'), 'w'), indent=1, default=str)

def hold_look(draws=4000):
    """Amendment A1: net points of the stop/hold result and MFE_pre for hold H = 30 / 60 / 120 bars, real vs the mean of both directions, same onsets (descriptive)."""
    data = {}
    for e in U.vacuum_onsets():
        o, h, l, c, ei, s, sd = e['o'], e['h'], e['l'], e['c'], e['ei'], e['s'], e['sd']; inside = e['n0'] + np.where(e['en'][e['n0']:] <= e['lim'])[0]; flat = int(inside.max()) if len(inside) else -1
        for H in (30, 60, 120):
            last = min(e['a'] + H, flat)
            if last < ei: continue
            r = walk(o, h, l, c, ei, last, s, sd); p = walk(o, h, l, c, ei, last, -s, sd); data.setdefault((e['pop'], H), []).append((e['date'], r['net_stop'], p['net_stop'], r['mfe_pre'] / sd, p['mfe_pre'] / sd, e['a'] + H <= flat))
    for pop, label in (('V_RTH', 'RTH'), ('V_GBX', 'GLOBEX')):
        print(f'=== {label} ===')
        for H in (30, 60, 120):
            R = data[(pop, H)]; n = len(R); full = np.mean([x[5] for x in R])
            ex = ci([(d, (a - b) / 2.0) for d, a, b, _, _, _ in R], SEEDS[pop] + 100 + H, draws); xm = ci([(d, (a - b) / 2.0) for d, _, _, a, b, _ in R], SEEDS[pop] + 200 + H, draws)
            print(f'  hold {H:3d} bars (N {n}, full hold available {full:.2f}): net real {np.mean([x[1] for x in R]):+.2f}, opposite {np.mean([x[2] for x in R]):+.2f}, excess {fmt(ex)} pt; extra MFE_pre {fmt(xm)} sd; MFE_pre real {np.mean([x[3] for x in R]):.3f} sd')

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'test': sys.exit(0 if unit_tests() else 1)
    elif st == 'run': run()
    elif st == 'hold': hold_look()
    elif st == 'rerun': run(list(csv.DictReader(open(os.path.join(OUT, 'trades.csv')))))
    else: print(__doc__)
