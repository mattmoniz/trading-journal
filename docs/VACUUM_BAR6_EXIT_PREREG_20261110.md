# Vacuum: the bar-6 DETERIORATING exit (user 2026-11-10 night: "can we test bar 6 deteriorating exits with the liquidity pull vacuum trade? the flush long worked great tonight and went farther than the vacuum long") (pre-registered BEFORE any outcome of this test is read)

Queue id Q4-8 (the last of the 8 Q4 slots, docs/CANDIDATE_QUEUE.md). Improvement register row 54. Explore only (2023-04-04..2025-05-16); sealed window and depth era untouched. Tick-built 500-volume bars (the minute-bar repair does not touch them).

## What the rule is (existing, reused definition, never re-derived)
`computeBar6Checkpoint()` in `server/services/maeMfeReplay.js`, used for level setups on 1-minute bars: over bars 0..6 after entry (bar 0 = the entry bar), find the bar holding the WORST adverse price; worst bar index <= 2 = RECOVERING (the low was made early and has been passed), >= 3 = DETERIORATING (new adverse extremes are still being made). Earlier finding for level setups (claim `bar6_early_exit_deteriorating_confirmed_recovering_inconclusive`): cutting a DETERIORATING trade at the bar-6 close made EV worse. Whether the vacuum behaves the same is the question; its bars are 500-volume bars, not minutes, so bar 6 = the 7th 500V bar from the entry bar.

## Population and arms (frozen)
The 9,116 taken live-rule onsets of row 52 (`unified_exit_lock.vacuum_onsets()`), RTH and Globex apart; entry Open of the entry bar, stop 2.5 x EMA10(TR), 30-bar hold, 2.0 pt cost (the live rule = ARM A, the baseline, `vacuum_take_look.walk`).
- ARM B: if the trade is still open after bar 6 (not stopped in bars 0..6, flat not reached) and the status is DETERIORATING, exit at the CLOSE of bar 6; otherwise identical to A.
- ARM C (descriptive): if DETERIORATING at bar 6, move the stop to the bar-6 close (never looser than the original), keep holding to the 30-bar clock; stop fills as `sim_vac` (gap = open, minus one tick).
- Placebo: the same arms on the SAME bars in the OPPOSITE direction (stop, bars, rule identical). A rule that merely trims variance or shortens holds shows the same paired change on the placebo.

