# Level-Fade Roster Replay, Value-Area Traversal, and Early-Globex Rotation Studies
**Date:** 2026-10-19  
**Analyst:** Gemini 3.8 Flash (Autonomous Agent)  
**Data Environment:** Read-only PostgreSQL (`trading_journal`), naive Eastern Time NQ 1-minute bars (`price_bars_primary`)  
**Evaluation Window:** 2023-03-06 to 2026-10-16  

---

## Executive Summary

This independent study executes three bar-level quantitative analyses on NQ futures:
1. **Task A (Roster-Wide Replay):** Evaluates the live level-fade setup roster across 3.5 years of out-of-sample and historical data. Overall pooled mean P&L is **-$4.04/trade** (95% CI: [-$5.70, -$2.32]), compared to **+$0.23/trade** for the direction-flipped placebo (real edge: **-$4.26/trade**). Zero of the 127 setup types cleared a positive lower bound after day-blocked bootstrapping.
2. **Task B (Value-Area Traversal):** Tests whether price re-entering the prior-day value area traverses edge-to-edge. Pooled reach probability is **40.2%** vs **37.5%** on equal-width placebo bands shifted by $\pm 0.3, \pm 0.6 \times \text{ATR20}$ (difference **+2.70%**, 95% CI: [-0.90%, +6.34%], non-significant). Traversal frequency in narrow bands (~60%) is shown to be a geometric artifact of random walk noise, not auction attraction.
3. **Task C (Early-Globex Rotation):** Tests whether confirming a $\ge 65$-point rotation leg within the first 10 minutes of Globex (18:00–18:10 ET) predicts overnight or RTH continuation. Overnight continuation (Outcome 1) yields **+0.1025 ATR** ($p = 0.0725$ vs permutation null), but DOWN legs show zero continuation (-0.0007 ATR, 51.6% win rate), indicating the effect is largely general overnight equity drift (+0.0444 ATR). Outcome 2 (RTH session) shows no positive follow-through (**-0.0898 ATR**, $p = 0.2355$).

---

## Common Data Integrity & Gating

- **Initial Window:** 2023-03-06 to 2026-10-16 (928 total RTH sessions recorded in DB).
- **Skipped Due to <20 Prior Sessions (ATR20 Gate):** 19 days (2023-03-06 through 2023-03-30), as 1-minute bars begin 2023-03-03.
- **Skipped Due to Missing `PD_CLOSE`:** 16 days (market holidays or uncomputed level dates: 2023-05-29, 2023-06-19, 2023-07-03, 2023-07-04, 2023-09-04, 2023-11-16, 2024-01-15, 2024-07-03, 2024-07-04, 2024-12-24, 2025-01-20, 2025-02-17, 2026-07-22, 2026-07-23, 2026-07-24, 2026-08-07).
- **Skipped Due to Roll Integrity Gate (`|PD_CLOSE - prev_rth_close| > 0.1 * ATR20`):** 39 days across quarterly contract rolls and calendar adjustments (listed in script output).
- **Valid Trading Days for Studies:** **854 days**.
- **Dollar & Commission Specification:** Micro E-mini Nasdaq (MNQ) $2/point, $2 round-trip commission: $\text{pnl} = \text{points} \times 2 - 2$.
- **Statistical Rigor:** All confidence intervals are 2,000-iteration day-blocked bootstraps. Per-trade mean is calculated as $\sum \text{pnl} / N$.

---

## TASK A: Roster-Wide Replay of Level-Fade Setups

**Script:** `scratch/gemini_roster_replay.mjs`  
**Scope:** 127 live calibrated setup types from `performance_audit` (`OPTIMAL_STOP` rows) matching `level_prices`, excluding `RTH_VWAP` and `_OVERNIGHT`.  
**Entry Rule:** First bar $i \ge 5$ with $\text{mod} \ge \max(575, \text{gate})$ and $\text{mod} < 960$ where $|\text{close}[i] - L| \le 15$. SHORT fade if $\text{close}[i-5] < \text{close}[i]$, else LONG fade.  
**Resolution:** Bar $i+1$ to 15:59. Stop / Target in points. If both hit in same bar, STOP wins. Unresolved at 15:59 marked to market at 15:59 close.  
**Placebo:** Exact same touch bar, direction flipped with identical stop and target distances applied to opposite side.

### Headline Pooled Results

| Category | N | Days | Win% | Mean $/trade | 95% Day-Blocked CI | Flipped $/trade | Real Edge ($/tr) |
|---|---|---|---|---|---|---|---|
| **ALL POOLED** | **22,408** | **854** | **38.3%** | **-$4.04** | **[-$5.70, -$2.32]** | **+$0.23** | **-$4.26** |
| Pre-2025-06-01 (Out-of-Sample) | 14,832 | 549 | 38.3% | -$4.73 | [-$6.72, -$2.69] | +$0.26 | -$4.99 |
| Post-2025-06-01 (In-Calibration) | 7,576 | 305 | 38.3% | -$2.68 | [-$5.48, +$0.19] | +$0.16 | -$2.84 |

### Directional Breakdown

| Direction | N | Days | Win% | Mean $/trade | 95% Day-Blocked CI | Flipped $/trade | Real Edge ($/tr) |
|---|---|---|---|---|---|---|---|
| **LONG** | 11,538 | 853 | 38.1% | -$3.98 | [-$6.41, -$1.47] | +$0.37 | -$4.35 |
| **SHORT** | 10,870 | 853 | 38.5% | -$4.10 | [-$6.57, -$1.41] | +$0.08 | -$4.17 |

### Breakdown by Level Family

| Family | N | Days | Win% | Mean $/trade | 95% Day-Blocked CI | Flipped $/trade | Real Edge ($/tr) |
|---|---|---|---|---|---|---|---|
| **PD_\*** | 4,499 | 832 | 37.6% | -$3.41 | [-$6.09, -$0.66] | -$0.11 | -$3.30 |
| **PW_\*** | 950 | 545 | 37.8% | -$4.73 | [-$9.73, +$0.08] | -$0.65 | -$4.08 |
| **PM_\*** | 248 | 196 | 40.7% | +$0.80 | [-$8.07, +$10.08] | -$1.07 | +$1.88 |
| **CAM_\*** | 3,538 | 798 | 37.6% | -$3.21 | [-$5.49, -$0.74] | -$1.40 | -$1.81 |
| **FLOOR_\*** | 1,812 | 705 | 39.7% | -$2.33 | [-$5.10, +$0.73] | -$1.51 | -$0.82 |
| **OR\*/IB\* same-day** | 6,850 | 848 | 39.1% | -$4.67 | [-$6.66, -$2.72] | +$1.83 | -$6.49 |
| **opens/VWAPs** | 2,076 | 777 | 37.1% | -$6.15 | [-$9.61, -$2.82] | +$0.88 | -$7.03 |
| **other** | 2,435 | 733 | 38.6% | -$4.33 | [-$7.06, -$1.21] | -$0.10 | -$4.22 |

