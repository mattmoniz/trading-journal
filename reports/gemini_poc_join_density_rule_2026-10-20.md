# Pre-Registered Evaluation of POC_ROTATION_JOIN Low-Density Entry Rule
**Date:** 2026-10-20  
**Specification:** `docs/POC_JOIN_DENSITY_RULE_PREREG_20261020.md`  
**Execution Script:** `scratch/gemini_poc_join_density_rule.mjs`  
**Raw Results:** `scratch/gemini_poc_join_density_rule_results.json`  
**Status:** Independent Build & Run Complete — **OVERALL VERDICT: FAIL**

---

## 1. Executive Summary

This study independently evaluates the pre-registered "low-density entry" rule for `POC_ROTATION_JOIN` signals against the live-exit realistic-fill E1 model (100pt catastrophic stop, breakeven stop armed at forward bar 60, exit on next signal or 24 hours, realistic execution fills at `min/max(stop, open)`, $2/pt, $2 round trip).

The rule hypothesizes that join rotations entering at prices with low prior volume (`dens3 <= 0.3392` on the 3-session composite RTH profile, fixed at the 33.3rd percentile of the exploration set) isolate superior POC joins compared to entries at heavy-volume nodes.

Across the pre-registered **HOLD-OUT universe** (2,402 joins across trade dates `2025-01-01` through `2026-10-16`), the low-density entry rule **fails 3 of the 6 pre-registered pass criteria**:
1. **Delta vs Unselected Baseline is Negative Overall and Spans Zero (Criterion 2: FAIL):** Passing hold-out joins underperform the unselected baseline overall (-$1.32/trade; passing mean $9.06 vs all hold-out mean $10.38). In the 2025 half, passing underperforms by -$2.41/trade ($4.87 vs $7.28). In the 2026 half, passing shows a negligible difference of +$0.19/trade ($13.59 vs $13.40). The 95% day-blocked bootstrap confidence interval `[-$11.11, +$9.29]` spans zero broadly.
2. **Shifted-Profile Placebo Shows No Edge for True Entry Price (Criterion 3: FAIL):** Recomputing density with the profile shifted by `±0.3` and `±0.6` x ATR20 yields a pooled shifted mean P&L of $11.03 (N = 4,531), which is **higher** than the real passing mean ($9.06). The real minus shifted difference is -$1.97 with a 95% day-blocked CI of `[-$11.18, +$8.54]`, failing to separate from zero.
3. **Severe Tail Concentration (Criterion 5: FAIL):** Passing set P&L is entirely lottery-driven: the top 5 passing events generated $8,996.50, which constitutes **112.23%** of the total net P&L of the entire 885-trade passing set ($8,016.00).

**Overall Verdict:** **FAIL**. In plain English: **low-density entries do not identify better POC joins**. The strong pattern observed in the pre-2025 exploration data (+ $9.60 delta, +$10.42 placebo separation) failed completely out of sample on the hold-out.

---

## 2. Methodology & Construction

The test was built strictly to the pre-registration specification (`docs/POC_JOIN_DENSITY_RULE_PREREG_20261020.md`):
- **Universe & Dates:** All trading days from `developing_value_log` between `2023-03-06` and `2026-10-16` (889 candidate sessions after excluding NQ roll weeks via `isInsideNqRollWeek`).
- **Signal Generation:** Canonical `detectSignalEvents(65, 'standard', theta, [{ t: d, bars }], 'fixed')` with point-in-time `THETA` (180-day rolling median of intraday bar range).
- **Session Bar Filtering:** Sessions spanning previous day 18:00:00 to date `d` 16:59:59 ET with `>= 100` bars and `>= 90%` minute density.
- **Entry & Forward Window:** Entry at the open of the bar immediately following the trigger bar (`ev.trigger_idx + 1`). Forward window extends strictly after the entry bar to the next signal entry or 24 hours (whichever is earlier). Trades with `< 2` forward bars were dropped (2 trades).
- **Realistic E1 Exit Simulation:**
  - Initial 100 pt catastrophic stop.
  - Breakeven stop moved to entry price starting at forward bar `k = 60` (armed before bar evaluation).
  - Realistic stop fills at `min(stop, open)` for longs and `max(stop, open)` for shorts if the bar opens through the stop.
  - Contract sizing: $2/point, $2 round-trip commission.
- **Composite Profile Construction:**
  - `computeProfile(bars)` from `server/services/developingValueService.js` applied to pooled 1-minute RTH bars (09:30–15:59 ET) of the 3 most recent RTH sessions strictly preceding the event's trade date `d`.
  - Qualifying RTH sessions strictly require `>= 300` RTH bars.
  - `density(entry)` = volume of the profile level within 0.125 of `entryPrice` (0 if no volume at level).
  - `meanDens` = `totalVol / max(1, (maxPrice - minPrice)/0.25 + 1)`.
  - `dens3` = `density(entry) / meanDens`.
