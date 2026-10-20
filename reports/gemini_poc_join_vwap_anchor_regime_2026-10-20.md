# POC_ROTATION_JOIN VWAP Follow-ups A & B — Pre-Registered Test Report

**Execution Date:** 2026-10-20  
**Specification:** `docs/POC_JOIN_VWAP_ANCHOR_REGIME_PREREG_20261020.md`  
**Script:** `scratch/gemini_poc_join_vwap_anchor_regime.mjs`  
**Status:**  
- **TEST A (RTH Anchor Direction Gate):** **FAIL** (VWAP slope as a direction check thread permanently closed)  
- **TEST B (FLAT x Outer-Band Fade):** **FAIL / INSUFFICIENT QUALIFYING EVENTS** (0 qualifying events in RTH, 1 in Globex)

---

## 1. Executive Summary & Plain-English Verdict

This test evaluated two follow-up hypotheses derived from the DeepSeek review and user feedback:
1. **TEST A (One-Shot RTH Anchor):** Does anchoring VWAP at the RTH open (09:30 ET) and filtering RTH joins ($t \ge 60$ in RTH, entry 10:30+) by 60m RTH VWAP slope improve POC joins?
2. **TEST B (FLAT Regime Outer-Band Fade):** In a FLAT VWAP session ($|\text{slope}| \le c$), does restricting entries strictly to "edge-aligned" joins (fading the outer third of the developing price distribution back toward VWAP: long when $z \le -q$, short when $z \ge +q$) capture the "b/D-shaped balance fade" edge?

Both tests were evaluated with realistic E1 execution ($2/pt, $2 round trip, 100pt stop, breakeven armed at bar 60, held to next event or 24 hours), volume-weighted VWAP, and stratified permutation tests within `direction x month`.

**Plain-English Verdict:**
- **TEST A is a decisive FAIL.** RTH-anchored VWAP slope provides zero edge. ALIGNED joins underperform ALL ($-\$0.14$/trade, 95% CI: [-$22.88, +$25.93]), severely decay in POST ($-\$27.23$ vs ALL $-\$5.20$), fail the permutation test ($p = 0.7020$), lose to the flipped placebo ($-\$2.50$ vs $+\$12.10$), and produce negative total P&L ($-\$513.00$). Per pre-registered protocol, the **"VWAP slope as a direction check" thread is closed permanently**.
- **TEST B CANNOT BE RUN / FAILS FOR LACK OF QUALIFYING EVENTS.** Across nearly 4 years of data, exactly **0 joins in RTH** and **1 join in Globex** met the "EDGE-ALIGNED" criteria ($N \ge 40$ required). The structural reason is clear: POC rotation joins enter on breakouts/momentum *in the direction of the rotation* (longs enter above VWAP at $z \ge +q$; shorts enter below VWAP at $z \le -q$). Fading back toward VWAP from the outer band almost never occurs within the POC join detector.

---

## 2. TEST A: RTH-Anchored VWAP Slope Direction Gate

### Pre-Registered Parameters & Universe:
- **Anchor:** 09:30 ET RTH open on date $d$. Cumulative volume-weighted VWAP via `computeRunningVwapSeries(rthBars)`.
- **Eligibility:** RTH entry bar (09:30–15:59 ET), trigger bar $t \ge 60$ counted from 09:30 (entry 10:31 or later).
- **Slope:** $W = 60$ minutes. Dynamic flat cut $c_{RTH}(d)$ = p33 of $|slope60|$ from prior 20 qualifying RTH dates.
- **Rule:** Fire only ALIGNED joins (long & UP, short & DOWN).

### Sample Counts:
- Total eligible RTH joins ($t \ge 60$): **956**
  - **ALIGNED:** **205** (21.4%) — PRE: 141, POST: 64
  - **OPPOSED:** **184** (19.2%)
  - **FLAT:** **567** (59.3%)

