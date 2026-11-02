"""docs/TELL_PULLBACK_AND_LEVEL_DIRECTION_PREREG_20261102.md Part E: the tell's own direction by level agreement, user's MAJOR/MINOR classes. EXPLORE (already seen: reference only). READS OUTCOMES -> look logged first. Usage: nice python run_tell_level_classes.py"""
import sys; sys.argv = sys.argv[:1]
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_tell_live')
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T, persist
from run_tell_at_level import outcomes
from run_tell_level_families import FAM, load_levels, nearest
SEED, BOOT = 20261102, 3000; HZ = (15, 30, 60)
MINOR = FAM['FLOOR'] + FAM['CAMARILLA']; MAJOR = [n for f, v in FAM.items() if f not in ('FLOOR', 'CAMARILLA') for n in v]

def main():
    rng = np.random.default_rng(SEED + 181); sess, ctxs, _ = TS.sessions_and_contexts(); LV = load_levels(persist.connect()); rows = []
    for d in sorted(ctxs):
        if d not in LV: continue
        ctx = ctxs[d]; S = ctx['S']
        for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0)):
            i = int(t['sig']); tdir = int(t['dir'])
            if i < 20 or i + 4 >= ctx['n']: continue
            mo = (S['start'][i] - V.RTH_OPEN) / 60.0
            for cls, names in (('MAJOR', MAJOR), ('MINOR', MINOR)):
                ch = nearest(S, i, LV[d], names, mo)
                if ch is None: continue
                dr, lvl = ch; r = dict(date=d, cls=cls, level=lvl, agree=bool(dr == tdir), tdir=tdir)
                for H in HZ: r[f'y{H}'] = outcomes(S, i + 1, tdir, H)
                rows.append(r)
    R = pd.DataFrame(rows); R.to_csv('/home/mmoniz/trading-journal/scratch/tell_level_classes_rows_20261102.csv', index=False); print(f'events: MAJOR {int((R.cls == "MAJOR").sum())}, MINOR {int((R.cls == "MINOR").sum())}')
    def stat(df, H):
        d = df.dropna(subset=[f'y{H}']); ga = d[d.agree].groupby('date')[f'y{H}'].agg(['sum', 'count']); gd = d[~d.agree].groupby('date')[f'y{H}'].agg(['sum', 'count']); ud = np.array(sorted(set(ga.index) | set(gd.index)))
        A = np.c_[ga.reindex(ud)['sum'].fillna(0).values, ga.reindex(ud)['count'].fillna(0).values]; B = np.c_[gd.reindex(ud)['sum'].fillna(0).values, gd.reindex(ud)['count'].fillna(0).values]; m = lambda w, x: (w @ x[:, 0]) / max(1.0, w @ x[:, 1]); w1 = np.ones(len(ud)); bd, ba, bb = [], [], []
        for _ in range(BOOT): w = np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud)).astype(float); bd.append(m(w, A) - m(w, B)); ba.append(m(w, A)); bb.append(m(w, B))
        h = len(ud) // 2; ha = (np.arange(len(ud)) < h) * 1.0; hb = 1 - ha; p = float(min(1.0, 2 * min((np.sum(np.array(bd) <= 0) + 1) / (BOOT + 1), (np.sum(np.array(bd) >= 0) + 1) / (BOOT + 1))))
        return dict(diff=m(w1, A) - m(w1, B), lo=np.percentile(bd, 2.5), hi=np.percentile(bd, 97.5), a=m(w1, A), al=np.percentile(ba, 2.5), ah=np.percentile(ba, 97.5), b=m(w1, B), bl=np.percentile(bb, 2.5), bh=np.percentile(bb, 97.5), na=int(A[:, 1].sum()), nb=int(B[:, 1].sum()), p=p, h1=m(ha, A) - m(ha, B), h2=m(hb, A) - m(hb, B))
    res = {c: stat(R[R.cls == c], 30) for c in ('MAJOR', 'MINOR')}; order = sorted(res, key=lambda c: res[c]['p']); keep = -1
    for rk, c in enumerate(order): keep = rk if res[c]['p'] <= (rk + 1) / 2 * 0.10 else keep
    print('\nCOUNTED (y30 = points in the TELL direction; AGREE = tell equals the level side):')
    for rk, c in enumerate(order):
        r = res[c]; ok = rk <= keep and (r['lo'] > 0 or r['hi'] < 0) and min(r['na'], r['nb']) >= 150 and np.sign(r['h1']) == np.sign(r['h2']) == np.sign(r['diff'])
        print(f'  {c}: AGREE {r["a"]:+6.2f} [{r["al"]:+.1f}, {r["ah"]:+.1f}] (N {r["na"]}) | DISAGREE {r["b"]:+6.2f} [{r["bl"]:+.1f}, {r["bh"]:+.1f}] (N {r["nb"]}) | AGREE minus DISAGREE {r["diff"]:+.2f} CI [{r["lo"]:+.2f}, {r["hi"]:+.2f}] p {r["p"]:.3f} halves {r["h1"]:+.1f}/{r["h2"]:+.1f} BH {"survives" if rk <= keep else "no"}{"  <== SHOWS" if ok else ""}')
    for H in (15, 60): print(f'UNCOUNTED y{H}: ' + '; '.join(f'{c} agree {stat(R[R.cls == c], H)["a"]:+.1f} / disagree {stat(R[R.cls == c], H)["b"]:+.1f}' for c in ('MAJOR', 'MINOR')))
    sel = pd.concat([R[(R.cls == 'MAJOR') & R.agree], R[(R.cls == 'MINOR') & ~R.agree]]); print(f'UNCOUNTED the rule (AGREE at major + DISAGREE at minor): N {len(sel)}, mean y30 {sel.y30.mean():+.2f}; by year: ' + ', '.join(f'{y} {sel[sel.date.str[:4] == y].y30.mean():+.2f} (N {int((sel.date.str[:4] == y).sum())})' for y in sorted(set(sel.date.str[:4]))))
    print('UNCOUNTED per family inside MAJOR (agree / disagree y30, N): ' + '; '.join(f'{f} {R[(R.cls == "MAJOR") & R.level.isin(FAM[f]) & R.agree].y30.mean():+.1f} / {R[(R.cls == "MAJOR") & R.level.isin(FAM[f]) & ~R.agree].y30.mean():+.1f} ({int(((R.cls == "MAJOR") & R.level.isin(FAM[f])).sum())})' for f in FAM if f not in ('FLOOR', 'CAMARILLA')))

if __name__ == '__main__': main()
