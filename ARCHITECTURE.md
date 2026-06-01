# Trading Journal Architecture

## System Overview

```
┌──────────────────────┐         ┌──────────────────────┐
│   React Frontend     │ ◄─────► │   Express Backend    │
│   (Port 5173)        │  HTTP   │   (Port 3001)        │
│                      │         │                      │
│  - Calendar View     │         │  - REST API          │
│  - Dashboard         │         │  - File Upload       │
│  - All Trades        │         │  - Sierra Watcher    │
│  - Settings          │         │  - Socket.IO         │
└──────────────────────┘         └──────────┬───────────┘
                                            │
                                            │ SQL
                                            ▼
                                 ┌──────────────────────┐
                                 │   PostgreSQL DB      │
                                 │   (Port 5432)        │
                                 │                      │
                                 │  - daily_logs        │
                                 │  - trades            │
                                 │  - trade_screenshots │
                                 │  - setup_types       │
                                 │  - custom_fields     │
                                 └──────────────────────┘
                                            ▲
                                            │ import
                                 ┌──────────────────────┐
                                 │  Sierra Chart TAL    │
                                 │  file watcher        │
                                 │  (chokidar)          │
                                 └──────────────────────┘
```

---

## Database Schema

### Tables

| Table | Purpose |
|-------|---------|
| `daily_logs` | One row per trading day — sleep quality, mood, market condition, pre/post-market notes, lessons learned |
| `trades` | Individual fills — entry/exit times, symbol, direction, qty, prices, P&L, fees, setup type, tags (JSONB), custom_fields (JSONB) |
| `trade_screenshots` | Images attached to trades, stored in `server/uploads/` |
| `setup_types` | Configurable setup names (pre-populated with defaults) |
| `custom_field_definitions` | Configurable extra fields per trade |

### Key Columns in `trades`

```
trades
├── id                  # Primary key
├── log_date            # Foreign key → daily_logs
├── entry_time
├── exit_time
├── symbol
├── direction           # LONG / SHORT
├── quantity
├── entry_price
├── exit_price
├── pnl
├── fees
├── setup_type
├── trade_notes
├── tags                # JSONB array
└── custom_fields       # JSONB — stores sierra_data, account, sierra_row, etc.
```

Key JSONB paths used by Sierra Chart imports:
- `custom_fields->>'account'` — account identifier
- `custom_fields->'sierra_data'->>'Entry DateTime'` — raw entry datetime (may end with ` BP`)
- `custom_fields->'sierra_data'->>'Exit DateTime'` — raw exit datetime (may end with ` EP`)
- `custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)'` — running account total
- `custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)'` — per-session P&L at EP boundary
- `custom_fields->'sierra_data'->>'sierra_row'` — original file row number (sort tiebreaker)

### View

| View | Purpose |
|------|---------|
| `daily_performance` | Aggregated per-day stats: trade count, win rate, total P&L, best/worst trade |

### Schema Relationships

```
daily_logs (1) ──────► trades (many)
                            │
                            └──────► trade_screenshots (many)

daily_logs ──────────────► daily_performance (view, aggregated)
```

---

## API Routes Reference

All stats endpoints support `?dateFrom=YYYY-MM-DD`, `?dateTo=YYYY-MM-DD`, `?account=...` filters.

### Daily Logs (`/api/daily-logs`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/daily-logs` | All logs with daily P&L |
| GET | `/api/daily-logs/:date` | Single day log (auto-creates if missing) |
| PUT | `/api/daily-logs/:date` | Update log fields |

### Trades (`/api/trades`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/trades` | All trades |
| GET | `/api/trades/:date` | Trades for a specific date |
| POST | `/api/trades` | Create trade |
| PUT | `/api/trades/:id` | Update trade (including tags) |
| DELETE | `/api/trades/:id` | Delete trade |

