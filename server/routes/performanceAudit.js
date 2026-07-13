import express from 'express';
import { query } from '../db.js';

const router = express.Router();

function normalize(q) {
  return q.trim().toUpperCase().replace(/[\s\-]+/g, '_');
}

// GET /api/performance-audit/search?q=CAM_R2
router.get('/performance-audit/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ results: [] });

  const pattern = `%${normalize(q)}%`;

  try {
    const [statusRes, stopRes] = await Promise.all([
      query(`
        WITH ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY signal_name ORDER BY run_date DESC, id DESC) AS rn
          FROM performance_audit
          WHERE signal_type = 'SETUP_STATUS' AND signal_name ILIKE $1
        )
        SELECT signal_name, win_rate, sample_size, ev_per_trade, recommendation, notes, run_date
        FROM ranked WHERE rn = 1
        ORDER BY signal_name LIMIT 30
      `, [pattern]),
      query(`
        WITH ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY signal_name ORDER BY run_date DESC, id DESC) AS rn
          FROM performance_audit
          WHERE signal_type = 'OPTIMAL_STOP' AND signal_name ILIKE $1
        )
        SELECT signal_name, win_rate, sample_size, ev_per_trade,
               optimal_stop, optimal_target, p50_mfe, p75_mfe, p50_mae, p75_mae,
               current_stop, current_target, stop_blowthrough_pct, run_date
        FROM ranked WHERE rn = 1
        ORDER BY signal_name LIMIT 30
      `, [pattern]),
    ]);

    const stopMap = {};
    for (const r of stopRes.rows) stopMap[r.signal_name] = r;

    let results = statusRes.rows.map(s => ({
      signal_name: s.signal_name,
      win_rate: s.win_rate,
      sample_size: s.sample_size,
      ev_per_trade: s.ev_per_trade,
      recommendation: s.recommendation,
      notes: s.notes,
      run_date: s.run_date,
      ...(stopMap[s.signal_name] && {
        optimal_stop: stopMap[s.signal_name].optimal_stop,
        optimal_target: stopMap[s.signal_name].optimal_target,
        p50_mfe: stopMap[s.signal_name].p50_mfe,
        p75_mfe: stopMap[s.signal_name].p75_mfe,
        p50_mae: stopMap[s.signal_name].p50_mae,
        p75_mae: stopMap[s.signal_name].p75_mae,
        current_stop: stopMap[s.signal_name].current_stop,
        current_target: stopMap[s.signal_name].current_target,
        stop_blowthrough_pct: stopMap[s.signal_name].stop_blowthrough_pct,
      }),
    }));

    // Fallback: also return raw OPTIMAL_STOP rows not covered by SETUP_STATUS
    if (results.length === 0 && stopRes.rows.length > 0) {
      results = stopRes.rows.map(r => ({ ...r, source: 'OPTIMAL_STOP' }));
    }

    // Final fallback: LEVEL_FADE_AUDIT
    if (results.length === 0) {
      const lr = await query(`
        WITH ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY signal_name ORDER BY run_date DESC, id DESC) AS rn
          FROM performance_audit
          WHERE signal_type = 'LEVEL_FADE_AUDIT' AND signal_name ILIKE $1
        )
        SELECT signal_name, win_rate, sample_size, ev_per_trade,
               optimal_stop, optimal_target, p50_mfe, p50_mae, recommendation, run_date
        FROM ranked WHERE rn = 1
        ORDER BY signal_name LIMIT 10
      `, [pattern]);
      results = lr.rows.map(r => ({ ...r, source: 'LEVEL_FADE_AUDIT' }));
    }

    res.json({ results });
  } catch (err) {
    console.error('[performance-audit/search]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
