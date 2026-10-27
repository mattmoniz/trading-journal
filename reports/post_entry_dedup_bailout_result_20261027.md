# Post-entry study -- run output. Population: 5324 BACKFILL RTH level fades (strategy SIMULATION), 336 dates; Train through 2026-01-02: 3160 trades; Hold-Out 2164

### Table 1 -- Deduplication impact (Mode 0 raw; Mode 1 no overlapping open same-direction trade; Mode 2 5-minute level-zone cooldown). Win rate = trades with Net_PnL > 0. DD = true realized-curve drawdown.

| Mode | Sample | Total Trades | Bucket A | Bucket B | Bucket C | Win Rate % | Profit Factor | Net PnL ($) | Mean PnL/Trade ($) | True Chrono Max DD ($) |
|---|---|---|---|---|---|---|---|---|---|---|
| Mode 0 | Full | 5324 | 3183 (59.8%) | 312 (5.9%) | 1357 (25.5%) | 59.8% | 1.02 | $5381 | $1.0 | $25287 |
| Mode 0 | Train 60% | 3160 | 1809 (57.2%) | 129 (4.1%) | 826 (26.1%) | 57.2% | 1.00 | $403 | $0.1 | $25287 |
| Mode 0 | Hold-Out 40% | 2164 | 1374 (63.5%) | 183 (8.5%) | 531 (24.5%) | 63.5% | 1.04 | $4978 | $2.3 | $13133 |
| Mode 1 | Full | 1723 | 1064 (61.8%) | 104 (6.0%) | 444 (25.8%) | 61.8% | 1.05 | $4203 | $2.4 | $4223 |
| Mode 1 | Train 60% | 926 | 554 (59.8%) | 39 (4.2%) | 240 (25.9%) | 59.8% | 1.05 | $2128 | $2.3 | $4223 |
| Mode 1 | Hold-Out 40% | 797 | 510 (64.0%) | 65 (8.2%) | 204 (25.6%) | 64.0% | 1.05 | $2075 | $2.6 | $2357 |
| Mode 2 | Full | 3628 | 2169 (59.8%) | 192 (5.3%) | 925 (25.5%) | 59.8% | 1.04 | $7058 | $1.9 | $15452 |
| Mode 2 | Train 60% | 2183 | 1239 (56.8%) | 83 (3.8%) | 574 (26.3%) | 56.8% | 1.00 | -$475 | -$0.2 | $15452 |
| Mode 2 | Hold-Out 40% | 1445 | 930 (64.4%) | 109 (7.5%) | 351 (24.3%) | 64.4% | 1.10 | $7533 | $5.2 | $6747 |

### Table 1b -- Are the removed duplicates below-average trades? removed mean vs Mode-0 mean (date-blocked 95% interval of the difference) and random-removal placebo (same count, 5th-95th pct of random-subset mean; remaining-book drawdown under random removal)

| Mode | Sample | Removed n | Removed mean vs all-trade mean | Diff 95% interval | Random-removal mean band | Actual remaining DD | Random-removal DD band |
|---|---|---|---|---|---|---|---|
| Mode 1 | Full | 3601 | $0.3 vs $1.0 | [-$2.8, $1.5] | -$2.2 to $4.2 | $4223 | $6357 to $11810 |
| Mode 1 | Train 60% | 2234 | -$0.8 vs $0.1 | [-$3.4, $1.5] | -$3.7 to $4.0 | $4223 | $5546 to $10870 |
| Mode 1 | Hold-Out 40% | 1367 | $2.1 vs $2.3 | [-$4.0, $3.7] | -$3.0 to $7.8 | $2357 | $3218 to $7663 |
| Mode 2 | Full | 1696 | -$1.0 vs $1.0 | [-$6.8, $3.0] | -$3.5 to $5.6 | $15452 | $15097 to $20260 |
| Mode 2 | Train 60% | 977 | $0.9 vs $0.1 | [-$6.2, $7.8] | -$5.9 to $6.4 | $15452 | $15154 to $20619 |
| Mode 2 | Hold-Out 40% | 719 | -$3.6 vs $2.3 | [-$12.9, $0.8] | -$5.3 to $10.1 | $6747 | $6769 to $11195 |


==============================================================================================================
## MODE 1 BOOK (primary) (1723 trades)


### Table 2 -- First-blood circuit breaker on MODE 1 BOOK (primary). W swept on Train; W* = highest Train remaining-book net. Hold-Out rows for W != W* are descriptive only.

