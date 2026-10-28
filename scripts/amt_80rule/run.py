"""AMT 80%-rule strategy: baseline + Phase 1 + (conditional) Phase 2 + placebo, EXPLORE ONLY. PREREG.md frozen.
Usage: ../../venv/bin/python run.py   (the hold-out is sealed: there is no hold-out stage in this file)"""
import sys, itertools, json, datetime, pathlib
import numpy as np, pandas as pd
import engine as E
SPLIT, SEED, BOOT = '2025-05-16', 20261028, 3000
HERE = pathlib.Path(__file__).parent

def metrics(tr, key='net'):
    if not tr: return dict(n=0)
    p = np.array([t[key] for t in tr]); w, lo = p[p > 0], p[p <= 0]
    eq = np.cumsum(p); dd = float(np.max(np.maximum.accumulate(eq) - eq)) if len(eq) else 0.0
    return dict(n=len(tr), wr_trade=100 * np.mean(p > 0), wr_a=100 * np.mean([t['net_a'] > 0 for t in tr]), wr_b=100 * np.mean([t['net_b'] > 0 for t in tr]),
                pf=(w.sum() / abs(lo.sum())) if lo.sum() != 0 else float('inf'), mean=float(p.mean()), pts=float(np.mean([(t['pts_a'] + t['pts_b']) / 2 for t in tr])),
                avg_w=float(w.mean()) if len(w) else 0.0, avg_l=float(lo.mean()) if len(lo) else 0.0, dd=dd, total=float(p.sum()))

def day_ci(tr, rng, key='net', iters=BOOT):
    g = {}
    for t in tr: g.setdefault(t['date'], []).append(t[key])
    arrs = [np.array(v) for v in g.values()]; m = len(arrs)
    if m == 0: return (float('nan'), float('nan'))
    means = np.array([np.concatenate([arrs[j] for j in rng.integers(0, m, m)]).mean() for _ in range(iters)])
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))

def line(label, m, ci=None):
    if m['n'] == 0: return f"  {label}: 0 trades"
    s = (f"  {label}: N={m['n']} WR trade {m['wr_trade']:.1f}% (leg A {m['wr_a']:.1f}%, runner {m['wr_b']:.1f}%) PF {m['pf']:.2f} mean ${m['mean']:.2f}/trade "
         f"({m['pts']:+.2f} pts/contract before commission) avgW ${m['avg_w']:.2f} avgL ${m['avg_l']:.2f} maxDD ${m['dd']:.0f} total ${m['total']:.0f}")
    return s + (f" | day-blocked 95% CI of mean $ [{ci[0]:.2f}, {ci[1]:.2f}]" if ci else '')

def after_stop_rotation(tr, sess_by_date):
    """Share of stop-type exits where price later traded through pdPOC (+/- 1 tick) before the 15:55 flatten."""
    k = r = 0
    for t in tr:
        if t['ra'] not in ('STOP', 'STOP_GAP', 'STRUCT'): continue
        a = sess_by_date[t['date']]['a']; xi = t['xi']; k += 1
        seg_h, seg_l = a['h'][xi + 1:385], a['l'][xi + 1:385]
        if len(seg_h) and ((t['dir'] == 1 and np.nanmax(seg_h) >= t['poc'] + E.TICK) or (t['dir'] == -1 and np.nanmin(seg_l) <= t['poc'] - E.TICK)): r += 1
    return k, r

def stripped(a, ei, d, entry_open, S, d1, d2):
    """Placebo geometry: fixed stop distance S, leg A target d1, leg B target d2, flatten at 15:55 open, no structural/bailout/breakeven/trail. Returns net $ (2 contracts)."""
    o, h, l = a['o'], a['h'], a['l']; entry = entry_open + d * E.SLIP; stop = entry - d * S; ta, tb = entry + d * d1, entry + d * d2
    legs = {'A': None, 'B': None}
    for i in range(ei, 390):
        if np.isnan(o[i]): continue
        if i >= E.FLAT_OFF:
            for k in legs:
                if legs[k] is None: legs[k] = (o[i] - d * E.SLIP - entry) * d
            break
        if i > ei and d * (o[i] - stop) <= 0:
            for k in legs:
                if legs[k] is None: legs[k] = (o[i] - d * E.SLIP - entry) * d
            break
        if (d == 1 and l[i] <= stop) or (d == -1 and h[i] >= stop):
            for k in legs:
                if legs[k] is None: legs[k] = (stop - d * E.SLIP - entry) * d
            break
        for k, tgt in (('A', ta), ('B', tb)):
            if legs[k] is None and ((d == 1 and h[i] >= tgt + E.TICK) or (d == -1 and l[i] <= tgt - E.TICK)): legs[k] = (tgt - entry) * d
        if legs['A'] is not None and legs['B'] is not None: break
    for k in legs:
        if legs[k] is None: legs[k] = 0.0
    return sum(v * E.DPP - E.COMM_RT for v in legs.values())

