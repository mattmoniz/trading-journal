"""Amendment 5 of PREREG_ROSTER_CONTEXT.md: the H4 test with the forecast horizon MATCHED to the trades' median hold (H*, fixed rule), no-tell model, same pass rule. SIMULATED P&L, EXPLORE only.
READS OUTCOMES (actual_pnl, resolved_at, mfe/mae) -> look logged first by log_look_p3c.mjs.  Usage: ../../venv/bin/python run_p3c.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
from scipy.stats import rankdata
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import tell_state as TS
from db import get_connection
import run_p2b as P
from run_p3 import dm, row_features, day_mean_ci, SEED, BOOT, DRAWS, FIRST_TRAIN, STEP, THIN_START

def main():
    rng = np.random.default_rng(SEED + 5); _, ctxs, _ = TS.sessions_and_contexts(); dates = np.array(sorted(ctxs)); date_pos = {d: k for k, d in enumerate(dates)}
    conn = get_connection(); cur = conn.cursor()
    cur.execute("""SELECT id, setup_type, trade_date::text, fired_at::text, actual_pnl::float, resolved_at::text, mfe_points::float, mae_points::float FROM active_setups WHERE origin_status = 'BACKFILL' AND is_rth
                   AND trade_date <= '2025-05-16' AND (EXTRACT(hour FROM fired_at) * 60 + EXTRACT(minute FROM fired_at)) BETWEEN 600 AND 870 ORDER BY trade_date, fired_at, id""")
    rows = cur.fetchall(); conn.close(); recs = []; flags = {}; drop = dict(null_pnl=0, no_ctx=0, in_first_train=0, no_state=0)
    for (i, st, d, fa, pnl, ra, mfe, mae) in rows:
        if pnl is None: drop['null_pnl'] += 1; continue
        if d not in date_pos: drop['no_ctx'] += 1; continue
        pos = date_pos[d]
        if pos < FIRST_TRAIN: drop['in_first_train'] += 1; continue
        if d not in flags: flags[d] = TS.bar_flags(ctxs[d])
        f = row_features(ctxs[d], flags[d], TS.et_to_session_sec(fa.split(' ')[1]), pd.Timestamp(d).dayofweek)
        if f is None: drop['no_state'] += 1; continue
        hold = (pd.Timestamp(ra) - pd.Timestamp(fa)).total_seconds() / 60.0 if ra else np.nan
        f.update(id=i, setup_type=st, date=d, pnl=float(pnl), hold=hold, exc=(mfe + mae) if mfe is not None and mae is not None else np.nan, blk=FIRST_TRAIN + ((pos - FIRST_TRAIN) // STEP) * STEP); recs.append(f)
    R = pd.DataFrame(recs); h = R.hold.dropna()
    H = int(min(240, max(30, round(h.median() / 15.0) * 15)))
    print(f'usable rows {len(R)} (dropped {drop}); hold minutes: n {len(h)}, p25 {h.quantile(.25):.0f}, median {h.median():.0f}, p75 {h.quantile(.75):.0f}, p90 {h.quantile(.9):.0f}  ->  H* = {H} minutes (rule: median rounded to 15, floor 30, cap 240)')
    df = P.build_points(ctxs, horizons=(H,)); n_all = len(df); df = df[df[f'full{H}']]
    print(f'training decision points with a complete {H}-minute window: {len(df)} of {n_all} ({100 * len(df) / n_all:.0f}%)')
    if len(df) < 0.7 * n_all: print('UNDERPOWERED (more than 30% of training points lack a complete window): reported, not altered.'); return
    fc = np.full(len(R), np.nan)
    for blk in sorted(R.blk.unique()):
        tr = df[df.date.isin(dates[:blk])]; Xtr = dm(tr); ytr = np.log(np.maximum(tr[f'E{H}'].values, 1e-4)); sel = (R.blk == blk).values
        Z, Zte = P.standardize(Xtr, dm(R[sel])); a = P.choose_alpha(Z, ytr, tr['date'].values); ym = ytr.mean(); w = P.ridge_solve(Z.T @ Z, Z.T @ (ytr - ym), a); fc[sel] = Zte @ w + ym
    R['fc'] = fc; R = R.sort_values(['date', 'id']).reset_index(drop=True); f = R.fc.values
    cut = np.array([np.quantile(f[:k], 2 / 3) if k >= THIN_START else np.nan for k in range(len(R))]); lo3 = np.array([np.quantile(f[:k], 1 / 3) if k >= THIN_START else np.nan for k in range(len(R))])
    E = R[R.index >= THIN_START].copy(); E['skip'] = f[THIN_START:] > cut[THIN_START:]; E['third'] = np.where(E.skip, 'high', np.where(f[THIN_START:] <= lo3[THIN_START:], 'low', 'mid'))
    print(f'evaluated {len(E)} rows on {E.date.nunique()} dates; overall mean simulated P&L per row ${E.pnl.mean():+.2f}')
    S, K = E[E.skip], E[~E.skip]; lo, hi = day_mean_ci(S.pnl.values, S.date.values, rng)
    print(f'\nSKIPPED (horizon-matched forecast top third): N={len(S)} on {S.date.nunique()} dates, mean ${S.pnl.mean():+.2f}/row, day-blocked 95% CI [{lo:+.2f}, {hi:+.2f}]; KEPT N={len(K)} mean ${K.pnl.mean():+.2f}')
    print(f'  effect of skipping them: total ${-S.pnl.sum():+.0f} over {E.date.nunique()} days = ${-S.pnl.sum() / E.date.nunique():+.2f}/day (mirror of a non-significant mean unless the pass rule below says otherwise)')
    med = np.sort(E.date.unique())[E.date.nunique() // 2]; halves = []
    for nm, g in (('first half', E[E.date <= med]), ('second half', E[E.date > med])):
        s, k = g[g.skip], g[~g.skip]; halves.append(s.pnl.mean() < k.pnl.mean()); print(f'  {nm}: skipped N={len(s)} mean ${s.pnl.mean():+.2f}, kept N={len(k)} mean ${k.pnl.mean():+.2f}')
    obs = S.pnl.mean(); plc = []
    for _ in range(DRAWS):
        pick = np.concatenate([rng.choice(g.index.values, size=int(g.skip.sum()), replace=False) for g in (E[E.date <= med], E[E.date > med])]); plc.append(E.loc[pick, 'pnl'].mean())
    p = float((np.sum(np.array(plc) <= obs) + 1) / (DRAWS + 1)); print(f'  matched random-skip placebo: mean ${np.mean(plc):+.2f}, p(placebo <= observed) = {p:.4f}')
    print(f'\nH4c pass rule (skipped CI upper < 0, placebo p < 0.05, skipped mean below kept mean in BOTH halves): {"PASS" if (hi < 0 and p < 0.05 and all(halves)) else "NOT PASSED"}')
    X = E.dropna(subset=['exc']); sp = lambda a, b: float(np.corrcoef(rankdata(a), rankdata(b))[0, 1]); by = {d: np.where(X.date.values == d)[0] for d in X.date.unique()}; ks = list(by); v = []
    for _ in range(BOOT): ix = np.concatenate([by[ks[j]] for j in rng.integers(0, len(ks), len(ks))]); v.append(sp(X.fc.values[ix], X.exc.values[ix]))
    print(f'\nuncounted: Spearman(forecast, trade mfe+mae) = {sp(X.fc.values, X.exc.values):+.4f}, day-blocked CI [{np.percentile(v, 2.5):+.4f}, {np.percentile(v, 97.5):+.4f}]; by forecast third (N, mean excursion points, mean $ pnl):')
    for t in ('low', 'mid', 'high'): g = X[X.third == t]; print(f'  {t:4s} N={len(g):4d} exc {g.exc.mean():7.2f}  pnl {g.pnl.mean():+7.2f}')

if __name__ == '__main__': main()
