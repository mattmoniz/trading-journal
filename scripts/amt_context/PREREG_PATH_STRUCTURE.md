# Pre-registration: the path-structure test ("hit probability"): after a signal, how does price actually travel? (written 2026-11-02 BEFORE the script exists; user request: "write the hit probability test ... think it through thoroughly with all possibilities in a given situation, don't be myopic"; nothing computed here)

## 0. Why this test, and why it is not another dollar bracket
The forecast-sized brackets (`PREREG_FORECAST_BRACKET.md`, claim `forecast_bracket_four_cells_not_shown_20261102`) were a dollar test with confidence intervals of about +/-$5 per signal, built on fill rules that lean pessimistic. A dollar result mixes four things: whether price reverts, how far it runs, how the bars are resolved, and the cost model. This test removes the cost model and the fill rules and asks only about MARKET BEHAVIOUR (hr-057): the probabilities of the possible paths after a reference price, with the dollar-relevant break-even written next to each so the result can be read in money terms without being a money claim. Explore only (<= 2025-05-16), the sealed window is not read, nothing live, no trade rule is produced.

## 1. Every situation after a signal (the path tree), and what each branch would pay
Reference P = close of the signal bar i (a completed 500-volume bar), t0 = its end. Distance k > 0 (section 3). Levels: U1 = P + k, D1 = P - k, U2 = P + 2k, D2 = P - 2k.
Stage 1, TOUCH: within W1 = 30 minutes of t0 price reaches U1 or D1 (first one; same-bar both = AMBIG_TOUCH). Possible: UP touch, DOWN touch, NO touch (a quiet period: nothing for a symmetric bracket to do).
Stage 2, RESOLUTION after a touch (bars strictly AFTER the touch bar, within W2 = 30 minutes of the touch bar's end): REVERT (price gets back to P), EXTEND (price reaches the next level, U2 or D2), TIMEOUT (neither; flatten at 15:55 also ends it), AMBIG_RES (a bar reaching both).
| Path | What it would pay |
|---|---|
| NO touch | a symmetric bracket never fills; no trade, no cost |
| touch then REVERT | the two-sided LIMIT fade wins (target P); a breakout entered at the touch loses (stop back at P) |
| touch then EXTEND | the breakout wins (target U2/D2); the limit fade loses (stop at U2/D2) |
| touch then TIMEOUT | both exit at market near the touch level, a small loss to costs; the share is reported because it dilutes every structure |
| touch then partial move | covered by section 4 (target/stop asymmetry grid) and the run-length distribution (convex "let winners run" structures) |
Structures this test CAN speak to: the symmetric limit fade, the symmetric stop breakout, asymmetric reward:risk variants of both (section 4), and convex runner structures through the run-length distribution (section 4). Structures it does NOT test (named so the scope is not mistaken for completeness): other reference anchors (VWAP, POC, range boundary, a node: "revert TO a level" is a different tree), confirmation / retest entries (enter after a pullback), skip-or-gate uses of the signal, Globex, scale-outs and trails (a standing user decision: no more trail research), ES, order sequence inside a bar (needs tick data), live OCO behaviour in Sierra Chart (documentation to be fetched first, hr-027).
What would make a no-direction structure work, stated in advance so the result is read against it: (a) P(revert) or P(extend) differs from one half by more than the cost break-even (a real asymmetry in the path, either way), or (b) a convex payoff: a fat enough tail of extensions that a capped loss and an uncapped run pays. A pure volatility change (bigger moves, same probabilities) cannot pay a symmetric structure by itself.

## 2. Populations (all from existing code; k needs the walk-forward forecast, so the first 120 dates are model-train only, as in the bracket test)
- TELL: every V1 simulated signal bar after the first 120 dates (1,379 expected; `T.simulate`), P = that bar's close.
- CONTROL: decision-grid bars (every 10th bar index, 10:00-14:30, complete) with price moving in at least one direction and no tell in either direction (ncomp < 5, not gated by the range), as the bracket test.
- ALL: every decision-grid bar with a usable forecast (the unconditional market, tell and no-tell, moving and not). Used for the market-structure question that does not depend on the tell.
- Each point also requires a complete 60-minute data window (`end[comp].max() >= ts + 3540`) so the tree can resolve; points failing it are dropped and counted. No outcome is used for any selection.

## 3. Distances (scale-free, causal, with a floor from the data's own resolution, hr-044)
k = max( floor, round_to_tick( c x forecast E_30 in points ) ) with c in {0.25, 0.5, 0.75, 1.0} (the walk-forward no-tell model of Amendment 3, `walkforward_forecast.block_forecasts`, times ATR20 in points) and floor = 2 x the median (high - low) of the 20 bars ending at the signal bar (a distance below about two typical bars is inside bar-resolution noise). The number of points hitting the floor is reported per cell. Four distance cells; no other value is tried.

## 4. Statistics computed at every cell (counts first, outcomes after)
- Touch rate; share AMBIG_TOUCH; among touches: REVERT, EXTEND, TIMEOUT, AMBIG_RES shares; the share of touch bars whose own range already covers P (a revert inside the touch bar that the later-bar rule cannot see) and the same for U2/D2; each as counts.
- PRIMARY quantity: Q = P(revert | resolved) = REVERT / (REVERT + EXTEND), side-pooled (an up touch and a down touch are mirror images). Also by touch side (up, down: equity drift) and by touch side relative to the tell's direction (with / against; TELL only).
- Cost break-even next to Q (constants from `trade.py`: $2 per point, $2 round trip, 1 tick = 0.25 slip): fade wins k - 1.0 points net, loses k + 0.25 + 1.0, so p*_fade = (k + 1.25) / (2k + 0.25); breakout via a stop entry wins k - 1.25, loses k + 1.5, so p*_brk = (k + 1.5) / (2k + 0.25). Computed per point from its own k and averaged per cell. They ignore timeouts (which cost a little more), so they are floors, stated as such.
- Asymmetry grid (uncounted): for targets t in {0.5k, k, 2k} and stops s in {0.5k, k, 2k} measured from the touch level, the probability that the fade-direction move (back toward P, target) hits before the stop, TELL vs CONTROL vs ALL, with the gambler's-ruin reference for a driftless walk s/(s+t) next to it. This answers "do an unequal target and stop help" without a new dollar test.
- Run-length distribution (uncounted, mechanism for convex structures): M = (maximum excursion beyond the touch level before REVERT or the window end) / k, quantiles and mean; a convex runner needs the tail, so the 90th and 99th percentiles are reported with the mean.
- Day-blocked bootstrap CIs (3000 draws, seed 20261102) on everything; TELL vs CONTROL standardised to the tell's entry-time mix (under 90, 90-180, 180+ minutes after 09:30), the same device as the bracket test; chronological halves (median date) and the four quarters (era flips are real here, cv-033).
- Structural splits, MANDATORY and uncounted (a pooled verdict is a question, cv-033): causal forecast third (expanding cutoffs, first 100 TELL points / 2,000 ALL points seed them), entry-time bin, quarter, touch side, touch side vs tell direction. A split that looks good is a LEAD for a forward test only.
- Resolution first: the script prints, before any verdict, the CI half-width of Q for each arm and cell (the minimum detectable effect). Expected from the arithmetic (not a result): about 1,100 resolved TELL points on about 370 dates give Q a day-blocked half-width near +/-4 to 5 points, WIDER than the roughly 1 to 2 point margin that costs require (p* - 0.5 is about 0.011 at k = 50 and 0.022 at k = 25). So the TELL arm can only detect a large structural effect; only ALL and CONTROL (about 20,000 points) can resolve a cost-sized asymmetry. This is stated now so a tell-arm null is not later read as "no effect".

## 5. Counted tests (family `path_structure_20261102`; ledger tests = 12; BH q = 0.10 within each group)
- M1-M8, the market-structure question on ALL, one pair per cell: M_fade = "Q exceeds p*_fade" (CI lower bound of Q > p*_fade) and M_brk = "P(extend | resolved) = 1 - Q exceeds p*_brk" (CI upper bound of Q < 1 - p*_brk). PASS of either also needs the same sign in both halves.
- T1-T4, tell versus control, one per cell: difference in Q (TELL minus CONTROL, entry-time weighted), PASS = CI excludes zero AND same sign in both halves AND the same sign in at least 3 of the 4 cells (the cells share their paths, so they are not independent; the rule demands a curve, not a point).
- Everything else is uncounted and labelled so.

## 6. Reading rules (fixed now)
- M pass (either side) on ALL with the split reading consistent in at least 3 of 4 quarters: the market has a path asymmetry at that scale independent of the tell; next step a pre-registered FORWARD shadow measurement, not a trade rule. A pass confined to one quarter is an era effect, not a finding.
- T pass: the tell changes the path structure. The SIGN says which structure it favours (more reversion after a tell -> fades; more extension -> breakouts and runners) and is reported with the era split first. Next step a forward shadow comparison.
- Neither passes with the resolution printed: at these scales the paths behave like a symmetric random walk with a bigger amplitude after a tell, so no symmetric 1:1 structure can pay; the remaining routes are payoff asymmetry through targets and stops (the asymmetry grid), convexity (the run-length tail), or levels (a different reference anchor, its own prereg). A null is reported with the resolution and with what could not be shown, never as "the idea is wrong".
- Under no outcome is any rule, any order, any switch or any live change made from this test.

## 7. Harness, tests and what must reproduce before an arm is read
- Unit tests of the tree classifier on synthetic bars (no touch, up/down touch, revert, extend, timeout, same-bar ambiguities, flatten, window edges) and one mutation (a revert counted from the touch bar itself) that the tests must catch; `test_path_tree.py`.
- Reproduction: the TELL touch rate at c = 0.25 and c = 0.5 must agree within one percentage point with the recorded bracket fill rates (99% and 83%; a touch needs no one-tick-through, so the touch rate is allowed to be at most about one point higher), and the TELL / CONTROL point counts must equal the bracket run (1,379 and 19,653 before the 60-minute window requirement; the dropped number is printed).
- Sensitivity, uncounted: k in ATR20 fractions {0.1, 0.2, 0.3} on all 516 dates for the 2,591 tell grid points (needs no model, more points, more power) against the control, to see whether the result depends on the forecast scale.

## 8. Follow-ups that depend on the outcome (not part of this test)
Any lead goes to the forward tags: the nightly forecast tagger could also log each tagged tell's path outcome (touch, revert, extend) so the sample grows without new orders; that build needs the user's go. Tick-level resolution (the tick archive covers 836 RTH sessions) is the natural refinement of any lead.
