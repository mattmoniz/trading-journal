"""Addendum A5 of docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md: development map of candidate forward arms. Descriptive; counts no test. Usage: venv/bin/python scripts/tell_context/research_20261103/ovn_orderflow_arms.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ovn_sim import sim, load_days, SLIP
from block_stats import bootmean
DAY = load_days(); rng = np.random.default_rng(229); dates = sorted(DAY); rr = {}
for d in dates:
    x = DAY[d]; m = np.array(x['m']); k = (m >= 570) & (m < 960); rr[d] = float(np.max(np.array(x['h'])[k]) - np.min(np.array(x['l'])[k])) if k.sum() > 300 else np.nan
def sliced(x, j0): return {k: x[k][j0:] for k in ('m', 'o', 'h', 'l', 'c')}
rows = []
for i, dte in enumerate(dates):
    x = DAY[dte]; prior = [rr[p] for p in dates[max(0, i - 20):i] if np.isfinite(rr[p])]
    if len(prior) < 15 or x['legs'] < 6: continue
    net = x['ask'] - x['bid']
    if net == 0: continue
    adr = float(np.median(prior)); d = 1 if net > 0 else -1; m = np.array(x['m']); r = dict(d=dte, adr=adr)
    def arm(name, start_m, stop_pts):
        j0 = int(np.argmax(m >= start_m)); xs = sliced(x, j0); en = xs['o'][0] + d * SLIP; n_, why = sim(xs, d, en, stop_pts, 870); r[name] = n_; r[name + '_why'] = why
    arm('base', 0, 400)
    for sm in (120, 240, 480): arm(f'delay{sm // 60}h', sm, 400)
    for stp in (250, 300): arm(f'fix{stp}', 0, stp)
    for c in (0.6, 0.8, 1.0, 1.2): arm(f'adr{c}', 0, c * adr)
    rows.append(r)
R = pd.DataFrame(rows); print(f'{len(R)} legs >= 6 nights; median ADR {R.adr.median():.0f} pts (400 points = {400/R.adr.median():.2f} ADR)')
arms = [('base', 'baseline 00:00, stop 400'), ('fix300', 'stop 300'), ('fix250', 'stop 250'), ('adr0.6', 'stop 0.6 x ADR'), ('adr0.8', 'stop 0.8 x ADR'), ('adr1.0', 'stop 1.0 x ADR'), ('adr1.2', 'stop 1.2 x ADR'), ('delay2h', 'enter 02:00, stop 400'), ('delay4h', 'enter 04:00, stop 400'), ('delay8h', 'enter 08:00, stop 400')]
def table(sub, title):
    print(f'\n{title} (N={len(sub)}): mean dollars/trade [day-block CI], win, worst, stopped')
    for key, lab in arms:
        x = sub[key]; c = bootmean(x.values, sub.d.values, rng, B=800) if len(sub) >= 20 else (np.nan, np.nan); print(f'  {lab:26s} {x.mean():+7.1f} [{c[0]:+.0f}, {c[1]:+.0f}]  win {100*(x>0).mean():3.0f}%  worst {x.min():+7.0f}  stopped {100*sub[key + "_why"].isin(["STOP", "STOP_GAP"]).mean():3.0f}%')
table(R, 'ALL qualifying nights'); table(R[R.d >= '2025-11-20'], 'FROM 2025-11-20 (the live calibration window)'); table(R[R.d < '2025-11-20'], 'BEFORE 2025-11-20')
b = R.base.mean(); se = bootmean(R.base.values, R.d.values, rng, B=1000); print(f'\nFORWARD-RACE QUALIFIERS (mean within 25% of the baseline {b:+.0f}, and a smaller worst loss, or a mean above it by more than the SE):')
for key, lab in arms[1:]:
    x = R[key]; q = (x.mean() >= 0.75 * b and x.min() > R.base.min()) or (x.mean() > b + (se[1] - se[0]) / 3.92)
    print(f'  {lab:26s} mean {x.mean():+7.1f} worst {x.min():+7.0f} -> ' + ('QUALIFIES' if q else 'no'))
