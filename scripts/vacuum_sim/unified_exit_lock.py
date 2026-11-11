"""Row 45 (docs/UNIFIED_EXIT_LOCK_PREREG_20261110.md): profit-gated (P) / capitulation-gated (K) / speed-split (S) stop LOCK on the tell (1,760 explore entries, V1 replay engine) and the vacuum live rule (P'), RTH and Globex apart, plus the
prop-account race Monte Carlo. Stages: test (unit tests + parity) | build (paired results to CSV, prints counts only) | null | run.   Usage: ulimit -v 4000000; python3 scripts/vacuum_sim/unified_exit_lock.py <stage>"""
import os, sys, csv, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'tell_context', 'research_20261103'))
import globex_roc3_test as G
Fm, v2, SH = G.Fm, G.v2, G.SH
from exit_lock_common import *
sys.path.insert(0, os.path.join(HERE, '..', 'lib')); from pass_race import race_arms as race   # one shared implementation (2026-11-10, cv-077); moved unchanged

# ---------------------------------------------------------------- vacuum simulator (baseline must equal shadow.calc_outcome net_stop25)
def sim_vac(o, h, l, c, ei, last, s, stop_dist, gate=None, f=LOCK_F, cost=2.0):
    entry = float(o[ei]); stop = entry - s * stop_dist; best_exc = 0.0; acted = False
    for t in range(ei, last + 1):
        if (s == 1 and l[t] <= stop) or (s == -1 and h[t] >= stop):
            px = (stop if t == ei else (min(stop, float(o[t])) if s == 1 else max(stop, float(o[t])))) - s * 0.25
            return s * (px - entry) - cost, True, acted
        exc = s * ((float(h[t]) if s == 1 else float(l[t])) - entry); best_exc = max(best_exc, exc)
        if gate is not None and best_exc >= gate:
            cand = lock_price(s, entry, best_exc, f); nstop = max(stop, cand) if s == 1 else min(stop, cand)
            if nstop != stop: acted = True
            stop = nstop
    return s * (float(c[last]) - entry) - cost, False, acted

def _bars(spec, n=40):
    """spec: {bar index: (o, h, l, c)}; every other bar is flat 100 / 100.5 / 99.5 / 100."""
    o = np.full(n, 100.0); h = np.full(n, 100.5); l = np.full(n, 99.5); c = np.full(n, 100.0)
    for k, (a, b, d_, e) in spec.items(): o[k], h[k], l[k], c[k] = a, b, d_, e
    return o, h, l, c

def unit_tests():
    ok = True
    def chk(name, cond, got=''):
        nonlocal ok; ok &= bool(cond); print(('PASS ' if cond else 'FAIL ') + name, '' if cond else got)
    chk('1 lock price long: entry 100, excursion 40, f 0.5 -> 120', lock_price(1, 100.0, 40.0) == 120.0); chk('2 lock price short: entry 100, excursion 40 -> 80', lock_price(-1, 100.0, 40.0) == 80.0)
    # long: runs to +40 on bar 5, pulls back, trades through the lock (120) on bar 7 with the open above it -> filled at the lock minus a tick
    run = {5: (100, 140, 100, 138), 6: (138, 139, 125, 130), 7: (130, 131, 118, 119)}
    o, h, l, c = _bars(run); nb, sb, ab = sim_vac(o, h, l, c, 1, 30, 1, 25.0, None); nl, sl, al = sim_vac(o, h, l, c, 1, 30, 1, 25.0, 10.0)
    chk('3 baseline (stop 25 never hit) holds to the last close 100: net -2.0', abs(nb + 2.0) < 1e-9 and not sb, (nb, sb)); chk('4 gate 10, +40 excursion on bar 5: lock 120 effective bar 6, hit on bar 7 (open 130 above it) -> fill 119.75: net 17.75', abs(nl - 17.75) < 1e-9 and sl and al, (nl, sl, al))
    # the stop is effective from the NEXT bar only, and a lock already beyond the market fills at the open
    o, h, l, c = _bars({5: (100, 140, 100, 138), 6: (110, 111, 90, 100)}); ng, sg, ag = sim_vac(o, h, l, c, 1, 30, 1, 25.0, 10.0)
    chk('5 the trigger bar cannot stop itself; bar 6 opens at 110 below the lock 120 -> fills at the open: net 110 - 0.25 - 100 - 2 = 7.75', sg and abs(ng - 7.75) < 1e-9, (ng, sg))
    o, h, l, c = _bars({4: (100, 100.5, 70, 80)}); ns, ss, _ = sim_vac(o, h, l, c, 1, 30, 1, 25.0, None); chk('6 initial stop 25 (price 75) hit on bar 4 with open 100: fills at the stop - 0.25 = 74.75: net -25.25 - 2', ss and abs(ns - (-27.25)) < 1e-9, (ns, ss))
    o, h, l, c = _bars({5: (100, 100.5, 60, 62), 6: (62, 70, 61, 65), 7: (65, 90.5, 64, 85)}); nsh, ssh, ash = sim_vac(o, h, l, c, 1, 30, -1, 25.0, 10.0)
    chk('7 short: +40 excursion on bar 5, lock 80, bar 7 high 90.5 >= 80 with the open 65 below it -> fill 80.25: net 19.75 - 2 = 17.75', ssh and abs(nsh - 17.75) < 1e-9, (nsh, ssh))
    print('ALL PASS' if ok else 'SOME FAILED'); return ok

