"""All ACTIVE+SHADOW fires since 2026-07-09 by setup, time of day and the shape of the day. Pre-registration: docs/SHADOW_FIRES_BY_DAY_TYPE_PREREG_20261103.md. Descriptive, hindsight (final RTH profile), informative.
Inputs: scratch/shadow_fires_20261103/{fires.json,bars_1m.json} (export_shadow_fires_20261103.mjs), scratch/volbars500_holdout_20261103. Outputs: printed tables, reports/shadow_fires_by_day_type_20261103.csv.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/shadow_fires_by_day_type.py"""
import os, sys, json, re, datetime, collections
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context')); import profile_shape as PS
from block_stats import bootmean
RTH0, RTH1 = 55800.0, 79200.0; HOLD = os.path.join(REPO, 'scratch', 'volbars500_holdout_20261103'); CUT = 0.365; rng = np.random.default_rng(61)
FI = json.load(open(os.path.join(REPO, 'scratch', 'shadow_fires_20261103', 'fires.json'))); BARS = json.load(open(os.path.join(REPO, 'scratch', 'shadow_fires_20261103', 'bars_1m.json')))
def shape_of(d):
    p = f'{HOLD}/{d}.bars.tsv'
    if os.path.exists(p):
        b = np.loadtxt(p, delimiter='\t', ndmin=2); v = np.loadtxt(p.replace('.bars.', '.vap.'), delimiter='\t', ndmin=2); ir = b[(b[:, 2] >= RTH0) & (b[:, 2] < RTH1), 0].astype(int)
        if len(ir) < 100: return None
        return PS.features(v[np.isin(v[:, 0].astype(int), ir), 1], v[np.isin(v[:, 0].astype(int), ir), 2])
    if len(BARS.get(d, [])) > 300:
        px, vol = [], []
        for x in BARS[d]: g = np.arange(x['l'], x['h'] + 0.125, 0.25); px.extend(g.tolist()); vol.extend([x['v'] / len(g)] * len(g))
        return PS.features(px, vol)
    return None
def tdate(fired):                                                               # fired_at is a naive ET timestamp (labelled Z): 18:00 or later belongs to the next calendar date's session
    d = datetime.date.fromisoformat(fired[:10]); return str(d + datetime.timedelta(days=1)) if int(fired[11:13]) >= 18 else str(d)
def tblock(hhmm, rth):
    m = int(hhmm[:2]) * 60 + int(hhmm[3:5])
    if 570 <= m < 960: return 'RTH 09:30-10:30' if m < 630 else ('RTH 10:30-12:00' if m < 720 else ('RTH 12:00-14:00' if m < 840 else 'RTH 14:00-16:00'))
    return 'GLX 18:00-00:00' if m >= 1080 else ('GLX 00:00-03:00' if m < 180 else ('GLX 03:00-08:00' if m < 480 else ('GLX 08:00-09:30' if m < 570 else 'other 16:00-18:00')))
