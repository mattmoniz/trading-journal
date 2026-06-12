import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// Single source of truth for cooldown duration — change here to adjust app-wide
export const COOLDOWN_MINUTES = 15;

// GET /api/cooldown/status — returns the most recent cooldown if it's still
// active (counting down) or finished-but-not-yet-acknowledged (awaiting dismissal)
router.get('/cooldown/status', async (req, res) => {
  try {
    const r = await query(`
      SELECT id, started_at, end_time, dismissed_at
      FROM post_loss_cooldowns
      WHERE dismissed_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const row = r.rows[0];
    if (!row) return res.json({ active: false, awaitingDismissal: false });

    const endMs = new Date(row.end_time).getTime();
    const now = Date.now();
    if (now < endMs) {
      return res.json({
        active: true,
        awaitingDismissal: false,
        id: row.id,
        endTime: row.end_time,
        remainingMs: endMs - now,
      });
    }
    return res.json({
      active: false,
      awaitingDismissal: true,
      id: row.id,
      endTime: row.end_time,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cooldown/start — begins a new cooldown ending COOLDOWN_MINUTES from now
router.post('/cooldown/start', async (req, res) => {
  try {
    const r = await query(`
      INSERT INTO post_loss_cooldowns (started_at, end_time)
      VALUES (NOW(), NOW() + ($1 || ' minutes')::interval)
      RETURNING id, started_at, end_time
    `, [COOLDOWN_MINUTES]);
    const row = r.rows[0];
    res.json({
      active: true,
      awaitingDismissal: false,
      id: row.id,
      endTime: row.end_time,
      remainingMs: new Date(row.end_time).getTime() - Date.now(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cooldown/:id/dismiss — acknowledges the re-entry prompt, clearing the cooldown
router.post('/cooldown/:id/dismiss', async (req, res) => {
  try {
    await query(`UPDATE post_loss_cooldowns SET dismissed_at = NOW() WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cooldown/decision-stats — live behavioral stats for the post-loss decision panel.
// Queries all-time data (no date filter) — these are structural truths, not regime metrics.
router.get('/cooldown/decision-stats', async (req, res) => {
  try {
    const parsePnl = `replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric`;
    const epCond = `
      custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
      AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
    `;

    // Post-loss vs post-win win rates — immediate next FILL after each fill result,
    // per (log_date, account). Fill-level captures the actual revenge-trade spiral:
    // the specific trade the cooldown button is designed to prevent.
    const seqR = await query(`
      WITH fills AS (
        SELECT log_date, entry_time, exit_time, pnl,
          custom_fields->>'account' as account
        FROM trades
        WHERE exit_time IS NOT NULL AND entry_time IS NOT NULL AND pnl IS NOT NULL
      ),
      gapped AS (
        SELECT pnl,
          LAG(pnl) OVER (PARTITION BY log_date, account ORDER BY entry_time) as prev_pnl
        FROM fills
      )
      SELECT
        CASE WHEN prev_pnl < 0 THEN 'after_loss' WHEN prev_pnl > 0 THEN 'after_win' END as context,
        COUNT(*) as cnt,
        ROUND(AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_pct
      FROM gapped
      WHERE prev_pnl IS NOT NULL AND prev_pnl != 0
      GROUP BY context
    `);

    // Sessions taken while already in a drawdown on the day (running P&L before session < 0)
    const wdR = await query(`
      WITH ep AS (
        SELECT log_date, exit_time, SUM(${parsePnl}) as pnl
        FROM trades WHERE ${epCond}
        GROUP BY log_date, exit_time
      ),
      with_running AS (
        SELECT log_date, exit_time, pnl,
          COALESCE(SUM(pnl) OVER (
            PARTITION BY log_date ORDER BY exit_time
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0) as running_before
        FROM ep
      )
      SELECT
        COUNT(*) as total_while_down,
        COUNT(CASE WHEN pnl < 0 THEN 1 END) as count_worse,
        ROUND(COUNT(CASE WHEN pnl < 0 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 1) as pct_worse,
        ROUND(AVG(CASE WHEN pnl < 0 THEN pnl END)::numeric, 0) as avg_loss_when_worse
      FROM with_running
      WHERE running_before < 0
    `);

    const afterLoss = seqR.rows.find(r => r.context === 'after_loss');
    const afterWin  = seqR.rows.find(r => r.context === 'after_win');
    const wd = wdR.rows[0];

    res.json({
      afterLossWinPct:             afterLoss ? parseFloat(afterLoss.win_pct) : null,
      afterLossCount:              afterLoss ? parseInt(afterLoss.cnt)        : 0,
      afterWinWinPct:              afterWin  ? parseFloat(afterWin.win_pct)  : null,
      afterWinCount:               afterWin  ? parseInt(afterWin.cnt)         : 0,
      continueWhileDownPctWorse:   wd ? parseFloat(wd.pct_worse)             : null,
      continueWhileDownAvgLoss:    wd ? parseFloat(wd.avg_loss_when_worse)   : null,
      continueWhileDownTotal:      wd ? parseInt(wd.total_while_down)         : 0,
      // Static: from 2026-06-08 session-replay backtest — simulated skipping all sessions
      // entered within 15 min of a same-day loss. To wire live: implement a session-replay
      // query that applies the 15-min lockout rule and computes the hypothetical total P&L delta.
      cooldownCounterfactualPnl: 225000,
    });
  } catch (err) {
    console.error('Decision stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
