# Design critique — `docs/MECHANISM_DECOMPOSITION_PREREG_20261026.md` (mechanism decomposition of the two survivors)

**Mode:** read-only critique. No code executed, no DB run, no source file edited except this report. Written 2026-10-26, before any outcome is computed.

## Verification status (what I actually read vs. UNVERIFIED)

**Verified against real files:**
- `docs/MECHANISM_DECOMPOSITION_PREREG_20261026.md` (full), `docs/BAR_CONTEXT_STUDIES_PREREG_B_20261026.md`, `reports/deepseek_bar_context_prereg_B_2026-10-26.md`.
- `scripts/build_mtf_touch_events_20261026.mjs` — the Part B builder the new `build_level_touch_events_20261026.mjs` will copy its touch rule/exclusions from. Touch rule (lines 40–55): level must have an `OPTIMAL_STOP` row for the fade direction; bar index `>= a+5`; `mod(gi) >= max(575, gate)` (OR5 09:35, OR10 09:40, OR15 09:45, OR30 10:00, IB 10:30); `|close - level| <= 15`; direction `long = !(C[gi-5] < C[gi])`; `break` = once per level per day; touches sharing a bar collapsed to one. Buckets (line 50): `FIRST_HOUR < 10:30`, `MID 10:30-14:30`, `LAST_90 >= 14:30`. `ret60` is `null` when `gi + 60 > b - 1` (line 47) — i.e. unavailable for touches after **15:00**.
- `scripts/lib/pocJoinLoader.mjs` — `loadBars` (flat arrays), `sessionIndex` (`rth [a,b)` per date, `atr20 = mean RTH range of 20 prior sessions`).
- `scripts/calibrate_live_roster.mjs` — selection population is `trade_date >= '2026-07-09'` (line 72); survivors pass `ci.lo > 0 && h1 > 0 && h2 > 0` on cluster-collapsed live `actual_pnl`.
- `server/services/rigorDiagnostics.js` — `dayBlockedBootstrapCI` (resamples whole days with replacement, pools trades), `dayBlockedBootstrapDeltaCI` (same, for a two-group delta), `collapseClusterSiblings`.
- `server/routes/acd.js:3742` — the live RTH fade direction rule: `approachDir = last5[0].close < currentPrice ? 'FROM_BELOW' : 'FROM_ABOVE'` with `isLong = approachDir === 'FROM_ABOVE'`. **This is algebraically identical to the replay's `long = !(C[gi-5] < C[gi])`** (price fell over 5 bars ⇒ long fade). The direction rule is therefore NOT the fairness problem; the exit/gates are (see S2).
- `scripts/update_optimal_stops.mjs:1356` — `OPTIMAL_STOP` rows are written with `window_days = 9999` (full-history, in-sample).

**UNVERIFIED (DB-dependent; per the task I could not run the database):**
- All sample sizes: touches per cell, distinct days, per-arm counts, and the SD of `ret60`. The power estimate below is a formula plus clearly-labelled assumptions.
- The "+14 per trade", "247 tested types", "~6 false passes expected", "3 passed" figures — quoted from the prereg, not independently recomputed.
- Whether the live proximity check uses bar **close** vs **high/low** (the replay uses close); the exact live entry price; and whether `level_prices` for same-day levels (OR/IB) is formation-time-causal (the codebase has a documented history of same-day-level lookahead bugs, e.g. the `3M_VAH/3M_VAL/3M_POC` bug in `ARCHITECTURE.md`).

---

## Executive severity ranking

