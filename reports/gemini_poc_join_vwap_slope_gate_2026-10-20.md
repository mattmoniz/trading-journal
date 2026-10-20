# POC_ROTATION_JOIN VWAP-Slope Direction Gate — Pre-Registered Test Report (Corrected Rerun)

**Execution Date:** 2026-10-20  
**Specification:** `docs/POC_JOIN_VWAP_SLOPE_GATE_PREREG_20261020.md`  
**Script:** `scratch/gemini_poc_join_vwap_slope_gate.mjs`  
**Status:** **FAIL** (a VWAP-slope direction gate does NOT improve POC joins)

---

## 1. Executive Summary & Plain-English Verdict

This test evaluated whether filtering POC Rotation Joins by session VWAP slope (anchored at 18:00 ET session open, 60-minute lookback, volume-weighted via `volume::float`, dynamic rolling flat cut from the prior 20 qualifying RTH days) improves realistic live performance under E1 execution ($2/pt, $2 round trip, 100pt stop, breakeven armed at bar 60, held to next event or 24 hours).

In this corrected rerun, `volume::float` was explicitly loaded for every bar (asserting non-zero volume on 99.9958% of bars), ensuring true volume-weighted VWAP rather than equal-weighted typical price. Permutation testing was conducted within `direction x month x session` blocks per post-review corrections.

**Plain-English Verdict:**  
**FAIL.** The VWAP-slope direction gate fails decisively across nearly all pre-registered rigor criteria:
- **ALIGNED underperforms ALL:** Overall ALIGNED mean P&L is **-$4.89** vs ALL mean of **+$0.40** (delta: **-$5.29**, 95% day-blocked CI: [-$13.70, +$3.55]). It is negative overall, negative in PRE (-$11.62), and negative in GLOBEX (-$9.46).
- **ALIGNED underperforms OPPOSED:** Overall OPPOSED mean P&L is **+$4.13**, so ALIGNED minus OPPOSED is **-$9.03** (95% CI: [-$31.01, +$11.23]).
- **Permutation Test Fails:** Shuffling class labels within direction x month x session yields **p = 0.9020** (1,804 / 2,000 permutations beat the observed delta).
- **Flipped Placebo Beats Actual:** Re-simulating ALIGNED entries with flipped direction yields **+$3.38** vs actual **-$4.89** (placebo beats actual by +$8.27).
- **Negative Total P&L & Tail Degradation:** Total ALIGNED P&L is **-$5,064.00** (failing the positive total P&L requirement), and right-tail frequency $P(\text{PnL} \ge +100)$ drops to **9.66%** vs **11.00%** for ALL.

Per pre-registered protocol: **a VWAP-slope direction gate does not improve POC joins**. Stop; do not tune slope windows or cuts to rescue it.

---

## 2. Pre-Registered Definitions & Sample Accounting

- **Signal Detector:** `detectSignalEvents(65, 'standard', THETA, [{t: d, bars}], 'fixed')`, 2023-03-06 to 2026-10-16, NQ roll weeks excluded.
- **Session Anchor:** 18:00 ET prior evening to 16:59 ET trade date $d$. Cumulative typical-price volume-weighted VWAP via `computeRunningVwapSeries(bars)` with explicit `volume::float` on all bars (>99% non-zero volume verified).
- **Lookback:** $W = 60$ minutes. Trigger bar index $t = \text{entry\_idx} - 1$ (counted from 18:00). Events with $t < 60$ are UNDEFINED.
- **Flat Cut $c(d)$:** 33.3rd percentile (`floor((n-1)/3)`) of $|\text{slope}|$ sampled every 15th bar index $\ge 60$ across the 20 qualifying RTH sessions ($\ge 300$ bars) immediately prior to $d$.
- **Eras:** PRE ($d < 2025-06-01$) vs POST ($d \ge 2025-06-01$).
- **Sessions:** RTH (09:30–15:59 ET entry time) vs GLOBEX (all other hours).

