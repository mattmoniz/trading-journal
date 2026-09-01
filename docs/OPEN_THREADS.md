# Open Threads / Pending Work

## ✅ 2026-09-01 (RESOLVED): liquidity-zones idea D census contradiction reconciled — a 3rd SQL bug, not a real negative

Resumed after a context clear left `OPEN_DECISION liquidity_zones_idea_d_census_contradiction`
mid-investigation (flagged, not yet root-caused): the same-day 92%/N=12 (§4.1, 2026-08-26) vs.
0.0%/N=766 (Task 2 above, 2026-09-01) idea-D-census disagreement. Found both scripts
(`scratch/census_idea_d_cluster_freshness.mjs` and `scripts/pilot_idea_d.mjs`), read both in full,
and reproduced the disagreement directly against the DB rather than trusting either number.

**Root cause: a 3rd, previously undiscovered bug in `pilot_idea_d.mjs`**, distinct from the 2 fixed
in the same-day audit above. Its bar-window query used one `$1` parameter both cast `::date` (day
boundary) and compared bare against a `timestamp` column (`ts < $1`). Postgres unifies a parameter's
type across every appearance in a single query — the explicit `::date` cast silently truncated the
bare comparison to midnight too (confirmed directly: `SELECT $1 as raw_param` in a query mixing
`::date` and bare usage of the same param returned `'2026-08-20'`, no time-of-day at all). That made
`ts < $1` equivalent to `ts < <midnight>`, impossible together with the script's own `time >= 570`
filter — **the bar-window query returned zero rows for literally every input row**, mechanically
forcing both `anchorVisited` and `anyPartnerVisited` to false regardless of the real data. The
0.0%/N=766 "decisive negative" was a pure artifact.

Fixed (two separate query params). Corrected script: **1/6 (16.7%)** — N-starved, and using a
narrower/less rigorous construction than the 2026-08-26 script (FADE-only population, `entry_zone`
midpoint as an anchor-price proxy instead of a real `level_prices` lookup, no same-day-forming-level
formation gate). Re-ran the 2026-08-26 script's more rigorous construction fresh against 6 more days
of data instead: **N grew 12→20 (clears this codebase's N≥20 floor for the first time), rate held
92%→90%.** Per the spec's own pre-registered rule, **idea D genuinely survives Step 0 and is worth
building** — the opposite of what the buggy same-day audit concluded.

`RESEARCH_CLAIM liquidity_zones_idea_d_free_census_rigorous_construction` (CONFIRMED, N=20/90%) is
now the load-bearing number; `RESEARCH_CLAIM liquidity_zones_idea_d_free_census` (the
`pilot_idea_d.mjs` N=6 result) is kept as directional-only, not weighed against it.
`OPEN_DECISION liquidity_zones_idea_d_census_contradiction` resolved. New `OPEN_DECISION
liquidity_zones_idea_d_step5_build_needed` (MEDIUM) flags the real remaining work — a genuine
EV/WR-tested comparison (already-visited-partner cluster vs. genuinely-fresh cluster), which needs
its own N≥20 per arm and will likely start as a SHADOW-tagging pass rather than a full live wire.
Full writeup: `docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.23.

## ✅ 2026-09-01 (RESOLVED): POC_ROTATION_JOIN_LONG/SHORT built and shipped live (SHADOW-only)

Resolves `OPEN_DECISION poc_rotation_join_build_live_detector`. Ported
`detectSignalEvents()` (the ZigZag-style leg/pivot + running-median-fair-value
convergence detector, originally built and audited in
`scripts/backtest_poc_rotation_vbp.mjs`) into a live, poll-computable form:

- **Extracted the canonical detector** into `server/services/pocRotationService.js`
  (moved, not copied — `backtest_poc_rotation_vbp.mjs` now re-exports it unchanged so
  its 14 existing downstream importers keep working without modification). Verified via
  a fresh backtest re-run before/after the extraction: N grew 767→775 from real new
  sessions between runs, same methodology, no behavior change.
- **New live poller** `server/services/pocRotationJoinDetector.js`, wired into
  `server/index.js`'s existing 60s `setInterval` alongside `detectRthFlush`/
  `detectGlobexFlush`/`detectMomentum60Trend` (same "own poller, not the level-touch
  candidates array" pattern — this is a whole-session leg-tracking construction, not a
  price touching a fixed level). **Stateless/restart-safe by design**, directly applying
  this same session's GLOBEX_FLUSH restart-fragility lesson: every poll recomputes
  `detectSignalEvents()` fresh from real bar history; the one in-memory cache field is a
  poll-skip optimization only, never a correctness dependency (a reset just re-attempts
  inserting already-fired events, which harmlessly no-ops against `active_setups`'
  unique index).
- **Construction**: JOIN direction (trade WITH the leg that just converged back to the
  running 24hr median fair value) + Time60_Stop20 exit (20pt stop, 60-minute time limit,
  mark-to-market, **no fixed price target**) — the validated winner per
  `RESEARCH_CLAIM poc_rotation_join_fade_levels_med50_fixed` (N=1935, WR=29.2%,
  EV=+$2.40/trade, real but thin, not rigor-clean).
- **Resolution**: since this is a genuinely target-less exit shape, it does NOT go
  through `resolveSetupsByPrice()`'s shared generic bar-walk (WIDER_TARGET/trail/extend
  logic) — added its own custom early-`continue` branch there instead, matching the
  existing `ABSORPTION_LONG`/`COIL_SURGE` precedent, deliberately avoiding edits to that
  complex shared critical path without its own review. `t1_level` on the live row is an
  unreachable informational placeholder (entry ± 1000pt), never checked for resolution.
- **Session span**: the full 6PM–5PM ET window continuously (matches
  `developing_value_log`'s convention), not RTH-only or Globex-only — legs freely cross
  both, so this satisfies CLAUDE.md's RTH+Globex-both-required rule structurally rather
  than via two separate calibrations (per the backtest's own KNOWN LIMITATION note).
- **Checklist items closed**: `bet_class` (added to `CONTINUATION_TYPES` — JOIN is a
  continuation-shaped bet, not a fade), `SETUP_DISPLAY_LABELS`, `setupDefinitions.js`
  (Setup Reference), `ARCHITECTURE.md` services table, `SETUP_STATUS` seeded via a live
  `backtest_setup_status.mjs` run (THIN_N, N=1 each, closing the "zero real touches ever
  is not automatically SHADOW-safe" gap immediately rather than waiting for the weekly
  cron). `SHADOW`-only throughout (real N=0 < 20).
- **Verified end-to-end in the actual restarted server process** (not just a manual
  script): 2 real events fired live within the first two 60s poll cycles after restart
  and resolved correctly — one `STOP_HIT` at exactly -$42 (20pt×$2/pt + $2 commission,
  confirming the custom branch's bar-by-bar stop check works), two more via
  `TIME_EXPIRED`/`MARK_TO_MARKET` at +$132/+$186.50 (confirming the time-limit path).
- **Deliberately NOT wired yet**: the ONH/ONL (`RESEARCH_CLAIM
  poc_rotation_join_onh_onl_confluence`, N=335, EV $21.18) and WS1 (N=42, EV $22.15)
  confluence findings — get the base type accumulating real data first, per the original
  decision's own explicit sequencing. Revisit as a follow-up once real N grows.

## ✅ 2026-09-01 (RESOLVED): audited 3 Gemini scripts from the combined dispatch — 2 real bugs found and fixed

Resolves `prefire_orderflow_touch_gate_candidate` and `liquidity_zones_defended_levels_ideas_pending_test`
(Step 0 only) and `volume_building_thread_untouched_angles_for_later` (sub-item a only). Each of the
3 delivered scripts was read in full before trusting anything, per the standing rule — 2 real bugs
found and fixed, one script clean as-is:

- **Task 1 (pre-fire order-flow gate)**: clean methodology (verified the `volZ`/`oneSidedRatio`
  formula genuinely matches `acd.js`'s live `STACK_VOL_BREAK_LIVE` code), one caveat noted (uses
  the bar strictly before `fired_at`, not the exact trigger bar — a related but not identical
  test). Result: negative, no monotonic predictive power, N=1446.
- **Task 2 (liquidity-zones idea D census)**: **2 real bugs found and fixed here**, plus **a 3rd,
  more severe one found later the same day (see the 2026-09-01 "idea D census contradiction
  reconciled" entry below — this paragraph's "0.0%/N=766, dies for free" conclusion was WRONG,
  a pure SQL artifact, not a real result; do not cite it).** (1) reconstructed "anchor freshness"
  using a window going back to 6PM the prior evening, but the real live `minutesSinceVisit` only
  ever looks at same-day RTH bars — a materially wider, non-equivalent window. (2) `fired_at` was
  never cast to `::text`, so a JS Date object got passed back as a SQL parameter and silently
  shifted 4 hours by the session timezone on round-trip (verified directly: Postgres rendered a
  09:37 ET touch as 05:37 ET) — this codebase's own documented naive-timestamp footgun, hit again.
  These 2 fixes alone were genuinely correct and needed — but a 3rd bug (a Postgres parameter
  type-unification issue that made the bar-window query unconditionally empty for every row) was
  still present after them and wasn't caught in this audit pass; it made the "N grew 154→766,
  14.9%→0.0%" result meaningless. See the later entry for the real, reconciled finding.
- **Task 3 (volume-building day-type conditioning)**: clean methodology, the closest audit given
  it's the one positive finding — verified the composite score formula matches `acd.js`'s real
  live `compositeStrength` computation exactly (not an invented formula), correct ground-truth
  day-type source, canonical `classifyLevelFormation()`, no lookahead. Reproduced identically on
  independent re-run (N=1161). Real finding: day-type composition doesn't explain the inherited-
  vs-same-day dose-response gap, but a real BALANCE-day sign-flip interaction does (high
  volume-building hurts same-day levels, helps inherited ones) — TREND shows an unexplained
  same-sign puzzle in both groups, flagged for later.

**Common gap across all 3**: none of Gemini's `recordClaim()` calls populated `sampleSize`/
`winRate`/`evPerTrade`/`rigorStatus` — only free-text `claimText`, leaving the RESEARCH_CLAIM
ledger's structured N/EV columns blank. Fixed in all 3 before finalizing. 3 throwaway scaffolding
scripts (`check_msv.mjs`, `read_claims.mjs`, `read_all_claims.mjs`) deleted — exploration
artifacts, not deliverables. Remaining follow-on work re-flagged as its own decisions:
`liquidity_zones_steps_1_through_4_remaining` (MEDIUM) and
`volume_building_inherited_level_remaining_angles_bc` (LOW).

## ✅ 2026-09-01 (RESOLVED): GLOBEX_FLUSH missed a real ~530pt overnight move — 2 real bugs found and fixed

User asked "did we catch the overnight drop?" — investigation of a genuine ~530pt NQ move
(2026-08-31 evening into 2026-09-01 morning) found `GLOBEX_FLUSH_LONG/SHORT/REVERSAL_LONG/
REVERSAL_SHORT` fired **zero** times despite this being exactly the mechanism built to catch this
shape of move. Two real, distinct bugs, found in sequence (the first hypothesis was wrong and
corrected before shipping anything):

1. **Restart fragility** (`server/services/globexFlushDetector.js`) — the armed departure state
   lived only in an in-memory module variable across the ~17hr overnight watch window, no DB
   persistence. 339 `SERVER_SHUTDOWN` events in the 7 days checked — restarts are routine in this
   codebase's dev workflow, never a rare edge case. Fixed by removing the cache and re-deriving
   the departure fresh from real bar/level history every poll, matching `rthFlushDetector.js`'s
   own already-restart-safe design (RTH never caches its trigger at all).
2. **Narrow trigger window** — the actual explanation for last night, found *after* first
   wrongly concluding bug #1 alone explained it (a manual check used the wrong day's PD_VAH,
   caught before it shipped). The departure check only looked in a fixed 30-minute window right
   at RTH close (4:00-4:30 PM ET) — last night's real value-area break didn't happen until
   **10:35 PM ET**, ~6 hours after that window closed, structurally invisible regardless of
   server uptime. Widened to check the full overnight watch period (4 PM through 9:30 AM).

**Retroactively verified against real data**: the fixed logic now correctly finds the DOWN
departure at 22:35 ET and would have fired `GLOBEX_FLUSH_SHORT` at 22:42 ET (entry 29436.75) —
well ahead of the continued slide to ~29040. Server restarted, healthy, `test_invariants.mjs`
shows no regressions from this change (one new unrelated FAIL, confirmed pre-existing calibration
drift on `IB_HIGH_FADE_SHORT`, zero code overlap with the touched file).

## ✅ 2026-09-01 (RESOLVED): POC-rotation-JOIN promotion decided YES, build deferred as its own session

Resolves `OPEN_DECISION poc_rotation_join_promote_to_live_setup_type`. Reviewed the actual
detection mechanism (`detectSignalEvents()`, `scripts/backtest_poc_rotation_vbp.mjs`) before
deciding — it's a genuine ZigZag-style leg/pivot detector with an incremental running-median
fair-value tracker, not a simple level-touch check. Porting it into `acd.js`'s live 15s-poll
detection loop safely is comparable in scope/risk to the VWAP-reclaim structural-stop build
already deferred this session, not a quick wire.

**Decision: yes, worth pursuing.** The base trade construction has real, independently-replicated
confluence findings with somewhere to attach (ONH/ONL EV $21.18/trade N=335; WS1 EV $22.15/trade
N=42) and the user has asked to wire this in multiple times. Not attempted this session — flagged
the actual build as its own new decision (`poc_rotation_join_build_live_detector`) with the full
5-step scope (port the detector live, pick/confirm the canonical exit, wire the confluence
findings, SETUP_STATUS/OPTIMAL_STOP calibration, SHADOW-only per N<20) since "should we start" and
"build it" are different questions.

## 🔶 2026-09-01 (in progress): 3 more research items dispatched to Gemini

`prefire_orderflow_touch_gate_candidate` (a genuine pre-entry order-flow filter pilot, reusing the
live `volZ`/`oneSidedRatio` block `STACK_VOL_BREAK_LIVE` already uses), the liquidity-zones spec's
"idea D" free census (`liquidity_zones_defended_levels_ideas_pending_test`), and day-type-
conditioning the inherited-vs-same-day raw expansion signal
(`volume_building_thread_untouched_angles_for_later`, sub-item a) — all dispatched together.
Not yet returned; audit before trusting any number, per the standing rule.

## ✅ 2026-09-01 (RESOLVED): all 3 dtClass-gated sizing/standdown gates come back negative — extends the trend-gate finding

Resolves `OPEN_DECISION dtclass_other_3_gates_untested`. The 2 combined Gemini dispatch tasks
finished with very different outcomes — audited both before trusting either.

**Task 1 (dtClass gates) succeeded, after a real bug fix.** The delivered script
(`scripts/backtest_dtclass_sizing_standdown_gates.mjs`) filtered its loss-streak lookback on
`fired_at < candidate's fired_at` — a genuine lookahead bug (a prior trade that fired earlier but
*resolved after* the candidate fired could get counted using an outcome that wasn't actually
knowable yet). Fixed to `resolved_at <` before running. Result, real (`ACTIVE`/`SHADOW`) fade
population N=1122, live-reassessment TREND reads 68.0% of the time (consistent with the
already-established ~70.6% false-positive rate for touch-moment evaluation): **all 3 gates come
back negative or unreliable** if swapped from the dead `dtClass` source to the live reassessment
engine — TREND-day sizing penalty (delta -$187.95, N=763, not rigor-clean), OR-expansion bonus
(delta +$125.90 but 98% day-clustered, not trustworthy), STAND DOWN filter (delta -$1534.80 across
574 suppressed rows). **Do not wire any of the 3** — extends, rather than contradicts, the
original 2026-08-03 `isTrendCounterFade` finding. Recorded as `dtclass_gate_a/b/c` RESEARCH_CLAIMs.

**Task 2 (IB-range exit signal) failed audit, discarded rather than run.** Its script
(`scripts/backtest_ib_range_exit_daytype_gated.mjs`) had 3 disqualifying problems: used $20/pt
(full NQ) instead of this codebase's MNQ $2/pt (a direct hard-rule violation), no `computeRigor()`
call despite explicit instruction, and the comparison itself didn't test the actual research
question (compared average MFE points across buckets — a market-move measure, not what an actual
hold-longer exit mechanism would capture; its own comments call it "very simple/a proxy for now").
Deleted rather than left as a misleading starting point. `wire_intraday_ib_range_exit_signal`
stays genuinely PENDING — re-flagged with the specific fixes a real rebuild needs (real $/pt
constant, `computeRigor()`, an actual net-P&L delta comparison instead of an MFE-magnitude proxy).

## ✅ 2026-09-01 (RESOLVED): bar-10 stop-cushion checkpoint re-attempted at 8x larger population — real, no longer reverses

Resolves `OPEN_DECISION trade_management_continuous_score_worth_reattempting`. Re-ran
`scripts/backtest_stop_cushion_checkpoint.mjs` — the exact bar-10 "how much stop-cushion remains"
test that reversed sign at N~200 back on 2026-07-27 — against the current real population
(N=907 checkpoint-eligible events, up ~4.5x from the eligible-subset count, ~8x on the base
ACTIVE/SHADOW population this decision's own trigger was keyed to). Result this time: a real,
clean effect that does **not** reverse. Median split at stopCushionFraction=0.967: LOW cushion
(closer to stop at bar 10) N=453, EV=**-$37.37/trade**; HIGH cushion (more room) N=454, EV=**+$13.09/trade**
— delta $50.46/trade. Chronological 70/30 split holds up (train delta $53.35 N=634, test delta
$42.99 N=273, same sign, similar magnitude — no reversal). `computeRigor`: stable=true,
clustered=false, clean=true (all 3 chronological thirds negative for the LOW-cushion group).
Recorded as `RESEARCH_CLAIM bar10_stop_cushion_reattempt_larger_population` (PROVISIONAL).

**Real open caveat before this goes anywhere near live/SHADOW**: it may substantially overlap
with the already-live `bar6_checkpoint`/`targetDistFraction` mechanism — both measure "how far
underwater is this trade," just at different fixed bars (6 vs 10). Before trusting this as a
genuinely *additive* signal rather than a later, redundant re-measurement of what bar6 already
captures, check the correlation between the bar-6 and bar-10 reads on the same trades, and
whether bar-10 adds real incremental information conditional on the bar-6 read. Also not yet done:
`bet_class` split (this codebase's own standing pooling-risk caution) and `computeReplication()`.
Does **not** itself build "the fuller continuous per-bar re-evaluation function" the original
2026-07-26 idea envisioned — that remains a separate, larger undertaking.

## ✅ 2026-09-01 (RESOLVED, wired live): slow+deep adverse-grind early exit — new informational mechanism

Resolves `OPEN_DECISION slow_deep_adverse_grind_early_exit`. The CONFIRMED finding (N=691,
family-gated across 4 bet_classes, rigor-clean, replicates — `docs/SLOW_DEEP_EARLY_EXIT_SPEC.md`)
had no live mechanism built. Added `computeSlowDeepEarlyExit()` (`server/services/maeMfeReplay.js`),
matching `computeBar6Checkpoint()`'s exact precedent — a pure function called once from
`resolveSetupsByPrice()`'s shared resolution loop with the same `bars.rows` array, compute-once-
never-overwrite. Walks forward bars tracking running MAE; the first bar where MAE crosses 75% of
the trade's own original stop distance sets `speed=FAST` (≤2 bars) or `SLOW` (3+ bars), matching
the CONFIRMED claim's own bar-count convention exactly. `ruleSaysExit=true` only when `speed=SLOW`
AND the setup's bet_class is one of the 4 validated families — family-gated per the spec's own
"never ship pooled" rule.

New columns `active_setups.slow_deep_exit_speed`/`slow_deep_exit_recommended`, migrated live,
`schema.sql` regenerated (also caught up broader unrelated drift since the last 2026-06-30
snapshot). Purely informational — this system has no broker execution capability, matching the
same caveat `bar6_exit_recommended` already carries. Server restarted, HTTP 200 confirmed,
`test_invariants.mjs` shows the same 8 pre-existing FAILUREs as baseline (no regressions), lint
clean. **Not done**: frontend display on `quick-check.html` — DB tracking was the priority piece,
matching the same precedent used for the OR-range/RVol tagging earlier this session.

## ✅ 2026-09-01 (RESOLVED): 3 more backlog items — 2 turned out already-stale, 1 needed user input

- **`vwap_reclaim_hold_rth_only_build_worth_it`** — RESOLVED as STALE. This "should we build it"
  decision was overtaken by action the SAME DAY it was flagged (2026-08-04, commit `abdf396`) and
  never marked resolved — `VWAP_RECLAIM_SHORT` is genuinely live SHADOW-only, including the
  mutual-exclusion gate against `RTH_VWAP_FADE` the decision worried about (verified both exist in
  code). The real open question now is different and already tracked: real forward SHADOW data on
  the shipped version is deeply negative (see this session's earlier `vwap_reclaim_short_structural_stop_not_yet_built`
  resolution) — ironically validating this decision's own stated worry about narrow single-cell
  survivors failing out-of-sample, just via live data rather than a fresh backtest.
- **`value_fade_daytype_positive_signal_needs_live_gate_research`** — RESOLVED, accepted as
  currently unactionable. Checked for a viable new live regime signal before defaulting to that:
  none exists (the only candidate, the value-area regime layer, is explicitly tagging-only/
  unvalidated per its own documentation) and re-testing the already-tried reassessment engine
  would very likely hit the same structural bias already found for `isTrendCounterFade` (fade-touch
  moments look like momentary trends). The BALANCE-day-positive edge stays real but unactionable;
  path 1 (a genuinely new signal) stays open in principle, not permanently closed.
- **`claude_md_restructuring_scoped_not_executed`** — RESOLVED as STALE. The restructuring this
  decision tracked ("not started") had actually already been executed the same day it was flagged
  (2026-08-12, per `docs/CLAUDE_MD_RESTRUCTURING_PLAN.md`'s own "Result" section — 4 commits, all
  3 detail files genuinely exist with real content, verified directly). CLAUDE.md has since grown
  back to 111KB (from 99KB post-split) over the 3 weeks since, as new hard rules/conventions were
  added in full narrative form without re-applying the same condensation discipline going forward.
  Re-flagged the actual remaining work as a fresh decision (`claude_md_needs_recondensation_20260901`,
  LOW) rather than reusing the stale slug — this is "condense 3 weeks of new content," not "redo
  the original split." Not started; per the original plan's own caution, this is a real multi-hour
  task that shouldn't be rushed into a single sitting.
- **`rolling_window_backtest_generalization_idea`** — user narrowed scope to the OR family only,
  then asked to skip describing the boundary basis for now. Left parked, unchanged.
- Also ran the scheduled `archive_open_threads.mjs` manually (cron catch-up hadn't caught it) —
  `docs/OPEN_THREADS.md` was 404KB against its own 250KB cap; moved 1 old section out, still over
  cap but that's expected given how active the last 7 days have been, not a new problem.

Older resolved/superseded threads are periodically moved to [OPEN_THREADS_ARCHIVE.md](OPEN_THREADS_ARCHIVE.md) (via `node scripts/archive_open_threads.mjs --apply`) to keep this file's per-session read cost down — nothing is deleted, just relocated. Still-pending items are backed by `OPEN_DECISION`/`RESEARCH_CLAIM` rows regardless, so archiving here never buries anything.

## ✅ 2026-09-01 (RESOLVED): 4 more backlog items closed — exit-mechanism family, VWAP_RECLAIM_SHORT, 18-script cron audit

Continuation of the same-session backlog-clearing pattern, same "check for newer superseding work
before redoing anything" discipline throughout.

- **`exit_logic_family_holistic_reassessment_20260818`** — RESOLVED. Verified, both in code and
  empirically against the DB, that the 4 independently-built exit-timing mechanisms (bar6,
  wider-target, slow-deep-early-exit, breakeven-trail) cannot produce contradictory signals on the
  same trade: bar6 is purely informational (never changes resolution), slow-deep isn't wired live
  at all, and `wider_target_mult`/`runner_trail_width` (the 2 that DO change resolution) are
  mutually exclusive by design at every one of 5 INSERT sites checked — confirmed empirically, 0
  of 1600 real `wider_target_mult` rows and 0 of 3 real `runner_trail_width` rows ever co-occur.
  bar6's cutoff re-check is already tracked separately (`verify_bar6_exit_recommended_live`).
  Sharing machinery between slow-deep and bar6 is deferred until slow-deep clears CONFIRMED
  (still PROVISIONAL, unwired). Breakeven-trail is worth keeping scheduled — `PD_POC_FADE_SHORT`
  already graduated to real calibration earlier this same session.
- **`vwap_reclaim_short_structural_stop_not_yet_built`** — decision point RESOLVED (build itself
  deferred as new decision `vwap_reclaim_short_build_structural_stop`). Real forward SHADOW data
  has accumulated (N=20, right at the N≥20 trigger this decision set): EV=-$39.78 to -$43.58/trade,
  WR 19-25%, `SETUP_STATUS`=THIN_N, all 3 chronological thirds negative — the fixed-point-stop
  simplification is underperforming badly vs. Phase 1's validated structural-stop prediction
  (EV=+$5.96/trade). Per the decision's own pre-stated logic, this means: yes, build the real
  structural-stop resolution path. Not attempted this session — genuine risk to a shared,
  heavily-loaded function (`resolveSetupsByPrice()`), deserves its own dedicated, reviewed session.
- **`roadmap_phase0_18_scripts_need_recordclaim_wiring`** — RESOLVED. Individually inspected all
  18 scripts. None actually need `recordClaim()`/cron wiring — they're one-time diagnostics (2
  literally self-labeled "one-off, not scheduled" / "INCONCLUSIVE" in their own header comments)
  whose findings are already superseded by later, more current live-wired work (bar6 mechanism,
  BIGMOVE_LIVE_SIGNAL, the current flagship 1yr prop-walkthrough script, the closed candle-pattern
  spec) or already fed into the standard `SETUP_STATUS` pipeline. Caveat: categorization based on
  documented history + each script's own comments, not a line-by-line status re-verification of
  all 18 `RESEARCH_CLAIM` rows.

## 🔶 2026-09-01 (in progress): 2 dtClass-gated backtests + IB-range exit signal, dispatched to Gemini

`dtclass_other_3_gates_untested` (the 2 remaining sizeMultiplier/standDown gates keyed on the
permanently-null `dtClass` — freshly relevant after today's sizeMultiplier audit independently
confirmed `dtClass` is NULL on 63/63 real fires) and `wire_intraday_ib_range_exit_signal`
(compression-based exit timing, needs day-type as a REQUIRED live condition, not the dead
end-of-day column the original test used) both need the same live day-type reassessment engine
(`dayTypeReassessmentService.js`/`computeCase()`) and the same rigor discipline as the
already-resolved `backtest_trend_gate_suppression.mjs`. Dispatched together to Gemini
(2026-09-01) with explicit instruction to reuse that exact pattern, not reimplement. Not yet
returned — check back before trusting any number, per the standing audit-Gemini-output rule.

## 🔶 2026-09-01: sizeMultiplier composite redesign Phase 0 — critique overturns the spec's own premise, redirected

`OPEN_DECISION sizemultiplier_composite_redesign_scoped_pending_review` — dispatched
`docs/SIZE_MULTIPLIER_COMPOSITE_REDESIGN_SPEC.md` to DeepSeek for the Phase 0 design critique its
own rollout plan called for. DeepSeek used real DB tool access to verify its claims rather than
critique abstractly (timed out mid-writeup at 15min, but had already run its verification) — its
finding was independently re-confirmed directly against the DB (N=63 real `ACTIVE`/`SHADOW` fires
with `size_factors_at_detection`, larger than DeepSeek's own N=41 subset, same pattern):
`dtaRowRecommendation` NULL 63/63, `entryPressureShortBoost` TRUE 0/63, `dtClass` NULL 63/63
(matches the already-tracked `dtclass_null_all_day_neuters_multiple_live_gates`), `smallGapDay`
TRUE 57/63. Only 4 distinct `size_multiplier` values exist across all real fires
(`{0.10:27, 0.25:34, 1.25:1, 1.30:1}`) — 97% sit at the two clamp floors.

**The 2 factors the spec held up as the model of "self-recalibration done right" (day-type bump,
entry-pressure boost) are exactly the two that never fire on any real row.** Real output variance
is almost entirely loss-streak-driven (`lfConsecLosses` + `hasLossToday`), not the other ~23
factors the spec proposed making continuous. Recorded as `RESEARCH_CLAIM
sizemultiplier_factor_hygiene_audit_reveals_dead_factors` (PROVISIONAL — sample is day-clustered,
92% top-5-day, but the 0%/100% factor rates are extreme enough to be structural).

**Redirected, not resolved**: building a composite score on top of the current stack would fit a
fancier model on mostly-dead/constant inputs — the spec's own Phase 1 (Gemini mine-and-run
comparison) is premature. Next step is a factor-hygiene/saturation census (fix or remove dead
factors, especially `dtClass` which is already separately scoped) *before* deciding whether a
composite redesign is still worth building on whatever factors actually vary. Spec doc updated
with a "Phase 0 critique result" section at its top; not yet done.

## ✅ 2026-09-01 (RESOLVED): RTH VWAP_MAGNET's "stable loser" reading was a short-history artifact, not real

Resolves `OPEN_DECISION globex_vs_rth_vwap_magnet_divergence_unexplained` (open since 2026-08-04).
The original finding compared `GLOBEX_VWAP_MAGNET_LONG` (real, strengthening edge, ~3.5yr
reconstruction) against RTH `VWAP_MAGNET_SHORT` (a "stable loser across all 3 chronological
thirds") at the same S=100/T=60 configuration — an unexplained session-dependent flip. The RTH
side's reconstruction depended on `getTrailingVwapStd()`, which reads `session_analysis.close_vs_vwap`
— only ~109 real days deep (back to 2026-03-25), nowhere near the Globex side's ~3.9yr
`price_bars_primary`-derived history.

Built `getTrailingRthVwapDists`/`getTrailingRthVwapStdFullHistory` (`server/services/queries.js`)
— the RTH-bar equivalent of the Globex helper, computing the same quantity directly from
`price_bars_primary`'s full history instead of the short table. Verified byte-identical to
`session_analysis.close_vs_vwap` on 5 overlapping dates before trusting it. Re-ran the identical
S=100/T=60 reconstruction both ways in the same pass (`scripts/backtest_vwap_magnet_rth_extended_window.mjs`):

| | N | Mean P&L | SHORT | Rigor |
|---|---|---|---|---|
| Old (109-day window) | 271 | +$2.28 | **-$15.10/trade** | not stable/clean |
| New (3.9yr window) | 747 | +$18.19 | **+$20.44/trade** | stable, clean |

With 2.75x the data, RTH `VWAP_MAGNET_SHORT` flips from a "stable loser" to the strongest leg of
the comparison. **Neither original hypothesis (a: real session mechanism / b: no mechanism, be
skeptical of Globex too) was right — the actual answer is (c): the RTH-loser reading was itself a
short-history statistical artifact**, exactly as the original decision's own text speculated might
be the case. Recorded as `RESEARCH_CLAIM vwap_magnet_rth_extended_window_reconstruction`
(PROVISIONAL — single-script, not yet independently re-verified). Does not by itself explain
Globex's strengthening z-trend (a separate, still-open question) — isolates that the RTH side
specifically was the artifact. New functions are backtest/reconstruction-only, not wired into any
live path — `getTrailingVwapStd` (the live threshold source) is unchanged.

## ✅ 2026-09-01 (RESOLVED, not promoted): 2-lot scale-out with breakeven-minus-5 runner — closed against the corrected baseline

Resolves `OPEN_DECISION twolot_scaleout_breakeven_minus5_runner_scoped_20260831`. The 2026-08-31
second-pass headline (+$7.63/trade) compared the mechanism against a synthetic "exit-all-no-runner"
strawman, not the user's actual current strategy — the second pass's own text had already computed
an `exactBe` reference arm (2-lot, exact-breakeven runner) without promoting it to primary. Doing
that promotion: **delta beMinus5 vs exactBe is only +$1.39/trade at T1=12pt**, and **negative at 3
of the other 4 T1 candidates** (T1=16: -$0.34, T1=20: -$1.18, T1=30: -$0.41; T1=24: +$0.19 near
zero). Most of the original edge was a structural-baseline artifact (beating giving-up-the-runner-
entirely, not beating what's actually already being done).

**Independent re-verification**: dispatched to Gemini with an explicit instruction to build a
fresh implementation blind to the existing script. Gemini's independent build
(`scratch/reverify_be_minus5.mjs`) corroborated the qualitative result (+$2.30/trade at T1=12,
thin/mixed-sign elsewhere) — audited the actual script (not just the writeup) and confirmed it
independently arrived at the same same-bar-ambiguity handling and the same real-`stop_level`
design choice without having seen this codebase's code, genuine convergent validation.

**Conclusion: closed, not built.** The real edge over the user's actual strategy is too thin and
not robust across the T1 neighborhood to justify live/SHADOW execution plumbing. `docs/TWOLOT_SCALEOUT_BREAKEVEN_MINUS5_SPEC.md`
updated with a "Third-pass result — CLOSED" section; `OPEN_DECISION twolot_scaleout_generalize_to_other_setups`
(the deferred "apply this elsewhere" question) is now moot for this specific mechanism.

Older resolved/superseded threads are periodically moved to [OPEN_THREADS_ARCHIVE.md](OPEN_THREADS_ARCHIVE.md) (via `node scripts/archive_open_threads.mjs --apply`) to keep this file's per-session read cost down — nothing is deleted, just relocated. Still-pending items are backed by `OPEN_DECISION`/`RESEARCH_CLAIM` rows regardless, so archiving here never buries anything.

## ✅ 2026-09-01 (RESOLVED): breakeven-trail 5-of-6-uncalibrated decision closed; contaminated `B_FLOOR_S1_FADE_LONG` row nulled

Resolves `OPEN_DECISION breakeven_trail_zero_real_survivors_20260816`. Checked current state before
acting (the last update to this decision was 2026-08-16/20) rather than redo stale analysis:
**`PD_POC_FADE_SHORT` has since genuinely graduated** — a real `BREAKEVEN_TRAIL_TEST` row exists
(run_date 2026-08-25, real N=24, trail=19.3pt, OOS EV +$30.31 vs -$2.31 fixed-target baseline),
already tracked and already wired live on both RTH and Globex (2026-08-31 `resolveUnconditionalTrailVariant`
work) — left untouched. The other 5 wired `_TRAIL` variants remain uncalibrated (no current
`BREAKEVEN_TRAIL_TEST` row at all — 0/5, not 0/6 as previously framed).

Took the decision's own option (b) for the one remaining stale row: `B_FLOOR_S1_FADE_LONG` still has
real (`ACTIVE`/`SHADOW`) `TARGET_HIT` N=0 (all 68 real target-hits are `BACKFILL`-origin) — nulled
`notes.trail` on all 5 historical weekly rows for this signal_name (all held an identical stale
trail=20.3pt, confirmed before nulling, so no distinct history was lost; original value preserved
per-row as `notes._original_trail_before_null`). The live consumer now falls back to a plain
fixed-target trade for `FLOOR_S1_FADE_LONG_TRAIL` instead of trailing on a synthetic-only basis,
matching the `OPTIMAL_STOP` circuit-breaker precedent. Verified via read-back same turn.

## ✅ 2026-08-31 (RESOLVED): Setup D's range+RVol finding wired for live tracking — no longer a dead end

Follow-up to the range+RVol combo finding above (`RESEARCH_CLAIM
setup_d_range_rvol_combo_robust_across_windows`) — user asked "how can I track this?" and the
honest answer was "not yet, it's backtest-only." Per this codebase's own "no dead ends" hard rule,
wired it properly rather than leaving it a passive claim: added `active_setups.or_range_at_detection`/
`.rvol_20d_at_detection` (real migration — `ALTER TABLE`, `server/schema.sql` regenerated,
`ARCHITECTURE.md` updated), stamped on every future `OPENING_DRIVE_15MIN_LONG/SHORT` fire (both
the immediate and pullback entry paths) via a new day-cached `getOrVolBaseline20d()` helper
(trailing-20-day OR-window volume average, strictly prior days, no lookahead). NULL for every
other setup_type, which never sets these on their candidate object. `node --check`/`eslint` clean,
`test_invariants.mjs` shows no new regressions (the one new FAIL, `GLOBEX_VWAP_FADE_LONG`, is an
unrelated OPTIMAL_STOP calibration drift, confirmed out of scope).

**Discovered along the way**: the dev server's systemd unit had been cleanly stopped (not crashed)
8 hours prior — restarted via the standard `./start.sh` per the existing dev workflow.

**Still not done**: no frontend display of the new columns yet (Setup History view could show
them per-fire, matching how `SHADOW`/`BACKFILL` tags already render) — the DB-level tracking is
the priority piece (satisfies "persisted queryable" + "has a recheck path" once real SHADOW fires
accumulate), frontend display is a nice-to-have, not blocking. No live filter/downweight wired
yet either — this is tagging only, matching the deliberate `vol_building_signal`/`regime_pos_Nd`
precedent (informational, not gating) until real forward data confirms the backtest finding.

## 🔶 2026-08-31: Setup D — direction asymmetry, drawdown, day-type, and monster-day threads (late-session round)

Continuation of the Setup D thread below, prompted by user follow-ups after the exit-mechanism
work closed out. Several distinct findings, all independently re-verified:

- **Win rate reveals shorts carry the whole edge**: current live 159/80 hits target 55.0%
  overall (needs 66.5% to break even on target/stop alone — the strategy survives on what the
  31% "expired" bucket does, not the raw hit rate). Split by direction: **SHORT hits 69.4%**
  (self-sufficient, clears break-even on its own) vs **LONG only 41.2%**, with LONG's defining
  failure being *failing to commit* (41% of longs neither hit target nor stop, just meander to
  session end) rather than getting stopped out more. Recorded as `RESEARCH_CLAIM
  setup_d_direction_split_winrate_long_weak_link`.
- **LONG-side entry filter screen** (5 candidates: drive magnitude, order-flow, volume-building,
  NL30, gap): one real but thin, counterintuitive lead — lighter volume-building at entry lifts
  LONG's hit rate from 41% to 56% (N=25 vs 26) — still short of the 66.5% break-even bar. Verdict:
  LONG's weakness is structural, not fixable with a smarter filter on what's been tested.
- **Real drawdown check**: worst historical losing streak (both directions combined) is 4 trades,
  -$964; worst peak-to-trough drawdown $1,088 — both centered on the most recent stretch in the
  data (late July–Aug 2026). With only ~100 trades on record, a worse streak than anything
  observed (e.g. 5 stops in a row, ~$1,600) hasn't happened yet but isn't statistically far-fetched.
- **Day-type check**: LONG's only losing bucket is TURBULENT days (50% WR, N=8, thin) — BALANCE
  and TREND are fine. SHORT is robust across all three. Not usable live as stated, though — day_type
  isn't known until ~8:20pm ET, well after the 10:15am entry decision (same structural gap that
  broke IB_BULLISH/IB_BEARISH).
- **Monster-day early-warning screen**: does anything before 10:15am predict a 600+pt session?
  Dispatched to Gemini, then independently audited — **2 real lookahead bugs found and fixed**
  (Overnight Range joined to the wrong night; Gap Size compared today's open to today's own
  not-yet-existing close — both corrected in `scripts/test_monster_day_predictors.mjs`, full
  before/after numbers in `reports/monster_day_predictors_2026-08-31.md`). Core finding survives
  correction: a real, clean, pre-entry signal for "today will be a monster day" exists (best:
  first-15-min OR range, AUC=0.881), but the days it correctly flags have WORSE average PnL
  ($18.79 vs $54.27) — extends `docs/COMPRESSION_TAIL_MFE_SPEC.md`'s existing finding that wide
  mornings predict chop, not clean trend. No early-warning-based exit adjustment is justified.
  Recorded as `RESEARCH_CLAIM setup_d_monster_day_predictors_corrected_still_negative`.
- **Follow-up, the strongest lead found all session**: does OR range COMBINED WITH relative
  volume (RVol) predict something the monster-day screen missed? `scripts/backtest_setup_d_range_rvol_combo.mjs` —
  splitting into quadrants (OR range vs its own median) × (RVol vs its own median), the
  "HIGH range + HIGH RVol" bucket is the worst by a wide margin (avg PnL -$9.65, N=31, contains
  9 of the 11 real monster days) vs "LOW range + LOW RVol" (+$69.09, N=29) at a 20-day RVol
  window. **Deliberately swept 5 RVol lookback windows (10/15/20/25/30 days) before trusting
  any single one** — the user's own habitual 10-day convention initially showed this, then
  reversed sign under a chronological-stability check (first-half direction flipped). Sweeping
  the neighborhood found 15/20/25/30-day all agree (same direction in BOTH chronological
  halves), only the thinnest (10-day) window disagrees — consistent with 10-day being the noisy
  outlier, not the true answer. This is the one filter idea from today that survived a genuine
  robustness check across parameter choices, not just one lucky number. Recorded as
  `RESEARCH_CLAIM setup_d_range_rvol_combo_robust_across_windows` (PROVISIONAL — still needs
  real forward SHADOW confirmation before hardening into a live filter).
- Real full-population NQ daily range check (not just Setup-D-triggering days): mean 317pt,
  median 275pt across all 449 trading days — confirms the user's own instinct that daily range
  typically runs north of 300, with a real fat right tail (max 1,620pt) pulling the mean up.

**Where this leaves Setup D**: entry (hybrid drive-magnitude rule) and exit (159/80, single entry)
both stand as tested. The clearest actionable open thread is the long/short asymmetry — SHORT is
a real, standalone, well-validated edge; LONG is a genuinely weak, close-to-coin-flip signal that
survives mostly on its non-resolving trades landing near flat rather than losing badly.

**RESOLVED 2026-09-01**: flagged as `OPEN_DECISION setup_d_long_short_sizing_asymmetry` and put to
the user directly (live-capital-sizing-affecting). **Decision: leave as-is for now** — no sizing
change, both LONG and SHORT stay SHADOW-only at the existing 159/80 combined exit (which already
implicitly prices in the asymmetry). Revisit once real N grows past the current ~2-fires-in-20-days
starvation level — re-check the direction split and the volume-building LONG filter lead
(41%→56% hit rate, N=25/26) with a larger sample before deciding size-down vs pause.

## 🔶 2026-08-31: Setup D (OPENING_DRIVE_15MIN) Stage 2 — a real, currently 100%-forfeited opportunity found; discriminator screen in progress

Follow-up to the (resolved, below) IB_BULLISH/IB_BEARISH thread — user's redirect: "figure out
how to capitalize on big breaks." Landscape check first: `BRACKET_BREAKOUT_SHORT` is a real,
decisive loser (real EV -$42.60/trade, N=20, stable); everything else in the breakout family has
essentially no real trade history except `OPENING_DRIVE_15MIN_LONG/SHORT` (Setup D), which
already passed a real Stage 1 bar-history validation (N=138, rigor-clean, beat a blind-delay
control) but has fired only 2 real times in 20 days — thin by starvation, not by failure.

**Stage 2** (`scripts/backtest_setup_d_opening_drive_stage2.mjs`, dispatched to Gemini, every
number independently re-verified by re-running directly): tested (a) an immediate-entry variant
(no pullback wait) and (b) a volume-building magnitude split on both entry styles. Immediate
entry alone fails OOS (-$1.80/trade vs Arm A's $38.15) — driven by ~46pt of real average worse
entry price. **User's own question ("are they addressing the same trade just differently?") led
to the real finding**: decomposing immediate-entry's 205 signals into "overlap" (139 days that
also pull back — Arm A's entry fires) vs "exclusive" (66 days that NEVER pull back — Arm A
structurally can't take these at all) showed the exclusive population alone is worth
**EV=$85.54/trade — more than double Arm A's $37.54/trade on its own population** — a real,
currently 100%-unexploited opportunity (~15% of all classified-drive days). Volume-building does
NOT discriminate which bucket a day falls into (score distributions barely differ, median -0.41
vs -0.20) and is actually mildly counterproductive as a filter within the exclusive bucket
(bottom tercile $111.43 > top tercile $65.07) — ruled out as the tool for this specific job.
Recorded as `RESEARCH_CLAIM setup_d_immediate_entry_vs_pullback_decomposition` (PROVISIONAL).

**Discriminator screen ran, same session** (`scripts/backtest_setup_d_opening_drive_stage3_screen.mjs`,
dispatched to Gemini, independently re-verified byte-for-byte): of 6 candidates, **drive
magnitude at confirm-close is a real, OOS-validated discriminator** — `(price - OR boundary) /
OR range`, signed by direction. Exclusive days had already traveled a median 0.69 OR-ranges by
10:15am vs 0.38 for overlap days; holds on a chronological train/test split (train AUC=0.293,
test AUC=0.329, same direction, doesn't decay). Honest caveat: this is close to "already-traveled-
further is mechanically harder to fully retrace," not a hidden order-flow secret — still real,
previously-unused information though. All 5 other candidates (order-flow imbalance,
volume-building, lookahead-corrected NL30 alignment, gap status, structural-level proximity)
came back genuinely null (AUC 0.45–0.51). Recorded as `RESEARCH_CLAIM
setup_d_drive_magnitude_discriminator` (PROVISIONAL).

**Built and OOS-validated, same session** (`scripts/backtest_setup_d_opening_drive_stage4_hybrid.mjs`):
a hybrid rule — immediate entry when drive magnitude clears a threshold, otherwise the existing
pullback-wait entry. Threshold (median split, 0.479 OR-ranges) picked using ONLY the
chronological train fold (4 pre-registered candidates, no fine grid search), then applied blind
to the untouched test fold: baseline (pullback-only) EV=$33.07/classified-day → hybrid
EV=$41.96/classified-day, a real **$8.89/classified-day OOS lift**. Rigor-clean, no
day-clustering (top5DayPct=2.7%), stable across all 3 chronological thirds. Tautology check (is
this just "ran out of time to retrace"?) came back reassuring, not conclusive — both an
ample-remaining-time and a thin-remaining-time subgroup show a comparable positive edge.
Recorded as `RESEARCH_CLAIM setup_d_hybrid_drive_magnitude_entry_oos_validated` (PROVISIONAL).

**Wired live SHADOW-only, same session** (`server/routes/acd.js`'s `openingDrive15Min` block):
at confirm-close, if drive magnitude clears `DRIVE_MAG_IMMEDIATE_THRESHOLD` (0.479, hardcoded
fallback pending a dedicated calibration row — same bootstrap pattern the pullback path's own
stop/target already uses), fires immediately using the confirm-close bar's own price (not
`currentPrice`, to avoid drifting away from what was actually backtested) with its own
stop/target (159/80); otherwise falls through to the existing pullback-wait logic unchanged.
`existingSetup`'s per-(trade_date, setup_type) dedup already guarantees this fires at most once
per day regardless of which branch a given poll takes — no new time-window guard needed.
`test_invariants.mjs` shows no new regressions (same 6 pre-existing FAILUREs). Still SHADOW-only
(no real trade alerts) — real forward data needs to accumulate and confirm this before any
promotion consideration, standard pipeline.

**Separately requested, not yet built**: a real excursion check (MFE/MAE, uncapped) on the
"immediate entry" population showed the current 80pt target is likely too tight (median real
favorable run ≈98pt, p75≈140pt, p90≈246pt) and the 159pt stop lets ~25% of trades' real adverse
excursion through — but MAE and MFE are comparably sized (median 88.5pt vs 98pt), so a wider
fixed target alone probably isn't the fix; a trailing/runner mechanism (already built and
validated on a different family earlier this session) is the more promising next angle, not yet
tested on this specific setup. Sizing-up this setup (user's own suggestion, given its rarity) is
reasonable in principle but premature before real forward SHADOW data exists to size against —
revisit once it does.

**Exit-mechanism follow-ups, all tested and closed out this session** (user: "test all avenues"):
velocity (magnitude/time-to-break) added nothing beyond drive magnitude as a discriminator or MFE
predictor (test AUC ≈ random). A fixed multiple of the trailing-20-day 1-min-bar-range as an
ATR-scaled target/stop lost decisively to the current fixed 159/80 both in-sample and OOS. A
precisely-confirmed Sierra Chart "ATR Ranges" level (read directly from the user's own study
settings: session-open ± 10-session RTH ATR) does NOT reliably pin the real MFE — spread over 200
points in the middle 50% of trades — nor does a prior-week high/low for overshoots (N=20, same
problem). One real, smaller pattern did emerge: bearish big-break drives tend to reach/exceed the
ATR-low, bullish ones tend to fall short of the ATR-high — a directional bias, not a magnet.
Recorded as `RESEARCH_CLAIM setup_d_atr_weekly_level_exit_negative` (CONFIRMED). User's own take:
"ATR gives a general target but not spot on" — consistent with the data.

**Bearish floor / bullish bimodality claims, tested and closed out**: the claimed "~200pt minimum"
for bearish drives once volume-building is confirmed sustained is false — even the top-tercile
building subset shows median MFE only ≈119pt (N=16, thin), with 200+ reached by roughly the top
15-25% of cases, not a floor. The "shoots up quickly OR grinds up all day" bullish pattern is real
but not in the way floated — fast-peaking drives (<60 bars) are typically the SMALLER moves
(median ≈60pt, N=21), slow-grinding ones (≥180 bars) the bigger ones (median ≈118pt, N=11, thin) —
different-sized outcomes, not two equal paths to the same result.

**Exit-mechanism comparison, tested and closed out**: a proper fixed-target sweep, the already-live
breakeven-trail runner, and the already-live wider-target-on-fast-arrival mechanism (both reused,
not reimplemented) were all tested against the current live 159/80 on this exact population, with
one real bug caught and fixed along the way (a walk-loop off-by-one vs this codebase's own
`resolve()` convention — made zero practical difference once corrected, since 1-min bar ranges are
far smaller than these stop/target distances). Breakeven-trail is a clear loser (-$21 OOS,
confirms it's a mean-reversion-tuned mechanism, a category error here). Wider-target is a wash
(effectively identical to baseline; this setup develops too slowly for the mechanism's own
fast-arrival assumptions to even engage). A tighter fixed target initially looked like a small
win but its own OOS thirds are decaying badly ($171→$78→**-$104**) — not trustworthy. **No change
made** — the live 159/80 stands, nothing tested earns the right to replace it. Recorded as
`RESEARCH_CLAIM setup_d_exit_mechanism_comparison_negative` (CONFIRMED).

**Wider target sweep and re-entry test, both settled** (`scripts/backtest_setup_d_stage6_widersweep_reentry.mjs`,
independently re-run, numbers reproduced): a comprehensive fixed-target sweep (60-250pt × 3 stops)
confirms the current 80/159 is the actual WINNER of the whole grid — nothing wider comes close
(100pt drops to $24, 120pt+ falls to near-zero or negative). Re-entry after an exit is a decisive
loser (single-entry EV=$36.53/day vs with-re-entry=-$4.96/day) — re-entering specifically after a
TARGET_HIT is catastrophic (N=55, -$77.66 added EV per bucket), re-entering after a STOP_HIT is
mildly positive but far too small to offset it (N=14, +$8.79), and the whole idea gets worse over
time, not better. Recorded as `RESEARCH_CLAIM setup_d_wider_target_sweep_settled_negative` and
`RESEARCH_CLAIM setup_d_reentry_after_exit_negative` (both CONFIRMED).

**Setup D exit-mechanism thread now fully closed**: after testing ATR-scaled targets, ATR/weekly
pinning levels, the breakeven-trail runner, the wider-target mechanism, a comprehensive fixed-target
sweep, and re-entry — all negative — the live 159/80, single-entry, no-re-entry exit stands as the
validated-by-elimination design. No further exit-mechanism work planned unless new evidence
surfaces (e.g. once real forward SHADOW data accumulates for the entry rule itself).

## ✅ 2026-08-31 (RESOLVED): IB_BULLISH/IB_BEARISH — real thesis doesn't match the live code at all; redesign scoped, tested, both suppressed

User question ("IB_BEARISH continues to stink, how is it still live") led to a real-data audit
that found a live misleading-text bug beyond the already-known
`ib_daytype_calibration_structurally_unreachable` gate issue — the alert's `tier` label is a
dead constant (`dtClass` null collapses it to the same value every fire), and the description
text hardcodes a "best day-type" claim that's empirically wrong per real data, one that has
flipped 3 times across 3 independent audits in this file's own comment history (noise being
re-discovered as signal, not a stable effect).

**Then the user clarified what these setups are actually supposed to be**: capitalize on a
break-and-retest of the 60-min Initial Balance boundary, then drive until the move exhausts.
That reframed the whole thread — confirmed the live code (`computeIbBullBear()`) implements
none of it: no break-of-boundary check (only a midpoint-position check), zero "retest" logic
anywhere in `acd.js`, no drive/continuation confirmation, fires as one unconditional snapshot
the instant IB closes. The entry signal never tested the thesis it's named for, which plausibly
explains the whole history of unstable, contradictory day-type findings.

Rectified against siblings per user request: `OPEN_TEST_DRIVE_LONG/SHORT` (test-then-drive off
the open) is the closest existing analog and is a decisive real negative (EV -$29.54/-$14.74,
N=113/106, suppressed since 2026-07-05) — a real prior worth weighing, though the IB boundary
(60-min-earned, widely-watched) is a different anchor than a single open price. The general
structural-breakout-retest engine (`docs/STRUCTURAL_BREAKOUT_RETEST_SPEC.md`) already tested
this same shape of idea on swing pivots and got a clean 0/8 negative — second independent
caution. `IB_HIGH_FADE`/`IB_LOW_FADE` (fade thesis) and `STOP_SWEEP_LONG/SHORT` (reversal
thesis, currently `ACTIVE` and fine) confirmed as different families, left alone.

Full doc rewritten: `docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md` now leads with a
concrete break/retest/drive detector (Idea 1, PRIMARY) as the real redesign — required confound
controls (immortal-time-bias, structural-advantage control arm) explicit up front, given the two
negative priors. Exit shape naturally pairs with the wider-target/breakeven-trail mechanisms or
the 2-lot scale-out thread scoped earlier this same session (a continuation trade fits a
runner-style exit far better than the current fixed 30-45pt target). Two refinements folded in:
reusing the already-live `vol_building_signal` specifically as a live drive-vs-exhaustion gauge
DURING the trade (not just an entry filter, per the user's own refinement), and a continuous-
strength upgrade path for the break/retest/drive parameters once validated. Would be one of the
only genuine trend-continuation bets in a ~118/122-fade roster, matching the user's documented
breakout-trading preference — a real reason to test properly, not a guarantee of success given
the priors.

**Step 1 shipped same session**: removed the dead `tier` field (`server/routes/acd.js`, a
dtClass-keyed ternary that always evaluated to the same value — dtClass is null at this point in
the live session, so every live IB_BULLISH fire showed `tier='WEAK'`, every IB_BEARISH fire
showed `tier='MARGINAL'`, regardless of actual conditions) and the two hardcoded "TREND days:
strongest"/"TURBULENT: strongest. BALANCE: suppressed" description claims (unverified static
text, contradicted by real data). Grepped first to confirm no frontend component reads this
setup's `.tier` field — pure no-op on display. The live `_edgeText()` call still gives the real
blended-EV summary. `node --check` + `eslint` clean.

**Step 2 shipped same session**: dispatched the plan (not code) to DeepSeek for a design critique.
Audited the result before acting on it (per the standing "audit all model output" rule) — caught
one misread (DeepSeek claimed a hard contradiction between Idea 1's retest tolerance and Idea 3's
deferral; the spec's own text already resolves this, Idea 3 only defers the OTHER two params).
Everything else checked out and is now incorporated into the spec: resolved state-machine
definitions (break=close not wick, fixed-fraction-of-IB-range retest tolerance for v1 not
ATR-relative, one-signal-per-day, distinct-bar sequencing to kill an intra-bar lookahead risk), a
redesigned confound-control plan (the naive "blind-delayed-entry" control was invalid for a
direction-committed setup — replaced with an all-break-days control + a placebo/level-swap
control), a new confound (drive-confirmation distance is itself a momentum filter), and an
exit-shape correction (the fade-validated wider-target/2-lot-scaleout mechanisms are a category
error for a continuation trade's return shape, not just mistuned — must be re-validated from the
observed forward-return distribution, not reused wholesale). Full detail:
`docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`'s new "DeepSeek design critique" section.

**Step 3 (the placebo/level-swap test) ran and came back CLEAN NEGATIVE, same session.**
Dispatched to Gemini, independently re-verified (Gemini's script omitted its own print calls;
re-added them, re-ran directly against `gemini_readonly`, every number reproduced exactly — see
`scratch/reproduce_ib_placebo_test.mjs`). NQ 1-min RTH bars, 2022-12-14 to 2026-08-31, 449 days.
The real IB boundary showed flat-to-negative, sign-inconsistent forward returns and was actually
WORSE than an economically meaningless IB-midpoint placebo on the bearish side across all 3
horizons (20/40/60min) — this directly refutes the one differentiator ("a widely-watched,
60-min-earned level") that justified testing IB despite the two prior negatives (`OPEN_TEST_DRIVE`,
the structural-breakout-retest engine). The all-break-days control also showed the retest+drive
filter adds no measurable EV over trading the raw break. DeepSeek's design critique predicted
this exact outcome on mechanism grounds before the test ran. Recorded as
`RESEARCH_CLAIM ib_break_retest_drive_placebo_test_negative` (CONFIRMED). Full numbers:
`docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`'s new "Step (a0) result" section.

**RESOLVED, same session: user confirmed "dump them both."** Implemented via a new
`MANUAL_SUPPRESS_OVERRIDE` in `scripts/backtest_setup_status.mjs` (removed both from
`DAY_TYPE_CONDITIONAL`, which was itself the mechanism giving them a pass whenever any one
bucket cleared the bar). Ran the pipeline live — both now show `recommendation='SUPPRESS'` in
`performance_audit`, picked up by `_suppressedSetups` on the next poll, same SHADOW-only
treatment as every other suppressed setup_type. `OPEN_DECISION
ib_bullish_bearish_audit_and_redesign_scoped` resolved. Full detail:
`docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`'s final section.

**New thread opened the same turn**: user wants to figure out how to capitalize on genuine big
breaks/continuation moves — not a revival of the IB-specific idea, a fresh direction. Not yet
scoped.

## 🔶 2026-08-31 (RESOLVED): computeRigor() gets a z-score trend field, closing a 2026-08-04 decision

Resolves `OPEN_DECISION add_z_score_trend_to_rigor_stability_gate`. `computeRigor()`'s existing
3-way chronological `stable` check collapses each third to a same-sign boolean, so two
setup_types passing it identically can have very different real trajectories (the original
finding: `GLOBEX_VWAP_MAGNET_LONG`'s per-third z-score strengthened 1.49→2.84→3.02 while its
RTH sibling eroded toward noise 2.46→1.78→0.94, both "stable"). Added `zScores {z1,z2,z3}` and
`zTrend` (`STRENGTHENING`/`DECAYING`/`MIXED`, null when thin) as standing output fields —
each third's mean divided by its own standard error, same ≥5-events-per-third gate as the
existing fields, informational only, never feeds `clean`. Surfaced everywhere `boundaryStraddle`
(the 2026-08-17 precedent) already was: `rigorContext()` plus all 3 real consumer sites in
`backtest_setup_status.mjs` (the local helper, the main SUPPRESS/PROMOTE gate's notes, and the
`SETUP_STATUS_DOW` sub-pass's notes + blended_rigor). Verified via a live re-run: 0 DOW
suppressions before and after (unchanged from baseline — `clean`'s gating logic untouched),
`zTrend` populated for exactly the same rows where `stable` is computable, `test_invariants.mjs`
shows no new failures.

## 🔶 2026-08-31 (RESOLVED): condition_memory rebuilt after a month-long daily_performance_log pipeline gap

Two-part fix, resolves `OPEN_DECISION condition_memory_needs_rebuild_not_backfill` (HIGH, open
since 2026-08-19). **Part 1 — pipeline gap**: the catch-up mechanism that populates
`daily_performance_log` only ever checked whether *today's* row existed, so a trade landing
after its own calendar day had passed (confirmed: 2026-08-03 and 2026-08-12 trades were both
imported in one batch on 2026-08-12 20:52 ET, 9 days late for 08-03, amid a server-instability
window matching the already-fixed pre-2026-08-18 "multiple simultaneous nodemon supervisors"
bug class) permanently never got backfilled — `daily_performance_log` stalled at 2026-07-31 for
a month with zero errors logged. Fixed with a bounded historical scan added to `server/index.js`'s
existing 30-min self-healing cron; both missing dates manually backfilled and verified same turn.

**Part 2 — condition_memory rebuild**: the original double-counting concern (occurrences/wins/
losses inflated up to ~6x by a since-removed redundant `setInterval`, fixed 2026-08-19 with an
idempotency guard that stops NEW corruption but does nothing to un-corrupt existing counters).
Confirmed before rebuilding: `sum(occurrences)=1088` across 31 rows vs. only 343 real qualifying
`daily_performance_log` rows (~3.2x inflated in aggregate). Rebuilt via `scripts/rebuild_condition_memory_20260831.mjs`
— backed up first (`condition_memory_backup_20260831`, cataloged in `docs/DB_BACKUP_CATALOG.md`),
wiped, then replayed every qualifying date chronologically through the now-idempotent
`updateConditionMemory()`. Deliberately done in this order (pipeline fix first) per the original
decision's own sequencing note — rebuilding from a still-broken source would have just
re-encoded a fresh gap. Verified: post-rebuild `sum(occurrences)=343` exactly matches the
qualifying date count, live endpoints (`/api/pattern/combinations`, `/api/pattern/today-combination`)
spot-checked, `test_invariants.mjs` shows no new failures (6 present failures are pre-existing
OPTIMAL_STOP circuit-breaker trips, confirmed unrelated and already tracked separately).

## 🔶 2026-08-31: 2-lot scale-out (breakeven-minus-5 runner) — SECOND pass with a real structural target, both open questions resolved, PROVISIONAL

Follow-up to the same-day scoping doc (`docs/TWOLOT_SCALEOUT_BREAKEVEN_MINUS5_SPEC.md`). First
pass (`RESEARCH_CLAIM twolot_scaleout_be_minus5_orshort_firstpass`, now superseded) used the
setup's own tight `t1_level` as a placeholder runner target — user confirmed both remaining open
questions the same day (runner arms the INSTANT Lot 1 fills; runner target should be a real
structural level, not the setup's own tight target), so `scripts/backtest_twolot_scaleout_be_minus5.mjs`
was rebuilt to pull the nearest known `level_prices` level below Lot 1's exit (prior-period-only
categories, no lookahead — see script header for the full category list) as the runner target.

Population: real (`ACTIVE`+`SHADOW`) OR-length SHORT-fade family, N=140 (picked up 1 new fire
since the first pass), 139 walkable, 130 usable at the winning T1 candidate (9 excluded per
candidate where no structural level existed below Lot 1's exit that date). **Best T1=12pt**:
delta vs exit-all-no-runner mean=**+$7.63/trade**, plateau-clean, `computeRigor` clean, bootstrap
98.9% positive. **Meaningfully stronger OOS behavior than the first pass**: train +$7.57/trade
(N=91) vs test +$7.75/trade (N=39) — nearly identical, versus the first pass's train/test
near-halving ($12.04→$6.19). Outcome composition also improved: targetHit share rose from 33.1%
to **46.2%** (now the largest of the three buckets, not just a minority tail) — structurally
explained, not a fluke: the first pass's target could sometimes sit closer than a wider T1
candidate and "win" trivially; the structural-level version can't, by construction. Full
breakdown, level-usage distribution, and remaining gaps in the spec doc's "Second-pass result."

**Still not done:** independent re-verification (single script's own output); comparison against
the user's actual current live/described strategy as the *primary* baseline (an `exactBe`
reference arm is computed, exit-all-no-runner remains primary). Broader generalization to other
"struggling" setup_types was raised and explicitly deferred by the user — tracked separately,
`OPEN_DECISION twolot_scaleout_generalize_to_other_setups` (LOW), with a recommended screen
(Setup Reference's "Left on Table" metric) for whenever it's picked up.
`RESEARCH_CLAIM twolot_scaleout_be_minus5_orshort_structural`, `PROVISIONAL`.

## 🔶 2026-08-30: Real, systemic Globex session-end bug found and fixed in 3 live exit mechanisms

User asked "why didn't the target widen at 3 bars" on a real Overnight/Globex `PD_POC_FADE_SHORT`
fire (id 109426). Root cause: THREE separate live exit mechanisms — wider-target
(`widerTargetWalker.js`), breakeven-trail (`breakevenTrailWalker.js`), and bank-vs-extend (acd.js's
inline `extendTarget` branch) — each independently hand-rolled the identical
`isSessionEnd = bar.ts.slice(11,13) >= '16'` check, an RTH-only assumption. For a Globex-hour fire
(e.g. 18:00 ET), this is already true on the very first bar, permanently blocking these mechanisms
from ever arming on an overnight trade. A fourth, compounding bug in the retroactive
`/api/setups/:id/wider-target-counterfactual` display endpoint's own bar-fetch SQL made it return
`no_bar_data` for every single Overnight/Globex trade, always (not a one-off on this specific
trade). **Verified empirically before fixing**: no real Globex-hour fire has EVER armed
`wider_target_mult`/`extend_target_level`/`runner_trail_width` — this was a dormant bug for live
trades, not an active mispricing, but would have silently misfired the moment any Globex-eligible
setup_type became eligible. Fixed with a new shared `server/services/sessionBoundary.js`
(`isPastMechanismSessionEnd()`) applied consistently across all 3 mechanisms + the display
endpoint, whose own bar-fetch was also fixed to bound correctly for a Globex-origin trade (was
`ts::date=trade_date AND mod<=960`, which mismatches on BOTH axes for a Globex fire). **Verified
against the real trade**: id 109426 now shows it would have captured $88 instead of $58 under the
wider-target mechanism — $30 left on the table, invisible until this fix. Added 9 new synthetic
regression tests (5 wider-target, 4 breakeven-trail) proving both RTH behavior is unchanged and the
new Globex behavior is correct; no `test_invariants.mjs` regressions (verified via `git stash`).
`RESEARCH_CLAIM globex_session_end_bug_fixed_three_mechanisms`.

Older resolved/superseded threads are periodically moved to [OPEN_THREADS_ARCHIVE.md](OPEN_THREADS_ARCHIVE.md) (via `node scripts/archive_open_threads.mjs --apply`) to keep this file's per-session read cost down — nothing is deleted, just relocated. Still-pending items are backed by `OPEN_DECISION`/`RESEARCH_CLAIM` rows regardless, so archiving here never buries anything.

## 🔶 2026-08-30 (correction): DeepSeek full-audit found a real classifier bug — fixed, finding survived and got stronger

A dispatched DeepSeek code review of everything below found that `classifyLevelFormation()` had a
real bug: it put 13 real PRIOR_PERIOD setup_types (`PD_IB_HIGH/LOW/MID`, `PD_OR_MID`, `5D_OR_MID`,
`10D_IB_MID` — all literally "PD_" for Prior Day) into `SAME_DAY_FORMING`, contaminating ~15% of
the headline bucket. Worse: this duplicated an axis that already existed as an authoritative table
(`setupDefinitions.js`'s `LEVEL_FADE_DEFINITIONS[].rule`) — a "check for an existing source of
truth first" miss, not just a regex-coverage miss. Fixed by rewriting the classifier as a
projection over that canonical table. **Re-ran every affected analysis on the correction — the
finding got stronger, not weaker**: SAME_DAY_FORMING gap $11.95→**$14.40/trade** (N=276),
walk-forward $12.19→**$13.38/trade** (N=216, still stable across all 3 thirds). Full account:
`RESEARCH_CLAIM momentum_ctx_sameday_corrected_after_deepseek_audit` (cite this one going forward),
correction detail in `docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`'s top section. The same audit
also caught and fixed 4 smaller issues in the live endpoint (a tradeDate convention gap during
18:00-23:59 ET, a session label that didn't distinguish the 5-6PM maintenance halt from live RTH,
a bucket guard checking only 1 of 4 required calibration fields, an inconsistent JSONB key set on
one early-return path) — all fixed in the same pass. A separate, unrelated real bug it surfaced
while cross-checking live figures — `/api/setups/performance-summary` showing 3 different ACTIVE
P&L numbers on the same page — was flagged, then fixed same-day on direct request: both the chart and table queries in
`GET /api/setups/performance-summary` now use the canonical `REAL_TRADE_FILTER` (imported from
`scripts/backtest_setup_status.mjs`) instead of their two different ad hoc filters. Verified live:
both now show $1,422.11 for ACTIVE, matching each other and the canonical figure.
`OPEN_DECISION setups_performance_summary_three_disagreeing_populations` resolved.

**Also tested a follow-up hypothesis and it failed, honestly**: does a level's "provenance" (real
observed volume structure vs. pure arithmetic formula) predict fade performance, independent of
volume-building context? Ranked every non-same-day level into `VOLUME_PROFILE_STRUCTURE`
(POC/VAH/VAL/VWAP) / `REAL_EXTREME_POINT` (a real high/low/open/close) / `PURE_ARITHMETIC` (floor
pivots, camarilla, weekly/monthly pivot points) and tested against the real trade population.
SAME_DAY_REAL confirmed best again (EV=$7.72/trade, independently reconfirming today's headline
finding from a totally different angle) — but the bottom 3 tiers didn't follow the predicted order:
`PURE_ARITHMETIC` (EV=$1.76) actually beat `VOLUME_PROFILE_STRUCTURE` (EV=-$8.52, the *worst*
tier) and `REAL_EXTREME_POINT` (EV=-$3.99). Checked for a single-bad-level confound (ruled out —
excluding all 4 VWAP variants still leaves POC/VAH/VAL alone at -$6.20/trade). `RESEARCH_CLAIM
level_provenance_tier_hypothesis_rejected`. A likely uncontrolled confound: each setup_type has its
own independently-calibrated stop/target, so this test entangles level-provenance with calibration
quality — **tested and ruled out** (`RESEARCH_CLAIM level_provenance_tier_gap_is_real_not_calibration`):
MAE/MFE (measured independent of whichever stop/target a setup happens to use) tracks the exact
same tier ranking — SAME_DAY_REAL has the only favorable MFE/MAE ratio (1.15), VOLUME_PROFILE_STRUCTURE
the worst (0.91). This is a real, raw difference in how price behaves after these touches, not an
artifact of some setup_types having better-tuned exits than others.

**Spot-check on stop/target calibration health (user question, "does anything look funny with
stops and targets"): yes.** Scanned all 146 `OPTIMAL_STOP` rows. Two things: (1) the underlying
EV-sweep, when unguarded, repeatedly proposes extreme stop:target skew (stop 3-19x the target) for
several thin/volatile setup_types (`GLOBEX_VWAP_MAGNET_LONG/SHORT`, `VWAP_MAGNET_SHORT`,
`IB_BEARISH`, `STOP_SWEEP_LONG`) — none of these are live (a separate risk-ceiling guardrail
rejects them), but the sweep keeps computing them, suggesting a systemic blind spot in how it
handles thin/noisy samples. (2) `IB_BULLISH` — a currently LIVE, active setup — has real N=60 but
89.2% of that N comes from just its top 5 calendar dates (8 distinct dates total); its live
stop/target is stable only because a circuit breaker is blocking the sweep's proposed move, not
because the calibration is actually trustworthy at this breadth. 3 more setup_types
(`GLOBEX_VWAP_FADE_SHORT`, `OR5_LOW_FADE_SHORT`, `PD_VAH_FADE_SHORT`) show the same pattern.

**Both resolved same day, on direct request.** (1) `scripts/update_optimal_stops.mjs`'s
`applyCircuitBreaker()` now has a data-derived plausibility gate — a `PLAUSIBLE_SKEW_CUTOFF`
recomputed each run from the 95th percentile of currently-live stop:target ratios (146 pairs →
2.55x this run); any candidate skewed beyond it is rejected (or loudly flagged if it's a
setup_type's first-ever calibration, since there's no prior to fall back to). Verified via
`--dry-run`: computes correctly, no crashes, no `test_invariants.mjs` regressions. (2) A new
"OPTIMAL_STOP CLUSTERING WATCH" section in `.claude/hooks/session-start.sh` surfaces every live
setup_type whose REAL calibration sample concentrates in a handful of dates — invisible to the
existing `DAY_TYPE_MANAGED WATCH`, which only sees the blended (real+BACKFILL) population.
Verified live: surfaces **`GLOBEX_VWAP_MAGNET_LONG`/`SHORT` calibrated from just 3 real distinct
trading days (100% of their sample)** — worse than the `IB_BULLISH` case that started this thread
— plus `VWAP_MAGNET_LONG`, `IB_BEARISH`, `STOP_SWEEP_LONG`, `PD_VAH_FADE_SHORT`. Neither change
silently suppresses anything; the `IB_BULLISH`-style live-status judgment call itself is
deliberately left to a human, just impossible to miss now. `OPEN_DECISION
optstop_sweep_implausible_rr_thin_samples` resolved. Found and separately flagged a real,
unrelated bug while building the watch: `FLOOR_R1_FADE_LONG`'s current `OPTIMAL_STOP` row has two
JSON objects string-concatenated in its `notes` field (a 2026-08-09 annotation-writer bug), which
aborts a naive bulk `::jsonb` cast — worked around defensively in the new query, root cause not
yet fixed (`OPEN_DECISION optstop_notes_malformed_json_concatenation`, LOW).

**DeepSeek review of both changes crashed again at the 900s timeout, but — same as earlier today
— left a real, substantive, independently-computed critique before it did**, catching two genuine
issues in the plausibility gate before it ever ran for real: (1) a bug — the new freeze reason was
missing from the 2026-08-19/20 method-relabeling fix, silently reopening that exact stale-label
bug for this one new path; (2) a methodology problem — the cutoff was derived from the live
stop:target population itself, which turned out to be more circular than assessed (73% of that
population shares one placeholder method, and the gate can only ratchet its own bound down over
time since it's computed from what it already accepted). Both verified independently before
fixing, not just trusted. Fix: the cutoff now derives from the real population's own p75-MAE-vs-
p75-MFE ratio (external ground truth, N≥20 real trades, verified n=28/p95=2.02) instead of the
sweep's own output, and a new `test_invariants.mjs` check [23] surfaces the one remaining gap
DeepSeek found (a flagged-but-accepted edge case that was previously only visible in cron logs).
`RESEARCH_CLAIM optstop_plausibility_gate_corrected_after_deepseek`.

## 🔶 2026-08-30: Same-day-forming vs inherited levels — the fade-filter thread's best, walk-forward-stable finding, plus a fresh-context validation exercise

Continuation of the 2026-08-29 volume-building thread below. The connective test onto the fade
roster (does building-strength context predict fade outcome) got a real breakthrough today:
splitting by WHETHER A LEVEL FORMED THIS SESSION (Initial Balance / Opening Range) vs is INHERITED
FROM A PRIOR PERIOD (prior-day value area, POC, VWAP, floor pivots, camarilla, prior-week/year,
3-month) explains almost all of the earlier per-family disagreement. SAME_DAY_FORMING levels show
an $11.95-12.19/trade gap (ACTIVE vs QUIET prior-30-bar backdrop), walk-forward-stable with the
sign never flipping across 3 chronological thirds (N=324, `RESEARCH_CLAIM
momentum_ctx_sameday_walkforward_stable`, status CONFIRMED) — the strongest, best-vetted finding
in the whole thread. Confirmed consistent across its own Initial-Balance vs Opening-Range
sub-components and across session timing (mid-session vs late/dead-zone). PRIOR_DAY_OR_DEVELOPING
levels show almost no effect ($2.17/trade) and a follow-up attempt at an alternate predictor there
(distance from prior-day POC) came back weak/non-monotonic — **that half of the roster's fade
filter is a genuinely open, unsolved question**, not a dead end papered over. The classifier behind
all of this (`classifyLevelFormation()`) is now a shared, exported function in
`server/config/setupTypes.js` — its first draft (regex only in a scratch script) had a real
coverage gap (missed `OR*_HIGH`/`OR*_LOW`) that diluted the finding for a full research pass before
being caught; any future script needing this distinction must import it, not re-derive it.
**Still NOT wired live** — correctly parked as a future size-multiplier-factor candidate (never a
new setup_type — this is an unconditional 100%-of-touches split, the exact anti-pattern this
codebase already learned to avoid) pending more real N past the current ~1 month of tracked
history. Full account, every sub-test, every number: `docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`.
Remaining open angles: `OPEN_DECISION volume_building_thread_untouched_angles_for_later` (updated
today with the current, accurate list — supersedes its own 2026-08-29 version).

**Also ran a deliberate fresh-context validation exercise** — spawned an independent Sonnet
instance with zero memory of this conversation and had it bootstrap itself the way a real future
session would (read `CLAUDE.md` → `OPEN_THREADS.md` → the spec doc → memory files → query
`record_claim.mjs`/`flag_decision.mjs` directly), then answer real questions about this thread's
status with no answers fed to it. It reconstructed the substance correctly and found one real,
fixable gap: **this file's dated section headers had gone one day stale relative to the live
tracked state** — today's `momentum_ctx_sameday_*` chain (arguably the most load-bearing findings
in the thread) existed only in the spec doc and the database, not as a dated entry here, meaning a
rushed cold read of this file alone (stopping before checking `flag_decision.mjs --list`) would
have concluded the fade-filter work was further behind than it actually is. This entry is the fix.
Secondary, non-blocking observation: `record_claim.mjs --list`/`flag_decision.mjs --list` output
is long enough that a naive `tail` on it can truncate past the most relevant recent entries —
grep or redirect-to-file instead of tailing when checking these lists.

## 🔶 2026-08-29: "Initiative" moves tested independent of any level — real non-directional volatility precursor found, no directional edge

User asked whether volume-building/pace ever fires "out of nowhere" (no nearby level) and whether
there's a pattern in that population. Per the hard rule that a market-behavior hypothesis goes
through raw bars before `active_setups` (no live setup fires without a level touch, so there was no
trade-level population to test this on at all), built a fresh bar-level scan over 60 days of NQ
bars (`scratch/scan_volume_building_no_level_context.mjs`, `scratch/scan_volume_building_magnitude_doseresponse.mjs`),
reusing the live `computeVolumeBuildingMeasures()` unchanged. Findings, persisted as
`RESEARCH_CLAIM volume_building_no_level_initiative_test`:
- **The phenomenon is real**: ~49.5% of all "building" bars sit >8pt (sample median) from every
  known level — building fires constantly, independent of level proximity.
- **No directional edge**: forward-move-matches-recent-push-direction rate sits at 48.6-51.3%
  across every group/horizon tested, indistinguishable from the 49.7% unconditional coin-flip
  baseline. A user follow-up ("just looking for a move in either direction... any intel") redirected
  the test from direction to magnitude.
- **Real, confound-checked magnitude signal**: composite building-strength dose-response (N=58,338)
  shows a clean monotonic increase in 20min max-excursion, Q1=42.6pt → Q5=57.1pt, top decile 44%
  larger than bottom decile. Checked against the obvious confound (Q5 just being RTH-open
  clustering) and it's the opposite — Q5 is *underrepresented* at the open (1.9% vs 4.0% in Q1) —
  and the same monotonic pattern holds independently within RTH-only (55→78pt) and Globex-only
  (34→54pt) subsets, clearing the RTH+Globex-both-required bar.
- **Conclusion**: volume-building strength is a real non-directional expansion precursor — it says
  a bigger swing is coming, not which way. Not wired anywhere live.

Also closed out a still-outstanding negative from the prior session in the same pass: the vaPos
(distance-from-prior-POC) structural-discernment idea was recorded as REJECTED via
`RESEARCH_CLAIM vapos_prior_poc_distance_family_artifact` — the pooled roster-wide positive split
was shown by within-family control to be a family-composition artifact (INITIAL_BALANCE_MID and
GLOBEX_VWAP families each reversed sign from the pooled direction).

**Tested same-session, `OPEN_DECISION test_volume_building_strength_as_fade_stop_target_modifier`
now RESOLVED**: does firing an existing level-fade at high building-strength (predicting a bigger
incoming swing) predict worse fade outcomes than firing at low building-strength? N=1,080 real
fade trades matched to bars. **Rejected as a blanket rule** — roster-wide EV by quintile isn't
monotonic ($3.50 → -$2.38 → -$1.04 → -$6.51 → -$3.55), and the within-family control split
opposite-signed again: `INITIAL_BALANCE_HIGH_LOW` and `OTHER` get meaningfully worse at high
building (matches the hypothesis), but `PD_VALUE_AREA_EDGE` and `GLOBEX_VWAP` get *better*
(reverses it). Per-family N is thin (22-174), so not fully decisive per family, but it rules out
wiring a single stop/target-width modifier across the whole roster — a 5th recurrence of the
pooled-verdict mantra inside the same research thread. `RESEARCH_CLAIM building_strength_as_fade_filter_mixed_negative`.
The underlying volatility-expansion finding itself is untouched by this — only the "use it to
adjust existing fades" connection failed.

**Two more angles on the same expansion signal, both confound-checked in RTH and Globex
separately**: (1) **Momentum feeds momentum, not a coiled spring** — a building-strength spike
riding on top of an already-elevated recent 30-bar backdrop predicts a BIGGER move (RTH: 62.6→88.7pt,
+41%; Globex: 47.9→60.6pt, +27%) than the same spike arriving out of a quiet stretch — the opposite
of the classic "quiet before the storm" intuition, and consistent with the existing wide-IB-days-
predict-TURBULENT finding in `docs/COMPRESSION_TAIL_MFE_SPEC.md` from a different instrument.
`RESEARCH_CLAIM building_strength_momentum_feeds_momentum`. (2) **Lead time is real but partial** —
of the biggest realized moves, 39% show zero elevated-building warning in the preceding 15 minutes
(this signal will simply miss them); of the 61% that do get a warning, median lead is 13 minutes,
though ~40% of those were already elevated at the full 15min scan boundary (right-censored — true
lead time for that subgroup likely longer, worth re-running with a wider scan window before
treating 13min as final). `RESEARCH_CLAIM building_strength_leadtime_before_big_moves`. Neither
wired anywhere live — pure market-behavior findings, both confirmed independently in RTH and
Globex.

**Self-correction, same thread**: decomposed the lead-time result into flicker count (how many
distinct elevated episodes precede a big move, not just when the first one started) and the "37min
early warning" does NOT hold up — flicker frequency before a big move (avg 2.28 in the preceding
60min) is essentially identical to a random baseline moment (avg 2.19), and gaps between flickers
don't shrink as a move approaches (17.0min vs 16.7min, flat). The 37min lead was mostly a base-rate
coincidence, not real anticipatory clustering — retracted via `RESEARCH_CLAIM
building_strength_leadtime_is_base_rate_artifact`. Does not affect the contemporaneous magnitude
dose-response or momentum-feeds-momentum findings, which measure the same-moment relationship, not
lead time.

**Also checked whether the magnitude dose-response holds the same shape across day-types**
(`acd_daily_log.day_type` — BALANCE/TREND/TURBULENT, an end-of-day RTH classification, distinct
from the live intraday `dtClass` column already flagged elsewhere as structurally null all day).
It doesn't: BALANCE days reproduce the clean staircase (38.75→51.39pt across quintiles); TREND and
TURBULENT days instead go flat across Q1-Q4 and only jump at the extreme Q5 (+27%/+19%) — a
threshold rather than a dial once the day is already active. `RESEARCH_CLAIM
building_strength_doseresponse_shape_differs_by_daytype` (day-level N still thin: 8 TREND, 4
TURBULENT days — recheck as more days classify). Full write-up:
`docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`.

**Last thread pulled, then shipped as informational-only wiring (2026-08-29)**: checked whether
momentum-feeds-momentum also flattens by day-type the way the raw dose-response did — it doesn't;
it holds across all three and is strongest on TREND (1.43x vs BALANCE's 1.18x and TURBULENT's
1.24x), making it the single most generally-useful finding in the thread
(`RESEARCH_CLAIM momentum_feeds_momentum_robust_across_daytype`). Both headline findings were then
independently replicated by Gemini via a blind dispatch (own from-scratch script, re-run locally to
confirm — `RESEARCH_CLAIM volume_building_findings_independently_replicated_by_gemini`), and on that
basis wired live as informational-only: `computeLiveVolumeBuildingSignal()` now stamps
`compositeStrength`/`momentumContext` on every real fire (all 5 insert sites, one shared function),
and a new read-only `GET /api/acd/building-strength-live` backs a non-directional "Expand" gauge
chip on `quick-check.html`'s pulse bar. Neither gates or sizes anything. DeepSeek reviewed the
actual code changes for correctness (not the statistics, already confirmed) before this was
considered done. Flagged remaining untouched angles (session-boundary interaction, a narrower
fade-filter retry, momentum-feeds-momentum's own dose-response) via `OPEN_DECISION
volume_building_thread_untouched_angles_for_later` (LOW). Full write-up:
`docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`.

## 🔶 2026-08-29: DeepSeek design critique on 2 "prior structure as S/R" ideas, then a whole-roster volume-building extension found the pooling-hides-subgroups mantra recurring a 4th time

Dispatched DeepSeek for a phase-0 design critique (read-only, no code/mining) on refining two
unbuilt ideas the user recalled from prior sessions: `docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md`'s
Idea E (structural volume-node context — is a level sitting on real historical volume or an air
pocket) and `docs/RUNNER_OPTIMIZATION_NOTES_20260814.md`'s swing-anchor trailing stop, both aimed
at RTH_FLUSH/GLOBEX_FLUSH and the roster-wide volume-building signal. Two of DeepSeek's most
concrete claims independently verified against the live DB: `computeVolumeProfileForRange`
(`developingValueService.js:104`) uses an uncoalesced `volume` column while every other signal in
this codebase uses `bid_volume+ask_volume` — confirmed 186 real rows where the two disagree, a
genuine (if currently null-safe) inconsistency risk. Full critique: identifies Globex VWAP as the
single most decisive test case for Idea E (not profile-derived by definition, unlike POC/VAH/VAL —
if it doesn't show real volume structure, the hypothesis is broken at its own pivotal case); for
the swing-anchor trail, recommends denominating everything in flush's own balance width (zero new
parameters) and testing via a drop-in second exit simulator on the EXISTING N=336 backtest
population rather than waiting for live trades or fixing the schema-blocked optimizer — but
against the ALREADY-LIVE building-widened target (~190pt), not the flat 77pt one, or any "trail
beats fixed target" result is a guaranteed false positive. Full critique persisted in both spec
docs; `OPEN_DECISION`s not yet flagged (design-only, no build committed to yet).

**DeepSeek's own cheapest suggested test — re-run the family split with FAMILY-specific cutoffs
instead of roster-wide ones — was run and came back the OPPOSITE of what it predicted: the IB
reversal is real, not a cutoff artifact** (family-specific: BUILDING EV=-$23.43 N=21 vs NOT
EV=$8.88 N=100, an even cleaner split than the roster-wide-cutoff version). This means the
structural volume-node hypothesis is better motivated, not worse — Globex VWAP is the next
falsifying test if this thread continues.

**User then asked to tag the WHOLE roster (not just fades) and see what pops up — this both found
something new AND caught the pooling-hides-subgroups mantra recurring a 4th time, one level
deeper than before, within the same research thread.** `STOP_SWEEP` (not a fade, a stop-hunt-
reversal setup) showed a real split (BUILDING WR=75% EV=$33.06 N=8 vs NOT WR=59.6% EV=$2.72 N=57)
— a genuinely new candidate outside the fade family. But splitting the earlier FAMILY-level
groupings apart by individual type revealed they were themselves still pooled too coarse:
`IB_HIGH_FADE` alone is positive (EV $37.25 vs $9.64) while `IB_LOW_FADE` alone is a severe
negative (EV -$78.67, WR 16.7%, vs $2.26) — pooling the two directions made "Initial Balance" look
uniformly bad. Symmetrically, `PD_VAH_FADE` alone is mildly negative while `PD_VAL_FADE` alone is
strongly positive (EV $39.36, WR 85.7%) — pooling made "value-area edge" look uniformly good. Full
numbers: `RESEARCH_CLAIM volume_building_full_roster_type_level_splits`. Every individual split
here is N=6-22/bucket, thinner than the family-level splits and not walk-forward tested at this
granularity — real and worth tracking, not yet actionable. The recursive nature of this finding
(roster → family → individual type, each level hiding another real split) is now folded into
`feedback_pooled_verdict_hides_opposite_signed_subgroups` memory as its own update.

**Same-day follow-up: user asked whether STOP_SWEEP's new finding was actually being tracked live
— it wasn't, and the reason is a real gap.** Found a **5th `active_setups` INSERT site** in
`acd.js` (the `shadowCandidates` loop, ~line 9645) that the 2026-08-28 volume-building wiring never
touched — this is the actual path `STOP_SWEEP_LONG/SHORT`, `IB_BEARISH`, and `C_PAIRED_SHORT` fire
through, distinct from the main RTH/Globex candidates loops. It had no `vol_building_signal` column
at all. **Fixed**: wired the same `getSessionBarsSinceOpen(570)` + `computeLiveVolumeBuildingSignal()`
pattern used at the other 4 sites, for every setup_type that fires through this loop (not just
STOP_SWEEP). Dry-run verified in a rolled-back transaction (param count + column mapping correct,
`vol_building_signal` round-trips into the right column), lint/syntax clean, clean restart with
zero new errors. This means every real setup_type in the system now gets tracked live, not just
the FADE roster — closes the gap the earlier whole-roster retroactive check (which computed
measures directly from historical bars, independent of live stamping) had exposed.

**Same-day: built a new standalone Home Assistant page per direct user request** —
`server/public/setup-performance.html` (`GET /setup-performance`, linked from quick-check's nav),
backed by a new `GET /api/setups/performance-summary` endpoint (`server/routes/setups.js`). Shows
every real (origin_status ACTIVE/SHADOW only) setup_type with its N/WR/EV/rigor-trend in a
sortable table (N<20 rows visually dimmed, matching this project's own decisive-N floor), plus a
day-by-day cumulative $ P&L chart with a per-setup dropdown (default: all real setups combined).
**Chart is dollars only, not normalized to a % of account size** — first considered a fixed $50k
account-size denominator, but the user caught a real problem before it was built: a fixed-account
percentage would make normal week-to-week swings look artificially dramatic (a good week jumping
5-10% isn't a meaningful "account move" at MNQ's real scale), so plain cumulative dollars was used
instead. Verified: dry-run-free (this endpoint is read-only), Playwright-checked (table renders
all 169 real setup types, dropdown/chart interaction works, zero console errors, thin-N dimming
confirmed via class inspection), reachable both locally and through the Cloudflare Tunnel (a 302
to Cloudflare Access on the tunnel = working correctly, matching quick-check's own behavior).
**Any future standalone page under `server/public/` needs the same two-part wiring**: an explicit
route in `server/index.js`, AND a matching exact-path entry in `~/.cloudflared/config.yml`
(outside this repo) for both the page itself and any API endpoint it calls — missed the second
part on the first pass here, caught it before considering the feature done. Restarted
`cloudflared-trading-journal.service` for the config change to take effect. Full convention now
recorded in CLAUDE.md's quick-check entry.

## 🔶 2026-08-28: Volume-building vs winners/losers — single-type check, then roster-wide, plus a reference-frame question

User recalled asking earlier to check "market levels and volume builds as potential entries" and
specifically asked to verify a factual recollection about `PD_VAH_FADE_SHORT` SHADOW misses. Actual
count checked directly against the DB: **11** SHADOW-origin `STOP_HIT` losses (not 15 as recalled),
and **not** spread out in time — 7 of 11 landed in the last 2 trading days. Comparing SHADOW winners
(N=5, `TARGET_HIT`) vs losers (N=11) on touch-bar relative volume and 10-bar approach volume-building
(both using the existing lookahead-safe convention: bars up to and including the touch bar only)
showed **no visible separation** — winners were actually slightly quieter at the touch than losers.

User asked to broaden this to the whole fade roster (matching the already-flagged `OPEN_DECISION
apply_volume_building_signal_to_existing_level_roster`) and separately asked whether the
volume-building baseline itself should be measured relative to that day's own volume rather than
(or in addition to) that time-of-day's historical volume. Built
`scratch/fade_roster_volume_building_daycompare.mjs` against the full real FADE population
(`origin_status IN ('ACTIVE','SHADOW')`, resolved `STOP_HIT`/`TARGET_HIT`, N=1322 across ~130
setup_types) and tested both baselines:

- **Existing time-of-day-relative volZ** (90-bar-per-minute-of-day historical z-score —
  `getVolumeBaseline()` convention, used everywhere else in the codebase): pooled roster-wide,
  BUILDING is actually *worse* than not (EV -$1.67/trade N=342 vs -$1.10/trade N=980) — a genuine
  pooled null/inversion, not a rounding artifact.
- **New day-relative volZ** (z-scored against that same session's own running volume since the
  last session open — RTH 9:30am or Globex 6pm — min 10-bar sample): pooled, shows a real if modest
  separation in the expected direction (DAY-BUILDING EV=$0.37/trade N=355 vs -$1.85/trade N=872).
- **The two measures are not redundant.** They agree ~74% of the time. The 2x2 shows the cleanest
  cut of the whole test is the AGREEMENT bucket (both say building, N=175, EV=$1.81/trade) — and the
  worst bucket is where time-of-day says building but day-relative disagrees (N=167, EV=-$5.30/trade),
  worse than either measure predicts alone.
- **Per-setup_type breakdown (N≥8 each side) shows the pooled null hides real per-type effects** —
  same shape as this session's earlier Globex mode-pooling lesson. `IB_HIGH_FADE_SHORT` (BUILDING
  N=12 WR=92% EV=$74.67 vs NOT N=41 WR=68% EV=$31.85), `OR5_HIGH_FADE_SHORT` (N=11 WR=73% EV=$83.45
  vs N=21 WR=52% EV=$19.57), `PD_POC_FADE_SHORT` (N=11 WR=73% EV=$29.26 vs N=32 WR=59% EV=-$8.62),
  and `PD_VAL_FADE_LONG` (N=17 WR=71% EV=$16.41 vs N=20 WR=50% EV=-$0.35) all show building
  meaningfully *better*. `PD_VAH_FADE_SHORT` (N=14 WR=36% EV=-$12.91 vs N=42 WR=43% EV=-$1.35) and
  `GLOBEX_VWAP_FADE_LONG` show the opposite — matching the single-type negative found first.

Recorded as two `RESEARCH_CLAIM`s (`fade_roster_volume_building_pooled_vs_pertype`,
`volz_day_relative_vs_timeofday_reference_frame`), both `PROVISIONAL` (exploratory, single-pass, no
train/test split, per-type Ns individually thin at 11-17). `apply_volume_building_signal_to_existing_level_roster`
resolved with this result. **Not wired live** — the honest next step, if pursued, is either a
per-type SHADOW pilot on the 3-4 highest-N types that show the split, or a bigger combined sample
using the AND-gated (both-measures-agree) definition before sizing/gating anything on it.

**Same-day follow-up: does firing on the "both-agree" filter beat firing on every touch, and does
tightening it further keep improving?** Yes to the first — baseline (fire on every touch, no
filter) is N=1328/WR=49.5%/EV=-$1.24/trade; requiring EITHER measure alone doesn't move the needle
(N=523/WR=49.5%/EV=-$1.59, no better than baseline); requiring BOTH to agree does (N=174/WR=51.7%/
EV=$2.40/trade). Tightened the both-agree filter from the median up through the 90th percentile on
all 4 measures to check whether more selective touches keep getting better — **not a clean
dose-response**: p60=N105/WR=54.3%/EV=$7.11 (real, still well above the N≥20 floor, roughly 3x the
median cutoff's EV) is the trustworthy sweet spot; p67=N55/WR=54.5%/EV=$1.00 already weakens; p75
reverses to EV=-$7.94/N=22; p80 bounces back to EV=$9.71/N=13. Past ~p60 the sample gets too thin to
trust and the numbers are noise, not a real "more certain = even better" trend — recorded as its own
`RESEARCH_CLAIM fade_roster_volume_building_dose_response_cutoff` so this exact caveat isn't lost.

**Same-day, wired live SHADOW-style (informational only, self-recalibrating): user asked to wire
this in across the whole roster and keep recalibrating it, rather than leave it as a one-off
finding.** Since this isn't a new setup_type (it's a property of every existing fade touch), "wire
it in" means: stamp the 4 raw measures + median/p60-agreement booleans onto every real fade fire's
`active_setups.vol_building_signal` (new JSONB column), across BOTH RTH and Globex, without gating
what fires or how it's sized — the same informational-only pattern already used for
`exhaustion_signal_at_detection`/`bar6_checkpoint`/`confluence_score_at_detection`. Built:
- `server/services/touchQuality.js`: `computeVolumeBuildingMeasures()`/`classifyVolumeBuilding()`,
  the single shared functions both the live code and the calibration script call (no
  reimplementation) — day-relative z uses only bars strictly BEFORE the one being scored, no
  lookahead.
- `scripts/backtest_volume_building_signal.mjs`: recalibrates median + p60-percentile cutoffs for
  all 4 measures from the real roster-wide FADE population, persists a single
  `VOLUME_BUILDING_CALIBRATION`/`ROSTER_WIDE_FADE` row. First run: N=1121 matched. Added to
  `run_weekly_backtests.sh` — self-recalibrates as real forward data accumulates, per this
  session's own standing "we're experimenting" rule (not gated on rigor/day-clustering).
- Wired into 4 `active_setups` INSERT sites in `acd.js`: the RTH level-fade candidates loop's
  SHADOW branch, ACTIVE branch, and early-touch-backfill branch (correctly sliced to bars up to
  the touch's OWN time, not "now", to avoid lookahead in the backfill case), plus
  `detectGlobexSetup()`'s Globex path (a freshly bounded since-session-open bars query, `ts<=NOW()`
  upper bound per the `price_bars_primary` convention). Does **not** touch
  `RTH_FLUSH`/`GLOBEX_FLUSH` — those fire from their own separate `rthFlushDetector.js`/
  `globexFlushDetector.js` pollers with their own already-built volume-building logic from the
  earlier redesign this session; `vol_building_signal` is simply null on those rows.
- Verified per this session's own new standing rule (never trust manual `$N` counting): dry-ran
  all 4 modified INSERT statements in a rolled-back transaction with sentinel values, confirmed
  correct param count and that `vol_building_signal` round-trips into the right column for each.
  Lint clean, server restarted clean, no new errors in `scratch/server_errors.jsonl` post-restart.

Migration: `ALTER TABLE active_setups ADD COLUMN vol_building_signal JSONB` (informational-only
addition, no backfill of historical rows — they simply have `vol_building_signal IS NULL`).

**Same-day, user requested a real walk-forward validation of the both-agree-at-p60 filter before
trusting it further — it FAILED.** Split the real population by date (TRAIN=first 25 of 37
distinct dates, TEST=last 12), froze cutoffs from TRAIN only: in-sample the filter looked strong
(EV $2.14→$15.52), but out-of-sample it did WORSE than an already-negative baseline
(EV -$4.34→-$18.06). `computeRigor()` on the filtered population confirmed it: 56% clustered in 5
days, EV degrading monotonically across chronological thirds ($15.55→-$9.75→-$17.56). **The earlier
single-pass $7.11/trade finding was very likely an in-sample artifact of a ~7-week-old dataset, not
a real edge** — recorded as `RESEARCH_CLAIM fade_roster_volume_building_walkforward_negative`
(`STALE`). Does not change the live wiring (still informational-only, still self-recalibrates) —
this specifically means the signal is NOT yet validated for gating/filtering anything.

**Follow-up: grouped by coarser level family** (OR-mid, Initial Balance high/low, Initial Balance
mid, value-area edge, POC, Globex VWAP, etc., ~19 families) to check the user's specific hypothesis
("does OR-mid or IB do better with this?"). Only 3 of 19 families have enough N (≥10 each side) to
say anything — `PD_VALUE_AREA_EDGE`, `PD_POC`, `GLOBEX_VWAP` — all 3 point the same direction
(building helps) but still thin and not walk-forward tested at this granularity.
**OR_MID/INITIAL_BALANCE specifically can't be tested yet** — too few of those touches ever clear
the ROSTER-WIDE p60 cutoff on both measures (OR_MID: 6/76 qualify; IB high/low: 9/124; IB mid:
3/71), likely because early-session (OR/IB-formation-window) touches have a structurally different
volume profile than the rest of the roster, which a single roster-wide cutoff penalizes. Recorded
as `RESEARCH_CLAIM volume_building_by_level_family` (`PROVISIONAL`). Natural next step if pursued:
family-specific (not roster-wide) percentile cutoffs.

**Real bug found and fixed while verifying the walk-forward** (caught by checking whether the
signal's own values made sense, not by an error message): `getVolumeBuildingCalibration()` read
`performance_audit.notes` (a `TEXT` column storing a JSON string, matching every other calibration
script in this codebase) without `JSON.parse()`ing it — every `agreesMedian`/`agreesP60`
classification in production was silently comparing real numbers against `undefined` and always
returning `false`. Fixed with the same `JSON.parse()`/try-catch idiom used at every other `notes`
read site in `acd.js`. **A second, independent bug surfaced from the same investigation**: the RTH
candidates loop's `activeVbSessionBars`/`auditVbSessionBars` reused `allRthBarsRow.rows` directly,
which is scoped to the RTH window and stops growing at 4PM close — any SHADOW candidate firing
during the routine, daily 4-6PM no-new-entries dead zone read the SAME frozen last bar for the
entire 2-hour window regardless of its own real fired time. Confirmed live: 17 same-afternoon
dead-zone fires showed byte-identical volume measures despite firing 37 minutes apart across
different setup_types. Fixed by adding `getSessionBarsSinceOpen(boundaryMod)` — a bounded
(`ts<=NOW()`) query from the most recent session-open bar (RTH 9:30am=mod570, Globex 6pm=mod1080)
through now — and using it for both RTH branches and simplifying the Globex branch (which already
had the correct pattern, now deduplicated into the shared helper). Backfilled today's 22 affected
rows via `scratch/backfill_frozen_vol_building_today.mjs` (recomputed correctly per-row, verified
each now shows genuinely different values). Both fixes verified via a fresh `./stop.sh`+`./start.sh`
cycle (a mid-restart port race briefly left the systemd-managed instance serving instead of the dev
nodemon supervisor — cleaned up via the shared lifecycle scripts, not a hand-rolled fix, confirmed
single supervisor + systemd correctly `inactive` afterward) and a live API check showing the
backfilled rows' measures now vary correctly touch-to-touch.

**Same-day: added a tracking UI to the quick-check page** (`server/public/quick-check.html`),
per explicit user request to keep watching this signal across ALL setup types (not just the
3 promising families) ahead of any future decision to gate live entries on it. A new "Vol Building"
toggle row (All / Building / Strong, with live counts per option) filters the already-rendered
Session Timeline client-side — never affects what fires, matches the existing Live/All toggle's
own display-only pattern. Each row also gets a small neutral-colored "Vol+"/"Vol++" tag (not
green/red, deliberately — the signal isn't validated yet, styling it as a win/loss signal would
overstate its current status). Verified via Playwright: toggle renders, filters correctly, no
console errors, and the observed zero-count on today's actual dead-zone chop population is a real
reflection of the data (post-close chop genuinely doesn't show volume building), not a bug.

**Same-day, live user report: "I see it but can't click on it."** Root cause: both the new Vol
Building toggle and the pre-existing Live/All toggle attached click listeners directly to their
`<button>` elements, which get destroyed and recreated by `innerHTML` on every `loadTimeline()`
poll (every 20s). If a poll lands between touchstart and click on a real touch gesture, the button
node the user is mid-tap on gets replaced before the click fires — the tap is silently swallowed,
with no error, no visual glitch, just "nothing happens." Confirmed via a mobile-emulated Playwright
test that intentionally fires a re-render mid-tap. **Fixed** with event delegation: one
`document`-level click listener (added once, at boot, never touched by any re-render) matches
`e.target.closest('[data-tf]')`/`[data-vf]'` and dispatches to `setTimelineFilter()`/`setVbFilter()`
— survives every future re-render by construction, since it's never attached to the ephemeral
button nodes at all. Applied to both toggles, not just the new one, since they shared the exact
same structural risk. Re-verified the same mid-render-tap race test now succeeds (confirmed via
`localStorage` state, not `window.<var>` — top-level `let`/`const` in a plain `<script>` never
attach to `window`, a dead-end my first verification attempt walked into before switching to a
real external signal).

**Same-day: path-traced (not just win/loss) both new mechanisms per user request, and found a
real explanatory clue for the walk-forward failure.** RTH_FLUSH's first-ever real trade
(-$396.50) reached +47.75pt favorable before fully reversing to the stop over 67 minutes — flagged
as `OPEN_DECISION flush_setups_lack_breakeven_trail_protection` (LOW, N=1, not acted on). More
substantively: bar-by-bar tracing the walk-forward TEST period's "building" trades found they took
40% longer to resolve and jostled MORE (not less) than non-building trades — a plausible mechanism
for the earlier walk-forward failure (rising volume into a touch may mean a contested two-sided
fight, not one side winning decisively). `RESEARCH_CLAIM volume_building_path_shows_contested_
fight_not_clean_move`. Full short/long-term watch list: Claude's own memory
`project_flush_and_volbuild_execution_learning_20260828.md`.

## 🔶 2026-08-26: Liquidity zones / defended levels — DeepSeek design round, 5 detection ideas + a strategy answer, NOTHING BUILT

User asked directly how to spot liquidity zones/defended levels and how to trade them. Dispatched
to DeepSeek in two passes (first timed out mid-answer after finishing detection, cached progress
survived; a narrow follow-up finished the strategy half). Full doc:
`docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md`.

**Important framing correction the doc itself surfaced**: "defended level" was already built and
tested once in this codebase (`docs/DEFENDED_LEVEL_RETEST_SPEC.md`) — negative in all 8 tested
variants — but the real lesson wasn't "defense doesn't matter," it was "waiting to *watch* the
defense complete before entering costs more than the signal is worth" (now confirmed 3 independent
times in this codebase). Every idea in the new doc is built to cost zero bars of entry delay.

5 detection ideas (A-E, ranging from a parameter-free session hold-rate classifier to a repair of
the existing confluence-count factor's blind spot to level defense/undefense), all with kill
conditions and redundancy checks against ideas already tried and failed here. Strategy section's
headline recommendation: undefended = fade-suppression, not a directional flip (the one live
level-anchored continuation setup, `BRACKET_BREAKOUT_*`, is already strongly negative-EV) — and
the single most valuable, least-obvious application isn't sizing, it's feeding defense-strength
into the wider-target/runner mechanism's tail-MFE decision, since that's the one decision point
where the entry-delay problem doesn't apply (the wait is already sunk by the time it fires).

**Nothing has been run.** Every number in the doc is a citation of an existing finding, not a new
result — Claude independently verified the most load-bearing citations (the `DEFENDED_LEVEL_RETEST_SPEC`
numbers, `AIR_POCKET_SIGNAL_SPEC` status, `BRACKET_BREAKOUT` live EV, and the `sizeMultiplier` IIFE's
absolute-assignment lines underpinning the slot recommendation) — all matched. `OPEN_DECISION
liquidity_zones_defended_levels_ideas_pending_test` (MEDIUM) tracks the pending build; the doc's own
step-ordered sequence (idea D's free census first) is the recommended entry point if picked up.

**Update 2026-08-26 (same day, follow-on session): Step 0 (idea D's free census) run — Idea D
survives, but two real bugs had to be found and fixed first, one of them a genuine live-adjacent
data-pipeline gap unrelated to this thread.** Dispatched to Gemini per the standing mining-work
convention; both of its runs were audited directly against the DB rather than trusted at face value:

1. **Gemini's first run (N=2) was Claude's own query-design bug, not Gemini's.** The census query
   filtered on `size_factors_at_detection->>'minutesSinceVisit' IS NULL` to find "fresh" anchors,
   but `size_factors_at_detection` is a column added 2026-08-20 (only 6 days of data) while
   `confluence_score_at_detection>=2` has a real ~5-week, 595-row population back to 2026-07-23.
   Caught by directly counting both populations in the DB (`14` rows have the new column vs `595`
   total) rather than trusting Gemini's "insufficient sample" framing of its own correct execution.
2. **The fix (recompute anchor freshness from bars directly, like live `acd.js` does) surfaced a
   second, real, standing bug: `level_prices`'s same-day-forming levels (`OR5_HIGH/LOW/MID`,
   `OR10/15/30_HIGH/LOW/MID`, `IB_HIGH/LOW/MID`) had been frozen at their 2026-08-12 values for two
   weeks** — spotted because multiple example rows showed the *identical* `OR5_LOW` price across
   four different trading dates, which is impossible for a real daily opening-range low. Root cause,
   confirmed by direct testing: **both automated `compute_levels.js` crons (`server/index.js`,
   Sunday 9:30 PM for the next Monday, Mon-Fri 8:00 AM for today) run before that trading day's own
   RTH session opens**, so the CURRENT-category same-day-forming levels' `if (or_?.orh && or_?.orl)`
   /`if (ib?.h && ib?.l)` guards can never be satisfied at either cron's fire time — that day's own
   OR/IB literally hasn't formed yet. Manually running `node scripts/compute_levels.js <past-date>`
   immediately produced correct values, confirming the function itself was always fine; only the two
   crons' timing was wrong for this one category. **Confirmed NOT live-impacting** — live `acd.js`
   computes OR/IB directly from `acd_daily_log`/`price_bars_primary` each session, never from this
   table (verified via code read) — this only corrupted historical/research reads of `level_prices`
   (this census, and potentially any other script using `getLevelsForDate()`-style lookups for dates
   after 2026-08-12, e.g. the OR-length seasonality work in `docs/OR_LENGTH_SEASONALITY_SPEC.md`).
   **Fixed**: backfilled the gap (`node scripts/compute_levels.js --backfill --from 2026-08-13`,
   plus a direct run for 2026-08-26 itself), and added a third cron (`server/index.js`, 11:00 AM ET
   Mon-Fri, after IB's 10:30 AM close) that re-runs `compute_levels.js` for "today" once the day's
   own OR/IB actually exist. Server restarted cleanly via `./restart.sh` to pick it up (health check
   OK, `systemctl --user is-active trading-journal-server.service` → active; a pre-existing, unrelated
   "inconsistent types deduced for parameter $2" DB error was confirmed via `journalctl` to already be
   occurring 1800+ times/day before this restart, so not introduced by this change — not yet
   root-caused, flagged here rather than chased down mid-thread).
3. **Corrected census result** (re-run twice, final numbers below): of active, real
   (`origin_status IN ('ACTIVE','SHADOW')`) fired setups with `confluence_score_at_detection>=2` and
   a freshly-recomputed-from-bars anchor (`minutesSinceVisit`-equivalent === null), **11 of 12 (92%)
   had at least one cluster partner level already visited earlier in the same session** — nowhere
   near the spec's own "low single digits ⇒ dead" kill threshold from either this run or the
   intermediate N=75 run before the second bug was found (49%). **Per the spec's own pre-registered
   rule, idea D clears Step 0 and is worth building.** N=12 is well below this codebase's N≥20
   decisive-stat floor, though — this is a directional census answering "build or don't," not a
   validated EV/WR finding, and should not be cited as one. The large "partners with no computed
   price" drop count (284 of 607 raw rows, 964 individual partner lookups) surfaced separately —
   likely legacy pre-rename level names (`OR_MID_AFTER_IB`, the old name for `OR5_MID`) that no
   longer exist under that string in `level_prices` post-rename — noted for whoever builds idea D
   for real, not chased down further here.

**Update 2026-08-26 (same day, continued): Step 1 (idea C + idea A extraction) run — both DEAD,
via a rigor test that had to be corrected mid-thread.** Dispatched to Gemini (built
`scratch/pilot_liquidity_zones_idea_c_a.mjs`, session-wide touch-ledger walk-forward across the
full level universe, R/B/H from `OPTIMAL_STOP`/`TOUCH_QUALITY` calibration with a medRange
fallback where missing). Raw features preserved at
`scratch/liquidity_zones_idea_ca_features.json` (N=1045 real fired FADE touches).

**The first-pass redundancy check was the wrong test, caught by the user mid-review, not by
Claude.** The dispatch asked for a 2×2 of `holdRate` tercile × `sameDirN` (the live stacking
factor) and treated a sign-flip across that split as a kill condition. That's not a valid bar —
real trading signals are allowed to behave differently across market regimes (an interaction
effect), and demanding cross-sectional sign-agreement against an arbitrary secondary split isn't
how this or any real backtesting shop tests validity. **The correct test, applied instead: this
codebase's own shared `computeRigor()`** (`server/services/rigorDiagnostics.js`, already the
standing convention for every other mining pipeline here) — day-clustering (do 5 calendar days
account for over half a bucket's N) and 3-way chronological sign-stability (does the sign hold
across early/middle/late thirds of the bucket's own history). This tests stability *over time*,
which is the legitimate, non-negotiable bar — not agreement across a regime split.

**Result, via `scratch/rigor_check_idea_ca.mjs`**: every one of the 12 quartile buckets across all
3 metrics (`acceptedTimeFrac`, `holdRate`, `holdRateDistinctLevels`) **failed the chronological
3-way stability check** (`stable=false` in all 12 — sign never held across early/mid/late), and
9 of 12 were also **day-clustered** (`top5DayPct` 53-76%, i.e. 5 calendar days account for over
half that bucket's N). This is a cleaner, more decisive, better-grounded negative than the
original sameDirN check gave — not "the effect is regime-dependent" (fine) but "the effect isn't
stable over time and part of it is a handful of days getting counted repeatedly" (not fine).
**Idea C (`acceptedTimeFrac`) and idea A (`holdRate`/`holdRateDistinctLevels`) are dead** — no
`RESEARCH_CLAIM` written (nothing here cleared the bar to be one), consistent with the doc's own
instruction that nothing in it should be promoted to a claim until independently tested.

**Update 2026-08-26 (same day, continued): Step 2 (§3.1's breakout-context test) run — a real,
decisive positive, but the OPPOSITE of the spec's own hypothesis.** The spec asked whether an
"undefended" level licenses trading the breakout THROUGH it (continuation). It doesn't — but level
context turns out to be a real, strong FILTER on the already-validated compression-volume-breakout
signal (`scripts/backtest_compression_volume_breakout.mjs`'s `NO_COMPRESSION_CONTROL` arm, N=1516,
`+++` STABLE, +$11.13/trade at stop=138/target=102 — itself still research-stage, not live).
Splitting that same population by idea C's `acceptedTimeFrac` (via a new
`scripts/backtest_compression_breakout_level_context.mjs`, reusing the breakout-detection and
grid-simulation logic verbatim from the two already-validated scripts):

- No level within 15pt (N=313): **+$26.76/trade, `+++` STABLE**
- Level nearby, DEFENDED (bottom-tercile `acceptedTimeFrac`, N=394): **+$23.20/trade, `+++` STABLE**
- Level nearby, UNDEFENDED (top-tercile, N=393): **-$11.34/trade, `+--` MIXED — negative across
  ALL 27 tested stop/target combinations**, several of them `---` STABLE-negative

Confound-checked (mean time-of-day, `isCompressed` fraction) — both are similar across arms, and
the undefended arm is actually slightly *earlier* in the session on average, ruling out the
obvious "high `acceptedTimeFrac` just means more elapsed bars" artifact. Per the spec's own
pre-registered kill condition (headline cell 138/102, $4-5/trade bar), the breakout-instead
hypothesis is **closed permanently** — but the entire original +$11.13/trade average turns out to
be concentrated in the no-level/defended breakouts, with undefended-level breakouts actively
losing. `RESEARCH_CLAIM compression_breakout_undefended_level_filter` (PROVISIONAL, single-pass,
not yet independently reviewed). `OPEN_DECISION
wire_undefended_level_filter_into_compression_breakout` (MEDIUM) — the base breakout signal isn't
live yet either, so this should be wired together with it, not bolted on separately later.

**Separate thread, same session: re-verified an orphaned 2-month-old finding the user
independently re-derived from memory before being shown it.** User described "a big move, a
failed countertrend bounce, then resumption in the original direction" — this is exactly
`scripts/archive/backtest_post_flush.js`'s June 2026 finding (85% of >200pt-flush days close in
the flush direction; a "re-enter on balance breakout, hold to close" entry backtested at 54.7%
WR/$50.63/trade/N=64), which was **never persisted to `performance_audit`, never wired live, and
had its script swept into `scripts/archive/` — a real no-dead-ends gap, not a rejected finding.**
Re-verified via `scratch/backtest_post_flush_reverify.mjs`: fixed a stale hardcoded `$1` commission
(real value is `LIVE_INSTRUMENT.commissionPerRoundTrip=$2`) and applied `computeRigor()` for the
first time. **Population claim is clean and solid**: 85.4% close in flush direction, N=103 flush
days (up from 78 — 2 more months of data), not day-clustered, chronologically stable across all
3 thirds. **The specific entry rule is real but shows a declining-magnitude trend**: full history
+$41.79/trade (N=86, corrected commission, still `stable`/`clean` on `computeRigor()`) but its own
3 chronological thirds are $48.00 → $63.68 → $15.57 — sign-stable, not magnitude-stable. The
held-out post-2026-06-25 slice (data that didn't exist when the original claim was made) is
directionally consistent but thin: N=23, 52.2% WR, +$12.67/trade — clears the bare N≥20 floor but
is nowhere near enough to independently confirm on its own; Gemini's own response file called this
"VALIDATED," which overstates what N=23 can show — flagged and corrected before recording.
`RESEARCH_CLAIM post_flush_resolution_breakout_reentry` (PROVISIONAL, not CONFIRMED — the
declining trend and thin held-out N are real open questions, not resolved ones).
`OPEN_DECISION post_flush_resolution_breakout_wiring_decision` (MEDIUM) — also flags a real gap:
this system has no execution capability to force a close-of-day exit, so "hold to RTH close" as
tested may not be exactly reproducible live and needs a realistic exit-rule substitute before any
wiring.

**Update 2026-08-26 (same day, continued): flush precursor study — user correctly caught a
premature "dead end" call, real signals found once the methodology was fixed.** User asked
directly whether volume (vs 5/10-day baseline), price action, or level proximity signal a flush
before/during it. Dispatched to Gemini (`scratch/study_flush_precursors.mjs`); found real bugs on
audit rather than trusting the writeup — Test A (volume) produced a nonsensical 5.52x
control-group mean and `NaN` z-scores (unguarded division against a thin/outlier trailing-volume
baseline), Test C part 1 ("opens near a level," claimed 72.4%/84.5%) didn't reproduce (true rate
99.7-100% both groups — saturated/uninformative given ~68 tracked levels). **Test B (price action)
was initially accepted as a dead end because its numbers "looked sane," not because it was
independently checked — the user pushed back explicitly ("none of this is a dead end, you're not
looking close enough"), which was correct: it used a ~100-minute ATR ratio at the open (mostly
overnight bars) for what should have been a multi-day question.** Rebuilt cleanly
(`scratch/verify_flush_precursors.mjs`, `scratch/verify_flush_priceaction.mjs`), N=96 real flush
days vs 292 control: **(1) elevated recent-vs-longer-term daily range precedes a flush** (not
compression — 4 lookback pairs, z=2.3-3.1, `computeRigor()`-clean, though fading over time);
**(2) larger gaps precede flush days** (203.7pt vs 133.4pt, z=3.02, clean, NOT fading); **(3)
flush trigger points land near a known level significantly LESS than chance** (independently
reconfirmed the direction of Gemini's own Test C part 2, though the exact magnitude differed —
same structural story as the compression-breakout finding above: liquidity voids, not levels, are
where big moves both start and work). Genuinely confirmed dead (checked, not assumed): gap
direction, momentum direction, and streak length none predict flush direction. Net: real state
predicts THAT a move is brewing, not WHICH way. `RESEARCH_CLAIM
flush_precursor_volatility_and_gap` (PROVISIONAL). Full writeup with all numbers:
`docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.5.

**Update 2026-08-26 (same day, continued): structural-stop design requirement tested for RTH +
Globex — user's design instinct was right, first Gemini dispatch was wrong (units bug + a
different reimplementation, not a clean A/B).** User specified the resumption entry's stop must
sit behind the balance zone's structure, and asked for RTH+Globex both. Corrected result
(`scratch/verify_structural_stop.mjs`, reproduces the known-good RTH baseline exactly as a
correctness check): **RTH unaffected by the stop** ($41.79→$42.71/trade, both clean); **Globex
hold-to-close is genuinely broken** (-$71.00/trade, unstable) **but the same structural stop makes
it work** (+$36.79/trade, clean, N=24 — thin but real). `RESEARCH_CLAIM
flush_structural_stop_rth_vs_globex` (PROVISIONAL). Also found and fixed one more off-by-one
along the way (the "first 60 minutes" flush window is 61 bars inclusive, not 60 — flipped a real
date's resolution direction before being caught). Full numbers:
`docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.6. **Next step, not yet built**: the live "Flush
Watch" dashboard card (RTH + Globex, informational-only, per the user's stated preference for a
dashboard card without a push alert for now).

**Update 2026-08-27: starting-zone structure + full time-of-night profile for the Globex-DOWN
elbow — user caught a real reference-point mix-up, then a real session-boundary bug, then
correctly pushed back on a surprising result that turned out to hold up.** Three follow-ons in one
thread: (1) user clarified they wanted structure at the move's STARTING zone (the Globex open),
not the acceleration point already analyzed — re-run found prior-day value is the single most
common real structure at the start (38.7%, vs 21.0% by the time it accelerates), a genuinely
different and more useful answer than the original framing gave. (2) Building the full-session
timing profile (not just first-60-min) surfaced a real bug — calendar-date bucketing merged two
unrelated session chunks under one key, producing impossible 20+ hour "sessions" — fixed via real
RTH-transition boundary detection; confirmed no earlier claim in this thread was affected, since
they all only looked at the first 60 minutes. Corrected: departure from prior-day value usually
happens right at RTH close (median 4:15 PM), not overnight; the real acceleration is bimodal
(8-10 PM and 8-10 AM, the latter being the single largest window). (3) User was surprised
deep-overnight (10PM-6AM) accelerations were real and asked to check the full 2-3yr history rather
than trust a single readout — checked directly (chronological thirds + year-by-year): stable at
~29-37% across the whole ~2.75yr history, not a recent artifact. `RESEARCH_CLAIM
globex_down_value_departure_and_acceleration_timing` — the only CONFIRMED (not PROVISIONAL) claim
from this whole thread, specifically because the stability question got checked instead of
assumed. Full writeup: `docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.7 (starting-zone
correction) and §4.8 (timing profile).

**Update 2026-08-27: real MAE/target refinement for Globex, then the same battery re-run on RTH
(user's own request, not assumed to transfer) — two genuinely different, better-tuned designs
emerge.** Reconciled the two Globex thresholds this thread was carrying (borrowed 174.75pt vs the
real 119.50pt elbow) — the real elbow doubles the sample (N=49) and reveals the hold-to-close exit
actually fails chronological stability at that size; a real target from the trades' own MFE (~190pt,
75th percentile) fixes it and improves EV to $58.79/trade. Re-ran the identical battery on RTH:
starting-zone structure is even stronger there (prior-day value near the open 62.1% of the time vs
Globex's 38.7%, and genuinely open starts are 0% vs Globex's ~52%); entries cluster in a single
tight ~11 AM window instead of Globex's all-night spread; and — the interesting asymmetry — RTH
wants a SMALLER target (~123pt, 50th-percentile MFE) where Globex wants a LARGER one (~190pt,
75th), with the Globex-sized target actually breaking RTH's stability. Confirms these need to be
built as two separately-tuned designs, not one shared rule. User also decided this should fire
live as a real SHADOW-status `setup_type` ("GLOBEX_FLUSH"), not just an informational dashboard
card — not yet built, needs the standard new-setup-type checklist (own poller, since it doesn't
fit the level-touch candidate loop). `RESEARCH_CLAIM globex_down_mae_mfe_and_real_target` and
`rth_flush_full_parity_vs_globex`. Full writeup: `docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md`
§4.9-§4.10.

**Update 2026-08-27: pace-based target widener — user's intuition beat the naive hypothesis.**
Asked for a `stepWiderTarget()`-style pace widener (widen when the move speeds up, matching the
existing `eliteZone` runner pattern). That hypothesis was backwards for Globex — pace-vs-MFE
correlation is negative (-0.142); fast approaches to the balance-breakout entry are the WORST
bucket (EV=-$57/trade) while slow grinds (averaging 9.5 hours to reach entry) are among the best
(EV=$94-99/trade) — user predicted this directly before the numbers came back ("it's slower but
still extends sometimes but slower"). Tuned design (bottom two-thirds by pace get a wide ~193pt
target, fastest third gets a tight ~96pt target) beats the flat single-target version: $61.68-61.94
vs $58.79/trade, same N=49, still clean/stable. RTH tested in parallel for comparison — weaker,
hump-shaped, no individual tercile clears rigor at N=28-29, flagged as less-trustworthy than the
Globex result. `RESEARCH_CLAIM globex_flush_pace_based_target_widener`. Full writeup:
`docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.11.

**Update 2026-08-27: volume hypothesis — first test failed and reversed, refined test confirmed it
cleanly in both markets.** User asked whether a volume spike + overnight-range break predicts a
much bigger flush continuation. As literally tested (single-bar volume z-score), it failed and
REVERSED — predicted a smaller move in both RTH and Globex, consistent with this codebase's
already-confirmed `hivolLopace` finding (a volume spike without matching price movement reads as
exhaustion here, not continuation). User refined it precisely: not a spike, sustained volume that
"keeps building and pushing past." Rebuilt around sustained-and-rising volZ over the continuation
push instead of a one-bar snapshot — confirmed cleanly in both markets (RTH: +66% bigger move when
building; Globex: +103%, more than double), though both N (16/11) are thin and need more real data
plus a stability check. `RESEARCH_CLAIM flush_building_volume_predicts_bigger_move`. Full writeup:
`docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.12.

**Update 2026-08-27: replaced the arbitrary RTH 200pt trigger with a real structural one — best
RTH design found in the whole thread.** User asked why trigger on an arbitrary 200pt move at all
when this whole thread is about defended/structural levels — tested breaking the day's own Initial
Balance or the overnight high/low instead. Both are far more frequent (3-4x) and, despite smaller
per-trade edge, produce more total $ than the 200pt design. Checked overlap: 87% of days trigger
both, mostly the same underlying move (not two separate opportunities) — so the right design is
ONE unified trigger (whichever fires first), not stacking two trades. Result: N=336, WR=66.1%
(highest RTH win rate in this whole research arc), EV=$34.31/trade, total $11,528.50, clean/stable
with a RISING trend — beats every other RTH design tested on every axis. `RESEARCH_CLAIM
rth_ib_on_break_stacked_trigger_best_design`. This is now the recommended `RTH_FLUSH` definition.
Full writeup: `docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.14.

**Still not run** (liquidity-zones spec): Steps 3-7 of the doc's own build sequence (the
wider-target tail-MFE split, idea B [moot now, gated on idea A showing a pooled effect, which it
didn't], idea D's full build [still alive per Step 0], idea E). `OPEN_DECISION
liquidity_zones_defended_levels_ideas_pending_test` left PENDING (unchanged slug) — 3 of 8 steps
done, not the whole thread.

**Update 2026-08-27: RTH_FLUSH and GLOBEX_FLUSH wired live SHADOW-only — and a real Globex
session-boundary bug found in the process.** Built `server/services/flushMechanics.js` (shared
mechanism), `scripts/backtest_flush_patterns.mjs` (calibration), and `rthFlushDetector.js`/
`globexFlushDetector.js` (own pollers, modeled on `minuteBarSignalDetector.js`), wired into
`server/index.js`'s 60s cycle. While building the calibration script, found that every Globex
mechanism script this session bumped the session date at 4PM ET (RTH close) instead of the real
5-6PM maintenance-halt boundary, silently folding the closing day's own 4-5PM trading hour into
the following night's session. Fixing it collapsed the Globex side's apparent edge: recomputed
elbow ~81pt (not 119.50pt), `GLOBEX_FLUSH_LONG` WR=38.5%/EV=$0.62/N=26 NOT clean, `GLOBEX_FLUSH_
SHORT` WR=31.3%/EV=-$24.13/N=16 THIN_N — a dramatic reversal from §4.6-4.13's believed numbers.
`RTH_FLUSH` is unaffected (RTH never crosses a date boundary) and stays solid: LONG WR=67.3%/
EV=$30.66/N=162, SHORT WR=64.4%/EV=$34.69/N=174, both clean/stable. Wired both anyway (SHADOW
costs nothing, lets real data decide) per this session's own experimental-wiring standard.
`OPEN_DECISION globex_session_boundary_4to5pm_misattribution_bug` (HIGH, full writeup + whether to
re-derive the rest of §4.6-4.13 under the corrected boundary).

**Update 2026-08-27 (same day, continued): DeepSeek code review found a real BLOCKER — neither
detector had ever actually fired.** An unreferenced 9th SQL parameter (`price_at_detection`) meant
Postgres rejected every INSERT attempt at parse time; both detectors had been silently error-looping
every 60s since being wired, with zero rows ever written. Found 5 more real bugs alongside it: a
4-5h timezone bug in `fired_at` (local getters on a UTC-mislabeled bar timestamp — a documented,
intentional `db.js` convention that only round-trips through UTC getters), a one-sided optimistic
fill-price assumption (entry priced at the bare threshold instead of the resolution bar's actual
close — this alone cost 30-55% of RTH_FLUSH's claimed edge once fixed), a Globex session-array
contamination residual from the earlier boundary fix, a backtest/live trigger-definition mismatch
(argmax-over-window vs. running-max, a real lookahead + population divergence), and a live RTH
ONH/ONL query narrower than what the calibration actually used. All 6 independently verified by
reading the code directly, and both detectors' exact INSERT statements dry-run tested in a
rolled-back transaction with fabricated values (catching a SECOND real off-by-one — `t1_level`
bound to the wrong param — introduced while manually re-deriving the fix, underscoring why a real
execution check beats counting placeholders by eye). **Corrected, honest numbers**: RTH_FLUSH
stays real (WR 66.7%/64.9%, EV $13.45/$23.63/trade, N=162/174, clean/stable — smaller than first
reported but solid). **GLOBEX_FLUSH is now net NEGATIVE both directions** (WR 41.7%/38.9%, EV
-$38.09/-$31.13, N=24/18) — its own backtest-based SETUP_STATUS reads SUPPRESS/THIN_N, not just
weak. Both remain wired SHADOW (real forward N still governs live status, per
`minuteBarSignalDetector.js`'s precedent) but GLOBEX_FLUSH is now honestly an experiment on a
currently-negative backtest, not a shadow-track of an unconfirmed-but-promising one — worth an
explicit call on whether that's still worth running. Full writeup:
`docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.16-4.17.

**Update 2026-08-28: GLOBEX_FLUSH redesigned entirely — the "first 60 minutes" trigger was never
testing what the user actually asked about.** User caught it directly after seeing §4.17's
still-negative numbers: they'd asked about moves around midnight/2AM/5AM, and the mechanism only
ever looked in the first 60 minutes after a (redefined) session open — never reaching those hours
at all. This matches sec 4.8's own already-CONFIRMED finding (price leaves value by RTH close,
median 4:15 PM; the real move follows a median ~5 hours later) which was found during this same
research arc but never actually wired into the mechanism — §4.9 onward quietly built a different,
narrower design instead and the two threads were never reconciled. Redesigned to match sec 4.8
directly: check at RTH close through 4:30 PM whether price left `PD_VAL`/`PD_VAH`; if so, that
departure bar is the trigger (no magnitude filter needed — unlike the old design), and the SAME
balance/resolution/structural-stop mechanism watches continuously through the whole night instead
of a fixed window. Both directions tested fresh: `GLOBEX_FLUSH_LONG` N=167, WR=58.7%,
EV=$19.69/trade, clean+stable (real positive); `GLOBEX_FLUSH_SHORT` N=152, WR=50.0%,
EV=-$34.75/trade, clean+stable (real negative, honest SUPPRESS). `server/services/
globexFlushDetector.js` fully rewritten (own poll window now 4PM-9:30AM ET, `trade_date` anchored
to the departure day even when resolution lands past midnight). `RESEARCH_CLAIM
globex_flush_value_departure_redesign` (CONFIRMED). Full writeup:
`docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.18.

**Update 2026-08-28 (same day, third round): pooling by resolution direction alone STILL hid the
real signal — mode-aware pace+volume tiering, user's explicit final direction.** User caught that
LONG/SHORT (grouped only by final resolution direction) mixes two structurally different bets:
continuation (departure and resolution agree) vs. reversal (they disagree). Also correctly flagged
that a raw pace-vs-MFE correlation check (0.04-0.14, "too weak") was the wrong test — it can't see
a real non-linear/threshold effect, which is exactly the shape sec 4.11's original pace finding
had. Split by mode and re-ran pace as a proper tercile split (matching sec 4.11 exactly, not a
correlation): the real signal in this whole GLOBEX_FLUSH thread is specifically a DOWN-departure
that reverses UP — $37.06/trade pooled, but the slowest-pace third of that group alone is worth
$105.96/trade. An UP-departure that reverses DOWN is a confirmed, clean, stable structural loser
regardless of pace. Per user's explicit direction ("just wire it in... using pace and volume build
as we reviewed earlier"), built the full mode-aware design: each of the 4 (departure×resolution)
combinations gets its own setup_type and its own pace/volume-building 3-tier score (sec 4.13's
exact combined design), NOT gated on further rigor checks given only ~6 weeks of underlying data
history. Final: `GLOBEX_FLUSH_REVERSAL_LONG` N=75 EV=$99.93/trade clean+stable ACTIVE (the
best-supported number in this entire thread); `GLOBEX_FLUSH_LONG` N=92 EV=$14.98 weak/ACTIVE;
`GLOBEX_FLUSH_SHORT` N=66 EV=-$16.84 SUPPRESS; `GLOBEX_FLUSH_REVERSAL_SHORT` N=86 EV=-$46.84
clean+stable SUPPRESS. Reversal types classified `MEAN_REVERSION` bet_class (a reversion-toward-
value bet, matching `C_REVERSAL_LONG/SHORT`), not `CONTINUATION_LEGACY`. Volume-building window
capped at the entry bar this time — no lookahead. `RESEARCH_CLAIM
globex_flush_mode_pace_volume_tiered_final` (CONFIRMED). `server/services/globexFlushDetector.js`
fully rewritten again to compute mode + pace + volume-building live (reuses `getVolumeBaseline()`
from `touchQuality.js`). Full writeup: `docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.19.

**Update 2026-08-28 (reconciliation): went back through §4.4-4.14's original findings one by one
to confirm nothing was silently lost when the "first 60 minutes" mechanism got replaced.** Net:
nothing was wasted. The core mechanism (§4.4/4.6), RTH's own trigger (§4.14, unchanged), the
RTH-gets-flat/Globex-gets-tiered target asymmetry (§4.10/4.13), and the pace/volume methodology
(§4.11-4.13, now correctly re-located to the sub-population where it's actually strongest) all
carried forward and are live today. Only the Globex TRIGGER definition itself (§4.7/4.9's 119.50pt
elbow) was truly retired — replaced by §4.8's own already-confirmed finding, which had been sitting
one section earlier the whole time. Also resolved `OPEN_DECISION
post_flush_resolution_breakout_wiring_decision` (PENDING since 2026-08-26) — every question it
raised (real setup_type, a real exit rule beyond hold-to-close, RTH+Globex coverage) is now
answered by this build. Full writeup: `docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.20.

**Update 2026-08-27: applied the approach-quality lens to the ENTIRE existing fade roster (not just
flush) — a real methodology bug caught and fixed, real signal found, but only where it was
supposed to matter.** Asked whether a fast/no-volume-build ("sliced through") vs.
slow/rising-volume ("genuinely tested") zero-delay approach classifier improves fade outcomes
roster-wide, and separately whether it reveals a hidden good subset inside currently-suppressed
setup_types worth wiring back in. First pass (anchored on `fired_at`) got flagged by Claude itself
as "doesn't hold up" — user corrected this as a premature reversal ("you just totally changed your
tune... we're not changing the trajectory here"). Re-examining found the negative call itself was
premature (all 4 subgroups pointed the same direction even if individually thin), AND surfaced a
real bug: day-clustering in the result overlapped the session's own `LATENCY_CRITICAL` alert dates,
meaning `fired_at` was the wrong anchor for the approach window on laggy fires. Fixed by anchoring
on the LAST touch bar at-or-before `fired_at` (median lag 24s, matching real detection latency) —
a naive "first touch of the day" fix was tried first and was worse (63min median "lag", an artifact
of persistent levels sitting near price for hours). Corrected result: on CURRENTLY-ACTIVE
setup_types, the "TEST" bucket (slow pace + building volume into the touch) shows WR=75.0%,
EV=$49.94/trade, N=28, vs ACTIVE-overall EV=$17.50 — real, consistent, but thin/day-clustered
(clean=false, stable=true). On CURRENTLY-SUPPRESSED/THIN_N setup_types the same filter does NOT
rescue them (EV=$0.85 vs -$5.77 baseline) — answers the "wire suppressed setups back in" question:
no, not via this filter. `RESEARCH_CLAIM fade_touch_quality_test_slice_filter_active_setups`
(PROVISIONAL).

**Wired live same day, after a correction on how much rigor should gate acting on an experimental
finding.** Claude initially framed "wire now vs. wait for more real N" as an `OPEN_DECISION` to
deliberate — user corrected this directly ("stop looking for total consistency in the rigor...
this isn't trading real money, we're experimenting") and chose to wire it in now. Shipped: a new
`+0.15 sizeMultiplier` factor in `acd.js`, gated to ACTIVE-status setup_types only (matches the
finding's own scope), computed live off the last 10 RTH bars into each touch via a generalized
`getPaceBaseline(tradeDate, lag)` (previously hardcoded to 5, now parameterized — existing 5-bar
callers unaffected) plus the existing volume baseline. `node --check`/eslint clean on both the
backend change and the `AlphaEngineOverview.jsx` Size Multiplier Stack entry added for it; server
restarted and `/api/acd/setup-detection` verified returning 200 with no new errors (the live RTH
candidate loop itself will only actually execute this code path during market hours). `OPEN_DECISION
fade_touch_quality_test_sizeup_wiring` resolved.

**Update 2026-08-28: checked RTH_FLUSH for the same hidden mode-specific pace/volume effect
Globex had — found something real, but a plainer version.** §4.13's original "RTH pace/volume too
weak" call was made pooled, against the old 200pt-trigger population — the exact shape of test
that hid the real Globex signal until split by mode. Re-checked against RTH_FLUSH's actual live
trigger (stacked IB/ONH-ONL break), both pooled and mode-split. Mode-splitting made RTH noisier,
not clearer (opposite of Globex) — the plain pooled result is the cleanest one. Pace still doesn't
hold (confirmed unchanged, still noisy/inconsistent either way tested). But volume-building holds
up cleanly pooled, no mode split needed: BUILDING N=68 WR=66.2% EV=$40.79/trade clean+stable vs
NOT-building N=249 WR=65.5% EV=$14.72/trade clean+stable — both individually clear the rigor bar.
Wired as a 2-tier target: baseline flat ~77pt unchanged, widens to ~190pt (the building group's
own p75 MFE) when volume is genuinely building through the approach (window capped at the entry
bar, no lookahead). `RESEARCH_CLAIM rth_flush_volume_building_tiered` (CONFIRMED). Wired in
`server/services/rthFlushDetector.js`. Full writeup:
`docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.21.

**Update 2026-08-28: re-checked §4.5's precursor signals against the new trigger — a clean
negative, closing out the reconciliation thread.** Elevated pre-move volatility and larger gaps
were real precursors to the OLD, rare (~23% of days) 200pt-flush population. Neither transfers to
the new value-departure trigger, which is a much more common event (~86% of RTH days) — ATR ratio
direction is actually reversed and not significant (z=-0.77 to -1.34), gap size is directionally
similar but not significant (z=1.63, thin control group). Also checked whether either signal
predicts the single best-known segment (a DOWN departure that reverses UP) specifically — weak,
non-significant hints in the OPPOSITE direction (smaller gaps/lower volatility, not bigger/higher).
Plausible reading: a rare, dramatic 200pt move may need real preconditions to occur; closing below
yesterday's value does not. `RESEARCH_CLAIM globex_flush_precursor_signals_do_not_transfer`
(CONFIRMED negative). Nothing wired, nothing contradicts what's already live. Full writeup:
`docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.22. This closes the reconciliation review the
user asked for — both of its identified action items (RTH volume-building, precursor re-test) are
now done. Full writeup:
`docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md` §4.15.

## 🔶 2026-08-26: Turn-of-Month / OpEx-week seasonality — weak/inconclusive after fixing a real, systemic `price_bars_primary` data gap

Tested the externally-documented Turn-of-Month effect (last trading day of month + 3 more days —
cited as the single most robust seasonality effect in general market research) plus an OpEx-week
comparison against real NQ data. Gemini's script correctly used `price_bars_primary` and correct
window logic, but 6 of its 27 reported turn-of-month instances (22%) were corrupted by a real
quarterly data gap — consecutive array-indexed trading days were actually 66-74 CALENDAR days
apart (e.g. `2023-12-14` to `2024-02-19`), turning a claimed 4-day window into an accidental
2-3-month return. **This is the same data gap DeepSeek independently found earlier the same
session auditing a completely different script** — now confirmed via two independent scripts.

Claude caught it by checking each instance's calendar-day span (not originally requested),
rebuilt the analysis excluding gap-corrupted windows from both the event and baseline
populations. **Corrected result: Turn-of-Month is weak, not the "cleanly replicates" finding
Gemini's original writeup claimed** — T-stat drops from 1.44 to 0.64 (RTH) and the 3-way
chronological stability check now FAILS (middle third goes negative) where the corrupted run had
claimed all-thirds-pass. OpEx-week stays directionally negative either way but is too thin/noisy
(N=21) to call a confirmed negative. `RESEARCH_CLAIM turn_of_month_effect_weak_inconclusive`.

**The bigger finding is the data gap itself** — `OPEN_DECISION
price_bars_primary_systemic_quarterly_data_gap` (HIGH): a real, recurring roughly-quarterly gap
in `price_bars_primary` from Dec2023 through May2025 (6 confirmed occurrences, stopped after
May2025), root cause not yet investigated. Any script that builds a positional trading-day array
(`dates[i]`, `dates[i+1]`, ...) and assumes consecutive indices are consecutive trading days is at
risk of silent corruption whenever a window straddles one of these gaps — this has now bitten two
independent scripts in one session. Needs a standing calendar-continuity guard, not a one-off fix.

## ✅ 2026-08-26: Range-boundary rejection→traversal theory — RESOLVED NULL (a location confound explained both the "negative" and the "positive" readings)

User's planned "overnight-high-to-low" thread, scoped once restated: does rejecting at one side
of a range/level pair (`PD_VAH`↔`PD_VAL`, `IB_HIGH`↔`IB_LOW`, `ONH`↔`ONL`) predict subsequent
traversal to the opposite side? Built as a bar-level scan (market-behavior hypothesis, per the
standing rule this goes through `price_bars_primary`, not `active_setups`), 8 configs (both
directions × 3 pairs, PD_VAH/PD_VAL tested in both RTH and Globex, IB/ONH legitimately RTH-only
by formation-timing construction), 96-cell K-bar × REJECT_FRAC grid.

**Three full audit passes, each catching something the previous one missed** — a genuine
demonstration of why this codebase never trusts a single confident-sounding writeup:
1. **2 Gemini passes**, both caught by Claude reading raw output instead of trusting prose
   (2-strikes rule, Claude took over after #2): pass 1's flat full-window baseline had a real
   time-budget confound; pass 2 fixed that but its own writeup cited the wrong Z-score as the
   headline.
2. **Claude's own independent CSV read** (after pass 2) concluded IB/ONH were significantly
   NEGATIVE and PD_VAH/PD_VAL RTH was inconclusive — recorded as `CONFIRMED negative`. This
   verdict itself turned out to still be wrong.
3. **User explicitly said "something off"** and asked for a DeepSeek audit. DeepSeek found TWO
   real bugs Claude's own read had missed: (a) a direction-mislabeling bug affecting 20-47% of
   PD_VAH/PD_VAL touch events (barely touches IB/ON, 0.4-2.7%), and (b) a **location confound**
   present in all 8 configs — the "time-matched" baseline conditioned only on elapsed bars into
   the window, not on distance-to-B from the rejection location, and a rejection event is
   mechanically close to B by construction (fixed pair width, less adverse excursion = less
   distance traveled = closer to B). DeepSeek's first pass timed out mid-analysis (real findings
   survived — its own analysis script and cached event data persisted); a narrow, fast follow-up
   (reusing the cached data) finished the combined fix.

**Final, independently spot-checked verdict: NULL, not negative, across all 8 configs.**
Matching on BOTH time (30-min bins) AND location (0.10-ATR signed-distance-to-B bins) collapses
every previously-"significant" result — canonical cell (K=5, frac=0.05) Z range is only −1.21 to
+0.49 across all 8 configs, and Claude independently verified 2 of these by hand (proportion-test
arithmetic matched exactly). Holds across a 120-cell robustness sweep (K variants, frac variants,
inside-only-approach restriction) — nothing anywhere reaches |Z|=1.96. Even the one comparison
originally believed to be clean (reject vs. broke-through, both measured in the same time window)
turned out to be location-confounded too — both arms simply perform at their own location's base
rate. `RESEARCH_CLAIM range_boundary_rejection_traversal_negative` now FINAL/CONFIRMED with the
corrected numbers (prior CONFIRMED-negative and PROVISIONAL-contested rows superseded, history
preserved in the claim's notes). Full derivation: `scratch/deepseek_range_boundary_rejection_review.md`.
Not wired anywhere live — pure research, nothing gated on it.

## 🔶 2026-08-26: Breakeven-trail mechanism — root-caused why 5 of 6 variants never engage; wired a 7th, real candidate (`PD_POC_FADE_SHORT_TRAIL`), monitor at N=20

Direct follow-on to the Kelly thread below: once Kelly was closed out, went back to the other real,
already-diagnosed structural finding — the breakeven-then-trail exit mechanism (meant to let a
winner run instead of banking a small fixed target) has never once engaged for any of its 6 live
variants. **Root cause confirmed, not a code bug**: all 6 base types (`FLOOR_R1_FADE_SHORT`,
`PW_HIGH_FADE_LONG`, `PD_POC_FADE_LONG`, `FLOOR_S1_FADE_LONG`, `DAILY_OPEN_FADE_LONG`,
`CAM_S2_FADE_LONG`) sit at 0-18 real (T1-reaching) trades, all below `backtest_breakeven_trail.mjs`'s
own `MIN_N=20` floor — they were picked by an earlier backtest but simply don't touch often enough
in real live trading to ever pass the mechanism's own guardrails. Only 2 `BREAKEVEN_TRAIL_TEST`
signal_names have EVER been written in this mechanism's entire history (`B_FLOOR_S1_FADE_LONG`,
stale since 2026-08-03 and not surviving since; `B_PD_POC_FADE_SHORT`, unrelated to any wired
variant). Re-ran the actual calibration for real today: **zero of the 6 wired variants survived.**

**Re-scanned every currently real-eligible setup_type (12 clear `MIN_N=20`) against the real
trail-validation funnel directly** (not just the 6 originally picked). Only one survives:
`PD_POC_FADE_SHORT` — real N=21 (30 all-time), Tier B ("Real Runner"), trail=19.3pt, OOS EV
+$30.31 vs a -$2.31 OOS fixed-target baseline. High-frequency real setups (`IB_BEARISH` real_n=147,
`IB_BULLISH` real_n=68) were also tested directly and genuinely fail the OOS/plateau guardrails —
frequency alone doesn't mean a safe trail exists; this correctly refused to invent one for them.

**Wired as the 7th trail variant** (`resolveSetupType()` override in `acd.js`, `CONDITIONAL_VARIANTS`
entry in `setupTypes.js`, `monitorAtN: 20`), SHADOW-only, same pattern as the original 6. **Real
tradeoff, explicit user confirmation obtained**: unlike the other 6 (already thin/inactive before
conversion), `PD_POC_FADE_SHORT` is CURRENTLY ACTIVE and alerting live (real N=30, 63.3% WR, real
EV=+$0.40/trade, stable, not day-clustered) — this wiring diverts all its future touches to the
forced-SHADOW `_TRAIL` variant, meaning real live alerts on a currently-working (if marginal) setup
stop until the trail mechanism proves itself at real N≥20. Judged worth it given the backtested
edge (+$30/trade) vs. what's being given up (+$0.40/trade) — but this is the first of the 7 trail
variants where a real opportunity cost, not just an already-idle setup, was knowingly traded away.

Verified: `node --check`/lint clean on both touched files, server restarted onto the new code with
zero new `scratch/server_errors.jsonl` entries, `test_invariants.mjs` confirms `inferDirection()`
resolves correctly, the trail width/OOS EV read back matches the fresh calibration row, and the
backtest script reference is valid — the only new WARN (`baseType ACTIVE, both would fire
simultaneously`) is the tradeoff above, already confirmed with the user, not an unresolved defect.
All 6 pre-existing `FAIL`s in that run are unrelated, pre-existing `OPTIMAL_STOP` circuit-breaker
trips, confirmed unrelated to this change.

**Next real checkpoint: `PD_POC_FADE_SHORT_TRAIL` at real N=20** — check whether the trail is
actually engaging by then (non-null `runner_trail_width` on resolved rows, some real
`TRAIL_EXIT`/similar resolution instead of universal `PRICE_CLEAN`), and whether its real forward
EV is anywhere close to the +$30.31 backtested figure before considering promoting it toward
`ACTIVE`. The other 5 stay SHADOW-only and effectively dormant (no calibration row, no engaged
trail) until their own real touch counts grow enough to re-enter `backtest_breakeven_trail.mjs`'s
funnel — nothing further to do there until that happens naturally.

## ✅ 2026-08-25: Kelly-criterion position sizing — RESOLVED NEGATIVE, not viable at current $400 DLL

Explored as the fix for "no great days, no consistency" after the standing stop/target R:R
asymmetry (118/122 setups stop>target) was confirmed to have no further viable re-optimization
technique. Went through 3 build/review rounds before landing on a trustworthy answer, each round
catching a real bug — worth reading in full before anyone tries a 4th attempt at Kelly sizing here:

1. **Design critique** (Gemini + DeepSeek): recommended continuous-outcome Kelly (`f*=mean/
   variance`) over the textbook binomial form (this system's `b<1` for most setups amplifies
   estimation error ~2.67x), fractional/N-scaled shrinkage, and flagged that a near-identical
   prior attempt (`scratch/backtest_1yr_prop_challenge_improved_strategy.mjs`, 2026-08-02) was
   silently void — a field-name bug (`t.st` vs `t.setup_type`) meant 100% of its "Kelly" P&L
   actually came from unfiltered Globex trades never touched by Kelly at all.
2. **Build round 1**: pooled SHADOW (suppressed, never-alerted) trades into the simulated P&L as
   if they were real opportunities, and fabricated an "Actual Historical" column assuming
   `size_multiplier` controlled real contract counts (it only ever drove a qualitative UI label).
   Both caught by Claude reading the code directly, not by running it.
3. **Build round 2** (corrected): fixed both of the above. Produced a result that looked like a
   real Kelly win (Calmar 4.04 vs 1.59, drawdown $606 vs $1612) — but DeepSeek's code-review-only
   pass (verified independently via a separate read-only replica reproducing the exact same
   numbers) found the "Kelly" branch never fired a single Kelly-sized trade across all 355 real
   trades: a dimensional bug (dividing by `riskPerContract` an extra, unjustified time after
   computing `f_star` on raw-dollar mean/variance) crushed every real Kelly-eligible contract
   count to ~0.003-0.02, always flooring to 0. The reported "improvement" was 100% an artifact of
   the N<20 warm-up fallback (trade 1 contract for a setup's first 20 observations, nothing to do
   with Kelly) firing on 46% fewer trades than the flat-1-contract control.
4. **Build round 4** (Claude implemented DeepSeek's corrected R-multiple formula directly, per the
   standing 2-strikes-then-Claude-takes-over convention): re-ran with the dimensionally-correct
   formula. Result: **near-identical output to the buggy version** ($2450.11 both times) — not
   because the fix failed, but because it confirms the real, honest answer. Even the single
   strongest-edge real setup_type in this system's entire history produces a pre-floor Kelly
   contract value of 0.874 — still under 1.0. **At this account's real $400 daily loss limit,
   properly-shrunk Kelly sizing floors to zero contracts for every real, N≥20 setup, uniformly**
   — not a selective go/no-go gate as originally hoped, just uniformly inert. The bankroll is too
   small relative to real per-contract risk ($45-280) for the math to ever clear 1 contract.

`RESEARCH_CLAIM kelly_sizing_not_actionable_at_current_dll` (CONFIRMED negative, 30-day recheck).
**Not wired, nothing changed live.** Revisit only if the real DLL increases materially or if
per-setup real N grows enough to meaningfully weaken the `N/(N+50)` shrinkage term — not by
retrying the same technique with different knobs. Script: `scratch/
backtest_kelly_sizing_simulation.mjs` (kept, all 4 rounds' reasoning is in its comments).

## 🔶 2026-08-25: Cluster touch credit — Phase 0+1 shipped, Phase 2/3 (schema + sibling insert) still NOT built

Traced from a chart question ("did this pivot point fire today?") through real-N visibility gaps
(fixed same session — see the SetupReferenceView/AlphaEngineOverview/BacktestView entries) into a
much bigger structural finding: the level-fade engine fires exactly ONE real `active_setups` row
per confluence touch — `FLOOR_R2` (29392.50) and `WEEKLY_OPEN` (29392.25), 0.25pt apart, both got
touched 3 times on 2026-08-25 alone, but only `WEEKLY_OPEN`/`OR5_HIGH` fired real rows;
`FLOOR_R2_FADE_SHORT`/`LONG` real N (stuck at 3/1 for months) didn't move at all. Not a rare-level
problem — a structural one: any level that chronically co-locates with a level that wins the
cluster's directional-EV sort can go its entire life real-N-starved regardless of real touch
frequency.

User's explicit decision, after being shown the tradeoff (naive "give everyone a real row" would
inflate N with correlated, non-independent outcomes — literally the same trade counted under
multiple names): fire real credit for every cluster member, but keep the N used for SUPPRESS/
PROMOTE gating statistically honest. Sent to BOTH Gemini and DeepSeek independently for design
critique (not code) before writing anything, per this codebase's standing rule for changes that
touch what gates a live trade. **Genuinely valuable to run both**: Gemini's critique was solid
(caught the Death-Sequence/stacking-count risk correctly) but asserted `backtest_setup_status.mjs`
needed no change — DeepSeek's much deeper, code-grounded critique found and Claude independently
verified this was wrong: the actual THIN_N→ACTIVE promotion gate has ZERO distinct-day/
independence protection (rigor diagnostics are explicitly commented "informational only," ~line
277), so cluster siblings could flip a level live on real trades spanning as few as 6-9 distinct
calendar days — the exact bug class the `origin_status` hard rule exists to catch, reintroduced
through a different door. DeepSeek also found 3 LIVE pooled consumers (not future work) that would
silently corrupt without a fix — including the `bet_class` SUPPRESS override that can suppress the
entire level-fade family at once — and a structural correction to the naive plan (`levelScalpSetup`
is a single-slot object with no loop to "un-break"; the correct build reuses the existing
suppressed-audit insert row shape instead). Full 4-phase build plan (verify → cheap independent
fixes → schema+gating safety net → the actual sibling insert → real-data review before flipping
gating inclusion), both critiques in full, and every risk found along the way:
`docs/CLUSTER_TOUCH_CREDIT_SPEC.md`.

**Phase 0 (verify) + Phase 1 (3 cheap fixes) shipped later the same session (2026-08-25).** Real
numbers replaced every assumption Phase 0 set out to check: RTH co-location is common (61% of 917
real confluence-tagged touches have 2+ levels in-radius); the overnight/Globex "natural
experiment" population (no cluster dedup there) produced 127 real near-simultaneous cross-type
pairs all-time with inter-sibling P&L correlation r=-0.14 (reassuring — not the redundant-bet
correlation the Phase 2 safety net worries about); the early-touch-backfill 1PM-expiry bug turned
out to have caused little realized damage so far (2 of 77 real backfill rows actually hit it, both
still resolved cleanly). Phase 1 shipped all 3 cheap fixes in `acd.js` (real rollover-safe backfill
expiry instead of hardcoded 13:00 ET; removed the wrong "near price → skip" backfill condition;
made `cluster_attributed_setups` symmetric so a same-poll cluster loser like `FLOOR_R2` gets tagged
onto its cluster's actual winner row, not just onto a different poll's already-open anchor). Server
restarted onto the new code clean (no new `scratch/server_errors.jsonl` entries), lint/syntax
clean, `test_invariants.mjs`'s 4 failures confirmed pre-existing and unrelated (OPTIMAL_STOP
circuit-breaker trips). **Phase 2 (schema: `cluster_touch_id`/`is_cluster_primary`, the
independence floor on the promotion gate, `POOLED_TRADE_FILTER`) and Phase 3 (the actual
sibling-row insert) remain NOT built** — both are live-wiring changes to production
gating/suppression logic and need the full 3-phase Gemini workflow (design critique → mine-and-run
→ code review) before shipping, not just the design-only critique both models already gave before
Phase 0's real numbers existed. `OPEN_DECISION cluster_touch_credit_phased_build` (updated, still
PENDING — Phase 2 is the next pickup point).

## 🔶 2026-08-25: Touch-quality signal ideas (DeepSeek brainstorm) — 6 candidate ideas, NOT tested, full writeup parked

A long session chasing "we're picking good spots but keep getting stopped out" tested 3 quality-
filter hypotheses for level touches (entry proximity — null; next-bar confirmation — real signal
but the wait costs more than it captures; breakout decisiveness — retracted, a real multi-contract
timestamp-collision bug in raw `price_bars` was found and fixed mid-thread, live code repointed to
`price_bars_primary`, but the underlying hypothesis was not re-tested against corrected data).
Asked DeepSeek to brainstorm genuinely new, adjacent ideas from the same frame (a quality signal
computable only from information available at/before the touch bar's own close, no lookahead).
DeepSeek did real codebase exploration first (verified against live `acd.js`: the revisit-latency
sizing factor's exact cited numbers, +$71 EV first-visit / -$35 EV 3hr+-stale, are real) and
returned 6 ideas: (1) volatility-normalized touch proximity — a re-test of today's null result in
the right units (bar-range-normalized, not raw points); (2) level liquidity depletion — the
volume-based mechanism behind the already-confirmed revisit-latency effect; (3) signed structural
runway — distance to the nearest opposing/favorable level, revives
`docs/STOP_PLACEMENT_LEVEL_CLUSTERING_SPEC.md`'s idea without its selection-ambiguity problem;
(4) approach path geometry — net-displacement/path-length efficiency over the k bars before the
touch; (5) tonight's fade-friendliness — hold-rate of every level touch so far tonight (fired or
not), not just the already-live but selection-biased win/loss streak factor; (6) touch-in-expansion
vs. touch-in-rotation — new-session-extreme context, with a real self-flagged crux confound
(several level families are definitionally at extremes) needing a within-`setup_type` control.
Full context, DeepSeek's exact request framing, all 6 ideas verbatim with sanity-check plans and
kill criteria, cross-cutting notes, deliberately-excluded ideas, and Claude's fact-check table:
`docs/TOUCH_QUALITY_SIGNAL_IDEAS_SPEC.md`. **Nothing here has been built or tested — this is a
parked idea set, not a finding.** ~~`OPEN_DECISION touch_quality_ideas_pending_test`~~ Resolved 2026-08-25 — see below.

- **RESOLVED 2026-08-25 — 5 of 6 ideas tested, 5 dead, 1 provisional, 1 deferred.** Built a
  shared feature-extraction pass (`scripts/pilot_touch_quality_features_deepseek.mjs`, real N=959,
  `origin_status IN ('ACTIVE','SHADOW')`, `price_bars_primary` only) per DeepSeek's own
  "one pass, not six scripts" recommendation, via the standard Gemini design-critique-then-mine
  workflow. The critique caught two real bugs before any run: idea 6 as originally specified would
  have used the still-forming touch bar's own high/low (lookahead), and ideas 1-3 can't be computed
  from `active_setups` columns alone (`structural_level_touched` confirmed 0% populated on live
  rows) — fixed by parsing `setup_type` back to a `level_prices` lookup, with `GLOBEX_VWAP_FADE_*`/
  `PD2_VAH_FADE_*`/`PD2_VAL_FADE_*`/`ZONE_EDGE_FADE` (117 trades) excluded from those 3 ideas since
  they have no static level anchor at all. **A second bug found by auditing Gemini's own output,
  not caught by the critique pass**: the mine-and-run script's verdict function computed
  `evSpread = max(bucketEV) - min(bucketEV)` and called anything ≥$4 "genuinely promising" without
  checking the monotonicity flag the script itself already computed a few lines above — this would
  have labeled all 7 numeric features "promising" purely from an 8-features×4-buckets multiple-
  comparisons artifact. Corrected via a follow-up dispatch (1 of the standard 2 correction
  attempts) rather than accepted as-is. **Real, corrected result**: ideas 1 (`d_norm`), 2
  (`depletion_frac`), 3 (`adverseRunway`/`favorableRunway`), 4 (`efficiency`/`overlapRatio`), and
  idea 6's `rangeVelocity` sub-feature — 7 numeric features total — show ZERO monotone EV trend
  across quartiles on N=840-960 each, the exact kill criterion the spec itself pre-registered.
  `RESEARCH_CLAIM touch_quality_ideas_1_2_3_4_negative`. Idea 6's boolean (`isNewSessionExtreme`,
  pooled N=35 True/+$24.54 EV vs N=875 False/-$0.99 EV) is genuinely **provisional, not dead** —
  Gemini's crux-control re-run (conditioning on level-family) called it fully dead, but a direct
  read of its own output table shows the effect only reverses for non-extreme-prone families;
  WITHIN the extreme-prone families (`MORNING_EDGES`/`PRIOR_DAY_EXTREMES`) themselves, True EV
  ($48.85, N=20) still far exceeds False EV ($4.20, N=284) — a residual that doesn't vanish, just
  too thin at N=20 to call either way. Caught and corrected before recording — see
  `RESEARCH_CLAIM touch_quality_idea6_expansion_touch_provisional` (`unblockCondition`: recheck
  once combined real N for the 12 constituent OR/IB/PD/ON fade setup_types roughly doubles from
  284). Idea 5 (tonight's fade-friendliness, a full per-session touch scan) remains fully untested
  — deliberately deferred as a structurally heavier build, own decision:
  `OPEN_DECISION touch_quality_idea5_fade_friendliness_deferred`. Nothing wired live from this
  thread — every numeric idea is a confirmed negative, and the one open candidate needs more real
  data before either promoting or killing it.

- **DeepSeek independent code review, same day — confirmed Claude's idea-6 read, found a new real
  lookahead bug Claude and Gemini both missed, narrowed the idea-6 scope further.** User explicitly
  asked for genuine critique, not agreement. DeepSeek ran its own direct DB queries (not just
  reasoning over the write-up) and: (1) independently re-verified the `MORNING_EDGES &
  PRIOR_DAY_EXTREMES` within-family gap ($48.85 vs $4.20, N=20 vs 284) is real and not an artifact
  of idea 6's own lookahead handling (confirmed it only reads bars strictly before `fired_at`, no
  `level_prices` lookup — clean); (2) found the "combined family group" framing overstates
  breadth — **19 of the 20 True cases are `MORNING_EDGES` specifically, only 1 is
  `PRIOR_DAY_EXTREMES`** (a single $82 trade) — `touch_quality_idea6_expansion_touch_provisional`
  narrowed accordingly, unblock condition now scoped to the 8 MORNING_EDGES setup_types only; (3)
  recommended a positive-control precondition before trusting the residual further — re-run this
  same pipeline against the already-confirmed revisit-latency effect (a KNOWN real signal) to prove
  it can detect a true effect before leaning on a thin N=20 cell, not yet done; (4) found and
  quantified a genuine lookahead bug in idea 3 that neither Gemini's design critique nor Claude's
  code read caught: `adverseRunway`/`favorableRunway` scan ALL `level_prices` rows for the
  trade_date, including same-day-forming levels (OR5/OR10/OR30/IB) not yet formed at touch time —
  54 trades fired before their OWN anchor level finished forming, ~30% of all touches have a
  contaminated `otherPrices` set; separately verified ONH/ONL are NOT affected (checked directly,
  all fire after their 09:29 formation); (5) found `rangeVelocity` defaults to exactly 1.0 (not
  null) for early-session trades with <30 prior bars, a session-timing artifact inflating ~25% of
  its Q4 bucket; (6) found `depletion_frac` returns 0 (not null) when there's no volume data,
  conflating "no data" with "genuine zero"; (7) checked and DEBUNKED its own hypothesis of a
  bigint-string-concatenation bug on volume sums by querying the actual column types directly —
  confirmed plain integers, no bug. None of these change the DEAD verdict on ideas 1-4 (a leaky
  feature failing to show even a false positive is, if anything, a more confident negative) — all
  recorded as caveats on `touch_quality_ideas_1_2_3_4_negative` for anyone reusing this script.

- **Bugs from the DeepSeek review actually fixed and re-verified, same day.** User asked to
  implement the critiqued results. Nothing from the trading-signal findings was ready to wire
  live (6 confirmed dead, the 7th thin/gated) — but the real bugs DeepSeek found in the script
  itself were fixable now: same-day-forming levels (`SAME_DAY_FORMING_MINUTE` map, OR5/OR10/
  OR30/IB) are now excluded from a trade's own anchor AND from the `adverseRunway`/
  `favorableRunway` "other levels" scan whenever the trade fired before that level's formation
  time (54 anchor trades, ~30% of touches broadly); `rangeVelocity` now returns `null` instead
  of a fake `1.0` for early-session trades with <30 prior bars; `depletion_frac` now returns
  `null` instead of `0` when there's no volume data. **Fixing the anchor-formation gate exposed
  a 4th real bug**: idea 6's family classification was wrongly coupled to the same `hasAnchor`
  flag ideas 1-3 use for price availability, so excluding lookahead-leaky trades silently
  reclassified early-firing OR5/IB trades out of `MORNING_EDGES` into an `OTHER` grab-bag,
  collapsing the True bucket from N=19 to N=1 — caught by comparing the re-run's numbers
  against DeepSeek's independently-verified ones before trusting them, not assumed correct.
  Fixed (family now derives from which level the setup_type names, independent of price
  availability) and re-verified: ideas 1-4 remain confirmed dead on the cleaner population —
  more trustworthy now, not just unchanged, since the confounds that could have masked or
  manufactured an effect are gone and the negative still holds. The MORNING_EDGES idea-6
  finding reproduces almost exactly (N=19, 78.9% WR, $47.11 EV) — reassuring that it isn't an
  artifact of the fixed bugs, but still PROVISIONAL: N=19 stays below the N≥20 floor, and
  DeepSeek's positive-control precondition (reproduce the known revisit-latency effect on this
  same pipeline before trusting this residual) still hasn't been run — would need a per-session
  touch-history scan similar in scope to the still-deferred idea 5. Both `RESEARCH_CLAIM` rows
  updated to reflect the fixed, re-verified state.

## 🔴 CURRENT TOP PRIORITY (set 2026-07-29): risk management, not more entry-signal research

**STALE NUMBER CORRECTED 2026-08-19 (Opus Audit 8, `scratch/opus_audit_8_results.md`):** the
"118 of 122 (97%) have a stop wider than target" figure cited below is no longer current — a
fresh census of the latest `OPTIMAL_STOP` row per type found **14 of 138 (10.1%)**, median
stop/target ratio **0.86** (was 1.67). The risk-ceiling machinery visible in `OPTIMAL_STOP`'s
`notes.risk_capping` has evidently fixed the raw ratio problem since this was written. **This
does NOT mean risk management is solved** — the realized payoff shape has not followed: ACTIVE
population (n=344, real capital) shows avg win $85.30 vs avg loss $118.00 (1.38 loss/win ratio),
driven by (a) a fatter loss tail on fade-family setups specifically (STOP_HIT MAE overshoots the
stop by >50% at 13.2% of the time vs 3.6% for breakout-family, both N≥20) and (b) a much larger,
newly-found structural bug: `IB_BULLISH`/`IB_BEARISH` — which together produce 67% of real-capital
big losses — have their entire day-type-conditioned stop/target/suppression wired to
`acd_daily_log.day_type`, a column that's NULL for the entire live session (written by cron at
8:20 PM ET). Four real, correctly-swept day-type `OPTIMAL_STOP` rows have never once been read
live. See `OPEN_DECISION ib_daytype_calibration_structurally_unreachable` (HIGH, flagged same
session) — **this, not the stop/target ratio, is the re-aimed top priority.**

**User directive, verbatim intent**: the system needs to find a way to manage risk effectively — throttling losing trades, achieving a better R:R, or some other mechanism — because right now it fires sequential counter-trend/low-R:R trades that produce small wins and large losses. This is the top priority over further signal-discovery work. Stated end goal: make the system **autonomous and profitable** — both halves matter, not just finding more signals. Recorded as `OPEN_DECISION` `prioritize_risk_management_over_signal_research` (HIGH) so it resurfaces every session start regardless of whether this file gets read carefully.

**Third lead tested and closed out, same night (2026-07-30): the user's own 4H-50-EMA trend filter idea (only fade LONG above it, only fade SHORT below it) — discard, real negative on 3 independent checks.** Built with genuine no-lookahead (`scratch/run_ema_filter_test.js` — Claude verified this directly by reading the code, not just trusting Gemini's summary: the DB session timezone is America/New_York, so the hour-based 4H bucket boundaries are correctly ET-midnight-anchored, and a touch only ever sees the EMA as of the previous CLOSED 4H bucket). A 9-combination sensitivity sweep (period ∈ {20,50,100} × timeframe ∈ {1H,2H,4H}, RTH) showed no consistent neighborhood — e.g. 1H/50 gap=-$2.87 vs 4H/50 gap=+$10.10 — the same brittle, parameter-specific signature that already killed the Regime A/B/C classifiers. The Globex/overnight leg fully INVERTED the RTH result (ALIGNED EV=-$2.06 vs COUNTER EV=+$5.27) — a real trend-alignment relationship shouldn't flip sign between sessions. Chronological rigor on the RTH headline failed (thirds -$4.20/-$1.42/+$17.42) with the entire apparent edge concentrated in the most recent third of ~3.5 years of history — independently corroborated by the 80/20 train/test split showing the identical pattern (two different slices of the same data agreeing it's a recent-history artifact, not a bug). `RESEARCH_CLAIM ema_4h_trend_filter_brittle_overfit_discard` (CONFIRMED negative). Not wired. **This closes out all 3 risk-management leads tested this session** (drawdown-velocity, risk-adjusted stop/target re-optimization, EMA trend filter) — all 3 real, honestly negative/inconclusive results, none wireable. Remaining un-tried angles: lean into `STACK_VOL_BREAK_LIVE` (the one breakout-family setup, naturally better R:R by construction — matches the user's own stated trading style, see memory `user-trading-style-breakout-preference`), or the never-built SPC/Kelly position-sizing ideas.

**Follow-up, same day, after the two threads below were exhausted**: user asked Claude+Gemini to work together on the root cause directly, and mentioned two new pieces of context — (a) they personally prefer trading breakouts, not fades, and (b) confirmed the objective-function hypothesis is worth pursuing. Investigation found: **118 of 122 calibrated setup_types (97%) have a stop wider than target** (median ratio 1.67, several need 65-81%+ WR to break even) — a direct, structural consequence of `update_optimal_stops.mjs` picking stop/target to maximize raw mean EV with zero penalty for variance/drawdown. This is very likely the real driver of "PnL volleys too much." Separately, the ONE live breakout-family setup, `STACK_VOL_BREAK_LIVE`, already has a healthy R:R by construction (LONG 40pt stop/70pt target, SHORT 40/40) — much better than the fade family, matching the user's stated preference; saved as memory `user-trading-style-breakout-preference`. User chose to pursue the root-cause fix. Ran the full 3-phase Gemini workflow:
   - **Phase 0 (design critique)**: Gemini recommended a Sortino-like ratio (`mean(pnl)/stdev(negative pnl)`), the plateau+chronological-rigor-check combo over full walk-forward (correctly judged walk-forward impractical given most setups have well under 150 total trades), and a hard EV-retention floor (`candidate_EV >= 0.5 * maxEV`) so the optimizer can't pick a near-zero-trade "solution." Also flagged that any resulting narrow-target pick deserves scrutiny since this codebase's backtests don't model slippage.
   - **Phase 1 (mine-and-run), attempt 1 — failed audit**: Gemini's Sortino-based pilot produced nonsensical ratios (values in the billions/trillions). Root-caused directly: this codebase's synthetic MAE/MFE-threshold stop-hit resolution resolves every stop-out to an *identical* dollar loss for a given (stop,target) candidate — downside stdev is ~0 by construction for nearly any candidate, so any per-trade Sortino/Sharpe computed on it is structurally degenerate, not just noisy. A real, reusable methodological finding for future risk-adjusted-objective work in this codebase, not a one-off bug. Also caught a second issue: 4 of the 8 pilot setups' live baseline EV comes from the corrected-resimulation target-calibration path, not the simpler function the pilot reused for speed — an apples-to-oranges baseline for those 4.
   - **Phase 1, attempt 2 (correction, per the standing 2-attempts rule)**: redirected to a Calmar-like objective (`EV / maxDrawdown` of the real resimulated equity curve) instead. Results genuinely promising: across the 6 evaluable pilot setups (2 of 8 failed the N≥20 gate), **maxDrawdown fell in 6/6** (12-72% reductions), EV improved or turned positive in 5/6. But the pilot's own overfitting guard (a plateau/neighbor-stability check) failed 100% of the time, including on the two highest-N setups (N=3026, N=1481) that shouldn't have a grid-resolution problem — inconsistent with a genuine instability finding. Root-caused directly (Gemini's 2 attempts were used, Claude took over per the standing rule): the check requires a neighboring grid cell within a hardcoded ±20% band of the chosen candidate's Calmar ratio — too tight for a compound ratio (EV/maxDrawdown, both independently noisy) at N~100 scale, and itself a static-threshold violation of this codebase's own standing rule.
   - **Round 3, same thread, next day (2026-07-30) — RESOLVED NEGATIVE.** Fixed the plateau tolerance (MAD-based, data-derived — no more hardcoded %) and re-ran on a clean 8-setup sample confirmed to all be on the plain-EV-sweep baseline (avoiding round 2's corrected-resim confound entirely): `OR_LOW_FADE_LONG`, `OR_HIGH_FADE_SHORT`, `IB_HIGH_FADE_SHORT`, `IB_LOW_FADE_LONG`, `IB_BEARISH`, `ONH_FADE_SHORT`, `ONL_FADE_LONG`, `WEEKLY_VWAP_FADE_LONG`. Result: **0 of 8 produced both a genuinely different AND a robustly-validated improvement.** 4/8 already sit at the risk-adjusted optimum (legitimate no-change result). 1/8 (`IB_BEARISH`, already EV-negative) correctly found no positive-EV candidate exists anywhere in its grid — the profitability floor working as designed. Of the 3 that did produce a different pick: `ONH_FADE_SHORT` cut maxDrawdown 37% but EV declined slightly and failed its own stability check (independently re-verified this setup really is plain-sweep, not corrected-resim — Gemini's report had mislabeled it, caught on audit); `IB_LOW_FADE_LONG` cut maxDrawdown 60% in dollars but its losing-STREAK LENGTH more than doubled (7→15 consecutive losses) — a real tradeoff (many small losses vs fewer big ones) that may not solve the user's actual "PnL feels like it volleys" complaint even though the dollar metric improved, and it also failed its own stability check; `ONL_FADE_LONG` showed no real improvement on any axis and failed all 3 checks. `RESEARCH_CLAIM risk_adjusted_stop_target_pilot_promising_unproven` updated to `CONFIRMED` status describing this final negative result (superseding round 2's promising-looking PROVISIONAL read, which is now understood to have been inflated by the round-2 baseline-mismatch confound). `OPEN_DECISION fix_plateau_tolerance_before_scaling_risk_adjusted_objective` RESOLVED: **do not scale this technique (Calmar-ratio re-optimization over the existing fixed MAE/MFE percentile grid) to the other 114 setup_types.** The underlying 97%-stop>target problem remains real and unaddressed — a genuinely different technique (finer/continuous candidate grid, or a different lever entirely) would be needed. **Not wired. Nothing changed live.**

**What was actually built/tried this session, and what's still open (original entries):**

1. **Drawdown-velocity circuit breaker — RESOLVED (as far as today's data allows): only the 15min leg is trustworthy, and it's the wrong-direction leg for risk management.** Same-day follow-up (2026-07-29, `scratch/pilot_drawdown_velocity_window_sweep.mjs`) ran a finer 11-point window sweep (10-60min, chronological 80/20 train/test, thresholds derived from TRAIN only) instead of just the original 15min/30min pair. Pooled EV across the sweep looked like a strikingly smooth, monotonic crossover around 25-30min — but two follow-up checks undercut treating that shape as real corroboration: (a) the TEST severe buckets are day-clustered at *every* window (top5DayPct 61-100%, only 4-15 distinct days behind each number — inherent to a volatility-conditioned bucket, not a bug); (b) chronological 3-way stability only passes at the ORIGINAL 15min window — every wider window, including large-N ones (30min N=160 train, 40min N=208 train), flips sign across its own history. Dispatched a Gemini methodology critique (`scratch/gemini_review_drawdown_rigor_methodology.md`) per direct user request to sanity-check whether `computeRigor()` itself was too strict — Gemini's independent read: the day-clustering flag is reasonably dismissed as structural for this kind of signal, but the large-N stability failures at 30min+ are a **real red flag, not an artifact of an overly strict check**, and the smooth crossover shape is mostly autocorrelation (adjacent windows share most of the same underlying touches) rather than 11 independent confirmations. **Net: the only trustworthy piece is the 15min "severe drawdown → BETTER next trade" (capitulation) leg (N=31 test, EV=+$18.35, rigor-clean)** — and that's the *opposite* direction from what a risk-management circuit breaker needs (it argues for re-engaging after a fast flush, not throttling). The useful leg (severe drawdown 30min+ → worse next trade) remains statistically unresolved. `RESEARCH_CLAIM drawdown_velocity_window_dependent_effect` updated with the full account (still PROVISIONAL). **Not wired, and not expected to be wireable from this angle without new data or a different technique** — Gemini recommends a GAM/spline regression treating window length as a continuous covariate (not built) as the correct way to actually pin down the crossover with a confidence band, rather than more discrete-bucket sweeps.

2. **R:R / bank-vs-extend (wider targets) — RESOLVED negative: fixed the broken replication check, real cross-setup held-out test does not replicate.** Same-day follow-up (`scratch/pilot_bank_vs_extend_replication_fix.mjs`) fixed both problems named below: (a) selection of the "best" extend multiple per setup is now reachability-weighted (must clear that setup's own median reachability across its 5 candidates, plus ≥10 trades that actually entered extending mode) instead of picking whichever multiple has the single highest raw EV — the prior pass's "best" picks were often driven by rare, barely-reachable outsized winners (0-20% reachability); (b) replication is now genuinely cross-setup (`idFn=setupType`, matching every other `computeReplication()` caller in this codebase) — top-half of the 17 tested setups by improvement-over-baseline selected as "winners," bottom half genuinely held out (the original bug: `selectedIds` was every trade id in the population being tested, so `heldOut` was always empty). **Result: does not replicate.** At the primary top-9-of-17 cut, selected pooled improvement is +$7.03/trade (N=827) vs. held-out −$3.61/trade (N=642) — opposite sign. Sensitivity-checked across cut points (K=3/5/9/13): only K=3 barely replicates (held-out +$0.17, weak), K=5/9/13 all fail, and the held-out favorable fraction degrades monotonically (0.79→0.75→0.63→0.25) as more setups are counted as "winners." 6 of 17 setups have every candidate multiple below the 10-trade reachability floor regardless of method — genuinely too thin to select on at all. `RESEARCH_CLAIM bank_vs_extend_wider_target_replication_check` recorded (new, PROVISIONAL). **Wider/extended targets are not currently a validated R:R lever. Not wired.**

3. **A specific gate idea (hivol_lopace_at_detection) was tested as a suppression mechanism and rejected** — 95.7% of the time it fires, it's on setup_types already suppressed by the existing system, so gating on it would be mostly redundant. Not a risk-management win, but a real negative result, properly recorded (`RESEARCH_CLAIM hivol_lopace_gate_promotion_not_supported`) rather than silently dropped.

4. **Two ideas raised early this session were never actually built or tested**: equity-curve/SPC (statistical-process-control) style self-throttling, and Kelly-criterion dynamic position sizing. Both respond to the system's own realized P&L/variance rather than trying to classify market conditions — structurally different from everything tried above, and still on the table as the next thing to actually scope.

**How this session's work got built (new standing process, see CLAUDE.md's Collaboration section for the durable rule)**: a 3-phase Gemini workflow — (0) send Gemini the intended approach for critique BEFORE writing code, (1) full mine-and-run for the actual test, (2) a separate code-review pass on the resulting script before trusting any number. Adopted mid-session after Claude shipped a live change (the `hivol_lopace_at_detection` badge) without any of this and a real off-by-one bug reached production undetected until the user asked "did gemini review your code?" Used properly for the gate-backtest above and caught real, load-bearing problems (a broken level-name mapping, a buried marginal-utility number, a stability-check failure the first write-up ignored) before anything was trusted. **Apply this to whatever risk-management work comes next — it's higher-stakes than signal discovery, not lower.**

**Also shipped this session, lower-stakes**: a standalone external dashboard (`server/public/quick-check.html`, exposed via a persistent Cloudflare Tunnel + Access at `tj.6claire.page` — see CLAUDE.md's new "Where to look" entry) and a fix for `active_setups` firing duplicate live rows when several levels cluster within a few polls of each other (`cluster_attributed_setups`).

## ✅ 2026-07-17: built `scripts/flag_decision.mjs` — pending decisions are now actively monitored, not buried in prose

Direct follow-on to the "no structural way to tell live pipeline from abandoned" thread below, after the user pushed further: "anything that needs to be reevaluated should [be] flagged with something and actively monitored. Nothing can be buried." Considered and rejected overloading `RESEARCH_CLAIM` (`scripts/record_claim.mjs`) directly — a pending product/architecture decision ("wire this in or delete it," "merge this branch") has no statistical content and doesn't go stale the way a tested research finding does; it just sits until a human decides. Built a deliberate sibling instead, reusing the same underlying mechanism (same `performance_audit` table, same JSON-notes-with-date shape, same session-start-hook integration pattern) rather than a parallel table/file — this codebase already has a documented anti-pattern of uncataloged ad hoc tables (see `docs/DB_BACKUP_CATALOG.md`'s own origin story).

**Built**: `scripts/flag_decision.mjs` (`flagDecision`/`resolveDecision`/`listDecisions`, `signal_type='OPEN_DECISION'`, vocabulary `PENDING`/`RESOLVED` — deliberately not `RESEARCH_CLAIM`'s `CONFIRMED`/`PROVISIONAL`/`STALE`, which wouldn't make sense for a yes/no decision). `.claude/hooks/session-start.sh` gained an `OPEN_DECISIONS` section, printed unconditionally every session, sorted oldest-first with age since first flagged (computed in SQL via `CURRENT_DATE - date`, not JS `Date()` — caught and fixed a real naive-timezone rounding bug during testing, exactly the class of bug this codebase's own `parseDateTime` writeup already warns about). **The hook section is the actual fix, not the table** — a row nobody ever queries again is exactly as buried as a paragraph nobody re-reads; printing it every session unconditionally is what makes it un-buriable.

**Seeded with 10 real pending decisions**, each written with full context (what's being decided, why it matters, what resolving it looks like — not a bare fact), pulled from this session and the prior day's SSOT/dead-end audit: `unrendered_dashboard_cards_5`, `rule_overrides_noop_pipeline`, `dead_backend_routes_20`, `premarket_walkthrough_and_screenshot_upload_orphaned`, `main_branch_55_commits_behind`, `latency_audit_sunday_only_cadence`, `vol_regime_history_cron_undecided`, `value_area_responsive_short_runner_followup`, `pd2_2dpoc_ev_magnitude_needs_scrutiny`, `backtest_pipeline_freshness_consumption_report`. Full text for each lives in the `OPEN_DECISION` rows themselves (`node scripts/flag_decision.mjs --list`), not duplicated here — this file's job now is narrative history, not the live pending-items list.

**Verified end-to-end**: smoke-tested add/list/resolve cycle before seeding for real; ran the hook standalone and confirmed all 10 print with correct 0-day age; confirmed `--resolve` correctly removes an item from the default `--list` (still visible via `--list-all`). Documented as a new convention in `CLAUDE.md` alongside the `RESEARCH_CLAIM` entry.

**Not done**: the actual "freshness + consumption cross-reference report" idea (querying every `performance_audit` signal_type's cron-wiring and live-consumer status automatically, instead of hand-archaeology each time) is tracked as its own pending `OPEN_DECISION` (`backtest_pipeline_freshness_consumption_report`), not built tonight — this session built the *tracking mechanism*, not that specific report.

## ✅ Dedup pass finished 2026-07-15 (picked up from the "READ THIS FIRST" item below) — went from ~86-102 requests to a stable 72-75, settle time now mostly hitting the 5-6s target

Picked up the explicit next step from the section below ("finishing the dedup pass... should be done regardless"). Found and fixed several real independent-fetcher duplicates beyond the 7 named there — the earlier sweep's own components (`useSharedPollData`, `refreshSharedPollData`) generalized cleanly to all of them:

- **`market/pulse`**: `App.jsx`'s `SidebarVerdictChip` (always-mounted sidebar, ungated) and `MarketPulseBar.jsx`'s default export both fetched independently — now share one `useSharedPollData` entry.
- **`acd/setup-detection`**: real fetchers were `MarketPulseBar.jsx`'s `SizeChip` (15s poll, now canonical), `App.jsx`'s `LiveSessionPanel` (60s poll + delayed socket refresh), and `TradeAlertBanner`'s health-check (previously used a `?date=` param — confirmed via `server/routes/acd.js` that the response cache is keyed by a constant string, so the param had zero effect server-side and was safe to drop for sharing). `App.jsx`'s `CaseSetupDetailModal` fetcher left alone — it's a rare user-triggered modal, not part of the page-load burst. A 4th apparent fetcher (`ACDView.jsx`'s `AuctionReadCard`) turned out to be **dead code**, see the new dead-code section below.
- **`acd/today`**: `LivePlaybookCard.jsx` (30s poll + socket refresh) and `ACDView.jsx`'s one-off mount fetch — now share one entry; `ACDView.jsx` gets live-updating data as a side benefit instead of a frozen mount-time snapshot.
- **`acd/feedback?days=1`**: `ACDView.jsx`'s `EdgeSectionsPanel` (60s poll, kept canonical), `SessionBiasPanel` (one-time mount fetch to restore "Traded" toggle state — converted to read the shared entry but only apply its *first* response, via a ref guard, so later shared-poll refreshes can't clobber an unsent optimistic update from `logTraded`). `QuickTradeLog`'s fetch left alone — it's on-demand (fires only when the user opens the quick-log modal), not part of the page-load burst.
- **`accounts?days=0` / `accounts/last-day`**: `DashboardView.jsx` was independently re-running the exact "any trades today, else fall back to last trading day" check `App.jsx`'s `fetchAccounts()` already does — a real violation of this file's own "account state is lifted to App.jsx" convention, not just a generic duplicate fetch. Fixed by having `App.jsx` expose a `hasTradesToday` boolean (set alongside `selectedAccounts` in the same fetch) as a prop; `DashboardView.jsx` now just reacts to that instead of re-querying.
- **`setups/today`**: the one OPEN_THREADS explicitly deferred as higher-risk ("entangled with a shared useEffect... two socket-event handlers that call it with a delay"). Unblocked by adding `refreshSharedPollData(url)` to `useSharedPollData.js` — an exported function that force-refreshes an already-subscribed shared cache entry, for exactly this "socket event should trigger an instant refresh, not just wait out the poll interval" case. `PermSlipAndStackBar`, `ACDView.jsx`'s `EdgeSectionsPanel`, and `App.jsx`'s `LiveSessionPanel` (whose `onExpired`/`onResolved` socket handlers now call `refreshSharedPollData` instead of their own fetch) all now share one entry. Same `refreshSharedPollData` mechanism also used for `acd/setup-detection` and `acd/feedback` above, replacing their own delayed-socket-refresh fetches.
- **Case-engine health check**: `TradeAlertBanner`'s separate fetch of `/case?date=...&asOf=09:30` (a fixed morning snapshot, independent of `CaseContext`'s own dynamic-`asOf` live poll) removed entirely — `useLiveCase()`/`CaseContext` (`src/components/shared/CaseContext.jsx`) now expose an `error` field (using the same `noData`/`isWeekend`-aware filtering `TradeAlertBanner`'s check used to apply itself), and `TradeAlertBanner` just reads `useContext(CaseContext).error` instead of firing its own fetch.
- **`TradeAlertBanner`'s own literal double-fetch**: `fetchAlerts()` was fetching `/morning-brief/trade-alerts/${d}` *twice* every 15s cycle — once inside its health-check array, once again immediately after for the actual alerts data. Now fetched once and reused for both.
- **New bug, not a simple duplicate-fetch**: `BehavioralPatternsCard.jsx`'s `load()` (fetches `behavioral-patterns` ×2 + `auction-read/today`) was wrapped in `useCallback(..., [ctxRes])` — `ctxRes` comes from a 30s shared poll, so every time it ticked, `load`'s identity changed and its own `useEffect(() => { load(); ... }, [load])` re-fired the **entire 3-request fetch**, not just the small `ctx` derivation that actually needed `ctxRes`. This meant a full re-fetch every ~30s instead of the intended 120s interval, on top of inflating the initial-load request count. Fixed by splitting the fetch (no `ctxRes` dependency) from the `ctx` derivation (separate effect, recomputes only, never refetches).
- **`MarketPulseBar.jsx`'s `ContextChips`**: missed by the original sweep — independently fetched `live-session-context` and `acd/trend-watch` (both already shared elsewhere) inside its own 4-request `Promise.all`. Pulled those two onto `useSharedPollData`; `flush-risk` and `auction-read/auto` don't have another subscriber yet, so they stay a local poll.

**Verified via Playwright** (symlink-into-node_modules trick, `playwright` isn't a direct dependency): request-count tracing (`page.on('request', ...)`, filtered to `/api/`) across repeated runs, before → after: **86-102 → 72-75 total requests**, essentially at the ~68 StrictMode-only floor this file itself calculated (the residual ~4-7 above that floor is `accounts`/`behavioral-patterns` each firing 2 *legitimately different* query strings × 2 StrictMode — not a bug, just this measurement's path-only grouping making it look like one). Settle time (`text=Loading…` visible-count polled to 0): **3.2s-6.4s across 5 repeated runs, mostly hitting the 5-6s target**, one 8.1s outlier — consistent with this file's own prediction that finishing the dedup pass "might get close enough that the remaining gap no longer matters in practice" without needing HTTP/2 or an endpoint-bundling redesign. Lint (`npm run lint:frontend`) and `npm run build` both clean after every change.

**Not re-measured under concurrent multi-tab load or during real market hours** — this pass was measured against a single idle Morning Prep load outside RTH; the connection-pool/concurrent-load numbers elsewhere in this file were measured separately and aren't re-verified here.

## ⏱️ EXPLICIT TARGET, READ THIS FIRST: Morning Prep full-page settle time ≤ 5-6s

User-set threshold, restated explicitly here (2026-07-15) so it isn't buried in prose in the section below. Measure with the convention already established: Playwright, `page.locator('text=Loading…').locator('visible=true').count()` polled ~every 500ms-1s from page load until it hits 0. Current state: **6-11s range, hit the target on at least one run, not consistently.**

**Honest math on how much further pure deduplication can take this, worked out directly rather than assumed:** a real Morning Prep load fires **34 unique API endpoints**. React StrictMode (dev-mode only, always on in this project's normal day-to-day workflow — it doesn't run a production build) double-invokes every effect, so even a *theoretically perfect* app with zero redundant fetchers still fires **68 requests** (34 × 2) — this is not fixable in app code short of disabling StrictMode (loses a real safety net) or moving off dev-server workflow (not how this app runs). Chrome caps 6 concurrent connections per origin; 68 ÷ 6 ≈ 11 sequential waves is a real structural floor even with every individual request fast. Currently measuring **88 total requests** — ~20 above that 68 floor, meaning **7 more endpoints are still duplicated beyond StrictMode's unavoidable 2x**, found via the same request-tracing method used all session (`market/pulse`, `case`, `accounts`, `morning-brief/trade-alerts`, `acd/feedback`, `behavioral-patterns`, `acd/today` — each 4x instead of 2x — plus `setups/today` at 6x, see below).

**Conclusion: getting under 5-6s *consistently* via deduplication alone is not guaranteed.** Finishing the dedup pass (bringing 88 → ~70, close to the 68 floor) is real, available, safe work and should be done regardless — but the last mile past that floor likely needs one of the two levers already deliberately deferred earlier this session (see "connection-starvation fix" entry below for the full reasoning on why they weren't done):
1. **HTTP/2 for the dev server** — removes the 6-connection cap via multiplexing entirely. Real tradeoff: changes the URL scheme (`https://`) and needs a one-time self-signed cert acceptance in the actual daily-use browser — a workflow change, not a code change, needs explicit confirmation before doing.
2. **Fewer distinct backend calls** — combine several small independent endpoints into one combined response (e.g. one "Morning Prep bundle" endpoint instead of 34 separate ones). Real engineering, not a quick fix — redesigns the API surface `useSharedPollData` currently subscribes to per-URL.
Don't reflexively reach for either without re-measuring first — finishing the dedup pass alone might get close enough that the remaining gap no longer matters in practice. Re-run the request-count + settle-time trace after the dedup pass before deciding whether (1) or (2) is actually still needed.

## Pending decisions / unconfirmed proposals

- **⚠️ CORRECTION NOTICE (2026-07-14): every dollar-EV figure dated 2026-07-14 elsewhere in this file, for any `resolution_method='BACKFILL'` setup_type, was computed at the wrong $/pt scale — read this before trusting any dollar figure below.** `scripts/archive/backfill_level_fades.js` (and every `scripts/repair_*.mjs` script that copied its convention today) used `PT=5, COMM=5` — but the live resolution path (`server/routes/acd.js` ~line 155, `const PNL_PER_POINT = 2; // MNQ = $2/point`) is explicit that the real contract is MNQ at $2/point, $1 commission. $5/pt matches neither MNQ ($2) nor standard NQ ($20) — an uncaught error in the archived script from the start, not a deliberate convention (user confirmed: "not sure why you picked $5"). **The error only affects the magnitude of dollar-EV figures for `BACKFILL`-sourced setup_types (overstated ~2.5x) — it does NOT change which setups are winners vs. losers (sign held in every case checked), and does NOT affect the 32+14=46 `SETUP_STATUS` recommendation flips' underlying *direction* claims, though some of those flips' exact classification (`SUPPRESS` vs `ACTIVE`/`PROMOTE`) did shift once rescaled, since the standard `-$5` `SUPPRESS_MAX_EV` threshold is itself calibrated at the correct $2/pt scale (it was already being applied correctly to the non-BACKFILL "PRICE_CLEAN"/live-resolved family all along).** Fixed via `scripts/repair_dollars_per_point.mjs` (backup: `active_setups_pnl_rescale_backup_20260714`) — rescaled `actual_pnl` directly from each row's already-correct point distances (`stop_level`/`t1_level`/`entry_zone_low`), no need to re-run any of today's detection/resolution logic. All 6 `repair_*.mjs` scripts also corrected at the source (`PT=2, COMM=1`) so re-running them in the future won't reintroduce the bug. Recalibrated `backtest_setup_status.mjs` + `update_optimal_stops.mjs` afterward — **14 more recommendation flips**, several `SUPPRESS→ACTIVE`/`PROMOTE→SUPPRESS` (the rescaling moved several near-boundary EVs across the `-$5` threshold in both directions): `CAM_S1_FADE_SHORT`, `FLOOR_R1_FADE_LONG`, `IB_MID_SCALP_FADE_SHORT`, `OR_HIGH_FADE_SHORT`, `PD_IB_HIGH_FADE_LONG`, `PD_VAH_FADE_LONG`, `PD_POC_FADE_LONG`→`ACTIVE`; `CAM_R1_FADE_SHORT`, `CAM_S1_FADE_LONG`, `FLOOR_S1_FADE_LONG`→`SUPPRESS`; `IB_LOW_FADE_LONG`, `PD_VAL_FADE_LONG`→`PROMOTE` (⚠ same trailing-90-day caution as before — not cleared for live); `PD_POC_FADE_SHORT`→`PROMOTE`; `OPEN_DRIVE_LONG` settled back to `SUPPRESS`. **Corrected final EV for the two original investigation targets**: `CAM_R4_FADE_SHORT` N=114 EV=**-$12.95** (still `SUPPRESS`, was wrongly shown as -$34.87), `CAM_S3_FADE_LONG` N=141 EV=**+$7.98** (still `ACTIVE`, was wrongly shown as +$17.45) — same sign, correct real magnitude. **Not done**: did not go back and edit every individual dollar figure already written into the CAM_R4/CAM_S3 entry and others below — too much prose to safely edit without introducing transcription errors; treat every dollar-EV number dated 2026-07-14 elsewhere in this file as directionally correct but ~2.5x overstated in magnitude for `BACKFILL`-sourced types, and use this corrected notice + a fresh `performance_audit` query as the source of truth going forward, not the historical prose.

- ~~**Execution-quality audit (proposed 2026-07-14) — 3 of 4 levers never started.**~~ — **Resolved 2026-07-16**, see the new entry at the top of this file for the full account. Short version: lever 1 (detection latency) unchanged from below. Levers 2 (fill/slippage) and 4 (stop/target discipline) turned out to be blocked on a real, deeper problem — the only trade-to-setup attribution link (a 5-min time-proximity match) recovers only ~4 real matches across the *entire* trade history once direction and price-proximity are correctly checked, far below N≥20. Lever 3 (sizing-multiplier adherence) uncovered a genuine live bug instead: the elaborate ~20-factor level-fade `sizeMultiplier` was being silently overwritten by a crude post-loss binary flag before ever reaching the DB or the live API response — fixed.

- **IB_BULLISH live incident (2026-07-14) — root-caused and fixed same day, two follow-ups still open.** Live `IB_BULLISH` (fired 09:58 ET, entry 29783/stop 29704/T1 29879) hit its stop for -$159 while every other context signal on the dashboard (overnight `SHORT TRAP`, Permission Slip 69% SHORT N=171, 3 session-signal stats all 72-74% SHORT, Claude's own "Ask Claude" read) was calling for SHORT/WAIT. Investigation found: (1) `IB_BULLISH`'s blended live EV was -$27.81/trade (N=106) — a real structural loser, not bad luck; (2) `backtest_setup_status.mjs` was unconditionally skipping the standard SUPPRESS check for `IB_BULLISH`/`IB_BEARISH` (the `DAY_TYPE_CONDITIONAL` set) and deferring to per-day-type gating in `acd.js` instead — but that gating (`server/routes/acd.js` ~line 3762, `if (dtClass === 'BALANCE' && ibSetup) ibSetup = null;` etc.) depends on `acd_daily_log.day_type`, which isn't classified until IB close at 10:30 ET, while `IB_BULLISH`/`IB_BEARISH` fire off a deliberate 30-min IB window and could fire as early as 10:00 — so the day-type check was a guaranteed no-op every time it mattered; (3) a set of in-code comments (2026-07-07 Opus Audit 2 vintage) claiming IB_BULLISH's TREND-day EV was "+$16 EV solid" had silently drifted to -$16 EV by 2026-07-14 — same silent-drift pattern as prior incidents, just in a comment instead of a live string this time. **Fixed same session:** moved the IB_BULLISH/IB_BEARISH fire gate from `etMin>=600` to `etMin>=630` (acd.js) so `dtClass` is always known by fire time (30-min IB *level* definition unchanged, still spec); extended `backtest_setup_status.mjs`'s `DAY_TYPE_CONDITIONAL` handling to compute real per-day-type EV and fall through to `SUPPRESS` if every bucket with N≥20 is below the standard `-$5` bar (reuses existing constants, no new thresholds) — `IB_BULLISH` now correctly shows `SUPPRESS` (all buckets confirmed negative: BALANCE N=53 EV=-$47, TREND N=34 EV=-$16), `IB_BEARISH` correctly stays `DAY_TYPE_MANAGED` (TURBULENT N=30 EV=+$78 is genuinely strong); wired `_suppressedSetups` into the `ibSetup` candidates-array check (`acd.js` ~line 5293) alongside the existing DOW check; corrected all 3 stale in-code comment blocks with today's verified numbers.
  - ~~**Still open (1): the level-fade candidates array and the session-bias/context layer... don't check each other before firing.**~~ — **Resolved 2026-07-16.** A flag-only version of this already existed for IB_BULLISH/IB_BEARISH by the end of this incident (`sessionConflictFor`, ~line 3505) but was never extended or escalated — found while working the design decision. User chose: extend to the level-fade family, fold into `sizeMultiplier` as a real size-down factor (not suppression), backtest the delta first rather than guess. See the new entry at the top of this file for the backtest (N=4,037 CONFLICT vs N=1,887 NO_CONFLICT, $43.55/tr delta, confound-checked) and the live wiring.
  - **Still open (2): broader audit of all setup types requested by the user 2026-07-14** ("we might need to look at the guts of all my setups to be sure they are working as expected") — **partially addressed 2026-07-16**, see the new entry at the top of this file. Found and fixed a real regression (IB_BULLISH's `DAY_TYPE_CONDITIONAL` recovery logic had silently un-suppressed it back to `ACTIVE` despite EV=-$29/trade) and one bounded-risk stale calibration row (`MOMENTUM_60m_60m_TREND`). Exemption-pattern hunting, standalone-poller promotion gaps, and Unified Signal Table status-mapping were checked systematically (all clean beyond the one regression); a full manual per-type stop/target-simulation pass (checklist item 5) across the long tail beyond the level-fade family is still not done — flagged as the honest remaining scope if a deeper pass is wanted.
    - **Methodology that made today's pass work — repeat this, don't shortcut it:** (a) query live numbers directly (`active_setups`, `performance_audit`) rather than trusting an existing `recommendation` label, a code comment, or a prior session's stated conclusion — the IB_BULLISH comments claiming "+$16 EV solid" were from a real 2026-07-07 audit that had simply gone stale, and would have been trusted at face value without a direct requery; (b) specifically hunt for *exemption* patterns — anywhere a setup type is carved out of the standard pipeline check (like `DAY_TYPE_CONDITIONAL` skipping `SUPPRESS`) — and verify the carve-out's own replacement mechanism can actually fire before the setup's own decision point, not just that a check exists in the code; (c) when fixing, extend/reuse the existing pipeline and its existing constants (`SUPPRESS_MIN_N`, `SUPPRESS_MAX_EV`) rather than adding a new hardcoded check to `acd.js`; (d) when building something new that could affect live firing (like the session-bias cross-check below), default to a visible flag, not silent suppression, until it's been observed for a while; (e) after every change, verify with a direct query AND a live endpoint curl — don't stop at "syntax check passed" or "no crash on save" (a transient nodemon-restart-window error surfaced once during today's work and was confirmed harmless only by retrying live, not by assumption); (f) correct stale comments/claims when found, not just the specific number that triggered the investigation — three separate in-code comment blocks had drifted, not one.
    - Candidate approach for the mining side specifically: Gemini for the data-mining half (per-setup live EV pulls, day-type/DOW breakdowns) per the Gemini-for-mining/Claude-for-implementation convention, Claude for the code-path verification half (does each setup's suppression actually get a chance to run before it fires, per (b) above) — mirrors how this specific incident was solved. Audit Gemini's pulled numbers the same way (b) says to audit existing code comments — don't skip that step just because a different agent produced the number this time.
    - **Priority order decided 2026-07-14, superseded same day (see the "CAM_R4/CAM_S3 investigation" thread below for what actually happened):** the original plan was to check `CAM_R4_FADE_SHORT`/`CAM_S3_FADE_LONG` first, then the rest of the then-current top-8 by EV. That investigation instead surfaced 2 systemic data bugs (duplicate-bar contamination across all 72 BACKFILL-sourced setup_types, and a backtest-window-vs-live-firing-window mismatch verified so far only for CAM_R4/CAM_S3) and both are now partially fixed — see that thread for the full account, including the 13 real ACTIVE→SUPPRESS flips this produced. **Updated priority order for the next session**: (1) re-verify the window mismatch (bug 2) for the rest of the *current* top-8-by-EV (re-pull the ranking fresh — it moved after today's recalibration), being careful with formation-time-dependent levels (IB/OR) to avoid introducing lookahead; (2) only after that, sweep the remaining setup_types more lightly per the original checklist-items-5-9 plan.

- ~~CAM_R4/CAM_S3 investigation (opened 2026-07-13)~~ — **Resolved 2026-07-14 into a full-corpus repair.** The original 111-vs-56 count-gap question turned out to be moot (a lost ad-hoc scratch script from a prior session, not a real bug) — but investigating it properly surfaced four real, verified data-integrity bugs affecting the entire level-fade backfill corpus (72 setup_types, every `resolution_method='BACKFILL'` row in `active_setups`, 6,375 rows final). All four are now fixed for the full corpus (all 34 base level families, zero exclusions).
  1. **Duplicate-bar contamination — fixed for all 72 setup_types.** `scripts/archive/backfill_level_fades.js` queried raw `price_bars` directly instead of the deduped `price_bars_primary` view (the duplicate-minute-bar fix from 2026-07-13, docs/KNOWN_ISSUES.md item 8) — it predates that fix and was never re-run. Fixed via `scripts/repair_backfill_duplicate_bars.mjs` (backup: `active_setups_backfill_backup_20260714`).
  2. **Backtest-window (10:30am-noon) vs. live-firing-window (any RTH touch, ~9:34 AM on) mismatch — fixed for all 34 base level families, in 5 waves.** Live `acd.js` (`nearLevels`, ~line 4757) has no window restriction; the archived backfill script does. Re-simulating "first touch anywhere in RTH" against clean data, using the *correct formation gate per level type* (not a blind 9:30 start — that would introduce lookahead for same-day-forming levels):
     - **Wave 1** (`scripts/repair_cam_r4_s3_window_mismatch.mjs`): `CAM_R4`, `CAM_S3` (gate 570, prior-session Camarilla pivots).
     - **Wave 2** (`scripts/repair_top8_window_mismatch.mjs`): `PD_OR_MID`, `PD_IB_HIGH`, `PD_POC`, `FLOOR_S1`, `CAM_R1`, `CAM_S2`, `CAM_S4` (gate 570), `OR_LOW` (gate 575 — OR forms from bars 570-574, valid at 9:35 ET, `acdService.js` ~line 359).
     - **Wave 3** (`scripts/repair_remaining_window_mismatch.mjs`): `OR_HIGH` (gate 575), plus 20 more prior-period-derived families at gate 570: `PD_VAH`, `PD_VAL`, `FLOOR_PIVOT`, `FLOOR_R1`, `PD_IB_MID`, `PD_IB_LOW`, `PD_SESSION_MID`, `5D_OR_MID` (confirmed via its own query using `trade_date < $1` — strictly backward-looking despite being labeled `CURRENT` category in `compute_levels.js`; verified the actual WHERE clause, not the label), `WS1`, `WS2`, `WR1`, `WR2`, `WPP`, `MPP`, `MR1`, `MR2`, `MS1`, `MS2`, `CAM_R2`, `CAM_R3`, `CAM_S1`.
     - **Wave 4** (`scripts/repair_ib_dependent_window_mismatch.mjs`): `IB_HIGH`, `IB_LOW`, `IB_MID` (`IB_MID_SCALP_FADE`), `OR_MID` (`OR_MID_AFTER_IB_FADE`) at gate 630 (10:30 ET), plus a redo of `PD_IB_HIGH`/`PD_IB_LOW` (waves 2/3 had fixed their window-timing but with stale level values — see bug 3 below) — run only after bug 3 was fixed. Re-run a second time after discovering bug 4 below (some `PD_IB_HIGH`/`PD_IB_LOW` `level_prices` rows were still stale the first time).
     - **Wave 5** (`scripts/repair_weekly_vwap_window_mismatch.mjs`): `WEEKLY_VWAP` (gate 570) — only after fixing its lookahead bug (bug 4 below).
     - Formation-gate classification cross-verified two independent ways before waves 3-5 ran: Claude read `scripts/compute_levels.js` directly; Gemini was independently dispatched the same classification task (`scratch/antigravity_response.md`) — both agreed on every row, including two non-obvious findings Claude found first and Gemini corroborated: IB (as `compute_levels.js` had it) forms at et_min 600 (10:00 ET), not the 630 (10:30 ET) assumed from the day-type-classifier convention elsewhere in this codebase — which turned out to matter, see bug 3; and `WEEKLY_VWAP` has a genuine lookahead bug in its own formula, see bug 4.
  3. **`IB_HIGH`/`IB_LOW` definitional mismatch, found and fixed while chasing bug 2's IB exclusion.** Live `acd.js` computes today's IB from a **60-minute** window (bars 570-629, gated `etMinNow>=630`, `server/routes/acd.js` ~line 4404-4419); `scripts/compute_levels.js` (source of `level_prices`, what historical backfills read) computed IB from a **30-minute** window (bars 570-599) — genuinely different price levels, not just different availability times. Git history: the 60-minute definition in `acd.js` predates `compute_levels.js` by a full month (2026-06-01 vs 2026-07-01) and matches this codebase's documented day-type-classifier convention ("Initial Balance closes" at 10:30 ET, `docs/daytype_classifier_v2_candidate.md`) — strong circumstantial evidence the 30-minute version was the bug, though not a certainty against original design intent (flagged to the user as an unconfirmed judgment call before acting — **user confirmed standardizing on 60-minute**). Fixed at the source: `scripts/compute_levels.js`'s `IB_HIGH`/`IB_LOW`/`IB_MID` and `PD_IB_HIGH`/`PD_IB_LOW`/`PD_IB_MID` blocks now both use bars 570-629; full historical `level_prices` re-backfilled via `node scripts/compute_levels.js --backfill` (backed up first to `level_prices_ib_backup_20260714`).
  4. **`WEEKLY_VWAP`'s own formula had a genuine lookahead bug — found and fixed.** `compute_levels.js` ~line 304-311 computed it via `ts::date BETWEEN wb.mon AND wb.fri` — i.e., through that **week's Friday close**, not just through the date being computed — so any `level_prices.WEEKLY_VWAP` row for a date before that week's Friday reflected volume-weighted price data that hadn't happened yet relative to that date. Fixed by changing the end bound to `date` (now a legitimate week-to-date VWAP as of each date); full historical `level_prices` re-backfilled (backup: `level_prices_weeklyvwap_backup_20260714`).
  5. **Both `--backfill` runs (bugs 3 and 4) silently skipped ~40-41 dates each under concurrent DB load, with no visible error in the piped/tailed console output — found and fixed.** Discovered by spot-checking a date against a raw SQL recomputation and finding it still matched the *pre-fix* formula despite the backfill reporting success. The per-date `try/catch` in `compute_levels.js --backfill`'s loop swallows failures to `console.error`, invisible when output is piped through `tail`. Diagnosed via `level_prices.computed_at` staleness (any row not touched on run day was suspect) and fixed by re-running `compute_levels.js <date>` individually for each stale date (all succeeded standalone, confirming the failures were concurrency-related — likely contention with the live server's 60s poller and the many other scripts run against the same DB this session — not a real per-date computation bug). **Lesson, now in CLAUDE.md**: never trust a truncated/piped console summary as proof a `--backfill` run is complete; verify with a freshness check across the full expected date range.
  6. **Found and self-healed, root cause not fully identified: all 98 `WEEKLY_VWAP_FADE_LONG`/`SHORT` rows vanished from `active_setups` sometime between the duplicate-bar fix (bug 1) and the window-mismatch fix (bug 2/wave 5).** Confirmed isolated to just this one setup_type (4 other recently-suppressed setup_types spot-checked, all had expected row counts intact) and confirmed NOT caused by `expireStaleSetups()`'s SHADOW-row cleanup (only deletes `status='SHADOW'` rows; every backfill-sourced row is inserted already-`RESOLVED`/`EXPIRED`). Self-healed by wave 5's own full backup+delete+reinsert cycle, so no data was permanently lost, but worth a quick row-count sanity check on other setup_types in a future session if anything looks unexpectedly thin.
  - **Full-session recommendation-flip count: 32** (final, after all fixes above), comparing the very first pre-session `performance_audit` SETUP_STATUS snapshot to the final state. ACTIVE→SUPPRESS (real losers unmasked): `CAM_R1_FADE_LONG`, `CAM_R3_FADE_LONG`, `CAM_S1_FADE_SHORT`, `CAM_S4_FADE_LONG`, `FLOOR_R1_FADE_LONG`, `IB_LOW_FADE_LONG`, `IB_LOW_FADE_SHORT`, `IB_MID_SCALP_FADE_SHORT`, `OR_HIGH_FADE_SHORT`, `OR_MID_AFTER_IB_FADE_LONG`, `PD_IB_LOW_FADE_LONG`, `PD_IB_LOW_FADE_SHORT`, `PD_VAH_FADE_LONG`, `PD_VAL_FADE_LONG`, `WEEKLY_VWAP_FADE_LONG`, `WEEKLY_VWAP_FADE_SHORT`, `WS1_FADE_LONG`, `PD_OR_MID_FADE_LONG`, `MPP_FADE_LONG`, `MR1_FADE_LONG`, `CAM_R4_FADE_SHORT` (the original investigation target — went from a claimed $84.56 EV top-4 setup to a confirmed -$34.87 EV structural loser). SUPPRESS/THIN_N→ACTIVE (real recoveries): `5D_OR_MID_FADE_SHORT`, `CAM_S2_FADE_SHORT`, `IB_HIGH_FADE_SHORT` (N nearly doubled to 248 once the correct 60min IB was used, EV flipped -$28.94→+$5.29), `MPP_FADE_SHORT`, `PD_OR_MID_FADE_SHORT`, `WPP_FADE_SHORT`. `CAM_R1_FADE_SHORT`, `CAM_S1_FADE_LONG`, `FLOOR_S1_FADE_LONG`, `PD_POC_FADE_LONG`→`PROMOTE` (⚠ trailing-90-day recovery, all-time EV still negative for all 4 — same caution as `OPEN_DRIVE_LONG`'s earlier razor-thin promotion, this bucket also oscillated PROMOTE↔SUPPRESS across recalibration waves as sample composition shifted slightly each time; worth a manual look, don't treat as cleared-for-live). `OR_HIGH_FADE_LONG` and `IB_HIGH_FADE_LONG` both went ACTIVE→`THIN_N` (N dropped to 18 and 10 respectively once duplicate/mistimed/wrongly-defined fires were removed — legitimate sample-size corrections, not red flags; `IB_HIGH_FADE_LONG`'s original N=81 was mostly a window-definition artifact). `OPEN_DRIVE_LONG` settled at `SUPPRESS` (its earlier razor-thin `PROMOTE` didn't survive full recalibration).
  - ~~NOT done: `AlphaEngineOverview.jsx`'s hardcoded `suppressed` narrative list (~line 465) is now significantly more stale~~ — **Fixed 2026-07-15**, see docs/KNOWN_ISSUES.md item 11 and the entry near the top of this file's priority list.
  - ~~**NOT done / follow-up needed: query performance on `active_setups`-heavy endpoints has degraded**~~ — **Re-checked 2026-07-16, not currently reproducible.** Direct timing: `/api/performance-audit/unified` ~1.2-1.4s, `/api/acd/setup-detection` <2ms (the latter is served from its existing 20s response cache — real cold cost not separately isolated, but neither endpoint is anywhere near the 41s/17s previously logged). Likely explained by other fixes landing later in the 2026-07-15/16 sessions (DB pool resize, the `Promise.all` batching pass) after the 41s/17s reading was taken. Dispatched to Gemini for root-cause diagnosis first; both of its specific theories (an N+1 loop calling `getSetupStats` per setup, and a missing `setup_type` index causing a slow momentum-lookback query) were checked directly via `EXPLAIN ANALYZE` and didn't hold up — `getSetupStats` has exactly one call site (on-demand, not a loop) and the momentum-lookback query already runs in 0.19ms thanks to `idx_as_unique_setup`'s `trade_date` ordering satisfying the `LIMIT 10` before a full scan is needed. `active_setups` genuinely has no index leading with `setup_type` alone, but nothing currently measured needs one. Worth a fresh re-measurement if the "trending the wrong way" pattern reappears as the BACKFILL corpus keeps growing, rather than assuming this note is still accurate.
  - **Next session's priority**: the original checklist-items-5-9 sweep of the long tail of setup_types that rarely fire, now that the level-fade data foundation itself is fully clean — no more data-integrity blockers remain from this thread.

- **Claude's own independent minute-bar pattern scanner — RUN 2026-07-13, then discovered/fixed a major data-integrity bug mid-audit, re-run clean, re-audited.** `scratch/claude_minute_bar_scanner.mjs` (revised grid) + `scratch/claude_minute_bar_scanner_original_grid.mjs` (original round-number grid, added 2026-07-13 as a supplementary pass). Both now query the fixed `price_bars_primary` (see below) and are confirmed deterministic (identical output across repeat runs).
  - **First-pass results were substantially an artifact, not a finding.** The initial run (192,125 raw rows) reported 8 "survivors," but re-running the identical script twice back-to-back gave different N/EV for the same combo — traced to `price_bars_primary` having ~23% sub-minute duplicate rows (up to 25 per minute on the worst days) with no deterministic tiebreak, silently corrupting every lookback window. **Fixed the view itself** 2026-07-13 (`GROUP BY symbol, contract, date_trunc('minute', ts)`, deterministic first/last-tick open/close via `array_agg(...ORDER BY ts)`) — see [ARCHITECTURE.md](../ARCHITECTURE.md) and [KNOWN_ISSUES.md](KNOWN_ISSUES.md) item 8 (root cause of the duplicate ingestion itself still not found). This fixes all 23 live/backtest consumers identified in the same audit, not just the scanner.
  - **Corrected results on clean data (148,634 true 1-min bars, both grids re-run, confirmed deterministic):** the original 8 "survivors" collapsed to **2** on the revised grid and **0** on the original round-number grid — almost everything reported in the first pass was sub-minute tick noise, not a real signal.
    - `MOMENTUM_60m / 60m` (continuation, not fade): N=4,366, WR=51.6%, EV=**+3.10pt/trade**. Audited clean: no day clustering (top-5 days = 3.3%), smooth time-of-day spread (no single-bucket concentration), same-sign across both directions (long +4.28pt / short +1.78pt — asymmetric, likely reflects NQ's structural uptrend over 2023-2026 rather than a predictor flaw), consistent across all 4 years in the sample.
    - `VOLZ_30m / 60m` (fade): N=3,314, EV=-1.67pt/trade. Same clean audit profile, low overlap with the momentum signal (8.8% shared events — largely independent).
  - **Conditioning pass (2026-07-13, `scratch/claude_minute_bar_conditioning.mjs`) found a real refinement — day-type splits `MOMENTUM_60m/60m` into two separate, opposite-direction edges.** Tested both survivors against DOW, day-type (only for events firing at/after 10:30 ET — `acd_daily_log.day_type` reclassifies at IB close, so pre-10:30 events are excluded from this breakdown, ~20% of events), proximity to the 54 lookahead-safe levels in `level_prices` (excluded `CURRENT`-category and `VWAP`-category levels — confirmed empirically via `scripts/compute_levels.js` that `WEEKLY_VWAP` spans the current week including today's own bars, so it and `OR_*`/`IB_*`/rolling-average levels are same-day-forming and unsafe to condition on), and confluence count. Re-ran the same 3-way chronological stability check used on the base signals against every day-type cell before trusting any of it:
    - `MOMENTUM_60m/60m` on **TREND** days: N=691, EV=**+10.63pt/trade** (continuation) — STABLE across all 3 chronological thirds (2.7 → 16.1 → 13.1). ~3.4x the unconditioned baseline.
    - `MOMENTUM_60m/60m` on **BALANCE** days: N=1,996, EV=**+4.62pt/trade as a fade** (i.e. reverse the base signal's direction) — STABLE (-1.3 → -4.8 → -7.7 as continuation, same sign all 3 thirds). A second, previously-invisible edge that only appears once split by day-type — maps directly onto this codebase's existing conditional-variant pattern (same reading, opposite setup type by condition, like `WPP_FADE_SHORT` vs `WPP_FADE_SHORT_GAP_UP`).
    - Everything else conditioned did NOT survive: `MOMENTUM_60m/60m` on TURBULENT days looked strong (+13.83pt) but is UNSTABLE (9.8 → -3.8 → 35.3, driven by one wild stretch). `VOLZ_30m/60m` conditioned on day-type is UNSTABLE in all 3 buckets, including a TREND slice that looked promising before the stability check (+5.99pt overall, flips sign 5.4 → -4.7 → -18.5). DOW and level-proximity/confluence-count breakdowns were non-monotonic for both signals (classic slicing-noise signature) and weren't even worth a stability check — treat as unconfirmed, not a lead.
  - **Recent-vs-all-time check (2026-07-14):** all 4 real signals hold the same direction in the last 60 trading days as all-time — `MOMENTUM_60m/60m` unconditioned 1.84x stronger recently (+5.68 vs +3.10pt), TREND-conditioned 1.37x stronger (+14.52 vs +10.63pt), BALANCE-fade 2.12x stronger (+9.78 vs +4.62pt as fade). `VOLZ_30m/60m` is the one weakening (0.68x, -1.14 vs -1.67pt) — still same direction, still above cost floor, but worth watching.
  - **Now persisted and tracked forward, not just ad-hoc scratch scripts (2026-07-14).** `scripts/backtest_minute_bar_scan.mjs` computes the full grid — every predictor/lookback/horizon combination (momentum at every integer 1-20 plus 30/60 minutes, range/volz at {5,15,30,60}, body-ratio, VWAP-distance, all × horizons {5,15,30,60} = 128 combos) plus the 2 day-type-conditioned variants = 130 signals — and writes **every one, profitable or not**, to `performance_audit` (`signal_type='MINUTE_BAR_SCAN'`, idempotent same-day DELETE+INSERT), two rows each (`window_days=0` all-time, `window_days=60` recent) so drift is queryable the same way other signal_types already track it. Added to `run_weekly_backtests.sh` for ongoing monitoring. Result: **4/130 pass the full rigor bar** — the same 4 already described above; the expanded 1-20-minute momentum sweep found nothing new.
  - **Gemini cross-check (2026-07-14):** dispatched the 1-20min momentum lookback sweep to Gemini in parallel (genuine combinatorial exploration of untested lookback values — a legitimate fit for its lane, unlike the persistence pipeline itself). Its run hit a real file-corruption bug mid-write (own narration text interleaved into the output — `agy`'s stdout racing its own file write; it self-diagnosed and worked around it via a manual `scratch/clean_report.md` copy), but the final settled data was clean and internally consistent (checked: duplicated rows had identical values, not conflicting ones). Independently spot-checked 2 combos directly against the DB — Gemini's numbers were correct within ~0.3% (traced the small gap to a real, explainable cause: Gemini's SQL used `<= CURRENT_DATE`, pulling in 964 partial bars from today's still-in-progress session, vs. this codebase's `< CURRENT_DATE` convention of full days only). Gemini's own conclusion (0/80 combos pass the bar) held up and is now folded into the persisted 128-combo grid above under the consistent date convention, rather than kept as a separate, slightly-different-window dataset.
  - **Critical correction (2026-07-14) — 3 of the 4 "validated" signals above turn negative EV once given a real stop/target.** The audit above (day-clustering, time-of-day, 3-way stability, recent-vs-all-time) all validated the *sign* of a raw time-exit value ("where's price at bar+60"), which has no stop and no drawdown tolerance — it is not a tradeable strategy. Built `scripts/backtest_momentum60_daytype.mjs` to derive a real stop/target from MAE/MFE within the same window (p75 MAE = stop, p50 MFE = target, same convention as `update_optimal_stops.mjs`) and re-simulate each as an actual bar-by-bar price-based trade. Result: unconditioned `MOMENTUM_60m/60m` → **-$15.75/trade**, `VOLZ_30m/60m` → **-$18.49/trade**, `MOMENTUM_60m_60m_BALANCE_FADE` → **-$3.20/trade** (N=1,983) — all losers despite passing every earlier statistical check. **Only `MOMENTUM_60m_60m_TREND` survives**: N=714, WR=65.3%, **EV=+$10.72/trade**, stop=71.0pt/target=46.0pt. Lesson for future sessions: a statistically-stable *direction* on a raw point value is necessary but not sufficient — always simulate the real stop/target before calling anything tradeable.
  - **`MOMENTUM_60m_60m_TREND` wired live (2026-07-14), `status='SHADOW'`.** New poller `server/services/minuteBarSignalDetector.js` (modeled on `phaseChangeDetector.js`'s rolling-bar-window shape, not the level-touch candidates array — this signal isn't level-based) runs on the same 60s cycle as the level-fade engine (`server/index.js`). Gated to TREND days only, ≥10:30 ET (day-type isn't final before IB close). Stop/target read live from `performance_audit` `OPTIMAL_STOP` — never hardcoded. `SHADOW` (not `ACTIVE`): zero live trades so far, and this is a brand-new kind of signal discovered this session — the permission system itself flagged the initial `ACTIVE` choice as insufficiently justified by the `WPP_FADE_SHORT_GAP_UP` precedent (that was a minor variant of an *already-live* type; this is genuinely new), which was the right call — fixed before anything shipped. Fired setup_type is direction-suffixed at insert time (`MOMENTUM_60m_60m_TREND_LONG`/`_SHORT`) so the existing generic `isLongSetup()`/`inferDirection()` machinery works with zero changes to the resolver. **Monitor at live N≥20** (same convention as `WPP_FADE_SHORT_GAP_UP`) before ever promoting to `ACTIVE`. Not registered in `CONDITIONAL_VARIANTS` (no shared base type — it's a standalone new signal, not a variant of an existing one); `test_invariants.mjs` still covers it via the broader OPTIMAL_STOP↔SETUP_STATUS pairing check, confirmed passing.
  - **Not yet done:** (1) `MOMENTUM_60m/60m`'s conceptual overlap with `OPEN_DRIVE`/`IB_BEARISH` still unchecked; (2) the IB-anchored version (literal 9:30-10:30 IB range, not a rolling window) still never run; (3) the 3 rejected signals' backtest-derived SETUP_STATUS rows show `recommendation='ACTIVE'` (mechanically correct per this codebase's -$5 suppress threshold — `BALANCE_FADE` at -$3.20 doesn't cross it) even though none of them are wired live — don't be misled by that label if reading `performance_audit` directly; the AlphaEngineOverview.jsx entry documents this clearly.

- **Every live setup's stop/target calibration — DONE, full recalibration re-run 2026-07-14.** `run_weekly_backtests.sh` re-run in full against the fixed `price_bars_primary` (all 23 consumers identified 2026-07-13). Gemini audited the before/after diffs — findings below, independently spot-checked before accepting.
  - **35 setup_types had stop/target shift >30% (often 50-80% tighter).** Verified this is a real methodology change in `update_optimal_stops.mjs`, not data corruption or a bug: it now sweeps the stop candidate across MAE percentiles (P25-P75) alongside the target sweep to maximize EV, rather than hardcoding stop=p75_mae. Gemini's spot-check on 3 setups (`CAM_R1_FADE_LONG` 70→10pt, `FLOOR_PIVOT_FADE_LONG` 82→14pt, `IB_MID_SCALP_FADE_LONG` 60→11pt) showed the tight stop is genuinely EV-optimal in each case (transparent SQL + percentile tables shown) — a wide stop's higher win rate doesn't compensate for the larger loss size. Underlying raw MAE/MFE percentiles themselves barely moved (<1pt) — confirms this is the algorithm working as redesigned, not the data-integrity fix causing this.
  - **Zero SETUP_STATUS recommendation flips** (ACTIVE↔SUPPRESS) — expected, since recommendations key off already-recorded live trade outcomes in `active_setups`, which don't change when historical backtest bar data is corrected.
  - **Caught and fixed a real bug in this session's own new code**: `backtest_minute_bar_scan.mjs` computed its `run_date` via JS `toISOString()` (UTC) while `backtest_momentum60_daytype.mjs` used SQL `CURRENT_DATE` (the DB server runs in `America/New_York`) — the two disagreed by a day once past 8PM ET, so `MOMENTUM_60m_60m_TREND`'s rows were split across two different `run_date`s despite being the same day's work. **Fixed**: standardized on SQL `CURRENT_DATE` (matches the DB server's own timezone and this codebase's ET-based trading-day convention throughout). Note: Gemini's own suggested fix was the *opposite* (standardize on JS UTC) — correctly diagnosed the bug, wrong fix, not followed.
  - **New rigor diagnostic added to the standing pipeline (2026-07-14), not just a one-off audit.** `backtest_setup_status.mjs` now computes day-clustering and 3-way chronological EV-sign-stability for every setup_type, every weekly run — informational only, doesn't feed the SUPPRESS/PROMOTE logic. Results: **38/113 setup_types day-clustering risk, 43/113 fail 3-way stability**; of 52 `ACTIVE`, **26 unstable** (0 clustered). Gemini classified all 26 (`scratch/unstable_active_setups_20260714.json` has the raw data, `scratch/antigravity_response.md` has the full write-up):
    - **3 DEGRADING** (thirds go +→-, trailing-90d also negative, but all have trailing N<20 so directional-only per the hard rule): `CAM_R1_FADE_SHORT` (-$153/trade decline), `WEEKLY_VWAP_FADE_SHORT` (-$72), `PD_VAH_FADE_SHORT` (-$70). Worth a human look, not auto-suppression (N too thin to act on alone).
    - **7 IMPROVING** (thirds go -→+, trailing-90d strongly positive): `PD_SESSION_MID_FADE_LONG`, `PD_POC_FADE_LONG`, `PD_IB_MID_FADE_SHORT`, `5D_OR_MID_FADE_LONG`, `FLOOR_R1_FADE_LONG`, `OR_LOW_FADE_LONG`, `CAM_R3_FADE_LONG` — same pattern as `MOMENTUM_60m_60m_TREND` (instability from getting *better*, not worse).
    - **7 NOISY-BUT-STABLE** (one sign flip, but all-time and trailing-90d both still positive and aligned): `CAM_S1_FADE_LONG`, `FLOOR_PIVOT_FADE_LONG`, `WEEKLY_VWAP_FADE_LONG`, `FLOOR_PIVOT_FADE_SHORT`, `OR_LOW_FADE_SHORT`, `IB_MID_SCALP_FADE_LONG` (N=20 trailing — the one non-thin case here), `CAM_R2_FADE_SHORT`.
    - **9 THIN/AMBIGUOUS**: trailing N too small (≤5) to classify confidently — see the response file for the list.
  - **Bottom line: no setup needs immediate action from this pass.** The 3 degrading ones are worth watching, not suppressing (N<20 trailing). Don't blanket-react to the "26 unstable" headline count — half of what looked like a problem is actually signals getting *stronger*, not weaker.
  - **Automated the classification itself (2026-07-14) — no longer needs a manual Gemini dispatch.** Gemini's DEGRADING/IMPROVING/NOISY_BUT_STABLE/THIN/AMBIGUOUS logic was simple rule comparison (thirds trend direction + trailing-90d sign/magnitude), not real judgment, so it's now encoded directly in `backtest_setup_status.mjs`'s `classifyTrend()` — runs automatically every week, writes to `notes.rigor.trend` on every unstable setup_type's `performance_audit` row. Verified against Gemini's manual read the same day: all 3 DEGRADING matched exactly, IMPROVING/NOISY_BUT_STABLE buckets matched with only minor additions from one more day of live data.
  - **Now visible in the Unified Signal Table (`/api/performance-audit/unified`, `BacktestView.jsx`), not just queryable in the DB (2026-07-14).** New "Stability" column shows Stable/Degrading/Improving/Noisy/Thin/Mixed per setup, color-coded, informational only (doesn't affect the ACTIVE/CONTEXT/REMOVED status column). Found and fixed two real integration gaps while wiring this in, both pre-existing (not introduced this session):
    1. **The table's status-mapping only recognized `KEEP`/`ACTIVE`/`DIRECTIONAL`/`CONTEXT`/`DLL_TRADEABLE`/`THIN`/`CUT`** — `SETUP_STATUS`'s actual vocabulary (`SUPPRESS`, `THIN_N`, `PROMOTE`, `DAY_TYPE_MANAGED`) matched none of them, so ~61 of 113 setup_types (everything except plain `ACTIVE`) were silently invisible in this table. Fixed: `SUPPRESS`→REMOVED, `THIN_N`/`DAY_TYPE_MANAGED`→CONTEXT, `PROMOTE`→ACTIVE. Table now shows 3,904 rows (was showing far fewer before, since most non-ACTIVE setup_types across all signal_types were being dropped) — user confirmed this exact mapping choice before it shipped.
    2. **A saved column order in `localStorage` fully overrides `defaultCols` rather than extending it** — meaning any newly-added column (like this one) would never appear for a user with a previously-customized column order. Fixed generally (merge missing default keys into a saved order) so this class of bug can't recur for future columns either.
    3. **Found a third instance of the JS-UTC-vs-SQL-CURRENT_DATE bug**, this time in pre-existing code (`backtest_setup_status.mjs`, not written this session) — its `today` variable used `new Date().toISOString()` same as the already-fixed `backtest_minute_bar_scan.mjs`. Fixed the same way (SQL `CURRENT_DATE`). This one was actively breaking the Unified Signal Table's "latest run" join for `MOMENTUM_60m_60m_TREND` when caught.
  - **`MOMENTUM_60m_60m_TREND` shows `status='ACTIVE'` in the Unified Signal Table** ($10.72 EV) — this reflects the *backtest* recommendation, not real deployment status, which is still `SHADOW` (silent, no live alerts) pending N≥20 live trades, same existing ambiguity as `WPP_FADE_SHORT_GAP_UP`. Don't read "ACTIVE" in this table as "currently alerting you."
  - **Fixed a real promotion gap the same day, before it could ever matter**: the live poller (`minuteBarSignalDetector.js`) hardcoded `status='SHADOW'` at insert with no re-check — it would have sat in SHADOW forever even after clearing N≥20 live trades with good EV, since nothing else in the pipeline flips a hardcoded status. Unlike the level-fade candidates array (which dynamically checks `liveStats._suppressedSetups`, rebuilt fresh every trading day), a standalone poller has no such built-in mechanism. Added `getLiveStatus()` — checks real resolved `active_setups` trades for the type on every fire, same N≥20/EV>-$5 bar as everywhere else. Verified this is *not* an issue for the other 113 setups (checked the actual candidates-array code — it already does this correctly). Codified as checklist items 7-8 in `CLAUDE.md` so the next standalone poller doesn't repeat it.

- **Perpetual dimensional pattern mining extended to the minute-bar signal families (2026-07-14).** `patternScannerService.js`'s `mineLevelFades()` already does exactly this — conditional "when X touches level L, Y% chance Z" mining across 14 dimensions (dow/hour/session/day-type/range/overnight/open-vs-value), nightly, with `ACTIVE`/`DEGRADED` lifecycle tracking in `pattern_discoveries` — but it's scoped to level touches only, which structurally can't cover a bar-window statistical extreme like `MOMENTUM_60m`/`VOLZ_30m`. New `scripts/mine_minutebar_conditions.mjs` applies the same dimensional cross-cut approach to those event families, writing into the **same** `pattern_discoveries` table (not a second silo) — added to `run_weekly_backtests.sh`, genuinely perpetual, not a one-off. Critically uses **real MAE/MFE-derived stop/target simulation for win/loss** (the exact lesson from earlier today), not the raw point-value-at-horizon the original scanner used.
  - **Rigor diagnostics added to this miner too, same day** (day-clustering + 3-way chronological stability, same as `backtest_setup_status.mjs` — stored per-discovery in `pattern_discoveries.context.rigor`, informational only, doesn't gate ACTIVE status). Of the original 16 discoveries: **only 4 are genuinely clean** (pass both checks):
    - `MOMENTUM_60m_60m:minutebar_daytype:TREND` — N=897, WR=68.0%, $4,603 net, 74 distinct days, 12.4% top-5 concentration
    - `MOMENTUM_60m_60m` TREND×10:00 ET — N=172, WR=75.0%, $3,999 net, 54 distinct days
    - `MOMENTUM_60m_60m` TURBULENT×10:00 ET — N=141, WR=75.2%, $3,343 net, 56 distinct days — genuinely new: the plain TURBULENT day-type aggregate was found unstable earlier today, but this specific hour slice within it is clean
    - `MOMENTUM_60m_60m` TREND×9:00 ET — N=114, WR=72.8%, $2,003 net, 72 distinct days
    - **`MOMENTUM_60m_60m:minutebar_range:EXTREME` looked stable (all 3 thirds positive) but is a false positive** — only 9 distinct trading days, 70.5% of its N=139 from the top-5 days. Sign-stability alone didn't catch this; day-clustering did. Exactly the CAM_R4/CAM_S3-style trap, now caught automatically by this miner instead of needing a manual audit.
    - **All 4 `VOLZ_30m_60m` discoveries and 7 other `MOMENTUM_60m_60m` ones are unstable and/or clustered** — don't trust any pattern_key in this family not listed as clean above without re-checking `context.rigor` first.
  - **Fixed `pattern_key` format to match the established level-fade convention** (`{dimension}:{name}×{value}`, e.g. `level_x_dow:OR_LOW×Thu`) instead of the initial `{family}:{dimension}:{value}` — the mismatch meant these discoveries, despite being `ACTIVE`, would never have surfaced through `morningBrief.js`'s existing DOW/day-type substring matching. Old-format rows deleted and regenerated under the correct format (same 16 discoveries, same numbers, just re-keyed).
  - **Now actually visible on a real daily-facing page, not just in the DB (2026-07-14).** Added the new `minutebar_*` dimension names to `/api/morning-brief/scalp-playbook/:date`'s recognized list (was silently excluding them, same class of gap as the Unified Signal Table's status-mapping earlier). Verified end-to-end against a real TREND day (2026-07-08): 5 patterns now correctly surface in `contextSpecific`. Also found `contextSpecific` **wasn't rendered anywhere in `ScalpPlaybookCard.jsx` at all** (true for the existing level-fade patterns too, not something introduced this session) — added a "Context-Specific Patterns" section to actually display it, with a green/red stability dot sourced from `context.rigor` so a stable and an unstable pattern don't show with equal visual weight. `stable` is `null` (no dot) for older level-fade discoveries that predate the rigor diagnostic.

- **Rigor diagnostic extended to all 4 statistical pipelines + centralized into a shared module (2026-07-14).** Was independently hand-written 3 times the same day (`backtest_setup_status.mjs`, `mine_minutebar_conditions.mjs`, `mineLevelFades()`) before being centralized into `server/services/rigorDiagnostics.js` (`computeRigor()`) — all 3 refactored and regression-verified byte-identical output (one deliberate exception: `backtest_setup_status.mjs`'s minimum-per-third bumped from 3→5 to match the other two, dropping 2 borderline setup_types from the unstable count, 43→41).
  - **`mineLevelFades()` (the pre-existing level-fade pattern miner, ~129 patterns per older memory — actually only 14 `ACTIVE` currently, that figure was stale): 0 of 13 currently-`ACTIVE` patterns are clean.** All 13 are day-clustered (top-5-dates = 56-91% of N), several also chronologically unstable. Read-only diagnostic only — nothing suppressed or changed, this was reported before any action per explicit instruction. Likely structural cause: this miner only uses a rolling 90-day window and level touches aren't independent day-to-day (a level gets tested 3-5x in one choppy stretch, then not again for weeks) — 90 days isn't enough distinct sessions for N≥20 to mean 20 independent instances. Worth deciding: extend the window, or accept these as directional-only.
  - **`mine_tod_patterns.mjs` (the "closes UP/continues morning move X% of days" time-of-day miner — this is where the user's recalled "86% afternoon follows morning" claim would live, though the current closest match is 76% not 86%, worth checking if 86% was a stale pre-refresh number or a different stat entirely): 6 of 7 currently-active patterns are clean.** Only `LATE_MORNING_WINDOW_TREND_DIRECTIONAL` (63% WR, N=75) is unstable. This miner is structurally more robust than the level-fade one — its unit of analysis is one observation per calendar day already, so day-clustering isn't the same risk (N≈distinct-days by construction).
  - **`minePatterns()` (patternScannerService.js's 6 hand-coded "next-day tendency" hypotheses) is a known, unaddressed gap** — no persistence, no ACTIVE/DEGRADED lifecycle, recomputed fresh every call. Structurally different enough (no discovery table to attach a rigor field to) that it needs its own design pass, not a bolt-on. Not done — flagged for a future session.
- **Fabricated-stats audit (2026-07-13) — 6 hardcoded/stale-stat instances found and fixed, 1 lower-priority instance logged.** Triggered by the user noticing a live "SESSION SIGNALS" card and asking "is this wired in?" — it wasn't. Full sweep found a repeating pattern: display code presenting a specific WR%/N/$ literal as if freshly computed, when it was actually hand-typed once and frozen. Fixed:
  1. `scripts/mine_session_bias.mjs` — wrote hardcoded `SESSION_BIAS_ROWS` literals daily instead of the real `enriched`/`stat()`/`reqToFilter()` pipeline already in the same file. Now overwrites `win_rate`/`sample_size` from live 252-trading-day computation before insert; rows with no live computation path (`SB_HIGH_EFF`/`SB_LOW_EFF` need a Kaufman ER backtest that doesn't exist, `SB_TREND_UP_PM_ABOVE`/`SB_TURBULENT_FADE_AM` need tracking fields not in the base query) are skipped rather than left stale. Also fixed a real bug found while doing this: the "252d" window was silently filtering the *entire* all-time `enriched` array (no slice existed) — added `last252e = enriched.slice(-252)` to match `last30e`'s convention.
  2. IB HIGH/LOW re-test cards (`antigravityEdges.js`) — hardcoded `pct:73/63`, plus an entirely fictional "DRIFT WARNING: last 30 days 73%..." narrative. New `scripts/backtest_ib_retest.mjs` computes the real rate: **~46% for both, essentially a coin flip** (not the confident 63-73% edge previously claimed). Fake drift narrative removed (no real 30d-vs-historical comparison exists for this signal).
  3. Gap-fill card (`antigravityEdges.js`) — hardcoded `pct:72/62` + fabricated "85% in last 30 days" claim. New `scripts/backtest_gap_fill.mjs`: real rate is **~54-56%** for both directions.
  4. V-pattern re-extension card (`antigravityEdges.js`) — hardcoded `pct:73, n:338`. New `scripts/backtest_v_pattern.mjs`: real rates **70% (N=170) long / 64.4% (N=160) short**.
  5. `SETUP_CONTEXT` table (`antigravityEdges.js`, fed `adjustedWr`/confidence on "Today's Actionable Setups") — hardcoded per-setup-type adjustments (e.g. `IB_BEARISH: monAdj: -0.20`) applied on top of the already-correct `dynamicEdges` mechanism, which reads real p-value-gated data from `dynamic_edges_mining`. That table covers the exact same dimensions (DAY_OF_WEEK/OR_SIZE/TIME_OF_DAY/TREND_ALIGNMENT) and almost every cell it has is `NEUTRAL` (not significant) — meaning `SETUP_CONTEXT` was applying static deltas on top of conditions its own properly-built sibling mechanism had already determined were noise. Also had a copy-text bug: "-0.7% deviation" didn't match the actual -1% adjustment applied. `SETUP_CONTEXT` removed entirely. Its data source, `scripts/edge_miner.mjs`, had been swept into `scripts/archive/` during the 2026-07-09 "archive 87 orphaned scripts" pass (de3e407) because nothing *called* it directly — but `dynamic_edges_mining` was still being read downstream by `antigravityEdges.js`, so it went 10 days stale while still presented live. Restored to `scripts/`, `MIN_N` raised from 10/15 to this codebase's standard 20 (several previously-"significant" rows were N=10-18), added to `run_weekly_backtests.sh`.
  6. `acd.js` `levelMap.bestCtx` (~30 entries, e.g. `IB_HIGH: '90% WR level fade'`) — directly violated this file's own documented hard rule ("never write a WR claim as a literal number in acd.js"). Rendered live in BacktestView.jsx's Setups guide panel. Fixed by adding `describeLevel(row, fallbackLabel)` which derives the text from each row's own already-fetched `win_rate`/`sample_size`/`ev_per_trade` (real, from `performance_audit`) — applies across all ~3,836 setup rows in that view, not just the ~30 levelMap entries. **Discrepancies found were large and directionally misleading, not just imprecise**: IB_HIGH claimed "90% WR" → real 71% WR at only $3/trade EV (barely breakeven); IB_LOW claimed "88% WR" → real 66% WR at **-$6/trade** (losing money); PD_IB_MID claimed "83% WR" → real 68% WR at -$3/trade; IB_MID_SCALP claimed "82% WR" → real 73% WR at -$5/trade. Three of four "elite" levels were actually running negative EV live while displaying an 80%+ badge.
  - All 4 new backtest scripts added to `run_weekly_backtests.sh` for ongoing freshness (previously: `mine_session_bias.mjs` only ran via a separate daily cron in `server/index.js`, the other 3 didn't exist).
  - **Not yet fixed, lower priority**: `server/routes/morningBrief.js` lines ~1306/1321 — "65% WR at triple confluence (N=112)" / "62% WR at this stretch (N=437)" / "59% WR (N=907)" for the Level Exhaustion/Absorption alerts. Per memory this WAS genuinely backtested and verified accurate on 2026-07-01 (`project_setup_parameters.md`), so it's a frozen-but-was-correct snapshot rather than a fabrication — different severity than the 6 above, but same underlying problem (won't self-update, will silently drift stale). Needs a small backtest script + a `performance_audit` row (signal_type e.g. `LEVEL_EXHAUSTION_TIER`) to make it live like the others.
  - **General takeaway for future sessions**: when adding any live-rendered card with a specific WR%/N/$ claim, either derive it from a `row` field already fetched from `performance_audit` in the same function, or write a dedicated `scripts/backtest_<name>.mjs` that populates one — never hand-type the number, even as a "temporary" placeholder. This is now also stated as a Hard Rule in CLAUDE.md.


- ~~update_optimal_stops.mjs — 2 lower-priority bugs from Opus audit (2026-07-13)~~ — **Fixed 2026-07-14, plus a third, more severe bug found while verifying.**
  - **The real bug: `update_optimal_stops.mjs` had been computing `OPTIMAL_STOP` from a small, disconnected dataset all session, blind to every fix in the CAM_R4/CAM_S3 thread above.** Its query filters on `replay_resolution IN ('TARGET_HIT','STOP_HIT')` — a column populated only by `scripts/backfill_mae_mfe.mjs`'s dedicated bar-by-bar replay step, separate from the `resolution` column the repair scripts set directly at insert time. None of today's ~6,044 backfill-sourced rows had ever been through that replay step, so `mae_points`/`mfe_points`/`replay_resolution` were all `NULL` for every one of them — explaining why the script reported an identical "12 rows upserted" across all 5 recalibration waves today despite `active_setups` changing dramatically each time. **Fixed by running `node scripts/backfill_mae_mfe.mjs`** (explicitly safe to re-run, only touches `mae_points IS NULL` rows) — 6,382 rows updated. Re-running `update_optimal_stops.mjs` afterward went from 12 to **71 rows upserted**. Verified this does NOT affect the 32 recommendation flips already documented above — `backtest_setup_status.mjs` (the actual source of SUPPRESS/ACTIVE decisions) consistently uses `resolution`, not `replay_resolution`, confirmed by grepping every query in that file.
  - **(1) Unit-scaling inconsistency — fixed.** The EV sweep's two modeled branches (`-stop*2`, `+target*2`) assumed a flat $2/pt while the third branch (`actual_pnl`, for expired/partial trades) used real dollars — inconsistent units in the same formula. Dispatched to Gemini to mine the real per-setup_type $/pt from resolved trades (`actual_pnl` vs. real point distance to stop/target); independently cross-checked 2 of its results against direct SQL before trusting (`CAM_R1_FADE_LONG` ~$5.08/pt, `IB_BULLISH` ~$2.01/pt, both matched). Found a clean bimodal split, not the "1.7-4.0x sizeMultiplier-driven variance" originally suspected — Gemini confirmed `size_multiplier` (only populated for 52 of 7,552 rows) isn't the driver; it's simply that the level-fade family of setup_types (the large majority) was built at $5/pt and a second family (`IB_BULLISH`/`BEARISH`, `OPEN_DRIVE`, `OPEN_TEST_DRIVE`, `C_STANDALONE`, `BRACKET_BREAKOUT`, `VALUE_AREA_RESPONSIVE`) at $2/pt. Fixed by deriving real per-setup_type `stopDpp`/`targetDpp` via SQL (median `actual_pnl / point-distance` for `STOP_HIT`/`TARGET_HIT` rows respectively, gated at the same `MIN_N=20` floor used elsewhere in the file, falling back to `DEFAULT_DPP=5` only when a type's own data is too thin) and threading it through `sweepOptimalTarget`/`sweepOptimalStopAndTarget` in place of the flat `*2`. One anomaly flagged by Gemini, not yet investigated: `PD_POC_FADE_SHORT` shows a noisy, non-matching stop-vs-target-implied $/pt (IQR 2.9-3.0 instead of 0.00 like every other type) — possibly mixed contract sizes at different times; worth a look if that setup_type's calibration looks off.
  - **(2) Thin effective N at the chosen stop percentile — fixed.** `MIN_N=20` previously gated on a setup_type's *total* N, not on how many trades actually inform the tail near a high percentile candidate (e.g. only ~25% of trades test a p75 stop by definition — N=20 total means only ~5 trades define where p75 actually lands). Fixed by requiring each percentile candidate to individually clear `MIN_N/(1-pct)` trades before it's eligible (p75 now needs N≥80, p50 needs N≥40, etc.) — derived from the existing `MIN_N` floor per-candidate, not a new hardcoded number.

- **Pattern scanner (`patternScannerService.js`) — the 3 bugs found via Opus review (2026-07-13) are now fixed** (MIN_N 8→20, derived target/stop, chronological win/loss ordering, notify path wired via the new Learning Digest). Remaining, lower-priority: (1) several other hardcoded values in the same function weren't touched — an 8pt level-proximity threshold, a 15-bar re-touch cooldown, 30/31-bar forward windows, and flat 200/400/600pt range-bucket boundaries. None as damaging as the target/stop bug (they're structural windowing choices, not a dollar-scale drifting with NQ's price over years), but they're the same class of issue and worth a fuller pass. (2) **Dimension-overlap caveat**: the current 14 ACTIVE discoveries include groups that likely aren't independent — e.g. `PW_VAH` shows up in `level_x_overnight`, `level_x_openval`, and `level_x_daytype` with identical N=24/net=$640, suggesting these are the same 24 trades sliced 3 correlated ways (SHORT_TRAPPED overnight + ABOVE_VALUE open + TURBULENT day-type plausibly co-occur), not 3 independent confirmations. Not verified trade-by-trade yet — worth doing before treating "14 discoveries" as 14 distinct edges.

- **Monitor today's live-trading changes (2026-07-13) over the next several sessions.** Both `update_optimal_stops.mjs` (stop-sweep methodology rewrite, twice-corrected) and `patternScannerService.js` (target/stop + ordering fix) changed parameters that feed real position sizing/stops, same day they were built. No production trading cycle has run against either fix yet. Watch `learning_digest_events` and `OPTIMAL_STOP`/`SETUP_STATUS` day-over-day for anything that looks like a repeat of the p90-artifact pattern.

- **Gemini's historical minute-bar mining, re-dispatched 2026-07-13 ("Part 2") — much improved, partially audited, still not fully validated.** Superseded the same-day first pass (which silently narrowed to 2023-11-15 for no stated reason). Part 2 correctly and transparently justified the same 2023-11-15 cutoff with real evidence (232 pre-2023-11-15 days are single synthetic zero-range bars with zero delta — independently verified against the live DB, confirmed exact: 150/232 zero-range, 232/232 zero-delta). Of its 3 findings: **Balance Day Streak Persistence** (71% WR after 2 consecutive BALANCE days) and **Volatile Day Streak Continuation** (78% WR after 2 consecutive TURBULENT days, N=32) both independently reproduced almost exactly via direct SQL — reasonably trustworthy as CONTEXTUAL_SIGNAL candidates.
  - ~~The flagship **Delta Divergence Momentum Continuation** (N=115, 60% WR, $245/trade EV)... needs a real dedicated `scripts/backtest_delta_divergence_momentum.mjs` before it goes anywhere near live.~~ **Checked 2026-07-17, definition is unrecoverable, not re-verifiable as specified.** Searched `git log --all -S"Delta Divergence"` and grepped the full repo — the only surviving artifact naming "delta divergence" is an unrelated same-named signal in `server/routes/edge.js` (IB order-flow-vs-price-direction → PM reversal, a completely different concept). The actual definition (the specific "rolling per-day σ-calibrated thresholds" Gemini used for its delta-divergence detection, and the exact "momentum continuation" outcome window) only ever existed in `scratch/antigravity_response.md`, which has been overwritten by every subsequent Gemini dispatch since (most recently by this session's own prop-backtest work). **This is a real instance of the exact landmine this codebase's own conventions exist to prevent** — a tested, real-looking finding (N=115, $245/trade EV) with no durable record of its own methodology, so nothing can re-check it and it can't be honestly promoted to live either. Do not attempt to reconstruct/redefine it from memory and re-test under the same name — that would risk exactly the "two independent reimplementations disagreeing" failure mode already documented elsewhere in this file (the `classifyRegime()` incident). If this candidate matters enough to pursue, it needs to be re-mined from scratch as a NEW hypothesis with its methodology written into the dispatch prompt (and ideally the resulting script) from the start, not treated as "re-verifying" a prior finding that no longer has a checkable definition.

- **WPP_FADE_SHORT_GAP_UP — monitor at N=50 (live 2026-07-09).** Gap-up subset (historical/retrospective): WR=59.3%, EV=+$8.7, N=27. **Checked 2026-07-13: live N=0** (zero rows with `setup_type='WPP_FADE_SHORT_GAP_UP'` in `active_setups` since going live — only 2 trading days have passed). Re-check when live N reaches 50; suppress via pipeline if EV drops below -$5.

- **Full-history strongest-setups ranking (Gemini, 2026-07-13)** — comprehensive N/WR/EV/split-sample/90-day-trend/composite-score ranking across every `setup_type`, full report in `scratch/antigravity_response.md` (will be overwritten by the next Gemini dispatch — pull anything else needed from it before then). Spot-checked one claim (`PD_IB_MID_FADE_LONG`) against direct SQL: exact match (N=62, WR=71.0%, EV=$17.95, 90d N=8 EV=-$6.69). Supersedes and expands the 2026-07-09 degradation watch below — 10 currently-`ACTIVE` setups flagged for suppression review based on negative trailing-90-day and/or negative-second-half EV (all N-gated, thin-N ones excluded):
  - `OR_HIGH_FADE_SHORT`: all-time N=103 WR=77.7% EV=$67.02 → 90d EV=**-$22.89** (N=22)
  - `CAM_S2_FADE_LONG`: all-time N=73 WR=76.7% EV=$70.28 → 90d EV=**-$12.77** (N=11)
  - `PD_IB_MID_FADE_LONG`: all-time N=62 WR=71.0% EV=$17.95 → 90d EV=**-$6.69** (N=8, thin)
  - `CAM_R1_FADE_SHORT`: all-time N=57 WR=70.2% EV=$25.29 → 90d EV=**-$127.90** (N=7, thin)
  - `WEEKLY_VWAP_FADE_SHORT`: all-time N=49 WR=63.3% EV=$1.08 (already marginal) → 90d EV=**-$70.75** (N=10, thin)
  - `IB_MID_SCALP_FADE_LONG`: all-time N=102 WR=68.6% EV=$9.53, 2nd-half EV **-$12.28** (structural degradation, not just a recent-window blip)
  - `CAM_S4_FADE_SHORT`: N=24 (thin all-time), 2nd-half EV **-$24.25**
  - `OPEN_DRIVE_LONG`: status is `PROMOTE` (verified: `backtest_setup_status.mjs`'s recovery-detection thresholds `PROMOTE_MIN_N=15`/`PROMOTE_MIN_WR=0.52`/`PROMOTE_MIN_EV=0` are genuinely met — not a bug) but only barely: 90d N=15 (right at the floor), EV=$4.33/trade (barely above the `>0` bar), while all-time EV is **-$12.17** and 2nd-half is **-$20.66**. This is a real, working-as-designed promotion trigger, but a razor-thin one — worth a manual look before it actually goes live, not an auto-trust. Separately: `PROMOTE_MIN_N`/`_WR`/`_EV` are themselves hardcoded static literals gating a real live suppress/promote decision — a different instance of the "no static thresholds" hard rule than the display-card fabrications fixed this session (2026-07-13), not fixed here, worth a dedicated look (should recovery detection use a rolling-distribution-derived bar instead of flat 15/0.52/0?).
  - `PD_VAH_FADE_SHORT`: this is the same setup already flagged 2026-07-09 (prior 90d=-$68/N=15) — refreshed number is 90d EV=**-$48.39** (N=14), still negative, still degrading
  - `CAM_R1_FADE_LONG`: all-time N=64 WR=64.1% EV=**-$4.45** (already negative all-time), 2nd-half EV **-$44.68**
  - No suppressed setup met the reverse (promotion-candidate) bar — none were flagged as wrongly-suppressed strong performers.
  - Monitor on next weekly run (Sun 9:20 PM) and re-diff against this baseline.

- **IB_BEARISH all-stop sweep negative (2026-07-09).** Best EV at 20pt stop = -$21 (all-day-type blended, BALANCE drag). On TURBULENT IB_BEARISH is elite. Monitor: if TURBULENT-only IB_BEARISH shows negative EV via DAY_TYPE_ALPHA, consider removing from candidates entirely.

- **Pulse score — revisit at N≥100 live setups.** Demoted to informational 2026-07-08 (too many false negatives on strong days). Score chip visible in setup cards. `scripts/backtest_pulse_score.mjs` accumulates data weekly. Revisit: if BALANCE_SCORE_0 false-negative rate <40% on non-TURBULENT days at N≥100, consider re-enabling -0.10× penalty only.

- **sizeMultiplier re-audit at N≥100 (~2026-08-20).** `size_multiplier` column added 2026-07-06. Re-run `SELECT ROUND(size_multiplier,1), COUNT(*), ROUND(AVG((resolution='TARGET_HIT')::int)*100,1) AS wr FROM active_setups WHERE size_multiplier IS NOT NULL GROUP BY 1 ORDER BY 1` when N≥100. Freeze policy: no new ±0.10 factor tweaks until capture ratio improves or audit completes.

- **AI_SETUP_AGG accumulating — monitor (~2026-08-07).** `scripts/aggregate_ai_setup_reviews.js` flags NEEDS_ADJUST when avg < 3.5⭐ and N≥20. Currently N=1 for all 8 setups — need ~4 weeks of daily reviews.

- ~~**HomeAssistant hosting (future, no timeline).** Access journal from HA sidebar via Cloudflare Tunnel (already running). Easiest: add `panel_iframe` to HA `configuration.yaml` pointing at tunnel URL — no backend/frontend changes. Prerequisite: verify tunnel URL is stable (not ephemeral trycloudflare.com free tier).~~ — **Resolved 2026-07-29.** Built as a persistent named tunnel (not the ephemeral free-tier concern this entry worried about) at `tj.6claire.page`, serving a dedicated standalone page (`server/public/quick-check.html`, `GET /quick-check`) rather than an iframe of the full app, with Cloudflare Access (Google OAuth) + exact-path ingress allowlisting in front of it. This entry sat here describing already-built work as "future, no timeline" for long enough that it was actively misleading — see CLAUDE.md's "Where to look" section (new entry, same date) for the real, current pointer, and Claude's own memory `reference_ha_cloudflare_tunnel.md` for full history.

## 30-day shadow validation

- **IB_MID_SCALP_FADE_SHORT and OR_MID_AFTER_IB_FADE_SHORT** — both flip positive with tight stops but currently suppressed pending live validation. Check ~2026-08-05.

- **Globex `sizeMultiplier` pair-bonus wired (2026-07-27).** `detectGlobexSetup()` (`server/routes/acd.js`) previously had NO `sizeMultiplier` concept at all — its INSERT statement never included a `size_multiplier` column, even though `backtest_confluence_globex.js` (2026-07-22) had already validated 5 real overnight confluence pairs (`PD_IB_LOW+PD_LOW` $10.56, `FLOOR_PIVOT+PD_SESSION_MID` $7.01, `PD_HIGH+PD_IB_HIGH` $6.83, `PD_CLOSE+PD_POC` $4.31, `CAM_S4+FLOOR_S1` $4.06, all N≥998) and `confluence_score_at_detection`/`confluence_levels_at_detection` were already being persisted on every insert. Built the minimal version scoped in the `OPEN_DECISION`: added a `levelBase` field to each candidate (PD candidates map to `PD_VAH`/`PD_VAL`/`PD_POC`; wider-window candidates already carry `level_prices.level_name` via `WIDER_WINDOW_OVERNIGHT_LEVELS[].levelName`), built a fresh `globexPairBonus` lookup per poll from `CONFLUENCE_AUDIT_OVERNIGHT`'s `VALIDATED_PAIR` rows (mirrors RTH's `liveStats._pairBonus` exactly), and applied the identical single-check +0.15x bonus (capped 1.5, matching RTH) whenever another candidate in the same poll's within-TOUCH set is a validated partner. Verified the map-building + lookup logic directly against live `performance_audit` data (confirmed `PD_HIGH`+`PD_IB_HIGH` correctly yields 1.15x, an unrelated `PD_VAL` correctly yields 1.0x) since the actual Globex window (6PM–8:30AM ET) wasn't open at verification time to exercise the real poller end-to-end. `node --check`, eslint, and `test_invariants.mjs` all clean (one pre-existing unrelated failure, `PD_POC_FADE_LONG_TRAIL` missing a `BREAKEVEN_TRAIL_TEST` row — confirmed via `git stash` to predate this change, tracked separately as `pd_poc_fade_long_trail_lost_breakeven_trail_baseline`). Server restarted, `/api/acd/setup-detection` responds 200, no new entries in `scratch/server_errors.jsonl`/`gemini_alerts.txt`. Resolves `OPEN_DECISION` `globex_confluence_pair_bonus_needs_sizing_mechanism`.

- **WEEKLY_OPEN_FADE G-Line historical recalibration done (2026-07-27), plus a real sibling direction-formula bug found and fixed along the way.** Scoping this `OPEN_DECISION` first required resolving a pre-compaction-claim discrepancy: the decision text (flagged 2026-07-20) claimed `level_prices.WEEKLY_OPEN` history was "NOT backfilled" under the corrected G-Line (Sunday 6PM ET Globex open) formula, but that same day's commit message and a direct DB check both showed `scripts/backfill_weekly_open_gline_20260720.mjs` HAD already run and rewritten 414/423 historical rows (backup: `level_prices_weekly_open_backup_20260720`) — the decision's own claim was stale, caught by checking live data rather than trusting either source, per the standing post-compaction-verification rule. What was genuinely still stale: `active_setups.WEEKLY_OPEN_FADE_LONG/_SHORT` (100% `origin_status='BACKFILL'`, real_n=0 either direction — no real live touch has ever fired for this setup type) was generated by `scripts/backfill_unified_levels.mjs` against the OLD Monday-open `level_prices` values and never regenerated after the fix. Since the entire affected population was synthetic with zero real trades to lose, this made the backfill-vs-self-heal tradeoff the decision posed moot — re-backfilling was unambiguously correct (self-heal was never realistic anyway: a weekly-scale level rarely gets touched, so real N would take a very long time to dilute stale synthetic history that will sit there misinforming SETUP_STATUS/OPTIMAL_STOP in the meantime).
  - **Found while reading `backfill_unified_levels.mjs` to re-run it**: its touch-direction formula (`fromAbove = prev.close > lvl`, comparing the previous bar's close against the LEVEL price) is a different, independently-written implementation from the live RTH candidate path's actual convention (`approachDir = last5[0].close < currentPrice`, 5-bar momentum vs. the CURRENT price — `server/routes/acd.js` ~line 4865) — the exact same bug class just fixed the same session in `backtest_unified.js`'s `detectLevelFades()`. This script covers all 22 previously-uncovered level types (`PD_HIGH/LOW/CLOSE`, `DAILY_OPEN`, `WEEKLY_OPEN`, `MONTHLY_OPEN`, `FLOOR_R2/R3/S2/S3`, `ONH/ONL`, `PM_HIGH/LOW/VAH/VAL`, `PW_HIGH/LOW/VAH/VAL/POC`, `10D_IB_MID`), not just `WEEKLY_OPEN` — fixed for all of them in the same edit (loop start moved `i=1`→`i=5`, `fromAbove = !(bars[i-5].close < b.close)`), confirmed via `git log` this script has only ever had one commit (2026-07-18, a from-scratch write, not a deliberate design choice to diverge).
  - Full pipeline re-run: `backfill_unified_levels.mjs` (2661 rows, all 22×2 setup_types regenerated) → `backfill_mae_mfe.mjs` (2659 rows updated) → `backtest_setup_status.mjs` → `update_optimal_stops.mjs`. `WEEKLY_OPEN_FADE_LONG`: N 96→88, EV $14.60→$26.54. `WEEKLY_OPEN_FADE_SHORT`: N 80→55, EV $9.51→$31.81. Both remain `THIN_N` (still real_n=0 — the recalibration corrected the synthetic backtest, it didn't manufacture real trades). Every other one of the 22 level types' EV also shifted (some non-trivially, e.g. `PD_LOW_FADE_LONG` now EV=-$23.25 N=98) since the direction-formula fix applies system-wide, not just to `WEEKLY_OPEN` — these are real corrections, not noise, matching the exact pattern found in `backtest_unified.js`'s re-run earlier the same session.
  - `node --check`/eslint clean on `backfill_unified_levels.mjs`. `test_invariants.mjs`: same single pre-existing unrelated failure as before this work (`PD_POC_FADE_LONG_TRAIL` missing `BREAKEVEN_TRAIL_TEST`, confirmed via `git stash` to predate this session's changes). Server restarted, `/api/acd/setup-detection` responds 200.
  - **Process note, not re-litigated further**: `backfill_unified_levels.mjs`'s own backup mechanism (`DROP TABLE IF EXISTS active_setups_unified_levels_backup_20260718` + `CREATE TABLE AS`) is the same non-append-only anti-pattern this session already found and fixed in a script written fresh this session — today's re-run overwrote that backup table's contents (previously a snapshot of the pre-2026-07-18 population) with a snapshot of the now-known-buggy 2026-07-18-generated population. Not a real data loss (everything in it was itself synthetic BACKFILL data, deterministically reproducible from `price_bars_primary`/`level_prices`, both untouched) — noted here rather than fixed, since the script isn't expected to run again soon and chasing it further wasn't worth the scope creep.
  - Resolves `OPEN_DECISION` `weekly_open_gline_historical_recalibration_needed`.

- **Setup Log / sidebar recording-completeness audit (2026-07-27)**, prompted directly by the user asking whether IB_BULLISH/IB_BEARISH (which "always shown... seemed inaccurate") and the Setup Log generally are accurate to what's actually fired. Dispatched to Gemini first (`scratch/claude_request.md`/`scratch/gemini_setup_log_audit_20260727.md`), then independently re-verified every material claim directly (Gemini's row-count for the timeline gap was off — 64 vs my own 75 — close enough in shape to trust the finding but not the exact number).
  - **Confirmed real gap, now fixed**: 2 of the 3 `INSERT`/resolution paths into `active_setups` never called `dropToTimeline()` (the helper that populates `trade_timeline_events`, which the sidebar Session Timeline reads via `/api/timeline/today`):
    1. **The main RTH candidate insertion path** (`acd.js` ~line 6656) — the single most important "a setup just fired ACTIVE" moment never dropped a timeline event at fire time; it only appeared once the setup later resolved via a separate path that DOES call `dropToTimeline()`. A freshly-fired live setup was invisible in the sidebar until close, sometimes minutes to hours later.
    2. **The 5–6PM ET session-close sweep** (~line 3119) — force-closes any still-open `ACTIVE` setup to `resolution='SESSION_CLOSED'` but never dropped that resolution to the timeline. Directly explains the user's specific IB_BULLISH/IB_BEARISH observation: all 6 real (`origin_status='ACTIVE'`) `SESSION_CLOSED` rows in the last 3 months were exactly `IB_BULLISH`/`IB_BEARISH` (the longest-lived, day-type-managed setups most likely to still be open at 5PM) — when one of these gets force-closed rather than hitting a real stop/target, the sidebar never showed how it actually ended.
    3. **The SHADOW-candidate persistence path** (~line 6730) also never calls it — left alone deliberately, since SHADOW fires aren't meant to alert the user live; 69 of the 75 total gap rows are this category, not a bug.
  - Both real gaps fixed additively (call `dropToTimeline()` right after the insert/update, matching the exact pattern already used by every other resolution path in the file — `ON CONFLICT (setup_id) DO NOTHING` makes double-calling safe). `node --check`/eslint clean, `test_invariants.mjs` shows 2 pre-existing unrelated failures (`IB_BEARISH`/`PD_VAL_FADE_LONG` `OPTIMAL_STOP` drift, confirmed via `git stash` to predate this change — small, noise-level, likely from the WEEKLY_OPEN_FADE recalibration re-run earlier this session touching the shared sweep). Server restarted, endpoint verified 200, no new errors.
  - **Separately confirmed** (not part of this fix, a distinct Setup Log *display* accuracy gap): `IB_BEARISH` (`DAY_TYPE_MANAGED`) and `PD_VAL_FADE_LONG` (`PROMOTE` on only 7 real trades out of 129 logged, rest synthetic `BACKFILL`) both show in the Setup Log's default non-shadow view with no visual distinction from a confirmed `ACTIVE` setup — `getShadowSetupTypes()` only recognizes `SUPPRESS`/`THIN_N`. User has not yet decided how they want this displayed (badge? hide? show real_n?) — revisit once the broader MAE/MFE execution-analysis work below settles, since that work will likely touch the same display surfaces.

- **Execution-efficiency analysis capability built (2026-07-27)**, per direct user request: "analyze the performance of the trades that fired and how they did vs MAE and MFE... vs the larger picture... anything you could learn to improve the setup or execution." Built as a durable, re-runnable script (`scripts/analyze_execution_efficiency.mjs`, now in `run_weekly_backtests.sh`), not a one-off report — persists to `performance_audit` (`signal_type='EXECUTION_EFFICIENCY_AUDIT'`) so it accumulates and can be trended as real N grows, per the standing no-dead-ends rule. Methodology dispatched to Gemini first (`scratch/claude_request.md`/`scratch/gemini_execution_efficiency_audit_20260727.md`), independently re-verified before building anything on it (Task 1/2 numbers matched almost exactly; Task 3's empty table was confirmed correct, not a miss).
  - **Honest headline finding**: across the ENTIRE system, only ONE setup_type (`IB_BEARISH`) currently has enough real (`origin_status IN ('ACTIVE','SHADOW')`) resolved trades to clear the N>=20 floor at all — everything else is still too thin. This in itself is a useful, if deflating, finding: the capability is real and working, but the underlying real (non-backfill) trade volume across this whole system is still very early-stage.
  - **The one real lead**: `IB_BEARISH` winners (N=25) leave a median 6pt/mean 7.54pt (~$15/trade) of MFE beyond the target before the tracking window ends, consistent in sign across all 3 chronological thirds — but `computeRigor()` correctly flags this as NOT clean, since the sample is heavily day-clustered (only 4 distinct trading days among the 25 winners, 12 from a single 2026-07-20 session). Recorded as `RESEARCH_CLAIM` `ib_bearish_mfe_left_on_table_20260727` (status `PROVISIONAL`, honest about the clustering) rather than acted on directly — the right next step is testing it through the existing `backtest_breakeven_trail.mjs` pipeline (same mechanism already live for 6 other setup_types), not wiring a new one-off fix.
  - **A second, more interesting finding surfaced along the way**: `IB_BEARISH`'s real realized EV ($7.77-$8.37) sits ~$24/trade ABOVE its stored `OPTIMAL_STOP` calibrated EV (-$15.98) — the opposite direction from what you'd expect (realized usually tracks or trails calibration). Working theory: `OPTIMAL_STOP`'s sweep fits one flat, day-type-blind stop/target, but `IB_BEARISH` is `DAY_TYPE_MANAGED` with an already-documented real day-type split (BALANCE -$24.68, TURBULENT +$63.07, TREND +$4.33) — if the recent live period happened to have more TURBULENT/TREND days, realized EV would look much better than a blended calibration. Not yet confirmed (would need the sweep re-run per day-type bucket) — flagged as `OPEN_DECISION` `ib_bearish_optimal_stop_not_day_type_conditioned` rather than assumed.
  - Task 3 (losers-that-almost-made-it) came back genuinely empty — verified directly, zero setup_types have N>=20 real `STOP_HIT` losers yet. Task 4 (bar6 checkpoint sanity check) re-confirmed the existing `RESEARCH_CLAIM engagement_bar6_worst_point_passed` finding still holds (RECOVERING N=11 EV=$13.33/WR=63.6% vs DETERIORATING N=8 EV=-$39.59/WR=50%).
  - Not yet done: wiring this into any UI panel (`AlphaEngineOverview.jsx` or similar) — deliberately deferred given only one setup_type currently has anything to show; revisit once real N grows across more setup_types. `test_invariants.mjs`/lint clean (2 pre-existing unrelated `OPTIMAL_STOP` drift failures, confirmed via `git stash`).

- **Corrected-resim target-widening: confirmed universal + investigated 2 rejections properly (2026-07-27)**. User asked to confirm this treatment (attempt widened target, apply guardrails, fall back honestly on failure) automatically applies to every setup_type, new and old, going forward — verified directly: `update_optimal_stops.mjs`'s main query is fully generic (`GROUP BY setup_type HAVING COUNT(*) >= 20`, no hardcoded list), the `computeCorrectedTarget()` attempt at line 337 runs unconditionally for every setup_type clearing that floor, and the script is scheduled from 3 places (`server/index.js`'s cron, `run_weekly_backtests.sh`, `run_daily_calibration.sh`) — any new setup_type automatically gets this exact treatment the moment it has enough data, no manual wiring needed.
  - Then dug into the 2 rejections (IB_BULLISH, PD_POC_FADE_SHORT/LONG) flagged in the payoff-asymmetry thread rather than accepting "guardrail failed" at face value — per the standing rule that a "looks debunked" result deserves the same scrutiny as a "looks too good" one. Wrote a diagnostic that dumps the FULL candidate grid (not just the terminal exclusion reason) for `PD_POC_FADE_SHORT`/`PD_POC_FADE_LONG`.
  - **`PD_POC_FADE_SHORT`**: legitimate rejection, confirmed independently of the specific guardrail that caught it — every candidate in the grid has negative out-of-sample EV, including the current live 50pt target itself (oosEv=-$13.50). The in-sample climb to $20.75 at 129.8pt is pure overfitting; even a relaxed plateau check would fail the OOS gate right after. No wider target exists for this setup — current calibration is already correct.
  - **`PD_POC_FADE_LONG`**: a genuine borderline case, not a clean rejection. Best candidate (110.8pt vs current 50pt) independently clears both the OOS test (oosEv=+$5.08) and beats-baseline test (fullEv=$7.90 vs $1.92 baseline) — but got blocked by its neighbor (139.8pt) having negative in-sample EV, and that neighbor's sample thins from 32 to 22 touches, so the negative reading may be a sample-size artifact rather than a real reversal. Flagged as `OPEN_DECISION` `plateau_check_may_be_too_strict_on_thin_neighbors` rather than special-cased directly — the plateau check is a shared guardrail across all 110+ setup_types, and a change to its neighbor-tolerance logic needs proper held-out validation across the full roster (matching this codebase's own repeated lesson about guardrail changes needing re-audits), not a one-off exception for this single setup_type.
  - `IB_BULLISH`'s rejection (from the earlier payoff-asymmetry thread) was not re-dug into as deeply since it's already `SUPPRESS`ed live (doesn't fire as ACTIVE regardless of its target calibration) — its OOS failure (-$25.42 vs training $9.74) is a clean, unambiguous overfitting signature on its face, lower priority to re-verify further.

- **Suppressed-fade SHADOW audit rows fixed to actually resolve (2026-07-27) — a real dead end, caught by a direct user question about weekly shadow P&L.** The "suppressed near-level audit" insert (`acd.js`, the `else` branch alongside the RTH candidate suppression check) has existed since early in this codebase's life logging every suppressed level-fade touch as a `SHADOW` row — but it only ever wrote `setup_type`/`fired_at`/`price_at_detection`. No `entry_zone_low`/`stop_level`/`t1_level`/`expires_at` at all. Consequence, confirmed live: these rows could never resolve via `resolveSetupsByPrice()` (which requires all three price fields to even attempt a bar-walk) — they just sat as `status='SHADOW'` until `expireStaleSetups()`'s `NO_EXPIRY_SET` backstop force-closed them with **no `actual_pnl` ever computed**. Checked one real week (2026-07-20 to 07-24): 64 of these fired across 34 setup_types, 100% dead-ended — zero ever produced a dollar outcome. Worse: `backtest_setup_status.mjs`'s gating population query (`WHERE resolution IN ('TARGET_HIT','STOP_HIT')`) can never count these rows either way, meaning firing repeatedly never grows N for the very suppression decision this mechanism exists to validate — a complete dead end by CLAUDE.md's own definition, not a display gap.
  - **Fixed**: the suppressed-audit insert now computes the exact same entry/stop/target a live (non-suppressed) candidate at that instant would have gotten — same `liveStats._opt[type]` lookup, same `STOP`/`TARGET` fallback constants, same `isLong ? currentPrice ± pts` formula — plus a self-contained expiry calc (4PM ET RTH close, rolled to next day if already past; couldn't reuse the shared `computeExpiry()`/`fmtETStr()` helpers since those are `const` closures defined later in the same function's execution order — referencing them earlier would hit the temporal dead zone). No changes needed to `resolveSetupsByPrice()` itself — it already generically walks any `status IN ('ACTIVE','SHADOW')` row with non-null entry/stop/target, so these rows now flow through the exact same resolution path everything else uses, and their outcome will actually count toward N going forward.
  - `node --check`/eslint clean, `test_invariants.mjs` shows the same 2 pre-existing unrelated `OPTIMAL_STOP` drift failures (confirmed via earlier `git stash` checks this session). Server restarted, endpoint verified 200.
  - **Not yet done, deliberately flagged rather than silently skipped**: the ~64 already-dead rows from last week (and however many older ones exist historically) are NOT backfilled by this fix — it only prevents the gap going forward. A repair pass (re-simulate entry/stop/target for existing null-priced SHADOW/SUPPRESSED-reason rows using the same live-candidate-equivalent formula, matching this codebase's established backfill-then-fix convention) is a reasonable, bounded follow-up — not done in this same session given the user also asked for a broader audit of whether other setup types have similar silent gaps, which took priority.

- **Comprehensive dead-end audit (2026-07-27), dispatched per direct user request after the SUPPRESSED_FADE fix.** Found 2 more insert paths with the same class of bug — both real, both independently verified against direct SQL/code reads, both fixed same session:
  1. **`CASCADE_BREAKER` suppression logging** (`acd.js`, the block right before the suppressed-near-level-audit fixed earlier — `if (cascadeBreaker.active...)`) — same missing entry/stop/target/expires_at, PLUS a separate naming bug (inserted `setup_type=lv.name` directly, a bare level name with no direction suffix, inconsistent with every other insert path's convention). 0 rows ever recorded (confirmed: `SELECT COUNT(*) WHERE suppression_reason='CASCADE_BREAKER'` = 0), so no historical damage, but structurally guaranteed to hit the identical dead end the next time the cascade breaker fires. Fixed to mirror the `SUPPRESSED_FADE` fix exactly: resolves a real direction+type per level, computes the same entry/stop/target a live candidate at that level would have gotten.
  2. **`minuteBarSignalDetector.js`'s `MOMENTUM_60m_60m_TREND` poller** — correctly populates entry/stop/target but omitted `expires_at` entirely. Worse consequence than the other two: since this poller's rows CAN reach `TARGET_HIT`/`STOP_HIT` normally (entry/stop/target present), the bug only bites when a trade runs to end-of-day without resolving — a `SHADOW` row falls to the `NO_EXPIRY_SET` backstop (no PnL, same dead end), but an `ACTIVE` row (once this setup_type graduates via its own `getLiveStatus()` promotion) would become a **permanent orphan** — `NO_EXPIRY_SET`'s backstop query is scoped to `status='SHADOW'` only, so nothing would ever force-close it. 0 rows exist yet (this poller has never actually fired live, matching the earlier finding this session that `MOMENTUM_60m_60m_TREND`/`_BALANCE_FADE` are orphaned/dead calibration rows with zero real history) — fixed before it could ever produce one. Expiry = fired-time + `HORIZON_MIN` (60min, this signal's own designed holding window per its file header), capped at RTH close, matching every other expiry convention in this codebase.
  - **Confirmed clean** (Gemini's claim independently spot-checked, not just trusted): `detectGlobexSetup()`, the early-touch-backfill path (~line 6563, verified directly — correctly includes `expires_at`/entry/stop/target), the main RTH candidate insertion, and the shadow-candidates fire-and-forget path all already populate everything needed. `origin_status` is non-null everywhere, no exceptions found.
  - `node --check`/eslint clean on both files, `test_invariants.mjs` shows the same 2 pre-existing unrelated failures (confirmed via `git stash` earlier this session). Server restarted, verified 200, no new errors.
  - Same follow-up as the `SUPPRESSED_FADE` fix applies here: 0 historical rows affected for either of these two (unlike `SUPPRESSED_FADE`'s real 64-row/week blast radius), so no backfill/repair pass is needed — these were caught before they ever produced bad data.

- **Standing invariant check added for the whole dead-end bug class (2026-07-27), plus full historical repair.** After fixing 3 separate silent dead-end insert paths this session (`SUPPRESSED_FADE`/`DOW_SUPPRESSED` audit rows, `CASCADE_BREAKER` logging, `minuteBarSignalDetector.js`'s momentum poller), added `test_invariants.mjs` check `[7]` — a generic, standing tripwire that doesn't depend on knowing which specific code path is at fault: (a) FAILs if any real (`ACTIVE`/`SHADOW`-origin) row from the last 30 days has no entry/stop/target at all, (b) WARNs on any resolved-but-`actual_pnl`-null row not already explained by a known, deliberately-deferred gap (`SESSION_CLOSED`, `PRE_ENTRY` invalidation). This is the actual fix for "how do we know this doesn't happen again silently" — a future insert path with the same bug trips this automatically on the next self-check, rather than requiring another user to notice by asking a pointed question about a specific week's numbers.
  - **Full historical repair completed**: `scripts/repair_dead_end_shadow_rows_20260727.mjs` recomputed entry/stop/target (using current `OPTIMAL_STOP` calibration) and walked real `price_bars_primary` bars for all 69 historical `NO_EXPIRY_SET`/null-`actual_pnl` rows from the `SUPPRESSED_FADE`-class bug — all 69 recovered (28 `TARGET_HIT`, 41 `STOP_HIT`/other after a second pass fixed a bar-window edge case for setups that fired right at the 4PM RTH/Globex boundary). Backup: `active_setups_dead_end_repair_backup_20260727`. Re-ran `update_optimal_stops.mjs`/`backtest_setup_status.mjs` afterward so calibration reflects the ~69 newly-real trades — `test_invariants.mjs` check `[5]`'s stale-drift failures (which had been sitting as 2 pre-existing FAILs all session) resolved as a direct side effect.
  - **Also fixed 2 still-open (not-yet-expired) rows directly** in place before they could dead-end, same fix applied live.
  - **One new, small, genuinely separate gap surfaced and flagged, not silently dropped**: 11 real rows dated 2026-07-11 through 07-17, `resolution='TIME_EXPIRED'`, `actual_pnl=NULL`, `resolution_method=null` — predate the 2026-07-20 `TIME_EXPIRED` mark-to-market fix and apparently weren't caught by that fix's own backfill pass. Different root cause/era than today's 3 bugs. Flagged as `OPEN_DECISION` `eleven_pre_20260720_time_expired_null_pnl_rows` rather than assumed-fixable by the same repair script without checking first.
  - Net result: `test_invariants.mjs` now shows only 1 pre-existing, already-tracked failure (`PD_POC_FADE_LONG_TRAIL` missing `BREAKEVEN_TRAIL_TEST`, unrelated, flagged earlier this session) and the 1 new small `OPEN_DECISION` above — down from 39 structural failures before the repair pass.

- **User-flagged: system missed a real, large intraday down-move on 2026-07-27 morning — conceptual gap identified, not a bug.** User annotated a live Sierra Chart screenshot (3 charts, multiple timeframes) showing:
  1. A short off the 5-min opening-range low that ALSO coincided with the Weekly Open (G-Line) and PW_VAH (prior week's VAH) — a 3-level confluence stack right before a large sustained down move.
  2. A second short later that same morning off RTH VWAP + PW_LOW confluence.
  3. General complaint: "generally huge downmove this morning. We caught none of it... these moves pay bills and need to figure out how to get you to see them and stay in it."
  - **Checked live `active_setups` for 2026-07-27 directly**: neither trade fired in any form (`ACTIVE` or `SHADOW`). 13 total rows fired all day; the only ones aligned with the down-move direction were 2x `IB_BEARISH` (+$69 each, tiny relative to the move); several others were `LONG` fades that lost fighting the trend (`PD_POC_FADE_LONG_TRAIL` +$81 was the exception, an early-morning long before the move).
  - **Root cause, confirmed structural**: every level-fade `setup_type` in this codebase (`OR_LOW_FADE_SHORT`, `WEEKLY_OPEN_FADE_SHORT`, `PW_VAH_FADE_SHORT`, etc.) is a mean-reversion bet — a "SHORT" fires expecting price to reverse back down AFTER rallying into the level, the opposite of what happened (price broke DOWN through the level and continued). The only breakdown/continuation-style setup anywhere in this system is `BRACKET_BREAKOUT_SHORT` — `THIN_N` (too little real data), and it tracks a 5-session rolling bracket range, not this OR/Weekly-Open/PW-VAH combination — structurally could never have caught this regardless of calibration state.
  - User did get the `SIGMA_CONTINUATION_LIVE` alert (confirmed: "you even caught the huge sigma down move. i got the alert") — but that signal (and `BIGMOVE_LIVE_SIGNAL`) are deliberately informational-only, never wired to a sized/tradeable setup (established earlier this same session) — so "got the alert, no position to act on" is current expected behavior, not a bug.
  - **Flagged as `OPEN_DECISION`** `build_multilevel_confluence_breakdown_continuation_detector` (HIGH priority, user's own "pays bills" framing) — a genuine new build: does price breaking through N stacked levels together (not just touching one) predict continuation, mirroring the confluence-FADE-bonus work already done this session (`backtest_confluence.js`/`backtest_confluence_globex.js`) but for the opposite direction. Needs its own dedicated backtest with the full confound checklist before any live wiring — a continuation entry is a momentum-chase entry with a different risk shape than a fade, and this session already caught one "later entry against fixed exit is structurally favorable" confound in an unrelated context, so that guardrail applies here too. Scoped for a fresh session, likely with Gemini doing the initial mining per this codebase's standing convention — not built same-session given size and an impending context clear.








- **"Air pocket" signal spec scoped and closed same-session without mining (2026-08-12)** — the natural mirror of the already-live `hivolLopace` signal (heavy volume + low price movement before a level touch, `CONFIRMED` negative 2026-07-29): low volume + LARGE price movement, on the theory it might indicate a thin/withdrawn order book. Written up as `docs/AIR_POCKET_SIGNAL_SPEC.md`, following the "reuse already-live `getTouchQualityBaseline()`/`getPaceBaseline()` infrastructure" pattern.
  - Sent to DeepSeek for a design critique before any Gemini mining, per this session's now-standard workflow. **The critique caught a factual error in the spec's own premise**: the "untested mirror" claim was false. The exact quadrant (`LO-VOL + HI-PACE`, labeled "Vacuum") was already computed in the same 2026-07-29 run that produced `hivolLopace` (`scratch/gemini_velocity_round3_results.md`'s 2D cross-tab) — N=519, WR=64.2%, EV=+5.36, but `clean=false, stable=false`, correctly excluded from that run's train/test replication. Verified directly against the actual file (not just trusted) — matched DeepSeek's transcription exactly.
  - DeepSeek also caught, independently verified: (a) the live `hivolLopace` window is NOT strictly pre-touch as the spec assumed — it includes the entry/touch bar itself (`acd.js` ~6858-6872), and `detectLevelFades()` sets fade direction from the same 5-bar move `paceZ` measures, so "high paceZ" is partly definitionally close to "the level was approached fast," not a clean pre-touch-only signal; (b) `volZ`/`paceZ` are positively correlated (r=+0.341, N=5240) so the Vacuum cell is a genuinely distinct, rarer-than-independence quadrant, not just `hivolLopace`'s logical negation — but both marginals are smooth/monotonic in the favorable direction with no sign of a real interaction, so the +5.36 reads as two favorable marginals coinciding rather than a distinct liquidity-thinness effect; (c) both framings the spec proposed (fade-suppression, then deferred continuation) are wrong-signed against the observed data — the only framing the data supports is reversion/exhaustion (fast approach → *better* fade, not worse).
  - **Closed without a Gemini dispatch** — re-deriving fresh percentile cutoffs for this quadrant would just be another resweep of a cell that already failed `computeRigor()` once, the exact largest-of-K trap this session's own confound checklist exists to catch. Folded into the existing `hivol_lopace_precursor_confirmed_negative` `RESEARCH_CLAIM` (updated with a "MIRROR-CELL CHECK" section) rather than filed as a new claim, since no new data was generated — this was a closer reading of data that already existed. If revisited, the real next step is the two marginals directly, or a pre-registered tercile design with `HI-PACE+HI-VOL` as a pace-matched thinness control — not another cut of this one cell.


- **Live-firing audit (2026-08-14/16): why trades fire on "overall" but not "live" — 2 CRITICAL bugs fixed, 2 more flagged.** User had DeepSeek independently audit this directly (not dispatched by Claude); full report recovered from `~/.cline` session logs after an accidental overwrite (see process note below) and independently verified by Claude against the live code/DB before anything was applied.
  - **F1 (FIXED, commit `303b181`)**: the cascade-breaker "audit" insert (`acd.js`, disabled as an acting gate 2026-08-05 but kept logging) computed a full, resolvable row (entry/stop/target/expiry) per near level whenever `cascadeBreaker.active`. Confirmed live: 1,072 such rows, 1,012 resolved via real price-walk with genuine P&L (avg +$81.54 wins / -$95.88 losses) — these counted toward `SETUP_STATUS`'s `real_n`/`real_ev`, contaminating the SUPPRESS/THIN_N/ACTIVE decision for every affected setup_type with phantom trades. Fixed: now a terminal, level-less marker (`status='EXPIRED'`, `resolution='NO_EXPIRY_SET'` set at insert time, no entry/stop/target) that can never be resolved or counted, deduped once per (trade_date, setup_type) per cascade window.
  - **F2 (FIXED, same commit)**: the `existingSetup` reuse query (decides whether to reuse a row instead of firing a fresh one) had zero `suppression_reason` exclusion — during a cascade window, a genuinely new live-quality touch could match and silently reuse a `CASCADE_BREAKER` audit row instead of getting its own `ACTIVE` fire, hijacking real live fires into invisible SHADOW rows. Fixed: only matches a real fire (`suppression_reason` NULL or one of the three legitimate `forceShadow` reasons — `POST_RTH_DEAD_ZONE`/`REFIRE_COOLDOWN`/`PERFORMANCE_BELOW_THRESHOLD`).
  - **F3 (FLAGGED, `OPEN_DECISION shadowcandidates_hardcoded_no_promotion_path`, HIGH, NOT applied — user explicitly held this)**: `shadowCandidates`' INSERT hardcodes literal `'SHADOW','SHADOW'` for ~20 event setup types (stop-sweep, absorption, coil-surge, VWAP magnet/reclaim, C-signal, bracket-breakout, TRT, etc.) — the array's own comment claims a promotion path exists ("promoted to ACTIVE when positive EV over 30+ forward trades") but none does. Confirmed: `STOP_SWEEP_LONG`/`SHORT` have **zero** `origin_status='ACTIVE'` rows ever despite real N well past 20. Same anti-pattern already fixed once for the *display* layer (`getShadowSetupTypes`) but never migrated to the *firing* layer. **This directly answers the "why are these shadowed when N>20" Setup Log question from 2026-08-16** — it's not a threshold check failing, these setup types are structurally incapable of ever leaving SHADOW. Real diff to apply is permanently archived in `docs/LIVE_FIRING_AUDIT_20260814.md` (section F3) and referenced in the `flagDecision` text itself — the original `scratch/deepseek_response.md` copy is no longer the source of truth for this. Two things must resolve before shipping: (1) review the per-type list (some of the 20 may not be desirable to fire live even at ACTIVE), (2) `STOP_SWEEP_LONG/SHORT` are separately paused (`OPEN_DECISION stop_sweep_long_calibrated_target_pause_or_keep`) — resolve or explicitly exclude before flipping.
  - **Also flagged, `OPEN_DECISION cascade_breaker_historical_rows_need_repair` (HIGH)**: F1's code fix stops NEW contamination but does NOT retroactively fix the 1,072 already-inserted `CASCADE_BREAKER` rows still sitting in their old resolvable shape — `SETUP_STATUS`'s live real_n/real_ev is STILL computed from contaminated data right now, until a dedicated repair script (delete or migrate-in-place, back up first per `docs/DB_MIGRATION_PROTOCOL.md`) runs and `backtest_setup_status.mjs` re-baselines. **This is the single highest-priority next step** — do it before trusting any current SUPPRESS/ACTIVE/THIN_N figure, and before F4 below.
  - **Also flagged, `OPEN_DECISION value_fade_override_failed_auction_long_review` (LOW)**: `FAILED_AUCTION_LONG` (blended EV=+$7.50, N=47) sits close to the `VALUE_FADE` bet-class override's own "own EV≥0" escape hatch — worth a specific look, but only after the historical repair above (real EV numbers will shift).
  - **Process note — scratch files are fragile, this bit us twice in one session**: `scratch/deepseek_response.md` and `scratch/antigravity_response.md` both got silently overwritten mid-session (once by the user's own parallel DeepSeek/Gemini work, once by Claude's own re-dispatch racing a read of the file before it could finish). The live-firing audit content was recoverable via `cline`'s own session logs (`~/.cline/data/sessions/*/​*.messages.json` — search for a unique string from the lost content, find the session by matching timestamp, extract the `run_commands`/`cat > ... <<EOF` tool-call input). **Anything worth keeping from a Gemini/DeepSeek dispatch needs to land in `docs/`/`performance_audit` before the next unrelated dispatch runs — never treat `scratch/*_response.md` as durable storage.**

- **8/13 missed long trade — investigated directly, 2026-08-16: the system DID catch it, informationally, but it never became a live alert, and the fixed-target exit left most of the real move on the table.** User annotated a Sierra Chart screenshot showing a long launching immediately off the Weekly Open/Daily VWAP/OR5 Low confluence around 9:31 AM, faltering briefly 9:35-37 (marked in red), then resuming on what the user read as absorption, continuing to ~30,230 (IB High) — a 300+ point move.
  - **Confirmed in `active_setups`**: `OR5_LOW_FADE_LONG` and `IB_LOW_FADE_LONG` both fired at exactly 09:31:00 (entry ~29,872, stop ~29,823-29,832, T1 ~29,914-29,916 — a ~43pt target) and both hit target (+$82, +$86). **Both `origin_status='SHADOW'`** — genuinely detected and correctly directional, but never shown to the user as a live alert (below the `SETUP_STATUS` N≥20 promotion floor as of that date).
  - **MFE on both was 75.25pt — ~1.75× the fixed target distance**, and that's only within the system's own tracked resolution window; the chart shows the real continuation went much further (300+pt to IB High). This is a concrete, real, dated example of exactly the "fixed target exits too early on a real trending move" problem — **directly relevant to the runner/trailing-stop optimization thread already in progress** (`docs/RUNNER_OPTIMIZATION_NOTES_20260814.md`) and to the standing `OPEN_DECISION build_multilevel_confluence_breakdown_continuation_detector` (flagged 2026-07-27 after a near-identical "we caught none of it" complaint about a different big move) — **these are the same underlying gap, not two separate asks.** Worth using this exact 8/13 case as a labeled example when either thread resumes.
  - **Not yet done**: independently checking volume/delta/order-flow at the 9:35-37 falter-and-resume moment the user pointed at on the chart (the "absorption" read) — the user asked specifically whether the data corroborates this. Next session: pull `price_bars_primary`/bid-ask volume for `2026-08-13` `09:34`-`09:40` ET and check `oneSidedRatio`/`volZ`/delta at that exact window against the touch-quality baseline machinery already built (`touchQuality.js`), the same infrastructure the `air_pocket`/`hivolLopace` threads already use — don't reimplement.

- **Friday 8/14 quick-check.html concerns — investigated directly, 2026-08-16: not a system-health bug, but one real unrelated finding surfaced.** User worried: (a) a trade that fired 12:56 PM didn't show an update until ~3pm, (b) `IB_BEARISH` banner sat active for hours, (c) general worry trades stopped firing at 1PM.
  - **(a) Not a bug** — the 12:56:41 PM `PD_IB_MID_FADE_SHORT` genuinely didn't resolve (`STOP_HIT`) until `resolved_at`=14:50:00 (2:50 PM). Session Timeline only updates its badge once resolution actually happens; ~10 minutes between real resolution and the user noticing at "around 3pm" is normal, not a lag bug.
  - **(c) Not a system outage** — confirmed no `SERVER_DOWN` alert in `scratch/gemini_alerts.txt` for that date, and the 1:00-2:05 PM window shows genuinely **zero** rows of any kind (not even suppressed/cascade audit rows) — consistent with a real quiet/rangebound period (RVOL 0.4× per the user's own screenshot), not a detection or server failure. Hourly fire counts that day: 44 (9am), 45 (10am), 26 (11am), 11 (12pm), **0 (1pm)**, 2 (2pm), 7 (4pm).
  - **(b) Not independently checked** — `IB_BULLISH`/`IB_BEARISH` are documented elsewhere in this codebase as the longest-lived, day-type-managed setups, "most likely to still be open at 5PM" — a multi-hour hold may be expected behavior for this specific setup type rather than a bug. Not confirmed either way this session.
  - **One real, separate finding surfaced while checking**: a `LATENCY_CRITICAL` alert logged at 5:15pm ET that same day shows a very large number of setup_types with severe latency (hundreds to 2,600+ seconds of lag) — unrelated to the 1-2PM gap specifically, but a genuine, currently-unexplained system finding worth a dedicated look next session (`scratch/gemini_alerts.txt`, search `2026-08-14.*LATENCY_CRITICAL`).

- **Dashboard audit (started 2026-08-13, still in progress) — see `docs/DASHBOARD_AUDIT_20260813.md`** for the full running tally. Status as of 2026-08-16:
  - Section 0 (quick-check.html): **fully fixed and shipped**, 5 commits.
  - Section 1 (`DashboardView.jsx`, audited by mistake before the scope correction): **audited, findings verified, nothing fixed yet** — real bugs found (Kelly% rendered 100× too small, UTC-vs-ET "Today" filter bug, a fully dead `/stats/key-levels` fetch, an account-filter bypass that can silently blend 30k+ TEST trades into PRO-only figures, directional stats always rendering zero from a case-mismatch). Lower priority than Morning Prep since this is a historical-review page, not a live-decision one.
  - Section 2 (`ACDView.jsx` "Morning Prep", the actual intended target): **Gemini's DB-grounded pass done and independently verified** (the single worst finding of the whole audit: `ACDView.jsx`'s `edgeCtx` object hardcodes frozen WR%/N description strings for 13 setup types, cross-checked stale against this session's own live `DAY_TYPE_ALPHA` data — e.g. hardcoded "N=31" vs real N=79 for `IB_BEARISH` TURBULENT). **DeepSeek's code-level pass was never completed** — dispatched twice, the second dispatch's output was sacrificed to recover the live-firing audit (see process note above) rather than let both be lost. Next session: re-run `./scripts/invoke_deepseek.sh 20m` (the request file `scratch/claude_request_deepseek.md` still has the correct Morning Prep scope, confirmed 2026-08-16) — but **read and archive the response into `docs/` immediately after, before dispatching anything else to either model**, given how many times this exact file got clobbered this session.
  - **Opus summary**: requested twice by the user (once generically for the dashboard audit, once specifically "based on what the system already has, what can we do to catch a large move like 8/13") — not yet written. Should combine: `docs/DASHBOARD_AUDIT_20260813.md`'s findings, this session's live-firing audit (F1-F4 above), the 8/13 missed-long case study above, and the user's own bar-size-momentum idea (a large bar followed by a second bar that continues without looking back/pulling back is itself a signal worth an override/immediate-reentry mechanic — tie this to the existing `OPEN_DECISION build_multilevel_confluence_breakdown_continuation_detector`, don't treat it as a new, unrelated ask).

- **Cascade-breaker historical contamination repaired (2026-08-16) — real live-firing behavior changed for 20 setup_types.** Resolves `OPEN_DECISION cascade_breaker_historical_rows_need_repair`, the highest-priority follow-up flagged from the same-day F1/F2 live-firing audit fix (commit `303b181`). `scripts/repair_cascade_breaker_contamination_20260816.mjs`: backed up (`active_setups_cascade_breaker_repair_backup_20260816`, `trade_timeline_events_cascade_breaker_repair_backup_20260816`), verified counts, then deleted all 1,072 pre-fix `CASCADE_BREAKER` "audit" rows from both `active_setups` and `trade_timeline_events`.
  - **Real, unanticipated finding surfaced while building the repair**: every one of the 1,072 phantom rows also had a matching `trade_timeline_events` row (FK `setup_id`), meaning these logging-only cascade-breaker rows had been leaking into the Session Timeline sidebar too, not just contaminating `real_n`/`real_ev` — each carried the literal `"(cascade breaker audit)"` label. Had to delete these first to satisfy the FK before the `active_setups` delete could run.
  - **Re-ran `backtest_setup_status.mjs` to re-baseline, then restarted the server** (12hr `DAY_CACHE_TTL` on `liveStats._suppressedSetups` meant a restart was needed for the correction to take effect live rather than silently waiting out the stale cache) — verified 200 post-restart, no new `scratch/server_errors.jsonl` entries.
  - **20 of 181 setup_types changed `recommendation`** comparing the 2026-08-14 (contaminated) row to the fresh 2026-08-16 one:
    - **11 flipped `ACTIVE` → `THIN_N`** (previously firing live on inflated real_n; now correctly SHADOW-only pending real N≥20): `CAM_S1_FADE_SHORT`, `CAM_S2_FADE_SHORT`, `FLOOR_R1_FADE_LONG`, `IB_LOW_FADE_LONG`, `ONL_FADE_SHORT`, `OR5_HIGH_FADE_SHORT`, `OR5_LOW_FADE_SHORT`, `OR5_MID_FADE_SHORT`, `PD_IB_HIGH_FADE_LONG`, `PD_VAH_FADE_SHORT`, `RTH_VWAP_FADE_LONG`.
    - **1 flipped `ACTIVE` → `SUPPRESS`**: `OR5_LOW_FADE_LONG` (real_n=22, real_ev=-$8.55 — confidently negative once the phantom wins are removed).
    - **7 flipped `SUPPRESS` → `THIN_N`** (previously falsely suppressed by phantom losses, now correctly "not enough real data yet"): `CAM_S1_FADE_LONG`, `CAM_S2_FADE_LONG_TRAIL`, `IB_HIGH_FADE_LONG`, `IB_MID_SCALP_FADE_LONG`, `PD_CLOSE_FADE_LONG`, `PD_VAL_FADE_LONG`, `RTH_VWAP_FADE_SHORT`.
    - **1 flipped `SUPPRESS` → `PROMOTE`**: `PD_POC_FADE_SHORT` — real_n=19, real_wr=68.4%, real_ev=+$9.85 (recent 90d), trend `IMPROVING` but `three_way_stable=false`. A real, promising signal, not yet a proven one — worth a specific look before leaning on it, same caution as any other `PROMOTE` this codebase already treats as "razor-thin, not auto-trust" (see the 2026-07-13 `OPEN_DRIVE_LONG` precedent above).
  - `test_invariants.mjs` shows 18 pre-existing FAILUREs, all confirmed unrelated (dated 2026-08-14, before this session's changes): `OPTIMAL_STOP` circuit-breaker trips (a different script, `update_optimal_stops.mjs`, not touched this session) and the already-tracked `BREAKEVEN_TRAIL_TEST` gaps for 5 `_TRAIL` variants. None new from this repair.
  - **Not yet done**: F4 (`FAILED_AUCTION_LONG` review, `OPEN_DECISION value_fade_override_failed_auction_long_review`) was explicitly gated on this repair completing first — real EV numbers have now shifted, worth revisiting. `PD_POC_FADE_SHORT`'s new `PROMOTE` status also hasn't been reviewed against F4's own `VALUE_FADE` bet-class override logic (it's the exact type F4 flagged as sitting close to the override's escape hatch) — these two threads likely converge, check together next.

- **Runner/trailing-stop optimization — saved, not started.** Full notes: `docs/RUNNER_OPTIMIZATION_NOTES_20260814.md` (DeepSeek's plain-English mechanism explanation, the broader "next level" roadmap DeepSeek volunteered — flagged as mostly out-of-scope institutional advice, not a near-term backlog — and Gemini's `structural_runner_optimization.py` prototype, permanent copy at `docs/structural_runner_optimization_20260814.py`). **Blocked on a real schema mismatch** (the script assumes flat `trades` columns and a `price_bars_primary.bar_time` column that don't exist in this codebase's real schema) — that's the actual next step, not a backtest. User explicitly: review the design first, don't just run it.

- **Promotion-pipeline structural audit (2026-08-16)** — full writeup: `docs/PROMOTION_PIPELINE_STRUCTURAL_AUDIT_20260816.md`. Triggered directly by the user, immediately after the cascade-breaker repair above: "I dont want to keep having an issue where setups arent getting promoted. Its fundamental here." Dispatched to DeepSeek for design critique; every checkable claim independently re-verified by Claude before recording (FK constraints, hardcoded-SHADOW insert code, all 3 poller query sites, `backtest_setup_status.mjs` fix-site line numbers — all confirmed exact against live code).
  - **DeepSeek pushed back on Claude's own framing, correctly**: the 4 known "setup never promotes" incidents (today's cascade contamination, `shadowcandidates_hardcoded_no_promotion_path`, `time_expired_exclusion_pattern_broader_audit`, the `OPTIMAL_STOP` circuit breaker) are NOT one bug class — they split into a genuine unilateral gate, an undercounted input to a working gate, poisoned data that cuts both directions, and a frozen-calibration problem on an unrelated axis. The real shared root cause is meta: **5 independent ACTIVE-vs-SHADOW decision sites in the code, only 2 of which read the canonical `SETUP_STATUS` table** — the other 3 (`shadowCandidates` INSERT, `minuteBarSignalDetector.getLiveStatus()`, `acd.js`'s `getOvernightLevelLiveStatus()`/`getStackVolBreakLiveStatus()`) each reimplement their own promotion check by hand and have each independently drifted.
  - **Real, still-open finding**: `time_expired_exclusion_pattern_broader_audit` (flagged 2026-08-03, was MEDIUM) is confirmed STILL LIVE inside all 3 of those independent promotion gates as of 2026-08-16 — elevated to HIGH. A setup type in the `momentum60_*`/`*_OVERNIGHT`/`STACK_VOL_BREAK_LIVE_*` families whose real trades mostly `TIME_EXPIRE` can sit stuck below the promotion floor indefinitely, a second and separate mechanism producing the exact symptom the user is worried about.
  - **New `OPEN_DECISION promotion_pipeline_structural_fix_2026_08_16`** (HIGH, not yet built) records DeepSeek's proposed 3-layer durable fix: (1) one canonical `isLiveEligible()` gate every insert path must call, replacing the 3 hand-rolled reimplementations; (2) a standing *reachability* invariant in `test_invariants.mjs` (sibling of existing check `[6]`) asserting every `ACTIVE`/`PROMOTE`-rated setup_type has at least one live insert path capable of firing `ACTIVE` — deliberately NOT a "something changed at N=20" check (too noisy/time-dependent), but a stable snapshot check that would have caught `STOP_SWEEP_LONG`'s "rated ACTIVE, zero real ACTIVE fires ever" case automatically; (3) one canonical "real resolved trade" SQL predicate, replacing the ~20-site copy-paste that let the `TIME_EXPIRED` fix silently miss most of its call sites in 2026-07-20/08-03.
  - **`shadowcandidates_hardcoded_no_promotion_path` (F3) updated** with DeepSeek's refined sequencing, not a new decision: ship the reachability invariant FIRST (it mechanically produces the per-type review F3's own caveat already demands), then ship F3 scoped (exclude `STOP_SWEEP_LONG`/`SHORT` until their separate pause decision resolves — don't couple them), then Layer 3.
  - **Also found in Part 1 (QA of the cascade-breaker repair itself)**: the repair script only checked 1 of 3 real FK constraints on `active_setups(id)` — missed `setup_outcome_backtest` (`ON DELETE CASCADE`, so a match would have been silently deleted with zero backup and zero error) and `trade_feedback` (restrict, would have blocked the delete but wasn't explicitly checked). Independently verified **zero actual data loss** (`setup_outcome_backtest`'s last real write predates the earliest CASCADE_BREAKER row by over a month) — harmless this time, but `docs/DB_MIGRATION_PROTOCOL.md` gained a new standing step (grep every `REFERENCES <table>` up front, not one FK error at a time) so the next repair script doesn't rely on getting lucky the same way.
  - **Not yet built — but a full build-ready spec now exists.** User signed off on the 3-layer approach and asked for a standalone implementation spec so a fresh session (post-`/clear`) can execute directly: **`docs/PROMOTION_PIPELINE_STRUCTURAL_FIX_SPEC.md`** (2026-08-16) — exact code for the Layer 2 reachability invariant (`test_invariants.mjs` check `[20]`, confirmed next-available number), the Layer 1 canonical gate + scoped F3 fix (excludes `STOP_SWEEP_LONG`/`SHORT`), and the Layer 3 poller migration, in the locked build order (2 → 1+F3 → 3), plus a "how do we know this actually worked" verification section per the user's explicit request to confirm the fix works before moving on to other decisions. Two open design questions are flagged IN the spec for the implementing session, not pre-decided: `minuteBarSignalDetector`'s family-pooling vs per-exact-type calibration (currently moot, zero real data either way), and whether migrating the 3 pollers should add DOW-suppression (a real behavior change) or stay `SETUP_STATUS`-only. **Next session: start directly from the spec doc**, no need to re-read this thread or the audit doc first.




- **Wider-target mechanism: pressure gate shipped, replacing a "fast = let it run" premise that didn't hold up (2026-08-24).** Full arc, same session: (1) speed alone (bars from fire to T1-touch) tested first, no clean signal — non-monotonic across the 1-4 bar range, thin/unstable per bucket. (2) A DeepSeek design critique (dispatched to scope the originally-proposed multi-stage MFE-checkpoint ladder, cut off mid-response but delivered its most important finding before failing) found a **live, opposite-signed precedent at the same checkpoint**: `acd.js`'s STACK_VOL_BREAK_LIVE bank-vs-extend branch treats *fast* T1 arrival as a climax spike and banks immediately, having already tested that extending fast arrivals there cost a median -$135/trade — directly contradicting the "fast → let it run" premise this thread started from. It also caught that the original framing mischaracterized `bar6_checkpoint` as validating "hold longer" when its actual validated direction is *exit early* (already adjudicated once before, re-caught here). (3) Buying/selling imbalance (favorable-minus-adverse volume fraction) at the T1-touch bar, tested next, showed a real, clean, monotonic signal — survived a confound-controlled check (regression controlling for same-day realized range and speed simultaneously; within-group replication on the single largest bet_class, VALUE_FADE alone, N=188, same clean climb: -$8/8%loss → $8/13%loss → $27/5%loss by pressure tercile) and a genuine chronological out-of-sample split (threshold derived from the first 60% of armed trades, applied unchanged to the later 40% — held up, most cleanly at the top tier: loss rate 4.5% in-sample vs 5.4% out-of-sample, nearly identical).
  - **Shipped as a gate, not the full multi-stage ladder** — matches DeepSeek's own top recommendation ("minimum viable version = the live mechanism plus exactly ONE new decision") rather than building the more ambitious, unresolved multi-stage/time-clocked design it was mid-way through specifying. `stepWiderTarget()` (`server/services/widerTargetWalker.js`) now takes optional `pressureReading`/`pressureThreshold` — when pressure doesn't clear the calibrated threshold, banks immediately (new `BANKED_LOW_PRESSURE` method) instead of arming. Purely additive: no threshold supplied = pre-2026-08-24 always-extend behavior, unchanged.
  - Threshold (top-tercile of real armed-trade pressure readings) calibrated by `scripts/calibrate_wider_target_pressure_gate.mjs`, persisted to `performance_audit` (`signal_type='WIDER_TARGET_PRESSURE_GATE'`), read live via the same cached-read-from-performance_audit pattern already used for `DELTA_CONFIRMATION_CALIB` — never hardcoded, scheduled weekly in `run_weekly_backtests.sh` so it tracks the growing population.
  - **Real tradeoff, not a clean win — surfaced explicitly, not decided unilaterally**: on held-out data, gating trades some average profit for meaningfully fewer real losses (mean $9.67 vs $16.25/trade, but losses 3 vs 11 out of 131 test trades) — only ~43% of trades actually extend under the gate, the rest bank safely. User chose to ship it given this project's broader risk-management-over-max-EV posture (DLL, profit-lock, cooldowns). The actually-extended subset shows `clustered=true` on `computeRigor()` — the exact loss-rate number isn't fully clear of the day-clustering bar yet, flagged honestly rather than oversold.
  - This entire mechanism remains **SHADOW-informational only** — `wider_target_mult` is never set on `ACTIVE`-origin rows, so nothing here touches live capital yet.
  - Synthetic test (`scripts/test_wider_target_walker_synthetic.mjs`) extended with 3 new cases covering the gate directly (weak pressure banks, strong pressure arms, no-threshold-supplied backward compatibility) — 25/25 pass.
  - Full research trail: `RESEARCH_CLAIM`s `wider_target_speed_participation_sign_check`, `wider_target_pressure_confound_check`, `wider_target_pressure_oos_check`, `wider_target_pressure_gate_vs_always_extend`. Resolves `OPEN_DECISION`s `wider_target_mfe_percentile_targets_vs_multiplier` (separately tested negative — global MFE-percentile targets underperform the multiplier at every candidate, see `RESEARCH_CLAIM wider_target_mfe_percentile_vs_multiplier`) and `wider_target_dynamic_checkpoint_reevaluation`.
  - **Not done**: the separate historical "what-if" replay endpoint (`acd.js` ~9698, a diagnostic reconstruction tool for already-resolved rows) was deliberately left unwired to the gate — applying it there would falsely flag old, pre-gate-era rows as `reconstruction_mismatch`. The fuller multi-stage/time-clocked progress-ladder design DeepSeek was mid-way through specifying remains unbuilt; revisit if this simpler gate's live SHADOW data ever motivates it.

- **Entry-proximity-to-level idea tested, decided against (2026-08-24).** User's hypothesis: entries currently fire the instant price comes within the live 15pt "nearLevels" window (using `currentPrice` as entry, NOT the level itself), and stop/target are fixed distances FROM ENTRY — so an early/far entry could eat into the intended stop distance if price keeps drifting toward the level before reversing, causing premature stop-outs. Proposed fix: require price to actually get much closer to (or touch) the level before entering.
  - **First-look retrospective check** (`scripts/pretest_entry_proximity_to_level.mjs`) conditioned real already-fired trades on how far entry actually was from the level. Caught and fixed a real methodology bug of its own along the way: same-day-forming levels (IB, OR-length) and continuously-developing ones (RTH_VWAP) can't be joined by trade_date alone — produced fake 500+pt "distances" until excluded (same bug class as CLAUDE.md's own same-day-forming-level documented pattern). After the fix: no clean monotonic pattern — the middle distance bucket was worst, not the far one.
  - **Full resimulation** (`scripts/backtest_entry_proximity_resimulation.mjs`), real bar-by-bar replay with no lookahead, walking forward from each real touch event under 6 candidate tighter thresholds (1/2/3/5/8/12pt) instead of the live 15pt/fire-immediately rule, correctly accounting for candidates that would never fire at all under a tighter rule (not just re-sorting already-fired trades). Findings: (1) fire rate collapses hard — only 13-46% of candidates ever get that close before drifting away, depending on threshold; (2) of the missed candidates, 53-56% would have been real winners under the current rule — tightening discards slightly more good trades than bad; (3) the trades that DO fire under a tighter rule are NOT individually better — their average (-$5.57 to -$21.38/trade depending on threshold) is worse than the current rule's overall average (-$3.77/candidate); any apparent total-dollar improvement at some thresholds is explained by trading far less volume, not higher-quality entries. Working theory: a level price only approaches-and-reverses from a distance may be a normal working fade, while one price grinds all the way down to and barely touches may be under more real pressure to break — the opposite of the original intuition.
  - **User decision: leave entries as they are.** Not pursued further. Both `RESEARCH_CLAIM`s (`entry_proximity_to_level_retrospective_check`, `entry_proximity_full_resimulation`) recorded PROVISIONAL with the full negative findings — a real, decisive-enough negative on the specific idea as tested, not proof no better entry-timing idea exists.

- **Two follow-on ideas from the pressure-gate work, both resolved same-session after a context clear (2026-08-24)** — real progress on both, neither buildable yet, both left as honest PROVISIONAL leads with named unblock conditions rather than closed dead:
  1. **`wider_target_multistage_pressure_extension` (RESOLVED, not built)** — DeepSeek's design critique kept writing after being first read (its response file grew from 16KB to 24KB before `invoke_deepseek.sh`'s 20-min timeout killed the process) and delivered a sharper conclusion than the one first recorded — corrected same-session once caught. Two independent structural arguments, not just thin data: (a) DISTRIBUTION MISMATCH — the T1-touch bar (stage 1) is by construction a high-volume directional-thrust bar, partly reading level-defence-vs-level-failure; a stage-2 checkpoint bar (still open K bars after arming) is by construction a "stall" bar in open space between levels — different distribution, the stage-1 threshold can't transfer (train→test exceedance already moved 33.3%→~43% across a purely chronological split on the *same* bar type; a structural thrust→stall shift should move it further, unpredictably). (b) STRUCTURAL IMPOSSIBILITY AT CURRENT POPULATION SIZE — `dirImbalance` is positively autocorrelated across small checkpoint offsets K, so any K with enough surviving trades to calibrate (reconstructing stage-1's own real numbers — N_eligible=327, every link N≥20 — requires ~93% of armed trades still open at the checkpoint) is also a K too early for the reading to carry information beyond what stage-1 already measured; any K late enough to be a fresh reading has too few survivors. **No K threads both needles at today's real armed population (~53-125 depending on definition)** — this is a proven tradeoff, not a data-volume complaint alone.
     - **Bonus find, fixed same session, more important than the original question**: `scripts/calibrate_wider_target_pressure_gate.mjs` was filtering on the stored `resolution='TARGET_HIT' AND bars_to_resolution<=4`, but `bars_to_resolution` is written at the *resolving* bar, not the T1-touch/arming bar — every trade that armed and then extended (`WIDER_TARGET_HIT`/`WIDER_STOP_HIT`/`WIDER_TIME_EXPIRED`) was silently excluded from its own gate's future recalibration sample, a self-reinforcing loop that would drift the top-tercile threshold down over time (armed rows leave the sample → threshold drops → more trades arm → more high-pressure rows leave → repeat). Verified live before fixing (53 rows with `wider_target_mult IS NOT NULL` and a WIDER_*-prefixed `resolution_method`, `bars_to_resolution` mostly >4, all of which the old filter would have dropped). Fixed subtractively — removed the two incorrect SQL clauses, the script's own downstream bar-walk already re-derives true eligibility correctly and independently of the stored fields. Re-ran clean: N grew 327→379 real eligible touches.
     - Recorded `RESEARCH_CLAIM wider_target_stage2_pressure_checkpoint_not_yet_viable` (PROVISIONAL, `unblockCondition` corrected to: real armed population growing to roughly the same order of magnitude stage-1 itself needed — several hundred, not the ≥100 first recorded — **and** DeepSeek's 3 named diagnostic pre-tests re-run to confirm an informative-and-adequately-sampled checkpoint K actually exists, since a raw N milestone alone doesn't resolve a ratio-based tradeoff). Also flagged, deliberately NOT fixed this session, `OPEN_DECISION wider_target_pressure_gate_fails_open_on_null_reading` (LOW) — the gate treats a null pressure reading (missing volume ingestion, indistinguishable from genuinely-zero volume since `bid_volume`/`ask_volume` are `NOT NULL DEFAULT 0`) as "gate passed," low-impact today (T1-touch bars are high-volume, missing data there is rare) but would become the *dominant* failure mode on a stall-bar stage-2 checkpoint — left as a live-behavior-change decision for explicit review rather than changed unilaterally.
  2. **`pressure_as_entry_time_sizing_signal` (RESOLVED, not built)** — full 3-phase workflow run (Gemini phase-0 critique → phase-1 backtest → a direction-split rigor follow-up after the pooled result washed out, all independently audited by Claude), then a genuine chronological out-of-sample check (TRAIN=first 60% of unique trade-dates, TEST=last 40%, per explicit user request to validate before wiring anything). **The LONG-side finding was discarded — it inverted out-of-sample.** Pooled, high pre-entry buying pressure looked harmful for LONG fades (EV -$17.35 vs -$3.91 baseline, N=40, "stable" per `computeRigor`'s chronological-thirds check) — but TRAIN alone showed a *positive* EV (+$2.23, N=22) while TEST alone showed a severe *negative* EV (-$41.28, N=18): a full sign inversion, not decay. Concrete, live proof that this codebase's rigor/clustering checks are not a substitute for a genuine train/test holdout — a finer 3-way split of the same subset passed cleanly while a real two-period holdout caught a spurious correlation the thirds check missed. **The SHORT-side finding replicated genuinely** — TRAIN EV=+$8.08 (N=22) vs neutral -$3.37, TEST EV=+$33.41 (N=23) vs neutral +$14.76, both periods positive and the effect grew rather than decayed; the absorption mechanism (lift concentrated where `sellersAtLevel==false`) held in both halves too. Recorded `RESEARCH_CLAIM pressure_entry_sizing_direction_asymmetric` (PROVISIONAL, updated) — SHORT-side is now genuinely OOS-validated but still too thin to wire (N=22-23 per half; unblock condition raised to N≥100 pooled so a 3-way chronological check becomes possible, not just one train/test split).
     - **Wired live anyway, deliberately (2026-08-24, explicit user call)**: this system doesn't trade real money and the user's stated priority is faster feedback loops over maximum caution — "I need to know if these things work sooner" / "this is all experimental." N=45 does clear this codebase's own general N≥20 live-firing floor even though it's below the stricter 3-way-check bar. Wired as a new `sizeMultiplier` factor, **SHORT-only, level-fade family only** (same population it was tested on — `VWAP_MAGNET`/`GLOBEX_*`/`OVERNIGHT_*` setups run through a separate, simpler multiplier path and are NOT included, deliberately, since extending to an untested population is exactly the mistake the LONG-side inversion just demonstrated). New shared function `server/services/entryPressureService.js` (`computeDirImbalance()`, imported by both the live code and the calibration script — single source of truth). New weekly-scheduled `scripts/calibrate_pressure_entry_sizing_short.mjs` (top-tercile raw-ratio threshold, not the rolling Z-score the original finding used — a live per-poll rolling Z-score would need an expensive historical re-walk; top-tercile is the same simpler convention `WIDER_TARGET_PRESSURE_GATE` already uses). **"Track if it starts to hurt us" (explicit user instruction) is the actual mechanism, not a figure of speech**: the calibration script floors the bump to 0 automatically if real forward EV isn't clearly positive on a given weekly run — nothing needs to notice or intervene for a bad recalibration to disable it. Bump capped at 0.15 (matches this IIFE's other single-factor bonuses), calibrated live at ship time to 0.05 off N=364 real trades (top-tercile lift $13.17 vs $8.06, +$5.12/trade — a broader, more diluted population than the Z≥1.0 OOS test, by design, since it needs to be cheaply computable live). `entryPressureShortBoost` added to the existing `sizeFactorsAtDetection` raw-input snapshot. Verified: syntax check, `test_invariants.mjs` (same pre-existing 2 failures/40 warnings as before, none new), server restart, endpoint curl-check, `scratch/server_errors.jsonl` clean of new entries.
     - **User then asked why this should stay level-fade-only rather than testing across all setup families — tested, and the level-fade-only scoping was correct, confirmed by catching a real Gemini bug on audit.** Gemini's dispatch reported "definitively real across the board... cleared to broaden the live wiring" — wrong. Its lift calc compared the boosted bucket's EV against the WHOLE population average (which includes the boosted trades themselves, inflating the apparent lift), not against the below-threshold trades specifically. Claude independently re-derived with the correct above-vs-below comparison on the same chronological split: `VWAP_MAGNET`'s boosted bucket is **negative in the held-out test half** (-$37.75/trade, N=8) despite looking strong in train — fails. `OTHER` (a grab-bag of unrelated setup types pooled together, itself a confound) is also negative in test (-$12.62/trade, N=43) — fails. `GLOBEX` shows a real lift in both halves (train $21.33 vs -$0.23 below; test $12.38 vs -$26.54 below) but decayed substantially and hasn't been through the mechanism check (absorption pattern) or day-clustering/rigor check the level-fade finding needed before being trusted — a genuine separate lead, not dismissed, just not ready. Recorded `RESEARCH_CLAIM pressure_entry_sizing_allfamilies_gemini_bug_caught` (PROVISIONAL). **Live wiring stays level-fade-only, unchanged.** Process lesson restated: a Gemini dispatch reporting uniform, no-exceptions replication across every subgroup tested is exactly the "too clean" pattern this codebase's rules already flag for mandatory re-derivation before trusting — confirmed again here, caught before any live change.
     - **Pushed further, per direct user question ("why not test against every setup") — two more rounds, both direct (not dispatched), both negative, both reinforcing rather than overturning the conclusion above.** (1) Full sweep of all 22 setup_types with N≥20 real directional trades (`scripts/backtest_pressure_entry_sizing_full_sweep.mjs`), ranked by apparent lift — the top-10 list looked compelling (`FAILED_AUCTION_LONG` +$88.67, `PD_POC_FADE_SHORT` +$47.00, etc.) but **failed `computeReplication()`** — pooled against the other 12 candidates as a held-out group, the top-10's lift (+$27.16) does not replicate (held-out pooled = -$11.61, only 17% favorable-signed) — a clean demonstration of exactly the multiple-comparisons trap this codebase's confound checklist item 4 exists to catch. (2) Genuine per-type chronological OOS split on the 5 setup_types with N≥50 (`scripts/backtest_pressure_entry_sizing_highn_oos.mjs`), the highest-power individual candidates available — none actionable: `IB_BEARISH` showed a huge train-period lift (+$47.61) that collapsed to both buckets negative in test (a real decay story, not a validated effect); `GLOBEX_VWAP_MAGNET_LONG`/`VWAP_MAGNET_LONG` both inverted; `IB_BULLISH` was the one directionally-consistent result but tiny in test and the setup is already globally suppressed. **Corrects an earlier claim in this same entry**: `GLOBEX_VWAP_MAGNET_SHORT` tested individually actually *inverts* — the earlier "GLOBEX family shows real lift in both halves, worth a follow-up" read was a pooling artifact across several different GLOBEX setup_types, not a real per-type signal. Recorded `RESEARCH_CLAIM`s `pressure_entry_sizing_full_sweep_no_universal_effect` and `pressure_entry_sizing_highn_types_oos_none_actionable` (both `CONFIRMED`). **This closes the "test it against everything" thread** — properly tested at both the ranked-sweep and high-N-individual levels, nothing beyond the original live-wired LEVEL_FADE SHORT finding survives scrutiny in this codebase's current real trade population.

- **MFE-computation near-miss + quick-check.html audit (2026-08-24).** User's own direct observation ("I see 1-3 zero-MFE trades a day on the HA page") caught a real bug in an ad-hoc Claude pilot script (`scripts/pilot_approach_pressure_zero_mfe_veto.mjs`, testing whether against-direction approach pressure predicts dead-on-arrival trades — user's own idea): the script computed MFE itself via an unbounded bar walk (up to 500 bars, no session cutoff) instead of reading the canonical `mfe_points` column, silently crediting favorable price action from after 4PM RTH close (sometimes the next day) that a real trade never actually had — undercounted the true zero-MFE rate by half (5.1% vs the real 10.9%). Fixed by reading the stored `mfe_points` (`scripts/backfill_mae_mfe.mjs`'s own RTH-bounded, same-day replay) instead of re-deriving it. **Corrected result reverses the original hypothesis for LONG**: high against-direction pressure predicts *fewer* dead-on-arrival trades, not more, consistently in both chronological halves — opposite of the intuitive "level about to break" framing; a real rejection/absorption read is more consistent with the data. SHORT shows no signal either way. Not wired anywhere — recorded as a lesson, not a claim (the target variable itself needed fixing before any claim could be trusted).
  - **Prompted a DeepSeek code-review audit of `quick-check.html` and its full backend data pipeline** (the page the user actually watches on Home Assistant), given the near-miss. The dispatch hit its 25-minute time budget before writing a clean final report (`scratch/deepseek_quickcheck_audit.md` was never created), but its raw working transcript (`scratch/deepseek_response.md`) surfaced two real findings, independently verified before acting: (1) **a real, latent bug, fixed** — `/market/pulse` (backs the page's live pulse bar) hardcoded `etOffset = -4` (EDT), silently correct only March-November; would have shifted the date rollover and RTH-window boundary an hour early every day of EST season. Replaced with this file's own established DST-aware pattern (`toLocaleString`/`toLocaleDateString` with `timeZone: 'America/New_York'`, matching `runSetupDetection`'s own `nowET`/`todayET` in the same file). (2) A second claim (the wider-target counterfactual endpoint not passing pressure-gate params) turned out to be an already-documented, deliberate 2026-08-24 decision (`OPEN_THREADS.md` line ~1070) that DeepSeek rediscovered mechanically without the session context explaining why — confirmed still correct, no action needed, but a reminder that a static code-review audit can flag a real code fact as if it were a bug when it's actually a considered tradeoff.
     - **Bonus find while recomputing the redundancy check**: confirmed a real, separate, already-live bug — `_lfDeltaNeutral`/`_lfDeltaHigh` (the "Session delta magnitude" `sizeMultiplier` factor, `acd.js` ~5953-5984) compares a *partial-day* running delta (RTH open to whenever a setup fires) against *full-day* historical percentile thresholds — mechanically makes `_lfDeltaHigh` almost never fire (1/704 in this sample) and `_lfDeltaNeutral` fire almost always (609/704). Flagged as `OPEN_DECISION lf_session_delta_partial_vs_fullday_percentile_mismatch` (MEDIUM) — not yet fixed, two open questions before it can be (did the original 2026-07-08 backtest that validated this factor use the same partial-vs-full comparison, or full-day delta with a lookahead problem of its own; and whether the fix should scale the partial sum by elapsed-session-fraction or use time-of-day-conditioned thresholds instead).
  - Next step for either thread: accumulate real data under the now-fixed pipeline, then revisit — both are "not enough data yet," not "doesn't work."


- **Wider-target widener wired into ACTIVE + trail-calibration silent-fallback fixed (2026-08-24, explicit user decisions).** Two related threads that came out of a "how do the last 19 days look under everything we've implemented" investigation.
  - **Widener wired live to `ACTIVE`**: the wider-target mechanism (`wider_target_mult`) was SHADOW-only since 2026-08-17 by a hardcoded gate (`forceShadow && !isTrailMechanism`). Removed the `forceShadow` condition at both real insert sites (~9091, ~9239) — user's explicit call, given a real 19-day SHADOW track record (53 armed trades, 47 `WIDER_TARGET_HIT`/5 `WIDER_STOP_HIT`, net **+$1,071.75** vs a plain-bank-at-T1 counterfactual on the same trades) and the user's own stated priority (not trading real money, wants faster validation loops over maximum caution). This is a materially different kind of change than the earlier entry-pressure sizing boost — it changes the actual displayed stop/target on a real trade, not just a size hint. The pressure-gate refinement shipped earlier the same day stays live regardless and is unaffected by this change.
  - **Real auto-promotion question raised and answered**: user asked why this hadn't auto-promoted after 50+ samples like other setup_types do. Answer: it structurally couldn't — the automatic SETUP_STATUS pipeline governs setup_types, not cross-cutting exit-mechanism modifiers layered on top of them. There was never an automatic gate watching this mechanism's sample size; the SHADOW-only restriction was always a manual code condition requiring an explicit human decision to remove, same as this one.
  - **Surveyed the other 2 exit-mechanism modifiers in this codebase** (mutually exclusive with the widener and each other, confirmed via code): `runner_trail_width` (breakeven-then-trail) is in the exact same situation — `forceShadow = isTrailMechanism || ...` forces every trail-variant setup_type to SHADOW unconditionally. `extend_target_level` (STACK_VOL_BREAK bank-vs-extend) is NOT hardcoded SHADOW-only — it goes through the normal SETUP_STATUS promotion pipeline like any other setup, just hasn't cleared N≥20 yet (only 13 real trades total, all SHADOW). Checked STACK_VOL_BREAK's own extend mechanism's real track record: fired exactly once, lost $78 (vs +$78 if it had just banked at T1) — net **-$156** impact. N=1, not evidence either way, but the one data point is negative, not positive — explicitly not a candidate for wiring live right now.
  - **Breakeven-trail investigation, real root cause found (not what the session-start alert implied)**: re-ran `scripts/backtest_breakeven_trail.mjs` fresh — **0 of the 6 live-wired `_TRAIL` variants survive its statistical guardrails today** (Tier A: 0 survivors; Tier B: 1 survivor, and it isn't even one of the 6 wired variants — it's `PD_POC_FADE_SHORT`, an unrelated exploratory candidate). This is not a stale-schedule or code bug — the script runs weekly via `run_weekly_backtests.sh` and last ran 2026-08-23. It's a genuine, current statistical finding: these 5 fail `failedOosOrBaseline`/`noPlateauPass` checks even with more real data than existed two weeks ago. The one row still present for a real wired variant (`FLOOR_S1_FADE_LONG_TRAIL`, via `B_FLOOR_S1_FADE_LONG`) survives only because the script deliberately never deletes a live-consumed row just because it stops surviving a given week (a documented protection from `breakeven_trail_calibration_wiped_by_unscoped_cleanup`) — it's coasting on an old pass, not a fresh one.
  - **User given 3 options** (leave silent / make the silent fallback visible / unwire the 5 non-survivors from `CONDITIONAL_VARIANTS` entirely), was unsure, Claude recommended and the user confirmed **option 2** (cheap, safe, reversible, matches the session's established "show the full picture" theme rather than leaving a dead mechanism looking identical to a working one). Shipped: `resolveSetupsByPrice()` now computes `trailCalibrationMissing` (a `_TRAIL`-designated row with no working `runner_trail_width`) and tags its resolution with a distinct `TRAIL_UNCALIBRATED` method (fits `VARCHAR(20)`, checked not assumed) instead of the ordinary `PRICE_CLEAN`/`MARK_TO_MARKET` a genuinely-never-trail-eligible trade gets. Pure observability — no behavior change. Also corrected a stale comment ("Only FLOOR_R1_FADE_SHORT_TRAIL sets this today") that predated the other 5 variants being wired 2026-07-21.
  - **Not done**: option 3 (unwiring the 5 non-surviving trail variants) remains on the table, deliberately deferred — revisit once the `TRAIL_UNCALIBRATED` tagging has had a chance to show whether the situation changes, or if it's been stuck this way for a long stretch.
  - Full 19-day-lookback investigation methodology (the current-eligibility filter using the real `isLiveEligible()`/`computeSuppressionSets()` functions, the payoff-shape/break-even-WR check, the widener/STACK_VOL dollar-impact counterfactuals) lives only in this session's scratch scripts, not yet promoted to `scripts/` — revisit if this kind of "how does everything implemented today judge a recent window" check becomes a recurring ask.

- **Confirmation-gate re-audit corrects an overstated Gemini negative (2026-08-24) — a real, complete multi-model audit chain.** User asked to revisit `OPEN_DECISION revisit_2bar_confirmation_gate_criteria` (the strict single-close-fails confirmation gate that came back flat), then asked Gemini for its take.
  - **Gemini re-tested with the codebase's real 2-consecutive-closes convention** (correctly found and reused `stepPocStructuralStop()` from `scripts/backtest_poc_convergence_directional_and_trade.mjs`, verified accurate) — new script `scripts/backtest_poc_rotation_join_confirm_2close.mjs`. Reported EV degrading with wait length, concluded "the confirmation gate premise is dead, don't pursue." Independently re-run by Claude — numbers reproduced closely, confirming the raw result wasn't fabricated.
  - **User asked for a DeepSeek audit of the methodology itself.** DeepSeek caught two real problems: (1) the comparison confounds WHICH events pass the gate with WHEN you enter — `wait=0/all-events/immediate` vs `wait=N/gated-events/delayed` changes two things at once, missing the confound-checklist control (a "blind delay, all events, same delayed entry, no gate" arm) needed to isolate the gate's own value; (2) "EV degrades monotonically" doesn't hold in the raw numbers either — FIXED_R65's wait3 EV ($1.25) beats wait2 ($1.02), PCT's wait2 EV ($1.60) is above its own baseline ($1.58) — only 2 of 6 EV series are actually monotone, and the summary quoted the two endpoints while skipping the cell that breaks the trend.
  - **Built and ran the missing control directly** (`scripts/backtest_poc_rotation_join_blind_delay_control.mjs`) rather than trust DeepSeek's prediction unverified. **Confirms DeepSeek's catch**: isolated gate value (gated EV minus blind-delay EV, same wait) is genuinely positive at short waits — FIXED_R65 wait2 +$0.17/trade, wait3 +$0.15/trade; PCT wait2 +$0.33/trade, wait3 +$0.53/trade — but flips negative at wait5 in both constructions (-$0.33, -$0.20), so DeepSeek's own "grows monotonically" claim only partially holds too.
  - **Practical bottom line ends up unchanged from Gemini's, but for the correct reason**: in every cell, the gate's real positive value is still smaller than the entry-timing cost of the delay, so the combined (actually-tradeable) number stays below immediate entry everywhere tested — still don't delay entry for this gate. But "the whole idea doesn't work" was an overstatement; the confirmation signal itself carries real information, it's just not currently being captured in a way that pays for itself.
  - **Real, unexplored idea surfaced by getting the mechanism right, not something either single-model pass would have found**: use the confirmation signal as a size/confidence input on an *immediate* entry instead of a delay gate, or reduce the delay's own execution cost (a resting limit order near the original signal price instead of paying full market-order slippage N bars later). Not tested — worth a dedicated look before considering this thread fully closed.
  - Recorded `RESEARCH_CLAIM poc_rotation_confirm_gate_isolated_selection_value` and resolved `OPEN_DECISION revisit_2bar_confirmation_gate_criteria` with the full corrected picture. Three new scripts on disk: `scripts/backtest_poc_rotation_join_confirm_2close.mjs`, `scripts/backtest_poc_rotation_join_blind_delay_control.mjs`.

- **Scale-in confirmation idea: real signal evaporates once immortal-time bias is properly controlled (2026-08-24/25).** Follow-up to the confirmation-gate correction above — user's own idea: instead of delaying entry to wait for confirmation, enter a base lot immediately and only ADD a second lot if a confirmation criterion fires. Tested at increasing rigor:
  1. **Fixed-checkpoint version, naive comparison** (`scripts/backtest_poc_rotation_join_scale_in.mjs`, checkpoints 2/3/5/7/10 bars — extended per user request, "these are 1-minute bars, might need 10"): comparing a strict confirmation criterion (level held via 2-consecutive-closes, AND closed favorably vs. own open, AND real order-flow via `computeDirImbalance()` confirms) against a blind-add-everyone control looked promising — beat blind sizing in 7-8 of 10 cells, $0.17-$2.76/trade.
  2. **DeepSeek design audit, dispatched before building the harder event-driven version, caught the real problem before it was built** (`scratch/deepseek_scale_in_control_design.md`, exceptionally thorough): this whole comparison shape — even the "simple" fixed-checkpoint one — carries **immortal-time bias**. Proof by thought experiment: even a pure-noise coin-flip trigger would show a fake positive under a naive "confirmed vs everyone" comparison, because surviving longer without breaking is itself correlated with a better outcome, independent of any real signal. Correct fix: landmark-stratified standardization — compare confirmed trades only against *other trades alive at the exact same bar*, never against a population that includes early failures. Also specified: 4 standardized arms (SIGNAL/LANDMARK_BLIND/AMBIENT_BLIND/a diagnostic-only TIMING arm), a day-blocked permutation null (not a naive shuffle — two "obvious" shuffle designs were explicitly ruled out with the algebra showing why), fixed eligibility window regardless of when the add happens, and consistent data-completeness gating across all arms.
  3. **Built the properly-controlled version exactly to spec** (`scripts/backtest_poc_rotation_join_scale_in_landmark.mjs`, K=8, 5000-rep permutation test) — **the signal evaporates completely.** FIXED_R65: the real tradeable policy (EV_A=$2.18) *underperforms* blind-add-to-everyone-alive (EV_B=$3.08) by -$0.90 and blind-add-to-literally-everyone (EV_C=$3.04) by -$0.86; permutation p=0.63 (statistically indistinguishable from a coin flip). PCT_R0.22pct: EV_A/EV_B/EV_C are essentially identical ($2.04/$2.05/$2.01); permutation p=0.99.
  - **Confirms this was exactly the bias DeepSeek predicted**, not a real effect that got diluted — the naive version's promising numbers were the artifact itself, demonstrated directly rather than just theorized.
  - **One genuinely interesting honest byproduct**: a diagnostic quantity that cheats by knowing in advance which trades eventually confirm (not tradeable — conditions on future information) shows real value ($7.51/$5.93, well above EV_A) — proving good add-opportunities genuinely exist in this population, just that this specific confirmation criterion doesn't find them. A different criterion might; this one, tested rigorously, does not.
  - Recorded `RESEARCH_CLAIM poc_rotation_scale_in_confirmation_no_real_signal` (CONFIRMED). This closes both the plain-delay confirmation-gate thread and the scale-in follow-up as real, decisive negatives — reached through a process rigorous enough that the negative itself is trustworthy, not just the first plausible-looking stopping point.
  - **Separately, real, thread-wide, unrelated to any of the above findings' validity**: flagged `OPEN_DECISION poc_rotation_thread_points_mislabeled_as_dollars` (HIGH) — every script in this entire multi-session POC-rotation thread, including its foundational script, reports raw price-point differences prefixed with "$", never applying MNQ's real $2/pt or the $2 round-trip commission. Worked out that DIFFERENCED comparisons (like all the Q1/Q2/Q3 findings above) have the commission cancel exactly so only a 2x scaling was missing (fixed in the newer scripts written this session); ABSOLUTE EV values elsewhere in this thread's older history do NOT get that cancellation and need individual re-checking, not yet done comprehensively.

- **Level-confluence research (2026-08-25): the origin point of a leg predicts the outcome for ONH/ONL and WS1 specifically, nothing else.** Continuation of the POC-rotation-JOIN thread above — user's own idea, prompted by the leg-speed pretrigger-feature result (see below): does the leg's *origin* (the pivot bar where it reversed) sitting near a known market level predict the base trade's outcome? Tested with a wick-tolerant touch check (3-bar window, `TOUCH=15pt`, matches the live RTH/overnight convention) so a brief breach-and-return still counts, per the user's explicit framing.
  1. **First pass, 27 independent (non-POC) levels** (`scripts/backtest_poc_rotation_join_level_confluence.mjs`): aggregate "any level touch" looked huge (lift $17-9.60/trade) but the 91% touch rate (27 levels × 30pt zones) was suspicious. **Blind control** (`scripts/backtest_poc_rotation_join_level_confluence_blind_control.mjs`, 27 random reference points, same density): did NOT replicate the same-sign pattern — ruled out "any dense reference grid does this," but the aggregate framing stayed too blended to trust on its own.
  2. **Per-level replication check** (`computeReplication()`, N-weighted pooled EV across two price constructions): **ONH+ONL passes** — pooled EV $21.18/trade (N=335) vs. held-out pool (other 26 levels) $1.83/trade, same sign, held-out favorable frac exactly 0.50. The 4 best-looking pivot sub-levels (CAM_S1/S4, FLOOR_R1/S1) do NOT pass as a family (0.46, just under the bar) — some pivot types are good, others in the same family are flat/negative, so "pivots in general" isn't supported. Recorded `RESEARCH_CLAIM poc_rotation_join_onh_onl_confluence` (PROVISIONAL).
  3. **Independence check vs. the leg-speed finding** (user's sharp question: "is this just restating leg speed?"): overlap was actually *below* chance (191 high-speed among 683 ONH/ONL-touch legs vs. 231 expected). Controlling for speed directly — splitting into low-speed and high-speed legs and checking ONH/ONL *within each* — the gap holds in both: low-speed at-level $14.19 vs. away -$5.87 (both stable); high-speed at-level $14.48 vs. away $2.51 (away flagged unstable). Genuinely independent signal, not a proxy for speed.
  4. **Extended sweep for mid-points, longer-term levels, and same-day Initial Balance** (`scripts/backtest_poc_rotation_join_level_confluence_extended.mjs` — PD_IB_MID/PD_SESSION_MID/PD_OR_MID, 3M/PY value areas, MONTHLY_OPEN/WEEKLY_OPEN, 10D_IB_MID/5D_OR_MID, weekly/monthly pivots, and live-computed same-day IB/OR5/OR10 gated to fire only after each actually closes — no lookahead): the naive top-3 (WS1/WR2/MONTHLY_OPEN) failed as a bundle, but isolating them found **WS1 alone passes** the same replication bar (pooled EV $22.15/trade N=42, held-out favorable frac 0.56) — `WR2` looked good but is day-clustered in both constructions (untrustworthy), `MONTHLY_OPEN` is inconsistent between constructions, and **nothing IB-related held up** (`PD_IB_MID` fails alone, same-day IB/OR never even reached the touch-breakdown's own N≥15 floor). Recorded `RESEARCH_CLAIM poc_rotation_join_ws1_confluence` (PROVISIONAL).
  5. **Real perf bug found and fixed mid-session**: the extended sweep's `etMinuteOfDay()` helper constructed a fresh `Intl.DateTimeFormat` on every call inside nested loops (millions of calls across 1924-2288 events) — silently caused two direct runs to get killed by Claude's own 280s tool timeout with no error, looking like a hang. Fixed by reusing one formatter instance and precomputing each session's per-bar ET-minute array once. Confirmed exit code 124 (timeout) via the task runner's own log, not a script bug.
  6. **Dispatched to Gemini for the final PCT-construction run** (user's own suggestion, after the direct run kept timing out) — first genuine Gemini dispatch of this whole session's research thread; audited by confirming Gemini's FIXED_R65 output matched Claude's own direct partial run exactly (same N/WR/EV per level) before trusting the new PCT numbers.
  - **Pre-trigger features tested the same day, before the level-confluence pivot** (`scripts/backtest_poc_rotation_join_pretrigger_features.mjs`): leg speed (points/bar) is the one candidate that didn't invert out-of-sample (PCT construction: train gap $3.19 → test gap $5.34, actually grows OOS; FIXED_R65: stays positive-signed but decays ~85%) — recorded `RESEARCH_CLAIM poc_rotation_join_leg_speed_pretrigger` (PROVISIONAL). Pre-trigger order-flow pressure (both a fixed 5-bar window AND a whole-leg-adaptive window built specifically to test the user's critique that 5 bars was arbitrary) and leg duration all inverted OOS in both price constructions — recorded together as `RESEARCH_CLAIM poc_rotation_join_pretrigger_pressure_duration_negative`. Notably, the whole-leg-adaptive pressure window performed *worse* than the arbitrary fixed one, not better — the user's hypothesis was reasonable to test but didn't hold.
  - **Confirmed existing live infrastructure already covers "confluence helps any setup" more broadly**: `backtest_confluence.js`'s weekly pair-bonus sweep (already live via `liveStats._pairBonus` in `acd.js`, confirmed by grep) has 75 `VALIDATED_PAIR` rows in RTH + 7 more overnight, across 344 pairs tested total — 8 already involve ONH/ONL specifically (`ONH+PD_HIGH` $16.52/trade, `ONL+PD_POC` $12.50/trade, etc.). This is a *different* mechanism from today's origin-confluence research (simultaneous-touch-at-trigger vs. leg-origin-before-entry) and was already running before this session, not something today's work triggered.
  - **`ONH_FADE`/`ONL_FADE` themselves remain `THIN_N`/SHADOW** (a third, separate thing from both of the above — a direct fade of touching ONH/ONL itself) — real N is 1/3/15/18 across the 4 direction variants, all below the N≥20 floor; nothing to do here but let real data accumulate, the weekly `backtest_setup_status.mjs` pass will auto-promote once it clears.
  - **Flagged `OPEN_DECISION poc_rotation_join_promote_to_live_setup_type`** (MEDIUM) — the base POC-rotation-JOIN trade has never been wired live anywhere (confirmed via grep, zero references in `acd.js`), so none of today's confluence findings have anywhere to attach yet. This is the real go/no-go blocking any of today's work from mattering practically.
  - **Two loose ends noted, not resolved**: (1) today's raw `active_setups` data shows `PM_POC` was crossed during a quiet overnight stretch after its one 04:25 AM fire resolved, without a second fire — not yet checked whether that's a real gap or expected dedup behavior. (2) `ONH_FADE`'s real N (1 LONG, 3 SHORT) is far below `ONL_FADE`'s (18/15) despite being the mirror-image setup — not yet checked whether that's real touch-frequency asymmetry or something about when/how `ONH_FADE` started firing live.

- **PD_VAH/PD_VAL "early entry eats the stop" hypothesis tested directly — not confirmed, and a real data-integrity bug found along the way (2026-08-25).** User asked why PD-VAH/PD-VAL fades "seem to fail," hypothesizing that the live `TOUCH=15` proximity window (both `detectGlobexSetup()` line ~1437 and the RTH `nearLevels` filter line ~7005 — confirmed hardcoded, itself a `no-static-thresholds` violation worth fixing generally) lets entries trigger up to 15pts before price actually reaches the level, so the calibrated stop gets hit before the real level ever gets tested.
  - **Live status check first**: `PD_VAH_FADE_SHORT` is actually `ACTIVE` (real WR 59%, EV +$5.06/trade) — fine. `PD_VAL_FADE_LONG` is the one that's actually broken: `SUPPRESS`, WR 57.3% but EV **-$8.13/trade** (classic "wins more often than not but loses more when it loses" signature). Its `OPTIMAL_STOP` has never found a rigor-clean stop/target — stuck on `volatility-scaled-default` because chronological thirds are genuinely unstable (EV $49.33 → -$13.33 → $26.55), not a clean plateau.
  - **Tested the hypothesis directly**: joined real (`origin_status IN ('ACTIVE','SHADOW')`) resolved trades against `developing_value_log`'s actual prior-day VAH/VAL to measure entry price's real distance from the level. First pass showed a huge, seemingly-confirming gap (winners entering 47-120pts from the level) — traced by hand-checking individual rows and found it was **contamination from a `developing_value_log` gap (2026-08-14 through 2026-08-18 has zero rows)**, causing the join to silently grab a stale value area up to 6 trading days old for anything fired 2026-08-19. Excluding the corrupted join: winners and losers for both setup types entered within a few points of each other (PD_VAH_FADE_SHORT: -7.3 win / +0.28 loss; PD_VAL_FADE_LONG: -4.91 win / -3.28 loss) — no clean separation, though N=10-14 per bucket is well under the N≥20 floor so this doesn't rule the mechanism out, it just isn't confirmed by what real data exists.
  - **Real, separate bug found**: `developing_value_log` is missing 3 consecutive trading days (2026-08-14/17/18) — any future script joining `trade_date` to "the immediately prior day's value area" via a naive LAG/self-join will silently pull a stale level across that gap. Not yet root-caused (compute_levels.js failure? a backfill gap?) or fixed. Worth checking before trusting any other PD_VAH/PD_VAL/PD_POC-adjacent analysis that spans 2026-08-13 to 2026-08-20.
  - **Not yet done**: the more likely real explanation for PD_VAL_FADE_LONG's negative EV — the chronological EV instability itself (day-type? regime? DOW?) — hasn't been investigated. User said "hold off" on building anything; this is parked pending that.

- **Sierra Chart's "PD-VAH" study uses a DIFFERENT session window than our `PD_VAH`/`PD_VAL` — confirmed via the study's own settings, not guessed (2026-08-25).** User's chart showed a PD-VAH line at 29392.25; our system's `PD_VAH` for the same day (from `developing_value_log`, cross-checked against a fresh `computeVolumeProfileForRange()` recompute — both agree exactly) is 29206.25, ~186pts away. Root cause found in the Sierra "Volume Value Area Lines" study's actual settings screenshot: `Use Day Session Only = No` — Sierra is computing the value area over the full 24hr Globex session, while our system is RTH-only (9:30am-4pm ET). Volume Value Area % matches ours exactly (0.7), so that's not the source. **Practical consequence found live the same day**: the "clean PD-VAH defense" the user visually flagged on that chart was NOT actually our `PD_VAH_FADE_SHORT` firing — it was `WEEKLY_OPEN_FADE_SHORT` (confluence: `OR5_HIGH/OR10_HIGH/OR15_HIGH/FLOOR_R2/WEEKLY_OPEN`, no `PD_VAH` in the set) coincidentally sitting near where Sierra's differently-computed PD-VAH line was drawn — a real, current-session confirmation that our system's PD_VAH and the visually-traded PD-VAH are different numbers, not just a one-off discrepancy. `OPEN_DECISION` needed: decide whether to (a) leave both definitions as-is and document the difference, (b) add a full-24hr-session PD_VAH/PD_VAL variant alongside the RTH-only one, or (c) switch the RTH one to match Sierra's session definition — not yet decided, flagging for a real `flag_decision.mjs` entry next session.
  - **Today's own stop/target tally is rough**: 27 STOP_HIT / 16 TARGET_HIT / net -$739 as of ~11:12 AM. A quick (uncontrolled) check found 26 of those 27 stopped-out trades saw price revisit their original target level again later in the window — but this is NOT a validated "stops are too tight" finding; it only checked "was the target ever touched again," not a real bar-by-bar re-simulation of whether a wider stop would have survived to get there without itself being hit first (the same immortal-time-bias risk the scale-in research caught above). Real next step if pursued: `SIGNAL`/landmark-style controlled re-simulation with an actual wider-stop candidate, per the existing confound checklist, before concluding anything about stop sizing.
  - **New idea, user's own, logged not yet tested**: for setups with a natural "opposite" paired level (PD_VAH↔PD_VAL, PW_VAH↔PW_VAL, ONH↔ONL, and any other same-family high/low pair), test using the opposite-side level itself as the target instead of (or alongside) a fixed-point stop/target — several of today's fires visually suggest fades often run to the paired level. Not yet backtested; would need the standard structural-advantage-control treatment (a wider/paired target is trivially easier to "hit" than a fixed point, so the comparison needs a same-distance fixed-point control arm before crediting the pairing itself).
  - **RESOLVED 2026-08-25, both follow-up threads closed with real negatives, nothing left open.**
    1. **PD_VAH/PD_VAL session-window question (decision (a)/(b)/(c) above)**: tested directly — a full-24hr-session value area (matching Sierra's `Use Day Session Only=No` study) does NOT fade better than the live RTH-only definition under a shared, neutral, no-lookahead exit. Every population (RTH baseline, full-session FRESH/SPENT_TESTED_AGAIN_RTH/SPENT_OVERNIGHT_ONLY) is either net-negative or chronologically unstable; Claude independently re-ran Gemini's corrected script and reproduced every number exactly (N=824/76/221/422/663/556, same WR/EV to the decimal). **Decision resolved: keep RTH-only PD_VAH/PD_VAL as-is** — the visual mismatch is real and documented but doesn't correspond to a better-performing level. `RESEARCH_CLAIM pd_va_full_session_vs_rth_no_edge`, `OPEN_DECISION pd_va_session_window_mismatch_20260825` resolved.
    2. **OR-family pooled calibration (the direct test of "are we missing T1 hits because of stop sizing")**: pooling real trades across OR5/OR10/OR30 (same position+direction) into the real live `computeStopTargetForType()` did produce a validated stop/target for `OR_LOW_FADE_SHORT_POOLED` (N=39, EV-sweep-real, stop=24/target=40) — but bar-by-bar resimulating `OR5_LOW_FADE_SHORT`'s actual 17 historical `STOP_HIT` trades against it recovered **zero** target hits (the +$182 benefit was pure loss-size reduction, not missed-win recovery), and the pooled group itself fails its own day-clustering rigor check (66.7% of trades from 5 dates) regardless. `OR_MID_FADE_SHORT_POOLED` didn't even produce a real method. **Not wired live** — a genuine, tested negative, not a dead end. `RESEARCH_CLAIM or_family_pooled_calibration_no_recovery`.
    3. **Bottom line for the original "missing T1 hits" question, SUPERSEDED by a real, bigger finding the same session (see below)**: two independently-audited tests (Gemini build + Claude direct re-run matching exactly both times) found no evidence that either the value-area definition or family-pooled stop widening explains or fixes the stopped-out-before-target feeling from this session's opening investigation. But the user then pointed at a specific overnight example (WEEKLY_OPEN, not PD_VAH) that traced to a real, structural RTH-only wiring gap — see `OPEN_DECISION keeplevels_rth_only_no_overnight_20260825` immediately below. That is the real answer to "why are we missing trades," not a calibration-width problem.

- **`keepLevelsAll` (~25 levels, WEEKLY_OPEN included) has ZERO overnight coverage — structural, not a calibration issue (2026-08-25).** Traced from the user noticing 2 real overnight touches of WEEKLY_OPEN (29392.25, confirmed exact match to `level_prices`, ~05:47-06:31 and ~07:48-08:28 ET) produced no fire — the eventual `WEEKLY_OPEN_FADE_SHORT` fire at 9:48 AM (TARGET_HIT +$84) was also the exact trade from this session's opening chart screenshot that was originally mistaken for a PD_VAH touch (see the RESOLVED PD_VAH thread above — same trade, now correctly identified). Root cause confirmed via direct code read: `keepLevelsAll` (`server/routes/acd.js` ~line 6800, containing `WEEKLY_OPEN_FADE` plus ~24 other levels — `PD_HIGH/LOW/CLOSE`, `FLOOR_R2/R3/S2/S3`, `DAILY_OPEN`, `MONTHLY_OPEN`, `WEEKLY_VWAP`, `ONH/ONL`, `PD_SESSION_MID`, `5D_OR_MID`, `10D_IB_MID`, `PD_OR_MID`, `PD_IB_HIGH/LOW`) sits entirely inside `if (currentPrice && allRthBarsRow.rows.length >= 3)` (line 6127) — `allRthBarsRow` is TODAY's RTH-only bar count, zero all night, not ≥3 until ~9:33 AM ET. Only the small set duplicated into the separate `detectGlobexSetup()` function (`PD_VAH`/`PD_VAL`/`PD_POC`, the 8 `WIDER_WINDOW_OVERNIGHT_LEVELS`, `GLOBEX_VWAP_FADE`) has real overnight coverage — confirmed WEEKLY_OPEN and the other ~24 are absent from that function's candidates array. Real violation of the standing RTH+Globex-both-required hard rule. **SHIPPED same session**: user chose to scope to weekly/monthly/quarterly/yearly levels (dropping daily-scale and same-day-forming ones, which can't exist overnight anyway), then explicitly expanded from an initial 2-level proposal to the full 21 remaining levels. Rather than port the RTH engine's complex cluster/shared-direction/dedup mechanism (judged too risky to replicate faithfully in one pass), simplified to the existing `detectGlobexSetup()` per-level pattern already proven for `PD_VAH`/`PD_VAL`/`PD_POC` — added all 21 to `WIDER_WINDOW_OVERNIGHT_LEVELS` (`server/routes/acd.js` ~line 1302), joining the 8 already there. Full 29-level set now has real overnight coverage: `WEEKLY_OPEN`, `WEEKLY_VWAP`, `PW_VAH/VAL/POC/HIGH/LOW`, `WR1/WR2/WS1/WS2`, `MONTHLY_OPEN`, `MONTHLY_VWAP`, `PM_VAH/VAL/POC/HIGH/LOW`, `MPP/MR1/MR2/MS1/MS2`, `3M_VAL/3M_POC`, `PY_VAH/VAL/POC`. Direction per new level picked from whichever side already shows the better/less-negative real EV in that level's existing RTH THIN_N data. Verified before shipping: VARCHAR(60) width OK, syntax clean, lint clean, `test_invariants.mjs` shows only 4 pre-existing unrelated failures (zero new), live server confirmed healthy (200 OK, no new errors). Every new `_OVERNIGHT` type starts SHADOW by `getCanonicalLiveStatus()`'s fail-closed default and self-promotes only once real overnight N independently clears the normal N≥20 bar — no manual promotion done. `OPEN_DECISION keeplevels_rth_only_no_overnight_20260825` resolved.
  - **Follow-up bug found and fixed same session: `detectGlobexSetup()`'s dedup fired at most once per (trade_date, setup_type) for the ENTIRE ~15.5hr session, no re-arm ever.** Found via real bar-by-bar reconstruction of last night's actual `WEEKLY_OPEN` touches: 3 genuinely distinct touch-and-resolve episodes occurred (05:47 STOP_HIT, 05:58 TARGET_HIT +$178, 09:45 STOP_HIT) but the old dedup would only ever have caught the first, missing the +$178 winner. A naive "re-arm immediately on resolution" fix risks reproducing the 2026-08-20 RTH flooding incident (31 duplicate SHADOW rows in 33 min) — resolved via a Gemini design critique (verified against the RTH engine's real anti-flood mechanism, `recentTypeRows` ~line 7139, confirmed to be an unconditional 15-min `fired_at`-based block): the real flooding signature is a near-instant PRIOR resolution (chop at the boundary), not short elapsed time since resolution — last night's genuine re-touch resolved in a real 10 minutes despite re-arming just 1 minute later. Shipped: re-arm allowed once the prior row is resolved AND took ≥`GLOBEX_REFIRE_MIN_TRADE_DURATION_MINUTES=3` min to resolve (a dedup/plumbing parameter, not a trading threshold, matching this codebase's own precedent for the RTH engine's 15-min cluster window). Also excludes `CASCADE_BREAKER` audit rows (`resolved_at=fired_at` by construction, zero duration) via the same exclusion the RTH engine's own cluster dedup already uses — without it, a cascade-breaker row for a shared-name type like `PD_VAH_FADE_SHORT` would have permanently blocked re-arm for the rest of the day. Applies universally across all ~39 `detectGlobexSetup()` candidate types, not just the 29 from the fix above, since `PD_VAH_FADE_SHORT` (currently `ACTIVE`, real alerts) has the same real exposure to missed re-touches. Verified: syntax clean, lint clean, `test_invariants.mjs` shows the same 4 pre-existing unrelated failures, server healthy post-deploy.
  - **RESOLVED NEGATIVE, properly tested (2026-08-25) — real signal, delay too costly, decided against implementing.** User flagged waiting for the next bar to close in the fade direction (before entering) as "the fix, should be applied across the board" after a clean single-night WEEKLY_OPEN example (immediate $264 vs confirmed $356 for the night). Locked in via `OPEN_DECISION confirm_entry_leading_fix_candidate_20260825`/`_v2` before testing, per explicit user request not to lose track of it. Corroborating system-wide evidence found: 146 of 658 real losses in the last 30 days (22.2%) had `mfe_points<=2` (zero favorable movement before loss) vs 0 of 714 wins.
    - **Proper 3-arm test built** (per a Gemini design critique that caught 2 real flaws in Claude's first draft — entry-price population mismatch between arms, and conflating a proximity hypothesis with a momentum-confirmation test): `IMMEDIATE_ALL` / `IMMEDIATE_CONFIRMED` (lookahead-only diagnostic, isolates selection value) / `DELAYED_CONFIRMED` (the real tradeable rule), across all 29 levels split into 5 structural groups (TIME_OPENS/VWAP/VALUE_NODES/RANGE_EDGES/MATH_PIVOTS).
    - **A real bug in Gemini's build was found and fixed before trusting any number**: `level_prices` only has rows for 473 of 910 real trading days for these levels (they only update on period rollover) — the script's exact-date lookup silently dropped every non-checkpoint day, ~half of all touches, non-randomly. Claude fixed it (valid-until-superseded binary-search lookup, matching this codebase's real convention), roughly doubling real N (1,010→2,010 touches). The corrected, doubled dataset reproduced the SAME qualitative conclusion Gemini originally reported — not an artifact of the thin/biased half-sample.
    - **Real result**: SelectionValue (do trades that go on to confirm beat the unconditional population, same entry price) is positive in all 5 groups (+$21.83 to +$41.35/trade) — the signal is genuinely real. DelayCost (cost of the 1-bar wait, same subset) is more negative than that in all 5 groups (-$32.93 to -$56.96/trade) — net effect negative everywhere (-$9.17 to -$28.44/trade). Same shape of result as the prior POC-rotation confirmation-gate research on an unrelated setup family (`docs/OPEN_THREADS_ARCHIVE.md` 2026-08-24/25) — real signal, delay too costly, now confirmed twice on unrelated setups. Worth treating as a property of this market's 1-minute-bar timeframe generally.
    - **Not implementing the wait-for-next-bar-confirmation rule anywhere.** `RESEARCH_CLAIM globex_level_confirm_entry_signal_real_delay_too_costly` recorded. Both `OPEN_DECISION`s resolved negative.
    - **Real, unexplored idea surfaced by this result, not pursued**: since SelectionValue is real, a same-bar (no-delay) signal that captures similar selectivity without paying the wait cost might exist — worth a dedicated look before considering this thread fully closed.

- **RETRACTED same session: the "breakout-reverses-harder" finding and its live wiring were built on a real data-corruption bug (2026-08-25).** After the confirmation-entry thread closed negative, tested the opposite hypothesis — does BREAKING one of the 29 levels predict continuation, and if not, does it predict a stronger reversal than a generic breakout? Initial pretest + trade-level simulation found a striking positive (fade-the-breakout: N=1089, +$41,022, dose-response showing 74.7% WR at 2.5x+ breakout size) — live SHADOW wiring was shipped (`<LEVEL>_SWEEP_REVERSAL_LONG/SHORT_OVERNIGHT` in `detectGlobexSetup()`) plus a Home Assistant quick-check.html watch card. **A user question prompting a hand-trace of the single biggest winning trade found the whole premise was substantially fake**: raw `price_bars` has 56,566 timestamps where TWO DIFFERENT FUTURES CONTRACTS both have a row (e.g. 2024-03-07 00:00:00: NQH24 @ ~17973 and NQU24 @ ~18783, an ~810pt fake jump) — the `DISTINCT ON(ts)` deduplication used throughout the day's scripts picks an arbitrary one of the two, not necessarily front-month. This codebase already has a correct, dedicated view for exactly this problem (`price_bars_primary`, confirmed zero duplicate timestamps across the full history) that should have been used from the start instead of hand-deduplicating raw `price_bars`. An earlier same-session verification query claiming these were harmless same-contract duplicates was ITSELF buggy (a CTE/JOIN aggregation error, re-verified and confirmed wrong). Re-running the exact same simulation against `price_bars_primary`: the finding completely reverses — +$41,022 becomes -$7,672 (N drops 1089→911, real fake breakouts removed), the 2.5x+ dose-response bucket drops from 74.7% WR/rigor-PASS to 39.6% WR/rigor-FAIL. The breakeven-trail test result is also invalidated by the same root cause. `RESEARCH_CLAIM globex_sweep_reversal_retraction_data_bug` recorded (retracts both prior positive claims). **Live code was fixed to use `price_bars_primary`** (both the new `detectGlobexSetup()` query and the backtest script) — the SHADOW wiring itself is left running (zero capital risk, will honestly collect real forward data now that its data source is correct), but the premise it was built on does not hold.
  - **Real, broader, NOT YET RESOLVED concern**: this bug's root cause (raw `price_bars` having genuine multi-contract timestamp collisions, 56,566 of them across the full history, 2023-06 through present) is NOT specific to today's scripts — ANY script anywhere in this codebase that queries raw `price_bars` directly (not `price_bars_primary`) without its own front-month dedup logic could be silently affected on any of those collision timestamps. `OPEN_DECISION price_bars_raw_multicontract_collision_audit_needed` flagged to grep every script that queries raw `price_bars` and check each one's dedup handling.

- **RESOLVED 2026-08-30: `poc_rotation_thread_points_mislabeled_as_dollars` fixed across the `scripts/backtest_poc_rotation_*.mjs` family (10 fixed directly + 2 transitively via a shared import + 2 already correct = 14 total), re-verified against real re-runs, DeepSeek-audited across 2 rounds (round 3 and round 4 — round 3 crashed mid-analysis on an unrelated thread before reaching this one), and corrected again after that audit caught 2 real mistakes in the first pass.**
  - **Fix scope**: import `LIVE_INSTRUMENT`, convert ONLY at the EV/WR/rigor/`recordClaim()` aggregation layer (`dollarPnl = pnl*PPT-COMM`) — trade-simulation logic, stop/target point distances, and CSV export columns deliberately stay in raw points, unconverted. `delta20_pretrade_stop15.mjs`/`fixed_stop_mfe_sweep.mjs` needed no direct edit — both get correct dollars transitively via `import { summarize } from './backtest_poc_rotation_fixed_stop_mfe25_target.mjs'` (now commented so a future edit doesn't silently reintroduce the bug by adding a local `summarize`).
  - **Re-ran all 11 scripts that call `recordClaim()`** (`join_time60_mfe.mjs` is diagnostic-only, no claim) to refresh their `performance_audit` rows — all completed cleanly, each producing a fresh 2026-08-30 row alongside the old buggy one for direct before/after comparison. Corrections landed almost exactly where the OPEN_DECISION's own predicted formula (`realEV = 2*reportedPoints - 2`) said they would, modulo real N growth between runs.
  - **`poc_rotation_vbp_entry_delay_test` moved from +$1.19/trade (buggy) to -$0.20/trade (corrected, N=763) — DeepSeek round 4 caught that this was NOT purely the unit fix.** Under the SAME underlying data the unit fix alone would have given +$0.38 (2×1.19−2, still positive) — the rest of the move to -$0.20 came from real points-EV drift (1.19→0.90) from N growing between the original run and today's re-run (real trades resolved in the interim). Both effects are real and both are worth knowing, but they're not the same claim — corrected here after conflating them in the first write-up. Several other claims stayed same-signed but moved substantially: `join_confirm_wait_fixed` +$1.25→+$0.54/trade, `join_blind_delay_control_fixed` +$1.18→+$0.30/trade, `join_time60_trail_fixed` -$0.59→-$3.31/trade, `fixed10_mfe25_target_fixed` -$1.83→-$5.59/trade. **Also worth knowing before leaning on any of these WR figures**: DeepSeek round 4 (finding S4) pointed out WR's definition silently changed too — `dollarPnl>0` is now a NET-of-commission win (a trade netting +0.5pt but losing to the $2 commission now counts as a loss), where the old buggy WR was gross-of-commission. This is the economically correct definition, but it means the 8/24-vs-8/30 WR numbers in this thread aren't a clean apples-to-apples comparison, only the EV ones are. **The "JOIN/Stop20/Time60 established winner" pattern this thread's later scripts (confirmation-gate, scale-in) cite as settled should be re-read against these corrected numbers before being treated as a foundation for further work.**
  - **DeepSeek round 4 also caught a real methodology error in Claude's own first pass: 2 of the 6 claims written off as "orphaned, source script no longer exists" were NOT orphaned** — Claude had checked whether each slug appeared inside a `recordClaim()` call in any script (a code search), not whether the claim's actually-*stored* `notes.source_file` pointed at a real file (a data check) — the two differ whenever a claim was written by a one-off `record_claim.mjs --add` CLI call rather than a script's own `recordClaim()`. `poc_rotation_confirm_gate_isolated_selection_value`'s stored source is `join_blind_delay_control.mjs` (exists, fixed and re-run today) — its methodology (a *difference*: `join_confirm_2close.mjs`'s gated EV minus `join_blind_delay_control.mjs`'s EV at matched wait) was fully recoverable from both scripts' fresh re-run logs and has been corrected: FIXED_R65 wait2/3/5 now +$0.38/+$0.33/-$0.62 (was +$0.17/+$0.15/-$0.33), PCT wait2/3/5 now +$0.68/+$1.10/-$0.37 (was +$0.33/+$0.53/-$0.20) — same qualitative conclusion (real, positive, separable gate value at wait 2-3, negative at wait 5, still smaller than the delay's entry-timing cost) survives, only the magnitude was wrong before. `poc_rotation_scale_in_confirmation_no_real_signal`'s stored source is `join_scale_in_landmark.mjs` — one of the 2 already-dollar-correct reference scripts. Re-run directly to confirm rather than trust that inference: FIXED_R65 (N=1903) Q1(SIGNAL_STRAT)=-$1.11, permutation p=0.72; PCT (N=2253) Q1=+$0.25, permutation p=0.92 — both non-significant, same "no real signal" conclusion reconfirmed on fresh data with genuinely correct dollar math throughout (the stored EV was never buggy in the first place; the exact -$1.49 originally recorded doesn't map to a single one of this script's own output fields since it was written via a one-off CLI call rather than the script's own `recordClaim()`, but the qualitative finding is unchanged and now independently reconfirmed). **Genuine remaining orphan count: 4 claims across 3 truly-nonexistent scripts** (`join_level_confluence.mjs`, `join_level_confluence_extended.mjs`, `join_pretrigger_features.mjs` — covering `_join_onh_onl_confluence`, `_join_ws1_confluence`, `_join_leg_speed_pretrigger`, `_join_pretrigger_pressure_duration_negative`), left flagged/uncorrected since guessing their exact stop/target/population risked fabricating a number.
  - **Adjacent bugs found and fixed in the same files**: `backtest_poc_rotation_join_confirm_2close.mjs`'s `recordClaim()` cited a nonexistent `sourceFile` (`scripts/backtest_poc_rotation_join_confirm_wait.mjs` — corrected to point at itself). Separately (DeepSeek round 4, finding S2): `join_blind_delay_control.mjs` and `join_confirm_2close.mjs` had been writing to the exact SAME two output paths (`reports/poc_rotation_join_confirm_wait_trades.csv`, `scratch/..._report.json`) since the commit that created the former by copying the latter — identical headers made the two scripts' artifacts indistinguishable, and whichever ran second silently clobbered the other's data (confirmed: this destroyed `join_blind_delay_control`'s fresh 2026-08-30 output 5 minutes after it was written; only its own stdout log survived to do the correction above). Renamed `join_blind_delay_control.mjs`'s outputs to their own `..._blind_delay_control_*` paths.
  - **New standing invariant added** (`scripts/test_invariants.mjs`, DeepSeek round 4 finding S10): every `RESEARCH_CLAIM`'s stored `source_file` is now checked for existence on disk (handles multi-path/compound `source_file` strings), not just cron-scheduling — this is exactly the check that would have caught the `join_confirm_wait.mjs` typo and the 2 mis-labeled "orphans" automatically. Running it live surfaced ~15 more pre-existing orphaned-source claims elsewhere in the codebase, predating this session — not triaged, out of scope for this thread, but now visible instead of silent.
  - **Full DeepSeek code-review audit trail**: `scratch/deepseek_code_review_20260830.md` (round 1), `_round2.md` (round 2, separate Globex/wider-target session-boundary fix), `_round4.md` (round 4, this thread specifically — round 3 crashed before reaching it, but its partial transcript caught one real bug in the adjacent round-2 fix, already corrected).
  - **Full DeepSeek code-review audit trail** (dispatched per user request to review the day's uncommitted work, not specific to this thread alone): `scratch/deepseek_code_review_20260830.md` (round 1, 9 findings, all fixed same session), `scratch/deepseek_code_review_20260830_round2.md` (round 2, 13 findings on a separate Globex/wider-target session-boundary fix — see `server/services/sessionBoundary.js`), `scratch/deepseek_code_review_20260830_round4.md` (round 4, this thread specifically — 11 findings, 2 of them (S1, S5) real methodology errors in Claude's own first pass, corrected above). A partial round 3 (crashed before writing a final file, but its live transcript caught one real bug in the round-2 fix — `nextTradingDay()`-vs-naive-date-arithmetic for a Friday/holiday dead-zone fire, already corrected) never reached this thread's own review — round 4 covered it separately.

- **RESOLVED 2026-08-31: `price_bars_primary_systemic_quarterly_data_gap` — root cause fully confirmed and a standing gap-guard shipped.** `price_bars_dedup_hist` (the historical branch `price_bars_primary`'s view unions in — effectively ALL historical data, since the view's other, calendar-JOIN branch only ever covers `ts` after `dedup_hist`'s own `max(ts)`, always very recent) has 6 real, permanent, unrecoverable gaps of ~63-70 days each, one at every NQ quarterly contract rollover from Dec2023 through Mar2025 inclusive: `2023-12-14→2024-02-15`, `2024-03-14→2024-05-23`, `2024-06-20→2024-08-22`, `2024-09-19→2024-11-21`, `2024-12-19→2025-02-20`, `2025-03-20→2025-05-22`.
  - **Mechanism, confirmed bar-by-bar at every boundary via the `contract` column**: the OLD front-month contract's data stops dead exactly at its own 3rd-Friday expiration (a partial final day, e.g. `NQU24`'s last real day is 2024-09-20), and the NEW contract's data doesn't begin until ~2 months later (also a partial first day, e.g. `NQZ24` starts 2024-11-21) — consistent with a chart/feed being manually re-pointed to each new front-month contract roughly one full rollover cycle late, for 6 consecutive quarters running, before whatever process fixed it (no gaps of this kind found after 2025-05-22).
  - **Fix shipped**: `server/services/queries.js` gained `findTradingDayGaps()`/`assertNoTradingDayGaps()` — shared helpers for any script building a positionally-indexed trading-day array to call before treating `dates[i+1]` as "the next trading day." Retrofitted into the 2 scripts whose audits originally surfaced this bug: `scripts/backtest_turn_of_month_effect.mjs` (also migrated off its own raw `pg.Client` with hardcoded credentials onto `server/db.js` — a real DeepSeek round-3 finding, fixed in the same pass, which also surfaced a real breakage: `server/db.js` globally overrides `pg`'s `date` type parser to return a plain string rather than a `Date` object, process-wide — a raw `pg.Client` elsewhere in the same process silently inherits that override the moment anything imports `server/db.js`, which is exactly what broke this script's own `.toISOString()` calls mid-fix) and `scripts/backtest_range_boundary_rejection_traversal.mjs`. Both now skip any event/window whose index range would straddle a real gap rather than silently computing a corrupted one — verified: turn-of-month runs clean end-to-end (N=21 events); range-boundary-rejection's gap-detection and skip logic confirmed executing correctly (its own full run is genuinely long — DB query per date across years of history — not completed in-session, but the fix itself is verified working).
  - **Not yet done**: a grep for the same `dates[i-1]`/`dates[i+1]` positional-indexing pattern found 4 more scripts with the same exposure (`backtest_poc_convergence_and_drift.mjs`, `backtest_or5_low_gap_down.mjs`, `mine_or_conditional_fade.mjs`, `backtest_unified.js`) — none audited or fixed yet. All are one-off research scripts (not live-wired), so this doesn't block resolving the main decision, but it's real — tracked as `OPEN_DECISION audit_remaining_positional_dategap_scripts_20260831`.
  - **Separate, smaller, NOT-yet-root-caused finding surfaced while investigating this**: a ~2-month window of THIN (not absent) data around the 2025-09 rollover — `contract=NQH26` (an unusually far-dated contract for the time) appears 2025-09-28 with chronically low bar counts (~20-340/day vs the normal ~1380), and `NQZ25` (the contract that actually should have been current) shows up afterward, 2025-11-19 through 2025-12-12, an inverted sequence. Bar counts return to normal by 2025-12-01. A genuinely different symptom (present-but-sparse, not absent) from the 6 root-caused gaps above — tracked separately as `OPEN_DECISION price_bars_nqh26_contract_thin_and_early_20260928`.

- **FIXED 2026-08-31: `detectGlobexSetup()`'s main INSERT never set `wider_target_mult`/`runner_trail_width`/`extend_target_level` at all — every setup_type firing through the entire overnight/Globex level-fade engine (~30+ types: the original `PD_VAH_FADE_SHORT`/`PD_VAL_FADE_LONG`/`PD_POC_FADE_SHORT`/`PD_POC_FADE_LONG` plus every `WIDER_WINDOW_OVERNIGHT_LEVELS` type) has never been eligible for either exit mechanism, full stop.** User caught this directly from the `quick-check.html` mobile view — 3 real overnight fires (`PD_VAL_FADE_LONG`/`PD_POC_FADE_LONG` x2) hit T1 in 3-14 bars, well within the wider-target mechanism's `MAX_BARS_TO_T1_FOR_WIDER=4` arming window, but resolved as plain fixed-target trades with `wider_target_mult`/`runner_trail_width` both `NULL` and asked why. **Not the same bug as tonight's earlier session-boundary fix** (`server/services/sessionBoundary.js` — that one fixed the mechanism's INTERNAL session-end check for candidates that DO get `wider_target_mult` set; this is a structurally different gap — the column was never in this INSERT's column list at all, so the mechanism never had a chance to try). Same bug CLASS as the already-documented `backfill_wider_target_4th_site_miss_20260818.mjs` incident (a different insert site missing the same column) and the RTH audit-only insert branch's identical fix (`~acd.js:8028`, 2026-08-18) — mirrors that exact lookup pattern (`CONDITIONAL_VARIANTS[type].trailSignalName` → `BREAKEVEN_TRAIL_TEST` calibration if trail-diverted, else `WIDER_TARGET_MULT`) rather than re-deriving it.
  - **Verified before and after**: confirmed live via direct query that all 3 of tonight's real fires (plus the day's other 3 overnight fires) had `wider_target_mult`/`runner_trail_width` both null. Fix applied to `detectGlobexSetup()`'s INSERT (`server/routes/acd.js` ~1896), lint+syntax clean, server restarted (`./restart.sh`) to deploy — confirmed the new process is live (started 2026-08-31 07:42 ET, port 3002 responding 200, `/api/acd/setup-detection` returning valid JSON, no new server errors).
  - **`PD_VAL_FADE_LONG` is now fully fixed** — it has no `CONDITIONAL_VARIANTS` trail entry, so it will get `wider_target_mult=1.5` on every future fire going forward. **`PD_POC_FADE_LONG` is fixed at the code level but still blocked by a separate, already-known gap**: it IS a trail-diverted type (`PD_POC_FADE_LONG_TRAIL`, `trailSignalName='B_PD_POC_FADE_LONG'`), but `BREAKEVEN_TRAIL_TEST` has no calibration row for `B_PD_POC_FADE_LONG` at all (confirmed via direct query — `B_PD_POC_FADE_SHORT` has one, `trail=19.3` from 2026-08-25; `B_PD_POC_FADE_LONG` has none), so `runner_trail_width` will keep coming back null until `scripts/backtest_breakeven_trail.mjs` actually produces that row — this matches the session-start hook's own standing `INVARIANT_WARN` for this exact signal_name, not a new gap. Once that calibration exists, this insert site will pick it up automatically with no further code change.
  - **Follow-up audit, same night, user-requested ("check if other setups won't widen")**: checked all 22 distinct real setup_types that have ever fired via this insert site (`bet_class='GLOBEX_LEVEL'`). **None of their raw type strings match a `CONDITIONAL_VARIANTS` key directly** — every one is inserted under its base name, never diverted — so with the shipped fix, **all 22 now get `wider_target_mult` set unconditionally**; nothing else is silently excluded the way `PD_VAL_FADE_LONG`/`PD_POC_FADE_LONG` were. Full list: `10D_IB_MID_FADE_SHORT_OVERNIGHT`, `3M_POC/VAL_FADE_SHORT_OVERNIGHT`, `GLOBEX_VWAP_FADE_LONG/SHORT`, `GLOBEX_VWAP_MAGNET_LONG/SHORT`, `MONTHLY_VWAP_FADE_SHORT_OVERNIGHT`, `MPP_FADE_SHORT_OVERNIGHT`, `PD_POC_FADE_LONG/SHORT`, `PD_VAH_FADE_SHORT`, `PD_VAL_FADE_LONG`, `PM_POC_FADE_SHORT_OVERNIGHT`, `PW_LOW/POC/VAH/VAL_FADE_*_OVERNIGHT`, `WEEKLY_OPEN/VWAP_FADE_SHORT_OVERNIGHT`, `WR1_FADE_SHORT_OVERNIGHT`, `WS1_FADE_SHORT_OVERNIGHT`.
  - **New, deeper finding surfaced by that same check**: `detectGlobexSetup()` never calls `resolveSetupType()` (confirmed — that function is a local closure defined entirely inside the separate RTH engine, ~acd.js:7270, and none of its call sites are within `detectGlobexSetup()`'s ~1493-1963 span). This means a Globex touch of `PD_POC_FADE_LONG`/`PD_POC_FADE_SHORT` is **never** diverted to the `_TRAIL` breakeven mechanism the way an RTH touch of the identical level is — it's structurally invisible to `test_invariants.mjs` check [21] and the whole `CONDITIONAL_VARIANTS` trail-health monitoring (which only ever queries `setup_type=X_TRAIL`), and with this fix it'll now default to wider-target instead. Not obviously wrong — could be a deliberate session-specific choice nobody made deliberately — flagged as `OPEN_DECISION globex_trail_diversion_never_applied_20260831` (MEDIUM) rather than silently picking one behavior.

- **`test_invariants.mjs` circuit-breaker/vol-bucket failures investigated (2026-08-31) — one real fix, six confirmed working-as-intended.**
  - **Fixed a real false-positive**: check [check "vol_bucket_at_fire re-derivation"] sampled the CURRENT trade_date, which isn't a genuine determinism test — `getVolBucketAtFire()`'s rolling window keeps reading new bars as the current session progresses, so re-deriving TODAY's own bucket later the same day can legitimately land in a different bucket purely from more of today's own data accumulating. Confirmed live: the sole mismatch this check has ever produced was `trade_date=today` (stored `ABOVE_AVG`, fresh `AVG`, re-derived hours later same session) — not a historical `price_bars_primary` correction, the check's own anticipated failure mode. Now excludes `trade_date < CURRENT_DATE` from the sample; failure count dropped from 7 to 6 as a direct result.
  - **The remaining 6 (`GLOBEX_VWAP_FADE_SHORT`, `IB_BULLISH`, `OR5_LOW_FADE_SHORT`, `PD_POC_FADE_LONG`, `PD_VAH_FADE_SHORT`, `RTH_VWAP_FADE_LONG`) are NOT new bugs.** Traced `IB_BULLISH`'s full `OPTIMAL_STOP` notes directly: real N=60 behind its frozen stop/target, but 89.2% of that N comes from just 8 distinct trading days — this is EXACTLY the already-diagnosed-and-resolved `optstop_sweep_implausible_rr_thin_samples` (RESOLVED 2026-08-30, the session before this one): the circuit breaker is correctly refusing to let a day-clustered, noisy real-data recalibration attempt swing the live stop/target by more than 35%, protecting the older, more broadly-sampled frozen values. That resolution already shipped both a data-derived plausibility gate (`PLAUSIBLE_SKEW_CUTOFF` in `update_optimal_stops.mjs`, reviewed as part of tonight's earlier DeepSeek rounds) and the standing "OPTIMAL_STOP CLUSTERING WATCH" session-start-hook section that surfaces exactly this pattern every session — and explicitly left the "keep `IB_BULLISH` live vs. demote it given the clustering" call to the user, not something to decide unilaterally. Nothing further to fix here; re-verified the diagnosis still holds rather than assuming the prior session's finding is still accurate (per this codebase's own "pre-compaction claims aren't evidence" rule).

- **RESOLVED 2026-08-31: `engagement_entry_timing_backfill_contam` (HIGH) — re-audited, and the corrected result is a materially different headline, not just a magnitude fix.** `scripts/backtest_engagement_confirmation_entry.mjs` (does the user's "wait for the tussle to resolve" idea beat immediate entry) had no `origin_status` filter at all — same unfiltered-population bug already caught once in its sibling study (`backtest_coarser_bar_entry_alignment.mjs`, whose own audit flagged this decision). Fixed to match the sibling's exact filter (`origin_status IN (ACTIVE,SHADOW)`, dynamic-exit-mechanism rows excluded) and re-ran: population dropped **10,881 → 1,501 real touches** (17,259 BACKFILL/UNKNOWN + 1,421 dynamic-exit rows excluded — confirms the ~83% BACKFILL estimate was accurate).
  - **The original study's own headline flips.** Original (contaminated): immediate entry (Arm A) roughly tied with or beat blind mechanical delay (Arm B) in all 3 pooled views ($0.95 vs $0.69 ALL; $1.53 vs -$0.35 CONFLUENCE; $0.62-0.65 vs $1.26-1.28 NON-CONFLUENCE). Corrected (real-only): Arm A is **negative** in ALL and NON-CONFLUENCE (-$0.84, -$1.20 — was positive), and Arm B **clearly dominates** Arm A in all 3 views, including a sign flip in CONFLUENCE (-$0.35 → **+$14.57/trade**).
  - **What stayed the same**: the real-time engagement triggers (C1/C2) still don't beat blind delay in any view, and the per-setup_type replication check still fails exactly as before (`replicates=false` both arms, both on train-selected subsets that don't hold up out-of-sample).
  - **Real caveat, not swept under the rug**: the ALL/NON-CONFLUENCE pooled views still don't clear this codebase's own rigor-clean bar even on the corrected data (`clustered=false` but `clean=false` — fails the 3-way chronological stability check). Only the CONFLUENCE view's A/B arms are rigor-clean — that's the single most trustworthy piece of this correction, not the headline ALL-pool numbers.
  - `RESEARCH_CLAIM engagement_confirmation_entry_timing` updated in place with full before/after numbers (status kept `PROVISIONAL` — real N, not yet rigor-stable, worth another look as real data grows rather than acted on today).

- **DeepSeek code review round 5 (2026-08-31)** audited all three fixes above (`scratch/deepseek_code_review_20260831_round5.md`) — confirmed everything correct with no new bugs, plus a few real, cheap fixes applied same session:
  - **Confirmed the `detectGlobexSetup()` INSERT's parameter renumbering has no off-by-one** (hand-recounted the full column list against the VALUES array) and **independently confirmed via code trace (not just the observed DB outcome) that `CONDITIONAL_VARIANTS[c.type]` is structurally dead** for the trail half — `detectGlobexSetup()` never calls `resolveSetupType()`, so no Globex candidate type can ever match a `CONDITIONAL_VARIANTS` key (which is keyed by `_TRAIL` names, not base types). This is the exact code-level confirmation `OPEN_DECISION globex_trail_diversion_never_applied_20260831` needed. **Fixed the misleading comment** at the insert site (previously claimed to "mirror" the RTH branch's working trail lookup — corrected to explain it's currently non-functional for that half and point at the open decision, so a future reader doesn't mistake it for live).
  - **Confirmed the gap-fix work (`findTradingDayGaps`/`assertNoTradingDayGaps` and both retrofitted scripts) has correct date-diff math and full window coverage**, no missed sites. **Found one real, worth-fixing gap**: `findTradingDayGaps` is a pure function but the *module* it lives in (`server/services/queries.js`) transitively imports `server/db.js`, whose module-load-time `pg.types.setTypeParser()` call is a process-wide mutation — importing the "pure" helper is not actually side-effect-free for a caller using its own raw `pg.Client` (this is exactly what broke `backtest_turn_of_month_effect.mjs` mid-session). Added an explicit warning docstring on the export rather than doing a full db-free-module split (real refactor, left as a documented tradeoff, not urgent since the one caller this bit has already been migrated onto `query()`). Also added a fail-loud guard for a malformed-date-string producing a silent `NaN`-never-flagged gap (no current caller triggers this, defensive only).
  - **Confirmed `backtest_engagement_confirmation_entry.mjs`'s new filter is a faithful field-for-field copy of its sibling** (no population divergence), but flagged that its header comment still asserted the OLD, pre-fix conclusion — **fixed**, now states the corrected headline and 3 real caveats on trusting the flipped numbers at face value: `waitWindow` (the Arm B/C trigger-scan horizon) is derived from a resolved-outcome statistic rather than a fully independent constant (pre-existing, not introduced by the origin_status fix); per-setup-type fallbacks (`bDelay=-1`, `volRatioP50=1.0`) fire more often now that real N dropped ~7x, changing Arm B/C2's composition in a way that isn't a clean "same test, smaller N"; and the replication gate now clears far fewer setup_types, weakening that check's own verdict independent of the headline flip. None of this invalidates the correction itself — it's why the claim stays `PROVISIONAL`.

- **RESOLVED 2026-08-31: `audit_remaining_positional_dategap_scripts_20260831` — all 4 remaining scripts patched with the same gap-guard pattern.**
  - `scripts/backtest_poc_convergence_and_drift.mjs` (Parts A+B, forward-return horizons) — re-ran end-to-end: both parts were already `REJECTED` before the fix and remain `REJECTED` after (kill criteria still trip) — no headline change, now correctly computed. Surfaced an 8th, very recent, much smaller gap (`2026-08-13→2026-08-19`, 6 days) not previously tracked — not investigated, likely unrelated to the historical contract-rollover mechanism given its size and recency.
  - `scripts/backtest_or5_low_gap_down.mjs` (the most exposed per the original flag — live-wired to `OR5_LOW_FADE_LONG_GAP_DOWN`'s SHADOW-only calibration) — re-ran: N moved 147→151 (aligned) / 194→193 (against), EV moved more than the small N-shift alone would suggest ($7.77→$14.86 / -$2.08→+$8.39). Plausibly mostly real data growth over the 13 days since the original 2026-08-18 calibration rather than purely this fix — not fully isolated, and not urgent to isolate since the recommendation stays `THIN_N` regardless either way (hardcoded by design, not data-driven — zero live behavior change).
  - `scripts/mine_or_conditional_fade.mjs` (the source mining script behind the calibration above) — same fix applied for consistency/future re-runs; not re-run this session (one-off dated-CSV output, not part of a recurring pipeline).
  - `scripts/backtest_unified.js`'s `buildTwoDayPOC()` — fixed for correctness; feeds `PD2_VAH`/`PD2_VAL`/`2D_POC`, already confirmed no real edge (2026-07-17) independent of this fix. Not re-run (large whole-roster backtest, downstream signal already known-dead).
  - All 4 lint/syntax clean; `test_invariants.mjs` unchanged (same 6 pre-existing circuit-breaker failures).

- **`price_bars_nqh26_contract_thin_and_early_20260928` root-caused (2026-08-31) — the original framing was wrong, and the real shape of the problem is more dangerous than a calendar gap, not less.** NQH26 (Mar2026)'s thin, early data turns out to be genuine, real market activity for a legitimate far-dated background contract — not the anomaly. **The real gap is in `NQZ25` (Dec2025, the contract that should have been front-month for essentially the whole `2025-09-20`–`2025-12-19` window)**: it only has real (confirmed genuine front-month volume, 400k-990k/day) data in `price_bars_dedup_hist` for `2025-11-19`–`2025-12-12` — missing its own first ~2 months and final ~week entirely. During those missing windows the table has ONLY `NQH26`'s thin (~1-2% of real volume) data for the same calendar dates.
  - **This does NOT show up as a calendar-date gap** — `findTradingDayGaps()` wouldn't flag it, since every date in the window has *some* row. That makes it a materially more dangerous failure mode than the 6 main gaps (which are at least obviously empty): any volume/liquidity-sensitive computation (rolling volume baselines, ATR-by-volume, the volume-building signal, order-flow imbalance) touching `2025-09-20`–`2025-11-18` is silently reading the wrong, ~1-2%-of-real-volume contract without any structural signal that something's off.
  - **Not resolved** — this needs a scope/handling decision, not just documentation: whether to build a separate volume-analysis exclusion guard for this window (distinct from the calendar-gap guard, since dates aren't missing here), whether the real `NQZ25` volume data is recoverable from another source, and how many existing scripts/live features already touch this window's volume data unknowingly. `OPEN_DECISION` updated in place with the corrected root cause, left `PENDING`.

- **RESOLVED 2026-08-31: `globex_trail_diversion_never_applied_20260831` — user decided Globex touches of `PD_POC_FADE_LONG`/`SHORT` should divert to the breakeven-trail mechanism too, matching RTH.** Added `resolveUnconditionalTrailVariant(rawType)` to `server/config/setupTypes.js` — derived from `CONDITIONAL_VARIANTS`'s own `baseType` field (a reverse map built once, filtering to `unconditional`-condition entries) rather than hand-copying the RTH engine's 7-line if-chain a second time, which is exactly the mistake that caused this whole thread. `detectGlobexSetup()` now resolves `c.type` through it before the `CONDITIONAL_VARIANTS` lookup that determines `runner_trail_width`/`wider_target_mult`.
  - **Deliberately scoped narrow for safety**: the row's own stored `setup_type` stays the raw base name (`PD_POC_FADE_LONG`), NOT renamed to the `_TRAIL` suffix RTH uses — only the trail-calibration *lookup* uses the resolved name. Renaming the stored value to match RTH would also require updating the re-arm dedup check and the live-status check (both key off `setup_type`), which touches real live-firing behavior and was judged out of scope for tonight.
  - **Concrete effect**: `PD_POC_FADE_SHORT` (which already has a real, validated calibration — real N=21, trail=19.3pt, OOS EV +$30.31 vs -$2.31 fixed-target baseline) now gets that real benefit on Globex fires too, not just RTH. `PD_POC_FADE_LONG` has no calibration yet, so it correctly falls back to wider-target automatically — same safe-default behavior as before.
  - **Known remaining gap, not fixed here**: Globex fires of these 2 types are still invisible to `test_invariants.mjs` check [21] and the `CONDITIONAL_VARIANTS` trail-health monitoring generally (both filter by `setup_type=X_TRAIL`) — a smaller, not-yet-flagged follow-up if full parity with RTH's monitoring is ever wanted.
  - Verified: `resolveUnconditionalTrailVariant()` unit-tested inline against known base types, lint/syntax clean, `test_invariants.mjs` unchanged, server restarted and confirmed live (new process, no new errors).

- **`quick-check.html` wider-target UI simplified (2026-08-31, direct user request), with one real bug caught by the user in the process.** Removed the per-trade "Wider-target check: could not verify..." counterfactual modal box (`loadWiderTargetCounterfactual()`, `WT_NORMAL_REASONS`/`WT_ABNORMAL_NOTE`, the `#wt-counterfactual` element/CSS) and the aggregate "Wider-target research/live" session-timeline banner (`#research-note`, `loadResearchNote()`/`renderResearchNote()`) — both replaced with a single compact **`Tx1.5`** row tag, matching the existing `Vol++`/`Vol+` visual pattern.
  - **First version was wrong, caught live by the user twice on the same real trade** (id 109447, `GLOBEX_VWAP_FADE_LONG`, fired 08:27 AM, resolved 9 bars later at 08:36 AM as `WIDER_TARGET_HIT`). v1 gated the tag on `wider_target_mult != null`, which only means the mechanism was ARMED at insert — every trade routed into that branch gets a non-null value regardless of outcome, so a trade that reached T1 too slowly to actually qualify still showed the tag. Fixed to gate on `resolution_method` starting `WIDER_` (the field that reflects the mechanism actually engaging, per `stepWiderTarget()`'s own state machine).
  - **Second flag on the same trade was NOT a bug** — traced it against real bars: T1 was genuinely reached in 2 bars (well inside the 4-bar `MAX_BARS_TO_T1_FOR_WIDER` eligibility window), correctly arming the extension; it then rode 7 more bars before the wider target itself printed, making `bars_to_resolution=9` a correct total-including-the-extension-phase figure, not a violation of the 4-bar rule. `bars_to_resolution` conflates "bars to original T1" (the actual eligibility check) with "bars to final resolution" once this mechanism engages — the tag's tooltip now says this explicitly so it doesn't keep reading as a bug.
  - **Max DD stat added to the Session Timeline stats row** (Wins/Losses/Net/Gross/Comm), reusing `computeRangeStats()` for the shared fields. After user clarification this is deliberately NOT the cumulative peak-to-trough figure already shown in the Performance section — it's the worst single-trade MAE (in dollars) among today's trades, scaled by that trade's own `size_multiplier` (the system's live sizing recommendation at fire time, baseline 1.0x) per a further user request to reflect "actual risk," not a flat 1-contract assumption. Deliberately NOT scaled by `trades.quantity` (the real broker-fill table) — no established, validated join from an `active_setups` row to a specific real trade's contract count exists, and CLAUDE.md's own collaboration rule bars conflating that table with the signal-firing engine without one.
  - Verified via a real Playwright check (not just `node --check`/`curl`) per the frontend hard rule: page loads clean, zero console/page errors, `#research-note` fully removed, `Tx1.5` tag renders with the corrected count, modal opens with no leftover `wt-counterfactual` element.

- **Five quick LOW/MEDIUM `OPEN_DECISION` items cleared in one pass (2026-08-31), picked specifically for being tractable without new backtests/mining (unlike most of the ~58-item backlog, which is blocked on N<20 or needs fresh research).**
  - **`remove_cascade_diag_after_confirmed`** — NOT resolved, re-checked and re-flagged with fresh evidence. Re-audited the full `scratch/cascade_diag.log` (5891 lines, 2026-08-12 through 2026-08-28 — quiet since because its logging is gated behind `cascadeBreaker.active`, not a bug). Still only 2 total multi-candidate `candidates-stage` lines in 16 days of instrumentation, and in both the winner was the first-listed candidate — the fallback-picks-a-non-obvious-candidate case this decision exists to observe has still never happened. Do not remove the 4 diagnostic checkpoints yet.
  - **`optstop_notes_malformed_json_concatenation`** — RESOLVED. No code in the current codebase or git history produces the concatenation bug (a one-time manual `noiseFloorRevert` annotation, most likely via the untracked `fix.js`/`patch.cjs`/`patch.js` scratch files present earlier this session, since cleaned up). Confirmed all 146 `OPTIMAL_STOP` signal_names' *current* rows are clean JSON — no live consumer was ever at risk. Repaired the one orphaned historical row (`FLOOR_R1_FADE_LONG`, `run_date=2026-08-07`) by merging the two concatenated objects properly.
  - **`wider_target_pressure_gate_fails_open_on_null_reading`** — RESOLVED, the recommended fix applied. `stepWiderTarget()`'s pressure gate now fails CLOSED on a missing reading (banks instead of silently arming) once a real calibrated threshold exists; the no-threshold-supplied case is unchanged. Added synthetic test T21; full suite 42/42.
  - **`confluence_levels_naming_canonicalization_4_sites`** — RESOLVED. Canonical form is `'VWAP'` for RTH developing (not `'RTH_VWAP'` — matches `backtest_confluence.js`'s own `availableLevels.VWAP` key), `'GLOBEX_VWAP'`/`levelBase` generally for Globex. New shared `canonicalConfluenceLevelName()` helper used at both RTH sites; Globex `detectGlobexSetup()` switched from human-readable `.name` strings to the already-existing `.levelBase` field (already used for confluence pair-matching a few lines up). Confirmed zero live consequence — `backtest_confluence.js` doesn't read this column at all.
  - **`breakeven_trail_backfill_path_latent_width_gap`** — RESOLVED. Added the missing `runner_trail_width` lookup (3rd copy of the pattern used at the other 2 insert sites) to the early-touch backfill INSERT path. Confirmed still purely defensive/latent — all 6 live `_TRAIL` variants remain `THIN_N` in `SETUP_STATUS` (per `breakeven_trail_zero_real_survivors_20260816`), so this path never actually fires a `_TRAIL` type yet; closes the gap for whenever one is eventually promoted.
  - All 5: lint/syntax clean, `test_invariants.mjs` shows the same pre-existing 6 circuit-breaker failures as baseline (no regressions), server restarted and confirmed live after each code change.



- **A second batch of 5 backlog items cleared (2026-08-31)**, same "tractable without new backtests/mining" selection as the earlier 5-item pass this session.
  - **`price_bars_multicontract_collision_audit`** — RESOLVED. Grepped every script/service referencing raw `price_bars` without `price_bars_primary`; found 3 genuinely vulnerable, currently-live/scheduled consumers (`server/routes/playbook.js` x3 sites, `scripts/derive_day_types.js`, `scripts/daily_coaching.js` x2 sites) and switched all to `price_bars_primary`. Verified near-identical query timing (489ms vs 465ms), no regression. Remaining research-only scripts (`runner_leg_backtest.mjs`, `replay_all_setups.js`, `combo_backtest.js`, `volatility_predictive_backtest.mjs`, `backtest_wpp_short_gap.mjs`) documented but not fixed — lower priority, not live/scheduled.
  - **`optimal_stop_circuit_breaker_n_count_unreconciled_drop`** — RESOLVED, bookkeeping only. Already fixed by Opus Audit 9 (2026-08-19/20, a circuit-breaker baseline-ratchet bug) — the code's own comment explicitly names this decision as resolved; the tracker entry was just never closed.
  - **`nodemon_child_orphan_silent_stale_serving`** — RESOLVED. Added a check to `.claude/hooks/session-start.sh`: whenever exactly one nodemon supervisor is alive, verifies the actual port-3002 holder's real PPID matches it, flagging loudly on mismatch (the exact silent failure found live 2026-08-25 — nodemon alive, port healthy, but no longer supervising the real process). Scoped to the ===1 case only to avoid noise on top of the existing 2+ duplicate-supervisor check.
  - **`compute_levels_11am_cron_overwrites_full_session_levels`** — RESOLVED. Added an optional `--category=X` flag to `scripts/compute_levels.js` (additive, every other caller unaffected); the 11am ET post-IB cron now passes `--category=CURRENT` so it only re-upserts OR/IB levels instead of also overwriting `RTH_VWAP` with a partial-session average.
  - **`app_jsx_dead_casesetupmap_regularevents_code`** — RESOLVED, mixed. The dead-code deletion itself was already done in earlier work this week (confirmed via the code's own dated comment). The genuine open question it left behind — should timeline enrichment (bar6_checkpoint/historical_win_rate/delta-confirmation) scope to only the 12 true case-engine types, or stay unconditional for every setup — was put to the user directly. **Decision: leave it unconditional** (scoping would have hidden this context from IB_BULLISH/BEARISH and the entire fade roster, the setups actually watched most).
  - Two of the five (circuit breaker, dead App.jsx code) turned out to already be fixed by other work earlier this week — the tracker just hadn't been updated. Verified each against live code before acting, not assumed from the flag text, per direct user instruction mid-session not to blindly reapply a stale fix over newer work.
  - All code changes: syntax/lint clean, `test_invariants.mjs` shows the same 6 pre-existing circuit-breaker failures as baseline (unrelated, confirmed predating this session), server restarted and confirmed healthy after each change.

- **A third batch of 5 backlog items checked (2026-08-31)**, same session as the two earlier 5-item passes.
  - **`selected_over_starvation_recheck_at_n20`** — still PENDING, correctly left open. Real N grew from 2 (8/18) to 10, still below the N>=20 floor this decision itself requires before drawing a conclusion. Directionally, every one of the 10 rows shows IB_BULLISH/BEARISH being the type passed over, never the reverse — consistent with the original starvation concern but too thin to call real yet.
  - **`ai_setup_review_needs_validation_check_at_n20`** — still PENDING. Max real N is 5 (PD_VAH_FADE_SHORT), nowhere near the N>=20 trigger.
  - **`value_area_measurement_layer_first_look`** — RESOLVED, checked 2 days ahead of the 2026-09-02 self-imposed checkpoint. Real N across all 7 lookback windows ranges 32-1343 (comfortably above thin). Honest result: value-area position (Edge vs Mid) shows no meaningful, consistent differentiation in outcome at ANY lookback — avg_pnl -$1.70 to -$7.77 for both labels, win rates flat 46.5-51.5% regardless. A genuine, decisive negative, recorded as `RESEARCH_CLAIM value_area_regime_position_first_look_no_differentiation` (CONFIRMED). The tagging itself stays live (zero cost, self-populating) — this closes the "don't let it run forgotten" checkpoint, not the mechanism.
  - **`pd_poc_fade_short_capital_exposure_override_revisit`** — RESOLVED. All 3 stated conditions genuinely cleared (see commit `4bd4db8`): real WR beats break-even for 3 consecutive runs (not just the required 2), real_n 42-44 each time, no longer circuit-breaker-deadlocked. Put to the user directly since it's a live-capital-affecting change — confirmed, override removed. `PD_POC_FADE_SHORT` returns to normal SETUP_STATUS-driven eligibility.
  - **`backfill_time_expired_null_resolved_at_329_rows`** — investigated, repair deliberately deferred. Confirmed worse than the original sample suggested (263/329 rows, 80%, show an impossible `resolution_bar_time < fired_at` ordering — the original sample found 3/5, 60%). The offsets are irregular (31-47 minutes), NOT the clean 4-5-hour DST-shift signature that matches this codebase's already-documented naive-timestamp bug elsewhere — a different, not-yet-identified cause. Deferred building a dedicated repair script given confirmed zero real-capital impact (100% synthetic BACKFILL data, `actual_pnl` already correctly 0).
  - 2 of 5 genuinely couldn't be resolved yet (both correctly left PENDING, not forced) — this batch is a mix of real closures and honest "not yet" answers, not a clean 5-for-5, matching the project's own no-fabrication standard.

- **A fourth batch of 5 backlog items checked (2026-08-31)**, same session, same "verify current state, no fabrication" discipline.
  - **`touchqualitytest_pace_window_off_by_one_affects_live_sizing`** — RESOLVED, user-confirmed. `_tqBars` was a 10-bar slice (9-interval span) z-scored against a genuine 10-interval baseline — fixed to an 11-bar slice so the span matches what was actually validated.
  - **`lf_session_delta_partial_vs_fullday_percentile_mismatch`** — RESOLVED, user-confirmed. Re-read the original 2026-07-08 backtest: it validated partial-day cumulative delta on both sides (self-consistent). Live's threshold was a flat full-day sum percentile instead — a different, unvalidated simplification, explaining why the factor almost never fired "high" (1/704) and almost always fired "neutral" (609/704). Rebuilt the threshold as a pooled percentile of the running cumulative delta sampled at every minute of every historical session, matching the original's implicit sampling.
  - **`rth_active_construction_stopped_20260803`** — RESOLVED 2026-09-01 as MOOT. A third zero-real-ACTIVE-fire day was found (2026-08-18) and left genuinely unexplained at the time this batch note was written. Superseded later the same session (2026-08-31, 18:19 ET, commit `c0f62d1`): IB_BULLISH/IB_BEARISH were suppressed outright, user-confirmed, after the full redesign audit came back negative. Both now permanently `recommendation=SUPPRESS` — the "why didn't IB fire" question this decision tracked no longer applies since there's no ACTIVE-eligible state left to investigate. Verified live 2026-09-01: zero ACTIVE fires of either type since the suppression deployed.
  - **`unbounded_price_bars_primary_4_weekly_scripts`** — RESOLVED, no code change. Confirmed none of the 4 scripts can be safely bounded without risking truncation of data they genuinely need (one needs a full trading-day index for lookback correctness, the other 3 need multi-year history by design). Matches this decision's own original caution against picking an arbitrary bound.
  - **`globex_ambiguous_names_need_session_backfill`** — RESOLVED. Backfilled 84 historical rows (of 4 setup_types sharing names across the RTH/Globex engines) from `VALUE_FADE` to `GLOBEX_LEVEL` based on real fired_at time-of-day, backed up per `DB_MIGRATION_PROTOCOL.md`, re-ran both dependent bet_class resweeps with the corrected population (`GLOBEX_LEVEL` N grew from 227 to ~560, verdict `SHIP_FLAT`; `VALUE_FADE` verdict `SHIP_CALIBRATED`).
  - 4 of 5 resolved; 1 correctly left open with new diagnostic progress rather than a forced answer.

- **A fifth batch of backlog items checked (2026-08-31)**, plus one standing test_invariants.mjs failure that had never been individually investigated.
  - **6 circuit-breaker-tripped setup_types** (not a formal OPEN_DECISION, a standing daily FAIL nobody had reviewed per-type) — individually reviewed. 5 correctly held (real-to-real recalibration with unconvincing EV improvement on thin/large swings, or the breaker correctly blocking a downgrade attempt). `OR5_LOW_FADE_SHORT` was the real judgment call: attempted move would have flipped a favorable ~1:1.9 risk:reward into an unfavorable ~2:1 one — user confirmed leave frozen despite the positive point-estimate EV, since that EV almost certainly reflects a compensating high win rate rather than a real edge. Recorded as `RESEARCH_CLAIM circuit_breaker_6_tripped_types_reviewed_20260831`.
  - **`price_bars_nqh26_contract_thin_and_early_20260928`** — partially resolved. Added `overlapsThinVolumeWindow()`/`THIN_VOLUME_WINDOWS` to `queries.js` (companion to the existing gap-guard). Identified the 3 highest-risk consumers (full-history + volume-using backtest scripts) but a full audit of all ~20 candidate files remains open — left PENDING.
  - **`do_not_ingest_tick_depth_into_postgres`** — resolved as a standing architectural decision with no action item (was sitting PENDING with nothing left to do).
  - **`time_expired_display_stats_sweep_remaining`** — RESOLVED, user-confirmed. `stats.js`'s capture-ratio and `monteCarloService.js` both now include TIME_EXPIRED trades (real mark-to-market P&L), classified win/loss by sign. `patternMemoryUpdate.js`'s TARGET_HIT-only queries audited and correctly left as-is (different semantic — move magnitude on a clean hit, not a general win/loss aggregate).
  - **`condition_memory_needs_rebuild_not_backfill`** — escalated to HIGH, not resolved. Found something bigger than the original double-counting concern while scoping the rebuild: `daily_performance_log`'s last row is 2026-07-31, a full month dead, despite real `trades` data existing through 2026-08-12 that should have triggered the pipeline's own catch-up mechanism. Not root-caused this session (deliberately not rabbit-holed) — needs its own focused investigation before any rebuild, since rebuilding from a still-broken source would just re-encode a fresh gap.


