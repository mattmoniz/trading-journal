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
| Auction / value | `developing_value_log`, `auction_reads`, `auction_history` | POC/VAH/VAL migration tracking, opening-call classification |
| MGI levels | `level_prices` | 64 computed market-generated-info levels per session date (PD VA, overnight, OR, VWAP, floor pivots, camarilla, weekly/monthly/quarterly VA, 10D_IB_MID, PD_OR_MID). PK: `(trade_date, level_name)`. Backfilled Nov 2023–Jul 2026. Regenerated by `scripts/compute_levels.js`; cron fires 9:30 PM ET Sunday. |
| Setups & performance | `active_setups`, `setup_outcome_backtest`, `setup_daytype_winrates`, `setup_move_stats`, `setup_correlation_cache` | Live setup tracking + their historical backtested edge stats |
| Pattern mining | `pattern_discoveries`, `pattern_stats`, `dynamic_edges_mining`, `condition_memory` | Nightly-mined OHLC/condition patterns and their hit rates |
| Risk / behavioral guardrails | `post_loss_cooldowns`, `dll_daily_events`, `profit_lock_config`, `profit_lock_events`, `risk_settings`, `rule_overrides` | Daily loss limit tracking, 1PM profit-lock guard, cooldown-after-loss enforcement |
| Sessions & timing | `trading_sessions`, `session_analysis`, `session_patterns` | Per-session OHLC/texture metrics (Monday texture, Friday bias, etc.) |
| Review & coaching | `morning_briefs`, `premarket_walkthroughs`, `daily_coaching`, `weekly_assessments`, `trade_annotations`, `trade_feedback`, `trade_timeline_events` | Persisted output of scheduled/manual review jobs and trade-level annotations |
| Engine evaluation | `engine_reads`, `daytype_accuracy_log`, `performance_audit`, `phase_change_alerts`, `phase_change_backtest_results`, `level_regime_performance`, `monte_carlo_runs` | Forward-test/backtest results for every signal system — **this is where backtest scripts write findings** (see `performance_audit`) |
| Misc config | `account_settings`, `settings_todos`, `import_log`, `process_log`, `macro_events` | App settings, scheduled-job run log, macro calendar |

### Dormant feature tables (code exists, never used — not dead, just empty)

`phase_change_alerts`, `trade_screenshots`, `trading_sessions`, `premarket_walkthroughs` all have a live route/service that can read/write them, but currently hold 0 rows because the feature has never been exercised. Don't drop these without also deciding to remove the feature — they're a product decision, not cleanup.

