# Trading Journal Architecture

## System Overview

```
┌──────────────────────┐         ┌──────────────────────────────────┐
│   React Frontend     │ ◄─────► │   Express Backend                │
│   (Vite, port 3000)  │  HTTP   │   (port 3002)                    │
│                      │  +WS    │                                  │
│  - Dashboard         │         │  - 27 route modules (/api/*)     │
│  - Calendar          │         │  - 18+ service modules           │
│  - All Trades        │         │  - Sierra Chart file watcher     │
│  - ACD / Tearsheet   │         │  - Socket.IO (live updates)      │
│  - Scenario/Backtest │         │  - node-cron scheduled jobs      │
│  - Settings/Risk     │         │    (morning brief, EOD reports,  │
└──────────────────────┘         │     pattern memory, coaching)    │
                                  └──────────┬───────────────────────┘
                                             │ SQL
                                             ▼
                                  ┌──────────────────────────────────┐
                                  │   PostgreSQL DB                  │
                                  │   (port 5432, db: trading_journal)│
                                  │                                  │
                                  │  ~49 core tables + price_bars    │
                                  │  monthly partitions (2022-2027)  │
                                  └──────────┬───────────────────────┘
                                             ▲
                                             │ import
                                  ┌──────────────────────────────────┐
                                  │  Sierra Chart TAL file watcher   │
                                  │  (chokidar) + manual import      │
                                  └──────────────────────────────────┘
```

`scripts/` contains ~37 standalone analysis/backtest scripts run manually via `node` — they are **not** wired into the running app (a few exceptions are scheduled reporters, noted below). 87 one-off/superseded scripts moved to `scripts/archive/` on 2026-07-09 — safe to browse but not maintained.

---

## Ports & Dev Workflow

| Service | Port | Notes |
|---|---|---|
| Vite frontend | 3000 | `vite.config.js`; proxies `/api`, `/uploads`, `/socket.io` to 3002 |
| Express backend | 3002 | Set via `.env` `PORT=3002` (code default is 3001 — `.env` wins) |
| PostgreSQL | 5432 | db name `trading_journal` |

- Start everything: `./start.sh` (kills stale processes on 3000/3001/3002/5173, starts server + client via `concurrently`)
- Stop everything: `./stop.sh` or `fuser -k 3002/tcp`
- Server only: `npm run server` (nodemon) — Client only: `npm run client` (vite)
- DB schema bootstrap: `npm run db:setup` (runs `server/schema.sql` — only covers the original 5 core tables; everything else was added ad hoc directly against the DB, not via tracked migrations)

---

## Database

### Schema source of truth
`server/schema.sql` is a full `pg_dump --schema-only` snapshot of the live DB (148 tables/views, regenerated 2026-07-19 after the session_pnl/3M-VA/PD2-2DPOC fixes added 5 backup tables — see docs/DB_BACKUP_CATALOG.md). There is still no tracked migration history — tables beyond the original 5 (`daily_logs`, `trades`, `custom_field_definitions`, `setup_types`, and originally `trade_screenshots`, dropped 2026-07-16) were created ad hoc directly against the live DB — so `schema.sql` is a point-in-time dump, not hand-maintained DDL, and will drift again as soon as a table is added/altered without regenerating it. Regenerate with:

```bash
PGPASSWORD=$DB_PASSWORD pg_dump --schema-only --no-owner --no-privileges --no-comments \
  -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME \
  | sed '/^\\restrict /d; /^\\unrestrict /d' > server/schema.sql
```

