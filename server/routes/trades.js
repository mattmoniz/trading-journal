import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { query } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Multer for trade screenshots
const uploadsDir = path.join(__dirname, '../uploads');
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

// ==================== TRADES ROUTES ====================

// Get trades for a specific date
router.get('/trades/:date', async (req, res) => {
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

// Fetch all trades at once (for All Trades view) — sierra_data stripped to keep payload small
router.get('/trades', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        t.id, t.log_date, t.entry_time, t.exit_time, t.symbol, t.direction,
        t.quantity, t.entry_price, t.exit_price, t.stop_loss, t.target,
        t.pnl, t.fees, t.setup_type, t.trade_notes, t.mistakes,
        t.emotional_state, t.risk_reward_ratio, t.tags, t.created_at,
        t.acd_signal, t.acd_number_line_at_entry, t.acd_monthly_bias,
        t.custom_fields || jsonb_build_object('sierra_data',
          (t.custom_fields->'sierra_data') - ARRAY[
            'Entry Efficiency','Exit Efficiency','Total Efficiency',
            'Duration','Note','High Price While Open','Low Price While Open',
            'FlatToFlat Max Open Loss (C)','FlatToFlat Max Open Profit (C)',
            'Max Closed Quantity','Close Position Quantity','Commission (C)',
            'Open Position Quantity','Trade Type','Trade Quantity',
            'Symbol','Account','Profit/Loss (C)','Max Open Loss (C)',
            'Entry Price','Exit Price'
          ]
        ) AS custom_fields,
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
router.post('/trades', async (req, res) => {
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
router.put('/trades/:id', async (req, res) => {
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
router.delete('/trades/:id', async (req, res) => {
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
router.post('/trades/:tradeId/screenshots', upload.single('screenshot'), async (req, res) => {
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
router.delete('/screenshots/:id', async (req, res) => {
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

// ==================== ACCOUNTS ROUTE ====================

// Get unique accounts from trades
router.get('/accounts', async (req, res) => {
  try {
    const days = req.query.days !== undefined ? parseInt(req.query.days) : 30;
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

// Get accounts and date for the most recent trading day
router.get('/accounts/last-day', async (req, res) => {
  try {
    const result = await query(`
      SELECT log_date::text as date,
        ARRAY_AGG(DISTINCT custom_fields->>'account' ORDER BY custom_fields->>'account') as accounts
      FROM trades
      WHERE custom_fields->>'account' IS NOT NULL
        AND log_date = (SELECT MAX(log_date) FROM trades WHERE custom_fields->>'account' IS NOT NULL)
      GROUP BY log_date
    `);
    const row = result.rows[0];
    if (!row) return res.json({ date: null, accounts: [] });
    res.json({ date: row.date, accounts: row.accounts.filter(Boolean) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
