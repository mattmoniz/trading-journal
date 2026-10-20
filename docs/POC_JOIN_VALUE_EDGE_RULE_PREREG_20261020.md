# Pre-registration: POC_ROTATION_JOIN "value-edge launch" rule (written 2026-10-20 BEFORE any outcome was computed for this rule)

Origin: DeepSeek review of the 2026-10-19/20 POC join work (scratch/deepseek_response_poc_join_review_20261020.md, item T3): replace the 21-feature ranker with ONE pre-registered discriminator, judged on tail metrics in both eras with a random-direction placebo. User agreed 2026-10-20. This file is committed before the test script is run; the criteria below are not to be edited after outcomes are seen (if they must change, write a new dated file and say why).

## The single rule (no other rule, feature or threshold may be tried and reported as the result)
A POC_ROTATION_JOIN event (real `detectSignalEvents` construction, 65pt, standard, point-in-time THETA, 2023-03-06..2026-10-16, roll weeks excluded; entry = open of the bar after the trigger bar) PASSES if the join continues a rotation launched from the prior day's value edge:
- LONG join (UP leg): the leg's ANCHOR price (low of the leg_start bar) lies within 0.15 x ATR20 of PD_VAL (|anchor - PD_VAL| <= 0.15 x ATR20).
- SHORT join (DOWN leg): the leg's anchor price (high of the leg_start bar) lies within 0.15 x ATR20 of PD_VAH.
- PD_VAL / PD_VAH = level_prices rows for the event's trade date (prior-period levels, known before the session opens). ATR20 = mean RTH range of the 20 sessions before the trade date. The anchor is the leg start, which is known at the trigger bar. 0.15 x ATR20 is the same proximity used elsewhere in this project; 0.10 and 0.25 are reported as sensitivity only and must NOT be used to select anything.

## Outcome
Realistic-fill live-exit P&L (E1): 100pt stop, breakeven stop from the 60th forward bar on, hold until the next event (either direction) or 24h, mark to market at the last forward bar; a stop already beyond the market at the bar it takes effect fills at that bar's OPEN (long: min(stop, open); short: max(stop, open)); $2/pt, $2 round trip; forward bars strictly after the entry bar. Identical to REALISTIC=1 in scripts/study_poc_join_exit_review_20261020.mjs.

## Comparisons (all day-blocked bootstrap, 2000 resamples, pooled per-trade mean = sum/N, never an average of day means)
- Primary: mean E1 P&L of PASSING events minus mean of ALL events, overall and separately for era PRE (trade date < 2025-06-01) and POST (>= 2025-06-01).
- Tail metrics: P(pnl >= +100 dollars) of passing events vs all; sum of P&L captured by passing events as a share of the total; top-5 events' share of the passing set's total P&L.
- Placebo 1 (random direction): the SAME entries and exit with the trade direction flipped; report the mean P&L of passing events under the flip.
- Placebo 2 (shifted levels): recompute the rule with PD_VAL/PD_VAH shifted by -0.6, -0.3, +0.3, +0.6 x ATR20 (same proximity), pool the four shifted populations, and report their mean E1 P&L; the rule's real edge = real-level passing mean minus shifted-level passing mean, with a day-blocked CI of that difference.
- Cells examined: the primary (1) + tail metrics. Nothing else is promoted. The by-era split is a required check, not a search.

## Pass criteria (ALL must hold; otherwise the conclusion is "POC join winners are not identifiable by this rule")
1. N of passing events >= 60 in EACH era.
2. Passing-minus-all mean > 0 in BOTH eras AND the overall day-blocked 95% CI excludes zero.
3. Real-level passing mean minus shifted-level passing mean: overall CI excludes zero (the value-edge location itself matters, not just any level-ish place).
4. Passing mean beats its random-direction placebo, overall and in both eras (point estimates).
5. Top-5 events' share of the passing set's total P&L < 50 percent.
6. P(pnl >= +100) of passing events > that of all events.
If it passes: the next step is a SHADOW tag only (never a live gate) plus a forward recheck on new sessions. If it fails, conclude POC join winners are not identifiable pre-entry with this rule and treat the strategy as a lottery for sizing purposes.

## Independent build
Gemini builds the same test from this file alone (not from Claude's script) and the two are compared; any material disagreement is traced before reporting.
