import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { cacheGet, cacheSet, latestBarDate } from '../lib/cache.js';

const REPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../reports');

const router = express.Router();

// GET /api/weekly/current
router.get('/weekly/current', async (req, res) => {
  try {
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    // Week start = Monday
    const dow = nowET.getDay(); // 0=Sun, 1=Mon...
    const daysToMon = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(nowET);
    monday.setDate(monday.getDate() + daysToMon);
    const weekStart = monday.toISOString().split('T')[0];

    const r = await query(`SELECT id, week_start::text as week_start_str, monday_high, monday_low, normal_week_upper, normal_week_lower, normal_var_upper, normal_var_lower, week_high, week_low, week_close, week_type, direction, acd_number_line_monday, monthly_pivot_bias, notes FROM weekly_ib_structure WHERE week_start=$1`, [weekStart]);
    if (r.rows.length > 0) {
      // Fetch current week high/low from bars
      const weekBars = await query(`
        SELECT MAX(high)::numeric(8,2) as week_high, MIN(low)::numeric(8,2) as week_low
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [weekStart]);
      const nlRow = await query(`SELECT COALESCE(SUM(daily_score),0) as nl30 FROM (SELECT daily_score FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) s`);
      const row = { ...r.rows[0], week_start: r.rows[0].week_start_str || weekStart };
      return res.json({ ...row, current_week_high: weekBars.rows[0]?.week_high, current_week_low: weekBars.rows[0]?.week_low, nl30: parseInt(nlRow.rows[0]?.nl30) });
    }

    // Auto-compute Monday IB from price_bars if available
    const mondayBars = await query(`
      SELECT MAX(high)::numeric(8,2) as high, MIN(low)::numeric(8,2) as low
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 10
    `, [weekStart]);

    if (mondayBars.rows[0]?.high) {
      const mh = parseFloat(mondayBars.rows[0].high), ml = parseFloat(mondayBars.rows[0].low);
      const ibRange = mh - ml;
      const nlRow = await query(`SELECT COALESCE(SUM(daily_score),0) as nl30 FROM (SELECT daily_score FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) s`);
      const pivotRow = await query(`SELECT pivot_level FROM acd_monthly_pivot WHERE month_year=$1`, [`${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}`]);
      const latestBar = await query(`SELECT close::float FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
      const nqClose = latestBar.rows[0]?.close;
      const pivotLevel = parseFloat(pivotRow.rows[0]?.pivot_level) || null;
      const pivotBias = pivotLevel ? (nqClose > pivotLevel ? 'ABOVE' : 'BELOW') : null;

      const saved = await query(`
        INSERT INTO weekly_ib_structure (week_start, monday_high, monday_low, normal_week_upper, normal_week_lower, normal_var_upper, normal_var_lower, acd_number_line_monday, monthly_pivot_bias)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (week_start) DO NOTHING RETURNING *, week_start::text
      `, [weekStart, mh, ml, mh+ibRange*0.5, ml-ibRange*0.5, mh+ibRange, ml-ibRange, parseInt(nlRow.rows[0]?.nl30), pivotBias]);

      const weekBars = await query(`SELECT MAX(high)::numeric(8,2) as week_high, MIN(low)::numeric(8,2) as week_low FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [weekStart]);
      return res.json({ ...(saved.rows[0] || {}), week_start: weekStart, monday_high: mh, monday_low: ml, normal_week_upper: mh+ibRange*0.5, normal_week_lower: ml-ibRange*0.5, normal_var_upper: mh+ibRange, normal_var_lower: ml-ibRange, current_week_high: weekBars.rows[0]?.week_high, current_week_low: weekBars.rows[0]?.week_low, nl30: parseInt(nlRow.rows[0]?.nl30), monthly_pivot_bias: pivotBias });
    }

    // Return prior week context even if current week has no IB
    const priorWeek = await query(`SELECT id, week_start::text as week_start_str, monday_high, monday_low, normal_week_upper, normal_week_lower, normal_var_upper, normal_var_lower, week_high, week_low, week_close, week_type, direction, acd_number_line_monday, monthly_pivot_bias, notes FROM weekly_ib_structure WHERE week_start < $1 ORDER BY weekly_ib_structure.week_start DESC LIMIT 1`, [weekStart]);
    const pw = priorWeek.rows[0];
    if (pw) pw.week_start = pw.week_start_str || pw.week_start;
    const priorBars = pw ? await query(`SELECT (array_agg(close ORDER BY ts DESC))[1]::numeric(8,2) as week_close, MAX(high)::numeric(8,2) as week_high, MIN(low)::numeric(8,2) as week_low FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= $1 AND ts::date < $2 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [pw.week_start_str, weekStart]) : null;
    res.json({ week_start: weekStart, monday_high: null, monday_low: null, prior_week: pw ? { ...pw, week_close: priorBars?.rows[0]?.week_close, week_high: priorBars?.rows[0]?.week_high, week_low: priorBars?.rows[0]?.week_low } : null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/weekly/va-history — weekly VP levels for last N weeks (for migration chart)
router.get('/weekly/va-history', async (req, res) => {
  try {
    const weeksBack = parseInt(req.query.weeks) || 8;
    const lbd = await latestBarDate();
    const cacheKey = `weekly-va-history-${weeksBack}-${lbd}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Get last N week starts that have bar data
    const weekStarts = await query(`
      SELECT DISTINCT date_trunc('week', ts::date)::date::text as week_start
      FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY week_start DESC LIMIT $1
    `, [weeksBack]);

    const results = [];
    for (const { week_start } of weekStarts.rows) {
      const we = new Date(week_start + 'T12:00:00Z');
      we.setUTCDate(we.getUTCDate() + 4);
      const weekEnd = we.toISOString().split('T')[0];

      try {
        const vp = await query(`
          WITH vp AS (
            SELECT ROUND(low / 0.25) * 0.25 as px, SUM(volume) as vol
            FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= $1 AND ts::date <= $2
              AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
            GROUP BY ROUND(low / 0.25) * 0.25
          ),
          total AS (SELECT SUM(vol) as t FROM vp),
          poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
          SELECT
            p.poc_px::float as poc,
            (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px) s WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
            (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px) s WHERE cv <= (SELECT t*0.35 FROM total))::float as val,
            MAX(vp.px)::float as week_high, MIN(vp.px)::float as week_low
          FROM vp, poc_row p GROUP BY p.poc_px
        `, [week_start, weekEnd]);

        // Monday range
        const mon = await query(`
          SELECT MAX(high)::float as h, MIN(low)::float as l
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        `, [week_start]);

        // Week close (Friday last bar)
        const close = await query(`
          SELECT (array_agg(close ORDER BY ts DESC))[1]::float as close
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date <= $1 AND ts::date >= $2
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        `, [weekEnd, week_start]);

        if (vp.rows[0]) {
          const v = vp.rows[0], m = mon.rows[0];
          const ibRange = m.h && m.l ? m.h - m.l : null;
          results.push({
            week_start,
            poc: v.poc, vah: v.vah, val: v.val,
            week_high: v.week_high, week_low: v.week_low,
            week_close: close.rows[0]?.close,
            monday_high: m.h, monday_low: m.l,
            ib_range: ibRange,
            nw_upper: m.h && ibRange ? m.h + ibRange * 0.5 : null,
            nv_upper: m.h && ibRange ? m.h + ibRange : null,
            week_type: v.week_high >= (m.h + ibRange) ? 'TREND' :
                       v.week_high >= (m.h + ibRange * 0.5) ? 'NORMAL_VARIATION' : 'NORMAL',
          });
        }
      } catch(e) { /* skip weeks with insufficient data */ }
    }

    results.reverse(); // oldest first for chart
    cacheSet(cacheKey, results, 4 * 60 * 60 * 1000);
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/daily/va-history — daily RTH volume profile for last N days
router.get('/daily/va-history', async (req, res) => {
  try {
    const daysBack = parseInt(req.query.days) || 30;
    const lbd = await latestBarDate();
    const cacheKey = `daily-va-history-${daysBack}-${lbd}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const tradingDays = await query(`
      SELECT DISTINCT ts::date::text as date
      FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY date DESC LIMIT $1
    `, [daysBack]);

    const results = [];
    for (const { date } of tradingDays.rows) {
      try {
        const vp = await query(`
          WITH vp AS (
            SELECT ROUND(low / 0.25) * 0.25 as px, SUM(volume) as vol
            FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
              AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
            GROUP BY ROUND(low / 0.25) * 0.25
          ),
          total AS (SELECT SUM(vol) as t FROM vp),
          poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
          SELECT
            p.poc_px::float as poc,
            (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px) s WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
            (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px) s WHERE cv <= (SELECT t*0.35 FROM total))::float as val,
            (array_agg(close ORDER BY ts DESC))[1]::float as day_close
          FROM vp, poc_row p
          JOIN price_bars_primary ON ts::date=$1 AND symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY p.poc_px LIMIT 1
        `, [date]);

        const ah = await query(`SELECT prior_profile, bias_dir FROM auction_history WHERE date=$1`, [date]);

        if (vp.rows[0]?.vah) {
          results.push({
            date,
            vah: vp.rows[0].vah,
            poc: vp.rows[0].poc,
            val: vp.rows[0].val,
            day_close: vp.rows[0].day_close,
            day_type: ah.rows[0]?.prior_profile || null,
            bias_dir: ah.rows[0]?.bias_dir || null,
          });
        }
      } catch(e) { /* skip days with insufficient data */ }
    }

    results.reverse();
    cacheSet(cacheKey, results, 4 * 60 * 60 * 1000);
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/weekly/bars — hourly bars + volume profile for a given week
router.get('/weekly/bars', async (req, res) => {
  try {
    const { week_start } = req.query;
    if (!week_start) return res.status(400).json({ error: 'week_start required' });
    const weekEnd = new Date(week_start + 'T12:00:00Z');
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 4);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    // Hourly bars
    const barsR = await query(`
      SELECT
        to_char(date_trunc('hour', ts), 'YYYY-MM-DD HH24:MI') as time,
        ts::date::text as date,
        (array_agg(open ORDER BY ts))[1]::float as open,
        MAX(high)::float as high,
        MIN(low)::float as low,
        (array_agg(close ORDER BY ts DESC))[1]::float as close,
        SUM(volume)::bigint as volume
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date >= $1 AND ts::date <= $2
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      GROUP BY date_trunc('hour', ts), ts::date
      ORDER BY date_trunc('hour', ts)
    `, [week_start, weekEndStr]);

    // Volume profile — 1-point buckets, find POC + 70% value area
    const vpR = await query(`
      WITH vp AS (
        SELECT ROUND(low / 0.25) * 0.25 as px, SUM(volume) as vol
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date >= $1 AND ts::date <= $2
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY ROUND(low / 0.25) * 0.25
      ),
      total AS (SELECT SUM(vol) as t FROM vp),
      poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
      SELECT
        p.poc_px::float as poc,
        (SELECT MAX(px) FROM (
          SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px
        ) s WHERE cv <= (SELECT t * 0.35 FROM total))::float as vah,
        (SELECT MIN(px) FROM (
          SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px
        ) s WHERE cv <= (SELECT t * 0.35 FROM total))::float as val,
        array_agg(json_build_object('price', vp.px, 'vol', vp.vol) ORDER BY vp.px) as histogram
      FROM vp, poc_row p
      GROUP BY p.poc_px
    `, [week_start, weekEndStr]);

    const vp = vpR.rows[0] || {};
    // Normalise histogram for display (pct of max)
    const hist = vp.histogram || [];
    const maxVol = hist.length ? Math.max(...hist.map(h => h.vol)) : 1;
    const histNorm = hist.map(h => ({ price: h.price, pct: Math.round(h.vol / maxVol * 100) }));

    res.json({ bars: barsR.rows, vp: { poc: vp.poc, vah: vp.vah, val: vp.val, histogram: histNorm } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/weekly/history
router.get('/weekly/history', async (req, res) => {
  try {
    const weeks = parseInt(req.query.weeks) || 12;
    const r = await query(`SELECT id, week_start::text as week_start_str, monday_high, monday_low, normal_week_upper, normal_week_lower, normal_var_upper, normal_var_lower, week_high, week_low, week_close, week_type, direction, acd_number_line_monday, monthly_pivot_bias, notes FROM weekly_ib_structure ORDER BY weekly_ib_structure.week_start DESC LIMIT $1`, [weeks]);
    res.json(r.rows.map(row => ({ ...row, week_start: row.week_start_str })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/weekly/monday
router.post('/weekly/monday', async (req, res) => {
  try {
    const { week_start, monday_high, monday_low, notes } = req.body;
    const mh = parseFloat(monday_high), ml = parseFloat(monday_low);
    const ibRange = mh - ml;
    const nlRow = await query(`SELECT COALESCE(SUM(daily_score),0) as nl30 FROM (SELECT daily_score FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) s`);
    const r = await query(`
      INSERT INTO weekly_ib_structure (week_start, monday_high, monday_low, normal_week_upper, normal_week_lower, normal_var_upper, normal_var_lower, acd_number_line_monday, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (week_start) DO UPDATE SET monday_high=$2, monday_low=$3, normal_week_upper=$4, normal_week_lower=$5, normal_var_upper=$6, normal_var_lower=$7, notes=$9, updated_at=NOW()
      RETURNING *, week_start::text
    `, [week_start, mh, ml, mh+ibRange*0.5, ml-ibRange*0.5, mh+ibRange, ml-ibRange, parseInt(nlRow.rows[0]?.nl30), notes]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/weekly/:id
router.put('/weekly/:id', async (req, res) => {
  try {
    const { week_type, direction, week_close, notes } = req.body;
    const r = await query(`UPDATE weekly_ib_structure SET week_type=$1, direction=$2, week_close=$3, notes=COALESCE($4,notes), updated_at=NOW() WHERE id=$5 RETURNING *, week_start::text`, [week_type, direction, week_close, notes, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/weekly/assessments — list all weeks with grade summary
router.get('/weekly/assessments', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT week_start::text, week_end::text, process_grade,
        total_pnl, winning_days, losing_days, days_with_trades, created_at
      FROM weekly_assessments ORDER BY week_start DESC LIMIT 52
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/weekly/assessment/:weekStart? — full data for one week
router.get('/weekly/assessment/:weekStart?', async (req, res) => {
  try {
    let rows;
    if (req.params.weekStart) {
      ({ rows } = await query(`
        SELECT week_start::text, week_end::text, process_grade, total_pnl,
          winning_days, losing_days, days_with_trades, assessment_text, report_text, created_at
        FROM weekly_assessments WHERE week_start = $1
      `, [req.params.weekStart]));
    } else {
      ({ rows } = await query(`
        SELECT week_start::text, week_end::text, process_grade, total_pnl,
          winning_days, losing_days, days_with_trades, assessment_text, report_text, created_at
        FROM weekly_assessments ORDER BY week_start DESC LIMIT 1
      `));
    }
    if (!rows.length) return res.json(null);
    const row = rows[0];
    if (!row.report_text) {
      try {
        row.report_text = fs.readFileSync(path.join(REPORTS_DIR, `weekly_${row.week_end}.txt`), 'utf8');
      } catch (_) {}
    }
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
