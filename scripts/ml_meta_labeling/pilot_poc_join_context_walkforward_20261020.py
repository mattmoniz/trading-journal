"""POC_ROTATION_JOIN context ranker pilot (2026-10-20, research only, nothing wired).
Question: do features known strictly at the join (order flow, volume, VWAP/range position, rotation structure, level runway, value-area position) rank joins by realistic-fill live-exit P&L OUT OF SAMPLE?
Walk-forward by calendar quarter (train on all earlier events minus a 24h purge, test on the quarter). Metrics (DeepSeek review 2026-10-20: top-half-minus-all is dominated by the bulk, so a lottery-shaped P&L needs right-tail metrics too):
  top-half minus all, TOP-DECILE minus all, and the big-win (pnl >= +100) rate inside the top decile vs overall. Within-quarter score-shuffle permutation null for each.
--plant X : POSITIVE CONTROL -- add a synthetic feature carrying X standard deviations of the (clipped) outcome plus unit noise, to prove the pipeline can see an effect of that size (committed so the claim is reproducible).
Input: scratch/poc_join_context_features_20261020.csv (scripts/study_poc_join_context_20261020.mjs). Run: ./venv/bin/python scripts/ml_meta_labeling/pilot_poc_join_context_walkforward_20261020.py [--plant 0.15]
"""
import sys, numpy as np, pandas as pd, warnings
from sklearn.linear_model import Ridge, LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import GradientBoostingClassifier
warnings.filterwarnings('ignore')
PLANT = float(sys.argv[sys.argv.index('--plant') + 1]) if '--plant' in sys.argv else None
df = pd.read_csv('scratch/poc_join_context_features_20261020.csv', parse_dates=['ts']).sort_values('ts').reset_index(drop=True)
if PLANT is not None:
    c = df['pnl'].clip(-100, 300); df['plant'] = (c - c.mean()) / c.std() * PLANT + np.random.default_rng(1).normal(0, 1, len(df))
FEATS = [c for c in df.columns if c not in ('d', 'ts', 'era', 'pnl')]
df['q'] = df['ts'].dt.to_period('Q').astype(str); df['win'] = (df['pnl'] > 0).astype(int); df['big'] = (df['pnl'] >= 100).astype(int); df['bigloss'] = (df['pnl'] <= -150).astype(int)
test_qs = [q for q in sorted(df['q'].unique()) if q >= '2024Q1']; rng = np.random.default_rng(20261020)
def fit_predict(kind, tr, te):
    med = tr[FEATS].median(); Xtr, Xte = tr[FEATS].fillna(med).values, te[FEATS].fillna(med).values
    sc = StandardScaler().fit(Xtr); Xtr, Xte = sc.transform(Xtr), sc.transform(Xte)
    if kind == 'ridge_pnl': return Ridge(alpha=300.0).fit(Xtr, tr['pnl'].clip(-150, 300).values).predict(Xte)
    if kind == 'logit_win': return LogisticRegression(C=0.05, max_iter=500).fit(Xtr, tr['win'].values).predict_proba(Xte)[:, 1]
    if kind == 'logit_big': return LogisticRegression(C=0.05, max_iter=500).fit(Xtr, tr['big'].values).predict_proba(Xte)[:, 1]
    if kind == 'gbm_win': return GradientBoostingClassifier(n_estimators=80, max_depth=2, learning_rate=0.05, subsample=0.7, random_state=1).fit(Xtr, tr['win'].values).predict_proba(Xte)[:, 1]
def sel(oos, frac):                                 # top `frac` of events by score within each quarter
    return oos.groupby('q')['score'].transform(lambda x: x >= x.quantile(1 - frac))
def metrics(oos):
    allm = oos['pnl'].mean(); h = sel(oos, 0.5); d = sel(oos, 0.1)
    return oos.loc[h, 'pnl'].mean() - allm, oos.loc[d, 'pnl'].mean() - allm, oos.loc[d, 'big'].mean() - oos['big'].mean(), oos.loc[d, 'bigloss'].mean() - oos['bigloss'].mean()
def day_boot(oos, frac, n=1500):                    # day-blocked CI of (selected mean - all mean)
    oos = oos.assign(s=sel(oos, frac)); g = {d: x for d, x in oos.groupby('d')}; days = list(g)
    Sa = np.array([g[d]['pnl'].sum() for d in days]); Na = np.array([len(g[d]) for d in days]); Ss = np.array([g[d].loc[g[d]['s'], 'pnl'].sum() for d in days]); Ns = np.array([g[d]['s'].sum() for d in days]); st = []
    for _ in range(n):
        i = rng.integers(0, len(days), len(days))
        if Na[i].sum() and Ns[i].sum(): st.append(Ss[i].sum() / Ns[i].sum() - Sa[i].sum() / Na[i].sum())
    return np.percentile(st, [2.5, 97.5])
print(f'events {len(df)}, test quarters {test_qs[0]}..{test_qs[-1]}, features {len(FEATS)}' + (f', PLANTED control {PLANT} SD' if PLANT is not None else ''))
print(f"{'model':11} {'N_test':>6} {'all':>6} | {'top-half-all':>12} {'CI':>16} {'p':>6} | {'top-decile-all':>14} {'CI':>16} {'p':>6} | {'big% decile vs all':>19}")
for kind in ['ridge_pnl', 'logit_win', 'logit_big', 'gbm_win']:
    out = []
    for q in test_qs:
        te = df[df['q'] == q].copy(); tr = df[df['ts'] < te['ts'].min() - pd.Timedelta(hours=24)]
        if len(tr) < 600 or len(te) < 30: continue
        te['score'] = fit_predict(kind, tr, te); out.append(te)
    oos = pd.concat(out); obs = metrics(oos); nulls = []
    for _ in range(400):
        sh = oos.copy(); sh['score'] = sh.groupby('q')['score'].transform(lambda x: rng.permutation(x.values)); nulls.append(metrics(sh))
    nulls = np.array(nulls); ph, pd_, pb = (nulls[:, 0] >= obs[0]).mean(), (nulls[:, 1] >= obs[1]).mean(), (nulls[:, 2] >= obs[2]).mean(); lh, hh = day_boot(oos, 0.5); ld, hd = day_boot(oos, 0.1)
    print(f'{kind:11} {len(oos):6d} {oos["pnl"].mean():6.1f} | {obs[0]:12.1f} {f"[{lh:.1f},{hh:.1f}]":>16} {ph:6.3f} | {obs[1]:14.1f} {f"[{ld:.1f},{hd:.1f}]":>16} {pd_:6.3f} | {100*(obs[2]+oos["big"].mean()):7.1f}% vs {100*oos["big"].mean():.1f}% (perm p {pb:.3f}) | big-LOSS (<=-150) decile {100*(obs[3]+oos["bigloss"].mean()):.1f}% vs {100*oos["bigloss"].mean():.1f}%')
