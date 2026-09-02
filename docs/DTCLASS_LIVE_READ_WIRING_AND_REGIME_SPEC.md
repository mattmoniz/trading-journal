# dtClass live-read wiring + "do we need a proper regime classifier" — scope (2026-09-02)

**Status: scoped, zero code changed.** Follow-up to the same-session IB_BULLISH/IB_BEARISH
DeepSeek code review, which found the shared `dtClass`-null bug is bigger than previously tracked
(6-7 real consumers, not 4) and that a fix already exists but was never wired in. User asked to
scope this out plus answer "what about using a proper day-type classifier or regime somehow"
before clearing context. Read this doc fresh before touching `dtClass`/day-type wiring again.

**CORRECTED 2026-09-02 (second DeepSeek pass, self-audited against live code/DB before
accepting):** the first version of this spec (below) had 3 real errors, all now fixed in place —
the consumer inventory undercounted by ~3 sites (missed `acd.js:8288`/`8292`/`8358` plus a
*separate* `standDown` in `playbook.js:309`), `eliteZone` was mis-tiered as "DISPLAY only" when it
actually drives a live `+0.15` size boost (`acd.js:8252`) — meaning the original "Phase 1: no
backtest required" plan would have silently changed live sizing — and the "52.8-68% accurate"
anchor was the optimistic *pooled* figure; the real live-tracked number (`daytype_accuracy_log`,
verified directly against the DB) is **48.6% overall, and by class: BALANCE 65.0%, TREND 23.3%,
TURBULENT 17.8%** — the classes any HARD gate actually depends on are the worst-predicted, not
"~53-68%." GARCH's "independent, lower-risk win" framing was also overstated (see its section).

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
false-positive rate on fade-touch moments specifically. This is the single most important fact
shaping the plan below: **do not assume wiring the fix in is automatically an improvement** — it
already wasn't, once, for real.

