# True-MTM decomposition -- run output. Pooled Mode 1 book 1723 trades (expected 1723): control mean at $1 fee Train -$0.9 (expected -$0.9), Hold-Out -$0.4 (expected -$0.4); universe 5324 trades, Train 3160 / Hold-Out 2164
level families: 15 labels, Unlabeled_Level trades 0; stored structural_level_type present on 5324 (coverage reported below); Touch_Seq=1 share of all 5,324 triggers 66.3%
metadata check: structural_level_type populated on 5324 of 5324 trades (setup_type parse used regardless)

### Table 1A -- View 1: Within-Setup Mode 1 (each setup deduplicated against itself only) on the BACKFILL simulation: 5324 trades, 116 setups. Stored = $0-expiry baseline P&L; True MTM from the re-simulation engine. Setups with total N>=30 listed.

| Setup | Train N | Hold-Out N | Stored mean $ (Train / HO) | True MTM mean @$1 (Train / HO) | True MTM mean @$4 Hold-Out [95% CI] | MTM win rate (Train / HO) | Time-expired share | Mean MTM P&L of time-expired trades @$1 |
|---|---|---|---|---|---|---|---|---|
| FLOOR_S3_FADE_LONG | 17 | 16 | $94.1 / $48.8 | $77.3 / $52.1 | $49.1 [-$38.1, $125.4] | 76.5% / 75.0% | 15.2% | -$46.6 |
| PW_VAL_FADE_LONG | 18 | 14 | $35.8 / $26.4 | $43.0 / $3.3 | $0.3 [-$93.4, $76.3] | 77.8% / 64.3% | 12.5% | $40.1 |
| WPP_FADE_LONG | 19 | 20 | $30.2 / $3.0 | $30.2 / $1.9 | -$1.1 [-$45.9, $39.5] | 84.2% / 65.0% | 5.1% | -$11.3 |
| PD_HIGH_FADE_SHORT | 40 | 44 | $32.5 / $10.2 | $25.0 / $4.4 | $1.4 [-$37.3, $38.7] | 67.5% / 70.5% | 14.3% | -$22.0 |
| WEEKLY_OPEN_FADE_SHORT | 28 | 23 | $35.1 / $53.1 | $23.1 / $50.7 | $47.7 [-$1.9, $95.7] | 60.7% / 73.9% | 21.6% | -$35.7 |
| WEEKLY_OPEN_FADE_LONG | 35 | 22 | $20.8 / $17.2 | $23.0 / $2.7 | -$0.3 [-$73.2, $58.0] | 71.4% / 63.6% | 3.5% | $37.5 |
| CAM_R2_FADE_SHORT | 36 | 32 | $22.1 / $13.8 | $20.4 / $13.6 | $10.6 [-$23.1, $44.0] | 75.0% / 71.9% | 8.8% | $0.9 |
| DAILY_OPEN_FADE_LONG | 58 | 41 | $19.1 / $33.3 | $20.1 / $24.7 | $21.7 [-$30.0, $73.3] | 70.7% / 70.7% | 8.1% | $7.6 |
| PD_SESSION_MID_FADE_SHORT | 26 | 19 | $21.9 / -$14.1 | $17.8 / -$14.1 | -$17.1 [-$72.2, $37.9] | 69.2% / 57.9% | 2.2% | -$106.0 |
| FLOOR_R1_FADE_SHORT | 50 | 32 | $24.2 / -$29.5 | $17.8 / -$29.5 | -$32.5 [-$70.6, -$0.8] | 70.0% / 53.1% | 12.2% | -$32.0 |
| 5D_OR_MID_FADE_LONG | 21 | 11 | $18.7 / -$7.6 | $14.8 / -$7.6 | -$10.6 [-$60.9, $39.7] | 76.2% / 63.6% | 6.3% | -$41.0 |
| PD_OR_MID_FADE_SHORT | 26 | 19 | $12.6 / -$6.2 | $12.2 / -$9.3 | -$12.3 [-$64.1, $39.4] | 61.5% / 57.9% | 11.1% | -$45.0 |
| CAM_S2_FADE_LONG | 53 | 27 | $9.5 / $15.4 | $12.0 / $15.4 | $12.4 [-$29.6, $45.9] | 66.0% / 70.4% | 3.8% | -$30.8 |
| FLOOR_PIVOT_FADE_LONG | 45 | 22 | $14.4 / -$33.2 | $11.4 / -$36.3 | -$39.3 [-$90.0, $14.9] | 64.4% / 45.5% | 9.0% | -$33.9 |
| CAM_R4_FADE_SHORT | 38 | 36 | $23.2 / -$32.1 | $11.3 / -$32.1 | -$35.1 [-$77.0, $6.9] | 65.8% / 55.6% | 12.2% | -$41.7 |
| ONH_FADE_SHORT | 85 | 52 | $17.0 / $2.8 | $10.1 / $4.5 | $1.5 [-$38.5, $39.6] | 63.5% / 63.5% | 19.0% | -$14.9 |
| IB_HIGH_FADE_SHORT | 131 | 79 | $10.4 / -$2.6 | $8.7 / -$4.1 | -$7.1 [-$24.6, $10.4] | 67.9% / 60.8% | 8.6% | -$12.4 |
| PD_IB_MID_FADE_SHORT | 28 | 17 | $8.3 / -$3.2 | $8.3 / -$3.2 | -$6.2 [-$46.3, $33.9] | 71.4% / 64.7% | 0.0% | n/a |
| OR5_MID_FADE_SHORT | 67 | 33 | $11.1 / -$31.8 | $8.2 / -$31.8 | -$34.8 [-$66.6, -$3.2] | 68.7% / 48.5% | 9.0% | -$21.8 |
| CAM_R3_FADE_SHORT | 47 | 35 | $11.0 / -$3.0 | $6.9 / -$3.0 | -$6.0 [-$46.2, $27.5] | 63.8% / 65.7% | 8.5% | -$27.7 |
| CAM_S3_FADE_LONG | 60 | 27 | $5.2 / $27.4 | $1.9 / $27.4 | $24.4 [-$14.9, $56.8] | 65.0% / 77.8% | 8.0% | -$28.1 |
| PD_VAL_FADE_LONG | 46 | 28 | -$2.6 / -$13.5 | $1.9 / -$13.5 | -$16.5 [-$62.8, $29.7] | 63.0% / 57.1% | 4.1% | -$18.2 |
| OR5_MID_FADE_LONG | 52 | 31 | $3.0 / -$11.9 | $1.9 / -$11.9 | -$14.9 [-$44.7, $14.8] | 63.5% / 61.3% | 7.2% | -$9.3 |
| PD_IB_HIGH_FADE_LONG | 32 | 11 | $1.1 / -$8.9 | $1.2 / -$8.9 | -$11.9 [-$78.1, $54.2] | 68.8% / 63.6% | 9.3% | $0.3 |
| IB_MID_SCALP_FADE_LONG | 80 | 44 | $3.0 / -$5.0 | $0.3 / -$5.0 | -$8.0 [-$31.3, $15.3] | 63.7% / 63.6% | 5.6% | -$6.9 |
| OR5_HIGH_FADE_SHORT | 151 | 92 | $2.1 / -$12.5 | $0.2 / -$12.6 | -$15.6 [-$39.0, $7.3] | 63.6% / 59.8% | 6.6% | -$18.0 |
| CAM_R3_FADE_LONG | 24 | 13 | -$0.8 / -$0.7 | -$0.8 / -$5.6 | -$8.6 [-$66.4, $45.6] | 66.7% / 61.5% | 2.7% | -$63.5 |
| CAM_S1_FADE_LONG | 45 | 22 | -$1.5 / -$15.5 | -$0.9 / -$15.5 | -$18.5 [-$71.7, $24.0] | 62.2% / 59.1% | 7.5% | -$13.8 |
| PW_POC_FADE_LONG | 24 | 14 | -$4.3 / -$54.6 | -$2.7 / -$52.7 | -$55.7 [-$145.4, $28.6] | 66.7% / 50.0% | 21.1% | $8.1 |
| PD_OR_MID_FADE_LONG | 35 | 23 | -$2.9 / -$11.0 | -$3.8 / -$13.1 | -$16.1 [-$64.7, $31.4] | 62.9% / 56.5% | 6.9% | -$20.0 |
| PD_IB_HIGH_FADE_SHORT | 33 | 26 | $8.6 / $13.9 | -$5.1 / $13.9 | $10.9 [-$35.7, $48.2] | 54.5% / 73.1% | 15.3% | -$41.2 |
| FLOOR_S1_FADE_LONG | 46 | 26 | -$6.1 / -$3.9 | -$5.8 / -$3.9 | -$6.9 [-$52.9, $39.0] | 58.7% / 61.5% | 5.6% | $25.6 |
| CAM_S4_FADE_LONG | 45 | 24 | -$8.2 / -$15.7 | -$5.8 / -$15.6 | -$18.6 [-$71.9, $34.6] | 66.7% / 62.5% | 7.2% | $21.4 |
| 10D_IB_MID_FADE_LONG | 14 | 16 | $15.7 / $47.3 | -$6.3 / $43.4 | $40.4 [-$50.8, $119.1] | 57.1% / 75.0% | 13.3% | -$92.6 |
| FLOOR_R2_FADE_SHORT | 39 | 34 | $2.7 / $21.6 | -$8.2 / $13.8 | $10.8 [-$25.4, $45.1] | 59.0% / 67.6% | 11.0% | -$27.0 |
| PD_SESSION_MID_FADE_LONG | 37 | 20 | -$6.3 / -$0.3 | -$8.8 / $1.5 | -$1.5 [-$56.7, $50.8] | 54.1% / 65.0% | 8.8% | -$11.7 |
| PD_IB_LOW_FADE_LONG | 36 | 23 | -$8.9 / $2.5 | -$8.9 / $0.6 | -$2.4 [-$44.2, $39.4] | 58.3% / 60.9% | 1.7% | -$43.0 |
| IB_MID_SCALP_FADE_SHORT | 74 | 42 | -$6.8 / -$14.7 | -$9.1 / -$14.5 | -$17.5 [-$42.2, $5.9] | 55.4% / 57.1% | 8.6% | -$16.3 |
| PD_VAH_FADE_SHORT | 46 | 29 | -$3.7 / $3.4 | -$9.6 / $2.4 | -$0.6 [-$37.1, $32.4] | 56.5% / 62.1% | 13.3% | -$29.9 |
| PD_POC_FADE_LONG | 49 | 20 | -$11.3 / $11.9 | -$9.8 / $2.6 | -$0.4 [-$46.9, $46.2] | 59.2% / 65.0% | 8.7% | $33.9 |
| PW_VAH_FADE_LONG | 27 | 15 | -$5.3 / $37.1 | -$10.4 / $17.0 | $14.0 [-$49.4, $71.0] | 66.7% / 73.3% | 11.9% | -$30.5 |
| PD_IB_MID_FADE_LONG | 36 | 25 | -$10.9 / $2.4 | -$12.2 / $2.4 | -$0.6 [-$34.7, $26.7] | 58.3% / 68.0% | 1.6% | -$46.0 |
| OR5_LOW_FADE_LONG | 159 | 91 | -$12.3 / $7.5 | -$12.2 / $6.6 | $3.6 [-$17.2, $22.2] | 59.7% / 69.2% | 3.6% | -$7.9 |
| PD_VAH_FADE_LONG | 39 | 16 | -$10.3 / $37.3 | -$12.2 / $37.3 | $34.3 [-$5.3, $74.0] | 53.8% / 81.3% | 5.5% | -$25.7 |
| IB_LOW_FADE_LONG | 120 | 49 | -$13.7 / -$2.1 | -$13.3 / -$4.0 | -$7.0 [-$34.7, $19.8] | 60.8% / 65.3% | 7.7% | -$3.1 |
| CAM_R1_FADE_LONG | 29 | 14 | -$12.5 / -$44.5 | -$15.4 / -$44.5 | -$47.5 [-$106.3, $11.4] | 55.2% / 42.9% | 9.3% | -$3.0 |
| CAM_R1_FADE_SHORT | 36 | 24 | -$11.3 / -$15.6 | -$15.6 / -$15.3 | -$18.3 [-$58.5, $19.2] | 52.8% / 58.3% | 10.0% | -$24.3 |
| PD_LOW_FADE_LONG | 51 | 30 | -$11.9 / -$3.9 | -$17.7 / -$16.7 | -$19.7 [-$88.3, $48.9] | 60.8% / 66.7% | 8.6% | -$46.1 |
| CAM_R2_FADE_LONG | 32 | 15 | -$19.9 / $12.0 | -$21.3 / $13.2 | $10.2 [-$43.1, $53.0] | 56.3% / 73.3% | 8.5% | -$7.6 |
| PW_VAH_FADE_SHORT | 25 | 19 | $2.7 / $22.8 | -$25.4 / $17.7 | $14.7 [-$33.6, $55.0] | 52.0% / 68.4% | 29.5% | -$61.5 |
| PD_CLOSE_FADE_LONG | 53 | 27 | -$17.9 / $22.4 | -$26.1 / $20.9 | $17.9 [-$35.0, $67.6] | 52.8% / 77.8% | 18.8% | -$17.8 |
| PD_CLOSE_FADE_SHORT | 39 | 30 | $11.9 / $27.0 | -$26.3 / -$10.2 | -$13.2 [-$70.5, $42.3] | 51.3% / 63.3% | 18.8% | -$94.8 |
| ONL_FADE_LONG | 78 | 51 | -$11.8 / $26.4 | -$28.7 / $20.9 | $17.9 [-$26.7, $59.2] | 52.6% / 74.5% | 17.1% | -$30.5 |
| PW_HIGH_FADE_SHORT | 22 | 19 | -$31.9 / -$18.1 | -$28.7 / -$18.5 | -$21.5 [-$69.2, $26.2] | 50.0% / 52.6% | 19.5% | -$10.9 |
| WR1_FADE_SHORT | 14 | 16 | -$26.1 / $0.9 | -$29.3 / $0.9 | -$2.1 [-$52.2, $48.0] | 42.9% / 62.5% | 10.0% | -$15.0 |
| PD_IB_LOW_FADE_SHORT | 21 | 11 | -$29.6 / $2.6 | -$30.1 / $2.6 | -$0.4 [-$59.6, $58.9] | 47.6% / 63.6% | 6.3% | -$5.3 |
| DAILY_OPEN_FADE_SHORT | 53 | 48 | -$26.4 / -$26.4 | -$34.0 / -$33.8 | -$36.8 [-$88.3, $14.7] | 50.9% / 54.2% | 5.9% | -$67.1 |
| FLOOR_S2_FADE_LONG | 30 | 22 | -$34.9 / -$22.2 | -$36.6 / -$26.0 | -$29.0 [-$109.3, $41.7] | 56.7% / 59.1% | 3.8% | -$67.5 |
| FLOOR_PIVOT_FADE_SHORT | 21 | 15 | -$34.1 / -$3.1 | -$42.6 / -$3.1 | -$6.1 [-$74.4, $45.2] | 38.1% / 60.0% | 13.9% | -$35.7 |
| PD_HIGH_FADE_LONG | 32 | 21 | -$27.6 / $19.7 | -$42.7 / -$7.9 | -$10.9 [-$66.2, $44.3] | 50.0% / 66.7% | 11.3% | -$32.3 |
| PD_POC_FADE_SHORT | 18 | 12 | -$56.2 / -$49.8 | -$56.2 / -$49.8 | -$52.8 [-$111.0, $5.4] | 38.9% / 41.7% | 0.0% | n/a |
| CAM_S1_FADE_SHORT | 17 | 27 | -$71.2 / $19.6 | -$71.2 / $19.6 | $16.6 [-$26.8, $51.2] | 35.3% / 74.1% | 0.0% | n/a |
| (all other groups, each N<30; 54 groups) | 372 | 408 | $2.3 / $8.5 | -$5.5 / $3.5 | $0.5 [-$15.8, $17.3] | 58.6% / 65.0% | 9.4% | -$40.4 |

