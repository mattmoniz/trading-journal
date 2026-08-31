# Day-Scale ATR Compression Filter Backtest

## Executive Summary
No cells cleared the bar. None of the 18 configurations had a COMPRESSED subset that beat the POOLED baseline (EV=$11.13) with N>=20 and chronological stability. This is a consistent third negative for compression as an independent filter. The already-validated baseline remains the strongest edge.

## Methodology
- **Population**: 1516 RTH breakout events (volZ >= 1.0, 30-bar high/low).
- **Stop/Target**: Fixed at 138pt stop, 102pt target for all cells to measure standalone filter value.
- **Day-Scale ATR**: Trailing N-day RTH ranges (strictly prior days, expanding window percentile).
- 18 valid Short/Long pairs (Short < Long) × Thresholds were evaluated.

## POOLED Reference (No Compression Filter)
**N**: 1516 | **EV**: $11.13 | **Win Rate**: 55.1% | **Stability**: +++ (STABLE)

## Grid Results
| Short | Long | Thresh | Subset | N | EV/Trade | Win Rate | Stability |
|---|---|---|---|---|---|---|---|
| 3 | 20 | 0.2 | COMPRESSED | 201 | $-10.09 | 48.3% | -+- |
| 3 | 20 | 0.2 | NOT_COMPRESSED | 1315 | $14.38 | 56.2% | +++ |
| 3 | 20 | 0.3 | COMPRESSED | 302 | $1.14 | 51.0% | -+- |
| 3 | 20 | 0.3 | NOT_COMPRESSED | 1214 | $13.62 | 56.2% | +++ |
| 3 | 50 | 0.2 | COMPRESSED | 160 | $-14.35 | 46.9% | -+- |
| 3 | 50 | 0.2 | NOT_COMPRESSED | 1356 | $14.14 | 56.1% | +++ |
| 3 | 50 | 0.3 | COMPRESSED | 254 | $-4.44 | 50.8% | -+- |
| 3 | 50 | 0.3 | NOT_COMPRESSED | 1262 | $14.27 | 56.0% | +++ |
| 3 | 100 | 0.2 | COMPRESSED | 57 | $-27.31 | 42.1% | -+- |
| 3 | 100 | 0.2 | NOT_COMPRESSED | 1459 | $12.64 | 55.7% | +++ |
| 3 | 100 | 0.3 | COMPRESSED | 104 | $-10.52 | 49.0% | +-- |
| 3 | 100 | 0.3 | NOT_COMPRESSED | 1412 | $12.73 | 55.6% | +++ |
| 5 | 20 | 0.2 | COMPRESSED | 200 | $-10.01 | 49.0% | --- |
| 5 | 20 | 0.2 | NOT_COMPRESSED | 1316 | $14.35 | 56.1% | +++ |
| 5 | 20 | 0.3 | COMPRESSED | 331 | $-6.40 | 48.9% | -+- |
| 5 | 20 | 0.3 | NOT_COMPRESSED | 1185 | $16.03 | 56.9% | +++ |
| 5 | 50 | 0.2 | COMPRESSED | 123 | $-36.57 | 39.8% | --- |
| 5 | 50 | 0.2 | NOT_COMPRESSED | 1393 | $15.35 | 56.5% | +++ |
| 5 | 50 | 0.3 | COMPRESSED | 255 | $-7.14 | 50.6% | -+- |
| 5 | 50 | 0.3 | NOT_COMPRESSED | 1261 | $14.83 | 56.1% | +++ |
| 5 | 100 | 0.2 | COMPRESSED | 35 | $-65.79 | 28.6% | --- |
| 5 | 100 | 0.2 | NOT_COMPRESSED | 1481 | $12.95 | 55.8% | +++ |
| 5 | 100 | 0.3 | COMPRESSED | 79 | $-5.44 | 50.6% | +-- |
| 5 | 100 | 0.3 | NOT_COMPRESSED | 1437 | $12.04 | 55.4% | +++ |
| 10 | 20 | 0.2 | COMPRESSED | 241 | $1.36 | 48.5% | --+ |
| 10 | 20 | 0.2 | NOT_COMPRESSED | 1275 | $12.98 | 56.4% | +++ |
| 10 | 20 | 0.3 | COMPRESSED | 370 | $-3.61 | 49.2% | --+ |
| 10 | 20 | 0.3 | NOT_COMPRESSED | 1146 | $15.89 | 57.1% | +++ |
| 10 | 50 | 0.2 | COMPRESSED | 142 | $-33.30 | 43.0% | --- |
| 10 | 50 | 0.2 | NOT_COMPRESSED | 1374 | $15.72 | 56.4% | +++ |
| 10 | 50 | 0.3 | COMPRESSED | 258 | $-10.97 | 50.0% | --+ |
| 10 | 50 | 0.3 | NOT_COMPRESSED | 1258 | $15.67 | 56.2% | +++ |
| 10 | 100 | 0.2 | COMPRESSED | 31 | $-59.24 | 35.5% | --- |
| 10 | 100 | 0.2 | NOT_COMPRESSED | 1485 | $12.60 | 55.6% | +++ |
| 10 | 100 | 0.3 | COMPRESSED | 64 | $-11.63 | 50.0% | ++- |
| 10 | 100 | 0.3 | NOT_COMPRESSED | 1452 | $12.14 | 55.4% | +++ |