| Sample | W (min) | Vetoed (n, %) | Vetoed mean PnL [95% CI] | Book baseline mean | Vetoed minus baseline [95% CI] | Random-veto placebo band (5th-95th) | Remaining book Net | Remaining book PF |
|---|---|---|---|---|---|---|---|---|
| Train 60% | 15 | 109 (11.8%) | -$4.9 [-$27.4, $16.8] | $2.3 | -$7.2 [-$29.0, $13.2] | -$15.3 to $18.9 | $2665 | 1.07 |
| Train 60% | 30 | 131 (14.1%) | -$2.5 [-$23.7, $17.4] | $2.3 | -$4.8 [-$24.2, $13.8] | -$14.1 to $18.7 | $2461 | 1.07 |
| Train 60% | 45 * | 154 (16.6%) | -$3.6 [-$22.2, $14.9] | $2.3 | -$5.9 [-$23.1, $11.0] | -$13.0 to $17.1 | $2690 | 1.08 |
| Train 60% | 60 | 169 (18.3%) | -$1.5 [-$17.8, $14.6] | $2.3 | -$3.8 [-$18.9, $11.8] | -$11.3 to $16.3 | $2388 | 1.07 |
| Train 60% | 390 (rest of session) | 256 (27.6%) | $6.2 [-$6.7, $19.4] | $2.3 | $3.9 [-$7.6, $15.5] | -$9.2 to $13.5 | $543 | 1.02 |
| Hold-Out 40% | 15 | 80 (10.0%) | -$0.7 [-$22.0, $21.2] | $2.6 | -$3.3 [-$22.8, $18.7] | -$20.6 to $25.5 | $2134 | 1.06 |
| Hold-Out 40% | 30 | 108 (13.6%) | -$7.5 [-$26.2, $12.8] | $2.6 | -$10.1 [-$28.3, $7.9] | -$17.6 to $21.3 | $2880 | 1.08 |
| Hold-Out 40% | 45 * | 128 (16.1%) | -$2.8 [-$21.0, $15.5] | $2.6 | -$5.4 [-$22.4, $11.3] | -$15.2 to $19.9 | $2438 | 1.07 |
| Hold-Out 40% | 60 | 147 (18.4%) | -$6.6 [-$23.2, $11.1] | $2.6 | -$9.2 [-$24.2, $6.3] | -$13.0 to $18.1 | $3043 | 1.09 |
| Hold-Out 40% | 390 (rest of session) | 233 (29.2%) | -$2.6 [-$15.9, $10.7] | $2.6 | -$5.2 [-$16.4, $5.5] | -$10.1 to $16.0 | $2685 | 1.09 |
Counted test (frozen W*=45, Hold-Out): vetoed minus baseline -$5.4, upper 97.5% bound $10.7 (needs < 0); vetoed mean -$2.8 vs placebo 5th pct -$15.7; remaining-book net $2438 vs book $2075 -> DOES NOT PASS

### Table 3A -- Path separation at bar k on MODE 1 BOOK (primary) (trades still open at the close of bar t_entry+k; MFE_k and Unrealized_R_k in R of the stop distance, bars t+1..t+k only; Full sample)

| k | Eventual bucket | Open n | MFE_k p25 / med / p75 | Unrealized_R_k p25 / med / p75 |
|---|---|---|---|---|
| 1 | Winners (A) | 976 | 0.064 / 0.130 / 0.230 | -0.081 / 0.018 / 0.124 |
| 1 | Steamrolls (C) | 443 | 0.039 / 0.086 / 0.158 | -0.167 / -0.057 / 0.036 |
| 2 | Winners (A) | 885 | 0.088 / 0.173 / 0.285 | -0.105 / 0.033 / 0.169 |
| 2 | Steamrolls (C) | 436 | 0.053 / 0.115 / 0.205 | -0.254 / -0.100 / 0.033 |
| 3 | Winners (A) | 784 | 0.100 / 0.191 / 0.319 | -0.122 / 0.022 / 0.165 |
| 3 | Steamrolls (C) | 425 | 0.064 / 0.130 / 0.228 | -0.319 / -0.126 / -0.011 |
| 5 | Winners (A) | 669 | 0.118 / 0.230 / 0.350 | -0.147 / 0.032 / 0.179 |
| 5 | Steamrolls (C) | 396 | 0.073 / 0.152 / 0.254 | -0.392 / -0.205 / -0.032 |

| k | Subset | n | Eventual win rate | Mean eventual PnL | Share eventually C |
|---|---|---|---|---|---|
| 1 | all open at k | 1627 | 60.0% | -$1.4 | 27.2% |
| 1 | MFE_k<0.15 & UR_k<-0.20 | 183 | 41.5% | -$51.8 | 43.7% |
| 2 | all open at k | 1521 | 58.2% | -$5.2 | 28.7% |
| 2 | MFE_k<0.15 & UR_k<-0.20 | 224 | 38.4% | -$63.5 | 50.4% |
| 3 | all open at k | 1394 | 56.2% | -$9.0 | 30.5% |
| 3 | MFE_k<0.15 & UR_k<-0.20 | 227 | 39.6% | -$56.6 | 49.8% |
| 5 | all open at k | 1232 | 54.3% | -$12.7 | 32.1% |
| 5 | MFE_k<0.15 & UR_k<-0.20 | 236 | 37.3% | -$59.4 | 51.3% |

### Table 3B -- Bailout grid on MODE 1 BOOK (primary): Train objective = sum over modified trades of (bailout PnL - original PnL). Hold-Out columns shown for transparency; ONLY the frozen Train-best cell counts. (* = frozen)