| # | Severity | Finding | Q |
|---|----------|---------|---|
| S1 | **Critical** | The `e` axis is **degenerate and family-confounded**: for a touch that is itself a new session high/low, `e` is exactly 0 or 1 by construction, and `top-tercile e` re-sorts the survivors' own "fade a fresh extreme" shape. A SHOWN `E_short`/`E_long` would be near-tautological, not a mechanism. | (b) |
| S2 | **Critical** | Test 0's **NOT REPLICATED → "no out-of-window support"** consequence is too strong: `ret60` (exit-free, gate-free) tests only the raw entry signal, not the live trade (calibrated `OPTIMAL_STOP` exit + `sizeMultiplier`/suppression gates + `actual_pnl`). A null on `ret60` is consistent with "the edge lives in the exit/gates", not "no edge". | (a) |
| S3 | **High** | `ret60` requires `t+60 <= last RTH bar`, so **every touch after 15:00 is silently dropped from the outcome** (only "counted"). This is selection on the outcome variable and makes the `LAST_90` bucket a partial population. | (c) |
| S4 | **High** | The control is a **random bar with an inherited `f`, not conditioned on being near a level or near a day-extreme**. Excess therefore conflates "at this level" with "at an intraday extreme + 5-bar reversal". A REPLICATES cannot be attributed to the level. | (a) |
| S5 | **High** | `1/nLevels` weighting is **mis-specified for per-cell (Test 0) and per-family (Test 2) statistics**: a touch that co-fires with other levels is down-weighted in its *own* cell. The weight is only correct for the pooled Test 1. `nLevels` may correlate with the outcome (confluence). | (a),(c) |
| S6 | **Medium** | **Power not stated a priori**; the smallest resolvable effect is ≈ the claimed +14/trade, so a NOT REPLICATED could be a false null from insufficient power. | (a) |
| S7 | **Medium** | **In-sample level universe**: `OPTIMAL_STOP` rows are `window_days=9999` and the builder filters levels by *any* such row (no run_date bound), so the testable level set leaks full-window information into the pre-2026-07-09 test. Mild for Test 0 (structural levels), material for Test 2. | (c) |
| S8 | **Medium** | **Multiplicity**: 2 (Test 0) + 4 (Test 1) + 14 (Test 2) = 20 tests run as **two separate BH families (q=0.10 each)** with no joint statement; Test 0's 2 cells have no stated adjustment; mirror/selection-window cells are "descriptive" but p-hacking-tempting. | (b) |
| S9 | **Medium** | `b` axis confounds (rare "true" arm, gap/day-of-week, correlated with `e`), tercile-vs-binary asymmetry, and the dropped **middle tercile** (misses non-monotonic effects). | (b) |
| S10 | **Low** | Control time-bucket is a coarse 75-min window; the control bar may itself be within 15pt of a level (not excluded); "both chronological halves positive" uses point estimates without half CIs; `level_prices` causality for same-day levels unverified. | (a),(c) |

---

## (a) Test 0 — out-of-window replication

**Is the date split really out of the selection window? Yes — verified.** `calibrate_live_roster.mjs` selects on `trade_date >= '2026-07-09'` (line 72); Test 0 uses dates strictly `< 2026-07-09` (2023-03..2026-07-08). The pre-window data is almost entirely unseen by selection. Two residual leaks remain (S7): (i) the level *universe* is defined by `OPTIMAL_STOP` rows whose `window_days = 9999` covers the test window, and the builder has no run_date bound; (ii) the survivors themselves were *chosen* from the post-window data, so the cell identities (`IB_HIGH` short, `WS1` long) are selected — that is exactly what a replication is for, but it must be said that this is not a clean "unseen" test of the *cells*, only of the *dates*. For the two structural levels involved this is minor; for Test 2's 14 family cells it is material.

