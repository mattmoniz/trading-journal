// Standalone volatility-regime route — see server/services/volatilityRegime.js's header for
// why this is deliberately its own file/module, not folded into setups.js or acd.js.
import express from 'express';
import { getLatestVolRegime } from '../services/volatilityRegime.js';

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

export default router;
