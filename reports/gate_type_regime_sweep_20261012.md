# Portfolio Risk Gate vs Setup Type Regime Sweep (2026-10-12)

**Date:** 2026-10-12
**Data Scope:** `active_setups` real trades (`REAL_TRADE_FILTER`, `actual_pnl IS NOT NULL`, `resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')`).
**Methodology:** Day-blocked bootstrap resampling on delta = `mean(BLOCKED) - mean(UNBLOCKED)` (2,000 iterations via `dayBlockedBootstrapDeltaCI`). Day-clustering threshold <= 50% top-5 day concentration via `computeRigor`.

## 1. Summary of Candidates for Exemption (GATE_HURTS_THIS_TYPE)

*No (setup_type, gate) pairs cleared all three hurdles simultaneously (N_blocked >= 10, 95% CI strictly excluding zero with delta > 0, and top5DayPct <= 50%).*

## 2. Per-Gate Detailed Breakdown Tables

### Gate: `OPPOSITE_DIRECTION_OPEN` (Opposite Direction Open)

Total affected setup_types with N_blocked >= 1: **49**

| setup_type | N_blocked | N_unblocked | mean_blocked | mean_unblocked | delta | CI_lo | CI_hi | top5DayPct_blocked | verdict |
|---|---|---|---|---|---|---|---|---|---|
| `10D_IB_MID_FADE_LONG` | 2 | 22 | $74.00 | $-5.36 | +$79.36 | $37.89 | $103.26 | 100% | INDETERMINATE |
| `2D_POC_FADE_LONG` | 1 | 14 | $-182.00 | $3.71 | $-185.71 | $-238.33 | $-115.56 | 100% | INDETERMINATE |
| `5D_OR_MID_FADE_SHORT` | 1 | 28 | $78.00 | $-11.14 | +$89.14 | $72.97 | $112.32 | 100% | INDETERMINATE |
| `CAM_R1_FADE_LONG` | 2 | 49 | $60.50 | $-2.84 | +$63.34 | $23.74 | $100.31 | 100% | INDETERMINATE |
| `CAM_R2_FADE_LONG` | 1 | 41 | $78.00 | $-15.90 | +$93.90 | $60.78 | $126.37 | 100% | INDETERMINATE |
| `CAM_R4_FADE_SHORT` | 3 | 23 | $-72.00 | $14.52 | $-86.52 | $-113.86 | $-51.50 | 100% | INDETERMINATE |
| `CAM_S1_FADE_LONG` | 1 | 48 | $-60.00 | $10.29 | $-70.29 | $-87.40 | $-53.00 | 100% | INDETERMINATE |
| `CAM_S1_FADE_SHORT` | 1 | 34 | $-76.00 | $-30.09 | $-45.91 | $-77.73 | $-21.06 | 100% | INDETERMINATE |
| `CAM_S4_FADE_LONG` | 1 | 24 | $-76.00 | $-14.42 | $-61.58 | $-91.63 | $-40.57 | 100% | INDETERMINATE |
| `FLOOR_PIVOT_FADE_LONG` | 3 | 48 | $-48.67 | $-0.75 | $-47.92 | $-77.79 | $-18.72 | 100% | INDETERMINATE |
| `FLOOR_PIVOT_FADE_SHORT` | 1 | 55 | $-36.00 | $-17.16 | $-18.84 | $-45.23 | $-2.42 | 100% | INDETERMINATE |
| `FLOOR_R2_FADE_LONG` | 2 | 19 | $1.00 | $-32.08 | +$33.08 | $-46.50 | $69.10 | 100% | INDETERMINATE |
| `FLOOR_R2_FADE_SHORT` | 1 | 27 | $-76.00 | $3.26 | $-79.26 | $-96.45 | $-60.20 | 100% | INDETERMINATE |
| `GLOBEX_VWAP_FADE_SHORT` | 6 | 189 | $36.67 | $-1.55 | +$38.21 | $5.73 | $97.20 | 100% | INDETERMINATE |
| `IB_HIGH_FADE_SHORT` | 1 | 90 | $98.00 | $21.04 | +$76.96 | $61.00 | $91.57 | 100% | INDETERMINATE |
| `IB_LOW_FADE_LONG` | 4 | 54 | $58.00 | $29.35 | +$28.65 | $-81.20 | $89.19 | 100% | INDETERMINATE |
| `IB_MID_SCALP_FADE_LONG` | 2 | 99 | $-46.00 | $-1.57 | $-44.43 | $-63.31 | $-25.06 | 100% | INDETERMINATE |
| `IB_MID_SCALP_FADE_SHORT` | 3 | 97 | $8.67 | $5.55 | +$3.11 | $-43.89 | $76.43 | 100% | INDETERMINATE |
| `MONTHLY_OPEN_FADE_LONG_OVERNIGHT` | 2 | 7 | $-92.00 | $23.71 | $-115.71 | $-180.00 | $0.00 | 100% | INDETERMINATE |
| `MR1_FADE_SHORT_OVERNIGHT` | 1 | 6 | $178.00 | $-92.00 | +$270.00 | $270.00 | $270.00 | 100% | INDETERMINATE |
| `ONH_FADE_LONG` | 2 | 36 | $-17.00 | $-9.11 | $-7.89 | $-48.89 | $15.12 | 100% | INDETERMINATE |
| `ONH_FADE_SHORT` | 2 | 46 | $15.00 | $-10.57 | +$25.57 | $-4.85 | $46.67 | 100% | INDETERMINATE |
| `OR10_HIGH_FADE_SHORT` | 2 | 36 | $-76.00 | $5.89 | $-81.89 | $-103.41 | $-48.08 | 100% | INDETERMINATE |
| `OR10_LOW_FADE_LONG` | 2 | 30 | $21.00 | $-13.60 | +$34.60 | $-1.60 | $66.33 | 100% | INDETERMINATE |
| `OR10_LOW_FADE_SHORT` | 1 | 23 | $-72.00 | $-3.04 | $-68.96 | $-101.52 | $-30.38 | 100% | INDETERMINATE |
| `OR10_MID_FADE_LONG` | 1 | 29 | $-72.00 | $10.97 | $-82.97 | $-112.07 | $-52.27 | 100% | INDETERMINATE |
| `OR15_HIGH_FADE_SHORT` | 1 | 33 | $-72.00 | $5.15 | $-77.15 | $-103.75 | $-51.78 | 100% | INDETERMINATE |
| `OR15_LOW_FADE_LONG` | 1 | 25 | $84.00 | $14.64 | +$69.36 | $49.07 | $86.33 | 100% | INDETERMINATE |
| `OR15_MID_FADE_LONG` | 2 | 31 | $18.00 | $2.06 | +$15.94 | $-13.00 | $48.09 | 100% | INDETERMINATE |
| `OR30_HIGH_FADE_SHORT` | 6 | 33 | $43.67 | $16.24 | +$27.42 | $3.10 | $65.85 | 100% | INDETERMINATE |
| `OR30_MID_FADE_LONG` | 1 | 25 | $-72.00 | $6.40 | $-78.40 | $-111.36 | $-42.70 | 100% | INDETERMINATE |
| `OR5_MID_FADE_LONG` | 3 | 78 | $0.67 | $9.42 | $-8.76 | $-69.68 | $25.97 | 100% | INDETERMINATE |
| `PD_IB_MID_FADE_SHORT` | 1 | 38 | $-52.00 | $16.97 | $-68.97 | $-91.58 | $-39.57 | 100% | INDETERMINATE |
| `PD_POC_FADE_LONG` | 4 | 106 | $-14.50 | $-0.50 | $-14.00 | $-29.64 | $8.16 | 100% | INDETERMINATE |
| `PD_SESSION_MID_FADE_LONG` | 1 | 38 | $78.00 | $-16.34 | +$94.34 | $81.00 | $120.71 | 100% | INDETERMINATE |
| `PD_VAH_FADE_SHORT` | 2 | 148 | $11.00 | $5.79 | +$5.21 | $-6.91 | $16.12 | 100% | INDETERMINATE |
| `PD_VAL_FADE_LONG` | 3 | 109 | $-17.33 | $1.76 | $-19.09 | $-87.97 | $97.12 | 100% | INDETERMINATE |
| `PM_HIGH_FADE_LONG` | 3 | 16 | $-22.00 | $-13.50 | $-8.50 | $-67.71 | $28.80 | 100% | INDETERMINATE |
| `PM_HIGH_FADE_LONG_OVERNIGHT` | 2 | 6 | $43.00 | $-92.00 | +$135.00 | $135.00 | $135.00 | 100% | INDETERMINATE |
| `PW_VAH_FADE_LONG` | 1 | 31 | $74.00 | $-25.52 | +$99.52 | $57.69 | $122.12 | 100% | INDETERMINATE |
| `PW_VAL_FADE_LONG` | 1 | 29 | $74.00 | $-22.34 | +$96.34 | $68.86 | $139.13 | 100% | INDETERMINATE |
| `PW_VAL_SWEEP_REVERSAL_SHORT_OVERNIGHT` | 1 | 0 | $-92.00 | N/A | N/A | N/A | N/A | 100% | INDETERMINATE |
| `RTH_VWAP_FADE_LONG` | 5 | 122 | $0.00 | $-5.25 | +$5.25 | $-50.46 | $27.00 | 100% | INDETERMINATE |
| `RTH_VWAP_FADE_SHORT` | 1 | 104 | $-78.00 | $-12.58 | $-65.42 | $-92.33 | $-41.45 | 100% | INDETERMINATE |
| `STACK_VOL_BREAK_LIVE_LONG` | 6 | 13 | $-18.43 | $2.11 | $-20.54 | $-136.42 | $120.88 | 100% | INDETERMINATE |
| `STACK_VOL_BREAK_LIVE_SHORT` | 4 | 30 | $-41.75 | $-28.29 | $-13.46 | $-73.04 | $32.00 | 100% | INDETERMINATE |
| `WEEKLY_OPEN_FADE_LONG` | 1 | 31 | $-36.00 | $-21.94 | $-14.06 | $-32.65 | $7.25 | 100% | INDETERMINATE |
| `WEEKLY_OPEN_FADE_SHORT` | 4 | 34 | $36.50 | $7.29 | +$29.21 | $-4.58 | $53.83 | 100% | INDETERMINATE |
| `WPP_FADE_LONG` | 3 | 29 | $58.00 | $-5.72 | +$63.72 | $36.69 | $84.85 | 100% | INDETERMINATE |

