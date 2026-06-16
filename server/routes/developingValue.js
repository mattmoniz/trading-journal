// Developing-value tracker API — descriptive only, single shared source
// (server/services/developingValueService.js -> developing_value_log table).
// Consumed by morning prep, afternoon review, and weekly review.

import express from 'express';
import { getDevelopingValueContext } from '../services/developingValueService.js';

const router = express.Router();

// GET /api/developing-value/context?date=YYYY-MM-DD&windows=5,10,20
router.get('/developing-value/context', async (req, res) => {
  try {
    const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const windows = (req.query.windows || '5,10,20').split(',').map(n => parseInt(n.trim())).filter(Boolean);
    const ctx = await getDevelopingValueContext(date, windows);
    res.json(ctx);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
