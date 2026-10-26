# Pre-registration: the one-contract size lever — skip trades whose dollar risk is out of line — 2026-10-26

Written BEFORE running anything. Origin: user, 2026-10-26: "Can we pursue the size lever item you keep mentioning" (I had only mentioned one micro contract as a limit; the user's own opening note says contract size is fixed at one contract). At one MNQ the only size action is TAKE or SKIP, so the lever is a risk cap. Facts checked first (last 60 days, 4,613 primary rows excluding POC join): median stop 37 points ($74), p10 22, p90 65, max 397; the top 10 percent widest-stop trades are 10 percent of trades and 36 percent of squared P&L; the widest-stop setup types (`RTH_FLUSH_LONG` ~198 pts, `TRT_SHORT` ~143, `C_PAIRED_SHORT` ~123) average negative on 15-23 trades. The daily-loss limit is $1,000 (`DTC_DLL_LIMIT_USD`), so any trade with a stop wider than 500 points can breach it alone (`OVERNIGHT_ORDERFLOW_*` carries a 700-point stop, $1,400 of risk).

## Question
Does skipping trades whose stop distance (dollar risk = |entry - stop| x $2, one contract) is above a cutoff that is DERIVED from past data (a) remove genuinely worse trades and (b) reduce the worst day and the drawdown by more than skipping the same number of random trades would?

## Population and rule (no lookahead)
Fired `active_setups` rows `origin_status IN ('ACTIVE','SHADOW')`, `is_cluster_primary`, `actual_pnl` not null, not NOT_FILLED, no `*_basis` rows, not fired 16:00-18:00, trade_date >= 2026-07-09 (the live-detected, post-origin-status window), `POC_ROTATION_JOIN%` reported separately and excluded from the headline (confound boundary 2026-10-11/12). Risk = |entry_zone_low - stop_level|. **Rule:** on trade date d, SKIP a trade whose risk exceeds the q-th percentile of risk over all fired primary trades of the 60 trade days BEFORE d (q = 90 primary; 95 secondary). Evaluation starts once 60 prior days exist. A second, parameter-free **structural cap**: skip any trade whose risk exceeds the daily loss limit (stop > 500 points).

## Outcomes (two separate claims, no composite)
- **S1 — are wide-stop trades worse trades?** Per-trade mean (sum/N) of KEPT minus SKIPPED, with a day-blocked bootstrap CI (2000 draws). Because wide stops are concentrated in a few setup types, the confound-free version is the **within-setup-type contrast**: for each type with >= 40 evaluated trades, WIDE (above that type's own median risk, using only prior data) minus NARROW, pooled across types weighted by trade count (type-stratified), day-blocked CI.
- **S2 — is skipping them a free risk reduction?** Account-level daily P&L of TAKE-ALL versus SKIP-WIDE: change in total, worst day and maximum drawdown (resolve-time-ordered daily series), each versus a **random-skip placebo** (same number of skips per day, 10,000 draws, day-resampled): the real change in worst day AND in max drawdown must beat the placebo 97.5th percentile (one-sided) while the change in total P&L is not worse than the placebo's.
Reported always: N, skipped share, distinct days, CI half-widths, explore (earlier 60 percent of evaluated days) and hold-out (later 40 percent) separately, the skipped share by setup type (so a cap that is really "drop 3 setup types" is visible), and a descriptive R-multiple view (pnl / risk).

## Pass bar
**S1 SHOWN** = KEPT-minus-SKIPPED CI lower bound > 0 AND the within-type stratified contrast CI lower bound > 0 AND both halves positive. **S2 SHOWN** = both worst-day and max-drawdown improvements above the placebo 97.5th percentile in the pooled period AND same sign in both halves. Otherwise NOT SHOWN with the CI half-width. A cap that only removes trades from setup types that are already negative is reported as "a setup-type result", not as a size lever.

## Limits stated in advance
~110 days of live-detected rows; SHADOW rows are not real orders; the SHADOW pile is much larger than the live roster, so the "account" series here is the detected-event series, not the Sim1 account; correlated same-day trades (clusters of the same level) inflate N; the roster gate means most live trades are now a handful of types, so any account-level finding does not transfer to the current live book without a re-check on `origin_status='ACTIVE'` rows (printed separately).

## Records
`recordClaim()` for S1 and S2, positive or negative; nothing here changes live behaviour (a DLL-structural-cap recommendation, if any, is a separate decision for the user).
