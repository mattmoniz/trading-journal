# Trading Journal — Architecture Inventory

> Perpetual reference document. Describes what *actually exists* in the codebase as of 2026-06-07. Not a roadmap — aspirational/parked features are called out explicitly in §9.

---

## 1. OVERVIEW

**Stack**
- Frontend: React (single monolithic `src/App.jsx`, ~19,000 lines) + supporting components in `src/components/`, built/served by Vite on port 5173
- Backend: Express (`server/index.js`), single Node process on port 3001, Socket.IO for live push (`io.emit(...)`)
- Database: PostgreSQL, accessed via `server/db.js` (`query()` wrapper), 43 tables
- Scheduling: `node-cron` jobs + raw `setInterval`/`setTimeout` registered at startup in `server/index.js`

**How the pieces connect**
1. Sierra Chart (charting platform running on Windows, mounted at `/mnt/c/SierraChart/...`) writes Trade Activity Log (TAL) export files and 1-minute price-bar data files to disk.
2. Backend ingestion pathways (cron + pollers, see §2) read those files, parse them, and write rows into `trades`, `price_bars`, `daily_logs`, etc.
3. Backend services (`caseEngine.js`, `acdService.js`, `phaseChangeDetector.js`, …) compute derived analytics (ACD levels, day-type classification, setups, phase changes) from the raw `price_bars`/`trades` data and persist results to their own tables.
4. REST API routes (`server/routes/*.js`) expose both raw data and computed analytics to the frontend; Socket.IO pushes live updates (price sync, setup alerts, DLL/profit-lock status, process-health alerts).
5. The React dashboard (`DashboardView.jsx` + many sub-panels) polls these endpoints on fixed intervals and renders cards/charts/tables; a separate "Auction Read" / "Live Case" sidebar consumes the live analytics endpoints for real-time intraday narrative.

**Data flow summary**
```
Sierra Chart (TAL exports, 1-min bars)
   → file-system ingestion (cron + watchers)
   → trades / price_bars / daily_logs (raw)
   → caseEngine / acdService / phaseChangeDetector / patternMemoryUpdate (derived analytics)
   → acd_daily_log / active_setups / phase_change_alerts / pattern_stats / daytype_accuracy_log (computed)
   → REST API (server/routes/*.js)
   → React dashboard (App.jsx, DashboardView.jsx, MorningBriefPanel, …) via polling + Socket.IO
```

---

## 2. DATA SOURCES & INGESTION

| Pathway | Trigger / Schedule | Reads | Writes to | Status |
|---|---|---|---|---|
| **Trade Import (TAL)** | Cron `0 16 * * 1-5` (4:00 PM ET, weekdays) in `index.js:392`, plus an intraday 30-min poller during market hours (`index.js:692`) | `TradeActivityLogExport_<date>.txt` files in `/mnt/c/SierraChart/SavedTradeActivity/` via `tradeImportService.js` | `trades`, `import_log` | **ACTIVE** |
| **Price Bar polling** | `setInterval` every 60s, `index.js:668` (`scanAndIngestNewBarFiles`) | New 1-minute bar files in `SIERRA_DATA_DIR` | `price_bars`, `price_bar_ingests` | **ACTIVE** — also triggers `expireStaleSetups`, DLL check, profit-lock check, and `autoComputeTodayACD` on new bars |
| **SierraWatcher** | Constructed at `index.js:229` but never `.start()`-ed; `sierraWatcher.js:11` constructor signature mismatch with the call site | (file watcher for chart images) | — | **DORMANT / dead code** |
| **DTC protocol prototype** | Manual script run (`scripts/dtc_phase0_test.cjs`) | Direct DTC socket connection to Sierra Chart | console output only | **TEST PROTOTYPE** — not wired into the running app |
| **Scheduled Analytics jobs** | Multiple crons (Morning Brief, Daily Coaching, Weekly/Monthly Report, Pattern Memory, Combo Backtest — see §8) | `trades`, `price_bars`, `acd_daily_log`, etc. | `morning_briefs`, `daily_coaching`, `weekly_assessments`, `pattern_stats`, `combo_stats`, `daytype_accuracy_log`, … | **ACTIVE** |
| **ACD Backfill** | One-time `setTimeout` at startup, `index.js:615` (`autoBulkBackfillIfEmpty`), only runs if `acd_daily_log` or `acd_weekly_log` is empty | `price_bars` | `acd_daily_log`, `acd_weekly_log` | **ACTIVE one-time** (no-op once history exists) |

