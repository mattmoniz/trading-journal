"""PREREG_TELL_TARGET.md: forecast at the tell's entry vs the V1 trade's favorable / adverse 30-minute excursion. EXPLORE only. READS OUTCOMES (price paths after the signal; V1 `net` descriptively) -> look logged first by log_look_tell_target.mjs.
Usage: ../../venv/bin/python run_tell_target.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
from scipy.stats import rankdata
import tell_state as TS, vbars as V, trade as T, forecast_features as FF
import run_p2b as P
from run_p3 import dm, FIRST_TRAIN, STEP
SEED, BOOT, DRAWS = 20261102, 3000, 1000
sp = lambda a, b: float(np.corrcoef(rankdata(a), rankdata(b))[0, 1])

def main():
    rng = np.random.default_rng(SEED + 7); _, ctxs, _ = TS.sessions_and_contexts(); dates = np.array(sorted(ctxs)); pos = {d: k for k, d in enumerate(dates)}
    df = P.build_points(ctxs, horizons=(30,)); df = df[df['full30']].reset_index(drop=True); recs = []; drop = dict(first_train=0, no_row=0, window=0); n_trades = 0
    for d in map(str, dates):
        ctx = ctxs[d]; S = ctx['S']; end, comp, h, l, o = S['end'], S['comp'], S['h'], S['l'], S['o']; dow = pd.Timestamp(d).dayofweek
        for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0)):
            n_trades += 1
            if pos[d] < FIRST_TRAIN: drop['first_train'] += 1; continue
            ei, dr = int(t['ei']), int(t['dir']); sig = ei - 1; ts = float(end[sig]); row = FF.activity_row(ctx, ts, dow)
            if row is None: drop['no_row'] += 1; continue
            if end[comp].max() < ts + 1800.0 - 60.0: drop['window'] += 1; continue
            win = np.where(comp & (np.arange(ctx['n']) >= ei) & (end <= ts + 1800.0))[0]
            if len(win) == 0: drop['window'] += 1; continue
            entry = float(t['entry']); mfe = (h[win].max() - entry) if dr == 1 else (entry - l[win].min()); mae = (entry - l[win].min()) if dr == 1 else (h[win].max() - entry)
            r = {k: row[k] for k in FF.CONT + ['bucket', 'dow']}; r.update(date=d, dir=dr, net=float(t['net']), mfe=max(0.0, mfe) / ctx['atr'], mae=max(0.0, mae) / ctx['atr'], blk=FIRST_TRAIN + ((pos[d] - FIRST_TRAIN) // STEP) * STEP); recs.append(r)
    R = pd.DataFrame(recs); print(f'V1 tell trades {n_trades}; dropped {drop}; evaluated {len(R)} trades on {R.date.nunique()} dates')
    fc = np.full(len(R), np.nan); bl = np.full(len(R), np.nan)
    for blk in sorted(R.blk.unique()):
        tr = df[df.date.isin(dates[:blk])]; Xtr = dm(tr); ytr = np.log(np.maximum(tr['E30'].values, 1e-4)); sel = (R.blk == blk).values
        Z, Zte = P.standardize(Xtr, dm(R[sel])); a = P.choose_alpha(Z, ytr, tr['date'].values); ym = ytr.mean(); fc[sel] = Zte @ P.ridge_solve(Z.T @ Z, Z.T @ (ytr - ym), a) + ym
        gm = tr['E30'].mean(); bm = {b: (tr[tr.bucket == b]['E30'].mean() if (tr.bucket == b).sum() >= 50 else gm) for b in range(10)}; bl[sel] = [bm[b] for b in R[sel].bucket]
    R['fc'], R['bl'] = fc, bl; R['net_exc'] = R.mfe - R.mae; med = np.sort(R.date.unique())[R.date.nunique() // 2]; h1, h2 = (R.date <= med).values, (R.date > med).values
    stats = lambda Rr, f, b: dict(T1=sp(f, Rr.mfe.values) - sp(b, Rr.mfe.values), T2=sp(f, Rr.net_exc.values))
    s0 = stats(R, R.fc.values, R.bl.values); by = {d: np.where(R.date.values == d)[0] for d in R.date.unique()}; ks = list(by); boot = {k: [] for k in s0}
    for _ in range(BOOT):
        ix = np.concatenate([by[ks[j]] for j in rng.integers(0, len(ks), len(ks))]); s = stats(R.iloc[ix], R.fc.values[ix], R.bl.values[ix])
        for k in s0: boot[k].append(s[k])
    nulls = {k: [] for k in s0}; ud = list(by)
    for _ in range(DRAWS):
        perm = rng.permutation(len(ud)); src = np.zeros(len(R), int)
        for k, d in enumerate(ud): ia, ib = by[d], by[ud[perm[k]]]; src[ia] = ib[np.arange(len(ia)) % len(ib)]
        s = stats(R, R.fc.values[src], R.bl.values[src])
        for k in s0: nulls[k].append(s[k])
    print(f'\nout-of-sample on {len(R)} tell trades: Spearman(forecast, MFE30) {sp(R.fc.values, R.mfe.values):+.4f}, (baseline, MFE30) {sp(R.bl.values, R.mfe.values):+.4f}, (forecast, MAE30) {sp(R.fc.values, R.mae.values):+.4f}, (forecast, MFE30-MAE30) {s0["T2"]:+.4f}')
    res = {}
    for k, nm in (('T1', 'T1 favorable reach: forecast minus baseline vs MFE30'), ('T2', 'T2 side advantage: forecast vs MFE30-MAE30')):
        lo, hi = np.percentile(boot[k], [2.5, 97.5]); p = float((np.sum(np.array(nulls[k]) >= s0[k]) + 1) / (DRAWS + 1)); a1, a2 = stats(R[h1], R.fc.values[h1], R.bl.values[h1])[k], stats(R[h2], R.fc.values[h2], R.bl.values[h2])[k]
        ok = lo > 0 and p < 0.05 and a1 > 0 and a2 > 0; res[k] = (p, ok); print(f'  {nm}: {s0[k]:+.4f} CI [{lo:+.4f}, {hi:+.4f}] permutation p {p:.4f} halves {a1:+.4f} / {a2:+.4f} -> {"PASS" if ok else "NOT PASSED"}')
    q = np.quantile(R.fc, [1 / 3, 2 / 3]); R['third'] = np.where(R.fc <= q[0], 'low', np.where(R.fc <= q[1], 'mid', 'high'))
    print('\ndescriptive (uncounted), terciles of all evaluated trades: N, mean MFE30, mean MAE30, mean V1 trade net $')
    for t in ('low', 'mid', 'high'): g = R[R.third == t]; print(f'  {t:4s} N={len(g):4d} MFE30 {g.mfe.mean():.3f} MAE30 {g.mae.mean():.3f}  net ${g.net.mean():+.2f}')
    ps = sorted((v[0], k) for k, v in res.items()); keep = max([i for i, (p, _) in enumerate(ps) if p <= (i + 1) / 2 * 0.10] + [-1]); print('BH q=0.10 over T1,T2:', {k: ('rejects' if i <= keep else 'does not reject') for i, (p, k) in enumerate(ps)})

if __name__ == '__main__': main()
