# Trade-brief unconsumed fields — cleanup spec (2026-09-20)

**Status: scoped, not yet executed.** Found while tracing sizeMultiplier's dropped factors for
dead code (`RESEARCH_CLAIM sizemultiplier_orphaned_factors_removed_20260920`). This spec traces
git history for each field (not just current usage) to answer the real question before deleting
anything: was this a frontend feature that got removed and left its backend fields orphaned, or
backend fields built ahead of a UI that was never finished?

## The fields in question

All are on `acd.js`'s `levelScalpSetup`/`active` trade-brief object (the JSON response from
`GET /api/acd/setup-detection`), confirmed via exhaustive grep to have **zero readers** in any
known frontend surface (`src/**/*.jsx`, `server/public/quick-check.html`,
`server/public/setup-performance.html`, `server/public/loss-prevention.html`):

`dayTypeEdge`, `dayTypeWarn`, `pulseScore`, `pulseVolSigma`, `stackCount`, `overnightAlignment`
(the top-level trade-brief copy — a second copy also exists inside `sizeFactorsAtDetection`, see
"Not in scope" below), `streakWarn`, `streakBoost`, `sessionDeltaNeutral`, `sessionDeltaHigh`, and
the entire `tripleStack` conviction-badge block (~acd.js line 8600+).

## What git history actually shows — two distinct groups, one clean answer

**Group A — real frontend consumer existed, removed 2026-07-13, backend never followed:**
`dayTypeEdge`, `dayTypeWarn`, `pulseScore`, `stackCount`, `streakWarn`, `streakBoost`,
`sessionDeltaNeutral`, `sessionDeltaHigh` all show up in `git log -S<field> -- src/` hits on
commit `e8946e5` ("Remove 1,788 lines of dead code from ACDView.jsx (27% of the file)",
2026-07-13). That commit's own message says it removed **11 top-level components/consts
(`SessionStatusBar`, `AuctionReadSummary`, `DashboardPanels`, `ProximityBanner`, etc.) "defined
but never referenced anywhere in src/ — confirmed via exhaustive grep."** Those were the
components that rendered these fields. The backend computations that fed them were never cleaned
up in the same pass — a mirror-image gap of the same class of drift this codebase's docs already
warn about elsewhere, just backend-lagging-frontend instead of the usual frontend-lagging-backend.
**These fields have had zero possible readers for ~2 months (2026-07-13 to today).**

**Group B — never had a frontend consumer, ever:** `tripleStack` and `overnightAlignment` (the
top-level copy) return **zero hits** in `git log -S<field>` across `src/` at any point in this
repo's history. Both were introduced backend-side in commit `041ddeb` ("System overhaul: trade
feedback, overnight reads, session forecast, triple-stack conviction", 2026-06-22) — whose own
commit message claims "Rolling momentum (last 10 trades) shown on setup cards" and "Triple-stack
conviction: range position × overnight alignment × day type" as if both shipped to the UI. Checked
directly: no `.conviction`/`MAXIMUM`/`VERY HIGH`-style string anywhere in `src/` traces back to
this object (the few real hits for those substrings belong to unrelated features —
`TeleprinterFeed.jsx`'s own confidence label, `ACDView.jsx`'s `s.confidence`, `BacktestView.jsx`'s
`probColor`). The commit message overstated what shipped, or described a companion feature (the
"rolling momentum" one) that isn't `tripleStack`. **`tripleStack` has been dead on arrival since
the day it was written, 3 months ago.**

**Compounding issue specific to `tripleStack`:** its `note` strings contain hand-typed WR%
literals ("83-100% WR", "88%", "75%", "69%", "0% WR", "13-27%", etc.) — a standing violation of
this codebase's own "never hand-type a WR%/N/$ literal" hard rule, made moot only by the fact
nothing ever displays them. Reviving this feature as-is would ship that violation live; it isn't
a defensible "resurrect unchanged" candidate even if a UI were built for it.

## Explicitly NOT in scope — real consumers found, do not touch

- **`exhaustionSignalAtDetection`** — looked like the same shape of dead field at first (0
  frontend hits), but IS actually consumed: persisted to the DB via `active.exhaustionSignalAtDetection`
  at the real INSERT site (~acd.js line 9510), feeding the still-open, documented
  `confluence_exhaustion_interaction` `RESEARCH_CLAIM` thread. This is a real backend
  data-collection field, not a dead UI field — keep it exactly as-is.
