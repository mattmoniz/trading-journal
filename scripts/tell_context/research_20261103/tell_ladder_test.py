"""Tell node-ladder test (docs/TELL_LADDER_TEST_PREREG_20261104.md): stop-placement sweep, ladder length, node target, by day shape. Explore, same 1,760 entries. Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_ladder_test.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F, REPO, SH, T, V
import core
from block_stats import bootmean, bootdiff
rng = np.random.default_rng(97); MS = (0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0); TICK = T.SLIP; NET = lambda px, entry, d: ((px - entry) * d) * T.DPP - T.COMM
def extra(S, allb, sig, t, ctxf):
    ctx = S['_ctx']; d = int(t['dir']); ei = int(t['ei']); s = float(t['risk']); entry = float(S['o'][ei]) + d * T.SLIP; end_i = S['end'][sig]; out = dict(s=s)
    out['L'] = int(core.decision_details(ctx, dict(sig=sig, dir=d))['L'])
    runs = {}
    for m in MS:
        r = SH._run(ctx, ei, d, entry - d * m * s, end_i, True); runs[m] = r; out[f'n{m}'] = r['net']
    v1 = runs[1.0]; out['v1_reason'] = v1['exit_reason']; out['v1_x'] = v1['exit_idx']
    P = T.Prof(ctx).upto(sig); cur = float(S['c'][sig]); nds = V.nodes_of(P, ctx['lo_bin']); tgt = None
    ah = [(a, b) for a, b in nds if (d == 1 and a * T.TICK > cur) or (d == -1 and (b + 1) * T.TICK < cur)]
    if ah:
        nd = min(ah, key=lambda ab: ab[0]) if d == 1 else max(ah, key=lambda ab: ab[1]); tgt = nd[0] * T.TICK if d == 1 else (nd[1] + 1) * T.TICK
        if (tgt - entry) * d < 2 * T.TICK: tgt = None
    out['tgt'] = np.nan if tgt is None else float(tgt); out['tgt_dist'] = np.nan if tgt is None else abs(tgt - entry)
    out['tgt_net'] = v1['net']
    if tgt is not None:
        hi, lo = S['h'], S['l']; xj = v1['exit_idx']
        for k in range(ei, min(xj, len(hi) - 1) + 0):
            if (d == 1 and hi[k] >= tgt + T.TICK) or (d == -1 and lo[k] <= tgt - T.TICK):
                out['tgt_net'] = NET(tgt, entry, d); break
    return out
R, bad = replay_rows(extra)
print(f'{len(R)} entries ({bad} without an entry bar); PARITY m=1 vs the file: max |diff| {np.abs(R["n1.0"] - R.csv_net).max():.4f}, trades differing by more than 0.01: {int((np.abs(R["n1.0"] - R.csv_net) > 0.01).sum())}')
bim = np.array([F[d]['final']['bimod'] for d in F]); q90, q25 = float(np.quantile(bim, .9)), float(np.quantile(bim, .25)); R['sB'] = R.bim >= q90; R['sD'] = (R.bim <= q25) & (R.letter == 'D')
R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_ladder_rows.csv'), index=False)
def ci(x, days): c = bootmean(np.asarray(x), days, rng, B=2000); return c
print('\n1. STOP SWEEP (V1 management unchanged; stop at m x the node-stop distance); mean dollars per trade, win rate, day-block CI; diff vs m=1.0 (paired)')
for m in MS:
    x = R[f'n{m}']; c = ci(x.values, R.date.values); dd = (x - R['n1.0']); cd = ci(dd.values, R.date.values)
    print(f'  m={m:4.2f}  mean {x.mean():+7.2f}  WR {100*(x>0).mean():3.0f}%  CI [{c[0]:+.1f}, {c[1]:+.1f}]   vs m=1: {dd.mean():+6.2f} CI [{cd[0]:+.1f}, {cd[1]:+.1f}]')
t1 = (R['n1.0'] - R['n0.75']); t2 = (R['n1.0'] - R['n1.25']); c1, c2 = ci(t1.values, R.date.values), ci(t2.values, R.date.values)
loc = t1.mean() > 0 and t2.mean() > 0 and (c1[0] > 0 or c2[0] > 0)
print(f'  T1 m=1.0 minus 0.75: {t1.mean():+.2f} CI [{c1[0]:+.1f}, {c1[1]:+.1f}]   T2 m=1.0 minus 1.25: {t2.mean():+.2f} CI [{c2[0]:+.1f}, {c2[1]:+.1f}]   => ' + ('m=1 is a LOCAL MAXIMUM (a node effect)' if loc else 'NOT a local maximum: the dose-response is in distance, not in node placement'))
print('\n2. LADDER LENGTH L (nodes left behind)')
R['Lb'] = np.where(R.L >= 4, '4+', R.L.astype(str))
for k in sorted(R.Lb.unique()): g = R[R.Lb == k]; c = ci(g['n1.0'].values, g.date.values); print(f'  L={k:2s} N={len(g):4d}  mean {g["n1.0"].mean():+7.2f}  CI [{c[0]:+.1f}, {c[1]:+.1f}]  median stop {g.s.median():.1f} pts')
a, b = R[R.L >= 3], R[R.L == 2]
if len(a) >= 20 and len(b) >= 20: cd = bootdiff(a['n1.0'].values, a.date.values, b['n1.0'].values, b.date.values, rng); print(f'  T3 L>=3 minus L=2: {a["n1.0"].mean() - b["n1.0"].mean():+.2f} CI [{cd[0]:+.1f}, {cd[1]:+.1f}]  (N {len(a)} / {len(b)})')
print('\n3. NODE TARGET (target = near edge of the nearest node ahead)')
G = R[R.tgt.notna()]; print(f'  entries with a node ahead: {len(G)} of {len(R)} ({100*len(G)/len(R):.0f}%); median target distance {G.tgt_dist.median():.1f} pts vs median stop {G.s.median():.1f}; target touched before the V1 exit on {int((G.tgt_net != G["n1.0"]).sum())}')
if len(G) >= 150:
    dd = (G.tgt_net - G['n1.0']); cd = ci(dd.values, G.date.values); print(f'  T4 target arm minus V1 on these entries: {dd.mean():+.2f} dollars/trade  CI [{cd[0]:+.1f}, {cd[1]:+.1f}]  (V1 mean {G["n1.0"].mean():+.2f}, target arm {G.tgt_net.mean():+.2f})')
else: print('  T4 UNDERPOWERED (< 150 entries with a node ahead): not scored')
print('\n4. BY DAY SHAPE (mean dollars per trade by stop multiple)')
print('  ' + ' ' * 18 + ''.join(f'  m={m:<5}' for m in MS))
for lab, m in (('ALL', R.bim.notna()), ('strong D', R.sD), ('strong B', R.sB), ('letter D', R.letter == 'D'), ('letter P', R.letter == 'P'), ('letter b', R.letter == 'b'), ('multi-hump', R.final_multi == True), ('not multi-hump', R.final_multi == False)):
    g = R[m]; print(f'  {lab:14s} N={len(g):4d}' + ''.join(f' {g[f"n{mm}"].mean():+8.1f}' for mm in MS))
a, b = R[R.sD], R[~R.sD]; da, db = (a['n2.0'] - a['n1.0']), (b['n2.0'] - b['n1.0']); cd = bootdiff(da.values, a.date.values, db.values, b.date.values, rng)
print(f'  T5 (m=2 minus m=1) on strong-D days {da.mean():+.2f} vs other days {db.mean():+.2f}: difference {da.mean() - db.mean():+.2f} CI [{cd[0]:+.1f}, {cd[1]:+.1f}]')
