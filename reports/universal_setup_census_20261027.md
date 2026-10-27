
### Table 1 -- Universal database census (tables carrying setup_type / setup_id; status flags: active_setups.origin_status = ACTIVE / SHADOW / BACKFILL / UNKNOWN, is_rth, resolution, *_basis flags)

| Source table / name | Environment | Session | Total raw rows | Date range | Unique setup IDs | Used for True MTM? |
|---|---|---|---|---|---|---|
| active_setups | Live (ACTIVE) | Globex / non-RTH | 483 | 2026-07-09 to 2026-10-23 | 34 | YES: native stop/target/expiry re-simulated |
| active_setups | Live (ACTIVE) | RTH | 1183 | 2026-07-09 to 2026-10-23 | 154 | YES: native stop/target/expiry re-simulated |
| active_setups | Backfill | Globex / non-RTH | 4132 | 2023-12-14 to 2026-07-28 | 6 | YES: native stop/target/expiry re-simulated |
| active_setups | Backfill | RTH | 11745 | 2023-11-16 to 2026-07-28 | 129 | YES: native stop/target/expiry re-simulated |
| active_setups | Shadow | Globex / non-RTH | 2334 | 2026-07-10 to 2026-10-27 | 177 | YES: native stop/target/expiry re-simulated |
| active_setups | Shadow | RTH | 6951 | 2026-07-09 to 2026-10-27 | 199 | YES: native stop/target/expiry re-simulated |
| active_setups | Unknown-origin (pre-2026-07-09) | Globex / non-RTH | 13 | 2026-06-18 to 2026-07-08 | 5 | YES: native stop/target/expiry re-simulated |
| active_setups | Unknown-origin (pre-2026-07-09) | RTH | 1470 | 2023-11-16 to 2026-07-08 | 68 | YES: native stop/target/expiry re-simulated |
| active_setups (ALL) | all four origins | Both | 28311 | 2023-11-16 to 2026-10-27 | 267 | (sum of the rows above) |
| gated_candidates priced (entry+stop+target) | Gated candidate (never entered) | Both | 20952 | 2026-08-12 to 2026-10-27 | 119 | YES: entry/stop/target, session-cap expiry |
| gated_candidates bookkeeping (no stop/target) | Gated candidate (never entered) | Both | 91549 | 2026-08-11 to 2026-10-27 | 204 | NO: no stop/target stored |
| setup_outcome_backtest | Backfill (derived) | n/a | 3545 | 2023-11-16 to 2026-06-19 | 97 | NO: every setup_id joins an active_setups row (duplicate, would double count) |
| acd_setup_events | Live+Backfill timeline | n/a | 12535 | 2023-03-06 to 2026-10-27 | 175 | NO: fired time and price only, no stop/target |
| order_placements | Live broker orders | n/a | 883 | 2026-09-28 to 2026-10-23 | 370 | NO: execution log keyed by active_setups.id (not a separate setup population) |
| trade_timeline_events | Timeline log | n/a | 9626 | 2026-06-16 to 2026-10-27 | 240 | NO: event log |
| dynamic_edges_mining | Statistics | n/a | 3639 | 2026-07-13 to 2026-10-26 | 58 | NO: aggregate statistics, no trades |
| setup_move_stats | Statistics | n/a | 5566 | 2024-11-18 to 2026-08-12 | 18 | NO: aggregate statistics |
| setup_daytype_winrates | Statistics | n/a | 170 | 2026-06-11 to 2026-06-15 | 26 | NO: aggregate statistics |
| trades | User's own trades | n/a | 32036 |  to  | 0 | NO: setup_type is NULL on every row; excluded by the standing rule (not signal evidence) |
| 61 *_backup_* snapshot tables | repair snapshots of the rows above | n/a | 85652 | n/a | n/a | NO: point-in-time copies of active_setups / timeline / orders rows |

### Table 1b -- Rows not simulated, by environment and reason (nothing is dropped silently); rows carrying a *_basis flag are included in the simulation

| Environment | Raw rows | Simulated | Mode 1 trades | Flagged-basis rows (included) | Included with session-cap expiry (stored expiry missing or before entry) | no bar at the fired minute | entry outside the fired bar range, not rescued by the +4/5h timestamp shift | roll week / sparse-bar window | entry outside the fired bar range (not an immediate fill) | no stop or target stored | stored: never entered (NOT_FILLED / NO_PRICE_DATA) | invalid geometry (stop or target on the wrong side of the entry) | no direction (name/price disagree or undefined) | session not complete in the data |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Backfill | 15877 | 7468 | 7466 | 2489 | 12 | 147 | 653 | 1936 | 0 | 0 | 0 | 0 | 0 | 0 |
| Unknown-origin (pre-2026-07-09) | 1483 | 1173 | 1172 | 136 | 19 | 6 | 0 | 204 | 96 | 4 | 0 | 0 | 0 | 0 |
| Live (ACTIVE) | 1666 | 1289 | 1163 | 46 | 8 | 3 | 0 | 33 | 152 | 5 | 184 | 0 | 0 | 0 |
| Shadow | 9285 | 6714 | 5756 | 457 | 70 | 8 | 0 | 409 | 2063 | 26 | 65 | 0 | 0 | 0 |
| Gated candidate (never entered) | 112501 | 14944 | 1108 | 0 | 0 | 263 | 0 | 1482 | 3561 | 0 | 0 | 327 | 223 | 152 |
| Backfill (timestamp-corrected +4/5h) | 5877 (subset of Backfill) | 5673 | 5673 | 3 | 1127 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
(gated_candidates: the 91549 bookkeeping rows without a stop or target are counted in Raw rows but are not in any later table)

simulated 37261 of 49263 priced rows; Mode 1 trades 22338; groups (setup x environment) 732; Train = trade date <= 2026-01-02.

### Table 2 -- Complete inventory: 861 (setup_id x environment) groups, sorted by total net at the $1 fee. Mode 1 dedup is within each group. Win rate = Net_$1 > 0. Hold-Out status uses the $1-fee mean; Hold-Out N < 5 -> Insufficient_Sample (evaluated on Train). Stored mean = the stored P&L (dynamic live exits / backfill $0-expiry) on the same trades.

