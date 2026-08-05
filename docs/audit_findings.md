# Registry Audit — findings

**External audit by Opus, 2026-08-05, built from a static export (`scratch/opus_registry_export/`)
of this codebase's `RESEARCH_CLAIM`/`OPEN_DECISION` history — not live DB access.** Saved verbatim
here per the author's own request, as the durable record for Claude Code (which reads the repo,
not Opus's own memory). See `docs/DECISIONS_LOG.md` for what Claude Code verified, corrected, or
acted on from this document, and `CLAUDE.md`'s "Where to look" for the pointer.

Reviewed: `registry.md`/`.json` (376 rows), `test_invariants_checks.md` + raw output, `README.md`,
`CLAUDE.md` and `OPEN_THREADS.md` (size/structure only).

---

## 1. Two buried walk-forward results say the system's core premise failed

Both dated **2026-07-20**. Both sitting in the 327-row "not re-run" bucket. Neither made the revisit list.

**`overnight_calibration_needs_genuine_fresh_holdout_test`** — RESOLVED (MEDIUM), N=2,618:

> calibration makes things WORSE on genuinely new data — held-out year flat P&L $6,357 vs calibrated P&L −$4,717 (32 combos), only 13/32 combos improve

This is the exact diagnostic proposed from scratch two weeks later — benchmark the optimizer against a flat default — and it had **already been run and already come back negative**. On a held-out year, at N=2,618, doing nothing beat calibrating by roughly $11,000.

**`current_validated_roster_2yr_walkforward_net_negative`** — PROVISIONAL, classified `contaminated-data`, no unblock condition:

> LEGACY_ROLLING is healthy at every DLL tested ($200/$400/$600 → $27,678.77/$19,416.15/$11,602…)

Two things here. The validated roster came back net negative over 2 years while the legacy approach stayed healthy. And the DLL sweep runs **backwards from last night's conclusion** — $200 outperformed $400, which outperformed $600. Tighter risk cap produced better results, not worse.

**Action:** re-run `overnight_calibration_needs_genuine_fresh_holdout_test` on RTH with today's corrected code before any further calibration work. If it reproduces, the self-calibrating premise is the thing to fix, and every downstream stop/target debate is arguing about the paint on a condemned building.

---

## 2. The classifier's blind spot excluded its own most important row

`overnight_calibration_needs_genuine_fresh_holdout_test` scores `touchesBaseSweep: true`, `targetsRrOrBigmove: true`, `preDefectDiscovery: true` — it satisfies every substantive filter. It was dropped because `rejectionReasonClass` came back `N/A (not a tested claim)`, since it's an `OPEN_DECISION` rather than a `RESEARCH_CLAIM`.

The taxonomy has no bucket for **"we tested a load-bearing assumption and it failed."** That's not a rejected idea, so it isn't a rejection; but it's also not a positive finding. It falls through to N/A and then into the 327.

**Fix:** add a `SYSTEM_PREMISE_FAILED` class, and drop the requirement that revisit candidates carry a confident *rejection* classification. Re-run the filter — expect more rows like this one.

---

## 3. Live code isn't reading the calibration (check [8], 9 warnings)

| Type | Calibration says | Actually fires |
|---|---|---|
| CAM_R1_FADE_SHORT | 25 / 40 | **68** / 40 |
| CAM_S4_FADE_LONG | 20 / 40 | **90 / 43** |
| FAILED_AUCTION_LONG | 54 / 26 | **40 / 35** |
| GLOBEX_VWAP_MAGNET_LONG | 20 / 25 | **30 / 20** |
| IB_MID_SCALP_FADE_LONG | 26 / 35 | **57,58 / 31** |
| VWAP_MAGNET_LONG | 30 / 30 | 30 / **20** |
| STOP_SWEEP_LONG | 51 / 35 | **34.25,57.5,23.5 / 29.75,30.5,30.25** |

Two of the nine (IB_BEARISH, IB_BULLISH) are legitimately `DAY_TYPE_MANAGED` and may read a per-day-type bucket. **The other seven have no such excuse.**

The important one: `GLOBEX_VWAP_MAGNET_LONG` fires **30/20**. An entire session was spent selecting between 30/25, 52/40 and 100/60 for this type — none of which the live path appears to consume.

There is also a closed-loop failure here worth naming:

- `vwap_magnet_hardcoded_stop_target_never_calibrated` — RESOLVED (HIGH), 2026-08-02, "acd.js now reads `getCached(...)?._opt?.[type]` instead of hardcoded 30/20/90/40"
- `verify_vwap_magnet_calibrated_stop_target_fires_live` — RESOLVED (**LOW**), "could not be verified end-to-end"

A fix was marked resolved, its verification was downgraded to LOW and closed unverified, and check [8] now shows the old 30/20 values still firing. **Verify this one before anything else in this document.** If live code doesn't consume `OPTIMAL_STOP`, the entire calibration pipeline is decorative.

---

## 4. 43% of rejections died to a bug, not to evidence

Of 148 confidently-classified rejections:

| Class | Count | Share |
|---|---|---|
| `genuinely-negative-clean` | 51 | 34% |
| `logic-bug` | 45 | 30% |
| `failed-gate` | 28 | 19% |
| `contaminated-data` | 19 | 13% |
| `data-limited` | 5 | 3% |

**64 of 148 (43%)** were killed by a defect in the test or the data. Only about a third died on clean evidence.