Pass gate, setups (within-date label permutation, max-T):
| Selected on Train (N>=20, mean>0) | Train N / mean | Hold-Out N / mean [95% CI] | Hold-Out t | max-T adjusted p | Verdict |
|---|---|---|---|---|---|
| OR5_HIGH_FADE_SHORT | 151 / $0.2 | 92 / -$12.6 [-$37.1, $10.3] | -1.06 | 1.000 | does not pass |
| IB_MID_SCALP_FADE_LONG | 80 / $0.3 | 44 / -$5.0 [-$28.3, $18.3] | -0.40 | 1.000 | does not pass |
| OR5_MID_FADE_LONG | 52 / $1.9 | 31 / -$11.9 [-$41.7, $17.8] | -0.73 | 1.000 | does not pass |
| IB_HIGH_FADE_SHORT | 131 / $8.7 | 79 / -$4.1 [-$21.6, $13.6] | -0.46 | 1.000 | does not pass |
| PD_VAL_FADE_LONG | 46 / $1.9 | 28 / -$13.5 [-$59.8, $36.0] | -0.56 | 1.000 | does not pass |
| PD_HIGH_FADE_SHORT | 40 / $25.0 | 44 / $4.4 [-$34.0, $39.7] | 0.23 | 1.000 | does not pass |
| CAM_R2_FADE_SHORT | 36 / $20.4 | 32 / $13.6 [-$19.8, $46.8] | 0.79 | 1.000 | does not pass |
| ONH_FADE_SHORT | 85 / $10.1 | 52 / $4.5 [-$36.7, $43.8] | 0.22 | 1.000 | does not pass |
| CAM_R3_FADE_SHORT | 47 / $6.9 | 35 / -$3.0 [-$43.2, $30.5] | -0.16 | 1.000 | does not pass |
| FLOOR_R1_FADE_SHORT | 50 / $17.8 | 32 / -$29.5 [-$61.3, $2.2] | -1.62 | 1.000 | does not pass |
| OR5_MID_FADE_SHORT | 67 / $8.2 | 33 / -$31.8 [-$63.5, $1.7] | -1.98 | 1.000 | does not pass |
| DAILY_OPEN_FADE_LONG | 58 / $20.1 | 41 / $24.7 [-$27.0, $67.7] | 0.97 | 0.995 | does not pass |
| PD_IB_HIGH_FADE_LONG | 32 / $1.2 | 11 / -$8.9 [-$75.1, $57.2] | n/a | n/a | UNDERPOWERED (Hold-Out N<20) |
| WEEKLY_OPEN_FADE_SHORT | 28 / $23.1 | 23 / $50.7 [-$4.7, $98.7] | 1.94 | 0.726 | does not pass |
| CAM_R4_FADE_SHORT | 38 / $11.3 | 36 / -$32.1 [-$74.0, $9.9] | -1.52 | 1.000 | does not pass |
| PD_SESSION_MID_FADE_SHORT | 26 / $17.8 | 19 / -$14.1 [-$69.2, $40.9] | n/a | n/a | UNDERPOWERED (Hold-Out N<20) |
| 5D_OR_MID_FADE_LONG | 21 / $14.8 | 11 / -$7.6 [-$57.9, $42.7] | n/a | n/a | UNDERPOWERED (Hold-Out N<20) |
| CAM_S2_FADE_LONG | 53 / $12.0 | 27 / $15.4 [-$26.6, $57.3] | 0.76 | 1.000 | does not pass |
| FLOOR_PIVOT_FADE_LONG | 45 / $11.4 | 22 / -$36.3 [-$87.0, $17.9] | -1.33 | 1.000 | does not pass |
| CAM_S3_FADE_LONG | 60 / $1.9 | 27 / $27.4 [-$11.9, $63.7] | 1.36 | 0.941 | does not pass |
| WEEKLY_OPEN_FADE_LONG | 35 / $23.0 | 22 / $2.7 [-$70.2, $61.0] | 0.08 | 1.000 | does not pass |
| PD_IB_MID_FADE_SHORT | 28 / $8.3 | 17 / -$3.2 [-$43.3, $36.9] | n/a | n/a | UNDERPOWERED (Hold-Out N<20) |
| PD_OR_MID_FADE_SHORT | 26 / $12.2 | 19 / -$9.3 [-$66.2, $42.4] | n/a | n/a | UNDERPOWERED (Hold-Out N<20) |
(116 groups, 23 selected on Train; null distribution of the max Hold-Out t: 5th-95th pct 1.33 to 4.10)

