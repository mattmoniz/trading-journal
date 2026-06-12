import express from 'express';
import { query } from '../db.js';
const router = express.Router();

// Pre-market walkthrough — guided 4-layer reasoning + committed plan, persisted per trade date.
router.get('/premarket-walkthrough/:date', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM premarket_walkthroughs WHERE trade_date = $1`, [req.params.date]);
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/premarket-walkthrough/:date', async (req, res) => {
  try {
    const {
      regime, overnight_read, open_notes, signals_notes,
      layer1_lean, layer2_lean, layer3_lean, layer4_lean, committed_plan,
    } = req.body || {};
    const r = await query(`
      INSERT INTO premarket_walkthroughs
        (trade_date, regime, overnight_read, open_notes, signals_notes, layer1_lean, layer2_lean, layer3_lean, layer4_lean, committed_plan, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (trade_date) DO UPDATE SET
        regime = EXCLUDED.regime,
        overnight_read = EXCLUDED.overnight_read,
        open_notes = EXCLUDED.open_notes,
        signals_notes = EXCLUDED.signals_notes,
        layer1_lean = EXCLUDED.layer1_lean,
        layer2_lean = EXCLUDED.layer2_lean,
        layer3_lean = EXCLUDED.layer3_lean,
        layer4_lean = EXCLUDED.layer4_lean,
        committed_plan = EXCLUDED.committed_plan,
        updated_at = NOW()
      RETURNING *
    `, [req.params.date, regime, overnight_read, open_notes, signals_notes, layer1_lean, layer2_lean, layer3_lean, layer4_lean, committed_plan]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
