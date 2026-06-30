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

`scripts/` contains ~50 standalone analysis/backtest scripts run manually via `node` — they are **not** wired into the running app (a few exceptions are scheduled reporters, noted below).

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
`server/schema.sql` is a full `pg_dump --schema-only` snapshot of the live DB (122 tables/views, after a 2026-06-30 cleanup dropped 6 confirmed-dead tables — see below), regenerated 2026-06-30. There is still no tracked migration history — tables beyond the original 5 (`daily_logs`, `trades`, `trade_screenshots`, `custom_field_definitions`, `setup_types`) were created ad hoc directly against the live DB — so `schema.sql` is a point-in-time dump, not hand-maintained DDL, and will drift again as soon as a table is added/altered without regenerating it. Regenerate with:

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
| Core journal | `daily_logs`, `trades`, `trade_screenshots`, `custom_field_definitions`, `setup_types` | Manual + Sierra-imported trade records, screenshots, daily notes |
| Price data | `price_bars` (parent, `PARTITION BY RANGE (ts)`) + `price_bars_YYYY_MM` (monthly partitions, 2022–2027) + `price_bars_primary` (view joining `price_bars` to `price_bars_contract_calendar` to pick the front-month contract per date), `price_bar_ingests` | 1-min OHLCV bars from Sierra Chart, true Postgres declarative partitioning by month |
| ACD / opening range | `acd_daily_log`, `acd_weekly_log`, `acd_monthly_pivot`, `acd_backtest_results`, `acd_setup_events` | Opening range, structural levels, day-type classification, A/B/C signal state |
| Auction / value | `developing_value_log`, `auction_reads`, `auction_history`, `wyckoff_levels` | POC/VAH/VAL migration tracking, opening-call classification, Wyckoff effort-result levels |
| Setups & performance | `active_setups`, `setup_outcome_backtest`, `setup_daytype_winrates`, `setup_move_stats`, `setup_correlation_cache` | Live setup tracking + their historical backtested edge stats |
| Pattern mining | `pattern_discoveries`, `pattern_stats`, `dynamic_edges_mining`, `condition_memory` | Nightly-mined OHLC/condition patterns and their hit rates |
| Risk / behavioral guardrails | `post_loss_cooldowns`, `dll_daily_events`, `profit_lock_config`, `profit_lock_events`, `risk_settings`, `rule_overrides` | Daily loss limit tracking, 1PM profit-lock guard, cooldown-after-loss enforcement |
| Sessions & timing | `trading_sessions`, `session_analysis`, `session_patterns` | Per-session OHLC/texture metrics (Monday texture, Friday bias, etc.) |
| Review & coaching | `morning_briefs`, `premarket_walkthroughs`, `daily_coaching`, `weekly_assessments`, `trade_annotations`, `trade_feedback`, `trade_timeline_events` | Persisted output of scheduled/manual review jobs and trade-level annotations |
| Engine evaluation | `engine_reads`, `daytype_accuracy_log`, `performance_audit`, `phase_change_alerts`, `phase_change_backtest_results`, `level_regime_performance`, `monte_carlo_runs` | Forward-test/backtest results for every signal system — **this is where backtest scripts write findings** (see `performance_audit`) |
| Misc config | `account_settings`, `settings_todos`, `import_log`, `process_log`, `macro_events` | App settings, scheduled-job run log, macro calendar |

### Dormant feature tables (code exists, never used — not dead, just empty)

`phase_change_alerts`, `wyckoff_levels`, `trade_screenshots`, `trading_sessions`, `premarket_walkthroughs` all have a live route/service that can read/write them, but currently hold 0 rows because the feature has never been exercised. Don't drop these without also deciding to remove the feature — they're a product decision, not cleanup.

### 2026-06-30 dead table cleanup

