# Pre-registration: "stuffed" big orders (response at the moment) — 2026-10-20

Written and committed BEFORE any outcome of this test. Origin: the user, looking at the charts, said that looking at big orders alone is not enough because a flood of other orders can run them over, and what matters is what happens at that moment; examples: the 98 and 96 sells in the 10-20 morning rally (price kept rising) and the 297 sell at 13:01 (a sell of 297 contracts, 250 prints, price flushed about 23 points in a second and was back above it within five minutes). Two earlier tests used big orders only as windowed net volume (`big_order_burst_flip_not_shown_20261020`, `big_order_plus_delta_*`), neither looked at the price response to a single order.

## Plain-English question
When a big order (an individual aggressive order of 70+ contracts) goes through and, within the next minute, price is back on the wrong side of where that order finished, the order was "stuffed". Does price then keep going the other way (a stuffed sell is followed by a rise, a stuffed buy by a fall), and do level-fade trades taken on the stuffed side do worse / on the other side do better?

## Data
- Big orders and their exact prices come from `scripts/tick_microstructure/extract_stuffed_20261020.py` (per session, RTH 9:30-16:00 ET, merged same-side prints at most 1 ms apart, size >= 70, the same definition as the earlier tests, validated to reproduce the user's chart numbers 97, 74, 89, 102, 78, 98, 96, 86, 80, 297, 140, 105 on 2026-10-20). Output `scratch/stuffed_20261020/DATE.tsv`: side, start second, end second, size, prints, first price, last price, price 60 s after the end, and the price 5, 15 and 30 minutes after that reference time. Prices are corrected for the DTC install's one-hundredth price scaling.
- Bars/ATR20: `scripts/lib/pocJoinLoader.mjs`. Trades: the 3.5-year RTH level-fade replay with touch times (`scratch/rotation_gate_replay_rows_ts_20261020.json`). Split: explore 2023-03-06..2025-05-31, hold-out 2025-06-01..2026-10-19.

## Definitions (fixed here)
- Reference time t_ref = end of the order + 60 seconds; the decision is made at t_ref (nothing later is used for the label). P_last = price of the order's last print; P_ref = last trade price at or before t_ref. "Against" means opposite to the order's direction (price higher for a sell, lower for a buy), measured in ticks of 0.25.
- STUFFED: P_ref is against the order by at least 2 ticks relative to P_last. FOLLOWED: P_ref is beyond P_last in the order's direction by at least 2 ticks. NEUTRAL: otherwise. Sensitivity only: 1 tick and 4 ticks; sizes 100 and 150.
- Only orders with t_ref inside RTH (before 15:30 ET) and 10:00 ET or later (so the 30-minute outcome horizon exists) are used for Test A.

## Test A — market behavior (bars/ticks first)
Outcome: price change from P_ref to the price 5, 15 and 30 minutes later, divided by ATR20, signed so that positive means price moved in the direction OPPOSITE to the order (up after a stuffed sell, down after a stuffed buy). Primary contrast: STUFFED vs FOLLOWED big orders of the same side, matched on 30-minute clock bucket and size bucket (70-99, 100-149, 150+); the residual is the mean of (outcome minus the matched FOLLOWED mean). Report also STUFFED vs all other same-side big orders and vs the unconditional matched minute mean. Day-blocked bootstrap CI (1500), permutation null (stuffed/followed labels shuffled within month x bucket x side x size bucket, 1000 draws, 95th percentile), explore vs hold-out, time-of-day split (before 11:00 / later), and buys and sells separately.

## Test B — the roster (dollars)
Trade fire minute T; only orders with t_ref <= T (label known) within the previous 10 minutes count. For a trade in direction d:
- STEP-IN flag: a STUFFED order on the side opposite to the trade (stuffed sells before a long, stuffed buys before a short: the other side was run over). Predicted better.
- STEP-ASIDE flag (primary, the user's original idea): a STUFFED order on the trade's own side (stuffed buys before a long, stuffed sells before a short: our side was run over). Predicted worse.
Metrics exactly as in the earlier tests: per-trade mean pnl (sum/N), matched difference within 30-minute clock buckets, day-blocked bootstrap CI, shuffled-label placebo within month x bucket, explore vs hold-out, five families, AGREE roster only, incremental over the rotation gate (trades not DISAGREE), by direction.

## Verdict rules
- Test B step-aside is USEFUL only if (i) at least 150 flagged trades on at least 60 sessions (else NOT ENOUGH EVENTS), (ii) CI lower bound above zero, (iii) above the placebo 95th percentile, (iv) hold-out same sign and at least half the explore size, (v) at least 3 of 5 families positive.
- Test A is a SIGNAL only if the matched residual CI excludes zero, it exceeds the permutation null, and the hold-out has the same sign, at the 15-minute horizon (primary) and at least one other horizon.
- Test B step-in is secondary and judged by the same rules with the sign reversed; it is NOT used to rescue a failed primary. This is the third big-order test of the day (two earlier ones not shown); that is noted when judging a lone positive cell. Sensitivities are labelled and never used for the verdict.
- If Test A and B both pass: a live SHADOW tag only, after DeepSeek review and a live order feed. Otherwise say exactly what could not be shown.

## Rules
- No look-ahead: labels use data up to t_ref; outcomes start at t_ref; trades use only labels with t_ref <= fire minute. Per-trade means sum/N; day-blocking only for intervals. Recorded as a RESEARCH_CLAIM either way. Not wired live. The scripts are not DeepSeek-reviewed (stated in the claim).

## Addendum B (written before any outcome of this test): a second definition, "reclaim"
Reason: the user's four chart examples on 2026-10-20 (98 sell 9:49, 96 sell 9:55, 297 sell 13:01, 111 sell 14:42) were checked against the definitions only, not against any outcome. Under definition A (price 60 s after the order's end is at least 2 ticks against its last print) the 98, 96 and 111 are STUFFED and the 297 is FOLLOWED (price made another 12 points lower before bouncing). The user's description is about the order failing and the market going the other way, which can take longer than 60 s.
- Definition B (RECLAIM): within 5 minutes after the order's end, price trades back through the order's VWAP against its direction by at least 2 ticks (a sell is reclaimed if price trades at or above VWAP + 0.5 points; a buy if at or below VWAP - 0.5). The label is known at t_end + 300 s; NOT-RECLAIMED is every other big order. All four examples are RECLAIM = YES (reclaimed by 41, 110, 9 and 41 points).
- Outcome for B starts at t_B = t_end + 300 s (the same moment for reclaimed and not-reclaimed orders, so there is no look-ahead): price change from the last trade at or before t_B to 5, 15 and 30 minutes later, ATR20-normalized, signed positive = in the direction opposite to the order. Contrast: RECLAIMED vs NOT-RECLAIMED big orders of the same side, matched on 30-minute clock bucket and size bucket.
- Test B (roster) for definition B: flags use only orders with t_B <= the trade's fire minute, within the previous 15 minutes (STEP-ASIDE: reclaimed order on the trade's own side; STEP-IN: reclaimed order on the opposite side).
- Because two definitions are now tested (A and B), each is judged on its own at a 97.5 percent bootstrap interval (instead of 95) and the permutation/placebo benchmark is the 97.5th percentile; all other verdict rules are unchanged. A pass on only one definition is reported as such, not as a pass of the idea.
- A third piece the user asked for: a LIVE read-only watcher (the tick file `C:\SierraChart-DTC\Data\NQZ26.scid` is written continuously) that labels big orders STUFFED/RECLAIMED as they happen and records them for forward evidence. It is built only after this test is read, as an informational display plus log with no effect on any trade, the same way the forward monitor was built; it is not part of this pre-registration's verdict.