Chart image upload (`POST /api/charts/:date/upload`, `sierra.js`) is a manual user-driven pathway, not scheduled ingestion.

---

## 3. DATABASE

43 tables in the `public` schema. Row counts captured 2026-06-07.

### Core trading data
| Table | Cols | Rows | Purpose / key columns |
|---|---|---|---|
| `trades` | 29 | 35,790 | Every imported fill/trade. `log_date`, `pnl`, `custom_fields` (JSONB — holds `account`, `sierra_data` with TAL fields like `Cumulative Profit/Loss (C)`, `FlatToFlat Profit/Loss (C)`) |
| `daily_logs` | 10 | 336 | One row per trading day — daily P&L summary, notes |
| `import_log` | 8 | 28 | Record of each TAL file import (file name, counts, status) |
| `trade_screenshots` | 6 | 0 | Screenshot attachments per trade — feature unused |
| `trade_timeline_events` | 25 | 23 | Timeline annotations on individual trades |
| `account_settings` | 9 | 157 | Per-account configuration (risk limits, labels) |
| `custom_field_definitions` | 8 | 4 | Schema metadata for `trades.custom_fields` |

### Price / market structure
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `price_bars` | 12 | 623,900 | 1-minute OHLCV bars, `symbol`+`ts`. Backbone of nearly all derived analytics |
| `price_bar_ingests` | 9 | 21 | Log of bar-file ingestion runs |
| `daily_charts` | 11 | 4 | Uploaded chart images per date — lightly used |
| `session_volume_summary` | 10 | 0 | Planned per-session volume rollups — empty |
| `trading_sessions` | 7 | 0 | Planned session metadata table — empty |

### ACD (Auction/Composite/Distribution) system
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `acd_daily_log` | 20 | 380 | Daily ACD computation: OR high/low, IB structure, `daily_score`, `day_type` (ground truth), NL inputs |
| `acd_weekly_log` | 17 | 65 | Weekly rollup of ACD data |
| `acd_monthly_pivot` | 9 | 2 | Monthly pivot levels — sparsely populated (only computed going forward) |
| `acd_setup_events` | 13 | 4,357 | Discrete intraday setup/event detections tied to ACD structure |
| `acd_backtest_results` | 21 | 1,080 | Stored results of ACD backtests (`acdBacktest.js`) |
| `weekly_ib_structure` | 17 | 3 | Weekly Initial Balance structure analysis — early stage |
| `weekly_assessments` | 20 | 9 | Weekly narrative/assessment records |

### Setups / active tracking
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `active_setups` | 30 | 26 | Currently-live setup instances tracked in real time |
| `setup_types` | 5 | 7 | Catalog of setup type definitions |
| `setup_move_stats` | 10 | 96 | Historical move statistics per setup type |
| `setup_outcome_backtest` | 21 | 10 | Backtest of setup outcomes |
| `setup_correlation_cache` | 12 | 22 | Cached correlation computations between setups |

### Day-type classifier & accuracy
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `daytype_accuracy_log` | 11 | 353 | Predicted-vs-actual day-type log: `trade_date` (UNIQUE), `intraday_call`, `eod_truth`, `matched`, `session_range`, `close_pct`, `trend_strength`, `or_width`, `nl30`, `logged_at`. Backfilled by `scripts/backfill_accuracy_log.js`; appended to going forward by `daily_coaching.js`. Backs `getDayTypeAccuracyStats()` in `caseEngine.js` |

