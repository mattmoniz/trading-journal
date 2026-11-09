"""Variations of OVERNIGHT_ORDERFLOW against its four weaknesses (docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md). Usage: venv/bin/python scripts/tell_context/research_20261103/ovn_orderflow_variations.py"""
import os, sys, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from block_stats import bootmean, bootdiff
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); DAY = json.load(open(os.path.join(REPO, 'scratch', 'ovn_orderflow_20261104', 'days.json'))); rng = np.random.default_rng(173)
dates = sorted(DAY); rngs = {}
for d in dates:
    x = DAY[d]; m = np.array(x['m']); k = (m >= 570) & (m < 960)
    rngs[d] = float(np.max(np.array(x['h'])[k]) - np.min(np.array(x['l'])[k])) if k.sum() > 300 else np.nan
from ovn_sim import sim, SLIP, DPP, COMM
rows = []
for i, dte in enumerate(dates):
    x = DAY[dte]; prior = [rngs[p] for p in dates[max(0, i - 20):i] if np.isfinite(rngs[p])]
    if len(prior) < 15 or x['legs'] < 6: continue
    net = x['ask'] - x['bid']; tot = x['ask'] + x['bid']
    if tot <= 0 or net == 0: continue
    adr = float(np.median(prior)); d = 1 if net > 0 else -1; m = np.array(x['m']); j0 = int(np.argmax(m >= 0)); entry = x['o'][j0] + d * SLIP
    r = dict(d=dte, dir=d, flow=abs(net) / tot, chase=d * (x['c_pre'] - x['open18']) / adr, legs=x['legs'], adr=adr, pos=(x['c_pre'] - x['lo_pre']) / max(x['hi_pre'] - x['lo_pre'], 1e-9))
    k = (m >= 570) & (m < 960); r['rth_dir'] = float(np.sign(x['c'][np.where(k)[0][-1]] - x['o'][np.where(k)[0][0]])); r['hit'] = float(r['rth_dir'] == d)
    for sp in (100, 150, 200, 300, 400, 700, np.inf):
        for em in (570, 720, 870, 955): n_, w_ = sim(x, d, entry, sp, em); r[f's{sp}_e{em}'] = n_
        r[f'why{sp}'] = sim(x, d, entry, sp, 870)[1]
    rows.append(r)
