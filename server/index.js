import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { query } from './db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import http from 'http';
import { Server } from 'socket.io';
import SierraWatcher from './watchers/sierraWatcher.js';
import { manualImportFromFile, getImportHistory } from './services/tradeImportService.js';
import { runACDBacktest, runACDBacktestFromDB, runParameterSearch } from './services/acdBacktest.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple in-memory cache for expensive endpoints (key-levels)
const _cache = new Map();
function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { _cache.delete(key); return null; }
  return entry.val;
}
function cacheSet(key, val, ttlMs = 120_000) {
  _cache.set(key, { val, exp: Date.now() + ttlMs });
}
function cacheDelete(key) { _cache.delete(key); }

// Returns 'YYYY-MM-DD' of the most recent price bar — used to key caches so
// they auto-invalidate when new bar data is imported, regardless of TTL.
async function latestBarDate() {
  try {
    const r = await query(`SELECT MAX(ts::date)::text as d FROM price_bars WHERE symbol='NQ'`);
    return r.rows[0]?.d || 'nodata';
  } catch(e) { return 'nodata'; }
}

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Create uploads directories
const uploadsDir = path.join(__dirname, 'uploads');
const chartsDir = path.join(__dirname, 'uploads', 'charts');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(chartsDir)) fs.mkdirSync(chartsDir, { recursive: true });

// Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Multer for chart images — stored as uploads/charts/YYYY-MM-DD.ext
const chartStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, chartsDir),
  filename: (req, file, cb) => cb(null, `${req.params.date}${path.extname(file.originalname).toLowerCase()}`)
});
const chartUpload = multer({
  storage: chartStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/jpeg|jpg|png|gif|webp/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Images only'));
  }
});

// Create tables on startup
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS daily_charts (
        log_date DATE PRIMARY KEY,
        image_path TEXT NOT NULL,
        chart_type TEXT DEFAULT 'daily',
        analysis TEXT,
        analyzed_at TIMESTAMPTZ,
        api_calls INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch(e) { console.error('daily_charts table init error:', e.message); }

  try {
    await query(`
      CREATE TABLE IF NOT EXISTS risk_settings (
        id SERIAL PRIMARY KEY,
        account_size NUMERIC DEFAULT 50000,
        risk_pct_per_trade NUMERIC DEFAULT 2.0,
        instrument VARCHAR DEFAULT 'MNQ',
        lookback_days INTEGER DEFAULT 60,
        daily_loss_limit_pct NUMERIC DEFAULT 2.0,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    const existing = await query('SELECT id FROM risk_settings LIMIT 1');
    if (existing.rows.length === 0) {
      await query('INSERT INTO risk_settings (account_size, risk_pct_per_trade, instrument, lookback_days, daily_loss_limit_pct) VALUES (50000, 2.0, $1, 60, 2.0)', ['MNQ']);
    }
  } catch(e) { console.error('risk_settings table init error:', e.message); }

  try {
    await query(`
      CREATE TABLE IF NOT EXISTS acd_weekly_log (
        id SERIAL PRIMARY KEY,
        week_start DATE NOT NULL UNIQUE,
        or_day DATE,
        or_high NUMERIC, or_low NUMERIC,
        a_multiplier NUMERIC DEFAULT 0.33,
        a_up_level NUMERIC, a_down_level NUMERIC,
        a_up_fired BOOLEAN DEFAULT FALSE, a_up_day DATE,
        a_down_fired BOOLEAN DEFAULT FALSE, a_down_day DATE,
        c_up_confirmed BOOLEAN DEFAULT FALSE,
        c_down_confirmed BOOLEAN DEFAULT FALSE,
        daily_score INTEGER DEFAULT 0,
        week_close NUMERIC,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } catch(e) { console.error('acd_weekly_log init error:', e.message); }

  try {
    await query(`
      CREATE TABLE IF NOT EXISTS acd_daily_log (
        id SERIAL PRIMARY KEY,
        trade_date DATE NOT NULL UNIQUE,
        or_high NUMERIC, or_low NUMERIC,
        a_multiplier NUMERIC DEFAULT 0.33,
        a_up_level NUMERIC, a_down_level NUMERIC,
        a_up_fired BOOLEAN DEFAULT FALSE, a_up_time TIME,
        a_down_fired BOOLEAN DEFAULT FALSE, a_down_time TIME,
        c_up_confirmed BOOLEAN DEFAULT FALSE,
        c_down_confirmed BOOLEAN DEFAULT FALSE,
        daily_score INTEGER DEFAULT 0,
        session_close NUMERIC,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS acd_monthly_pivot (
        id SERIAL PRIMARY KEY,
        month_year VARCHAR(7) NOT NULL UNIQUE,
        prior_month_high NUMERIC, prior_month_low NUMERIC, prior_month_close NUMERIC,
        pivot_level NUMERIC, pivot_r1 NUMERIC, pivot_s1 NUMERIC,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS acd_backtest_results (
        id SERIAL PRIMARY KEY,
        run_date TIMESTAMP DEFAULT NOW(),
        or_minutes INTEGER, a_multiplier NUMERIC, sustain_minutes INTEGER,
        total_signals INTEGER, win_rate NUMERIC, avg_win_r NUMERIC, avg_loss_r NUMERIC,
        payoff_ratio NUMERIC, ev_per_signal NUMERIC, profit_factor NUMERIC,
        win_rate_nl_above_9 NUMERIC, win_rate_nl_below_9 NUMERIC, win_rate_nl_ranging NUMERIC,
        notes TEXT
      )
    `);
    await query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS acd_signal VARCHAR(20)`);
    await query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS acd_number_line_at_entry INTEGER`);
    await query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS acd_monthly_bias VARCHAR(20)`);
  } catch(e) { console.error('ACD tables init error:', e.message); }

  try {
    await query(`
      CREATE TABLE IF NOT EXISTS trading_sessions (
        id SERIAL PRIMARY KEY,
        session_date DATE DEFAULT CURRENT_DATE,
        opening_account_value NUMERIC,
        daily_loss_limit_pct NUMERIC DEFAULT 2.0,
        session_closed BOOLEAN DEFAULT FALSE,
        closed_reason VARCHAR,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } catch(e) { console.error('trading_sessions table init error:', e.message); }
})();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed!'));
  }
});

// ==================== DAILY LOGS ROUTES ====================

// Get or create daily log for a specific date
app.get('/api/daily-logs/:date', async (req, res) => {
  try {
    const { date } = req.params;
    
    let result = await query('SELECT * FROM daily_logs WHERE log_date = $1', [date]);
    
    // If no log exists, create one
    if (result.rows.length === 0) {
      result = await query(
        'INSERT INTO daily_logs (log_date) VALUES ($1) RETURNING *',
        [date]
      );
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching daily log:', error);
    res.status(500).json({ error: 'Failed to fetch daily log' });
  }
});

// Update daily log
app.put('/api/daily-logs/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const { 
      sleep_quality, 
      mood, 
      market_condition, 
      pre_market_notes, 
      post_market_notes, 
      lessons_learned 
    } = req.body;
    
    const result = await query(
      `UPDATE daily_logs 
       SET sleep_quality = $1, mood = $2, market_condition = $3, 
           pre_market_notes = $4, post_market_notes = $5, lessons_learned = $6
       WHERE log_date = $7
       RETURNING *`,
      [sleep_quality, mood, market_condition, pre_market_notes, post_market_notes, lessons_learned, date]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating daily log:', error);
    res.status(500).json({ error: 'Failed to update daily log' });
  }
});

// Get all daily logs with stats (for calendar)
app.get('/api/daily-logs', async (req, res) => {
  try {
    const accounts = req.query.accounts ? req.query.accounts.split(',') : null;
    const hasFilter = accounts && accounts.length > 0;
    const acctFilter = hasFilter ? `AND custom_fields->>'account' = ANY($1::text[])` : '';
    const tradeAcctFilter = hasFilter ? `AND t.custom_fields->>'account' = ANY($1::text[])` : '';

    // Use FlatToFlat sum as primary P&L — reliable even when account CumPL resets mid-stream.
    // CumPL diff breaks when a prop firm resets an account balance while keeping the same account ID.
    const result = await query(`
      WITH ftf_pnl AS (
        SELECT log_date,
          SUM(replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric) as daily_pnl
        FROM trades
        WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
          AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
          ${acctFilter}
        GROUP BY log_date
      )
      SELECT
        dl.*,
        COUNT(t.id) as trade_count,
        COALESCE(fp.daily_pnl, 0) as daily_pnl
      FROM daily_logs dl
      INNER JOIN trades t ON dl.log_date = t.log_date
        AND t.exit_time IS NOT NULL
        ${tradeAcctFilter}
      LEFT JOIN ftf_pnl fp ON fp.log_date = dl.log_date
      GROUP BY dl.id, dl.log_date, fp.daily_pnl
      HAVING COUNT(t.id) > 0
      ORDER BY dl.log_date DESC
    `, hasFilter ? [accounts] : []);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching daily logs:', error);
    res.status(500).json({ error: 'Failed to fetch daily logs' });
  }
});

// ==================== TRADES ROUTES ====================

// Get trades for a specific date
app.get('/api/trades/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const result = await query(`
      SELECT t.*, 
             array_agg(json_build_object('id', ts.id, 'filename', ts.filename, 'file_path', ts.file_path, 'caption', ts.caption)) 
             FILTER (WHERE ts.id IS NOT NULL) as screenshots
      FROM trades t
      LEFT JOIN trade_screenshots ts ON t.id = ts.trade_id
      WHERE t.log_date = $1
      GROUP BY t.id
      ORDER BY t.entry_time DESC
    `, [date]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trades:', error);
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

// Fetch all trades at once (for All Trades view)
app.get('/api/trades', async (req, res) => {
  try {
    const result = await query(`
      SELECT t.*,
             array_agg(json_build_object('id', ts.id, 'filename', ts.filename, 'file_path', ts.file_path, 'caption', ts.caption))
             FILTER (WHERE ts.id IS NOT NULL) as screenshots
      FROM trades t
      LEFT JOIN trade_screenshots ts ON t.id = ts.trade_id
      WHERE t.exit_time IS NOT NULL
      GROUP BY t.id
      ORDER BY t.entry_time DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching all trades:', error);
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

// Create new trade
app.post('/api/trades', async (req, res) => {
  try {
    const {
      log_date,
      entry_time,
      exit_time,
      symbol,
      direction,
      quantity,
      entry_price,
      exit_price,
      stop_loss,
      target,
      pnl,
      fees,
      setup_type,
      trade_notes,
      mistakes,
      emotional_state,
      risk_reward_ratio,
      tags,
      custom_fields
    } = req.body;
    
    const result = await query(`
      INSERT INTO trades (
        log_date, entry_time, exit_time, symbol, direction, quantity,
        entry_price, exit_price, stop_loss, target, pnl, fees,
        setup_type, trade_notes, mistakes, emotional_state,
        risk_reward_ratio, tags, custom_fields
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      RETURNING *
    `, [
      log_date, entry_time, exit_time, symbol, direction, quantity,
      entry_price, exit_price, stop_loss, target, pnl, fees,
      setup_type, trade_notes, mistakes, emotional_state,
      risk_reward_ratio, tags, custom_fields
    ]);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating trade:', error);
    res.status(500).json({ error: 'Failed to create trade' });
  }
});

// Update trade
app.put('/api/trades/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Build dynamic update query
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map((field, index) => `${field} = $${index + 1}`).join(', ');
    
    const result = await query(
      `UPDATE trades SET ${setClause} WHERE id = $${fields.length + 1} RETURNING *`,
      [...values, id]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating trade:', error);
    res.status(500).json({ error: 'Failed to update trade' });
  }
});

// Delete trade
app.delete('/api/trades/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await query('DELETE FROM trades WHERE id = $1', [id]);
    res.json({ message: 'Trade deleted successfully' });
  } catch (error) {
    console.error('Error deleting trade:', error);
    res.status(500).json({ error: 'Failed to delete trade' });
  }
});

// ==================== SCREENSHOTS ROUTES ====================

// Upload screenshot for a trade
app.post('/api/trades/:tradeId/screenshots', upload.single('screenshot'), async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { caption } = req.body;
    const { filename, path: filePath } = req.file;
    
    const result = await query(
      'INSERT INTO trade_screenshots (trade_id, filename, file_path, caption) VALUES ($1, $2, $3, $4) RETURNING *',
      [tradeId, filename, filePath, caption]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading screenshot:', error);
    res.status(500).json({ error: 'Failed to upload screenshot' });
  }
});

// Delete screenshot
app.delete('/api/screenshots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get file path before deleting
    const screenshot = await query('SELECT file_path FROM trade_screenshots WHERE id = $1', [id]);
    
    if (screenshot.rows.length > 0) {
      // Delete file from filesystem
      fs.unlinkSync(screenshot.rows[0].file_path);
    }
    
    await query('DELETE FROM trade_screenshots WHERE id = $1', [id]);
    res.json({ message: 'Screenshot deleted successfully' });
  } catch (error) {
    console.error('Error deleting screenshot:', error);
    res.status(500).json({ error: 'Failed to delete screenshot' });
  }
});

// ==================== DASHBOARD/ANALYTICS ROUTES ====================

// Get overall statistics
app.get('/api/stats/overview', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

    // Build WHERE clause based on filters
    let whereConditions = ['exit_time IS NOT NULL'];
    const queryParams = [];
    let paramCounter = 1;

    if (dateFrom) {
      whereConditions.push(`log_date >= $${paramCounter}`);
      queryParams.push(dateFrom);
      paramCounter++;
    }

    if (dateTo) {
      whereConditions.push(`log_date <= $${paramCounter}`);
      queryParams.push(dateTo);
      paramCounter++;
    }

    if (account) {
      whereConditions.push(`custom_fields->>'account' = ANY($${paramCounter}::text[])`);
      queryParams.push(account.split(",").filter(Boolean));
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    const result = await query(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
        ROUND(MAX(pnl)::numeric, 2) as best_trade,
        ROUND(MIN(pnl)::numeric, 2) as worst_trade,
        ROUND((SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::decimal / NULLIF(COUNT(*), 0) * 100)::numeric, 2) as win_rate,
        ROUND(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END)::numeric, 2) as gross_profit,
        ROUND(ABS(SUM(CASE WHEN pnl < 0 THEN pnl ELSE 0 END))::numeric, 2) as gross_loss,
        ROUND(AVG(CASE WHEN pnl > 0 THEN pnl END)::numeric, 2) as avg_win,
        ROUND(AVG(CASE WHEN pnl < 0 THEN pnl END)::numeric, 2) as avg_loss,
        ROUND((SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN pnl < 0 THEN pnl ELSE 0 END)), 0))::numeric, 2) as profit_factor
      FROM trades
      WHERE ${whereClause}
    `, queryParams);

    const stats = result.rows[0];

    // Calculate max drawdown and streaks (requires sequential data)
    const tradesResult = await query(`
      SELECT pnl, log_date, entry_time
      FROM trades
      WHERE ${whereClause}
      ORDER BY entry_time ASC
    `, queryParams);

    const trades = tradesResult.rows;
    let maxDrawdown = 0;
    let peak = 0;
    let cumulative = 0;
    let currentStreak = 0;
    let longestWinStreak = 0;
    let longestLossStreak = 0;
    let lastWasWin = null;

    trades.forEach(trade => {
      const pnl = parseFloat(trade.pnl);
      cumulative += pnl;

      // Track drawdown
      if (cumulative > peak) {
        peak = cumulative;
      }
      const drawdown = peak - cumulative;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }

      // Track streaks
      const isWin = pnl > 0;
      if (lastWasWin === null || lastWasWin === isWin) {
        currentStreak++;
      } else {
        currentStreak = 1;
      }

      if (isWin) {
        longestWinStreak = Math.max(longestWinStreak, currentStreak);
      } else {
        longestLossStreak = Math.max(longestLossStreak, currentStreak);
      }

      lastWasWin = isWin;
    });

    stats.max_drawdown = maxDrawdown.toFixed(2);
    stats.recovery_factor = maxDrawdown > 0 ? (parseFloat(stats.total_pnl) / maxDrawdown).toFixed(2) : null;
    stats.longest_win_streak = longestWinStreak;
    stats.longest_loss_streak = longestLossStreak;
    stats.expectancy = stats.avg_pnl; // Expectancy is same as avg_pnl

    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get top performing symbols
app.get('/api/stats/top-symbols', async (req, res) => {
  try {
    const { dateFrom, dateTo, account, limit = 5 } = req.query;

    // Build WHERE clause based on filters
    let whereConditions = ['exit_time IS NOT NULL'];
    const queryParams = [];
    let paramCounter = 1;

    if (dateFrom) {
      whereConditions.push(`log_date >= $${paramCounter}`);
      queryParams.push(dateFrom);
      paramCounter++;
    }

    if (dateTo) {
      whereConditions.push(`log_date <= $${paramCounter}`);
      queryParams.push(dateTo);
      paramCounter++;
    }

    if (account) {
      whereConditions.push(`custom_fields->>'account' = ANY($${paramCounter}::text[])`);
      queryParams.push(account.split(",").filter(Boolean));
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    const result = await query(`
      SELECT
        symbol,
        COUNT(*) as trade_count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
        ROUND((SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::decimal / COUNT(*) * 100)::numeric, 2) as win_rate
      FROM trades
      WHERE ${whereClause}
      GROUP BY symbol
      ORDER BY total_pnl DESC
      LIMIT $${paramCounter}
    `, [...queryParams, limit]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching top symbols:', error);
    res.status(500).json({ error: 'Failed to fetch top symbols' });
  }
});

// Get cumulative P&L data for equity curve (aggregated by day)
app.get('/api/stats/cumulative-pnl', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

    // Build WHERE clause based on filters
    let whereConditions = ['exit_time IS NOT NULL'];
    const queryParams = [];
    let paramCounter = 1;

    if (dateFrom) {
      whereConditions.push(`log_date >= $${paramCounter}`);
      queryParams.push(dateFrom);
      paramCounter++;
    }

    if (dateTo) {
      whereConditions.push(`log_date <= $${paramCounter}`);
      queryParams.push(dateTo);
      paramCounter++;
    }

    if (account) {
      whereConditions.push(`custom_fields->>'account' = ANY($${paramCounter}::text[])`);
      queryParams.push(account.split(",").filter(Boolean));
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    // Aggregate by day and calculate cumulative P&L
    const result = await query(`
      WITH daily_pnl AS (
        SELECT
          log_date,
          SUM(pnl) as daily_pnl
        FROM trades
        WHERE ${whereClause}
        GROUP BY log_date
        ORDER BY log_date ASC
      )
      SELECT
        log_date,
        daily_pnl,
        SUM(daily_pnl) OVER (ORDER BY log_date) as cumulative_pnl
      FROM daily_pnl
      ORDER BY log_date ASC
    `, queryParams);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching cumulative P&L:', error);
    res.status(500).json({ error: 'Failed to fetch cumulative P&L' });
  }
});

// Get performance by hour of day
app.get('/api/stats/by-hour', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

    // Build WHERE clause based on filters
    let whereConditions = ['exit_time IS NOT NULL'];
    const queryParams = [];
    let paramCounter = 1;

    if (dateFrom) {
      whereConditions.push(`log_date >= $${paramCounter}`);
      queryParams.push(dateFrom);
      paramCounter++;
    }

    if (dateTo) {
      whereConditions.push(`log_date <= $${paramCounter}`);
      queryParams.push(dateTo);
      paramCounter++;
    }

    if (account) {
      whereConditions.push(`custom_fields->>'account' = ANY($${paramCounter}::text[])`);
      queryParams.push(account.split(",").filter(Boolean));
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    const result = await query(`
      SELECT
        EXTRACT(HOUR FROM entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') as hour,
        COUNT(*) as trade_count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
        ROUND((SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::decimal / COUNT(*) * 100)::numeric, 2) as win_rate
      FROM trades
      WHERE ${whereClause}
      GROUP BY EXTRACT(HOUR FROM entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')
      ORDER BY hour ASC
    `, queryParams);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching hourly stats:', error);
    res.status(500).json({ error: 'Failed to fetch hourly statistics' });
  }
});

// Get performance by day of week
app.get('/api/stats/by-day-of-week', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

    // Build WHERE clause based on filters
    let whereConditions = ['exit_time IS NOT NULL'];
    const queryParams = [];
    let paramCounter = 1;

    if (dateFrom) {
      whereConditions.push(`log_date >= $${paramCounter}`);
      queryParams.push(dateFrom);
      paramCounter++;
    }

    if (dateTo) {
      whereConditions.push(`log_date <= $${paramCounter}`);
      queryParams.push(dateTo);
      paramCounter++;
    }

    if (account) {
      whereConditions.push(`custom_fields->>'account' = ANY($${paramCounter}::text[])`);
      queryParams.push(account.split(",").filter(Boolean));
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    const result = await query(`
      SELECT
        EXTRACT(DOW FROM entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') as day_num,
        CASE EXTRACT(DOW FROM entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')
          WHEN 0 THEN 'Sunday'
          WHEN 1 THEN 'Monday'
          WHEN 2 THEN 'Tuesday'
          WHEN 3 THEN 'Wednesday'
          WHEN 4 THEN 'Thursday'
          WHEN 5 THEN 'Friday'
          WHEN 6 THEN 'Saturday'
        END as day_name,
        COUNT(*) as trade_count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
        ROUND((SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::decimal / COUNT(*) * 100)::numeric, 2) as win_rate
      FROM trades
      WHERE ${whereClause}
      GROUP BY EXTRACT(DOW FROM entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')
      ORDER BY day_num ASC
    `, queryParams);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching day of week stats:', error);
    res.status(500).json({ error: 'Failed to fetch day of week statistics' });
  }
});

// Get performance by trade duration
app.get('/api/stats/by-duration', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

    let whereConditions = ['exit_time IS NOT NULL', 'exit_time > entry_time', 'pnl IS NOT NULL'];
    const queryParams = [];
    let paramCounter = 1;

    if (dateFrom) {
      whereConditions.push(`log_date >= $${paramCounter}`);
      queryParams.push(dateFrom);
      paramCounter++;
    }
    if (dateTo) {
      whereConditions.push(`log_date <= $${paramCounter}`);
      queryParams.push(dateTo);
      paramCounter++;
    }
    if (account) {
      whereConditions.push(`custom_fields->>'account' = ANY($${paramCounter}::text[])`);
      queryParams.push(account.split(",").filter(Boolean));
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    const result = await query(`
      WITH bucketed AS (
        SELECT
          pnl,
          CASE
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 30 THEN 1
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 60 THEN 2
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 300 THEN 3
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 900 THEN 4
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 1800 THEN 5
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 3600 THEN 6
            ELSE 7
          END as bucket_order,
          CASE
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 30 THEN '< 30s'
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 60 THEN '30s-1m'
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 300 THEN '1-5m'
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 900 THEN '5-15m'
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 1800 THEN '15-30m'
            WHEN EXTRACT(EPOCH FROM (exit_time - entry_time)) < 3600 THEN '30m-1h'
            ELSE '> 1h'
          END as duration_bucket
        FROM trades
        WHERE ${whereClause}
      )
      SELECT
        bucket_order,
        duration_bucket,
        COUNT(*) as trade_count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
        ROUND((SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::decimal / COUNT(*) * 100)::numeric, 2) as win_rate
      FROM bucketed
      GROUP BY bucket_order, duration_bucket
      ORDER BY bucket_order ASC
    `, queryParams);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching duration stats:', error);
    res.status(500).json({ error: 'Failed to fetch duration statistics' });
  }
});

// Get daily performance (from view)
app.get('/api/stats/daily', async (req, res) => {
  try {
    const { days = 30, dateFrom, dateTo, account } = req.query;

    // Build query based on filters
    let whereConditions = [];
    const queryParams = [];
    let paramCounter = 1;

    // Handle date range filters
    if (dateFrom) {
      whereConditions.push(`dl.log_date >= $${paramCounter}`);
      queryParams.push(dateFrom);
      paramCounter++;
    } else {
      whereConditions.push(`dl.log_date >= CURRENT_DATE - INTERVAL '${days} days'`);
    }

    if (dateTo) {
      whereConditions.push(`dl.log_date <= $${paramCounter}`);
      queryParams.push(dateTo);
      paramCounter++;
    }

    // Build account filter for trades
    let tradeAccountFilter = '';
    let epAccountFilter = '';
    if (account) {
      const accounts = account.split(",").filter(Boolean);
      tradeAccountFilter = `AND t.custom_fields->>'account' = ANY($${paramCounter}::text[])`;
      epAccountFilter = `AND custom_fields->>'account' = ANY($${paramCounter}::text[])`;
      queryParams.push(accounts);
      paramCounter++;
    }

    // Build CTE date conditions (same params, referencing 'log_date' not 'dl.log_date')
    const cteWhereConditions = whereConditions.map(c => c.replace(/dl\.log_date/g, 'log_date'));
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    const cteWhereClause = cteWhereConditions.length > 0 ? 'AND ' + cteWhereConditions.join(' AND ') : '';

    const result = await query(`
      WITH ep_fills AS (
        SELECT
          log_date,
          custom_fields->>'account' as account,
          exit_time,
          CASE
            WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric
            ELSE NULL
          END as cum_pl
        FROM trades
        WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
          AND exit_time IS NOT NULL
          ${epAccountFilter}
          ${cteWhereClause}
      ),
      last_ep_per_day AS (
        SELECT DISTINCT ON (log_date, account)
          log_date, account, cum_pl
        FROM ep_fills
        ORDER BY log_date, account, exit_time DESC
      ),
      daily_pnl_per_account AS (
        SELECT
          log_date,
          cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) as session_pnl
        FROM last_ep_per_day
        WHERE cum_pl IS NOT NULL
      ),
      daily_cuml AS (
        SELECT log_date, SUM(session_pnl) as cum_daily_pnl
        FROM daily_pnl_per_account
        GROUP BY log_date
      )
      SELECT
        dl.log_date,
        COUNT(t.id) as total_trades,
        COALESCE(dcp.cum_daily_pnl, SUM(t.pnl), 0) as daily_pnl,
        ROUND((SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END)::decimal / NULLIF(COUNT(t.id), 0) * 100)::numeric, 2) as win_rate
      FROM daily_logs dl
      LEFT JOIN trades t ON dl.log_date = t.log_date AND t.exit_time IS NOT NULL ${tradeAccountFilter}
      LEFT JOIN daily_cuml dcp ON dcp.log_date = dl.log_date
      ${whereClause}
      GROUP BY dl.log_date, dcp.cum_daily_pnl
      HAVING COUNT(t.id) > 0
      ORDER BY dl.log_date ASC
    `, queryParams);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching daily performance:', error);
    res.status(500).json({ error: 'Failed to fetch daily performance' });
  }
});

// Get performance by setup type
app.get('/api/stats/by-setup', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

    // Build WHERE clause based on filters
    let whereConditions = ['exit_time IS NOT NULL', 'setup_type IS NOT NULL'];
    const queryParams = [];
    let paramCounter = 1;

    if (dateFrom) {
      whereConditions.push(`log_date >= $${paramCounter}`);
      queryParams.push(dateFrom);
      paramCounter++;
    }

    if (dateTo) {
      whereConditions.push(`log_date <= $${paramCounter}`);
      queryParams.push(dateTo);
      paramCounter++;
    }

    if (account) {
      whereConditions.push(`custom_fields->>'account' = ANY($${paramCounter}::text[])`);
      queryParams.push(account.split(",").filter(Boolean));
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    const result = await query(`
      SELECT
        setup_type,
        COUNT(*) as trade_count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
        ROUND((SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::decimal / COUNT(*) * 100)::numeric, 2) as win_rate
      FROM trades
      WHERE ${whereClause}
      GROUP BY setup_type
      ORDER BY total_pnl DESC
    `, queryParams);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching setup stats:', error);
    res.status(500).json({ error: 'Failed to fetch setup statistics' });
  }
});

// Get unique accounts from trades
app.get('/api/accounts', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const all  = req.query.all === 'true';

    const result = await query(`
      SELECT
        custom_fields->>'account' as account,
        MAX(log_date) as last_trade_date,
        COUNT(*) as trade_count
      FROM trades
      WHERE custom_fields->>'account' IS NOT NULL
      GROUP BY custom_fields->>'account'
      ${all ? '' : `HAVING MAX(log_date) >= CURRENT_DATE - INTERVAL '${days} days'`}
      ORDER BY last_trade_date DESC
    `);

    res.json(result.rows.map(row => row.account));
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// ==================== SETTINGS ROUTES ====================

// Get all setup types
app.get('/api/setup-types', async (req, res) => {
  try {
    const result = await query('SELECT * FROM setup_types WHERE is_active = true ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching setup types:', error);
    res.status(500).json({ error: 'Failed to fetch setup types' });
  }
});

// Get custom field definitions
app.get('/api/custom-fields', async (req, res) => {
  try {
    const { category } = req.query;
    let queryText = 'SELECT * FROM custom_field_definitions';
    const params = [];
    
    if (category) {
      queryText += ' WHERE field_category = $1';
      params.push(category);
    }
    
    queryText += ' ORDER BY display_order, field_name';
    
    const result = await query(queryText, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching custom fields:', error);
    res.status(500).json({ error: 'Failed to fetch custom fields' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


// ===== SIERRA CHART API =====
app.get('/api/sierra/status', (req, res) => {
  res.json(sierraWatcher.getStatus());
});

app.post('/api/sierra/import', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  
  try {
    const result = await manualImportFromFile(filePath);
    io.emit('trades-updated', { ...result, timestamp: new Date() });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sierra/history', async (req, res) => {
  try {
    const history = await getImportHistory(parseInt(req.query.limit) || 50);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== TRADING BEHAVIOR / INTRADAY PATTERNS ====================
app.get('/api/stats/behavior', async (req, res) => {
  try {
    const { account, dateFrom, dateTo } = req.query;
    let conditions = [
      `custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'`,
      `custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'`
    ];
    let params = []; let p = 1;
    if (dateFrom) { conditions.push(`log_date >= $${p++}`); params.push(dateFrom); }
    else           { conditions.push(`log_date >= CURRENT_DATE - INTERVAL '90 days'`); }
    if (dateTo)  { conditions.push(`log_date <= $${p++}`); params.push(dateTo); }
    if (account) { conditions.push(`custom_fields->>'account' = ANY($${p++}::text[])`); params.push(account.split(',').filter(Boolean)); }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const parsePnl = `replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric`;

    // Aggregate all accounts per exit_time slot to get combined session P&L
    const raw = await query(`
      SELECT log_date::text, exit_time, SUM(${parsePnl}) as pnl
      FROM trades ${where}
      GROUP BY log_date, exit_time ORDER BY log_date, exit_time
    `, params);

    const byDate = {};
    for (const r of raw.rows) {
      if (!byDate[r.log_date]) byDate[r.log_date] = [];
      byDate[r.log_date].push(parseFloat(r.pnl));
    }

    const days = [];
    for (const [date, sessions] of Object.entries(byDate).sort()) {
      let running = 0, low = 0, high = 0;
      sessions.forEach(pnl => { running += pnl; if (running < low) low = running; if (running > high) high = running; });
      const s1 = sessions[0] ?? 0;
      const s2 = sessions[1] ?? null;
      const s3 = sessions[2] ?? null;
      const finalPnl = running;
      let pattern;
      if      (low < -200 && finalPnl > 0)               pattern = 'comeback';
      else if (low < -200 && finalPnl > low*0.5)         pattern = 'partial';
      else if (high > 300 && finalPnl < high*0.5)        pattern = 'gaveBack';
      else if (low < -200)                                pattern = 'straightDown';
      else if (finalPnl > 0 && low > -100)               pattern = 'cleanGreen';
      else                                                pattern = 'mixed';
      days.push({ date, sessions: sessions.length, s1, s2, s3, finalPnl, low, high, pattern });
    }

    const patternLabels = { comeback:'Hole → Comeback', partial:'Hole → Partial', gaveBack:'Gave Back Gains', straightDown:'Straight Down', cleanGreen:'Clean Green', mixed:'Mixed' };
    const ps = {};
    for (const d of days) {
      if (!ps[d.pattern]) ps[d.pattern] = { count:0, pnl:0, low:0, high:0, sess:0 };
      ps[d.pattern].count++; ps[d.pattern].pnl += d.finalPnl; ps[d.pattern].low += d.low; ps[d.pattern].high += d.high; ps[d.pattern].sess += d.sessions;
    }
    const patterns = Object.entries(ps).map(([k, s]) => ({
      key: k, label: patternLabels[k], count: s.count,
      avgPnl: Math.round(s.pnl/s.count), avgLow: Math.round(s.low/s.count),
      avgHigh: Math.round(s.high/s.count), avgSessions: Math.round(s.sess/s.count*10)/10
    })).sort((a,b) => b.avgPnl - a.avgPnl);

    const avgArr = arr => arr.length ? Math.round(arr.reduce((s,v)=>s+v,0)/arr.length) : 0;
    const fw = days.filter(d=>d.s1>0), fl = days.filter(d=>d.s1<0);
    const firstSessionStats = {
      winDays: fw.length, lossDays: fl.length,
      winAvgS1: avgArr(fw.map(d=>d.s1)), lossAvgS1: avgArr(fl.map(d=>d.s1)),
      winAvgFinal: avgArr(fw.map(d=>d.finalPnl)), lossAvgFinal: avgArr(fl.map(d=>d.finalPnl)),
      winStayedGreen: fw.filter(d=>d.finalPnl>0).length,
      lossRecoveredGreen: fl.filter(d=>d.finalPnl>0).length,
      winAvgS2: avgArr(fw.filter(d=>d.s2!==null).map(d=>d.s2||0)),
      lossAvgS2: avgArr(fl.filter(d=>d.s2!==null).map(d=>d.s2||0)),
      winAvgS3: avgArr(fw.filter(d=>d.s3!==null).map(d=>d.s3||0)),
      lossAvgS3: avgArr(fl.filter(d=>d.s3!==null).map(d=>d.s3||0))
    };

    const reentryRaw = await query(`
      WITH ep AS (
        SELECT log_date, exit_time, MIN(entry_time) as entry_time, SUM(${parsePnl}) as pnl
        FROM trades ${where} GROUP BY log_date, exit_time
      ),
      gapped AS (
        SELECT pnl,
          LAG(pnl) OVER (PARTITION BY log_date ORDER BY exit_time) as prev_pnl,
          EXTRACT(EPOCH FROM (entry_time - LAG(exit_time) OVER (PARTITION BY log_date ORDER BY exit_time))) as gap_sec
        FROM ep
      )
      SELECT
        CASE
          WHEN prev_pnl<0 AND gap_sec<60   THEN 'loss_under1'
          WHEN prev_pnl<0 AND gap_sec<300  THEN 'loss_1to5'
          WHEN prev_pnl<0 AND gap_sec>=300 THEN 'loss_over5'
          WHEN prev_pnl>0 AND gap_sec<60   THEN 'win_under1'
          WHEN prev_pnl>0 AND gap_sec>=60  THEN 'win_over1'
        END as bucket,
        COUNT(*) as cnt,
        ROUND(AVG(pnl)::numeric,2) as avg_pnl,
        ROUND(AVG(CASE WHEN pnl>0 THEN 1.0 ELSE 0.0 END)*100,1) as win_pct
      FROM gapped WHERE prev_pnl IS NOT NULL AND gap_sec >= 0
      GROUP BY bucket
    `, params);
    const reentry = {};
    for (const r of reentryRaw.rows) if (r.bucket) reentry[r.bucket] = { count: parseInt(r.cnt), avgPnl: parseFloat(r.avg_pnl), winPct: parseFloat(r.win_pct) };

    const scb = {};
    for (const d of days) {
      const k = d.sessions<=1?'1':d.sessions<=2?'2':d.sessions<=3?'3':d.sessions<=5?'4-5':d.sessions<=8?'6-8':'9+';
      if (!scb[k]) scb[k]={count:0,pnl:0,wins:0};
      scb[k].count++; scb[k].pnl+=d.finalPnl; if(d.finalPnl>0) scb[k].wins++;
    }
    const sessionCounts = ['1','2','3','4-5','6-8','9+'].filter(k=>scb[k]).map(k=>({
      label: k==='1'?'1 session':`${k} sessions`, bucket:k,
      days: scb[k].count, avgPnl: Math.round(scb[k].pnl/scb[k].count),
      winPct: Math.round(scb[k].wins/scb[k].count*100)
    }));

    res.json({
      patterns, firstSessionStats, reentry, sessionCounts,
      totalDays: days.length,
      days: days.map(d=>({ date:d.date, finalPnl:Math.round(d.finalPnl), low:Math.round(d.low), high:Math.round(d.high), sessions:d.sessions, pattern:d.pattern, s1:Math.round(d.s1) }))
    });
  } catch(err) {
    console.error('Behavior stats error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ==================== EFFICIENCY ANALYSIS ====================
app.get('/api/backtest/efficiency', async (req, res) => {
  try {
    const { account, dateFrom, dateTo } = req.query;

    let conditions = [
      `custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'`,
      `custom_fields->'sierra_data'->>'Entry Efficiency' ~ '^-?[0-9]+(\\.[0-9]+)?%$'`,
      `custom_fields->'sierra_data'->>'Exit Efficiency'  ~ '^-?[0-9]+(\\.[0-9]+)?%$'`,
      `custom_fields->'sierra_data'->>'Total Efficiency'  ~ '^-?[0-9]+(\\.[0-9]+)?%$'`
    ];
    let params = [];
    let p = 1;

    if (dateFrom) { conditions.push(`log_date >= $${p++}`); params.push(dateFrom); }
    if (dateTo)   { conditions.push(`log_date <= $${p++}`); params.push(dateTo); }
    if (account) {
      conditions.push(`custom_fields->>'account' = ANY($${p++}::text[])`);
      params.push(account.split(',').filter(Boolean));
    }

    const parseEff = col => `REPLACE(custom_fields->'sierra_data'->>'${col}','%','')::numeric`;
    const parseFtf = `CASE WHEN custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?\\s*F$'
      THEN REPLACE(REPLACE(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric END`;

    const where = `WHERE ${conditions.join(' AND ')}`;

    // Overall averages, split by win/loss
    const overallRes = await query(`
      SELECT
        COUNT(*) as total_sessions,
        ROUND(AVG(${parseEff('Entry Efficiency')})::numeric, 1) as avg_entry_eff,
        ROUND(AVG(${parseEff('Exit Efficiency')})::numeric,  1) as avg_exit_eff,
        ROUND(AVG(${parseEff('Total Efficiency')})::numeric,  1) as avg_total_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} > 0 THEN ${parseEff('Entry Efficiency')} END)::numeric, 1) as win_entry_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} > 0 THEN ${parseEff('Exit Efficiency')} END)::numeric,  1) as win_exit_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} > 0 THEN ${parseEff('Total Efficiency')} END)::numeric,  1) as win_total_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} < 0 THEN ${parseEff('Entry Efficiency')} END)::numeric, 1) as loss_entry_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} < 0 THEN ${parseEff('Exit Efficiency')} END)::numeric,  1) as loss_exit_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} < 0 THEN ${parseEff('Total Efficiency')} END)::numeric,  1) as loss_total_eff,
        COUNT(CASE WHEN ${parseFtf} > 0 THEN 1 END) as wins,
        COUNT(CASE WHEN ${parseFtf} < 0 THEN 1 END) as losses
      FROM trades ${where}
    `, params);

    // By date trend (filtered by selected timeframe — for the timeframe-aware charts below)
    const byDateRes = await query(`
      SELECT
        log_date::text,
        COUNT(*) as sessions,
        ROUND(AVG(${parseEff('Entry Efficiency')})::numeric, 1) as entry_eff,
        ROUND(AVG(${parseEff('Exit Efficiency')})::numeric,  1) as exit_eff,
        ROUND(AVG(${parseEff('Total Efficiency')})::numeric,  1) as total_eff,
        ROUND(AVG(${parseFtf})::numeric, 2) as avg_pnl
      FROM trades ${where}
      GROUP BY log_date ORDER BY log_date ASC
    `, params);

    // All-time by date (account-filtered only, no date cutoff — for the always-all-time trend chart)
    // All-time trend chart: no account filter, no date filter — shows the full history across all sessions
    const byDateAllRes = await query(`
      SELECT
        log_date::text,
        ROUND(AVG(${parseEff('Entry Efficiency')})::numeric, 1) as entry_eff,
        ROUND(AVG(${parseEff('Exit Efficiency')})::numeric,  1) as exit_eff,
        ROUND(AVG(${parseEff('Total Efficiency')})::numeric,  1) as total_eff
      FROM trades
      WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
        AND custom_fields->'sierra_data'->>'Entry Efficiency' ~ '^-?[0-9]+(\\.[0-9]+)?%$'
        AND custom_fields->'sierra_data'->>'Exit Efficiency'  ~ '^-?[0-9]+(\\.[0-9]+)?%$'
        AND custom_fields->'sierra_data'->>'Total Efficiency'  ~ '^-?[0-9]+(\\.[0-9]+)?%$'
      GROUP BY log_date ORDER BY log_date ASC
    `, []);

    // By hour ET
    const byHourRes = await query(`
      SELECT
        EXTRACT(HOUR FROM entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::int as hour,
        COUNT(*) as sessions,
        ROUND(AVG(${parseEff('Entry Efficiency')})::numeric, 1) as entry_eff,
        ROUND(AVG(${parseEff('Exit Efficiency')})::numeric,  1) as exit_eff,
        ROUND(AVG(${parseEff('Total Efficiency')})::numeric,  1) as total_eff
      FROM trades ${where}
      GROUP BY hour ORDER BY hour ASC
    `, params);

    // By session number (1st, 2nd, 3rd, 4+ of the day)
    const bySessionRes = await query(`
      WITH ranked AS (
        SELECT
          ${parseEff('Entry Efficiency')} as entry_eff,
          ${parseEff('Exit Efficiency')}  as exit_eff,
          ${parseEff('Total Efficiency')}  as total_eff,
          ${parseFtf} as pnl,
          ROW_NUMBER() OVER (PARTITION BY log_date, custom_fields->>'account' ORDER BY exit_time ASC) as session_num
        FROM trades ${where}
      )
      SELECT
        CASE WHEN session_num >= 4 THEN 4 ELSE session_num END as session_num,
        CASE WHEN session_num >= 4 THEN '4+' ELSE '#' || session_num END as label,
        COUNT(*) as sessions,
        ROUND(AVG(entry_eff)::numeric, 1) as entry_eff,
        ROUND(AVG(exit_eff)::numeric,  1) as exit_eff,
        ROUND(AVG(total_eff)::numeric,  1) as total_eff,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl
      FROM ranked
      GROUP BY CASE WHEN session_num >= 4 THEN 4 ELSE session_num END,
               CASE WHEN session_num >= 4 THEN '4+' ELSE '#' || session_num END
      ORDER BY session_num ASC
    `, params);

    // Scatter: total efficiency vs P&L per session (max 400 points)
    const scatterRes = await query(`
      SELECT
        ROUND(${parseEff('Total Efficiency')}::numeric, 1) as total_eff,
        ROUND(${parseFtf}::numeric, 2) as pnl,
        log_date::text as date
      FROM trades ${where}
        AND ${parseFtf} IS NOT NULL
      ORDER BY RANDOM() LIMIT 400
    `, params);

    // Session P&L distribution (for TP guidance) — uses FTF only, no efficiency filter needed
    const ftfOnlyConditions = conditions.filter(c =>
      !c.includes('Entry Efficiency') && !c.includes('Exit Efficiency') && !c.includes('Total Efficiency')
    );
    const pnlDistRes = await query(`
      WITH sessions AS (
        SELECT replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric as ftf
        FROM trades
        WHERE ${ftfOnlyConditions.join(' AND ')}
          AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
          AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
      )
      SELECT
        COUNT(*) FILTER (WHERE ftf > 0) as win_count,
        COUNT(*) FILTER (WHERE ftf < 0) as loss_count,
        ROUND(AVG(ftf) FILTER (WHERE ftf > 0)::numeric, 2) as avg_win,
        ROUND(AVG(ftf) FILTER (WHERE ftf < 0)::numeric, 2) as avg_loss,
        ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p25_win,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p50_win,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p75_win,
        ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p90_win,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf < 0)::numeric, 2) as p50_loss
      FROM sessions
    `, params);

    // All-time per-session FTF series for the rolling chart (account-filtered but no date filter)
    // Used to compute expanding-window p50/p75/p50Loss on the frontend
    const accountOnlyConditions = conditions.filter(c => c.includes('account') || c.includes('Exit DateTime'));
    const timeSeriesRes = await query(`
      SELECT log_date::text as date,
        replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric as ftf
      FROM trades
      WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
        AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
        ${account ? `AND custom_fields->>'account' = ANY($1::text[])` : ''}
      ORDER BY log_date ASC, exit_time ASC
    `, account ? [account.split(',').filter(Boolean)] : []);

    // Last-14-days aggregate (always fixed window, for the right-side boxes)
    const last14Params = account ? [account.split(',').filter(Boolean)] : [];
    const last14Res = await query(`
      WITH sessions AS (
        SELECT replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric as ftf
        FROM trades
        WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
          AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
          AND log_date >= CURRENT_DATE - 14
          ${account ? `AND custom_fields->>'account' = ANY($1::text[])` : ''}
      )
      SELECT
        COUNT(*) FILTER (WHERE ftf > 0) as win_count,
        COUNT(*) FILTER (WHERE ftf < 0) as loss_count,
        ROUND(AVG(ftf) FILTER (WHERE ftf > 0)::numeric, 2) as avg_win,
        ROUND(AVG(ftf) FILTER (WHERE ftf < 0)::numeric, 2) as avg_loss,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p50_win,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p75_win,
        ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p90_win,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf < 0)::numeric, 2) as p50_loss,
        ROUND(AVG(ftf) FILTER (WHERE ftf < 0)::numeric, 2) as avg_loss2
      FROM sessions
    `, last14Params);

    const o = overallRes.rows[0];
    const pd = pnlDistRes.rows[0];
    const l14 = last14Res.rows[0];
    res.json({
      overall: {
        totalSessions: parseInt(o.total_sessions),
        avgEntryEff:   parseFloat(o.avg_entry_eff),
        avgExitEff:    parseFloat(o.avg_exit_eff),
        avgTotalEff:   parseFloat(o.avg_total_eff),
        wins:          parseInt(o.wins),
        losses:        parseInt(o.losses),
        winBreakdown:  { entry: parseFloat(o.win_entry_eff),  exit: parseFloat(o.win_exit_eff),  total: parseFloat(o.win_total_eff)  },
        lossBreakdown: { entry: parseFloat(o.loss_entry_eff), exit: parseFloat(o.loss_exit_eff), total: parseFloat(o.loss_total_eff) }
      },
      byDate:        byDateRes.rows.map(r => ({ ...r, entry_eff: parseFloat(r.entry_eff), exit_eff: parseFloat(r.exit_eff), total_eff: parseFloat(r.total_eff), avg_pnl: parseFloat(r.avg_pnl) })),
      byDateAllTime: byDateAllRes.rows.map(r => ({ ...r, entry_eff: parseFloat(r.entry_eff), exit_eff: parseFloat(r.exit_eff), total_eff: parseFloat(r.total_eff) })),
      byHour:    byHourRes.rows.map(r => ({ ...r, hour: parseInt(r.hour), label: `${r.hour}:00`, entry_eff: parseFloat(r.entry_eff), exit_eff: parseFloat(r.exit_eff), total_eff: parseFloat(r.total_eff), sessions: parseInt(r.sessions) })),
      bySession: bySessionRes.rows.map(r => ({ ...r, session_num: parseInt(r.session_num), entry_eff: parseFloat(r.entry_eff), exit_eff: parseFloat(r.exit_eff), total_eff: parseFloat(r.total_eff), avg_pnl: parseFloat(r.avg_pnl), sessions: parseInt(r.sessions) })),
      scatter:   scatterRes.rows.map(r => ({ x: parseFloat(r.total_eff), y: parseFloat(r.pnl), date: r.date })),
      sessionPnlDist: pd ? {
        winCount:  parseInt(pd.win_count),
        lossCount: parseInt(pd.loss_count),
        avgWin:    parseFloat(pd.avg_win),
        avgLoss:   parseFloat(pd.avg_loss),
        p25Win:    parseFloat(pd.p25_win),
        p50Win:    parseFloat(pd.p50_win),
        p75Win:    parseFloat(pd.p75_win),
        p90Win:    parseFloat(pd.p90_win),
        p50Loss:   parseFloat(pd.p50_loss),
      } : null,
      // All-time series for rolling chart (raw per-session FTF)
      pnlTimeSeries: timeSeriesRes.rows.map(r => ({
        date: r.date,
        ftf:  r.ftf != null ? parseFloat(r.ftf) : null,
      })).filter(r => r.ftf != null),
      // Last-14-days stats for the right-side boxes
      last14DaysDist: l14 ? {
        winCount:  parseInt(l14.win_count),
        lossCount: parseInt(l14.loss_count),
        avgWin:    parseFloat(l14.avg_win),
        avgLoss:   parseFloat(l14.avg_loss2),
        p50Win:    parseFloat(l14.p50_win),
        p75Win:    parseFloat(l14.p75_win),
        p90Win:    parseFloat(l14.p90_win),
        p50Loss:   parseFloat(l14.p50_loss),
      } : null,
    });

  } catch (error) {
    console.error('Error fetching efficiency data:', error);
    res.status(500).json({ error: 'Failed to fetch efficiency data' });
  }
});

// ==================== ANALYSIS / PIVOT DATA ====================
// ==================== BACKTESTING ====================
app.get('/api/backtest', async (req, res) => {
  try {
    const { account, dateFrom, dateTo, maxDailyLoss, maxDailyProfit, timeCutoff, maxSessions, consecutiveLossStop } = req.query;

    let conditions = [
      `(custom_fields->'sierra_data'->>'Entry DateTime' LIKE '% BP' OR custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP')`
    ];
    let params = [];
    let p = 1;

    if (dateFrom) { conditions.push(`log_date >= $${p++}`); params.push(dateFrom); }
    if (dateTo)   { conditions.push(`log_date <= $${p++}`); params.push(dateTo); }
    if (account) {
      conditions.push(`custom_fields->>'account' = ANY($${p++}::text[])`);
      params.push(account.split(',').filter(Boolean));
    }

    const result = await query(`
      SELECT
        log_date::text,
        entry_time,
        exit_time,
        custom_fields->>'account' as account,
        custom_fields->'sierra_data'->>'Entry DateTime' as entry_dt,
        custom_fields->'sierra_data'->>'Exit DateTime' as exit_dt,
        custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' as ftf_pl
      FROM trades
      WHERE ${conditions.join(' AND ')}
      ORDER BY log_date ASC, exit_time ASC, entry_time ASC
    `, params);

    // Group fills into flat-to-flat sessions.
    // All fills sharing the same (account, exit_time) belong to the same session.
    // BP fill provides session start time; EP fill provides the session P&L (FTF ending in "F").
    const sessionMap = new Map();
    for (const fill of result.rows) {
      const exitISO = fill.exit_time instanceof Date ? fill.exit_time.toISOString() : fill.exit_time;
      const key = `${fill.log_date}|${fill.account}|${exitISO}`;
      if (!sessionMap.has(key)) {
        sessionMap.set(key, { date: fill.log_date, account: fill.account, sessionEnd: fill.exit_time, sessionStart: null, pnl: null });
      }
      const session = sessionMap.get(key);
      const entryDT = (fill.entry_dt || '').trim();
      const exitDT  = (fill.exit_dt  || '').trim();

      if (entryDT.endsWith('BP') && !session.sessionStart) {
        session.sessionStart = fill.entry_time;
      }
      if (exitDT.endsWith('EP')) {
        const ftfStr = (fill.ftf_pl || '').trim();
        if (ftfStr.toUpperCase().endsWith('F')) {
          session.pnl = parseFloat(ftfStr.replace(/\s*F$/i, '')) || 0;
        }
      }
    }

    const sessions = Array.from(sessionMap.values()).filter(s => s.pnl !== null);

    // Group by date and sort sessions within each day by start time
    const byDate = {};
    for (const s of sessions) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    }
    for (const date of Object.keys(byDate)) {
      byDate[date].sort((a, b) => new Date(a.sessionStart || a.sessionEnd) - new Date(b.sessionStart || b.sessionEnd));
    }

    // Convert UTC timestamp to ET minutes since midnight
    const getETMinutes = (ts) => {
      if (!ts) return null;
      const d = new Date(ts);
      const parts = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).split(':');
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    };
    const getETHour = (ts) => {
      if (!ts) return null;
      return parseInt(new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
    };

    // Parse rules
    const ruleMaxLoss   = maxDailyLoss       ? Math.abs(parseFloat(maxDailyLoss))   : null;
    const ruleMaxProfit = maxDailyProfit      ? Math.abs(parseFloat(maxDailyProfit)) : null;
    const ruleCutoff    = timeCutoff ? (() => { const [h, m] = timeCutoff.split(':').map(Number); return h * 60 + (m || 0); })() : null;
    const ruleMaxSess   = maxSessions         ? parseInt(maxSessions)                : null;
    const ruleConsLoss  = consecutiveLossStop ? parseInt(consecutiveLossStop)        : null;
    const hasRules = [ruleMaxLoss, ruleMaxProfit, ruleCutoff, ruleMaxSess, ruleConsLoss].some(r => r !== null);

    // Simulate each day applying the configured rules
    const sortedDates = Object.keys(byDate).sort();
    const daily = [];

    for (const date of sortedDates) {
      const daySessions = byDate[date];
      const actualPnl = daySessions.reduce((s, x) => s + x.pnl, 0);
      let simPnl = 0, ruleFired = false, ruleType = null, sessionsTaken = 0, consecutiveLosses = 0;

      for (const session of daySessions) {
        if (ruleCutoff !== null) {
          const mins = getETMinutes(session.sessionStart || session.sessionEnd);
          if (mins !== null && mins >= ruleCutoff) { ruleFired = true; ruleType = 'timeCutoff'; break; }
        }
        if (ruleMaxSess !== null && sessionsTaken >= ruleMaxSess)       { ruleFired = true; ruleType = 'maxSessions';    break; }
        if (ruleMaxLoss !== null && simPnl <= -ruleMaxLoss)             { ruleFired = true; ruleType = 'maxDailyLoss';   break; }
        if (ruleMaxProfit !== null && simPnl >= ruleMaxProfit)          { ruleFired = true; ruleType = 'maxDailyProfit'; break; }
        if (ruleConsLoss !== null && consecutiveLosses >= ruleConsLoss) { ruleFired = true; ruleType = 'consecutiveLoss'; break; }

        simPnl += session.pnl;
        sessionsTaken++;
        consecutiveLosses = session.pnl < 0 ? consecutiveLosses + 1 : 0;
      }

      daily.push({
        date,
        actualPnl:    Math.round(actualPnl * 100) / 100,
        simulatedPnl: hasRules ? Math.round(simPnl * 100) / 100 : Math.round(actualPnl * 100) / 100,
        ruleFired,
        ruleType,
        sessionsActual: daySessions.length,
        sessionsTaken:  hasRules ? sessionsTaken : daySessions.length
      });
    }

    // Add cumulative columns
    let cumActual = 0, cumSim = 0;
    for (const d of daily) {
      cumActual += d.actualPnl; cumSim += d.simulatedPnl;
      d.cumActual    = Math.round(cumActual * 100) / 100;
      d.cumSimulated = Math.round(cumSim * 100) / 100;
    }

    const totalActual = daily.reduce((s, d) => s + d.actualPnl, 0);
    const totalSim    = daily.reduce((s, d) => s + d.simulatedPnl, 0);

    // === Pattern Analysis ===

    // Session-number performance (1st, 2nd, 3rd, 4+ session of the day)
    const snStats = {};
    for (const date of sortedDates) {
      byDate[date].forEach((s, idx) => {
        const num = idx < 3 ? idx + 1 : 4;
        if (!snStats[num]) snStats[num] = { count: 0, wins: 0, pnl: 0 };
        snStats[num].count++;  snStats[num].pnl += s.pnl;
        if (s.pnl > 0) snStats[num].wins++;
      });
    }
    const sessionNumbers = Object.entries(snStats).map(([num, s]) => ({
      label: num === '4' ? '4+' : `#${num}`,
      sessionNum: parseInt(num),
      avgPnl:  Math.round((s.pnl / s.count) * 100) / 100,
      winRate: Math.round((s.wins / s.count) * 100),
      count:   s.count,
      totalPnl: Math.round(s.pnl * 100) / 100
    })).sort((a, b) => a.sessionNum - b.sessionNum);

    // Hourly performance (ET hour of session start)
    const hourStats = {};
    for (const s of sessions) {
      const hour = getETHour(s.sessionStart || s.sessionEnd);
      if (hour === null) continue;
      if (!hourStats[hour]) hourStats[hour] = { count: 0, wins: 0, pnl: 0 };
      hourStats[hour].count++;  hourStats[hour].pnl += s.pnl;
      if (s.pnl > 0) hourStats[hour].wins++;
    }
    const hourlyPerformance = Object.entries(hourStats).map(([h, s]) => ({
      hour: parseInt(h), label: `${h}:00`,
      avgPnl:  Math.round((s.pnl / s.count) * 100) / 100,
      winRate: Math.round((s.wins / s.count) * 100),
      count:   s.count,
      totalPnl: Math.round(s.pnl * 100) / 100
    })).sort((a, b) => a.hour - b.hour);

    // After-loss vs after-win next-session performance
    let afterLoss = { count: 0, wins: 0, pnl: 0 };
    let afterWin  = { count: 0, wins: 0, pnl: 0 };
    for (const date of sortedDates) {
      const ds = byDate[date];
      for (let i = 1; i < ds.length; i++) {
        const tgt = ds[i - 1].pnl < 0 ? afterLoss : afterWin;
        tgt.count++;  tgt.pnl += ds[i].pnl;
        if (ds[i].pnl > 0) tgt.wins++;
      }
    }

    // Day-of-week performance
    const dowStats = {};
    const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const date of sortedDates) {
      const dow = new Date(date + 'T12:00:00Z').getDay();
      const dayPnl = byDate[date].reduce((s, x) => s + x.pnl, 0);
      if (!dowStats[dow]) dowStats[dow] = { days: 0, wins: 0, pnl: 0 };
      dowStats[dow].days++;  dowStats[dow].pnl += dayPnl;
      if (dayPnl > 0) dowStats[dow].wins++;
    }
    const dayOfWeek = Object.entries(dowStats).map(([dow, s]) => ({
      dow: parseInt(dow), label: dowNames[parseInt(dow)],
      avgPnl:  Math.round((s.pnl / s.days) * 100) / 100,
      winRate: Math.round((s.wins / s.days) * 100),
      days: s.days,
      totalPnl: Math.round(s.pnl * 100) / 100
    })).sort((a, b) => a.dow - b.dow);

    res.json({
      summary: {
        actualPnl:    Math.round(totalActual * 100) / 100,
        simulatedPnl: Math.round(totalSim * 100) / 100,
        improvement:  Math.round((totalSim - totalActual) * 100) / 100,
        daysTraded:   daily.length,
        daysRuleFired: daily.filter(d => d.ruleFired).length,
        daysImproved:  daily.filter(d => d.simulatedPnl > d.actualPnl).length,
        daysHurt:      daily.filter(d => d.simulatedPnl < d.actualPnl).length,
        hasRules
      },
      daily,
      patterns: {
        sessionNumbers,
        hourlyPerformance,
        dayOfWeek,
        afterLoss: {
          count: afterLoss.count,
          winRate: afterLoss.count > 0 ? Math.round((afterLoss.wins / afterLoss.count) * 100) : 0,
          avgPnl:  afterLoss.count > 0 ? Math.round((afterLoss.pnl  / afterLoss.count) * 100) / 100 : 0
        },
        afterWin: {
          count: afterWin.count,
          winRate: afterWin.count > 0 ? Math.round((afterWin.wins / afterWin.count) * 100) : 0,
          avgPnl:  afterWin.count > 0 ? Math.round((afterWin.pnl  / afterWin.count) * 100) / 100 : 0
        }
      }
    });

  } catch (error) {
    console.error('Error running backtest:', error);
    res.status(500).json({ error: 'Failed to run backtest' });
  }
});

// ==================== PRICE BARS ====================
import { ingestBarFile, scanAndIngestNewBarFiles, getBars, parseContractFromFilename } from './services/priceBarService.js';

const SIERRA_DATA_DIR = process.env.SIERRA_DATA_PATH || '/mnt/c/SierraChart/Data';

// On startup: auto-ingest any new bar files already sitting in the data dir
setTimeout(async () => {
  try { await scanAndIngestNewBarFiles(SIERRA_DATA_DIR); } catch (e) { console.error('Auto-ingest error:', e.message); }
}, 5000); // 5s delay so DB is ready

// GET /api/price-bars/status — what's been ingested
app.get('/api/price-bars/status', async (req, res) => {
  try {
    const result = await query(`
      SELECT filename, contract, symbol, bars_inserted, date_from, date_to, ingested_at
      FROM price_bar_ingests ORDER BY symbol, date_from
    `);
    const coverage = await query(`
      SELECT symbol, MIN(ts) as from_ts, MAX(ts) as to_ts, COUNT(*) as total_bars,
        COUNT(DISTINCT contract) as contracts
      FROM price_bars GROUP BY symbol ORDER BY symbol
    `);
    res.json({ ingests: result.rows, coverage: coverage.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/price-bars/ingest — scan Data dir for updated bar files and ingest them
// Sierra Chart's "Write Bar Data to File" study handles export automatically.
app.post('/api/price-bars/ingest', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Bar data scan started' });
    io.emit('price-sync-progress', { status: 'running', message: 'Scanning for updated bar files…', total: 0, done: 0 });

    const results = await scanAndIngestNewBarFiles(SIERRA_DATA_DIR);
    const updated = results.filter(r => !r.error && !r.skipped);
    const totalBars = updated.reduce((s, r) => s + (r.bars_inserted || 0), 0);

    if (updated.length === 0) {
      io.emit('price-sync-progress', { status: 'success', message: 'Price data already up to date', total: 0, done: 0 });
    } else {
      io.emit('price-sync-progress', { status: 'success', message: `${updated.length} file(s) updated · ${totalBars.toLocaleString()} bars ingested`, total: updated.length, done: updated.length });
      if (updated.some(r => r.symbol === 'NQ')) setTimeout(autoComputeTodayACD, 1000);
      // Also try OR pre-compute if it's 9:35-11:00 and OR not yet set
      if (updated.some(r => r.symbol === 'NQ')) {
        const nowET2 = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const h2 = nowET2.getHours(), m2 = nowET2.getMinutes();
        if ((h2 === 9 && m2 >= 35) || (h2 === 10)) {
          setTimeout(async () => {
            const todayET2 = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            const { aMult } = await getBestACDParams();
            const levels = await computeORLevelsOnly(todayET2, aMult);
            if (levels) {
              console.log(`📐 OR levels set after bar sync: A Up ${levels.aUpLevel} / A Down ${levels.aDownLevel}`);
              io.emit('acd-levels-updated', levels);
            }
          }, 2000);
        }
      }
    }
  } catch (err) {
    io.emit('price-sync-progress', { status: 'error', message: err.message });
  }
});

// GET /api/price-bars/query — fetch bars for a symbol/time range
// ?symbol=NQ&from=2026-03-15T14:30:00Z&to=2026-03-15T16:00:00Z&interval=1
app.get('/api/price-bars/query', async (req, res) => {
  try {
    const { symbol, from, to, interval = 1 } = req.query;
    if (!symbol || !from || !to) return res.status(400).json({ error: 'symbol, from, to required' });
    const bars = await getBars(symbol, new Date(from), new Date(to), parseInt(interval));
    res.json(bars);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/price-bars/volume-profile — compute volume profile for a date/symbol
// ?symbol=NQ&date=2025-03-21&session=rth|overnight|both&contract=NQH25
app.get('/api/price-bars/volume-profile', async (req, res) => {
  try {
    const { symbol = 'NQ', date, session = 'rth', contract } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    // Session times are in EST (Eastern), matching Sierra Chart's display timezone.
    // Bar files are exported in EST so stored values match directly.
    // RTH:       09:30 – 16:14 on the selected date
    // Overnight: 16:15 prev day – 09:29 on the selected date
    // Both:      16:15 prev day – 16:14 on the selected date
    const prevDay = new Date(date + 'T12:00:00Z');
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    const prev = prevDay.toISOString().slice(0, 10);

    let fromTs, toTs, sessionLabel;
    if (session === 'overnight') {
      fromTs = `${prev} 16:15:00`; toTs = `${date} 09:29:59`; sessionLabel = 'Overnight';
    } else if (session === 'both') {
      fromTs = `${prev} 16:15:00`; toTs = `${date} 16:14:59`; sessionLabel = 'Full Day';
    } else {
      fromTs = `${date} 09:30:00`; toTs = `${date} 16:14:59`; sessionLabel = 'RTH';
    }

    // Find the right contract for the date if not specified
    let contractFilter = contract;
    if (!contractFilter) {
      const r = await query(
        `SELECT contract FROM price_bars WHERE symbol=$1 AND ts::text BETWEEN $2 AND $3
         GROUP BY contract ORDER BY COUNT(*) DESC LIMIT 1`,
        [symbol, fromTs, toTs]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'No bars found for this date' });
      contractFilter = r.rows[0].contract;
    }

    const bars = await query(
      `SELECT open, high, low, close, volume, bid_volume, ask_volume
       FROM price_bars WHERE contract=$1 AND ts::text BETWEEN $2 AND $3 ORDER BY ts`,
      [contractFilter, fromTs, toTs]
    );

    if (!bars.rows.length) return res.status(404).json({ error: 'No bars found' });

    // Build volume profile: distribute each bar's volume across price range in 0.25 tick increments
    const TICK = 0.25;
    const volByPrice = {};
    const bidByPrice = {};
    const askByPrice = {};

    for (const bar of bars.rows) {
      const lo  = parseFloat(bar.low);
      const hi  = parseFloat(bar.high);
      const vol = parseFloat(bar.volume) || 0;
      const bid = parseFloat(bar.bid_volume) || 0;
      const ask = parseFloat(bar.ask_volume) || 0;
      const ticks = Math.round((hi - lo) / TICK) + 1;
      const vpt = vol / ticks;
      const bpt = bid / ticks;
      const apt = ask / ticks;

      for (let p = lo; p <= hi + 0.001; p += TICK) {
        const key = Math.round(p / TICK) * TICK;
        volByPrice[key] = (volByPrice[key] || 0) + vpt;
        bidByPrice[key] = (bidByPrice[key] || 0) + bpt;
        askByPrice[key] = (askByPrice[key] || 0) + apt;
      }
    }

    // Sort by price
    const levels = Object.keys(volByPrice)
      .map(k => parseFloat(k))
      .sort((a, b) => a - b);

    // Find POC
    let pocPrice = levels[0], pocVol = 0;
    for (const p of levels) {
      if (volByPrice[p] > pocVol) { pocVol = volByPrice[p]; pocPrice = p; }
    }

    // Value Area: 70% of total volume around POC
    const totalVol = Object.values(volByPrice).reduce((s, v) => s + v, 0);
    const vaTarget = totalVol * 0.70;
    const pocIdx = levels.indexOf(pocPrice);
    let vaVol = volByPrice[pocPrice];
    let loIdx = pocIdx, hiIdx = pocIdx;
    while (vaVol < vaTarget && (loIdx > 0 || hiIdx < levels.length - 1)) {
      const addHi = hiIdx < levels.length - 1 ? volByPrice[levels[hiIdx + 1]] : 0;
      const addLo = loIdx > 0 ? volByPrice[levels[loIdx - 1]] : 0;
      if (addHi >= addLo && hiIdx < levels.length - 1) { hiIdx++; vaVol += addHi; }
      else if (loIdx > 0) { loIdx--; vaVol += addLo; }
      else { hiIdx++; vaVol += addHi; }
    }

    const profile = levels.map(p => ({
      price: p,
      volume: Math.round(volByPrice[p]),
      bid:    Math.round(bidByPrice[p]),
      ask:    Math.round(askByPrice[p]),
    }));

    res.json({
      contract: contractFilter,
      date,
      session: sessionLabel,
      fromTs,
      toTs,
      totalBars: bars.rows.length,
      totalVolume: Math.round(totalVol),
      poc: pocPrice,
      vah: levels[hiIdx],
      val: levels[loIdx],
      profile,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/price-bars/available — list what date ranges are available per symbol
app.get('/api/price-bars/available', async (req, res) => {
  try {
    const result = await query(`
      SELECT symbol, contract, MIN(ts) as from_ts, MAX(ts) as to_ts, COUNT(*) as bars
      FROM price_bars GROUP BY symbol, contract ORDER BY symbol, from_ts
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== TEARSHEET ENDPOINTS ====================

// Helper to build WHERE clause (reused across tearsheet endpoints)
function buildWhere(query = {}) {
  const { dateFrom, dateTo, account } = query;
  const conds = ['exit_time IS NOT NULL'];
  const params = [];
  let p = 1;
  if (dateFrom) { conds.push(`log_date >= $${p++}`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`log_date <= $${p++}`); params.push(dateTo); }
  if (account)  { conds.push(`custom_fields->>'account' = ANY($${p++}::text[])`); params.push(account.split(',').filter(Boolean)); }
  return { where: conds.join(' AND '), params };
}

// Extended overview: Sharpe, Sortino, SQN, Kelly, Calmar, Omega, duration stats, long/short
app.get('/api/stats/tearsheet-overview', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);

    // All trades ordered by time for sequential stats
    const tradesRes = await query(`
      SELECT pnl, log_date, direction,
        EXTRACT(EPOCH FROM (exit_time - entry_time)) as duration_secs
      FROM trades WHERE ${where} ORDER BY entry_time ASC
    `, params);
    const trades = tradesRes.rows;
    if (!trades.length) return res.json({});

    const pnls = trades.map(t => parseFloat(t.pnl));
    const n = pnls.length;
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const grossProfit = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const avgWin = wins.length ? grossProfit / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const winRate = wins.length / n;
    const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : null;
    const expectancy = totalPnl / n;
    const kelly = payoffRatio ? winRate - (1 - winRate) / payoffRatio : null;
    const breakevenWR = payoffRatio ? 1 / (1 + payoffRatio) : null;

    // Std dev & SQN
    const mean = totalPnl / n;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    const sqn = stdDev > 0 ? (expectancy / stdDev) * Math.sqrt(n) : null;

    // Max drawdown, drawdown episodes, runup
    let peak = 0, trough = 0, cum = 0, maxDD = 0, maxRunup = 0, runupBase = 0;
    let ddStart = null, ddEpisodes = [], currentDDStart = null;
    trades.forEach((t, i) => {
      const p = parseFloat(t.pnl);
      cum += p;
      if (cum > peak) {
        if (currentDDStart !== null) {
          ddEpisodes.push({ start: currentDDStart, end: i, depth: peak - trough });
          currentDDStart = null;
        }
        const runup = cum - runupBase;
        if (runup > maxRunup) maxRunup = runup;
        peak = cum;
        trough = cum;
      }
      if (cum < trough) {
        trough = cum;
        if (currentDDStart === null) currentDDStart = i;
      }
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    });
    const calmar = maxDD > 0 ? totalPnl / maxDD : null;
    const recoveryFactor = maxDD > 0 ? totalPnl / maxDD : null;
    const omega = grossLoss > 0 ? grossProfit / grossLoss : null; // same as profit factor

    // Daily P&L for Sharpe/Sortino
    const dailyRes = await query(`
      WITH ep_fills AS (
        SELECT log_date, custom_fields->>'account' as account, exit_time,
          CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
        FROM trades WHERE ${where} AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
      ),
      last_ep AS (SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl FROM ep_fills ORDER BY log_date, account, exit_time DESC),
      daily_pa AS (SELECT log_date, cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) as d_pnl FROM last_ep WHERE cum_pl IS NOT NULL),
      daily AS (SELECT log_date, SUM(d_pnl) as daily_pnl FROM daily_pa GROUP BY log_date ORDER BY log_date)
      SELECT daily_pnl FROM daily
    `, params);
    const dailyPnls = dailyRes.rows.map(r => parseFloat(r.daily_pnl));
    let sharpe = null, sortino = null, ulcer = null;
    if (dailyPnls.length > 1) {
      const dm = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
      const dv = dailyPnls.reduce((s, p) => s + (p - dm) ** 2, 0) / dailyPnls.length;
      const ds = Math.sqrt(dv);
      if (ds > 0) sharpe = (dm / ds) * Math.sqrt(252);
      const downside = dailyPnls.filter(p => p < 0);
      const dDown = downside.length ? Math.sqrt(downside.reduce((s, p) => s + p ** 2, 0) / dailyPnls.length) : 0;
      if (dDown > 0) sortino = (dm / dDown) * Math.sqrt(252);
      // Ulcer index from cumulative daily
      let peak2 = 0, cumD = 0;
      const ddPcts = dailyPnls.map(p => { cumD += p; if (cumD > peak2) peak2 = cumD; return peak2 > 0 ? ((cumD - peak2) / peak2 * 100) ** 2 : 0; });
      ulcer = Math.sqrt(ddPcts.reduce((a, b) => a + b, 0) / ddPcts.length);
    }

    // Duration stats
    const durs = trades.map(t => parseFloat(t.duration_secs)).filter(d => d > 0 && isFinite(d));
    const winDurs = trades.filter(t => parseFloat(t.pnl) > 0).map(t => parseFloat(t.duration_secs)).filter(d => d > 0 && isFinite(d));
    const lossDurs = trades.filter(t => parseFloat(t.pnl) < 0).map(t => parseFloat(t.duration_secs)).filter(d => d > 0 && isFinite(d));
    const avgDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
    const avgWinDur = winDurs.length ? winDurs.reduce((a, b) => a + b, 0) / winDurs.length : null;
    const avgLossDur = lossDurs.length ? lossDurs.reduce((a, b) => a + b, 0) / lossDurs.length : null;
    const minDur = durs.length ? Math.min(...durs) : null;
    const maxDur = durs.length ? Math.max(...durs) : null;

    // Long / Short breakdown
    const longs = trades.filter(t => t.direction === 'Long');
    const shorts = trades.filter(t => t.direction === 'Short');
    const longWins = longs.filter(t => parseFloat(t.pnl) > 0);
    const shortWins = shorts.filter(t => parseFloat(t.pnl) > 0);

    // Profit concentration
    const sortedWins = [...wins].sort((a, b) => b - a);
    const top1share = grossProfit > 0 ? sortedWins[0] / grossProfit : null;
    const top5share = grossProfit > 0 ? sortedWins.slice(0, 5).reduce((a, b) => a + b, 0) / grossProfit : null;
    const top10share = grossProfit > 0 ? sortedWins.slice(0, 10).reduce((a, b) => a + b, 0) / grossProfit : null;

    // Daily stats for profitability %
    const allDailyRes = await query(`
      WITH ep_fills AS (
        SELECT log_date, custom_fields->>'account' as account, exit_time,
          CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
        FROM trades WHERE ${where} AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
      ),
      last_ep AS (SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl FROM ep_fills ORDER BY log_date, account, exit_time DESC),
      daily_pa AS (SELECT log_date, cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) as d_pnl FROM last_ep WHERE cum_pl IS NOT NULL),
      daily AS (SELECT log_date, SUM(d_pnl) as daily_pnl FROM daily_pa GROUP BY log_date)
      SELECT log_date, daily_pnl FROM daily ORDER BY log_date
    `, params);
    const allDaily = allDailyRes.rows;
    const winDays = allDaily.filter(d => parseFloat(d.daily_pnl) > 0).length;
    const lossDays = allDaily.filter(d => parseFloat(d.daily_pnl) < 0).length;
    const avgWinDay = winDays ? allDaily.filter(d => parseFloat(d.daily_pnl) > 0).reduce((s, d) => s + parseFloat(d.daily_pnl), 0) / winDays : 0;
    const avgLossDay = lossDays ? allDaily.filter(d => parseFloat(d.daily_pnl) < 0).reduce((s, d) => s + parseFloat(d.daily_pnl), 0) / lossDays : 0;

    // Profitable weeks/months
    const weekMap = {}, monthMap = {};
    allDaily.forEach(d => {
      const date = new Date(d.date || d.log_date);
      const yr = date.getFullYear();
      const wk = `${yr}-W${String(Math.ceil(((date - new Date(yr,0,1))/86400000+1)/7)).padStart(2,'0')}`;
      const mo = d.log_date.slice(0, 7);
      if (!weekMap[wk]) weekMap[wk] = 0;
      if (!monthMap[mo]) monthMap[mo] = 0;
      weekMap[wk] += parseFloat(d.daily_pnl);
      monthMap[mo] += parseFloat(d.daily_pnl);
    });
    const weeks = Object.values(weekMap);
    const months = Object.values(monthMap);
    const pctProfWeeks = weeks.length ? weeks.filter(v => v > 0).length / weeks.length * 100 : null;
    const pctProfMonths = months.length ? months.filter(v => v > 0).length / months.length * 100 : null;

    res.json({
      // Risk-adjusted
      sharpe: sharpe ? +sharpe.toFixed(3) : null,
      sortino: sortino ? +sortino.toFixed(3) : null,
      ulcer_index: ulcer ? +ulcer.toFixed(3) : null,
      calmar: calmar ? +calmar.toFixed(3) : null,
      omega: omega ? +omega.toFixed(3) : null,
      // Trade quality
      sqn: sqn ? +sqn.toFixed(3) : null,
      expectancy: +expectancy.toFixed(2),
      payoff_ratio: payoffRatio ? +payoffRatio.toFixed(3) : null,
      kelly: kelly ? +(kelly * 100).toFixed(1) : null,
      breakeven_wr: breakevenWR ? +(breakevenWR * 100).toFixed(1) : null,
      recovery_factor: recoveryFactor ? +recoveryFactor.toFixed(3) : null,
      max_runup: +maxRunup.toFixed(2),
      // Duration
      avg_duration_secs: avgDur ? +avgDur.toFixed(0) : null,
      avg_win_duration_secs: avgWinDur ? +avgWinDur.toFixed(0) : null,
      avg_loss_duration_secs: avgLossDur ? +avgLossDur.toFixed(0) : null,
      min_duration_secs: minDur,
      max_duration_secs: maxDur,
      // Long/Short
      long_count: longs.length, short_count: shorts.length,
      long_win_rate: longs.length ? +(longWins.length / longs.length * 100).toFixed(1) : null,
      short_win_rate: shorts.length ? +(shortWins.length / shorts.length * 100).toFixed(1) : null,
      long_pnl: +longs.reduce((s, t) => s + parseFloat(t.pnl), 0).toFixed(2),
      short_pnl: +shorts.reduce((s, t) => s + parseFloat(t.pnl), 0).toFixed(2),
      // Concentration
      top1_profit_share: top1share ? +(top1share * 100).toFixed(1) : null,
      top5_profit_share: top5share ? +(top5share * 100).toFixed(1) : null,
      top10_profit_share: top10share ? +(top10share * 100).toFixed(1) : null,
      // Day stats
      win_days: winDays, loss_days: lossDays,
      avg_win_day: +avgWinDay.toFixed(2), avg_loss_day: +avgLossDay.toFixed(2),
      pct_profitable_weeks: pctProfWeeks ? +pctProfWeeks.toFixed(1) : null,
      pct_profitable_months: pctProfMonths ? +pctProfMonths.toFixed(1) : null,
    });
  } catch (err) {
    console.error('tearsheet-overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Trade P&L distribution (histogram buckets)
app.get('/api/stats/pnl-distribution', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);
    const result = await query(`SELECT pnl FROM trades WHERE ${where} ORDER BY pnl`, params);
    const pnls = result.rows.map(r => parseFloat(r.pnl));
    if (!pnls.length) return res.json([]);
    const min = Math.floor(Math.min(...pnls) / 50) * 50;
    const max = Math.ceil(Math.max(...pnls) / 50) * 50;
    const bucketSize = Math.max(50, Math.round((max - min) / 30 / 50) * 50);
    const buckets = {};
    for (let b = min; b <= max; b += bucketSize) buckets[b] = 0;
    pnls.forEach(p => {
      const b = Math.floor(p / bucketSize) * bucketSize;
      buckets[b] = (buckets[b] || 0) + 1;
    });
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const median = pnls[Math.floor(pnls.length / 2)];
    res.json({ buckets: Object.entries(buckets).map(([k, v]) => ({ range: +k, count: v })), mean: +mean.toFixed(2), median: +median.toFixed(2) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Timing heatmap: weekday × hour average P&L
app.get('/api/stats/timing-heatmap', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);
    const result = await query(`
      SELECT
        EXTRACT(DOW FROM exit_time AT TIME ZONE 'America/New_York') as dow,
        EXTRACT(HOUR FROM exit_time AT TIME ZONE 'America/New_York') as hour,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
        COUNT(*) as trade_count,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl
      FROM trades WHERE ${where}
      GROUP BY dow, hour ORDER BY dow, hour
    `, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rolling 20-trade metrics
app.get('/api/stats/rolling', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);
    const result = await query(`SELECT pnl, entry_time FROM trades WHERE ${where} ORDER BY entry_time ASC`, params);
    const trades = result.rows;
    const window = 20;
    const rolling = [];
    for (let i = window - 1; i < trades.length; i++) {
      const slice = trades.slice(i - window + 1, i + 1).map(t => parseFloat(t.pnl));
      const wins = slice.filter(p => p > 0);
      const losses = slice.filter(p => p < 0);
      const exp = slice.reduce((a, b) => a + b, 0) / window;
      const wr = wins.length / window * 100;
      const pf = losses.length ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : null;
      rolling.push({ index: i, date: trades[i].entry_time, expectancy: +exp.toFixed(2), win_rate: +wr.toFixed(1), profit_factor: pf ? +pf.toFixed(2) : null });
    }
    res.json(rolling);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Monthly return heatmap (year × month)
app.get('/api/stats/monthly-heatmap', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);
    const result = await query(`
      WITH ep_fills AS (
        SELECT log_date, custom_fields->>'account' as account, exit_time,
          CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
        FROM trades WHERE ${where} AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
      ),
      last_ep AS (SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl FROM ep_fills ORDER BY log_date, account, exit_time DESC),
      daily_pa AS (SELECT log_date, cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) as d_pnl FROM last_ep WHERE cum_pl IS NOT NULL),
      daily AS (SELECT log_date, SUM(d_pnl) as daily_pnl FROM daily_pa GROUP BY log_date)
      SELECT
        EXTRACT(YEAR FROM log_date)::int as year,
        EXTRACT(MONTH FROM log_date)::int as month,
        ROUND(SUM(daily_pnl)::numeric, 2) as pnl,
        COUNT(*) as trading_days,
        SUM(CASE WHEN daily_pnl > 0 THEN 1 ELSE 0 END) as win_days
      FROM daily GROUP BY year, month ORDER BY year, month
    `, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// MFE/MAE and execution efficiency stats
app.get('/api/stats/excursion', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);
    const result = await query(`
      SELECT
        pnl,
        NULLIF(REGEXP_REPLACE(custom_fields->>'max_open_profit', '[^0-9.\\-]','','g'), '')::numeric AS mfe,
        NULLIF(REGEXP_REPLACE(custom_fields->>'max_open_loss',   '[^0-9.\\-]','','g'), '')::numeric AS mae,
        NULLIF(REGEXP_REPLACE(REPLACE(custom_fields->>'entry_efficiency','%',''), '[^0-9.\\-]','','g'), '')::numeric AS entry_eff,
        NULLIF(REGEXP_REPLACE(REPLACE(custom_fields->>'exit_efficiency', '%',''), '[^0-9.\\-]','','g'), '')::numeric AS exit_eff,
        NULLIF(REGEXP_REPLACE(REPLACE(custom_fields->>'total_efficiency','%',''), '[^0-9.\\-]','','g'), '')::numeric AS total_eff
      FROM trades
      WHERE ${where}
        AND custom_fields->>'max_open_profit' IS NOT NULL
        AND custom_fields->>'max_open_profit' != ''
    `, params);

    const rows = result.rows.filter(r => r.mfe !== null);
    if (!rows.length) return res.json({ summary: {}, scatter: [] });

    const mfes = rows.map(r => parseFloat(r.mfe)).filter(v => isFinite(v));
    const maes = rows.map(r => parseFloat(r.mae)).filter(v => isFinite(v));
    const entryEffs = rows.map(r => parseFloat(r.entry_eff)).filter(v => isFinite(v) && v >= 0);
    const exitEffs  = rows.map(r => parseFloat(r.exit_eff)).filter(v => isFinite(v) && v >= 0);
    const totalEffs = rows.map(r => parseFloat(r.total_eff)).filter(v => isFinite(v) && v >= 0);

    const pct = (arr, p) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length * p / 100)] ?? null;
    };
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    // MFE capture: pnl / mfe for trades where mfe > 0
    const captureRows = rows.filter(r => parseFloat(r.mfe) > 0);
    const mfeCaptures = captureRows.map(r => parseFloat(r.pnl) / parseFloat(r.mfe) * 100);

    // Scatter data (capped at 500 points)
    const step = Math.max(1, Math.floor(rows.length / 500));
    const scatter = rows.filter((_, i) => i % step === 0).map(r => ({
      mfe: parseFloat(r.mfe),
      mae: Math.abs(parseFloat(r.mae)),
      pnl: parseFloat(r.pnl),
    }));

    res.json({
      summary: {
        avg_mfe: avg(mfes) ? +avg(mfes).toFixed(2) : null,
        avg_mae: avg(maes) ? +avg(maes).toFixed(2) : null,
        avg_entry_eff: avg(entryEffs) ? +avg(entryEffs).toFixed(1) : null,
        avg_exit_eff:  avg(exitEffs)  ? +avg(exitEffs).toFixed(1)  : null,
        avg_total_eff: avg(totalEffs) ? +avg(totalEffs).toFixed(1) : null,
        avg_mfe_capture: avg(mfeCaptures) ? +avg(mfeCaptures).toFixed(1) : null,
        mfe_p50: pct(mfes, 50) ? +pct(mfes, 50).toFixed(2) : null,
        mfe_p75: pct(mfes, 75) ? +pct(mfes, 75).toFixed(2) : null,
        mfe_p90: pct(mfes, 90) ? +pct(mfes, 90).toFixed(2) : null,
        mae_p50: pct(maes, 50) ? +pct(maes, 50).toFixed(2) : null,
        mae_p75: pct(maes, 75) ? +pct(maes, 75).toFixed(2) : null,
        mae_p90: pct(maes, 90) ? +pct(maes, 90).toFixed(2) : null,
        n: rows.length,
      },
      scatter,
      // Entry efficiency distribution (buckets of 10%)
      entry_eff_dist: (() => {
        const buckets = Array.from({length: 11}, (_, i) => ({ range: i*10, count: 0 }));
        entryEffs.forEach(v => { const b = Math.min(10, Math.floor(v/10)); buckets[b].count++; });
        return buckets;
      })(),
      exit_eff_dist: (() => {
        const buckets = Array.from({length: 11}, (_, i) => ({ range: i*10, count: 0 }));
        exitEffs.forEach(v => { const b = Math.min(10, Math.floor(v/10)); buckets[b].count++; });
        return buckets;
      })(),
    });
  } catch (err) {
    console.error('excursion error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== SIERRA CHART SYNC TRIGGER ====================
app.post('/api/trigger-export', async (req, res) => {
  // Respond immediately so the browser doesn't time out
  res.json({ ok: true, message: 'Export started' });

  const emitProgress = (step, message, status = 'running') => {
    io.emit('sync-progress', { step, message, status, timestamp: new Date() });
  };

  try {
    const { spawn } = await import('child_process');
    emitProgress(1, 'Launching export script...', 'running');

    await new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NonInteractive',
        '-File', 'C:\\SierraChart\\export_tal.ps1'
      ], { timeout: 60000 });

      let out = '';
      let step = 1;
      proc.stdout.on('data', d => {
        const text = d.toString();
        out += text;
        text.split('\n').forEach(line => {
          line = line.trim();
          if (!line || line.startsWith('#')) return;
          // Emit every meaningful line as its own message so user sees the log
          let msg = line, status = 'running';
          if (line === 'NEED_TAL_OPEN')                       { step = 2; msg = '⚠ Trade Activity Log is not open in Sierra Chart'; status = 'need_tal'; }
          else if (line.startsWith('Found:'))                { step = 2; msg = `✓ ${line}`; }
          else if (line.includes('Checking if TAL'))         { step = 2; msg = '⏳ Checking if Trade Activity Log is open…'; }
          else if (line.includes('Looking for Trade'))       { step = 2; msg = '⏳ Looking for Trade Activity Log…'; }
          else if (line.includes('TAL not open'))            { step = 2; msg = '⏳ TAL not open — trying to open it…'; }
          else if (line.includes('TAL focused') || line.includes('TAL opened'))  { step = 3; msg = `✓ ${line}`; }
          else if (line.includes('Triggering File'))         { step = 4; msg = '⏳ Triggering File → Export…'; }
          else if (line.includes('Setting save path'))       { step = 5; msg = '⏳ Setting save path and confirming…'; }
          else if (line.includes('Waiting for file'))        { step = 5; msg = `⏳ ${line} — waiting for file…`; }
          else if (line.includes('Detected:'))               { step = 6; msg = `✓ ${line}`; }
          else if (line.includes('Renaming'))                { step = 7; msg = `✓ ${line}`; }
          else if (line.startsWith('SUCCESS'))               { step = 8; msg = `✓ ${line}`; status = 'success'; }
          else if (line.startsWith('NEED_TAL') || line.startsWith('ERROR') || line.includes('ERROR:')) { status = 'error'; }
          emitProgress(step, msg, status);
        });
      });
      proc.stderr.on('data', d => {
        const text = d.toString().trim();
        out += text;
        if (text) {
          // stderr from PowerShell Write-Error — extract the actual message
          const clean = text.replace(/.*At .*\.ps1:\d+.*\n?/g, '').replace(/^\s*\+.*\n?/gm, '').trim();
          if (clean) emitProgress(step, `✕ ${clean}`, 'error');
        }
      });
      proc.on('close', code => {
        if (code !== 0 && !out.includes('SUCCESS')) reject(new Error(out.trim() || `Exit code ${code}`));
        else resolve(out);
      });
      proc.on('error', reject);
    });

    emitProgress(8, 'Export complete — importing trades...', 'success');
  } catch (err) {
    console.error('Export trigger error:', err.message);
    io.emit('sync-progress', { step: -1, message: err.message, status: 'error', timestamp: new Date() });
  }
});

// Start server with WebSocket support
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ['http://localhost:3000', 'http://127.0.0.1:3000'], methods: ['GET', 'POST'] }
});

// Initialize Sierra Chart watcher
const sierraWatcher = new SierraWatcher(io);
sierraWatcher.start();

// WebSocket handlers
io.on('connection', (socket) => {
  console.log('🔌 Dashboard connected:', socket.id);
  socket.emit('watcher-status', sierraWatcher.getStatus());
  socket.on('disconnect', () => console.log('🔌 Disconnected:', socket.id));
});

// ==================== CHART UPLOAD & AI ANALYSIS ====================

// GET all dates that have uploaded charts
app.get('/api/charts/dates', async (req, res) => {
  try {
    const result = await query(`SELECT log_date, analysis IS NOT NULL as analyzed FROM daily_charts ORDER BY log_date`);
    res.json(result.rows.map(r => ({ date: r.log_date, analyzed: r.analyzed })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET chart info for a date
app.get('/api/charts/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const result = await query(`SELECT * FROM daily_charts WHERE log_date = $1`, [date]);
    if (!result.rows.length) return res.json(null);
    const row = result.rows[0];
    res.json({ ...row, image_url: `/uploads/charts/${path.basename(row.image_path)}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST upload chart image for a date
app.post('/api/charts/:date/upload', chartUpload.single('chart'), async (req, res) => {
  try {
    const { date } = req.params;
    const { chart_type = 'daily' } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Remove old file if different extension
    const existing = await query(`SELECT image_path FROM daily_charts WHERE log_date = $1`, [date]);
    if (existing.rows.length && existing.rows[0].image_path !== req.file.path) {
      try { fs.unlinkSync(existing.rows[0].image_path); } catch(_) {}
    }

    await query(`
      INSERT INTO daily_charts (log_date, image_path, chart_type)
      VALUES ($1, $2, $3)
      ON CONFLICT (log_date) DO UPDATE SET image_path = $2, chart_type = $3, analysis = NULL, analyzed_at = NULL
    `, [date, req.file.path, chart_type]);

    res.json({ image_url: `/uploads/charts/${req.file.filename}`, chart_type });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST analyze chart with Claude
app.post('/api/charts/:date/analyze', async (req, res) => {
  try {
    const { date } = req.params;
    const { chart_type = 'daily', accounts = [] } = req.body;

    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in .env' });

    // Check monthly limit
    const MAX_CALLS = parseInt(process.env.MAX_MONTHLY_ANALYSES || '50');
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const callsThisMonth = await query(
      `SELECT COALESCE(SUM(api_calls),0) as total FROM daily_charts WHERE analyzed_at >= $1`, [monthStart]
    );
    if (parseInt(callsThisMonth.rows[0].total) >= MAX_CALLS) {
      return res.status(429).json({ error: `Monthly analysis limit (${MAX_CALLS}) reached. Increase MAX_MONTHLY_ANALYSES in .env to continue.` });
    }

    // Get chart image
    const chartRow = await query(`SELECT * FROM daily_charts WHERE log_date = $1`, [date]);
    if (!chartRow.rows.length) return res.status(404).json({ error: 'No chart uploaded for this date' });
    const imagePath = chartRow.rows[0].image_path;
    if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Image file not found on disk' });

    const imageData = fs.readFileSync(imagePath);
    const base64Image = imageData.toString('base64');
    const ext = path.extname(imagePath).toLowerCase().replace('.', '');
    const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

    let prompt;

    if (chart_type === 'weekly') {
      prompt = `You are helping a futures trader prepare for the upcoming trading week. They trade NQ (Nasdaq futures) micro contracts.

Attached is a longer-timeframe chart for weekly preparation. Please:
1. Identify key levels visible (support, resistance, value areas if volume profile is shown, POC, VAH, VAL)
2. Describe the current market structure (trending up/down, ranging, at key decision level, etc.)
3. Suggest 2-3 specific scenarios to watch for the coming week (e.g. "if price holds above X, look for Y")
4. Note any high-volume nodes or gaps that could act as magnets
Keep it focused and actionable — this is a pre-market planning tool, not a general market recap.`;
    } else {
      // Get trades per account for this date
      const parsePnl = `replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric`;
      const byAccount = await query(`
        SELECT
          custom_fields->>'account' as account,
          entry_time,
          exit_time as exit_et,
          symbol,
          direction,
          custom_fields->'sierra_data'->>'Max Open Quantity' as max_qty,
          SUM(${parsePnl}) as trade_pnl
        FROM trades
        WHERE log_date = $1
          AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
          AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
        GROUP BY custom_fields->>'account', entry_time, exit_time, symbol, direction, custom_fields->'sierra_data'->>'Max Open Quantity'
        ORDER BY custom_fields->>'account', exit_time
      `, [date]);

      // Group rows by account
      const accountMap = {};
      for (const row of byAccount.rows) {
        if (!accountMap[row.account]) accountMap[row.account] = [];
        accountMap[row.account].push(row);
      }

      const fmt = (dt) => new Date(dt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });

      // Build per-account trade lines
      const accountBlocks = Object.entries(accountMap).map(([acct, trades]) => {
        const total = trades.reduce((s, r) => s + parseFloat(r.trade_pnl), 0);
        const lines = trades.map((r, i) => {
          const pnl = parseFloat(r.trade_pnl);
          const dir = (r.direction || '').charAt(0).toUpperCase() + (r.direction || '').slice(1).toLowerCase();
          const qty = r.max_qty || r.quantity || '?';
          const entry = fmt(r.entry_time);
          const exit = fmt(r.exit_et);
          return `    Trade ${i+1}: ${entry}–${exit} ET | ${r.symbol} ${dir} qty:${qty} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
        }).join('\n');
        return `  Account ${acct} — Total: ${total >= 0 ? '+' : ''}$${total.toFixed(2)}\n${lines}`;
      }).join('\n\n');

      const grandTotal = byAccount.rows.reduce((s, r) => s + parseFloat(r.trade_pnl), 0);

      // Get prior analyses for context
      const priorAnalyses = await query(`
        SELECT log_date::text, LEFT(analysis, 300) as summary
        FROM daily_charts
        WHERE log_date < $1 AND analysis IS NOT NULL
        ORDER BY log_date DESC LIMIT 4
      `, [date]);

      const priorContext = priorAnalyses.rows.length
        ? '\n\nRecent prior day notes:\n' + priorAnalyses.rows.map(r => `${r.log_date}: ${r.summary}`).join('\n')
        : '';

      prompt = `You are reviewing a NQ (Nasdaq futures) trader's performance for ${date}.
Grand total P&L across all accounts: ${grandTotal >= 0 ? '+' : ''}$${grandTotal.toFixed(2)}

Trades by account (each trade is a flat-to-flat round trip, chronological):
${accountBlocks}
${priorContext}

Attached is the price action chart for this day. Begin your response with these two lines first, before any analysis. Use exactly this format, no extra words:
CHART_RANGE: 9:45 AM - 11:30 AM
PRICE_RANGE: 24800 - 25200

Then structure the rest as follows:

**Per-Account Review**
For each account, write a short section. If two or more accounts have identical exit times and matching P&Ls, note "Copytraded" and skip the individual breakdown — just say how the copytrade performed overall. Otherwise, group the account's trades into time clusters (trades within ~10 min of each other) and comment on what price was doing at that time on the chart, whether the trades made structural sense, and what went right or wrong.

**Overall Analysis**
Cover as many themes as you observe — patterns across accounts, whether the trader was on the right side of the market, where they left money on the table, or where they traded well. Be as detailed as the day warrants. Specific and chart-grounded only — no generic advice.

**Chart Verdict**
Step back and describe what kind of day this was from a pure price action perspective — was it trending, choppy, range-bound, news-driven, did it have a clear directional bias or fake both ways? Given how the chart actually played out, what was the highest-probability approach for this specific day (e.g. fade the open, buy the first pullback, stay flat until a level broke)? Then assess: did the trades taken align with that, and if not, what one adjustment would have made the biggest difference?

Be specific to what you see on the chart. Do not give generic trading advice.`;
    }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
          { type: 'text', text: prompt }
        ]
      }]
    });

    const raw = message.content[0].text;

    // Extract and strip axis metadata lines
    const chartRangeMatch = raw.match(/^CHART_RANGE:\s*(.+)$/m);
    const priceRangeMatch = raw.match(/^PRICE_RANGE:\s*(.+)$/m);
    const analysis = raw.replace(/^CHART_RANGE:.*$/m, '').replace(/^PRICE_RANGE:.*$/m, '').trim();

    let chartStart = null, chartEnd = null, priceLow = null, priceHigh = null;
    if (chartRangeMatch) {
      // Extract all time patterns like "9:30 AM" from the value — take first and last
      const times = [...chartRangeMatch[1].matchAll(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/gi)];
      if (times.length >= 2) { chartStart = times[0][1].trim(); chartEnd = times[times.length - 1][1].trim(); }
      else if (times.length === 1) { chartStart = times[0][1].trim(); }
    }
    if (priceRangeMatch) {
      const nums = [...priceRangeMatch[1].matchAll(/[\d,]+/g)].map(m => parseFloat(m[0].replace(/,/g, '')));
      if (nums.length >= 2) { priceLow = Math.min(...nums); priceHigh = Math.max(...nums); }
    }

    await query(`
      UPDATE daily_charts SET analysis = $1, analyzed_at = NOW(), api_calls = api_calls + 1,
        chart_start = $3, chart_end = $4, chart_price_low = $5, chart_price_high = $6
      WHERE log_date = $2
    `, [analysis, date, chartStart, chartEnd, priceLow, priceHigh]);

    res.json({ analysis, analyzed_at: new Date(), chart_start: chartStart, chart_end: chartEnd, chart_price_low: priceLow, chart_price_high: priceHigh });
  } catch(e) {
    console.error('Chart analysis error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE chart for a date
app.delete('/api/charts/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const existing = await query(`SELECT image_path FROM daily_charts WHERE log_date = $1`, [date]);
    if (existing.rows.length) {
      try { fs.unlinkSync(existing.rows[0].image_path); } catch(_) {}
      await query(`DELETE FROM daily_charts WHERE log_date = $1`, [date]);
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stats/optimization
// Returns MFE/MAE per trade, time-of-day breakdown, VWAP context
app.get('/api/stats/optimization', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);

    // Fetch trades with price data + bars for MFE/MAE via lateral join
    const tradesRes = await query(`
      SELECT
        t.id, t.log_date, t.direction,
        t.entry_price::numeric  AS entry_price,
        t.exit_price::numeric   AS exit_price,
        t.pnl::numeric          AS pnl,
        t.symbol,
        EXTRACT(HOUR FROM t.entry_time)   AS entry_hour,
        EXTRACT(DOW  FROM t.entry_time)   AS entry_dow,
        EXTRACT(EPOCH FROM (t.exit_time - t.entry_time)) / 60 AS duration_mins,
        pb.max_high, pb.min_low,
        -- VWAP at entry: cumulative from 09:30 EST same day up to entry_time
        vw.vwap_at_entry
      FROM trades t
      LEFT JOIN LATERAL (
        SELECT MAX(high::numeric) AS max_high, MIN(low::numeric) AS min_low
        FROM price_bars
        WHERE symbol = CASE regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '')
            WHEN 'MNQ' THEN 'NQ' WHEN 'MES' THEN 'ES' WHEN 'M2K' THEN 'RTY'
            ELSE regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '') END
          AND ts >= date_trunc('minute', t.entry_time)
          AND ts <= date_trunc('minute', t.exit_time) + interval '1 minute'
      ) pb ON true
      LEFT JOIN LATERAL (
        SELECT
          SUM((high::numeric + low::numeric + close::numeric) / 3 * volume::numeric)
            / NULLIF(SUM(volume::numeric), 0) AS vwap_at_entry
        FROM price_bars
        WHERE symbol = CASE regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '')
            WHEN 'MNQ' THEN 'NQ' WHEN 'MES' THEN 'ES' WHEN 'M2K' THEN 'RTY'
            ELSE regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '') END
          AND ts >= (t.entry_time::date + time '09:30:00')
          AND ts <= t.entry_time
      ) vw ON true
      WHERE ${where}
        AND t.entry_price IS NOT NULL
        AND t.exit_price  IS NOT NULL
        AND t.direction   IS NOT NULL
      ORDER BY t.entry_time ASC
    `, params);

    const trades = tradesRes.rows;
    if (!trades.length) return res.json({ trades: [], byHour: [], summary: null });

    // Compute MFE/MAE in points per trade
    const enriched = trades.map(t => {
      const ep   = parseFloat(t.entry_price);
      const xp   = parseFloat(t.exit_price);
      const high = t.max_high != null ? parseFloat(t.max_high) : null;
      const low  = t.min_low  != null ? parseFloat(t.min_low)  : null;
      const pnl  = parseFloat(t.pnl);
      const isLong = t.direction?.toUpperCase() === 'LONG';

      const mfe = high != null && low != null
        ? (isLong ? high - ep : ep - low)
        : null;
      const mae = high != null && low != null
        ? (isLong ? ep - low : high - ep)
        : null;
      const actual_pts = isLong ? xp - ep : ep - xp;
      const mfe_capture = mfe != null && mfe > 0 ? actual_pts / mfe : null;
      const vwap = t.vwap_at_entry != null ? parseFloat(t.vwap_at_entry) : null;
      const vwap_relation = vwap != null
        ? (isLong ? (ep >= vwap ? 'with_trend' : 'counter_trend')
                  : (ep <= vwap ? 'with_trend' : 'counter_trend'))
        : null;

      return {
        id: t.id, log_date: t.log_date, direction: t.direction,
        entry_hour: parseInt(t.entry_hour), entry_dow: parseInt(t.entry_dow),
        duration_mins: Math.round(parseFloat(t.duration_mins) || 0),
        pnl, actual_pts: +actual_pts.toFixed(2),
        mfe: mfe != null ? +mfe.toFixed(2) : null,
        mae: mae != null ? +mae.toFixed(2) : null,
        mfe_capture: mfe_capture != null ? +mfe_capture.toFixed(3) : null,
        vwap_relation,
      };
    });

    // Overall summary
    const withBars = enriched.filter(t => t.mfe != null);
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const pct = (arr, p) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(p / 100 * s.length)];
    };
    const mfes = withBars.map(t => t.mfe);
    const maes = withBars.map(t => t.mae);
    const captures = withBars.filter(t => t.mfe_capture != null).map(t => t.mfe_capture);
    const wins  = enriched.filter(t => t.pnl > 0);
    const losses = enriched.filter(t => t.pnl < 0);

    // MAE of winning trades — where do winners dip before recovering?
    const winMaes  = wins.filter(t => t.mae != null).map(t => t.mae);
    // MAE of losing trades — how far did they go before being stopped
    const lossMaes = losses.filter(t => t.mae != null).map(t => t.mae);

    const summary = {
      tradeCount:    enriched.length,
      withBarsCount: withBars.length,
      avgMfe:        avg(mfes) != null ? +avg(mfes).toFixed(2) : null,
      avgMae:        avg(maes) != null ? +avg(maes).toFixed(2) : null,
      avgActualPts:  +avg(enriched.map(t => t.actual_pts)).toFixed(2),
      avgMfeCapture: captures.length ? +(avg(captures) * 100).toFixed(1) : null,
      mfe_p50:       pct(mfes, 50) != null ? +pct(mfes, 50).toFixed(2) : null,
      mfe_p75:       pct(mfes, 75) != null ? +pct(mfes, 75).toFixed(2) : null,
      mae_p50:       pct(maes, 50) != null ? +pct(maes, 50).toFixed(2) : null,
      mae_p75:       pct(maes, 75) != null ? +pct(maes, 75).toFixed(2) : null,
      winMae_p50:    pct(winMaes, 50) != null ? +pct(winMaes, 50).toFixed(2) : null,
      winMae_p75:    pct(winMaes, 75) != null ? +pct(winMaes, 75).toFixed(2) : null,
      // Suggested TP: 75th pct of MFE (captures more of typical winner)
      suggestedTp:   pct(mfes, 75) != null ? +pct(mfes, 75).toFixed(2) : null,
      // Suggested stop: just beyond 75th pct MAE of winning trades (avoids stopping out winners)
      suggestedStop: pct(winMaes, 75) != null ? +pct(winMaes, 75).toFixed(2) : null,
    };

    // Time-of-day breakdown (by hour)
    const byHourMap = {};
    for (const t of enriched) {
      const h = t.entry_hour;
      if (!byHourMap[h]) byHourMap[h] = { hour: h, count: 0, wins: 0, pnls: [], mfes: [], maes: [], winMfes: [], winMaes: [] };
      byHourMap[h].count++;
      if (t.pnl > 0) {
        byHourMap[h].wins++;
        if (t.mfe != null) byHourMap[h].winMfes.push(t.mfe);
        if (t.mae != null) byHourMap[h].winMaes.push(Math.abs(t.mae));
      }
      byHourMap[h].pnls.push(t.pnl);
      if (t.mfe != null) byHourMap[h].mfes.push(t.mfe);
      if (t.mae != null) byHourMap[h].maes.push(t.mae);
    }
    const byHour = Object.values(byHourMap).map(h => ({
      hour: h.hour,
      count: h.count,
      win_rate: +(h.wins / h.count * 100).toFixed(1),
      avg_pnl:  +(h.pnls.reduce((a, b) => a + b, 0) / h.count).toFixed(2),
      avg_mfe:  h.mfes.length ? +(h.mfes.reduce((a, b) => a + b, 0) / h.mfes.length).toFixed(2) : null,
      avg_mae:  h.maes.length ? +(h.maes.reduce((a, b) => a + b, 0) / h.maes.length).toFixed(2) : null,
      mfe_p75:  h.winMfes.length ? +(pct(h.winMfes, 75) ?? 0).toFixed(1) : null,
      mae_p75:  h.winMaes.length ? +(pct(h.winMaes, 75) ?? 0).toFixed(1) : null,
    })).sort((a, b) => a.hour - b.hour);

    // VWAP context breakdown
    const vwapGroups = { with_trend: { count:0, wins:0, pnls:[] }, counter_trend: { count:0, wins:0, pnls:[] } };
    for (const t of enriched.filter(t => t.vwap_relation)) {
      const g = vwapGroups[t.vwap_relation];
      g.count++; if (t.pnl > 0) g.wins++; g.pnls.push(t.pnl);
    }
    const byVwap = Object.entries(vwapGroups)
      .filter(([, g]) => g.count > 0)
      .map(([key, g]) => ({
        label: key === 'with_trend' ? 'With VWAP Trend' : 'Counter VWAP',
        count: g.count,
        win_rate: +(g.wins / g.count * 100).toFixed(1),
        avg_pnl:  +(g.pnls.reduce((a, b) => a + b, 0) / g.count).toFixed(2),
      }));

    // Distribution buckets for MFE and MAE
    const mfeBuckets = [0, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200];
    const maeBuckets = [0, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200];

    const buildDist = (values, buckets) => {
      const counts = Array(buckets.length).fill(0);
      for (const v of values) {
        const absV = Math.abs(v);
        let i = buckets.length - 1;
        while (i > 0 && absV < buckets[i]) i--;
        counts[i]++;
      }
      return buckets.map((b, i) => ({
        label: i === buckets.length - 1 ? `${b}+` : `${b}–${buckets[i + 1]}`,
        count: counts[i],
        pct: values.length ? +(counts[i] / values.length * 100).toFixed(1) : 0,
      }));
    };

    const mfeDist  = buildDist(mfes, mfeBuckets);
    const maeDist  = buildDist(maes, maeBuckets);
    const winMaeDist = buildDist(winMaes, maeBuckets);

    res.json({ summary, byHour, byVwap, mfeDist, maeDist, winMaeDist, trades: enriched });
  } catch (err) {
    console.error('Optimization error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/trade-location
// For each RTH trade, builds the volume profile up to entry time and classifies
// entry location relative to HVNs, LVNs, POC, VAH, VAL
app.get('/api/stats/trade-location', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);

    // Get RTH trades with entry info, mapping micro contracts to full contracts
    const tradesRes = await query(`
      SELECT t.id, t.log_date, t.direction,
             t.entry_price::numeric AS entry_price,
             t.pnl::numeric AS pnl,
             t.symbol, t.entry_time,
             CASE regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '')
               WHEN 'MNQ' THEN 'NQ' WHEN 'MES' THEN 'ES'
               ELSE regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '') END AS bar_symbol
      FROM trades t
      WHERE ${where}
        AND t.entry_price IS NOT NULL
        AND t.entry_time IS NOT NULL
        AND t.direction IS NOT NULL
        AND regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '') IN ('NQ','MNQ','ES','MES')
      ORDER BY t.log_date ASC, t.entry_time ASC
    `, params);

    const trades = tradesRes.rows;
    if (!trades.length) return res.json({ trades: [], byLocation: [] });

    const TICK = 0.25;
    const round = p => Math.round(p / TICK) * TICK;

    // Group trades by (date, bar_symbol)
    const groups = {};
    for (const t of trades) {
      const key = `${t.log_date}|${t.bar_symbol}`;
      if (!groups[key]) groups[key] = { date: t.log_date, barSymbol: t.bar_symbol, trades: [] };
      groups[key].trades.push(t);
    }

    const results = [];

    for (const { date, barSymbol, trades: dayTrades } of Object.values(groups)) {
      // Fetch all RTH bars for this date (raw CT time comparison)
      const barsRes = await query(`
        SELECT ts, high::numeric AS high, low::numeric AS low, volume::numeric AS volume
        FROM price_bars
        WHERE symbol = $1
          AND ts >= ($2::date + time '09:30:00')
          AND ts <  ($2::date + time '16:15:00')
        ORDER BY ts ASC
      `, [barSymbol, date]);

      const bars = barsRes.rows;
      const volMap = {};  // price_level → cumulative volume
      let barIdx = 0;

      for (const trade of dayTrades) {
        const entryTime = new Date(trade.entry_time);

        // Advance bars up to (but not including) the entry minute
        while (barIdx < bars.length && new Date(bars[barIdx].ts) <= entryTime) {
          const bar = bars[barIdx];
          const h = parseFloat(bar.high), l = parseFloat(bar.low), v = parseFloat(bar.volume);
          const levels = Math.max(1, Math.round((h - l) / TICK) + 1);
          const vpl = v / levels;
          for (let p = l; p <= h + TICK / 2; p += TICK) {
            const lvl = round(p);
            volMap[lvl] = (volMap[lvl] || 0) + vpl;
          }
          barIdx++;
        }

        const entries = Object.entries(volMap);
        if (entries.length < 5) continue;  // not enough profile to classify

        const levels = entries.map(([p, v]) => ({ price: parseFloat(p), volume: v }))
                               .sort((a, b) => a.price - b.price);
        const maxVol   = Math.max(...levels.map(l => l.volume));
        const totalVol = levels.reduce((s, l) => s + l.volume, 0);

        // POC
        const poc = levels.reduce((best, l) => l.volume > best.volume ? l : best).price;
        const pocIdx = levels.findIndex(l => Math.abs(l.price - poc) < TICK / 2);

        // Value area — bidirectional expansion from POC to 70%
        let vaVol = levels[pocIdx]?.volume || 0;
        let upI = pocIdx + 1, dnI = pocIdx - 1;
        while (vaVol < totalVol * 0.70 && (upI < levels.length || dnI >= 0)) {
          const upAdd = upI < levels.length ? levels[upI].volume : 0;
          const dnAdd = dnI >= 0          ? levels[dnI].volume : 0;
          if (upAdd >= dnAdd && upI < levels.length) { vaVol += upAdd; upI++; }
          else if (dnI >= 0)                          { vaVol += dnAdd; dnI--; }
          else                                        { vaVol += upAdd; upI++; }
        }
        const vah = levels[upI - 1]?.price ?? poc;
        const val = levels[dnI + 1]?.price ?? poc;

        // HVN / LVN thresholds
        const hvnThresh = maxVol * 0.70;
        const lvnThresh = maxVol * 0.20;
        const hvns = levels.filter(l => l.volume >= hvnThresh).map(l => l.price);
        const lvns = levels.filter(l => l.volume > 0 && l.volume <= lvnThresh).map(l => l.price);

        const nearest  = (arr, p) => arr.length ? arr.reduce((b, x) => Math.abs(x - p) < Math.abs(b - p) ? x : b) : null;
        const ep       = parseFloat(trade.entry_price);
        const epLevel  = round(ep);
        const epVolPct = (volMap[epLevel] || 0) / maxVol;

        const nearestHvn = nearest(hvns, ep);
        const nearestLvn = nearest(lvns, ep);
        const PROX = 5;

        // Classify
        let location;
        if (Math.abs(ep - poc)     <= PROX) location = 'At POC';
        else if (Math.abs(ep - vah) <= PROX) location = 'At VAH';
        else if (Math.abs(ep - val) <= PROX) location = 'At VAL';
        else if (epVolPct <= 0.20 && nearestLvn != null && Math.abs(ep - nearestLvn) <= 3) location = 'In LVN';
        else if (epVolPct >= 0.70 && nearestHvn != null && Math.abs(ep - nearestHvn) <= PROX) location = 'At HVN';
        else if (ep > vah)        location = 'Above VAH';
        else if (ep < val)        location = 'Below VAL';
        else                      location = 'In Value Area';

        // Direction-aware assessment
        const isLong = trade.direction?.toUpperCase() === 'LONG';
        const hvnsAbove = hvns.filter(h => h > ep);
        const hvnsBelow = hvns.filter(h => h < ep);
        const nextHvn   = isLong
          ? (hvnsAbove.length ? Math.min(...hvnsAbove) : null)
          : (hvnsBelow.length ? Math.max(...hvnsBelow) : null);

        let assessment, quality;
        if (location === 'In LVN') {
          const dist = nextHvn ? Math.abs(ep - nextHvn).toFixed(1) : null;
          assessment = dist
            ? `Fast-travel zone — next HVN target at ${nextHvn} (${dist} pts)`
            : 'Fast-travel zone — no clear HVN target above';
          quality = 'neutral';  // depends on direction confirmation
        } else if (location === 'At HVN') {
          quality = isLong ? 'good' : 'good';
          assessment = isLong
            ? 'Buying at institutional support — favorable if HVN holds'
            : 'Selling at institutional supply — favorable if resistance holds';
        } else if (location === 'At VAH') {
          quality = isLong ? 'poor' : 'good';
          assessment = isLong
            ? 'Buying at resistance — unfavorable unless breakout confirmed'
            : 'Selling resistance — good mean-reversion setup toward POC/VAL';
        } else if (location === 'At VAL') {
          quality = isLong ? 'good' : 'poor';
          assessment = isLong
            ? 'Buying support — good mean-reversion setup toward POC/VAH'
            : 'Selling at support — unfavorable unless breakdown confirmed';
        } else if (location === 'At POC') {
          quality = 'neutral';
          assessment = 'At fair value — expect two-sided trade, no clear edge';
        } else if (location === 'Above VAH') {
          quality = isLong ? 'neutral' : 'poor';
          assessment = isLong
            ? 'Above value — potential breakout continuation'
            : 'Shorting above value — fading breakout, high risk';
        } else if (location === 'Below VAL') {
          quality = isLong ? 'poor' : 'neutral';
          assessment = isLong
            ? 'Buying a breakdown — high risk'
            : 'Below value — potential continuation short';
        } else {
          quality = 'neutral';
          assessment = `Inside value area — ${isLong ? 'long' : 'short'} between VAL and VAH`;
        }

        results.push({
          id: trade.id,
          log_date: trade.log_date,
          direction: trade.direction?.toUpperCase(),
          entry_price: ep,
          pnl: parseFloat(trade.pnl),
          location,
          quality,
          assessment,
          poc: +poc.toFixed(2),
          vah: +vah.toFixed(2),
          val: +val.toFixed(2),
          nearestHvn,
          nearestLvn,
          entryVolPct: +(epVolPct * 100).toFixed(1),
          nextHvnTarget: nextHvn,
        });
      }
    }

    // Aggregate by location
    const locMap = {};
    for (const t of results) {
      if (!locMap[t.location]) locMap[t.location] = { location: t.location, quality: t.quality, count: 0, wins: 0, pnls: [] };
      const g = locMap[t.location];
      g.count++;
      if (t.pnl > 0) g.wins++;
      g.pnls.push(t.pnl);
    }
    const byLocation = Object.values(locMap).map(g => ({
      location: g.location,
      quality: g.quality,
      count: g.count,
      win_rate: +(g.wins / g.count * 100).toFixed(1),
      avg_pnl: +(g.pnls.reduce((a, b) => a + b, 0) / g.count).toFixed(2),
      total_pnl: +(g.pnls.reduce((a, b) => a + b, 0)).toFixed(2),
    })).sort((a, b) => b.count - a.count);

    res.json({ trades: results, byLocation });
  } catch (err) {
    console.error('Trade location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Key Level Analysis ────────────────────────────────────────────────────
// Computes IB High/Low, Opening 5-min Mid, Prior Day VA, Prior Week VA, RTH VWAP
// for each trading date, then measures:
//   1) How often price respected each level (all RTH bars)
//   2) Win rate / avg P&L when YOUR trades were entered near each level
app.get('/api/stats/key-levels', async (req, res) => {
  try {
    const { account, dateFrom, dateTo, prox: proxStr,
            nl30State, openingCall, sessionDirection } = req.query;
    const PROX = Math.max(0.25, Math.min(50, parseFloat(proxStr) || 2.5));

    // Filters are passed through — do not cache filtered results (sample sizes too small)
    const hasFilters = !!(nl30State || openingCall || sessionDirection);
    const cacheKey = `kl|${dateFrom||''}|${dateTo||''}|${PROX}|${account||''}`;
    if (!hasFilters) {
      const cached = cacheGet(cacheKey);
      if (cached) { console.log(`[cache hit] key-levels ${cacheKey}`); return res.json(cached); }
    }

    const params = [];
    let where = `WHERE t.entry_price IS NOT NULL AND t.exit_price IS NOT NULL
                   AND t.direction IS NOT NULL
                   AND regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '') IN ('NQ','MNQ','ES','MES')`;
    if (dateFrom) { params.push(dateFrom); where += ` AND t.log_date >= $${params.length}`; }
    if (dateTo)   { params.push(dateTo);   where += ` AND t.log_date <= $${params.length}`; }
    if (account) {
      const accs = account.split(',').filter(Boolean);
      if (accs.length) { params.push(accs); where += ` AND t.custom_fields->>'account' = ANY($${params.length})`; }
    }

    const tradesRes = await query(`
      SELECT t.id, t.log_date, t.direction,
             t.entry_price::numeric AS entry_price,
             t.pnl::numeric AS pnl,
             t.entry_time,
             regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '') AS root_symbol
      FROM trades t
      ${where}
      ORDER BY t.log_date ASC, t.entry_time ASC
    `, params);

    if (!tradesRes.rows.length) return res.json({ byLevel: [], summary: null });

    const tradeDates = [...new Set(tradesRes.rows.map(r => r.log_date))].sort();

    // Bar scan range: use requested dateFrom/dateTo so different timeframes yield
    // different touch/respect stats. When "All Time" (no params), scan from the
    // first trade date to today, which gives the widest available dataset.
    const today = new Date().toISOString().split('T')[0];
    const barRangeFrom = dateFrom || tradeDates[0];
    const barRangeTo   = dateTo   || today;

    // Build session metadata — always loaded (needed for condition breakdowns + filtering)
    // Uses bulk queries instead of per-date queries for performance
    const sessionMeta = {};

    // NL30 per date via window function
    const nl30BulkQ = await query(`
      SELECT trade_date::text as d,
        SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30
      FROM acd_daily_log WHERE daily_score IS NOT NULL
    `);
    const nl30Map = {};
    for (const r of nl30BulkQ.rows) nl30Map[r.d] = parseInt(r.nl30) || 0;

    // Opening calls per date
    const ocBulkQ = await query(`SELECT trade_date::text as d, opening_call_type as oc FROM auction_reads WHERE opening_call_type IS NOT NULL`);
    const ocMap = {};
    for (const r of ocBulkQ.rows) ocMap[r.d] = r.oc;

    // Confluence scores per date
    const confBulkQ = await query(`SELECT trade_date::text as d, COALESCE(confluence_score_peak, confluence_score_pre) as score FROM daily_performance_log`);
    const confMap = {};
    for (const r of confBulkQ.rows) if (r.score != null) confMap[r.d] = parseInt(r.score);

    // Session direction will be derived during bar scan (open/close per day already available)
    const sessDirectionMap = {};

    // Populate sessionMeta for each bar-scan date (direction computed after bar load below)
    // After bar load, we fill sessDirectionMap and build sessionMeta

    // Extend look-back 14 days for prior-week VA computation
    const extFrom = new Date(barRangeFrom);
    extFrom.setDate(extFrom.getDate() - 14);
    const extFromStr = extFrom.toISOString().split('T')[0];

    // Fetch all RTH 1-min bars for the extended range (NQ bars cover MNQ too)
    const barsRes = await query(`
      SELECT date(ts) AS bar_date, ts,
             open::numeric AS open, high::numeric AS high,
             low::numeric AS low, close::numeric AS close,
             volume::integer AS volume
      FROM price_bars
      WHERE symbol = 'NQ'
        AND ts >= $1::date
        AND ts <  ($2::date + interval '1 day')
        AND (
          (EXTRACT(HOUR FROM ts) = 9  AND EXTRACT(MINUTE FROM ts) >= 30) OR
          (EXTRACT(HOUR FROM ts) > 9  AND EXTRACT(HOUR FROM ts) < 16)
        )
      ORDER BY ts ASC
    `, [extFromStr, barRangeTo]);

    // Fetch overnight bars (non-RTH) only for the actual scan range — just need high/low
    const onBarsRes = await query(`
      SELECT date(ts) AS bar_date, ts,
             high::numeric AS high, low::numeric AS low
      FROM price_bars
      WHERE symbol = 'NQ'
        AND ts >= $1::date
        AND ts <  ($2::date + interval '1 day')
        AND NOT (
          (EXTRACT(HOUR FROM ts) = 9  AND EXTRACT(MINUTE FROM ts) >= 30) OR
          (EXTRACT(HOUR FROM ts) > 9  AND EXTRACT(HOUR FROM ts) < 16)
        )
      ORDER BY ts ASC
    `, [extFromStr, barRangeTo]);

    // Group bars by date string
    const barsByDate = {};
    for (const b of barsRes.rows) {
      const d = b.bar_date;
      if (!barsByDate[d]) barsByDate[d] = [];
      barsByDate[d].push(b);
    }

    // Group overnight bars: evening bars (hour >= 16) attach to NEXT trading day's overnight;
    // pre-market bars (hour < 9:30) attach to same calendar day's trading session.
    const onBarsByTradingDate = {};
    for (const b of onBarsRes.rows) {
      const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes();
      const calDate = b.bar_date;
      if (h >= 16) {
        // Evening bar: belongs to the NEXT trading day's overnight
        // We'll assign it after allBarDates is built
        if (!onBarsByTradingDate['__eve__' + calDate]) onBarsByTradingDate['__eve__' + calDate] = [];
        onBarsByTradingDate['__eve__' + calDate].push(b);
      } else {
        // Pre-market bar (midnight–9:29): belongs to same calendar day
        if (!onBarsByTradingDate[calDate]) onBarsByTradingDate[calDate] = [];
        onBarsByTradingDate[calDate].push(b);
      }
    }
    const allBarDates = Object.keys(barsByDate).sort();

    // Resolve evening bars → next trading day
    for (const key of Object.keys(onBarsByTradingDate)) {
      if (!key.startsWith('__eve__')) continue;
      const calDate = key.slice(7);
      const idx = allBarDates.indexOf(calDate);
      if (idx >= 0 && idx < allBarDates.length - 1) {
        const nextTD = allBarDates[idx + 1];
        if (!onBarsByTradingDate[nextTD]) onBarsByTradingDate[nextTD] = [];
        onBarsByTradingDate[nextTD].push(...onBarsByTradingDate[key]);
      }
      delete onBarsByTradingDate[key];
    }

    // Dates used for touch/respect scanning: all RTH trading days in the requested range
    const barScanDates = allBarDates.filter(d => d >= barRangeFrom && d <= barRangeTo);

    // ── Volume profile helpers ─────────────────────────────────────────────
    const TICK = 0.25;
    const rnd = p => Math.round(p / TICK) * TICK;

    const buildVP = (bars) => {
      if (!bars.length) return null;
      const volMap = {};
      let totalVol = 0;
      for (const b of bars) {
        const h = b.high, l = b.low, v = b.volume || 0;
        if (!v) continue;
        const lo = rnd(l), hi = rnd(h);
        const steps = Math.round((hi - lo) / TICK) + 1;
        const vpL = v / steps;
        for (let i = 0; i < steps; i++) {
          const p = rnd(lo + i * TICK);
          volMap[p] = (volMap[p] || 0) + vpL;
          totalVol += vpL;
        }
      }
      if (!totalVol) return null;

      const levels = Object.entries(volMap)
        .map(([p, v]) => ({ price: +p, volume: v }))
        .sort((a, b) => a.price - b.price);

      const poc = levels.reduce((m, l) => l.volume > m.volume ? l : m, levels[0]);
      const pocIdx = levels.findIndex(l => Math.abs(l.price - poc.price) < TICK / 2);

      let vaVol = poc.volume, upI = pocIdx + 1, dnI = pocIdx - 1;
      const target = totalVol * 0.70;
      while (vaVol < target) {
        const up = upI < levels.length ? levels[upI].volume : 0;
        const dn = dnI >= 0          ? levels[dnI].volume : 0;
        if (up >= dn && upI < levels.length)      { vaVol += up; upI++; }
        else if (dnI >= 0)                         { vaVol += dn; dnI--; }
        else if (upI < levels.length)              { vaVol += up; upI++; }
        else break;
      }

      const vah = levels[Math.min(upI - 1, levels.length - 1)]?.price ?? poc.price;
      const val = levels[Math.max(dnI + 1, 0)]?.price ?? poc.price;
      return { poc: poc.price, vah, val };
    };

    // ── Compute static levels for each bar date in the scan range ─────────
    const levelsByDate = {};

    for (const date of barScanDates) {
      const bars = barsByDate[date] || [];

      // IB = first hour: 9:30 through 10:29
      const ibBars = bars.filter(b => {
        const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes();
        return (h === 9 && m >= 30) || (h === 10 && m <= 29);
      });
      const ibHigh = ibBars.length ? Math.max(...ibBars.map(b => +b.high)) : null;
      const ibLow  = ibBars.length ? Math.min(...ibBars.map(b => +b.low))  : null;
      const ibRange = ibHigh != null ? ibHigh - ibLow : null;

      // Opening 5-min midpoint: 9:30–9:34
      const o5Bars = bars.filter(b => {
        const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes();
        return h === 9 && m >= 30 && m <= 34;
      });
      const o5H = o5Bars.length ? Math.max(...o5Bars.map(b => +b.high)) : null;
      const o5L = o5Bars.length ? Math.min(...o5Bars.map(b => +b.low))  : null;
      const open5Mid = o5H != null ? +((o5H + o5L) / 2).toFixed(2) : null;

      // Prior day VP
      const dateIdx = allBarDates.indexOf(date);
      const prevDayBars = dateIdx > 0 ? (barsByDate[allBarDates[dateIdx - 1]] || []) : [];
      const pdVP = buildVP(prevDayBars);

      // Prior week VP: Mon–Fri of the calendar week before current date's week
      // Use UTC dates since bar_date strings are CT dates (no timezone shift)
      const [yr, mo, dy] = date.split('-').map(Number);
      const d = new Date(Date.UTC(yr, mo - 1, dy));
      const dow = d.getUTCDay(); // 0=Sun … 6=Sat
      const daysToMon = dow === 0 ? 6 : dow - 1;
      const thisMonday = new Date(Date.UTC(yr, mo - 1, dy - daysToMon));
      const prevWeekFri = new Date(thisMonday.getTime() - 86400000 * 3); // Fri = Mon-3
      const prevWeekMon = new Date(thisMonday.getTime() - 86400000 * 7); // Mon-7
      const pwStart = prevWeekMon.toISOString().split('T')[0];
      const pwEnd   = prevWeekFri.toISOString().split('T')[0];

      const prevWeekBars = allBarDates
        .filter(bd => bd >= pwStart && bd <= pwEnd)
        .flatMap(bd => barsByDate[bd] || []);
      const pwVP = buildVP(prevWeekBars);

      // Prior week high/low (structural swing levels, independent of volume profile)
      const pwHigh = prevWeekBars.length ? Math.max(...prevWeekBars.map(b => +b.high)) : null;
      const pwLow  = prevWeekBars.length ? Math.min(...prevWeekBars.map(b => +b.low))  : null;

      // Prior day VWAP (cumulative VWAP at prior session close — institutional carry-over)
      const pdVwap = (() => {
        if (!prevDayBars.length) return null;
        let cpv = 0, cv = 0;
        for (const b of prevDayBars) {
          const tp = (+b.high + +b.low + +b.close) / 3, v = b.volume || 0;
          cpv += tp * v; cv += v;
        }
        return cv > 0 ? +(cpv / cv).toFixed(2) : null;
      })();

      const onBarsForDate = onBarsByTradingDate[date] || [];
      const onHigh = onBarsForDate.length ? Math.max(...onBarsForDate.map(b => +b.high)) : null;
      const onLow  = onBarsForDate.length ? Math.min(...onBarsForDate.map(b => +b.low))  : null;

      // Session direction (used for condition breakdown)
      const sessOpen  = bars.length > 0 ? +bars[0].open : null;
      const sessClose = bars.length > 0 ? +bars[bars.length - 1].close : null;
      if (sessOpen && sessClose) {
        const diff = sessClose - sessOpen;
        sessDirectionMap[date] = diff > 20 ? 'UP' : diff < -20 ? 'DOWN' : 'RANGE';
      }

      levelsByDate[date] = {
        ibHigh, ibLow, ibRange, open5Mid,
        pdVAH: pdVP?.vah ?? null, pdVAL: pdVP?.val ?? null, pdPOC: pdVP?.poc ?? null,
        pwVAH: pwVP?.vah ?? null, pwVAL: pwVP?.val ?? null, pwPOC: pwVP?.poc ?? null,
        pwHigh, pwLow, pdVwap,
        onHigh, onLow,
        rthBars: bars,
      };
    }

    // Populate sessionMeta for all scan dates
    for (const date of barScanDates) {
      const nl30 = nl30Map[date] ?? 0;
      sessionMeta[date] = {
        nl30: nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING',
        openingCall: ocMap[date] || null,
        sessionDirection: sessDirectionMap[date] || null,
        confluenceScore: confMap[date] ?? null,
      };
    }

    // ── Level definitions ──────────────────────────────────────────────────
    const LEVEL_DEFS = [
      { key: 'ibh',    label: 'IB High',          get: l => l.ibHigh,  ibOnly: true },
      { key: 'ibl',    label: 'IB Low',            get: l => l.ibLow,   ibOnly: true },
      { key: 'ibhExt', label: 'IB High +1×Range',  get: l => l.ibHigh != null ? l.ibHigh + l.ibRange : null, ibOnly: true },
      { key: 'iblExt', label: 'IB Low −1×Range',   get: l => l.ibLow  != null ? l.ibLow  - l.ibRange : null, ibOnly: true },
      { key: 'open5',  label: 'Opening 5-min Mid', get: l => l.open5Mid },
      { key: 'pdvah',  label: 'Prior Day VAH',     get: l => l.pdVAH },
      { key: 'pdval',  label: 'Prior Day VAL',     get: l => l.pdVAL },
      { key: 'pdpoc',  label: 'Prior Day POC',     get: l => l.pdPOC },
      { key: 'pwvah',  label: 'Prior Week VAH',    get: l => l.pwVAH },
      { key: 'pwval',  label: 'Prior Week VAL',    get: l => l.pwVAL },
      { key: 'pwhigh', label: 'Prior Week High',   get: l => l.pwHigh },
      { key: 'pwlow',  label: 'Prior Week Low',    get: l => l.pwLow  },
      { key: 'pdvwap', label: 'Prior Day VWAP',    get: l => l.pdVwap },
      { key: 'onhigh', label: 'Overnight High',    get: l => l.onHigh },
      { key: 'onlow',  label: 'Overnight Low',     get: l => l.onLow  },
    ];

    // PROX defined above from query param
    const LOOKAHEAD  = 15;    // bars to look forward when checking if level held (respect check)
    const MFE_BARS   = 60;    // bars to look forward for MFE/MAE analysis (1 hour)
    const MIN_BOUNCE = PROX;  // price must move at least this far in the right direction to count as respected

    // Percentile helper
    const pct = (arr, p) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const idx = (p / 100) * (s.length - 1);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      return lo === hi ? +s[lo].toFixed(2) : +(s[lo] + (s[hi] - s[lo]) * (idx - lo)).toFixed(2);
    };

    // Per-touch event collection for MFE/MAE analysis
    const touchEvents = {};
    for (const ld of LEVEL_DEFS) touchEvents[ld.key] = { support: [], resistance: [] };
    touchEvents['vwap'] = { support: [], resistance: [] };

    // Normal CDF approximation (Abramowitz & Stegun) for p-value calculation
    const normCDF = (z) => {
      const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
      const s=z<0?-1:1, x=Math.abs(z)/Math.SQRT2;
      const t=1/(1+p*x);
      const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
      return 0.5*(1+s*y);
    };
    const calcPValue = (actualRate, baseRate, n) => {
      if (n < 5 || baseRate <= 0 || baseRate >= 1) return null;
      const z = (actualRate - baseRate) / Math.sqrt(baseRate*(1-baseRate)/n);
      return +(1 - normCDF(z)).toFixed(4);
    };

    // ── Scan RTH bars for price responsiveness ─────────────────────────────
    // Touch definition (solid-test model):
    //   A touch is only counted when ALL of the following hold:
    //   1. Price enters the proximity zone (level ± PROX) from outside.
    //   2. Price was "clear" — had moved at least PROX beyond the zone edge
    //      since the last touch. Prevents hover/re-graze inflation; the whole
    //      cluster of bounces at a level counts as one touch until price
    //      travels meaningfully away.
    //   3. Within LOOKAHEAD bars, price moves ≥ MIN_BOUNCE in ANY direction.
    //      Filters pure drift-throughs with no actual reaction at the level.
    //
    // Respect definition:
    //   Among confirmed touches, price moved ≥ MIN_BOUNCE in the *expected*
    //   direction (up from support, down from resistance) without closing
    //   through the far side by more than PROX.
    //
    // Clear threshold: PROX beyond the zone edge (= PROX*2 from level center).
    const CLEAR_DIST = PROX;
    const mkSide = () => ({ touches: 0, respects: 0 });
    const mkRS   = () => ({ support: mkSide(), resistance: mkSide() });
    const respStats = {};
    for (const ld of LEVEL_DEFS) respStats[ld.key] = mkRS();
    respStats['vwap'] = mkRS();


    // Per-date detail: for each level+side, record each contributing day
    const detailStats = {};
    for (const ld of LEVEL_DEFS) detailStats[ld.key] = { support: [], resistance: [] };
    detailStats['vwap'] = { support: [], resistance: [] };

    const vwapByDate = {};

    for (const date of barScanDates) {
      const lvl = levelsByDate[date];
      if (!lvl) continue;
      const bars = lvl.rthBars;

      let cpv = 0, cv = 0;
      vwapByDate[date] = bars.map(b => {
        const tp = (+b.high + +b.low + +b.close) / 3, v = b.volume || 0;
        cpv += tp * v; cv += v;
        return cv > 0 ? cpv / cv : null;
      });

      // Per-day touch/respect counters (reset each date)
      const dayTouches   = {};
      const dayRespects  = {};
      const dayLevelPrice = {};
      for (const ld of LEVEL_DEFS) { dayTouches[ld.key] = { support: 0, resistance: 0 }; dayRespects[ld.key] = { support: 0, resistance: 0 }; }
      dayTouches['vwap'] = { support: 0, resistance: 0 }; dayRespects['vwap'] = { support: 0, resistance: 0 };
      dayLevelPrice['vwap'] = { support: null, resistance: null };
      for (const ld of LEVEL_DEFS) dayLevelPrice[ld.key] = { support: null, resistance: null };

      // Per-level state: inZone (currently touching), readyForTouch (far enough away to count next entry)
      const inZone = {};
      const readyForTouch = {};
      for (const ld of LEVEL_DEFS) { inZone[ld.key] = false; readyForTouch[ld.key] = true; }
      let vwapInZone = false, vwapReady = true;

      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const ts = new Date(b.ts);
        const h = ts.getUTCHours(), m = ts.getUTCMinutes();
        const afterIB = h > 10 || (h === 10 && m >= 30);
        const hi = +b.high, lo = +b.low, cl = +b.close;

        // Static levels
        for (const ld of LEVEL_DEFS) {
          if (ld.ibOnly && !afterIB) continue;
          const level = ld.get(lvl);
          if (level == null) continue;

          const barInZone = hi >= level - PROX && lo <= level + PROX;

          if (!barInZone) {
            inZone[ld.key] = false;
            // Reset touch eligibility once price clears CLEAR_DIST beyond zone edge
            if (!readyForTouch[ld.key] &&
                (lo > level + PROX + CLEAR_DIST || hi < level - PROX - CLEAR_DIST)) {
              readyForTouch[ld.key] = true;
            }
            continue;
          }

          if (inZone[ld.key]) continue; // still in same zone visit
          inZone[ld.key] = true;
          if (!readyForTouch[ld.key]) continue; // too close to last touch, skip

          readyForTouch[ld.key] = false;
          const fromAbove = cl > level || (hi > level && lo < level && (i === 0 || +bars[i-1].close > level));
          const side = fromAbove ? 'support' : 'resistance';
          dayLevelPrice[ld.key][side] = +level.toFixed(2);

          // Scan forward: respect check (LOOKAHEAD bars) + MFE/MAE (MFE_BARS)
          let maxBounce = 0, maxAnyMove = 0, respected = true;
          for (let j = i + 1; j < Math.min(i + LOOKAHEAD + 1, bars.length); j++) {
            const nc = +bars[j].close;
            maxAnyMove = Math.max(maxAnyMove, Math.abs(nc - level));
            if (fromAbove) {
              maxBounce = Math.max(maxBounce, nc - level);
              if (nc < level - PROX) { respected = false; break; }
            } else {
              maxBounce = Math.max(maxBounce, level - nc);
              if (nc > level + PROX) { respected = false; break; }
            }
          }

          // Only count if price actually moved after testing the level
          if (maxAnyMove < MIN_BOUNCE) continue;

          // Apply session-level filters when requested
          if (hasFilters && sessionMeta[date]) {
            const sm = sessionMeta[date];
            if (nl30State && sm.nl30 !== nl30State) continue;
            if (openingCall && sm.openingCall !== openingCall) continue;
            if (sessionDirection && sm.sessionDirection !== sessionDirection) continue;
          }

          respStats[ld.key][side].touches++;
          dayTouches[ld.key][side]++;
          const isRespected = respected && maxBounce >= MIN_BOUNCE;
          if (isRespected) {
            respStats[ld.key][side].respects++;
            dayRespects[ld.key][side]++;
          }

          // MFE/MAE over extended window for TP/stop analysis
          let mfe = 0, mae = 0, mfePeakBar = 0;
          for (let j = i + 1; j < Math.min(i + MFE_BARS + 1, bars.length); j++) {
            const nc = +bars[j].close, nh = +bars[j].high, nl = +bars[j].low;
            if (fromAbove) {
              const fav = nc - level;           // up from level = favorable for support
              const adv = level - nl;           // low below level = adverse (stop risk)
              if (fav > mfe) { mfe = fav; mfePeakBar = j - i; }
              if (adv > mae) mae = adv;
            } else {
              const fav = level - nc;           // down from level = favorable for resistance
              const adv = nh - level;           // high above level = adverse
              if (fav > mfe) { mfe = fav; mfePeakBar = j - i; }
              if (adv > mae) mae = adv;
            }
          }
          const bts = new Date(b.ts);
          const touchHour = bts.getUTCHours() * 100 + bts.getUTCMinutes(); // HHMM
          const sm = sessionMeta[date] || {};
          touchEvents[ld.key][side].push({
            mfe: +Math.max(0, mfe).toFixed(2),
            mae: +Math.max(0, mae).toFixed(2),
            timeToPeak: mfePeakBar,
            hour: bts.getUTCHours(),
            hhmm: touchHour,
            isRespected,
            ts: b.ts,
            date,
            barIndex: i,
            nl30State: sm.nl30 || null,
            openingCall: sm.openingCall || null,
            sessionDirection: sm.sessionDirection || null,
            confluenceScore: sm.confluenceScore ?? null,
          });

        }

        // VWAP scan (skip first 5 bars so VWAP has settled)
        if (i >= 5) {
          const vwap = vwapByDate[date][i];
          if (vwap != null) {
            const barInZone = hi >= vwap - PROX && lo <= vwap + PROX;

            if (!barInZone) {
              vwapInZone = false;
              if (!vwapReady &&
                  (lo > vwap + PROX + CLEAR_DIST || hi < vwap - PROX - CLEAR_DIST)) {
                vwapReady = true;
              }
            } else if (!vwapInZone) {
              vwapInZone = true;
              if (!vwapReady) continue;

              vwapReady = false;
              const fromAboveV = cl > vwap || (hi > vwap && lo < vwap && (i === 0 || +bars[i-1].close > vwap));
              const vside = fromAboveV ? 'support' : 'resistance';
              dayLevelPrice['vwap'][vside] = +vwap.toFixed(2);

              let maxBounceV = 0, maxAnyMoveV = 0, respectedV = true;
              for (let j = i + 1; j < Math.min(i + LOOKAHEAD + 1, bars.length); j++) {
                const nc = +bars[j].close, vj = vwapByDate[date][j] ?? vwap;
                maxAnyMoveV = Math.max(maxAnyMoveV, Math.abs(nc - vj));
                if (fromAboveV) {
                  maxBounceV = Math.max(maxBounceV, nc - vj);
                  if (nc < vj - PROX) { respectedV = false; break; }
                } else {
                  maxBounceV = Math.max(maxBounceV, vj - nc);
                  if (nc > vj + PROX) { respectedV = false; break; }
                }
              }

              if (maxAnyMoveV < MIN_BOUNCE) continue;

              if (hasFilters && sessionMeta[date]) {
                const sm = sessionMeta[date];
                if (nl30State && sm.nl30 !== nl30State) continue;
                if (openingCall && sm.openingCall !== openingCall) continue;
                if (sessionDirection && sm.sessionDirection !== sessionDirection) continue;
              }

              respStats['vwap'][vside].touches++;
              dayTouches['vwap'][vside]++;
              const isRespectedV = respectedV && maxBounceV >= MIN_BOUNCE;
              if (isRespectedV) {
                respStats['vwap'][vside].respects++;
                dayRespects['vwap'][vside]++;
              }

              // MFE/MAE for VWAP touches
              let mfeV = 0, maeV = 0, mfePeakV = 0;
              for (let j = i + 1; j < Math.min(i + MFE_BARS + 1, bars.length); j++) {
                const nc = +bars[j].close, nh = +bars[j].high, nl = +bars[j].low;
                const vj = vwapByDate[date][j] ?? vwap;
                if (fromAboveV) {
                  const fav = nc - vj; const adv = vj - nl;
                  if (fav > mfeV) { mfeV = fav; mfePeakV = j - i; }
                  if (adv > maeV) maeV = adv;
                } else {
                  const fav = vj - nc; const adv = nh - vj;
                  if (fav > mfeV) { mfeV = fav; mfePeakV = j - i; }
                  if (adv > maeV) maeV = adv;
                }
              }
              const btsV = new Date(b.ts);
              touchEvents['vwap'][vside].push({
                mfe: +Math.max(0, mfeV).toFixed(2),
                mae: +Math.max(0, maeV).toFixed(2),
                timeToPeak: mfePeakV,
                hour: btsV.getUTCHours(),
                hhmm: btsV.getUTCHours() * 100 + btsV.getUTCMinutes(),
                isRespected: isRespectedV,
                ts: b.ts,
                date,
              });
            }
          }
        }
      }

      // Record per-date detail for any level that had touches today
      const allKeys = [...LEVEL_DEFS.map(l => l.key), 'vwap'];
      for (const key of allKeys) {
        for (const side of ['support', 'resistance']) {
          if (dayTouches[key][side] > 0) {
            detailStats[key][side].push({
              date,
              touches: dayTouches[key][side],
              respects: dayRespects[key][side],
              levelPrice: dayLevelPrice[key][side],
            });
          }
        }
      }
    }

    // ── Random baseline: randomly-placed levels per day, same solid-test rules ──
    // Null-hypothesis respect rate. Uses same touch filter (require CLEAR_DIST away
    // before re-touch, require MIN_BOUNCE move after touch) for a fair comparison.
    const RAND_PER_DAY = 10;
    const randStats = { support: { t: 0, r: 0 }, resistance: { t: 0, r: 0 } };
    for (const date of barScanDates) {
      const lvl = levelsByDate[date];
      if (!lvl) continue;
      const bars = lvl.rthBars;
      if (!bars.length) continue;
      const dayHi = Math.max(...bars.map(b => +b.high));
      const dayLo = Math.min(...bars.map(b => +b.low));
      const range = dayHi - dayLo;
      if (range < PROX * 4) continue;
      for (let r = 0; r < RAND_PER_DAY; r++) {
        const rl = dayLo + PROX + Math.random() * (range - PROX * 2);
        let rInZone = false, rReady = true;
        for (let i = 0; i < bars.length; i++) {
          const b = bars[i], hi = +b.high, lo = +b.low, cl = +b.close;
          const barInZone = hi >= rl - PROX && lo <= rl + PROX;
          if (!barInZone) {
            rInZone = false;
            if (!rReady && (lo > rl + PROX + CLEAR_DIST || hi < rl - PROX - CLEAR_DIST)) rReady = true;
            continue;
          }
          if (rInZone) continue;
          rInZone = true;
          if (!rReady) continue;
          rReady = false;
          const fromAbove = cl > rl || (hi > rl && lo < rl && (i === 0 || +bars[i-1].close > rl));
          const side = fromAbove ? 'support' : 'resistance';
          let respected = true, maxB = 0, maxAny = 0;
          for (let j = i + 1; j < Math.min(i + LOOKAHEAD + 1, bars.length); j++) {
            const nc = +bars[j].close;
            maxAny = Math.max(maxAny, Math.abs(nc - rl));
            if (fromAbove) { maxB = Math.max(maxB, nc - rl); if (nc < rl - PROX) { respected = false; break; } }
            else           { maxB = Math.max(maxB, rl - nc); if (nc > rl + PROX) { respected = false; break; } }
          }
          if (maxAny < MIN_BOUNCE) continue;
          randStats[side].t++;
          if (respected && maxB >= MIN_BOUNCE) randStats[side].r++;
        }
      }
    }
    const randRate = {
      support:    randStats.support.t    > 0 ? randStats.support.r    / randStats.support.t    : 0.5,
      resistance: randStats.resistance.t > 0 ? randStats.resistance.r / randStats.resistance.t : 0.5,
    };

    // ── Classify each trade against levels + compute VWAP at entry ─────────
    const mkTS = () => ({
      support:    { count: 0, wins: 0, pnls: [], mfeAvailable: [] },
      resistance: { count: 0, wins: 0, pnls: [], mfeAvailable: [] },
    });
    const tradeStats = {};
    for (const ld of LEVEL_DEFS) tradeStats[ld.key] = mkTS();
    tradeStats['vwap'] = mkTS();

    const enrichedTrades = [];

    for (const t of tradesRes.rows) {
      const date = t.log_date;
      const lvl  = levelsByDate[date];
      const ep   = +t.entry_price;
      const pnl  = +t.pnl;
      const nearLevels = [];

      if (lvl) {
        for (const ld of LEVEL_DEFS) {
          const level = ld.get(lvl);
          if (level != null && Math.abs(ep - level) <= PROX) {
            const side = ep >= level ? 'support' : 'resistance';
            nearLevels.push(ld.key);
            tradeStats[ld.key][side].count++;
            if (pnl > 0) tradeStats[ld.key][side].wins++;
            tradeStats[ld.key][side].pnls.push(pnl);

            // Find the touch event on this date closest in time to trade entry
            const eventsForSide = (touchEvents[ld.key][side] || []).filter(e => e.date === date);
            if (eventsForSide.length > 0 && t.entry_time) {
              const entryMs = new Date(t.entry_time).getTime();
              const nearest = eventsForSide.reduce((best, e) => {
                const diff = Math.abs(new Date(e.ts).getTime() - entryMs);
                return diff < best.diff ? { e, diff } : best;
              }, { e: eventsForSide[0], diff: Infinity });
              tradeStats[ld.key][side].mfeAvailable.push(nearest.e.mfe);
            }
          }
        }

        // RTH VWAP at entry
        const vwapSeries = vwapByDate[date] || [];
        let vwapAtEntry = null;
        for (let i = 0; i < lvl.rthBars.length; i++) {
          if (lvl.rthBars[i].ts > t.entry_time) break;
          vwapAtEntry = vwapSeries[i] ?? vwapAtEntry;
        }
        if (vwapAtEntry != null && Math.abs(ep - vwapAtEntry) <= PROX) {
          const side = ep >= vwapAtEntry ? 'support' : 'resistance';
          tradeStats['vwap'][side].count++;
          if (pnl > 0) tradeStats['vwap'][side].wins++;
          tradeStats['vwap'][side].pnls.push(pnl);
          nearLevels.push('vwap');
          const eventsV = (touchEvents['vwap'][side] || []).filter(e => e.date === date);
          if (eventsV.length > 0 && t.entry_time) {
            const entryMs = new Date(t.entry_time).getTime();
            const nearest = eventsV.reduce((best, e) => {
              const diff = Math.abs(new Date(e.ts).getTime() - entryMs);
              return diff < best.diff ? { e, diff } : best;
            }, { e: eventsV[0], diff: Infinity });
            tradeStats['vwap'][side].mfeAvailable.push(nearest.e.mfe);
          }
        }
      }

      enrichedTrades.push({ id: t.id, log_date: date, direction: t.direction?.toUpperCase(), entry_price: ep, pnl, nearLevels });
    }

    // ── Build response ─────────────────────────────────────────────────────
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    // Compute hour-of-day breakdown from touch events
    const buildHourBreakdown = (events) => {
      const hourMap = {};
      for (const e of events) {
        const h = e.hour;
        if (!hourMap[h]) hourMap[h] = { touches: 0, respects: 0, mfes: [] };
        hourMap[h].touches++;
        if (e.isRespected) hourMap[h].respects++;
        hourMap[h].mfes.push(e.mfe);
      }
      return Object.entries(hourMap)
        .sort(([a], [b]) => +a - +b)
        .map(([h, d]) => ({
          hour: +h,
          label: `${h}:00`,
          touches: d.touches,
          respects: d.respects,
          respectRate: d.touches > 0 ? +(d.respects / d.touches * 100).toFixed(1) : null,
          mfe_p50: pct(d.mfes, 50),
          mfe_p75: pct(d.mfes, 75),
        }));
    };

    // Build condition breakdown: splits touch events by a grouping function
    const buildConditionBreakdown = (events, baseRate) => {
      const groupBy = (fn) => {
        const groups = {};
        for (const e of events) {
          const key = fn(e);
          if (!key) continue;
          if (!groups[key]) groups[key] = { touches: 0, respects: 0, mfes: [] };
          groups[key].touches++;
          if (e.isRespected) { groups[key].respects++; groups[key].mfes.push(e.mfe); }
          else groups[key].mfes.push(e.mfe);
        }
        return Object.fromEntries(Object.entries(groups).sort().map(([k, g]) => [k, {
          touches: g.touches,
          respects: g.respects,
          respectRate: g.touches > 0 ? +(g.respects / g.touches * 100).toFixed(1) : null,
          mfe_p50: pct(g.mfes, 50),
          pValue: g.touches >= 5 ? calcPValue(g.touches > 0 ? g.respects/g.touches : 0, baseRate, g.touches) : null,
        }]));
      };
      return {
        byNL30: groupBy(e => e.nl30State),
        byOpeningCall: groupBy(e => e.openingCall),
        bySessionDirection: groupBy(e => e.sessionDirection),
        byTouchTime: groupBy(e => {
          if (e.barIndex == null) return null;
          return e.barIndex < 30 ? 'early_0-30min' : e.barIndex < 50 ? 'mid_30-50min' : 'late_50min+';
        }),
        byConfluence: groupBy(e => {
          const s = e.confluenceScore;
          if (s == null) return null;
          // confluence_score_pre in daily_performance_log is stored on a 0–3 scale
          return s === 0 ? '0 — no confluence' : s === 1 ? '1 — low' : s === 2 ? '2 — moderate' : '3 — high';
        }),
      };
    };

    const buildSide = (rs, ts, side, details, events) => {
      const actualRate = rs.touches > 0 ? rs.respects / rs.touches : null;
      const baseRate   = randRate[side];
      const mfes = (events || []).map(e => e.mfe);
      const maes = (events || []).map(e => e.mae);
      const peaks = (events || []).map(e => e.timeToPeak);
      return {
        touches:      rs.touches,
        respects:     rs.respects,
        respectRate:  actualRate != null ? +(actualRate * 100).toFixed(1) : null,
        randomRate:   +(baseRate * 100).toFixed(1),
        pValue:       actualRate != null ? calcPValue(actualRate, baseRate, rs.touches) : null,
        tradeCount:          ts.count,
        tradeWinRate:        ts.count > 0 ? +(ts.wins / ts.count * 100).toFixed(1) : null,
        tradeAvgPnl:         ts.count > 0 ? +avg(ts.pnls).toFixed(2) : null,
        tradeAvgMfeAvail:    ts.mfeAvailable.length > 0 ? +avg(ts.mfeAvailable).toFixed(2) : null,
        tradeMfeAvailP50:    ts.mfeAvailable.length > 0 ? pct(ts.mfeAvailable, 50) : null,
        details:      details || [],
        // MFE/MAE distributions for TP/stop analysis
        mfe: mfes.length ? {
          p25: pct(mfes, 25), p50: pct(mfes, 50),
          p75: pct(mfes, 75), p90: pct(mfes, 90),
          mean: +avg(mfes).toFixed(2),
        } : null,
        mae: maes.length ? {
          p25: pct(maes, 25), p50: pct(maes, 50), p75: pct(maes, 75),
        } : null,
        timeToPeak: peaks.length ? {
          p25: pct(peaks, 25), p50: pct(peaks, 50), p75: pct(peaks, 75),
        } : null,
        byHour: buildHourBreakdown(events || []),
        conditionBreakdown: buildConditionBreakdown(events || [], baseRate),
      };
    };

    const allKeys = [...LEVEL_DEFS.map(l => l.key), 'vwap'];
    const allLabels = { ...Object.fromEntries(LEVEL_DEFS.map(l => [l.key, l.label])), vwap: 'RTH VWAP' };

    const byLevel = allKeys.map(key => {
      const rs = respStats[key];
      const ts2 = tradeStats[key];
      const evts = touchEvents[key] || { support: [], resistance: [] };
      const sup = buildSide(rs.support,    ts2.support,    'support',    detailStats[key].support,    evts.support);
      const res = buildSide(rs.resistance, ts2.resistance, 'resistance', detailStats[key].resistance, evts.resistance);
      const totalTouches = sup.touches + res.touches;
      return {
        key, label: allLabels[key],
        support:    sup,
        resistance: res,
        totalTouches,
      };
    }).filter(r => r.totalTouches > 0 || r.support.tradeCount > 0 || r.resistance.tradeCount > 0);

    // Combined confluence breakdown across the 6 primary levels (ibh, ibl, ibhExt, iblExt, pdvah, pdval)
    const SIG_LEVELS = ['ibh', 'ibl', 'ibhExt', 'iblExt', 'pdvah', 'pdval'];
    const allSigEvents = SIG_LEVELS.flatMap(k => [
      ...(touchEvents[k]?.support || []),
      ...(touchEvents[k]?.resistance || []),
    ]);
    const combinedRandRate = (randRate.support + randRate.resistance) / 2;
    const combinedConfluenceBreakdown = buildConditionBreakdown(allSigEvents, combinedRandRate).byConfluence;

    const result = { byLevel, tradeCount: enrichedTrades.length, combinedConfluenceBreakdown };
    cacheSet(cacheKey, result, 120_000);
    res.json(result);
  } catch (err) {
    console.error('Key levels error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Session Chart: live candlestick + key levels + trades for one day ────────
app.get('/api/chart/live-day', async (req, res) => {
  try {
    const { date, account } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    // Load bars from 14 days prior so we can compute prior-week VA
    const extFrom = new Date(date);
    extFrom.setDate(extFrom.getDate() - 14);
    const extFromStr = extFrom.toISOString().split('T')[0];

    const barsRes = await query(`
      SELECT date(ts) AS bar_date, ts,
             open::numeric, high::numeric, low::numeric, close::numeric,
             volume::integer, bid_volume::integer, ask_volume::integer
      FROM price_bars
      WHERE symbol = 'NQ'
        AND ts >= $1::date
        AND ts <  ($2::date + interval '1 day')
      ORDER BY ts ASC
    `, [extFromStr, date]);

    // Also fetch the previous day's overnight bars (for ONH/ONL)
    // Overnight = after 16:00 prior day through 9:29 of current date
    const barsByDate = {};
    const overnightBars = []; // bars for the overnight session leading into `date`
    for (const b of barsRes.rows) {
      const d = b.bar_date;
      if (!barsByDate[d]) barsByDate[d] = [];
      barsByDate[d].push(b);
      // Overnight for `date`: bars on date that are before 9:30
      if (d === date) {
        const ts = new Date(b.ts);
        const h = ts.getUTCHours(), m = ts.getUTCMinutes();
        if (h < 9 || (h === 9 && m < 30)) overnightBars.push(b);
      }
    }
    const allBarDates = Object.keys(barsByDate).sort();

    // RTH bars for the requested date
    const rthBars = (barsByDate[date] || []).filter(b => {
      const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes();
      return (h === 9 && m >= 30) || (h > 9 && h < 16);
    });

    // ── Level computation (same logic as key-levels endpoint) ──────────────
    const TICK = 0.25;
    const rnd = p => Math.round(p / TICK) * TICK;
    const buildVP = (bars, returnHistogram = false) => {
      if (!bars.length) return null;
      const volMap = {}; let totalVol = 0;
      for (const b of bars) {
        const h = +b.high, l = +b.low, v = b.volume || 0; if (!v) continue;
        const lo = rnd(l), hi = rnd(h), steps = Math.round((hi - lo) / TICK) + 1, vpl = v / steps;
        for (let i = 0; i < steps; i++) { const p = rnd(lo + i * TICK); volMap[p] = (volMap[p] || 0) + vpl; totalVol += vpl; }
      }
      if (!totalVol) return null;
      const levels = Object.entries(volMap).map(([p, v]) => ({ price: +p, volume: v })).sort((a, b) => a.price - b.price);
      const poc = levels.reduce((m, l) => l.volume > m.volume ? l : m, levels[0]);
      const pocIdx = levels.findIndex(l => Math.abs(l.price - poc.price) < TICK / 2);
      let vaVol = poc.volume, upI = pocIdx + 1, dnI = pocIdx - 1;
      const target = totalVol * 0.70;
      while (vaVol < target) {
        const up = upI < levels.length ? levels[upI].volume : 0, dn = dnI >= 0 ? levels[dnI].volume : 0;
        if (up >= dn && upI < levels.length) { vaVol += up; upI++; } else if (dnI >= 0) { vaVol += dn; dnI--; } else if (upI < levels.length) { vaVol += up; upI++; } else break;
      }
      const vah = levels[Math.min(upI - 1, levels.length - 1)]?.price ?? poc.price;
      const val = levels[Math.max(dnI + 1, 0)]?.price ?? poc.price;
      if (returnHistogram) {
        const maxVol = Math.max(...levels.map(l => l.volume));
        return { poc: poc.price, vah, val, histogram: levels.map(l => ({ price: l.price, pct: +(l.volume / maxVol).toFixed(3) })) };
      }
      return { poc: poc.price, vah, val };
    };

    // IB
    const ibBars = rthBars.filter(b => { const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes(); return (h === 9 && m >= 30) || (h === 10 && m <= 29); });
    const ibHigh = ibBars.length ? Math.max(...ibBars.map(b => +b.high)) : null;
    const ibLow  = ibBars.length ? Math.min(...ibBars.map(b => +b.low))  : null;

    // Opening 5-min midpoint
    const o5Bars = rthBars.filter(b => { const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes(); return h === 9 && m >= 30 && m <= 34; });
    const o5H = o5Bars.length ? Math.max(...o5Bars.map(b => +b.high)) : null;
    const o5L = o5Bars.length ? Math.min(...o5Bars.map(b => +b.low))  : null;
    const open5Mid = o5H != null ? +((o5H + o5L) / 2).toFixed(2) : null;
    const open5High = o5H, open5Low = o5L;

    // Prior day VP + PDH/PDL
    const dateIdx = allBarDates.indexOf(date);
    const prevDayDate = dateIdx > 0 ? allBarDates[dateIdx - 1] : null;
    const prevDayAllBars = prevDayDate ? (barsByDate[prevDayDate] || []) : [];
    const prevDayRth = prevDayAllBars.filter(b => { const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes(); return (h === 9 && m >= 30) || (h > 9 && h < 16); });
    const pdVP = buildVP(prevDayRth);
    const pdHigh = prevDayRth.length ? Math.max(...prevDayRth.map(b => +b.high)) : null;
    const pdLow  = prevDayRth.length ? Math.min(...prevDayRth.map(b => +b.low))  : null;
    const pdClose = prevDayRth.length ? +prevDayRth[prevDayRth.length - 1].close : null;

    // Prior Day VWAP
    const pdVwap = (() => {
      if (!prevDayRth.length) return null;
      let cpv = 0, cv = 0;
      for (const b of prevDayRth) { const tp = (+b.high + +b.low + +b.close) / 3, v = b.volume || 0; cpv += tp * v; cv += v; }
      return cv > 0 ? +(cpv / cv).toFixed(2) : null;
    })();

    // Today's RTH volume profile (with full histogram for chart overlay)
    const todayVP = buildVP(rthBars, true);

    // Overnight High/Low (current date pre-market)
    const onHigh = overnightBars.length ? Math.max(...overnightBars.map(b => +b.high)) : null;
    const onLow  = overnightBars.length ? Math.min(...overnightBars.map(b => +b.low))  : null;

    // Gap: RTH open vs prior close
    const rthOpen = rthBars.length ? +rthBars[0].open : null;
    const gap = rthOpen != null && pdClose != null ? +(rthOpen - pdClose).toFixed(2) : null;

    // Prior week VP
    const [yr, mo, dy] = date.split('-').map(Number);
    const d = new Date(Date.UTC(yr, mo - 1, dy));
    const dow = d.getUTCDay();
    const daysToMon = dow === 0 ? 6 : dow - 1;
    const pwStart = new Date(d.getTime() - 86400000 * (daysToMon + 7)).toISOString().split('T')[0];
    const pwEnd   = new Date(d.getTime() - 86400000 * (daysToMon + 3)).toISOString().split('T')[0];
    const prevWeekRthBars = allBarDates.filter(bd => bd >= pwStart && bd <= pwEnd).flatMap(bd => {
      return (barsByDate[bd] || []).filter(b => { const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes(); return (h === 9 && m >= 30) || (h > 9 && h < 16); });
    });
    const pwVP = buildVP(prevWeekRthBars);
    const pwHigh = prevWeekRthBars.length ? Math.max(...prevWeekRthBars.map(b => +b.high)) : null;
    const pwLow  = prevWeekRthBars.length ? Math.min(...prevWeekRthBars.map(b => +b.low))  : null;

    const levels = {
      ibHigh, ibLow,
      ibRange: ibHigh != null ? ibHigh - ibLow : null,
      ibExt1Up:  ibHigh != null ? +(ibHigh + (ibHigh - ibLow)).toFixed(2)     : null,
      ibExt1Dn:  ibLow  != null ? +(ibLow  - (ibHigh - ibLow)).toFixed(2)     : null,
      open5Mid, open5High, open5Low,
      pdVAH: pdVP?.vah ?? null, pdVAL: pdVP?.val ?? null, pdPOC: pdVP?.poc ?? null,
      pdHigh, pdLow, pdClose, pdVwap,
      onHigh, onLow,
      gap,
      pwVAH: pwVP?.vah ?? null, pwVAL: pwVP?.val ?? null,
      pwHigh, pwLow,
    };

    // ── RTH VWAP series ────────────────────────────────────────────────────
    let cumPV = 0, cumVol = 0;
    const vwapSeries = rthBars.map(b => {
      const tp = (+b.high + +b.low + +b.close) / 3, v = b.volume || 0;
      cumPV += tp * v; cumVol += v;
      return { ts: b.ts, vwap: cumVol > 0 ? +(cumPV / cumVol).toFixed(2) : null };
    });

    // ── Trades for this date ───────────────────────────────────────────────
    const tp = [date];
    let tw = `log_date = $1 AND entry_price IS NOT NULL AND entry_time IS NOT NULL`;
    if (account) { tp.push(account.split(',').filter(Boolean)); tw += ` AND custom_fields->>'account' = ANY($2)`; }
    // Convert entry/exit times from UTC → CT face value so they align with bar timestamps.
    // Bars are stored as CT face values (e.g. 09:30 CT stored as 09:30Z).
    // Trades are stored as real UTC, so we convert to CT before sending to the chart.
    const tradesRes = await query(`
      SELECT id, direction, entry_price::numeric, exit_price::numeric,
             pnl::numeric,
             (entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') AS entry_time,
             (exit_time  AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') AS exit_time,
             quantity, symbol,
             custom_fields->'sierra_data'->>'Max Open Quantity' as max_qty,
             custom_fields->>'account' as account
      FROM trades WHERE ${tw} ORDER BY entry_time ASC
    `, tp);

    res.json({ date, bars: rthBars, overnightBars, vwap: vwapSeries, levels, trades: tradesRes.rows, vpHistogram: todayVP?.histogram ?? [], vpStats: todayVP ? { poc: todayVP.poc, vah: todayVP.vah, val: todayVP.val } : null });
  } catch (err) {
    console.error('Chart live-day error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── Discovery Edge Analysis ───────────────────────────────────────────────────
// Finds genuinely new edges: time-of-day patterns, bid/ask delta, consecutive
// day sequences, opening drive, intraday volume correlations, and multi-factor
// combinations the trader may not have considered.
app.get('/api/analysis/edge', async (req, res) => {
  try {
    const barsRes = await query(`
      SELECT date(ts) AS bar_date, ts,
             open::numeric, high::numeric, low::numeric, close::numeric,
             volume::integer, bid_volume::integer, ask_volume::integer
      FROM price_bars
      WHERE symbol = 'NQ'
      ORDER BY ts ASC
    `);

    // Group by date
    const byDate = {};
    for (const b of barsRes.rows) {
      const d = b.bar_date;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(b);
    }
    const allDates = Object.keys(byDate).sort();

    const rth = bars => bars.filter(b => {
      const h = new Date(b.ts).getUTCHours(), m = new Date(b.ts).getUTCMinutes();
      return (h === 9 && m >= 30) || (h > 9 && h < 16);
    });
    const barMin = b => { const t = new Date(b.ts); return (t.getUTCHours()-9)*60 + t.getUTCMinutes() - 30; };
    const normCDF = z => {
      const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
      const s=z<0?-1:1,x=Math.abs(z)/Math.SQRT2,t=1/(1+p*x);
      return 0.5*(1+s*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x)));
    };
    const pval = (r,b,n) => {
      if (n<10||b<=0||b>=1) return null;
      return +(2*(1-normCDF(Math.abs((r-b)/Math.sqrt(b*(1-b)/n))))).toFixed(4);
    };

    // ── Build session metrics ──────────────────────────────────────────────────
    const sessions = [];
    let rollingRanges = [], rollingVols = [];

    for (let di = 0; di < allDates.length; di++) {
      const date = allDates[di];
      const rthB = rth(byDate[date]);
      if (rthB.length < 30) continue;

      const ibB = rthB.filter(b => { const m = barMin(b); return m >= 0 && m < 60; });
      if (!ibB.length) continue;

      const ibH = Math.max(...ibB.map(b => +b.high));
      const ibL = Math.min(...ibB.map(b => +b.low));
      const ibRange = ibH - ibL;
      if (ibRange < 5) continue;

      const open = +rthB[0].open;
      const close = +rthB[rthB.length-1].close;
      const dayHi = Math.max(...rthB.map(b => +b.high));
      const dayLo = Math.min(...rthB.map(b => +b.low));
      const dayRange = dayHi - dayLo;
      const dayVol = rthB.reduce((s, b) => s+(b.volume||0), 0);
      const dayBid = rthB.reduce((s, b) => s+(b.bid_volume||0), 0);
      const dayAsk = rthB.reduce((s, b) => s+(b.ask_volume||0), 0);

      rollingRanges.push(dayRange); if (rollingRanges.length > 20) rollingRanges.shift();
      rollingVols.push(dayVol);     if (rollingVols.length > 20) rollingVols.shift();
      const avgRange = rollingRanges.reduce((a,b)=>a+b,0)/rollingRanges.length;
      const avgVol   = rollingVols.reduce((a,b)=>a+b,0)/rollingVols.length;

      const dow = new Date(date+'T12:00:00').getDay();
      const dayDir = close > open + 5 ? 'up' : close < open - 5 ? 'down' : 'flat';
      const trendDay = dayRange > 0 && (Math.abs(close-open)/dayRange) > 0.55;
      const volRatio = avgVol > 0 ? dayVol/avgVol : 1;
      const rangeRatio = avgRange > 0 ? dayRange/avgRange : 1;

      // Intraday time buckets (30-min slots, 0=9:30-10:00, 1=10:00-10:30, ...)
      const SLOTS = 13; // 9:30-16:00 = 6.5hrs = 13 × 30min
      const slotBars = Array.from({length:SLOTS}, ()=>[]);
      for (const b of rthB) {
        const slot = Math.floor(barMin(b) / 30);
        if (slot >= 0 && slot < SLOTS) slotBars[slot].push(b);
      }
      const slotStats = slotBars.map(bs => {
        if (!bs.length) return null;
        const slotOpen = +bs[0].open;
        const slotClose = +bs[bs.length-1].close;
        const slotHi = Math.max(...bs.map(b=>+b.high));
        const slotLo = Math.min(...bs.map(b=>+b.low));
        const vol = bs.reduce((s,b)=>s+(b.volume||0),0);
        const bid = bs.reduce((s,b)=>s+(b.bid_volume||0),0);
        const ask = bs.reduce((s,b)=>s+(b.ask_volume||0),0);
        return {
          net: slotClose-slotOpen,
          range: slotHi-slotLo,
          vol, bid, ask,
          delta: ask-bid,
          dir: slotClose>slotOpen+2?'up':slotClose<slotOpen-2?'down':'flat'
        };
      });

      // Opening drive: first 15-min move
      const first15 = rthB.filter(b => barMin(b) < 15);
      const drive15 = first15.length ? +first15[first15.length-1].close - open : 0;
      const drive15Dir = drive15 > 5 ? 'up' : drive15 < -5 ? 'down' : 'flat';

      // First 30-min close vs open
      const f30close = slotStats[0] ? open + slotStats[0].net : open;
      const f30dir = f30close > open+5 ? 'up' : f30close < open-5 ? 'down' : 'flat';

      // Bid/ask delta in first 60min (IB period)
      const ibBid = ibB.reduce((s,b)=>s+(b.bid_volume||0),0);
      const ibAsk = ibB.reduce((s,b)=>s+(b.ask_volume||0),0);
      const ibDelta = ibAsk - ibBid; // positive = more buying pressure in IB
      const ibDeltaDir = ibDelta > (ibBid+ibAsk)*0.03 ? 'buy' : ibDelta < -(ibBid+ibAsk)*0.03 ? 'sell' : 'neutral';

      // IB price direction (was IB bullish or bearish?)
      const ibClose = ibB.length ? +ibB[ibB.length-1].close : open;
      const ibPriceDir = ibClose > open + 5 ? 'up' : ibClose < open - 5 ? 'down' : 'flat';

      // DELTA DIVERGENCE: price direction contradicts order flow — the real edge
      // Price up in IB but sell pressure dominated = distribution into strength = bearish signal
      const ibDeltaDivergence =
        (ibPriceDir === 'up'   && ibDeltaDir === 'sell') ? 'bearish_div' :  // price up, sellers absorbing
        (ibPriceDir === 'down' && ibDeltaDir === 'buy')  ? 'bullish_div' :  // price down, buyers absorbing
        (ibPriceDir === 'up'   && ibDeltaDir === 'buy')  ? 'bullish_conf':  // price up, buyers confirming
        (ibPriceDir === 'down' && ibDeltaDir === 'sell') ? 'bearish_conf':  // price down, sellers confirming
        'neutral';

      // Delta strength: how dominant is the imbalance?
      const ibDeltaStrength = (ibBid+ibAsk) > 0 ? Math.abs(ibDelta)/(ibBid+ibAsk) : 0;
      const ibStrongDelta = ibDeltaStrength > 0.08; // >8% imbalance = notable

      // IB break
      const postIB = rthB.filter(b => barMin(b) >= 60);
      const ibBreakUp = postIB.some(b => +b.close > ibH);
      const ibBreakDn = postIB.some(b => +b.close < ibL);

      // AM vs PM direction
      const amBars = rthB.filter(b => barMin(b) < 150); // 9:30-12:00
      const pmBars = rthB.filter(b => barMin(b) >= 150);
      const amClose = amBars.length ? +amBars[amBars.length-1].close : open;
      const pmClose = pmBars.length ? +pmBars[pmBars.length-1].close : amClose;
      const amDir = amClose>open+5?'up':amClose<open-5?'down':'flat';
      const pmDir = pmClose>amClose+5?'up':pmClose<amClose-5?'down':'flat';
      const pmContinues = amDir !== 'flat' && pmDir === amDir;
      const pmReverses  = amDir !== 'flat' && pmDir !== 'flat' && pmDir !== amDir;

      // Prior day
      const prev = sessions[sessions.length-1];
      const prevDir  = prev?.dayDir  ?? null;
      const prevDir2 = sessions[sessions.length-2]?.dayDir ?? null;
      const prevDir3 = sessions[sessions.length-3]?.dayDir ?? null;
      const prevRange = prev?.dayRange ?? null;
      const prevRangeRatio = prev?.rangeRatio ?? null;
      const prevTrend = prev?.trendDay ?? null;
      const streak = prev ? (
        prev.dayDir === 'up'   ? (sessions[sessions.length-2]?.dayDir === 'up'   ? (sessions[sessions.length-3]?.dayDir === 'up'   ? 3 : 2) : 1) :
        prev.dayDir === 'down' ? (sessions[sessions.length-2]?.dayDir === 'down' ? (sessions[sessions.length-3]?.dayDir === 'down' ? -3 : -2) : -1) : 0
      ) : 0;

      // IB position within prior day range
      const prevHi = prev?.dayHi ?? null;
      const prevLo = prev?.dayLo ?? null;
      const openVsPriorRange = prevHi && prevLo ? (open - prevLo)/(prevHi - prevLo) : null;
      // 0 = at prior lo, 0.5 = mid, 1 = at prior hi

      sessions.push({
        date, dow, dayDir, trendDay, volRatio, rangeRatio, dayRange, dayVol, dayHi, dayLo,
        ibRange, ibH, ibL, open, close, dayBid, dayAsk,
        ibDelta, ibDeltaDir, ibPriceDir, ibDeltaDivergence, ibStrongDelta, ibBreakUp, ibBreakDn,
        drive15, drive15Dir, f30dir, amDir, pmDir, pmContinues, pmReverses,
        slotStats,
        prevDir, prevDir2, prevDir3, prevTrend, prevRangeRatio, streak,
        openVsPriorRange, prevHi, prevLo,
      });
    }

    const N = sessions.length;
    if (N < 50) return res.json({ sections: [], sessions: N });

    const test = (label, category, description, filter, outcome, baseline=0.5) => {
      const cohort = sessions.filter(filter);
      if (cohort.length < 15) return null;
      const hits = cohort.filter(outcome).length;
      const rate = hits/cohort.length;
      const edge = rate-baseline;
      const pv = pval(rate, baseline, cohort.length);
      return { label, category, description, n: cohort.length, hits, rate: +(rate*100).toFixed(1), baseline: +(baseline*100).toFixed(1), edge: +(edge*100).toFixed(1), pValue: pv, sig: pv!=null&&pv<0.05 };
    };

    const all = [

      // ── TIME-OF-DAY DIRECTIONAL BIAS ─────────────────────────────────────────
      // For each 30-min slot, what % of days does price move up?
      ...Array.from({length:13}, (_,i) => {
        const h = Math.floor(i/2)+9, m = (i%2)*30, label = `${h}:${m===0?'30':'00'}${m===0?' AM':''}-${h}:${m===0?'00':'30'} directional bias`;
        const slotLabel = `${h+Math.floor((m+30)/60)}:${((m+30)%60).toString().padStart(2,'0')}`;
        const fullLabel = `${h}:${m.toString().padStart(2,'0')}–${slotLabel} → price moves UP`;
        return test(fullLabel, 'Time of Day',
          `In the ${h}:${m.toString().padStart(2,'0')}–${slotLabel} slot, what % of sessions does price close higher than it opened?`,
          s => s.slotStats[i] != null,
          s => s.slotStats[i]?.dir === 'up',
          0.5);
      }).filter(Boolean),

      // ── OPENING DRIVE ────────────────────────────────────────────────────────
      test('Opening Drive Up → Day Closes Up', 'Opening Drive',
        'When the first 15-min move is upward, does the day close above the open?',
        s => s.drive15Dir === 'up', s => s.dayDir === 'up'),
      test('Opening Drive Down → Day Closes Down', 'Opening Drive',
        'When the first 15-min move is downward, does the day close below the open?',
        s => s.drive15Dir === 'down', s => s.dayDir === 'down'),
      test('Opening Drive Up → AM Continues Up', 'Opening Drive',
        'When the first 15-min is up, does the full AM (9:30-12:00) close above the open?',
        s => s.drive15Dir === 'up', s => s.amDir === 'up'),
      test('Opening Drive Down → AM Continues Down', 'Opening Drive',
        'When the first 15-min is down, does the full AM close below the open?',
        s => s.drive15Dir === 'down', s => s.amDir === 'down'),
      test('Opening Drive Up → PM Reverses Down', 'Opening Drive',
        'When the first 15-min is up, does the PM (12:00-16:00) reverse downward?',
        s => s.drive15Dir === 'up', s => s.pmReverses),
      test('Opening Drive Down → PM Reverses Up', 'Opening Drive',
        'When the first 15-min is down, does the PM reverse upward?',
        s => s.drive15Dir === 'down', s => s.pmReverses),

      // ── AM/PM CONTINUATION vs REVERSAL ───────────────────────────────────────
      test('AM Direction → PM Continues Same Direction', 'AM/PM Pattern',
        'Does the afternoon (12:00-16:00) continue the same direction as the morning (9:30-12:00)?',
        s => s.amDir !== 'flat', s => s.pmContinues),
      test('AM Up → PM Reverses Down', 'AM/PM Pattern',
        'When the morning closes above open, does the afternoon reverse lower?',
        s => s.amDir === 'up', s => s.pmReverses),
      test('AM Down → PM Reverses Up', 'AM/PM Pattern',
        'When the morning closes below open, does the afternoon reverse higher?',
        s => s.amDir === 'down', s => s.pmReverses),
      test('Strong AM Move (>IB range) → PM Reversal', 'AM/PM Pattern',
        'When the AM move exceeds the IB range, does the PM tend to reverse?',
        s => Math.abs(s.amDir==='up'?+1:-1) > 0 && s.amDir !== 'flat',
        s => s.pmReverses),

      // ── BID/ASK DELTA DIVERGENCE (the real edge, not tautology) ─────────────
      // Price up + sell delta = weakness/distribution. Price down + buy delta = absorption/accumulation.
      test('IB Bearish Divergence (price up, sellers dominate) → Day Reverses Down', 'Bid/Ask Delta',
        'Price rises in the IB but selling volume exceeds buying — distribution into strength. Does the day close below open?',
        s => s.ibDeltaDivergence === 'bearish_div', s => s.dayDir === 'down'),
      test('IB Bullish Divergence (price down, buyers dominate) → Day Reverses Up', 'Bid/Ask Delta',
        'Price falls in the IB but buying volume exceeds selling — accumulation on weakness. Does the day close above open?',
        s => s.ibDeltaDivergence === 'bullish_div', s => s.dayDir === 'up'),
      test('IB Bearish Confirmation (price up, buyers dominate) → Day Continues Up', 'Bid/Ask Delta',
        'Price rises AND buying volume dominates — genuine demand. Does the day sustain the upside?',
        s => s.ibDeltaDivergence === 'bullish_conf', s => s.dayDir === 'up'),
      test('IB Bearish Confirmation (price down, sellers dominate) → Day Continues Down', 'Bid/Ask Delta',
        'Price falls AND selling volume dominates — genuine supply. Does the day sustain the downside?',
        s => s.ibDeltaDivergence === 'bearish_conf', s => s.dayDir === 'down'),
      test('Strong Delta Divergence → PM Reversal', 'Bid/Ask Delta',
        'When IB order flow strongly contradicts IB price direction (>8% delta imbalance), does the PM reverse the AM?',
        s => s.ibStrongDelta && (s.ibDeltaDivergence === 'bearish_div' || s.ibDeltaDivergence === 'bullish_div'),
        s => s.pmReverses),
      test('Strong Delta Confirmation → AM/PM Continuation', 'Bid/Ask Delta',
        'When IB order flow strongly agrees with IB price direction, does the AM direction continue through PM?',
        s => s.ibStrongDelta && (s.ibDeltaDivergence === 'bullish_conf' || s.ibDeltaDivergence === 'bearish_conf'),
        s => s.pmContinues),

      // ── CONSECUTIVE DAY PATTERNS ─────────────────────────────────────────────
      test('After 1 Up Day → Next Day Up', 'Consecutive Days',
        'When yesterday closed up, is today also up?',
        s => s.prevDir === 'up', s => s.dayDir === 'up'),
      test('After 1 Down Day → Next Day Down', 'Consecutive Days',
        'When yesterday closed down, is today also down?',
        s => s.prevDir === 'down', s => s.dayDir === 'down'),
      test('After 2 Consecutive Up Days → Next Day Down', 'Consecutive Days',
        'After 2 straight up days, does the market reverse down?',
        s => s.streak >= 2, s => s.dayDir === 'down'),
      test('After 2 Consecutive Down Days → Next Day Up', 'Consecutive Days',
        'After 2 straight down days, does the market reverse up?',
        s => s.streak <= -2, s => s.dayDir === 'up'),
      test('After 3 Consecutive Up Days → Next Day Down', 'Consecutive Days',
        'After 3 straight up days, does the market reverse down?',
        s => s.streak >= 3, s => s.dayDir === 'down'),
      test('After 3 Consecutive Down Days → Next Day Up', 'Consecutive Days',
        'After 3 straight down days, does the market reverse up?',
        s => s.streak <= -3, s => s.dayDir === 'up'),
      test('After Trend Day → Next Day is Range Day', 'Consecutive Days',
        'The day after a strong trend day tends to be a lower-volatility, range-bound session',
        s => s.prevTrend === true, s => !s.trendDay),
      test('After Range Day → Next Day is Trend Day', 'Consecutive Days',
        'After a tight, range-bound day, does the following session expand into a trend?',
        s => s.prevTrend === false, s => s.trendDay),

      // ── VOLUME PATTERNS ───────────────────────────────────────────────────────
      test('Above Avg Volume → Trend Day', 'Volume',
        'When today has more volume than the 20-day average, is it a trend day?',
        s => s.volRatio > 1.25, s => s.trendDay),
      test('Below Avg Volume → Range Day', 'Volume',
        'When today has less volume than the 20-day average, is it a range-bound day?',
        s => s.volRatio < 0.80, s => !s.trendDay),
      test('High Volume After Down Day → Reversal Up', 'Volume',
        'High volume the day after a down day signals institutional accumulation and next-day reversal',
        s => s.prevDir === 'down' && s.volRatio > 1.25, s => s.dayDir === 'up'),
      test('High Volume After Up Day → Reversal Down', 'Volume',
        'High volume the day after an up day may signal distribution and next-day weakness',
        s => s.prevDir === 'up' && s.volRatio > 1.25, s => s.dayDir === 'down'),
      test('Expanding Range (today > yesterday) → Trend Day', 'Volume',
        'When today\'s range exceeds yesterday\'s, is it a trend day?',
        s => s.prevRangeRatio != null && s.rangeRatio > s.prevRangeRatio, s => s.trendDay),

      // ── DAY OF WEEK PATTERNS ──────────────────────────────────────────────────
      test('Monday → Trend Day', 'Day of Week',
        'Mondays have higher or lower trend-day frequency than the baseline',
        s => s.dow === 1, s => s.trendDay),
      test('Tuesday → Trend Day', 'Day of Week',
        'Tuesdays have higher or lower trend-day frequency than the baseline',
        s => s.dow === 2, s => s.trendDay),
      test('Wednesday → Trend Day', 'Day of Week',
        'Wednesdays have higher or lower trend-day frequency than the baseline',
        s => s.dow === 3, s => s.trendDay),
      test('Thursday → Trend Day', 'Day of Week',
        'Thursdays have higher or lower trend-day frequency than the baseline',
        s => s.dow === 4, s => s.trendDay),
      test('Friday → Trend Day', 'Day of Week',
        'Fridays have higher or lower trend-day frequency than the baseline',
        s => s.dow === 5, s => s.trendDay),
      test('Monday → Closes in Direction of Opening Drive', 'Day of Week',
        'On Mondays, does the day close in the same direction as the first 15-min move?',
        s => s.dow === 1 && s.drive15Dir !== 'flat', s => s.dayDir === s.drive15Dir),
      test('Friday → AM Reverses in PM', 'Day of Week',
        'Fridays tend to have PM reversals of the AM direction (profit-taking into weekend)',
        s => s.dow === 5 && s.amDir !== 'flat', s => s.pmReverses),
      test('Wednesday → AM Continues into PM', 'Day of Week',
        'Mid-week sessions tend to continue the AM direction through the close',
        s => s.dow === 3 && s.amDir !== 'flat', s => s.pmContinues),

      // ── OPEN POSITION IN PRIOR DAY RANGE ─────────────────────────────────────
      test('Open in Upper 25% of Prior Range → Day Closes Down', 'Open Position',
        'When today opens in the top quarter of yesterday\'s range, does it tend to close lower (mean reversion)?',
        s => s.openVsPriorRange != null && s.openVsPriorRange > 0.75, s => s.dayDir === 'down'),
      test('Open in Lower 25% of Prior Range → Day Closes Up', 'Open Position',
        'When today opens in the bottom quarter of yesterday\'s range, does it tend to close higher (mean reversion)?',
        s => s.openVsPriorRange != null && s.openVsPriorRange < 0.25, s => s.dayDir === 'up'),
      test('Open Near Middle of Prior Range → Range Day', 'Open Position',
        'Opening in the middle third of the prior day\'s range — does the day stay range-bound?',
        s => s.openVsPriorRange != null && s.openVsPriorRange >= 0.33 && s.openVsPriorRange <= 0.67, s => !s.trendDay),

      // ── VOLATILITY EXPANSION ──────────────────────────────────────────────────
      test('Narrow Range After 2 Narrowing Days → Range Expansion', 'Volatility',
        'After 2 consecutive narrowing-range sessions, does range expand significantly next day?',
        s => s.prevRangeRatio != null && s.rangeRatio < 0.85 && s.prevRangeRatio < 0.85, s => s.rangeRatio > 1.15),
      test('IB Range < 60pts → Day Has High MFE from IB Level', 'Volatility',
        'Narrow IBs (<60pts) set up large moves — is the day range much larger than IB range?',
        s => s.ibRange < 60, s => s.dayRange > s.ibRange * 2.5),

    ].filter(Boolean);

    // Group by category, sort by |edge| within each group
    const catOrder = ['Time of Day','Opening Drive','AM/PM Pattern','Bid/Ask Delta','Consecutive Days','Volume','Day of Week','Open Position','Volatility'];
    const sections = catOrder.map(cat => {
      const items = all.filter(p => p.category === cat).sort((a,b) => Math.abs(b.edge)-Math.abs(a.edge));
      return { category: cat, patterns: items };
    }).filter(s => s.patterns.length > 0);

    // Top 25 across all categories sorted by sig + edge
    const top25 = [...all].sort((a,b) => {
      if (a.sig !== b.sig) return a.sig ? -1 : 1;
      return Math.abs(b.edge) - Math.abs(a.edge);
    }).slice(0, 25);

    res.json({ top25, sections, sessions: N, total: all.length });
  } catch(err) {
    console.error('Edge analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});


// Multer for CSV backtest uploads
const csvDataDir = path.join(__dirname, 'data');
if (!fs.existsSync(csvDataDir)) fs.mkdirSync(csvDataDir, { recursive: true });
const csvUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, csvDataDir),
    filename: (req, file, cb) => cb(null, 'NQ_1min.csv'),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(csv|txt)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('CSV files only'));
  },
});

// ==================== RISK MANAGEMENT ROUTES ====================

// Monte Carlo Risk of Ruin
function calculateRoR(winRate, payoffRatio, riskPct, trials = 5000) {
  if (riskPct <= 0 || winRate <= 0 || winRate >= 1 || payoffRatio <= 0) return null;
  const unitsOfCapital = Math.round(100 / riskPct);
  const successTarget = unitsOfCapital * 50;
  let ruins = 0;
  for (let t = 0; t < trials; t++) {
    let equity = unitsOfCapital;
    for (let s = 0; s < 2000; s++) {
      if (Math.random() < winRate) { equity += payoffRatio; } else { equity -= 1; }
      if (equity <= 0) { ruins++; break; }
      if (equity >= successTarget) break;
    }
  }
  return ruins / trials;
}

// GET /api/risk/q1-winrate — 30-day win rate for quantity=1 trades only
app.get('/api/risk/q1-winrate', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        COUNT(*) as trades,
        COUNT(*) FILTER (WHERE pnl > 0)::float / NULLIF(COUNT(*), 0) as win_rate,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl
      FROM trades
      WHERE quantity = 1
        AND pnl IS NOT NULL
        AND entry_time >= NOW() - INTERVAL '30 days'
    `);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/risk/settings
app.get('/api/risk/settings', async (req, res) => {
  try {
    const r = await query('SELECT * FROM risk_settings ORDER BY id LIMIT 1');
    const s = r.rows[0] || {};
    // If ACD params not yet set, pull best from backtest results
    if (!s.acd_a_multiplier) {
      const best = await query(`SELECT or_minutes, a_multiplier, sustain_minutes, ev_per_signal, period FROM acd_backtest_results ORDER BY ev_per_signal DESC NULLS LAST LIMIT 1`);
      if (best.rows.length) {
        s.acd_or_minutes = best.rows[0].or_minutes;
        s.acd_a_multiplier = best.rows[0].a_multiplier;
        s.acd_sustain_minutes = best.rows[0].sustain_minutes;
        s.acd_best_params_period = best.rows[0].period;
        s.acd_best_params_ev = best.rows[0].ev_per_signal;
      }
    }
    res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/risk/settings
app.post('/api/risk/settings', async (req, res) => {
  try {
    const { account_size, risk_pct_per_trade, instrument, lookback_days, daily_loss_limit_pct } = req.body;
    const existing = await query('SELECT id FROM risk_settings ORDER BY id LIMIT 1');
    let r;
    if (existing.rows.length > 0) {
      r = await query(
        `UPDATE risk_settings SET account_size=$1, risk_pct_per_trade=$2, instrument=$3, lookback_days=$4, daily_loss_limit_pct=$5, updated_at=NOW() WHERE id=$6 RETURNING *`,
        [account_size, risk_pct_per_trade, instrument, lookback_days, daily_loss_limit_pct, existing.rows[0].id]
      );
    } else {
      r = await query(
        `INSERT INTO risk_settings (account_size, risk_pct_per_trade, instrument, lookback_days, daily_loss_limit_pct) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [account_size, risk_pct_per_trade, instrument, lookback_days, daily_loss_limit_pct]
      );
    }
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/risk/stats?days=60&accounts=...
app.get('/api/risk/stats', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 60;
    const accounts = req.query.accounts ? req.query.accounts.split(',') : null;
    const acctFilter = accounts && accounts.length > 0 ? `AND custom_fields->>'account' = ANY($2::text[])` : '';
    const params = accounts && accounts.length > 0 ? [days, accounts] : [days];

    const r = await query(`
      SELECT
        COUNT(*) FILTER (WHERE pnl > 0)::float / NULLIF(COUNT(*),0) as win_rate,
        COALESCE(AVG(pnl) FILTER (WHERE pnl > 0), 0) as avg_win,
        COALESCE(ABS(AVG(pnl) FILTER (WHERE pnl < 0)), 0) as avg_loss,
        COUNT(*) as total_trades,
        COALESCE(SUM(pnl) FILTER (WHERE pnl > 0), 0) as gross_profit,
        COALESCE(ABS(SUM(pnl) FILTER (WHERE pnl < 0)), 0) as gross_loss,
        MIN(entry_time) as earliest_trade,
        MAX(entry_time) as latest_trade
      FROM trades
      WHERE exit_time IS NOT NULL AND pnl IS NOT NULL
        AND entry_time >= NOW() - ($1 || ' days')::interval
        ${acctFilter}
    `, params);

    const row = r.rows[0];
    const winRate = parseFloat(row.win_rate) || 0;
    const avgWin = parseFloat(row.avg_win) || 0;
    const avgLoss = parseFloat(row.avg_loss) || 0;
    const totalTrades = parseInt(row.total_trades) || 0;
    const grossProfit = parseFloat(row.gross_profit) || 0;
    const grossLoss = parseFloat(row.gross_loss) || 0;
    const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;
    const ev = winRate * payoffRatio - (1 - winRate);

    // Current streak from recent trades
    const streakR = await query(`
      SELECT pnl FROM trades
      WHERE exit_time IS NOT NULL AND pnl IS NOT NULL
        AND entry_time >= NOW() - ($1 || ' days')::interval
        ${acctFilter}
      ORDER BY entry_time DESC LIMIT 50
    `, params);

    let currentStreak = 0;
    let maxConsecLosses = 0;
    let curLoss = 0;
    if (streakR.rows.length > 0) {
      const firstWin = parseFloat(streakR.rows[0].pnl) > 0;
      for (const row of streakR.rows) {
        const isWin = parseFloat(row.pnl) > 0;
        if (isWin === firstWin) { currentStreak += firstWin ? 1 : -1; } else break;
      }
      // max consec losses in lookback
      for (const row of streakR.rows) {
        if (parseFloat(row.pnl) < 0) { curLoss++; maxConsecLosses = Math.max(maxConsecLosses, curLoss); }
        else curLoss = 0;
      }
    }

    res.json({ winRate, avgWin, avgLoss, payoffRatio, totalTrades, grossProfit, grossLoss, profitFactor, ev, currentStreak, maxConsecLosses, periodDays: days });
  } catch(e) { console.error('risk/stats error:', e); res.status(500).json({ error: e.message }); }
});

// GET /api/risk/ruin?riskPct=2&days=60&accounts=...
app.get('/api/risk/ruin', async (req, res) => {
  try {
    const riskPct = parseFloat(req.query.riskPct) || 2;
    const cacheKey = `ruin:${riskPct}:${req.query.days}:${req.query.accounts}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const statsRes = await fetch(`http://localhost:${PORT}/api/risk/stats?days=${req.query.days || 60}${req.query.accounts ? '&accounts=' + req.query.accounts : ''}`);
    const stats = await statsRes.json();

    const ror = calculateRoR(stats.winRate, stats.payoffRatio, riskPct);
    const result = { ror, riskPct, winRate: stats.winRate, payoffRatio: stats.payoffRatio, totalTrades: stats.totalTrades };
    cacheSet(cacheKey, result, 5 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/risk/ruin/compare?days=60&accounts=...
app.get('/api/risk/ruin/compare', async (req, res) => {
  try {
    const cacheKey = `ruin:compare:${req.query.days}:${req.query.accounts}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const statsRes = await fetch(`http://localhost:${PORT}/api/risk/stats?days=${req.query.days || 60}${req.query.accounts ? '&accounts=' + req.query.accounts : ''}`);
    const stats = await statsRes.json();

    const result = {
      at1pct: calculateRoR(stats.winRate, stats.payoffRatio, 1),
      at2pct: calculateRoR(stats.winRate, stats.payoffRatio, 2),
      at3pct: calculateRoR(stats.winRate, stats.payoffRatio, 3),
      winRate: stats.winRate,
      payoffRatio: stats.payoffRatio,
      totalTrades: stats.totalTrades,
    };
    cacheSet(cacheKey, result, 5 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/risk/kelly?days=60&accounts=...
app.get('/api/risk/kelly', async (req, res) => {
  try {
    const statsRes = await fetch(`http://localhost:${PORT}/api/risk/stats?days=${req.query.days || 60}${req.query.accounts ? '&accounts=' + req.query.accounts : ''}`);
    const stats = await statsRes.json();
    const p = stats.winRate;
    const b = stats.payoffRatio;
    const kelly = b > 0 ? (p * b - (1 - p)) / b : 0;
    const halfKelly = kelly / 2;
    res.json({ kelly: Math.max(0, kelly), halfKelly: Math.max(0, halfKelly), winRate: p, payoffRatio: b });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/risk/sizing?accountSize=50000&instrument=MNQ&riskPct=2&stopPoints=20
app.get('/api/risk/sizing', async (req, res) => {
  try {
    const accountSize = parseFloat(req.query.accountSize) || 50000;
    const instrument = req.query.instrument || 'MNQ';
    const riskPct = parseFloat(req.query.riskPct) || 2;
    const stopPoints = parseFloat(req.query.stopPoints) || 20;
    const pointValue = instrument === 'NQ' ? 20 : 2;
    const dollarRisk = accountSize * (riskPct / 100);
    const contracts = Math.max(1, Math.floor(dollarRisk / (stopPoints * pointValue)));
    res.json({ accountSize, instrument, riskPct, stopPoints, pointValue, dollarRisk, contracts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sessions/current
app.get('/api/sessions/current', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const session = await query('SELECT * FROM trading_sessions WHERE session_date = $1 ORDER BY id DESC LIMIT 1', [today]);
    const settings = await query('SELECT * FROM risk_settings ORDER BY id LIMIT 1');
    const s = settings.rows[0] || {};

    // Today's P&L from trades
    const pnlRes = await query(`
      SELECT COALESCE(SUM(replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric), 0) as session_pnl
      FROM trades
      WHERE log_date = $1
        AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
        AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
    `, [today]);

    const sessionPnl = parseFloat(pnlRes.rows[0]?.session_pnl) || 0;
    const accountSize = parseFloat(s.account_size) || 50000;
    const limitPct = parseFloat(s.daily_loss_limit_pct) || 2;
    const dailyLimitDollars = accountSize * (limitPct / 100);
    const pctUsed = dailyLimitDollars > 0 ? Math.min(100, Math.abs(Math.min(0, sessionPnl)) / dailyLimitDollars * 100) : 0;
    const limitHit = sessionPnl <= -dailyLimitDollars;

    // Eastern time info
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = nowET.getHours();
    const minute = nowET.getMinutes();
    const totalMinutes = hour * 60 + minute;
    const sessionStart = 9 * 60 + 30;
    const sessionEnd = 11 * 60;
    let phase;
    if (totalMinutes < sessionStart) phase = 'pre';
    else if (totalMinutes >= sessionEnd) phase = 'closed';
    else phase = limitHit ? 'limit_hit' : 'active';

    const minutesToOpen = phase === 'pre' ? sessionStart - totalMinutes : 0;

    res.json({
      phase,
      sessionPnl,
      dailyLimitDollars,
      pctUsed,
      limitHit,
      accountSize,
      limitPct,
      minutesToOpen,
      currentTime: nowET.toTimeString().slice(0, 5),
      sessionRecord: session.rows[0] || null,
      sessionClosed: session.rows[0]?.session_closed || false,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sessions/open
app.post('/api/sessions/open', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const { opening_account_value, daily_loss_limit_pct } = req.body;
    const r = await query(
      `INSERT INTO trading_sessions (session_date, opening_account_value, daily_loss_limit_pct) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING *`,
      [today, opening_account_value, daily_loss_limit_pct]
    );
    res.json(r.rows[0] || { message: 'Session already exists for today' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sessions/close
app.post('/api/sessions/close', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const { closed_reason } = req.body;
    const r = await query(
      `UPDATE trading_sessions SET session_closed=TRUE, closed_reason=$1 WHERE session_date=$2 AND session_closed=FALSE RETURNING *`,
      [closed_reason || 'manual', today]
    );
    res.json(r.rows[0] || { message: 'No open session found' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== ACD ROUTES ====================

// In-memory backtest job state
let acdJob = { status: 'idle', progress: null, result: null, error: null };

// GET /api/acd/today — current day's ACD state + system failure check
app.get('/api/acd/today', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const today = await query('SELECT * FROM acd_daily_log WHERE trade_date = $1', [todayET]);

    // Number line
    const nlRow = await query(`
      SELECT COALESCE(SUM(daily_score), 0) as sum30,
             COALESCE(SUM(CASE WHEN rn <= 10 THEN daily_score ELSE 0 END), 0) as sum10
      FROM (SELECT daily_score, ROW_NUMBER() OVER (ORDER BY trade_date DESC) as rn FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) sub
    `);

    // System failure check: A signal 2-3 days ago that hasn't been confirmed
    const recent = await query(`SELECT trade_date::text as trade_date, daily_score, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed FROM acd_daily_log ORDER BY trade_date DESC LIMIT 4`);
    let systemFailureWarning = null;
    for (const row of recent.rows.slice(1, 4)) {
      const daysAgo = recent.rows.findIndex(r => r.trade_date === row.trade_date);
      if ((row.a_up_fired && !row.c_up_confirmed) || (row.a_down_fired && !row.c_down_confirmed)) {
        const dir = row.a_up_fired ? 'A Up' : 'A Down';
        const since = row.trade_date;
        systemFailureWarning = `System failure check: ${dir} signal from ${since} has not confirmed. Fisher's rule: if no follow-through within 2–3 sessions, exit immediately.`;
        break;
      }
    }

    const settings = await query('SELECT * FROM risk_settings ORDER BY id LIMIT 1');
    const aMultiplier = parseFloat(settings.rows[0]?.a_multiplier || 0.33);

    res.json({
      today: today.rows[0] || null,
      numberLine: { sum30: parseInt(nlRow.rows[0]?.sum30) || 0, sum10: parseInt(nlRow.rows[0]?.sum10) || 0 },
      systemFailureWarning,
      aMultiplier,
      todayDate: todayET,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/acd/daily — log today's ACD result
app.post('/api/acd/daily', async (req, res) => {
  try {
    const { trade_date, or_high, or_low, a_multiplier = 0.33, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, session_close, notes, profile_shape } = req.body;
    const aUpLevel   = or_high && or_low ? parseFloat(or_high) + (parseFloat(or_high) - parseFloat(or_low)) * a_multiplier : null;
    const aDownLevel = or_high && or_low ? parseFloat(or_low)  - (parseFloat(or_high) - parseFloat(or_low)) * a_multiplier : null;

    let score = 0;
    if (a_up_fired   && c_up_confirmed)   score =  4;
    else if (a_up_fired)                  score =  1;
    else if (a_down_fired && c_down_confirmed) score = -4;
    else if (a_down_fired)                score = -1;

    const r = await query(`
      INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close, notes, profile_shape)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (trade_date) DO UPDATE SET
        or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
        a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
        daily_score=$11, session_close=$12, notes=$13,
        profile_shape=COALESCE($14, acd_daily_log.profile_shape)
      RETURNING *
    `, [trade_date, or_high, or_low, a_multiplier, aUpLevel, aDownLevel, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, score, session_close, notes, profile_shape || null]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/daily?days=60 — recent daily log
app.get('/api/acd/daily', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 60;
    const r = await query(`SELECT *, trade_date::text as trade_date_str FROM acd_daily_log ORDER BY trade_date DESC LIMIT $1`, [days]);
    res.json(r.rows.map(row => ({ ...row, trade_date: row.trade_date_str })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/numberline — rolling sums + trend state
app.get('/api/acd/numberline', async (req, res) => {
  try {
    const r = await query(`
      SELECT trade_date, daily_score,
             SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as sum30,
             SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 9 PRECEDING AND CURRENT ROW) as sum10
      FROM acd_daily_log
      ORDER BY trade_date DESC
      LIMIT 90
    `);
    const rows = r.rows;
    const latest = rows[0];
    const sum30 = parseInt(latest?.sum30) || 0;
    const sum10 = parseInt(latest?.sum10) || 0;
    const trend = sum30 > 9 ? 'TRENDING_UP' : sum30 < -9 ? 'TRENDING_DOWN' : 'RANGING';
    const quality = (trend !== 'RANGING' && Math.abs(sum30) > 15) ? 'HIGH' : (trend !== 'RANGING') ? 'MODERATE' : 'LOW';
    const momentumWarning = sum30 > 9 && sum10 < 5 ? 'Momentum weakening — trend may be losing conviction' :
                            sum30 < -9 && sum10 > -5 ? 'Bearish momentum weakening' : null;
    res.json({ sum30, sum10, trend, quality, momentumWarning, history: rows.slice(0, 30).reverse() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/pivot/current — current month's pivot
app.get('/api/acd/pivot/current', async (req, res) => {
  try {
    const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const d = new Date(nowET);
    const monthYear = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const r = await query('SELECT * FROM acd_monthly_pivot WHERE month_year = $1', [monthYear]);
    res.json(r.rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/acd/pivot — save monthly pivot data
app.post('/api/acd/pivot', async (req, res) => {
  try {
    const { month_year, prior_month_high, prior_month_low, prior_month_close } = req.body;
    const ph = parseFloat(prior_month_high), pl = parseFloat(prior_month_low), pc = parseFloat(prior_month_close);
    const pivot = (ph + pl + pc) / 3;
    const r1 = 2 * pivot - pl;
    const s1 = 2 * pivot - ph;
    const r = await query(`
      INSERT INTO acd_monthly_pivot (month_year, prior_month_high, prior_month_low, prior_month_close, pivot_level, pivot_r1, pivot_s1)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (month_year) DO UPDATE SET prior_month_high=$2, prior_month_low=$3, prior_month_close=$4, pivot_level=$5, pivot_r1=$6, pivot_s1=$7
      RETURNING *
    `, [month_year, ph, pl, pc, pivot, r1, s1]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/backtest/results
app.get('/api/acd/backtest/results', async (req, res) => {
  try {
    const period = req.query.period || 'all-time';
    const r = await query('SELECT * FROM acd_backtest_results WHERE period=$1 ORDER BY ev_per_signal DESC NULLS LAST LIMIT 100', [period]);
    const lastRun = await query('SELECT MAX(run_date) as last_run FROM acd_backtest_results WHERE period=$1', [period]);
    res.json({ results: r.rows, lastRun: lastRun.rows[0]?.last_run || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/backtest/status — never include trades arrays, only lightweight state
app.get('/api/acd/backtest/status', (req, res) => {
  res.json({ status: acdJob.status, progress: acdJob.progress, error: acdJob.error });
});

// POST /api/acd/backtest/run — run parameter search from DB (optionally override with uploaded CSV)
app.post('/api/acd/backtest/run', csvUpload.single('csv'), async (req, res) => {
  if (acdJob.status === 'running') return res.status(409).json({ error: 'Backtest already running' });

  const csvPath  = req.file ? req.file.path : null;
  const useDB    = !csvPath;
  const days     = req.body?.days ? parseInt(req.body.days) : null;
  const startDate = days ? new Date(Date.now() - days * 86400000).toISOString().split('T')[0] : null;

  acdJob = { status: 'running', progress: { done: 0, total: 360, source: useDB ? 'db' : 'csv', days: days || 'all' }, result: null, error: null };
  res.json({ message: `Backtest started from ${useDB ? 'price bar database' : 'CSV'}${days ? ` (last ${days} days)` : ''}`, status: 'running' });

  setImmediate(async () => {
    try {
      const results = await runParameterSearch(csvPath, (p) => { acdJob.progress = { ...p, source: useDB ? 'db' : 'csv', days: days || 'all' }; }, startDate);

      // Bulk-replace results for this period (sorted best EV first)
      const period = days ? `last-${days}d` : 'all-time';
      await query('DELETE FROM acd_backtest_results WHERE period=$1', [period]);
      const top = results.slice(0, 360);
      if (top.length > 0) {
        const cols = 18;
        const vals = [];
        const placeholders = top.map((r, i) => {
          const b = i * cols;
          const filterLabel = [
            r.params.nlAligned ? 'NL-aligned' : null,
            r.params.orRangeMax ? `OR<${r.params.orRangeMax}` : null,
            r.params.cConfirmedOnly ? 'C-only' : null,
          ].filter(Boolean).join('+') || 'baseline';
          vals.push(
            r.params.orMinutes, r.params.aMultiplier, r.params.sustainMinutes,
            r.totalSignals, r.winRate, r.avgWinR, r.avgLossR, r.payoffRatio,
            r.evPerTrade, r.profitFactor,
            r.nlAbove9?.winRate ?? null, r.nlBelow9?.winRate ?? null, r.nlRanging?.winRate ?? null,
            r.params.nlAligned ?? false, r.params.orRangeMax ?? null,
            r.params.cConfirmedOnly ?? false, filterLabel, period
          );
          return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18})`;
        });
        await query(`INSERT INTO acd_backtest_results (or_minutes,a_multiplier,sustain_minutes,total_signals,win_rate,avg_win_r,avg_loss_r,payoff_ratio,ev_per_signal,profit_factor,win_rate_nl_above_9,win_rate_nl_below_9,win_rate_nl_ranging,nl_aligned,or_range_max,c_confirmed_only,filter_label,period) VALUES ${placeholders.join(',')}`, vals);
      }
      // Auto-save best parameters from the most recent backtest period
      // Priority: last-30d > last-60d > all-time (more recent = more relevant)
      const bestPeriodPriority = ['last-30d', 'last-60d', 'all-time'];
      const bestPeriodToUse = bestPeriodPriority.includes(period) ? period : 'all-time';
      const bestResult = top[0];
      if (bestResult) {
        await query(`
          UPDATE risk_settings SET
            acd_or_minutes=$1, acd_a_multiplier=$2, acd_sustain_minutes=$3,
            acd_best_params_period=$4, acd_best_params_ev=$5
        `, [bestResult.params.orMinutes, bestResult.params.aMultiplier, bestResult.params.sustainMinutes,
            bestPeriodToUse, bestResult.evPerTrade]);
        console.log(`📐 ACD best params auto-saved: OR=${bestResult.params.orMinutes}m A=${bestResult.params.aMultiplier} sus=${bestResult.params.sustainMinutes} (${bestPeriodToUse}, EV=${bestResult.evPerTrade.toFixed(3)}R)`);
      }
      acdJob = { status: 'complete', progress: { done: top.length, total: results.length }, error: null };
    } catch(e) {
      acdJob = { status: 'error', progress: acdJob.progress, result: null, error: e.message };
    }
  });
});

// ── ACD auto-computation from price_bars ─────────────────────────────────────
// Bars are stored with ET face values at UTC: 09:30 ET = 09:30 UTC

function addMins(hhmm, n) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + n;
  return `${String(Math.floor(t / 60)).padStart(2,'0')}:${String(t % 60).padStart(2,'0')}`;
}

function minsFromBar(ts) {
  const d = new Date(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

async function computeACDFromBars(date, orMinutes, aMultiplier, sustainMinutes) {
  const orEndMin = 9 * 60 + 30 + orMinutes;
  const sessionEndMin = 11 * 60;

  const bars = await query(`
    SELECT ts, open, high, low, close
    FROM price_bars
    WHERE symbol = 'NQ'
      AND ts >= ($1::date + time '09:30:00')
      AND ts <  ($1::date + time '16:15:00')
    ORDER BY ts ASC
  `, [date]);

  if (bars.rows.length === 0) return null;

  // Opening Range
  const orBars = bars.rows.filter(b => minsFromBar(b.ts) < orEndMin);
  if (orBars.length === 0) return null;
  const orHigh = Math.max(...orBars.map(b => parseFloat(b.high)));
  const orLow  = Math.min(...orBars.map(b => parseFloat(b.low)));
  const orRange = orHigh - orLow;
  if (orRange === 0) return null;

  const aUp   = orHigh + orRange * aMultiplier;
  const aDown = orLow  - orRange * aMultiplier;

  // A signal detection (09:30+orMin to 11:00)
  const postOrBars = bars.rows.filter(b => {
    const m = minsFromBar(b.ts);
    return m >= orEndMin && m < sessionEndMin;
  });

  let aUpReachedMin = null, aDownReachedMin = null;
  let aUpFired = false, aDownFired = false, aUpTime = null, aDownTime = null;

  for (const bar of postOrBars) {
    const barMin = minsFromBar(bar.ts);
    const h = parseFloat(bar.high), l = parseFloat(bar.low);

    if (!aDownReachedMin) {
      if (aUpReachedMin === null && h >= aUp) aUpReachedMin = barMin;
      if (aUpReachedMin !== null) {
        if (l < orHigh) { aUpReachedMin = null; }
        else if (barMin - aUpReachedMin >= sustainMinutes) {
          aUpFired = true;
          aUpTime = new Date(bar.ts).toISOString().slice(11, 16);
          break;
        }
      }
    }

    if (!aUpReachedMin) {
      if (aDownReachedMin === null && l <= aDown) aDownReachedMin = barMin;
      if (aDownReachedMin !== null) {
        if (h > orLow) { aDownReachedMin = null; }
        else if (barMin - aDownReachedMin >= sustainMinutes) {
          aDownFired = true;
          aDownTime = new Date(bar.ts).toISOString().slice(11, 16);
          break;
        }
      }
    }
  }

  // C signal (bar closing above OR High or below OR Low, after 10:00)
  const lateBars = bars.rows.filter(b => minsFromBar(b.ts) >= 10 * 60);
  let cUpConfirmed = false, cDownConfirmed = false;
  for (const bar of lateBars) {
    const c = parseFloat(bar.close);
    if (aUpFired   && c > orHigh) { cUpConfirmed   = true; break; }
    if (aDownFired && c < orLow)  { cDownConfirmed = true; break; }
  }

  // Session close
  const sessionClose = parseFloat(bars.rows[bars.rows.length - 1]?.close) || null;
  const sessionHigh  = Math.max(...bars.rows.map(b => parseFloat(b.high)));
  const sessionLow   = Math.min(...bars.rows.map(b => parseFloat(b.low)));

  // Score
  let score = 0;
  if (aUpFired   && cUpConfirmed)   score =  4;
  else if (aUpFired)                score =  1;
  else if (aDownFired && cDownConfirmed) score = -4;
  else if (aDownFired)              score = -1;

  const aUpLevel   = Math.round(aUp   * 100) / 100;
  const aDownLevel = Math.round(aDown * 100) / 100;

  return { date, orHigh, orLow, orRange, aUpLevel, aDownLevel, aUpFired, aUpTime, aDownFired, aDownTime, cUpConfirmed, cDownConfirmed, score, sessionClose, sessionHigh, sessionLow };
}

// GET /api/acd/context — prior day VAH/VAL/POC + A level positioning
app.get('/api/acd/context', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Find the prior trading day (last day with NQ bars before today)
    const prevRes = await query(`
      SELECT DISTINCT ts::date::text as d FROM price_bars
      WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY d DESC LIMIT 1
    `, [todayET]);
    if (!prevRes.rows.length) return res.json(null);
    const prevDate = prevRes.rows[0].d;

    // Get prior day RTH bars
    const bars = await query(`
      SELECT high::float, low::float, volume::bigint
      FROM price_bars
      WHERE symbol='NQ' AND ts::date = $1
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY ts
    `, [prevDate]);
    if (!bars.rows.length) return res.json(null);

    // Build volume profile
    const TICK = 0.25;
    const volMap = {};
    for (const bar of bars.rows) {
      const h = Math.round(bar.high / TICK) * TICK;
      const l = Math.round(bar.low  / TICK) * TICK;
      const v = bar.volume || 1;
      const steps = Math.round((h - l) / TICK) + 1;
      const vPerStep = v / steps;
      for (let i = 0; i < steps; i++) {
        const p = Math.round((l + i * TICK) * 100) / 100;
        volMap[p] = (volMap[p] || 0) + vPerStep;
      }
    }
    const levels = Object.keys(volMap).map(Number).sort((a, b) => a - b);
    if (!levels.length) return res.json(null);

    // POC
    const poc = levels.reduce((best, p) => volMap[p] > volMap[best] ? p : best, levels[0]);
    const pocIdx = levels.indexOf(poc);
    const totalVol = Object.values(volMap).reduce((s, v) => s + v, 0);
    const target = totalVol * 0.70;
    let vaVol = volMap[poc], lo = pocIdx, hi = pocIdx;
    while (vaVol < target) {
      const upVol = hi + 1 < levels.length ? volMap[levels[hi + 1]] : 0;
      const dnVol = lo - 1 >= 0 ? volMap[levels[lo - 1]] : 0;
      if (upVol >= dnVol && hi + 1 < levels.length) { hi++; vaVol += upVol; }
      else if (lo - 1 >= 0) { lo--; vaVol += dnVol; }
      else break;
    }
    const vah = levels[hi];
    const val = levels[lo];

    // Session high/low/close
    const sessionHigh  = Math.max(...bars.rows.map(b => b.high));
    const sessionLow   = Math.min(...bars.rows.map(b => b.low));

    const cacheKey = `acd-context-${todayET}`;
    const result = { prevDate, poc, vah, val, sessionHigh, sessionLow };
    cacheSet(cacheKey, result, 4 * 60 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save setup events from a completed session's bar scan
async function saveSetupEvents(date, timeline, orH, orL, aUp, aDown, sessionHigh, sessionLow) {
  if (!timeline || timeline.length === 0) return;
  const orEndMin = 9 * 60 + 35;
  for (const ev of timeline) {
    try {
      const [hh, mm] = ev.time.split(':').map(Number);
      const minsFromOR = hh * 60 + mm - orEndMin;
      // Normalize setup type (strip attempt suffix for consistency)
      const setupType = ev.event.replace(/ \(attempt \d+\)$/, '').replace(/ \(re-test \d+\)$/, '');
      await query(`
        INSERT INTO acd_setup_events
          (trade_date, setup_type, fired_time, fired_price, minutes_from_or, or_high, or_low, a_up_level, a_down_level, session_high, session_low)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (trade_date, setup_type, fired_time) DO NOTHING
      `, [date, setupType, ev.time + ':00', ev.price, minsFromOR, orH, orL, aUp, aDown, sessionHigh, sessionLow]);
    } catch(e) { /* skip duplicates */ }
  }
}

// Compute structural context levels for a given historical date
// Returns: { gLine, pwHigh, pwLow, pmVAH, pmVAL }
// Uses the corrected 9:30+ filter for G-Line so the backfill is clean from day one.
async function getStructuralLevels(date) {
  const [yr, mo, dy] = date.split('-').map(Number);

  // G-Line: first RTH bar (≥9:30) of Monday of the week containing `date`
  const gQ = await query(`
    SELECT (array_agg(open ORDER BY ts ASC))[1]::float as g
    FROM price_bars WHERE symbol='NQ'
      AND ts::date >= date_trunc('week', ($1::text)::date)
      AND ts::date <= ($1::text)::date
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
      AND EXTRACT(hour FROM ts) < 16
  `, [date]);
  const gLine = gQ.rows[0]?.g || null;

  // Prior week RTH high/low (9:30–16:00, not pre-market)
  const pwQ = await query(`
    SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low
    FROM price_bars WHERE symbol='NQ'
      AND ts::date >= date_trunc('week', ($1::text)::date) - INTERVAL '7 days'
      AND ts::date <  date_trunc('week', ($1::text)::date)
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
      AND EXTRACT(hour FROM ts) < 16
  `, [date]);
  const pwHigh = pwQ.rows[0]?.pw_high || null;
  const pwLow  = pwQ.rows[0]?.pw_low  || null;

  // Prior month value area — volume profile from prior calendar month's RTH bars
  const pmStart = new Date(Date.UTC(yr, mo - 2, 1)).toISOString().split('T')[0]; // 1st of prior month
  const pmEnd   = new Date(Date.UTC(yr, mo - 1, 1)).toISOString().split('T')[0]; // 1st of current month
  const pmVpQ = await query(`
    WITH vp AS (
      SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
      FROM price_bars WHERE symbol='NQ'
        AND ts >= $1::date AND ts < $2::date
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
        AND EXTRACT(hour FROM ts) < 16
      GROUP BY ROUND(low/0.25)*0.25
    ), total AS (SELECT SUM(vol) as t FROM vp),
    poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
    SELECT p.poc_px::float as poc,
      (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv
        FROM vp WHERE px >= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
      (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv
        FROM vp WHERE px <= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
    FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
  `, [pmStart, pmEnd]);
  const pmVAH = pmVpQ.rows[0]?.vah || null;
  const pmVAL = pmVpQ.rows[0]?.val || null;

  return { gLine, pwHigh, pwLow, pmVAH, pmVAL };
}

// Scan a single session's RTH bars for structural level events (G-Line, PW, PM)
// and save them to acd_setup_events alongside the existing A/C events.
async function scanStructuralEvents(date) {
  try {
    // Fetch levels for this date
    const { gLine, pwHigh, pwLow, pmVAH, pmVAL } = await getStructuralLevels(date);
    if (!gLine && !pwHigh && !pwLow && !pmVAH && !pmVAL) return; // no levels to scan

    // OR levels for saving reference in the event row
    const acdRow = await query(`SELECT or_high::float, or_low::float, a_up_level::float, a_down_level::float FROM acd_daily_log WHERE trade_date=$1`, [date]);
    if (!acdRow.rows.length) return;
    const { or_high: orH, or_low: orL, a_up_level: aUp, a_down_level: aDown } = acdRow.rows[0];

    // Fetch full RTH bars for this session (9:35 → 16:00, post-OR)
    const bars = await query(`
      SELECT ts, high::float, low::float, close::float,
             EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as bar_min
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 575 AND 959
      ORDER BY ts
    `, [date]);
    if (!bars.rows.length) return;

    const sessionHigh = Math.max(...bars.rows.map(b => b.high));
    const sessionLow  = Math.min(...bars.rows.map(b => b.low));
    const timeline = [];

    // State flags
    let gLineTouched = false, gLineLost = false, gLineReclaimed = false;
    let pwHighTouched = false, pwHighBroken = false;
    let pwLowTouched  = false, pwLowBroken  = false;
    let pmVAHTouched  = false, pmVAHBroken  = false;
    let pmVALTouched  = false, pmVALBroken  = false;

    for (const bar of bars.rows) {
      const t = new Date(bar.ts).toISOString().slice(11, 16);
      const { high: hi, low: lo, close: cl } = bar;

      // G-Line events (weekly open)
      if (gLine) {
        if (!gLineTouched && lo <= gLine && hi >= gLine) {
          gLineTouched = true;
          timeline.push({ time: t, event: 'G-Line tested', price: gLine });
        }
        if (!gLineLost && cl < gLine) {
          gLineLost = true;
          timeline.push({ time: t, event: 'G-Line lost', price: cl });
        }
        if (gLineLost && !gLineReclaimed && cl > gLine) {
          gLineReclaimed = true;
          timeline.push({ time: t, event: 'G-Line reclaimed', price: cl });
        }
      }

      // Prior week high
      if (pwHigh) {
        if (!pwHighTouched && hi >= pwHigh) {
          pwHighTouched = true;
          timeline.push({ time: t, event: 'PW High tested', price: pwHigh });
        }
        if (!pwHighBroken && cl > pwHigh) {
          pwHighBroken = true;
          timeline.push({ time: t, event: 'PW High broken', price: cl });
        }
      }

      // Prior week low
      if (pwLow) {
        if (!pwLowTouched && lo <= pwLow) {
          pwLowTouched = true;
          timeline.push({ time: t, event: 'PW Low tested', price: pwLow });
        }
        if (!pwLowBroken && cl < pwLow) {
          pwLowBroken = true;
          timeline.push({ time: t, event: 'PW Low broken', price: cl });
        }
      }

      // Prior month VAH
      if (pmVAH) {
        if (!pmVAHTouched && hi >= pmVAH) {
          pmVAHTouched = true;
          timeline.push({ time: t, event: 'PM VAH tested', price: pmVAH });
        }
        if (!pmVAHBroken && cl > pmVAH) {
          pmVAHBroken = true;
          timeline.push({ time: t, event: 'PM VAH broken', price: cl });
        }
      }

      // Prior month VAL
      if (pmVAL) {
        if (!pmVALTouched && lo <= pmVAL) {
          pmVALTouched = true;
          timeline.push({ time: t, event: 'PM VAL tested', price: pmVAL });
        }
        if (!pmVALBroken && cl < pmVAL) {
          pmVALBroken = true;
          timeline.push({ time: t, event: 'PM VAL broken', price: cl });
        }
      }
    }

    await saveSetupEvents(date, timeline, orH, orL, aUp, aDown, sessionHigh, sessionLow);
    return timeline.length;
  } catch(e) {
    console.error(`scanStructuralEvents error for ${date}:`, e.message);
    return 0;
  }
}

// Run timeline scan for a historical date and save events
async function scanAndSaveSetupEvents(date) {
  try {
    const logged = await query(`SELECT or_high, or_low, a_up_level, a_down_level FROM acd_daily_log WHERE trade_date=$1`, [date]);
    if (!logged.rows.length || !logged.rows[0].or_high) return;
    const { or_high, or_low, a_up_level, a_down_level } = logged.rows[0];
    const orH = parseFloat(or_high), orL = parseFloat(or_low);
    const aUp = parseFloat(a_up_level), aDown = parseFloat(a_down_level);
    const orEndMin = 9 * 60 + 35;
    const rthEndMin = 16 * 60;

    const bars = await query(`
      SELECT ts, high::float, low::float, close::float,
             EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as bar_min
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN $2 AND $3
      ORDER BY ts
    `, [date, orEndMin, rthEndMin]);
    if (!bars.rows.length) return;

    const postOR = bars.rows;
    const sessionHigh = Math.max(...postOR.map(b => b.high));
    const sessionLow  = Math.min(...postOR.map(b => b.low));

    // Run timeline scan — 15-bar cooldown after each failure before re-triggering
    let aUpTouchTime = null, aUpFiredTimeline = false, aDownFiredTimeline = false;
    let failedAUpCount = 0, failedADownCount = 0;
    let aDownTouchTime = null, cUpLogged = false, cDownLogged = false;
    let aUpCooldown = 0, aDownCooldown = 0; // bars remaining in cooldown
    const timeline = [];

    for (const bar of postOR) {
      const t = new Date(bar.ts).toISOString().slice(11, 16);
      const bm = bar.bar_min;

      if (aUpCooldown > 0) aUpCooldown--;
      if (aDownCooldown > 0) aDownCooldown--;

      if (!aDownFiredTimeline) {
        if (!aUpFiredTimeline) {
          if (!aUpTouchTime && aUpCooldown === 0 && bar.high >= aUp) { aUpTouchTime = t; timeline.push({ time: t, event: failedAUpCount > 0 ? `A Up tested (re-test ${failedAUpCount+1})` : 'A Up tested', price: aUp }); }
          if (aUpTouchTime) {
            if (bar.low < orH) { failedAUpCount++; timeline.push({ time: t, event: `Failed A Up${failedAUpCount > 1 ? ` (attempt ${failedAUpCount})` : ''}`, price: bar.close }); aUpTouchTime = null; aUpCooldown = 15; }
            else if (bm - (parseInt(aUpTouchTime.split(':')[0])*60+parseInt(aUpTouchTime.split(':')[1])) >= 5) { aUpFiredTimeline = true; timeline.push({ time: t, event: 'A Up fired', price: aUp }); aUpTouchTime = 'fired'; }
          }
        } else {
          if (bar.low < orH && aUpTouchTime !== 'reversed') { aUpTouchTime = 'reversed'; failedAUpCount++; timeline.push({ time: t, event: `Failed A Up${failedAUpCount > 1 ? ` (attempt ${failedAUpCount})` : ''}`, price: bar.close }); aUpCooldown = 15; }
          else if (aUpCooldown === 0 && aUpTouchTime === 'reversed' && bar.high >= aUp) { aUpTouchTime = t; timeline.push({ time: t, event: `A Up tested (re-test ${failedAUpCount+1})`, price: aUp }); }
          else if (aUpTouchTime && aUpTouchTime !== 'reversed' && aUpTouchTime !== 'fired' && bar.low < orH) { failedAUpCount++; timeline.push({ time: t, event: `Failed A Up (attempt ${failedAUpCount})`, price: bar.close }); aUpTouchTime = 'reversed'; aUpCooldown = 15; }
        }
      }
      if (!aUpFiredTimeline && !aDownFiredTimeline) {
        if (!aDownTouchTime && aDownCooldown === 0 && bar.low <= aDown) { aDownTouchTime = t; timeline.push({ time: t, event: failedADownCount > 0 ? `A Down tested (re-test ${failedADownCount+1})` : 'A Down tested', price: aDown }); }
        if (aDownTouchTime) {
          if (bar.high > orL) { failedADownCount++; timeline.push({ time: t, event: `Failed A Down${failedADownCount > 1 ? ` (attempt ${failedADownCount})` : ''}`, price: bar.close }); aDownTouchTime = null; aDownCooldown = 15; }
          else if (bm - (parseInt(aDownTouchTime.split(':')[0])*60+parseInt(aDownTouchTime.split(':')[1])) >= 5) { aDownFiredTimeline = true; timeline.push({ time: t, event: 'A Down fired', price: aDown }); aDownTouchTime = null; }
        }
      }
      if (!cUpLogged && bar.close > orH) { cUpLogged = true; timeline.push({ time: t, event: aUpFiredTimeline ? 'C Up confirmed' : 'C Up (no A)', price: bar.close }); }
      if (!cDownLogged && bar.close < orL) { cDownLogged = true; timeline.push({ time: t, event: aDownFiredTimeline ? 'C Down confirmed' : 'C Down (no A)', price: bar.close }); }
    }

    await saveSetupEvents(date, timeline, orH, orL, aUp, aDown, sessionHigh, sessionLow);
    // Also scan structural levels (G-Line, PW, PM) for this session
    await scanStructuralEvents(date);
  } catch(e) { /* silent */ }
}

// GET /api/auction-read/day-setups?date=YYYY-MM-DD
// Returns only profitable setups from ACD events + key level interactions
app.get('/api/auction-read/day-setups', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    // Get bars + levels
    const barsR = await query(`
      SELECT ts, open::float, high::float, low::float, close::float, volume::bigint,
             SUM(close::float * volume::bigint) OVER (ORDER BY ts) /
             NULLIF(SUM(volume::bigint) OVER (ORDER BY ts), 0) as vwap_running
      FROM price_bars
      WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960
      ORDER BY ts
    `, [date]);
    const bars = barsR.rows;
    if (!bars.length) return res.json([]);

    // Get key levels from prior day
    const priorR = await query(`
      SELECT MAX(ts::date::text) as prior_date FROM price_bars
      WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    `, [date]);
    const priorDate = priorR.rows[0]?.prior_date;

    let pdHigh = null, pdLow = null, pdVAH = null, pdVAL = null, onHigh = null, onLow = null;
    if (priorDate) {
      const pd = await query(`
        SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars
        WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [priorDate]);
      pdHigh = pd.rows[0]?.h; pdLow = pd.rows[0]?.l;

      // Prior day VA
      const vaR = await query(`
        WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
        total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT p2.px::float as poc,
          (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
          (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
        FROM vp, poc_row p2 GROUP BY p2.px LIMIT 1
      `, [priorDate]);
      pdVAH = vaR.rows[0]?.vah; pdVAL = vaR.rows[0]?.val;

      // Overnight range (bars between 16:00 prior and 09:30 today)
      const onR = await query(`
        SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars
        WHERE symbol='NQ' AND ts::date=$1 AND (EXTRACT(hour FROM ts) >= 16 OR EXTRACT(hour FROM ts) < 9)
      `, [priorDate]);
      onHigh = onR.rows[0]?.h; onLow = onR.rows[0]?.l;
    }

    // ACD levels
    const acdR = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [date]);
    const ibHigh = acdR.rows[0]?.or_high, ibLow = acdR.rows[0]?.or_low;

    // Key levels to test
    const keyLevels = [
      { key: 'IBH',    price: ibHigh,  type: 'resistance', desc: 'Initial Balance High' },
      { key: 'IBL',    price: ibLow,   type: 'support',    desc: 'Initial Balance Low'  },
      { key: 'PD VAH', price: pdVAH,   type: 'resistance', desc: 'Prior Day Value Area High' },
      { key: 'PD VAL', price: pdVAL,   type: 'support',    desc: 'Prior Day Value Area Low'  },
      { key: 'PD High',price: pdHigh,  type: 'resistance', desc: 'Prior Day High' },
      { key: 'PD Low', price: pdLow,   type: 'support',    desc: 'Prior Day Low'  },
      { key: 'ON High',price: onHigh,  type: 'resistance', desc: 'Overnight High'  },
      { key: 'ON Low', price: onLow,   type: 'support',    desc: 'Overnight Low'   },
    ].filter(l => l.price);

    // For each level, find the first test and measure subsequent move
    const TOUCH_RANGE = 8; // pts to consider "testing" the level
    const MEASURE_BARS = 30; // bars to measure reaction (~30 min)
    const MIN_MOVE = 15; // minimum pts to call "profitable"

    const profitable = [];

    for (const lvl of keyLevels) {
      const p = parseFloat(lvl.price);
      for (let i = 10; i < bars.length - MEASURE_BARS; i++) {
        const bar = bars[i];
        const touched = lvl.type === 'resistance'
          ? bar.high >= p - TOUCH_RANGE && bar.high <= p + TOUCH_RANGE
          : bar.low <= p + TOUCH_RANGE && bar.low >= p - TOUCH_RANGE;
        if (!touched) continue;

        // Measure reaction over next MEASURE_BARS
        const futBars = bars.slice(i + 1, i + MEASURE_BARS + 1);
        const futClose = futBars[futBars.length - 1]?.close;
        if (!futClose) break;

        const move = lvl.type === 'resistance'
          ? bar.high - Math.min(...futBars.map(b => b.low))   // resistance: how far did it drop
          : Math.max(...futBars.map(b => b.high)) - bar.low;  // support: how far did it rise

        if (move >= MIN_MOVE) {
          const time = new Date(bar.ts).toISOString().slice(11, 16);
          profitable.push({
            type: 'KEY_LEVEL',
            setup: lvl.key,
            desc: lvl.desc,
            level_type: lvl.type,
            price: p,
            time,
            move_pts: Math.round(move),
            direction: lvl.type === 'resistance' ? 'SHORT' : 'LONG',
          });
        }
        break; // only count first test
      }
    }

    // ACD setups - check if move was profitable
    const acdEvents = await query(`
      SELECT setup_type, TO_CHAR(fired_time,'HH24:MI') as fired_time, fired_price::float
      FROM acd_setup_events WHERE trade_date=$1 ORDER BY fired_time
    `, [date]);

    for (const ev of acdEvents.rows) {
      const isLong  = ev.setup_type?.includes('A_UP') && !ev.setup_type?.includes('Failed');
      const isShort = ev.setup_type?.includes('A_DOWN') && !ev.setup_type?.includes('Failed') ||
                      ev.setup_type?.includes('Failed_A_Up');
      const isLong2 = ev.setup_type?.includes('Failed_A_Down');
      if (!isLong && !isShort && !isLong2) continue;

      const barIdx = bars.findIndex(b => new Date(b.ts).toISOString().slice(11, 16) === ev.fired_time);
      if (barIdx < 0 || barIdx >= bars.length - MEASURE_BARS) continue;

      const futBars = bars.slice(barIdx + 1, barIdx + MEASURE_BARS + 1);
      if (!futBars.length) continue;

      const entryPrice = parseFloat(ev.fired_price);
      let movePts;
      if (isLong || isLong2) {
        movePts = Math.max(...futBars.map(b => b.high)) - entryPrice;
      } else {
        movePts = entryPrice - Math.min(...futBars.map(b => b.low));
      }

      if (movePts >= MIN_MOVE) {
        profitable.push({
          type: 'ACD',
          setup: ev.setup_type.replace(/_/g, ' '),
          desc: '',
          level_type: (isLong || isLong2) ? 'support' : 'resistance',
          price: entryPrice,
          time: ev.fired_time,
          move_pts: Math.round(movePts),
          direction: (isLong || isLong2) ? 'LONG' : 'SHORT',
        });
      }
    }

    // VWAP interaction setups
    for (let i = 10; i < bars.length - MEASURE_BARS; i++) {
      const bar = bars[i];
      const vwap = bar.vwap_running;
      if (!vwap) continue;
      // Look for VWAP cross/reclaim
      const prev = bars[i - 1];
      if (!prev?.vwap_running) continue;
      const crossUp   = prev.close < prev.vwap_running && bar.close > vwap;
      const crossDown = prev.close > prev.vwap_running && bar.close < vwap;
      if (!crossUp && !crossDown) continue;

      const futBars = bars.slice(i + 1, i + MEASURE_BARS + 1);
      const move = crossUp
        ? Math.max(...futBars.map(b => b.high)) - bar.close
        : bar.close - Math.min(...futBars.map(b => b.low));

      if (move >= MIN_MOVE) {
        const time = new Date(bar.ts).toISOString().slice(11, 16);
        profitable.push({
          type: 'VWAP',
          setup: crossUp ? 'VWAP Reclaim' : 'VWAP Break',
          desc: crossUp ? 'Price crossed above VWAP — buyers taking control' : 'Price crossed below VWAP — sellers taking control',
          level_type: crossUp ? 'support' : 'resistance',
          price: parseFloat(vwap.toFixed(2)),
          time,
          move_pts: Math.round(move),
          direction: crossUp ? 'LONG' : 'SHORT',
        });
        break; // first VWAP cross only
      }
    }

    // Sort by move size descending
    profitable.sort((a, b) => b.move_pts - a.move_pts);
    res.json(profitable);
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /api/acd/setup-events/day?date=YYYY-MM-DD — events for a specific day
app.get('/api/acd/setup-events/day', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });
    const r = await query(`
      SELECT setup_type, TO_CHAR(fired_time,'HH24:MI') as fired_time,
             fired_price::numeric(8,2), minutes_from_or
      FROM acd_setup_events WHERE trade_date=$1
      ORDER BY fired_time
    `, [date]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/setup-events/stats — time-of-day patterns across all logged events
app.get('/api/acd/setup-events/stats', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        setup_type,
        COUNT(*) as occurrences,
        ROUND(AVG(minutes_from_or)) as avg_minutes_from_or,
        MIN(minutes_from_or) as earliest_minutes,
        MAX(minutes_from_or) as latest_minutes,
        TO_CHAR(MIN(fired_time), 'HH24:MI') as earliest_time,
        TO_CHAR(MAX(fired_time), 'HH24:MI') as latest_time,
        TO_CHAR(TIME '09:35' + (ROUND(AVG(minutes_from_or)) || ' minutes')::INTERVAL, 'HH24:MI') as avg_fire_time
      FROM acd_setup_events
      GROUP BY setup_type
      ORDER BY occurrences DESC
    `);
    // Also get time distribution by 30-min bucket
    const dist = await query(`
      SELECT
        setup_type,
        FLOOR(minutes_from_or / 30) * 30 as bucket_minutes,
        TO_CHAR(TIME '09:35' + (FLOOR(minutes_from_or / 30) * 30 || ' minutes')::INTERVAL, 'HH24:MI') as bucket_label,
        COUNT(*) as count
      FROM acd_setup_events
      WHERE minutes_from_or >= 0
      GROUP BY setup_type, bucket_minutes
      ORDER BY setup_type, bucket_minutes
    `);
    res.json({ stats: r.rows, distribution: dist.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/setup-events — recent setup event log
app.get('/api/acd/setup-events', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const r = await query(`
      SELECT trade_date::text, setup_type, TO_CHAR(fired_time, 'HH24:MI') as fired_time,
             fired_price::numeric(8,2), minutes_from_or
      FROM acd_setup_events
      ORDER BY trade_date DESC, fired_time ASC
      LIMIT $1
    `, [limit]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/live — real-time setup detection from today's bars
app.get('/api/acd/live', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Get today's logged OR and A levels
    const logged = await query(`SELECT or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
    if (!logged.rows.length || !logged.rows[0].or_high) return res.json({ setup: null, reason: 'No OR data for today' });

    // G-Line: weekly open = first RTH bar of Monday (strictly 9:30+, not pre-market)
    const gLineQ = await query(`
      SELECT (array_agg(open ORDER BY ts ASC))[1]::float as g_line
      FROM price_bars WHERE symbol='NQ'
        AND ts::date >= date_trunc('week', CURRENT_DATE)
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
        AND EXTRACT(hour FROM ts) < 16
    `);
    const gLine = gLineQ.rows[0]?.g_line || null;

    // Prior week RTH high/low
    const pwQ = await query(`
      SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low
      FROM price_bars WHERE symbol='NQ'
        AND ts::date >= date_trunc('week', CURRENT_DATE) - INTERVAL '7 days'
        AND ts::date <  date_trunc('week', CURRENT_DATE)
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    `);
    const pwHigh = pwQ.rows[0]?.pw_high || null;
    const pwLow  = pwQ.rows[0]?.pw_low  || null;

    // Prior month value area (VAH/POC/VAL from volume profile)
    const pmVaQ = await query(`
      WITH vp AS (
        SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
        FROM price_bars WHERE symbol='NQ'
          AND date_trunc('month', ts) = date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY ROUND(low/0.25)*0.25
      ), total AS (SELECT SUM(vol) as t FROM vp),
      poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
      SELECT p.poc_px::float as poc,
        (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
        (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
      FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
    `);
    const pmVAH = pmVaQ.rows[0]?.vah || null;
    const pmVAL = pmVaQ.rows[0]?.val || null;
    const pmPOC = pmVaQ.rows[0]?.poc || null;

    const { or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired } = logged.rows[0];
    const orH = parseFloat(or_high), orL = parseFloat(or_low);
    const aUp = parseFloat(a_up_level), aDown = parseFloat(a_down_level);
    const orRange = orH - orL;
    const orEndMin = 9 * 60 + 35; // 09:35 ET

    // Get today's post-OR bars — RTH only (9:35–16:00)
    // After-hours bars would give false signals since ACD is a morning-session framework
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const isRTH = nowET.getHours() < 16 || (nowET.getHours() === 16 && nowET.getMinutes() === 0);
    const rthEndMin = 16 * 60; // 16:00

    const bars = await query(`
      SELECT ts, high::float, low::float, close::float, volume::bigint,
             EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as bar_min
      FROM price_bars
      WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= $2
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) <= $3
      ORDER BY ts
    `, [todayET, orEndMin, rthEndMin]);

    if (!bars.rows.length) return res.json({ setup: null, reason: 'No post-OR bars yet' });

    const postOR = bars.rows;
    const sessionHigh = Math.max(...postOR.map(b => b.high));
    const sessionLow  = Math.min(...postOR.map(b => b.low));
    const latestBar   = postOR[postOR.length - 1];
    const currentPrice = latestBar.close;
    const barTime = new Date(latestBar.ts).toISOString().slice(11, 16);

    // Detect all 6 setups
    const reachedAUp   = sessionHigh >= aUp;
    const reachedADown = sessionLow  <= aDown;
    const cUp   = postOR.some(b => b.close > orH);
    const cDown = postOR.some(b => b.close < orL);

    // Failed A: reached level but price has since fallen back inside OR (or below OR High / above OR Low)
    const failedAUp   = reachedAUp   && !a_up_fired   && currentPrice < orH;
    const failedADown = reachedADown && !a_down_fired  && currentPrice > orL;

    // Determine active setup (priority order)
    let setup = null, color = '#94a3b8', description = '';

    if (a_up_fired && cUp) {
      setup = 'A Up + C Confirmed'; color = '#22c55e';
      description = `A Up fired and C Up confirmed. Strong continuation long. Price ${currentPrice.toFixed(2)}, above OR High ${orH.toFixed(2)}.`;
    } else if (a_up_fired && !cUp) {
      setup = 'A Up (no C yet)'; color = '#86efac';
      description = `A Up fired. Waiting for C Up confirmation (close above OR High ${orH.toFixed(2)}). Still valid long.`;
    } else if (a_down_fired && cDown) {
      setup = 'A Down + C Confirmed'; color = '#ef4444';
      description = `A Down fired and C Down confirmed. Strong continuation short. Price ${currentPrice.toFixed(2)}, below OR Low ${orL.toFixed(2)}.`;
    } else if (a_down_fired && !cDown) {
      setup = 'A Down (no C yet)'; color = '#fca5a5';
      description = `A Down fired. Waiting for C Down confirmation (close below OR Low ${orL.toFixed(2)}). Still valid short.`;
    } else if (failedAUp) {
      setup = 'Failed A Up'; color = '#f97316';
      description = `Price reached A Up (${aUp.toFixed(2)}) but failed to sustain — fell back below OR High (${orH.toFixed(2)}). Short setup. Entry near OR High, stop above session high (${sessionHigh.toFixed(2)}).`;
    } else if (failedADown) {
      setup = 'Failed A Down'; color = '#a78bfa';
      description = `Price reached A Down (${aDown.toFixed(2)}) but failed to sustain — rose back above OR Low (${orL.toFixed(2)}). Long setup. Entry near OR Low, stop below session low (${sessionLow.toFixed(2)}).`;
    } else if (reachedAUp) {
      setup = 'Testing A Up'; color = '#fbbf24';
      description = `Price reached A Up level (${aUp.toFixed(2)}). Watching for 5-minute sustain above OR High for long entry, or failure for short entry.`;
    } else if (reachedADown) {
      setup = 'Testing A Down'; color = '#fbbf24';
      description = `Price reached A Down level (${aDown.toFixed(2)}). Watching for 5-minute sustain below OR Low for short entry, or failure for long entry.`;
    } else if (cUp && !a_up_fired) {
      setup = 'C Up (no A)'; color = '#6ee7b7';
      description = `A bar closed above OR High (${orH.toFixed(2)}) without A Up firing first. Weaker signal — price accepted above OR but didn't break the A level.`;
    } else if (cDown && !a_down_fired) {
      setup = 'C Down (no A)'; color = '#fda4af';
      description = `A bar closed below OR Low (${orL.toFixed(2)}) without A Down firing first. Weaker signal.`;
    } else {
      const distToAUp   = aUp - currentPrice;
      const distToADown = currentPrice - aDown;
      setup = 'No signal'; color = '#64748b';
      description = `No setup yet. Price ${currentPrice.toFixed(2)} — ${distToAUp.toFixed(0)} pts from A Up (${aUp.toFixed(2)}), ${distToADown.toFixed(0)} pts from A Down (${aDown.toFixed(2)}).`;
    }

    // Build session timeline — with cooldown flags to prevent re-triggering on same touch
    const timeline = [];
    let aUpTouchTime = null, aDownTouchTime = null;
    let aUpFiredTimeline = false, aDownFiredTimeline = false;
    // aUpHeld: true while A Up is active after firing; set false if price reverses below OR High
    let aUpHeld = false;
    let failedAUpCount = 0, failedADownCount = 0;
    let aUpCooldown2 = 0, aDownCooldown2 = 0;
    let cUpLogged = false, cDownLogged = false;

    for (const bar of postOR) {
      const t = new Date(bar.ts).toISOString().slice(11, 16);
      const barMinutes = bar.bar_min;

      if (aUpCooldown2 > 0) aUpCooldown2--;
      if (aDownCooldown2 > 0) aDownCooldown2--;

      // Track A Up path — keep tracking even after fire to catch reversals and re-tests
      if (!aDownFiredTimeline) {
        // Pre-fire: detect initial test and sustained fire
        if (!aUpFiredTimeline) {
          if (!aUpTouchTime && aUpCooldown2 === 0 && bar.high >= aUp) {
            aUpTouchTime = t;
            const testLabel = failedAUpCount > 0 ? ` (re-test ${failedAUpCount + 1})` : '';
            timeline.push({ time: t, event: `A Up tested${testLabel}`, price: aUp, color: '#fbbf24',
              note: `Price reached the A Up level (${aUp.toFixed(2)})${failedAUpCount > 0 ? ' again after a prior failure' : ''}. The 5-minute sustain clock has started — if price holds above OR High (${orH.toFixed(2)}) without pulling back inside the OR, A Up fires and a long entry is valid.` });
          }
          if (aUpTouchTime) {
            if (bar.low < orH) {
              failedAUpCount++;
              const attemptLabel = failedAUpCount > 1 ? ` (attempt ${failedAUpCount})` : '';
              timeline.push({ time: t, event: `Failed A Up${attemptLabel}`, price: bar.close, color: '#f97316',
                note: `Price reached the A Up level${failedAUpCount > 1 ? ' again' : ''} but fell back below OR High (${orH.toFixed(2)}) before sustaining 5 minutes. ${failedAUpCount > 1 ? 'Second failure — stronger conviction that bulls cannot hold this level. ' : ''}Short setup: entry near OR High on the reversal, stop above session high (${sessionHigh.toFixed(2)}).` });
              aUpTouchTime = null; aUpCooldown2 = 15;
            } else if (barMinutes - (parseInt(aUpTouchTime.split(':')[0])*60 + parseInt(aUpTouchTime.split(':')[1])) >= 5) {
              aUpFiredTimeline = true; aUpHeld = true;
              timeline.push({ time: t, event: 'A Up fired', price: aUp, color: '#22c55e',
                note: `A Up confirmed — price held above OR High (${orH.toFixed(2)}) for 5 consecutive minutes. Long entry at ${aUp.toFixed(2)}, stop at OR Low (${orL.toFixed(2)}). Hold duration depends on confluence score.` });
              aUpTouchTime = null;
            }
          }
        } else {
          // Post-fire: track if price reverses below OR High (Failed to hold) then re-tests
          if (bar.low < orH && aUpTouchTime !== 'reversed') {
            aUpTouchTime = 'reversed'; aUpHeld = false;
            failedAUpCount++;
            const attemptLabel = failedAUpCount > 1 ? ` (attempt ${failedAUpCount})` : '';
            timeline.push({ time: t, event: `Failed A Up${attemptLabel}`, price: bar.close, color: '#f97316',
              note: `A Up had fired but price reversed back below OR High (${orH.toFixed(2)}). The breakout failed to hold — short setup. Entry near OR High, stop above session high (${sessionHigh.toFixed(2)}).` });
          } else if (aUpTouchTime === 'reversed' && bar.high >= aUp) {
            // Price re-tested A Up after reversal — reset for next failure detection
            aUpTouchTime = t;
            timeline.push({ time: t, event: `A Up tested (re-test ${failedAUpCount + 1})`, price: aUp, color: '#fbbf24',
              note: `Price returned to the A Up level (${aUp.toFixed(2)}) after a prior failure. Watching for sustained hold or another rejection.` });
          } else if (aUpTouchTime !== null && aUpTouchTime !== 'reversed' && bar.low < orH) {
            failedAUpCount++;
            timeline.push({ time: t, event: `Failed A Up (attempt ${failedAUpCount})`, price: bar.close, color: '#f97316',
              note: `Price reached A Up again but failed to hold above OR High (${orH.toFixed(2)}). Repeated failure strengthens the short case.` });
            aUpTouchTime = 'reversed';
          }
        }
      }

      // Track A Down path — allowed if A Up never fired, or if A Up fired but reversed (no longer held)
      if (!aUpHeld) {
        if (!aDownTouchTime && aDownCooldown2 === 0 && bar.low <= aDown) {
          aDownTouchTime = t;
          timeline.push({ time: t, event: failedADownCount > 0 ? `A Down tested (re-test ${failedADownCount+1})` : 'A Down tested', price: aDown, color: '#fbbf24',
            note: `Price reached the A Down level (${aDown.toFixed(2)}) for the first time. The 5-minute sustain clock has started — if price holds below OR Low (${orL.toFixed(2)}) without pulling back inside the OR, A Down fires and a short entry is valid.` });
        }
        if (aDownTouchTime && !aDownFiredTimeline) {
          if (bar.high > orL) {
            failedADownCount++;
            const attemptLabelD = failedADownCount > 1 ? ` (attempt ${failedADownCount})` : '';
            timeline.push({ time: t, event: `Failed A Down${attemptLabelD}`, price: bar.close, color: '#a78bfa',
              note: `Price reached the A Down level${failedADownCount > 1 ? ' again' : ''} but rose back above OR Low (${orL.toFixed(2)}) before sustaining 5 minutes. ${failedADownCount > 1 ? 'Second failure — stronger conviction bears cannot hold. ' : ''}Long setup: entry near OR Low on the bounce, stop below the session low (${sessionLow.toFixed(2)}).` });
            aDownTouchTime = null; aDownCooldown2 = 15;
          } else if (barMinutes - (parseInt(aDownTouchTime.split(':')[0])*60 + parseInt(aDownTouchTime.split(':')[1])) >= 5) {
            aDownFiredTimeline = true;
            timeline.push({ time: t, event: 'A Down fired', price: aDown, color: '#ef4444',
              note: `A Down confirmed — price held below OR Low (${orL.toFixed(2)}) for 5 consecutive minutes without pulling back inside the OR. Short entry at ${aDown.toFixed(2)}, stop at OR High (${orH.toFixed(2)}). Hold duration depends on confluence score.` });
          }
        }
      }

      // C confirmations
      // G-Line (weekly open) — first touch, first close below (lost), first close above after lost (reclaimed)
      if (gLine) {
        if (!timeline.some(e => e.event.startsWith('G-Line')) && bar.low <= gLine && bar.high >= gLine) {
          timeline.push({ time: t, event: 'G-Line tested', price: gLine, color: '#f59e0b',
            note: `Price tested the G-Line (${gLine.toFixed(2)}) — the weekly open from Monday's session.\n\nAbove G-Line = week is positive / buyers in control. Below = week is negative / sellers in control. First test of this level is the key tell: does it hold or break?` });
        }
        if (!timeline.some(e => e.event === 'G-Line lost') && bar.close < gLine) {
          timeline.push({ time: t, event: 'G-Line lost', price: bar.close, color: '#f59e0b',
            note: `Price closed below the G-Line (${gLine.toFixed(2)}) — the weekly open. The week has turned negative. Sellers are in control of the weekly timeframe. A Down signals and short setups now have structural weekly tailwind.` });
        }
        if (timeline.some(e => e.event === 'G-Line lost') && !timeline.some(e => e.event === 'G-Line reclaimed') && bar.close > gLine) {
          timeline.push({ time: t, event: 'G-Line reclaimed', price: bar.close, color: '#f59e0b',
            note: `Price reclaimed the G-Line (${gLine.toFixed(2)}) after losing it — closed back above the weekly open. Bullish recovery. Week has turned positive again. A Up signals now have structural weekly tailwind.` });
        }
      }

      // Prior month VAH — first touch and first close-through
      if (pmVAH) {
        if (!timeline.some(e => e.event.startsWith('PM VAH')) && bar.high >= pmVAH) {
          timeline.push({ time: t, event: 'PM VAH tested', price: pmVAH, color: '#10b981',
            note: `Price touched the prior month value area high (${pmVAH.toFixed(0)}) — the top of where 70% of last month's volume was accepted.\n\nAbove PM VAH = price is above monthly accepted value — buyers accepting prices beyond last month's range. Strongly initiative on the monthly timeframe.\nBelow PM VAH = still within or below monthly value — responsive territory.` });
        }
        if (!timeline.some(e => e.event === 'PM VAH broken') && bar.close > pmVAH) {
          timeline.push({ time: t, event: 'PM VAH broken', price: bar.close, color: '#10b981',
            note: `A bar closed above the prior month value area high (${pmVAH.toFixed(0)}) — price accepted above the monthly range. Multi-timeframe bullish structural shift. Prior month VAH flips to support on the monthly timeframe.` });
        }
      }
      // Prior month VAL — first touch and first close-through
      if (pmVAL) {
        if (!timeline.some(e => e.event.startsWith('PM VAL')) && bar.low <= pmVAL) {
          timeline.push({ time: t, event: 'PM VAL tested', price: pmVAL, color: '#10b981',
            note: `Price touched the prior month value area low (${pmVAL.toFixed(0)}) — the bottom of where 70% of last month's volume was accepted.\n\nBelow PM VAL = price accepted below monthly value — sellers pushing below last month's range. Strongly initiative bearish.\nAbove PM VAL = still within monthly value — responsive territory.` });
        }
        if (!timeline.some(e => e.event === 'PM VAL broken') && bar.close < pmVAL) {
          timeline.push({ time: t, event: 'PM VAL broken', price: bar.close, color: '#10b981',
            note: `A bar closed below the prior month value area low (${pmVAL.toFixed(0)}) — price accepted below the monthly range. Bearish multi-timeframe structural shift.` });
        }
      }

      // PW High — first touch and first close-through
      if (pwHigh) {
        if (!timeline.some(e => e.event === 'PW High tested' || e.event === 'PW High broken') && bar.high >= pwHigh) {
          timeline.push({ time: t, event: 'PW High tested', price: pwHigh, color: '#c084fc',
            note: `Price touched the prior week high (${pwHigh.toFixed(2)}). Key resistance — the highest price traded during last week's RTH session. A close above confirms acceptance at a new weekly high; rejection here is a short lean.` });
        }
        if (!timeline.some(e => e.event === 'PW High broken') && bar.close > pwHigh) {
          timeline.push({ time: t, event: 'PW High broken', price: bar.close, color: '#c084fc',
            note: `A bar closed above the prior week high (${pwHigh.toFixed(2)}) — price is being accepted above last week's range. Bullish structural shift. Dalton: new value is being established above the prior reference. Prior week high now acts as support.` });
        }
      }
      // PW Low — first touch and first close-through
      if (pwLow) {
        if (!timeline.some(e => e.event === 'PW Low tested' || e.event === 'PW Low broken') && bar.low <= pwLow) {
          timeline.push({ time: t, event: 'PW Low tested', price: pwLow, color: '#c084fc',
            note: `Price touched the prior week low (${pwLow.toFixed(2)}). Key support — the lowest price traded during last week's RTH session. A close below confirms acceptance at a new weekly low; bounce here is a long lean.` });
        }
        if (!timeline.some(e => e.event === 'PW Low broken') && bar.close < pwLow) {
          timeline.push({ time: t, event: 'PW Low broken', price: bar.close, color: '#c084fc',
            note: `A bar closed below the prior week low (${pwLow.toFixed(2)}) — price is being accepted below last week's range. Bearish structural shift. Dalton: new value being established lower. Prior week low now acts as resistance.` });
        }
      }

      if (!cUpLogged && bar.close > orH) {
        cUpLogged = true;
        timeline.push({ time: t, event: aUpFiredTimeline ? 'C Up confirmed' : 'C Up (no A)', price: bar.close, color: aUpFiredTimeline ? '#22c55e' : '#6ee7b7',
          note: aUpFiredTimeline
            ? `A bar closed above OR High (${orH.toFixed(2)}) after A Up already fired. C confirmation means price is being accepted above the opening range — the breakout has follow-through. Strengthens the long case and supports holding the position.`
            : `A bar closed above OR High (${orH.toFixed(2)}) without A Up firing first. Weaker signal — price accepted above OR but didn't break the A level (${aUp.toFixed(2)}) with sustained conviction. Can still lean long but treat as lower confidence.` });
      }
      if (!cDownLogged && bar.close < orL) {
        cDownLogged = true;
        timeline.push({ time: t, event: aDownFiredTimeline ? 'C Down confirmed' : 'C Down (no A)', price: bar.close, color: aDownFiredTimeline ? '#ef4444' : '#fda4af',
          note: aDownFiredTimeline
            ? `A bar closed below OR Low (${orL.toFixed(2)}) after A Down already fired. C confirmation means price is being accepted below the opening range — the breakdown has follow-through. Strengthens the short case.`
            : `A bar closed below OR Low (${orL.toFixed(2)}) without A Down firing first. Weaker signal — price dipped below OR but didn't reach the A Down level (${aDown.toFixed(2)}). Likely a probe that lacked conviction. Lower confidence short lean.` });
      }
    }

    // Generate plain-English narrative of the session
    const narrative = [];

    // Opening
    narrative.push(`NQ opened with a ${orRange.toFixed(0)}-point opening range: high ${orH.toFixed(2)}, low ${orL.toFixed(2)}. A Up level: ${aUp.toFixed(2)}, A Down level: ${aDown.toFixed(2)}.`);

    // Walk through timeline events
    for (const ev of timeline) {
      if (ev.event === 'A Up tested') {
        narrative.push(`At ${ev.time}, price reached the A Up level (${aUp.toFixed(2)}). The 5-minute sustain clock started.`);
      } else if (ev.event === 'A Up fired') {
        narrative.push(`At ${ev.time}, A Up confirmed — price held above OR High for 5 minutes. Long signal active. Entry ${aUp.toFixed(2)}, stop at OR Low ${orL.toFixed(2)}.`);
      } else if (ev.event === 'Failed A Up') {
        narrative.push(`At ${ev.time}, the A Up attempt failed — price pulled back inside the OR (below ${orH.toFixed(2)}) before sustaining 5 minutes. This failure is a short setup: the bulls showed up, couldn't hold it. Entry near OR High on the way down, stop above the session high (${sessionHigh.toFixed(2)}).`);
      } else if (ev.event === 'A Down tested') {
        narrative.push(`At ${ev.time}, price reached the A Down level (${aDown.toFixed(2)}). The 5-minute sustain clock started.`);
      } else if (ev.event === 'A Down fired') {
        narrative.push(`At ${ev.time}, A Down confirmed — price held below OR Low for 5 minutes. Short signal active. Entry ${aDown.toFixed(2)}, stop at OR High ${orH.toFixed(2)}.`);
      } else if (ev.event === 'Failed A Down') {
        narrative.push(`At ${ev.time}, the A Down attempt failed — price recovered back inside the OR (above ${orL.toFixed(2)}). Long setup: the bears failed. Entry near OR Low on the bounce, stop below session low (${sessionLow.toFixed(2)}).`);
      } else if (ev.event === 'C Up confirmed') {
        narrative.push(`At ${ev.time}, C Up confirmed (close at ${ev.price.toFixed(2)}, above OR High ${orH.toFixed(2)}). Price is being accepted above the opening range — confirms the A Up signal and strengthens the long case.`);
      } else if (ev.event === 'C Down confirmed') {
        narrative.push(`At ${ev.time}, C Down confirmed (close at ${ev.price.toFixed(2)}, below OR Low ${orL.toFixed(2)}). Price accepted below the opening range — confirms the A Down signal.`);
      } else if (ev.event === 'C Up (no A)') {
        narrative.push(`At ${ev.time}, a bar closed above OR High (${ev.price.toFixed(2)}) but A Up never fired — price never reached the A Up level (${aUp.toFixed(2)}) with sustained conviction. Weaker signal, price explored above the OR without committing to a breakout.`);
      } else if (ev.event === 'C Down (no A)') {
        narrative.push(`At ${ev.time}, a bar closed below OR Low (${ev.price.toFixed(2)}) but A Down never fired — price dipped below the OR without reaching the A Down level (${aDown.toFixed(2)}). Weaker signal, likely a probe that faded.`);
      }
    }

    // Current state
    const distToAUp = aUp - currentPrice;
    const distToADown = currentPrice - aDown;
    if (timeline.length === 0) {
      narrative.push(`No setups have fired yet. Price (${currentPrice.toFixed(2)}) is ${distToAUp.toFixed(0)} points from A Up and ${distToADown.toFixed(0)} points from A Down. Watching both levels.`);
    } else {
      if (!a_up_fired && !a_down_fired) {
        if (currentPrice > orH) {
          narrative.push(`Currently price (${currentPrice.toFixed(2)}) is above OR High (${orH.toFixed(2)}) — ${distToAUp.toFixed(0)} points from A Up. Watching for a sustained push through ${aUp.toFixed(2)} or a rejection back inside the OR.`);
        } else if (currentPrice < orL) {
          narrative.push(`Currently price (${currentPrice.toFixed(2)}) is below OR Low (${orL.toFixed(2)}) — ${distToADown.toFixed(0)} points from A Down. Watching for sustained breakdown below ${aDown.toFixed(2)} or a recovery.`);
        } else {
          narrative.push(`Currently price (${currentPrice.toFixed(2)}) is back inside the OR (${orL.toFixed(2)}–${orH.toFixed(2)}). No active A signal. Ranging.`);
        }
      }
    }

    // ── Phase 3 auto-suggestions ──────────────────────────────────────────────
    // Bias: A signal overrides structure; fall back to overnight_inventory/open_vs_prior_value
    const todayRead = await query(`SELECT overnight_inventory, open_vs_prior_value FROM auction_reads WHERE trade_date=$1`, [todayET]);
    const inv2 = todayRead.rows[0]?.overnight_inventory;
    const val2 = todayRead.rows[0]?.open_vs_prior_value;
    const strLong  = (inv2==='SHORT_TRAPPED'&&val2!=='BELOW_VALUE')||(inv2==='NEUTRAL'&&val2==='ABOVE_VALUE');
    const strShort = (inv2==='LONG_TRAPPED'&&val2!=='ABOVE_VALUE')||(inv2==='NEUTRAL'&&val2==='BELOW_VALUE');
    const biasDir = a_up_fired ? 'LONG' : a_down_fired ? 'SHORT' : strLong ? 'LONG' : strShort ? 'SHORT' : 'NEUTRAL';

    // VWAP (volume-weighted close across all post-OR bars)
    const totalVol = postOR.reduce((s, b) => s + (Number(b.volume) || 1), 0);
    const vwap = postOR.reduce((s, b) => s + b.close * (Number(b.volume) || 1), 0) / totalVol;

    // 1. VWAP holding: current price on correct side of VWAP
    const p3_vwap_holding = biasDir === 'LONG' ? currentPrice > vwap
                          : biasDir === 'SHORT' ? currentPrice < vwap : false;

    // 2. Value migrating: VWAP now vs VWAP 20 bars ago (session weighted trend)
    const split = Math.max(1, postOR.length - 20);
    const earlyBars = postOR.slice(0, split);
    const earlyVol = earlyBars.reduce((s, b) => s + (Number(b.volume) || 1), 0);
    const earlyVwap = earlyBars.reduce((s, b) => s + b.close * (Number(b.volume) || 1), 0) / earlyVol;
    const p3_value_migrating = biasDir === 'LONG' ? vwap > earlyVwap
                             : biasDir === 'SHORT' ? vwap < earlyVwap : false;

    // 3. Delta confirming: close-position proxy (close near high = buy pressure)
    const last10 = postOR.slice(-10);
    const avgClosePos = last10.reduce((s, b) => {
      const rng = b.high - b.low;
      return s + (rng > 0 ? (b.close - b.low) / rng : 0.5);
    }, 0) / last10.length;
    const p3_delta_confirming = biasDir === 'LONG' ? avgClosePos > 0.55
                              : biasDir === 'SHORT' ? avgClosePos < 0.45 : false;

    // 4. Auction accepted: ≥40% of last 20 bars closing beyond OR in bias direction
    const last20 = postOR.slice(-20);
    const acceptCount = last20.filter(b =>
      biasDir === 'LONG' ? b.close > orH : biasDir === 'SHORT' ? b.close < orL : false
    ).length;
    const p3_auction_accepted = last20.length > 0 && acceptCount / last20.length >= 0.4;

    // 5. Rotations increasing: recent bar ranges expanding (balance/two-sided trade forming)
    const last16 = postOR.slice(-16);
    let p3_rotations_increasing = false;
    if (last16.length >= 8) {
      const half = Math.floor(last16.length / 2);
      const firstHalf = last16.slice(0, half);
      const secondHalf = last16.slice(half);
      const rng1 = Math.max(...firstHalf.map(b => b.high)) - Math.min(...firstHalf.map(b => b.low));
      const rng2 = Math.max(...secondHalf.map(b => b.high)) - Math.min(...secondHalf.map(b => b.low));
      p3_rotations_increasing = rng2 > rng1 * 1.15;
    }

    const p3Suggested = { p3_vwap_holding, p3_value_migrating, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing, vwap: Math.round(vwap * 100) / 100, biasDir };

    // ── Opening call auto-detection from first 15 min of bars (9:30–9:45) ──
    // Also include the OR bars (bm 570–574) for the first-bar open price
    const allBarsQ = await query(`
      SELECT high::float, low::float, close::float, open::float,
             EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as bm
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 585
      ORDER BY ts
    `, [todayET]);
    const first15 = allBarsQ.rows;
    let opening_call_type = null;
    if (first15.length >= 5 && orH && orL) {
      const h15    = Math.max(...first15.map(b => b.high));
      const l15    = Math.min(...first15.map(b => b.low));
      const openPx = first15[0].open;
      const lastPx = first15[first15.length-1].close;
      const orRng  = orH - orL;
      const ext    = orRng * 0.3;   // 30% extension = meaningful push
      const ext50  = orRng * 0.5;   // 50% extension = drive territory
      const aboveOR = h15 - orH;    // how far above OR High
      const belowOR = orL - l15;    // how far below OR Low

      if (aboveOR > ext && belowOR > ext) {
        // Tested both sides — Open Test Drive
        opening_call_type = 'OPEN_TEST_DRIVE';
      } else if (aboveOR > ext50 && belowOR < ext * 0.3) {
        // Strong upside extension, no downside test — Open Drive
        opening_call_type = 'OPEN_DRIVE';
      } else if (belowOR > ext50 && aboveOR < ext * 0.3) {
        // Strong downside extension, no upside test — Open Drive
        opening_call_type = 'OPEN_DRIVE';
      } else if ((aboveOR > ext || belowOR > ext) && Math.abs(lastPx - (orH+orL)/2) < orRng * 0.4) {
        // Extended one side but price came back toward midpoint — ORR
        opening_call_type = 'OPEN_REJECTION_REVERSE';
      } else {
        // Stayed within or near OR — Open Auction
        opening_call_type = 'OPEN_AUCTION';
      }
    }

    // Derive setup and signal flags from live bar analysis (timeline), not stale DB values
    let liveSetup = setup, liveColor = color, liveDescription = description;
    if (aUpFiredTimeline && cUp) {
      liveSetup = 'A Up + C Confirmed'; liveColor = '#22c55e';
      liveDescription = `A Up fired and C Up confirmed. Strong continuation long. Price ${currentPrice.toFixed(2)}, above OR High ${orH.toFixed(2)}.`;
    } else if (aUpFiredTimeline) {
      liveSetup = 'A Up (no C yet)'; liveColor = '#86efac';
      liveDescription = `A Up fired. Waiting for C Up confirmation (close above OR High ${orH.toFixed(2)}). Still valid long.`;
    } else if (aDownFiredTimeline && cDown) {
      liveSetup = 'A Down + C Confirmed'; liveColor = '#ef4444';
      liveDescription = `A Down fired and C Down confirmed. Strong continuation short. Price ${currentPrice.toFixed(2)}, below OR Low ${orL.toFixed(2)}.`;
    } else if (aDownFiredTimeline) {
      liveSetup = 'A Down (no C yet)'; liveColor = '#fca5a5';
      liveDescription = `A Down fired. Waiting for C Down confirmation (close below OR Low ${orL.toFixed(2)}).`;
    } else if (timeline.some(e => e.event?.startsWith('Failed A Up') && !e.event.includes('attempt'))) {
      liveSetup = 'Failed A Up'; liveColor = '#f97316';
    } else if (timeline.some(e => e.event?.startsWith('Failed A Down') && !e.event.includes('attempt'))) {
      liveSetup = 'Failed A Down'; liveColor = '#a78bfa';
    }

    res.json({
      setup: liveSetup, color: liveColor, description: liveDescription, currentPrice, barTime,
      orHigh: orH, orLow: orL, aUpLevel: aUp, aDownLevel: aDown,
      gLine, pwHigh, pwLow, pmVAH, pmVAL, pmPOC,
      sessionHigh, sessionLow,
      aUpFired: aUpFiredTimeline, aDownFired: aDownFiredTimeline,
      reachedAUp, reachedADown, failedAUp, failedADown, cUp, cDown,
      barsAnalyzed: postOR.length,
      timeline, narrative, p3Suggested, opening_call_type,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/setup-detection — detect the highest-priority intraday setup
// Returns one setup card at a time. Priority: IB_CONFIRMATION > OPEN_DRIVE_CONT >
// FAILED_AUCTION > BRACKET_BREAKOUT > VALUE_AREA_RESP
app.get('/api/acd/setup-detection', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const nowET   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etMin   = nowET.getHours() * 60 + nowET.getMinutes();
    const isRTH   = etMin >= 9 * 60 + 30 && etMin < 16 * 60;
    if (!isRTH) return res.json({ setup: null, reason: 'market closed' });

    // ── Fetch all data sources in parallel ────────────────────────────────────
    const [acdRow, arRow, ltRow, ibBarsRow, latestBarRow, volumeCtxRow, timelineRow] = await Promise.all([
      // Today's OR levels
      query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [todayET]),
      // Auction reads for today
      query(`SELECT opening_call_type, open_vs_prior_value FROM auction_reads WHERE trade_date=$1`, [todayET]),
      // Prior 5 bracket states (for bracket breakout detection)
      query(`
        SELECT al.trade_date::text, al.or_high::float, al.or_low::float,
               ar.opening_call_type
        FROM acd_daily_log al LEFT JOIN auction_reads ar USING (trade_date)
        WHERE al.trade_date < $1 AND al.or_high IS NOT NULL
        ORDER BY al.trade_date DESC LIMIT 5
      `, [todayET]),
      // IB bars (9:30–10:29) with bid/ask volume
      query(`
        SELECT high::float, low::float, close::float, open::float,
               COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol, volume::int
        FROM price_bars WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
        ORDER BY ts
      `, [todayET]),
      // Current price + last 20 bars for volume context
      query(`SELECT close::float, volume::int FROM price_bars WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`),
      // 20-bar average volume (last 20 RTH bars)
      query(`
        SELECT AVG(volume)::float as avg_vol
        FROM (SELECT volume FROM price_bars WHERE symbol='NQ' AND ts::date=$1
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 575 ORDER BY ts DESC LIMIT 20) v
      `, [todayET]),
      // Live timeline (from acd_daily_log, approximate from acd_setup_events)
      query(`SELECT setup_type, fired_time FROM acd_setup_events WHERE trade_date=$1 ORDER BY fired_time`, [todayET]),
    ]);

    // Prior day value area
    const priorDayQ = await query(`SELECT MAX(ts::date)::text as d FROM price_bars WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [todayET]);
    const priorDay = priorDayQ.rows[0]?.d;
    let pdVAH = null, pdVAL = null, pdPOC = null;
    if (priorDay) {
      const vaQ = await query(`
        WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
        total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT p.poc_px::float as poc,
          (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
          (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
        FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
      `, [priorDay]);
      if (vaQ.rows[0]) { pdVAH = vaQ.rows[0].vah; pdVAL = vaQ.rows[0].val; pdPOC = vaQ.rows[0].poc; }
    }

    // NL30 state
    const nlQ = await query(`SELECT SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30 FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date DESC LIMIT 1`);
    const nl30 = parseInt(nlQ.rows[0]?.nl30) || 0;
    const nl30State = nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING';

    // Extract data
    const orH = acdRow.rows[0]?.or_high, orL = acdRow.rows[0]?.or_low;
    const orRange = orH && orL ? orH - orL : null;
    const openingCall = arRow.rows[0]?.opening_call_type;
    const openVsPrior = arRow.rows[0]?.open_vs_prior_value;
    const currentPrice = latestBarRow.rows[0]?.close || 0;
    const avgVol = parseFloat(volumeCtxRow.rows[0]?.avg_vol) || 0;
    const ibBars = ibBarsRow.rows;
    const timelineEvents = timelineRow.rows.map(r => r.setup_type);

    // Helper: look up condition_memory win rate for current conditions
    const getHistory = async (structState) => {
      const nlBucket = nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING';
      const oc = openingCall || 'NO_SIGNAL';
      const r = await query(`
        SELECT occurrences, win_rate, avg_pnl, t1_hit_rate
        FROM condition_memory WHERE structural_state=$1 AND nl30_bucket=$2
          AND opening_call=$3 AND sufficient_data=true
        LIMIT 1
      `, [structState, nlBucket, oc]).catch(() => ({ rows: [] }));
      return r.rows[0] ? {
        occurrences: r.rows[0].occurrences,
        winRate: r.rows[0].win_rate != null ? parseFloat(r.rows[0].win_rate) : null,
        avgPnl: r.rows[0].avg_pnl != null ? parseFloat(r.rows[0].avg_pnl) : null,
        t1HitRate: r.rows[0].t1_hit_rate != null ? parseFloat(r.rows[0].t1_hit_rate) : null,
      } : null;
    };

    // ── SETUP 5: IB CONFIRMATION ──────────────────────────────────────────────
    // Detect after IB period completes (after 10:30 ET)
    let ibConfirmation = null;
    if (etMin >= 10 * 60 + 30 && ibBars.length >= 5) {
      const ibHigh = Math.max(...ibBars.map(b => b.high));
      const ibLow  = Math.min(...ibBars.map(b => b.low));
      const ibMid  = (ibHigh + ibLow) / 2;
      const ibClose = ibBars[ibBars.length - 1].close;
      const totalAsk = ibBars.reduce((s, b) => s + b.ask_vol, 0);
      const totalBid = ibBars.reduce((s, b) => s + b.bid_vol, 0);
      const ibBullish = ibClose > ibMid && totalAsk > totalBid;
      const ibBearish = ibClose < ibMid && totalBid > totalAsk;
      if ((ibBullish || ibBearish) && currentPrice) {
        const isBull = ibBullish;
        const priceSide = isBull ? currentPrice > ibMid : currentPrice < ibMid;
        if (priceSide) { // price still on IB-confirmed side
          const stop = isBull ? +(ibLow - 2).toFixed(2) : +(ibHigh + 2).toFixed(2);
          const target = isBull
            ? (pdVAH && pdVAH > currentPrice ? Math.round(pdVAH) : Math.round(ibHigh + orRange * 0.5))
            : (pdVAL && pdVAL < currentPrice ? Math.round(pdVAL) : Math.round(ibLow - orRange * 0.5));
          ibConfirmation = {
            type: 'IB_CONFIRMATION',
            label: isBull ? 'IB BULLISH' : 'IB BEARISH',
            direction: isBull ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +stop.toFixed(0),
            target,
            targetLabel: isBull ? (pdVAH && pdVAH > currentPrice ? 'Prior Day VAH' : 'IB Extension') : (pdVAL && pdVAL < currentPrice ? 'Prior Day VAL' : 'IB Extension'),
            keyLevel: +ibMid.toFixed(0),
            keyLevelLabel: 'IB Midpoint',
            description: isBull
              ? `IB closed ${(ibClose - ibMid).toFixed(0)}pts above midpoint with ask volume dominating (${totalAsk.toLocaleString()} vs ${totalBid.toLocaleString()} bid). Buyers controlled the opening hour. Lean long on pullbacks to IB midpoint — price structure favors continuation.`
              : `IB closed ${(ibMid - ibClose).toFixed(0)}pts below midpoint with bid volume dominating (${totalBid.toLocaleString()} vs ${totalAsk.toLocaleString()} ask). Sellers controlled the opening hour. Lean short on rallies to IB midpoint.`,
            history: await getHistory(nl30State === 'BULLISH' ? 'TRENDING_UP' : nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE'),
          };
        }
      }
    }

    // ── SETUP 1: OPEN DRIVE CONTINUATION ────────────────────────────────────
    let openDriveCont = null;
    if (openingCall === 'OPEN_DRIVE' && orH && orL && currentPrice) {
      // Bull drive: price went well above OR High then pulled back near OR High
      const nearOrHigh = Math.abs(currentPrice - orH) <= 15 && currentPrice >= orH - 15 && currentPrice <= orH + 5;
      // Bear drive: price went well below OR Low then pulled back near OR Low
      const nearOrLow  = Math.abs(currentPrice - orL) <= 15 && currentPrice <= orL + 15 && currentPrice >= orL - 5;
      const isBull = nearOrHigh && nl30State !== 'BEARISH';
      const isBear = nearOrLow  && nl30State !== 'BULLISH';
      if (isBull || isBear) {
        const stop = isBull ? +(orL - 2).toFixed(0) : +(orH + 2).toFixed(0);
        const t1   = isBull ? +(orH + orRange).toFixed(0) : +(orL - orRange).toFixed(0);
        openDriveCont = {
          type: 'OPEN_DRIVE_CONT',
          label: isBull ? 'OPEN DRIVE CONTINUATION (LONG)' : 'OPEN DRIVE CONTINUATION (SHORT)',
          direction: isBull ? 'LONG' : 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: +stop,
          target: t1,
          targetLabel: 'OR Measured Move',
          keyLevel: +(isBull ? orH : orL).toFixed(0),
          keyLevelLabel: isBull ? 'OR High (support)' : 'OR Low (resistance)',
          description: isBull
            ? `Open Drive up confirmed. Price drove ${(currentPrice - orL).toFixed(0)}pts above OR Low on the open with commitment. This pullback to near OR High is the first test of the breakout level — buyers who missed the drive are entering here. Stop below OR Low.`
            : `Open Drive down confirmed. Price drove ${(orH - currentPrice).toFixed(0)}pts below OR High on the open. This rally toward OR Low is the first test of the breakdown level. Sellers who missed the drive are entering here. Stop above OR High.`,
          history: await getHistory('TRENDING_UP'),
        };
      }
    }

    // ── SETUP 3: FAILED AUCTION ──────────────────────────────────────────────
    // Detect via timeline: structural level tested then price closed back through
    let failedAuction = null;
    const gLineLost      = timelineEvents.includes('G-Line lost');
    const gLineReclaimed = timelineEvents.includes('G-Line reclaimed');
    const pwHighTested   = timelineEvents.includes('PW High tested');
    const pwHighBroken   = timelineEvents.includes('PW High broken');
    const pwLowTested    = timelineEvents.includes('PW Low tested');
    const pwLowBroken    = timelineEvents.includes('PW Low broken');
    const lastBarVol     = latestBarRow.rows[0]?.volume || 0;
    const highVolume     = avgVol > 0 && lastBarVol > avgVol * 1.5;

    if (gLineLost && gLineReclaimed && currentPrice) {
      // Failed bear auction: G-Line was lost then reclaimed → buyers won, long lean
      failedAuction = {
        type: 'FAILED_AUCTION', label: 'FAILED AUCTION — G-LINE RECLAIM',
        direction: 'LONG',
        entry: +currentPrice.toFixed(0), stop: +(currentPrice - orRange * 0.5).toFixed(0),
        target: pdVAH ? Math.round(pdVAH) : +(currentPrice + orRange * 0.5).toFixed(0),
        targetLabel: pdVAH ? 'Prior Day VAH' : 'OR extension',
        keyLevel: null, keyLevelLabel: 'G-Line (weekly open)',
        description: `G-Line was lost (sellers tried to push below weekly open) then reclaimed — bears failed to hold the breakdown. Volume ${highVolume ? 'was elevated on the reclaim, confirming conviction' : 'on reclaim'}. Failed bearish auction: long lean until prior VAH.`,
        history: await getHistory('TRANSITIONAL'),
      };
    } else if (pwHighTested && !pwHighBroken && currentPrice < (orH || currentPrice + 50)) {
      failedAuction = {
        type: 'FAILED_AUCTION', label: 'FAILED AUCTION — PRIOR WEEK HIGH',
        direction: 'SHORT',
        entry: +currentPrice.toFixed(0), stop: +(currentPrice + orRange * 0.3).toFixed(0),
        target: pdVAL ? Math.round(pdVAL) : +(currentPrice - orRange * 0.5).toFixed(0),
        targetLabel: pdVAL ? 'Prior Day VAL' : 'OR extension',
        keyLevel: null, keyLevelLabel: 'Prior Week High',
        description: `Prior week high was tested but price failed to close above it — supply was waiting there. Bulls pushed to last week's extreme, found sellers, and retreated. Fade the test: short lean toward prior day value area.`,
        history: await getHistory('BALANCE'),
      };
    }

    // ── SETUP 4: BRACKET BREAKOUT CONFIRMATION ───────────────────────────────
    let bracketBreakout = null;
    if (ltRow.rows.length >= 3 && orH && orL && currentPrice && pdVAH && pdVAL) {
      // Check if developing session is outside prior 5-day value area range
      const priorHighs = ltRow.rows.map(r => r.or_high).filter(Boolean);
      const priorLows  = ltRow.rows.map(r => r.or_low).filter(Boolean);
      const bracketTop = priorHighs.length ? Math.max(...priorHighs) : null;
      const bracketBot = priorLows.length  ? Math.min(...priorLows)  : null;
      const breakingUp   = bracketTop && currentPrice > bracketTop + 5 && nl30State === 'BULLISH';
      const breakingDown = bracketBot && currentPrice < bracketBot - 5 && nl30State === 'BEARISH';
      if (breakingUp || breakingDown) {
        const isBull = breakingUp;
        bracketBreakout = {
          type: 'BRACKET_BREAKOUT', label: isBull ? 'BRACKET BREAKOUT (LONG)' : 'BRACKET BREAKOUT (SHORT)',
          direction: isBull ? 'LONG' : 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: +(isBull ? (bracketTop - 5) : (bracketBot + 5)).toFixed(0),
          target: isBull ? Math.round(pdVAH + (pdVAH - pdVAL)) : Math.round(pdVAL - (pdVAH - pdVAL)),
          targetLabel: 'Value Area Extension',
          keyLevel: +(isBull ? bracketTop : bracketBot).toFixed(0),
          keyLevelLabel: isBull ? 'Prior Bracket Top' : 'Prior Bracket Bottom',
          description: isBull
            ? `5-session bracket top (${bracketTop?.toFixed(0)}) has been exceeded with NL30 aligned bullish (+${nl30}). Value area breakouts with trend carry significantly higher follow-through — prior bracket top becomes new support.`
            : `5-session bracket bottom (${bracketBot?.toFixed(0)}) has been broken with NL30 aligned bearish (${nl30}). Prior bracket bottom becomes new resistance. Target: value area measured move lower.`,
          history: await getHistory(isBull ? 'TRENDING_UP' : 'TRENDING_DOWN'),
        };
      }
    }

    // ── SETUP 2: VALUE AREA RESPONSIVE ──────────────────────────────────────
    let valueAreaResp = null;
    if (openVsPrior === 'INSIDE_VALUE' && openingCall !== 'OPEN_DRIVE' && currentPrice && pdVAH && pdVAL) {
      const nearVAH = Math.abs(currentPrice - pdVAH) <= 20;
      const nearVAL = Math.abs(currentPrice - pdVAL) <= 20;
      if (nearVAH || nearVAL) {
        const isFade = nearVAH; // fading VAH = short; fading VAL = long
        valueAreaResp = {
          type: 'VALUE_AREA_RESP', label: isFade ? 'VALUE AREA RESPONSIVE (SHORT)' : 'VALUE AREA RESPONSIVE (LONG)',
          direction: isFade ? 'SHORT' : 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: +(isFade ? (pdVAH + 8) : (pdVAL - 8)).toFixed(0),
          target: +(pdPOC || (isFade ? pdVAL : pdVAH)).toFixed(0),
          targetLabel: 'Prior Day POC',
          keyLevel: +(isFade ? pdVAH : pdVAL).toFixed(0),
          keyLevelLabel: isFade ? 'Prior Day VAH' : 'Prior Day VAL',
          description: isFade
            ? `Price opened inside prior value (${pdVAL?.toFixed(0)}–${pdVAH?.toFixed(0)}) and is testing VAH (${pdVAH?.toFixed(0)}) with a non-drive open. 70% of volume accepted below this level last session. Responsive sellers will defend VAH — target POC (${pdPOC?.toFixed(0)}).`
            : `Price opened inside prior value and is testing VAL (${pdVAL?.toFixed(0)}). Buyers from last session are at breakeven here — responsive buying sets up. Target POC (${pdPOC?.toFixed(0)}).`,
          history: await getHistory('BALANCE'),
        };
      }
    }

    // ── Priority selection ────────────────────────────────────────────────────
    const active = ibConfirmation || openDriveCont || failedAuction || bracketBreakout || valueAreaResp || null;
    if (!active) return res.json({ setup: null });

    // ── Stable timestamps: persist first-detection to acd_setup_events ───────
    // Use setup type as the fired_time key so re-calls don't create duplicate rows.
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const firedTimeStr = `${String(etNow.getHours()).padStart(2,'0')}:${String(etNow.getMinutes()).padStart(2,'0')}:00`;
    const existingRow = await query(`
      SELECT fired_time::text as fired_time, created_at
      FROM acd_setup_events WHERE trade_date=$1 AND setup_type=$2
      LIMIT 1
    `, [todayET, active.type]);

    let detectedAt;
    if (existingRow.rows.length) {
      // Already stored — use original fired_time for display stability
      detectedAt = existingRow.rows[0].fired_time.slice(0, 5); // HH:MM
    } else {
      // First detection — write it
      await query(`
        INSERT INTO acd_setup_events (trade_date, setup_type, fired_time, fired_price)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
      `, [todayET, active.type, firedTimeStr, active.entry || null]);
      detectedAt = firedTimeStr.slice(0, 5);
    }

    // Expiration window per setup type
    const expiryMins = {
      IB_CONFIRMATION:  11 * 60,      // 11:00 AM ET
      OPEN_DRIVE_CONT:  11 * 60,
      FAILED_AUCTION:   11 * 60,
      BRACKET_BREAKOUT: 16 * 60,      // whole session
      VALUE_AREA_RESP:  11 * 60,
    };
    const expiresAtMins = expiryMins[active.type] || 11 * 60;
    const minsRemaining = Math.max(0, expiresAtMins - etMin);
    const isExpired = minsRemaining === 0;

    res.json({ setup: { ...active, detectedAt, minsRemaining, isExpired } });
  } catch(e) { console.error('setup-detection error:', e); res.status(500).json({ error: e.message }); }
});

// GET /api/acd/level-confidence — nearby key levels + condition-specific respect rates
// Uses the key-levels cache to return confidence without re-scanning bars.
app.get('/api/acd/level-confidence', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Current price + session conditions
    const latestBar = await query(`SELECT close::float as close FROM price_bars WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
    const currentPrice = latestBar.rows[0]?.close;
    if (!currentPrice) return res.json({ levels: [] });

    // Session conditions for today
    const nlQ = await query(`
      SELECT SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30
      FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date DESC LIMIT 1
    `);
    const nl30Val = parseInt(nlQ.rows[0]?.nl30) || 0;
    const nl30State = nl30Val > 9 ? 'BULLISH' : nl30Val < -9 ? 'BEARISH' : 'RANGING';

    const arQ = await query(`SELECT opening_call_type FROM auction_reads WHERE trade_date=$1`, [todayET]);
    const openingCall = arQ.rows[0]?.opening_call_type || null;

    // Read today's levels (OR, IB, PD VA, G-Line) from existing data
    const acdQ = await query(`SELECT or_high, or_low, a_up_level, a_down_level FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
    const orH = parseFloat(acdQ.rows[0]?.or_high || 0);
    const orL = parseFloat(acdQ.rows[0]?.or_low || 0);

    // Today's IB (bars from 9:30-10:29)
    const ibQ = await query(`
      SELECT MAX(high)::float as ib_high, MIN(low)::float as ib_low
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    `, [todayET]);
    const ibHigh = ibQ.rows[0]?.ib_high;
    const ibLow  = ibQ.rows[0]?.ib_low;
    const ibRange = ibHigh && ibLow ? ibHigh - ibLow : null;

    // Prior day VA
    const pdQ = await query(`
      SELECT acd_daily_log.or_high, acd_daily_log.or_low FROM acd_daily_log
      WHERE trade_date < $1 AND or_high IS NOT NULL ORDER BY trade_date DESC LIMIT 1
    `, [todayET]);

    // Compute prior day VP for VAH/VAL
    const prevDay = pdQ.rows[0];
    let pdVAH = null, pdVAL = null;
    if (prevDay) {
      const pdBars = await query(`
        SELECT high::float as high, low::float as low, close::float as close, volume::integer as volume
        FROM price_bars WHERE symbol='NQ' AND ts::date=(SELECT MAX(trade_date) FROM acd_daily_log WHERE trade_date < $1)
          AND (EXTRACT(hour FROM ts)=9 AND EXTRACT(minute FROM ts)>=30 OR EXTRACT(hour FROM ts) BETWEEN 10 AND 15)
      `, [todayET]);
      // Quick VP from prior day bars
      if (pdBars.rows.length) {
        const priceMap = {};
        let totalV = 0;
        for (const b of pdBars.rows) {
          const v = b.volume || 0;
          for (let p = Math.round(b.low / 0.25) * 0.25; p <= b.high + 0.01; p += 0.25) {
            const k = p.toFixed(2);
            priceMap[k] = (priceMap[k] || 0) + v / Math.max(1, Math.round((b.high - b.low) / 0.25) + 1);
            totalV += v / Math.max(1, Math.round((b.high - b.low) / 0.25) + 1);
          }
        }
        const poc = parseFloat(Object.entries(priceMap).sort((a,b) => b[1]-a[1])[0]?.[0]);
        if (poc && totalV > 0) {
          const sorted70 = Object.entries(priceMap).filter(([p]) => parseFloat(p) >= poc)
            .sort((a,b) => b[1]-a[1]);
          let cumVah = 0;
          pdVAH = poc;
          for (const [p,v] of sorted70) { cumVah += v; pdVAH = Math.max(pdVAH, parseFloat(p)); if (cumVah >= totalV * 0.35) break; }
          const sorted70dn = Object.entries(priceMap).filter(([p]) => parseFloat(p) <= poc)
            .sort((a,b) => b[1]-a[1]);
          let cumVal = 0;
          pdVAL = poc;
          for (const [p,v] of sorted70dn) { cumVal += v; pdVAL = Math.min(pdVAL, parseFloat(p)); if (cumVal >= totalV * 0.35) break; }
        }
      }
    }

    // Candidate levels with their key-levels backtest keys and role
    const candidates = [
      { key: 'ibh',    price: ibHigh, label: 'IB High',         side: 'resistance' },
      { key: 'ibl',    price: ibLow,  label: 'IB Low',          side: 'support'    },
      { key: 'ibhExt', price: ibHigh && ibRange ? ibHigh + ibRange : null, label: 'IB High +1×', side: 'resistance' },
      { key: 'iblExt', price: ibLow  && ibRange ? ibLow  - ibRange : null, label: 'IB Low -1×',  side: 'support'    },
      { key: 'pdvah',  price: pdVAH,  label: 'PD VAH',          side: 'resistance' },
      { key: 'pdval',  price: pdVAL,  label: 'PD VAL',          side: 'support'    },
    ].filter(c => c.price != null);

    // Look up condition-filtered respect rates from key-levels cache
    const klCacheKey = `kl||||2.5|`; // match the unfiltered all-time cache key pattern
    let klData = cacheGet(klCacheKey) || cacheGet(`kl||||10|`) || cacheGet(`kl||||5|`);

    const getCondRate = (levelKey, side, condKey, condVal) => {
      if (!klData) return null;
      const levelData = klData.byLevel?.find(l => l.key === levelKey);
      if (!levelData) return null;
      const sideData = levelData[side];
      if (!sideData?.conditionBreakdown) return null;
      const dim = sideData.conditionBreakdown[condKey];
      return dim?.[condVal] || null;
    };

    const PROX = 60; // show levels within 60 points
    const nearLevels = candidates
      .map(c => {
        const dist = Math.abs(c.price - currentPrice);
        if (dist > PROX) return null;
        const rawRate = getCondRate(c.key, c.side, 'byNL30', nl30State);
        const ocRate  = openingCall ? getCondRate(c.key, c.side, 'byOpeningCall', openingCall) : null;
        const unfiltered = (() => {
          if (!klData) return null;
          const ld = klData.byLevel?.find(l => l.key === c.key);
          return ld?.[c.side]?.respectRate ?? null;
        })();
        return {
          key: c.key, label: c.label, price: +c.price.toFixed(2),
          side: c.side, dist: +dist.toFixed(1),
          approaching: c.side === 'resistance' ? currentPrice < c.price : currentPrice > c.price,
          respectRate: unfiltered,
          nl30Filtered: rawRate ? { rate: rawRate.respectRate, touches: rawRate.touches, condition: nl30State } : null,
          openCallFiltered: ocRate ? { rate: ocRate.respectRate, touches: ocRate.touches, condition: openingCall } : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.dist - b.dist);

    res.json({ currentPrice, nl30State, openingCall, nl30: nl30Val, nearLevels });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/nq/latest — most recent NQ bar close + vs monthly pivot
app.get('/api/acd/nq/latest', async (req, res) => {
  try {
    const r = await query(`SELECT ts, close, high, low, open FROM price_bars WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
    if (r.rows.length === 0) return res.json(null);
    const bar = r.rows[0];
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const monthYear = `${nowET.getFullYear()}-${String(nowET.getMonth() + 1).padStart(2, '0')}`;
    const pivot = await query('SELECT * FROM acd_monthly_pivot WHERE month_year = $1', [monthYear]);
    const pivotRow = pivot.rows[0];
    let pivotBias = null;
    if (pivotRow) {
      const price = parseFloat(bar.close);
      const pLevel = parseFloat(pivotRow.pivot_level);
      const r1 = parseFloat(pivotRow.pivot_r1);
      const s1 = parseFloat(pivotRow.pivot_s1);
      pivotBias = price > r1 ? 'ABOVE_R1' : price > pLevel ? 'ABOVE_PIVOT' : price > s1 ? 'BELOW_PIVOT' : 'BELOW_S1';
    }
    res.json({ ts: bar.ts, close: parseFloat(bar.close), pivot: pivotRow || null, pivotBias, barAgeMinutes: Math.round((Date.now() - new Date(bar.ts).getTime()) / 60000) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/numberline/history — full rolling sum history for chart
app.get('/api/acd/numberline/history', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        trade_date::text as date,
        daily_score,
        SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30,
        SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 9  PRECEDING AND CURRENT ROW) as nl10,
        SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 4  PRECEDING AND CURRENT ROW) as nl5
      FROM acd_daily_log
      ORDER BY trade_date ASC
    `);
    res.json(r.rows.map(row => ({
      date: row.date,
      score: parseInt(row.daily_score),
      nl30: parseInt(row.nl30),
      nl10: parseInt(row.nl10),
      nl5:  parseInt(row.nl5),
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/acd/autocompute — compute one date from price_bars and save
app.post('/api/acd/autocompute', async (req, res) => {
  try {
    const { date, or_minutes, a_multiplier, sustain_minutes } = req.body;
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const targetDate = date || todayET;
    // Use best saved params if not specified
    const best = await getBestACDParams();
    const orMins   = or_minutes   ? parseInt(or_minutes)    : best.orMins;
    const aMult    = a_multiplier ? parseFloat(a_multiplier): best.aMult;
    const sustainM = sustain_minutes ? parseInt(sustain_minutes) : best.sustainMins;

    const result = await computeACDFromBars(targetDate, orMins, aMult, sustainM);
    if (!result) return res.status(404).json({ error: `No NQ bars found for ${targetDate}` });

    const r = await query(`
      INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (trade_date) DO UPDATE SET
        or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
        a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
        daily_score=$11, session_close=$12
      RETURNING *
    `, [targetDate, result.orHigh, result.orLow, aMult, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);

    res.json({ ...result, saved: r.rows[0] });
  } catch(e) { console.error('autocompute error:', e); res.status(500).json({ error: e.message }); }
});

// In-memory structural backfill job state
let structuralBackfillJob = { status: 'idle', done: 0, total: 0, eventsAdded: 0, error: null };

// GET /api/acd/structural-events/backfill/status
app.get('/api/acd/structural-events/backfill/status', (req, res) => res.json(structuralBackfillJob));

// POST /api/acd/structural-events/backfill — populate G-Line, PW, PM events for all historical dates
app.post('/api/acd/structural-events/backfill', async (req, res) => {
  if (structuralBackfillJob.status === 'running')
    return res.status(409).json({ error: 'Backfill already running' });

  res.json({ message: 'Structural events backfill started' });

  structuralBackfillJob = { status: 'running', done: 0, total: 0, eventsAdded: 0, error: null };

  // Run async so response returns immediately
  (async () => {
    try {
      // Get all dated sessions that have OR data (bar data is a prerequisite)
      const datesQ = await query(`
        SELECT al.trade_date::text as d
        FROM acd_daily_log al
        WHERE al.or_high IS NOT NULL
        ORDER BY al.trade_date ASC
      `);
      const dates = datesQ.rows.map(r => r.d);
      structuralBackfillJob.total = dates.length;
      console.log(`📐 Structural events backfill: ${dates.length} dates to process`);

      // Cache PM value areas by month to avoid recomputing for every session in the same month
      const pmVaCache = {};

      for (const date of dates) {
        try {
          const [yr, mo] = date.split('-').map(Number);
          const monthKey = `${yr}-${String(mo).padStart(2,'0')}`;

          // Use cached PM value area for this month
          if (!pmVaCache[monthKey]) {
            const pmStart = new Date(Date.UTC(yr, mo - 2, 1)).toISOString().split('T')[0];
            const pmEnd   = new Date(Date.UTC(yr, mo - 1, 1)).toISOString().split('T')[0];
            const pmVpQ = await query(`
              WITH vp AS (
                SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
                FROM price_bars WHERE symbol='NQ'
                  AND ts >= $1::date AND ts < $2::date
                  AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
                  AND EXTRACT(hour FROM ts) < 16
                GROUP BY ROUND(low/0.25)*0.25
              ), total AS (SELECT SUM(vol) as t FROM vp),
              poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
              SELECT p.poc_px::float as poc,
                (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
                (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
              FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
            `, [pmStart, pmEnd]);
            pmVaCache[monthKey] = {
              pmVAH: pmVpQ.rows[0]?.vah || null,
              pmVAL: pmVpQ.rows[0]?.val || null,
            };
          }
          const { pmVAH, pmVAL } = pmVaCache[monthKey];

          // G-Line and PW levels (compute fresh per date — these change weekly)
          const gQ = await query(`
            SELECT (array_agg(open ORDER BY ts ASC))[1]::float as g
            FROM price_bars WHERE symbol='NQ'
              AND ts::date >= date_trunc('week', ($1::text)::date)
              AND ts::date <= ($1::text)::date
              AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
              AND EXTRACT(hour FROM ts) < 16
          `, [date]);
          const gLine = gQ.rows[0]?.g || null;

          const pwQ = await query(`
            SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low
            FROM price_bars WHERE symbol='NQ'
              AND ts::date >= date_trunc('week', ($1::text)::date) - INTERVAL '7 days'
              AND ts::date <  date_trunc('week', ($1::text)::date)
              AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
              AND EXTRACT(hour FROM ts) < 16
          `, [date]);
          const pwHigh = pwQ.rows[0]?.pw_high || null;
          const pwLow  = pwQ.rows[0]?.pw_low  || null;

          // OR reference for the event row
          const acdRow = await query(`
            SELECT or_high::float, or_low::float, a_up_level::float, a_down_level::float
            FROM acd_daily_log WHERE trade_date=$1
          `, [date]);
          if (!acdRow.rows.length) { structuralBackfillJob.done++; continue; }
          const { or_high: orH, or_low: orL, a_up_level: aUp, a_down_level: aDown } = acdRow.rows[0];

          // RTH bars for this session (post-OR period, 9:35+)
          const bars = await query(`
            SELECT ts, high::float, low::float, close::float
            FROM price_bars WHERE symbol='NQ' AND ts::date=$1
              AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 575 AND 959
            ORDER BY ts
          `, [date]);
          if (!bars.rows.length) { structuralBackfillJob.done++; continue; }

          const sessionHigh = Math.max(...bars.rows.map(b => b.high));
          const sessionLow  = Math.min(...bars.rows.map(b => b.low));
          const timeline = [];

          let gLineTouched=false, gLineLost=false, gLineReclaimed=false;
          let pwHighTouched=false, pwHighBroken=false;
          let pwLowTouched=false,  pwLowBroken=false;
          let pmVAHTouched=false,  pmVAHBroken=false;
          let pmVALTouched=false,  pmVALBroken=false;

          for (const bar of bars.rows) {
            const t = new Date(bar.ts).toISOString().slice(11, 16);
            const { high: hi, low: lo, close: cl } = bar;

            if (gLine) {
              if (!gLineTouched && lo <= gLine && hi >= gLine)
                { gLineTouched = true; timeline.push({ time: t, event: 'G-Line tested', price: gLine }); }
              if (!gLineLost && cl < gLine)
                { gLineLost = true; timeline.push({ time: t, event: 'G-Line lost', price: cl }); }
              if (gLineLost && !gLineReclaimed && cl > gLine)
                { gLineReclaimed = true; timeline.push({ time: t, event: 'G-Line reclaimed', price: cl }); }
            }
            if (pwHigh) {
              if (!pwHighTouched && hi >= pwHigh)
                { pwHighTouched = true; timeline.push({ time: t, event: 'PW High tested', price: pwHigh }); }
              if (!pwHighBroken && cl > pwHigh)
                { pwHighBroken = true; timeline.push({ time: t, event: 'PW High broken', price: cl }); }
            }
            if (pwLow) {
              if (!pwLowTouched && lo <= pwLow)
                { pwLowTouched = true; timeline.push({ time: t, event: 'PW Low tested', price: pwLow }); }
              if (!pwLowBroken && cl < pwLow)
                { pwLowBroken = true; timeline.push({ time: t, event: 'PW Low broken', price: cl }); }
            }
            if (pmVAH) {
              if (!pmVAHTouched && hi >= pmVAH)
                { pmVAHTouched = true; timeline.push({ time: t, event: 'PM VAH tested', price: pmVAH }); }
              if (!pmVAHBroken && cl > pmVAH)
                { pmVAHBroken = true; timeline.push({ time: t, event: 'PM VAH broken', price: cl }); }
            }
            if (pmVAL) {
              if (!pmVALTouched && lo <= pmVAL)
                { pmVALTouched = true; timeline.push({ time: t, event: 'PM VAL tested', price: pmVAL }); }
              if (!pmVALBroken && cl < pmVAL)
                { pmVALBroken = true; timeline.push({ time: t, event: 'PM VAL broken', price: cl }); }
            }
          }

          if (timeline.length > 0) {
            await saveSetupEvents(date, timeline, orH, orL, aUp, aDown, sessionHigh, sessionLow);
            structuralBackfillJob.eventsAdded += timeline.length;
          }
        } catch(e) {
          console.error(`Structural backfill error for ${date}:`, e.message);
        }
        structuralBackfillJob.done++;

        // Yield every 10 dates to keep the event loop breathing
        if (structuralBackfillJob.done % 10 === 0) await new Promise(r => setTimeout(r, 0));
      }

      structuralBackfillJob.status = 'complete';
      console.log(`📐 Structural events backfill complete — ${structuralBackfillJob.eventsAdded} events added across ${structuralBackfillJob.done} dates`);
    } catch(e) {
      structuralBackfillJob.status = 'error';
      structuralBackfillJob.error = e.message;
      console.error('Structural backfill fatal error:', e);
    }
  })();
});

// In-memory bulk backfill job state
let acdBulkJob = { status: 'idle', done: 0, total: 0, error: null };

// GET /api/acd/autocompute/bulk/status
app.get('/api/acd/autocompute/bulk/status', (req, res) => res.json(acdBulkJob));

// POST /api/acd/autocompute/bulk — backfill all dates with NQ bar data
app.post('/api/acd/autocompute/bulk', async (req, res) => {
  if (acdBulkJob.status === 'running') return res.status(409).json({ error: 'Bulk job already running' });

  const { or_minutes, a_multiplier, sustain_minutes } = req.body;
  const orMins   = parseInt(or_minutes)    || 5;
  const aMult    = parseFloat(a_multiplier) || 0.33;
  const sustainM = parseInt(sustain_minutes) || 3;

  res.json({ message: 'Bulk backfill started' });

  setImmediate(async () => {
    try {
      const datesRes = await query(`
        SELECT DISTINCT ts::date::text as d FROM price_bars
        WHERE symbol = 'NQ'
          AND EXTRACT(hour FROM ts) = 9 AND EXTRACT(minute FROM ts) = 30
        ORDER BY d
      `);
      const dates = datesRes.rows.map(r => r.d);
      acdBulkJob = { status: 'running', done: 0, total: dates.length, error: null };

      for (let i = 0; i < dates.length; i++) {
        const d = dates[i];
        try {
          const result = await computeACDFromBars(d, orMins, aMult, sustainM);
          if (result) {
            await query(`
              INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
              ON CONFLICT (trade_date) DO UPDATE SET
                or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
                a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
                daily_score=$11, session_close=$12
            `, [d, result.orHigh, result.orLow, aMult, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);
          }
        } catch(e) { /* skip individual date errors */ }
        acdBulkJob.done = i + 1;
      }
      acdBulkJob = { status: 'complete', done: acdBulkJob.total, total: acdBulkJob.total, error: null };
    } catch(e) {
      acdBulkJob = { status: 'error', done: acdBulkJob.done, total: acdBulkJob.total, error: e.message };
    }
  });
});

// POST /api/acd/pivot/autocompute — compute monthly pivot from price_bars
app.post('/api/acd/pivot/autocompute', async (req, res) => {
  try {
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const currentYear = nowET.getFullYear();
    const currentMonth = nowET.getMonth(); // 0-indexed
    // Prior month
    const priorMonth = currentMonth === 0 ? 12 : currentMonth;
    const priorYear  = currentMonth === 0 ? currentYear - 1 : currentYear;
    const monthYear  = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;

    const priorFrom = `${priorYear}-${String(priorMonth).padStart(2, '0')}-01`;
    const priorTo   = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`;

    const r = await query(`
      SELECT
        MAX(high)   as prior_month_high,
        MIN(low)    as prior_month_low,
        (SELECT close FROM price_bars WHERE symbol='NQ'
          AND ts >= $1::date AND ts < $2::date
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          ORDER BY ts DESC LIMIT 1) as prior_month_close
      FROM price_bars
      WHERE symbol = 'NQ'
        AND ts >= $1::date AND ts < $2::date
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    `, [priorFrom, priorTo]);

    const { prior_month_high: ph, prior_month_low: pl, prior_month_close: pc } = r.rows[0];
    if (!ph || !pl || !pc) return res.status(404).json({ error: 'Insufficient bar data for prior month' });

    const pivot = (parseFloat(ph) + parseFloat(pl) + parseFloat(pc)) / 3;
    const r1 = 2 * pivot - parseFloat(pl);
    const s1 = 2 * pivot - parseFloat(ph);

    const saved = await query(`
      INSERT INTO acd_monthly_pivot (month_year, prior_month_high, prior_month_low, prior_month_close, pivot_level, pivot_r1, pivot_s1)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (month_year) DO UPDATE SET
        prior_month_high=$2, prior_month_low=$3, prior_month_close=$4,
        pivot_level=$5, pivot_r1=$6, pivot_s1=$7
      RETURNING *
    `, [monthYear, ph, pl, pc, pivot, r1, s1]);

    res.json(saved.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/correlation — cross-reference existing trades with ACD log
app.get('/api/acd/correlation', async (req, res) => {
  try {
    const accounts = req.query.accounts ? req.query.accounts.split(',') : null;
    const acctFilter = accounts?.length ? `AND t.custom_fields->>'account' = ANY($1::text[])` : '';
    const params = accounts?.length ? [accounts] : [];

    const trades = await query(`
      SELECT t.id, t.entry_time, t.exit_time, t.pnl, t.setup_type,
             t.entry_time::date::text as trade_date
      FROM trades t
      WHERE t.exit_time IS NOT NULL AND t.pnl IS NOT NULL
        ${acctFilter}
      ORDER BY t.entry_time
    `, params);

    const acdDays = await query('SELECT trade_date::text as trade_date, daily_score, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed FROM acd_daily_log');

    const acdMap = {};
    for (const d of acdDays.rows) {
      acdMap[d.trade_date] = d;
    }

    const tagged = trades.rows.map(t => {
      const rawDate = t.trade_date;
      const dateKey = typeof rawDate === 'string' ? rawDate : rawDate?.toISOString?.()?.split('T')[0] ?? '';
      const acd = acdMap[dateKey];
      const signal = acd?.a_up_fired ? 'A_UP' : acd?.a_down_fired ? 'A_DOWN' : acd ? 'NO_SIGNAL' : null;
      const confirmed = acd?.c_up_confirmed || acd?.c_down_confirmed;
      const pnl = parseFloat(t.pnl);
      return { ...t, pnl, acdSignal: signal, acdConfirmed: confirmed, acdScore: acd?.daily_score ?? null };
    });

    const withSignal  = tagged.filter(t => t.acdSignal === 'A_UP' || t.acdSignal === 'A_DOWN');
    const noSignal    = tagged.filter(t => t.acdSignal === 'NO_SIGNAL');
    const untagged    = tagged.filter(t => t.acdSignal === null);
    const aUpTrades   = tagged.filter(t => t.acdSignal === 'A_UP');
    const aDownTrades = tagged.filter(t => t.acdSignal === 'A_DOWN');
    const confirmed   = tagged.filter(t => t.acdConfirmed);

    const stats = (arr) => arr.length === 0 ? { count: 0, winRate: null, avgPnl: null } : {
      count: arr.length,
      winRate: arr.filter(t => t.pnl > 0).length / arr.length,
      avgPnl: arr.reduce((s, t) => s + t.pnl, 0) / arr.length,
    };

    res.json({
      totalTrades: tagged.length,
      acdLogDays: acdDays.rows.length,
      withSignal:  stats(withSignal),
      noSignal:    stats(noSignal),
      aUp:         stats(aUpTrades),
      aDown:       stats(aDownTrades),
      confirmed:   stats(confirmed),
      untagged: untagged.length,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Weekly ACD computation ────────────────────────────────────────────────────

async function computeWeeklyACD(weekStart, aMultiplier = 0.33, sustainMinutes = 5) {
  // Get all RTH bars for this week, grouped by day
  const bars = await query(`
    SELECT ts::date::text as date, to_char(ts, 'HH24:MI') as time,
           high::float, low::float, close::float
    FROM price_bars
    WHERE symbol = 'NQ'
      AND ts::date >= $1::date
      AND ts::date < $1::date + interval '7 days'
      AND EXTRACT(dow FROM ts::date) BETWEEN 1 AND 5
      AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    ORDER BY ts
  `, [weekStart]);

  if (bars.rows.length === 0) return null;

  // Group by day
  const byDay = {};
  for (const b of bars.rows) {
    if (!byDay[b.date]) byDay[b.date] = [];
    byDay[b.date].push(b);
  }
  const days = Object.keys(byDay).sort();
  if (days.length < 2) return null;

  // First trading day of week = OR day (handles holiday Mondays)
  const orDay = days[0];
  const orBars = byDay[orDay];
  const orHigh = Math.max(...orBars.map(b => b.high));
  const orLow  = Math.min(...orBars.map(b => b.low));
  const orRange = orHigh - orLow;
  if (orRange === 0) return null;

  const aUp   = orHigh + orRange * aMultiplier;
  const aDown = orLow  - orRange * aMultiplier;

  // Scan remaining days for A signal using sustain logic
  const restDays = days.slice(1);
  let aUpFired = false, aUpDay = null;
  let aDownFired = false, aDownDay = null;
  let aUpTime = null, aDownTime = null;

  outer: for (const day of restDays) {
    for (const bar of byDay[day]) {
      if (!aDownTime) {
        if (!aUpTime && bar.high >= aUp) aUpTime = `${day} ${bar.time}`;
        if (aUpTime) {
          const [td, tt] = aUpTime.split(' ');
          const minsHeld = td === day
            ? (parseInt(bar.time.split(':')[0]) * 60 + parseInt(bar.time.split(':')[1])) -
              (parseInt(tt.split(':')[0]) * 60 + parseInt(tt.split(':')[1]))
            : 999; // carried from prior day = definitely sustained
          if (bar.low < orHigh) { aUpTime = null; }
          else if (minsHeld >= sustainMinutes) {
            aUpFired = true; aUpDay = day; break outer;
          }
        }
      }
      if (!aUpTime) {
        if (!aDownTime && bar.low <= aDown) aDownTime = `${day} ${bar.time}`;
        if (aDownTime) {
          const [td, tt] = aDownTime.split(' ');
          const minsHeld = td === day
            ? (parseInt(bar.time.split(':')[0]) * 60 + parseInt(bar.time.split(':')[1])) -
              (parseInt(tt.split(':')[0]) * 60 + parseInt(tt.split(':')[1]))
            : 999;
          if (bar.high > orLow) { aDownTime = null; }
          else if (minsHeld >= sustainMinutes) {
            aDownFired = true; aDownDay = day; break outer;
          }
        }
      }
    }
    // Reset sustain tracker at day boundary (but keep track of which signal was reached)
    if (aUpTime && !aUpFired) aUpTime = `${day} 999`; // mark as "carried over"
    if (aDownTime && !aDownFired) aDownTime = `${day} 999`;
  }

  // C confirmation: close above OR high (for A Up) or below OR low (for A Down) on any rest day
  let cUpConfirmed = false, cDownConfirmed = false;
  for (const day of restDays) {
    const dayBars = byDay[day];
    const lastClose = dayBars[dayBars.length - 1]?.close;
    if (lastClose === undefined) continue;
    if (aUpFired   && lastClose > orHigh) { cUpConfirmed   = true; break; }
    if (aDownFired && lastClose < orLow)  { cDownConfirmed = true; break; }
  }

  let score = 0;
  if (aUpFired   && cUpConfirmed)   score =  4;
  else if (aUpFired)                score =  1;
  else if (aDownFired && cDownConfirmed) score = -4;
  else if (aDownFired)              score = -1;

  const weekClose = byDay[days[days.length - 1]]?.slice(-1)[0]?.close ?? null;

  return {
    weekStart, orDay, orHigh, orLow, aMultiplier,
    aUpLevel: Math.round(aUp * 100) / 100,
    aDownLevel: Math.round(aDown * 100) / 100,
    aUpFired, aUpDay, aDownFired, aDownDay,
    cUpConfirmed, cDownConfirmed, score, weekClose,
  };
}

async function saveWeeklyACD(r) {
  await query(`
    INSERT INTO acd_weekly_log
      (week_start, or_day, or_high, or_low, a_multiplier, a_up_level, a_down_level,
       a_up_fired, a_up_day, a_down_fired, a_down_day,
       c_up_confirmed, c_down_confirmed, daily_score, week_close)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (week_start) DO UPDATE SET
      or_day=$2, or_high=$3, or_low=$4, a_multiplier=$5, a_up_level=$6, a_down_level=$7,
      a_up_fired=$8, a_up_day=$9, a_down_fired=$10, a_down_day=$11,
      c_up_confirmed=$12, c_down_confirmed=$13, daily_score=$14, week_close=$15
  `, [r.weekStart, r.orDay, r.orHigh, r.orLow, r.aMultiplier,
      r.aUpLevel, r.aDownLevel, r.aUpFired, r.aUpDay, r.aDownFired, r.aDownDay,
      r.cUpConfirmed, r.cDownConfirmed, r.score, r.weekClose]);
}

// GET /api/acd/weekly — recent weekly log
app.get('/api/acd/weekly', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 52;
    const r = await query(`
      SELECT *, week_start::text, or_day::text, a_up_day::text, a_down_day::text
      FROM acd_weekly_log ORDER BY week_start DESC LIMIT $1
    `, [limit]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/weekly/numberline
app.get('/api/acd/weekly/numberline', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        week_start::text as date,
        daily_score as score,
        SUM(daily_score) OVER (ORDER BY week_start ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30,
        SUM(daily_score) OVER (ORDER BY week_start ROWS BETWEEN 9  PRECEDING AND CURRENT ROW) as nl10
      FROM acd_weekly_log
      ORDER BY week_start ASC
    `);
    const rows = r.rows.map(row => ({ date: row.date, score: parseInt(row.score), nl30: parseInt(row.nl30), nl10: parseInt(row.nl10) }));
    const latest = rows[rows.length - 1];
    const nl30 = latest?.nl30 || 0;
    const trend = nl30 > 9 ? 'TRENDING_UP' : nl30 < -9 ? 'TRENDING_DOWN' : 'RANGING';
    res.json({ nl30, nl10: latest?.nl10 || 0, trend, history: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/acd/confluence — multi-timeframe alignment score
app.get('/api/acd/confluence', async (req, res) => {
  try {
    // Daily NL
    const dNL = await query(`
      SELECT COALESCE(SUM(daily_score), 0) as nl30
      FROM (SELECT daily_score FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) s
    `);
    const dailyNL30 = parseInt(dNL.rows[0]?.nl30) || 0;
    const dailyTrend = dailyNL30 > 9 ? 'up' : dailyNL30 < -9 ? 'down' : 'ranging';

    // Weekly NL
    const wNL = await query(`
      SELECT COALESCE(SUM(daily_score), 0) as nl30
      FROM (SELECT daily_score FROM acd_weekly_log ORDER BY week_start DESC LIMIT 30) s
    `);
    const weeklyNL30 = parseInt(wNL.rows[0]?.nl30) || 0;
    const weeklyTrend = weeklyNL30 > 9 ? 'up' : weeklyNL30 < -9 ? 'down' : 'ranging';

    // Monthly pivot vs latest bar
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const monthYear = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}`;
    const pivot = await query('SELECT pivot_level FROM acd_monthly_pivot WHERE month_year=$1', [monthYear]);
    const latestBar = await query(`SELECT close::float as close FROM price_bars WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
    const nqClose = latestBar.rows[0]?.close || 0;
    const pivotLevel = parseFloat(pivot.rows[0]?.pivot_level) || null;
    const pivotBias = pivotLevel ? (nqClose > pivotLevel ? 'up' : 'down') : null;

    // Today's ACD state
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const todayACD = await query(`SELECT a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
    const today = todayACD.rows[0];

    // Confluence scoring: how many timeframes align with daily trend?
    let score = 0, maxScore = 0, details = [];
    const dir = dailyTrend; // anchor to daily

    if (dailyTrend !== 'ranging') {
      maxScore++;
      if (true) { score++; details.push({ label: 'Daily NL', state: dailyTrend, aligned: true }); }
    } else {
      details.push({ label: 'Daily NL', state: 'ranging', aligned: false });
    }

    if (weeklyTrend !== 'ranging') {
      maxScore++;
      const aligned = weeklyTrend === dir;
      if (aligned) score++;
      details.push({ label: 'Weekly NL', state: weeklyTrend, aligned });
    } else {
      details.push({ label: 'Weekly NL', state: 'ranging', aligned: false });
    }

    if (pivotBias) {
      maxScore++;
      const aligned = pivotBias === dir;
      if (aligned) score++;
      details.push({ label: 'Monthly Pivot', state: pivotBias, aligned });
    } else {
      details.push({ label: 'Monthly Pivot', state: null, aligned: false });
    }

    // Hold recommendation
    let holdRec, holdColor;
    if (score >= 3) { holdRec = 'Multi-day hold'; holdColor = '#22c55e'; }
    else if (score === 2) { holdRec = '1–2 day hold'; holdColor = '#86efac'; }
    else if (score === 1) { holdRec = 'Day trade only'; holdColor = '#fbbf24'; }
    else { holdRec = 'Stand aside'; holdColor = '#ef4444'; }

    res.json({
      score, maxScore, dir, holdRec, holdColor,
      dailyNL30, weeklyNL30, pivotLevel, nqClose, pivotBias,
      dailyTrend, weeklyTrend, details,
      todaySignal: today ? (today.a_up_fired ? 'A_UP' : today.a_down_fired ? 'A_DOWN' : null) : null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/acd/weekly/autocompute/bulk
let weeklyBulkJob = { status: 'idle', done: 0, total: 0, error: null };
app.get('/api/acd/weekly/bulk/status', (req, res) => res.json(weeklyBulkJob));

app.post('/api/acd/weekly/autocompute/bulk', async (req, res) => {
  if (weeklyBulkJob.status === 'running') return res.status(409).json({ error: 'Already running' });
  const aMultiplier = parseFloat(req.body?.a_multiplier) || 0.33;
  const sustainMinutes = parseInt(req.body?.sustain_minutes) || 5;
  res.json({ message: 'Weekly ACD backfill started' });

  setImmediate(async () => {
    try {
      const weeksRes = await query(`
        SELECT DISTINCT date_trunc('week', ts::date)::date::text as week_start
        FROM price_bars
        WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        ORDER BY week_start
      `);
      const weeks = weeksRes.rows.map(r => r.week_start);
      weeklyBulkJob = { status: 'running', done: 0, total: weeks.length, error: null };
      for (let i = 0; i < weeks.length; i++) {
        try {
          const r = await computeWeeklyACD(weeks[i], aMultiplier, sustainMinutes);
          if (r) await saveWeeklyACD(r);
        } catch(e) {}
        weeklyBulkJob.done = i + 1;
      }
      weeklyBulkJob = { status: 'complete', done: weeks.length, total: weeks.length, error: null };
      console.log(`📐 Weekly ACD backfill complete: ${weeks.length} weeks`);
    } catch(e) {
      weeklyBulkJob = { status: 'error', done: weeklyBulkJob.done, total: weeklyBulkJob.total, error: e.message };
    }
  });
});

// ── Sierra Chart chart image auto-watcher ────────────────────────────────────
// Watches the Sierra Chart Images folder for PNG/BMP files exported by the
// "Save Chart Image to File" study and auto-imports them into daily_charts.

const SIERRA_IMAGES_DIR = process.env.SIERRA_IMAGES_PATH || '/mnt/c/SierraChart/Images';
const seenChartImages = new Map(); // filename → { mtime, size }

async function ingestChartImage(filePath) {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();
  if (!/\.(png|jpg|jpeg|bmp)$/i.test(filename)) return;

  const stat = fs.statSync(filePath);
  const key = filename;
  const prev = seenChartImages.get(key);
  if (prev && prev.mtime === stat.mtimeMs && prev.size === stat.size) return; // unchanged
  seenChartImages.set(key, { mtime: stat.mtimeMs, size: stat.size });

  // Determine the date this chart is for.
  // Priority: date embedded in filename (YYYY-MM-DD or YYYYMMDD)
  // Fallback: today in ET
  let chartDate = null;
  const isoMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
  const compactMatch = filename.match(/(\d{8})/);
  if (isoMatch) {
    chartDate = isoMatch[1];
  } else if (compactMatch) {
    const d = compactMatch[1];
    chartDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
  } else {
    chartDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }

  // Copy to uploads/charts/YYYY-MM-DD.ext
  const destFilename = `${chartDate}${ext === '.bmp' ? '.png' : ext}`;
  const destPath = path.join(chartsDir, destFilename);

  try {
    if (ext === '.bmp') {
      // Convert BMP → PNG via canvas if available, otherwise just copy and rename
      // For now: copy as-is with .png extension (browsers handle BMP as PNG in most cases,
      // and the journal's <img> tag will render it)
      fs.copyFileSync(filePath, destPath);
    } else {
      fs.copyFileSync(filePath, destPath);
    }

    const existing = await query('SELECT image_path FROM daily_charts WHERE log_date = $1', [chartDate]);
    if (existing.rows.length && existing.rows[0].image_path !== destPath) {
      try { fs.unlinkSync(existing.rows[0].image_path); } catch(_) {}
    }

    await query(`
      INSERT INTO daily_charts (log_date, image_path, chart_type)
      VALUES ($1, $2, 'daily')
      ON CONFLICT (log_date) DO UPDATE SET image_path = $2, analysis = NULL, analyzed_at = NULL
    `, [chartDate, destPath]);

    console.log(`📸 Chart image auto-imported: ${filename} → ${chartDate}`);
    io.emit('chart-imported', { date: chartDate, image_url: `/uploads/charts/${destFilename}` });
  } catch(e) {
    console.error(`📸 Chart image import error (${filename}):`, e.message);
  }
}

function startChartImageWatcher() {
  if (!fs.existsSync(SIERRA_IMAGES_DIR)) {
    console.log(`📸 Chart image watcher: directory not found (${SIERRA_IMAGES_DIR}) — will retry`);
    setTimeout(startChartImageWatcher, 30000);
    return;
  }
  console.log(`📸 Watching for chart images: ${SIERRA_IMAGES_DIR}`);

  // Snapshot existing files so we don't import old ones on startup
  try {
    const existing = fs.readdirSync(SIERRA_IMAGES_DIR);
    for (const f of existing) {
      const fp = path.join(SIERRA_IMAGES_DIR, f);
      try {
        const stat = fs.statSync(fp);
        seenChartImages.set(f, { mtime: stat.mtimeMs, size: stat.size });
      } catch(_) {}
    }
  } catch(_) {}

  setInterval(async () => {
    try {
      if (!fs.existsSync(SIERRA_IMAGES_DIR)) return;
      const files = fs.readdirSync(SIERRA_IMAGES_DIR)
        .filter(f => /\.(png|jpg|jpeg|bmp)$/i.test(f));
      for (const f of files) {
        const fp = path.join(SIERRA_IMAGES_DIR, f);
        try { await ingestChartImage(fp); } catch(_) {}
      }
    } catch(_) {}
  }, 5 * 60 * 1000); // 5 minutes
}

// ── ACD auto-trigger helpers ──────────────────────────────────────────────────

async function getBestACDParams() {
  try {
    const s = await query('SELECT acd_or_minutes, acd_a_multiplier, acd_sustain_minutes FROM risk_settings ORDER BY id LIMIT 1');
    if (s.rows[0]?.acd_a_multiplier) {
      return { orMins: parseInt(s.rows[0].acd_or_minutes) || 5, aMult: parseFloat(s.rows[0].acd_a_multiplier) || 0.25, sustainMins: parseInt(s.rows[0].acd_sustain_minutes) || 5 };
    }
    // Fall back to best from backtest results
    const best = await query(`SELECT or_minutes, a_multiplier, sustain_minutes FROM acd_backtest_results ORDER BY ev_per_signal DESC NULLS LAST LIMIT 1`);
    if (best.rows.length) return { orMins: best.rows[0].or_minutes, aMult: parseFloat(best.rows[0].a_multiplier), sustainMins: best.rows[0].sustain_minutes };
  } catch(e) {}
  return { orMins: 5, aMult: 0.25, sustainMins: 5 };
}

async function computeORLevelsOnly(date, aMult) {
  // Compute just the OR and A levels from the first 5 bars after 9:30
  // Used to pre-populate levels as soon as 9:35 bars exist
  try {
    const orBars = await query(`
      SELECT high::float, low::float
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 574
      ORDER BY ts
    `, [date]);
    if (orBars.rows.length === 0) return null;
    const orHigh = Math.max(...orBars.rows.map(b => b.high));
    const orLow  = Math.min(...orBars.rows.map(b => b.low));
    const orRange = orHigh - orLow;
    if (orRange === 0) return null;
    const aUpLevel   = Math.round((orHigh + orRange * aMult) * 100) / 100;
    const aDownLevel = Math.round((orLow  - orRange * aMult) * 100) / 100;
    await query(`
      INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (trade_date) DO UPDATE SET
        or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6
      WHERE acd_daily_log.or_high IS NULL
    `, [date, orHigh, orLow, aMult, aUpLevel, aDownLevel]);
    return { orHigh, orLow, aUpLevel, aDownLevel };
  } catch(e) { return null; }
}

async function autoComputeTodayACD() {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hourET = nowET.getHours();
    const minET  = nowET.getMinutes();

    // Early: 9:35+ — just compute OR and A levels so they show during the session
    if (hourET === 9 && minET >= 35) {
      const { aMult } = await getBestACDParams();
      const levels = await computeORLevelsOnly(todayET, aMult);
      if (levels) console.log(`📐 OR levels pre-computed: A Up ${levels.aUpLevel} / A Down ${levels.aDownLevel}`);
      return;
    }
    if (hourET < 11) return;
    const existing = await query('SELECT id FROM acd_daily_log WHERE trade_date = $1', [todayET]);
    const { orMins, aMult, sustainMins } = await getBestACDParams();
    const result = await computeACDFromBars(todayET, orMins, aMult, sustainMins);
    if (!result) return;
    await query(`
      INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (trade_date) DO UPDATE SET
        or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
        a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
        daily_score=$11, session_close=$12
    `, [todayET, result.orHigh, result.orLow, aMult, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);
    console.log(`📐 ACD auto-logged: ${todayET} — score ${result.score > 0 ? '+' : ''}${result.score} (${result.aUpFired ? 'A Up' : result.aDownFired ? 'A Down' : 'No signal'})`);
    // Save setup events for pattern tracking
    setTimeout(() => scanAndSaveSetupEvents(todayET), 2000);
  } catch(e) { /* silent — bars may not be loaded yet */ }
}

async function autoBulkBackfillIfEmpty() {
  try {
    const count = await query('SELECT COUNT(*) as n FROM acd_daily_log');
    if (parseInt(count.rows[0].n) >= 10) return;
    console.log('📐 ACD daily log empty — starting automatic backfill from price bars…');
    const datesRes = await query(`
      SELECT DISTINCT ts::date::text as d FROM price_bars
      WHERE symbol = 'NQ' AND EXTRACT(hour FROM ts) = 9 AND EXTRACT(minute FROM ts) = 30
      ORDER BY d
    `);
    const dates = datesRes.rows.map(r => r.d);
    let done = 0;
    for (const d of dates) {
      try {
        const { orMins: bfOrMins, aMult: bfAMult, sustainMins: bfSustain } = await getBestACDParams();
        const result = await computeACDFromBars(d, bfOrMins, bfAMult, bfSustain);
        if (result) {
          await query(`
            INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT (trade_date) DO NOTHING
          `, [d, result.orHigh, result.orLow, 0.33, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);
        }
      } catch(e) {}
      done++;
      if (done % 50 === 0) console.log(`📐 ACD backfill: ${done}/${dates.length}`);
    }
    console.log(`📐 ACD backfill complete: ${done} days`);
    // Also auto-compute monthly pivot
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const priorMonth = nowET.getMonth() === 0 ? 12 : nowET.getMonth();
      const priorYear  = nowET.getMonth() === 0 ? nowET.getFullYear() - 1 : nowET.getFullYear();
      const priorFrom  = `${priorYear}-${String(priorMonth).padStart(2,'0')}-01`;
      const priorTo    = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}-01`;
      const monthYear  = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}`;
      const pr = await query(`SELECT MAX(high) as h, MIN(low) as l, (SELECT close FROM price_bars WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 ORDER BY ts DESC LIMIT 1) as c FROM price_bars WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [priorFrom, priorTo]);
      const { h: ph, l: pl, c: pc } = pr.rows[0];
      if (ph && pl && pc) {
        const piv = (parseFloat(ph) + parseFloat(pl) + parseFloat(pc)) / 3;
        await query(`INSERT INTO acd_monthly_pivot (month_year, prior_month_high, prior_month_low, prior_month_close, pivot_level, pivot_r1, pivot_s1) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (month_year) DO NOTHING`, [monthYear, ph, pl, pc, piv, 2*piv-parseFloat(pl), 2*piv-parseFloat(ph)]);
        console.log(`📐 Monthly pivot auto-set: ${monthYear} → ${piv.toFixed(2)}`);
      }
    } catch(e) {}
  } catch(e) { console.error('ACD auto-backfill error:', e.message); }
}

// ==================== AUCTION READ ROUTES ====================

// GET /api/composite-profile?days=5 — multi-day TPO composite profile
app.get('/api/composite-profile', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 5;
    const lbd = await latestBarDate();
    const cacheKey = `composite-tpo-${days}-${lbd}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Current price for context
    const latestBar = await query(`SELECT close::float as close FROM price_bars WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
    const currentPrice = latestBar.rows[0]?.close || null;

    // Build TPO composite: each 1-min bar contributes 1 count to each price level it spans
    const tpoQ = await query(`
      WITH bars AS (
        SELECT ROUND(low/0.25)*0.25 as lo, ROUND(high/0.25)*0.25 as hi
        FROM price_bars WHERE symbol='NQ'
          AND ts::date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      )
      SELECT ROUND((lo + s*0.25)::numeric, 2)::float as px, COUNT(*)::int as tpo
      FROM bars, generate_series(0, ROUND((hi-lo)/0.25)::int) s
      GROUP BY px ORDER BY px ASC
    `, [days]);

    if (!tpoQ.rows.length) return res.json({ available: false });

    const profile = tpoQ.rows; // [{px, tpo}]
    const totalTpo = profile.reduce((s, r) => s + r.tpo, 0);
    const maxTpo   = Math.max(...profile.map(r => r.tpo));

    // POC = most time spent
    const poc = profile.reduce((best, r) => r.tpo > best.tpo ? r : best, profile[0]);

    // Value area (70% of total TPO around POC)
    const target = totalTpo * 0.70;
    const pocIdx = profile.findIndex(r => r.px === poc.px);
    let lo = pocIdx, hi = pocIdx, accumulated = poc.tpo;
    while (accumulated < target && (lo > 0 || hi < profile.length - 1)) {
      const addLo = lo > 0 ? profile[lo - 1].tpo : 0;
      const addHi = hi < profile.length - 1 ? profile[hi + 1].tpo : 0;
      if (addLo >= addHi) { lo--; accumulated += addLo; }
      else { hi++; accumulated += addHi; }
    }
    const vah = profile[hi].px;
    const val = profile[lo].px;

    // HVN: local peaks (tpo > 80% of max and higher than both neighbors)
    const hvn = profile.filter((r, i) =>
      i > 0 && i < profile.length - 1 &&
      r.tpo > maxTpo * 0.65 &&
      r.tpo >= profile[i-1].tpo &&
      r.tpo >= profile[i+1].tpo
    ).map(r => r.px);

    // LVN: local valleys within value area (tpo < 30% of max between two HVNs)
    const lvn = profile.filter((r, i) =>
      i > 0 && i < profile.length - 1 &&
      r.px >= val && r.px <= vah &&
      r.tpo < maxTpo * 0.25 &&
      r.tpo <= profile[i-1].tpo &&
      r.tpo <= profile[i+1].tpo
    ).map(r => r.px);

    // Context: where is current price relative to composite
    let priceContext = null;
    if (currentPrice) {
      if (currentPrice > vah) priceContext = `Price above composite value area — buyers accepting prices above ${days}-session fair value. Initiative territory.`;
      else if (currentPrice < val) priceContext = `Price below composite value area — sellers pushing below ${days}-session fair value. Watch for responsive buyers at VAL (${val}).`;
      else if (Math.abs(currentPrice - poc.px) < 20) priceContext = `Price near composite POC (${poc.px}) — the most accepted price of the last ${days} sessions. Expect two-sided trade here.`;
      else if (currentPrice > poc.px) priceContext = `Price above composite POC (${poc.px}) within value — buyers in control of the ${days}-session range but not yet breaking out.`;
      else priceContext = `Price below composite POC (${poc.px}) within value — sellers in control of the ${days}-session range but not yet breaking down.`;
    }

    const result = {
      available: true, days,
      profile: profile.slice(0, 2000), // cap for response size
      poc: poc.px, pocTpo: poc.tpo,
      vah, val, hvn: hvn.slice(0, 10), lvn: lvn.slice(0, 10),
      totalTpo, maxTpo, currentPrice, priceContext,
      priceVsVA: currentPrice > vah ? 'ABOVE' : currentPrice < val ? 'BELOW' : 'INSIDE',
      priceVsPoc: currentPrice > poc.px ? 'ABOVE' : currentPrice < poc.px ? 'BELOW' : 'AT',
    };
    cacheSet(cacheKey, result, 4 * 60 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/backtest/conditions — backtest edge trades vs market structure over last N days
app.get('/api/backtest/conditions', async (req, res) => {
  try {
    const tradingDays = parseInt(req.query.days) || 90;
    // Convert trading days to calendar days (trading days × 1.4 to account for weekends/holidays)
    // Then cap at all available data by using a large window and LIMIT
    const rows = await query(`
      SELECT date::text, prior_vah::float, prior_val::float, prior_poc::float,
             session_open::float, session_close::float, session_high::float, session_low::float,
             a_up_fired, a_down_fired, pts_vs_open::float, nl30::int, bias_dir, prior_profile,
             or_high::float, or_low::float
      FROM auction_history
      WHERE session_open IS NOT NULL AND session_close IS NOT NULL
        AND prior_vah IS NOT NULL AND prior_val IS NOT NULL
      ORDER BY date DESC
      LIMIT $1
    `, [tradingDays + 10]); // +10 for the 5-day rolling window buffer
    rows.rows.reverse(); // oldest first

    const data = rows.rows;
    if (data.length < 6) return res.json({ available: false, reason: 'Insufficient history' });

    // Classify market structure for each day using prior 5 sessions
    function overlapCheck(days5) {
      let count = 0;
      for (let i = 1; i < days5.length; i++) {
        const prev = days5[i-1], curr = days5[i];
        if (!prev.prior_vah || !curr.prior_vah) continue;
        const lo = Math.max(prev.prior_val, curr.prior_val);
        const hi = Math.min(prev.prior_vah, curr.prior_vah);
        if (hi > lo) count++;
      }
      return count;
    }
    function migrationDir(days5) {
      if (days5.length < 3) return 'OVERLAPPING';
      let up = 0, down = 0;
      for (let i = 1; i < days5.length; i++) {
        if (days5[i].prior_poc > days5[i-1].prior_poc) up++;
        else if (days5[i].prior_poc < days5[i-1].prior_poc) down++;
      }
      const t = days5.length - 1;
      if (up / t >= 0.65) return 'HIGHER';
      if (down / t >= 0.65) return 'LOWER';
      return 'OVERLAPPING';
    }

    const results = [];
    for (let i = 5; i < data.length; i++) {
      const d     = data[i];
      const prior = data.slice(Math.max(0, i-5), i);
      const overlaps = overlapCheck(prior);
      const dir5     = migrationDir(prior);
      const nlState  = d.nl30 > 9 ? 'BULLISH' : d.nl30 < -9 ? 'BEARISH' : 'RANGING';

      // Classify structure
      let structure;
      if (overlaps >= 4)      structure = 'BRACKET';
      else if (overlaps >= 3) structure = dir5 === 'HIGHER' ? 'BRACKET_TILTING_UP' : dir5 === 'LOWER' ? 'BRACKET_TILTING_DOWN' : 'BRACKET';
      else if (dir5 === 'HIGHER') structure = 'TRENDING_UP';
      else if (dir5 === 'LOWER')  structure = 'TRENDING_DOWN';
      else                        structure = 'TRANSITIONAL';

      // --- Edge trade evaluation ---
      const vah = d.prior_vah, val = d.prior_val, poc = d.prior_poc;
      const open = d.session_open, close = d.session_close;
      const high = d.session_high, low = d.session_low;
      const orRange = (d.or_high && d.or_low) ? d.or_high - d.or_low : 80;
      const nearThresh = orRange * 0.5; // within 50% of OR range = "near the level"

      const trades = [];

      // BRACKET / TILTING: fade from VAH if opened above/near it
      if (structure.startsWith('BRACKET')) {
        if (open >= vah - nearThresh) {
          // Opened near or above VAH — fade short toward POC
          const target = poc;
          const success = close < vah; // returned inside value
          const ptsGained = vah - close; // positive = move worked
          const hitTarget = low <= target; // touched POC on the way
          trades.push({ type: 'FADE_VAH', structure, success, ptsGained: Math.round(ptsGained), hitTarget, nl: nlState, date: d.date });
        }
        if (open <= val + nearThresh) {
          // Opened near or below VAL — fade long toward POC
          const target = poc;
          const success = close > val;
          const ptsGained = close - val;
          const hitTarget = high >= target;
          trades.push({ type: 'FADE_VAL', structure, success, ptsGained: Math.round(ptsGained), hitTarget, nl: nlState, date: d.date });
        }
      }

      // TRENDING_UP: A Up fired — did following it work?
      if (structure === 'TRENDING_UP' && d.a_up_fired) {
        const success = (d.pts_vs_open || 0) > 0;
        trades.push({ type: 'TREND_A_UP', structure, success, ptsGained: Math.round(d.pts_vs_open || 0), nl: nlState, date: d.date });
      }
      // TRENDING_DOWN: A Down fired
      if (structure === 'TRENDING_DOWN' && d.a_down_fired) {
        const success = (d.pts_vs_open || 0) < 0;
        trades.push({ type: 'TREND_A_DOWN', structure, success, ptsGained: Math.round(-(d.pts_vs_open || 0)), nl: nlState, date: d.date });
      }

      // A SIGNAL QUALITY BY NL30 — all days with A signals
      if (d.a_up_fired) {
        const success = (d.pts_vs_open || 0) > 0;
        trades.push({ type: 'A_UP_BY_NL', structure, success, ptsGained: Math.round(d.pts_vs_open || 0), nl: nlState, date: d.date, nlNum: d.nl30 });
      }
      if (d.a_down_fired) {
        const success = (d.pts_vs_open || 0) < 0;
        trades.push({ type: 'A_DOWN_BY_NL', structure, success, ptsGained: Math.round(-(d.pts_vs_open || 0)), nl: nlState, date: d.date, nlNum: d.nl30 });
      }

      results.push(...trades);
    }

    // Aggregate by trade type + structure/nl
    function agg(trades) {
      const n = trades.length;
      if (!n) return null;
      const wins = trades.filter(t => t.success).length;
      const pts  = trades.reduce((s, t) => s + t.ptsGained, 0);
      return {
        n,
        winRate: Math.round(wins / n * 100),
        avgPts: Math.round(pts / n),
        totalPts: pts,
        wins,
        sample: trades.slice(-5).map(t => ({ date: t.date, success: t.success, pts: t.ptsGained })),
      };
    }

    // Group fade trades
    const fadeVAH        = agg(results.filter(t => t.type === 'FADE_VAH'));
    const fadeVAHBracket = agg(results.filter(t => t.type === 'FADE_VAH' && t.structure === 'BRACKET'));
    const fadeVAHTilting = agg(results.filter(t => t.type === 'FADE_VAH' && t.structure.includes('TILTING')));
    const fadeVAL        = agg(results.filter(t => t.type === 'FADE_VAL'));
    const fadeVALBracket = agg(results.filter(t => t.type === 'FADE_VAL' && t.structure === 'BRACKET'));
    const fadeVALTilting = agg(results.filter(t => t.type === 'FADE_VAL' && t.structure.includes('TILTING')));

    // A signal quality by NL30
    const aUpBullish  = agg(results.filter(t => t.type === 'A_UP_BY_NL'  && t.nl === 'BULLISH'));
    const aUpRanging  = agg(results.filter(t => t.type === 'A_UP_BY_NL'  && t.nl === 'RANGING'));
    const aUpBearish  = agg(results.filter(t => t.type === 'A_UP_BY_NL'  && t.nl === 'BEARISH'));
    const aDownBearish= agg(results.filter(t => t.type === 'A_DOWN_BY_NL'&& t.nl === 'BEARISH'));
    const aDownRanging= agg(results.filter(t => t.type === 'A_DOWN_BY_NL'&& t.nl === 'RANGING'));
    const aDownBullish= agg(results.filter(t => t.type === 'A_DOWN_BY_NL'&& t.nl === 'BULLISH'));

    // Trend trades
    const trendUp   = agg(results.filter(t => t.type === 'TREND_A_UP'));
    const trendDown = agg(results.filter(t => t.type === 'TREND_A_DOWN'));

    // By structure — overall win rates
    const byStructure = {};
    for (const s of ['BRACKET','BRACKET_TILTING_UP','BRACKET_TILTING_DOWN','TRENDING_UP','TRENDING_DOWN','TRANSITIONAL']) {
      const days = [...new Set(results.filter(t => t.structure === s).map(t => t.date))];
      byStructure[s] = { days: days.length };
    }

    // ── Per-day log ──────────────────────────────────────────────────────────
    const dailyLog = [];
    for (let i = 5; i < data.length; i++) {
      const d     = data[i];
      const prior = data.slice(Math.max(0, i-5), i);
      const overlaps = overlapCheck(prior);
      const dir5     = migrationDir(prior);
      const nlState  = d.nl30 > 9 ? 'BULLISH' : d.nl30 < -9 ? 'BEARISH' : 'RANGING';

      let structure;
      if (overlaps >= 4)      structure = dir5 === 'HIGHER' ? 'BRACKET_TILTING_UP' : dir5 === 'LOWER' ? 'BRACKET_TILTING_DOWN' : 'BRACKET';
      else if (overlaps >= 3) structure = dir5 === 'HIGHER' ? 'BRACKET_TILTING_UP' : dir5 === 'LOWER' ? 'BRACKET_TILTING_DOWN' : 'BRACKET';
      else if (dir5 === 'HIGHER') structure = 'TRENDING_UP';
      else if (dir5 === 'LOWER')  structure = 'TRENDING_DOWN';
      else                        structure = 'TRANSITIONAL';

      // Determine the edge for this day
      const vah = d.prior_vah, val = d.prior_val, poc = d.prior_poc;
      const open = d.session_open, close = d.session_close;
      const pts = d.pts_vs_open || 0;
      const aUp = d.a_up_fired, aDown = d.a_down_fired;

      let suggestedEdge, edgeResult, edgeWorked;

      if (structure === 'BRACKET' || structure === 'BRACKET_TILTING_UP' || structure === 'BRACKET_TILTING_DOWN') {
        const tiltUp   = structure === 'BRACKET_TILTING_UP';
        const tiltDown = structure === 'BRACKET_TILTING_DOWN';
        if (tiltUp) {
          suggestedEdge = 'CAUTION: Do not fade VAH. Buy near VAL only. Wait for confirmed VAH break.';
          // Edge: only long from VAL
          edgeResult = open <= val + 50 ? (close > val ? `+${Math.round(close-val)}pts` : `${Math.round(close-val)}pts`) : 'No edge setup (opened inside value)';
          edgeWorked = open <= val + 50 ? close > val : null;
        } else if (tiltDown) {
          suggestedEdge = 'CAUTION: Do not fade VAL. Sell near VAH only. Wait for confirmed VAL break.';
          edgeResult = open >= vah - 50 ? (close < vah ? `+${Math.round(vah-close)}pts` : `${Math.round(vah-close)}pts`) : 'No edge setup';
          edgeWorked = open >= vah - 50 ? close < vah : null;
        } else {
          suggestedEdge = 'Fade VAH short → POC, or fade VAL long → POC';
          if (open >= vah - 50) {
            edgeResult = close < vah ? `Fade VAH worked +${Math.round(vah-close)}pts` : `Fade VAH failed ${Math.round(vah-close)}pts`;
            edgeWorked = close < vah;
          } else if (open <= val + 50) {
            edgeResult = close > val ? `Fade VAL worked +${Math.round(close-val)}pts` : `Fade VAL failed ${Math.round(close-val)}pts`;
            edgeWorked = close > val;
          } else {
            edgeResult = 'Opened inside value — no edge at extremes';
            edgeWorked = null;
          }
        }
      } else if (structure === 'TRENDING_UP') {
        suggestedEdge = nlState === 'BULLISH' ? 'Follow A Up signal, trail to prior VAH (NL30 aligned ✓)' : 'Follow A Up if fires — reduced conviction (NL30 ranging)';
        if (aUp) {
          edgeResult = pts > 0 ? `A Up followed, closed +${Math.round(pts)}pts` : `A Up followed, closed ${Math.round(pts)}pts`;
          edgeWorked = pts > 0;
        } else {
          edgeResult = 'No A Up fired — no initiative entry signal';
          edgeWorked = null;
        }
      } else if (structure === 'TRENDING_DOWN') {
        suggestedEdge = nlState === 'BEARISH' ? 'Follow A Down signal, trail to prior VAL (NL30 aligned ✓)' : 'Follow A Down if fires — reduced conviction';
        if (aDown) {
          edgeResult = pts < 0 ? `A Down followed, closed ${Math.round(pts)}pts` : `A Down followed, closed +${Math.round(pts)}pts (failed)`;
          edgeWorked = pts < 0;
        } else {
          edgeResult = 'No A Down fired — no initiative entry signal';
          edgeWorked = null;
        }
      } else { // TRANSITIONAL
        suggestedEdge = 'Reduce size 50%+. Wait for first confirmed VA migration day before entering.';
        edgeResult = `Session moved ${pts > 0 ? '+' : ''}${Math.round(pts)}pts — ${Math.abs(pts) < 30 ? 'rotational' : pts > 0 ? 'bullish breakout attempt' : 'bearish breakdown attempt'}`;
        edgeWorked = null; // no directional bet recommended
      }

      // Actual session characterization
      const actualChar = aUp && pts > 0 ? 'A Up + closed up ✓' :
                         aDown && pts < 0 ? 'A Down + closed down ✓' :
                         aUp && pts < 0 ? 'A Up but closed down ✗' :
                         aDown && pts > 0 ? 'A Down but closed up ✗' :
                         pts > 30 ? 'No signal, closed up' :
                         pts < -30 ? 'No signal, closed down' : 'Rotational/neutral';

      dailyLog.push({
        date: d.date,
        structure,
        nlState,
        nl30: d.nl30,
        dir5,
        overlaps,
        priorVAH: Math.round(vah || 0),
        priorVAL: Math.round(val || 0),
        priorPOC: Math.round(poc || 0),
        sessionOpen: Math.round(open),
        sessionClose: Math.round(close),
        ptsVsOpen: Math.round(pts),
        aUpFired: !!aUp,
        aDownFired: !!aDown,
        suggestedEdge,
        edgeResult,
        edgeWorked,
        actualChar,
      });
    }

    res.json({
      available: true, totalDays: data.length - 5, days: tradingDays,
      fades: { vah: fadeVAH, vahBracket: fadeVAHBracket, vahTilting: fadeVAHTilting, val: fadeVAL, valBracket: fadeVALBracket, valTilting: fadeVALTilting },
      aSignals: { aUpBullish, aUpRanging, aUpBearish, aDownBearish, aDownRanging, aDownBullish },
      trends: { up: trendUp, down: trendDown },
      byStructure, rawCount: results.length,
      dailyLog: dailyLog.reverse(), // most recent first
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/longterm/summary — all long-term structure components in one call
app.get('/api/longterm/summary', async (req, res) => {
  try {
    const lbd = await latestBarDate();
    const cached = cacheGet(`longterm-summary-${lbd}`);
    if (cached) return res.json(cached);

    // ── Value areas: last 30 trading days ──────────────────────────────────
    const tradingDays = await query(`
      SELECT DISTINCT ts::date::text as date
      FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY date DESC LIMIT 30
    `);

    const vaRows = [];
    for (const { date } of tradingDays.rows) {
      try {
        const r = await query(`
          WITH vp AS (
            SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
            FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
            GROUP BY ROUND(low/0.25)*0.25
          ), total AS (SELECT SUM(vol) as t FROM vp),
          poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
          SELECT p.poc_px::float as poc,
            (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) s WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
            (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC)  cv FROM vp WHERE px<=p.poc_px) s WHERE cv<=(SELECT t*0.35 FROM total))::float as val,
            MAX(vp.px)::float as day_high, MIN(vp.px)::float as day_low,
            (SELECT (array_agg(close ORDER BY ts DESC))[1]::float FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16) as day_close
          FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
        `, [date]);
        const sh = await query(`SELECT l.profile_shape FROM acd_daily_log l WHERE l.trade_date=$1`, [date]);
        if (r.rows[0]?.vah) vaRows.push({ date, ...r.rows[0], profile_shape: sh.rows[0]?.profile_shape || null });
      } catch(e) {}
    }
    vaRows.reverse(); // oldest first

    // ── Bracket/trend state from last 10 VA days ──────────────────────────
    const last10va = vaRows.slice(-10);
    const last5va  = vaRows.slice(-5);

    function overlapCount(days) {
      let count = 0;
      for (let i = 1; i < days.length; i++) {
        const prev = days[i-1], curr = days[i];
        if (!prev || !curr) continue;
        const overlapLow  = Math.max(prev.val, curr.val);
        const overlapHigh = Math.min(prev.vah, curr.vah);
        if (overlapHigh > overlapLow) count++;
      }
      return count;
    }

    function migrationDir(days) {
      if (days.length < 3) return 'OVERLAPPING';
      let up = 0, down = 0;
      for (let i = 1; i < days.length; i++) {
        if (!days[i-1] || !days[i]) continue;
        if (days[i].poc > days[i-1].poc) up++;
        else if (days[i].poc < days[i-1].poc) down++;
      }
      const total = days.length - 1;
      if (up / total >= 0.65) return 'HIGHER';
      if (down / total >= 0.65) return 'LOWER';
      return 'OVERLAPPING';
    }

    const overlaps10 = overlapCount(last10va);
    const overlaps5  = overlapCount(last5va);
    const dir10 = migrationDir(last10va);
    const dir5  = migrationDir(last5va);

    // Primary classification uses 5-day (more responsive); 10-day provides broader context
    let bracketState, bracketConfidence, bracketPlaybook, transitionalNote;
    if (overlaps5 >= 4) {
      bracketState = 'BRACKET'; bracketConfidence = 'HIGH';
      bracketPlaybook = 'RESPONSIVE — fade VAH/VAL, buy VAL sell VAH, expect mean reversion.';
      if (dir5 === 'HIGHER') transitionalNote = `Bracket tilting BULLISH — value migrating higher within the balance zone. Bias your responsive trades to the buy side. Watch for a VAH break that holds — that confirms the bracket is becoming a trend.`;
      else if (dir5 === 'LOWER') transitionalNote = `Bracket tilting BEARISH — value migrating lower within the balance zone. Bias your responsive trades to the sell side. Watch for a VAL break that holds — that confirms the bracket is becoming a downtrend.`;
      else if (dir10 !== 'OVERLAPPING' && dir10 !== dir5) {
        transitionalNote = `5-day is in balance but 10-day was ${dir10.toLowerCase()} — bracket may be forming after a prior trend. Watch for a breakout attempt.`;
      }
    } else if (overlaps5 >= 3) {
      bracketState = 'BRACKET'; bracketConfidence = 'MODERATE';
      bracketPlaybook = 'RESPONSIVE — bracket edges are key levels but breakout risk elevated. Watch for trending breakout.';
      if (dir5 === 'HIGHER') transitionalNote = `Bracket tilting BULLISH with moderate confidence — value migrating higher, overlap count low. The bracket may be breaking into an uptrend. Do not fade bullish extensions aggressively.`;
      else if (dir5 === 'LOWER') transitionalNote = `Bracket tilting BEARISH with moderate confidence — value migrating lower, overlap count low. Do not fade bearish extensions aggressively.`;
      else if (dir5 !== 'OVERLAPPING' && dir10 !== 'OVERLAPPING' && dir5 !== dir10) {
        transitionalNote = `5-day and 10-day migration disagree (5d: ${dir5}, 10d: ${dir10}) — bracket structure has low confidence. Reduce size.`;
      }
    } else if (dir5 === 'HIGHER' && dir10 === 'HIGHER') {
      bracketState = 'TRENDING_UP'; bracketConfidence = 'HIGH';
      bracketPlaybook = 'INITIATIVE — buy pullbacks to prior VAH, do not fade range extensions upward.';
    } else if (dir5 === 'LOWER' && dir10 === 'LOWER') {
      bracketState = 'TRENDING_DOWN'; bracketConfidence = 'HIGH';
      bracketPlaybook = 'INITIATIVE — sell rallies to prior VAL, do not fade range extensions downward.';
    } else if (dir5 !== dir10) {
      bracketState = 'TRANSITIONAL'; bracketConfidence = 'HIGH';
      bracketPlaybook = 'REDUCE SIZE — 5-day and 10-day structure disagree. Most dangerous condition. Favor responsive setups only.';
      transitionalNote = `5-day value moving ${dir5.toLowerCase()}, 10-day moving ${dir10.toLowerCase()}. Strategies that worked in the prior regime may stop working before the new direction confirms.`;
    } else {
      bracketState = 'BRACKET'; bracketConfidence = 'LOW';
      bracketPlaybook = 'RESPONSIVE — insufficient data for high-confidence classification.';
    }

    const valueMigration = dir5; // primary signal is now 5-day

    // ── ACD number lines ───────────────────────────────────────────────────
    const acdQ = await query(`
      SELECT trade_date::text, daily_score, a_up_fired, a_down_fired
      FROM acd_daily_log WHERE trade_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY trade_date DESC
    `);
    const acdRows = acdQ.rows;
    const nl30 = acdRows.reduce((s, r) => s + (r.daily_score || 0), 0);
    const nl10 = acdRows.slice(0, 10).reduce((s, r) => s + (r.daily_score || 0), 0);
    const nl5  = acdRows.slice(0, 5).reduce((s, r) => s + (r.daily_score || 0), 0);
    const nlPrev7 = acdRows.slice(5, 12).reduce((s, r) => s + (r.daily_score || 0), 0);
    const nlSparkline = acdRows.slice(0, 30).map(r => ({ date: r.trade_date, score: r.daily_score || 0 })).reverse();
    const loggedDays = acdRows.length;

    // Momentum: is 10-day diverging from 30-day?
    const nl30trend = nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING';
    const nl10trend = nl10 > 9 ? 'BULLISH' : nl10 < -9 ? 'BEARISH' : 'RANGING';
    const nlDiverging = (nl30trend === 'BULLISH' && nl10 < 0) || (nl30trend === 'BEARISH' && nl10 > 0);
    const nlWeakening = (nl30trend === 'BULLISH' && nl10 < nl30 * 0.3) || (nl30trend === 'BEARISH' && nl10 > nl30 * 0.3);

    // ── Volume effort vs result: last 10 days ─────────────────────────────
    const efQ = await query(`
      WITH daily AS (
        SELECT ts::date as d, MAX(high)-MIN(low) as rng, SUM(volume) as vol,
          (array_agg(close ORDER BY ts DESC))[1]-(array_agg(open ORDER BY ts ASC))[1] as chg
        FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY ts::date HAVING COUNT(*)>100 ORDER BY d DESC LIMIT 10
      ), stats AS (
        SELECT AVG(rng) as ar, AVG(vol) as av FROM (
          SELECT MAX(high)-MIN(low) as rng, SUM(volume) as vol FROM price_bars
          WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ts::date HAVING COUNT(*)>100 ORDER BY MAX(ts) DESC LIMIT 30
        ) s
      )
      SELECT d::text, ROUND((vol/NULLIF(av,0))::numeric,2) as vol_ratio,
        ROUND((rng/NULLIF(ar,0))::numeric,2) as rng_ratio, ROUND(chg::numeric,1) as chg,
        CASE WHEN vol/NULLIF(av,0)>1.5 AND rng/NULLIF(ar,0)<0.7 THEN 'ABSORPTION'
             WHEN vol/NULLIF(av,0)<0.8 AND rng/NULLIF(ar,0)>1.3 THEN 'EASE_OF_MOVEMENT'
             ELSE 'NORMAL' END as flag
      FROM daily, stats ORDER BY d ASC
    `);
    const efRows = efQ.rows;
    const absorptionCount = efRows.filter(r => r.flag === 'ABSORPTION').length;
    const lastFlag = efRows[efRows.length-1]?.flag;
    const consecutiveAbsorption = (() => {
      let count = 0;
      for (let i = efRows.length-1; i >= 0; i--) {
        if (efRows[i].flag === 'ABSORPTION') count++; else break;
      }
      return count;
    })();

    // ── Profile shapes: last 10 days ──────────────────────────────────────
    const psQ = await query(`
      SELECT trade_date::text as date, profile_shape
      FROM acd_daily_log WHERE trade_date >= CURRENT_DATE - INTERVAL '14 days'
        AND profile_shape IS NOT NULL
      ORDER BY trade_date DESC LIMIT 10
    `);
    const profileShapes = psQ.rows.reverse();
    const loggedShapes = profileShapes.length;
    const recentShapes = profileShapes.slice(-3).map(r => r.profile_shape);
    const olderShapes  = profileShapes.slice(0, -3).map(r => r.profile_shape);
    const elongatedRecent = recentShapes.filter(s => s === 'ELONGATED').length;
    const fatRecent = recentShapes.filter(s => s === 'FAT').length;
    const squatRecent = recentShapes.filter(s => s === 'SQUAT').length;
    let shapeTransition = null;
    if (olderShapes.length >= 3) {
      const wasElongated = olderShapes.filter(s => s === 'ELONGATED').length >= Math.ceil(olderShapes.length * 0.6);
      if (wasElongated && fatRecent >= 2) shapeTransition = 'ELONGATED_TO_FAT';
      if (wasElongated && squatRecent >= 1) shapeTransition = 'ELONGATED_TO_SQUAT';
      const wasFat = olderShapes.filter(s => s === 'FAT').length >= Math.ceil(olderShapes.length * 0.6);
      if (wasFat && squatRecent >= 2) shapeTransition = 'FAT_TO_SQUAT';
    }

    // ── Weekly structure ───────────────────────────────────────────────────
    const weekStart = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const wQ = await query(`
      SELECT MAX(high)::float as wh, MIN(low)::float as wl,
        (array_agg(high ORDER BY ts))[1]::float as mon_open
      FROM price_bars WHERE symbol='NQ' AND ts::date>=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    `, [weekStartStr]);
    const monIBQ = await query(`
      SELECT MAX(high)::float as h, MIN(low)::float as l
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630
    `, [weekStartStr]);
    const wRow = wQ.rows[0], monIB = monIBQ.rows[0];
    const monIBRange = monIB?.h && monIB?.l ? monIB.h - monIB.l : null;
    const weekRange = wRow?.wh && wRow?.wl ? wRow.wh - wRow.wl : null;
    let weekType = null;
    if (monIBRange && weekRange) {
      weekType = weekRange > monIBRange * 2 ? 'TREND' : weekRange > monIBRange * 1.5 ? 'NORMAL_VARIATION' : 'NORMAL';
    }

    // ── Structural summary ─────────────────────────────────────────────────
    let bull = 0, bear = 0, neutral = 0;
    if (valueMigration === 'HIGHER') bull++; else if (valueMigration === 'LOWER') bear++; else neutral++;
    if (nl30 > 9) bull++; else if (nl30 < -9) bear++; else neutral++;
    if (nl10 > 0) bull++; else if (nl10 < 0) bear++; else neutral++;
    if (bracketState === 'TRENDING_UP') bull++; else if (bracketState === 'TRENDING_DOWN') bear++; else neutral++;
    if (lastFlag === 'EASE_OF_MOVEMENT') bull++; else if (lastFlag === 'ABSORPTION') neutral++; else neutral++;
    if (weekType === 'TREND') { if (wRow?.wh > wRow?.wl) bull++; } else neutral++;

    let summaryLevel, summaryText;
    if (bull >= 4 && bear === 0) { summaryLevel = 'BULLISH'; summaryText = `Strong bullish structure — ${bull} of ${bull+bear+neutral} components aligned higher. Value migrating, ACD trending, and bracket state all support long bias. Intraday long setups have multi-timeframe structural support. Shorting against this context carries elevated risk.`; }
    else if (bear >= 4 && bull === 0) { summaryLevel = 'BEARISH'; summaryText = `Strong bearish structure — ${bear} of ${bull+bear+neutral} components aligned lower. Intraday short setups have multi-timeframe support. Buying against this context carries elevated risk.`; }
    else if (bull >= 3 && bear <= 1) { summaryLevel = 'BULLISH'; summaryText = `Bullish structural lean — ${bull} components aligned higher with ${bear} conflicting. Long setups have more structural support than shorts, but not all timeframes agree. Standard sizing.`; }
    else if (bear >= 3 && bull <= 1) { summaryLevel = 'BEARISH'; summaryText = `Bearish structural lean — ${bear} components aligned lower with ${bull} conflicting. Short setups have more structural support. Standard sizing.`; }
    else if (bracketState === 'TRANSITIONAL') { summaryLevel = 'TRANSITIONAL'; summaryText = `Transitional — 5-day and 10-day structures disagree. This is the most dangerous condition: strategies that worked in the prior trend may fail, but the new direction has not confirmed. Reduce size significantly. Favor responsive setups only.`; }
    else { summaryLevel = 'NEUTRAL'; summaryText = `Balanced structure — ${neutral} components neutral, ${bull} bullish, ${bear} bearish. Market is in balance across multiple timeframes. Neither buyers nor sellers have structural control. Reduce size and favor responsive strategies.`; }

    const result = {
      generatedAt: new Date().toISOString(),
      loggedDays,
      dataQuality: loggedDays >= 20 ? 'GOOD' : loggedDays >= 10 ? 'LIMITED' : 'INSUFFICIENT',
      summary: { level: summaryLevel, text: summaryText, bull, bear, neutral },
      valueMigration: { direction: valueMigration, days: vaRows, last10: last10va, last5: last5va, overlapCount5: overlaps5, overlapCount10: overlaps10 },
      acd: { nl30, nl10, nl5, nlPrev7, nl30trend, nl10trend, nlDiverging, nlWeakening, sparkline: nlSparkline, loggedDays },
      effortResult: { sessions: efRows, absorptionCount, consecutiveAbsorption, lastFlag },
      bracketState: { state: bracketState, confidence: bracketConfidence, playbook: bracketPlaybook, dir5, dir10, overlaps5, overlaps10, transitionalNote },
      profileShapes: { shapes: profileShapes, loggedShapes, shapeTransition, recentShapes, olderShapes },
      weeklyStructure: { weekStart: weekStartStr, weekHigh: wRow?.wh, weekLow: wRow?.wl, monIBHigh: monIB?.h, monIBLow: monIB?.l, monIBRange, weekRange, weekType },
    };

    cacheSet(`longterm-summary-${lbd}`, result, 2 * 60 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/longterm/profile-shape/:date — get shape for a date
app.get('/api/longterm/profile-shape/:date', async (req, res) => {
  try {
    const r = await query(`SELECT profile_shape FROM acd_daily_log WHERE trade_date=$1`, [req.params.date]);
    res.json({ profile_shape: r.rows[0]?.profile_shape || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/longterm/profile-shape — log just the shape for today
app.post('/api/longterm/profile-shape', async (req, res) => {
  try {
    const { date, profile_shape } = req.body;
    await query(`UPDATE acd_daily_log SET profile_shape=$1 WHERE trade_date=$2`, [profile_shape, date]);
    cacheDelete('longterm-summary');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/confluence/today — 12-condition confluence score
app.get('/api/confluence/today', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const nowET   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etMin   = nowET.getHours() * 60 + nowET.getMinutes();

    // ── Source 1: auction_reads ───────────────────────────────────────────────
    const arQ = await query(`SELECT * FROM auction_reads WHERE trade_date=$1`, [todayET]);
    const ar  = arQ.rows[0] || {};

    // ── Source 2: NL30/NL10/NL5 computed from acd_daily_log rolling sums ─────
    const nlQ = await query(`
      SELECT
        SUM(daily_score)::int as nl30,
        SUM(CASE WHEN trade_date >= ($1::text)::date - INTERVAL '10 days' THEN daily_score ELSE 0 END)::int as nl10,
        SUM(CASE WHEN trade_date >= ($1::text)::date - INTERVAL '5 days'  THEN daily_score ELSE 0 END)::int as nl5
      FROM acd_daily_log
      WHERE trade_date < ($1::text)::date AND trade_date >= ($1::text)::date - INTERVAL '30 days'
    `, [todayET]);
    const nl30 = nlQ.rows[0]?.nl30 || 0;
    const nl10 = nlQ.rows[0]?.nl10 || 0;

    // ── Source 3: value migration from prior 5 sessions via price_bars ────────
    const vaQ = await query(`
      WITH days AS (
        SELECT DISTINCT ts::date::text as d FROM price_bars WHERE symbol='NQ'
          AND ts::date < ($1::text)::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        ORDER BY d DESC LIMIT 5
      )
      SELECT d, (
        WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
          FROM price_bars WHERE symbol='NQ' AND ts::date::text=days.d
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
        poc_row AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT poc_row.px FROM poc_row LIMIT 1
      ) as poc
      FROM days ORDER BY d DESC
    `, [todayET]);
    const pocDays = vaQ.rows.map(r => parseFloat(r.poc)).filter(Boolean);
    let valueMigration = 'OVERLAPPING';
    if (pocDays.length >= 3) {
      let up = 0, down = 0;
      for (let i = 1; i < pocDays.length; i++) {
        if (pocDays[i-1] > pocDays[i]) up++;
        else if (pocDays[i-1] < pocDays[i]) down++;
      }
      if (up >= 3) valueMigration = 'HIGHER';
      else if (down >= 3) valueMigration = 'LOWER';
    }

    // ── Source 4: monthly pivot position ─────────────────────────────────────
    const monthYear = todayET.slice(0,7); // 'YYYY-MM'
    const pivotQ    = await query(`SELECT pivot_level FROM acd_monthly_pivot WHERE month_year=$1`, [monthYear]);
    const pivotLevel = pivotQ.rows[0]?.pivot_level ? parseFloat(pivotQ.rows[0].pivot_level) : null;
    const currentPriceQ = await query(`SELECT close::float as close FROM price_bars WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
    const currentPrice = currentPriceQ.rows[0]?.close || 0;
    const monthlyPivotPos = pivotLevel && currentPrice
      ? (currentPrice > pivotLevel * 1.002 ? 'ABOVE_PIVOT' : currentPrice < pivotLevel * 0.998 ? 'BELOW_PIVOT' : 'INSIDE_PIVOT')
      : null;

    // ── Source 5: A and C signals from acd_setup_events ──────────────────────
    const evQ = await query(`SELECT setup_type, fired_time FROM acd_setup_events WHERE trade_date=$1 ORDER BY fired_time ASC`, [todayET]);
    const events = evQ.rows;
    const aUpFired    = events.some(e => e.setup_type === 'A Up fired');
    const aDownFired  = events.some(e => e.setup_type === 'A Down fired');
    const cUpFired    = events.some(e => e.setup_type === 'C Up confirmed' || e.setup_type === 'C Up (no A)');
    const cDownFired  = events.some(e => e.setup_type === 'C Down confirmed' || e.setup_type === 'C Down (no A)');

    // ── Determine bias direction ──────────────────────────────────────────────
    let bias;
    if (nl30 > 9)                          bias = 'BULLISH';
    else if (nl30 < -9)                    bias = 'BEARISH';
    else if (valueMigration === 'HIGHER')  bias = 'BULLISH_LEAN';
    else if (valueMigration === 'LOWER')   bias = 'BEARISH_LEAN';
    else                                   bias = 'NEUTRAL';

    const isBull = bias === 'BULLISH' || bias === 'BULLISH_LEAN';
    const isBear = bias === 'BEARISH' || bias === 'BEARISH_LEAN';

    // ── a_signal_override — maps to quality (STRONG/WEAK/FAILED) ─────────────
    const aSignalOverride = ar.a_signal_override || null;
    const aSignalDir = aSignalOverride?.startsWith('A_UP') ? 'BULLISH'
                     : aSignalOverride?.startsWith('A_DOWN') ? 'BEARISH' : null;
    const aSignalQuality = aSignalOverride?.endsWith('_STRONG') ? 'STRONG'
                         : aSignalOverride?.endsWith('_WEAK')   ? 'WEAK'
                         : aSignalOverride?.endsWith('_FAILED') ? 'FAILED' : null;

    // Fall back to acd_setup_events for A signal direction if override not set
    const effectiveADir = aSignalDir || (aUpFired ? 'BULLISH' : aDownFired ? 'BEARISH' : null);
    // A signal failed = override says FAILED, or setup_events shows only failed attempts with no fire
    const aSignalFailed = aSignalQuality === 'FAILED' ||
      (!aUpFired && !aDownFired && events.some(e => e.setup_type?.startsWith('Failed')));

    // ── Market state from prior_day_profile ───────────────────────────────────
    const inefficientProfiles = ['TREND', 'NORMAL_VARIATION'];
    const marketState = ar.prior_day_profile
      ? (inefficientProfiles.includes(ar.prior_day_profile) ? 'INEFFICIENT' : 'EFFICIENT')
      : null;

    // ── Opening phase check ───────────────────────────────────────────────────
    const preOpen    = etMin < 9 * 60 + 30;
    const postOpen   = etMin >= 9 * 60 + 30;
    const postLocked = etMin >= 9 * 60 + 45;

    // Derive structural direction before conditions array (used in c10 note)
    const structDir = isBull ? 'BULLISH' : isBear ? 'BEARISH' : 'NEUTRAL';

    // ── Score 12 conditions ───────────────────────────────────────────────────
    const conditions = [
      {
        id: 'c1', label: 'NL30 trend confirmed',
        available: true,
        met: nl30 > 9 || nl30 < -9,
        value: `${nl30 > 0 ? '+' : ''}${nl30}`,
        reason: nl30 > 9 ? 'Confirmed uptrend (+9 threshold)' : nl30 < -9 ? 'Confirmed downtrend (-9 threshold)' : 'Ranging — no sustained OTF conviction',
      },
      {
        id: 'c2', label: 'NL10 aligned — no momentum divergence',
        available: true,
        met: (nl30 > 9 && nl10 > 0) || (nl30 < -9 && nl10 < 0) || (Math.abs(nl30) <= 9),
        value: `${nl10 > 0 ? '+' : ''}${nl10}`,
        reason: (nl30 > 9 && nl10 < 0) ? 'Divergence: NL30 bullish but NL10 negative — momentum weakening'
              : (nl30 < -9 && nl10 > 0) ? 'Divergence: NL30 bearish but NL10 positive — momentum weakening'
              : 'No divergence',
      },
      {
        id: 'c3', label: 'Open location supports bias direction',
        available: !!ar.open_vs_prior_value,
        met: (isBull && ar.open_vs_prior_value === 'ABOVE_VALUE') ||
             (isBear && ar.open_vs_prior_value === 'BELOW_VALUE') ||
             (bias === 'BULLISH_LEAN' && ar.open_vs_prior_value !== 'BELOW_VALUE') ||
             (bias === 'BEARISH_LEAN' && ar.open_vs_prior_value !== 'ABOVE_VALUE'),
        value: ar.open_vs_prior_value?.replace(/_/g, ' ') || null,
        reason: !ar.open_vs_prior_value ? 'Not yet logged' : null,
      },
      {
        id: 'c4', label: 'Overnight inventory trapped in bias direction',
        available: !!ar.overnight_inventory,
        met: (isBull && ar.overnight_inventory === 'SHORT_TRAPPED') ||
             (isBear && ar.overnight_inventory === 'LONG_TRAPPED'),
        value: ar.overnight_inventory?.replace(/_/g, ' ') || null,
        reason: ar.overnight_inventory === 'NEUTRAL' ? 'Neutral — no trapped fuel' : null,
      },
      {
        id: 'c5', label: 'Market state matches playbook',
        available: !!marketState,
        met: ((isBull || isBear) && marketState === 'INEFFICIENT') ||
             ((bias === 'BULLISH_LEAN' || bias === 'BEARISH_LEAN') && marketState === 'EFFICIENT'),
        value: marketState,
        reason: !marketState ? 'No prior day profile logged' : null,
      },
      {
        id: 'c6', label: 'Monthly pivot aligned with bias',
        available: !!monthlyPivotPos,
        met: (isBull && monthlyPivotPos === 'ABOVE_PIVOT') ||
             (isBear && monthlyPivotPos === 'BELOW_PIVOT'),
        value: monthlyPivotPos?.replace(/_/g, ' ') || null,
        reason: monthlyPivotPos === 'INSIDE_PIVOT' ? 'Inside pivot — neutral' : !monthlyPivotPos ? 'Monthly pivot not logged' : null,
      },
      {
        id: 'c7', label: 'Value migrating in bias direction (5-session)',
        available: pocDays.length >= 3,
        met: (isBull && valueMigration === 'HIGHER') || (isBear && valueMigration === 'LOWER'),
        value: valueMigration,
        reason: pocDays.length < 3 ? 'Insufficient history' : valueMigration === 'OVERLAPPING' ? 'Value overlapping — balanced' : null,
      },
      {
        id: 'c8', label: 'OR condition favorable (narrow/normal)',
        available: postOpen && !!ar.or_condition,
        met: ar.or_condition === 'NARROW' || ar.or_condition === 'NORMAL',
        value: ar.or_condition,
        reason: !postOpen ? 'Waiting for open' : !ar.or_condition ? 'Not yet logged'
              : (ar.or_condition === 'WIDE' || ar.or_condition === 'EMOTIONAL') ? 'Wide/emotional OR reduces A signal quality' : null,
      },
      {
        id: 'c9', label: 'Opening call supports directional conviction',
        available: postOpen && !!ar.opening_call_type,
        met: ar.opening_call_type === 'OPEN_DRIVE' || ar.opening_call_type === 'OPEN_TEST_DRIVE',
        value: ar.opening_call_type?.replace(/_/g, ' ') || null,
        reason: !postOpen ? 'Waiting for open' : !ar.opening_call_type ? 'Not yet logged' : null,
      },
      {
        // c10 measures whether a signal fired and sustained — direction is informational only
        // Counter-trend trades still earn this point if the signal was valid
        id: 'c10', label: 'A signal fired and sustained',
        available: postOpen,
        met: !!effectiveADir && !aSignalFailed,
        value: effectiveADir ? `A ${effectiveADir === 'BULLISH' ? 'Up' : 'Down'} fired` : null,
        reason: !postOpen ? 'Waiting for open'
              : !effectiveADir ? 'No A signal fired yet'
              : aSignalFailed ? 'A signal failed — did not sustain' : null,
        note: effectiveADir && structDir !== 'NEUTRAL' && effectiveADir !== structDir
              ? `Counter-trend vs NL30 ${structDir.toLowerCase()} — directional context, not a scoring penalty` : null,
      },
      {
        // c11 measures quality independently — assessed regardless of c10 or direction
        id: 'c11', label: 'A signal quality: strong',
        available: postOpen,
        met: aSignalQuality === 'STRONG',
        value: aSignalQuality || (effectiveADir ? 'not assessed' : null),
        reason: !postOpen ? 'Waiting for open'
              : !effectiveADir ? 'No A signal yet — set quality in Opening Read'
              : aSignalQuality === 'WEAK' ? 'Signal quality: WEAK — slow grind, overlapping bars'
              : aSignalQuality === 'FAILED' ? 'Signal quality: FAILED — trap, potential reversal'
              : !aSignalQuality ? 'Quality not yet assessed — set in Opening Read (A signal override)'
              : null,
      },
      {
        // c12: C signal in the same direction as the A signal (not structural bias)
        id: 'c12', label: 'C signal confirmed',
        available: postOpen,
        met: (effectiveADir === 'BULLISH' && cUpFired) || (effectiveADir === 'BEARISH' && cDownFired),
        value: cUpFired ? 'C Up confirmed' : cDownFired ? 'C Down confirmed' : null,
        reason: !postOpen ? 'Waiting for open'
              : !effectiveADir ? 'Waiting for A signal first'
              : 'C signal not yet fired',
      },
    ];

    // ── STRUCTURAL score: c1-c7, direction = NL30 ────────────────────────────
    const structConds     = conditions.slice(0, 7);
    const structScore     = structConds.filter(c => c.available && c.met).length;
    const structBias      = bias; // BULLISH/BEARISH/NEUTRAL/BULLISH_LEAN/BEARISH_LEAN
    // structDir already declared above conditions array

    const structLabel = structScore >= 6 ? 'STRONG' : structScore >= 4 ? 'MODERATE' : structScore >= 2 ? 'WEAK' : 'NEUTRAL';
    const structColor = structDir === 'BULLISH' ? '#22c55e' : structDir === 'BEARISH' ? '#ef4444' : '#64748b';

    // ── SESSION score: c8-c12, direction = A signal ───────────────────────────
    const sessConds   = conditions.slice(7);
    const sessScore   = sessConds.filter(c => c.available && c.met).length;
    const sessDir     = effectiveADir || null; // BULLISH/BEARISH/null
    const sessAvail   = sessConds.some(c => c.available);

    const sessLabel = !sessDir ? 'NO SIGNAL' : sessScore >= 4 ? 'HIGH CONVICTION' : sessScore >= 2 ? 'MODERATE' : 'LOW';
    const sessColor = sessDir === 'BULLISH' ? '#22c55e' : sessDir === 'BEARISH' ? '#ef4444' : '#64748b';

    // ── ALIGNMENT ─────────────────────────────────────────────────────────────
    let alignment, alignColor, alignNote;
    if (!sessDir || !structDir || structDir === 'NEUTRAL') {
      alignment  = 'NEUTRAL';
      alignColor = '#64748b';
      alignNote  = !sessDir ? 'No A signal fired yet — structural context only' : 'Neutral structural bias — no directional tailwind';
    } else if (structDir === sessDir) {
      alignment  = 'ALIGNED';
      alignColor = '#22c55e';
      alignNote  = `Both structural (${structDir}) and session (${sessDir}) point the same direction — highest quality setup condition.`;
    } else {
      alignment  = 'COUNTER_TREND';
      alignColor = '#fbbf24';
      alignNote  = `A signal (${sessDir}) is counter-trend to structural bias (${structDir}). Reduced conviction. Tighter targets. No overnight.`;
    }

    // ── COUNTER-TREND structural levels (for panel) ───────────────────────────
    let counterTrendData = null;
    if (alignment === 'COUNTER_TREND') {
      // Fetch composite 5-day POC/VAH/VAL from price_bars
      const ctVaQ = await query(`
        WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
          FROM price_bars WHERE symbol='NQ' AND ts::date >= CURRENT_DATE-5 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ROUND(low/0.25)*0.25),
        total AS (SELECT SUM(vol) as t FROM vp),
        poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT p.poc_px::float as poc,
          (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
          (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
        FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
      `);
      const ctVa = ctVaQ.rows[0] || {};

      // Prior day VAH/VAL from price_bars
      const priorVaQ = await query(`
        WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
          FROM price_bars WHERE symbol='NQ' AND ts::date=(SELECT MAX(ts::date) FROM price_bars WHERE symbol='NQ' AND ts::date<CURRENT_DATE AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16)
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
        total AS (SELECT SUM(vol) as t FROM vp),
        poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT p.poc_px::float as poc,
          (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
          (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
        FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
      `);
      const priorVa = priorVaQ.rows[0] || {};

      const currentPx = currentPrice;
      const isShort   = sessDir === 'BEARISH'; // counter-trend short in bull structure

      const allLevels = [
        ctVa.vah   && { price: Math.round(ctVa.vah),   label: '5d Composite VAH', type: 'resistance' },
        ctVa.poc   && { price: Math.round(ctVa.poc),   label: '5d Composite POC — median 37pts', type: isShort ? 'support' : 'resistance' },
        ctVa.val   && { price: Math.round(ctVa.val),   label: '5d Composite VAL', type: 'support' },
        priorVa.vah && { price: Math.round(priorVa.vah), label: isShort ? 'Prior Day VAH — median 33pts' : 'Prior Day VAH — median 33pts', type: 'resistance' },
        priorVa.poc && { price: Math.round(priorVa.poc), label: 'Prior Day POC — median 37pts', type: 'neutral' },
        priorVa.val && { price: Math.round(priorVa.val), label: 'Prior Day VAL', type: 'support' },
      ].filter(Boolean);

      // For counter-trend short: targets = supports below current price (sorted near→far)
      // Headwinds = resistance above current price (sorted near→far)
      const targets   = allLevels
        .filter(l => isShort ? l.price < currentPx : l.price > currentPx)
        .sort((a,b) => isShort ? b.price - a.price : a.price - b.price);
      const headwinds = allLevels
        .filter(l => isShort ? l.price > currentPx : l.price < currentPx)
        .sort((a,b) => isShort ? a.price - b.price : b.price - a.price);

      const nearestTarget   = targets[0] || null;
      const nearestHeadwind = headwinds[0] || null;

      const mgmtRule = isShort
        ? `Exit at first structural support (${nearestTarget?.price || 'POC'}). No overnight. Exit immediately if price reclaims OR High.`
        : `Exit at first structural resistance (${nearestTarget?.price || 'POC'}). No overnight. Exit immediately if price breaks OR Low.`;

      counterTrendData = {
        direction: sessDir,
        structuralBias: structDir,
        targets, headwinds,
        nearestTarget, nearestHeadwind,
        t1: nearestTarget?.price || null,
        mgmtRule,
        compositePOC: Math.round(ctVa.poc || 0),
        compositeVAH: Math.round(ctVa.vah || 0),
        compositeVAL: Math.round(ctVa.val || 0),
        priorVAH: Math.round(priorVa.vah || 0),
        priorVAL: Math.round(priorVa.val || 0),
      };
    }

    // ── Combined score label (for legacy display) ────────────────────────────
    const score     = structScore + sessScore;
    const trueMax   = 12 - conditions.filter(c => c.available && !c.met && (
      (c.id === 'c4' && ar.overnight_inventory === 'NEUTRAL') ||
      (c.id === 'c6' && monthlyPivotPos === 'INSIDE_PIVOT')
    )).length;
    const missing   = conditions.filter(c => c.available && !c.met).map(c => c.label);
    const neutral   = bias === 'NEUTRAL';

    let label, sublabel, color;
    if (alignment === 'COUNTER_TREND') {
      label = 'COUNTER-TREND'; sublabel = alignNote; color = '#fbbf24';
    } else if (neutral) {
      label = 'NEUTRAL BIAS'; sublabel = 'Responsive setups only'; color = '#64748b';
    } else if (score >= 10) {
      label = 'HIGH CONFLUENCE'; sublabel = 'Full process — 1 contract'; color = '#22c55e';
    } else if (score >= 7) {
      label = 'MODERATE'; sublabel = 'Day trade only — tighter targets'; color = '#fbbf24';
    } else if (score >= 4) {
      label = 'LOW'; sublabel = 'Reduce size 50% — obvious setups only'; color = '#f97316';
    } else {
      label = 'STAND ASIDE'; sublabel = 'Conflicting signals — no new entries'; color = '#ef4444';
    }

    res.json({
      // Combined
      score, maxPossible: trueMax, bias, neutral, label, sublabel, color,
      conditions, missing,
      // Structural (c1-c7)
      structural: { score: structScore, max: 7, bias: structBias, dir: structDir, label: structLabel, color: structColor, conditions: structConds },
      // Session (c8-c12)
      session: { score: sessScore, max: 5, dir: sessDir, label: sessLabel, color: sessColor, conditions: sessConds, available: sessAvail },
      // Alignment
      alignment, alignColor, alignNote,
      counterTrendData,
      // Meta
      preMarketScore: structScore,
      sessionScore: sessScore,
      calculatedAt: new Date().toISOString(),
      nl30, nl10, valueMigration,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Pattern Memory API routes ─────────────────────────────────────────────────

import { runNightlyUpdate, populateDailyLog, recalculatePatternStats } from './services/patternMemoryUpdate.js';

// POST /api/pattern/update/:tradeDate — manual trigger (test + backfill use)
app.post('/api/pattern/update/:tradeDate', async (req, res) => {
  try {
    const result = await runNightlyUpdate(req.params.tradeDate, io);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pattern/backfill — process all dates in range
app.post('/api/pattern/backfill', async (req, res) => {
  const { startDate, endDate } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });
  res.json({ ok: true, message: 'Backfill started — check server logs' });
  // Run async after response
  (async () => {
    const dates = await query(`
      SELECT DISTINCT log_date::text as d FROM trades
      WHERE log_date >= $1 AND log_date <= $2
      ORDER BY d ASC
    `, [startDate, endDate]);
    let processed = 0, skipped = 0, errors = 0;
    for (const { d } of dates.rows) {
      try {
        const r = await runNightlyUpdate(d, io);
        if (r.skipped) skipped++; else if (r.error) errors++; else processed++;
      } catch(e) { errors++; console.error(`[backfill] ${d}:`, e.message); }
    }
    console.log(`[backfill] Done: ${processed} processed, ${skipped} skipped, ${errors} errors`);
    io.emit('pattern-memory-updated', { backfill: true, processed, skipped, errors });
  })();
});

// GET /api/pattern/today-combination — matching condition_memory for today's setup
// ?days=30|60|90|0  (0 = all time; default 30)
app.get('/api/pattern/today-combination', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const days = parseInt(req.query.days ?? '30'); // 0 = all time

    // Get today's NL30 and structural context
    const nlQ = await query(`
      SELECT SUM(daily_score) FILTER (WHERE trade_date > CURRENT_DATE-30 AND trade_date <= CURRENT_DATE) as nl30
      FROM acd_daily_log WHERE daily_score IS NOT NULL`);
    const nl30 = parseInt(nlQ.rows[0]?.nl30) || 0;
    const arQ  = await query(`SELECT opening_call_type, a_signal_override FROM auction_reads WHERE trade_date=$1`, [todayET]);
    const ar   = arQ.rows[0] || {};
    const aOvr = ar.a_signal_override;
    const aQuality = aOvr?.endsWith('_STRONG') ? 'STRONG' : aOvr?.endsWith('_WEAK') ? 'WEAK' : aOvr?.endsWith('_FAILED') ? 'FAILED' : 'NO_SIGNAL';
    const openingCall = ar.opening_call_type || 'NO_SIGNAL';
    const nl30Bucket = nl30 > 15 ? 'STRONG_BULL' : nl30 > 9 ? 'BULL' : nl30 < -15 ? 'STRONG_BEAR' : nl30 < -9 ? 'BEAR' : 'RANGING';

    const lastLogQ = await query(`SELECT confluence_score_peak, confluence_score_pre, structural_state FROM daily_performance_log ORDER BY trade_date DESC LIMIT 1`);
    const lastScore = lastLogQ.rows[0]?.confluence_score_peak || lastLogQ.rows[0]?.confluence_score_pre;
    const confBucket = lastScore >= 10 ? 'HIGH' : lastScore >= 7 ? 'MODERATE' : lastScore >= 4 ? 'LOW' : 'WEAK';
    const structState = lastLogQ.rows[0]?.structural_state || 'BRACKET';
    const counterTrend = (nl30 > 9 && aQuality !== 'NO_SIGNAL' && aOvr?.startsWith('A_DOWN')) ||
                         (nl30 < -9 && aQuality !== 'NO_SIGNAL' && aOvr?.startsWith('A_UP'));

    const context = { structState, nl30Bucket, openingCall, aQuality, confBucket, counterTrend };

    // For 30-day window use condition_memory (pre-aggregated, includes trend data)
    if (days === 30) {
      const cmQ = await query(`
        SELECT *, win_rate_last30 as win_rate, avg_pnl_last30 as avg_pnl, occurrences_last30 as occurrences,
               t1_hit_rate, win_rate_trend, sufficient_data, first_seen::text, last_seen::text,
               occurrences as total_occurrences, win_rate as win_rate_alltime, avg_pnl as avg_pnl_alltime
        FROM condition_memory
        WHERE structural_state=$1 AND nl30_bucket=$2 AND opening_call=$3
          AND a_signal_quality=$4 AND confluence_bucket=$5 AND counter_trend=$6
      `, [structState, nl30Bucket, openingCall, aQuality, confBucket, counterTrend]);
      const row = cmQ.rows[0];
      if (!row) return res.json({ match: null, context, days });
      // For 30-day, sufficient_data requires at least 10 sessions in window
      const windowMatch = {
        ...row,
        occurrences: row.occurrences || 0,
        win_rate: row.win_rate,
        avg_pnl: row.avg_pnl,
        sufficient_data: (row.occurrences || 0) >= 10,
      };
      return res.json({ match: windowMatch, context, days });
    }

    // For 60d/90d/all-time: query daily_performance_log dynamically
    // Match same condition buckets used by condition_memory
    const dateFilter = days > 0 ? `AND trade_date >= CURRENT_DATE - ${days}` : '';
    const wQ = await query(`
      SELECT
        COUNT(*) as occurrences,
        AVG(CASE WHEN session_pnl > 0 THEN 1.0 ELSE 0.0 END) as win_rate,
        AVG(session_pnl) as avg_pnl,
        AVG(CASE WHEN t1_hit THEN 1.0 ELSE 0.0 END) as t1_hit_rate,
        MIN(trade_date)::text as first_seen,
        MAX(trade_date)::text as last_seen
      FROM daily_performance_log
      WHERE structural_state = $1
        AND (CASE
          WHEN nl30_at_open > 15 THEN 'STRONG_BULL'
          WHEN nl30_at_open > 9  THEN 'BULL'
          WHEN nl30_at_open < -15 THEN 'STRONG_BEAR'
          WHEN nl30_at_open < -9 THEN 'BEAR'
          ELSE 'RANGING'
        END) = $2
        AND COALESCE(opening_call, 'NO_SIGNAL') = $3
        AND COALESCE(a_signal_quality, 'NO_SIGNAL') = $4
        AND COALESCE(counter_trend, false) = $5
        ${dateFilter}
    `, [structState, nl30Bucket, openingCall, aQuality, counterTrend]);

    const w = wQ.rows[0];
    const occurrences = parseInt(w?.occurrences) || 0;
    if (occurrences === 0) return res.json({ match: null, context, days });

    // Also fetch all-time condition_memory row for trend data
    const cmQ = await query(`
      SELECT win_rate_trend, sufficient_data, first_seen::text, last_seen::text,
             occurrences as total_occurrences
      FROM condition_memory
      WHERE structural_state=$1 AND nl30_bucket=$2 AND opening_call=$3
        AND a_signal_quality=$4 AND confluence_bucket=$5 AND counter_trend=$6
    `, [structState, nl30Bucket, openingCall, aQuality, confBucket, counterTrend]);
    const cm = cmQ.rows[0] || {};

    const match = {
      occurrences,
      win_rate: w.win_rate != null ? parseFloat(w.win_rate) : null,
      avg_pnl:  w.avg_pnl  != null ? parseFloat(w.avg_pnl)  : null,
      t1_hit_rate: w.t1_hit_rate != null ? parseFloat(w.t1_hit_rate) : null,
      win_rate_trend: cm.win_rate_trend || null,
      sufficient_data: occurrences >= 10,
      first_seen: w.first_seen,
      last_seen:  w.last_seen,
      total_occurrences: cm.total_occurrences || occurrences,
    };
    res.json({ match, context, days });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pattern/stats?lookback=30
app.get('/api/pattern/stats', async (req, res) => {
  try {
    const days = parseInt(req.query.lookback) || 30;
    const r = await query(`
      SELECT * FROM pattern_stats
      WHERE lookback_days=$1 AND calculated_date=(SELECT MAX(calculated_date) FROM pattern_stats WHERE lookback_days=$1)
      ORDER BY degrading_alert DESC, structural_state
    `, [days]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pattern/daily-log?days=30
app.get('/api/pattern/daily-log', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const r = await query(`SELECT * FROM daily_performance_log WHERE trade_date >= CURRENT_DATE-$1 ORDER BY trade_date DESC`, [days]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pattern/combinations?minOccurrences=10
app.get('/api/pattern/combinations', async (req, res) => {
  try {
    const min = parseInt(req.query.minOccurrences) || 5;
    const r = await query(`SELECT * FROM condition_memory WHERE occurrences >= $1 ORDER BY avg_pnl DESC NULLS LAST`, [min]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction-read/auto — auto-detect Phase 1 + Phase 2 values from bar data
app.get('/api/auction-read/auto', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Prior day value area — CTE approach (avoids LATERAL+WITH compatibility issue)
    const priorDayQ = await query(`SELECT MAX(ts::date)::text as d FROM price_bars WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [todayET]);
    const priorDay = priorDayQ.rows[0]?.d;
    const ctx = priorDay ? await query(`
      WITH vp AS (
        SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
        FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY ROUND(low/0.25)*0.25
      ), total AS (SELECT SUM(vol) as t FROM vp),
      poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
      SELECT p.poc_px::float as poc,
        (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
        (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
      FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
    `, [priorDay]) : { rows: [] };

    const va = ctx.rows[0] || {};
    const vah = parseFloat(va.vah), val = parseFloat(va.val), poc = parseFloat(va.poc);

    // Today's OR + current price
    const todayLog = await query(`SELECT or_high, or_low FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
    const latestBar = await query(`SELECT close::float as close FROM price_bars WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
    const nqClose = latestBar.rows[0]?.close || 0;
    const orH = todayLog.rows[0]?.or_high ? parseFloat(todayLog.rows[0].or_high) : null;
    const orL = todayLog.rows[0]?.or_low  ? parseFloat(todayLog.rows[0].or_low)  : null;
    const orRange = orH && orL ? orH - orL : null;
    const orMid = orH && orL ? (orH + orL) / 2 : null;

    // 30-day average OR range
    const avgOR = await query(`
      SELECT ROUND(AVG(or_high - or_low)::numeric, 1) as avg, ROUND(STDDEV(or_high - or_low)::numeric, 1) as sd
      FROM acd_daily_log WHERE or_high IS NOT NULL AND trade_date >= CURRENT_DATE - 30
    `);
    const avgRange = parseFloat(avgOR.rows[0]?.avg) || 85;

    // Auto-detect: open vs prior value
    const refPrice = orMid || nqClose;
    let open_vs_prior_value = null;
    if (vah && val && refPrice) {
      if (refPrice > vah)      open_vs_prior_value = 'ABOVE_VALUE';
      else if (refPrice < val) open_vs_prior_value = 'BELOW_VALUE';
      else                     open_vs_prior_value = 'INSIDE_VALUE';
    }

    // Auto-detect: overnight inventory
    let overnight_inventory = null;
    if (vah && val && refPrice) {
      if (refPrice > vah)      overnight_inventory = 'SHORT_TRAPPED';   // price above — shorts from prior session trapped
      else if (refPrice < val) overnight_inventory = 'LONG_TRAPPED';    // price below — longs from prior session trapped
      else                     overnight_inventory = 'NEUTRAL';
    }

    // Auto-detect: OR condition
    let or_condition = null;
    if (orRange && avgRange) {
      const ratio = orRange / avgRange;
      if (ratio < 0.5)      or_condition = 'NARROW';
      else if (ratio < 1.5) or_condition = 'NORMAL';
      else if (ratio < 2.5) or_condition = 'WIDE';
      else                  or_condition = 'EMOTIONAL';
    }

    // Auto-detect: prior day profile from yesterday's session range vs IB range
    let prior_day_profile = null;
    const priorDate = (await query(`SELECT MAX(ts::date)::text as d FROM price_bars WHERE symbol='NQ' AND ts::date < $1`, [todayET])).rows[0]?.d;
    if (priorDate) {
      const priorIB = await query(`SELECT or_high::float as ib_high, or_low::float as ib_low FROM acd_daily_log WHERE trade_date=$1`, [priorDate]);
      const priorSess = await query(`SELECT MAX(high)::float as sh, MIN(low)::float as sl FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [priorDate]);
      const ib = priorIB.rows[0] || {};
      const sess = priorSess.rows[0] || {};
      const ibR = (ib.ib_high || 0) - (ib.ib_low || 0);
      const sessR = (sess.sh || 0) - (sess.sl || 0);
      if (ibR > 0 && sessR > 0) {
        const ext = sessR / ibR;
        const closePct = sessR > 0 ? ((sess.sc || 0) - sess.sl) / sessR : 0.5;
        prior_day_profile = ext > 2.0 ? 'TREND'
          : ext > 1.5 ? 'NORMAL_VARIATION'
          : ext > 0.9 ? 'NORMAL'
          : (sess.sh > ib.ib_high && sess.sl < ib.ib_low && (closePct > 0.75 || closePct < 0.25)) ? 'RUNNING_PROFILE_NEUTRAL'
          : (sess.sh > ib.ib_high && sess.sl < ib.ib_low) ? 'NEUTRAL'
          : 'NONTREND';
      }
    }

    // Overnight high/low (prior 4 PM to today 9:30) — needed for T1 targets
    const ovnQ = await query(`
      SELECT MAX(high)::float as ovn_high, MIN(low)::float as ovn_low
      FROM price_bars WHERE symbol='NQ'
        AND ts > (SELECT MAX(ts::date)::timestamp FROM price_bars WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16) + INTERVAL '7 hours'
        AND ts < ($1::text)::date + INTERVAL '9 hours 30 minutes'
    `, [todayET]);
    const ovnHigh = ovnQ.rows[0]?.ovn_high || null;
    const ovnLow  = ovnQ.rows[0]?.ovn_low  || null;

    // IB Low -1x Range (A-down extended target)
    const ibLow1x = orH && orL ? orL - (orH - orL) : null;
    // IB High (= OR High for A-up target)
    const ibHigh  = orH || null;

    res.json({
      open_vs_prior_value, overnight_inventory, or_condition, prior_day_profile,
      prior_day_vah: vah || null, prior_day_val: val || null, prior_day_poc: poc || null,
      avg_or_range: avgRange, today_or_range: orRange,
      ovn_high: ovnHigh, ovn_low: ovnLow,
      ib_high: ibHigh, ib_low: orL || null, ib_low_1x: ibLow1x,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction-read/correlation — serve cached correlation results
app.get('/api/auction-read/correlation', async (req, res) => {
  try {
    const r = await query(`
      SELECT bias_dir, setup_key, tested, profitable, avg_pts, max_pts,
             ROUND(hit_rate*100,1) as hit_rate_pct, prior_hit_rate,
             prior_avg_pts, changed, computed_at::text
      FROM setup_correlation_cache
      WHERE tested >= 3
      ORDER BY bias_dir, hit_rate DESC, avg_pts DESC
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction-read/correlation/compute — run full correlation analysis
app.post('/api/auction-read/correlation/compute', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Correlation computation started' });
    const TOUCH=8, BARS=30, MIN=15;
    const hist = await query(`SELECT date::text, bias_dir, pts_vs_open FROM auction_history WHERE bias_dir IS NOT NULL ORDER BY date`);
    const acc = {};

    for (const row of hist.rows) {
      const { date, bias_dir } = row;
      const bars = (await query(`
        SELECT ts, high::float h, low::float l, close::float c,
          SUM(close::float*volume::bigint) OVER (ORDER BY ts)/NULLIF(SUM(volume::bigint) OVER (ORDER BY ts),0) vw
        FROM price_bars WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960 ORDER BY ts`, [date])).rows;
      if (bars.length < 50) continue;

      const pdR = await query(`SELECT MAX(ts::date::text) p FROM price_bars WHERE symbol='NQ' AND ts::date<$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [date]);
      const priorDate = pdR.rows[0]?.p;
      if (!priorDate) continue;

      const pd = (await query(`SELECT MAX(high)::float h, MIN(low)::float l FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [priorDate])).rows[0];
      const va = (await query(`WITH vp AS (SELECT ROUND(low/0.25)*0.25 px, SUM(volume) vol FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25), t AS (SELECT SUM(vol) t FROM vp), pr AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1) SELECT p2.px::float poc, (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p2.px) x WHERE cv<=(SELECT t*0.35 FROM t))::float vah, (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p2.px) x WHERE cv<=(SELECT t*0.35 FROM t))::float val FROM vp, pr p2 GROUP BY p2.px LIMIT 1`, [priorDate])).rows[0];
      const acd = (await query(`SELECT or_high::float oh, or_low::float ol FROM acd_daily_log WHERE trade_date=$1`, [date])).rows[0];

      const levels = [
        {k:'IBH',p:acd?.oh,t:'resistance'},{k:'IBL',p:acd?.ol,t:'support'},
        {k:'PD VAH',p:va?.vah,t:'resistance'},{k:'PD VAL',p:va?.val,t:'support'},
        {k:'PD High',p:pd?.h,t:'resistance'},{k:'PD Low',p:pd?.l,t:'support'},
      ].filter(l=>l.p);

      const bkey = bias_dir || 'NEUTRAL';
      if (!acc[bkey]) acc[bkey] = {};

      for (const lv of levels) {
        const p = parseFloat(lv.p);
        for (let i=10; i<bars.length-BARS; i++) {
          const b=bars[i];
          const hit=lv.t==='resistance'?b.h>=p-TOUCH&&b.h<=p+TOUCH:b.l<=p+TOUCH&&b.l>=p-TOUCH;
          if (!hit) continue;
          const fut=bars.slice(i+1,i+BARS+1);
          const mv=lv.t==='resistance'?p-Math.min(...fut.map(x=>x.l)):Math.max(...fut.map(x=>x.h))-p;
          if (!acc[bkey][lv.k]) acc[bkey][lv.k]={tested:0,profitable:0,pts:[]};
          acc[bkey][lv.k].tested++;
          if (mv>=MIN){acc[bkey][lv.k].profitable++;acc[bkey][lv.k].pts.push(Math.round(mv));}
          break;
        }
      }
      // VWAP
      for (let i=10; i<bars.length-BARS; i++) {
        const prev=bars[i-1],cur=bars[i];
        if (!prev?.vw||!cur?.vw) continue;
        const up=prev.c<prev.vw&&cur.c>cur.vw,dn=prev.c>prev.vw&&cur.c<cur.vw;
        if (!up&&!dn) continue;
        const fut=bars.slice(i+1,i+BARS+1);
        const mv=up?Math.max(...fut.map(x=>x.h))-cur.c:cur.c-Math.min(...fut.map(x=>x.l));
        const k=up?'VWAP Reclaim':'VWAP Break';
        if (!acc[bkey][k]) acc[bkey][k]={tested:0,profitable:0,pts:[]};
        acc[bkey][k].tested++;
        if (mv>=MIN){acc[bkey][k].profitable++;acc[bkey][k].pts.push(Math.round(mv));}
        break;
      }
    }

    // Save to DB with change detection
    for (const [bias, setups] of Object.entries(acc)) {
      for (const [key, v] of Object.entries(setups)) {
        if (v.tested < 3) continue;
        const hitRate = v.profitable / v.tested;
        const avgPts = v.pts.length ? Math.round(v.pts.reduce((s,x)=>s+x,0)/v.pts.length) : 0;
        const maxPts = v.pts.length ? Math.max(...v.pts) : 0;
        const existing = await query(`SELECT hit_rate, avg_pts FROM setup_correlation_cache WHERE bias_dir=$1 AND setup_key=$2`, [bias, key]);
        const prior = existing.rows[0];
        const changed = prior ? (Math.abs(hitRate - parseFloat(prior.hit_rate)) > 0.05 || Math.abs(avgPts - prior.avg_pts) > 10) : false;
        await query(`
          INSERT INTO setup_correlation_cache (bias_dir, setup_key, tested, profitable, avg_pts, max_pts, hit_rate, prior_hit_rate, prior_avg_pts, changed, computed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
          ON CONFLICT (bias_dir, setup_key) DO UPDATE SET
            tested=$3, profitable=$4, avg_pts=$5, max_pts=$6, hit_rate=$7,
            prior_hit_rate=COALESCE($8, setup_correlation_cache.hit_rate),
            prior_avg_pts=COALESCE($9, setup_correlation_cache.avg_pts),
            changed=$10, computed_at=NOW()
        `, [bias, key, v.tested, v.profitable, avgPts, maxPts, hitRate,
            prior ? parseFloat(prior.hit_rate) : null,
            prior ? prior.avg_pts : null, changed]);
      }
    }
    console.log('📊 Setup correlation computed and cached');
  } catch(e) { console.error('Correlation compute error:', e.message); }
});

// POST /api/auction-read/history/refresh — force recompute all history
app.post('/api/auction-read/history/refresh', async (req, res) => {
  try {
    await query('DELETE FROM auction_history');
    cacheSet('auction-history-30', null, 1);
    cacheSet('auction-history-60', null, 1);
    cacheSet('auction-history-90', null, 1);
    res.json({ ok: true, message: 'History cleared — will recompute on next load' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction-read/history — serve from DB when available, compute missing days
app.get('/api/auction-read/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const cacheKey = `auction-history-${days}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Check what's already in the DB
    const stored = await query(`
      SELECT *, date::text as date_str FROM auction_history
      WHERE date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      ORDER BY date DESC
    `, [days * 2]);

    // Serve from DB only when we have enough days AND the most recent record is current
    const mostRecentStored = stored.rows[0]?.date_str;
    const latestBarDate = (await query(`SELECT MAX(ts::date)::text as d FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`)).rows[0]?.d;
    const dbIsCurrent = mostRecentStored && latestBarDate && mostRecentStored >= latestBarDate;

    if (stored.rows.length >= days - 5 && dbIsCurrent) {
      const result = stored.rows.map(r => ({
        date: r.date_str, priorDay: r.prior_day, priorProfile: r.prior_profile,
        nlTrend: r.nl_trend, nl30: r.nl30, inv: r.inv, valPos: r.val_pos,
        orCond: r.or_cond, biasDir: r.bias_dir, conflict: r.conflict,
        outcome: r.outcome, actualDir: r.actual_dir, acdScore: r.acd_score,
        ptsVsOpen: r.pts_vs_open, orHigh: r.or_high, orLow: r.or_low,
        aUpLevel: r.a_up_level, aDownLevel: r.a_down_level,
        aUpFired: r.a_up_fired, aDownFired: r.a_down_fired,
        priorVAH: r.prior_vah, priorVAL: r.prior_val, priorPOC: r.prior_poc,
        sessionHigh: r.session_high, sessionLow: r.session_low,
        sessionClose: r.session_close, sessionOpen: r.session_open,
        pivotBias: r.pivot_bias, bars: r.bars || [],
      }));
      cacheSet(cacheKey, result, 4 * 60 * 60 * 1000);
      return res.json(result);
    }
    // DB is stale — fall through to recompute missing days

    // Need to compute — send partial from DB while computing
    const storedDates = new Set(stored.rows.map(r => r.date_str));

    // Trading days with bar data
    // Look back 2x calendar days to ensure we capture enough trading days
    const calendarLookback = days * 2;
    const tradingDays = await query(`
      SELECT DISTINCT ts::date::text as d
      FROM price_bars WHERE symbol='NQ'
        AND ts::date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
        AND ts::date < CURRENT_DATE
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 10
      ORDER BY d DESC LIMIT $2
    `, [calendarLookback, days + 2]);

    const dayList = tradingDays.rows.map(r => r.d).reverse();
    const avgOrRow = await query(`SELECT ROUND(AVG(or_high-or_low)::numeric,1) as avg FROM acd_daily_log WHERE or_high IS NOT NULL AND trade_date >= CURRENT_DATE-35`);
    const avgOR = parseFloat(avgOrRow.rows[0]?.avg) || 85;
    const pivotRow = await query(`SELECT pivot_level FROM acd_monthly_pivot ORDER BY created_at DESC LIMIT 1`);
    const pivotLevel = pivotRow.rows[0] ? parseFloat(pivotRow.rows[0].pivot_level) : null;

    const results = [];

    for (let i = 1; i < dayList.length; i++) {
      const today = dayList[i];
      const priorDay = dayList[i - 1];

      // Prior day bars + IB
      const pb = await query(`
        SELECT MAX(high)::float as sh, MIN(low)::float as sl,
          (array_agg(close ORDER BY ts DESC))[1]::float as sc,
          MAX(high) FILTER (WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630)::float as ib_high,
          MIN(low)  FILTER (WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630)::float as ib_low
        FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [priorDay]);
      const p = pb.rows[0];
      if (!p?.sh) continue;

      // Prior day VA
      const vaR = await query(`
        WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
        total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT p2.px::float as poc,
          (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
          (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
        FROM vp, poc_row p2 GROUP BY p2.px LIMIT 1
      `, [priorDay]);
      const va = vaR.rows[0];
      if (!va) continue;

      // Today's ACD + NL
      const acdR = await query(`SELECT or_high::float, or_low::float, daily_score, a_up_fired, a_down_fired, a_up_level::float, a_down_level::float FROM acd_daily_log WHERE trade_date=$1`, [today]);
      const acd = acdR.rows[0];
      if (!acd?.or_high) continue;
      const orMid = (acd.or_high + acd.or_low) / 2;
      const orRange = acd.or_high - acd.or_low;

      const nlR = await query(`SELECT COALESCE(SUM(daily_score),0) as nl30 FROM (SELECT daily_score FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 30) s`, [today]);
      const nl30 = parseInt(nlR.rows[0]?.nl30) || 0;
      const nlTrend = nl30 > 9 ? 'TRENDING_UP' : nl30 < -9 ? 'TRENDING_DOWN' : 'RANGING';

      // Today's session
      const sessR = await query(`
        SELECT MAX(high)::float as sh, MIN(low)::float as sl,
          (array_agg(close ORDER BY ts DESC))[1]::float as sc,
          (array_agg(open ORDER BY ts ASC))[1]::float as so
        FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [today]);
      const sess = sessR.rows[0];

      // Hourly bars for mini chart
      const barsR = await query(`
        SELECT to_char(date_trunc('hour',ts),'HH24:MI') as t,
          (array_agg(open ORDER BY ts))[1]::float as o,
          MAX(high)::float as h, MIN(low)::float as l,
          (array_agg(close ORDER BY ts DESC))[1]::float as c
        FROM price_bars WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY date_trunc('hour',ts) ORDER BY 1
      `, [today]);

      // Classify prior day profile
      const ibRange = (p.ib_high||0) - (p.ib_low||0);
      const sessRange = p.sh - p.sl;
      const ext = ibRange > 0 ? sessRange / ibRange : 0;
      const closePct = sessRange > 0 ? (p.sc - p.sl) / sessRange : 0.5;
      const priorProfile = ext > 2.0 ? 'TREND'
        : ext > 1.5 ? 'NORMAL_VARIATION'
        : ext > 0.9 ? 'NORMAL'
        : (p.sh > (p.ib_high||0) && p.sl < (p.ib_low||0) && (closePct > 0.75 || closePct < 0.25)) ? 'RUNNING_PROFILE_NEUTRAL'
        : (p.sh > (p.ib_high||0) && p.sl < (p.ib_low||0)) ? 'NEUTRAL'
        : 'NONTREND';

      // Bias signals
      const inv = orMid > va.vah ? 'SHORT_TRAPPED' : orMid < va.val ? 'LONG_TRAPPED' : 'NEUTRAL';
      const valPos = orMid > va.vah ? 'ABOVE_VALUE' : orMid < va.val ? 'BELOW_VALUE' : 'INSIDE_VALUE';
      const orCond = orRange/avgOR < 0.5 ? 'NARROW' : orRange/avgOR < 1.5 ? 'NORMAL' : orRange/avgOR < 2.5 ? 'WIDE' : 'EMOTIONAL';

      const structureLong  = (inv==='SHORT_TRAPPED'&&valPos!=='BELOW_VALUE')||(inv==='NEUTRAL'&&valPos==='ABOVE_VALUE');
      const structureShort = (inv==='LONG_TRAPPED'&&valPos!=='ABOVE_VALUE')||(inv==='NEUTRAL'&&valPos==='BELOW_VALUE');
      const nlDir = nlTrend==='TRENDING_UP'?'up':nlTrend==='TRENDING_DOWN'?'down':'ranging';
      const conflict = (structureLong&&nlDir==='down')||(structureShort&&nlDir==='up');
      const biasDir = structureLong?'LONG':structureShort?'SHORT':'NEUTRAL';

      // Actual direction
      const ptsVsOpen = sess?.sc && sess?.so ? sess.sc - sess.so : null;
      // Use close-vs-open as primary truth (what price actually did), ACD score as tiebreaker
      const actualDir = ptsVsOpen > 15 ? 'BULLISH' : ptsVsOpen < -15 ? 'BEARISH'
        : acd.daily_score > 0 ? 'BULLISH' : acd.daily_score < 0 ? 'BEARISH'
        : ptsVsOpen > 0 ? 'BULLISH' : ptsVsOpen < 0 ? 'BEARISH' : 'NEUTRAL';
      const outcome = biasDir==='LONG'&&actualDir==='BULLISH'?'CORRECT'
        :biasDir==='SHORT'&&actualDir==='BEARISH'?'CORRECT'
        :biasDir==='LONG'&&actualDir==='BEARISH'?'WRONG'
        :biasDir==='SHORT'&&actualDir==='BULLISH'?'WRONG'
        :'NEUTRAL';

      results.push({
        date: today, priorDay,
        priorProfile, nlTrend, nl30,
        inv, valPos, orCond, biasDir, conflict, outcome,
        actualDir, acdScore: acd.daily_score,
        ptsVsOpen: ptsVsOpen ? Math.round(ptsVsOpen) : null,
        orHigh: acd.or_high, orLow: acd.or_low,
        aUpLevel: acd.a_up_level, aDownLevel: acd.a_down_level,
        aUpFired: acd.a_up_fired, aDownFired: acd.a_down_fired,
        priorVAH: va.vah, priorVAL: va.val, priorPOC: va.poc,
        sessionHigh: sess?.sh, sessionLow: sess?.sl, sessionClose: sess?.sc, sessionOpen: sess?.so,
        pivotBias: pivotLevel ? (sess?.so > pivotLevel ? 'ABOVE' : 'BELOW') : null,
        bars: barsR.rows,
      });
    }

    results.reverse();

    // Save new results to DB for persistence
    for (const r of results) {
      if (storedDates.has(r.date)) continue; // skip already stored
      try {
        await query(`
          INSERT INTO auction_history (date, prior_day, prior_profile, nl_trend, nl30, inv, val_pos, or_cond, bias_dir, conflict, outcome, actual_dir, acd_score, pts_vs_open, or_high, or_low, a_up_level, a_down_level, a_up_fired, a_down_fired, prior_vah, prior_val, prior_poc, session_high, session_low, session_close, session_open, pivot_bias, bars)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
          ON CONFLICT (date) DO NOTHING
        `, [r.date, r.priorDay, r.priorProfile, r.nlTrend, r.nl30, r.inv, r.valPos, r.orCond, r.biasDir, r.conflict, r.outcome, r.actualDir, r.acdScore, r.ptsVsOpen, r.orHigh, r.orLow, r.aUpLevel, r.aDownLevel, r.aUpFired, r.aDownFired, r.priorVAH, r.priorVAL, r.priorPOC, r.sessionHigh, r.sessionLow, r.sessionClose, r.sessionOpen, r.pivotBias, JSON.stringify(r.bars)]);
      } catch(e) { /* skip individual save errors */ }
    }

    cacheSet(cacheKey, results, 4 * 60 * 60 * 1000);
    res.json(results);
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/auction-read/today', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const r = await query('SELECT *, trade_date::text FROM auction_reads WHERE trade_date=$1', [todayET]);
    res.json(r.rows[0] || { trade_date: todayET });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auction-read/today', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const { overnight_inventory, open_vs_prior_value, prior_day_profile, or_condition, opening_call_type, a_signal_override, p3_value_migrating, p3_vwap_holding, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing } = req.body;
    const r = await query(`
      INSERT INTO auction_reads (trade_date, overnight_inventory, open_vs_prior_value, prior_day_profile, or_condition, opening_call_type, a_signal_override, p3_value_migrating, p3_vwap_holding, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (trade_date) DO UPDATE SET
        overnight_inventory=COALESCE($2,auction_reads.overnight_inventory),
        open_vs_prior_value=COALESCE($3,auction_reads.open_vs_prior_value),
        prior_day_profile=COALESCE($4,auction_reads.prior_day_profile),
        or_condition=COALESCE($5,auction_reads.or_condition),
        opening_call_type=COALESCE($6,auction_reads.opening_call_type),
        a_signal_override=COALESCE($7,auction_reads.a_signal_override),
        p3_value_migrating=COALESCE($8,auction_reads.p3_value_migrating),
        p3_vwap_holding=COALESCE($9,auction_reads.p3_vwap_holding),
        p3_delta_confirming=COALESCE($10,auction_reads.p3_delta_confirming),
        p3_auction_accepted=COALESCE($11,auction_reads.p3_auction_accepted),
        p3_rotations_increasing=COALESCE($12,auction_reads.p3_rotations_increasing),
        updated_at=NOW(),
        p1_updated_at=CASE WHEN ($2 IS NOT NULL AND $2 IS DISTINCT FROM auction_reads.overnight_inventory) OR ($3 IS NOT NULL AND $3 IS DISTINCT FROM auction_reads.open_vs_prior_value) OR ($4 IS NOT NULL AND $4 IS DISTINCT FROM auction_reads.prior_day_profile) THEN NOW() ELSE auction_reads.p1_updated_at END,
        p2_updated_at=CASE WHEN ($5 IS NOT NULL AND $5 IS DISTINCT FROM auction_reads.or_condition) OR ($6 IS NOT NULL AND $6 IS DISTINCT FROM auction_reads.opening_call_type) OR ($7 IS NOT NULL AND $7 IS DISTINCT FROM auction_reads.a_signal_override) THEN NOW() ELSE auction_reads.p2_updated_at END,
        p3_updated_at=CASE WHEN ($8 IS NOT NULL AND $8 IS DISTINCT FROM auction_reads.p3_value_migrating) OR ($9 IS NOT NULL AND $9 IS DISTINCT FROM auction_reads.p3_vwap_holding) OR ($10 IS NOT NULL AND $10 IS DISTINCT FROM auction_reads.p3_delta_confirming) OR ($11 IS NOT NULL AND $11 IS DISTINCT FROM auction_reads.p3_auction_accepted) OR ($12 IS NOT NULL AND $12 IS DISTINCT FROM auction_reads.p3_rotations_increasing) THEN NOW() ELSE auction_reads.p3_updated_at END,
        ts_overnight_inventory=CASE WHEN $2 IS NOT NULL AND $2 IS DISTINCT FROM auction_reads.overnight_inventory THEN NOW() ELSE auction_reads.ts_overnight_inventory END,
        ts_open_vs_prior_value=CASE WHEN $3 IS NOT NULL AND $3 IS DISTINCT FROM auction_reads.open_vs_prior_value THEN NOW() ELSE auction_reads.ts_open_vs_prior_value END,
        ts_prior_day_profile=CASE WHEN $4 IS NOT NULL AND $4 IS DISTINCT FROM auction_reads.prior_day_profile THEN NOW() ELSE auction_reads.ts_prior_day_profile END,
        ts_or_condition=CASE WHEN $5 IS NOT NULL AND $5 IS DISTINCT FROM auction_reads.or_condition THEN NOW() ELSE auction_reads.ts_or_condition END,
        ts_opening_call_type=CASE WHEN $6 IS NOT NULL AND $6 IS DISTINCT FROM auction_reads.opening_call_type THEN NOW() ELSE auction_reads.ts_opening_call_type END,
        ts_a_signal_override=CASE WHEN $7 IS NOT NULL AND $7 IS DISTINCT FROM auction_reads.a_signal_override THEN NOW() ELSE auction_reads.ts_a_signal_override END,
        ts_p3_value_migrating=CASE WHEN $8 IS NOT NULL AND $8 IS DISTINCT FROM auction_reads.p3_value_migrating THEN NOW() ELSE auction_reads.ts_p3_value_migrating END,
        ts_p3_vwap_holding=CASE WHEN $9 IS NOT NULL AND $9 IS DISTINCT FROM auction_reads.p3_vwap_holding THEN NOW() ELSE auction_reads.ts_p3_vwap_holding END,
        ts_p3_delta_confirming=CASE WHEN $10 IS NOT NULL AND $10 IS DISTINCT FROM auction_reads.p3_delta_confirming THEN NOW() ELSE auction_reads.ts_p3_delta_confirming END,
        ts_p3_auction_accepted=CASE WHEN $11 IS NOT NULL AND $11 IS DISTINCT FROM auction_reads.p3_auction_accepted THEN NOW() ELSE auction_reads.ts_p3_auction_accepted END,
        ts_p3_rotations_increasing=CASE WHEN $12 IS NOT NULL AND $12 IS DISTINCT FROM auction_reads.p3_rotations_increasing THEN NOW() ELSE auction_reads.ts_p3_rotations_increasing END
      RETURNING *, trade_date::text
    `, [todayET, overnight_inventory, open_vs_prior_value, prior_day_profile, or_condition, opening_call_type, a_signal_override, p3_value_migrating, p3_vwap_holding, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== WYCKOFF & STEIDLMAYER ROUTES ====================

// ── Wyckoff levels ────────────────────────────────────────────────────────────
app.get('/api/wyckoff/levels', async (req, res) => {
  try {
    const r = await query(`SELECT id, level_date::text, price_level, level_type, origin_description, status, spring_occurred, spring_date::text, spring_volume_type, upthrust_occurred, upthrust_date::text, notes, created_at FROM wyckoff_levels WHERE status='ACTIVE' ORDER BY wyckoff_levels.level_date DESC, price_level DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction-read/eod — end-of-day debrief for a given date
// GET /api/auction-read/midday — 1:45 PM mid-session snapshot
app.get('/api/auction-read/midday', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const nowET   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etMin   = nowET.getHours() * 60 + nowET.getMinutes();

    // ACD levels
    const acd = await query(`SELECT or_high::float, or_low::float, a_up_level::float, a_down_level::float, a_up_fired, a_down_fired FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
    const acdRow = acd.rows[0];
    if (!acdRow) return res.json({ available: false, reason: 'No ACD data for today' });

    // Session bars up to now (or up to 13:45 if called later)
    const cutoffMin = Math.min(etMin, 13 * 60 + 45);
    const bars = await query(`
      SELECT high::float, low::float, close::float, open::float, volume::bigint,
             EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as bm,
             to_char(ts,'HH24:MI') as t
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND $2
      ORDER BY ts
    `, [todayET, cutoffMin]);
    if (!bars.rows.length) return res.json({ available: false, reason: 'No bar data yet' });

    const b = bars.rows;
    const sessOpen  = b[0].open;
    const sessClose = b[b.length-1].close; // price at cutoff
    const sessHigh  = Math.max(...b.map(r => r.high));
    const sessLow   = Math.min(...b.map(r => r.low));
    const ptsVsOpen = Math.round((sessClose - sessOpen) * 100) / 100;
    const dir = ptsVsOpen > 10 ? 'BULLISH' : ptsVsOpen < -10 ? 'BEARISH' : 'NEUTRAL';

    // Avg range
    const avgQ = await query(`SELECT AVG(daily_range)::float as avg FROM (SELECT MAX(high)-MIN(low) as daily_range FROM price_bars WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= ($1::text)::date - INTERVAL '30 days' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ts::date) s`, [todayET]);
    const avgRange = avgQ.rows[0]?.avg || 150;
    const sessRange = sessHigh - sessLow;
    const rangeVsAvg = sessRange / avgRange;

    // VWAP
    const totalVol = b.reduce((s, r) => s + (Number(r.volume)||1), 0);
    const vwap = Math.round(b.reduce((s, r) => s + r.close * (Number(r.volume)||1), 0) / totalVol);

    // Morning read
    const ar = await query(`SELECT overnight_inventory, open_vs_prior_value, prior_day_profile, p3_value_migrating, p3_vwap_holding, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing FROM auction_reads WHERE trade_date=$1`, [todayET]);
    const read = ar.rows[0] || {};
    const inv = read.overnight_inventory, val = read.open_vs_prior_value;
    const strLong  = (inv==='SHORT_TRAPPED'&&val!=='BELOW_VALUE')||(inv==='NEUTRAL'&&val==='ABOVE_VALUE');
    const strShort = (inv==='LONG_TRAPPED'&&val!=='ABOVE_VALUE')||(inv==='NEUTRAL'&&val==='BELOW_VALUE');
    // Pre-market structural bias (from overnight inventory + open vs prior value — set before 9:30)
    const preMktBias = strLong ? 'LONG' : strShort ? 'SHORT' : 'NEUTRAL';
    // Session signal (A signal fired during the session — overrides structural read for direction)
    const sessionSignal = acdRow.a_up_fired ? 'LONG' : acdRow.a_down_fired ? 'SHORT' : null;
    // Effective bias: A signal takes priority when it fires; otherwise use pre-market read
    const mornBias = sessionSignal || preMktBias;
    const biasPlaying  = (mornBias==='LONG'&&dir==='BULLISH') || (mornBias==='SHORT'&&dir==='BEARISH');
    const biasReversed = (mornBias==='LONG'&&dir==='BEARISH') || (mornBias==='SHORT'&&dir==='BULLISH');

    // G-Line and PW levels
    const gQ = await query(`SELECT (array_agg(open ORDER BY ts))[1]::float as g FROM price_bars WHERE symbol='NQ' AND ts::date>=date_trunc('week',($1::text)::date) AND ts::date<=($1::text)::date AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 570 AND EXTRACT(hour FROM ts) < 16`, [todayET]);
    const gLine = gQ.rows[0]?.g;
    const pwQ = await query(`SELECT MAX(high)::float as pwh, MIN(low)::float as pwl FROM price_bars WHERE symbol='NQ' AND ts::date>=date_trunc('week',($1::text)::date)-INTERVAL '7 days' AND ts::date<date_trunc('week',($1::text)::date) AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [todayET]);
    const pwHigh = pwQ.rows[0]?.pwh, pwLow = pwQ.rows[0]?.pwl;

    // P3 score — compute from bar data (same as live endpoint) so it's never 0 due to DB nulls
    const orH2 = acdRow.or_high, orL2 = acdRow.or_low;
    const tvol = b.reduce((s,r)=>s+(Number(r.volume)||1),0);
    const vwapFull = b.reduce((s,r)=>s+r.close*(Number(r.volume)||1),0)/tvol;
    const split2 = Math.max(1, b.length - 20);
    const earlyV = b.slice(0,split2).reduce((s,r)=>s+(Number(r.volume)||1),0);
    const earlyVwap2 = b.slice(0,split2).reduce((s,r)=>s+r.close*(Number(r.volume)||1),0)/earlyV;
    const biasForP3 = mornBias;
    const p3_vwap_holding2 = biasForP3==='LONG' ? sessClose>vwapFull : biasForP3==='SHORT' ? sessClose<vwapFull : false;
    const p3_value_migrating2 = biasForP3==='LONG' ? vwapFull>earlyVwap2 : biasForP3==='SHORT' ? vwapFull<earlyVwap2 : false;
    const last10b = b.slice(-10);
    const avgCP = last10b.reduce((s,r)=>{const rng=r.high-r.low; return s+(rng>0?(r.close-r.low)/rng:0.5);},0)/last10b.length;
    const p3_delta_confirming2 = biasForP3==='LONG' ? avgCP>0.55 : biasForP3==='SHORT' ? avgCP<0.45 : false;
    const last20b = b.slice(-20);
    const acceptCt = last20b.filter(r=>biasForP3==='LONG'?r.close>orH2:biasForP3==='SHORT'?r.close<orL2:false).length;
    const p3_auction_accepted2 = last20b.length>0 && acceptCt/last20b.length>=0.4;
    const last16b = b.slice(-16);
    let p3_rotations_increasing2 = false;
    if (last16b.length>=8){const h=Math.floor(last16b.length/2); const r1=Math.max(...last16b.slice(0,h).map(r=>r.high))-Math.min(...last16b.slice(0,h).map(r=>r.low)); const r2=Math.max(...last16b.slice(h).map(r=>r.high))-Math.min(...last16b.slice(h).map(r=>r.low)); p3_rotations_increasing2=r2>r1*1.15;}
    // Prefer manually saved values from DB if set, fall back to computed
    const p3_vm = read.p3_value_migrating ?? p3_value_migrating2;
    const p3_vh = read.p3_vwap_holding ?? p3_vwap_holding2;
    const p3_dc = read.p3_delta_confirming ?? p3_delta_confirming2;
    const p3_aa = read.p3_auction_accepted ?? p3_auction_accepted2;
    const p3_ri = read.p3_rotations_increasing ?? p3_rotations_increasing2;
    const p3Score = [p3_vm, p3_vh, p3_dc, p3_aa, p3_ri].filter(Boolean).length;
    const p3Source = read.p3_updated_at ? 'manual' : 'auto-computed';

    // Afternoon context: what's the session shaping up to be?
    const morningBars  = b.filter(r => r.bm < 12*60);
    const afternoonBars = b.filter(r => r.bm >= 12*60);
    const morningRange = morningBars.length ? Math.max(...morningBars.map(r=>r.high)) - Math.min(...morningBars.map(r=>r.low)) : 0;
    const pmOpen = afternoonBars.length ? afternoonBars[0].open : sessClose;
    const pmClose = afternoonBars.length ? afternoonBars[afternoonBars.length-1].close : sessClose;

    // Day type developing
    let dayTypeDeveloping;
    if (rangeVsAvg > 1.5 && Math.abs(ptsVsOpen) > avgRange * 0.4) {
      dayTypeDeveloping = 'TREND DAY developing — one-sided move, high range vs avg. Go with direction, do not fade.';
    } else if (rangeVsAvg < 0.6) {
      dayTypeDeveloping = 'BALANCE DAY developing — narrow range vs avg. Responsive strategy, fade extremes. Low follow-through on breakouts.';
    } else if (morningRange > avgRange * 0.8 && afternoonBars.length > 5 && Math.abs(pmClose - pmOpen) < morningRange * 0.3) {
      dayTypeDeveloping = 'NORMAL day — large morning range, afternoon consolidating. Value has been established. Watch for late directional break or rotation back to morning POC.';
    } else {
      dayTypeDeveloping = 'NORMAL VARIATION developing — meaningful range, some directional follow-through. Standard intraday playbook.';
    }

    // What to watch into close
    const watches = [];
    if (gLine) {
      const aboveGLine = sessClose > gLine;
      if (aboveGLine) watches.push(`G-Line (${Math.round(gLine)}) is support — holding above keeps week positive. Watch for a test and hold or break into close.`);
      else watches.push(`G-Line (${Math.round(gLine)}) is resistance — below keeps week negative. Reclaim above = bullish close; failure = continued weekly weakness.`);
    }
    if (acdRow.a_up_fired) watches.push(`A Up confirmed — OR High (${Math.round(acdRow.or_high)}) is now support. Hold above into close = strong continuation signal.`);
    else if (acdRow.a_down_fired) watches.push(`A Down confirmed — OR Low (${Math.round(acdRow.or_low)}) is now resistance. Hold below into close = strong continuation signal.`);
    else watches.push(`No A signal fired — this is a no-signal day. Watch for late-session initiative or range expansion after 2 PM. Without an A signal the close vs OR mid (${Math.round((acdRow.or_high+acdRow.or_low)/2)}) determines the day's bias.`);
    if (p3Score <= 1 && mornBias !== 'NEUTRAL') watches.push(`P3 score ${p3Score}/5 (${p3Source}) — in-session monitor says the ${mornBias} bias is not being confirmed structurally. Caution on afternoon ${mornBias} positions.`);
    else if (p3Score >= 4 && mornBias !== 'NEUTRAL') watches.push(`P3 score ${p3Score}/5 (${p3Source}) — strong structural confirmation of ${mornBias} bias. Structure supports holding ${mornBias} positions into the close.`);
    if (biasReversed) watches.push(`Morning bias (${mornBias}) is NOT playing out — price has moved ${Math.abs(ptsVsOpen).toFixed(0)}pts against it. This is not a reason to reverse — it is a reason to stand aside until a new structural read confirms.`);

    const snap = {
      available: true,
      generatedAt: new Date().toISOString(),
      cutoffTime: `${Math.floor(cutoffMin/60)}:${String(cutoffMin%60).padStart(2,'0')}`,
      preMktBias, sessionSignal, mornBias, biasPlaying, biasReversed,
      sessOpen: Math.round(sessOpen), sessHigh: Math.round(sessHigh), sessLow: Math.round(sessLow),
      currentPrice: Math.round(sessClose), ptsVsOpen, dir,
      sessRange: Math.round(sessRange), rangeVsAvg: Math.round(rangeVsAvg * 100),
      vwap, gLine: gLine ? Math.round(gLine) : null, pwHigh: pwHigh ? Math.round(pwHigh) : null, pwLow: pwLow ? Math.round(pwLow) : null,
      orHigh: Math.round(acdRow.or_high), orLow: Math.round(acdRow.or_low),
      aUpFired: !!acdRow.a_up_fired, aDownFired: !!acdRow.a_down_fired,
      p3Score, p3Source, dayTypeDeveloping, watches,
    };
    res.json(snap);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auction-read/eod', async (req, res) => {
  try {
    const dateET = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Morning read
    const ar = await query(`SELECT * FROM auction_reads WHERE trade_date=$1`, [dateET]);
    const read = ar.rows[0] || {};

    // ACD levels + signals
    const acd = await query(`SELECT or_high::float, or_low::float, a_up_level::float, a_down_level::float, a_up_fired, a_down_fired, or_high::float - or_low::float as or_range FROM acd_daily_log WHERE trade_date=$1`, [dateET]);
    const acdRow = acd.rows[0];
    if (!acdRow) return res.json({ available: false, reason: 'No ACD data for this date' });

    // Full RTH session bars
    const barsQ = await query(`
      SELECT high::float, low::float, close::float, open::float, volume::bigint,
             EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as bm,
             to_char(ts,'HH24:MI') as t
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY ts
    `, [dateET]);
    const bars = barsQ.rows;
    if (!bars.length) return res.json({ available: false, reason: 'No bar data for this date' });

    // Session stats
    const sessOpen  = bars[0]?.open;
    const sessClose = bars[bars.length-1]?.close;
    const sessHigh  = Math.max(...bars.map(b => b.high));
    const sessLow   = Math.min(...bars.map(b => b.low));
    const sessRange = sessHigh - sessLow;
    const ptsVsOpen = Math.round((sessClose - sessOpen) * 100) / 100;
    const actualDir = ptsVsOpen > 15 ? 'BULLISH' : ptsVsOpen < -15 ? 'BEARISH' : 'NEUTRAL';

    // Avg range (30-day)
    const avgQ = await query(`SELECT AVG(daily_range)::float as avg FROM (SELECT MAX(high)-MIN(low) as daily_range FROM price_bars WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= ($1::text)::date - INTERVAL '30 days' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ts::date) sub`, [dateET]);
    const avgRange = avgQ.rows.length ? avgQ.rows.reduce((s,r)=>s+r.avg,0)/avgQ.rows.length : 150;
    const rangeVsAvg = sessRange / avgRange;

    // Prior week levels
    const pwQ = await query(`SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low FROM price_bars WHERE symbol='NQ' AND ts::date >= date_trunc('week',($1::text)::date) - INTERVAL '7 days' AND ts::date < date_trunc('week',($1::text)::date) AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [dateET]);
    const pwHigh = pwQ.rows[0]?.pw_high;
    const pwLow  = pwQ.rows[0]?.pw_low;

    // G-Line (weekly open)
    const gQ = await query(`SELECT (array_agg(open ORDER BY ts))[1]::float as g FROM price_bars WHERE symbol='NQ' AND ts::date>=date_trunc('week',($1::text)::date) AND ts::date<=($1::text)::date AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 570 AND EXTRACT(hour FROM ts) < 16`, [dateET]);
    const gLine = gQ.rows[0]?.g;

    // VWAP
    const totalVol = bars.reduce((s,b)=>s+(Number(b.volume)||1),0);
    const vwap = bars.reduce((s,b)=>s+b.close*(Number(b.volume)||1),0)/totalVol;

    // Bias
    const inv  = read.overnight_inventory;
    const val  = read.open_vs_prior_value;
    const strLong  = (inv==='SHORT_TRAPPED'&&val!=='BELOW_VALUE')||(inv==='NEUTRAL'&&val==='ABOVE_VALUE');
    const strShort = (inv==='LONG_TRAPPED'&&val!=='ABOVE_VALUE')||(inv==='NEUTRAL'&&val==='BELOW_VALUE');
    const mornBias = acdRow.a_up_fired ? 'LONG' : acdRow.a_down_fired ? 'SHORT' : strLong ? 'LONG' : strShort ? 'SHORT' : 'NEUTRAL';
    const biasCorrect = (mornBias==='LONG'&&actualDir==='BULLISH')||(mornBias==='SHORT'&&actualDir==='BEARISH');
    const biasWrong   = (mornBias==='LONG'&&actualDir==='BEARISH')||(mornBias==='SHORT'&&actualDir==='BULLISH');

    // Pattern detection
    const patterns = [];

    // V-reversal: big drop then recovery (or vice versa)
    const firstHalfBars = bars.filter(b => b.bm < 12*60);
    const secondHalfBars = bars.filter(b => b.bm >= 12*60);
    const firstHalfLow  = firstHalfBars.length ? Math.min(...firstHalfBars.map(b=>b.low)) : sessLow;
    const firstHalfHigh = firstHalfBars.length ? Math.max(...firstHalfBars.map(b=>b.high)) : sessHigh;
    const dropFromOpen  = sessOpen - firstHalfLow;
    const riseFromLow   = sessClose - sessLow;
    const dropToHigh    = firstHalfHigh - sessOpen;
    const fallFromHigh  = sessHigh - sessClose;
    if (dropFromOpen > avgRange * 0.4 && riseFromLow > dropFromOpen * 0.6) {
      patterns.push({ type: 'V_REVERSAL_UP', label: 'Bullish V-Reversal', detail: `Price sold off ${dropFromOpen.toFixed(0)}pts from the open, then recovered ${riseFromLow.toFixed(0)}pts — a classic spring/trap. The initial breakdown attracted sellers who were squeezed.` });
    } else if (dropToHigh > avgRange * 0.4 && fallFromHigh > dropToHigh * 0.6) {
      patterns.push({ type: 'V_REVERSAL_DOWN', label: 'Bearish V-Reversal', detail: `Price rallied ${dropToHigh.toFixed(0)}pts from the open then collapsed ${fallFromHigh.toFixed(0)}pts — buyers absorbed then reversed.` });
    }

    // Trend day
    if (rangeVsAvg > 1.8 && Math.abs(ptsVsOpen) > avgRange * 0.5) {
      patterns.push({ type: 'TREND_DAY', label: 'Trend Day', detail: `Session range ${sessRange.toFixed(0)}pts (${(rangeVsAvg*100).toFixed(0)}% of avg). Price closed ${ptsVsOpen > 0 ? '+' : ''}${ptsVsOpen}pts from open — one-sided directional day with limited pullbacks.` });
    }

    // Balance/rotation day
    if (rangeVsAvg < 0.7) {
      patterns.push({ type: 'BALANCE_DAY', label: 'Balance/Rotation Day', detail: `Session range ${sessRange.toFixed(0)}pts (only ${(rangeVsAvg*100).toFixed(0)}% of avg). Price rotated inside a tight range — neither side committed. Low-conviction day.` });
    }

    // Failed A signal — absorption (multiple fails before fire or no fire)
    const aUpFailed = !acdRow.a_up_fired && sessHigh >= acdRow.a_up_level;
    const aDownFailed = !acdRow.a_down_fired && sessLow <= acdRow.a_down_level;
    if (aUpFailed) patterns.push({ type: 'FAILED_A_UP', label: 'Failed A Up (Absorption)', detail: `Price reached the A Up level (${acdRow.a_up_level?.toFixed(0)}) but couldn't sustain above OR High. Bulls showed up and were absorbed. This failure was itself the signal.` });
    if (aDownFailed) patterns.push({ type: 'FAILED_A_DOWN', label: 'Failed A Down (Absorption)', detail: `Price reached the A Down level (${acdRow.a_down_level?.toFixed(0)}) but couldn't sustain below OR Low. Bears showed up and were absorbed. Classic spring setup.` });

    // News-driven open (8:30 spike bar)
    const earlyBars = bars.filter(b => b.bm >= 8*60 && b.bm <= 9*60);
    const maxEarlyRange = earlyBars.length ? Math.max(...earlyBars.map(b=>b.high-b.low)) : 0;
    if (maxEarlyRange > avgRange * 0.3) {
      const newsBar = earlyBars.find(b=>(b.high-b.low)===maxEarlyRange);
      patterns.push({ type: 'NEWS_DRIVEN', label: 'News-Driven Open (8:30)', detail: `A ${maxEarlyRange.toFixed(0)}-point bar fired at ${newsBar?.t} ET — characteristic 8:30 economic data spike. These bars often set the day's extremes. Initial reaction direction: ${newsBar && newsBar.close < newsBar.open ? 'DOWN' : 'UP'}.` });
    }

    // G-Line behavior
    const gLost = gLine && sessLow < gLine;
    const gReclaimed = gLost && sessClose > gLine;
    const gNeverLost = gLine && sessLow >= gLine;
    let gNote = null;
    if (gReclaimed) gNote = `G-Line (${gLine?.toFixed(0)}) was lost intraday but reclaimed by close — weekly structure turned negative then recovered. Indecisive week so far.`;
    else if (gLost) gNote = `G-Line (${gLine?.toFixed(0)}) was lost and not reclaimed — week closed negative. Bearish weekly structure heading into tomorrow.`;
    else if (gNeverLost) gNote = `G-Line (${gLine?.toFixed(0)}) held all day — weekly structure remained bullish throughout.`;

    // PW level interaction
    let pwNote = null;
    if (pwHigh && sessHigh >= pwHigh && sessClose < pwHigh) pwNote = `Prior week high (${pwHigh?.toFixed(0)}) was tested but rejected — failed breakout above last week's range. Watch for continuation short or re-test.`;
    else if (pwHigh && sessClose > pwHigh) pwNote = `Price closed above the prior week high (${pwHigh?.toFixed(0)}) — new weekly acceptance. Structurally bullish carry into next session.`;
    else if (pwLow && sessLow <= pwLow && sessClose > pwLow) pwNote = `Prior week low (${pwLow?.toFixed(0)}) was tested but held — successful test of weekly support. Spring-like structure.`;

    // P3 score — compute from full day bars if DB values are null
    const allBars = bars;
    const eodTVol = allBars.reduce((s,r)=>s+(Number(r.volume)||1),0);
    const eodVwap = allBars.reduce((s,r)=>s+r.close*(Number(r.volume)||1),0)/eodTVol;
    const eodSplit = Math.max(1, allBars.length-20);
    const eodEarlyV = allBars.slice(0,eodSplit).reduce((s,r)=>s+(Number(r.volume)||1),0);
    const eodEarlyVwap = allBars.slice(0,eodSplit).reduce((s,r)=>s+r.close*(Number(r.volume)||1),0)/eodEarlyV;
    const eodBiasForP3 = biasCorrect ? (actualDir==='BULLISH'?'LONG':'SHORT') : mornBias;
    const eodP3vm = read.p3_value_migrating ?? (eodBiasForP3==='LONG'?eodVwap>eodEarlyVwap:eodBiasForP3==='SHORT'?eodVwap<eodEarlyVwap:false);
    const eodP3vh = read.p3_vwap_holding ?? (eodBiasForP3==='LONG'?sessClose>eodVwap:eodBiasForP3==='SHORT'?sessClose<eodVwap:false);
    const eodLast10 = allBars.slice(-10);
    const eodAvgCP = eodLast10.reduce((s,r)=>{const rng=r.high-r.low; return s+(rng>0?(r.close-r.low)/rng:0.5);},0)/eodLast10.length;
    const eodP3dc = read.p3_delta_confirming ?? (eodBiasForP3==='LONG'?eodAvgCP>0.55:eodBiasForP3==='SHORT'?eodAvgCP<0.45:false);
    const eodLast20 = allBars.slice(-20);
    const eodAcc = eodLast20.filter(r=>eodBiasForP3==='LONG'?r.close>parseFloat(acdRow.or_high):eodBiasForP3==='SHORT'?r.close<parseFloat(acdRow.or_low):false).length;
    const eodP3aa = read.p3_auction_accepted ?? (eodLast20.length>0&&eodAcc/eodLast20.length>=0.4);
    const eodLast16 = allBars.slice(-16); let eodP3ri = read.p3_rotations_increasing ?? false;
    if (!read.p3_rotations_increasing && eodLast16.length>=8){const h=Math.floor(eodLast16.length/2); const r1=Math.max(...eodLast16.slice(0,h).map(r=>r.high))-Math.min(...eodLast16.slice(0,h).map(r=>r.low)); const r2=Math.max(...eodLast16.slice(h).map(r=>r.high))-Math.min(...eodLast16.slice(h).map(r=>r.low)); eodP3ri=r2>r1*1.15;}
    const p3Score = [eodP3vm,eodP3vh,eodP3dc,eodP3aa,eodP3ri].filter(Boolean).length;
    const p3Source = read.p3_updated_at ? 'manual' : 'auto-computed';

    // ── Longterm structural context at time of session ────────────────────
    const acdHistQ = await query(`
      SELECT SUM(daily_score) as nl30,
             SUM(CASE WHEN trade_date >= ($1::text)::date - INTERVAL '10 days' THEN daily_score ELSE 0 END) as nl10
      FROM acd_daily_log WHERE trade_date < ($1::text)::date AND trade_date >= ($1::text)::date - INTERVAL '30 days'
    `, [dateET]);
    const ltNL30 = acdHistQ.rows[0]?.nl30 || 0;
    const ltNL10 = acdHistQ.rows[0]?.nl10 || 0;
    const ltNL30trend = ltNL30 > 9 ? 'confirmed uptrend' : ltNL30 < -9 ? 'confirmed downtrend' : 'ranging (no directional edge)';

    // VA migration direction: last 5 days before this session
    const vaHist5Q = await query(`
      WITH days AS (
        SELECT DISTINCT ts::date::text as d FROM price_bars WHERE symbol='NQ'
          AND ts::date < ($1::text)::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        ORDER BY d DESC LIMIT 5
      )
      SELECT d, (SELECT ROUND((array_agg(close ORDER BY ts DESC))[1]/0.25)*0.25 FROM price_bars WHERE symbol='NQ' AND ts::date::text=days.d AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16) as close
      FROM days ORDER BY d ASC
    `, [dateET]);
    const vaClosing = vaHist5Q.rows.map(r => parseFloat(r.close)).filter(Boolean);
    const ltValMigration = vaClosing.length >= 3
      ? (vaClosing[vaClosing.length-1] > vaClosing[0] ? 'migrating higher' : vaClosing[vaClosing.length-1] < vaClosing[0] ? 'migrating lower' : 'overlapping')
      : null;

    // Bracket state from VA overlap over last 10 days
    const vaOverlapQ = await query(`
      SELECT COUNT(*) as overlap_days FROM (
        SELECT d1.d, d2.d as prev,
          LEAST(d1.vah, d2.vah) - GREATEST(d1.val, d2.val) as overlap
        FROM (
          SELECT ts::date::text as d, MAX(high)::float as vah, MIN(low)::float as val
          FROM price_bars WHERE symbol='NQ' AND ts::date < ($1::text)::date
            AND ts::date >= ($1::text)::date - INTERVAL '14 days'
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ts::date
        ) d1 JOIN (
          SELECT ts::date::text as d, MAX(high)::float as vah, MIN(low)::float as val
          FROM price_bars WHERE symbol='NQ' AND ts::date < ($1::text)::date
            AND ts::date >= ($1::text)::date - INTERVAL '15 days'
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ts::date
        ) d2 ON d2.d < d1.d
        ORDER BY d1.d DESC LIMIT 9
      ) t WHERE overlap > 0
    `, [dateET]);
    const ltOverlaps = parseInt(vaOverlapQ.rows[0]?.overlap_days) || 0;
    const ltBracket = ltOverlaps >= 7 ? 'BRACKET (high confidence)' : ltOverlaps >= 5 ? 'BRACKET (moderate)' : ltValMigration === 'migrating higher' ? 'TRENDING UP' : ltValMigration === 'migrating lower' ? 'TRENDING DOWN' : 'TRANSITIONAL';

    // ── Deep narrative generation ──────────────────────────────────────────
    const p = v => v?.toFixed ? v.toFixed(0) : v || '—';
    const invLabels = { SHORT_TRAPPED: 'short sellers trapped above value', LONG_TRAPPED: 'long buyers trapped below value', NEUTRAL: 'neither side trapped — no forced activity expected' };
    const valLabels = { ABOVE_VALUE: 'above prior value area', INSIDE_VALUE: 'inside prior value area', BELOW_VALUE: 'below prior value area' };
    const profileLabels = { TREND: 'Trend day (inefficient — go with range extensions)', NORMAL_VARIATION: 'Normal Variation (go with extensions but expect two-sided rotations)', NORMAL: 'Normal (two-sided, responsive strategies)', NEUTRAL: 'Neutral (balance — fade the extremes)', RUNNING_PROFILE_NEUTRAL: 'Running Neutral (two-sided but closed near an extreme)', NONTREND: 'Nontrend (very efficient — fade everything)' };

    // Pre-market read narrative
    const preNarrative = [];
    if (inv && val) {
      preNarrative.push(`Overnight inventory was ${invLabels[inv] || inv.replace(/_/g,' ')}. Price opened ${valLabels[val] || val.replace(/_/g,' ')}.`);
    }
    if (read.prior_day_profile) {
      const isPriorInefficient = ['TREND','NORMAL_VARIATION'].includes(read.prior_day_profile);
      preNarrative.push(`Prior day classified as ${profileLabels[read.prior_day_profile] || read.prior_day_profile}. Playbook: ${isPriorInefficient ? 'initiative — go with range extensions, do not fade' : 'responsive — fade extremes, buy VAL sell VAH'}.`);
    }
    if (acdRow.or_high && acdRow.or_low) {
      const orRng = (acdRow.or_high - acdRow.or_low).toFixed(0);
      const orVsAvg = avgRange > 0 ? ((acdRow.or_high - acdRow.or_low) / avgRange * 100).toFixed(0) : null;
      preNarrative.push(`OR was ${p(acdRow.or_high)} / ${p(acdRow.or_low)} (${orRng}pts${orVsAvg ? ', ' + orVsAvg + '% of avg' : ''}).`);
    }
    // What the combined read implied
    if (mornBias !== 'NEUTRAL') {
      const conflicted = (inv === 'NEUTRAL' || val === 'INSIDE_VALUE');
      preNarrative.push(`Combined structural read: ${mornBias} bias${conflicted ? ', though with limited structural edge (neutral/inside value position means neither side has forced activity advantage)' : ' with clear structural support'}.`);
    } else {
      preNarrative.push(`Combined structural read: NEUTRAL — overlapping conditions made a directional bias difficult to establish pre-market. Two-sided strategy was appropriate.`);
    }

    // Longer-term structural context
    const ltNL30desc = ltNL30 > 9 ? `NL30 at +${ltNL30} — 30-session uptrend confirmed` : ltNL30 < -9 ? `NL30 at ${ltNL30} — 30-session downtrend confirmed` : `NL30 at ${ltNL30 > 0 ? '+' : ''}${ltNL30} — ranging, no multi-session directional edge`;
    const ltNLalign = (mornBias === 'LONG' && ltNL30 > 9) || (mornBias === 'SHORT' && ltNL30 < -9);
    const ltNLconflict = (mornBias === 'LONG' && ltNL30 < -9) || (mornBias === 'SHORT' && ltNL30 > 9);
    const ltBracketNote = ltBracket.startsWith('TRENDING') ? `market structure was ${ltBracket} — initiative playbook supported intraday signals in the trend direction` : ltBracket.startsWith('BRACKET') ? `market structure was in BRACKET — responsive playbook, range extension signals carry higher failure risk in this environment` : `market structure was TRANSITIONAL — reduced reliability for directional setups`;
    const ltValNote = ltValMigration ? `value was ${ltValMigration} over the prior 5 sessions` : null;

    let ltLine = `Longer-term context: ${ltNL30desc}. ${ltBracketNote}.`;
    if (ltValNote) ltLine += ` ${ltValNote.charAt(0).toUpperCase() + ltValNote.slice(1)}.`;
    if (ltNLalign && mornBias !== 'NEUTRAL') ltLine += ` The 30-session NL trend aligned with today's ${mornBias} structural bias — multi-timeframe confluence.`;
    else if (ltNLconflict && mornBias !== 'NEUTRAL') ltLine += ` Note: the 30-session NL was working against today's ${mornBias} structural bias — counter-trend setup, lower conviction.`;
    preNarrative.push(ltLine);

    // Session narrative — what actually happened
    const sessionNarrative = [];
    if (acdRow.a_up_fired) {
      sessionNarrative.push(`A Up signal confirmed (OR High ${p(acdRow.or_high)}). Price sustained above OR High for 5 minutes — buyers took structural control of the session. This converted the pre-market LONG bias into an active long entry signal.`);
    } else if (acdRow.a_down_fired) {
      sessionNarrative.push(`A Down signal confirmed (OR Low ${p(acdRow.or_low)}). Price sustained below OR Low for 5 minutes — sellers took structural control. This converted the pre-market SHORT bias into an active short entry signal.`);
    } else {
      sessionNarrative.push(`No A signal fired — neither side held beyond their A level for 5 minutes. This is a no-signal day. ${mornBias !== 'NEUTRAL' ? `The pre-market ${mornBias} bias was not confirmed by the ACD framework.` : 'Consistent with the neutral pre-market read.'}`);
    }
    // Range character
    if (rangeVsAvg > 1.5) {
      sessionNarrative.push(`Session range was ${Math.round(sessRange)}pts — ${Math.round(rangeVsAvg * 100)}% of the 30-day average. This was a large-range day, characteristic of OTF (other timeframe) participation. The prior day's TREND classification set up the expectation for above-average range, and it delivered.`);
    } else if (rangeVsAvg < 0.7) {
      sessionNarrative.push(`Session range was ${Math.round(sessRange)}pts — only ${Math.round(rangeVsAvg * 100)}% of the 30-day average. Price stayed compressed. Despite the structural ${mornBias !== 'NEUTRAL' ? mornBias + ' ' : ''}read, this was an efficiency day — neither side committed to significant extension.`);
    } else {
      sessionNarrative.push(`Session range was ${Math.round(sessRange)}pts (${Math.round(rangeVsAvg * 100)}% of avg) — normal participation, consistent with a standard session.`);
    }
    // VWAP context
    const closeVsVwap = sessClose - vwap;
    sessionNarrative.push(`VWAP settled at ${Math.round(vwap)}. Session closed ${Math.abs(closeVsVwap).toFixed(0)}pts ${closeVsVwap > 0 ? 'above' : 'below'} VWAP — ${closeVsVwap > 0 ? 'buyers maintained value acceptance above the session average, confirming structural control' : 'price accepted below the session average, with sellers maintaining structural pressure into the close'}.`);
    // G-Line
    if (gLine) {
      if (sessClose > gLine && sessLow < gLine) sessionNarrative.push(`Weekly G-Line (${Math.round(gLine)}) was tested intraday but reclaimed by the close — the week ended on a positive structural note despite the intraday probe.`);
      else if (sessClose > gLine) sessionNarrative.push(`Price held above the weekly G-Line (${Math.round(gLine)}) throughout — the week maintained a positive structural character.`);
      else sessionNarrative.push(`Price closed below the weekly G-Line (${Math.round(gLine)}) — the week turned structurally negative. This matters going into tomorrow.`);
    }

    // Verdict and what it means
    const verdictNarrative = [];
    if (biasCorrect) {
      if (acdRow.a_up_fired || acdRow.a_down_fired) {
        verdictNarrative.push(`The pre-market structural read (${mornBias}) was validated by the A signal and confirmed by price following through. The three elements aligned: structural bias, ACD signal, and price acceptance. This is the highest-quality setup condition.`);
      } else {
        verdictNarrative.push(`The pre-market structural read (${mornBias}) was directionally correct, though without an A signal the trade was structural rather than signal-confirmed. Price moved in the bias direction, but the ACD framework did not provide a clean entry trigger.`);
      }
      if (ltNLalign) verdictNarrative.push(`The 30-session number line (${ltNL30 > 0 ? '+' : ''}${ltNL30}) was aligned with the ${mornBias} bias — today's intraday read had multi-timeframe structural support. When the NL, bracket state, and daily structure all agree, the setup quality is highest.`);
      else if (ltNL30 > -9 && ltNL30 < 9) verdictNarrative.push(`The 30-session number line was ranging (${ltNL30 > 0 ? '+' : ''}${ltNL30}) — no multi-session trend tailwind. Today's correct call was driven by the intraday structure, not a broader trend edge.`);
      if (p3Score >= 3) verdictNarrative.push(`In-session monitor confirmed throughout (${p3Score}/5) — the structure was observable and real, not just directional luck.`);
    } else if (biasWrong) {
      verdictNarrative.push(`The pre-market read called ${mornBias} but price moved ${actualDir.toLowerCase()}. `);
      if (ltNLconflict) verdictNarrative[verdictNarrative.length-1] += ` Notably, the 30-session number line (${ltNL30 > 0 ? '+' : ''}${ltNL30}) was already working against the ${mornBias} bias — this was a counter-trend intraday read in a ${ltNL30 > 9 ? 'bullish' : 'bearish'} structural environment. Counter-trend setups carry higher failure rates.`;
      if (patterns.some(p => p.type === 'NEWS_DRIVEN')) verdictNarrative[verdictNarrative.length-1] += `The 8:30 data event overrode the structural read — news-driven moves often ignore pre-session structure. This is not a structural failure; it is an external catalyst superseding the auction framework.`;
      else if (patterns.some(p => p.type.includes('REVERSAL'))) verdictNarrative[verdictNarrative.length-1] += `A reversal pattern developed during the session — the market opened in the structural direction then reversed. This is the most costly scenario: the initial read was right but the session character changed mid-day.`;
      else verdictNarrative[verdictNarrative.length-1] += `The structural conditions did not produce the expected directional follow-through. Review whether the prior day profile classification was accurate — if yesterday was mis-classified, the playbook would have been wrong from the start.`;
      if (p3Score <= 1) verdictNarrative.push(`P3 score was ${p3Score}/5 — the in-session monitor was correctly showing that the bias was not being confirmed. This was an available exit signal during the session.`);
    } else {
      verdictNarrative.push(`Neutral outcome — price moved less than 15pts from open to close. The session stayed inside the prior value area and neither side asserted control. The pre-market NEUTRAL read (if that was the call) was accurate. In neutral sessions, the playbook is to fade extremes rather than initiate in either direction.`);
    }
    // Tomorrow
    const tomorrow = [];
    if (biasCorrect && (acdRow.a_up_fired || acdRow.a_down_fired)) {
      tomorrow.push(`Prior day now classified as likely ${rangeVsAvg > 1.5 ? 'TREND' : 'NORMAL_VARIATION'} — tomorrow's playbook: ${rangeVsAvg > 1.5 ? 'initiative, go with range extensions, same side maintained control' : 'two-sided with extensions possible'}.`);
    }
    if (gLine) {
      tomorrow.push(sessClose > gLine ? `G-Line (${Math.round(gLine)}) becomes support going into tomorrow — hold above = week remains structurally positive.` : `G-Line (${Math.round(gLine)}) is now overhead resistance — any rally tomorrow that stalls here is a potential fade.`);
    }

    const narrative = { preMarket: preNarrative, session: sessionNarrative, verdict: verdictNarrative, tomorrow };

    // Build the analysis object
    const analysis = {
      available: true,
      date: dateET,
      // Prediction
      mornBias,
      inv: read.overnight_inventory,
      val: read.open_vs_prior_value,
      priorProfile: read.prior_day_profile,
      orCondition: read.or_condition,
      openingCall: read.opening_call_type,
      // Result
      actualDir,
      ptsVsOpen,
      sessOpen: Math.round(sessOpen),
      sessClose: Math.round(sessClose),
      sessHigh: Math.round(sessHigh),
      sessLow: Math.round(sessLow),
      sessRange: Math.round(sessRange),
      rangeVsAvg: Math.round(rangeVsAvg * 100),
      vwap: Math.round(vwap),
      // Signal
      aUpLevel: acdRow.a_up_level, aDownLevel: acdRow.a_down_level,
      aUpFired: !!acdRow.a_up_fired, aDownFired: !!acdRow.a_down_fired,
      orRange: Math.round(acdRow.or_range),
      // Accuracy
      biasCorrect, biasWrong,
      outcome: biasCorrect ? 'CORRECT' : biasWrong ? 'WRONG' : 'NEUTRAL',
      // Patterns
      patterns,
      // Levels
      gLine: gLine ? Math.round(gLine) : null,
      gNote,
      pwHigh: pwHigh ? Math.round(pwHigh) : null,
      pwLow: pwLow ? Math.round(pwLow) : null,
      pwNote,
      // P3
      p3Score, p3Source,
      // Deep narrative
      narrative,
    };

    res.json(analysis);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wyckoff/levels', async (req, res) => {
  try {
    const { price_level, level_type, origin_description, notes } = req.body;
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const r = await query(`INSERT INTO wyckoff_levels (level_date, price_level, level_type, origin_description, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *, level_date::text`, [todayET, price_level, level_type, origin_description, notes]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/wyckoff/levels/:id', async (req, res) => {
  try {
    const { status, spring_occurred, spring_date, spring_volume_type, upthrust_occurred, upthrust_date, notes } = req.body;
    const r = await query(`UPDATE wyckoff_levels SET status=COALESCE($1,status), spring_occurred=COALESCE($2,spring_occurred), spring_date=COALESCE($3,spring_date), spring_volume_type=COALESCE($4,spring_volume_type), upthrust_occurred=COALESCE($5,upthrust_occurred), upthrust_date=COALESCE($6,upthrust_date), notes=COALESCE($7,notes) WHERE id=$8 RETURNING *, level_date::text`, [status, spring_occurred, spring_date, spring_volume_type, upthrust_occurred, upthrust_date, notes, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/wyckoff/levels/:id', async (req, res) => {
  try {
    await query(`UPDATE wyckoff_levels SET status='ARCHIVED' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Wyckoff setup stats ───────────────────────────────────────────────────────
app.get('/api/wyckoff/setups/stats', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        wyckoff_setup,
        spring_volume_type,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE pnl > 0) as wins,
        ROUND(COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*),0) * 100, 1) as win_rate,
        ROUND(AVG(pnl) FILTER (WHERE pnl > 0)::numeric, 2) as avg_win,
        ROUND(ABS(AVG(pnl)) FILTER (WHERE pnl < 0)::numeric, 2) as avg_loss,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl
      FROM trades
      WHERE wyckoff_setup IS NOT NULL AND pnl IS NOT NULL
      GROUP BY wyckoff_setup, spring_volume_type
      ORDER BY wyckoff_setup
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Effort vs Result — compute from price_bars ────────────────────────────────
app.get('/api/wyckoff/effort-result', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const lbd = await latestBarDate();
    const cacheKey = `effort-result-${days}-${lbd}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Get last N trading days with volume and range from price_bars
    const r = await query(`
      WITH daily AS (
        SELECT
          ts::date as session_date,
          MAX(high)::numeric(8,2) as session_high,
          MIN(low)::numeric(8,2) as session_low,
          MAX(high) - MIN(low) as session_range,
          SUM(volume)::bigint as total_volume
        FROM price_bars
        WHERE symbol='NQ'
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY ts::date
        HAVING COUNT(*) > 100
        ORDER BY ts::date DESC
        LIMIT $1
      ),
      stats AS (
        SELECT
          AVG(session_range) as avg_range_30d,
          AVG(total_volume) as avg_volume_30d
        FROM (
          SELECT
            MAX(high) - MIN(low) as session_range,
            SUM(volume) as total_volume
          FROM price_bars
          WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ts::date
          HAVING COUNT(*) > 100
          ORDER BY MAX(ts) DESC
          LIMIT 30
        ) sub
      )
      SELECT
        d.session_date::text,
        d.session_high, d.session_low,
        ROUND(d.session_range::numeric, 1) as session_range,
        d.total_volume,
        ROUND((d.total_volume / NULLIF(s.avg_volume_30d, 0))::numeric, 2) as volume_ratio,
        ROUND((d.session_range / NULLIF(s.avg_range_30d, 0))::numeric, 2) as range_ratio,
        CASE
          WHEN (d.total_volume / NULLIF(s.avg_volume_30d, 0)) > 1.5
           AND (d.session_range / NULLIF(s.avg_range_30d, 0)) < 0.7 THEN 'ABSORPTION'
          WHEN (d.total_volume / NULLIF(s.avg_volume_30d, 0)) < 0.8
           AND (d.session_range / NULLIF(s.avg_range_30d, 0)) > 1.3 THEN 'EASE_OF_MOVEMENT'
          ELSE 'NORMAL'
        END as flag
      FROM daily d, stats s
      ORDER BY d.session_date DESC
      LIMIT $1
    `, [days]);
    const result = r.rows;
    cacheSet(cacheKey, result, 4 * 60 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SOT detection ─────────────────────────────────────────────────────────────
app.get('/api/wyckoff/sot', async (req, res) => {
  try {
    const cacheKey = 'sot-signals';
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Get daily high/low for last 60 days to detect swing points
    const bars = await query(`
      SELECT ts::date::text as date, MAX(high)::numeric(8,2) as high, MIN(low)::numeric(8,2) as low
      FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      GROUP BY ts::date ORDER BY ts::date DESC LIMIT 60
    `);
    const days = bars.rows.reverse(); // oldest first
    if (days.length < 10) return res.json({ up: null, down: null });

    // Find swing highs and lows (N=3 bar pivot)
    const swingHighs = [], swingLows = [];
    for (let i = 2; i < days.length - 2; i++) {
      const d = days[i];
      if (d.high >= days[i-1].high && d.high >= days[i-2].high && d.high >= days[i+1].high && d.high >= days[i+2].high) {
        swingHighs.push({ date: d.date, price: parseFloat(d.high) });
      }
      if (d.low <= days[i-1].low && d.low <= days[i-2].low && d.low <= days[i+1].low && d.low <= days[i+2].low) {
        swingLows.push({ date: d.date, price: parseFloat(d.low) });
      }
    }

    const detectSOT = (swings, direction) => {
      if (swings.length < 3) return null;
      const last3 = swings.slice(-3);
      const m1 = Math.abs(last3[1].price - last3[0].price);
      const m2 = Math.abs(last3[2].price - last3[1].price);
      if (m2 < m1) {
        const pct = ((m1 - m2) / m1 * 100);
        if (pct >= 25) return { direction, swing1: m1.toFixed(1), swing2: m2.toFixed(1), pct: pct.toFixed(1), dates: last3.map(s => s.date), latestSwingDate: last3[2].date };
      }
      return null;
    };

    const result = {
      up: detectSOT(swingHighs, 'UP'),
      down: detectSOT(swingLows, 'DOWN'),
      swingHighs: swingHighs.slice(-5),
      swingLows: swingLows.slice(-5),
    };
    cacheSet(cacheKey, result, 60 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Weekly IB structure ───────────────────────────────────────────────────────
app.get('/api/weekly/current', async (req, res) => {
  try {
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    // Week start = Monday
    const dow = nowET.getDay(); // 0=Sun, 1=Mon...
    const daysToMon = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(nowET);
    monday.setDate(monday.getDate() + daysToMon);
    const weekStart = monday.toISOString().split('T')[0];

    const r = await query(`SELECT id, week_start::text as week_start_str, monday_high, monday_low, normal_week_upper, normal_week_lower, normal_var_upper, normal_var_lower, week_high, week_low, week_close, week_type, direction, acd_number_line_monday, monthly_pivot_bias, notes FROM weekly_ib_structure WHERE week_start=$1`, [weekStart]);
    if (r.rows.length > 0) {
      // Fetch current week high/low from bars
      const weekBars = await query(`
        SELECT MAX(high)::numeric(8,2) as week_high, MIN(low)::numeric(8,2) as week_low
        FROM price_bars WHERE symbol='NQ' AND ts::date >= $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [weekStart]);
      const nlRow = await query(`SELECT COALESCE(SUM(daily_score),0) as nl30 FROM (SELECT daily_score FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) s`);
      const row = { ...r.rows[0], week_start: r.rows[0].week_start_str || weekStart };
      return res.json({ ...row, current_week_high: weekBars.rows[0]?.week_high, current_week_low: weekBars.rows[0]?.week_low, nl30: parseInt(nlRow.rows[0]?.nl30) });
    }

    // Auto-compute Monday IB from price_bars if available
    const mondayBars = await query(`
      SELECT MAX(high)::numeric(8,2) as high, MIN(low)::numeric(8,2) as low
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 10
    `, [weekStart]);

    if (mondayBars.rows[0]?.high) {
      const mh = parseFloat(mondayBars.rows[0].high), ml = parseFloat(mondayBars.rows[0].low);
      const ibRange = mh - ml;
      const nlRow = await query(`SELECT COALESCE(SUM(daily_score),0) as nl30 FROM (SELECT daily_score FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) s`);
      const pivotRow = await query(`SELECT pivot_level FROM acd_monthly_pivot WHERE month_year=$1`, [`${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}`]);
      const latestBar = await query(`SELECT close::float FROM price_bars WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
      const nqClose = latestBar.rows[0]?.close;
      const pivotLevel = parseFloat(pivotRow.rows[0]?.pivot_level) || null;
      const pivotBias = pivotLevel ? (nqClose > pivotLevel ? 'ABOVE' : 'BELOW') : null;

      const saved = await query(`
        INSERT INTO weekly_ib_structure (week_start, monday_high, monday_low, normal_week_upper, normal_week_lower, normal_var_upper, normal_var_lower, acd_number_line_monday, monthly_pivot_bias)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (week_start) DO NOTHING RETURNING *, week_start::text
      `, [weekStart, mh, ml, mh+ibRange*0.5, ml-ibRange*0.5, mh+ibRange, ml-ibRange, parseInt(nlRow.rows[0]?.nl30), pivotBias]);

      const weekBars = await query(`SELECT MAX(high)::numeric(8,2) as week_high, MIN(low)::numeric(8,2) as week_low FROM price_bars WHERE symbol='NQ' AND ts::date >= $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [weekStart]);
      return res.json({ ...(saved.rows[0] || {}), week_start: weekStart, monday_high: mh, monday_low: ml, normal_week_upper: mh+ibRange*0.5, normal_week_lower: ml-ibRange*0.5, normal_var_upper: mh+ibRange, normal_var_lower: ml-ibRange, current_week_high: weekBars.rows[0]?.week_high, current_week_low: weekBars.rows[0]?.week_low, nl30: parseInt(nlRow.rows[0]?.nl30), monthly_pivot_bias: pivotBias });
    }

    // Return prior week context even if current week has no IB
    const priorWeek = await query(`SELECT id, week_start::text as week_start_str, monday_high, monday_low, normal_week_upper, normal_week_lower, normal_var_upper, normal_var_lower, week_high, week_low, week_close, week_type, direction, acd_number_line_monday, monthly_pivot_bias, notes FROM weekly_ib_structure WHERE week_start < $1 ORDER BY weekly_ib_structure.week_start DESC LIMIT 1`, [weekStart]);
    const pw = priorWeek.rows[0];
    if (pw) pw.week_start = pw.week_start_str || pw.week_start;
    const priorBars = pw ? await query(`SELECT (array_agg(close ORDER BY ts DESC))[1]::numeric(8,2) as week_close, MAX(high)::numeric(8,2) as week_high, MIN(low)::numeric(8,2) as week_low FROM price_bars WHERE symbol='NQ' AND ts::date >= $1 AND ts::date < $2 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [pw.week_start_str, weekStart]) : null;
    res.json({ week_start: weekStart, monday_high: null, monday_low: null, prior_week: pw ? { ...pw, week_close: priorBars?.rows[0]?.week_close, week_high: priorBars?.rows[0]?.week_high, week_low: priorBars?.rows[0]?.week_low } : null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/weekly/va-history — weekly VP levels for last N weeks (for migration chart)
app.get('/api/weekly/va-history', async (req, res) => {
  try {
    const weeksBack = parseInt(req.query.weeks) || 8;
    const lbd = await latestBarDate();
    const cacheKey = `weekly-va-history-${weeksBack}-${lbd}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Get last N week starts that have bar data
    const weekStarts = await query(`
      SELECT DISTINCT date_trunc('week', ts::date)::date::text as week_start
      FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY week_start DESC LIMIT $1
    `, [weeksBack]);

    const results = [];
    for (const { week_start } of weekStarts.rows) {
      const we = new Date(week_start + 'T12:00:00Z');
      we.setUTCDate(we.getUTCDate() + 4);
      const weekEnd = we.toISOString().split('T')[0];

      try {
        const vp = await query(`
          WITH vp AS (
            SELECT ROUND(low / 0.25) * 0.25 as px, SUM(volume) as vol
            FROM price_bars WHERE symbol='NQ' AND ts::date >= $1 AND ts::date <= $2
              AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
            GROUP BY ROUND(low / 0.25) * 0.25
          ),
          total AS (SELECT SUM(vol) as t FROM vp),
          poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
          SELECT
            p.poc_px::float as poc,
            (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px) s WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
            (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px) s WHERE cv <= (SELECT t*0.35 FROM total))::float as val,
            MAX(vp.px)::float as week_high, MIN(vp.px)::float as week_low
          FROM vp, poc_row p GROUP BY p.poc_px
        `, [week_start, weekEnd]);

        // Monday range
        const mon = await query(`
          SELECT MAX(high)::float as h, MIN(low)::float as l
          FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        `, [week_start]);

        // Week close (Friday last bar)
        const close = await query(`
          SELECT (array_agg(close ORDER BY ts DESC))[1]::float as close
          FROM price_bars WHERE symbol='NQ' AND ts::date <= $1 AND ts::date >= $2
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        `, [weekEnd, week_start]);

        if (vp.rows[0]) {
          const v = vp.rows[0], m = mon.rows[0];
          const ibRange = m.h && m.l ? m.h - m.l : null;
          results.push({
            week_start,
            poc: v.poc, vah: v.vah, val: v.val,
            week_high: v.week_high, week_low: v.week_low,
            week_close: close.rows[0]?.close,
            monday_high: m.h, monday_low: m.l,
            ib_range: ibRange,
            nw_upper: m.h && ibRange ? m.h + ibRange * 0.5 : null,
            nv_upper: m.h && ibRange ? m.h + ibRange : null,
            week_type: v.week_high >= (m.h + ibRange) ? 'TREND' :
                       v.week_high >= (m.h + ibRange * 0.5) ? 'NORMAL_VARIATION' : 'NORMAL',
          });
        }
      } catch(e) { /* skip weeks with insufficient data */ }
    }

    results.reverse(); // oldest first for chart
    cacheSet(cacheKey, results, 4 * 60 * 60 * 1000);
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/daily/va-history — daily RTH volume profile for last N days
app.get('/api/daily/va-history', async (req, res) => {
  try {
    const daysBack = parseInt(req.query.days) || 30;
    const lbd = await latestBarDate();
    const cacheKey = `daily-va-history-${daysBack}-${lbd}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const tradingDays = await query(`
      SELECT DISTINCT ts::date::text as date
      FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY date DESC LIMIT $1
    `, [daysBack]);

    const results = [];
    for (const { date } of tradingDays.rows) {
      try {
        const vp = await query(`
          WITH vp AS (
            SELECT ROUND(low / 0.25) * 0.25 as px, SUM(volume) as vol
            FROM price_bars WHERE symbol='NQ' AND ts::date=$1
              AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
            GROUP BY ROUND(low / 0.25) * 0.25
          ),
          total AS (SELECT SUM(vol) as t FROM vp),
          poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
          SELECT
            p.poc_px::float as poc,
            (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px) s WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
            (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px) s WHERE cv <= (SELECT t*0.35 FROM total))::float as val,
            (array_agg(close ORDER BY ts DESC))[1]::float as day_close
          FROM vp, poc_row p
          JOIN price_bars ON ts::date=$1 AND symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY p.poc_px LIMIT 1
        `, [date]);

        const ah = await query(`SELECT prior_profile, bias_dir FROM auction_history WHERE date=$1`, [date]);

        if (vp.rows[0]?.vah) {
          results.push({
            date,
            vah: vp.rows[0].vah,
            poc: vp.rows[0].poc,
            val: vp.rows[0].val,
            day_close: vp.rows[0].day_close,
            day_type: ah.rows[0]?.prior_profile || null,
            bias_dir: ah.rows[0]?.bias_dir || null,
          });
        }
      } catch(e) { /* skip days with insufficient data */ }
    }

    results.reverse();
    cacheSet(cacheKey, results, 4 * 60 * 60 * 1000);
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/weekly/bars — hourly bars + volume profile for a given week
app.get('/api/weekly/bars', async (req, res) => {
  try {
    const { week_start } = req.query;
    if (!week_start) return res.status(400).json({ error: 'week_start required' });
    const weekEnd = new Date(week_start + 'T12:00:00Z');
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 4);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    // Hourly bars
    const barsR = await query(`
      SELECT
        to_char(date_trunc('hour', ts), 'YYYY-MM-DD HH24:MI') as time,
        ts::date::text as date,
        (array_agg(open ORDER BY ts))[1]::float as open,
        MAX(high)::float as high,
        MIN(low)::float as low,
        (array_agg(close ORDER BY ts DESC))[1]::float as close,
        SUM(volume)::bigint as volume
      FROM price_bars
      WHERE symbol='NQ' AND ts::date >= $1 AND ts::date <= $2
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      GROUP BY date_trunc('hour', ts), ts::date
      ORDER BY date_trunc('hour', ts)
    `, [week_start, weekEndStr]);

    // Volume profile — 1-point buckets, find POC + 70% value area
    const vpR = await query(`
      WITH vp AS (
        SELECT ROUND(low / 0.25) * 0.25 as px, SUM(volume) as vol
        FROM price_bars
        WHERE symbol='NQ' AND ts::date >= $1 AND ts::date <= $2
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY ROUND(low / 0.25) * 0.25
      ),
      total AS (SELECT SUM(vol) as t FROM vp),
      poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
      SELECT
        p.poc_px::float as poc,
        (SELECT MAX(px) FROM (
          SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px
        ) s WHERE cv <= (SELECT t * 0.35 FROM total))::float as vah,
        (SELECT MIN(px) FROM (
          SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px
        ) s WHERE cv <= (SELECT t * 0.35 FROM total))::float as val,
        array_agg(json_build_object('price', vp.px, 'vol', vp.vol) ORDER BY vp.px) as histogram
      FROM vp, poc_row p
      GROUP BY p.poc_px
    `, [week_start, weekEndStr]);

    const vp = vpR.rows[0] || {};
    // Normalise histogram for display (pct of max)
    const hist = vp.histogram || [];
    const maxVol = hist.length ? Math.max(...hist.map(h => h.vol)) : 1;
    const histNorm = hist.map(h => ({ price: h.price, pct: Math.round(h.vol / maxVol * 100) }));

    res.json({ bars: barsR.rows, vp: { poc: vp.poc, vah: vp.vah, val: vp.val, histogram: histNorm } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/weekly/history', async (req, res) => {
  try {
    const weeks = parseInt(req.query.weeks) || 12;
    const r = await query(`SELECT id, week_start::text as week_start_str, monday_high, monday_low, normal_week_upper, normal_week_lower, normal_var_upper, normal_var_lower, week_high, week_low, week_close, week_type, direction, acd_number_line_monday, monthly_pivot_bias, notes FROM weekly_ib_structure ORDER BY weekly_ib_structure.week_start DESC LIMIT $1`, [weeks]);
    res.json(r.rows.map(row => ({ ...row, week_start: row.week_start_str })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/weekly/monday', async (req, res) => {
  try {
    const { week_start, monday_high, monday_low, notes } = req.body;
    const mh = parseFloat(monday_high), ml = parseFloat(monday_low);
    const ibRange = mh - ml;
    const nlRow = await query(`SELECT COALESCE(SUM(daily_score),0) as nl30 FROM (SELECT daily_score FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) s`);
    const r = await query(`
      INSERT INTO weekly_ib_structure (week_start, monday_high, monday_low, normal_week_upper, normal_week_lower, normal_var_upper, normal_var_lower, acd_number_line_monday, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (week_start) DO UPDATE SET monday_high=$2, monday_low=$3, normal_week_upper=$4, normal_week_lower=$5, normal_var_upper=$6, normal_var_lower=$7, notes=$9, updated_at=NOW()
      RETURNING *, week_start::text
    `, [week_start, mh, ml, mh+ibRange*0.5, ml-ibRange*0.5, mh+ibRange, ml-ibRange, parseInt(nlRow.rows[0]?.nl30), notes]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/weekly/:id', async (req, res) => {
  try {
    const { week_type, direction, week_close, notes } = req.body;
    const r = await query(`UPDATE weekly_ib_structure SET week_type=$1, direction=$2, week_close=$3, notes=COALESCE($4,notes), updated_at=NOW() WHERE id=$5 RETURNING *, week_start::text`, [week_type, direction, week_close, notes, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 API available at http://localhost:${PORT}/api`);
  console.log(`👀 Sierra Chart watching: ${process.env.SIERRA_WATCH_PATH}`);
  // Auto-backfill ACD history from price bars if the log is empty
  setTimeout(autoBulkBackfillIfEmpty, 3000);
  // Backfill setup events for all historical dates that don't have them yet
  setTimeout(async () => {
    try {
      const dates = await query(`
        SELECT d.trade_date::text as d FROM acd_daily_log d
        WHERE d.or_high IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM acd_setup_events e WHERE e.trade_date = d.trade_date)
        ORDER BY d.trade_date
      `);
      if (dates.rows.length > 0) {
        console.log(`📐 Backfilling setup events for ${dates.rows.length} dates...`);
        for (const { d } of dates.rows) {
          await scanAndSaveSetupEvents(d);
        }
        console.log(`📐 Setup event backfill complete`);
      }
    } catch(e) { console.error('Setup event backfill error:', e.message); }
  }, 10000);
  // Auto-log today's ACD if past session end
  setTimeout(autoComputeTodayACD, 5000);
  // Auto-compute monthly pivot if not set for this month
  setTimeout(async () => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const monthYear = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}`;
      const existing = await query('SELECT id FROM acd_monthly_pivot WHERE month_year=$1', [monthYear]);
      if (existing.rows.length > 0) return; // already set for this month
      // Compute from prior month's bars
      const priorMonth = nowET.getMonth() === 0 ? 12 : nowET.getMonth();
      const priorYear  = nowET.getMonth() === 0 ? nowET.getFullYear()-1 : nowET.getFullYear();
      const priorFrom  = `${priorYear}-${String(priorMonth).padStart(2,'0')}-01`;
      const priorTo    = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}-01`;
      const pr = await query(`
        SELECT MAX(high) as h, MIN(low) as l,
          (SELECT close FROM price_bars WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date
           AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 ORDER BY ts DESC LIMIT 1) as c
        FROM price_bars WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [priorFrom, priorTo]);
      const { h, l, c } = pr.rows[0];
      if (!h || !l || !c) return;
      const piv = (parseFloat(h)+parseFloat(l)+parseFloat(c))/3;
      await query(`INSERT INTO acd_monthly_pivot (month_year,prior_month_high,prior_month_low,prior_month_close,pivot_level,pivot_r1,pivot_s1) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (month_year) DO NOTHING`,
        [monthYear, h, l, c, piv, 2*piv-parseFloat(l), 2*piv-parseFloat(h)]);
      console.log(`📐 Monthly pivot auto-set for ${monthYear}: ${piv.toFixed(2)}`);
    } catch(e) { console.error('Auto pivot error:', e.message); }
  }, 6000);
  // Watch Sierra Chart Images folder for auto-exported chart images
  startChartImageWatcher();
  // Auto-poll bar file every 60 seconds and ingest if updated
  setInterval(async () => {
    try {
      const results = await scanAndIngestNewBarFiles(SIERRA_DATA_DIR);
      const updated = results.filter(r => !r.error && !r.skipped && r.symbol === 'NQ');
      if (updated.length > 0) {
        const totalBars = updated.reduce((s, r) => s + (r.bars_inserted || 0), 0);
        if (totalBars > 0) {
          io.emit('price-sync-progress', { status: 'success', message: `Auto-sync: ${totalBars.toLocaleString()} new bars`, total: 1, done: 1 });
          setTimeout(autoComputeTodayACD, 1000);
        }
      }
    } catch(e) { /* silent */ }
  }, 60000);
  // Pattern memory nightly job — fires at 4:05 PM ET on trading days
  setInterval(async () => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const h = nowET.getHours(), m = nowET.getMinutes(), day = nowET.getDay();
      if (day === 0 || day === 6) return; // skip weekends
      if (h !== 16 || m < 5 || m > 10) return; // only fire between 4:05-4:10 PM ET
      const tradeDate = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      console.log(`[pattern] Nightly job triggered for ${tradeDate}`);
      await runNightlyUpdate(tradeDate, io);
    } catch(e) { console.error('[pattern] Nightly job error:', e.message); }
  }, 60000); // check every minute

  // Auto-backfill weekly ACD if empty
  setTimeout(async () => {
    try {
      const n = await query('SELECT COUNT(*) as n FROM acd_weekly_log');
      if (parseInt(n.rows[0].n) < 5) {
        console.log('📐 Weekly ACD log empty — starting backfill…');
        const weeksRes = await query(`SELECT DISTINCT date_trunc('week', ts::date)::date::text as w FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 ORDER BY w`);
        for (const { w } of weeksRes.rows) {
          try { const r = await computeWeeklyACD(w, 0.33, 5); if (r) await saveWeeklyACD(r); } catch(e) {}
        }
        console.log(`📐 Weekly ACD backfill done: ${weeksRes.rows.length} weeks`);
      }
    } catch(e) { console.error('Weekly ACD startup error:', e.message); }
  }, 8000);
});
