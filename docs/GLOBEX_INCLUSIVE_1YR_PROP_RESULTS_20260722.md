# 1-Year Globex-Inclusive Prop Challenge (corrected)

**Window:** 2025-07-22 to 2026-07-22 (257 trading days)

> [!WARNING]
> This is a HYBRID result. The RTH leg reflects real historical trade outcomes (mostly BACKFILL-origin, with known caveats). The Globex leg is a pure bar-walk simulation that has never fired live at this scope (only ~12 of the ~50 simulated overnight level-touches are actually wired into `detectGlobexSetup()` today). The two are merged to test DLL interactions, not presented as "real" trading history.

**Supersedes** `docs/GLOBEX_INCLUSIVE_1YR_PROP_RESULTS_20260720.md`, which used the `OVERNIGHT_OPTIMAL_STOP` calibration to price the Globex leg. That calibration was independently resolved negative via a fresh train/test holdout the same day (`docs/OVERNIGHT_RESEARCH_SPEC.md` Part 6): calibrated stops made held-out-year P&L *worse* than a flat fallback (flat $6,357 vs calibrated -$4,717, N=2,618), and the `OPEN_DECISION` explicitly says do not wire it in. The 2026-07-20 doc's Globex leg (~$32-33k) used it anyway and substantially re-aggregated the same held-out evidence the calibration was validated against — inflated by in-sample leakage, not a real number. This version always uses the flat fallback (90/40pt, 60/30pt Monday), matching what the holdout test actually validated.

## Performance by Scenario & DLL

| RTH Scenario | Globex | DLL | Total P&L | Trades | Combined Win Rate | Max Drawdown | Lockout Days |
|---|---|---|---|---|---|---|---|
| LEGACY_ROLLING | Excluded | $200 | $23961.83 | 2367 | 62.5% | $4542.00 | 131 |
| LEGACY_ROLLING | Excluded | $400 | $14836.01 | 2781 | 60.4% | $5918.36 | 95 |
| LEGACY_ROLLING | Excluded | $600 | $10640.01 | 3107 | 59.6% | $6469.28 | 63 |
| LEGACY_ROLLING | Included | $200 | $16509.87 | 2785 | 64.4% | $5013.56 | 152 |
| LEGACY_ROLLING | Included | $400 | $11375.75 | 3694 | 63.0% | $9036.18 | 111 |
| LEGACY_ROLLING | Included | $600 | $8818.39 | 4186 | 62.1% | $11189.98 | 75 |
| CURRENT_VALIDATED_ROSTER | Excluded | $200 | $-1697.60 | 128 | 58.6% | $3134.81 | 12 |
| CURRENT_VALIDATED_ROSTER | Excluded | $400 | $-1697.60 | 128 | 58.6% | $3134.81 | 3 |
| CURRENT_VALIDATED_ROSTER | Excluded | $600 | $-1611.60 | 129 | 58.9% | $3048.81 | 0 |
| CURRENT_VALIDATED_ROSTER | Included | $200 | $3304.82 | 1139 | 69.2% | $2934.28 | 79 |
| CURRENT_VALIDATED_ROSTER | Included | $400 | $3117.82 | 1396 | 69.1% | $3131.52 | 37 |
| CURRENT_VALIDATED_ROSTER | Included | $600 | $2047.80 | 1453 | 68.8% | $3271.12 | 17 |
| ALL_WIRED_NO_FILTER | Excluded | $200 | $33657.30 | 3499 | 63.4% | $3749.14 | 157 |
| ALL_WIRED_NO_FILTER | Excluded | $400 | $38869.54 | 4436 | 62.6% | $4605.70 | 116 |
| ALL_WIRED_NO_FILTER | Excluded | $600 | $33372.14 | 4934 | 62.0% | $5770.56 | 89 |
| ALL_WIRED_NO_FILTER | Included | $200 | $13093.69 | 4197 | 65.3% | $5948.18 | 188 |
| ALL_WIRED_NO_FILTER | Included | $400 | $19578.67 | 5988 | 65.1% | $9337.98 | 142 |
| ALL_WIRED_NO_FILTER | Included | $600 | $26725.59 | 7153 | 64.9% | $9054.28 | 111 |

## Component Breakdown (Globex Included Runs)

