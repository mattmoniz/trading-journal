# Pre-registration: POC join blown through at a range edge as a breakout sign (written 2026-10-28 BEFORE any outcome)

Origin: user idea 2026-10-28, `OPEN_DECISION poc_join_blown_through_at_range_edge_breakout_idea_20261028`: "when a POC Join is blown through at the top or bottom of a range (the edges), that may be a sign of a breakout." A market-behaviour question, so it runs on raw bar history first (CLAUDE.md), not on `active_setups` trade N. Script: `scripts/study_poc_join_edge_blowthrough_20261028.mjs`. Window pinned: 2023-03-06 .. 2026-10-27 (a live table grows, so every number comes from one run with this fixed end date). PRE = trade dates before 2025-06-01, POST = on or after.

## What the join is (read from the code, `pocRotationService.js detectSignalEvents`, `pocRotationJoinDetector.js`)
A 65-point ZigZag leg whose own volume-median has converged back to the 24-hour running median. The join trades WITH that leg (UP leg -> long). So a join pointing away from an edge has its stop on the edge side; "blown through" therefore means price goes through the edge on the stop side, against the join. This is the reading tested (AGAINST). The other reading (a join pointing AT a near edge, then price breaks that edge in the join direction) is NOT tested here; it is recorded as untested.

## Events
Join events come from the real detector via `scripts/lib/pocJoinLoader.mjs` `buildEvents` (R = 65, withVolume true, roll weeks excluded), the same construction the live poller uses. Sanity check before any outcome: match events to real `POC_ROTATION_JOIN` rows in `active_setups` (same minute of `fired_at`, same direction) for 2026-09-01..2026-10-27 and report the match rate; most real rows should line up. A join's lifetime window is the loader's `fwd()` (next join of either direction or 24 hours).

## Edges (all computed from `price_bars_primary` bars, never from `level_prices`/`developing_value_log`, which have a history of going stale; all known before use)
- ONH/ONL: high/low of 18:00 prior evening .. 09:29 of trade date d. Known 09:30. RTH arm only.
- PD high/low: high/low of the previous RTH session (09:30-15:59). Known from the prior evening.
- IB high/low: 09:30-10:29 of d. Known 10:30. RTH arm only.
- GIB high/low: first 60 minutes of the Globex session (18:00-18:59 prior evening). Known 19:00. Globex arm only.
Arms (each judged alone): RTH-ONH/ONL, RTH-IB, RTH-PD, GLOBEX-PD, GLOBEX-GIB. RTH = join entry bar 09:30-15:59; Globex = 18:00-09:29; 16:00-17:59 is the dead zone and is dropped. A join counts for an arm only if its entry bar is after the edge is known and the join's trade date is d.

## "At the edge" (near), derived from the data, outcome-free
For a LONG join the stop-side edge is the low-side level (ONL / PD low / IB low / GIB low); for a SHORT join the high-side level. dist = (entry - level) for a long, (level - entry) for a short, divided by ATR20 (mean RTH range of the previous 20 sessions). A join whose entry is already beyond the level (dist < 0) is excluded and counted. NEAR = dist at or below the 33.3rd percentile of dist across ALL joins of that arm (both sides pooled, computed from joins alone before any outcome). FAR = dist above the 66.7th percentile.

## Test 2 (PRIMARY): does a join blown through at the edge precede a held breakout that continues
Break events (one per arm level per day per side): the first 1-minute close beyond the level after the count start (RTH: 09:30, IB from 10:30; Globex: 18:00 prior evening, GIB from 19:00), break bar b0 no later than 15:29 (RTH) or 09:14 (Globex). HELD: every 1-minute close from b0 through b0+15 bars stays beyond the level. The held-break EVENT is bar b0+15; entry = open of the next bar.
- SIGNAL: a NEAR join (against side, dist at or below the arm cutoff, dist >= 0) whose direction is opposite to the break, whose entry bar is strictly before b0, and whose lifetime still covers b0.
- CONTROL: every other held break of the same arm (same levels, same days, same hold rule, no such join). This is the SAME_SELECTION_NO_SIGNAL control (CLAUDE.md confound checklist item 3): any held break of that edge continues somewhat, so the signal must beat held breaks without the join.
- Outcome: signed (in the break direction) move from the entry open to the close at +30, +60, +120, +240 minutes, in units of ATR20; horizons past the session end (15:59 RTH; 09:29 Globex) are dropped. Primary horizons +60 and +120; +30/+240 reported.
- Statistic: per-event mean of each group; difference SIGNAL minus CONTROL; the day-blocked bootstrap (resample trading days, pool the events of the resampled days per group, difference of per-event means) is used for the CI only, never for the point estimate (CLAUDE.md split-comparison rule). 2000 draws, seeded.