### Pattern memory / condition tracking
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `pattern_stats` | 20 | 3,810 | Historical pattern occurrence/outcome stats, updated nightly by `patternMemoryUpdate.js` |
| `condition_memory` | 28 | 23 | Tracked market-condition memory entries |
| `combo_stats` | 13 | 11 | Multi-condition combination statistics, refreshed by `scripts/combo_backtest.js` |

### Phase-change detection
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `phase_change_alerts` | 33 | 0 | Live phase-change alerts — table exists, detector running, but **no alerts logged yet** |
| `phase_change_backtest_results` | 31 | 2 | Backtest results for the phase-change detector |

### Performance analytics / risk
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `daily_performance` | 9 | 335 | Daily performance metrics rollup |
| `daily_performance_log` | 29 | 330 | Extended per-day performance log |
| `risk_settings` | 12 | 1 | Singleton row of risk-management configuration |
| `rule_overrides` | 7 | 14 | User-entered overrides to coaching/process rules |

### Reports & coaching
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `morning_briefs` | 5 | 5 | Generated morning-brief text, one per day run |
| `daily_coaching` | 11 | 34 | Generated end-of-day coaching narrative + logged day-type prediction |
| `process_log` | 10 | 70 | Log of scheduled-job executions (`logProcess` wrapper) — used for process-health monitoring |

### Profit-lock / DLL (Daily Loss Limit)
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `profit_lock_config` | 7 | 1 | Singleton config for the profit-lock system |
| `profit_lock_events` | 11 | 7 | Log of profit-lock trigger events |

### Auction Read
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `auction_reads` | 28 | 1 | Snapshot rows of the live "Auction Read" computation — essentially unpopulated (live reads are computed on the fly from bars, not persisted) |
| `auction_history` | 31 | 106 | Historical auction-read snapshots |

### Wyckoff / SOT (misc analytical extensions)
| Table | Cols | Rows | Purpose |
|---|---|---|---|
| `wyckoff_levels` | 13 | 0 | Wyckoff level definitions — table exists, feature unused/empty |
| `sot_signals` | 10 | 0 | "Sign of Trouble"-style signal table — empty |

**Indexes**: most high-volume tables (`price_bars`, `trades`, `acd_setup_events`, `pattern_stats`) have composite indexes on `(symbol, ts)` / `(log_date, account)` / `trade_date` to support the time-range and per-account queries that dominate the route layer. `daytype_accuracy_log.trade_date` carries a UNIQUE constraint enabling idempotent UPSERT backfills.

---

## 4. BACKEND — API ENDPOINTS

Grouped by route file (`server/routes/`). "⏱" flags endpoints doing heavy computation or hit by frontend pollers.

### `acd.js` — ACD core + setups + live read
`/acd/today`, `/acd/daily` (GET/POST), `/acd/numberline` ⏱, `/acd/pivot/current`, `/acd/pivot` (POST), `/acd/backtest/results|status|run` ⏱, `/acd/context`, `/acd/autocompute` (POST) ⏱, `/acd/structural-events/backfill*` ⏱, `/acd/autocompute/bulk*` ⏱, `/acd/pivot/autocompute`, `/acd/correlation`, `/acd/weekly*`, `/acd/confluence`, `/acd/nq/latest`, `/acd/numberline/history`, `/acd/setup-events*`, `/acd/level-confidence`, `/acd/live` ⏱ (drives Live Case sidebar), `/acd/setup-detection`, `/setups/active|today|stats`, `/setups/:id/outcome` (POST), `/timeline/today`, `/setups/playbook-reference`

### `auctionRead.js` — intraday auction narrative
`/auction-read/day-setups`, `/composite-profile`, `/auction-read/auto` ⏱ (live composite read, polled), `/auction-read/correlation*`, `/auction-read/history*`, `/auction-read/today` (GET/POST), `/auction-read/midday`, `/auction-read/eod`

### `backtest.js` — generic backtest views
`/backtest/efficiency`, `/backtest`, `/backtest/conditions`

### `behavior.js`
`/stats/behavior`

### `calendar.js`
`/calendar/coaching/:date` (GET + PATCH `:date/read`), `/calendar/weekly/:weekStart`

