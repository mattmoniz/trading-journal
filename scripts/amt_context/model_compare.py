"""Shared walk-forward model comparison for the forecast amendments (PREREG_ROSTER_CONTEXT.md Amendments 6 and 7): the run_p2b.py pipeline (same blocks, alpha rule, day-blocked bootstrap, date-permutation null) for any set of ridge designs.
Extracted from run_overnight_volume.py (cv-079). Compares out-of-sample Spearman of design `a` minus design `b` on E_30."""
import numpy as np
from scipy.stats import rankdata
import run_p2b as P
rho = lambda p, e: float(np.corrcoef(rankdata(p), rankdata(e))[0, 1])

def compare(df, designs, a, b, seed, boot=3000, draws=1000, raw=None):
    """df: build_points output (columns date, bucket, E30, ...). designs: {name: design matrix aligned with df rows}. Returns a dict with per-model Spearman (+ clock baseline), the a-b difference with CI, permutation p, halves, quarters, per-model out-of-sample predictions, last-refit coefficients.
    raw: optional {name: array aligned with df} of model-free predictors whose Spearman with realized E_30 is reported on the same out-of-sample rows."""
    rng = np.random.default_rng(seed); dates = np.array(sorted(df.date.unique())); blocks = [dates[k:k + P.STEP] for k in range(P.FIRST_TRAIN, len(dates), P.STEP)]
    sub = df[df['E30'].notna()].index.values; E = df.loc[sub, 'E30'].values; y = np.log(np.maximum(E, 1e-4)); D = df.loc[sub, 'date'].values; B = df.loc[sub, 'bucket'].values
    pred = {m: np.full(len(sub), np.nan) for m in ['clock'] + list(designs)}; cache = {m: [] for m in designs}; bl_idx = []; oos = np.zeros(len(sub), bool); coefs = {}
    for blk in blocks:
        te = np.isin(D, blk); tr = D < blk[0]
        if te.sum() == 0: continue
        oos |= te; bl_idx.append((tr, te))
        for m, X in designs.items():
            Z, Zte = P.standardize(X[sub][tr], X[sub][te]); al = P.choose_alpha(Z, y[tr], D[tr]); ym = y[tr].mean(); w = P.ridge_solve(Z.T @ Z, Z.T @ (y[tr] - ym), al); pred[m][te] = Zte @ w + ym; cache[m].append((Z, Zte, Z.T @ Z, al)); coefs[m] = (w, al)
        gm = E[tr].mean(); bm = {bk: (E[tr][B[tr] == bk].mean() if (B[tr] == bk).sum() >= 50 else gm) for bk in np.unique(B)}; pred['clock'][te] = [bm.get(bk, gm) for bk in B[te]]
    oi = np.where(oos)[0]; Eo = E[oi]; Do = D[oi]; Pm = {m: pred[m][oi] for m in pred}; r0 = {m: rho(Pm[m], Eo) for m in Pm}
    rawr = {k: rho(np.asarray(v)[sub][oi], Eo) for k, v in (raw or {}).items()}
    d0 = r0[a] - r0[b]; med = np.sort(np.unique(Do))[len(np.unique(Do)) // 2]; h1 = Do <= med
    byd = {d: np.where(Do == d)[0] for d in np.unique(Do)}; ks = list(byd); boots = []
    for _ in range(boot):
        ix = np.concatenate([byd[ks[j]] for j in rng.integers(0, len(ks), len(ks))]); boots.append(rho(Pm[a][ix], Eo[ix]) - rho(Pm[b][ix], Eo[ix]))
    nulls = []; by_date = {d: np.where(D == d)[0] for d in np.unique(D)}; ud = list(by_date)
    for _ in range(draws):
        perm = rng.permutation(len(ud)); src = np.zeros(len(sub), int)
        for k, d in enumerate(ud): ia, ib = by_date[d], by_date[ud[perm[k]]]; src[ia] = ib[np.arange(len(ia)) % len(ib)]
        yp, Ep = y[src], E[src]; Pp = {m: np.full(len(sub), np.nan) for m in (a, b)}
        for bi, (tr, te) in enumerate(bl_idx):
            for m in (a, b): Z, Zte, ZtZ, al = cache[m][bi]; ym = yp[tr].mean(); Pp[m][te] = Zte @ P.ridge_solve(ZtZ, Z.T @ (yp[tr] - ym), al) + ym
        nulls.append(rho(Pp[a][oi], Ep[oi]) - rho(Pp[b][oi], Ep[oi]))
    lo, hi = np.percentile(boots, [2.5, 97.5]); p = float((np.sum(np.array(nulls) >= d0) + 1) / (draws + 1))
    hd = lambda m: rho(Pm[a][m], Eo[m]) - rho(Pm[b][m], Eo[m]); ha, hb = hd(h1), hd(~h1)
    quarters = [(qd[0], qd[-1], {m: rho(Pm[m][np.isin(Do, qd)], Eo[np.isin(Do, qd)]) for m in Pm}) for qd in np.array_split(np.sort(np.unique(Do)), 4)]
    return dict(n_oos=len(oi), n_dates=len(np.unique(Do)), r=r0, raw=rawr, diff=d0, ci=(lo, hi), p=p, halves=(ha, hb), passed=bool(lo > 0 and p < 0.05 and ha > 0 and hb > 0), quarters=quarters, coefs=coefs)
