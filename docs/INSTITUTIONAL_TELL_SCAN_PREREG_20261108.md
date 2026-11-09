# Institutional-tell scan on 500V bars (candidate Q4-5, exploration; user: "be open minded and drive towards the idea of institutional tells")

Written 2026-11-08 BEFORE any outcome of this scan is read. This is a LEAD-FINDING scan, not a confirmation: whatever it shows is a lead until it replicates on data it was not found on. The user's idea stays the frame: institutions leave a fingerprint in how the 500-contract bars finish and in what the book does; the user's own tells are pace, Ratio (vacuum) and ROC. The scan adds the other tells that 500V bars carry, without changing any of the user's definitions. Sealed windows untouched. Thirds informational. Nothing here retires anything.

## Population and outcome
Population: the ROC-expansion onsets (family E0 of `docs/VACUUM_COMMON_SIM_PREREG_20261108.md` amendment A1; |Z_ROC10| > 2 crossing, direction = the push), RTH and Globex separate, Explore 2023-03..2025-05-16 (about 14,000 RTH and 3,800 Globex events). Outcome: signed continuation = dir x (Close at bar t+30 - Open[t+1]) in points (positive = continuation, negative = reversal/absorption). Hard flat at 15:55 RTH / 09:29:50 Globex.

## The tells (each computed at the event bar's close, causal)
1. PACE: 1 - (the bar's share of same-clock-hour bars in the prior 20 sessions that were at least as fast), so larger = faster (the user's graded pace).
2. PRINT SIZE: 500 / ntrades of the bar (average contracts per trade print), as a same-hour percentile (larger = fewer, bigger prints: block / iceberg / institutional footprint).
3. ONE-SIDEDNESS: |ask - bid aggressor volume| / 500, same-hour percentile (larger = one side doing all the work).
4. RANGE PER 500: the bar's range (high - low) as a same-hour percentile (larger = price moved far on the same volume: thin book / vacuum).
5. RATIO Z (the user's Ratio on the trade-count PROXY, labelled): Z_Ratio.
6. BURST: how many of the last 5 bars (including this one) were in the fastest pace tercile (0-5): involvement that persists, not one bar.
Real order-book depth (Sierra Bid & Ask Depth, about 100 sessions) is added as a 7th tell once calibrated (separate look).

## Counted tests (12): for each tell and each track, the mean continuation of the TOP quintile minus the BOTTOM quintile of that tell (quintiles by rank inside the track), day-blocked bootstrap 95 percent CI (3000, seeded), one-sided p for 'top beats bottom', Holm 0.10 over the 12. Also printed (information only, not counted): the five quintile means (to see a monotonic pattern), the sign in the first and second half of the dates, thirds. The two-sided picture matters: a strongly NEGATIVE top-minus-bottom (the tell marks absorption / reversal) is reported as a lead in the other direction, with its own next test.

## Next-step tree
A tell that shows (Holm survivor or a consistent two-half sign with a CI excluding 0): replicate on the second half and on the real-depth sessions, then combine with the user's thrust rule and exits (a new pre-registration). Not shown: report what was tested and move to the real-depth tell. Mixed: keep as a lead; never retire (co-025).

## PART 2 (2026-11-09 ~00:45 ET, written before any Part 2 outcome is read; user: "keep going"): pace as a BUILD-UP before the expansion
Look 191 showed the user's pace alone does not predict continuation AFTER the ROC expansion bar. The user's idea is that pace shows where institutions get involved, which may precede the ROC cross. Definitions (causal at bar close, same-hour pace percentile, fast = fastest tercile): FAST3 at bar a = the last 3 bars (a-2, a-1, a) are all fast; BURST ONSET at a = FAST3[a] and not FAST3[a-1] and at most 2 of the 5 bars a-7..a-3 were fast; direction = sign of Close[a] - Close[a-3]; the burst must have MOVED price: |Close[a] - Close[a-3]| >= EMA10(True Range)[a]. CONTROL MOVE_ONLY = the same move condition (|3-bar move| >= EMA10 TR, onset of the condition) when FAST3 is false. Entry windows as before (RTH 09:35-15:50, Globex 18:30-09:25, 60 continuous bars). Outcome as before: signed change over 30 bars from Open[t+1].
Counted tests, per track (6 in all, Holm 0.10): T1 BURST minus MOVE_ONLY; T2 BURST with one-sided aggression (|ask - bid|/500 in the top tercile of the same hour) minus MOVE_ONLY; T3 among the E0 ROC expansions: those with a burst already on in the previous 5 bars minus those without (is the cross late when pace was already building?). Information only: monotonic buckets, halves, thirds. The Part 1 leads (RTH big-range reversal, Globex one-sidedness) are NOT re-tested here as counted tests; T2 reuses one-sidedness on a different population.