### `case.js`
`/case` ⏱ — full computed "case" object (calls `computeCase` in `caseEngine.js`), heavily polled by Live Case sidebar

### `confluence.js`
`/confluence/today` ⏱ — polled every 5 minutes by frontend

### `dailyLogs.js`
`/daily-logs/:date` (GET/PUT), `/daily-logs`

### `dll.js` — Daily Loss Limit
`/dll/status`, `/eval/progress`, `/dll/weekly-summary`

### `edge.js`
`/analysis/edge`

### `keyLevels.js`
`/stats/key-levels`, `/chart/live-day` ⏱

### `longterm.js`
`/longterm/summary`, `/longterm/profile-shape/:date` (GET/POST)

### `morningBrief.js`
`/dates`, `/:date?`

### `pattern.js`
`/pattern/update/:tradeDate` (POST) ⏱, `/pattern/update-move-stats/:tradeDate` (POST), `/pattern/backfill` (POST) ⏱, `/pattern/today-combination`, `/pattern/stats`, `/pattern/daily-log`, `/pattern/combinations`

### `phaseChange.js`
`/phase-change/current-state` ⏱, `/phase-change/alerts/today`, `/phase-change/alerts/:id/override|acknowledge|outcome`, `/phase-change/backtest/run|status/:jobId|results` ⏱, `/phase-change/forward-test`

### `priceBars.js`
`/price-bars/status`, `/price-bars/ingest` (POST) ⏱, `/price-bars/query` ⏱, `/price-bars/volume-profile` ⏱, `/price-bars/available`

### `profitLock.js`
`/profit-lock/status`, `/profit-lock/config` (GET/PUT), `/profit-lock/1pm-ack` (POST), `/profit-lock/history`

### `ruleOverrides.js`
`/rule-overrides` (GET/POST)

### `scenario.js` — Scenario Tester suite
`/scenario` (POST) ⏱, `/scenario/dll-compare` (POST) ⏱, `/scenario/accounts`, `/scenario/patterns` (POST) ⏱, `/scenario/optimize` (POST) ⏱⏱ (parameter optimizer — grid search), `/scenario/monte-carlo` (POST) ⏱⏱ (5,000-iteration simulation)

### `settings.js`
`/settings/process-health`, `/settings/process-overdue`, `/setup-types`, `/custom-fields`, `/health`

### `setups.js`
`/setups/tp-recommendation`, `/setups/best-by-date`, `/setups/for-date`, `/setups/backtest/run` (POST) ⏱, `/setups/backtest/edge`, `/setups/backtest`

### `sierra.js`
`/sierra/status`, `/sierra/import` (POST) ⏱, `/sierra/history`, `/trigger-export` (POST), `/charts/dates`, `/charts/:date`, `/charts/:date/upload|analyze` (POST), `/charts/:date` (DELETE)

### `stats.js` — core stats + risk + sessions
`/stats/overview`, `/stats/top-symbols`, `/stats/cumulative-pnl`, `/stats/by-hour|by-day-of-week|by-duration`, `/stats/daily` ⏱, `/stats/by-setup`, `/risk/q1-winrate`, `/risk/settings` (GET/POST), `/risk/stats|ruin|ruin/compare|kelly|sizing` ⏱, `/sessions/current|open|close`, `/stats/combo-stats`, `/stats/combo-stats/rerun` (POST) ⏱⏱

### `tearsheet.js`
`/stats/tearsheet-overview`, `/stats/pnl-distribution`, `/stats/timing-heatmap`, `/stats/rolling`, `/stats/monthly-heatmap`, `/stats/excursion`, `/stats/optimization`, `/stats/trade-location`

### `trades.js`
`/trades/:date`, `/trades` (GET/POST), `/trades/:id` (PUT/DELETE), `/trades/:tradeId/screenshots` (POST), `/screenshots/:id` (DELETE), `/accounts`, `/accounts/last-day`

### `weekly.js`
`/weekly/current`, `/weekly/va-history`, `/daily/va-history`, `/weekly/bars`, `/weekly/history`, `/weekly/monday` (POST), `/weekly/:id` (PUT), `/weekly/assessments`, `/weekly/assessment/:weekStart?`

