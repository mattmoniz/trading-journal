"""Node ladder + flow tell (PREREG.md Amendment 1), EXPLORE ONLY. Hold-out not loaded.  Usage: ../../venv/bin/python run_flow.py"""
import pathlib
import numpy as np, pandas as pd
import nodes as N
import engine as E
from amt_s1 import overnight_ranges
SPLIT, SEED, BOOT = '2025-05-16', 20261028, 3000
HERE = pathlib.Path(__file__).parent

def sdiff(st, a, r, y):
    tot = 0.0; w = 0
    for k in range(3):
        m = st == k; ma, mr = m & a, m & r
        if ma.sum() == 0 or mr.sum() == 0: continue
        tot += ma.sum() * (y[ma].mean() - y[mr].mean()); w += ma.sum()
    return tot / w if w else np.nan

def boot(df, a, r, y, rng):
    dates = df.date.to_numpy(); ud = np.unique(dates); idx = [np.where(dates == d)[0] for d in ud]; st = df.stratum.to_numpy(); res = []
    for _ in range(BOOT):
        pick = np.concatenate([idx[j] for j in rng.integers(0, len(ud), len(ud))]); res.append(sdiff(st[pick], a[pick], r[pick], y[pick]))
    res = np.array(res); return np.nanpercentile(res, [2.5, 97.5]), np.nanpercentile(res, 1.25)

def main():
    rng = np.random.default_rng(SEED)
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]
    on = overnight_ranges(end='2026-10-27')
    for s in ex:
        r = on.loc[s['d']] if s['d'] in on.index else None
        s['onh'], s['onl'] = (float(r.hi), float(r.lo)) if (r is not None and r.n >= 500) else (None, None)
    steps = np.abs(np.concatenate([np.diff(N.bracket_pocs(s['a'])) for s in ex])); S = float(np.median(steps[~np.isnan(steps)]))
    rows = []
    for s in ex: rows += N.points(s, N.atr20(raw, s['d']), S)
    df = pd.DataFrame(rows); df['ladder'] = df.ladder.astype(bool); df['mom'] = df.mom.astype(bool)
    q = df.dist.quantile([1 / 3, 2 / 3]).values; df['stratum'] = np.where(df.dist <= q[0], 0, np.where(df.dist <= q[1], 1, 2))
    # baseline: median same-bracket 90-bar volume over the 20 prior sessions (raw, any session with a full bracket set)
    ks = sorted(raw); base = {}
    vol3 = {k: {b: N.flow3(raw[k], b)[0] for b in range(N.DEC_LO, N.DEC_HI + 1)} for k in ks}
    for k in ex and [s['d'] for s in ex]:
        i = ks.index(k)
        for b in range(N.DEC_LO, N.DEC_HI + 1):
            prior = [vol3[p][b] for p in ks[max(0, i - 20):i] if vol3[p][b] > 0]
            base[(k, b)] = float(np.median(prior)) if i >= 20 and len(prior) >= 15 else np.nan
    df['basevol'] = [base.get((d, b), np.nan) for d, b in zip(df.date, df.b)]
    df['imb'] = np.abs(df.net3) / df.vol3.replace(0, np.nan)
    cut = float(df.imb.median()); print(f"Back-and-forth cutoff (median |net delta|/volume over 90 bars, pooled over {df.imb.notna().sum()} decision points) = {cut:.4f} (frozen)")
    df['hi'] = df.vol3 >= df.basevol; df['baf'] = df.imb <= cut; df['F'] = df.ladder & df.hi & df.baf & df.basevol.notna()
    df['lad_notF'] = df.ladder & ~df.F
    print(f"Decision points {len(df)}; ladder {int(df.ladder.sum())}; F {int(df.F.sum())} ({df[df.F].date.nunique()} dates; up {int(((df.dir == 1) & df.F).sum())} down {int(((df.dir == -1) & df.F).sum())}); ladder-not-F {int(df.lad_notF.sum())}")
    print("  F per stratum:", [int(((df.stratum == k) & df.F).sum()) for k in range(3)])
    for lab, m in (('F (flow ladder)', df.F), ('ladder not F', df.lad_notF), ('price-momentum control', df.mom), ('no-ladder', ~df.ladder)):
        g = df[m]; print(f"  {lab:24s} N={len(g):5d} break {100 * g.brk.mean():5.1f}%  60-min signed move {g.fwd.mean():+.4f} ATR20")
    d = df.dropna(subset=['fwd']).reset_index(drop=True); y = d.fwd.to_numpy(); yb = d.brk.astype(float).to_numpy()
    st = d.stratum.to_numpy(); F = d.F.to_numpy(); nol = (~d.ladder).to_numpy(); mom = d.mom.to_numpy(); ln = d.lad_notF.to_numpy()
    print("\nCOUNTED CELL 2: signed 60-min move, F minus no-ladder (one-sided 98.75% lower bound, Bonferroni over 2 cells)")
    pt = sdiff(st, F, nol, y); ci, lo = boot(d, F, nol, y, rng); print(f"  {pt:+.4f} ATR20, 95% CI [{ci[0]:+.4f}, {ci[1]:+.4f}], one-sided 98.75% lower bound {lo:+.4f}")
    for lab, ref in (('ladder-not-F (does flow add?)', ln), ('price-momentum control', mom)):
        p2 = sdiff(st, F, ref, y); c2, _ = boot(d, F, ref, y, rng); print(f"  F minus {lab}: {p2:+.4f}, CI [{c2[0]:+.4f}, {c2[1]:+.4f}]")
    pb = sdiff(st, F, nol, yb); cb, _ = boot(d, F, nol, yb, rng); print(f"  break rate (primary definition), F minus no-ladder: {100 * pb:+.2f} pts, CI [{100 * cb[0]:+.2f}, {100 * cb[1]:+.2f}]")
    pbl = sdiff(st, F, ln, yb); cbl, _ = boot(d, F, ln, yb, rng); print(f"  break rate, F minus ladder-not-F: {100 * pbl:+.2f} pts, CI [{100 * cbl[0]:+.2f}, {100 * cbl[1]:+.2f}]")
    print("\nDESCRIPTIVE by direction (F vs no-ladder 60-min move):")
    for dr in (1, -1):
        g = d[d.dir == dr]; print(f"  dir {dr:+d}: F {g[g.F].fwd.mean():+.4f} (N={int(g.F.sum())}) vs no-ladder {g[~g.ladder].fwd.mean():+.4f}")
    df.to_csv(HERE / 'decision_points_flow_explore.csv', index=False)
    print('\nReading is pre-registered (Amendment 1): lead = lower bound > 0 AND beats both price-momentum control and ladder-not-F. Under 150 F events or 60 dates = underpowered.')

if __name__ == '__main__':
    main()