### Table 1A-2 -- View 2: the pooled Mode 1 book (1,723) partitioned by setup (setups with N>=15)

| Setup | Train N | Hold-Out N | Stored mean $ (Train / HO) | True MTM mean @$1 (Train / HO) | True MTM mean @$4 Hold-Out [95% CI] | MTM win rate (Train / HO) | Time-expired share | Mean MTM P&L of time-expired trades @$1 |
|---|---|---|---|---|---|---|---|---|
| FLOOR_S3_FADE_LONG | 8 | 9 | $132.8 / $51.8 | $112.6 / $57.7 | $54.7 [-$58.9, $148.8] | 87.5% / 77.8% | 11.8% | -$54.5 |
| PD_CLOSE_FADE_SHORT | 8 | 7 | $89.7 / $38.8 | $68.7 / $31.6 | $28.6 [-$69.6, $99.5] | 87.5% / 71.4% | 13.3% | -$109.3 |
| CAM_S3_FADE_SHORT | 5 | 12 | $63.6 / $13.2 | $66.9 / $13.2 | $10.2 [-$56.2, $76.5] | 100.0% / 75.0% | 5.9% | $16.5 |
| ONH_FADE_SHORT | 16 | 17 | $59.8 / -$17.2 | $52.8 / -$13.3 | -$16.3 [-$84.9, $52.2] | 81.3% / 58.8% | 21.2% | $9.9 |
| FLOOR_S1_FADE_LONG | 12 | 11 | $48.2 / -$20.6 | $48.2 / -$20.6 | -$23.6 [-$88.8, $41.5] | 83.3% / 54.5% | 0.0% | n/a |
| IB_HIGH_FADE_SHORT | 41 | 37 | $21.6 / -$0.1 | $20.7 / -$2.0 | -$5.0 [-$31.9, $20.9] | 75.6% / 62.2% | 9.0% | $1.3 |
| OR5_MID_FADE_SHORT | 31 | 16 | $16.1 / -$24.9 | $12.8 / -$25.1 | -$28.1 [-$74.3, $14.3] | 71.0% / 50.0% | 10.6% | -$20.7 |
| FLOOR_R2_FADE_SHORT | 9 | 15 | $10.5 / $10.5 | $10.5 / -$5.5 | -$8.5 [-$72.5, $55.5] | 66.7% / 60.0% | 0.0% | n/a |
| DAILY_OPEN_FADE_SHORT | 29 | 27 | $13.0 / -$2.7 | $7.2 / -$15.8 | -$18.8 [-$84.2, $46.6] | 62.1% / 59.3% | 7.1% | -$41.9 |
| IB_MID_SCALP_FADE_LONG | 52 | 34 | $6.7 / -$13.2 | $6.6 / -$13.2 | -$16.2 [-$46.3, $13.9] | 67.3% / 58.8% | 4.7% | -$2.0 |
| IB_LOW_FADE_LONG | 44 | 32 | $2.4 / -$13.4 | $1.7 / -$16.2 | -$19.2 [-$55.3, $13.2] | 65.9% / 59.4% | 6.6% | -$24.2 |
| IB_MID_SCALP_FADE_SHORT | 54 | 33 | $2.3 / -$22.2 | $0.1 / -$21.8 | -$24.8 [-$52.0, $2.3] | 63.0% / 54.5% | 5.7% | -$20.8 |
| OR5_HIGH_FADE_SHORT | 98 | 45 | $1.8 / $1.0 | -$0.2 / $1.9 | -$1.1 [-$33.2, $29.3] | 63.3% / 66.7% | 7.0% | -$14.9 |
| DAILY_OPEN_FADE_LONG | 29 | 18 | -$7.0 / $29.9 | -$1.0 / $29.9 | $26.9 [-$51.5, $85.8] | 65.5% / 72.2% | 6.4% | $57.7 |
| PD_LOW_FADE_LONG | 10 | 7 | -$12.1 / $6.1 | -$6.9 / $6.1 | $3.1 [-$114.5, $120.8] | 60.0% / 71.4% | 5.9% | -$1.5 |
| CAM_R1_FADE_SHORT | 10 | 5 | -$9.1 / -$9.1 | -$9.1 / -$9.1 | -$12.1 [-$94.6, $70.3] | 60.0% / 60.0% | 0.0% | n/a |
| PD_CLOSE_FADE_LONG | 13 | 10 | -$11.1 / $33.8 | -$12.8 / $25.1 | $22.1 [-$72.3, $99.5] | 61.5% / 80.0% | 8.7% | -$3.5 |
| FLOOR_S2_FADE_LONG | 14 | 6 | -$14.0 / -$4.8 | -$14.0 / -$4.8 | -$7.8 [-$137.5, $122.0] | 64.3% / 66.7% | 0.0% | n/a |
| OR5_MID_FADE_LONG | 32 | 23 | -$15.3 / -$4.7 | -$16.1 / -$4.7 | -$7.7 [-$47.8, $24.4] | 56.3% / 65.2% | 5.5% | -$9.2 |
| OR5_LOW_FADE_LONG | 95 | 52 | -$16.5 / $20.9 | -$16.7 / $19.3 | $16.3 [-$9.2, $39.6] | 57.9% / 75.0% | 3.4% | -$19.9 |
| CAM_R4_FADE_SHORT | 5 | 16 | $31.9 / -$61.8 | -$26.3 / -$61.8 | -$64.8 [-$127.7, -$1.9] | 40.0% / 43.8% | 14.3% | -$97.0 |
| PW_VAH_FADE_SHORT | 9 | 6 | $26.8 / $67.1 | -$26.7 / $63.3 | $60.3 [$26.0, $77.5] | 44.4% / 83.3% | 46.7% | -$72.0 |
| CAM_S2_FADE_LONG | 11 | 10 | -$61.6 / $14.6 | -$41.0 / $14.6 | $11.6 [-$56.4, $79.5] | 45.5% / 70.0% | 0.0% | n/a |
| CAM_S3_FADE_LONG | 12 | 7 | -$44.3 / $3.7 | -$47.4 / $3.7 | $0.7 [-$113.1, $76.5] | 41.7% / 71.4% | 10.5% | -$18.3 |
| PD_IB_LOW_FADE_LONG | 6 | 9 | -$63.2 / -$24.0 | -$63.2 / -$28.8 | -$31.8 [-$93.9, $30.3] | 33.3% / 44.4% | 6.7% | -$43.0 |
| CAM_R4_FADE_LONG | 5 | 11 | -$52.8 / -$11.7 | -$76.7 / -$11.7 | -$14.7 [-$83.4, $53.9] | 20.0% / 63.6% | 12.5% | -$59.8 |
| ONL_FADE_LONG | 15 | 11 | -$89.0 / -$46.2 | -$99.8 / -$78.1 | -$81.1 [-$176.9, $14.7] | 33.3% / 45.5% | 11.5% | -$16.2 |
| (all other groups, each N<15; 85 groups) | 253 | 311 | $5.9 / $9.7 | $1.1 / $6.1 | $3.1 [-$11.0, $17.3] | 62.8% / 65.9% | 6.2% | -$29.7 |