| Scenario | DLL | RTH P&L | RTH Trades | Globex P&L | Globex Trades | Globex Win Rate |
|---|---|---|---|---|---|---|
| LEGACY_ROLLING | $200 | $12085.87 | 1722 | $4424.00 | 1063 | 70.2% |
| LEGACY_ROLLING | $400 | $7070.75 | 2412 | $4305.00 | 1282 | 70.0% |
| LEGACY_ROLLING | $600 | $5922.39 | 2855 | $2896.00 | 1331 | 69.5% |
| CURRENT_VALIDATED_ROSTER | $200 | $-938.18 | 75 | $4243.00 | 1064 | 70.1% |
| CURRENT_VALIDATED_ROSTER | $400 | $-825.18 | 112 | $3943.00 | 1284 | 69.9% |
| CURRENT_VALIDATED_ROSTER | $600 | $-667.20 | 121 | $2715.00 | 1332 | 69.4% |
| ALL_WIRED_NO_FILTER | $200 | $6430.69 | 1925 | $6663.00 | 2272 | 70.1% |
| ALL_WIRED_NO_FILTER | $400 | $12566.67 | 3105 | $7012.00 | 2883 | 69.9% |
| ALL_WIRED_NO_FILTER | $600 | $20433.59 | 3950 | $6292.00 | 3203 | 69.7% |

## `ALL_WIRED_NO_FILTER` — what it actually is, and isn't

Added 2026-07-22 per user request ("all active wired setups... how do I ask for that"). First checked whether this could be answered with strictly-real (non-synthetic) data: `active_setups.origin_status` only distinguishes real `ACTIVE`/`SHADOW` fires from synthetic `BACKFILL` starting **2026-07-09** — 13 days of real data exist (223 rows total, most setup_types single-digit N), nowhere near a year. User chose to fall back to a full year using all available data (including `BACKFILL`) rather than accept a 13-day answer.

`ALL_WIRED_NO_FILTER` = every setup_type that has fired at least once in the window, with **no quality gate at all** — not the strict `SETUP_STATUS` check (`CURRENT_VALIDATED_ROSTER`), not even the looser rolling N≥20/EV≥-$5 walk-forward check (`LEGACY_ROLLING`). It includes every currently-`SUPPRESS`-status setup_type (proven negative EV) mixed in with everything else.

**This is a ceiling, not a recommendation.** The jump from `LEGACY_ROLLING` ($14,836 RTH-only at $400 DLL) to `ALL_WIRED_NO_FILTER` ($38,869) reflects mostly-`BACKFILL`-origin data — i.e., the system's own retroactive calibration of what the *ideal* stop/target would have been for each historical touch, not what would have actually been traded. Removing every quality filter doesn't validate the suppressed setups; it just measures the full population's aggregate historical edge with no correction for the setups already independently proven to lose. Do not read this as "we should turn off suppression" — the entire `SETUP_STATUS`/`SUPPRESS` pipeline exists precisely because averages like this one hide real, individually-negative setups inside a bigger positive number.

## Key caveats

1. **The Globex leg's eligibility gate is looser than the RTH `CURRENT_VALIDATED_ROSTER` gate.** RTH `CURRENT_VALIDATED_ROSTER` trades require the setup_type to be non-`SUPPRESS`/`THIN_N` in the live `SETUP_STATUS` table *today*. The Globex leg uses a rolling walk-forward filter instead (N≥20 trailing trades AND EV≥-$5, recomputed day by day) — the same style as the more permissive `LEGACY_ROLLING` RTH scenario, not the strict current-roster standard. So every row's Globex contribution is not apples-to-apples with its RTH `CURRENT_VALIDATED_ROSTER` column — it's closer to "what a live, continuously-recalibrating rolling system would have fired," not "what's wired live today." Only ~12 of the ~50 simulated overnight level-touches are actually wired into `detectGlobexSetup()` right now.
2. **`CURRENT_VALIDATED_ROSTER` RTH-only is flat-to-negative** (-$1,611 to -$1,697 across DLL levels, N=128-129 trades over the *entire year*) — consistent with, and reinforcing, this session's earlier capture-ratio/sizeMultiplier findings: the honestly-currently-eligible RTH roster is thin and not clearly profitable on its own.
3. **Combining sessions under one shared DLL can reduce total P&L, not just add risk** — `LEGACY_ROLLING` Globex-Included underperforms Globex-Excluded at every DLL level (e.g. $200: $16,510 combined vs $23,962 RTH-only) because the extra Globex trades trigger more/faster lockouts (152 vs 131 lockout days) that cut off otherwise-profitable RTH trading later the same day. This doesn't repeat for `CURRENT_VALIDATED_ROSTER` (RTH leg is too thin — 128 trades/year — to be meaningfully affected either way), but it's a real, non-obvious risk-management finding worth remembering before combining any two legs under a shared daily limit.
4. Not reflected here: today's newly-validated confluence-pair bonuses (71 RTH, 5 Globex) — RTH's bonus only applies going forward from when it was wired (historical `size_multiplier` values are real, not retroactively rescored), and the Globex leg has no sizing mechanism to apply a bonus to at all yet (`OPEN_DECISION` `globex_confluence_pair_bonus_needs_sizing_mechanism`).