| k | X (MFE<=) | Y (UR<=-) | Train n mod | Train saved-minus-forgone ($) | Train per modified | Hold-Out n mod | Hold-Out total ($) | Hold-Out per modified |
|---|---|---|---|---|---|---|---|---|
| 2 | 0.05 | 0.1 | 98 | $1503 | $15.3 | 70 | -$925 | -$13.2 |
| 2 | 0.05 | 0.2 | 48 | $1270 | $26.5 | 52 | $609 | $11.7 |
| 2 | 0.05 | 0.35 | 19 | $529 | $27.8 | 24 | -$103 | -$4.3 |
| 2 | 0.05 | 0.5 | 9 | $152 | $16.8 | 13 | -$91 | -$7.0 |
| 2 | 0.1 | 0.1 | 167 | $1646 | $9.9 | 137 | -$2476 | -$18.1 |
| 2 | 0.1 | 0.2 | 81 | $1151 | $14.2 | 96 | $380 | $4.0 |
| 2 | 0.1 | 0.35 | 30 | $598 | $19.9 | 43 | -$30 | -$0.7 |
| 2 | 0.1 | 0.5 | 17 | $373 | $21.9 | 19 | -$150 | -$7.9 |
| 2 | 0.15 | 0.1 | 207 | $1402 | $6.8 | 180 | -$2819 | -$15.7 |
| 2 | 0.15 | 0.2 | 106 | $1272 | $12.0 | 119 | -$353 | -$3.0 |
| 2 | 0.15 | 0.35 | 37 | $857 | $23.2 | 54 | -$245 | -$4.5 |
| 2 | 0.15 | 0.5 | 20 | $297 | $14.9 | 24 | -$273 | -$11.4 |
| 2 | 0.25 | 0.1 | 241 | $1651 * | $6.9 | 235 | -$2602 | -$11.1 |
| 2 | 0.25 | 0.2 | 124 | $1090 | $8.8 | 156 | -$629 | -$4.0 |
| 2 | 0.25 | 0.35 | 42 | $643 | $15.3 | 73 | $121 | $1.7 |
| 2 | 0.25 | 0.5 | 23 | $133 | $5.8 | 32 | $256 | $8.0 |
| 3 | 0.05 | 0.1 | 85 | $496 | $5.8 | 60 | -$14 | -$0.2 |
| 3 | 0.05 | 0.2 | 47 | $679 | $14.4 | 44 | -$162 | -$3.7 |
| 3 | 0.05 | 0.35 | 23 | $515 | $22.4 | 25 | $449 | $18.0 |
| 3 | 0.05 | 0.5 | 11 | $316 | $28.7 | 13 | $149 | $11.5 |
| 3 | 0.1 | 0.1 | 148 | $1045 | $7.1 | 123 | -$1673 | -$13.6 |
| 3 | 0.1 | 0.2 | 84 | $608 | $7.2 | 89 | -$870 | -$9.8 |
| 3 | 0.1 | 0.35 | 41 | $184 | $4.5 | 50 | $285 | $5.7 |
| 3 | 0.1 | 0.5 | 18 | -$120 | -$6.7 | 21 | -$403 | -$19.2 |
| 3 | 0.15 | 0.1 | 199 | $606 | $3.0 | 167 | -$1860 | -$11.1 |
| 3 | 0.15 | 0.2 | 106 | -$233 | -$2.2 | 123 | -$1120 | -$9.1 |
| 3 | 0.15 | 0.35 | 50 | -$340 | -$6.8 | 68 | -$216 | -$3.2 |
| 3 | 0.15 | 0.5 | 22 | -$87 | -$4.0 | 27 | -$395 | -$14.6 |
| 3 | 0.25 | 0.1 | 236 | $361 | $1.5 | 222 | -$1516 | -$6.8 |
| 3 | 0.25 | 0.2 | 131 | -$677 | -$5.2 | 165 | -$453 | -$2.7 |
| 3 | 0.25 | 0.35 | 59 | -$861 | -$14.6 | 96 | $506 | $5.3 |
| 3 | 0.25 | 0.5 | 25 | -$403 | -$16.1 | 37 | -$281 | -$7.6 |
| 4 | 0.05 | 0.1 | 79 | $238 | $3.0 | 52 | -$472 | -$9.1 |
| 4 | 0.05 | 0.2 | 51 | $748 | $14.7 | 43 | -$945 | -$22.0 |
| 4 | 0.05 | 0.35 | 21 | $148 | $7.0 | 26 | -$686 | -$26.4 |
| 4 | 0.05 | 0.5 | 8 | -$139 | -$17.3 | 14 | $514 | $36.7 |
| 4 | 0.1 | 0.1 | 141 | $1308 | $9.3 | 103 | -$1817 | -$17.6 |
| 4 | 0.1 | 0.2 | 94 | $1100 | $11.7 | 82 | -$1939 | -$23.6 |
| 4 | 0.1 | 0.35 | 42 | $201 | $4.8 | 47 | -$1040 | -$22.1 |
| 4 | 0.1 | 0.5 | 15 | $62 | $4.1 | 25 | $592 | $23.7 |
| 4 | 0.15 | 0.1 | 192 | -$495 | -$2.6 | 150 | -$1407 | -$9.4 |
| 4 | 0.15 | 0.2 | 122 | $46 | $0.4 | 113 | -$1899 | -$16.8 |
| 4 | 0.15 | 0.35 | 54 | -$520 | -$9.6 | 66 | -$1420 | -$21.5 |
| 4 | 0.15 | 0.5 | 22 | -$541 | -$24.6 | 36 | $500 | $13.9 |
| 4 | 0.25 | 0.1 | 248 | $112 | $0.5 | 208 | -$762 | -$3.7 |
| 4 | 0.25 | 0.2 | 157 | $896 | $5.7 | 152 | -$1210 | -$8.0 |
| 4 | 0.25 | 0.35 | 73 | -$789 | -$10.8 | 93 | -$796 | -$8.6 |
| 4 | 0.25 | 0.5 | 32 | -$449 | -$14.0 | 50 | $939 | $18.8 |
Frozen Train-best cell: k*=2, X*=0.25, Y*=0.1 (Train improvement $1651 on 241 modified trades)
Selection null (Train best-of-48 under random same-size bailouts, 500 reps): 5th-95th pct $1189 to $3215; actual Train max $1651; P(null max >= actual) = 0.686