### Gate: `ROTATION_DIRECTION_CONFLICT` (Rotation Direction Conflict (65pt))

Total affected setup_types with N_blocked >= 1: **6**

| setup_type | N_blocked | N_unblocked | mean_blocked | mean_unblocked | delta | CI_lo | CI_hi | top5DayPct_blocked | verdict |
|---|---|---|---|---|---|---|---|---|---|
| `GLOBEX_VWAP_MAGNET_LONG` | 3 | 143 | $58.00 | $-4.57 | +$62.57 | $51.82 | $77.70 | 100% | INDETERMINATE |
| `OR5_LOW_FADE_SHORT` | 1 | 89 | $78.00 | $-2.76 | +$80.76 | $64.83 | $93.82 | 100% | INDETERMINATE |
| `PM_HIGH_FADE_LONG_OVERNIGHT` | 1 | 7 | $-92.00 | $-53.43 | $-38.57 | $-135.00 | $0.00 | 100% | INDETERMINATE |
| `PW_POC_FADE_SHORT_OVERNIGHT` | 1 | 17 | $178.00 | $35.06 | +$142.94 | $54.00 | $222.35 | 100% | INDETERMINATE |
| `PW_VAL_FADE_SHORT` | 1 | 37 | $78.00 | $8.41 | +$69.59 | $50.00 | $100.53 | 100% | INDETERMINATE |
| `WEEKLY_VWAP_FADE_SHORT_OVERNIGHT` | 2 | 18 | $130.00 | $-2.00 | +$132.00 | $63.18 | $190.24 | 100% | INDETERMINATE |

