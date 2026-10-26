# Does ES corroborate the NQ move at a level touch? (pre-registration, 2026-10-25)

User's idea, verbatim: "use es price at the same moment leading up to the trade to see if it's corroborating the nq move... if nq is slipping, is es slipping? Or vice versa finding support." Committed BEFORE any outcome is computed. Nothing here changes live behaviour. Companion docs and lessons: `docs/MECHANISM_DECOMPOSITION_PREREG_20261026.md` (its Amendment 1 and the control-artifact audit apply: compare with the absolute return, never trust a same-day random control, report what could not be shown).

## Hypothesis (the user's, stated so it can fail)
At an NQ level touch, the fade (buying a falling NQ at support, selling a rising NQ at resistance) works BETTER when ES did not move as much as NQ into the level (NQ stretched, ES "finding support") and WORSE when ES moved with it, or more than NQ (a confirmed move that is more likely to break the level). If true, "skip the fade when ES confirms" is a usable filter and an ES-aware sizing read exists.

## Population
The level touches of `scratch/level_touch_events_20261026.json` (builder `scripts/build_level_touch_events_20261026.mjs`: first touch per level per day, NQ RTH 2023-03-06..2026-10-23, same exclusions), restricted to touches where ES has clean data: the ES front contract (`es_front_calendar`) has `rth_minutes >= 371` that day, the day is not an ES roll day, and ES and NQ closes exist at the needed timestamps. The thin back-month stretch 2025-12-29..2026-03-13 and the early-2023 stretch drop out automatically. Counts of touches and days are printed before any outcome. RTH only (Globex deferred, see below).

## Features (closed bars strictly before the event bar `t`; entry is `open[t+1]`)
For a lookback `L` in {5, 15, 60} minutes and fade direction `f` (+1 long fade, -1 short fade), the approach moves, in the direction price travelled into the level:
- `aN_L = -f * (C_NQ[t-1] - C_NQ[t-1-L]) / ATR20_NQ`
- `aE_L = -f * (C_ES[t-1] - C_ES[t-1-L]) / ATR20_ES` (ES front contract from `price_bars_es_front`, same timestamps)
ATR20 is the mean RTH range of the 20 prior sessions for each market (ES: prior sessions with at least 371 RTH minutes), so the two moves are in comparable units. Positive = price moved toward the level.
- **Divergence** `r_L = aN_L - b_L * aE_L`, where `b_L` is the OLS slope of `aN_L` on `aE_L` fitted on EXPLORE touches only (explore cuts apply to hold-out unchanged). `r_L` is the part of NQ's approach that ES does not explain. High `r_L` = NQ stretched beyond ES ("ES not confirming"); low `r_L` = ES moved as much or more ("ES confirming"). Using the residual, not the raw difference, keeps `r_L` from being a re-labelled NQ approach size.

## Outcome
`ret60 = f * (C_NQ[t+60] - O_NQ[t+1]) / ATR20_NQ`, ABSOLUTE (not excess over a control): the contrast below compares two groups of touches with the same fade direction, so drift and the time-of-day baseline cancel; the matched-control artifact seen in the mechanism study cannot enter. Secondary, informational: the simulated symmetric +/-0.5 ATR20 trade P&L in dollars (per-trade mean).

## Tests (6, counted up front)
`L` in {5, 15, 60} x `f` in {short, long}. Statistic: weighted mean `ret60` of the TOP tercile of `r_L` minus the BOTTOM tercile (cuts from explore, per `f`), computed WITHIN strata of NQ's own approach (tercile of `aN_L`, explore cuts) x time bucket (first hour, mid, last 90) x level family, strata-weighted by arm size, so the contrast isolates what ES adds beyond NQ's own stretch and the session context. Weights `1/nLevels` (a bar firing several levels counts once). Chronological split by DATE: explore = earliest 60% of the touch days, hold-out the rest. Day-blocked bootstrap (2,000 seeded draws; days resampled, the stratified difference recomputed in every draw).
- Screening: explore two-sided bootstrap p; BH at q = 0.10 over the 6 tests (arms below 100 touches on 40 days in explore are listed as underpowered and excluded).
- **SHOWN** only if: BH survivor on explore AND hold-out stratified difference has the same sign with one-sided p < 0.05 AND its magnitude is at least half of explore AND the sign is the hypothesis' (high `r_L` better). A significant effect in the OPPOSITE direction (ES confirming is better) is reported as such, not as support.
- **Practical bar (frozen):** a SHOWN difference below 0.02 ATR60 (about 10 dollars per trade at the median ATR20 of roughly 240 points; commission is 2 dollars plus slippage) is reported as "real but too small to trade".
- Reference rows, untested: the same contrast for NQ's own approach `aN_L` (does NQ stretch alone predict?), and the unstratified contrast.
- Permutation sanity: re-pair each touch with the ES features of a DIFFERENT day at the same minute of day (1,000 draws, day-blocked), and report where the observed stratified difference falls in that null.
- Informational filter read: the mean `ret60` and symmetric-trade dollars of touches in the bottom tercile of `r_15` (ES confirming) vs the rest, and what dropping them would do to the per-trade mean and the trade count. No gate is proposed on this.

