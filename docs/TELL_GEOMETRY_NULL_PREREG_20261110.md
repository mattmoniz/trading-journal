# Does the tell know the direction? Geometry-matched null on the explore tells (pre-registered 2026-11-10 night, BEFORE any outcome of this test is read)

Origin: candidate A of the outside review (audited in docs/FABLE_REVIEW_AUDIT_20261110.md). The user delegated the choice ("make the most prudent decisions to improve results"). Queue id Q4-6 (docs/CANDIDATE_QUEUE.md, 6 of 8 used). Improvement register row 51. Explore only, sealed window untouched. A result here is a LEAD (co-024): the verdict that counts is the forward one below.

## The question in plain words
A tell entry sits inside the range with a stop behind it and the range edge (the overnight high or low, widened by the first hour's range once it is complete) in front of it. If price has no direction, which of the two it touches first depends only on how far away each is. The test asks: does price touch the range edge before the stop MORE often after a tell than the same geometry gets with no directional knowledge? If not, the tell's replay profit comes from the shape of the trade (stop, timeout, flatten), not from knowing which way price goes.

## Population (frozen)
The 1,760 V1 explore trades of `scripts/amt_vbars/trades_V1_explore.csv` (2023-04-04..2025-05-16), replayed through `tell_replay_lib.replay_rows()` (the live code, hr-022). 500-volume bars built from tick files per session.

## Definitions (frozen)
- Tell race: entry E = open of the entry bar + 1 tick in the trade direction d (the engine's entry). Stop S = the engine's stop for that trade. Edge B = `trade.boundary(ctx, signal bar, d)`, fixed at the signal bar. R = |E - S|, D = d x (B - E). A trade with D <= 0 (opened through the edge) is excluded and counted.
- Walk the bars from the entry bar to the last bar that starts before the 15:55 flatten. Stop touched: bar low <= S (long) or high >= S (short). Edge touched: bar high >= B (long) or low <= B (short). Outcome EDGE = edge touched in an earlier bar than the stop; STOP = stop touched first, or both in the same bar (conservative, counted separately); NONE = neither by the flatten.
- Direction-blind placebo (the null): for the same session, every bar k whose previous bar ends within 15 minutes (900 s) of the tell's signal-bar end, k != the tell's entry bar, in BOTH directions g = +1 and -1: entry = open[k] + g x 1 tick, stop = entry - g x R, edge = entry + g x D, same walk and same rules. This keeps the tell's own distances, volatility state and time left to the flatten, and has no directional knowledge by construction (each bar is taken both ways). The placebo rate of a tell is the mean over its placebo races.
- Implied rate of a driftless walk, R / (R + D): DESCRIPTIVE only (it ignores the flatten).

## Counted test (ONE test, T1)
T1: mean over tells of [EDGE] minus the mean of the tells' placebo EDGE rates (all tells in the denominator; NONE counts as not-EDGE on both sides). Day-blocked bootstrap (10,000 resamples of sessions, seed 20261110), 95 percent interval, two-sided p. Charged as 1 test to family `tell_geometry_null_20261110`; quarter-level Holm 0.10 applies to the forward verdict.

Power, stated before the run: with about 1,750 tells and an EDGE rate near 30 percent the standard error is about 1.1 to 1.5 percentage points (day clustering), so the smallest difference this can see is about 3 to 4 points. A null therefore means "no directional knowledge larger than about 4 points of touch rate".

## Null gate (must pass before T1 is read)
The placebo must be direction-blind in fact: the long-placebo EDGE rate minus the short-placebo EDGE rate, averaged over tells, has to be within its own day-blocked 95 percent interval of zero OR smaller than 2 points in size (a market drift of that size is expected in a rising index and is removed anyway by taking both directions). Also a code check on synthetic bars (a path that goes straight to the edge, straight to the stop, both in one bar, neither). If the gate fails, T1 is not read and the fault is fixed first.

## Descriptive (uncounted)
- STOP-first and NONE rates, tell vs placebo (bears on the live stop share: 62 percent in the replay, 78 percent live).
- The same three rates inside the engine's own 120-minute window.
- Tell EDGE rate and placebo EDGE rate by decile of the implied rate R / (R + D), with the implied rate beside them.
- By direction (long, short) and by year.
- Geometry-only dollars: `trade.stripped()` (same stop distance, 120-minute time exit, 15:55 flatten, $2 a point, $2 round trip) for the tell vs the same call on its placebo bars in both directions.
- Sensitivity: T1 without sessions on or one day after a contract stitch or on a bad-bar date (`scripts/lib/nq_roll_stitch.py`).

## What is NOT tested
The tell's own exits (fade exit after the break, timeout), the live fills and the three large entry slips, Globex (the tell is an RTH rule), and the hold-out era.

## Next-step tree (co-022)
- T1 positive and its interval excludes zero: the tell has directional knowledge on explore (a lead). Then the live loss is a fill / stop-size / exit problem, not a direction problem: next is the risk-rule study (candidate D: dollar-risk cap, same-direction lockout) and the review of the three slipped entries. Forward check below still decides.
- T1 inside its interval of zero: no directional knowledge larger than the stated minimum could be shown. The replay profit then rests on the trade's shape. Next: the same comparison in dollars with the engine's full exits against the placebo (one further pre-registered test); keep tell orders paused until one of the two shows something. First null of the two that co-025 requires; parked, not retired.
- T1 negative and its interval excludes zero: the tell marks the end of a move more than its start. A lead for a separate, separately registered fade test; nothing is flipped on this result.

## Forward verdict (the one that counts)
The same T1 on live tell fires from 2026-10-28 on (`amt_tell_live` fires are logged whether or not orders are placed), read once at 150 fires and once at 300. Kill rule: T1 not positive at Holm 0.10 at both reads = parked.

## Script
`scripts/vacuum_sim/tell_geometry_null.py` (`check` = synthetic code check, `build` = the replay that writes one row per tell, `count` = outcome-blind counts, `run` = gate then T1). Output `scratch/tell_geometry_null_20261110/`.

## RESULT (2026-11-10 night; look 271; output `scratch/tell_geometry_null_20261110/output.txt`): NOT SHOWN ON THE TOUCH RATE; A SMALL UNCOUNTED LEAN IN DOLLARS
- Counts: 1,760 tells replayed, 3 excluded (opened through the edge), 1,757 used on 488 sessions; median stop distance 26.25 points, median edge distance 130; 49 to 139 placebo bars per tell.
- Null gate PASSED: long placebo 20.34 percent, short placebo 20.80, difference -0.46 points [-2.82, +1.90]. Code check passed (8 cases).
- **T1 (the counted test): tell 20.66 percent edge-first vs direction-blind placebo 20.57; difference +0.09 points [-1.28, +1.53], two-sided p 0.897.** The interval is tighter than the power statement expected: a directional effect of more than about 1.5 points of touch rate is ruled out on explore.
- Stop-first: tell 66.3 percent vs placebo 66.7 (difference -0.4 [-2.2, +1.4]). Neither by the flatten: 13.0 vs 12.7. Inside 120 minutes: edge 18.4 vs 18.2, stop 62.2 vs 63.1, neither 19.4 vs 18.7. No same-bar ties.
- Flat everywhere it was cut: all ten deciles of the implied rate (differences between -2.0 and +1.9 points, the placebo tracks the tell from 1 percent to 75 percent), longs +0.9 [-0.9, +2.8], shorts -0.7 [-2.8, +1.4], 2023 +1.0, 2024 -0.6, 2025 +0.1. Without the 34 tells on stitch or bad-bar sessions: +0.04 [-1.37, +1.45].
- The driftless formula R / (R + D) averages 26.2 percent against 20.6 realized: the flatten cuts races short, which is why the placebo and not the formula is the null.
- UNCOUNTED, geometry-only dollars (the tell's stop distance, 120-minute time exit, flatten, net of $2): tell +2.61 per trade, direction-blind placebo -3.17, difference +5.79 [+0.76, +11.25], p 0.022. The engine's own V1 net on the same rows is +1.90. Since the touch rates are equal, this lean comes from the trades that reach neither level (drift in the tell's direction over the hold). It is one descriptive number that was not the registered test; read it as the reason to run the dollar test, not as an edge.
- UNCOUNTED: nearby bars taken the tell's way make +10.78, so the tell's own entry is 8.17 [4.64, 11.39] worse than its neighbours. Part of that is hindsight (neighbours before the signal already hold the move that caused the signal), so it is not evidence that a different entry would do better; it is consistent with the entry coming after the move.
- What this means in plain words: after a tell, price is no more likely to reach the range edge before the stop than a coin-flip direction with the same distances. If the tell has anything, it is a small drift on the trades that go nowhere fast, about $6 a trade before live slippage, against live stops that have been running $83.
- What it does not show: anything about the tell's fade exit, live fills, or the hold-out era.
- Next (per the tree, branch 2): one further pre-registered test in dollars with the engine's full exits against the direction-blind placebo; tell orders stay paused until that or the forward read shows something. First of the two nulls co-025 requires; parked, not retired.
