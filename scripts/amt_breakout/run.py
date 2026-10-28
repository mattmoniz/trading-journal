"""Initiative Ignition & Retest, EXPLORE ONLY (PREREG.md frozen). Hold-out not loaded.  Usage: ../../venv/bin/python run.py"""
import sys, pathlib
import numpy as np, pandas as pd
import breakout as B
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
    return (f"  {label}: N={m['n']} WR {m['wr']:.1f}% PF {m['pf']:.2f} mean ${m['mean']:.2f}/trade ({m['pts']:+.2f} pts) avgW ${m['avg_w']:.2f} avgL ${m['avg_l']:.2f} maxDD ${m['dd']:.0f} total ${m['total']:.0f}"
            f" | day-blocked 95% CI [{c[0]:.2f}, {c[1]:.2f}] | exits " + ', '.join(f'{k} {v:.0f}%' for k, v in mix.items()))

def placebo(tr, by, rng):
    real = np.mean([B.stripped(by[t['date']]['a'], t['ei'], t['dir'], B.HARD, B.TGT) for t in tr]); res = []
    for _ in range(TRIALS):
        v = []
        for t in tr:
            a = by[t['date']]['a']; i = int(rng.integers(B.WIN_LO + 1, B.WIN_HI + 1))
            while np.isnan(a['o'][i]): i = int(rng.integers(B.WIN_LO + 1, B.WIN_HI + 1))
            v.append(B.stripped(a, i, int(rng.choice([-1, 1])), B.HARD, B.TGT))
        res.append(np.mean(v))
    res = np.array(res); return real, np.percentile(res, [5, 50, 95]), 100 * np.mean(res >= real)

def runaway(unfilled, by):
    """Descriptive: share of unfilled orders whose price reached Line +/- 24 within 30 bars after the order bar."""
    hit = 0
    for date, t, d, ln in unfilled:
        a = by[date]['a']; seg_h = a['h'][t + 1:t + 31]; seg_l = a['l'][t + 1:t + 31]
        hit += int((np.nanmax(seg_h) >= ln + B.TGT) if d == 1 else (np.nanmin(seg_l) <= ln - B.TGT)) if len(seg_h) else 0
    return hit, len(unfilled)

def main():
    rng = np.random.default_rng(SEED)
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]
    on = overnight_ranges(end='2026-10-27')
    for s in ex:
        r = on.loc[s['d']] if s['d'] in on.index else None
        s['onh'], s['onl'] = (float(r.hi), float(r.lo)) if (r is not None and r.n >= 500) else (None, None)
    by = {s['d']: s for s in ex}
    print(f"Explore sessions {len(ex)} ({ex[0]['d']}..{ex[-1]['d']}); hold-out {len(allS) - len(ex)} SEALED. Sessions with ON levels: {sum(s['onh'] is not None for s in ex)}")
    has_l = sum(any(B.lines(s, i)[0] is not None for i in (30, 100)) for s in ex); has_s = sum(any(B.lines(s, i)[1] is not None for i in (30, 100)) for s in ex)
    print(f"Sessions with a long line at some point (09:59 or 11:10 bar): {has_l}; short line: {has_s}")
    out = {}
    for name, mode, market in (('ignition', 'ignition', False), ('plain', 'plain', False), ('ignition_market', 'ignition', True)):
        rep = dict(signals=0, filled=0, unfilled=[]); tr = []
        for s in ex: tr += B.simulate(s, mode=mode, market=market, report=rep)
        out[name] = (tr, rep); pd.DataFrame(tr).to_csv(HERE / f'trades_{name}_explore.csv', index=False)
    for name, label in (('ignition', 'IGNITION + LIMIT RETEST (the spec)'), ('plain', 'PLAIN BREAK control (cross + clear, fails >= 1 initiative condition), same retest and management'), ('ignition_market', 'DIAGNOSTIC: ignition signals entered at market at the next open')):
        tr, rep = out[name]; print(f'\n=== {label} ===')
        if name != 'ignition_market':
            print(f"  signals {rep['signals']}, filled {rep['filled']} ({100 * rep['filled'] / max(1, rep['signals']):.1f}%), unfilled {len(rep['unfilled'])}")
            h, n = runaway(rep['unfilled'], by); print(f"  unfilled orders where price ran >= 24 pts from the line within 30 bars (descriptive): {h} of {n}")
        print(line('result', tr, rng))
        if tr: print(f"     long {sum(t['dir'] == 1 for t in tr)} short {sum(t['dir'] == -1 for t in tr)}; trades per session {len(tr) / len(ex):.3f}")
    tr = out['ignition'][0]
    if tr:
        real, pq, share = placebo(tr, by, rng)
        print(f"\n  RANDOM-ENTRY PLACEBO (stripped 12/24 geometry, {TRIALS} trials): real-stripped mean ${real:.2f}/trade | placebo p5 {pq[0]:.2f} p50 {pq[1]:.2f} p95 {pq[2]:.2f} | trials >= real: {share:.1f}%")
    print('\nReading is pre-registered (PREREG.md): a lead needs CI lower bound > 0, beat placebo p95, AND beat the plain-break control. Under 150 trades = underpowered.')

if __name__ == '__main__':
    main()
