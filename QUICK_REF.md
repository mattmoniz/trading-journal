# ⚡ QUICK REFERENCE - Trading Journal

## 🚀 ONE-TIME SETUP (Run Once)

```bash
# 1. Install PostgreSQL
brew install postgresql@14
brew services start postgresql@14

# 2. Create Database
psql postgres
CREATE DATABASE trading_journal;
CREATE USER trader WITH PASSWORD 'trader123';
GRANT ALL PRIVILEGES ON DATABASE trading_journal TO trader;
\q

# 3. Setup Project
cd trading-journal
cp .env.example .env
npm install
npm run db:setup
```

## 🏃 DAILY USAGE (Every Time)

```bash
# Start app
npm run dev

# Open browser
# → http://localhost:3000
```

## 📁 KEY FILES

```
src/App.jsx          # Frontend code (React)
src/App.css          # Styling
server/index.js      # Backend code (API)
server/schema.sql    # Database structure
.env                 # Database password
```

## 🔧 USEFUL COMMANDS

```bash
# Stop app
Ctrl+C

# Reset database
npm run db:setup

# Check database
psql -U trader -d trading_journal

# View trades
psql -U trader -d trading_journal -c "SELECT * FROM trades;"

# Backup
pg_dump -U trader trading_journal > backup.sql
```

## 🆘 TROUBLESHOOTING

```bash
# PostgreSQL not running?
brew services start postgresql@14
pg_isready

# Port in use?
lsof -ti:3000 | xargs kill -9

# Database error?
# Check .env password matches database

# Fresh start?
rm -rf node_modules
npm install
npm run db:setup
```

## 🎯 APP STRUCTURE

```
Sidebar              → Navigate between pages
Today's Log          → Record daily trades
Calendar             → View all trading days  
Dashboard            → Analytics & stats
Settings             → Configuration
```

## 📊 ADDING A TRADE

1. Click "+ Add Trade"
2. Fill in:
   - Entry/Exit times
   - Symbol (NQ, ES, etc.)
   - Direction (LONG/SHORT)
   - Prices & P&L
   - Setup type
3. Click "Add Trade"

## 🔐 DEFAULT CREDENTIALS

**Database:**
- Host: localhost
- Port: 5432
- Database: trading_journal
- User: trader
- Password: trader123

**App URLs:**
- Frontend: http://localhost:3000
- Backend: http://localhost:3001

---

**For detailed help, see:**
- `SETUP_COMPLETE.md` - Step-by-step setup
- `FILE_GUIDE.md` - File explanations
- `README.md` - Full documentation
