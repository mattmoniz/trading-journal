# 2 x 1-minute ATR stop variant (frozen 2026-10-28)

Committed BEFORE any outcome of this variant is read. User request: "try a 2 times the 1 minute ATR stop". It is a fork on data the order-flow branch has already seen (both the volume-profile and the TPO zone runs), so it is reported as a sensitivity of the SAME frozen spec, with the usual placebo and same-selection control, and no configuration is selected out of it.

## The one change
- ATR14 = simple mean of the true range of the 14 one-minute bars ending at the trigger bar (known at its close); true range uses the prior bar's close (`engine.atr14`).
- Stop distance from the entry price (after the 1-tick adverse slippage) = 2.0 x ATR14. It REPLACES Setup A's "6 points beyond the setup extreme" and Setup B's "10 points fixed".
- Everything else unchanged: targets (A 15, B 20 points), Setup A's structural exit (a close 5 points beyond the zone), entry windows, fills and costs (1 MNQ, $2 round trip), flatten 15:55, zones, controls (the same stop), random-entry placebo (each real trade's own risk distance), explore set (529 sessions), hold-outs sealed.
- Sensitivity, Setup A only: the stop 2 x ATR14 BEYOND the setup extreme (the structure-anchored form, extreme - 2 x ATR for a long) instead of from the entry.
- Both zone definitions are run and shown side by side: volume-profile VA (the original spec) and TPO VA (1.0-point rows).

## Reading (frozen, unchanged)
A lead needs a day-blocked CI lower bound > 0 AND beat the random-entry placebo p95 AND beat its own same-selection control. Otherwise not shown. Note the zero-drift win probability depends on the realized risk (stop/(stop+target)), so win rate alone is not a signal.
