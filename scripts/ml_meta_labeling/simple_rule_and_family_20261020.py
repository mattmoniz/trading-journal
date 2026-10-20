"""Offline test, runs docs/ML_SIMPLE_RULE_AND_FAMILY_PREREG_20261020.md (committed 4c52b7e before any arm was run).
Step 1: simple time-of-day / flow / family rules vs the model. Step 2: setup family as a model input. Same population, folds, hyperparameters, weights and approval mechanism as walkforward.py.
Run: ./venv/bin/python scripts/ml_meta_labeling/simple_rule_and_family_20261020.py   Nothing here touches the live model."""
import sys, os, json
import numpy as np, pandas as pd, lightgbm as lgb
from datetime import timedelta
from sklearn.metrics import roc_auc_score
sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe, feature_cols
from hyperparams import load_hyperparams
import walkforward as wf
from ablation_new_features_20261020 import run_arm, summarize, boot_diff
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
N_NULL = 8
def session_minutes(df):
    mod = df['_fired_dt'].dt.hour * 60 + df['_fired_dt'].dt.minute
    return np.where(df['is_rth_int'] == 1, mod - 570, (mod - 1080) % 1440)
def shrunk_scores(train, test, key_cols, rth_tr, rth_te, val='pnl0'):
    """Score = (sum cell pnl + k * session mean) / (n + k), k = median training cell size; cells and session means from TRAIN only; computed per session type."""
    s_tr = np.zeros(len(train)); s_te = np.zeros(len(test)); pnl_tr = train[val].values.astype(float)
    for sess in (True, False):
        mtr = rth_tr == sess; mte = rth_te == sess
        if mtr.sum() == 0: continue
        keys_tr = train.loc[mtr, key_cols].astype(str).agg('|'.join, axis=1) if len(key_cols) > 1 else train.loc[mtr, key_cols[0]].astype(str)
        g = pd.DataFrame({'k': keys_tr.values, 'p': pnl_tr[mtr]}).groupby('k')['p'].agg(['sum', 'count'])
        mean_s = pnl_tr[mtr].mean(); k = float(np.median(g['count']))
        sc = ((g['sum'] + k * mean_s) / (g['count'] + k)).to_dict()
        s_tr[mtr] = [sc.get(x, mean_s) for x in keys_tr.values]
        if mte.sum():
            keys_te = test.loc[mte, key_cols].astype(str).agg('|'.join, axis=1) if len(key_cols) > 1 else test.loc[mte, key_cols[0]].astype(str)
            s_te[mte] = [sc.get(x, mean_s) for x in keys_te.values]
    return s_tr, s_te
def add_bins(train, test, rth_tr, rth_te, with_flow):
    """Adds columns tbin (and fbin) with edges from TRAIN rows of the same session type."""
    for c in ('tbin', 'fbin'): train[c] = 'x'; test[c] = 'x'
    for sess in (True, False):
        mtr = rth_tr == sess; mte = rth_te == sess
        if mtr.sum() < 12: continue
        q = np.nanpercentile(train.loc[mtr, 'smin'], [100 / 6 * i for i in range(1, 6)]); train.loc[mtr, 'tbin'] = np.searchsorted(q, train.loc[mtr, 'smin'].values).astype(str); test.loc[mte, 'tbin'] = np.searchsorted(q, test.loc[mte, 'smin'].values).astype(str)
        if with_flow:
            v = train.loc[mtr, 'drv_recentDeltaAligned15Bars']; qq = np.nanpercentile(v.dropna(), [100 / 3, 200 / 3])
            f = lambda x: np.where(x.isna(), 'm', np.searchsorted(qq, x.fillna(0).values).astype(str))
            train.loc[mtr, 'fbin'] = f(v); test.loc[mte, 'fbin'] = f(test.loc[mte, 'drv_recentDeltaAligned15Bars'])
