# Sweep + Reclaim engine -- run output. Dates used 316 of 336 (skipped for missing RTH bars or previous session: 20); Train 186 (through 2026-01-02), Hold-Out 130.

### Spec B / "Argon" (intrabar touch fill, buffer max(2, 0.25 ATR), 1.5 ATR guardrail, structural target with 1R floor)

| Sample | Total trades | Win rate | Profit factor | Net PnL @$4 | Mean PnL/trade @$4 [95% CI] | Max drawdown | Mean @$1 (reference) |
|---|---|---|---|---|---|---|---|
| In-sample Train | 3989 | 35.2% | 0.71 | -$21064 | -$5.3 [-$6.5, -$4.1] | $21409 | -$2.3 |
| Out-of-sample Hold-Out | 2966 | 34.5% | 0.76 | -$18220 | -$6.1 [-$7.6, -$4.6] | $18358 | -$3.1 |

Train geometry: avg stop 12.4 pts, avg target 29.7 pts (avg 2.63R), fee = 23.6% of 1R on average, break-even win rate at the average geometry 34.2%, observed 35.2%; target hit 34.4%, stopped 64.7%, time exit 0.9%; long 2005 / short 1984
Hold-Out geometry: avg stop 18.2 pts, avg target 40.7 pts (avg 2.64R), fee = 16.3% of 1R on average, break-even win rate at the average geometry 34.3%, observed 34.5%; target hit 33.8%, stopped 65.2%, time exit 1.0%; long 1466 / short 1500
| Hold-Out split | Trades | Mean @$4 | Win rate | Net @$4 |
|---|---|---|---|---|
| level PDH | 440 | -$10.9 | 32.3% | -$4783 |
| level PDL | 334 | -$9.0 | 33.8% | -$3009 |
| level VAH | 342 | -$4.8 | 34.5% | -$1641 |
| level VAL | 410 | -$4.3 | 37.1% | -$1744 |
| level POC | 378 | -$5.7 | 33.1% | -$2149 |
| level IB_High | 690 | -$7.1 | 34.6% | -$4927 |
| level IB_Low | 372 | $0.1 | 36.0% | $32 |
| direction long | 1466 | -$6.1 | 34.9% | -$8939 |
| direction short | 1500 | -$6.2 | 34.1% | -$9281 |

Sensitivity grid (descriptive; only the spec cell counts; the frozen Train-best no-lookahead cell is marked *):
| Cell | Train trades / mean @$4 | Hold-Out trades / mean @$4 [95% CI] |
|---|---|---|
| K=2, no-lookahead stop * | 3974 / -$5.2 | 2954 / -$6.1 [-$7.7, -$4.5] |
| K=2, spec-literal stop (uses the fill bar full extreme: lookahead-optimistic) | 3377 / -$2.6 | 2540 / -$2.4 [-$4.3, -$0.5] |
| K=3, no-lookahead stop | 3989 / -$5.3 | 2966 / -$6.1 [-$7.7, -$4.5] |
| K=3, spec-literal stop (uses the fill bar full extreme: lookahead-optimistic) | 3389 / -$2.7 | 2555 / -$2.5 [-$4.5, -$0.5] |
| K=5, no-lookahead stop | 3991 / -$5.3 | 2971 / -$6.0 [-$7.5, -$4.4] |
| K=5, spec-literal stop (uses the fill bar full extreme: lookahead-optimistic) | 3392 / -$2.7 | 2567 / -$2.4 [-$4.3, -$0.4] |

Random-entry placebos on Hold-Out (same stop / target geometry, same fee, same Mode 1); distribution of the mean PnL per trade @$4 over the runs:
| Placebo | Runs | Placebo mean/trade (5th-95th pct) | Median trades | Median PF | Share of runs >= the real engine |
|---|---|---|---|---|---|
| REAL B | 1 | -$6.1 [-$7.6, -$4.6] | 2966 | 0.76 | - |
| P1 random entry times (same direction & geometry) | 300 | -$6.5 to -$3.0 (median -$4.8) | 2351 | 0.80 | 91.0% |
| P2 random direction (same entry bars) | 300 | -$6.2 to -$2.7 (median -$4.4) | 2323 | 0.83 | 94.7% |
| P3 random levels (full state machine re-run) | 100 | -$7.0 to -$4.3 (median -$5.9) | 2739 | 0.76 | 60.0% |

Pass rule (Hold-Out): lower bound -$7.6 > 0 ? false; mean -$6.1 above the 95th percentile of P1 (-$3.0) false, P2 (-$2.7) false, P3 (-$4.3) false -> DOES NOT PASS (NOT SHOWN)

