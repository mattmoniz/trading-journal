# Single-position, day-level test of the counter-trend-spike rule (frozen 2026-10-29 BEFORE it is run)

Why: the per-event results (robust_output.txt, drift_control_output.txt) overlap within a day (hold-to-close positions cannot be summed). The user trades one position at a time. This turns the finding into day-level P&L with the same controls. EXPLORE only (sessions to 2025-05-16, RTH). The detector was tuned by eye on these sessions, so this is exploratory; the sealed hold-out section below is frozen but NOT run.

## The rule (frozen)
- Marks: `scripts/amt_exhaust/spike.py` detect() with M=5, Q=75 (K=30, MINK=8, RET=5, REFRACT=15, thresholds from the prior 20 sessions at the same clock bar +/- 15), decided at the confirmation bar u.
- Qualifying mark: the spike was AGAINST the day drift at u: drift sign = sign(close[u] - session open); against = the fade direction D equals the drift sign (a spike LOW in an up-drifting day, a spike HIGH in a down-drifting day). Trade direction = D (with the day drift).
- Entry at the open of bar u+1 (entry bar 5..345), 1 tick adverse. Stop = the spike extreme minus/plus 1 tick. No target, no stop moving. Exit at the stop or the 15:55 flatten (bar 385 open); a stop already beyond the market fills at the open, an intrabar touch at the stop minus 1 tick; 1 MNQ, 2 dollars per point, 2 dollars round trip (same simulator as run_path.py).
- ONE POSITION AT A TIME. S1 = the first qualifying mark of the session only (one trade per day at most). S2 = after the position has exited (stop hit), the next qualifying mark whose entry bar is after the exit bar may open a new position (re-entry); a position held to the flatten ends the day. Marks in either direction arriving while a position is open are ignored.

## Placebo (day-level, same process)
For every real qualifying mark, a time-matched pseudo-mark: a random bar in the same session within +/- 30 bars of its entry bar (excluding it, within 5..345), trade in the drift direction at that bar (sign(close[bar-1] - open)), the real mark's own risk distance. The same S1/S2 process is run on the pseudo-mark sequence (ordered by entry bar); 50 repetitions. Statistic = per traded day: real daily P&L minus the placebo's mean daily P&L for the same session (sessions where the placebo takes no trade count as 0 for it); day-blocked bootstrap of the per-day difference (3000 draws, seed 20261029).

## Reported (explore)
Trades, days traded, mean net per trade, mean and median daily P&L over traded days and over all sessions, win-day share, worst day, max drawdown of the cumulative daily series (dollars), trades per traded day (S2), PRE (< 2025-01-01) / POST; real minus placebo per traded day with the CI. A pass = S1 AND S2 real-minus-placebo CI excludes zero and both halves positive. Neighbouring settings (M=3/8, Q=65/85) are re-run for the sign only.

## FROZEN specification for the single sealed look (NOT run; needs the user's explicit go)
Code and thresholds frozen at the commit that contains this section. Data: sessions after 2025-05-16 to 2026-10-27 (never used for any detector or rule decision). ONE primary statistic: S1 (first qualifying mark per session) real-minus-time-matched-placebo mean daily P&L per traded day, CI excluding zero, at least 60 traded days, same sign in the first and second half of the hold-out. Everything else secondary. No amendment after the hold-out output is seen; the look is spent whatever the result. A guard in run_single.py refuses to run the hold-out without HOLDOUT_OK=1 and writes a lock file on use.

## Not tested
Globex; the user's two-lot and loose-trail exits; the tell-component hold gate; absorption marks as a filter (their confirmation can come after the spike entry and leaks).
