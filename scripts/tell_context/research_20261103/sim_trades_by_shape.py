"""Real sim trades vs the shape of the day they happened on. Pre-registration: docs/SIM_TRADES_BY_DAY_SHAPE_PREREG_20261103.md (the user lifted co-002 for THIS analysis). Descriptive, hindsight (final profile), tiny effective N.
Inputs: scratch/sim_trades_20261103/{trades.json,bars_1m.json} (export_sim_trades_20261103.mjs), scratch/volbars500_holdout_20261103 (exact profiles through 2026-10-19). Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/sim_trades_by_shape.py"""
import os, sys, json, collections
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context')); import profile_shape as PS
from block_stats import bootmean
RTH0, RTH1 = 55800.0, 79200.0; HOLD = os.path.join(REPO, 'scratch', 'volbars500_holdout_20261103'); CUT = 0.365; Q90, Q25 = 0.61, 0.09; rng = np.random.default_rng(53)
TR = json.load(open(os.path.join(REPO, 'scratch', 'sim_trades_20261103', 'trades.json'))); B1 = json.load(open(os.path.join(REPO, 'scratch', 'sim_trades_20261103', 'bars_1m.json')))
def exact(d):
    p = f'{HOLD}/{d}.bars.tsv'
    if not os.path.exists(p): return None
    b = np.loadtxt(p, delimiter='\t', ndmin=2); v = np.loadtxt(p.replace('.bars.', '.vap.'), delimiter='\t', ndmin=2); ir = b[(b[:, 2] >= RTH0) & (b[:, 2] < RTH1), 0].astype(int); m = np.isin(v[:, 0].astype(int), ir)
    return PS.features(v[m, 1], v[m, 2])
def spread(d):
    px, vol = [], []
    for x in B1[d]:
        g = np.arange(x['l'], x['h'] + 0.125, 0.25); px.extend(g.tolist()); vol.extend([x['v'] / len(g)] * len(g))
    return PS.features(px, vol)
SH = {}; agree = []
for d in sorted(set(t['trade_date'] for t in TR)):
    e = exact(d) if os.path.exists(f'{HOLD}/{d}.bars.tsv') else None; s = spread(d) if len(B1.get(d, [])) > 100 else None; f = e or s
    if e and s: agree.append((d, PS.letter(e['va_mid']), PS.letter(s['va_mid']), e['va_mid'], s['va_mid']))
    if f: SH[d] = dict(f=f, src='exact' if e else 'spread', letter=PS.letter(f['va_mid']), bim=f['bimod'], multi=f['bimod'] >= CUT)
print(f'{len(TR)} real sim broker rows; day shapes for {len(SH)} of {len(set(t["trade_date"] for t in TR))} trade dates (exact {sum(v["src"]=="exact" for v in SH.values())}, 1-minute spread {sum(v["src"]=="spread" for v in SH.values())})')
if agree: print(f'O6 shape source check on {len(agree)} dates with both: letters agree {sum(a[1]==a[2] for a in agree)}/{len(agree)}; midpoint correlation {np.corrcoef([a[3] for a in agree],[a[4] for a in agree])[0,1]:+.2f}; ' + '; '.join(f'{a[0][5:]} {a[1]}/{a[2]}' for a in agree if a[1] != a[2]))
rows = []
for t in TR:
    d = t['trade_date']; sh = SH.get(d)
    if not sh: continue
    f = sh['f']; ext = f['hi'] - f['lo']; ep = t['entry_fill'] if t['entry_fill'] is not None else t['entry_price']; dr = 1 if 'LONG' in t['setup_type'] else (-1 if 'SHORT' in t['setup_type'] else 0)
    pos = (ep - f['lo']) / ext; mid = f['lo'] + f['va_mid'] * ext; val, vah = f['lo'] + f['val'] * ext, f['lo'] + f['vah'] * ext
    rows.append(dict(id=t['id'], date=d, setup=t['setup_type'], dir=dr, hhmm=t['fired_at'][11:16], rth=bool(t['is_rth']), pnl=t['broker_pnl'], prim=bool(t['is_cluster_primary']), basis=bool(t['basis_flag']), letter=sh['letter'], multi=sh['multi'], bim=sh['bim'], src=sh['src'],
                     loc3='lower' if pos < 1 / 3 else ('upper' if pos > 2 / 3 else 'middle'), vaPos='below VAL' if ep < val else ('above VAH' if ep > vah else 'inside VA'), toward=('toward value' if (dr == 1 and ep < mid) or (dr == -1 and ep > mid) else 'away from value') if dr else 'n/a',
                     fam='tell' if t['setup_type'].startswith('AMT_TELL') else ('level fade' if '_FADE_' in t['setup_type'] else 'other')))
