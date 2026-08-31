# 2-Lot Scale-Out with a Breakeven-Minus-5 Runner (2026-08-31)

**Status: SECOND-pass bar-by-bar backtest run, both open questions user-confirmed, PROVISIONAL
result recorded** — `scripts/backtest_twolot_scaleout_be_minus5.mjs`, `RESEARCH_CLAIM
twolot_scaleout_be_minus5_orshort_structural` (supersedes the first-pass
`twolot_scaleout_be_minus5_orshort_firstpass` claim, which used the setup's own t1_level as a
placeholder runner target). User confirmed both Open Questions 2 and 4 the same day: runner
arms to BE-minus-5 the **instant** Lot 1 fills, and the runner's target is a **real structural
level**, not the setup's own tight target. See "Second-pass result" below.

## Second-pass result (2026-08-31) — structural runner target, both open questions resolved

Runner target now comes from `level_prices` (the same table that feeds live level-fade
candidates in `acd.js`'s `keepLevelsAll`), restricted to categories that are always known
*before* the live session — `PRIOR_DAY`/`PRIOR`/`WEEKLY`/`MONTHLY`/`QUARTERLY`/`YEARLY`/
`PIVOT`/`CAMARILLA`/`WEEKLY_PIVOT`/`MONTHLY_PIVOT`/`OVERNIGHT` — explicitly excluding the
same-day-forming `CURRENT` category (OR/IB values already used for entry) and `RTH_VWAP` (forms
intraday), so there's no lookahead. For each trade/T1-candidate, the target is the nearest known
level strictly below where Lot 1 already exits — i.e. the runner genuinely runs further, not
just holds the same distance under a looser stop.

Population: real (`ACTIVE`+`SHADOW`) OR-length SHORT-fade family, N=140 direction-confirmed
(picked up 1 new fire since the first pass), 139 walkable. Structural levels available for
30/34 trade dates; 9 of 139 trades excluded per T1 candidate where no qualifying level existed
below Lot 1's exit that date (a real, honest limitation of relying on actual level coverage
rather than a synthetic always-available target).

**Best candidate: T1=12pt** (same as the first pass). Delta (beMinus5 vs exit-all-no-runner)
mean=**+$7.63/trade**, N=130. Plateau-clean (T1=16pt neighbor +$4.84). **Chronological OOS is
now much tighter than the first pass**: train mean=+$7.57 (N=91), test mean=+$7.75 (N=39) —
nearly identical, test even slightly higher, a real improvement over the first pass's
train/test near-halving ($12.04→$6.19). `computeRigor`: stable=true, clustered=false,
clean=true. Bootstrap (2000 resamples): 98.9% positive-mean.

**Outcome composition** (same three-way read as the first pass, now genuinely stronger):
- 26.9% (35/130): Lot 1 never fills — no difference.
- 26.9% (35/130): Lot 1 fills, runner gives back the fixed **-$34/trade** deliberate small
  loss — down from 39.6% in the first pass.
- **46.2%** (60/130): Lot 1 fills, runner reaches the real structural target — up from 33.1% in
  the first pass, now the largest of the three buckets, not just the tail.

Structural levels actually used span a wide mix — no single dominant level type (heaviest were
`ONL` 10x, `PD_LOW`/`CAM_S3`/`FLOOR_S3`/`PM_POC` 5-7x each, the rest single digits) — average
distance the runner target sits beyond Lot 1's own exit: **25.3pt**.

**Read this as a genuinely stronger, more honestly-derived result than the first pass** — not
just a different number. The improvement (higher win-share, tighter OOS agreement) is
structurally explained: the first pass's runner target (the setup's own t1_level) could
sometimes sit closer than a wider T1 candidate, letting the runner "win" trivially without
really running further — the structural-level version can't do that by construction (level must
be strictly beyond Lot 1's exit).

**Still not done before this goes near a live/SHADOW wiring decision:**
- Independent re-verification (still a single script's own output).
- Comparison against the user's actual current live/described strategy (T1 ~10-15pt +
  exact-breakeven, no small-loss tolerance) as the *primary* baseline — the `exactBe` arm is
  computed as a reference (beMinus5 modestly ahead at T1=12: $1.41/trade) but exit-all-no-runner
  remains the primary comparison in this pass.
