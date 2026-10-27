# VbP + kinematics veto filter -- run output (population: BACKFILL RTH level fades; strategy SIMULATION, not an account record)
raw rows 6195; dropped {"roll":392,"sparse":1,"noDir":0,"noBar":83,"entryMismatch":123,"gap":272,"noFeat":0}; trades used 5324 on 336 dates 2023-11-16..2026-07-21
buckets: A 3183, B 312, C 1357, FLAT(time-expired, pnl 0) 472; baseline net $5381

### Table 1 -- Feature distribution matrix (25th / median / 75th / mean) by bucket, Mann-Whitney A vs C (descriptive: trades are correlated within days)

| Feature | A p25 | A med | A p75 | A mean | B p25 | B med | B p75 | B mean | C p25 | C med | C p75 | C mean | med(A)-med(C) | MWU p (A vs C) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dPOC_Migration_30 | -0.049 | 0.000 | 0.416 | 0.315 | -0.062 | 0.000 | 0.504 | 0.229 | 0.000 | 0.000 | 0.503 | 0.438 | 0.000 | 0.0710 |
| Rolling_POC_Stretch_60 | 0.504 | 1.533 | 3.313 | 2.037 | 0.444 | 1.569 | 3.132 | 1.948 | 0.535 | 1.532 | 3.255 | 1.970 | 0.001 | 0.5318 |
| Doorstep_HVN_Density | 0.000 | 0.007 | 0.055 | 0.056 | 0.000 | 0.004 | 0.049 | 0.049 | 0.000 | 0.011 | 0.070 | 0.064 | -0.004 | 0.0152 |
| Approach_Vol_Taper_Ratio | 0.031 | 0.462 | 1.000 | 7.896 | 0.037 | 0.379 | 1.000 | 0.498 | 0.008 | 0.361 | 1.000 | 5.389 | 0.102 | <1e-4 |
| RVWAP_Spread_Against | 0.000 | 0.000 | 0.945 | 0.468 | 0.000 | 0.000 | 0.802 | 0.428 | 0.000 | 0.000 | 0.960 | 0.463 | 0.000 | 0.6475 |
| LRMA_Slope_Against | 0.028 | 0.110 | 0.203 | 0.111 | 0.038 | 0.133 | 0.218 | 0.125 | 0.034 | 0.121 | 0.206 | 0.120 | -0.012 | 0.0784 |
| R_Squared_20 | 0.196 | 0.541 | 0.776 | 0.493 | 0.243 | 0.575 | 0.795 | 0.506 | 0.198 | 0.570 | 0.776 | 0.502 | -0.029 | 0.4943 |
| LRMA_Stretch_Against | -0.061 | 0.345 | 0.812 | 0.400 | -0.201 | 0.246 | 0.878 | 0.352 | -0.043 | 0.312 | 0.831 | 0.397 | 0.032 | 0.8015 |
(valid counts: dPOC_Migration_30 A 2768/3183, C 1147/1357; the others are defined for all trades)

### Table 2 -- Time-of-day steamroll breakdown

| Window | Trades | A (winners) | A % | C (steamrolls) | C % | Baseline PF |
|---|---|---|---|---|---|---|
| 09:30-10:30 | 2856 | 1731 | 60.6% | 798 | 27.9% | 0.94 |
| 10:30-13:30 | 1996 | 1220 | 61.1% | 492 | 24.6% | 1.11 |
| 13:30-16:00 | 472 | 232 | 49.2% | 67 | 14.2% | 1.44 |

### Table 3 -- Constrained single-feature sweep (cutoff that blocks the most steamrolls (C) while killing <= 15% of winners (A)); ranked by blocked%/killed%. A random feature scores about 1.0.

