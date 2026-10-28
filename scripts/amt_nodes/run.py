"""Node ladder before the breakout, EXPLORE ONLY (PREREG.md frozen). Hold-out not loaded.  Usage: ../../venv/bin/python run.py"""
import pathlib
import numpy as np, pandas as pd
import nodes as N
import engine as E
from amt_s1 import overnight_ranges
SPLIT, SEED, BOOT = '2025-05-16', 20261028, 3000
HERE = pathlib.Path(__file__).parent

def strat_diff(df, arm, ref, col, edges=None):
    """Weighted (by arm count per stratum) mean difference arm-minus-ref of `col` over distance strata."""
    st = df.stratum.to_numpy(); y = df[col].astype(float).to_numpy()
    return _sd(st, np.asarray(arm), np.asarray(ref), y)

def _sd(st, a, r, y):
    tot = 0.0; w = 0
    for k in range(3):
        m = st == k; ma, mr = m & a, m & r
        if ma.sum() == 0 or mr.sum() == 0: continue
        tot += ma.sum() * (np.nanmean(y[ma]) - np.nanmean(y[mr])); w += ma.sum()
    return tot / w if w else np.nan

def boot(df, arm, ref, col, rng):
    dates = df.date.to_numpy(); ud = np.unique(dates); idx = [np.where(dates == d)[0] for d in ud]; st = df.stratum.to_numpy(); y = df[col].astype(float).to_numpy()
    lad = df.ladder.astype(bool).to_numpy(); mom = df.mom.astype(bool).to_numpy(); A = lad if arm == 'ladder' else mom
    R = ~lad if ref == 'noladder' else mom if ref == 'mom' else (~lad & ~mom); res = []
    for _ in range(BOOT):
        pick = np.concatenate([idx[j] for j in rng.integers(0, len(ud), len(ud))]); res.append(_sd(st[pick], A[pick], R[pick], y[pick]))
    return np.nanpercentile(res, [2.5, 97.5]), np.nanpercentile(res, 2.5)

