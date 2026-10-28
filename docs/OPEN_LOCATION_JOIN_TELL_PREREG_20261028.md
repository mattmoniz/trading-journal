# Pre-registration: does the RTH open location (vs overnight range, vs yesterday's value area) change how POC joins and the tell do (written 2026-10-28 BEFORE any outcome)

Origin: user 2026-10-28: "If price opens above overnight high or yesterday's VA, does that improve results, or vice versa for the overnight low and under yesterday's VA?" Read as: results of the POC join (and the research tell) conditioned on the open location, direction-aligned. Script `scripts/study_open_location_join_tell_20261028.mjs`. Window pinned 2023-03-06..2026-10-27 (joins), explore sessions through 2025-05-16 (tell). PRE < 2025-06-01 <= POST. Related and already done: Part A (`docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md`) found NO directional next-hours edge from open vs overnight range or vs prior value area for the market itself; this asks whether it conditions the SETUPS.

## States (per trade date d, all known at the 09:30 open)
- OPEN = open of the 09:30 bar. ONH/ONL = high/low of 18:00 prior evening..09:29 from bars. PD VAH/VAL = `level_prices` PD_VAH/PD_VAL of d (repaired 2026-10-27).
- ONH state: ABOVE (open > ONH), INSIDE, BELOW (open < ONL). VA state: ABOVE (open > PD_VAH), INSIDE, BELOW (open < PD_VAL).
- Globex has no open: its analogue is the VA state of the JOIN ENTRY PRICE against PD VAH/VAL (ONH/ONL are still forming, a running-extreme version is not tested here).

## Events and outcome
- Joins: real-detector events (`pocJoinLoader.buildEvents`, R=65, withVolume). RTH joins (entry 09:30-15:59) take the open states; Globex joins (18:00-09:29) take the entry-price VA state. 16:00-17:59 dropped.
- Outcome: with-join signed move from the entry open to the close at +60, +120, +240 minutes and to the session end (RTH 15:59, Globex 09:29), in ATR20 units (mean RTH range of the previous 20 sessions); horizons past the session end dropped.
- ALIGNED = ABOVE and long join, or BELOW and short join. AGAINST = ABOVE and short, or BELOW and long. INSIDE = INSIDE state. Full 2 (direction) x 3 (state) table of per-trade means with N is printed so a sign split between long and short is visible.
- Tell: the 1,760 research V1 trades (`scripts/amt_vbars/trades_V1_explore.csv`), same states by trade date, tell direction = trade direction; outcomes `broke`, `pts`, `net` from the CSV. Descriptive.

## Screen (per family: ONH-open RTH, VA-open RTH, VA-at-entry Globex; each judged alone)
"Aligned improves results" only if ALL: (1) N_aligned >= 100 on >= 40 days; (2) ALIGNED minus AGAINST > 0 at +60 and +120, day-blocked 95% CI (resample days, per-event means) excluding zero at both; (3) ALIGNED minus INSIDE > 0 at +60 and +120 (point estimate; CI reported); (4) same sign of ALIGNED minus AGAINST in PRE and POST at +60 and +120; (5) top-5 days share of the summed aligned move < 50 percent of a positive total. Three families x two horizons: one pass is a LEAD for one frozen later look, not a result. A negative reading (AGAINST beats ALIGNED) is reported equally. Not tested: trade P&L under the live exit, a rule that skips AGAINST joins, order flow, day type.

## Reading rule
Counts (events per state, days) print before any outcome. Claim `open_location_join_tell_*_20261028` is recorded whatever the result, including what could not be shown (the CI half-width).

## Amendment 1 (2026-10-28, after the census, before any ONH outcome existed)
Census: the ONH-open family is EMPTY by construction (every 09:30 open lies inside the overnight range, 0 ABOVE / 0 BELOW for joins and 6 of 1,760 tell trades), the known trap that a state defined from the last bar before the window cannot vary. Its outcome rows were n/a, so no ONH result was seen. The VA-open RTH family ran (outcomes seen: ALIGNED-AGAINST -0.025 ATR20 at +60, CI -0.068..+0.019; Globex VA-at-entry -0.015, CI -0.037..+0.005; both NOT SHOWN, reported unchanged). Replacement and addition, defined now: (a) ONH-at-entry RTH: the state of the JOIN/TELL ENTRY PRICE against the fixed overnight range (ABOVE entry > ONH, BELOW entry < ONL, else INSIDE) for RTH entries 09:30-15:59; (b) VA-at-entry RTH: the entry price against PD VAH/VAL for RTH entries, so RTH and Globex share one definition. Family list is now five: VA-open RTH, ONH-at-entry RTH, VA-at-entry RTH, VA-at-entry Globex (and the dropped ONH-open). The screen, outcomes and horizons are unchanged; five families x two horizons means one pass is still only a lead. The tell gets the same three RTH families by tell entry price.