| Rank | Feature | Group | Veto when | Cutoff | Steamrolls blocked % | Winners sacrificed % | Ratio |
|---|---|---|---|---|---|---|---|
| 1 | Doorstep_HVN_Density | Vol-by-Price | > | 0.138 | 16.4% | 15.0% | 1.09 |
| 2 | LRMA_Slope_Against | Kinematic | > | 0.251 | 16.3% | 15.0% | 1.09 |
| 3 | dPOC_Migration_30 | Vol-by-Price | > | 1.372 | 16.2% | 15.0% | 1.08 |
| 4 | Approach_Vol_Taper_Ratio | Vol-by-Price | > | 1.000 | 6.1% | 5.9% | 1.04 |
| 5 | RVWAP_Spread_Against | Kinematic | > | 1.516 | 15.2% | 15.0% | 1.01 |
| 6 | R_Squared_20 | Kinematic | > | 0.853 | 15.0% | 15.0% | 1.00 |
| 7 | LRMA_Stretch_Against | Kinematic | < | -0.243 | 13.9% | 15.0% | 0.93 |
| 8 | Rolling_POC_Stretch_60 | Vol-by-Price | < | 0.096 | 13.1% | 15.0% | 0.88 |
S_75 (75th percentile of Bucket A LRMA_Slope_Against) = 0.2025; Rule 4 picks (top 2 Vol-by-Price + top 1 Kinematic): Doorstep_HVN_Density, dPOC_Migration_30, LRMA_Slope_Against; per-feature A-kill share used 7.0%

### Table 4 -- Backtest performance comparison (FULL SAMPLE, in-sample: S_75, Table 3 cutoffs and Rule 4 were fit on these same trades)

| Rule | Total Trades | Win Rate % | Profit Factor | Net PnL ($) | Max Drawdown ($) | Avg Trade ($) / per-trade Sharpe | Steamrolls Blocked | Winners Killed |
|---|---|---|---|---|---|---|---|---|
| 0. Unfiltered Baseline | 5324 | 59.8% | 1.02 | $5381 | $24785 | $1 / 0.009 | 0 (0.0%) | 0 (0.0%) |
| 1. Rule 1 Only (Volume Profile Migration/HVN) | 3209 | 59.6% | 1.04 | $6232 | $16652 | $2 / 0.017 | 557 (41.0%) | 1272 (40.0%) |
| 2. Rule 2 Only (Approach Volume Taper) | 5301 | 59.9% | 1.02 | $6322 | $24258 | $1 / 0.010 | 13 (1.0%) | 10 (0.3%) |
| 3. Rule 3 Only (LRMA Grind vs. Spike) | 4327 | 60.0% | 1.04 | $9306 | $17033 | $2 / 0.018 | 266 (19.6%) | 586 (18.4%) |
| 4. Rules 1 + 2 + 3 Combined | 2483 | 59.6% | 1.07 | $7959 | $10830 | $3 / 0.028 | 744 (54.8%) | 1704 (53.5%) |
| 5. Rule 4 (Data-Driven Optimal Composite) | 4301 | 60.0% | 1.04 | $7958 | $22017 | $2 / 0.016 | 282 (20.8%) | 604 (19.0%) |

### Table 4a -- Does the veto remove BELOW-average trades? (FULL in-sample) vetoed avg minus all-trade avg, date-blocked 95% interval; random-veto placebo P(random subset avg <= vetoed avg)

| Rule | Vetoed n | Vetoed avg | All-trade avg | Diff | 95% interval of diff | Placebo P |
|---|---|---|---|---|---|---|
| 1. Rule 1 Only (Volume Profile Migration/HVN) | 2115 | -$0 | $1 | -$1 | [-$7, $4] | 0.284 |
| 2. Rule 2 Only (Approach Volume Taper) | 23 | -$41 | $1 | -$42 | [-$85, $2] | 0.045 |
| 3. Rule 3 Only (LRMA Grind vs. Spike) | 997 | -$4 | $1 | -$5 | [-$15, $5] | 0.096 |
| 4. Rules 1 + 2 + 3 Combined | 2841 | -$1 | $1 | -$2 | [-$6, $2] | 0.196 |
| 5. Rule 4 (Data-Driven Optimal Composite) | 1023 | -$3 | $1 | -$4 | [-$13, $6] | 0.169 |

