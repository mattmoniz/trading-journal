"""POC travel at the fire vs the tell and flip results. Pre-registration: docs/TELL_POC_TRAVEL_PREREG_20261103.md. Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_poc_travel.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, RTH0, REPO
from block_stats import bootmean, bootdiff
from context import _profile, value_area
rng = np.random.default_rng(37); CACHE = {}
def poc_of(bars): return float(value_area(_profile(bars, True))[0])
def extra(S, allb, sig, t, ctxf):
    sec = allb[sig]['end']; d = S['d']; pts = []
    for k in range(1, 13):
        tk = RTH0 + 1800 * k
        if tk > sec: break
        if (d, k) not in CACHE:
            sub = [b for b in allb if b['end'] <= tk]; CACHE[(d, k)] = poc_of(sub) if sum(b['end'] >= RTH0 for b in sub) >= 5 else None
        if CACHE[(d, k)] is not None: pts.append(CACHE[(d, k)])
    rth = [b for b in allb[:sig + 1] if b['end'] >= RTH0]
    if len(rth) < 5 or not pts: return dict(travel=np.nan, net=np.nan)
    now = poc_of(allb[:sig + 1]); rg = max(b['h'] for b in rth) - min(b['l'] for b in rth); allp = pts + [now]
    return dict(travel=(max(allp) - min(allp)) / max(rg, 1e-9), net=int(t['dir']) * (now - pts[0]) / max(rg, 1e-9))
R, bad = replay_rows(extra)
R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_poc_travel_rows.csv'), index=False)
V = R.dropna(subset=['travel']); cut = float(np.quantile(V.travel, 2 / 3)); R['big'] = R.travel > cut; ag = R[(R.label == 'AGAINST') & R.travel.notna()].copy(); ag['gap'] = ag.C - ag.A
print(f'{len(R)} fires replayed ({bad} without entry bar), {len(V)} with a POC travel value; big-travel cut (top tercile) {cut:.3f}; AGAINST fires with a value {len(ag)}, big {int(ag.big.sum())}, rest {int((~ag.big).sum())}; NET>0 {int((ag.net > 0).sum())}, NET<0 {int((ag.net < 0).sum())}')
def cm(df, col): x = df[col].values; c = bootmean(x, df.date.values, rng); return f'N={len(x):4d} mean {x.mean():+7.2f}  CI [{c[0]:+.1f}, {c[1]:+.1f}]' + ('  (N<20: not a result)' if len(x) < 20 else '')
def diff(name, a, b, col):
    if len(a) < 20 or len(b) < 20: print(f'  {name}: a group has N<20, no contrast'); return
    c = bootdiff(a[col].values, a.date.values, b[col].values, b.date.values, rng)
    h1 = (a[a.date < '2024-04-01'][col].mean() - b[b.date < '2024-04-01'][col].mean()); h2 = (a[a.date >= '2024-04-01'][col].mean() - b[b.date >= '2024-04-01'][col].mean())
    print(f'  {name}: {a[col].mean() - b[col].mean():+7.2f}  CI [{c[0]:+.1f}, {c[1]:+.1f}]   halves {h1:+.1f} / {h2:+.1f}  ' + ('-> LEAD (CI excludes 0, same sign both halves)' if (c[0] > 0 or c[1] < 0) and h1 * h2 > 0 else '-> not shown'))
print('\nT1-T3, AGAINST fires, big travel vs rest')
for lab, m in (('big travel', ag.big), ('rest', ~ag.big)): g = ag[m]; print(f'  {lab:10s} tell {cm(g, "A")}   | flip {cm(g, "C")}   | flip-tell {g.gap.mean():+.2f}')
diff('T1 tell: big minus rest', ag[ag.big], ag[~ag.big], 'A'); diff('T2 flip: big minus rest', ag[ag.big], ag[~ag.big], 'C'); diff('T3 flip-tell: big minus rest', ag[ag.big], ag[~ag.big], 'gap')
print('\nT4 all fires, share ending multi-hump')
R['fm'] = R.final_multi.astype(float); V2 = R[R.travel.notna()]; diff('T4 multi-hump share: big minus rest', V2[V2.big], V2[~V2.big], 'fm')
print(f'  big travel: {100 * V2[V2.big].fm.mean():.0f}% multi-hump (N={int(V2.big.sum())})   rest: {100 * V2[~V2.big].fm.mean():.0f}% (N={int((~V2.big).sum())})   all: {100 * V2.fm.mean():.0f}%')
print('\nT5-T6, AGAINST fires, POC moved WITH the fire vs AGAINST it')
for lab, m in (('POC with fire', ag.net > 0), ('POC against fire', ag.net < 0)): g = ag[m]; print(f'  {lab:17s} tell {cm(g, "A")}   | flip {cm(g, "C")}')
diff('T5 tell: with minus against', ag[ag.net > 0], ag[ag.net < 0], 'A'); diff('T6 flip: with minus against', ag[ag.net > 0], ag[ag.net < 0], 'C')
print('\nDESCRIPTIVE (not counted): AGAINST fires by travel tercile')
t3 = np.quantile(ag.travel, [1 / 3, 2 / 3])
for lab, m in (('low third', ag.travel <= t3[0]), ('middle', (ag.travel > t3[0]) & (ag.travel <= t3[1])), ('high third', ag.travel > t3[1])): g = ag[m]; print(f'  {lab:10s} travel {g.travel.min():.2f}-{g.travel.max():.2f}  tell {g.A.mean():+7.2f}  flip {g.C.mean():+7.2f}  N={len(g)}  ended multi-hump {100 * g.final_multi.mean():.0f}%')
print('AGAINST fires before 12:00 vs from 12:00, big vs rest (tell / flip means, N):')
for lab, m in (('before 12:00', ag.end_sec < RTH0 + 9000), ('from 12:00', ag.end_sec >= RTH0 + 9000)):
    for bl, bm in (('big', ag.big), ('rest', ~ag.big)): g = ag[m & bm]; print(f'  {lab:13s} {bl:5s} N={len(g):3d} tell {g.A.mean() if len(g) else float("nan"):+7.2f} flip {g.C.mean() if len(g) else float("nan"):+7.2f}')