### Multiple Testing Audit
- **Setups with 95% CI Lower Bound > 0:** **0 / 127** (0.0%).
- **Setups with 95% CI Upper Bound < 0:** **15 / 127** (11.8%).
- **Expected by Chance (5% two-sided, 2.5% tail):** ~3.2 on each side (6.4 total).
- **Finding:** Not a single setup type demonstrated statistically significant positive edge over the 3.5-year history. Negative outliers (15) exceed chance expectation, reflecting commission drag ($2/trade) and adverse selection when fading momentum.

### Caveat
*Every level fires independently (no portfolio concurrency gate, no confluence deduplication). The pooled figures represent aggregate signal expectancy per touch, not a realized account equity curve.*

### Detailed Roster Breakdown (All 127 Setups)

| Setup Type | N | Days | Win% | Mean $/tr | 95% CI | Flipped $/tr | Real Edge | Pre-2025-06 | Post-2025-06 | 2023 | 2024 | 2025 | 2026 | Live Rec | Live Real N | Live Real EV |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10D_IB_MID_FADE_LONG | 106 | 106 | 45.3% | $4.72 | [-8.9, 18.4] | $-6.58 | $11.30 | $5.9 | $3.0 | $3.5 | $4.2 | $-10.7 | $21.4 | ACTIVE | 24 | $1.3 |
| 10D_IB_MID_FADE_SHORT | 104 | 104 | 38.5% | $-6.07 | [-20.0, 7.9] | $5.69 | $-11.76 | $-0.6 | $-14.5 | $-4.8 | $3.3 | $-25.8 | $2.1 | ACTIVE | 22 | $-22.4 |
| 3M_POC_FADE_LONG | 66 | 66 | 40.9% | $-0.86 | [-18.1, 15.3] | $3.69 | $-4.55 | $-2.0 | $0.2 | $-11.0 | $-5.4 | $23.9 | $-20.6 | ACTIVE | 23 | $-7.9 |
| 3M_POC_FADE_SHORT | 57 | 57 | 54.4% | $6.58 | [-11.8, 25.0] | $-10.21 | $16.79 | $-1.6 | $16.3 | $9.2 | $-11.7 | $5.8 | $18.7 | ACTIVE | 22 | $10.9 |
| 5D_OR_MID_FADE_LONG | 125 | 125 | 40.0% | $-11.50 | [-24.2, 2.2] | $9.16 | $-20.66 | $-10.5 | $-12.7 | $-3.5 | $-38.8 | $17.2 | $-26.5 | ACTIVE | 22 | $0.9 |
| 5D_OR_MID_FADE_SHORT | 122 | 122 | 44.3% | $-3.43 | [-17.2, 9.4] | $-1.68 | $-1.75 | $-4.7 | $-1.3 | $6.9 | $-4.5 | $-3.6 | $-13.2 | ACTIVE | 29 | $-8.1 |
| CAM_R1_FADE_LONG | 238 | 238 | 52.1% | $-2.90 | [-9.8, 3.8] | $-3.55 | $0.66 | $-2.2 | $-4.1 | $-4.0 | $0.4 | $2.4 | $-14.8 | ACTIVE | 51 | $-0.3 |
| CAM_R1_FADE_SHORT | 259 | 259 | 39.0% | $-3.37 | [-10.1, 3.6] | $-2.04 | $-1.33 | $-1.1 | $-7.6 | $-4.5 | $2.1 | $-4.8 | $-8.5 | ACTIVE | 50 | $-25.3 |
| CAM_R2_FADE_LONG | 215 | 215 | 35.8% | $-6.38 | [-15.2, 2.5] | $3.86 | $-10.24 | $-7.1 | $-5.1 | $-5.8 | $-6.0 | $-8.6 | $-4.1 | ACTIVE | 42 | $-13.7 |
| CAM_R2_FADE_SHORT | 287 | 287 | 37.6% | $-4.01 | [-11.3, 3.6] | $-3.95 | $-0.06 | $-1.5 | $-8.6 | $-1.3 | $-5.0 | $-6.4 | $-2.4 | ACTIVE | 43 | $3.8 |
| CAM_R3_FADE_LONG | 178 | 178 | 40.4% | $-1.58 | [-11.8, 8.5] | $4.53 | $-6.12 | $-0.4 | $-3.6 | $4.3 | $2.4 | $-3.6 | $-13.0 | ACTIVE | 22 | $-34.3 |
| CAM_R3_FADE_SHORT | 297 | 297 | 47.1% | $0.35 | [-8.9, 10.0] | $-9.06 | $9.41 | $0.9 | $-0.7 | $1.0 | $-3.0 | $3.8 | $-0.8 | ACTIVE | 25 | $-1.2 |
| CAM_R4_FADE_LONG | 81 | 81 | 35.8% | $-8.04 | [-23.2, 7.1] | $-2.15 | $-5.90 | $-1.2 | $-16.6 | $-22.1 | $-3.0 | $2.5 | $-18.2 | ACTIVE | 19 | $-50.7 |
| CAM_R4_FADE_SHORT | 280 | 280 | 33.2% | $-12.30 | [-21.8, -3.0] | $5.26 | $-17.56 | $-10.0 | $-16.0 | $-7.8 | $-11.8 | $-11.6 | $-19.0 | ACTIVE | 28 | $5.1 |
| CAM_S1_FADE_LONG | 301 | 301 | 40.9% | $1.62 | [-5.7, 8.8] | $0.12 | $1.50 | $4.1 | $-2.9 | $2.1 | $5.0 | $-4.2 | $4.7 | ACTIVE | 50 | $10.2 |
| CAM_S1_FADE_SHORT | 188 | 188 | 44.7% | $-8.30 | [-18.5, 1.3] | $4.37 | $-12.66 | $-15.9 | $5.1 | $-3.6 | $-29.8 | $-6.8 | $8.9 | ACTIVE | 37 | $-33.8 |
| CAM_S2_FADE_LONG | 300 | 300 | 48.3% | $1.46 | [-6.1, 8.9] | $-6.58 | $8.04 | $4.2 | $-3.3 | $16.1 | $-6.0 | $-2.9 | $3.0 | ACTIVE | 0 | $- |
| CAM_S2_FADE_SHORT | 169 | 169 | 36.1% | $-1.88 | [-11.6, 7.4] | $-5.05 | $3.17 | $-7.4 | $8.4 | $-13.9 | $-7.0 | $11.7 | $3.1 | ACTIVE | 49 | $0.4 |
| CAM_S3_FADE_LONG | 301 | 301 | 37.2% | $-2.01 | [-8.9, 5.2] | $-2.63 | $0.62 | $-2.5 | $-1.2 | $10.0 | $-10.2 | $-2.5 | $-3.8 | ACTIVE | 52 | $-5.4 |
| CAM_S3_FADE_SHORT | 124 | 124 | 35.5% | $-2.00 | [-13.0, 8.0] | $-2.00 | $0.00 | $-1.0 | $-4.7 | $5.7 | $-18.0 | $12.6 | $-16.5 | ACTIVE | 48 | $-8.4 |
| CAM_S4_FADE_LONG | 249 | 249 | 30.9% | $-4.89 | [-11.7, 2.6] | $1.17 | $-6.06 | $-6.5 | $-2.3 | $-3.5 | $-7.6 | $-11.7 | $5.3 | ACTIVE | 36 | $-9.9 |
| CAM_S4_FADE_SHORT | 71 | 71 | 25.4% | $0.37 | [-9.9, 10.6] | $0.66 | $-0.30 | $5.4 | $-7.4 | $0.0 | $3.7 | $5.2 | $-6.2 | ACTIVE | 34 | $-10.3 |
| DAILY_OPEN_FADE_LONG | 360 | 360 | 41.7% | $-7.77 | [-14.8, -1.2] | $0.77 | $-8.54 | $-9.1 | $-5.6 | $-1.5 | $-10.6 | $-10.9 | $-7.6 | ACTIVE | 0 | $- |
| DAILY_OPEN_FADE_SHORT | 347 | 347 | 39.8% | $-3.14 | [-10.7, 4.1] | $-3.77 | $0.63 | $-3.8 | $-2.1 | $-3.2 | $-4.6 | $-2.3 | $-2.1 | ACTIVE | 12 | $26.4 |
| FLOOR_PIVOT_FADE_LONG | 278 | 278 | 32.0% | $-5.58 | [-12.1, 1.4] | $-3.40 | $-2.17 | $-7.7 | $-1.7 | $-6.0 | $-10.6 | $-8.0 | $6.5 | ACTIVE | 51 | $-3.6 |
| FLOOR_PIVOT_FADE_SHORT | 204 | 204 | 38.7% | $0.55 | [-6.9, 8.2] | $-2.40 | $2.95 | $-4.1 | $9.7 | $-7.2 | $-2.2 | $6.2 | $7.5 | ACTIVE | 56 | $-17.5 |
| FLOOR_R1_FADE_LONG | 99 | 99 | 37.4% | $-8.89 | [-21.3, 4.5] | $2.06 | $-10.95 | $-9.5 | $-8.1 | $-23.1 | $-8.2 | $-0.8 | $-9.9 | ACTIVE | 41 | $1.5 |
| FLOOR_R1_FADE_SHORT | 302 | 302 | 47.7% | $1.65 | [-6.1, 8.9] | $-4.20 | $5.85 | $4.3 | $-3.1 | $-2.7 | $13.0 | $0.8 | $-7.5 | ACTIVE | 0 | $- |
| FLOOR_R2_FADE_LONG | 34 | 34 | 47.1% | $3.93 | [-22.4, 30.2] | $-13.69 | $17.62 | $2.6 | $7.0 | $-12.8 | $11.5 | $26.8 | $-19.3 | ACTIVE | 21 | $-28.9 |
| FLOOR_R2_FADE_SHORT | 187 | 187 | 44.9% | $-2.89 | [-9.7, 3.8] | $-0.43 | $-2.46 | $-6.4 | $1.9 | $-1.5 | $-8.9 | $-4.4 | $3.9 | ACTIVE | 28 | $0.4 |
| FLOOR_R3_FADE_SHORT | 78 | 78 | 33.3% | $-10.66 | [-25.3, 5.1] | $6.07 | $-16.73 | $-17.4 | $8.8 | $-29.6 | $-9.8 | $19.8 | $-0.4 | ACTIVE | 15 | $15.0 |
| FLOOR_S1_FADE_LONG | 251 | 251 | 45.0% | $-2.44 | [-10.9, 6.3] | $-3.31 | $0.87 | $1.5 | $-9.2 | $-2.7 | $4.1 | $0.8 | $-13.7 | ACTIVE | 0 | $- |
| FLOOR_S1_FADE_SHORT | 76 | 76 | 38.2% | $10.07 | [-2.1, 22.3] | $-10.04 | $20.11 | $11.6 | $7.9 | $-6.0 | $3.2 | $29.3 | $6.5 | ACTIVE | 29 | $-8.3 |
| FLOOR_S2_FADE_LONG | 157 | 157 | 40.1% | $-3.24 | [-13.8, 8.1] | $5.62 | $-8.86 | $-8.3 | $4.5 | $-7.4 | $-5.1 | $-10.7 | $10.8 | ACTIVE | 37 | $-1.3 |
| FLOOR_S2_FADE_SHORT | 35 | 35 | 37.1% | $-11.57 | [-29.0, 6.8] | $6.89 | $-18.46 | $-2.4 | $-20.3 | $-27.5 | $20.0 | $-14.5 | $-18.2 | ACTIVE | 30 | $4.4 |
| FLOOR_S3_FADE_LONG | 99 | 99 | 37.4% | $-2.49 | [-16.1, 11.0] | $0.40 | $-2.89 | $-11.6 | $14.1 | $-2.2 | $-3.8 | $-19.4 | $18.4 | ACTIVE | 24 | $5.1 |
| FLOOR_S3_FADE_SHORT | 12 | 12 | 33.3% | $-12.67 | [-48.2, 22.8] | $22.83 | $-35.50 | $11.0 | $-24.5 | $82.0 | $-12.7 | $-60.0 | $-12.7 | ACTIVE | 15 | $-23.5 |
| IB_HIGH_FADE_LONG | 30 | 30 | 26.7% | $-12.50 | [-29.5, 6.2] | $7.72 | $-20.22 | $-19.1 | $0.8 | $-13.7 | $-16.0 | $-21.6 | $30.7 | ACTIVE | 63 | $-14.0 |
| IB_HIGH_FADE_SHORT | 525 | 525 | 31.6% | $-7.34 | [-13.4, -1.5] | $2.66 | $-10.01 | $-10.0 | $-3.0 | $-14.2 | $-8.1 | $-3.0 | $-5.3 | ACTIVE | 97 | $21.2 |
| IB_LOW_FADE_LONG | 468 | 468 | 35.3% | $-1.43 | [-8.4, 6.1] | $2.93 | $-4.37 | $-2.6 | $0.7 | $-4.0 | $5.0 | $-6.8 | $-0.5 | ACTIVE | 62 | $27.9 |
| IB_LOW_FADE_SHORT | 17 | 17 | 35.3% | $-7.50 | [-37.0, 24.5] | $2.09 | $-9.59 | $-23.1 | $10.0 | $-58.0 | $-13.4 | $-3.6 | $23.6 | ACTIVE | 39 | $-36.7 |
| MONTHLY_OPEN_FADE_LONG | 84 | 84 | 36.9% | $-3.67 | [-18.4, 10.7] | $-5.61 | $1.94 | $-5.4 | $-1.1 | $-3.8 | $-4.8 | $-17.4 | $11.7 | ACTIVE | 10 | $13.6 |
| MONTHLY_OPEN_FADE_SHORT | 76 | 76 | 43.4% | $2.76 | [-13.3, 18.8] | $-3.91 | $6.67 | $3.5 | $0.9 | $-3.2 | $-0.1 | $6.8 | $11.0 | ACTIVE | 6 | $27.0 |
| MONTHLY_VWAP_FADE_LONG | 167 | 167 | 18.6% | $-5.03 | [-20.6, 10.8] | $4.33 | $-9.36 | $-13.5 | $6.2 | $-18.1 | $-24.6 | $12.8 | $3.4 | ACTIVE | 22 | $-4.5 |
| MONTHLY_VWAP_FADE_SHORT | 141 | 141 | 17.7% | $-9.71 | [-25.0, 7.0] | $7.18 | $-16.90 | $-12.6 | $-4.9 | $-13.3 | $-17.4 | $4.3 | $-12.8 | ACTIVE | 32 | $-34.0 |
| MPP_FADE_LONG | 52 | 52 | 38.5% | $-4.02 | [-21.2, 15.4] | $7.22 | $-11.24 | $3.6 | $-11.1 | $22.1 | $-17.4 | $-4.8 | $-9.8 | ACTIVE | 6 | $23.3 |
| MPP_FADE_SHORT | 59 | 59 | 35.6% | $-7.36 | [-23.9, 10.2] | $2.00 | $-9.36 | $-22.0 | $8.9 | $-3.2 | $-30.8 | $5.5 | $1.0 | ACTIVE | 7 | $5.9 |
| MR1_FADE_LONG | 42 | 42 | 40.5% | $-5.55 | [-28.1, 17.0] | $-4.90 | $-0.64 | $-10.2 | $0.1 | $-12.8 | $0.9 | $20.2 | $-42.8 | ACTIVE | 6 | $2.0 |
| MR1_FADE_SHORT | 49 | 49 | 44.9% | $3.63 | [-17.4, 24.6] | $-10.49 | $14.12 | $17.0 | $-19.3 | $-19.3 | $21.7 | $33.3 | $-56.2 | ACTIVE | 8 | $-16.0 |
| MS1_FADE_LONG | 35 | 35 | 45.7% | $4.91 | [-15.4, 29.3] | $-27.54 | $32.46 | $0.9 | $11.0 | $-12.7 | $-31.6 | $11.0 | $30.4 | ACTIVE | 2 | $-54.0 |
| ONH_FADE_LONG | 68 | 68 | 47.1% | $-20.82 | [-36.1, -5.5] | $14.57 | $-35.39 | $-15.6 | $-31.1 | $-13.9 | $-28.5 | $-10.5 | $-43.0 | ACTIVE | 44 | $-10.0 |
| ONH_FADE_SHORT | 475 | 475 | 36.6% | $-7.32 | [-13.4, -1.4] | $0.53 | $-7.85 | $-9.5 | $-3.0 | $-8.1 | $-10.7 | $-4.1 | $-5.8 | ACTIVE | 58 | $-7.5 |
| ONL_FADE_LONG | 433 | 433 | 22.6% | $-5.23 | [-9.3, -1.1] | $-0.76 | $-4.47 | $-9.1 | $1.4 | $-7.4 | $-9.3 | $-6.6 | $4.7 | ACTIVE | 59 | $-9.9 |
| ONL_FADE_SHORT | 48 | 48 | 33.3% | $-4.00 | [-17.5, 11.8] | $-8.50 | $4.50 | $-5.3 | $-2.2 | $-20.4 | $9.8 | $-9.1 | $3.2 | ACTIVE | 45 | $2.2 |
| OR10_HIGH_FADE_LONG | 25 | 25 | 20.0% | $-5.20 | [-21.8, 11.4] | $-13.52 | $8.32 | $-4.3 | $-26.0 | $-16.5 | $5.2 | $8.7 | $-26.0 | ACTIVE | 45 | $-7.0 |
| OR10_HIGH_FADE_SHORT | 401 | 401 | 37.2% | $-2.02 | [-7.5, 4.3] | $-3.34 | $1.32 | $-0.4 | $-9.9 | $0.5 | $1.1 | $-10.1 | $-2.5 | ACTIVE | 57 | $-2.1 |
| OR10_LOW_FADE_LONG | 388 | 388 | 58.8% | $-2.97 | [-9.0, 3.3] | $2.56 | $-5.52 | $-4.7 | $5.4 | $-9.0 | $-1.6 | $-3.0 | $14.2 | ACTIVE | 39 | $-4.1 |
| OR10_LOW_FADE_SHORT | 19 | 19 | 36.8% | $-7.68 | [-37.6, 22.2] | $14.74 | $-22.42 | $-3.2 | $-24.5 | $11.0 | $-24.5 | $34.7 | $-60.0 | ACTIVE | 28 | $-3.5 |
| OR10_MID_FADE_LONG | 230 | 230 | 26.5% | $-4.30 | [-10.6, 2.0] | $1.06 | $-5.36 | $-4.7 | $-1.5 | $2.5 | $-9.6 | $-8.5 | $-4.5 | ACTIVE | 36 | $4.4 |
| OR10_MID_FADE_SHORT | 217 | 217 | 42.9% | $-1.49 | [-9.4, 6.7] | $-0.90 | $-0.59 | $-0.4 | $-5.7 | $10.7 | $-3.9 | $-12.5 | $-1.7 | ACTIVE | 31 | $-14.7 |
| OR15_HIGH_FADE_LONG | 27 | 27 | 14.8% | $-15.70 | [-27.9, 0.6] | $0.59 | $-16.30 | $-12.9 | $-32.0 | $-12.0 | $-32.0 | $12.0 | $-32.0 | ACTIVE | 32 | $-7.9 |
| OR15_HIGH_FADE_SHORT | 382 | 382 | 42.1% | $-4.38 | [-11.4, 3.0] | $3.92 | $-8.30 | $-6.6 | $7.3 | $2.8 | $-15.0 | $-9.4 | $27.8 | ACTIVE | 41 | $3.5 |
| OR15_LOW_FADE_LONG | 375 | 375 | 50.4% | $-2.42 | [-9.7, 4.5] | $-0.64 | $-1.78 | $-4.5 | $8.0 | $-12.0 | $6.4 | $-7.5 | $11.0 | ACTIVE | 34 | $9.4 |
| OR15_LOW_FADE_SHORT | 14 | 14 | 21.4% | $-22.14 | [-52.6, 11.0] | $21.14 | $-43.29 | $-7.0 | $-60.0 | $4.7 | $-24.5 | $-60.0 | $-60.0 | ACTIVE | 19 | $-4.4 |
| OR15_MID_FADE_LONG | 223 | 223 | 28.3% | $-8.10 | [-15.1, -0.6] | $4.28 | $-12.38 | $-8.3 | $-6.7 | $-12.7 | $1.5 | $-13.8 | $-7.7 | ACTIVE | 40 | $4.2 |
| OR15_MID_FADE_SHORT | 217 | 217 | 28.1% | $1.85 | [-4.5, 8.1] | $-3.88 | $5.73 | $0.2 | $9.1 | $4.8 | $-0.5 | $-4.0 | $14.4 | ACTIVE | 33 | $-2.1 |
| OR30_HIGH_FADE_LONG | 26 | 26 | 23.1% | $-14.31 | [-32.8, 8.8] | $18.00 | $-32.31 | $-14.3 | $- | $-6.0 | $-16.3 | $-42.0 | $- | ACTIVE | 32 | $-4.4 |
| OR30_HIGH_FADE_SHORT | 348 | 348 | 50.9% | $-6.68 | [-13.6, 0.3] | $3.13 | $-9.81 | $-9.3 | $5.9 | $-0.9 | $-9.6 | $-15.4 | $6.3 | ACTIVE | 47 | $20.9 |
| OR30_LOW_FADE_LONG | 335 | 335 | 26.9% | $-2.50 | [-9.0, 4.5] | $-1.41 | $-1.09 | $-2.8 | $-1.0 | $-4.9 | $-3.0 | $0.4 | $1.8 | ACTIVE | 34 | $20.6 |
| OR30_LOW_FADE_SHORT | 16 | 16 | 43.8% | $2.13 | [-33.4, 37.6] | $2.13 | $0.00 | $0.9 | $11.0 | $11.0 | $-12.7 | $-12.7 | $82.0 | ACTIVE | 21 | $1.5 |
| OR30_MID_FADE_LONG | 215 | 215 | 34.4% | $-8.67 | [-20.4, 4.1] | $-2.01 | $-6.65 | $-7.0 | $-15.9 | $-22.3 | $2.0 | $-7.7 | $-1.3 | ACTIVE | 29 | $2.5 |
| OR30_MID_FADE_SHORT | 194 | 194 | 45.9% | $-2.11 | [-13.6, 9.7] | $-0.41 | $-1.70 | $-5.3 | $15.2 | $-8.7 | $-4.9 | $12.8 | $4.0 | ACTIVE | 28 | $5.3 |
| OR5_HIGH_FADE_LONG | 56 | 56 | 25.0% | $-18.75 | [-32.8, -2.3] | $5.71 | $-24.46 | $-20.4 | $-10.0 | $-28.6 | $-23.8 | $4.7 | $-1.2 | ACTIVE | 85 | $-10.2 |
| OR5_HIGH_FADE_SHORT | 654 | 654 | 37.5% | $-7.59 | [-15.5, -0.2] | $7.72 | $-15.31 | $-4.6 | $-12.7 | $-2.7 | $-8.3 | $-1.8 | $-18.7 | ACTIVE | 83 | $-5.5 |
| OR5_LOW_FADE_LONG | 654 | 654 | 27.1% | $-3.51 | [-7.3, 0.3] | $-1.00 | $-2.51 | $-2.9 | $-4.6 | $-7.1 | $-0.2 | $-2.7 | $-5.2 | ACTIVE | 61 | $1.8 |
| OR5_LOW_FADE_SHORT | 54 | 54 | 38.9% | $1.04 | [-15.6, 18.7] | $6.89 | $-5.85 | $15.9 | $-28.7 | $43.1 | $6.7 | $-7.3 | $-50.0 | ACTIVE | 97 | $-5.0 |
| OR5_MID_FADE_LONG | 372 | 372 | 31.7% | $-8.00 | [-15.4, -0.7] | $8.08 | $-16.08 | $-6.5 | $-10.7 | $-9.4 | $-5.3 | $-7.4 | $-11.0 | ACTIVE | 90 | $10.2 |
| OR5_MID_FADE_SHORT | 368 | 368 | 33.2% | $-4.55 | [-10.1, 1.3] | $-1.52 | $-3.03 | $-7.0 | $-0.1 | $-10.6 | $-2.5 | $-0.4 | $-6.3 | ACTIVE | 87 | $-6.6 |
| PD_CLOSE_FADE_LONG | 272 | 272 | 38.6% | $-1.52 | [-8.9, 6.3] | $-0.42 | $-1.10 | $-4.0 | $2.7 | $7.9 | $-8.1 | $-11.2 | $11.1 | ACTIVE | 46 | $-6.0 |
| PD_CLOSE_FADE_SHORT | 229 | 229 | 36.7% | $-3.87 | [-11.8, 4.0] | $-3.10 | $-0.77 | $-4.8 | $-2.0 | $-10.3 | $3.3 | $-4.3 | $-5.8 | ACTIVE | 59 | $7.7 |
| PD_HIGH_FADE_LONG | 152 | 152 | 23.7% | $-12.05 | [-19.8, -3.5] | $4.85 | $-16.90 | $-13.8 | $-9.5 | $-22.6 | $-19.4 | $-10.5 | $5.1 | ACTIVE | 29 | $-18.9 |
| PD_HIGH_FADE_SHORT | 253 | 253 | 30.0% | $-6.92 | [-13.1, -1.1] | $2.14 | $-9.06 | $-11.2 | $0.4 | $-11.1 | $-8.4 | $-8.5 | $1.1 | ACTIVE | 35 | $-3.7 |
| PD_IB_HIGH_FADE_LONG | 176 | 176 | 36.4% | $-7.38 | [-16.7, 2.3] | $4.76 | $-12.14 | $-5.7 | $-10.7 | $-5.3 | $-7.0 | $-15.8 | $4.8 | ACTIVE | 35 | $-11.3 |
| PD_IB_HIGH_FADE_SHORT | 205 | 205 | 56.6% | $-5.46 | [-13.9, 2.8] | $-1.62 | $-3.84 | $-9.1 | $0.4 | $-8.4 | $-9.8 | $-8.8 | $6.0 | ACTIVE | 40 | $-7.7 |
| PD_IB_LOW_FADE_LONG | 207 | 207 | 34.8% | $-8.50 | [-16.9, 0.3] | $5.09 | $-13.59 | $-12.4 | $-3.3 | $-2.4 | $-19.8 | $-18.0 | $8.2 | ACTIVE | 33 | $-31.9 |
| PD_IB_LOW_FADE_SHORT | 140 | 140 | 47.1% | $-2.76 | [-14.7, 9.5] | $-0.36 | $-2.40 | $-8.8 | $9.6 | $-2.7 | $-8.6 | $-13.5 | $23.5 | ACTIVE | 25 | $27.8 |
| PD_IB_MID_FADE_LONG | 209 | 209 | 50.2% | $1.63 | [-9.0, 12.1] | $-4.68 | $6.31 | $4.1 | $-2.4 | $12.5 | $3.0 | $-5.6 | $-1.9 | ACTIVE | 39 | $-23.4 |
| PD_IB_MID_FADE_SHORT | 191 | 191 | 29.8% | $0.84 | [-9.8, 12.0] | $-9.78 | $10.62 | $-5.1 | $10.9 | $6.3 | $-8.2 | $1.4 | $4.7 | ACTIVE | 40 | $17.8 |
| PD_LOW_FADE_LONG | 224 | 224 | 33.5% | $-8.03 | [-16.0, 0.1] | $9.02 | $-17.06 | $-12.9 | $0.3 | $-6.2 | $-23.0 | $1.7 | $-4.0 | ACTIVE | 38 | $-15.8 |
| PD_LOW_FADE_SHORT | 87 | 87 | 20.7% | $-5.10 | [-15.6, 6.9] | $7.78 | $-12.88 | $-1.2 | $-13.4 | $-6.0 | $-2.5 | $0.5 | $-12.5 | ACTIVE | 32 | $21.6 |
| PD_OR_MID_FADE_LONG | 192 | 192 | 41.1% | $-7.53 | [-17.4, 2.8] | $4.37 | $-11.90 | $-7.7 | $-7.3 | $-4.0 | $-12.3 | $-9.6 | $-0.9 | ACTIVE | 32 | $-26.9 |
| PD_OR_MID_FADE_SHORT | 162 | 162 | 51.9% | $4.85 | [-7.5, 17.1] | $-7.91 | $12.77 | $-4.7 | $19.4 | $3.4 | $-13.1 | $15.8 | $11.5 | ACTIVE | 44 | $-19.3 |
| PD_POC_FADE_LONG | 256 | 256 | 41.8% | $5.06 | [-2.7, 12.5] | $-4.90 | $9.96 | $8.6 | $-1.0 | $13.5 | $12.2 | $-5.1 | $0.1 | ACTIVE | 119 | $0.3 |
| PD_POC_FADE_SHORT | 219 | 219 | 53.9% | $-11.94 | [-22.5, -2.0] | $8.05 | $-19.99 | $-14.7 | $-6.9 | $-14.6 | $-11.4 | $-11.5 | $-10.0 | ACTIVE | 63 | $-27.3 |
| PD_SESSION_MID_FADE_LONG | 247 | 247 | 38.1% | $-5.66 | [-14.1, 2.6] | $4.45 | $-10.11 | $-0.9 | $-14.2 | $8.5 | $-3.6 | $-15.4 | $-11.7 | ACTIVE | 41 | $-16.1 |
| PD_SESSION_MID_FADE_SHORT | 197 | 197 | 34.0% | $-4.37 | [-11.3, 3.1] | $-2.14 | $-2.22 | $-5.8 | $-1.4 | $-2.6 | $-7.2 | $0.8 | $-10.6 | ACTIVE | 44 | $-17.9 |
| PD_VAH_FADE_LONG | 207 | 207 | 42.5% | $1.77 | [-7.0, 10.7] | $-5.61 | $7.37 | $-1.9 | $7.1 | $3.1 | $-3.2 | $-6.7 | $21.1 | ACTIVE | 45 | $-8.2 |
| PD_VAH_FADE_SHORT | 270 | 270 | 37.4% | $-4.80 | [-12.8, 2.9] | $-0.29 | $-4.51 | $-7.2 | $-0.7 | $-22.0 | $2.8 | $4.8 | $-8.2 | ACTIVE | 159 | $5.8 |
| PD_VAL_FADE_LONG | 261 | 261 | 43.7% | $0.61 | [-9.8, 11.1] | $-5.17 | $5.78 | $-1.0 | $3.5 | $11.1 | $-2.0 | $-6.7 | $1.6 | ACTIVE | 116 | $3.5 |
| PD_VAL_FADE_SHORT | 143 | 143 | 33.6% | $5.95 | [-2.2, 14.7] | $-3.20 | $9.15 | $4.6 | $8.3 | $7.0 | $-1.7 | $8.1 | $12.8 | ACTIVE | 42 | $-13.9 |
| PM_HIGH_FADE_LONG | 52 | 52 | 51.9% | $15.45 | [-3.7, 36.3] | $-13.61 | $29.06 | $31.1 | $-0.2 | $29.3 | $25.5 | $11.0 | $-3.6 | ACTIVE | 19 | $-14.8 |
| PM_HIGH_FADE_SHORT | 54 | 54 | 35.2% | $-7.21 | [-25.9, 11.4] | $9.25 | $-16.46 | $-10.2 | $-3.5 | $-22.2 | $4.5 | $-24.4 | $5.4 | ACTIVE | 12 | $-22.0 |
| PM_VAH_FADE_LONG | 48 | 48 | 41.7% | $-8.50 | [-28.6, 11.6] | $6.88 | $-15.38 | $-3.7 | $-17.3 | $-10.8 | $-4.7 | $3.0 | $-31.5 | ACTIVE | 0 | $- |
| PM_VAL_FADE_LONG | 46 | 46 | 58.7% | $12.04 | [-7.5, 31.6] | $-14.04 | $26.09 | $15.1 | $7.3 | $16.3 | $-33.1 | $49.0 | $-1.0 | ACTIVE | 14 | $-9.0 |
| PM_VAL_FADE_SHORT | 48 | 48 | 41.7% | $-7.51 | [-28.3, 12.7] | $5.39 | $-12.90 | $-10.9 | $-3.2 | $-50.1 | $9.7 | $4.0 | $0.8 | ACTIVE | 13 | $7.1 |
| PW_HIGH_FADE_LONG | 84 | 84 | 48.8% | $3.42 | [-10.6, 17.3] | $-7.51 | $10.93 | $-3.1 | $13.5 | $-18.5 | $12.9 | $14.1 | $3.0 | ACTIVE | 0 | $- |
| PW_HIGH_FADE_SHORT | 126 | 126 | 37.3% | $-6.21 | [-18.2, 7.0] | $-3.17 | $-3.03 | $-0.6 | $-15.4 | $-9.2 | $11.8 | $-10.5 | $-20.7 | ACTIVE | 16 | $-7.8 |
| PW_LOW_FADE_LONG | 82 | 82 | 37.8% | $-4.18 | [-18.4, 12.4] | $-2.12 | $-2.05 | $-12.5 | $12.8 | $-10.3 | $3.9 | $-22.6 | $13.6 | ACTIVE | 19 | $-10.6 |
| PW_LOW_FADE_SHORT | 53 | 53 | 37.7% | $-4.96 | [-22.5, 14.0] | $5.04 | $-10.00 | $-7.3 | $-0.5 | $-21.3 | $-16.3 | $11.0 | $0.5 | ACTIVE | 22 | $18.2 |
| PW_POC_FADE_LONG | 110 | 110 | 46.4% | $-3.82 | [-17.5, 9.8] | $-0.98 | $-2.84 | $5.6 | $-20.3 | $2.3 | $-15.4 | $19.0 | $-24.8 | ACTIVE | 12 | $-0.5 |
| PW_POC_FADE_SHORT | 87 | 87 | 43.7% | $-8.48 | [-24.3, 6.8] | $4.71 | $-13.18 | $-13.1 | $1.8 | $-18.7 | $-6.4 | $4.0 | $-8.5 | ACTIVE | 11 | $-34.2 |
| PW_VAH_FADE_LONG | 106 | 106 | 35.8% | $-9.79 | [-23.0, 3.9] | $-4.53 | $-5.26 | $-22.6 | $6.3 | $-25.6 | $-22.1 | $1.3 | $5.4 | ACTIVE | 32 | $-22.4 |
| PW_VAH_FADE_SHORT | 132 | 132 | 44.7% | $-4.76 | [-17.5, 7.9] | $2.65 | $-7.41 | $-4.6 | $-5.0 | $-3.8 | $-2.6 | $-11.4 | $-0.2 | ACTIVE | 19 | $13.8 |
| PW_VAL_FADE_LONG | 99 | 99 | 44.4% | $-1.69 | [-16.4, 13.1] | $-0.39 | $-1.30 | $2.6 | $-8.8 | $-7.9 | $18.0 | $-5.4 | $-17.2 | ACTIVE | 34 | $-17.7 |
| PW_VAL_FADE_SHORT | 71 | 71 | 42.3% | $-5.64 | [-22.8, 12.0] | $2.65 | $-8.30 | $-8.6 | $-0.8 | $-9.5 | $1.2 | $-3.7 | $-13.2 | ACTIVE | 42 | $13.8 |
| WEEKLY_OPEN_FADE_LONG | 168 | 168 | 26.2% | $-5.88 | [-13.1, 2.3] | $-2.77 | $-3.10 | $-5.0 | $-7.5 | $-2.7 | $-7.5 | $-9.3 | $-1.8 | ACTIVE | 32 | $-22.4 |
| WEEKLY_OPEN_FADE_SHORT | 141 | 141 | 57.4% | $1.49 | [-9.1, 11.9] | $-4.47 | $5.96 | $-3.0 | $8.7 | $-10.0 | $12.7 | $0.9 | $6.3 | ACTIVE | 38 | $10.4 |
| WEEKLY_VWAP_FADE_LONG | 313 | 313 | 41.9% | $-10.40 | [-19.0, -2.3] | $6.66 | $-17.06 | $-10.3 | $-10.6 | $-16.7 | $-11.3 | $2.7 | $-22.0 | ACTIVE | 24 | $-1.3 |
| WEEKLY_VWAP_FADE_SHORT | 279 | 279 | 23.3% | $-9.09 | [-14.6, -3.2] | $3.26 | $-12.34 | $-7.4 | $-11.7 | $-2.5 | $-10.2 | $-13.8 | $-8.9 | ACTIVE | 32 | $2.3 |
| WPP_FADE_LONG | 127 | 127 | 44.1% | $-7.17 | [-17.4, 3.1] | $3.86 | $-11.03 | $-2.9 | $-11.9 | $-5.2 | $-1.4 | $-5.8 | $-15.5 | ACTIVE | 35 | $-4.4 |
| WPP_FADE_SHORT | 124 | 124 | 48.4% | $9.03 | [-4.0, 22.1] | $-3.73 | $12.77 | $-1.3 | $29.9 | $0.2 | $-4.2 | $20.6 | $26.7 | ACTIVE | 10 | $-42.2 |
| WR1_FADE_LONG | 51 | 51 | 35.3% | $-14.80 | [-34.8, 5.5] | $5.45 | $-20.25 | $-17.5 | $-11.2 | $-19.3 | $26.8 | $-30.9 | $-4.3 | ACTIVE | 8 | $1.5 |
| WR1_FADE_SHORT | 111 | 111 | 36.0% | $-9.89 | [-23.9, 4.2] | $4.10 | $-13.99 | $-6.4 | $-15.6 | $2.0 | $-7.0 | $-21.0 | $-11.8 | ACTIVE | 5 | $-12.0 |
| WR2_FADE_LONG | 20 | 20 | 50.0% | $3.00 | [-24.6, 30.6] | $-10.80 | $13.80 | $21.8 | $-20.0 | $16.8 | $3.0 | $10.7 | $-66.0 | ACTIVE | 5 | $72.8 |
| WR2_FADE_SHORT | 33 | 33 | 42.4% | $-7.45 | [-28.4, 17.6] | $5.09 | $-12.55 | $-9.5 | $-3.3 | $-20.0 | $-24.6 | $49.0 | $-14.3 | ACTIVE | 2 | $-127.0 |
| WS1_FADE_LONG | 86 | 86 | 47.7% | $8.37 | [-6.5, 24.2] | $-9.79 | $18.16 | $12.0 | $0.1 | $7.2 | $11.0 | $1.7 | $15.2 | ACTIVE | 20 | $25.4 |
| WS1_FADE_SHORT | 42 | 42 | 42.9% | $2.92 | [-18.7, 23.2] | $1.56 | $1.36 | $9.0 | $-9.3 | $21.1 | $-13.3 | $17.5 | $-3.2 | ACTIVE | 21 | $-4.5 |

