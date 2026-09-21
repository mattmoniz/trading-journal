// Standalone live "volume piling on" gauge route -- see
// server/services/volumePileGauge.js's header for why this is its own file, not folded into
// acd.js/setups.js (isolate non-trading/informational features convention).
import express from 'express';
import { getLiveVolumePileReading } from '../services/volumePileGauge.js';

const router = express.Router();

// GET /api/globex/volume-pile -- live descriptive read of whether recent volume is running
// above or below its own last-hour baseline. Purely informational, never gates or sizes any
// real trade -- see the service file's header for the honest research caveat this reading
// deliberately does NOT claim (a live volume spike alone does not predict continuation).
router.get('/globex/volume-pile', async (req, res) => {
  try {
    const state = await getLiveVolumePileReading();
    res.json(state);
  } catch (e) {
    console.error('[globex/volume-pile]', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
