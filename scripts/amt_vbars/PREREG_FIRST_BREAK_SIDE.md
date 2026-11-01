# Pre-registration: which side does price break first after a tell fire? (written 2026-11-01 BEFORE any outcome)

Origin: user 2026-11-01, "is it detecting capitulation and firing in that direction when it should fire the opposite?" The direction test (`PREREG_DIRECTION.md`, not shown) compared money outcomes of a fixed stop trade. This is the cleaner market-behaviour question underneath it: after a tell fires, does the range break on the tell's side or on the other side first? Explore sessions to 2025-05-16 only, hold-out untouched. Script `scripts/amt_vbars/run_first_break.py`, one run.

## Population and definitions (all from existing code, no new number)
- Events: the 1,760 research V1 tell fires (signal bar `sig`, direction `d`), RTH 10:00-14:30.
- Range sides: `trade.boundary(ctx, j, side)` (overnight high/low, widened by the IB once the IB is done), a break = a 500-volume-bar CLOSE beyond it, counted only from the RTH open (the tell's own `inside_range` convention).
- Window: bars after the signal bar until 120 minutes after it (the tell's own time-out) or the 15:55 flatten, whichever is first.
- Per event the first break in the window is classified: TELL_SIDE (a close beyond the boundary on side `d`), OPPOSITE (beyond side `-d`), or NONE. Events whose opposite side was ALREADY broken before the fire (a close beyond it earlier in RTH) are set apart as FAILED-BREAK-BACK candidates (the user's "peak and fail") and reported separately, not mixed in.
- Headline statistic: among events that break at all, the share where the first break is TELL_SIDE. Also the break rate itself (share not NONE) and both counts per event class.

## Control (confound checklist item 3, same selection minus the signal)
Decision bars of the same sessions where the tell is NOT required: every 10th bar between 10:00 and 14:30, for each side `d` where `moving_d` is true (price moved in direction `d` over the last 10 bars, the tell's own motion component) and `d`'s side and the other side are both still inside the range. Same window, same classification. Share TELL_SIDE-equivalent = first break on side `d`. This is the "moving only" control the earlier node-ladder tests used; it answers whether the tell adds anything beyond price already moving that way.

## Statistics
Per-event shares (sum / N) per arm, never a day-weighted mean. Difference tell minus control with a day-blocked bootstrap CI (resample dates, pool each arm's events from the resampled dates, difference of shares; 2000 draws, seeded). Counts first. Chronological halves by median event date.

## Reading rule (stated before the run)
- The user's reading (the tell points the wrong way) predicts TELL_SIDE share BELOW the control's, CI excluding zero.
- The design reading (continuation) predicts ABOVE the control's, CI excluding zero.
- Anything else = not shown, and the CI half-width is reported as the resolution.
Floors: >= 40 breaking tell events on >= 30 dates, else UNDERPOWERED.

## Descriptive splits (reported, not counted toward the reading)
- NEAR vs FAR: the tell direction points to the nearer or the farther of the two range sides at the signal bar (distance from the signal-bar close to the boundary); first-break share per class.
- FAILED-BREAK-BACK class: count, share whose tell side breaks within the window.
- Session-open location is NOT used here; "where price sits against overnight high/low and absorbed areas" as a direction chooser needs its own definition of absorbed areas and its own prereg.
