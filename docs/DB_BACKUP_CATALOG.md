# Database Backup Table Catalog

Every `*_backup_*` table currently sitting in the live database, what it's a snapshot
of, why it was taken, and what it's for. Built 2026-07-17 after realizing there was no
index of these anywhere — several were created across multiple sessions and nothing
pointed back to them, which is exactly the "landmine for a future session" class of risk
this whole codebase's documentation conventions exist to prevent. If you find a
`*_backup_*` table NOT listed here, that's a real gap — add it, or if you created one
and are reading this later, add it now.

**Convention going forward**: any script that creates a backup table (per
`docs/DB_MIGRATION_PROTOCOL.md`'s "backup before destructive change" step) must add an
entry here in the same commit. A backup nobody can identify six months later might as
well not exist — worse, it's a table someone will eventually delete without knowing what
they're losing, or leave forever without knowing it's safe to drop.

## How to use these for spot-checking an anomaly

If a number looks wrong today and you suspect a repair/migration changed something it
shouldn't have, these are exactly what you diff against:
```sql
-- Compare a specific row's before/after
SELECT * FROM active_setups WHERE id = 12345;
SELECT * FROM active_setups_pnl_rescale_backup_20260714 WHERE id = 12345;

-- Compare aggregate stats before/after for a setup_type
SELECT setup_type, COUNT(*), AVG(actual_pnl) FROM active_setups_pnl_rescale_backup_20260714 GROUP BY 1;
SELECT setup_type, COUNT(*), AVG(actual_pnl) FROM active_setups WHERE resolution_method='BACKFILL' GROUP BY 1;
```
Pick the backup whose date is right before the fix you suspect, per the table below.

## Column schemas

Every backup below is `CREATE TABLE x_backup AS SELECT [*|columns] FROM <source>` — same
columns as the live source table **as of the backup date**, not a separately-documented
schema. If the live table has since had columns added (e.g. `active_setups.origin_status`,
added 2026-07-17, doesn't exist in any of the 2026-07-14 backups), the backup simply
predates that column. Check `\d <backup_table_name>` directly if you need the exact
column list — these are real point-in-time snapshots, not projections.

## Catalog

| Backup table | Taken | Rows | Snapshot of | Why | Source script |
|---|---|---|---|---|---|
| `active_setups_pnl_rescale_backup_20260714` | 2026-07-14 | 6,375 | `active_setups` (all `resolution_method='BACKFILL'` rows, pre-fix) | Before rescaling `actual_pnl` from the wrong `PT=5,COMM=5` constant to the real MNQ `$2/pt,$1 comm` — see CLAUDE.md's P&L hard rule. | `scripts/repair_dollars_per_point.mjs` |
| `active_setups_backfill_backup_20260714` | 2026-07-14 | 3,764 | `active_setups` (all `BACKFILL` rows, pre-fix) | Before deduplicating a Sierra Chart TAL structural quirk (same position logged on multiple lines, BP/EP suffix) that had caused duplicate `BACKFILL` inserts. | `scripts/repair_backfill_duplicate_bars.mjs` |
| `active_setups_cam_window_backup_20260714` | 2026-07-14 | 139 | `active_setups` (CAM_R4/S3 setup_types, pre-fix) | Before re-simulating CAM_R4/S3 level-fade outcomes with the live poller's real "first touch anywhere in RTH" window instead of the narrower 10:30am-noon window `backfill_level_fades.js` originally used (CLAUDE.md hard rule #10 — the window-mismatch bug that flipped several setup_types from winners to losers once corrected). | `scripts/repair_cam_r4_s3_window_mismatch.mjs` |
| `active_setups_top8_window_backup_20260714` | 2026-07-14 | 881 | `active_setups` (top-8-by-volume level families, pre-fix) | Same window-mismatch fix as above, first wave (highest-volume level families). | `scripts/repair_top8_window_mismatch.mjs` |
| `active_setups_remaining_window_backup_20260714` | 2026-07-14 | 1,688 | `active_setups` (remaining level families not covered by the top8/cam/ib/weeklyvwap waves) | Same window-mismatch fix, catch-all wave for everything not covered by the other 4 repair scripts. | `scripts/repair_remaining_window_mismatch.mjs` |
| `active_setups_ib_window_backup_20260714` | 2026-07-14 | 1,389 | `active_setups` (IB-dependent setup_types, pre-fix) | Same window-mismatch fix, IB-dependent wave. Also caught the deeper IB_HIGH/IB_LOW **definitional** mismatch (60min vs 30min IB — see `level_prices_ib_backup_20260714` below), not just a window issue. | `scripts/repair_ib_dependent_window_mismatch.mjs` |
| `active_setups_weeklyvwap_window_backup_20260714` | 2026-07-14 | 0 (empty — no rows matched at backup time) | `active_setups` (WEEKLY_VWAP setup_types, pre-fix) | Same window-mismatch fix, final wave, run after the `WEEKLY_VWAP` lookahead bug (see `level_prices_weeklyvwap_backup_20260714`) was already fixed — 0 rows suggests either the fix order left nothing to re-simulate at backup time, or the WHERE clause matched nothing; not independently re-investigated, flagging rather than guessing. | `scripts/repair_weekly_vwap_window_mismatch.mjs` |
| `level_prices_ib_backup_20260714` | 2026-07-14 | 2,457 | `level_prices` (pre-fix, full table) | Before fixing `compute_levels.js`'s IB_HIGH/IB_LOW/IB_MID + PD_IB_* blocks — they computed a 30-minute Initial Balance while live `acd.js` used 60-minute, a genuine **definitional** mismatch (different price levels, not just a timing one). User confirmed standardizing on 60-minute (git history showed it predates the 30-min version by a month) before this was applied. See `docs/KNOWN_ISSUES.md` item 9. | `scripts/compute_levels.js --backfill` (repair, not the named script above) |
| `level_prices_weeklyvwap_backup_20260714` | 2026-07-14 | 415 | `level_prices` (pre-fix, full table) | Before fixing a genuine lookahead bug in `compute_levels.js`'s `WEEKLY_VWAP` formula — it queried through that week's Friday close regardless of the date being computed, so any date before Friday reflected data that hadn't happened yet. Independently corroborated by Gemini. See `docs/KNOWN_ISSUES.md` item 10. | `scripts/compute_levels.js --backfill` |
| `active_setups_maemfe_backup_20260717` | 2026-07-17 | 430 | `active_setups` (rows with `mae_points`/`mfe_points` > 1000, pre-fix) | Before fixing the ES-symbol-contamination bug in `backfill_mae_mfe.mjs`/`maeMfeReplay.js` (missing `symbol='NQ'` filter let a same-date `ES` futures batch leak into NQ trade replays, producing impossible 11,000+ point excursions). See `docs/OPEN_THREADS.md` 2026-07-17. | `scripts/backfill_mae_mfe.mjs` (manually backed up first, not built into the script itself) |
| `trades_backup_20260716` | 2026-07-16 | 40,453 | `trades` (full table, pre-dedup) | Before the 3-pass trades dedup cleanup (2 mass-reimport events from the naive-timestamp EDT/EST bug + a Sierra Chart TAL structural quirk logging one position across multiple lines) that took `trades` from 40,453 → 31,416 rows. Full account in CLAUDE.md's "Never parse a naive timestamp" hard rule. | `scripts/repair_trades_dedupe_20260609_batch.mjs` / `..._20260422_batch.mjs` / `..._remaining.mjs` |
| `rule_overrides_backup_20260716` | 2026-07-16 | 21 | `rule_overrides` (full table) | Before dropping the table entirely — confirmed dead (the only creator route, `POST /rule-overrides`, had zero UI callers; `patternMemoryUpdate.js` only read/updated existing rows, never created new ones). User-approved deletion. | Manual (dead-table cleanup session) |
| `trade_screenshots_backup_20260716` | 2026-07-16 | 0 (table was already empty) | `trade_screenshots` (full table) | Same dead-table cleanup as `rule_overrides` — confirmed dead (full multer upload pipeline existed, zero UI caller). | Manual (dead-table cleanup session) |

## Caveats

- **Most of these backups use `DROP TABLE IF EXISTS ... ; CREATE TABLE ... AS`** inside their own repair script (check the script column above) — meaning if that exact script is ever re-run, it will silently **overwrite its own backup** with a fresh pre-state snapshot from whenever it's re-run, not preserve the original 2026-07-14 one. All of these scripts are one-off historical repairs not wired into any cron, so this is low risk in practice, but don't assume a backup table's contents are frozen forever just because it looks like a snapshot — check whether its source script could plausibly run again first.
- **None of these are on any retention/cleanup schedule.** They sit in the live DB indefinitely until someone manually drops them. `trades_backup_20260716` alone is 71MB — not enormous, but worth knowing these aren't free. There's no current policy on when it's safe to drop one (e.g. "N days after the fix has been live with no regressions reported") — if that's wanted, it needs a deliberate decision, not an assumed default.
- This catalog is a snapshot of what existed as of 2026-07-17. If you're reading this later and the live `information_schema.tables` list doesn't match, trust the live query over this file and update it.