### Screenshots

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/trades/:tradeId/screenshots` | Upload image (10 MB max) |
| DELETE | `/api/screenshots/:id` | Delete screenshot |

### Analytics (`/api/stats`)

| Path | Description |
|------|-------------|
| `/api/stats/overview` | KPIs: total trades, win rate, profit factor, max drawdown, streaks |
| `/api/stats/daily` | Daily P&L bar chart data |
| `/api/stats/cumulative-pnl` | Equity curve |
| `/api/stats/by-hour` | P&L by hour of day (ET) |
| `/api/stats/by-day-of-week` | P&L by weekday |
| `/api/stats/by-duration` | P&L by trade duration bucket |
| `/api/stats/by-setup` | P&L by setup type |
| `/api/stats/top-symbols` | Top performing symbols |

### Other

| Path | Description |
|------|-------------|
| `/api/accounts` | Unique account list ordered by most recently active |
| `/api/sierra/status` | File watcher status |
| `/api/sierra/import` | Manual import from file path |
| `/api/sierra/history` | Import history (last 50) |
| `/api/setup-types` | Setup type list |
| `/api/custom-fields` | Custom field definitions |
| `/api/trigger-export` | Triggers Sierra Chart TAL export via PowerShell |
| `/health` | Health check |

---

## Data Flow

### Sierra Chart TAL Import

```
Sierra Chart exports TAL file
        │
        ▼
chokidar detects file change
        │
        ▼  (wait SIERRA_STABILITY_THRESHOLD ms for file to settle)
sierra.js parses tab-separated TAL file
        │
        ▼
For each row: extract BP/EP markers, account, prices, CumPL
        │
        ▼
Count-based dedup check against DB
(entry_time, exit_time, symbol, direction, qty, entry_price, exit_price, account)
        │
        ▼
INSERT only net-new rows into trades table
        │
        ▼
Socket.IO broadcasts update to connected frontend clients
```

### Dashboard Load

```
Dashboard mounts
        │
        ├──► GET /api/stats/overview   ──► SQL aggregate over trades + daily_performance view
        ├──► GET /api/stats/daily      ──► CumPL diff CTE (see below)
        ├──► GET /api/stats/by-setup   ──► GROUP BY setup_type
        └──► GET /api/accounts         ──► DISTINCT accounts ordered by last active
                │
                ▼
        Render charts & KPI cards
```

### Manual Trade Add

```
User submits trade form
        │
        ▼
POST /api/trades
        │
        ▼
INSERT into trades (and daily_logs if date is new)
        │
        ▼
Return new trade as JSON
        │
        ▼
React updates trades state → TradeCard renders → stats refresh
```

---

## Key Design Decisions

### P&L Calculation (CumPL Diff)

Raw fill sums overcount P&L when positions are scaled. The correct approach uses `Cumulative Profit/Loss (C)` diffs at EP (end-of-flat) boundaries:

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

Fallback to `SUM(t.pnl)` for Activity Log format data that lacks CumPL fields.

### TAL Markers

- **BP** (`Entry DateTime` ends with ` BP`): position opened from flat — marks session start
- **EP** (`Exit DateTime` ends with ` EP`): position returned to flat — marks session end and is the authoritative P&L boundary

Fill grouping in the UI uses BP → EP boundaries. The label sequence within a group is: Entry (BP fill), Add, Partial Exit, Exit (EP fill).

### Count-Based Deduplication

Sierra Chart can repeat identical fill rows (e.g., scaling in at the same price). The dedup key is `(entry_time, exit_time, symbol, direction, quantity, entry_price, exit_price, account)`. If the file contains N rows matching that key and M already exist in the DB, `N − M` rows are inserted. This preserves scaled-in positions without creating duplicates on re-import.

### JSONB for Sierra Data

Sierra Chart TAL columns are stored as JSONB in `custom_fields->'sierra_data'` rather than typed columns. This allows the schema to accommodate any TAL column without migrations, and lets both TAL and older Activity Log formats coexist in the same table.

### Account Filter (Shared State)

`/api/accounts` returns accounts ordered by most recently active. The app defaults to `data[0]`. Both Calendar and Dashboard share the selected account via state lifted to the App component.

---

## File/Directory Structure

```
trading-journal/
│
├── package.json              # Dependencies and npm scripts
├── vite.config.js            # Vite dev server config
├── index.html                # HTML entry point (loads React)
├── .env.example              # Environment variables template
├── .gitignore                # Git ignore rules
│
├── start.sh                  # One-command startup (kills stale, checks pg, starts all)
├── stop.sh                   # Force-kills all processes, frees ports
├── restart.sh                # stop + start in sequence
│
├── server/
│   ├── index.js              # Express server — all API routes, Sierra watcher setup
│   ├── db.js                 # PostgreSQL connection pool and query helper
│   ├── schema.sql            # Table/index/view definitions, pre-populated setup types
│   ├── sierra.js             # TAL file parser, chokidar watcher, import logic
│   ├── scripts/
│   │   └── setupDb.js        # Reads schema.sql and runs it — called by npm run db:setup
│   └── uploads/              # Screenshot storage (served as static files)
│       └── .gitkeep
│
└── src/
    ├── main.jsx              # React entry point — renders App to DOM
    ├── App.jsx               # Main React app — all views, state, API calls
    ├── App.css               # All component styles, dark theme, CSS variables
    └── index.css             # Base CSS resets and fonts
