# COMPLETE SETUP CHECKLIST
## Trading Journal with PostgreSQL

---

## 📁 ALL FILES YOU NEED (Copy to your machine)

### Root Directory Files
```
trading-journal/
├── package.json                    ✓ Dependencies & scripts
├── vite.config.js                  ✓ Vite configuration
├── index.html                      ✓ HTML entry point
├── .env.example                    ✓ Environment template
├── .gitignore                      ✓ Git ignore rules
├── README.md                       ✓ Full documentation
├── QUICKSTART.md                   ✓ Quick setup guide
├── ARCHITECTURE.md                 ✓ System design docs
└── start.sh                        ✓ Startup script
```

### Server Files (Backend)
```
server/
├── index.js                        ✓ Express server
├── db.js                           ✓ PostgreSQL connection
├── schema.sql                      ✓ Database schema
├── scripts/
│   └── setupDb.js                  ✓ DB initialization script
└── uploads/                        ✓ Directory for screenshots
    └── .gitkeep                    ✓ Keep directory in git
```

### React Files (Frontend)
```
src/
├── main.jsx                        ✓ React entry point
├── App.jsx                         ✓ Main React component (2000+ lines)
├── App.css                         ✓ Main styling
└── index.css                       ✓ Base styles
```

**Total Files: 17**

---

## 🔧 PREREQUISITE INSTALLATIONS

### 1. Node.js (Required)
**Check if installed:**
```bash
node --version
# Should show v18.x.x or higher
```

**If not installed:**
- **macOS:** `brew install node`
- **Windows:** Download from https://nodejs.org
- **Linux:** `sudo apt install nodejs npm`

### 2. PostgreSQL (Required)
**Check if installed:**
```bash
psql --version
# Should show PostgreSQL 14.x or higher
```

**If not installed:**

**macOS:**
```bash
brew install postgresql@14
brew services start postgresql@14
```

**Windows (WSL2/Ubuntu):**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo service postgresql start
```

**Windows (Native):**
Download from: https://www.postgresql.org/download/windows/

### 3. Git (Optional, for version control)
```bash
git --version
```

---

## 📋 STEP-BY-STEP SETUP

### STEP 1: Copy Files to Your Machine
```bash
# Download the trading-journal folder to your computer
# Extract to a location like:
# ~/Documents/trading-journal   (macOS/Linux)
# C:\Users\YourName\trading-journal   (Windows)
```

### STEP 2: Open in VS Code
```bash
cd ~/Documents/trading-journal
code .
```

**In VS Code, you should see this structure:**
```
EXPLORER
├── server/
│   ├── index.js
│   ├── db.js
│   ├── schema.sql
│   ├── scripts/
│   │   └── setupDb.js
│   └── uploads/
├── src/
│   ├── App.css
│   ├── App.jsx
│   ├── index.css
│   └── main.jsx
├── .env.example
├── .gitignore
├── index.html
├── package.json
├── README.md
└── vite.config.js
```

### STEP 3: Install PostgreSQL (if needed)
**macOS:**
```bash
# Terminal 1 in VS Code (Cmd+`)
brew install postgresql@14
brew services start postgresql@14

# Verify it's running
pg_isready
# Should output: accepting connections
```

**Linux/WSL:**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql

# Verify
pg_isready
```

### STEP 4: Create Database
```bash
# Open PostgreSQL interactive terminal
psql postgres

# You should see: postgres=#
```

**Run these commands in psql:**
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

### STEP 5: Configure Environment
**In VS Code terminal:**
```bash
# Copy the environment template
cp .env.example .env

# Open .env file in VS Code
code .env
```

**Edit .env to match your database:**
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=trading_journal
DB_USER=trader
DB_PASSWORD=trader123

PORT=3001
NODE_ENV=development
```

**Save the file (Cmd+S / Ctrl+S)**

### STEP 6: Install Dependencies
```bash
# In VS Code terminal
npm install
```

**This installs (~30 seconds):**
- express (backend)
- pg (PostgreSQL client)
- react & react-dom (frontend)
- vite (build tool)
- cors, multer, dotenv
- and more...

**Expected output:**
```
added 245 packages in 28s
```

### STEP 7: Initialize Database Schema
```bash
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

### STEP 8: Start the Application
```bash
npm run dev
```

