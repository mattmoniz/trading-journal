"""Opus Audit #14 (2026-09-24) section 2.3 -- Track B upgraded to the one ordinal
first-passage target instead of the binary STOP_HIT/TARGET_HIT label. reach_R buckets:
{<0.5R, 0.5-1R, 1-1.5R, 1.5-2R, 2-3R, >=3R} (build_trade_level_dataset.py's
compute_reach_r(), RTH-only, H=240 bars, stop-first tie-break, uncensored MFE).

Model, per the audit's own explicit order ("use an ordinal logistic regression (cumulative
link) on <=10 pre-specified features first. LightGBM earns its place only if it beats that
baseline"): statsmodels' OrderedModel (a real cumulative-link ordinal logistic regression,
not a hand-rolled approximation), fit on the top-10 features by gain from the earlier
TICK_SIGNED/LightGBM binary run (train_fade_outcome_model.py) -- reusing an already-computed
ranking rather than guessing a feature subset.

Pass/kill per the audit's own rank-order table (section 7, step 3): "Harness sanity:
calibration curve monotone; no leakage (a shuffled-feature control ~= 0.5); the model's EV
ranks real P&L (Spearman > 0) out-of-fold." This step is explicitly NOT a go/no-go gate for
the market-event substrate (step 4) -- a null here at ~44 RTH test days is uninformative by
construction, it only validates the harness end-to-end.
"""
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from statsmodels.miscmodels.ordinal_model import OrderedModel
from sklearn.preprocessing import StandardScaler

from train_fade_outcome_model import load_data, day_blocked_split, RANDOM_SEED

# Top-10 features by LightGBM gain from the TICK_SIGNED binary run (2026-09-24) -- reused,
# not re-picked, per the audit's own "<=10 pre-specified features."
ORDINAL_FEATURES = [
    'trailing_elapsed_mean_medium', 'ofi_abs_mean_medium', 'signed_efficiency_toward_trade_long',
    'ofi_abs_mean_long', 'efficiency_ratio_short', 'signed_trailing_ofi_mean_long',
    'efficiency_ratio_long', 'signed_trailing_ofi_mean_medium',
    'signed_efficiency_toward_trade_medium', 'pace_divergence_short_long',
]
N_BUCKETS = 6
N_PERMUTATIONS = 200  # matches the standard convention elsewhere in this session -- fixed
                       # 2026-09-24 after DeepSeek code review correctly found the null here
                       # was a single draw (1 shuffle, 1 Spearman), materially weaker than
                       # the 200-permutation null used everywhere else in this thread.


def fit_and_predict(train_df, test_df, features, seed=RANDOM_SEED):
    scaler = StandardScaler()
    X_train = scaler.fit_transform(train_df[features])
    X_test = scaler.transform(test_df[features])
    model = OrderedModel(train_df['reach_r_bucket'].astype(int), X_train, distr='logit')
    res = model.fit(method='bfgs', disp=False, maxiter=200)
    proba = res.model.predict(res.params, exog=X_test)  # (n_test, N_BUCKETS)
    expected_bucket = proba @ np.arange(proba.shape[1])
    return expected_bucket, res


