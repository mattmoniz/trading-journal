# AMT S1 prereg: does the open's location against the prior value area predict that day's direction?

Written and committed BEFORE any S1 outcome is read. History-based (2023-03 onward) with ONE hold-out look; no multi-year forward wait.
Question about the MARKET (forward excursion), not a trade: no stops, targets, or geometry anywhere in this study.

## Why history is usable here
A window is burned per hypothesis. The S1 outcome (open-to-close by open location) has never been evaluated on this data. The project-wide
forking-paths caveat still applies (about a dozen adjacent tests on the same sessions): an explore p-value is never read at face value, and a
"confirmed" label below means "confirmed on held-out existing history", which is weaker than forward data.

## Population and data (all from `scripts/macro_regime/loader.py`, pinned window 2023-01-01..2026-10-27 exclusive)
- A session is ELIGIBLE if it is a full RTH session (>= 385 bars, first bar 09:30, last bar 15:59), the previous loaded session is also full and at most 5 calendar days earlier, and 20 prior full sessions exist for ATR20.
- Prior VAH/VAL = `compute_va_fn` of the prior full session (70%, volume spread across each bar's high-low; verified identical to the JS reference).
- ATR20 = mean RTH high-low range of the 20 most recent full sessions strictly before the day.
- Eligible sessions are sorted by date; the FIRST 60% are EXPLORE, the LAST 40% are HOLD-OUT (cut by count).

## State (decided at 09:30:00 ET, uses only prior VAH/VAL and today's 09:30 open O)
ABOVE: O > VAH. BELOW: O < VAL. INSIDE: otherwise.

## Outcome
y = (close of the 15:59 bar - open of the 09:30 bar) / ATR20. One value per session.

## Statistics (two counted cells, one per side; no pooled claim)
- mu = mean of y over ALL eligible days in the same block (drift is ~0: whole-sample mean y = 0.007 ATR20; no side-specific mu).
- ABOVE excess E_A = mean(y - mu) over ABOVE days. BELOW excess E_B = mean(mu - y) over BELOW days. Positive = continuation in the direction of the open's location. Per-trade mean = sum/N.
- CI: bootstrap over days (one outcome per day), 5000 iterations, fixed seed 20261028. Reported as the 95% two-sided interval; its lower endpoint is the one-sided 97.5% lower bound (Bonferroni, 2 cells, alpha 0.025 each).
- Pooled signed excess and per-side chronological-thirds sign are DESCRIPTIVE only (no pass criterion).

## Matched control (pre-open variables only; IB range is post-decision and is NOT in the primary)
- Covariates per day: gap = (O - prior RTH close)/ATR20; overnight range = (max high - min low over 18:00 prior calendar day to 09:29)/ATR20 (needs >= 500 overnight bars, else the day is excluded from the control only); prior RTH range/ATR20.
- Mahalanobis distance using the covariance of all eligible days in the block. Each state day is matched to its K = 5 nearest INSIDE days (donors, with replacement). Control excess = mean over retained state days of s*(y - mean y of its 5 donors), s = +1 ABOVE, -1 BELOW.
- Common-support trim (data-derived): drop a state day whose nearest-donor distance exceeds the 90th percentile of leave-one-out nearest-neighbour distances among INSIDE days. The retained share is reported per side and block. **If the retained share is under 50%, the control is NOT EVALUABLE** (a limit of the control, not a result about the idea).
- Control CI: joint bootstrap over days (state days and donors resampled together, matching redone each iteration, covariance and trim threshold held fixed), 2000 iterations.
- SENSITIVITY only: add IB range/ATR20 as a 4th covariate, and K = 1.
- Note: S1 is largely the gap (same-sign gap on ~95% of state days; median |gap| 0.41/0.45 vs 0.16 INSIDE). The control therefore asks "does location add anything beyond the gap".

## Census before any outcome (counts and retained shares only)
Printed first. A side with fewer than 30 eligible state days in a block is NOT EVALUATED in that block (never re-defined).

## Decision rules (frozen)
1. EXPLORE: a side has an EXPLORE SIGNAL iff its E lower endpoint (97.5% one-sided) > 0. Otherwise NOT SHOWN for that side. If NEITHER side has a signal the idea is CLOSED at explore and the hold-out is NOT opened (it stays unseen).
2. HOLD-OUT (one look, only for sides with an explore signal, enforced by a lock file): single pre-specified cell per side, one-sided 95% lower bound (5th percentile). A side is CONFIRMED ON HELD-OUT HISTORY iff E_hold lower bound > 0 AND the matched-control excess point estimate > 0 (control evaluable). It is additionally CONTROL-SUPPORTED if the control's one-sided 95% lower bound > 0. If the control is NOT EVALUABLE the side can be at most "held-out positive, control not evaluable".
3. Power is stated: the hold-out can only confirm roughly 0.16 ATR20 or more; a miss below that is "NOT CONFIRMED (underpowered for small effects)", never "no effect".
4. If the two sides disagree in sign, report an asymmetry; no pooled claim is ever made.
5. "range-mediated": if the IB-range-matched sensitivity has the opposite sign of the primary control, label "range-mediated" in the report (a label, not a verdict).

## What a result authorizes
CONFIRMED ON HELD-OUT HISTORY authorizes only (a) a frozen forward-scoring log of the same definition and (b) use as a context lens (expectation, sizing context). It does NOT authorize a trade rule, stop, target or live gate; those are separate preregs. Nothing in this study is wired live.