### Table 3B (frozen rule k*=2 X*=0.25 Y*=0.1) on MODE 1 BOOK (primary)

| Sample | Trades modified | Original mean PnL of modified | Bailout mean PnL of modified | Net improvement per modified [95% CI] | Random-bailout placebo band (5th-95th) | Full book Net: after vs before | Full book PF: after vs before |
|---|---|---|---|---|---|---|---|
| Train 60% | 241 | -$46.5 | -$39.7 | $6.9 [-$7.0, $20.3] | -$12.6 to $10.2 (mean -$1.2) | $3779 vs $2128 | 1.11 vs 1.05 |
| Hold-Out 40% | 235 | -$38.5 | -$49.5 | -$11.1 [-$27.3, $4.1] | -$13.0 to $11.9 (mean -$0.4) | -$527 vs $2075 | 0.99 vs 1.05 |
Counted test (Hold-Out): improvement per modified lower bound -$27.3 (needs > 0); placebo 95th pct $11.9; selection-null P 0.686 (needs < 0.05) -> DOES NOT PASS

### Table 4 -- Post-entry flip vs random-flip placebo on MODE 1 BOOK (primary) (Variant A: bailout flip at Close[t+k*] with the frozen Part-3 rule k*=2 X*=0.25 Y*=0.1; Variant B: stop-through flip at Stop_Price at t_exit for accepted Bucket C stop-outs; B+C supplement flips every stop-out)

| Sample | Variant | Target | Flip Count | Flip Win Rate | Flip Mean PnL [95% CI] | Random-flip placebo band (5th-95th) | Combined Book Net / PF |
|---|---|---|---|---|---|---|---|
| Train 60% | A bailout flip | 1R | 241 | 55.2% | $7.9 [-$9.8, $26.2] | -$22.3 to $7.6 (mean -$7.6) | $5681 / 1.11 (book alone $3779 / 1.11) |
| Train 60% | A bailout flip | 1.5R | 241 | 45.6% | $4.6 [-$19.2, $27.8] | -$26.3 to $9.9 (mean -$7.9) | $4890 / 1.09 (book alone $3779 / 1.11) |
| Train 60% | B stop-through flip (C only) | 1R | 240 | 51.2% | -$4.2 [-$22.3, $13.5] | -$20.4 to $11.8 (mean -$4.2) | $1112 / 1.02 (book alone $2128 / 1.05) |
| Train 60% | B stop-through flip (C only) | 1.5R | 240 | 46.7% | $3.4 [-$17.5, $22.8] | -$10.7 to $22.1 (mean $6.0) | $2945 / 1.05 (book alone $2128 / 1.05) |
| Train 60% | B+C all stop-outs (supplement) | 1R | 279 | 50.9% | -$4.0 [-$20.3, $11.7] | -$17.6 to $11.9 (mean -$3.5) | $1016 / 1.02 (book alone $2128 / 1.05) |
| Train 60% | B+C all stop-outs (supplement) | 1.5R | 279 | 46.6% | $5.6 [-$14.1, $24.8] | -$11.6 to $22.0 (mean $5.2) | $3688 / 1.06 (book alone $2128 / 1.05) |
| Hold-Out 40% | A bailout flip | 1R | 235 | 49.4% | -$4.3 [-$26.7, $17.4] | -$22.1 to $12.9 (mean -$4.0) | -$1545 / 0.97 (book alone -$527 / 0.99) |
| Hold-Out 40% | A bailout flip | 1.5R | 235 | 41.7% | -$0.4 [-$25.2, $25.1] | -$27.8 to $14.8 (mean -$6.4) | -$612 / 0.99 (book alone -$527 / 0.99) |
| Hold-Out 40% | B stop-through flip (C only) | 1R | 204 | 45.6% | -$17.6 [-$37.8, $3.7] | -$34.2 to $3.1 (mean -$14.9) | -$1512 / 0.97 (book alone $2075 / 1.05) |
| Hold-Out 40% | B stop-through flip (C only) | 1.5R | 204 | 39.7% | -$14.1 [-$37.1, $10.6] | -$30.6 to $11.3 (mean -$9.9) | -$808 / 0.99 (book alone $2075 / 1.05) |
| Hold-Out 40% | B+C all stop-outs (supplement) | 1R | 269 | 46.5% | -$15.1 [-$33.2, $2.9] | -$31.1 to $0.6 (mean -$15.4) | -$1995 / 0.97 (book alone $2075 / 1.05) |
| Hold-Out 40% | B+C all stop-outs (supplement) | 1.5R | 269 | 40.5% | -$10.6 [-$31.4, $10.2] | -$28.8 to $8.5 (mean -$9.9) | -$769 / 0.99 (book alone $2075 / 1.05) |
Counted test (Hold-Out) A bailout flip 1R: mean -$4.3 lower bound -$26.7 (needs > 0), placebo 95th pct $12.9 -> DOES NOT PASS (n=235)
Counted test (Hold-Out) A bailout flip 1.5R: mean -$0.4 lower bound -$25.2 (needs > 0), placebo 95th pct $14.8 -> DOES NOT PASS (n=235)
Counted test (Hold-Out) B stop-through flip (C only) 1R: mean -$17.6 lower bound -$37.8 (needs > 0), placebo 95th pct $3.1 -> DOES NOT PASS (n=204)
Counted test (Hold-Out) B stop-through flip (C only) 1.5R: mean -$14.1 lower bound -$37.1 (needs > 0), placebo 95th pct $11.3 -> DOES NOT PASS (n=204)


