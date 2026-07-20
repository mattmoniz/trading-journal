# Overnight Research — Findings Log + Cross-Reference Against the RTH Large-Movement Calibration Playbook

Started 2026-07-20. Consolidates a full session's worth of overnight research (wider-window
backtest verification, the overnight-calibration overfitting lesson, taper-timing tests,
open-ended pattern discovery, direct big-move diagnostics) and — per explicit user request —
cross-references it against how this codebase already solved the analogous RTH problem
("large movements aren't captured by a fixed target") so the overnight work reuses a
hard-won methodology instead of re-learning the same lessons from scratch. Same "keep the
dialogue, not just conclusions" convention as `TARGET_CALIBRATION_SPEC.md`/`SCALEOUT_RUNNER_SPEC.md`.

Related: [OPEN_THREADS.md](OPEN_THREADS.md) has the day-by-day chronological entries this
doc consolidates. [WIDER_WINDOW_BACKTEST_20260720.md](WIDER_WINDOW_BACKTEST_20260720.md) has
the underlying window-construction/level-population methodology everything here builds on.
[TARGET_CALIBRATION_SPEC.md](TARGET_CALIBRATION_SPEC.md) and
[SCALEOUT_RUNNER_SPEC.md](SCALEOUT_RUNNER_SPEC.md) are the RTH precedent being cross-referenced.

## Part 1 — What was actually found today (overnight), in order

### 1.1 The foundation: wider-window backtest re-verified, methodology corrected twice
User asked for a past-year "24hr trading cycle" prop walkthrough. Before building it, the
underlying wider-window backtest (multi-year, built the prior session) got a second, more
thorough audit: found the window direction was wrong on a first attempt (should extend
backward into the overnight session, not forward past close — confirmed via the doc's own
ONH/ONL caveat), then found a flat 240-bar (4hr) resolution cap was starving overnight-fired
trades of the time they need (overnight moves slower — RTH showed 11/238 `EXPIRED` outcomes,
the same test showed 122/352 once extended overnight). After both fixes, 5 of 6 spot-checked
prior-period rows reproduced the original report closely; the same-day-forming levels
(`IB_HIGH`/`IB_LOW`/etc.) got WORSE under the fix (EV flipped sign again), reinforcing they're
genuinely unstable, not just unverified.

### 1.2 Past-year walkthroughs (52 prior-period levels, excludes same-day-forming + several
newly-caught same-day-forming impostors: `IB_MID`/`OR_MID`/`RTH_VWAP`/`WEEKLY_VWAP`/
`MONTHLY_VWAP`/`DAILY_OPEN`/`WEEKLY_OPEN`/`MONTHLY_OPEN` — 3 separate rounds of contamination
found and fixed while building the very first walkthrough)
- **RTH-only vs 24hr (pooled), same levels/window**: 24hr underperforms RTH-only at every DLL
  tested (-$589/-$1,895/-$1,444 at $200/$400/$600 DLL) — a real, honest, pooled result, though
  it doesn't rule out individual levels still benefiting (pooling can mask winners/losers
  cancelling out).
- **Overnight-only** (excludes RTH entirely): $7,047/$6,113/$4,246 at $200/$400/$600 DLL,
  N=1079-1340, WR ~70-71%, PF 1.02-1.14. Positive on its own terms.

### 1.3 Overnight stop/target recalibration — real descriptive fact, no real P&L edge
Overnight excursions genuinely are narrower than RTH (p75 MAE/p50 MFE: 127.8pt/65.3pt
overnight vs 149.8pt/91.0pt RTH — both wider than the flat 90pt/40pt default actually used
everywhere, notably). But recalibrating the blanket stop/target to match produced a dramatic
in-sample "improvement" ($5,226→$36,858) that collapsed to noise out-of-sample ($7,502→$7,625,
a $123 difference over 76 held-out days). **This is the session's first hard lesson directly
relevant to Part 2 below**: a distribution-derived parameter must be validated on data it
wasn't fit on before its P&L impact is trusted, no matter how dramatic the in-sample number.