### `wyckoff.js`
`/wyckoff/levels` (GET/POST/PUT/DELETE), `/wyckoff/setups/stats`, `/wyckoff/effort-result`, `/wyckoff/sot`

---

## 5. BACKEND — SERVICES / ENGINES

### `caseEngine.js` — primary analytical engine
- `computeCase(...)` — builds the full "case" object served by `GET /case` and `GET /acd/live`: combines opening-type classification, day-type classification, key levels, impact stack (weighted list of bullish/bearish factors), and accuracy annotations.
- `classifyOpeningType(bars)` (exported) — pure function; classifies the session's opening structure from the first 5 RTH bars (9:30–9:34 ET).
- `classifyDayType({ openingType, nl30, orWidth, asOfMinutes, accuracyStats })` (exported) — pure function; classifies the day as `TREND` / `BALANCE` / `TURBULENT` / `FORMING`. **Decision-tree logic and thresholds are unchanged** from before this session's work — only the *display* of confidence/accuracy was made live (see below).
- `getDayTypeAccuracyStats()` (exported, async) — queries `daytype_accuracy_log` for live overall accuracy and per-type precision, with a 5-minute in-memory cache (`_dayTypeAccuracyCache`).
- `dayTypeAccuracyNote(type, stats)` — builds the human-readable accuracy string shown alongside each call (`"N% hit rate on TYPE calls (n=N live, see daytype_accuracy_log)"`, or `"measuring — N sessions"` if the sample is below 20).

**Classifier inputs**: `openingType` (from first-5-bar shape), `nl30` (rolling 30-day sum of `daily_score` from `acd_daily_log`), `orWidth` (Opening Range high − low), `asOfMinutes` (minutes since midnight ET — drives which decision branch is reachable).

**Commit timing / re-evaluation**: the live call site re-runs `classifyOpeningType` + `classifyDayType` at IB close (10:30 ET) using the confirmed IB-break status, rather than freezing the call at 9:35 (this was a fix made prior to this session — see `[[project_daytype_accuracy_backlog]]`). `getDayTypeAccuracyStats()` is awaited fresh on each `computeCase` run (subject to its 5-minute cache), so confidence labels reflect the live measured accuracy.

**Accuracy figures are now fully live** (Step 4 of this session): `DAYTYPE_LOW_CONFIDENCE` is no longer a hardcoded constant — it's computed per-call as `lowConfidence = overallPct == null || overallPct < 60`. As of the last backfill: overall accuracy 53.0% (353 scored / 2 skipped sessions), so the system currently runs in low-confidence mode. Per-type precision (the figure surfaced in the UI): TREND ≈ 26.1% (n small), BALANCE and TURBULENT higher — see `daytype_accuracy_log` for current numbers, which shift slightly as new sessions are appended nightly by `daily_coaching.js`.

### `phaseChangeDetector.js`
Detects intraday "phase changes" (shifts in market character — e.g., balance → trend) from live price-bar sequences; emits alerts persisted to `phase_change_alerts` (currently empty — detector running but no qualifying alerts logged yet) and surfaced via `/phase-change/current-state`.

### `acdService.js`
Core ACD (Auction/Composite/Distribution) computation library — builds daily/weekly ACD records (OR, IB, daily score, numberline) from `price_bars`, persisted to `acd_daily_log` / `acd_weekly_log`. Backs most of `acd.js`'s compute endpoints.

### `queries.js`
Shared SQL query builders/constants used across routes — includes some **hardcoded reversal-rate constants** (lines ~199–205) flagged as technical debt in §9.

### `setupEmitter.js`
Emits/tracks setup lifecycle events (creation, expiration) into `acd_setup_events` / `active_setups`, and pushes Socket.IO notifications (`expireStaleSetups`).

### `patternMemoryUpdate.js`
`runNightlyUpdate(tradeDate, io)` — nightly job that recomputes pattern occurrence/outcome statistics into `pattern_stats` and `condition_memory`.

