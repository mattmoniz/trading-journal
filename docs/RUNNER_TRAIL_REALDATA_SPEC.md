# Real-data runner/trailing-exit backtest — build-ready spec (2026-08-16)

**Status: spec only, not built.** Supersedes nothing — this is the "actually do it against
real data" follow-up to `docs/RUNNER_OPTIMIZATION_NOTES_20260814.md`, whose two optimizer
prototypes (Gemini's structural zigzag, DeepSeek's ATR-band) were schema-blocked and never
ran on real data. Also unrelated to (and does not reuse) `scripts/tripwire_backtest_framework.py`
/ `scripts/numba_tripwire_backtest.py`, deleted 2026-08-16 — those were confirmed by both
Gemini and DeepSeek to be copied from an unrelated crypto-exchange project (percentage
taker fees, synthetic-only data) and have no connection to this thread.

## The actual question

User, verbatim: "we're trying to figure out ways to let winners run while maintaining our
current strategy that excels on balance days." Two real, already-established facts frame
this:

1. **The live fade roster's real edge is concentrated on BALANCE days, not TREND/TURBULENT.**
   `VALUE_FADE` (the core fade family): BALANCE EV=+$7.18/trade (N=605, positive), TREND
   EV=-$6.59 (N=444), TURBULENT EV=-$17.90 (N=185) — `RESEARCH_CLAIM
   value_fade_daytype_conditioned_ev_balance_positive`. A runner/trailing exit is inherently
   a trend-capturing mechanism — applying it blindly across all day types risks diluting the
   one regime where this system is already reliably positive.
2. **The existing live breakeven-trail mechanism already tried "let winners run" once** —
   fixed-point trail width, arms only once T1 is reached (`stepBreakevenTrail()`,
   `server/services/breakevenTrailWalker.js`). Its own day-type-conditioned extension found
   **0 of 5 IB_BULLISH/IB_BEARISH buckets survive** full validation, and most of its 6
   blended SHADOW variants have never actually engaged the trail in real data. This spec
   tests two different mechanisms (ATR-band, structural zigzag), not a re-run of that one.

**Refined hypothesis**: a runner mechanism might help specifically where the current fixed
exit is *already weak* (TREND/TURBULENT) without needing to touch BALANCE, where the fixed
exit already works. Per user direction (2026-08-16): build and report **both** the ungated
(all day types) and day-type-gated (TREND/TURBULENT only; BALANCE stays on the current fixed
exit) results side by side — don't presuppose gating is the answer, show the data for both.

## Population (checked live, 2026-08-16)

```sql
SELECT a.*, d.day_type
FROM active_setups a
JOIN acd_daily_log d ON a.trade_date = d.trade_date
WHERE a.origin_status IN ('ACTIVE','SHADOW')   -- real fires only, never BACKFILL
  AND a.status = 'RESOLVED'
  AND a.resolution IN ('TARGET_HIT','STOP_HIT') -- excludes TIME_EXPIRED/trail variants;
                                                  -- see Note A below
  AND a.entry_zone_low IS NOT NULL AND a.stop_level IS NOT NULL AND a.t1_level IS NOT NULL
```

N=1,063 total. By day_type: BALANCE=544, TREND=420, TURBULENT=99. Date range 2026-07-09 to
2026-08-17 (~6 weeks, ~40 trading days). **TURBULENT's N=99 is thin for a parameter grid
search** — any TURBULENT-specific candidate selection needs a wider or coarser grid than
BALANCE/TREND get, and its own result should be treated as more provisional. The ~40-day
span also means a 3-way chronological stability split (`computeReplication()` convention)
gives only ~13 days per third — flag this explicitly in the writeup rather than treating a
"stable" read as strong evidence at this sample size; this is a first read, not a decisive
one, and should re-run as real N grows (matches `globex_edge_recheck_at_n180`'s precedent of
scheduling a recheck rather than trusting an early-N result indefinitely).

**Note A**: rows already resolved via the live trail mechanism (`resolution='TRAIL_EXIT'`)
or `TIME_EXPIRED` are excluded from the population — this spec is about testing an
*alternate* exit for entries that currently resolve via plain fixed stop/target, not
re-simulating rows that already have a different mechanism's real history.

