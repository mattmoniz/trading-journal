"""Offline ML input ablation + candidate-feature test, runs docs/ML_INPUT_ABLATION_PREREG_20261020.md (committed fe46775 before any arm was run).
Same population, folds, hyperparameters, sample weights and approval mechanism as walkforward.py; only the feature list and the seed change. Nothing here touches the live model or its training.
Run: ./venv/bin/python scripts/ml_meta_labeling/ablation_new_features_20261020.py  (needs scratch/ml_candidate_features_20261020.csv from scripts/export_ml_candidate_features_20261020.mjs)"""
import sys, os, json
import numpy as np, pandas as pd, lightgbm as lgb
from datetime import timedelta
from sklearn.metrics import roc_auc_score
sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe, compute_sample_weights, PD_FEATURE_KEYS, INTRADAY_FEATURE_KEYS, MIGRATION_CATEGORIES
from hyperparams import load_hyperparams
import walkforward as wf
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SEEDS_ARM = [42]; SEEDS_BASE = [42]; BOOT = 2000; N_NULL = 8   # Addendum A: LightGBM here is deterministic (seed has no effect), so the noise band comes from null-column arms
def run_arm(df, cols, hp, seed):
    """walkforward.run_walkforward_folds with the seed and column list parameterised; returns (per-trade frame, fold AUCs)."""
    start, end = df['_fired_dt'].min(), df['_fired_dt'].max(); fs = start; out = []; aucs = []
    while fs < end:
        fe = fs + timedelta(days=wf.FOLD_DAYS); purge = fs - timedelta(days=wf.PURGE_DAYS)
        train = df[df['_fired_dt'] < purge]; fold = df[(df['_fired_dt'] >= fs) & (df['_fired_dt'] < fe)]
        if len(fold) == 0: fs = fe; continue
        if len(train) < wf.MIN_TRAIN_N or not (0.05 <= train['label'].mean() <= 0.95): fs = fe; continue
        model = lgb.LGBMClassifier(**hp, objective='binary', random_state=seed, verbose=-1)
        model.fit(train[cols], train['label'], sample_weight=compute_sample_weights(train))
        tp = model.predict_proba(train[cols])[:, 1]; pooled = float(np.percentile(tp, wf.APPROVAL_PERCENTILE)); rth = train['is_rth_int'].values.astype(bool)
        t_rth = float(np.percentile(tp[rth], wf.APPROVAL_PERCENTILE)) if rth.sum() >= wf.MIN_SPLIT_N else pooled; t_glx = float(np.percentile(tp[~rth], wf.APPROVAL_PERCENTILE)) if (~rth).sum() >= wf.MIN_SPLIT_N else pooled
        fp = model.predict_proba(fold[cols])[:, 1]
        if fold['label'].nunique() > 1: aucs.append((fs.strftime('%Y-%m-%d'), float(roc_auc_score(fold['label'], fp))))
        th = np.where(fold['is_rth_int'].values.astype(bool), t_rth, t_glx)
        o = fold[['id', 'trade_date', 'actual_pnl']].copy(); o['take'] = (fp >= th).astype(int); o['fold'] = fs.strftime('%Y-%m-%d'); out.append(o); fs = fe
    return pd.concat(out, ignore_index=True), aucs
def summarize(runs):
    """runs: list of (frame, aucs) over seeds -> dict with seed-averaged fold AUC and the per-trade seed-averaged policy P&L aligned by id."""
    auc = float(np.mean([np.mean([a for _, a in aucs]) for _, aucs in runs])); frames = [r[0].set_index('id') for r in runs]
    ids = frames[0].index; pol = np.mean([(f.loc[ids, 'take'] * np.nan_to_num(f.loc[ids, 'actual_pnl'].values, nan=0.0)).values for f in frames], axis=0)
    take_n = float(np.mean([f['take'].sum() for f in frames])); take_pnl = float(np.mean([(f['take'] * np.nan_to_num(f['actual_pnl'].values, nan=0.0)).sum() for f in frames]))
    base = frames[0]; return dict(auc=auc, per_seed_auc=[float(np.mean([a for _, a in aucs])) for _, aucs in runs], pol=pol, ids=np.array(ids), days=base.loc[ids, 'trade_date'].values, fold=base.loc[ids, 'fold'].values, take_n=take_n, take_pnl=take_pnl, n=len(ids), policy_per_trade=float(pol.mean()))