**Expected output:**
```
VITE v5.0.8  ready in 523 ms

➜  Local:   http://localhost:3000/
➜  Network: use --host to expose

🚀 Server running on http://localhost:3001
📊 API available at http://localhost:3001/api
✅ Connected to PostgreSQL database
```

### STEP 9: Open in Browser
Navigate to: **http://localhost:3000**

You should see the Trading Journal app! 🎉

---

## ✅ VERIFICATION CHECKLIST

**After setup, verify everything works:**

1. ☐ VS Code shows all files (17 total)
2. ☐ `node --version` shows v18+
3. ☐ `psql --version` shows PostgreSQL 14+
4. ☐ Database created successfully
5. ☐ `.env` file configured
6. ☐ `npm install` completed without errors
7. ☐ `npm run db:setup` created tables
8. ☐ `npm run dev` starts both servers
9. ☐ http://localhost:3000 loads in browser
10. ☐ Can add a test trade

---

## 🎯 KEY FILES TO UNDERSTAND

### Files You'll Edit Most:
1. **src/App.jsx** - Main React component, all UI logic
2. **src/App.css** - Styling, colors, layout
3. **server/index.js** - API endpoints, backend logic
4. **server/schema.sql** - Database structure

### Files You'll Rarely Touch:
- package.json (only when adding new libraries)
- vite.config.js (only for build configuration)
- server/db.js (database connection, usually fine as-is)

---

## 🚨 TROUBLESHOOTING

### Problem: "PostgreSQL not running"
```bash
# macOS
brew services start postgresql@14

# Linux/WSL
sudo systemctl start postgresql

# Verify
pg_isready
```

### Problem: "Database connection failed"
**Check credentials in .env:**
```bash
cat .env
```
**Try connecting manually:**
```bash
psql -U trader -d trading_journal
# Enter password: trader123
```

### Problem: "Port 3000 already in use"
```bash
# Find and kill the process
lsof -ti:3000 | xargs kill -9

# Or change port in vite.config.js:
# server: { port: 3002 }
```

### Problem: "Cannot find module 'express'"
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Problem: "Permission denied" on start.sh
```bash
chmod +x start.sh
```

---

## 📦 VS CODE RECOMMENDED EXTENSIONS

**Install these for better experience:**

1. **ES7+ React/Redux/React-Native snippets**
   - Identifier: `dsznajder.es7-react-js-snippets`

2. **ESLint**
   - Identifier: `dbaeumer.vscode-eslint`

3. **Prettier - Code formatter**
   - Identifier: `esbenp.prettier-vscode`

4. **PostgreSQL**
   - Identifier: `ckolkman.vscode-postgres`
   - Connect to your database from VS Code

**Install all at once:**
```bash
code --install-extension dsznajder.es7-react-js-snippets
code --install-extension dbaeumer.vscode-eslint
code --install-extension esbenp.prettier-vscode
code --install-extension ckolkman.vscode-postgres
```

---

## 🎮 DEVELOPMENT WORKFLOW

### Starting the App Daily:
```bash
cd trading-journal
npm run dev
```

### Stopping the App:
Press `Ctrl+C` in the terminal

### Viewing Database:
```bash
psql -U trader -d trading_journal

# Useful commands:
\dt              # List all tables
\d trades        # Describe trades table
SELECT * FROM trades LIMIT 5;
\q               # Quit
```

### Making Changes:
1. Edit files in VS Code
2. Save (Cmd+S / Ctrl+S)
3. Browser auto-refreshes (Vite hot reload)
4. Check terminal for errors

---

## 📊 NEXT STEPS AFTER SETUP

1. **Add your first trade** in Today's Log
2. **Upload a chart screenshot**
3. **Check the Calendar** view
4. **View Dashboard** analytics
5. **Customize** in Settings

---

## 🆘 STILL STUCK?

**Common Commands to Try:**

```bash
# Check everything is installed
node --version
npm --version
psql --version
pg_isready

# View logs
npm run server      # Backend only
npm run client      # Frontend only

# Database debug
psql -U trader -d trading_journal -c "\dt"

# Reset everything
rm -rf node_modules package-lock.json
npm install
npm run db:setup
```

**If all else fails:**
1. Check the README.md for detailed docs
2. Look at ARCHITECTURE.md to understand the system
3. Review server/schema.sql to understand the database

---

## ✨ YOU'RE ALL SET!

Once `npm run dev` is running and you see the app at localhost:3000, you're good to go!

Start tracking your trades like a pro! 📊🚀
