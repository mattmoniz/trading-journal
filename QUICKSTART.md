# QUICK START GUIDE

## 🚀 Get Running in 5 Minutes

### Step 1: Install PostgreSQL

**macOS:**
```bash
brew install postgresql@14
brew services start postgresql@14
```

**Ubuntu/WSL:**
```bash
sudo apt update && sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
```

### Step 2: Create Database

```bash
# Login to PostgreSQL
psql postgres

# Run these commands:
CREATE DATABASE trading_journal;
CREATE USER trader WITH PASSWORD 'trader123';
GRANT ALL PRIVILEGES ON DATABASE trading_journal TO trader;
\q
```

### Step 3: Configure App

```bash
cd trading-journal

# Copy environment file
cp .env.example .env

# Edit .env - change password to match above
# nano .env
```

### Step 4: Install & Setup

```bash
# Install dependencies (takes 1-2 minutes)
npm install

# Create database tables
npm run db:setup
```

### Step 5: Run!

```bash
# Start both frontend and backend
npm run dev
```

Open http://localhost:3000 and start trading! 📊

---

## Default Database Credentials (CHANGE IN PRODUCTION!)

- **Database:** trading_journal
- **User:** trader  
- **Password:** trader123
- **Host:** localhost
- **Port:** 5432

---

## Common Issues

**"PostgreSQL not found"**
→ Install PostgreSQL first (see Step 1)

**"Database connection error"**
→ Check PostgreSQL is running: `pg_isready`

**"Port 3000 already in use"**
→ Kill the process: `lsof -ti:3000 | xargs kill -9`

**Missing dependencies**
→ Run: `npm install`

---

For detailed setup, see README.md