def boot_diff(d, days, n=BOOT, seed=20261020):
    rng = np.random.default_rng(seed); ud = np.unique(days); idx = {u: np.where(days == u)[0] for u in ud}; out = []
    for _ in range(n):
        pick = rng.choice(ud, size=len(ud), replace=True); sel = np.concatenate([idx[u] for u in pick]); out.append(d[sel].mean())
    return float(np.percentile(out, 0.5)), float(np.percentile(out, 99.5))
def main():
    conn = get_connection(); hp = load_hyperparams(conn); df, cols0 = fetch_training_dataframe(conn)
    df = df.assign(_fired_dt=pd.to_datetime(df['fired_at'], format='mixed')).sort_values('_fired_dt').reset_index(drop=True)
    ids = tuple(df['id'].tolist()); df = df.merge(pd.read_sql(f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {ids}", conn), on='id')
    cand = pd.read_csv(os.path.join(ROOT, 'scratch', 'ml_candidate_features_20261020.csv')); df = df.merge(cand, on='id', how='left')
    print(f'rows {len(df)}, {df["_fired_dt"].min()} .. {df["_fired_dt"].max()}; hyperparameters {hp}; candidate features present for {df["ctx_rank"].notna().sum()} rows ({df["ctx_rank"].notna().mean():.0%})')
    G = {'A1 prior-day level distances': [f'pd_{k}' for k in PD_FEATURE_KEYS if k.startswith('distTo')], 'A2 prior-day structure': [f'pd_{k}' for k in PD_FEATURE_KEYS if not k.startswith('distTo')], 'A3 value migration': [f'pd_migration_{c}' for c in MIGRATION_CATEGORIES],
         'A4 developing-level distances': [f'intraday_{k}' for k in INTRADAY_FEATURE_KEYS if k.startswith('distTo')], 'A5 session cumulative delta': ['intraday_sessionCumulativeDelta'], 'A6 recent 15-bar delta (raw and aligned)': ['intraday_recentDelta15Bars', 'drv_recentDeltaAligned15Bars'],
         'A7 time in session': ['intraday_barsInSessionSoFar', 'minutes_from_open'], 'A8 nl30': ['nl30_at_detection'], 'A9 confluence score': ['confluence_score_at_detection'], 'A10 trade direction': ['drv_is_long']}
    for k, v in G.items():
        miss = [c for c in v if c not in cols0]; assert not miss, (k, miss)
    assert sorted(sum(G.values(), [])) == sorted(cols0), 'groups must partition the current feature list exactly'
    B = {'B1 day type': ['ctx_rank', 'dev_range_atr'], 'B2 order flow vs normal': ['adv_rank_15', 'adv_rank_30'], 'B3 rotation gate and chop': ['rot_agree', 'leg_age_bars', 'rot_count']}; B['B4 all three'] = sum(B.values(), [])
    # regression check: seed-42 baseline equals walkforward.py's own fold AUCs
    res_wf, sums_wf, _ = wf.run_walkforward_folds(df, cols0, hp); wf_auc = [s['fold_auc'] for s in sums_wf if s['fold_auc'] is not None]
    base_runs = [run_arm(df, cols0, hp, s) for s in SEEDS_BASE]; chk = [round(a, 4) for _, a in base_runs[0][1]]; print('regression vs walkforward.py (seed 42 fold AUCs equal):', [round(x, 4) for x in wf_auc] == chk)
    arm_seeds = lambda cols: [run_arm(df, cols, hp, 42)]
    base = summarize(base_runs); rng = np.random.default_rng(20261020); nulls = []
    for i in range(N_NULL): df[f'null{i}'] = rng.normal(size=len(df)); nulls.append(summarize(arm_seeds(cols0 + [f'null{i}'])))
    sd_auc = float(np.std([n['auc'] for n in nulls], ddof=1)); sd_pol = float(np.std([n['policy_per_trade'] for n in nulls], ddof=1))
    print(f'BASELINE: fold-averaged AUC {base["auc"]:.4f}, policy P&L per trade {base["policy_per_trade"]:+.3f}, approved {base["take_n"]:.0f} of {base["n"]}, approved P&L {base["take_pnl"]:+.0f}, all-trades mean {np.nanmean(df["actual_pnl"]):+.2f}')
    print(f'NULL-COLUMN noise band over {N_NULL} random columns: AUC mean {np.mean([n["auc"] for n in nulls]):.4f} SD {sd_auc:.4f} (range {min(n["auc"] for n in nulls):.4f}..{max(n["auc"] for n in nulls):.4f}); policy per trade SD {sd_pol:.3f}')
    base3 = base; half = np.median(pd.to_datetime(base3['fold']).astype('int64')); rows = []; has = df['ctx_rank'].notna().values
    for i in range(7): df[f'cm{i}'] = np.where(has, rng.normal(size=len(df)), np.nan)    # random columns with the candidates' exact blank pattern
    df['rth_flag'] = df['is_rth_int']
    C1 = summarize(arm_seeds(cols0 + ['rth_flag'])); C2 = summarize(arm_seeds(cols0 + ['cm0', 'cm1'])); C3 = summarize(arm_seeds(cols0 + [f'cm{i}' for i in range(7)]))
    for nm, c in (('C1 RTH flag only', C1), ('C2 two random columns, blank like the candidates', C2), ('C3 seven random columns, blank like the candidates', C3)): print(f'CONTROL {nm:52s} AUC {c["auc"]:.4f} (vs baseline {c["auc"] - base["auc"]:+.4f} = {(c["auc"] - base["auc"]) / sd_auc:+.1f} null SD) | policy/trade {c["policy_per_trade"]:+.3f}')
    def judge(name, s_, kind, ref=None):
        ref = ref or base3; dd = (base3['pol'] - s_['pol']) if kind == 'A' else (s_['pol'] - ref['pol']); lo, hi = boot_diff(dd, base3['days']); dauc = (base3['auc'] - s_['auc']) if kind == 'A' else (s_['auc'] - ref['auc']); z = dauc / sd_auc
        m1 = pd.to_datetime(base3['fold']).astype('int64') <= half; h1 = dd[m1].mean(); h2 = dd[~m1].mean()
        if kind == 'A': label = 'MATTERS' if (z > 2 and lo > 0) else ('HURTS (removal helps)' if (z < -2 or hi < 0) else 'NOT HELPING (within noise)')
        else: label = 'ADDS VALUE' if (z > 2 and lo > 0 and h1 > 0 and h2 > 0) else 'research only'
        rows.append(dict(arm=name, auc=s_['auc'], d_auc=dauc, d_auc_in_null_sd=z, policy_per_trade=s_['policy_per_trade'], diff_per_trade=float(dd.mean()), ci_lo=lo, ci_hi=hi, half1=float(h1), half2=float(h2), approved=s_['take_n'], label=label))
        print(f'{name:44s} AUC {s_["auc"]:.4f} (delta {dauc:+.4f} = {z:+.1f} null SD) | policy/trade {s_["policy_per_trade"]:+.3f} | diff {dd.mean():+.3f} CI99 [{lo:+.3f},{hi:+.3f}] halves {h1:+.3f}/{h2:+.3f} | approved {s_["take_n"]:.0f} -> {label}')
    print('\n--- A arms: remove one group (diff = baseline minus arm; positive = removing it HURTS) ---')
    for k, v in G.items(): judge(k, summarize(arm_seeds([c for c in cols0 if c not in v])), 'A')
    print('\n--- B arms: add candidate columns (diff = arm minus baseline; positive = adding it HELPS) ---')
    print('(B arms are judged against their matching control: B1-B3 vs C2, B4 vs C3)')
    for k, v in B.items(): judge(k, summarize(arm_seeds(cols0 + v)), 'B', ref=(C3 if k.startswith('B4') else C2))
    json.dump(dict(baseline=dict(auc=base['auc'], sd_auc_null=sd_auc, policy=base['policy_per_trade'], sd_pol_null=sd_pol, take_n=base['take_n'], n=base['n']), controls=dict(C1=C1['auc'], C2=C2['auc'], C3=C3['auc']), arms=rows), open(os.path.join(ROOT, 'scratch', 'ml_ablation_results_20261020.json'), 'w'), indent=1)
if __name__ == '__main__': main()
