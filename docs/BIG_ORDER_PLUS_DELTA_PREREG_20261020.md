# Pre-registration: big orders in conjunction with cumulative delta — 2026-10-20

Written and committed BEFORE any outcome of this test. Origin: the user asked what happens if order sizes are used together with cumulative delta to gate or trade off of. The burst-then-flip test (`docs/BIG_ORDER_BURST_FLIP_PREREG_20261020.md`, not shown) looked at big orders alone. This one asks about the relationship between the BIG players and everyone else.

## Plain-English question
Over the last half hour, did the big individual orders and the rest of the crowd push the same way or opposite ways? When the big orders are buying while everyone else is selling (or the reverse), does price follow the big orders, and do level-fade trades do better when the big orders are on their side and worse when the crowd is on their side but the big orders are against them?

## Definitions (fixed here, no fitted cut points)
- Big order: a merged same-side order (consecutive same-side prints at most 1 ms apart) of at least 70 contracts, from `scratch/orders_20261020/*.tsv` (tick archive, 836 sessions through 2026-10-19). These are individual aggressive orders reconstructed from ticks, not large volume at a price or on a bar. Sensitivity only: 40 and 100.
- BIG(w) = signed net size of big orders (buys positive) whose first print is in window w.
- TOTAL(w) = cumulative delta over w = ask-aggressor volume minus bid-aggressor volume from the 1-minute bars (`price_bars_primary`, complete volume, not only big prints).
- REST(w) = TOTAL(w) - BIG(w): the net aggression of everything that is not a big order.
- Window w = the 30 minutes before the decision minute T (minute-aligned, orders and bars strictly before T). Sensitivity only: 15 and 60 minutes.
- Each of BIG and REST is ranked against the previous 60 sessions at the same clock time and window (mid-rank for ties; at least 30 past sessions). Strong = rank >= 0.75 or <= 0.25. Decision minute 10:00-15:59 ET (30 minutes of history inside the session).
- Quadrants (absolute): BIG strong up / REST strong down ("big buying into crowd selling"), BIG strong down / REST strong up, and the two agree cells (both strong up, both strong down) for comparison. Sensitivity only: rank cuts 0.67/0.33 and 0.80/0.20.
- Session cumulative delta (CVD from the 9:30 open) is reported as a secondary variable, ranked the same way, never used for the verdict.

## Test A — market behavior (bars first)
Events: every minute T from 10:00 to 15:00 in the divergence quadrants, de-clustered to the first minute of each run with at least 30 minutes between events within a session. Outcome: forward 30 and 60 minute price change divided by ATR20, signed so that positive means price moved WITH the big orders (big up / crowd down: forward change; big down / crowd up: minus forward change). Control: every eligible minute in the same month x 30-minute clock bucket and the same sign. Report event mean, matched residual, day-blocked bootstrap CI, a permutation null (random minute from the same month x bucket, 1000 draws, 95th percentile), explore (2023-03-06..2025-05-31) and hold-out (2025-06-01..2026-10-19). Also, for context, the agree quadrants and "BIG strong, REST neutral" with the same outcome, so the added value of the divergence over big orders alone is visible.

## Test B — the roster (dollars)
Same 21,480-trade RTH level-fade replay with touch times as the burst-flip test, restricted to trades with a feature read. Aligned to the trade direction (short trades mirror the ranks):
- STAND-DOWN flag (primary): aligned BIG rank <= 0.25 and aligned REST rank >= 0.75 (the crowd is with us, the big orders are against us).
- STAND-IN group (secondary, predicted better): aligned BIG rank >= 0.75 and aligned REST rank <= 0.25.
Metrics exactly as in the burst-flip pre-registration: per-trade mean pnl (sum/N), matched difference of unflagged minus flagged within 30-minute clock buckets, day-blocked bootstrap CI, shuffled-label placebo within month x bucket, explore vs hold-out, five families, inside the AGREE (rotation-gated) roster, incremental over the rotation gate, saving per trade, time of day.

## Verdict rules
- Test B stand-down is USEFUL only if (i) at least 150 flagged trades on at least 60 sessions (else NOT ENOUGH EVENTS, which is not a failure), (ii) CI lower bound above zero, (iii) above the placebo 95th percentile, (iv) hold-out same sign and at least half the explore size, (v) at least 3 of 5 families positive.
- Test A is a SIGNAL only if the matched residual CI excludes zero in the "price follows big orders" direction, it exceeds the permutation null, and hold-out has the same sign.
- Five sensitivity settings are reported next to the primary and never used to rescue a failed primary; this family is the second big-order test of the day (the first, the burst-then-flip, was not shown), which is noted when judging how much weight one positive cell deserves.
- If both pass: a live SHADOW tag only (never a gate) after DeepSeek review and after a live big-order feed exists. If only one passes or neither, say exactly what could not be shown.

## Rules
- Features use only data before the decision minute. Per-trade means are sum/N; day-blocking only for the interval. No lookahead. Deviations and sensitivities are labelled. Recorded as a RESEARCH_CLAIM either way. Not wired to anything live. The study script is not yet DeepSeek-reviewed (stated in the claim).
