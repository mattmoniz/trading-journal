"""docs/TELL_PULLBACK_AND_LEVEL_DIRECTION_PREREG_20261102.md Part C: Globex, causal tell variant (no range gate), levels that exist at the time. EXPLORE only, points. READS OUTCOMES -> look logged first. Usage: nice python run_tell_level_direction_globex.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T
from run_tell_at_level import outcomes
from run_tell_level_direction import prior_levels
SEED, BOOT = 20261102, 3000; HZ = (15, 30, 60); G0, G1 = 1800.0, 54000.0      # 18:30 and 09:00 ET in seconds since the 18:00 open

def session_vwap(S):
    n = len(S['c']); px = S['vp'] * 0.25; pv = np.bincount(S['vi'], weights=px * S['vv'], minlength=n); vv = np.bincount(S['vi'], weights=S['vv'], minlength=n); cv = np.cumsum(vv)
    return np.where(cv > 0, np.cumsum(pv) / np.maximum(cv, 1e-9), np.nan)

def choose(S, vw, i, pl, hh, ll):
    c = S['c'][i]; lv = {'VWAP': vw[i], 'ONH_run': hh[i], 'ONL_run': ll[i]}; lv.update(pl); lv = {k: v for k, v in lv.items() if v is not None and np.isfinite(v)}
    up = [(v - c, k) for k, v in lv.items() if v > c]; dn = [(c - v, k) for k, v in lv.items() if v < c]
    if not up or not dn: return None
    du, ku = min(up); dl, kd = min(dn); scale = float(np.median(S['h'][i - 19:i + 1] - S['l'][i - 19:i + 1]))
    if min(du, dl) > 2 * scale: return None
    return (-1, ku) if du < dl else (1, kd)

def main():
    rng = np.random.default_rng(SEED + 167); sess, ctxs, _ = TS.sessions_and_contexts(); ks = sorted(sess); rows = []; npts = {'TELL': 0, 'CONTROL': 0}
    for d in sorted(ctxs):
        k = ks.index(d); pl = prior_levels(sess[ks[k - 1]]); ctx = ctxs[d]; S = ctx['S']; end, comp, h, l = S['end'], S['comp'], S['h'], S['l']; n = ctx['n']; vw = session_vwap(S); hh = np.r_[np.nan, np.maximum.accumulate(h)[:-1]]; ll = np.r_[np.nan, np.minimum.accumulate(l)[:-1]]; prof = T.Prof(ctx); armed = {1: True, -1: True}; tells = []; ctl = []
        for i in range(V.MOVE_N, n - 6):
            if not comp[i] or end[i] < G0 or end[i] > G1: continue
            t5 = {dd: T.ncomp_at(ctx, prof, i, dd, need_nodes=True)[1] for dd in (1, -1)}; cand = [dd for dd in (1, -1) if t5[dd] and armed[dd]]
            for dd in (1, -1):
                if not t5[dd]: armed[dd] = True
            if len(cand) == 1 and not (t5[1] and t5[-1]): tells.append((i, cand[0])); armed[cand[0]] = False
            elif cand: armed[cand[0]] = False if len(cand) == 1 else armed[cand[0]]
            if i % 10 == 0 and (ctx['moving1'][i] or ctx['moving-1'][i]) and not (t5[1] or t5[-1]): ctl.append((i, 0))
        for arm, pts in (('TELL', tells), ('CONTROL', ctl)):
            for i, tdir in pts:
                npts[arm] += 1
                if i < 40 or i + 4 >= n: continue
                ch = choose(S, vw, i, pl, hh, ll)
                if ch is None: continue
                dr, lvl = ch; hour = int(((S['start'][i] + 18 * 3600) // 3600) % 24); r = dict(date=d, arm=arm, dr=dr, level=lvl, agree=(None if arm == 'CONTROL' else dr == tdir), block=('18:30-00' if hour >= 18 or hour == 0 and False else '00-03' if hour < 3 else '03-08' if hour < 8 else '08-09'))
                for H in HZ: r[f'y{H}'] = outcomes(S, i + 1, dr, H)
                rows.append(r)
    R = pd.DataFrame(rows); R.to_csv('/home/mmoniz/trading-journal/scratch/tell_level_direction_globex_rows_20261102.csv', index=False); cT = int((R.arm == 'TELL').sum()); cC = int((R.arm == 'CONTROL').sum())
    print(f'Globex signal bars TELL {npts["TELL"]}, CONTROL {npts["CONTROL"]}; near a level (event): TELL {cT} on {R[R.arm == "TELL"].date.nunique()} dates, CONTROL {cC}')
    res = {}
    for H in HZ:
        g = lambda a: R[R.arm == a].dropna(subset=[f'y{H}']).groupby('date')[f'y{H}'].agg(['sum', 'count']); gT, gC = g('TELL'), g('CONTROL'); ud = np.array(sorted(set(gT.index) | set(gC.index)))
        AT = np.c_[gT.reindex(ud)['sum'].fillna(0).values, gT.reindex(ud)['count'].fillna(0).values]; AC = np.c_[gC.reindex(ud)['sum'].fillna(0).values, gC.reindex(ud)['count'].fillna(0).values]; m = lambda w, a: (w @ a[:, 0]) / max(1.0, w @ a[:, 1]); w1 = np.ones(len(ud)); bd, bt = [], []
        for _ in range(BOOT): w = np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float); bd.append(m(w, AT) - m(w, AC)); bt.append(m(w, AT))
        h = len(ud) // 2; ha = (np.arange(len(ud)) < h) * 1.0; hb = 1 - ha; diff = m(w1, AT) - m(w1, AC); p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
        res[H] = dict(diff=diff, lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), tm=m(w1, AT), tl=np.percentile(bt, 2.5), th=np.percentile(bt, 97.5), cm=m(w1, AC), p=p, h1=m(ha, AT) - m(ha, AC), h2=m(hb, AT) - m(hb, AC), n=int(AT[:, 1].sum()), days=int((AT[:, 1] > 0).sum()))
    order = sorted(HZ, key=lambda x: res[x]['p']); keep = -1
    for rk, x in enumerate(order): keep = rk if res[x]['p'] <= (rk + 1) / 3 * 0.10 else keep
    print('\nRESOLUTION (TELL absolute-mean CI half-width, points): ' + ', '.join(f'{x}m {(res[x]["th"] - res[x]["tl"]) / 2:.1f}' for x in HZ)); print('\nCOUNTED (Globex): y = points in the direction that FADES the nearest level')
    for rk, x in enumerate(order):
        r = res[x]; sgn = np.sign(r['diff']); ok = rk <= keep and (r['lo'] > 0 or r['hi'] < 0) and ((r['tl'] > 1.5) if sgn > 0 else (-r['th'] > 1.5)) and r['n'] >= 200 and r['days'] >= 100 and np.sign(r['h1']) == np.sign(r['h2']) == sgn
        print(f'  H {x:2d}m: TELL mean {r["tm"]:+.2f} [{r["tl"]:+.2f}, {r["th"]:+.2f}] (N {r["n"]}, {r["days"]} dates), CONTROL {r["cm"]:+.2f}, TELL minus CONTROL {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.2f} / {r["h2"]:+.2f} BH {"survives" if rk <= keep else "no"}{"  UNDERPOWERED" if r["n"] < 200 or r["days"] < 100 else ""}{"  <== CANDIDATE" if ok else ""}')
    t = R[R.arm == 'TELL']; c = R[R.arm == 'CONTROL']
    print('\nUNCOUNTED by time block (y30: TELL mean (N) | CONTROL mean (N)): ' + '; '.join(f'{b} {t[t.block == b].y30.mean():+.1f} ({int((t.block == b).sum())}) | {c[c.block == b].y30.mean():+.1f} ({int((c.block == b).sum())})' for b in ('18:30-00', '00-03', '03-08', '08-09')))
    print('UNCOUNTED per level (TELL y30 (N) | CONTROL y30 (N)): ' + '; '.join(f'{lv} {t[t.level == lv].y30.mean():+.1f} ({int((t.level == lv).sum())}) | {c[c.level == lv].y30.mean():+.1f} ({int((c.level == lv).sum())})' for lv in sorted(t.level.unique())))
    print('UNCOUNTED tell direction vs the level-chosen side: ' + '; '.join(f'tell {"AGREES" if v else "DISAGREES"}: N {int((t.agree == v).sum())}, mean y30 {t[t.agree == v].y30.mean():+.2f}' for v in (True, False)) + '; by year: ' + ', '.join(f'{y} {t[t.date.str[:4] == y].y30.mean():+.2f} (N {int((t.date.str[:4] == y).sum())})' for y in sorted(set(t.date.str[:4]))))

if __name__ == '__main__': main()
