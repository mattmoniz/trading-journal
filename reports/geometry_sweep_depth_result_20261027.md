# Geometry / sweep-depth study -- run output. Mode 1 book 1723 trades (expected 1723); Hold-Out DD of the stored P&L $2357 (expected $2357); Train 926, Hold-Out 797; buckets A 1064 B 104 C 444

### Table 1 -- Post-stop path of stop-outs in the Mode 1 book (bars strictly after t_exit, capped at 15:59; R = multiples of the stop distance). Reversion = travel back in the fade's favor from Stop_Price; Continuation = further travel against it.

| Sample | Bucket | Post-stop window | n | Continuation_R p25 / med / p75 / mean | Reversion_R p25 / med / p75 / mean | % back to Entry | % back to Target |
|---|---|---|---|---|---|---|---|
| Train 60% | Bucket C | 5m | 239 | 0.05 / 0.18 / 0.36 / 0.30 | 0.09 / 0.25 / 0.48 / 0.33 | 2.9% | 1.3% |
| Train 60% | Bucket C | 15m | 239 | 0.14 / 0.33 / 0.59 / 0.48 | 0.16 / 0.34 / 0.66 / 0.46 | 10.0% | 2.9% |
| Train 60% | Bucket C | 30m | 239 | 0.17 / 0.45 / 0.84 / 0.66 | 0.22 / 0.45 / 0.81 / 0.61 | 17.2% | 8.4% |
| Train 60% | Bucket B | 5m | 39 | 0.15 / 0.29 / 0.48 / 0.34 | 0.19 / 0.37 / 0.54 / 0.40 | 2.6% | 0.0% |
| Train 60% | Bucket B | 15m | 39 | 0.27 / 0.43 / 0.67 / 0.61 | 0.31 / 0.57 / 1.00 / 0.78 | 25.6% | 20.5% |
| Train 60% | Bucket B | 30m | 39 | 0.38 / 0.54 / 1.13 / 0.93 | 0.32 / 0.73 / 1.24 / 1.01 | 30.8% | 20.5% |
| Hold-Out 40% | Bucket C | 5m | 204 | 0.08 / 0.21 / 0.43 / 0.31 | 0.12 / 0.29 / 0.59 / 0.42 | 9.3% | 2.0% |
| Hold-Out 40% | Bucket C | 15m | 204 | 0.13 / 0.35 / 0.82 / 0.53 | 0.23 / 0.51 / 0.95 / 0.66 | 23.0% | 10.3% |
| Hold-Out 40% | Bucket C | 30m | 204 | 0.22 / 0.51 / 1.04 / 0.74 | 0.29 / 0.66 / 1.20 / 0.86 | 32.4% | 15.7% |
| Hold-Out 40% | Bucket B | 5m | 64 | 0.21 / 0.39 / 0.86 / 0.65 | 0.19 / 0.39 / 0.68 / 0.52 | 15.6% | 3.1% |
| Hold-Out 40% | Bucket B | 15m | 64 | 0.35 / 0.64 / 1.31 / 1.13 | 0.30 / 0.66 / 1.05 / 0.79 | 28.1% | 14.1% |
| Hold-Out 40% | Bucket B | 30m | 64 | 0.38 / 0.85 / 1.57 / 1.33 | 0.39 / 0.79 / 1.45 / 1.01 | 37.5% | 18.8% |

### Table 1b -- Bucket C excess over the random-time placebo (same clock +/-30 min on other dates, same direction and stop distance; 30 draws per trade); date-blocked 95% intervals

| Sample | Window | n | Placebo % reaching the entry distance | Excess % back to Entry [95% CI] | Excess % back to Target [95% CI] | Excess (Reversion_R - Continuation_R) [95% CI] |
|---|---|---|---|---|---|---|
| Train 60% | 5m | 239 | 2.9% (mean cont 0.26R, rev 0.26R) | 0.1% [-2.0%, 2.4%] | 0.6% [-0.7%, 2.2%] | 0.03R [-0.03, 0.10] |
| Train 60% | 15m | 239 | 10.3% (mean cont 0.44R, rev 0.43R) | -0.3% [-4.5%, 4.1%] | -0.2% [-2.2%, 2.0%] | -0.01R [-0.11, 0.08] |
| Train 60% | 30m | 239 | 17.7% (mean cont 0.61R, rev 0.59R) | -0.5% [-5.3%, 4.7%] | 1.0% [-2.5%, 4.9%] | -0.03R [-0.16, 0.10] |
| Hold-Out 40% | 5m | 204 | 3.3% (mean cont 0.26R, rev 0.28R) | 6.0% [2.1%, 10.2%] | 1.3% [-0.3%, 3.3%] | 0.08R [0.01, 0.15] |
| Hold-Out 40% | 15m | 204 | 11.4% (mean cont 0.44R, rev 0.45R) | 11.6% [5.7%, 17.5%] | 6.4% [2.1%, 11.1%] | 0.12R [0.01, 0.23] |
| Hold-Out 40% | 30m | 204 | 18.4% (mean cont 0.61R, rev 0.61R) | 14.0% [7.8%, 20.0%] | 7.7% [2.6%, 12.9%] | 0.12R [-0.02, 0.26] |

