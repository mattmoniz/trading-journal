# BIGMOVE_LIVE_SIGNAL bug fix + runner-extension idea (ready to design)

**Status: bugs fixed and live (commit `1347d50`, 2026-08-04). Runner-extension idea corrected and
ready for Phase 0 design — not started. Written to be self-contained across a context clear.**

## What happened, in order

**The trigger**: user shared a Sierra Chart screenshot of 2026-08-04's RTH session — a sustained,
one-directional move (price rode the 9-EMA up the whole session on the 5-min chart) — and asked why
the system never flagged it.

**Investigation found two real, independent bugs in `server/routes/acd.js`, both now fixed
(commit `1347d50`)**:

1. **Reachability bug.** `BIGMOVE_LIVE_SIGNAL`, `sigmaContinuation`, and `stackVolSignal`
   (`computeStackVolSignal()`) were all computed *after* `if (!active) return res.json(...)` — an
   early return that only fires when some fade-family candidate happens to be selected as `active`
   that poll. On a sustained trend day, no fade candidate naturally becomes active (price keeps
   running through/away from levels instead of holding at one), so every single poll hit the early
   return before ever reaching the signal code. The exact days these signals exist to flag are the
   days they were least likely to run at all. Same failure class as the already-documented
   2026-07-27 `STACK_VOL_BREAK_LIVE` Globex-unreachability bug — a second, previously-uncaught
   instance gating the RTH path instead of the Globex path. **Fix**: moved all three computations
   to before the early return (now ~line 7542 in `acd.js`), and the early return itself now
   includes `bigMoveSignal`/`sigmaContinuation`/`stackVolSignal` in its response.

2. **A separate, independent SQL bug**, only discovered once bug 1 made this code reachable for
   the first time: the `BIGMOVE_LIVE_SIGNAL` INSERT used `$1` for both `run_date` (a `date` column)
   and `signal_name` (a `varchar` column) in the same statement. Postgres cannot infer one
   consistent type for a parameter used in two different type contexts — this threw a real
   `42P08 date versus character varying` error on every attempt, silently swallowed by a bare
   `.catch(() => {})` since the feature was built (2026-07-24). Confirmed via server logs the
   moment bug 1 was fixed. **Fix**: separate `$3` parameter for `signal_name`, and the catch
   handler now logs failures (`console.error`) instead of swallowing them.

**Verified live, end to end**: real query against `price_bars_primary` confirmed the actual
crossing time was **2:00 AM ET** overnight (range hit exactly 250pt, 900 minutes remaining at that
moment) — by RTH open (9:30 AM) the range was already 450.5pt. The RTH move on the user's chart was
a *continuation* of an already-large overnight move, not its origin. The dashboard banner
(`ACDView.jsx`, "📈 BIG-MOVE DAY SIGNAL") was already correctly built and wired on the frontend — it
just never had real data to render, since `bigMoveSignal.active` was always `false` in every
response, every day, since the feature was built. `test_invariants.mjs` confirmed zero regressions
(one new FAIL that session, `FLOOR_R3_FADE_SHORT`, confirmed via `git stash` to be pre-existing,
unrelated day-to-day calibration drift).

**Also confirmed, separately**: `STACK_VOL_BREAK_LIVE_LONG/SHORT` (the closest thing this system has
to a live breakout/trend-following setup) never fired at all on 2026-08-04, and has fired only 4
times total, ever (all `SHORT`, all `SHADOW`-origin, 2026-07-29 through 2026-07-31, nothing since).
This fact is true and worth knowing, but — important — **it turned out to be irrelevant to the
runner-extension idea below**, see the correction.

## The "let it ride" idea — corrected after a real scoping error, now ready to design

User proposed: if `BIGMOVE_LIVE_SIGNAL` is validated, the system should be able to capitalize on it
by holding trades longer on big-move days ("we need to catch these moves").

**This is not speculative — it was already tested** in `RESEARCH_CLAIM
bigmove_signal_fade_direction_hypothesis_refuted` (source: `scripts/
backtest_bigmove_signal_exit_trigger_fade_direction.mjs`, N=311, dated 2026-07-26). That backtest
split the population of trades that triggered while `BIGMOVE_LIVE_SIGNAL` was active into two
groups by whether the trade's own direction matched the day's established price direction at the
trigger moment:
- **Riding WITH the day's trend (N=53)**: holding via the signal beat baseline by **+$819** and beat
  a blind hold by **+$4,646**.
- **Fading AGAINST the day's trend (N=258 — the large majority)**: a blind, signal-free fast exit
  beat everything, including the signal-gated approach, by **+$13,979**.

