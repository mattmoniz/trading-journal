# Spike exhaustion, marks only (definition frozen 2026-10-28 BEFORE any detector output)

Origin: the user reviewed the explore windows of 2023-05-18..05-24 and circled (blue) the exhaustions they see: sharp spikes to an extreme, a high or a V-low, after which price "comes right back" ("exhaustions happen quick because the opposing side steps away at the end and price comes right back"). They are NOT the slow efficient 30-bar pushes the E2 rule (PREREG.md) requires, which is why E2 misses them. This stage is MARKS ONLY (same workflow as the absorption marks in scripts/amt_absorb): no trades, no P&L, no outcome statistics. Trailing the trade is a separate later question (the repo record for trail / breakeven exits under realistic fills is poor, so it would be tested only after the detection is right).

## Definition (1-minute RTH bars; every size threshold is a quantile of the prior 20 sessions' same quantity at the same clock bar +/- 15 minutes)
Spike HIGH at bar t (the mirror is a spike LOW):
1. THRUST: over the last M = 5 bars ending at t, bar t is the highest high of the window, the window's lowest low came BEFORE it (an upward thrust), and thrust size = highest high minus that lowest low >= the trailing 90th percentile of thrust size (pooled up and down).
2. NEW EXTREME: that high exceeds the highest high of the K = 30 bars before the thrust window.
3. RIGHT BACK: within the next 5 bars price closes back through the thrust's midpoint (WEAK) and STRONG if it closes back at or below the thrust's base (the whole thrust erased). The mark is placed when the midpoint is first closed through; one mark per spike; a 15-bar refractory period per direction.
No level, order-flow or time-of-day condition is required in this stage; the user judges by eye. Direction of the (unscored) idea: against the spike. Sensitivity (counts only): M = 3 and 8; quantile 80 and 95.
Fidelity check: the 12 spikes circled by the user, with times read off their screenshots (about +/- 5 minutes), are looked up after the run as a hit list; the thresholds are NOT adjusted to hit them.