### `setupBacktestService.js`
Backtests setup-type performance against historical price/trade data, backing `/setups/backtest*` and populating `setup_outcome_backtest` / `setup_move_stats`.

### `phaseChangeBacktest.js`
Backtests the phase-change detector against historical bars; results land in `phase_change_backtest_results`.

### `acdBacktest.js`
Backtests ACD-derived setups/levels against historical outcomes; results land in `acd_backtest_results`.

### `priceBarService.js`
Ingests and queries 1-minute price-bar data; backs the price-bar polling pathway (§2) and `/price-bars/*` endpoints.

### `tradeImportService.js`
Parses Sierra Chart TAL export files (handles both TAL and legacy Activity Log formats, BP/EP markers, CumPL diffing) and writes to `trades` / `import_log`.

---

## 6. FRONTEND — STRUCTURE

**Top-level**: `src/App.jsx` (~19,000 lines) is a single monolithic component housing routing/tabs, shared state (selected account lifted to `App` for both Calendar and Dashboard), and most panel implementations inline. `src/components/dashboard/` holds the more recently extracted dashboard pieces.

**Views / tabs** (selected in `App.jsx`): Dashboard, Calendar, Trades, Stats/Tearsheet, Scenario Tester, Setups, Auction Read / Live Case, Settings — navigated via a top-level tab switcher in `App.jsx`.

**Dashboard card layout** (`DashboardView.jsx`):
- `StatsGrid` — top-line P&L / win-rate / streak cards
- `PerformanceVisuals` — equity curve and related charts
- `PnlCharts` — P&L distribution charts
- `SymbolsTable` — per-symbol breakdown
- `SetupsTable` — active/recent setups
- `OptimizationSection` — links into Scenario Tester results
- `BehaviorSection` — behavioral stats (from `/stats/behavior`)

**Sidebar / Live Read**: `LiveReadPanel`-style components consume `/acd/live` and `/auction-read/auto` to render the running intraday narrative (opening type, day-type call + live accuracy note, key levels, impact stack) — refreshed on a 10-second poll (`App.jsx:1207`).

**`CaseContext`**: shared React context that wraps the `/case` endpoint result, feeding the day-type/impact-stack data to multiple consumers without prop-drilling.

**Persistent narrative panels**: `MorningBriefPanel`, `MarketRecapPanel`, `WeeklyReportPanel` — render generated text from `morning_briefs` / `daily_coaching` / `weekly_assessments`.

**Polling intervals** (verified in `App.jsx`, all via `setInterval`):
| Interval | Lines (examples) | What it refreshes |
|---|---|---|
| 10,000 ms | `App.jsx:1207` | Live case / setup / event data |
| 30,000 ms | `App.jsx:9140`, `:10293`, `:14859` | NQ live price, auto-refresh sections |
| 60,000 ms | `App.jsx:877`, `:9123`, `:9895`, `:10136`, `:11746` | Socket fallback polling, setup lists, live read |
| 5 × 60,000 ms (5 min) | `App.jsx:11743`, `:12700`, `:12784`, `:12792`, `:12993`, `:14332`, `:15174` | Confluence, pattern combinations, optimization sections |
| 15 × 60,000 ms (15 min) | `App.jsx:12287`, `:12443` | Lower-frequency analytical sections (longer-running computations) |

(The "30,000ms NQ price / 300,000ms confluence-patterns / 900,000ms config / 10,000ms live case / 60,000ms socket fallback" figures referenced in earlier session notes correspond to these same intervals.)

---

## 7. ANALYSIS TOOLS

### Scenario Tester (`scenario.js` route + frontend tab)
Runs "what-if" trade-rule scenarios against historical trade data (`POST /scenario`), with sub-tools:
- **DLL Compare** (`/scenario/dll-compare`) — compares scenario performance against the daily-loss-limit rules
- **Pattern analysis** (`/scenario/patterns`) — surfaces which market-condition patterns drive scenario outcomes
- **Parameter Optimizer** (`/scenario/optimize`) — grid-searches scenario parameters; guards against overfitting via an in-sample/out-of-sample (IS/OOS) split, a plateau-ratio check, and labels each result **ROBUST** / **OVERFIT** / **FRAGILE**; capped at 3,000 parameter combinations per run
- **Monte Carlo** (`/scenario/monte-carlo`) — runs 5,000 iterations of resampled trade sequences, reports percentile distributions of outcome metrics

