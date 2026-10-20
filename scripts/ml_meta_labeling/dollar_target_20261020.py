"""Runs docs/ML_DOLLAR_TARGET_PREREG_20261020.md (committed 92e94e6 before any arm was run). Offline research only."""
import sys, os, json
import numpy as np, pandas as pd, lightgbm as lgb
from datetime import timedelta
from sklearn.metrics import roc_auc_score
sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe, compute_sample_weights
from hyperparams import load_hyperparams
import walkforward as wf
from ablation_new_features_20261020 import run_arm, summarize, boot_diff
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
def run_dollar(df, cols, hp, kind):
    start, end = df['_fired_dt'].min(), df['_fired_dt'].max(); fs = start; out = []; a_hit = []; a_win = []
    while fs < end:
        fe = fs + timedelta(days=wf.FOLD_DAYS); purge = fs - timedelta(days=wf.PURGE_DAYS)
        train = df[df['_fired_dt'] < purge]; fold = df[(df['_fired_dt'] >= fs) & (df['_fired_dt'] < fe)]
        if len(fold) == 0: fs = fe; continue
        if len(train) < wf.MIN_TRAIN_N or not (0.05 <= train['label'].mean() <= 0.95): fs = fe; continue
        w = compute_sample_weights(train)
        if kind == 'D1':
            lo, hi = np.percentile(train['pnl0'], [1, 99]); y = train['pnl0'].clip(lo, hi)
            m = lgb.LGBMRegressor(**hp, objective='regression', random_state=42, verbose=-1); m.fit(train[cols], y, sample_weight=w); tp = m.predict(train[cols]); fp = m.predict(fold[cols])
        else:
            m = lgb.LGBMClassifier(**hp, objective='binary', random_state=42, verbose=-1); m.fit(train[cols], (train['pnl0'] > 0).astype(int), sample_weight=w); tp = m.predict_proba(train[cols])[:, 1]; fp = m.predict_proba(fold[cols])[:, 1]
        rth = train['is_rth_int'].values.astype(bool); pooled = float(np.percentile(tp, wf.APPROVAL_PERCENTILE))
        t_rth = float(np.percentile(tp[rth], wf.APPROVAL_PERCENTILE)) if rth.sum() >= wf.MIN_SPLIT_N else pooled; t_glx = float(np.percentile(tp[~rth], wf.APPROVAL_PERCENTILE)) if (~rth).sum() >= wf.MIN_SPLIT_N else pooled
        if fold['label'].nunique() > 1: a_hit.append((fs.strftime('%Y-%m-%d'), float(roc_auc_score(fold['label'], fp))))
        if (fold['pnl0'] > 0).nunique() > 1: a_win.append(float(roc_auc_score((fold['pnl0'] > 0).astype(int), fp)))
        th = np.where(fold['is_rth_int'].values.astype(bool), t_rth, t_glx)
        o = fold[['id', 'trade_date', 'actual_pnl']].copy(); o['take'] = (fp >= th).astype(int); o['fold'] = fs.strftime('%Y-%m-%d'); out.append(o); fs = fe
    return pd.concat(out, ignore_index=True), a_hit, float(np.mean(a_win))
def main():
    conn = get_connection(); hp = load_hyperparams(conn); df, cols0 = fetch_training_dataframe(conn, full_features=True)
    df = df.assign(_fired_dt=pd.to_datetime(df['fired_at'], format='mixed')).sort_values('_fired_dt').reset_index(drop=True)
    ids = tuple(df['id'].tolist()); df = df.merge(pd.read_sql(f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {ids}", conn), on='id'); df['pnl0'] = df['actual_pnl'].fillna(0.0)
    base_run = run_arm(df, cols0, hp, 42); base = summarize([base_run]); allmean = float(df['pnl0'].mean())
    # M0's AUC against the dollar-win label, same fold loop (informational)
    print(f'rows {len(df)}; take everything {allmean:+.3f}/trade; M0: AUC(2.5x hit) {base["auc"]:.4f}, policy/trade {base["policy_per_trade"]:+.3f}, approved {base["take_n"]:.0f} of {base["n"]}, approved P&L {base["take_pnl"]:+.0f}; random approval of same fraction {allmean * base["take_n"] / base["n"]:+.3f}/trade')
    half = np.median(pd.to_datetime(base['fold']).astype('int64')); m1 = pd.to_datetime(base['fold']).astype('int64') <= half; rows = []
    for k in ('D1', 'D2'):
        fr, a_hit, a_win = run_dollar(df, cols0, hp, k); s = summarize([(fr, a_hit)]); assert (s['ids'] == base['ids']).all()
        dd = s['pol'] - base['pol']; lo, hi = boot_diff(dd, base['days']); h1 = dd[m1].mean(); h2 = dd[~m1].mean()
        label = 'DOLLAR TARGET HELPS' if (lo > 0 and h1 > 0 and h2 > 0) else 'not shown'
        rows.append(dict(arm=k, auc_hit=s['auc'], auc_dollar_win=a_win, policy=s['policy_per_trade'], approved=s['take_n'], approved_pnl=s['take_pnl'], diff=float(dd.mean()), ci_lo=lo, ci_hi=hi, half1=float(h1), half2=float(h2), label=label))
        print(f'{k}: AUC(2.5x hit) {s["auc"]:.4f}, AUC(dollar win) {a_win:.4f}, policy/trade {s["policy_per_trade"]:+.3f}, approved {s["take_n"]:.0f}, approved P&L {s["take_pnl"]:+.0f} | vs M0 diff {dd.mean():+.3f} CI99 [{lo:+.3f},{hi:+.3f}] halves {h1:+.3f}/{h2:+.3f} -> {label}')
    json.dump(dict(base=dict(auc=base['auc'], pol=base['policy_per_trade'], take=base['take_n']), rows=rows), open(os.path.join(ROOT, 'scratch', 'ml_dollar_target_results_20261020.json'), 'w'), indent=1)
if __name__ == '__main__': main()
