# POC_ROTATION_JOIN "Bad-Day VWAP Gate" — Pre-Registered Test Report

**Execution Date:** 2026-10-20  
**Specification:** `docs/POC_JOIN_BAD_DAY_VWAP_PREREG_20261020.md`  
**Script:** `scratch/gemini_poc_join_bad_day_vwap.mjs`  
**Status:** **FAIL** (the VWAP gate does NOT help on losing days)

---

## 1. Executive Summary & Plain-English Verdict

This test evaluated the hypothesis that when the trading session is already in a substantial drawdown (running realized same-day POC join P&L $\le -$400), restricting entries strictly to VWAP-aligned joins (session VWAP slope lookback 60m, volume-weighted via `volume::float`, dynamic rolling flat cut) avoids catastrophic runaway losses.

The running STATE was computed in point-of-time tradeable fashion: the sum of realistic E1 P&L of earlier joins of the same trade date (18:00 prior evening to 16:59 ET) whose exit bar index was strictly less than the entry bar index of the current trade (closed, realized fills only). Permutation placebos were stratified by `direction x session x era` per post-review corrections.

**Plain-English Verdict:**  
**FAIL.** The bad-day VWAP gate fails decisively across all seven pre-registered pass criteria:
- **Insufficient Sample Size:** Only **38** joins qualified as VWAP-aligned in BAD STATE ($\le -$400) across 31 distinct trade dates, failing Criterion 1 ($N \ge 60$ required).
- **Severe Negative Expectancy:** Rather than protecting capital, VWAP-aligned joins in bad state lost an average of **-$53.13** per trade, severely underperforming the bad-state universe mean of **-$17.16** (delta: **-$35.97**, 95% day-blocked CI: [-$76.07, +$7.61]).
- **Underperforms OPPOSED:** OPPOSED joins in bad state averaged **-$13.35**, beating ALIGNED by **+$39.78** (ALIGNED minus OPPOSED: -$39.78, 95% CI: [-$103.90, +$20.84]).
- **Permutation Test Rejection:** Stratified permutation test yielded **p = 0.9750** (1,950 / 2,000 permutations outperformed the observed delta).
- **Flipped Placebo Inversion:** Reversing trade direction on bad-state ALIGNED joins produces an average P&L of **+$32.33** vs actual **-$53.13** (placebo beats actual by +$85.46, consistently across PRE and POST eras).
- **Consistent Failure Across Sessions:** ALIGNED minus ALL is negative in both RTH (**-$34.85**) and GLOBEX (**-$38.93**).

Per pre-registered rules: **the VWAP gate does not help on losing days**. Stop; the daily-loss threshold and VWAP window are not to be tuned to rescue it.

---

## 2. Pre-Registered Definitions & Sample Accounting

- **Signal Detector:** `detectSignalEvents(65, 'standard', THETA, [{t: d, bars}], 'fixed')`, 2023-03-06 to 2026-10-16, NQ roll weeks excluded.
- **Session Anchor:** 18:00 ET prior evening to 16:59 ET trade date $d$. VWAP series computed with volume weighting on all bars.
- **Slope & Flat Cut:** $W = 60$ minutes. Trigger bar index $t = \text{entry\_idx} - 1$. Flat cut $c(d)$ derived from pooled $|slope|$ p33 of prior 20 qualifying RTH dates.
- **Running STATE:** For entry $j$, $\text{STATE}_j = \sum_{i < j, \text{date}_i = \text{date}_j, \text{exitGlobalIdx}_i < \text{entryGlobalIdx}_j} \text{PnL}_i$. Realized, closed trades only.
- **BAD STATE:** $\text{STATE} \le -$400.

### Sample Counts in BAD STATE ($\le -$400):
- Total joins entered while in Bad State: **201**
- Bad State joins with defined VWAP class: **201**
  - **ALIGNED:** **38** (18.9%) across 31 distinct trade dates
  - **OPPOSED:** **41** (20.4%)
  - **FLAT:** **122** (60.7%)

---

## 3. Primary Outcomes: BAD STATE E1 Performance

| Partition | Total N | Aligned N | Opposed N | Flat N | ALL Mean | ALIGNED Mean | OPPOSED Mean | ALIGNED - ALL | 95% Day-Blocked CI |
|---|---|---|---|---|---|---|---|---|---|
| **Overall Bad State** | 201 | 38 | 41 | 122 | -$17.16 | -$53.13 | -$13.35 | **-$35.97** | [-76.07, +7.61] |
| **PRE Era** | 77 | 18 | - | - | -$16.69 | -$46.11 | - | **-$29.42** | - |
| **POST Era** | 124 | 20 | - | - | -$17.45 | -$59.45 | - | **-$42.00** | - |
| **RTH** | 147 | 29 | - | - | -$18.48 | -$53.33 | - | **-$34.85** | - |
| **GLOBEX** | 54 | 9 | - | - | -$13.57 | -$52.50 | - | **-$38.93** | - |