def main():
    rng = np.random.default_rng(SEED)
    raw = E.load_sessions(); allS = E.build_eligible(raw)
    ex = [s for s in allS if s['d'] <= SPLIT]; by = {s['d']: s for s in ex}
    print(f"Eligible sessions {len(allS)} (explore {len(ex)}, hold-out {len(allS) - len(ex)} SEALED, not touched). Explore {ex[0]['d']}..{ex[-1]['d']}; VA widths: median {np.median([s['width'] for s in ex]):.0f}, share < 40 pts {100 * np.mean([s['width'] < 40 for s in ex]):.1f}%")
    base = [t for s in ex for t in E.simulate_session(s, E.BASE)]
    mb = metrics(base); ci = day_ci(base, rng)
    print('\n=== BASELINE (explore) ==='); print(line('baseline, $2 RT commission', mb, ci))
    print(line('baseline, spec $4.50 RT commission (sensitivity)', metrics(base, 'net_spec')))
    exits = pd.Series([t['ra'] + '/' + t['rb'] for t in base]).value_counts()
    print('  exits (leg A / leg B): ' + ', '.join(f"{k} {v}" for k, v in exits.head(8).items()))
    print('  T1 filled on', int(np.sum([t['t1_hit'] for t in base])), 'of', len(base), 'trades; trades by direction: long', sum(t['dir'] == 1 for t in base), 'short', sum(t['dir'] == -1 for t in base))
    # ---- Phase 1 ----
    print('\n=== PHASE 1 DIAGNOSTICS (baseline trade log, explore) ===')
    losers = [t for t in base if t['net'] <= 0]
    if losers:
        mf = np.array([t['mfe'] for t in losers]); ma = np.array([t['mae'] for t in base])
        print(f"  1. losers N={len(losers)}: MFE >= 6 pts {100 * np.mean(mf >= 6):.1f}%, in [6,10) {100 * np.mean((mf >= 6) & (mf < 10)):.1f}%, >= 10 {100 * np.mean(mf >= 10):.1f}%; median MFE {np.median(mf):.1f}; MAE of all trades median {np.median(ma):.1f}, p90 {np.percentile(ma, 90):.1f}")
        k, r = after_stop_rotation(base, by); print(f"     stop-type exits {k}: price later traded through pdPOC before 15:55 on {r} ({100 * r / max(k, 1):.0f}%) -> stopped then rotated")
    for name, lo_, hi_ in (('09:35-11:00', 5, 90), ('11:00-13:30', 90, 240), ('13:30-15:15', 240, 346)):
        seg = [t for t in base if lo_ <= t['ei'] < hi_]; print(line('2. ' + name, metrics(seg)))
    for name, far in (('open > 30 pts beyond the value area', True), ('open within 30 pts', False)):
        seg = [t for t in base if t['regime_far'] == far]; print(line('3. ' + name, metrics(seg)))
    # ---- placebo ----
    print('\n=== PLACEBO (explore baseline entries; random direction under one simple fixed geometry) ===')
    real = [stripped(by[t['date']]['a'], t['ei'], t['dir'], by[t['date']]['a']['o'][t['ei']], abs(t['entry'] - t['stop0']), abs(t['t1'] - t['entry']), abs(t['t2'] - t['entry'])) for t in base]
    pl = []
    for _ in range(200):
        pl.append(np.mean([stripped(by[t['date']]['a'], t['ei'], int(rng.choice([-1, 1])), by[t['date']]['a']['o'][t['ei']], abs(t['entry'] - t['stop0']), abs(t['t1'] - t['entry']), abs(t['t2'] - t['entry'])) for t in base]))
    pl = np.array(pl); print(f"  stripped geometry, real direction: mean ${np.mean(real):.2f}/trade | random direction: p5 {np.percentile(pl, 5):.2f}  p50 {np.percentile(pl, 50):.2f}  p95 {np.percentile(pl, 95):.2f} | trials >= real: {100 * np.mean(pl >= np.mean(real)):.1f}%")
    pd.DataFrame(base).to_csv(HERE / 'baseline_trades_explore.csv', index=False)
    # ---- Phase 2 ----
    print('\n=== PHASE 2 MATRIX ===')
    if mb['n'] and mb['pf'] >= 1.3: print(f"  baseline explore PF {mb['pf']:.2f} >= 1.3: pre-registered rule says the matrix is not required."); return
    print(f"  baseline explore PF {mb['pf']:.2f} < 1.3: running all 27 configurations on EXPLORE only")
    rows = []
    for A, B, C in itertools.product(('A1', 'A2', 'A3'), ('B1', 'B2', 'B3'), ('C1', 'C2', 'C3')):
        cfg = dict(E.BASE, A=A, B=B, C=C); tr = [t for s in ex for t in E.simulate_session(s, cfg)]; m = metrics(tr); m.update(cfg=f'{A}/{B}/{C}', tr=tr); rows.append(m)
        print(f"   {A}/{B}/{C}: N={m['n']} PF {m.get('pf', float('nan')):.2f} mean ${m.get('mean', float('nan')):.2f}", flush=True)
    ok = sorted([r for r in rows if r['n'] >= 30], key=lambda r: -r['mean'])
    print('\n  TOP 3 by mean $ per trade (N >= 30), with the baseline for reference:')
    for r in ok[:3]: print(line(r['cfg'], r, day_ci(r['tr'], rng)))
    print(line('BASELINE A1/B1/C1', mb, ci))
    print(f"  configurations with N>=30: {len(ok)} of 27; best-of-27 on the same data is biased upward. Share with positive mean: {100 * np.mean([r['mean'] > 0 for r in ok]):.0f}%")
    json.dump([{k: v for k, v in r.items() if k != 'tr'} for r in rows], open(HERE / 'matrix_explore.json', 'w'), indent=1, default=float)

if __name__ == '__main__':
    main()