R = pd.DataFrame(rows); R['yr'] = R.d.str[:4]; half = R.d.sort_values().iloc[len(R) // 2]; R['half'] = np.where(R.d < half, 1, 2)
print(f'{len(dates)} dates; {len(R)} qualifying nights (>= 6 rotation legs by midnight and a non-zero 18:00-21:00 flow); by year: ' + ', '.join(f'{y} {int(n)}' for y, n in R.yr.value_counts().sort_index().items()) + f'; split at {half}')
B = R['s400_e870']; c = bootmean(B.values, R.d.values, rng, B=2000)
print(f'\nBASELINE B0 (400-point stop, exit 14:30): N={len(R)}  mean {B.mean():+.1f} dollars/trade CI [{c[0]:+.0f}, {c[1]:+.0f}]  win rate {100*(B>0).mean():.0f}%  median {B.median():+.0f}  worst {B.min():+.0f}  stopped {100*(R.why400.isin(["STOP","STOP_GAP"])).mean():.0f}%  | flow sign predicted the RTH direction {100*R.hit.mean():.0f}% of nights')
L = R[R.d >= '2025-11-20']; print(f'  the live calibration window (from 2025-11-20): N={len(L)} mean {L["s400_e870"].mean():+.1f} win rate {100*(L["s400_e870"]>0).mean():.0f}% hit {100*L.hit.mean():.0f}%   | before: N={len(R)-len(L)} mean {R[R.d < "2025-11-20"]["s400_e870"].mean():+.1f}')
print('  flow lean at the weak trade-like cases: median |flow share| ' + f'{100*R.flow.median():.1f}%, chase median {R.chase.median():+.2f} ADR, legs median {R.legs.median():.0f}')
# expanding cuts from earlier qualifying nights only
cut = lambda col, q, i: np.quantile(R[col].values[:i], q) if i >= 10 else np.nan
R['F1'] = [bool(R.flow.values[i] >= cut('flow', .5, i)) if i >= 10 else np.nan for i in range(len(R))]; R['F2'] = [bool(R.chase.values[i] <= cut('chase', 2 / 3, i)) if i >= 10 else np.nan for i in range(len(R))]; R['F3'] = [bool(R.legs.values[i] <= cut('legs', 2 / 3, i)) if i >= 10 else np.nan for i in range(len(R))]
R['F12'] = R.F1 & R.F2; R['F123'] = R.F1 & R.F2 & R.F3; V = R.iloc[10:].copy()
print(f'\nVARIATIONS (cuts from earlier nights only; the first 10 nights have no cut: {len(V)} scored): mean dollars per trade retained vs dropped, N, win rate, worst; contrast with the day-block CI; halves')
def contrast(name, col, counted):
    a, b = V[V[col].astype(bool)], V[~V[col].astype(bool)]
    if len(a) < 10 or len(b) < 10: print(f'  {name}: too few'); return
    cd = bootdiff(a['s400_e870'].values, a.d.values, b['s400_e870'].values, b.d.values, rng); h = [a[a.half == k]['s400_e870'].mean() - b[b.half == k]['s400_e870'].mean() for k in (1, 2)]
    print(f'  {name:34s} kept N={len(a):3d} mean {a["s400_e870"].mean():+7.1f} win {100*(a["s400_e870"]>0).mean():3.0f}% worst {a["s400_e870"].min():+6.0f} | dropped N={len(b):3d} mean {b["s400_e870"].mean():+7.1f} win {100*(b["s400_e870"]>0).mean():3.0f}% | kept minus dropped {a["s400_e870"].mean() - b["s400_e870"].mean():+6.1f} CI [{cd[0]:+.0f}, {cd[1]:+.0f}] halves {h[0]:+.0f}/{h[1]:+.0f}' + (('  -> LEAD' if (cd[0] > 0 and min(h) > 0) else '  -> not shown') if counted else '  (uncounted)'))
contrast('T1 F1 strong flow lean (>= median)', 'F1', True); contrast('T2 F2 not chased (<= 67th pct)', 'F2', True); contrast('T3 F3 not choppy (legs <= 67th pct)', 'F3', True); contrast('F12 = F1 and F2', 'F12', False); contrast('F123 = all three', 'F123', False)
print('\nW4 RISK: stop sweep on the baseline set (exit 14:30): mean dollars, win rate, worst loss, share stopped')
for sp in (100, 150, 200, 300, 400, 700, np.inf):
    x = R[f's{sp}_e870']; why = R[f'why{sp}']; print(f'  stop {("none" if np.isinf(sp) else int(sp)):>5} pts ({"-" if np.isinf(sp) else int(sp*2)} dollars risk): mean {x.mean():+7.1f}  win {100*(x>0).mean():3.0f}%  worst {x.min():+7.0f}  stopped {100*why.isin(["STOP","STOP_GAP"]).mean():3.0f}%')
d4 = (R['s150_e870'] - R['s400_e870']); c4 = bootmean(d4.values, R.d.values, rng, B=2000); print(f'  T4 150-point stop minus 400-point stop: {d4.mean():+.1f} dollars/trade CI [{c4[0]:+.1f}, {c4[1]:+.1f}] (the price of cutting the risk from 800 to 300 dollars)')
print('\nEXIT TIME sweep (stop 400): mean dollars at exit 09:30 / 12:00 / 14:30 / 15:55: ' + ' / '.join(f'{R[f"s400_e{e}"].mean():+.1f}' for e in (570, 720, 870, 955)))
print('\nSUBSETS on their own (baseline stop 400, exit 14:30):')
for lab, m in (('weak lean (|flow| < 5%)', R.flow < 0.05), ('strong lean (>= 5%)', R.flow >= 0.05), ('chased > 1.0 ADR in the trade direction', R.chase > 1.0), ('not chased (<= 1.0 ADR)', R.chase <= 1.0), ('legs > 30', R.legs > 30), ('legs 6-30', R.legs <= 30)):
    g = R[m]; print(f'  {lab:40s} N={len(g):3d} mean {g["s400_e870"].mean():+7.1f}  win {100*(g["s400_e870"]>0).mean():3.0f}%  RTH direction hit {100*g.hit.mean():3.0f}%' + ('  (N<20)' if len(g) < 20 else ''))
R.to_csv(os.path.join(REPO, 'scratch', 'ovn_orderflow_20261104', 'rows.csv'), index=False)
