# Pre-registration: reading the Volume by Price histogram — breakout with volume building outside a node, and prior value-area re-entry — 2026-10-27

Written BEFORE any event or outcome of these tests has been computed or seen. Counts of events are not known yet and will be printed before any outcome is read.

## Origin
The user (2026-10-27): "start testing volume by price and delta by price to show if volume is building at price. And we should hang on to a trade or engage in a trade or fade current move", then "by looking at vbp" (how to know when to buy, sell, bail, engage or hold from the Volume by Price histogram alone). The practitioner reading (none of it verified by us): fat bars (high-volume nodes) mean acceptance and chop; thin bars mean price passes quickly to the next fat node; a breakout is real only if volume then builds outside the old node (a new fat bar forms) and fails if price pokes out over thin bars and slides back; bail when price re-enters the node it left; and the prior-value-area re-entry version (price re-enters the prior day's value area and stays two 30-minute periods, then tends to travel to the other side). Design: DeepSeek, `reports/deepseek_vbp_acceptance_test_design_2026-10-27_raw.md` (off-peak run 14:47 ET); its design is the base, with the corrections in "What I changed" below, each checked against its own text.

## Honest limits (stated before the run)
The history is spent (every earlier study used these bars), so everything here is an explore screen and only dates after 2026-10-27 can confirm. The node, "building" and "acceptance" definitions are mine, built from Sierra's documented peak/valley rule (N=3 is my assumption; the user's own sensitivity setting is unknown) and from DeepSeek's design, not the user's own words. Two constants are chosen, not derived, and are frozen with no tuning: the minimum profile age of 4 completed 30-minute cells, and the two-cell "stays" rule. A null here tests this definition, not the user's discretion or other profile reads (delta, imbalances, shape).

## What I changed from DeepSeek's design (and why)
1. **"Volume builds outside" as DeepSeek wrote it is mechanical.** The strip beyond the exit edge only holds volume if price kept trading there, and the exit cell's own strip is small because price just arrived, so "rising" is nearly guaranteed and the BUILDING arm is the arm where price had already moved further before entry. Replaced by an outside DENSITY (volume per occupied price bin outside the edge, relative to the profile so far), plus a stratified comparison on how far beyond the edge the cell closed, so distance cannot carry the result.
2. **"Failed breakout" cannot be an arm.** DeepSeek defined it as "close back inside within 2 cells", which is outcome information. It is a descriptive outcome, not a classifier.
3. **Value-area re-entry as written omits the opening condition the classic rule has**: the session opens OUTSIDE the prior value area. Added as part of the event.
4. **The prior value area must come from real tick volume, not the stored `PD_VAH`/`PD_VAL`** (those spread bar volume over high-low and carried repaired-row issues). Use `tickVolumeProfile.js` `getPeriodProfile` on the prior trade date, session `rth` for the RTH arm.
5. **Its power numbers (2,000 to 4,000 events, a 0.15 to 0.2 SD floor) were estimates, not computed.** Not cited; counts are printed first and the resolution is stated from the date-blocked bootstrap after counting.
6. **Percentile and "two closes" constants are declared chosen, not data-derived**, and listed in the limits above rather than presented as derived.

## Common frame
NQ only first. Trade-date convention (18:00 ET to 17:00 ET); roll weeks, the sparse window 2025-09-28 to 2025-11-19 and half-days excluded; data pinned to `STUDY_END=2026-10-23` for every query and every script in this thread. Cells: `volume_at_price_30m` (completed cells only: a cell starting at T is usable from T+30 minutes). Bins `0.1 x H4` rounded to 0.25, H4 = mean four-hour bar range of the 20 prior trade days. RTH (09:30 to 16:00 ET) and Globex are separate arms with separate profiles (an RTH profile uses RTH cells only; a Globex profile uses cells since 18:00). Up-breakouts and down-breakouts are reported separately and pooled signed (continuation positive). Explore = earlier 60 percent of event dates, hold-out = later 40 percent; a screen only.

## Test A: breakout from a node, volume building outside versus thin pass-through
- **Profile and node:** developing session profile from completed cells, at least 4 completed cells old. Fat node = Sierra peak (volume greater than each of the N=3 bins above and below, session extremes excluded). Edge = the contiguous bins around the peak out to the first bin whose volume is at or below the median of the profile's non-empty bins; nodes narrower than 3 bins are dropped.
- **Event:** a completed 30-minute cell closes beyond a node's edge after the previous completed cell closed inside the edge or at it. One event per node per direction per session. Decision at that cell's close; entry at the next 1-minute open; signed forward move in H4 units at 60 minutes (primary) and 240 minutes (sensitivity). No stop, target or trade in this screen.
- **BUILDING measure (decision-time only):** outside density = mean volume per occupied 0.25 price outside the edge within that cell, divided by the median volume per non-empty bin of the profile through the previous cell. HIGH = top tercile of the pooled events' density, LOW = bottom tercile (the tercile cut-offs use an outcome-free quantity, per the checklist's convention). Distance strata = terciles of how far the cell closed beyond the edge in H4 units.
- **Primary statistic (one):** HIGH minus LOW mean signed 60-minute move, averaged over the distance strata weighted by event count, day-blocked bootstrap; one-sided lower bound at 97.5 percent (Bonferroni over the 2 counted cells: RTH, Globex) must exceed 0. Per-trade means as sum over N for each arm (the day-weighting rule), day-blocking only for the interval.
- **Secondary (not counted):** HIGH arm excess over blind same-clock same-direction entries (30 draws from other dates); mirrored direction; share of events that re-enter the node within 2 cells by arm (descriptive, outcome); the node peak's overlap with named POC/VA lines (share within `0.5 x H4`) so a node result is not a re-labelled POC result.
- **NOT SHOWN:** the primary lower bound does not exceed 0 in a counted cell, or the HIGH arm does not beat blind entries; stated with the resolution reached.

## Test B: prior value-area re-entry, travel to the other side
- **Value area:** prior trade date's real tick-volume value area (`getPeriodProfile`, session `rth`, 70 percent rule of the shared code); RTH arm: the session's 09:30 open is outside it (above VAH or below VAL). Globex arm: the 18:00 open is outside the prior RTH value area.
- **Event:** a completed 30-minute cell closes back inside the value area, and the next completed cell also closes inside. One event per session. Decision at the second cell's close; entry at the next open toward the far boundary.
- **Outcome:** the far boundary is reached before the session ends (RTH 15:59, Globex 09:29); also the signed move in H4 units at 60 minutes. Control: blind same-clock entries on other dates toward a target at the same distance in H4 units (matched geometry); mirrored target.
- **Primary statistic (one):** reach rate of the far boundary minus the matched blind reach rate, day-blocked 97.5 percent one-sided lower bound above 0 (2 counted cells: RTH, Globex).
- **NOT SHOWN:** lower bound not above 0 in a counted cell. This test is expected to be the thinner one; event counts are printed first and an arm with fewer than 30 events or 20 dates is called UNDERPOWERED, not negative.

## Deferred
Test C (fade at a node edge toward the middle) overlaps the already-tested defended-floor and POC fade population; it is not run until A and B are read. ES corroboration runs only if an NQ cell passes its screen, with the identical rule on ES tick profiles.

## Forward look
The same rules on events dated 2026-10-28 or later, one look at 200 events per session arm or 2027-04-01, whichever is first. No reaction between looks.

## Order of work
1. Build the loader for completed-cell developing profiles and the event lists; print event counts and arm sizes per session. 2. Freeze this document with the counts appended as an amendment. 3. Run Test A, then Test B, each once. 4. Record each claim with `recordClaim`, flag the forward look.
