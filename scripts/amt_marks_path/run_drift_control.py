"""Drift-direction control (PREREG.md Amendment 3). EXPLORE only. Usage: ../../venv/bin/python run_drift_control.py"""
import sys, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_exhaust'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_path')
import engine as E, spike as SP, run_path as RP
TRIALS = 50; SEED = 20261029

def net_dd(a, e, dd, risk):
    o = a['o']
    if np.isnan(o[e]): return None
    entry = o[e] + dd * RP.SLIP; r = RP.sim(a, e, dd, entry - dd * risk)
    return None if r is None else r['pts'] * RP.DPP - RP.COMM

def main():
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= RP.SPLIT]; rng = np.random.default_rng(SEED)
    stats = [SP.thrust(s['a']) for s in ex]; rows = []
    for si, s in enumerate(ex):
        thr = SP.thresholds(stats, si)
        if thr is None: continue
        a = s['a']; o0 = a['o'][0]
        for e in SP.detect(a, stats[si], thr):
            D = e['dir']; en = e['u'] + 1
            if not (RP.E_LO <= en <= RP.E_HI) or np.isnan(a['o'][en]): continue
            risk = D * (a['o'][en] + D * RP.SLIP - (e['ext'] - D * RP.TICK))
            if risk <= 0: continue
            dd = 1 if a['c'][e['u']] > o0 else -1; real = net_dd(a, en, dd, risk)
            if real is None: continue
            A, B = [], []
            for _ in range(TRIALS):
                e2 = int(rng.integers(RP.E_LO, RP.E_HI + 1)); d2 = 1 if a['c'][e2 - 1] > o0 else -1; v = net_dd(a, e2, d2, risk)
                if v is not None: A.append(v)
                lo, hi = max(RP.E_LO, en - 30), min(RP.E_HI, en + 30); e3 = int(rng.integers(lo, hi + 1))
                if e3 != en:
                    d3 = 1 if a['c'][e3 - 1] > o0 else -1; v = net_dd(a, e3, d3, risk)
                    if v is not None: B.append(v)
            if len(A) < 10 or len(B) < 10: continue
            rows.append(dict(d=s['d'], real=real, A=float(np.mean(A)), B=float(np.mean(B)), against=(dd == D), era='PRE' if s['d'] < RP.PRE_END else 'POST'))
    print(f'events {len(rows)}')
    def cell(name, R):
        if not R: print(name, 'n=0'); return
        days = [r['d'] for r in R]; ma = RP.boot([r['real'] - r['A'] for r in R], days, rng, RP.BOOT); mb = RP.boot([r['real'] - r['B'] for r in R], days, rng, RP.BOOT)
        pre = [r['real'] - r['B'] for r in R if r['era'] == 'PRE']; post = [r['real'] - r['B'] for r in R if r['era'] == 'POST']
        print(f"{name:34s} n={len(R):4d} | drift-direction trade at the mark {np.mean([r['real'] for r in R]):6.2f}$ | uniform {np.mean([r['A'] for r in R]):6.2f} time-matched {np.mean([r['B'] for r in R]):6.2f} | real-uniform {ma[0]:6.2f} [{ma[1]:6.2f},{ma[2]:6.2f}] | real-timematched {mb[0]:6.2f} [{mb[1]:6.2f},{mb[2]:6.2f}] PRE {np.mean(pre) if pre else float('nan'):6.2f} POST {np.mean(post) if post else float('nan'):6.2f}")
    cell('ALL marks', rows); cell('against-drift marks (fade = with drift)', [r for r in rows if r['against']]); cell('with-drift marks (fade = against drift)', [r for r in rows if not r['against']])
if __name__ == '__main__': main()