`wyckoff_levels` was dropped 2026-07-04 (0 rows, route removed, no frontend references).

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
├── db.js                 # pg Pool + query() helper; also fixes a timestamp/timezone parsing bug globally
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
| ACD / opening range | `acd.js` (largest route file, ~4000 lines) | OR computation, structural levels, day-type, NL30, pivots, A/B/C signal backtest |
| Price data | `priceBars.js` | Bar ingest, partition-aware queries, volume profile |
| Phase detection | `phaseChange.js` | Compression→expansion phase detection + backtest |
| Auction/value | `developingValue.js`, `auctionRead.js`, `weekly.js`, `keyLevels.js` | POC/VAH/VAL tracking, opening-call classification (`open_vs_prior_value` + `overnight_inventory` auto-computed from price data; `prior_day_profile` is manual Sierra Chart read), weekly VA migration, key-level regime stats. `keyLevels.js` also hosts `/api/level-prices/:date` (64 level types), `/api/level-prices/tag/:date` (re-tag BP fills), and `/api/level-approach/today` (ranked level anticipation list for today's day_type+DOW, sourced from `performance_audit` LEVEL_APPROACH rows). |
| Setups | `setups.js`, `pattern.js`, `confluence.js`, `antigravityEdges.js` | Setup detection/backtest, pattern mining endpoints, level confluence score, fade/reversal edges |
| Risk & behavior guardrails | `cooldown.js`, `profitLock.js`, `dll.js`, `ruleOverrides.js` | Post-loss cooldown, 1PM profit-lock guard, daily loss limit tracking, rule override testing |
| Conviction/case | `case.js`, `scenario.js` | Case Engine (multi-factor conviction read), Monte Carlo + optimization scenarios |
| Prep & review | `morningBrief.js`, `premarketWalkthrough.js`, `calendar.js`, `annotations.js`, `longterm.js` | Pre-open forecast/scalp playbook, structured pre-market prep, coaching notes, trade annotations, multi-session structural state |
| Config | `settings.js` | Health check, setup types, custom fields, settings/todos |
| Volatility / error | `index.js` (direct) | `/api/vol-alert` (GET) — overnight range σ + OR-width σ, double-alert flag, used by `VolatilityAlertBanner`; `/api/client-error` (POST) — receives React `ErrorBoundary` crashes, stores in in-memory ring buffer; `/api/errors/recent` (GET, `?since=ISO`) — new errors since timestamp, polled by Gemini error watcher every 60s |

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
| `tradeImportService.js` | Sierra Chart export parsing with count-based dedup; tags BP fills via `levelProximityService` after insert |
| `levelProximityService.js` | Tags BP fills with `AT_LEVEL` (≤5pt), `LATE` (5-15pt), or `CHASING` (>15pt) relative to `level_prices`; stores top-3 nearest levels in `trades.level_proximity`; `tagTradesForDate()` runs after 4 PM auto-import |
| `volatilityRegimeService.js` | Live read-only volatility regime (morning vol z-score, trend strength) |
| `marketCalendar.js` | NYSE/CME NQ holiday + early-close calendar 2024–2026. Exports `getMarketStatus(dateStr)` → `{type:'HOLIDAY'|'EARLY_CLOSE', name, rthCloseEtMin?}` or `null`; `isHoliday()`; `getEarlyCloseMinute()`. Used by `/api/acd/live` to short-circuit on holidays and to return `earlyClose` field on early-close days. |

### Scheduled jobs (node-cron, set up in `server/index.js`)
Morning brief generation, EOD auto-import (4 PM — also runs `tagTradesForDate` + `backfill_auction_reads.js` for today), weekly report, monthly report, pattern memory nightly update, daily coaching, MGI level computation (9:30 PM ET Sunday via `scripts/compute_levels.js`). Each run is logged to `process_log` (see `logProcess()` calls in `index.js`).

---

## Frontend Structure

```
src/
├── main.jsx               # Entry point
├── App.jsx                # Global state (account, view routing, socket.io, profit-lock/DLL banners), ~all view switching
├── App.css                # Dark theme, CSS variables
├── utils/
│   ├── usePollData.js     # Generic fetch+setInterval hook (cancellation built in)
│   ├── useAcdLive.js      # /api/acd/live poller — 30s default, error-filtered
│   ├── confidenceTier.js
│   ├── format.js
│   ├── timestamps.js
│   └── updateDots.js
├── components/shared/
│   ├── Card.jsx           # Standard card wrapper (var(--card-bg), var(--border-color))
│   ├── WinChip.jsx        # Win-rate chip: label + WR% + N, highlight/isBaseline props
│   ├── ErrorBoundary.jsx
│   └── UpdateDot.jsx
└── components/dashboard/  # 27 components (4 deleted 2026-07-04)
```

**Sidebar nav (5 items):** Morning Prep → `acd`, Dashboard → `dashboard`, Edge → `backtest`, Trades → `calendar`, Settings → `settings`. Removed 2026-07-03: Structure (`longterm`), Tearsheet, Scenarios, Risk, Setup Log — all absorbed into Edge sub-tabs or Dashboard content.

Views routed inside `App.jsx`: `dashboard`, `all-trades`, `calendar`, `acd`, `backtest`, `settings`, `longterm`, `playbook` (still renderable, just not in sidebar nav; `scenario`, `risk`, `setup-log`, `tearsheet` render as Edge sub-tabs or via direct URL).

**BacktestView ("Edge") sub-tabs:** Setup Log (default), Performance Audit, Edge Analysis, Efficiency Analysis, Volume Profile, Playbook & Patterns, Key Levels, Scenarios, Risk & Sizing, Chart Review, Playbook, Backlog.

**DashboardView fetches:** `stats/daily`, `stats/cumulative-pnl`, `tearsheet-overview`, `rolling`, `pnl-distribution`. Renders: daily P&L chart, equity curve, Sharpe/Sortino/Kelly chip card, Rolling 20-trade expectancy chart, Trade P&L Distribution chart, LevelMonitorPanel, DevelopingValueCard, Risk-Adjusted Performance section. Removed 2026-07-04: `SetupsTable`, `PerformanceVisuals`, `OptimizationSection`, `BehaviorSection` + their backend endpoints (`stats/by-setup`, `stats/by-duration`, `stats/behavior`, `stats/optimization`, `stats/trade-location`).

| Group | Components |
|---|---|
| Pre-market context | `PreSessionChecklist`, `SessionForecastPanel`, `DevelopingValueCard`, `VolatilityRegimeCard` |
| Live session | `VolatilityAlertBanner` (polls `/api/vol-alert`, orange σ≥1 / red σ≥2, OR-width alert, dismissible), `BalanceZonePanel`, `DayOfWeekPlaybookCard`, `TradeAlertBanner`, `TeleprinterFeed`, `LiveScriptsCard`, `TradeCalibrationCard`, `AntigravityEdgesView` (includes `EdgeSectionsPanel` with `SetupFeedbackForm` on each setup + "Closed Today" collapsible), `PostLossCooldown` |
| Post-market review | `WeeklyReportPanel`, `MarketRecapPanel`, `ScalpPlaybookCard`, `LevelMonitorPanel` |
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

~50 standalone Node scripts run manually (`node scripts/backtest_X.js`) against the live DB via `server/db.js`. They are **not imported by the running app** — each one tests a specific edge hypothesis (delta divergence, overnight inventory, sweep-reclaim, flush-balance, confluence, etc.) and most write their findings into the `performance_audit` table for later reference. Treat this directory as a research lab, not production code — naming convention is `backtest_<hypothesis>.js`.

A few scripts ARE wired in as scheduled jobs from `server/index.js` (morning brief, weekly/monthly report, daily coaching, level computation) — check `index.js` cron registrations before assuming a script is dead.

Notable scripts that are scheduled or run after auto-import:
- `scripts/compute_levels.js` — computes all 64 MGI levels for a session date, writes to `level_prices`; supports single date or `--backfill [--from DATE]`; runs via cron 9:30 PM ET Sunday
- `scripts/backfill_auction_reads.js` — computes `open_vs_prior_value` and `overnight_inventory` from price bars and writes to `auction_reads`; runs after 4 PM auto-import for today's date; supports single date, `--nulls` (keep existing), or all-dates overwrite
- `scripts/backtest_level_approach.js` — for each of 64 levels, computes historical touch rate (price within 15pt during RTH) broken down by (day_type, DOW); writes 1260 rows to `performance_audit` with `signal_type='LEVEL_APPROACH'`; signal_name encoded as `LEVEL|DAY_TYPE|DOW` (e.g. `IB_MID|BALANCE|TUE`). Run manually after major level changes or ~monthly. **Recalibrate weekly** via `node scripts/backtest_level_approach.js`.
- `scripts/context_analysis.js` — mines 520 confluence pairs and contextual filters (DOW/day-type/direction); writes `performance_audit` rows with `signal_type='CONTEXT_ANALYSIS'`; cron fires Sunday 6 AM ET

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
