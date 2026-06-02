import express from 'express';
import { computeCase } from '../services/caseEngine.js';

const router = express.Router();

// GET /api/case?date=YYYY-MM-DD&asOf=HH:MM
router.get('/case', async (req, res) => {
  const { date, asOf } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });
  }
  try {
    const result = await computeCase(date, asOf || null);
    res.json(result);
  } catch (err) {
    console.error('[/api/case]', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

export default router;