`npm run db:setup` runs this file against an empty database — it is **not idempotent** (no `IF NOT EXISTS`), so it will error if run against a DB that already has these tables. To inspect current live schema directly instead of reading the dump:

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '<table>' ORDER BY ordinal_position;
```

### Table clusters

| Cluster | Tables | Purpose |
|---|---|---|
| Core journal | `daily_logs`, `trades`, `custom_field_definitions`, `setup_types` | Manual + Sierra-imported trade records, daily notes |
| Price data | `price_bars` (parent, `PARTITION BY RANGE (ts)`) + `price_bars_YYYY_MM` (monthly partitions, 2022–2027) + `price_bars_primary` (view joining `price_bars` to `price_bars_contract_calendar` to pick the front-month contract per date, **then `GROUP BY` symbol/contract/`date_trunc('minute', ts)`** — fixed 2026-07-13, see below), `price_bar_ingests` | 1-min OHLCV bars from Sierra Chart, true Postgres declarative partitioning by month |
| ACD / opening range | `acd_daily_log`, `acd_weekly_log`, `acd_monthly_pivot`, `acd_backtest_results`, `acd_setup_events` | Opening range, structural levels, day-type classification, A/B/C signal state |
| Auction / value | `developing_value_log`, `auction_reads`, `auction_history` | POC/VAH/VAL migration tracking, opening-call classification |
| MGI levels | `level_prices` | 68 computed market-generated-info levels per session date (PD VA, overnight, OR, VWAP [RTH/weekly/monthly], floor pivots, camarilla, weekly/monthly/quarterly/yearly VA, 10D_IB_MID, PD_OR_MID). PK: `(trade_date, level_name)`. Backfilled Nov 2023–Jul 2026 (yearly VA only from Feb 2024 — needs a full prior calendar year of data, correctly null before that). Regenerated by `scripts/compute_levels.js`; cron fires 9:30 PM ET Sunday. |
| Setups & performance | `active_setups`, `setup_outcome_backtest`, `setup_daytype_winrates`, `setup_move_stats`, `setup_correlation_cache` | Live setup tracking + their historical backtested edge stats. `active_setups.origin_status` (added 2026-07-17) is immutable at insert and never touched by any resolution UPDATE — preserves whether a resolved trade fired `ACTIVE` (real, live-visible), `SHADOW` (suppressed, background-only), `BACKFILL` (synthetic historical, never fired live), or `UNKNOWN` (pre-2026-07-09, unrecoverable — no `SETUP_STATUS` snapshot history exists that far back). `status` alone cannot answer this since it gets overwritten to `RESOLVED`/`EXPIRED` on resolution — see Opus Audit #3 (`scratch/opus_audit_3_results.md`) for the full investigation and `.claude/hooks/session-start.sh`'s `SHADOW_VALIDATION` section for the resulting closed-loop check. `runner_trail_width`/`breakeven_armed_at`/`runner_peak_price`/`runner_trail_price` (added 2026-07-19) support the breakeven-then-trail exit mechanism (docs/SCALEOUT_RUNNER_SPEC.md): a non-null `runner_trail_width` marks a row as using the dynamic path-dependent exit instead of the fixed stop/target logic in `resolveSetupsByPrice()` (`server/routes/acd.js`) — set once at insert time from `performance_audit` `signal_type='BREAKEVEN_TRAIL_TEST'` (never hardcoded). The other 3 columns are recomputed from scratch on every poll (the function already re-walks the full bar range from `fired_at` every call) and written purely for frontend display of "armed, trailing" state — never read back as input. First (and currently only) live variant: `FLOOR_R1_FADE_SHORT_TRAIL`, forced `SHADOW`-only until N≥20 live-resolved trades (see `CONDITIONAL_VARIANTS` in `server/config/setupTypes.js`). Every terminal resolution (`TARGET_HIT`/`STOP_HIT`/`TRAIL_EXIT`/`TIME_EXPIRED`) computes a real `actual_pnl` as of 2026-07-20 — `resolveSetupsByPrice()`'s general branch and `expireStaleSetups()`'s backstop path both mark-to-market against the last known price rather than leaving a timed-out row null; see CLAUDE.md's hard rule for the incident this fixed. |
| Pattern mining | `pattern_discoveries`, `pattern_stats`, `dynamic_edges_mining`, `condition_memory` | Nightly-mined OHLC/condition patterns and their hit rates. `pattern_discoveries.window_type` (added 2026-07-17) distinguishes two independent scan modes sharing the table and dimension logic (`mineLevelFades()` in `patternScannerService.js`, params `{windowDays, windowType, keyPrefix}`): `ROLLING_90D` (default, nightly via `server/index.js`, re-evaluates fresh every run, DEGRADEs anything that doesn't re-qualify in the current 90-day window) and `ALL_TIME` (full price history, weekly via `scripts/mine_level_fades_alltime.mjs` in `run_weekly_backtests.sh`, `pattern_key` prefixed `ALLTIME:` to avoid colliding with rolling entries, independent ACTIVE/DEGRADED lifecycle). Built because the rolling window structurally can't accumulate N>=20 for rare/low-frequency patterns (e.g. a specific dow×hour combo that only occurs a few times a year) — first all-time run (2026-07-17, 417 RTH trading days, ~194s) surfaced 15 new patterns invisible to the rolling scan, e.g. `IB_HIGH×Fri×15:00` (74% WR, N=23). |
| Risk / behavioral guardrails | `post_loss_cooldowns`, `dll_daily_events`, `profit_lock_config`, `profit_lock_events`, `risk_settings` | Daily loss limit tracking, 1PM profit-lock guard, cooldown-after-loss enforcement |
| Sessions & timing | `trading_sessions`, `session_analysis`, `session_patterns` | Per-session OHLC/texture metrics (Monday texture, Friday bias, etc.) |
| Review & coaching | `morning_briefs`, `premarket_walkthroughs`, `daily_coaching`, `weekly_assessments`, `trade_annotations`, `trade_feedback`, `trade_timeline_events` | Persisted output of scheduled/manual review jobs and trade-level annotations |
| AI coach | `playbook_conversations`, `daily_ai_reviews`, `ai_cost_log` | Live session assessments (Sonnet), per-day structured setup ratings (Haiku, auto-runs 5 PM ET), cost ledger with $5 boundary socket alerts. `daily_ai_reviews.stop_target_analysis` JSONB holds per-setup ratings (1-5 stars, entry_quality, stop_verdict, t1_verdict, recommended pts). Auto-persist on generate writes `AI_SETUP_REVIEW` rows (signal_type='AI_SETUP_REVIEW') to `performance_audit`. |
| Engine evaluation | `engine_reads`, `daytype_accuracy_log`, `performance_audit`, `phase_change_alerts`, `phase_change_backtest_results`, `level_regime_performance`, `monte_carlo_runs` | Forward-test/backtest results for every signal system — **this is where backtest scripts write findings** (see `performance_audit`) |
| Misc config | `account_settings`, `settings_todos`, `import_log`, `process_log`, `macro_events` | App settings, scheduled-job run log, macro calendar |

### Dormant feature tables (code exists, barely used — not dead, just idle)

`phase_change_alerts`, `trading_sessions` currently hold 0 rows because the feature has never been exercised. Don't drop these without also deciding to remove the feature — they're a product decision, not cleanup.

`premarket_walkthroughs` is a special case, corrected 2026-07-16 (this note previously said it also held 0 rows — wrong, checked directly and it holds 56, and is still being actively written to nightly by `scripts/daily_coaching.js`'s auto-seed step, which generates real regime/level content for the next trading day). No UI has ever been built to read or add to it, and the nightly auto-seed has silently stopped producing new rows since 2026-07-08 for a reason not yet root-caused — flagged in `docs/OPEN_THREADS.md`. Do not drop this table; the write side is live, unlike the other two.

`rule_overrides` and `trade_screenshots` were dropped 2026-07-16 (dead-ends audit, user-confirmed) — both genuinely had no route ever called from any UI, and `rule_overrides`' data (21 rows) traced to a one-time auto-tagged backfill, not organic use. Backed up to `rule_overrides_backup_20260716`/`trade_screenshots_backup_20260716` (the latter was empty, 0 rows) before dropping.

`wyckoff_levels` was dropped 2026-07-04 (0 rows, route removed, no frontend references).

### 2026-06-30 dead table cleanup

Audited every non-partition table for code references (grep across `server/` + `scripts/` + `src/`) and row counts. Six tables had **zero references anywhere in the codebase** and were dropped after a full schema+data `pg_dump` backup at `backups/dead_tables_backup_20260630_090329.sql` (118MB — contains real account identifiers and trade-level financial data from `trades_backup_tz_fix`, so it's **gitignored, local-only, not in git history** — restore from that local file if any of these tables are ever needed back):

- `price_bars_old` (633,844 rows) — pre-partition-migration backup; `scripts/migrate_price_bars_partition.sh` itself flagged this as droppable once the new partitioned `price_bars` was confirmed working
- `trades_backup_tz_fix` (35,813 rows) — backup taken before the timezone-parsing fix in `db.js`, long since superseded by the live `trades` table
- `calibration_snapshots`, `session_volume_summary`, `sot_signals` (0 rows) — scaffolded, never wired to surviving code
- `intraday_snapshots` (14 rows) — small amount of orphaned data, no code reads it

### 2026-07-13 `price_bars_primary` duplicate-minute-bar fix

Discovered while auditing a new minute-bar pattern scanner: `price_bars` (documented above as "1-min OHLCV bars") actually had sub-minute duplicate ticks for ~14.6% of RTH minutes in the NQ history (some single minutes had up to 25 rows — an ingestion issue, not a data-model choice; the worst offenders cluster in Jun–Aug 2025). The old `price_bars_primary` view passed these through as plain per-row `SELECT`s with no tiebreak among same-minute rows, so **any consumer that walked results positionally (`bars[i-N]` = "N minutes ago") got non-deterministic results** — proven by running the identical query twice back-to-back and getting different OHLCV values back for the same nominal minute.

Fixed at the view level (not per-consumer) since `price_bars` is documented as 1-minute data and nothing legitimately depends on sub-minute granularity through this view: `price_bars_primary` now `GROUP BY`s on `(symbol, contract, date_trunc('minute', ts))`, taking `open`=first tick/`close`=last tick (via `array_agg(...ORDER BY ts)[1]`, deterministic regardless of physical scan order), `high`=MAX, `low`=MIN, `volume`/`num_trades`/`bid_volume`/`ask_volume`=SUM. One view fix corrects every downstream consumer automatically — no code changes needed in `acd.js`, `caseEngine.js`, `acdService.js`, etc.

**Not yet done**: every live setup's stop/target calibration in `performance_audit` (from `backtest_unified.js`, `update_optimal_stops.mjs`, and the rest of the weekly backtest suite) was computed against the old, contaminated bar data and needs a full recompute against the fixed view. That's flagged in `docs/OPEN_THREADS.md`, not done as part of this fix — large enough to warrant its own session.

### Key Columns in `trades`

```
trades
├── id, log_date (FK → daily_logs), entry_time, exit_time
├── symbol, direction (LONG/SHORT), quantity, entry_price, exit_price
├── pnl, fees, setup_type, trade_notes
├── tags                # JSONB array
├── level_proximity     # JSONB — AT_LEVEL/LATE/CHASING tag + top-3 nearest level_prices entries for BP fills
└── custom_fields       # JSONB — sierra_data, account, sierra_row, etc.
```

Key JSONB paths used by Sierra Chart imports:
- `custom_fields->>'account'` — account identifier
- `custom_fields->'sierra_data'->>'Entry DateTime'` — raw entry datetime (may end with ` BP`)
- `custom_fields->'sierra_data'->>'Exit DateTime'` — raw exit datetime (may end with ` EP`)
- `custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)'` — running account total (use for P&L, see below)
- `custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)'` — per-session P&L at EP boundary
- `custom_fields->'sierra_data'->>'sierra_row'` — original file row number (sort tiebreaker)

