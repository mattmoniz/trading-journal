"""Tell side as direction context for shadow fires (docs/TELL_AS_DIRECTION_CONTEXT_PREREG_20261104.md). 3 counted tests, day-block bootstrap, other-date placebo, momentum drift control.
Usage: ulimit -v 4000000; venv/bin/python scripts/tell_context/research_20261103/tell_direction_context.py   (look 173 is logged first, hr-023)"""
import os, json, datetime, re
import numpy as np, pandas as pd
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); rng = np.random.default_rng(20261104); B, NPLC = 4000, 1000; CIQ = (0.835, 99.165); T0, T1, LASTS = 57600, 73800, 3600
J = json.load(open(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'shadow_fires_tellctx.json'))); F = pd.DataFrame(J['fires']); bars = J['bars']
F['dir'] = np.where(F.stop_level < (F.ez_lo + F.ez_hi) / 2, 1, -1); sfx = F.setup_type.str.extract(r'_(LONG|SHORT)(?:_OVERNIGHT)?$')[0]; chk = sfx.notna()
print(f'{len(F)} fires on {F.trade_date.nunique()} dates; direction from stop vs entry agrees with the _LONG/_SHORT suffix on {100 * (F.dir[chk] == np.where(sfx[chk] == "LONG", 1, -1)).mean():.1f}% of the {int(chk.sum())} fires that carry a suffix')
F['t'] = [(datetime.datetime.fromisoformat(f) - (datetime.datetime.fromisoformat(d) - datetime.timedelta(days=1)).replace(hour=18, minute=0, second=0)).total_seconds() for f, d in zip(F.fired_at, F.trade_date)]
H = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'watcher_stop_sealed_rows_sealed.csv'), usecols=['date', 'dir', 'end_sec']); H = H[H.date.isin(set(F.trade_date))].sort_values(['date', 'end_sec'])
print(f'{len(H)} tell entries on {H.date.nunique()} of the fire dates')
dates = sorted(F.trade_date.unique()); tells = {d: g[['end_sec', 'dir']].values for d, g in H.groupby('date')}


def side_arr(d, last):
    """Side (+1 / -1 / 0) of the active tell at every second of the decision window of date d: the most recent tell entry at or before the second and no more than `last` seconds earlier (last = None: any earlier tell today)."""
    a = np.zeros(T1 - T0 + 1, int)
    for s, dr in tells.get(d, []):
        lo = max(int(np.ceil(s)), T0); hi = T1 if last is None else min(int(s + last), T1)
        if lo <= T1: a[lo - T0:hi - T0 + 1] = int(dr) if hi >= lo else 0
    return a                                                                       # later tells overwrite earlier ones in time order: the most recent wins


ARR = {w: {d: side_arr(d, w) for d in dates} for w in (LASTS, 1800, None)}
idx = np.clip(np.floor(F.t.values).astype(int) - T0, 0, T1 - T0)
def side_for(w): return np.array([ARR[w][d][i] for d, i in zip(F.trade_date, idx)])
def state(side): return np.where(side == 0, 'NONE', np.where(side == F.dir.values, 'AGREE', 'AGAINST'))
F['side'] = side_for(LASTS); F['st'] = state(F.side.values); F['st30'] = state(side_for(1800)); F['stany'] = state(side_for(None))
mom = []
for d, f in zip(F.trade_date, F.fired_at):
    hm = {b['hm']: b['c'] for b in bars[d]}; m = int(f[11:13]) * 60 + int(f[14:16]); g = lambda k: hm.get('%02d:%02d' % divmod(m - k, 60)); a, b = g(1), g(61)
    mom.append(np.sign(a - b) if a is not None and b is not None else 0)