### Gate: `SAME_TYPE_REFIRE` (Same-Type Refire Gate)

Total affected setup_types with N_blocked >= 1: **13**

| setup_type | N_blocked | N_unblocked | mean_blocked | mean_unblocked | delta | CI_lo | CI_hi | top5DayPct_blocked | verdict |
|---|---|---|---|---|---|---|---|---|---|
| `CAM_R2_FADE_SHORT` | 1 | 42 | $-50.00 | $5.05 | $-55.05 | $-105.77 | $-10.58 | 100% | INDETERMINATE |
| `GLOBEX_VWAP_FADE_SHORT` | 5 | 190 | $26.00 | $-1.07 | +$27.07 | $-58.29 | $52.64 | 100% | INDETERMINATE |
| `IB_HIGH_FADE_LONG` | 1 | 59 | $-40.00 | $-14.08 | $-25.92 | $-42.19 | $-9.32 | 100% | INDETERMINATE |
| `IB_HIGH_FADE_SHORT` | 1 | 90 | $98.00 | $21.04 | +$76.96 | $60.29 | $91.81 | 100% | INDETERMINATE |
| `IB_MID_SCALP_FADE_SHORT` | 1 | 99 | $-26.00 | $5.97 | $-31.97 | $-46.54 | $-18.21 | 100% | INDETERMINATE |
| `OR30_HIGH_FADE_LONG` | 2 | 28 | $1.00 | $-4.00 | +$5.00 | $-14.19 | $41.39 | 100% | INDETERMINATE |
| `OR30_HIGH_FADE_SHORT` | 1 | 38 | $58.00 | $19.47 | +$38.53 | $18.65 | $62.00 | 100% | INDETERMINATE |
| `PM_HIGH_FADE_SHORT` | 1 | 11 | $72.00 | $-30.55 | +$102.55 | $78.86 | $102.55 | 100% | INDETERMINATE |
| `RTH_VWAP_FADE_LONG` | 1 | 126 | $-52.00 | $-4.67 | $-47.33 | $-57.39 | $-36.55 | 100% | INDETERMINATE |
| `STACK_VOL_BREAK_LIVE_SHORT` | 1 | 33 | $-93.60 | $-27.94 | $-65.66 | $-88.02 | $-30.71 | 100% | INDETERMINATE |
| `WEEKLY_OPEN_FADE_LONG` | 1 | 31 | $-76.00 | $-20.65 | $-55.35 | $-71.41 | $-30.67 | 100% | INDETERMINATE |
| `WEEKLY_OPEN_FADE_SHORT` | 1 | 37 | $-64.00 | $12.38 | $-76.38 | $-94.90 | $-43.38 | 100% | INDETERMINATE |
| `WR1_FADE_LONG` | 1 | 7 | $-76.00 | $12.57 | $-88.57 | $-129.00 | $-50.00 | 100% | INDETERMINATE |

