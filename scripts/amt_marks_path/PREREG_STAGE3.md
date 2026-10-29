# Stage 3: context calibration for large moves (frozen 2026-10-29 BEFORE any outcome)

User (2026-10-29): "I really just want to catch the large ones, the ones that come before more of 50 point moves... avoid getting stopped out on a big move because a stop pop looks like exhaustion... is there a dynamic multi-factor way to assess and calibrate the detector for the day to come or the day in progress? What is relative volume? How is volatility? Where are we relative to the overnight movement, within overnight value, above, beneath? ... can we use these factors to calibrate our detector to get larger moves most of the time and not every move." Prior evidence in this repo: a big overnight range / high overnight volume per bar predicts a WIDER RTH range (+0.14 to +0.26 ATR20) but no direction (BAR_CONTEXT_STUDIES_PREREG_A). So context should calibrate SIZE and the continuation-vs-reversal character of a spike, not direction. EXPLORE only (sessions to 2025-05-16), RTH, spike marks (M=5, Q=75, scripts/amt_exhaust/spike.py, decided at the confirmation bar u). Exploratory; marks tuned by eye on these sessions; no hold-out touched.

## Context features, ALL known at the confirmation bar u (rolling, relative, no typed cutoffs)
- RVOL = cumulative RTH volume through u / the median of the same quantity at bar u over the prior 20 sessions.
- VOLNOW = high-low range of the last 30 bars ending at u / the median of the same over the prior 20 sessions at bar u.
- RANGE_SO_FAR = session high-low through u / the median of the same over the prior 20 sessions at bar u.
- EXPANSION SCORE ES = mean of log(RVOL), log(VOLNOW), log(RANGE_SO_FAR) (a relative measure; tercile cut points from the pooled explore marks, outcome-blind).
- OVERNIGHT LOCATION at u: price above / inside / below the overnight range (ONH/ONL from the 18:00-09:29 bars); above / inside / below the OVERNIGHT value area (volume profile of the overnight bars, engine.profile); above / inside / below the PRIOR-DAY value area; overnight range / ATR20; overnight volume / the median of the prior 20 sessions; gap = open minus prior close over ATR20; minutes since the open; day drift = (close[u] - open)/ATR20 relative to the spike direction; spike size / the trailing p75 thrust size.

## Trades and labels (per mark, P1 machinery of run_path.py: entry next open +1 tick, structural stop, no target, flatten 15:55, realistic fills)
FADE = the way price returned, stop at the spike extreme. FLIP = the spike direction, same risk distance (the continuation). LARGE move L = 50 points x ATR20(session) / median ATR20(explore sessions) ("50 points at today's volatility"; reported also as the raw 50). A trade CAPTURES a large move if its maximum favourable excursion before the exit is >= L. Per mark: BIG_REV = FADE MFE >= L, BIG_CONT = FLIP MFE >= L; a mark can be both (stop pop, then trend), or neither.

## Analyses (counted only where marked)
- P1 (counted): FADE-minus-FLIP net by ES tercile. Hypothesis: fade is better when ES is low (rotation, balance), continuation (flip) is better when ES is high (expansion): top-tercile minus bottom-tercile of (fade - flip), day-blocked 95 percent CI excluding zero, N >= 100 per tercile, same sign in PRE (< 2025-01-01) and POST.
- P2 (descriptive): BIG_REV and BIG_CONT shares, and fade-minus-flip, by ES tercile, by each factor's terciles/categories (RVOL, VOLNOW, RANGE_SO_FAR separately), by overnight and prior-day value location, by time-of-day (first hour / middle / last two hours).
- P3 (descriptive, causal): a walk-forward chooser: for each mark in date order choose FADE or FLIP by the sign of the mean (fade - flip) of EARLIER marks in the same ES tercile (at least 50), versus always-FADE, always-FLIP and the with-drift rule; per-mark net and day-blocked CIs of the differences.
- P4 (descriptive): walk-forward logistic regression (expanding window, refit every calendar month, features above, standardised on the training rows only) predicting BIG_CONT and BIG_REV; out-of-sample AUC with a day-blocked bootstrap CI, versus ES alone.
About 40 descriptive looks: only P1 is counted; everything else is a lead needing a fresh pre-registration. Reading: a null says what could not be shown, with the CI half-width.

## Not in this stage
Absorption marks (next, same machinery); the single-position day rule with an ES gate; Globex; the sealed hold-out.