**Is the replay touch rule a fair test of the live setups? Direction yes, exit no.**
- **Direction (verified consistent):** `acd.js:3742` uses `last5[0].close < currentPrice ? FROM_BELOW : FROM_ABOVE` with `isLong = FROM_ABOVE`. The replay's `long = !(C[gi-5] < C[gi])` is the same mapping (5-bar down-move ⇒ long fade). So the "5-bar approach" *is* the live rule, and this part is fair.
- **Entry proximity (UNVERIFIED):** the replay requires `|close - level| <= 15`; I could not confirm the live detector uses close rather than high/low, and the exact live entry price. A high/low-proximity live rule would fire on wicks the close-based replay misses.
- **Exit (the real mismatch, S2):** the live edge was measured as `actual_pnl` under calibrated `OPTIMAL_STOP`/target exits and the `sizeMultiplier`/suppression gate stack, on **live-fired** rows. Test 0 uses an exit-free 60-minute forward return on **raw, ungated** touches. A REPLICATES on `ret60` is genuinely strong (entry edge survives exit removal) — but a NOT REPLICATED on `ret60` is *not* evidence of "no edge"; it is only evidence of "no *entry-only, gate-free* edge". The prereg's frozen consequence ("flag an OPEN_DECISION that the two roster types have no out-of-window support") is therefore over-broad. It also never uses the secondary ±0.5 ATR20 sim to qualify a negative.

**Is the matched control the right comparator? It is a drift/time baseline, not a level-specificity control (S4).** The control (random RTH bar, same session, same time bucket, same `f`, 20 draws) removes NQ drift and time-of-day, which is correct as far as it goes. Its flaws:
1. **Not conditioned on being near a level or near a day-extreme.** A `WS1` long touch happens at a session low with a 5-bar down-move; its 60-min forward return has a mean-reversion component from *being at an extreme in the fade direction* that a random bar (assigned the same `f`) does not. Excess therefore measures "fade + at-a-level + at-an-extreme" vs "random moment", not "this level" vs "somewhere else". The prereg honestly admits this in "Honest expectations", but the *verdict labels* (`REPLICATES`) then over-attribute the result to the cell. The mirror cells (`IB_LOW` long, `WR1` short) partially expose this but are explicitly *descriptive/untested*.
2. **`f` is inherited, not derived.** The control bar's own 5-bar direction is ignored; only the touch's `f` is copied. So the control does not net out the 5-bar reversal premise (momentum/mean-reversion of the 5-bar move itself), which is a genuine component of the signal being tested. Fine *if* the claim is "the whole setup replicates", but it means a positive excess is not specific to the level.
3. **First-hour control is coarse.** A 09:35 `WS1` touch is controlled by any bar in 09:35–10:29; the control's 60-min horizon then lands in a different intraday-seasonality window than the touch's. Minor but real.
4. The control bar may itself be within 15pt of a level (not excluded), so the "baseline" is mildly contaminated by level-touch structure.

**Are the verdict categories sound? Mostly, with two caveats (S6, S8).**
- The four-way mapping (REPLICATES / DIRECTIONAL / NOT REPLICATED / REVERSES) is clean and asymmetric in the right direction (a REVERSES requires `CI_hi < 0`, a strong negative statement). Good.
- **Caveat 1:** "both halves positive" uses bare point estimates of two chronological halves; a half with +0.0001 counts the same as a strongly positive half, and there is no CI on each half. A single 50/50 date split also cannot catch an era boundary landing mid-half.
- **Caveat 2:** no multiplicity is stated for the 2 cells (both are pre-specified survivors, so per-cell reporting is defensible — but it should be *said*).

**Is the power statement adequate? No (S6).** The prereg only promises to report "the CI half-width (the smallest effect this sample can resolve)" *post-hoc*. It does not commit to an expected N or SD up front, so it cannot honestly claim a resolvable effect before running. My estimate (UNVERIFIED — I could not run the DB):
- One touch per (level, day) ⇒ per cell at most ~1 event/day; over ~750 excludable pre-window trading days, expect roughly **150–400 touches per cell** (IB_HIGH more, WS1 less — UNVERIFIED).
- `SD(ret60)` in ATR20 units is plausibly **0.3–0.5** (a 60-min move normalised by a 20-day range); `SD(excess) ≈ SD(ret60)·√(1 + 1/20) ≈ same`.
- Day-blocked SE ≈ `SD / √(N_days)`; with N_days 150–400 ⇒ SE ≈ **0.015–0.04**, CI half-width ≈ **0.03–0.08 ATR60**.
- At ATR20 ≈ 150–250 pt and $2/pt, that is roughly **$10–40/trade**. The claimed live edge is **+$14/trade ≈ 0.03–0.05 ATR60** — i.e. *at or below the resolution floor*. A genuine edge of the claimed size can come back NOT REPLICATED. This must be stated as a power caveat, not left to a post-hoc half-width.

