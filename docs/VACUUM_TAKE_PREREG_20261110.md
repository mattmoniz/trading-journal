# Vacuum item 1: is there anything to take? Favourable vs adverse run against a direction-blind placebo (pre-registered 2026-11-10 night, BEFORE any outcome of this test is read)

Origin: user 2026-11-10 ("the vacuum is the only setup showing promise; the open problem is how to take profits"), items 1-3 of docs/HANDOFF_20261110_LATE_NIGHT_NEXT_SESSION.md. Improvement register row 52. DESCRIPTIVE look: no new claim about the vacuum's edge and no candidate-queue slot (Q4 has 2 slots left; items 2 and 3 take them, Q4-7 and Q4-8). Explore only (2023-04..2025-05-16); the sealed window (2025-05-17..2026-06-14) and the depth era are untouched. Tick-built 500-volume bars, so the NQ minute-bar repair does not change this population.

## The question in plain words
The live vacuum rule fires on an expansion onset, enters next bar open, stops at 2.5 x EMA10(TR) and holds 30 bars. Its 9,116 explore trades average about -$4.80 per event (gross about zero). A better exit can only help if, after the onset, price runs further in the trade's direction than it would after a coin-flip direction with the same stop, entry and hold. Measure that run, and what a fixed take-profit would have collected, against the placebo.

