# Pre-Registered Analysis Report: 65pt Rotation-Direction Gate Roster Replay (2023-03-06 to 2026-10-16)

**Date of Report:** 2026-10-20  
**Pre-Registration Specification:** `docs/ROTATION_GATE_ROSTER_REPLAY_PREREG_20261020.md`  
**Execution Script:** `scratch/gemini_rotation_gate_roster_replay.mjs`  
**Data Scope:** 3.5 years of NQ 1-minute price bars (2023-03-06 through 2026-10-16), 854 valid RTH trading days (39 roll days skipped via `|PD_CLOSE - prevRthClose| > 0.1 * ATR20`).  
**Fill Engine:** Realistic fill model (Stop beyond market fills at bar open: Long `min(stop, open)`, Short `max(stop, open)`; Target fills at bar open when gapping through: Long `max(target, open)`, Short `min(target, open)`; Stop checked before target intrabar; unresolved positions marked to market at 15:59; $2/pt, $2 round trip).  
**Execution Mode:** Pure data analysis — read-only DB.

---

## 1. Pre-Run Equivalence Verification

As mandated by Requirement 1 of the pre-registration specification, the rotation direction derived from `detectRotationLegs` (`server/services/rotationDetector.js`, R=65) on the 18:00 previous-evening anchored session through the touch bar was verified against `detectSignalEvents(65, 'standard', 6.75, [{ t: d, bars }], 'fixed').all_leg_records.at(-1).direction` (`server/services/pocRotationService.js`) on 250 random `(date, touch bar)` samples.

- **Samples Tested:** 250 random touches
- **Matches:** 250
- **Mismatches:** 0 (100.0% agreement)
- **Status:** **PASSED** (zero mismatches observed; test proceeded to completion).

---

## 2. Replay Counts and Partitioning

Touches were recorded on all valid days for levels in `level_prices` possessing a live `OPTIMAL_STOP` calibration (first touch per level per day within 15 points, formation gates applied, entry between 09:35 and 15:59).

### 2.1 Replayed Touches & Tagging Rates
| Category | Count | Percentage |
|---|---|---|
| **Total Replayed Touches** | 22,408 | 100.0% |
| **Tagged Touches** (confirmed leg exists) | 22,203 | 99.08% |
| **Untagged Touches** (no confirmed leg yet) | 205 | 0.92% |
| **AGREE Trades** (`(leg UP == trade LONG)`) | 4,544 | 20.47% of tagged |
| **DISAGREE Trades** (`(leg UP != trade LONG)`) | 17,659 | 79.53% of tagged |

*Note on asymmetry:* Because level fades enter against the prevailing price move into the level, touches during an active 65pt swing naturally fade into that swing (e.g. rising into resistance triggers SHORT fade while the rotation leg is UP), creating a ~4:1 structural tilt toward DISAGREE.

### 2.2 Sample Counts by Era and Calendar Year
| Period | Date Range | Total Tagged (N) | AGREE (N) | DISAGREE (N) | % AGREE |
|---|---|---|---|---|---|
| **PRE Era** | 2023-03-06 to 2025-05-30 | 14,648 | 3,328 | 11,320 | 22.72% |
| **POST Era** | 2025-06-01 to 2026-10-16 | 7,555 | 1,216 | 6,339 | 16.10% |
| **2023** | 2023-03-06 to 2023-12-29 | 5,572 | 1,469 | 4,103 | 26.36% |
| **2024** | 2024-01-02 to 2024-12-31 | 6,411 | 1,461 | 4,950 | 22.79% |
| **2025** | 2025-01-02 to 2025-12-31 | 5,986 | 1,059 | 4,927 | 17.69% |
| **2026** | 2026-01-02 to 2026-10-16 | 4,234 | 555 | 3,679 | 13.11% |

---

## 3. Core Comparisons & Day-Blocked Bootstrap CIs (2,000 Resamples)

