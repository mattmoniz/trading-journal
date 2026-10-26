# Pre-registration: anatomy of the floor entries that work — structure, day of week, time of day, retest — 2026-10-26

Written BEFORE running anything. Origin: user, 2026-10-26: "What if we gated the trade... studying when it does work out and what's interesting there? Was there a visible bottom or top we could try and get in again once it's retested? Does it seem to work better at certain days of week or times of day? It works well when it does and maybe we study those trades and how to make it work and only take it then." Parents: `docs/FLOOR_ENTRY_ES_AGREEMENT_PREREG_20261026.md` (+ Amendment 1), `docs/FLOOR_CONTEXT_NARROWING_PREREG_20261026.md` (+ Amendment 1; same explore/hold-out screen, same candidate/confirmed rule, same sequence-blocked bootstrap). The volume and volatility contexts are already done (0 candidates in 20 cells, claim `floor_context_volume_volatility_none_20261026`), so this study is the REST of the user's list: calendar, price structure at the floor, retest.

## Why "study the winners" is done as winners-versus-everything on pre-listed features
Looking only at trades that worked and describing what they share always produces a story (every set of winners shares something). The same features are therefore measured on ALL fired events and the question is whether a feature level has a better outcome than the rest, picked on the earlier 60 percent of dates and checked on the later 40 percent. A descriptive anatomy table (share of each feature level among the top quartile versus the rest of ret60, explore period only) is printed to generate hypotheses, with no verdict attached.

## Events and outcome
The parent study's fired events (long floors and mirror ceilings separately, all K arms pooled, pinned end date 2026-10-25, rows from `scratch/floor_entry_events_20261026_m0.25.json`). Primary outcome per cell: **E1a**, ret60 of the NQ-fire entry minus its delay-matched blind control in A15 units (the "is the entry worthwhile" measure, which removes the entry-price/delay effect). Descriptive outcome next to it: raw ret60 minus the all-clock unconditional baseline, and MFE60/MAE60.

## Features (all known at the fire bar; every cut point from explore-period events only)
1. **Day of week** of the entry bar's calendar date, ET (Sun..Fri; Sunday means the Sunday-evening Globex open). 6 levels.
2. **Time of day** using the system's own session phases: Globex evening 18:00-23:59, overnight 00:00-09:29, RTH open 09:30-10:59, midday 11:00-13:59, afternoon 14:00-15:59. 5 levels.
3. **Visible bottom held (the retest), K>=2 only:** the lowest low of the approach into this test (from the previous episode's end to the fire-signal bar) is at or above the lowest low inside the previous episode (HIGHER-OR-EQUAL LOW) versus below it (UNDERCUT). The user's "get in again once it's retested" is this feature on repeat tests. 2 levels, K>=2 events only.
4. **Depth:** how far the episode low went through the level, (VAL - lowest low since the episode start)/A15 (mirror: the ceiling analogue). Median split.
5. **Approach drop:** (highest high in the 60 minutes before the episode start - the low of the episode-start bar)/A15, i.e. how sharp the move into the level was. Median split.
6. **Time since the previous test** (K>=2): minutes from the previous episode's end to this episode start. Median split.
Cells: 6 + 5 + 2 + 2 + 2 + 2 = **19 levels x 1 primary outcome x 2 sides = 38 counted cells**. A cell needs >= 20 distinct days in explore else it is not tested.

## Rule (as in the context study)
CANDIDATE = explore sequence-blocked CI lower bound > 0 (95 percent, one-sided alpha 0.025); CONFIRMED = candidate AND hold-out point > 0 AND hold-out CI lower bound > 0 AND explore point > 0; hold-out with < 20 distinct days is UNDERPOWERED, never confirmed. Printed: tested cells, candidates, expected candidates by chance (tested x 0.025), confirmed, and each cell's CI half-width. Calendar cells (day of week, time of day) are the most correlated with the system's session phases and the parent's Globex lead, so they are reported and counted but flagged "calendar".

## Wording and next step
A feature level counts as "worth a forward test" only if CONFIRMED on a side with the same sign on the other side or a stated reason it should not; the forward test uses the nightly ES refresh and tags (no gating). The re-entry idea beyond the retest feature (a second entry after the first bounce, with its own stop) needs a bar-by-bar trade simulation with realistic fills and a placebo and is not part of this study; it is only worth building if feature 3 confirms.

## Limits stated in advance
The same data as the parents (no true hold-out; the 40 percent is a screen); events are correlated within a floor sequence and across contexts; day-of-week cells will have 40-130 events each; hold-out power is low; the structure features were chosen from the user's description after seeing the parent null, so they are a stated forking path with 38 cells, not a pre-parent hypothesis.