### Gate: `CROSS_DIRECTION_FAST_FLIP` (Cross-Direction Fast Flip (<N>min))

Total affected setup_types with N_blocked >= 1: **25**

| setup_type | N_blocked | N_unblocked | mean_blocked | mean_unblocked | delta | CI_lo | CI_hi | top5DayPct_blocked | verdict |
|---|---|---|---|---|---|---|---|---|---|
| `5D_OR_MID_FADE_LONG` | 1 | 21 | $-76.00 | $7.81 | $-83.81 | $-123.43 | $-52.52 | 100% | INDETERMINATE |
| `CAM_R3_FADE_LONG` | 1 | 21 | $-76.00 | $-32.29 | $-43.71 | $-61.41 | $-20.00 | 100% | INDETERMINATE |
| `FLOOR_PIVOT_FADE_SHORT` | 1 | 55 | $-42.00 | $-17.05 | $-24.95 | $-45.47 | $-6.28 | 100% | INDETERMINATE |
| `FLOOR_S2_FADE_SHORT` | 1 | 19 | $78.00 | $-17.26 | +$95.26 | $67.53 | $123.78 | 100% | INDETERMINATE |
| `FLOOR_S3_FADE_LONG` | 2 | 19 | $1.00 | $6.42 | $-5.42 | $-128.38 | $105.48 | 100% | INDETERMINATE |
| `GLOBEX_VWAP_FADE_LONG` | 14 | 204 | $-30.86 | $-8.09 | $-22.76 | $-61.75 | $23.86 | 50% | INDETERMINATE |
| `GLOBEX_VWAP_FADE_SHORT` | 10 | 185 | $-10.80 | $0.19 | $-10.99 | $-55.32 | $40.07 | 80% | INDETERMINATE |
| `IB_HIGH_FADE_LONG` | 1 | 59 | $-40.00 | $-14.08 | $-25.92 | $-46.06 | $-11.05 | 100% | INDETERMINATE |
| `IB_MID_SCALP_FADE_LONG` | 1 | 100 | $-50.00 | $-1.97 | $-48.03 | $-63.61 | $-29.48 | 100% | INDETERMINATE |
| `IB_MID_SCALP_FADE_SHORT` | 1 | 99 | $-26.00 | $5.97 | $-31.97 | $-46.97 | $-18.76 | 100% | INDETERMINATE |
| `ONH_FADE_SHORT` | 1 | 47 | $-48.00 | $-8.68 | $-39.32 | $-62.76 | $-11.80 | 100% | INDETERMINATE |
| `OR10_LOW_FADE_LONG` | 1 | 31 | $78.00 | $-14.32 | +$92.32 | $60.43 | $123.32 | 100% | INDETERMINATE |
| `OR15_LOW_FADE_LONG` | 1 | 25 | $84.00 | $14.64 | +$69.36 | $48.90 | $87.54 | 100% | INDETERMINATE |
| `OR30_HIGH_FADE_LONG` | 1 | 29 | $-76.00 | $-1.17 | $-74.83 | $-93.21 | $-45.67 | 100% | INDETERMINATE |
| `OR30_HIGH_FADE_SHORT` | 3 | 36 | $80.67 | $15.44 | +$65.22 | $39.77 | $104.00 | 100% | INDETERMINATE |
| `OR30_MID_FADE_LONG` | 1 | 25 | $-64.00 | $6.08 | $-70.08 | $-98.81 | $-33.19 | 100% | INDETERMINATE |
| `OR30_MID_FADE_SHORT` | 1 | 20 | $86.00 | $24.30 | +$61.70 | $29.86 | $99.38 | 100% | INDETERMINATE |
| `OR5_HIGH_FADE_SHORT` | 1 | 72 | $-72.00 | $-5.00 | $-67.00 | $-90.05 | $-43.27 | 100% | INDETERMINATE |
| `OR5_LOW_FADE_SHORT` | 1 | 89 | $78.00 | $-2.76 | +$80.76 | $68.54 | $94.82 | 100% | INDETERMINATE |
| `OR5_MID_FADE_LONG` | 1 | 80 | $-48.00 | $9.81 | $-57.81 | $-71.51 | $-44.00 | 100% | INDETERMINATE |
| `OR5_MID_FADE_SHORT` | 1 | 82 | $-46.00 | $-5.70 | $-40.30 | $-53.04 | $-27.00 | 100% | INDETERMINATE |
| `PD_IB_MID_FADE_SHORT` | 1 | 38 | $118.00 | $12.50 | +$105.50 | $82.00 | $135.38 | 100% | INDETERMINATE |
| `PD_POC_FADE_LONG` | 4 | 106 | $-18.50 | $-0.35 | $-18.15 | $-60.61 | $71.09 | 100% | INDETERMINATE |
| `PD_POC_FADE_SHORT` | 4 | 59 | $-96.00 | $-22.64 | $-73.36 | $-100.00 | $-40.16 | 100% | INDETERMINATE |
| `WEEKLY_OPEN_FADE_SHORT` | 1 | 37 | $-64.00 | $12.38 | $-76.38 | $-93.54 | $-43.46 | 100% | INDETERMINATE |

