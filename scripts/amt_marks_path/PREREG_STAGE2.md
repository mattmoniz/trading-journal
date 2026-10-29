# Stage 2: the spike signature (end of a large move vs a stop-pop that continues), frozen 2026-10-29 BEFORE any outcome

Origin: the user's reviews of 8 weeks of the marks chart, and two statements: (1) "sometimes the spike can be the end of a large move or the beginning of a large move if there wasn't one"; (2) "if there is high velocity, minor exhaustion is just stops getting popped and more continuation (so we might need to figure out this signature)". Also: many exhaustive bursts are shorts being stopped out who must buy back "with some intensity". Stage 1 (PREREG.md, corrected) found: fading the corrected spike marks with a structural stop beats a same-stop random-entry placebo by about 12.6 dollars per trade (CI 7.6..17.6) yet loses 1.9 dollars per trade after costs; spikes WITH the day drift or at a new session extreme did better (+18.0, +21.8) than counter-trend pops (+1.5, CI -7.7..+11.6) - the first numeric support for the two-case idea. Everything stays EXPLORE (sessions to 2025-05-16), marks tuned by eye on the same sessions, RTH only, nothing out of sample.

## Variables, all known at the confirmation bar u (no lookahead)
- PRIOR_RUN: signed move in the SPIKE direction over the 60 bars before the thrust window, in ATR20 units (large = the spike ends a large move; small or negative = the spike may start one).
- VELOCITY: thrust size divided by the trailing 75th-percentile thrust size at the same clock bar (how much bigger than a typical big thrust; scale-free).
- LEVEL_PIERCED: the spike extreme went beyond a named level (ONH/ONL, pdH/pdL, pdVAH/pdVAL, IBH/IBL from 10:30) that the thrust started on the other side of (stops rest beyond levels).
- INTENSITY: aggressive volume of the spike side summed over the thrust bars (ask for a spike high, bid for a spike low) >= the trailing 75th percentile of the same quantity at the same clock bar over the prior 20 sessions.
- DRIFT: spike with or against the day drift (close[t] vs the session open), as in stage 1.
Cut points for tertiles (PRIOR_RUN, VELOCITY) are taken from the pooled explore spike marks, outcome-blind.

## Two arms, both with the stage-1 machinery (structural stop, no target, no stop moving, flatten 15:55, realistic fills, 2 dollars per round trip, placebo = 50 random entry bars with the same stop distance and direction, day-blocked bootstrap of real minus placebo, PRE < 2025-01-01 / POST)
- FADE (stage 1): direction D = the way price returned; stop at the spike extreme.
- CONTINUATION: direction C = the original spike direction (the move continues after the pop); entry at the open of u+1 (+1 tick adverse), stop = the pullback extreme (lowest low of bars t+1..u for a spike high; highest high for a spike low) minus/plus one tick; events whose entry price is beyond that stop are excluded and counted.

## Pre-specified hypotheses (the only two counted; everything else is descriptive)
H1 (end of a large move): FADE real-minus-placebo is larger for the TOP tertile of PRIOR_RUN than for the BOTTOM tertile; counted as shown if top-minus-bottom > 0 with a day-blocked CI excluding zero and the top tertile itself beats its placebo (CI excludes zero), N >= 100 per tertile, same sign in PRE and POST.
H2 (stop-pop continuation): among HIGH-VELOCITY (top tertile) spikes that are AGAINST the day drift, CONTINUATION real-minus-placebo > 0 with a day-blocked CI excluding zero, N >= 100, same sign in PRE and POST, top-5 days < 50 percent of a positive total.
Descriptive tables, no pass/fail: both arms by every variable (tertiles or yes/no), by side, and the intensity and level tags. About 20 descriptive looks: any pattern there is a lead only. A null states the CI half-width, what could not be shown, and that Globex is untested.

## Not in this stage
Globex; trailing and two-lot exits; the 500-volume-bar tell components as a hold gate (separate prereg); absorption marks as a variable (their confirmation can come after the spike entry and leaks, so they are used only as an annotation).