def vacuum_onsets():
    """Every TAKEN vacuum live-rule onset on explore (30-bar lock per track), one dict per onset with the arrays the simulators need. Single source of the onset loop (cv-079): vacuum_pairs() and the MFE/MAE look use it."""
    files = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    hist = {'RTH': [], 'GBX': []}; prevS = None
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if S['date'] in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2:
            P, n0, reset = v2.continuous(prevS, S); n = len(P['c']); Fm.L_ROC = 10; F = v2.feats(P, n0, reset, prs, close); etr = Fm.ema(F['tr']); en, o, h, l, c = P['en'], P['o'], P['h'], P['l'], P['c']
            idx = np.arange(n); z = F['zroc']; roc = F['roc']; ok = (idx >= n0) & ~np.isnan(z); prev_ok = np.r_[False, ~np.isnan(z[:-1])]; dd = np.where(roc > 0, 1, np.where(roc < 0, -1, 0))
            on0 = SH.onset(~np.isnan(z) & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd)) & prev_ok
            gw = ok & (en <= 55500.0); rw = ok & (en >= 56100.0) & (en <= close - 600.0); lock = {'GBX': -1, 'RTH': -1}
            for a in np.where(on0 & (gw | rw))[0]:
                tr = 'GBX' if gw[a] else 'RTH'
                if a < lock[tr]: continue
                lock[tr] = a + 30; s = int(dd[a]); lim = G.LIM if tr == 'GBX' else close - 300.0; inside = n0 + np.where(en[n0:] <= lim)[0]; flat = int(inside.max()) if len(inside) else -1; ei = a + 1
                if ei > flat or ei >= n: continue
                yield dict(date=S['date'], pop='V_' + tr, a=int(a), s=s, ei=ei, last=min(a + 30, flat), etr_a=float(etr[a]), sd=2.5 * float(etr[a]), lim=lim, n=n, n0=n0, en=en, o=o, h=h, l=l, c=c, pace_win=F['pace'][max(a - 4, n0):a + 1].copy(), dur_win=F['dur'][max(a - 4, n0):a + 1].copy())
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S

def vacuum_pairs(check_parity=False):
    """Paired baseline / P' results of every vacuum live-rule trade on explore, plus daily keys."""
    rows = []; maxdiff = 0.0
    for e in vacuum_onsets():
        o, h, l, c, ei, last, s, sd = e['o'], e['h'], e['l'], e['c'], e['ei'], e['last'], e['s'], e['sd']
        base, sb, _ = sim_vac(o, h, l, c, ei, last, s, sd, None); arm, sa, acted = sim_vac(o, h, l, c, ei, last, s, sd, VAC_GATE * sd, LOCK_F)
        if check_parity:
            oc = SH.calc_outcome(e['en'], o, h, l, c, e['a'], s, e['etr_a'], e['lim'], e['n'], n0=e['n0']); maxdiff = max(maxdiff, abs(oc['net_stop25'] - base)) if oc is not None and not isinstance(oc, tuple) else maxdiff
        rows.append(dict(date=e['date'], pop=e['pop'], base=base, arm=arm, acted=int(acted and abs(arm - base) > 1e-9), base_stop=int(sb), arm_stop=int(sa)))
    return rows, maxdiff