def run_rule(df, kind):
    """Same fold loop as walkforward.run_walkforward_folds; kind in R1,R2,R3."""
    val = 'label' if kind.endswith('L') else 'pnl0'; kind = kind.rstrip('L') if kind.endswith('L') else kind   # post-hoc variants: score cells by training win rate of the 2.5x label (the quantity AUC is measured on)
    start, end = df['_fired_dt'].min(), df['_fired_dt'].max(); fs = start; out = []; aucs = []
    while fs < end:
        fe = fs + timedelta(days=wf.FOLD_DAYS); purge = fs - timedelta(days=wf.PURGE_DAYS)
        train = df[df['_fired_dt'] < purge].copy(); fold = df[(df['_fired_dt'] >= fs) & (df['_fired_dt'] < fe)].copy()
        if len(fold) == 0: fs = fe; continue
        if len(train) < wf.MIN_TRAIN_N or not (0.05 <= train['label'].mean() <= 0.95): fs = fe; continue
        rth_tr = train['is_rth_int'].values.astype(bool); rth_te = fold['is_rth_int'].values.astype(bool)
        if kind == 'R3': keys = ['family']
        else:
            add_bins(train, fold, rth_tr, rth_te, with_flow=(kind == 'R2')); keys = ['tbin'] if kind == 'R1' else ['tbin', 'fbin']
        s_tr, s_te = shrunk_scores(train, fold, keys, rth_tr, rth_te, val)
        pooled = float(np.percentile(s_tr, wf.APPROVAL_PERCENTILE))
        t_rth = float(np.percentile(s_tr[rth_tr], wf.APPROVAL_PERCENTILE)) if rth_tr.sum() >= wf.MIN_SPLIT_N else pooled; t_glx = float(np.percentile(s_tr[~rth_tr], wf.APPROVAL_PERCENTILE)) if (~rth_tr).sum() >= wf.MIN_SPLIT_N else pooled
        if fold['label'].nunique() > 1: aucs.append((fs.strftime('%Y-%m-%d'), float(roc_auc_score(fold['label'], s_te))))
        th = np.where(rth_te, t_rth, t_glx)
        o = fold[['id', 'trade_date', 'actual_pnl']].copy(); o['take'] = (s_te >= th).astype(int); o['fold'] = fs.strftime('%Y-%m-%d'); out.append(o); fs = fe
    return pd.concat(out, ignore_index=True), aucs