### Table 1B -- ACTIVE live-model rows (outside the simulation; never subject to the $0 convention: their stored P&L is already marked to market), Within-Setup Mode 1, split at the 2026-10-11 18:00 ET confound boundary

ACTIVE rows with a P&L and direction: 1402; fee basis in the stored P&L, from the median TARGET_HIT residual (n=518): $2.00 per trade (so the $4 column below is stored + -2.00).
| Setup (N>=10 after within-setup Mode 1) | N | Mean P&L stored | Mean @$4 [95% CI] | Win rate | Pre-boundary N / mean | Post-boundary N / mean |
|---|---|---|---|---|---|---|
| ALL ACTIVE (within-setup Mode 1) | 1310 | -$2.3 | -$4.3 [-$8.8, $0.4] | 42.5% | 948 / -$2.5 | 362 / -$1.7 |
| IB_BEARISH | 93 | -$1.2 | -$3.2 [-$24.7, $12.4] | 59.1% | 93 / -$1.2 | 0 / n/a |
| PD_VAL_FADE_LONG | 66 | $3.7 | $1.7 [-$12.9, $20.4] | 50.0% | 60 / $2.9 | 6 / $12.3 |
| PD_VAH_FADE_SHORT | 64 | $2.1 | $0.1 [-$15.0, $23.0] | 43.8% | 55 / -$1.4 | 9 / $23.8 |
| PD_POC_FADE_LONG | 61 | -$3.0 | -$5.0 [-$22.4, $13.3] | 41.0% | 61 / -$3.0 | 0 / n/a |
| PD_POC_FADE_SHORT | 43 | $1.6 | -$0.4 [-$36.1, $36.1] | 48.8% | 35 / -$2.2 | 8 / $17.9 |
| IB_BULLISH | 39 | $22.5 | $20.5 [-$7.2, $63.6] | 66.7% | 39 / $22.5 | 0 / n/a |
| GLOBEX_VWAP_MAGNET_LONG | 38 | -$14.1 | -$16.1 [-$30.5, $2.1] | 42.1% | 28 / -$13.2 | 10 / -$16.8 |
| GLOBEX_VWAP_FADE_SHORT | 37 | $12.8 | $10.8 [-$16.6, $45.3] | 43.2% | 25 / $15.7 | 12 / $6.7 |
| IB_HIGH_FADE_SHORT | 34 | $4.2 | $2.2 [-$16.7, $26.2] | 29.4% | 32 / $2.8 | 2 / $26.0 |
| OR5_LOW_FADE_SHORT | 33 | -$0.3 | -$2.3 [-$23.0, $25.7] | 36.4% | 32 / $0.3 | 1 / -$20.0 |
| OR5_HIGH_FADE_SHORT | 27 | $2.6 | $0.6 [-$22.4, $32.3] | 25.9% | 24 / -$5.2 | 3 / $64.7 |
| OR5_MID_FADE_LONG | 22 | -$3.8 | -$5.8 [-$32.4, $22.2] | 36.4% | 20 / -$6.7 | 2 / $25.0 |
| RTH_VWAP_FADE_LONG | 22 | -$13.2 | -$15.2 [-$38.2, $4.9] | 31.8% | 14 / -$2.8 | 8 / -$31.4 |
| IB_MID_SCALP_FADE_SHORT | 22 | $2.2 | $0.2 [-$15.2, $15.8] | 27.3% | 21 / $3.5 | 1 / -$26.0 |
| GLOBEX_VWAP_MAGNET_SHORT | 19 | $21.3 | $19.3 [-$24.1, $125.6] | 47.4% | 17 / $21.3 | 2 / $21.3 |
| FAILED_AUCTION_LONG | 19 | $22.4 | $20.4 [$6.3, $40.3] | 78.9% | 8 / $41.8 | 11 / $8.3 |
| IB_LOW_FADE_LONG | 17 | $6.6 | $4.6 [-$17.1, $33.2] | 23.5% | 17 / $6.6 | 0 / n/a |
| OR30_HIGH_FADE_LONG | 16 | -$19.6 | -$21.6 [-$42.4, $14.6] | 31.3% | 10 / -$26.4 | 6 / -$8.3 |
| GLOBEX_VWAP_FADE_LONG | 15 | -$28.4 | -$30.4 [-$85.1, $30.7] | 46.7% | 15 / -$28.4 | 0 / n/a |
| FLOOR_R1_FADE_LONG | 13 | $3.2 | $1.2 [-$40.5, $37.3] | 53.8% | 8 / -$8.6 | 5 / $21.9 |
| STACK_VOL_BREAK_LIVE_SHORT | 13 | -$60.3 | -$62.3 [-$128.7, -$20.4] | 23.1% | 9 / -$68.4 | 4 / -$42.0 |
| OR10_LOW_FADE_SHORT | 13 | -$15.2 | -$17.2 [-$65.4, $12.2] | 30.8% | 10 / -$6.0 | 3 / -$46.0 |
| POC_ROTATION_JOIN_SHORT | 13 | -$38.1 | -$40.1 [-$70.0, -$14.2] | 0.0% | 0 / n/a | 13 / -$38.1 |
| OR5_HIGH_FADE_LONG | 12 | -$0.1 | -$2.1 [-$38.6, $30.5] | 41.7% | 7 / $22.0 | 5 / -$31.1 |
| C_PAIRED_SHORT | 11 | -$43.8 | -$45.8 [-$184.9, $56.6] | 36.4% | 7 / -$72.9 | 4 / $7.1 |
| OR10_HIGH_FADE_LONG | 11 | $27.0 | $25.0 [-$22.6, $61.7] | 54.5% | 6 / $48.7 | 5 / $1.0 |
| OR15_HIGH_FADE_LONG | 11 | $30.2 | $28.2 [-$21.8, $66.1] | 54.5% | 5 / $60.8 | 6 / $4.7 |
| POC_ROTATION_JOIN_LONG | 11 | -$57.5 | -$59.5 [-$83.1, -$35.7] | 9.1% | 0 / n/a | 11 / -$57.5 |
| OR30_MID_FADE_SHORT | 10 | $2.5 | $0.5 [-$43.9, $34.8] | 40.0% | 6 / $11.0 | 4 / -$10.4 |
| RTH_VWAP_FADE_SHORT | 10 | $40.5 | $38.5 [-$19.1, $85.6] | 70.0% | 6 / $68.3 | 4 / -$1.1 |
| BRACKET_BREAKOUT_LONG | 10 | -$8.4 | -$10.4 [-$33.5, $84.0] | 40.0% | 10 / -$8.4 | 0 / n/a |
| (all other setups, each N<10; 137 setups) | 485 | -$5.1 | -$7.1 [-$17.2, $2.5] | 40.4% | 268 / -$10.8 | 217 / $1.9 |
(descriptive only: per-setup N is small, the window crosses the 2026-10-11/12 boundary where three structural changes landed, and live rows span every session and setup family; no N>=20 claim is made for any row with N<20)