def main():
    df = load_data()
    rth_df = df.dropna(subset=ORDINAL_FEATURES + ['reach_r_bucket']).copy()
    rth_df['reach_r_bucket'] = rth_df['reach_r_bucket'].astype(int)
    print(f"RTH rows with a real reach_R bucket: {len(rth_df)} / {len(df)} total rows, "
          f"{rth_df['trade_date'].nunique()} distinct days")
    print("Bucket distribution:")
    print(rth_df['reach_r_bucket'].value_counts().sort_index().to_string())

    train_days, val_days, test_days = day_blocked_split(rth_df)
    train_df = rth_df[rth_df['trade_date'].isin(train_days)]
    test_df = rth_df[rth_df['trade_date'].isin(test_days)]
    print(f"\nTrain: {len(train_df)} rows / {len(train_days)} days, Test: {len(test_df)} rows / {test_df['trade_date'].nunique()} days")
    if len(train_df) < 30 or len(test_df) < 10:
        print("FAILED: insufficient RTH data for a day-blocked ordinal fit.")
        return

    print("\nFitting OrderedModel (cumulative logit) on real data...")
    expected_bucket, res = fit_and_predict(train_df, test_df, ORDINAL_FEATURES)
    rho, pval = spearmanr(expected_bucket, test_df['reach_r_bucket'])
    print(f"REAL: Spearman(expected_bucket, actual_bucket) = {rho:.4f} (p={pval:.4f})")

    # Calibration check: bin test rows into terciles of the model's own expected_bucket
    # score and confirm the ACTUAL mean bucket rises monotonically across them.
    test_df = test_df.copy()
    test_df['expected_bucket'] = expected_bucket
    test_df['score_tercile'] = pd.qcut(test_df['expected_bucket'], 3, labels=['T1', 'T2', 'T3'], duplicates='drop')
    calib = test_df.groupby('score_tercile', observed=True)['reach_r_bucket'].agg(['mean', 'count'])
    print(f"\nCalibration (actual mean reach_r_bucket by predicted-score tercile):\n{calib.to_string()}")
    monotone = calib['mean'].is_monotonic_increasing
    print(f"Monotone: {monotone}")

    # Day-block LABEL permutation null (NOT a feature-shuffle) -- matches this codebase's
    # own already-established convention (day_block_permutation_null() in
    # train_fade_outcome_model.py), reused here rather than inventing a different control.
    # A first version of this check shuffled TRAINING features but then scored against the
    # REAL, unshuffled TEST features (only shuffling one side of the fit/predict pair) --
    # since order-flow features are mutually correlated, a garbage-fit model's coefficients
    # can still pick up real structure through the real test features' own correlations,
    # even with a null-trained model. That produced Spearman=0.212 (p=0.0014) on a check
    # meant to be ~0 -- a real methodology bug in the CONTROL, not evidence the real 0.2875
    # result is fake. Fixed: permute which DAY's real labels go with which day's real rows
    # (preserving real features on both train and test, breaking only the feature->label
    # mapping), exactly the null every other Track B model in this session already uses.
    #
    # REWRITTEN 2026-09-24 (DeepSeek code review): the first version of this fix ran only ONE
    # permutation draw and reported ITS Spearman p-value -- a single roll of the dice, not a
    # real null distribution, materially weaker than the 200-permutation convention used
    # everywhere else in this session. Now runs N_PERMUTATIONS draws and reports the
    # empirical fraction of null Spearmans whose ABSOLUTE VALUE meets or exceeds the real
    # Spearman's absolute value (a two-sided empirical p-value -- the null hypothesis is "no
    # relationship," which a strong negative correlation would also violate, not just a
    # strong positive one).
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
        expected_bucket_null, _ = fit_and_predict(perm_train, test_df, ORDINAL_FEATURES)
        rho_null_i, _ = spearmanr(expected_bucket_null, test_df['reach_r_bucket'])
        null_rhos.append(rho_null_i)
    null_rhos = np.array(null_rhos)
    print(f"\nDAY-BLOCK LABEL PERMUTATION NULL ({N_PERMUTATIONS} draws): "
          f"mean={null_rhos.mean():.4f}, std={null_rhos.std():.4f}, "
          f"p5={np.percentile(null_rhos, 5):.4f}, p95={np.percentile(null_rhos, 95):.4f}")
    pct_beats = (np.abs(null_rhos) >= abs(rho)).mean()
    print(f"Fraction of null |Spearman| >= real |Spearman| ({abs(rho):.4f}): {pct_beats:.3f} (empirical p-value)")

    print(f"\n=== Harness sanity summary (Opus Audit #14 step 3 pass/kill) ===")
    print(f"Calibration monotone: {monotone}")
    print(f"No leakage (null distribution centered near 0): {abs(null_rhos.mean()) < 0.05}")
    print(f"Real Spearman > 0: {rho > 0}")
    print(f"Real result clears the 200-permutation null (empirical p < 0.05): {pct_beats < 0.05}")
    all_pass = monotone and abs(null_rhos.mean()) < 0.05 and rho > 0
    print(f"ALL HARNESS CHECKS PASS: {all_pass}")


if __name__ == '__main__':
    main()