### P&L Calculation (CumPL Diff) — critical, don't regress this

Raw fill sums overcount P&L when positions are scaled. The correct approach uses `Cumulative Profit/Loss (C)` diffs at EP (flat-to-flat) boundaries:

```sql
WITH ep_fills AS (
  SELECT log_date, custom_fields->>'account' as account, exit_time,
    CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\.[0-9]+)?$'
    THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
  FROM trades WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP' AND exit_time IS NOT NULL
),
last_ep_per_day AS (
  SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl
  FROM ep_fills ORDER BY log_date, account, exit_time DESC
),
daily_pnl_per_account AS (
  SELECT log_date,
    cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) as session_pnl
  FROM last_ep_per_day WHERE cum_pl IS NOT NULL
),
daily_cuml AS (
  SELECT log_date, SUM(session_pnl) as cum_daily_pnl
  FROM daily_pnl_per_account GROUP BY log_date
)
-- JOIN daily_cuml, use COALESCE(cum_daily_pnl, SUM(t.pnl), 0) as daily_pnl
```

Fallback to `SUM(t.pnl)` only for older Activity Log format data that lacks CumPL fields. Both `/api/daily-logs` and `/api/stats/daily` implement this pattern — keep them in sync if you touch one.

### TAL Markers & Dedup

- **BP** (`Entry DateTime` ends with ` BP`): position opened from flat — session start
- **EP** (`Exit DateTime` ends with ` EP`): position returned to flat — session end, authoritative P&L boundary
- Dedup key: `(entry_time, exit_time, symbol, direction, quantity, entry_price, exit_price, account)`. If the import file contains N rows matching a key and M already exist, only `N − M` are inserted — preserves legitimate repeated scale-ins without duplicating on re-import.

### Account filter (shared state)
`/api/accounts` returns accounts ordered by most recently active; the app defaults to `data[0]`. Selected account is lifted to the `App` component so Calendar and Dashboard stay in sync.

---

## Backend Structure

```
server/
├── index.js              # Express app entry — mounts all 27 routers, Socket.IO, cron jobs, Sierra watcher init
├── db.js                 # pg Pool (max: 60, connectionTimeoutMillis: 8000 — raised from 20/2000
│                           2026-07-15 after parallelizing Morning Prep's endpoints internally
│                           caused real connection-pool exhaustion under concurrent page load;
│                           Postgres max_connections=100) + query() helper; also fixes a
│                           timestamp/timezone parsing bug globally
├── schema.sql             # Original 5-table schema only (see DB section above)
├── sierra.js              # TAL file parser, chokidar watcher
├── routes/                # 27 files, one per domain, all mounted under /api
├── services/               # 19 files, business logic called by routes (and by cron jobs in index.js)
├── scripts/setupDb.js      # Runs schema.sql
└── uploads/                # Screenshot storage, served as static files
```

### Routes (`server/routes/`, mounted under `/api`)

