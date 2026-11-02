"""docs/RANGE_BUDGET_PREREG_20261102.md: the range-budget (exhaustion) screen on EXPLORE days only. Market behaviour, no fills/costs. The hold-out is NOT extracted or read. READS OUTCOMES -> look logged first (log_look_range_budget.mjs).
Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/range_budget/run_range_budget.py"""
import sys, json
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_context'); sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
from scipy.stats import spearmanr
import run_p2b as P
import checkpoints as CP
SEED, BOOT, DRAWS, FIRST_TRAIN, STEP, CUT_SEED = 20261102, 3000, 1000, 60, 10, 40
ROOT = '/home/mmoniz/trading-journal/scratch'; NCP = len(CP.KS)

def load():
    ds = json.load(open(f'{ROOT}/overnight_rth_dataset_20261026.json'))['rows']; nexp = int(len(ds) * 0.6); bars = json.load(open(f'{ROOT}/range_budget_bars_20261102.json'))
    D = pd.DataFrame(ds); D['onr'] = (D.onH - D.onL) / D.atr; D['onv'] = np.nan
    for i in range(20, len(D)): D.loc[i, 'onv'] = np.log(D.onVol[i] / D.onVol[i - 20:i].mean())
    D = D.iloc[:nexp].copy(); D = D[D.onv.notna()].reset_index(drop=True); assert all(d in bars['bars'] for d in D.date), 'missing explore bars'
    assert D.date.max() <= '2025-04-02', 'hold-out date in the frame'
    return D, bars['bars']