---

## (b) Test 1 — pooled mechanism axes

**Look-ahead: neither `e` nor `b` is look-ahead, but `e` is mechanically degenerate.**
- `e` uses day high/low through bar `t` (entry `open[t+1]`) — no look-ahead. `b` uses the prior session's RTH high/low, fully realised at today's open — no look-ahead.
- **The problem is not look-ahead but degeneracy + mechanical tie (S1).** For a short fade, `e = (C[t] − dayLow)/(dayHigh − dayLow)`. The short fade fires when price *rose* over 5 bars; if that rise also makes bar `t` a new session high, then `e = 1` exactly (and for a long-fade new low, `e = 0` exactly). Because `dayHigh`/`dayLow` include bar `t`'s own high/low, **every new-extreme touch has a degenerate `e` ∈ {0,1}**, and the top tercile is dominated by new-high (short) / new-low (long) touches — which are precisely the survivors' own stop-run/exhaustion shape, and which concentrate in high-type (IB_HIGH/WR1/OR-high/PD_HIGH) vs low-type levels. So "top-tercile `e`" is not an independent extremity axis; it is a rough re-sort of level family × "is this a fresh extreme", and a SHOWN `E` would mostly re-confirm that the survivor shape has an edge. The stratified SHOWN rule (family × bucket) softens but does not remove this, because the tercile cut is computed pooled over all families.
- **Fix:** define `e` on the *prior* bar's position, `e_prior = (C[t−1] − dayLow_{t−1})/(dayHigh_{t−1} − dayLow_{t−1})` (range through `t−1`), or use a rank percentile of `C[t]` rather than the boundary-degenerate normalisation; alternatively split `e` into a binary "is new session high/low" flag and test that separately. At minimum, report the count of `e ∈ {0,1}` (degenerate) touches and the level-family composition of each tercile before any verdict.

**Is the tercile comparison (explore-only cuts, weights 1/nLevels) sound?**
- Explore-only tercile cuts applied to hold-out: correct and look-ahead-free. Per-direction terciles (separate cuts for long vs short) are also right given `e`'s opposite meaning per direction.
- **1/nLevels is wrong at the arm level for this comparison in one respect (S5):** within a *pooled* Test 1 the weight correctly collapses a bar firing N levels into one vote. But the two arms are defined by `e`/`b` of the *bar*, which is identical for all rows sharing the bar, so the weight is doing no work for arm assignment — it only matters for the *statistic*, and there it is fine *provided* the bootstrap re-applies the same per-row weights and the control's 20 draws are weighted by the touch's `1/nLevels`. The prereg says the bootstrap "pools trades per arm in each draw" but never states that weights are honoured — that must be pinned down, or the CI will not bracket the point estimate.
- **Middle tercile dropped:** top-vs-bottom ignores the middle third and cannot see a non-monotonic (e.g. U-shaped, or "interior touches best") effect. Report the middle tercile descriptively and add a monotonicity check.

