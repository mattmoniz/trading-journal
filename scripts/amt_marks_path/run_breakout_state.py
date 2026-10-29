"""Breakout-state test (PREREG_BREAKOUT_STATE.md frozen 2026-10-29). EXPLORE only. Usage: ../../venv/bin/python run_breakout_state.py"""
import sys, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_exhaust'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_path'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import engine as E, run_path as RP, run_context as RC
SHIFTS = (-0.6, -0.3, 0.3, 0.6); SEED = 20261029; BOOT = 3000; N = 390

def detect(a, level, d, A, medmove):
    """First bar at which the last A closes are all beyond `level` (d=+1 above, -1 below); returns (ta, push) or None."""
    c = a['c']; run = 0
    for t in range(N):
        if np.isnan(c[t]): run = 0; continue
        run = run + 1 if (c[t] > level if d == 1 else c[t] < level) else 0
        if run >= A and t >= 30 and not np.isnan(c[t - 30]):
            return t, bool(d * (c[t] - c[t - 30]) >= medmove[t])
    return None

def outcome(a, ta, d, level, atr, L):
    e = ta + 1
    if e > RP.E_HI or np.isnan(a['o'][e]): return None
    o, h, l, c = a['o'], a['h'], a['l'], a['c']; entry = o[e]; r = {}
    for hh in (60, 120):
        j = e + hh - 1; r[f'm{hh}'] = d * (c[j] - entry) / atr if j <= 389 and not np.isnan(c[j]) else np.nan
    r['mclose'] = d * (c[389] - entry) / atr if not np.isnan(c[389]) else np.nan
    mfe = 0.0; fail60 = False
    for i in range(e, N):
        if np.isnan(h[i]) or np.isnan(l[i]): continue
        mfe = max(mfe, (h[i] - entry) if d == 1 else (entry - l[i]))
        if not np.isnan(c[i]) and ((c[i] <= level) if d == 1 else (c[i] >= level)):
            fail60 = fail60 or (i - e < 60); break
    r['cap'] = bool(mfe >= L); r['fail60'] = fail60; return r

def bdiff(Ra, Rb, key, rng, it=BOOT):
    ga, gb = {}, {}
    for r in Ra:
        if not np.isnan(r[key]): ga.setdefault(r['d'], []).append(r[key])
    for r in Rb:
        if not np.isnan(r[key]): gb.setdefault(r['d'], []).append(r[key])
    if not ga or not gb: return float('nan'), float('nan'), float('nan')
    days = sorted(set(ga) | set(gb)); out = []
    for _ in range(it):
        pick = [days[j] for j in rng.integers(0, len(days), len(days))]; x = [v for d in pick for v in ga.get(d, [])]; y = [v for d in pick for v in gb.get(d, [])]
        if x and y: out.append(np.mean(x) - np.mean(y))
    base = np.mean([v for l in ga.values() for v in l]) - np.mean([v for l in gb.values() for v in l]); return float(base), float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))

def build(A):
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= RP.SPLIT]; ON = RC.overnight_table()
    rngs = np.array([float(np.nanmax(s['a']['h']) - np.nanmin(s['a']['l'])) for s in ex]); atr20 = {i: float(np.mean(rngs[i - 20:i])) for i in range(20, len(ex))}; Lscale = 50.0 / float(np.median(list(atr20.values())))
    ratio = {i: float(np.mean(rngs[i - 5:i]) / np.mean(rngs[i - 60:i])) for i in range(60, len(ex))}
    mm = []                                                                                                   # per-session |30-bar move| arrays for the same-bar median over the prior 20 sessions
    for s in ex:
        c = s['a']['c']; x = np.full(N, np.nan); x[30:] = np.abs(c[30:] - c[:-30]); mm.append(x)
    real, plc = [], []
    for si, s in enumerate(ex):
        if si < 100 or s['d'] not in ON: continue
        prior = [ratio[j] for j in range(max(60, si - 250), si)]
        if len(prior) < 40: continue
        bal = bool(np.mean([p <= ratio[si] for p in prior]) <= 1 / 3); atr = atr20[si]; a = s['a']; medmove = np.nanmedian(np.array([mm[j] for j in range(si - 20, si)]), axis=0); on = ON[s['d']]
        for d, lvl in ((1, on['hi']), (-1, on['lo'])):
            for shift, bucket in [(0.0, real)] + [(sh, plc) for sh in SHIFTS]:
                level = lvl + shift * atr * d if False else lvl + shift * atr; ev = detect(a, level, d, A, medmove)
                if ev is None: continue
                ta, push = ev; r = outcome(a, ta, d, level, atr, Lscale * atr)
                if r is None: continue
                bucket.append(dict(d=s['d'], dir=d, push=push, bal=bal, era='PRE' if s['d'] < RP.PRE_END else 'POST', **r))
    return real, plc

