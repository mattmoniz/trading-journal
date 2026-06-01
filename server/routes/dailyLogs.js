import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// Get or create daily log for a specific date
router.get('/daily-logs/:date', async (req, res) => {
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
router.put('/daily-logs/:date', async (req, res) => {
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
router.get('/daily-logs', async (req, res) => {
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

export default router;