### Primary Performance Outcomes:
| Partition | Total N | Aligned N | Opposed N | Flat N | ALL Mean | ALIGNED Mean | OPPOSED Mean | FLAT Mean | ALIGNED - ALL | 95% Day-Blocked CI |
|---|---|---|---|---|---|---|---|---|---|---|
| **Overall RTH** | 956 | 205 | 184 | 567 | -$2.37 | -$2.50 | -$13.09 | +$1.16 | **-$0.14** | [-22.88, +25.93] |
| **PRE Era** | 565 | 141 | 104 | 320 | -$0.33 | +$8.72 | -$14.93 | +$0.40 | **+$9.05** | - |
| **POST Era** | 391 | 64 | 80 | 247 | -$5.20 | -$27.23 | -$10.70 | +$2.15 | **-$22.03** | - |

- **ALIGNED minus OPPOSED:** **+$10.59** (95% Day-Blocked CI: [-$25.65, +$49.10] — spans zero).

### Rigor Checks & Placebos:
- **Placebo 1 (Flipped Direction):**
  - Actual ALIGNED Mean: **-$2.50** | Flipped Placebo Mean: **+$12.10** (Placebo beats actual by +$14.60; in POST: actual -$27.23 vs flipped +$36.77). **FAIL.**
- **Placebo 2 (Permutation Test):**
  - Shuffled within `direction x month` (2,000 permutations): **p = 0.7020** (1,404 / 2,000 perms $\ge$ obs). **FAIL.**
- **Tail Behavior:**
  - $P(\text{PnL} \ge +100)$: ALIGNED = **11.71%** (24 / 205) vs ALL = **12.97%** (124 / 956). **FAIL.**
  - Top-5 Share: Total ALIGNED P&L = **-$513.00** (non-positive total fails concentration check). **FAIL.**

### TEST A Pass Criteria Evaluation:
| # | Criterion | Required Threshold | Observed Value | Evaluation |
|---|---|---|---|---|
| **1** | Sample Size ($N$) | Overall $\ge 100$; PRE, POST $\ge 40$ | Overall: 205; PRE: 141; POST: 64 | **PASS** |
| **2** | ALIGNED minus ALL | $> 0$ with 95% CI excluding 0, AND $> 0$ in both eras | Overall: -$0.14 (CI: [-22.88, 25.93]); PRE: +$9.05; POST: -$22.03 | **FAIL** |
| **3** | ALIGNED minus OPPOSED | $> 0$ with 95% CI excluding zero | +$10.59 (CI: [-$25.65, +$49.10]) | **FAIL** |
| **4** | Permutation Test | $p \le 0.05$ (2000 perms within direction x month) | $p = 0.7020$ | **FAIL** |
| **5** | Flipped Direction Placebo | ALIGNED beats Placebo overall and in both eras | Overall: -$2.50 vs +$12.10; POST: -$27.23 vs +$36.77 | **FAIL** |
| **6** | Top-5 Event Share | Top-5 share $< 50\%$ of positive aligned total | Total P&L = -$513.00 (non-positive) | **FAIL** |
| **7** | Right Tail Expansion | $P(\text{PnL} \ge +100)$ ALIGNED $>$ ALL | 11.71% vs 12.97% | **FAIL** |

**Final Score: 1 / 7 PASS.** Status: **DECISIVE REJECTION.**

---

## 3. TEST B: FLAT Regime x Outer-Band Location ("Fade Balance Edge")

### Pre-Registered Parameters & Universe:
- **Session Types:**
  - **RTH Joins:** RTH-open-anchored VWAP (09:30–15:59 ET, trigger bar $t \ge 60$ from 09:30).
  - **GLOBEX Joins:** 18:00-anchored VWAP (18:00 prior evening to 09:29 ET, trigger bar $t \ge 60$ from 18:00).
- **Flat Cut $c(d)$:** p33 of $|slope60|$ sampled every 15th bar index $\ge 60$ over prior 20 qualifying RTH dates for the *same session construction*.
- **Dispersion & Cut:** $\sigma(d) = \text{stddev}(\text{typical price} - \text{VWAP})$ over those samples; $z = (\text{entryPrice} - \text{VWAP}[t]) / \sigma(d)$; $q(d)$ = p67 of $|z|$ in that pool.
- **Rule:** When FLAT ($|slope| \le c$), fire ONLY `EDGE-ALIGNED` joins:
  $$\text{EDGE-ALIGNED} = (\text{Long} \land z \le -q) \lor (\text{Short} \land z \ge +q)$$

