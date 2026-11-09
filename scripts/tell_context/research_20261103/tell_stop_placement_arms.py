"""Stop-placement arms (docs/TELL_STOP_PLACEMENT_ARMS_PREREG_20261104.md): same 1,760 explore entries, V1 management, only the stop differs. Arms K3, K4, EXT, SIE vs V1 (paired, day-block CI at 98.75 percent).
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_stop_placement_arms.py   (look 155 is logged first by log_look_stop_placement_20261104.mjs, hr-023)"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F, REPO, SH, T, V
import core

TICK = T.TICK; H10, H11 = 57600.0, 61200.0
rng = np.random.default_rng(20261104)


def v1_net_stop(entry, d, s): return entry - d * s


# The stop functions (node_stop, coarse_stop, extreme_stop) live in scripts/tell_context/shadow.py, the single copy the live forward books also use (cv-079); scripts/tell_context/test_stop_books.py proves they reproduce this script's saved rows.


def run(ctx, ei, d, entry, stop, end_i):
    if stop is None or (entry - stop) * d <= 0: return None
    return SH._run(ctx, ei, d, stop, end_i, True)


def extra(S, allb, sig, t, ctxf):
    ctx = S['_ctx']; d = int(t['dir']); ei = int(t['ei']); s = float(t['risk']); entry = float(S['o'][ei]) + d * T.SLIP; end_i = S['end'][sig]
    P = T.Prof(ctx).upto(sig); v1s = entry - d * s; out = dict(s=s, ehr=float(S['start'][ei]))
    stops = dict(v1=v1s, k3=SH.node_stop(ctx, P, sig, d, 3), k4=SH.node_stop(ctx, P, sig, d, 4), ext=SH.extreme_stop(S, sig, d, v1s), sie=SH.coarse_stop(ctx, P, sig, d))
    for a, st in stops.items():
        ok = st is not None and (entry - st) * d > 0
        use = st if ok else v1s; r = SH._run(ctx, ei, d, use, end_i, True)
        out[f'{a}_changed'] = bool(ok and abs(use - v1s) > 1e-9); out[f'{a}_dist'] = abs(entry - use); out[f'{a}_net'] = r['net']; out[f'{a}_why'] = r['exit_reason']
        if a != 'v1' and out[f'{a}_changed']:                                                                # local-maximum neighbours at 0.75 and 1.25 times the arm's own distance
            for m in (0.75, 1.25): out[f'{a}_m{m}'] = SH._run(ctx, ei, d, entry - d * m * abs(entry - use), end_i, True)['net']
        else:
            for m in (0.75, 1.25): out[f'{a}_m{m}'] = np.nan
    return out


def dayboot(x, days, q=(0.625, 99.375), B_=4000):
    x = np.asarray(x, float); u = np.unique(days); idx = {d: np.where(days == d)[0] for d in u}; n = len(x); means = np.empty(B_)
    sums = np.array([x[idx[d]].sum() for d in u]); cnts = np.array([len(idx[d]) for d in u])
    for b in range(B_):
        pick = rng.integers(0, len(u), len(u)); means[b] = sums[pick].sum() / cnts[pick].sum()
    return np.percentile(means, q), float(np.std(means))


R, bad = replay_rows(extra)
print(f'{len(R)} entries ({bad} without an entry bar); PARITY v1 vs the file: max |diff| {np.abs(R["v1_net"] - R.csv_net).max():.4f}, trades differing by more than 0.01: {int((np.abs(R["v1_net"] - R.csv_net) > 0.01).sum())}')
R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_stop_placement_rows.csv'), index=False)
dates = R.date.values; order = np.argsort(pd.to_datetime(R.date).values, kind='stable'); ud = sorted(R.date.unique()); half = set(ud[len(ud) // 2:]); thirds = [set(ud[i * len(ud) // 3:(i + 1) * len(ud) // 3]) for i in range(3)]
print('\nDESCRIPTIVE per arm (all entries): share with a changed stop, median / p90 stop distance (points), win rate, avg win, avg loss, worst, stop-exit share')
for a in ('v1', 'k3', 'k4', 'ext', 'sie'):
    x = R[f'{a}_net']; ch = R.get(f'{a}_changed', pd.Series(True, index=R.index))
    print(f'  {a:4s} changed {100 * ch.mean():5.1f}%  dist med {R[f"{a}_dist"].median():6.1f} p90 {R[f"{a}_dist"].quantile(.9):6.1f}  WR {100 * (x > 0).mean():3.0f}%  avg win {x[x > 0].mean():+7.1f}  avg loss {x[x <= 0].mean():+7.1f}  worst {x.min():+8.1f}  mean {x.mean():+6.2f}  stop-exit {100 * (R[f"{a}_why"].astype(str).str.contains("STOP")).mean():3.0f}%')
print('\nCOUNTED TESTS: paired difference (arm minus V1), dollars per trade, day-block CI 98.75% (verdict) and 95% (printed), detectable effect = 2.8 x SE')
verdict = {}
for a in ('k3', 'k4', 'ext', 'sie'):
    dd = (R[f'{a}_net'] - R['v1_net']).values; c98, se = dayboot(dd, dates); c95, _ = dayboot(dd, dates, q=(2.5, 97.5))
    h2 = R.date.isin(half).values; h1 = ~h2; hs = (dd[h1].mean() > 0, dd[h2].mean() > 0); th = [dd[R.date.isin(t).values].mean() > 0 for t in thirds]
    pays = c98[0] > 0 and all(hs) and sum(th) >= 2; verdict[a] = pays
    print(f'  {a:4s} mean diff {dd.mean():+7.2f}  CI98.75 [{c98[0]:+.1f}, {c98[1]:+.1f}]  CI95 [{c95[0]:+.1f}, {c95[1]:+.1f}]  SE {se:.2f} detectable {2.8 * se:.1f}  halves {hs}  thirds {th}  changed N={int(R[f"{a}_changed"].sum())}  => ' + ('PAYS' if pays else ('LEAD (positive mean, CI includes 0)' if dd.mean() > 0 else 'NOT SHOWN')))
    g = R[R[f'{a}_changed']]
    if len(g) >= 20:
        d2 = (g[f'{a}_net'] - g['v1_net']).values; c, _ = dayboot(d2, g.date.values, q=(2.5, 97.5)); print(f'        on the {len(g)} entries whose stop changed: mean diff {d2.mean():+.2f} CI95 [{c[0]:+.1f}, {c[1]:+.1f}]; V1 mean on them {g.v1_net.mean():+.2f}, arm mean {g[f"{a}_net"].mean():+.2f}')
print('\nNODE EFFECT (descriptive, entries with a changed stop): arm net vs the same arm at 0.75 and 1.25 times its own distance')
for a in ('k3', 'k4', 'ext', 'sie'):
    g = R[R[f'{a}_changed'] & R[f'{a}_m0.75'].notna()]
    if len(g): print(f'  {a:4s} N={len(g):4d}  0.75x {g[f"{a}_m0.75"].mean():+7.2f}   1.0x {g[f"{a}_net"].mean():+7.2f}   1.25x {g[f"{a}_m1.25"].mean():+7.2f}  => ' + ('local maximum' if g[f"{a}_net"].mean() > max(g[f"{a}_m0.75"].mean(), g[f"{a}_m1.25"].mean()) else 'no local maximum (distance, not placement)'))
print('\nBY ENTRY HOUR (descriptive): mean paired difference vs V1')
fh = (R.ehr >= H10) & (R.ehr < H11)
for lab, m in (('10:00-10:59', fh), ('11:00 on', ~fh)):
    g = R[m]; print(f'  {lab:12s} N={len(g):4d} V1 {g.v1_net.mean():+6.2f}' + ''.join(f'   {a} {(g[f"{a}_net"] - g.v1_net).mean():+6.2f}' for a in ('k3', 'k4', 'ext', 'sie')))
print('\nBY FINAL DAY SHAPE (hindsight, descriptive): mean paired difference vs V1')
bim = np.array([F[d]['final']['bimod'] for d in F]); q90, q25 = float(np.quantile(bim, .9)), float(np.quantile(bim, .25)); R['sB'] = R.bim >= q90; R['sD'] = (R.bim <= q25) & (R.letter == 'D')
for lab, m in (('strong D', R.sD), ('strong B', R.sB), ('letter D', R.letter == 'D'), ('letter P', R.letter == 'P'), ('letter b', R.letter == 'b'), ('multi-hump', R.final_multi == True)):
    g = R[m]; print(f'  {lab:11s} N={len(g):4d} V1 {g.v1_net.mean():+6.2f}' + ''.join(f'   {a} {(g[f"{a}_net"] - g.v1_net).mean():+6.2f}' for a in ('k3', 'k4', 'ext', 'sie')))
print('\nONE-CONTRACT DOLLAR RISK (stop distance x $2): median and p90 by arm: ' + '; '.join(f'{a} {2 * R[f"{a}_dist"].median():.0f} / {2 * R[f"{a}_dist"].quantile(.9):.0f}' for a in ('v1', 'k3', 'k4', 'ext', 'sie')))
