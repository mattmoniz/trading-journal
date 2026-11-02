"""docs/TELL_PULLBACK_AND_LEVEL_DIRECTION_PREREG_20261102.md Part B: the tell is the timing trigger, the nearest market level chooses the side (fade it). EXPLORE only, points. READS OUTCOMES -> look logged first. Usage: nice python run_tell_level_direction.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T
from run_tell_at_level import outcomes, vwap_by_bar
SEED, BOOT = 20261102, 3000; HZ = (15, 30, 60)

def prior_levels(S):
    rth = (S['end'] >= V.RTH_OPEN) & (S['end'] < V.RTH_CLOSE)
    if rth.sum() < 30: return {}
    idx = np.where(rth)[0]; L = {'PDH': float(S['h'][rth].max()), 'PDL': float(S['l'][rth].min()), 'PDC': float(S['c'][idx[-1]])}
    m = np.isin(S['vi'], idx)
    if m.any(): tick = S['vp'][m]; vol = np.bincount(tick - tick.min(), weights=S['vv'][m]); L['PDPOC'] = float((tick.min() + int(np.argmax(vol))) * 0.25)
    return L

def choose(ctx, vw, i, pl):
    S = ctx['S']; c = S['c'][i]; lv = {'VWAP': vw[i], 'ONH': ctx['onh'], 'ONL': ctx['onl']}
    if S['end'][i] >= V.RTH_OPEN + 3600 and ctx['ibh'] is not None: lv['IBH'] = ctx['ibh']; lv['IBL'] = ctx['ibl']
    lv.update(pl); lv = {k: v for k, v in lv.items() if v is not None and np.isfinite(v)}
    up = [(v - c, k) for k, v in lv.items() if v > c]; dn = [(c - v, k) for k, v in lv.items() if v < c]
    if not up or not dn: return None
    du, ku = min(up); dl, kd = min(dn); scale = float(np.median(S['h'][i - 19:i + 1] - S['l'][i - 19:i + 1])) if i >= 20 else None
    if scale is None or min(du, dl) > 2 * scale: return None
    return (-1, ku, du) if du < dl else (1, kd, dl)

def main():
    rng = np.random.default_rng(SEED + 163); sess, ctxs, _ = TS.sessions_and_contexts(); ks = sorted(sess); rows = []; npts = {'TELL': 0, 'CONTROL': 0}
    for d in sorted(ctxs):
        k = ks.index(d); pl = prior_levels(sess[ks[k - 1]]); ctx = ctxs[d]; S = ctx['S']; vw = vwap_by_bar(S); end, comp = S['end'], S['comp']; prof = T.Prof(ctx)
        tells = [(int(t['sig']), int(t['dir'])) for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0))]
        ctl = [(i, 0) for i in range(ctx['n'] - 1) if i % 10 == 0 and V.DEC_FIRST <= end[i] <= V.DEC_LAST and comp[i] and (ctx['moving1'][i] or ctx['moving-1'][i]) and not any(T.ncomp_at(ctx, prof, i, dd, need_nodes=False)[1] for dd in (1, -1))]
        for arm, pts in (('TELL', tells), ('CONTROL', ctl)):
            for i, tdir in pts:
                npts[arm] += 1
                if i < 20 or i + 4 >= ctx['n']: continue
                ch = choose(ctx, vw, i, pl)
                if ch is None: continue
                dr, lvl, dist = ch; r = dict(date=d, arm=arm, dr=dr, level=lvl, agree=(None if arm == 'CONTROL' else dr == tdir), hour=int(((S['start'][i] + 18 * 3600) // 3600) % 24), minute_open=float((S['start'][i] - V.RTH_OPEN) / 60.0))
                for H in HZ: r[f'y{H}'] = outcomes(S, i + 1, dr, H)
                rows.append(r)
    R = pd.DataFrame(rows); R.to_csv('/home/mmoniz/trading-journal/scratch/tell_level_direction_rows_20261102.csv', index=False); cT = int((R.arm == 'TELL').sum()); cC = int((R.arm == 'CONTROL').sum()); print(f'signal bars TELL {npts["TELL"]}, CONTROL {npts["CONTROL"]}; near a level (event): TELL {cT} ({100 * cT / npts["TELL"]:.0f}%), CONTROL {cC} ({100 * cC / npts["CONTROL"]:.0f}%)')
    res = {}
    for H in HZ:
        g = lambda a: R[R.arm == a].dropna(subset=[f'y{H}']).groupby('date')[f'y{H}'].agg(['sum', 'count']); gT, gC = g('TELL'), g('CONTROL'); ud = np.array(sorted(set(gT.index) | set(gC.index)))
        AT = np.c_[gT.reindex(ud)['sum'].fillna(0).values, gT.reindex(ud)['count'].fillna(0).values]; AC = np.c_[gC.reindex(ud)['sum'].fillna(0).values, gC.reindex(ud)['count'].fillna(0).values]; m = lambda w, a: (w @ a[:, 0]) / max(1.0, w @ a[:, 1]); w1 = np.ones(len(ud)); bd, bt = [], []
        for _ in range(BOOT): w = np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float); bd.append(m(w, AT) - m(w, AC)); bt.append(m(w, AT))
        h = len(ud) // 2; ha = (np.arange(len(ud)) < h) * 1.0; hb = 1 - ha; diff = m(w1, AT) - m(w1, AC); p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
        res[H] = dict(diff=diff, lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), tm=m(w1, AT), tl=np.percentile(bt, 2.5), th=np.percentile(bt, 97.5), cm=m(w1, AC), p=p, h1=m(ha, AT) - m(ha, AC), h2=m(hb, AT) - m(hb, AC), n=int(AT[:, 1].sum()), days=int((AT[:, 1] > 0).sum()))
    order = sorted(HZ, key=lambda x: res[x]['p']); keep = -1
    for rk, x in enumerate(order): keep = rk if res[x]['p'] <= (rk + 1) / 3 * 0.10 else keep
    print('\nRESOLUTION (TELL absolute-mean CI half-width, points): ' + ', '.join(f'{x}m {(res[x]["th"] - res[x]["tl"]) / 2:.1f}' for x in HZ)); print('\nCOUNTED: y = points in the direction that FADES the nearest level (positive = the level held; negative = it was a launch pad)')
    for rk, x in enumerate(order):
        r = res[x]; sgn = np.sign(r['diff']); ok = rk <= keep and (r['lo'] > 0 or r['hi'] < 0) and ((r['tl'] > 1.5) if sgn > 0 else (-r['th'] > 1.5)) and r['n'] >= 200 and r['days'] >= 100 and np.sign(r['h1']) == np.sign(r['h2']) == sgn
        print(f'  H {x:2d}m: TELL mean {r["tm"]:+.2f} [{r["tl"]:+.2f}, {r["th"]:+.2f}] (N {r["n"]}, {r["days"]} dates), CONTROL {r["cm"]:+.2f}, TELL minus CONTROL {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.2f} / {r["h2"]:+.2f} BH {"survives" if rk <= keep else "no"}{"  UNDERPOWERED" if r["n"] < 200 or r["days"] < 100 else ""}{"  <== CANDIDATE" if ok else ""}')
    t = R[R.arm == 'TELL']; print('\nUNCOUNTED per nearest level (TELL mean y30, N): ' + '; '.join(f'{lv} {t[t.level == lv].y30.mean():+.1f} ({int((t.level == lv).sum())})' for lv in sorted(t.level.unique())))
    print('UNCOUNTED tell direction vs the level-chosen direction: ' + '; '.join(f'tell {"AGREES" if v else "DISAGREES"}: N {int((t.agree == v).sum())}, mean y30 {t[t.agree == v].y30.mean():+.2f}' for v in (True, False)) + '; by year: ' + ', '.join(f'{y} {t[t.date.str[:4] == y].y30.mean():+.2f} (N {int((t.date.str[:4] == y).sum())})' for y in sorted(set(t.date.str[:4]))))

if __name__ == '__main__': main()
