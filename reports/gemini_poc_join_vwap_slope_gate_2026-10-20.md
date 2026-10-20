# POC_ROTATION_JOIN VWAP-Slope Direction Gate — Pre-Registered Test Report

**Execution Date:** 2026-10-20  
**Specification:** `docs/POC_JOIN_VWAP_SLOPE_GATE_PREREG_20261020.md`  
**Script:** `scratch/gemini_poc_join_vwap_slope_gate.mjs`  
**Status:** **FAIL** (a VWAP-slope direction gate does NOT improve POC joins)

---

## 1. Executive Summary & Plain-English Verdict

This test evaluated whether filtering POC Rotation Joins by session VWAP slope (anchored at 18:00 ET session open, 60-minute lookback, dynamic rolling flat cut from the prior 20 RTH days) improves realistic live performance under E1 execution ($2/pt, $2 round trip, 100pt stop, breakeven armed at bar 60, held to next event or 24 hours).

**Plain-English Verdict:**
**FAIL.** The VWAP-slope direction gate fails the pre-registered rigor criteria:
- Overall ALIGNED minus ALL is **+$0.56** (95% day-blocked CI: [-$6.31, +$7.56]), failing Criterion 2 because the CI spans zero and the difference is negative in PRE (-$0.03) and GLOBEX (-$2.72).
- ALIGNED minus OPPOSED is **-$2.44** (95% CI: [-$16.94, +$10.95]), failing Criterion 3 because ALIGNED actually underperforms OPPOSED.
- The permutation test p-value is **p = 0.6427**, failing Criterion 4 (requires $p \le 0.05$).
- While ALIGNED passes sample size ($N=1186$), flipped placebo ($+$7.64 vs -$5.74), top-5 share (45.7%), and tail expansion (14.2% vs 12.9%), the core edge is statistically non-existent and economically negligible ($+$0.56/trade).
- Therefore, per pre-registered instructions: **a VWAP-slope direction gate does not improve POC joins**. Stop; do not tune slope windows or cuts to rescue it.

---

## 2. Pre-Registered Definitions & Sample Accounting

- **Signal Detector:** `detectSignalEvents(65, 'standard', THETA, [{t: d, bars}], 'fixed')`, 2023-03-06 to 2026-10-16, NQ roll weeks excluded.
- **Session Anchor:** 18:00 ET prior evening to 16:59 ET trade date $d$. Cumulative typical-price VWAP via `computeRunningVwapSeries(bars)`.
- **Lookback:** $W = 60$ minutes. Trigger bar index $t = \text{entry\_idx} - 1$.
- **Flat Cut $c(d)$:** 33.3rd percentile of $|\text{slope}|$ sampled every 15th bar index $\ge 60$ across the 20 qualifying RTH sessions ($\ge 300$ bars) immediately prior to $d$.
- **Eras:** PRE ($d < 2025-06-01$) vs POST ($d \ge 2025-06-01$).
- **Sessions:** RTH (09:30–15:59 ET entry time) vs GLOBEX (all other hours).

### Sample Counts:
- Total raw events detected: **3974**
- Skipped (<2 forward bars): **2**
- Valid evaluated trades: **3972**
- Joins with $t < 60$ or no prior 20 RTH days (UNDEFINED): **353**
- **ALL (Defined Class Universe):** **3619**
  - **ALIGNED:** **1186** (32.8%)
  - **OPPOSED:** **1231** (34.0%)
  - **FLAT:** **1202** (33.2%)

---

## 3. Primary Outcomes: Realistic E1 Performance

| Partition | Total N | Aligned N | Opposed N | Flat N | ALL Mean P&L | ALIGNED Mean | OPPOSED Mean | FLAT Mean | ALIGNED - ALL | 95% Day-Blocked CI |
|---|---|---|---|---|---|---|---|---|---|---|
| **Overall** | 3619 | 1186 | 1231 | 1202 | $7.08 | $7.64 | $10.08 | $3.45 | **$0.56** | [-6.31, 7.56] |
| **PRE Era** | 1982 | 690 | 624 | 668 | $1.12 | $1.09 | $8.83 | $-6.04 | **$-0.03** | [-7.73, 7.42] |
| **POST Era** | 1637 | 496 | 607 | 534 | $14.29 | $16.75 | $11.37 | $15.31 | **$2.47** | [-10.35, 16.21] |
| **RTH** | 1584 | 445 | 655 | 484 | $8.46 | $14.90 | $7.43 | $3.93 | **$6.44** | [-6.63, 18.93] |
| **GLOBEX** | 2035 | 741 | 576 | 718 | $6.00 | $3.28 | $13.10 | $3.12 | **$-2.72** | [-11.62, 5.33] |

### ALIGNED minus OPPOSED
- **ALIGNED minus OPPOSED (Overall):** **$-2.44**
- **95% Day-Blocked Bootstrap CI:** [-16.94, 10.95]

---

## 4. Placebos and Rigor Checks

### Placebo 1: Direction-Flipped Re-simulation
The ALIGNED joins re-simulated under the opposite trade direction with full realistic E1 execution:
| Partition | ALIGNED Actual Mean | Flipped Placebo Mean | Delta (Actual - Flipped) | Status |
|---|---|---|---|---|
| **Overall** | $7.64 | $-5.74 | +$13.38 | **PASS (Actual beats placebo)** |
| **PRE Era** | $1.09 | $0.98 | +$0.11 | **PASS (Actual beats placebo)** |
| **POST Era** | $16.75 | $-15.08 | +$31.83 | **PASS (Actual beats placebo)** |

