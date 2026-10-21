"""Runs docs/ML_LEVEL_DISTANCE_FEATURES_PREREG_20261021.md (committed b21478e before the export or any arm). Offline research; nothing live changes.
Run: ./venv/bin/python scripts/ml_meta_labeling/ablation_level_distance_20261021.py   (needs scratch/ml_level_features_20261021.csv from scripts/export_ml_level_distance_features_20261021.mjs)"""
import sys, os, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe
from hyperparams import load_hyperparams
from ablation_new_features_20261020 import run_arm, summarize, boot_diff
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
def main():
    conn = get_connection(); hp = load_hyperparams(conn); df, cols0 = fetch_training_dataframe(conn, full_features=True)
    df = df.assign(_fired_dt=pd.to_datetime(df['fired_at'], format='mixed')).sort_values('_fired_dt').reset_index(drop=True)
    ids = tuple(df['id'].tolist()); df = df.merge(pd.read_sql(f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {ids}", conn), on='id')
    lf = pd.read_csv(os.path.join(ROOT, 'scratch', 'ml_level_features_20261021.csv')); df = df.merge(lf, on='id', how='left')
    F = ['d_onh', 'd_onl', 'd_pw_vah', 'd_pw_val', 'd_pw_high', 'd_pw_low']
    print(f'rows {len(df)}; coverage ' + ', '.join(f'{c} {df[c].notna().mean():.0%}' for c in F))
    print('feature medians (ATR20 units):', {c: round(float(df[c].median()), 2) for c in F})
    base = summarize([run_arm(df, cols0, hp, 42)]); rng = np.random.default_rng(20261021); nulls = []
    for i in range(8): df[f'null{i}'] = rng.normal(size=len(df)); nulls.append(summarize([run_arm(df, cols0 + [f'null{i}'], hp, 42)]))
    sd_auc = float(np.std([n['auc'] for n in nulls], ddof=1)); sd_pol = float(np.std([n['policy_per_trade'] for n in nulls], ddof=1))
    print(f'BASELINE M0: AUC {base["auc"]:.4f}, policy/trade {base["policy_per_trade"]:+.3f}, approved {base["take_n"]:.0f} of {base["n"]}; null-column noise band AUC SD {sd_auc:.4f}, policy SD {sd_pol:.3f}')
    for c in F: df['rc_' + c] = np.where(df[c].notna(), rng.normal(size=len(df)), np.nan)
    sets = {'L1 ONH, ONL': ['d_onh', 'd_onl'], 'L2 prior-week VAH, VAL, high, low': ['d_pw_vah', 'd_pw_val', 'd_pw_high', 'd_pw_low'], 'L3 all six': F}
    half = np.median(pd.to_datetime(base['fold']).astype('int64')); m1 = pd.to_datetime(base['fold']).astype('int64') <= half; rows = []
    for nm, cs in sets.items():
        ctrl = summarize([run_arm(df, cols0 + ['rc_' + c for c in cs], hp, 42)]); arm = summarize([run_arm(df, cols0 + cs, hp, 42)])
        dd = arm['pol'] - ctrl['pol']; lo, hi = boot_diff(dd, base['days']); dauc = arm['auc'] - ctrl['auc']; z = dauc / sd_auc; h1 = dd[m1].mean(); h2 = dd[~m1].mean()
        label = 'ADDS VALUE' if (z > 2 and lo > 0 and h1 > 0 and h2 > 0) else 'research only (not shown)'
        rows.append(dict(arm=nm, auc=arm['auc'], control_auc=ctrl['auc'], d_auc_vs_control_sd=z, policy=arm['policy_per_trade'], control_policy=ctrl['policy_per_trade'], diff=float(dd.mean()), ci_lo=lo, ci_hi=hi, half1=float(h1), half2=float(h2), label=label))
        print(f'{nm:38s} AUC {arm["auc"]:.4f} vs control {ctrl["auc"]:.4f} (baseline {base["auc"]:.4f}) = {z:+.1f} null SD | policy/trade {arm["policy_per_trade"]:+.3f} vs control {ctrl["policy_per_trade"]:+.3f} (diff {dd.mean():+.3f} CI99 [{lo:+.3f},{hi:+.3f}], halves {h1:+.3f}/{h2:+.3f}) | approved {arm["take_n"]:.0f} -> {label}')
    json.dump(dict(baseline=dict(auc=base['auc'], policy=base['policy_per_trade']), sd_auc=sd_auc, arms=rows), open(os.path.join(ROOT, 'scratch', 'ml_level_distance_results_20261021.json'), 'w'), indent=1)
if __name__ == '__main__': main()
