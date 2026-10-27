# VbP + kinematics veto filter -- run output (population: BACKFILL RTH level fades; strategy SIMULATION, not an account record)
raw rows 6195; dropped {"roll":392,"sparse":1,"noDir":0,"noBar":83,"entryMismatch":123,"gap":272,"noFeat":0}; trades used 5324 on 336 dates 2023-11-16..2026-07-21
buckets: A 3183, B 312, C 1357, FLAT(time-expired, pnl 0) 472; baseline net $5381
LEVEL_MODE=entry. Degeneracy diagnostics: |entry - L| / ATR median 0.00, p75 0.00; Taper ratio exactly 1.000 (no volume in either slice) 9.6%; Doorstep density < 0.001 20.8%; RVWAP spread exactly 0 (30- and 60-bar windows identical, before ~10:00) 41.1%; dPOC migration exactly 0 34.8%

### Table 1 -- Feature distribution matrix (25th / median / 75th / mean) by bucket, Mann-Whitney A vs C (descriptive: trades are correlated within days)

| Feature | A p25 | A med | A p75 | A mean | B p25 | B med | B p75 | B mean | C p25 | C med | C p75 | C mean | med(A)-med(C) | MWU p (A vs C) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dPOC_Migration_30 | -0.049 | 0.000 | 0.416 | 0.315 | -0.062 | 0.000 | 0.504 | 0.229 | 0.000 | 0.000 | 0.503 | 0.438 | 0.000 | 0.0710 |
| Rolling_POC_Stretch_60 | 0.504 | 1.533 | 3.313 | 2.037 | 0.444 | 1.569 | 3.132 | 1.948 | 0.535 | 1.532 | 3.255 | 1.970 | 0.001 | 0.5318 |
| Doorstep_HVN_Density | 0.003 | 0.030 | 0.099 | 0.087 | 0.000 | 0.013 | 0.073 | 0.058 | 0.007 | 0.038 | 0.124 | 0.098 | -0.008 | <1e-4 |
| Approach_Vol_Taper_Ratio | 0.182 | 0.489 | 0.909 | 6.555 | 0.064 | 0.399 | 1.000 | 13.315 | 0.187 | 0.430 | 0.831 | 6.707 | 0.059 | 0.0800 |
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
| 1 | Approach_Vol_Taper_Ratio | Vol-by-Price | > | 1.000 | 12.5% | 10.7% | 1.17 |
| 2 | Doorstep_HVN_Density | Vol-by-Price | > | 0.198 | 16.8% | 15.0% | 1.12 |
| 3 | LRMA_Slope_Against | Kinematic | > | 0.251 | 16.3% | 15.0% | 1.09 |
| 4 | dPOC_Migration_30 | Vol-by-Price | > | 1.372 | 16.2% | 15.0% | 1.08 |
| 5 | RVWAP_Spread_Against | Kinematic | > | 1.516 | 15.2% | 15.0% | 1.01 |
| 6 | R_Squared_20 | Kinematic | > | 0.853 | 15.0% | 15.0% | 1.00 |
| 7 | LRMA_Stretch_Against | Kinematic | < | -0.243 | 13.9% | 15.0% | 0.93 |
| 8 | Rolling_POC_Stretch_60 | Vol-by-Price | < | 0.096 | 13.1% | 15.0% | 0.88 |
S_75 (75th percentile of Bucket A LRMA_Slope_Against) = 0.2025; Rule 4 picks (top 2 Vol-by-Price + top 1 Kinematic): Approach_Vol_Taper_Ratio, Doorstep_HVN_Density, LRMA_Slope_Against; per-feature A-kill share used 8.0%

### Table 4 -- Backtest performance comparison (FULL SAMPLE, in-sample: S_75, Table 3 cutoffs and Rule 4 were fit on these same trades)

| Rule | Total Trades | Win Rate % | Profit Factor | Net PnL ($) | Max Drawdown ($) | Avg Trade ($) / per-trade Sharpe | Steamrolls Blocked | Winners Killed |
|---|---|---|---|---|---|---|---|---|
| 0. Unfiltered Baseline | 5324 | 59.8% | 1.02 | $5381 | $24785 | $1 / 0.009 | 0 (0.0%) | 0 (0.0%) |
| 1. Rule 1 Only (Volume Profile Migration/HVN) | 3164 | 59.5% | 1.04 | $6609 | $16936 | $2 / 0.018 | 572 (42.2%) | 1299 (40.8%) |
| 2. Rule 2 Only (Approach Volume Taper) | 5259 | 59.9% | 1.02 | $6587 | $24203 | $1 / 0.011 | 26 (1.9%) | 32 (1.0%) |
| 3. Rule 3 Only (LRMA Grind vs. Spike) | 4327 | 60.0% | 1.04 | $9306 | $17033 | $2 / 0.018 | 266 (19.6%) | 586 (18.4%) |
| 4. Rules 1 + 2 + 3 Combined | 2427 | 59.5% | 1.07 | $8225 | $10489 | $3 / 0.029 | 760 (56.0%) | 1738 (54.6%) |
| 5. Rule 4 (Data-Driven Optimal Composite) | 4323 | 59.8% | 1.04 | $8932 | $22301 | $2 / 0.018 | 286 (21.1%) | 596 (18.7%) |

