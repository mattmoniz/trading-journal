# POC-Rotation-Join Exit-Variant Review Under Realistic Stop Fills
## Re-Evaluating the Profit-Lock Hypothesis After Correcting for Fill Mechanics Beyond Market

**Date:** 2026-10-20  
**Author:** Gemini (Autonomous Mining & Data Analysis Agent)  
**Database:** `trading_journal` (Read-Only)  
**Scripts:**  
- Realistic Fills: [`scratch/gemini_poc_join_exit_review_realistic.mjs`](file:///home/mmoniz/trading-journal/scratch/gemini_poc_join_exit_review_realistic.mjs)  
- Prior Ideal Fills: [`scratch/gemini_poc_join_exit_review.mjs`](file:///home/mmoniz/trading-journal/scratch/gemini_poc_join_exit_review.mjs)  
**Data JSON:** [`scratch/gemini_poc_join_exit_review_realistic_data.json`](file:///home/mmoniz/trading-journal/scratch/gemini_poc_join_exit_review_realistic_data.json)  
**Underlying Data Source:** `price_bars_primary` (NQ 1-minute bars), `developing_value_log` (trade dates)

---

## Executive Summary & Plain Verdict

### 1. Does the earlier "L75 decisively beats E1" conclusion survive?
**NO. IT DOES NOT SURVIVE.**  
The earlier conclusion that `L75` (locking 75% of MFE at bar 60) was a superior exit architecture was **entirely an artifact of an unrealistic fill specification** in the initial backtest. 

When realistic order fills are applied—closing at the bar open whenever a stop takes effect while the market is already beyond the stop level (`exitPrice = min(stop, open[k])` for Longs and `max(stop, open[k])` for Shorts)—**`L75` collapses by -$27.07/trade** (from +$31.94 down to **+$4.87/trade**), and its win rate plummets from 71.1% down to **46.9%**.

### 2. Under realistic fills, does ANY variant beat E1 with a CI excluding zero across BOTH eras?
**NO. EXACTLY ZERO VARIANTS BEAT E1_LIVE.**  
- **Pre-2025-06 Era:** `L75` paired delta vs `E1` is **-$0.19/trade** (95% CI: [-$4.08, +$4.01], includes zero).
- **Post-2025-06 Era:** `L75` paired delta vs `E1` is **-$3.90/trade** (95% CI: [-$10.55, +$2.67], includes zero).
- Across the entire 3,972-event sample, **`E1_LIVE` achieves the highest overall expectancy of all evaluated variants (+6.76/trade)**, compared to +$5.52 for `L25`, +$5.13 for `L50`, +$4.87 for `L75`, +$5.08 for `T65`, and +$5.37 for `T130`.

### 3. Why did this happen? (The Anatomy of the Spec Flaw)
In the original specification, "if a stop is hit, exit price = stop price." At bar 60, adaptive rules arm:
- For **`E1_LIVE`**, the stop jumped to breakeven (`entryPrice`). For any trade underwater at minute 60, the simulator magically erased the loss and filled at breakeven ($0 points / -$2 commission). In reality, a sell stop placed above the current market executes immediately as a market order at `open[60]`, realizing the loss. This affected **1,030 trades (25.9% of all events)** with an average penalty of **-$40.96/trade** (-20.48 points), creating a -$10.62/trade drag overall.
- For **`L75`**, the flaw was dramatically more severe. At bar 60, `L75` snapped the stop to `entry + 0.75 * MFE`. If a trade had gained +100 points at minute 15 but retraced to +10 points at minute 59, the ideal simulator retroactively granted an exit at `entry + 75 points`! In reality, at minute 60 the market is at +10 points; placing a stop at +75 triggers immediately at the market open, capturing only +10 points. This affected **2,138 trades (53.8% of all events—more than half the sample!)** with an average penalty of **-$50.29/trade** (-25.15 points), destroying **-$107,524.38** in phantom profits.

---

## 1. Discrepancy Diagnostics: Realistic Fills vs Stop Prices

The table below isolates every trade where the realistic fill price differed from the nominal stop price (`exitPx !== stopPx` on stop hits).

| Metric | `E1_LIVE` (Breakeven Hold) | `L75` (75% MFE Lock) | Comparison / Notes |
|---|:---:|:---:|---|
| **Total Events ($N$)** | 3,972 | 3,972 | Identical signal population |
| **Total Stop Hits** | 2,249 | 2,795 | More stops hit under L75 due to tighter levels |
| **Events Differing from Stop Price** | **1,030** | **2,138** | **2.1x more trades affected under L75** |
| **Share of Stop Hits Differing (%)** | 45.8% | 76.5% | Over 3 out of 4 L75 stop hits were beyond market |
| **Share of ALL Events Differing (%)** | **25.9%** | **53.8%** | **Over half of all trades affected under L75** |
| **Arming Bar ($k=60$) Differing Events** | 1,024 (99.4%) | 2,133 (99.8%) | Overwhelmingly caused by bar 60 arming jump |
| **Subsequent Bar / Gap Differing Events** | 6 (0.6%) | 5 (0.2%) | Bar-to-bar gaps are negligible (<0.2%) |
| **Total Dollar Discrepancy (Drag)** | **-$42,188.50** | **-$107,524.38** | **Phantom profit was 2.55x larger in L75** |
| **Avg $ Difference on Differing Events** | **-$40.96** | **-$50.29** | Signed difference ($P\&L_{\text{real}} - P\&L_{\text{ideal}}$) |
| **Avg Point Difference on Differing Events** | **20.48 pts** | **25.15 pts** | Absolute slippage per affected trade |
| **Overall Impact on Strategy Expectancy** | **-$10.62 / trade** | **-$27.07 / trade** | Diluted across all 3,972 events |

### Key Takeaway on Discrepancy Mechanics
The speculative advantage of `L75` observed in the earlier report was a statistical illusion. Because NQ frequently exhibits sharp initial thrusts followed by heavy mean reversion during the first 60 minutes, the market at minute 60 was sitting substantially below the 75% MFE level on **53.8% of all occurrences**. The ideal model credited exits at high prices that had already ceased to exist.

---

## 2. Headline Performance Tables (Primary Run: Exact Spec, Realistic Fills)

*All metrics reflect realistic fills: stops hit on bar $k$ fill at $\min(\text{stop}, \text{open}[k])$ for Longs and $\max(\text{stop}, \text{open}[k])$ for Shorts. P&L is net dollars per trade ($/trade) after $2 round-trip commission ($2/pt MNQ). Paired difference $\Delta$ vs E1 is $\frac{1}{N}\sum (\text{pnl}_{\text{variant}} - \text{pnl}_{\text{E1}})$. The 95% Confidence Intervals are derived from a 2,000-resample day-blocked bootstrap pooling events by trading day.*

### Overall Population ($N = 3,972$, Distinct Days = 982)

| Variant | Mean $/Trade | Win Rate (%) | Paired $\Delta$ vs E1 | 95% Day-Blocked Bootstrap CI | Excludes Zero? |
|---|---|---|---|---|:---:|
| **E1_LIVE** | **+$6.76** | **19.8%** | **$0.00** | **[+$0.00, +$0.00]** | **Baseline (Best)** |
| **E0_OLD** | +$0.75 | 30.9% | -$6.01 | [-$10.55, -$1.42] | **Yes (Worse)** |
| **E2_FIXED100** | +$4.25 | 46.4% | -$2.51 | [-$6.61, +$1.34] | No |
| **L25** | +$5.52 | 46.9% | -$1.24 | [-$3.93, +$1.27] | No |
| **L50** | +$5.13 | 46.9% | -$1.63 | [-$5.23, +$1.62] | No |
| **L75** | +$4.87 | 46.9% | -$1.89 | [-$5.69, +$1.85] | No |
| **T65** | +$5.08 | 29.6% | -$1.68 | [-$4.99, +$1.34] | No |
| **T130** | +$5.37 | 23.6% | -$1.39 | [-$4.22, +$1.41] | No |

---

### Era Breakdown (Design In-Sample vs Chronological Out-of-Sample)

#### Out-of-Sample Era: Pre-2025-06 ($N = 2,146$, Distinct Days = 595)

| Variant | Mean $/Trade | Win Rate (%) | Paired $\Delta$ vs E1 | 95% Day-Blocked Bootstrap CI | Excludes Zero? |
|---|---|---|---|---|:---:|
| **E1_LIVE** | **+$0.40** | **18.0%** | **$0.00** | **[+$0.00, +$0.00]** | Baseline |
| **E0_OLD** | -$2.43 | 30.4% | -$2.83 | [-$7.78, +$2.30] | No |
| **E2_FIXED100** | -$0.09 | 44.8% | -$0.49 | [-$4.60, +$3.84] | No |
| **L25** | -$0.16 | 44.9% | -$0.56 | [-$3.63, +$2.43] | No |
| **L50** | +$0.05 | 44.9% | -$0.35 | [-$4.20, +$3.54] | No |
| **L75** | +$0.21 | 45.0% | -$0.19 | [-$4.08, +$4.01] | No |
| **T65** | +$0.20 | 26.4% | -$0.20 | [-$3.66, +$3.13] | No |
| **T130** | +$1.10 | 20.6% | +$0.70 | [-$2.24, +$3.44] | No |

#### In-Sample Era: Post-2025-06 ($N = 1,826$, Distinct Days = 387)

| Variant | Mean $/Trade | Win Rate (%) | Paired $\Delta$ vs E1 | 95% Day-Blocked Bootstrap CI | Excludes Zero? |
|---|---|---|---|---|:---:|
| **E1_LIVE** | **+$14.24** | **21.9%** | **$0.00** | **[+$0.00, +$0.00]** | **Baseline (Best)** |
| **E0_OLD** | +$4.49 | 31.4% | -$9.75 | [-$17.84, -$1.68] | **Yes (Worse)** |
| **E2_FIXED100** | +$9.35 | 48.3% | -$4.90 | [-$12.09, +$2.00] | No |
| **L25** | +$12.20 | 49.2% | -$2.05 | [-$6.49, +$2.09] | No |
| **L50** | +$11.10 | 49.2% | -$3.14 | [-$9.20, +$2.43] | No |
| **L75** | +$10.34 | 49.2% | -$3.90 | [-$10.55, +$2.67] | No |
| **T65** | +$10.81 | 33.3% | -$3.44 | [-$9.94, +$2.65] | No |
| **T130** | +$10.39 | 27.1% | -$3.85 | [-$9.35, +$1.09] | No |

---

### Session Breakdown (RTH vs GLOBEX)

#### RTH Session: 09:30-15:59 ET ($N = 1,611$, Distinct Days = 574)

| Variant | Mean $/Trade | Win Rate (%) | Paired $\Delta$ vs E1 | 95% Day-Blocked Bootstrap CI | Excludes Zero? |
|---|---|---|---|---|:---:|
| **E1_LIVE** | **+$8.43** | **25.5%** | **$0.00** | **[+$0.00, +$0.00]** | Baseline |
| **E0_OLD** | +$0.46 | 26.8% | -$7.97 | [-$15.58, -$1.42] | **Yes (Worse)** |
| **E2_FIXED100** | +$6.66 | 46.6% | -$1.77 | [-$7.49, +$3.22] | No |
| **L25** | +$7.80 | 47.1% | -$0.63 | [-$3.16, +$1.73] | No |
| **L50** | +$8.71 | 47.1% | +$0.28 | [-$3.60, +$3.89] | No |
| **L75** | +$7.45 | 47.1% | -$0.98 | [-$6.45, +$3.72] | No |
| **T65** | +$6.96 | 34.1% | -$1.47 | [-$6.23, +$2.84] | No |
| **T130** | +$5.77 | 28.6% | -$2.66 | [-$6.19, +$0.54] | No |

#### GLOBEX Session: Overnight / Extended ($N = 2,361$, Distinct Days = 924)

| Variant | Mean $/Trade | Win Rate (%) | Paired $\Delta$ vs E1 | 95% Day-Blocked Bootstrap CI | Excludes Zero? |
|---|---|---|---|---|:---:|
| **E1_LIVE** | **+$5.63** | **15.9%** | **$0.00** | **[+$0.00, +$0.00]** | Baseline |
| **E0_OLD** | +$0.95 | 33.7% | -$4.67 | [-$11.20, +$1.39] | No |
| **E2_FIXED100** | +$2.60 | 46.3% | -$3.02 | [-$9.02, +$2.30] | No |
| **L25** | +$3.96 | 46.8% | -$1.67 | [-$5.99, +$2.00] | No |
| **L50** | +$2.69 | 46.8% | -$2.94 | [-$8.30, +$2.07] | No |
| **L75** | +$3.11 | 46.8% | -$2.52 | [-$8.06, +$2.81] | No |
| **T65** | +$3.80 | 26.5% | -$1.83 | [-$6.74, +$2.81] | No |
| **T130** | +$5.10 | 20.2% | -$0.53 | [-$4.84, +$3.43] | No |

---

### Direction Breakdown (Long vs Short)

#### Long Trades ($N = 1,906$, Distinct Days = 847)

| Variant | Mean $/Trade | Win Rate (%) | Paired $\Delta$ vs E1 | 95% Day-Blocked Bootstrap CI | Excludes Zero? |
|---|---|---|---|---|:---:|
| **E1_LIVE** | **+$9.03** | **29.2%** | **$0.00** | **[+$0.00, +$0.00]** | **Baseline (Best)** |
| **E0_OLD** | +$1.57 | 34.4% | -$7.46 | [-$11.74, -$2.89] | **Yes (Worse)** |
| **E2_FIXED100** | +$3.78 | 49.3% | -$5.25 | [-$8.51, -$2.05] | **Yes (Worse)** |
| **L25** | +$7.39 | 49.3% | -$1.64 | [-$3.49, +$0.11] | No |
| **L50** | +$5.15 | 49.3% | -$3.88 | [-$6.56, -$1.26] | **Yes (Worse)** |
| **L75** | +$4.72 | 49.3% | -$4.31 | [-$7.38, -$1.36] | **Yes (Worse)** |
| **T65** | +$8.06 | 31.4% | -$0.97 | [-$2.12, +$0.16] | No |
| **T130** | +$8.80 | 29.4% | -$0.23 | [-$1.02, +$0.40] | No |

#### Short Trades ($N = 2,066$, Distinct Days = 922)

| Variant | Mean $/Trade | Win Rate (%) | Paired $\Delta$ vs E1 | 95% Day-Blocked Bootstrap CI | Excludes Zero? |
|---|---|---|---|---|:---:|
| **E1_LIVE** | **+$4.67** | **11.1%** | **$0.00** | **[+$0.00, +$0.00]** | Baseline |
| **E0_OLD** | -$0.00 | 27.6% | -$4.67 | [-$13.03, +$3.10] | No |
| **E2_FIXED100** | +$4.68 | 43.8% | +$0.01 | [-$7.25, +$6.87] | No |
| **L25** | +$3.79 | 44.7% | -$0.88 | [-$5.68, +$3.52] | No |
| **L50** | +$5.11 | 44.7% | +$0.44 | [-$5.98, +$6.38] | No |
| **L75** | +$5.01 | 44.7% | +$0.34 | [-$6.74, +$7.01] | No |
| **T65** | +$2.32 | 27.9% | -$2.35 | [-$8.95, +$3.82] | No |
| **T130** | +$2.21 | 18.3% | -$2.46 | [-$7.83, +$2.88] | No |

---

## 3. Side-by-Side: IDEAL Fill vs REALISTIC Fill

The table below contrasts the previous ideal fill specification with the realistic fill specification across all variants on the full population ($N=3,972$).

| Variant | Ideal Mean ($/tr) | Realistic Mean ($/tr) | Realization Drag ($/tr) | Ideal Win Rate (%) | Realistic Win Rate (%) | Realistic Paired $\Delta$ vs E1 | 95% Day-Blocked CI (Realistic) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **E1_LIVE** | +$17.38 | **+$6.76** | **-$10.62** | 19.8% | 19.8% | **$0.00** | [+$0.00, +$0.00] |
| **E0_OLD** | +$1.38 | +$0.75 | -$0.63 | 30.9% | 30.9% | -$6.01 | [-$10.55, -$1.42] |
| **E2_FIXED100** | +$4.36 | +$4.25 | -$0.12 | 46.4% | 46.4% | -$2.51 | [-$6.61, +$1.34] |
| **L25** | +$19.19 | +$5.52 | -$13.67 | 68.8% | 46.9% | -$1.24 | [-$3.93, +$1.27] |
| **L50** | +$23.94 | +$5.13 | -$18.81 | 70.5% | 46.9% | -$1.63 | [-$5.23, +$1.62] |
| **L75** | **+$31.94** | **+$4.87** | **-$27.07** | **71.1%** | **46.9%** | **-$1.89** | **[-$5.69, +$1.85]** |
| **T65** | +$17.92 | +$5.08 | -$12.84 | 30.8% | 29.6% | -$1.68 | [-$4.99, +$1.34] |
| **T130** | +$16.29 | +$5.37 | -$10.92 | 23.8% | 23.6% | -$1.39 | [-$4.22, +$1.41] |

### Side-by-Side Across Eras

#### Out-of-Sample: Pre-2025-06 ($N = 2,146$)
| Variant | Ideal Mean | Real Mean | Drag | Ideal WR | Real WR | Real $\Delta$ vs E1 | 95% CI (Realistic) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **E1_LIVE** | +$12.79 | **+$0.40** | -$12.39 | 18.0% | 18.0% | $0.00 | [+$0.00, +$0.00] |
| **L75** | +$28.18 | **+$0.21** | -$27.97 | 73.5% | 45.0% | -$0.19 | [-$4.08, +$4.01] |
| **L50** | +$20.40 | +$0.05 | -$20.35 | 72.6% | 44.9% | -$0.35 | [-$4.20, +$3.54] |
| **T65** | +$13.90 | +$0.20 | -$13.70 | 27.4% | 26.4% | -$0.20 | [-$3.66, +$3.13] |

#### In-Sample: Post-2025-06 ($N = 1,826$)
| Variant | Ideal Mean | Real Mean | Drag | Ideal WR | Real WR | Real $\Delta$ vs E1 | 95% CI (Realistic) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **E1_LIVE** | +$22.78 | **+$14.24** | -$8.54 | 21.9% | 21.9% | $0.00 | [+$0.00, +$0.00] |
| **L75** | +$36.36 | **+$10.34** | -$26.02 | 68.2% | 49.2% | -$3.90 | [-$10.55, +$2.67] |
| **L50** | +$28.10 | +$11.10 | -$17.00 | 68.0% | 49.2% | -$3.14 | [-$9.20, +$2.43] |
| **T65** | +$22.63 | +$10.81 | -$11.83 | 34.7% | 33.3% | -$3.44 | [-$9.94, +$2.65] |

---

## 4. Secondary Diagnostic Inquiries under Realistic Fills

### A. Arming Impact & Outcome Changes (L50 vs T65)
- **Total Trades Arming ($k \ge 60$ reached):** 2,716 trades (68.4% of total sample)
- **L50 Impact:**
  - Arming reached: 2,716
  - Changed outcome vs E1: **1,580 trades (39.8% of all events, 58.2% of armed events)**  
    *(Down from 92.6% in ideal fills, because trades that gap through or open past the lock level exit at identical market prices as E1).*
- **T65 Impact:**
  - Arming reached: 2,716
  - Changed outcome vs E1: **887 trades (22.3% of all events, 32.7% of armed events)**.

### B. E1 Round Trips & Rescue Rates
A round trip is defined as an event that reached minute 60 in open profit but finished with $P\&L_{\text{E1}} \le 0$ ($N = 1,094$ trades, 27.5% of total events).
- Under realistic fills, the rescue counts are:
  - **`E1_LIVE`:** 0 (0.0% — baseline)
  - **`E0_OLD`:** 692 (63.3%)
  - **`E2_FIXED100`:** 1,058 (96.7%)
  - **`L25`:** 1,028 (94.0%)
  - **`L50`:** 1,028 (94.0%)
  - **`L75`:** 1,028 (94.0%)  
    *(Down from 1,093 in ideal fills: 65 trades were in an open gain at bar 60 close, but opened bar 60 with a minor dip or gap that triggered an immediate realistic fill at or below breakeven).*
  - **`T65`:** 382 (34.9%)
  - **`T130`:** 151 (13.8%)

### C. Top-5 Outlier Share of Total Delta vs E1
Under realistic fills, all variants underperform `E1_LIVE` on net. The top 5 events that *favored* each variant over `E1` are compared against the total negative deficit:

| Variant | Total Population $\Delta$ vs E1 | Top-5 Advantage Sum ($) | Top-5 Share of Delta | Top-5 Advantage Events ($) |
|---|:---:|:---:|:---:|:---:|
| **E1_LIVE** | $0 | $0 | 0.0% | Baseline |
| **E0_OLD** | -$23,870 | +$2,387 | -10.0% | +531.0, +505.5, +484.0, +468.5, +398.0 |
| **E2_FIXED100** | -$9,988 | +$2,736.5 | -27.4% | +747.5, +531.0, +505.5, +484.0, +468.5 |
| **L25** | -$4,944.5 | +$1,559.75 | -31.5% | +509.1, +297.2, +290.8, +232.5, +230.1 |
| **L50** | -$6,486.5 | +$2,690.25 | -41.5% | +783.0, +629.2, +460.2, +420.2, +397.5 |
| **L75** | -$7,520.75 | +$2,687.75 | -35.7% | +749.4, +541.1, +515.2, +446.2, +435.8 |
| **T65** | -$6,692.5 | +$3,015.5 | -45.1% | +739.5, +593.0, +591.5, +557.0, +534.5 |
| **T130** | -$5,530.5 | +$3,819.5 | -69.1% | +1006.0, +899.0, +660.5, +644.5, +609.5 |

Notice that `L75` gives up -$7,520.75 in total net P&L relative to `E1_LIVE`. It does not have an edge to analyze for concentration; it is net negative overall.

---

## 5. Sensitivity Analysis: Volume-Weighted Profile Run

To guarantee complete consistency, the full realistic simulation was re-run across the volume-weighted profile dataset ($N = 3,692$ valid trades over 885 sessions):

### Discrepancy on Volume-Weighted Run
- **`E1_LIVE`:** 1,024 differing events (27.7% of sample), total drag **-$46,532.50**, avg **-$45.44/trade** on differing events.
- **`L75`:** 2,033 differing events (55.1% of sample), total drag **-$113,523.38**, avg **-$55.84/trade** on differing events.

### Volume-Weighted Headline Results ($N = 3,692$)

| Variant | Ideal Mean ($/tr) | Real Mean ($/tr) | Drag ($/tr) | Real Win Rate (%) | Real $\Delta$ vs E1 | 95% Day-Blocked CI (Real) | Excludes Zero? |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **E1_LIVE** | +$13.44 | **+$0.83** | -$12.60 | 15.3% | $0.00 | [+$0.00, +$0.00] | Baseline |
| **E0_OLD** | +$1.61 | +$1.15 | -$0.46 | 29.9% | +$0.31 | [-$5.47, +$5.61] | No |
| **E2_FIXED100** | -$0.47 | -$0.55 | -$0.08 | 44.8% | -$1.38 | [-$6.55, +$3.13] | No |
| **L25** | +$15.11 | -$1.16 | -$16.27 | 45.0% | -$1.99 | [-$6.03, +$1.40] | No |
| **L50** | +$21.89 | +$0.07 | -$21.81 | 45.0% | -$0.76 | [-$5.36, +$3.24] | No |
| **L75** | +$30.43 | -$0.32 | -$30.75 | 45.0% | -$1.15 | [-$6.22, +$3.19] | No |
| **T65** | +$14.64 | -$0.36 | -$15.01 | 28.1% | -$1.20 | [-$5.85, +$3.10] | No |
| **T130** | +$13.68 | +$0.83 | -$12.85 | 19.7% | -$0.01 | [-$3.80, +$3.20] | No |

### Volume-Weighted Era Breakdown
- **Pre-2025-06 ($N = 1,931$):**
  - `E1_LIVE`: +$0.63/trade
  - `L75`: -$0.85/trade (Paired $\Delta = -\$1.49$, 95% CI: [-$9.02, +$4.39], includes zero)
  - `L50`: +$0.67/trade (Paired $\Delta = +\$0.04$, 95% CI: [-$7.32, +$5.48], includes zero)
- **Post-2025-06 ($N = 1,761$):**
  - `E1_LIVE`: +$1.05/trade
  - `L75`: +$0.27/trade (Paired $\Delta = -\$0.78$, 95% CI: [-$7.57, +$5.87], includes zero)
  - `L50`: -$0.58/trade (Paired $\Delta = -\$1.63$, 95% CI: [-$7.84, +$4.15], includes zero)

In the volume-weighted dataset, `L75` actually produces a **net negative expectancy** (-$0.32/trade overall, -$0.85/trade in Pre-2025-06).

---

## 6. Statistical Verdict & Recommendation

### Multiple-Comparison Accounting
Across 7 candidate variants evaluated against `E1_LIVE` under rigorous realistic fill constraints:
1. **Did any variant beat E1 with a 95% CI excluding zero in BOTH eras?**  
   **NO. Zero out of 7 variants.**
2. **Did any variant beat E1 with a 95% CI excluding zero in EVEN ONE era?**  
   **NO. Zero out of 7 variants.**  
   Every single variant has confidence intervals that cleanly cross zero in both Pre-2025-06 and Post-2025-06.
3. **Did any variant beat E1 in overall point estimate?**  
   **NO.** In the primary dataset, `E1_LIVE` (+6.76) beats all other variants (which cluster between +0.75 and +5.52). In the volume dataset, `E1_LIVE` (+0.83) is tied or superior to all adaptive variants.

### Final Takeaways
1. **The "Profit-Lock" Concept Was Severely Flawed by Retroactive Lookahead:**  
   Locking a fraction of past excursion $k$ minutes into a trade implicitly assumes you can capture that excursion *after* price has already reversed. In live execution, once price pulls back, your order executes at the market price, not at the prior peak. Because NQ consolidations routinely mean-revert before continuing, aggressive lock levels like 75% trigger instant fills at market open at severe discounts to the locked price on more than 53% of all trades.
2. **`E1_LIVE` Remains the Superior Production Choice:**  
   While `E1_LIVE` also suffers from arming slippage when underwater at minute 60 (affecting 25.9% of trades), letting surviving trades run with a wide breakeven buffer gives winners the room they need to develop into outsized trends without getting prematurely shaken out at adverse prices.
3. **Recommendation:**  
   **Do NOT deploy `L75` or any of the MFE-lock variants.** Retain `E1_LIVE` as the production baseline. Any future exit research must account for realistic fill mechanics at the arming boundary as an explicit constraint.
