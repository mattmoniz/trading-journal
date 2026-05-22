# Trading Journal

A personal trading journal with Sierra Chart integration. Automatically imports trades from Sierra Chart TAL (Trade Activity Log) exports and provides a calendar-based review interface with analytics.

## Stack

- **Frontend**: React 18 + Vite, Recharts
- **Backend**: Express.js + Socket.IO
- **Database**: PostgreSQL (JSONB for flexible Sierra Chart data)
- **Integration**: chokidar file watcher monitors Sierra Chart export folder

---

## Quick Start

```bash
./start.sh    # kills stale processes, checks PostgreSQL, starts everything
./stop.sh     # kills all processes and frees ports 3001 / 5173 / 3000
./restart.sh  # stop + start in one command (use this after code changes)
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001/api

### When to use each

| Command | When to use |
|---------|-------------|
| `./start.sh` | First time opening the journal each day |
| `./stop.sh` | Done for the day, or ports are stuck |
| `./restart.sh` | After pulling code updates or making backend changes |

> **WSL2 note:** `lsof` doesn't work reliably on WSL2 for port cleanup. These scripts use `fuser` instead, which does.

---

## Initial Setup (First Time Only)

**1. Install dependencies**
```bash
npm install
```

**2. Create the database**
```bash
sudo -u postgres psql
CREATE DATABASE trading_journal;
CREATE USER trader WITH PASSWORD 'trader123';
GRANT ALL PRIVILEGES ON DATABASE trading_journal TO trader;
\q
```

**3. Configure environment**

Copy `.env.example` to `.env`:
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=trading_journal
DB_USER=trader
DB_PASSWORD=trader123

PORT=3001
NODE_ENV=development

# Sierra Chart file watcher
SIERRA_WATCH_PATH=/mnt/c/SierraChart/SavedTradeActivity
SIERRA_FILE_PATTERN=TradeActivityLog*.txt
SIERRA_POLL_INTERVAL=1000
SIERRA_STABILITY_THRESHOLD=2000
```

**4. Initialize schema**
```bash
npm run db:setup
```

---

## Views

| View | Description |
|------|-------------|
| **Calendar** | Monthly grid with daily P&L heat map. Click a day to open the detail modal. |
| **Dashboard** | Equity curve, daily P&L, win rate, profit factor, hourly/weekday breakdowns, top symbols, setup performance. |
| **All Trades** | Sortable table of all closed trades. |
| **Settings** | Manage setup types and custom field definitions. |

### Day Modal

Clicking a calendar day opens a modal with:

- **Daily log**: Sleep Quality, Mood, Market Condition dropdowns + Pre-Market, Post-Market, Lessons Learned text areas (all auto-save on change/blur)
- **Intraday P&L chart**: one dot per flat-to-flat session, hover for details + tags
- **Fill list**: grouped by flat-to-flat session (BP → EP boundaries), tags per group

### Account Filter

Both Calendar and Dashboard share a single account filter (top-right dropdown). It defaults to the most recently active live account. Switch to "All Accounts" to include sim trades.

---

## Sierra Chart Integration

### File Format (TAL — Trade Activity Log)

- **BP marker**: `Entry DateTime` ends with ` BP` → position opened from flat
- **EP marker**: `Exit DateTime` ends with ` EP` → position returned to flat (session end)
- `Cumulative Profit/Loss (C)`: running account total across all sessions
- `FlatToFlat Profit/Loss (C)`: cumulative running total of session P&Ls (not per-session)

### P&L Calculation

Uses **CumPL diffs**, not raw fill sums:
```
Daily P&L = (last EP CumPL for day) − (last EP CumPL from previous day)  [per account]
```
This matches prop firm reported figures exactly.

### Dedup Logic

Count-based deduplication: if `(entry_time, exit_time, symbol, direction, quantity, entry_price, exit_price, account)` appears N times in the file and M already exist in the DB, only `N − M` new rows are inserted. This correctly handles scaling into positions at the same price.

### Auto-Import

The server watches `SIERRA_WATCH_PATH` for changes. New or modified files matching `SIERRA_FILE_PATTERN` are parsed and imported after `SIERRA_STABILITY_THRESHOLD` ms of no further changes.

