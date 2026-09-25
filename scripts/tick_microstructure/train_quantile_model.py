"""MAE/MFE quantile extension to the ordinal model (2026-09-24, DeepSeek path-distribution
proposal, gating test for the level-pair combinatorial idea).

The existing ordinal model (train_ordinal_model.py) predicts one slice of a trade's forward
path: P(reach >= 2R), via a single expected_bucket score. DeepSeek's structural argument:
direct parameter fitting (OPTIMAL_STOP's own "what stop distance worked lately" sweep) is
inherently unstable because it fits an ACTION to a window, and the action jumps when the
window changes -- confirmed independently the same day (check_calibration_drift_vs_atr.mjs:
4/20 flagged setups showed real calibration churn unrelated to volatility). The proposed fix:
predict the full forward MAE/MFE DISTRIBUTION (a stable market property) and derive stop/
target from it via a fixed rule, instead of fitting the stop/target number directly.

This script is the gating test, not the full framework: fit quantile regression (multiple
quantiles, both directions) for MFE (reach_r) and MAE (mae_r) using the SAME top-10 feature
set/day-blocked split as the existing ordinal model, then check via Spearman(predicted
quantile, actual) whether the quantile predictions beat chance. Per DeepSeek's own framing:
a clean negative here is a real, useful answer ("calibrated exits are already as good as
this gets"), not a wasted week -- this gates whether the bigger distribution-based exit
framework (and the level-pair combinatorial idea) is worth building at all.

Fade-only, RTH-only, tick-based -- same scope as the existing ordinal model (a broader
"every setup type" version was tried 2026-09-24 and found negative, different setups don't
share one pattern).

Run manually: venv/bin/python3 scripts/tick_microstructure/train_quantile_model.py
"""
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.linear_model import QuantileRegressor
from sklearn.preprocessing import StandardScaler

from train_fade_outcome_model import load_data, day_blocked_split, RANDOM_SEED
from train_ordinal_model import ORDINAL_FEATURES

QUANTILES = [0.5, 0.75, 0.9]
# MAE (mae_r) is heavily right-censored at the 1.0 stop boundary -- 75.6% of real trades hit
# their full -1R stop within the window, so the TRUE 50th/75th/90th percentiles of mae_r are
# trivially 1.0 by construction (more than half the mass sits at the ceiling). Testing those
# quantiles for MAE is degenerate by design, not a model failure -- confirmed 2026-09-24 via
# a first run that produced constant (nan-Spearman) predictions there. The real, non-
# degenerate signal is in the minority (~24%) that DOESN'T get fully stopped -- use quantiles
# below that ceiling-mass threshold instead.
MAE_QUANTILES = [0.10, 0.15, 0.20]
N_PERMUTATIONS = 200

# The 4 real CALIBRATION_CHURN setup_types found by check_calibration_drift_vs_atr.mjs
# (2026-09-24) -- stops changed for reasons unrelated to volatility for these, so their
# reach_r/mae_r (both R-normalized by each trade's OWN point-in-time stop distance) may
# still reflect a confounded denominator. Held out as a separate sanity-check group, not
# excluded from training -- per DeepSeek: "if it works on both, the drift didn't affect the
# learnable structure; if it works on clean but not drifted, that's evidence the drift is
# real and matters." Either result is informative, so both groups get evaluated.
DRIFTED_SETUP_TYPES = {'ONL_FADE_SHORT', 'CAM_S2_FADE_SHORT', 'OR5_LOW_FADE_SHORT', 'IB_BEARISH'}


def fit_quantiles(train_df, test_df, features, target_col, quantiles):
    scaler = StandardScaler()
    X_train = scaler.fit_transform(train_df[features])
    X_test = scaler.transform(test_df[features])
    y_train = train_df[target_col].values
    preds = {}
    for q in quantiles:
        model = QuantileRegressor(quantile=q, alpha=0.01, solver='highs')
        model.fit(X_train, y_train)
        preds[q] = model.predict(X_test)
    return preds


