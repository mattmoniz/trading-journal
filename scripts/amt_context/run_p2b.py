"""Amendment 2 of PREREG_ROSTER_CONTEXT.md (H3b2): the P2 walk-forward ridge for E_30 with recent realized range (rr15, rr30, rr60) added to the activity set of BOTH the full and the no-tell model. Copy of run_p2.py, E_30 only.
Metric: difference in out-of-sample Spearman(prediction, realized E). EXPLORE only. READS OUTCOMES -> the look is logged first by log_look_p2.mjs.  Usage: ../../venv/bin/python run_p2.py [DRAWS]"""
import sys, numpy as np, pandas as pd
from scipy.stats import rankdata
import tell_state as TS, vbars as V
SEED, BOOT = 20261102, 3000
DRAWS = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
ALPHAS = (0.1, 1.0, 10.0, 100.0, 1000.0); FIRST_TRAIN, STEP = 120, 20
FLAGS = ['tell_now', 'tell_any_5m', 'tell_any_15m', 'tell_any_30m', 'tell_any_60m']
TELL_OTHER = ['tell_bars_5m', 'tell_bars_15m', 'tell_bars_30m', 'tell_bars_60m', 'c4max_now', 'minutes_since_last_tell']
ACT = ['A_now', 'rth_range_so_far_atr', 'overnight_range_atr', 'minutes_since_rth_open']; RR = ['rr15', 'rr30', 'rr60']

