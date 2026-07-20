# 1-Year Globex-Inclusive Prop Challenge
**Window:** 2025-07-21 to 2026-07-20 (256 trading days)

> [!WARNING]
> This is a HYBRID result. The RTH leg reflects real historical trade outcomes (which are mostly BACKFILL-origin, with known caveats). The Globex leg is a pure bar-walk simulation that has NEVER fired live (except 4 thin setup types). The two are merged to test DLL interactions, but do not mistake the combined result for purely "real" trading history.

## Performance by Scenario & DLL

| RTH Scenario | Globex | DLL | Total P&L | Trades | Combined Win Rate | Max Drawdown | Lockout Days |
|---|---|---|---|---|---|---|---|
| LEGACY_ROLLING | Excluded | $200 | $21565.51 | 2319 | 62.1% | $4185.44 | 133 |
| LEGACY_ROLLING | Excluded | $400 | $14707.09 | 2799 | 60.2% | $5900.48 | 95 |
| LEGACY_ROLLING | Excluded | $600 | $9840.83 | 3082 | 59.3% | $6492.76 | 65 |
| LEGACY_ROLLING | Included | $200 | $47102.69 | 3428 | 59.5% | $3303.78 | 121 |
| LEGACY_ROLLING | Included | $400 | $42136.31 | 4047 | 58.4% | $5392.46 | 83 |
| LEGACY_ROLLING | Included | $600 | $35614.21 | 4309 | 57.7% | $7851.92 | 62 |
| CURRENT_VALIDATED_ROSTER | Excluded | $200 | $-954.50 | 38 | 52.6% | $2282.50 | 10 |
| CURRENT_VALIDATED_ROSTER | Excluded | $400 | $-954.50 | 38 | 52.6% | $2282.50 | 3 |
| CURRENT_VALIDATED_ROSTER | Excluded | $600 | $-954.50 | 38 | 52.6% | $2282.50 | 0 |
| CURRENT_VALIDATED_ROSTER | Included | $200 | $32131.50 | 1137 | 56.6% | $2615.50 | 29 |
| CURRENT_VALIDATED_ROSTER | Included | $400 | $32188.00 | 1224 | 55.7% | $3085.00 | 9 |
| CURRENT_VALIDATED_ROSTER | Included | $600 | $31626.00 | 1240 | 55.2% | $3207.00 | 4 |

## Component Breakdown (Globex Included Runs)

| Scenario | DLL | RTH P&L | RTH Trades | Globex P&L | Globex Trades | Globex Win Rate |
|---|---|---|---|---|---|---|
| LEGACY_ROLLING | $200 | $14338.69 | 2323 | $32764.00 | 1105 | 56.6% |
| LEGACY_ROLLING | $400 | $8850.31 | 2859 | $33286.00 | 1188 | 55.8% |
| LEGACY_ROLLING | $600 | $2890.21 | 3105 | $32724.00 | 1204 | 55.3% |
| CURRENT_VALIDATED_ROSTER | $200 | $-632.50 | 32 | $32764.00 | 1105 | 56.6% |
| CURRENT_VALIDATED_ROSTER | $400 | $-1098.00 | 36 | $33286.00 | 1188 | 55.8% |
| CURRENT_VALIDATED_ROSTER | $600 | $-1098.00 | 36 | $32724.00 | 1204 | 55.3% |
