# Scope: volume by price and delta by price — is volume building at a price, and should we hold, engage, or fade? — 2026-10-26 (for the user to read first; DeepSeek is asked AFTER the user has seen this)

Nothing in this document is built, tested or scored. It is the plan, written so the user can correct it before any work.

## What the user asked (verbatim, 2026-10-26 night)
"As we start getting into volume profile also we'll have to start testing volume by price and delta by price to show if volume is building at price. And we should hang on to a trade or engage in a trade or fade current move. You can check sierra's chart docs on this and the internet." And: "Also check with deepseek about its interpretation once you build out the scope. I would like to see what you come up with first."

## What Sierra Chart itself means (so ours matches the chart the user reads)
- **Volume by Price** study: each price's volume bar can be drawn as total, bid volume and ask volume separately, a bid-by-ask pair, or their difference; diagonal differences compare the bid at one price with the ask at the adjacent price (Sierra docs: [Volume By Price Study](https://www.sierrachart.com/index.php?page=doc%2FStudiesReference.php&ID=141&Name=Volume_by_Price)). The study code is not public; ACSIL exposes bid and ask volume per price (`sc.VolumeAtPriceForBars`) per Sierra's support board.
- **Numbers Bars**: per bar, per price, the ask volume, bid volume and their difference; "delta" in Sierra's wording is the Ask minus Bid volume at a price level or for a period; diagonal imbalance coloring compares dominant sides at adjacent prices with configurable percentages ([Numbers Bars](https://www.sierrachart.com/index.php?page=doc%2FNumbersBars.php)). Numbers Bars works on intraday charts only.
- Sierra's cumulative delta needs the feed's historical bid and ask volume; our tick files carry `BidVolume` and `AskVolume` on every record, so the split exists for the whole history (per `scripts/tick_microstructure/scid_reader.py`; complete 2023-03..2026-10 per the 2026-10-20 absorption study).
- NOT verified from Sierra's docs: the exact diagonal ratio thresholds the user uses, and how Sierra assigns a trade to bid or ask when it prints between them. To be asked (below), not guessed.

## What we already have and what is new
Built tonight: `volume_at_price_30m` = TOTAL volume per 0.25 price per 30-minute slot, 2023-03..2026-10 (7.1M rows, reconciled to the daily table), with `getBarProfiles` (POC/VA at any bar size). **Not yet stored: the bid/ask split per price.** Rebuild from the raw records (summing each record's `BidVolume` and `AskVolume` at its price, which is how Sierra's own studies read it) into a sibling table `volume_at_price_30m_ba` (bid_vol, ask_vol), reconciled so bid + ask equals the total already stored; records with neither are counted and reported.

Already tested in this project (do not repeat; results are in `performance_audit` `RESEARCH_CLAIM`, listed with `node scripts/record_claim.mjs --list`):
- **Volume building** (a composite of volume z-scores at the moment a level is touched): CONFIRMED large effect on whether a touch RUNS (consumes the level) or HELD: top quartile 24.5 percent run rate vs bottom 6.5 percent (`volume_building_strength_predicts_level_run_vs_held`); it predicts a bigger swing in either direction, not direction (`VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`). This is the closest existing answer to "hold or fade at a level" and it is measured per bar, not per price.
- **Order flow around levels** (per-minute aggressor volume, big orders, absorption at sweeps, trapped buyers/sellers, burst flips): mostly NOT SHOWN as stand-alone signals (`orderflow_absorption_at_sweep_not_shown_20261020`, `big_order_*`, `stuffed_*`); one real, small descriptive effect: trapped aggressive-buy volume above the close predicts worse long outcomes at the 30-minute horizon (`bubble_trapped_buyers_step_aside_cells_20261020`, Spearman about -0.13, did not carry to dollars on the roster).
- **Delta** (cumulative and recent, aligned or not): mostly negative or confounded (`orderflow_*`, `direction_signed_recentdelta_*`).
What has NOT been tested: the **price dimension over time** — how much volume has accumulated AT the price zone of a defended level, its bid/ask split and diagonal imbalances in that zone, and how that evolves bar by bar (the Sierra volume-by-price picture), as opposed to per-bar totals.

## The decisions, as measurable states at a level L (a defended floor/top, a period line, or a node)
Zone = the band around L (a data-derived fraction of the bar-range scale, never a fixed point count). For each bar since the level was first approached:
1. **Volume building at price**: zone volume (all prices in the zone, this bar and cumulative) relative to the same-clock normal; and the zone's share of the bar's volume. "Building" = rising across consecutive bars vs the normal for that clock.
2. **Delta at price**: ask minus bid volume in the zone, and its sign relative to what price did (price held while the opposing side was aggressive = absorption; price moved with the aggression = initiative). Reported as percentile of the same-clock distribution, not raw.
3. **Diagonal imbalances** at the zone's edges (Sierra's definition): stacked consecutive-price imbalances at the zone's top/bottom edge, ratios set from the data's own percentiles unless the user supplies theirs.
Actions to evaluate, each as a conditional-outcome question (never a pooled verdict; floors and tops, RTH and Globex separately):
- **ENGAGE**: at the moment a defended run or a level touch confirms, does the state (building / absorption / initiative) separate better from worse outcomes than the same event without it?
- **HOLD**: for an open position, does the state at later bars (volume still building at/near the stop side or target side; delta flipping) separate "keeps going" from "gives it back"? (This is the exit-timing question; the earlier exit audit showed arm-a-stop mechanisms need realistic fills.)
- **FADE**: when price drives into a level, does a different state (initiative with no response at the level, vs absorption) separate fades that work from fades that run over?

## Method guardrails (project rules that apply)
Signal-level forward-return pre-test first (no stop/target), conditional vs unconditional over the same horizon, then a real bar-by-bar trade only if that shows something; every feature a percentile vs the same clock slot over a trailing window (no fixed thresholds); both RTH and Globex; day-blocked intervals; explore/hold-out as a screen on spent history with a forward look as the clean test; no lookahead (a feature at decision time uses ticks up to the decision bar's close); the controls from the defended-run work (blind same-clock entries, fresh-extreme births, mirror); a pooled result is a question, split by structural variable first.

## Stages
- **S0 data**: bid/ask per price per 30 minutes (sibling table, nightly refresh), reconciled to the totals. Checked against a Sierra Numbers Bars or Volume by Price reading the user gives me for one bar (the user reads one number off their chart and I confirm ours matches).
- **S1 worked examples on charts**: this morning's floor (29,024), plus 3 to 5 of the user's own cases they name; a Sierra-style volume-by-price view per period (bid and ask colored, delta, imbalances) beside the candles, so the user can say whether "volume building at price" looks like what they mean.
- **S2 definitions fixed and shown to the user** (what counts as building, absorption, initiative, the zone width) before any outcome is read.
- **S3 signal-level pre-test** on defended-run events and the level universe; **S4 a real-trade test** only for what survives S3, written down first.
- DeepSeek: first a BLIND read of the user's words (as for the defended-level work), compared with this scope; then design review of S2; code review before any run; dispatched only in off-peak windows (the dispatch script now refuses peak).

## Questions for the user (answer any, none blocks S0)
1. Which decision matters most first: engage, hold, or fade? (I would start with ENGAGE at the defended-run events, since they exist now.)
2. On your chart, which bid/ask view do you read: Numbers Bars or Volume by Price, bid x ask or delta, and do you use diagonal imbalances (what ratio, e.g. 300 percent)?
3. Name two or three dates where you watched volume build at a price and it mattered (hold, add, or fade). I will use them as worked examples, not as evidence.