D = pd.DataFrame(FI); D['td'] = D.fired_at.map(tdate); D['hhmm'] = D.fired_at.str[11:16]; D['tb'] = [tblock(h, r) for h, r in zip(D.hhmm, D.is_rth)]
D['family'] = D.setup_type.str.replace(r'(_OVERNIGHT)$', '', regex=True).str.replace(r'_(LONG|SHORT)$', '', regex=True); D['dir'] = np.where(D.setup_type.str.contains('LONG'), 'L', np.where(D.setup_type.str.contains('SHORT'), 'S', '?'))
n0 = len(D); flood = (D.fired_at >= '2026-07-09') & (D.fired_at < '2026-09-17') & (D.tb == 'other 16:00-18:00')
SH = {d: shape_of(d) for d in sorted(set(D.td))}; SH = {d: f for d, f in SH.items() if f}
D['letter'] = [PS.letter(SH[d]['va_mid']) if d in SH else None for d in D.td]; D['bim'] = [SH[d]['bimod'] if d in SH else np.nan for d in D.td]; D['multi'] = D.bim >= CUT
D['daytype'] = np.where(D.letter.isna(), 'unknown', D.letter + np.where(D.multi, ' multi', ''))
keep = D.pnl.notna() & ~D.basis_flag & ~flood & D.letter.notna(); X = D[keep].copy()
print(f'{n0} fires; no pnl (not filled / unresolved) {int(D.pnl.isna().sum())}; basis-flagged {int((D.basis_flag & D.pnl.notna()).sum())}; post-close flood {int(flood.sum())}; no RTH shape yet (tonight {int((D.letter.isna() & D.pnl.notna()).sum())}) -> {len(X)} fires with pnl and a day type on {X.td.nunique()} days; declustered (primary lens) {int(X.is_cluster_primary.sum())}')
X.to_csv(os.path.join(REPO, 'reports', 'shadow_fires_by_day_type_20261103.csv'), index=False, columns=['id', 'td', 'fired_at', 'tb', 'setup_type', 'family', 'dir', 'origin_status', 'session', 'is_rth', 'is_cluster_primary', 'resolution', 'resolution_method', 'pnl', 'letter', 'multi', 'bim', 'daytype'])
P = X[X.is_cluster_primary].copy(); P['d'] = P.td; half = sorted(set(P.td))[len(set(P.td)) // 2]
def cell(g):
    x = g.pnl.values; c = bootmean(x, g.td.values, rng, B=1000) if len(x) >= 20 else (np.nan, np.nan); h1, h2 = g[g.td < half].pnl, g[g.td >= half].pnl
    return dict(N=len(x), days=g.td.nunique(), mean=x.mean(), win=100 * (x > 0).mean(), lo=c[0], hi=c[1], h1=h1.mean() if len(h1) else np.nan, h2=h2.mean() if len(h2) else np.nan)
def fmt(c): return f'N={c["N"]:5d} days={c["days"]:3d} mean {c["mean"]:+7.1f} win {c["win"]:3.0f}% CI [{c["lo"]:+.0f}, {c["hi"]:+.0f}]  halves {c["h1"]:+.0f}/{c["h2"]:+.0f}'
days = X.groupby('td').daytype.first(); print('\nDAY TYPES in the sample (days):', days.value_counts().to_dict(), f'(split-half date: {half})')
print('\nO1 by day type (declustered lens)')
for k in sorted(P.daytype.unique()): print(f'  {k:8s} {fmt(cell(P[P.daytype == k]))}')
print(f'  ALL      {fmt(cell(P))}')
print('\nO1b same, ALL fires (clusters included)')
for k in sorted(X.daytype.unique()): print(f'  {k:8s} N={int((X.daytype == k).sum()):5d} mean {X[X.daytype == k].pnl.mean():+7.1f}')
print('\nO2 time block x day type (declustered): mean $/fire (N)')
tbs = sorted(t for t in P.tb.unique() if t != 'other 16:00-18:00'); dts = sorted(P.daytype.unique()); print('  ' + ' ' * 17 + ''.join(f'{d:>14s}' for d in dts) + '          ALL')
for t in tbs:
    print(f'  {t:17s}' + ''.join((lambda g: f'{g.pnl.mean():+7.1f} ({len(g):4d})' if len(g) >= 20 else f'{"-":>7s} ({len(g):4d})')(P[(P.tb == t) & (P.daytype == d)]).rjust(14) for d in dts) + f'  {P[P.tb == t].pnl.mean():+7.1f} ({int((P.tb == t).sum())})')
print('\nO3 setup types overall (N>=20), best and worst 12 by mean')
st = [(s, cell(g)) for s, g in P.groupby('setup_type') if len(g) >= 20]; st.sort(key=lambda t: -t[1]['mean']); print(f'  {len(st)} setup types with N>=20')
for s, c in st[:12]: print(f'  {s:38s} {fmt(c)}')
print('  ...'); [print(f'  {s:38s} {fmt(c)}') for s, c in st[-12:]]
fm = [(s, cell(g)) for s, g in P.groupby('family') if len(g) >= 30]; fm.sort(key=lambda t: -t[1]['mean']); print(f'\nO3b setup FAMILIES (direction and OVERNIGHT stripped, N>=30): {len(fm)}; best 10 / worst 10')
for s, c in fm[:10]: print(f'  {s:34s} {fmt(c)}')
print('  ...'); [print(f'  {s:34s} {fmt(c)}') for s, c in fm[-10:]]
def ranked(col, minN=20, minD=4):
    cells = []
    for (s, dt), g in P.groupby([col, 'daytype']):
        if len(g) >= minN and g.td.nunique() >= minD: cells.append((s, dt, cell(g)))
    return cells
for col, nm in (('family', 'FAMILY'), ('setup_type', 'SETUP TYPE')):
    cells = ranked(col); cells.sort(key=lambda t: -t[2]['mean']); print(f'\nO4 {nm} x day type cells (N>=20 on >=4 days): {len(cells)} cells EXAMINED (the best of this many looks good by luck; "halves" = first/second half of the dates)')
    print('  BEST 12'); [print(f'  {s:34s} {dt:8s} {fmt(c)}' + ('  SAME SIGN BOTH HALVES' if c['h1'] * c['h2'] > 0 and c['h1'] > 0 else '')) for s, dt, c in cells[:12]]
    print('  WORST 12'); [print(f'  {s:34s} {dt:8s} {fmt(c)}' + ('  SAME SIGN BOTH HALVES' if c['h1'] * c['h2'] > 0 and c['h1'] < 0 else '')) for s, dt, c in cells[-12:]]
    if col == 'family': print(f'  cells with a positive mean in BOTH halves: {sum(1 for _, _, c in cells if c["h1"] > 0 and c["h2"] > 0)} of {len(cells)}; negative in both: {sum(1 for _, _, c in cells if c["h1"] < 0 and c["h2"] < 0)}')
print('\nO5 setup family x time block: best 10 cells (N>=20, >=4 days)')
cells = []
for (s, t), g in P[P.tb != 'other 16:00-18:00'].groupby(['family', 'tb']):
    if len(g) >= 20 and g.td.nunique() >= 4: cells.append((s, t, cell(g)))
cells.sort(key=lambda t: -t[2]['mean']); print(f'  {len(cells)} cells examined'); [print(f'  {s:30s} {t:17s} {fmt(c)}') for s, t, c in cells[:10]]