(Per the 6aa641c commit, "Backtest Rules" was retired in favor of this consolidated Scenario Tester.)

### `scripts/combo_backtest.js`
Standalone script (run nightly via cron, §8) that backtests 13 fixed condition-combinations at a $20/point outcome assumption, writing results to `combo_stats`.

### `scripts/derive_day_types.js`
Standalone script that derives ground-truth day-type labels for historical sessions using the confirmed rules: `TREND` if (`close_pct` ≥ 0.80 or ≤ 0.20) AND `trend_strength` ≥ 0.50 AND `range_ratio` ≥ 0.75 AND price closes outside the IB; `TURBULENT` if `range_ratio` ≥ 1.25 and not TREND; otherwise `BALANCE`. Writes/validates `acd_daily_log.day_type`.

### `scripts/backfill_accuracy_log.js`
One-time/idempotent backfill (built this session, Step 3): reconstructs what `classifyDayType` would have predicted at 10:05 ET for every completed historical session (using faithfully-reconstructed `openingType`, `nl30`, `orWidth` inputs), compares to ground truth, and UPSERTs into `daytype_accuracy_log`. Last run: **353 scored, 2 skipped** (2025-10-10, 2025-11-07 — missing first-5-bar data). Produces a full accuracy report (overall %, per-type precision/recall, confusion matrix, miss/false-positive breakdowns).

### `daytype_accuracy_log` (table — see §3)
Living record of classifier performance. Populated by the backfill script (history) and appended to nightly by `daily_coaching.js` (going forward). Read live by `getDayTypeAccuracyStats()` in `caseEngine.js` to drive the UI's confidence display.

### Pattern analysis (`pattern.js` + `patternMemoryUpdate.js`)
Nightly recomputation of pattern/condition outcome statistics (`pattern_stats`, `condition_memory`), exposed via `/pattern/*` for the frontend's pattern-combination views.

---

## 8. SCHEDULED JOBS

All times America/New_York. Source: `server/index.js`.

| Schedule | Line | Job | What it does |
|---|---|---|---|
| `0 7 * * 1-5` | 386 | Morning Brief | `runMorningBriefLogged()` → generates and stores the morning brief narrative |
| `0 16 * * 1-5` | 392 | Auto-Import (4:00 PM) | Imports the day's TAL export file into `trades` |
| `0 13 * * 1-5` | 415 | 1 PM Reminder | Computes today's running P&L and emits a mid-day reminder/alert |
| `5 16 * * 1-5` | 433 | Pattern Memory (nightly) | `logProcess('PATTERN_MEMORY', runNightlyUpdate)` — recomputes pattern stats |
| `45 16 * * 1-5` | 439 | Daily Coaching | `runDailyCoaching()` — generates coaching narrative AND logs the day's day-type prediction vs. ground truth into `daytype_accuracy_log` |
| `0 18 * * 0` | 449 | Weekly Report | `runWeeklyReport()` — generates weekly assessment |
| `30 18 * * 0` | 459 | Combo Backtest | Spawns `scripts/combo_backtest.js` as a detached child process |
| `0 19 * * 0` | 471 | Monthly Report | `runMonthlyReport()` — only fires if it's the first Sunday of the month (`d.getDate() > 7` guard) |
| `*/30 * * * *` | 480 | Self-Healing Catch-up | Periodic check (every 30 min) that retries/repairs missed scheduled work |

