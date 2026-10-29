"""Spike robustness and same-selection control (PREREG.md Amendment 2). EXPLORE only. Usage: ../../venv/bin/python run_robust.py"""
import sys, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_exhaust'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_path')
import engine as E, spike as SP, run_path as RP
SETTINGS = [(5, 75), (3, 75), (8, 75), (5, 65), (5, 85)]; SEED = 20261029; BOOT = 3000; TICK = RP.TICK

def evaluate(a, ev):
    """P1 fade and direction-flip for each event dict (dir = fade direction D, ext, u)."""
    rows = []
    for e in ev:
        D = e['dir']; en = e['u'] + 1
        if not (RP.E_LO <= en <= RP.E_HI): continue
        stop = e['ext'] - D * TICK; r = RP.sim(a, en, D, stop)
        if r is None: continue
        risk = D * (r['entry'] - stop); Df = -D; enC = a['o'][en] + Df * RP.SLIP
        if np.isnan(enC): continue
        rC = RP.sim(a, en, Df, enC - Df * risk)
        if rC is None: continue
        c = a['c']; t = e['t']; o0 = a['o'][0]; against = bool(c[t] > o0) if D == 1 else bool(c[t] < o0)   # spike LOW (fade long) is against the drift when the day is UP; spike HIGH when the day is DOWN
        rows.append(dict(fade=r['pts'] * RP.DPP - RP.COMM, flip=rC['pts'] * RP.DPP - RP.COMM, against=against, D=D))
    return rows

def group_stats(R, rng):
    if not R: return None
    days = [r['d'] for r in R]; m, lo, hi = RP.boot([r['fade'] - r['flip'] for r in R], days, rng, BOOT)
    return dict(n=len(R), fade=float(np.mean([r['fade'] for r in R])), flip=float(np.mean([r['flip'] for r in R])), m=m, lo=lo, hi=hi)

def did(Ra, Rb, rng, it=BOOT):
    ga, gb = {}, {}
    for r in Ra: ga.setdefault(r['d'], []).append(r['fade'] - r['flip'])
    for r in Rb: gb.setdefault(r['d'], []).append(r['fade'] - r['flip'])
    days = sorted(set(ga) | set(gb)); out = []
    for _ in range(it):
        pick = [days[j] for j in rng.integers(0, len(days), len(days))]; x = [v for d in pick for v in ga.get(d, [])]; y = [v for d in pick for v in gb.get(d, [])]
        if x and y: out.append(np.mean(x) - np.mean(y))
    base = np.mean([r['fade'] - r['flip'] for r in Ra]) - np.mean([r['fade'] - r['flip'] for r in Rb])
    return float(base), float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))

def main():
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= RP.SPLIT]; rng = np.random.default_rng(SEED)
    fmt = lambda g: 'n/a' if g is None else f"n={g['n']:4d} fade {g['fade']:6.2f} flip {g['flip']:6.2f} fade-flip {g['m']:6.2f} [{g['lo']:6.2f},{g['hi']:6.2f}]"
    for (m, q) in SETTINGS:
        stats = [SP.thrust(s['a'], m) for s in ex]; real, ctl = [], []
        for si, s in enumerate(ex):
            thr = SP.thresholds(stats, si, q)
            if thr is None: continue
            a = s['a']
            for r in evaluate(a, SP.detect(a, stats[si], thr, m)): r['d'] = s['d']; real.append(r)
            for r in evaluate(a, SP.detect_noreturn(a, stats[si], thr, m)): r['d'] = s['d']; ctl.append(r)
        print(f"\n=== M={m} Q={q}: real marks {len(real)}, no-return control {len(ctl)} ===")
        for nm, sel in (('ALL spikes', lambda r: True), ('AGAINST the day drift (primary)', lambda r: r['against']), ('WITH the day drift', lambda r: not r['against']), ('spike LOWS (fade long)', lambda r: r['D'] == 1), ('spike HIGHS (fade short)', lambda r: r['D'] == -1)):
            A = [r for r in real if sel(r)]; B = [r for r in ctl if sel(r)]
            print(f"  {nm:32s} REAL    {fmt(group_stats(A, rng))}"); print(f"  {'':32s} CONTROL {fmt(group_stats(B, rng))}")
            if A and B and nm.startswith(('ALL', 'AGAINST', 'WITH')): d, lo, hi = did(A, B, rng); print(f"  {'':32s} difference real - control {d:6.2f} [{lo:6.2f},{hi:6.2f}]")
if __name__ == '__main__': main()
