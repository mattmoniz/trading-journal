// Live pulse-reading route — see server/services/pulseReading.js's header for the backing
// research and why this is informational-only, not a validated signal.
import express from 'express';
import { getLivePulseReading } from '../services/pulseReading.js';

const router = express.Router();

// GET /api/pulse/reading — the current live volume-acceleration state (PICKING_UP/DROPPING_OFF).
router.get('/pulse/reading', async (req, res) => {
  try {
    const pulse = await getLivePulseReading();
    res.json({ pulse });
  } catch (e) {
    console.error('[pulse/reading]', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