import pandas as pd
R = pd.DataFrame(rows); early = R[R.date <= '2026-09-29']; P = R[R.prim & ~R.basis & (R.date > '2026-09-29')].copy()
print(f'PRIMARY population: {len(P)} trades on {P.date.nunique()} days (cluster-primary, no basis flag, trade date after 2026-09-29); not in it: {len(R)-len(P)} rows = {len(early)} on 2026-09-28/29 (P&L {", ".join(f"{x:+.0f}" for x in early.pnl)}), {int((~R.prim).sum())} cluster siblings, {int(R.basis.sum())} basis-flagged')
def cm(df, col='pnl'):
    x = df[col].values
    if len(x) == 0: return 'N=0'
    c = bootmean(x, df.date.values, rng); return f'N={len(x):3d} days={df.date.nunique():2d} sum {x.sum():+8.0f} mean {x.mean():+7.1f} CI [{c[0]:+.0f}, {c[1]:+.0f}]' + ('  (N<20: not a result)' if len(x) < 20 else '')
print('\nO5 per day (primary): date, trades, P&L, letter, bimodality, source')
for d, g in P.groupby('date'): print(f'  {d} n={len(g):3d} P&L {g.pnl.sum():+8.0f}  {SH[d]["letter"]}  bim {SH[d]["bim"]:.2f}  {SH[d]["src"]}')
print('\nO2 by final letter / multi-hump')
for name, g0 in (('ALL', P), ('RTH only', P[P.rth]), ('tell only', P[P.fam == 'tell']), ('level fades only', P[P.fam == 'level fade']), ('other', P[P.fam == 'other'])):
    print(f' [{name}]')
    for lt in 'DPb': print(f'   letter {lt}: {cm(g0[g0.letter == lt])}')
    for mh, lab in ((True, 'multi-hump'), (False, 'not multi-hump')): print(f'   {lab:14s}: {cm(g0[g0.multi == mh])}')
print('\nO3 enrichment (all primary trades): share of the top-decile winners / bottom-decile losers vs all trades, by letter and multi-hump')
hi, lo = np.quantile(P.pnl, .9), np.quantile(P.pnl, .1); W, L = P[P.pnl >= hi], P[P.pnl <= lo]; print(f'  winners (P&L >= {hi:.0f}) N={len(W)} on {W.date.nunique()} days; losers (P&L <= {lo:.0f}) N={len(L)} on {L.date.nunique()} days')
for lt in 'DPb': print(f'  letter {lt}: all {100*(P.letter==lt).mean():3.0f}%   winners {100*(W.letter==lt).mean():3.0f}%   losers {100*(L.letter==lt).mean():3.0f}%')
print(f'  multi-hump: all {100*P.multi.mean():.0f}%   winners {100*W.multi.mean():.0f}%   losers {100*L.multi.mean():.0f}%')
print('\nO4 entry location x direction')
for k in ('toward value', 'away from value'): print(f'  {k:16s}: {cm(P[P.toward == k])}')
for k in ('lower', 'middle', 'upper'): print(f'  entry in {k:6s} third of the day range: {cm(P[P.loc3 == k])}')
for k in ('below VAL', 'inside VA', 'above VAH'): print(f'  entry {k:10s}: {cm(P[P.vaPos == k])}')
print('\nO1 biggest winners and losers (primary)')
for lab, g in (('WINNERS', P.sort_values('pnl', ascending=False).head(12)), ('LOSERS', P.sort_values('pnl').head(12))):
    print(f' {lab}'); [print(f'  {r.date} {r.hhmm} {r.setup:36s} {r.pnl:+8.0f}  day {r.letter}{" multi-hump" if r.multi else ""}  entry in {r.loc3} third, {r.vaPos}, {r.toward}') for r in g.itertuples()]
print('\nSetup types with N>=20:', ', '.join(f'{k} {n}' for k, n in P.setup.value_counts().items() if n >= 20) or 'none')
s = P.groupby('setup').pnl.agg(['count', 'sum']).sort_values('count', ascending=False).head(8); print('largest setup types (N, total):', '; '.join(f'{i} {int(r["count"])} {r["sum"]:+.0f}' for i, r in s.iterrows()))
P.to_csv(os.path.join(REPO, 'scratch', 'sim_trades_20261103', 'rows_with_shape.csv'), index=False)
