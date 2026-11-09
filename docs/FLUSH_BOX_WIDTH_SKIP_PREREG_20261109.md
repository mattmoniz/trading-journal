# Flush: skip events whose box is too wide for the day (scale-free). PRE-REGISTRATION, FROZEN 2026-11-09 before any outcome is read

Tracker item E (`docs/WORKPLAN_20261109.md`). Motivation (an anecdote, NOT data for this test): Sunday 2026-11-08 a live-window GLOBEX_FLUSH_REVERSAL_LONG entered with a 392-pt box / 442-pt stop and lost $887. Phase-1 counts and geometry: `docs/FLUSH_ENTRY_STOP_TEST_PHASE1_20261109.md` (addendum), scripts `flush_phase1_blind_counts_20261109.mjs` and `flush_phase1b_live_window_20261109.mjs`; shared event finders in `scripts/lib/flushStudyLib.mjs` (live-faithful Globex finder validated against the 44 live rows: 39 same type, 35 same fire time, all rows since 2026-10-16 match). Design critique: Argon (web, 2026-11-09), audited; adopted items listed in the phase-1 addendum.

## Question
Does skipping flush events whose stop is unusually wide for the day (box + overshoot, in units of ADR20) improve the expected per-event P&L, versus taking every event, without simply trading less?

## Population (frozen)
EXPLORE window only: departure/session date <= 2025-05-16. RTH events (`buildRthBlindEvents`) and live-faithful Globex events (`buildGlobexBlindEventsLive`), one event per day. Not used: 2025-05-17..2025-11-19 (hr-070 volume inflation) and >= 2025-11-20 (SEALED, untouched; the live shadow rows since 2026-09-01 are inside it and are not used for selection). Groups: RTH (L+S), GLOBEX_CONT (L+S), GLOBEX_REV (L+S). Eligible events (>= 20 earlier events of the same group+direction): RTH 358, GLOBEX_CONT 158, GLOBEX_REV 157.

## Rule under test (S1')
Sp = (|entry - structural stop| - 50) / ADR20, i.e. box + overshoot in ADR20 units (the fixed 50-pt entry buffer is removed because it leaked the regime into the ratio: Spearman with ADR20 -0.4..-0.5 for stop/ADR20 vs -0.1..+0.1 for Sp). Skip the event when Sp > the expanding 80th percentile of Sp over EARLIER events of the same group AND direction (direction-stratified, known strictly before the event). ADR20 = mean RTH range of the 20 prior sessions (inclusive of the departure day for Globex, whose RTH is complete at the fire). Skip rate in explore: 25 / 15 / 21 percent (final third), expected about 20-27 percent.

## Fills, exits, target (same in both arms)
`realistic()` arm of `flushStudyLib.mjs`: entry = the NEXT bar's open, gap-aware stop fill (structural stop price), exit at session end. Target = the median MFE of strictly EARLIER events of the same group+direction (walk-forward, >= 20 earlier events), identical for both arms; events without a target are not eligible. P&L = points x $2 - $2.

## Counted tests (3; Holm, family alpha 0.10)
T1 RTH, T2 GLOBEX_CONT, T3 GLOBEX_REV. Statistic: paired per-event difference d_i = P&L(S1') - P&L(B0) = -P&L_i if skipped, else 0; mean over ALL eligible events (skipped trades counted at zero); day-blocked bootstrap (`dayBlockedBootstrapCI`, whole days resampled; every event is its own day here). Analysed as RAW P&L and as PROP-TRUNCATED P&L (each trade's loss floored at -$1,000); the verdict uses the raw P&L and the truncated result must have the same sign. Median paired difference reported alongside (one tail event, e.g. the 777-pt stop, must not decide a verdict).

## Controls
(1) Fixed-count day-matched random skip: 1,000 draws that skip the SAME number of events per fire-time tercile (terciles of the group's explore fire-time distribution) from the NON-flagged events; the arm must exceed the 95th percentile of the random paired means (so trading less cannot pass). (2) Placebo: the same skip set applied to the MIRRORED trades (`realistic(setup, target, true)`: same stop/target distances, opposite side); the arm minus placebo paired mean must have a day-blocked CI lower bound > 0.

## PASS (all must hold, per test; Holm-adjusted alpha_i = 0.10 / (3 - rank + 1), one-sided)
1. Eligible events >= 150 (all three groups qualify). 2. Raw paired mean CI lower bound > 0 at the Holm-adjusted level. 3. Prop-truncated paired mean > 0. 4. Beats the fixed-count random-skip control (> its 95th percentile). 5. Arm minus placebo CI lower bound > 0. 6. Both chronological halves of the explore window have a paired mean >= 0. 7. Not INCONCLUSIVE (below). 8. Worst single loss of the S1' book is not larger than B0's.
INCONCLUSIVE (regime-confounded): the LONG and SHORT subset paired means have opposite signs and each exceeds 0.5 standard errors in absolute value; the pooled result is then neither a pass nor a fail and is reported as such. Direction-split results are descriptive, never counted tests.
NOT SHOWN: anything else. A not-shown result PARKS the idea (co-025), it does not retire it.

## Power (honest)
Per-event outcome SD of the skipped subset is NOT measured here; GUESS $350-500 (Argon) to $200 (mine). Paired SD about sqrt(skip share) x that, i.e. about $100-$250; minimum detectable paired mean at 80 percent power = 2.8 x SD_paired / sqrt(N): about $15-$37 per event for RTH (N 358) and $22-$55 for the Globex groups (N 157-158). A smaller true effect will read NOT SHOWN, so a not-shown result means "underpowered here", and the forward tag below is how it keeps accumulating.

## Parked (not tested, with reopen trigger)
E1 pullback limit: the diagnostics show wide stops are wide BOXES (tail variance share: RTH box 100 percent, GLOBEX_REV 82 percent, GLOBEX_CONT 54 percent box / 45 percent overshoot), and a pullback entry into a wide box is not what the data suggests; reopen only if a forward tag shows overshoot-driven wide stops. E2 sweep-reclaim (no defined sweep-depth distribution), S1b stop cap, ex-ante reward-to-risk gate (needs prior-event outcomes), entry-buffer normalization (a separate entry-rule test), per-direction counted tests, rolling-50 percentile (monitoring rule: if the 50-event live skip rate leaves 10-30 percent, switch to the rolling-50 window by this declared rule, not by tuning). Reopen trigger for all: forward events reaching 30 flagged per group (needs a forward tag on live fires: tracker item).

## Sealed handling
No sealed look in this test. Only an arm that PASSES may spend one sealed look (2025-11-20..2026-11-08) via `spendSealedLook()`, then forward shadow days from 2026-11-10 at 30 flagged events per group.

## Failure autopsy (co-022)
On NOT SHOWN: decompose the paired mean into (a) skipped winners lost vs skipped losers avoided, (b) the Sunday-session share of skips (explore enrichment was 0.38x CONT / 0.93x REV, so S1' is not a disguised no-Sunday rule), (c) top-5-day share, (d) raw vs truncated; record the claim and the next step.

## Amendment A1 (2026-11-09, BEFORE any outcome was read)
Data hygiene omitted from the frozen text and declared in the earlier Argon brief: events dated inside an NQ roll week (`isInsideNqRollWeek`, `server/services/acdShared.js`) are excluded; the number excluded is reported per group. Nothing else changes (population, rule, controls, pass rules, counted tests, eligibility of >= 20 earlier events computed after the exclusion).
