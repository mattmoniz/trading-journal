"""docs/TELL_FAR_FROM_OPEN_PREREG_20261102.md. EXPLORE only. READS OUTCOMES -> look logged first. Usage: nice python run_tell_far_open.py"""
import sys; sys.argv = sys.argv[:1]; sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_context')
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T
SEED, BOOT, PERM = 20261102, 3000, 1000; T1, T2, OPEN_S = 57600.0, 61200.0, 55800.0

def y_after(S, t0, i, dr, atr, H):
    end, c, comp = S['end'], S['c'], S['comp']
    if end[comp].max() < t0 + H * 60 - 60: return np.nan
    w = np.where(comp & (end > t0) & (end <= t0 + H * 60))[0]
    return np.nan if len(w) == 0 else dr * (c[w[-1]] - c[i]) / atr

def touch(S, t0, i, dr, atr, k=0.15):
    """1 if +k ATR toward the open is reached before -k within 60 min, 0 if the reverse, nan if neither/same bar."""
    h, l, c, end, comp = S['h'], S['l'], S['c'], S['end'], S['comp']; w = np.where(comp & (end > t0) & (end <= t0 + 3600))[0]
    for j in w:
        up, dn = h[j] >= c[i] + k * atr, l[j] <= c[i] - k * atr; fav, adv = (up, dn) if dr == 1 else (dn, up)
        if fav and adv: return np.nan
        if fav: return 1.0
        if adv: return 0.0
    return np.nan

def main():
    sess, ctxs, inputs = TS.sessions_and_contexts(); rows = []
    for d in sorted(ctxs):
        ctx = ctxs[d]; S = ctx['S']; end, comp, c = S['end'], S['comp'], S['c']; atr = inputs[d][0]; prof = T.Prof(ctx)
        ob = np.where(comp & (end <= OPEN_S))[0]
        if len(ob) == 0: continue
        P0 = c[ob[-1]]
        tells = [(int(t['sig']), int(t['dir'])) for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0))]
        ctl = [(i, 0) for i in range(ctx['n'] - 1) if i % 10 == 0 and V.DEC_FIRST <= end[i] <= V.DEC_LAST and comp[i] and (ctx['moving1'][i] or ctx['moving-1'][i]) and not any(T.ncomp_at(ctx, prof, i, dd, need_nodes=False)[1] for dd in (1, -1))]
        for arm, pts in (('TELL', tells), ('CONTROL', ctl)):
            for i, td in pts:
                if i < 10 or not (T1 <= end[i] <= T2): continue
                pre = int(np.sign(c[i] - c[i - 10])); dirn = td if arm == 'TELL' else pre
                if dirn == 0 or c[i] == P0: continue
                dr_open = -int(np.sign(c[i] - P0)); t0 = end[i]
                rows.append(dict(date=d, arm=arm, D=abs(c[i] - P0) / atr, toward=(dirn == dr_open), t0=t0,
                                 y30=y_after(S, t0, i, dr_open, atr, 30), y60=y_after(S, t0, i, dr_open, atr, 60), tch=touch(S, t0, i, dr_open, atr)))
    R = pd.DataFrame(rows).sort_values(['date', 't0']).reset_index(drop=True)
    print(f'first-hour events: TELL {int((R.arm=="TELL").sum())} on {R[R.arm=="TELL"].date.nunique()} dates, CONTROL {int((R.arm=="CONTROL").sum())} on {R[R.arm=="CONTROL"].date.nunique()} dates; toward share TELL {R[R.arm=="TELL"].toward.mean():.3f} CONTROL {R[R.arm=="CONTROL"].toward.mean():.3f}')
    # causal expanding 2/3 cutoff over EARLIER DATES' events (both arms pooled); first 100 events seed
    cut = np.full(len(R), np.nan); dates = R.date.values; Dv = R.D.values; seen = []; i0 = 0
    for d in sorted(set(dates)):
        idx = np.where(dates == d)[0]
        if len(seen) >= 100: cut[idx] = np.quantile(seen, 2 / 3)
        seen.extend(Dv[idx]); 
    R['cut'] = cut; E = R[R.cut.notna()].copy(); E['far'] = E.D >= E.cut
    print(f'evaluated {len(E)} events on {E.date.nunique()} dates (first 100 seed the cutoff); far share {E.far.mean():.3f}')
    ds = sorted(E.date.unique()); half = {d: (0 if k < len(ds) // 2 else 1) for k, d in enumerate(ds)}; E['half'] = E.date.map(half)
    rng = np.random.default_rng(SEED)
    def diff(df, col):
        a, b = df[(df.arm == 'TELL')][col].dropna(), df[(df.arm == 'CONTROL')][col].dropna()
        return (a.mean() - b.mean(), len(a), len(b)) if len(a) and len(b) else (np.nan, len(a), len(b))
    def ci(df, col):
        g = {d: x for d, x in df.groupby('date')}; ks = list(g); out = []
        for _ in range(BOOT):
            s = pd.concat([g[k] for k in rng.choice(ks, len(ks))]); v = diff(s, col)[0]
            if not np.isnan(v): out.append(v)
        return np.percentile(out, [2.5, 97.5])
    def perm(df, col):
        obs = diff(df, col)[0]; g = {d: x for d, x in df.groupby('date')}; cnt = 0
        for _ in range(PERM):
            s = pd.concat([x.assign(arm=rng.permutation(x.arm.values)) for x in g.values()]); cnt += abs(diff(s, col)[0]) >= abs(obs)
        return (cnt + 1) / (PERM + 1)
    def report(name, df, col='y30', full=False):
        v, na, nb = diff(df, col); line = f'{name:<34} {col}: TELL {df[df.arm=="TELL"][col].mean():+.4f} (N {na}) CONTROL {df[df.arm=="CONTROL"][col].mean():+.4f} (N {nb}) diff {v:+.4f}'
        if full and na > 5 and nb > 5: lo, hi = ci(df, col); line += f' CI [{lo:+.4f}, {hi:+.4f}] perm p {perm(df, col):.3f}'
        print(line)
    FT = E[E.far & E.toward]
    print('\n== C1 (the one counted test): FAR and TOWARD the open')
    report('FAR+TOWARD', FT, 'y30', full=True)
    for h in (0, 1): report(f'  half {h+1} ({E[E.half==h].date.min()}..{E[E.half==h].date.max()})', FT[FT.half == h], 'y30')
    print('\n== reported, uncounted')
    report('FAR+TOWARD', FT, 'y60'); report('FAR+TOWARD touch +0.15 first', FT, 'tch')
    for h in (0, 1): report(f'  half {h+1}', FT[FT.half == h], 'y60')
    s = FT.copy(); top = s[s.arm == 'TELL'].y30.abs().nlargest(10).index; report('FAR+TOWARD minus 10 biggest tell |y30|', s.drop(top), 'y30')
    report('ALL distances, TOWARD', E[E.toward], 'y30'); report('FAR, AWAY from open', E[E.far & ~E.toward], 'y30'); report('NEAR, TOWARD', E[~E.far & E.toward], 'y30')
    c = FT[FT.arm == 'CONTROL'].y30.dropna(); print(f'CONTROL FAR+TOWARD mean y30 {c.mean():+.4f} (N {len(c)}, share positive {(c>0).mean():.3f}) -> plain reversion {"exists" if c.mean()>0 else "absent"} in the control')
    E.to_csv('/home/mmoniz/trading-journal/scripts/amt_context/tell_far_open_events.csv', index=False)
main()
