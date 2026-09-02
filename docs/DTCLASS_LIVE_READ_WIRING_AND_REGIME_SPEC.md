# dtClass live-read wiring + "do we need a proper regime classifier" — scope (2026-09-02)

**Status: scoped, zero code changed.** Follow-up to the same-session IB_BULLISH/IB_BEARISH
DeepSeek code review, which found the shared `dtClass`-null bug is bigger than previously tracked
(6-7 real consumers, not 4) and that a fix already exists but was never wired in. User asked to
scope this out plus answer "what about using a proper day-type classifier or regime somehow"
before clearing context. Read this doc fresh before touching `dtClass`/day-type wiring again.

## The bug, restated precisely

`dtClass` is read from `acd_daily_log.day_type`, which the nightly pipeline doesn't write until
8:20 PM ET — so every live read of `dtClass` during market hours is `null`. Confirmed at the data
level this session: `active_setups.day_type_at_fire` is `NULL`/`'UNKNOWN'` for ~100% of both
IB_BULLISH and IB_BEARISH rows (452/452, 225/225).

**A fix already exists and was never wired in.** `getLiveDayTypeRead()`
(`server/services/caseEngine.js:346`, extracted 2026-08-19) computes a real-time day-type
estimate from bars/session-open/IB-high-low/nl30/orWidth/A-up-down-fired flags — genuinely live,
not the dead end-of-day column. It's only ever called from within `caseEngine.js` itself
(`computeCase()`, line 1137) — `grep getLiveDayTypeRead server/routes/acd.js` returns nothing.
The comment at `caseEngine.js:345` literally says the IB call site should use it; it doesn't.

**One consumer already tested the live read and found it net-harmful.**
`scripts/backtest_trend_gate_suppression.mjs` swapped `isTrendCounterFade()`'s data source from
dead `dtClass` to the live reassessment engine: N=440, net delta **-$3,238.60**, 70.6%
false-positive rate on fade-touch moments specifically. DeepSeek's read: the live estimator is
roughly **52.8-68% accurate end-to-end** — fine for a display/direction hint, too noisy for a
hard binary gate. This is the single most important fact shaping the plan below: **do not
assume wiring the fix in is automatically an improvement** — it already wasn't, once, for real.

## Full consumer inventory (verified this session, not assumed)

`dtClass` is read in 7 places in `acd.js`. Behavior under the current permanent `null` differs
per consumer — this matters, because "fixing" a consumer that's currently *accidentally
permissive* could newly start blocking trades that were fine, and "fixing" one that's currently
*accidentally restrictive* could newly allow trades that were being (correctly, by luck) blocked.

| Line | Consumer | Behavior when `dtClass=null` today | Stakes tier |
|---|---|---|---|
| 6228 | `dayTypeOk = dtClass === 'BALANCE'` (an absorption-pattern candidate) | Always `false` → this candidate **never fires** | HARD gate |
| 6300 | `dayTypeOk = dtClass==='TREND' \|\| (nl30-based fallback)` | TREND path dead, but nl30 fallback still works → **partially** restrictive | HARD gate (partial) |
| 7182 | `isTrendCounterFade()`: `if (dtClass !== 'TREND'...) return false` | Always `false` → suppression **never triggers** (real trend-counter fades slip through) | HARD gate — **already tested, live-read swap was net-harmful** |
| 8073 | `eliteZone = dtClass==='TURBULENT' && ...` | Always `false` → ELITE_ZONE badge **never shows** | DISPLAY only |
| 8092 | `dtaKey = dtClass ? ... : null` (day-type-alpha size lookup) | `dtaKey` null → SIZE_UP/DOWN/SUPPRESS lookup **skipped entirely**, falls through to default sizing | SOFT nudge |
| ~8285 | OR-expansion-bias `mult` boost, gated on `dtClass==='BALANCE'\|\|'TURBULENT'` | Always `false` → this specific `mult` bonus **skipped** | SOFT nudge |
| 8339-8350 | `dayTypeEdge`/`dayTypeWarn` display fields | Derived from the (already-null) `dtaRow` above → always absent | DISPLAY only |

Net picture: **not** uniformly permissive or restrictive — a real mix. Any fix must be evaluated
per-consumer, not applied as one blanket swap.

## "Should we build a proper day-type/regime classifier?" — the honest answer

**No — reuse what already exists (`getLiveDayTypeRead()`), don't build a new one from scratch.**
This codebase has already tried the "build a real regime classifier" path multiple times, with a
track record worth knowing before trying again:

