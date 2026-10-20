# Pre-registration: large-order absorption at a sweep (buyers stuffed on the way down, sellers absorbed at the turn) — 2026-10-20

Written and committed BEFORE any outcome is computed. Origin: user 2026-10-20: "looking for large orders tells you a lot more: when the market is driving down, large buy orders are getting stuffed and then large sellers come in; once you see that our buying needs to step aside. Usually at the end, after the market has come down a bit and started to turn up, larger buyers come in." The earlier price-only tests (4h state, 1-minute sweep, counterpunch) were null or fragile; none looked at order flow, which the user's chart story is mostly about.

## What this can and cannot see
Data: 1-minute NQ bars have complete aggressor volume (bid_volume = trades at the bid = aggressive sells, ask_volume = aggressive buys, 100 percent coverage 2023-03..2026-10) and num_trades. Average trade size is 1.08 contracts: NQ large orders are sliced, so a "large order" shows up as sustained one-sided aggressor volume with a price result, not as a big print (consistent with the 2026-08 Opus/Gemini findings that print-size heterogeneity barely exists). Resting large orders (iceberg / stuffed passive liquidity) are only visible in order-book depth (110 day files Jul-Oct 13 2026 on disk, no reader in the repo, `OPEN_DECISION run_depth_absorption_poc_stage1`); this test does not use depth and says so. It tests the part of the user's sequence that leaves a footprint in aggressor flow versus price progress ("effort versus result").

## Definitions (all scale-free, point in time, no fixed constants)
- Events: the first penetration of a level in the scale-free sweep test (`SWEEP_RECLAIM_SCALEFREE_PREREG_20261020.md`: RTH ONL / PDL / IBL and mirrored highs; Globex prior-day low/high as an exploratory arm), every depth, `sgn` +1 for lows (long frame) and -1 for highs (short frame, mirrored).
- Window W in {3, 10, 30} minutes (three scales, all reported; the primary statistic is the max over W, with a null for the max).
- For a decision bar e and window W: buyEff = sum of ask_volume over the W bars ending at e, sellEff = sum of bid_volume, price result = close[e] - close[e-W]. Each is converted to a rank against the same quantity measured at the same clock time on the previous 60 sessions that have it (no fixed volume numbers, no ATR).
- ABS_sell(W) = rank(sellEff) x rank(price result up): lots of aggressive selling that did not push price down (sellers absorbed). ABS_buy(W) = rank(buyEff) x rank(price result down): lots of aggressive buying that did not push price up (buyers stuffed). For a high-sweep (short frame) the roles swap.
- Scale for outcomes: R30 = high-low of the 30 minutes ending at the decision bar (the local move size, no ATR). Outcome = symmetric race from the decision close: +q x R30 in the event's direction (win), -q x R30 (loss), both in one bar or unresolved by the session end (neither). q = 1 primary; 0.5 and 2 reported. Score +1 / -1 / 0.

## Primary hypotheses (directional, one test each, Bonferroni: each judged at the 97.5th percentile / one-sided alpha 0.025)
- P1 (the turn): decision = the reclaim close (reclaiming events only). Statistic = max over W of Spearman(ABS_sell(W) over the W minutes ending at the reclaim, race score). Predicted > 0 (sellers absorbed at the turn, then the move goes our way).
- P2 (step aside): decision = the first-penetration bar (known at that moment, no reclaim needed). Statistic = max over W of Spearman(ABS_buy(W) over the W minutes ending at the penetration bar, race score from that bar, long frame). Predicted < 0 (buyers stuffed on the way into the level, longs should step aside); the statistic is the min over W.
- Null: permute the race scores among events within the same arm and calendar month (1000 draws) and recompute the max/min over W.
- Each hypothesis is SUPPORTED only if (i) the real statistic passes the 97.5th percentile of its null; (ii) the day-block bootstrap CI of the Spearman at the argmax W excludes zero in the predicted direction; (iii) same sign in both halves (explore 2023-03-06..2025-05-31 / hold-out 2025-06-01..2026-10-16) at that W; (iv) the mirrored high-sweep frame has the same sign. Otherwise "not shown", stated with exactly what was tested.

## Reported alongside (no verdict)
Spearman at each W and q; tercile contrast (top vs bottom third of the feature) of mean race score; Globex arm; the same features for the deep-sweep top band only; and a worked illustration for 2026-10-20 (the user's example, outside the test sample): the flow features at each of 09:35-09:50 on that date.

## Rules
Claude builds; DeepSeek reviews the code before the verdict is final. Record via `recordClaim()` whatever the result, phrased as what was and was not shown. A SUPPORTED result licenses only a pre-registered trade-level test with realistic fills; nothing is wired live.
