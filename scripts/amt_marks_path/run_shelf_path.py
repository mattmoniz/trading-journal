"""Shelf stage 2: trade test with the spike-study controls (scripts/amt_absorb/PREREG_SHELF.md). EXPLORE only. Usage: ../../venv/bin/python run_shelf_path.py"""
import sys, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_absorb'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_path')
import engine as E, shelf as SH, run_path as RP, run_drift_control as DC
TRIALS = 50; SEED = 20261029

def main():
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= RP.SPLIT]; rng = np.random.default_rng(SEED)
    Rs = [SH.ranges(s['a']) for s in ex]; rows = []; nshelf = 0
    for si, s in enumerate(ex):
        thr = SH.thresholds(Rs, si)
        if thr is None: continue
        a = s['a']; o0 = a['o'][0]; c = a['c']
        for sh in SH.shelves(a, Rs[si], thr, E.atr14(a)):
            nshelf += 1; b = SH.breaks(a, sh, o0)
            if b is None: continue
            D = b['brk']; en = b['u'] + 1
            if not (RP.E_LO <= en <= RP.E_HI) or np.isnan(a['o'][en]): continue
            stop = (sh['lo'] - RP.TICK) if D == 1 else (sh['hi'] + RP.TICK); entry = a['o'][en] + D * RP.SLIP
            if D * (entry - stop) <= 0: continue
            risk = D * (entry - stop); r = RP.sim(a, en, D, stop)
            if r is None: continue
            Df = -D; enF = a['o'][en] + Df * RP.SLIP; rF = RP.sim(a, en, Df, enF - Df * risk)
            if rF is None: continue
            A, B = [], []
            for _ in range(TRIALS):
                e2 = int(rng.integers(RP.E_LO, RP.E_HI + 1)); d2 = 1 if c[e2 - 1] > o0 else -1; v = DC.net_dd(a, e2, d2, risk)
                if v is not None: A.append(v)
                lo, hi = max(RP.E_LO, en - 30), min(RP.E_HI, en + 30); e3 = int(rng.integers(lo, hi + 1))
                if e3 != en:
                    d3 = 1 if c[e3 - 1] > o0 else -1; v = DC.net_dd(a, e3, d3, risk)
                    if v is not None: B.append(v)
            if len(A) < 10 or len(B) < 10: continue
            rows.append(dict(d=s['d'], with_drift=b['with_drift'], real=r['pts'] * RP.DPP - RP.COMM, flip=rF['pts'] * RP.DPP - RP.COMM, A=float(np.mean(A)), B=float(np.mean(B)), risk=risk, hit=r['hit'], era='PRE' if s['d'] < RP.PRE_END else 'POST'))
    print(f'shelves {nshelf}, shelves with a break inside 20 bars and a valid trade {len(rows)}')
    def cell(name, R):
        if not R: print(name, 'n=0'); return
        days = [r['d'] for r in R]; f = lambda t: f"{t[0]:6.2f} [{t[1]:6.2f},{t[2]:6.2f}]"
        dA = RP.boot([r['real'] - r['A'] for r in R], days, rng, RP.BOOT); dB = RP.boot([r['real'] - r['B'] for r in R], days, rng, RP.BOOT); dF = RP.boot([r['real'] - r['flip'] for r in R], days, rng, RP.BOOT)
        pre = [r['real'] - r['B'] for r in R if r['era'] == 'PRE']; post = [r['real'] - r['B'] for r in R if r['era'] == 'POST']
        print(f"{name:44s} n={len(R):4d} days={len(set(days)):3d} stop-hit {100 * np.mean([r['hit'] for r in R]):3.0f}% risk {np.median([r['risk'] for r in R]):5.1f}pt | net {np.mean([r['real'] for r in R]):6.2f}$ | uniform {np.mean([r['A'] for r in R]):6.2f} time-matched {np.mean([r['B'] for r in R]):6.2f} flip {np.mean([r['flip'] for r in R]):6.2f}")
        print(f"{'':44s} real-uniform {f(dA)} | real-timematched {f(dB)} | real-flip {f(dF)} | PRE {np.mean(pre) if pre else float('nan'):6.2f} POST {np.mean(post) if post else float('nan'):6.2f}")
    cell('shelf breaks WITH the day drift (primary)', [r for r in rows if r['with_drift']]); cell('shelf breaks AGAINST the day drift', [r for r in rows if not r['with_drift']]); cell('all shelf breaks', rows)
if __name__ == '__main__': main()