### Gate: `POST_WIN_OPP_FAMILY_REV` (Post-Win Opposite Family Reversal)

Total affected setup_types with N_blocked >= 1: **2**

| setup_type | N_blocked | N_unblocked | mean_blocked | mean_unblocked | delta | CI_lo | CI_hi | top5DayPct_blocked | verdict |
|---|---|---|---|---|---|---|---|---|---|
| `GLOBEX_VWAP_FADE_LONG` | 5 | 213 | $-36.80 | $-8.92 | $-27.88 | $-95.62 | $60.30 | 100% | INDETERMINATE |
| `GLOBEX_VWAP_FADE_SHORT` | 5 | 190 | $-4.80 | $-0.26 | $-4.54 | $-70.16 | $90.28 | 100% | INDETERMINATE |

### Gate: `OPENING_DRIVE_COUNTER` (Opening Drive Counter)

Total affected setup_types with N_blocked >= 1: **0**

*Zero rows recorded in active_setups under this suppression reason.*

## 3. Bet Class / Family Pooling

### Gate: `OPPOSITE_DIRECTION_OPEN` - Pooled by bet_class

| bet_class | N_blocked | N_unblocked | mean_blocked | mean_unblocked | delta | CI_lo | CI_hi | top5DayPct_blocked | verdict | consistency |
|---|---|---|---|---|---|---|---|---|---|---|
| `GLOBEX_LEVEL` | 20 | 1259 | $1.10 | $-6.34 | +$7.44 | $-33.19 | $49.62 | 90% | INDETERMINATE | MIXED (4 pos, 3 neg) |
| `VALUE_FADE` | 76 | 4740 | $2.86 | $-3.50 | +$6.35 | $-3.05 | $16.59 | 77.6% | INDETERMINATE | MIXED (19 pos, 20 neg) |
| `CONTINUATION_LEGACY` | 10 | 678 | $-27.76 | $-1.82 | $-25.94 | $-88.50 | $16.71 | 90% | INDETERMINATE | ALL_NEGATIVE |