| Setup ID | Environment | Raw N | Sim N | Mode 1 N | Train N | Hold-Out N | Train mean @$1 | Hold-Out mean @$1 | Mean @$1 | Mean @$4 [95% CI] | Win rate | Total net @$1 | Total net @$4 | Stored mean | Hold-Out status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ONH_FADE_SHORT | Backfill | 228 | 186 | 186 | 121 | 65 | $22.4 | $5.4 | $16.5 | $13.5 [-$5.7, $31.9] | 66.1% | $3067 | $2509 | $20.8 | Profitable |
| DAILY_OPEN_FADE_LONG | Backfill | 173 | 147 | 147 | 93 | 54 | $16.6 | $24.8 | $19.6 | $16.6 [-$8.3, $41.7] | 69.4% | $2886 | $2445 | $20.9 | Profitable |
| FLOOR_S3_FADE_LONG | Backfill | 45 | 37 | 37 | 18 | 19 | $81.4 | $48.2 | $64.3 | $61.3 [$14.4, $105.6] | 75.7% | $2381 | $2270 | $70.6 | Profitable |
| WEEKLY_OPEN_FADE_SHORT | Backfill | 68 | 60 | 60 | 35 | 25 | $12.7 | $56.2 | $30.8 | $27.8 [-$4.6, $59.0] | 65.0% | $1849 | $1669 | $40.0 | Profitable |
| C_STANDALONE_DOWN | Unknown-origin (pre-2026-07-09) | 189 | 150 | 150 | 97 | 53 | $27.6 | -$17.4 | $11.7 | $8.7 [-$16.1, $35.4] | 55.3% | $1758 | $1308 | $13.5 | Unprofitable |
| MONTHLY_OPEN_FADE_LONG | Backfill | 50 | 39 | 39 | 23 | 16 | $61.5 | $20.5 | $44.6 | $41.6 [-$6.9, $85.0] | 71.8% | $1741 | $1624 | $39.3 | Profitable |
| PY_VAH_FADE_SHORT | Backfill | 12 | 9 | 9 | 1 | 8 | $493.0 | $146.6 | $185.1 | $182.1 [$27.3, $353.0] | 66.7% | $1666 | $1639 | $66.6 | Profitable |
| IB_BEARISH | Unknown-origin (pre-2026-07-09) | 148 | 126 | 126 | 86 | 40 | $27.2 | -$17.8 | $12.9 | $9.9 [-$17.6, $36.7] | 53.2% | $1627 | $1249 | $5.6 | Unprofitable |
| CAM_R2_FADE_SHORT | Backfill | 141 | 117 | 117 | 71 | 46 | $11.1 | $18.0 | $13.8 | $10.8 [-$6.2, $26.9] | 71.8% | $1615 | $1264 | $15.3 | Profitable |
| PM_HIGH_FADE_LONG | Backfill | 31 | 24 | 24 | 17 | 7 | $73.3 | $47.5 | $65.8 | $62.8 [$17.6, $105.3] | 79.2% | $1579 | $1507 | $63.3 | Profitable |
| WEEKLY_OPEN_FADE_LONG | Backfill | 88 | 70 | 70 | 47 | 23 | $32.6 | -$6.2 | $19.9 | $16.9 [-$19.0, $48.9] | 70.0% | $1391 | $1181 | $20.8 | Unprofitable |
| CAM_S2_FADE_LONG | Backfill | 156 | 125 | 125 | 86 | 39 | $12.7 | $7.0 | $10.9 | $7.9 [-$10.5, $25.2] | 67.2% | $1366 | $991 | $9.9 | Profitable |
| PD_SESSION_MID_FADE_SHORT | Backfill | 89 | 71 | 71 | 43 | 28 | $28.2 | $2.6 | $18.1 | $15.1 [-$13.0, $40.9] | 69.0% | $1286 | $1073 | $19.6 | Profitable |
| IB_HIGH_FADE_SHORT | Shadow | 120 | 96 | 93 | 0 | 93 | n/a | $13.2 | $13.2 | $10.2 [-$7.3, $27.1] | 49.5% | $1230 | $951 | $13.7 | Profitable |
| MONTHLY_VWAP_FADE_LONG | Backfill | 96 | 81 | 81 | 54 | 27 | $20.0 | $5.2 | $15.1 | $12.1 [-$59.5, $78.0] | 58.0% | $1222 | $979 | -$52.0 | Profitable |
| PW_VAL_FADE_LONG | Backfill | 52 | 39 | 39 | 24 | 15 | $34.9 | $12.3 | $26.2 | $23.2 [-$26.9, $69.2] | 71.8% | $1021 | $904 | $29.0 | Profitable |
| PD_IB_MID_FADE_SHORT | Backfill | 87 | 72 | 72 | 47 | 25 | $12.2 | $17.0 | $13.9 | $10.9 [-$7.3, $26.7] | 73.6% | $999 | $783 | $13.0 | Profitable |
| PM_VAL_FADE_SHORT | Backfill | 23 | 20 | 20 | 8 | 12 | $26.0 | $64.5 | $49.1 | $46.1 [-$16.0, $99.4] | 70.0% | $982 | $922 | $55.8 | Profitable |
| OPEN_DRIVE_LONG | Shadow | 10 | 8 | 8 | 0 | 8 | n/a | $122.5 | $122.5 | $119.5 [$73.5, $186.0] | 100.0% | $980 | $956 | $121.5 | Profitable |
| TRT_LONG | Unknown-origin (pre-2026-07-09) | 42 | 33 | 33 | 17 | 16 | $16.6 | $43.6 | $29.7 | $26.7 [-$13.9, $65.5] | 60.6% | $979 | $880 | $40.5 | Profitable |
| PD_HIGH_FADE_SHORT | Backfill | 113 | 93 | 93 | 48 | 45 | $13.8 | $6.3 | $10.2 | $7.2 [-$19.0, $31.7] | 67.7% | $944 | $665 | $17.1 | Profitable |
| PW_HIGH_FADE_LONG | Backfill | 41 | 31 | 31 | 26 | 5 | $18.2 | $87.0 | $29.3 | $26.3 [-$9.0, $59.4] | 74.2% | $908 | $815 | $35.8 | Profitable |
| IB_HIGH_FADE_SHORT | Backfill | 263 | 210 | 210 | 131 | 79 | $8.7 | -$4.1 | $3.9 | $0.9 [-$9.3, $11.5] | 65.2% | $816 | $186 | $5.5 | Unprofitable |
| C_PAIRED_SHORT | Unknown-origin (pre-2026-07-09) | 7 | 6 | 6 | 0 | 6 | n/a | $135.2 | $135.2 | $132.2 [$39.4, $227.1] | 83.3% | $811 | $793 | $337.1 | Profitable |
| ONL_FADE_LONG | Shadow | 68 | 39 | 38 | 0 | 38 | n/a | $21.2 | $21.2 | $18.2 [-$5.6, $36.9] | 55.3% | $807 | $693 | $20.3 | Profitable |
| BRACKET_BREAKOUT_LONG | Unknown-origin (pre-2026-07-09) | 65 | 55 | 55 | 26 | 29 | -$27.9 | $52.7 | $14.6 | $11.6 [-$34.8, $60.2] | 43.6% | $804 | $639 | $12.5 | Profitable |
| PW_POC_FADE_SHORT_OVERNIGHT | Shadow | 20 | 17 | 17 | 0 | 17 | n/a | $46.9 | $46.9 | $43.9 [-$27.3, $119.2] | 52.9% | $798 | $747 | $44.8 | Profitable |
| FAILED_SWEEP_REVERSAL_LONG | Gated candidate (never entered) | 618 | 492 | 15 | 0 | 15 | n/a | $52.7 | $52.7 | $49.7 [-$25.9, $144.5] | 53.3% | $791 | $746 | n/a | Profitable |
| FAILED_SWEEP_REVERSAL_SHORT | Gated candidate (never entered) | 133 | 90 | 15 | 0 | 15 | n/a | $51.9 | $51.9 | $48.9 [-$22.7, $147.1] | 46.7% | $779 | $734 | n/a | Profitable |
| 10D_IB_MID_FADE_SHORT | Backfill | 43 | 34 | 34 | 13 | 21 | $3.1 | $34.5 | $22.5 | $19.5 [-$39.2, $73.1] | 64.7% | $765 | $663 | $36.6 | Profitable |
| MPP_FADE_SHORT | Backfill | 28 | 23 | 23 | 13 | 10 | $35.9 | $29.3 | $33.0 | $30.0 [-$7.9, $64.7] | 78.3% | $760 | $691 | $33.9 | Profitable |
| BRACKET_BREAKOUT_SHORT | Unknown-origin (pre-2026-07-09) | 20 | 10 | 10 | 10 | 0 | $73.2 | n/a | $73.2 | $70.2 [-$38.2, $227.7] | 30.0% | $732 | $702 | $22.2 | Insufficient_Sample (N < 5) |
| PM_LOW_FADE_SHORT | Backfill | 13 | 12 | 12 | 5 | 7 | $138.6 | $4.8 | $60.5 | $57.5 [-$44.4, $139.8] | 75.0% | $727 | $691 | $65.9 | Profitable |
| GLOBEX_FLUSH_SHORT | Shadow | 12 | 8 | 8 | 0 | 8 | n/a | $90.5 | $90.5 | $87.5 [-$116.4, $256.5] | 50.0% | $724 | $700 | $97.6 | Profitable |
| PW_VAL_FADE_SHORT | Shadow | 47 | 31 | 30 | 0 | 30 | n/a | $24.0 | $24.0 | $21.0 [-$7.9, $49.1] | 63.3% | $720 | $630 | $12.2 | Profitable |
| IB_LOW_FADE_LONG | Shadow | 94 | 75 | 55 | 0 | 55 | n/a | $13.0 | $13.0 | $10.0 [-$11.1, $31.5] | 52.7% | $713 | $548 | $13.4 | Profitable |
| IB_HIGH_FADE_SHORT | Live (ACTIVE) | 36 | 32 | 25 | 0 | 25 | n/a | $28.4 | $28.4 | $25.4 [$0.4, $53.6] | 68.0% | $710 | $635 | $7.5 | Profitable |
| OR30_LOW_FADE_LONG | Shadow | 42 | 31 | 31 | 0 | 31 | n/a | $21.4 | $21.4 | $18.4 [-$1.1, $37.9] | 61.3% | $665 | $572 | $24.5 | Profitable |
| POC_ROTATION_JOIN_LONG | Shadow | 92 | 81 | 80 | 0 | 80 | n/a | $8.2 | $8.2 | $5.2 [-$16.2, $26.2] | 38.8% | $657 | $417 | $12.3 | Profitable |
| STOP_SWEEP_SHORT | Shadow | 62 | 60 | 54 | 0 | 54 | n/a | $12.1 | $12.1 | $9.1 [-$8.9, $24.0] | 68.5% | $652 | $490 | $9.3 | Profitable |
| POC_ROTATION_JOIN_SHORT | Shadow | 91 | 79 | 78 | 0 | 78 | n/a | $8.2 | $8.2 | $5.2 [-$12.1, $23.4] | 38.5% | $639 | $405 | $4.5 | Profitable |
| PD_VAL_FADE_LONG | Shadow | 94 | 77 | 70 | 0 | 70 | n/a | $9.1 | $9.1 | $6.1 [-$11.9, $23.4] | 54.3% | $637 | $427 | $7.5 | Profitable |
| FLOOR_PIVOT_FADE_SHORT_OVERNIGHT | Shadow | 10 | 10 | 10 | 0 | 10 | n/a | $61.0 | $61.0 | $58.0 [$56.0, $76.5] | 60.0% | $611 | $581 | $59.7 | Profitable |
| PM_VAH_FADE_SHORT | Backfill | 19 | 16 | 16 | 6 | 10 | -$6.4 | $63.3 | $37.2 | $34.2 [-$35.9, $98.0] | 68.8% | $595 | $547 | $58.2 | Profitable |
| GLOBEX_VWAP_FADE_LONG | Backfill (timestamp-corrected +4/5h) | 115 | 115 | 115 | 67 | 48 | $10.4 | -$2.3 | $5.1 | $2.1 [-$22.7, $25.8] | 67.8% | $587 | $242 | $1.4 | Unprofitable |
| PM_HIGH_FADE_SHORT | Backfill | 32 | 24 | 24 | 10 | 14 | $33.9 | $17.6 | $24.4 | $21.4 [-$29.0, $67.8] | 62.5% | $586 | $514 | $24.2 | Profitable |
| FLOOR_PIVOT_FADE_LONG | Backfill | 131 | 104 | 104 | 72 | 32 | $12.4 | -$9.9 | $5.5 | $2.5 [-$20.9, $25.8] | 62.5% | $574 | $262 | $7.5 | Unprofitable |
| A_UP_STRONG | Shadow | 33 | 26 | 25 | 0 | 25 | n/a | $22.6 | $22.6 | $19.6 [-$31.3, $144.5] | 36.0% | $565 | $490 | $23.0 | Profitable |
| OR5_HIGH_FADE_SHORT | Live (ACTIVE) | 28 | 23 | 22 | 0 | 22 | n/a | $25.3 | $25.3 | $22.3 [-$13.5, $64.8] | 50.0% | $558 | $492 | -$0.3 | Profitable |
| GLOBEX_FLUSH_REVERSAL_SHORT | Shadow | 5 | 5 | 5 | 0 | 5 | n/a | $105.1 | $105.1 | $102.1 [-$152.7, $344.7] | 60.0% | $526 | $511 | $104.1 | Profitable |
| WEEKLY_OPEN_FADE_SHORT | Shadow | 58 | 48 | 46 | 0 | 46 | n/a | $11.4 | $11.4 | $8.4 [-$11.3, $31.7] | 58.7% | $523 | $385 | $13.2 | Profitable |
| RTH_VWAP_FADE_SHORT | Live (ACTIVE) | 12 | 7 | 7 | 0 | 7 | n/a | $73.6 | $73.6 | $70.6 [$7.0, $96.0] | 85.7% | $515 | $494 | $92.2 | Profitable |
| OR5_MID_FADE_LONG | Shadow | 83 | 50 | 50 | 0 | 50 | n/a | $10.3 | $10.3 | $7.3 [-$10.9, $26.4] | 48.0% | $514 | $364 | $15.0 | Profitable |
| VALUE_AREA_RESPONSIVE_SHORT | Shadow | 17 | 17 | 17 | 0 | 17 | n/a | $30.0 | $30.0 | $27.0 [-$9.0, $56.6] | 64.7% | $511 | $460 | $28.5 | Profitable |
| FLOOR_S1_FADE_SHORT | Backfill | 30 | 22 | 22 | 11 | 11 | $44.5 | $1.1 | $22.8 | $19.8 [-$23.6, $63.3] | 72.7% | $502 | $436 | $22.8 | Profitable |
| CAM_S1_FADE_LONG | Shadow | 63 | 39 | 35 | 0 | 35 | n/a | $13.8 | $13.8 | $10.8 [-$15.2, $33.0] | 62.9% | $484 | $379 | $15.4 | Profitable |
| PD_CLOSE_FADE_LONG | Shadow | 67 | 40 | 40 | 0 | 40 | n/a | $11.9 | $11.9 | $8.9 [-$4.8, $27.7] | 52.5% | $475 | $355 | $13.0 | Profitable |
| FLOOR_R1_FADE_SHORT | Backfill | 145 | 119 | 119 | 72 | 47 | $17.3 | -$16.4 | $4.0 | $1.0 [-$15.7, $17.3] | 66.4% | $472 | $115 | $6.7 | Unprofitable |
| FLOOR_S3_FADE_SHORT | Backfill | 7 | 5 | 5 | 2 | 3 | $7.3 | $151.8 | $94.0 | $91.0 [$13.5, $148.8] | 80.0% | $470 | $455 | $91.1 | Insufficient_Sample (N < 5) |
| RTH_FLUSH_SHORT | Shadow | 9 | 9 | 9 | 0 | 9 | n/a | $51.5 | $51.5 | $48.5 [-$81.1, $151.6] | 66.7% | $464 | $437 | $51.8 | Profitable |
| PD_IB_MID_FADE_SHORT | Shadow | 57 | 47 | 43 | 0 | 43 | n/a | $10.5 | $10.5 | $7.5 [-$15.3, $28.2] | 48.8% | $450 | $321 | $14.1 | Profitable |
| CAM_S2_FADE_LONG_OVERNIGHT | Shadow | 11 | 10 | 10 | 0 | 10 | n/a | $44.0 | $44.0 | $41.0 [-$94.0, $155.2] | 50.0% | $440 | $410 | $27.9 | Profitable |
| WPP_FADE_LONG | Backfill | 64 | 50 | 50 | 28 | 22 | $9.6 | $7.7 | $8.7 | $5.7 [-$18.3, $29.8] | 72.0% | $436 | $286 | $9.2 | Profitable |
| FLOOR_S3_FADE_SHORT | Shadow | 14 | 8 | 8 | 0 | 8 | n/a | $54.0 | $54.0 | $51.0 [-$4.4, $81.6] | 75.0% | $432 | $408 | $18.2 | Profitable |
| C_STANDALONE_UP | Shadow | 5 | 4 | 4 | 0 | 4 | n/a | $106.4 | $106.4 | $103.4 [n<5] | 75.0% | $426 | $414 | $122.0 | Insufficient_Sample (N < 5) |
| FLOOR_R3_FADE_SHORT | Backfill | 35 | 27 | 27 | 19 | 8 | $6.0 | $37.8 | $15.4 | $12.4 [-$23.5, $44.6] | 66.7% | $416 | $335 | $20.6 | Profitable |
| OPEN_DRIVE_SHORT | Unknown-origin (pre-2026-07-09) | 46 | 29 | 29 | 23 | 6 | $33.1 | -$58.7 | $14.1 | $11.1 [-$26.7, $47.8] | 55.2% | $410 | $323 | $9.5 | Unprofitable |
| 5D_OR_MID_FADE_SHORT | Shadow | 38 | 27 | 27 | 0 | 27 | n/a | $15.1 | $15.1 | $12.1 [-$15.2, $39.9] | 51.9% | $409 | $328 | $8.2 | Profitable |
| PD_POC_FADE_LONG | Shadow | 64 | 53 | 47 | 0 | 47 | n/a | $8.4 | $8.4 | $5.4 [-$14.0, $24.4] | 46.8% | $395 | $254 | $8.5 | Profitable |
| GLOBEX_VWAP_FADE_SHORT | Live (ACTIVE) | 38 | 34 | 33 | 0 | 33 | n/a | $12.0 | $12.0 | $9.0 [-$13.0, $34.6] | 51.5% | $395 | $296 | $18.5 | Profitable |
| ONL_FADE_SHORT | Shadow | 46 | 29 | 29 | 0 | 29 | n/a | $13.6 | $13.6 | $10.6 [-$21.9, $38.0] | 51.7% | $394 | $307 | $9.3 | Profitable |
| IB_BULLISH | Live (ACTIVE) | 73 | 72 | 42 | 0 | 42 | n/a | $9.3 | $9.3 | $6.3 [-$25.1, $61.0] | 59.5% | $392 | $266 | $22.3 | Profitable |
| MONTHLY_VWAP_FADE_SHORT | Backfill | 80 | 67 | 67 | 39 | 28 | -$30.9 | $56.8 | $5.8 | $2.8 [-$64.4, $76.5] | 44.8% | $387 | $186 | $44.6 | Profitable |
| CAM_S3_FADE_LONG | Backfill | 148 | 121 | 121 | 84 | 37 | $2.0 | $5.6 | $3.1 | $0.1 [-$21.3, $20.5] | 67.8% | $374 | $11 | $4.7 | Profitable |
| FLOOR_R2_FADE_SHORT | Shadow | 49 | 37 | 37 | 0 | 37 | n/a | $9.8 | $9.8 | $6.8 [-$10.9, $23.8] | 54.1% | $363 | $252 | $7.9 | Profitable |
| PW_LOW_FADE_SHORT | Backfill | 19 | 16 | 16 | 8 | 8 | $62.2 | -$17.5 | $22.3 | $19.3 [-$65.2, $100.8] | 68.8% | $358 | $310 | $30.0 | Unprofitable |
| PD_LOW_FADE_SHORT | Shadow | 39 | 23 | 23 | 0 | 23 | n/a | $15.5 | $15.5 | $12.5 [-$12.9, $41.5] | 52.2% | $356 | $287 | $10.5 | Profitable |
| PW_HIGH_FADE_LONG_OVERNIGHT | Shadow | 5 | 4 | 4 | 0 | 4 | n/a | $87.1 | $87.1 | $84.1 [n<5] | 75.0% | $349 | $337 | $88.8 | Insufficient_Sample (N < 5) |
| 5D_OR_MID_FADE_SHORT | Backfill | 56 | 44 | 44 | 26 | 18 | $21.7 | -$12.3 | $7.8 | $4.8 [-$20.4, $28.6] | 70.5% | $343 | $211 | $7.8 | Unprofitable |
| OPEN_TEST_DRIVE_LONG | Gated candidate (never entered) | 10030 | 7230 | 353 | 0 | 353 | n/a | $0.9 | $0.9 | -$2.1 [-$8.8, $3.1] | 48.4% | $335 | -$725 | n/a | Profitable |
| OPEN_DRIVE_LONG | Live (ACTIVE) | 4 | 4 | 4 | 0 | 4 | n/a | $83.0 | $83.0 | $80.0 [n<5] | 100.0% | $332 | $320 | $78.6 | Insufficient_Sample (N < 5) |
| PD_VAL_FADE_SHORT | Backfill | 70 | 57 | 57 | 34 | 23 | -$14.2 | $35.2 | $5.8 | $2.8 [-$28.7, $30.5] | 66.7% | $328 | $157 | $9.4 | Profitable |
| OR30_MID_FADE_LONG | Shadow | 38 | 22 | 22 | 0 | 22 | n/a | $14.7 | $14.7 | $11.7 [-$23.7, $44.9] | 54.5% | $324 | $258 | $8.8 | Profitable |
| PM_VAH_FADE_LONG_OVERNIGHT | Shadow | 3 | 3 | 3 | 0 | 3 | n/a | $107.3 | $107.3 | $104.3 [n<5] | 66.7% | $322 | $313 | $106.3 | Insufficient_Sample (N < 5) |
| FLOOR_S2_FADE_SHORT | Shadow | 30 | 19 | 19 | 0 | 19 | n/a | $16.5 | $16.5 | $13.5 [-$21.6, $42.8] | 63.2% | $313 | $256 | $23.0 | Profitable |
| 5D_OR_MID_FADE_LONG | Backfill | 63 | 52 | 52 | 35 | 17 | $11.6 | -$5.6 | $6.0 | $3.0 [-$20.9, $24.6] | 71.2% | $310 | $154 | $7.5 | Unprofitable |
| PW_VAL_FADE_SHORT | Backfill | 35 | 26 | 26 | 15 | 11 | $37.8 | -$23.6 | $11.8 | $8.8 [-$51.2, $67.6] | 61.5% | $307 | $229 | $20.9 | Unprofitable |
| VALUE_AREA_RESPONSIVE_LONG | Unknown-origin (pre-2026-07-09) | 56 | 44 | 44 | 33 | 11 | $11.2 | -$6.2 | $6.9 | $3.9 [-$17.1, $25.9] | 31.8% | $302 | $170 | $19.4 | Unprofitable |
| OR10_HIGH_FADE_LONG | Live (ACTIVE) | 16 | 12 | 12 | 0 | 12 | n/a | $24.8 | $24.8 | $21.8 [-$24.2, $58.2] | 50.0% | $298 | $262 | $22.6 | Profitable |
| WPP_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 4 | 4 | 4 | 0 | 4 | n/a | $74.5 | $74.5 | $71.5 [n<5] | 75.0% | $298 | $286 | $85.5 | Insufficient_Sample (N < 5) |
| WPP_FADE_LONG | Shadow | 51 | 37 | 30 | 0 | 30 | n/a | $9.9 | $9.9 | $6.9 [-$21.0, $35.3] | 56.7% | $297 | $207 | $11.7 | Profitable |
| CAM_S4_FADE_SHORT | Backfill | 33 | 26 | 26 | 10 | 16 | $29.1 | $0.3 | $11.4 | $8.4 [-$30.9, $47.7] | 73.1% | $296 | $218 | $11.4 | Profitable |
| TRT_MAH_SHORT | Unknown-origin (pre-2026-07-09) | 8 | 6 | 6 | 2 | 4 | -$17.3 | $81.3 | $48.4 | $45.4 [-$88.8, $270.0] | 16.7% | $291 | $273 | $48.4 | Insufficient_Sample (N < 5) |
| 3M_POC_FADE_SHORT | Shadow | 44 | 33 | 33 | 0 | 33 | n/a | $8.7 | $8.7 | $5.7 [-$17.7, $32.3] | 60.6% | $289 | $190 | $11.2 | Profitable |
| POC_ROTATION_JOIN_SHORT | Live (ACTIVE) | 18 | 13 | 10 | 0 | 10 | n/a | $28.9 | $28.9 | $25.9 [-$79.1, $150.3] | 40.0% | $289 | $259 | -$49.0 | Profitable |
| PD_CLOSE_FADE_SHORT | Shadow | 80 | 54 | 47 | 0 | 47 | n/a | $6.1 | $6.1 | $3.1 [-$14.7, $29.3] | 44.7% | $287 | $146 | $1.9 | Profitable |
| A_DOWN_WEAK | Shadow | 21 | 20 | 17 | 0 | 17 | n/a | $16.2 | $16.2 | $13.2 [-$28.1, $54.6] | 64.7% | $276 | $225 | $13.6 | Profitable |
| WR1_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | $89.0 | $89.0 | $86.0 [n<5] | 66.7% | $267 | $258 | $88.0 | Insufficient_Sample (N < 5) |
| CAM_S1_FADE_LONG | Live (ACTIVE) | 6 | 5 | 5 | 0 | 5 | n/a | $53.0 | $53.0 | $50.0 [$32.7, $76.0] | 80.0% | $265 | $250 | $49.5 | Profitable |
| PD_SESSION_MID_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 6 | 6 | 6 | 0 | 6 | n/a | $44.0 | $44.0 | $41.0 [$14.0, $176.0] | 50.0% | $264 | $246 | $44.7 | Profitable |
| MS1_FADE_LONG_OVERNIGHT | Shadow | 7 | 6 | 6 | 0 | 6 | n/a | $44.0 | $44.0 | $41.0 [$14.0, $176.0] | 50.0% | $264 | $246 | $43.0 | Profitable |
| FLOOR_S3_FADE_SHORT | Live (ACTIVE) | 4 | 3 | 3 | 0 | 3 | n/a | $85.0 | $85.0 | $82.0 [n<5] | 100.0% | $255 | $246 | $39.2 | Insufficient_Sample (N < 5) |
| CAM_S2_FADE_LONG_TRAIL | Shadow | 52 | 36 | 36 | 0 | 36 | n/a | $6.9 | $6.9 | $3.9 [-$26.3, $35.8] | 55.6% | $249 | $141 | $8.0 | Profitable |
| PW_VAH_FADE_SHORT | Shadow | 25 | 11 | 9 | 0 | 9 | n/a | $27.7 | $27.7 | $24.7 [-$38.0, $72.8] | 66.7% | $249 | $222 | $30.4 | Profitable |
| GLOBEX_VWAP_FADE_LONG | Gated candidate (never entered) | 8229 | 94 | 20 | 0 | 20 | n/a | $12.3 | $12.3 | $9.3 [-$17.8, $26.2] | 70.0% | $246 | $186 | n/a | Profitable |
| FLOOR_R1_FADE_SHORT_OVERNIGHT | Shadow | 8 | 8 | 8 | 0 | 8 | n/a | $30.6 | $30.6 | $27.6 [-$2.8, $41.0] | 50.0% | $245 | $221 | $32.1 | Profitable |
| PD2_VAH_FADE_LONG | Gated candidate (never entered) | 35 | 11 | 3 | 0 | 3 | n/a | $81.0 | $81.0 | $78.0 [n<5] | 100.0% | $243 | $234 | n/a | Insufficient_Sample (N < 5) |
| PD_POC_FADE_SHORT_TRAIL | Shadow | 25 | 20 | 20 | 0 | 20 | n/a | $12.1 | $12.1 | $9.1 [-$21.1, $33.9] | 70.0% | $242 | $182 | $0.7 | Profitable |
| GLOBEX_VWAP_FADE_SHORT | Backfill | 82 | 5 | 5 | 4 | 1 | $40.6 | $79.0 | $48.3 | $45.3 [-$0.1, $76.0] | 80.0% | $242 | $227 | -$25.0 | Insufficient_Sample (N < 5) |
| IB_HIGH_FADE_LONG | Backfill | 6 | 4 | 4 | 1 | 3 | $59.8 | $59.8 | $59.8 | $56.8 [n<5] | 100.0% | $239 | $227 | $59.8 | Insufficient_Sample (N < 5) |
| PD_VAH_FADE_LONG | Backfill | 105 | 84 | 84 | 57 | 27 | -$13.7 | $37.8 | $2.8 | -$0.2 [-$20.9, $21.0] | 63.1% | $238 | -$14 | $3.8 | Profitable |
| STACK_VOL_BREAK_LIVE_LONG | Shadow | 32 | 27 | 27 | 0 | 27 | n/a | $8.7 | $8.7 | $5.7 [-$31.0, $46.7] | 48.1% | $234 | $153 | $5.9 | Profitable |
| STOP_SWEEP_LONG | Shadow | 117 | 117 | 59 | 0 | 59 | n/a | $3.9 | $3.9 | $0.9 [-$14.8, $16.5] | 59.3% | $233 | $56 | $2.3 | Profitable |
| DAILY_OPEN_FADE_SHORT | Shadow | 12 | 7 | 7 | 0 | 7 | n/a | $33.0 | $33.0 | $30.0 [-$68.0, $70.0] | 71.4% | $231 | $210 | $32.0 | Profitable |
| MONTHLY_OPEN_FADE_SHORT | Shadow | 9 | 6 | 6 | 0 | 6 | n/a | $37.8 | $37.8 | $34.8 [$1.0, $51.8] | 66.7% | $227 | $209 | $37.8 | Profitable |
| WR1_FADE_LONG | Shadow | 13 | 8 | 8 | 0 | 8 | n/a | $28.3 | $28.3 | $25.3 [$5.0, $60.4] | 62.5% | $227 | $203 | $27.3 | Profitable |
| CAM_R4_FADE_SHORT | Shadow | 43 | 28 | 26 | 0 | 26 | n/a | $8.7 | $8.7 | $5.7 [-$24.8, $40.0] | 50.0% | $226 | $148 | $4.1 | Profitable |
| GLOBEX_VWAP_FADE_SHORT | Gated candidate (never entered) | 7949 | 171 | 15 | 0 | 15 | n/a | $15.0 | $15.0 | $12.0 [-$3.1, $29.2] | 53.3% | $226 | $181 | n/a | Profitable |
| FLOOR_PIVOT_FADE_SHORT | Backfill | 95 | 79 | 79 | 48 | 31 | -$11.6 | $25.1 | $2.8 | -$0.2 [-$26.5, $24.5] | 59.5% | $222 | -$15 | $5.8 | Profitable |
| 2D_POC_FADE_SHORT | Shadow | 19 | 6 | 6 | 0 | 6 | n/a | $35.7 | $35.7 | $32.7 [-$35.4, $76.0] | 83.3% | $214 | $196 | $34.7 | Profitable |
| PD_OR_MID_FADE_SHORT | Backfill | 86 | 71 | 71 | 48 | 23 | $0.7 | $7.8 | $3.0 | -$0.0 [-$27.2, $26.1] | 60.6% | $212 | -$1 | $5.3 | Profitable |
| PD_VAH_FADE_SHORT | Backfill | 122 | 99 | 99 | 61 | 38 | -$2.1 | $8.9 | $2.1 | -$0.9 [-$20.4, $19.0] | 62.6% | $209 | -$88 | $5.1 | Profitable |
| OR15_MID_FADE_SHORT | Shadow | 32 | 20 | 20 | 0 | 20 | n/a | $10.4 | $10.4 | $7.4 [-$24.6, $37.5] | 45.0% | $208 | $148 | $5.7 | Profitable |
| FLOOR_R3_FADE_SHORT | Shadow | 17 | 13 | 13 | 0 | 13 | n/a | $15.8 | $15.8 | $12.8 [-$37.7, $34.1] | 53.8% | $205 | $166 | $5.9 | Profitable |
| C_PAIRED_LONG | Shadow | 126 | 116 | 57 | 0 | 57 | n/a | $3.6 | $3.6 | $0.6 [-$33.8, $45.9] | 47.4% | $204 | $33 | $2.1 | Profitable |
| VWAP_MAGNET_LONG | Gated candidate (never entered) | 43 | 29 | 22 | 0 | 22 | n/a | $9.2 | $9.2 | $6.2 [-$15.0, $22.2] | 59.1% | $202 | $136 | n/a | Profitable |
| TRT_MAH_SHORT | Shadow | 3 | 2 | 2 | 0 | 2 | n/a | $98.8 | $98.8 | $95.8 [n<5] | 100.0% | $198 | $192 | $94.0 | Insufficient_Sample (N < 5) |
| OR5_HIGH_FADE_LONG | Live (ACTIVE) | 12 | 8 | 8 | 0 | 8 | n/a | $24.5 | $24.5 | $21.5 [-$31.1, $72.5] | 62.5% | $196 | $172 | $27.1 | Profitable |
| VALUE_AREA_RESPONSIVE_SHORT | Live (ACTIVE) | 6 | 6 | 6 | 0 | 6 | n/a | $32.3 | $32.3 | $29.3 [$8.0, $72.0] | 66.7% | $194 | $176 | $31.0 | Profitable |
| 5D_OR_MID_FADE_SHORT | Gated candidate (never entered) | 31 | 7 | 3 | 0 | 3 | n/a | $64.7 | $64.7 | $61.7 [n<5] | 100.0% | $194 | $185 | n/a | Insufficient_Sample (N < 5) |
| FLOOR_S1_FADE_LONG_OVERNIGHT | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | $95.3 | $95.3 | $92.3 [n<5] | 100.0% | $191 | $185 | $98.0 | Insufficient_Sample (N < 5) |
| MONTHLY_OPEN_FADE_SHORT | Backfill | 36 | 32 | 32 | 19 | 13 | $18.8 | -$12.9 | $5.9 | $2.9 [-$51.0, $54.3] | 53.1% | $190 | $94 | $13.9 | Unprofitable |
| OR5_HIGH_FADE_LONG | Backfill | 14 | 11 | 11 | 3 | 8 | -$75.3 | $51.7 | $17.0 | $14.0 [-$49.9, $56.7] | 72.7% | $188 | $155 | $17.0 | Profitable |
| PD_VAL_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 2 | 2 | 2 | 0 | 2 | n/a | $92.0 | $92.0 | $89.0 [n<5] | 100.0% | $184 | $178 | $92.0 | Insufficient_Sample (N < 5) |
| FLOOR_PIVOT_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 2 | 2 | 2 | 0 | 2 | n/a | $92.0 | $92.0 | $89.0 [n<5] | 100.0% | $184 | $178 | $92.0 | Insufficient_Sample (N < 5) |
| OR15_LOW_FADE_LONG | Gated candidate (never entered) | 110 | 20 | 3 | 0 | 3 | n/a | $59.8 | $59.8 | $56.8 [n<5] | 100.0% | $180 | $171 | n/a | Insufficient_Sample (N < 5) |
| MONTHLY_OPEN_SWEEP_REVERSAL_SHORT_OVERNIGHT | Shadow | 2 | 1 | 1 | 0 | 1 | n/a | $179.0 | $179.0 | $176.0 [n<5] | 100.0% | $179 | $176 | $178.0 | Insufficient_Sample (N < 5) |
| FLOOR_S3_FADE_SHORT_OVERNIGHT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | $179.0 | $179.0 | $176.0 [n<5] | 100.0% | $179 | $176 | $178.0 | Insufficient_Sample (N < 5) |
| MONTHLY_OPEN_FADE_SHORT_OVERNIGHT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | $179.0 | $179.0 | $176.0 [n<5] | 100.0% | $179 | $176 | $178.0 | Insufficient_Sample (N < 5) |
| PW_LOW_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 7 | 4 | 4 | 0 | 4 | n/a | $44.0 | $44.0 | $41.0 [n<5] | 50.0% | $176 | $164 | $82.1 | Insufficient_Sample (N < 5) |
| PD2_VAL_FADE_SHORT | Shadow | 34 | 20 | 10 | 0 | 10 | n/a | $17.5 | $17.5 | $14.5 [-$96.0, $80.0] | 80.0% | $175 | $145 | $10.8 | Profitable |
| OR15_LOW_FADE_SHORT | Shadow | 14 | 4 | 4 | 0 | 4 | n/a | $43.5 | $43.5 | $40.5 [n<5] | 75.0% | $174 | $162 | $5.0 | Insufficient_Sample (N < 5) |
| GLOBEX_VWAP_MAGNET_SHORT | Backfill | 179 | 8 | 7 | 0 | 7 | n/a | $24.7 | $24.7 | $21.7 [-$1.5, $36.0] | 85.7% | $173 | $152 | $4.9 | Profitable |
| PD2_VAL_FADE_LONG | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | $83.0 | $83.0 | $80.0 [n<5] | 100.0% | $166 | $160 | -$2.0 | Insufficient_Sample (N < 5) |
| OPEN_DRIVE_LONG | Gated candidate (never entered) | 3 | 2 | 2 | 0 | 2 | n/a | $83.0 | $83.0 | $80.0 [n<5] | 100.0% | $166 | $160 | n/a | Insufficient_Sample (N < 5) |
| PW_HIGH_FADE_LONG_TRAIL | Shadow | 8 | 6 | 6 | 0 | 6 | n/a | $27.0 | $27.0 | $24.0 [-$68.0, $70.0] | 66.7% | $162 | $144 | $20.1 | Profitable |
| FLOOR_S2_FADE_LONG | Live (ACTIVE) | 7 | 4 | 4 | 0 | 4 | n/a | $40.5 | $40.5 | $37.5 [n<5] | 75.0% | $162 | $150 | $4.0 | Insufficient_Sample (N < 5) |
| CAM_R2_FADE_LONG | Gated candidate (never entered) | 22 | 2 | 2 | 0 | 2 | n/a | $80.3 | $80.3 | $77.3 [n<5] | 100.0% | $161 | $155 | n/a | Insufficient_Sample (N < 5) |
| FLOOR_R1_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 2 | 2 | 2 | 0 | 2 | n/a | $79.0 | $79.0 | $76.0 [n<5] | 100.0% | $158 | $152 | $79.0 | Insufficient_Sample (N < 5) |
| CAM_R2_FADE_SHORT | Live (ACTIVE) | 4 | 2 | 2 | 0 | 2 | n/a | $79.0 | $79.0 | $76.0 [n<5] | 100.0% | $158 | $152 | $78.0 | Insufficient_Sample (N < 5) |
| PD_HIGH_FADE_LONG | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | $79.0 | $79.0 | $76.0 [n<5] | 100.0% | $158 | $152 | $78.0 | Insufficient_Sample (N < 5) |
| FLOOR_R3_FADE_LONG | Backfill | 4 | 4 | 4 | 1 | 3 | -$112.3 | $89.5 | $39.1 | $36.1 [n<5] | 75.0% | $156 | $144 | $39.1 | Insufficient_Sample (N < 5) |
| 3M_VAL_FADE_LONG | Shadow | 20 | 12 | 2 | 0 | 2 | n/a | $77.3 | $77.3 | $74.3 [n<5] | 100.0% | $155 | $149 | $48.0 | Insufficient_Sample (N < 5) |
| PD_IB_HIGH_FADE_SHORT | Shadow | 52 | 34 | 30 | 0 | 30 | n/a | $5.1 | $5.1 | $2.1 [-$16.6, $25.1] | 56.7% | $152 | $62 | $6.3 | Profitable |
| WS1_FADE_SHORT_OVERNIGHT | Shadow | 12 | 8 | 8 | 0 | 8 | n/a | $19.0 | $19.0 | $16.0 [-$26.0, $64.3] | 50.0% | $152 | $128 | $18.0 | Profitable |
| IB_LOW_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 3 | 3 | 3 | 0 | 3 | n/a | $50.0 | $50.0 | $47.0 [n<5] | 66.7% | $150 | $141 | $50.0 | Insufficient_Sample (N < 5) |
| WR2_FADE_LONG | Shadow | 5 | 2 | 2 | 0 | 2 | n/a | $75.0 | $75.0 | $72.0 [n<5] | 100.0% | $150 | $144 | $74.0 | Insufficient_Sample (N < 5) |
| PW_VAL_FADE_LONG_OVERNIGHT | Live (ACTIVE) | 6 | 5 | 5 | 0 | 5 | n/a | $29.8 | $29.8 | $26.8 [-$72.7, $176.0] | 40.0% | $149 | $134 | $32.2 | Profitable |
| OR10_LOW_FADE_LONG | Shadow | 46 | 34 | 34 | 0 | 34 | n/a | $4.4 | $4.4 | $1.4 [-$20.9, $20.1] | 55.9% | $149 | $47 | $9.5 | Profitable |
| VALUE_AREA_RESPONSIVE_SHORT | Gated candidate (never entered) | 34 | 12 | 4 | 0 | 4 | n/a | $36.6 | $36.6 | $33.6 [n<5] | 75.0% | $147 | $135 | n/a | Insufficient_Sample (N < 5) |
| GLOBEX_VWAP_MAGNET_LONG | Backfill | 395 | 14 | 13 | 3 | 10 | $18.3 | $9.0 | $11.2 | $8.2 [-$11.1, $30.4] | 69.2% | $145 | $106 | -$17.8 | Profitable |
| PM_LOW_FADE_LONG | Shadow | 3 | 3 | 3 | 0 | 3 | n/a | $46.8 | $46.8 | $43.8 [n<5] | 66.7% | $141 | $132 | $1.3 | Insufficient_Sample (N < 5) |
| FLOOR_R1_FADE_LONG | Live (ACTIVE) | 13 | 11 | 11 | 0 | 11 | n/a | $12.6 | $12.6 | $9.6 [-$32.4, $47.8] | 63.6% | $139 | $106 | $17.5 | Profitable |
| WEEKLY_OPEN_FADE_SHORT | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | $69.0 | $69.0 | $66.0 [n<5] | 100.0% | $138 | $132 | $4.0 | Insufficient_Sample (N < 5) |
| IB_LOW_FADE_SHORT | Live (ACTIVE) | 8 | 4 | 4 | 0 | 4 | n/a | $34.0 | $34.0 | $31.0 [n<5] | 75.0% | $136 | $124 | $43.3 | Insufficient_Sample (N < 5) |
| GLOBEX_VWAP_FADE_LONG | Backfill | 91 | 5 | 5 | 3 | 2 | $79.0 | -$51.0 | $27.0 | $24.0 [-$80.0, $76.0] | 80.0% | $135 | $120 | $79.0 | Insufficient_Sample (N < 5) |
| FLOOR_R2_FADE_SHORT | Gated candidate (never entered) | 51 | 32 | 2 | 0 | 2 | n/a | $66.8 | $66.8 | $63.8 [n<5] | 100.0% | $134 | $128 | n/a | Insufficient_Sample (N < 5) |
| OR30_LOW_FADE_SHORT | Live (ACTIVE) | 6 | 5 | 5 | 0 | 5 | n/a | $26.2 | $26.2 | $23.2 [-$62.0, $84.0] | 60.0% | $131 | $116 | $31.5 | Profitable |
| WEEKLY_VWAP_FADE_SHORT_OVERNIGHT | Shadow | 22 | 16 | 16 | 0 | 16 | n/a | $8.0 | $8.0 | $5.0 [-$54.5, $77.0] | 43.8% | $129 | $81 | $6.6 | Profitable |
| PW_LOW_FADE_SHORT | Shadow | 34 | 31 | 31 | 0 | 31 | n/a | $4.1 | $4.1 | $1.1 [-$38.4, $25.1] | 48.4% | $128 | $35 | $3.3 | Profitable |
| FAILED_SWEEP_REVERSAL_SHORT | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | $125.0 | $125.0 | $122.0 [n<5] | 100.0% | $125 | $122 | $111.0 | Insufficient_Sample (N < 5) |
| FAILED_AUCTION_LONG | Live (ACTIVE) | 19 | 19 | 19 | 0 | 19 | n/a | $6.4 | $6.4 | $3.4 [-$7.9, $20.9] | 68.4% | $122 | $65 | $22.4 | Profitable |
| OR30_LOW_FADE_LONG | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | $39.0 | $39.0 | $36.0 [n<5] | 66.7% | $117 | $108 | -$16.0 | Insufficient_Sample (N < 5) |
| CAM_S4_FADE_SHORT | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | $38.2 | $38.2 | $35.2 [n<5] | 66.7% | $115 | $106 | $23.8 | Insufficient_Sample (N < 5) |
| TRT_LONG_V2 | Gated candidate (never entered) | 152 | 136 | 4 | 0 | 4 | n/a | $28.0 | $28.0 | $25.0 [n<5] | 75.0% | $112 | $100 | n/a | Insufficient_Sample (N < 5) |
| WS1_FADE_SHORT | Backfill | 17 | 14 | 14 | 8 | 6 | -$21.9 | $47.9 | $8.0 | $5.0 [-$54.8, $49.8] | 64.3% | $112 | $70 | $8.0 | Profitable |
| PD_VAH_FADE_LONG | Shadow | 63 | 42 | 40 | 0 | 40 | n/a | $2.8 | $2.8 | -$0.2 [-$20.7, $22.9] | 47.5% | $111 | -$10 | $3.6 | Profitable |
| RTH_VWAP_FADE_LONG | Gated candidate (never entered) | 251 | 8 | 3 | 0 | 3 | n/a | $35.7 | $35.7 | $32.7 [n<5] | 66.7% | $107 | $98 | n/a | Insufficient_Sample (N < 5) |
| WS1_FADE_LONG | Shadow | 23 | 13 | 13 | 0 | 13 | n/a | $7.9 | $7.9 | $4.9 [-$16.3, $29.7] | 53.8% | $103 | $64 | $9.8 | Profitable |
| PW_VAL_FADE_SHORT | Live (ACTIVE) | 7 | 5 | 5 | 0 | 5 | n/a | $20.6 | $20.6 | $17.6 [-$56.0, $76.0] | 60.0% | $103 | $88 | $15.0 | Profitable |
| PD2_VAL_FADE_SHORT | Gated candidate (never entered) | 51 | 12 | 2 | 0 | 2 | n/a | $51.5 | $51.5 | $48.5 [n<5] | 100.0% | $103 | $97 | n/a | Insufficient_Sample (N < 5) |
| CAM_S3_FADE_SHORT | Backfill | 39 | 31 | 31 | 14 | 17 | $5.5 | $1.4 | $3.3 | $0.3 [-$42.4, $38.7] | 71.0% | $101 | $8 | $3.3 | Profitable |
| IB_BULLISH | Gated candidate (never entered) | 290 | 210 | 11 | 0 | 11 | n/a | $9.2 | $9.2 | $6.2 [$6.2, $6.2] | 63.6% | $101 | $68 | n/a | Profitable |
| C_STANDALONE_UP | Gated candidate (never entered) | 71 | 17 | 5 | 0 | 5 | n/a | $20.1 | $20.1 | $17.1 [-$126.8, $161.0] | 60.0% | $101 | $86 | n/a | Profitable |
| FLOOR_S2_FADE_SHORT | Backfill | 14 | 11 | 11 | 3 | 8 | -$4.8 | $14.3 | $9.1 | $6.1 [-$100.1, $92.8] | 72.7% | $100 | $67 | $7.5 | Profitable |
| PW_VAH_FADE_LONG | Shadow | 37 | 18 | 12 | 0 | 12 | n/a | $8.3 | $8.3 | $5.3 [-$21.6, $44.0] | 50.0% | $100 | $64 | $13.0 | Profitable |
| IB_MID_SCALP_FADE_SHORT | Live (ACTIVE) | 23 | 18 | 18 | 0 | 18 | n/a | $5.5 | $5.5 | $2.5 [-$20.0, $26.1] | 33.3% | $100 | $46 | $4.5 | Profitable |
| PD_SESSION_MID_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $99.0 | $99.0 | $96.0 [n<5] | 100.0% | $99 | $96 | $99.0 | Insufficient_Sample (N < 5) |
| FLOOR_R3_FADE_LONG | Shadow | 11 | 7 | 7 | 0 | 7 | n/a | $14.1 | $14.1 | $11.1 [-$30.0, $78.0] | 71.4% | $99 | $78 | $13.1 | Profitable |
| PD_HIGH_FADE_SHORT | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | $33.0 | $33.0 | $30.0 [n<5] | 66.7% | $99 | $90 | $32.0 | Insufficient_Sample (N < 5) |
| PD_IB_HIGH_FADE_SHORT | Live (ACTIVE) | 3 | 2 | 2 | 0 | 2 | n/a | $49.0 | $49.0 | $46.0 [n<5] | 100.0% | $98 | $92 | $48.0 | Insufficient_Sample (N < 5) |
| PW_VAL_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $97.0 | $97.0 | $94.0 [n<5] | 100.0% | $97 | $94 | $97.0 | Insufficient_Sample (N < 5) |
| FLOOR_S1_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $97.0 | $97.0 | $94.0 [n<5] | 100.0% | $97 | $94 | n/a | Insufficient_Sample (N < 5) |
| 2D_POC_FADE_SHORT | Live (ACTIVE) | 3 | 2 | 2 | 0 | 2 | n/a | $48.0 | $48.0 | $45.0 [n<5] | 100.0% | $96 | $90 | $49.5 | Insufficient_Sample (N < 5) |
| PM_POC_FADE_SHORT | Shadow | 11 | 5 | 5 | 0 | 5 | n/a | $19.1 | $19.1 | $16.1 [-$118.5, $78.0] | 80.0% | $96 | $81 | $18.6 | Profitable |
| OR15_HIGH_FADE_LONG | Live (ACTIVE) | 12 | 8 | 8 | 0 | 8 | n/a | $11.8 | $11.8 | $8.8 [-$34.0, $63.7] | 37.5% | $94 | $70 | $24.5 | Profitable |
| 10D_IB_MID_FADE_LONG | Shadow | 29 | 15 | 14 | 0 | 14 | n/a | $6.7 | $6.7 | $3.7 [-$34.4, $37.2] | 50.0% | $93 | $51 | $0.7 | Profitable |
| CAM_S1_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $93.0 | $93.0 | $90.0 [n<5] | 100.0% | $93 | $90 | n/a | Insufficient_Sample (N < 5) |
| PD_IB_LOW_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $91.0 | $91.0 | $88.0 [n<5] | 100.0% | $91 | $88 | $91.0 | Insufficient_Sample (N < 5) |
| OR30_HIGH_FADE_SHORT | Shadow | 66 | 46 | 46 | 0 | 46 | n/a | $2.0 | $2.0 | -$1.0 [-$26.6, $17.8] | 54.3% | $91 | -$47 | $1.8 | Profitable |
| A_UP_STRONG | Gated candidate (never entered) | 507 | 335 | 9 | 0 | 9 | n/a | $10.1 | $10.1 | $7.1 [-$34.3, $55.6] | 44.4% | $91 | $64 | n/a | Profitable |
| C_PAIRED_LONG | Gated candidate (never entered) | 523 | 335 | 9 | 0 | 9 | n/a | $10.1 | $10.1 | $7.1 [-$36.4, $58.2] | 44.4% | $91 | $64 | n/a | Profitable |
| OPEN_TEST_DRIVE_SHORT | Unknown-origin (pre-2026-07-09) | 107 | 89 | 89 | 46 | 43 | $12.0 | -$10.7 | $1.0 | -$2.0 [-$36.9, $36.0] | 44.9% | $89 | -$179 | -$9.8 | Unprofitable |
| PM_VAL_FADE_SHORT_OVERNIGHT | Shadow | 7 | 2 | 2 | 0 | 2 | n/a | $44.0 | $44.0 | $41.0 [n<5] | 50.0% | $88 | $82 | $43.0 | Insufficient_Sample (N < 5) |
| WEEKLY_OPEN_SWEEP_REVERSAL_LONG_OVERNIGHT | Shadow | 2 | 2 | 2 | 0 | 2 | n/a | $44.0 | $44.0 | $41.0 [n<5] | 50.0% | $88 | $82 | $43.0 | Insufficient_Sample (N < 5) |
| PM_VAH_FADE_SHORT_OVERNIGHT | Shadow | 2 | 2 | 2 | 0 | 2 | n/a | $44.0 | $44.0 | $41.0 [n<5] | 50.0% | $88 | $82 | $43.0 | Insufficient_Sample (N < 5) |
| MR1_FADE_SHORT_OVERNIGHT | Shadow | 3 | 2 | 2 | 0 | 2 | n/a | $44.0 | $44.0 | $41.0 [n<5] | 50.0% | $88 | $82 | $43.0 | Insufficient_Sample (N < 5) |
| MS2_FADE_SHORT | Backfill | 5 | 5 | 5 | 4 | 1 | -$1.6 | $93.3 | $17.4 | $14.4 [-$61.5, $90.3] | 60.0% | $87 | $72 | $17.4 | Insufficient_Sample (N < 5) |
| CAM_S2_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $87.0 | $87.0 | $84.0 [n<5] | 100.0% | $87 | $84 | $87.0 | Insufficient_Sample (N < 5) |
| CAM_S4_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $87.0 | $87.0 | $84.0 [n<5] | 100.0% | $87 | $84 | $87.0 | Insufficient_Sample (N < 5) |
| PD_HIGH_FADE_SHORT | Shadow | 44 | 16 | 15 | 0 | 15 | n/a | $5.8 | $5.8 | $2.8 [-$31.5, $45.0] | 46.7% | $87 | $42 | $12.7 | Profitable |
| MR1_FADE_LONG | Shadow | 5 | 3 | 3 | 0 | 3 | n/a | $29.0 | $29.0 | $26.0 [n<5] | 66.7% | $87 | $78 | $28.0 | Insufficient_Sample (N < 5) |
| WS1_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $85.0 | $85.0 | $82.0 [n<5] | 100.0% | $85 | $82 | $85.0 | Insufficient_Sample (N < 5) |
| WS1_FADE_LONG_OVERNIGHT | Shadow | 6 | 5 | 5 | 0 | 5 | n/a | $17.0 | $17.0 | $14.0 [-$94.0, $176.0] | 40.0% | $85 | $70 | -$7.8 | Profitable |
| PD_SESSION_MID_FADE_SHORT_OVERNIGHT | Shadow | 5 | 5 | 5 | 0 | 5 | n/a | $17.0 | $17.0 | $14.0 [-$94.0, $41.0] | 40.0% | $85 | $70 | $16.0 | Profitable |
| WPP_FADE_SHORT_GAP_UP | Gated candidate (never entered) | 21 | 1 | 1 | 0 | 1 | n/a | $85.0 | $85.0 | $82.0 [n<5] | 100.0% | $85 | $82 | n/a | Insufficient_Sample (N < 5) |
| MINOR_DEFENDED_LEVEL_SHORT | Shadow | 3 | 3 | 3 | 0 | 3 | n/a | $28.0 | $28.0 | $25.0 [n<5] | 66.7% | $84 | $75 | $36.0 | Insufficient_Sample (N < 5) |
| 3M_POC_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $83.0 | $83.0 | $80.0 [n<5] | 100.0% | $83 | $80 | $83.0 | Insufficient_Sample (N < 5) |
| CAM_R4_FADE_LONG | Gated candidate (never entered) | 57 | 15 | 1 | 0 | 1 | n/a | $83.0 | $83.0 | $80.0 [n<5] | 100.0% | $83 | $80 | n/a | Insufficient_Sample (N < 5) |
| 5D_OR_MID_FADE_LONG | Live (ACTIVE) | 9 | 9 | 6 | 0 | 6 | n/a | $13.7 | $13.7 | $10.7 [-$55.7, $69.0] | 66.7% | $82 | $64 | $17.0 | Profitable |
| 2D_POC_FADE_LONG | Gated candidate (never entered) | 1 | 1 | 1 | 0 | 1 | n/a | $81.5 | $81.5 | $78.5 [n<5] | 100.0% | $82 | $79 | n/a | Insufficient_Sample (N < 5) |
| PD_CLOSE_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $81.0 | $81.0 | $78.0 [n<5] | 100.0% | $81 | $78 | $81.0 | Insufficient_Sample (N < 5) |
| CAM_R1_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $81.0 | $81.0 | $78.0 [n<5] | 100.0% | $81 | $78 | $81.0 | Insufficient_Sample (N < 5) |
| PD_CLOSE_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $81.0 | $81.0 | $78.0 [n<5] | 100.0% | $81 | $78 | $81.0 | Insufficient_Sample (N < 5) |
| PM_VAH_FADE_SHORT | Shadow | 2 | 1 | 1 | 0 | 1 | n/a | $81.0 | $81.0 | $78.0 [n<5] | 100.0% | $81 | $78 | $80.0 | Insufficient_Sample (N < 5) |
| PM_POC_FADE_LONG | Gated candidate (never entered) | 28 | 1 | 1 | 0 | 1 | n/a | $81.0 | $81.0 | $78.0 [n<5] | 100.0% | $81 | $78 | n/a | Insufficient_Sample (N < 5) |
| PM_POC_FADE_SHORT | Gated candidate (never entered) | 51 | 1 | 1 | 0 | 1 | n/a | $81.0 | $81.0 | $78.0 [n<5] | 100.0% | $81 | $78 | n/a | Insufficient_Sample (N < 5) |
| FLOOR_R1_FADE_SHORT_TRAIL | Gated candidate (never entered) | 71 | 3 | 3 | 0 | 3 | n/a | $27.0 | $27.0 | $24.0 [n<5] | 66.7% | $81 | $72 | n/a | Insufficient_Sample (N < 5) |
| FLOOR_R1_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $79.0 | $79.0 | $76.0 [n<5] | 100.0% | $79 | $76 | $79.0 | Insufficient_Sample (N < 5) |
| PD_OR_MID_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $79.0 | $79.0 | $76.0 [n<5] | 100.0% | $79 | $76 | $79.0 | Insufficient_Sample (N < 5) |
| 5D_OR_MID_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $79.0 | $79.0 | $76.0 [n<5] | 100.0% | $79 | $76 | $79.0 | Insufficient_Sample (N < 5) |
| PD_VAH_FADE_LONG | Gated candidate (never entered) | 63 | 1 | 1 | 0 | 1 | n/a | $79.0 | $79.0 | $76.0 [n<5] | 100.0% | $79 | $76 | n/a | Insufficient_Sample (N < 5) |
| OR5_HIGH_FADE_LONG | Gated candidate (never entered) | 53 | 3 | 1 | 0 | 1 | n/a | $79.0 | $79.0 | $76.0 [n<5] | 100.0% | $79 | $76 | n/a | Insufficient_Sample (N < 5) |
| VWAP_MAGNET_SHORT | Backfill | 87 | 2 | 2 | 0 | 2 | n/a | $39.0 | $39.0 | $36.0 [n<5] | 100.0% | $78 | $72 | -$61.0 | Insufficient_Sample (N < 5) |
| PD_VAL_FADE_LONG | Live (ACTIVE) | 66 | 52 | 52 | 0 | 52 | n/a | $1.5 | $1.5 | -$1.5 [-$19.5, $24.4] | 50.0% | $78 | -$78 | $4.3 | Profitable |
| MONTHLY_VWAP_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | $25.0 | $25.0 | $22.0 [n<5] | 66.7% | $75 | $66 | $24.0 | Insufficient_Sample (N < 5) |
| PD_IB_LOW_FADE_SHORT | Live (ACTIVE) | 2 | 1 | 1 | 0 | 1 | n/a | $75.0 | $75.0 | $72.0 [n<5] | 100.0% | $75 | $72 | $74.0 | Insufficient_Sample (N < 5) |
| MPP_FADE_LONG | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | $75.0 | $75.0 | $72.0 [n<5] | 100.0% | $75 | $72 | $13.0 | Insufficient_Sample (N < 5) |
| DAILY_OPEN_FADE_SHORT | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | $75.0 | $75.0 | $72.0 [n<5] | 100.0% | $75 | $72 | $80.5 | Insufficient_Sample (N < 5) |
| PM_VAL_FADE_LONG | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | $75.0 | $75.0 | $72.0 [n<5] | 100.0% | $75 | $72 | $74.0 | Insufficient_Sample (N < 5) |
| CAM_R3_FADE_LONG | Gated candidate (never entered) | 71 | 3 | 1 | 0 | 1 | n/a | $75.0 | $75.0 | $72.0 [n<5] | 100.0% | $75 | $72 | n/a | Insufficient_Sample (N < 5) |
| PD_OR_MID_FADE_LONG | Gated candidate (never entered) | 82 | 2 | 1 | 0 | 1 | n/a | $75.0 | $75.0 | $72.0 [n<5] | 100.0% | $75 | $72 | n/a | Insufficient_Sample (N < 5) |
| PD_POC_FADE_SHORT | Live (ACTIVE) | 48 | 43 | 39 | 0 | 39 | n/a | $1.9 | $1.9 | -$1.1 [-$36.4, $29.1] | 64.1% | $73 | -$45 | -$0.7 | Profitable |
| DAILY_OPEN_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $71.0 | $71.0 | $68.0 [n<5] | 100.0% | $71 | $68 | $71.0 | Insufficient_Sample (N < 5) |
| PM_HIGH_FADE_SHORT | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | $35.3 | $35.3 | $32.3 [n<5] | 50.0% | $71 | $65 | -$39.0 | Insufficient_Sample (N < 5) |
| 5D_OR_MID_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $69.0 | $69.0 | $66.0 [n<5] | 100.0% | $69 | $66 | $69.0 | Insufficient_Sample (N < 5) |
| WEEKLY_OPEN_FADE_LONG | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | $69.0 | $69.0 | $66.0 [n<5] | 100.0% | $69 | $66 | $71.0 | Insufficient_Sample (N < 5) |
| PD_VAL_FADE_SHORT | Live (ACTIVE) | 3 | 2 | 2 | 0 | 2 | n/a | $34.0 | $34.0 | $31.0 [n<5] | 50.0% | $68 | $62 | $33.0 | Insufficient_Sample (N < 5) |
| MR2_FADE_LONG | Backfill | 4 | 2 | 2 | 2 | 0 | $33.0 | n/a | $33.0 | $30.0 [n<5] | 100.0% | $66 | $60 | $33.0 | Insufficient_Sample (N < 5) |
| IB_MID_SCALP_FADE_LONG | Gated candidate (never entered) | 100 | 2 | 2 | 0 | 2 | n/a | $33.0 | $33.0 | $30.0 [n<5] | 50.0% | $66 | $60 | n/a | Insufficient_Sample (N < 5) |
| PD_VAL_FADE_LONG | Gated candidate (never entered) | 7525 | 15 | 2 | 0 | 2 | n/a | $31.0 | $31.0 | $28.0 [n<5] | 50.0% | $62 | $56 | n/a | Insufficient_Sample (N < 5) |
| STOP_SWEEP_SHORT | Unknown-origin (pre-2026-07-09) | 4 | 4 | 3 | 0 | 3 | n/a | $20.2 | $20.2 | $17.2 [n<5] | 66.7% | $61 | $52 | $20.2 | Insufficient_Sample (N < 5) |
| FLOOR_R1_FADE_LONG | Backfill | 50 | 38 | 38 | 26 | 12 | -$28.1 | $65.8 | $1.6 | -$1.4 [-$28.2, $25.3] | 68.4% | $60 | -$54 | $1.6 | Profitable |
| OR15_LOW_FADE_LONG | Shadow | 40 | 29 | 29 | 0 | 29 | n/a | $2.1 | $2.1 | -$0.9 [-$31.3, $29.8] | 48.3% | $60 | -$28 | $11.5 | Profitable |
| A_DOWN_WEAK | Unknown-origin (pre-2026-07-09) | 6 | 4 | 4 | 0 | 4 | n/a | $14.8 | $14.8 | $11.8 [n<5] | 50.0% | $59 | $47 | $295.8 | Insufficient_Sample (N < 5) |
| PD2_VAH_FADE_LONG | Live (ACTIVE) | 4 | 4 | 4 | 0 | 4 | n/a | $14.5 | $14.5 | $11.5 [n<5] | 75.0% | $58 | $46 | $4.5 | Insufficient_Sample (N < 5) |
| FLOOR_PIVOT_FADE_SHORT | Live (ACTIVE) | 5 | 5 | 5 | 0 | 5 | n/a | $11.4 | $11.4 | $8.4 [-$38.0, $102.0] | 40.0% | $57 | $42 | $10.4 | Profitable |
| OR5_MID_FADE_SHORT | Live (ACTIVE) | 11 | 9 | 9 | 0 | 9 | n/a | $6.3 | $6.3 | $3.3 [-$21.3, $27.1] | 44.4% | $57 | $30 | -$8.4 | Profitable |
| PD2_VAH_FADE_LONG | Shadow | 21 | 17 | 17 | 0 | 17 | n/a | $3.4 | $3.4 | $0.4 [-$80.4, $46.9] | 70.6% | $57 | $6 | $4.8 | Profitable |
| GLOBEX_FLUSH_LONG | Shadow | 14 | 14 | 14 | 0 | 14 | n/a | $4.0 | $4.0 | $1.0 [-$132.7, $140.9] | 42.9% | $57 | $15 | $3.0 | Profitable |
| GLOBEX_VWAP_FADE_LONG | Live (ACTIVE) | 15 | 11 | 11 | 0 | 11 | n/a | $5.1 | $5.1 | $2.1 [-$67.4, $63.8] | 63.6% | $56 | $23 | $3.8 | Profitable |
| OR30_LOW_FADE_LONG | Gated candidate (never entered) | 77 | 2 | 2 | 0 | 2 | n/a | $28.0 | $28.0 | $25.0 [n<5] | 50.0% | $56 | $50 | n/a | Insufficient_Sample (N < 5) |
| OR5_LOW_FADE_LONG | Live (ACTIVE) | 6 | 6 | 6 | 0 | 6 | n/a | $9.1 | $9.1 | $6.1 [-$36.0, $35.6] | 50.0% | $55 | $37 | $11.0 | Profitable |
| 10D_IB_MID_FADE_LONG | Backfill | 46 | 39 | 39 | 23 | 16 | -$27.8 | $43.4 | $1.4 | -$1.6 [-$66.2, $51.7] | 64.1% | $54 | -$64 | $9.6 | Profitable |
| MINOR_DEFENDED_LEVEL_LONG | Shadow | 4 | 4 | 4 | 0 | 4 | n/a | $12.6 | $12.6 | $9.6 [n<5] | 50.0% | $51 | $39 | $0.0 | Insufficient_Sample (N < 5) |
| ONL_FADE_LONG | Gated candidate (never entered) | 48 | 2 | 2 | 0 | 2 | n/a | $25.0 | $25.0 | $22.0 [n<5] | 50.0% | $50 | $44 | n/a | Insufficient_Sample (N < 5) |
| OR30_LOW_FADE_SHORT | Shadow | 20 | 9 | 9 | 0 | 9 | n/a | $5.2 | $5.2 | $2.2 [-$73.3, $61.3] | 55.6% | $47 | $20 | $4.2 | Profitable |
| CAM_R1_FADE_LONG | Shadow | 63 | 32 | 30 | 0 | 30 | n/a | $1.5 | $1.5 | -$1.5 [-$21.1, $13.8] | 56.7% | $45 | -$45 | -$1.7 | Profitable |
| PD_SESSION_MID_FADE_SHORT | Shadow | 44 | 22 | 19 | 0 | 19 | n/a | $2.4 | $2.4 | -$0.6 [-$22.2, $21.2] | 42.1% | $45 | -$12 | $3.2 | Profitable |
| PD_IB_MID_FADE_SHORT | Live (ACTIVE) | 5 | 5 | 5 | 0 | 5 | n/a | $8.8 | $8.8 | $5.8 [-$54.0, $20.8] | 60.0% | $44 | $29 | $16.4 | Profitable |
| 3M_POC_FADE_SHORT | Gated candidate (never entered) | 47 | 1 | 1 | 0 | 1 | n/a | $44.0 | $44.0 | $41.0 [n<5] | 100.0% | $44 | $41 | n/a | Insufficient_Sample (N < 5) |
| MAJOR_PIVOT_DEFENDED_BREAK_LONG | Shadow | 4 | 3 | 3 | 0 | 3 | n/a | $13.7 | $13.7 | $10.7 [n<5] | 66.7% | $41 | $32 | $18.7 | Insufficient_Sample (N < 5) |
| IB_BEARISH | Live (ACTIVE) | 157 | 156 | 99 | 0 | 99 | n/a | $0.4 | $0.4 | -$2.6 [-$24.9, $14.2] | 59.6% | $41 | -$256 | -$2.9 | Profitable |
| 3M_POC_FADE_LONG | Gated candidate (never entered) | 25 | 5 | 2 | 0 | 2 | n/a | $20.0 | $20.0 | $17.0 [n<5] | 50.0% | $40 | $34 | n/a | Insufficient_Sample (N < 5) |
| OR5_MID_FADE_SHORT | Gated candidate (never entered) | 140 | 37 | 5 | 0 | 5 | n/a | $7.9 | $7.9 | $4.9 [-$29.4, $63.6] | 60.0% | $40 | $25 | n/a | Profitable |
| WPP_FADE_SHORT | Backfill | 51 | 42 | 42 | 22 | 20 | $3.3 | -$1.6 | $0.9 | -$2.1 [-$31.0, $23.4] | 69.0% | $39 | -$87 | $2.2 | Unprofitable |
| VWAP_MAGNET_LONG | Backfill | 145 | 1 | 1 | 0 | 1 | n/a | $39.0 | $39.0 | $36.0 [n<5] | 100.0% | $39 | $36 | $39.0 | Insufficient_Sample (N < 5) |
| 3M_POC_FADE_SHORT | Live (ACTIVE) | 2 | 1 | 1 | 0 | 1 | n/a | $39.0 | $39.0 | $36.0 [n<5] | 100.0% | $39 | $36 | $38.0 | Insufficient_Sample (N < 5) |
| BRACKET_BREAKOUT_LONG | Gated candidate (never entered) | 133 | 90 | 4 | 0 | 4 | n/a | $9.5 | $9.5 | $6.5 [n<5] | 50.0% | $38 | $26 | n/a | Insufficient_Sample (N < 5) |
| IB_MID_SCALP_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $37.0 | $37.0 | $34.0 [n<5] | 100.0% | $37 | $34 | -$51.5 | Insufficient_Sample (N < 5) |
| STACK_VOL_BREAK_LIVE_SHORT | Shadow | 34 | 27 | 27 | 0 | 27 | n/a | $1.3 | $1.3 | -$1.7 [-$34.8, $32.4] | 59.3% | $36 | -$45 | -$12.8 | Profitable |
| PW_VAH_FADE_LONG | Backfill | 59 | 53 | 53 | 36 | 17 | -$10.6 | $24.5 | $0.7 | -$2.3 [-$40.2, $29.5] | 69.8% | $35 | -$124 | $6.9 | Profitable |
| OR5_HIGH_FADE_LONG | Shadow | 101 | 59 | 57 | 0 | 57 | n/a | $0.6 | $0.6 | -$2.4 [-$18.0, $11.5] | 47.4% | $35 | -$136 | $0.4 | Profitable |
| PM_VAL_FADE_SHORT | Shadow | 15 | 6 | 6 | 0 | 6 | n/a | $5.8 | $5.8 | $2.8 [-$70.3, $76.0] | 50.0% | $35 | $17 | $20.4 | Profitable |
| CAM_R2_FADE_LONG | Shadow | 53 | 36 | 31 | 0 | 31 | n/a | $1.1 | $1.1 | -$1.9 [-$29.8, $23.8] | 48.4% | $35 | -$59 | $1.5 | Profitable |
| PM_VAH_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 2 | 1 | 1 | 0 | 1 | n/a | $34.0 | $34.0 | $31.0 [n<5] | 100.0% | $34 | $31 | $33.0 | Insufficient_Sample (N < 5) |
| MS1_FADE_SHORT | Backfill | 12 | 9 | 9 | 3 | 6 | $20.2 | -$4.5 | $3.7 | $0.7 [-$75.1, $67.5] | 55.6% | $33 | $6 | $6.0 | Unprofitable |
| DAILY_OPEN_FADE_LONG_TRAIL | Shadow | 9 | 9 | 9 | 0 | 9 | n/a | $3.7 | $3.7 | $0.7 [-$76.0, $80.0] | 55.6% | $33 | $6 | $2.7 | Profitable |
| PD_IB_HIGH_FADE_SHORT | Backfill | 103 | 80 | 80 | 44 | 36 | -$3.5 | $5.1 | $0.4 | -$2.6 [-$24.1, $20.1] | 62.5% | $32 | -$208 | $6.7 | Profitable |
| STOP_SWEEP_LONG | Gated candidate (never entered) | 83 | 56 | 8 | 0 | 8 | n/a | $3.9 | $3.9 | $0.9 [-$59.0, $42.2] | 62.5% | $32 | $8 | n/a | Profitable |
| OR5_LOW_FADE_LONG | Gated candidate (never entered) | 195 | 105 | 7 | 0 | 7 | n/a | $4.5 | $4.5 | $1.5 [-$23.2, $20.0] | 42.9% | $32 | $11 | n/a | Profitable |
| OR30_MID_FADE_SHORT | Shadow | 26 | 19 | 19 | 0 | 19 | n/a | $1.6 | $1.6 | -$1.4 [-$29.5, $31.6] | 47.4% | $31 | -$26 | $5.0 | Profitable |
| PM_HIGH_FADE_SHORT | Gated candidate (never entered) | 12 | 3 | 1 | 0 | 1 | n/a | $31.0 | $31.0 | $28.0 [n<5] | 100.0% | $31 | $28 | n/a | Insufficient_Sample (N < 5) |
| CAM_R2_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $30.0 | $30.0 | $27.0 [n<5] | 100.0% | $30 | $27 | n/a | Insufficient_Sample (N < 5) |
| OR5_LOW_FADE_LONG_GAP_DOWN | Shadow | 31 | 26 | 26 | 0 | 26 | n/a | $1.2 | $1.2 | -$1.8 [-$27.7, $22.9] | 34.6% | $30 | -$48 | $9.3 | Profitable |
| OR10_HIGH_FADE_SHORT | Live (ACTIVE) | 9 | 6 | 6 | 0 | 6 | n/a | $5.0 | $5.0 | $2.0 [-$47.0, $52.0] | 50.0% | $30 | $12 | -$1.2 | Profitable |
| PD_POC_FADE_LONG_TRAIL | Gated candidate (never entered) | 113 | 19 | 2 | 0 | 2 | n/a | $15.0 | $15.0 | $12.0 [n<5] | 50.0% | $30 | $24 | n/a | Insufficient_Sample (N < 5) |
| OR10_MID_FADE_SHORT | Live (ACTIVE) | 11 | 5 | 5 | 0 | 5 | n/a | $5.8 | $5.8 | $2.8 [-$54.4, $60.0] | 40.0% | $29 | $14 | $5.7 | Profitable |
| TRT_LONG | Shadow | 8 | 8 | 7 | 0 | 7 | n/a | $4.0 | $4.0 | $1.0 [-$51.4, $72.6] | 57.1% | $28 | $7 | -$2.9 | Profitable |
| PD_CLOSE_FADE_SHORT | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | $14.0 | $14.0 | $11.0 [n<5] | 50.0% | $28 | $22 | $13.0 | Insufficient_Sample (N < 5) |
| A_DOWN_WEAK | Live (ACTIVE) | 11 | 9 | 8 | 0 | 8 | n/a | $3.4 | $3.4 | $0.4 [-$53.9, $46.6] | 37.5% | $27 | $3 | $12.3 | Profitable |
| WR1_FADE_SHORT | Shadow | 10 | 6 | 6 | 0 | 6 | n/a | $4.3 | $4.3 | $1.3 [-$68.0, $22.0] | 50.0% | $26 | $8 | $3.3 | Profitable |
| PD_OR_MID_FADE_SHORT | Shadow | 50 | 29 | 27 | 0 | 27 | n/a | $0.9 | $0.9 | -$2.1 [-$44.1, $31.6] | 51.9% | $25 | -$56 | $2.3 | Profitable |
| CAM_R3_FADE_SHORT | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | $8.2 | $8.2 | $5.2 [n<5] | 66.7% | $25 | $16 | $5.3 | Insufficient_Sample (N < 5) |
| PM_HIGH_FADE_SHORT_OVERNIGHT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | $24.5 | $24.5 | $21.5 [n<5] | 100.0% | $25 | $22 | $20.0 | Insufficient_Sample (N < 5) |
| PW_LOW_FADE_SHORT | Gated candidate (never entered) | 38 | 17 | 3 | 0 | 3 | n/a | $8.2 | $8.2 | $5.2 [n<5] | 66.7% | $25 | $16 | n/a | Insufficient_Sample (N < 5) |
| TRT_MAH_LONG | Unknown-origin (pre-2026-07-09) | 5 | 2 | 2 | 2 | 0 | $12.0 | n/a | $12.0 | $9.0 [n<5] | 50.0% | $24 | $18 | $12.0 | Insufficient_Sample (N < 5) |
| STOP_SWEEP_LONG | Unknown-origin (pre-2026-07-09) | 5 | 5 | 5 | 0 | 5 | n/a | $4.6 | $4.6 | $1.6 [-$64.6, $56.5] | 60.0% | $23 | $8 | $4.6 | Profitable |
| OR10_HIGH_FADE_LONG | Gated candidate (never entered) | 84 | 27 | 1 | 0 | 1 | n/a | $23.0 | $23.0 | $20.0 [n<5] | 100.0% | $23 | $20 | n/a | Insufficient_Sample (N < 5) |
| WEEKLY_VWAP_FADE_SHORT | Shadow | 33 | 21 | 16 | 0 | 16 | n/a | $1.3 | $1.3 | -$1.7 [-$33.6, $35.3] | 50.0% | $20 | -$28 | -$1.2 | Profitable |
| FLOOR_S3_FADE_LONG | Live (ACTIVE) | 12 | 8 | 2 | 0 | 2 | n/a | $8.0 | $8.0 | $5.0 [n<5] | 50.0% | $16 | $10 | -$60.0 | Insufficient_Sample (N < 5) |
| OR30_MID_FADE_LONG | Gated candidate (never entered) | 178 | 12 | 3 | 0 | 3 | n/a | $5.2 | $5.2 | $2.2 [n<5] | 33.3% | $16 | $7 | n/a | Insufficient_Sample (N < 5) |
| ONH_FADE_LONG | Gated candidate (never entered) | 111 | 54 | 2 | 0 | 2 | n/a | $6.0 | $6.0 | $3.0 [n<5] | 50.0% | $12 | $6 | n/a | Insufficient_Sample (N < 5) |
| FLOOR_S2_FADE_SHORT | Gated candidate (never entered) | 16 | 1 | 1 | 0 | 1 | n/a | $11.5 | $11.5 | $8.5 [n<5] | 100.0% | $12 | $9 | n/a | Insufficient_Sample (N < 5) |
| OR15_LOW_FADE_LONG | Live (ACTIVE) | 8 | 6 | 6 | 0 | 6 | n/a | $1.7 | $1.7 | -$1.3 [-$69.0, $47.4] | 50.0% | $10 | -$8 | -$30.7 | Profitable |
| 3M_POC_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 4 | 4 | 4 | 0 | 4 | n/a | $2.4 | $2.4 | -$0.6 [n<5] | 50.0% | $10 | -$3 | $5.0 | Insufficient_Sample (N < 5) |
| PM_POC_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 4 | 4 | 4 | 0 | 4 | n/a | $2.4 | $2.4 | -$0.6 [n<5] | 50.0% | $10 | -$3 | $3.4 | Insufficient_Sample (N < 5) |
| MONTHLY_OPEN_FADE_SHORT | Gated candidate (never entered) | 28 | 10 | 1 | 0 | 1 | n/a | $9.5 | $9.5 | $6.5 [n<5] | 100.0% | $10 | $7 | n/a | Insufficient_Sample (N < 5) |
| MAJOR_PIVOT_DEFENDED_BREAK_SHORT | Live (ACTIVE) | 3 | 2 | 2 | 0 | 2 | n/a | $4.7 | $4.7 | $1.7 [n<5] | 50.0% | $9 | $3 | -$93.6 | Insufficient_Sample (N < 5) |
| WS1_FADE_LONG | Backfill | 37 | 33 | 33 | 25 | 8 | $15.8 | -$48.1 | $0.3 | -$2.7 [-$40.8, $35.3] | 60.6% | $9 | -$90 | $0.3 | Unprofitable |
| OR5_LOW_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | $9.0 | $9.0 | $6.0 [n<5] | 100.0% | $9 | $6 | $9.0 | Insufficient_Sample (N < 5) |
| FLOOR_R1_FADE_SHORT_TRAIL | Shadow | 46 | 36 | 36 | 0 | 36 | n/a | $0.3 | $0.3 | -$2.8 [-$32.3, $23.3] | 52.8% | $9 | -$99 | -$5.2 | Profitable |
| WR2_FADE_SHORT | Backfill | 15 | 12 | 12 | 7 | 5 | $5.0 | -$5.6 | $0.6 | -$2.4 [-$63.2, $53.9] | 66.7% | $7 | -$29 | $6.8 | Unprofitable |
| PD_SESSION_MID_FADE_SHORT | Live (ACTIVE) | 6 | 3 | 3 | 0 | 3 | n/a | $2.3 | $2.3 | -$0.7 [n<5] | 33.3% | $7 | -$2 | $1.3 | Insufficient_Sample (N < 5) |
| IB_MID_SCALP_FADE_SHORT | Gated candidate (never entered) | 89 | 16 | 1 | 0 | 1 | n/a | $6.0 | $6.0 | $3.0 [n<5] | 100.0% | $6 | $3 | n/a | Insufficient_Sample (N < 5) |
| IB_HIGH_FADE_SHORT | Gated candidate (never entered) | 136 | 64 | 11 | 0 | 11 | n/a | $0.5 | $0.5 | -$2.5 [-$44.9, $23.8] | 45.5% | $6 | -$28 | n/a | Profitable |
| FLOOR_R2_FADE_SHORT | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | $2.0 | $2.0 | -$1.0 [n<5] | 50.0% | $4 | -$2 | $1.0 | Insufficient_Sample (N < 5) |
| PD_POC_FADE_SHORT | Shadow | 82 | 62 | 62 | 0 | 62 | n/a | $0.1 | $0.1 | -$2.9 [-$29.0, $16.2] | 59.7% | $4 | -$182 | -$3.7 | Profitable |
| MPP_FADE_SHORT | Shadow | 7 | 5 | 5 | 0 | 5 | n/a | $0.6 | $0.6 | -$2.4 [-$148.0, $70.0] | 60.0% | $3 | -$12 | -$0.4 | Profitable |
| 10D_IB_MID_FADE_SHORT | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | $0.0 | $0.0 | -$3.0 [n<5] | 50.0% | $0 | -$6 | -$1.0 | Insufficient_Sample (N < 5) |
| WPP_FADE_LONG | Gated candidate (never entered) | 77 | 3 | 1 | 0 | 1 | n/a | -$0.5 | -$0.5 | -$3.5 [n<5] | 0.0% | -$1 | -$4 | n/a | Insufficient_Sample (N < 5) |
| OR15_LOW_FADE_SHORT | Live (ACTIVE) | 10 | 7 | 7 | 0 | 7 | n/a | -$0.1 | -$0.1 | -$3.1 [-$67.3, $50.7] | 42.9% | -$1 | -$22 | $7.4 | Unprofitable |
| MPP_FADE_LONG | Shadow | 8 | 4 | 4 | 0 | 4 | n/a | -$0.5 | -$0.5 | -$3.5 [n<5] | 50.0% | -$2 | -$14 | -$1.5 | Insufficient_Sample (N < 5) |
| MONTHLY_OPEN_FADE_LONG | Shadow | 12 | 6 | 6 | 0 | 6 | n/a | -$0.3 | -$0.3 | -$3.3 [-$41.0, $71.5] | 50.0% | -$2 | -$20 | -$1.3 | Unprofitable |
| PD_IB_LOW_FADE_SHORT | Shadow | 30 | 18 | 15 | 0 | 15 | n/a | -$0.2 | -$0.2 | -$3.2 [-$33.6, $25.8] | 46.7% | -$3 | -$48 | $0.3 | Unprofitable |
| FLOOR_R2_FADE_SHORT | Backfill | 91 | 74 | 74 | 40 | 34 | -$11.8 | $13.8 | -$0.0 | -$3.0 [-$27.9, $22.3] | 62.2% | -$3 | -$225 | $9.4 | Profitable |
| OR15_MID_FADE_LONG | Live (ACTIVE) | 7 | 3 | 3 | 0 | 3 | n/a | -$1.0 | -$1.0 | -$4.0 [n<5] | 33.3% | -$3 | -$12 | -$1.7 | Insufficient_Sample (N < 5) |
| ZONE_EDGE_FADE | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$5.0 | -$5.0 | -$8.0 [n<5] | 0.0% | -$5 | -$8 | -$7.5 | Insufficient_Sample (N < 5) |
| FLOOR_PIVOT_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 6 | 6 | 6 | 0 | 6 | n/a | -$1.0 | -$1.0 | -$4.0 [-$94.0, $176.0] | 33.3% | -$6 | -$24 | $5.0 | Unprofitable |
| WPP_FADE_SHORT_OVERNIGHT | Shadow | 6 | 6 | 6 | 0 | 6 | n/a | -$1.0 | -$1.0 | -$4.0 [-$94.0, $14.0] | 33.3% | -$6 | -$24 | -$2.0 | Unprofitable |
| MS2_FADE_LONG | Backfill | 6 | 4 | 4 | 3 | 1 | -$33.2 | $93.3 | -$1.6 | -$4.6 [n<5] | 50.0% | -$6 | -$18 | -$1.6 | Insufficient_Sample (N < 5) |
| ZONE_EDGE_FADE | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$7.0 | -$7.0 | -$10.0 [n<5] | 0.0% | -$7 | -$10 | -$7.0 | Insufficient_Sample (N < 5) |
| ZONE_EDGE_FADE | Gated candidate (never entered) | 11 | 5 | 3 | 0 | 3 | n/a | -$3.0 | -$3.0 | -$6.0 [n<5] | 0.0% | -$9 | -$18 | n/a | Insufficient_Sample (N < 5) |
| PW_HIGH_FADE_SHORT | Live (ACTIVE) | 5 | 3 | 3 | 0 | 3 | n/a | -$3.3 | -$3.3 | -$6.3 [n<5] | 33.3% | -$10 | -$19 | -$0.5 | Insufficient_Sample (N < 5) |
| PD_VAH_FADE_SHORT | Live (ACTIVE) | 69 | 55 | 53 | 0 | 53 | n/a | -$0.2 | -$0.2 | -$3.2 [-$23.7, $24.0] | 43.4% | -$12 | -$171 | -$0.6 | Unprofitable |
| OPENING_DRIVE_15MIN_LONG | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | -$6.0 | -$6.0 | -$9.0 [n<5] | 50.0% | -$12 | -$18 | -$7.0 | Insufficient_Sample (N < 5) |
| OR5_LOW_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$12.5 | -$12.5 | -$15.5 [n<5] | 0.0% | -$13 | -$16 | -$59.5 | Insufficient_Sample (N < 5) |
| PD_POC_FADE_SHORT_TRAIL | Gated candidate (never entered) | 170 | 6 | 5 | 0 | 5 | n/a | -$2.6 | -$2.6 | -$5.6 [-$98.0, $56.0] | 60.0% | -$13 | -$28 | n/a | Unprofitable |
| RSI_DIV_BULLISH | Gated candidate (never entered) | 1 | 1 | 1 | 0 | 1 | n/a | -$13.5 | -$13.5 | -$16.5 [n<5] | 0.0% | -$14 | -$17 | n/a | Insufficient_Sample (N < 5) |
| CAM_S4_FADE_SHORT | Gated candidate (never entered) | 31 | 1 | 1 | 0 | 1 | n/a | -$15.0 | -$15.0 | -$18.0 [n<5] | 0.0% | -$15 | -$18 | n/a | Insufficient_Sample (N < 5) |
| PD_VAH_FADE_SHORT | Gated candidate (never entered) | 7232 | 11 | 2 | 0 | 2 | n/a | -$7.8 | -$7.8 | -$10.8 [n<5] | 50.0% | -$16 | -$22 | n/a | Insufficient_Sample (N < 5) |
| OR5_HIGH_FADE_LONG | Unknown-origin (pre-2026-07-09) | 3 | 3 | 3 | 0 | 3 | n/a | -$5.7 | -$5.7 | -$8.7 [n<5] | 66.7% | -$17 | -$26 | -$5.7 | Insufficient_Sample (N < 5) |
| FLOOR_S1_FADE_SHORT | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | -$5.7 | -$5.7 | -$8.7 [n<5] | 33.3% | -$17 | -$26 | -$46.5 | Insufficient_Sample (N < 5) |
| PD2_VAH_FADE_SHORT | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | -$7.0 | -$7.0 | -$10.0 [n<5] | 66.7% | -$21 | -$30 | -$8.0 | Insufficient_Sample (N < 5) |
| MR1_FADE_SHORT | Gated candidate (never entered) | 112 | 49 | 1 | 0 | 1 | n/a | -$21.5 | -$21.5 | -$24.5 [n<5] | 0.0% | -$22 | -$25 | n/a | Insufficient_Sample (N < 5) |
| VWAP_MAGNET_SHORT | Unknown-origin (pre-2026-07-09) | 2 | 2 | 2 | 0 | 2 | n/a | -$11.0 | -$11.0 | -$14.0 [n<5] | 50.0% | -$22 | -$28 | -$11.0 | Insufficient_Sample (N < 5) |
| PD_HIGH_FADE_LONG | Shadow | 33 | 17 | 14 | 0 | 14 | n/a | -$1.6 | -$1.6 | -$4.6 [-$28.3, $31.0] | 42.9% | -$22 | -$64 | -$11.2 | Unprofitable |
| OR10_MID_FADE_LONG | Live (ACTIVE) | 8 | 3 | 3 | 0 | 3 | n/a | -$8.3 | -$8.3 | -$11.3 [n<5] | 33.3% | -$25 | -$34 | -$9.3 | Insufficient_Sample (N < 5) |
| TRT_SHORT | Shadow | 15 | 13 | 12 | 0 | 12 | n/a | -$2.1 | -$2.1 | -$5.1 [-$56.7, $45.2] | 58.3% | -$26 | -$62 | -$8.6 | Unprofitable |
| PD_IB_HIGH_FADE_LONG | Backfill | 86 | 66 | 66 | 48 | 18 | -$10.1 | $25.3 | -$0.4 | -$3.4 [-$30.2, $22.4] | 66.7% | -$28 | -$226 | -$0.3 | Profitable |
| VALUE_AREA_RESPONSIVE_LONG | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | -$9.7 | -$9.7 | -$12.7 [n<5] | 33.3% | -$29 | -$38 | $50.7 | Insufficient_Sample (N < 5) |
| CAM_R4_FADE_SHORT | Gated candidate (never entered) | 38 | 12 | 4 | 0 | 4 | n/a | -$7.4 | -$7.4 | -$10.4 [n<5] | 50.0% | -$30 | -$42 | n/a | Insufficient_Sample (N < 5) |
| MR1_FADE_SHORT | Backfill | 21 | 18 | 18 | 12 | 6 | $9.7 | -$24.5 | -$1.7 | -$4.7 [-$51.8, $35.7] | 61.1% | -$30 | -$84 | -$3.9 | Unprofitable |
| STACK_VOL_BREAK_LIVE_LONG | Live (ACTIVE) | 15 | 11 | 9 | 0 | 9 | n/a | -$3.4 | -$3.4 | -$6.4 [-$102.1, $59.9] | 44.4% | -$30 | -$57 | $35.3 | Unprofitable |
| OR5_LOW_FADE_SHORT | Shadow | 73 | 47 | 46 | 0 | 46 | n/a | -$0.7 | -$0.7 | -$3.7 [-$22.1, $16.9] | 37.0% | -$31 | -$169 | -$0.6 | Unprofitable |
| WEEKLY_OPEN_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 6 | 5 | 5 | 0 | 5 | n/a | -$6.2 | -$6.2 | -$9.2 [-$21.3, $9.0] | 40.0% | -$31 | -$46 | -$7.2 | Unprofitable |
| OR15_HIGH_FADE_LONG | Gated candidate (never entered) | 77 | 12 | 1 | 0 | 1 | n/a | -$31.0 | -$31.0 | -$34.0 [n<5] | 0.0% | -$31 | -$34 | n/a | Insufficient_Sample (N < 5) |
| OR5_LOW_FADE_LONG_GAP_DOWN | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$33.0 | -$33.0 | -$36.0 [n<5] | 0.0% | -$33 | -$36 | n/a | Insufficient_Sample (N < 5) |
| PD_SESSION_MID_FADE_LONG | Backfill | 122 | 99 | 99 | 66 | 33 | -$8.0 | $15.0 | -$0.3 | -$3.3 [-$28.4, $20.1] | 60.6% | -$34 | -$331 | $0.4 | Profitable |
| WEEKLY_OPEN_FADE_LONG | Gated candidate (never entered) | 13 | 1 | 1 | 0 | 1 | n/a | -$35.0 | -$35.0 | -$38.0 [n<5] | 0.0% | -$35 | -$38 | n/a | Insufficient_Sample (N < 5) |
| IB_HIGH_FADE_LONG | Live (ACTIVE) | 3 | 2 | 2 | 0 | 2 | n/a | -$18.0 | -$18.0 | -$21.0 [n<5] | 50.0% | -$36 | -$42 | -$47.5 | Insufficient_Sample (N < 5) |
| VALUE_AREA_RESPONSIVE_LONG | Gated candidate (never entered) | 58 | 38 | 1 | 0 | 1 | n/a | -$36.5 | -$36.5 | -$39.5 [n<5] | 0.0% | -$37 | -$40 | n/a | Insufficient_Sample (N < 5) |
| CAM_R3_FADE_LONG | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | -$12.3 | -$12.3 | -$15.3 [n<5] | 33.3% | -$37 | -$46 | -$11.8 | Insufficient_Sample (N < 5) |
| TRT_LONG_V2 | Shadow | 9 | 9 | 8 | 0 | 8 | n/a | -$5.3 | -$5.3 | -$8.3 [-$12.1, -$4.4] | 50.0% | -$42 | -$66 | -$10.8 | Unprofitable |
| RSI_DIV_BULLISH | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | -$43.0 | -$43.0 | -$46.0 [n<5] | 0.0% | -$43 | -$46 | -$44.0 | Insufficient_Sample (N < 5) |
| CAM_R3_FADE_SHORT | Gated candidate (never entered) | 34 | 11 | 3 | 0 | 3 | n/a | -$14.5 | -$14.5 | -$17.5 [n<5] | 66.7% | -$44 | -$53 | n/a | Insufficient_Sample (N < 5) |
| 3M_VAL_FADE_SHORT_OVERNIGHT | Shadow | 6 | 4 | 4 | 0 | 4 | n/a | -$11.0 | -$11.0 | -$14.0 [n<5] | 50.0% | -$44 | -$56 | -$12.0 | Insufficient_Sample (N < 5) |
| MR1_FADE_SHORT | Shadow | 7 | 7 | 7 | 0 | 7 | n/a | -$6.4 | -$6.4 | -$9.4 [-$78.0, $84.0] | 42.9% | -$45 | -$66 | -$7.4 | Unprofitable |
| OR10_LOW_FADE_SHORT | Shadow | 19 | 9 | 9 | 0 | 9 | n/a | -$5.0 | -$5.0 | -$8.0 [-$52.8, $35.1] | 44.4% | -$45 | -$72 | -$1.8 | Unprofitable |
| GAP_FILL_SHORT | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$45.0 | -$45.0 | -$48.0 [n<5] | 0.0% | -$45 | -$48 | -$46.0 | Insufficient_Sample (N < 5) |
| PW_LOW_FADE_LONG | Live (ACTIVE) | 2 | 1 | 1 | 0 | 1 | n/a | -$45.0 | -$45.0 | -$48.0 [n<5] | 0.0% | -$45 | -$48 | -$46.0 | Insufficient_Sample (N < 5) |
| CAM_S3_FADE_SHORT | Gated candidate (never entered) | 65 | 1 | 1 | 0 | 1 | n/a | -$45.0 | -$45.0 | -$48.0 [n<5] | 0.0% | -$45 | -$48 | n/a | Insufficient_Sample (N < 5) |
| IB_LOW_PNR_SHORT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | -$45.5 | -$45.5 | -$48.5 [n<5] | 0.0% | -$46 | -$49 | -$48.5 | Insufficient_Sample (N < 5) |
| OR15_HIGH_FADE_SHORT | Live (ACTIVE) | 9 | 7 | 7 | 0 | 7 | n/a | -$6.7 | -$6.7 | -$9.7 [-$55.7, $37.1] | 42.9% | -$47 | -$68 | $11.5 | Unprofitable |
| ONH_FADE_LONG | Live (ACTIVE) | 7 | 7 | 7 | 0 | 7 | n/a | -$6.7 | -$6.7 | -$9.7 [-$84.0, $46.0] | 57.1% | -$47 | -$68 | -$5.6 | Unprofitable |
| CAM_S2_FADE_SHORT | Live (ACTIVE) | 2 | 1 | 1 | 0 | 1 | n/a | -$47.0 | -$47.0 | -$50.0 [n<5] | 0.0% | -$47 | -$50 | -$26.5 | Insufficient_Sample (N < 5) |
| OR30_MID_FADE_SHORT | Gated candidate (never entered) | 74 | 9 | 4 | 0 | 4 | n/a | -$12.0 | -$12.0 | -$15.0 [n<5] | 50.0% | -$48 | -$60 | n/a | Insufficient_Sample (N < 5) |
| CAM_S3_FADE_LONG | Live (ACTIVE) | 2 | 1 | 1 | 0 | 1 | n/a | -$49.0 | -$49.0 | -$52.0 [n<5] | 0.0% | -$49 | -$52 | -$50.0 | Insufficient_Sample (N < 5) |
| FLOOR_PIVOT_FADE_LONG | Gated candidate (never entered) | 126 | 6 | 2 | 0 | 2 | n/a | -$24.8 | -$24.8 | -$27.8 [n<5] | 0.0% | -$50 | -$56 | n/a | Insufficient_Sample (N < 5) |
| CAM_S3_FADE_SHORT | Live (ACTIVE) | 4 | 4 | 4 | 0 | 4 | n/a | -$12.5 | -$12.5 | -$15.5 [n<5] | 25.0% | -$50 | -$62 | $10.8 | Insufficient_Sample (N < 5) |
| PD_POC_FADE_LONG | Unknown-origin (pre-2026-07-09) | 4 | 1 | 1 | 0 | 1 | n/a | -$51.0 | -$51.0 | -$54.0 [n<5] | 0.0% | -$51 | -$54 | -$51.0 | Insufficient_Sample (N < 5) |
| IB_HIGH_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$51.0 | -$51.0 | -$54.0 [n<5] | 0.0% | -$51 | -$54 | -$51.0 | Insufficient_Sample (N < 5) |
| CAM_S1_FADE_LONG | Gated candidate (never entered) | 63 | 8 | 1 | 0 | 1 | n/a | -$51.0 | -$51.0 | -$54.0 [n<5] | 0.0% | -$51 | -$54 | n/a | Insufficient_Sample (N < 5) |
| PD_LOW_FADE_LONG | Gated candidate (never entered) | 21 | 4 | 1 | 0 | 1 | n/a | -$51.0 | -$51.0 | -$54.0 [n<5] | 0.0% | -$51 | -$54 | n/a | Insufficient_Sample (N < 5) |
| OR15_MID_FADE_SHORT | Gated candidate (never entered) | 38 | 2 | 2 | 0 | 2 | n/a | -$27.0 | -$27.0 | -$30.0 [n<5] | 0.0% | -$54 | -$60 | n/a | Insufficient_Sample (N < 5) |
| PD_POC_FADE_SHORT | Backfill | 64 | 56 | 56 | 39 | 17 | $8.9 | -$23.5 | -$1.0 | -$4.0 [-$33.1, $25.1] | 62.5% | -$54 | -$222 | $1.3 | Unprofitable |
| IB_MID_SCALP_FADE_LONG | Shadow | 113 | 68 | 63 | 0 | 63 | n/a | -$0.9 | -$0.9 | -$3.9 [-$20.9, $10.0] | 39.7% | -$56 | -$245 | -$5.1 | Unprofitable |
| WPP_FADE_SHORT | Shadow | 9 | 5 | 5 | 0 | 5 | n/a | -$11.4 | -$11.4 | -$14.4 [-$22.0, -$3.0] | 40.0% | -$57 | -$72 | -$12.4 | Unprofitable |
| CAM_S3_FADE_LONG | Shadow | 54 | 36 | 34 | 0 | 34 | n/a | -$1.7 | -$1.7 | -$4.7 [-$33.3, $24.3] | 44.1% | -$59 | -$161 | $4.2 | Unprofitable |
| 3M_POC_FADE_LONG | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$59.0 | -$59.0 | -$62.0 [n<5] | 0.0% | -$59 | -$62 | -$60.0 | Insufficient_Sample (N < 5) |
| CAM_R1_FADE_LONG | Gated candidate (never entered) | 96 | 4 | 1 | 0 | 1 | n/a | -$59.0 | -$59.0 | -$62.0 [n<5] | 0.0% | -$59 | -$62 | n/a | Insufficient_Sample (N < 5) |
| FLOOR_S2_FADE_LONG | Gated candidate (never entered) | 18 | 1 | 1 | 0 | 1 | n/a | -$59.0 | -$59.0 | -$62.0 [n<5] | 0.0% | -$59 | -$62 | n/a | Insufficient_Sample (N < 5) |
| PW_LOW_FADE_LONG | Gated candidate (never entered) | 28 | 1 | 1 | 0 | 1 | n/a | -$59.0 | -$59.0 | -$62.0 [n<5] | 0.0% | -$59 | -$62 | n/a | Insufficient_Sample (N < 5) |
| ONL_FADE_LONG | Live (ACTIVE) | 6 | 6 | 5 | 0 | 5 | n/a | -$12.1 | -$12.1 | -$15.1 [-$62.7, $64.1] | 40.0% | -$61 | -$76 | -$37.1 | Unprofitable |
| OR5_LOW_FADE_SHORT | Backfill | 25 | 17 | 17 | 12 | 5 | $0.6 | -$13.5 | -$3.6 | -$6.6 [-$56.3, $30.7] | 64.7% | -$61 | -$112 | -$3.6 | Unprofitable |
| VWAP_MAGNET_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$61.0 | -$61.0 | -$64.0 [n<5] | 0.0% | -$61 | -$64 | -$61.0 | Insufficient_Sample (N < 5) |
| CAM_S1_FADE_SHORT | Backfill | 96 | 78 | 78 | 42 | 36 | -$20.1 | $21.7 | -$0.8 | -$3.8 [-$30.8, $20.2] | 65.4% | -$61 | -$295 | -$0.8 | Profitable |
| MS1_FADE_LONG | Shadow | 13 | 12 | 12 | 0 | 12 | n/a | -$5.1 | -$5.1 | -$8.1 [-$34.8, $8.4] | 50.0% | -$62 | -$98 | $24.8 | Unprofitable |
| MR2_FADE_SHORT | Backfill | 5 | 3 | 3 | 1 | 2 | $33.0 | -$47.5 | -$20.7 | -$23.7 [n<5] | 66.7% | -$62 | -$71 | -$20.7 | Insufficient_Sample (N < 5) |
| ZONE_EDGE_FADE | Shadow | 19 | 19 | 18 | 0 | 18 | n/a | -$3.4 | -$3.4 | -$6.4 [-$6.9, -$6.0] | 0.0% | -$62 | -$116 | -$16.4 | Unprofitable |
| CAM_R4_FADE_LONG | Shadow | 27 | 11 | 10 | 0 | 10 | n/a | -$6.2 | -$6.2 | -$9.2 [-$56.4, $38.7] | 40.0% | -$62 | -$92 | -$23.2 | Unprofitable |
| ONH_FADE_SHORT | Live (ACTIVE) | 4 | 4 | 4 | 0 | 4 | n/a | -$15.5 | -$15.5 | -$18.5 [n<5] | 25.0% | -$62 | -$74 | -$1.6 | Insufficient_Sample (N < 5) |
| PD_LOW_FADE_SHORT | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | -$31.0 | -$31.0 | -$34.0 [n<5] | 0.0% | -$62 | -$68 | -$32.0 | Insufficient_Sample (N < 5) |
| PD_VAL_FADE_SHORT | Gated candidate (never entered) | 75 | 5 | 2 | 0 | 2 | n/a | -$31.0 | -$31.0 | -$34.0 [n<5] | 0.0% | -$62 | -$68 | n/a | Insufficient_Sample (N < 5) |
| OR30_HIGH_FADE_SHORT | Live (ACTIVE) | 5 | 5 | 5 | 0 | 5 | n/a | -$12.6 | -$12.6 | -$15.6 [-$66.0, $38.6] | 40.0% | -$63 | -$78 | $11.3 | Unprofitable |
| WEEKLY_OPEN_FADE_SHORT | Gated candidate (never entered) | 44 | 1 | 1 | 0 | 1 | n/a | -$63.0 | -$63.0 | -$66.0 [n<5] | 0.0% | -$63 | -$66 | n/a | Insufficient_Sample (N < 5) |
| PM_HIGH_FADE_LONG | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$65.0 | -$65.0 | -$68.0 [n<5] | 0.0% | -$65 | -$68 | -$66.0 | Insufficient_Sample (N < 5) |
| CAM_S2_FADE_LONG_TRAIL | Gated candidate (never entered) | 92 | 3 | 1 | 0 | 1 | n/a | -$65.0 | -$65.0 | -$68.0 [n<5] | 0.0% | -$65 | -$68 | n/a | Insufficient_Sample (N < 5) |
| PD_OR_MID_FADE_LONG | Live (ACTIVE) | 4 | 1 | 1 | 0 | 1 | n/a | -$67.0 | -$67.0 | -$70.0 [n<5] | 0.0% | -$67 | -$70 | -$68.0 | Insufficient_Sample (N < 5) |
| IB_HIGH_FADE_LONG | Unknown-origin (pre-2026-07-09) | 2 | 2 | 2 | 0 | 2 | n/a | -$34.0 | -$34.0 | -$37.0 [n<5] | 50.0% | -$68 | -$74 | -$34.0 | Insufficient_Sample (N < 5) |
| MINOR_DEFENDED_LEVEL_LONG | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$68.8 | -$68.8 | -$71.8 [n<5] | 0.0% | -$69 | -$72 | $12.0 | Insufficient_Sample (N < 5) |
| PW_POC_FADE_LONG | Shadow | 15 | 9 | 9 | 0 | 9 | n/a | -$7.7 | -$7.7 | -$10.7 [-$61.3, $53.5] | 44.4% | -$69 | -$96 | -$8.7 | Unprofitable |
| WPP_FADE_LONG | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | -$23.0 | -$23.0 | -$26.0 [n<5] | 33.3% | -$69 | -$78 | $13.2 | Insufficient_Sample (N < 5) |
| PD_OR_MID_FADE_SHORT | Live (ACTIVE) | 5 | 3 | 3 | 0 | 3 | n/a | -$23.0 | -$23.0 | -$26.0 [n<5] | 33.3% | -$69 | -$78 | -$24.0 | Insufficient_Sample (N < 5) |
| CAM_S1_FADE_SHORT | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$69.0 | -$69.0 | -$72.0 [n<5] | 0.0% | -$69 | -$72 | -$50.5 | Insufficient_Sample (N < 5) |
| FLOOR_R1_FADE_LONG | Shadow | 47 | 31 | 31 | 0 | 31 | n/a | -$2.2 | -$2.2 | -$5.2 [-$29.2, $28.2] | 48.4% | -$70 | -$163 | $0.4 | Unprofitable |
| PM_LOW_FADE_SHORT | Shadow | 4 | 3 | 3 | 0 | 3 | n/a | -$23.3 | -$23.3 | -$26.3 [n<5] | 66.7% | -$70 | -$79 | -$31.3 | Insufficient_Sample (N < 5) |
| WEEKLY_VWAP_FADE_SHORT | Gated candidate (never entered) | 10 | 4 | 2 | 0 | 2 | n/a | -$35.0 | -$35.0 | -$38.0 [n<5] | 0.0% | -$70 | -$76 | n/a | Insufficient_Sample (N < 5) |
| FLOOR_PIVOT_FADE_LONG | Live (ACTIVE) | 6 | 6 | 6 | 0 | 6 | n/a | -$11.8 | -$11.8 | -$14.8 [-$48.0, $39.6] | 33.3% | -$71 | -$89 | -$33.4 | Unprofitable |
| ONL_FADE_SHORT | Live (ACTIVE) | 6 | 5 | 5 | 0 | 5 | n/a | -$14.2 | -$14.2 | -$17.2 [-$40.5, $6.9] | 20.0% | -$71 | -$86 | -$15.2 | Unprofitable |
| MAJOR_PIVOT_DEFENDED_BREAK_LONG | Live (ACTIVE) | 3 | 1 | 1 | 0 | 1 | n/a | -$71.0 | -$71.0 | -$74.0 [n<5] | 0.0% | -$71 | -$74 | n/a | Insufficient_Sample (N < 5) |
| WR1_FADE_SHORT | Gated candidate (never entered) | 21 | 1 | 1 | 0 | 1 | n/a | -$71.0 | -$71.0 | -$74.0 [n<5] | 0.0% | -$71 | -$74 | n/a | Insufficient_Sample (N < 5) |
| FAILED_SWEEP_REVERSAL_LONG | Shadow | 124 | 122 | 65 | 0 | 65 | n/a | -$1.1 | -$1.1 | -$4.1 [-$44.1, $43.4] | 38.5% | -$73 | -$268 | -$5.6 | Unprofitable |
| CAM_R1_FADE_LONG | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | -$24.3 | -$24.3 | -$27.3 [n<5] | 33.3% | -$73 | -$82 | -$38.0 | Insufficient_Sample (N < 5) |
| BRACKET_BREAKOUT_LONG | Live (ACTIVE) | 10 | 10 | 10 | 0 | 10 | n/a | -$7.4 | -$7.4 | -$10.4 [-$33.5, $84.0] | 40.0% | -$74 | -$104 | -$8.4 | Unprofitable |
| MOMENTUM_CHASE_MEDIUM_SHORT | Shadow | 9 | 7 | 7 | 0 | 7 | n/a | -$10.7 | -$10.7 | -$13.7 [-$69.7, $42.9] | 42.9% | -$75 | -$96 | -$11.7 | Unprofitable |
| 5D_OR_MID_FADE_SHORT | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | -$25.0 | -$25.0 | -$28.0 [n<5] | 33.3% | -$75 | -$84 | -$26.0 | Insufficient_Sample (N < 5) |
| PW_VAL_FADE_LONG | Live (ACTIVE) | 4 | 1 | 1 | 0 | 1 | n/a | -$75.0 | -$75.0 | -$78.0 [n<5] | 0.0% | -$75 | -$78 | n/a | Insufficient_Sample (N < 5) |
| WEEKLY_VWAP_FADE_SHORT | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | -$25.0 | -$25.0 | -$28.0 [n<5] | 33.3% | -$75 | -$84 | -$26.0 | Insufficient_Sample (N < 5) |
| WR1_FADE_LONG | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$75.0 | -$75.0 | -$78.0 [n<5] | 0.0% | -$75 | -$78 | -$76.0 | Insufficient_Sample (N < 5) |
| MR1_FADE_LONG | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$75.0 | -$75.0 | -$78.0 [n<5] | 0.0% | -$75 | -$78 | -$76.0 | Insufficient_Sample (N < 5) |
| WPP_FADE_SHORT | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$75.0 | -$75.0 | -$78.0 [n<5] | 0.0% | -$75 | -$78 | -$76.0 | Insufficient_Sample (N < 5) |
| WS1_FADE_SHORT | Live (ACTIVE) | 2 | 2 | 1 | 0 | 1 | n/a | -$75.0 | -$75.0 | -$78.0 [n<5] | 0.0% | -$75 | -$78 | -$21.0 | Insufficient_Sample (N < 5) |
| PD_IB_LOW_FADE_SHORT | Gated candidate (never entered) | 34 | 1 | 1 | 0 | 1 | n/a | -$75.0 | -$75.0 | -$78.0 [n<5] | 0.0% | -$75 | -$78 | n/a | Insufficient_Sample (N < 5) |
| PW_POC_FADE_SHORT | Gated candidate (never entered) | 16 | 1 | 1 | 0 | 1 | n/a | -$75.0 | -$75.0 | -$78.0 [n<5] | 0.0% | -$75 | -$78 | n/a | Insufficient_Sample (N < 5) |
| TRT_SHORT | Gated candidate (never entered) | 18 | 13 | 2 | 0 | 2 | n/a | -$39.8 | -$39.8 | -$42.8 [n<5] | 50.0% | -$80 | -$86 | n/a | Insufficient_Sample (N < 5) |
| FAILED_AUCTION_SHORT | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$81.0 | -$81.0 | -$84.0 [n<5] | 0.0% | -$81 | -$84 | -$82.0 | Insufficient_Sample (N < 5) |
| PD_SESSION_MID_FADE_SHORT | Gated candidate (never entered) | 90 | 2 | 2 | 0 | 2 | n/a | -$41.0 | -$41.0 | -$44.0 [n<5] | 0.0% | -$82 | -$88 | n/a | Insufficient_Sample (N < 5) |
| OR15_MID_FADE_LONG | Gated candidate (never entered) | 91 | 2 | 2 | 0 | 2 | n/a | -$41.0 | -$41.0 | -$44.0 [n<5] | 0.0% | -$82 | -$88 | n/a | Insufficient_Sample (N < 5) |
| PD_IB_HIGH_FADE_LONG | Shadow | 44 | 24 | 24 | 0 | 24 | n/a | -$3.5 | -$3.5 | -$6.5 [-$31.2, $18.6] | 45.8% | -$84 | -$156 | -$2.8 | Unprofitable |
| OR30_MID_FADE_SHORT | Live (ACTIVE) | 10 | 6 | 6 | 0 | 6 | n/a | -$14.0 | -$14.0 | -$17.0 [-$67.3, $52.0] | 33.3% | -$84 | -$102 | $0.4 | Unprofitable |
| FLOOR_PIVOT_FADE_SHORT | Gated candidate (never entered) | 71 | 2 | 2 | 0 | 2 | n/a | -$42.0 | -$42.0 | -$45.0 [n<5] | 0.0% | -$84 | -$90 | n/a | Insufficient_Sample (N < 5) |
| OR15_MID_FADE_SHORT | Live (ACTIVE) | 13 | 6 | 6 | 0 | 6 | n/a | -$14.8 | -$14.8 | -$17.8 [-$42.4, $33.6] | 16.7% | -$89 | -$107 | -$5.8 | Unprofitable |
| CAM_S2_FADE_LONG_OVERNIGHT | Live (ACTIVE) | 42 | 2 | 2 | 0 | 2 | n/a | -$44.5 | -$44.5 | -$47.5 [n<5] | 50.0% | -$89 | -$95 | -$43.3 | Insufficient_Sample (N < 5) |
| PW_VAL_FADE_SHORT | Gated candidate (never entered) | 43 | 26 | 4 | 0 | 4 | n/a | -$22.3 | -$22.3 | -$25.3 [n<5] | 25.0% | -$89 | -$101 | n/a | Insufficient_Sample (N < 5) |
| OR5_LOW_FADE_SHORT | Live (ACTIVE) | 33 | 33 | 33 | 0 | 33 | n/a | -$2.7 | -$2.7 | -$5.7 [-$25.3, $20.4] | 36.4% | -$91 | -$190 | -$0.3 | Unprofitable |
| A_UP_STRONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$91 | -$94 | -$121.0 | Insufficient_Sample (N < 5) |
| PW_VAH_SWEEP_REVERSAL_SHORT_OVERNIGHT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$91 | -$94 | -$92.0 | Insufficient_Sample (N < 5) |
| PW_VAL_SWEEP_REVERSAL_SHORT_OVERNIGHT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$91 | -$94 | -$92.0 | Insufficient_Sample (N < 5) |
| PW_LOW_SWEEP_REVERSAL_LONG_OVERNIGHT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$91 | -$94 | -$92.0 | Insufficient_Sample (N < 5) |
| MONTHLY_OPEN_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 4 | 1 | 1 | 0 | 1 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$91 | -$94 | -$43.5 | Insufficient_Sample (N < 5) |
| PW_LOW_SWEEP_REVERSAL_SHORT_OVERNIGHT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$91 | -$94 | -$92.0 | Insufficient_Sample (N < 5) |
| CAM_S2_SWEEP_REVERSAL_LONG_OVERNIGHT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$91 | -$94 | -$92.0 | Insufficient_Sample (N < 5) |
| WPP_SWEEP_REVERSAL_SHORT_OVERNIGHT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$91 | -$94 | -$92.0 | Insufficient_Sample (N < 5) |
| FLOOR_S3_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$91 | -$94 | -$92.0 | Insufficient_Sample (N < 5) |
| RTH_VWAP_FADE_SHORT | Gated candidate (never entered) | 159 | 1 | 1 | 0 | 1 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$91 | -$94 | n/a | Insufficient_Sample (N < 5) |
| STOP_SWEEP_SHORT | Gated candidate (never entered) | 133 | 95 | 23 | 0 | 23 | n/a | -$4.0 | -$4.0 | -$7.0 [-$35.9, $22.8] | 60.9% | -$93 | -$162 | n/a | Unprofitable |
| PM_HIGH_FADE_LONG_OVERNIGHT | Shadow | 4 | 4 | 4 | 0 | 4 | n/a | -$23.5 | -$23.5 | -$26.5 [n<5] | 25.0% | -$94 | -$106 | -$24.5 | Insufficient_Sample (N < 5) |
| FLOOR_R2_FADE_SHORT_OVERNIGHT | Shadow | 4 | 4 | 4 | 0 | 4 | n/a | -$23.5 | -$23.5 | -$26.5 [n<5] | 25.0% | -$94 | -$106 | -$24.5 | Insufficient_Sample (N < 5) |
| TRT_LONG | Live (ACTIVE) | 4 | 4 | 4 | 0 | 4 | n/a | -$24.1 | -$24.1 | -$27.1 [n<5] | 75.0% | -$97 | -$109 | $28.1 | Insufficient_Sample (N < 5) |
| PD2_VAL_FADE_SHORT | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | -$49.0 | -$49.0 | -$52.0 [n<5] | 50.0% | -$98 | -$104 | -$50.0 | Insufficient_Sample (N < 5) |
| WR1_FADE_LONG | Backfill | 33 | 26 | 26 | 18 | 8 | $16.4 | -$49.2 | -$3.8 | -$6.8 [-$42.5, $26.8] | 61.5% | -$99 | -$177 | -$3.9 | Unprofitable |
| MONTHLY_OPEN_FADE_LONG_OVERNIGHT | Shadow | 15 | 10 | 10 | 0 | 10 | n/a | -$10.0 | -$10.0 | -$13.0 [-$94.0, $53.3] | 30.0% | -$100 | -$130 | -$11.0 | Unprofitable |
| PD_IB_MID_FADE_SHORT | Gated candidate (never entered) | 394 | 5 | 2 | 0 | 2 | n/a | -$51.0 | -$51.0 | -$54.0 [n<5] | 0.0% | -$102 | -$108 | n/a | Insufficient_Sample (N < 5) |
| PD_VAL_FADE_LONG | Unknown-origin (pre-2026-07-09) | 5 | 2 | 2 | 0 | 2 | n/a | -$51.8 | -$51.8 | -$54.8 [n<5] | 50.0% | -$104 | -$110 | -$51.8 | Insufficient_Sample (N < 5) |
| OR10_LOW_FADE_LONG | Gated candidate (never entered) | 106 | 3 | 3 | 0 | 3 | n/a | -$35.0 | -$35.0 | -$38.0 [n<5] | 33.3% | -$105 | -$114 | n/a | Insufficient_Sample (N < 5) |
| OR15_HIGH_FADE_SHORT | Gated candidate (never entered) | 71 | 6 | 6 | 0 | 6 | n/a | -$17.6 | -$17.6 | -$20.6 [-$70.0, $29.7] | 33.3% | -$106 | -$124 | n/a | Unprofitable |
| WEEKLY_OPEN_FADE_SHORT_OVERNIGHT | Shadow | 21 | 16 | 16 | 0 | 16 | n/a | -$6.6 | -$6.6 | -$9.6 [-$94.0, $68.0] | 31.3% | -$106 | -$154 | -$7.6 | Unprofitable |
| CAM_R2_FADE_LONG | Live (ACTIVE) | 2 | 2 | 2 | 0 | 2 | n/a | -$53.0 | -$53.0 | -$56.0 [n<5] | 0.0% | -$106 | -$112 | -$53.3 | Insufficient_Sample (N < 5) |
| MOMENTUM_CHASE_MEDIUM_LONG | Shadow | 8 | 3 | 3 | 0 | 3 | n/a | -$35.7 | -$35.7 | -$38.7 [n<5] | 33.3% | -$107 | -$116 | -$36.7 | Insufficient_Sample (N < 5) |
| PD_VAL_FADE_SHORT | Shadow | 72 | 39 | 35 | 0 | 35 | n/a | -$3.1 | -$3.1 | -$6.1 [-$31.1, $10.1] | 37.1% | -$108 | -$213 | -$4.7 | Unprofitable |
| PD_VAH_FADE_LONG | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | -$36.3 | -$36.3 | -$39.3 [n<5] | 33.3% | -$109 | -$118 | $12.0 | Insufficient_Sample (N < 5) |
| PM_LOW_FADE_LONG | Backfill | 18 | 16 | 16 | 8 | 8 | $33.5 | -$47.5 | -$7.0 | -$10.0 [-$108.4, $78.8] | 62.5% | -$112 | -$160 | -$15.2 | Unprofitable |
| OR10_HIGH_FADE_LONG | Shadow | 45 | 27 | 27 | 0 | 27 | n/a | -$4.2 | -$4.2 | -$7.2 [-$30.8, $22.8] | 29.6% | -$113 | -$194 | -$10.7 | Unprofitable |
| PD_SESSION_MID_FADE_LONG | Live (ACTIVE) | 3 | 2 | 2 | 0 | 2 | n/a | -$57.0 | -$57.0 | -$60.0 [n<5] | 0.0% | -$114 | -$120 | -$30.8 | Insufficient_Sample (N < 5) |
| CAM_R3_FADE_SHORT | Shadow | 47 | 27 | 24 | 0 | 24 | n/a | -$4.8 | -$4.8 | -$7.8 [-$30.8, $13.9] | 45.8% | -$115 | -$187 | -$7.3 | Unprofitable |
| OR10_HIGH_FADE_SHORT | Gated candidate (never entered) | 76 | 5 | 5 | 0 | 5 | n/a | -$23.4 | -$23.4 | -$26.4 [-$52.0, $24.8] | 20.0% | -$117 | -$132 | n/a | Unprofitable |
| CAM_S4_FADE_LONG | Live (ACTIVE) | 3 | 2 | 2 | 0 | 2 | n/a | -$59.0 | -$59.0 | -$62.0 [n<5] | 0.0% | -$118 | -$124 | -$46.3 | Insufficient_Sample (N < 5) |
| MS1_FADE_LONG | Gated candidate (never entered) | 16 | 2 | 2 | 0 | 2 | n/a | -$59.0 | -$59.0 | -$62.0 [n<5] | 0.0% | -$118 | -$124 | n/a | Insufficient_Sample (N < 5) |
| PD_VAH_FADE_SHORT | Shadow | 119 | 92 | 90 | 0 | 90 | n/a | -$1.4 | -$1.4 | -$4.4 [-$16.5, $9.2] | 40.0% | -$123 | -$393 | -$1.7 | Unprofitable |
| FLOOR_S2_FADE_SHORT | Live (ACTIVE) | 8 | 5 | 5 | 0 | 5 | n/a | -$24.8 | -$24.8 | -$27.8 [-$78.0, -$1.0] | 40.0% | -$124 | -$139 | -$24.1 | Unprofitable |
| OR10_MID_FADE_SHORT | Gated candidate (never entered) | 93 | 26 | 3 | 0 | 3 | n/a | -$41.3 | -$41.3 | -$44.3 [n<5] | 0.0% | -$124 | -$133 | n/a | Insufficient_Sample (N < 5) |
| MONTHLY_VWAP_FADE_LONG | Shadow | 33 | 17 | 12 | 0 | 12 | n/a | -$10.5 | -$10.5 | -$13.5 [-$55.5, $55.3] | 16.7% | -$126 | -$162 | $6.7 | Unprofitable |
| RTH_VWAP_FADE_LONG | Live (ACTIVE) | 27 | 18 | 18 | 0 | 18 | n/a | -$7.1 | -$7.1 | -$10.1 [-$35.1, $16.4] | 38.9% | -$128 | -$182 | -$4.6 | Unprofitable |
| GLOBEX_VWAP_MAGNET_SHORT | Live (ACTIVE) | 25 | 12 | 12 | 0 | 12 | n/a | -$10.7 | -$10.7 | -$13.7 [-$45.1, $23.5] | 41.7% | -$128 | -$164 | $43.0 | Unprofitable |
| OR10_MID_FADE_SHORT | Shadow | 34 | 17 | 17 | 0 | 17 | n/a | -$7.6 | -$7.6 | -$10.6 [-$38.7, $19.1] | 41.2% | -$129 | -$180 | -$15.8 | Unprofitable |
| CAM_R1_FADE_SHORT | Live (ACTIVE) | 4 | 3 | 3 | 0 | 3 | n/a | -$43.0 | -$43.0 | -$46.0 [n<5] | 0.0% | -$129 | -$138 | -$44.0 | Insufficient_Sample (N < 5) |
| PD_IB_MID_FADE_LONG | Live (ACTIVE) | 4 | 3 | 3 | 0 | 3 | n/a | -$43.7 | -$43.7 | -$46.7 [n<5] | 33.3% | -$131 | -$140 | -$54.8 | Insufficient_Sample (N < 5) |
| OR15_MID_FADE_LONG | Shadow | 45 | 24 | 24 | 0 | 24 | n/a | -$5.5 | -$5.5 | -$8.5 [-$33.5, $15.2] | 37.5% | -$132 | -$204 | $6.0 | Unprofitable |
| OR10_MID_FADE_LONG | Gated candidate (never entered) | 90 | 4 | 4 | 0 | 4 | n/a | -$33.0 | -$33.0 | -$36.0 [n<5] | 0.0% | -$132 | -$144 | n/a | Insufficient_Sample (N < 5) |
| WS2_FADE_SHORT | Shadow | 2 | 2 | 2 | 0 | 2 | n/a | -$67.0 | -$67.0 | -$70.0 [n<5] | 50.0% | -$134 | -$140 | -$68.0 | Insufficient_Sample (N < 5) |
| PD_IB_LOW_FADE_SHORT | Backfill (timestamp-corrected +4/5h) | 1 | 1 | 1 | 1 | 0 | -$135.6 | n/a | -$135.6 | -$138.6 [n<5] | 0.0% | -$136 | -$139 | $81.6 | Insufficient_Sample (N < 5) |
| WEEKLY_VWAP_FADE_SHORT | Backfill (timestamp-corrected +4/5h) | 1 | 1 | 1 | 1 | 0 | -$135.6 | n/a | -$135.6 | -$138.6 [n<5] | 0.0% | -$136 | -$139 | $81.0 | Insufficient_Sample (N < 5) |
| GLOBEX_VWAP_MAGNET_LONG | Gated candidate (never entered) | 3570 | 33 | 30 | 0 | 30 | n/a | -$4.5 | -$4.5 | -$7.5 [-$34.0, $22.0] | 43.3% | -$137 | -$227 | n/a | Unprofitable |
| A_DOWN_WEAK | Gated candidate (never entered) | 677 | 261 | 8 | 0 | 8 | n/a | -$17.1 | -$17.1 | -$20.1 [-$43.5, $5.6] | 50.0% | -$137 | -$161 | n/a | Unprofitable |
| GLOBEX_VWAP_FADE_SHORT | Shadow | 229 | 188 | 177 | 0 | 177 | n/a | -$0.8 | -$0.8 | -$3.8 [-$13.7, $6.3] | 44.6% | -$139 | -$670 | $1.1 | Unprofitable |
| FLOOR_S3_FADE_LONG | Shadow | 29 | 19 | 19 | 0 | 19 | n/a | -$7.3 | -$7.3 | -$10.3 [-$37.5, $17.4] | 42.1% | -$139 | -$196 | -$6.1 | Unprofitable |
| TRT_LONG_V2 | Live (ACTIVE) | 4 | 4 | 4 | 0 | 4 | n/a | -$34.8 | -$34.8 | -$37.8 [n<5] | 25.0% | -$139 | -$151 | -$11.3 | Insufficient_Sample (N < 5) |
| PD_IB_HIGH_FADE_LONG | Live (ACTIVE) | 4 | 2 | 2 | 0 | 2 | n/a | -$70.0 | -$70.0 | -$73.0 [n<5] | 0.0% | -$140 | -$146 | -$22.5 | Insufficient_Sample (N < 5) |
| CAM_R4_FADE_LONG | Live (ACTIVE) | 6 | 2 | 2 | 0 | 2 | n/a | -$71.0 | -$71.0 | -$74.0 [n<5] | 0.0% | -$142 | -$148 | -$72.0 | Insufficient_Sample (N < 5) |
| WS1_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$143.0 | -$143.0 | -$146.0 [n<5] | 0.0% | -$143 | -$146 | -$143.0 | Insufficient_Sample (N < 5) |
| OR5_MID_FADE_LONG | Live (ACTIVE) | 23 | 21 | 21 | 0 | 21 | n/a | -$6.8 | -$6.8 | -$9.8 [-$35.0, $18.7] | 38.1% | -$143 | -$206 | -$1.7 | Unprofitable |
| C_PAIRED_LONG | Unknown-origin (pre-2026-07-09) | 5 | 5 | 5 | 0 | 5 | n/a | -$29.0 | -$29.0 | -$32.0 [-$134.7, $108.5] | 20.0% | -$145 | -$160 | -$72.0 | Unprofitable |
| CAM_S4_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$145.0 | -$145.0 | -$148.0 [n<5] | 0.0% | -$145 | -$148 | -$279.5 | Insufficient_Sample (N < 5) |
| PM_VAL_FADE_LONG | Backfill | 20 | 16 | 16 | 9 | 7 | -$21.7 | $7.1 | -$9.1 | -$12.1 [-$91.0, $76.9] | 56.3% | -$146 | -$194 | -$5.5 | Profitable |
| CAM_R1_FADE_SHORT | Gated candidate (never entered) | 106 | 27 | 3 | 0 | 3 | n/a | -$49.0 | -$49.0 | -$52.0 [n<5] | 0.0% | -$147 | -$156 | n/a | Insufficient_Sample (N < 5) |
| 3M_POC_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$149.0 | -$149.0 | -$152.0 [n<5] | 0.0% | -$149 | -$152 | -$149.0 | Insufficient_Sample (N < 5) |
| CAM_S2_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$149.0 | -$149.0 | -$152.0 [n<5] | 0.0% | -$149 | -$152 | -$149.0 | Insufficient_Sample (N < 5) |
| OR30_HIGH_FADE_SHORT | Gated candidate (never entered) | 233 | 166 | 9 | 0 | 9 | n/a | -$16.8 | -$16.8 | -$19.8 [-$52.5, $23.8] | 33.3% | -$151 | -$178 | n/a | Unprofitable |
| OR5_MID_FADE_LONG | Gated candidate (never entered) | 80 | 25 | 9 | 0 | 9 | n/a | -$17.0 | -$17.0 | -$20.0 [-$50.0, $23.0] | 22.2% | -$153 | -$180 | n/a | Unprofitable |
| VWAP_MAGNET_SHORT | Live (ACTIVE) | 9 | 9 | 9 | 0 | 9 | n/a | -$17.2 | -$17.2 | -$20.2 [-$30.0, $46.0] | 33.3% | -$155 | -$182 | -$14.0 | Unprofitable |
| OR5_LOW_FADE_LONG | Shadow | 72 | 53 | 52 | 0 | 52 | n/a | -$3.0 | -$3.0 | -$6.0 [-$25.1, $9.1] | 40.4% | -$157 | -$313 | $1.9 | Unprofitable |
| C_PAIRED_SHORT | Shadow | 105 | 96 | 39 | 0 | 39 | n/a | -$4.1 | -$4.1 | -$7.1 [-$47.6, $40.0] | 48.7% | -$159 | -$276 | -$18.1 | Unprofitable |
| IB_LOW_FADE_LONG | Gated candidate (never entered) | 121 | 4 | 2 | 0 | 2 | n/a | -$80.0 | -$80.0 | -$83.0 [n<5] | 0.0% | -$160 | -$166 | n/a | Insufficient_Sample (N < 5) |
| CAM_R2_FADE_SHORT | Shadow | 59 | 28 | 26 | 0 | 26 | n/a | -$6.2 | -$6.2 | -$9.2 [-$40.8, $23.5] | 38.5% | -$162 | -$240 | -$0.6 | Unprofitable |
| IB_LOW_FADE_LONG | Live (ACTIVE) | 20 | 18 | 16 | 0 | 16 | n/a | -$10.1 | -$10.1 | -$13.1 [-$58.0, $22.6] | 37.5% | -$162 | -$210 | $8.4 | Unprofitable |
| MS1_FADE_LONG | Backfill | 19 | 17 | 17 | 6 | 11 | -$4.5 | -$12.3 | -$9.6 | -$12.6 [-$73.0, $47.8] | 64.7% | -$163 | -$214 | -$9.6 | Unprofitable |
| PW_VAL_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$163.0 | -$163.0 | -$166.0 [n<5] | 0.0% | -$163 | -$166 | -$163.0 | Insufficient_Sample (N < 5) |
| PW_LOW_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$163.0 | -$163.0 | -$166.0 [n<5] | 0.0% | -$163 | -$166 | -$163.0 | Insufficient_Sample (N < 5) |
| CAM_R2_FADE_SHORT | Gated candidate (never entered) | 100 | 42 | 3 | 0 | 3 | n/a | -$55.0 | -$55.0 | -$58.0 [n<5] | 0.0% | -$165 | -$174 | n/a | Insufficient_Sample (N < 5) |
| FLOOR_S1_FADE_SHORT | Shadow | 44 | 26 | 23 | 0 | 23 | n/a | -$7.3 | -$7.3 | -$10.3 [-$40.2, $25.9] | 39.1% | -$168 | -$237 | -$9.0 | Unprofitable |
| PD_CLOSE_FADE_LONG | Live (ACTIVE) | 8 | 8 | 8 | 0 | 8 | n/a | -$21.0 | -$21.0 | -$24.0 [-$34.0, $6.0] | 25.0% | -$168 | -$192 | -$20.6 | Unprofitable |
| MONTHLY_VWAP_FADE_SHORT | Shadow | 32 | 21 | 12 | 0 | 12 | n/a | -$14.3 | -$14.3 | -$17.3 [-$60.0, $53.8] | 16.7% | -$172 | -$208 | -$15.3 | Unprofitable |
| VWAP_MAGNET_LONG | Live (ACTIVE) | 8 | 8 | 8 | 0 | 8 | n/a | -$21.5 | -$21.5 | -$24.5 [-$50.4, $14.4] | 25.0% | -$172 | -$196 | -$6.6 | Unprofitable |
| OR10_LOW_FADE_LONG | Live (ACTIVE) | 6 | 5 | 4 | 0 | 4 | n/a | -$43.0 | -$43.0 | -$46.0 [n<5] | 25.0% | -$172 | -$184 | -$39.6 | Insufficient_Sample (N < 5) |
| OPENING_DRIVE_15MIN_SHORT | Gated candidate (never entered) | 1 | 1 | 1 | 0 | 1 | n/a | -$172.0 | -$172.0 | -$175.0 [n<5] | 0.0% | -$172 | -$175 | n/a | Insufficient_Sample (N < 5) |
| VWAP_MAGNET_SHORT | Gated candidate (never entered) | 52 | 43 | 18 | 0 | 18 | n/a | -$9.9 | -$9.9 | -$12.9 [-$41.5, $38.0] | 33.3% | -$178 | -$232 | n/a | Unprofitable |
| CAM_S4_FADE_SHORT | Shadow | 46 | 29 | 24 | 0 | 24 | n/a | -$7.5 | -$7.5 | -$10.5 [-$50.6, $19.3] | 45.8% | -$180 | -$252 | -$8.3 | Unprofitable |
| OR5_HIGH_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$181.0 | -$181.0 | -$184.0 [n<5] | 0.0% | -$181 | -$184 | -$181.0 | Insufficient_Sample (N < 5) |
| PD_IB_MID_FADE_LONG | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$181.0 | -$181.0 | -$184.0 [n<5] | 0.0% | -$181 | -$184 | -$181.0 | Insufficient_Sample (N < 5) |
| PD_IB_MID_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$181.0 | -$181.0 | -$184.0 [n<5] | 0.0% | -$181 | -$184 | -$181.0 | Insufficient_Sample (N < 5) |
| 5D_OR_MID_FADE_LONG | Shadow | 26 | 15 | 15 | 0 | 15 | n/a | -$12.1 | -$12.1 | -$15.1 [-$46.3, $28.8] | 40.0% | -$181 | -$226 | $0.0 | Unprofitable |
| PM_POC_SWEEP_REVERSAL_SHORT_OVERNIGHT | Shadow | 2 | 2 | 2 | 0 | 2 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$182 | -$188 | -$92.0 | Insufficient_Sample (N < 5) |
| WR2_FADE_SHORT_OVERNIGHT | Shadow | 2 | 2 | 2 | 0 | 2 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$182 | -$188 | -$92.0 | Insufficient_Sample (N < 5) |
| PD_LOW_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 1 | 1 | 1 | 0 | 1 | n/a | -$183.0 | -$183.0 | -$186.0 [n<5] | 0.0% | -$183 | -$186 | -$183.0 | Insufficient_Sample (N < 5) |
| PY_POC_FADE_LONG | Backfill | 1 | 1 | 1 | 0 | 1 | n/a | -$185.0 | -$185.0 | -$188.0 [n<5] | 0.0% | -$185 | -$188 | $0.0 | Insufficient_Sample (N < 5) |
| FLOOR_S1_FADE_LONG_OVERNIGHT | Shadow | 5 | 5 | 5 | 0 | 5 | n/a | -$37.0 | -$37.0 | -$40.0 [-$94.0, $176.0] | 20.0% | -$185 | -$200 | -$38.0 | Unprofitable |
| PM_POC_FADE_SHORT | Live (ACTIVE) | 3 | 1 | 1 | 0 | 1 | n/a | -$187.0 | -$187.0 | -$190.0 [n<5] | 0.0% | -$187 | -$190 | -$188.0 | Insufficient_Sample (N < 5) |
| MS1_FADE_LONG | Live (ACTIVE) | 1 | 1 | 1 | 0 | 1 | n/a | -$187.0 | -$187.0 | -$190.0 [n<5] | 0.0% | -$187 | -$190 | -$31.0 | Insufficient_Sample (N < 5) |
| PD_HIGH_FADE_LONG_OVERNIGHT | Shadow | 6 | 6 | 6 | 0 | 6 | n/a | -$31.3 | -$31.3 | -$34.3 [-$94.0, $25.3] | 16.7% | -$188 | -$206 | -$35.7 | Unprofitable |
| WPP_FADE_SHORT_GAP_UP | Shadow | 18 | 12 | 12 | 0 | 12 | n/a | -$15.8 | -$15.8 | -$18.8 [-$56.2, $30.7] | 33.3% | -$190 | -$226 | $68.0 | Unprofitable |
| WS1_FADE_SHORT | Shadow | 22 | 13 | 12 | 0 | 12 | n/a | -$16.0 | -$16.0 | -$19.0 [-$78.9, $9.7] | 41.7% | -$192 | -$228 | -$13.9 | Unprofitable |
| TRT_SHORT | Live (ACTIVE) | 3 | 3 | 3 | 0 | 3 | n/a | -$64.7 | -$64.7 | -$67.7 [n<5] | 0.0% | -$194 | -$203 | -$53.8 | Insufficient_Sample (N < 5) |
| OR5_LOW_FADE_SHORT | Gated candidate (never entered) | 51 | 14 | 4 | 0 | 4 | n/a | -$49.0 | -$49.0 | -$52.0 [n<5] | 0.0% | -$196 | -$208 | n/a | Insufficient_Sample (N < 5) |
| CAM_S4_FADE_LONG | Shadow | 44 | 27 | 24 | 0 | 24 | n/a | -$8.3 | -$8.3 | -$11.3 [-$52.4, $17.5] | 45.8% | -$199 | -$271 | -$7.3 | Unprofitable |
| IB_MID_SCALP_FADE_LONG | Backfill | 150 | 124 | 124 | 80 | 44 | $0.3 | -$5.0 | -$1.6 | -$4.6 [-$19.1, $9.4] | 63.7% | -$200 | -$572 | $0.2 | Unprofitable |
| WS2_FADE_LONG | Shadow | 2 | 1 | 1 | 0 | 1 | n/a | -$203.0 | -$203.0 | -$206.0 [n<5] | 0.0% | -$203 | -$206 | -$204.0 | Insufficient_Sample (N < 5) |
| PW_VAL_FADE_LONG_OVERNIGHT | Shadow | 32 | 29 | 29 | 0 | 29 | n/a | -$7.1 | -$7.1 | -$10.1 [-$56.8, $53.6] | 37.9% | -$205 | -$292 | -$8.2 | Unprofitable |
| VALUE_AREA_RESPONSIVE_SHORT | Unknown-origin (pre-2026-07-09) | 85 | 64 | 64 | 35 | 29 | $5.5 | -$13.7 | -$3.2 | -$6.2 [-$19.5, $9.1] | 26.6% | -$205 | -$397 | $4.1 | Unprofitable |
| OPEN_DRIVE_SHORT | Shadow | 18 | 18 | 4 | 0 | 4 | n/a | -$51.6 | -$51.6 | -$54.6 [n<5] | 25.0% | -$207 | -$219 | -$39.8 | Insufficient_Sample (N < 5) |
| TRT_LONG | Gated candidate (never entered) | 3 | 3 | 3 | 0 | 3 | n/a | -$70.0 | -$70.0 | -$73.0 [n<5] | 66.7% | -$210 | -$219 | n/a | Insufficient_Sample (N < 5) |
| PW_HIGH_FADE_SHORT | Shadow | 13 | 10 | 9 | 0 | 9 | n/a | -$23.9 | -$23.9 | -$26.9 [-$62.6, $25.7] | 33.3% | -$215 | -$242 | -$24.9 | Unprofitable |
| ONH_FADE_LONG | Shadow | 74 | 49 | 42 | 0 | 42 | n/a | -$5.1 | -$5.1 | -$8.1 [-$36.8, $17.0] | 50.0% | -$215 | -$341 | -$2.2 | Unprofitable |
| OR10_LOW_FADE_SHORT | Live (ACTIVE) | 15 | 10 | 10 | 0 | 10 | n/a | -$21.8 | -$21.8 | -$24.8 [-$68.0, $23.0] | 30.0% | -$218 | -$248 | -$18.6 | Unprofitable |
| PM_HIGH_FADE_SHORT | Shadow | 11 | 10 | 10 | 0 | 10 | n/a | -$22.1 | -$22.1 | -$25.1 [-$74.0, -$4.1] | 30.0% | -$221 | -$251 | -$26.4 | Unprofitable |
| DAILY_OPEN_FADE_SHORT | Backfill (timestamp-corrected +4/5h) | 1 | 1 | 1 | 1 | 0 | -$225.0 | n/a | -$225.0 | -$228.0 [n<5] | 0.0% | -$225 | -$228 | $128.0 | Insufficient_Sample (N < 5) |
| OR30_MID_FADE_LONG | Live (ACTIVE) | 6 | 3 | 3 | 0 | 3 | n/a | -$75.0 | -$75.0 | -$78.0 [n<5] | 0.0% | -$225 | -$234 | -$65.5 | Insufficient_Sample (N < 5) |
| OVERNIGHT_ORDERFLOW_SHORT | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | -$225.5 | -$225.5 | -$228.5 [n<5] | 0.0% | -$226 | -$229 | -$778.0 | Insufficient_Sample (N < 5) |
| PD_VAL_FADE_LONG | Backfill | 126 | 102 | 102 | 68 | 34 | $9.4 | -$25.5 | -$2.2 | -$5.2 [-$29.4, $17.5] | 61.8% | -$226 | -$532 | -$4.4 | Unprofitable |
| PD_POC_FADE_LONG | Backfill | 132 | 104 | 104 | 71 | 33 | -$3.3 | $0.2 | -$2.2 | -$5.2 [-$25.6, $14.4] | 62.5% | -$228 | -$540 | -$0.4 | Profitable |
| BRACKET_BREAKOUT_LONG | Shadow | 28 | 28 | 22 | 0 | 22 | n/a | -$10.4 | -$10.4 | -$13.4 [-$22.4, $77.0] | 40.9% | -$228 | -$294 | -$7.8 | Unprofitable |
| WEEKLY_VWAP_FADE_SHORT | Backfill | 144 | 112 | 112 | 69 | 43 | -$8.2 | $7.9 | -$2.1 | -$5.1 [-$23.7, $12.2] | 59.8% | -$230 | -$566 | $0.5 | Profitable |
| IB_BEARISH | Gated candidate (never entered) | 445 | 301 | 14 | 0 | 14 | n/a | -$16.4 | -$16.4 | -$19.4 [-$71.6, $10.7] | 42.9% | -$230 | -$272 | n/a | Unprofitable |
| PD_IB_LOW_FADE_LONG | Shadow | 39 | 21 | 20 | 0 | 20 | n/a | -$11.5 | -$11.5 | -$14.5 [-$48.9, $35.8] | 45.0% | -$231 | -$291 | -$21.7 | Unprofitable |
| PM_HIGH_FADE_LONG | Shadow | 19 | 15 | 15 | 0 | 15 | n/a | -$15.5 | -$15.5 | -$18.5 [-$74.0, $0.9] | 40.0% | -$233 | -$278 | -$17.3 | Unprofitable |
| VWAP_MAGNET_SHORT | Shadow | 48 | 47 | 33 | 0 | 33 | n/a | -$7.1 | -$7.1 | -$10.1 [-$34.0, $2.2] | 51.5% | -$235 | -$334 | $1.2 | Unprofitable |
| IB_MID_SCALP_FADE_SHORT | Shadow | 109 | 76 | 74 | 0 | 74 | n/a | -$3.2 | -$3.2 | -$6.2 [-$20.7, $11.3] | 24.3% | -$238 | -$460 | -$1.8 | Unprofitable |
| 3M_VAL_FADE_SHORT | Shadow | 7 | 5 | 5 | 0 | 5 | n/a | -$47.8 | -$47.8 | -$50.8 [-$192.0, -$15.5] | 40.0% | -$239 | -$254 | -$61.4 | Unprofitable |
| WR1_FADE_SHORT | Backfill | 59 | 41 | 41 | 23 | 18 | -$9.0 | -$1.9 | -$5.9 | -$8.9 [-$35.4, $18.9] | 56.1% | -$240 | -$363 | -$4.7 | Unprofitable |
| OPENING_DRIVE_15MIN_SHORT | Shadow | 4 | 3 | 3 | 0 | 3 | n/a | -$80.8 | -$80.8 | -$83.8 [n<5] | 33.3% | -$243 | -$252 | -$81.8 | Insufficient_Sample (N < 5) |
| GLOBEX_VWAP_MAGNET_LONG | Shadow | 143 | 134 | 96 | 0 | 96 | n/a | -$2.5 | -$2.5 | -$5.5 [-$14.8, $10.3] | 53.1% | -$244 | -$532 | $0.8 | Unprofitable |
| ONH_FADE_SHORT | Gated candidate (never entered) | 84 | 4 | 4 | 0 | 4 | n/a | -$61.0 | -$61.0 | -$64.0 [n<5] | 0.0% | -$244 | -$256 | n/a | Insufficient_Sample (N < 5) |
| OR30_HIGH_FADE_LONG | Shadow | 33 | 23 | 23 | 0 | 23 | n/a | -$10.7 | -$10.7 | -$13.7 [-$42.5, $20.1] | 34.8% | -$247 | -$316 | -$4.8 | Unprofitable |
| PD_CLOSE_FADE_SHORT | Gated candidate (never entered) | 102 | 55 | 5 | 0 | 5 | n/a | -$49.4 | -$49.4 | -$52.4 [-$54.0, -$50.0] | 0.0% | -$247 | -$262 | n/a | Unprofitable |
| PM_POC_FADE_LONG | Shadow | 18 | 10 | 10 | 0 | 10 | n/a | -$24.8 | -$24.8 | -$27.8 [-$76.7, $44.8] | 60.0% | -$248 | -$278 | -$43.8 | Unprofitable |
| WR2_FADE_SHORT | Shadow | 2 | 2 | 2 | 0 | 2 | n/a | -$126.0 | -$126.0 | -$129.0 [n<5] | 0.0% | -$252 | -$258 | -$127.0 | Insufficient_Sample (N < 5) |
| WR1_FADE_SHORT_OVERNIGHT | Shadow | 5 | 4 | 4 | 0 | 4 | n/a | -$63.6 | -$63.6 | -$66.6 [n<5] | 25.0% | -$255 | -$267 | -$59.0 | Insufficient_Sample (N < 5) |
| PM_VAL_FADE_LONG | Shadow | 17 | 7 | 7 | 0 | 7 | n/a | -$37.1 | -$37.1 | -$40.1 [-$111.0, $20.3] | 28.6% | -$260 | -$281 | -$33.1 | Unprofitable |
| 10D_IB_MID_FADE_SHORT | Shadow | 27 | 14 | 13 | 0 | 13 | n/a | -$20.1 | -$20.1 | -$23.1 [-$79.2, $20.4] | 38.5% | -$261 | -$300 | -$21.1 | Unprofitable |
| CAM_R3_FADE_LONG | Backfill | 77 | 56 | 56 | 37 | 19 | -$11.3 | $8.3 | -$4.7 | -$7.7 [-$37.0, $19.2] | 64.3% | -$261 | -$429 | -$3.5 | Profitable |
| FLOOR_R2_FADE_LONG | Backfill | 17 | 12 | 12 | 9 | 3 | -$32.6 | $10.5 | -$21.8 | -$24.8 [-$92.5, $35.2] | 50.0% | -$262 | -$298 | $3.0 | Insufficient_Sample (N < 5) |
| OR15_HIGH_FADE_SHORT | Shadow | 51 | 29 | 29 | 0 | 29 | n/a | -$9.0 | -$9.0 | -$12.0 [-$33.8, $13.2] | 37.9% | -$262 | -$349 | $1.4 | Unprofitable |
| VWAP_MAGNET_SHORT | Backfill (timestamp-corrected +4/5h) | 500 | 500 | 500 | 148 | 352 | -$3.3 | $0.7 | -$0.5 | -$3.5 [-$7.8, $0.5] | 59.6% | -$263 | -$1763 | $1.6 | Profitable |
| WEEKLY_VWAP_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 11 | 8 | 8 | 0 | 8 | n/a | -$33.3 | -$33.3 | -$36.3 [-$62.0, $41.0] | 12.5% | -$266 | -$290 | -$30.9 | Unprofitable |
| IB_BULLISH | Shadow | 16 | 15 | 14 | 0 | 14 | n/a | -$19.2 | -$19.2 | -$22.2 [-$58.4, $10.7] | 42.9% | -$269 | -$311 | $4.4 | Unprofitable |
| OR5_MID_FADE_LONG | Backfill | 99 | 83 | 83 | 52 | 31 | $1.9 | -$11.9 | -$3.3 | -$6.3 [-$23.6, $12.9] | 62.7% | -$272 | -$521 | -$2.6 | Unprofitable |
| CAM_R3_FADE_SHORT | Backfill | 154 | 129 | 129 | 81 | 48 | -$0.0 | -$5.6 | -$2.1 | -$5.1 [-$24.3, $12.7] | 63.6% | -$273 | -$660 | -$0.7 | Unprofitable |
| PD2_VAL_FADE_LONG | Shadow | 23 | 12 | 12 | 0 | 12 | n/a | -$23.1 | -$23.1 | -$26.1 [-$115.6, $60.1] | 50.0% | -$278 | -$314 | -$21.8 | Unprofitable |
| C_STANDALONE_DOWN | Shadow | 1 | 1 | 1 | 0 | 1 | n/a | -$279.0 | -$279.0 | -$282.0 [n<5] | 0.0% | -$279 | -$282 | -$280.0 | Insufficient_Sample (N < 5) |
| FAILED_AUCTION_LONG | Gated candidate (never entered) | 390 | 305 | 19 | 0 | 19 | n/a | -$14.9 | -$14.9 | -$17.9 [-$29.6, -$3.8] | 42.1% | -$283 | -$340 | n/a | Unprofitable |
| 2D_POC_FADE_SHORT | Gated candidate (never entered) | 17 | 16 | 3 | 0 | 3 | n/a | -$94.3 | -$94.3 | -$97.3 [n<5] | 33.3% | -$283 | -$292 | n/a | Insufficient_Sample (N < 5) |
| CAM_S2_FADE_SHORT | Shadow | 56 | 38 | 37 | 0 | 37 | n/a | -$7.8 | -$7.8 | -$10.8 [-$27.6, $4.6] | 37.8% | -$287 | -$398 | -$8.1 | Unprofitable |
| 10D_IB_MID_FADE_SHORT_OVERNIGHT | Shadow | 17 | 8 | 8 | 0 | 8 | n/a | -$36.0 | -$36.0 | -$39.0 [-$94.0, $17.4] | 25.0% | -$288 | -$312 | -$37.0 | Unprofitable |
| WEEKLY_VWAP_FADE_LONG | Shadow | 29 | 13 | 13 | 0 | 13 | n/a | -$22.7 | -$22.7 | -$25.7 [-$59.3, $10.5] | 30.8% | -$295 | -$334 | -$19.7 | Unprofitable |
| MR1_FADE_LONG | Backfill | 21 | 18 | 18 | 12 | 6 | $15.8 | -$81.0 | -$16.5 | -$19.5 [-$62.5, $23.5] | 50.0% | -$297 | -$351 | -$16.5 | Unprofitable |
| FAILED_SWEEP_REVERSAL_SHORT | Shadow | 70 | 69 | 63 | 0 | 63 | n/a | -$4.7 | -$4.7 | -$7.7 [-$42.0, $33.0] | 38.1% | -$298 | -$487 | -$4.0 | Unprofitable |
| PD_OR_MID_FADE_LONG | Shadow | 59 | 21 | 18 | 0 | 18 | n/a | -$16.7 | -$16.7 | -$19.7 [-$55.9, $17.1] | 38.9% | -$301 | -$355 | -$3.2 | Unprofitable |
| CAM_S2_FADE_SHORT | Backfill | 69 | 54 | 54 | 31 | 23 | -$5.2 | -$6.1 | -$5.6 | -$8.6 [-$37.9, $20.8] | 61.1% | -$302 | -$464 | -$5.6 | Unprofitable |
| GLOBEX_VWAP_MAGNET_SHORT | Gated candidate (never entered) | 2533 | 47 | 17 | 0 | 17 | n/a | -$18.1 | -$18.1 | -$21.1 [-$32.8, $8.0] | 29.4% | -$308 | -$359 | n/a | Unprofitable |
| FAILED_AUCTION_SHORT | Unknown-origin (pre-2026-07-09) | 10 | 6 | 6 | 2 | 4 | -$36.0 | -$62.0 | -$53.3 | -$56.3 [-$75.3, -$41.7] | 0.0% | -$320 | -$338 | -$26.7 | Insufficient_Sample (N < 5) |
| GLOBEX_VWAP_FADE_SHORT | Backfill (timestamp-corrected +4/5h) | 134 | 134 | 134 | 80 | 54 | -$2.2 | -$2.9 | -$2.5 | -$5.5 [-$24.6, $13.8] | 66.4% | -$329 | -$731 | $4.8 | Unprofitable |
| OR5_MID_FADE_SHORT | Shadow | 90 | 51 | 50 | 0 | 50 | n/a | -$6.6 | -$6.6 | -$9.6 [-$29.7, $11.6] | 36.0% | -$330 | -$480 | -$6.8 | Unprofitable |
| OR30_HIGH_FADE_LONG | Live (ACTIVE) | 16 | 15 | 15 | 0 | 15 | n/a | -$22.6 | -$22.6 | -$25.6 [-$45.3, $15.3] | 26.7% | -$339 | -$384 | -$18.1 | Unprofitable |
| FLOOR_R2_FADE_LONG | Shadow | 27 | 15 | 15 | 0 | 15 | n/a | -$22.9 | -$22.9 | -$25.9 [-$57.4, $22.0] | 33.3% | -$344 | -$389 | -$20.4 | Unprofitable |
| VWAP_MAGNET_LONG | Shadow | 95 | 95 | 63 | 0 | 63 | n/a | -$5.5 | -$5.5 | -$8.5 [-$16.1, $10.4] | 54.0% | -$348 | -$537 | -$0.9 | Unprofitable |
| VALUE_AREA_RESPONSIVE_LONG | Shadow | 31 | 31 | 29 | 0 | 29 | n/a | -$12.0 | -$12.0 | -$15.0 [-$42.1, $8.6] | 41.4% | -$349 | -$436 | -$10.1 | Unprofitable |
| PD2_VAH_FADE_SHORT | Gated candidate (never entered) | 13 | 8 | 2 | 0 | 2 | n/a | -$175.5 | -$175.5 | -$178.5 [n<5] | 0.0% | -$351 | -$357 | n/a | Insufficient_Sample (N < 5) |
| PD_SESSION_MID_FADE_LONG | Shadow | 49 | 29 | 27 | 0 | 27 | n/a | -$13.0 | -$13.0 | -$16.0 [-$43.5, $9.1] | 40.7% | -$352 | -$433 | -$15.1 | Unprofitable |
| PD_VAH_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 4 | 4 | 4 | 0 | 4 | n/a | -$88.6 | -$88.6 | -$91.6 [n<5] | 25.0% | -$355 | -$367 | -$88.6 | Insufficient_Sample (N < 5) |
| MR1_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 5 | 5 | 5 | 0 | 5 | n/a | -$71.2 | -$71.2 | -$74.2 [-$94.0, -$44.5] | 20.0% | -$356 | -$371 | -$76.6 | Unprofitable |
| VWAP_RECLAIM_SHORT | Gated candidate (never entered) | 66 | 41 | 6 | 0 | 6 | n/a | -$59.6 | -$59.6 | -$62.6 [-$78.0, -$38.4] | 16.7% | -$358 | -$376 | n/a | Unprofitable |
| PW_POC_FADE_SHORT | Shadow | 16 | 7 | 7 | 0 | 7 | n/a | -$51.2 | -$51.2 | -$54.2 [-$78.0, -$9.6] | 14.3% | -$359 | -$380 | -$54.3 | Unprofitable |
| CAM_R3_FADE_LONG | Shadow | 41 | 22 | 19 | 0 | 19 | n/a | -$19.1 | -$19.1 | -$22.1 [-$59.6, $11.8] | 31.6% | -$363 | -$420 | -$20.1 | Unprofitable |
| GAP_FILL_SHORT | Unknown-origin (pre-2026-07-09) | 2 | 2 | 2 | 0 | 2 | n/a | -$182.0 | -$182.0 | -$185.0 [n<5] | 0.0% | -$364 | -$370 | -$208.0 | Insufficient_Sample (N < 5) |
| WS1_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 6 | 4 | 4 | 0 | 4 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$364 | -$376 | -$76.8 | Insufficient_Sample (N < 5) |
| PM_HIGH_FADE_LONG_OVERNIGHT | Live (ACTIVE) | 4 | 4 | 4 | 0 | 4 | n/a | -$91.0 | -$91.0 | -$94.0 [n<5] | 0.0% | -$364 | -$376 | -$92.0 | Insufficient_Sample (N < 5) |
| OR10_MID_FADE_LONG | Shadow | 45 | 30 | 30 | 0 | 30 | n/a | -$12.2 | -$12.2 | -$15.2 [-$36.8, $10.1] | 33.3% | -$367 | -$457 | -$3.4 | Unprofitable |
| MS1_FADE_SHORT_OVERNIGHT | Shadow | 8 | 7 | 7 | 0 | 7 | n/a | -$52.4 | -$52.4 | -$55.4 [-$94.0, -$26.5] | 14.3% | -$367 | -$388 | -$53.4 | Unprofitable |
| ONH_FADE_SHORT | Shadow | 78 | 51 | 50 | 0 | 50 | n/a | -$7.4 | -$7.4 | -$10.4 [-$28.0, $3.1] | 38.0% | -$369 | -$519 | -$7.6 | Unprofitable |
| FLOOR_PIVOT_FADE_SHORT | Shadow | 64 | 42 | 36 | 0 | 36 | n/a | -$10.3 | -$10.3 | -$13.3 [-$39.6, $13.5] | 33.3% | -$370 | -$478 | -$9.3 | Unprofitable |
| PD_IB_MID_FADE_LONG | Backfill | 106 | 79 | 79 | 50 | 29 | -$9.8 | $4.1 | -$4.7 | -$7.7 [-$25.9, $8.7] | 63.3% | -$374 | -$611 | -$4.2 | Profitable |
| OR5_HIGH_FADE_SHORT | Shadow | 98 | 65 | 61 | 0 | 61 | n/a | -$6.1 | -$6.1 | -$9.1 [-$29.7, $16.6] | 31.1% | -$374 | -$557 | $0.9 | Unprofitable |
| FLOOR_R2_FADE_LONG | Live (ACTIVE) | 6 | 5 | 5 | 0 | 5 | n/a | -$75.0 | -$75.0 | -$78.0 [-$78.0, -$78.0] | 0.0% | -$375 | -$390 | -$76.0 | Unprofitable |
| WEEKLY_OPEN_FADE_LONG | Shadow | 52 | 41 | 40 | 0 | 40 | n/a | -$9.6 | -$9.6 | -$12.6 [-$37.6, $8.6] | 35.0% | -$382 | -$502 | -$9.3 | Unprofitable |
| 3M_POC_FADE_LONG | Shadow | 45 | 36 | 36 | 0 | 36 | n/a | -$10.7 | -$10.7 | -$13.7 [-$39.1, $20.8] | 41.7% | -$386 | -$494 | -$9.8 | Unprofitable |
| PD_POC_FADE_LONG_TRAIL | Shadow | 31 | 28 | 28 | 0 | 28 | n/a | -$13.9 | -$13.9 | -$16.9 [-$50.9, $17.4] | 42.9% | -$389 | -$473 | -$11.8 | Unprofitable |
| PW_VAL_FADE_LONG | Shadow | 49 | 30 | 27 | 0 | 27 | n/a | -$14.4 | -$14.4 | -$17.4 [-$60.4, $12.2] | 44.4% | -$389 | -$470 | -$16.4 | Unprofitable |
| CAM_R1_FADE_SHORT | Shadow | 68 | 35 | 33 | 0 | 33 | n/a | -$11.9 | -$11.9 | -$14.9 [-$31.6, $7.4] | 33.3% | -$393 | -$492 | -$13.7 | Unprofitable |
| FAILED_AUCTION_LONG | Unknown-origin (pre-2026-07-09) | 6 | 5 | 5 | 1 | 4 | -$67.0 | -$82.1 | -$79.1 | -$82.1 [-$131.2, -$29.9] | 20.0% | -$396 | -$411 | $76.3 | Insufficient_Sample (N < 5) |
| FLOOR_S2_FADE_LONG | Shadow | 55 | 32 | 25 | 0 | 25 | n/a | -$16.0 | -$16.0 | -$19.0 [-$36.4, $1.1] | 36.0% | -$401 | -$476 | -$9.9 | Unprofitable |
| WR2_FADE_LONG | Backfill | 14 | 10 | 10 | 8 | 2 | -$40.5 | -$40.5 | -$40.5 | -$43.5 [-$116.4, $29.4] | 50.0% | -$405 | -$435 | -$40.5 | Insufficient_Sample (N < 5) |
| 2D_POC_FADE_LONG | Shadow | 19 | 9 | 8 | 0 | 8 | n/a | -$51.0 | -$51.0 | -$54.0 [-$184.0, $38.9] | 50.0% | -$408 | -$432 | -$52.0 | Unprofitable |
| IB_MID_SCALP_FADE_LONG | Live (ACTIVE) | 17 | 13 | 12 | 0 | 12 | n/a | -$34.2 | -$34.2 | -$37.2 [-$68.3, -$3.6] | 16.7% | -$410 | -$446 | -$30.1 | Unprofitable |
| PD_IB_LOW_FADE_SHORT | Backfill | 64 | 53 | 53 | 35 | 18 | -$10.2 | -$2.9 | -$7.7 | -$10.7 [-$40.2, $18.8] | 58.5% | -$410 | -$569 | -$7.5 | Unprofitable |
| FLOOR_PIVOT_FADE_LONG | Shadow | 61 | 42 | 40 | 0 | 40 | n/a | -$10.4 | -$10.4 | -$13.4 [-$36.9, $6.6] | 35.0% | -$415 | -$535 | -$4.9 | Unprofitable |
| PD_LOW_FADE_LONG | Shadow | 44 | 29 | 29 | 0 | 29 | n/a | -$14.4 | -$14.4 | -$17.4 [-$42.9, $26.7] | 34.5% | -$419 | -$506 | -$8.5 | Unprofitable |
| PD_POC_FADE_LONG | Live (ACTIVE) | 61 | 45 | 44 | 0 | 44 | n/a | -$9.5 | -$9.5 | -$12.5 [-$39.9, $12.2] | 43.2% | -$419 | -$551 | -$3.9 | Unprofitable |
| OR5_HIGH_FADE_SHORT | Gated candidate (never entered) | 69 | 13 | 9 | 0 | 9 | n/a | -$47.2 | -$47.2 | -$50.2 [-$79.6, -$2.0] | 11.1% | -$425 | -$452 | n/a | Unprofitable |
| CAM_S3_FADE_SHORT | Shadow | 50 | 37 | 35 | 0 | 35 | n/a | -$12.2 | -$12.2 | -$15.2 [-$49.9, $12.1] | 34.3% | -$426 | -$531 | -$1.4 | Unprofitable |
| POC_ROTATION_JOIN_LONG | Live (ACTIVE) | 18 | 11 | 10 | 0 | 10 | n/a | -$43.5 | -$43.5 | -$46.5 [-$164.8, $183.8] | 30.0% | -$435 | -$465 | -$63.1 | Unprofitable |
| OR15_HIGH_FADE_LONG | Shadow | 37 | 17 | 17 | 0 | 17 | n/a | -$25.9 | -$25.9 | -$28.9 [-$53.9, $6.0] | 23.5% | -$441 | -$492 | -$18.1 | Unprofitable |
| MS1_FADE_SHORT | Shadow | 6 | 5 | 5 | 0 | 5 | n/a | -$89.3 | -$89.3 | -$92.3 [-$188.0, -$56.0] | 40.0% | -$447 | -$462 | -$91.0 | Unprofitable |
| C_PAIRED_SHORT | Live (ACTIVE) | 12 | 11 | 10 | 0 | 10 | n/a | -$45.3 | -$45.3 | -$48.3 [-$191.4, $57.9] | 30.0% | -$453 | -$483 | -$38.0 | Unprofitable |
| MPP_FADE_SHORT_OVERNIGHT | Shadow | 9 | 5 | 5 | 0 | 5 | n/a | -$91.0 | -$91.0 | -$94.0 [-$94.0, -$94.0] | 0.0% | -$455 | -$470 | -$92.0 | Unprofitable |
| PW_HIGH_FADE_LONG_OVERNIGHT | Live (ACTIVE) | 5 | 5 | 5 | 0 | 5 | n/a | -$91.0 | -$91.0 | -$94.0 [-$94.0, -$94.0] | 0.0% | -$455 | -$470 | -$92.0 | Unprofitable |
| STACK_VOL_BREAK_LIVE_SHORT | Live (ACTIVE) | 15 | 12 | 12 | 0 | 12 | n/a | -$38.8 | -$38.8 | -$41.8 [-$124.9, $21.9] | 41.7% | -$466 | -$502 | -$57.5 | Unprofitable |
| IB_BEARISH | Shadow | 149 | 149 | 30 | 0 | 30 | n/a | -$16.1 | -$16.1 | -$19.1 [-$43.2, $11.6] | 40.0% | -$485 | -$575 | -$7.3 | Unprofitable |
| IB_LOW_FADE_SHORT | Backfill | 19 | 14 | 14 | 7 | 7 | -$49.1 | -$20.1 | -$34.6 | -$37.6 [-$95.7, $5.9] | 50.0% | -$485 | -$527 | -$34.6 | Unprofitable |
| OR5_MID_FADE_SHORT | Backfill | 131 | 100 | 100 | 67 | 33 | $8.2 | -$31.8 | -$5.0 | -$8.0 [-$26.3, $7.9] | 62.0% | -$503 | -$803 | -$3.0 | Unprofitable |
| C_PAIRED_SHORT | Gated candidate (never entered) | 581 | 371 | 24 | 0 | 24 | n/a | -$21.1 | -$21.1 | -$24.1 [-$40.3, -$10.9] | 45.8% | -$507 | -$579 | n/a | Unprofitable |
| GLOBEX_VWAP_MAGNET_LONG | Live (ACTIVE) | 43 | 30 | 30 | 0 | 30 | n/a | -$16.9 | -$16.9 | -$19.9 [-$35.9, -$6.8] | 36.7% | -$508 | -$598 | -$16.9 | Unprofitable |
| C_STANDALONE_DOWN | Gated candidate (never entered) | 31 | 24 | 3 | 0 | 3 | n/a | -$172.3 | -$172.3 | -$175.3 [n<5] | 33.3% | -$517 | -$526 | n/a | Insufficient_Sample (N < 5) |
| IB_HIGH_FADE_LONG | Shadow | 84 | 60 | 55 | 0 | 55 | n/a | -$9.4 | -$9.4 | -$12.4 [-$24.6, $1.5] | 38.2% | -$520 | -$685 | -$10.5 | Unprofitable |
| MAJOR_PIVOT_DEFENDED_BREAK_SHORT | Shadow | 3 | 1 | 1 | 0 | 1 | n/a | -$522.5 | -$522.5 | -$525.5 [n<5] | 0.0% | -$522 | -$525 | -$523.5 | Insufficient_Sample (N < 5) |
| IB_BULLISH | Unknown-origin (pre-2026-07-09) | 138 | 110 | 110 | 58 | 52 | -$20.2 | $12.0 | -$5.0 | -$8.0 [-$35.3, $19.5] | 56.4% | -$548 | -$878 | -$3.0 | Profitable |
| PW_LOW_FADE_SHORT_OVERNIGHT | Shadow | 13 | 12 | 12 | 0 | 12 | n/a | -$46.0 | -$46.0 | -$49.0 [-$94.0, $14.0] | 16.7% | -$552 | -$588 | -$35.3 | Unprofitable |
| GLOBEX_FLUSH_REVERSAL_LONG | Shadow | 5 | 5 | 5 | 0 | 5 | n/a | -$110.6 | -$110.6 | -$113.6 [-$193.0, $26.7] | 20.0% | -$553 | -$568 | -$73.0 | Unprofitable |
| PM_POC_FADE_SHORT_OVERNIGHT | Shadow | 26 | 23 | 23 | 0 | 23 | n/a | -$24.5 | -$24.5 | -$27.5 [-$73.2, $14.9] | 26.1% | -$563 | -$632 | -$25.5 | Unprofitable |
| OR10_HIGH_FADE_SHORT | Shadow | 62 | 37 | 37 | 0 | 37 | n/a | -$15.3 | -$15.3 | -$18.3 [-$37.7, $2.9] | 32.4% | -$565 | -$676 | -$7.4 | Unprofitable |
| FLOOR_S1_FADE_LONG_TRAIL | Shadow | 19 | 16 | 16 | 0 | 16 | n/a | -$35.4 | -$35.4 | -$38.4 [-$121.6, $10.9] | 37.5% | -$566 | -$614 | -$27.8 | Unprofitable |
| PW_POC_FADE_LONG | Backfill | 57 | 50 | 50 | 33 | 17 | $15.9 | -$64.9 | -$11.6 | -$14.6 [-$56.6, $25.5] | 64.0% | -$579 | -$729 | -$13.9 | Unprofitable |
| MONTHLY_VWAP_FADE_SHORT_OVERNIGHT | Shadow | 21 | 15 | 15 | 0 | 15 | n/a | -$38.8 | -$38.8 | -$41.8 [-$94.0, $26.5] | 20.0% | -$583 | -$628 | -$40.2 | Unprofitable |
| PW_LOW_FADE_LONG | Shadow | 37 | 29 | 29 | 0 | 29 | n/a | -$20.2 | -$20.2 | -$23.2 [-$67.9, $13.9] | 34.5% | -$586 | -$673 | -$14.9 | Unprofitable |
| ONL_FADE_SHORT | Backfill | 24 | 16 | 16 | 10 | 6 | -$22.6 | -$62.1 | -$37.4 | -$40.4 [-$117.5, $33.4] | 50.0% | -$598 | -$646 | -$17.5 | Unprofitable |
| PW_VAH_FADE_SHORT | Backfill | 58 | 52 | 52 | 30 | 22 | -$30.2 | $13.3 | -$11.8 | -$14.8 [-$46.1, $16.5] | 57.7% | -$614 | -$770 | $4.0 | Profitable |
| CAM_R1_FADE_SHORT | Backfill | 118 | 99 | 99 | 61 | 38 | -$10.9 | $1.1 | -$6.3 | -$9.3 [-$27.9, $7.8] | 59.6% | -$623 | -$920 | -$4.8 | Profitable |
| PD_OR_MID_FADE_LONG | Backfill | 97 | 78 | 78 | 49 | 29 | -$7.4 | -$9.3 | -$8.1 | -$11.1 [-$38.4, $15.5] | 60.3% | -$631 | -$865 | -$8.2 | Unprofitable |
| PD_CLOSE_FADE_SHORT | Backfill | 102 | 84 | 84 | 50 | 34 | -$5.9 | -$10.1 | -$7.6 | -$10.6 [-$41.4, $18.5] | 59.5% | -$640 | -$892 | $25.7 | Unprofitable |
| WS2_FADE_SHORT | Backfill | 14 | 12 | 12 | 9 | 3 | -$73.5 | $7.0 | -$53.4 | -$56.4 [-$116.8, $4.0] | 41.7% | -$641 | -$677 | -$53.4 | Insufficient_Sample (N < 5) |
| C_PAIRED_LONG | Live (ACTIVE) | 26 | 7 | 7 | 0 | 7 | n/a | -$91.8 | -$91.8 | -$94.8 [-$216.6, $61.7] | 28.6% | -$643 | -$664 | -$79.4 | Unprofitable |
| PD2_VAH_FADE_SHORT | Shadow | 17 | 8 | 8 | 0 | 8 | n/a | -$84.0 | -$84.0 | -$87.0 [-$148.3, -$21.0] | 37.5% | -$672 | -$696 | -$66.9 | Unprofitable |
| IB_LOW_FADE_SHORT | Shadow | 79 | 50 | 31 | 0 | 31 | n/a | -$21.8 | -$21.8 | -$24.8 [-$57.5, $6.4] | 35.5% | -$675 | -$768 | -$19.4 | Unprofitable |
| PW_POC_FADE_SHORT | Backfill | 34 | 26 | 26 | 13 | 13 | -$55.3 | $3.3 | -$26.0 | -$29.0 [-$85.2, $24.8] | 46.2% | -$677 | -$755 | $18.6 | Profitable |
| OPEN_TEST_DRIVE_LONG | Unknown-origin (pre-2026-07-09) | 113 | 85 | 85 | 48 | 37 | -$14.0 | -$0.6 | -$8.2 | -$11.2 [-$43.8, $20.8] | 48.2% | -$694 | -$949 | -$15.4 | Unprofitable |
| CAM_S4_FADE_LONG | Backfill | 119 | 92 | 92 | 58 | 34 | -$6.2 | -$10.0 | -$7.6 | -$10.6 [-$35.3, $15.2] | 65.2% | -$698 | -$974 | -$8.4 | Unprofitable |
| PW_VAH_FADE_LONG_OVERNIGHT | Shadow | 25 | 23 | 23 | 0 | 23 | n/a | -$31.2 | -$31.2 | -$34.2 [-$65.8, $14.0] | 21.7% | -$717 | -$786 | -$30.8 | Unprofitable |
| RTH_VWAP_FADE_LONG | Shadow | 158 | 60 | 57 | 0 | 57 | n/a | -$12.6 | -$12.6 | -$15.6 [-$27.1, -$4.6] | 29.8% | -$718 | -$889 | -$6.9 | Unprofitable |
| GLOBEX_VWAP_MAGNET_SHORT | Shadow | 103 | 98 | 71 | 0 | 71 | n/a | -$10.4 | -$10.4 | -$13.4 [-$32.0, -$5.0] | 47.9% | -$735 | -$948 | -$6.6 | Unprofitable |
| A_UP_STRONG | Live (ACTIVE) | 26 | 6 | 6 | 0 | 6 | n/a | -$127.2 | -$127.2 | -$130.2 [-$250.4, $16.8] | 16.7% | -$763 | -$781 | -$102.8 | Unprofitable |
| MPP_FADE_LONG | Backfill | 29 | 23 | 23 | 11 | 12 | -$23.8 | -$42.4 | -$33.5 | -$36.5 [-$82.3, $9.4] | 47.8% | -$770 | -$839 | -$22.7 | Unprofitable |
| CAM_S1_FADE_SHORT | Shadow | 47 | 27 | 26 | 0 | 26 | n/a | -$30.4 | -$30.4 | -$33.4 [-$55.8, -$6.9] | 26.9% | -$792 | -$870 | -$30.1 | Unprofitable |
| PD_IB_MID_FADE_LONG | Shadow | 72 | 52 | 38 | 0 | 38 | n/a | -$21.6 | -$21.6 | -$24.6 [-$45.8, -$7.8] | 31.6% | -$819 | -$933 | -$20.6 | Unprofitable |
| PD_POC_FADE_SHORT | Unknown-origin (pre-2026-07-09) | 50 | 41 | 41 | 21 | 20 | -$18.6 | -$22.1 | -$20.3 | -$23.3 [-$54.6, $9.5] | 48.8% | -$832 | -$955 | -$26.1 | Unprofitable |
| FAILED_AUCTION_LONG | Shadow | 204 | 204 | 116 | 0 | 116 | n/a | -$7.2 | -$7.2 | -$10.2 [-$24.4, $3.2] | 50.0% | -$838 | -$1186 | -$4.8 | Unprofitable |
| PD_IB_LOW_FADE_LONG | Backfill | 98 | 79 | 79 | 51 | 28 | -$7.8 | -$15.9 | -$10.7 | -$13.7 [-$36.9, $7.1] | 57.0% | -$846 | -$1083 | -$10.2 | Unprofitable |
| CAM_S1_FADE_LONG | Backfill | 139 | 113 | 113 | 77 | 36 | -$9.2 | -$4.3 | -$7.6 | -$10.6 [-$31.4, $11.1] | 61.1% | -$863 | -$1202 | -$6.9 | Unprofitable |
| RTH_VWAP_FADE_SHORT | Shadow | 137 | 57 | 48 | 0 | 48 | n/a | -$18.3 | -$18.3 | -$21.3 [-$42.1, -$1.3] | 35.4% | -$878 | -$1022 | -$11.2 | Unprofitable |
| RTH_FLUSH_LONG | Shadow | 21 | 19 | 19 | 0 | 19 | n/a | -$48.1 | -$48.1 | -$51.1 [-$148.2, $44.6] | 52.6% | -$914 | -$971 | -$53.6 | Unprofitable |
| CAM_R4_FADE_LONG | Backfill | 38 | 31 | 31 | 13 | 18 | -$64.8 | -$4.1 | -$29.6 | -$32.6 [-$73.5, $8.0] | 48.4% | -$916 | -$1009 | -$22.4 | Unprofitable |
| OPEN_DRIVE_LONG | Unknown-origin (pre-2026-07-09) | 59 | 51 | 51 | 26 | 25 | $2.6 | -$40.6 | -$18.6 | -$21.6 [-$60.7, $17.0] | 49.0% | -$949 | -$1102 | -$19.0 | Unprofitable |
| 3M_POC_FADE_SHORT_OVERNIGHT | Shadow | 29 | 24 | 24 | 0 | 24 | n/a | -$39.6 | -$39.6 | -$42.6 [-$94.0, -$15.6] | 20.8% | -$952 | -$1024 | -$40.9 | Unprofitable |
| PW_LOW_FADE_LONG | Backfill | 40 | 33 | 33 | 21 | 12 | -$75.2 | $48.5 | -$30.2 | -$33.2 [-$95.7, $33.4] | 54.5% | -$998 | -$1097 | -$17.8 | Profitable |
| PD_LOW_FADE_SHORT | Backfill | 34 | 25 | 25 | 14 | 11 | -$17.2 | -$75.4 | -$42.8 | -$45.8 [-$125.7, $25.9] | 52.0% | -$1070 | -$1145 | -$32.7 | Unprofitable |
| CAM_R4_FADE_SHORT | Backfill | 129 | 103 | 103 | 58 | 45 | $1.9 | -$26.5 | -$10.5 | -$13.5 [-$36.6, $8.5] | 61.2% | -$1083 | -$1392 | -$5.4 | Unprofitable |
| PM_VAH_FADE_LONG | Backfill | 26 | 19 | 19 | 11 | 8 | -$37.6 | -$85.0 | -$57.6 | -$60.6 [-$138.4, $23.0] | 47.4% | -$1094 | -$1151 | -$28.1 | Unprofitable |
| TRT_SHORT | Unknown-origin (pre-2026-07-09) | 45 | 34 | 34 | 23 | 11 | -$50.9 | $4.6 | -$33.0 | -$36.0 [-$81.7, $9.0] | 44.1% | -$1121 | -$1223 | -$33.0 | Profitable |
| OR5_HIGH_FADE_SHORT | Backfill | 301 | 243 | 243 | 151 | 92 | $0.2 | -$12.6 | -$4.7 | -$7.7 [-$22.9, $7.1] | 62.1% | -$1130 | -$1859 | -$3.5 | Unprofitable |
| VWAP_RECLAIM_SHORT | Shadow | 39 | 38 | 38 | 0 | 38 | n/a | -$30.8 | -$30.8 | -$33.8 [-$59.0, -$4.6] | 28.9% | -$1172 | -$1286 | -$36.3 | Unprofitable |
| C_STANDALONE_UP | Unknown-origin (pre-2026-07-09) | 198 | 149 | 149 | 89 | 60 | -$6.1 | -$11.3 | -$8.2 | -$11.2 [-$40.8, $15.0] | 55.0% | -$1219 | -$1666 | -$11.5 | Unprofitable |
| CAM_R1_FADE_LONG | Backfill | 119 | 94 | 94 | 67 | 27 | -$5.1 | -$33.6 | -$13.3 | -$16.3 [-$35.3, $4.1] | 57.4% | -$1247 | -$1529 | -$12.4 | Unprofitable |
| OPEN_TEST_DRIVE_SHORT | Gated candidate (never entered) | 4088 | 2932 | 229 | 0 | 229 | n/a | -$5.5 | -$5.5 | -$8.5 [-$22.1, -$1.1] | 43.2% | -$1253 | -$1940 | n/a | Unprofitable |
| FLOOR_S1_FADE_LONG | Backfill | 120 | 97 | 97 | 59 | 38 | -$17.3 | -$6.3 | -$13.0 | -$16.0 [-$39.0, $5.1] | 55.7% | -$1260 | -$1551 | -$12.6 | Unprofitable |
| BRACKET_BREAKOUT_SHORT | Shadow | 94 | 94 | 21 | 0 | 21 | n/a | -$60.2 | -$60.2 | -$63.2 [-$116.3, -$48.6] | 28.6% | -$1264 | -$1327 | -$57.0 | Unprofitable |
| WS2_FADE_LONG | Backfill | 16 | 13 | 13 | 9 | 4 | -$123.8 | -$38.1 | -$97.4 | -$100.4 [-$139.9, -$43.8] | 23.1% | -$1267 | -$1306 | -$86.4 | Insufficient_Sample (N < 5) |
| IB_MID_SCALP_FADE_SHORT | Backfill | 152 | 116 | 116 | 74 | 42 | -$9.1 | -$14.5 | -$11.1 | -$14.1 [-$28.9, $0.5] | 56.0% | -$1282 | -$1630 | -$9.6 | Unprofitable |
| ONH_FADE_LONG | Backfill | 26 | 21 | 21 | 16 | 5 | -$41.1 | -$128.3 | -$61.9 | -$64.9 [-$122.7, -$5.8] | 38.1% | -$1300 | -$1363 | -$55.4 | Unprofitable |
| OR5_LOW_FADE_LONG | Backfill | 305 | 250 | 250 | 159 | 91 | -$12.2 | $6.6 | -$5.4 | -$8.4 [-$21.1, $4.5] | 63.2% | -$1340 | -$2090 | -$5.1 | Profitable |
| CAM_R2_FADE_LONG | Backfill | 97 | 74 | 74 | 51 | 23 | -$25.3 | -$2.8 | -$18.3 | -$21.3 [-$45.2, $0.4] | 56.8% | -$1357 | -$1579 | -$17.8 | Unprofitable |
| PW_HIGH_FADE_SHORT | Backfill | 62 | 51 | 51 | 29 | 22 | -$35.8 | -$14.8 | -$26.8 | -$29.8 [-$61.2, $0.6] | 51.0% | -$1366 | -$1519 | -$28.2 | Unprofitable |
| PD_CLOSE_FADE_LONG | Backfill | 129 | 106 | 106 | 70 | 36 | -$28.6 | $12.7 | -$14.5 | -$17.5 [-$44.9, $10.3] | 61.3% | -$1542 | -$1860 | -$6.9 | Profitable |
| PY_VAH_FADE_LONG | Backfill | 8 | 6 | 6 | 2 | 4 | -$341.3 | -$250.3 | -$280.6 | -$283.6 [-$517.6, $11.3] | 16.7% | -$1684 | -$1702 | -$300.5 | Insufficient_Sample (N < 5) |
| IB_LOW_FADE_LONG | Backfill | 216 | 169 | 169 | 120 | 49 | -$13.3 | -$4.0 | -$10.6 | -$13.6 [-$26.8, $1.6] | 62.1% | -$1784 | -$2291 | -$10.3 | Unprofitable |
| PD_LOW_FADE_LONG | Backfill | 110 | 94 | 94 | 59 | 35 | -$16.3 | -$29.0 | -$21.0 | -$24.0 [-$66.6, $11.5] | 61.7% | -$1975 | -$2257 | -$10.7 | Unprofitable |
| FLOOR_S2_FADE_LONG | Backfill | 71 | 54 | 54 | 32 | 22 | -$50.8 | -$26.0 | -$40.7 | -$43.7 [-$94.2, $6.7] | 55.6% | -$2199 | -$2361 | -$38.2 | Unprofitable |
| GLOBEX_VWAP_MAGNET_SHORT | Backfill (timestamp-corrected +4/5h) | 1334 | 1334 | 1334 | 311 | 1023 | -$4.1 | -$1.0 | -$1.7 | -$4.7 [-$7.2, -$1.7] | 57.6% | -$2301 | -$6303 | $0.9 | Unprofitable |
| PD_HIGH_FADE_LONG | Backfill | 85 | 67 | 67 | 42 | 25 | -$39.9 | -$27.2 | -$35.2 | -$38.2 [-$70.7, -$8.2] | 53.7% | -$2355 | -$2556 | -$12.7 | Unprofitable |
| DAILY_OPEN_FADE_SHORT | Backfill | 169 | 137 | 137 | 81 | 56 | -$8.7 | -$33.5 | -$18.8 | -$21.8 [-$48.1, $4.9] | 56.9% | -$2578 | -$2989 | -$13.0 | Unprofitable |
| GLOBEX_VWAP_FADE_LONG | Shadow | 281 | 243 | 237 | 0 | 237 | n/a | -$11.4 | -$11.4 | -$14.4 [-$25.6, -$3.7] | 54.9% | -$2705 | -$3416 | -$10.0 | Unprofitable |
| WEEKLY_VWAP_FADE_LONG | Backfill | 156 | 127 | 127 | 85 | 42 | -$28.3 | -$11.8 | -$22.9 | -$25.9 [-$44.2, -$7.1] | 51.2% | -$2904 | -$3285 | -$20.5 | Unprofitable |
| ONL_FADE_LONG | Backfill | 211 | 168 | 168 | 101 | 67 | -$39.1 | $13.3 | -$18.2 | -$21.2 [-$43.4, $3.2] | 58.9% | -$3056 | -$3560 | -$7.9 | Profitable |
| VWAP_MAGNET_LONG | Backfill (timestamp-corrected +4/5h) | 1013 | 1013 | 1013 | 305 | 708 | -$4.3 | -$8.6 | -$7.3 | -$10.3 [-$15.1, -$3.9] | 53.4% | -$7370 | -$10409 | -$1.2 | Unprofitable |
| GLOBEX_VWAP_MAGNET_LONG | Backfill (timestamp-corrected +4/5h) | 2574 | 2574 | 2574 | 948 | 1626 | -$5.6 | -$5.1 | -$5.3 | -$8.3 [-$11.1, -$5.0] | 55.0% | -$13649 | -$21371 | -$1.6 | Unprofitable |
| OPENING_DRIVE_15MIN_LONG | Shadow | 3 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| STALL_DEFENDED_LEVEL_SHORT | Shadow | 2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_POC_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MR1_FADE_SHORT | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| OPENING_DRIVE_15MIN_SHORT | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MONTHLY_VWAP_FADE_SHORT | Live (ACTIVE) | 2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WS1_FADE_LONG | Live (ACTIVE) | 3 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WS2_FADE_SHORT | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MPP_FADE_SHORT | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_IB_LOW_FADE_LONG | Live (ACTIVE) | 3 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MS1_FADE_SHORT | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| CAM_R4_FADE_SHORT | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| 2D_POC_FADE_LONG | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_LOW_FADE_LONG | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_POC_FADE_LONG | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_LOW_FADE_LONG | Live (ACTIVE) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MPP_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 605 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| 10D_IB_MID_FADE_LONG | Gated candidate (never entered) | 19 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| 3M_VAL_FADE_LONG | Gated candidate (never entered) | 11 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WEEKLY_VWAP_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 2135 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| CAM_S4_FADE_LONG | Gated candidate (never entered) | 15 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| CAM_S2_SWEEP_REVERSAL_LONG_OVERNIGHT | Gated candidate (never entered) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_R1_FADE_LONG | Gated candidate (never entered) | 61 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MR1_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 763 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_VAH_SWEEP_REVERSAL_SHORT_OVERNIGHT | Gated candidate (never entered) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_VAL_SWEEP_REVERSAL_SHORT_OVERNIGHT | Gated candidate (never entered) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WPP_FADE_SHORT | Gated candidate (never entered) | 10 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_LOW_FADE_SHORT | Gated candidate (never entered) | 44 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_POC_SWEEP_REVERSAL_SHORT_OVERNIGHT | Gated candidate (never entered) | 2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_VAL_FADE_SHORT | Gated candidate (never entered) | 7 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_VAL_FADE_LONG | Gated candidate (never entered) | 4 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_VAL_FADE_LONG | Gated candidate (never entered) | 29 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_S1_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 542 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WS2_FADE_LONG | Gated candidate (never entered) | 4 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| STACK_VOL_BREAK_LIVE_SHORT | Gated candidate (never entered) | 2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WR1_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 1072 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| 10D_IB_MID_FADE_SHORT | Gated candidate (never entered) | 13 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| CAM_S2_FADE_SHORT | Gated candidate (never entered) | 43 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_IB_HIGH_FADE_SHORT | Gated candidate (never entered) | 103 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_HIGH_FADE_LONG_TRAIL | Gated candidate (never entered) | 55 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_HIGH_FADE_SHORT | Gated candidate (never entered) | 65 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MONTHLY_VWAP_FADE_SHORT | Gated candidate (never entered) | 52 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MS1_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 676 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MPP_FADE_LONG | Gated candidate (never entered) | 2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_R2_FADE_LONG | Gated candidate (never entered) | 5 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| BROKER | Gated candidate (never entered) | 15 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MPP_FADE_SHORT | Gated candidate (never entered) | 4 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_S1_FADE_SHORT | Gated candidate (never entered) | 43 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_R3_FADE_SHORT | Gated candidate (never entered) | 11 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_VAH_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 1691 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_POC_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 2332 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_VAH_FADE_LONG | Gated candidate (never entered) | 35 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MS1_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 676 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_VAL_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 359 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| 3M_VAL_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 298 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_S3_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 80 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_LOW_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 1157 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_VAL_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 2518 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| CAM_S1_FADE_SHORT | Gated candidate (never entered) | 46 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_POC_FADE_LONG | Gated candidate (never entered) | 3989 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WS1_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 267 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WPP_SWEEP_REVERSAL_SHORT_OVERNIGHT | Gated candidate (never entered) | 3 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MAJOR_PIVOT_DEFENDED_BREAK_LONG | Gated candidate (never entered) | 3 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_LOW_SWEEP_REVERSAL_LONG_OVERNIGHT | Gated candidate (never entered) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MONTHLY_VWAP_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 1698 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| IB_LOW_FADE_SHORT | Gated candidate (never entered) | 55 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_OR_MID_FADE_SHORT | Gated candidate (never entered) | 391 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WPP_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 1031 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD2_VAL_FADE_LONG | Gated candidate (never entered) | 65 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_S3_FADE_SHORT | Gated candidate (never entered) | 7 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WS1_FADE_SHORT | Gated candidate (never entered) | 3 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| CAM_S3_FADE_LONG | Gated candidate (never entered) | 97 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| CAM_S2_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 1024 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_HIGH_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 796 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_S3_FADE_LONG | Gated candidate (never entered) | 13 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_IB_LOW_FADE_LONG | Gated candidate (never entered) | 77 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_S1_FADE_LONG_TRAIL | Gated candidate (never entered) | 21 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| POC_ROTATION_JOIN_SHORT | Gated candidate (never entered) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| POC_ROTATION_JOIN_LONG | Gated candidate (never entered) | 6 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MONTHLY_OPEN_SWEEP_REVERSAL_SHORT_OVERNIGHT | Gated candidate (never entered) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WR2_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 57 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WS1_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 608 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| IB_HIGH_FADE_LONG | Gated candidate (never entered) | 39 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MONTHLY_VWAP_FADE_LONG | Gated candidate (never entered) | 83 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WEEKLY_OPEN_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 1959 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| DAILY_OPEN_FADE_LONG_TRAIL | Gated candidate (never entered) | 16 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_LOW_SWEEP_REVERSAL_SHORT_OVERNIGHT | Gated candidate (never entered) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_SESSION_MID_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 821 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| 10D_IB_MID_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 2704 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MONTHLY_OPEN_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 523 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| 5D_OR_MID_FADE_LONG | Gated candidate (never entered) | 9 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WS1_FADE_LONG | Gated candidate (never entered) | 2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MINOR_DEFENDED_LEVEL_LONG | Gated candidate (never entered) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| STACK_VOL_BREAK_LIVE_LONG | Gated candidate (never entered) | 4 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WEEKLY_VWAP_FADE_LONG | Gated candidate (never entered) | 43 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_HIGH_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 76 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| OR5_LOW_FADE_LONG_GAP_DOWN | Gated candidate (never entered) | 68 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_HIGH_FADE_SHORT | Gated candidate (never entered) | 62 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MR1_FADE_LONG | Gated candidate (never entered) | 37 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| ONL_FADE_SHORT | Gated candidate (never entered) | 48 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| OR15_LOW_FADE_SHORT | Gated candidate (never entered) | 67 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_R1_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 613 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| OR10_LOW_FADE_SHORT | Gated candidate (never entered) | 58 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WS2_FADE_SHORT | Gated candidate (never entered) | 15 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_R3_FADE_LONG | Gated candidate (never entered) | 3 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_HIGH_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 733 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_SESSION_MID_FADE_LONG | Gated candidate (never entered) | 100 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_HIGH_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 688 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_VAH_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 67 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| OR30_LOW_FADE_SHORT | Gated candidate (never entered) | 75 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_R2_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 323 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_HIGH_FADE_LONG | Gated candidate (never entered) | 38 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PM_VAH_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 246 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_IB_HIGH_FADE_LONG | Gated candidate (never entered) | 46 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_POC_FADE_LONG | Gated candidate (never entered) | 7 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MONTHLY_OPEN_FADE_LONG | Gated candidate (never entered) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| OR30_HIGH_FADE_LONG | Gated candidate (never entered) | 69 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| FLOOR_PIVOT_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 943 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_IB_MID_FADE_LONG | Gated candidate (never entered) | 138 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_POC_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 2892 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MAJOR_PIVOT_DEFENDED_BREAK_SHORT | Gated candidate (never entered) | 2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| DAILY_OPEN_FADE_SHORT | Gated candidate (never entered) | 20 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_CLOSE_FADE_LONG | Gated candidate (never entered) | 83 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| WEEKLY_OPEN_SWEEP_REVERSAL_LONG_OVERNIGHT | Gated candidate (never entered) | 2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PW_VAH_FADE_SHORT | Gated candidate (never entered) | 38 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MONTHLY_OPEN_FADE_LONG_OVERNIGHT | Gated candidate (never entered) | 1178 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| PD_POC_FADE_SHORT | Gated candidate (never entered) | 5197 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| MS1_FADE_SHORT | Gated candidate (never entered) | 1 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |
| 3M_POC_FADE_SHORT_OVERNIGHT | Gated candidate (never entered) | 4193 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No simulated trades |