==============================================================================================================
## MODE 0 RAW BOOK (secondary) (5324 trades)


### Table 2 -- First-blood circuit breaker on MODE 0 RAW BOOK (secondary). W swept on Train; W* = highest Train remaining-book net. Hold-Out rows for W != W* are descriptive only.

| Sample | W (min) | Vetoed (n, %) | Vetoed mean PnL [95% CI] | Book baseline mean | Vetoed minus baseline [95% CI] | Random-veto placebo band (5th-95th) | Remaining book Net | Remaining book PF |
|---|---|---|---|---|---|---|---|---|
| Train 60% | 15 * | 461 (14.6%) | $3.9 [-$19.1, $25.9] | $0.1 | $3.8 [-$16.0, $23.6] | -$8.3 to $8.4 | -$1402 | 0.99 |
| Train 60% | 30 | 555 (17.6%) | $6.4 [-$13.0, $26.1] | $0.1 | $6.3 [-$11.4, $23.2] | -$7.7 to $7.8 | -$3170 | 0.98 |
| Train 60% | 45 | 640 (20.3%) | $6.6 [-$12.0, $25.0] | $0.1 | $6.4 [-$8.9, $23.4] | -$7.0 to $7.6 | -$3794 | 0.97 |
| Train 60% | 60 | 678 (21.5%) | $6.5 [-$11.6, $24.0] | $0.1 | $6.3 [-$8.9, $21.5] | -$7.5 to $7.6 | -$3983 | 0.97 |
| Train 60% | 390 (rest of session) | 881 (27.9%) | $7.3 [-$6.9, $23.0] | $0.1 | $7.1 [-$6.3, $19.8] | -$6.0 to $6.3 | -$5989 | 0.95 |
| Hold-Out 40% | 15 * | 280 (12.9%) | $1.1 [-$21.5, $22.8] | $2.3 | -$1.2 [-$22.5, $20.0] | -$10.1 to $14.7 | $4661 | 1.05 |
| Hold-Out 40% | 30 | 371 (17.1%) | $0.7 [-$15.9, $18.4] | $2.3 | -$1.6 [-$16.6, $13.0] | -$8.1 to $13.0 | $4725 | 1.05 |
| Hold-Out 40% | 45 | 432 (20.0%) | -$7.6 [-$24.6, $10.1] | $2.3 | -$9.9 [-$24.7, $4.9] | -$7.2 to $11.6 | $8259 | 1.09 |
| Hold-Out 40% | 60 | 479 (22.1%) | -$6.6 [-$23.1, $10.3] | $2.3 | -$8.9 [-$22.5, $4.0] | -$7.0 to $11.3 | $8147 | 1.09 |
| Hold-Out 40% | 390 (rest of session) | 687 (31.7%) | $0.1 [-$12.9, $14.5] | $2.3 | -$2.2 [-$12.3, $8.0] | -$5.5 to $9.9 | $4881 | 1.06 |
Counted test (frozen W*=15, Hold-Out): vetoed minus baseline -$1.2, upper 97.5% bound $19.8 (needs < 0); vetoed mean $1.1 vs placebo 5th pct -$10.2; remaining-book net $4661 vs book $4978 -> DOES NOT PASS

