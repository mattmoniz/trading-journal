# AMT intraday option 1: where a swing turn forms relative to prior value, and what the next hour does (frozen 2026-10-28)

Committed BEFORE any outcome is read. Question about the MARKET (forward move after a confirmed turn), not a trade: no stops, targets, geometry.
Option 3 (initiative vs responsive at the first excursion beyond prior value / IB) is the user's priority and follows as its own prereg; this is the faster first test.

## Data
`rotation_events` (65-point confirmed swing pivots from the validated `rotationDetector`, RTH and GLOBEX separately) joined to `amt_daily_state` on `trade_date` for the prior-session 70% value area (prior_vah, prior_val) and gap. For a GLOBEX event, trade_date D = 18:00 the previous evening to 09:29 on D, so the prior RTH value area stored for D is the right one. Window: trade dates 2023-03-01 .. 2026-10-26. Excluded: roll_gap_day events, events with no out_ret_60 (too close to the session end), days without an amt_daily_state row.
Each event is KNOWN at confirm_ts (the 65-point move away from the pivot). Outcomes are measured forward from the confirm bar's close and signed ALONG THE NEW LEG: positive = the leg keeps going. (A study of the market after a confirmed turn, no fill model: entering the next bar would cost a little.)

## State (decided at confirm_ts; uses only the pivot price and prior VAH/VAL)
- HIGH pivot (new leg DOWN): price > VAH = TOWARD (turned back toward value from outside); price < VAL = AWAY (below value, leg heads further from it); otherwise INSIDE.
- LOW pivot (new leg UP): price < VAL = TOWARD; price > VAH = AWAY; otherwise INSIDE.
In AMT terms TOWARD = a responsive turn after an excursion beyond value (rejection of the excursion); AWAY = the new leg is initiative away from value; INSIDE = a turn within value. No thresholds anywhere; the states are pure geometry against yesterday's value area.

## Outcome and statistic
- y = out_ret_60 (ATR20 units, 60 bars after the confirm bar, signed along the new leg).
- mu_type = mean of y over ALL events of the same pivot_type, same session type and same block (it removes the drift that favours up-legs over down-legs). Event excess x = y - mu_type.
- State excess E = mean of x over the state's events (per-event mean = sum/N).
- CI: day-blocked bootstrap (resample trade_dates, pool their events; 3000 iterations, seed 20261028). Lower endpoint at the one-sided level stated below.
- Descriptive only: AWAY and INSIDE excess, TOWARD split by pivot type (HIGH-above vs LOW-below), horizons 15/30/120/240, chronological-thirds sign.

## Primary cells (2, one per session type; RTH and GLOBEX both required)
Cell = TOWARD excess E > 0 (a turn back toward value after an excursion beyond it continues more than the average turn of its type). One-sided alpha 0.025 per session (Bonferroni, 2 cells). A cell needs >= 100 events and >= 30 distinct days in the block, else NOT EVALUATED.

## Matched control (gate for any claim; pre-decision covariates only)
Donors = INSIDE events of the same pivot_type, session type and block. Covariates: tod_min, vwap_dist_atr, prior_leg_pts/atr20, minutes_to_confirm, |gap_atr|. Mahalanobis distance with the covariance of all events of that type in the block; K = 5 nearest donors with replacement; common-support trim at the 90th percentile of leave-one-out nearest-neighbour distances among donors; retained share under 50% = control NOT EVALUABLE (a limit of the control, not a verdict). Control excess = mean over retained state events of (y - mean y of its 5 donors). CI: day-blocked bootstrap on those per-event contrasts, donor selection held fixed (documented simplification). SENSITIVITY: K = 1.

## Decision rules (frozen)
1. EXPLORE = trade dates up to 2025-05-16 (the same date cut as AMT S1); HOLD-OUT = after. A session type has an EXPLORE SIGNAL iff its TOWARD E one-sided 97.5% lower bound > 0. If neither session type has one: CLOSED at explore, hold-out not opened.
2. HOLD-OUT, one look per session type that had a signal (lock file): CONFIRMED ON HELD-OUT HISTORY iff the one-sided 95% lower bound of E > 0 AND the matched-control point estimate > 0 (evaluable) AND both TOWARD subtypes have positive point estimates. Control-supported additionally if the control's one-sided 95% lower bound > 0.
3. A miss is "NOT CONFIRMED", never "no effect"; the CI width is the resolution and is always stated.
4. Events within a day are serially correlated (about 11 a day); the day-blocked CI is the statement of uncertainty, the raw event count is not.
5. A result authorizes a forward log and a context lens only, never a trade rule; same forking-paths caveat as S1 (many adjacent tests on the same history; an explore p-value is not read at face value).
