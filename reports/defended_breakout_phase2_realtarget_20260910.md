# Phase 2: Real Bar-by-Bar Simulation (Real Stop + Real ATR-Multiple Target)

Population: N=11233. Stop = CSV's own real stopPrice (median 40pt-ish). Target = a FIXED grid of ATR-multiples (0.5x, 1x, 1.5x, 2x), NOT derived from this population's own outcome distribution -- avoids the median-MFE tautology trap. Max hold 240min, then time-stop at market. $2/pt, $2 round-trip commission (MNQ).

## ALL (N=11233, day-clustering top5=6.7%)

| Target | N | WR | EV/trade | Stop-out % | Target-hit % | Time-stop % |
|---|---|---|---|---|---|---|
| 0.5x ATR | 11233 | 39.1% | $-6.03 | 50.5% | 14.1% | 35.4% |
| 1x ATR | 11233 | 37.6% | $-6.81 | 51.3% | 2.6% | 46.1% |
| 1.5x ATR | 11233 | 37.6% | $-3.47 | 51.3% | 1.0% | 47.7% |
| 2x ATR | 11233 | 37.6% | $-2.69 | 51.3% | 0.3% | 48.4% |

## HIGH_VOL (N=5616, day-clustering top5=8.9%)

| Target | N | WR | EV/trade | Stop-out % | Target-hit % | Time-stop % |
|---|---|---|---|---|---|---|
| 0.5x ATR | 5616 | 40.8% | $-6.53 | 47.2% | 18.6% | 34.2% |
| 1x ATR | 5616 | 38.6% | $-7.53 | 48.3% | 3.9% | 47.8% |
| 1.5x ATR | 5616 | 38.6% | $-2.27 | 48.3% | 1.7% | 49.9% |
| 2x ATR | 5616 | 38.5% | $-0.73 | 48.3% | 0.5% | 51.1% |

## DEFENDED (streak>=1) (N=8253, day-clustering top5=6.2%)

| Target | N | WR | EV/trade | Stop-out % | Target-hit % | Time-stop % |
|---|---|---|---|---|---|---|
| 0.5x ATR | 8253 | 39.1% | $-3.59 | 50.5% | 14.0% | 35.5% |
| 1x ATR | 8253 | 37.7% | $-4.64 | 51.2% | 2.5% | 46.3% |
| 1.5x ATR | 8253 | 37.7% | $-1.61 | 51.2% | 0.9% | 47.9% |
| 2x ATR | 8253 | 37.7% | $-1.20 | 51.2% | 0.3% | 48.6% |

## UNDEFENDED (streak==0) (N=2980, day-clustering top5=9.0%)

| Target | N | WR | EV/trade | Stop-out % | Target-hit % | Time-stop % |
|---|---|---|---|---|---|---|
| 0.5x ATR | 2980 | 39.1% | $-12.80 | 50.5% | 14.5% | 34.9% |
| 1x ATR | 2980 | 37.3% | $-12.80 | 51.7% | 2.9% | 45.5% |
| 1.5x ATR | 2980 | 37.3% | $-8.61 | 51.7% | 1.2% | 47.1% |
| 2x ATR | 2980 | 37.3% | $-6.82 | 51.7% | 0.4% | 47.9% |

## DEFENDED+HIGH_VOL (N=4002, day-clustering top5=8.7%)

| Target | N | WR | EV/trade | Stop-out % | Target-hit % | Time-stop % |
|---|---|---|---|---|---|---|
| 0.5x ATR | 4002 | 40.9% | $-1.85 | 46.9% | 18.9% | 34.2% |
| 1x ATR | 4002 | 38.9% | $-3.01 | 47.9% | 3.8% | 48.4% |
| 1.5x ATR | 4002 | 38.8% | $2.30 | 47.9% | 1.7% | 50.4% |
| 2x ATR | 4002 | 38.7% | $2.87 | 47.9% | 0.4% | 51.7% |

## UNDEFENDED+HIGH_VOL (N=1614, day-clustering top5=13.5%)

| Target | N | WR | EV/trade | Stop-out % | Target-hit % | Time-stop % |
|---|---|---|---|---|---|---|
| 0.5x ATR | 1614 | 40.6% | $-18.15 | 48.0% | 17.8% | 34.2% |
| 1x ATR | 1614 | 38.0% | $-18.75 | 49.5% | 4.2% | 46.3% |
| 1.5x ATR | 1614 | 38.0% | $-13.61 | 49.5% | 1.8% | 48.7% |
| 2x ATR | 1614 | 38.0% | $-9.63 | 49.5% | 0.7% | 49.8% |