def build_points(ctxs=None, horizons=(15, 30, 60), full_only=False):
    if ctxs is None: _, ctxs, _ = TS.sessions_and_contexts()
    rows = []
    for d, ctx in ctxs.items():
        S = ctx['S']; end, comp = S['end'], S['comp']; n = ctx['n']; fl = TS.bar_flags(ctx); dow = pd.Timestamp(d).dayofweek
        for i in [i for i in range(V.MOVE_N, n) if comp[i] and V.DEC_FIRST <= end[i] <= V.DEC_LAST][::V.THIN]:
            st = TS.state_at(ctx, float(end[i]), flags=fl)
            if st is None or st['rth_range_so_far_atr'] is None or not np.isfinite(st['A_now']): continue
            r = {k: v for k, v in st.items() if k not in ('i0', 'bar_end_sec', 'age_of_last_bar_s')}
            r['minutes_since_last_tell'] = 180.0 if r['minutes_since_last_tell'] is None else min(180.0, r['minutes_since_last_tell'])
            r.update(date=d, dow=dow, bucket=int(((end[i] - V.DEC_FIRST) // 1800) if end[i] >= V.DEC_FIRST else 0))
            for M in (15, 30, 60):
                w = comp & (end <= end[i]) & (end > end[i] - M * 60.0); r[f'rr{M}'] = float((S['h'][w].max() - S['l'][w].min()) / ctx['atr']) if w.any() else np.nan
            for W in horizons:
                hz = comp & (end > end[i]) & (end <= end[i] + W * 60.0)
                r[f'E{W}'] = float((S['h'][hz].max() - S['l'][hz].min()) / ctx['atr']) if (hz.any() and (not full_only or end[comp].max() >= end[i] + W * 60.0 - 60.0)) else np.nan
                r[f'full{W}'] = bool(end[comp].max() >= end[i] + W * 60.0 - 60.0)
            rows.append(r)
    df = pd.DataFrame(rows).dropna(subset=(['E30'] if 30 in horizons else [f'E{h}' for h in horizons]) + ['rr15', 'rr30', 'rr60']).reset_index(drop=True)
    for c in FLAGS: df[c] = df[c].astype(float)
    return df

def design(df, cols_cont, onehots):
    parts = [df[cols_cont].values.astype(float)] if cols_cont else []
    for c in onehots: parts.append(pd.get_dummies(df[c]).reindex(columns=sorted(df[c].unique()), fill_value=0).values.astype(float)[:, 1:])
    return np.hstack(parts)

def standardize(Xtr, Xte):
    mu, sd = Xtr.mean(0), Xtr.std(0); sd[sd == 0] = 1.0
    return (Xtr - mu) / sd, (Xte - mu) / sd

def ridge_solve(ZtZ, Zty, a): return np.linalg.solve(ZtZ + a * np.eye(ZtZ.shape[0]), Zty)

def choose_alpha(Z, y, dates_tr):
    """time-ordered CV inside the training block: 4 consecutive date chunks, validate chunk k on chunks < k (k = 1..3)."""
    ud = np.unique(dates_tr); chunks = np.array_split(ud, 4); best = None
    for a in ALPHAS:
        err = []
        for k in (1, 2, 3):
            tr = np.isin(dates_tr, np.concatenate(chunks[:k])); va = np.isin(dates_tr, chunks[k])
            ym = y[tr].mean(); w = ridge_solve(Z[tr].T @ Z[tr], Z[tr].T @ (y[tr] - ym), a); err.append(np.mean((Z[va] @ w + ym - y[va]) ** 2))
        m = float(np.mean(err))
        if best is None or m < best[0]: best = (m, a)
    return best[1]

def main():
    df = build_points(); print(f'decision points {len(df)} on {df.date.nunique()} dates')
    dates = np.array(sorted(df.date.unique())); blocks = [dates[k:k + STEP] for k in range(FIRST_TRAIN, len(dates), STEP)]
    models = {'full2': design(df, FLAGS + TELL_OTHER + ACT + RR, ['bucket', 'dow']), 'notell2': design(df, ACT + RR, ['bucket', 'dow'])}
    base_bucket = df.bucket.values; rng = np.random.default_rng(SEED)
    res = {}
    for W in (30,):
        sub = df[df[f'E{W}'].notna()].index.values; E = df.loc[sub, f'E{W}'].values; y = np.log(np.maximum(E, 1e-4)); D = df.loc[sub, 'date'].values; B = base_bucket[sub]
        oos = np.zeros(len(sub), bool); pred = {m: np.full(len(sub), np.nan) for m in ['base'] + list(models)}; cache = {m: [] for m in models}; alphas = {m: [] for m in models}; bl_idx = []
        for blk in blocks:
            te = np.isin(D, blk); tr = D < blk[0]
            if te.sum() == 0: continue
            oos |= te; bl_idx.append((tr, te))
            for m, X in models.items():
                Z, Zte = standardize(X[sub][tr], X[sub][te]); a = choose_alpha(Z, y[tr], D[tr]); ym = y[tr].mean(); w = ridge_solve(Z.T @ Z, Z.T @ (y[tr] - ym), a)
                pred[m][te] = Zte @ w + ym; cache[m].append((Z, Zte, Z.T @ Z, a)); alphas[m].append(a)
            gm = E[tr].mean(); bm = {b: (E[tr][B[tr] == b].mean() if (B[tr] == b).sum() >= 50 else gm) for b in np.unique(B)}; pred['base'][te] = [bm.get(b, gm) for b in B[te]]
        oos_idx = np.where(oos)[0]; Eo = E[oos_idx]; Do = D[oos_idx]; P = {m: pred[m][oos_idx] for m in pred}
        rho = lambda p, e: float(np.corrcoef(rankdata(p), rankdata(e))[0, 1])
        r0 = {m: rho(P[m], Eo) for m in P}; comps = {'H3b2 full2-notell2': ('full2', 'notell2')}
        med = np.sort(np.unique(Do))[len(np.unique(Do)) // 2]; h1 = Do <= med
        print(f'\n=== E_{W}{" [PRIMARY, counted]" if W == 30 else " [secondary, uncounted]"}: {len(oos_idx)} out-of-sample rows on {len(np.unique(Do))} dates; chosen alphas (full model per block): {alphas["full2"]}')
        print('  out-of-sample Spearman: ' + ', '.join(f'{m} {r0[m]:+.4f}' for m in r0))
        byd = {d: np.where(Do == d)[0] for d in np.unique(Do)}; ks = list(byd); boots = {c: [] for c in comps}
        for _ in range(BOOT):
            ix = np.concatenate([byd[ks[j]] for j in rng.integers(0, len(ks), len(ks))]); rr = {m: rho(P[m][ix], Eo[ix]) for m in P}
            for c, (a, b) in comps.items(): boots[c].append(rr[a] - rr[b])
        pnull = {}
        if W == 30:
            nulls = {c: [] for c in comps}; by_date = {d: np.where(D == d)[0] for d in np.unique(D)}; ud = list(by_date)
            for _ in range(DRAWS):
                perm = rng.permutation(len(ud)); src = np.zeros(len(sub), int)
                for k, d in enumerate(ud): ia, ib = by_date[d], by_date[ud[perm[k]]]; src[ia] = ib[np.arange(len(ia)) % len(ib)]
                yp, Ep = y[src], E[src]; Pp = {m: np.full(len(sub), np.nan) for m in P}
                for bi, (tr, te) in enumerate(bl_idx):
                    for m in models:
                        Z, Zte, ZtZ, a = cache[m][bi]; ym = yp[tr].mean(); w = ridge_solve(ZtZ, Z.T @ (yp[tr] - ym), a); Pp[m][te] = Zte @ w + ym
                    gm = Ep[tr].mean(); bm = {b: (Ep[tr][B[tr] == b].mean() if (B[tr] == b).sum() >= 50 else gm) for b in np.unique(B)}; Pp['base'][te] = [bm.get(b, gm) for b in B[te]]
                rp = {m: rho(Pp[m][oos_idx], Ep[oos_idx]) for m in P}
                for c, (a, b) in comps.items(): nulls[c].append(rp[a] - rp[b])
            pnull = {c: float((np.sum(np.array(nulls[c]) >= r0[comps[c][0]] - r0[comps[c][1]]) + 1) / (DRAWS + 1)) for c in comps}
        for c, (a, b) in comps.items():
            d0 = r0[a] - r0[b]; lo, hi = np.percentile(boots[c], [2.5, 97.5]); ha = rho(P[a][h1], Eo[h1]) - rho(P[b][h1], Eo[h1]); hb = rho(P[a][~h1], Eo[~h1]) - rho(P[b][~h1], Eo[~h1])
            ptxt = f' permutation p {pnull[c]:.4f}' if pnull else ''
            ok = (lo > 0) and (not pnull or pnull[c] < 0.05) and ha > 0 and hb > 0
            print(f'  {c:18s} diff {d0:+.4f} CI [{lo:+.4f}, {hi:+.4f}]{ptxt} halves {ha:+.4f} / {hb:+.4f}' + (f'  -> {"PASS" if ok else "not passed"}' if W == 30 else ''))
            if W == 30: res[c] = (d0, pnull[c], ok)

if __name__ == '__main__': main()
