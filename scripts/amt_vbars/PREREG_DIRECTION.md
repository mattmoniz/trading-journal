# Pre-registration: can a delta/flow read fix the tell's DIRECTION? (written 2026-11-01 BEFORE any outcome)

Origin: user 2026-10-31 after watching the live AMT tell: "the timing is very good but the direction is opposite", and "is it possible to use [delta flips] to help determine the stronger side for the trade ... only part of the decision making". Explore sessions only (to 2025-05-16); hold-out untouched. Script `scripts/amt_vbars/run_direction.py` (explore, one run).

## What is being tested
The research tell fires (the 1,760 V1 trades in `trades_V1_explore.csv`: date, entry bar `ei`, direction `dir`, structural stop distance `risk`). The live observation says the fire TIME is good but the side is often wrong. Two separate questions, kept separate:
- Q1 (descriptive): is the tell's direction better or worse than coin-flip direction on the same entries and stops? Does opposite-of-tell do better? (If the live impression is right, the opposite side should look better than a placebo here too.)
- Q2 (the user's idea): does a flow-based read of the stronger side, available before entry, choose the direction better than the tell's own ladder direction?

## Outcome (frozen, one definition for every arm)
For every tell event and any direction d, the existing `trade.stripped(ctx, ei, d, risk)`: market entry at the next open plus one tick of slip, stop `risk` points from the entry (the tell's own structural distance, same for either side, a geometry choice), 120-minute time exit, flatten at the 15:55 open, $2 round trip, $2/point. No target, no moving stop. NET dollars per trade.

## Features (ours, causal, from bar `ei-1` backwards; they are NOT a replica of the user's DDY Delta Heatmap, whose exact definition and settings are not in the repo; a replica needs those settings)
- `delta_K(i)` = sum over the K bars ending at bar `i` of (ask-side volume minus bid-side volume) from the 500-contract bars. K = 10, the tell's own existing FLOW_N, so no new number.
- DELTA direction: sign of `delta_10(ei-1)`; zero = no read.
- FLIP: the sign of `delta_10(ei-1)` differs from the sign of `delta_10(ei-11)` (the non-overlapping previous window); the flip direction = the new sign.

## Arms
- R0 tell direction (the live rule). R1 opposite of the tell.
- R2 DELTA: trade the DELTA direction (events with a read).
- R3 FLIP: trade the flip direction when a flip exists, else the tell direction.
- R4 AGREE: take the tell only when the DELTA direction equals the tell direction. Reported as a SPLIT of the same events: tell-direction outcome on AGREE events vs on DISAGREE events (per-trade means, day-blocked CI of the difference; never the day-weighted point estimate).
- PLACEBO: random direction per event, same entries, stops and exit, 200 draws, seeded. Its 95th percentile of the mean is the bar a rule's mean must exceed (gambler's-ruin geometry makes a coin-flip arm non-zero, so it is the right control, CLAUDE.md placebo rule).

## Statistics
Per-trade means (sum of net divided by N) for every arm. Paired comparisons (R1, R2, R3 minus R0) run on the SAME events, so day composition is matched; the day-blocked bootstrap (resample dates, 2000 draws, seeded) is used for the CI of the paired difference only. Chronological halves = events before / after the median event date. Counts printed first (events, with a read, with a flip, agree/disagree, distinct days).

## Pass criteria (a rule "fixes direction" only if ALL hold)
1. N >= 200 events on >= 100 distinct days.
2. Paired difference from R0 (or AGREE minus DISAGREE for R4) > 0 with the day-blocked 95% CI excluding zero.
3. The rule's own mean exceeds the placebo's 95th percentile.
4. Same sign of the difference in both chronological halves.
5. Top-5 days' share of the summed paired difference < 50 percent of a positive total.
Three rules tested (R2, R3, R4); one pass among three is a lead for one frozen look on a later window, not a result. Q1 is descriptive and does not count.

## Not tested here, recorded
- The user's peak-and-fail past the overnight high/low with stuffed large shorts (needs a depth or big-order signature; earlier trade-tick versions of "stuffed orders" were NOT SHOWN, and depth exists only from about mid-June 2026, roughly 100 sessions, so it is a forward-collection question not an explore-window test).
- Take half off at the IB high with a runner, two-sided trading between absorbed areas on balance days (exit/management rules, own prereg and realistic fills; the exit audit already closed most stop-moving ideas).
- Direction chosen by the AMT state of the day (balance vs trend) rather than flow.
- The user's DDY Delta Heatmap exact flip definition.