```

### Service Files

| File | Role |
|------|------|
| `server/index.js` | Express app, all route handlers, multer file upload config, Sierra watcher initialization |
| `server/db.js` | `pg` connection pool; exports a `query(sql, params)` helper used by all routes |
| `server/schema.sql` | Source of truth for DB structure; re-runnable (uses `CREATE TABLE IF NOT EXISTS`) |
| `server/sierra.js` | Parses TAL tab-separated format, extracts BP/EP markers, runs count-based dedup INSERT |
| `server/scripts/setupDb.js` | One-shot script that reads `schema.sql` and executes it against the configured DB |
| `src/App.jsx` | All React components (Calendar, Dashboard, DayModal, FillList, etc.) and `computeNetTrades` logic |
| `src/App.css` | CSS variables (`--bg-primary`, `--accent-green`, `--accent-red`, etc.), all component styles |

### Key Sections in `src/App.jsx`

- `computeNetTrades()` — second-pass CumPL diff per account to produce per-session P&L for the intraday chart
- `App()` — shared account state, lifted to top level so Calendar and Dashboard stay in sync
- Day modal — fill grouping by BP/EP boundaries, per-group tags, intraday P&L chart

### Key Sections in `server/index.js`

- `/api/daily-logs` routes — include the CumPL diff CTE for accurate daily P&L
- `/api/stats/*` routes — all support `dateFrom`, `dateTo`, `account` query params
- `/api/trigger-export` — spawns PowerShell to drive Sierra Chart UI automation
- Socket.IO setup — broadcasts `tradesUpdated` after each successful import

---

## Useful Database Queries

```sql
-- View all trades for a date
SELECT * FROM trades WHERE log_date = '2026-03-04' ORDER BY entry_time;

-- Check daily performance view
SELECT * FROM daily_performance ORDER BY log_date DESC LIMIT 30;

-- Total P&L this month
SELECT SUM(pnl) FROM trades WHERE entry_time >= DATE_TRUNC('month', CURRENT_DATE);

-- Best performing setup
SELECT setup_type, COUNT(*), SUM(pnl) as total_pnl
FROM trades WHERE exit_time IS NOT NULL
GROUP BY setup_type ORDER BY total_pnl DESC;

-- Export to CSV
COPY (SELECT * FROM trades ORDER BY entry_time DESC)
TO '/tmp/trades_export.csv' WITH CSV HEADER;

-- Database size
SELECT pg_size_pretty(pg_database_size('trading_journal'));

-- Add a new setup type
INSERT INTO setup_types (name, description) VALUES ('Your New Setup', 'Description here');
```

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
