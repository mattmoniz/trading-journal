import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// GET /api/calendar/coaching/:date
router.get('/calendar/coaching/:date', async (req, res) => {
  try {
    const { date } = req.params;
    // daily_coaching table may not exist yet — return null gracefully
    const result = await query(
      `SELECT coaching_text, coaching_read, created_at
       FROM daily_coaching WHERE session_date = $1 LIMIT 1`,
      [date]
    ).catch(() => ({ rows: [] }));
    const row = result.rows[0] || null;
    res.json({ coaching: row || null });
  } catch (e) {
    res.json({ coaching: null });
  }
});

// PATCH /api/calendar/coaching/:date/read
router.patch('/calendar/coaching/:date/read', async (req, res) => {
  try {
    const { date } = req.params;
    await query(`UPDATE daily_coaching SET coaching_read = true WHERE session_date = $1`, [date]).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// GET /api/calendar/weekly/:weekStart
router.get('/calendar/weekly/:weekStart', async (req, res) => {
  try {
    const { weekStart } = req.params;
    // weekly_assessments table may not exist yet — return null gracefully
    // Use range match: any week_start whose 7-day span contains the requested date
    const result = await query(
      `SELECT process_grade, assessment_text, created_at
       FROM weekly_assessments
       WHERE $1::date BETWEEN week_start AND week_start + INTERVAL '6 days'
       ORDER BY week_start DESC LIMIT 1`,
      [weekStart]
    ).catch(() => ({ rows: [] }));
    const row = result.rows[0] || null;
    res.json({ assessment: row || null });
  } catch (e) {
    res.json({ assessment: null });
  }
});

export default router;
