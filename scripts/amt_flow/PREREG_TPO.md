# TPO version of the confluence zones: re-run of the order-flow spec (frozen 2026-10-28)

Committed BEFORE any outcome of this variant is read. User decision: "Build the TPO (time-at-price) version of the confluence zones and re-run this exact spec." `PREREG.md` (the order-flow branch) governs everything else UNCHANGED: Setup A and Setup B rules, entry windows, stops and targets, structural exit, fills, costs, 1 MNQ contract, flatten at 15:55, the explore set (the same 529 sessions to 2025-05-16), the random-entry placebo (100 trials) and the same-selection controls, the reading rule. Hold-outs sealed.

## The one change
pdVAH / pdVAL (and nothing else) come from the prior full RTH session's **TPO profile** instead of the volume profile. ONH/ONL, IBH/IBL, the 20-point zone rule, and Setup B's micro VPOC (a 15-bar VOLUME profile, as the spec names it) are unchanged.

## TPO profile definition (fixed here)
- Brackets: 13 thirty-minute brackets of the 1-minute bars, A = 09:30-09:59 ... M = 15:30-15:59. A bracket with no bars is skipped.
- Price rows: 1.0 point (4 ticks). This is a free parameter chosen before any result as a common NQ Market Profile row size; it is NOT tuned. A row index is floor(price / 1.0). A bracket prints a TPO on every row between its low and its high inclusive. Row count = number of brackets covering the row.
- TPO POC: the row with the highest count; ties go to the row closest to the midpoint of the session's row range, then the lower row.
- Value area: 70% of the total TPO count. Start at the POC row; repeatedly compare the TPO sum of the next two rows above with the next two rows below and add the larger pair (ties go UP; at the edge of the profile only the rows that exist are added) until the enclosed count is at least 70% of the total. pdVAH = the highest tick of the top row (row top - 0.25); pdVAL = the lowest tick of the bottom row (row bottom).
- Sensitivity, descriptive only and never selected: row sizes 0.5 and 2.0 points.

## What is reported in addition (descriptive)
How different the TPO and the volume value-area edges are (median absolute difference of VAH and of VAL, in points), how often each zone set is the same, the share of sessions with a zone, and the full A/B reports, controls and placebo exactly as in the volume-profile run, side by side with it.

## Reading (frozen)
Unchanged: a setup is "a lead" only if its explore mean per trade after friction has a day-blocked CI lower bound > 0 AND beats the random-entry placebo p95 AND beats its own same-selection control. If the TPO zones differ little from the volume zones the result is expected to be close to the volume-profile result; that is itself informative.
