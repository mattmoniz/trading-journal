"""How far back is normal, and volatility-scaled trailing stop arms (docs/TELL_HOLD_VALUE_TRAIL_PREREG_20261104.md incl. amendment A1). Same 1,760 explore entries, V1 management, only the stop trails.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_hold_value_trail.py   (look 157 is logged first, hr-023)"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F, REPO, SH, T, V
from watcher_stop_lib import run_dyn

KS = (3, 6, 12); H10, H11 = 57600.0, 61200.0
rng = np.random.default_rng(20261104)


def extra(S, allb, sig, t, ctxf):
    ctx = S['_ctx']; d = int(t['dir']); ei = int(t['ei']); risk = float(t['risk']); end_i = S['end'][sig]; h, l = S['h'], S['l']
    a = max(0, sig - 19); scale = float(np.median(h[a:sig + 1] - l[a:sig + 1])); scale = max(scale, T.TICK)
    out = dict(scale=scale, ehr=float(S['start'][ei]))
    v1 = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i)[0]; out.update(v1_net=v1['net'], v1_pts=v1['pts'], v1_mfe=v1['mfe'], v1_why=v1['reason'], v1_xj=int(v1['xj']))
    entry = float(S['o'][ei]) + d * T.SLIP; best = None; peak_j = ei; dd_all = 0.0; dd_pre = 0.0; dd_run = 0.0                              # pullbacks from the running best, along the V1 life
    for j in range(ei, int(v1['xj']) + 1):
        if best is not None:
            dd = (best - l[j]) if d == 1 else (h[j] - best); dd_run = max(dd_run, dd); dd_all = max(dd_all, dd)
        bp = h[j] if d == 1 else l[j]
        if best is None or (bp > best if d == 1 else bp < best): best = bp; dd_pre = dd_run; peak_j = j                                     # pre-peak pullback = the largest pullback seen before the final best was set
    out.update(dd_pre=dd_pre, dd_all=dd_all, peak_frac=(peak_j - ei) / max(1, int(v1['xj']) - ei))
    for k in KS:
        tr = run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i, trail_k=k, scale=scale)[0]; out[f'k{k}_net'] = tr['net']; out[f'k{k}_pts'] = tr['pts']; out[f'k{k}_why'] = tr['reason']
    return out


def boot(x, days, q, B=4000):
    x = np.asarray(x, float); s = pd.Series(x).groupby(days).agg(['sum', 'count']); sm, ct = s['sum'].values, s['count'].values; m = np.empty(B)
    for b in range(B): p = rng.integers(0, len(sm), len(sm)); m[b] = sm[p].sum() / ct[p].sum()
    return np.percentile(m, q), float(np.std(m))


R, bad = replay_rows(extra)
R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_hold_value_trail_rows.csv'), index=False)
print(f'{len(R)} entries ({bad} without an entry bar); PARITY v1 vs the file: max |diff| {np.abs(R["v1_net"] - R.csv_net).max():.4f}, trades differing by more than 0.01: {int((np.abs(R["v1_net"] - R.csv_net) > 0.01).sum())}')
dates = sorted(R.date.unique()); half = set(dates[len(dates) // 2:])
R['den'] = np.maximum(R.v1_mfe, R.scale); R['cap_v1'] = R.v1_pts / R.den
print(f'scale s (median of 20 bars): median {R.scale.median():.1f} points, p10 {R.scale.quantile(.1):.1f}, p90 {R.scale.quantile(.9):.1f}')
print('\nDESCRIPTIVE: how far back is normal (V1 life; points and units of s)')
W = R[R.csv_net > 0]; L_ = R[R.csv_net <= 0]; TOP = R[R.v1_mfe >= R.v1_mfe.quantile(.75)]
for lab, g in (('winners (net>0)', W), ('not winners', L_), ('top quarter of MFE', TOP)):
    q = lambda col, u: ' / '.join(f'{(g[col] / (g.scale if u else 1)).quantile(p):6.1f}' for p in (.25, .5, .75, .9))
    print(f'  {lab:19s} N={len(g):4d}  MFE pts p25/50/75/90 {q("v1_mfe", 0)}  |  pre-peak pullback pts {q("dd_pre", 0)}  |  pre-peak pullback in s {q("dd_pre", 1)}  |  MFE in s {q("v1_mfe", 1)}')
print(f'  share of the MFE the tell keeps: sum(exit points) / sum(V1 MFE) = {100 * R.v1_pts.sum() / R.v1_mfe.sum():.1f}% overall; winners {100 * W.v1_pts.sum() / W.v1_mfe.sum():.1f}%; runners (top quarter) {100 * TOP.v1_pts.sum() / TOP.v1_mfe.sum():.1f}%; median per-trade capture (floored) {R.cap_v1.median():+.2f}')
print('\nCOUNTED TESTS: arm minus V1, paired; CI 98.33% (Bonferroni 3), day-block; capture = exit points / max(V1 MFE, s)')
for k in KS:
    R[f'cap_k{k}'] = R[f'k{k}_pts'] / R.den; dc = (R[f'cap_k{k}'] - R.cap_v1).values; dn = (R[f'k{k}_net'] - R.v1_net).values
    cc, sc = boot(dc, R.date.values, (0.835, 99.165)); cn, sn = boot(dn, R.date.values, (0.835, 99.165)); h2 = R.date.isin(half).values
    hs = (dc[~h2].mean() > 0, dc[h2].mean() > 0); keeps = cc[0] > 0 and cn[0] > -2.8 * sn and all(hs); costs = cc[0] > 0 and cn[1] < 0 and all(hs)
    print(f'  k={k:2d}  capture diff {dc.mean():+.3f} (V1 {R.cap_v1.mean():+.3f}) CI98.33 [{cc[0]:+.3f}, {cc[1]:+.3f}] SE {sc:.3f} | net diff {dn.mean():+7.2f} CI98.33 [{cn[0]:+.1f}, {cn[1]:+.1f}] SE {sn:.2f} detectable {2.8 * sn:.1f} | halves {hs}  => '
          + ('KEEPS MORE, COSTS RUNNERS' if costs else ('KEEPS MORE' if keeps else ('LEAD (capture up, CI includes 0)' if dc.mean() > 0 and cc[0] <= 0 else 'NOT SHOWN'))))
print('\nREPORTED PER ARM (not counted): win rate, avg winner, avg loser, worst, mean net, saved vs cut, runner-cut rate, aggregate share kept')
for lab, col in (('V1', 'v1'), *[(f'k={k}', f'k{k}') for k in KS]):
    x = R[f'{col}_net']; pts = R[f'{col}_pts']; sv = (R[f'{col}_net'] - R.v1_net)
    cut = (R.v1_net > 0) & (R[f'{col}_net'] < R.v1_net) if col != 'v1' else pd.Series(False, index=R.index)
    print(f'  {lab:5s} WR {100 * (x > 0).mean():3.0f}%  avg win {x[x > 0].mean():+7.1f}  avg loss {x[x <= 0].mean():+7.1f}  worst {x.min():+8.1f}  mean {x.mean():+6.2f}  saved +{sv[sv > 0].sum():8.0f} / cut {sv[sv < 0].sum():9.0f}  runner-cut rate {100 * cut.sum() / max(1, (R.v1_net > 0).sum()):4.1f}%  kept share {100 * pts.sum() / R.v1_mfe.sum():5.1f}%  stop-exit {100 * R[f"{col}_why"].astype(str).str.contains("STOP").mean():3.0f}%')
fh = (R.ehr >= H10) & (R.ehr < H11); print('\nBY ENTRY HOUR (descriptive): mean paired capture diff / net diff vs V1')
for lab, m in (('10:00-10:59', fh), ('11:00 on', ~fh)):
    g = R[m]; print(f'  {lab:12s} N={len(g):4d}  V1 net {g.v1_net.mean():+6.2f}' + ''.join(f'   k={k}: cap {(g[f"cap_k{k}"] - g.cap_v1).mean():+.3f} net {(g[f"k{k}_net"] - g.v1_net).mean():+6.2f}' for k in KS))
