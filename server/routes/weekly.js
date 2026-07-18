import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';

const REPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../reports');

const router = express.Router();

// GET /api/weekly/assessments — list all weeks with grade summary
router.get('/weekly/assessments', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT week_start::text, week_end::text, process_grade,
        total_pnl, winning_days, losing_days, days_with_trades, created_at
      FROM weekly_assessments ORDER BY week_start DESC LIMIT 52
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/weekly/assessment/:weekStart? — full data for one week
router.get('/weekly/assessment/:weekStart?', async (req, res) => {
  try {
    let rows;
    if (req.params.weekStart) {
      ({ rows } = await query(`
        SELECT week_start::text, week_end::text, process_grade, total_pnl,
          winning_days, losing_days, days_with_trades, assessment_text, report_text, created_at
        FROM weekly_assessments WHERE week_start = $1
      `, [req.params.weekStart]));
    } else {
      ({ rows } = await query(`
        SELECT week_start::text, week_end::text, process_grade, total_pnl,
          winning_days, losing_days, days_with_trades, assessment_text, report_text, created_at
        FROM weekly_assessments ORDER BY week_start DESC LIMIT 1
      `));
    }
    if (!rows.length) return res.json(null);
    const row = rows[0];
    if (!row.report_text) {
      try {
        row.report_text = fs.readFileSync(path.join(REPORTS_DIR, `weekly_${row.week_end}.txt`), 'utf8');
      } catch (_) {}
    }
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
