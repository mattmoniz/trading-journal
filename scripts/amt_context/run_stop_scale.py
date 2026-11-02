"""PREREG_STOP_SCALE.md: paired simulation on the V1 tell trades, stop widened by the forecast (arm W) vs the structural stop. EXPLORE only, SIMULATED dollars. READS OUTCOMES -> look logged first by log_look_stop_scale.mjs.
Usage: ../../venv/bin/python run_stop_scale.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import tell_state as TS, vbars as V, trade as T, forecast_features as FF
import run_p2b as P
from run_p3 import dm, day_mean_ci, FIRST_TRAIN, STEP
SEED, BOOT, DRAWS = 20261102, 3000, 1000

def main():
    rng = np.random.default_rng(SEED + 11); _, ctxs, _ = TS.sessions_and_contexts(); dates = [str(x) for x in sorted(ctxs)]; pos = {d: k for k, d in enumerate(dates)}
    df = P.build_points(ctxs, horizons=(30,)); df = df[df['full30']].reset_index(drop=True); recs = []; n_all = 0
    for d in dates:
        ctx = ctxs[d]; S = ctx['S']; end, comp = S['end'], S['comp']; dow = pd.Timestamp(d).dayofweek
        for t in T.simulate(ctx, 'V1', dict(fires=0, skip=0, trades=0, fallback=0)):
            n_all += 1
            if pos[d] < FIRST_TRAIN: continue
            ei, dr = int(t['ei']), int(t['dir']); row = FF.activity_row(ctx, float(end[ei - 1]), dow)
            if row is None or end[comp].max() < float(end[ei - 1]) + 1740.0: continue
            r = {k: row[k] for k in FF.CONT + ['bucket', 'dow']}; r.update(date=d, ei=ei, dir=dr, stop=float(t['stop']), entry=float(t['entry']), risk=float(t['risk']), net0=float(t['net']), reason0=t['reason'], xj0=int(t['xj']), blk=FIRST_TRAIN + ((pos[d] - FIRST_TRAIN) // STEP) * STEP); recs.append(r)
    R = pd.DataFrame(recs); print(f'V1 tell trades {n_all}; evaluated {len(R)} on {R.date.nunique()} dates')
    sc = np.full(len(R), np.nan); fc = np.full(len(R), np.nan)
    for blk in sorted(R.blk.unique()):
        tr = df[df.date.isin(dates[:blk])]; Xtr = dm(tr); ytr = np.log(np.maximum(tr['E30'].values, 1e-4)); sel = (R.blk == blk).values
        Z, Zte = P.standardize(Xtr, dm(R[sel])); a = P.choose_alpha(Z, ytr, tr['date'].values); ym = ytr.mean(); lf = Zte @ P.ridge_solve(Z.T @ Z, Z.T @ (ytr - ym), a) + ym; sc[sel] = np.exp(lf - ym); fc[sel] = lf
    R['s'] = sc; R['fc'] = fc
    # harness check: the real function with the trade's own stop must reproduce the research result exactly
    def run(row, stop_price):
        ctx = ctxs[row.date]; return T.run_position(ctx, T.Prof(ctx), int(row.ei), int(row.dir), stop_price, 'V1', float(ctx['S']['end'][int(row.ei) - 1]))
    bad = 0
    for row in R.itertuples():
        t = run(row, row.stop)
        if abs(t['net'] - row.net0) > 1e-9 or t['xj'] != row.xj0: bad += 1
    print(f'harness check: baseline re-run mismatches {bad} of {len(R)}')
    if bad: print('STOPPED: the paired harness does not reproduce the research simulation'); return
    grid = [round(x, 1) for x in np.arange(0.5, 2.01, 0.1)]; net = {}
    for g in grid:
        net[g] = np.array([run(row, row.entry - row.dir * row.risk * g)['net'] for row in R.itertuples()])
    q = lambda s: np.clip(np.round(s * 10) / 10, 0.5, 2.0); sW = np.clip(np.round(np.clip(R.s.values, 1, 2) * 10) / 10, 1.0, 2.0); sS = q(R.s.values)
    pick = lambda sv: np.array([net[round(float(v), 1)][i] for i, v in enumerate(sv)])
    base = R.net0.values; armW = pick(sW); armS = pick(sS); R['diff'] = armW - base
    lo, hi = day_mean_ci(R['diff'].values, R.date.values, rng); med = np.sort(R.date.unique())[R.date.nunique() // 2]; h1, h2 = (R.date <= med).values, (R.date > med).values
    plc = []
    for _ in range(DRAWS):
        sp = sW.copy()
        for m in (h1, h2): idx = np.where(m)[0]; sp[idx] = sW[rng.permutation(idx)]
        plc.append(pick(sp).mean())
    p = float((np.sum(np.array(plc) >= armW.mean()) + 1) / (DRAWS + 1)); ok = lo > 0 and p < 0.05 and (armW - base)[h1].mean() > 0 and (armW - base)[h2].mean() > 0
    print(f'\nARM W (widen-only): mean net base ${base.mean():+.2f}, arm ${armW.mean():+.2f}; paired difference ${(armW - base).mean():+.2f}/trade, day-blocked CI [{lo:+.2f}, {hi:+.2f}]; halves {(armW - base)[h1].mean():+.2f} / {(armW - base)[h2].mean():+.2f}')
    print(f'  shuffled-scale placebo: mean arm ${np.mean(plc):+.2f}, p(placebo >= observed) = {p:.4f}  ->  H_S {"PASS" if ok else "NOT PASSED"}')
    print(f'\nuncounted: symmetric arm (scale clipped 0.5..2): mean ${armS.mean():+.2f}, paired difference ${(armS - base).mean():+.2f}')
    thirds = np.quantile(R.fc, [1 / 3, 2 / 3]); R['third'] = np.where(R.fc <= thirds[0], 'low', np.where(R.fc <= thirds[1], 'mid', 'high'))
    stopped = lambda reasons: np.mean([x in ('STOP', 'STOP_GAP') for x in reasons])
    print('by forecast third: N, baseline mean $, arm W mean $, mean scale, baseline stop-out share')
    for t in ('low', 'mid', 'high'):
        m = (R.third == t).values; print(f'  {t:4s} N={int(m.sum()):4d} base ${base[m].mean():+.2f} armW ${armW[m].mean():+.2f} scale {sW[m].mean():.2f} stop-outs {100 * stopped(R.reason0[m]):.0f}%')
    print(f'mean stop distance (ATR points): baseline {R.risk.mean():.1f}, arm W {(R.risk * sW).mean():.1f}')

if __name__ == '__main__': main()
