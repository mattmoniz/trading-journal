# Pre-registration: ways to get out of the tell trade with profit (targets) (written 2026-11-01 BEFORE any outcome)

Origin: the trader (2026-11-01): "we dont have targets ... im not sure how to approach getting out of a trade with profit." The tested tell trade (V1, the rule Stage 2 runs) has no target by design: stop at the second LVN, tell-fade exit after the range breaks, 120-minute no-break exit, 15:55 flatten. A first descriptive look (`amt_tell_targets_and_stop_cap_descriptive_20261028`, in-sample, not pre-registered) found fixed R-multiple targets lowered the average at every multiple and that the edge sits in a thin wide-stop tail. This is the pre-registered version with STRUCTURAL targets. Research only: Stage 2 keeps running unchanged. Explore only (the 1,760 research V1 tell fires, 516 sessions to 2025-05-16; the sealed AMT-tell hold-out is not extracted). Script `run_profit_exits.py`, one run.

## Engine (one engine for every arm, so comparisons are like-for-like)
Same entries as the research trade (market at the next open plus one tick adverse) and the same node stop distance. Exits in the simple engine: the stop, the target (variants below), the time exit (120 minutes unless a variant says otherwise), the 15:55 open; gaps fill at the open (a stop gap adverse, a target gap favourable); a limit target fills at its price only when the bar trades ONE TICK THROUGH it (a bare touch does not fill); a bar that reaches both the stop and the target counts as the STOP (worst case). $2 per point, $2 round trip, no stop moving (the exit audit closed those ideas). The V1 tell-fade exit is not in the simple engine; the actual V1 result is printed as a reference only.
Variants (the only ones tried; every level data-derived, none static):
- NONE: no target (the simple-engine baseline all others are paired against).
- T1 STRUCTURAL EDGE: the nearest of the overnight high/low and, once complete, the IB high/low that lies beyond the entry in the trade direction (the trader's "IB high" idea); no level ahead = no target for that fire (counted).
- T2 NEXT NODE: the near edge of the next volume node ahead of the entry on the day profile at the signal bar (`vbars.nodes_of`, prefix-safe); none ahead = no target.
- T3 TIME: market exit W minutes after entry, W in {15, 30, 60} (the expansion windows), the stop and the flatten still live.
A two-lot half-off-and-runner is NOT tested: the trader trades one MNQ.

## Controls
PLACEBO: random direction per fire with the SAME stop distance and, where the variant has a target, the SAME target distance as the tell direction (an asymmetric stop/target pair produces a win rate with no skill, the gambler's-ruin trap), 40 draws, seeded; its 95th percentile of the mean is the bar a variant's tell result must exceed. Targets are also reported against NONE paired on the same fires.

## Statistics
Per-trade means (sum / N), per-variant WR, share of exits at the target, at the stop, by time; day-blocked bootstrap CIs (2000 draws, seeded) for the absolute mean and for the paired difference to NONE; chronological halves. Counts first (fires with a target for T1 and T2).

## Reading rule (stated before the run; absolute dollars)
A variant "gets out with profit" only if ALL hold: absolute mean > 0 with the day-blocked CI lower bound > 0; paired improvement over NONE > 0 with the CI excluding zero; mean above the placebo p95; same sign of the paired improvement in both halves. Five variants are tested: one pass is a LEAD for one frozen sealed look, not a result; a positive paired improvement with a negative absolute mean is NOT a rule. Resolution (CI half-widths) reported either way.

## Not tested
Trails and breakeven moves (closed by the exit audit), partial exits (one contract), targets from the tell's own tell-fade logic beyond V1, Globex, the sub-bar order of fills (500-volume bars have no intrabar order; the both-touched rule is the conservative resolution), any change to the live Stage 2 exit.
