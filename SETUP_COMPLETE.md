# 🚀 COMPLETE SETUP GUIDE - Trading Journal

## 📂 ALL FILES IN YOUR PROJECT

Your `trading-journal` folder contains these files:

```
trading-journal/
│
├── 📄 package.json                    # Dependencies and scripts
├── 📄 .env.example                    # Environment template
├── 📄 .gitignore                      # Git ignore rules
├── 📄 vite.config.js                  # Vite configuration
├── 📄 index.html                      # HTML entry point
├── 📄 README.md                       # Full documentation
├── 📄 QUICKSTART.md                   # Quick start guide
├── 📄 ARCHITECTURE.md                 # System architecture
├── 🔧 start.sh                        # Startup script
│
├── 📁 server/
│   ├── 📄 index.js                    # Express server (MAIN BACKEND)
│   ├── 📄 db.js                       # Database connection
│   ├── 📄 schema.sql                  # Database schema
│   ├── 📁 scripts/
│   │   └── 📄 setupDb.js              # DB initialization script
│   └── 📁 uploads/                    # Screenshot storage (auto-created)
│       └── .gitkeep
│
└── 📁 src/
    ├── 📄 main.jsx                    # React entry point
    ├── 📄 App.jsx                     # Main React app (MAIN FRONTEND)
    ├── 📄 App.css                     # Main styling
    └── 📄 index.css                   # Base CSS
```

**Total: 17 files + 2 directories**

---

## ✅ STEP-BY-STEP SETUP (15 minutes)

### STEP 1: Install PostgreSQL (5 min)

**On macOS:**
```bash
# Install PostgreSQL
brew install postgresql@14

# Start PostgreSQL service
brew services start postgresql@14

# Verify it's running
pg_isready
# Should output: accepting connections
```

**On Windows (WSL2/Ubuntu):**
```bash
# Update package list
sudo apt update

# Install PostgreSQL
sudo apt install postgresql postgresql-contrib

# Start service
sudo service postgresql start

# Verify
pg_isready
```

**On Linux:**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql  # Start on boot
pg_isready
```

---

### STEP 2: Create Database (2 min)

```bash
# Open PostgreSQL command line
psql postgres

# You should see: postgres=#
```

Now run these SQL commands one by one:

```sql
CREATE DATABASE trading_journal;
CREATE USER trader WITH PASSWORD 'trader123';
GRANT ALL PRIVILEGES ON DATABASE trading_journal TO trader;
\q
```

**Expected output:**
```
CREATE DATABASE
CREATE ROLE
GRANT
```

---

### STEP 3: Open Project in VSCode (1 min)

```bash
# Navigate to your project
cd /path/to/trading-journal

# Open in VSCode
code .
```

Or:
- Open VSCode
- File → Open Folder
- Select `trading-journal` folder

---

### STEP 4: Configure Environment (1 min)

In VSCode terminal (`` Ctrl+` ``):

```bash
# Copy environment template
cp .env.example .env
```

**Edit `.env` file** (it should already have these values):
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=trading_journal
DB_USER=trader
DB_PASSWORD=trader123

PORT=3001
NODE_ENV=development
```

**⚠️ IMPORTANT:** If you used a different password in Step 2, update `DB_PASSWORD`

---

### STEP 5: Install Dependencies (2 min)

In VSCode terminal:

```bash
# Install all npm packages
npm install
```

This installs:
- React, React DOM
- Express, CORS
- PostgreSQL client (pg)
- Vite, Multer
- And more...

**Expected output:** Progress bars and "added XXX packages"

---

### STEP 6: Initialize Database (1 min)

```bash
# Create all database tables
npm run db:setup
```

**Expected output:**
```
🔧 Setting up database schema...
✅ Database schema created successfully!
📊 Tables created:
   - daily_logs
   - trades
   - trade_screenshots
   - custom_field_definitions
   - setup_types
📈 Views created:
   - daily_performance
```

---

### STEP 7: Start the App (1 min)

```bash
# Start both frontend and backend
npm run dev
```

**Expected output:**
```
> trading-journal@1.0.0 dev
> concurrently "npm run server" "npm run client"