### Table 2 -- Entry-depth variants on the Mode 1 book. Primary engine marks unresolved trades to the 15:59 close; "flat-0 mean" is the stored baseline convention (unresolved = 0 dollars). Mean at $4 = gross - $4 per filled trade.


**Train 60%** (926 trades)
| Row | Filled / Mode 1 trades (fill rate) | Win rate (filled) | Profit factor | Mean PnL per filled trade [95% CI] | Mean at $4 fee+slippage [95% CI] | Flat-0 mean | Total net ($) | Max DD ($) |
|---|---|---|---|---|---|---|---|---|
| Stored baseline (flat-0 expiry) | 926 / 926 (100.0%) | 59.8% | 1.05 | $2.3 [-$4.9, $9.6] | -$0.8 [-$7.5, $6.0] | $2.3 | $2128 | $4223 |
| Control: baseline re-simulated, same engine | 926 / 926 (100.0%) | 63.0% | 0.98 | -$0.9 [-$8.0, $6.3] | -$3.9 [-$11.4, $3.0] | $2.0 | -$876 | $4624 |
| V1a at-level limit, target PRICE fixed | 734 / 926 (79.3%) | 58.0% | 0.92 | -$4.7 [-$13.8, $4.0] | -$7.7 [-$16.7, $1.5] | -$2.1 | -$3420 | $6507 |
| V1b at-level limit, target DISTANCE fixed | 734 / 926 (79.3%) | 62.3% | 0.97 | -$1.8 [-$10.2, $6.8] | -$4.8 [-$13.1, $3.5] | $0.8 | -$1304 | $4904 |
| V2 mid-sweep limit (half stop distance) | 316 / 926 (34.1%) | 32.9% | 0.97 | -$1.4 [-$15.1, $12.4] | -$4.4 [-$18.3, $9.5] | -$3.8 | -$446 | $4067 |
| V3 second mouse 1.0R | 119 / 926 (12.9%) | 50.4% | 1.02 | $1.5 [-$26.7, $31.7] | -$1.5 [-$30.8, $27.5] | $2.1 | $183 | $2579 |
| V3 second mouse 1.5R | 119 / 926 (12.9%) | 44.5% | 1.14 | $11.0 [-$21.9, $46.3] | $8.0 [-$24.7, $41.6] | $6.3 | $1307 | $2609 |

Missed-fill accounting and mirrored placebo (Train 60%): control P&L split into the trades the variant fills vs the ones it misses (a missed trade earns 0 in the variant)
| Variant | Filled | Control PnL on the SAME filled trades | Variant PnL on them | Control PnL on the trades the variant MISSES | Variant book total (missed = 0) | Control book total | Mirrored-geometry placebo |
|---|---|---|---|---|---|---|---|
| V1a at-level limit, target PRICE fixed | 734 | -$11296 | -$3420 | $10420 | -$3420 | -$876 | 80.1% fill, mean -$14.0, mean@$4 -$17.0, PF 0.78, net -$10365 |
| V1b at-level limit, target DISTANCE fixed | 734 | -$11296 | -$1304 | $10420 | -$1304 | -$876 | 80.1% fill, mean -$12.3, mean@$4 -$15.3, PF 0.79, net -$9147 |
| V2 mid-sweep limit (half stop distance) | 316 | -$20352 | -$446 | $19477 | -$446 | -$876 | 34.8% fill, mean -$4.4, mean@$4 -$7.4, PF 0.91, net -$1421 |
| V3 second mouse 1.0R | 119 | -$14773 | $183 | $13898 | $183 | -$876 | 10.5% fill, mean -$16.4, mean@$4 -$19.4, PF 0.80, net -$1587 |
| V3 second mouse 1.5R | 119 | -$14773 | $1307 | $13898 | $1307 | -$876 | 10.5% fill, mean -$21.8, mean@$4 -$24.8, PF 0.77, net -$2119 |

