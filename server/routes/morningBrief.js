import express from 'express';
import { query } from '../db.js';

const router = express.Router();

router.get('/dates', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT brief_date::text, created_at FROM morning_briefs ORDER BY brief_date DESC LIMIT 90`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:date?', async (req, res) => {
  try {
    let rows;
    if (req.params.date) {
      ({ rows } = await query(
        `SELECT brief_date::text, brief_text, structural_data, created_at
         FROM morning_briefs WHERE brief_date = $1`,
        [req.params.date]
      ));
    } else {
      ({ rows } = await query(
        `SELECT brief_date::text, brief_text, structural_data, created_at
         FROM morning_briefs ORDER BY brief_date DESC LIMIT 1`
      ));
    }
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
