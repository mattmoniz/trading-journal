# 2-Lot Scale-Out with a Breakeven-Minus-5 Runner — Scoped, Not Started (2026-08-31)

**Status: scoped and recorded, zero code written, zero backtest run.** User explicitly asked
for this to be its own focused thread, not squeezed into other work — read this doc fresh at
the start of that session rather than reconstructing from conversation history.

## The idea

On a 2-contract position:
- **Lot 1**: takes a quick, close target — user's own framing, "10-15 point base hit."
- **Lot 2 (the runner)**: once armed (presumably once Lot 1's target is hit, though this needs
  confirming with the user — see Open Questions), its stop moves to **entry minus 5 points**
  (for a long; entry plus 5 for a short) — NOT exact breakeven, NOT a locked-in profit. If the
  runner fails and reverses all the way back, it takes a small, capped loss of 5 points. This
  was an explicit correction from the user mid-conversation ("Breakeven minus 5. Small loss") —
  do not build it as exact-breakeven or breakeven-plus, both were considered and rejected in
  favor of this specific small-loss-tolerance framing.

## Why this is a genuinely different risk shape than what already exists live

This codebase already has two related-but-different mechanisms — don't conflate this with
either:

1. **The live breakeven-then-trail mechanism** (`server/services/breakevenTrailWalker.js`,
   `scripts/backtest_breakeven_trail.mjs`) — snaps to exact breakeven or a calibrated trail
   width once armed, never a small deliberate loss. SHADOW-only, 6 variants, 5 of 6 confirmed
   non-functional as of 2026-08-16 (see `docs/OPEN_THREADS.md`).
2. **The breakeven-floor arm tested earlier the same session this idea came up**
   (`scripts/backtest_wider_target_breakeven_floor.mjs`, 2026-08-24) — stop snaps to EXACT
   entry once armed. Found real: it does make every "loss" exactly -$2 commission (no real
   point-loss ever), but it also kills the wider-target mechanism's entire edge — mean delta
   dropped from +$9.46/trade to ~$0, because it also cuts off trades that would have recovered
   and run further. **This is the most directly relevant prior result** — a breakeven-minus-5
   variant sits between "protects fully" (exact breakeven, kills the edge) and "protects not at
   all" (the current live wider-target shape, original stop never moves) — worth explicitly
   comparing against both of those as reference points, not just against "no mechanism at all."

## Connects to 2 existing, already-scoped threads — read both before starting

1. **`project_scaleout_optimization_parked.md`** (Claude's own memory, not a repo file — pull
   it via memory access at the start of the new session). This is the original, more general
   scale-out brief this idea is a specific instance of. Full methodology already written:
   sweep T1 distance (12/16/20/24/30pt), sweep scale ratio (3+1/2+2/2+1 on a 3-lot, 4+1 on a
   5-lot — the user's 2-lot case is the simplest version of this), sweep runner stop
   (breakeven vs small trailing vs the now-clarified breakeven-minus-5), compare against two
   baselines (exit-all-at-T1-no-runner, and the current strategy as actually described). Explicit
   guardrails: out-of-sample + plateau check (best config must be surrounded by other good
   settings, not a lucky spike) + Monte Carlo robustness pass, matching the existing $200 DLL
   validation convention. **"Recommend ONLY if a config robustly beats current strategy —
   otherwise conclude current strategy is sound, don't change it" is an explicitly legitimate,
   expected outcome, not a failure.**

2. **`docs/RUNNER_OPTIMIZATION_NOTES_20260814.md`** — a separate, real backtest of a
   *structural swing-anchor trailing-stop* runner (734 trades, 2025-08-01 to 2026-08-14,
   avg +$0.68/trade) that is **NOT trustworthy as-is** — two confirmed, unfixed bugs:
   - **Lookahead bias**: `docs/dump_levels_20260814.mjs` dumps every level for every date with
     no time-of-day awareness. Same-day-forming levels (`OR10/15/30_HIGH/LOW/MID`,
     `IB_HIGH/LOW/MID`) get matched against their *fully-formed* value even at 9:40 AM, when
     that level wouldn't be known yet. This is the exact failure mode CLAUDE.md's own hard
     rule names: same-day-forming levels need their own formation gate.
   - **No commission subtracted anywhere** in either `docs/backtest_mnq_20260814.py` or
     `docs/summarize_csv_20260814.py`.
   - Do not reuse this backtest's entry signal, its trailing-stop logic, or its P&L numbers
     without fixing both bugs first — or explicitly scope the new 2-lot analysis as fully
     independent of it (probably cleaner, since it's a different question: a fixed
     breakeven-minus-5 runner stop, not a structural trailing stop).

## Open questions to resolve before (or while) building

1. **Does real historical trade data support a genuine multi-lot replay?** Check whether
   `active_setups` (or `trades`) has any real 2-lot/N-lot position records to replay directly,
   or whether this has to be modeled as a hypothetical construction from existing single-position
   MAE/MFE data (i.e., simulate "what if this exact historical trade had been split into 2 lots
   with these two different exit rules" from its real bar-by-bar path). The parked brief's own
   "Data Requirements" section assumes MFE/MAE per trade is already available (~97% populated,
   Sierra-native) — confirm this is still true and sufufficient, or whether a real bar-by-bar
   walk (matching every other exit-mechanism backtest in this codebase, e.g.
   `scripts/backtest_wider_target_breakeven_floor.mjs`'s pattern) is needed instead.
2. **What arms the runner's stop move?** Confirmed: Lot 1 hits its quick target. Not yet
   confirmed: does Lot 2's stop move to entry-minus-5 the INSTANT Lot 1's target fills (most
   natural reading), or after some additional condition? Confirm with the user before building
   if this isn't obvious from context by the time work starts.
3. **What determines Lot 1's target exactly — a fixed 10-15pt, or a data-derived one?** Per
   this codebase's own standing "no static thresholds" rule, if this goes anywhere near a live
   recommendation, the exact cutoff should come from a rolling distribution, not a hand-picked
   number in that range — but for an initial exploratory sweep (matching the parked brief's own
   "sweep T1 distance 12/16/20/24/30pt" methodology), testing a small range of literal candidate
   values is the normal, correct first step, not a violation of the rule by itself.
4. **What's the runner's own target?** The parked brief's baseline uses "run to a structural
   level ~100-200pt away." Confirm whether that's still the intended runner target for this
   specific idea, or whether the runner should just run indefinitely / to session close /
   to some other definition.

## Rigor requirements before trusting any result (non-negotiable, per the parked brief + this
codebase's standing conventions)

- Chronological out-of-sample split (train/test), not an in-sample-only sweep.
- Plateau check — best config must be surrounded by other good settings, not an isolated spike.
- `computeRigor()` (day-clustering + 3-way chronological stability) on the winning config's
  delta vs baseline.
- Monte Carlo robustness pass on the winning config, matching the existing DLL-validation
  convention.
- Explicit baseline comparisons: vs exit-all-at-T1 (no runner at all), and vs whatever the
  actual current live/intended strategy is.
- A genuine negative ("current strategy is fine, don't change it") is a legitimate, expected,
  real answer — do not lean toward finding an improvement just because one was asked for.

## Suggested first step for the next session

Read `project_scaleout_optimization_parked.md` (memory) and this doc, resolve Open Question 1
(does real multi-lot-replayable data exist) before writing any simulation code, then scope
whether to build this as a from-scratch bar-by-bar walker (recommended, matches this codebase's
"export the real function, reuse the walk conventions already established" pattern from every
other exit-mechanism backtest this session) or as an MAE/MFE-based approximation.
