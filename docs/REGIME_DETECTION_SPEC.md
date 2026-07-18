# Market Regime Detection & Anticipation — Research Spec

**Status: RESEARCH SPEC — `regime_detection_methodology_needs_validation` RESOLVED (negative result), not cleared for live.** Written 2026-07-18. Timeline across one day: §7 found a differentiated first-pass result → §7.1 (placebo test + non-overlapping re-test) overturned the most promising part of it → §8/§8.1 built and ran the independent `ruptures`-based ground truth Stage 3 called for, and Regime A's transitions aligned with real, independently-detected price structural breaks *worse than chance* on the best-tested configuration. **Net: Regime A/B/C, as currently constructed, are not validated by any test run — read §8.1 first, it's the most decisive result and the reason the open decision is now resolved (in the negative).**

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

1. **Done, this session**: apply Stages 1-2 to Regime A/B/C, then act on both caveats surfaced (non-overlapping re-test + Regime C placebo test) plus a cheap third check (NL10/NL30 divergence). Results in §7/§7.1 — real progress on the open decision, not a resolution (Stages 3-4 remain), and the outcome is more sobering than §7 alone suggested: see item 3 below.
2. **Near-term, cheap, high-confidence**: consolidate the already-validated GARCH walk-forward vol-scaled stop out of `scratch/` into one canonical script — it's a real, proven asset currently sitting unpromoted because of 4 inconsistent versions, not because of any remaining doubt about its value. Unaffected by anything in §7.1 — independent thread.
3. ~~**Near-term, cheap**: now that §7 has separated which of Regime A/B/C's *sub-labels* are actually well-supported (Regime C fully, Regime B's `STRETCHED_LOW` only, Regime A weakly), update `regimeClassificationService.js`'s header comment...~~ **Superseded by §7.1**: Regime C's apparent validation did not survive a placebo test, and Regime A/B's trend/stretch buckets turned out to be underpowered rather than weak-but-measured. None of the three sub-schemes currently clears both Stage 1 and Stage 2 cleanly — there is no per-label distinction left to document as "well-supported" yet. The honest header-comment update is the opposite of what this item originally proposed: state plainly that no sub-label is validated yet, pending Stage 3.
4. **Promoted to top priority by §7.1, scoped in §8**: build the `ruptures`-based retrospective changepoint ground-truth dataset (Stage 3) — no longer just "next in line." Every self-referential test tried on Regime A/B/C so far (EV splits, forward-return predictive power, persistence-vs-placebo) has either failed outright or been too data-thin to evaluate; an independent ground truth is the only remaining path that could actually validate (or further debunk) any of it. Concrete scope (data source, algorithm, validation methodology, effort phasing, new dependency): §8. Not yet built.
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

### What this does and does not resolve (as of the initial pass — see §7.1, this was substantially revised same day)

~~**Does**: gives Regime A/B/C's three sub-schemes real, differentiated evidence for the first time — Regime C is well-supported, Regime B's `STRETCHED_LOW` half is well-supported, Regime A and Regime B's `STRETCHED_HIGH` half are not.~~ **Superseded by §7.1 below — Regime C's apparent validation did not survive a placebo test.**