### Manual Import

```bash
curl -X POST http://localhost:3001/api/sierra/import \
  -H "Content-Type: application/json" \
  -d '{"filePath": "/mnt/c/SierraChart/SavedTradeActivity/TradeActivityLog_20260304.txt"}'
```

---

## Accounts

Stored in `custom_fields->>'account'` on each trade row.

| Account | Type |
|---------|------|
| `LTF050-MHF7U342-PRO007` | Live (prop firm) |
| `LTE050-F326QIQ6-TEST092` | Sim |

Select PRO007 when comparing P&L against prop firm statements.

---

## Database Schema

### Tables

| Table | Description |
|-------|-------------|
| `daily_logs` | One row per trading day — sleep, mood, market condition, pre/post notes, lessons |
| `trades` | Individual fills — entry/exit times, symbol, direction, qty, prices, P&L, fees, setup type, tags (JSONB), custom_fields (JSONB) |
| `trade_screenshots` | Images attached to trades, stored in `server/uploads/` |
| `setup_types` | Configurable setup names |
| `custom_field_definitions` | Configurable extra fields per trade |

### View

| View | Description |
|------|-------------|
| `daily_performance` | Aggregated per-day stats (trade count, win rate, P&L, best/worst) |

---

## API Reference

All stats endpoints support `?dateFrom=YYYY-MM-DD`, `?dateTo=YYYY-MM-DD`, `?account=...` filters.

### Daily Logs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/daily-logs` | All logs with daily P&L |
| GET | `/api/daily-logs/:date` | Single day (auto-creates if missing) |
| PUT | `/api/daily-logs/:date` | Update log fields |

### Trades
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/trades/:date` | Trades for a date |
| GET | `/api/trades` | All trades |
| POST | `/api/trades` | Create trade |
| PUT | `/api/trades/:id` | Update trade (including tags) |
| DELETE | `/api/trades/:id` | Delete trade |

### Screenshots
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/trades/:tradeId/screenshots` | Upload image (10 MB max) |
| DELETE | `/api/screenshots/:id` | Delete screenshot |

### Analytics
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
| `/api/accounts` | Unique account list |
| `/api/sierra/status` | File watcher status |
| `/api/sierra/import` | Manual import from file path |
| `/api/sierra/history` | Import history (last 50) |
| `/api/setup-types` | Setup type list |
| `/api/custom-fields` | Custom field definitions |
| `/api/trigger-export` | Triggers Sierra Chart TAL export via PowerShell (see below) |
| `/health` | Health check |

### Sync Trades Button

The **⬇ Sync Trades** button in the Dashboard header triggers a live export from Sierra Chart without leaving the journal.

**How it works:**
1. Calls `POST /api/trigger-export` on the backend
2. Backend runs `C:\SierraChart\export_tal.ps1` via PowerShell
3. The script uses Windows UI Automation to: open Sierra Chart → Trade → Trade Activity Log → File → Export
4. Sierra Chart saves the file to `C:\SierraChart\SavedTradeActivity\TradeActivityLogExport_YYYY-MM-DD.txt`
5. The file watcher detects the new file and auto-imports it
6. A toast notification confirms success

**Requirements:**
- Sierra Chart must be running and not blocked by an open dialog
- The PowerShell script lives at `C:\SierraChart\export_tal.ps1` (already placed there)
- No AutoHotkey needed — uses built-in Windows PowerShell UI Automation

---

## Development Scripts

```bash
./start.sh          # Start app (kills stale processes first)
./stop.sh           # Force-kills everything, frees ports
./restart.sh        # stop + start in one step (use after code changes)

npm start           # Start frontend + backend (concurrently)
npm run server      # Backend only (nodemon)
npm run client      # Frontend only (vite)
npm run build       # Production build
npm run db:setup    # Initialize database schema
npm run db:seed     # Seed sample data
```

---

## Troubleshooting

**Port already in use**
```bash
./stop.sh   # force-kills all related processes and ports
```

**PostgreSQL not running**
```bash
sudo service postgresql start
pg_isready   # verify
```

**Database backup**
```bash
pg_dump trading_journal > backup_$(date +%Y%m%d).sql
psql trading_journal < backup_20260304.sql  # restore
```