### Table 2b -- Pooled by environment (all Mode 1 trades of the environment, every setup together; descriptive)

| Environment | Groups (simulated) | Mode 1 trades | Train N / mean @$1 | Hold-Out N / mean @$1 [95% CI] | Hold-Out mean @$4 | Win rate | Groups Profitable / Unprofitable / Insufficient (Hold-Out) |
|---|---|---|---|---|---|---|---|
| Backfill | 129 | 7466 | 4640 / -$2.8 | 2826 / $0.8 [-$8.3, $9.5] | -$2.2 | 62.4% | 58 / 54 / 17 |
| Unknown-origin (pre-2026-07-09) | 70 | 1172 | 645 / $4.9 | 527 / -$4.3 [-$22.3, $15.6] | -$7.3 | 49.4% | 6 / 11 / 53 |
| Shadow | 247 | 5756 | 0 / n/a | 5756 / -$2.5 [-$4.9, -$0.1] | -$5.5 | 45.1% | 87 / 114 / 46 |
| Gated candidate (never entered) | 115 | 1108 | 0 / n/a | 1108 / -$3.2 [-$8.7, $1.7] | -$6.2 | 45.3% | 14 / 17 / 84 |
| Live (ACTIVE) | 162 | 1163 | 0 / n/a | 1163 / -$3.2 [-$7.5, $2.1] | -$6.2 | 45.8% | 31 / 37 / 94 |
| Backfill (timestamp-corrected +4/5h) | 9 | 5673 | 1862 / -$4.5 | 3811 / -$4.1 [-$7.4, -$1.0] | -$7.1 | 56.2% | 1 / 5 / 3 |