def main():
    rng = np.random.default_rng(SEED)
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]
    on = overnight_ranges(end='2026-10-27')
    for s in ex:
        r = on.loc[s['d']] if s['d'] in on.index else None
        s['onh'], s['onl'] = (float(r.hi), float(r.lo)) if (r is not None and r.n >= 500) else (None, None)
    raw_by = {d: raw[d] for d in raw}
    print(f"Explore sessions {len(ex)} ({ex[0]['d']}..{ex[-1]['d']}); hold-out {len(allS) - len(ex)} SEALED")
    pocs = {s['d']: N.bracket_pocs(s['a']) for s in ex}
    steps = np.abs(np.concatenate([np.diff(p) for p in pocs.values()])); steps = steps[~np.isnan(steps)]
    S = float(np.median(steps)); print(f"S (median absolute adjacent-bracket POC step, pooled over {len(steps)} pairs) = {S:.2f} pts (frozen)")
    rows = []
    for s in ex:
        rows += N.points(s, N.atr20(raw_by, s['d']), S)
    df = pd.DataFrame(rows); df['ladder'] = df.ladder.astype(bool); df['mom'] = df.mom.astype(bool)
    q = df.dist.quantile([1 / 3, 2 / 3]).values; df['stratum'] = np.where(df.dist <= q[0], 0, np.where(df.dist <= q[1], 1, 2))
    print(f"Decision points {len(df)} over {df.date.nunique()} sessions; distance terciles cut at {q[0]:.3f} / {q[1]:.3f} ATR20")
    nl, nm = int(df.ladder.sum()), int(df.mom.sum())
    print(f"ARM SIZES: ladder {nl} events ({df[df.ladder].date.nunique()} dates; up {int(((df.dir == 1) & df.ladder).sum())} down {int(((df.dir == -1) & df.ladder).sum())}), price-momentum control {nm} ({df[df.mom].date.nunique()} dates), no-ladder {int((~df.ladder).sum())}")
    print("  ladder events per stratum:", [int(((df.stratum == k) & df.ladder).sum()) for k in range(3)], " by bracket b=2..7:", [int(((df.b == b) & df.ladder).sum()) for b in range(2, 8)])
    for lab, m in (('ladder', df.ladder), ('price-momentum control', df.mom), ('no-ladder', ~df.ladder)):
        g = df[m]; print(f"  {lab:24s} break rate {100 * g.brk.mean():5.1f}%  break combined range {100 * g.brk2.dropna().astype(float).mean():5.1f}%  mean 60-min move {g.fwd.mean():+.4f} ATR20 (N={len(g)})")
    lad, nol, mom_ = df.ladder, ~df.ladder, df.mom
    print("\nPRIMARY: break-rate difference, strata-weighted (day-blocked bootstrap)")
    d1 = strat_diff(df, lad, nol, 'brk', None); ci1, lo1 = boot(df, 'ladder', 'noladder', 'brk', rng)
    print(f"  ladder minus no-ladder: {100 * d1:+.2f} pts, 95% CI [{100 * ci1[0]:+.2f}, {100 * ci1[1]:+.2f}], one-sided 97.5% lower bound {100 * lo1:+.2f}")
    d2 = strat_diff(df, lad, mom_, 'brk', None); ci2, _ = boot(df, 'ladder', 'mom', 'brk', rng)
    print(f"  ladder minus price-momentum control: {100 * d2:+.2f} pts, CI [{100 * ci2[0]:+.2f}, {100 * ci2[1]:+.2f}]")
    d3 = strat_diff(df.dropna(subset=['fwd']), df.dropna(subset=['fwd']).ladder, ~df.dropna(subset=['fwd']).ladder, 'fwd', None); sub = df.dropna(subset=['fwd']).reset_index(drop=True)
    ci3, _ = boot(sub, 'ladder', 'noladder', 'fwd', rng)
    print(f"  SIGNED 60-min move, ladder minus no-ladder: {d3:+.4f} ATR20, CI [{ci3[0]:+.4f}, {ci3[1]:+.4f}]")
    d4 = strat_diff(sub, sub.ladder, sub.mom, 'fwd', None); ci4, _ = boot(sub, 'ladder', 'mom', 'fwd', rng)
    print(f"  SIGNED 60-min move, ladder minus price-momentum control: {d4:+.4f} ATR20, CI [{ci4[0]:+.4f}, {ci4[1]:+.4f}]")
    sub2 = df.dropna(subset=['brk2']).reset_index(drop=True); sub2['brk2'] = sub2.brk2.astype(float)
    d5 = strat_diff(sub2, sub2.ladder, ~sub2.ladder, 'brk2', None); ci5, _ = boot(sub2, 'ladder', 'noladder', 'brk2', rng)
    print(f"  break of the COMBINED range (IB + overnight), ladder minus no-ladder: {100 * d5:+.2f} pts, CI [{100 * ci5[0]:+.2f}, {100 * ci5[1]:+.2f}]")
    print("\nDESCRIPTIVE: break rate by direction, ladder vs no-ladder")
    for dr in (1, -1):
        g = df[df.dir == dr]; print(f"  dir {dr:+d}: ladder {100 * g[g.ladder].brk.mean():.1f}% (N={int(g.ladder.sum())}) vs no-ladder {100 * g[~g.ladder].brk.mean():.1f}%  | 60-min move {g[g.ladder].fwd.mean():+.4f} vs {g[~g.ladder].fwd.mean():+.4f}")
    df.to_csv(HERE / 'decision_points_explore.csv', index=False)
    print("\nReading is pre-registered (PREREG.md): lead = primary lower bound > 0 AND ladder beats the price-momentum control AND signed 60-min move difference positive. Under 150 ladder events or 60 dates = underpowered.")

if __name__ == '__main__':
    main()
