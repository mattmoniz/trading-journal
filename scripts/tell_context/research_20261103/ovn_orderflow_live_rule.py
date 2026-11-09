"""Addendum A6 of docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md: replicate the LIVE detector's rule (close-only legs >= 7, entry at the 00:00 close) and compare with the research rule. Usage: venv/bin/python scripts/tell_context/research_20261103/ovn_orderflow_live_rule.py"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ovn_sim import sim, load_days, SLIP
from block_stats import bootmean
DAY = load_days(); rng = np.random.default_rng(239); dates = sorted(DAY)
rows = []
for i, dte in enumerate(dates):
    x = DAY[dte]; net = x['ask'] - x['bid']; tot = x['ask'] + x['bid']
    if tot <= 0 or net == 0: continue
    d = 1 if net > 0 else -1; m = np.array(x['m']); j0 = int(np.argmax(m >= 0)); xs = {k: x[k][j0:] for k in ('m', 'o', 'h', 'l', 'c')}
    en_open = xs['o'][0] + d * SLIP; en_close = xs['c'][0] + d * SLIP                                    # research entry (00:00 open) vs the live entry (the first window bar's close)
    # the live rule enters at the close of the 00:00 bar; the simulation then starts from the NEXT bar
    xs2 = {k: v[1:] for k, v in xs.items()}
    rows.append(dict(d=dte, dir=d, legs_hl=x['legs'], legs_c=x['legs_close'], research=sim(xs, d, en_open, 400, 870)[0], live=sim(xs2, d, en_close, 400, 870)[0], L=sim(xs2, 1, xs['c'][0] + SLIP, 400, 870)[0], S=sim(xs2, -1, xs['c'][0] - SLIP, 400, 870)[0]))
R = pd.DataFrame(rows); R['yr'] = R.d.str[:4]; R['q_hl6'] = R.legs_hl >= 6; R['q_c7'] = R.legs_c >= 7; R['q_c6'] = R.legs_c >= 6
print(f'{len(R)} nights; qualifying under: research rule (high/low legs >= 6) {int(R.q_hl6.sum())}; LIVE rule (close-only legs >= 7) {int(R.q_c7.sum())}; close-only >= 6 {int(R.q_c6.sum())}; overlap research and live {int((R.q_hl6 & R.q_c7).sum())}')
print('qualifying nights by year  (research | live): ' + ', '.join(f'{y} {int(g.q_hl6.sum())} | {int(g.q_c7.sum())}' for y, g in R.groupby('yr')))
L = R[R.q_c7]; c = bootmean(L.live.values, L.d.values, rng, B=2000); P = np.array([np.where(rng.random(len(L)) < .5, L.L, L.S).mean() for _ in range(4000)])
print(f'\nT1 LIVE RULE (close-only legs >= 7, entry at the 00:00 close, stop 400, exit 14:30): N={len(L)} mean {L.live.mean():+.1f} dollars CI [{c[0]:+.0f}, {c[1]:+.0f}]  win {100*(L.live>0).mean():.0f}%  worst {L.live.min():+.0f} | random-direction placebo {P.mean():+.1f} (sd {P.std():.1f}); observed above {100*(P < L.live.mean()).mean():.1f}% of draws')
print('   by year: ' + ', '.join(f'{y} N={len(g)} mean {g.live.mean():+.0f}' for y, g in L.groupby('yr')))
H = R[R.q_hl6]; print(f'   comparison: the research rule on its own nights (N={len(H)}): mean {H.research.mean():+.1f}')
print('\nT2 REPLICATION since the detector began (2026-09-21): live-rule qualifying nights vs the two shadow rows written (2026-10-26 SHORT, 2026-11-04 SHORT, not in this export if after 11-03)')
for _, r in R[(R.d >= '2026-09-21') & (R.q_c7 | R.q_hl6)].iterrows(): print(f'  {r.d}  legs high/low {int(r.legs_hl):2d}  legs close-only {int(r.legs_c):2d}  live rule qualifies: {bool(r.q_c7)}  research rule qualifies: {bool(r.q_hl6)}  direction {"LONG" if r.dir == 1 else "SHORT"}')
print('\nclose-only legs >= 6 variant (a cut between): N=' + f'{int(R.q_c6.sum())} mean {R[R.q_c6].live.mean():+.1f}')
R.to_csv(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'scratch', 'ovn_orderflow_20261104', 'rows_live_rule.csv'), index=False)
