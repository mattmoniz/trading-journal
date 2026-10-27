# Pre-registration: unified "Sweep + Reclaim" (failed auction) 1-minute execution engine — 2026-10-27

Written BEFORE any trade of this engine was generated. Origin: the user's spec (phases 1-6), replacing the static-coordinate level fades. The spec's parameters are the PRIMARY test and are not tuned; the Train period is used only for the small pre-listed sensitivity grid below.

## Data and split
NQ 1-minute RTH bars (09:30-15:59 ET) on the same 336 trade dates as the earlier studies (`scripts/lib/vbpTradeSet.mjs` date list; roll weeks and the 2025-09-28..2025-11-19 sparse window already excluded; days missing RTH bars are skipped and counted). Train = earliest 60 percent of dates (through 2026-01-02), Hold-Out = the later 40 percent (134 dates), frozen.

## Levels (all known before the bar that uses them)
PDH / PDL = prior completed RTH session high / low from bars (previous session with >= 330 RTH bars, within 5 calendar days). VAH / VAL / POC = the prior RTH session's value area from REAL TICK volume (`tickVolumeProfile.getDailyProfiles`, session `rth`, 70 percent rule), not the stored `level_prices` rows. IB_High / IB_Low = high / low of the 09:30-10:29 bars; usable only for sweep bars at or after 10:30. A level that cannot be computed on a date is skipped for that date. The "proximity zone" (bar range within 0.25 ATR_14 of L) is implied by the physical pierce of State 0 and adds no extra gate.

## State machine (per level, per direction, per date)
ATR_14 = mean true range of the 14 bars before the sweep bar, session bars only (minimum 5 bars, else the setup is skipped), floored at 1.0 point. **Sweep bar t** (fresh pierce): short: `High[t] > L` and `Close[t-1] <= L`; long: `Low[t] < L` and `Close[t-1] >= L` (without the previous-close condition every bar of a price that has traded above L for hours would be a "sweep"). **Reclaim:** the first bar j in t+1..t+K (K = 3) with `Close[j] < L` (short) / `> L` (long); none -> cancelled. While a setup is pending the level/direction is not re-armed; scanning resumes after the reclaim bar or after the window. **Entry** at `Close[j]`. **Stop** = `max(High[t..j]) + 0.25 ATR_14` (short) / `min(Low[t..j]) - 0.25 ATR_14` (long). Skip if `Stop_Dist < 10` or `> 35` points. **Target** = entry +/- 1.5 x Stop_Dist. The reclaim bar must not be the last bar of the session.

## Execution and accounting
From bar j+1: if the stop and target can both be hit on a bar the stop is taken first; a stop gapped through fills at that bar's open, a target gapped through fills at that bar's open (symmetric, the earlier engine's rule); otherwise at the stop / target price. Unresolved at the 15:59 close: marked to the 15:59 close. Point value 2 dollars. **Fee: 4 dollars round-turn per trade (fees plus one tick of slippage), headline; the 1-dollar fee is shown beside it.** Mode 1: no new trade in a direction while an accepted trade in that direction is still open (new trigger bar <= the open trade's exit bar), pooled across all levels; when several levels trigger on the same bar the order is nearest level to the entry, then level name. Drawdown on the realized curve ordered by exit bar. Intervals: date-blocked bootstrap (95 percent).

## Placebos (Hold-Out, same stop/target geometry, same fee, same Mode 1)
P1 random entry TIMES: each Hold-Out trade is replaced by one drawn at a random Hold-Out date and a random bar within +/- 30 minutes of the real entry's clock time, same direction and same stop distance (kills the level/sweep information, keeps time of day and geometry). P2 random DIRECTION: the real entry bars and stop distances with a coin-flipped direction. P3 random LEVELS: the full state machine on Hold-Out dates with every level shifted by a uniform random amount of up to +/- 0.5 x the prior session's range (keeps the sweep-and-reclaim pattern and the filters, removes the structural coordinates; 100 repetitions; P1 and P2 300 each). Reported: the placebo distribution (5th-95th percentile) of the mean per trade at the 4-dollar fee, trade count and profit factor, and the share of placebo runs at or above the real result.

## Sensitivity grid (Train-selected, descriptive)
K in {2, 3, 5} x R in {1.0, 1.5, 2.0}: the cell with the highest Train mean at the 4-dollar fee is frozen and shown on Hold-Out beside the spec cell (K = 3, R = 1.5). 9 cells, so only the spec cell is a counted test.

## Pass rule (fixed now)
The engine passes if, on Hold-Out at the spec parameters, the mean P&L per trade at the 4-dollar fee has its 95 percent date-blocked lower bound above 0 AND exceeds the 95th percentile of each of P1, P2 and P3. A positive point estimate that does not separate from the placebos is reported as NOT SHOWN.

## Stated in advance
Fee drag: with 10-35 point stops (20-70 dollars of risk) a 4-dollar fee is 6-20 percent of 1R; the break-even win rate at a 1.5R target is about 40 percent before fees and about 44-46 percent after; the report prints the trades' average. Entry at the reclaim bar's close assumes a fill at that close. Resolution on Hold-Out is limited by about 134 dates. RTH only; Globex untested. A zero or negative result is a result about this definition (K, 0.25 ATR buffer, 10-35 stop band, 1.5R), not about failed auctions in general.