---

## TASK B: Value-Area Traversal (Edge-to-Edge)

**Script:** `scratch/gemini_value_traversal.mjs`  
**Hypothesis:** Price re-entering the prior-day value area (`PD_VAH` / `PD_VAL`) travels across to the opposite value area boundary.  
**Placebo:** Identical band width $W = \text{VAH} - \text{VAL}$ shifted by $\pm 0.3, \pm 0.6 \times \text{ATR20}$.  
**Terciles computed on real events:**  
- **T1 (Narrow):** $W / \text{ATR20} \le 0.3398$  
- **T2 (Medium):** $0.3398 < W / \text{ATR20} \le 0.5271$  
- **T3 (Wide):** $W / \text{ATR20} > 0.5271$  

### Traversal Performance vs Placebo

| Re-Entry Type | Tercile | Real N (Days) | Real Reach% (Med Mins) | Placebo Reach% (Med Mins) | Difference (Real - Plac) | 95% Day-Blocked CI |
|---|---|---|---|---|---|---|
| **FROM ABOVE** | **Overall** | **414 (414)** | **38.9% (40.0m)** | **38.5% (44.0m)** | **+0.38%** | **[-4.08%, +5.06%]** |
| FROM ABOVE | T1 (Narrow) | 137 (137) | 53.3% (19.0m) | 59.9% (24.0m) | -6.60% | [-15.37%, +2.34%] |
| FROM ABOVE | T2 (Medium) | 135 (135) | 43.7% (75.0m) | 40.8% (53.0m) | +2.89% | [-5.97%, +11.51%] |
| FROM ABOVE | T3 (Wide) | 142 (142) | 20.4% (128.0m) | 21.1% (96.0m) | -0.71% | [-6.41%, +5.04%] |
| **FROM BELOW** | **Overall** | **340 (340)** | **41.8% (50.5m)** | **36.4% (70.0m)** | **+5.32%** | **[+0.00%, +10.58%]** |
| FROM BELOW | T1 (Narrow) | 116 (116) | 68.1% (39.0m) | 55.8% (39.0m) | +12.27% | [+2.13%, +22.28%] |
| FROM BELOW | T2 (Medium) | 116 (116) | 33.6% (55.0m) | 33.7% (85.0m) | -0.05% | [-9.53%, +9.03%] |
| FROM BELOW | T3 (Wide) | 108 (108) | 22.2% (152.5m) | 22.7% (132.0m) | -0.44% | [-7.50%, +7.56%] |
| **POOLED** | **Overall** | **754 (562)** | **40.2% (46.0m)** | **37.5% (57.0m)** | **+2.70%** | **[-0.90%, +6.34%]** |
| POOLED | T1 (Narrow) | 253 (165) | 60.1% (29.5m) | 57.8% (26.5m) | +2.25% | [-4.06%, +8.68%] |
| POOLED | T2 (Medium) | 251 (185) | 39.0% (59.5m) | 37.1% (68.0m) | +1.90% | [-4.75%, +8.32%] |
| POOLED | T3 (Wide) | 250 (212) | 21.2% (137.0m) | 21.9% (109.5m) | -0.65% | [-5.69%, +4.44%] |

