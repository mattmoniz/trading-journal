import express from 'express';
import { query } from '../db.js';
import { getLastState } from '../services/phaseChangeDetector.js';
import { runPhaseChangeBacktest } from '../services/phaseChangeBacktest.js';

const router = express.Router();

// In-memory job tracker (same pattern as ACD backtest)
const jobs = new Map();

// GET /api/phase-change/current-state — polling fallback
router.get('/phase-change/current-state', (req, res) => {
  res.json(getLastState() || { outsideHours: true, conditionsMet: 0 });
});

// GET /api/phase-change/alerts/today
router.get('/phase-change/alerts/today', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const r = await query(`
      SELECT * FROM phase_change_alerts
      WHERE trade_date = $1 ORDER BY alert_time ASC
    `, [todayET]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/phase-change/alerts/:id/override
router.post('/phase-change/alerts/:id/override', async (req, res) => {
  try {
    const { condition, value } = req.body;
    const allowed = ['volume_declining', 'delta_diverging', 'range_compressing', 'profile_stopped'];
    if (!allowed.includes(condition)) return res.status(400).json({ error: 'Invalid condition' });
    const col = `${condition}_override`;
    await query(`UPDATE phase_change_alerts SET ${col}=$1, updated_at=NOW() WHERE id=$2`,
      [value, req.params.id]);
    // Recount effective conditions (using overrides where set)
    const row = await query(`SELECT * FROM phase_change_alerts WHERE id=$1`, [req.params.id]);
    const a = row.rows[0];
    if (a) {
      const eff = (cond, ovr) => ovr != null ? ovr : cond;
      const met = [
        a.near_structural_level,
        eff(a.volume_declining, a.volume_declining_override),
        a.delta_source === 'UNAVAILABLE' ? (a.delta_diverging_override ?? false) : eff(a.delta_diverging, a.delta_diverging_override),
        eff(a.range_compressing, a.range_compressing_override),
        eff(a.profile_stopped, a.profile_stopped_override),
      ].filter(Boolean).length;
      await query(`UPDATE phase_change_alerts SET conditions_met=$1, updated_at=NOW() WHERE id=$2`, [met, a.id]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/phase-change/alerts/:id/acknowledge
router.put('/phase-change/alerts/:id/acknowledge', async (req, res) => {
  try {
    await query(`UPDATE phase_change_alerts SET alert_acknowledged=true, acknowledged_at=NOW(), updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/phase-change/alerts/:id/outcome
router.put('/phase-change/alerts/:id/outcome', async (req, res) => {
  try {
    const { outcome15min, outcome30min, outcome60min, didReverse, reversalMagnitude, notes } = req.body;
    await query(`
      UPDATE phase_change_alerts SET
        outcome_15min=$1, outcome_30min=$2, outcome_60min=$3,
        did_reverse=$4, reversal_magnitude=$5, notes=$6, updated_at=NOW()
      WHERE id=$7
    `, [outcome15min ?? null, outcome30min ?? null, outcome60min ?? null,
        didReverse ?? null, reversalMagnitude ?? null, notes ?? null, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/phase-change/backtest/run
router.post('/phase-change/backtest/run', async (req, res) => {
  try {
    const params = {
      proximityPoints: parseInt(req.body.proximityPoints) || 20,
      minConditions: parseInt(req.body.minConditions) || 3,
      volumeLookback: parseInt(req.body.volumeLookback) || 3,
      deltaLookback: parseInt(req.body.deltaLookback) || 5,
      rangeLookback: parseInt(req.body.rangeLookback) || 3,
      profileLookback: parseInt(req.body.profileLookback) || 10,
      forwardWindowMinutes: parseInt(req.body.forwardWindowMinutes) || 30,
      reversalThresholdPoints: parseInt(req.body.reversalThresholdPoints) || 15,
      startDate: req.body.startDate || null,
      endDate: req.body.endDate || null,
    };

    const jobId = `pcbt-${Date.now()}`;
    jobs.set(jobId, { status: 'running', progress: 0, startedAt: Date.now() });

    // Run async — never block
    runPhaseChangeBacktest(params, (progress) => {
      const j = jobs.get(jobId);
      if (j) j.progress = progress;
    }).then(result => {
      jobs.set(jobId, { status: 'complete', progress: 100, result });
    }).catch(err => {
      jobs.set(jobId, { status: 'error', error: err.message });
    });

    res.json({ jobId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/phase-change/backtest/status/:jobId
router.get('/phase-change/backtest/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const elapsed = Math.round((Date.now() - (job.startedAt || Date.now())) / 1000);
  res.json({ status: job.status, progress: job.progress, estimatedSeconds: elapsed });
});

// GET /api/phase-change/backtest/results
router.get('/phase-change/backtest/results', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM phase_change_backtest_results ORDER BY run_date DESC LIMIT 1`);
    res.json(r.rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/phase-change/forward-test — logged alerts with outcomes vs backtest
router.get('/phase-change/forward-test', async (req, res) => {
  try {
    const alerts = await query(`
      SELECT conditions_met, level_type, did_reverse, reversal_magnitude, outcome_30min
      FROM phase_change_alerts
      WHERE did_reverse IS NOT NULL
      ORDER BY trade_date DESC
    `);
    const rows = alerts.rows;
    if (rows.length < 10) return res.json({ insufficient: true, count: rows.length });

    const total = rows.length;
    const reversed = rows.filter(r => r.did_reverse).length;
    const liveRate = reversed / total;

    // Get backtest prediction at modal condition count
    const modalCount = Math.round(rows.reduce((s, r) => s + (r.conditions_met || 3), 0) / total);
    const bt = await query(`SELECT * FROM phase_change_backtest_results ORDER BY run_date DESC LIMIT 1`);
    let btRate = null;
    if (bt.rows[0]) {
      if (modalCount === 3) btRate = parseFloat(bt.rows[0].reversal_rate_3);
      else if (modalCount === 4) btRate = parseFloat(bt.rows[0].reversal_rate_4);
      else if (modalCount === 5) btRate = parseFloat(bt.rows[0].reversal_rate_5);
    }

    const diff = btRate != null ? Math.abs(liveRate - btRate) : null;
    const status = diff == null ? 'no_backtest'
      : diff <= 0.10 ? 'within_variance'
      : 'outside_variance';

    res.json({
      liveAlerts: total, liveReversalRate: liveRate,
      btPredictedRate: btRate, modalConditionCount: modalCount, status,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
