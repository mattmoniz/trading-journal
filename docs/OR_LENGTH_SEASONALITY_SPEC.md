# Opening Range length + seasonality research — design spec (Phase 0, pre-code)

Status: **DESIGN ONLY — not built, not dispatched to mining yet.** This doc is the
Phase 0 artifact per the standing 3-phase Gemini/DeepSeek workflow (CLAUDE.md
"Collaboration" section) — it goes out for design critique BEFORE any backtest
script is written. Do not treat anything below as validated.

## 1. Why this exists

Triggered by the 2026-08-12 IB_BULLISH/IB_BEARISH window-bug fix (`RESEARCH_CLAIM
ib_bullbear_30min_vs_60min_window_test`, `OPEN_DECISION
ib_bullbear_window_fix_recalibration_needed`). That fix corrected `acd.js`'s IB
window from 30min to the real 60min Initial Balance. While auditing it, two things
became clear:

1. This codebase's existing `OR_HIGH`/`OR_LOW`/`OR_MID_AFTER_IB` setup types are
   **already a specific Opening Range length (5 minutes, gate=575 i.e. bars
   570-574) — but nothing in the name says so.** `OR_HIGH` reads as generic
   "the opening range high," not "the 5-minute opening range high." This is the
   same class of ambiguity the IB bug just came from (a name that doesn't
   pin down which window it means), just not yet manifested as a bug because
   there's currently only one OR length live.
2. `server/services/acdBacktest.js` already has a parameterized
   `getOpeningRange(bars, orMinutes)` — this codebase's own ACD methodology
   (Mark Fisher A/C/D) treats OR length as a real, sweepable parameter, and
   `scripts/backtest_setup_d_opening_drive_stage1.mjs` (2026-08-11) already
   compared a 5min vs 15min OR for the Opening Drive setup. So "does OR length
   matter" is not a new question for this codebase — it's an established one,
   just never generalized to the level-fade engine (`OR_HIGH`/`OR_LOW`/`OR_MID`)
   the way it's been used for Opening Drive.

User's ask, two parts:
- **(A)** Test whether OR high/low/mid at other lengths (10/15/30min, in addition
  to the existing 5min) have real, calibratable EV — as a fade level, a breakout
  level, or both — and whether that varies across the calendar year.
- **(B)** Whatever survives gets wired into the same infrastructure everything
  else uses (`level_prices`, `keepLevelsAll`, `SETUP_STATUS`/`OPTIMAL_STOP`, the
  weekly/daily cron files) with a naming convention that makes the window length
  self-evident from the name alone — no repeat of the "OR_HIGH is secretly 5min"
  ambiguity.

## 2. Proposed naming convention (open question — flag in critique)