All confidence intervals are generated using a 2,000-resample day-blocked bootstrap preserving cross-trade daily correlations.

### 3.1 AGREE vs DISAGREE Performance ($/trade)
| Period | AGREE Mean ($) | AGREE 95% CI | DISAGREE Mean ($) | DISAGREE 95% CI | AGREE - DISAGREE ($) | Diff 95% CI |
|---|---|---|---|---|---|---|
| **OVERALL** | -$3.28 | [-$7.07, +$0.84] | -$4.28 | [-$6.19, -$2.35] | **+$1.00** | [-$3.48, +$5.64] |
| **PRE Era** | -$2.04 | [-$6.99, +$3.07] | -$5.64 | [-$8.14, -$3.17] | **+$3.60** | [-$2.17, +$9.48] |
| **POST Era** | -$6.68 | [-$13.32, -$0.12] | -$1.85 | [-$4.57, +$0.79] | **-$4.82** | [-$11.86, +$2.40] |
| **2023** | -$2.13 | [-$10.08, +$5.82] | -$5.41 | [-$9.97, -$0.68] | **+$3.28** | [-$6.62, +$13.54] |
| **2024** | -$3.25 | [-$10.01, +$3.67] | -$5.56 | [-$8.96, -$1.93] | **+$2.31** | [-$6.11, +$11.09] |
| **2025** | -$1.35 | [-$8.46, +$6.44] | -$4.14 | [-$7.63, -$0.74] | **+$2.80** | [-$5.30, +$11.44] |
| **2026** | -$10.09 | [-$18.05, -$1.42] | -$1.49 | [-$4.94, +$1.92] | **-$8.60** | [-$17.64, +$1.29] |

### 3.2 Does Gating Turn the Roster Positive? (AGREE vs Zero & ALL Tagged)
| Cohort | N | Total P&L ($) | Mean $/trade ($) | 95% Bootstrap CI ($) | Positive? |
|---|---|---|---|---|---|
| **ALL Tagged** | 22,203 | -$90,479.50 | -$4.08 | [-$5.66, -$2.43] | No (95% CI strictly < 0) |
| **AGREE Only** | 4,544 | -$14,892.50 | -$3.28 | [-$7.07, +$0.84] | No (Mean is negative; CI crosses zero) |
| **DISAGREE Only**| 17,659 | -$75,587.00 | -$4.28 | [-$6.19, -$2.35] | No (95% CI strictly < 0) |

*Finding:* Filtering to AGREE does **not** turn the level-fade roster positive. The AGREE cohort remains net negative (-$3.28/trade, total loss -$14,892.50), and its advantage over DISAGREE is negligible (+$1.00/trade overall) and completely reverses in the POST era (-$4.82/trade disadvantage in POST, -$8.60/trade in 2026).

---

## 4. Placebo Tests

### 4.1 Placebo 1: Flipped-Direction Placebo on AGREE Cohort
Re-simulates each AGREE trade in the exact opposite direction with identical stop/target distances from the same bar close.

| Cohort | AGREE Mean ($) | Flipped AGREE Mean ($) | Real Edge (AGREE - Flipped) ($) | 95% Bootstrap CI ($) |
|---|---|---|---|---|
| **OVERALL** | -$3.28 | **-$0.96** | **-$2.32** | [-$9.91, +$5.83] |
| **PRE Era** | -$2.04 | **-$1.24** | **-$0.80** | [-$10.32, +$8.69] |
| **POST Era** | -$6.68 | **-$0.20** | **-$6.48** | [-$19.06, +$6.37] |
| **2023** | -$2.13 | -$1.08 | -$1.05 | [-$17.56, +$14.43] |
| **2024** | -$3.25 | -$0.52 | -$2.73 | [-$16.43, +$10.37] |
| **2025** | -$1.35 | -$2.47 | +$1.12 | [-$13.24, +$16.30] |
| **2026** | -$10.09 | +$1.07 | -$11.16 | [-$26.76, +$4.30] |

