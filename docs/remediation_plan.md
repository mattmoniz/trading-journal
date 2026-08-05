# Remediation Plan

**External plan by Opus, 2026-08-05, sequenced from `docs/audit_findings.md`. Saved verbatim per
the author's own request. See `docs/DECISIONS_LOG.md` for what was actually verified/done and
where reality diverged from this plan's assumptions (notably §Phase 1's framing of the holdout
test — see the log for the correction).**

Sequenced so each phase gates the next. **Do not skip ahead** — Phase 1 can make Phases 2–3 unnecessary, and Phase 2 makes Phase 3 meaningful. Every phase has an explicit stop condition.

---

## Phase 0 — Stop the bleeding (today, ~2 hours)

Three items, none requiring analysis or a decision.

### 0.1 Verify whether live code reads `OPTIMAL_STOP` at all — **do this first**

Check [8] shows nine live types firing stops that don't match their calibration. Two are legitimately `DAY_TYPE_MANAGED`. Seven aren't.

Read `server/routes/acd.js` for each of the seven and answer one question per type: **does the setup-construction path read `getCached(...)?._opt?.[type]`, or a hardcoded value, or a different field?**

Specifically:
- `CAM_R1_FADE_SHORT` (calibration 25, fires 68)
- `CAM_S4_FADE_LONG` (20/40, fires 90/43)
- `FAILED_AUCTION_LONG` (54/26, fires 40/35)
- `GLOBEX_VWAP_MAGNET_LONG` (20/25, fires 30/20)
- `IB_MID_SCALP_FADE_LONG` (26/35, fires 57–58/31)
- `VWAP_MAGNET_LONG` (30/30, fires 30/20)
- `STOP_SWEEP_LONG` (51/35, target never matches)

`vwap_magnet_hardcoded_stop_target_never_calibrated` was marked RESOLVED on 2026-08-02 claiming these now read `getCached()`. `verify_vwap_magnet_calibrated_stop_target_fires_live` was then closed at LOW priority saying it couldn't be verified end-to-end. The 30/20 values in check [8] are the exact hardcoded pair that fix was supposed to remove.

**Why this is first:** if live code doesn't consume the calibration, every phase below is optional and the real bug is a disconnected pipeline. This is a 30-minute read that could reframe everything.

### 0.2 Fix the two sub-noise-floor stops

`GLOBEX_VWAP_FADE_SHORT` at 10pt and `PD_CLOSE_FADE_LONG` at 14pt, both under the 18.4pt floor. Same signature as the 8pt incident.

Also answer: **why didn't the circuit breaker catch these?** Check [12] reports nothing tripped. Either they were already below the floor when the breaker was armed (it guards *changes*, not *levels*), or the breaker doesn't cover this path. That answer determines whether the breaker actually works.

### 0.3 Ship the stop-side `origin_status` filter

The stop value has still never been filtered. Use the documented re-baseline plan: snapshot → filter → run once with the breaker bypassed → snapshot/diff → re-arm. Without the bypass, the breaker will reject the corrections and preserve the synthetic-derived values.

---

## Phase 1 — Answer the existential question (one session)

**Re-run `overnight_calibration_needs_genuine_fresh_holdout_test` for RTH, with today's corrected code.**

The original (2026-07-20, N=2,618) found calibration made things *worse* on a held-out year: flat P&L $6,357 vs calibrated −$4,717, with only 13 of 32 combos improving. That test was overnight-only and predates every fix since.

Design:
- Fit stop/target on data through month T, apply to T+1, roll forward
- Compare against one flat global stop/target applied to everything
- Report cumulative P&L and return-to-drawdown for both
- Run per-setup-type as well as aggregate — the answer may differ across types

### Stop condition

| Result | What it means | Next |
|---|---|---|
| Calibration beats flat | Pipeline earns its keep | Phase 2 |
| Flat beats calibration | Per-type calibration is overfitting | **Stop.** Replace the pipeline with volatility-scaled defaults and skip Phases 2–3 |
| Mixed by type | Only some types support calibration | Calibrate the subset that wins, flat-default the rest |

This is the highest-leverage single test available. Run it before building anything else.

---

## Phase 2 — Fix the measurement (one to two sessions)

Only if Phase 1 says calibration is worth keeping.

### 2.1 Break the censoring feedback loop

`mae_points` stops accumulating when a trade resolves, so the MAE distribution is censored by the live stop, and `sweepOptimalStopAndTarget()` uses that censored distribution as its candidate grid. Tight stop → tight MAE → tight candidates → tight stop.

Two columns, not one:
- `mae_points` — unchanged, censored at resolution, for P&L accounting
- `mae_points_uncensored` — walk to session close regardless of resolution, for calibration only

Backfill the second from bar history. Then change the candidate grid to draw from the uncensored column.

### 2.2 Replace the candidate grid entirely

Better than 2.1 alone: stop deriving stop candidates from the setup's own trade history at all. Build them from the **uncensored bar-history stop-out/target-hit surface** already constructed on 2026-08-04 — for every signal instance in multi-year bars, the stop-out rate and target-hit rate at each candidate (S, T).

This removes the circularity at the source rather than patching the input. It also gives N in the hundreds-to-thousands instead of dozens.

### 2.3 Select from a plateau, not an argmax

Smooth the EV surface across adjacent cells and choose the center of the broadest positive region. Isolated peaks on thin N are noise. The plateau logic already inside `computeCorrectedTarget()` becomes the primary selection rule rather than an override.

### 2.4 Re-baseline all 130

