"""C1 (docs/TELL_LIVE_GAP_C1_PREREG_20261110.md): why is the live tell model book (amt_tell_trades V1 split) far below its explore history?
S1 day-blocked luck test (counted), S2 scale, S4 session / direction / day concentration, S5 continuation proxy (uncounted). S3 (time placebo) is a separate stage. Usage: python3 scripts/tell_context/c1_gap.py"""
import os, csv, collections
import numpy as np, pandas as pd
R = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')); S = os.path.join(R, 'scratch')
ex = pd.read_csv(os.path.join(S, 'unified_exit_lock_20261110', 'tell_pairs.csv'))
fl = pd.read_csv(os.path.join(S, 'tell_context_20261103', 'tell_floor_target_rows.csv'))[['date', 'ei', 'v1_mfe']]
ex = ex.merge(fl, on=['date', 'ei'], how='left'); ex = ex[ex.adr20.notna()].copy(); ex['net'] = ex['base_net']
lv = pd.read_csv(os.path.join(S, 'tell_live_gap_c1_live_book_20261110.csv')); rg = pd.read_csv(os.path.join(S, 'tell_live_gap_c1_rth_ranges_20261110.csv'))
lv['adr20'] = [float(np.mean(rg[rg.d < d].rng.tail(20))) for d in lv.d]
print(f'EXPLORE {len(ex)} trades on {ex.date.nunique()} days, mean {ex.net.mean():+.2f} $/trade, win rate {np.mean(ex.net > 0):.1%}')
print(f'LIVE BOOK {len(lv)} closed model trades on {lv.d.nunique()} dates ({lv.d.min()}..{lv.d.max()}), mean {lv.net.mean():+.2f} $/trade, sum {lv.net.sum():+.0f}, win rate {np.mean(lv.net > 0):.1%}')
print('explore mean by year:', {y: round(float(g.net.mean()), 2) for y, g in ex.groupby(ex.date.str[:4])})
# ---- S1
K = lv.d.nunique(); days = {d: g.net.values for d, g in ex.groupby('date')}; keys = list(days); rng = np.random.default_rng(20261110); B = 20000
pm = np.empty(B); dm = np.empty(B)
for b in range(B):
    pick = rng.integers(0, len(keys), K); v = np.concatenate([days[keys[i]] for i in pick]); pm[b] = v.mean(); dm[b] = np.mean([days[keys[i]].mean() for i in pick])
lm = lv.net.mean(); ldm = lv.groupby('d').net.mean().mean()
print(f'\nS1 DAY-BLOCKED LUCK TEST ({K} explore days per draw, {B} draws): pooled mean per trade 5th/50th/95th pct {np.percentile(pm, 5):+.1f} / {np.percentile(pm, 50):+.1f} / {np.percentile(pm, 95):+.1f}; live {lm:+.2f} sits at percentile {np.mean(pm <= lm):.4f}')
print(f'   per-day-mean statistic: explore 5th/50th/95th {np.percentile(dm, 5):+.1f} / {np.percentile(dm, 50):+.1f} / {np.percentile(dm, 95):+.1f}; live {ldm:+.2f} at percentile {np.mean(dm <= ldm):.4f}')
# ---- S2
ex['risk_adr'] = ex.risk_pts / ex.adr20; lv['risk_adr'] = lv.risk / lv.adr20; ex['mfe_adr'] = ex.v1_mfe / ex.adr20; lv['mfe_adr'] = lv.mfe / lv.adr20
ex['net_adr'] = ex.net / 2.0 / ex.adr20; lv['net_adr'] = lv.net / 2.0 / lv.adr20
def row(nm, a, b, f='{:.3f}'): print(f'   {nm:34s} explore {f.format(a)}   live {f.format(b)}')
print('\nS2 SCALE (medians unless stated; ADR20 = mean prior-20 RTH range):')
row('ADR20 (points)', ex.adr20.median(), lv.adr20.median(), '{:.1f}'); row('stop distance (points)', ex.risk_pts.median(), lv.risk.median(), '{:.1f}'); row('stop distance / ADR20', ex.risk_adr.median(), lv.risk_adr.median())
row('MFE / ADR20 (median)', ex.mfe_adr.median(), lv.mfe_adr.median()); row('MFE / ADR20 (mean)', ex.mfe_adr.mean(), lv.mfe_adr.mean()); row('net / (2 x ADR20) (mean)', ex.net_adr.mean(), lv.net_adr.mean(), '{:+.4f}')
row('trades per active day', len(ex) / ex.date.nunique(), len(lv) / lv.d.nunique(), '{:.1f}')
print('   exit reasons explore:', dict(collections.Counter(ex.base_why)), ' live:', dict(collections.Counter(lv.exit_reason)))
# ---- S4 / S5
lv['t'] = pd.to_datetime(lv.ea).dt.hour * 60 + pd.to_datetime(lv.ea).dt.minute; lv['rth'] = (lv.t >= 570) & (lv.t < 960)
print('\nS4 SESSION / DIRECTION / DAYS (live book):')
for nm, g in (('RTH', lv[lv.rth]), ('Globex', lv[~lv.rth]), ('long', lv[lv.direction == 1]), ('short', lv[lv.direction == -1])): print(f'   {nm:7s} N {len(g):3d} mean {g.net.mean() if len(g) else float("nan"):+8.2f} $/trade, win rate {np.mean(g.net > 0) if len(g) else float("nan"):.0%}')
bd = lv.groupby('d').net.sum().sort_values(); print('   day totals ($):', {d: round(float(v)) for d, v in bd.items()}); print(f'   worst 2 days = {bd.iloc[:2].sum():+.0f} of {bd.sum():+.0f}; mean per trade without them {lv[~lv.d.isin(bd.index[:2])].net.mean():+.2f}')
print('\nS5 CONTINUATION PROXY (MFE in points, V1 managed, mean / share reaching 0.15 ADR20):')
row('mean MFE points', ex.v1_mfe.mean(), lv.mfe.mean(), '{:.1f}'); row('share MFE >= 0.15 ADR20', np.mean(ex.mfe_adr >= 0.15), np.mean(lv.mfe_adr >= 0.15), '{:.1%}'); row('share MFE >= 0.35 ADR20', np.mean(ex.mfe_adr >= 0.35), np.mean(lv.mfe_adr >= 0.35), '{:.1%}')