**Is BH over 4 tests + 14 family cells treated as separate families defensible? Only with disclosure (S8).**
- The 4 Test-1 p-values and (up to) 14 Test-2 p-values are separate BH(q=0.10) families, but the *total* is 18–20 hypothesis tests, and `E` and `B` are correlated (a touch beyond yesterday's high is usually near today's high ⇒ high `e`), so the "4 independent tests" premise is loose. The hold-out + stratified + sign gate is the real protection and is strong, but the prereg should state the total test count and the reason for the split, and should *not* let the "descriptive" mirror/selection-window cells be read as confirmatory. Recommend one joint statement: "20 tests across 3 families; family-wise FDR controlled at q=0.10 within Test 1 and Test 2, Test 0 reported per pre-specified cell without adjustment; descriptive cells carry no multiplicity credit and are not confirmatory."

---

## (c) Confounds the prereg misses

1. **`ret60` horizon truncation (S3).** Touches after 15:00 have no `t+60` and are dropped from *all* outcome tests. This removes the last ~60 minutes of every session — the period where late fades resolve into the close — and biases both the sample and the `LAST_90` bucket. The ±0.5 ATR20 secondary sim instead runs to the close, so late touches get a *shortened* exit window there; the two outcomes are not on the same population. Fix: report the dropped count prominently and add a "held-to-close" variant (exit at `b−1`) so late touches are scored on an equal footing.
2. **Same-day level / IB timing.** IB touches can only exist from 10:30 (gate), so `IB_HIGH` short has zero first-hour representation and its touches are structurally late-morning; for an `IB_HIGH` touch the day high through `t` is ≈ the IB high, making `e ≈ 1` almost deterministically (feeds S1). The prereg's `e` axis is therefore nearly useless *within* the IB family.
3. **In-sample level universe (S7).** `OPTIMAL_STOP` rows are `window_days=9999`; the builder's `SELECT DISTINCT signal_name … WHERE signal_type='OPTIMAL_STOP'` has no run_date bound, so the set of testable levels (and which families are "in") is defined by full-window calibration. Material for Test 2, mild for Test 0.
4. **Day-clustering / era.** The CI is day-blocked (correct), but the explore screening "two-sided bootstrap p" must also be day-blocked (the wording is ambiguous — pin it down). Test 0 lacks the era split that Tests 1/2 get for SHOWN cells; add pre/post-2025-06 and an annual breakdown to Test 0.
5. **`b` confounds (S9).** `b=true` requires price beyond yesterday's range, which on gap/Monday opens is trivially satisfied — `b` is partly a gap/day-of-week indicator, not a clean "expansion beyond yesterday" axis. `b=true` is also rare (imbalanced arm) and correlated with `e≈1`. Expect the `B` tests to be underpowered and non-independent of `E`.
6. **Confluence weighting (S5).** `nLevels` (levels sharing a bar) may correlate with `ret60` (multi-level confluence is itself a documented signal in this codebase). Down-weighting by `1/nLevels` then biases the cell/arm means rather than merely reducing precision.
7. **`level_prices` causality for same-day levels (UNVERIFIED).** Same-day OR/IB prices must be formation-time-causal; the codebase has a documented history of same-day-level look-ahead bugs. Verify before trusting any same-day-family result.

---

## (d) What could produce a false SHOWN, a false null, and required additions

**False SHOWN risks:** (i) `E` SHOWN via the S1 degeneracy (re-finding the survivor shape, not a mechanism); (ii) a positive excess that is really "fade the intraday extreme" (S4 control) mis-labelled as a level effect; (iii) the in-sample level universe (S7) inflating Test 2; (iv) the 20-test surface with two separate BH families and tempting "descriptive" cells (S8).

**False null risks:** (i) marginal power at the +14 effect size (S6); (ii) exit/gate mismatch turning an exit-dependent edge into a NOT REPLICATED (S2); (iii) dropping post-15:00 touches (S3); (iv) `1/nLevels` weighting shrinking the effective sample and the underpowered-arm floor (`<100 touches on 40 days`) excluding real-but-small arms; (v) top-vs-bottom tercile missing a non-monotonic effect (S9).

**Concrete amendments to adopt verbatim before running:**