- **Pre-Registered Cut:** `dens3 <= 0.3392` (fixed from the 33.3rd percentile of the exploration half; never re-derived).
- **Hold-Out Definition:** Trade date `d >= '2025-01-01'` (using the session's trade date `d`, not the entry calendar date).
- **Hold-Out Halves:** 2025 half (`d` in 2025) vs 2026 half (`d` in 2026).
- **Dataset Counts:**
  - Total detected signal events: 3,974
  - Total valid trades (fwd bars >= 2): 3,972
  - Study universe (having ATR20 and 3-session profile): 3,923
  - Exploration half (`d < '2025-01-01'`): 1,521 (matches pre-registration exactly)
  - Hold-out set (`d >= '2025-01-01'`): 2,402 (matches pre-registration exactly)
    - Hold-out 2025 half: 1,185
    - Hold-out 2026 half: 1,217

---

## 3. Hold-Out Primary Comparison

Per-trade means (`sum / N`), with day-blocked bootstrap (2,000 resamples, seed 42) computing 95% percentile confidence intervals:

| Cohort | Sub-Period | N Total | N Pass | Pass Rate (%) | Mean P&L ALL ($) | Mean P&L PASS ($) | Delta (PASS - ALL) ($) | 95% Day-Blocked Bootstrap CI ($) |
|---|---|---|---|---|---|---|---|---|
| **Hold-Out Overall** | Full Hold-Out (2025-01-01 .. 2026-10-16) | 2,402 | 885 | 36.84% | $10.38 | $9.06 | **-$1.32** | `[-$11.11, +$9.29]` |
| **Hold-Out 2025 Half** | 2025 (2025-01-01 .. 2025-12-31) | 1,185 | 460 | 38.82% | $7.28 | $4.87 | **-$2.41** | `[-$14.49, +$10.11]` |
| **Hold-Out 2026 Half** | 2026 (2026-01-01 .. 2026-10-16) | 1,217 | 425 | 34.92% | $13.40 | $13.59 | **+$0.19** | `[-$15.36, +$19.28]` |

*Observations:*
- Passing events underperformed the unselected hold-out baseline by -$1.32/trade.
- In 2025, passing events underperformed by -$2.41/trade.
- In 2026, passing events barely matched the baseline (+$0.19/trade).
- The 95% day-blocked bootstrap confidence interval `[-$11.11, +$9.29]` spans zero symmetrically.

---

## 4. Hold-Out Tail Metrics

1. **Probability of Large Gainers (`P(pnl >= +100)`):**
   - **ALL Hold-Out Events:** 13.32% (320 / 2,402)
   - **PASSING Hold-Out Events:** 13.90% (123 / 885)
   - *Result:* Minimal difference (+0.58 percentage points).

2. **P&L Captured as Share of Total:**
   - Total P&L of ALL Hold-Out events: **$24,934.00**
   - Total P&L of PASSING Hold-Out events: **$8,016.00**
   - Share captured: **32.15%** (passing events are 36.84% of trades).

3. **Top-5 Event Concentration in Passing Set:**
   - Top-5 passing trades: `[+$3,051.50, +$2,424.50, +$1,316.00, +$1,108.00, +$1,096.50]`
   - Sum of Top-5 trades: **$8,996.50**
   - Total net P&L of the entire 885-trade passing set: **$8,016.00**
   - **Top-5 Share:** **112.23%**
   - *Result:* Exceeds 100% because the remaining 880 passing trades generated an aggregate net loss of -$980.50. The passing set is an unhedged lottery ticket.

---

## 5. Hold-Out Placebo 1: Flipped Direction

Evaluated by flipping trade direction (Short instead of Long, Long instead of Short) on the passing entries:
- **Simulated E1 (Opposite Entry Direction):** Inverted direction simulated through the full E1 realistic state machine (100pt stop on opposite side, BE arming at forward bar 60).
- **Exact-Fill Inverted P&L:** realised points inverted on identical fills (`-pts * 2 - 2`).

| Sub-Period | Real Passing Mean P&L ($) | Flipped Sim Mean P&L ($) | Flipped Same-Fill Mean P&L ($) | Passing Beats Flipped Sim? |
|---|---|---|---|---|
| **Hold-Out Overall** | **+$9.06** | -$7.71 | -$13.06 | **YES** (+$16.77 margin) |
| **Hold-Out 2025 Half** | **+$4.87** | -$4.27 | -$8.87 | **YES** (+$9.14 margin) |
| **Hold-Out 2026 Half** | **+$13.59** | -$11.45 | -$17.59 | **YES** (+$25.04 margin) |

*Result:* Passing entries beat the flipped direction overall and in both halves. This reflects the underlying baseline drift of the market and the POC join setup itself, not an edge specific to density.

---

## 6. Hold-Out Placebo 2: Shifted-Profile Placebo

Recomputing `dens3` by shifting the composite profile by `[-0.6, -0.3, +0.3, +0.6] x ATR20` (equivalently evaluating profile density at `entryPrice - s * ATR20` rounded to nearest 0.25 level) and applying the same cut `0.3392`:

| Shift Factor `s` | Shifted Passing Count | Shifted Passing Rate (%) |
|---|---|---|
| -0.6 x ATR20 | 1,576 | 65.61% |
| -0.3 x ATR20 | 1,232 | 51.29% |
| +0.3 x ATR20 | 765 | 31.85% |
| +0.6 x ATR20 | 958 | 39.88% |
| **Pooled Shifted Population** | **4,531** | **47.16%** |

- **Pooled Shifted Mean P&L:** **$11.03**
- **Real Passing Mean P&L:** **$9.06**
- **Real minus Shifted Difference:** **-$1.97**
- **95% Day-Blocked Bootstrap CI on Difference:** `[-$11.18, +$8.54]`

*Result:* The shifted-profile placebo produced a higher mean return ($11.03) than the unshifted density filter ($9.06). The confidence interval broadly overlaps zero, confirming that low density at the entry price provides no localized edge over arbitrary price offsets.

---

## 7. Evaluation of the 6 Pre-Registered Pass Criteria

| # | Criterion Specification | Value / Result | Status |
|---|---|---|---|
| **1** | N passing >= 100 overall and >= 40 in each hold-out half | Overall: **885** (>=100)<br>2025 Half: **460** (>=40)<br>2026 Half: **425** (>=40) | **PASS** |
| **2** | Passing-minus-all > 0 with overall day-blocked 95% CI excluding zero, and > 0 in both hold-out halves | Overall Delta: **-$1.32** (not > 0)<br>Overall 95% CI: `[-$11.11, +$9.29]` (includes 0)<br>2025 Delta: **-$2.41** (not > 0)<br>2026 Delta: **+$0.19** | **FAIL** |
| **3** | Real minus shifted-profile placebo: CI excludes zero | Difference: **-$1.97**<br>95% CI: `[-$11.18, +$8.54]` (includes 0) | **FAIL** |
| **4** | Passing mean beats flipped-direction placebo overall and in both halves | Overall: +$9.06 vs -$7.71 (Pass)<br>2025: +$4.87 vs -$4.27 (Pass)<br>2026: +$13.59 vs -$11.45 (Pass) | **PASS** |
| **5** | Top-5 share of passing set's total P&L < 50 percent | Top-5 Sum: $8,996.50<br>Total Pass P&L: $8,016.00<br>Share: **112.23%** (not < 50%) | **FAIL** |
| **6** | P(pnl >= +100) of passing > all | Passing: **13.90%**<br>ALL Hold-Out: **13.32%**<br>(13.90% > 13.32%) | **PASS** |

### **Overall Verdict: FAIL**
Only 3 of 6 pre-registered criteria passed. Under the explicit rules of `docs/POC_JOIN_DENSITY_RULE_PREREG_20261020.md`, all 6 criteria must hold.

**Plain English Conclusion:**  
**Low-density entries do not identify better POC joins.**

---

## 8. Exploration Set Breakdown (Reference Only)

For completeness, below are the identical metrics evaluated on the **EXPLORATION half** (trade dates `2023-03-06` to `2024-12-31`), strictly labeled **reference only**:

| Metric | Exploration Value (Reference Only) | Comparison vs Hold-Out |
|---|---|---|
| Universe N | 1,521 | Hold-Out was 2,402 |
| Passing N (`dens3 <= 0.3392`) | 506 (33.27%) | Hold-Out was 885 (36.84%) |
| Mean P&L ALL | $1.14 | Hold-Out was $10.38 |
| Mean P&L PASSING | $10.74 | Hold-Out was $9.06 |
| **Delta (PASS - ALL)** | **+$9.60** (95% CI: `[-$0.02, +$20.99]`) | Hold-Out was **-$1.32** |
| P(pnl >= +100) PASS vs ALL | 14.23% vs 11.11% | Hold-Out was 13.90% vs 13.32% |
| Top-5 Share of Passing P&L | 65.94% ($3,584.50 / $5,436.00) | Hold-Out was 112.23% |
| Flipped Sim Mean | -$3.45 | Hold-Out was -$7.71 |
| Shifted Placebo Pooled Mean | $0.32 | Hold-Out was $11.03 |
| **Real minus Shifted Placebo Diff** | **+$10.42** (95% CI: `[+$1.64, +$20.25]`) | Hold-Out was **-$1.97** |

*Methodological Note:*  
In the exploration window, low-density entries exhibited an apparent +$9.60 edge over baseline and a +$10.42 advantage over shifted profile placebos (with the placebo CI excluding zero). However, this edge evaporated entirely on the true hold-out (delta -$1.32, placebo difference -$1.97), illustrating classical in-sample overfitting to noise in historical volume profiles. Pre-registration successfully prevented a false positive from entering production.
