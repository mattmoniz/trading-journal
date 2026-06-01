import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// POST /api/rule-overrides — log a stand-aside override
router.post('/rule-overrides', async (req, res) => {
  try {
    const { rule_violated, confluence_score } = req.body;
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const nowUTC = new Date();

    await query(`
      INSERT INTO rule_overrides (override_date, override_time, rule_violated, confluence_score)
      VALUES ($1, $2, $3, $4)
    `, [todayET, nowUTC, rule_violated || 'STAND_ASIDE_CONFLUENCE', confluence_score ?? null]);

    res.json({ ok: true, date: todayET });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/rule-overrides — list all overrides (most recent first)
router.get('/rule-overrides', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 90;
    const result = await query(`
      SELECT id, override_date::text, override_time, rule_violated,
        confluence_score, session_outcome, created_at
      FROM rule_overrides
      ORDER BY override_date DESC, override_time DESC
      LIMIT $1
    `, [limit]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