### Plain-English Verdict for Task B
1. **Value-Area Traversal Edge is NOT Supported Overall:** The aggregate edge-to-edge traversal probability is **40.2%**, which exceeds the shifted placebo bands (**37.5%**) by only **+2.70%** (95% CI: `[-0.90%, +6.34%]`). Because the confidence interval encompasses zero, there is no statistically distinguishable structural effect across the broad distribution of value areas.
2. **The Narrow-Band Illusion:** In narrow value areas (T1), reach probability is elevated (**60.1%**), but shifted placebo bands of the same narrow width also reach the other edge **57.8%** of the time. This confirms that higher traversal in narrow value areas is a geometric artifact of random walk excursions over smaller price intervals, not market auction magnetism.
3. **Asymmetric Re-Entry From Below:** A mild anomaly appears when re-entering from below in narrow bands (+12.27% over placebo, CI `[+2.13%, +22.28%]`), likely correlated with the general intraday upward drift of equity futures, but disappears completely in medium and wide bands.

---

## TASK C: Early-Globex Rotation Direction as a Session Bias

**Script:** `scratch/gemini_early_globex_rotation.mjs`  
**Leg Definition:** Intrabar high - running low $\ge 65$ confirms UP; running high - intrabar low $\ge 65$ confirms DOWN. First confirmed leg of session.  
**Session Scope:** 18:00 ET prior calendar trading evening through 09:29 ET trade date $D$.  
- Total valid trade dates: 854.  
- Dropped for sparse data (<90% of expected 930 minutes): 1 session (2024-05-28 post-Memorial Day).  
- No 65-point leg confirmed before 09:29: 27 sessions.  
- **Group A (Confirmed $\le$ 18:10):** **130 sessions** (68 UP, 62 DOWN).  
- **Control Group (Confirmed > 18:10):** **696 sessions** (342 UP, 354 DOWN).  

