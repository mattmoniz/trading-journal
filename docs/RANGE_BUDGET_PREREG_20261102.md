# Pre-registration: the range budget ("how much of the expected day has price already used?") (written 2026-11-02 BEFORE any minute bar is fetched or any outcome computed; user idea: "we know the overnight range and how the market has behaved at a specific moment, can we assert the next move by studying the past?"; user go: "Ok start with that")

## 0. The question, and what is and is not new
Known and NOT repeated here (hr-052): overnight range and open location as DIRECTIONAL predictors were not shown (claims `overnight_rth_context_partA_20261026`, `heavy_night_range_playbook_not_shown_20261026`); a big overnight range predicts a WIDER day (volatility), which is what a forecast of the day's range uses; after any reference bar the revert/extend odds are a coin flip (claim `path_structure_symmetric_walk_not_shown_20261102`).
New: use that day-range forecast R-hat as a BUDGET and measure how much of it price has already used at a moment in the day, U = (RTH range so far) / R-hat. Hypothesis family (exhaustion, an idea from the user's framing, not from any result): when price sits at a fresh extreme of the day AND most of the expected range is already used, the next hour continues the move LESS than when little of the budget is used (exhaustion), possibly reversing. This is a question about WHERE price is inside its expected range, a conditional-probability structure the tell research never tried. It is a market-behaviour screen, not a trade rule: no fills, no costs, nothing live.
Honest prior (stated so a null is not whiplash): about 10 to 15 percent that anything survives. Budget heuristics are popular and the signal-to-noise at one observation per day is low.

## 1. Data (pinned to the earlier bar-context studies)
- Day-level features: `scratch/overnight_rth_dataset_20261026.json` (built by `scripts/build_overnight_rth_dataset_20261026.mjs`; NQ one-minute bars from `price_bars_primary`, window 2023-03-06 .. 2026-10-23, valid days after the sparse-window, roll-week and density exclusions; 772 days). Fields used: `date, dow, atr` (ATR20 in points = mean RTH range of the 20 prior sessions), `onL, onH, onVol, pdRangeAtr, gapAtr, rthRangeAtr`.
- Split, the SAME rule as Part A: explore = the earliest 60 percent of valid days (463 days, 2023-03-31 .. 2025-06-20 by the dataset), hold-out = the latest 40 percent. **ONLY EXPLORE minute bars are extracted** (`scripts/build_range_budget_bars_20261102.mjs` refuses a hold-out date); the hold-out is NOT touched by this pre-registration, and spending it requires the user's explicit go (a sealed look via `spendSealedLook`, family `range_budget_20261102`).
- Intraday bars: one-minute RTH bars of each explore date (09:30-15:59, 390 bars, density already screened), fetched per date with both timestamp bounds (cv-009). A fetched day whose recomputed RTH range / `atr` differs from `rthRangeAtr` by more than 1e-6 is a loader bug and stops the run.

## 2. Definitions (causal, scale-free; every cutoff is a rolling quantile of strictly EARLIER days, hr-003)
- Day-level forecast R-hat (known before 09:30; ATR20 units): ridge on log(rthRangeAtr) with features log(pdRangeAtr), (onH - onL)/atr, ONV = log(onVol / mean onVol of the 20 prior valid days), |gapAtr|, day-of-week one-hot (Tuesday..Friday). Walk-forward: the first 60 valid days train only, refit every 10 days on all earlier days, alpha by the time-ordered inner CV of `run_p2b.choose_alpha`. R-hat = exp(prediction) x atr (points).
- Checkpoints: every 30 minutes at k = 30, 60, ..., 300 bars after the open (10:00 .. 14:30). At checkpoint k the decision uses bars 0..k-1 only: close C = close[k-1], running high H and low L of bars 0..k-1, range so far = H - L.
- Budget variables: U_hat = (H - L) / R-hat (the primary) and U_atr = (H - L) / atr (the control: budget with NO forecast).
- Location: loc = (C - L) / (H - L). AT_HIGH = loc at or above the 80th percentile of the loc values of earlier days at the same checkpoint; AT_LOW = loc at or below the 20th percentile (expanding, same checkpoint, strictly earlier days).
- Budget buckets: U_TOP / U_BOT = the top / bottom third of U among earlier days at the same checkpoint (expanding). The checkpoint-relative definition removes the time-of-day confound (late checkpoints always have a bigger range so far).
- Evaluation starts after the 60 training days plus 40 further days that only seed the cutoffs (about 363 evaluated explore days, about 3,600 checkpoints).
- Outcomes (price only, in ATR20 units of that day): y60 = (close[k+59] - C) / atr; s = +1 at AT_HIGH, -1 at AT_LOW, so s x y60 > 0 is CONTINUATION of the extreme; E60 = 1 if the next 60 minutes trades beyond the running extreme (above H when AT_HIGH, below L when AT_LOW).

## 3. Counted tests (family `range_budget_20261102`, ledger tests = 3, BH q = 0.10 across them)
- T1_HIGH: D = mean(s x y60 | AT_HIGH, U_hat TOP) - mean(s x y60 | AT_HIGH, U_hat BOT). Exhaustion predicts D < 0. AT_HIGH and AT_LOW are never merged.
- T1_LOW: the same for AT_LOW.
- T2: the extension probability, D_E = P(E60 | at an extreme, U_hat TOP) - P(E60 | at an extreme, U_hat BOT) (high and low pooled because the quantity is side-free). Exhaustion predicts D_E < 0; this is partly mechanical (a big range so far is harder to extend), which is why T2 only counts as informative if the forecast budget does better than the no-forecast budget (section 4, control C2).
Statistics: day-blocked bootstrap 95 percent CI (3000 draws, seed 20261102; the unit is the day, a day contributes all its checkpoints); two-sided p from a circular-shift placebo (1000 random day offsets applied to the U-bucket labels only, the extreme states stay the true ones, so the placebo asks whether the budget carries information beyond the state); same sign in both chronological halves of the evaluated days; leave-the-5-largest-contributing-days-out check (same sign and at least half the effect); floors: at least 30 points and 20 days in each arm, else UNDERPOWERED (not "not shown").
EXPLORE-CANDIDATE (the only positive label this test can give) = BH survivor AND CI excludes zero AND placebo p < 0.05 AND halves same sign AND leave-5-out holds AND the sign is the pre-registered exhaustion sign. Everything else = NOT SHOWN (with the resolution: half the CI width, printed BEFORE any verdict).

## 4. Controls and diagnostics (uncounted, all printed)
- C1 time-of-day: buckets are checkpoint-relative (section 2); the table of D by checkpoint is printed.
- C2 does the FORECAST matter: every counted statistic is recomputed with U_atr (range so far over ATR20, no forecast). An effect that appears with U_atr as strongly as with U_hat is a "range-so-far" effect, labelled "not forecast-specific" and not a reason to build the day forecast.
- C3 unconditional drift: mean y60 over all checkpoints and over all at-extreme checkpoints (multi-year NQ has drift; the contrast D already differences it out, the means are printed).
- C4 other horizons: y30 and the return to the close, same contrasts (uncounted).
- C5 the other arm: mean(s x y60 | AT extreme, U_hat BOT) minus the at-extreme mean (does a LOW budget used carry continuation) and the semantic split U_hat >= 1 (budget fully used) vs below.
- C6 eras: by calendar year and by quarter (the fade/continuation sign has flipped between eras before, cv-033); a pooled result that lives in one era is reported as such.
- C7 the day-level forecast itself: out-of-sample Spearman of R-hat with the realized day range (and against the naive baselines atr alone and pdRangeAtr), so the budget's quality is known.
- C8 the full tercile tables (N points, N days, mean s x y60, P(E60)) for AT_HIGH and AT_LOW.

## 5. Resolution, stated now
About 360 evaluated days and 3,600 checkpoints, of which roughly 20 percent are at an extreme and a third each in the top and bottom budget buckets: a few hundred points per arm. The 60-minute return in ATR units has a standard deviation near 0.15, so a day-blocked CI on D is expected to be about +/-0.04 ATR, roughly 10 points of NQ, far wider than the $1-3 per trade that would matter after costs. This test can only see a LARGE structural effect (several hundredths of an ATR). That is the same limit Part A reported (smallest resolvable about 0.064 ATR). A pass is a lead for the hold-out look; a null is "no large exhaustion effect", not "no effect".

## 6. Reading rules (fixed now)
- EXPLORE-CANDIDATE on T1 (either side) and "forecast-specific" under C2: the next step is a pre-registered hold-out look (user's go required) and, if it holds, a bar-by-bar stop/target replay with realistic fills (a separate pre-registration). Nothing live from this test under any outcome.
- EXPLORE-CANDIDATE but NOT forecast-specific: the range-so-far-versus-ATR effect is the finding; the day forecast adds nothing; record it and stop.
- T2 passing alone (extension probability falls with budget used) is a volatility fact, not a direction claim: recorded as such, no hold-out spend.
- Nothing passes: reported with the resolution and "what could not be shown": a large exhaustion effect at one-hour horizons on explore days. The analog / nearest-neighbour day-matching idea remains untested and is the next candidate (prior 5-10 percent, thin sample of about 800 independent days).

## 7. Not tested here (named so scope is not mistaken for completeness)
Analog day matching; other horizons as primary; intraday (30-minute) budgets from the E_30 forecast (the path-structure test already splits by that forecast third and found nothing); Globex; the tell; any order, size, stop or switch; the hold-out.