### Table 2A -- Level families. View 1: Within-Family Mode 1 on the simulation (4731 trades)

| Level family | Train N | Hold-Out N | Stored mean $ (Train / HO) | True MTM mean @$1 (Train / HO) | True MTM mean @$4 Hold-Out [95% CI] | MTM win rate (Train / HO) | Time-expired share | Mean MTM P&L of time-expired trades @$1 |
|---|---|---|---|---|---|---|---|---|
| VAL | 89 | 74 | $9.5 / $4.3 | $10.4 / $2.6 | -$0.4 [-$32.3, $30.0] | 65.2% / 62.2% | 9.2% | -$20.1 |
| PERIOD_OPEN | 167 | 143 | $11.5 / $6.5 | $8.9 / -$0.9 | -$3.9 [-$31.0, $21.6] | 64.7% / 61.5% | 8.7% | -$17.1 |
| OR_MID | 205 | 127 | $9.2 / -$15.9 | $7.3 / -$16.7 | -$19.7 [-$37.2, -$2.0] | 67.3% / 56.7% | 7.8% | -$24.6 |
| PRIOR_HIGH | 119 | 91 | $13.5 / $19.5 | $6.3 / $9.4 | $6.4 [-$19.6, $30.8] | 63.9% / 68.1% | 11.9% | -$21.3 |
| FLOOR_PIVOTS | 266 | 188 | $3.9 / $3.7 | -$1.4 / $2.0 | -$1.0 [-$18.3, $16.3] | 61.3% / 63.8% | 9.7% | -$22.2 |
| IB_MID | 239 | 159 | $1.2 / $1.1 | -$3.5 / $0.7 | -$2.3 [-$21.0, $15.9] | 60.3% / 64.8% | 6.5% | -$38.1 |
| CAMARILLA | 312 | 266 | -$1.9 / -$8.6 | -$4.8 / -$8.8 | -$11.8 [-$26.1, $1.3] | 60.9% / 62.8% | 7.8% | -$22.0 |
| IB_EDGE | 333 | 195 | -$4.6 / -$1.6 | -$5.7 / -$3.0 | -$6.0 [-$19.7, $7.2] | 61.9% / 63.1% | 7.8% | -$10.4 |
| OR_EDGE | 322 | 195 | -$5.8 / $0.2 | -$6.6 / -$0.3 | -$3.3 [-$18.9, $11.4] | 61.5% / 65.6% | 4.8% | -$14.4 |
| PERIOD_PIVOTS | 100 | 123 | -$10.0 / -$2.7 | -$11.6 / -$5.5 | -$8.5 [-$27.2, $10.7] | 59.0% / 61.8% | 6.3% | -$12.8 |
| OVERNIGHT | 178 | 112 | -$0.5 / $4.9 | -$12.1 / $3.2 | $0.2 [-$28.9, $27.8] | 57.3% / 66.1% | 16.9% | -$24.6 |
| VAH | 129 | 87 | -$7.9 / $28.1 | -$16.2 / $16.6 | $13.6 [-$7.7, $33.5] | 55.0% / 70.1% | 13.4% | -$48.7 |
| PD_CLOSE_MID | 130 | 85 | -$4.1 / $14.7 | -$18.5 / $5.6 | $2.6 [-$27.0, $31.4] | 54.6% / 68.2% | 14.0% | -$47.0 |
| POC | 92 | 58 | -$18.5 / -$10.5 | -$24.1 / -$22.4 | -$25.4 [-$62.2, $11.0] | 52.2% / 56.9% | 14.0% | -$26.0 |
| PRIOR_LOW | 82 | 65 | -$19.4 / -$3.9 | -$27.8 / -$11.3 | -$14.3 [-$60.2, $31.6] | 56.1% / 63.1% | 11.6% | -$47.9 |