### Outcome Performance (Signed by Direction $D$ in $\text{ATR20}$ Units)

| Metric | Group A (N=130) | Permutation Null (Group A) | Control Group (Own C0, N=696) | Control Group (18:10 Clock, N=696) |
|---|---|---|---|---|
| **Outcome 1 (C0 $\to$ 09:29 Close)** | **+0.1025 ATR** | +0.0032 ATR | +0.0425 ATR | +0.2206 ATR |
| 95% Confidence Interval | [+0.0013, +0.2129] | [-0.1067, +0.1143] | [+0.0117, +0.0729] | [+0.1878, +0.2530] |
| $p$-value vs Permutation Null | **$p = 0.0725$** | - | - | - |
| Fraction on $D$-side at 09:29 | **55.4%** (72/130) | 50.0% | 52.9% (368/696) | - |
| **Outcome 2 (09:30 Open $\to$ 15:59 Close RTH)** | **-0.0898 ATR** | +0.0068 ATR | +0.0117 ATR | +0.0117 ATR |
| 95% Confidence Interval | [-0.2388, +0.0464] | [-0.1385, +0.1478] | [-0.0454, +0.0618] | [-0.0454, +0.0618] |
| $p$-value vs Permutation Null | **$p = 0.2355$** | - | - | - |