| Domain | File | Purpose |
|---|---|---|
| Core journal | `dailyLogs.js`, `trades.js`, `sierra.js` | Daily logs CRUD, trade CRUD, TAL import/history, chart uploads |
| Stats/analytics | `stats.js`, `tearsheet.js`, `backtest.js` | Overview KPIs, by-hour/day breakdowns, risk-of-ruin, tearsheet (P&L distribution, timing heatmap, MAE, rolling expectancy), Kelly sizing |
| ACD / opening range | `acd.js` (largest route file, ~6000 lines) | OR computation, structural levels, day-type, NL30, pivots, A/B/C signal backtest. Also hosts the **Level Fade Alpha Engine**: 50+ pre-computed key levels (PD_*, CAM_*, FLOOR_*, WPP, weekly/monthly VA, OR/IB), proximity detection at 15pt, sizeMultiplier stack (streak depth / overnight alignment / approach delta / elite zone / recency / confluence pair / INSIDE_VALUE / DAY_TYPE_ALPHA / NL30 regime / stacking suppress at 7+ / revisit latency / VWAP extension / OR expansion bias / TURBULENT regime persistence), setup tier badges (PRIME/SOLID/MARGINAL/WEAK/KILL), unified data-driven suppression (`_suppressedSetups` from `performance_audit` SETUP_STATUS — hardcoded list removed 2026-07-09), early-touch backfill (SHADOW). Gate lowered from 60-bar (10:30 AM) to 3-bar (~9:34 AM) on 2026-07-05. **Trade-generation backfill coverage: 56 of 64 unified level types now have real `SETUP_STATUS`/`OPTIMAL_STOP` calibration** (up from 34-35 before 2026-07-18 — `scripts/backfill_unified_levels.mjs` added 22 previously-uncovered levels: `PD_HIGH/LOW/CLOSE`, `DAILY_OPEN`, `WEEKLY_OPEN`, `MONTHLY_OPEN`, `FLOOR_R2/R3/S2/S3`, `ONH/ONL`, `PM_HIGH/LOW/VAH/VAL`, `PW_HIGH/LOW/VAH/VAL/POC`, `10D_IB_MID`). Still uncovered: `3M_VAH` (deliberately excluded live, WR=7.1%). `3M_VAL`/`3M_POC`'s lookahead bug (`compute_levels.js`'s window used to end at `date` inclusive, the only VA/POC level in that file that did) was fixed 2026-07-19 — now bounds at `date-1` like every sibling VA/POC level; had zero live calibration history at fix time, so no reconciliation needed, just a `level_prices` re-backfill (`3m_val_poc_same_day_lookahead_risk` `OPEN_DECISION`, resolved). `PD2_VAH`/`PD2_VAL`/`2D_POC` are separately tested and confirmed genuinely negative EV (`RESEARCH_CLAIM` `2d_poc_fade_no_edge`) — as of 2026-07-19 this finding is now actually wired into the live suppression pipeline (`scripts/backtest_pd2_2dpoc_complete.mjs` writes real `SETUP_STATUS` rows: `SUPPRESS` for the 3 LONG variants, `THIN_N` for the thin SHORT ones), closing a real gap where the confirmed finding had a display-only patch (`CONFIRMED_NO_EDGE_OVERRIDE`, now removed) but no live-candidate-construction protection at all (`backtest_unified_pd2_2dpoc_methodology_stale` `OPEN_DECISION`, resolved). **4 new levels added 2026-07-19** (`MONTHLY_VWAP`, `PY_VAH`/`PY_VAL`/`PY_POC` — prior-complete-calendar-year value area, see `compute_levels.js`'s `yearBounds()`) are wired into `keepLevelsAll` and have real backfilled `SETUP_STATUS` (`scripts/backfill_monthly_vwap_yearly_poc.mjs`), but all 4 are `THIN_N` (most touches of a month/year-scale magnet don't resolve within a single RTH session — SHADOW-only via the standard THIN_N gate, accumulating real live data going forward). A same-day investigation initially misdiagnosed `keepLevelsAll`'s `ls()` lookup as having a base-key mismatch (strips `_LONG`/`_SHORT` but not `_FADE`) that would degrade `nearLevels.reduce()`'s highest-EV primary-selection to array-position tie-breaking — direct re-verification against the live DB disproved this: `statsQ`'s `UNIFIED_BACKTEST` rows have used bare, non-`_FADE` signal names (`PD_HIGH_LONG`, not `PD_HIGH_FADE_LONG`) since `backtest_unified.js` was written (2026-07-01), so the pre-existing base-key regex was already correct and `reduce()` was never actually broken. See `keepLevels_ls_base_key_mismatch_selection_bug` `OPEN_DECISION` for the full corrected writeup. |
| Price data | `priceBars.js` | Bar ingest, partition-aware queries, volume profile |
| Phase detection | `phaseChange.js` | Compression→expansion phase detection + backtest |
| Auction/value | `developingValue.js`, `auctionRead.js`, `weekly.js`, `keyLevels.js` | POC/VAH/VAL tracking, opening-call classification (`open_vs_prior_value` + `overnight_inventory` auto-computed from price data; `prior_day_profile` is manual Sierra Chart read), key-level regime stats. `weekly.js` now only hosts `/api/weekly/assessments` + `/api/weekly/assessment/:weekStart?` (weekly grade summaries, read by `WeeklyReportPanel.jsx`/`CalendarView.jsx`) — its `weekly_ib_structure`-backed routes (`/weekly/current`, `/weekly/va-history`, `/daily/va-history`, `/weekly/bars`, `/weekly/history`, `POST /weekly/monday`, `PUT /weekly/:id`) were deleted 2026-07-18 (confirmed zero frontend callers; `weekly_ib_structure` table left in place, data only, not dropped). `keyLevels.js` also hosts `/api/level-prices/:date` (64 level types), `/api/level-prices/tag/:date` (re-tag BP fills), and `/api/level-approach/today` (ranked setup anticipation list for today's day_type+DOW, sourced from `performance_audit` SETUP_ANTICIPATION rows), `/api/volatility-forecast` (next-session day_type probability distribution — live query, self-updating; returns volatility_flag HIGH/ELEVATED/NORMAL + drivers), and `/api/confluence-near-price` (level pairs from `confluence_pairs_latest.json` where both levels are within 15pt of current price; day_type-adjusted EV where N≥10). |
| Setups | `setups.js`, `pattern.js`, `confluence.js`, `antigravityEdges.js` | Setup detection/backtest, pattern mining endpoints, level confluence score, fade/reversal edges |
| Risk & behavior guardrails | `cooldown.js`, `profitLock.js`, `dll.js` | Post-loss cooldown, 1PM profit-lock guard, daily loss limit tracking |
| Conviction/case | `case.js`, `scenario.js` | Case Engine (multi-factor conviction read), Monte Carlo + optimization scenarios |
| Prep & review | `morningBrief.js`, `premarketWalkthrough.js`, `calendar.js`, `annotations.js`, `longterm.js` | Pre-open forecast/scalp playbook, structured pre-market prep (`premarket_walkthroughs` table, seeded nightly by `scripts/daily_coaching.js` with regime/DOW-pattern/watch-plan content; displayed read-only in Morning Prep via `PremarketWalkthroughCard`, `src/views/ACDView.jsx`, added 2026-07-18 — the table's `layer1_lean`..`layer4_lean`/`committed_plan`-as-user-input fields still have no interactive UI, that remains a separate unbuilt feature), coaching notes, trade annotations, multi-session structural state |
| AI coach | `playbook.js` | Manual live assessment (3-button: LONG/SHORT/NOT SURE → Sonnet ~300-word, saves to `playbook_conversations`); assess prompt includes current price/bar trend/level distances/move extension tier/session phase/stall signals (2026-07-07). Auto daily setup review at 5 PM ET (Haiku, saves to `daily_ai_reviews`). Auto-persist on generate: `AI_SETUP_REVIEW` rows to `performance_audit` — no button. `/api/playbook/daily-review/:date` returns `setup_details` (mae_points/mfe_points/entry/stop/t1). |
| Config | `settings.js` | Health check (includes `AI_DAILY_REVIEW` schedule entry), setup types, custom fields, settings/todos |
| Volatility / error | `index.js` (direct) | `/api/vol-alert` (GET) — overnight range σ + OR-width σ, double-alert flag, used by `VolatilityAlertBanner`; `/api/client-error` (POST) — receives React `ErrorBoundary` crashes, stores in in-memory ring buffer; `/api/errors/recent` (GET, `?since=ISO`) — new errors since timestamp, polled by Gemini error watcher every 60s |

### Services (`server/services/`)

| Service | Purpose |
|---|---|
| `acdService.js` | ACD computation engine (OR, structural level, daily score) |
| `acdBacktest.js` | Backtests ACD parameters (OR width, bias, NL30) |
| `caseEngine.js` | The evolving single session "read": opening type, delta confirmation, level hold, volatility — the conviction signal surfaced on Dashboard |
| `dayTypeReassessmentService.js` | Live day-type reassessment at 11:00+ ET, called from inside `caseEngine` |
| `developingValueService.js` | Single source of truth for POC/VAH/VAL — `computeProfile(bars)` (spread each bar's volume evenly across its own H-L tick range, then alternate VAH/VAL extension to 70% total volume) backs both the live single-session read (descriptive only, no signals) and, via the exported `computeVolumeProfileForRange(queryFn, opts)` wrapper (added 2026-07-17), every period-range volume-area computation (`scripts/compute_levels.js`'s weekly/monthly/quarterly VA, `acd.js`'s prior-month/2-day-composite VA) — replacing a previously-duplicated bucket-by-low SQL pattern that silently dragged POC/VAH/VAL toward each bar's low price instead of its true traded range. (`weekly.js`'s VA-history/bars endpoints were a caller too until they were deleted 2026-07-18 as confirmed dead/zero-frontend-callers.) See docs/OPEN_THREADS.md for the bug writeup. |
| `engineReadHitRates.js` | Historical hit-rate lookups for A_UP/A_DOWN/BIAS signals; requires N≥20 before reporting a rate as decisive |
| `monteCarloService.js` | Monte Carlo V2 — trade source selection, daily block bootstrapping, MAE-aware stop override |
| `patternMemoryUpdate.js` | Nightly job populating `daily_performance_log`/`condition_memory`/`pattern_stats`. `session_pnl` (fixed 2026-07-19) uses CumPL-diff scoped to `-PRO%` accounts — see CLAUDE.md's CumPL hard rule for why an unscoped diff is worse than the `SUM(pnl)` it replaced (practice-account balance resets read as phantom five-figure losses). Falls back to raw `SUM(pnl)` for the ~87% of trading days with no PRO-account activity. |
| `patternScannerService.js` | Pattern detectors run at bar-ingest time (compression/expansion, multi-bar rejection) |
| `phaseChangeBacktest.js` / `phaseChangeDetector.js` | Backtest + live detection of market phase changes |
| `minuteBarSignalDetector.js` | Live detection for `MOMENTUM_60m_60m_TREND` (2026-07-14) — rolling-bar-window statistical extreme, not a level touch, so it has its own poller modeled on `phaseChangeDetector.js` rather than the level-fade candidates array in `acd.js`. Runs on the same 60s cycle as the level fade engine (`server/index.js`). `SHADOW` status pending N≥20 live trades. |
| `priceBarService.js` | Sierra Chart filename parsing, bar ingest, monthly partition routing |
| `queries.js` | Shared cross-service helpers (NL30/NL10, gap drift, prior-week range, conviction data) — widely imported |
| `sessionForecastService.js` | Session bias forecast from prior 30 sessions (balance zone, opening, expected range) |
| `setupBacktestService.js` | Backtests setups for hit rate, MAE, win rate by day type |
| `setupEmitter.js` | Real-time setup detection + Socket.IO emission on each bar ingest |
| `targetCalibrationService.js` | Corrected, guardrailed target-calibration methodology (2026-07-19) — `computeCorrectedTarget()`: chronological bar-by-bar resimulation from entry (fixes the old EV-sweep's truncated-MFE and order-blind flaws), thin-tail gate, candidate grid anchored to the current live target, chronological out-of-sample split, plateau check, `computeRigor()`. Shared by `scripts/update_optimal_stops.mjs` (wired in live — overrides the EV-sweep target for any setup_type that clears every guardrail, tagged `notes.method='corrected-resim'` on the `OPTIMAL_STOP` row) and `scripts/backtest_target_sweep_v2.mjs` (standalone audit/comparison tool, writes `TARGET_SWEEP_V2` rows). 19/103 setup_types use it as of 2026-07-19. See `docs/TARGET_CALIBRATION_SPEC.md`. |
| `touchQuality.js` | Order-flow "touch-quality" classification (2026-07-15) — was a level touch a real 2-sided fight (`HIGH_VOL_ABSORBED`/`HIGH_VOL_OVERRUN`) or quiet (`QUIET`)? Volume z-score vs. a 90-day trailing per-minute-of-day baseline (reuses the existing VOLUME_SPIKE convention). Shared by `scripts/calibrate_touch_quality.mjs` (historical calibration → `performance_audit` `TOUCH_QUALITY` rows) and `acd.js`'s live `resolveSetupsByPrice()` (classifies open setups once their calibrated reaction window elapses) — informational only, never affects resolution/pnl/stops. Surfaced as a badge in `ACDView.jsx`'s live setup cards via `touchQualityStats` on `/api/antigravity/edges-context`. |
| `tradeImportService.js` | Sierra Chart export parsing with count-based dedup; tags BP fills via `levelProximityService` after insert |
| `levelProximityService.js` | Tags BP fills with `AT_LEVEL` (≤5pt), `LATE` (5-15pt), or `CHASING` (>15pt) relative to `level_prices`; stores top-3 nearest levels in `trades.level_proximity`; `tagTradesForDate()` runs after 4 PM auto-import |
| `volatilityRegimeService.js` | Live read-only volatility regime (morning vol z-score, trend strength) |
| `marketCalendar.js` | NYSE/CME NQ holiday + early-close calendar 2024–2026. Exports `getMarketStatus(dateStr)` → `{type:'HOLIDAY'|'EARLY_CLOSE', name, rthCloseEtMin?}` or `null`; `isHoliday()`; `getEarlyCloseMinute()`. Used by `/api/acd/live` to short-circuit on holidays and to return `earlyClose` field on early-close days. |

### Scheduled jobs (node-cron + setInterval, set up in `server/index.js`)
Morning brief generation, EOD auto-import (4 PM — also runs `tagTradesForDate` + `backfill_auction_reads.js` for today), weekly report, monthly report, pattern memory nightly update, daily coaching (4:45 PM), **AI setup review (5:00 PM ET Mon-Fri** — auto-generates per-setup ratings via Haiku; skips if review already exists or no resolved setups), MGI level computation (9:30 PM ET Sunday via `scripts/compute_levels.js`). Each run is logged to `process_log` (see `logProcess()` calls in `index.js`).

- **Server-autonomous detection (2026-07-05):** `setInterval` every 60s during 9:30–4:00 PM ET Mon–Fri polls `GET /api/acd/today` to trigger the level fade detection INSERT without requiring a browser client. The INSERT is idempotent (ON CONFLICT DO NOTHING). This fixed the root cause of 62% of setups firing via retroactive IB-close backfill.
- **Nightly latency audit:** cron `15 17 * * 1-5` runs `scripts/audit_setup_latency.mjs` for the current ET date; writes `LATENCY_AUDIT` to `performance_audit`; appends CRITICAL alerts to `scratch/gemini_alerts.txt`.
- **Day-type alpha recompute:** cron Sunday 9:10 PM runs `scripts/backtest_day_type_alpha.js` (per-setup_type × day_type z-scores → `DAY_TYPE_ALPHA` rows in `performance_audit`).
- **Setup anticipation recompute:** cron Sunday 8:30 PM runs `scripts/backtest_level_approach.js` (P(fire|day_type,DOW) × avg_pnl → `SETUP_ANTICIPATION` rows).

---

## Frontend Structure

```
src/
├── main.jsx               # Entry point
├── App.jsx                # Global state only (account, socket.io, profit-lock/DLL banners, view routing shell)
│                          # Reduced 17k→1.8k lines 2026-07-12; all view content extracted to src/views/
├── App.css                # Dark theme, CSS variables
├── utils/
│   ├── usePollData.js     # Generic fetch+setInterval hook (cancellation built in)
│   ├── useAcdLive.js      # /api/acd/live poller — 30s default, error-filtered
│   ├── confidenceTier.js
│   ├── format.js
│   ├── timestamps.js
│   └── updateDots.js
├── views/                 # All top-level views extracted from App.jsx — every one is lazy() + Suspense
│   ├── ACDView.jsx        # 1,585 lines — lazy (Morning Prep / dashboard tab). Was 4,310
│   │                        lines until 2026-07-16: removed ~2,725 lines of dead code
│   │                        (AuctionReadCard/BigPictureSnapshot/ConfluenceScore/
│   │                        PhaseChangeMonitor/TradeTimelinePanel and everything only they
│   │                        called) orphaned by e8946e5's "Remove 1,788 lines of dead code"
│   │                        commit, which deleted SessionStatusBar and DashboardPanels
│   │                        (both genuinely dead) but didn't transitively check whether
│   │                        removing them orphaned anything those two used to call — they
│   │                        did, twice over. See docs/OPEN_THREADS.md for the full account.
│   ├── BacktestView.jsx   # 2,872 lines — lazy
│   ├── CalendarView.jsx   # 2,305 lines — lazy (imported inside the also-lazy AllTradesView.jsx)
│   ├── PlaybookView.jsx   # 1,564 lines — lazy (2026-07-15: was the last static top-level
│   │                        import in App.jsx; also imported 3 named exports there —
│   │                        LevelConfluenceReference/ConditionBacktestInline/PatternStatsPanel
│   │                        — that went unused in App.jsx itself, since ACDView.jsx already
│   │                        imports those same 3 directly from PlaybookView.jsx on its own.
│   │                        Converting to lazy dropped the main bundle 1,122KB→979KB raw
│   │                        (302KB→273KB gzip); no other file needs a static PlaybookView import)
│   ├── ScenarioTesterView.jsx, AllTradesView.jsx, LongTermStructureView.jsx
│   ├── RiskView.jsx, TearsheetView.jsx, SetupHistoryView.jsx
│   └── SettingsView.jsx (`ProcessHealthDashboard` — live status table for every
│                        backfill/mining/calibration cron, driven by
│                        /api/settings/process-health; `HowTheSystemLearns`, added
│                        2026-07-17, moved here from AlphaEngineOverview after the user
│                        pointed out this is the literal "system health" page and it
│                        directly tracks the same scripts the diagram references — a
│                        plain-language visual map of the closed-loop learning mechanism)
├── components/shared/
│   ├── WinChip.jsx        # Win-rate chip: label + WR% + N, highlight/isBaseline props
│   ├── ErrorBoundary.jsx
│   └── UpdateDot.jsx
└── components/dashboard/  # 28 components (4 deleted 2026-07-04)
```

**Sidebar nav (5 items):** Morning Prep → `acd`, Dashboard → `dashboard`, Edge → `backtest`, Trades → `calendar`, Settings → `settings`. Removed 2026-07-03: Structure (`longterm`), Tearsheet, Scenarios, Risk, Setup Log — all absorbed into Edge sub-tabs or Dashboard content.

Views routed inside `App.jsx` → `src/views/`: `dashboard`, `all-trades`, `calendar`, `acd`, `backtest`, `settings`, `longterm`, `playbook` (still renderable, just not in sidebar nav; `scenario`, `risk`, `setup-log`, `tearsheet` render as Edge sub-tabs or via direct URL).

**BacktestView ("Edge") sub-tabs:** Setup Log (default), **Alpha Engine** (system overview — size multiplier stack, tiers, suppressions, tools, road map), Performance Audit, Edge Analysis, Efficiency Analysis, Volume Profile, Playbook & Patterns, Key Levels, Scenarios, Risk & Sizing, Chart Review, Playbook, Backlog.

**DashboardView fetches:** `stats/daily`, `stats/cumulative-pnl`, `tearsheet-overview`, `rolling`, `pnl-distribution`. Renders: daily P&L chart, equity curve, Sharpe/Sortino/Kelly chip card, Rolling 20-trade expectancy chart, Trade P&L Distribution chart, LevelMonitorPanel, DevelopingValueCard, Risk-Adjusted Performance section. Removed 2026-07-04: `SetupsTable`, `PerformanceVisuals`, `OptimizationSection`, `BehaviorSection` + their backend endpoints (`stats/by-setup`, `stats/by-duration`, `stats/behavior`, `stats/optimization`, `stats/trade-location`).

| Group | Components |
|---|---|
| Pre-market context | `SessionForecastPanel`, `DevelopingValueCard`, `VolatilityRegimeCard` |
| Edge overview | `AlphaEngineOverview` — Edge → Alpha Engine tab; covers size multiplier stack, setup tiers, suppressions, all 11 supporting tools, pending road map |
| Live session | `VolatilityAlertBanner` (polls `/api/vol-alert`, orange σ≥1 / red σ≥2, OR-width alert, dismissible), `DayOfWeekPlaybookCard`, `TradeAlertBanner`, `TeleprinterFeed`, `EdgeSectionsPanel` (with `SetupFeedbackForm` on each setup + "Closed Today" collapsible), `PostLossCooldown`, `OvernightContextStrip`, `PremarketWalkthroughCard` (read-only nightly-seeded regime/pattern/watch-plan display, added 2026-07-18) — all four `ACDView.jsx` Morning Prep components. (`AntigravityEdgesView` removed 2026-07-17, dead tab.) |
| Post-market review | `WeeklyReportPanel`, `MarketRecapPanel`, `LevelMonitorPanel` |
| Performance viz | `PnlCharts`, `StatsGrid` |
| Utility | `SyncProgressPanel`, `RecapDatePicker`, `DashboardFilters`, `DashboardView` |

Key logic in `App.jsx`: `computeNetTrades()` (second-pass CumPL diff per account for the intraday chart), shared account state, day modal with BP→EP fill grouping.

---

## Systemd User Services (auto-start on boot, restart on crash)

Managed via `systemctl --user [start|stop|restart|status] <name>`. Both enabled and lingering (`loginctl enable-linger mmoniz`) so they start at WSL2 boot without login.

| Service | File | What it runs |
|---|---|---|
| `trading-journal-server` | `~/.config/systemd/user/trading-journal-server.service` | `node server/index.js` on port 3002 |
| `trading-journal-watcher` | `~/.config/systemd/user/trading-journal-watcher.service` | `scratch/gemini_error_watcher.mjs` — polls health + errors, writes `scratch/gemini_alerts.txt` |

**PostgreSQL** is managed by system-level systemd (not user-level) — `pg_isready` to check.

**Vite frontend** (port 5173) is NOT a service — start manually with `npm run client` or `./start.sh`.

---

## `scripts/` — Ad-hoc Analysis & Backtests

~51 standalone Node scripts run manually (`node scripts/backtest_X.js`) against the live DB via `server/db.js`. They are **not imported by the running app** — each one tests a specific edge hypothesis and most write findings into `performance_audit`. Naming convention is `backtest_<hypothesis>.js`; one-time data-repair scripts use `repair_<what>.mjs` (see below). 87 superseded scripts moved to `scripts/archive/` (2026-07-09) — not maintained.

A few scripts ARE wired in as scheduled jobs from `server/index.js` (morning brief, weekly/monthly report, daily coaching, level computation) — check `index.js` cron registrations before assuming a script is dead.

Notable scripts that are scheduled or run after auto-import:
- `scripts/compute_levels.js` — computes all 68 MGI levels for a session date, writes to `level_prices`; supports single date or `--backfill [--from DATE]`; runs via cron 9:30 PM ET Sunday
- `scripts/backfill_auction_reads.js` — computes `open_vs_prior_value` and `overnight_inventory` from price bars and writes to `auction_reads`; runs after 4 PM auto-import for today's date; supports single date, `--nulls` (keep existing), or all-dates overwrite
- `scripts/backtest_level_approach.js` — computes P(setup fires | day_type, DOW) × avg_pnl from `active_setups` history; writes 906 rows to `performance_audit` with `signal_type='SETUP_ANTICIPATION'`, `window_days=0`; signal_name = `SETUP_TYPE|DAY_TYPE|DOW`. **Run weekly** via `node scripts/backtest_level_approach.js`. Endpoint `/api/level-approach/today` returns ranked list for today's context. Calibrated via `scripts/backtest_anticipation_validation.js` (30-day check: top-3 coverage = 77%).
- `scripts/backtest_next_day_type.js` — one-off research script; 346-day backtest of next-session day_type predictors. Key finding: prior TURBULENT = +57% volatile lift; overnight range WIDE = +22%, NARROW = -29%; overnight inventory adds near-zero lift. Results baked into `/api/volatility-forecast` lookup table.
- `scripts/backtest_anticipation_validation.js` — calibration check: for each of last 30 days, top-N predicted setups vs actual fires; reports coverage, calibration buckets, per-setup hit rates. Run after any `backtest_level_approach.js` refresh.
- `scripts/context_analysis.js` — mines 520 confluence pairs and contextual filters (DOW/day-type/direction); writes `performance_audit` rows with `signal_type='CONTEXT_ANALYSIS'`; cron fires Sunday 6 AM ET
- `scripts/audit_setup_latency.mjs` — nightly latency audit (`node scripts/audit_setup_latency.mjs [YYYY-MM-DD]`); for each FADE setup finds first RTH bar within 15pt, computes lag (fired_at − first_bar_ts); classifies OK/SLOW/CRITICAL/RETROACTIVE/PREMARKET; writes `LATENCY_AUDIT` rows to `performance_audit`; appends CRITICAL alerts to `scratch/gemini_alerts.txt`; cron fires 5:15 PM ET Mon–Fri
- `scripts/backtest_latency_impact.mjs` — one-shot P&L impact analysis: entry slippage + phantom wins (T1 hit before alert fired) per lag bucket; quantified ~$44K/yr recovery from server-autonomous detection fix (2026-07-05)
- `scripts/update_optimal_stops.mjs` — joint EV-sweep of stop × target per setup_type (2026-07-13: stop candidates are that type's own MAE percentiles p25/p40/p50/p60/p75/p90 — not a fixed p75_mae rule or flat point grid — target candidates are `TARGET_SWEEP` capped at p75_mfe); writes `OPTIMAL_STOP` rows; **daily** (via `run_daily_calibration.sh` 4:20 PM ET) + Sunday 9:13 PM
- `scripts/backtest_first5min_mae_gate.mjs` — one-off research script (2026-07-13): tests whether setups firing in the first 5 min of RTH that absorb high adverse excursion before the 9:35 bar closes should exit early. Derives the cutoff as mean+Kσ of the historical MAE-at-9:35 distribution (K swept by EV, not hardcoded) instead of a fixed point value. Current finding: the EV-optimal K only gates ~1% of trades (not a meaningful edge) — **not wired live**, informational `FIRST5MIN_MAE_GATE` row only. Not on any cron; re-run manually if more data accumulates.
- `scripts/backtest_day_type_alpha.js` — per-(setup_type × day_type) z-score from all resolved trades; writes `DAY_TYPE_ALPHA` rows; cron fires Sunday 9:10 PM ET; live path reads `liveStats._dta` to adjust sizeMultiplier
- `scripts/backfill_mae_mfe.mjs` — backfills mae_points, mfe_points, bars_to_resolution, resolution_bar_time on `active_setups`; shared replay engine: `server/services/maeMfeReplay.js`; **daily** (via `run_daily_calibration.sh`)
- `scripts/run_daily_calibration.sh` — runs `backfill_mae_mfe.mjs` + `update_optimal_stops.mjs` + `backtest_setup_status.mjs` at 4:20 PM ET Mon-Fri (system crontab); fast pass (~2 min); ensures stops/suppression reflect same-day resolved trades
- `scripts/backtest_monday_deep.js` — Monday WR/EV overrides per level; writes `MON_BACKTEST` rows read live by `acd.js` keepLevels logic; cron fires Sunday via `run_weekly_backtests.sh`
- `scripts/calibrate_touch_quality.mjs` (2026-07-15) — per-setup_type order-flow touch-quality calibration: reaction window (p25 bars-to-resolution) + high-volume z-score tercile cutoff + per-bucket (`HIGH_VOL_ABSORBED`/`HIGH_VOL_OVERRUN`/`QUIET`) N/WR/EV; writes `TOUCH_QUALITY` rows to `performance_audit`; shares classification logic with `server/services/touchQuality.js` (also used live by `acd.js`'s `resolveSetupsByPrice()`). Added to `run_weekly_backtests.sh`. See docs/OPEN_THREADS.md "Touch-quality" thread for the full derivation (price-action approach tried first, didn't generalize; order-flow approach validated across all 47 N≥50 setup_types, ~45% show `HIGH_VOL_OVERRUN` as the clearly worst bucket, zero day-clustering).
- `scripts/repair_*.mjs` (2026-07-14, 7 scripts) — one-time data repairs for the `resolution_method='BACKFILL'` corpus in `active_setups` (the historical output of `scripts/archive/backfill_level_fades.js`), not scheduled/cron, kept for audit trail: `repair_backfill_duplicate_bars.mjs` (re-simulated against clean `price_bars_primary`), `repair_cam_r4_s3_window_mismatch.mjs`/`repair_top8_window_mismatch.mjs`/`repair_remaining_window_mismatch.mjs`/`repair_ib_dependent_window_mismatch.mjs`/`repair_weekly_vwap_window_mismatch.mjs` (re-simulated first-touch-anywhere-in-RTH instead of the archived script's 10:30am-noon window, one wave per level-formation-gate family), `repair_dollars_per_point.mjs` (rescaled `actual_pnl` from $5/pt to the real $2/pt MNQ contract value). Each backs up to a `active_setups_*_backup_20260714` table before writing — see docs/OPEN_THREADS.md for the full incident writeup and docs/KNOWN_ISSUES.md items 8-10 for the underlying bugs. Backup tables are safe to drop once the fixes have held for a few sessions.
- `scripts/repair_trades_timezone_shift.mjs` + `repair_trades_dedupe_20260609_batch.mjs` / `repair_trades_dedupe_20260422_batch.mjs` / `repair_trades_dedupe_remaining.mjs` (2026-07-16) — one-time repair of the `trades` table (not `active_setups`) for the ambient-timezone ingestion bug in `sierraParser.js` — see CLAUDE.md's "Never parse a naive... timestamp" convention for the full mechanism. Corrected 35,813 pre-2026-06-09 `entry_time`/`exit_time` values (date-aware +4h EDT / +5h EST, not a flat shift) and removed 9,037 duplicate rows across three distinct causes (a 2026-06-09 re-import, an unrelated 2026-04-22 re-import, and a structural multi-line-per-position Sierra TAL quirk present across the full history). Backs up to `trades_backup_20260716` before writing. `trades`: 40,453 → 31,416 rows.
- `scripts/backfill_volatility_regime_history.mjs` (2026-07-16) — canonical historical backfill of `volatilityRegimeService.js`'s live regime classification (LOW-VOL/NORMAL-VOL/HIGH-VOL-DIRECTIONAL/HIGH-VOL-CHOP), one row per trading day; writes `VOL_REGIME_HIST` rows to `performance_audit`. Imports the real live functions (`fiveMinBars`, `stdevLogReturns`, `getPercentile`, `classifyRegime`, `getMorningVolBaseline` — all exported from `volatilityRegimeService.js` for this reuse) rather than reimplementing the math, after two Gemini hand-reimplementations of the same logic produced internally inconsistent EV comparisons. Not on any cron yet — re-run manually as more days accumulate.
- `scripts/record_claim.mjs` (2026-07-16) — canonical way to persist an exploratory/research finding (not a setup-calibration one — those already have SETUP_STATUS/OPTIMAL_STOP/etc.) as a durable, re-checkable row instead of leaving it only as prose in docs/OPEN_THREADS.md. Writes/reads `RESEARCH_CLAIM` rows in `performance_audit` (`notes` holds `{claim_text, source_file, source_date, rigor_status, status, last_verified_date, next_recheck_due}` as JSON text). Exports `recordClaim()`/`listClaims()` for reuse by other scripts; `node scripts/record_claim.mjs --list` shows all claims and flags any past their 30-day recheck date. Seeded with 7 audited claims from a 2026-07-16 session; caught a genuine cross-run discrepancy in the TRIPLE-zone confluence number the same day (see `backtest_confluence.js` entry below) — a live example of exactly the drift this ledger exists to catch.
- `scripts/backtest_confluence.js` (weekly, Sun cron per `run_weekly_backtests.sh`'s job list — not itself listed there by name but confirmed live via `playbook.js`'s `CONFLUENCE_AUDIT` metadata row) — tests SINGLE/DOUBLE/TRIPLE/QUAD_PLUS level-confluence tiers for fade WR/MAE/MFE/EV improvement; writes `CONFLUENCE_AUDIT` rows to `performance_audit`, consumed live by `SessionForecastPanel`. **2026-07-16: added a `computeRigor()` call per tier** (imported from `rigorDiagnostics.js`, not reimplemented) — this script had zero rigor checking despite being the source of the TRIPLE-zone confluence numbers that had swung significantly across past ad hoc re-tests (an Opus-consultation-flagged gap). Re-run the same day surfaced a real discrepancy against an older scratch-file number for the same claim — see `docs/OPEN_THREADS.md` and the `triple_zone_confluence_alltime` `RESEARCH_CLAIM` row.
- `scripts/flag_decision.mjs` (2026-07-17) — sibling to `record_claim.mjs` above, deliberately a separate `signal_type` (`OPEN_DECISION`, vocabulary `PENDING`/`RESOLVED`) rather than the same rows, since a pending product/architecture decision ("wire this in or delete it," "merge this branch") has no statistical content and doesn't go stale the way a research finding does. `flagDecision()`/`resolveDecision()`/`listDecisions()` exported for reuse. **The actual fix is `.claude/hooks/session-start.sh`'s new `OPEN_DECISIONS` section** — every `PENDING` decision prints unconditionally at the start of every session, oldest-first with age (computed in SQL, not JS `Date()` — see the naive-timezone-arithmetic hard rule), so nothing here depends on a future session remembering to re-read prose. Built per explicit user request: "anything that needs to be reevaluated should [be] flagged with something and actively monitored. Nothing can be buried." `node scripts/flag_decision.mjs --list` / `--resolve <slug> '<resolution>'`.

---

## CSS Customization

Key CSS variables in `src/App.css`:

```css
:root {
  --bg-primary: #0a0e27;      /* Dark background */
  --accent-purple: #8b5cf6;   /* Primary accent */
  --accent-green: #10b981;    /* Profit / success */
  --accent-red: #ef4444;      /* Loss / error */
}
```
