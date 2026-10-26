# Pre-registration: one volume-vs-normal cut on four-hour defended levels — 2026-10-26 (P3 of the handoff)

Written BEFORE running anything. Origin: the user named volume vs normal as the ONE metric ("I do not want 10 metrics"). An exploratory look (`four_hour_relvol_exploratory_lead_20261026`) saw Spearman +0.121 between relative volume at the defended bars and the +1,440-minute excess, found incidentally in a smoke test run on real outcomes, so it is a lead, not a result. This study asks the single question once, with the cut fixed here.

## What is disclosed up front (it limits what this can show)
- The events (first K>=3 four-hour level per level, floors long, tops short, band 0.25 x H4) and their outcomes were already examined in four earlier studies today. The explore/hold-out split below is therefore a SCREEN on spent history, not a clean out-of-sample test. The only clean test is forward data from 2026-10-27; a forward look is scheduled (below).
- The cut value was not tuned on outcomes, but the median of relative volume in a random-label sample was seen in the smoke test (about 1.05x). The cut here is recomputed from explore-period events' relative volume only (no outcome used), and I print both so the reader can see they agree.
- Expected result: few events per cell (about 150 floors and 275 tops in total before the split), so a HEAVY-vs-LIGHT contrast has a smallest detectable effect of several tenths of D20. "Underpowered / not shown" is the likely outcome and will be reported as exactly that.

## Definitions (all reused code: `scripts/lib/fourHourLevels.mjs`, `exitSim.mjs`)
- Population: `firstK3Events()` at band 0.25 x H4, floors (long) and tops (short), NQ 1-minute bars 2023-03-06 .. last complete date minus 3, sampler pinned to that end date (`pinnedLimit`), roll weeks / 2025-09-28..11-19 / bars under 60 minutes excluded as before. Events need a +1,439-minute exit bar (`strictOK`).
- Relative volume `relVol` = mean over the defended bars of (bar volume / mean volume of the same session-slot four-hour bar over the 20 prior trade days), as built by `build4h`; events with no `relVol` are dropped and counted.
- THE CUT: HEAVY = `relVol` strictly above the median `relVol` of EXPLORE events of that side (floors and tops get their own median, no outcome data used); LIGHT = at or below it. Explore = earlier 60 percent of event dates (by the same rule as the moonshot study); explore events whose 1,440-minute window crosses the cut date are dropped from both screens (counted).
- Outcomes (both in D20 units for exit-free, points for exit M), each as EXCESS over the clock-matched blind same-direction entry (30 draws, own-partition controls, as in the moonshot study):
  - **X** exit-free, direction-signed return from the next open to +1,439 minutes, in D20 units.
  - **M** the moonshot exit (stop 0.5 x D20, no target, hold 1,440 minutes, realistic gap-through fills, cost 1.5 points), in points.

## Counted cells = 4
{FLOOR long, TOP short} x {X, M}. The statistic is the HEAVY-minus-LIGHT difference in mean EXCESS (two-sample, dates resampled within each arm, `diffCI`). CANDIDATE = explore difference with 98.75 percent CI (Bonferroni over 4) lower bound above 0. SCREEN-SURVIVOR = candidate AND hold-out difference above 0 with its single 95 percent CI lower bound above 0, AND the explore difference still above 0 after removing its top date. UNDERPOWERED = fewer than 15 events in either arm or fewer than 15 distinct dates in either arm (stated per cell; the arms are small by construction).
Printed per cell and per arm: n, distinct dates, mean and median excess, HEAVY and LIGHT absolute P&L, the smallest detectable effect (CI half-width), the cut value, the K=3/4+ and session mix of the two arms (a volume split that is really a session split is read off that).

## Descriptive only (not counted, never a verdict)
Spearman and the OLS slope of excess on `relVol` (all dates, per side, and with the session as a stratum: RTH and Globex events separately, since relative volume is already slot-normalized but arms may still differ in session mix); the lead's second condition (DROP into the level, in D20) is NOT used and not tested.

## Forward look (the real test)
One look at the HEAVY-minus-LIGHT difference on events dated on or after 2026-10-27, with the cut value frozen from this study's printed explore median, on or after 2026-12-15 (same date as the other forward looks), reporting whatever the count. No intermediate reports. Recorded as an OPEN_DECISION.

## Limits stated in advance
The history is spent (see above); few independent levels with overlapping windows (overlap share printed); date-blocked intervals only reflect between-date variability; relative volume depends on the 20-day same-slot baseline and on session alignment assumed to start at 18:00 ET; a null here says a heavy-versus-light split of defended levels could not be shown on this size of sample, not that volume does not matter at a level.

---
## Amendment 1 (2026-10-26, before the run) — DeepSeek review (`reports/deepseek_volume_cut_prereg_review_2026-10-26_raw.md`, answer is the text before the first `[thinking]`)
1. **The in-sample screen is a hypothesis, not a verdict (finding 1).** CANDIDATE / SCREEN-SURVIVOR labels stay as printed but are reported as "screen result"; the 2026-12-15 forward look is the sole confirmatory test.
2. **Power floors raised (finding 2).** UNDERPOWERED = fewer than 30 events or 20 distinct dates in either arm (matches the moonshot study). Most explore cells are expected to be underpowered; the all-dates difference with its CI half-width (the smallest detectable effect) is printed for every cell regardless and is the number a reader should use. Cells below the floor are labelled "descriptive".
3. **Confound control (finding 3).** Added printed: the HEAVY-minus-LIGHT difference stratified by session (RTH/Globex) x D20 tercile (weighted within-stratum difference, strata with at least 2 events per arm, date-blocked bootstrap CI), and a flag "SESSION-MIX ARTIFACT" when the arms' RTH shares differ by more than 15 percentage points. A cell whose unadjusted difference clears zero but whose adjusted difference does not is labelled "confounded".
4. **Overlap (finding 4).** Events are one per level already; the effective independent count (greedy non-overlapping 1,440-minute windows per side) is printed next to raw n.
5. **Leakage and outliers (finding 5).** `relVol` is built from defended bars up to and including the confirming bar (all pre-entry, checked in `runLevels`); `build4h` already requires at least 10 baseline days. The cut and the arms use ranks and a median, so outliers do not move them; the descriptive slope winsorizes `relVol` at its 1st/99th percentiles.
6. **Direction (finding 6).** X: the hypothesis is HEAVY better (from the exploratory lead), screened one-sided on the lower bound. M: no sign is assumed (heavy volume could raise stop-outs); the 98.75 percent CI is two-sided and "HEAVY WORSE (screen)" is printed when its upper bound is below zero.
7. **Multiplicity (finding 7).** Bonferroni over 4 is kept (conservative; X and M are the same move, so power is lost deliberately); raw intervals are printed too. Nothing is promoted by this study either way.
8. **Cut sensitivity (finding 8).** Printed, never counted: the same contrasts for the top third versus bottom third of explore `relVol`.
