"""ML ranking test: docs/ML_RANKING_TEST_ADDENDUM_20261025.md (+ the 2026-10-06 pre-registration in OPEN_DECISION ml_ranking_preregistered_test_20261027).
Trains on rows fired before the cutoff (minus the purge), scores primary ACTIVE trades fired in the window, groups them into 5-minute chains, and compares the model's top pick to the window mean.
Run via scripts/run_ml_ranking_test_20261027.mjs (date guard + recording). Writes scratch/ml_ranking_test_result_20261027.json.
  ./venv/bin/python scripts/ml_meta_labeling/ranking_test_20261027.py [--window-end YYYY-MM-DD]"""
import sys, os, json
import numpy as np, pandas as pd, lightgbm as lgb
sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe, compute_sample_weights, feature_cols, CORE_COLS, TRIMMED_COLS
from hyperparams import load_hyperparams
import walkforward as wf
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CUTOFF, WINDOW_START = '2026-10-07', '2026-10-07'
WINDOW_END = '2026-10-27'
if '--window-end' in sys.argv: WINDOW_END = sys.argv[sys.argv.index('--window-end') + 1]

def windows_of(df):
    """maximal chains: each trade fired within 5 minutes of the previous one; keep chains of 2+"""
    df = df.sort_values('_fired_dt').reset_index(drop=True); chains, cur = [], []
    for i, r in df.iterrows():
        if cur and (r['_fired_dt'] - df.loc[cur[-1], '_fired_dt']).total_seconds() <= 300: cur.append(i)
        else:
            if len(cur) >= 2: chains.append(cur)
            cur = [i]
    if len(cur) >= 2: chains.append(cur)
    return df, chains

def run_arm(df_all, cols, hp, test, label):
    train = df_all[df_all['_fired_dt'] < pd.Timestamp(CUTOFF) - pd.Timedelta(days=wf.PURGE_DAYS)]
    model = lgb.LGBMClassifier(**hp, objective='binary', random_state=42, verbose=-1)
    model.fit(train[cols], train['label'], sample_weight=compute_sample_weights(train))
    t = test.copy(); t['p'] = model.predict_proba(t[cols])[:, 1]
    t, chains = windows_of(t); diffs, beats, days = [], 0, []
    for ch in chains:
        w = t.loc[ch]; top = w.sort_values(['p', '_fired_dt'], ascending=[False, True]).iloc[0]; mean_pnl = float(w['actual_pnl'].mean())
        d = float(top['actual_pnl'] - mean_pnl); diffs.append(d); beats += 1 if top['actual_pnl'] > mean_pnl else 0; days.append(str(w['trade_date'].iloc[0]))
    n = len(diffs); out = dict(arm=label, n_train=int(len(train)), n_test_trades=int(len(t)), n_windows=n, mean_diff=float(np.mean(diffs)) if n else None, beats=beats, beats_share=(beats / n) if n else None)
    if n >= 4:
        rng = np.random.default_rng(20261027); ud = sorted(set(days)); idx = {u: [i for i, d in enumerate(days) if d == u] for u in ud}; boots = []
        for _ in range(3000):
            pick = rng.choice(len(ud), size=len(ud), replace=True); sel = [i for k in pick for i in idx[ud[k]]]; boots.append(float(np.mean([diffs[i] for i in sel])))
        out['ci95'] = [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))]
    return out

def main():
    conn = get_connection(); hp = load_hyperparams(conn); df, _ = fetch_training_dataframe(conn, full_features=True)
    df = df.assign(_fired_dt=pd.to_datetime(df['fired_at'], format='mixed')).sort_values('_fired_dt').reset_index(drop=True)
    ids = tuple(df['id'].tolist()); pnl = pd.read_sql(f"SELECT id, actual_pnl::float AS actual_pnl, origin_status, is_cluster_primary, bad_bars_basis, status FROM active_setups WHERE id IN {ids}", conn)
    df = df.merge(pnl, on='id')
    cand = pd.read_sql("""SELECT count(*) n FROM active_setups WHERE origin_status='ACTIVE' AND is_cluster_primary IS NOT FALSE AND actual_pnl IS NOT NULL AND bad_bars_basis IS NOT TRUE
        AND status NOT IN ('ACTIVE','SHADOW') AND fired_at >= %s::timestamp AND fired_at < (%s::date + 1)::timestamp""", conn, params=(WINDOW_START, WINDOW_END))
    test = df[(df['origin_status'] == 'ACTIVE') & (df['is_cluster_primary'] != False) & (df['bad_bars_basis'] != True) & (~df['status'].isin(['ACTIVE', 'SHADOW'])) & df['actual_pnl'].notna()
              & (df['_fired_dt'] >= pd.Timestamp(WINDOW_START)) & (df['_fired_dt'] < pd.Timestamp(WINDOW_END) + pd.Timedelta(days=1))]
    res = dict(window=[WINDOW_START, WINDOW_END], cutoff=CUTOFF, candidate_trades_in_window=int(cand['n'].iloc[0]), scored_trades=int(len(test)), unscorable_no_features=int(cand['n'].iloc[0]) - int(len(test)))
    core = list(CORE_COLS); full22 = [c for c in feature_cols(full=True) if c not in TRIMMED_COLS]
    res['primary'] = run_arm(df, core, hp, test, 'CORE_4 (primary)'); res['secondary'] = run_arm(df, full22, hp, test, 'FULL_22 (information only)')
    p = res['primary']; res['pass'] = bool(p['n_windows'] >= 20 and p['mean_diff'] is not None and p['mean_diff'] >= 5 and p['beats_share'] is not None and p['beats_share'] >= 0.60)
    json.dump(res, open(os.path.join(ROOT, 'scratch', 'ml_ranking_test_result_20261027.json'), 'w'), indent=1); print(json.dumps(res, indent=1))
if __name__ == '__main__': main()