**Raw `setInterval`/`setTimeout` startup tasks** (not `node-cron`, registered once at server start):
| Interval | Line | Job |
|---|---|---|
| one-time, +2s | 105 | `scanAndSaveSetupEvents(todayET)` |
| one-time, +30s | 181 | `startChartImageWatcher` |
| every 5 min | 198 | Chart-image directory scan/cleanup |
| every 1 hr | 595 | Process-health overdue check → emits `process-health-alert` (weekday market hours only) |
| one-time, +3s | 612 | `autoBulkBackfillIfEmpty` (ACD daily backfill if `acd_daily_log` empty) |
| one-time, +5s | 634 | `autoComputeTodayACD` |
| every 60s | 668 | Expire stale setups, scan/ingest new bar files, DLL + profit-lock checks (the main "live loop") |
| one-time, +8s | 745 | Weekly ACD backfill check (logs guidance only — actual backfill is manual via `/acd/weekly/bulk-backfill`) |
| every 60s | 692 | Intraday auto-import poller (9:30 AM–1:00 PM ET, weekdays) |
| every 60s | 732 | **Duplicate** pattern-memory trigger — fires `runNightlyUpdate` if the clock shows 16:05–16:10 ET on a weekday (overlaps with the `5 16 * * 1-5` cron at line 433 — see §9) |

---

## 9. KNOWN ISSUES / TECHNICAL DEBT

1. **Three competing day-type classifiers** exist in the codebase simultaneously:
   - `caseEngine.js` → `classifyDayType` (the "official" one, now accuracy-tracked via `daytype_accuracy_log`)
   - `auctionRead.js` → `dayTypeDeveloping` (separate intraday heuristic)
   - `acd.js` → an implicit OR-range-based day-type inference embedded in route logic
   These are not unified; they can disagree, and only `caseEngine.js`'s version is currently measured for accuracy.

2. **SierraWatcher dead code**: instantiated at `index.js:229` but its constructor signature in `sierraWatcher.js:11` doesn't match the call site, and `.start()` is never invoked — the watcher never runs.

3. **Duplicate pattern-memory trigger**: the nightly pattern update fires both from the `5 16 * * 1-5` cron (`index.js:433`) and from a parallel `setInterval` time-window check (`index.js:732`, fires 16:05–16:10). Both call `runNightlyUpdate` — likely redundant execution on most weekdays.

4. **Hardcoded reversal-rate constants** in `queries.js` (~lines 199–205) — magic numbers not derived from live data, unlike the day-type accuracy figures which were made live this session.

5. **Silent error handling**: numerous `catch (e) { /* silent */ }` / `catch (_) {}` blocks throughout `index.js` (e.g., lines 612, 668-area) swallow errors without logging, making failures hard to diagnose.

6. **Undefined-variable bug**: `index.js:718` references `target.name` where `target` appears to be undefined in that code path (latent bug in the intraday auto-import poller).

7. **Backup files committed to the tree**: `index.js.backup` / `index.js.bak`-style files exist alongside the live source — clutter and a source of confusion about which file is authoritative.

8. **Empty/unused tables**: `phase_change_alerts` (detector runs, never logs a qualifying alert), `wyckoff_levels`, `sot_signals`, `trade_screenshots`, `trading_sessions`, `session_volume_summary`, `auction_reads` (effectively unpopulated — live reads computed on the fly, not persisted) — features scaffolded in the schema but not exercised by the running app.

9. **`App.jsx` monolith**: ~19,000 lines in a single component file; most dashboard/panel logic lives inline rather than in `src/components/`, making the file difficult to navigate and test in isolation.

10. **DTC prototype not integrated**: `scripts/dtc_phase0_test.cjs` demonstrates a direct DTC-protocol connection to Sierra Chart but is a standalone test script, not wired into the running ingestion pipeline.

11. **Parked v2 candidate**: `docs/daytype_classifier_v2_candidate.md` documents a proposed "IB candidate" enhancement to the day-type classifier. Per explicit instruction this session, it has **not** been wired in — it remains a parked design doc pending the accuracy-measurement window (re-evaluate ~2026-07-07, 20 trading days after the 2026-06-06 timing fix — see `[[project_daytype_accuracy_backlog]]`).

---

*Generated 2026-06-07. Reflects code state as of commit `6aa641c` plus this session's Step 3/4 changes to `caseEngine.js`, `daily_coaching.js`, and the new `scripts/backfill_accuracy_log.js`.*
