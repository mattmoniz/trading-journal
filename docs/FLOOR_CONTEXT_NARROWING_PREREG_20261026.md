# Pre-registration: in which context does ES agreement / the floor entry work? (narrowing search) — 2026-10-26

Written BEFORE running anything. Origin: user, 2026-10-26, after the floor-entry study's inconclusive ES result: "If it's inconclusive then narrow the scope. Find the context where it does work. How's relative volume or overnight volume? Volatility? Something else?" Parent studies: `docs/FLOOR_ENTRY_ES_AGREEMENT_PREREG_20261026.md` (+ Amendment 1 and code-review corrections) and its recorded claims `floor_entry_nq_turn_not_worthwhile_20261026`, `floor_entry_es_agreement_lead_20261026`.

## Why this needs a stricter protocol than the parent study
Searching for a context after a null is a forking-paths search: with enough cells something always looks good. So the contexts are fixed here BEFORE looking, there are few, their cut points come from explore-period data only, and a context counts only if it is picked on the earlier 60% of dates and CONFIRMED on the later 40%. The number of cells is stated, and the expected number of false candidates by chance is printed next to the number found. Whatever survives is only licensed for a forward test (the nightly ES refresh now collects it), never for wiring.

## Events
The parent study's fired events, long floors (VAL) and the mirror short ceilings (VAH) reported SEPARATELY, all K arms pooled (the arm split is not a context here). Same fire definition (turn 0.25 A15 off the episode low, wait 50 minutes), same strata (family x NQ turn size tercile x bars-to-turn tercile), same delay-matched control, same ES read at the fire bar. Event rows come from `scratch/floor_entry_events_20261026_m0.25.json` written by the parent script (pinned: the parent's printed end date 2026-10-25).

## The contexts (all measured strictly BEFORE the entry bar; cut points = terciles from explore-period events only; nothing hand-picked)
1. **Session:** RTH (09:30-16:00 entry) vs Globex. (2 levels. The parent's descriptive split already pointed here, so it is the least independent of the four.)
2. **Relative volume at the fire:** volume of the 15 one-minute bars ending at the fire bar divided by the mean volume of the same clock window on the 20 prior trade days. (3 levels.)
3. **Session volume so far (the "overnight volume" idea, defined for both sessions):** volume from the session start (09:30 for RTH entries, 18:00 for Globex entries) to the fire bar, divided by the mean of the same elapsed window on the 20 prior trade days. For an RTH entry the user's "overnight volume" is also reported as the prior Globex session's total volume over its own 20-day mean. (3 levels each; the overnight version is descriptive only so the count of tested cells stays fixed.)
4. **Volatility regime:** the entry date's A15 (20-prior-day mean 15-minute range) ranked within the A15 values of the previous 250 trade days. (3 levels.)

## Outcomes per cell (two)
- **E2 (ES agreement):** AGREE minus DISAGREE, ret60 in A15 units, within the parent strata, strata-weighted by DISAGREE count (`strat()` logic from the parent script).
- **E1a (entry worthwhile):** fire entry minus its delay-matched control, ret60 in A15 units (mean of event minus control).

## Cell count and the selection rule
Levels: 2 + 3 + 3 + 3 = 11 per side; two outcomes; two sides (long floors, mirror ceilings): **44 cells**. For every cell: explore estimate with a sequence-blocked bootstrap CI (2000 draws, 95 percent), hold-out estimate with the same.
- **CANDIDATE** = explore CI lower bound above 0.
- **CONFIRMED** = candidate AND hold-out point estimate above 0 AND hold-out CI lower bound above 0.
- **HOLD-OUT UNDERPOWERED** = candidate whose hold-out cell has fewer than 20 distinct days or (E2) fewer than 30 DISAGREE events: reported as such, never as confirmed.
- A cell with fewer than 20 distinct days or (E2) fewer than 30 DISAGREE events in the explore half is UNDERPOWERED and not tested.
Printed alongside the table: number of cells tested, number of candidates, expected candidates by chance (tested cells x 0.025 one-sided), number confirmed, and the smallest effect each cell could have detected (CI half-width).

## Wording
A context is "worth a forward test" only if CONFIRMED on a side and consistent with the parent direction; otherwise the answer is "no context where this works could be shown", with the half-widths stated. Nothing here changes live behaviour. A confirmed context is tagged forward on the nightly ES refresh and judged after >= 20 forward days with the same frozen cut points (written to the claim), per the parent decision `es_confirming_fade_lead_needs_forward_test_20261026`.

## Limits stated in advance
Contexts are correlated with each other (session vs session-volume vs relative volume); the hold-out is 40 percent of 365-408 days, so many hold-out cells will be underpowered; DISAGREE is only about 18-28 percent of fires, so E2 cells split three ways have few DISAGREE events; the volatility regime uses only A15, not GARCH, to keep it computable for every date in the sample.