`OR{N}_HIGH`, `OR{N}_LOW`, `OR{N}_MID` where `{N}` is the window length in
minutes: `OR5_HIGH`, `OR10_HIGH`, `OR15_HIGH`, `OR30_HIGH`, and the `_LOW`/`_MID`
siblings. This:
- Makes the window length readable directly from the setup_type string, matching
  how `IB_` already reads unambiguously (IB is always 60min, never suffixed,
  because there's only one IB).
- Parallels the existing day-type-suffix convention (`IB_BEARISH_TURBULENT`) and
  the `_TRAIL` conditional-variant suffix — this codebase already suffixes
  setup_type strings to encode a real distinguishing parameter, so this isn't a
  new pattern, just a new parameter being encoded (window length instead of
  day-type or exit-mechanism).

**Open question for critique**: the CURRENT live `OR_HIGH`/`OR_LOW`/
`OR_MID_AFTER_IB` are un-suffixed 5-minute levels with real history in
`active_setups`/`SETUP_STATUS`. Two options:
- **(a) Rename them to `OR5_HIGH`/`OR5_LOW`/`OR5_MID_AFTER_IB`** for full
  consistency — requires updating `SETUP_DISPLAY_LABELS`, `CONTEXTUAL_DIRECTION_TYPES`,
  live INSERT sites, and deciding how to treat their existing history (relabel
  historical rows in place — same setup, just renamed, unlike the IB window fix
  where the classification itself changed — vs. leave history under the old
  name and only rename going forward).
- **(b) Leave `OR_HIGH`/`OR_LOW` as bare names** (grandfather them as the
  implicit-5min legacy case) and only apply the `OR{N}_` suffix to the NEW
  10/15/30min variants being added.
- Recommend (a) for long-term clarity (this is exactly the "don't leave a stale/
  inconsistent name next to a new clear scheme" lesson CLAUDE.md's docs-maintenance
  section already states as a hard rule) but it's a real live-wiring rename, not
  a free action — wants explicit sign-off, not a unilateral decision, per the
  standing "ask before rewriting shared historical/live conventions" rule.

## 3. What's being tested

For each candidate window `N ∈ {5, 10, 15, 30}` (60 is IB, already covered,
excluded here) and each level `{HIGH, LOW, MID}`:
- **As a fade level** (price returns to it and reverses) — same mechanism as
  the existing level-fade engine.
- **As a breakout/continuation level** (price closes through it and continues)
  — this codebase doesn't currently test ANY opening-range level this way; the
  Opening Drive precedent (`backtest_setup_d_opening_drive_stage1.mjs`) is the
  closest analog and should be read before designing this arm.

Both arms tested against real NQ bar history directly (`price_bars_primary`,
`symbol='NQ'` filtered, MTM concept doesn't apply since this predates any
`active_setups` row — this is bar-history-first per CLAUDE.md's "market
hypothesis → bar history first" rule, NOT routed through `active_setups`).

**Seasonality**: bucket by calendar month (12 buckets) at minimum; consider
quarter (4 buckets) as a coarser, higher-N companion view since month-level N
will be thin for some window/level/direction combinations. Do NOT report a
"best month" without correcting for how many buckets were tested — this is the
same shape of risk as `SETUP_STATUS_DOW`'s ~180-cell sweep, which needed an
explicit multiple-comparison correction and still only had ~26% of cells survive.

## 4. Rigor guardrails (non-negotiable, matches existing precedent)

Total comparison surface: 4 windows × 3 levels × 2 directions (fade/breakout)
× 13 time buckets (12 months + all-year) = up to 312 cells. This needs the same
discipline as `COMPRESSION_TAIL_MFE_SPEC.md`'s "pre-registered... 18-test budget
declared up front" — **declare the real test count and a Bonferroni (or
equivalent) correction BEFORE running anything**, not after seeing which cells
look good.

Every surviving cell must clear, before being reported as a real finding (not
just before being wired live):
1. N≥20 (standing floor).
2. `computeRigor()` (day-clustering + 3-way chronological stability) — reuse
   the shared function, do not hand-roll a 4th copy.
3. `computeReplication()` — required specifically because this is a sweep
   picking winners out of up to 312 cells (confound checklist item 4: "was this
   the largest of K effects pulled from a sweep").
4. No lookahead — this is bar-walk simulation over historical bars in
   chronological order only; the confound checklist's item 1 (does the "smarter"
   arm have a structural/algebraic edge, e.g. from entering later against a
   fixed exit) applies directly if a breakout arm and a fade arm on the SAME
   level are compared against each other.
5. Symbol filter (`NQ` only — the ES-contamination window is a standing trap).

## 5. Existing infrastructure to reuse, not reimplement

- `server/services/acdBacktest.js`'s `getOpeningRange(bars, orMinutes)` — the
  window-length parameterization already exists, reuse it directly rather than
  re-deriving.
- `server/services/developingValueService.js`'s `computeProfile()` — if a MID
  level ends up needing anything beyond a simple `(high+low)/2` midpoint (it
  shouldn't — OR mid is a range midpoint, not a volume-weighted POC — but flag
  this explicitly so nobody accidentally reaches for the wrong function).
- `server/services/rigorDiagnostics.js`'s `computeRigor()`/`computeReplication()`
  — mandatory per §4, not a suggestion.
- `scripts/update_optimal_stops.mjs`'s `sweepOptimalStopAndTarget`/
  `sweepOptimalStopAndTargetChronological` — for stop/target calibration once a
  window/level/direction combo is promising enough to simulate a real trade,
  not a hand-rolled sweep.
- `scripts/record_claim.mjs` / `scripts/flag_decision.mjs` — every tested
  cell (positive or negative) gets recorded; no dead ends.

## 6. Wiring plan (once something survives §4 — not before)

1. **`level_prices`**: new `level_name` values (`OR10_HIGH`, `OR10_LOW`, etc.)
   computed by `scripts/compute_levels.js`, using the SAME same-day-forming
   gate-minute convention as the existing `OR_HIGH`/`OR_LOW` (gate = 570+N),
   not a new mechanism.
2. **`server/routes/acd.js`'s `keepLevelsAll`**: new candidate entries per
   surviving window/level/direction, mirroring the existing `OR_HIGH`/`OR_LOW`
   candidate objects exactly (same self-gating pattern via `etMinNow`).
3. **Calibration pipeline**: `backtest_setup_status.mjs`/`update_optimal_stops.mjs`
   are generic (`GROUP BY setup_type`, no hardcoded list) — any new setup_type
   auto-discovers into `SETUP_STATUS`/`OPTIMAL_STOP` once it has real touches.
   No cron change needed for this part specifically.
4. **A dedicated recurring script** (`scripts/backtest_or_length_seasonality.mjs`)
   for the seasonality angle specifically, since that's not something the
   generic per-setup_type pipeline checks on its own — added to
   `run_weekly_backtests.sh`, matching the "any new calibration finding needs a
   recheck/recalibration path" hard rule (same pattern as
   `backtest_value_fade_bet_class_phase2.mjs`).
5. **Discoverability**: a CLAUDE.md "Where to look" entry + `ARCHITECTURE.md`
   inventory entry once anything is actually wired — not after the fact.
6. **`test_invariants.mjs`**: extend the existing OPTIMAL_STOP-coverage /
   naming-consistency checks to cover the new `OR{N}_` family, same as every
   other conditional-variant family gets.

## 7. What Phase 0 critique should specifically push on

1. Is the 4-window × 3-level × 2-direction × 13-bucket surface (§4) the right
   scope, or should the breakout arm / seasonality arm be split into a
   SEPARATE, later pass rather than one combined 312-cell sweep? (Smaller,
   sequential passes with their own budgets may be safer than one giant one.)
2. Is bar-history-first (not `active_setups`) actually right here, or does the
   existing 5min `OR_HIGH`/`OR_LOW`'s real trade history make a hybrid approach
   (validate the bar-history finding against the real 5min case where live data
   already exists) more convincing?
3. Naming: option (a) vs (b) in §2 — does renaming live setup_types carry risk
   this design is underweighting?
4. Anything in the wiring plan (§6) that's actually more complex than it looks
   from inside this codebase's existing conventions.
