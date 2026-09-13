# Stop-Touch Check: Volume-Confirmed Defended-Level Breakout

Same population as the Phase 1 pre-test (N=11233). Stop = the CSV's own stopPrice (z.extremePrice +/- the zone proximity band). "% stopped by H" = fraction of events whose stop was touched at or before that horizon. "Clean" = raw forward close-to-close change ignoring the stop (what was reported before). "With-stop" = realized result if the stop had actually been honored (frozen at -stopDist once touched, flat after).

Median stop distance overall: 74.8pt

## ALL (N=11233)

| Horizon | % stopped by H | Clean mean | With-stop mean |
|---|---|---|---|
| +15 | 4.0% | -0.83 | -0.77 |
| +30 | 11.9% | -0.59 | -0.56 |
| +60 | 24.2% | -0.75 | -0.50 |
| +120 | 38.3% | 1.01 | 0.57 |
| +240 | 51.3% | -0.80 | -1.03 |

## HIGH_VOL (N=5616)

| Horizon | % stopped by H | Clean mean | With-stop mean |
|---|---|---|---|
| +15 | 3.7% | -0.92 | -0.89 |
| +30 | 11.1% | -0.81 | -1.25 |
| +60 | 22.0% | -1.76 | -1.51 |
| +120 | 35.1% | 0.66 | 1.10 |
| +240 | 48.3% | -3.48 | -0.63 |

## LOW_VOL (N=5617)

| Horizon | % stopped by H | Clean mean | With-stop mean |
|---|---|---|---|
| +15 | 4.3% | -0.73 | -0.64 |
| +30 | 12.6% | -0.36 | 0.12 |
| +60 | 26.4% | 0.25 | 0.51 |
| +120 | 41.6% | 1.36 | 0.05 |
| +240 | 54.3% | 1.88 | -1.42 |

## DEFENDED (streak>=1) (N=8253)

| Horizon | % stopped by H | Clean mean | With-stop mean |
|---|---|---|---|
| +15 | 4.3% | -0.88 | -0.75 |
| +30 | 12.1% | -0.47 | -0.36 |
| +60 | 24.3% | 0.75 | 0.85 |
| +120 | 38.6% | 3.02 | 1.97 |
| +240 | 51.2% | 0.98 | -0.40 |

## UNDEFENDED (streak==0) (N=2980)

| Horizon | % stopped by H | Clean mean | With-stop mean |
|---|---|---|---|
| +15 | 3.2% | -0.69 | -0.82 |
| +30 | 11.2% | -0.91 | -1.13 |
| +60 | 23.9% | -4.92 | -4.22 |
| +120 | 37.6% | -4.54 | -3.29 |
| +240 | 51.7% | -5.72 | -2.77 |

## DEFENDED+HIGH_VOL (N=4002)

| Horizon | % stopped by H | Clean mean | With-stop mean |
|---|---|---|---|
| +15 | 4.1% | -0.93 | -0.85 |
| +30 | 11.2% | -0.67 | -1.09 |
| +60 | 22.1% | 0.32 | 0.60 |
| +120 | 35.2% | 3.43 | 3.61 |
| +240 | 47.9% | -0.26 | 0.89 |

## UNDEFENDED+HIGH_VOL (N=1614)

| Horizon | % stopped by H | Clean mean | With-stop mean |
|---|---|---|---|
| +15 | 2.8% | -0.90 | -0.99 |
| +30 | 10.8% | -1.16 | -1.62 |
| +60 | 21.7% | -6.89 | -6.72 |
| +120 | 35.0% | -6.19 | -5.11 |
| +240 | 49.5% | -11.44 | -4.42 |
