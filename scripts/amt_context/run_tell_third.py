"""PREREG_TELL_THIRD.md: robustness (NOT confirmation) of the lead 'top-third busy forecast tell trades net less'. EXPLORE only, SIMULATED dollars. READS OUTCOMES -> look logged first by log_look_tell_third.mjs.
Usage: ../../venv/bin/python run_tell_third.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, trade as T, forecast_features as FF
import run_p2b as P
from run_p3 import dm, FIRST_TRAIN, STEP
SEED, BOOT, DRAWS, SEED_N = 20261102, 3000, 1000, 100

def main():
    rng = np.random.default_rng(SEED + 13); _, ctxs, _ = TS.sessions_and_contexts(); dates = [str(x) for x in sorted(ctxs)]; pos = {d: k for k, d in enumerate(dates)}
    df = P.build_points(ctxs, horizons=(30,)); df = df[df['full30']].reset_index(drop=True); recs = []
    for d in dates:
        ctx = ctxs[d]; S = ctx['S']; end, comp, h, l = S['end'], S['comp'], S['h'], S['l']; dow = pd.Timestamp(d).dayofweek
        for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0)):
            if pos[d] < FIRST_TRAIN: continue
            ei, dr = int(t['ei']), int(t['dir']); ts = float(end[ei - 1]); row = FF.activity_row(ctx, ts, dow)
            if row is None or end[comp].max() < ts + 1740.0: continue
            win = np.where(comp & (np.arange(ctx['n']) >= ei) & (end <= ts + 1800.0))[0]
            if len(win) == 0: continue
            en = float(t['entry']); mfe = (h[win].max() - en) if dr == 1 else (en - l[win].min()); mae = (en - l[win].min()) if dr == 1 else (h[win].max() - en)
            r = {k: row[k] for k in FF.CONT + ['bucket', 'dow']}; r.update(date=d, net=float(t['net']), reason=t['reason'], mfe=max(0.0, mfe) / ctx['atr'], mae=max(0.0, mae) / ctx['atr'], blk=FIRST_TRAIN + ((pos[d] - FIRST_TRAIN) // STEP) * STEP); recs.append(r)
    R = pd.DataFrame(recs); fc = np.full(len(R), np.nan)
    for blk in sorted(R.blk.unique()):
        tr = df[df.date.isin(dates[:blk])]; ytr = np.log(np.maximum(tr['E30'].values, 1e-4)); sel = (R.blk == blk).values
        Z, Zte = P.standardize(dm(tr), dm(R[sel])); a = P.choose_alpha(Z, ytr, tr['date'].values); ym = ytr.mean(); fc[sel] = Zte @ P.ridge_solve(Z.T @ Z, Z.T @ (ytr - ym), a) + ym
    R['fc'] = fc; R = R.sort_values(['date']).reset_index(drop=True); f = R.fc.values
    cut = np.array([np.quantile(f[:k], 2 / 3) if k >= SEED_N else np.nan for k in range(len(R))]); E = R.iloc[SEED_N:].copy(); E['top'] = f[SEED_N:] > cut[SEED_N:]
    T_, Rt = E[E.top], E[~E.top]; print(f'evaluated {len(E)} trades on {E.date.nunique()} dates (first {SEED_N} seed the cutoff); TOP N={len(T_)} REST N={len(Rt)}')
    def diff(x): return x[x.top].net.mean() - x[~x.top].net.mean()
    by = {d: np.where(E.date.values == d)[0] for d in E.date.unique()}; ks = list(by); bs = []
    for _ in range(BOOT): ix = np.concatenate([by[ks[j]] for j in rng.integers(0, len(ks), len(ks))]); bs.append(diff(E.iloc[ix]))
    d0 = diff(E); lo, hi = np.percentile(bs, [2.5, 97.5]); med = np.sort(E.date.unique())[E.date.nunique() // 2]; hh = [E[E.date <= med], E[E.date > med]]; hd = [diff(x) for x in hh]
    nul = []
    for _ in range(DRAWS):
        lab = E.top.values.copy()
        for m in ((E.date <= med).values, (E.date > med).values): idx = np.where(m)[0]; lab[idx] = lab[rng.permutation(idx)]
        x = E.copy(); x['top'] = lab; nul.append(diff(x))
    p = float((np.sum(np.array(nul) <= d0) + 1) / (DRAWS + 1)); ok = hi < 0 and p < 0.05 and all(v < 0 for v in hd)
    print(f'C1: net(TOP) ${T_.net.mean():+.2f} vs net(REST) ${Rt.net.mean():+.2f}; difference ${d0:+.2f}, day-blocked CI [{lo:+.2f}, {hi:+.2f}], permutation p {p:.4f}, halves {hd[0]:+.2f} / {hd[1]:+.2f} -> {"lead supported (weakly)" if ok else "NOT distinguishable from noise / not stable"}')
    dts = np.sort(E.date.unique()); qs = np.array_split(dts, 4); print('\nE1 quarters (dates, N top / N rest, difference $):')
    for q in qs:
        g = E[E.date.isin(q)]; print(f'  {q[0]}..{q[-1]}  top {int(g.top.sum()):3d} / rest {int((~g.top).sum()):3d}  diff ${diff(g):+.2f}' + ('' if g.top.sum() >= 30 else '  (fewer than 30 top trades: not read)'))
    st = lambda g: np.mean([x in ('STOP', 'STOP_GAP') for x in g.reason])
    print(f'\nE2: stop-out share TOP {100 * st(T_):.0f}% vs REST {100 * st(Rt):.0f}%; MFE30 TOP {T_.mfe.mean():.3f} vs REST {Rt.mfe.mean():.3f}; MAE30 TOP {T_.mae.mean():.3f} vs REST {Rt.mae.mean():.3f}')
    k = (E.net - E.net.mean()).abs().sort_values(ascending=False).index[:10]; print(f'     leave-top-10-extreme-trades-out difference ${diff(E.drop(index=k)):+.2f} (full {d0:+.2f})')

if __name__ == '__main__': main()