### Table 4b -- HOLD-OUT: everything fitted on trade dates <= 2026-01-02 (3160 trades), applied to the later 2164 trades. Rule 4 picks on train: Rolling_POC_Stretch_60, dPOC_Migration_30, LRMA_Slope_Against; S_75(train) 0.1824

| Rule | Total Trades | Win Rate % | Profit Factor | Net PnL ($) | Max Drawdown ($) | Avg Trade ($) / per-trade Sharpe | Steamrolls Blocked | Winners Killed |
|---|---|---|---|---|---|---|---|---|
| 0. Unfiltered Baseline | 2164 | 63.5% | 1.04 | $4978 | $13133 | $2 / 0.019 | 0 (0.0%) | 0 (0.0%) |
| 1. Rule 1 Only (Volume Profile Migration/HVN) | 1265 | 62.0% | 1.01 | $765 | $6913 | $1 / 0.005 | 218 (41.1%) | 590 (42.9%) |
| 2. Rule 2 Only (Approach Volume Taper) | 2154 | 63.5% | 1.04 | $5018 | $13134 | $2 / 0.019 | 4 (0.8%) | 6 (0.4%) |
| 3. Rule 3 Only (LRMA Grind vs. Spike) | 1647 | 62.4% | 1.00 | -$391 | $11489 | -$0 / -0.002 | 110 (20.7%) | 346 (25.2%) |
| 4. Rules 1 + 2 + 3 Combined | 896 | 59.9% | 0.95 | -$2778 | $8512 | -$3 / -0.025 | 293 (55.2%) | 837 (60.9%) |
| 5. Rule 4 (Data-Driven Optimal Composite) | 1630 | 63.1% | 1.04 | $3694 | $10107 | $2 / 0.018 | 137 (25.8%) | 345 (25.1%) |

### Table 4a -- Does the veto remove BELOW-average trades? (HOLD-OUT) vetoed avg minus all-trade avg, date-blocked 95% interval; random-veto placebo P(random subset avg <= vetoed avg)

| Rule | Vetoed n | Vetoed avg | All-trade avg | Diff | 95% interval of diff | Placebo P |
|---|---|---|---|---|---|---|
| 1. Rule 1 Only (Volume Profile Migration/HVN) | 899 | $5 | $2 | $2 | [-$6, $11] | 0.707 |
| 2. Rule 2 Only (Approach Volume Taper) | 10 | -$4 | $2 | -$6 | [-$85, $59] | 0.414 |
| 3. Rule 3 Only (LRMA Grind vs. Spike) | 517 | $10 | $2 | $8 | [-$4, $21] | 0.919 |
| 4. Rules 1 + 2 + 3 Combined | 1268 | $6 | $2 | $4 | [-$2, $10] | 0.869 |
| 5. Rule 4 (Data-Driven Optimal Composite) | 534 | $2 | $2 | $0 | [-$14, $14] | 0.513 |

Train-fitted Table 3 (for stability against the full-sample one above):
| Rank | Feature | Cutoff | C blocked | A killed | Ratio |
|---|---|---|---|---|---|
| 1 | LRMA_Slope_Against | 0.232 | 19.1% | 15.0% | 1.28 |
| 2 | LRMA_Stretch_Against | -0.198 | 18.3% | 15.0% | 1.22 |
| 3 | R_Squared_20 | 0.841 | 17.8% | 14.9% | 1.20 |
| 4 | Rolling_POC_Stretch_60 | 0.153 | 16.0% | 15.0% | 1.07 |
| 5 | dPOC_Migration_30 | 1.337 | 15.9% | 14.9% | 1.06 |
| 6 | Approach_Vol_Taper_Ratio | 1.000 | 6.3% | 6.0% | 1.04 |
| 7 | Doorstep_HVN_Density | 0.141 | 15.1% | 15.0% | 1.01 |
| 8 | RVWAP_Spread_Against | 1.489 | 14.0% | 15.0% | 0.94 |