### Sample Counts:
- Total raw events detected: **3,694**
- Skipped (<2 forward bars): **2**
- Valid evaluated trades: **3,692**
- Joins with $t < 60$ or missing prior 20 RTH days (UNDEFINED): **365**
- **ALL (Defined Class Universe):** **3,327**
  - **ALIGNED:** **1,035** (31.1%)
  - **OPPOSED:** **728** (21.9%)
  - **FLAT:** **1,564** (47.0%)

### Descriptive Direction & Slope Breakdown:
| Direction | Slope Class | Join Classification | Event Count |
|---|---|---|---|
| Long | UP | ALIGNED | **550** |
| Short | UP | OPPOSED | **367** |
| Long | DOWN | OPPOSED | **361** |
| Short | DOWN | ALIGNED | **485** |
| Long | FLAT | FLAT | **793** |
| Short | FLAT | FLAT | **771** |
| **Total UP** | | | **917** |
| **Total DOWN** | | | **846** |
| **Total FLAT** | | | **1,564** |

---

## 3. Primary Outcomes: Realistic E1 Performance

| Partition | Total N | Aligned N | Opposed N | Flat N | ALL Mean P&L | ALIGNED Mean | OPPOSED Mean | FLAT Mean | ALIGNED - ALL | 95% Day-Blocked CI |
|---|---|---|---|---|---|---|---|---|---|---|
| **Overall** | 3327 | 1035 | 728 | 1564 | $0.40 | $-4.89 | $4.13 | $2.16 | **-$5.29** | [-13.70, +3.55] |
| **PRE Era** | 1745 | 697 | 364 | 684 | $1.69 | $-9.92 | $14.47 | $6.73 | **-$11.62** | [-21.38, -2.72] |
| **POST Era** | 1582 | 338 | 364 | 880 | $-1.03 | $5.48 | $-6.20 | $-1.39 | **+$6.51** | [-11.10, +24.65] |
| **RTH** | 1502 | 428 | 500 | 574 | $-1.68 | $-1.41 | $-2.20 | $-1.43 | **+$0.27** | [-13.43, +15.26] |
| **GLOBEX** | 1825 | 607 | 228 | 990 | $2.11 | $-7.35 | $18.02 | $4.24 | **-$9.46** | [-20.91, +0.85] |

### ALIGNED minus OPPOSED:
- **ALIGNED minus OPPOSED (Overall):** **-$9.03**
- **95% Day-Blocked Bootstrap CI:** [-$31.01, +$11.23]

---

## 4. Placebos and Rigor Checks

### Placebo 1: Direction-Flipped Re-simulation
The ALIGNED joins re-simulated under the opposite trade direction with full realistic E1 execution:
| Partition | ALIGNED Actual Mean | Flipped Placebo Mean | Delta (Actual - Flipped) | Status |
|---|---|---|---|---|
| **Overall** | -$4.89 | +$3.38 | -$8.27 | **FAIL (Placebo beats actual)** |
| **PRE Era** | -$9.92 | +$7.70 | -$17.62 | **FAIL (Placebo beats actual)** |
| **POST Era** | +$5.48 | -$5.54 | +$11.02 | **PASS (Actual beats placebo)** |

### Placebo 2: Stratified Permutation Test
Shuffling UP/DOWN/FLAT labels within `direction x month x session` blocks (2,000 permutations):
- **Observed ALIGNED minus ALL:** -$5.29
- **Permutations $\ge$ Observed:** 1,804 / 2,000
- **Permutation p-value:** **p = 0.9020** (Fails: must be $\le 0.05$)

### Tail Behavior:
- **$P(\text{PnL} \ge +100)$:**
  - ALIGNED: **9.66%** (100 / 1,035)
  - ALL: **11.00%** (366 / 3,327)
  - Status: **FAIL (Aligned < All)**
