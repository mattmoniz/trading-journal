# Compression + Volume Breakout Backtest Stats

## RTH Window
**Baseline**: N=10741, Mean Time-of-Day (mod)=761.6

### SIGNAL
- **N**: 82 (56 Long [68.3%], 26 Short [31.7%])
- **Mean Time-of-Day (mod)**: 744.6 (Baseline: 761.6)
- **Top 5 Dates Frac**: 12.2%

| Horizon | Arm Mean | Flat Base Diff | Matched Base Diff | Stability |
|---|---|---|---|---|
| 5 | -1.95 | -1.93 | -1.94 | ++- (MIXED) |
| 10 | -3.11 | -2.82 | -3.00 | ++- (MIXED) |
| 15 | -1.89 | -1.65 | -1.80 | ++- (MIXED) |
| 20 | -0.80 | -0.54 | -0.71 | ++- (MIXED) |
| 40 | 2.12 | 2.29 | 2.18 | -+- (MIXED) |
| 60 | 5.57 | 5.40 | 5.51 | -++ (MIXED) |
| 120 | 7.41 | 5.98 | 6.89 | --+ (MIXED) |
| 180 | 17.91 | 15.64 | 17.08 | --+ (MIXED) |
| 240 | 12.66 | 9.30 | 11.43 | --+ (MIXED) |
| EOD | 14.81 | 16.52 | 15.43 | --+ (MIXED) |

### FADE_CONTROL
- **N**: 316 (237 Long [75.0%], 79 Short [25.0%])
- **Mean Time-of-Day (mod)**: 750.2 (Baseline: 761.6)
- **Top 5 Dates Frac**: 7.6%

| Horizon | Arm Mean | Flat Base Diff | Matched Base Diff | Stability |
|---|---|---|---|---|
| 5 | -1.09 | -1.08 | -1.08 | --- (STABLE) |
| 10 | 0.25 | 0.54 | 0.40 | -++ (MIXED) |
| 15 | -2.46 | -2.21 | -2.33 | --- (STABLE) |
| 20 | -2.22 | -1.96 | -2.09 | --- (STABLE) |
| 40 | -5.85 | -5.68 | -5.76 | --- (STABLE) |
| 60 | -6.81 | -6.98 | -6.89 | --- (STABLE) |
| 120 | -5.80 | -7.23 | -6.51 | --- (STABLE) |
| 180 | -7.42 | -9.69 | -8.56 | --+ (MIXED) |
| 240 | -6.09 | -9.45 | -7.77 | --+ (MIXED) |
| EOD | -8.23 | -6.52 | -7.37 | --+ (MIXED) |

### NO_COMPRESSION_CONTROL
- **N**: 1516 (694 Long [45.8%], 822 Short [54.2%])
- **Mean Time-of-Day (mod)**: 747.3 (Baseline: 761.6)
- **Top 5 Dates Frac**: 4.6%

| Horizon | Arm Mean | Flat Base Diff | Matched Base Diff | Stability |
|---|---|---|---|---|
| 5 | 0.38 | 0.39 | 0.38 | -++ (MIXED) |
| 10 | 1.91 | 2.20 | 1.88 | +++ (STABLE) |
| 15 | 2.01 | 2.26 | 1.99 | +++ (STABLE) |
| 20 | 2.56 | 2.82 | 2.54 | +++ (STABLE) |
| 40 | 4.38 | 4.55 | 4.36 | +++ (STABLE) |
| 60 | 4.82 | 4.65 | 4.83 | +++ (STABLE) |
| 120 | 5.43 | 3.99 | 5.55 | +++ (STABLE) |
| 180 | 2.68 | 0.42 | 2.87 | +++ (STABLE) |
| 240 | 4.80 | 1.44 | 5.09 | +++ (STABLE) |
| EOD | 3.03 | 4.73 | 2.88 | +++ (STABLE) |

## GLOBEX Window
**Baseline**: N=27408, Mean Time-of-Day (mod)=681.1

### SIGNAL
- **N**: 320 (215 Long [67.2%], 105 Short [32.8%])
- **Mean Time-of-Day (mod)**: 954.4 (Baseline: 681.1)
- **Top 5 Dates Frac**: 7.5%

| Horizon | Arm Mean | Flat Base Diff | Matched Base Diff | Stability |
|---|---|---|---|---|
| 5 | 0.26 | 0.15 | 0.22 | +-+ (MIXED) |
| 10 | 0.29 | -0.21 | 0.12 | +-+ (MIXED) |
| 15 | -0.54 | -1.12 | -0.74 | +-- (MIXED) |
| 20 | -1.79 | -2.49 | -2.03 | --- (STABLE) |
| 40 | -1.71 | -3.14 | -2.20 | --- (STABLE) |
| 60 | 0.12 | -1.76 | -0.52 | +-+ (MIXED) |
| 120 | 2.37 | -0.97 | 1.22 | +-+ (MIXED) |
| 180 | 1.88 | -3.08 | 0.18 | --+ (MIXED) |
| 240 | -0.70 | -7.19 | -2.93 | --- (STABLE) |
| EOD | 6.14 | -13.16 | -0.49 | -+- (MIXED) |

### FADE_CONTROL
- **N**: 638 (400 Long [62.7%], 238 Short [37.3%])
- **Mean Time-of-Day (mod)**: 846.5 (Baseline: 681.1)
- **Top 5 Dates Frac**: 6.1%

| Horizon | Arm Mean | Flat Base Diff | Matched Base Diff | Stability |
|---|---|---|---|---|
| 5 | 0.02 | -0.09 | -0.01 | -+- (MIXED) |
| 10 | 1.02 | 0.52 | 0.89 | -++ (MIXED) |
| 15 | 1.33 | 0.75 | 1.19 | -++ (MIXED) |
| 20 | -0.13 | -0.83 | -0.31 | -+- (MIXED) |
| 40 | -0.05 | -1.48 | -0.41 | --+ (MIXED) |
| 60 | 0.64 | -1.24 | 0.17 | -++ (MIXED) |
| 120 | 1.55 | -1.80 | 0.70 | +-- (MIXED) |
| 180 | 0.55 | -4.41 | -0.71 | +-- (MIXED) |
| 240 | -0.42 | -6.91 | -2.07 | +-- (MIXED) |
| EOD | 13.58 | -5.72 | 8.68 | +++ (STABLE) |

### NO_COMPRESSION_CONTROL
- **N**: 4616 (2353 Long [51.0%], 2263 Short [49.0%])
- **Mean Time-of-Day (mod)**: 690.8 (Baseline: 681.1)
- **Top 5 Dates Frac**: 3.2%

| Horizon | Arm Mean | Flat Base Diff | Matched Base Diff | Stability |
|---|---|---|---|---|
| 5 | -1.21 | -1.32 | -1.21 | --- (STABLE) |
| 10 | -0.68 | -1.19 | -0.69 | --- (STABLE) |
| 15 | -0.64 | -1.22 | -0.65 | --- (STABLE) |
| 20 | -0.96 | -1.66 | -0.98 | --- (STABLE) |
| 40 | -1.19 | -2.62 | -1.22 | --- (STABLE) |
| 60 | -0.92 | -2.81 | -0.96 | --+ (MIXED) |
| 120 | -1.73 | -5.07 | -1.80 | --- (STABLE) |
| 180 | -2.81 | -7.77 | -2.90 | --- (STABLE) |
| 240 | -1.67 | -8.16 | -1.79 | --- (STABLE) |
| EOD | -1.96 | -21.26 | -2.33 | --+ (MIXED) |
