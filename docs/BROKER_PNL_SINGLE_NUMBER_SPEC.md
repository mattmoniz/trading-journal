# One P&L number: broker truth for real trades, and resolving rows from broker fills (2026-10-19, DESIGN ONLY, nothing built)

Status: for independent design review (DeepSeek) BEFORE any code, per the higher-stakes-work rule. Related: `OPEN_DECISION broker_stop_fill_not_reflected_in_app_row_20261019`.

## Decision already made by the user
"One number everywhere" -- for a trade that really went to the broker, the P&L shown and used must be what the broker actually did (fills, commission included), not the app's model P&L (signal entry to stop/target level). Rejected alternative: keep `actual_pnl` as model and only change displays.

## Facts (measured 2026-10-19, last 60 days, rows with `origin_status IN ('ACTIVE','SHADOW')`, resolved)
- 6,867 SHADOW-origin rows: no broker order ever, model P&L only, sum -$23,979.
- 1,084 ACTIVE-origin rows; only **98 (9%)** have `broker_pnl` (written by `brokerPnlWriter.js` on EXIT/STOP/TARGET fill; `pnl_source='BROKER'`; first row 2026-09-29). By resolution, on the rows where both numbers exist: STOP_HIT n=29 model avg -$58.4 vs broker -$161.4 (gap -$103); ROTATION_FLIP n=39 model -$16.2 vs broker +$24.0; TARGET_HIT n=22 model +$97.8 vs broker +$86.9; INVALIDATED n=5 -$67.0 vs -$10.1; TIME_EXPIRED n=2 -$25.8 vs +$319.8. So the model has been flattering real stop-outs by ~$100 each (real stops lose more: market-escalated entries, wider stops on some families, slippage).
- 8 filled-entry rows in 30 days have no `broker_pnl` (6 STOP_HIT, 2 ROTATION_FLIP).
- The gap case that started this: setups 136552/136553, broker stop filled 13:17:41 (tick 29807.00) while the bar feed's high was 29806.75, so the app never resolved the row; 44 min later the rotation flip closed it at model +47.5 vs broker -37.
- Consumers of `actual_pnl`: `scripts/backtest_setup_status.mjs` (24 refs; SETUP_STATUS/promotion/suppression, `REAL_TRADE_FILTER`), `server/public/quick-check.html` (50 refs, never reads `broker_pnl`), `update_optimal_stops.mjs`, ML meta-labeling labels, rigor/replication scripts, the performance pages. `dllGate.js` already uses `broker_pnl` (with a worst-case-risk fallback when absent).
- Where a broker STOP/TARGET/EXIT fill is handled (`server/services/sierraChart/reconciliation.js` ~883): it writes `broker_pnl` and frees the position slot, but never touches `active_setups.status/resolution/actual_pnl`.

## Proposal (for critique, not decided)
1. **Resolve from broker fills.** In the fill handler, when a STOP or TARGET order fills and the row is still `ACTIVE`/unresolved, atomically resolve it (`UPDATE ... WHERE id=$ AND status='ACTIVE' AND resolved_at IS NULL RETURNING`, the same guard `rotationFlipClose.js` uses): `resolution='STOP_HIT'|'TARGET_HIT'`, a new `resolution_method` value that fits VARCHAR(20), `resolved_at` = broker fill time. Already-resolved rows (flip got there first) are left alone. No new order code.
2. **One number.** Preserve the model value first: add `model_pnl` (backfilled = current `actual_pnl` for every row, immutable afterwards), then for rows with `broker_pnl`, `actual_pnl := broker_pnl` (written when broker_pnl is written, and backfilled for the 98 existing). Every consumer keeps reading `actual_pnl`; nothing is re-pointed. Rows without a broker result keep the model number.
3. **Statistics.** Decide what `REAL_TRADE_FILTER`/SETUP_STATUS/OPTIMAL_STOP do with a population where ~9% of ACTIVE-origin rows now carry real fills and the rest carry model numbers: pool them, calibrate on model only (`model_pnl`), or report both.
4. **Display.** `quick-check.html` then shows real numbers for real trades automatically; consider labelling.