def day_forecast(D):
    """walk-forward ridge on log(rthRangeAtr): features log(pdRangeAtr), onr, onv, |gapAtr|, dow 2..5. Returns log-forecast for days from FIRST_TRAIN on (NaN before)."""
    X = np.column_stack([np.log(D.pdRangeAtr), D.onr, D.onv, D.gapAtr.abs()] + [(D.dow == w).astype(float) for w in (2, 3, 4, 5)]); y = np.log(D.rthRangeAtr.values); lf = np.full(len(D), np.nan); dts = D.date.values
    for i in range(FIRST_TRAIN, len(D)):
        blk = FIRST_TRAIN + ((i - FIRST_TRAIN) // STEP) * STEP; Z, Zte = P.standardize(X[:blk], X[i:i + 1]); a = P.choose_alpha(Z, y[:blk], dts[:blk]); ym = y[:blk].mean(); lf[i] = (Zte @ P.ridge_solve(Z.T @ Z, Z.T @ (y[:blk] - ym), a) + ym)[0]
    return lf

def expanding_q(M, q, seed):
    """M: (days, checkpoints). cutoff for day j at checkpoint c = quantile q of M[:j, c] (strictly earlier days); NaN for j < seed."""
    out = np.full(M.shape, np.nan)
    for j in range(seed, M.shape[0]):
        out[j] = np.quantile(M[:j], q, axis=0)
    return out

def build(D, bars, lf):
    n = len(D); cp = [CP.checkpoints(bars[d]['h'], bars[d]['l'], bars[d]['c'], D.atr[i]) for i, d in enumerate(D.date)]; F = {k: np.array([c[k] for c in cp]) for k in cp[0]}
    rhat = np.exp(lf)[:, None]; F['U_hat'] = F['rng_atr'] / rhat; F['U_atr'] = F['rng_atr']
    # evaluation days: after the training days AND the cutoff seed days (cutoffs come from earlier evaluated days)
    ev = np.arange(FIRST_TRAIN + CUT_SEED, n); sub = {k: v[FIRST_TRAIN:] for k, v in F.items()}; off = CUT_SEED
    S = {}; S['hi'] = (sub['loc'] >= expanding_q(sub['loc'], 0.8, off)); S['lo'] = (sub['loc'] <= expanding_q(sub['loc'], 0.2, off))
    for u in ('U_hat', 'U_atr'): S['top_' + u] = sub[u] >= expanding_q(sub[u], 2 / 3, off); S['bot_' + u] = sub[u] <= expanding_q(sub[u], 1 / 3, off)
    keep = np.arange(off, len(sub['loc'])); return {k: v[keep] for k, v in sub.items()}, {k: v[keep] for k, v in S.items()}, D.iloc[ev].reset_index(drop=True)

def arm_stats(V, state, top, bot, w=None):
    """D = mean(V | state & top) - mean(V | state & bot) with optional day weights w (days,)."""
    w = np.ones(V.shape[0]) if w is None else w; a, b = state & top, state & bot
    with np.errstate(divide='ignore', invalid='ignore'):
        return (w @ np.where(a, V, 0).sum(1)) / (w @ a.sum(1)) - (w @ np.where(b, V, 0).sum(1)) / (w @ b.sum(1))

def test_one(V, state, top, bot, rng):
    n = V.shape[0]; obs = arm_stats(V, state, top, bot); draws = np.array([arm_stats(V, state, top, bot, np.bincount(rng.integers(0, n, n), minlength=n).astype(float)) for _ in range(BOOT)]); lo, hi = np.nanpercentile(draws, [2.5, 97.5])
    plc = np.array([arm_stats(V, state, np.roll(top, o, axis=0), np.roll(bot, o, axis=0)) for o in rng.integers(1, n, DRAWS)]); p = float((np.sum(np.abs(plc) >= abs(obs)) + 1) / (DRAWS + 1))
    h = n // 2; wa = np.r_[np.ones(h), np.zeros(n - h)]; wb = 1 - wa; halves = (arm_stats(V, state, top, bot, wa), arm_stats(V, state, top, bot, wb))
    a, b = state & top, state & bot; Na, Nb = max(1, a.sum()), max(1, b.sum()); ma, mb = np.where(a, V, 0).sum() / Na, np.where(b, V, 0).sum() / Nb
    contrib = (np.where(a, V, 0).sum(1) - a.sum(1) * ma) / Na - (np.where(b, V, 0).sum(1) - b.sum(1) * mb) / Nb; worst = np.argsort(-np.abs(contrib))[:5]; wd = np.ones(n); wd[worst] = 0; drop = arm_stats(V, state, top, bot, wd)
    na, nb = int(a.sum()), int(b.sum()); da, db = int((a.sum(1) > 0).sum()), int((b.sum(1) > 0).sum())
    return dict(D=obs, lo=lo, hi=hi, p=p, halves=halves, drop=drop, na=na, nb=nb, da=da, db=db, under=min(na, nb) < 30 or min(da, db) < 20)

def main():
    rng = np.random.default_rng(SEED + 31); D, bars = load(); lf = day_forecast(D); n0 = len(D)
    print(f'explore days with a 20-day volume baseline {n0} ({D.date.iloc[0]}..{D.date.iloc[-1]}); hold-out NOT extracted; training days {FIRST_TRAIN}, cutoff-seed days {CUT_SEED}')
    F, S, Dev = build(D, bars, lf); nd = len(Dev); print(f'evaluated days {nd} ({Dev.date.iloc[0]}..{Dev.date.iloc[-1]}), checkpoints {nd * NCP}; AT_HIGH points {int(S["hi"].sum())}, AT_LOW {int(S["lo"].sum())}; U_hat TOP/BOT points {int(S["top_U_hat"].sum())}/{int(S["bot_U_hat"].sum())}')
    ev = np.arange(FIRST_TRAIN + CUT_SEED, n0); r = spearmanr(np.exp(lf[ev]), D.rthRangeAtr.values[ev])[0]; r_pd = spearmanr(D.pdRangeAtr.values[ev], D.rthRangeAtr.values[ev])[0]; r_on = spearmanr(D.onr.values[ev], D.rthRangeAtr.values[ev])[0]
    print(f'C7 day-range forecast on evaluated days: Spearman(R-hat, realized RTH range/ATR) {r:+.3f}; naive: prior-day range {r_pd:+.3f}, overnight range {r_on:+.3f}')
    yh, yl = F['y60'], -F['y60']; E_ = np.where(S['hi'], F['extH'], F['extL']); st_any = S['hi'] | S['lo']
    tests = {'T1_HIGH': (yh, S['hi']), 'T1_LOW': (yl, S['lo']), 'T2': (E_, st_any)}
    res = {k: test_one(V, st, S['top_U_hat'], S['bot_U_hat'], rng) for k, (V, st) in tests.items()}
    print('\nRESOLUTION (printed before any verdict): half-width of the day-blocked 95% CI on D: ' + ', '.join(f'{k} {(v["hi"] - v["lo"]) / 2:.4f}' for k, v in res.items()) + ' (ATR units; 1 ATR is about 250-300 NQ points)')
    for k, v in res.items(): print(f'  {k}: arms top N {v["na"]} ({v["da"]} days) / bottom N {v["nb"]} ({v["db"]} days){"  UNDERPOWERED" if v["under"] else ""}')
    ps = [res[k]['p'] for k in res]; order = sorted(range(3), key=lambda i: ps[i]); keep = -1
    for rk, ix in enumerate(order): keep = rk if ps[ix] <= (rk + 1) / 3 * 0.10 else keep
    surv = {list(res)[ix]: rk <= keep for rk, ix in enumerate(order)}
    print('\nCOUNTED TESTS (exhaustion predicts D < 0):')
    for k, v in res.items():
        ok = surv[k] and (v['lo'] > 0 or v['hi'] < 0) and v['p'] < 0.05 and np.sign(v['halves'][0]) == np.sign(v['halves'][1]) == np.sign(v['D']) and np.sign(v['drop']) == np.sign(v['D']) and abs(v['drop']) >= 0.5 * abs(v['D']) and v['D'] < 0 and not v['under']
        print(f'  {k}: D {v["D"]:+.4f} CI [{v["lo"]:+.4f}, {v["hi"]:+.4f}] placebo p {v["p"]:.4f} BH q=0.10 {"survives" if surv[k] else "does not survive"}; halves {v["halves"][0]:+.4f} / {v["halves"][1]:+.4f}; leave-5-out {v["drop"]:+.4f} -> {"EXPLORE-CANDIDATE" if ok else "NOT SHOWN"}')
    c2 = {k: test_one(V, st, S['top_U_atr'], S['bot_U_atr'], rng) for k, (V, st) in tests.items()}
    print('\nC2 control, the SAME contrasts with U_atr (no forecast): ' + '; '.join(f'{k} D {v["D"]:+.4f} CI [{v["lo"]:+.4f}, {v["hi"]:+.4f}] p {v["p"]:.3f}' for k, v in c2.items()))
    print('\nC3 drift: mean y60 over all checkpoints %+.4f; at AT_HIGH %+.4f; at AT_LOW %+.4f (signed continuation s x y60: %+.4f / %+.4f)' % (F['y60'].mean(), F['y60'][S['hi']].mean(), F['y60'][S['lo']].mean(), yh[S['hi']].mean(), yl[S['lo']].mean()))
    print('C4 other horizons (uncounted), D with U_hat: ' + '; '.join(f'{nm} {side}: {arm_stats(Fk if sg > 0 else -Fk, S[side], S["top_U_hat"], S["bot_U_hat"]):+.4f}' for nm, Fk in (('y30', F['y30']), ('yclose', F['yclose'])) for side, sg in (('hi', 1), ('lo', -1))))
    print('C5/C8 tercile tables (U_hat): state, bucket, N points, N days, mean continuation s x y60, P(extension next 60 min)')
    for nm, st, V, ext in (('AT_HIGH', S['hi'], yh, F['extH']), ('AT_LOW', S['lo'], yl, F['extL'])):
        mid = ~S['top_U_hat'] & ~S['bot_U_hat']
        for bn, bm in (('BOT', S['bot_U_hat']), ('MID', mid), ('TOP', S['top_U_hat'])):
            m = st & bm; print(f'  {nm} {bn}: N {int(m.sum())}, days {int((m.sum(1) > 0).sum())}, mean {V[m].mean():+.4f}, P(ext) {ext[m].mean():.3f}')
    full = st_any & (F['U_hat'] >= 1); print(f'  budget fully used (U_hat >= 1) at an extreme: N {int(full.sum())}, mean continuation {np.nanmean(np.where(S["hi"], yh, yl)[full]):+.4f} vs below 1: {np.nanmean(np.where(S["hi"], yh, yl)[st_any & (F["U_hat"] < 1)]):+.4f}')
    print('C6 eras: T1 D by calendar year (U_hat): ' + '; '.join(f'{yr} ' + ' '.join(f'{k} {arm_stats(V[m], st[m], S["top_U_hat"][m], S["bot_U_hat"][m]):+.3f}' for k, (V, st) in (('HIGH', tests['T1_HIGH']), ('LOW', tests['T1_LOW']))) for yr in sorted(set(Dev.date.str[:4])) for m in [(Dev.date.str[:4] == yr).values]))

if __name__ == '__main__': main()