### Table 5 -- Breakout flip of the Rule-4-vetoed trades (FULL in-sample); vetoed 1023; baseline net $5381, PF 1.02, DD $24785; filtered fades only (no flips) net $7958, PF 1.04, DD $22017

| Entry | Exit | Flipped Trades | Breakout Win Rate | Breakout PF | Breakout Net PnL | Avg per flip | Random-subset flip avg (placebo) | Combined Net | Combined PF | Combined Max DD |
|---|---|---|---|---|---|---|---|---|---|---|
| at touch (spec) | 1R | 1023 | 52.5% | 1.14 | $15858 | $16 | $20 (p5 -$58, p95 $92) | $23816 | 1.07 | $57095 |
| at touch (spec) | 1.5R | 1023 | 45.4% | 1.12 | $15187 | $15 | $20 (p5 -$48, p95 $100) | $23145 | 1.07 | $54623 |
| at touch (spec) | 2R | 1023 | 42.0% | 1.11 | $14027 | $14 | $12 (p5 -$70, p95 $94) | $21985 | 1.06 | $55896 |
| at touch (spec) | LRMA trail | 1023 | 45.1% | 1.11 | $7959 | $8 | $17 (p5 -$38, p95 $92) | $15917 | 1.06 | $57304 |
| break-confirmed | 1R | 845 | 52.5% | 1.07 | $4749 | $6 | $3 (p5 -$6, p95 $12) | $12707 | 1.05 | $20298 |
| break-confirmed | 1.5R | 845 | 43.4% | 1.02 | $1664 | $2 | $0 (p5 -$9, p95 $11) | $9622 | 1.03 | $19955 |
| break-confirmed | 2R | 845 | 40.4% | 1.03 | $2574 | $3 | -$1 (p5 -$14, p95 $11) | $10532 | 1.04 | $19565 |
| break-confirmed | LRMA trail | 845 | 43.3% | 0.98 | -$633 | -$1 | -$0 (p5 -$5, p95 $4) | $7325 | 1.03 | $21047 |

### Table 5 -- Breakout flip of the Rule-4-vetoed trades (HOLD-OUT, train-fitted Rule 4); vetoed 534; baseline net $4978, PF 1.04, DD $13133; filtered fades only (no flips) net $3694, PF 1.04, DD $10107

| Entry | Exit | Flipped Trades | Breakout Win Rate | Breakout PF | Breakout Net PnL | Avg per flip | Random-subset flip avg (placebo) | Combined Net | Combined PF | Combined Max DD |
|---|---|---|---|---|---|---|---|---|---|---|
| at touch (spec) | 1R | 534 | 49.4% | 0.99 | -$235 | -$0 | -$2 (p5 -$17, p95 $8) | $3460 | 1.03 | $9856 |
| at touch (spec) | 1.5R | 534 | 40.1% | 0.94 | -$2794 | -$5 | -$2 (p5 -$15, p95 $12) | $900 | 1.01 | $10867 |
| at touch (spec) | 2R | 534 | 36.5% | 0.99 | -$607 | -$1 | -$2 (p5 -$15, p95 $12) | $3088 | 1.02 | $11439 |
| at touch (spec) | LRMA trail | 534 | 44.4% | 0.86 | -$2906 | -$5 | -$3 (p5 -$11, p95 $4) | $789 | 1.01 | $11149 |
| break-confirmed | 1R | 446 | 51.1% | 1.05 | $1795 | $4 | $2 (p5 -$15, p95 $17) | $5489 | 1.04 | $9774 |
| break-confirmed | 1.5R | 446 | 40.1% | 0.97 | -$1208 | -$3 | $4 (p5 -$13, p95 $17) | $2486 | 1.02 | $13617 |
| break-confirmed | 2R | 446 | 35.2% | 0.97 | -$1546 | -$3 | $2 (p5 -$12, p95 $17) | $2149 | 1.02 | $13952 |
| break-confirmed | LRMA trail | 446 | 43.9% | 0.98 | -$238 | -$1 | -$0 (p5 -$7, p95 $7) | $3456 | 1.03 | $11415 |
