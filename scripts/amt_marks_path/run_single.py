"""Single-position day-level test (PREREG_SINGLE.md frozen 2026-10-29). Usage: ../../venv/bin/python run_single.py [--sizes]   (explore)
The sealed hold-out look is guarded: HOLDOUT_OK=1 ../../venv/bin/python run_single.py --holdout   (refuses without the variable, writes holdout_single.lock, can be used ONCE)."""
import sys, os, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_exhaust'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_path')
import engine as E, spike as SP, run_path as RP
REPS = 50; SEED = 20261029; LOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'holdout_single.lock')

def process(marks, mode):
    """marks: list of dict(en, D, r) sorted by en, r = sim result (pts, xi). One position at a time. S1 = first valid mark only; S2 = re-entry after an exit that is not the flatten. Returns list of net dollars."""
    out = []; pos_exit = -1
    for m in sorted(marks, key=lambda x: x['en']):
        if m['en'] <= pos_exit: continue
        out.append(m['r']['pts'] * RP.DPP - RP.COMM); pos_exit = m['r']['xi']
        if mode == 'S1' or pos_exit >= RP.FLAT: break
    return out

def session_rows(a, evs, rng, pre_end):
    o0 = a['o'][0]; c = a['c']; real = []; pseudo_specs = []
    for e in evs:
        D = e['dir']; u = e['u']; en = u + 1
        if not (RP.E_LO <= en <= RP.E_HI) or np.isnan(a['o'][en]): continue
        dsign = 1 if c[u] > o0 else -1
        if D != dsign: continue                                                    # qualifying: the spike was AGAINST the day drift, trade = with the drift = D
        stop = e['ext'] - D * RP.TICK; r = RP.sim(a, en, D, stop)
        if r is None: continue
        risk = D * (r['entry'] - stop); real.append(dict(en=en, D=D, r=r)); pseudo_specs.append((en, risk))
    return real, pseudo_specs

def pseudo_marks(a, pseudo_specs, rng):
    o0 = a['o'][0]; c = a['c']; out = []
    for en, risk in pseudo_specs:
        lo, hi = max(RP.E_LO, en - 30), min(RP.E_HI, en + 30); e3 = int(rng.integers(lo, hi + 1))
        if e3 == en or np.isnan(a['o'][e3]): continue
        d3 = 1 if c[e3 - 1] > o0 else -1; entry = a['o'][e3] + d3 * RP.SLIP; r = RP.sim(a, e3, d3, entry - d3 * risk)
        if r is not None: out.append(dict(en=e3, D=d3, r=r))
    return out

def run(sessions, m, q, rng, label):
    stats = [SP.thrust(s['a'], m) for s in sessions]; rows = []; nsess = 0
    for si, s in enumerate(sessions):
        thr = SP.thresholds(stats, si, q)
        if thr is None: continue
        nsess += 1; a = s['a']; evs = SP.detect(a, stats[si], thr, m); real, specs = session_rows(a, evs, rng, RP.PRE_END)
        if not real: continue
        row = dict(d=s['d'], n_qual=len(real))
        for mode in ('S1', 'S2'):
            tr = process(real, mode); row[mode] = float(sum(tr)); row[mode + '_n'] = len(tr)
            pl = []
            for _ in range(REPS):
                pm = pseudo_marks(a, specs, rng); pl.append(sum(process(pm, mode)) if pm else 0.0)
            row[mode + '_plc'] = float(np.mean(pl))
        rows.append(row)
    return rows, nsess

def report(rows, nsess, rng, label, boot=True):
    print(f'\n=== {label}: sessions with thresholds {nsess}, sessions with a qualifying mark {len(rows)} ===')
    for mode in ('S1', 'S2'):
        P = [r[mode] for r in rows]; PL = [r[mode + '_plc'] for r in rows]; N = [r[mode + '_n'] for r in rows]; diff = [p - q for p, q in zip(P, PL)]
        days = [r['d'] for r in rows]; cum = np.cumsum([r[mode] for r in sorted(rows, key=lambda x: x['d'])]); dd = float(np.max(np.maximum.accumulate(cum) - cum)) if len(cum) else 0.0
        pre = [x for r, x in zip(rows, diff) if r['d'] < RP.PRE_END]; post = [x for r, x in zip(rows, diff) if r['d'] >= RP.PRE_END]
        tr = sum(N); trade_net = sum(P) / tr if tr else float('nan')
        line = f"{mode}: trades {tr}, traded days {sum(1 for n in N if n)}, mean net/trade {trade_net:6.2f}$, mean daily P&L (traded days) {np.mean(P):6.2f}$ median {np.median(P):6.2f}, win days {100 * np.mean([p > 0 for p in P]):3.0f}%, worst day {min(P):7.2f}$, max drawdown {dd:8.2f}$, mean over ALL sessions {sum(P) / nsess:5.2f}$ | placebo daily {np.mean(PL):6.2f}$"
        if boot:
            m_, lo, hi = RP.boot(diff, days, rng, RP.BOOT); line += f" | real-placebo per traded day {m_:6.2f} [{lo:6.2f},{hi:6.2f}] PRE {np.mean(pre) if pre else float('nan'):6.2f} POST {np.mean(post) if post else float('nan'):6.2f}"
        else: line += f" | real-placebo {np.mean(diff):6.2f}"
        print(line)

def main():
    raw = E.load_sessions(); allS = E.build_eligible(raw); rng = np.random.default_rng(SEED)
    if '--holdout' in sys.argv:
        if os.environ.get('HOLDOUT_OK') != '1' or os.path.exists(LOCK): print('REFUSED: the sealed look needs HOLDOUT_OK=1 and can be used once (lock file).'); sys.exit(3)
        open(LOCK, 'w').write('spent\n'); rows, nsess = run([s for s in allS if s['d'] > RP.SPLIT or True], 5, 75, rng, 'HOLD-OUT')   # thresholds need the prior sessions; only post-split rows are reported
        rows = [r for r in rows if r['d'] > RP.SPLIT]; report(rows, sum(1 for s in allS if s['d'] > RP.SPLIT), rng, 'SEALED HOLD-OUT (post 2025-05-16), primary = S1'); return
    ex = [s for s in allS if s['d'] <= RP.SPLIT]; rows, nsess = run(ex, 5, 75, rng, 'explore'); report(rows, nsess, rng, 'EXPLORE M=5 Q=75')
    if '--sizes' in sys.argv:
        for m, q in ((3, 75), (8, 75), (5, 65), (5, 85)):
            r2, n2 = run(ex, m, q, rng, f'M={m} Q={q}'); report(r2, n2, rng, f'EXPLORE M={m} Q={q} (sign check)', boot=False)
if __name__ == '__main__': main()
