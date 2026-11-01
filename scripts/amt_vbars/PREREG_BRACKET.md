# Pre-registration: a side-agnostic bracket after the tell, exits at 5 / 15 / 30 minutes (written 2026-11-01 BEFORE any outcome)

Origin: the trader needs fully automatic trades and cannot supply the side; the tell is an expansion detector with a coin-flip side (`amt_tell_expansion_5_15_30_60min_windows_20261101`); user asked for a 5/15/30-minute trade backtest. Explore only (516 sessions to 2025-05-16, decision points 10:00-14:30 from `decision_points_explore.csv`; the AMT tell hold-out is not extracted). Script `run_bracket.py`, one run. This is a TRADE backtest (entries, stops, costs, fills), unlike the expansion study.

## The structure (needs no side)
At a decision bar i with close c0: a buy stop at c0 + k and a sell stop at c0 - k, both live for W minutes (500-volume bars with end time within W of the decision bar's end). k is data-derived and rolling: k = m x the median (high - low) of the 20 bars ending at the decision bar, m in {1, 2} (two widths, both reported; no other value tried). The first trigger to trade fills (gap rule: a bar opening beyond the trigger fills at its open) with one tick of adverse slip; the other trigger becomes the stop (stop distance 2k); exit at the stop (gap fills at the open, one tick adverse), or W minutes after the fill at the close of the bar completing the window (one tick adverse), or at the 15:55 open, whichever first. $2 per point, $2 round trip, 1 MNQ.
Resolution rule (the 500-volume bars carry no intrabar order): a bar whose range reaches BOTH triggers is AMBIGUOUS and scored as the worst case, entering on one side and stopped on the other (loss of 2k plus both slips). Ambiguous counts are reported per cell; a cell with more than a quarter of fills ambiguous is flagged as dominated by bar resolution rather than by market behaviour.
Cells: m in {1, 2} x W in {5, 15, 30} = 6, all reported.

## Arms (unique (date, bar) decision points, the structure is symmetric so each point counts once)
TELL = either direction has ncomp == 5. CONTROL_MOVING = no tell in either direction and price moving in at least one (the expansion test's control). CONTROL_NONODE = fast, flip, oscillation, strides all true in a direction with no node ladder (the ladder-isolating control). The control is the placebo here: it uses the identical structure with no tell.

## Statistics
Per decision point (no fill = 0) AND per fill; fill rate; ambiguous share. Per-point mean net dollars per arm, difference TELL minus control weighted to the TELL entry-time mix (three bins by minutes since 09:30: under 90, 90-180, 180 and later), day-blocked bootstrap CI (2000 draws, seeded); TELL absolute mean with its own day-blocked CI; chronological halves by median date. Counts first.

## Reading rule (stated before the run)
A cell "shows a tell bracket edge" only if ALL hold: >= 200 tell points on >= 100 dates; TELL absolute mean per point > 0 with CI lower bound > 0; TELL minus the moving-only control > 0 with CI excluding zero; same sign in both halves; ambiguous share under a quarter. Six cells are tested: one passing cell is a LEAD for one frozen look at the sealed hold-out (not extracted, needs the user's go), not a result; the same sign across the three windows is required before calling anything robust. A positive difference with a negative absolute mean is NOT a rule (the 2026-11-01 hold-out lesson: relative skill with negative dollars). Resolution (CI half-width) is reported either way.

## Not tested
Globex; a stop other than the opposite trigger; targets or trails; sub-bar order from ticks (would remove the ambiguity and sharpen 5-minute cells; the tick archive covers 836 RTH sessions); the half-off-at-IB-high runner.
