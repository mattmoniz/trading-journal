"""Walk-forward context gate on the with-trend spike rule (PREREG_GATE.md frozen 2026-10-29). EXPLORE only. Usage: ../../venv/bin/python run_gate.py"""
import sys, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_exhaust'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_path'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import run_path as RP, run_context as RC
from sklearn.linear_model import Ridge
SEED = 20261029; BOOT = 3000; MIN_PRIOR = 100; MIN_RIDGE = 150; REPS = 50
FE = ['es', 'rvol', 'volnow', 'rngr', 'on_vol_rel', 'on_range_rel', 'on_pos', 'on_va', 'va_pos', 'gap_rel', 'u', 'size_ratio']

def feat(r): return [np.log(r[f]) if f in ('rvol', 'volnow', 'rngr') else r[f] for f in FE]

def process(marks, mode):
    """marks: dicts with en, xi, net (the with-drift trade of an allowed mark). One position at a time. S1 first only; S2 re-entry after an exit that is not the flatten."""
    tot = 0.0; n = 0; pos_exit = -1
    for m in sorted(marks, key=lambda x: x['en']):
        if m['en'] <= pos_exit: continue
        tot += m['net']; n += 1; pos_exit = m['xi']
        if mode == 'S1' or pos_exit >= RP.FLAT: break
    return tot, n

def main():
    rows = RC.build(); nsess = RC.NSESS; rng = np.random.default_rng(SEED); Q = [r for r in rows if r['D'] == r['dsign']]
    for r in Q: r['net'] = r['fade']; r['xi'] = r['wd_xi']                                  # qualifying = against-drift spike, trade with the drift = the fade
    dates = sorted(set(r['d'] for r in Q)); allsess = nsess; by = {}
    for r in Q: by.setdefault(r['d'], []).append(r)
    print(f'qualifying marks {len(Q)} on {len(dates)} sessions of {allsess}')
    # walk-forward gate decisions
    prior = []; decisions = {}; ridge = None; ridge_month = None; mu = sd = None
    for d in dates:
        marks = by[d]; allow = {g: [True] * len(marks) for g in ('G1', 'G2', 'G3', 'G4', 'G5')}
        if len(prior) >= MIN_PRIOR:
            cut = lambda key: np.nanquantile([p[key] for p in prior], 1 / 3)
            c_es, c_ov, c_or = cut('es'), cut('on_vol_rel'), cut('on_range_rel')
            if ridge is None or ridge_month != d[:7]:
                if len(prior) >= MIN_RIDGE:
                    X = np.array([feat(p) for p in prior], float); y = np.array([p['net'] for p in prior]); med = np.nanmedian(X, 0); X = np.where(np.isnan(X), med, X); mu = X.mean(0); sd = X.std(0); sd[sd == 0] = 1
                    ridge = Ridge(alpha=10.0).fit((X - mu) / sd, y); ridge_med = med; ridge_month = d[:7]
            for i, m in enumerate(marks):
                low_es = m['es'] <= c_es; low_ov = (m['on_vol_rel'] <= c_ov) if np.isfinite(m['on_vol_rel']) else False; low_or = m['on_range_rel'] <= c_or
                allow['G1'][i] = not low_es; allow['G2'][i] = not low_ov; allow['G3'][i] = not low_or; allow['G4'][i] = not (low_es or low_ov)
                if ridge is not None:
                    x = np.array(feat(m), float); x = np.where(np.isnan(x), ridge_med, x); allow['G5'][i] = bool(ridge.predict(((x - mu) / sd).reshape(1, -1))[0] > 0)
        decisions[d] = allow; prior.extend(marks)
    skip = {g: np.mean([not a for d in dates for a in decisions[d][g]]) for g in ('G1', 'G2', 'G3', 'G4', 'G5')}
    def run(mode, sel):
        out = {}
        for d in dates:
            ms = [m for i, m in enumerate(by[d]) if sel(d, i)]; out[d] = process(ms, mode)
        return out
    def daily(res): return {d: res[d][0] for d in dates}
    for mode in ('S1', 'S2'):
        print(f'\n=== {mode} ({"first allowed mark per session" if mode == "S1" else "re-entry after a stop"}), mean P&L over ALL {allsess} sessions ===')
        base = run(mode, lambda d, i: True); bd = daily(base)
        def line(nm, res, sk):
            dd = daily(res); tr = sum(res[d][1] for d in dates); tot = sum(dd.values()); wins = np.mean([v > 0 for v in dd.values() if v != 0]) if any(v != 0 for v in dd.values()) else float('nan'); cum = np.cumsum([dd[d] for d in dates]); mdd = float(np.max(np.maximum.accumulate(cum) - cum))
            print(f"  {nm:14s} skip {100 * sk:3.0f}% trades {tr:4d} per trade {tot / tr if tr else float('nan'):6.2f}$ | per session {tot / allsess:6.2f}$ | win days {100 * wins:3.0f}% worst {min(dd.values()):8.2f}$ max drawdown {mdd:8.2f}$")
        line('UNGATED', base, 0.0)
        gres = {}
        for g in ('G1', 'G2', 'G3', 'G4', 'G5'):
            gres[g] = run(mode, lambda d, i, g=g: decisions[d][g][i]); line(g, gres[g], skip[g])
        # random-skip control at the G1 skip rate
        rs = []
        for _ in range(REPS):
            ska = {d: [rng.random() >= skip['G1'] for _ in by[d]] for d in dates}; r = run(mode, lambda d, i: ska[d][i]); rs.append(daily(r))
        rsd = {d: float(np.mean([x[d] for x in rs])) for d in dates}; print(f"  {'RANDOM-SKIP':14s} skip {100 * skip['G1']:3.0f}% (mean of {REPS} reps)          per session {sum(rsd.values()) / allsess:6.2f}$")
        pad = lambda dd: [dd.get(d, 0.0) for d in dates]
        allday = {d: i for i, d in enumerate(dates)}; days_all = dates
        for g in ('G1', 'G2', 'G3', 'G4', 'G5'):
            gd = daily(gres[g]); diff = [gd[d] - bd[d] for d in dates]; diffr = [gd[d] - rsd[d] for d in dates]
            m1 = RP.boot(diff, dates, rng, BOOT); m2 = RP.boot(diffr, dates, rng, BOOT); pre = [x for d, x in zip(dates, diff) if d < RP.PRE_END]; post = [x for d, x in zip(dates, diff) if d >= RP.PRE_END]
            # per-session means over ALL sessions: scale the traded-day mean by traded days / all sessions
            sc = len(dates) / allsess
            print(f"  {g} minus UNGATED {m1[0] * sc:6.2f}$/session [{m1[1] * sc:6.2f},{m1[2] * sc:6.2f}]  minus RANDOM-SKIP {m2[0] * sc:6.2f} [{m2[1] * sc:6.2f},{m2[2] * sc:6.2f}]  PRE {np.mean(pre) * sc if pre else float('nan'):6.2f} POST {np.mean(post) * sc if post else float('nan'):6.2f}" + ('   <== COUNTED' if g == 'G1' and mode == 'S2' else ''))
if __name__ == '__main__': main()
