# Walk-forward context gate on the with-trend spike rule (frozen 2026-10-29 BEFORE any outcome)

Why: stage 3 (context_output.txt, claim spike_context_calibration_stage3_20261029) showed the with-drift rule's profit concentrated in active conditions (expansion score mid/high, high overnight relative volume, large overnight range) and about flat in quiet ones, but from in-sample slices of one dataset. The user asked for a dynamic multi-factor calibration. This tests it causally: gate cut points and models use ONLY earlier sessions. EXPLORE only (sessions to 2025-05-16, RTH); the sealed hold-out is untouched.

## The base rule (unchanged, PREREG_SINGLE.md)
Spike marks (M=5, Q=75) AGAINST the day drift at the confirmation bar; trade WITH the drift (= the fade direction D) at the next open +1 tick, stop at the spike extreme, no target, flatten 15:55, realistic fills, 2 dollars round trip, 1 MNQ; one position at a time; S1 = first allowed mark per session, S2 = re-entry after a stop.

## Gates (a gate only DECIDES whether a mark may open a position; everything before the decision is known at the confirmation bar)
Context features (as in PREREG_STAGE3.md): ES = mean log of relative volume, recent volatility and range so far; overnight relative volume (overnight volume / the median of the prior 20 sessions); overnight range / ATR20.
- G1 (PRIMARY, counted): skip a mark if its ES is in the lowest tercile of the ES values of ALL EARLIER qualifying marks (strictly earlier sessions); no gating until 100 earlier marks exist.
- G2: same with overnight relative volume. G3: same with overnight range / ATR20. G4: skip if EITHER ES or overnight relative volume is in its lowest tercile. G5 (multi-factor): ridge regression (standardised, alpha 10) of the with-drift trade's net dollars on ES, relative volume, volatility now, range so far, overnight relative volume, overnight range, overnight/prior-day location, gap, minutes since the open and spike size, refit at each calendar month on earlier qualifying marks only (at least 150), allow the mark only if the predicted net > 0.
G2-G5 are descriptive; one counted gate.

## Controls
RANDOM-SKIP: skip each mark at random with the SAME overall skip rate the gate had (50 repetitions) - shows whether the gate does more than merely trade less. UNGATED = the base rule.

## Statistic and reading
Per SESSION (all explore sessions with thresholds, no-trade sessions count as 0): daily P&L under S2 (and S1). Counted: G1 minus ungated, mean daily P&L over all sessions, day-blocked 95 percent CI; AND G1 minus random-skip, same CI; both must exclude zero on the positive side under S2, with the same sign in PRE (< 2025-01-01) and POST. Also reported: trades, mean per trade, win days, worst day, max drawdown, skip rate. A null states the CI half-width and what could not be shown. Exploratory: the detector and the factors were found on this data.

## Not in this stage
Globex; the news windows (underpowered); absorption; the sealed hold-out look.
