# AMT tell LONG gate on the RTH liquidation day state: FORWARD pre-registration (frozen 2026-11-09, before the gate has ever fired)

Tracker items F/G (`docs/WORKPLAN_20261109.md`). Code: `server/services/dayState.js` (pure machine, `scripts/test_day_state.mjs`), `dayStateService.js` (live), `amtTellOrders.js` (`AMT_TELL_ORDERS.dayStateGate`, `decideEntry`, tests in `scripts/test_amt_tell_orders.mjs`). User decision 2026-11-09: option A (gate the tell's longs for real on Sim1, with a scored skipped-trade ledger), restart go still pending.

## Rule (fixed)
While the RTH day state is DOWN_EARLY or DOWN_CONFIRMED, no LONG order is sent for an AMT tell (a flipped book-C long included). The check is LAST in `decideEntry`, so `amt_tell_trades.order_state = 'SKIPPED_LIQ'` marks only tells that would otherwise have been ordered. Shorts, melt-ups and every other setup are untouched. Unknown / stale (> 5 minutes) / warm-up state = no gate (fail open).

## Why a forward test and not a backtest
Replay of the state over 2023-2026 (outcome-blind): ~12% of RTH sessions flagged (about 2.5 a month). Of the five worst long days since 2026-09-01 the state flags 11-05 early (DOWN_EARLY 09:40, before the 10:00-14:11 tell longs that lost $970) and 10-08 late (13:26); 10-22, 09-08, 10-13 are never flagged. The tell has only 27 live long trades, so the gate's effect cannot be estimated from history; it is judged on the ledger.

## The scored ledger
Every skipped tell keeps its virtual V1 result in `amt_tell_trades` (`net_dollars`, `exit_reason`). Gate effect per skipped tell = minus that virtual P&L (positive = loss avoided). Also tracked: flagged RTH days; tells that fired in a liquidation state (skipped) vs not; times the gate was unknown (stale / warm-up / error); the day-state log (`day_state_log`).

## Judgement (no peeking before the floor; cv-006)
Floor: at least 15 skipped tells on at least 6 distinct flagged RTH days, counted from the restart that enables the gate. At the floor, day-blocked bootstrap of the mean gate effect per skipped tell:
- CONFIRM (keep the gate): lower 90% bound > 0.
- FAIL (remove the gate, keep the light): upper 90% bound < 0 (the gate removed winners). Removal is the pre-registered result, not an estimate.
- CONTINUE: otherwise, re-look at 30 skipped tells and 10 flagged days, then decide on the same rules.
Alarms before the floor (not a verdict): the gate fires on more than 30% of RTH days since enabling (miscalibrated), or `known:false` on more than 20% of RTH minutes (feed problem), or a skipped tell's virtual loss larger than $1,000.

## Next-step tree (co-022)
Confirm: extend the same gate idea to the vacuum rule's longs and the order-flow setup (own prereg each) and log the symmetric melt-up gate for shorts as a candidate. Fail: autopsy which skipped tells won and what the state looked like (early vs confirmed, time of day) before any redesign. Continue: nothing changes.

## Known limits (stated before data)
Narrow by construction: 1 of the 5 worst long days is covered early. The state's parameters (windows, the 0.97 quantile) are design parameters set by alarm rate, not by any result. The state is computed from the NQ feed the dashboard uses; hr-014 (stale price feed) is why stale = no gate.