### Table 3 -- Surviving positive setups: Train mean @$1 > 0 AND (Hold-Out mean @$1 > 0 OR Hold-Out N < 5). 37 of 732 simulated groups. Parameter profile = median stop width, median target width (points from the stored entry), session mix of entries (R = RTH, P = post-close, G = Globex, % of trades), setup category (most common stored bet_class).

| Setup ID | Environment | Mode 1 N (Train / HO) | Train mean @$1 | Hold-Out mean @$1 | Mean @$4 (Train / HO) | Fee-robust (positive @$4 in both) | Stop width | Target width | Session mix | Category | Hold-Out evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ONH_FADE_SHORT | Backfill | 186 (121 / 65) | $22.4 | $5.4 | $19.4 / $2.4 | yes | 94.0 | 57.8 | R100/P0/G0 | VALUE_FADE | HO N=65 (>=20) |
| DAILY_OPEN_FADE_LONG | Backfill | 147 (93 / 54) | $16.6 | $24.8 | $13.6 / $21.8 | yes | 112.0 | 64.5 | R100/P0/G0 | VALUE_FADE | HO N=54 (>=20) |
| FLOOR_S3_FADE_LONG | Backfill | 37 (18 / 19) | $81.4 | $48.2 | $78.4 / $45.2 | yes | 110.5 | 76.4 | R100/P0/G0 | VALUE_FADE | HO N=19 (5-19) |
| WEEKLY_OPEN_FADE_SHORT | Backfill | 60 (35 / 25) | $12.7 | $56.2 | $9.7 / $53.2 | yes | 100.2 | 60.1 | R100/P0/G0 | VALUE_FADE | HO N=25 (>=20) |
| MONTHLY_OPEN_FADE_LONG | Backfill | 39 (23 / 16) | $61.5 | $20.5 | $58.5 / $17.5 | yes | 92.6 | 68.4 | R100/P0/G0 | VALUE_FADE | HO N=16 (5-19) |
| PY_VAH_FADE_SHORT | Backfill | 9 (1 / 8) | $493.0 | $146.6 | $490.0 / $143.6 | yes | 300.0 | 300.0 | R100/P0/G0 | VALUE_FADE | HO N=8 (5-19) |
| CAM_R2_FADE_SHORT | Backfill | 117 (71 / 46) | $11.1 | $18.0 | $8.1 / $15.0 | yes | 69.5 | 37.5 | R100/P0/G0 | VALUE_FADE | HO N=46 (>=20) |
| PM_HIGH_FADE_LONG | Backfill | 24 (17 / 7) | $73.3 | $47.5 | $70.3 / $44.5 | yes | 72.6 | 63.0 | R100/P0/G0 | VALUE_FADE | HO N=7 (5-19) |
| CAM_S2_FADE_LONG | Backfill | 125 (86 / 39) | $12.7 | $7.0 | $9.7 / $4.0 | yes | 71.5 | 41.8 | R100/P0/G0 | VALUE_FADE | HO N=39 (>=20) |
| PD_SESSION_MID_FADE_SHORT | Backfill | 71 (43 / 28) | $28.2 | $2.6 | $25.2 / -$0.4 | no | 82.3 | 48.5 | R100/P0/G0 | VALUE_FADE | HO N=28 (>=20) |
| MONTHLY_VWAP_FADE_LONG | Backfill | 81 (54 / 27) | $20.0 | $5.2 | $17.0 / $2.2 | yes | 300.0 | 300.0 | R100/P0/G0 | VALUE_FADE | HO N=27 (>=20) |
| PW_VAL_FADE_LONG | Backfill | 39 (24 / 15) | $34.9 | $12.3 | $31.9 / $9.3 | yes | 108.0 | 69.3 | R100/P0/G0 | VALUE_FADE | HO N=15 (5-19) |
| PD_IB_MID_FADE_SHORT | Backfill | 72 (47 / 25) | $12.2 | $17.0 | $9.2 / $14.0 | yes | 56.3 | 29.0 | R100/P0/G0 | VALUE_FADE | HO N=25 (>=20) |
| PM_VAL_FADE_SHORT | Backfill | 20 (8 / 12) | $26.0 | $64.5 | $23.0 / $61.5 | yes | 109.3 | 68.8 | R100/P0/G0 | VALUE_FADE | HO N=12 (5-19) |
| TRT_LONG | Unknown-origin (pre-2026-07-09) | 33 (17 / 16) | $16.6 | $43.6 | $13.6 / $40.6 | yes | 113.0 | 85.0 | R100/P0/G0 | VALUE_FADE | HO N=16 (5-19) |
| PD_HIGH_FADE_SHORT | Backfill | 93 (48 / 45) | $13.8 | $6.3 | $10.8 / $3.3 | yes | 100.1 | 44.9 | R100/P0/G0 | VALUE_FADE | HO N=45 (>=20) |
| PW_HIGH_FADE_LONG | Backfill | 31 (26 / 5) | $18.2 | $87.0 | $15.2 / $84.0 | yes | 73.8 | 44.0 | R100/P0/G0 | VALUE_FADE | HO N=5 (5-19) |
| 10D_IB_MID_FADE_SHORT | Backfill | 34 (13 / 21) | $3.1 | $34.5 | $0.1 / $31.5 | yes | 142.3 | 67.8 | R100/P0/G0 | VALUE_FADE | HO N=21 (>=20) |
| MPP_FADE_SHORT | Backfill | 23 (13 / 10) | $35.9 | $29.3 | $32.9 / $26.3 | yes | 74.3 | 41.0 | R100/P0/G0 | VALUE_FADE | HO N=10 (5-19) |
| BRACKET_BREAKOUT_SHORT | Unknown-origin (pre-2026-07-09) | 10 (10 / 0) | $73.2 | n/a | $70.2 / n/a | yes | 20.0 | 288.0 | R100/P0/G0 | CONTINUATION_LEGACY | Insufficient_Sample (HO N=0) |
| PM_LOW_FADE_SHORT | Backfill | 12 (5 / 7) | $138.6 | $4.8 | $135.6 / $1.8 | yes | 128.8 | 82.3 | R100/P0/G0 | VALUE_FADE | HO N=7 (5-19) |
| PM_HIGH_FADE_SHORT | Backfill | 24 (10 / 14) | $33.9 | $17.6 | $30.9 / $14.6 | yes | 72.6 | 63.0 | R100/P0/G0 | VALUE_FADE | HO N=14 (5-19) |
| FLOOR_S1_FADE_SHORT | Backfill | 22 (11 / 11) | $44.5 | $1.1 | $41.5 / -$1.9 | no | 75.0 | 44.5 | R100/P0/G0 | VALUE_FADE | HO N=11 (5-19) |
| FLOOR_S3_FADE_SHORT | Backfill | 5 (2 / 3) | $7.3 | $151.8 | $4.3 / $148.8 | yes | 110.5 | 76.4 | R100/P0/G0 | VALUE_FADE | Insufficient_Sample (HO N=3) |
| WPP_FADE_LONG | Backfill | 50 (28 / 22) | $9.6 | $7.7 | $6.6 / $4.7 | yes | 78.6 | 33.3 | R100/P0/G0 | VALUE_FADE | HO N=22 (>=20) |
| FLOOR_R3_FADE_SHORT | Backfill | 27 (19 / 8) | $6.0 | $37.8 | $3.0 / $34.8 | yes | 55.6 | 45.3 | R100/P0/G0 | VALUE_FADE | HO N=8 (5-19) |
| CAM_S3_FADE_LONG | Backfill | 121 (84 / 37) | $2.0 | $5.6 | -$1.0 / $2.6 | no | 92.4 | 40.3 | R100/P0/G0 | VALUE_FADE | HO N=37 (>=20) |
| CAM_S4_FADE_SHORT | Backfill | 26 (10 / 16) | $29.1 | $0.3 | $26.1 / -$2.7 | no | 87.3 | 40.6 | R100/P0/G0 | VALUE_FADE | HO N=16 (5-19) |
| GLOBEX_VWAP_FADE_SHORT | Backfill | 5 (4 / 1) | $40.6 | $79.0 | $37.6 / $76.0 | yes | 90.0 | 40.0 | R100/P0/G0 | GLOBEX_LEVEL | Insufficient_Sample (HO N=1) |
| IB_HIGH_FADE_LONG | Backfill | 4 (1 / 3) | $59.8 | $59.8 | $56.8 / $56.8 | yes | 52.4 | 30.4 | R100/P0/G0 | VALUE_FADE | Insufficient_Sample (HO N=3) |
| PD_OR_MID_FADE_SHORT | Backfill | 71 (48 / 23) | $0.7 | $7.8 | -$2.3 / $4.8 | no | 77.9 | 45.0 | R100/P0/G0 | VALUE_FADE | HO N=23 (>=20) |
| GLOBEX_VWAP_MAGNET_LONG | Backfill | 13 (3 / 10) | $18.3 | $9.0 | $15.3 / $6.0 | yes | 30.0 | 20.0 | R62/P0/G38 | GLOBEX_LEVEL | HO N=10 (5-19) |
| GLOBEX_VWAP_FADE_LONG | Backfill | 5 (3 / 2) | $79.0 | -$51.0 | $76.0 / -$54.0 | yes | 90.0 | 40.0 | R100/P0/G0 | GLOBEX_LEVEL | Insufficient_Sample (HO N=2) |
| CAM_S3_FADE_SHORT | Backfill | 31 (14 / 17) | $5.5 | $1.4 | $2.5 / -$1.6 | no | 92.4 | 40.3 | R100/P0/G0 | VALUE_FADE | HO N=17 (5-19) |
| MR2_FADE_LONG | Backfill | 2 (2 / 0) | $33.0 | n/a | $30.0 / n/a | yes | 63.5 | 17.0 | R100/P0/G0 | VALUE_FADE | Insufficient_Sample (HO N=0) |
| TRT_MAH_LONG | Unknown-origin (pre-2026-07-09) | 2 (2 / 0) | $12.0 | n/a | $9.0 / n/a | yes | 55.0 | 14.0 | R100/P0/G0 | VALUE_FADE | Insufficient_Sample (HO N=0) |
| MR2_FADE_SHORT | Backfill | 3 (1 / 2) | $33.0 | -$47.5 | $30.0 / -$50.5 | yes | 63.5 | 17.0 | R100/P0/G0 | VALUE_FADE | Insufficient_Sample (HO N=2) |
  Backfill: 34 survivors of 129 simulated groups; with Hold-Out N>=5: 28; with Train N>=20 and Hold-Out N>=20: 12
  Unknown-origin (pre-2026-07-09): 3 survivors of 70 simulated groups; with Hold-Out N>=5: 1; with Train N>=20 and Hold-Out N>=20: 0
  Shadow: 0 survivors of 247 simulated groups; with Hold-Out N>=5: 0; with Train N>=20 and Hold-Out N>=20: 0
  Gated candidate (never entered): 0 survivors of 115 simulated groups; with Hold-Out N>=5: 0; with Train N>=20 and Hold-Out N>=20: 0
  Live (ACTIVE): 0 survivors of 162 simulated groups; with Hold-Out N>=5: 0; with Train N>=20 and Hold-Out N>=20: 0
  Backfill (timestamp-corrected +4/5h): 0 survivors of 9 simulated groups; with Hold-Out N>=5: 0; with Train N>=20 and Hold-Out N>=20: 0