- **Regime A/B/C** (`server/services/regimeClassificationService.js`'s `conditionedMultiplier()`)
  — a full 5-stage validation framework (`docs/REGIME_DETECTION_SPEC.md`) found its label
  transitions align with real structural breaks **worse than chance** (independent PELT-changepoint
  ground truth). Confirmed this session: zero live callers anywhere in `server/` or `scripts/` —
  correctly dead, not wired to anything.
- **`sessionChar`** (`server/routes/morningBrief.js`) — display-only (the "Session" badge on
  quick-check.html), never read by `acd.js`. Has its own real bug found this session (a strict
  if/else-if cascade masking simultaneous states — e.g. a day can be both TIGHT_IB and TREND_UP
  but the badge can only show one, whichever priority-order check happened to pass). Cosmetic
  only, not fixed yet, low priority.
- **`currentRegime`** (vol/dir/range, computed inline in `acd.js` ~12057-12093) — feeds a
  per-level "regime fit" metric on the Backtest research view only (`BacktestView.jsx`), not any
  live decision.
- **`classifyRegime`** (`server/services/volatilityRegimeService.js`) — feeds a scheduled
  historical accumulation table (`VOL_REGIME_HIST`) for future backtests, not live-gating today.
- **`dayTypeReassessmentService.js`'s `classifyGroundTruth()`/`runReassessment()`** — the offline
  "ground truth" day-type engine, called from `caseEngine.js` and used for backtesting/training —
  this is plausibly what `getLiveDayTypeRead()` was validated against originally.
- **`getLiveDayTypeRead()`** — the one already-built, already-partially-tested LIVE intraday
  estimator. ~52.8-68% accurate. One real test (hard-gate role) found it net-harmful.

Building a genuinely new/better classifier is a large, speculative undertaking with a track
record of failure or non-adoption in this exact codebase. The pragmatic path is to use the one
live estimator that already exists and is moderately accurate, and **match its role to what
52-68% accuracy can actually support** — not force it into roles that already failed a real test.

## "Is there a genuinely better way to forecast this?" — don't just settle for reuse

User pushback, correctly: recommending "reuse `getLiveDayTypeRead()`" should not be read as "this
is as good as it gets, stop looking." Two different axes here, with two different honest answers.

**Volatility specifically: yes, a real, better, already-built method exists and is completely
unwired.** `scripts/backfill_garch_vol_scale_history.py` fits a genuine walk-forward GARCH(1,1)
model (`arch_model(..., vol='Garch', p=1, q=1)`, proper numerical safeguards for near-unit-root
fits) and persists it as `performance_audit` `signal_type='GARCH_VOL_SCALE'`. This is a
real, statistically principled volatility forecast — not a heuristic, not a z-score bucket — and
it's already shown a real, if modest, effect (28 of 103 setup_types improve when their stop is
GARCH-scaled, per the existing `docs/OPEN_THREADS.md` note). **Confirmed this session: zero live
callers anywhere in `server/`.** This is the one clear, concrete "stop settling, use the better
thing" action available right now — wiring `GARCH_VOL_SCALE` into `sizeMultiplier` (or into the
volatility side of any consumer that currently eyeballs range/ATR) is a legitimate, evidence-backed
upgrade over the current ad hoc range-percentile checks, independent of the whole day-type/dtClass
question. Worth scoping as its own follow-up.

**Trend/Balance/Turbulent classification specifically: the honest answer is this is a genuinely
hard forecasting problem this early in a session, not a case of nobody having tried properly.**
`getLiveDayTypeRead()`/the reassessment engine (`dayTypeReassessmentService.js`) is not a naive
rule cascade — its trigger was itself backtested and selected: a fresh range-expansion trigger
(72.6% TPR / 20.4% FPR) was kept; a break-and-hold-outside-IB trigger was tested and **proven to
be noise** (38.9% TPR vs 43.3% FPR — fires MORE on no-change days) and explicitly excluded. The
52.8-68% ceiling likely reflects real uncertainty in predicting a full day's character from a
partial morning read, not a lazy method. Two real (untried, not guaranteed) ways to actually push
past this, in order of effort:
1. **Cheapest, most honest test**: instead of asking "is the existing estimator good enough,"
   train a properly cross-validated model (logistic regression or gradient-boosted trees — nothing
   exotic) on the SAME features already computed live (rots, IB range percentile, close-position,
   order flow) against the SAME real ground-truth label (`classifyGroundTruth()`), with a
   **chronological** train/test split (never random — the confound-checklist convention this
   codebase already uses everywhere else). This directly tests whether a properly fit model beats
   the hand-picked trigger rules, which has never been tried — Regime A/B/C's failure was a
   *different* method (z-score/tercile bucketing validated against PELT changepoints, a stricter
   and differently-defined ground truth), not this same ground truth with a real trained model.
   A negative result here is a real, useful answer too, not a failure to search hard enough.