*Finding:* AGREE underperforms its flipped placebo overall and in both eras. Flipping AGREE trades produces better results (-$0.96 vs -$3.28 overall; -$0.20 vs -$6.68 in POST; +$1.07 vs -$10.09 in 2026).

### 4.2 Placebo 2: Permutation Test (Labels Shuffled within Trade DIRECTION)
As corrected after initial review, AGREE/DISAGREE labels were permuted 2,000 times within trade `DIRECTION` (LONG trades shuffled among LONG, SHORT trades shuffled among SHORT) to avoid homogeneous date-strata ties.

- **Observed Difference (AGREE - DISAGREE):** +$1.003 / trade
- **Permutations with Diff >= Observed:** 363 / 2,000
- **One-Sided Permutation p-value:** **p = 0.1815**
- **Threshold for Significance:** p <= 0.05
- **Status:** **FAIL** (statistically indistinguishable from random noise).

---

## 5. Top-5 Concentration and Size-Rule Analysis

### 5.1 Top-5 Trade Share (AGREE Cohort)
- **Total AGREE Cohort P&L:** -$14,892.50
- **Condition for Validity:** Must be a **positive total** to evaluate top-5 share (per specification and implementation correction).
- **Sum of Top 5 AGREE Trades:** +$990.00
  1. `MONTHLY_VWAP_FADE_SHORT` (2023-08-02 09:43:00): +$198.00 (+100.0 pt target)
  2. `MONTHLY_VWAP_FADE_LONG` (2023-11-27 09:35:00): +$198.00 (+100.0 pt target)
  3. `MONTHLY_VWAP_FADE_SHORT` (2024-01-03 09:48:00): +$198.00 (+100.0 pt target)
  4. `MONTHLY_VWAP_FADE_SHORT` (2025-12-11 09:35:00): +$198.00 (+100.0 pt target)
  5. `MONTHLY_VWAP_FADE_SHORT` (2026-02-20 10:01:00): +$198.00 (+100.0 pt target)
- **Top-5 Share:** **N/A** (Total P&L is -$14,892.50; cannot pass on a negative total).

### 5.2 Size-Rule Sizing Analysis (Descriptive Only)
Comparing base roster (ALL tagged trades at 1.0x contract) vs Size Rule (AGREE at 1.0x contract, DISAGREE at 0.5x contract):

| Configuration | Total Contracts / Weight | Total P&L ($) | Mean $/trade ($) | Mean $/contract ($) |
|---|---|---|---|---|
| **ALL Tagged (Baseline 1.0x)** | 22,203.0 | -$90,479.50 | -$4.08 | -$4.08 |
| **Size Rule (AGREE 1.0x, DISAGREE 0.5x)** | 13,373.5 | -$52,686.00 | -$2.37 | -$3.94 |
| **Delta** | -8,829.5 (-39.8%) | **+$37,793.50** | **+$1.70** | +$0.14 |

*Interpretation:* The size rule reduces aggregate dollar drawdowns by +$37,793.50 purely by cutting trade volume in half on a persistently losing roster (-$4.28/trade DISAGREE pool). The per-contract edge improvement is trivial (+14 cents/contract), reflecting that the gate does not create positive expectancy.

---

## 6. Breakdown by Level Family & Exempt-Type Sensitivity

