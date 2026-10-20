# Pre-registration: 1-minute sweep-and-reclaim of a defended low (and the mirrored high) — 2026-10-20

Written and committed BEFORE any outcome is computed. Origin: user chart story 2026-10-20 (overnight low 29510 swept to 29391.75, reclaimed within minutes, then +500pt) and the failed-sweep-reversal long that caught it. The 4h state test (`POST_SELLOFF_THRUST_PREREG_20261020.md`) was null and cannot see this structure. `OPEN_DECISION sweep_reclaim_minute_scale_test_20261020`. Market-behaviour test on bars; no trades are simulated, nothing is wired.

## Question
After price first pushes through a defended level during RTH and then closes back through it within a few minutes (a "reclaim"), is the forward move in the reversal direction larger than (a) what the same time of day does anyway, (b) what a placebo level does, and (c) what a sweep that does NOT reclaim does?

## Data
NQ 1-minute `price_bars_primary`, 2023-03-06..2026-10-16, ET naive strings, roll-week sessions excluded (`isInsideNqRollWeek`). ATR20 = mean RTH range of the 20 prior sessions (`sessionIndex().atr20`). All distances in ATR20 units. RTH only (09:30-16:00); Globex untested here and flagged as a follow-up per the RTH+Globex rule.

## Levels (point in time, all known before the event)
Lows: ONL = lowest low 18:00 previous evening..09:29; PDL = previous RTH session low; IBL = lowest low 09:30..10:29 (usable only after 10:30). Highs (mirror): ONH, PDH, IBH likewise.

## Event (one per level per session)
- First penetration: a 1-min bar whose low is below the level (high above it for the mirror), where the previous bar's close was on the original side (no gap-through starts), start time 09:35..13:30 (09:30-09:34 is the RTH-open dead zone; 13:30 so +120 min stays inside RTH). IB levels start after 10:30.
- Depth(t) = deepest penetration so far, in ATR20.
- RECLAIM (primary M = 15): a 1-min CLOSE back on the original side within M minutes of the first penetration. Decision time t_d = that close. NO_RECLAIM: no such close within M minutes; decision time t_d = first-penetration + M, at which point price is still beyond the level. Only information up to t_d is used to classify.
- Qualifying sweep: Depth(t_d) >= the median depth of all first penetrations in the explore half (derived from data, then frozen).
- Direction dir = +1 (long) for low sweeps, -1 for high sweeps.

## Outcomes (from the close at t_d)
R(k) = dir * (C[t_d + k] - C[t_d]) / ATR20 for k = 30, 60, 120 minutes (session-end clipped events are excluded). Drift adjustment: subtract the mean of dir * (C[t + k] - C[t]) / ATR20 over all minutes in the same 30-minute time-of-day bucket across all non-roll sessions (so a long is compared with the plain long drift at that hour). adjR = R minus that.

## Primary test H1
Mean adjR(120) of qualifying RECLAIM LOW-sweep events (long), pooled across ONL/PDL/IBL, day-blocked bootstrap CI (resample sessions, per-event mean = sum/N), 2000 draws.
- Placebo: 200 draws that shift every level by a random amount of +-(0.25..1.0) ATR20 (sign random), rerun the same event definition and depth threshold on the same sessions; the real mean adjR(120) must exceed the 95th percentile of the placebo means.
- Split: explore 2023-03-06..2025-05-31, hold-out 2025-06-01..2026-10-16; the depth threshold comes from explore only.
- SUPPORTED only if all hold: (i) CI lower bound > 0; (ii) beats placebo 95th percentile; (iii) same positive sign in both halves with hold-out mean >= half the explore mean; (iv) total stays positive after removing the 5 best sessions; (v) the mirrored HIGH-sweep RECLAIM events (short) have a positive point estimate too (if only the long side works it is probably drift, report it as such). Otherwise NOT SUPPORTED, recorded as is.

## Secondary (reported, no verdicts beyond sign + CI)
- H2: RECLAIM minus NO_RECLAIM on adjR(120) per side.
- Splits by level family (ONL, PDL, IBL) and by time of day (before/after 11:00) — pooled is a question, not an answer.
- Sensitivity, never used to pick a winner: M = 5 and 30; k = 60 and 240 where session allows; depth threshold p25 and p75.
- Descriptive link: list the real FAILED_SWEEP_REVERSAL_LONG fires and say whether each coincides (same session, within 20 minutes) with a qualifying RECLAIM event.

## Independence and rules
Claude builds; DeepSeek reviews the code against this document before the verdict is final (Gemini is Flash-tier now and unreliable). A SUPPORTED result licenses only a pre-registered trade-level test with realistic fills; no live change. Record via `recordClaim()` whatever the result.