- The 9-trades-excluded-per-candidate gap (no structural level some dates) means the usable
  population shifts unevenly across T1 candidates — worth keeping in mind reading the sweep.
- Broader generalization to other "struggling" setups was raised and explicitly deferred by the
  user — tracked separately, `OPEN_DECISION twolot_scaleout_generalize_to_other_setups` (LOW).

## First-pass result (2026-08-31, superseded by the above — kept for history)

Population: real-only (`origin_status IN ('ACTIVE','SHADOW')`) OR-length SHORT-fade family
(OR5/OR10/OR30 × HIGH/LOW/MID), N=139 direction-confirmed, all 139 walkable against
`price_bars_primary`. 458 additional BACKFILL rows excluded per the standing origin_status rule.

Swept Lot 1's T1 distance over [12,16,20,24,30]pt; Lot 2 arms to entry+5pt (short-side
breakeven-minus-5) the instant Lot 1 fills, runs to the setup's own calibrated `t1_level`.
Compared against **Baseline 1** (exit-all-at-the-same-T1-distance, no runner at all) at every
candidate.

**Best candidate: T1=12pt.** Delta (beMinus5 vs exit-all-no-runner) mean=+$10.27/trade, N=139.
Plateau-clean (T1=16pt neighbor also positive, +$6.86). Chronological OOS: train mean=+$12.04
(N=97), test mean=+$6.19 (N=42), same-sign. `computeRigor`: stable=true, clustered=false,
clean=true. Bootstrap (2000 resamples): 99.7% positive-mean.

**Read the composition, not just the mean — this is the one thing worth internalizing before
anyone gets excited about a "+$10/trade" headline:**
- 27.3% (38/139): Lot 1 never even fills — no difference from doing nothing differently.
- 39.6% (55/139): Lot 1 fills, then the runner gives back the deliberate small loss — a fixed,
  deterministic **-$34/trade** relative to the no-runner baseline (this is the "breakeven minus
  5" mechanism doing exactly what it's designed to do: capping the runner's downside at a small
  known cost).
- 33.1% (46/139): Lot 1 fills, the runner reaches its target — a real win, ranging $40-$176
  better than the no-runner baseline.

The positive $10.27 mean is entirely a minority-right-tail effect (the 33% that reach target),
not something the median trade experiences — the median delta is exactly $0, purely because of
tie-clustering between the "never filled" and "fixed -$34" buckets, not because the effect is
fake (hand-traced and confirmed deterministic, not a bug). This is a legitimate, expected shape
for a payoff-asymmetric mechanism, not a red flag by itself — but it means "N=139, +$10.27 mean"
alone is a misleading way to describe this to a human deciding whether to use it. Present the
three-way split whenever this finding is referenced.

**Not yet done, needed before any live/SHADOW wiring decision:**
- Confirm Open Questions 2 and 4 with the user (see below — both were given a documented
  default, not a confirmed answer).
- Independent re-verification (this is a single script's own first-pass output — the standing
  "a number computed twice by the same script isn't verified" rule applies).
- Comparison against the actual current live/described strategy (T1 ~10-15pt + exact-breakeven
  runner) as its own baseline, not just against a synthetic "exit-all" baseline — the script
  computed an `exactBe` arm for reference but did not make it the primary comparison.
- N=139 clears the general N≥20 floor in aggregate, but the outcome-composition breakdown above
  means each of the 3 buckets individually is thinner than that — worth keeping in mind before
  treating any bucket's own number as decisive.

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

## Suggested next step for the next session

Open Questions 1, 2, and 4 are all resolved (see Second-pass result above). Open Question 3
(Lot 1's target — literal sweep vs. data-derived) was already sanctioned as a literal sweep for
an exploratory first pass; revisit only if this mechanism gets close to a live decision.
Remaining: make the "current strategy as actually described" (T1 ~10-15pt + exact-breakeven)
the *primary* baseline instead of the synthetic exit-all-no-runner one, and get independent
re-verification before this goes anywhere near a live/SHADOW wiring decision. The
struggling-setups generalization question is separately parked — see
`OPEN_DECISION twolot_scaleout_generalize_to_other_setups`.
