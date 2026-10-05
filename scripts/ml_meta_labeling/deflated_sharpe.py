"""Deflated Sharpe Ratio (Bailey & Lopez de Prado, 2014) -- corrects a strategy's observed
Sharpe ratio for (a) non-normal returns (skew/kurtosis) via the Probabilistic Sharpe Ratio,
and (b) the fact that this codebase has tried hundreds of ideas before this one, so some
apparent edge is expected to show up by chance alone even with zero real skill anywhere.

Added 2026-10-04 as part of the CPCV/walk-forward retrofit (user: "did adding order flow
actually help... measured properly instead of on a single train/test split") -- a walk-
forward Sharpe ratio alone still doesn't answer "is this believable given how much we've
already gone looking," which is exactly the multiple-testing risk DSR exists to correct for.

N_TRIALS below is NOT a free parameter to tune until the answer looks good -- it is sourced
from a real, countable fact about this project (distinct RESEARCH_CLAIM slugs ever recorded
via scripts/record_claim.mjs, i.e. every tested idea this codebase has a record of, win or
lose). This is a conservative-leaning proxy, not a precise one: a few slugs are re-tests of
the same underlying idea rather than genuinely independent strategies, which would make the
true trial count somewhat lower than 967 -- but given this codebase's own repeated history
of reversed/fabricated-looking findings needing correction, erring toward MORE deflation
(more skepticism of an apparent edge) rather than less is the right default. Pass a
different n_trials explicitly if a narrower, more defensible count is ever derived.
"""
import numpy as np
from scipy.stats import norm, skew, kurtosis

EULER_MASCHERONI = 0.5772156649


def probabilistic_sharpe_ratio(sr, sr_benchmark, n, skewness, excess_kurtosis):
    """PSR(SR*): probability the TRUE Sharpe ratio exceeds sr_benchmark, given an observed
    SR over n observations with the given sample skewness/excess-kurtosis (both 0 for a
    normal return distribution, in which case this reduces to a simple t-like z-test).
    excess_kurtosis is kurtosis - 3 (scipy's kurtosis() already returns excess by default)."""
    if n <= 1:
        return float('nan')
    denom = np.sqrt(max(1e-12, 1 - skewness * sr + (excess_kurtosis / 4.0) * sr**2))
    z = (sr - sr_benchmark) * np.sqrt(n - 1) / denom
    return float(norm.cdf(z))


def expected_max_sharpe_under_null(n_trials, sr_trial_std):
    """E[max SR_n] under the null that none of the n_trials strategies have real skill --
    the benchmark DSR deflates the observed SR against. Standard closed-form approximation
    (Bailey & Lopez de Prado eq. 10): uses the Euler-Mascheroni constant and the inverse
    normal CDF at the trial count's own implied extreme-value quantiles. sr_trial_std is the
    standard deviation of Sharpe ratios ACROSS the n_trials (not across time within one
    strategy) -- approximated here from this walk-forward's own per-fold Sharpe spread,
    since this codebase has no single persisted per-trial-SR history to draw from directly."""
    if n_trials <= 1:
        return 0.0
    a = (1 - EULER_MASCHERONI) * norm.ppf(1 - 1.0 / n_trials)
    b = EULER_MASCHERONI * norm.ppf(1 - 1.0 / (n_trials * np.e))
    return float(sr_trial_std * (a + b))


def deflated_sharpe_ratio(returns, n_trials, sr_trial_std=None):
    """Full DSR pipeline from a raw per-trade (or per-fold) returns/pnl series.
    returns: array-like of real $ P&L (or returns) -- NOT annualized, NOT normalized; this
      function computes SR in whatever units `returns` is in, consistently throughout.
    n_trials: real count of independent strategies/ideas this codebase has tried (see
      module header -- defaults to the RESEARCH_CLAIM slug count when called from main()).
    sr_trial_std: std-dev of Sharpe ratios across those n_trials, used as the DSR benchmark
      input. If None, falls back to 1.0 (the standard simplifying assumption when no better
      estimate of trial-to-trial SR dispersion is available) -- callers should pass a real
      value when one exists (e.g. this walk-forward's own per-fold SR std) rather than rely
      on the fallback silently.
    Returns a dict with every intermediate value, not just the final DSR, so a caller/audit
    can see exactly what drove the number rather than trusting one float blind.
    """
    returns = np.asarray(returns, dtype=float)
    n = len(returns)
    if n < 2:
        return {'n': n, 'error': 'fewer than 2 observations, cannot compute'}

    mean_r = float(np.mean(returns))
    std_r = float(np.std(returns, ddof=1))
    sr = mean_r / std_r if std_r > 0 else 0.0
    skewness = float(skew(returns)) if std_r > 0 else 0.0
    excess_kurt = float(kurtosis(returns)) if std_r > 0 else 0.0  # scipy default: Fisher (excess)

    sr_std = sr_trial_std if sr_trial_std is not None else 1.0
    sr_benchmark = expected_max_sharpe_under_null(n_trials, sr_std)
    psr_vs_zero = probabilistic_sharpe_ratio(sr, 0.0, n, skewness, excess_kurt)
    dsr = probabilistic_sharpe_ratio(sr, sr_benchmark, n, skewness, excess_kurt)

    return {
        'n': n, 'mean': round(mean_r, 4), 'std': round(std_r, 4), 'sharpe_ratio': round(sr, 4),
        'skewness': round(skewness, 4), 'excess_kurtosis': round(excess_kurt, 4),
        'n_trials': n_trials, 'sr_trial_std_assumed': sr_std,
        'expected_max_sharpe_under_null': round(sr_benchmark, 4),
        'psr_vs_zero': round(psr_vs_zero, 4),
        'deflated_sharpe_ratio': round(dsr, 4),
        'passes_dsr_0.95': dsr >= 0.95,
    }


if __name__ == '__main__':
    # Self-test against known reference behavior, run directly (python3 deflated_sharpe.py)
    # before trusting this module for anything real -- per this codebase's own standing
    # "verify a statistical function against a known case before trusting it" discipline.
    np.random.seed(42)

    print("=== Sanity 1: pure noise (mean=0), n_trials=1 -- DSR should be near 0.5 (PSR vs 0 is a coin flip, no deflation to apply) ===")
    noise = np.random.normal(0, 100, 500)
    print(deflated_sharpe_ratio(noise, n_trials=1, sr_trial_std=1.0))

    print("\n=== Sanity 2: SAME noise series, but n_trials=1000 -- DSR should drop sharply (same observed SR, but now it's expected by chance) ===")
    print(deflated_sharpe_ratio(noise, n_trials=1000, sr_trial_std=1.0))

    print("\n=== Sanity 3: genuinely strong, consistent edge (mean=50, std=100, n=500), n_trials=1 -- DSR should be high ===")
    strong = np.random.normal(50, 100, 500)
    print(deflated_sharpe_ratio(strong, n_trials=1, sr_trial_std=1.0))

    print("\n=== Sanity 4: SAME strong edge, n_trials=1000 -- should survive deflation if the edge is real relative to noise-level trial variance ===")
    print(deflated_sharpe_ratio(strong, n_trials=1000, sr_trial_std=1.0))
