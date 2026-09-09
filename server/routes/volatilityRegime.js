// Standalone volatility-regime route — see server/services/volatilityRegime.js's header for
// why this is deliberately its own file/module, not folded into setups.js or acd.js.
import express from 'express';
import { getLatestVolRegime, getVolRegimeHistory } from '../services/volatilityRegime.js';

const router = express.Router();

// GET /api/volatility/regime — the latest GARCH(1,1) forward-looking volatility reading.
// Informational only; not consumed by any live setup-detection or sizing code.
router.get('/volatility/regime', async (req, res) => {
  try {
    const regime = await getLatestVolRegime();
    res.json({ regime });
  } catch (e) {
    console.error('[volatility/regime]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/volatility/regime/history — the walk-forward daily scale series, for quick-check's
// tap-to-expand chart. `days` is optional (default 180, capped server-side by
// getVolRegimeHistory's own LIMIT regardless of what's passed).
router.get('/volatility/regime/history', async (req, res) => {
  try {
    const days = Math.min(400, Math.max(1, parseInt(req.query.days, 10) || 180));
    const [history, latest] = await Promise.all([getVolRegimeHistory(days), getLatestVolRegime()]);
    res.json({ history, band: latest?.band || null });
  } catch (e) {
    console.error('[volatility/regime/history]', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
