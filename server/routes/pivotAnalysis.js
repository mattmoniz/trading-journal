// Live cross-session pivot/confluence route — see server/services/pivotConfluenceAnalysis.js's
// header for the backing research (2026-09-09) and why this is informational-only.
import express from 'express';
import { getRecentContinuousBars, analyzeSupportResistance } from '../services/pivotConfluenceAnalysis.js';
import { getSessionVolumeElevation } from '../services/sessionVolumeMonitor.js';

const router = express.Router();

// GET /api/pivots/session-volume — is the CURRENT session (RTH or Globex), taken as a
// whole from its own open through now, running hotter or quieter than normal for this
// time of year. See sessionVolumeMonitor.js's header for how this differs from the
// per-bar touchVolZ/breakVolZ in the pivot analysis below.
router.get('/pivots/session-volume', async (req, res) => {
  try {
    const elevation = await getSessionVolumeElevation();
    res.json({ elevation });
  } catch (e) {
    console.error('[pivots/session-volume]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/pivots/live-analysis — current resistance (last confirmed swing high) and
// support (last confirmed swing low), tracked independently, cross-session (RTH+Globex),
// each with its volume signature, confluence count, and whether it's already been broken.
// If the most recent pivot on a side has been pushed through, `resistance`/`support`
// automatically cascades to the next-older one that hasn't -- the full recent history is
// in `resistanceStack`/`supportStack` (most-recent-first) if you want to see what broke.
router.get('/pivots/live-analysis', async (req, res) => {
  try {
    const bars = await getRecentContinuousBars();
    const { resistance, support, resistanceStack, supportStack, sessionVolume } = await analyzeSupportResistance(bars, { swingWidth: 5 });
    if (!resistance && !support) return res.json({ resistance: null, support: null, sessionVolume, note: 'Not enough bars yet to confirm a pivot.' });
    res.json({ resistance, support, resistanceStack, supportStack, sessionVolume });
  } catch (e) {
    console.error('[pivots/live-analysis]', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