### Table 4a -- Does the veto remove BELOW-average trades? (FULL in-sample) vetoed avg minus all-trade avg, date-blocked 95% interval; random-veto placebo P(random subset avg <= vetoed avg)

| Rule | Vetoed n | Vetoed avg | All-trade avg | Diff | 95% interval of diff | Placebo P |
|---|---|---|---|---|---|---|
| 1. Rule 1 Only (Volume Profile Migration/HVN) | 2160 | -$1 | $1 | -$2 | [-$7, $4] | 0.268 |
| 2. Rule 2 Only (Approach Volume Taper) | 65 | -$19 | $1 | -$20 | [-$47, $8] | 0.093 |
| 3. Rule 3 Only (LRMA Grind vs. Spike) | 997 | -$4 | $1 | -$5 | [-$15, $5] | 0.096 |
| 4. Rules 1 + 2 + 3 Combined | 2897 | -$1 | $1 | -$2 | [-$6, $2] | 0.180 |
| 5. Rule 4 (Data-Driven Optimal Composite) | 1001 | -$4 | $1 | -$5 | [-$14, $5] | 0.114 |

### Table 4b -- HOLD-OUT: everything fitted on trade dates <= 2026-01-02 (3160 trades), applied to the later 2164 trades. Rule 4 picks on train: Approach_Vol_Taper_Ratio, Rolling_POC_Stretch_60, LRMA_Slope_Against; S_75(train) 0.1824

| Rule | Total Trades | Win Rate % | Profit Factor | Net PnL ($) | Max Drawdown ($) | Avg Trade ($) / per-trade Sharpe | Steamrolls Blocked | Winners Killed |
|---|---|---|---|---|---|---|---|---|
| 0. Unfiltered Baseline | 2164 | 63.5% | 1.04 | $4978 | $13133 | $2 / 0.019 | 0 (0.0%) | 0 (0.0%) |
| 1. Rule 1 Only (Volume Profile Migration/HVN) | 1262 | 61.9% | 1.01 | $423 | $6823 | $0 / 0.003 | 218 (41.1%) | 593 (43.2%) |
| 2. Rule 2 Only (Approach Volume Taper) | 2134 | 63.6% | 1.05 | $5456 | $13125 | $3 / 0.021 | 12 (2.3%) | 16 (1.2%) |
| 3. Rule 3 Only (LRMA Grind vs. Spike) | 1647 | 62.4% | 1.00 | -$391 | $11489 | -$0 / -0.002 | 110 (20.7%) | 346 (25.2%) |
| 4. Rules 1 + 2 + 3 Combined | 882 | 59.9% | 0.94 | -$2946 | $8756 | -$3 / -0.027 | 297 (55.9%) | 846 (61.6%) |
| 5. Rule 4 (Data-Driven Optimal Composite) | 1622 | 61.3% | 0.97 | -$2426 | $11755 | -$1 / -0.012 | 116 (21.8%) | 380 (27.7%) |

### Table 4a -- Does the veto remove BELOW-average trades? (HOLD-OUT) vetoed avg minus all-trade avg, date-blocked 95% interval; random-veto placebo P(random subset avg <= vetoed avg)

| Rule | Vetoed n | Vetoed avg | All-trade avg | Diff | 95% interval of diff | Placebo P |
|---|---|---|---|---|---|---|
| 1. Rule 1 Only (Volume Profile Migration/HVN) | 902 | $5 | $2 | $3 | [-$5, $11] | 0.747 |
| 2. Rule 2 Only (Approach Volume Taper) | 30 | -$16 | $2 | -$18 | [-$65, $23] | 0.203 |
| 3. Rule 3 Only (LRMA Grind vs. Spike) | 517 | $10 | $2 | $8 | [-$4, $21] | 0.919 |
| 4. Rules 1 + 2 + 3 Combined | 1282 | $6 | $2 | $4 | [-$2, $10] | 0.869 |
| 5. Rule 4 (Data-Driven Optimal Composite) | 542 | $14 | $2 | $11 | [-$1, $23] | 0.988 |