## What could not be shown (declared up front)
- `L` and the minute-level resolution are coarse; NQ and ES correlate 0.91 per minute, so `r_L` has small variance and is a noisy feature. A lead-lag that is arbitraged away in seconds is invisible at 1-minute bars.
- Power: with about 15,000 usable touches, terciles near 5,000 each, the expected 95% half-width of a stratified difference is roughly 0.01-0.02 ATR60 (about 5-10 dollars); a smaller true effect cannot be resolved.
- Globex is not evaluated. The ES-NQ relationship and the Globex fade engine are both different from RTH, and Globex reverses RTH pressure signals on this roster. Per the hard rule, nothing is wired until Globex is tested or an OPEN_DECISION records why not.
- ES and NQ share the same days, so ES corroboration is not an independent sample; it can only add information about the move, not extra evidence about luck.

## Honest expectation (committed before the data)
About a 10% chance of any SHOWN cell at or above the practical bar; most likely a null or a real-but-tiny effect. A null closes the question for 1-minute bars; it would not close it for tick-level or second-level lead-lag, which this data cannot test.

## What follows
SHOWN and above the bar: an observation-only shadow tag first (house pattern, logic in `server/services/`, not `acd.js`), forward tracking with a frozen rule, then a Globex test before any wiring. Otherwise: record the claim with the power statement and close the lead as "unresolved at this resolution, not refuted".

---

## Amendment 1 (2026-10-25, committed BEFORE any outcome) — the user's "use ES as the canary"

The user's clarification: ES should act as an early warning, i.e. ES turns FIRST and NQ follows. That is a lead-lag question about the last few bars before the touch, which the approach-divergence family above (`r_L`, a 5/15/60-minute read of how stretched NQ is relative to ES) does not test. Added as a separate **Family C**; Family A (confirmation/divergence, 6 tests) is unchanged.

**Prior stated honestly before the data.** The unconditional one-minute lead-lag between the two markets is essentially zero on the loaded data (correlation of ES[t-1] with NQ[t] is -0.000, of NQ[t-1] with ES[t] is +0.011, about 55,000 sampled minutes each; `scripts/verify_es_bars_20261026.mjs`). So any canary effect would have to be specific to moments at a level, at minute resolution. I expect about a 5% chance of a SHOWN cell in Family C. The fast lead of ES over NQ that traders talk about lives at the second and sub-second scale, which one-minute bars cannot see.

**Feature (closed bars strictly before the event bar `t`):** for `k` in {1, 3} minutes, the recent move in the FADE direction, ES minus what NQ explains:
- `nN_k = f * (C_NQ[t-1] - C_NQ[t-1-k]) / ATR20_NQ`, `nE_k = f * (C_ES[t-1] - C_ES[t-1-k]) / ATR20_ES` (sign: positive = already moving in the direction the fade wants, i.e. turning).
- **Canary** `c_k = nE_k - d_k * nN_k`, with `d_k` the OLS slope of `nE_k` on `nN_k` fitted on explore touches only. High `c_k` = ES has already turned in the fade direction more than NQ has ("ES bounced first"); low `c_k` = ES still leaning with the move.
**Hypothesis:** high `c_k` (ES turned first) makes the fade better.