- **`hivolLopaceAtDetection`** — has a real, live frontend reference (1 hit in `src/`) — keep.
- **`overnightAlignment`/`stackCount` inside `sizeFactorsAtDetection`** (a *second*, separately-
  written copy of each, distinct from the top-level trade-brief fields named above) — this is the
  deliberate write-only monitoring log established by today's sizeMultiplier cleanup (see
  `RESEARCH_CLAIM sizemultiplier_stripped_to_pressure_only_20260920` and its siblings) — every
  factor dropped from sizing today was deliberately kept there for future auditing. Do not
  conflate the two copies; only the top-level trade-brief copies (which were built for direct
  display, per Group A/B above) are in scope for this cleanup.

## What executing this would actually remove

Beyond the JSON fields themselves, real computation goes with them:
- `pulseScore`/`pulseVolSigma`: `_pulseHighVol`, `_pulseDelta15`, `_pulseStruct`, `_pulseLowRots`,
  `_pulseVolSigma` (acd.js ~line 3604-3633) — includes a real DB query computing a rolling
  volatility z-score (`_pulseVolSigma`), currently run every poll for a field nobody reads. (Not
  to be confused with the separate, real, already-shipped `server/services/pulseReading.js` /
  `GET /api/pulse/reading` live feature — confirmed via import check that it does NOT share this
  computation; it's fully independent. Removing this does not touch that feature.)
- `tripleStack`: the whole ~40-line conviction-assessment block (range quintile × overnight
  alignment × day-type branching, ~acd.js line 8600+), plus `isOvernightAligned(active.direction)`/
  `isOvernightCounter(active.direction)` calls at that site specifically (the *functions* themselves
  stay — they're still called elsewhere for the top-level `overnightAlignment` field being removed
  in this same pass, so once both call sites are gone, check whether `isOvernightAligned`/
  `isOvernightCounter` become fully orphaned too and remove them if so).
- `streakWarn`/`streakBoost`: no separate computation — just the two field expressions
  (`lfConsecLosses >= 2 ? ... : null`, `lfConsecWins >= 2 ? ... : null`). `lfConsecWins`/
  `lfConsecLosses` themselves stay (still feed `sizeFactorsAtDetection` monitoring).
- `dayTypeEdge`/`dayTypeWarn`: no separate computation — `dtaRow` stays (feeds the real,
  displayed `dtNote` description text).
- `sessionDeltaNeutral`/`sessionDeltaHigh`, `stackCount` (top-level copy): no separate
  computation — the underlying `_lfDeltaNeutral`/`_lfDeltaHigh`/`_lfSameDirCounts` stay (feed
  `sizeFactorsAtDetection` monitoring).
- `overnightAlignment` (top-level copy): no separate computation beyond the `isOvernightAligned`/
  `isOvernightCounter` orphan-check noted above.

## Recommendation

**Delete all of it.** Unlike the sizeMultiplier factors flagged-but-not-removed earlier today
(which fed a live, if unproven, sizing decision), every field here fits the same test that
justified today's other deletions: a real DB read/computation with zero possible reader for a
sustained period, not just a thin sample. Group A has been unreachable for 2 months by a
confirmed frontend removal; Group B has been unreachable for 3 months and never had a consumer at
all. Neither shows any sign of an active plan to rebuild the missing UI. There is no ambiguous
case here requiring a keep/revive judgment call, unlike the sizeMultiplier factors.

## Verification requirements (same discipline as every extraction/removal today)

1. Exhaustive grep for each field name + underlying variable before removing (this spec already
   did the field-name pass; re-verify at execution time in case anything changed since).
2. `node --check` + `npm run lint` (backend) + `npm run lint:frontend` + `npm run build` clean.
3. `node scripts/test_invariants.mjs` — no new failures vs. current baseline.
4. Live server restart, confirm process postdates the edit, health-check
   `GET /api/acd/setup-detection` returns clean JSON with the fields actually gone.
5. Check for orphaned imports/locals exactly like the sizeMultiplier cleanup did
   (`isOvernightAligned`/`isOvernightCounter`, `_pulseHighVol` family) — don't assume removing the
   field alone is complete.

## Priority

**LOW** — real value (removes ~50 lines plus a wasted per-poll DB query), no urgency (write-only
dead code carries no live-trading risk, unlike the sizeMultiplier factors). Reasonable to execute
in the same session it was scoped, since the investigation is already done and every case is
clear-cut (no judgment calls deferred) — but not time-sensitive.