**Hold-Out 40%** (797 trades)
| Row | Filled / Mode 1 trades (fill rate) | Win rate (filled) | Profit factor | Mean PnL per filled trade [95% CI] | Mean at $4 fee+slippage [95% CI] | Flat-0 mean | Total net ($) | Max DD ($) |
|---|---|---|---|---|---|---|---|---|
| Stored baseline (flat-0 expiry) | 797 / 797 (100.0%) | 64.0% | 1.05 | $2.6 [-$6.3, $11.0] | -$0.4 [-$8.8, $7.9] | $2.6 | $2075 | $2357 |
| Control: baseline re-simulated, same engine | 797 / 797 (100.0%) | 64.2% | 0.99 | -$0.4 [-$8.7, $7.8] | -$3.4 [-$11.9, $5.1] | -$0.1 | -$281 | $3073 |
| V1a at-level limit, target PRICE fixed | 706 / 797 (88.6%) | 60.2% | 0.99 | -$0.6 [-$10.2, $9.1] | -$3.6 [-$13.6, $5.8] | -$0.2 | -$450 | $3953 |
| V1b at-level limit, target DISTANCE fixed | 706 / 797 (88.6%) | 64.2% | 1.03 | $1.6 [-$7.5, $10.7] | -$1.4 [-$10.2, $7.9] | $1.9 | $1127 | $2662 |
| V2 mid-sweep limit (half stop distance) | 416 / 797 (52.2%) | 31.7% | 0.98 | -$1.3 [-$11.9, $9.4] | -$4.3 [-$15.2, $6.9] | -$1.5 | -$529 | $2573 |
| V3 second mouse 1.0R | 203 / 797 (25.5%) | 48.8% | 0.97 | -$2.1 [-$25.0, $20.5] | -$5.1 [-$27.6, $16.2] | -$1.7 | -$425 | $2903 |
| V3 second mouse 1.5R | 203 / 797 (25.5%) | 36.9% | 0.90 | -$9.5 [-$33.8, $15.2] | -$12.5 [-$37.1, $11.2] | -$11.3 | -$1921 | $3212 |

Missed-fill accounting and mirrored placebo (Hold-Out 40%): control P&L split into the trades the variant fills vs the ones it misses (a missed trade earns 0 in the variant)
| Variant | Filled | Control PnL on the SAME filled trades | Variant PnL on them | Control PnL on the trades the variant MISSES | Variant book total (missed = 0) | Control book total | Mirrored-geometry placebo |
|---|---|---|---|---|---|---|---|
| V1a at-level limit, target PRICE fixed | 706 | -$6735 | -$450 | $6454 | -$450 | -$281 | 88.3% fill, mean -$6.3, mean@$4 -$9.3, PF 0.90, net -$4442 |
| V1b at-level limit, target DISTANCE fixed | 706 | -$6735 | $1127 | $6454 | $1127 | -$281 | 88.3% fill, mean -$4.6, mean@$4 -$7.6, PF 0.92, net -$3260 |
| V2 mid-sweep limit (half stop distance) | 416 | -$22151 | -$529 | $21870 | -$529 | -$281 | 50.2% fill, mean -$7.5, mean@$4 -$10.5, PF 0.87, net -$2990 |
| V3 second mouse 1.0R | 203 | -$21565 | -$425 | $21284 | -$425 | -$281 | 25.3% fill, mean $20.1, mean@$4 $17.1, PF 1.31, net $4065 |
| V3 second mouse 1.5R | 203 | -$21565 | -$1921 | $21284 | -$1921 | -$281 | 25.3% fill, mean $26.5, mean@$4 $23.5, PF 1.34, net $5344 |
Counted test (Hold-Out) V1a at-level limit, target PRICE fixed: mean@$4 -$3.6 lower bound -$13.6 (needs > 0); mirrored placebo mean@$4 -$9.3; variant total net -$450 (missed trades earn 0) vs control -$281 (needs higher) -> DOES NOT PASS
Counted test (Hold-Out) V1b at-level limit, target DISTANCE fixed: mean@$4 -$1.4 lower bound -$10.2 (needs > 0); mirrored placebo mean@$4 -$7.6; variant total net $1127 (missed trades earn 0) vs control -$281 (needs higher) -> DOES NOT PASS
Counted test (Hold-Out) V2 mid-sweep limit (half stop distance): mean@$4 -$4.3 lower bound -$15.2 (needs > 0); mirrored placebo mean@$4 -$10.5; variant total net -$529 (missed trades earn 0) vs control -$281 (needs higher) -> DOES NOT PASS
Counted test (Hold-Out) V3 second mouse 1.0R: mean@$4 -$5.1 lower bound -$27.6 (needs > 0); mirrored placebo mean@$4 $17.1; variant total net -$425 (missed trades earn 0) vs control -$281 (needs higher) -> DOES NOT PASS
Counted test (Hold-Out) V3 second mouse 1.5R: mean@$4 -$12.5 lower bound -$37.1 (needs > 0); mirrored placebo mean@$4 $23.5; variant total net -$1921 (missed trades earn 0) vs control -$281 (needs higher) -> DOES NOT PASS

