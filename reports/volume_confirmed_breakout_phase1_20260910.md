# Volume-Confirmed Defended-Level Breakout: Phase 1 Forward-Return Pre-Test

Population: confirmed breakouts of a 2+ level confluence zone (denial_streak_breakout_backtest.mjs), entryTime >= 2025-11-20 (clean volume data only). N=11233. No stop/target/exit rule -- raw forward price change in the breakout's own direction.

## Split 1: HIGH_VOL (volZ > median=0.41) vs LOW_VOL vs ALL (unconditional)

| Horizon (min) | ALL mean | ALL N | HIGH_VOL mean | HIGH_VOL N | LOW_VOL mean | LOW_VOL N |
|---|---|---|---|---|---|---|
| +15 | -0.83 | 11233 | -0.92 | 5616 | -0.73 | 5617 |
| +30 | -0.59 | 11233 | -0.81 | 5616 | -0.36 | 5617 |
| +60 | -0.75 | 11233 | -1.76 | 5616 | 0.25 | 5617 |
| +120 | 1.01 | 11233 | 0.66 | 5616 | 1.36 | 5617 |
| +240 | -0.80 | 11233 | -3.48 | 5616 | 1.88 | 5617 |

Day-clustering (top5 dates as % of N): ALL=6.7%, HIGH_VOL=8.9%, LOW_VOL=7.4%

## Split 2: DEFENDED ONLY (streak>=1, N=8253) -- HIGH_VOL vs LOW_VOL vs ALL_DEFENDED

| Horizon (min) | ALL_DEFENDED mean | N | HIGH_VOL mean | N | LOW_VOL mean | N |
|---|---|---|---|---|---|---|
| +15 | -0.88 | 8253 | -0.93 | 4002 | -0.83 | 4251 |
| +30 | -0.47 | 8253 | -0.67 | 4002 | -0.28 | 4251 |
| +60 | 0.75 | 8253 | 0.32 | 4002 | 1.16 | 4251 |
| +120 | 3.02 | 8253 | 3.43 | 4002 | 2.63 | 4251 |
| +240 | 0.98 | 8253 | -0.26 | 4002 | 2.15 | 4251 |

Day-clustering: ALL_DEFENDED=6.2%, HIGH_VOL=8.7%, LOW_VOL=7.3%

## Split 3: DEFENDED (streak>=1, N=8253) vs UNDEFENDED (streak==0, N=2980) -- volume held constant (both HIGH_VOL only)

| Horizon (min) | DEFENDED+HIGH_VOL mean | N | UNDEFENDED+HIGH_VOL mean | N |
|---|---|---|---|---|
| +15 | -0.93 | 4002 | -0.90 | 1614 |
| +30 | -0.67 | 4002 | -1.16 | 1614 |
| +60 | 0.32 | 4002 | -6.89 | 1614 |
| +120 | 3.43 | 4002 | -6.19 | 1614 |
| +240 | -0.26 | 4002 | -11.44 | 1614 |