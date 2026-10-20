// GET /api/day-type/now — informational day-type read (balance-like / middle / expansion-like). See server/services/dayTypeNow.js.
import express from 'express';
import { getDayTypeNow } from '../services/dayTypeNow.js';
import { microCache } from '../lib/microCache.js';
const router = express.Router();
router.get('/day-type/now', microCache(15000), async (req, res) => {
  try { res.json({ dayType: await getDayTypeNow() }); }
  catch (e) { console.error('[day-type/now]', e.message); res.status(500).json({ error: e.message }); }
});
export default router;