Pass gate, level families:
| Selected on Train (N>=20, mean>0) | Train N / mean | Hold-Out N / mean [95% CI] | Hold-Out t | max-T adjusted p | Verdict |
|---|---|---|---|---|---|
| OR_MID | 205 / $7.3 | 127 / -$16.7 [-$33.7, -$0.0] | -1.87 | 1.000 | does not pass |
| VAL | 89 / $10.4 | 74 / $2.6 [-$29.3, $31.7] | 0.15 | 0.926 | does not pass |
| PRIOR_HIGH | 119 / $6.3 | 91 / $9.4 [-$16.3, $33.1] | 0.70 | 0.713 | does not pass |
| PERIOD_OPEN | 167 / $8.9 | 143 / -$0.9 [-$27.6, $25.6] | -0.06 | 0.962 | does not pass |
(15 groups, 4 selected on Train; null distribution of the max Hold-Out t: 5th-95th pct 0.02 to 2.33)

### Table 2A-2 -- View 2: the pooled Mode 1 book partitioned by level family

| Level family | Train N | Hold-Out N | Stored mean $ (Train / HO) | True MTM mean @$1 (Train / HO) | True MTM mean @$4 Hold-Out [95% CI] | MTM win rate (Train / HO) | Time-expired share | Mean MTM P&L of time-expired trades @$1 |
|---|---|---|---|---|---|---|---|---|
| PD_CLOSE_MID | 27 | 32 | $32.9 / $15.0 | $25.8 / $10.7 | $7.7 [-$36.2, $48.4] | 74.1% / 68.8% | 6.8% | -$56.4 |
| FLOOR_PIVOTS | 70 | 61 | $23.9 / $3.3 | $17.1 / $0.4 | -$2.6 [-$36.1, $34.5] | 68.6% / 62.3% | 6.9% | -$14.1 |
| PERIOD_OPEN | 70 | 63 | $15.6 / $30.7 | $15.9 / $25.8 | $22.8 [-$21.4, $59.8] | 67.1% / 71.4% | 7.5% | $6.0 |
| POC | 13 | 15 | $20.0 / -$22.2 | $13.6 / -$22.2 | -$25.2 [-$87.2, $36.9] | 61.5% / 53.3% | 10.7% | -$27.5 |
| PRIOR_LOW | 22 | 26 | $10.5 / $26.9 | $10.7 / $27.6 | $24.6 [-$53.1, $90.8] | 63.6% / 73.1% | 6.3% | -$10.5 |
| IB_EDGE | 110 | 100 | $8.9 / -$8.1 | $8.0 / -$10.1 | -$13.1 [-$32.3, $5.0] | 69.1% / 60.0% | 6.7% | -$7.3 |
| PRIOR_HIGH | 22 | 23 | $5.8 / $22.4 | $7.9 / -$5.5 | -$8.5 [-$61.2, $41.2] | 63.6% / 60.9% | 8.9% | -$41.0 |
| IB_MID | 122 | 91 | $9.8 / $2.9 | $6.0 / $3.0 | $0.0 [-$20.5, $19.8] | 66.4% / 63.7% | 5.6% | -$37.5 |
| OR_MID | 70 | 55 | $1.6 / -$11.7 | -$0.2 / -$11.7 | -$14.7 [-$37.8, $7.2] | 64.3% / 60.0% | 6.4% | -$16.4 |
| VAH | 26 | 18 | $18.1 / $62.2 | -$2.5 / $45.1 | $42.1 [-$4.5, $81.7] | 57.7% / 77.8% | 18.2% | -$69.7 |
| OR_EDGE | 204 | 106 | -$7.2 / $13.0 | -$8.2 / $12.6 | $9.6 [-$10.0, $27.7] | 60.8% / 71.7% | 4.8% | -$16.6 |
| CAMARILLA | 91 | 108 | -$14.0 / -$10.3 | -$15.1 / -$10.3 | -$13.3 [-$33.0, $6.5] | 57.1% / 63.0% | 6.0% | -$27.8 |
| OVERNIGHT | 42 | 34 | -$23.0 / -$40.5 | -$34.5 / -$48.9 | -$51.9 [-$109.0, $1.9] | 52.4% / 50.0% | 15.8% | -$16.0 |
| VAL | 17 | 21 | -$19.9 / -$0.6 | -$37.4 / $2.3 | -$0.7 [-$75.4, $65.8] | 47.1% / 66.7% | 10.5% | -$58.6 |
| PERIOD_PIVOTS | 20 | 44 | -$43.4 / -$5.2 | -$43.4 / -$12.9 | -$15.9 [-$46.8, $13.0] | 45.0% / 59.1% | 1.6% | -$109.0 |