### ALIGNED minus OPPOSED in Bad State:
- **ALIGNED minus OPPOSED:** **-$39.78**
- **95% Day-Blocked Bootstrap CI:** [-$103.90, +$20.84]

### Account-Style Total P&L in Bad State:
- **Total P&L of all Bad-State joins:** **-$3,449.00** ($N=201$)
- **Total P&L of ALIGNED-only Bad-State joins:** **-$2,019.00** ($N=38$)
  - Note: Taking only the 38 ALIGNED joins still lost -$2,019.00, representing 58.5% of the entire bad-state dollar loss despite comprising only 18.9% of trades!

---

## 4. Placebos and Rigor Checks

### Placebo 1: Direction-Flipped Re-simulation
| Partition | ALIGNED Actual Mean | Flipped Placebo Mean | Delta (Actual - Flipped) | Status |
|---|---|---|---|---|
| **Overall** | -$53.13 | +$32.33 | -$85.46 | **FAIL (Placebo beats actual)** |
| **PRE Era** | -$46.11 | +$25.11 | -$71.22 | **FAIL (Placebo beats actual)** |
| **POST Era** | -$59.45 | +$38.83 | -$98.28 | **FAIL (Placebo beats actual)** |

### Placebo 2: Stratified Permutation Test
Shuffling UP/DOWN/FLAT labels within `direction x session x era` blocks (2,000 permutations):
- **Observed ALIGNED minus ALL:** -$35.97
- **Permutations $\ge$ Observed:** 1,950 / 2,000
- **Permutation p-value:** **p = 0.9750** (Fails: must be $\le 0.05$)

### Tail Behavior:
- **$P(\text{PnL} \ge +100)$:**
  - ALIGNED: **10.53%** (4 / 38)
  - ALL Bad State: **13.43%** (27 / 201)
  - Status: **FAIL (Aligned < All)**
- **Top-5 Share of ALIGNED Total P&L:**
  - Total ALIGNED P&L: **-$2,019.00**
  - Top-5 Sum: $1,050.50
  - Status: **FAIL (Total P&L is negative)**

---

## 5. Pre-Registered Pass Criteria Evaluation

| # | Criterion | Required Threshold | Observed Value | Evaluation |
|---|---|---|---|---|
| **1** | Sample Size ($N$) | $N \ge 60$ aligned on $\ge 25$ distinct trade dates | $N = 38$ on 31 distinct dates | **FAIL** |
| **2** | ALIGNED minus ALL | $> 0$ with 95% CI excluding zero | -$35.97 (CI: [-$76.07, +$7.61]) | **FAIL** |
| **3** | ALIGNED minus OPPOSED | $> 0$ with 95% CI excluding zero | -$39.78 (CI: [-$103.90, +$20.84]) | **FAIL** |
| **4** | Permutation Test | $p \le 0.05$ (2000 perms within direction x session x era) | $p = 0.9750$ | **FAIL** |
| **5** | Flipped Direction Placebo | ALIGNED beats Placebo overall and in both PRE and POST eras | -$53.13 vs +$32.33; PRE: -$46.11 vs +$25.11; POST: -$59.45 vs +$38.83 | **FAIL** |
| **6** | Top-5 Event Share | Top-5 share $< 50\%$ of positive aligned total | Total P&L = -$2,019.00 (negative) | **FAIL** |
| **7** | Session Consistency | ALIGNED minus ALL $\ge 0$ in BOTH RTH and GLOBEX | RTH: -$34.85, GLOBEX: -$38.93 | **FAIL** |

**Final Score: 0 / 7 PASS.** Result: **TOTAL REJECTION.**

---

## 6. Sensitivity Analysis (Descriptive Only — Never for Selection)

- **State $\le -$300 Threshold:**
  - ALL: $N=322$, Mean = -$12.65$
  - ALIGNED: $N=56$, Mean = -$31.42$
  - OPPOSED: $N=73$, Mean = -$0.14$
  - ALIGNED minus ALL: **-$18.77$** | ALIGNED minus OPPOSED: **-$31.28$**
- **State $\le -$500 Threshold:**
  - ALL: $N=107$, Mean = -$13.38$
  - ALIGNED: $N=20$, Mean = -$67.58$
  - OPPOSED: $N=25$, Mean = -$19.08$
  - ALIGNED minus ALL: **-$54.19$** | ALIGNED minus OPPOSED: **-$48.50$**

---

## 7. Descriptive Hindsight Analysis (NOT Tradeable)

Examining trade dates whose FINAL cumulative day P&L ended at $\le -$400:
- Number of losing dates (final P&L $\le -$400): **78 dates**
- Total trades on those dates: **592 trades**, generating a net loss of **-$41,933.00** (mean: -$70.83).
- ALIGNED trades on those dates: **115 trades**, generating a net loss of **-$10,036.00** (mean: -$87.27).

Even in hindsight conditioning on day-end disaster days, VWAP-aligned joins performed worse (-$87.27/trade) than the average join on those days (-$70.83/trade).