- **Top-5 Share of ALIGNED Total P&L:**
  - Total ALIGNED P&L: **-$5,064.00**
  - Top-5 Sum: $5,461.00
  - Status: **FAIL (Total P&L is non-positive; cannot pass)**

---

## 5. Pre-Registered Pass Criteria Evaluation

| # | Criterion | Required Threshold | Observed Value | Evaluation |
|---|---|---|---|---|
| **1** | Sample Size ($N$) | Overall $\ge 150$; RTH, GLOBEX, PRE, POST $\ge 50$ | Overall: 1,035; RTH: 428; GLOBEX: 607; PRE: 697; POST: 338 | **PASS** |
| **2** | ALIGNED minus ALL | $> 0$ with 95% CI excluding zero, AND $> 0$ in PRE, POST, RTH, GLOBEX | Overall: -$5.29 (CI: [-13.70, +3.55]); PRE: -$11.62; POST: +$6.51; RTH: +$0.27; GLOBEX: -$9.46 | **FAIL** |
| **3** | ALIGNED minus OPPOSED | $> 0$ with 95% CI excluding zero | -$9.03 (CI: [-$31.01, +$11.23]) | **FAIL** |
| **4** | Permutation Test | $p \le 0.05$ (2000 perms within direction x month x session) | $p = 0.9020$ | **FAIL** |
| **5** | Flipped Direction Placebo | ALIGNED beats Placebo overall and in both PRE and POST eras | Overall: -$4.89 vs +$3.38 (FAIL); PRE: -$9.92 vs +$7.70 (FAIL); POST: +$5.48 vs -$5.54 (PASS) | **FAIL** |
| **6** | Top-5 Event Share | Top-5 share $< 50\%$ of positive aligned total | Total P&L = -$5,064.00 (non-positive) | **FAIL** |
| **7** | Right Tail Expansion | $P(\text{PnL} \ge +100)$ ALIGNED $>$ ALL | 9.66% vs 11.00% | **FAIL** |

**Final Score: 1 / 7 PASS.** Result: **DECISIVE REJECTION.**

---

## 6. Sensitivity Analysis (Descriptive Only — Never for Selection)

- **30-minute Slope Window:**
  - ALL: $N=3,427$, Mean = +$0.24$
  - ALIGNED: $N=1,372$, Mean = -$1.98$
  - OPPOSED: $N=558$, Mean = +$1.30$
  - FLAT: $N=1,497$, Mean = +$1.88$
  - ALIGNED minus ALL: **-$2.22$** | ALIGNED minus OPPOSED: **-$3.28$**
- **120-minute Slope Window:**
  - ALL: $N=3,147$, Mean = +$0.76$
  - ALIGNED: $N=825$, Mean = -$6.96$
  - OPPOSED: $N=820$, Mean = +$6.02$
  - FLAT: $N=1,502$, Mean = +$2.13$
  - ALIGNED minus ALL: **-$7.72$** | ALIGNED minus OPPOSED: **-$12.98$**

---

## 7. Secondary Descriptive Analysis: FLAT Joins & Price-Side

### FLAT-VWAP Joins:
- Overall: $N=1,564$, Mean = **+$2.16$**, $P(\ge +100) = 10.93\%$
- PRE Era: $N=684$, Mean = +$6.73$
- POST Era: $N=880$, Mean = -$1.39$
- RTH: $N=574$, Mean = -$1.43$
- GLOBEX: $N=990$, Mean = **+$4.24$**

### Price-Side Check:
- **ALIGNED_PX** (Long entry > VWAP / Short entry < VWAP): $N=3,045$, Mean = **-$0.50$**
- **OPPOSED_PX** (Long entry < VWAP / Short entry > VWAP): $N=282$, Mean = **+$10.06$**

As previously observed in research claims, price-side alignment is detrimental to mean expectancy on POC rotation joins; entering against the session VWAP (fading back toward value) carries positive EV (+10.06 vs -0.50).