def main():
    conn = get_connection(); hp = load_hyperparams(conn); df, cols0 = fetch_training_dataframe(conn, full_features=True)
    df = df.assign(_fired_dt=pd.to_datetime(df['fired_at'], format='mixed')).sort_values('_fired_dt').reset_index(drop=True)
    ids = tuple(df['id'].tolist()); df = df.merge(pd.read_sql(f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {ids}", conn), on='id')
    df['pnl0'] = df['actual_pnl'].fillna(0.0); df['smin'] = session_minutes(df)
    df['family'] = df['setup_type'].str.replace(r'_(LONG|SHORT)(_.*)?$', '', regex=True)
    fam_cats = sorted(df['family'].unique()); df['family'] = pd.Categorical(df['family'], categories=fam_cats)
    print(f'rows {len(df)}, {df["_fired_dt"].min()} .. {df["_fired_dt"].max()}, {len(fam_cats)} families, hp {hp}')
    base = summarize([run_arm(df, cols0, hp, 42)]); rng = np.random.default_rng(20261020)
    print(f'M0 baseline: AUC {base["auc"]:.4f}, policy/trade {base["policy_per_trade"]:+.3f}, approved {base["take_n"]:.0f} of {base["n"]}, approved P&L {base["take_pnl"]:+.0f}')
    allmean = float(df['pnl0'].mean()); frac = base['take_n'] / base['n']; print(f'reference: take everything {allmean:+.3f}/trade; random approval of the same fraction {allmean * frac:+.3f}/trade')
    nulls = []
    for i in range(N_NULL): df[f'null{i}'] = rng.normal(size=len(df)); nulls.append(summarize([run_arm(df, cols0 + [f'null{i}'], hp, 42)]))
    sd_null = float(np.std([n['auc'] for n in nulls], ddof=1)); sd_null_pol = float(np.std([n['policy_per_trade'] for n in nulls], ddof=1))
    shuf = []
    for i in range(N_NULL):
        df[f'fsh{i}'] = pd.Categorical(rng.permutation(df['family'].astype(str).values), categories=fam_cats); shuf.append(summarize([run_arm(df, cols0 + [f'fsh{i}'], hp, 42)]))
    sd_shuf = float(np.std([n['auc'] for n in shuf], ddof=1)); mean_shuf = float(np.mean([n['auc'] for n in shuf]))
    print(f'noise band: null numeric column AUC SD {sd_null:.4f} (policy SD {sd_null_pol:.3f}); shuffled-family AUC mean {mean_shuf:.4f} SD {sd_shuf:.4f} (shuffled-family AUC minus M0 = {mean_shuf - base["auc"]:+.4f})')
    half = np.median(pd.to_datetime(base['fold']).astype('int64')); m1 = pd.to_datetime(base['fold']).astype('int64') <= half; rows = []
    def compare(name, a, b, sd, kind):
        """a minus b; kind 'rule' (model vs rule) or 'family' (arm vs M0)."""
        assert (a['ids'] == b['ids']).all()
        dd = a['pol'] - b['pol']; lo, hi = boot_diff(dd, a['days']); dauc = a['auc'] - b['auc']; z = dauc / sd; h1 = dd[m1].mean(); h2 = dd[~m1].mean()
        if kind == 'rule': label = 'MODEL ADDS' if (z > 2 and lo > 0) else ('RULE IS BETTER' if (z < -2 or hi < 0) else 'RULE IS AS GOOD (cannot show the model adds)')
        else: label = 'FAMILY HELPS' if (z > 2 and lo > 0 and h1 > 0 and h2 > 0) else 'research only'
        rows.append(dict(comparison=name, auc_a=a['auc'], auc_b=b['auc'], d_auc=dauc, d_auc_sd=z, diff_per_trade=float(dd.mean()), ci_lo=lo, ci_hi=hi, half1=float(h1), half2=float(h2), label=label))
        print(f'{name:34s} AUC {a["auc"]:.4f} vs {b["auc"]:.4f} (delta {dauc:+.4f} = {z:+.1f} SD) | policy/trade {a["policy_per_trade"]:+.3f} vs {b["policy_per_trade"]:+.3f} | diff {dd.mean():+.3f} CI99 [{lo:+.3f},{hi:+.3f}] halves {h1:+.3f}/{h2:+.3f} | approved {a["take_n"]:.0f} vs {b["take_n"]:.0f} -> {label}')
    print('\n--- Step 1/3 rules ---'); rules = {}
    for k in ('R1', 'R2', 'R3', 'R1L', 'R2L', 'R3L'):
        rules[k] = summarize([run_rule(df, k)]); r = rules[k]; print(f'{k}: AUC {r["auc"]:.4f}, policy/trade {r["policy_per_trade"]:+.3f}, approved {r["take_n"]:.0f} of {r["n"]}, approved P&L {r["take_pnl"]:+.0f}, folds {r["n"] and len(r["per_seed_auc"])}')
    print('\n--- Model vs rule (M0 minus rule) ---')
    for k in ('R1', 'R2', 'R3', 'R1L', 'R2L', 'R3L'): compare(f'M0 vs {k}' + (' (post-hoc)' if k.endswith('L') else ''), base, rules[k], sd_null, 'rule')
    print('\n--- Step 2: family as a model input (arm minus M0) ---')
    F1 = summarize([run_arm(df, cols0 + ['family'], hp, 42)]); compare('F1 M0 + family vs M0', F1, base, max(sd_shuf, sd_null), 'family')
    colsF2 = ['intraday_barsInSessionSoFar', 'minutes_from_open', 'intraday_recentDelta15Bars', 'drv_recentDeltaAligned15Bars', 'family']
    F2 = summarize([run_arm(df, colsF2, hp, 42)]); compare('F2 time+delta15+family vs M0', F2, base, max(sd_shuf, sd_null), 'family')
    M22 = summarize([run_arm(df, feature_cols(), hp, 42)]); print(f'reference M22 (live-trimmed 22 inputs): AUC {M22["auc"]:.4f}, policy/trade {M22["policy_per_trade"]:+.3f}, approved {M22["take_n"]:.0f}')
    print('\nfamily-level view: top/bottom families by training-free total pnl (descriptive only)'); g = df.groupby('family', observed=True)['pnl0'].agg(['count', 'mean']).sort_values('count', ascending=False).head(12); print(g.round(2).to_string())
    json.dump(dict(base=dict(auc=base['auc'], pol=base['policy_per_trade'], take=base['take_n'], n=base['n']), sd_null=sd_null, sd_shuf=sd_shuf, rules={k: dict(auc=v['auc'], pol=v['policy_per_trade'], take=v['take_n']) for k, v in rules.items()}, F1=dict(auc=F1['auc'], pol=F1['policy_per_trade'], take=F1['take_n']), F2=dict(auc=F2['auc'], pol=F2['policy_per_trade'], take=F2['take_n']), M22=dict(auc=M22['auc'], pol=M22['policy_per_trade']), rows=rows), open(os.path.join(ROOT, 'scratch', 'ml_simple_rule_family_results_20261020.json'), 'w'), indent=1)
if __name__ == '__main__': main()