### Gate: `ROTATION_DIRECTION_CONFLICT` - Pooled by bet_class

| bet_class | N_blocked | N_unblocked | mean_blocked | mean_unblocked | delta | CI_lo | CI_hi | top5DayPct_blocked | verdict | consistency |
|---|---|---|---|---|---|---|---|---|---|---|
| `GLOBEX_LEVEL` | 7 | 1272 | $74.29 | $-6.66 | +$80.95 | $75.99 | $86.25 | 100% | INDETERMINATE | MIXED (3 pos, 1 neg) |
| `VALUE_FADE` | 2 | 4814 | $78.00 | $-3.43 | +$81.43 | $78.05 | $84.87 | 100% | INDETERMINATE | ALL_POSITIVE |

### Gate: `SAME_TYPE_REFIRE` - Pooled by bet_class

| bet_class | N_blocked | N_unblocked | mean_blocked | mean_unblocked | delta | CI_lo | CI_hi | top5DayPct_blocked | verdict | consistency |
|---|---|---|---|---|---|---|---|---|---|---|
| `GLOBEX_LEVEL` | 5 | 1274 | $26.00 | $-6.35 | +$32.35 | $-48.68 | $54.95 | 100% | INDETERMINATE | SINGLE_TYPE |
| `VALUE_FADE` | 12 | 4804 | $-12.83 | $-3.37 | $-9.46 | $-34.79 | $49.58 | 91.7% | INDETERMINATE | MIXED (4 pos, 7 neg) |
| `CONTINUATION_LEGACY` | 1 | 687 | $-93.60 | $-2.06 | $-91.54 | $-102.41 | $-81.41 | 100% | INDETERMINATE | SINGLE_TYPE |

### Gate: `CROSS_DIRECTION_FAST_FLIP` - Pooled by bet_class

| bet_class | N_blocked | N_unblocked | mean_blocked | mean_unblocked | delta | CI_lo | CI_hi | top5DayPct_blocked | verdict | consistency |
|---|---|---|---|---|---|---|---|---|---|---|
| `GLOBEX_LEVEL` | 32 | 1247 | $-31.19 | $-5.58 | $-25.61 | $-50.90 | $4.75 | 46.9% | INDETERMINATE | ALL_NEGATIVE |
| `VALUE_FADE` | 24 | 4792 | $1.58 | $-3.42 | +$5.00 | $-14.21 | $17.15 | 66.7% | INDETERMINATE | MIXED (7 pos, 14 neg) |

### Gate: `POST_WIN_OPP_FAMILY_REV` - Pooled by bet_class

| bet_class | N_blocked | N_unblocked | mean_blocked | mean_unblocked | delta | CI_lo | CI_hi | top5DayPct_blocked | verdict | consistency |
|---|---|---|---|---|---|---|---|---|---|---|
| `GLOBEX_LEVEL` | 10 | 1269 | $-20.80 | $-6.11 | $-14.69 | $-59.31 | $31.92 | 90% | INDETERMINATE | ALL_NEGATIVE |

### Gate: `OPENING_DRIVE_COUNTER` - Pooled by bet_class

*No rows.*

## 4. SAME_TYPE_REFIRE Dedicated Analysis

Total types with SAME_TYPE_REFIRE blocked trades: **13**
- Types with negative delta (blocked trades performed worse, consistent with refire penalty): **8** (61.5%)
- Types with positive delta (blocked trades performed better, inverted): **5** (38.5%)

