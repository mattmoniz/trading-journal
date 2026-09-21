// ML meta-labeling silo -- comparison API. Deliberately its own route file, not folded into
// acd.js/setups.js, per this codebase's "isolate non-trading features" convention (this is
// a research/observation layer, not a live trading mechanism -- see mlSiloService.js's own
// header for the full "why isolated" reasoning). Read-only: every endpoint here only ever
// reads ml_models/ml_verdicts/active_setups, never writes.
import express from 'express';
import { getLatestModel, getComparison, getCumulativePnlSeries, getTradeList, getRangeTrades, getStepTrailComparison } from '../services/mlSiloService.js';

const router = express.Router();

// GET /api/ml-silo/summary?sample=test|train|all — the headline comparison: latest model
// info + all-trades vs ML-approved P&L/WR, plus the cumulative equity-curve series.
// Defaults to 'test' (out-of-sample only) -- the only honest comparison; 'train'/'all' are
// an explicit opt-in the frontend should clearly label as "in-sample, optimistic" if ever
// shown, matching mlSiloService.js's own documented reasoning.
router.get('/ml-silo/summary', async (req, res) => {
  try {
    const sample = ['test', 'train', 'all'].includes(req.query.sample) ? req.query.sample : 'test';
    const model = await getLatestModel();
    if (!model) return res.json({ model: null, comparison: null, series: [] });

    const [comparison, series] = await Promise.all([
      getComparison(model.model_version, sample),
      getCumulativePnlSeries(model.model_version, sample),
    ]);
    res.json({ model, sample, comparison, series });
  } catch (e) {
    console.error('[ml-silo/summary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ml-silo/trades?sample=test&setupType=X&verdict=TAKE&limit=100&offset=0 — the
// per-trade drill-down ("why did ML gate this one").
router.get('/ml-silo/trades', async (req, res) => {
  try {
    const model = await getLatestModel();
    if (!model) return res.json({ trades: [] });
    const sample = ['test', 'train', 'all'].includes(req.query.sample) ? req.query.sample : 'test';
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const trades = await getTradeList({
      modelVersion: model.model_version, sample,
      setupType: req.query.setupType || null,
      verdict: req.query.verdict || null,
      limit, offset,
    });
    res.json({ trades, modelVersion: model.model_version });
  } catch (e) {
    console.error('[ml-silo/trades]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ml-silo/range-trades?range=today|week|month|year|all&sample=test|train|all —
// added 2026-09-21 (user request: same today/week/month/year/all views as the main
// Performance section, with charts, for the ML silo). Returns raw per-trade rows (like
// /api/setups/range-summary does for the main Performance tab) rather than pre-aggregated
// stats -- the frontend computes wins/losses/net/gross/commission/maxDD/equity-curve itself,
// same pattern as quick-check.html's own computeRangeStats()/renderEquityCurve(), split into
// "all scored" vs "ML-approved" (verdict=TAKE) subsets.
router.get('/ml-silo/range-trades', async (req, res) => {
  try {
    const model = await getLatestModel();
    if (!model) return res.json({ trades: [], rangeLabel: null });
    const sample = ['test', 'train', 'all'].includes(req.query.sample) ? req.query.sample : 'test';
    const range = ['today', 'week', 'month', 'year', 'all'].includes(req.query.range) ? req.query.range : 'today';
    const result = await getRangeTrades({ modelVersion: model.model_version, sample, range });
    res.json({ ...result, modelVersion: model.model_version, sample, range });
  } catch (e) {
    console.error('[ml-silo/range-trades]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ml-silo/step-trail-comparison?sample=test|train|all — "ML gates entry, a
// validated trail mechanism decides how far to let it run" (the coupling step, 2026-09-21).
// Composes two already-isolated, already-PROVISIONAL research mechanisms (this model's
// TAKE verdicts + step_trail_shadow's hypothetical exit) purely for comparison -- never
// live-wired, see getStepTrailComparison()'s own header for the full account.
router.get('/ml-silo/step-trail-comparison', async (req, res) => {
  try {
    const model = await getLatestModel();
    if (!model) return res.json({ comparison: null });
    const sample = ['test', 'train', 'all'].includes(req.query.sample) ? req.query.sample : 'test';
    const comparison = await getStepTrailComparison(model.model_version, sample);
    res.json({ modelVersion: model.model_version, comparison });
  } catch (e) {
    console.error('[ml-silo/step-trail-comparison]', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
