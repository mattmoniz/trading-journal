# Widened push: the exhaustion rule with looser push thresholds (frozen 2026-10-28)

Committed BEFORE any outcome of this variant is read. User decision: "widen the push". `PREREG.md` governs everything UNCHANGED: the exhaustion definition (leading-side aggressive volume over the last 3 bars at or below the 25th percentile of its own earlier push), the counter-side response (>= 2 counter-delta bars, counter volume in control, close beyond the extreme bar's opposite end, within 5 bars), E2 as the one counted cell, E1 / C2 / NR as controls, the random-entry placebo (100 trials), the MGI sham-level interaction, the geometry stage (stop 1 tick + 0.5 x ATR14 beyond the extreme, target 50% retracement, 30-bar time stop, flatten 15:55), costs (1 MNQ, 1 tick slippage, $2 round trip), the explore sessions (509 with a 20-session trailing history, to 2025-05-16), hold-outs sealed, RTH only.

## The one change
PUSH requires |net move| >= the trailing **80th** percentile (was 90th) and efficiency ratio >= the trailing **60th** percentile (was 75th), at the same clock bar +/- 15 over the prior 20 sessions. The census (outcome-free, already printed): 585 exhaustion signals, 229 with a counter-side response (186 days; morning 116, midday 60, afternoon 53), above the 150-event floor.

## Honest framing
This is a FORK on data whose strict version has already been read (E2 not shown, N=127, CI -7.11..+7.12). The setting was fixed from the census counts alone (the smallest widening that clears the 150 floor), not from outcomes. A wider push admits smaller and less one-directional moves, so more events may mean less "real" exhaustion. A lead found here is still generated on explore and can only be confirmed on a sealed hold-out, which needs the user's approval. A looser setting (70th percentile move, 50th efficiency: 309 events) is reported as a descriptive sensitivity only, never selected.

## Reading (frozen, unchanged)
E2 is "a lead" only if its gross mean F_15 has a day-blocked CI lower bound > 0, it beats the random-entry placebo p95, and E2 minus C2 and E2 minus NR each have CI lower bounds > 0. Net profitability: net F_15 and the geometry stage with its placebo. Otherwise not shown, never "no effect".
