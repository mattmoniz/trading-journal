"""Order-flow branch, EXPLORE ONLY (PREREG.md frozen). The hold-out is not loaded into any computation here.
Usage: ../../venv/bin/python run.py"""
import sys, pathlib
import numpy as np, pandas as pd
import flow as F
import engine as E
from amt_s1 import overnight_ranges
SPLIT, SEED, BOOT, TRIALS = '2025-05-16', 20261028, 3000, 100
HERE = pathlib.Path(__file__).parent

def metrics(tr):
    if not tr: return dict(n=0)
    p = np.array([t['net'] for t in tr]); w, lo = p[p > 0], p[p <= 0]; eq = np.cumsum(p)
    return dict(n=len(tr), wr=100 * np.mean(p > 0), pf=(w.sum() / abs(lo.sum())) if lo.sum() != 0 else float('inf'), mean=float(p.mean()), pts=float(np.mean([t['pts'] for t in tr])),
                avg_w=float(w.mean()) if len(w) else 0.0, avg_l=float(lo.mean()) if len(lo) else 0.0, dd=float(np.max(np.maximum.accumulate(eq) - eq)), total=float(p.sum()))

def ci(tr, rng):
    g = {}
    for t in tr: g.setdefault(t['date'], []).append(t['net'])
    arrs = [np.array(v) for v in g.values()]; m = len(arrs)
    if m == 0: return (float('nan'), float('nan'))
    means = np.array([np.concatenate([arrs[j] for j in rng.integers(0, m, m)]).mean() for _ in range(BOOT)]); return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))

def line(label, tr, rng):
    m = metrics(tr)
    if m['n'] == 0: return f'  {label}: 0 trades'
    c = ci(tr, rng); mix = pd.Series([t['reason'] for t in tr]).value_counts(normalize=True) * 100
    return (f"  {label}: N={m['n']} WR {m['wr']:.1f}% PF {m['pf']:.2f} mean ${m['mean']:.2f}/trade ({m['pts']:+.2f} pts) avgW ${m['avg_w']:.2f} avgL ${m['avg_l']:.2f} maxDD ${m['dd']:.0f} total ${m['total']:.0f}"
            f" | day-blocked 95% CI [{c[0]:.2f}, {c[1]:.2f}] | exits " + ', '.join(f'{k} {v:.0f}%' for k, v in mix.items()))

def placebo(tr, by, kind, rng):
    T = F.A_TGT if kind == 'A' else F.B_TGT; lo_i, hi_i = F.A_RANGE if kind == 'A' else F.B_RANGE
    real = np.mean([F.stripped(by[t['date']]['a'], t['ei'], t['dir'], t['risk'], T) for t in tr]); res = []
    for _ in range(TRIALS):
        v = []
        for t in tr:
            a = by[t['date']]['a']; i = int(rng.integers(lo_i, hi_i + 1))
            while np.isnan(a['o'][i]): i = int(rng.integers(lo_i, hi_i + 1))
            v.append(F.stripped(a, i, int(rng.choice([-1, 1])), t['risk'], T))
        res.append(np.mean(v))
    res = np.array(res); return real, np.percentile(res, [5, 50, 95]), 100 * np.mean(res >= real)

def main():
    rng = np.random.default_rng(SEED)
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]
    on = overnight_ranges(end='2026-10-27')
    for s in ex:
        r = on.loc[s['d']] if s['d'] in on.index else None
        s['onh'], s['onl'] = (float(r.hi), float(r.lo)) if (r is not None and r.n >= 500) else (None, None)
    by = {s['d']: s for s in ex}
    print(f"Explore sessions {len(ex)} ({ex[0]['d']}..{ex[-1]['d']}); hold-out {len(allS) - len(ex)} SEALED. Sessions with ON levels: {sum(s['onh'] is not None for s in ex)}")
    zs = {s['d']: F.build_zones(s) for s in ex}; nz = np.array([len(z) for z in zs.values()])
    print(f"Confluence zones: sessions with >= 1 zone {100 * np.mean(nz > 0):.1f}% (median zones among those {np.median(nz[nz > 0]):.0f}); sessions with none are skipped")
    res = {}
    for kind in ('A', 'B'):
        for ctrl in (False, True):
            tr = []
            for s in ex:
                if zs[s['d']]: tr += F.simulate(s, kind, control=ctrl, zones=zs[s['d']], mv=F.micro_vpoc(s['a']) if kind == 'B' else None)
            res[(kind, ctrl)] = tr
    nsess = len(ex)
    for kind, name in (('A', 'SETUP A: sweep + CVD absorption'), ('B', 'SETUP B: build and go')):
        print(f"\n=== {name} ===")
        sig, ctl = res[(kind, False)], res[(kind, True)]
        print(line('signal  ', sig, rng)); print(f"     trades per session with a zone: {len(sig) / max(1, int(np.sum(nz > 0))):.2f}; long {sum(t['dir'] == 1 for t in sig)} short {sum(t['dir'] == -1 for t in sig)}")
        print(line('control (no ' + ('absorption' if kind == 'A' else 'acceptance') + ')', ctl, rng))
        if sig:
            real, pq, share = placebo(sig, by, kind, rng)
            print(f"  RANDOM-ENTRY PLACEBO (stripped geometry, {TRIALS} trials): real-stripped mean ${real:.2f}/trade | placebo p5 {pq[0]:.2f} p50 {pq[1]:.2f} p95 {pq[2]:.2f} | trials >= real: {share:.1f}%")
        pd.DataFrame(sig).to_csv(HERE / f'trades_{kind}_signal_explore.csv', index=False); pd.DataFrame(ctl).to_csv(HERE / f'trades_{kind}_control_explore.csv', index=False)
    print('\nReading is pre-registered (PREREG.md): a lead needs CI lower bound > 0, beat placebo p95, AND beat its own same-selection control. Otherwise not shown.')

if __name__ == '__main__':
    main()