### Pass criteria (an arm "shows a blown-through-join breakout sign" only if ALL hold)
1. N_signal >= 40 events on >= 30 distinct days; below that the arm is reported UNDERPOWERED with its resolution (the day-blocked CI half-width), not as a null.
2. SIGNAL minus CONTROL > 0 at +60 and at +120, day-blocked 95% CI excluding zero at both.
3. SIGNAL mean at +60 > 0 with its own day-blocked CI above zero (continuation in absolute terms, not only relative to controls).
4. Same sign of SIGNAL minus CONTROL in PRE and POST at +60 and +120.
5. Top-5 days' share of the summed signed SIGNAL move < 50 percent of a positive total.
Five arms are tested; one pass among five is a LEAD for one frozen second look on a later window, not a result (chance expectation at these thresholds is well under one arm). If an RTH arm passes and its Globex analogue does not (or the reverse) the conclusion is "session-specific", not a rule. Long-join/short-break and short-join/long-break are reported separately (CLAUDE.md pooled-verdict rule); the pass is judged on the pooled arm, a sign split between the two sides is noted.

## Test 1 (SUPPORTING, not counted toward the pass): does the join work worse near an edge
For every join with dist >= 0: with-join signed move from the entry open at +60, +120, +240 minutes (ATR20 units, capped at session end). NEAR minus FAR, same day-blocked CI. Reported per arm and per join direction. A negative difference means the join is weaker at the edge (link 1 of the idea). Also descriptive: the share of NEAR vs FAR joins whose edge gets a HELD break within the join's lifetime.

## Not tested here, recorded
- The join pointing AT a near edge (WITH reading).
- A trade rule (stop, target, sizing). Only if an arm passes does the follow-up ask whether a rule can capture it, with its own prereg and realistic-fill exits.
- Overlap with the live node-ladder tell: only if an arm passes, check whether the signal events coincide with research-tell fires (`scripts/amt_vbars`, explore dates) in the preceding hour.
- Leg-size or POC-distance sub-splits of the join, a continuous distance dose-response beyond terciles, order-flow enrichment.

## Reading rule
Every result prints counts first (events, joins matched to real rows, dist cutoffs, SIGNAL/CONTROL N and distinct days per arm) before any outcome; the run is one continuous script. Whatever happens is recorded with `recordClaim()` (claim slug `poc_join_blown_through_at_edge_*_20261028`) and the decision is resolved or updated with the numbers, including what could not be shown (resolution of the day-blocked CI).

## Amendment 1 (2026-10-28, written after the outcome-free census, BEFORE any outcome was computed)
Census (`--census`, counts only): real-row sanity match: 98 of 219 real rows match a replay event at the exact minute and a further 96 within 30 minutes in the SAME direction (replay events fire a median of a few minutes before the live row); of the 25 with no replay event within 30 minutes about 20 fall in the 2026-09-10..14 NQ roll week, which `buildEvents` excludes by design. So the replay population is the live population, timed a few minutes earlier. Held-break counts under the original "first close beyond the level that day" rule were SIGNAL N = 12 / 6 / 8 / 7 / 4 (RTH-ONH/ONL, RTH-IB, RTH-PD, GLX-PD, GLX-GIB) against a pre-registered floor of 40: the original Test 2 is structurally UNDERPOWERED. Cause: a near join follows a 65-point leg that usually started AT the edge, so the day's first close beyond that edge has typically already happened before the join exists and is excluded by the "break after the join" rule.
Change (one, applied to SIGNAL and CONTROL alike): a break event is a FRESH break, not the day's first. A fresh break is a close beyond the level after at least 30 consecutive closes not beyond it (30 = twice the hold window, so one excursion yields one event; the window start counts as armed). Hold rule (15 further closes all beyond), entry, horizons, ATR20 units, NEAR/FAR cutoffs, SIGNAL and CONTROL definitions, pass criteria and the day-blocked statistics are unchanged. The fresh-break version is the PRIMARY Test 2 from here; the original day-first version is still run and reported as "Test 2-orig" (expected UNDERPOWERED, not counted). No cutoff, level or threshold was changed after seeing any outcome, because no outcome had been computed.