def evaluate(test_df, target_col, preds, label, quantiles, primary_q):
    y_test = test_df[target_col].values
    results = {}
    # Discriminative check: does the predicted PRIMARY quantile rank-correlate with the
    # actual value? (q=0.5/median for MFE; a low quantile for MAE, since MAE's own median is
    # trivially degenerate -- see MAE_QUANTILES' own comment above.)
    rho, pval = spearmanr(preds[primary_q], y_test)
    results['spearman_primary'] = (rho, pval)
    print(f"  [{label}] Spearman(predicted q{primary_q}, actual {target_col}) = {rho:.4f} (p={pval:.4f}), n={len(y_test)}")

    # Calibration check: for quantile q, what fraction of actual values fall BELOW the
    # predicted q-th quantile? Should be close to q if well-calibrated.
    for q in quantiles:
        coverage = float(np.mean(y_test <= preds[q]))
        print(f"  [{label}] q={q}: predicted coverage={coverage:.3f} (target={q})")
        results[f'coverage_{q}'] = coverage
    return results


def day_block_permutation_null_spearman(df, features, target_col, train_days, test_days, primary_q=0.5, n_perms=N_PERMUTATIONS, seed=RANDOM_SEED):
    """Day-block TARGET permutation null -- exact same shape as this codebase's established
    day_block_permutation_null() (train_fade_outcome_model.py), adapted from a classifier's
    binary label to a regression target. Each permutation reassigns each real day's ROWS the
    REAL per-row target values from a randomly-donor day (sampled with replacement if the
    donor day has a different row count -- preserving real per-row variance, never a day's
    mean), refits a fresh median quantile model on the shuffled train split, and scores it
    against the SAME shuffled test split's permuted target -- never the real one, matching
    the original exactly. A model with no real learned relationship should score near zero
    regardless of which day's real values got reassigned where."""
    rng = np.random.RandomState(seed)
    sub = df.dropna(subset=features + [target_col])
    all_days = sorted(set(train_days) | set(test_days))
    day_targets = {d: sub.loc[sub['trade_date'] == d, target_col].values for d in all_days}

    null_rhos = []
    for _ in range(n_perms):
        shuffled = list(all_days)
        rng.shuffle(shuffled)
        mapping = dict(zip(all_days, shuffled))
        perm_df = sub[sub['trade_date'].isin(all_days)].copy()
        perm_df['perm_y'] = np.nan
        for real_day, donor_day in mapping.items():
            mask = perm_df['trade_date'] == real_day
            block = day_targets[donor_day]
            if len(block) == 0:
                continue
            idx = rng.randint(0, len(block), size=int(mask.sum()))
            perm_df.loc[mask, 'perm_y'] = block[idx]
        train_p = perm_df[perm_df['trade_date'].isin(train_days)].dropna(subset=['perm_y'])
        test_p = perm_df[perm_df['trade_date'].isin(test_days)].dropna(subset=['perm_y'])
        if len(train_p) < 20 or len(test_p) < 5:
            continue
        scaler = StandardScaler()
        X_train = scaler.fit_transform(train_p[features])
        X_test = scaler.transform(test_p[features])
        model = QuantileRegressor(quantile=primary_q, alpha=0.01, solver='highs')
        model.fit(X_train, train_p['perm_y'].values)
        pred = model.predict(X_test)
        rho, _ = spearmanr(pred, test_p['perm_y'].values)
        if not np.isnan(rho):
            null_rhos.append(rho)
    return null_rhos