### Table 3A -- Path separation at bar k on MODE 0 RAW BOOK (secondary) (trades still open at the close of bar t_entry+k; MFE_k and Unrealized_R_k in R of the stop distance, bars t+1..t+k only; Full sample)

| k | Eventual bucket | Open n | MFE_k p25 / med / p75 | Unrealized_R_k p25 / med / p75 |
|---|---|---|---|---|
| 1 | Winners (A) | 2973 | 0.058 / 0.119 / 0.211 | -0.080 / 0.018 / 0.112 |
| 1 | Steamrolls (C) | 1355 | 0.039 / 0.085 / 0.149 | -0.138 / -0.043 / 0.049 |
| 2 | Winners (A) | 2756 | 0.083 / 0.158 / 0.271 | -0.093 / 0.027 / 0.146 |
| 2 | Steamrolls (C) | 1338 | 0.052 / 0.111 / 0.191 | -0.221 / -0.076 / 0.040 |
| 3 | Winners (A) | 2513 | 0.093 / 0.181 / 0.305 | -0.111 / 0.025 / 0.156 |
| 3 | Steamrolls (C) | 1317 | 0.060 / 0.127 / 0.213 | -0.289 / -0.114 / 0.014 |
| 5 | Winners (A) | 2149 | 0.113 / 0.210 / 0.342 | -0.123 / 0.035 / 0.171 |
| 5 | Steamrolls (C) | 1244 | 0.069 / 0.152 / 0.249 | -0.383 / -0.176 / 0.003 |

| k | Subset | n | Eventual win rate | Mean eventual PnL | Share eventually C |
|---|---|---|---|---|---|
| 1 | all open at k | 5093 | 58.4% | -$2.2 | 26.6% |
| 1 | MFE_k<0.15 & UR_k<-0.20 | 476 | 43.5% | -$48.5 | 41.2% |
| 2 | all open at k | 4833 | 57.0% | -$4.7 | 27.7% |
| 2 | MFE_k<0.15 & UR_k<-0.20 | 624 | 38.0% | -$61.5 | 49.7% |
| 3 | all open at k | 4539 | 55.4% | -$8.0 | 29.0% |
| 3 | MFE_k<0.15 & UR_k<-0.20 | 662 | 38.1% | -$61.1 | 50.8% |
| 5 | all open at k | 4050 | 53.1% | -$12.1 | 30.7% |
| 5 | MFE_k<0.15 & UR_k<-0.20 | 700 | 36.1% | -$65.7 | 53.6% |

### Table 3B -- Bailout grid on MODE 0 RAW BOOK (secondary): Train objective = sum over modified trades of (bailout PnL - original PnL). Hold-Out columns shown for transparency; ONLY the frozen Train-best cell counts. (* = frozen)