Audited every non-partition table for code references (grep across `server/` + `scripts/` + `src/`) and row counts. Six tables had **zero references anywhere in the codebase** and were dropped after a full schema+data `pg_dump` backup at `backups/dead_tables_backup_20260630_090329.sql` (118MB — contains real account identifiers and trade-level financial data from `trades_backup_tz_fix`, so it's **gitignored, local-only, not in git history** — restore from that local file if any of these tables are ever needed back):

- `price_bars_old` (633,844 rows) — pre-partition-migration backup; `scripts/migrate_price_bars_partition.sh` itself flagged this as droppable once the new partitioned `price_bars` was confirmed working
- `trades_backup_tz_fix` (35,813 rows) — backup taken before the timezone-parsing fix in `db.js`, long since superseded by the live `trades` table
- `calibration_snapshots`, `session_volume_summary`, `sot_signals` (0 rows) — scaffolded, never wired to surviving code
- `intraday_snapshots` (14 rows) — small amount of orphaned data, no code reads it

### Key Columns in `trades`

```
trades
├── id, log_date (FK → daily_logs), entry_time, exit_time
├── symbol, direction (LONG/SHORT), quantity, entry_price, exit_price
├── pnl, fees, setup_type, trade_notes
├── tags                # JSONB array
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
├── db.js                 # pg Pool + query() helper; also fixes a timestamp/timezone parsing bug globally
├── schema.sql             # Original 5-table schema only (see DB section above)
├── sierra.js              # TAL file parser, chokidar watcher
├── routes/                # 27 files, one per domain, all mounted under /api
├── services/               # 18 files, business logic called by routes (and by cron jobs in index.js)
├── scripts/setupDb.js      # Runs schema.sql
└── uploads/                # Screenshot storage, served as static files
```

### Routes (`server/routes/`, mounted under `/api`)

| Domain | File | Purpose |
|---|---|---|
| Core journal | `dailyLogs.js`, `trades.js`, `sierra.js` | Daily logs CRUD, trade CRUD, TAL import/history, chart uploads |
| Stats/analytics | `stats.js`, `tearsheet.js`, `backtest.js` | Overview KPIs, by-hour/day/duration/setup breakdowns, risk-of-ruin, tearsheet (P&L distribution, timing heatmap, MAE), Kelly sizing |
| ACD / opening range | `acd.js` (largest route file, ~4000 lines) | OR computation, structural levels, day-type, NL30, pivots, A/B/C signal backtest |
| Price data | `priceBars.js` | Bar ingest, partition-aware queries, volume profile |
| Phase detection | `phaseChange.js` | Compression→expansion phase detection + backtest |
| Auction/value | `developingValue.js`, `auctionRead.js`, `weekly.js`, `wyckoff.js`, `keyLevels.js` | POC/VAH/VAL tracking, opening-call classification, weekly VA migration, Wyckoff levels, key-level regime stats |
| Setups | `setups.js`, `pattern.js`, `confluence.js`, `antigravityEdges.js` | Setup detection/backtest, pattern mining endpoints, level confluence score, fade/reversal edges |
| Risk & behavior guardrails | `cooldown.js`, `profitLock.js`, `dll.js`, `behavior.js`, `ruleOverrides.js` | Post-loss cooldown, 1PM profit-lock guard, daily loss limit tracking, behavioral metrics, rule override testing |
| Conviction/case | `case.js`, `scenario.js` | Case Engine (multi-factor conviction read), Monte Carlo + optimization scenarios |
| Prep & review | `morningBrief.js`, `premarketWalkthrough.js`, `calendar.js`, `annotations.js`, `longterm.js` | Pre-open forecast/scalp playbook, structured pre-market prep, coaching notes, trade annotations, multi-session structural state |
| Config | `settings.js` | Health check, setup types, custom fields, settings/todos |

### Services (`server/services/`)

| Service | Purpose |
|---|---|
| `acdService.js` | ACD computation engine (OR, structural level, daily score) |
| `acdBacktest.js` | Backtests ACD parameters (OR width, bias, NL30) |
| `caseEngine.js` | The evolving single session "read": opening type, delta confirmation, level hold, volatility — the conviction signal surfaced on Dashboard |
| `dayTypeReassessmentService.js` | Live day-type reassessment at 11:00+ ET, called from inside `caseEngine` |
| `developingValueService.js` | Single source of truth for live POC/VAH/VAL — descriptive only, no signals |
| `engineReadHitRates.js` | Historical hit-rate lookups for A_UP/A_DOWN/BIAS signals; requires N≥20 before reporting a rate as decisive |
| `monteCarloService.js` | Monte Carlo V2 — trade source selection, daily block bootstrapping, MAE-aware stop override |
| `patternMemoryUpdate.js` | Nightly job populating `daily_performance_log`/`condition_memory`/`pattern_stats` |
| `patternScannerService.js` | Pattern detectors run at bar-ingest time (compression/expansion, multi-bar rejection) |
| `phaseChangeBacktest.js` / `phaseChangeDetector.js` | Backtest + live detection of market phase changes |
| `priceBarService.js` | Sierra Chart filename parsing, bar ingest, monthly partition routing |
| `queries.js` | Shared cross-service helpers (NL30/NL10, gap drift, prior-week range, conviction data) — widely imported |
| `sessionForecastService.js` | Session bias forecast from prior 30 sessions (balance zone, opening, expected range) |
| `setupBacktestService.js` | Backtests setups for hit rate, MAE, win rate by day type |
| `setupEmitter.js` | Real-time setup detection + Socket.IO emission on each bar ingest |
| `tradeImportService.js` | Sierra Chart export parsing with count-based dedup |
| `volatilityRegimeService.js` | Live read-only volatility regime (morning vol z-score, trend strength) |

### Scheduled jobs (node-cron, set up in `server/index.js`)
Morning brief generation, EOD auto-import (4 PM), weekly report, monthly report, pattern memory nightly update, daily coaching. Each run is logged to `process_log` (see `logProcess()` calls in `index.js`).

---

## Frontend Structure

```
src/
├── main.jsx               # Entry point
├── App.jsx                # Global state (account, view routing, socket.io, profit-lock/DLL banners), ~all view switching
├── App.css                # Dark theme, CSS variables
└── components/dashboard/  # 31 components
```

Views routed inside `App.jsx`: `dashboard`, `all-trades`, `calendar`, `acd`, `scenario`, `backtest`, `tearsheet`, `settings`, `risk`, `longterm`, `playbook`.

| Group | Components |
|---|---|
| Pre-market context | `MorningBriefPanel`, `PreSessionChecklist`, `PreMarketWalkthrough`, `SessionForecastPanel`, `DevelopingValueCard`, `VolatilityRegimeCard`, `GapContextCard` |
| Live session | `BalanceZonePanel`, `DayOfWeekPlaybookCard`, `TradeAlertBanner`, `TeleprinterFeed`, `LiveScriptsCard`, `TradeCalibrationCard`, `AntigravityEdgesView`, `BehavioralGuideCard`, `PostLossCooldown` |
| Post-market review | `WeeklyReportPanel`, `MarketRecapPanel`, `ScalpPlaybookCard` |
| Performance viz | `PerformanceVisuals`, `PnlCharts`, `StatsGrid`, `SymbolsTable`, `SetupsTable` |
| Utility | `SyncProgressPanel`, `RecapDatePicker`, `OptimizationSection`, `DashboardFilters`, `DashboardQuickNav`, `DashboardView` |

Key logic in `App.jsx`: `computeNetTrades()` (second-pass CumPL diff per account for the intraday chart), shared account state, day modal with BP→EP fill grouping.

---

## `scripts/` — Ad-hoc Analysis & Backtests

~50 standalone Node scripts run manually (`node scripts/backtest_X.js`) against the live DB via `server/db.js`. They are **not imported by the running app** — each one tests a specific edge hypothesis (delta divergence, overnight inventory, sweep-reclaim, flush-balance, confluence, etc.) and most write their findings into the `performance_audit` table for later reference. Treat this directory as a research lab, not production code — naming convention is `backtest_<hypothesis>.js`.

A few scripts ARE wired in as scheduled jobs from `server/index.js` (morning brief, weekly/monthly report, daily coaching) — check `index.js` cron registrations before assuming a script is dead.

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
