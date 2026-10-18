# Auction state (balance vs expansion) as the explanation for why defended levels hold or break -- scoping spec v2 for external review

Status: DRAFT v2, 2026-10-18 (v1 framed this too narrowly as a POC-rotation-only experiment; the user then clarified the real goal, below). Nothing here is built. Research only, no live wiring. Written to be read standalone by a reviewer with read access to this repo (`/home/mmoniz/trading-journal`).

## 1. The idea, in the user's own terms

Use TPO / market-profile thinking **together with POC rotation** to understand **whether the market is over-extended and wants to revert, or wants to reach for new territory and keep going.** That is the reason a defended level works or doesn't:
- **Balance (contained market):** price is over-extended relative to value and wants to revert. Defended levels hold; the system's *calibrated* stops and targets (derived from past data in exactly this regime) work well because the market stays contained.
- **Expansion (reaching for new territory):** price is accepted outside value and keeps going. Defended levels FAIL (they get run through). Here the system should (a) **allow breakout / continuation trades** and (b) **stretch targets**, because the market will move further than the calibrated target assumes.

So the deliverable is not "a better POC-rotation filter". It is **a measurable auction-state variable that (1) predicts hold vs break at a level, and (2) tells the system when to fade with calibrated targets, when to stand aside, and when to follow with stretched targets.** POC rotation (rotation structure, POC migration) and TPO shape are two ways of measuring that state; they are used jointly. Triggering anecdote: Fri 2026-10-16, POC-rotation longs kept firing and failing while NQ fell ~700pt (an expansion/trend day) -- the rotation looked like balance behaviour but the market was building to go lower.

A related, larger framing the user raised: a **multi-timeframe** view (big = weekly/multi-day premise incl. single-print gaps the market tends to come back to fill; medium = prior-day / composite value; small = the live trigger) so the "state" is read in context, not from the last hour alone.

## 2. What the system does today (reuse; do not rebuild)

| Capability | Where |
|---|---|
| Defended-level fades at named levels (PD VAH/VAL/POC, OR/IB, pivots, weekly/monthly...) with CALIBRATED stop/target per setup_type | `acd.js` level-fade engine, `performance_audit` `OPTIMAL_STOP`/`SETUP_STATUS`, `scripts/update_optimal_stops.mjs` |
| The only existing "stretch" mechanisms (blunt, not state-aware): 1.5x wider target, step-trail runner, T1-floor runner, breakeven stop | `widerTargetWalker.js`, `stepTrailWalker.js`, `t1FloorRunnerWalker.js`, `breakevenStopWalker.js` |
| Defended-level breakout/pivot detectors | `majorPivotDefendedBreakDetector.js`, `stallDefendedLevelDetector.js`, `minorDefendedLevelDetector.js` |
| 65pt rotation legs / convergence events, POC-rotation join setup + its exit | `pocRotationService.js` `detectSignalEvents`, `pocRotationJoinDetector.js`, `pocBreakevenHoldWalker.js`, `rotation65ptGateShadow.js` |
| Volume profile POC/VAH/VAL (volume spread across each bar's H-L) | `developingValueService.js` `computeProfile` (the ONLY sanctioned implementation) |
| Prior-day / weekly / monthly levels, value-area overlap, day type, regime labels, GARCH scale | `level_prices`, `developing_value_log`, `acd_daily_log`, `regime_label_*`, `GARCH_VOL_SCALE` |
| Bars (NQ 1-min with bid/ask volume; a VIEW -- always bound both ends of `ts`) | `price_bars_primary` |
| Stats | `rigorDiagnostics.js` `dayBlockedBootstrapCI`, `computeRigor`, `computeReplication` |

**Not in the codebase:** any TPO construct (30-min brackets, tails/excess, single prints, poor highs/lows), an auction-state classifier, a multi-day composite POC, any state-conditioned target or stop.

## 3. Hypotheses (market-behaviour hypotheses are tested on raw bar history FIRST, per house rule; trade-level only afterwards)

- **H1 -- hold vs break.** At a touch of a defended level, the as-of-touch auction state predicts whether the level HOLDS (price reverts toward value) or BREAKS (continues through and extends).
- **H2 -- extension size.** Conditional on state, the distribution of favourable/adverse excursion after the touch differs enough that stretching targets in expansion (and keeping calibrated ones in balance) beats the single calibrated stop/target pair.
- **H3 -- rotation is read through state.** POC-rotation JOIN (follow the leg back to fair value) works in one state and fails in another; rotation structure + POC migration + extension-from-value together are the state measurement.
- **H4 (only if H1-H2 hold).** In the expansion state, breakout / continuation entries at the same levels have positive expectancy that the fade roster currently forgoes.

Units of analysis: (i) **level touches** across the existing level families (bar-history scan of touches; outcome = reversion distance vs continuation distance over fixed bar horizons, computed from FUTURE bars as OUTCOME only); (ii) the 65pt rotation events (for H3).

## 4. Measuring "over-extended vs reaching" (candidate as-of features; all bucketed from rolling distributions)

a) Developing-session POC location `L=(POC-VAL)/(VAH-VAL)` and its slope (POC following price = acceptance / migration; POC lagging = rejection / reversion).
b) Price vs the PRIOR day's value area (inside/above/below) and time spent outside it; distance beyond VAH/VAL in value-area-width units, z-scored vs trailing history.
c) Rotation structure so far: count and size of 65pt legs, overlap vs one-directional; many overlapping rotations ~ balance, one-directional legs with POC following ~ expansion.
d) Multi-day (the big picture): 3-5 day composite POC position, prior-days' value-area migration (overlapping vs stair-stepping), proximity of unfilled single-print gaps (as a pull/target).
e) Volume z-score vs the time-of-day baseline; delta alignment z-scored per minute-of-day.
f) TPO shape layer (later, only if a)-e) show a signal): poor high/low, excess, single prints from 30-min brackets built from 1-min bars.