### Table 3c -- Hold-Out-only positives: groups with NO Train trades (all of Live, Shadow and Gated data begins after the 2026-01-02 cut, so a Train period does not exist for them), Hold-Out N >= 5 and Hold-Out mean @$1 > 0. 135 of 304 such groups. This is a single-period result, not a Train/Hold-Out confirmation.

| Setup ID | Environment | Hold-Out N | Mean @$1 | Mean @$4 [95% CI] | Win rate | Stop width | Target width | Session mix | Category |
|---|---|---|---|---|---|---|---|---|---|
| C_PAIRED_SHORT | Unknown-origin (pre-2026-07-09) | 6 | $135.2 | $132.2 [$45.8, $227.1] | 83.3% | 83.0 | 154.0 | R100/P0/G0 | CONTINUATION_LEGACY |
| OPEN_DRIVE_LONG | Shadow | 8 | $122.5 | $119.5 [$73.6, $193.7] | 100.0% | 135.0 | 38.0 | R100/P0/G0 | CONTINUATION_LEGACY |
| GLOBEX_FLUSH_REVERSAL_SHORT | Shadow | 5 | $105.1 | $102.1 [-$152.7, $344.7] | 60.0% | 131.5 | 108.3 | R0/P0/G100 | VALUE_FADE |
| GLOBEX_FLUSH_SHORT | Shadow | 8 | $90.5 | $87.5 [-$91.5, $299.5] | 50.0% | 106.3 | 188.9 | R0/P0/G100 | CONTINUATION_LEGACY |
| RTH_VWAP_FADE_SHORT | Live (ACTIVE) | 7 | $73.6 | $70.6 [$7.0, $96.0] | 85.7% | 39.0 | 50.0 | R100/P0/G0 | VALUE_FADE |
| FLOOR_PIVOT_FADE_SHORT_OVERNIGHT | Shadow | 10 | $61.0 | $58.0 [$56.0, $76.5] | 60.0% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| FLOOR_S3_FADE_SHORT | Shadow | 8 | $54.0 | $51.0 [-$4.4, $81.6] | 75.0% | 92.0 | 43.0 | R100/P0/G0 | VALUE_FADE |
| CAM_S1_FADE_LONG | Live (ACTIVE) | 5 | $53.0 | $50.0 [$32.7, $76.0] | 80.0% | 25.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| FAILED_SWEEP_REVERSAL_LONG | Gated candidate (never entered) | 15 | $52.7 | $49.7 [-$28.8, $147.9] | 53.3% | 67.8 | 250.3 | R47/P53/G0 | FAILED_SWEEP_REVERSAL |
| FAILED_SWEEP_REVERSAL_SHORT | Gated candidate (never entered) | 15 | $51.9 | $48.9 [-$24.3, $152.4] | 46.7% | 68.3 | 249.8 | R47/P53/G0 | FAILED_SWEEP_REVERSAL |
| RTH_FLUSH_SHORT | Shadow | 9 | $51.5 | $48.5 [-$61.0, $151.2] | 66.7% | 232.3 | 78.8 | R100/P0/G0 | CONTINUATION_LEGACY |
| PW_POC_FADE_SHORT_OVERNIGHT | Shadow | 17 | $46.9 | $43.9 [-$26.5, $114.8] | 52.9% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| CAM_S2_FADE_LONG_OVERNIGHT | Shadow | 10 | $44.0 | $41.0 [-$94.0, $155.2] | 50.0% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| PD_SESSION_MID_FADE_SHORT_OVERNIGHT | Live (ACTIVE) | 6 | $44.0 | $41.0 [$14.0, $176.0] | 50.0% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| MS1_FADE_LONG_OVERNIGHT | Shadow | 6 | $44.0 | $41.0 [$14.0, $176.0] | 50.0% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| MONTHLY_OPEN_FADE_SHORT | Shadow | 6 | $37.8 | $34.8 [$1.0, $51.8] | 66.7% | 37.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| 2D_POC_FADE_SHORT | Shadow | 6 | $35.7 | $32.7 [-$35.4, $76.0] | 83.3% | 90.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| DAILY_OPEN_FADE_SHORT | Shadow | 7 | $33.0 | $30.0 [-$68.0, $70.0] | 71.4% | 37.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| VALUE_AREA_RESPONSIVE_SHORT | Live (ACTIVE) | 6 | $32.3 | $29.3 [$8.0, $72.0] | 66.7% | 31.0 | 43.0 | R100/P0/G0 | VALUE_FADE |
| FLOOR_R1_FADE_SHORT_OVERNIGHT | Shadow | 8 | $30.6 | $27.6 [-$2.8, $41.0] | 50.0% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| VALUE_AREA_RESPONSIVE_SHORT | Shadow | 17 | $30.0 | $27.0 [-$9.4, $56.3] | 64.7% | 37.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| PW_VAL_FADE_LONG_OVERNIGHT | Live (ACTIVE) | 5 | $29.8 | $26.8 [-$72.7, $176.0] | 40.0% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| POC_ROTATION_JOIN_SHORT | Live (ACTIVE) | 10 | $28.9 | $25.9 [-$79.1, $150.3] | 40.0% | 100.0 | 1000.0 | R20/P0/G80 | CONTINUATION_LEGACY |
| IB_HIGH_FADE_SHORT | Live (ACTIVE) | 25 | $28.4 | $25.4 [-$0.9, $51.1] | 68.0% | 29.0 | 50.0 | R100/P0/G0 | VALUE_FADE |
| WR1_FADE_LONG | Shadow | 8 | $28.3 | $25.3 [$4.3, $58.4] | 62.5% | 35.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| PW_VAH_FADE_SHORT | Shadow | 9 | $27.7 | $24.7 [-$38.0, $72.8] | 66.7% | 37.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| PW_HIGH_FADE_LONG_TRAIL | Shadow | 6 | $27.0 | $24.0 [-$68.0, $70.0] | 66.7% | 32.0 | 37.0 | R100/P0/G0 | VALUE_FADE |
| OR30_LOW_FADE_SHORT | Live (ACTIVE) | 5 | $26.2 | $23.2 [-$62.0, $84.0] | 60.0% | 35.0 | 44.0 | R100/P0/G0 | VALUE_FADE |
| OR5_HIGH_FADE_SHORT | Live (ACTIVE) | 22 | $25.3 | $22.3 [-$17.1, $59.7] | 50.0% | 35.0 | 70.0 | R100/P0/G0 | VALUE_FADE |
| OR10_HIGH_FADE_LONG | Live (ACTIVE) | 12 | $24.8 | $21.8 [-$23.8, $62.5] | 50.0% | 12.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| GLOBEX_VWAP_MAGNET_SHORT | Backfill | 7 | $24.7 | $21.7 [-$1.5, $36.0] | 85.7% | 30.0 | 20.0 | R57/P14/G29 | GLOBEX_LEVEL |
| OR5_HIGH_FADE_LONG | Live (ACTIVE) | 8 | $24.5 | $21.5 [-$29.5, $72.5] | 62.5% | 26.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| PW_VAL_FADE_SHORT | Shadow | 30 | $24.0 | $21.0 [-$7.5, $46.0] | 63.3% | 36.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| A_UP_STRONG | Shadow | 25 | $22.6 | $19.6 [-$30.5, $141.2] | 36.0% | 25.0 | 185.0 | R100/P0/G0 | CONTINUATION_LEGACY |
| OR30_LOW_FADE_LONG | Shadow | 31 | $21.4 | $18.4 [-$0.1, $39.6] | 61.3% | 37.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| ONL_FADE_LONG | Shadow | 38 | $21.2 | $18.2 [-$6.1, $37.0] | 55.3% | 14.0 | 40.0 | R97/P3/G0 | VALUE_FADE |
| PW_VAL_FADE_SHORT | Live (ACTIVE) | 5 | $20.6 | $17.6 [-$56.0, $76.0] | 60.0% | 40.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| C_STANDALONE_UP | Gated candidate (never entered) | 5 | $20.1 | $17.1 [-$136.0, $153.0] | 60.0% | 79.0 | 97.0 | R100/P0/G0 | CONTINUATION_LEGACY |
| PM_POC_FADE_SHORT | Shadow | 5 | $19.1 | $16.1 [-$118.5, $78.0] | 80.0% | 92.0 | 41.0 | R100/P0/G0 | VALUE_FADE |
| WS1_FADE_SHORT_OVERNIGHT | Shadow | 8 | $19.0 | $16.0 [-$26.5, $64.3] | 50.0% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| PD2_VAL_FADE_SHORT | Shadow | 10 | $17.5 | $14.5 [-$93.5, $70.9] | 80.0% | 90.0 | 42.0 | R80/P20/G0 | VALUE_FADE |
| WS1_FADE_LONG_OVERNIGHT | Shadow | 5 | $17.0 | $14.0 [-$94.0, $176.0] | 40.0% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| PD_SESSION_MID_FADE_SHORT_OVERNIGHT | Shadow | 5 | $17.0 | $14.0 [-$94.0, $41.0] | 40.0% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| FLOOR_S2_FADE_SHORT | Shadow | 19 | $16.5 | $13.5 [-$20.5, $43.1] | 63.2% | 29.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| A_DOWN_WEAK | Shadow | 17 | $16.2 | $13.2 [-$26.1, $57.5] | 64.7% | 134.0 | 35.0 | R100/P0/G0 | CONTINUATION_LEGACY |
| FLOOR_R3_FADE_SHORT | Shadow | 13 | $15.8 | $12.8 [-$30.3, $34.1] | 53.8% | 37.0 | 41.0 | R100/P0/G0 | VALUE_FADE |
| PD_LOW_FADE_SHORT | Shadow | 23 | $15.5 | $12.5 [-$14.7, $42.0] | 52.2% | 37.0 | 43.0 | R100/P0/G0 | VALUE_FADE |
| 5D_OR_MID_FADE_SHORT | Shadow | 27 | $15.1 | $12.1 [-$16.1, $40.8] | 51.9% | 37.0 | 40.0 | R96/P4/G0 | VALUE_FADE |
| GLOBEX_VWAP_FADE_SHORT | Gated candidate (never entered) | 15 | $15.0 | $12.0 [-$2.6, $28.6] | 53.3% | 23.0 | 40.0 | R80/P20/G0 | GLOBEX_LEVEL |
| OR30_MID_FADE_LONG | Shadow | 22 | $14.7 | $11.7 [-$25.1, $44.1] | 54.5% | 36.0 | 44.0 | R100/P0/G0 | VALUE_FADE |
| FLOOR_R3_FADE_LONG | Shadow | 7 | $14.1 | $11.1 [-$30.0, $78.0] | 71.4% | 76.0 | 41.0 | R100/P0/G0 | VALUE_FADE |
| CAM_S1_FADE_LONG | Shadow | 35 | $13.8 | $10.8 [-$17.0, $35.6] | 62.9% | 37.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| 5D_OR_MID_FADE_LONG | Live (ACTIVE) | 6 | $13.7 | $10.7 [-$55.7, $68.3] | 66.7% | 37.0 | 35.0 | R100/P0/G0 | VALUE_FADE |
| ONL_FADE_SHORT | Shadow | 29 | $13.6 | $10.6 [-$26.7, $38.5] | 51.7% | 37.0 | 38.0 | R97/P3/G0 | VALUE_FADE |
| IB_HIGH_FADE_SHORT | Shadow | 93 | $13.2 | $10.2 [-$6.3, $26.8] | 49.5% | 29.0 | 50.0 | R94/P6/G0 | VALUE_FADE |
| IB_LOW_FADE_LONG | Shadow | 55 | $13.0 | $10.0 [-$11.6, $32.4] | 52.7% | 32.0 | 50.0 | R95/P5/G0 | VALUE_FADE |
| FLOOR_R1_FADE_LONG | Live (ACTIVE) | 11 | $12.6 | $9.6 [-$36.2, $43.1] | 63.6% | 41.0 | 35.0 | R100/P0/G0 | VALUE_FADE |
| GLOBEX_VWAP_FADE_LONG | Gated candidate (never entered) | 20 | $12.3 | $9.3 [-$22.5, $26.0] | 70.0% | 49.0 | 30.0 | R90/P10/G0 | GLOBEX_LEVEL |
| PD_POC_FADE_SHORT_TRAIL | Shadow | 20 | $12.1 | $9.1 [-$24.5, $33.8] | 70.0% | 47.0 | 30.0 | R100/P0/G0 | VALUE_FADE |
| STOP_SWEEP_SHORT | Shadow | 54 | $12.1 | $9.1 [-$9.2, $25.5] | 68.5% | 44.0 | 30.0 | R93/P7/G0 | VALUE_FADE |
| GLOBEX_VWAP_FADE_SHORT | Live (ACTIVE) | 33 | $12.0 | $9.0 [-$14.9, $35.4] | 51.5% | 37.0 | 46.0 | R52/P0/G48 | GLOBEX_LEVEL |
| PD_CLOSE_FADE_LONG | Shadow | 40 | $11.9 | $8.9 [-$4.0, $26.9] | 52.5% | 26.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| OR15_HIGH_FADE_LONG | Live (ACTIVE) | 8 | $11.8 | $8.8 [-$34.0, $63.7] | 37.5% | 15.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| FLOOR_PIVOT_FADE_SHORT | Live (ACTIVE) | 5 | $11.4 | $8.4 [-$38.0, $102.0] | 40.0% | 20.0 | 35.0 | R100/P0/G0 | VALUE_FADE |
| WEEKLY_OPEN_FADE_SHORT | Shadow | 46 | $11.4 | $8.4 [-$11.3, $30.5] | 58.7% | 37.0 | 38.0 | R89/P11/G0 | VALUE_FADE |
| PD_IB_MID_FADE_SHORT | Shadow | 43 | $10.5 | $7.5 [-$15.8, $28.4] | 48.8% | 37.0 | 41.0 | R93/P7/G0 | VALUE_FADE |
| OR15_MID_FADE_SHORT | Shadow | 20 | $10.4 | $7.4 [-$22.4, $37.0] | 45.0% | 35.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| OR5_MID_FADE_LONG | Shadow | 50 | $10.3 | $7.3 [-$10.7, $25.7] | 48.0% | 23.0 | 50.0 | R98/P2/G0 | VALUE_FADE |
| A_UP_STRONG | Gated candidate (never entered) | 9 | $10.1 | $7.1 [-$36.3, $55.5] | 44.4% | 139.0 | 199.0 | R0/P100/G0 | CONTINUATION_LEGACY |
| C_PAIRED_LONG | Gated candidate (never entered) | 9 | $10.1 | $7.1 [-$33.1, $55.6] | 44.4% | 139.0 | 234.0 | R0/P100/G0 | CONTINUATION_LEGACY |
| WPP_FADE_LONG | Shadow | 30 | $9.9 | $6.9 [-$23.4, $34.9] | 56.7% | 37.0 | 37.0 | R97/P3/G0 | VALUE_FADE |
| FLOOR_R2_FADE_SHORT | Shadow | 37 | $9.8 | $6.8 [-$11.4, $24.1] | 54.1% | 32.0 | 37.0 | R100/P0/G0 | VALUE_FADE |
| IB_BULLISH | Live (ACTIVE) | 42 | $9.3 | $6.3 [-$25.7, $59.8] | 59.5% | 79.0 | 35.0 | R86/P14/G0 | CONTINUATION_LEGACY |
| VWAP_MAGNET_LONG | Gated candidate (never entered) | 22 | $9.2 | $6.2 [-$15.1, $22.2] | 59.1% | 29.0 | 25.0 | R77/P23/G0 | VALUE_FADE |
| IB_BULLISH | Gated candidate (never entered) | 11 | $9.2 | $6.2 [$6.2, $6.2] | 63.6% | 50.0 | 35.0 | R82/P18/G0 | CONTINUATION_LEGACY |
| PD_VAL_FADE_LONG | Shadow | 70 | $9.1 | $6.1 [-$11.4, $23.2] | 54.3% | 38.0 | 44.0 | R47/P3/G50 | GLOBEX_LEVEL |
| OR5_LOW_FADE_LONG | Live (ACTIVE) | 6 | $9.1 | $6.1 [-$36.0, $47.5] | 50.0% | 16.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| PD_IB_MID_FADE_SHORT | Live (ACTIVE) | 5 | $8.8 | $5.8 [-$54.0, $20.8] | 60.0% | 37.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| 3M_POC_FADE_SHORT | Shadow | 33 | $8.7 | $5.7 [-$17.0, $34.5] | 60.6% | 37.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| CAM_R4_FADE_SHORT | Shadow | 26 | $8.7 | $5.7 [-$26.2, $37.2] | 50.0% | 36.0 | 43.0 | R96/P4/G0 | VALUE_FADE |
| STACK_VOL_BREAK_LIVE_LONG | Shadow | 27 | $8.7 | $5.7 [-$31.1, $48.8] | 48.1% | 57.0 | 70.0 | R100/P0/G0 | CONTINUATION_LEGACY |
| PD_POC_FADE_LONG | Shadow | 47 | $8.4 | $5.4 [-$14.6, $23.0] | 46.8% | 24.0 | 40.0 | R2/P0/G98 | GLOBEX_LEVEL |
| PW_VAH_FADE_LONG | Shadow | 12 | $8.3 | $5.3 [-$23.3, $44.7] | 50.0% | 37.0 | 38.0 | R83/P17/G0 | VALUE_FADE |
| POC_ROTATION_JOIN_LONG | Shadow | 80 | $8.2 | $5.2 [-$15.5, $23.7] | 38.8% | 20.0 | 1000.0 | R31/P0/G69 | CONTINUATION_LEGACY |
| POC_ROTATION_JOIN_SHORT | Shadow | 78 | $8.2 | $5.2 [-$11.3, $24.8] | 38.5% | 20.0 | 1000.0 | R31/P1/G68 | CONTINUATION_LEGACY |
| WEEKLY_VWAP_FADE_SHORT_OVERNIGHT | Shadow | 16 | $8.0 | $5.0 [-$56.7, $80.1] | 43.8% | 45.0 | 90.0 | R0/P0/G100 | GLOBEX_LEVEL |
| WS1_FADE_LONG | Shadow | 13 | $7.9 | $4.9 [-$16.3, $29.7] | 53.8% | 37.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| OR5_MID_FADE_SHORT | Gated candidate (never entered) | 5 | $7.9 | $4.9 [-$29.4, $51.3] | 60.0% | 22.0 | 40.0 | R40/P60/G0 | VALUE_FADE |
| CAM_S2_FADE_LONG_TRAIL | Shadow | 36 | $6.9 | $3.9 [-$27.0, $36.5] | 55.6% | 32.0 | 37.0 | R97/P3/G0 | VALUE_FADE |
| 10D_IB_MID_FADE_LONG | Shadow | 14 | $6.7 | $3.7 [-$32.3, $38.1] | 50.0% | 32.0 | 37.0 | R93/P7/G0 | VALUE_FADE |
| FAILED_AUCTION_LONG | Live (ACTIVE) | 19 | $6.4 | $3.4 [-$7.9, $20.9] | 68.4% | 33.0 | 20.0 | R100/P0/G0 | VALUE_FADE |
| OR5_MID_FADE_SHORT | Live (ACTIVE) | 9 | $6.3 | $3.3 [-$21.3, $29.5] | 44.4% | 22.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| PD_CLOSE_FADE_SHORT | Shadow | 47 | $6.1 | $3.1 [-$15.1, $27.8] | 44.7% | 25.0 | 40.0 | R96/P4/G0 | VALUE_FADE |
| PM_VAL_FADE_SHORT | Shadow | 6 | $5.8 | $2.8 [-$70.3, $76.0] | 50.0% | 37.0 | 38.0 | R83/P17/G0 | VALUE_FADE |
| PD_HIGH_FADE_SHORT | Shadow | 15 | $5.8 | $2.8 [-$30.8, $45.0] | 46.7% | 37.0 | 41.0 | R100/P0/G0 | VALUE_FADE |
| OR10_MID_FADE_SHORT | Live (ACTIVE) | 5 | $5.8 | $2.8 [-$54.4, $60.0] | 40.0% | 36.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| IB_MID_SCALP_FADE_SHORT | Live (ACTIVE) | 18 | $5.5 | $2.5 [-$20.6, $24.4] | 33.3% | 12.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| OR30_LOW_FADE_SHORT | Shadow | 9 | $5.2 | $2.2 [-$73.1, $60.8] | 55.6% | 36.0 | 42.0 | R100/P0/G0 | VALUE_FADE |
| GLOBEX_VWAP_FADE_LONG | Live (ACTIVE) | 11 | $5.1 | $2.1 [-$71.1, $67.6] | 63.6% | 81.0 | 40.0 | R0/P0/G100 | GLOBEX_LEVEL |
| PD_IB_HIGH_FADE_SHORT | Shadow | 30 | $5.1 | $2.1 [-$17.9, $27.1] | 56.7% | 37.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| OR10_HIGH_FADE_SHORT | Live (ACTIVE) | 6 | $5.0 | $2.0 [-$47.0, $52.0] | 50.0% | 40.0 | 42.0 | R100/P0/G0 | VALUE_FADE |
| STOP_SWEEP_LONG | Unknown-origin (pre-2026-07-09) | 5 | $4.6 | $1.6 [-$64.6, $56.5] | 60.0% | 50.5 | 30.3 | R100/P0/G0 | VALUE_FADE |
| OR5_LOW_FADE_LONG | Gated candidate (never entered) | 7 | $4.5 | $1.5 [-$23.2, $20.0] | 42.9% | 16.0 | 40.0 | R86/P14/G0 | VALUE_FADE |
| OR10_LOW_FADE_LONG | Shadow | 34 | $4.4 | $1.4 [-$21.0, $21.5] | 55.9% | 37.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| WR1_FADE_SHORT | Shadow | 6 | $4.3 | $1.3 [-$68.0, $22.0] | 50.0% | 35.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| PW_LOW_FADE_SHORT | Shadow | 31 | $4.1 | $1.1 [-$39.0, $23.6] | 48.4% | 32.0 | 38.0 | R97/P3/G0 | VALUE_FADE |
| GLOBEX_FLUSH_LONG | Shadow | 14 | $4.0 | $1.0 [-$121.6, $147.7] | 42.9% | 102.0 | 103.6 | R0/P0/G100 | CONTINUATION_LEGACY |
| TRT_LONG | Shadow | 7 | $4.0 | $1.0 [-$51.4, $72.6] | 57.1% | 170.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| STOP_SWEEP_LONG | Shadow | 59 | $3.9 | $0.9 [-$12.6, $14.7] | 59.3% | 41.3 | 30.3 | R93/P7/G0 | VALUE_FADE |
| STOP_SWEEP_LONG | Gated candidate (never entered) | 8 | $3.9 | $0.9 [-$59.0, $42.2] | 62.5% | 74.3 | 29.8 | R88/P13/G0 | VALUE_FADE |
| DAILY_OPEN_FADE_LONG_TRAIL | Shadow | 9 | $3.7 | $0.7 [-$76.0, $80.0] | 55.6% | 88.0 | 42.0 | R100/P0/G0 | VALUE_FADE |
| C_PAIRED_LONG | Shadow | 57 | $3.6 | $0.6 [-$37.5, $45.8] | 47.4% | 60.0 | 97.0 | R96/P4/G0 | CONTINUATION_LEGACY |
| A_DOWN_WEAK | Live (ACTIVE) | 8 | $3.4 | $0.4 [-$53.2, $49.5] | 37.5% | 89.0 | 51.0 | R100/P0/G0 | CONTINUATION_LEGACY |
| PD2_VAH_FADE_LONG | Shadow | 17 | $3.4 | $0.4 [-$84.5, $46.9] | 70.6% | 91.0 | 41.0 | R100/P0/G0 | VALUE_FADE |
| PD_VAH_FADE_LONG | Shadow | 40 | $2.8 | -$0.2 [-$22.4, $21.6] | 47.5% | 37.0 | 40.0 | R98/P3/G0 | VALUE_FADE |
| PD_SESSION_MID_FADE_SHORT | Shadow | 19 | $2.4 | -$0.6 [-$24.7, $20.6] | 42.1% | 20.0 | 35.0 | R100/P0/G0 | VALUE_FADE |
| OR15_LOW_FADE_LONG | Shadow | 29 | $2.1 | -$0.9 [-$30.1, $29.7] | 48.3% | 35.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| OR30_HIGH_FADE_SHORT | Shadow | 46 | $2.0 | -$1.0 [-$26.1, $16.5] | 54.3% | 35.0 | 30.0 | R98/P2/G0 | VALUE_FADE |
| PD_POC_FADE_SHORT | Live (ACTIVE) | 39 | $1.9 | -$1.1 [-$34.3, $29.0] | 64.1% | 47.0 | 30.0 | R8/P0/G92 | GLOBEX_LEVEL |
| OR15_LOW_FADE_LONG | Live (ACTIVE) | 6 | $1.7 | -$1.3 [-$69.0, $47.4] | 50.0% | 37.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| OR30_MID_FADE_SHORT | Shadow | 19 | $1.6 | -$1.4 [-$29.6, $36.6] | 47.4% | 35.0 | 42.0 | R100/P0/G0 | VALUE_FADE |
| PD_VAL_FADE_LONG | Live (ACTIVE) | 52 | $1.5 | -$1.5 [-$19.0, $23.1] | 50.0% | 39.0 | 40.5 | R23/P0/G77 | GLOBEX_LEVEL |
| CAM_R1_FADE_LONG | Shadow | 30 | $1.5 | -$1.5 [-$21.9, $14.9] | 56.7% | 31.0 | 25.0 | R93/P7/G0 | VALUE_FADE |
| STACK_VOL_BREAK_LIVE_SHORT | Shadow | 27 | $1.3 | -$1.7 [-$37.2, $33.4] | 59.3% | 47.8 | 40.0 | R100/P0/G0 | CONTINUATION_LEGACY |
| WEEKLY_VWAP_FADE_SHORT | Shadow | 16 | $1.3 | -$1.7 [-$31.5, $31.8] | 50.0% | 32.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| OR5_LOW_FADE_LONG_GAP_DOWN | Shadow | 26 | $1.2 | -$1.8 [-$26.4, $21.1] | 34.6% | 16.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| CAM_R2_FADE_LONG | Shadow | 31 | $1.1 | -$1.9 [-$29.2, $24.0] | 48.4% | 37.0 | 40.0 | R100/P0/G0 | VALUE_FADE |
| OPEN_TEST_DRIVE_LONG | Gated candidate (never entered) | 353 | $0.9 | -$2.1 [-$9.4, $3.1] | 48.4% | 32.0 | 37.0 | R95/P5/G0 | VALUE_FADE |
| PD_OR_MID_FADE_SHORT | Shadow | 27 | $0.9 | -$2.1 [-$38.4, $32.6] | 51.9% | 37.0 | 43.0 | R81/P19/G0 | VALUE_FADE |
| OR5_HIGH_FADE_LONG | Shadow | 57 | $0.6 | -$2.4 [-$17.4, $11.5] | 47.4% | 27.0 | 40.0 | R96/P4/G0 | VALUE_FADE |
| MPP_FADE_SHORT | Shadow | 5 | $0.6 | -$2.4 [-$148.0, $70.0] | 60.0% | 37.0 | 38.0 | R100/P0/G0 | VALUE_FADE |
| IB_HIGH_FADE_SHORT | Gated candidate (never entered) | 11 | $0.5 | -$2.5 [-$44.9, $24.3] | 45.5% | 29.0 | 50.0 | R73/P27/G0 | VALUE_FADE |
| IB_BEARISH | Live (ACTIVE) | 99 | $0.4 | -$2.6 [-$24.2, $14.5] | 59.6% | 79.0 | 45.0 | R89/P11/G0 | CONTINUATION_LEGACY |
| FLOOR_R1_FADE_SHORT_TRAIL | Shadow | 36 | $0.3 | -$2.8 [-$35.1, $22.6] | 52.8% | 32.0 | 37.0 | R97/P3/G0 | VALUE_FADE |
| PD_POC_FADE_SHORT | Shadow | 62 | $0.1 | -$2.9 [-$29.4, $17.1] | 59.7% | 47.0 | 30.0 | R11/P0/G89 | GLOBEX_LEVEL |

