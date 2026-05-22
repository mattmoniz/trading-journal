# ⚡ QUICK REFERENCE CARD
## Trading Journal - Essential Commands

---

## 🚀 INITIAL SETUP (One Time Only)

```bash
# 1. Install PostgreSQL (macOS)
brew install postgresql@14
brew services start postgresql@14

# 2. Create Database
psql postgres
CREATE DATABASE trading_journal;
CREATE USER trader WITH PASSWORD 'trader123';
GRANT ALL PRIVILEGES ON DATABASE trading_journal TO trader;
\q

# 3. Setup App
cd trading-journal
cp .env.example .env
npm install
npm run db:setup
```

---

## 🎮 DAILY COMMANDS

```bash
# Start the app (both frontend + backend)
npm run dev

# Stop the app
Ctrl+C

# Start backend only
npm run server

# Start frontend only  
npm run client
```

**Access Points:**
- Frontend: http://localhost:3000
- Backend API: http://localhost:3001/api

---

## 🗄️ DATABASE COMMANDS

```bash
# Connect to database
psql -U trader -d trading_journal

# Inside psql:
\dt                              # List all tables
\d trades                        # Describe trades table
SELECT * FROM trades LIMIT 5;    # View recent trades
SELECT * FROM daily_performance; # View daily stats
\q                               # Quit

# Backup database
pg_dump trading_journal > backup.sql

# Restore database
psql trading_journal < backup.sql

# Reset database (WARNING: Deletes all data)
psql -U trader -d trading_journal -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
npm run db:setup
```

---

## 📊 USEFUL SQL QUERIES

```sql
-- View all trades today
SELECT * FROM trades 
WHERE log_date = CURRENT_DATE 
ORDER BY entry_time DESC;

-- Total P&L this month
SELECT SUM(pnl) as monthly_pnl 
FROM trades 
WHERE entry_time >= DATE_TRUNC('month', CURRENT_DATE);

-- Best performing setup
SELECT setup_type, COUNT(*), SUM(pnl) as total_pnl
FROM trades 
WHERE exit_time IS NOT NULL
GROUP BY setup_type 
ORDER BY total_pnl DESC;

-- Win rate by day
SELECT * FROM daily_performance 
ORDER BY log_date DESC 
LIMIT 30;

-- Export to CSV
COPY (SELECT * FROM trades ORDER BY entry_time DESC) 
TO '/tmp/trades_export.csv' WITH CSV HEADER;
```

---

## 🔧 TROUBLESHOOTING COMMANDS

```bash
# Check if PostgreSQL is running
pg_isready

# Start PostgreSQL (if stopped)
brew services start postgresql@14    # macOS
sudo systemctl start postgresql      # Linux

# Kill port 3000 (if already in use)
lsof -ti:3000 | xargs kill -9

# Kill port 3001
lsof -ti:3001 | xargs kill -9

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Check Node version
node --version    # Need v18+

# Check PostgreSQL version
psql --version    # Need v14+

# View backend logs
npm run server    # Run backend separately to see logs

# Test database connection
psql -U trader -d trading_journal -c "SELECT 1;"
```

---

## 📁 FILE LOCATIONS

```
trading-journal/
├── src/App.jsx              # Main React code (edit for UI changes)
├── src/App.css              # Styling (colors, layout)
├── server/index.js          # API endpoints (backend logic)
├── server/schema.sql        # Database structure
├── .env                     # Database credentials
└── package.json             # Dependencies & scripts
```

---

## 🎨 CUSTOMIZATION

### Change Colors (src/App.css)
```css
:root {
  --accent-purple: #8b5cf6;  /* Change to your color */
  --accent-green: #10b981;   /* Success color */
  --accent-red: #ef4444;     /* Loss color */
}
```

### Add New Setup Type (psql)
```sql
INSERT INTO setup_types (name, description) 
VALUES ('Your New Setup', 'Description here');
```

### Change Port (vite.config.js)
```javascript
server: {
  port: 3002,  // Change from 3000
}
```

---

## 🔐 SECURITY REMINDERS

**Before deploying to production:**

1. Change database password in `.env`
2. Don't commit `.env` to git (already in .gitignore)
3. Use strong passwords
4. Enable HTTPS
5. Add authentication if sharing with others

---

## 📦 NPM SCRIPTS REFERENCE

```bash
npm run dev        # Start both frontend & backend
npm run server     # Start backend only (port 3001)
npm run client     # Start frontend only (port 3000)
npm run build      # Build for production
npm run db:setup   # Initialize database schema
```

---

## 🆘 COMMON ERRORS & FIXES

| Error | Fix |
|-------|-----|
| "Cannot connect to PostgreSQL" | `brew services start postgresql@14` |
| "Port 3000 already in use" | `lsof -ti:3000 \| xargs kill -9` |
| "Module not found" | `npm install` |
| "Password authentication failed" | Check `.env` credentials |
| "Table does not exist" | `npm run db:setup` |

---

## 📞 QUICK HELP

**Check Status:**
```bash
pg_isready        # PostgreSQL running?
node --version    # Node.js installed?
npm --version     # npm working?
```

**View All:**
```bash
cat .env                    # See database config
cat package.json            # See dependencies
ls -la server/uploads/      # See screenshots
```

**Full Reset:**
```bash
# Delete everything and start fresh
rm -rf node_modules package-lock.json
dropdb trading_journal
createdb trading_journal
npm install
npm run db:setup
npm run dev
```

---

## 🎯 KEYBOARD SHORTCUTS (in app)

- **Cmd/Ctrl + S** - Save in VS Code
- **Cmd/Ctrl + `** - Toggle terminal in VS Code
- **Cmd/Ctrl + C** - Stop server

---

## 📚 DOCUMENTATION FILES

1. **README.md** - Complete documentation
2. **QUICKSTART.md** - 5-minute setup
3. **COMPLETE_SETUP_GUIDE.md** - Detailed walkthrough
4. **ARCHITECTURE.md** - System design
5. **THIS FILE** - Quick reference

---

**Print this page and keep it handy!** 📄

**Questions?** Check README.md or COMPLETE_SETUP_GUIDE.md
