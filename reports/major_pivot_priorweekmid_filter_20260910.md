# Prior-Week-Mid Filter Side Test (on the 1.5x ATR DEFENDED major-pivot population)

Rule: LONG only if entry price is above prior week's RTH mid ((pwHigh+pwLow)/2 via getPriorWeekRange); SHORT only if below. Reuses the real function, no reimplementation.

## ALIGNED (filter keeps) (N=55, clustering=21.8%)

| Horizon | N | Mean | Median | Positive % |
|---|---|---|---|---|
| +30min | 55 | 1.68 | 12.25 | 60.0% |
| +60min | 55 | -4.30 | 16.50 | 60.0% |
| +120min | 55 | 12.29 | 22.25 | 61.8% |
| +240min | 55 | 33.96 | 27.75 | 61.8% |

## MISALIGNED (filter removes) (N=4, clustering=100.0%)

| Horizon | N | Mean | Median | Positive % |
|---|---|---|---|---|
| +30min | 4 | -10.63 | 48.50 | 75.0% |
| +60min | 4 | 45.63 | 75.00 | 75.0% |
| +120min | 4 | 131.69 | 159.00 | 75.0% |
| +240min | 4 | 280.94 | 362.75 | 75.0% |

## UNFILTERED (baseline) (N=59, clustering=20.3%)

| Horizon | N | Mean | Median | Positive % |
|---|---|---|---|---|
| +30min | 59 | 0.85 | 12.25 | 61.0% |
| +60min | 59 | -0.91 | 20.50 | 61.0% |
| +120min | 59 | 20.39 | 30.00 | 62.7% |
| +240min | 59 | 50.71 | 30.75 | 62.7% |