### 1.4 Does the RTH taper-timing pattern transfer overnight? No.
The user's own confirmed RTH domain pattern (down moves fast-then-fizzle by late morning, up
moves grind all session) does not show an analog overnight — tested with the same
train/derive-on-70%/test-on-30% discipline, real negative (7.1% vs 4.2% taper-by-landmark on
held-out data, both N≥20).

### 1.5 Open-ended pattern discovery — first pass underpowered, redone properly
First pass (70/30 holdout on an already-rare ~82-event population) rejected all 7 candidates,
but every single one failed for power reasons (buckets as thin as n=1) — corrected from a
mislabeled "clean" result to "underpowered." Redone with a full-sample permutation test
(matching the methodology that already worked for `globex_large_moves_start_near_pit_safe_levels`)
— genuinely well-powered this time for 2 of 7 candidates (prior-day-range-expansion and
pre-move-compression both cleanly, negatively tested, N≥20, day-clustering clean), 2 remain too
rare to test with current data volume (not negatives — unknowns), 3 have adequate N but fail
independence (day-clustering), with p-values far enough from significance that clustering
probably isn't hiding a real effect.

### 1.6 Direct big-move diagnostics (>400pt overnight range)
- 47 of 253 days (18.6%) qualify.
- MAE/MFE of trades taken: big-move days show LESS adverse excursion than normal days
  (cleaner, more directional sessions), similar-or-slightly-higher MFE.
- **Money left on the table, big-move days specifically**: `TARGET_HIT` trades (N=653) ran an
  average 143.2pt (median 119.3pt) further favorable AFTER the fixed 40pt target, 87.3% ran
  ≥30pt further — vs. only 80.2pt average extra on normal days (N=1941). ~1.8x more left on
  the table on the days that matter most.
- **Levels respected during big moves** (N≥20): `PD_VAH` 86%, `PD_LOW` 85%, `PD_POC` 83%,
  `PD_SESSION_MID` 82% stand out as genuinely well-powered. `CAM_R1` is the standout the other
  way — 48% (N=31), gets broken through more than it holds during big moves.
- **Inception timing**: raw distribution favors London (44.2%), but duration-adjusted,
  Pre-Market (08:30-09:30 ET, just a 1hr window) captures ~3x its fair share of inceptions —
  almost certainly the 08:30 ET US economic-data-release effect.

**Self-correction, made while writing this doc, before the user could be misled by it**: the
"143.2pt left on the table" finding above has the EXACT flaw the RTH thread's first
`POST_TARGET_RUNUP` attempt had — it only tracks the running favorable extreme after target,
with **no record of whether a real adverse retracement happened first**. RTH's own account of
this (see §"Post-resolution excursion research" in `docs/OPEN_THREADS.md`, 2026-07-18) is
explicit: *"the script only recorded the two EXTREME points... with no record of which
happened FIRST... `post_target_max_adverse` was consistently comparable to or larger than the
'extra run-up' itself... meaning the numbers can't distinguish 'price ran further in our
favor, then gave some back' (real, capturable) from 'price dropped hard against us first, and
only recovered to a new favorable extreme much later' (you'd have been shaken out before ever
seeing the upside)."* The overnight big-move script (`analyze_overnight_big_moves_20260720.mjs`)
has this identical gap — do not treat the 143.2pt figure as already-actionable. It's a lead,
not a validated opportunity, exactly like RTH's raw MFE observation was before the sequence
fix. See Part 2 for the concrete fix.

## Part 2 — Cross-reference: the RTH large-movement calibration playbook, and how it applies here

The RTH thread (docs/TARGET_CALIBRATION_SPEC.md, docs/SCALEOUT_RUNNER_SPEC.md) already solved
almost exactly this problem — "a fixed target doesn't capture how far a big move actually
goes" — the hard way, across multiple false starts. Every one of those false starts has a
direct overnight analog worth naming explicitly, so the overnight work doesn't have to
rediscover them independently.

