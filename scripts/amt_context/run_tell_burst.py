"""docs/TELL_BURST_CONFIRMATION_PREREG_20261102.md. EXPLORE only. READS OUTCOMES -> look logged first (log_look_tell_burst.mjs). Usage: nice python run_tell_burst.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T
from run_tell_at_level import outcomes
SEED, BOOT, SLIP, COST = 20261102, 3000, 0.25, 1.25; HZ = (15, 30, 60)

def bds(S): return (S['ask'] - S['bid']) / S['vol']

def find_burst(S, i, th, need_break):
    """first bar j in i+1..i+3 with |delta share| >= th (and, if need_break, closing beyond the signal bar's extreme in its direction). Returns (direction, entry bar) or None."""
    n = len(S['c'])
    if i + 5 >= n: return None
    b = bds(S)
    for j in range(i + 1, i + 4):
        if abs(b[j]) >= th:
            dr = 1 if b[j] > 0 else -1
            if need_break and not ((S['c'][j] > S['h'][i]) if dr == 1 else (S['c'][j] < S['l'][i])): continue
            return dr, j + 1
    return None

def main():
    rng = np.random.default_rng(SEED + 127); sess, ctxs, _ = TS.sessions_and_contexts(); ks = sorted(sess); rows = []; npts = {'TELL': 0, 'CONTROL': 0}
    for d in sorted(ctxs):
        k = ks.index(d); pooled = np.concatenate([np.abs(bds(sess[x])) for x in ks[k - 20:k]]); pooled = pooled[np.isfinite(pooled)]; ths = {q: np.quantile(pooled, q) for q in (0.8, 0.9, 0.95)}
        ctx = ctxs[d]; S = ctx['S']; end, comp = S['end'], S['comp']; prof = T.Prof(ctx); tells = [(int(t['sig']), int(t['dir'])) for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0))]
        ctl = [(i, 0) for i in range(ctx['n'] - 1) if i % 10 == 0 and V.DEC_FIRST <= end[i] <= V.DEC_LAST and comp[i] and (ctx['moving1'][i] or ctx['moving-1'][i]) and not any(T.ncomp_at(ctx, prof, i, dd, need_nodes=False)[1] for dd in (1, -1))]
        for arm, pts in (('TELL', tells), ('CONTROL', ctl)):
            for i, tdir in pts:
                npts[arm] += 1; mvm = (S['start'][i] - V.RTH_OPEN) / 60.0; base = dict(date=d, arm=arm, tdir=tdir, bin=(0 if mvm < 90 else 1 if mvm < 180 else 2))
                for var, need in (('A', False), ('B', True)):
                    ev = find_burst(S, i, ths[0.9], need)
                    if ev is not None:
                        dr, j1 = ev; r = dict(base, var=var, dr=dr, agree=(None if arm == 'CONTROL' else dr == tdir))
                        for H in HZ: r[f'y{H}'] = outcomes(S, j1, dr, H)
                        rows.append(r)
                if arm == 'TELL' and i + 3 < ctx['n']:      # plain tell reference (tell's own direction, next open), and burst thresholds 80/95 for variant A
                    r = dict(base, var='PLAIN', dr=tdir, agree=True)
                    for H in HZ: r[f'y{H}'] = outcomes(S, i + 1, tdir, H)
                    rows.append(r)
                    for q in (0.8, 0.95):
                        ev = find_burst(S, i, ths[q], False)
                        if ev is not None:
                            dr, j1 = ev; r = dict(base, var=f'A{int(q * 100)}', dr=dr, agree=(dr == tdir))
                            for H in HZ: r[f'y{H}'] = outcomes(S, j1, dr, H)
                            rows.append(r)
    R = pd.DataFrame(rows); print(f'signal bars TELL {npts["TELL"]}, CONTROL {npts["CONTROL"]}'); cnt = lambda a, v: int(((R.arm == a) & (R['var'] == v)).sum()); print(f'events: A tell {cnt("TELL", "A")} control {cnt("CONTROL", "A")}; B tell {cnt("TELL", "B")} control {cnt("CONTROL", "B")}; plain tell {cnt("TELL", "PLAIN")}')
    def mstat(df, H):
        d = df.dropna(subset=[f'y{H}']); g = d.groupby('date')[f'y{H}'].agg(['sum', 'count']); return g
    res = {}
    for var in ('A', 'B'):
        for H in HZ:
            gT = mstat(R[(R.arm == 'TELL') & (R['var'] == var)], H); gC = mstat(R[(R.arm == 'CONTROL') & (R['var'] == var)], H); ud = np.array(sorted(set(gT.index) | set(gC.index))); AT = np.c_[gT.reindex(ud)['sum'].fillna(0).values, gT.reindex(ud)['count'].fillna(0).values]; AC = np.c_[gC.reindex(ud)['sum'].fillna(0).values, gC.reindex(ud)['count'].fillna(0).values]
            m = lambda w, a: (w @ a[:, 0]) / max(1.0, w @ a[:, 1]); w1 = np.ones(len(ud)); bd, bt = [], []
            for _ in range(BOOT): w = np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float); bd.append(m(w, AT) - m(w, AC)); bt.append(m(w, AT))
            h = len(ud) // 2; ha = (np.arange(len(ud)) < h) * 1.0; hb = 1 - ha; diff = m(w1, AT) - m(w1, AC); p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
            res[(var, H)] = dict(diff=diff, lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), tm=m(w1, AT), tl=np.percentile(bt, 2.5), th=np.percentile(bt, 97.5), cm=m(w1, AC), p=p, h1=m(ha, AT) - m(ha, AC), h2=m(hb, AT) - m(hb, AC), n=int(AT[:, 1].sum()), days=int((AT[:, 1] > 0).sum()))
    keys = list(res); order = sorted(range(6), key=lambda i: res[keys[i]]['p']); keep = -1
    for rk, ix in enumerate(order): keep = rk if res[keys[ix]]['p'] <= (rk + 1) / 6 * 0.10 else keep
    sv = {keys[ix]: rk <= keep for rk, ix in enumerate(order)}; print('\nRESOLUTION (TELL absolute-mean CI half-width, points): ' + ', '.join(f'{k[0]}{k[1]}m {(res[k]["th"] - res[k]["tl"]) / 2:.1f}' for k in keys))
    print('\nCOUNTED: y = points moved in the direction of the burst after entry at the next open (gross; cost 1.25 + slip)')
    for k in keys:
        r = res[k]; ok = sv[k] and (r['lo'] > 0 or r['hi'] < 0) and r['tl'] > 1.5 and r['n'] >= 100 and r['days'] >= 60 and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['diff'])
        print(f'  variant {k[0]} H {k[1]:2d}m: TELL mean {r["tm"]:+.2f} [{r["tl"]:+.2f}, {r["th"]:+.2f}] (N {r["n"]}, {r["days"]} dates), CONTROL {r["cm"]:+.2f}, TELL minus CONTROL {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.2f} / {r["h2"]:+.2f} BH {"survives" if sv[k] else "no"}{"  UNDERPOWERED" if r["n"] < 100 or r["days"] < 60 else ""}{"  <== CANDIDATE" if ok else ""}')
    tt = R[R.arm == 'TELL']; print('\nUNCOUNTED reference and splits (mean y30, N): ' + '; '.join(f'{v}: {tt[tt["var"] == v]["y30"].mean():+.2f} (N {int((tt["var"] == v).sum())})' for v in ('PLAIN', 'A80', 'A', 'A95', 'B')))
    for var in ('A', 'B'):
        a = tt[(tt['var'] == var)]; print(f'variant {var} burst AGREES with the tell direction: N {int((a.agree == True).sum())} mean y30 {a[a.agree == True]["y30"].mean():+.2f}; OPPOSES (capitulation case: follow the opposite side): N {int((a.agree == False).sum())} mean y30 {a[a.agree == False]["y30"].mean():+.2f}')
    a = tt[tt['var'] == 'A']; print('by year (variant A mean y30): ' + ', '.join(f'{y} {a[a.date.str[:4] == y]["y30"].mean():+.2f} (N {int((a.date.str[:4] == y).sum())})' for y in sorted(set(a.date.str[:4]))))

if __name__ == '__main__': main()