## 5. Hard constraints (the review must respect these)

1. **No static thresholds** -- every cutoff from a rolling distribution (the long external TPO spec's 30min/2 closes/1.5x/5 TPOs/0.7-0.3 constants must be re-derived or dropped; pure structural definitions like "poor high = >=3 TPOs at the extreme" may be pinned as pre-registered conventions, never re-fit).
2. **No lookahead**: every feature as-of the event bar; a developing profile uses bars <= t only; a leg's end and a level "breaking" are only known later.
3. **RTH and Globex separately** (these roster behaviours have reversed between the two before).
4. **Split-comparison rule**: plain sum(pnl)/N per arm; day-blocked bootstrap only for the CI on the delta.
5. **Placebo / geometry controls** for any asymmetric stop/target (gambler's-ruin baseline `stop/(stop+target)`), and a control that is NOT a self-referential target (a target set from the same population's own median MFE is a tautology).
6. **Confound boundary 2026-10-11/12** (PROMOTE_ALL_MODE stat gate, 65pt rotation gate, brand-new POC-join exit): fit only through 2026-10-10; later data is a forward check, never pooled.
7. **Drift control**: a down-trending (or up-trending) day makes any "down" state look predictive; state must beat a plain running-direction-so-far covariate.
8. **Effective N**: ~250 distinct days, not events; DeepSeek's earlier critique put the honest cell budget at ~6-8 pre-registered cells with Holm correction. "No usable state split" is a complete, acceptable result.
9. Data: NQ 1-min is dense only from 2025-11-20; roll weeks excluded via `acdShared.js`.
10. Anything that could later gate/size a live trade needs the 3-phase review. This document is phase 0.

## 6. Proposed staged plan (attack it)

- **Stage A (smallest):** ONE state feature -- developing POC location `L` (tertiles vs trailing distribution) -- with the running-direction-so-far control, on BOTH (i) level touches (H1: hold vs break, and the reversion/continuation distance distribution for H2) and (ii) rotation events (H3, exit-agnostic forward return). Kill rule: if no pre-registered arm survives, stop.
- **Stage B:** add b) prior-VA/time-outside and c) rotation structure, only as pre-registered 2-arm contrasts.
- **Stage C:** TPO shape features (poor high/low first -- the most bar-robust), then the multi-day / single-print context d).
- **Stage D (application, shadow-only first):** evaluate state-conditioned target/stop rules by PAIRED simulation on identical events (state-aware vs the current calibrated pair), then consider a breakout-allowance track (H4). Nothing live without the 3-phase review.

## 7. Questions for the reviewers

1. Is "state -> hold vs break, plus the excursion distribution" the right target for the user's goal? What is a better or additional target variable?
2. What is the smallest honest first experiment on LEVEL TOUCHES (not just rotation events)? Define "hold" vs "break" using future bars as OUTCOME only, without circularity or a self-referential threshold.
3. How do we define "over-extended" vs "reaching for new territory" lookahead-free and threshold-free from what exists (rolling percentiles)? How do extension-from-value, POC migration and rotation structure relate -- are they one construct or three?
4. How do we fairly test target-stretching: paired simulation design that avoids the asymmetric-stop gambler's-ruin trap and self-referential targets, and does not just reward a later/looser entry?
5. Overfitting budget: propose the concrete pre-registered cell list and correction for Stage A-B.
6. Which TPO features are worth building after Stage A, and which are noise from 1-min bars? Build on, do not repeat, `scratch/deepseek_response_poc_tpo_20261018.md` (your earlier answer to the narrower v1 question) -- say explicitly what changes now that the goal is hold-vs-break plus target stretching.
7. How do we include the weekly / single-print "big picture" without exploding the cell count?
8. What are the lookahead traps specific to a level "break" label and a developing profile, and what would you cut or kill first?

## 8. Output format requested

Write the answer to the response file named in the request. Sections: (0) one-paragraph verdict, (1) ranked holes, (2) recommended minimal experiment as a numbered protocol covering level touches AND rotation events, (3) answers to questions 1-8, (4) what you checked in the repo vs assumed. Concrete and short; mark speculation as speculation.
