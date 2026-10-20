# Pre-registration: POC_ROTATION_JOIN time-based circuit breaker (written 2026-10-20 BEFORE any outcome)

Origin: user 2026-10-20: "a 2, 5, 15 or 30 minute circuit breaker when things start firing against trend and losing." Prior evidence to respect (not a reason to skip): MEMORY `feedback_reactive_exposure_cutting_reversion_trap` (cut-exposure-after-bad-signs ideas backfired pooled), the loss-streak sizeMultiplier decays, and this session's finding that joins entered after the day was already down 400+ averaged MORE than usual (regression to the mean in a lottery-shaped P&L). Mechanics to respect: an E1 join closes at its stop or at the NEXT join's entry (so a loss is only realized at that time), and a breaker that skips joins changes later exit boundaries (a limitation: states are computed from the UNGATED stream).

## Definitions
- Events/outcome: real `detectSignalEvents` joins 2023-03-06..2026-10-16 (roll weeks excluded), realistic-fill live exit E1 (100pt stop, breakeven from forward bar 60, hold to next join or 24h, stop beyond the market fills at the bar open, $2/pt, $2 RT). Each join has an exit time (the bar at which E1 ends) and a P&L.
- LOSS = closed join with P&L < 0. Trigger T1 (primary): two consecutive CLOSED joins of the same trade date (consecutive by exit time) are both losses; the breaker starts at the exit time of the second loss. Trigger T2 (secondary, "against trend and losing"): same as T1 but both losing joins were VWAP-OPPOSED (against the 60-minute slope of the 18:00-anchored running volume-weighted VWAP, class definitions of docs/POC_JOIN_VWAP_SLOPE_GATE_PREREG_20261020.md).
- Breaker durations D = 2, 5, 15, 30 minutes (the user's four; all reported). While a breaker is active (trigger time <= entry time < trigger time + D), joins whose entry falls in the window are SKIPPED (set S); all others are KEPT.
- Exits of kept trades are as simulated on the ungated stream (the limitation).

## Comparisons
- For each (trigger, D): N skipped, mean P&L of S vs mean of KEPT vs mean of ALL; total P&L change from the breaker = -(sum of S); by era (PRE < 2025-06-01 / POST), by session of the skipped entry (RTH 09:30-15:59 / GLOBEX); big winners skipped (P&L >= +100) vs big losers avoided (<= -150).
- Day-blocked bootstrap (2000) of mean(S) - mean(KEPT), per-trade means.
- Placebo (random pauses): for each trigger, slide its window to a random start within the same trade date's joins (keep D), recompute S, 2000 repetitions; one-sided p = share of placebo total P&L(S) at most the observed (a breaker only helps if the observed skipped joins are WORSE than random ones).
- Cells: 2 triggers x 4 durations = 8; Bonferroni-style note, primary = T1 at each D reported equally.

## Pass criteria (per (trigger, D); the breaker "helps" only if ALL hold)
1. N skipped >= 60.
2. mean(S) < mean(KEPT) with the day-blocked CI of the difference excluding zero, and total P&L(S) < 0 (the breaker saves money in dollars, not only per trade).
3. Placebo p <= 0.05.
4. Same sign in PRE and POST, and in RTH and GLOBEX.
5. The skipped set's NEGATIVE total is not carried by <= 5 trades (top-5 losses < 50 percent of |sum(S)|), and the breaker skips fewer big winners than... (reported: big winners skipped x average vs big losers avoided; must net positive in dollars, i.e. criterion 2).
If none passes: no breaker; do not tune D, the trigger count (2 losses) or the loss definition to rescue it.
