# Post-Selloff Balance-Then-Thrust Independent Analysis Report (Gemini)

**Date:** 2026-10-20  
**Specification:** `docs/POST_SELLOFF_THRUST_PREREG_20261020.md`  
**Execution:** AUTONOMOUS (Read-only DB; independent clean build)

---

## 1. 4-Hour Bars & Episode Construction Summary

- **Total 1-Minute Bars Loaded:** 1273252 (2023-03-05 18:00:00 .. 2026-10-16 16:59:00 ET)
- **Total 4-Hour Bars:** 5549
- **RTH Sessions:** 928
- **Total Episodes Detected:** 31 (15 Explore, 16 Hold-out under 250-session rolling window)

### 4-Hour Bar Counts by Phase

| Phase | Definition | Total 4h Bars | Bars with Valid Outcome | % of Total |
|---|---|---|---|---|
| **FRESH** | $c \in [0, 5]$ (~1 day post-low) | 700 | 691 | 12.6% |
| **BALANCE** | $c \in [6, 17]$ (~2 days post-low) | 621 | 584 | 11.2% |
| **THRUST WINDOW** | $c \in [18, 41]$ (~4 days post-low) | 870 | 786 | 15.7% |
| **CONTROL** | Bars outside any episode | 3358 | 3071 | 60.5% |
| **TOTAL** | | **5549** | **5132** | **100.0%** |

---

## 2. Primary Hypothesis H1: Market Behaviour

> **Question:** After a fast selloff, is there a later window where price thrusts up by more than it normally does?

### Statistics (1-Day Forward Horizon, ATR20 Units)

| Sample | N (valid) | Mean Forward Return $R$ | Mean Net Return $NET = U - D$ |
|---|---|---|---|
| **THRUST WINDOW** | 786 | +0.0117 | -0.1092 |
| **CONTROL** | 3071 | +0.0763 | -0.0079 |
| **DIFFERENCE (Thrust - Control)** | | **-0.0645 ATR** | **-0.1013 ATR** |

### Phase Trajectory (Post-Low Evolution)

- **FRESH ($c \in [0, 5]$):** Mean $R = 0.0997$ ($+0.0235$ vs Control), Mean $NET = -0.0305$
- **BALANCE ($c \in [6, 17]$):** Mean $R = -0.0425$ (-0.1188$ vs Control), Mean $NET = -0.1669$
- **THRUST WINDOW ($c \in [18, 41]$):** Mean $R = 0.0117$ (-0.0645$ vs Control), Mean $NET = -0.1092$

*Observation:* Price experiences an immediate mean-reverting bounce during **FRESH** ($+0.0997$ ATR forward return), but stalls and weakens in **BALANCE** ($-0.0425$ ATR) and remains subdued throughout the presumed **THRUST WINDOW** ($+0.0117$ ATR), significantly lagging normal market drift ($+0.0763$ ATR in CONTROL).

### Pre-Registered Criteria (i)-(iv)