## Population (frozen)
Every TAKEN onset of the live rule on explore (30-bar lock per track), from `unified_exit_lock.vacuum_onsets()` (the same onset loop as `vacuum_pairs()`, parity with `shadow.calc_outcome` asserted by that script's `build`). RTH (7,118 trades) and Globex (1,998) always separately (hr-002, hr-039).

## Definitions (frozen)
- Entry = Open of the entry bar, stop distance sd = 2.5 x EMA10(TR) at the signal bar, hold = up to bar `last` (30 bars, clamped at the hard flat), cost 2.0 points per trade (the family's convention). Real direction s; placebo direction = both directions on the same bars (each trade evaluated at s and -s; the placebo value of a trade is the mean of the two, so the control is direction-blind by construction and has the same stop, entry, hold, volatility and clock).
- Stop touched in a bar: low <= stop (long) / high >= stop (short); stop bar and entry-bar rules as `sim_vac`.
- MFE_pre = largest favourable excursion from entry over the bars BEFORE the stop bar (the whole hold if never stopped); the stop bar's own range is excluded because its high/low order is unknown. Reported in points and in stop units (MFE_pre / sd). MAE = largest adverse excursion, capped at the stop (sd) if stopped. Whole-hold MFE/MAE (as `calc_outcome`) are also stored.
- Bracket for take-profit multiple k in {0.5, 1.0, 1.5, 2.0, 3.0}: target = entry + g x k x sd; first touch wins; a bar that touches both stop and target counts as STOP; target fills at its price (no gap credit); stop fills as `sim_vac`; neither = close of the last bar; net = result - 2.0.

## ONE primary estimate per track (descriptive, uncounted; Holm not applied)
P: mean over trades of [MFE_pre(real)/sd - MFE_pre(placebo)/sd], i.e. the extra favourable run in stop units that the vacuum's direction has over a coin flip. Day-blocked bootstrap (10,000 draws, seeds 3101 RTH / 3102 Globex), 95 percent interval. "Something to take" = interval above zero on BOTH halves of the history (chronological halves) and on both directions (long, short).

## Descriptive (uncounted)
Mean/median MFE_pre and MAE real vs placebo; share of trades with MFE_pre >= 1 sd; bracket first-touch win rate and net points per trade, real vs placebo (difference with day-blocked interval), for each k; thirds and halves by date; long vs short; top-5-days share; MDE (2.93 x se) of P so a null can be read.

## Null gate
(1) Synthetic-bar unit tests of the excursion and bracket walkers (path straight to the target, straight to the stop, both in one bar, neither, gap through the stop). (2) Placebo is direction-blind by construction; additionally the sign-flip check: with each day's real-minus-placebo value multiplied by a random sign the bootstrap interval covers zero in at least 90 percent of 200 draws (a rough size check, not a Holm gate).

## Next-step tree (co-022)
- P interval above zero on both halves and both directions: there IS an excess run. Then (and only then) a pre-registered exit-design test (take-profit and/or scale-out) in dollars with an entry-price-only control, as its own row; the user earlier asked for no more profit-lock/trail research, so say so and ask before building trails.
- P inside zero: the vacuum direction carries no run beyond a coin flip with this geometry on explore; the gross edge of about zero is the whole story and no exit rule can create a profit from nothing. First MDE-stated null of the two co-025 needs for this question; the depth-era arm (item 3) already ran 2026-11-09 and is too thin (84 full-rule trades) to be the second; parked, not retired.
- P below zero with an interval excluding zero: the onset marks the end of the move; a separately registered fade test (the earlier ones: row 50 found the move is before the trigger).

## Failure autopsy (co-022)
If the primary is a null, record the stop-unit MDE, the share of trades that touch k = 1 before the stop in real vs placebo, and whether the excess is zero in both tracks, so "not shown" is a measured size and not a shrug.

## Script
`scripts/vacuum_sim/vacuum_take_look.py` (`test` = synthetic walkers, `run` = the look). Output `scratch/vacuum_take_look_20261110/`.

## RESULT (2026-11-10 night; look 272; claim `vacuum_take_20261110`; output `scratch/vacuum_take_look_20261110/output.txt`): NOTHING TO TAKE BEYOND A COIN FLIP
- Primary, extra favourable run in stop units: RTH (7,118 trades, 512 days) -0.004 [-0.022, +0.014], MDE 0.027 sd; Globex (1,998) -0.001 [-0.034, +0.033], MDE 0.050 sd. Both halves, thirds and both directions straddle zero (long -0.019 / -0.037, short +0.009 / +0.031: the sign split does not repeat across tracks and no interval excludes zero). Top-5-days share 0.04.
- Real MFE_pre 1.054 sd vs opposite 1.062 (RTH); stopped share 0.481 both; MAE 0.730 vs 0.734. Target-first rates identical at every k (RTH k 1: 0.446 vs 0.446). Bracket excess RTH -0.08..-0.21 pt, Globex +0.04..+0.35 pt, all intervals span zero.
- Live stop/hold net: RTH -2.18 pt vs placebo -1.78; Globex -1.85 vs -1.91. Null gate: walkers pass 8 synthetic checks, parity with `sim_vac`; sign-flip size check 0.965.
- Reading: a vacuum onset is followed by the same excursion as a coin flip with the same stop, so the live P&L (about the cost) is the whole story and no take-profit, trail or scale-out has anything to harvest. This is a measurement on explore with a stated minimum (0.03 to 0.05 stop units); it does not cover Wave 2, the depth-era book ratio (item 3) or the duration gate (item 2). Parked, not retired.
- A single live trade like 160187 (+38 pt, exited by the 30-bar clock, price ran another ~140) is one path; the explore data say the hold-30 exit leaves nothing systematic behind.

## AMENDMENT A1 (2026-11-10 night, written BEFORE any outcome of it is computed; prompted by the user's question on live trade 160187, exited by the 30-bar clock while price ran on): does a LONGER hold change the picture?
Same population, stop and placebo as above (stop 2.5 x EMA10 TR, initial only, no target). Hold H in {30 (the live rule), 60, 120} bars from Open[next bar], clamped at the same hard flat (RTH close - 300 s, Globex 09:29:50 ET); the onset population (30-bar lock) is NOT changed (descriptive). Per H and track: net points per trade of the stop/hold result, real vs the mean of both directions (excess = (real - opposite) / 2) with a day-blocked 95 percent interval (4,000 draws), plus mean MFE_pre in stop units. DESCRIPTIVE, 0 counted tests, no claim of an edge; if any excess interval excludes zero it is a lead needing its own registered test (a longer hold also raises overlap between onsets, so the pooled interval is a lower bound on the true width). Script stage `hold` of `scripts/vacuum_sim/vacuum_take_look.py`; ledger look logged first by `scripts/vacuum_sim/log_look_take_hold.mjs`.

### A1 RESULT (look 274; claim `vacuum_take_hold_20261110`; `scratch/vacuum_take_look_20261110/output_hold.txt`): A LONGER HOLD CHANGES NOTHING
Net-point excess over the placebo, hold 30 / 60 / 120 bars: RTH -0.196 [-0.779, +0.378] / -0.122 [-0.738, +0.516] / -0.034 [-0.709, +0.642]; Globex +0.031 [-1.265, +1.302] / +0.594 [-0.940, +2.090] / +0.534 [-1.221, +2.260]. Extra MFE_pre stays about zero at every hold; the favourable run grows with the hold (RTH real 1.05 -> 1.66 stop units) just as much for the opposite direction. So staying in longer, like trade 160187 did not, would on average have added the same run in the wrong direction; no interval excludes zero. Globex +0.5 to +0.6 pt at 60 / 120 bars is an unregistered lead inside wide intervals (full-hold availability falls to 0.57 at 120 bars Globex); nothing changed.
