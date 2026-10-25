"""Greedy forward selection from the 4-input base: docs/ML_FORWARD_SELECTION_PREREG_20261026.md (committed 27e0955 before this ran). Offline research; nothing live changes.
Run: ./venv/bin/python scripts/ml_meta_labeling/forward_selection_20261026.py   (needs scratch/ml_candidate_features_20261020.csv and scratch/ml_level_features_20261021.csv)"""
import sys, os, json, time
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe, PD_FEATURE_KEYS, INTRADAY_FEATURE_KEYS, MIGRATION_CATEGORIES
from hyperparams import load_hyperparams
from ablation_new_features_20261020 import run_arm, summarize, boot_diff
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BASE = ['intraday_barsInSessionSoFar', 'minutes_from_open', 'intraday_recentDelta15Bars', 'drv_recentDeltaAligned15Bars']
MAX_ROUNDS, N_NULL, Z_MIN = 6, 8, 2.0
def main():
    t0 = time.time(); conn = get_connection(); hp = load_hyperparams(conn); df, cols0 = fetch_training_dataframe(conn, full_features=True)
    df = df.assign(_fired_dt=pd.to_datetime(df['fired_at'], format='mixed')).sort_values('_fired_dt').reset_index(drop=True)
    ids = tuple(df['id'].tolist()); df = df.merge(pd.read_sql(f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {ids}", conn), on='id')
    df = df.merge(pd.read_csv(os.path.join(ROOT, 'scratch', 'ml_candidate_features_20261020.csv')), on='id', how='left').merge(pd.read_csv(os.path.join(ROOT, 'scratch', 'ml_level_features_20261021.csv')), on='id', how='left')
    df['family'] = df['setup_type'].str.replace(r'_(LONG|SHORT)(_.*)?$', '', regex=True); fam_cats = sorted(df['family'].unique()); df['family'] = pd.Categorical(df['family'], categories=fam_cats)
    G = {'A1 prior-day level distances': [f'pd_{k}' for k in PD_FEATURE_KEYS if k.startswith('distTo')], 'A2 prior-day structure': [f'pd_{k}' for k in PD_FEATURE_KEYS if not k.startswith('distTo')],
         'A3 value migration': [f'pd_migration_{c}' for c in MIGRATION_CATEGORIES], 'A4 developing-level distances': [f'intraday_{k}' for k in INTRADAY_FEATURE_KEYS if k.startswith('distTo')],
         'A5 session cumulative delta': ['intraday_sessionCumulativeDelta'], 'A8 nl30': ['nl30_at_detection'], 'A9 confluence score': ['confluence_score_at_detection'], 'A10 trade direction': ['drv_is_long'],
         'B1 day type': ['ctx_rank', 'dev_range_atr'], 'B2 order flow vs normal': ['adv_rank_15', 'adv_rank_30'], 'B3 rotation gate and chop': ['rot_agree', 'leg_age_bars', 'rot_count'],
         'L1 overnight high/low distances': ['d_onh', 'd_onl'], 'L2 prior-week level distances': ['d_pw_vah', 'd_pw_val', 'd_pw_high', 'd_pw_low'], 'FAM setup family': ['family']}
    for k, v in G.items():
        miss = [c for c in v if c not in df.columns]; assert not miss, (k, miss)
    print(f'rows {len(df)}, {df["_fired_dt"].min()} .. {df["_fired_dt"].max()}; base {BASE}')
    rng = np.random.default_rng(20261026)
    def control_cols(name, cols):
        out = []
        for c in cols:
            cn = f'rc_{name}_{c}_{len(df)}'
            if cn not in df.columns:
                if str(df[c].dtype) == 'category': df[cn] = pd.Categorical(rng.permutation(df[c].astype(str).values), categories=fam_cats)
                else: df[cn] = np.where(df[c].notna(), rng.normal(size=len(df)), np.nan)
            out.append(cn)
        return out
    base_summary = summarize([run_arm(df, BASE, hp, 42)]); print(f'BASE-4: AUC {base_summary["auc"]:.4f}, policy/trade {base_summary["pol"].mean():+.3f}, approved {base_summary["take_n"]:.0f} of {base_summary["n"]}  ({time.time()-t0:.0f}s)')
    current = list(BASE); chosen = []; remaining = dict(G); log = []
    for rnd in range(1, MAX_ROUNDS + 1):
        cur = summarize([run_arm(df, current, hp, 42)]); nulls = []
        for i in range(N_NULL):
            df[f'null{i}'] = rng.normal(size=len(df)); nulls.append(summarize([run_arm(df, current + [f'null{i}'], hp, 42)])['auc'])
        sd = float(np.std(nulls, ddof=1)); rows = []
        for name, cols in remaining.items():
            ctrl = summarize([run_arm(df, current + control_cols(name, cols), hp, 42)]); arm = summarize([run_arm(df, current + cols, hp, 42)])
            dd = arm['pol'] - ctrl['pol']; lo, hi = boot_diff(dd, cur['days']); z = (arm['auc'] - ctrl['auc']) / sd
            rows.append(dict(name=name, arm_auc=arm['auc'], ctrl_auc=ctrl['auc'], z=z, arm_pol=float(arm['pol'].mean()), ctrl_pol=float(ctrl['pol'].mean()), dpol=float(dd.mean()), lo=lo, hi=hi, take_n=arm['take_n']))
        rows.sort(key=lambda r: -r['z'])
        print(f'\n=== ROUND {rnd}: current {len(current)} inputs, AUC {cur["auc"]:.4f}, policy/trade {cur["pol"].mean():+.3f}; null SD {sd:.4f} ({time.time()-t0:.0f}s)')
        for r in rows: print(f'  {r["name"]:34s} AUC {r["arm_auc"]:.4f} vs control {r["ctrl_auc"]:.4f} z {r["z"]:+5.1f} | policy {r["arm_pol"]:+.2f} vs {r["ctrl_pol"]:+.2f} diff {r["dpol"]:+.2f} CI99 [{r["lo"]:+.2f},{r["hi"]:+.2f}]')
        ok = [r for r in rows if r['z'] >= Z_MIN and r['dpol'] >= 0]; log.append(dict(round=rnd, current=list(current), auc=cur['auc'], pol=float(cur['pol'].mean()), sd=sd, table=rows))
        if not ok: print('  -> no candidate qualifies (z >= 2 and dollar diff >= 0); stop'); break
        pick = ok[0]; print(f'  -> ACCEPT {pick["name"]} (z {pick["z"]:+.1f}, dollar diff {pick["dpol"]:+.2f})'); chosen.append(pick['name']); current += remaining.pop(pick['name'])
        if not remaining: break
    final = summarize([run_arm(df, current, hp, 42)])
    print(f'\nFINAL set ({len(current)} inputs; accepted groups {chosen}): AUC {final["auc"]:.4f}, policy/trade {final["pol"].mean():+.3f}, approved {final["take_n"]:.0f} of {final["n"]}   [M0 27 inputs: AUC 0.5859, +0.51; 17 inputs: 0.5986, +0.31; base 4: {base_summary["auc"]:.4f}, {base_summary["pol"].mean():+.3f}]')
    json.dump(dict(base=BASE, final=current, chosen=chosen, final_auc=final['auc'], final_policy=float(final['pol'].mean()), base_auc=base_summary['auc'], rounds=log), open(os.path.join(ROOT, 'scratch', 'ml_forward_selection_20261026.json'), 'w'), indent=1, default=str)
if __name__ == '__main__': main()
