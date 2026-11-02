"""Amendment 6 of PREREG_ROSTER_CONTEXT.md: does overnight volume (ONV = log of the overnight 500-volume bar count over its 20-session mean) add out-of-sample skill to the no-tell 30-minute forecast (BASE = notell2)? Structure copied from run_p2b.py main (same blocks, alpha rule, permutation null), two models.
EXPLORE only. READS OUTCOMES (realized E_30) -> look logged first by log_look_overnight_volume.mjs.  Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/amt_context/run_overnight_volume.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
from scipy.stats import rankdata, spearmanr
import tell_state as TS, vbars as V
import run_p2b as P
SEED, BOOT, DRAWS = 20261102, 3000, 1000
rho = lambda p, e: float(np.corrcoef(rankdata(p), rankdata(e))[0, 1])

def onv_by_date(sess, ctx_dates):
    """ONV per ctx date: log(N_on / mean N_on of the 20 sessions before it in the SAME ordered session list the ATR20 baseline uses). Returns ({date: onv}, dropped count)."""
    ks = sorted(sess); n_on = {d: int((sess[d]['comp'] & (sess[d]['end'] < V.RTH_OPEN)).sum()) for d in ks}; out = {}; dropped = 0
    for k, d in enumerate(ks):
        if d not in ctx_dates: continue
        prior = [n_on[p] for p in ks[k - 20:k]]
        if len(prior) < 20 or np.mean(prior) <= 0 or n_on[d] <= 0: dropped += 1; continue
        out[d] = float(np.log(n_on[d] / np.mean(prior)))
    return out, dropped

def main():
    rng = np.random.default_rng(SEED + 19); sess, ctxs, _ = TS.sessions_and_contexts(); onv, dropped = onv_by_date(sess, set(ctxs))
    df = P.build_points(ctxs); n0 = len(df); df['onv'] = df.date.map(onv); df = df[df.onv.notna()].reset_index(drop=True)
    print(f'decision points {n0}; with ONV {len(df)} on {df.date.nunique()} dates (sessions dropped for ONV: {dropped}); ONV mean {df.onv.mean():+.3f} sd {df.onv.std():.3f}')
    dates = np.array(sorted(df.date.unique())); blocks = [dates[k:k + P.STEP] for k in range(P.FIRST_TRAIN, len(dates), P.STEP)]
    models = {'base': P.design(df, P.ACT + P.RR, ['bucket', 'dow']), 'plus': P.design(df, P.ACT + P.RR + ['onv'], ['bucket', 'dow'])}
    sub = df[df['E30'].notna()].index.values; E = df.loc[sub, 'E30'].values; y = np.log(np.maximum(E, 1e-4)); D = df.loc[sub, 'date'].values; B = df.loc[sub, 'bucket'].values
    pred = {m: np.full(len(sub), np.nan) for m in ['clock'] + list(models)}; cache = {m: [] for m in models}; bl_idx = []; oos = np.zeros(len(sub), bool); coefs = None
    for blk in blocks:
        te = np.isin(D, blk); tr = D < blk[0]
        if te.sum() == 0: continue
        oos |= te; bl_idx.append((tr, te))
        for m, X in models.items():
            Z, Zte = P.standardize(X[sub][tr], X[sub][te]); a = P.choose_alpha(Z, y[tr], D[tr]); ym = y[tr].mean(); w = P.ridge_solve(Z.T @ Z, Z.T @ (y[tr] - ym), a); pred[m][te] = Zte @ w + ym; cache[m].append((Z, Zte, Z.T @ Z, a))
            if m == 'plus': coefs = (w[len(P.ACT + P.RR)], a)
        gm = E[tr].mean(); bm = {b: (E[tr][B[tr] == b].mean() if (B[tr] == b).sum() >= 50 else gm) for b in np.unique(B)}; pred['clock'][te] = [bm.get(b, gm) for b in B[te]]
    oi = np.where(oos)[0]; Eo = E[oi]; Do = D[oi]; Pm = {m: pred[m][oi] for m in pred}; r0 = {m: rho(Pm[m], Eo) for m in Pm}
    print(f'\n{len(oi)} out-of-sample rows on {len(np.unique(Do))} dates. Spearman: clock {r0["clock"]:+.4f}, BASE {r0["base"]:+.4f} (run_p2b notell2 +0.6467, clock +0.2628), PLUS {r0["plus"]:+.4f}')
    if round(r0['base'], 4) != 0.6467 or round(r0['clock'], 4) != 0.2628: print('NOTE: BASE does not reproduce run_p2b exactly (ONV drops sessions or the population changed); see counts above')
    d0 = r0['plus'] - r0['base']; med = np.sort(np.unique(Do))[len(np.unique(Do)) // 2]; h1 = Do <= med
    byd = {d: np.where(Do == d)[0] for d in np.unique(Do)}; ks = list(byd); boots = []
    for _ in range(BOOT):
        ix = np.concatenate([byd[ks[j]] for j in rng.integers(0, len(ks), len(ks))]); boots.append(rho(Pm['plus'][ix], Eo[ix]) - rho(Pm['base'][ix], Eo[ix]))
    nulls = []; by_date = {d: np.where(D == d)[0] for d in np.unique(D)}; ud = list(by_date)
    for _ in range(DRAWS):
        perm = rng.permutation(len(ud)); src = np.zeros(len(sub), int)
        for k, d in enumerate(ud): ia, ib = by_date[d], by_date[ud[perm[k]]]; src[ia] = ib[np.arange(len(ia)) % len(ib)]
        yp, Ep = y[src], E[src]; Pp = {m: np.full(len(sub), np.nan) for m in models}
        for bi, (tr, te) in enumerate(bl_idx):
            for m in models: Z, Zte, ZtZ, a = cache[m][bi]; ym = yp[tr].mean(); Pp[m][te] = Zte @ P.ridge_solve(ZtZ, Z.T @ (yp[tr] - ym), a) + ym
        nulls.append(rho(Pp['plus'][oi], Ep[oi]) - rho(Pp['base'][oi], Ep[oi]))
    lo, hi = np.percentile(boots, [2.5, 97.5]); p = float((np.sum(np.array(nulls) >= d0) + 1) / (DRAWS + 1))
    ha = rho(Pm['plus'][h1], Eo[h1]) - rho(Pm['base'][h1], Eo[h1]); hb = rho(Pm['plus'][~h1], Eo[~h1]) - rho(Pm['base'][~h1], Eo[~h1]); ok = lo > 0 and p < 0.05 and ha > 0 and hb > 0
    print(f'\nAmendment 6 PLUS - BASE: {d0:+.4f}  day-blocked CI [{lo:+.4f}, {hi:+.4f}]  permutation p {p:.4f}  halves {ha:+.4f} / {hb:+.4f}  -> {"PASS" if ok else "NOT PASSED"}')
    print(f'uncounted: spearman(ONV, overnight_range_atr) over dates {spearmanr(df.drop_duplicates("date").onv, df.drop_duplicates("date").overnight_range_atr)[0]:+.3f}; PLUS standardized ONV coefficient in the last refit {coefs[0]:+.4f} (alpha {coefs[1]})')
    for q, qd in enumerate(np.array_split(np.sort(np.unique(Do)), 4)):
        m = np.isin(Do, qd); print(f'  quarter {q + 1} {qd[0]}..{qd[-1]}: BASE {rho(Pm["base"][m], Eo[m]):+.4f} PLUS {rho(Pm["plus"][m], Eo[m]):+.4f} diff {rho(Pm["plus"][m], Eo[m]) - rho(Pm["base"][m], Eo[m]):+.4f}')

if __name__ == '__main__': main()
