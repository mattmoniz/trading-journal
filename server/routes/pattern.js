import express from 'express';
import { query } from '../db.js';
import { runNightlyUpdate, updateSetupMoveStats } from '../services/patternMemoryUpdate.js';

const router = express.Router();

// POST /api/pattern/update/:tradeDate
router.post('/pattern/update/:tradeDate', async (req, res) => {
  try {
    const result = await runNightlyUpdate(req.params.tradeDate, req.app.get('io'));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pattern/update-move-stats/:tradeDate — populate setup_move_stats independently
router.post('/pattern/update-move-stats/:tradeDate', async (req, res) => {
  try {
    await updateSetupMoveStats(req.params.tradeDate);
    res.json({ ok: true, date: req.params.tradeDate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pattern/backfill
router.post('/pattern/backfill', async (req, res) => {
  const { startDate, endDate } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });
  res.json({ ok: true, message: 'Backfill started — check server logs' });
  const io = req.app.get('io');
  (async () => {
    const dates = await query(`
      SELECT DISTINCT log_date::text as d FROM trades
      WHERE log_date >= $1 AND log_date <= $2 ORDER BY d ASC
    `, [startDate, endDate]);
    let processed = 0, skipped = 0, errors = 0;
    for (const { d } of dates.rows) {
      try {
        const r = await runNightlyUpdate(d, io);
        if (r.skipped) skipped++; else if (r.error) errors++; else processed++;
      } catch(e) { errors++; console.error(`[backfill] ${d}:`, e.message); }
    }
    console.log(`[backfill] Done: ${processed} processed, ${skipped} skipped, ${errors} errors`);
    io.emit('pattern-memory-updated', { backfill: true, processed, skipped, errors });
  })();
});

// GET /api/pattern/today-combination?days=30|60|90|0
router.get('/pattern/today-combination', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const days = parseInt(req.query.days ?? '30');

    const nlQ = await query(`
      SELECT SUM(daily_score) FILTER (WHERE trade_date > CURRENT_DATE-30 AND trade_date <= CURRENT_DATE) as nl30
      FROM acd_daily_log WHERE daily_score IS NOT NULL`);
    const nl30 = parseInt(nlQ.rows[0]?.nl30) || 0;
    const arQ  = await query(`SELECT opening_call_type, a_signal_override FROM auction_reads WHERE trade_date=$1`, [todayET]);
    const ar   = arQ.rows[0] || {};
    const aOvr = ar.a_signal_override;
    const aQuality = aOvr?.endsWith('_STRONG') ? 'STRONG' : aOvr?.endsWith('_WEAK') ? 'WEAK' : aOvr?.endsWith('_FAILED') ? 'FAILED' : 'NO_SIGNAL';
    const openingCall = ar.opening_call_type || 'NO_SIGNAL';
    const nl30Bucket = nl30 > 15 ? 'STRONG_BULL' : nl30 > 9 ? 'BULL' : nl30 < -15 ? 'STRONG_BEAR' : nl30 < -9 ? 'BEAR' : 'RANGING';

    const lastLogQ = await query(`SELECT confluence_score_peak, confluence_score_pre, structural_state FROM daily_performance_log ORDER BY trade_date DESC LIMIT 1`);
    const lastScore = lastLogQ.rows[0]?.confluence_score_peak || lastLogQ.rows[0]?.confluence_score_pre;
    const confBucket = lastScore >= 10 ? 'HIGH' : lastScore >= 7 ? 'MODERATE' : lastScore >= 4 ? 'LOW' : 'WEAK';
    const structState = lastLogQ.rows[0]?.structural_state || 'BRACKET';
    const counterTrend = (nl30 > 9 && aQuality !== 'NO_SIGNAL' && aOvr?.startsWith('A_DOWN')) ||
                         (nl30 < -9 && aQuality !== 'NO_SIGNAL' && aOvr?.startsWith('A_UP'));
    const context = { structState, nl30Bucket, openingCall, aQuality, confBucket, counterTrend };

    if (days === 30) {
      const cmQ = await query(`
        SELECT *, win_rate_last30 as win_rate, avg_pnl_last30 as avg_pnl, occurrences_last30 as occurrences,
               t1_hit_rate, win_rate_trend, sufficient_data, first_seen::text, last_seen::text,
               occurrences as total_occurrences, win_rate as win_rate_alltime, avg_pnl as avg_pnl_alltime
        FROM condition_memory
        WHERE structural_state=$1 AND nl30_bucket=$2 AND opening_call=$3
          AND a_signal_quality=$4 AND confluence_bucket=$5 AND counter_trend=$6
      `, [structState, nl30Bucket, openingCall, aQuality, confBucket, counterTrend]);
      const row = cmQ.rows[0];
      if (!row) return res.json({ match: null, context, days });
      return res.json({ match: { ...row, occurrences: row.occurrences || 0, sufficient_data: (row.occurrences || 0) >= 10 }, context, days });
    }

    const dateFilter = days > 0 ? `AND trade_date >= CURRENT_DATE - ${days}` : '';
    const wQ = await query(`
      SELECT COUNT(*) as occurrences,
        AVG(CASE WHEN session_pnl > 0 THEN 1.0 ELSE 0.0 END) as win_rate,
        AVG(session_pnl) as avg_pnl,
        AVG(CASE WHEN t1_hit THEN 1.0 ELSE 0.0 END) as t1_hit_rate,
        MIN(trade_date)::text as first_seen, MAX(trade_date)::text as last_seen
      FROM daily_performance_log
      WHERE structural_state = $1
        AND (CASE WHEN nl30_at_open > 15 THEN 'STRONG_BULL' WHEN nl30_at_open > 9 THEN 'BULL'
             WHEN nl30_at_open < -15 THEN 'STRONG_BEAR' WHEN nl30_at_open < -9 THEN 'BEAR' ELSE 'RANGING' END) = $2
        AND COALESCE(opening_call, 'NO_SIGNAL') = $3
        AND COALESCE(a_signal_quality, 'NO_SIGNAL') = $4
        AND COALESCE(counter_trend, false) = $5
        ${dateFilter}
    `, [structState, nl30Bucket, openingCall, aQuality, counterTrend]);

    const w = wQ.rows[0];
    const occurrences = parseInt(w?.occurrences) || 0;
    if (occurrences === 0) return res.json({ match: null, context, days });

    const cmQ = await query(`
      SELECT win_rate_trend, sufficient_data, first_seen::text, last_seen::text, occurrences as total_occurrences
      FROM condition_memory
      WHERE structural_state=$1 AND nl30_bucket=$2 AND opening_call=$3
        AND a_signal_quality=$4 AND confluence_bucket=$5 AND counter_trend=$6
    `, [structState, nl30Bucket, openingCall, aQuality, confBucket, counterTrend]);
    const cm = cmQ.rows[0] || {};

    res.json({ match: {
      occurrences,
      win_rate: w.win_rate != null ? parseFloat(w.win_rate) : null,
      avg_pnl:  w.avg_pnl  != null ? parseFloat(w.avg_pnl)  : null,
      t1_hit_rate: w.t1_hit_rate != null ? parseFloat(w.t1_hit_rate) : null,
      win_rate_trend: cm.win_rate_trend || null,
      sufficient_data: occurrences >= 10,
      first_seen: w.first_seen, last_seen: w.last_seen,
      total_occurrences: cm.total_occurrences || occurrences,
    }, context, days });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/pattern/stats', async (req, res) => {
  try {
    const days = parseInt(req.query.lookback) || 30;
    const r = await query(`
      SELECT * FROM pattern_stats
      WHERE lookback_days=$1 AND calculated_date=(SELECT MAX(calculated_date) FROM pattern_stats WHERE lookback_days=$1)
      ORDER BY degrading_alert DESC, structural_state
    `, [days]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/pattern/daily-log', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const r = await query(`SELECT * FROM daily_performance_log WHERE trade_date >= CURRENT_DATE-$1 ORDER BY trade_date DESC`, [days]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/pattern/combinations', async (req, res) => {
  try {
    const min = parseInt(req.query.minOccurrences) || 5;
    const r = await query(`SELECT * FROM condition_memory WHERE occurrences >= $1 ORDER BY avg_pnl DESC NULLS LAST`, [min]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;
