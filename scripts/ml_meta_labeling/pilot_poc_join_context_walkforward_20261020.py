"""POC_ROTATION_JOIN context ranker pilot (2026-10-20, research only, nothing wired).
Question: do features known strictly at the join (order flow, volume, VWAP/range position, rotation structure, level runway, value-area position) rank joins by realistic-fill live-exit P&L OUT OF SAMPLE?
Walk-forward by calendar quarter (train on all earlier events minus a 24h purge, test on the quarter), selection = top half by score. Compared with ALL events and with a within-quarter score-shuffle null.
Input: scratch/poc_join_context_features_20261020.csv (scripts/study_poc_join_context_20261020.mjs). Run: ./venv/bin/python scripts/ml_meta_labeling/pilot_poc_join_context_walkforward_20261020.py
"""
import numpy as np, pandas as pd, warnings
from sklearn.linear_model import Ridge, LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import GradientBoostingClassifier
warnings.filterwarnings('ignore')
df = pd.read_csv('scratch/poc_join_context_features_20261020.csv', parse_dates=['ts'])
FEATS = [c for c in df.columns if c not in ('d', 'ts', 'era', 'pnl')]
df = df.sort_values('ts').reset_index(drop=True)
df['q'] = df['ts'].dt.to_period('Q').astype(str)
df['win'] = (df['pnl'] > 0).astype(int); df['big'] = (df['pnl'] >= 100).astype(int)
quarters = sorted(df['q'].unique()); test_qs = [q for q in quarters if q >= '2024Q1']
rng = np.random.default_rng(20261020)
def fit_predict(kind, tr, te):
    med = tr[FEATS].median(); Xtr = tr[FEATS].fillna(med).values; Xte = te[FEATS].fillna(med).values
    sc = StandardScaler().fit(Xtr); Xtr, Xte = sc.transform(Xtr), sc.transform(Xte)
    if kind == 'ridge_pnl': m = Ridge(alpha=300.0).fit(Xtr, tr['pnl'].clip(-150, 300).values); return m.predict(Xte), dict(zip(FEATS, m.coef_))
    if kind == 'logit_win': m = LogisticRegression(C=0.05, max_iter=500).fit(Xtr, tr['win'].values); return m.predict_proba(Xte)[:, 1], dict(zip(FEATS, m.coef_[0]))
    if kind == 'logit_big': m = LogisticRegression(C=0.05, max_iter=500).fit(Xtr, tr['big'].values); return m.predict_proba(Xte)[:, 1], dict(zip(FEATS, m.coef_[0]))
    if kind == 'gbm_win': m = GradientBoostingClassifier(n_estimators=80, max_depth=2, learning_rate=0.05, subsample=0.7, random_state=1).fit(Xtr, tr['win'].values); return m.predict_proba(Xte)[:, 1], dict(zip(FEATS, m.feature_importances_))
def day_boot(sel_df, n=2000):                      # day-blocked CI of (mean pnl | selected) - (mean pnl | all) over out-of-fold events
    days = sel_df['d'].unique(); g = {d: x for d, x in sel_df.groupby('d')}; stats = []
    S_all = np.array([g[d]['pnl'].sum() for d in days]); N_all = np.array([len(g[d]) for d in days]); S_sel = np.array([g[d].loc[g[d]['sel'], 'pnl'].sum() for d in days]); N_sel = np.array([g[d]['sel'].sum() for d in days])
    for _ in range(n):
        i = rng.integers(0, len(days), len(days)); na, ns = N_all[i].sum(), N_sel[i].sum()
        if na and ns: stats.append(S_sel[i].sum() / ns - S_all[i].sum() / na)
    return np.percentile(stats, [2.5, 97.5])
print(f'events {len(df)}, test quarters {test_qs[0]}..{test_qs[-1]}, features {len(FEATS)}')
print(f"{'model':11} {'N_test':>6} {'all':>7} {'top-half':>9} {'bottom':>8} {'top-all':>8} {'95% CI (day-blocked)':>22} {'perm p':>7}")
coefs = {}
for kind in ['ridge_pnl', 'logit_win', 'logit_big', 'gbm_win']:
    out = []
    for q in test_qs:
        te = df[df['q'] == q].copy(); t0 = te['ts'].min()
        tr = df[df['ts'] < t0 - pd.Timedelta(hours=24)]
        if len(tr) < 600 or len(te) < 30: continue
        s, c = fit_predict(kind, tr, te); te['score'] = s; te['sel'] = s >= np.median(s); out.append(te); coefs.setdefault(kind, []).append(c)
    oos = pd.concat(out); top, bot, allm = oos.loc[oos['sel'], 'pnl'].mean(), oos.loc[~oos['sel'], 'pnl'].mean(), oos['pnl'].mean()
    lo, hi = day_boot(oos); obs = top - allm; null = []
    for _ in range(500):                              # shuffle scores within each test quarter
        sh = oos.copy(); sh['score'] = sh.groupby('q')['score'].transform(lambda x: rng.permutation(x.values)); sh['sel'] = sh.groupby('q')['score'].transform(lambda x: x >= np.median(x)); null.append(sh.loc[sh['sel'], 'pnl'].mean() - allm)
    p = (np.array(null) >= obs).mean()
    print(f'{kind:11} {len(oos):6d} {allm:7.1f} {top:9.1f} {bot:8.1f} {obs:8.1f} {f"[{lo:.1f},{hi:.1f}]":>22} {p:7.3f}')
    per_q = oos.groupby('q').apply(lambda x: x.loc[x['sel'], 'pnl'].mean() - x['pnl'].mean()); print('            per-quarter top-all:', ' '.join(f'{v:+.0f}' for v in per_q.values), f'| quarters positive {(per_q > 0).sum()}/{len(per_q)}')
print('\nridge_pnl coefficient stability (mean coef over folds, share of folds with the same sign) -- standardized features:')
C = pd.DataFrame(coefs['ridge_pnl']); st = pd.DataFrame({'mean_coef': C.mean(), 'same_sign_share': C.apply(lambda c: (np.sign(c) == np.sign(c.mean())).mean())}).sort_values('mean_coef', key=abs, ascending=False)
print(st.head(10).round(3).to_string())
