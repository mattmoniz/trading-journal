import express from 'express';
import { query } from '../db.js';
import { cacheGet, cacheSet, latestBarDate } from '../lib/cache.js';

const router = express.Router();

// GET /api/wyckoff/levels
router.get('/wyckoff/levels', async (req, res) => {
  try {
    const r = await query(`SELECT id, level_date::text, price_level, level_type, origin_description, status, spring_occurred, spring_date::text, spring_volume_type, upthrust_occurred, upthrust_date::text, notes, created_at FROM wyckoff_levels WHERE status='ACTIVE' ORDER BY wyckoff_levels.level_date DESC, price_level DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/wyckoff/levels
router.post('/wyckoff/levels', async (req, res) => {
  try {
    const { price_level, level_type, origin_description, notes } = req.body;
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const r = await query(`INSERT INTO wyckoff_levels (level_date, price_level, level_type, origin_description, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *, level_date::text`, [todayET, price_level, level_type, origin_description, notes]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/wyckoff/levels/:id
router.put('/wyckoff/levels/:id', async (req, res) => {
  try {
    const { status, spring_occurred, spring_date, spring_volume_type, upthrust_occurred, upthrust_date, notes } = req.body;
    const r = await query(`UPDATE wyckoff_levels SET status=COALESCE($1,status), spring_occurred=COALESCE($2,spring_occurred), spring_date=COALESCE($3,spring_date), spring_volume_type=COALESCE($4,spring_volume_type), upthrust_occurred=COALESCE($5,upthrust_occurred), upthrust_date=COALESCE($6,upthrust_date), notes=COALESCE($7,notes) WHERE id=$8 RETURNING *, level_date::text`, [status, spring_occurred, spring_date, spring_volume_type, upthrust_occurred, upthrust_date, notes, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/wyckoff/levels/:id
router.delete('/wyckoff/levels/:id', async (req, res) => {
  try {
    await query(`UPDATE wyckoff_levels SET status='ARCHIVED' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/wyckoff/setups/stats
router.get('/wyckoff/setups/stats', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        wyckoff_setup,
        spring_volume_type,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE pnl > 0) as wins,
        ROUND(COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*),0) * 100, 1) as win_rate,
        ROUND(AVG(pnl) FILTER (WHERE pnl > 0)::numeric, 2) as avg_win,
        ROUND(ABS(AVG(pnl)) FILTER (WHERE pnl < 0)::numeric, 2) as avg_loss,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl
      FROM trades
      WHERE wyckoff_setup IS NOT NULL AND pnl IS NOT NULL
      GROUP BY wyckoff_setup, spring_volume_type
      ORDER BY wyckoff_setup
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/wyckoff/effort-result — compute from price_bars
router.get('/wyckoff/effort-result', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const lbd = await latestBarDate();
    const cacheKey = `effort-result-${days}-${lbd}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Get last N trading days with volume and range from price_bars
    const r = await query(`
      WITH daily AS (
        SELECT
          ts::date as session_date,
          MAX(high)::numeric(8,2) as session_high,
          MIN(low)::numeric(8,2) as session_low,
          MAX(high) - MIN(low) as session_range,
          SUM(volume)::bigint as total_volume
        FROM price_bars
        WHERE symbol='NQ'
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY ts::date
        HAVING COUNT(*) > 100
        ORDER BY ts::date DESC
        LIMIT $1
      ),
      stats AS (
        SELECT
          AVG(session_range) as avg_range_30d,
          AVG(total_volume) as avg_volume_30d
        FROM (
          SELECT
            MAX(high) - MIN(low) as session_range,
            SUM(volume) as total_volume
          FROM price_bars
          WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ts::date
          HAVING COUNT(*) > 100
          ORDER BY MAX(ts) DESC
          LIMIT 30
        ) sub
      )
      SELECT
        d.session_date::text,
        d.session_high, d.session_low,
        ROUND(d.session_range::numeric, 1) as session_range,
        d.total_volume,
        ROUND((d.total_volume / NULLIF(s.avg_volume_30d, 0))::numeric, 2) as volume_ratio,
        ROUND((d.session_range / NULLIF(s.avg_range_30d, 0))::numeric, 2) as range_ratio,
        CASE
          WHEN (d.total_volume / NULLIF(s.avg_volume_30d, 0)) > 1.5
           AND (d.session_range / NULLIF(s.avg_range_30d, 0)) < 0.7 THEN 'ABSORPTION'
          WHEN (d.total_volume / NULLIF(s.avg_volume_30d, 0)) < 0.8
           AND (d.session_range / NULLIF(s.avg_range_30d, 0)) > 1.3 THEN 'EASE_OF_MOVEMENT'
          ELSE 'NORMAL'
        END as flag
      FROM daily d, stats s
      ORDER BY d.session_date DESC
      LIMIT $1
    `, [days]);
    const result = r.rows;
    cacheSet(cacheKey, result, 4 * 60 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/wyckoff/sot — SOT detection
router.get('/wyckoff/sot', async (req, res) => {
  try {
    const cacheKey = 'sot-signals';
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Get daily high/low for last 60 days to detect swing points
    const bars = await query(`
      SELECT ts::date::text as date, MAX(high)::numeric(8,2) as high, MIN(low)::numeric(8,2) as low
      FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      GROUP BY ts::date ORDER BY ts::date DESC LIMIT 60
    `);
    const days = bars.rows.reverse(); // oldest first
    if (days.length < 10) return res.json({ up: null, down: null });

    // Find swing highs and lows (N=3 bar pivot)
    const swingHighs = [], swingLows = [];
    for (let i = 2; i < days.length - 2; i++) {
      const d = days[i];
      if (d.high >= days[i-1].high && d.high >= days[i-2].high && d.high >= days[i+1].high && d.high >= days[i+2].high) {
        swingHighs.push({ date: d.date, price: parseFloat(d.high) });
      }
      if (d.low <= days[i-1].low && d.low <= days[i-2].low && d.low <= days[i+1].low && d.low <= days[i+2].low) {
        swingLows.push({ date: d.date, price: parseFloat(d.low) });
      }
    }

    const detectSOT = (swings, direction) => {
      if (swings.length < 3) return null;
      const last3 = swings.slice(-3);
      const m1 = Math.abs(last3[1].price - last3[0].price);
      const m2 = Math.abs(last3[2].price - last3[1].price);
      if (m2 < m1) {
        const pct = ((m1 - m2) / m1 * 100);
        if (pct >= 25) return { direction, swing1: m1.toFixed(1), swing2: m2.toFixed(1), pct: pct.toFixed(1), dates: last3.map(s => s.date), latestSwingDate: last3[2].date };
      }
      return null;
    };

    const result = {
      up: detectSOT(swingHighs, 'UP'),
      down: detectSOT(swingLows, 'DOWN'),
      swingHighs: swingHighs.slice(-5),
      swingLows: swingLows.slice(-5),
    };
    cacheSet(cacheKey, result, 60 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;