| RTH lesson (what was tried, what failed, why) | Overnight analog / how it applies |
|---|---|
| **Raw MFE/"extra run-up" without sequence tracking produced misleading 300-475% numbers** — couldn't distinguish real continuation from "dropped hard first, recovered late." Never acted on until fixed. | **Exactly the flaw in today's 143.2pt finding** (§1.6 self-correction above). Must be fixed before this goes any further — see §3 below. |
| **Efficiency-ratio framing** (captured/eventual-true-extreme) is the right primary metric, not raw extra points — user's own bar: "capture profit within 10% of the actual bottom if calibrated properly." | Should compute this for overnight big-move trades once sequence tracking is fixed: `target_distance / true_eventual_extreme`. Rough current estimate (unvalidated, pre-sequence-fix): ~40/(40+143) ≈ 22% captured on big-move days — a low efficiency ratio, but this number itself needs the sequence fix before it's trustworthy. |
| **Order-blind independent-percentile checks (mae>stop AND mfe>target as separate facts) systematically overstate EV** — the actual fix was real bar-by-bar chronological resimulation checking which level is hit FIRST, every time. | The overnight scripts already DO this correctly for entry-to-resolution (via the real `resolve()` import) — the gap is specifically POST-resolution tracking (§1.6), not the initial simulation. Fix: extend the post-target walk to track BOTH running favorable and running adverse from the moment target is hit, so a genuine continuation can be distinguished from a stopped-out-then-recovered path, exactly like `backtest_post_resolution_sequence.mjs` does for RTH. |
| **A single static wider target is structurally the wrong tool** — can't be simultaneously (a) reliably reached and (b) wide enough for a rare huge continuation. `backtest_target_sweep_v2.mjs`'s first attempt proved this by spike-picking absurd targets (719.8pt off 1 trade). | **Do not test "would a wider fixed overnight target have helped."** Skip straight to the mechanism RTH landed on instead (next row) — testing a static wider target here would just re-derive the same negative result RTH already paid for. |
| **Scale-out / breakeven-then-trail is the mechanism that actually worked** — take the existing, already-validated target, then trail the remainder with a DATA-DERIVED trail width instead of predicting in advance whether a trade is "a big one." Already built and SHADOW-live for `FLOOR_R1_FADE_SHORT` and 4 other RTH setups (`server/routes/acd.js`'s `resolveSetupsByPrice()`, `active_setups.runner_trail_width`/`breakeven_armed_at`/etc.). | **This is the recommended design for overnight big-move trades**, not a recalibrated fixed target. Concretely: on a day already showing big-move character, arm a breakeven-trail on target touch instead of taking the fixed 40pt exit — reuses the EXISTING schema/resolution-engine hooks (no new plumbing), just needs its own trail-width calibration and its own eligibility test (see §3). |
| **Guardrail stack**: thin-tail gate (N≥15-20 real touches of the winning candidate), plateau check (neighbors must also look good — a lone spike is curve-fit), chronological OOS split, day-clustering/rigor check, ALL FOUR together. | Apply all four to any overnight trail-width candidate. Given big-move-conditional touches are already a thin population (876 total, spread across 52 levels), expect this to bite hard — likely too thin to test per-level; may need to pool across levels the way the initial big-move MAE/MFE check did, rather than per-level like RTH's scale-out survivors. |
| **Candidate grid needs a floor derived from the DATA'S OWN RESOLUTION** — a 3-6.8pt RTH trail was finer than the median 1-min bar range (6.25pt) and unresolvable from OHLC data; every statistical guardrail passed it anyway since none check data granularity. | **Must derive this floor from OVERNIGHT's own bar-range distribution, not RTH's** — overnight bars likely have a different (probably narrower, given lower volume/participation) typical range than RTH bars. Check this directly before setting any overnight trail-width floor; do not reuse RTH's 6.25pt number. |
| **Baseline must be resimulated by the exact same method as the candidate — never read a stored/precomputed EV column.** This bit `VALUE_AREA_RESPONSIVE_SHORT` hard: comparing against a stale `OPTIMAL_STOP.ev_per_trade` reversed the entire finding once corrected (-$1.99 stored vs. +$15.22 properly resimulated). | Any overnight trailing-mechanism test must resimulate its OWN 100%-at-fixed-target baseline in the same pass, on the same big-move-conditional population — never compare against today's descriptive "143.2pt extra" stat or the flat P&L numbers from §1.2/§1.6 as if they were an equivalent baseline. |
| **Expect a LOW survival rate as the sign of a trustworthy finding** — 88/90 (97.8%) surviving was the tell something was broken; 3-4/96 or 18-19/103 surviving strict guardrails was the trustworthy shape. | If an overnight trail-width sweep shows many levels "surviving," treat that as a red flag requiring root-cause, not a win — same as the RTH snug-trail (32/96, later 0/96 once the data-resolution floor was applied) false alarm. |
| **Wire durably or not at all** — the RTH mechanism was extracted into a shared service (`targetCalibrationService.js`) reused by the live scheduled pipeline, not a one-time patch; the breakeven-trail mechanism reused the EXISTING resolution engine rather than building parallel plumbing. | If an overnight-specific trail config survives all guardrails, it should plug into the SAME `active_setups` columns/`resolveSetupsByPrice()` hooks already built for RTH's breakeven-trail mechanism, gated on a "today looks like a big-move day" condition — not a second, parallel mechanism. |

## Part 3 — Concrete recommended next steps (in order, not all done)

1. **Fix the sequence-tracking gap in the big-move post-target walk first** (cheap, should
   happen before anything else in this section is trusted). Extend
   `analyze_overnight_big_moves_20260720.mjs`'s post-target walk to record running adverse
   excursion alongside running favorable, same as `backtest_post_resolution_sequence.mjs`
   does for RTH — this tells us whether the 143.2pt figure is a clean continuation or requires
   riding through a real drawdown first.
2. **Compute the efficiency ratio** (captured/true-eventual-extreme) on the corrected,
   sequence-aware data, per big-move-conditional trade — the RTH-validated framing, not raw
   extra points.
3. **Check overnight's own bar-range distribution** before setting any trail-width floor —
   do not reuse RTH's 6.25pt median.
4. **Test the breakeven-then-trail mechanism specifically for big-move-conditional overnight
   trades** (not a recalibrated fixed target — Part 2 already argues why that's the wrong
   tool), with the full RTH guardrail stack: thin-tail, plateau, chronological OOS, rigor,
   data-resolution floor, same-method baseline. Expect a low survival rate; a high one means
   something's wrong, not that overnight is unusually rich in edges.
5. **If something survives**: wire into the existing `active_setups`/`resolveSetupsByPrice()`
   breakeven-trail mechanism, gated on a big-move-day detector, SHADOW-first, N≥20 live before
   promotion — same discipline as every other new setup type in this codebase.

None of steps 1-5 are done yet. `OPEN_DECISION` `overnight_bigmove_target_truncation_needs_sequence_fix`
flags step 1 specifically (HIGH — it's what makes §1.6's headline number honest or not);
`OPEN_DECISION` `overnight_bigmove_trailing_mechanism_test` flags steps 2-5 as a single
follow-on body of work (MEDIUM — real but not urgent, no live exposure either way since
nothing here is wired).

## Part 4 — Overnight gets its own calibration, using RTH's REAL methodology (done, 2026-07-20)

Direct follow-up: user confirmed overnight should have its own calibration (not share RTH's,
not use a blanket flat default), specifically using the SAME rigorous methodology RTH's real
`OPTIMAL_STOP` pipeline uses — not the cruder pooled-percentile shortcut §1.3 already showed
doesn't generalize. Built `scripts/calibrate_overnight_optimal_stops_20260720.mjs`, which
achieves genuine methodology parity the strongest possible way: it **imports and calls the
real, live, already-guardrailed functions directly** — `sweepOptimalStopAndTarget` from
`scripts/update_optimal_stops.mjs` and `computeCorrectedTarget` from
`server/services/targetCalibrationService.js` — rather than reimplementing either one.
Confirmed via direct source read: no local reimplementation exists anywhere in the script.

**Result**: 102 level+direction combinations tested (52 levels × 2 directions, full available
history, overnight-fired touches only). **61 cleared stage 1** (EV-sweep, N≥20 + thin-tail
gate — a believable ~60% pass rate). **15 additionally cleared stage 2** (full chronological
corrected-resim with every guardrail — thin-tail, plateau, OOS split, rigor-clean, beats
baseline both full-sample and OOS) — a believable, low ~15% pass rate matching RTH's own
18/103 (17.5%), the trustworthy shape per this doc's own Part 2 lesson ("expect few
survivors"). Audited before trusting: re-ran the deterministic script myself and reproduced
byte-identical results; checked all 15 stage-2 corrected targets for the RTH-precedent
overfitting spike pattern (719.8pt off 1 trade) — none found, all 15 are moderate widenings
(50-134.8pt) with adequate supporting N (47-243).

**Confirms the premise of this whole part**: the calibrated stops for well-powered levels are
meaningfully tighter than the flat 90pt placeholder used throughout §1.2/§1.3/§1.6's other
overnight work — `CAM_R1_LONG` 32pt, `CAM_R3_LONG` 34pt, `FLOOR_R2_LONG` 26pt. Overnight
genuinely does warrant its own calibration, not a shared or blanket one. Persisted to
`performance_audit` `signal_type='OVERNIGHT_OPTIMAL_STOP'`, mirroring the real `OPTIMAL_STOP`
schema exactly (same columns, same query pattern — queryable the same way, including via
`DISTINCT ON (signal_name) ... ORDER BY signal_name, run_date DESC` per this table's own
standing convention). `RESEARCH_CLAIM` `OVERNIGHT_OPTIMAL_STOP` recorded (CONFIRMED).

**Not yet done**: this is the general, always-on overnight calibration (mirrors RTH's base
`OPTIMAL_STOP`) — it is NOT the big-move-conditional trailing mechanism from Part 3 steps 1-5,
which remains separate, unstarted follow-on work. The two are complementary: this gives
overnight levels a real baseline stop/target; the trailing mechanism (once Part 3 step 1's
sequence-tracking fix lands) would be an additional, move-size-conditional refinement on top.

## Part 5 — Scoping the 1-year Globex-inclusive prop challenge (user request, 2026-07-20)

User wants a full 1-year prop-account walkthrough that includes Globex/overnight trading, now
that overnight has its own real calibration (Part 4). This closes a real gap: nothing before
this point had scoped how RTH and Globex actually COMBINE into one challenge — the two sides
of this codebase's data are fundamentally different in kind, and that difference must be
disclosed, not glossed over.

**The core asymmetry**: RTH has ~103 setup_types with real (if ~80% `BACKFILL`-tainted) trade
history in `active_setups`, each with its own live `OPTIMAL_STOP` calibration already computed
by the scheduled pipeline. Globex/overnight has almost no real fired history — only 4
dedicated setup_types (`PD_VAH_FADE_SHORT`/`PD_VAL_FADE_LONG`/`PD_POC_FADE_SHORT/LONG` via
`detectGlobexSetup()`), each with N=4-6 (checked earlier this session, too thin to use as-is).
**The only way to include "Globex" in a year-long challenge is the simulated 52-level
population this entire session's overnight thread has been built on** — bar-walked touches
against real `level_prices` values, using the just-built `OVERNIGHT_OPTIMAL_STOP` calibration
(Part 4) instead of the flat 90/40 placeholder used in every earlier overnight walkthrough
today.

**Design, resolved**:
1. **RTH leg**: real `active_setups` history for the full live-eligible setup roster (same
   population as the earlier `LEGACY_ROLLING`/`CURRENT_VALIDATED_ROSTER` walkthrough,
   `scratch/backtest_prop_2yr_walkforward_CORRECTED_TARGETS.mjs`-style — reuse that script's
   day-loop/DLL structure, don't rewrite it), each trade's real `actual_pnl` as historically
   resolved.
2. **Globex leg**: simulated touches from the 52-level wider-window population (reuse
   `scripts/calibrate_overnight_optimal_stops_20260720.mjs`'s exact window-construction/
   touch-detection code), each trade PRICED using its own level+direction's
   `OVERNIGHT_OPTIMAL_STOP` calibrated stop/target where one exists (15 combinations from
   Part 4), falling back to the flat 90/40 default for the other 87 (same fallback convention
   `update_optimal_stops.mjs` itself uses for RTH setups that don't clear its own guardrails —
   consistent, not a new pattern).
3. **Merge chronologically**: one day-loop over the full 1-year window, combining both legs'
   trades by `fired_at` timestamp (Globex trades fire overnight/pre-market, RTH trades fire
   9:30-4:00 — they interleave by calendar day, never by literal minute-of-day collision).
   Apply DLL/lockout across the COMBINED day (a Globex loss overnight should count against
   the same day's RTH DLL budget, matching how a real prop account actually works — the
   day's cumulative P&L doesn't reset at 9:30 AM).
4. **Eligibility**: RTH trades use the real, already-computed live `SETUP_STATUS`/rolling
   eligibility (or the same self-computed rolling `n≥20 && ev≥-5` used in the earlier
   walkthrough, for consistency with that comparison). Globex trades use a freshly
   self-computed rolling eligibility over the simulated population (can't reuse live
   `SETUP_STATUS` — nothing Globex-specific is wired there), same as every Globex walkthrough
   today has already done.
5. **Mandatory disclosure, prominently, in the output itself** (not buried in a caveat
   paragraph): this is a HYBRID of real historical account behavior (RTH leg) and a pure
   price-action simulation that never fired live (Globex leg, except the 4 already-checked
   thin setups). Report the two legs' contribution to total P&L separately, not just a single
   blended number, so it's always clear how much of any headline figure depends on simulated
   vs. real trade outcomes — same spirit as the existing `origin_status` (`BACKFILL` vs
   `ACTIVE`/`SHADOW`) disclosure already standard for RTH-only walkthroughs.

**Built and audited, same session (2026-07-20)**: `scripts/backtest_1yr_globex_inclusive_prop_challenge_20260720.mjs`.
Merge mechanics confirmed correct by direct source read — both legs' trades combined into one
chronological list per day (`[...rth, ...globex].sort(by fired_at)`), one shared DLL-lockout
loop walks that combined list, roster query is a fresh live `SETUP_STATUS` read, not
hardcoded. Full matrix: `docs/GLOBEX_INCLUSIVE_1YR_PROP_RESULTS_20260720.md`.

| RTH scenario | Globex | DLL $200 | DLL $400 | DLL $600 |
|---|---|---|---|---|
| `LEGACY_ROLLING` | Excluded | $21,565.51 | $14,707.09 | $9,840.83 |
| `LEGACY_ROLLING` | Included | $47,102.69 | $42,136.31 | $35,614.21 |
| `CURRENT_VALIDATED_ROSTER` | Excluded | -$954.50 | -$954.50 | -$954.50 |
| `CURRENT_VALIDATED_ROSTER` | Included | $32,131.50 | $32,188.00 | $31,626.00 |

The Globex leg contributes ~$32.7k-$33.3k independently across every Globex-included run —
nearly identical across both RTH scenarios at matching DLL, confirmed as the CORRECT expected
behavior (Globex always fires chronologically before that day's RTH trades, so it's never
affected by which RTH scenario is being tested), not a bug.

**A real caveat was found during audit, not yet resolved — do not treat the ~$32-33k Globex
figure as fresh confirmation of the Part 4 calibration.** The `OVERNIGHT_OPTIMAL_STOP` lookup
this script uses has no date restriction — it reads calibration derived from the FULL
available history (2023-11-16 to 2026-07-19, ~2.68 years). `computeCorrectedTarget()`'s own
internal chronological OOS check (the last 1/3 of each combo's own touch history) covers
roughly the same recent ~11-12 months this new test calls "the past year." So this result
substantially re-aggregates the SAME held-out evidence already used to validate the 15
calibrated combos individually — a real but weaker claim than a genuinely fresh out-of-sample
test (the stop/target VALUES were chosen from earlier, non-overlapping training data, so this
isn't pure in-sample refitting, but the AGGREGATE validation window overlaps heavily with what
was already checked). `OPEN_DECISION` `overnight_calibration_needs_genuine_fresh_holdout_test`
(MEDIUM) flags the clean fix: freeze the calibration using only data through 1 year ago, then
test purely against the following year, untouched by any part of calibration. Not yet built.
