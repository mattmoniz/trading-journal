"""P1 of PREREG_ROSTER_CONTEXT.md: H1 descriptive. Does a tell in the last 30 minutes go with a larger direction-free travel E_W in the next W minutes, within clock-hour x range-so-far strata?
EXPLORE only (<= 2025-05-16). READS OUTCOMES (E_W) -> the look is logged first by log_look_p1.mjs.  Usage: ../../venv/bin/python run_p1.py"""
import numpy as np, pandas as pd
import tell_state as TS, vbars as V
SEED, BOOT = 20261102, 3000
H = (15, 30, 60)

def rows_for_session(d, ctx):
    S = ctx['S']; end, comp = S['end'], S['comp']; n = ctx['n']; fl = TS.bar_flags(ctx)
    dec = [i for i in range(V.MOVE_N, n) if comp[i] and V.DEC_FIRST <= end[i] <= V.DEC_LAST][::V.THIN]; out = []
    for i in dec:
        st = TS.state_at(ctx, float(end[i]), flags=fl)
        if st is None or st['rth_range_so_far_atr'] is None: continue
        r = dict(date=d, hour=int((64800 + end[i]) % 86400 // 3600), tell30=int(st['tell_any_30m']), tell15=int(st['tell_any_15m']), rng=st['rth_range_so_far_atr'], A=st['A_now'])
        for W in H:
            hz = comp & (end > end[i]) & (end <= end[i] + W * 60.0)
            r[f'E{W}'] = float((S['h'][hz].max() - S['l'][hz].min()) / ctx['atr']) if hz.any() else np.nan
        out.append(r)
    return out

def strat_diff(df, col):
    """stratum-weighted (weights = tell-on counts per stratum) mean difference of col, tell30==1 minus tell30==0, strata = hour x range tercile."""
    num = den = 0.0
    for _, g in df.groupby('stratum'):
        a, b = g[g.tell30 == 1][col].dropna(), g[g.tell30 == 0][col].dropna()
        if len(a) and len(b): num += len(a) * (a.mean() - b.mean()); den += len(a)
    return num / den if den else np.nan

def boot_ci(df, col, rng):
    by = {k: g for k, g in df.groupby('date')}; ks = list(by); vals = []
    for _ in range(BOOT):
        samp = pd.concat([by[ks[j]] for j in rng.integers(0, len(ks), len(ks))]); vals.append(strat_diff(samp, col))
    return float(np.nanpercentile(vals, 2.5)), float(np.nanpercentile(vals, 97.5))

def main():
    sess, ctxs, _ = TS.sessions_and_contexts(); rows = []
    for d, c in ctxs.items(): rows += rows_for_session(d, c)
    df = pd.DataFrame(rows); q = df.rng.quantile([1 / 3, 2 / 3]).values
    df['rt'] = np.digitize(df.rng, q); df['stratum'] = df.hour.astype(str) + '_' + df.rt.astype(str)
    print(f'decision points {len(df)} on {df.date.nunique()} dates; tell30 on {int(df.tell30.sum())} ({100 * df.tell30.mean():.1f}%), dates with any tell30 {df[df.tell30 == 1].date.nunique()}')
    print('arm sizes per clock hour (tell-on / tell-off):', {h: (int(((df.hour == h) & (df.tell30 == 1)).sum()), int(((df.hour == h) & (df.tell30 == 0)).sum())) for h in sorted(df.hour.unique())})
    rng = np.random.default_rng(SEED); med = np.sort(df.date.unique())[len(df.date.unique()) // 2]
    print('\nH1: E_W tell-on minus tell-off (ATR20 units), stratum-weighted by tell-on counts, day-blocked 95% CI')
    for W in H:
        col = f'E{W}'; dd = strat_diff(df, col); lo, hi = boot_ci(df, col, rng)
        h1, h2 = df[df.date <= med], df[df.date > med]
        on, off = df[df.tell30 == 1][col].mean(), df[df.tell30 == 0][col].mean()
        print(f"  W={W:2d}{' [PRIMARY]' if W == 30 else '          '} diff {dd:+.4f} CI [{lo:+.4f}, {hi:+.4f}]  raw means on {on:.3f} off {off:.3f}  halves {strat_diff(h1, col):+.4f} / {strat_diff(h2, col):+.4f}")
    print('\nsame contrast with pace held roughly fixed (A >= 1 only, the tell requires fast pace):')
    f = df[df.A >= 1]
    for W in H: print(f"  W={W:2d} diff {strat_diff(f, f'E{W}'):+.4f} (n tell-on {int(f.tell30.sum())}, off {int((f.tell30 == 0).sum())})")
    df.to_csv('p1_points.csv', index=False)

if __name__ == '__main__': main()
