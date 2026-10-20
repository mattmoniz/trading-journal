# Pre-registration: sweep-and-reclaim, scale-free redo (RTH + Globex) — 2026-10-20

Written and committed BEFORE any outcome of this design is computed. Replaces the fixed-cutoff design of `SWEEP_RECLAIM_MINUTE_PREREG_20261020.md` (null at poke scale only; DeepSeek: the median-depth threshold diluted the real-sweep case; the user: counterpunch timing and size vary, so fixed numbers are myopic). Market-behaviour test on 1-minute bars, no trades simulated, nothing wired.

## What is no longer fixed
- No depth number: depth is a point-in-time PERCENTILE RANK against that level family's own prior penetration depths (walk-forward, all earlier sessions; at least 60 prior events or the event is skipped as warm-up). Results are reported across rank bands and as a continuous gradient, never at a single picked cut.
- No reclaim window: the reclaim is the first 1-minute close back through the level at any later time in the same session (time-to-reclaim is itself reported as a distribution: median, quartiles, share that never reclaim, by rank band).
- No fixed forward horizon and no ATR target: the outcome is a symmetric race scaled by the sweep's OWN depth: after the reclaim close E, which comes first within the rest of the session, E + q*depthPts or E - q*depthPts (q = 2 primary; 1 and 3 reported). Both in one bar = "both" (neither, share reported). Unresolved by session end = neither.

## Data and events
NQ 1-minute `price_bars_primary` 2023-03-06..2026-10-16, roll-week sessions dropped, ATR20 as before (used only for the placebo shift size). RTH arm: ONL, PDL, IBL and mirrored highs, first penetration 09:35..13:30 (IB levels after 10:30), previous bar closed on the original side. Globex arm (exploratory scope, reported separately): prior-day RTH low/high, first penetration 18:30..09:25, session ends 09:30. One event per level per session; the decision time is the reclaim close.

## Primary test H1 (RTH, lows, long)
Events = RTH low-level penetrations that reclaim and whose depth rank is in the top band (rank >= 0.8, i.e. the deepest fifth of that level's own history). Statistic S = (share of races won - share lost) at q = 2.
- Placebo: 200 draws shifting every level by +-(0.25..1.0) ATR20 and rerunning the identical detection, using the REAL trailing depth distribution of the family to compute ranks; the real S must exceed the 95th percentile of the placebo S values.
- Day-blocked bootstrap CI of S (resample sessions), explore 2023-03-06..2025-05-31 / hold-out 2025-06-01..2026-10-16.
- SUPPORTED only if: (i) S CI lower bound > 0; (ii) S beats the placebo 95th percentile; (iii) S positive in both halves with hold-out >= half of explore; (iv) S positive after removing the 5 best sessions; (v) the mirrored high-sweep events have S > 0; (vi) S > 0 at q = 1 and q = 3. Otherwise NOT SUPPORTED, stated as what could not be shown.

## Reported alongside (no verdict beyond sign and CI)
Share that reclaim, and time to reclaim, by rank band ([0,.5), [.5,.8), [.8,1]); S by rank band; Spearman correlation of depth rank with the race score over all reclaim events (is deeper better, with no cut at all); by level family; the Globex arm with the same statistics; the real FAILED_SWEEP_REVERSAL_LONG fires coinciding with a top-band reclaim event (descriptive).

## Rules
Claude builds, DeepSeek reviews the code before the verdict is final. Record via `recordClaim()` whatever the result, phrased as what was and was not shown. A SUPPORTED result licenses only a pre-registered trade-level test with realistic fills; no live change.
