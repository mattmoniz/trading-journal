"""Step 3 of docs/ML_SIMPLE_RULE_AND_FAMILY_PREREG_20261020.md (addendum committed before this ran). Pace inputs from scratch/ml_pace_20261020.csv (scripts/export_ml_pace_20261020.mjs).
Run: ./venv/bin/python scripts/ml_meta_labeling/pace_20261020.py   Offline research only."""
import sys, os, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from db import get_connection
from dataset import fetch_training_dataframe
from hyperparams import load_hyperparams
import walkforward as wf
import simple_rule_and_family_20261020 as S
from ablation_new_features_20261020 import run_arm, summarize, boot_diff
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
def main():
    conn = get_connection(); hp = load_hyperparams(conn); df, cols0 = fetch_training_dataframe(conn, full_features=True)
    df = df.assign(_fired_dt=pd.to_datetime(df['fired_at'], format='mixed')).sort_values('_fired_dt').reset_index(drop=True)
    ids = tuple(df['id'].tolist()); df = df.merge(pd.read_sql(f"SELECT id, actual_pnl::float AS actual_pnl FROM active_setups WHERE id IN {ids}", conn), on='id')
    df = df.merge(pd.read_csv(os.path.join(ROOT, 'scratch', 'ml_pace_20261020.csv')), on='id', how='left')
    df['pnl0'] = df['actual_pnl'].fillna(0.0); df['smin'] = S.session_minutes(df); df['family'] = df['setup_type']
    print(f'rows {len(df)}, pace present {df["pace_15"].notna().mean():.1%}; pace_5 mean {df["pace_5"].mean():+.3f} median {df["pace_5"].median():+.3f}; pace_15 mean {df["pace_15"].mean():+.3f} median {df["pace_15"].median():+.3f}')
    base = summarize([run_arm(df, cols0, hp, 42)]); rng = np.random.default_rng(20261020); nulls = []
    for i in range(8): df[f'na{i}'] = rng.normal(size=len(df)); df[f'nb{i}'] = rng.normal(size=len(df)); nulls.append(summarize([run_arm(df, cols0 + [f'na{i}', f'nb{i}'], hp, 42)]))
    sd = float(np.std([n['auc'] for n in nulls], ddof=1)); print(f'M0: AUC {base["auc"]:.4f}, policy/trade {base["policy_per_trade"]:+.3f}, approved {base["take_n"]:.0f}; noise band (8 arms, 2 random columns each): AUC mean {np.mean([n["auc"] for n in nulls]):.4f} SD {sd:.4f}')
    P0 = summarize([run_arm(df, cols0 + ['pace_5', 'pace_15'], hp, 42)])
    # rules (R1 time only, R4 time x pace tercile) -- reuse step 1 machinery by pointing the flow column at pace_15
    df['drv_recentDeltaAligned15Bars_orig'] = df['drv_recentDeltaAligned15Bars']
    r1 = {k: summarize([S.run_rule(df, k)]) for k in ('R1', 'R1L')}
    df['drv_recentDeltaAligned15Bars'] = df['pace_15']
    r4 = {k: summarize([S.run_rule(df, k)]) for k in ('R2', 'R2L')}   # R2 machinery with the flow column replaced by pace_15 == R4 / R4L
    df['drv_recentDeltaAligned15Bars'] = df['drv_recentDeltaAligned15Bars_orig']
    half = np.median(pd.to_datetime(base['fold']).astype('int64')); m1 = pd.to_datetime(base['fold']).astype('int64') <= half; rows = []
    def cmp(name, a, b, kind):
        assert (a['ids'] == b['ids']).all(); dd = a['pol'] - b['pol']; lo, hi = boot_diff(dd, a['days']); dauc = a['auc'] - b['auc']; z = dauc / sd; h1 = dd[m1].mean(); h2 = dd[~m1].mean()
        if kind == 'helps': label = 'PACE HELPS' if (z > 2 and lo > 0 and h1 > 0 and h2 > 0) else 'research only'
        else: label = 'MIXED/AS GOOD' if not (z > 2 and lo > 0) and not (z < -2 or hi < 0) else ('A BETTER' if (z > 2 and lo > 0) else 'B BETTER')
        rows.append(dict(comparison=name, auc_a=a['auc'], auc_b=b['auc'], d_auc_sd=z, diff=float(dd.mean()), ci_lo=lo, ci_hi=hi, half1=float(h1), half2=float(h2), label=label))
        print(f'{name:30s} AUC {a["auc"]:.4f} vs {b["auc"]:.4f} ({dauc:+.4f} = {z:+.1f} SD) | policy/trade {a["policy_per_trade"]:+.3f} vs {b["policy_per_trade"]:+.3f} | diff {dd.mean():+.3f} CI99 [{lo:+.3f},{hi:+.3f}] halves {h1:+.3f}/{h2:+.3f} | approved {a["take_n"]:.0f} vs {b["take_n"]:.0f} -> {label}')
    for nm, x in (('R1', r1['R1']), ('R1L', r1['R1L']), ('R4 time x pace', r4['R2']), ('R4L time x pace (label)', r4['R2L'])): print(f'{nm:26s} AUC {x["auc"]:.4f}, policy/trade {x["policy_per_trade"]:+.3f}, approved {x["take_n"]:.0f}')
    cmp('P0 (M0+pace) vs M0', P0, base, 'helps'); cmp('R4 vs R1', r4['R2'], r1['R1'], 'helps'); cmp('R4L vs R1L', r4['R2L'], r1['R1L'], 'helps')
    cmp('P0 vs R4', P0, r4['R2'], 'rule'); cmp('P0 vs R4L', P0, r4['R2L'], 'rule')
    json.dump(dict(sd=sd, base=dict(auc=base['auc'], pol=base['policy_per_trade']), P0=dict(auc=P0['auc'], pol=P0['policy_per_trade'], take=P0['take_n']), rows=rows), open(os.path.join(ROOT, 'scratch', 'ml_pace_results_20261020.json'), 'w'), indent=1)
if __name__ == '__main__': main()
