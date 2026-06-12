import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// ==================== DASHBOARD/ANALYTICS ROUTES ====================

// Get overall statistics
router.get('/stats/overview', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

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

      if (cumulative > peak) {
        peak = cumulative;
      }
      const drawdown = peak - cumulative;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }

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
    stats.expectancy = stats.avg_pnl;

    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get top performing symbols
router.get('/stats/top-symbols', async (req, res) => {
  try {
    const { dateFrom, dateTo, account, limit = 5 } = req.query;

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
router.get('/stats/cumulative-pnl', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

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

// POLICY: entry_time and exit_time are stored as ET wall-clock (normalized 2026-06-08).
// Do NOT apply AT TIME ZONE conversion — they are already ET. Double-shifting will corrupt
// time-bucketed displays (By Hour, By DOW, Timing Heatmap). Use EXTRACT directly.

// Get performance by hour of day
router.get('/stats/by-hour', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

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
        EXTRACT(HOUR FROM entry_time) as hour,
        COUNT(*) as trade_count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
        ROUND((SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::decimal / COUNT(*) * 100)::numeric, 2) as win_rate
      FROM trades
      WHERE ${whereClause}
      GROUP BY EXTRACT(HOUR FROM entry_time)
      ORDER BY hour ASC
    `, queryParams);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching hourly stats:', error);
    res.status(500).json({ error: 'Failed to fetch hourly statistics' });
  }
});

// Get performance by day of week
router.get('/stats/by-day-of-week', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

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
        EXTRACT(DOW FROM entry_time) as day_num,
        CASE EXTRACT(DOW FROM entry_time)
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
      GROUP BY EXTRACT(DOW FROM entry_time)
      ORDER BY day_num ASC
    `, queryParams);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching day of week stats:', error);
    res.status(500).json({ error: 'Failed to fetch day of week statistics' });
  }
});

// Get performance by trade duration
router.get('/stats/by-duration', async (req, res) => {
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
router.get('/stats/daily', async (req, res) => {
  try {
    const { days = 30, dateFrom, dateTo, account } = req.query;

    let whereConditions = [];
    const queryParams = [];
    let paramCounter = 1;

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

    let tradeAccountFilter = '';
    let epAccountFilter = '';
    if (account) {
      const accounts = account.split(",").filter(Boolean);
      tradeAccountFilter = `AND t.custom_fields->>'account' = ANY($${paramCounter}::text[])`;
      epAccountFilter = `AND custom_fields->>'account' = ANY($${paramCounter}::text[])`;
      queryParams.push(accounts);
      paramCounter++;
    }

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
router.get('/stats/by-setup', async (req, res) => {
  try {
    const { dateFrom, dateTo, account } = req.query;

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

// ==================== RISK MANAGEMENT ROUTES ====================

// Monte Carlo Risk of Ruin helper
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

// GET /api/risk/q1-winrate
router.get('/risk/q1-winrate', async (req, res) => {
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
router.get('/risk/settings', async (req, res) => {
  try {
    const r = await query('SELECT * FROM risk_settings ORDER BY id LIMIT 1');
    const s = r.rows[0] || {};
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
router.post('/risk/settings', async (req, res) => {
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
router.get('/risk/stats', async (req, res) => {
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
      for (const row of streakR.rows) {
        if (parseFloat(row.pnl) < 0) { curLoss++; maxConsecLosses = Math.max(maxConsecLosses, curLoss); }
        else curLoss = 0;
      }
    }

    res.json({ winRate, avgWin, avgLoss, payoffRatio, totalTrades, grossProfit, grossLoss, profitFactor, ev, currentStreak, maxConsecLosses, periodDays: days });
  } catch(e) { console.error('risk/stats error:', e); res.status(500).json({ error: e.message }); }
});

// GET /api/risk/ruin
router.get('/risk/ruin', async (req, res) => {
  try {
    const { cacheGet, cacheSet } = await import('../lib/cache.js');
    const PORT = process.env.PORT || 3001;
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

// GET /api/risk/ruin/compare
router.get('/risk/ruin/compare', async (req, res) => {
  try {
    const { cacheGet, cacheSet } = await import('../lib/cache.js');
    const PORT = process.env.PORT || 3001;
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

// GET /api/risk/kelly
router.get('/risk/kelly', async (req, res) => {
  try {
    const PORT = process.env.PORT || 3001;
    const statsRes = await fetch(`http://localhost:${PORT}/api/risk/stats?days=${req.query.days || 60}${req.query.accounts ? '&accounts=' + req.query.accounts : ''}`);
    const stats = await statsRes.json();
    const p = stats.winRate;
    const b = stats.payoffRatio;
    const kelly = b > 0 ? (p * b - (1 - p)) / b : 0;
    const halfKelly = kelly / 2;
    res.json({ kelly: Math.max(0, kelly), halfKelly: Math.max(0, halfKelly), winRate: p, payoffRatio: b });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/risk/sizing
router.get('/risk/sizing', async (req, res) => {
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
router.get('/sessions/current', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const session = await query('SELECT * FROM trading_sessions WHERE session_date = $1 ORDER BY id DESC LIMIT 1', [today]);
    const settings = await query('SELECT * FROM risk_settings ORDER BY id LIMIT 1');
    const s = settings.rows[0] || {};

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
      phase, sessionPnl, dailyLimitDollars, pctUsed, limitHit, accountSize, limitPct, minutesToOpen,
      currentTime: nowET.toTimeString().slice(0, 5),
      sessionRecord: session.rows[0] || null,
      sessionClosed: session.rows[0]?.session_closed || false,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sessions/open
router.post('/sessions/open', async (req, res) => {
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
router.post('/sessions/close', async (req, res) => {
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

// GET /api/stats/combo-stats — live level confluence backtest results
router.get('/stats/combo-stats', async (req, res) => {
  try {
    const r = await query(`
      SELECT combo_id, label, category, tier, levels, n, win_count,
        avg_pnl::float, win_rate::float, prox_pts::float,
        session_range_start::text, session_range_end::text,
        TO_CHAR(last_analyzed AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as last_analyzed
      FROM combo_stats ORDER BY tier ASC, win_rate DESC NULLS LAST
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stats/combo-stats/rerun — trigger a fresh backtest
router.post('/stats/combo-stats/rerun', async (req, res) => {
  try {
    const { spawn } = await import('child_process');
    const child = spawn('node', ['scripts/combo_backtest.js'], {
      cwd: process.cwd(), detached: true, stdio: 'ignore',
    });
    child.unref();
    res.json({ ok: true, message: 'Backtest started — check combo_stats in ~2 minutes' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;
