# Climactic Acceleration Reversal (Globex) — Phase 2 Robustness Check

Per OPEN_DECISION climactic_acceleration_reversal_phase2_needed_20260910 (DeepSeek design review). No new detector, no wiring.

## Part 1-2: Full population robustness (p90, target=1x ATR, hold=240min)

- N=132, Mean EV=$26.06, Median EV=$23.00
- Top-5-trade sum=$3683.50 = **107.1% of total EV**, 23.8% of gross positive P&L
- Distinct trading days: 108 (N=132 events) — top-5-dates concentration: 14/132 = 10.6%
- Day-blocked bootstrap 95% CI on real mean: [$-27.88, $76.57]
- Placebo (30 random-direction trials): avg=$2.42, range=[$-32.37, $65.23]
- **Strict standard (CI excludes 0 AND full placebo range): FAIL**

## Part 3: Chronological half-split

Split by distinct date: first half 2025-09-02 to 2026-03-23, second half 2026-03-24 to 2026-09-09.

| Half | N | Mean EV |
|---|---|---|
| First | 64 | $29.69 |
| Second | 68 | $22.65 |

**Both halves positive: YES**

## Part 4: Threshold-sensitivity sweep (target=1x ATR, hold=240min fixed)

| Percentile | Cutoff (xATR) | N | Real EV | Placebo avg (range) | Delta |
|---|---|---|---|---|---|
| p80 | 0.43x | 263 | $29.77 | $-6.59 ($-63.31/$59.24) | $36.36 |
| p85 | 0.51x | 202 | $52.76 | $-3.46 ($-58.17/$43.44) | $56.22 |
| p90 | 0.62x | 132 | $26.06 | $-1.60 ($-63.50/$46.28) | $27.66 |
| p92 | 0.69x | 97 | $29.70 | $-7.45 ($-50.81/$46.72) | $37.14 |
| p95 | 0.83x | 64 | $90.70 | $-0.10 ($-111.13/$72.23) | $90.79 |