# Market Regime Detection & Anticipation — Research Spec

**Status: RESEARCH SPEC — partially validated, not cleared for live.** Written 2026-07-18 directly against `OPEN_DECISION` `regime_detection_methodology_needs_validation` (HIGH priority, still PENDING after this document — see [Section 7](#7-preliminary-validation-results-run-2026-07-18)).

## 1. Purpose & Scope

Two goals, in order:

1. **Survey the space of methods** for (a) diagnosing what regime the market is in *right now* and (b) anticipating a regime *change* before it's obvious in realized price — both generally, and specifically for what's cheap/hard to build against this codebase's existing data.
2. **Propose a validation framework** so a regime classifier earns trust before it's wired into live sizing/suppression logic — this is the actual gap the open decision flagged: this codebase has repeatedly verified that a regime label's *downstream EV split* is statistically real (N, chi-square-ish significance, chronological stability), but never verified that the *label itself* is a valid, non-arbitrary regime detector, independent of whichever setup it happens to be conditioning.

**Instrument scope**: MNQ (Micro E-mini Nasdaq), $2/pt. All data below comes from `price_bars_primary`, `acd_daily_log`, `active_setups`, `auction_reads`, `performance_audit` — this codebase's existing tables. No new data source is assumed available unless explicitly flagged as "needs new data" below.

**Out of scope**: cross-asset regime signals (no other instrument's data is ingested), macro/news-driven regime shifts (no fundamental data source exists here), options-derived signals (no options chain data ingested — flagged in §3.9 as a real institutional lever this codebase simply can't use yet).

---

## 2. Current State Inventory

Every regime-adjacent component that already exists in this codebase, with its real validation status — not what a comment claims, what's actually been checked (per the standing "audit before trusting a 'verified' comment" hard rule).

| Component | What it detects | Validation status | Live? |
|---|---|---|---|
| Day-Type Classifier v1 (`caseEngine.js`) | TREND / BALANCE / TURBULENT, committed at 9:35 ET from 5 bars, never updates | Backtested 41% overall accuracy, 25% on TREND calls specifically — weak | Live (feeds `sessionConflictFor`, coaching content) |
| Day-Type Classifier v2 candidate (`docs/daytype_classifier_v2_candidate.md`) | Same 3 labels, but reclassifies at IB close (10:30 ET) using the actual IB break | Own doc header: **"CANDIDATE — NOT VALIDATED, NOT DEPLOYED."** Designed 2026-06-06, never scored against v1 | Not live |
| Volatility Regime (`server/services/volatilityRegimeService.js`) | HIGH-VOL-DIRECTIONAL / HIGH-VOL-CHOP / NORMAL-VOL / LOW-VOL, from 9:30-10:30 ET realized vol z-scored vs a 60-session baseline | **Validated.** Phase 1 backtest confirmed the split before going live; independently reconfirmed 2026-07-17/18 against 358 persisted `VOL_REGIME_HIST` days — fade EV +$6.75/tr (CHOP, clean) vs -$17.99/tr (DIRECTIONAL, not clean) despite both predicting similarly elevated range | Live — `/api/acd/volatility-regime`, wired to `SidebarVerdictChip`/`VolatilityRegimeCard.jsx` |
| Regime A/B/C (`server/services/regimeClassificationService.js`) | Directional-trend z-score / price-stretch z-score / trend-persistence tercile | **Unvalidated as of last night** — only downstream EV splits were checked. See §7 for this document's own first-pass validation | Not live |
| Markov regime probability score | A Markov-chain-derived probability score, tested as an alternative to the volatility-regime classifier | **Rejected** — `RESEARCH_CLAIM` `markov_vs_regime_comparison`: adds no value over the existing (simpler) volatility-regime classifier, real-regime spread ~$25/tr vs. Markov's ~$10/tr | Not built |
| Per-level Hurst/ADF (`scripts/backtest_level_mean_reversion.py`) | Mean-reversion signature *per individual level* (not a time-varying regime — a structural property of the level itself) | **Validated** for specific levels — `MR2_FADE_LONG` standout (Hurst 0.53, +$33/tr live EV, N=56); high-Hurst levels uniformly flat-to-negative | Informs which levels to trust, not live "regime" logic |
| GARCH(1,1) walk-forward vol-scaled stop (`scripts/backtest_confluence_garch_stop.py`) | Forecasts next-day volatility, scales a fixed stop by `forecast_vol / baseline_vol` | **Validated as a real improvement** (all-time EV +18-19%, recent-window losses shrink 30%+) — but 4 inconsistent scratch scripts exist with different N depending on window/target choice; **not consolidated into one canonical version, not promoted to live** | Not live |
| `prior_day_profile=TREND` anticipation flag (`auction_reads`, already computed) | A day preceded by a TREND day has ~2x the odds of itself being a 500+pt rotation day | **Validated** — `RESEARCH_CLAIM` `prior_day_trend_profile_anticipates_rotation_day`, χ²≈9.88, p≈0.002, independently re-verified via direct SQL | Zero-infrastructure-cost flag; not wired into anything live yet |
| Regime-transition forecasting (formal Markov-switching / changepoint detection) | Not "what regime now" but "is a shift coming" | **Not started.** Flagged 2026-07-15/16 as a genuinely hard problem — "institutional quant shops work this exact problem without a clean solved answer" | Not built |

---

## 3. Survey of Regime-Detection & Anticipation Methodologies

Organized by category. Each entry: what it does, what it would cost to build here, and how hard it is to validate (i.e. how easy it is to fool yourself with it).

### 3.1 Rolling z-score / percentile threshold classifiers — what most of this codebase already uses

Label "now" by comparing a rolling statistic against its own historical distribution (mean ± Nσ, or a percentile cutoff). This is Regime A/B/C, the volatility regime classifier, and Day-Type v1/v2 — all the same underlying pattern.

- **Pros**: simple, transparent, auditable in one glance, and naturally compatible with this codebase's "no static thresholds" hard rule (the threshold *is* the rolling distribution).
- **Cons**: the window length and cutoff percentile are themselves hidden hyperparameters. Two reasonable-looking choices (30-day vs 40-day sum, ±1.0σ vs ±1.2σ) can produce meaningfully different label histories, and nothing about the z-score math itself tells you which choice is "right" — that has to come from validation, not the formula. This is exactly the gap the open decision names.
- **Validation difficulty**: low-to-moderate. Cheap to sensitivity-sweep (redo the same math with different windows, measure label agreement — this is exactly what §7 Task 2 below does).

### 3.2 Structural break / change-point detection — anticipating a shift, not labeling current state

A different question than "what regime is today": *when* did the regime actually change? Useful both as a live "elevated odds of a shift" signal and — just as importantly — as a way to build an independent ground-truth answer key to validate any z-score classifier against.

- **CUSUM (cumulative sum control chart)**: classic real-time break detector, flags when a running cumulative deviation from a baseline mean crosses a threshold. Cheap to compute on daily NL30/return series.
- **Bayesian Online Changepoint Detection (BOCPD, Adams & MacKay 2007)**: gives a continuously-updated *probability* that "today is a changepoint," not a binary flag — a natural fit for a dashboard badge ("elevated probability of a regime shift today") rather than a hard label.
- **Chow test / Bai-Perron multiple breakpoint test**: retrospective, finds *how many* structural breaks exist in a historical series and roughly where. Not a live signal — a calibration/validation tool.
- **`ruptures` (Python library)**: implements PELT/BinSeg/window-based changepoint detection. Already scoped as an idea in `docs/OPEN_THREADS.md` (2026-07-15/16). Best first use here: retrospectively label real historical regime-shift dates *independent of any existing z-score classifier*, then use that independent label set as the answer key for Stage 3 of the validation framework below (§5).
- **Validation difficulty**: moderate — these methods have their own hyperparameters (CUSUM's threshold, BOCPD's hazard rate prior), but because they're explicitly designed to answer "was there a break," their output is more directly checkable against known market events (e.g. does `ruptures` find a break around a real, independently-known volatility spike) than a z-score label is.

### 3.3 Markov-switching / Hidden Markov Models

Fits N latent states with their own return/volatility distributions and a transition probability matrix between them (Hamilton 1989; `statsmodels.tsa.regime_switching.markov_autoregression` in Python).

Important distinction from what was already tried here: the rejected "Markov regime probability score" (`markov_vs_regime_comparison`) was a lighter-weight derived score used as a filter, not a full formally-fit 2-3-state Markov-switching model with its own maximum-likelihood transition matrix. The two are not the same test. The formal version's real, distinct value proposition is a **calibrated forward transition probability** — "P(regime flips in the next N days) = X%" — which none of the current z-score classifiers provide; they only label "now," they say nothing about how likely that label is to persist (Regime C's tercile approach is a proxy for this, not the real thing).

- **Caution**: HMMs are notorious for overfitting with few states or a short history, and estimated state labels can be unstable or relabel entirely across refits (the "label-switching problem" in the HMM literature) — needs the same validation discipline as everything else, arguably more, since it has more free parameters to hide overfitting in.
- **Recommendation**: worth trying only *after* the cheaper z-score approach has been fully validated (or found wanting) via §5 — not a first move, per §6.

### 3.4 Volatility/GARCH-family models

GARCH(1,1)/EGARCH/GJR-GARCH forecast tomorrow's volatility from today's realized volatility and past forecast errors. Already validated here as a stop-sizing input (`backtest_confluence_garch_stop.py`).

- **Extension not yet tried**: use the GARCH forecast itself as a *forward-looking* vol-regime input (`forecast_vol / long_run_vol`, thresholded the same way `volatilityRegimeService.js` already thresholds *realized* vol) instead of the current backward-looking "morning vol vs 60-day baseline" measure. This would give a regime read that updates *before* the realized-vol evidence accumulates, rather than after.
- **Open question, testable cheaply**: is the GARCH-forecast regime meaningfully different from the existing realized-vol regime, or largely redundant? If redundant, the existing (much cheaper) classifier should stay canonical — GARCH's marginal value here may be entirely in the stop-sizing use case, not a new regime label.

### 3.5 Trend/mean-reversion structural tests (Hurst, variance ratio, ADF/KPSS)

Already applied *per level* in this codebase (Hurst exponent + ADF stationarity test on price behavior near each specific level, `backtest_level_mean_reversion.py`). Not yet applied at the *session* level.

- **Untried extension**: compute Hurst exponent / variance-ratio on *today's* intraday price path using only the bars seen so far (e.g. trailing 60-120 min of 1-min bars), to get a live, continuously-updating "is today trending or mean-reverting" signal — distinct from Regime A's daily NL30-sum-based read, and updating within the session rather than only at day-boundary.
- **Same overfitting risk applies**: the intraday window length is itself a hyperparameter needing the same §5 treatment.

### 3.6 Machine-learning classifiers / ensemble methods

- **Supervised**: train a classifier (random forest, gradient boosting, logistic regression) on lagged features (realized vol, NL30, delta, IB width, texture metrics already computed in `volatilityRegimeService.js`'s `computeTextureMetrics`) against a hand-labeled or `ruptures`-derived regime/breakpoint target.
- **Unsupervised**: k-means / Gaussian Mixture Model clustering on a feature vector, letting regimes emerge from the data instead of being hand-defined by a cutoff. Sidesteps "did we pick the right z-score cutoff" but trades it for an analogous problem — "did we pick the right number of clusters / the right feature set."
- **Why this is ranked low-priority here** (see §6): this codebase's usable daily sample is ~350-400 trading days (per the `VOL_REGIME_HIST`/Regime-A history sizes actually observed in §7). That's a small sample for a model class with materially more free parameters than a 2-3-cutoff z-score rule — real overfitting risk, and a harder one to catch, since more parameters means more places to hide a spurious fit. Should be a later-stage idea, attempted only after the cheaper methods have been fully validated (or shown to be insufficient) and only with the full walk-forward/purged-CV discipline in §5 Stage 3.

### 3.7 Order-flow / market-microstructure regime signals

- `touchQuality.js` already classifies volume-spike/touch quality *per touch* — never aggregated to a session-level "was today's order flow trending or two-sided" read.
- Overnight/Globex volume and delta as a regime-anticipation signal — explicitly flagged as untested in the 2026-07-17 overnight-anticipation research thread ("order-flow angle... was not tested in this pass").
- Delta/CVD (cumulative volume delta) divergence from price (price makes a new high, delta doesn't confirm — a classic prop-desk exhaustion tell) — **not currently computed anywhere in this codebase.** Real gap, real potential value, unbuilt.

### 3.8 Cross-day / calendar-conditioned anticipation signals

Signals that tell you something about the regime *before* today's price action does, because they're knowable at (or before) the open:

- `prior_day_profile=TREND` → elevated rotation-day odds — already found, real (§2 table above).
- Day-of-week effects — this codebase already conditions some setups on DOW (e.g. the existing "no Monday fades" rule); the same category of signal.
- Options-expiry / quarterly-rebalance calendar effects — a standard equities-index-futures regime tell (elevated pinning/volatility around expiry). **Needs new data**: no options-expiry calendar table currently exists in this DB. Cheap to add (a static calendar, not a live feed) if this is worth pursuing.

### 3.9 Term-structure / cross-instrument signals

Not directly usable today — this journal trades a single instrument (MNQ) with no options chain or futures-curve data ingested, and no second correlated instrument's price series collected. A real institutional-grade lever (front-month/back-month term structure, VIX-regime, cross-asset correlation regime) but genuinely out of scope until/unless a second data source is added. Flagged for completeness, not actionable today.

---

## 4. Why "does it split EV" is not enough

Every one of this codebase's existing rigor checks (`computeRigor()` — N≥20, day-clustering, 3-way chronological sign stability) answers one question: **is the measured EV/return split between labeled buckets statistically real, given the data?** That question has already been answered "yes" for Regime A/B/C's downstream setup-conditioning splits.

It does **not** answer a second, different question: **does the label itself correspond to something real and meaningful about market structure**, as opposed to one arbitrary construction among many that happened, by chance, to produce a split with a plausible-sounding story attached after the fact? Three concrete reasons this second question stays open even after the first is answered:

1. **The window/cutoff choice is unvalidated.** Regime A's 30-day/120-day/±1.0σ, Regime B's 20-day/252-day/80th-20th percentile, Regime C's 252-day tercile — all chosen semi-informally, none derived from a principled search or checked against an alternative.
2. **A plausible narrative is not evidence.** "Don't fade a fresh trend" is a story that can be told for almost any split, discovered after the fact — narrative plausibility should prioritize what to validate first, never substitute for validating it (§5 Stage 5 makes this explicit).
3. **Multiple-comparisons exposure.** 3 regime schemes × ~40 setup_types × 2-3 buckets each is a real number of independent-looking tests run against the same underlying data — with no correction applied, some fraction of "significant" splits are expected to be false positives by chance alone, even if every individual N/stability check is done correctly.

---

## 5. Proposed Validation Framework

A concrete, five-stage protocol — the actual deliverable that closes the open decision. Reusable for Regime A/B/C now, and for any future regime classifier this codebase builds.

### Stage 1 — Independent predictive power

Before a regime label is allowed to condition any setup's EV, it must first predict something about the market **on its own**: forward return (trend regime), forward range (vol regime), forward label persistence (persistence regime) — evaluated with the same `computeRigor()` convention already used everywhere else (N≥20, chronological stability), imported not reimplemented.

### Stage 2 — Parameter sensitivity / robustness sweep

Re-derive the label under 2+ alternate, equally-reasonable parameterizations (different window lengths, different cutoff percentiles). Measure day-by-day label agreement. A genuinely meaningful regime shouldn't flip because the window moved by a third; a fragile/arbitrary one will.

### Stage 3 — Out-of-sample / walk-forward validation

Any parameter that's ever *fit* rather than fixed (an HMM's transition matrix, an ML classifier's weights) must be fit on data through day D only and evaluated on D+1 onward, never re-fit with hindsight. For a pure z-score rule with no fitting step, this stage instead means: validate the label against an *independently derived* ground truth (e.g. `ruptures`-based changepoint dates, §3.2) rather than only checking internal consistency against itself. If a future ML classifier is built, use purged/embargoed cross-validation (Lopez de Prado) so autocorrelated daily features near a train/test boundary don't leak.

### Stage 4 — Multiple-comparisons correction

With 3 schemes × ~40 setup_types × several buckets each as the real testing surface, apply either a Benjamini-Hochberg false-discovery-rate correction across all regime × setup_type EV-spread tests run in one mining pass, or — if a full FDR pipeline is too heavy right now — a Bonferroni-lite heuristic that raises the required N/significance bar as the comparison count grows. Concretely actionable here: `scripts/record_claim.mjs`'s ledger already tracks how many `RESEARCH_CLAIM`s get tested per session — it could compute and log an implied FDR-adjusted significance threshold as part of that ledger going forward, making this correction visible rather than assumed.

### Stage 5 — Economic-rationale sanity check (last, not first)

A plausible story is a prior for *which* label to spend Stage 1-4 validation budget on first — never a substitute for actually running Stages 1-4, and never sufficient justification on its own for skipping them.

---

## 6. Recommended Roadmap

Priority-ordered by cheap-and-high-confidence first, expensive-and-speculative last.

1. **Done, this session**: apply Stages 1-2 to Regime A/B/C. Results in §7 below — this is real progress on the open decision, not a full resolution (Stages 3-4 remain).
2. **Near-term, cheap, high-confidence**: consolidate the already-validated GARCH walk-forward vol-scaled stop out of `scratch/` into one canonical script — it's a real, proven asset currently sitting unpromoted because of 4 inconsistent versions, not because of any remaining doubt about its value.
3. **Near-term, cheap**: now that §7 has separated which of Regime A/B/C's *sub-labels* are actually well-supported (Regime C fully, Regime B's `STRETCHED_LOW` only, Regime A weakly), update `regimeClassificationService.js`'s header comment and any future consumer to reflect that per-label distinction rather than treating all three schemes as equally trustworthy.
4. **Medium-term**: build a `ruptures`/BOCPD-based retrospective changepoint ground-truth dataset — an answer key independent of any existing z-score classifier — and use it for Stage 3 validation of Regime A/B/C and any future classifier, instead of only checking internal consistency.
5. **Medium-term**: extend the per-level Hurst/ADF methodology (§3.5) from "per level" to "whole session, intraday-updating" — a live trend/chop read distinct from and complementary to Regime A.
6. **Longer-term, higher effort/risk**: a formal Markov-switching model with a fit transition matrix (§3.3) — only after 1-5 are done, and only if Stage-1-style testing shows the existing z-score approach genuinely underperforms.
7. **Longer-term, flagged not scoped**: order-flow/CVD-based regime tells (§3.7, entirely untested) and options-expiry calendar effects (§3.8, needs new data).
8. **Explicitly deprioritized**: ML ensemble classifiers (§3.6) until the simpler methods have exhausted their validation budget — more parameters is more overfitting surface on a ~350-400-day sample, not automatically more insight.

---

## 7. Preliminary Validation Results (run 2026-07-18)

Stage 1 and Stage 2 of §5, applied to Regime A/B/C, executed directly (dispatched to Gemini; its prose response hit the known response-file-truncation bug documented in this codebase's Gemini-collaboration memory, so the underlying script — `scratch/validate_regime_methodology.mjs`, confirmed to import the real `buildRegimeMap`/`computeRigor` rather than reimplementing them — was re-run directly for clean output). Recorded as 3 `RESEARCH_CLAIM` rows (`regime_a_directional_trend_weak_independent_predictor`, `regime_b_stretched_low_validated_stretched_high_not`, `regime_c_persistence_validated_independent_predictor`).

**Methodology caveat that applies to every number below**: forward-5-day windows overlap day to day (day D's window shares 4 of 5 days with day D+1's), so consecutive daily observations in the same bucket are serially correlated — nominal N overstates the effective independent sample size. Not corrected for in this pass (a real Stage-3/4-adjacent gap, not fixed here). Treat every N below as an upper bound on independence, not a literal count of unrelated observations.

### Regime A (directional trend) — does NOT clearly validate

| Bucket | N | Avg fwd-5d return (pt) | 3-way thirds | Stable? |
|---|---|---|---|---|
| NEUTRAL | 287 | **+217.42** | 295 / 139 / 217 | Yes |
| BULLISH_TREND | 73 | +59.13 | 100 / -39 / 114 | **No** |
| BEARISH_TREND | 44 | -60.37 | 127 / -547 / 201 | **No** |

The trend-continuation story is weak: `BULLISH_TREND`'s average forward return is *smaller* than the unconditioned `NEUTRAL` bucket's, and both trend buckets fail the chronological stability check. `BEARISH_TREND` has the correct sign but is driven almost entirely by one bad middle third. **This does not clear the bar to trust live** — but the label-generation mechanism itself is separately robust (see Task 2 below), so the fix, if there is one, is more likely in what the label is being asked to predict than in how it's computed.

### Regime B (price-stretch) — mixed: one real sub-signal, one that fails

| Bucket | N | Avg fwd-5d return (pt) | 3-way thirds | Stable? |
|---|---|---|---|---|
| NORMAL | 312 | +150.54 | 265 / 127 / 59 | Yes |
| STRETCHED_LOW | 64 | **+219.45** | 333 / 53 / 270 | **Yes** |
| STRETCHED_HIGH | 28 | +108.86 | 247 / 372 / **-252** | **No** |

`STRETCHED_LOW` is a real, independently-validated mean-reversion bounce signal — clean, stable, and every third positive. `STRETCHED_HIGH` fails both the sign expectation (a mean-reversion story predicts *negative* forward return; two of three thirds are strongly positive instead) and the stability check. **Recommendation: `STRETCHED_LOW` conditioning is a defensible candidate for further work (Stage 3-4); `STRETCHED_HIGH` conditioning is not, as currently defined.**

### Regime C (trend persistence) — cleanly validates its own specific claim

| Bucket | N | 5-day same-label persistence | 3-way thirds | Stable? |
|---|---|---|---|---|
| fresh | 319 | **82.0%** | 100% / 75% / 72% | Yes |
| established | 37 | 76.0% | 83% / 50% / 92% | Yes |
| extended | 48 | 73.0% | 81% / 38% / 100% | Yes |

Monotonic decay exactly as the "persistence" framing predicts, all three buckets N-cleared and chronologically stable. This is the strongest-validated of the three metrics. **Important scope limit**: this only validates that the label predicts its own continuation — it says nothing about whether "extended" trends are tradeable in any specific direction, which is a separate, unaddressed question.

### Task 2 — Regime A parameter sensitivity: the label mechanism is robust even though its predictive power is weak

| Alt config | Agreement w/ live 30/120 | N compared | Outright BULLISH↔BEARISH flips |
|---|---|---|---|
| 25-day sum / 90-day baseline | 72.7% | 249 | **0** |
| 40-day sum / 150-day baseline | 63.4% | 227 | **0** |

Every mismatch in both alternates is a NEUTRAL-vs-TREND boundary dispute (does today count as "trending enough"), never an outright sign flip. **The classifier's directional core is robust to reasonable reparameterization** — this is a genuinely positive, distinct finding from the predictive-power result above, and the two should not be conflated: Regime A computes a *stable* label, it just hasn't been shown to *predict* much beyond the market's baseline drift.

### What this does and does not resolve

**Does**: gives Regime A/B/C's three sub-schemes real, differentiated evidence for the first time — Regime C is well-supported, Regime B's `STRETCHED_LOW` half is well-supported, Regime A and Regime B's `STRETCHED_HIGH` half are not. That's a real, actionable update from "three equally-unvalidated metrics" to "one validated, one half-validated, one not."

**Does not**: complete Stage 3 (true out-of-sample / independent-ground-truth validation) or Stage 4 (multiple-comparisons correction across the full regime × setup_type testing surface this session and last night's both represent). **The `OPEN_DECISION` stays PENDING** — this document and its §7 results are real progress, not a clearance to wire any of Regime A/B/C into live sizing.

---

## 8. What this spec deliberately does not do

- Does not resolve `regime_detection_methodology_needs_validation` — Stages 3-4 are unexecuted; the decision stays open until they are.
- Does not propose wiring anything new into `acd.js`'s live `sizeMultiplier` IIFE. Per the standing rule already in `CLAUDE.md`, nothing here should be treated as cleared for live until the full validation framework has actually been run against it and passed.
- Does not attempt to build any of §3's untried methods (changepoint detection, formal Markov-switching, order-flow regime signals, ML classifiers) — this is a spec and a first validation pass, not an implementation session.
