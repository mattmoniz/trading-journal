"""Expansion test at 5/15/30-minute windows (PREREG_EXPANSION.md Amendment 1, frozen 2026-11-01). EXPLORE ONLY. Usage: ../../venv/bin/python run_expansion_horizons.py"""
import glob, os
import numpy as np, pandas as pd
import vbars as V, trade as T
SEED, BOOT = 20261101, 2000
HZ = (300, 900, 1800, 3600)

def sessions():
    dates = sorted(os.path.basename(p)[:10] for p in glob.glob(V.ROOT + '/*.bars.tsv')); dates = [d for d in dates if d <= '2025-05-16']
    sess, stats = {}, {}
    for d in dates:
        try: S = V.load_session(d)
        except Exception: continue
        sess[d] = S; stats[d] = V.session_stats(S)
    ks = sorted(sess); atr = {}
    for i, d in enumerate(ks):
        if i < 20: continue
        rngs = [stats[p][0] for p in ks[i - 20:i] if not np.isnan(stats[p][0])]
        if len(rngs) >= 15: atr[d] = float(np.mean(rngs))
    return sess, atr

def excursions(S, a, i, d, W):
    end, c, h, l, comp = S['end'], S['c'], S['h'], S['l'], S['comp']; ib_done = end[i] >= V.RTH_OPEN + 3600
    on = end < V.RTH_OPEN; onh, onl = float(h[on].max()), float(l[on].min()); ib = (end >= V.RTH_OPEN) & (end < V.RTH_OPEN + 3600)
    ibh = float(h[ib].max()) if ib.any() else None; ibl = float(l[ib].min()) if ib.any() else None
    bd = max(onh, ibh) if (d == 1 and ib_done and ibh is not None) else onh if d == 1 else min(onl, ibl) if (ib_done and ibl is not None) else onl
    hz = (end > end[i]) & (end <= end[i] + W) & comp
    if not hz.any(): return None
    cur = c[i]; j = np.where(hz)[0][-1]; fwd = d * (c[j] - cur) / a
    hi_ = d * ((h[hz] if d == 1 else l[hz]) - cur) / a; adv_ = d * ((l[hz] if d == 1 else h[hz]) - cur) / a
    brk = bool(np.any(c[hz] > bd) if d == 1 else np.any(c[hz] < bd))
    return float(np.max(hi_)), float(-np.min(adv_)), fwd, brk

def agg(x, col, dts):
    idx = {d: k for k, d in enumerate(dts)}; Sm = np.zeros((len(dts), 3)); N = np.zeros((len(dts), 3))
    for (d, st), g in x.groupby(['date', 'stratum']): Sm[idx[d], st] = g[col].sum(); N[idx[d], st] = len(g)
    return Sm, N

def wdiff(t, c, col, w):
    tot = 0.0
    for s in (0, 1, 2):
        a, b = t[t.stratum == s][col], c[c.stratum == s][col]
        if len(a) == 0 or len(b) == 0: return np.nan
        tot += w[s] * (a.mean() - b.mean())
    return tot

def ci(t, c, col, rng):
    dts = sorted(set(t.date) | set(c.date)); St, Nt = agg(t, col, dts); Sc, Nc = agg(c, col, dts); D = len(dts); out = []
    for _ in range(BOOT):
        wgt = np.bincount(rng.integers(0, D, D), minlength=D).astype(float); nt, ncc = wgt @ Nt, wgt @ Nc
        if (nt == 0).any() or (ncc == 0).any(): continue
        out.append(float(np.sum(nt / nt.sum() * ((wgt @ St) / nt - (wgt @ Sc) / ncc))))
    return float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))

def main():
    df0 = pd.read_csv('decision_points_explore.csv')
    for c in ('moving', 'nodes', 'fast', 'flip', 'osc', 'strides', 'brk'): df0[c] = df0[c].astype(str).str.lower().eq('true')
    sess, atr = sessions(); res = {}; n_all = len(df0)
    for W in HZ:
        rows = []
        for r in df0.itertuples():
            if r.date not in atr: rows.append((np.nan,) * 4); continue
            ex = excursions(sess[r.date], atr[r.date], int(r.i), int(r.dir), W); rows.append(ex if ex else (np.nan,) * 4)
        a = np.array(rows, dtype=float); res[W] = a
        if W == 3600:
            m = ~np.isnan(a[:, 0]); print(f"REPRODUCTION at 60 min: rows {m.sum()} of {n_all}; max |mfe diff| {np.max(np.abs(a[m, 0] - df0.mfe.to_numpy()[m])):.2e}, max |mae diff| {np.max(np.abs(a[m, 1] - df0.mae.to_numpy()[m])):.2e}, max |fwd diff| {np.max(np.abs(a[m, 2] - df0.fwd.to_numpy()[m])):.2e}, brk equal {bool(np.all(a[m, 3].astype(bool) == df0.brk.to_numpy()[m]))}")
            if not (np.max(np.abs(a[m, 0] - df0.mfe.to_numpy()[m])) < 1e-9 and np.max(np.abs(a[m, 1] - df0.mae.to_numpy()[m])) < 1e-9): print('REPRODUCTION FAILED, stopping'); return
    rng = np.random.default_rng(SEED)
    for W in HZ:
        a = res[W]; df = df0.copy(); df['mfe'], df['mae'], df['fwd'], df['B'] = a[:, 0], a[:, 1], a[:, 2], a[:, 3]; df = df.dropna(subset=['mfe']).copy()
        df['E'] = df.mfe + df.mae; df['A'] = df.mfe - df.mae
        tell = df[df.ncomp == 5]; cm = df[df.moving & (df.ncomp < 5)]; cn = df[(~df.nodes) & df.fast & df.flip & df.osc & df.strides]
        w = tell.stratum.value_counts(normalize=True).to_dict(); w = {s: w.get(s, 0.0) for s in (0, 1, 2)}; med = sorted(tell.date)[len(tell) // 2]
        print(f"\n######## window {W // 60} minutes: rows {len(df)} of {n_all}; tell {len(tell)} on {tell.date.nunique()} dates, moving-only {len(cm)}, no-node {len(cn)}")
        for cname, ctl in (('CONTROL_MOVING', cm), ('CONTROL_NONODE', cn)):
            print(f"  --- TELL minus {cname}")
            for col, lab in (('E', 'E range travelled'), ('A', 'A asymmetry mfe-mae'), ('fwd', 'fwd signed move'), ('B', 'break rate')):
                d = wdiff(tell, ctl, col, w); lo, hi = ci(tell, ctl, col, rng); h1 = wdiff(tell[tell.date < med], ctl[ctl.date < med], col, w); h2 = wdiff(tell[tell.date >= med], ctl[ctl.date >= med], col, w)
                extra = f"  ratio tell/ctl {tell[col].mean() / ctl[col].mean():.2f}" if col == 'E' else ''
                print(f"    {lab:22s} tell {tell[col].mean():+.4f} ctl {ctl[col].mean():+.4f}  weighted diff {d:+.4f} CI [{lo:+.4f}, {hi:+.4f}]  halves {h1:+.4f}/{h2:+.4f}{extra}")

if __name__ == '__main__': main()