### Table 3 -- Stop-width x target-scale sweep on the Control geometry (stop = S x SD, target = T x TD from the baseline trigger). Fit on Train by mean PnL at the $4 fee; only the frozen cell counts. Mirrored = same distances, direction reversed.

| S (stop x) | T (target x) | Train mean / @$4 / PF / net / DD | Hold-Out mean / @$4 / PF / net / DD | Hold-Out win rate | Hold-Out flat-0 mean | Mirrored placebo Hold-Out mean@$4 |
|---|---|---|---|---|---|---|
| 1 (control) | 1 | -$0.9 / -$3.9 / 0.98 / -$876 / $4624 | -$0.4 / -$3.4 / 0.99 / -$281 / $3073 | 64.2% | -$0.1 | -$12.3 |
| 1.25 | 1 | -$2.3 / -$5.3 / 0.96 / -$2175 / $5985 | $2.3 / -$0.7 / 1.04 / $1853 / $3112 | 69.3% | $3.8 | -$9.7 |
| 1.25 | 1.25 | $0.1 / -$2.9 / 1.00 / $99 / $5027 | $1.5 / -$1.5 / 1.02 / $1156 / $3668 | 64.1% | $3.4 | -$11.2 |
| 1.25 | 1.5 | $0.3 / -$2.7 / 1.00 / $276 / $6446 | $1.2 / -$1.8 / 1.02 / $952 / $4908 | 60.2% | $2.9 | -$11.5 |
| 1.5 | 1 | -$0.5 / -$3.5 / 0.99 / -$499 / $7080 | $5.2 / $2.2 / 1.09 / $4119 / $2776 | 73.0% | $8.4 | -$7.8 |
| 1.5 | 1.25 | $2.6 / -$0.4 / 1.04 / $2400 / $6098 | $5.4 / $2.4 / 1.08 / $4324 / $3636 | 68.3% | $9.4 | -$9.9 |
| 1.5 | 1.5 | $3.2 / $0.2 / 1.05 / $2938 / $7169 | $5.6 / $2.6 / 1.07 / $4432 / $4007 | 64.6% | $9.5 | -$9.7 |
| 2 | 1 | $1.4 / -$1.6 / 1.03 / $1316 / $8384 | $1.9 / -$1.1 / 1.03 / $1495 / $3816 | 75.8% | $8.8 | -$8.4 |
| 2 | 1.25 | $3.5 / $0.5 / 1.06 / $3224 / $7651 | $1.9 / -$1.1 / 1.03 / $1499 / $4473 | 71.3% | $9.6 | -$10.7 |
| 2 * | 1.5 | $3.8 / $0.8 / 1.05 / $3476 / $9060 | -$0.4 / -$3.4 / 1.00 / -$316 / $5973 | 67.4% | $8.1 | -$12.3 |
Frozen Train-best cell: S=2, T=1.5. Hold-Out: mean -$0.4 [-$15.0, $13.0], mean@$4 -$3.4 [-$17.8, $10.1]; control Hold-Out mean@$4 -$3.4; mirrored -$12.3 -> DOES NOT PASS

### Table 4 -- Live/recorded roster (outside the simulation): raw vs primary-only vs Mode 1 deduplicated (no overlapping open same-direction row per trade date). Model P&L (actual_pnl); realized-curve drawdown ordered by resolved_at.

