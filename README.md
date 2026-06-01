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

| Command | When to use |
|---------|-------------|
| `./start.sh` | First time opening the journal each day |
| `./stop.sh` | Done for the day, or ports are stuck |
| `./restart.sh` | After pulling code updates or making backend changes |

> **WSL2 note:** `lsof` doesn't work reliably on WSL2 for port cleanup. These scripts use `fuser` instead, which does.

---

## Environment Setup

Copy `.env.example` to `.env` and configure:

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

---

## First-Time Database Setup

**1. Install PostgreSQL**

```bash
# Ubuntu/WSL:
sudo apt update && sudo apt install postgresql postgresql-contrib
sudo service postgresql start

# macOS:
brew install postgresql@14
brew services start postgresql@14
```

**2. Create the database**

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE trading_journal;
CREATE USER trader WITH PASSWORD 'trader123';
GRANT ALL PRIVILEGES ON DATABASE trading_journal TO trader;
\q
```

**3. Install dependencies**

```bash
npm install
```

**4. Initialize schema**

```bash
npm run db:setup
```

This creates all tables and views:
- Tables: `daily_logs`, `trades`, `trade_screenshots`, `setup_types`, `custom_field_definitions`
- Views: `daily_performance`

**5. Verify**

```bash
pg_isready                              # PostgreSQL running?
psql -U trader -d trading_journal -c "\dt"   # tables exist?
curl http://localhost:3001/health       # backend up?
```

---

## Sierra Chart Integration Setup

### File Format (TAL — Trade Activity Log)

- **BP marker**: `Entry DateTime` ends with ` BP` → position opened from flat
- **EP marker**: `Exit DateTime` ends with ` EP` → position returned to flat (session end)
- `Cumulative Profit/Loss (C)`: running account total across all sessions
- `FlatToFlat Profit/Loss (C)`: per-session P&L (the value at each EP boundary)

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

### Sync Trades Button

The **Sync Trades** button in the Dashboard header triggers a live export from Sierra Chart without leaving the journal.

1. Calls `POST /api/trigger-export` on the backend
2. Backend runs `C:\SierraChart\export_tal.ps1` via PowerShell
3. The script uses Windows UI Automation to open Sierra Chart and trigger File → Export
4. Sierra Chart saves the file to `C:\SierraChart\SavedTradeActivity\TradeActivityLogExport_YYYY-MM-DD.txt`
5. The file watcher detects the new file and auto-imports it

Requirements: Sierra Chart must be running; `C:\SierraChart\export_tal.ps1` must be present.

---

## Troubleshooting

**Port already in use**
```bash
./stop.sh   # force-kills all related processes and ports
```

**PostgreSQL not running**
```bash
sudo service postgresql start
pg_isready
```

**Password authentication failed**
Check `.env` — `DB_PASSWORD` must match the password you set for the `trader` user.

**Table does not exist**
```bash
npm run db:setup
```

**"Cannot find module" / missing dependencies**
```bash
rm -rf node_modules package-lock.json
npm install
```

**Reset database (deletes all data)**
```bash
psql -U trader -d trading_journal -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
npm run db:setup
```

**Database backup and restore**
```bash
pg_dump trading_journal > backup_$(date +%Y%m%d).sql
psql trading_journal < backup_20260304.sql
```

**Check PostgreSQL logs**
```bash
# Linux/WSL
sudo tail -f /var/log/postgresql/postgresql-14-main.log
```

---

## Scripts Reference

```bash
./start.sh          # Start app (kills stale processes first)
./stop.sh           # Force-kills everything, frees ports
./restart.sh        # stop + start in one step (use after code changes)

npm start           # Start frontend + backend (concurrently)
npm run dev         # Start frontend + backend (concurrently)
npm run server      # Backend only (nodemon, port 3001)
npm run client      # Frontend only (vite, port 5173)
npm run build       # Production build
npm run db:setup    # Initialize database schema
npm run db:seed     # Seed sample data
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

| Account | Type |
|---------|------|
| `LTF050-MHF7U342-PRO007` | Live (prop firm) |
| `LTE050-F326QIQ6-TEST092` | Sim |

Select PRO007 when comparing P&L against prop firm statements.