| k | X (MFE<=) | Y (UR<=-) | Train n mod | Train saved-minus-forgone ($) | Train per modified | Hold-Out n mod | Hold-Out total ($) | Hold-Out per modified |
|---|---|---|---|---|---|---|---|---|
| 2 | 0.05 | 0.1 | 318 | -$1317 | -$4.1 | 218 | $1543 | $7.1 |
| 2 | 0.05 | 0.2 | 169 | $547 | $3.2 | 145 | $1927 | $13.3 |
| 2 | 0.05 | 0.35 | 65 | -$779 | -$12.0 | 62 | $894 | $14.4 |
| 2 | 0.05 | 0.5 | 25 | -$132 | -$5.3 | 28 | -$367 | -$13.1 |
| 2 | 0.1 | 0.1 | 522 | $1171 | $2.2 | 367 | -$1213 | -$3.3 |
| 2 | 0.1 | 0.2 | 266 | $2520 | $9.5 | 238 | -$220 | -$0.9 |
| 2 | 0.1 | 0.35 | 97 | -$82 | -$0.8 | 110 | $378 | $3.4 |
| 2 | 0.1 | 0.5 | 40 | $224 | $5.6 | 43 | -$514 | -$12.0 |
| 2 | 0.15 | 0.1 | 642 | $89 | $0.1 | 470 | -$1020 | -$2.2 |
| 2 | 0.15 | 0.2 | 332 | $3022 | $9.1 | 294 | -$1455 | -$4.9 |
| 2 | 0.15 | 0.35 | 114 | $247 | $2.2 | 131 | $64 | $0.5 |
| 2 | 0.15 | 0.5 | 49 | $339 | $6.9 | 52 | -$726 | -$14.0 |
| 2 | 0.25 | 0.1 | 733 | -$1248 | -$1.7 | 618 | -$1634 | -$2.6 |
| 2 | 0.25 | 0.2 | 383 | $1291 | $3.4 | 384 | -$2750 | -$7.2 |
| 2 | 0.25 | 0.35 | 134 | -$1404 | -$10.5 | 177 | -$554 | -$3.1 |
| 2 | 0.25 | 0.5 | 56 | -$440 | -$7.8 | 68 | $10 | $0.1 |
| 3 | 0.05 | 0.1 | 277 | -$236 | -$0.9 | 193 | $2278 | $11.8 |
| 3 | 0.05 | 0.2 | 159 | $13 | $0.1 | 148 | $2202 | $14.9 |
| 3 | 0.05 | 0.35 | 79 | $507 | $6.4 | 70 | $1099 | $15.7 |
| 3 | 0.05 | 0.5 | 30 | $284 | $9.5 | 39 | -$112 | -$2.9 |
| 3 | 0.1 | 0.1 | 500 | $2506 | $5.0 | 341 | -$1580 | -$4.6 |
| 3 | 0.1 | 0.2 | 261 | $1369 | $5.2 | 248 | -$528 | -$2.1 |
| 3 | 0.1 | 0.35 | 127 | $992 | $7.8 | 120 | -$106 | -$0.9 |
| 3 | 0.1 | 0.5 | 46 | $111 | $2.4 | 59 | -$998 | -$16.9 |
| 3 | 0.15 | 0.1 | 666 | $1300 | $2.0 | 448 | -$1803 | -$4.0 |
| 3 | 0.15 | 0.2 | 334 | $357 | $1.1 | 331 | -$1620 | -$4.9 |
| 3 | 0.15 | 0.35 | 159 | $607 | $3.8 | 160 | -$992 | -$6.2 |
| 3 | 0.15 | 0.5 | 58 | $69 | $1.2 | 74 | -$1532 | -$20.7 |
| 3 | 0.25 | 0.1 | 801 | $1871 | $2.3 | 612 | -$1885 | -$3.1 |
| 3 | 0.25 | 0.2 | 411 | -$182 | -$0.4 | 451 | -$808 | -$1.8 |
| 3 | 0.25 | 0.35 | 192 | -$758 | -$3.9 | 227 | $477 | $2.1 |
| 3 | 0.25 | 0.5 | 69 | -$556 | -$8.1 | 104 | -$553 | -$5.3 |
| 4 | 0.05 | 0.1 | 269 | -$648 | -$2.4 | 168 | $438 | $2.6 |
| 4 | 0.05 | 0.2 | 163 | $394 | $2.4 | 131 | -$638 | -$4.9 |
| 4 | 0.05 | 0.35 | 72 | $315 | $4.4 | 84 | $423 | $5.0 |
| 4 | 0.05 | 0.5 | 30 | -$765 | -$25.5 | 46 | $681 | $14.8 |
| 4 | 0.1 | 0.1 | 481 | $747 | $1.6 | 299 | -$2872 | -$9.6 |
| 4 | 0.1 | 0.2 | 293 | $1668 | $5.7 | 234 | -$3018 | -$12.9 |
| 4 | 0.1 | 0.35 | 131 | $338 | $2.6 | 139 | $366 | $2.6 |
| 4 | 0.1 | 0.5 | 52 | -$744 | -$14.3 | 72 | $1210 | $16.8 |
| 4 | 0.15 | 0.1 | 649 | -$1741 | -$2.7 | 413 | -$3388 | -$8.2 |
| 4 | 0.15 | 0.2 | 388 | $1457 | $3.8 | 318 | -$3609 | -$11.3 |
| 4 | 0.15 | 0.35 | 169 | -$127 | -$0.8 | 185 | -$141 | -$0.8 |
| 4 | 0.15 | 0.5 | 73 | -$1450 | -$19.9 | 98 | $1346 | $13.7 |
| 4 | 0.25 | 0.1 | 805 | $1209 | $1.5 | 583 | -$1682 | -$2.9 |
| 4 | 0.25 | 0.2 | 473 | $3514 * | $7.4 | 441 | -$1426 | -$3.2 |
| 4 | 0.25 | 0.35 | 204 | -$945 | -$4.6 | 252 | $1681 | $6.7 |
| 4 | 0.25 | 0.5 | 89 | -$1034 | -$11.6 | 139 | $2196 | $15.8 |
Frozen Train-best cell: k*=4, X*=0.25, Y*=0.2 (Train improvement $3514 on 473 modified trades)
Selection null (Train best-of-48 under random same-size bailouts, 500 reps): 5th-95th pct $2986 to $6865; actual Train max $3514; P(null max >= actual) = 0.830

### Table 3B (frozen rule k*=4 X*=0.25 Y*=0.2) on MODE 0 RAW BOOK (secondary)