### Table 3b -- Reading Table 3: (a) survivor-count placebo (within-date permutation of setup labels among the Mode 1 trades of each environment, group sizes and Train/Hold-Out membership kept, 500 permutations); (b) persistence of the Train sign into the Hold-Out

| Survivor rule | Observed | Placebo mean | Placebo 5th-95th pct | P(placebo >= observed) |
|---|---|---|---|---|
| all simulated groups (Train N>=1, HO>0 or HO N<5) | 37 | 41.0 | 35 to 47 | 0.870 |
| Train N>=20 and Hold-Out N>=20, both means > 0 | 12 | 18.9 | 14 to 23 | 1.000 |
| Hold-Out-only groups (no Train trades), Hold-Out N>=5 and mean > 0 (Table 3c) | 135 | 132.7 | 122 to 142 | 0.376 |

Persistence test: pooled Hold-Out trades of groups with Train mean @$1 > 0 vs <= 0 (groups defined from Train only):
| Groups included | Groups | Train-positive / Train-nonpositive groups | Hold-Out trades (pos / nonpos) | Hold-Out mean, Train-positive groups | Hold-Out mean, Train-nonpositive groups | Difference [95% CI] |
|---|---|---|---|---|---|---|
| all groups with Train and Hold-Out trades | 147 | 68 / 79 | 1547 / 5523 | -$1.3 | -$2.5 | $1.2 [-$8.2, $10.4] |
| Train N>=5 and Hold-Out N>=5 | 126 | 60 / 66 | 1512 / 5474 | -$2.5 | -$2.4 | -$0.1 [-$9.4, $8.9] |
| Train N>=20 and Hold-Out N>=20 | 74 | 29 / 45 | 1154 / 5219 | -$3.8 | -$2.7 | -$1.1 [-$11.1, $8.7] |
