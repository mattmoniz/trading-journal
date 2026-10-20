# Pre-registration: large-volume bubbles (trapped buyers / trapped sellers) at a sweep — 2026-10-20

Written and committed BEFORE any outcome is computed (the cell extraction that produces the data has no outcomes). Follows `ORDERFLOW_ABSORPTION_PREREG_20261020.md` (aggregate aggressor flow: not shown at the bar, P2 sign consistently negative). Origin: the user's Sierra Chart screenshots show numbered bubbles (70-146) and the description "when the market is driving down, large buy orders are getting stuffed and then large sellers come in; at the end, after the market has come down and turned up, larger buyers come in".

## The bubbles
Sierra's documentation (StudiesReference ID 390) names the study "Large Volume Trade": one marker per price level within a bar, the number being the volume at that level (several Draw Modes: total, max single trade, bid/ask, difference), with a Volume Threshold and a Trades Combining Method. On 2026-10-12 and 2026-10-09 (09:30-10:30) only 1-3 SINGLE trades were 70+ lots but 85-97 one-minute x price cells had 70+ total lots, so the bubbles are per-price-per-bar volume, not single orders. The exact Draw Mode, threshold and bar type of the user's chart are not known (asked; `OPEN_DECISION bubble_large_order_definition_needed_20261020`); this test uses the most plausible reading, total volume at one price in one 1-minute bar, and is made scale-free so the unknown threshold does not matter.

## Data
Tick data (`.scid`, NQ front month per `price_bars_contract_calendar`, 2023-03-06..2026-10-13 on disk) aggregated by `scripts/tick_microstructure/extract_cells_20261020.py` into per-session files of (minute, price, total, bid-aggressor, ask-aggressor) cells, RTH 09:30-16:00 ET, cells with total >= 20 kept (derived aggregate on disk under scratch, not ingested into Postgres, per the standing architecture decision). Validated against `price_bars_primary` before use. RTH only; the Globex arm is not covered (no tick extraction for overnight yet; flagged).

## Definitions (no fixed cutoff)
- A cell is ask-dominant if ask > bid, bid-dominant if bid > ask (aggressive side).
- At decision bar e with close Cc and window W in {3, 10, 30} minutes ending at e: UWbuy(W) = sum over ask-dominant cells in the window whose price is ABOVE Cc of total^2 (large aggressive-buy volume now underwater, i.e. buyers stuffed); UWsell(W) = sum over bid-dominant cells whose price is BELOW Cc of total^2 (large aggressive-sell volume now underwater, sellers trapped). Squaring weights big cells without any threshold. Each value is converted to a rank against the previous 60 sessions at the same clock time (each past session computed the same way with its own close).
- Frames: lows long, highs short mirrored (underwater roles swap).
- Events and outcomes exactly as in `ORDERFLOW_ABSORPTION_PREREG_20261020.md`: first penetration of ONL / prior-day low / IB low (and mirrored highs), P1 decision = reclaim close, P2 decision = first-penetration bar, outcome = symmetric race scaled by the 30-minute local range (q = 1; 0.5 and 2 reported), score +1/-1/0.

## Hypotheses (directional, each at the 97.5th/2.5th percentile of a permutation null for the max/min over W)
- P1b (turn): Spearman(UWsell rank at the reclaim, long race score) > 0 (large sellers trapped under price at the turn).
- P2b (step aside): Spearman(UWbuy rank at the penetration bar, long race score) < 0 (large buyers trapped above price on the way down).
- Null: permute race scores within arm and calendar month (1000 draws), recompute max/min over W. SUPPORTED only if (i) beats the null, (ii) day-block bootstrap CI at the argmax W excludes 0 in the predicted direction, (iii) same sign in both halves (explore 2023-03-06..2025-05-31 / hold-out 2025-06-01..2026-10-16), (iv) the mirrored frame has the same sign. Otherwise "not shown".
- Sensitivity, never used to pick a winner: percentile-count version (number of cells above the 95th / 97.5th / 99th percentile of that clock time), max-single-trade version, and the sum of the aggregate-flow score from the previous test as a covariate (does the bubble view add anything beyond aggregate aggressor flow?).

## Rules
Claude builds; DeepSeek reviews the code before the verdict is final. Record via `recordClaim()` whatever the result, phrased as what was and was not shown. Nothing is wired live. If the user supplies the study's real settings, a variant with those exact settings is run as an addendum, pre-registered the same way.
