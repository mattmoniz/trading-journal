# Defended breaks and flushes as gates / counter-gates / boosts for the rest of the roster (2026-10-19, DESIGN ONLY, nothing built)

Status: for independent design review (DeepSeek) BEFORE any code or number is trusted. User directive 2026-10-19: "we may want to test defended levels or flushes as gates or counter gates to detect trend shifts. If they are aligned ... even better." Related: the user's rule that MAJOR_PIVOT_DEFENDED_BREAK and RTH/Globex flush setups are NOT themselves gated by the 65pt POC rotation (exempt, `acdRiskGates.js`).

## Question
Does a recent defended-level break or a flush (a structural trend-shift event) change how the REST of the roster performs?
- COUNTER: a roster candidate whose direction is OPPOSITE to a recent event (e.g. a long fade right after a major defended break DOWN) -- hypothesis: worse than average, a candidate for blocking or SHADOW.
- ALIGNED: candidate direction SAME as the recent event -- hypothesis: better than average, a candidate for a size boost / priority.
- Direction of the effect is open; either sign, or none, is an acceptable answer.

## Event sources (the REAL functions only, never reimplemented)
1. Major defended breaks: `computeDefendedBreaks(threshold, lookbackDays)` (`majorPivotDefendedBreakDetector.js`), 365 days: 85 breaks at zigzag 1.0 (59 RTH / 26 Globex), 41 at the live 1.5. Direction known; event time = completed 5-minute bar close (bucket start + 5 min) -- NOT the bucket start (see the partial-bar finding, `major_pivot_live_rows_always_miss_3min_entry_window_20261019`).
2. Flushes: RTH_FLUSH_* and GLOBEX_FLUSH_* rows exist in `active_setups` only since 2026-08-28/09-01 (RTH 24, Globex 31, all SHADOW). A longer bar-derived history needs the detectors' own pure functions (`rthFlushDetector.js`, `globexFlushDetector.js` -- the exported surface was listed in the session; check what is reusable before writing anything). If no pure exported function exists, the first step is exporting one (the repo's "export the real function" rule), not copying the math.

## Outcome populations (roster candidates being gated)
`active_setups`, primary rows only (`is_cluster_primary IS NULL OR true`), `actual_pnl IS NOT NULL`, excluding the event families themselves. Last 365 days: ACTIVE 1,019 trades / 70 days, SHADOW 5,674 / 73 days, BACKFILL 8,716 / 195 days (synthetic strategy simulation), UNKNOWN 686. Each origin analysed SEPARATELY and labelled; BACKFILL is a simulation, not an account record. Use the broker P&L where it exists only for ACTIVE rows (display truth); for an EV test use `model_pnl` / `actual_pnl` consistently within a population.

## Method requirements (each guards a known failure of this codebase)
- Alignment defined from direction fields only; lookback L after an event is a SMALL pre-registered grid (e.g. 2h / 6h / same session / 24h), never tuned to a result; report all L (multiplicity).
- Effective N is the number of EVENT-DAYS, not trades (all trades near one event are one correlated draw). Report both; do not call anything decisive below ~20 distinct event days.
- Compare the arms with PER-TRADE means (sum/N) per arm and a DAY-BLOCKED bootstrap CI on the DIFFERENCE (resample whole days, pool trades per arm, per-trade-mean difference) -- NOT the day-weighted point estimate (the 2026-10-12 split-comparison inflation).
- Controls: (1) placebo: shuffle event directions across events, or shift event times by +/- k days, re-run the identical comparison; (2) same-selection-minus-the-signal control (trades in the same window with no event); (3) check that ALIGNED vs COUNTER is not just "trade direction vs the day's drift" (a pure market-direction control, `RESEARCH_CLAIM` pooled-verdict rule: split by family -- fades vs breakouts -- and RTH vs Globex before trusting any pooled number).
- Roster-churn confound (CLAUDE.md): the roster grew ~3.5x in the real-trade window; report the weekly distinct-setup count and restrict to a stable-roster sub-window.
- Persist: `RESEARCH_CLAIM` via `recordClaim()` (positive or negative); recheck path: weekly script; consumer: only after a result, via an explicit OPEN_DECISION (gate vs boost, RTH and Globex both evaluated per the standing rule).

## Questions for the reviewer
1. Is "most recent event within L hours" the right alignment definition, or should the event's own lifecycle (e.g. until an opposite break) define "active"? What is the cleanest way to avoid lookahead (the event is only known at its completed bar close)?
2. With 41-85 break events a year (~47-53 days) and thin flush history, is any test of this idea adequately powered? What minimum detectable effect, and what would you do if the answer is "too thin": pool thresholds 1.0/1.25/1.5, use bar-level forward returns of the market instead of roster trades (the repo's "market behavior hypotheses go through bar history first" rule), or wait for forward data?
3. Which control best separates "event information" from "trade direction vs the day's drift"? Is the shuffle/shift placebo enough?
4. Confounds I may have missed (roster-churn, cluster siblings, session mix, the partial-bar entry issue in the live MAJOR_PIVOT detector, the rotation gate being off since 2026-10-14).
5. If the effect is real, how should it be wired so it is a SHADOW tag first (the repo's convention) and so RTH and Globex are both covered? Which existing mechanism is the right place (sizeMultiplier is mostly stripped, `computeSizeMultiplier` in touchQuality.js; force-SHADOW gates in the insert chain)? Beware the later-override-wins ordering rule.
6. What would make you stop and call it negative, and what is the exact pre-registered promote/kill criterion?