## Counted tests (4; Holm 0.10 over the 4; two-sided; day-blocked bootstrap, 10,000 draws, seeds 3301-3304; gate >= 100 trades whose status is DETERIORATING on >= 60 days)
Per track (RTH, Globex): T1 = mean paired difference (ARM B minus ARM A) in net points per trade over ALL trades of the track (a trade that is not DETERIORATING contributes 0); T2 = the same difference for the real direction minus the same difference for the opposite-direction placebo (does the rule help the vacuum's direction more than it helps a coin flip?).

## Null gate
Sign-flip Monte Carlo of the 4-cell pipeline (1,000 iterations): family-wise false-pass rate at Holm 0.10 must be <= 0.10. Synthetic-bar unit tests of the walker (deteriorating long exits at the bar-6 close, recovering long holds, trade stopped before bar 6 unchanged, flat before bar 6 unchanged, short mirror, arm C stop move and gap fill) and parity of ARM A with `vacuum_take_look.walk`.

## Descriptive (uncounted)
Share DETERIORATING; net per trade by status under A, B, C; the paired difference by direction (long, short), halves and thirds by date; Arm C difference; the same on the placebo; the vacuum row 160187 (tonight's long) classed by the rule as a worked example (recorded, not tested).

## Next-step tree (co-022)
- T1 survives Holm and T2 agrees (rule helps more than for the placebo) and both halves positive: a lead (co-024). Next: a forward shadow flag of the bar-6 status on live vacuum rows (stored at bar 6, no order change) and a pre-registered forward read; nothing live without the user.
- T1 survives but T2 does not (the rule helps a coin flip as much): it is a shape effect (shorter holds), not information; no wiring; parked.
- Nothing survives: bar-6 deterioration is no usable exit signal on the vacuum (as for level setups); parked, not retired (the one clean null of co-025; Q4-8 slot spent).
- A cell significant with the opposite sign (the rule hurts): consistent with the level-setup finding; no action.

## Failure autopsy (co-022)
Report each cell's MDE, the DETERIORATING share, and the paired difference on the placebo, so a null is a measured size.

## FORWARD FLAG (user go 2026-11-10 night: "Lets call it the liquidity pull, yes store the live vacuum rows")
The bar-6 status of every taken live row is stored on `vacuum_live_events` (b6_* columns, see ARCHITECTURE.md), informational and gating nothing. Shared definition `scripts/vacuum_live/bar6_status.py` (the research script imports the same file; the research output was re-run byte-identical after the move). 78 earlier live rows (2026-11-09 and -10 sessions) were back-filled from the saved bar files with arm A checked against the stored net_stop25 (78 of 78 within 0.05); tonight's row 160187 was flagged by the live writer (src LIVE): DETERIORATING at bar 6 (bar-6 close 27,942.75), live exit +23.25 points, a bar-6 cut would have been -15.75. FORWARD READ (frozen): read once at 30 TAKEN DETERIORATING rows per track from the first LIVE-flagged row; cut (B minus A) interval above zero on that forward sample and a positive point estimate in both halves = a lead for a registered test; anything else = the explore null stands. The backfilled rows (src BACKFILL) are live-era but flagged after the fact and are reported separately, never pooled into the forward read.

## What this is NOT
Not a comparison of the vacuum with the flush: tonight's GLOBEX_FLUSH_LONG (a SHADOW row, entry 27,969.25 at 18:40 ET, target 28,056.65 hit 20:29, +$172.8) and vacuum 160187 (entry 18:35 at 27,956.5, clock exit 20:12 at 27,981.75, +$59) are one pair on one night; the flush has its own target and 146-pt stop and is not part of this test.

## Script
`scripts/vacuum_sim/vacuum_bar6_exit.py` (`test`, `build`, `null`, `run`). Output `scratch/vacuum_bar6_exit_20261110/`.

## RESULT (2026-11-10 night; look 275; claim `vacuum_bar6_exit_20261110`; output `scratch/vacuum_bar6_exit_20261110/output.txt`): NOT SHOWN, NO HOLM SURVIVOR
- Null gate 0.082; walker 8 checks passed. Status of the 9,116 trades at bar 6: RTH DETERIORATING 2,883 / RECOVERING 3,215 / stopped or flat before bar 6 1,020; Globex 791 / 891 / 316.
- Counted (net points per trade, two-sided): RTH T1 +0.226 [-0.117, +0.587] p 0.198 (MDE 0.52), T2 +0.403 [-0.167, +1.011] p 0.163; Globex T1 +0.359 [-0.449, +1.191] p 0.401 (MDE 1.23), T2 +0.292 [-1.026, +1.657] p 0.666.
- Descriptive: on the deteriorating trades the cut at bar 6 is worth +0.56 pt (RTH) and +0.91 (Globex) over holding; arm C (stop to the bar-6 close) +0.43 / +0.92; the opposite-direction placebo gains -0.37 / +0.15 from the same cut. Both halves and both directions are positive in point estimate and all intervals span zero. Under the live exit RECOVERING trades net +8.05 (RTH) and +13.66 (Globex) against DETERIORATING -6.53 and -8.66: the split is largely mechanical (bar 6 already holds 6 of the 30 bars) and the cut harvests almost none of it, because a trade that is deteriorating at bar 6 is on average already near where it ends.
- Reading: the bar-6 exit is not a usable improvement of the live vacuum on explore (MDE about 0.5 pt RTH, 1.2 Globex per trade), the same non-result as the level-setup finding with a milder sign. Parked, not retired; the live rows can store the bar-6 status as a forward flag if the user wants it (no order change).
- Not done: the worked example of tonight's row 160187 (the 500V bars after the entry are not stored per live row; not reconstructed). The comparison with GLOBEX_FLUSH_LONG is one pair on one night and was never part of this test.

## AMENDMENT A1 (2026-11-10 night, user: "can we test it during globex only"; written BEFORE any outcome of it is computed)
Globex alone is already one of the two tracks of the counted tests (T1 +0.359, T2 +0.292, neither near significance); a Globex-only Holm over 2 tests would still need p < 0.05. What is new is a DESCRIPTIVE split inside Globex (the pooled verdict is a question, cv-033), from the same 1,998 trades and the same arm B minus A and arm C minus A: by entry clock block of the signal bar, 18:00-19:59 ET (the reopen), 20:00-23:59, 00:00-05:59, 06:00-09:25. Per block: N, deteriorating N, B minus A and C minus A per trade (all trades in the block) with a day-blocked 95 percent interval (4,000 draws), and the same difference on the opposite-direction placebo. 0 counted tests, no claim of an edge; a block whose interval excludes zero is a lead needing its own registered test. Stage `globex_split` of `scripts/vacuum_sim/vacuum_bar6_exit.py`; look logged first by `scripts/vacuum_sim/log_look_bar6_globex.mjs`.

### A1 RESULT (look 276; claim `vacuum_bar6_exit_globex_20261110`; `scratch/vacuum_bar6_exit_20261110/output_globex_split.txt`): NO GLOBEX BLOCK EXCLUDES ZERO
B minus A per trade: 18:00-19:59 reopen (N 356) +0.09 [-1.76, +1.81]; 20:00-23:59 (N 224) +1.80 [-0.80, +4.53] (placebo -1.35); 00:00-05:59 (N 672) +0.52 [-1.12, +2.19]; 06:00-09:25 (N 746) -0.09 [-1.23, +1.07]. Arm C is similar (+2.05 in the 20:00-23:59 block, interval [-0.46, +4.64]). The deteriorating trades lose -7 to -13 pt under the live exit in every block, so there is something to avoid, but the cut at bar 6 harvests little of it with these sample sizes. The 20:00-23:59 block (tonight's long entered at 18:35, in the reopen block) is the largest point estimate, from 224 trades on 209 days and one of four unregistered cuts: a lead at most, to be read forward.