| Sample | Trades modified | Original mean PnL of modified | Bailout mean PnL of modified | Net improvement per modified [95% CI] | Random-bailout placebo band (5th-95th) | Full book Net: after vs before | Full book PF: after vs before |
|---|---|---|---|---|---|---|---|
| Train 60% | 473 | -$66.2 | -$58.8 | $7.4 [-$6.8, $21.2] | -$7.7 to $9.4 (mean $0.9) | $3917 vs $403 | 1.03 vs 1.00 |
| Hold-Out 40% | 441 | -$70.5 | -$73.7 | -$3.2 [-$21.0, $13.1] | -$11.9 to $7.4 (mean -$2.3) | $3552 vs $4978 | 1.03 vs 1.04 |
Counted test (Hold-Out): improvement per modified lower bound -$21.0 (needs > 0); placebo 95th pct $7.4; selection-null P 0.830 (needs < 0.05) -> DOES NOT PASS

### Table 4 -- Post-entry flip vs random-flip placebo on MODE 0 RAW BOOK (secondary) (Variant A: bailout flip at Close[t+k*] with the frozen Part-3 rule k*=4 X*=0.25 Y*=0.2; Variant B: stop-through flip at Stop_Price at t_exit for accepted Bucket C stop-outs; B+C supplement flips every stop-out)

| Sample | Variant | Target | Flip Count | Flip Win Rate | Flip Mean PnL [95% CI] | Random-flip placebo band (5th-95th) | Combined Book Net / PF |
|---|---|---|---|---|---|---|---|
| Train 60% | A bailout flip | 1R | 473 | 50.5% | $6.2 [-$12.8, $24.4] | -$8.4 to $13.6 (mean $3.0) | $6858 / 1.04 (book alone $3917 / 1.03) |
| Train 60% | A bailout flip | 1.5R | 473 | 42.9% | $2.0 [-$20.1, $24.0] | -$13.0 to $12.2 (mean -$0.2) | $4849 / 1.03 (book alone $3917 / 1.03) |
| Train 60% | B stop-through flip (C only) | 1R | 826 | 49.4% | -$7.2 [-$26.5, $11.1] | -$17.6 to -$2.1 (mean -$9.8) | -$5551 / 0.97 (book alone $403 / 1.00) |
| Train 60% | B stop-through flip (C only) | 1.5R | 826 | 44.7% | -$6.0 [-$27.4, $15.0] | -$17.0 to $1.3 (mean -$8.1) | -$4517 / 0.98 (book alone $403 / 1.00) |
| Train 60% | B+C all stop-outs (supplement) | 1R | 955 | 48.2% | -$9.9 [-$27.6, $7.3] | -$17.4 to -$2.4 (mean -$9.7) | -$9067 / 0.96 (book alone $403 / 1.00) |
| Train 60% | B+C all stop-outs (supplement) | 1.5R | 955 | 43.5% | -$8.1 [-$28.7, $13.9] | -$16.6 to $0.3 (mean -$8.3) | -$7332 / 0.97 (book alone $403 / 1.00) |
| Hold-Out 40% | A bailout flip | 1R | 441 | 51.7% | -$1.8 [-$26.1, $22.9] | -$18.6 to $7.3 (mean -$5.5) | $2739 / 1.02 (book alone $3552 / 1.03) |
| Hold-Out 40% | A bailout flip | 1.5R | 441 | 44.0% | -$0.5 [-$32.2, $31.2] | -$20.4 to $10.5 (mean -$5.4) | $3314 / 1.02 (book alone $3552 / 1.03) |
| Hold-Out 40% | B stop-through flip (C only) | 1R | 531 | 44.8% | -$22.4 [-$44.1, -$1.0] | -$27.2 to -$3.5 (mean -$15.3) | -$6899 / 0.96 (book alone $4978 / 1.04) |
| Hold-Out 40% | B stop-through flip (C only) | 1.5R | 531 | 37.9% | -$21.5 [-$47.6, $4.1] | -$28.8 to -$1.9 (mean -$15.5) | -$6450 / 0.96 (book alone $4978 / 1.04) |
| Hold-Out 40% | B+C all stop-outs (supplement) | 1R | 714 | 46.9% | -$15.3 [-$34.1, $2.8] | -$24.7 to -$5.5 (mean -$15.1) | -$5913 / 0.97 (book alone $4978 / 1.04) |
| Hold-Out 40% | B+C all stop-outs (supplement) | 1.5R | 714 | 38.9% | -$15.6 [-$39.1, $8.9] | -$27.0 to -$3.7 (mean -$15.5) | -$6162 / 0.97 (book alone $4978 / 1.04) |
Counted test (Hold-Out) A bailout flip 1R: mean -$1.8 lower bound -$26.1 (needs > 0), placebo 95th pct $7.3 -> DOES NOT PASS (n=441)
Counted test (Hold-Out) A bailout flip 1.5R: mean -$0.5 lower bound -$32.2 (needs > 0), placebo 95th pct $10.5 -> DOES NOT PASS (n=441)
Counted test (Hold-Out) B stop-through flip (C only) 1R: mean -$22.4 lower bound -$44.1 (needs > 0), placebo 95th pct -$3.5 -> DOES NOT PASS (n=531)
Counted test (Hold-Out) B stop-through flip (C only) 1.5R: mean -$21.5 lower bound -$47.6 (needs > 0), placebo 95th pct -$1.9 -> DOES NOT PASS (n=531)