F['mom'] = mom; F['mst'] = np.where(F.mom == 0, 'NONE', np.where(F.mom == F.dir, 'AGREE', 'AGAINST'))
P = F[F.is_cluster_primary].reset_index(drop=True); half_cut = sorted(P.trade_date.unique())[len(P.trade_date.unique()) // 2]
print(f'\nCOUNTS FIRST (declustered, {len(P)} fires on {P.trade_date.nunique()} dates): ' + ', '.join(f'{k} {int(v)}' for k, v in P.st.value_counts().items()) + f'; all-fires lens: ' + ', '.join(f'{k} {int(v)}' for k, v in F.st.value_counts().items()))
print(f'  days with at least one AGREE / AGAINST fire: {P[P.st == "AGREE"].trade_date.nunique()} / {P[P.st == "AGAINST"].trade_date.nunique()}')


def contrast(df, col, a, b, mask=None):
    x, y = df.pnl.values[(df[col] == a).values], df.pnl.values[(df[col] == b).values]
    return float(x.mean() - y.mean()) if len(x) >= 5 and len(y) >= 5 else np.nan


def boot(df, col, a, b):
    g = list(df.groupby('trade_date').indices.values()); out = np.empty(B)
    for k in range(B):
        p = np.concatenate([g[j] for j in rng.integers(0, len(g), len(g))]); s = df.iloc[p]; x, y = s.pnl.values[(s[col] == a).values], s.pnl.values[(s[col] == b).values]; out[k] = (x.mean() - y.mean()) if len(x) >= 5 and len(y) >= 5 else np.nan
    return np.nanpercentile(out, CIQ), float(np.nanstd(out))


tests = [('T1 AGREE minus AGAINST', 'AGREE', 'AGAINST'), ('T2 AGREE minus NONE', 'AGREE', 'NONE'), ('T3 AGAINST minus NONE', 'AGAINST', 'NONE')]; res = []
for lab, a, b in tests:
    ci, se = boot(P, 'st', a, b); res.append((lab, a, b, ci, se))
print('\nDETECTABLE (2.8 x SE) dollars per fire, printed before the verdicts: ' + '; '.join(f'{r[0][:2]} {2.8 * r[4]:.1f}' for r in res))
tdates = np.array(dates); dir_p = P.dir.values; it = np.clip(np.floor(P.t.values).astype(int) - T0, 0, T1 - T0); pl = []
for _ in range(NPLC):
    d2 = tdates[rng.integers(0, len(tdates), len(P))]; side = np.array([ARR[LASTS][d][i] for d, i in zip(d2, it)]); st = np.where(side == 0, 'NONE', np.where(side == dir_p, 'AGREE', 'AGAINST'))
    x, y = P.pnl.values[st == 'AGREE'], P.pnl.values[st == 'AGAINST']; pl.append(x.mean() - y.mean() if len(x) >= 5 and len(y) >= 5 else np.nan)
p97 = float(np.nanpercentile(np.abs(pl), 97.5)); print(f'PLACEBO (the tell timeline of a random other date, {NPLC} draws): mean {np.nanmean(pl):+.2f}, 97.5th percentile of |contrast| {p97:.2f}')
print('\nCOUNTED TESTS (declustered fires, CI 98.33% day-block):')
for lab, a, b, ci, se in res:
    c = contrast(P, 'st', a, b); h1, h2 = contrast(P[P.trade_date < half_cut], 'st', a, b), contrast(P[P.trade_date >= half_cut], 'st', a, b)
    ok = dict(ci_excludes_0=bool(ci[0] > 0 or ci[1] < 0), halves_same_sign=bool(np.sign(h1) == np.sign(h2) == np.sign(c)))
    if lab.startswith('T1'): ok['placebo_beaten'] = abs(c) > p97
    na, nb = int((P.st == a).sum()), int((P.st == b).sum())
    print(f'  {lab}: {c:+.2f} per fire (N {na} vs {nb}) CI [{ci[0]:+.2f}, {ci[1]:+.2f}] halves {h1:+.2f} / {h2:+.2f}\n      conditions {ok} => ' + ('LEAD' if all(ok.values()) else 'NOT SHOWN'))
print('\nREPORTED (not counted):')
for nm, col in (('momentum side (the drift control)', 'mst'), ('tell side, 30-minute window', 'st30'), ('tell side, any earlier tell today', 'stany')):
    print(f'  {nm}: AGREE minus AGAINST {contrast(P, col, "AGREE", "AGAINST"):+.2f} (N {int((P[col] == "AGREE").sum())} vs {int((P[col] == "AGAINST").sum())}); AGREE minus NONE {contrast(P, col, "AGREE", "NONE"):+.2f}; AGAINST minus NONE {contrast(P, col, "AGAINST", "NONE"):+.2f}')
print('  all-fires lens (tell 60 min): AGREE minus AGAINST ' + f'{contrast(F, "st", "AGREE", "AGAINST"):+.2f} (N {int((F.st == "AGREE").sum())} vs {int((F.st == "AGAINST").sum())})')
for nm, m in (('momentum AGREE', P.mst == 'AGREE'), ('momentum AGAINST', P.mst == 'AGAINST')):
    q = P[m]; print(f'  within {nm}: tell AGREE minus AGAINST {contrast(q, "st", "AGREE", "AGAINST"):+.2f} (N {int((q.st == "AGREE").sum())} vs {int((q.st == "AGAINST").sum())})')
for nm, dv in (('LONG fires', 1), ('SHORT fires', -1)): q = P[P.dir == dv]; print(f'  {nm}: AGREE minus AGAINST {contrast(q, "st", "AGREE", "AGAINST"):+.2f} (N {int((q.st == "AGREE").sum())} vs {int((q.st == "AGAINST").sum())}); mean per fire AGREE {q[q.st == "AGREE"].pnl.mean():+.1f}, AGAINST {q[q.st == "AGAINST"].pnl.mean():+.1f}, NONE {q[q.st == "NONE"].pnl.mean():+.1f}')
P['fam'] = P.setup_type.str.replace(r'_(LONG|SHORT)(_OVERNIGHT)?$', '', regex=True); fam = []
for k, q in P.groupby('fam'):
    a, b = q[q.st == 'AGREE'], q[q.st == 'AGAINST']
    if len(a) >= 30 and len(b) >= 30: fam.append((k, a.pnl.mean() - b.pnl.mean(), len(a), len(b)))
print(f'  by setup family (N >= 30 each side, {len(fam)} families, descriptive, read as noise unless they replicate): ' + '; '.join(f'{k} {c:+.0f} ({na}/{nb})' for k, c, na, nb in sorted(fam, key=lambda z: -z[1])[:6]) + (' ... ' + '; '.join(f'{k} {c:+.0f} ({na}/{nb})' for k, c, na, nb in sorted(fam, key=lambda z: z[1])[:3]) if len(fam) > 6 else ''))
print(f'  mean per fire overall {P.pnl.mean():+.2f}; AGREE {P[P.st == "AGREE"].pnl.mean():+.2f}, AGAINST {P[P.st == "AGAINST"].pnl.mean():+.2f}, NONE {P[P.st == "NONE"].pnl.mean():+.2f}')
