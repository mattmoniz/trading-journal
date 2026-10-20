# Pre-registration: POC_ROTATION_JOIN "low-density entry" rule (written 2026-10-20 BEFORE the hold-out was examined)

Origin: user 2026-10-20 asked for the FULL volume profile (not just the value area) of the prior 1/3/5 sessions and for the confluence of those POCs with the join's own 65pt-rotation POC. Exploration used ONLY trade dates < 2025-01-01 (1,521 joins; `scripts/study_poc_join_profile_confluence_20261020.mjs`, 22 features x 3 terciles, with shifted-profile placebos). The hold-out (trade dates 2025-01-01..2026-10-16, 2,402 joins) was computed and saved but never printed or examined. The one pattern that was consistent across the 1-, 3- and 5-session profiles and across two related measures (density at the entry price, density behind the entry) was: joins that ENTER at a price with LOW prior volume (a low-volume node / air) did better than joins entering at heavy-volume nodes. This rule tests exactly that, once, on the hold-out. Other exploration leads (POC-confluence stack, 24h-median distance to POC) are NOT tested here (their placebos did not separate and they point in conflicting directions across windows).

## The single rule
PASS if `dens3 <= 0.3392`, where:
- Composite profile = `computeProfile(bars)` (server/services/developingValueService.js) over the 1-minute RTH bars (09:30-15:59) of the 3 most recent RTH sessions strictly BEFORE the event's trade date (a session counts if it has >= 300 RTH bars).
- `density(entry)` = the volume of the profile's 0.25-point price level at the entry price (the profile `entries` array; 0 if that level has no volume; the match is the level within 0.125 of the entry).
- `meanDens` = total profile volume / number of 0.25-point levels spanning [lowest profile level, highest profile level] = totalVol / max(1, (maxPrice - minPrice)/0.25 + 1).
- `dens3` = density(entry) / meanDens. The cut 0.3392 is the 33.3rd percentile of dens3 in the EXPLORATION half; it is fixed here and must not be re-derived on the hold-out.
Events: the real `detectSignalEvents` construction (65pt, standard, point-in-time THETA), entry = open of the bar after the trigger bar, 2023-03-06..2026-10-16, roll weeks excluded, joins need a 3-session profile and ATR20.

## Outcome and comparisons (hold-out = trade dates >= 2025-01-01 only)
Outcome = realistic-fill live exit E1 (100pt stop, breakeven from forward bar 60, hold to next event or 24h, stop beyond the market fills at the bar open; $2/pt, $2 round trip). Day-blocked bootstrap, 2000 resamples, per-trade mean = sum/N.
- Primary: mean E1 of PASSING hold-out joins minus mean of ALL hold-out joins, overall and in each hold-out half (2025, 2026).
- Tail: P(pnl >= +100) passing vs all; top-5 events' share of the passing set's total P&L.
- Placebo 1: same entries with direction flipped. Placebo 2: recompute dens3 with the profile shifted by -0.6, -0.3, +0.3, +0.6 x ATR20 (equivalently the entry price shifted the other way), apply the SAME cut, pool the four shifted passing populations; real passing mean minus shifted passing mean with a day-blocked CI.

## Pass criteria (ALL must hold; else the conclusion is "low-density entries do not identify better POC joins")
1. N passing >= 100 overall and >= 40 in each hold-out half.
2. Passing-minus-all > 0 with the overall day-blocked 95% CI excluding zero, and > 0 in both hold-out halves.
3. Real minus shifted-profile placebo: CI excludes zero.
4. Passing mean beats the flipped-direction placebo overall and in both halves.
5. Top-5 share of the passing set's total P&L < 50 percent.
6. P(pnl >= +100) of passing > all.
If it passes: next step is a SHADOW tag only plus a forward recheck on new sessions; never a live gate. Independent Gemini build from this file alone; any disagreement is traced before reporting.
