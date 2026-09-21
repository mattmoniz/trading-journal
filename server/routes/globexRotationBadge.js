// Standalone Globex overnight rotation badge route — see
// server/services/globexRotationBadge.js's header for why this is its own file, not folded
// into acd.js/setups.js (isolate non-trading/informational features convention).
import express from 'express';
import { getGlobexRotationBadgeState } from '../services/globexRotationBadge.js';

const router = express.Router();

// GET /api/globex/rotation-badge — current overnight rotation-count read against the latest
// weekly self-calibration. Purely informational, direction-agnostic (predicts RTH range
// magnitude, not which way price moves), never gates or sizes any real trade.
router.get('/globex/rotation-badge', async (req, res) => {
  try {
    const state = await getGlobexRotationBadgeState();
    res.json(state);
  } catch (e) {
    console.error('[globex/rotation-badge]', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
