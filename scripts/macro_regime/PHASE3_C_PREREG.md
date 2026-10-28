# Phase 3 prereg: Regime C execution layer (backtest engine only)

Written and committed BEFORE any Regime C trade was simulated. Regime B is out of scope (see `prereg_retrospective_20261027.md`).
"Execution layer" here means the trigger/exit/friction simulation specified in the handoff. No live order placement, no wiring into
`acd.js`, nothing near Sierra. It is a research backtest.

## What is frozen (spec values, unchanged) 
- Population: sessions classified `REGIME_C_MID_CONCENTRATION` by the locked classifier (labels in `regime_labels.csv`, produced by `run_audit.py`).
- Trigger: price breaks the IB on LOW breakout-bar volume (< volMA20), then a bar closes back inside the IB within 5 bars; trade the reversal.
- Stop: sweep extreme +/- 0.75 x ATR14(1-min). Target: the opposite IB boundary. Ex-ante R:R >= 1.0 required.
- Friction: 1 tick slippage per side, stop fills before target on a same-bar hit, flatten at 15:58, max 1 trade per direction, max 2 per day.

## Details the spec left open, fixed here before seeing any result
1. Bars: 1-minute, open-time stamped (bar 10:30 covers 10:30:00-10:30:59), RTH 09:30-15:59.
2. Initial state at 10:30 is "inside" (the 10:29 close can never exceed the IB high or fall below the IB low, since the IB is the max/min of its own highs/lows).
3. Breakout bar = the first bar whose CLOSE is outside the IB while the state is inside. The state is "outside" until a bar closes back inside.
4. volMA20 = simple mean of the 20 bars immediately before the breakout bar (the breakout bar itself excluded). Breakout qualifies only if its volume < volMA20. A non-qualifying breakout consumes the episode (no trade).
5. Reclaim bar = the first bar among the next 5 after the breakout bar whose close is back inside [IB_Low, IB_High]. No reclaim within 5 bars = no trade for that episode. A close outside on the OPPOSITE side ends the episode as failed and starts a new episode on that side (volume check applies to that bar).
6. **Spec correction (lookahead):** the handoff says "entry on the reclaim bar open". The reclaim is only known at that bar's CLOSE, so entering at its open uses information from the future. Entry is the open of the bar AFTER the reclaim bar, 1 tick adverse. The entry bar must be <= 15:57.
7. Direction: high-side break then reclaim = SHORT; low-side break then reclaim = LONG.
8. Sweep extreme = highest high (short) / lowest low (long) from the breakout bar through the reclaim bar inclusive.
9. ATR14 = simple mean (not Wilder) of the true range of the 14 bars ending at the reclaim bar inclusive. True range uses the prior bar's close; the first bar of the session has no prior and is not needed (ATR window is always deep inside the session).
10. Stop price is rounded outward to the tick. R:R is computed at the slippage-adjusted entry: (distance to target) / (distance to stop) >= 1.0, and the geometry must be valid (short: stop > entry > target; long: stop < entry < target), else skip.
11. Exit walk starts on the entry bar itself (entry is at its open, so its high/low count). Per bar: if the bar OPENS beyond the stop, fill at the open (never at the stop price); else if the bar's range reaches the stop, fill at the stop; then target (a gap in favor fills at the open). Stop is checked before target on the same bar. Every exit takes 1 tick adverse slippage, including the target (conservative, per the spec's "per side").
12. Flatten: exit at the OPEN of the 15:58 bar with 1 tick adverse (if that bar is missing, the close of the last bar before it).
13. One position at a time (single-contract trader). A signal that completes while a position is open is skipped. Max 1 trade per direction and 2 per day, counted on taken trades.
14. Instrument and money: MNQ, $2/point, commission **$2.00 round trip** (`server/config/instruments.js`, repo ground truth). The handoff says "$4.00 commission"; that is run as a pre-registered sensitivity ($4.00 RT), not the headline. Prices are NQ bars, point values identical.
15. R = points / planned risk points (stop distance from the slippage-adjusted entry).

## Evaluation: one look, no iteration
- Train and hold-out are reported SEPARATELY, never pooled into one verdict. This run is the hold-out's first and only look. Whatever it shows, no parameter above changes; any change needs a new prereg and a fresh window that does not exist in this database yet.
- Reported per split: trades, distinct days, win rate, mean $/trade (sum/N, never a day-weighted mean), mean R, exit mix (stop/target/flatten), top-5-day share of total P&L, day-blocked bootstrap 95% CI of the mean $/trade (resample days, pool their trades; 5000 iterations, fixed seed).
- Placebo (asymmetric stop/target geometry needs one): for each real trade keep the entry bar, entry price, stop distance and target distance in points but draw the direction at random; 200 trials through the same engine. Report the placebo mean distribution (p5/p50/p95) and the share of trials at or above the real mean.
- Does the REGIME filter add anything? Same engine on every classified session of the same split (regimes A, B, C, D reported separately). Compare C against non-C: per-trade mean for each arm (sum/N), delta with a day-blocked CI that resamples days from both arms together and recomputes each arm's pooled per-trade mean. C has wider IBs by construction, so mean R is reported alongside dollars.
- Cost sensitivity: the headline repeated at $4.00 RT commission.
- Pre-registered reading, descriptive only: a hold-out result is called "a lead" only if hold-out CI lower bound > 0 AND hold-out real mean >= placebo p95 AND train mean > 0. Otherwise: "no demonstrated edge". N and CI width are always stated; at this sample the study cannot confirm or reject a real 0.2-0.3R edge.