2. **If (1) doesn't meaningfully beat the current estimator**: accept that ~53-68% may be close to
   the real ceiling this early in a session, and lean harder into the SOFT/DISPLAY role framework
   below rather than chasing a hard-gate-worthy classifier that may not exist yet.

## Recommended framework: match the classifier's role to its accuracy, per consumer

- **HARD gate (binary suppress/allow)** — highest risk of noise-driven false suppression at
  ~53-68% accuracy. `isTrendCounterFade` already tested harmful here. The two `dayTypeOk` gates
  (6228, 6300) are the same risk category and untested — **do not assume they need "fixing"; a
  negative result (live read doesn't help here either) is a fully legitimate, expected outcome**
  given the one data point already in hand.
- **SOFT nudge (a size-multiplier adjustment, not a full block)** — lower stakes per error, since
  being wrong 40-47% of the time only shifts size a little rather than fully blocking a good trade
  or allowing a bad one. `dtaKey` (day-type-alpha sizing) and the OR-expansion-bias `mult` bonus
  are the two real candidates here. This is the most promising untested role for the estimator —
  worth testing first.
- **DISPLAY/badge only** (`eliteZone`, `dayTypeEdge`/`dayTypeWarn`) — lowest risk, purely
  cosmetic. Safe to wire without a backtest, though any user-facing copy should read as an
  estimate ("likely TURBULENT," not "TURBULENT") given the known accuracy ceiling.

## Phased plan for next session

1. **Display-tier wiring** (`eliteZone`, `dayTypeEdge`/`dayTypeWarn`): swap in
   `getLiveDayTypeRead()` directly. Low risk, quick, no backtest required — worst case is a
   badge/description that's sometimes wrong, same as it is blank today.
2. **Soft-tier backtest FIRST, wire only if it wins**: reuse
   `scripts/backtest_trend_gate_suppression.mjs`'s exact methodology (the one that already caught
   `isTrendCounterFade`'s harm) to test `dtaKey`/day-type-alpha sizing and the OR-expansion `mult`
   bonus with the live read swapped in vs. the current skip-entirely behavior. Only wire whichever
   direction wins on real data.
3. **Hard-tier: test each of the 2 untested gates (6228, 6300) individually**, same rigor as #2,
   expecting a plausible negative given the `isTrendCounterFade` precedent — do not treat "the
   live read doesn't help here either" as a failure to fix, it's a real, useful finding either way.
4. **Do not build a new regime/day-type classifier from scratch.** Reuse
   `getLiveDayTypeRead()` — see the track-record section above for why.
5. **Entirely separate from, and does not block on, the IB_BULLISH/IB_BEARISH thread** (already
   suppressed; the redesign's own placebo test already found the corrected thesis fails at the IB
   boundary — see `docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`). This fix is for the rest
   of the level-fade engine (absorption pattern, trend-counter-fade suppression, day-type-alpha
   sizing, OR-expansion bias, elite-zone badge) — IB's day-type conditioning is not part of this
   scope since IB's entry signal itself is likely being retired regardless.

6. **Wire `GARCH_VOL_SCALE` into live sizing** (separate from the day-type/dtClass work above —
   this is volatility magnitude, not day-character classification). Already computed, already
   shows a real modest effect in backtesting, zero live callers today. Independent, lower-risk
   win.
7. **Test a properly cross-validated trend/balance model** (logistic regression or GBT on existing
   live features vs. `classifyGroundTruth()`, chronological split) as a genuine attempt to beat
   the current 52.8-68% estimator — not guaranteed to win, but never actually tried this way.

## Suggested entry point

Start with #1 (display-tier) or #6 (GARCH wiring) for fast, safe wins, or start with #2 (soft-tier
backtest) since it directly answers "is `getLiveDayTypeRead()` actually useful for anything" with
real data. #7 (a real trained classifier) is the most direct answer to "can we do better than the
current estimator" and is worth prioritizing if the goal is genuinely improving day-type forecasts
rather than just wiring the existing one in more places.
