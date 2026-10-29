# Shelf marks (absorption as a sideways hold), marks-only first (definition frozen 2026-10-29 BEFORE any output)

Why: after 8 weeks of the user's review, the persistent-absorption marks (PREREG.md, 4 amendments) overlap only about 30 percent of the user's green boxes. The misses are long sideways shelves of 25-65 minutes at highs and lows (and grinds with shelves along the way), where price holds a narrow range and the edges keep getting tested. The user: "we're not giving up on absorption yet". This is a second, structural absorption detector. Stage 1 = marks only and a fidelity check against what the user circled; stage 2 = the same controls as the spikes (flip, time-matched drift-direction placebo). EXPLORE only (sessions to 2025-05-16); the hold-out is untouched.

## Definition (1-minute RTH bars; every threshold a quantile of the prior 20 sessions at the same clock bar +/- 15 minutes)
- WINDOW W = 25 bars (the shortest shelf the user boxes; sensitivity W = 15 and 40, counts only). R[t] = highest high minus lowest low of the last W bars ending at t.
- COMPRESSED: R[t] <= the trailing 25th percentile of R at the same clock bar.
- DEFENDED (multiple tries): within the window at least 2 separate tests (clusters at least 3 bars apart) of the window's high band (high >= window high - 1 x 1-minute ATR14) or of its low band, as in the absorption detector.
- SHELF MARK: consecutive qualifying bars (gaps up to 3 bars merged) form one shelf; the drawn box spans the first qualifying window's first bar to the last qualifying bar and the shelf's high-low range. A shelf is CONFIRMED at the first qualifying bar t_c (known then, not before).
- No level, order-flow or location condition in this stage (location relative to the session range is recorded as a tag only).

## Fidelity check (not a statistic, not tuned to)
The user's week-2 green boxes (2023-08-04..08-10, 28 boxes, times read off their screenshots, about +/- 5 minutes) are used as a hit list AFTER the run: a box counts as caught if a shelf interval overlaps it within 5 minutes. The marks per session are reported; thresholds are not adjusted to the hit list.

## Stage 2 (written now, run only after the user has seen the marks): trade test
Event: after confirmation at t_c, the first close within 20 bars beyond the shelf's high (up break) or low (down break) at bar u; counted only when the break direction equals the day-drift sign at u (close[u] vs the session open) (hypothesis carried over from the spike finding; the other direction is reported descriptively). Entry at the open of u+1 (1 tick adverse), stop at the shelf's OPPOSITE edge -/+ 1 tick, no target, flatten 15:55, same fills as run_path.py. Controls: direction-flip at the same bar and risk, time-matched drift-direction placebo (50 random bars in the same session +/- 30 bars, drift direction at that bar, same risk), uniform placebo, day-blocked CIs, PRE/POST, one-position-at-a-time version as in PREREG_SINGLE.md. Pass rule as in PREREG_SINGLE.md. Exploratory.

## Not in this stage
Globex; order-flow intensity; the tell-component hold gate; the user's two-lot and loose-trail exits.