## Questions for the reviewer
1. Is overwriting `actual_pnl` with `broker_pnl` (model preserved in `model_pnl`) safe, or does it break an invariant somewhere (CumPL-diff P&L method, `computeRigor`, `dayBlockedBootstrapCI` day-weights, the `is_cluster_primary` dedup, cluster siblings that share one broker position)? Cluster siblings: several rows can share one real fill -- which row gets the broker number, and can the sum double count?
2. Calibration: `OPTIMAL_STOP`/`SETUP_STATUS` pick stops/targets by simulating bars. If a real row's `actual_pnl` is a real fill result, is mixing it with simulated rows in the same EV a methodology error (the baseline-must-be-computed-the-same-way rule)? Should calibration read `model_pnl` while displays read `actual_pnl`? That reintroduces two numbers -- is there a cleaner split?
3. The broker-fill resolution: failure modes of resolving from a broker STOP/TARGET fill: races with `resolveSetupsByPrice`, `structurallyInvalidateSetups`, `expireStaleSetups`, `closeOnRotationFlip`; partial fills; a fill for an order the app cancelled; out-of-order/duplicate messages (the terminal-state lattice in `handleOrderUpdate`); account-label mismatch rows; the Sim1 vs Evaluator venue differences. Which `resolution_method` and `actual_pnl` should a broker-resolved row carry?
4. Backfill/repair: the 98 rows, the 8 missing-`broker_pnl` rows, the 9 rows whose resolution disagrees with the broker (3 from 10-07 have a different cause). What must be backed up (docs/DB_BACKUP_CATALOG.md) and in what order?
5. The ~100 USD STOP_HIT gap (n=29) is itself a finding: is the model's STOP_HIT P&L wrong for real trades, or are real stops systematically different (wider-stop families, market escalation)? What would you check before trusting either?
6. Sequencing and rollout order, rollback, and what tests you would require before each step.

---
## Review outcome and audit (2026-10-19, same evening) -- DeepSeek response saved at scratch/deepseek_response_brokerpnl_spec_20261019.md

Claude re-checked DeepSeek's key claims against code and live data before accepting any of them.

**Verified and accepted**
- Calibration reads `actual_pnl` directly: `update_optimal_stops.mjs:932-936` divides stored `actual_pnl` by the MODEL stop/target distance for its dollars-per-point, and `backtest_setup_status.mjs:346` averages it into `real_ev`. Putting a real fill in that numerator corrupts both. This is the strongest finding and partly conflicts with "one number everywhere": calibration must keep reading the model value.
- A cancelled-then-late-filled stop would resolve a row the app already closed: `shouldApplyStatus` (`reconciliation.js:708`) lets FILLED correct CANCELED/REJECTED regardless of timestamp. Step 1 needs a "leg still live from the app's view" guard.
- `model_pnl` is only useful if all ~9 writers of `actual_pnl` keep it populated; `broker_pnl` has two `UPDATE` sites (`brokerPnlWriter.js:21`, `brokerPnlResolver.js:190`) -- the silent-close path calls the first, so it is not a third -- all must be hooked.
- Resolution label and P&L would decouple on 46 of the 98 rows (flip/expired/invalidated); decide it explicitly. "Latest exit wins" in `recordBrokerPnlForSetup` can replace a stop-fill number with a later exit's; `filled_quantity` is not threaded through.

**Rejected after checking**
- "Siblings never get real fills; the singleton means one real position at a time" is WRONG today: 43 of 114 recent filled-entry rows are `is_cluster_primary=false` with `origin_status='ACTIVE'`, and up to 9 `position_slot`s were open at once on 10-19. Every sibling has its own entry/exit orders and its own `broker_pnl`, so one fill is not double counted, but the real population includes siblings that the `is_cluster_primary` dedup in the statistics drops. Separate open question for the statistics design.
- "The model systematically flatters stop-outs by ~$100" (Q5) is an outlier artifact. Of the 29 STOP_HIT rows with a broker P&L: 24 were closed by the broker's own STOP fill and averaged broker -$31 vs model -$58 (the broker did BETTER); 5 were closed by a market flatten and averaged -$787, driven by two 2026-09-29 first-night rows (ids 127681 MR1, 127693 PD_POC: exits filled at 31512.25, entries ~30437/30637, broker_pnl -2152/-1753) from the known first-night misattribution incident. Three more rows show the opposite divergence: model STOP_HIT -134/-84.5 but broker +1069.5/+610.5 (ids 135009, 134806; the broker stop was cancelled and the position later exited at a profit).

**Consequences for the plan**
1. The 2026-09-29 incident rows must be flagged and excluded before any `actual_pnl := broker_pnl` (use the existing flag-and-preserve boolean-basis convention, not deletion), otherwise the single number imports an order-bug loss as if it were a trade result.
2. `model_pnl` stays and calibration keeps reading it; one number is shown/used everywhere else. Needs the user's OK because it narrows the "one number" decision.
3. Rollout order from the review stands (measure, schema + model_pnl, broker-fill resolution behind a flag with the live-leg guard, then the overwrite with all writers hooked, then calibration/display split, then recalibrate).