**The real live accuracy, not the pooled figure.** `getLiveDayTypeRead()`'s own header quotes a
pooled "~68%" and the static one-shot classifier is separately documented at 52.8% — but the
actual live-tracked table this codebase already maintains
(`daytype_accuracy_log`, read by `caseEngine.js`'s `getDayTypeAccuracyStats()`) tells a sharper
story. Queried directly (2026-09-02): **48.6% overall (201/414)**, and critically, by class:
**BALANCE 65.0% (N=266), TREND 23.3% (N=30), TURBULENT 17.8% (N=118)**. Every HARD-gate consumer
below keys on TREND or TURBULENT specifically — the two classes the live read gets right barely
more than 1-in-5 times. A call on those classes is wrong ~77-82% of the time, not "40-47%." This
is the number that should drive the tiering, not the optimistic pooled one.

## Full consumer inventory (corrected 2026-09-02 — the first pass undercounted)

`dtClass` is read in **at least 10 places in `acd.js`, plus a separate one in `playbook.js`** —
not 7. Behavior under the current permanent `null` differs per consumer — this matters, because
"fixing" a consumer that's currently *accidentally permissive* could newly start blocking trades
that were fine, and "fixing" one that's currently *accidentally restrictive* could newly allow
trades that were being (correctly, by luck) blocked.

| Line | Consumer | Behavior when `dtClass=null` today | Stakes tier |
|---|---|---|---|
| 6228 | `dayTypeOk = dtClass === 'BALANCE'` (an absorption-pattern candidate) | Always `false` → this candidate **never fires** | HARD gate |
| 6300 | `dayTypeOk = dtClass==='TREND' \|\| (nl30-based fallback)` | TREND path dead, but nl30 fallback still works → **partially** restrictive | HARD gate (partial) |
| 7182 | `isTrendCounterFade()`: `if (dtClass !== 'TREND'...) return false` | Always `false` → suppression **never triggers** (real trend-counter fades slip through) | HARD gate — **already tested, live-read swap was net-harmful** |
| 8074 | `eliteZone = dtClass==='TURBULENT' && ...` | Always `false` → badge never shows | **SOFT nudge, NOT display-only** — see 8252 below |
| 8092 | `dtaKey = dtClass ? ... : null` (day-type-alpha size lookup) | `dtaKey` null → SIZE_UP/DOWN/SUPPRESS lookup **skipped entirely**, falls through to default sizing | SOFT nudge |
| 8252 | `if (eliteZone) mult = Math.min(mult + 0.15, 1.5)` | Skipped (since `eliteZone` is always false) → **real live size boost never applied** | SOFT nudge (same root as 8074, not separate) |
| 8285 | OR-expansion-bias `mult` boost, gated on `dtClass==='BALANCE'\|\|'TURBULENT'` | Always `false` → this specific `mult` bonus **skipped** | SOFT nudge |
| 8288 | **MISSED first pass.** Regime-persistence boost: `if (_lfRegimePersist && dtClass==='TURBULENT' && ...) mult += 0.10` | Skipped → boost never applied | SOFT nudge |
| 8292 | **MISSED first pass.** TREND size-down: `if (dtClass==='TREND') mult = Math.max(mult - 0.25, 0.25)` | Skipped → **TREND-day trades are NOT being penalized** (the risky, accidentally-permissive direction) | SOFT nudge |
| 8358 | **MISSED first pass.** `standDown: lfConsecLosses>=2 \|\| (dtClass==='TREND' && lfConsecLosses>=1)` | TREND branch always false → **this consumer's TREND-triggered stand-down never fires**; read live by `MarketPulseBar.jsx` and `quick-check.html`, forces `mult=0` (full skip) when true | HARD gate (partial — the `lfConsecLosses>=2` branch is unaffected) |
| 8339-8350 | `dayTypeEdge`/`dayTypeWarn` display fields | Derived from the (already-null) `dtaRow` above → always absent | DISPLAY only |
| `playbook.js:309` | **MISSED first pass, different file entirely.** `standDown = consecLosses>=2 \|\| (dtClass==='TREND' && consecLosses>=1)` gates a "⛔ STAND DOWN" instruction in the AI coaching prompt | TREND branch always false → coaching never gets this stand-down signal | Separate system, own scope |

Net picture: **not** uniformly permissive or restrictive — a real mix, and the permissive side
(8292, 8358, `isTrendCounterFade`) is the riskier one to leave alone, since it means real trades
that SHOULD be sized down or filtered currently aren't. Any fix must be evaluated per-consumer,
not applied as one blanket swap.

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

**Volatility specifically: a real, better, already-built method exists and is completely unwired
— but it's a minority-effect asset, not a blanket upgrade (corrected 2026-09-02).**
`scripts/backfill_garch_vol_scale_history.py` fits a genuine walk-forward GARCH(1,1) model
(`arch_model(..., vol='Garch', p=1, q=1)`, proper numerical safeguards for near-unit-root fits)
and persists it as `performance_audit` `signal_type='GARCH_VOL_SCALE'` (verified: 317 rows,
2024-12-16 through 2026-07-17). This is a real, statistically principled volatility forecast —
not a heuristic, not a z-score bucket. **Confirmed: zero live callers anywhere in `server/`.**
Two real caveats, both from `backtest_garch_scaled_stop_all_setups.mjs`'s own verdict:
- **It's a minority effect, explicitly "NOT a broad win" per the backtest's own comment.** 28 of
  103 setup_types show a rigor-clean EV improvement on ONE metric; only **2 of 103 improve on
  BOTH** EV and reduced regime-spread. Wiring it as a blanket `sizeMultiplier` factor would apply
  GARCH scaling to the ~73% of setup types it doesn't help (and some it may hurt). The correct
  shape is **per-setup gating** — only wire it in for the types that actually improve — which is a
  meaningfully bigger task than "wire GARCH into live sizing."
- **Coverage is stale**: the table ends 2026-07-17, ~6.5 weeks behind as of this session. A live
  consumer needs a fresh backfill run first or it silently no-ops on any recent date.

Still a real, concrete "stop settling, use the better thing" asset — just scoped correctly: a
per-setup-gated pilot plus a backfill re-run, not a direct live wire-in.

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
   **Tempered expectation (added 2026-09-02):** `classifyGroundTruth()` is a *full-session* label
   (final close position, final range), while live features are necessarily *partial-morning* —
   the existing reassessment engine already documents cases where an early read satisfies the
   ground-truth threshold and the session still closes BALANCE. A trained model can plausibly beat
   the hand rules on the BALANCE majority class (already 65% precision) and on calibration, but the
   TREND/TURBULENT precision that the HARD gates actually need may stay low simply because the
   information isn't there yet that early — that's a real possible outcome, not a reason to skip
   the test. Also: **a more accurate classifier does not automatically mean a better trading
   decision** — `isTrendCounterFade`'s net-harmful result came from a MORE accurate input than the
   dead column; the errors just landed on the moments that mattered. Don't read a future accuracy
   win here as an automatic green light to wire it into a HARD gate.
2. **If (1) doesn't meaningfully beat the current estimator**: accept that the real ~48.6%
   (18-24% on TREND/TURBULENT specifically) may be close to the ceiling this early in a session,
   and lean harder into the SOFT/DISPLAY role framework below rather than chasing a hard-gate-worthy
   classifier that may not exist yet.

## Recommended framework: match the classifier's role to WHICH CLASS it keys on, not just stakes

**Sharpened 2026-09-02, in response to direct user pushback on the accuracy correction above.**
The base rates matter: TREND is only ~7% of real sessions (30/414), TURBULENT ~29% (118/414),
BALANCE ~64% (266/414). A classifier calling TREND at 23.3% precision is *somewhat* above its
~7% base rate — still wrong 3 times out of 4. TURBULENT at 17.8% precision against a ~29% base
rate is **close to indistinguishable from random guessing**. The real split isn't HARD-vs-SOFT
stakes, it's **which class the consumer keys on**:

- **BALANCE-keyed consumers** — real, usable signal (65% precision, meaningfully above base rate).
  `dayTypeOk = dtClass==='BALANCE'` (6228), the BALANCE half of the OR-expansion bonus (8285).
  These are the ones actually worth testing/wiring.
- **TREND/TURBULENT-keyed consumers** — the live classifier offers close to no real information
  here. This applies **regardless of HARD vs SOFT tier**: `isTrendCounterFade` (7182, HARD,
  already tested harmful), the TREND half of 6300 (HARD), `standDown`'s TREND branch (8358 +
  `playbook.js:309`, HARD), the TREND half of the OR-expansion bonus (8285), the TURBULENT
  regime-persistence bonus (8288, SOFT), the TREND size-down (8292, SOFT), `eliteZone`'s TURBULENT
  boost (8074/8252, SOFT). **Do not wire the live read into any of these** — a soft nudge built on
  near-noise-level input is still noise-chasing, just with a smaller loss per mistake than a hard
  gate. The `isTrendCounterFade` result is exactly what this pattern produces.
