# Stall-Defended-Level (RTH) — Phase 2 Robustness Check

Per OPEN_DECISION stall_defended_level_phase2_robustness_gap_20260910. Full live-equivalent population (CLEAN+COILED, N=109), target fixed at the shipped 0.5x ATR, full hold grid swept.

## Part 1: Hold grid sweep (target=0.5x ATR)

| Hold | N | WR | EV | stop%/target%/time% | Placebo avg (range) | Delta |
|---|---|---|---|---|---|---|
| 120m | 109 | 33.0% | $14.64 | 62.4%/2.8%/34.9% | $2.54 ($-7.17/$13.73) | $12.10 |
| 150m | 109 | 31.2% | $24.11 | 64.2%/3.7%/32.1% | $5.66 ($-10.87/$22.71) | $18.46 |
| 180m | 109 | 33.0% | $27.83 | 65.1%/4.6%/30.3% | $4.96 ($-9.94/$19.92) | $22.86 |
| 210m | 109 | 33.0% | $29.50 | 66.1%/5.5%/28.4% | $5.69 ($-9.18/$21.39) | $23.81 |
| 240m | 109 | 33.0% | $32.41 | 67.0%/5.5%/27.5% | $6.13 ($-8.77/$26.14) | $26.28 |
| 300m | 109 | 33.0% | $43.47 | 67.0%/7.3%/25.7% | $12.90 ($-3.82/$37.68) | $30.57 |
| 360m | 109 | 33.0% | $47.89 | 67.0%/7.3%/25.7% | $12.67 ($-7.99/$29.82) | $35.22 |

**Best cell by real-vs-placebo delta: hold=360min** (shipped live value is 210min)

## Part 2: Day-clustering + day-blocked bootstrap CI at winning cell (hold=360min)

- Distinct trading days: 49 (N=109 events) — top-5-dates concentration: 38/109 = 34.9%
- Top-5-trade sum=$2710.40 = **51.9% of total EV**
- Day-blocked bootstrap 95% CI on real mean: [$6.98, $88.09]
- Placebo range (30 trials): [$-7.99, $29.82], avg=$12.67
- **Strict standard (CI excludes 0 AND full placebo range): FAIL**

## Part 3: Chronological half-split at winning cell (hold=360min)

Split by distinct date: first half 2025-09-01 to 2026-02-27, second half 2026-03-30 to 2026-09-08.

| Half | N | Mean EV |
|---|---|---|
| First | 65 | $42.31 |
| Second | 44 | $56.13 |

**Both halves positive: YES**