[0] 🚀 Server running on http://localhost:3001
[0] 📊 API available at http://localhost:3001/api
[1] 
[1]   VITE v5.0.8  ready in 523 ms
[1]
[1]   ➜  Local:   http://localhost:3000/
[1]   ➜  Network: use --host to expose
```

---

### STEP 8: Open in Browser

Navigate to: **http://localhost:3000**

You should see the Trading Journal with:
- Sidebar navigation
- Today's Log page (default view)
- Quick stats showing $0.00 (no trades yet)

---

## 🎯 VERIFY EVERYTHING IS WORKING

### Test 1: Check Backend API
Open: **http://localhost:3001/health**

Should show:
```json
{"status":"ok","timestamp":"2024-12-10T..."}
```

### Test 2: Check Database Connection
In a new terminal:
```bash
psql -U trader -d trading_journal -c "SELECT * FROM setup_types;"
```

Should show 7 setup types like "Morning Trend Follow", etc.

### Test 3: Add Your First Trade
1. In the app, click **"+ Add Trade"**
2. Fill in:
   - Entry time: (auto-filled with current time)
   - Symbol: NQ
   - Direction: LONG
   - Quantity: 1
   - Entry Price: 20000
   - Exit Price: 20050
   - P&L: 100
3. Click **"Add Trade"**
4. Trade should appear below!

---

## 📝 IMPORTANT FILES TO KNOW

### Files You'll Edit Most:

1. **`src/App.jsx`** (1250+ lines)
   - Main React component
   - All UI logic
   - Edit to customize features

2. **`src/App.css`** (600+ lines)
   - All styling
   - Edit colors, layout, spacing

3. **`server/index.js`** (400+ lines)
   - All API endpoints
   - Edit to add new endpoints

4. **`server/schema.sql`** (200+ lines)
   - Database structure
   - Edit to add new tables/columns

### Files You Won't Touch Much:

- `package.json` - Already configured
- `vite.config.js` - Already configured  
- `server/db.js` - Database connection (works as-is)
- `index.html` - Entry point (works as-is)
- `src/main.jsx` - React bootstrap (works as-is)

---

## 🔧 TROUBLESHOOTING

### Problem: "PostgreSQL not found"
```bash
# Check if installed
which psql

# If not installed, go back to Step 1
```

### Problem: "Database connection refused"
```bash
# Check if PostgreSQL is running
pg_isready

# If not running:
# macOS:
brew services start postgresql@14

# Linux:
sudo systemctl start postgresql
```

### Problem: "FATAL: database 'trading_journal' does not exist"
```bash
# You skipped Step 2, run:
psql postgres -c "CREATE DATABASE trading_journal;"
```

### Problem: "password authentication failed for user 'trader'"
```bash
# Your .env password doesn't match
# Edit .env and set correct password
nano .env
```

### Problem: "Port 3000 is already in use"
```bash
# Kill the process on port 3000
lsof -ti:3000 | xargs kill -9

# Or change port in vite.config.js:
# server: { port: 3002 }
```

### Problem: "Port 3001 is already in use"
```bash
# Kill the process on port 3001
lsof -ti:3001 | xargs kill -9

# Or change PORT in .env:
# PORT=3002
```

### Problem: "npm: command not found"
```bash
# Install Node.js first
# macOS:
brew install node

# Ubuntu:
sudo apt install nodejs npm
```

---

## 📊 USING THE APP

### Recording Trades

1. **Today's Log** (default view)
   - Add daily notes at top (sleep, mood, market condition)
   - Click **"+ Add Trade"** to record trades
   - Fill in all details
   - Click **"Add Trade"** to save

2. **Calendar View**
   - See all trading days
   - Green = profitable, Red = losing
   - Click any day to view that day's trades

3. **Dashboard**
   - View overall statistics
   - Last 30 days performance
   - Performance by setup type

4. **Settings**
   - Future: customize fields
   - Current: shows database info

---

## 🎬 QUICK COMMANDS REFERENCE

```bash
# Start everything
npm run dev

# Start backend only
npm run server

# Start frontend only  
npm run client

# Stop everything
Ctrl+C (in the terminal)

# Reset database
npm run db:setup

# Check database
psql -U trader -d trading_journal

# View trades
psql -U trader -d trading_journal -c "SELECT * FROM trades;"

# Backup database
pg_dump -U trader trading_journal > backup.sql

# Restore database
psql -U trader trading_journal < backup.sql
```

---

## 🚀 NEXT STEPS

After setup, you can:

1. **Start trading** - Record your first real trades
2. **Customize styling** - Edit `src/App.css` colors
3. **Add custom fields** - Use the `custom_fields` JSONB column
4. **Export data** - Export trades to CSV for Python analysis
5. **Set up backups** - Create automated database backups

---

## 📞 NEED HELP?

If you get stuck:

1. Check the troubleshooting section above
2. Check PostgreSQL logs:
   ```bash
   # macOS
   tail -f /usr/local/var/log/postgresql@14.log
   
   # Linux
   sudo tail -f /var/log/postgresql/postgresql-14-main.log
   ```
3. Check backend errors in terminal
4. Check frontend errors in browser console (F12)

---

## ✅ CHECKLIST

Before you start trading, verify:

- [ ] PostgreSQL is installed and running (`pg_isready`)
- [ ] Database `trading_journal` exists
- [ ] User `trader` has access
- [ ] `.env` file is configured
- [ ] `npm install` completed successfully
- [ ] `npm run db:setup` created tables
- [ ] `npm run dev` starts without errors
- [ ] http://localhost:3000 loads the app
- [ ] http://localhost:3001/health returns OK
- [ ] You can add a test trade

---

**You're all set! Happy trading! 📊📈**