1. **Test 0 consequence (S2).** Replace the NOT REPLICATED branch with: *"NOT REPLICATED on `ret60` means 'no gate-free, exit-free entry edge out of window', and is reported together with the ±0.5 ATR20 sim P&L and the live-exit sim before any 'no out-of-window support' conclusion is drawn."*
2. **`e` definition (S1).** *"`e` is computed on the prior bar's position within the day range through `t−1`: short `e = (C[t−1] − dayLow_{t−1}) / (dayHigh_{t−1} − dayLow_{t−1})`, long `e = (dayHigh_{t−1} − C[t−1]) / (dayHigh_{t−1} − dayLow_{t−1})`, so a new-extreme touch is not degenerate. Counts of touches that are new session highs/lows are printed separately."*
3. **Control conditioning (S4).** *"For each touch, the 20 control draws are matched on session, time bucket, and `f`, and additionally restricted to bars whose `e` (per the fixed definition) is in the same tercile as the touch's `e` and which are more than 15pt from every level that day; if a cell has fewer than 20 such control bars on a day, the nearest-`e` available bars are used and the shortfall is reported."*
4. **Weighting (S5).** *"`1/nLevels` is applied only to pooled (all-row) statistics. Per-cell (Test 0) and per-family (Test 2) statistics weight each (level, day) row equally (weight 1); `nLevels` is reported as a covariate and its correlation with `ret60` excess is printed."*
5. **Horizon (S3).** *"Every touch, including those after 15:00, is scored by a held-to-close return `f·(C[b−1] − O[t+1])/ATR20`; `ret60` is reported only for touches with `t+60 ≤ b−1`, and the dropped count is stated first."*
6. **Power (S6).** *"Before any outcome, report the expected N (touches, distinct days) per cell and per arm, the SD of `ret60` excess, and the implied smallest resolvable effect (95% CI half-width). If that exceeds the live +14/trade claim, the replication is declared underpowered for the claimed size up front."*
7. **Universe (S7).** *"The level universe is the live roster's `OPTIMAL_STOP` set; because those stops are calibrated over the full window (`window_days=9999`), this is acknowledged as in-sample level selection — minor for the two structural survivors, and reported as a limitation for Test 2."*
8. **Multiplicity (S8).** *"20 hypothesis tests in total (2 Test 0 cells, 4 Test 1 arms, 14 Test 2 cells). Test 0 cells are pre-specified and reported per cell without adjustment; Test 1 and Test 2 each apply BH q=0.10 within their family; the mirror and selection-window cells are descriptive and carry no confirmatory weight."*
9. **Test 0 era/robustness.** *"Report pre/post-2025-06 and annual breakdowns, and per-half CIs, next to each Test 0 cell."*

---

## Bottom line

The prereg's skeleton is right — out-of-window replication first, exit-free outcome, day-blocked bootstrap, explore/hold-out with a stratified SHOWN gate — and its "Honest expectations" correctly predicts a null. But three things currently undermine it: (1) the `e` axis is not a mechanism variable, it is a near-tautological re-description of the survivors' "fade a fresh extreme" shape, so Test 1's headline test can only confirm what Test 0 already asks; (2) a NOT REPLICATED on exit-free `ret60` is being allowed to stand for "no edge" when it only rules out a *gate-free, exit-free entry* edge — the live edge plausibly lives in the `OPTIMAL_STOP` exit and the gate stack; and (3) the control can't separate "the level" from "an intraday extreme in the fade direction", so even a REPLICATES is ambiguous about *what* replicated. The cheap fixes (amendments 1–9) — a prior-bar `e`, a level/excess-conditioned control, per-cell weight 1, a held-to-close fallback for post-15:00 touches, and a stated power/universe/multiplicity — close those gaps without changing the study's structure. With them, the likely honest outcome remains "null on the axes, and on Test 0 either a weak DIRECTIONAL at the resolution floor or a clean null", which is a real falsification result about the two survivors' *entry* signal and worth having.