### 6.1 Family-Level Breakdown
| Level Family | N Total | N AGREE | N DISAGREE | AGREE Mean ($) | DISAGREE Mean ($) | Diff ($) | Diff 95% Bootstrap CI ($) |
|---|---|---|---|---|---|---|---|
| `PD_*` | 4,460 | 769 | 3,691 | -$1.18 | -$3.93 | +$2.75 | [-$4.66, +$10.03] |
| `PW_*` | 944 | 125 | 819 | +$1.33 | -$5.67 | +$6.99 | [-$7.64, +$21.64] |
| `PM_*` | 248 | 32 | 216 | +$13.53 | -$1.08 | +$14.61 | [-$12.70, +$40.31] |
| `CAM_*` | 3,498 | 615 | 2,883 | -$3.21 | -$3.15 | -$0.05 | [-$6.64, +$6.51] |
| `FLOOR_*` | 1,803 | 231 | 1,572 | -$4.78 | -$2.04 | -$2.74 | [-$11.13, +$6.22] |
| `OR*/IB* same-day` | 6,777 | 1,946 | 4,831 | -$4.16 | -$4.95 | +$0.79 | [-$4.85, +$6.07] |
| `opens/VWAPs` | 2,059 | 498 | 1,561 | -$2.97 | -$7.29 | +$4.32 | [-$3.69, +$12.69] |
| `other` | 2,414 | 328 | 2,086 | -$5.90 | -$4.14 | -$1.76 | [-$10.60, +$7.06] |

*Observation:* Not a single level family demonstrates a statistically significant difference between AGREE and DISAGREE (every family's 95% bootstrap CI spans zero). In `CAM_*`, `FLOOR_*`, and `other`, AGREE trades actually fared worse than DISAGREE.

### 6.2 Exempt-Type Sensitivity
None of the live gate exempt setup types (e.g. momentum trend or breakout systems) apply to level fades. Consequently, exempt sensitivity produces no change to this population.

---

## 7. Pre-Registered Pass Criteria Scorecard

| # | Criterion | Pre-Registered Requirement | Observed Metric | Status |
|---|---|---|---|---|
| **1** | **Sample Size** | N AGREE >= 2,000 and N DISAGREE >= 2,000 | N AGREE = 4,544, N DISAGREE = 17,659 | **PASS** |
| **2** | **Stability & Persistence** | AGREE - DISAGREE > 0, overall CI excludes 0, and > 0 in PRE & POST | Diff = +$1.00; CI [-$3.48, +$5.64] includes 0; POST Diff = -$4.82 (< 0) | **FAIL** |
| **3** | **Permutation Test** | Permutation p <= 0.05 (direction-blocked shuffle) | p = 0.1815 | **FAIL** |
| **4** | **Flipped Placebo** | AGREE mean beats flipped placebo overall and in PRE & POST | Overall: -$3.28 vs -$0.96 (Edge -$2.32); PRE: -$2.04 vs -$1.24; POST: -$6.68 vs -$0.20 | **FAIL** |
| **5** | **Concentration Check**| Top-5 share < 50% of a positive AGREE total | AGREE total is negative (-$14,892.50) | **FAIL** |

**Overall Result: 1 PASS / 4 FAIL**

---

## 8. Plain-English Verdict

**VERDICT: REJECT (FAIL). The 65pt rotation-direction gate is NOT supported on the 3.5-year level-fade population.**

1. **No Edge Over Random Chance:** The observed AGREE minus DISAGREE difference across 22,203 trades is only +$1.00/trade, and its 95% day-blocked confidence interval spans [-$3.48, +$5.64]. The permutation test yields p = 0.1815, confirming the difference is fully consistent with random noise.
2. **Era Instability:** While AGREE outperformed DISAGREE in the PRE era (+$3.60/trade), this completely inverted in the POST era (-$4.82/trade disadvantage for AGREE, worsening to -$8.60/trade in 2026).
3. **Fails Flipped Placebo:** In both eras and overall, AGREE trades lost more money than taking the exact opposite trade (-$3.28 vs -$0.96 overall).
4. **Negative Absolute Total:** Filtering to AGREE does not yield an investable or profitable strategy: the AGREE portfolio lost -$14,892.50 overall (-$3.28/trade).
5. **Operational Directive:** Per the pre-registration specification, the 65pt rotation gate **must not be promoted** to an execution gate for RTH level fades. It should remain strictly an observational shadow tag.