### Table 2B -- Touch_Seq on the pooled Mode 1 book (Seq 1 = no trigger at an earlier minute within 15.0 points of its level, same date and direction, over the full 5,324 trigger universe)

| Touch_Seq | Train N | Hold-Out N | Stored mean $ (Train / HO) | True MTM mean @$1 (Train / HO) | True MTM mean @$4 Hold-Out [95% CI] | MTM win rate (Train / HO) | Time-expired share | Mean MTM P&L of time-expired trades @$1 |
|---|---|---|---|---|---|---|---|---|
| 2+ | 152 | 105 | $13.5 / $4.9 | $9.6 / $1.2 | -$1.8 [-$25.0, $19.9] | 67.1% / 64.8% | 10.9% | -$21.8 |
| 1 | 774 | 692 | $0.1 / $2.3 | -$3.0 / -$0.6 | -$3.6 [-$12.2, $4.9] | 62.1% / 64.2% | 6.2% | -$25.5 |

Pass gate, Touch_Seq:
| Selected on Train (N>=20, mean>0) | Train N / mean | Hold-Out N / mean [95% CI] | Hold-Out t | max-T adjusted p | Verdict |
|---|---|---|---|---|---|
| 2+ | 152 / $9.6 | 105 / $1.2 [-$21.3, $22.8] | 0.11 | 0.687 | does not pass |
(2 groups, 1 selected on Train; null distribution of the max Hold-Out t: 5th-95th pct -0.74 to 2.08)

Touch_Seq by gap to the nearest earlier same-zone trigger (descriptive, Train + Hold-Out pooled):
| Group | N | MTM mean @$1 | MTM win rate |
|---|---|---|---|
| no earlier same-zone trigger (Seq 1) | 1466 | -$1.9 | 63.1% |
| 2+, nearest earlier trigger < 5 min before | 39 | $8.9 | 66.7% |
| 2+, 5-29 min before | 73 | $18.1 | 69.9% |
| 2+, >= 30 min before | 145 | -$0.5 | 64.1% |

macro variables: defined for m1 1723, m2 1723, m3 1723, m4 870 of 1723 pooled trades; Daily_ATR_14 median 312.9 points over 675 completed sessions in the bar history.

### Table 3A -- Macro variables by Train-cutoff quartile (Q1 lowest ... Q4 highest) on the pooled True-MTM Mode 1 book

