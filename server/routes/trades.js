import express from 'express';
import { query } from '../db.js';
import { cacheGet, cacheSet, cacheDelete } from '../lib/cache.js';

// /api/trades (unbounded "All Trades" list) is genuinely expensive: 40k+ rows, a
// disk-spilling GROUP BY/ORDER BY under default work_mem, and CPU-bound JS-side
// JSON serialization of the whole result — measured 2026-07-15 at ~5s per request,
// the dominant cost being server-side work, not network transfer (gzip alone only
// cut 5.0s->4.3s despite a 51MB->2.6MB payload drop). The data only actually
// changes on a trade sync/create/update/delete — cached here and invalidated
// explicitly on all of those, with a 10min TTL as a backstop in case an invalidation
// point is ever missed. See docs/OPEN_THREADS.md. (screenshot-upload dropped from
// this list 2026-07-16 -- that invalidation point no longer exists, see below;
// fs/path/fileURLToPath/multer imports removed the same day, only ever used by the
// now-deleted screenshot-upload routes.)
const ALL_TRADES_CACHE_KEY = 'all-trades-list';
const ALL_TRADES_CACHE_TTL = 10 * 60 * 1000;

const router = express.Router();

// ==================== TRADES ROUTES ====================

// Get trades for a specific date
router.get('/trades/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const result = await query(`
      SELECT t.*,
             NULL::json[] as screenshots
      FROM trades t
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
    // Cache the pre-serialized JSON string, not just the JS array — res.json() re-runs
    // JSON.stringify on every call regardless of whether the underlying data is cached,
    // and for a 40k-row/51MB payload that stringify cost alone is ~1s. Sending the
    // string directly skips it on every cache hit after the first.
    const cached = cacheGet(ALL_TRADES_CACHE_KEY);
    if (cached) { res.type('application/json'); return res.send(cached); }
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
        NULL::json[] as screenshots
      FROM trades t
      WHERE t.exit_time IS NOT NULL
      GROUP BY t.id
      ORDER BY t.entry_time DESC
    `);
    const json = JSON.stringify(result.rows);
    cacheSet(ALL_TRADES_CACHE_KEY, json, ALL_TRADES_CACHE_TTL);
    res.type('application/json');
    res.send(json);
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

    cacheDelete(ALL_TRADES_CACHE_KEY);
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

    cacheDelete(ALL_TRADES_CACHE_KEY);
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
    cacheDelete(ALL_TRADES_CACHE_KEY);
    res.json({ message: 'Trade deleted successfully' });
  } catch (error) {
    console.error('Error deleting trade:', error);
    res.status(500).json({ error: 'Failed to delete trade' });
  }
});

// Screenshot upload routes + trade_screenshots table removed 2026-07-16 (dead-ends
// audit): zero UI ever called POST /trades/:tradeId/screenshots (no upload button
// anywhere), table was genuinely empty (0 rows, verified before dropping -- no backup
// needed). The two GET /trades queries above kept their `screenshots` field in the
// response (now always NULL) rather than removing it, in case anything downstream
// still reads it defensively. git history has the multer pipeline if a real
// attach-a-chart-screenshot-to-a-trade feature is ever built with a real UI.

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
