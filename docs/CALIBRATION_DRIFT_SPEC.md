# Calibration drift as a market signal: does the calibration moving predict the market?

Status: scoped 2026-10-05, not started. Written for the engineer or analyst who runs it.

## Question

Does week-to-week change in the system's own calibrations carry information about future market
conditions, beyond what plain market measures already show?

## Why this is confounded, and what must be separated

Calibrations move for reasons that have nothing to do with the market:
- Roster churn: setup types are added, suppressed, and promoted.
- Sample growth: each setup's trade count rises, which shifts its stats.
- Data repairs: e.g. the Sep to Nov 2025 bar fix moved historical stats.
- Policy changes: e.g. PROMOTE_ALL_MODE changed which setups count as live.

Any drift test that doesn't remove these will mostly measure the system, not the market.

## Data (all already stored)

- `performance_audit`: append-only, one row per calibration run, per setup type. Use
  `DISTINCT ON (signal_name, signal_type) ... ORDER BY run_date DESC, id DESC` to get the
  latest row per run date. Never a bare filter (see the performance_audit hard rule in CLAUDE.md).
- Market measures: `GARCH_VOL_SCALE` (`LATEST` and walk-forward history), realized volatility
  from `price_bars_primary`, day-type from `acd_daily_log.day_type`.
- Roster history: `active_setups` by setup_type and trade_date.

## Method

1. Fixed-roster panel. Keep only setup types with a continuous calibration history across the
   whole test window, and no suppression or promotion change inside it. This removes roster churn.
2. Remove sample-size mechanics. Use the per-run change in EV or WR only where both runs have
   sample sizes above a fixed floor, and compare changes on a common scale (z-scores per setup).
3. Market measures. Build weekly market series from the stored measures above. Do not use any
   measure computed from the calibrations themselves.
4. Lead-lag test. For each market series, test whether the cross-sectional mean calibration
   change at week t predicts the market measure at weeks t+1 to t+4, versus the reverse direction.
5. Confounds to check: the common market trend (a rising or falling tide lifts all setups), and
   the day-type mix in each week.
6. Inference: day-blocked resampling (weeks as blocks), not independent observations.

## Holdout

Fix every choice above before looking at the outcome. Then run on the first two-thirds of the
history, and check the same direction on the last third, which is not used to pick anything.

## Pre-registered kill criteria

The drift signal is only kept if all of these hold:
- Lead, not lag: the calibration change predicts the market measure, not the reverse.
- The effect survives removing the common market trend.
- The block-bootstrap confidence interval excludes zero on the holdout.
- It does not depend on which fixed-roster cut is used (try two cut sizes).

Anything less is recorded as a RESEARCH_CLAIM, not used for any decision.

## Known caveats

- This area has produced weak or negative results before (regime detection, volatility
  clustering). Expect a modest result. The test is worth running because it uses data already
  stored and costs little.
- The Sep to Nov 2025 window is contaminated and flagged (`bad_bars_basis`). Exclude it from the
  market series, or the drift will show a fake signal from the repair itself.
