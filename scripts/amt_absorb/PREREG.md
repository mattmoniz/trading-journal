# Persistent absorption detector, marks only (definition frozen 2026-10-28, BEFORE any detector output or outcome)

User description (2026-10-28, confirmed): absorption is "persistent selling with no reward and then price goes in the opposite direction", seen anywhere (not only at a paired confluence zone, not only after 10:30), "multiple tries and it keeps getting defended". Mirror for persistent buying. This stage is MARKS ONLY: it draws where the detector fires on the trade chart so the user can compare it with what they see. No trades, no P&L, no statistics on outcomes. Scoring is a separate later prereg, and only after the user agrees the marks match their reading.

## Definition (1-minute RTH bars, K = 20-bar window ending at bar t; every threshold is a quantile of the prior 20 sessions' same quantity at the same clock bar +/- 15 minutes)
Bullish absorption of SELLING (the mirror, absorption of BUYING, swaps ask/bid, highs/lows and signs):
1. PERSISTENT SELLING (effort): aggressive selling volume summed over the window (bid volume = (volume - delta)/2) >= the trailing 75th percentile, AND the window's net delta is negative (sellers dominate).
2. NO REWARD (result): |close[t] - close[t-K]| <= the trailing 25th percentile of the same quantity (price made little net progress for that much effort).
3. KEPT GETTING DEFENDED (multiple tries): the bars of the window whose low is within one 1-minute ATR14 of the window's lowest low form at least 2 separate tries (clusters separated by at least 3 bars).
4. THEN PRICE GOES THE OTHER WAY (confirmation): within 10 bars after t, the first bar u whose close is above the midpoint of the window's high-low range with positive bar delta, and no bar between t+1 and u trades below the window low (the defended low held). The event is recorded at bar u.
5. One event per direction: windows that end before u are skipped after an event. No level is required; the nearest named level is a descriptive tag only.
Sensitivity (counts only, never selected): K = 10 and 40.

## What is shown
Per event: the window (rectangle spanning its bars and high-low range), the defended band (low band for bullish, high band for bearish), tries, and an arrow at u in the direction price left. Counts per session and by direction are reported. Reading against the user's circled examples on 2023-05-18 is the check, not a statistic.

## Amendment 1 (2026-10-28, after the first marks census, display only, no outcomes exist)
The first run (K = 20: 509 explore sessions, 1,264 events, 2.5 per session; 698 bullish, 566 bearish; 336 sessions with at least one) showed the same shelf flagged in several heavily overlapping windows (2023-05-18 12:16-12:46). Rule 5 is tightened so one defended area is one mark: after an event in a direction, the next window in that direction must START after that event's bar u (was: end after u). Nothing else changes.

## Amendment 2 (2026-10-28, marks stage only, after diagnosing two misses on the user's 2023-05-18 circles; no outcome exists)
Diagnosis on 2023-05-18: (a) the V-low into 13763 around 14:00: price fell 45-70 points inside the 20-bar window, so "no net progress over the whole window" failed although the selling stalled at the low (two tests of the same low, then up); (b) the early-morning rise: net delta was POSITIVE in most windows (buying with reward), i.e. not absorption, and the one flat/negative-delta stretch (10:00-10:05) had selling volume just under the top-quartile bar. Changes, defined before the re-run: rule 1 becomes persistence in both halves: net delta of the pressing side dominant in BOTH halves of the window AND window volume of that side >= the trailing MEDIAN (was top quartile); rule 2 NO REWARD is measured on the LAST HALF of the window: |close[t] - close[t-K/2]| <= the trailing 25th percentile of the same quantity (was the whole window). Rules 3-5 unchanged. Marks stage: the check remains the user's own eye, not a statistic.

## Amendment 3 (2026-10-28, marks stage; defect visible in the marks, no outcome exists)
After Amendment 2 the same flat shelf (2023-05-18 12:21-12:41) was marked both up and down in windows one bar apart: the "net delta negative/positive in both halves" test passes on tiny noise. Rule 1 now also requires the pressing side's net delta in EACH half to be real: |net delta of the half| >= the trailing median of |net delta of a half-window| (same clock bar +/- 15 minutes, prior 20 sessions, both halves pooled). Everything else unchanged. Accuracy is judged by the user's eye on the chart across many days (the 8 windows), not by a statistic; the detector has been adjusted three times against one day, so it is NOT considered accurate until the user has reviewed other days.

## Amendment 4 (2026-10-28, marks stage): two strengths instead of one more tuned threshold
Amendment 3 alone is too strict (0.52 events/session, none on 2023-05-18), Amendment 2 alone marked a flat shelf both ways. Rather than keep adjusting a cutoff against a few examples, the chart shows BOTH: STRONG = passes everything including the Amendment 3 net-delta dominance test; WEAK = passes rules 1-5 as of Amendment 2 but not the dominance test (and does not overlap a strong mark in the same direction). The user decides by eye which strength matches what they see, and over many days.
