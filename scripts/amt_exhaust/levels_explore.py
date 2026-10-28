"""Which level types / confluences carry the explore at-level exhaustion effect? EXPLORE ONLY, descriptive, hypothesis-generating; the hold-out is consumed and must not be used. Usage: ../../venv/bin/python levels_explore.py"""
import numpy as np, pandas as pd
CUT = 0.030821; rng = np.random.default_rng(20261028)
df = pd.read_csv('events_explore_wide.csv'); lvl = [c[5:] for c in df.columns if c.startswith('dist_')]
def ci(v, d):
    g = {}
    for x, k in zip(v, d): g.setdefault(k, []).append(x)
    a = [np.array(x) for x in g.values()]
    if len(a) < 3: return float('nan'), float('nan')
    m = [np.concatenate([a[j] for j in rng.integers(0, len(a), len(a))]).mean() for _ in range(1500)]; return np.percentile(m, 2.5), np.percentile(m, 97.5)
for grp in ('E1', 'E2'):
    e = df[(df.grp == grp) & df.F15.notna()].copy(); print(f"\n=== {grp} (widened push, explore): N={len(e)}; at-level cut {CUT} ATR20 (about {CUT * 293:.0f} pts) ===")
    print('  by nearest level type, events within the cut of THAT level (an event can count for several levels if they overlap):')
    rows = []
    for L in lvl:
        s = e[e['dist_' + L] <= CUT]
        if len(s) == 0: continue
        lo, hi = ci(s.F15, s.date); rows.append((L, len(s), s.date.nunique(), s.F15.mean(), lo, hi, 100 * (s.F15 > 0).mean()))
    for L, n, nd, m, lo, hi, w in sorted(rows, key=lambda r: -r[3]): print(f"    {L:6s} N={n:3d} days={nd:3d} mean F15 {m:+7.2f} (CI {lo:+7.2f}..{hi:+7.2f}) positive {w:.0f}%")
    print('  by confluence (number of distinct levels within the cut of the extreme):')
    for lab, s in (('0 levels (not at level)', e[e.n_conf == 0]), ('1 level', e[e.n_conf == 1]), ('2+ levels (confluence)', e[e.n_conf >= 2])):
        if len(s) < 5: print(f"    {lab}: N={len(s)}"); continue
        lo, hi = ci(s.F15, s.date); print(f"    {lab}: N={len(s)} mean F15 {s.F15.mean():+.2f} (CI {lo:+.2f}..{hi:+.2f})")
    fam = {'value area edges (pdVAH, pdVAL)': ['pdVAH', 'pdVAL'], 'POC': ['POC'] if 'POC' in lvl else ['pdPOC'], 'prior-day high/low': ['pdH', 'pdL'], 'overnight high/low': ['ONH', 'ONL'], 'IB high/low (after 10:30)': ['IBH', 'IBL']}
    print('  by level family (any level of the family within the cut):')
    for nm, ls in fam.items():
        ls = [x for x in ls if x in lvl]
        if not ls: continue
        mask = np.zeros(len(e), bool)
        for x in ls: mask |= (e['dist_' + x] <= CUT).to_numpy()
        s = e[mask]
        if len(s) >= 5: lo, hi = ci(s.F15, s.date); print(f"    {nm:34s} N={len(s):3d} mean F15 {s.F15.mean():+7.2f} (CI {lo:+7.2f}..{hi:+7.2f})")
print("\nNote: about 25+ cells per group on a few dozen events each; with a hold-out that reversed the pooled hint (-10 pts), none of these cells can be trusted; they only show how thin the data are.")
