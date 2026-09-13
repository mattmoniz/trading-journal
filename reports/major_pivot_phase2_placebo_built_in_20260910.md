# Phase 2: Major-Pivot DEFENDED Population -- Real Stop/Target + Placebo Built In

Population: N=55. Target = fixed ATR-multiple grid (not self-referential). Hold capped (not unlimited, per today's earlier gambler's-ruin lesson). Placebo = 10 independent random-direction trials per cell, averaged, for a noise floor. Two stop variants compared: WITH_STOP (the pivot's own real defended-extreme distance) and NO_STOP (deliberate -- target-or-timeout only, no downside cap; this is what the earlier bug accidentally tested, now run on purpose with its own placebo).

## WITH_STOP

| Target | Hold | REAL: N/WR/EV | REAL stop%/target% | PLACEBO avg: WR/EV | Real-vs-placebo EV delta |
|---|---|---|---|---|---|
| 0.5x ATR | 240m | N=55 WR=52.7% EV=$48.71 | 36.4% / 18.2% | WR=42.4% EV=$3.38 (range $-45.82/$55.78) | $45.33 |
| 0.5x ATR | 480m | N=55 WR=49.1% EV=$47.62 | 45.5% / 30.9% | WR=40.4% EV=$7.02 (range $-45.83/$61.50) | $40.60 |
| 1x ATR | 240m | N=55 WR=52.7% EV=$68.55 | 36.4% / 9.1% | WR=42.2% EV=$20.46 (range $-34.50/$49.65) | $48.09 |
| 1x ATR | 480m | N=55 WR=41.8% EV=$63.43 | 50.9% / 10.9% | WR=34.7% EV=$10.45 (range $-51.87/$56.19) | $52.99 |
| 1.5x ATR | 240m | N=55 WR=52.7% EV=$88.72 | 36.4% / 5.5% | WR=41.1% EV=$8.27 (range $-24.21/$51.02) | $80.45 |
| 1.5x ATR | 480m | N=55 WR=41.8% EV=$72.74 | 50.9% / 5.5% | WR=32.7% EV=$-12.77 (range $-62.19/$43.18) | $85.51 |
## NO_STOP (deliberate, target-or-timeout only)

| Target | Hold | REAL: N/WR/EV | REAL stop%/target% | PLACEBO avg: WR/EV | Real-vs-placebo EV delta |
|---|---|---|---|---|---|
| 0.5x ATR | 240m | N=55 WR=65.5% EV=$61.32 | 0.0% / 21.8% | WR=59.8% EV=$28.87 (range $-28.95/$65.68) | $32.46 |
| 0.5x ATR | 480m | N=55 WR=65.5% EV=$54.67 | 0.0% / 41.8% | WR=58.9% EV=$9.01 (range $-113.55/$115.18) | $45.66 |
| 1x ATR | 240m | N=55 WR=65.5% EV=$85.96 | 0.0% / 9.1% | WR=52.7% EV=$15.81 (range $-94.20/$70.92) | $70.14 |
| 1x ATR | 480m | N=55 WR=58.2% EV=$76.20 | 0.0% / 14.5% | WR=53.5% EV=$25.47 (range $-64.21/$151.22) | $50.73 |
| 1.5x ATR | 240m | N=55 WR=65.5% EV=$106.13 | 0.0% / 5.5% | WR=49.3% EV=$1.37 (range $-58.83/$92.73) | $104.76 |
| 1.5x ATR | 480m | N=55 WR=58.2% EV=$86.39 | 0.0% / 7.3% | WR=50.0% EV=$9.95 (range $-71.31/$133.72) | $76.43 |