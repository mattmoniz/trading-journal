# Pre-registration: post-selloff balance-then-thrust (4h state, drill-in to the gate) — 2026-10-20

Written and committed BEFORE any outcome in this test is computed. Origin: user observation 2026-10-20 ("when the market falls it drops quick, then a couple of days of balance, then thrusts back up; that might impede the POC gate"; example: overnight low swept to 29391.75, then +500pt). `OPEN_DECISION post_selloff_balance_then_thrust_vs_poc_gate_20261020`.

## Questions
- H1 (market behaviour, PRIMARY, the only confirmatory test of the market claim): after a fast selloff, is there a later window where price thrusts up by more than it normally does?
- H2 (secondary): inside that window, is the rotation-direction gate's AGREE-minus-DISAGREE gap (3.5y RTH level-fade replay) different from outside it?
- H3, H4: descriptive only (no verdict): failed-sweep-reversal real rows by phase; one thrust leg vs many 65pt rotations inside the window.

## Data
NQ 1-minute bars `price_bars_primary`, 2023-03-06 .. 2026-10-16 (continuous intraday from 2023-03; earlier months are placeholders and are excluded). Quarterly roll weeks (`isInsideNqRollWeek`) are dropped from state and outcome windows; any window touching one is skipped. 4-hour bars anchored at 18:00 ET: [18,22) [22,02) [02,06) [06,10) [10,14) [14,17). ATR20 = mean RTH range of the 20 prior sessions (`sessionIndex().atr20`), as in the other 2026-10-20 studies. All quantities in ATR20 units. Realistic-fill rule is not needed (no trades are simulated in H1).

## State definition (point in time, closed 4h bars only)
- DROP(t) = (highest high of the trailing 12 four-hour bars - close(t)) / ATR20.
- Selloff ON at bar t when DROP(t) >= the 90th percentile of DROP over the previous 250 sessions of 4h bars (rolling, walk-forward; no fixed number).
- Episode low L = lowest low since the selloff turned on; every new lower low resets the episode clock c to 0. c = number of 4h bars since the episode low was set. The episode ends (expires) at c > 41.
- Phases by c (from the user's description, ~6 bars per day): FRESH c 0-5, BALANCE c 6-17, THRUST WINDOW c 18-41. Bars outside any episode are CONTROL.

## H1 test (primary)
- For each 4h bar close t: R(t) = (close(t+6) - close(t)) / ATR20 (about one day forward net return); U(t) = (max high over t+1..t+6 - close(t)) / ATR20; D(t) = (close(t) - min low over t+1..t+6) / ATR20; NET(t) = U - D.
- Statistic: mean R and mean NET in THRUST WINDOW minus the same in CONTROL. Cluster = episode (all bars of one episode are one cluster; resample episodes with replacement for the CI, 2000 draws), and the control is resampled by session date. Report N episodes and N bars.
- Placebo: 200 draws that move every episode's low time by a random offset of 20-120 sessions (keeping its clock and phase lengths), recompute the statistic. Real must exceed the 95th percentile of placebo.
- Split: explore 2023-03-06..2025-05-31, hold-out 2025-06-01..2026-10-16. The hold-out is evaluated once, with the rule exactly as written here.
- SUPPORTED only if all hold: (i) pooled bootstrap CI of mean R difference excludes zero AND of mean NET difference excludes zero; (ii) real > placebo 95th percentile; (iii) both halves have the same sign and the hold-out point estimate is at least half the explore estimate; (iv) the effect does not vanish when the best episode is removed. Otherwise NOT SUPPORTED, recorded as is.
- Sensitivity (reported, never used to pick a winner): phase boundaries shifted by -6 and +6 bars, selloff percentile 85 and 95, forward horizon 3 and 12 bars.
- Also report the same statistic for FRESH and BALANCE (is the "balance then thrust" order visible, or is it the whole post-low period that is up?).

## H2 (drill-in, secondary)
Join `scratch/rotation_gate_replay_rows_20261020.json` (RTH level-fade touches, AGREE/DISAGREE, realistic fills, direction) to the phase of the last closed 4h bar before each touch. Per-trade mean (sum/N, not day-weighted) AGREE minus DISAGREE inside THRUST WINDOW vs outside; day-blocked bootstrap CI of the difference of differences (resample days). Also LONG minus SHORT mean inside the window, ignoring the gate. Verdict rule: a difference counts only if its CI excludes zero and the sign matches in both halves; else recorded as inconclusive. No live change from H2.

## H3 / H4 (descriptive)
H3: real FAILED_SWEEP_REVERSAL rows (origin ACTIVE/SHADOW, primary, actual_pnl not null) listed by phase at fire time with counts and means. No verdict (tiny N). H4: for THRUST WINDOW bars vs CONTROL, count of 65pt rotation legs (`detectRotationLegs`) per session and the size of the largest up leg.

## Independence
Claude builds it and Gemini builds H1 and H2 independently from this document alone (not shown Claude's code). Disagreement between the builds is the signal; resolve by reading both before any number is recorded.

## Non-goals / rules
No trade rule is proposed or wired from this test. A SUPPORTED H1 only licenses a follow-up pre-registered trade-level test. All outcomes recorded via `recordClaim()` whatever the result.
