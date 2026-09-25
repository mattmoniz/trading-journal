"""Ordinal 'how far will it run' model applied to the FULL real setup roster (not just
FADE types), using ONLY bar-level features (no tick pipeline) -- per explicit user request
2026-09-24: "point the how far will it run model and apply it to ALL setups. Isn't that the
point for learning" -- and the immediate follow-up correction after I started rebuilding the
full tick dataset for this: "Oh i thought we were done with the ticks and depth stuff per
recommendation" (correct catch -- Step 1's own finding, TICK_SIGNED vs BAR_CONTROL AUC 0.5481
vs 0.5480, said the tick pipeline doesn't earn its cost; this script honors that finding by
using ONLY the 3 cheap bar-level features, not tick order-flow features).

Same model choice and validation discipline as train_ordinal_model.py (statsmodels
OrderedModel, cumulative logit, day-blocked split, 200-permutation day-block label
permutation null) -- applied to scripts/tick_microstructure/build_bar_only_dataset.py's
output instead of the tick-derived one.
"""
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from statsmodels.miscmodels.ordinal_model import OrderedModel
from sklearn.preprocessing import StandardScaler

from train_fade_outcome_model import day_blocked_split, RANDOM_SEED

DATA_PATH = '/home/mmoniz/trading-journal/scratch/bar_only_all_setups_outcomes.csv'
BAR_FEATURES = ['bar_ofi_15', 'bar_efficiency_ratio_15', 'bar_realized_vol_15', 'dir']
N_PERMUTATIONS = 200


def load_data():
    df = pd.read_csv(DATA_PATH)
    df['fired_at_et'] = pd.to_datetime(df['fired_at_et'], format='ISO8601', utc=True).dt.tz_convert('America/New_York')
    df['trade_date'] = df['fired_at_et'].dt.date
    return df


def fit_and_predict(train_df, test_df, features, seed=RANDOM_SEED):
    scaler = StandardScaler()
    X_train = scaler.fit_transform(train_df[features])
    X_test = scaler.transform(test_df[features])
    model = OrderedModel(train_df['reach_r_bucket'].astype(int), X_train, distr='logit')
    res = model.fit(method='bfgs', disp=False, maxiter=200)
    proba = res.model.predict(res.params, exog=X_test)
    expected_bucket = proba @ np.arange(proba.shape[1])
    return expected_bucket, res


def main():
    df = load_data()
    rth_df = df.dropna(subset=BAR_FEATURES + ['reach_r_bucket']).copy()
    rth_df['reach_r_bucket'] = rth_df['reach_r_bucket'].astype(int)
    print(f"ALL-SETUPS rows with a real reach_R bucket: {len(rth_df)} / {len(df)} total rows, "
          f"{rth_df['trade_date'].nunique()} distinct days, "
          f"{rth_df['setup_type'].nunique()} distinct setup_types")
    print("Bucket distribution:")
    print(rth_df['reach_r_bucket'].value_counts().sort_index().to_string())

    train_days, val_days, test_days = day_blocked_split(rth_df)
    train_df = rth_df[rth_df['trade_date'].isin(train_days)]
    test_df = rth_df[rth_df['trade_date'].isin(test_days)]
    print(f"\nTrain: {len(train_df)} rows / {len(train_days)} days, Test: {len(test_df)} rows / {test_df['trade_date'].nunique()} days")
    if len(train_df) < 30 or len(test_df) < 10:
        print("FAILED: insufficient data for a day-blocked ordinal fit.")
        return

    print("\nFitting OrderedModel (cumulative logit, bar-only features) on ALL real setup types...")
    expected_bucket, res = fit_and_predict(train_df, test_df, BAR_FEATURES)
    rho, pval = spearmanr(expected_bucket, test_df['reach_r_bucket'])
    print(f"REAL: Spearman(expected_bucket, actual_bucket) = {rho:.4f} (p={pval:.4f})")

    test_df = test_df.copy()
    test_df['expected_bucket'] = expected_bucket
    test_df['score_tercile'] = pd.qcut(test_df['expected_bucket'], 3, labels=['T1', 'T2', 'T3'], duplicates='drop')
    calib = test_df.groupby('score_tercile', observed=True)['reach_r_bucket'].agg(['mean', 'count'])
    print(f"\nCalibration (actual mean reach_r_bucket by predicted-score tercile):\n{calib.to_string()}")
    monotone = calib['mean'].is_monotonic_increasing
    print(f"Monotone: {monotone}")

    rng = np.random.RandomState(RANDOM_SEED)
    all_days = sorted(set(train_df['trade_date']) | set(test_df['trade_date']))
    day_labels = {d: rth_df.loc[rth_df['trade_date'] == d, 'reach_r_bucket'].values for d in all_days}
    null_rhos = []
    for _ in range(N_PERMUTATIONS):
        shuffled_days = list(all_days)
        rng.shuffle(shuffled_days)
        day_map = dict(zip(all_days, shuffled_days))
        perm_train = train_df.copy()
        for d in train_df['trade_date'].unique():
            mask = perm_train['trade_date'] == d
            donor = day_labels[day_map[d]]
            if mask.sum() == len(donor):
                perm_train.loc[mask, 'reach_r_bucket'] = donor
            else:
                perm_train.loc[mask, 'reach_r_bucket'] = donor[rng.randint(0, len(donor), size=mask.sum())]
        expected_bucket_null, _ = fit_and_predict(perm_train, test_df, BAR_FEATURES)
        rho_null_i, _ = spearmanr(expected_bucket_null, test_df['reach_r_bucket'])
        null_rhos.append(rho_null_i)
    null_rhos = np.array(null_rhos)
    print(f"\nDAY-BLOCK LABEL PERMUTATION NULL ({N_PERMUTATIONS} draws): "
          f"mean={null_rhos.mean():.4f}, std={null_rhos.std():.4f}")
    pct_beats = (np.abs(null_rhos) >= abs(rho)).mean()
    print(f"Fraction of null |Spearman| >= real |Spearman| ({abs(rho):.4f}): {pct_beats:.3f} (empirical p-value)")

    print(f"\n=== Harness sanity summary ===")
    print(f"Calibration monotone: {monotone}")
    print(f"No leakage (null centered near 0): {abs(null_rhos.mean()) < 0.05}")
    print(f"Real Spearman > 0: {rho > 0}")
    print(f"Clears 200-permutation null (p < 0.05): {pct_beats < 0.05}")


if __name__ == '__main__':
    main()