- **DISPLAY only** (`dayTypeEdge`/`dayTypeWarn`): safe to wire regardless of class, since nothing
  sizing-relevant depends on them — but the copy should still read as an estimate.

**Practical consequence**: the phased plan's soft-tier backtest (#2 below) should test BALANCE-
keyed consumers first and treat that as the real opportunity. TREND/TURBULENT-keyed consumers
should stay untouched until either a properly cross-validated model (#7) shows real precision
improvement specifically on those two classes, or there's some other reason to believe the
live-read's TREND/TURBULENT calls carry more signal than their raw precision suggests.

## Phased plan for next session

1. **Soft-tier backtest FIRST for the real display-adjacent fields** (`dayTypeEdge`/`dayTypeWarn`
   only — the two genuinely cosmetic ones): swap in `getLiveDayTypeRead()`, no backtest strictly
   required since nothing sizing-relevant depends on them, but keep the copy hedged given 48.6%
   real accuracy.
2. **Soft-tier backtest for the BALANCE-keyed consumers only**: reuse
   `scripts/backtest_trend_gate_suppression.mjs`'s exact methodology (the one that already caught
   `isTrendCounterFade`'s harm) to test `dayTypeOk`'s BALANCE gate (6228) and the BALANCE half of
   the OR-expansion bonus (8285) with the live read swapped in vs. the current skip-entirely
   behavior. This is the real opportunity, per the class-conditional accuracy above.
3. **Do NOT wire the live read into any TREND/TURBULENT-keyed consumer yet** (the TREND half of
   6300, `isTrendCounterFade` at 7182, `standDown`'s TREND branch at 8358/`playbook.js:309`, the
   TURBULENT regime-persistence bonus at 8288, the TREND size-down at 8292, `eliteZone`'s TURBULENT
   boost at 8074/8252) — 17-23% precision on exactly these classes means a backtest here is likely
   to reproduce something close to `isTrendCounterFade`'s -$3,238 result regardless of HARD/SOFT
   tier. Revisit only after #7 (a real trained classifier) shows genuine improvement specifically
   on TREND/TURBULENT precision, not just pooled accuracy.
4. **Do not build a new regime/day-type classifier from scratch.** Reuse
   `getLiveDayTypeRead()` — see the track-record section above for why.
5. **Entirely separate from, and does not block on, the IB_BULLISH/IB_BEARISH thread** (already
   suppressed; the redesign's own placebo test already found the corrected thesis fails at the IB
   boundary — see `docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md`). This fix is for the rest
   of the level-fade engine — IB's day-type conditioning is not part of this scope since IB's
   entry signal itself is likely being retired regardless.
6. **Pilot `GARCH_VOL_SCALE` per-setup, not as a blanket wire-in** — re-run the backfill first
   (stale since 2026-07-17), then gate it only for the ~2-28 setup_types that actually showed
   improvement in `backtest_garch_scaled_stop_all_setups.mjs`, not all 103.
7. **Test a properly cross-validated trend/balance model** (logistic regression or GBT on existing
   live features vs. `classifyGroundTruth()`, chronological split) as a genuine attempt to beat
   the current 48.6% estimator — not guaranteed to win (especially on TREND/TURBULENT specifically,
   see the tempered-expectation note above), but never actually tried this way.
8. **Flag separately, independent of IB's fate**: `computeIbBullBear()`'s field-name footgun
   (`caseEngine.js:163-164` uses `b.ask_vol`/`b.bid_vol` with no `|| 0` guard, while the sibling
   `confirmedDeltaDir()` in the same file uses the safe `b.ask_volume || 0`/`b.bid_volume || 0`
   convention). Latent, not active today (current callers all alias correctly), but the function is
   shared/exported and a future caller passing naturally-named DB rows would get silent
   `NaN`→`false` on both `ibBullish`/`ibBearish`. Trivial fix (add `|| 0` guards), low priority,
   but shouldn't get lost when IB itself is retired.

## Suggested entry point

Start with #1 (the two genuinely cosmetic fields) for a fast, safe win, or start with #2 (the
soft-tier `mult` backtest) since it directly answers "is `getLiveDayTypeRead()` actually useful for
anything real" with real data — the more informative next step given only one consumer
(`isTrendCounterFade`) has been tested so far. #7 (a real trained classifier) is the most direct
answer to "can we do better than the current estimator," tempered by the class-conditional
accuracy caveat above.
