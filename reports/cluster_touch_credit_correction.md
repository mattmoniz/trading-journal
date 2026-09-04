# Cluster Touch Credit Dryrun Correction

## Population Summary
- Winner rows scanned: 1292
- Globex-origin rows excluded: 190
- Sibling-name instances found: 3574
- Exclusions:
  - Gap-conditioned: 118
  - _TRAIL-base diversion: 148
  - Not-reconstructable base/price: 1067
  - Already covered (dedup): 697
  - Sweep reversal artifact: 0
  - Globex-only name: 0
  - Unrecognized name: 4
  - No real fire precedent: 212
- Total backfillable rows: 1328

## Results Table
| Setup Type | Backfill N | Real N (Before -> After) | Distinct Days (Before -> After) | Clears N>=20? | Backfill WR / EV | Combined WR / EV |
|---|---|---|---|---|---|---|
| RTH_VWAP_FADE_LONG | 74 | 27 -> 101 | 13 -> 17 | NO | 50.0% / $15.00 | 44.6% / $7.94 |
| RTH_VWAP_FADE_SHORT | 64 | 18 -> 82 | 8 -> 12 | NO | 50.0% / $3.00 | 43.9% / $-8.96 |
| CAM_R1_FADE_SHORT | 43 | 2 -> 45 | 2 -> 8 | NO | 32.6% / $-25.21 | 35.6% / $-20.58 |
| PD_OR_MID_FADE_LONG | 43 | 5 -> 48 | 5 -> 9 | NO | 14.0% / $-53.67 | 20.8% / $-43.17 |
| PD_VAL_FADE_SHORT | 40 | 14 -> 54 | 7 -> 11 | NO | 27.5% / $-34.75 | 35.2% / $-19.23 |
| CAM_R2_FADE_SHORT | 38 | 3 -> 41 | 3 -> 8 | NO | 57.9% / $14.32 | 56.1% / $11.46 |
| PD_CLOSE_FADE_SHORT | 34 | 5 -> 39 | 3 -> 7 | NO | 58.8% / $13.76 | 56.4% / $13.41 |
| OR5_HIGH_FADE_LONG | 33 | 20 -> 53 | 12 -> 18 | NO | 36.4% / $-21.45 | 39.6% / $-14.58 |
| CAM_R1_FADE_LONG | 30 | 2 -> 32 | 2 -> 9 | NO | 53.3% / $7.47 | 53.1% / $8.47 |
| MONTHLY_VWAP_FADE_SHORT | 29 | 2 -> 31 | 2 -> 5 | NO | 10.3% / $-31.52 | 9.7% / $-33.23 |
| PD_HIGH_FADE_SHORT | 28 | 4 -> 32 | 2 -> 9 | NO | 64.3% / $24.29 | 62.5% / $18.50 |
| CAM_R2_FADE_LONG | 27 | 3 -> 30 | 3 -> 8 | NO | 29.6% / $-31.56 | 30.0% / $-30.93 |
| IB_MID_SCALP_FADE_LONG | 26 | 29 -> 55 | 16 -> 20 | YES | 46.2% / $-6.77 | 45.5% / $-13.72 |
| FLOOR_PIVOT_FADE_SHORT | 26 | 10 -> 36 | 6 -> 10 | NO | 38.5% / $-18.31 | 36.1% / $-20.15 |
| PD_CLOSE_FADE_LONG | 25 | 10 -> 35 | 6 -> 11 | NO | 44.0% / $-10.00 | 45.7% / $-2.51 |
| ONH_FADE_SHORT | 25 | 7 -> 32 | 4 -> 8 | NO | 48.0% / $-4.00 | 46.9% / $-4.13 |
| MONTHLY_VWAP_FADE_LONG | 25 | 1 -> 26 | 1 -> 3 | NO | 44.0% / $51.28 | 42.3% / $46.85 |
| PD_IB_LOW_FADE_LONG | 24 | 5 -> 29 | 1 -> 8 | NO | 20.8% / $-44.75 | 24.1% / $-38.90 |
| CAM_S4_FADE_SHORT | 24 | 3 -> 27 | 3 -> 5 | NO | 62.5% / $22.50 | 59.3% / $10.81 |
| PW_VAH_FADE_LONG | 24 | 7 -> 31 | 3 -> 5 | NO | 20.8% / $-38.83 | 25.8% / $-33.23 |
| FLOOR_PIVOT_FADE_LONG | 23 | 10 -> 33 | 6 -> 10 | NO | 47.8% / $-4.26 | 51.5% / $4.38 |
| PD_OR_MID_FADE_SHORT | 23 | 11 -> 34 | 8 -> 11 | NO | 26.1% / $-34.26 | 35.3% / $-21.43 |
| PD_HIGH_FADE_LONG | 22 | 3 -> 25 | 3 -> 7 | NO | 40.9% / $-14.64 | 40.0% / $-14.20 |
| ONH_FADE_LONG | 22 | 16 -> 38 | 5 -> 7 | NO | 50.0% / $-1.00 | 42.1% / $-2.34 |
| FLOOR_S1_FADE_SHORT | 21 | 3 -> 24 | 2 -> 4 | NO | 85.7% / $60.57 | 79.2% / $49.92 |
| CAM_S1_FADE_LONG | 21 | 12 -> 33 | 5 -> 9 | NO | 57.1% / $9.71 | 57.6% / $10.73 |
| OR5_HIGH_FADE_SHORT | 21 | 55 -> 76 | 31 -> 32 | NO | 38.1% / $19.33 | 42.1% / $20.43 |
| PD_IB_LOW_FADE_SHORT | 20 | 3 -> 23 | 1 -> 8 | NO | 75.0% / $36.50 | 69.6% / $30.30 |
| CAM_R4_FADE_LONG | 20 | 1 -> 21 | 1 -> 3 | NO | 45.0% / $-4.00 | 42.9% / $-7.43 |
| PD_VAH_FADE_LONG | 20 | 23 -> 43 | 10 -> 12 | NO | 20.0% / $-46.00 | 46.5% / $-5.03 |
| PD_SESSION_MID_FADE_SHORT | 20 | 11 -> 31 | 3 -> 6 | NO | 30.0% / $-31.00 | 32.3% / $-27.23 |
| PD_IB_HIGH_FADE_SHORT | 19 | 9 -> 28 | 4 -> 10 | NO | 47.4% / $-4.95 | 42.9% / $-9.02 |
| WEEKLY_VWAP_FADE_SHORT | 18 | 2 -> 20 | 2 -> 5 | NO | 38.9% / $-12.33 | 40.0% / $-12.90 |
| CAM_S1_FADE_SHORT | 17 | 6 -> 23 | 4 -> 7 | NO | 41.2% / $-14.24 | 39.1% / $-14.30 |
| CAM_R4_FADE_SHORT | 17 | 4 -> 21 | 3 -> 7 | NO | 58.8% / $18.12 | 57.1% / $15.83 |
| CAM_S4_FADE_LONG | 16 | 3 -> 19 | 2 -> 4 | NO | 37.5% / $-18.50 | 42.1% / $-16.32 |
| PD_IB_HIGH_FADE_LONG | 16 | 12 -> 28 | 6 -> 9 | NO | 43.8% / $-10.38 | 42.9% / $-6.77 |
| ONL_FADE_LONG | 16 | 29 -> 45 | 10 -> 12 | NO | 12.5% / $-57.25 | 37.8% / $-15.36 |
| CAM_S3_FADE_LONG | 16 | 17 -> 33 | 9 -> 13 | NO | 43.8% / $-10.38 | 57.6% / $13.00 |
| OR5_MID_FADE_SHORT | 15 | 35 -> 50 | 16 -> 20 | YES | 33.3% / $-0.67 | 38.0% / $-8.25 |
| PD_VAL_FADE_LONG | 15 | 67 -> 82 | 26 -> 26 | NO | 33.3% / $-20.67 | 50.0% / $-1.95 |
| ONL_FADE_SHORT | 14 | 21 -> 35 | 9 -> 12 | NO | 50.0% / $-1.00 | 51.4% / $7.09 |
| PW_VAH_FADE_SHORT | 14 | 6 -> 20 | 3 -> 5 | NO | 71.4% / $31.14 | 60.0% / $18.70 |
| PD_SESSION_MID_FADE_LONG | 13 | 16 -> 29 | 5 -> 6 | NO | 61.5% / $16.31 | 48.3% / $-6.76 |
| 10D_IB_MID_FADE_SHORT | 13 | 3 -> 16 | 2 -> 4 | NO | 69.2% / $29.54 | 56.3% / $6.63 |
| 10D_IB_MID_FADE_LONG | 13 | 3 -> 16 | 2 -> 5 | NO | 15.4% / $-44.77 | 18.8% / $-39.25 |
| IB_MID_SCALP_FADE_SHORT | 11 | 38 -> 49 | 17 -> 18 | NO | 72.7% / $49.64 | 51.0% / $15.84 |
| IB_LOW_FADE_LONG | 11 | 67 -> 78 | 23 -> 23 | NO | 72.7% / $48.36 | 65.4% / $30.90 |
| OR5_MID_FADE_LONG | 10 | 57 -> 67 | 27 -> 29 | NO | 30.0% / $-4.20 | 44.8% / $2.66 |
| WEEKLY_VWAP_FADE_LONG | 10 | 1 -> 11 | 1 -> 5 | NO | 70.0% / $30.60 | 63.6% / $21.82 |
| PD_LOW_FADE_SHORT | 10 | 8 -> 18 | 2 -> 4 | NO | 80.0% / $51.20 | 72.2% / $40.83 |
| CAM_R3_FADE_LONG | 9 | 12 -> 21 | 5 -> 6 | NO | 22.2% / $-42.67 | 19.0% / $-35.98 |
| CAM_S3_FADE_SHORT | 9 | 17 -> 26 | 8 -> 11 | NO | 11.1% / $-59.33 | 38.5% / $-10.35 |
| WPP_FADE_LONG | 9 | 16 -> 25 | 5 -> 5 | NO | 44.4% / $-9.33 | 36.0% / $-8.98 |
| PD_VAH_FADE_SHORT | 9 | 82 -> 91 | 32 -> 32 | NO | 100.0% / $78.00 | 41.8% / $3.30 |
| OR5_LOW_FADE_SHORT | 8 | 55 -> 63 | 20 -> 22 | NO | 12.5% / $-34.00 | 38.1% / $-1.84 |
| CAM_R3_FADE_SHORT | 8 | 16 -> 24 | 5 -> 6 | NO | 75.0% / $36.50 | 50.0% / $10.19 |
| CAM_S2_FADE_SHORT | 8 | 20 -> 28 | 12 -> 12 | NO | 87.5% / $55.25 | 53.6% / $9.88 |
| IB_LOW_FADE_SHORT | 7 | 55 -> 62 | 12 -> 14 | NO | 14.3% / $-54.57 | 32.3% / $-28.90 |
| PW_POC_FADE_SHORT | 7 | 2 -> 9 | 1 -> 3 | NO | 42.9% / $-9.71 | 44.4% / $-7.11 |
| DAILY_OPEN_FADE_SHORT | 7 | 1 -> 8 | 1 -> 2 | NO | 71.4% / $32.57 | 62.5% / $20.25 |
| PD_LOW_FADE_LONG | 6 | 14 -> 20 | 3 -> 5 | NO | 16.7% / $-51.00 | 20.0% / $-33.73 |
| FLOOR_R2_FADE_SHORT | 5 | 4 -> 9 | 3 -> 5 | NO | 60.0% / $16.80 | 33.3% / $-23.78 |
| FLOOR_S2_FADE_LONG | 4 | 15 -> 19 | 5 -> 6 | NO | 75.0% / $43.00 | 52.6% / $14.61 |
| FLOOR_S3_FADE_LONG | 4 | 3 -> 7 | 1 -> 2 | NO | 25.0% / $-31.50 | 57.1% / $3.43 |
| WS1_FADE_SHORT | 4 | 4 -> 8 | 3 -> 4 | NO | 50.0% / $3.00 | 50.0% / $-0.88 |
| 5D_OR_MID_FADE_SHORT | 3 | 8 -> 11 | 5 -> 6 | NO | 33.3% / $-26.00 | 27.3% / $-21.09 |
| WS1_FADE_LONG | 3 | 3 -> 6 | 3 -> 5 | NO | 33.3% / $-20.00 | 66.7% / $34.50 |
| PW_VAL_FADE_SHORT | 2 | 17 -> 19 | 3 -> 3 | NO | 50.0% / $-1.00 | 47.4% / $2.58 |
| PD_IB_MID_FADE_LONG | 2 | 40 -> 42 | 8 -> 8 | NO | 0.0% / $-76.00 | 40.5% / $-5.18 |
| MONTHLY_OPEN_FADE_LONG | 2 | 1 -> 3 | 1 -> 1 | NO | 100.0% / $72.00 | 100.0% / $72.00 |
| PW_LOW_FADE_SHORT | 2 | 13 -> 15 | 5 -> 5 | NO | 100.0% / $74.00 | 53.3% / $2.13 |
| 5D_OR_MID_FADE_LONG | 2 | 9 -> 11 | 7 -> 8 | NO | 50.0% / $-1.00 | 54.5% / $-2.36 |
| PW_LOW_FADE_LONG | 2 | 15 -> 17 | 4 -> 5 | NO | 100.0% / $74.00 | 52.9% / $-2.94 |
| IB_HIGH_FADE_LONG | 1 | 42 -> 43 | 14 -> 14 | NO | 0.0% / $-52.00 | 39.5% / $-18.66 |
| MPP_FADE_SHORT | 1 | 3 -> 4 | 2 -> 2 | NO | 0.0% / $-66.00 | 50.0% / $-7.75 |
| WEEKLY_OPEN_FADE_SHORT | 1 | 21 -> 22 | 9 -> 9 | NO | 0.0% / $-6.00 | 59.1% / $24.70 |
| PD_IB_MID_FADE_SHORT | 1 | 23 -> 24 | 7 -> 8 | NO | 100.0% / $74.00 | 54.2% / $5.21 |
| WEEKLY_OPEN_FADE_LONG | 1 | 14 -> 15 | 6 -> 6 | NO | 0.0% / $-76.00 | 20.0% / $-38.83 |
| PW_POC_FADE_LONG | 1 | 5 -> 6 | 4 -> 5 | NO | 0.0% / $-76.00 | 33.3% / $-25.00 |
| MR1_FADE_SHORT | 1 | 2 -> 3 | 1 -> 2 | NO | 0.0% / $-76.00 | 66.7% / $32.00 |

## Space check in setup types
Zero setup_type strings contain a space: true
Zero setup_type strings contain a lowercase letter: true