Train-fitted Table 3 (for stability against the full-sample one above):
| Rank | Feature | Cutoff | C blocked | A killed | Ratio |
|---|---|---|---|---|---|
| 1 | LRMA_Slope_Against | 0.232 | 19.1% | 15.0% | 1.28 |
| 2 | LRMA_Stretch_Against | -0.198 | 18.3% | 15.0% | 1.22 |
| 3 | R_Squared_20 | 0.841 | 17.8% | 14.9% | 1.20 |
| 4 | Approach_Vol_Taper_Ratio | 1.000 | 12.7% | 10.9% | 1.17 |
| 5 | Rolling_POC_Stretch_60 | 0.153 | 16.0% | 15.0% | 1.07 |
| 6 | dPOC_Migration_30 | 1.337 | 15.9% | 14.9% | 1.06 |
| 7 | RVWAP_Spread_Against | 1.489 | 14.0% | 15.0% | 0.94 |
| 8 | Doorstep_HVN_Density | 0.234 | 13.4% | 15.0% | 0.90 |

### Table 5 -- Breakout flip of the Rule-4-vetoed trades (FULL in-sample); vetoed 1001; baseline net $5381, PF 1.02, DD $24785; filtered fades only (no flips) net $8932, PF 1.04, DD $22301

| Entry | Exit | Flipped Trades | Breakout Win Rate | Breakout PF | Breakout Net PnL | Avg per flip | Random-subset flip avg (placebo) | Combined Net | Combined PF | Combined Max DD |
|---|---|---|---|---|---|---|---|---|---|---|
| at touch (spec) | 1R | 1001 | 50.7% | 0.69 | -$34488 | -$34 | $20 (p5 -$43, p95 $92) | -$25556 | 0.92 | $58270 |
| at touch (spec) | 1.5R | 1001 | 43.1% | 0.71 | -$35777 | -$36 | $19 (p5 -$49, p95 $111) | -$26844 | 0.92 | $56175 |
| at touch (spec) | 2R | 1001 | 39.3% | 0.71 | -$37640 | -$38 | $12 (p5 -$70, p95 $95) | -$28707 | 0.92 | $56429 |
| at touch (spec) | LRMA trail | 1001 | 44.1% | 0.43 | -$40834 | -$41 | $18 (p5 -$38, p95 $94) | -$31901 | 0.89 | $58735 |
| break-confirmed | 1R | 883 | 51.5% | 1.02 | $1371 | $2 | $0 (p5 -$7, p95 $9) | $10303 | 1.04 | $22035 |
| break-confirmed | 1.5R | 883 | 43.4% | 1.01 | $1111 | $1 | -$2 (p5 -$11, p95 $9) | $10043 | 1.03 | $20204 |
| break-confirmed | 2R | 883 | 39.8% | 1.03 | $2437 | $3 | -$3 (p5 -$15, p95 $7) | $11370 | 1.04 | $20060 |
| break-confirmed | LRMA trail | 883 | 42.8% | 0.93 | -$1811 | -$2 | $0 (p5 -$4, p95 $4) | $7122 | 1.03 | $22924 |

### Table 5 -- Breakout flip of the Rule-4-vetoed trades (HOLD-OUT, train-fitted Rule 4); vetoed 542; baseline net $4978, PF 1.04, DD $13133; filtered fades only (no flips) net -$2426, PF 0.97, DD $11755

| Entry | Exit | Flipped Trades | Breakout Win Rate | Breakout PF | Breakout Net PnL | Avg per flip | Random-subset flip avg (placebo) | Combined Net | Combined PF | Combined Max DD |
|---|---|---|---|---|---|---|---|---|---|---|
| at touch (spec) | 1R | 542 | 45.9% | 0.84 | -$7419 | -$14 | -$2 (p5 -$16, p95 $9) | -$9844 | 0.93 | $16602 |
| at touch (spec) | 1.5R | 542 | 37.1% | 0.85 | -$8461 | -$16 | -$2 (p5 -$16, p95 $12) | -$10886 | 0.93 | $19264 |
| at touch (spec) | 2R | 542 | 33.4% | 0.87 | -$7287 | -$13 | -$2 (p5 -$15, p95 $11) | -$9712 | 0.94 | $17810 |
| at touch (spec) | LRMA trail | 542 | 39.5% | 0.69 | -$8316 | -$15 | -$3 (p5 -$9, p95 $4) | -$10742 | 0.91 | $17601 |
| break-confirmed | 1R | 472 | 49.4% | 0.96 | -$1537 | -$3 | -$1 (p5 -$15, p95 $14) | -$3962 | 0.97 | $16472 |
| break-confirmed | 1.5R | 472 | 40.5% | 0.97 | -$1183 | -$3 | $1 (p5 -$15, p95 $14) | -$3609 | 0.97 | $17693 |
| break-confirmed | 2R | 472 | 36.2% | 1.02 | $726 | $2 | -$1 (p5 -$16, p95 $11) | -$1700 | 0.99 | $15682 |
| break-confirmed | LRMA trail | 472 | 45.8% | 1.06 | $988 | $2 | $0 (p5 -$6, p95 $7) | -$1438 | 0.99 | $13386 |