| Variable | Quartile (Train cutoffs) | N (Train / Hold-Out) | True MTM win rate (T / HO) | Mean @$1 (T / HO) | Mean @$4 (T / HO) |
|---|---|---|---|---|---|
| Macro_Var_1 Session_VWAP_Anchor_Dist_ATR | Q1 (<=0.05) | 232 / 182 | 59.9% / 67.6% | -$8.8 / $1.7 | -$11.8 / -$1.3 |
| Macro_Var_1 Session_VWAP_Anchor_Dist_ATR | Q2 | 231 / 171 | 68.0% / 66.1% | $7.1 / $2.6 | $4.1 / -$0.4 |
| Macro_Var_1 Session_VWAP_Anchor_Dist_ATR | Q3 | 231 / 238 | 61.5% / 61.8% | -$5.0 / -$4.0 | -$8.0 / -$7.0 |
| Macro_Var_1 Session_VWAP_Anchor_Dist_ATR | Q4 (>0.30) | 232 / 206 | 62.5% / 62.6% | $2.9 / -$0.4 | -$0.1 / -$3.4 |
| Macro_Var_2 Opening_Drive_Net_Move_ATR | Q1 (<=-0.08) | 232 / 197 | 69.0% / 68.0% | $15.8 / $6.8 | $12.8 / $3.8 |
| Macro_Var_2 Opening_Drive_Net_Move_ATR | Q2 | 231 / 174 | 57.6% / 63.8% | -$16.7 / -$1.9 | -$19.7 / -$4.9 |
| Macro_Var_2 Opening_Drive_Net_Move_ATR | Q3 | 231 / 194 | 65.4% / 62.4% | $2.7 / -$7.4 | -$0.3 / -$10.4 |
| Macro_Var_2 Opening_Drive_Net_Move_ATR | Q4 (>0.30) | 232 / 232 | 59.9% / 62.9% | -$5.7 / $0.7 | -$8.7 / -$2.3 |
| Macro_Var_3 PD_Break_Dist_ATR | Q1 (<=-0.85) | 232 / 204 | 58.2% / 68.6% | -$9.6 / $11.5 | -$12.6 / $8.5 |
| Macro_Var_3 PD_Break_Dist_ATR | Q2 | 231 / 170 | 62.3% / 66.5% | -$3.8 / $2.5 | -$6.8 / -$0.5 |
| Macro_Var_3 PD_Break_Dist_ATR | Q3 | 231 / 181 | 64.1% / 60.2% | -$0.1 / -$10.5 | -$3.1 / -$13.5 |
| Macro_Var_3 PD_Break_Dist_ATR | Q4 (>-0.03) | 232 / 242 | 67.2% / 62.0% | $9.7 / -$4.8 | $6.7 / -$7.8 |
| Macro_Var_4 IB_Extension_Against (entries >= 10:30) | Q1 (<=-0.60) | 117 / 99 | 64.1% / 66.7% | $3.5 / $0.2 | $0.5 / -$2.8 |
| Macro_Var_4 IB_Extension_Against (entries >= 10:30) | Q2 | 117 / 76 | 68.4% / 61.8% | $9.8 / -$3.2 | $6.8 / -$6.2 |
| Macro_Var_4 IB_Extension_Against (entries >= 10:30) | Q3 | 117 / 121 | 59.0% / 58.7% | -$9.9 / -$8.6 | -$12.9 / -$11.6 |
| Macro_Var_4 IB_Extension_Against (entries >= 10:30) | Q4 (>0.13) | 117 / 106 | 67.5% / 65.1% | $17.0 / $3.8 | $14.0 / $0.8 |

### Table 3B -- Macro veto: tail chosen on Train (15% or 20% of the toxic side, the one minimizing the vetoed trades' Train mean @$1), frozen, applied to Hold-Out; flip of the vetoed trades at the trigger (original stop distance, 1.0R / 1.5R, True-MTM expiry)

| Variable | Frozen Train rule | Hold-Out vetoed | Vetoed True-MTM mean @$1 | All-trade mean (same trades) | Vetoed minus baseline [95% CI] | One-sided 98.75% upper bound (Bonferroni, 4 vars) | Random-veto placebo band @$1 (5th-95th) |
|---|---|---|---|---|---|---|---|
| Macro_Var_1 Session_VWAP_Anchor_Dist_ATR | 20% low tail, cut 0.033 (Train vetoed mean -$6.0, n 186) | 156 | $6.6 | -$0.4 | $7.0 [-$9.8, $23.8] | $26.4 | -$17.4 to $15.6 |
| Macro_Var_2 Opening_Drive_Net_Move_ATR | 20% high tail, cut 0.408 (Train vetoed mean -$3.6, n 186) | 181 | $7.0 | -$0.4 | $7.4 [-$8.2, $22.0] | $23.7 | -$15.2 to $14.1 |
| Macro_Var_3 PD_Break_Dist_ATR | 20% high tail, cut 0.099 (Train vetoed mean $8.6, n 186) | 197 | -$0.1 | -$0.4 | $0.2 [-$13.5, $13.5] | $16.5 | -$14.9 to $13.7 |
| Macro_Var_4 IB_Extension_Against (entries >= 10:30) | 20% high tail, cut 0.251 (Train vetoed mean $15.4, n 95) | 87 | $6.1 | -$2.2 | $8.3 [-$12.6, $30.2] | $33.0 | -$21.7 to $17.0 |

Hold-Out breakout flip of the vetoed trades:
| Variable | Target | Flips | Flip win rate @$1 | Flip mean @$1 | Flip mean @$4 [95% CI] | Random-flip placebo @$4 (5th-95th) | Verdict |
|---|---|---|---|---|---|---|---|
| Macro_Var_1 Session_VWAP_Anchor_Dist_ATR | 1R | 156 | 46.2% | -$11.2 | -$14.2 [-$39.2, $10.4] | -$28.5 to $13.7 | not viable |
| Macro_Var_1 Session_VWAP_Anchor_Dist_ATR | 1.5R | 156 | 39.7% | -$8.3 | -$11.3 [-$42.7, $21.3] | -$40.0 to $11.0 | not viable |
| Macro_Var_2 Opening_Drive_Net_Move_ATR | 1R | 181 | 47.5% | -$5.9 | -$8.9 [-$33.1, $14.0] | -$28.6 to $13.0 | not viable |
| Macro_Var_2 Opening_Drive_Net_Move_ATR | 1.5R | 181 | 37.0% | -$20.2 | -$23.2 [-$54.6, $6.8] | -$36.1 to $9.7 | not viable |
| Macro_Var_3 PD_Break_Dist_ATR | 1R | 197 | 49.7% | -$1.7 | -$4.7 [-$26.9, $17.2] | -$29.4 to $12.7 | not viable |
| Macro_Var_3 PD_Break_Dist_ATR | 1.5R | 197 | 41.6% | -$3.9 | -$6.9 [-$35.4, $21.5] | -$37.3 to $8.4 | not viable |
| Macro_Var_4 IB_Extension_Against (entries >= 10:30) | 1R | 87 | 41.4% | -$19.4 | -$22.4 [-$54.7, $10.9] | -$37.6 to $14.5 | not viable |
| Macro_Var_4 IB_Extension_Against (entries >= 10:30) | 1.5R | 87 | 29.9% | -$43.5 | -$46.5 [-$81.3, -$9.9] | -$46.3 to $13.0 | not viable |
Pass gate Macro_Var_1 Session_VWAP_Anchor_Dist_ATR: upper bound $26.4 (needs < 0), vetoed mean $6.6 vs placebo 5th pct -$17.4 -> DOES NOT PASS
Pass gate Macro_Var_2 Opening_Drive_Net_Move_ATR: upper bound $23.7 (needs < 0), vetoed mean $7.0 vs placebo 5th pct -$15.2 -> DOES NOT PASS
Pass gate Macro_Var_3 PD_Break_Dist_ATR: upper bound $16.5 (needs < 0), vetoed mean -$0.1 vs placebo 5th pct -$14.9 -> DOES NOT PASS
Pass gate Macro_Var_4 IB_Extension_Against (entries >= 10:30): upper bound $33.0 (needs < 0), vetoed mean $6.1 vs placebo 5th pct -$21.7 -> DOES NOT PASS
