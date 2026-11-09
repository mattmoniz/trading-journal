"""Addendum A2 of docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md: volatility-regime measures instead of the rotation count, plus the momentum control arm. Usage: venv/bin/python scripts/tell_context/research_20261103/ovn_orderflow_regime.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ovn_sim import sim, load_days, SLIP
from block_stats import bootmean, bootdiff
DAY = load_days(); rng = np.random.default_rng(199); dates = sorted(DAY); rr = {}
for d in dates:
    x = DAY[d]; m = np.array(x['m']); k = (m >= 570) & (m < 960); rr[d] = float(np.max(np.array(x['h'])[k]) - np.min(np.array(x['l'])[k])) if k.sum() > 300 else np.nan
rows = []; adr_hist = []
for i, dte in enumerate(dates):
    x = DAY[dte]; prior = [rr[p] for p in dates[max(0, i - 20):i] if np.isfinite(rr[p])]
    if len(prior) < 15: continue
    adr = float(np.median(prior)); net = x['ask'] - x['bid']; tot = x['ask'] + x['bid']; adr_hist.append(adr)
    if tot <= 0 or net == 0: continue
    d = 1 if net > 0 else -1; m = np.array(x['m']); j0 = int(np.argmax(m >= 0)); en = x['o'][j0]; nl = sim(x, 1, en + SLIP, 400, 870)[0]; ns = sim(x, -1, en - SLIP, 400, 870)[0]; mom = np.sign(x['c_pre'] - x['open18']) or 1; k = (m >= 570) & (m < 960); ii = np.where(k)[0]
    pdr = rr.get(dates[i - 1], np.nan) if i > 0 else np.nan
    rows.append(dict(d=dte, dir=d, legs=x['legs'], R1=(x['hi_pre'] - x['lo_pre']) / adr, R2=adr, R5=(pdr / adr) if np.isfinite(pdr) else np.nan, flow=nl if d == 1 else ns, mom=nl if mom == 1 else ns, rev=ns if mom == 1 else nl, hit=float(np.sign(x['c'][ii[-1]] - x['o'][ii[0]]) == d), mh=float(np.sign(x['c'][ii[-1]] - x['o'][ii[0]]) == mom),
                     L=nl, S=ns, st150=sim(x, d, en + d * SLIP, 150, 870)[0], st200=sim(x, d, en + d * SLIP, 200, 870)[0], st300=sim(x, d, en + d * SLIP, 300, 870)[0], st400=nl if d == 1 else ns))
R = pd.DataFrame(rows).sort_values('d').reset_index(drop=True); R['yr'] = R.d.str[:4]; R['q'] = R.d.str[:4] + 'Q' + ((R.d.str[5:7].astype(int) - 1) // 3 + 1).astype(str)
for col in ('R1', 'R2', 'R5'): R['on_' + col] = [(R[col].values[i] >= np.nanquantile(R[col].values[:i], 0.9)) if i >= 60 else np.nan for i in range(len(R))]
R['on_legs'] = R.legs >= 6; S = R.iloc[60:].copy(); half = S.d.sort_values().iloc[len(S) // 2]; S['half'] = np.where(S.d < half, 1, 2)
print(f'{len(R)} nights with a flow sign; {len(S)} scored (the first 60 have no expanding cut); split at {half}; market drift: always LONG {S.L.mean():+.1f}, always SHORT {S.S.mean():+.1f}')
def block(name, on, counted):
    a, b = S[on.astype(bool)], S[~on.astype(bool)]
    if len(a) < 15: print(f'  {name}: only {len(a)} ON nights'); return None
    ca = bootmean(a.flow.values, a.d.values, rng, B=1500); cd = bootdiff(a.flow.values, a.d.values, b.flow.values, b.d.values, rng); h = [a[a.half == k].flow.mean() - b[b.half == k].flow.mean() for k in (1, 2)]; ov = S.on_legs[on.astype(bool)].mean()
    print(f'  {name:26s} ON N={len(a):3d} mean {a.flow.mean():+7.1f} CI [{ca[0]:+.0f}, {ca[1]:+.0f}] win {100*(a.flow>0).mean():3.0f}% hit {100*a.hit.mean():3.0f}% | OFF N={len(b):3d} mean {b.flow.mean():+6.1f} | ON minus OFF {a.flow.mean() - b.flow.mean():+7.1f} CI [{cd[0]:+.0f}, {cd[1]:+.0f}] halves {h[0]:+.0f}/{h[1]:+.0f} | share of ON that are legs>=6: {100*ov:.0f}%' + (('  -> LEAD' if cd[0] > 0 and min(h) > 0 else '  -> not shown') if counted else '')); return a
print('\nREGIME MEASURES (ON = at or above the expanding 90th percentile of earlier nights); the flow-sign trade, stop 400, exit 14:30')
A1 = block('T1 R1 overnight range / ADR', S.on_R1, True); A2 = block('T2 R2 ADR era percentile', S.on_R2, True); A5 = block('T3 R5 prior-day range / ADR', S.on_R5, True); block('comparator: legs >= 6', S.on_legs, False)
block('R1 ON and legs >= 6', S.on_R1.astype(bool) & S.on_legs, False); block('R1 ON or legs >= 6', S.on_R1.astype(bool) | S.on_legs, False)
g = S[S.on_legs]; cd = bootmean((g.flow - g.mom).values, g.d.values, rng, B=2000)
print(f'\nT4 CONTROL on the legs >= 6 nights (N={len(g)}): flow-sign trade {g.flow.mean():+.1f}, following the overnight price move (M1) {g.mom.mean():+.1f} (RTH hit {100*g.mh.mean():.0f}%), against it (M2) {g.rev.mean():+.1f}; flow minus M1 {(g.flow - g.mom).mean():+.1f} CI [{cd[0]:+.0f}, {cd[1]:+.0f}]  -> ' + ('flow beats price momentum' if cd[0] > 0 else 'not shown'))
print('\nON counts and means by YEAR (flow-sign trade) for R1, R2, R5 and legs >= 6:')
for y in sorted(S.yr.unique()):
    s = S[S.yr == y]; print(f'  {y}: nights {len(s):3d} | ' + ' | '.join(f'{lab} ON {int(s[col].fillna(False).astype(bool).sum()):3d} mean {s[s[col].fillna(False).astype(bool)].flow.mean():+7.1f}' if s[col].fillna(False).astype(bool).sum() else f'{lab} ON   0' for lab, col in (('R1', 'on_R1'), ('R2', 'on_R2'), ('R5', 'on_R5'), ('legs', 'on_legs'))))
print('\nR1 ON by QUARTER (does it switch off when the regime fades?): ' + '; '.join(f'{q} {int(len(g))} {g.flow.mean():+.0f}' for q, g in S[S.on_R1.astype(bool)].groupby('q')))
if A1 is not None:
    print('\nSTOP SWEEP inside the R1 ON set (mean / worst / stopped%): ' + '; '.join(f'{lab} {A1[col].mean():+.0f} / {A1[col].min():+.0f}' for lab, col in (('150', 'st150'), ('200', 'st200'), ('300', 'st300'), ('400', 'st400'))))
S.to_csv(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'scratch', 'ovn_orderflow_20261104', 'rows_regime.csv'), index=False)
