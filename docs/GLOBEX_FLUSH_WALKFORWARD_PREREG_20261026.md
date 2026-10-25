# GLOBEX_FLUSH family: walk-forward, realistic-fill, mirrored-placebo check — pre-registration (2026-10-25)

Follow-up to `docs/FLUSH_RECONCILE_PREREG_20261026.md` (RTH_FLUSH: NOT SHOWN under the same treatment). User (2026-10-25, "Fine do it", "be prudent") asked to run the Globex flush modes the same way. Committed BEFORE the study runs. Nothing live changes. MOMENTUM_CHASE is a separate, later study.

## What is being tested (from `scripts/backtest_flush_patterns.mjs` and `server/services/globexFlushDetector.js`, read before writing this)
Trigger = a RTH close-window bar (15:59-16:29 ET) that closes beyond the prior-day value area (`PD_VAL`/`PD_VAH` from `level_prices`, the row for that date); the sequence runs continuously from that bar to the bar before the next 09:30 open. Balance = the 30 bars after the trigger; resolution = the first close beyond the balance by 50 points; entry = the resolution bar's close; stop = the opposite balance edge (structural price); exit = the end of the overnight sequence. Four buckets by (departure direction -> resolution direction): UP->UP CONTINUATION long, DOWN->UP REVERSAL long, DOWN->DOWN CONTINUATION short, UP->DOWN REVERSAL short. The stored backtest numbers (`FLUSH_BACKTEST_REFERENCE` 2026-10-19: REVERSAL_LONG N=84 EV +100.4, LONG N=103 +33.4, SHORT N=74 -27.7, REVERSAL_SHORT N=91 -43.4) predate the 2026-10-19 bar rebuild, and every bucket's pace tercile cutoff, volume medians and tier targets (p75 MFE per tier) are computed from the SAME bucket population they are then scored on (self-referential, 4 buckets x 3 tiers, with the best bucket then headlined = winner's curse).

## Population and exclusions
2023-03-06 .. last complete date, trigger day and the next day outside NQ roll weeks, sparse window 2025-09-28..2025-11-19 excluded, sequences of at least 60 bars. Counts printed.

## Arms (same events)
- **A, in-sample backtest procedure on current bars** (full-sample per-bucket calibration, ideal fills, entry = resolution close): the number to compare with the stored reference; informational (the stored rows predate the rebuild).
- **B, walk-forward calibration, ideal fills:** for each event, pace tercile cutoff, volume-building medians and tier targets come from PRIOR events of the same bucket only (same tier rule as the backtest: tier target = p75 MFE of the prior tier events if >= 8, else the prior bucket median MFE); a bucket needs >= 15 prior events, otherwise the event is dropped (counted).
- **C, walk-forward calibration, realistic fills (primary):** entry at the OPEN of the bar after the resolution bar; the structural stop PRICE kept, gap-aware fill (if the open is already beyond it, fill at the open); target distance from the real entry, gap-aware fill; stop first; exit at the close of the last bar of the overnight sequence.
- **D, direction-mirrored placebo of C:** flip direction, same stop distance from the real entry and same target distance.

## Rule (frozen)
PRIMARY test = all four buckets pooled, one event per bucket-day: **SURVIVES** only if arm C pooled EV has a day-blocked 95% CI lower bound above 0 AND `C - D` (paired by event) has a CI lower bound above 0 AND both chronological halves of C are positive. Per-bucket results (and by year) are descriptive only, for the opposite-signed-subgroup check; four buckets means any single-bucket headline is a 1-of-4 pick and cannot be SHOWN on its own. Report N, win rate, EV per trade (sum/N), CIs, top-5-day share. **Live comparison:** live `GLOBEX_FLUSH_*` rows (first live row date onward) next to the arm-C simulated P&L of replay events matched by direction within one calendar day of fired_at; counts and means with N stated (N is small, about 4-13 per type).

## Limits
Replay events are about 75-100 per bucket over 3.5 years; the walk-forward drops the first 15 per bucket; the sequence includes the 17:00-18:00 halt gap as one bar step, as the live detector does; the live Globex detector's exact trigger window and date convention are matched only by direction/date proximity here. The ONH/ONL repair does not enter this strategy (it uses PD_VAL/PD_VAH).