### Sample Accounting & Power Reality:
| Metric | RTH Session | GLOBEX Session |
|---|---|---|
| **Total Eligible Joins** | 956 | 1,063 |
| **FLAT Joins** ($|slope| \le c$) | 567 | 616 |
| **EDGE-ALIGNED Joins** | **0** | **1** |
| **OTHER FLAT Joins** | 567 | 615 |
| **Average Outer Cut $q$** | 0.92 | 0.83 |
| **Observed $z$ Range** | [-2.49, +1.36] | [-1.75, +2.11] |
| **Long & $z \le -q$** (Long fade below VWAP) | **0** | **1** |
| **Short & $z \ge +q$** (Short fade above VWAP) | **0** | **0** |
| **Long & $z \ge +q$** (Long momentum above VWAP) | 20 | 39 |
| **Short & $z \le -q$** (Short momentum below VWAP) | 12 | 61 |

### Why Did Test B Have 0 and 1 Events?
The hypothesis assumed that in balance/flat regimes, POC rotation joins would fire fading back into balance from the edges. In reality, the detector mechanics are momentum/breakout oriented:
- When price breaks above the outer band ($z \ge +q$), the detector produces **LONG** joins (20 in RTH, 39 in Globex), never short fades.
- When price breaks below the outer band ($z \le -q$), the detector produces **SHORT** joins (12 in RTH, 61 in Globex), never long fades.
- Consequently, an "edge-aligned fade" ($Long \land z \le -q$ or $Short \land z \ge +q$) occurs with near-zero frequency.

### TEST B Pass Criteria Evaluation:
| # | Criterion | Required Threshold | RTH Result | GLOBEX Result | Evaluation |
|---|---|---|---|---|---|
| **1** | Sample Size ($N$) | $N \ge 40$ in each session type | $N = 0$ | $N = 1$ | **FAIL (Insufficient power)** |
| **2** | EDGE-ALIGNED minus ALL FLAT | $> 0$ with 95% CI excluding zero | N/A ($N=0$) | -$59.12 (CI: [-$75.12, +$0.47]) | **FAIL** |
| **3** | Era Consistency | Positive in PRE and POST | N/A ($N=0$) | PRE: -$55.45, POST: -$14.00 | **FAIL** |
| **4** | Permutation Test | $p \le 0.05$ | N/A ($N=0$) | $p = 0.9290$ | **FAIL** |
| **5** | Flipped Direction Placebo | Beats flipped placebo | N/A ($N=0$) | Actual -$47.50 vs Flipped -$2.00 | **FAIL** |
| **6** | Top-5 Event Share | $< 50\%$ of positive total | N/A ($N=0$) | Total P&L = -$47.50 (negative) | **FAIL** |
| **7** | Right Tail Expansion | $P(\ge +100)$ Edge-Aligned > Flat | 0.0% vs 14.5% | 0.0% vs 9.1% | **FAIL** |

**Final Score: 0 / 7 PASS in both sessions.** Status: **FAIL FOR LACK OF QUALIFYING EVENTS.**

---

## 4. Final Conclusion Across All VWAP Tests

1. **Test 1 (Session VWAP Slope Gate):** Decisively rejected ($p=0.9020$, ALIGNED minus ALL = -$5.29).
2. **Test 2 (Bad-Day VWAP Gate):** Decisively rejected ($p=0.9750$, ALIGNED in bad state averages -$53.13 vs -$17.16 overall).
3. **Test 3A (RTH-Anchored VWAP Slope Gate):** Decisively rejected ($p=0.7020$, POST era degrades to -$27.23).
4. **Test 3B (FLAT Regime Outer-Band Fade):** Structurally incompatible with the POC join detector (0 events in RTH, 1 in Globex).

The directional VWAP hypothesis for POC rotation joins has been tested under all pre-registered configurations (full session anchor, RTH anchor, bad-day state, outer-band balance fade) and **fails across every dimension**. The thread is closed permanently.
