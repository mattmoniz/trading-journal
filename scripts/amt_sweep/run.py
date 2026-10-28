"""Revised Sweep & Absorb, EXPLORE ONLY (PREREG.md frozen). Hold-out not loaded.  Usage: ../../venv/bin/python run.py"""
import pathlib
import numpy as np, pandas as pd
import sweep as W
import engine as E
from amt_s1 import overnight_ranges
SPLIT, SEED, BOOT, TRIALS = '2025-05-16', 20261028, 3000, 100
HERE = pathlib.Path(__file__).parent

def metrics(tr):
    p = np.array([t['net'] for t in tr]); w, lo = p[p > 0], p[p <= 0]; eq = np.cumsum(p)
    return dict(n=len(tr), wr=100 * np.mean(p > 0), pf=(w.sum() / abs(lo.sum())) if lo.sum() != 0 else float('inf'), mean=float(p.mean()), pts=float(np.mean([t['pts'] for t in tr])),
                avg_w=float(w.mean()) if len(w) else 0.0, avg_l=float(lo.mean()) if len(lo) else 0.0, dd=float(np.max(np.maximum.accumulate(eq) - eq)), total=float(p.sum()))

def ci(tr, rng):
    g = {}
    for t in tr: g.setdefault(t['date'], []).append(t['net'])
    arrs = [np.array(v) for v in g.values()]; m = len(arrs)
    means = np.array([np.concatenate([arrs[j] for j in rng.integers(0, m, m)]).mean() for _ in range(BOOT)]); return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))

def line(label, tr, rng):
    if not tr: return f'  {label}: 0 trades'
    m = metrics(tr); c = ci(tr, rng); mix = pd.Series([t['reason'] for t in tr]).value_counts(normalize=True) * 100
    return (f"  {label}: N={m['n']} WR {m['wr']:.1f}% PF {m['pf']:.2f} mean ${m['mean']:.2f}/trade ({m['pts']:+.2f} pts/contract) avgW ${m['avg_w']:.2f} avgL ${m['avg_l']:.2f} maxDD ${m['dd']:.0f} total ${m['total']:.0f}"
            f" | day-blocked 95% CI [{c[0]:.2f}, {c[1]:.2f}]\n     exits " + ', '.join(f'{k} {v:.0f}%' for k, v in mix.items()))

def placebo(tr, by, vw, rng):
    real = np.mean([t['net'] for t in tr]); res = []; f15 = []
    for _ in range(TRIALS):
        v = []; ff = []
        for t in tr:
            a = by[t['date']]['a']
            while True:
                ei = int(rng.integers(W.ENT_LO, W.ENT_HI + 1))
                if not np.isnan(a['o'][ei]): break
            d = int(rng.choice([-1, 1])); r = W.manage(a, vw[t['date']], ei, d, t['stop_dist'], ei - 1)
            if r is not None: v.append(r['net']); ff.append(W.fwd15(a, ei, d))
        res.append(np.mean(v)); f15.append(np.nanmean(ff))
    res = np.array(res); return real, np.percentile(res, [5, 50, 95]), 100 * np.mean(res >= real), float(np.mean(f15))

def main():
    rng = np.random.default_rng(SEED)
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]
    on = overnight_ranges(end='2026-10-27')
    for s in ex:
        r = on.loc[s['d']] if s['d'] in on.index else None
        s['onh'], s['onl'] = (float(r.hi), float(r.lo)) if (r is not None and r.n >= 500) else (None, None)
    by = {s['d']: s for s in ex}; vw = {d: W.session_vwap(s['a']) for d, s in by.items()}
    print(f"Explore sessions {len(ex)} ({ex[0]['d']}..{ex[-1]['d']}); hold-out {len(allS) - len(ex)} SEALED")
    zs = {s['d']: W.F.build_zones(s) for s in ex}; nz = np.array([len(z) for z in zs.values()])
    print(f"Sessions with >= 1 confluence zone: {100 * np.mean(nz > 0):.1f}%")
    out = {}
    for name, ctrl in (('signal', False), ('control', True)):
        rep = dict(signals=0, capped=0, dist=[]); tr = []
        for s in ex:
            if zs[s['d']]: tr += W.simulate(s, control=ctrl, zones=zs[s['d']], report=rep)
        out[name] = (tr, rep); pd.DataFrame(tr).to_csv(HERE / f'trades_{name}_explore.csv', index=False)
    for name, label in (('signal', 'REVISED SWEEP & ABSORB (the spec)'), ('control', 'SAME-SELECTION CONTROL (delta opposite: no absorption)')):
        tr, rep = out[name]; print(f'\n=== {label} ===')
        print(f"  qualifying signals {rep['signals']}, aborted by the 25-pt risk cap {rep['capped']}, traded {len(tr)}; median distance of the signal bar beyond the zone {np.median(rep['dist']):.1f} pts" if rep['dist'] else '  no signals')
        print(line('result', tr, rng))
        if tr:
            print(f"     long {sum(t['dir'] == 1 for t in tr)} short {sum(t['dir'] == -1 for t in tr)}; trades per session with a zone {len(tr) / max(1, int((nz > 0).sum())):.2f}; runner in VWAP mode {100 * np.mean([t['vwap_mode'] for t in tr]):.0f}%; mean 15-bar forward move {np.nanmean([t['fwd15'] for t in tr]):+.2f} pts")
    tr = out['signal'][0]
    if tr:
        real, pq, share, pf15 = placebo(tr, by, vw, rng)
        print(f"\n  RANDOM-ENTRY PLACEBO (same management, {TRIALS} trials): real mean ${real:.2f}/trade | placebo p5 {pq[0]:.2f} p50 {pq[1]:.2f} p95 {pq[2]:.2f} | trials >= real: {share:.1f}% | placebo mean 15-bar forward {pf15:+.2f} pts")
    print('\nReading is pre-registered (PREREG.md): a lead needs CI lower bound > 0, beat placebo p95, AND beat its own same-selection control. Under 150 trades = underpowered.')

if __name__ == '__main__':
    main()