def main():
    df = load_data()
    rth_df = df.dropna(subset=ORDINAL_FEATURES + ['reach_r', 'mae_r']).copy()
    print(f"RTH rows with real reach_r AND mae_r: {len(rth_df)} / {len(df)} total rows, "
          f"{rth_df['trade_date'].nunique()} distinct days")

    train_days, _val_days, test_days = day_blocked_split(rth_df)
    train_df = rth_df[rth_df['trade_date'].isin(train_days)]
    test_df = rth_df[rth_df['trade_date'].isin(test_days)]
    print(f"Train: {len(train_df)} rows / {len(train_days)} days, Test: {len(test_df)} rows / {test_df['trade_date'].nunique()} days")
    if len(train_df) < 30 or len(test_df) < 10:
        print("FAILED: insufficient data for a day-blocked quantile fit.")
        return

    print("\n=== MFE (reach_r) quantile predictions ===")
    mfe_preds = fit_quantiles(train_df, test_df, ORDINAL_FEATURES, 'reach_r', QUANTILES)
    mfe_results = evaluate(test_df, 'reach_r', mfe_preds, 'MFE', QUANTILES, 0.5)

    print("\n=== MAE (mae_r) quantile predictions ===")
    mae_preds = fit_quantiles(train_df, test_df, ORDINAL_FEATURES, 'mae_r', MAE_QUANTILES)
    mae_results = evaluate(test_df, 'mae_r', mae_preds, 'MAE', MAE_QUANTILES, 0.15)

    print(f"\n=== Day-block permutation null on MFE median prediction ({N_PERMUTATIONS} permutations) ===")
    null_rhos_mfe = day_block_permutation_null_spearman(rth_df, ORDINAL_FEATURES, 'reach_r', train_days, test_days, primary_q=0.5)
    real_rho_mfe = mfe_results['spearman_primary'][0]
    if null_rhos_mfe:
        pct_beats = float(np.mean(np.abs(null_rhos_mfe) >= abs(real_rho_mfe)))
        print(f"Null: mean={np.mean(null_rhos_mfe):.4f}, std={np.std(null_rhos_mfe):.4f}, n={len(null_rhos_mfe)}")
        print(f"Real MFE Spearman ({real_rho_mfe:.4f}) empirical p-value: {pct_beats:.3f}")
    else:
        pct_beats = None
        print("Null permutation produced no valid draws -- insufficient data per permuted day-block.")

    print(f"\n=== Day-block permutation null on MAE median prediction ({N_PERMUTATIONS} permutations) ===")
    null_rhos_mae = day_block_permutation_null_spearman(rth_df, ORDINAL_FEATURES, 'mae_r', train_days, test_days, primary_q=0.15)
    real_rho_mae = mae_results['spearman_primary'][0]
    if null_rhos_mae:
        pct_beats_mae = float(np.mean(np.abs(null_rhos_mae) >= abs(real_rho_mae)))
        print(f"Null: mean={np.mean(null_rhos_mae):.4f}, std={np.std(null_rhos_mae):.4f}, n={len(null_rhos_mae)}")
        print(f"Real MAE Spearman ({real_rho_mae:.4f}) empirical p-value: {pct_beats_mae:.3f}")
    else:
        pct_beats_mae = None
        print("Null permutation produced no valid draws.")

    print("\n=== Clean vs drifted setup_type sanity check (DeepSeek's proposed holdout) ===")
    test_clean = test_df[~test_df['setup_type'].isin(DRIFTED_SETUP_TYPES)]
    test_drifted = test_df[test_df['setup_type'].isin(DRIFTED_SETUP_TYPES)]
    print(f"Clean test rows: {len(test_clean)}, Drifted test rows: {len(test_drifted)}")
    if len(test_clean) >= 10:
        scaler = StandardScaler()
        X_train = scaler.fit_transform(train_df[ORDINAL_FEATURES])
        model = QuantileRegressor(quantile=0.5, alpha=0.01, solver='highs')
        model.fit(X_train, train_df['reach_r'].values)
        pred_clean = model.predict(scaler.transform(test_clean[ORDINAL_FEATURES]))
        rho_clean, p_clean = spearmanr(pred_clean, test_clean['reach_r'].values)
        print(f"  Clean subset: Spearman={rho_clean:.4f} (p={p_clean:.4f}), n={len(test_clean)}")
        if len(test_drifted) >= 10:
            pred_drifted = model.predict(scaler.transform(test_drifted[ORDINAL_FEATURES]))
            rho_drifted, p_drifted = spearmanr(pred_drifted, test_drifted['reach_r'].values)
            print(f"  Drifted subset: Spearman={rho_drifted:.4f} (p={p_drifted:.4f}), n={len(test_drifted)}")
        else:
            print(f"  Drifted subset too thin ({len(test_drifted)} rows) for a separate read.")

    print("\n=== GATE VERDICT ===")
    beats_null_mfe = pct_beats is not None and pct_beats < 0.05
    beats_null_mae = pct_beats_mae is not None and pct_beats_mae < 0.05
    print(f"MFE quantile prediction clears the null (p<0.05): {beats_null_mfe}")
    print(f"MAE quantile prediction clears the null (p<0.05): {beats_null_mae}")
    if beats_null_mfe or beats_null_mae:
        print("PASS (at least one direction beats chance) -- path-distribution frame is viable, proceed to derive stop/target rules.")
    else:
        print("FAIL -- neither direction beats chance on this data. Real negative: calibrated exits are already as good as this gets for this population.")


if __name__ == '__main__':
    main()