def report(real, plc, rng, A, full=True):
    G = {'A&P&BAL (counted)': lambda r: r['push'] and r['bal'], 'A&P&NOT-BAL': lambda r: r['push'] and not r['bal'], 'A&NO-PUSH': lambda r: not r['push'], 'A&P (all)': lambda r: r['push']}
    print(f'\n=== A={A}: real events {len(real)} (up {sum(r["dir"] == 1 for r in real)}, down {sum(r["dir"] == -1 for r in real)}), shifted-level placebo events {len(plc)} ===')
    for nm, sel in G.items():
        R = [r for r in real if sel(r)]; P = [r for r in plc if sel(r)]
        if len(R) < 10: print(f'  {nm:22s} n={len(R)} (too few)'); continue
        d60 = bdiff(R, P, 'm60', rng); d120 = bdiff(R, P, 'm120', rng); dcl = bdiff(R, P, 'mclose', rng)
        pre = [r['m120'] for r in R if r['era'] == 'PRE' and not np.isnan(r['m120'])]; post = [r['m120'] for r in R if r['era'] == 'POST' and not np.isnan(r['m120'])]; ppre = [r['m120'] for r in P if r['era'] == 'PRE' and not np.isnan(r['m120'])]; ppost = [r['m120'] for r in P if r['era'] == 'POST' and not np.isnan(r['m120'])]
        byday = {}
        for r in R:
            if not np.isnan(r['m120']): byday[r['d']] = byday.get(r['d'], 0) + r['m120']
        dv = sorted(byday.values(), reverse=True); tot = sum(dv); share = sum(dv[:5]) / tot if tot > 0 else float('nan')
        print(f"  {nm:22s} n={len(R):4d} days={len(set(r['d'] for r in R)):3d} | move +60 {np.nanmean([r['m60'] for r in R]):+.3f} +120 {np.nanmean([r['m120'] for r in R]):+.3f} close {np.nanmean([r['mclose'] for r in R]):+.3f} ATR20 | large-capture {100 * np.mean([r['cap'] for r in R]):3.0f}% (placebo {100 * np.mean([r['cap'] for r in P]):3.0f}%) fail<60min {100 * np.mean([r['fail60'] for r in R]):3.0f}% (placebo {100 * np.mean([r['fail60'] for r in P]):3.0f}%)")
        print(f"  {'':22s} minus placebo: +60 {d60[0]:+.3f} [{d60[1]:+.3f},{d60[2]:+.3f}] +120 {d120[0]:+.3f} [{d120[1]:+.3f},{d120[2]:+.3f}] close {dcl[0]:+.3f} [{dcl[1]:+.3f},{dcl[2]:+.3f}] | PRE {np.mean(pre) - np.mean(ppre) if pre and ppre else float('nan'):+.3f} POST {np.mean(post) - np.mean(ppost) if post and ppost else float('nan'):+.3f} top5 {100 * share:3.0f}%")
    if full:
        Rb = [r for r in real if r['push'] and r['bal']]; Rn = [r for r in real if r['push'] and not r['bal']]; d = bdiff(Rb, Rn, 'm120', rng); print(f"  COUNTED (3): A&P&BAL minus A&P&NOT-BAL at +120: {d[0]:+.3f} [{d[1]:+.3f},{d[2]:+.3f}]")
        for dd, nm in ((1, 'UP breaks'), (-1, 'DOWN breaks')):
            R = [r for r in real if r['push'] and r['bal'] and r['dir'] == dd]; P = [r for r in plc if r['push'] and r['bal'] and r['dir'] == dd]
            if len(R) >= 10: d = bdiff(R, P, 'm120', rng); print(f"  {nm} A&P&BAL n={len(R)} minus placebo +120: {d[0]:+.3f} [{d[1]:+.3f},{d[2]:+.3f}]")

def main():
    rng = np.random.default_rng(SEED)
    for A in (30, 15, 60):
        real, plc = build(A); report(real, plc, rng, A, full=(A == 30))
if __name__ == '__main__': main()
