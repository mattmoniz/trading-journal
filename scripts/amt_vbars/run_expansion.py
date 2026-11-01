"""Expansion-detector test for the tell (PREREG_EXPANSION.md frozen 2026-11-01). EXPLORE ONLY. Usage: ../../venv/bin/python run_expansion.py"""
import numpy as np, pandas as pd
SEED, BOOT = 20261101, 2000
df = pd.read_csv('decision_points_explore.csv')
for c in ('moving', 'nodes', 'fast', 'flip', 'osc', 'strides', 'brk'): df[c] = df[c].astype(str).str.lower().eq('true')
df['E'] = df.mfe + df.mae; df['A'] = df.mfe - df.mae; df['B'] = df.brk.astype(float)
tell = df[df.ncomp == 5]; cm = df[df.moving & (df.ncomp < 5)]; cn = df[(~df.nodes) & df.fast & df.flip & df.osc & df.strides]
print(f"points: TELL {len(tell)} on {tell.date.nunique()} dates; CONTROL_MOVING {len(cm)} on {cm.date.nunique()}; CONTROL_NONODE {len(cn)} on {cn.date.nunique()}")
for s in (0, 1, 2): print(f"  stratum {s}: tell {int((tell.stratum == s).sum())}, moving {int((cm.stratum == s).sum())}, nonode {int((cn.stratum == s).sum())}")

def wdiff(t, c, col, w):
    tot = 0.0
    for s in (0, 1, 2):
        a, b = t[t.stratum == s][col], c[c.stratum == s][col]
        if len(a) == 0 or len(b) == 0: return np.nan
        tot += w[s] * (a.mean() - b.mean())
    return tot

def agg(x, col, dts):
    idx = {d: i for i, d in enumerate(dts)}; S = np.zeros((len(dts), 3)); N = np.zeros((len(dts), 3))
    for (d, st), g in x.groupby(['date', 'stratum']): S[idx[d], st] = g[col].sum(); N[idx[d], st] = len(g)
    return S, N

def ci(t, c, col, rng):
    dts = sorted(set(t.date) | set(c.date)); St, Nt = agg(t, col, dts); Sc, Nc = agg(c, col, dts); D = len(dts); out = []
    for _ in range(BOOT):
        wgt = np.bincount(rng.integers(0, D, D), minlength=D).astype(float)
        nt, ncc = wgt @ Nt, wgt @ Nc
        if (nt == 0).any() or (ncc == 0).any(): continue
        w_ = nt / nt.sum(); out.append(float(np.sum(w_ * ((wgt @ St) / nt - (wgt @ Sc) / ncc))))
    return float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))

rng = np.random.default_rng(SEED); w = tell.stratum.value_counts(normalize=True).to_dict(); w = {s: w.get(s, 0.0) for s in (0, 1, 2)}
med = sorted(tell.date)[len(tell) // 2]; res = {}
for cname, ctl in (('CONTROL_MOVING', cm), ('CONTROL_NONODE', cn)):
    print(f"\n=== TELL minus {cname} (tell-mix-weighted over distance strata; per-point means; day-blocked CI) ===")
    for col, lab in (('E', 'E range travelled (ATR20)'), ('A', 'A directional asymmetry mfe-mae'), ('fwd', 'fwd signed 60m move'), ('B', 'break rate')):
        d = wdiff(tell, ctl, col, w); lo, hi = ci(tell, ctl, col, rng)
        h1 = wdiff(tell[tell.date < med], ctl[ctl.date < med], col, w); h2 = wdiff(tell[tell.date >= med], ctl[ctl.date >= med], col, w)
        print(f"  {lab:34s} tell {tell[col].mean():+.4f} ctl {ctl[col].mean():+.4f}  weighted diff {d:+.4f} CI [{lo:+.4f}, {hi:+.4f}]  halves {h1:+.4f}/{h2:+.4f}")
        res[(cname, col)] = (d, lo, hi, h1, h2)
ok = lambda k: res[k][1] > 0 and res[k][3] > 0 and res[k][4] > 0
n_ok = len(tell) >= 200 and tell.date.nunique() >= 100
print(f"\nREADING: expansion detector vs moving-only: {'YES' if ok(('CONTROL_MOVING', 'E')) and n_ok else 'not shown'}; ladder marginal over non-node components on E: {'YES' if ok(('CONTROL_NONODE', 'E')) else 'not shown'}; direction asymmetry A vs moving-only CI excludes zero: {'YES' if res[('CONTROL_MOVING', 'A')][1] > 0 or res[('CONTROL_MOVING', 'A')][2] < 0 else 'no (coin-flip side not shown to differ)'}")