This was already diagnosed. `compute_replication_helper_and_confound_checklist`, from **Opus Audit #4 on 2026-07-21**, records that "the same confound-then-retraction pattern has recurred ≥5 times across ~5 sessions." It recurred at least three more times on 2026-08-04 (the bigmove N=53 misread, the p40 baseline mismatch, the compression trade-level routing).

Naming a recurring pattern in a decision record hasn't stopped it recurring. The pre-flight checklist needs to be a script that runs, not a convention that's remembered.

---

## 5. Volatility clustering was confirmed two weeks before it was rediscovered

- `volatility_regime_roster_wide_ev_effect` (2026-07-23) opens: *"Tests whether the **already-confirmed** volatility-clustering finding (big moves follow already-elevated volatility)…"*
- `audit_stale_ib_range_squeeze_claim` (2026-07-23, still PENDING/LOW) flags that `scripts/runner_leg_backtest.mjs` contains a hand-typed conclusion asserting the **opposite**: *"Tight IB range days indeed lead to significantly larger MFE extension"*

So: the correct finding was confirmed on 07-23, a stale claim contradicting it was flagged the same day and never removed, and on 08-04 the whole thing was derived again from scratch at the cost of most of a session.

**Action:** close `audit_stale_ib_range_squeeze_claim` now — last night's 369-session result settles it. Then cross-link the three volatility-clustering claims so the next session finds one thread instead of three.

---

## 6. The docs are past the size where they can function

| File | Size | ~Tokens |
|---|---|---|
| `CLAUDE.md` | 219 KB | ~55,000 |
| `OPEN_THREADS.md` | 386 KB | ~97,000 |
| **Combined** | **605 KB** | **~152,000** |

No session reads 152k tokens of standing documentation and still has room to work. This is the mechanism behind §5 — the rules and prior findings exist, they're just not reachable in practice. `CLAUDE.md` is only 224 lines for 219 KB, so it's dense prose rather than scannable structure.

**Fix:** split `CLAUDE.md` into a ≤300-line `CLAUDE.md` holding only the hard rules and conventions, plus `docs/` files for everything else. Archive `OPEN_THREADS.md` entries older than 30 days into a dated file. Target: the always-read portion under 10k tokens.

Related, from check [10]: **160 of 172 claim source scripts are not wired into any recurring cron.** 93% of findings run once and are never revalidated.

---

## 7. Revisit list — the four worth actually re-running

From the 25, ranked by expected value:

1. **`mfe_runner_target_widening_mining`** (2026-07-17, `active_setups N` + `base sweep`) — tested widening the target cap past `p75_mfe` up to `p95_mfe`; concluded the effect is "real but SMALL." Measured on the censored MAE surface with the base sweep, pre-defect. This is *the* big-move capture question, and the uncensored bar-history surface now exists to answer it properly.

2. **`risk_adjusted_stop_target_pilot_promising_unproven`** (2026-07-30, `contaminated-data`, MAE%ile + base sweep) — the Calmar attempt. Risk-adjusted objectives want tight stops; tight stops are exactly where the censoring bias was worst. Its failure is fully explained by the defect.

3. **`stop_target_ratio_9729_finding_was_measurement_artifact`** (2026-08-03) — worth reading rather than re-running. The "97% of setups have stop wider than target, median 1.67" finding that **motivated the entire risk-management priority** was itself an artifact of the `optStopQ` column-read bug. Check [9] now reports a live-firing median of **1.00**. The R:R problem may be materially smaller than the premise assumed.

4. **`ib_bearish_mfe_left_on_table_20260727`** (ambiguous list, PROVISIONAL) — winners leave a median 6pt of MFE past target, sign-consistent across all three thirds. Small, but it's direct evidence for target widening and it's never been resolved either way.

**Skip** `value_area_responsive_short_runner_followup` — its sibling `promote_scaleout_runner_value_area_responsive_short` was retracted for sourcing baseline EV from `OPTIMAL_STOP.ev_per_trade` instead of resimulating. Same bug, already known.

---

## 8. Improvements worth shipping

**Pre-flight script for every backtest.** Make the recurring confound classes mechanically checkable rather than remembered: `origin_status` filter present; baseline resimulated, never read from a stored column; chronological ordering explicit (`ORDER BY`); no lookahead in any derived field; instrument constants match MNQ. Five assertions covering most of the 45 `logic-bug` rejections.

**Add `SYSTEM_PREMISE_FAILED` to the taxonomy** and re-run the filter (§2).

**Wire check [8] from WARN to FAIL** for non-`DAY_TYPE_MANAGED` types. A live path not reading its own calibration is not a benign mismatch.

**Ban RESOLVED-without-verification.** `verify_vwap_magnet_calibrated_stop_target_fires_live` was closed at LOW priority explicitly stating it couldn't be verified. If a fix can't be verified, the decision stays open.

**Add z-score trend to `computeRigor`.** `add_z_score_trend_to_rigor_stability_gate` is already filed. Last night it was the only thing that separated a strengthening edge from a decaying one where the sign-only gate scored both identical. This is a validated upgrade sitting unbuilt.

---

## 9. Two new failures from tonight's fresh run

Check [13] flagged `GLOBEX_VWAP_FADE_SHORT` (10pt) and `PD_CLOSE_FADE_LONG` (14pt), both below the 18.4pt noise floor. Both are new since the earlier run.

The circuit breaker shipped on 08-04 was supposed to prevent exactly this. Check [12] reports no tripped breaker. So either these stops were already below the floor when the breaker was armed and it only guards *changes*, or the breaker isn't covering this path. Worth knowing which — it determines whether the breaker works.
