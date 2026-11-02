# Pre-registration: robustness of the explore-derived lead "tell trades with a top-third busy forecast net less" (written 2026-11-02 BEFORE this check was run; user: "Go ahead and test the last lead")

STATUS OF THIS CHECK: NOT CONFIRMATORY. The lead came from the descriptive table of the stop-scale run (+$7.16 / +$8.44 / -$2.48 by forecast third) on the same 1,379 explore V1 trades. Re-reading those trades cannot confirm it. This check only asks whether the lead is internally robust (distinguishable from noise, stable across eras); it can weaken the lead but cannot prove it. Independent confirmation is F2 (forward, docs/FORECAST_SERVICE_20261102.md) or a deliberate sealed-window look, which needs the user's go and hours of extraction.

## Definition (frozen)
Same trades and same walk-forward no-tell forecast as `PREREG_TELL_TARGET.md` (1,379 evaluated V1 trades, simulated `net` dollars of the research simulation). CAUSAL third: each trade's forecast is compared with the 2/3 quantile of the forecasts of ALL EARLIER trades (expanding; the first 100 trades only seed the cutoff and are not evaluated). TOP = forecast above that cutoff; REST = the others. (The all-trade terciles used in the descriptive table look ahead and are not used here.)

## Statistics (one counted test: C1; E1, E2 reported)
- C1: mean net(TOP) minus mean net(REST), day-blocked 95% CI (3000, seed 20261102), permutation p by shuffling TOP/REST labels among trades within chronological halves (1000 draws). Lead supported (weakly) only if the CI upper bound < 0 AND p < 0.05 AND the difference is negative in both halves.
- E1 (stability, uncounted): the same difference in each of four chronological quarters of the evaluated dates, with trade counts.
- E2 (what moves it, uncounted): TOP vs REST stop-out share, mean MFE30 and MAE30 (exit-independent excursions), and the share of the C1 difference attributable to the 10 most extreme trades (leave-top-10-out difference).

## Reading rules (fixed now)
C1 CI includes zero or the sign differs between halves -> the lead is NOT distinguishable from noise on the explore data; F2 stays as a low-prior forward test and no consumer is considered. C1 passes and every quarter with at least 30 trades has the same sign -> the lead survives its own data; it is still only a hypothesis for F2. C1 passes but a quarter with at least 30 trades flips -> flagged as era-dependent (cv-033). No dollar claim, no rule, no change to Stage 2 comes from this check. Ledger: one look, tests = 3.
