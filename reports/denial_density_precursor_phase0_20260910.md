# Denial Density Precursor — Phase 0 (non-directional forward-return pre-test)

Question: does a zone's CURRENT touch density (touches in trailing 24h, live at each touch) predict a bigger absolute forward move, either direction -- NOT whether raw cumulative streak-at-break predicts EV (already tested negative, see CLAUDE.md). Population: level_prices confluence zones, same continuous cross-day tracking as denial_streak_breakout_backtest.mjs.

| Density bucket | N | Distinct dates | Top-5-dates % | +30m mean|Δ|/ATR | +60m mean|Δ|/ATR | +120m mean|Δ|/ATR | +240m mean|Δ|/ATR |
|---|---|---|---|---|---|---|---|
| 1 (first touch) | 3853 | 309 | 6.0% | 0.141 | 0.193 | 0.262 | 0.343 |
| 2-3 | 7130 | 312 | 6.1% | 0.130 | 0.179 | 0.243 | 0.322 |
| 4-6 | 9399 | 306 | 5.6% | 0.119 | 0.163 | 0.220 | 0.305 |
| 7-12 | 13710 | 295 | 6.3% | 0.106 | 0.146 | 0.208 | 0.297 |
| 13+ | 14655 | 234 | 8.1% | 0.103 | 0.149 | 0.215 | 0.308 |