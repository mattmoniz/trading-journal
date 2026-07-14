# Known Issues / Technical Debt

Living tracker. Originally compiled 2026-06-07 (see archived `docs/ARCHITECTURE_2026-06-07_superseded.md`), re-verified 2026-06-30 against current code — only items still confirmed present are listed. When you fix one, delete it (don't just mark it done — git history is the record of what was fixed and when).

1. **`App.jsx` monolith** — now ~23,200 lines (grew from ~19,000 on 2026-06-07). Single-file React component holding most dashboard/panel logic inline rather than in `src/components/`. Makes the file hard to navigate and impossible to unit test in isolation.

2. **Backup files committed to the tree**: `server/index.js.bak` and `server/index.js.backup` sit alongside the live `server/index.js` — clutter, and a real risk someone edits the wrong one. Safe to delete (git history preserves prior versions) unless there's a reason they're kept outside git tracking.

3. **Three day-type classifiers exist independently** and can disagree:
   - `caseEngine.js` → `classifyDayType` (the one tracked for accuracy via `daytype_accuracy_log`)
   - `auctionRead.js` → `dayTypeDeveloping` (separate intraday heuristic)
   - `acd.js` → an implicit OR-range-based inference embedded in route logic
   Only the `caseEngine.js` version is currently measured for accuracy. If you touch day-type logic, check which of the three you're actually changing.

4. **DTC prototype not integrated**: `scripts/dtc_phase0_test.cjs` demonstrates a direct DTC-protocol connection to Sierra Chart but is a standalone test script, not wired into the running ingestion pipeline.

5. **Dormant feature tables** (route/service code exists, table holds 0 rows because the feature has never been exercised — see [ARCHITECTURE.md](../ARCHITECTURE.md)): `phase_change_alerts`, `wyckoff_levels`, `trade_screenshots`, `trading_sessions`, `premarket_walkthroughs`. Decide to either use or remove; don't let new code assume they're populated.

6. **`caseEngine.js`'s overnight-range query (`onQ`, ~line 886) may leak lookahead when run for historical/past dates.** It filters `ts::date = $1 AND (hour>=18 OR hour<9)` — a *single*-date equality, not `$1::date - 1` for the evening leg like the equivalent (correct) 24hr-VWAP query in `morningBrief.js` does. In live/intraday use this accidentally "works" because tonight's evening bars for `$1` don't exist yet when the case is built each morning. But if `computeCase` is ever called for a past date with a full day of bars already in the DB (replay, backfill, or historical case re-derivation), `hour>=18` would pull tonight's (i.e. *after* tradeDate's own session close) bars into "overnight," not last night's. Found 2026-06-30 while wiring `OVERNIGHT_HIGH/LOW` into `phaseChangeDetector.js` (which uses the correct `priorDate`-qualified version) — not fixed yet because it needs confirmation of whether `computeCase` is ever actually invoked in a historical-replay context before changing live-session behavior.

## Re-verified fixed / no longer applicable (removed from list 2026-06-30)
- "SierraWatcher dead code, never `.start()`'d" — `index.js:235` now instantiates and mounts it via `createSierraRouter(io, sierraWatcher)`; appears wired.
- "Empty/unused tables" list — `auction_reads` is now actively populated (395 rows, used by 11 files) — no longer dormant. The remaining dormant tables are listed in item 6 above.
- 6 confirmed-dead tables (`price_bars_old`, `trades_backup_tz_fix`, `calibration_snapshots`, `session_volume_summary`, `sot_signals`, `intraday_snapshots`) were dropped 2026-06-30 — see [ARCHITECTURE.md](../ARCHITECTURE.md).

7. **`ACDSessionState` in `App.jsx` (~line 10875) is dead code** — defined with props `{ todayData, nl, pivot }` but never rendered anywhere in the app. The correct vehicle for ACD-related pre-session UI is `SessionForecastPanel.jsx` and the morning prep view. Do not edit `ACDSessionState` expecting users to see the result.


8. **Root cause of duplicate sub-minute `price_bars` ingestion not found yet.** Fixed 2026-07-13 at the read layer (`price_bars_primary` now `GROUP BY`s to guaranteed one-row-per-minute — see [ARCHITECTURE.md](../ARCHITECTURE.md)), but the underlying `price_bars` table itself still has ~14.6% of RTH minutes with 2+ sub-minute-resolution rows (up to 25 in one minute, worst cluster Jun–Aug 2025) — looks like a Sierra Chart export/import mixing in a different (possibly volume-based) bar type under the same symbol/contract on certain days, not yet root-caused. The view fix compensates correctly for all current and future reads, but new imports could keep adding more sub-minute rows to the raw table indefinitely unless the ingestion path (`priceBarService.js`) is fixed or a `CHECK`/trigger rejects sub-minute writes.

## Not re-verified (carried over unconfirmed — check before trusting)
- "Duplicate pattern-memory trigger" (cron + parallel `setInterval` both calling `runNightlyUpdate`)
- "Silent error handling" (`catch (e) {}` blocks swallowing errors without logging) throughout `index.js`
