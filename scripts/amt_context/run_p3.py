"""P3 = H4 of PREREG_ROSTER_CONTEXT.md (+Amendments 1-3): on the BACKFILL level-fade rows (RTH, fired 10:00-14:30 ET, through 2025-05-16) skip the rows whose no-tell forecast E_30 is in the top third (expanding cutoff) and ask
whether the skipped rows lost money and whether that beats a matched random skip. SIMULATED P&L (hr-006): a pass is a hypothesis for forward tags, never a dollar claim.  EXPLORE only.
READS OUTCOMES (actual_pnl) -> the look is logged first by log_look_p3.mjs.  Usage: ../../venv/bin/python run_p3.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/ml_meta_labeling')
import tell_state as TS, vbars as V
from db import get_connection
import run_p2b as P
SEED, BOOT, DRAWS, FIRST_TRAIN, STEP, THIN_START = 20261102, 3000, 1000, 120, 20, 100
CONT = P.ACT + P.RR

def dm(df):
    """fixed-level design: continuous + bucket one-hot (levels 1..9 vs 0) + day of week one-hot (1..4 vs 0), so train and row designs always have the same columns."""
    X = [df[CONT].values.astype(float)] + [(df['bucket'].values == b).astype(float)[:, None] for b in range(1, 10)] + [(df['dow'].values == w).astype(float)[:, None] for w in range(1, 5)]
    return np.hstack(X)

def row_features(ctx, fl, ts, dow):
    S = ctx['S']; end, comp = S['end'], S['comp']; st = TS.state_at(ctx, ts, flags=fl)
    if st is None or st['rth_range_so_far_atr'] is None or not np.isfinite(st['A_now']): return None
    r = dict(A_now=st['A_now'], rth_range_so_far_atr=st['rth_range_so_far_atr'], overnight_range_atr=st['overnight_range_atr'], minutes_since_rth_open=st['minutes_since_rth_open'], dow=dow, bucket=int((ts - V.DEC_FIRST) // 1800))
    for M in (15, 30, 60):
        w = comp & (end <= ts) & (end > ts - M * 60.0)
        if not w.any(): return None
        r[f'rr{M}'] = float((S['h'][w].max() - S['l'][w].min()) / ctx['atr'])
    return r

def day_mean_ci(pnl, dates, rng):
    ud = np.unique(dates); sums = np.array([pnl[dates == d].sum() for d in ud]); ns = np.array([(dates == d).sum() for d in ud]); v = []
    for _ in range(BOOT):
        ix = rng.integers(0, len(ud), len(ud)); v.append(sums[ix].sum() / max(1, ns[ix].sum()))
    return float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))

def main():
    rng = np.random.default_rng(SEED); _, ctxs, _ = TS.sessions_and_contexts(); df = P.build_points(ctxs); dates = np.array(sorted(df.date.unique())); date_pos = {d: k for k, d in enumerate(dates)}
    conn = get_connection(); cur = conn.cursor()
    cur.execute("""SELECT id, setup_type, trade_date::text, fired_at::text, actual_pnl::float FROM active_setups WHERE origin_status = 'BACKFILL' AND is_rth AND trade_date <= '2025-05-16'
                   AND (EXTRACT(hour FROM fired_at) * 60 + EXTRACT(minute FROM fired_at)) BETWEEN 600 AND 870 ORDER BY trade_date, fired_at, id""")
    rows = cur.fetchall(); conn.close(); funnel = dict(rows=len(rows), null_pnl=0, no_ctx=0, in_first_train=0, no_state=0); recs = []; flags = {}
    for (i, st, d, fa, pnl) in rows:
        if pnl is None: funnel['null_pnl'] += 1; continue
        if d not in ctxs or d not in date_pos: funnel['no_ctx'] += 1; continue
        pos = date_pos[d]
        if pos < FIRST_TRAIN: funnel['in_first_train'] += 1; continue
        if d not in flags: flags[d] = TS.bar_flags(ctxs[d])
        ts = TS.et_to_session_sec(fa.split(' ')[1]); f = row_features(ctxs[d], flags[d], ts, pd.Timestamp(d).dayofweek)
        if f is None: funnel['no_state'] += 1; continue
        f.update(id=i, setup_type=st, date=d, pnl=float(pnl), blk=FIRST_TRAIN + ((pos - FIRST_TRAIN) // STEP) * STEP); recs.append(f)
    R = pd.DataFrame(recs); print('funnel (row counts):', funnel, '-> usable', len(R), 'rows on', R.date.nunique(), 'dates,', R.setup_type.nunique(), 'setup types')
    fc = np.full(len(R), np.nan)
    for blk in sorted(R.blk.unique()):
        tr = df[df.date.isin(dates[:blk])]; Xtr = dm(tr); ytr = np.log(np.maximum(tr['E30'].values, 1e-4)); sel = (R.blk == blk).values
        Z, Zte = P.standardize(Xtr, dm(R[sel])); a = P.choose_alpha(Z, ytr, tr['date'].values); ym = ytr.mean(); w = P.ridge_solve(Z.T @ Z, Z.T @ (ytr - ym), a); fc[sel] = Zte @ w + ym
    R['fc'] = fc; R = R.sort_values(['date', 'id']).reset_index(drop=True); f = R.fc.values
    cut = np.array([np.quantile(f[:k], 2 / 3) if k >= THIN_START else np.nan for k in range(len(R))]); lo3 = np.array([np.quantile(f[:k], 1 / 3) if k >= THIN_START else np.nan for k in range(len(R))])
    E = R[R.index >= THIN_START].copy(); E['skip'] = f[THIN_START:] > cut[THIN_START:]; E['third'] = np.where(f[THIN_START:] > cut[THIN_START:], 'high', np.where(f[THIN_START:] <= lo3[THIN_START:], 'low', 'mid'))
    print(f'first {THIN_START} rows only seed the cutoff and are not evaluated; evaluated {len(E)} rows on {E.date.nunique()} dates; overall mean simulated P&L per row ${E.pnl.mean():+.2f}')
    S, K = E[E.skip], E[~E.skip]; lo, hi = day_mean_ci(S.pnl.values, S.date.values, rng)
    print(f'\nSKIPPED (forecast top third): N={len(S)} on {S.date.nunique()} dates, mean ${S.pnl.mean():+.2f}/row, day-blocked 95% CI [{lo:+.2f}, {hi:+.2f}]; KEPT: N={len(K)}, mean ${K.pnl.mean():+.2f}')
    print(f'  effect of skipping them: total ${-S.pnl.sum():+.0f} over {E.date.nunique()} days = ${-S.pnl.sum() / E.date.nunique():+.2f}/day; half-size (reported, uncounted) ${-0.5 * S.pnl.sum():+.0f}')
    med = np.sort(E.date.unique())[E.date.nunique() // 2]; halves = []
    for nm, g in (('first half', E[E.date <= med]), ('second half', E[E.date > med])):
        s, k = g[g.skip], g[~g.skip]; halves.append(s.pnl.mean() < k.pnl.mean()); print(f'  {nm}: skipped N={len(s)} mean ${s.pnl.mean():+.2f}, kept N={len(k)} mean ${k.pnl.mean():+.2f}')
    obs = S.pnl.mean(); plc = []
    for _ in range(DRAWS):
        pick = np.concatenate([rng.choice(g.index.values, size=int(g.skip.sum()), replace=False) for g in (E[E.date <= med], E[E.date > med])]); plc.append(E.loc[pick, 'pnl'].mean())
    p = float((np.sum(np.array(plc) <= obs) + 1) / (DRAWS + 1)); print(f'  matched random-skip placebo (same count per half, {DRAWS} draws): mean ${np.mean(plc):+.2f}, p(placebo <= observed) = {p:.4f}')
    ok = (hi < 0) and (p < 0.05) and all(halves); print(f'\nH4 pass rule (skipped CI upper bound < 0, placebo p < 0.05, skipped mean below kept mean in BOTH halves): {"PASS" if ok else "NOT PASSED"}')
    print('\ndescriptive (uncounted): simulated P&L by forecast third at the row, expanding cutoffs')
    for t in ('low', 'mid', 'high'):
        g = E[E.third == t]; a, b = day_mean_ci(g.pnl.values, g.date.values, rng); print(f'  {t:4s} N={len(g):4d} mean ${g.pnl.mean():+.2f} CI [{a:+.2f}, {b:+.2f}]')
    E.to_csv('p3_rows.csv', index=False)

if __name__ == '__main__': main()
