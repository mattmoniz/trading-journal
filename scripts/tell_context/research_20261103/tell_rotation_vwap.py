"""Rotation-leg direction and rotational VWAP as a filter for the tell's early fires (docs/TELL_ROTATION_VWAP_PREREG_20261104.md): T1 leg direction, T2 rotational VWAP side, T3 VWAP side within agreeing fires, T4 static stop beyond the leg pivot.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_rotation_vwap.py   (the state file comes from export_rotation_vwap_20261104.mjs; look 156 is logged first, hr-023)"""
import os, sys, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tell_replay_lib import replay_rows, F, REPO, SH, T, V

RTH0 = 55800.0; EARLY_END = RTH0 + 120 * 60; TICK = T.TICK
STATE = json.load(open(os.path.join(REPO, 'scratch', 'rotation_vwap_20261104', 'state.json')))
rng = np.random.default_rng(20261104)


def extra(S, allb, sig, t, ctxf):
    ctx = S['_ctx']; d = int(t['dir']); ei = int(t['ei']); s = float(t['risk']); entry = float(S['o'][ei]) + d * T.SLIP; end_i = S['end'][sig]; end_sec = float(S['end'][sig])
    out = dict(early=end_sec < EARLY_END, ehr=end_sec, leg=0, agree=np.nan, with_rv=np.nan, with_rt=np.nan, with_sv=np.nan, dist_rv=np.nan, t4_net=np.nan, t4_changed=False, t4_dist=np.nan)
    st = STATE.get(t['date'] if 'date' in t else ''); i = int((end_sec - RTH0) // 60) - 1                                  # last COMPLETED minute strictly before the fire
    if st is None or i < 0 or i >= st['n']: out['nostate'] = True; return out
    out['nostate'] = False; leg = st['dir'][i]; out['leg'] = leg; sv = st['sv'][i]
    out['with_sv'] = float(entry > sv if d == 1 else entry < sv) if sv is not None else np.nan
    if leg == 0: return out
    rv, rt, piv = st['rv'][i], st['rt'][i], st['piv'][i]
    out['agree'] = float(leg == d); out['with_rv'] = float(entry > rv if d == 1 else entry < rv); out['with_rt'] = float(entry > rt if d == 1 else entry < rt); out['dist_rv'] = abs(entry - rv)
    if leg == d:                                                                                           # T4: a static stop one tick beyond the leg pivot, never closer than the tell's own stop
        v1s = entry - d * s; ps = piv + TICK if d == -1 else piv - TICK; use = max(ps, v1s) if d == -1 else min(ps, v1s)
        out['t4_changed'] = bool((entry - use) * d > 0 and abs(use - v1s) > 1e-9); out['t4_dist'] = abs(entry - use)
        if out['t4_changed']: out['t4_net'] = SH._run(ctx, ei, d, use, end_i, True)['net']
    return out


def diff_boot(xa, da, xb, db, q=(0.625, 99.375), B=4000):
    ua = pd.Series(xa).groupby(da).agg(['sum', 'count']); ub = pd.Series(xb).groupby(db).agg(['sum', 'count']); u = sorted(set(ua.index) | set(ub.index))
    sa = np.array([ua['sum'].get(k, 0.0) for k in u]); na = np.array([ua['count'].get(k, 0) for k in u]); sb = np.array([ub['sum'].get(k, 0.0) for k in u]); nb = np.array([ub['count'].get(k, 0) for k in u]); m = np.empty(B)
    for b in range(B):
        p = rng.integers(0, len(u), len(u)); a_, b_ = na[p].sum(), nb[p].sum(); m[b] = (sa[p].sum() / a_ - sb[p].sum() / b_) if a_ and b_ else np.nan
    return np.nanpercentile(m, q), float(np.nanstd(m))


def mean_boot(x, days, q=(0.625, 99.375), B=4000):
    x = np.asarray(x, float); s = pd.Series(x).groupby(days).agg(['sum', 'count']); sm, ct = s['sum'].values, s['count'].values; m = np.empty(B)
    for b in range(B): p = rng.integers(0, len(sm), len(sm)); m[b] = sm[p].sum() / ct[p].sum()
    return np.percentile(m, q), float(np.std(m))


R, bad = replay_rows(extra)
R['net'] = R.csv_net; R.to_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'tell_rotation_vwap_rows.csv'), index=False)
dates = sorted(R.date.unique()); half = set(dates[len(dates) // 2:]); thirds = [set(dates[i * len(dates) // 3:(i + 1) * len(dates) // 3]) for i in range(3)]
print(f'{len(R)} entries ({bad} without an entry bar); state missing for {int(R.nostate.sum())}; early (before 11:30): {int(R.early.sum())}; no leg yet among early: {int(((R.early) & (R.leg == 0) & (~R.nostate)).sum())}')
E = R[R.early & (R.leg != 0) & (~R.nostate)].copy(); print(f'early fires with a confirmed leg: {len(E)} on {E.date.nunique()} dates; AGREE share {100 * E.agree.mean():.1f}%; WITH_RV share {100 * E.with_rv.mean():.1f}%')


def verdict(lab, a, b):
    ci, se = diff_boot(a.net.values, a.date.values, b.net.values, b.date.values); ci95, _ = diff_boot(a.net.values, a.date.values, b.net.values, b.date.values, q=(2.5, 97.5)); dm = a.net.mean() - b.net.mean()
    def sub(ds): x, y = a[a.date.isin(ds)], b[b.date.isin(ds)]; return (x.net.mean() - y.net.mean()) if len(x) and len(y) else np.nan
    hs = [sub(set(dates) - half) > 0, sub(half) > 0]; th = [sub(t) > 0 for t in thirds]; ok = ci[0] > 0 and all(hs) and sum(th) >= 2
    print(f'  {lab}: N {len(a)} vs {len(b)}  means {a.net.mean():+.2f} vs {b.net.mean():+.2f}  diff {dm:+.2f}  CI98.75 [{ci[0]:+.1f}, {ci[1]:+.1f}]  CI95 [{ci95[0]:+.1f}, {ci95[1]:+.1f}]  SE {se:.2f} detectable {2.8 * se:.1f}  halves {hs} thirds {th}  => '
          + ('SEPARATES' if ok else ('LEAD (positive mean, CI includes 0)' if dm > 0 else 'NOT SHOWN')))
    return ok


print('\nCOUNTED TESTS (fires before 11:30 with a confirmed leg; difference in mean net dollars per trade, CI 98.75% day-block)')
verdict('T1 AGREE minus AGAINST (leg direction)', E[E.agree == 1], E[E.agree == 0])
verdict('T2 WITH_RV minus AGAINST_RV (rotational VWAP side)', E[E.with_rv == 1], E[E.with_rv == 0])
EA = E[E.agree == 1]; verdict('T3 WITH_RV minus AGAINST_RV within AGREE (VWAP beyond direction)', EA[EA.with_rv == 1], EA[EA.with_rv == 0])
g = EA[EA.t4_changed]
if len(g) >= 20:
    dd = (g.t4_net - g.net).values; ci, se = mean_boot(dd, g.date.values); ci95, _ = mean_boot(dd, g.date.values, q=(2.5, 97.5)); hs = [dd[~g.date.isin(half).values].mean() > 0, dd[g.date.isin(half).values].mean() > 0]; th = [dd[g.date.isin(t).values].mean() > 0 for t in thirds]
    ok = ci[0] > 0 and all(hs) and sum(th) >= 2
    print(f'  T4 pivot stop minus V1 on {len(g)} AGREE fires whose stop changed: diff {dd.mean():+.2f}  CI98.75 [{ci[0]:+.1f}, {ci[1]:+.1f}]  CI95 [{ci95[0]:+.1f}, {ci95[1]:+.1f}]  SE {se:.2f} detectable {2.8 * se:.1f}  halves {hs} thirds {th}  V1 mean {g.net.mean():+.2f} arm mean {g.t4_net.mean():+.2f}  median stop dist {g.t4_dist.median():.1f}  => ' + ('PAYS' if ok else ('LEAD (positive mean, CI includes 0)' if dd.mean() > 0 else 'NOT SHOWN')))
else: print(f'  T4 UNDERPOWERED: only {len(g)} AGREE fires with a changed stop')
print('\nDESCRIPTIVE')
print('  buckets (all fires with state): mean net / win rate / N')
for lab, m in (('early AGREE', R.early & (R.agree == 1)), ('early AGAINST', R.early & (R.agree == 0)), ('early no leg yet', R.early & (R.leg == 0) & (~R.nostate)), ('later AGREE', (~R.early) & (R.agree == 1)), ('later AGAINST', (~R.early) & (R.agree == 0))):
    x = R[m]; print(f'    {lab:18s} N={len(x):4d}  mean {x.net.mean():+7.2f}  WR {100 * (x.net > 0).mean():3.0f}%')
print('  VWAP variants (early, with a leg): WITH minus AGAINST')
for lab, col in (('rotational volume-weighted', 'with_rv'), ('rotational equal-weight', 'with_rt'), ('session 09:30 VWAP', 'with_sv')):
    a, b = E[E[col] == 1], E[E[col] == 0]; print(f'    {lab:28s} WITH N={len(a):4d} {a.net.mean():+7.2f}  AGAINST N={len(b):4d} {b.net.mean():+7.2f}  diff {a.net.mean() - b.net.mean():+6.2f}')
print('  2x2 early: leg direction x rotational VWAP side (mean net, N)')
for ag in (1, 0):
    for wr in (1, 0):
        x = E[(E.agree == ag) & (E.with_rv == wr)]; print(f'    {"AGREE " if ag else "AGAINST"} / {"WITH_RV " if wr else "AGAINST_RV"}  N={len(x):4d}  mean {x.net.mean():+7.2f}' if len(x) else f'    {"AGREE " if ag else "AGAINST"} / {"WITH_RV " if wr else "AGAINST_RV"}  N=0')
print('  context label x leg (early, with a leg): label AGREES/AGAINST/NEUTRAL/UNKNOWN vs AGREE_LEG mean net')
for lab in ('AGREES', 'AGAINST', 'NEUTRAL', 'UNKNOWN'):
    for ag in (1, 0):
        x = E[(E.label == lab) & (E.agree == ag)]
        if len(x): print(f'    {lab:8s} {"leg agree  " if ag else "leg against"} N={len(x):4d} mean {x.net.mean():+7.2f}')
print('  by entry hour, AGREE minus AGAINST (with a leg, all fires): ' + '; '.join(f'{lab} {a.net.mean() - b.net.mean():+.2f} (N {len(a)}/{len(b)})' for lab, m in (('10:00-10:59', (R.ehr >= 57600) & (R.ehr < 61200)), ('11:00-11:29', (R.ehr >= 61200) & (R.ehr < 63000)), ('11:30 on', R.ehr >= 63000)) for a, b in [(R[m & (R.agree == 1)], R[m & (R.agree == 0)])] if len(a) and len(b)))
print(f'  distance of the entry from the rotational VWAP (early, with a leg): median {E.dist_rv.median():.1f} pts, p90 {E.dist_rv.quantile(.9):.1f} pts')
