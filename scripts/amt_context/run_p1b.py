"""P1b = Amendment 1 of PREREG_ROSTER_CONTEXT.md (post-hoc, descriptive, uncounted). Contrast of E_30 for each tell flag, inside clock-hour x A_now-tercile strata (pace-matched) and, for comparison, the original range strata.
EXPLORE only. READS OUTCOMES -> look logged first by log_look_p1b.mjs.  Usage: ../../venv/bin/python run_p1b.py"""
import numpy as np, pandas as pd
import tell_state as TS, vbars as V
from run_p1 import SEED, BOOT
W = 30

def rows(d, ctx):
    S = ctx['S']; end, comp = S['end'], S['comp']; n = ctx['n']; fl = TS.bar_flags(ctx); out = []
    for i in [i for i in range(V.MOVE_N, n) if comp[i] and V.DEC_FIRST <= end[i] <= V.DEC_LAST][::V.THIN]:
        st = TS.state_at(ctx, float(end[i]), flags=fl)
        if st is None or st['rth_range_so_far_atr'] is None or not np.isfinite(st['A_now']): continue
        hz = comp & (end > end[i]) & (end <= end[i] + W * 60.0)
        if not hz.any(): continue
        out.append(dict(date=d, hour=int((64800 + end[i]) % 86400 // 3600), tell_now=int(st['tell_now']), tell5=int(st['tell_any_5m']), tell30=int(st['tell_any_30m']), rng=st['rth_range_so_far_atr'], A=st['A_now'],
                        E=float((S['h'][hz].max() - S['l'][hz].min()) / ctx['atr'])))
    return out

def sdiff(df, flag):
    num = den = 0.0
    for _, g in df.groupby('stratum'):
        a, b = g[g[flag] == 1].E, g[g[flag] == 0].E
        if len(a) and len(b): num += len(a) * (a.mean() - b.mean()); den += len(a)
    return num / den if den else np.nan

def ci(df, flag, rng):
    by = {k: g for k, g in df.groupby('date')}; ks = list(by)
    v = [sdiff(pd.concat([by[ks[j]] for j in rng.integers(0, len(ks), len(ks))]), flag) for _ in range(BOOT)]
    return float(np.nanpercentile(v, 2.5)), float(np.nanpercentile(v, 97.5))

def main():
    _, ctxs, _ = TS.sessions_and_contexts(); r = []
    for d, c in ctxs.items(): r += rows(d, c)
    df = pd.DataFrame(r); rng = np.random.default_rng(SEED + 1); med = np.sort(df.date.unique())[len(df.date.unique()) // 2]
    qa = df.A.quantile([1 / 3, 2 / 3]).values; qr = df.rng.quantile([1 / 3, 2 / 3]).values
    print(f'decision points {len(df)} on {df.date.nunique()} dates; share on: tell_now {100 * df.tell_now.mean():.1f}%, tell_any_5m {100 * df.tell5.mean():.1f}%, tell_any_30m {100 * df.tell30.mean():.1f}%; A_now tercile cuts {qa.round(3).tolist()}')
    for name, col in (('pace-matched strata: clock hour x A_now tercile', 'A'), ('range strata (the original H1 strata): clock hour x range-so-far tercile', 'rng')):
        df['stratum'] = df.hour.astype(str) + '_' + np.digitize(df[col], qa if col == 'A' else qr).astype(str)
        print(f'\n{name}\n  flag          n_on   n_off   E_30 diff   95% CI (day-blocked)        halves')
        for fl in ('tell_now', 'tell5', 'tell30'):
            lo, hi = ci(df, fl, rng); h1, h2 = df[df.date <= med], df[df.date > med]
            print(f'  {fl:12s} {int(df[fl].sum()):6d} {int((df[fl] == 0).sum()):7d}   {sdiff(df, fl):+.4f}    [{lo:+.4f}, {hi:+.4f}]    {sdiff(h1, fl):+.4f} / {sdiff(h2, fl):+.4f}')

if __name__ == '__main__': main()
