# AMT option 3: accepted vs rejected first excursion beyond prior value / the IB (frozen 2026-10-28)

Committed BEFORE any outcome is read. Question about the MARKET (forward move), not a trade. RTH only in this prereg; the Globex arm is NOT tested here and is flagged as an open decision (the repo rule requires RTH and Globex, so an untested gap must be recorded, not hidden). Written and run without a DeepSeek design review at the user's request ("run it now"); a DeepSeek critique of this run is queued for off-peak.

## Idea (Auction Market Theory)
When price first trades outside a reference of agreed value, it either ACCEPTS the new area (stays out, builds value there) or REJECTS it (returns inside). The test: after a fixed waiting time, does the market keep moving in the excursion direction more after an accepted excursion than after a rejected one, once comparable excursions are matched?

## Data (loader.py RTH 1-minute bars; amt_daily_state for day covariates; window trade dates 2023-03-01 .. 2026-10-26)
Eligible days = rows of `amt_daily_state` before 2026-10-27 (full RTH, valid prior value area, ATR20, gap, overnight range). Bars are minute-of-day 09:30 = offset 0 .. 15:59 = offset 389; a window with any missing minute drops the event (counted).

## Two reference families (separate cells)
- PRIOR_VALUE: days that OPEN INSIDE the prior 70% value area (VAL <= open <= VAH). Level = VAH for an up excursion, VAL for a down one. (Days opening outside value have no "first excursion"; they are excluded from this family and counted. This is the gap-aware part.)
- IB: every day, reference = the IB (09:30-10:29) high/low; scanning starts at the 10:30 bar.

## Event (one per day per family)
Excursion bar e = the first bar in scope with high > level (up, s = +1) or low < level (down, s = -1). A bar that exceeds both sides is dropped (counted). Require e's offset <= 299 (14:29) so the decision and outcome fit in the session.

## State (decided at T = e + 30 bars; uses only bars up to and including T)
ACCEPTED: close(T) is beyond the level in the excursion direction. REJECTED: close(T) is at or inside the level. (Pure geometry, no threshold.)
Volume is a SECONDARY descriptive axis only: rv = volume summed over bars e..T divided by the mean of the same clock-window sum over the 20 prior full sessions; split at the explore-block median.

## Outcome
y = s * (close(T + 60 bars) - close(T)) / ATR20, ATR20 = mean RTH range of the 20 prior full sessions. Positive = the market keeps moving in the excursion direction after the decision time.

## Primary statistic (one per family, 2 counted cells, one-sided alpha 0.025 each)
D = mean over ACCEPTED events of (y - mean y of its 5 nearest REJECTED events), matched by Mahalanobis distance (covariance of all events of the family-block) on: clock offset of e, excursion depth = max beyond-level distance over bars e..T / ATR20, |gap_atr|, prior-day range/ATR20, overnight range/ATR20 (all known by T; IB range is not used because it does not exist before 10:30 for PRIOR_VALUE events). Donors with replacement; common-support trim at the 90th percentile of leave-one-out nearest-neighbour distances among REJECTED events; retained share under 50% = NOT EVALUABLE. Day-blocked bootstrap (3000, seed 20261028) on the per-event contrasts, donors held fixed. A state needs >= 30 events and 30 distinct days in the block, else NOT EVALUATED.
Descriptive: E per state vs the family mean of y; UP vs DOWN subtypes; K = 1 sensitivity; decision delays 15 and 60 bars (sensitivity only, never selected); the volume split within ACCEPTED; chronological thirds.

## Decision rules (frozen)
1. EXPLORE = trade dates up to 2025-05-16 (same cut as S1 and option 1). A family has an EXPLORE SIGNAL iff D's one-sided 97.5% lower bound > 0 and the control is evaluable. No signal in either family = CLOSED at explore; hold-out not opened.
2. HOLD-OUT, one look per family with a signal (lock file): CONFIRMED ON HELD-OUT HISTORY iff D's one-sided 95% lower bound > 0, retained share >= 50%, and both UP and DOWN subtype contrasts have positive point estimates.
3. A miss is NOT CONFIRMED, never "no effect"; the CI width is the resolution and is stated. Forking-paths caveat as before: many adjacent tests share this history, explore results are not read at face value.
4. Authorizes only a frozen forward log and a context lens, never a trade rule.