**Tests (4, a separate BH family at q = 0.10 over its own four explore p-values; Family A keeps its own six):** `k` in {1, 3} x `f` in {short, long}; the same statistic, strata, weights, split, SHOWN rule, 0.02 ATR60 practical bar, permutation sanity and reference rows as Family A (the reference row here is NQ's own recent turn `nN_k`).

**Reporting duties added:** the two families are reported separately and never pooled; the total is 10 hypothesis tests (6 + 4); a SHOWN cell in Family C must also be checked against the unconditional baseline above (a canary that merely re-states NQ's own turn would show up in the `nN_k` reference row).

---

## Amendment 2 (2026-10-25, committed BEFORE any outcome) — Family D: ES at its OWN extreme ("finding support")

The user's wording "if NQ is slipping, is ES slipping? Or vice versa finding support" also reads as: when NQ is at a level, is ES ALSO at its own day extreme (both at support), or is ES holding away from it? Families A and C test how ES MOVED; this tests where ES SITS.

**Feature (closed bars strictly before `t`):** the position of the last closed ES close inside the range of ES closes from 09:30 through `t-1` (needs at least 5 bars), in the fade direction: short fade `xE = (C_ES[t-1] - minC_ES) / (maxC_ES - minC_ES)`, long fade `xE = (maxC_ES - C_ES[t-1]) / (maxC_ES - minC_ES)`; `xN` is the same on NQ closes (close-based for both so they are comparable). `xE` near 1 = ES is also at its own day extreme in the direction of the touch.
**Hypothesis (the user's):** high `xE` (ES confirming from its own extreme) makes the NQ fade better.
**Tests (2, a separate BH family of its own):** `f` in {short, long}; top vs bottom tercile of `xE` (explore cuts) within strata of NQ's own `xN` tercile x time bucket x level family (so what ES adds beyond NQ's own extremity is isolated); same weights, split, SHOWN rule, practical bar, permutation sanity (ES `xE` re-paired within the same minute of day and `f`) and NQ-only reference row (`xN` alone). Total hypothesis tests: 12 (A 6, C 4, D 2), reported as three families, never pooled.
**A note on direction, fixed here so it cannot be flipped afterwards:** every test is screened two-sided and the label says whether the sign matches the stated hypothesis. If ES CONFIRMING (moving with NQ into the level, or sitting at its own extreme) turns out to be the better fade, that is reported as the result, not discarded as "opposite".

---

## Amendment 3 (2026-10-25, committed BEFORE any outcome) — from the DeepSeek design critique `reports/deepseek_es_corroboration_prereg_2026-10-26.md` (all eight amendments adopted; its findings were checked against the code)

Corrections to my own text: (i) the sentence in the Features section saying the residual "keeps `r_L` from being a re-labelled NQ approach size" is WRONG. `r_L` is NQ's approach residualized against ES; it is NOT orthogonal to NQ's own move (corr(`r_L`, `aN_L`) is about sqrt(1 - rho^2), roughly 0.3-0.4 at these horizons). The isolation of ES information comes from the `aN_L`-tercile stratification and the NQ-only reference row, not from the residual alone. The audit line printed by the script ("should be near 0") is therefore not a gate and is reworded as "expected 0.3-0.4, not near 0". (ii) The canary question (Family C) is largely not resolvable at one-minute bars.

Adopted, verbatim in effect:
1. **Reference-row gate.** A cell is SHOWN only if the NQ-only reference row (same terciles of NQ's own move, stratified bucket x family) does NOT reproduce the same sign with a magnitude of at least half of the cell's all-data stratified difference; otherwise the cell is reported as "ES adds nothing beyond NQ".
2. **Hold-out power.** The hold-out 95% CI half-width is printed for every test. If it is at or above 0.02 ATR60 the cell is labelled UNDERPOWERED AT HOLD-OUT and a hold-out null there is reported "could not be resolved at the practical bar", not as a refutation. (The 60/40 split makes the hold-out about 1.6x wider than the full sample.)
3. **Within-day demeaning.** The contrast is also computed with `ret60` demeaned within day and `f` (ret60 minus the mean ret60 of that day's touches with the same `f`). A SHOWN must keep the sign in explore AND hold-out on the demeaned contrast, with explore magnitude at least half of the absolute contrast.
4. **Alignment proof and counts.** The ES join is exact naive-ET timestamp equality with drop-on-missing, never a positional shift. Before any outcome: touches dropped per `L` and `k` for a missing ES or NQ minute are printed, and so are first-hour touches whose 60-minute lookback reaches before 09:30 (overnight bars). The lag-0 dominance check is re-run on ALL days (not the 1-in-6 sample) and on the 04:00-09:30 ET window.
5. **Family C nulls.** A touch with a null `nN_k` or `nE_k` is excluded from Family C and from its OLS fit (it must not be coerced to 0 into the bottom tercile).
6. **Practical bar.** The 0.02 ATR60 bar is evaluated on the HOLD-OUT stratified difference, and the symmetric-trade dollar P&L of the top and bottom arms is printed beside it (`ret60` is exit-free).
7. **Opposite-direction recording.** A significant cell whose sign is opposite to the stated hypothesis is recorded with the status OPPOSITE, listed separately from hypothesis-supporting SHOWN cells, as a result in its own right.
8. **Canary scope.** Family C is EXPLORATORY at one-minute resolution and carries no confirmatory weight. The unconditional one-minute ES-to-NQ lead is about 0, so any canary lives below this resolution; a Family C SHOWN would need a tick or second-level dataset before any decision, and a Family C null is recorded "unresolved at this resolution", never "no canary". Family D (Amendment 2) uses the same gates as Family A.