## Baseline (computed the same pass, not read from `actual_pnl`)

Per the standing "baseline must be computed the same way as the candidate" rule: don't trust
the stored `actual_pnl` as the baseline even though it should match. Recompute the baseline
via `replayBars()` (`server/services/maeMfeReplay.js`, already the canonical fixed-exit
replay used by the live resolution path and every other backtest in this codebase) against
the exact same real 1-min bars the trail arms will use. This also gives a free integrity
check: if `replayBars()`'s baseline disagrees with the stored `actual_pnl` by more than a
rounding tolerance, that's a real finding to surface (similar in spirit to
`scripts/audit_worst_trades_maemfe.mjs`'s Part 2, sitting uncommitted from 2026-08-12 — worth
running that script for real once this backtest reuses the same bar-fetch plumbing, since
it's already written and never run).

## Candidate arms — both walk the SAME real bars, SAME entry, SAME initial stop

This structurally satisfies the confound checklist's item 1 (no entry-price/structural
advantage — only the exit differs) for free, since all three arms share entry/stop/direction
exactly as recorded live.

### Arm 1: Baseline (fixed exit) — `replayBars()`, unmodified.

### Arm 2: ATR-band trail
New function, e.g. `replayBarsWithAtrTrail(bars, entry, stop, t1, direction, { activationR, atrMult, atrLookback })`:
- Stays on the fixed initial stop until price reaches `entry + activationR * (entry - stop)`
  (long case; mirrored for short) — i.e., activation is a multiple of *initial risk*, not a
  fixed point, matching DeepSeek's original design and Gemini's utility-function framing.
- Once activated, trail stop = `rolling_high(atrLookback) - atrMult * ATR(atrLookback)`,
  ratchet-only (never loosens), computed **causally** — the ATR and rolling-high at bar `i`
  use only bars `<= i`, exactly the no-lookahead convention `replayBars()` and
  `computeStructuralStopAnchors()` (from `docs/structural_runner_optimization_20260814.py`,
  Gemini's already-causal zigzag) both already follow.
- No fixed T1 once armed — exits only on the trailing stop hitting, or `TIME_EXPIRED` at RTH
  close (matching `stepBreakevenTrail()`'s `isSessionEnd` convention, `bar.ts` hour >= '16').

### Arm 3: Structural zigzag trail
`replayBarsWithStructuralTrail(bars, entry, stop, t1, direction, { activationR, pivotThreshold, tickOffset })`:
- Same activation-at-`activationR`-multiple-of-risk gate as Arm 2.
- Once activated, trail = most recent confirmed swing-low (long) / swing-high (short) minus/
  plus `tickOffset`, using the same causal zigzag logic as
  `compute_structural_stop_anchors()` in `docs/structural_runner_optimization_20260814.py` —
  port that function's logic to JS rather than re-deriving pivot detection from scratch (per
  "export the real function" — it's already written and was Gemini's own design, just never
  run against real data).

### Candidate grid (swept per arm, not hand-picked)

- `activationR`: {1.0, 1.5, 2.0, 2.5, 3.0} — spans "activate right at 1R" through "well past
  where a lot of these setups' current T1s already sit" (median target-to-risk ratio across
  the live roster should anchor the upper end — pull this from `OPTIMAL_STOP` data rather
  than guessing).
- `atrMult` (Arm 2): {1.0, 1.5, 2.0, 2.5, 3.0} × `atrLookback` fixed at 14 (standard, but note
  it as a fixed choice, not swept, to keep the grid tractable — flag as a known
  simplification).
- `pivotThreshold` (Arm 3): derive the candidate set from the data's own volatility (e.g. a
  few multiples of the median 1-min bar range for the relevant day_type), not arbitrary
  percentages — matches the "candidate grid needs a floor from the data's own resolution"
  rule.
- `tickOffset` (Arm 3): {0.5, 1, 2} ticks (0.25/tick for NQ/MNQ).

This is a real grid (5 × 5 for Arm 2, 5 × N × 3 for Arm 3) — run it with the same
train/OOS split discipline `computeCorrectedTarget()` uses (in-sample candidate selection,
out-of-sample confirmation), not a single full-sample sweep-and-pick.

