# Pre-registration: does the LIVE_ROSTER rule pick forward winners, and how fast? — 2026-10-26

Written BEFORE running anything. Origin: user's ordered list for the next session, item 1 ("which setups earn live status, and how fast"). Related: `docs/NEXT_STEPS_SCOREBOARD_AND_BAR_STUDIES_SCOPE_20261025.md`, claim `live_roster_count_floors_not_binding_20261025`.

## Question
The roster rule (`scripts/calibrate_live_roster.mjs`: >=5 distinct days of cluster-collapsed events, day-blocked bootstrap 95% CI lower bound > 0, both chronological halves positive, new promotions must survive leave-best-day-out, demotion instant) has only ever been scored in-sample. Replayed day by day, using only data available at each date, (a) do the types it puts on the roster earn more on the NEXT day's events than other types, and more than a random pick of the same size, and (b) how many days/events does a type need before it first passes?

## Data and replay (frozen)
- Population = the calibration script's own query (ACTIVE+SHADOW origin, `trade_date >= 2026-07-09`, `actual_pnl` not null, not NOT_FILLED, no `*_basis` rows, no 16:00-18:00 ET, no `POC_ROTATION_JOIN%`), cluster-collapsed by `collapseClusterSiblings`. Upper bound = the latest fully resolved trading date at run time, printed in the output and reused verbatim.
- The REAL `evaluateType` and `buildRoster` are imported, not re-coded. For each trading date t (in order) the roster R_t is built from events dated <= t, with `prevPassing` = passing set of R_(t-1) (null on the first date), siblings off, exactly as the daily cron does. R_t is applied to the events of the next trading date t+1 (live: the 20:23 run writes the row used next day).
- Sensitivity arm "OLD_FLOORS": same replay with the earlier 20 events / 10 days floors (pre-filter, then the same `evaluateType`).

## Primary test (one)
Pooled per-trade mean (sum/N, NOT day-weighted) of forward events of ROSTER types minus that of forward events of OTHER types that were testable (>=5 days of history) at t. CI = day-blocked bootstrap over forward days (resample days, pool trades from resampled days in each arm, difference of per-trade means), 2000 draws.
**SHOWN** requires all of: difference > 0 with CI lower bound > 0; the roster arm's pooled per-trade mean above the 97.5th percentile of the placebo; and the sign of the difference the same in both chronological halves of forward days. Anything else is **NOT SHOWN**, reported with the CI half-width so the reader can see what size of effect could not have been detected.
Expectation stated in advance: very few forward roster events (one to two types for most dates), so a NOT SHOWN is the likely outcome and is a statement about resolution, not about the rule.

## Placebo
For each t draw |R_t| types uniformly from those testable at t, pool their forward events, 2000 draws of the whole path, per-trade mean of each. Report the roster's percentile.

## Secondary (descriptive, no verdict)
1. First-pass table per type that ever entered: first-pass date, distinct days and events at that date, days since the type's first event, in-sample mean at promotion, mean of its events AFTER promotion (while on roster) and after demotion; share of testable types that ever pass (compare with the ~2.5% expected by chance per test).
2. Days-to-first-pass distribution for passers under both floor sets, and the churn (promotions, demotions per week).
3. Implied time-to-significance: for each currently testable type, `(1.96*sd_day/mean_day)^2` days if its observed mean were true, next to the days it has. Observed means are inflated by selection; this is a ceiling on speed, not a forecast.

## Known limits (stated before looking)
- ~85 trading days of history; the roster arm will have a handful of forward events per day at best.
- The rule's own constants (MIN_DAYS=5, interval test) were chosen on the full data after a what-if, so the replay is causal per date but the rule design is not out-of-sample.
- Types are judged on live-detected ACTIVE+SHADOW rows during `PROMOTE_ALL_MODE`; SHADOW rows are not real orders.
- Roster membership is correlated across days (the same type stays on), so forward days are not independent draws; the day-block bootstrap handles same-day correlation only.

## Records
`recordClaim()` for the primary result and the first-pass table (positive or negative); `flagDecision()` only if a real fork appears. Nothing here changes live behaviour.
