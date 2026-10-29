# Path study at the absorption and spike-exhaustion marks (frozen 2026-10-29 BEFORE any outcome)

Why: the user finished reviewing the marks chart (8 weeks) and asked to continue toward the hold idea and the absorption/exhaustion interaction (`OPEN_DECISION absorption_grind_hold_idea_20261028`, `absorption_exhaustion_interaction_study_20261029`). This is the cheapest decisive screen: if nothing holds up after the marks even under the simplest hold rule against a placebo, polishing the detectors is pointless. It is a market-behavior question on bars, not a trade rule. EXPLORE only (sessions through 2025-05-16); the detectors were tuned BY EYE on these same sessions, so every result here is exploratory and cannot be called out-of-sample; no hold-out is touched. RTH only (Globex untested, recorded, not an excuse).

## Events
- Spike marks (`scripts/amt_exhaust/spikes_explore.csv`, PREREG_SPIKE.md incl. Amendment 1) and absorption marks (`scripts/amt_absorb/events_explore.csv`, PREREG.md incl. Amendments 1-4). Strong and weak are separate cells. Direction D = the direction price left (spike LOW or absorbed selling: long; spike HIGH or absorbed buying: short).
- Entry at the open of bar u+1 (u = the confirmation bar), 1 tick adverse (SLIP 0.25), entry bar 5..345 (09:35-15:15).

## Hold policy P1 (the only policy in this stage)
STRUCTURAL stop = the defended extreme minus/plus one tick (spike: the spike extreme `ext`; absorption: the window's lowest low for a long, highest high for a short). NO target, NO stop moving. Exit at the stop or the 15:55 flatten (bar 385 open), whichever first. A stop that is already beyond the market at a bar's open fills at that open (never at the stop price); a stop touched intrabar fills at the stop minus 1 tick adverse. Events whose entry price is already beyond the stop are excluded and counted. 1 MNQ, 2 dollars per point, 2 dollars round-trip cost.

## Outcomes (per event, then per cell)
Net points and dollars of P1; stop-hit share; MFE and MAE (points and ATR20 units, MAE = deepest adverse excursion before the exit); signed forward move at +30, +60, +120 bars and to the flatten in ATR20 units; risk in points. ATR20 = mean RTH range of the prior 20 sessions.

## Placebo (the confound control: a hold rule with an asymmetric stop wins or loses by geometry alone)
For every event, 50 random entry bars in the same session (entry window 5..345), same direction, stop distance = that event's own risk (entry minus/plus the same points), same fills, hold to the flatten. The per-event placebo mean is subtracted from the event's P1 result; the CI of (real minus placebo) is a day-blocked bootstrap (resample trading days, per-event means, 3000 draws, seed 20261029). The point estimate is the per-event mean, not a day-weighted mean.

## Reading (per cell, 4 cells: spike strong, spike weak, absorption strong, absorption weak)
A cell shows a hold-after-the-mark edge only if ALL hold: (1) N >= 100 events on >= 50 days; (2) real-minus-placebo > 0 with the day-blocked 95% CI excluding zero; (3) same sign in PRE (< 2025-01-01) and POST; (4) top-5 days' share of the summed real-minus-placebo < 50 percent of a positive total. One cell passing out of four is a LEAD, not a result; all four reported either way, with the CI half-width stated so a null says what could not be shown. Eyeball-tuned detectors on the same sessions mean even a pass needs a sealed look before any trust.

## Interaction tags (descriptive; same stop/placebo machinery; reported for spike marks, strong and weak pooled and each)
INSIDE_ABS: a same-direction absorption mark's window [t0, u] contains the spike peak bar. NEW_EXTREME: the spike extreme is beyond the session high (spike high) / low (spike low) so far. AGAINST_TREND: the spike is against the day's drift so far (spike high when close[t] < the session open; spike low when close[t] > the open). For each tag, real-minus-placebo with day-blocked CI, with and without the tag. Intensity (aggressive volume burst on the thrust bars) is NOT in this stage; it is the next pre-registration if the tags show anything.

## Not tested
Globex; trailing and two-lot exits (the user's discretionary habits) and the tell-component hold gate (needs the 500-volume bars; separate prereg); any live wiring.
