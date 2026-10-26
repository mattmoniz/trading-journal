# Pre-registration: multi-touch floor at a value-area-low edge -> run to that period's POC, and ES as canary — 2026-10-26

Written BEFORE running anything. Origin: user, live, 2026-10-26 08:10 ET: price had tested the PW-VAL / 3-month-VAL area repeatedly overnight (low 29024, session range 29024..29345), expected "a pop today or tomorrow, up to the blue POC", and asked whether the system can be set up to catch the larger trade and whether ES can serve as the canary to fire and hold it. This is a market-behaviour question, so it goes through raw NQ bars first (CLAUDE.md), not through `active_setups`.

## Hypotheses
- **H1 (floor-hold):** a value-area-low edge that has been tested repeatedly and held is followed, within about two sessions, by price reaching that same period's POC more often than a first test of the same edge does.
- **H2 (ES canary):** at a repeat test, when ES made a relatively HIGHER low than NQ did versus the previous test, the move to the POC is more likely.
Not tested here: any exit/trail, any size change, anything live.

## Data (frozen)
NQ 1-minute `price_bars_primary` (`symbol='NQ'`) 2023-03-06 .. last complete date at run time (printed and reused verbatim); per-month chunked reads with explicit upper bounds. Excluded and stated: contract-roll weeks (`isInsideNqRollWeek`) and 2025-09-28..2025-11-19 (KNOWN_ISSUES #16). Levels from `level_prices`: for each family F in {PW, 3M, PM, PD, PY} the rows `F_VAL`, `F_POC`, `F_VAH`, applied to a bar by trade date (a bar at or after 18:00 ET belongs to the NEXT calendar date; use the first `level_prices` row with `trade_date >= that date`, the project's `>=`/ASC convention). ES from `price_bars_es` (front contract per `es_front_calendar`) for H2 only. The user's chart draws "PW-VAL/VAH" lines (about 29065/29195) that do NOT match our `PW_VAL/PW_VAH` (29280/30111) while his blue POC matches our `PW_POC` (29767); we test our stored levels and say so. Question to him is open.

## Scale (all data-derived, nothing fixed in points)
`A15(d)` = mean high-low range of 15-minute bars over the 20 trade days strictly before d (the chart's "15 Min ATR" analogue). Zone half-width `p = 1.0*A15`, stop distance below the level `s = 1.0*A15`; sensitivity at p in {0.5, 1, 2} and s in {0.5, 1, 2} (5 combinations: vary p with s=1, vary s with p=1).

## Events (no lookahead)
For family F with VAL < POC and price above VAL: an **episode** starts at the first 1-minute bar whose low <= VAL + p and ends when a bar's low > VAL + 2p. The **episode count k** of a start is 1 + the number of earlier episodes in the same **sequence**. A sequence is keyed by (F, VAL value) and RESETS when (a) a bar's close <= VAL - s*A15 (decisive break), (b) a bar's high >= POC (target reached), or (c) the level row's VAL value changes. Entry = fill at the OPEN of the bar after the episode start (market, realistic). Arms: `K1` (k=1), `K2`, `K3P` (k>=3). Primary arm contrast: `K3P` vs `K1`. A secondary confirmation entry (first close above VAL + 2p after an episode with k>=2) is reported separately and is not part of the pass bar.

## Outcome (one primary, two secondary)
Barrier walk from the entry bar: target = F_POC, stop = VAL - s*A15, cap = end of the second trade date after the entry date (RTH close 16:00 ET), exit at the cap by mark-to-market. Stop fills at min(stop, bar open) for a long (gap-through fills at the open); target fills at the limit. **Primary: hit rate = share reaching the POC before the stop or cap.** Secondary: mean points per trade (sum/N, never day-weighted; dollars = 2/pt minus 2 round trip) and the share of the entry-to-POC distance reached (MFE/dist, median and p80). Report time-to-target for the hits, the stop and cap shares, and the entry-to-POC distance in A15 units, so a hit rate is never read without its geometry.

## Controls
1. `K1` arm of the same family and parameters (contrast above).
2. **Gambler's-ruin placebo:** the same entry times and distances with the direction mirrored (a short at the level with the target below, stop above), 10 independent random-direction trials per cell, and the analytic driftless baseline stop/(stop+target). A hit rate of the real long must clear the placebo range, not just the K1 arm.
3. Mirror test: the VAH ceiling -> POC down version (same code mirrored) reported separately; pooled verdicts are never given without the split.
4. Entry-session split (RTH 9:30-16:00 vs Globex) for K3P, both windows required.

## Statistics
Day-blocked bootstrap (2000 draws, resample trade dates, pool trades from resampled days per arm, difference of per-trade means / of hit rates). One event per (F, sequence, arm) is kept when several fall in the same episode window. Chronological halves (by event date) must have the same sign. Cells count: primary = 1 (pooled five families, K3P minus K1, hit rate at p=1,s=1); secondary = 5 per-family + 4 sensitivity + 2 session splits + VAH mirror + H2; BH within the secondary set, stated. State counts (events per arm per family and distinct days) are printed BEFORE any outcome is looked at, and any arm with fewer than 20 distinct days is reported as underpowered, not tested.

## H2 (ES canary) definition
Only for `K2` and `K3P` events (needs a previous episode): `D = (ES_low_now - ES_low_prev)/ES_A15 - (NQ_low_now - NQ_low_prev)/NQ_A15`, where `*_low_now` is the lowest low from the previous episode's end to the entry bar (the approach into this test, causal) and `*_low_prev` the lowest low inside the previous episode. Canary-positive = D > 0 (a sign, not a fitted cutoff). Contrast = hit rate of canary-positive minus canary-negative within K2+K3P, day-blocked CI. Prior stated: the earlier pre-registered ES canary study (12 tests) showed nothing, so INCONCLUSIVE is the expected outcome; this is a narrower, setup-specific re-ask, not a rescue.

## Pass bar and wording
H1 is **SHOWN** only if all of: pooled K3P hit rate minus K1 hit rate > 0 with day-blocked CI lower bound > 0; K3P hit rate above the 97.5th percentile of its mirrored placebo; same sign in both chronological halves; and the result survives the p/s sensitivity points (same sign at all five). Otherwise **NOT SHOWN**, stated with the CI half-width (the smallest effect that could not have been detected) and what could not be shown. The user's current setup is the same shape but N=1; it is not evidence either way and is not used.

## Limits stated in advance
Few distinct days for the 3M and PY families (their levels change slowly, so a sequence spans weeks); sequences are correlated across days; the target is far (several A15 to tens of A15), so hit rates will be low and the placebo geometry matters most; ES is a single-feature canary on a thin event count; NQ roll-week/sparse-window exclusions shrink the sample.

## Records
`recordClaim()` for each of H1 and H2 (positive or negative); `flagDecision()` only for a real fork. Nothing changes live behaviour.