### Placebo 2: Stratified Permutation Test
Shuffling UP/DOWN/FLAT labels among joins within each `month x session` block (2,000 permutations):
- **Observed ALIGNED minus ALL:** $0.56
- **Permutations $\ge$ Observed:** 1285 / 2000
- **Permutation p-value:** **p = 0.6427** (Fails: must be $\le 0.05$)

### Tail Behavior:
- **$P(\text{PnL} \ge +100)$:**
  - ALIGNED: **14.25%** (169 / 1186)
  - ALL: **12.90%** (467 / 3619)
  - Status: **PASS (Aligned > All)**
- **Top-5 Share of ALIGNED Total P&L:**
  - Top-5 Sum: $4138.00
  - Total ALIGNED P&L: $9062.00
  - Top-5 Share: **45.7%**
  - Status: **PASS (< 50%)**

---

## 5. Pre-Registered Pass Criteria Evaluation

| # | Criterion | Required Threshold | Observed Value | Evaluation |
|---|---|---|---|---|
| **1** | Sample Size ($N$) | Overall $\ge 150$; RTH, GLOBEX, PRE, POST $\ge 50$ | Overall: 1186, RTH: 445, GLOBEX: 741, PRE: 690, POST: 496 | **PASS** |
| **2** | ALIGNED minus ALL | $> 0$ with 95% CI excluding zero, AND $> 0$ in PRE, POST, RTH, GLOBEX | Overall: $0.56 (CI: [-6.31, 7.56]), PRE: $-0.03, POST: $2.47, RTH: $6.44, GLOBEX: $-2.72 | **FAIL** |
| **3** | ALIGNED minus OPPOSED | $> 0$ with 95% CI excluding zero | $-2.44 (CI: [-16.94, 10.95]) | **FAIL** |
| **4** | Permutation Test | $p \le 0.05$ (2000 permutations) | $p = 0.6427$ | **FAIL** |
| **5** | Flipped Direction Placebo | ALIGNED beats Placebo overall and in both PRE and POST eras | Overall: $7.64 vs $-5.74; PRE: $1.09 vs $0.98; POST: $16.75 vs $-15.08 | **PASS** |
| **6** | Top-5 Event Share | Top-5 share $< 50\%$ of aligned total | Top-5 share = 45.7% (Total P&L: $9062.00) | **PASS** |
| **7** | Right Tail Expansion | $P(\text{PnL} \ge +100)$ ALIGNED $>$ ALL | 14.25\%$ vs 12.90\%$ | **PASS** |

**Final Rule Verdict:** **FAIL (7 of 7 criteria must pass; only 4 passed).**

---

## 6. Sensitivity Analysis (Descriptive Only)

| Window ($W$) | N Defined | N Aligned | N Opposed | N Flat | ALL Mean | ALIGNED Mean | Delta (Aligned - All) | PRE Delta | POST Delta | RTH Delta | GLOBEX Delta |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **30 Minutes** | 3715 | 1426 | 1189 | 1100 | $6.22 | $3.69 | $-2.53 | $-2.14 | $-2.16 | $4.43 | $-5.59 |
| **60 Minutes (Primary)** | 3619 | 1186 | 1231 | 1202 | $7.08 | $7.64 | $0.56 | $-0.03 | $2.47 | $6.44 | $-2.72 |
| **120 Minutes** | 3444 | 952 | 1209 | 1283 | $6.74 | $6.28 | $-0.46 | $0.20 | $-0.20 | $5.65 | $-4.84 |

*Note: Across all three lookbacks (30m, 60m, 120m), ALIGNED joins do not reliably outperform ALL. In 30m and 120m windows, the overall delta is negative (-$2.53 and -$0.46).*

---

## 7. Secondary / Exploratory Findings

### A. FLAT-VWAP Joins
- **N Flat:** 1202 trades (33.2% of defined)
- **Mean P&L:** **+$3.45** (vs ALL $7.08 and ALIGNED $7.64)
- **$P(\text{PnL} \ge +100)$:** 11.98%
- **By Partition:**
  - PRE Era: $-6.04 (N=668)
  - POST Era: $15.31 (N=534)
  - RTH: $3.93 (N=484)
  - GLOBEX: $3.12 (N=718)

### B. Price-Side Check (Descriptive)
Evaluating entries relative to current session VWAP (Long above VWAP / Short below VWAP = ALIGNED_PX):
- **ALIGNED_PX Mean:** $3.43 (N=2457)
- **OPPOSED_PX Mean:** $14.79 (N=1162)
- **Delta (ALIGNED_PX - OPPOSED_PX):** **-$11.36**
- *Interpretation:* Entering in the direction of the VWAP side (long above VWAP, short below) also produces a negative drag relative to fading the VWAP side.

---

## 8. Ambiguities Resolved

1. **Qualifying RTH Sessions for Dynamic Flat Cut:** A qualifying RTH session is defined as any date with $\ge 300$ bars in the RTH window (09:30–15:59 ET). The 20 qualifying RTH dates immediately prior to trade date $d$ were pooled. In the first 21 trade dates of the study (March–April 2023), 20 prior dates were not yet available in the database; these trades were strictly treated as `UNDEFINED` and excluded from the defined universe.
2. **Sampling Bar Index:** Sampling of $|\text{slope}|$ was conducted starting at bar index $k = 60$ (the 60th bar after 18:00 ET) and stepping by 15 bars ($k = 60, 75, 90, \dots$) through the end of the session.
3. **Session Timing for RTH/GLOBEX:** RTH is classified based on the ET timestamp of the entry bar ($09:30 \le t \le 15:59$ ET), with all other hours classified as GLOBEX.
4. **Trigger Bar vs Entry Bar for Slope:** Per clarification (b), $t = \text{entry\_idx} - 1$ within the detector session. Joins where $t < 60$ have undefined slope and are classified as `UNDEFINED`.