**First pass at scoping this got it wrong, caught and corrected the same session — read this before
building anything.** The first instinct was to scope the runner-extension idea to
`STACK_VOL_BREAK_LIVE` specifically, reasoning that it's "the one live trend-following setup," and
to block the whole idea on that setup's own thin N=4. **This was wrong, and was corrected by
directly reading the actual backtest script** (`scripts/
backtest_bigmove_signal_exit_trigger_fade_direction.mjs`, lines 71-116): the population query has
**no `setup_type` filter at all** — it loads every trade from the trailing 365 days, and classifies
"riding with" vs "fading against" purely by comparing each individual trade's own inferred
direction (`directionFromType(t.setup_type)`) against the day's price direction at that specific
moment (`dayDirection[entryIdx + triggerOffset]`, computed as `close >= sessionOpen ? 'UP' :
'DOWN'`). `STACK_VOL_BREAK_LIVE` was never specially involved — the N=53 "riding with" population is
almost certainly dominated by ordinary fade-type setups that simply happened to be long on an up
day or short on a down day, not a distinct breakout-family subset.

**Corrected conclusion: N=53 already clears this codebase's standing N≥20 floor. This is not
blocked on more data — it's ready for real design work now.**

Both the wrong claim and the corrected one are on record, not silently replaced:
- `RESEARCH_CLAIM bigmove_runner_extension_stack_vol_break_blocked_n4` — marked `SUPERSEDED_WAS_WRONG`
  / status `STALE`, kept (not deleted) so the correction itself is visible.
- `RESEARCH_CLAIM bigmove_runner_extension_design_ready` — the corrected claim, `PROVISIONAL`,
  N=53, `rigor_status='READY_FOR_DESIGN_N53_CLEARS_FLOOR'`.
- `OPEN_DECISION bigmove_runner_extension_design_task` — the original (wrongly-scoped) decision,
  RESOLVED with the correction explained in its resolution text.
- `OPEN_DECISION bigmove_runner_extension_ready_to_design` — the corrected, currently PENDING
  decision, **HIGH priority** (explicit user emphasis: "we cant lose sight of this").

## What building this actually looks like (not started)

A runner-extension mechanism gated on **both**:
1. `BIGMOVE_LIVE_SIGNAL.active` (already fixed and live, see above), **and**
2. the specific open trade's own direction matching the day's established direction at that moment
   — this second condition is not optional or redundant with the first; it's exactly what
   separates the validated N=53 "helps" population from the N=258 "hurts" population. Skipping it
   and gating on `BIGMOVE_LIVE_SIGNAL` alone would silently reintroduce the harmful case.

Mechanism: keep the calibrated target on a portion of the position, trail the remainder — reuse the
existing `scripts/lib/breakevenTrailCore.mjs` bar-walk infrastructure (already extracted, already
has its own guardrail suite: thin-tail gate, plateau check, chronological IS/OOS split, baseline
comparison, `computeRigor()`) rather than building new mechanics from scratch. This is the same
infrastructure already recommended for the independent Part 4 pilot in `docs/
COMPRESSION_TAIL_MFE_SPEC.md` (a different, unrelated thread — read that doc separately if picking
it up, don't conflate the two runner-extension ideas; they use the same underlying trail
infrastructure but are gated on completely different conditions).

**Definition of "the day's established direction" needs to be pinned down precisely before
building** — the original backtest used `close >= sessionOpen` at the trigger moment as a simple,
real-time-computable proxy (no lookahead: only uses the current session's own open and current
price, both known live). Reuse that exact definition, don't reinvent one, unless there's a specific
reason to test an alternative — and if so, treat that as a deliberate, flagged design choice, not a
silent substitution.

**Follow the standing 3-phase workflow** (design critique → mine-and-run → code review) before any
live wiring, per this codebase's own rule for anything that will eventually touch live execution
behavior — this has not been started. The next concrete action is Phase 0: a design critique (via
Gemini and/or DeepSeek) of the exact gating logic and how it interacts with the existing
`resolveSetupsByPrice()` resolution loop (already flagged elsewhere in this codebase — see
`CLAUDE.md`'s `acd_trail_null_fallback_silent` note — as an area with real, documented fragility
around trail-mechanism null-fallback behavior; check that note before extending trail logic further
in that same function).

## Quick reference for a fresh session

- Bug fixes: commit `1347d50`, `server/routes/acd.js` (search `bigMoveSignal`/`sigmaContinuation`/
  `stackVolSignal` to find every touched line).
- Validated runner-extension finding: `RESEARCH_CLAIM bigmove_runner_extension_design_ready`
  (N=53) — supersedes `bigmove_runner_extension_stack_vol_break_blocked_n4` (wrong, kept for the
  correction record).
- Pending action: `OPEN_DECISION bigmove_runner_extension_ready_to_design` (HIGH).
- Underlying research this all builds on: `RESEARCH_CLAIM
  bigmove_signal_fade_direction_hypothesis_refuted` (N=311) and `RESEARCH_CLAIM
  bigmove_realtime_price_progress_promising_volume_weak` (the original signal validation, N=180,
  57.2% vs 36.9% baseline for finishing ≥400pt).
- Reusable infra for the mechanism itself: `scripts/lib/breakevenTrailCore.mjs`.