Snapshot, run, diff, review the largest movers by hand, re-arm the breaker.

---

## Phase 3 — The overlooked setups

Only after Phase 2. Re-running these against the broken surface reproduces the original wrong answer.

**1. `mfe_runner_target_widening_mining`** (2026-07-17) — the highest-value one. Tested widening the target cap past `p75_mfe` up to `p95_mfe` across all 71 types with N≥20; concluded "real but SMALL." Measured on the censored surface with the base sweep. This is directly the big-move-capture question, and it now has an uncensored surface to run against. **If one thing gets revisited, make it this.**

**2. `risk_adjusted_stop_target_pilot_promising_unproven`** (2026-07-30) — the Calmar attempt. Risk-adjusted objectives prefer tight stops; tight stops are exactly where the censoring bias was worst. Its failure is fully explained by the defect, so it deserves one clean run.

**3. `ib_bearish_mfe_left_on_table_20260727`** — winners leave a median 6pt of MFE past target, sign-consistent across all three thirds, never resolved either way. Small but direct evidence for target widening.

**4. `stop_target_ratio_9729_finding_was_measurement_artifact`** — read, don't re-run. The "97% of setups have stop wider than target, median 1.67" finding that motivated the entire risk-management priority was an artifact of the `optStopQ` column-read bug. Check [9] now reports a live-firing median of **1.00**. Update `prioritize_risk_management_over_signal_research` to reflect the corrected number — the priority may deserve demotion.

**Skip** `value_area_responsive_short_runner_followup` — its sibling was retracted for the same baseline-sourcing bug.

### Also still open from 08-04/05

- **The IB rule with day-type as a required second condition.** Top-decile IB predicts a wide day at 73%, but 53% of those are TURBULENT and only 17% TREND. The inverted version — *take profits faster* on wide-IB days — is untested and is the live lead.
- **The `_TRAIL` prerequisite.** Five of six live-wired trail variants have never engaged their trail mechanism. Runners are the leading remedy for the big-move problem, and the machinery that would implement it doesn't work.
- **Globex vs RTH VWAP magnet divergence.** Same config, opposite results. Unexplained.

---

## Phase 4 — Prevention

Ship alongside the above, not after.

### 4.1 Pre-flight assertion script for every backtest

43% of rejections (64 of 148) died to a logic bug or contaminated data. The same confound pattern was documented as recurring five times back on 2026-07-21 and has recurred at least three times since. A convention isn't stopping it; a script will.

Five assertions:
1. `origin_status` filter present in the trade query
2. Baseline resimulated in-script, never read from a stored column
3. Explicit `ORDER BY` wherever chronological order matters
4. No same-day or future data in any derived field
5. `$/pt` constants match MNQ, not NQ

### 4.2 Split the documentation

`CLAUDE.md` (219 KB, ~55k tokens) plus `OPEN_THREADS.md` (386 KB, ~97k tokens) is ~152k tokens of standing docs. No session reads that and still has room to work — which is why volatility clustering was confirmed on 07-23 and rediscovered from scratch on 08-04.

- `CLAUDE.md` — ≤300 lines, hard rules and conventions only
- Everything else — `docs/`
- `OPEN_THREADS.md` entries older than 30 days — dated archive files
- Target: always-read portion under 10k tokens

### 4.3 Close the stale contradiction

`audit_stale_ib_range_squeeze_claim` (flagged 07-23, still PENDING) — `scripts/runner_leg_backtest.mjs` contains a hand-typed claim that tight IB days lead to larger MFE extension. The 369-session result disproves it. Delete the claim and close the decision.

### 4.4 Smaller items

- **Check [8] WARN → FAIL** for non-`DAY_TYPE_MANAGED` types. A live path ignoring its own calibration isn't benign.
- **Ban RESOLVED-without-verification.** If a fix can't be verified end-to-end, the decision stays open. This is how the 30/20 hardcode survived being "fixed."
- **Add `SYSTEM_PREMISE_FAILED`** to the registry taxonomy and re-run the filter. The most important row in the export was excluded because "we tested an assumption and it failed" has no bucket.
- **Add z-score trend to `computeRigor`** — already filed as `add_z_score_trend_to_rigor_stability_gate`. It was the only thing that separated a strengthening edge from a decaying one where the sign-only gate scored both identical.
- **Wire the 12 claims missing unblock conditions** (check [11] warnings).

---

## Trading posture while this runs

Unchanged from 08-04, and Phase 0.1 may reinforce it:

- Signals from the app, stops set by hand — structural invalidation plus a volatility buffer
- Hard stop after 2 losses, independent of the $400 DLL
- Flat by 1PM unless the trade is already working
- Size fits the stop; never tighten the stop to fit the size
- Shadow-track `GLOBEX_VWAP_MAGNET_LONG` at 100/60, expecting ~$6.69/trade rather than the $22.18 headline

One correction from the audit: the 2-year walk-forward found **tighter** DLLs performed better ($200 → $27,678, $400 → $19,416, $600 → $11,602). The conclusion that you need $1,000–1,200 of DLL headroom rests on one cell of one surface. That data points the other way, and it argues for fewer, better trades rather than a larger cushion.

---

## If you only do three things

1. **Phase 0.1** — verify whether live code reads `OPTIMAL_STOP`. 30 minutes, and it may reframe the whole system.
2. **Phase 1** — re-run the holdout test. It decides whether the calibration pipeline should be fixed or deleted.
3. **Phase 4.2** — split the docs. It's the mechanism behind the rediscovery loop, and nothing else stops it.
