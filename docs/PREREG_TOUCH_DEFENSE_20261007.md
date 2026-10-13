# Pre-registration: touch/defense history as a stop/target-width predictor

Written and committed BEFORE running any computation, per the discipline both tonight's
DeepSeek design critique and an external DeepSeek review independently converged on. One
configuration, no iteration, kill criterion fixed in advance.

## Honest prior art check (done before writing this, not after)

A related hypothesis — does a level's denial-streak length (how many times it's been touched
before it finally breaks) predict the EV of trading the eventual breakout — was already tested
2026-09-09/10 and came back negative: pooled EV by streak bucket was non-monotonic and flat
(0 denials $-4.97, 1-2 $+3.11, 3-4 $-3.51, 5+ $-2.86/trade). That is NOT the same question as
this one (that was streak-length -> breakout-trade EV, on a narrower population; this is
defended-vs-not -> stop/target WIDTH, on the full existing fade roster), so it is not a literal
duplicate and is still worth testing on its own terms. But it raises the honest prior that this
kind of "has this level fought before" signal may not carry real information in this market,
and that prior is stated here, before the result, not after.

## Hypothesis, stated once

A level is **DEFENDED** if, in the 30 calendar days before this trade's own touch, price came
within a proximity band of this exact level at least 2 times before (not counting this touch),
and at least one of those prior approaches was a **REJECTION**: price moved away by at least
1.0x the local 20-bar ATR without ever closing through the level.

A level that fails this (first-ever approach, or prior approaches with no qualifying rejection)
is **NOT_DEFENDED**.

Claim under test: DEFENDED touches should show a different (ev_1.4 - ev_0.8) outcome than
NOT_DEFENDED touches -- a defended level, having proven it can hold, plausibly argues for a
tighter stop (0.8x) on a fade, while an undefended level argues for more room (1.4x) since it
hasn't proven anything yet.

## Fixed parameters (no tuning after seeing results)

- Proximity band: 0.15% of price (matches this codebase's existing level-touch convention
  elsewhere, not invented for this test).
- Lookback window: 30 calendar days, continuous (not reset per calendar day).
- Rejection threshold: >=1.0x local 20-bar ATR excursion away from the level without a close
  back through it.
- Minimum prior touches for DEFENDED: 2.
- Population: the same 5588-row full (non-deduplicated) REAL_TRADE_FILTER population already
  computed tonight (scratch/ml_cluster_confluence_ev_20261007.csv has the ids/ev values; levels
  come from each row's own entry_zone_low/high).

## Kill criterion, fixed before running

Compute the day-blocked bootstrap 95% CI on the difference in mean (ev_1.4 - ev_0.8) between
DEFENDED and NOT_DEFENDED groups.

- **If the CI excludes zero**: real, report the direction and magnitude honestly, whichever way
  it points.
- **If the CI crosses zero**: dead. Report as a clean negative. Do not re-tune the proximity
  band, rejection threshold, lookback window, or minimum-touch count after seeing this result --
  that would be exactly the multiple-testing/researcher-degrees-of-freedom trap both reviews
  warned about. If it fails, this specific operationalization is closed, not iterated on.

Run once, after this file is saved.
