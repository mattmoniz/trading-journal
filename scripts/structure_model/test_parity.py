"""Parity test: scripts/structure_model/features.py must reproduce the research rows (scratch/structure_model_20261105/explore_features.csv, written by structure_model_stepA.py --dump-features) from raw inputs, to 1e-9, on sampled explore days.
Also checks that the fitted model reproduces a refit on the same rows. Usage: venv/bin/python scripts/structure_model/test_parity.py"""
import os, sys, json, csv
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TB = pd.read_csv(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'daytype_forecast_table.csv')).sort_values('d').reset_index(drop=True); TB['rng'] = TB.adr * np.exp(TB.lrr)
RF = json.load(open(os.path.join(REPO, 'scratch', 'watcher_marks_20261104', 'rth_1m_flow.json'))); LG = json.load(open(os.path.join(REPO, 'scratch', 'ovn_orderflow_20261104', 'rth_legs_at_decisions.json')))
REF = pd.read_csv(os.path.join(REPO, 'scratch', 'structure_model_20261105', 'explore_features.csv'))
dates = [d for d in TB.d if d in RF and d in LG and os.path.exists(os.path.join(REPO, 'scratch', 'updown_1m_20261104', d + '.csv'))]; TB = TB[TB.d.isin(dates)].reset_index(drop=True); dl = list(TB.d)


def bars(d):
    x = RF[d]; a = {k: np.full(390, np.nan) for k in ('o', 'h', 'l', 'c')}
    for i, m in enumerate(x['m']):
        for k in a: a[k][m] = x[k][i]
    return a


def ticks(d):
    a = {k: np.full(390, np.nan) for k in ('up', 'dn', 'vol')}
    for r in csv.DictReader(open(os.path.join(REPO, 'scratch', 'updown_1m_20261104', d + '.csv'))):
        if r['ts'][:10] == d:
            m = int(r['ts'][11:13]) * 60 + int(r['ts'][14:16]) - 570
            if 0 <= m < 390: a['up'][m] = int(r['up_vol']); a['dn'][m] = int(r['down_vol']); a['vol'][m] = int(r['volume'])
    return a


rng = np.random.default_rng(7); days = sorted(REF.date.unique()); pick = list(rng.choice(days, 25, replace=False)); cols = ['T'] + F.M2_COLS; worst = 0.0; n = 0
for d in pick:
    i = dl.index(d); t = TB.iloc[i]; adr = t.adr; prior = [dict(h=bars(p)['h'], l=bars(p)['l'], vol=ticks(p)['vol']) for p in dl[i - 20:i]]
    har = F.har_features([TB.rng.iloc[j] for j in range(i - 22, i)], adr, t.on_rng * adr); g = F.leg_grid_size(adr); legs = {T: LG[d][str(T)][str(g)] for T in F.TIMES}
    rows = F.feature_rows(bars(d), adr, har, ticks(d), prior, legs); ref = REF[REF.date == d].sort_values('T')
    for r, (_, rr) in zip(rows, ref.iterrows()):
        for c in cols: worst = max(worst, abs(r[c] - rr[c])); n += 1
print(f'features parity on {len(pick)} sampled explore days, {n} values: worst absolute difference {worst:.2e}')
assert worst < 1e-9, 'FEATURE PARITY BROKEN'
X = REF[F.M2_COLS].values.astype(float); y = REF.y.values; m = F.fit(X, y, REF.di.values); p = F.predict(m, X)
print(f'fit on all {len(REF)} explore rows: alpha {m["alpha"]}, in-sample correlation {np.corrcoef(p, y)[0, 1]:.3f}')
m2 = json.loads(json.dumps(m)); assert np.allclose(F.predict(m2, X), p), 'MODEL ROUND-TRIP BROKEN'
print('PARITY OK; model round-trips through JSON')
