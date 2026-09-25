"""Real dollar-impact test of the direction-signed tick model against genuinely HELD-OUT
past trades -- not the frozen model (which was trained on ALL historical data through its
cutoff, so scoring it against past trades would be circular/in-sample), but a fresh
logistic/TICK_SIGNED fit on the same day-blocked TRAIN split, scored on the same
day-blocked TEST split it never saw. Reports real actual_pnl, not just AUC, per the
audit's own "report dollars per selected trade, not just AUC" rule (section 6 item 5) --
this specific check was still missing before now.
"""
import json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from train_fade_outcome_model import load_data, day_blocked_split, TICK_SIGNED_COLS, RANDOM_SEED


def main():
    df = load_data()
    sub = df.dropna(subset=TICK_SIGNED_COLS + ['label', 'actual_pnl'])
    print(f"Rows with real actual_pnl + full feature set: {len(sub)} / {len(df)}")

    train_days, val_days, test_days = day_blocked_split(sub)
    train_df = sub[sub['trade_date'].isin(train_days)]
    test_df = sub[sub['trade_date'].isin(test_days)].copy()
    print(f"Train: {len(train_df)} rows / {len(train_days)} days, Test: {len(test_df)} rows / {test_df['trade_date'].nunique()} days")
    print(f"Test set real $ if EVERY trade taken (no filter): total=${test_df['actual_pnl'].sum():.2f}, mean=${test_df['actual_pnl'].mean():.2f}/trade")

    scaler = StandardScaler()
    X_train = scaler.fit_transform(train_df[TICK_SIGNED_COLS])
    X_test = scaler.transform(test_df[TICK_SIGNED_COLS])
    model = LogisticRegression(max_iter=1000, random_state=RANDOM_SEED)
    model.fit(X_train, train_df['label'])
    test_df['pred_proba'] = model.predict_proba(X_test)[:, 1]

    # Tercile by the model's OWN predicted probability of TARGET_HIT -- does a higher
    # predicted probability actually correspond to better REAL $ outcomes on trades the
    # model never trained on?
    test_df['pred_tercile'] = pd.qcut(test_df['pred_proba'], 3, labels=['T1_lowest', 'T2_mid', 'T3_highest'], duplicates='drop')
    summary = test_df.groupby('pred_tercile', observed=True)['actual_pnl'].agg(['mean', 'sum', 'count'])
    print(f"\nReal $ by predicted-probability tercile (held-out test days, never trained on):\n{summary.to_string()}")

    t1 = test_df[test_df['pred_tercile'] == 'T1_lowest']
    t3 = test_df[test_df['pred_tercile'] == 'T3_highest']
    print(f"\nT3 (model most confident) - T1 (model least confident): ${t3['actual_pnl'].mean() - t1['actual_pnl'].mean():.2f}/trade")

    # A simple "would filtering by this model have helped" simulation: only take trades
    # where predicted P(target_hit) is above the median (the kind of threshold a live
    # TAKE/VETO gate would actually use), compare real $ against taking everything.
    median_proba = test_df['pred_proba'].median()
    filtered = test_df[test_df['pred_proba'] >= median_proba]
    print(f"\nFilter simulation: taking only trades with predicted P(target_hit) >= median ({median_proba:.3f})")
    print(f"  Filtered: N={len(filtered)}, total=${filtered['actual_pnl'].sum():.2f}, mean=${filtered['actual_pnl'].mean():.2f}/trade")
    print(f"  All (no filter): N={len(test_df)}, total=${test_df['actual_pnl'].sum():.2f}, mean=${test_df['actual_pnl'].mean():.2f}/trade")

    # Export per-row results for the JS day-blocked bootstrap CI (this codebase's own
    # canonical dayBlockedBootstrapDeltaCI/collapseClusterSiblings, per the "keep exporting
    # per-row results as JSON so the JS rigor functions remain the single source of truth"
    # convention -- walkforward.py's own pattern, reused here rather than hand-rolling a
    # bootstrap in Python a second time).
    export = test_df[['id', 'trade_date', 'actual_pnl', 'pred_tercile']].copy()
    export['trade_date'] = export['trade_date'].astype(str)
    export.to_json('/home/mmoniz/trading-journal/scratch/dollar_impact_test_rows.json', orient='records')
    print(f"\nExported {len(export)} rows to scratch/dollar_impact_test_rows.json for the JS day-blocked CI")


if __name__ == '__main__':
    main()