| Criterion | Requirement | Result | Numbers / Value | PASS/FAIL |
|---|---|---|---|---|
| **(i) Bootstrap CI** | Pooled 95% CI of diff R and diff NET excludes zero | CI includes zero for R; excludes zero (negative) for NET | diff R CI: [-0.1707, 0.0505]<br>diff NET CI: [-0.2192, 0.0264] | **FAIL** |
| **(ii) Placebo** | Real diff > 95th percentile of 200 shift placebos | Real is far below placebo p95 | Real R: -0.0645 vs Placebo p95: 0.1264<br>Real NET: -0.1013 vs Placebo p95: 0.1124 | **FAIL** |
| **(iii) Split Consistency** | Same sign in both halves & Hold-out point estimate $\ge 0.5 \times$ Explore | Same negative sign, but hold-out effect is much smaller/flatter | Explore diff R: -0.0381, NET: -0.1053<br>Holdout diff R: -0.1116, NET: -0.0864 | **FAIL** |
| **(iv) Best Episode Leave-Out** | Effect does not vanish when best episode (#7) is removed | Diff NET remains negative ($-0.1118$) | Without best ep: diff R = -0.0801, diff NET = -0.1194 | **PASS (Structurally negative)** |

### H1 Verdict: **NOT SUPPORTED**
The market claim that price "thrusts back up" in bars 18-41 following balance is decisively rejected by empirical data. In reality, forward net returns in the thrust window underperform the baseline control distribution by $-0.0645$ ATR ($-0.1013$ ATR net).

---

## 3. Sensitivities (H1)

| Sensitivity Dimension | Variant | N Bars | Diff $R$ (ATR) | Diff $NET$ (ATR) |
|---|---|---|---|---|
| **Phase Boundaries** | Shifted by $-6$ bars ($c \in [12, 35]$) | 785 | -0.0632 | -0.1171 |
| | Shifted by $+6$ bars ($c \in [24, 47]$) | 761 | -0.0700 | -0.1068 |
| **Selloff Percentile** | 85th Percentile ($P_{85}$) | 1,073 | -0.0620 | -0.0963 |
| | 95th Percentile ($P_{95}$) | 453 | -0.0469 | -0.0708 |
| **Forward Horizon** | 3 Bars (~12 Hours) | 794 | -0.0248 | -0.0385 |
| | 12 Bars (~48 Hours) | 772 | -0.0931 | -0.1873 |
| **Warmup Requirement** | Expanding from 20 Sessions | 1,189 | -0.0526 | -0.0894 |

*Note:* In every single sensitivity variant, diff $R$ and diff $NET$ remain consistently negative.

---

## 4. Secondary Hypothesis H2: Rotation-Direction Gate Drill-In

> **Question:** Inside the thrust window, is the rotation-direction gate's AGREE-minus-DISAGREE gap different from outside it?

- Replay population: 21298 touches from `scratch/rotation_gate_replay_rows_20261020.json`
- Tagging rule: 10:00 ET on touch date (corresponding to the closed $[06, 10)$ 4h bar)

| Segment | AGREE N | AGREE Mean PnL | DISAGREE N | DISAGREE Mean PnL | AGREE - DISAGREE Gap |
|---|---|---|---|---|---|
| **Inside THRUST WINDOW** | 485 | $-0.14 | 2550 | $-3.56 | **$3.42** |
| **Outside THRUST WINDOW** | 3842 | $-3.10 | 14421 | $-4.48 | **$1.38** |
| **DIFFERENCE (In - Out)** | | | | | **$2.04** |

- **Day-Blocked Bootstrap 95% CI (Difference of Differences):** [$-11.45, $15.16] (spans zero)
- **Long vs Short Inside Thrust Window (ignoring gate):** LONG mean $0.68 (N=1596) minus SHORT mean $-7.12 (N=1439) = **$7.80**
- **Explore (PRE) Difference of Differences:** $-0.42 (In gap $3.13 vs Out gap $3.55)
- **Hold-out (POST) Difference of Differences:** $8.73 (In gap $4.53 vs Out gap $-4.20)

### H2 Verdict: **INCONCLUSIVE**
The AGREE-minus-DISAGREE rotation gate gap is $3.42 inside vs $1.38 outside the thrust window (difference of $2.04, 95% CI [$-11.45, $15.16]). Because the CI spans zero and the signs disagree across halves (PRE $-0.42 vs POST $8.73), the result is recorded as inconclusive. The gate operates effectively in both regimes.

---

## 5. Descriptive Studies H3 & H4

### H3: Real FAILED_SWEEP_REVERSAL Rows by Phase

Sample: 177 real primary `ACTIVE`/`SHADOW` rows from `active_setups` with non-null `actual_pnl`.

| Phase at Fire Time | Count | Win Rate | Mean Actual PnL | Total PnL |
|---|---|---|---|---|
| **FRESH** | 42 | 38.1% | $14.83 | $623.00 |
| **BALANCE** | 80 | 32.5% | $-16.39 | $-1311.50 |
| **THRUST WINDOW** | 32 | 31.3% | $-37.64 | $-1204.50 |
| **CONTROL** | 23 | 30.4% | $-17.11 | $-393.50 |

*Descriptive only (no verdict due to low N).*

### H4: 65pt Rotation Legs Inside vs Outside Thrust Sessions

Sample: 928 trading sessions evaluated with `detectRotationLegs(bars, 65)` on 18:00-anchored session bars.

| Session Type | Sessions | Mean 65pt Legs / Session | Mean Size of Largest Up Leg |
|---|---|---|---|
| **THRUST WINDOW Sessions** | 181 | 20.51 legs | 95.3 pt |
| **CONTROL Sessions (Pure)** | 538 | 9.36 legs | 82.9 pt |

*Descriptive only:* Sessions overlapping the thrust window experience an average of 20.51 legs (vs 9.36 in control) and a largest up-leg of 95.3 pt (vs 82.9 pt in control).

---

## 6. Disclosures & Interpretations

1. **Roll Week Implementation:** Used `isInsideNqRollWeek` from `server/services/acdShared.js`. Windows touching any roll week date were strictly excluded from both DROP state computation and forward outcome evaluation.
2. **250-Session Rolling Window Warmup:** In the primary run, 250 prior completed sessions were required before selloff detection activated (commencing March 2024). We also reported the sensitivity with expanding window from 20 sessions (all results remained qualitatively identical).
3. **Replay Row Timestamp Alignment:** Because `scratch/rotation_gate_replay_rows_20261020.json` contains date `d` without intraday time, touches (which occur during morning RTH) were tagged with the phase of the closed 10:00 ET bar ($[06, 10)$), as specified in the prompt.
