"""docs/TELL_RANGE_BREAK_PREREG_20261102.md. EXPLORE only. READS OUTCOMES -> look logged first (log_look_tell_range_break.mjs). Usage: nice python run_tell_range_break.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T
SEED, BOOT, SLIP, TICK = 20261102, 3000, 0.25, 0.25; HZ = (15, 30, 60); WIN = 900.0; FLAT = T.FLAT_S

def y_from(S, t0, entry, dr, H):
    end, c, comp = S['end'], S['c'], S['comp']
    if end[comp].max() < t0 + H * 60 - 60: return None
    w = np.where(comp & (end > t0) & (end <= t0 + H * 60))[0]
    return None if len(w) == 0 else dr * (c[w[-1]] - entry)

def break_event(S, i, win=WIN):
    """returns dict(S=(dr, entry, t0), C=(dr, entry, t0), amb=bool, any=bool) for the break of the 10-bar range at signal bar i, or None when the window is unusable."""
    h, l, o, c, end, start = S['h'], S['l'], S['o'], S['c'], S['end'], S['start']; n = len(c)
    if i < 10 or i + 3 >= n: return None
    hi, lo = h[i - 9:i + 1].max(), l[i - 9:i + 1].min(); up, dn = hi + TICK, lo - TICK; out = dict(S=None, C=None, amb=False, any=False); t0 = end[i]
    for j in range(i + 1, n - 1):
        if start[j] >= FLAT or end[j] - t0 > win: break
        tu, td = h[j] >= up, l[j] <= dn
        if out['S'] is None and not out['amb']:
            if tu and td: out['amb'] = True
            elif tu: out['S'] = (1, max(up, o[j]) + SLIP, end[j - 1]); out['any'] = True
            elif td: out['S'] = (-1, min(dn, o[j]) - SLIP, end[j - 1]); out['any'] = True
        if out['C'] is None:
            if c[j] > hi: out['C'] = (1, o[j + 1] + SLIP, start[j + 1]); out['any'] = True
            elif c[j] < lo: out['C'] = (-1, o[j + 1] - SLIP, start[j + 1]); out['any'] = True
        if (out['S'] is not None or out['amb']) and out['C'] is not None: break
    return out

def main():
    rng = np.random.default_rng(SEED + 131); sess, ctxs, _ = TS.sessions_and_contexts(); rows = []; npts = {'TELL': 0, 'CONTROL': 0}; amb = {'TELL': 0, 'CONTROL': 0}; anyb = {'TELL': 0, 'CONTROL': 0}
    for d in sorted(ctxs):
        ctx = ctxs[d]; S = ctx['S']; end, comp = S['end'], S['comp']; prof = T.Prof(ctx); tells = [(int(t['sig']), int(t['dir'])) for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0))]
        ctl = [(i, 0) for i in range(ctx['n'] - 1) if i % 10 == 0 and V.DEC_FIRST <= end[i] <= V.DEC_LAST and comp[i] and (ctx['moving1'][i] or ctx['moving-1'][i]) and not any(T.ncomp_at(ctx, prof, i, dd, need_nodes=False)[1] for dd in (1, -1))]
        for arm, pts in (('TELL', tells), ('CONTROL', ctl)):
            for i, tdir in pts:
                ev = break_event(S, i)
                if ev is None: continue
                npts[arm] += 1; amb[arm] += int(ev['amb']); anyb[arm] += int(ev['any']); base = dict(date=d, arm=arm, tdir=tdir)
                for var in ('S', 'C'):
                    if ev[var] is None: continue
                    dr, entry, t0 = ev[var]; r = dict(base, var=var, dr=dr, agree=(None if arm == 'CONTROL' else dr == tdir))
                    for H in HZ: r[f'y{H}'] = y_from(S, t0 + (0 if var == 'C' else 0), entry, dr, H) if var == 'C' else y_from(S, t0, entry, dr, H)
                    rows.append(r)
    R = pd.DataFrame(rows); cnt = lambda a, v: int(((R.arm == a) & (R['var'] == v)).sum())
    print(f'usable signal bars: TELL {npts["TELL"]}, CONTROL {npts["CONTROL"]}; broke the 10-bar range within 15 min (either variant): TELL {100 * anyb["TELL"] / npts["TELL"]:.1f}%, CONTROL {100 * anyb["CONTROL"] / npts["CONTROL"]:.1f}%; ambiguous bars (both sides): TELL {amb["TELL"]}, CONTROL {amb["CONTROL"]}')
    print(f'events: S tell {cnt("TELL", "S")} control {cnt("CONTROL", "S")}; C tell {cnt("TELL", "C")} control {cnt("CONTROL", "C")}')
    res = {}
    for var in ('S', 'C'):
        for H in HZ:
            g = lambda a: R[(R.arm == a) & (R['var'] == var)].dropna(subset=[f'y{H}']).groupby('date')[f'y{H}'].agg(['sum', 'count']); gT, gC = g('TELL'), g('CONTROL'); ud = np.array(sorted(set(gT.index) | set(gC.index)))
            AT = np.c_[gT.reindex(ud)['sum'].fillna(0).values, gT.reindex(ud)['count'].fillna(0).values]; AC = np.c_[gC.reindex(ud)['sum'].fillna(0).values, gC.reindex(ud)['count'].fillna(0).values]; m = lambda w, a: (w @ a[:, 0]) / max(1.0, w @ a[:, 1]); w1 = np.ones(len(ud)); bd, bt = [], []
            for _ in range(BOOT): w = np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float); bd.append(m(w, AT) - m(w, AC)); bt.append(m(w, AT))
            h = len(ud) // 2; ha = (np.arange(len(ud)) < h) * 1.0; hb = 1 - ha; diff = m(w1, AT) - m(w1, AC); p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
            res[(var, H)] = dict(diff=diff, lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), tm=m(w1, AT), tl=np.percentile(bt, 2.5), th=np.percentile(bt, 97.5), cm=m(w1, AC), p=p, h1=m(ha, AT) - m(ha, AC), h2=m(hb, AT) - m(hb, AC), n=int(AT[:, 1].sum()), days=int((AT[:, 1] > 0).sum()))
    keys = list(res); order = sorted(range(6), key=lambda i: res[keys[i]]['p']); keep = -1
    for rk, ix in enumerate(order): keep = rk if res[keys[ix]]['p'] <= (rk + 1) / 6 * 0.10 else keep
    sv = {keys[ix]: rk <= keep for rk, ix in enumerate(order)}; print('\nRESOLUTION (TELL absolute-mean CI half-width, points): ' + ', '.join(f'{k[0]}{k[1]}m {(res[k]["th"] - res[k]["tl"]) / 2:.1f}' for k in keys))
    print('\nCOUNTED: y = points moved in the break direction after entry (gross of the 1.25-point cost; slip included)')
    for k in keys:
        r = res[k]; ok = sv[k] and (r['lo'] > 0 or r['hi'] < 0) and r['tl'] > 1.25 and r['n'] >= 100 and r['days'] >= 60 and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['diff'])
        print(f'  variant {k[0]} H {k[1]:2d}m: TELL mean {r["tm"]:+.2f} [{r["tl"]:+.2f}, {r["th"]:+.2f}] (N {r["n"]}, {r["days"]} dates), CONTROL {r["cm"]:+.2f}, TELL minus CONTROL {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.2f} / {r["h2"]:+.2f} BH {"survives" if sv[k] else "no"}{"  UNDERPOWERED" if r["n"] < 100 or r["days"] < 60 else ""}{"  <== CANDIDATE" if ok else ""}')
    tt = R[R.arm == 'TELL']
    for var in ('S', 'C'):
        a = tt[tt['var'] == var]; print(f'UNCOUNTED variant {var}: breaks UP {100 * (a.dr == 1).mean():.0f}%; break AGREES with the tell direction N {int((a.agree == True).sum())} mean y30 {a[a.agree == True]["y30"].mean():+.2f}; OPPOSES N {int((a.agree == False).sum())} mean y30 {a[a.agree == False]["y30"].mean():+.2f}; by year ' + ', '.join(f'{y} {a[a.date.str[:4] == y]["y30"].mean():+.2f} (N {int((a.date.str[:4] == y).sum())})' for y in sorted(set(a.date.str[:4]))))

if __name__ == '__main__': main()