**Does not**: complete Stage 3 (true out-of-sample / independent-ground-truth validation) or Stage 4 (multiple-comparisons correction across the full regime × setup_type testing surface this session and last night's both represent). **The `OPEN_DECISION` stays PENDING** — this document and its §7/§7.1 results are real progress, not a clearance to wire any of Regime A/B/C into live sizing.

## 7.1 Phase A Follow-Up (same day, 2026-07-18) — two of §7's caveats turned out to matter, one new negative finding

User asked to act on both caveats flagged in §7 (the overlapping-window autocorrelation issue, and — implicitly, by asking "is deeper research needed" — whether Regime C's clean result should be trusted at face value), plus a third question: is the pre-existing NL10/NL30 divergence flag (`server/services/queries.js` `getNL()`, already live as a "momentum weakening" signal in `confluence.js`/`longterm.js`/`ACDView.jsx`) usable as a regime-transition early-warning signal. All three run directly (`scratch/validate_regime_phase2.mjs`) rather than dispatched to Gemini — two prior dispatches in this thread had both hit the response-file truncation bug and needed a direct re-run anyway, so for a task this precisely specified there was no round-trip left to capture.

### Test 1 — non-overlapping-window re-test: the original N's were inflated by autocorrelation, and there isn't enough independent data to say more

Re-ran §7's Task 1 using windows that start every 5th day instead of every day (no overlap, no shared days between consecutive observations). Every trend/stretch bucket collapses below this codebase's own N≥20 floor:

| Bucket | Original overlapping N | Non-overlapping N | Verdict |
|---|---|---|---|
| Regime A NEUTRAL | 287 | 57 | Still clears floor — avg +222.9pt, clean/stable |
| Regime A BULLISH_TREND | 73 | **16** | Below floor — can't be evaluated |
| Regime A BEARISH_TREND | 44 | **9** | Below floor, 55.6% day-clustered — can't be evaluated |
| Regime B NORMAL | 312 | 65 | Still clears floor — avg +163.86pt, clean/stable |
| Regime B STRETCHED_LOW | 64 | **12** | Below floor — can't be evaluated |
| Regime B STRETCHED_HIGH | 28 | **5** | Below floor, 100% day-clustered — can't be evaluated |

**This is a more important finding than "Regime A is weak" — it's "we don't have enough independent data to know."** Only the two majority/baseline buckets (which have enough raw days to survive a 5x sample reduction) remain evaluable at all. The original pass's apparent statistical confidence in `BULLISH_TREND`/`BEARISH_TREND`/`STRETCHED_LOW`/`STRETCHED_HIGH` was inflated by non-independent overlapping samples, not a real sample-size advantage — this codebase's ~410-day history simply doesn't contain enough independent trending/stretched days yet to validate or invalidate those specific buckets properly. Recorded as `RESEARCH_CLAIM` `regime_a_b_trend_stretch_buckets_underpowered_nonoverlapping`.

### Test 2 — Regime C permutation/placebo test: the "cleanest" finding in §7 does not survive

The suspicion raised when this spec was first reviewed — that Regime C's fresh→established→extended persistence decay might be a generic run-length/aging statistical artifact rather than a real market-regime finding — was tested directly. Real persistence percentages (index-based reconstruction; N differs slightly from §7's date-keyed version due to warmup-alignment, not a discrepancy worth chasing) were compared against 200 permutations of `daily_score` (randomly shuffled, breaking all real temporal structure, same z-score/tercile construction rebuilt fresh on each shuffle):

| Bucket | Real | Placebo mean (200 permutations) | Placebo 95% range |
|---|---|---|---|
| fresh | 71.8% (N=170) | 70.2% | 58.0 – 82.1% |
| established | 75.7% (N=37) | 73.5% | 41.4 – 100% |
| extended | 72.9% (N=48) | 71.0% | 25.0 – 97.5% |

**All three real values sit near the center of their placebo null range, not in a tail.** The fresh>established~extended decay pattern shows up just as strongly when the data is randomly shuffled — it is very likely a generic property of run-length statistics under this specific z-score-threshold construction (the "inspection paradox": a state that's already run long is structurally more likely to be near its end, independent of whether the underlying process has any real regime structure), not evidence that Regime A/C tracks anything genuine about the market. **This reverses §7's conclusion that Regime C was the strongest-validated of the three metrics — it is now the least supported, once tested against a proper null, not the most.** Recorded as `RESEARCH_CLAIM` `regime_c_persistence_debunked_placebo_test`; the original `regime_c_persistence_validated_independent_predictor` claim has been updated in place to point here and marked `STALE` — do not cite it as a validated finding.

### Test 3 — NL10/NL30 divergence as a regime-transition leading indicator: no signal found

A cheap, already-computed candidate signal (not built this session — `getNL()`'s `nl30`/`nl10` calendar-day sums have been live for a while, feeding a "momentum weakening" display flag, but its predictive validity as a regime-transition indicator was never itself backtested). Tested whether NL10 diverging from (or "weakening" relative to) the NL30 trend, on a currently-trending day, predicts Regime A flipping within the next 5 trading days:

| Test | Group | N | 5-day flip rate | Avg fwd-5d return |
|---|---|---|---|---|
| Divergence | ALIGNED | 102 | 33.3% | -36.19pt (unstable) |
| Divergence | DIVERGING | 12 | 33.3% | +403.69pt (N too thin, 41.7% clustered) |
| Weakening | NOT_WEAKENING | 76 | 32.9% | -47.73pt (unstable) |
| Weakening | WEAKENING | 38 | 34.2% | +125.80pt (unstable) |

Flip rates are essentially identical between diverging/aligned and weakening/not-weakening — **no evidence this flag anticipates an upcoming regime flip.** The forward-return gaps look larger but neither clears this codebase's stability bar, and the `DIVERGING` group is far too thin to trust regardless. Negative finding, recorded as `RESEARCH_CLAIM` `nl_divergence_no_regime_transition_signal` (`status='PROVISIONAL'` — this tests one specific narrow question, it says nothing about NL30's already-separately-validated role in session-bias conditioning per the Permission Slip system, a different question that isn't reopened here).

### Net effect on the roadmap

Section 6's priority order needs updating: Regime C is no longer a promotable candidate as originally described — it was ranked highly in §7/§6 item 3 on the strength of a finding that didn't survive its own placebo test. Nothing from Regime A/B/C currently clears both Stage 1 and Stage 2 cleanly. The most defensible read of everything tested today: this codebase does not yet have a validated regime classifier, full stop — Stage 3 (an independent `ruptures`-based ground truth, §3.2 / §6 item 4) is no longer just "next in line," it's the only remaining path that could actually validate any of this, since every self-referential test tried so far (EV splits, forward-return predictive power, persistence-vs-placebo) has either passed on too-thin data or failed outright.

---

## 8. Stage 3 Scope — Independent Changepoint Ground Truth (`ruptures`)

Scoped 2026-07-18, not yet built. This is now the load-bearing next step for the whole thread (§7.1's closing note) — every test tried so far has been self-referential (checking Regime A/B/C against data derived from the same underlying `daily_score` series, or against its own internal consistency). This is the first test that would check them against something genuinely external.

### Why `daily_score`-derived ground truth would NOT be independent (and what to use instead)

Checked `server/services/acdService.js` (~line 92-97): `daily_score` is a discrete conviction score computed by this codebase's own A/C session-read engine — `+4`/`+1` for A-Up (with/without C-confirmation), `-4`/`-1` for A-Down, `0` otherwise. Regime A's z-score is a 30-day rolling sum of *this* — so running a changepoint detector on `daily_score` itself would just be re-deriving Regime A's own input in a different shape, not an independent check.

**Ground truth should instead run on raw NQ price data** (`price_bars_primary`, symbol='NQ') — daily log-returns for trend/mean-shift detection (validates Regime A directly, the metric with the biggest open gap) and, as a lower-priority secondary pass, daily realized volatility for variance-shift detection (validates the vol-regime classifier, which — reminder — is already separately validated via its own Phase 1 backtest, so this is confirmatory rather than filling a real gap).

**Correction, found during Phase 1 execution (§8.1) — the "877-day" data-volume upside below did not hold up**: `MIN/MAX(date)` across `price_bars_primary` returns 2022-12-14 to 2026-07-17, but that spans *all* hours including thin overnight/Globex coverage from before this system tracked RTH consistently. Restricted to actual RTH hours (the same 9:30 AM–4 PM ET filter every other script in this codebase uses), real coverage starts 2023-11-16 — essentially the same start date as `acd_daily_log` (418 RTH days vs. 410). The changepoint ground truth ends up built on almost the same window as Regime A itself, not a materially longer independent series. Left the original paragraph below struck through rather than deleted, per this doc's own house style of correcting in place — the lesson (check the *specific* query you'll actually run, not a looser proxy for it) is worth keeping visible.

~~**Real data-volume upside found while scoping this**: `price_bars_primary` NQ history runs 2022-12-14 to 2026-07-17 (877 distinct trading days) — more than double `acd_daily_log`'s 410-day window (2023-11-16 onward, itself only producing non-default Regime A labels after a further 150-day warmup, so real evaluable overlap is closer to ~260 days). Run the changepoint detector on the full 877-day price history for a statistically stronger ground truth; only the overlapping ~260-day window can actually be used to score Regime A's alignment against it, but the changepoint *detection* itself benefits from the longer series.~~

### Method

- **Tool**: Python `ruptures` library, PELT (Pruned Exact Linear Time) search — exact (not greedy like BinSeg), efficient enough for an 877-point daily series, and the standard first choice for offline multiple-changepoint detection.
- **Cost function**: L2/RBF on daily NQ log-returns (mean-shift detection). A separate run on rolling realized volatility (variance-shift) is the optional secondary pass noted above.
- **Penalty parameter**: PELT needs a penalty controlling how many changepoints it reports — this is itself a hyperparameter, and picking it by feel would just relocate the "arbitrary threshold" problem this whole spec exists to get away from. Use a BIC-derived penalty (`penalty = log(n) * sigma²`, a standard formula-driven default in the `ruptures` literature) rather than hand-tuning, and report how many changepoints it finds at that penalty plus at 0.5x/2x it (a cheap robustness check, same spirit as §5 Stage 2) — if the changepoint count/dates are wildly sensitive to a 2x penalty change, that's worth knowing before trusting the result.
- **New dependency**: `ruptures` isn't in `scratch/.venv` yet (checked — `arch`/`statsmodels`/`pandas`/`numpy`/`scipy` are already there from the GARCH work, `pip install ruptures` into the same venv rather than creating a second one).

### Validation methodology (how the ground truth actually gets used)

Once `ruptures` produces a set of changepoint dates, independent of Regime A:

1. **Alignment test**: for each Regime A label transition (a day where the label changes from the prior day), check whether an independently-detected changepoint falls within a small tolerance window (e.g. ±3 trading days — matches the kind of lag a 30-day rolling z-score would realistically have in confirming a break after it happened). Compute precision (of Regime A's transitions, what fraction land near a real changepoint) and recall (of real changepoints, what fraction Regime A's label transitions near).
2. **Significance via permutation** (same technique as the Regime C placebo test in §7.1, applied differently here): randomly redistribute Regime A's transition *dates* (keeping the same count of transitions) across the evaluable window, many times, and recompute precision/recall against the same real changepoint set each time. If the real alignment isn't meaningfully better than this randomized null, Regime A isn't tracking real structural breaks any better than chance would — the same standard of evidence §7.1 held Regime C to.
3. **Report honestly** even if the ~260-day overlap window turns out too thin to clear N≥20 real transitions for a confident precision/recall read (a real possibility worth flagging now, not discovering after building it) — if so, that's itself a finding (the same "not enough independent data yet" conclusion §7.1 reached for the trend/stretch buckets), not a reason to force a number out of it.

### Effort phasing

1. Install `ruptures`, pull 877-day NQ daily log-return series, run PELT at the BIC-derived penalty + the 0.5x/2x sensitivity check. Cheap, one sitting.
2. Build the alignment test (precision/recall + permutation significance) against Regime A's transitions over the evaluable ~260-day window. Moderate — the statistical design is already specified above, but this is genuinely new code, not a re-run of an existing script.
3. Only if 1-2 look promising: extend to the volatility-changepoint / vol-regime-classifier confirmatory pass. Optional, lower priority, can be dropped without weakening the main result.

### What this does NOT do

Does not retroactively validate or invalidate Regime B (`STRETCHED_LOW`/`STRETCHED_HIGH`) or Regime C — those would need their own ground-truth definitions (a "stretch" changepoint and a "run-length" ground truth are different objects than a trend changepoint, and are not scoped here). This phase is deliberately narrow: Regime A only, because it's the one with the biggest unresolved gap and the clearest independent ground-truth analog (a real trend/mean-shift in price).

---

## 8.1 Stage 3 Executed (same day, 2026-07-18) — Regime A fails the independent ground-truth test, and does worse than chance on the best-populated configuration

Built and run same session as the scoping above (dispatched to Gemini for the penalty-selection and alignment-test implementation; audited directly before trusting — see the two real issues caught below).

**Penalty selection (Task 1)**: confirmed the scope's predicted risk was real — a BIC-derived penalty computed from `l2` cost's own scale did NOT transfer to `rbf` cost at all (identical 83 changepoints across a 4x penalty range when naively reused). Fixed with a proper elbow-method sweep (12-20 log-spaced penalty values per model, `scratch/regime_changepoints_elbow_sweep.json`). `l2`'s curve declines smoothly with no sharp elbow (66→62→52→41→29→15→9→3→0); two candidate counts (9, 15) were carried forward rather than forcing a single arbitrary pick. `rbf`'s curve is flat at 83 for a wide penalty range (1e-6 to ~0.011) then declines to 0 — genuinely elbow-shaped, though the specific point chosen (26 changepoints, penalty 0.785) sits mid-decline rather than exactly at the flat-to-declining transition (~0.01-0.03); worth knowing the exact count is a soft call even though the curve shape itself is real.

**Alignment test (Task 2)**: Regime A has 33 label transitions in the evaluable window (index≥150). Precision/recall computed against each changepoint set (±3 trading-day tolerance), significance via a 500-iteration permutation null. **Caught and fixed one real bug before trusting the result**: the first version of the permutation script used `shuffledDates.sort(() => 0.5 - Math.random())` — a known-biased shuffle, not a fair permutation. Re-ran with a correct Fisher-Yates shuffle directly (`scratch/validate_regime_stage3_alignment.mjs`); the numbers moved only slightly, the conclusion didn't change.

| Changepoint set | N in window | Real precision | Null mean | Precision percentile | Real recall | Null mean | Recall percentile |
|---|---|---|---|---|---|---|---|
| `l2_9` | 4 (too thin) | 9.1% | 9.4% | 61.6th | 75.0% | 63.2% | 81.2th |
| `l2_15` | 8 (too thin) | 15.2% | 18.3% | 41.8th | 50.0% | 60.1% | 40.6th |
| `rbf_26` | 17 (closest to usable) | 33.3% | 41.6% | **21.6th** | 47.1% | 61.3% | **13.2th** |

Every changepoint-set N (4/8/17) sits below this codebase's own N≥20 floor, so no single row is individually decisive on its own. But the **direction is consistent across all three, and gets more negative as the changepoint set gets more populated and reliable** — `rbf_26`, the best-supported configuration, shows Regime A's real transitions aligning with independently-detected structural breaks *worse* than 78-87% of random 33-date placements would. That's not noise trending toward zero; it's a real signal, and it points the wrong way.

**Conclusion**: Regime A's label transitions do not correspond to independently-detectable structural breaks in raw NQ price action — on the most-populated test, they align distinctly worse than chance. Combined with the same-day findings that Regime B's trend/stretch buckets are underpowered (§7.1 Test 1) and Regime C's persistence pattern is statistically indistinguishable from a placebo (§7.1 Test 2), **all three components of Regime A/B/C now have a real, tested, negative-or-inconclusive result** — this is no longer just "unvalidated," there is now actual evidence against treating the current z-score construction as meaningful. Recorded as `RESEARCH_CLAIM` `regime_a_fails_independent_changepoint_alignment`.

**Stage 4 (multiple-comparisons correction) is now moot for these three labels** — it exists to correct for false positives among things that appeared to pass; nothing here passed, so there's nothing left to correct for. `OPEN_DECISION` `regime_detection_methodology_needs_validation` has been resolved on this basis — see the decision's own resolution text for the full account and recommendation.

---

## 9. What this spec deliberately does not do

- Does not conclude Regime A/B/C are *permanently* invalid — only that the *current* z-score/tercile construction, on *this* ~410-day history, does not clear real independent validation. More history, a different construction, or a different ground truth could change this; nothing here rules that out.
- Does not propose wiring anything new into `acd.js`'s live `sizeMultiplier` IIFE — the opposite: the evidence gathered argues against doing so with Regime A/B/C as currently built.
- Does not attempt to build any of §3's other untried methods (formal Markov-switching, order-flow regime signals, ML classifiers) — those remain real options for a future attempt at regime detection in this codebase, just not exercised in this spec.
- Does not retest Regime B or Regime C against an independent ground truth of their own — only Regime A got the full Stage 3 treatment; Regime B/C's negative results (§7.1) are self-referential (non-overlapping windows, placebo test), one level short of what Regime A received.