### Overnight Drift and Directional Asymmetry Analysis

| Cohort | N | Outcome 1 Mean (ATR) | 95% Day-Blocked CI | Fraction on $D$-side |
|---|---|---|---|---|
| **Unconditional Overnight Drift (18:10 $\to$ 09:29)** | 826 | **+0.0444 ATR** | [+0.0108, +0.0786] | 55.7% Positive |
| Group A UP Rotations | 68 | **+0.1966 ATR** | [+0.0623, +0.3486] | 58.8% (40/68) |
| Group A DOWN Rotations | 62 | **-0.0007 ATR** | [-0.1610, +0.1720] | 51.6% (32/62) |

### Plain-English Verdict for Task C
1. **Early-Globex Rotation Direction Does NOT Create a Predictive Session Bias:**
   - **Overnight Continuation (Outcome 1):** The observed move of **+0.1025 ATR** for Group A fails statistical significance against the permutation null ($p = 0.0725$).
   - **Directional Asymmetry Explained by Overnight Drift:** When disaggregated by direction, Group A UP rotations gained +0.1966 ATR, but DOWN rotations showed essentially zero continuation (-0.0007 ATR, win rate 51.6% — indistinguishable from a coin flip). This asymmetry aligns with the market's structural unconditional overnight drift (+0.0444 ATR). An early UP rotation simply aligns with the positive drift of equity index futures; an early DOWN rotation fights the drift and immediately stalls.
   - **RTH Continuation (Outcome 2) Reverses:** During the subsequent RTH session (09:30–15:59), Group A directional continuation is **negative (-0.0898 ATR)** with $p = 0.2355$. Early Globex momentum does not carry into RTH; if anything, intraday mean reversion slightly dominates.