def build():
    assert os.path.exists(os.path.join(OUT, 'tell_pairs.csv')), 'run scripts/vacuum_sim/unified_exit_lock_tell.py first'
    V, md = vacuum_pairs(True); assert md <= 0.0051, f'vacuum baseline vs calc_outcome: max diff {md}'   # calc_outcome rounds to 2 decimals
    with open(os.path.join(OUT, 'vac_pairs.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(V[0].keys())); w.writeheader(); w.writerows(V)
    print(f'VACUUM: baseline reproduces calc_outcome net_stop25 to its 2-decimal rounding (max diff {md:.4f}) on {len(V)} trades')
    for pop in ('V_RTH', 'V_GBX'):
        r = [x for x in V if x['pop'] == pop]; print(f'  {pop}: {len(r)} trades; acted {sum(x["acted"] for x in r)} on {len({x["date"] for x in r if x["acted"]})} days')

# ---------------------------------------------------------------- statistics
def cells_from(T, V):
    cells = {}
    for arm in ('P', 'K', 'S'): cells[f'T-{arm}'] = [(r.date, float(r[f'{arm}_net'] - r['base_net']), abs(r[f'{arm}_net'] - r['base_net']) > 1e-9) for _, r in T.iterrows()]
    for pop, nm in (('V_RTH', 'V-P-RTH'), ('V_GBX', 'V-P-GBX')): cells[nm] = [(x['date'], float(x['arm']) - float(x['base']), int(x['acted']) == 1) for x in V if x['pop'] == pop]
    return cells
def run_cells(cells, seeds, draws, flip=None):
    res = {}
    for k, (nm, rows) in enumerate(cells.items()):
        acted = [(d, v) for d, v, a in rows if a]; ok = len(acted) >= G.MIN_N and len({d for d, _ in acted}) >= G.MIN_DAYS
        vals = [(d, v * (flip[d] if flip else 1)) for d, v, _ in rows]; res[nm] = (G.boot_mean(vals, seeds[nm], draws) if ok else None)
        if res[nm] is not None: res[nm]['acted'] = len(acted)
    return res
SEEDS = {'T-P': 1700, 'T-K': 1701, 'T-S': 1702, 'V-P-RTH': 1703, 'V-P-GBX': 1704}
def load_pairs():
    import pandas as pd
    return pd.read_csv(os.path.join(OUT, 'tell_pairs.csv')), list(csv.DictReader(open(os.path.join(OUT, 'vac_pairs.csv'))))
def null_gate(iters=1000, alpha=0.10, seed=789):
    T, V = load_pairs(); cells = cells_from(T, V); dates = sorted({d for rows in cells.values() for d, _, _ in rows}); rng = np.random.default_rng(seed); passes = 0
    for it in range(iters):
        flip = {d: int(rng.choice([-1, 1])) for d in dates}; keep, m = G.holm(run_cells(cells, SEEDS, 1000, flip), alpha); passes += bool(keep)
    rate = passes / iters; print(f'NULL GATE: 5 cells, {iters} iterations, Holm {alpha}: family-wise false-pass {rate:.3f} (required <= 0.10)'); json.dump(dict(rate=rate, ok=rate <= 0.10, alpha=alpha, iters=iters), open(os.path.join(OUT, 'null_gate.json'), 'w'))

# ---------------------------------------------------------------- prop-account race Monte Carlo (paired day-block paths)
def daily(rows_by_date, dates, key): return np.array([sum(rows_by_date.get(dt, {}).get(key, [0.0])) for dt in dates], float)

def run():
    ng = json.load(open(os.path.join(OUT, 'null_gate.json'))); assert ng['ok']; ALPHA = ng['alpha']; T, V = load_pairs(); cells = cells_from(T, V); res = run_cells(cells, SEEDS, G.B); keep, m = G.holm(res, ALPHA)
    print(f'COUNTED: 5 cells ({m} passed the gate: >= 100 acted trades on >= 60 days), Holm {ALPHA} survivors: {sorted(keep) or "none"}')
    unit = {'T-P': '$', 'T-K': '$', 'T-S': '$', 'V-P-RTH': 'pt', 'V-P-GBX': 'pt'}
    for nm, rows in cells.items():
        r = res[nm]; acted = sum(1 for _, _, a in rows if a)
        if r is None: print(f'  {nm:8s} PARKED: acted {acted} of {len(rows)} trades (gate 100 acted on 60 days)'); continue
        dates = sorted({d for d, _, _ in rows}); half = set(dates[len(dates) // 2:]); h1 = np.mean([v for d, v, _ in rows if d not in half]); h2 = np.mean([v for d, v, _ in rows if d in half]); dv = np.array([v for _, v, _ in rows]); cnt = collections.Counter()
        for d, v, _ in rows: cnt[d] += v
        top5 = sum(sorted((abs(x) for x in cnt.values()), reverse=True)[:5]) / max(sum(abs(x) for x in cnt.values()), 1e-9)
        print(f'  {nm:8s} N {r["n"]:5d} acted {acted:5d} ({r["days"]} days): mean paired diff {r["mean"]:+.3f} {unit[nm]} per trade [{r["lo"]:+.3f}, {r["hi"]:+.3f}] one-sided p {r["p"]:.3f}  halves {h1:+.3f} / {h2:+.3f}  improved {int((dv > 1e-9).sum())} / worsened {int((dv < -1e-9).sum())}  MDE {2.93 * r["se"]:.2f}  top-5-days share {top5:.2f}  Holm {"PASS" if nm in keep else "no"}')
    json.dump(dict(survivors=sorted(keep), res=res), open(os.path.join(OUT, 'summary.json'), 'w'), indent=1, default=str)
    print('\nDESCRIPTIVE (never counted): TELL by arm (paired difference vs V1, $ per trade; acted trades only in brackets)')
    for arm in ('P', 'K', 'S'):
        d = T[f'{arm}_net'] - T['base_net']; a = d.abs() > 1e-9
        if a.sum(): print(f'  {arm}: all {d.mean():+.2f}; acted {a.sum()}: mean {d[a].mean():+.2f}, median {d[a].median():+.2f}, improved {int((d > 1e-9).sum())} / worsened {int((d < -1e-9).sum())}; exit mix of acted: {dict(T.loc[a, f"{arm}_why"].value_counts())}')
    d = T['Kpl_net'] - T['base_net']; k = T['K_net'] - T['base_net']; a = T['K_trig'] == True
    print(f'  K timing placebo (same lock at a random in-profit bar of the same trade, K-triggered trades only, N {int(a.sum())}): K minus V1 {k[a].mean():+.2f}, placebo minus V1 {d[a].mean():+.2f}, K minus placebo {(k[a] - d[a]).mean():+.2f}')
    for nm, _, _ in SENS: print(f'  P sensitivity {nm}: mean paired diff {(T[f"P_{nm}_net"] - T["base_net"]).mean():+.2f} $ per trade')
    print('  by entry hour (RTH 10:00-10:59 vs other):', ', '.join(f'{lab}: P {(T.loc[mk, "P_net"] - T.loc[mk, "base_net"]).mean():+.2f} (N {int(mk.sum())})' for lab, mk in (('10h', (T.ehr >= 57600) & (T.ehr < 61200)), ('other', ~((T.ehr >= 57600) & (T.ehr < 61200))))))
    for lab, ser in (('V1 baseline', T['base_net']), ('P', T['P_net']), ('K', T['K_net']), ('S', T['S_net'])): print(f'  left tail {lab}: worst trade {ser.min():+.0f} $, 5th percentile {np.percentile(ser, 5):+.0f} $, mean {ser.mean():+.2f} $, win rate {np.mean(ser > 0):.1%}')
    print('\nTHE PROP-ACCOUNT RACE ($3,000 target, $2,000 end-of-day trailing floor that follows the high-water mark, one contract; 100 day-pool replicas x 10,000 paths x 250 days; the SAME paths for every arm)')
    cal = sorted(load_adr())
    for pop, label in (('T', 'TELL'), ('V_RTH', 'VACUUM RTH'), ('V_GBX', 'VACUUM Globex')):
        if pop == 'T':
            by = collections.defaultdict(lambda: collections.defaultdict(list))
            for _, r in T.iterrows():
                for arm, col in (('base', 'base_net'), ('P', 'P_net'), ('K', 'K_net'), ('S', 'S_net')): by[r.date][arm].append(float(r[col]))
            dv = {arm: np.array([sum(by[d][arm]) if d in by else 0.0 for d in cal]) for arm in ('base', 'P', 'K', 'S')}
        else:
            by = collections.defaultdict(lambda: collections.defaultdict(float))
            for x in V:
                if x['pop'] == pop: by[x['date']]['base'] += 2.0 * float(x['base']); by[x['date']]['P'] += 2.0 * float(x['arm'])
            dv = {arm: np.array([by[d][arm] if d in by else 0.0 for d in cal]) for arm in ('base', 'P')}
        out, dd = race(dv); print(f'  {label} ({len(cal)} calendar days; mean day {dv["base"].mean():+.1f} $ baseline):')
        for arm, (pp, pf, pu) in out.items(): print(f'     {arm:5s} P(pass) {pp:.3f}  P(fail) {pf:.3f}  unresolved {pu:.3f}' + ('' if arm == 'base' else f'   delta P(pass) vs baseline {dd[arm][0]:+.3f} (90% interval {dd[arm][1]:+.3f} to {dd[arm][2]:+.3f})'))

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    if st == 'test': sys.exit(0 if unit_tests() else 1)
    elif st == 'build': build()
    elif st == 'null': null_gate(int(sys.argv[2]) if len(sys.argv) > 2 else 1000, float(sys.argv[3]) if len(sys.argv) > 3 else 0.10, int(sys.argv[4]) if len(sys.argv) > 4 else 789)
    elif st == 'run': run()
    else: print(__doc__)
