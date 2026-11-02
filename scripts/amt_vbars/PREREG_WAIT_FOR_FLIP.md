# Pre-registration: wait for the DDY flip AFTER the tell fires, then trade the flip's side (written 2026-11-01 BEFORE any outcome)

Origin: the trader (2026-11-01): "you need to wait for the flip after the tell". The earlier test (`amt_tell_ddy_flip_approx_side_guide_not_shown_20261101`) used a flip that had already printed in the 10 bars up to the fire; this is the wait-for-confirmation design, the delta-flip analogue of the wait-for-break test (`amt_tell_armed_wait_for_break_entry_not_shown_20261101`). Explore only (516 sessions to 2025-05-16; the AMT-tell hold-out is not extracted). Script `run_wait_for_flip.py`, one run. Research only; Stage 2 keeps running unchanged.

## The rule
ARM: after a tell fire (the 1,760 research V1 fires, signal bar i0), the FIRST DDY flip (APPROXIMATE: 10-bar WMA of ask-minus-bid delta, state change after the old state lasted at least 10 bars; reproduces 566 of the 786 real flips on the trader's own export, precision 0.71, recall 0.72) at a bar after i0 within 120 minutes (the tell's own no-break window) and before the 15:55 flatten. Direction = the flip's direction (up LONG, down SHORT), whatever the tell's direction was. Entry at the open after the flip bar plus one tick adverse.
Stop (data-derived, no search): the extreme of the bars from the signal bar i0 through the flip bar (the low for a LONG, the high for a SHORT) minus/plus one tick, i.e. the swing the flip is claimed to end. A fire whose entry is not beyond that stop by more than 2 ticks is skipped and counted. No target (targets lowered the average, `amt_tell_profit_exit_targets_not_shown_20261101`), no stop moving; exits: the stop, 120 minutes after entry, the 15:55 open; gaps fill at the open; $2 per point and $2 round trip, 1 MNQ.

## Controls and splits
CONTROL (same selection minus the tell): the identical wait-for-flip rule started from non-tell decision points (the moving-only points of `decision_points_explore.csv`, price moving in at least one direction, no tell in either); events reachable from an armed fire belong to ARM and are removed from CONTROL; de-duplicated by (date, flip bar). PLACEBO: at each ARM entry bar a random direction with the SAME stop distance mirrored, 40 draws (p95 of the mean is the bar). REFERENCE (not a pass criterion): the tell direction entered immediately with the node stop, +2.68 per trade (`run_direction_output.txt`).
Descriptive splits of ARM (not counted toward the reading): the flip AGREES with the tell direction (a confirmation entry) versus DISAGREES (a reversal entry); fires with no flip in the window (no trade, counted).

## Statistics
Per-trade means (sum / N), win rate, share of exits at the stop; day-blocked bootstrap CIs (2000 draws, seeded) for ARM's absolute mean and for ARM minus CONTROL weighted to ARM's entry-time mix (three bins by minutes since 09:30: under 90, 90-180, 180 and later); chronological halves. Counts first.

## Reading rule (stated before the run; absolute dollars)
ARM "shows a wait-for-flip edge" only if ALL hold: >= 200 ARM trades on >= 100 dates; ARM absolute mean > 0 with the day-blocked CI lower bound > 0; ARM minus CONTROL > 0 with the CI excluding zero; ARM mean above the placebo p95; same sign of ARM minus CONTROL in both halves. This is the 7th test of the direction family (earlier looks: R2, R3, R4, F1, F2, F3, plus the first-break count), so one pass is a LEAD for one frozen sealed look, not a result; a positive difference with a negative absolute mean is NOT a rule. Resolution (CI half-widths) reported either way.

## Not tested
The true DDY flips (history unavailable), a flip plus absorption, targets or trails, Globex, other stop constructions, a flip window other than 120 minutes.
