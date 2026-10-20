# Pre-registration: POC_ROTATION_JOIN "VWAP-slope direction gate" (written 2026-10-20 BEFORE any VWAP-slope outcome was computed)

Origin: user 2026-10-20: use VWAP only as a CHECK of the market's general direction (not a signal): when the session VWAP slopes up fire only POC joins LONG, when it slopes down fire only POC joins SHORT; a FLAT VWAP is a different regime (balance; the user expects joins to do well fading the outer edges, e.g. in "b"/"D" shaped profiles) and needs its own definition. Prior evidence to keep in mind (not a reason to skip the test): `RESEARCH_CLAIM pulse_vwap_slope_direction_negative_20260909` (VWAP slope/position did not predict forward direction as a signal) and the standing CLAUDE.md finding that RTH-validated against-the-trade price-position signals tended to REVERSE in Globex for the FADE roster; this tests a trend-alignment filter on JOINS, so RTH and Globex must be reported and judged separately.

## Definitions (single primary rule; no other parameter may be tried and reported as the result)
- Events: the real `detectSignalEvents` (65pt, standard, point-in-time THETA), 2023-03-06..2026-10-16, roll weeks excluded; entry = open of the bar after the trigger bar. Session bars = the detector's own session (18:00 ET previous evening through 16:59 ET of trade date d), so the VWAP is anchored where the 24h session starts.
- VWAP series = `computeRunningVwapSeries(bars)` (server/services/developingValueService.js: cumulative typical-price VWAP, zero-volume bars weigh 1) over the session bars from 18:00.
- At the trigger bar index t (entry bar index - 1, counted from the 18:00 session start): `slope = VWAP[t] - VWAP[t-60]` in index points per hour. A join with t < 60 is UNDEFINED (excluded from the rule, counted).
- Flat cut c(d) = the 33.3rd percentile of |slope| where |slope| is sampled at every 15th bar index (index >= 60) of the same session construction for each of the 20 RTH trade dates (dates with an RTH session of >= 300 bars) immediately BEFORE d, pooled; needs 20 prior dates. (A rolling, data-derived flat definition, no fixed point threshold.)
- Class: UP if slope > c; DOWN if slope < -c; FLAT otherwise. ALIGNED = (long join and UP) or (short join and DOWN). OPPOSED = (long and DOWN) or (short and UP). FLAT = FLAT.
- Primary rule: fire only ALIGNED joins.

## Outcome and comparisons
Outcome = realistic-fill live exit E1 (100pt stop, breakeven from forward bar 60, hold to next event or 24h, stop beyond the market fills at the bar open; $2/pt, $2 round trip; forward bars strictly after the entry bar). ALL = all joins with a defined class. Day-blocked bootstrap (2000), per-trade mean = sum/N. RTH = entry bar time 09:30-15:59 ET, else GLOBEX. Eras: trade date d < 2025-06-01 PRE, >= POST.
- ALIGNED minus ALL, overall and in PRE, POST, RTH, GLOBEX. ALIGNED minus OPPOSED. FLAT reported descriptively.
- Placebo 1: the ALIGNED joins with direction flipped (same entries, same exit rules).
- Placebo 2: shuffle the UP/DOWN/FLAT labels among joins within the same calendar month x entry session (RTH/GLOBEX), 2000 permutations, recompute ALIGNED minus ALL; one-sided permutation p for the observed value.
- Tail: P(pnl >= +100) aligned vs all; top-5 events' share of the aligned set's total P&L.
- Sensitivity ONLY (never for selection): slope window 30 and 120 index minutes.

## Pass criteria (ALL must hold; else "a VWAP-slope direction gate does not improve POC joins")
1. N aligned >= 150 overall and >= 50 in each of RTH, GLOBEX, PRE, POST.
2. ALIGNED minus ALL > 0 with the overall day-blocked 95% CI excluding zero, AND > 0 in each of PRE, POST, RTH, GLOBEX.
3. ALIGNED minus OPPOSED > 0 with the CI excluding zero.
4. Permutation p <= 0.05.
5. ALIGNED mean beats its flipped-direction placebo overall and in both eras.
6. Top-5 share of the aligned total < 50 percent.
7. P(pnl >= +100) of aligned > all.
If it passes: a SHADOW tag only (never a live gate) plus forward recheck. If it fails: stop; do not tune slope windows or cuts to rescue it.

## Secondary, EXPLORATORY ONLY (descriptive tables, nothing promoted)
FLAT-VWAP joins: mean, tail, by RTH/GLOBEX and by era; and the price-side check (long with entry above session VWAP / short below). The user's "b"/"D"/"P" profile-shape idea needs its own definition (TPO or volume-profile skew of the DEVELOPING session, point-in-time) and will be pre-registered separately before any outcome is looked at.