live rows with a P&L, direction and both timestamps: 10573 (ACTIVE 1402, SHADOW 9171); dates 2026-07-09 to 2026-10-27
| Scope | Book | Version | Rows | Net ($) | Mean/trade ($) | Max DD ($) | PF | Duplicates removed |
|---|---|---|---|---|---|---|---|---|
| all sessions | ACTIVE (live-visible) | raw (every row) | 1402 | -$2639 | -$1.9 | $8096 | 0.95 | - |
| all sessions | ACTIVE (live-visible) | primary-only (is_cluster_primary) | 1179 | -$2768 | -$2.3 | $8309 | 0.94 | 223 sibling rows |
| all sessions | ACTIVE (live-visible) | Mode 1 on raw | 796 | -$942 | -$1.2 | $4804 | 0.97 | 606 stacked (43.2%) |
| all sessions | ACTIVE (live-visible) | Mode 1 on primary-only | 778 | -$1189 | -$1.5 | $5070 | 0.96 | 401 stacked beyond primary (34.0%) |
| all sessions | ACTIVE excluding POC_ROTATION_JOIN | raw (every row) | 1378 | -$1511 | -$1.1 | $7134 | 0.97 | - |
| all sessions | ACTIVE excluding POC_ROTATION_JOIN | primary-only (is_cluster_primary) | 1155 | -$1640 | -$1.4 | $7180 | 0.96 | 223 sibling rows |
| all sessions | ACTIVE excluding POC_ROTATION_JOIN | Mode 1 on raw | 788 | -$547 | -$0.7 | $4523 | 0.98 | 590 stacked (42.8%) |
| all sessions | ACTIVE excluding POC_ROTATION_JOIN | Mode 1 on primary-only | 772 | -$727 | -$0.9 | $4914 | 0.97 | 383 stacked beyond primary (33.2%) |
| all sessions | ACTIVE + SHADOW (all real-time rows) | raw (every row) | 10573 | -$32962 | -$3.1 | $38790 | 0.92 | - |
| all sessions | ACTIVE + SHADOW (all real-time rows) | primary-only (is_cluster_primary) | 7672 | -$17068 | -$2.2 | $22422 | 0.94 | 2901 sibling rows |
| all sessions | ACTIVE + SHADOW (all real-time rows) | Mode 1 on raw | 3197 | -$4376 | -$1.4 | $9552 | 0.96 | 7376 stacked (69.8%) |
| all sessions | ACTIVE + SHADOW (all real-time rows) | Mode 1 on primary-only | 3230 | -$6049 | -$1.9 | $10072 | 0.95 | 4442 stacked beyond primary (57.9%) |
| RTH only | ACTIVE (live-visible) | raw (every row) | 1001 | -$3641 | -$3.6 | $6366 | 0.90 | - |
| RTH only | ACTIVE (live-visible) | primary-only (is_cluster_primary) | 780 | -$3816 | -$4.9 | $6611 | 0.87 | 221 sibling rows |
| RTH only | ACTIVE (live-visible) | Mode 1 on raw | 500 | -$1911 | -$3.8 | $3523 | 0.89 | 501 stacked (50.0%) |
| RTH only | ACTIVE (live-visible) | Mode 1 on primary-only | 483 | -$2160 | -$4.5 | $3849 | 0.87 | 297 stacked beyond primary (38.1%) |
| RTH only | ACTIVE excluding POC_ROTATION_JOIN | raw (every row) | 993 | -$3283 | -$3.3 | $6096 | 0.91 | - |
| RTH only | ACTIVE excluding POC_ROTATION_JOIN | primary-only (is_cluster_primary) | 772 | -$3458 | -$4.5 | $6253 | 0.88 | 221 sibling rows |
| RTH only | ACTIVE excluding POC_ROTATION_JOIN | Mode 1 on raw | 498 | -$1695 | -$3.4 | $3308 | 0.90 | 495 stacked (49.8%) |
| RTH only | ACTIVE excluding POC_ROTATION_JOIN | Mode 1 on primary-only | 483 | -$1878 | -$3.9 | $3566 | 0.89 | 289 stacked beyond primary (37.4%) |
| RTH only | ACTIVE + SHADOW (all real-time rows) | raw (every row) | 7844 | -$23787 | -$3.0 | $28234 | 0.92 | - |
| RTH only | ACTIVE + SHADOW (all real-time rows) | primary-only (is_cluster_primary) | 5265 | -$13146 | -$2.5 | $17738 | 0.94 | 2579 sibling rows |
| RTH only | ACTIVE + SHADOW (all real-time rows) | Mode 1 on raw | 1918 | -$3297 | -$1.7 | $5285 | 0.96 | 5926 stacked (75.5%) |
| RTH only | ACTIVE + SHADOW (all real-time rows) | Mode 1 on primary-only | 1945 | -$4962 | -$2.6 | $6482 | 0.94 | 3320 stacked beyond primary (63.1%) |