### Spec A (bar-close reclaim, 10-35 pt stop band, 1.5R target)

| Sample | Total trades | Win rate | Profit factor | Net PnL @$4 | Mean PnL/trade @$4 [95% CI] | Max drawdown | Mean @$1 (reference) |
|---|---|---|---|---|---|---|---|
| In-sample Train | 1900 | 40.4% | 0.84 | -$7455 | -$3.9 [-$5.8, -$2.0] | $8278 | -$0.9 |
| Out-of-sample Hold-Out | 1487 | 39.5% | 0.86 | -$5689 | -$3.8 [-$6.3, -$1.3] | $6233 | -$0.8 |

Train geometry: avg stop 19.1 pts, avg target 28.7 pts (avg 1.50R), fee = 11.8% of 1R on average, break-even win rate at the average geometry 44.2%, observed 40.4%; target hit 39.1%, stopped 58.5%, time exit 2.5%; long 980 / short 920
Hold-Out geometry: avg stop 21.6 pts, avg target 32.4 pts (avg 1.50R), fee = 10.4% of 1R on average, break-even win rate at the average geometry 43.7%, observed 39.5%; target hit 39.3%, stopped 59.8%, time exit 0.9%; long 749 / short 738
| Hold-Out split | Trades | Mean @$4 | Win rate | Net @$4 |
|---|---|---|---|---|
| level PDH | 234 | -$1.5 | 41.0% | -$347 |
| level PDL | 141 | -$1.9 | 41.8% | -$265 |
| level VAH | 152 | -$0.8 | 42.8% | -$127 |
| level VAL | 194 | -$4.0 | 38.7% | -$773 |
| level POC | 181 | -$10.6 | 33.7% | -$1915 |
| level IB_High | 379 | -$6.2 | 37.2% | -$2344 |
| level IB_Low | 206 | $0.4 | 44.2% | $81 |
| direction long | 749 | -$4.2 | 39.8% | -$3165 |
| direction short | 738 | -$3.4 | 39.3% | -$2524 |

Sensitivity grid (descriptive; only the spec cell counts; the frozen Train-best cell is marked *):
| Cell | Train trades / mean @$4 | Hold-Out trades / mean @$4 [95% CI] |
|---|---|---|
| K=2, R=1 | 2022 / -$4.1 | 1542 / -$3.4 [-$5.5, -$1.3] |
| K=2, R=1.5 | 1837 / -$4.1 | 1424 / -$3.0 [-$5.5, -$0.5] |
| K=2, R=2 | 1718 / -$3.7 | 1362 / -$2.5 [-$5.2, $0.6] |
| K=3, R=1 | 2114 / -$4.1 | 1624 / -$3.9 [-$5.8, -$2.1] |
| K=3, R=1.5 | 1900 / -$3.9 | 1487 / -$3.8 [-$6.3, -$1.3] |
| K=3, R=2 | 1760 / -$3.5 | 1415 / -$3.2 [-$6.2, -$0.3] |
| K=5, R=1 | 2197 / -$4.1 | 1661 / -$3.5 [-$5.4, -$1.7] |
| K=5, R=1.5 | 1955 / -$4.1 | 1512 / -$3.5 [-$6.0, -$1.2] |
| K=5, R=2 * | 1795 / -$3.4 | 1426 / -$2.9 [-$5.8, -$0.1] |

Random-entry placebos on Hold-Out (same stop / target geometry, same fee, same Mode 1); distribution of the mean PnL per trade @$4 over the runs:
| Placebo | Runs | Placebo mean/trade (5th-95th pct) | Median trades | Median PF | Share of runs >= the real engine |
|---|---|---|---|---|---|
| REAL A | 1 | -$3.8 [-$6.3, -$1.3] | 1487 | 0.86 | - |
| P1 random entry times (same direction & geometry) | 300 | -$6.8 to -$2.2 (median -$4.3) | 1298 | 0.85 | 35.0% |
| P2 random direction (same entry bars) | 300 | -$6.3 to -$2.0 (median -$4.0) | 1272 | 0.86 | 43.0% |
| P3 random levels (full state machine re-run) | 100 | -$6.1 to -$2.3 (median -$4.2) | 1384 | 0.85 | 33.0% |

Pass rule (Hold-Out): lower bound -$6.3 > 0 ? false; mean -$3.8 above the 95th percentile of P1 (-$2.2) false, P2 (-$2.0) false, P3 (-$2.3) false -> DOES NOT PASS (NOT SHOWN)