## Day-type conditioning — report both

For each arm, report:
- **Ungated**: all 1,063 rows, one grid search, one winning cell.
- **Gated**: grid search run separately per `day_type` bucket (BALANCE/TREND/TURBULENT each
  get their own candidate selection) — then construct the "TREND/TURBULENT get the trail,
  BALANCE keeps the current fixed exit" blended portfolio result as its own row, alongside
  each day_type's standalone number. This directly answers the user's actual question: does
  gating preserve BALANCE's existing edge while capturing something extra on TREND/TURBULENT,
  or does gating just needlessly complicate a result that's fine (or not) either way.

## No-lookahead check specific to gating

`day_type` (`acd_daily_log`) reclassifies at IB close (~10:30 ET) per
`project_daytype_accuracy_backlog` and is stable after that. Before trusting a
day-type-gated result: confirm what fraction of the 1,063-row population fired *before*
10:30 ET, since gating a pre-IB-close trade on a day_type label that wasn't actually knowable
yet at fire time would be a real lookahead leak specific to this backtest (not present in the
ungated arm). If a meaningful fraction fired early, either exclude them from the gated arm or
use the *prior-day* day_type as a knowable proxy and note the difference — don't silently
assume day_type was available.

## Rigor checklist (standard, restated for this specific backtest)

- N≥20 per reported cell (day_type × arm × winning candidate) — TURBULENT's N=99 total means
  its OOS split may fall short per grid cell; if so, report thin-N honestly rather than
  picking a cell that happens to clear 20 by chance.
- Day-clustering: top-5-trading-day share of each winning cell's N.
- `computeReplication()` 3-way chronological check (`server/services/rigorDiagnostics.js`) —
  report the raw numbers, not just the `replicates` boolean (per
  `project-engagement-research-session-20260723-synthesis`'s standing caution that this
  boolean has misled before in both directions).
- Real commission: MNQ $2 round-trip (`server/config/instruments.js`
  `LIVE_INSTRUMENT.commissionPerRoundTrip`), applied identically across all 3 arms.

## Build order

1. Port `compute_structural_stop_anchors()`'s causal zigzag logic to JS (small, ~30 lines,
   already designed correctly per the 2026-08-14 notes — just needs translating, not
   redesigning).
2. Write `replayBarsWithAtrTrail()` / `replayBarsWithStructuralTrail()` — new functions,
   reusing `directionFromType()` from `maeMfeReplay.js`, same file or a new
   `server/services/runnerTrailSim.js` (backtest-only for now, not wired into
   `resolveSetupsByPrice()` — this is research, not a live change).
3. Write `scripts/backtest_runner_trail_realdata.mjs` — pulls the population above, runs
   `replayBars()` (baseline) + both new functions across the candidate grid, per-day_type and
   blended, with the rigor checklist wired in (reuse `computeRigor()`/`computeReplication()`
   from `server/services/rigorDiagnostics.js`, don't reimplement).
4. Record whatever the result is via `recordClaim()` — positive or negative, per the standing
   "every tested claim gets recorded" rule. If a config decisively beats baseline with the
   gating clean, that becomes an `OPEN_DECISION` for live-wiring (SHADOW-only first, per every
   other setup-type checklist in this codebase) — not wired same-session regardless of result.

## What NOT to do

- Don't reuse the toy from-scratch signal from `docs/backtest_mnq_20260814.py` — that thread
  is closed (decisive negative, `RESEARCH_CLAIM mnq_structural_trailing_2bar_toy_signal_negative`).
  This spec tests real live-roster entries instead, which is the actual open question.
- Don't port Gemini's `scipy.optimize.differential_evolution` utility-function approach
  as-is — its weights (0.35× mean-runner-return, 1.5× downside penalty, 0.30× CVaR) were
  never validated as reflecting what the user wants optimized, per the 2026-08-14 doc's own
  flagged caveat. A plain grid search with an explicit train/OOS EV comparison is more
  auditable and consistent with how every other calibration in this codebase works
  (`update_optimal_stops.mjs`'s sweep, not a black-box optimizer).
