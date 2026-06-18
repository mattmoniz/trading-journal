// ACD Routes — full implementation extracted from server/index.js lines ~4759-7220
// Covers: /api/acd/*, /api/acd/backtest/*, /api/acd/weekly/*, weekly ACD computation

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getGLine, getGLineDaysHeld, getConvictionData, computeDynamicConviction } from '../services/queries.js';
import {
  computeACDFromBars,
  getBestACDParams,
  saveSetupEvents,
  scanAndSaveSetupEvents,
  scanStructuralEvents,
  getStructuralLevels,
} from '../services/acdService.js';
import { runParameterSearch } from '../services/acdBacktest.js';
import { getLevelTouchLookup, getComboLookup, formatLevelTouchRate, formatComboRate } from '../services/engineReadHitRates.js';
import { computeLiveVolatilityRegime } from '../services/volatilityRegimeService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory backtest job state
let acdJob = { status: 'idle', progress: null, result: null, error: null };

// ── Setup-detection level cache (structural data that changes at most daily) ──
// Keyed by trade date + cache key. TTL = 60 seconds for intraday stability.
const _levelCache = {};
const LEVEL_CACHE_TTL = 60000;
function cacheKey(tradeDate, key) { return `${tradeDate}:${key}`; }
function getCached(tradeDate, key) {
  const e = _levelCache[cacheKey(tradeDate, key)];
  if (e && Date.now() - e.ts < LEVEL_CACHE_TTL) return e.val;
  return null;
}
function setCached(tradeDate, key, val) {
  _levelCache[cacheKey(tradeDate, key)] = { val, ts: Date.now() };
  return val;
}
let structuralBackfillJob = { status: 'idle', done: 0, total: 0, eventsAdded: 0, error: null };
let acdBulkJob = { status: 'idle', done: 0, total: 0, error: null };
let weeklyBulkJob = { status: 'idle', done: 0, total: 0, error: null };

// Multer for CSV uploads
const csvDataDir = path.join(__dirname, '../data');
if (!fs.existsSync(csvDataDir)) fs.mkdirSync(csvDataDir, { recursive: true });
const csvUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, csvDataDir),
    filename: (req, file, cb) => cb(null, 'NQ_1min.csv'),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(csv|txt)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('CSV files only'));
  },
});

// ── Helpers for setup lifecycle ───────────────────────────────────────────────

function inferDirection(setupType) {
  if (/LONG|UP|BULLISH/.test(setupType)) return 'LONG';
  if (/SHORT|DOWN|BEARISH/.test(setupType)) return 'SHORT';
  return null;
}

// Drops an active_setups row into trade_timeline_events (idempotent via ON CONFLICT).
// event_time = fired_at (never current timestamp — per spec).
export async function dropToTimeline(setup) {
  await query(`
    INSERT INTO trade_timeline_events (
      trade_date, event_time, event_type, setup_type, setup_id,
      direction, entry_zone, stop_level, t1_level, t1_label,
      resolution, historical_win_rate, historical_sessions,
      window_duration_minutes
    ) VALUES ($1,$2,'SETUP',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (setup_id) DO NOTHING
  `, [
    setup.trade_date,
    setup.fired_at,
    setup.setup_type,
    setup.id,
    inferDirection(setup.setup_type),
    setup.entry_zone_low,
    setup.stop_level,
    setup.t1_level,
    setup.t1_label,
    setup.resolution || null,
    setup.historical_win_rate,
    setup.historical_sessions,
    setup.expires_at
      ? Math.round((new Date(setup.expires_at) - new Date(setup.fired_at)) / 60000)
      : null,
  ]);
}

function isLongSetup(setupType) {
  return setupType.includes('LONG') || setupType.includes('BULLISH') || setupType.includes('_UP');
}

// Price-based resolution: for each ACTIVE setup with defined entry/stop/T1, walk price
// bars since fired_at and resolve TARGET_HIT/STOP_HIT the moment either level is touched
// (whichever is touched first, chronologically — same logic as setupBacktestService.js
// and the historical backfill). Runs BEFORE expireStaleSetups/structurallyInvalidateSetups
// so a real T1/stop touch is never preempted by a timer or OR-break invalidation.
export async function resolveSetupsByPrice(io) {
  const active = await query(`
    SELECT id, setup_type, trade_date, fired_at, entry_zone_low, entry_zone_high, stop_level, t1_level
    FROM active_setups WHERE status='ACTIVE'
  `);

  let count = 0;
  for (const row of active.rows) {
    const long = isLongSetup(row.setup_type);
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const stop = row.stop_level;
    const t1 = row.t1_level;
    if (entry == null || stop == null || t1 == null) continue;
    if (long && t1 <= entry) continue;
    if (!long && t1 >= entry) continue;

    const bars = await query(`
      SELECT ts, open::float, high::float, low::float, close::float
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 ORDER BY ts
    `, [row.fired_at]);

    let resolution = null, resolvedAt = null, priceAtRes = null, method = null;
    for (const bar of bars.rows) {
      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (t1Hit && stopHit) {
        const towardT1 = long ? (bar.open > entry) : (bar.open < entry);
        resolution = towardT1 ? 'TARGET_HIT' : 'STOP_HIT';
        method = 'SAME_BAR_TIEBREAK';
        resolvedAt = bar.ts;
        priceAtRes = towardT1 ? t1 : stop;
        break;
      } else if (t1Hit) {
        resolution = 'TARGET_HIT';
        method = 'PRICE_CLEAN';
        resolvedAt = bar.ts;
        priceAtRes = t1;
        break;
      } else if (stopHit) {
        resolution = 'STOP_HIT';
        method = 'PRICE_CLEAN';
        resolvedAt = bar.ts;
        priceAtRes = stop;
        break;
      }
    }
    if (!resolution) continue;

    const pnl = resolution === 'TARGET_HIT'
      ? (long ? (t1 - entry) : (entry - t1)) * 5 - 5
      : (long ? (stop - entry) : (entry - stop)) * 5 - 5;

    const updated = await query(`
      UPDATE active_setups
      SET status='RESOLVED', resolution=$2, resolution_method=$3, actual_outcome=$2,
          actual_pnl=$4, price_at_resolution=$5, resolved_at=$6, updated_at=NOW()
      WHERE id=$1 AND status='ACTIVE'
      RETURNING *
    `, [row.id, resolution, method, Math.round(pnl * 100) / 100, priceAtRes, resolvedAt]);

    if (updated.rows.length) {
      try { await dropToTimeline(updated.rows[0]); } catch (_) {}
      if (io) io.emit('setup-resolved', {
        setupId: row.id, setupType: row.setup_type, tradeDate: row.trade_date,
        resolution, resolutionMethod: method, actualPnl: updated.rows[0].actual_pnl,
      });
      count++;
    }
  }
  return count;
}

// Expires any ACTIVE setups past their expires_at; emits socket events.
export async function expireStaleSetups(io) {
  const expired = await query(`
    UPDATE active_setups
    SET status = 'EXPIRED', resolution = 'TIME_EXPIRED', resolved_at = NOW(), updated_at = NOW()
    WHERE status = 'ACTIVE'
      AND expires_at IS NOT NULL
      AND expires_at < NOW()
    RETURNING *
  `);
  for (const row of expired.rows) {
    try { await dropToTimeline(row); } catch (_) {}
    if (io) io.emit('setup-expired', { setupId: row.id, setupType: row.setup_type, tradeDate: row.trade_date });
  }
  return expired.rows.length;
}

// Structural invalidation: expire SHORT setups when price > OR High, LONG when price < OR Low.
// Called alongside expireStaleSetups on every setup-detection poll.
export async function structurallyInvalidateSetups(io) {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const [priceRow, acdRow] = await Promise.all([
    query(`SELECT close::float FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`),
    query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [todayET]),
  ]);

  const currentPrice = priceRow.rows[0]?.close;
  const orHigh = acdRow.rows[0]?.or_high;
  const orLow  = acdRow.rows[0]?.or_low;
  if (!currentPrice || !orHigh || !orLow) return 0;

  // Bearish setups invalidated when price closes above OR High
  const bearishPattern = '%SHORT%,IB_BEARISH,C_STANDALONE_DOWN,FAILED_AUCTION_SHORT,VALUE_AREA_RESPONSIVE_SHORT'.split(',');
  const bullishPattern = '%LONG%,IB_BULLISH,C_STANDALONE_UP,FAILED_AUCTION_LONG,VALUE_AREA_RESPONSIVE_LONG'.split(',');

  const isBearish = (t) => t.includes('SHORT') || t.includes('BEARISH') || t === 'C_STANDALONE_DOWN' || t.includes('A_DOWN');
  const isBullish = (t) => t.includes('LONG')  || t.includes('BULLISH') || t === 'C_STANDALONE_UP' || t.includes('A_UP');

  // Need fired_at and stop_level to compute how long the setup was active when invalidated
  const activeWithTime = await query(`
    SELECT id, setup_type, trade_date, fired_at, stop_level FROM active_setups
    WHERE trade_date=$1 AND status='ACTIVE'
  `, [todayET]);

  let count = 0;
  for (const row of activeWithTime.rows) {
    const isBracket = row.setup_type.includes('BRACKET_BREAKOUT');
    let shouldInvalidate = false;

    if (isBracket) {
      const isLong = row.setup_type.includes('LONG');
      shouldInvalidate = isLong
        ? (row.stop_level != null && currentPrice <= row.stop_level)
        : (row.stop_level != null && currentPrice >= row.stop_level);
    } else {
      shouldInvalidate =
        (isBearish(row.setup_type) && currentPrice > orHigh) ||
        (isBullish(row.setup_type) && currentPrice < orLow);
    }

    if (!shouldInvalidate) continue;

    const minutesActive = row.fired_at
      ? (Date.now() - new Date(row.fired_at).getTime()) / 60000
      : 0;
    const invalidationTiming = minutesActive >= 2 ? 'POST_ENTRY' : 'PRE_ENTRY';

    const updated = await query(`
      UPDATE active_setups
      SET status='EXPIRED', resolution='INVALIDATED', resolved_at=NOW(),
          updated_at=NOW(), invalidation_timing=$2
      WHERE id=$1 AND status='ACTIVE'
      RETURNING *
    `, [row.id, invalidationTiming]);

    if (updated.rows.length) {
      try { await dropToTimeline(updated.rows[0]); } catch (_) {}
      if (io) io.emit('setup-expired', {
        setupId: row.id, setupType: row.setup_type, tradeDate: row.trade_date,
        resolution: 'INVALIDATED', invalidationTiming,
      });
      count++;
    }
  }
  return count;
}

// Factory: needs io for socket events
export default function createACDRouter(io) {
  const router = express.Router();

  // GET /api/acd/volatility-regime
  // Phase 2 of the volatility-regime backtest (report-only Phase 1 confirmed
  // setups perform meaningfully better in HIGH-VOL-DIRECTIONAL mornings and
  // flat-to-worse in HIGH-VOL-CHOP). Live read-only monitor — does not affect
  // setup detection/resolution/classification.
  router.get('/acd/volatility-regime', async (req, res) => {
    try {
      const result = await computeLiveVolatilityRegime();
      res.json(result);
    } catch (e) {
      res.status(500).json({ available: false, reason: e.message });
    }
  });

  // GET /api/acd/gap-context
  // Detects open RTH-to-RTH gaps from the last 30 sessions and returns gap zones,
  // fill status, and current price relation. Read-only, no DB writes.
  router.get('/acd/gap-context', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      const rangesQ = await query(`
        SELECT d, rth_low, rth_high FROM (
          SELECT ts::date::text as d,
            MIN(low)::float as rth_low,
            MAX(high)::float as rth_high
          FROM price_bars_primary
          WHERE symbol='NQ'
            AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
            AND ts::date <= $1
          GROUP BY ts::date
          ORDER BY ts::date DESC
          LIMIT 40
        ) sub ORDER BY d ASC
      `, [todayET]);
      const sessions = rangesQ.rows;

      const priceQ = await query(`
        SELECT close::float as price FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date = $1
        ORDER BY ts DESC LIMIT 1
      `, [todayET]);
      const currentPrice = priceQ.rows[0]?.price ?? null;

      if (sessions.length < 2) {
        return res.json({ gaps: [], currentPrice });
      }

      const gaps = [];
      for (let i = 1; i < sessions.length; i++) {
        const prev = sessions[i - 1];
        const curr = sessions[i];
        if (curr.rth_low > prev.rth_high) {
          gaps.push({ type: 'up', fromDate: prev.d, toDate: curr.d, gapLow: prev.rth_high, gapHigh: curr.rth_low });
        } else if (curr.rth_high < prev.rth_low) {
          gaps.push({ type: 'down', fromDate: prev.d, toDate: curr.d, gapLow: curr.rth_high, gapHigh: prev.rth_low });
        }
      }

      const openGaps = [];
      for (const gap of gaps) {
        const gapIdx = sessions.findIndex(s => s.d === gap.toDate);
        const gapSize = gap.gapHigh - gap.gapLow;
        let filled = false;
        let partialFillLow = gap.gapHigh; // lowest price reached inside gap (for up gaps)
        let partialFillHigh = gap.gapLow; // highest price reached inside gap (for down gaps)

        for (let i = gapIdx + 1; i < sessions.length; i++) {
          const s = sessions[i];
          if (gap.type === 'up') {
            partialFillLow = Math.min(partialFillLow, s.rth_low);
            if (s.rth_low <= gap.gapLow) { filled = true; break; }
          } else {
            partialFillHigh = Math.max(partialFillHigh, s.rth_high);
            if (s.rth_high >= gap.gapHigh) { filled = true; break; }
          }
        }

        if (!filled) {
          const sessionAge = sessions.length - 1 - gapIdx;
          let pctFilled = 0;
          if (gap.type === 'up' && partialFillLow < gap.gapHigh) {
            pctFilled = Math.min(100, (gap.gapHigh - partialFillLow) / gapSize * 100);
          } else if (gap.type === 'down' && partialFillHigh > gap.gapLow) {
            pctFilled = Math.min(100, (partialFillHigh - gap.gapLow) / gapSize * 100);
          }

          const priceInGap = currentPrice != null && currentPrice > gap.gapLow && currentPrice < gap.gapHigh;
          const priceAboveGap = currentPrice != null && currentPrice >= gap.gapHigh;
          const priceBelowGap = currentPrice != null && currentPrice <= gap.gapLow;
          const priceRelation = currentPrice == null ? null
            : priceAboveGap ? 'above' : priceBelowGap ? 'below' : 'inside';

          openGaps.push({
            type: gap.type,
            fromDate: gap.fromDate,
            toDate: gap.toDate,
            gapLow: gap.gapLow,
            gapHigh: gap.gapHigh,
            gapSize: Math.round(gapSize * 100) / 100,
            sessionAge,
            pctFilled: Math.round(pctFilled),
            ptsRemaining: Math.round((gapSize * (1 - pctFilled / 100)) * 100) / 100,
            priceRelation,
          });
        }
      }

      res.json({ gaps: openGaps, currentPrice });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/acd/vol-backtest-stats
  // Returns latest cached results from vol_backtest_cache (written by scripts/volatility_predictive_backtest.mjs).
  // Used by VolatilityRegimeCard to show expansion targets and continuation probability.
  router.get('/acd/vol-backtest-stats', async (req, res) => {
    try {
      const r = await query(
        `SELECT results, run_at FROM vol_backtest_cache ORDER BY id DESC LIMIT 1`
      );
      if (!r.rows.length) return res.json(null);
      res.json({ ...r.rows[0].results, cachedAt: r.rows[0].run_at });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/acd/today
  router.get('/acd/today', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const today = await query('SELECT * FROM acd_daily_log WHERE trade_date = $1', [todayET]);

      const nlRow = await query(`
        SELECT COALESCE(SUM(daily_score), 0) as sum30,
               COALESCE(SUM(CASE WHEN rn <= 10 THEN daily_score ELSE 0 END), 0) as sum10
        FROM (SELECT daily_score, ROW_NUMBER() OVER (ORDER BY trade_date DESC) as rn FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) sub
      `);

      const recent = await query(`SELECT trade_date::text as trade_date, daily_score, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed FROM acd_daily_log ORDER BY trade_date DESC LIMIT 4`);
      let systemFailureWarning = null;
      for (const row of recent.rows.slice(1, 4)) {
        if ((row.a_up_fired && !row.c_up_confirmed) || (row.a_down_fired && !row.c_down_confirmed)) {
          const dir = row.a_up_fired ? 'A Up' : 'A Down';
          systemFailureWarning = `System failure check: ${dir} signal from ${row.trade_date} has not confirmed. Fisher's rule: if no follow-through within 2–3 sessions, exit immediately.`;
          break;
        }
      }

      const settings = await query('SELECT * FROM risk_settings ORDER BY id LIMIT 1');
      const aMultiplier = parseFloat(settings.rows[0]?.a_multiplier || 0.33);

      res.json({
        today: today.rows[0] || null,
        numberLine: { sum30: parseInt(nlRow.rows[0]?.sum30) || 0, sum10: parseInt(nlRow.rows[0]?.sum10) || 0 },
        systemFailureWarning,
        aMultiplier,
        todayDate: todayET,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/acd/daily
  router.post('/acd/daily', async (req, res) => {
    try {
      const { trade_date, or_high, or_low, a_multiplier = 0.33, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, session_close, notes, profile_shape } = req.body;
      const aUpLevel   = or_high && or_low ? parseFloat(or_high) + (parseFloat(or_high) - parseFloat(or_low)) * a_multiplier : null;
      const aDownLevel = or_high && or_low ? parseFloat(or_low)  - (parseFloat(or_high) - parseFloat(or_low)) * a_multiplier : null;

      let score = 0;
      if (a_up_fired   && c_up_confirmed)   score =  4;
      else if (a_up_fired)                  score =  1;
      else if (a_down_fired && c_down_confirmed) score = -4;
      else if (a_down_fired)                score = -1;

      const r = await query(`
        INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close, notes, profile_shape)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (trade_date) DO UPDATE SET
          or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
          a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
          daily_score=$11, session_close=$12, notes=$13,
          profile_shape=COALESCE($14, acd_daily_log.profile_shape)
        RETURNING *
      `, [trade_date, or_high, or_low, a_multiplier, aUpLevel, aDownLevel, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, score, session_close, notes, profile_shape || null]);
      res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/daily
  router.get('/acd/daily', async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 60;
      const r = await query(`SELECT *, trade_date::text as trade_date_str FROM acd_daily_log ORDER BY trade_date DESC LIMIT $1`, [days]);
      res.json(r.rows.map(row => ({ ...row, trade_date: row.trade_date_str })));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/numberline
  router.get('/acd/numberline', async (req, res) => {
    try {
      const r = await query(`
        SELECT trade_date, daily_score,
               SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as sum30,
               SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 9 PRECEDING AND CURRENT ROW) as sum10
        FROM acd_daily_log
        ORDER BY trade_date DESC
        LIMIT 90
      `);
      const rows = r.rows;
      const latest = rows[0];
      const sum30 = parseInt(latest?.sum30) || 0;
      const sum10 = parseInt(latest?.sum10) || 0;
      const trend = sum30 > 9 ? 'TRENDING_UP' : sum30 < -9 ? 'TRENDING_DOWN' : 'RANGING';
      const quality = (trend !== 'RANGING' && Math.abs(sum30) > 15) ? 'HIGH' : (trend !== 'RANGING') ? 'MODERATE' : 'LOW';
      const momentumWarning = sum30 > 9 && sum10 < 5 ? 'Momentum weakening — trend may be losing conviction' :
                              sum30 < -9 && sum10 > -5 ? 'Bearish momentum weakening' : null;
      res.json({ sum30, sum10, trend, quality, momentumWarning, history: rows.slice(0, 30).reverse() });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/pivot/current
  router.get('/acd/pivot/current', async (req, res) => {
    try {
      const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
      const d = new Date(nowET);
      const monthYear = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const r = await query('SELECT * FROM acd_monthly_pivot WHERE month_year = $1', [monthYear]);
      res.json(r.rows[0] || null);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/acd/pivot
  router.post('/acd/pivot', async (req, res) => {
    try {
      const { month_year, prior_month_high, prior_month_low, prior_month_close } = req.body;
      const ph = parseFloat(prior_month_high), pl = parseFloat(prior_month_low), pc = parseFloat(prior_month_close);
      const pivot = (ph + pl + pc) / 3;
      const r1 = 2 * pivot - pl;
      const s1 = 2 * pivot - ph;
      const r = await query(`
        INSERT INTO acd_monthly_pivot (month_year, prior_month_high, prior_month_low, prior_month_close, pivot_level, pivot_r1, pivot_s1)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (month_year) DO UPDATE SET prior_month_high=$2, prior_month_low=$3, prior_month_close=$4, pivot_level=$5, pivot_r1=$6, pivot_s1=$7
        RETURNING *
      `, [month_year, ph, pl, pc, pivot, r1, s1]);
      res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/backtest/results
  router.get('/acd/backtest/results', async (req, res) => {
    try {
      const period = req.query.period || 'all-time';
      const r = await query('SELECT * FROM acd_backtest_results WHERE period=$1 ORDER BY ev_per_signal DESC NULLS LAST LIMIT 100', [period]);
      const lastRun = await query('SELECT MAX(run_date) as last_run FROM acd_backtest_results WHERE period=$1', [period]);
      res.json({ results: r.rows, lastRun: lastRun.rows[0]?.last_run || null });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/backtest/status
  router.get('/acd/backtest/status', (req, res) => {
    res.json({ status: acdJob.status, progress: acdJob.progress, error: acdJob.error });
  });

  // POST /api/acd/backtest/run

  router.post('/acd/backtest/run', csvUpload.single('csv'), async (req, res) => {
    if (acdJob.status === 'running') return res.status(409).json({ error: 'Backtest already running' });

    const csvPath  = req.file ? req.file.path : null;
    const useDB    = !csvPath;
    const days     = req.body?.days ? parseInt(req.body.days) : null;
    const startDate = days ? new Date(Date.now() - days * 86400000).toISOString().split('T')[0] : null;

    acdJob = { status: 'running', progress: { done: 0, total: 360, source: useDB ? 'db' : 'csv', days: days || 'all' }, result: null, error: null };
    res.json({ message: `Backtest started from ${useDB ? 'price bar database' : 'CSV'}${days ? ` (last ${days} days)` : ''}`, status: 'running' });

    setImmediate(async () => {
      try {
        const results = await runParameterSearch(csvPath, (p) => { acdJob.progress = { ...p, source: useDB ? 'db' : 'csv', days: days || 'all' }; }, startDate);

        const period = days ? `last-${days}d` : 'all-time';
        await query('DELETE FROM acd_backtest_results WHERE period=$1', [period]);
        const top = results.slice(0, 360);
        if (top.length > 0) {
          const cols = 18;
          const vals = [];
          const placeholders = top.map((r, i) => {
            const b = i * cols;
            const filterLabel = [
              r.params.nlAligned ? 'NL-aligned' : null,
              r.params.orRangeMax ? `OR<${r.params.orRangeMax}` : null,
              r.params.cConfirmedOnly ? 'C-only' : null,
            ].filter(Boolean).join('+') || 'baseline';
            vals.push(
              r.params.orMinutes, r.params.aMultiplier, r.params.sustainMinutes,
              r.totalSignals, r.winRate, r.avgWinR, r.avgLossR, r.payoffRatio,
              r.evPerTrade, r.profitFactor,
              r.nlAbove9?.winRate ?? null, r.nlBelow9?.winRate ?? null, r.nlRanging?.winRate ?? null,
              r.params.nlAligned ?? false, r.params.orRangeMax ?? null,
              r.params.cConfirmedOnly ?? false, filterLabel, period
            );
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18})`;
          });
          await query(`INSERT INTO acd_backtest_results (or_minutes,a_multiplier,sustain_minutes,total_signals,win_rate,avg_win_r,avg_loss_r,payoff_ratio,ev_per_signal,profit_factor,win_rate_nl_above_9,win_rate_nl_below_9,win_rate_nl_ranging,nl_aligned,or_range_max,c_confirmed_only,filter_label,period) VALUES ${placeholders.join(',')}`, vals);
        }
        const bestPeriodPriority = ['last-30d', 'last-60d', 'all-time'];
        const bestPeriodToUse = bestPeriodPriority.includes(period) ? period : 'all-time';
        const bestResult = top[0];
        if (bestResult) {
          await query(`
            UPDATE risk_settings SET
              acd_or_minutes=$1, acd_a_multiplier=$2, acd_sustain_minutes=$3,
              acd_best_params_period=$4, acd_best_params_ev=$5
          `, [bestResult.params.orMinutes, bestResult.params.aMultiplier, bestResult.params.sustainMinutes,
              bestPeriodToUse, bestResult.evPerTrade]);
          console.log(`ACD best params auto-saved: OR=${bestResult.params.orMinutes}m A=${bestResult.params.aMultiplier} sus=${bestResult.params.sustainMinutes} (${bestPeriodToUse}, EV=${bestResult.evPerTrade.toFixed(3)}R)`);
        }
        acdJob = { status: 'complete', progress: { done: top.length, total: results.length }, error: null };
      } catch(e) {
        acdJob = { status: 'error', progress: acdJob.progress, result: null, error: e.message };
      }
    });
  });

  // GET /api/acd/context
  router.get('/acd/context', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      const prevRes = await query(`
        SELECT DISTINCT ts::date::text as d FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        ORDER BY d DESC LIMIT 1
      `, [todayET]);
      if (!prevRes.rows.length) return res.json(null);
      const prevDate = prevRes.rows[0].d;

      const bars = await query(`
        SELECT high::float, low::float, volume::bigint
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date = $1
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        ORDER BY ts
      `, [prevDate]);
      if (!bars.rows.length) return res.json(null);

      const TICK = 0.25;
      const volMap = {};
      for (const bar of bars.rows) {
        const h = Math.round(bar.high / TICK) * TICK;
        const l = Math.round(bar.low  / TICK) * TICK;
        const v = bar.volume || 1;
        const steps = Math.round((h - l) / TICK) + 1;
        const vPerStep = v / steps;
        for (let i = 0; i < steps; i++) {
          const p = Math.round((l + i * TICK) * 100) / 100;
          volMap[p] = (volMap[p] || 0) + vPerStep;
        }
      }
      const levels = Object.keys(volMap).map(Number).sort((a, b) => a - b);
      if (!levels.length) return res.json(null);

      const poc = levels.reduce((best, p) => volMap[p] > volMap[best] ? p : best, levels[0]);
      const pocIdx = levels.indexOf(poc);
      const totalVol = Object.values(volMap).reduce((s, v) => s + v, 0);
      const target = totalVol * 0.70;
      let vaVol = volMap[poc], lo = pocIdx, hi = pocIdx;
      while (vaVol < target) {
        const upVol = hi + 1 < levels.length ? volMap[levels[hi + 1]] : 0;
        const dnVol = lo - 1 >= 0 ? volMap[levels[lo - 1]] : 0;
        if (upVol >= dnVol && hi + 1 < levels.length) { hi++; vaVol += upVol; }
        else if (lo - 1 >= 0) { lo--; vaVol += dnVol; }
        else break;
      }
      const vah = levels[hi];
      const val = levels[lo];

      const sessionHigh  = Math.max(...bars.rows.map(b => b.high));
      const sessionLow   = Math.min(...bars.rows.map(b => b.low));

      // cacheSet imported at top
      const cacheKey = `acd-context-${todayET}`;
      const result = { prevDate, poc, vah, val, sessionHigh, sessionLow };
      cacheSet(cacheKey, result, 4 * 60 * 60 * 1000);
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/acd/autocompute
  router.post('/acd/autocompute', async (req, res) => {
    try {
      const { date, or_minutes, a_multiplier, sustain_minutes } = req.body;
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const targetDate = date || todayET;
      const best = await getBestACDParams();
      const orMins   = or_minutes   ? parseInt(or_minutes)    : best.orMins;
      const aMult    = a_multiplier ? parseFloat(a_multiplier): best.aMult;
      const sustainM = sustain_minutes ? parseInt(sustain_minutes) : best.sustainMins;

      const result = await computeACDFromBars(targetDate, orMins, aMult, sustainM);
      if (!result) return res.status(404).json({ error: `No NQ bars found for ${targetDate}` });

      const r = await query(`
        INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (trade_date) DO UPDATE SET
          or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
          a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
          daily_score=$11, session_close=$12
        RETURNING *
      `, [targetDate, result.orHigh, result.orLow, aMult, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);

      res.json({ ...result, saved: r.rows[0] });
    } catch(e) { console.error('autocompute error:', e); res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/structural-events/backfill/status
  router.get('/acd/structural-events/backfill/status', (req, res) => res.json(structuralBackfillJob));

  // POST /api/acd/structural-events/backfill
  router.post('/acd/structural-events/backfill', async (req, res) => {
    if (structuralBackfillJob.status === 'running')
      return res.status(409).json({ error: 'Backfill already running' });

    res.json({ message: 'Structural events backfill started' });
    structuralBackfillJob = { status: 'running', done: 0, total: 0, eventsAdded: 0, error: null };

    (async () => {
      try {
        const datesQ = await query(`
          SELECT al.trade_date::text as d
          FROM acd_daily_log al
          WHERE al.or_high IS NOT NULL
          ORDER BY al.trade_date ASC
        `);
        const dates = datesQ.rows.map(r => r.d);
        structuralBackfillJob.total = dates.length;
        console.log(`Structural events backfill: ${dates.length} dates to process`);

        const pmVaCache = {};

        for (const date of dates) {
          try {
            const [yr, mo] = date.split('-').map(Number);
            const monthKey = `${yr}-${String(mo).padStart(2,'0')}`;

            if (!pmVaCache[monthKey]) {
              const pmStart = new Date(Date.UTC(yr, mo - 2, 1)).toISOString().split('T')[0];
              const pmEnd   = new Date(Date.UTC(yr, mo - 1, 1)).toISOString().split('T')[0];
              const pmVpQ = await query(`
                WITH vp AS (
                  SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
                  FROM price_bars_primary WHERE symbol='NQ'
                    AND ts >= $1::date AND ts < $2::date
                    AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
                    AND EXTRACT(hour FROM ts) < 16
                  GROUP BY ROUND(low/0.25)*0.25
                ), total AS (SELECT SUM(vol) as t FROM vp),
                poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
                SELECT p.poc_px::float as poc,
                  (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
                  (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
                FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
              `, [pmStart, pmEnd]);
              pmVaCache[monthKey] = {
                pmVAH: pmVpQ.rows[0]?.vah || null,
                pmVAL: pmVpQ.rows[0]?.val || null,
              };
            }
            const { pmVAH, pmVAL } = pmVaCache[monthKey];

            const gLine = await getGLine(date);

            const pwQ = await query(`
              SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low
              FROM price_bars_primary WHERE symbol='NQ'
                AND ts::date >= date_trunc('week', ($1::text)::date) - INTERVAL '7 days'
                AND ts::date <  date_trunc('week', ($1::text)::date)
                AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
                AND EXTRACT(hour FROM ts) < 16
            `, [date]);
            const pwHigh = pwQ.rows[0]?.pw_high || null;
            const pwLow  = pwQ.rows[0]?.pw_low  || null;

            const acdRow = await query(`
              SELECT or_high::float, or_low::float, a_up_level::float, a_down_level::float
              FROM acd_daily_log WHERE trade_date=$1
            `, [date]);
            if (!acdRow.rows.length) { structuralBackfillJob.done++; continue; }
            const { or_high: orH, or_low: orL, a_up_level: aUp, a_down_level: aDown } = acdRow.rows[0];

            const bars = await query(`
              SELECT ts, high::float, low::float, close::float
              FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
                AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 575 AND 959
              ORDER BY ts
            `, [date]);
            if (!bars.rows.length) { structuralBackfillJob.done++; continue; }

            const sessionHigh = Math.max(...bars.rows.map(b => b.high));
            const sessionLow  = Math.min(...bars.rows.map(b => b.low));
            const timeline = [];

            let gLineTouched=false, gLineLost=false, gLineReclaimed=false;
            let pwHighTouched=false, pwHighBroken=false;
            let pwLowTouched=false,  pwLowBroken=false;
            let pmVAHTouched=false,  pmVAHBroken=false;
            let pmVALTouched=false,  pmVALBroken=false;

            for (const bar of bars.rows) {
              const t = new Date(bar.ts).toISOString().slice(11, 16);
              const { high: hi, low: lo, close: cl } = bar;

              if (gLine) {
                if (!gLineTouched && lo <= gLine && hi >= gLine)
                  { gLineTouched = true; timeline.push({ time: t, event: 'G-Line tested', price: gLine }); }
                if (!gLineLost && cl < gLine)
                  { gLineLost = true; timeline.push({ time: t, event: 'G-Line lost', price: cl }); }
                if (gLineLost && !gLineReclaimed && cl > gLine)
                  { gLineReclaimed = true; timeline.push({ time: t, event: 'G-Line reclaimed', price: cl }); }
              }
              if (pwHigh) {
                if (!pwHighTouched && hi >= pwHigh)
                  { pwHighTouched = true; timeline.push({ time: t, event: 'PW High tested', price: pwHigh }); }
                if (!pwHighBroken && cl > pwHigh)
                  { pwHighBroken = true; timeline.push({ time: t, event: 'PW High broken', price: cl }); }
              }
              if (pwLow) {
                if (!pwLowTouched && lo <= pwLow)
                  { pwLowTouched = true; timeline.push({ time: t, event: 'PW Low tested', price: pwLow }); }
                if (!pwLowBroken && cl < pwLow)
                  { pwLowBroken = true; timeline.push({ time: t, event: 'PW Low broken', price: cl }); }
              }
              if (pmVAH) {
                if (!pmVAHTouched && hi >= pmVAH)
                  { pmVAHTouched = true; timeline.push({ time: t, event: 'PM VAH tested', price: pmVAH }); }
                if (!pmVAHBroken && cl > pmVAH)
                  { pmVAHBroken = true; timeline.push({ time: t, event: 'PM VAH broken', price: cl }); }
              }
              if (pmVAL) {
                if (!pmVALTouched && lo <= pmVAL)
                  { pmVALTouched = true; timeline.push({ time: t, event: 'PM VAL tested', price: pmVAL }); }
                if (!pmVALBroken && cl < pmVAL)
                  { pmVALBroken = true; timeline.push({ time: t, event: 'PM VAL broken', price: cl }); }
              }
            }

            if (timeline.length > 0) {
              await saveSetupEvents(date, timeline, orH, orL, aUp, aDown, sessionHigh, sessionLow);
              structuralBackfillJob.eventsAdded += timeline.length;
            }
          } catch(e) {
            console.error(`Structural backfill error for ${date}:`, e.message);
          }
          structuralBackfillJob.done++;
          if (structuralBackfillJob.done % 10 === 0) await new Promise(r => setTimeout(r, 0));
        }

        structuralBackfillJob.status = 'complete';
        console.log(`Structural events backfill complete — ${structuralBackfillJob.eventsAdded} events added across ${structuralBackfillJob.done} dates`);
      } catch(e) {
        structuralBackfillJob.status = 'error';
        structuralBackfillJob.error = e.message;
        console.error('Structural backfill fatal error:', e);
      }
    })();
  });

  // GET /api/acd/autocompute/bulk/status
  router.get('/acd/autocompute/bulk/status', (req, res) => res.json(acdBulkJob));

  // POST /api/acd/autocompute/bulk
  router.post('/acd/autocompute/bulk', async (req, res) => {
    if (acdBulkJob.status === 'running') return res.status(409).json({ error: 'Bulk job already running' });

    const { or_minutes, a_multiplier, sustain_minutes } = req.body;
    const orMins   = parseInt(or_minutes)    || 5;
    const aMult    = parseFloat(a_multiplier) || 0.33;
    const sustainM = parseInt(sustain_minutes) || 3;

    res.json({ message: 'Bulk backfill started' });

    setImmediate(async () => {
      try {
        const datesRes = await query(`
          SELECT DISTINCT ts::date::text as d FROM price_bars_primary
          WHERE symbol = 'NQ'
            AND EXTRACT(hour FROM ts) = 9 AND EXTRACT(minute FROM ts) = 30
          ORDER BY d
        `);
        const dates = datesRes.rows.map(r => r.d);
        acdBulkJob = { status: 'running', done: 0, total: dates.length, error: null };

        for (let i = 0; i < dates.length; i++) {
          const d = dates[i];
          try {
            const result = await computeACDFromBars(d, orMins, aMult, sustainM);
            if (result) {
              await query(`
                INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                ON CONFLICT (trade_date) DO UPDATE SET
                  or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
                  a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
                  daily_score=$11, session_close=$12
              `, [d, result.orHigh, result.orLow, aMult, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);
            }
          } catch(e) { /* skip individual date errors */ }
          acdBulkJob.done = i + 1;
        }
        acdBulkJob = { status: 'complete', done: acdBulkJob.total, total: acdBulkJob.total, error: null };
      } catch(e) {
        acdBulkJob = { status: 'error', done: acdBulkJob.done, total: acdBulkJob.total, error: e.message };
      }
    });
  });

  // POST /api/acd/pivot/autocompute
  router.post('/acd/pivot/autocompute', async (req, res) => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const currentYear = nowET.getFullYear();
      const currentMonth = nowET.getMonth();
      const priorMonth = currentMonth === 0 ? 12 : currentMonth;
      const priorYear  = currentMonth === 0 ? currentYear - 1 : currentYear;
      const monthYear  = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;

      const priorFrom = `${priorYear}-${String(priorMonth).padStart(2, '0')}-01`;
      const priorTo   = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`;

      const r = await query(`
        SELECT
          MAX(high)   as prior_month_high,
          MIN(low)    as prior_month_low,
          (SELECT close FROM price_bars_primary WHERE symbol='NQ'
            AND ts >= $1::date AND ts < $2::date
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
            ORDER BY ts DESC LIMIT 1) as prior_month_close
        FROM price_bars_primary
        WHERE symbol = 'NQ'
          AND ts >= $1::date AND ts < $2::date
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [priorFrom, priorTo]);

      const { prior_month_high: ph, prior_month_low: pl, prior_month_close: pc } = r.rows[0];
      if (!ph || !pl || !pc) return res.status(404).json({ error: 'Insufficient bar data for prior month' });

      const pivot = (parseFloat(ph) + parseFloat(pl) + parseFloat(pc)) / 3;
      const r1 = 2 * pivot - parseFloat(pl);
      const s1 = 2 * pivot - parseFloat(ph);

      const saved = await query(`
        INSERT INTO acd_monthly_pivot (month_year, prior_month_high, prior_month_low, prior_month_close, pivot_level, pivot_r1, pivot_s1)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (month_year) DO UPDATE SET
          prior_month_high=$2, prior_month_low=$3, prior_month_close=$4,
          pivot_level=$5, pivot_r1=$6, pivot_s1=$7
        RETURNING *
      `, [monthYear, ph, pl, pc, pivot, r1, s1]);

      res.json(saved.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/correlation
  router.get('/acd/correlation', async (req, res) => {
    try {
      const accounts = req.query.accounts ? req.query.accounts.split(',') : null;
      const acctFilter = accounts?.length ? `AND t.custom_fields->>'account' = ANY($1::text[])` : '';
      const params = accounts?.length ? [accounts] : [];

      const trades = await query(`
        SELECT t.id, t.entry_time, t.exit_time, t.pnl, t.setup_type,
               t.entry_time::date::text as trade_date
        FROM trades t
        WHERE t.exit_time IS NOT NULL AND t.pnl IS NOT NULL
          ${acctFilter}
        ORDER BY t.entry_time
      `, params);

      const acdDays = await query('SELECT trade_date::text as trade_date, daily_score, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed FROM acd_daily_log');

      const acdMap = {};
      for (const d of acdDays.rows) { acdMap[d.trade_date] = d; }

      const tagged = trades.rows.map(t => {
        const rawDate = t.trade_date;
        const dateKey = typeof rawDate === 'string' ? rawDate : rawDate?.toISOString?.()?.split('T')[0] ?? '';
        const acd = acdMap[dateKey];
        const signal = acd?.a_up_fired ? 'A_UP' : acd?.a_down_fired ? 'A_DOWN' : acd ? 'NO_SIGNAL' : null;
        const confirmed = acd?.c_up_confirmed || acd?.c_down_confirmed;
        const pnl = parseFloat(t.pnl);
        return { ...t, pnl, acdSignal: signal, acdConfirmed: confirmed, acdScore: acd?.daily_score ?? null };
      });

      const withSignal  = tagged.filter(t => t.acdSignal === 'A_UP' || t.acdSignal === 'A_DOWN');
      const noSignal    = tagged.filter(t => t.acdSignal === 'NO_SIGNAL');
      const untagged    = tagged.filter(t => t.acdSignal === null);
      const aUpTrades   = tagged.filter(t => t.acdSignal === 'A_UP');
      const aDownTrades = tagged.filter(t => t.acdSignal === 'A_DOWN');
      const confirmed   = tagged.filter(t => t.acdConfirmed);

      const stats = (arr) => arr.length === 0 ? { count: 0, winRate: null, avgPnl: null } : {
        count: arr.length,
        winRate: arr.filter(t => t.pnl > 0).length / arr.length,
        avgPnl: arr.reduce((s, t) => s + t.pnl, 0) / arr.length,
      };

      res.json({
        totalTrades: tagged.length,
        acdLogDays: acdDays.rows.length,
        withSignal:  stats(withSignal),
        noSignal:    stats(noSignal),
        aUp:         stats(aUpTrades),
        aDown:       stats(aDownTrades),
        confirmed:   stats(confirmed),
        untagged: untagged.length,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Weekly ACD ──────────────────────────────────────────────────────────────

  async function computeWeeklyACD(weekStart, aMultiplier = 0.33, sustainMinutes = 5) {
    const bars = await query(`
      SELECT ts::date::text as date, to_char(ts, 'HH24:MI') as time,
             high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol = 'NQ'
        AND ts::date >= $1::date
        AND ts::date < $1::date + interval '7 days'
        AND EXTRACT(dow FROM ts::date) BETWEEN 1 AND 5
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY ts
    `, [weekStart]);

    if (bars.rows.length === 0) return null;

    const byDay = {};
    for (const b of bars.rows) {
      if (!byDay[b.date]) byDay[b.date] = [];
      byDay[b.date].push(b);
    }
    const days = Object.keys(byDay).sort();
    if (days.length < 2) return null;

    const orDay = days[0];
    const orBars = byDay[orDay];
    const orHigh = Math.max(...orBars.map(b => b.high));
    const orLow  = Math.min(...orBars.map(b => b.low));
    const orRange = orHigh - orLow;
    if (orRange === 0) return null;

    const aUp   = orHigh + orRange * aMultiplier;
    const aDown = orLow  - orRange * aMultiplier;

    const restDays = days.slice(1);
    let aUpFired = false, aUpDay = null;
    let aDownFired = false, aDownDay = null;
    let aUpTime = null, aDownTime = null;

    outer: for (const day of restDays) {
      for (const bar of byDay[day]) {
        if (!aDownTime) {
          if (!aUpTime && bar.high >= aUp) aUpTime = `${day} ${bar.time}`;
          if (aUpTime) {
            const [td, tt] = aUpTime.split(' ');
            const minsHeld = td === day
              ? (parseInt(bar.time.split(':')[0]) * 60 + parseInt(bar.time.split(':')[1])) -
                (parseInt(tt.split(':')[0]) * 60 + parseInt(tt.split(':')[1]))
              : 999;
            if (bar.low < orHigh) { aUpTime = null; }
            else if (minsHeld >= sustainMinutes) {
              aUpFired = true; aUpDay = day; break outer;
            }
          }
        }
        if (!aUpTime) {
          if (!aDownTime && bar.low <= aDown) aDownTime = `${day} ${bar.time}`;
          if (aDownTime) {
            const [td, tt] = aDownTime.split(' ');
            const minsHeld = td === day
              ? (parseInt(bar.time.split(':')[0]) * 60 + parseInt(bar.time.split(':')[1])) -
                (parseInt(tt.split(':')[0]) * 60 + parseInt(tt.split(':')[1]))
              : 999;
            if (bar.high > orLow) { aDownTime = null; }
            else if (minsHeld >= sustainMinutes) {
              aDownFired = true; aDownDay = day; break outer;
            }
          }
        }
      }
      if (aUpTime && !aUpFired) aUpTime = `${day} 999`;
      if (aDownTime && !aDownFired) aDownTime = `${day} 999`;
    }

    let cUpConfirmed = false, cDownConfirmed = false;
    for (const day of restDays) {
      const dayBars = byDay[day];
      const lastClose = dayBars[dayBars.length - 1]?.close;
      if (lastClose === undefined) continue;
      if (aUpFired   && lastClose > orHigh) { cUpConfirmed   = true; break; }
      if (aDownFired && lastClose < orLow)  { cDownConfirmed = true; break; }
    }

    let score = 0;
    if (aUpFired   && cUpConfirmed)   score =  4;
    else if (aUpFired)                score =  1;
    else if (aDownFired && cDownConfirmed) score = -4;
    else if (aDownFired)              score = -1;

    const weekClose = byDay[days[days.length - 1]]?.slice(-1)[0]?.close ?? null;

    return {
      weekStart, orDay, orHigh, orLow, aMultiplier,
      aUpLevel: Math.round(aUp * 100) / 100,
      aDownLevel: Math.round(aDown * 100) / 100,
      aUpFired, aUpDay, aDownFired, aDownDay,
      cUpConfirmed, cDownConfirmed, score, weekClose,
    };
  }

  async function saveWeeklyACD(r) {
    await query(`
      INSERT INTO acd_weekly_log
        (week_start, or_day, or_high, or_low, a_multiplier, a_up_level, a_down_level,
         a_up_fired, a_up_day, a_down_fired, a_down_day,
         c_up_confirmed, c_down_confirmed, daily_score, week_close)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (week_start) DO UPDATE SET
        or_day=$2, or_high=$3, or_low=$4, a_multiplier=$5, a_up_level=$6, a_down_level=$7,
        a_up_fired=$8, a_up_day=$9, a_down_fired=$10, a_down_day=$11,
        c_up_confirmed=$12, c_down_confirmed=$13, daily_score=$14, week_close=$15
    `, [r.weekStart, r.orDay, r.orHigh, r.orLow, r.aMultiplier,
        r.aUpLevel, r.aDownLevel, r.aUpFired, r.aUpDay, r.aDownFired, r.aDownDay,
        r.cUpConfirmed, r.cDownConfirmed, r.score, r.weekClose]);
  }

  // GET /api/acd/weekly
  router.get('/acd/weekly', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 52;
      const r = await query(`
        SELECT *, week_start::text, or_day::text, a_up_day::text, a_down_day::text
        FROM acd_weekly_log ORDER BY week_start DESC LIMIT $1
      `, [limit]);
      res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/weekly/numberline
  router.get('/acd/weekly/numberline', async (req, res) => {
    try {
      const r = await query(`
        SELECT
          week_start::text as date,
          daily_score as score,
          SUM(daily_score) OVER (ORDER BY week_start ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30,
          SUM(daily_score) OVER (ORDER BY week_start ROWS BETWEEN 9  PRECEDING AND CURRENT ROW) as nl10
        FROM acd_weekly_log
        ORDER BY week_start ASC
      `);
      const rows = r.rows.map(row => ({ date: row.date, score: parseInt(row.score), nl30: parseInt(row.nl30), nl10: parseInt(row.nl10) }));
      const latest = rows[rows.length - 1];
      const nl30 = latest?.nl30 || 0;
      const trend = nl30 > 9 ? 'TRENDING_UP' : nl30 < -9 ? 'TRENDING_DOWN' : 'RANGING';
      res.json({ nl30, nl10: latest?.nl10 || 0, trend, history: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/confluence
  router.get('/acd/confluence', async (req, res) => {
    try {
      const dNL = await query(`
        SELECT COALESCE(SUM(daily_score), 0) as nl30
        FROM (SELECT daily_score FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) s
      `);
      const dailyNL30 = parseInt(dNL.rows[0]?.nl30) || 0;
      const dailyTrend = dailyNL30 > 9 ? 'up' : dailyNL30 < -9 ? 'down' : 'ranging';

      const wNL = await query(`
        SELECT COALESCE(SUM(daily_score), 0) as nl30
        FROM (SELECT daily_score FROM acd_weekly_log ORDER BY week_start DESC LIMIT 30) s
      `);
      const weeklyNL30 = parseInt(wNL.rows[0]?.nl30) || 0;
      const weeklyTrend = weeklyNL30 > 9 ? 'up' : weeklyNL30 < -9 ? 'down' : 'ranging';

      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const monthYear = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}`;
      const pivot = await query('SELECT pivot_level FROM acd_monthly_pivot WHERE month_year=$1', [monthYear]);
      const latestBar = await query(`SELECT close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
      const nqClose = latestBar.rows[0]?.close || 0;
      const pivotLevel = parseFloat(pivot.rows[0]?.pivot_level) || null;
      const pivotBias = pivotLevel ? (nqClose > pivotLevel ? 'up' : 'down') : null;

      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const todayACD = await query(`SELECT a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
      const today = todayACD.rows[0];

      let score = 0, maxScore = 0, details = [];
      const dir = dailyTrend;

      if (dailyTrend !== 'ranging') {
        maxScore++;
        if (true) { score++; details.push({ label: 'Daily NL', state: dailyTrend, aligned: true }); }
      } else {
        details.push({ label: 'Daily NL', state: 'ranging', aligned: false });
      }

      if (weeklyTrend !== 'ranging') {
        maxScore++;
        const aligned = weeklyTrend === dir;
        if (aligned) score++;
        details.push({ label: 'Weekly NL', state: weeklyTrend, aligned });
      } else {
        details.push({ label: 'Weekly NL', state: 'ranging', aligned: false });
      }

      if (pivotBias) {
        maxScore++;
        const aligned = pivotBias === dir;
        if (aligned) score++;
        details.push({ label: 'Monthly Pivot', state: pivotBias, aligned });
      } else {
        details.push({ label: 'Monthly Pivot', state: null, aligned: false });
      }

      let holdRec, holdColor;
      if (score >= 3) { holdRec = 'Multi-day hold'; holdColor = '#22c55e'; }
      else if (score === 2) { holdRec = '1–2 day hold'; holdColor = '#86efac'; }
      else if (score === 1) { holdRec = 'Day trade only'; holdColor = '#fbbf24'; }
      else { holdRec = 'Stand aside'; holdColor = '#ef4444'; }

      res.json({
        score, maxScore, dir, holdRec, holdColor,
        dailyNL30, weeklyNL30, pivotLevel, nqClose, pivotBias,
        dailyTrend, weeklyTrend, details,
        todaySignal: today ? (today.a_up_fired ? 'A_UP' : today.a_down_fired ? 'A_DOWN' : null) : null,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/acd/weekly/autocompute/bulk
  router.get('/acd/weekly/bulk/status', (req, res) => res.json(weeklyBulkJob));

  router.post('/acd/weekly/autocompute/bulk', async (req, res) => {
    if (weeklyBulkJob.status === 'running') return res.status(409).json({ error: 'Already running' });
    const aMultiplier = parseFloat(req.body?.a_multiplier) || 0.33;
    const sustainMinutes = parseInt(req.body?.sustain_minutes) || 5;
    res.json({ message: 'Weekly ACD backfill started' });

    setImmediate(async () => {
      try {
        const weeksRes = await query(`
          SELECT DISTINCT date_trunc('week', ts::date)::date::text as week_start
          FROM price_bars_primary
          WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          ORDER BY week_start
        `);
        const weeks = weeksRes.rows.map(r => r.week_start);
        weeklyBulkJob = { status: 'running', done: 0, total: weeks.length, error: null };
        for (let i = 0; i < weeks.length; i++) {
          try {
            const r = await computeWeeklyACD(weeks[i], aMultiplier, sustainMinutes);
            if (r) await saveWeeklyACD(r);
          } catch(e) {}
          weeklyBulkJob.done = i + 1;
        }
        weeklyBulkJob = { status: 'complete', done: weeks.length, total: weeks.length, error: null };
        console.log(`Weekly ACD backfill complete: ${weeks.length} weeks`);
      } catch(e) {
        weeklyBulkJob = { status: 'error', done: weeklyBulkJob.done, total: weeklyBulkJob.total, error: e.message };
      }
    });
  });

  // GET /api/acd/nq/latest
  router.get('/acd/nq/latest', async (req, res) => {
    try {
      const r = await query(`SELECT ts, close, high, low, open FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
      if (r.rows.length === 0) return res.json(null);
      const bar = r.rows[0];
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const todayET = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const monthYear = `${nowET.getFullYear()}-${String(nowET.getMonth() + 1).padStart(2, '0')}`;
      const [pivot, arQ] = await Promise.all([
        query('SELECT * FROM acd_monthly_pivot WHERE month_year = $1', [monthYear]),
        query('SELECT opening_call_type FROM auction_reads WHERE trade_date=$1', [todayET]),
      ]);
      const pivotRow = pivot.rows[0];
      let pivotBias = null;
      if (pivotRow) {
        const price = parseFloat(bar.close);
        const pLevel = parseFloat(pivotRow.pivot_level);
        const r1 = parseFloat(pivotRow.pivot_r1);
        const s1 = parseFloat(pivotRow.pivot_s1);
        pivotBias = price > r1 ? 'ABOVE_R1' : price > pLevel ? 'ABOVE_PIVOT' : price > s1 ? 'BELOW_PIVOT' : 'BELOW_S1';
      }
      const opening_call_type = arQ.rows[0]?.opening_call_type || null;
      res.json({ ts: bar.ts, close: parseFloat(bar.close), pivot: pivotRow || null, pivotBias, barAgeMinutes: Math.round((Date.now() - new Date(bar.ts).getTime()) / 60000), opening_call_type });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/numberline/history
  router.get('/acd/numberline/history', async (req, res) => {
    try {
      const r = await query(`
        SELECT
          trade_date::text as date,
          daily_score,
          SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30,
          SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 9  PRECEDING AND CURRENT ROW) as nl10,
          SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 4  PRECEDING AND CURRENT ROW) as nl5
        FROM acd_daily_log
        ORDER BY trade_date ASC
      `);
      res.json(r.rows.map(row => ({
        date: row.date,
        score: parseInt(row.daily_score),
        nl30: parseInt(row.nl30),
        nl10: parseInt(row.nl10),
        nl5:  parseInt(row.nl5),
      })));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/setup-events/day
  router.get('/acd/setup-events/day', async (req, res) => {
    try {
      const { date } = req.query;
      if (!date) return res.status(400).json({ error: 'date required' });
      const r = await query(`
        SELECT setup_type, TO_CHAR(fired_time,'HH24:MI') as fired_time,
               fired_price::numeric(8,2), minutes_from_or
        FROM acd_setup_events WHERE trade_date=$1
        ORDER BY fired_time
      `, [date]);
      res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/setup-events/stats
  router.get('/acd/setup-events/stats', async (req, res) => {
    try {
      const r = await query(`
        SELECT
          setup_type,
          COUNT(*) as occurrences,
          ROUND(AVG(minutes_from_or)) as avg_minutes_from_or,
          MIN(minutes_from_or) as earliest_minutes,
          MAX(minutes_from_or) as latest_minutes,
          TO_CHAR(MIN(fired_time), 'HH24:MI') as earliest_time,
          TO_CHAR(MAX(fired_time), 'HH24:MI') as latest_time,
          TO_CHAR(TIME '09:35' + (ROUND(AVG(minutes_from_or)) || ' minutes')::INTERVAL, 'HH24:MI') as avg_fire_time
        FROM acd_setup_events
        GROUP BY setup_type
        ORDER BY occurrences DESC
      `);
      const dist = await query(`
        SELECT
          setup_type,
          FLOOR(minutes_from_or / 30) * 30 as bucket_minutes,
          TO_CHAR(TIME '09:35' + (FLOOR(minutes_from_or / 30) * 30 || ' minutes')::INTERVAL, 'HH24:MI') as bucket_label,
          COUNT(*) as count
        FROM acd_setup_events
        WHERE minutes_from_or >= 0
        GROUP BY setup_type, bucket_minutes
        ORDER BY setup_type, bucket_minutes
      `);
      res.json({ stats: r.rows, distribution: dist.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/setup-events
  router.get('/acd/setup-events', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const r = await query(`
        SELECT trade_date::text, setup_type, TO_CHAR(fired_time, 'HH24:MI') as fired_time,
               fired_price::numeric(8,2), minutes_from_or
        FROM acd_setup_events
        ORDER BY trade_date DESC, fired_time ASC
        LIMIT $1
      `, [limit]);
      res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/level-confidence
  router.get('/acd/level-confidence', async (req, res) => {
    try {
      // cacheGet imported at top of file
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      const latestBar = await query(`SELECT close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
      const currentPrice = latestBar.rows[0]?.close;
      if (!currentPrice) return res.json({ levels: [] });

      const nlQ = await query(`
        SELECT SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30
        FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date DESC LIMIT 1
      `);
      const nl30Val = parseInt(nlQ.rows[0]?.nl30) || 0;
      const nl30State = nl30Val > 9 ? 'BULLISH' : nl30Val < -9 ? 'BEARISH' : 'RANGING';

      const arQ = await query(`SELECT opening_call_type FROM auction_reads WHERE trade_date=$1`, [todayET]);
      const openingCall = arQ.rows[0]?.opening_call_type || null;

      const acdQ = await query(`SELECT or_high, or_low, a_up_level, a_down_level FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
      const orH = parseFloat(acdQ.rows[0]?.or_high || 0);
      const orL = parseFloat(acdQ.rows[0]?.or_low || 0);

      const ibQ = await query(`
        SELECT MAX(high)::float as ib_high, MIN(low)::float as ib_low
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
      `, [todayET]);
      const ibHigh = ibQ.rows[0]?.ib_high;
      const ibLow  = ibQ.rows[0]?.ib_low;
      const ibRange = ibHigh && ibLow ? ibHigh - ibLow : null;

      const pdQ = await query(`
        SELECT acd_daily_log.or_high, acd_daily_log.or_low FROM acd_daily_log
        WHERE trade_date < $1 AND or_high IS NOT NULL ORDER BY trade_date DESC LIMIT 1
      `, [todayET]);

      const prevDay = pdQ.rows[0];
      let pdVAH = null, pdVAL = null;
      if (prevDay) {
        const vaQ = await query(`
          SELECT vah::float as vah, val::float as val
          FROM developing_value_log
          WHERE trade_date = (SELECT MAX(trade_date) FROM acd_daily_log WHERE trade_date < $1)
        `, [todayET]);
        if (vaQ.rows[0]) {
          pdVAH = vaQ.rows[0].vah;
          pdVAL = vaQ.rows[0].val;
        } else {
          // fallback to pdBars calculation
          const pdBars = await query(`
            SELECT high::float as high, low::float as low, close::float as close, volume::integer as volume
            FROM price_bars_primary WHERE symbol='NQ' AND ts::date=(SELECT MAX(trade_date) FROM acd_daily_log WHERE trade_date < $1)
              AND (EXTRACT(hour FROM ts)=9 AND EXTRACT(minute FROM ts)>=30 OR EXTRACT(hour FROM ts) BETWEEN 10 AND 15)
          `, [todayET]);
          if (pdBars.rows.length) {
            const priceMap = {};
            let totalV = 0;
            for (const b of pdBars.rows) {
              const v = b.volume || 0;
              for (let p = Math.round(b.low / 0.25) * 0.25; p <= b.high + 0.01; p += 0.25) {
                const k = p.toFixed(2);
                priceMap[k] = (priceMap[k] || 0) + v / Math.max(1, Math.round((b.high - b.low) / 0.25) + 1);
                totalV += v / Math.max(1, Math.round((b.high - b.low) / 0.25) + 1);
              }
            }
            const poc = parseFloat(Object.entries(priceMap).sort((a,b) => b[1]-a[1])[0]?.[0]);
            if (poc && totalV > 0) {
              const sorted70 = Object.entries(priceMap).filter(([p]) => parseFloat(p) >= poc)
                .sort((a,b) => b[1]-a[1]);
              let cumVah = 0;
              pdVAH = poc;
              for (const [p,v] of sorted70) { cumVah += v; pdVAH = Math.max(pdVAH, parseFloat(p)); if (cumVah >= totalV * 0.35) break; }
              const sorted70dn = Object.entries(priceMap).filter(([p]) => parseFloat(p) <= poc)
                .sort((a,b) => b[1]-a[1]);
              let cumVal = 0;
              pdVAL = poc;
              for (const [p,v] of sorted70dn) { cumVal += v; pdVAL = Math.min(pdVAL, parseFloat(p)); if (cumVal >= totalV * 0.35) break; }
            }
          }
        }
      }

      const candidates = [
        { key: 'ibh',    price: ibHigh, label: 'IB High',         side: 'resistance' },
        { key: 'ibl',    price: ibLow,  label: 'IB Low',          side: 'support'    },
        { key: 'ibhExt', price: ibHigh && ibRange ? ibHigh + ibRange : null, label: 'IB High +1×', side: 'resistance' },
        { key: 'iblExt', price: ibLow  && ibRange ? ibLow  - ibRange : null, label: 'IB Low -1×',  side: 'support'    },
        { key: 'pdvah',  price: pdVAH,  label: 'PD VAH',          side: 'resistance' },
        { key: 'pdval',  price: pdVAL,  label: 'PD VAL',          side: 'support'    },
      ].filter(c => c.price != null);

      const klCacheKey = `kl||||2.5|`;
      let klData = cacheGet(klCacheKey) || cacheGet(`kl||||10|`) || cacheGet(`kl||||5|`);

      const getCondRate = (levelKey, side, condKey, condVal) => {
        if (!klData) return null;
        const levelData = klData.byLevel?.find(l => l.key === levelKey);
        if (!levelData) return null;
        const sideData = levelData[side];
        if (!sideData?.conditionBreakdown) return null;
        const dim = sideData.conditionBreakdown[condKey];
        return dim?.[condVal] || null;
      };

      const PROX = 60;
      const nearLevels = candidates
        .map(c => {
          const dist = Math.abs(c.price - currentPrice);
          if (dist > PROX) return null;
          const rawRate = getCondRate(c.key, c.side, 'byNL30', nl30State);
          const ocRate  = openingCall ? getCondRate(c.key, c.side, 'byOpeningCall', openingCall) : null;
          const unfiltered = (() => {
            if (!klData) return null;
            const ld = klData.byLevel?.find(l => l.key === c.key);
            return ld?.[c.side]?.respectRate ?? null;
          })();
          return {
            key: c.key, label: c.label, price: +c.price.toFixed(2),
            side: c.side, dist: +dist.toFixed(1),
            approaching: c.side === 'resistance' ? currentPrice < c.price : currentPrice > c.price,
            respectRate: unfiltered,
            nl30Filtered: rawRate ? { rate: rawRate.respectRate, touches: rawRate.touches, condition: nl30State } : null,
            openCallFiltered: ocRate ? { rate: ocRate.respectRate, touches: ocRate.touches, condition: openingCall } : null,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.dist - b.dist);

      res.json({ currentPrice, nl30State, openingCall, nl30: nl30Val, nearLevels });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/auction-read/day-setups (moved here as it uses ACD data)
  router.get('/auction-read/day-setups', async (req, res) => {
    try {
      const { date } = req.query;
      if (!date) return res.status(400).json({ error: 'date required' });

      const barsR = await query(`
        SELECT ts, open::float, high::float, low::float, close::float, volume::bigint,
               SUM(close::float * volume::bigint) OVER (ORDER BY ts) /
               NULLIF(SUM(volume::bigint) OVER (ORDER BY ts), 0) as vwap_running
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960
        ORDER BY ts
      `, [date]);
      const bars = barsR.rows;
      if (!bars.length) return res.json([]);

      const priorR = await query(`
        SELECT MAX(ts::date::text) as prior_date FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [date]);
      const priorDate = priorR.rows[0]?.prior_date;

      let pdHigh = null, pdLow = null, pdVAH = null, pdVAL = null, onHigh = null, onLow = null;
      if (priorDate) {
        const pd = await query(`
          SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        `, [priorDate]);
        pdHigh = pd.rows[0]?.h; pdLow = pd.rows[0]?.l;

        const vaR = await query(`
          SELECT poc::float as poc, vah::float as vah, val::float as val
          FROM developing_value_log
          WHERE trade_date = $1
        `, [priorDate]);
        if (vaR.rows[0]) {
          pdVAH = vaR.rows[0].vah;
          pdVAL = vaR.rows[0].val;
        } else {
          // fallback
          const fallbackQ = await query(`
            WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
            total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1)
            SELECT p2.px::float as poc,
              (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
              (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
            FROM vp, poc_row p2 GROUP BY p2.px LIMIT 1
          `, [priorDate]);
          pdVAH = fallbackQ.rows[0]?.vah;
          pdVAL = fallbackQ.rows[0]?.val;
        }

        const onR = await query(`
          SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date=$1 AND (EXTRACT(hour FROM ts) >= 16 OR EXTRACT(hour FROM ts) < 9)
        `, [priorDate]);
        onHigh = onR.rows[0]?.h; onLow = onR.rows[0]?.l;
      }

      const acdR = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [date]);
      const ibHigh = acdR.rows[0]?.or_high, ibLow = acdR.rows[0]?.or_low;

      const keyLevels = [
        { key: 'IBH',    price: ibHigh,  type: 'resistance', desc: 'Initial Balance High' },
        { key: 'IBL',    price: ibLow,   type: 'support',    desc: 'Initial Balance Low'  },
        { key: 'PD VAH', price: pdVAH,   type: 'resistance', desc: 'Prior Day Value Area High' },
        { key: 'PD VAL', price: pdVAL,   type: 'support',    desc: 'Prior Day Value Area Low'  },
        { key: 'PD High',price: pdHigh,  type: 'resistance', desc: 'Prior Day High' },
        { key: 'PD Low', price: pdLow,   type: 'support',    desc: 'Prior Day Low'  },
        { key: 'ON High',price: onHigh,  type: 'resistance', desc: 'Overnight High'  },
        { key: 'ON Low', price: onLow,   type: 'support',    desc: 'Overnight Low'   },
      ].filter(l => l.price);

      const TOUCH_RANGE = 8;
      const MEASURE_BARS = 30;
      const MIN_MOVE = 15;

      const profitable = [];

      for (const lvl of keyLevels) {
        const p = parseFloat(lvl.price);
        for (let i = 10; i < bars.length - MEASURE_BARS; i++) {
          const bar = bars[i];
          const touched = lvl.type === 'resistance'
            ? bar.high >= p - TOUCH_RANGE && bar.high <= p + TOUCH_RANGE
            : bar.low <= p + TOUCH_RANGE && bar.low >= p - TOUCH_RANGE;
          if (!touched) continue;

          const futBars = bars.slice(i + 1, i + MEASURE_BARS + 1);
          const futClose = futBars[futBars.length - 1]?.close;
          if (!futClose) break;

          const move = lvl.type === 'resistance'
            ? bar.high - Math.min(...futBars.map(b => b.low))
            : Math.max(...futBars.map(b => b.high)) - bar.low;

          if (move >= MIN_MOVE) {
            const time = new Date(bar.ts).toISOString().slice(11, 16);
            profitable.push({
              type: 'KEY_LEVEL',
              setup: lvl.key,
              desc: lvl.desc,
              level_type: lvl.type,
              price: p,
              time,
              move_pts: Math.round(move),
              direction: lvl.type === 'resistance' ? 'SHORT' : 'LONG',
            });
          }
          break;
        }
      }

      const acdEvents = await query(`
        SELECT setup_type, TO_CHAR(fired_time,'HH24:MI') as fired_time, fired_price::float
        FROM acd_setup_events WHERE trade_date=$1 ORDER BY fired_time
      `, [date]);

      for (const ev of acdEvents.rows) {
        const isLong  = ev.setup_type?.includes('A_UP') && !ev.setup_type?.includes('Failed');
        const isShort = ev.setup_type?.includes('A_DOWN') && !ev.setup_type?.includes('Failed') ||
                        ev.setup_type?.includes('Failed_A_Up');
        const isLong2 = ev.setup_type?.includes('Failed_A_Down');
        if (!isLong && !isShort && !isLong2) continue;

        const barIdx = bars.findIndex(b => new Date(b.ts).toISOString().slice(11, 16) === ev.fired_time);
        if (barIdx < 0 || barIdx >= bars.length - MEASURE_BARS) continue;

        const futBars = bars.slice(barIdx + 1, barIdx + MEASURE_BARS + 1);
        if (!futBars.length) continue;

        const entryPrice = parseFloat(ev.fired_price);
        let movePts;
        if (isLong || isLong2) {
          movePts = Math.max(...futBars.map(b => b.high)) - entryPrice;
        } else {
          movePts = entryPrice - Math.min(...futBars.map(b => b.low));
        }

        if (movePts >= MIN_MOVE) {
          profitable.push({
            type: 'ACD',
            setup: ev.setup_type.replace(/_/g, ' '),
            desc: '',
            level_type: (isLong || isLong2) ? 'support' : 'resistance',
            price: entryPrice,
            time: ev.fired_time,
            move_pts: Math.round(movePts),
            direction: (isLong || isLong2) ? 'LONG' : 'SHORT',
          });
        }
      }

      for (let i = 10; i < bars.length - MEASURE_BARS; i++) {
        const bar = bars[i];
        const vwap = bar.vwap_running;
        if (!vwap) continue;
        const prev = bars[i - 1];
        if (!prev?.vwap_running) continue;
        const crossUp   = prev.close < prev.vwap_running && bar.close > vwap;
        const crossDown = prev.close > prev.vwap_running && bar.close < vwap;
        if (!crossUp && !crossDown) continue;

        const futBars = bars.slice(i + 1, i + MEASURE_BARS + 1);
        const move = crossUp
          ? Math.max(...futBars.map(b => b.high)) - bar.close
          : bar.close - Math.min(...futBars.map(b => b.low));

        if (move >= MIN_MOVE) {
          const time = new Date(bar.ts).toISOString().slice(11, 16);
          profitable.push({
            type: 'VWAP',
            setup: crossUp ? 'VWAP Reclaim' : 'VWAP Break',
            desc: crossUp ? 'Price crossed above VWAP — buyers taking control' : 'Price crossed below VWAP — sellers taking control',
            level_type: crossUp ? 'support' : 'resistance',
            price: parseFloat(vwap.toFixed(2)),
            time,
            move_pts: Math.round(move),
            direction: crossUp ? 'LONG' : 'SHORT',
          });
          break;
        }
      }

      profitable.sort((a, b) => b.move_pts - a.move_pts);
      res.json(profitable);
    } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
  });

      router.get('/acd/live', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      // Get today's logged OR and A levels
      const logged = await query(`SELECT or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
      if (!logged.rows.length || !logged.rows[0].or_high) return res.json({ setup: null, reason: 'No OR data for today' });

      // G-Line: CME weekly open — defined once in services/queries.js
      const todayForGLine = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const gLine = await getGLine(todayForGLine);

      // G-Line days held (prior sessions this week only — today not yet closed)
      let gLineDaysHeld = 0;
      if (gLine) {
        try {
          const weeklyQ = await query(`
            SELECT ts::date as session_date,
                   (array_agg(close ORDER BY ts DESC))[1]::float as session_close
            FROM price_bars_primary
            WHERE symbol='NQ'
              AND ts::date >= date_trunc('week', ($1::text)::date)
              AND ts::date < ($1::text)::date
              AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 960
            GROUP BY ts::date ORDER BY ts::date ASC
          `, [todayET]);
          for (const s of weeklyQ.rows) { if (s.session_close > gLine) gLineDaysHeld++; }
        } catch (_) {}
      }

      // Prior week RTH high/low
      const pwQ = await query(`
        SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low
        FROM price_bars_primary WHERE symbol='NQ'
          AND ts::date >= date_trunc('week', CURRENT_DATE) - INTERVAL '7 days'
          AND ts::date <  date_trunc('week', CURRENT_DATE)
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `);
      const pwHigh = pwQ.rows[0]?.pw_high || null;
      const pwLow  = pwQ.rows[0]?.pw_low  || null;

      // Prior month value area (VAH/POC/VAL from volume profile)
      const pmVaQ = await query(`
        WITH vp AS (
          SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
          FROM price_bars_primary WHERE symbol='NQ'
            AND date_trunc('month', ts) = date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ROUND(low/0.25)*0.25
        ), total AS (SELECT SUM(vol) as t FROM vp),
        poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT p.poc_px::float as poc,
          (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
          (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
        FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
      `);
      const pmVAH = pmVaQ.rows[0]?.vah || null;
      const pmVAL = pmVaQ.rows[0]?.val || null;
      const pmPOC = pmVaQ.rows[0]?.poc || null;

      const { or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired } = logged.rows[0];
      const orH = parseFloat(or_high), orL = parseFloat(or_low);
      const aUp = parseFloat(a_up_level), aDown = parseFloat(a_down_level);
      const orRange = orH - orL;
      const orEndMin = 9 * 60 + 35; // 09:35 ET

      // Get today's post-OR bars — RTH only (9:35–16:00)
      // After-hours bars would give false signals since ACD is a morning-session framework
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const isRTH = nowET.getHours() < 16 || (nowET.getHours() === 16 && nowET.getMinutes() === 0);
      const rthEndMin = 16 * 60; // 16:00

      const bars = await query(`
        SELECT ts, open::float, high::float, low::float, close::float, volume::bigint,
               EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as bar_min
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= $2
          AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) <= $3
        ORDER BY ts
      `, [todayET, orEndMin, rthEndMin]);

      if (!bars.rows.length) return res.json({ setup: null, reason: 'No post-OR bars yet' });

      const postOR = bars.rows;
      const sessionHigh = Math.max(...postOR.map(b => b.high));
      const sessionLow  = Math.min(...postOR.map(b => b.low));
      const latestBar   = postOR[postOR.length - 1];
      const currentPrice = latestBar.close;
      const barTime = new Date(latestBar.ts).toISOString().slice(11, 16);

      // G-Line status vs current price
      let gLineStatus = null;
      if (gLine) {
        const TESTING_THRESHOLD = 15;
        if (Math.abs(currentPrice - gLine) <= TESTING_THRESHOLD) gLineStatus = 'testing';
        else if (currentPrice > gLine) gLineStatus = 'held';
        else gLineStatus = 'broken';
      }

      // Weis effort-vs-result warning: volume AND body declining on last 3 bars while signal active
      let weisWarning = false;
      if ((a_up_fired || a_down_fired) && postOR.length >= 3) {
        const last3 = postOR.slice(-3); // [oldest, middle, newest]
        const [b0, b1, b2] = last3;     // b2 = most recent
        const vol0 = Number(b0.volume), vol1 = Number(b1.volume), vol2 = Number(b2.volume);
        const body0 = Math.abs(b0.close - b0.open);
        const body1 = Math.abs(b1.close - b1.open);
        const body2 = Math.abs(b2.close - b2.open);
        const volDeclining  = vol2  < vol1  && vol1  < vol0;
        const bodyDeclining = body2 < body1 && body1 < body0;
        weisWarning = volDeclining && bodyDeclining;
      }

      // Detect all 6 setups
      const reachedAUp   = sessionHigh >= aUp;
      const reachedADown = sessionLow  <= aDown;
      const cUp   = postOR.some(b => b.close > orH);
      const cDown = postOR.some(b => b.close < orL);

      // Failed A: reached level but price has since fallen back inside OR (or below OR High / above OR Low)
      const failedAUp   = reachedAUp   && !a_up_fired   && currentPrice < orH;
      const failedADown = reachedADown && !a_down_fired  && currentPrice > orL;

      // Determine active setup (priority order)
      let setup = null, color = '#94a3b8', description = '';

      if (a_up_fired && cUp) {
        setup = 'A Up + C Confirmed'; color = '#22c55e';
        description = `A Up fired and C Up confirmed. Strong continuation long. Price ${currentPrice.toFixed(2)}, above OR High ${orH.toFixed(2)}.`;
      } else if (a_up_fired && !cUp) {
        setup = 'A Up (no C yet)'; color = '#86efac';
        description = `A Up fired. Waiting for C Up confirmation (close above OR High ${orH.toFixed(2)}). Still valid long.`;
      } else if (a_down_fired && cDown) {
        setup = 'A Down + C Confirmed'; color = '#ef4444';
        description = `A Down fired and C Down confirmed. Strong continuation short. Price ${currentPrice.toFixed(2)}, below OR Low ${orL.toFixed(2)}.`;
      } else if (a_down_fired && !cDown) {
        setup = 'A Down (no C yet)'; color = '#fca5a5';
        description = `A Down fired. Waiting for C Down confirmation (close below OR Low ${orL.toFixed(2)}). Still valid short.`;
      } else if (failedAUp) {
        setup = 'Failed A Up'; color = '#f97316';
        description = `Price reached A Up (${aUp.toFixed(2)}) but failed to sustain — fell back below OR High (${orH.toFixed(2)}). Short setup. Entry near OR High, stop above session high (${sessionHigh.toFixed(2)}).`;
      } else if (failedADown) {
        setup = 'Failed A Down'; color = '#a78bfa';
        description = `Price reached A Down (${aDown.toFixed(2)}) but failed to sustain — rose back above OR Low (${orL.toFixed(2)}). Long setup. Entry near OR Low, stop below session low (${sessionLow.toFixed(2)}).`;
      } else if (reachedAUp) {
        setup = 'Testing A Up'; color = '#fbbf24';
        description = `Price reached A Up level (${aUp.toFixed(2)}). Watching for 5-minute sustain above OR High for long entry, or failure for short entry.`;
      } else if (reachedADown) {
        setup = 'Testing A Down'; color = '#fbbf24';
        description = `Price reached A Down level (${aDown.toFixed(2)}). Watching for 5-minute sustain below OR Low for short entry, or failure for long entry.`;
      } else if (cUp && !a_up_fired) {
        setup = 'C Up (no A)'; color = '#6ee7b7';
        description = `A bar closed above OR High (${orH.toFixed(2)}) without A Up firing first. Weaker signal — price accepted above OR but didn't break the A level.`;
      } else if (cDown && !a_down_fired) {
        setup = 'C Down (no A)'; color = '#fda4af';
        description = `A bar closed below OR Low (${orL.toFixed(2)}) without A Down firing first. Weaker signal.`;
      } else {
        const distToAUp   = aUp - currentPrice;
        const distToADown = currentPrice - aDown;
        setup = 'No signal'; color = '#64748b';
        description = `No setup yet. Price ${currentPrice.toFixed(2)} — ${distToAUp.toFixed(0)} pts from A Up (${aUp.toFixed(2)}), ${distToADown.toFixed(0)} pts from A Down (${aDown.toFixed(2)}).`;
      }

      // Build session timeline — with cooldown flags to prevent re-triggering on same touch
      const timeline = [];
      let aUpTouchTime = null, aDownTouchTime = null;
      let aUpFiredTimeline = false, aDownFiredTimeline = false;
      // aUpHeld: true while A Up is active after firing; set false if price reverses below OR High
      let aUpHeld = false;
      let failedAUpCount = 0, failedADownCount = 0;
      let aUpCooldown2 = 0, aDownCooldown2 = 0;
      let cUpLogged = false, cDownLogged = false;

      for (const bar of postOR) {
        const t = new Date(bar.ts).toISOString().slice(11, 16);
        const barMinutes = bar.bar_min;

        if (aUpCooldown2 > 0) aUpCooldown2--;
        if (aDownCooldown2 > 0) aDownCooldown2--;

        // Track A Up path — keep tracking even after fire to catch reversals and re-tests
        if (!aDownFiredTimeline) {
          // Pre-fire: detect initial test and sustained fire
          if (!aUpFiredTimeline) {
            if (!aUpTouchTime && aUpCooldown2 === 0 && bar.high >= aUp) {
              aUpTouchTime = t;
              const testLabel = failedAUpCount > 0 ? ` (re-test ${failedAUpCount + 1})` : '';
              timeline.push({ time: t, event: `A Up tested${testLabel}`, price: aUp, color: '#fbbf24',
                note: `Price reached the A Up level (${aUp.toFixed(2)})${failedAUpCount > 0 ? ' again after a prior failure' : ''}. The 5-minute sustain clock has started — if price holds above OR High (${orH.toFixed(2)}) without pulling back inside the OR, A Up fires and a long entry is valid.` });
            }
            if (aUpTouchTime) {
              if (bar.low < orH) {
                failedAUpCount++;
                const attemptLabel = failedAUpCount > 1 ? ` (attempt ${failedAUpCount})` : '';
                timeline.push({ time: t, event: `Failed A Up${attemptLabel}`, price: bar.close, color: '#f97316',
                  note: `Price reached the A Up level${failedAUpCount > 1 ? ' again' : ''} but fell back below OR High (${orH.toFixed(2)}) before sustaining 5 minutes. ${failedAUpCount > 1 ? 'Second failure — stronger conviction that bulls cannot hold this level. ' : ''}Short setup: entry near OR High on the reversal, stop above session high (${sessionHigh.toFixed(2)}).` });
                aUpTouchTime = null; aUpCooldown2 = 15;
              } else if (barMinutes - (parseInt(aUpTouchTime.split(':')[0])*60 + parseInt(aUpTouchTime.split(':')[1])) >= 5) {
                aUpFiredTimeline = true; aUpHeld = true;
                timeline.push({ time: t, event: 'A Up fired', price: aUp, color: '#22c55e',
                  note: `A Up confirmed — price held above OR High (${orH.toFixed(2)}) for 5 consecutive minutes. Long entry at ${aUp.toFixed(2)}, stop at OR Low (${orL.toFixed(2)}). Hold duration depends on confluence score.` });
                aUpTouchTime = null;
              }
            }
          } else {
            // Post-fire: track if price reverses below OR High (Failed to hold) then re-tests
            if (bar.low < orH && aUpTouchTime !== 'reversed') {
              aUpTouchTime = 'reversed'; aUpHeld = false;
              failedAUpCount++;
              const attemptLabel = failedAUpCount > 1 ? ` (attempt ${failedAUpCount})` : '';
              timeline.push({ time: t, event: `Failed A Up${attemptLabel}`, price: bar.close, color: '#f97316',
                note: `A Up had fired but price reversed back below OR High (${orH.toFixed(2)}). The breakout failed to hold — short setup. Entry near OR High, stop above session high (${sessionHigh.toFixed(2)}).` });
            } else if (aUpTouchTime === 'reversed' && bar.high >= aUp) {
              // Price re-tested A Up after reversal — reset for next failure detection
              aUpTouchTime = t;
              timeline.push({ time: t, event: `A Up tested (re-test ${failedAUpCount + 1})`, price: aUp, color: '#fbbf24',
                note: `Price returned to the A Up level (${aUp.toFixed(2)}) after a prior failure. Watching for sustained hold or another rejection.` });
            } else if (aUpTouchTime !== null && aUpTouchTime !== 'reversed' && bar.low < orH) {
              failedAUpCount++;
              timeline.push({ time: t, event: `Failed A Up (attempt ${failedAUpCount})`, price: bar.close, color: '#f97316',
                note: `Price reached A Up again but failed to hold above OR High (${orH.toFixed(2)}). Repeated failure strengthens the short case.` });
              aUpTouchTime = 'reversed';
            }
          }
        }

        // Track A Down path — allowed if A Up never fired, or if A Up fired but reversed (no longer held)
        if (!aUpHeld) {
          if (!aDownTouchTime && aDownCooldown2 === 0 && bar.low <= aDown) {
            aDownTouchTime = t;
            timeline.push({ time: t, event: failedADownCount > 0 ? `A Down tested (re-test ${failedADownCount+1})` : 'A Down tested', price: aDown, color: '#fbbf24',
              note: `Price reached the A Down level (${aDown.toFixed(2)}) for the first time. The 5-minute sustain clock has started — if price holds below OR Low (${orL.toFixed(2)}) without pulling back inside the OR, A Down fires and a short entry is valid.` });
          }
          if (aDownTouchTime && !aDownFiredTimeline) {
            if (bar.high > orL) {
              failedADownCount++;
              const attemptLabelD = failedADownCount > 1 ? ` (attempt ${failedADownCount})` : '';
              timeline.push({ time: t, event: `Failed A Down${attemptLabelD}`, price: bar.close, color: '#a78bfa',
                note: `Price reached the A Down level${failedADownCount > 1 ? ' again' : ''} but rose back above OR Low (${orL.toFixed(2)}) before sustaining 5 minutes. ${failedADownCount > 1 ? 'Second failure — stronger conviction bears cannot hold. ' : ''}Long setup: entry near OR Low on the bounce, stop below the session low (${sessionLow.toFixed(2)}).` });
              aDownTouchTime = null; aDownCooldown2 = 15;
            } else if (barMinutes - (parseInt(aDownTouchTime.split(':')[0])*60 + parseInt(aDownTouchTime.split(':')[1])) >= 5) {
              aDownFiredTimeline = true;
              timeline.push({ time: t, event: 'A Down fired', price: aDown, color: '#ef4444',
                note: `A Down confirmed — price held below OR Low (${orL.toFixed(2)}) for 5 consecutive minutes without pulling back inside the OR. Short entry at ${aDown.toFixed(2)}, stop at OR High (${orH.toFixed(2)}). Hold duration depends on confluence score.` });
            }
          }
        }

        // C confirmations
        // G-Line (weekly open) — first touch, first close below (lost), first close above after lost (reclaimed)
        if (gLine) {
          if (!timeline.some(e => e.event.startsWith('G-Line')) && bar.low <= gLine && bar.high >= gLine) {
            timeline.push({ time: t, event: 'G-Line tested', price: gLine, color: '#f59e0b',
              note: `Price tested the G-Line (${gLine.toFixed(2)}) — the weekly open from Monday's session.\n\nAbove G-Line = week is positive / buyers in control. Below = week is negative / sellers in control. First test of this level is the key tell: does it hold or break?` });
          }
          if (!timeline.some(e => e.event === 'G-Line lost') && bar.close < gLine) {
            timeline.push({ time: t, event: 'G-Line lost', price: bar.close, color: '#f59e0b',
              note: `Price closed below the G-Line (${gLine.toFixed(2)}) — the weekly open. The week has turned negative. Sellers are in control of the weekly timeframe. A Down signals and short setups now have structural weekly tailwind.` });
          }
          if (timeline.some(e => e.event === 'G-Line lost') && !timeline.some(e => e.event === 'G-Line reclaimed') && bar.close > gLine) {
            timeline.push({ time: t, event: 'G-Line reclaimed', price: bar.close, color: '#f59e0b',
              note: `Price reclaimed the G-Line (${gLine.toFixed(2)}) after losing it — closed back above the weekly open. Bullish recovery. Week has turned positive again. A Up signals now have structural weekly tailwind.` });
          }
        }

        // Prior month VAH — first touch and first close-through
        if (pmVAH) {
          if (!timeline.some(e => e.event.startsWith('PM VAH')) && bar.high >= pmVAH) {
            timeline.push({ time: t, event: 'PM VAH tested', price: pmVAH, color: '#10b981',
              note: `Price touched the prior month value area high (${pmVAH.toFixed(0)}) — the top of where 70% of last month's volume was accepted.\n\nAbove PM VAH = price is above monthly accepted value — buyers accepting prices beyond last month's range. Strongly initiative on the monthly timeframe.\nBelow PM VAH = still within or below monthly value — responsive territory.` });
          }
          if (!timeline.some(e => e.event === 'PM VAH broken') && bar.close > pmVAH) {
            timeline.push({ time: t, event: 'PM VAH broken', price: bar.close, color: '#10b981',
              note: `A bar closed above the prior month value area high (${pmVAH.toFixed(0)}) — price accepted above the monthly range. Multi-timeframe bullish structural shift. Prior month VAH flips to support on the monthly timeframe.` });
          }
        }
        // Prior month VAL — first touch and first close-through
        if (pmVAL) {
          if (!timeline.some(e => e.event.startsWith('PM VAL')) && bar.low <= pmVAL) {
            timeline.push({ time: t, event: 'PM VAL tested', price: pmVAL, color: '#10b981',
              note: `Price touched the prior month value area low (${pmVAL.toFixed(0)}) — the bottom of where 70% of last month's volume was accepted.\n\nBelow PM VAL = price accepted below monthly value — sellers pushing below last month's range. Strongly initiative bearish.\nAbove PM VAL = still within monthly value — responsive territory.` });
          }
          if (!timeline.some(e => e.event === 'PM VAL broken') && bar.close < pmVAL) {
            timeline.push({ time: t, event: 'PM VAL broken', price: bar.close, color: '#10b981',
              note: `A bar closed below the prior month value area low (${pmVAL.toFixed(0)}) — price accepted below the monthly range. Bearish multi-timeframe structural shift.` });
          }
        }

        // PW High — first touch and first close-through
        if (pwHigh) {
          if (!timeline.some(e => e.event === 'PW High tested' || e.event === 'PW High broken') && bar.high >= pwHigh) {
            timeline.push({ time: t, event: 'PW High tested', price: pwHigh, color: '#c084fc',
              note: `Price touched the prior week high (${pwHigh.toFixed(2)}). Key resistance — the highest price traded during last week's RTH session. A close above confirms acceptance at a new weekly high; rejection here is a short lean.` });
          }
          if (!timeline.some(e => e.event === 'PW High broken') && bar.close > pwHigh) {
            timeline.push({ time: t, event: 'PW High broken', price: bar.close, color: '#c084fc',
              note: `A bar closed above the prior week high (${pwHigh.toFixed(2)}) — price is being accepted above last week's range. Bullish structural shift. Dalton: new value is being established above the prior reference. Prior week high now acts as support.` });
          }
        }
        // PW Low — first touch and first close-through
        if (pwLow) {
          if (!timeline.some(e => e.event === 'PW Low tested' || e.event === 'PW Low broken') && bar.low <= pwLow) {
            timeline.push({ time: t, event: 'PW Low tested', price: pwLow, color: '#c084fc',
              note: `Price touched the prior week low (${pwLow.toFixed(2)}). Key support — the lowest price traded during last week's RTH session. A close below confirms acceptance at a new weekly low; bounce here is a long lean.` });
          }
          if (!timeline.some(e => e.event === 'PW Low broken') && bar.close < pwLow) {
            timeline.push({ time: t, event: 'PW Low broken', price: bar.close, color: '#c084fc',
              note: `A bar closed below the prior week low (${pwLow.toFixed(2)}) — price is being accepted below last week's range. Bearish structural shift. Dalton: new value being established lower. Prior week low now acts as resistance.` });
          }
        }

        if (!cUpLogged && bar.close > orH) {
          cUpLogged = true;
          timeline.push({ time: t, event: aUpFiredTimeline ? 'C Up confirmed' : 'C Up (no A)', price: bar.close, color: aUpFiredTimeline ? '#22c55e' : '#6ee7b7',
            note: aUpFiredTimeline
              ? `A bar closed above OR High (${orH.toFixed(2)}) after A Up already fired. C confirmation means price is being accepted above the opening range — the breakout has follow-through. Strengthens the long case and supports holding the position.`
              : aDownFiredTimeline
                ? `A bar closed above OR High (${orH.toFixed(2)}) after A Down had fired. A Down sellers are now trapped — price above OR High invalidates the short premise and forces short covering.`
                : `A bar closed above OR High (${orH.toFixed(2)}) without A Up firing first. Weaker signal — price accepted above OR but didn't break the A level (${aUp.toFixed(2)}) with sustained conviction. Can still lean long but treat as lower confidence.` });
          // A Down fired earlier but price is now above OR High → TRT Long alert
          if (aDownFiredTimeline && !aUpFiredTimeline) {
            timeline.push({ time: t, event: 'TRT Long potential', price: bar.close, color: '#f59e0b',
              note: `C Up after A Down — potential TRT Long. A Down sellers trapped above OR High (${orH.toFixed(2)}). Short thesis invalidated. Trapped shorts covering fuels upside squeeze. Watch for entry on reclaim/hold of OR High as support. Stop below OR Low (${orL.toFixed(2)}).` });
          }
        }
        if (!cDownLogged && bar.close < orL) {
          cDownLogged = true;
          timeline.push({ time: t, event: aDownFiredTimeline ? 'C Down confirmed' : 'C Down (no A)', price: bar.close, color: aDownFiredTimeline ? '#ef4444' : '#fda4af',
            note: aDownFiredTimeline
              ? `A bar closed below OR Low (${orL.toFixed(2)}) after A Down already fired. C confirmation means price is being accepted below the opening range — the breakdown has follow-through. Strengthens the short case.`
              : `A bar closed below OR Low (${orL.toFixed(2)}) without A Down firing first. Weaker signal — price dipped below OR but didn't reach the A Down level (${aDown.toFixed(2)}). Likely a probe that lacked conviction. Lower confidence short lean.` });
        }
      }

      // Generate plain-English narrative of the session
      const narrative = [];

      // Opening
      narrative.push(`NQ opened with a ${orRange.toFixed(0)}-point opening range: high ${orH.toFixed(2)}, low ${orL.toFixed(2)}. A Up level: ${aUp.toFixed(2)}, A Down level: ${aDown.toFixed(2)}.`);

      // Walk through timeline events
      for (const ev of timeline) {
        if (ev.event === 'A Up tested') {
          narrative.push(`At ${ev.time}, price reached the A Up level (${aUp.toFixed(2)}). The 5-minute sustain clock started.`);
        } else if (ev.event === 'A Up fired') {
          narrative.push(`At ${ev.time}, A Up confirmed — price held above OR High for 5 minutes. Long signal active. Entry ${aUp.toFixed(2)}, stop at OR Low ${orL.toFixed(2)}.`);
        } else if (ev.event === 'Failed A Up') {
          narrative.push(`At ${ev.time}, the A Up attempt failed — price pulled back inside the OR (below ${orH.toFixed(2)}) before sustaining 5 minutes. This failure is a short setup: the bulls showed up, couldn't hold it. Entry near OR High on the way down, stop above the session high (${sessionHigh.toFixed(2)}).`);
        } else if (ev.event === 'A Down tested') {
          narrative.push(`At ${ev.time}, price reached the A Down level (${aDown.toFixed(2)}). The 5-minute sustain clock started.`);
        } else if (ev.event === 'A Down fired') {
          narrative.push(`At ${ev.time}, A Down confirmed — price held below OR Low for 5 minutes. Short signal active. Entry ${aDown.toFixed(2)}, stop at OR High ${orH.toFixed(2)}.`);
        } else if (ev.event === 'Failed A Down') {
          narrative.push(`At ${ev.time}, the A Down attempt failed — price recovered back inside the OR (above ${orL.toFixed(2)}). Long setup: the bears failed. Entry near OR Low on the bounce, stop below session low (${sessionLow.toFixed(2)}).`);
        } else if (ev.event === 'C Up confirmed') {
          narrative.push(`At ${ev.time}, C Up confirmed (close at ${ev.price.toFixed(2)}, above OR High ${orH.toFixed(2)}). Price is being accepted above the opening range — confirms the A Up signal and strengthens the long case.`);
        } else if (ev.event === 'C Down confirmed') {
          narrative.push(`At ${ev.time}, C Down confirmed (close at ${ev.price.toFixed(2)}, below OR Low ${orL.toFixed(2)}). Price accepted below the opening range — confirms the A Down signal.`);
        } else if (ev.event === 'C Up (no A)') {
          narrative.push(`At ${ev.time}, a bar closed above OR High (${ev.price.toFixed(2)}) but A Up never fired — price never reached the A Up level (${aUp.toFixed(2)}) with sustained conviction. Weaker signal, price explored above the OR without committing to a breakout.`);
        } else if (ev.event === 'C Down (no A)') {
          narrative.push(`At ${ev.time}, a bar closed below OR Low (${ev.price.toFixed(2)}) but A Down never fired — price dipped below the OR without reaching the A Down level (${aDown.toFixed(2)}). Weaker signal, likely a probe that faded.`);
        }
      }

      // Current state
      const distToAUp = aUp - currentPrice;
      const distToADown = currentPrice - aDown;
      if (timeline.length === 0) {
        narrative.push(`No setups have fired yet. Price (${currentPrice.toFixed(2)}) is ${distToAUp.toFixed(0)} points from A Up and ${distToADown.toFixed(0)} points from A Down. Watching both levels.`);
      } else {
        if (!a_up_fired && !a_down_fired) {
          if (currentPrice > orH) {
            narrative.push(`Currently price (${currentPrice.toFixed(2)}) is above OR High (${orH.toFixed(2)}) — ${distToAUp.toFixed(0)} points from A Up. Watching for a sustained push through ${aUp.toFixed(2)} or a rejection back inside the OR.`);
          } else if (currentPrice < orL) {
            narrative.push(`Currently price (${currentPrice.toFixed(2)}) is below OR Low (${orL.toFixed(2)}) — ${distToADown.toFixed(0)} points from A Down. Watching for sustained breakdown below ${aDown.toFixed(2)} or a recovery.`);
          } else {
            narrative.push(`Currently price (${currentPrice.toFixed(2)}) is back inside the OR (${orL.toFixed(2)}–${orH.toFixed(2)}). No active A signal. Ranging.`);
          }
        }
      }

      // ── Phase 3 auto-suggestions ──────────────────────────────────────────────
      // Bias: A signal overrides structure; fall back to overnight_inventory/open_vs_prior_value
      const todayRead = await query(`SELECT overnight_inventory, open_vs_prior_value FROM auction_reads WHERE trade_date=$1`, [todayET]);
      const inv2 = todayRead.rows[0]?.overnight_inventory;
      const val2 = todayRead.rows[0]?.open_vs_prior_value;
      const strLong  = (inv2==='SHORT_TRAPPED'&&val2!=='BELOW_VALUE')||(inv2==='NEUTRAL'&&val2==='ABOVE_VALUE');
      const strShort = (inv2==='LONG_TRAPPED'&&val2!=='ABOVE_VALUE')||(inv2==='NEUTRAL'&&val2==='BELOW_VALUE');
      const biasDir = a_up_fired ? 'LONG' : a_down_fired ? 'SHORT' : strLong ? 'LONG' : strShort ? 'SHORT' : 'NEUTRAL';

      // VWAP (volume-weighted close across all post-OR bars)
      const totalVol = postOR.reduce((s, b) => s + (Number(b.volume) || 1), 0);
      const vwap = postOR.reduce((s, b) => s + b.close * (Number(b.volume) || 1), 0) / totalVol;

      // 1. VWAP holding: current price on correct side of VWAP
      const p3_vwap_holding = biasDir === 'LONG' ? currentPrice > vwap
                            : biasDir === 'SHORT' ? currentPrice < vwap : false;

      // 2. Value migrating: VWAP now vs VWAP 20 bars ago (session weighted trend)
      const split = Math.max(1, postOR.length - 20);
      const earlyBars = postOR.slice(0, split);
      const earlyVol = earlyBars.reduce((s, b) => s + (Number(b.volume) || 1), 0);
      const earlyVwap = earlyBars.reduce((s, b) => s + b.close * (Number(b.volume) || 1), 0) / earlyVol;
      const p3_value_migrating = biasDir === 'LONG' ? vwap > earlyVwap
                               : biasDir === 'SHORT' ? vwap < earlyVwap : false;

      // 3. Delta confirming: close-position proxy (close near high = buy pressure)
      const last10 = postOR.slice(-10);
      const avgClosePos = last10.reduce((s, b) => {
        const rng = b.high - b.low;
        return s + (rng > 0 ? (b.close - b.low) / rng : 0.5);
      }, 0) / last10.length;
      const p3_delta_confirming = biasDir === 'LONG' ? avgClosePos > 0.55
                                : biasDir === 'SHORT' ? avgClosePos < 0.45 : false;

      // 4. Auction accepted: ≥40% of last 20 bars closing beyond OR in bias direction
      const last20 = postOR.slice(-20);
      const acceptCount = last20.filter(b =>
        biasDir === 'LONG' ? b.close > orH : biasDir === 'SHORT' ? b.close < orL : false
      ).length;
      const p3_auction_accepted = last20.length > 0 && acceptCount / last20.length >= 0.4;

      // 5. Rotations increasing: recent bar ranges expanding (balance/two-sided trade forming)
      const last16 = postOR.slice(-16);
      let p3_rotations_increasing = false;
      if (last16.length >= 8) {
        const half = Math.floor(last16.length / 2);
        const firstHalf = last16.slice(0, half);
        const secondHalf = last16.slice(half);
        const rng1 = Math.max(...firstHalf.map(b => b.high)) - Math.min(...firstHalf.map(b => b.low));
        const rng2 = Math.max(...secondHalf.map(b => b.high)) - Math.min(...secondHalf.map(b => b.low));
        p3_rotations_increasing = rng2 > rng1 * 1.15;
      }

      const p3Suggested = { p3_vwap_holding, p3_value_migrating, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing, vwap: Math.round(vwap * 100) / 100, biasDir };

      // ── Opening call auto-detection from first 15 min of bars (9:30–9:45) ──
      // Also include the OR bars (bm 570–574) for the first-bar open price
      const allBarsQ = await query(`
        SELECT high::float, low::float, close::float, open::float,
               EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as bm
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 585
        ORDER BY ts
      `, [todayET]);
      const first15 = allBarsQ.rows;
      let opening_call_type = null;
      if (first15.length >= 5 && orH && orL) {
        const h15    = Math.max(...first15.map(b => b.high));
        const l15    = Math.min(...first15.map(b => b.low));
        const openPx = first15[0].open;
        const lastPx = first15[first15.length-1].close;
        const orRng  = orH - orL;
        const ext    = orRng * 0.3;   // 30% extension = meaningful push
        const ext50  = orRng * 0.5;   // 50% extension = drive territory
        const aboveOR = h15 - orH;    // how far above OR High
        const belowOR = orL - l15;    // how far below OR Low

        if (aboveOR > ext && belowOR > ext) {
          // Tested both sides — Open Test Drive
          opening_call_type = 'OPEN_TEST_DRIVE';
        } else if (aboveOR > ext50 && belowOR < ext * 0.3) {
          // Strong upside extension, no downside test — Open Drive
          opening_call_type = 'OPEN_DRIVE';
        } else if (belowOR > ext50 && aboveOR < ext * 0.3) {
          // Strong downside extension, no upside test — Open Drive
          opening_call_type = 'OPEN_DRIVE';
        } else if ((aboveOR > ext || belowOR > ext) && Math.abs(lastPx - (orH+orL)/2) < orRng * 0.4) {
          // Extended one side but price came back toward midpoint — ORR
          opening_call_type = 'OPEN_REJECTION_REVERSE';
        } else {
          // Stayed within or near OR — Open Auction
          opening_call_type = 'OPEN_AUCTION';
        }
      }

      // Derive setup and signal flags from live bar analysis (timeline), not stale DB values
      let liveSetup = setup, liveColor = color, liveDescription = description;
      if (aUpFiredTimeline && cUp) {
        liveSetup = 'A Up + C Confirmed'; liveColor = '#22c55e';
        liveDescription = `A Up fired and C Up confirmed. Strong continuation long. Price ${currentPrice.toFixed(2)}, above OR High ${orH.toFixed(2)}.`;
      } else if (aUpFiredTimeline) {
        liveSetup = 'A Up (no C yet)'; liveColor = '#86efac';
        liveDescription = `A Up fired. Waiting for C Up confirmation (close above OR High ${orH.toFixed(2)}). Still valid long.`;
      } else if (aDownFiredTimeline && cDown) {
        liveSetup = 'A Down + C Confirmed'; liveColor = '#ef4444';
        liveDescription = `A Down fired and C Down confirmed. Strong continuation short. Price ${currentPrice.toFixed(2)}, below OR Low ${orL.toFixed(2)}.`;
      } else if (aDownFiredTimeline) {
        liveSetup = 'A Down (no C yet)'; liveColor = '#fca5a5';
        liveDescription = `A Down fired. Waiting for C Down confirmation (close below OR Low ${orL.toFixed(2)}).`;
      } else if (timeline.some(e => e.event?.startsWith('Failed A Up') && !e.event.includes('attempt'))) {
        liveSetup = 'Failed A Up'; liveColor = '#f97316';
      } else if (timeline.some(e => e.event?.startsWith('Failed A Down') && !e.event.includes('attempt'))) {
        liveSetup = 'Failed A Down'; liveColor = '#a78bfa';
      }

      // NL30 for dynamic conviction (reuse cache from setup-detection when available)
      let liveNL30 = 0, liveStructState = null;
      const cachedNL30 = getCached(todayET, 'nl30');
      if (cachedNL30) {
        liveNL30 = cachedNL30.nl30;
        liveStructState = cachedNL30.nl30State === 'BULLISH' ? 'TRENDING_UP' : cachedNL30.nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE';
      } else {
        try {
          const nlQ = await query(`SELECT SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30 FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date DESC LIMIT 1`);
          liveNL30 = parseInt(nlQ.rows[0]?.nl30) || 0;
          liveStructState = liveNL30 > 9 ? 'TRENDING_UP' : liveNL30 < -9 ? 'TRENDING_DOWN' : 'BALANCE';
        } catch (_) {}
      }

      const rawConviction = await getConvictionData().catch(() => null);
      const conviction = rawConviction
        ? Object.fromEntries(Object.entries(rawConviction).map(([k, v]) => [
            k, v ? { ...v, dynamic: computeDynamicConviction(v, k, { nl30: liveNL30, structuralState: liveStructState }) } : null
          ]))
        : null;

      // Day type classification (available after IB close at 10:00 AM, updates at 10:30 and 11:00)
      // Use timeline-based failure detection — simple failedAUp is false when a_up_fired=true in DB
      const etMinLive = nowET.getHours() * 60 + nowET.getMinutes();
      let dayType = null;
      if (etMinLive >= 10 * 60) {
        const tlFailedAUp   = timeline.some(e => e.event?.startsWith('Failed A Up'));
        const tlFailedADown = timeline.some(e => e.event?.startsWith('Failed A Down'));
        const hasA  = aUpFiredTimeline || aDownFiredTimeline;
        const hasFA = tlFailedAUp || tlFailedADown;
        const trendLong  = aUpFiredTimeline   && cUp   && !tlFailedAUp;
        const trendShort = aDownFiredTimeline && cDown && !tlFailedADown;
        if (trendLong || trendShort) {
          dayType = { label: 'TREND DAY', color: trendLong ? '#22c55e' : '#ef4444', detail: 'Directional — go with the drive' };
        } else if ((hasA && hasFA) || (aUpFiredTimeline && cDown) || (aDownFiredTimeline && cUp) || (tlFailedAUp && tlFailedADown)) {
          dayType = { label: 'NEUTRAL DAY', color: '#94a3b8', detail: 'Both sides rejected — wait for extremes' };
        } else if (hasA && !hasFA) {
          dayType = { label: 'NORMAL DAY', color: '#f59e0b', detail: 'Responsive at extremes' };
        } else if ((cUp || cDown) && !hasA) {
          dayType = { label: 'NORMAL DAY', color: '#f59e0b', detail: 'C signal — responsive probe' };
        } else {
          dayType = { label: 'BRACKET DAY', color: '#6366f1', detail: 'Fade value area extremes' };
        }
      }

      res.json({
        setup: liveSetup, color: liveColor, description: liveDescription, currentPrice, barTime,
        orHigh: orH, orLow: orL, aUpLevel: aUp, aDownLevel: aDown,
        gLine, gLineDaysHeld, gLineStatus,
        pwHigh, pwLow, pmVAH, pmVAL, pmPOC,
        sessionHigh, sessionLow,
        aUpFired: aUpFiredTimeline, aDownFired: aDownFiredTimeline,
        reachedAUp, reachedADown, failedAUp, failedADown, cUp, cDown,
        barsAnalyzed: postOR.length,
        weisWarning,
        timeline, narrative, p3Suggested, opening_call_type,
        nl30: liveNL30,
        conviction,
        dayType,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/engine-reads/hit-rates — historical hit rates from engine_reads table
  // Used by dashboard to show calibrated conviction next to A signals and pre-market bias reads.
  // N<20 decisive outcomes = not confident; never display a percentage as reliable below this threshold.
  router.get('/engine-reads/hit-rates', async (req, res) => {
    try {
      // Compute overall and by-bias-context hit rates for each signal type+value
      const rows = await query(`
        SELECT read_type, signal_value, session_bias_context,
          COUNT(*) FILTER (WHERE outcome IN ('CORRECT','WRONG')) AS decisive,
          COUNT(*) FILTER (WHERE outcome = 'CORRECT')            AS correct,
          COUNT(*) FILTER (WHERE outcome = 'WRONG')              AS wrong,
          COUNT(*)                                               AS n
        FROM engine_reads
        WHERE outcome IS NOT NULL
        GROUP BY read_type, signal_value, session_bias_context
        ORDER BY read_type, signal_value, session_bias_context
      `);

      // Build structured result
      // Keys: 'A_UP', 'A_DOWN', 'BIAS_LONG', 'BIAS_SHORT', 'BIAS_NEUTRAL'
      const result = {};
      for (const r of rows.rows) {
        const decisive = parseInt(r.decisive), correct = parseInt(r.correct), wrong = parseInt(r.wrong), n = parseInt(r.n);
        const hitRate  = decisive > 0 ? correct / decisive : null;
        const confident = decisive >= 20;
        const entry = { n, decisive, correct, wrong, hitRate, confident };

        const key = r.read_type === 'A_SIGNAL' ? r.signal_value : `BIAS_${r.signal_value}`;
        if (!result[key]) result[key] = { overall: null, byBias: {} };
        if (r.session_bias_context) result[key].byBias[r.session_bias_context] = entry;
      }

      // Overall (all bias contexts combined) per signal type+value
      const overall = await query(`
        SELECT read_type, signal_value,
          COUNT(*) FILTER (WHERE outcome IN ('CORRECT','WRONG')) AS decisive,
          COUNT(*) FILTER (WHERE outcome = 'CORRECT')            AS correct,
          COUNT(*) FILTER (WHERE outcome = 'WRONG')              AS wrong,
          COUNT(*)                                               AS n
        FROM engine_reads
        WHERE outcome IS NOT NULL
        GROUP BY read_type, signal_value
      `);
      for (const r of overall.rows) {
        const decisive = parseInt(r.decisive), correct = parseInt(r.correct), wrong = parseInt(r.wrong), n = parseInt(r.n);
        const hitRate  = decisive > 0 ? correct / decisive : null;
        const confident = decisive >= 20;
        const key = r.read_type === 'A_SIGNAL' ? r.signal_value : `BIAS_${r.signal_value}`;
        if (!result[key]) result[key] = { overall: null, byBias: {} };
        result[key].overall = { n, decisive, correct, wrong, hitRate, confident };
      }

      // NEW: level-touch (IB/PD/VWAP reversal-bounce rates) and combo (level-confluence)
      // hit rates from setup_correlation_cache / combo_stats — same N>=20 confidence rule.
      const [levelTouches, combos] = await Promise.all([getLevelTouchLookup(), getComboLookup()]);

      res.json({ rates: result, levelTouches, combos, computedAt: new Date().toISOString() });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/setup-detection — detect the highest-priority intraday setup
  // Returns one setup card at a time. Priority: IB_CONFIRMATION > OPEN_DRIVE_CONT >
  // FAILED_AUCTION > BRACKET_BREAKOUT > VALUE_AREA_RESP
      router.get('/acd/setup-detection', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const nowET   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const etMin   = nowET.getHours() * 60 + nowET.getMinutes();

      // Resolve setups by price FIRST (TARGET_HIT/STOP_HIT) — a real T1/stop touch must
      // never be preempted by a timer or OR-break invalidation. Only setups still ACTIVE
      // after this (i.e. neither level touched) fall through to expiry/invalidation below.
      await resolveSetupsByPrice(io).catch(() => {});
      await expireStaleSetups(io).catch(() => {});
      await structurallyInvalidateSetups(io).catch(() => {});

      // Session close at 1:00 PM ET: expire all remaining active setups, return null
      // No new entries after noon; setups stay visible for management until 1 PM.
      if (etMin >= 13 * 60) {
        await query(`
          UPDATE active_setups SET status='EXPIRED', resolution='SESSION_CLOSED',
            resolved_at=NOW(), updated_at=NOW()
          WHERE trade_date=$1 AND status='ACTIVE'
        `, [todayET]).catch(() => {});
        return res.json({ setup: null, sessionClosed: true });
      }
      const noNewEntries = etMin >= 12 * 60; // noon–1 PM: manage open trades only

      // Setup detection itself depends on today's OR/A-levels, which aren't
      // computed until 9:35 ET — opening this gate at 8:30 just stops the
      // endpoint hard-blocking pre-market; it'll still return setup:null
      // until the OR/A-levels exist.
      const isRTH = etMin >= 8 * 60 + 30;
      if (!isRTH) return res.json({ setup: null, reason: 'market closed' });

      // ── Fetch all data sources in parallel ────────────────────────────────────
      const [acdRow, arRow, ltRow, ibBarsRow, latestBarRow, volumeCtxRow, timelineRow, sessionHiLoRow, first15Row] = await Promise.all([
        // Today's OR levels + ACD/C state
        query(`SELECT or_high::float, or_low::float, a_up_fired, a_up_level::float, c_up_confirmed, a_down_fired, a_down_level::float, c_down_confirmed FROM acd_daily_log WHERE trade_date=$1`, [todayET]),
        // Auction reads for today
        query(`SELECT opening_call_type, open_vs_prior_value FROM auction_reads WHERE trade_date=$1`, [todayET]),
        // Prior 5 bracket states using actual session High/Low (9:30–16:00)
        query(`
          WITH dates AS (
            SELECT DISTINCT ts::date as dt FROM price_bars_primary
            WHERE symbol='NQ' AND ts::date < $1
            ORDER BY dt DESC LIMIT 5
          )
          SELECT ts::date::text as trade_date, 
                 MAX(high)::float as or_high, 
                 MIN(low)::float as or_low
          FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date IN (SELECT dt FROM dates)
            AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 960
          GROUP BY ts::date
          ORDER BY trade_date DESC
        `, [todayET]),
        // IB bars (9:30–10:00) with bid/ask volume — spec: 30-min OR period
        query(`
          SELECT high::float, low::float, close::float, open::float,
                 COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol, volume::int
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 599
          ORDER BY ts
        `, [todayET]),
        // Current price + volume + bar timestamp
        query(`SELECT ts, close::float, volume::int FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`),
        // 20-bar average volume (last 20 RTH bars)
        query(`
          SELECT AVG(volume)::float as avg_vol
          FROM (SELECT volume FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 575 ORDER BY ts DESC LIMIT 20) v
        `, [todayET]),
        // Live timeline events
        query(`SELECT setup_type, fired_time FROM acd_setup_events WHERE trade_date=$1 ORDER BY fired_time`, [todayET]),
        // Session high/low so far today (for TRT stop calculation)
        query(`SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [todayET]),
        // First 15 min of bars (9:30-9:45) for live opening-type classification
        query(`
          SELECT high::float, low::float, close::float, open::float
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 585
          ORDER BY ts
        `, [todayET]),
      ]);

      // Prior day value area — cached (changes only between days)
      let pdVAH = null, pdVAL = null, pdPOC = null;
      const cachedPdVA = getCached(todayET, 'pdVA');
      if (cachedPdVA) {
        ({ pdVAH, pdVAL, pdPOC } = cachedPdVA);
      } else {
        const priorDayQ = await query(`SELECT MAX(ts::date)::text as d FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [todayET]);
        const priorDay = priorDayQ.rows[0]?.d;
        if (priorDay) {
          const vaQ = await query(`
            SELECT poc::float as poc, vah::float as vah, val::float as val
            FROM developing_value_log
            WHERE trade_date = $1
          `, [priorDay]);
          if (vaQ.rows[0]) {
            pdVAH = vaQ.rows[0].vah;
            pdVAL = vaQ.rows[0].val;
            pdPOC = vaQ.rows[0].poc;
          } else {
            // fallback
            const fallbackQ = await query(`
              WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
              total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
              SELECT p.poc_px::float as poc,
                (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
                (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
              FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
            `, [priorDay]);
            if (fallbackQ.rows[0]) {
              pdVAH = fallbackQ.rows[0].vah;
              pdVAL = fallbackQ.rows[0].val;
              pdPOC = fallbackQ.rows[0].poc;
            }
          }
        }
        setCached(todayET, 'pdVA', { pdVAH, pdVAL, pdPOC });
      }

      // NL30 state — cached
      let nl30, nl30State, isMahBull, isMahBear;
      const cachedNL = getCached(todayET, 'nl30');
      if (cachedNL) {
        ({ nl30, nl30State, isMahBull, isMahBear } = cachedNL);
      } else {
        const nlQ = await query(`SELECT SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30 FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date DESC LIMIT 1`);
        nl30 = parseInt(nlQ.rows[0]?.nl30) || 0;
        nl30State = nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING';
        const mahQ = await query(`
          WITH nl AS (
            SELECT trade_date,
                   SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30_val,
                   ROW_NUMBER() OVER (ORDER BY trade_date DESC) as rn
            FROM acd_daily_log WHERE daily_score IS NOT NULL AND trade_date <= $1
          )
          SELECT
            SUM(CASE WHEN nl30_val > 9  THEN 1 ELSE 0 END) as bull_sessions,
            SUM(CASE WHEN nl30_val < -9 THEN 1 ELSE 0 END) as bear_sessions
          FROM nl WHERE rn <= 10
        `, [todayET]);
        isMahBull = nl30 > 15 && parseInt(mahQ.rows[0]?.bull_sessions || 0) >= 10;
        isMahBear = nl30 < -15 && parseInt(mahQ.rows[0]?.bear_sessions || 0) >= 10;
        setCached(todayET, 'nl30', { nl30, nl30State, isMahBull, isMahBear });
      }

      // Extract data
      const orH = acdRow.rows[0]?.or_high, orL = acdRow.rows[0]?.or_low;
      const orRange = orH && orL ? orH - orL : null;
      const openingCall = arRow.rows[0]?.opening_call_type;
      const currentPrice = latestBarRow.rows[0]?.close || 0;
      const avgVol = parseFloat(volumeCtxRow.rows[0]?.avg_vol) || 0;
      const ibBars = ibBarsRow.rows;
      const timelineEvents = timelineRow.rows.map(r => r.setup_type);

      // Live opening-type classification (first 15 min of bars, 9:30-9:45) — replaces
      // the empty auction_reads.opening_call_type for OPEN_DRIVE/VALUE_AREA_RESPONSIVE
      // gating below. Mirrors /acd/live's classifier (~line 1895) without persisting.
      const first15 = first15Row.rows;
      let liveOpeningCallType = null;
      if (first15.length >= 5 && orH && orL) {
        const h15 = Math.max(...first15.map(b => b.high));
        const l15 = Math.min(...first15.map(b => b.low));
        const lastPx = first15[first15.length - 1].close;
        const orRng = orH - orL;
        const ext = orRng * 0.3;
        const ext50 = orRng * 0.5;
        const aboveOR = h15 - orH;
        const belowOR = orL - l15;

        if (aboveOR > ext && belowOR > ext) {
          liveOpeningCallType = 'OPEN_TEST_DRIVE';
        } else if (aboveOR > ext50 && belowOR < ext * 0.3) {
          liveOpeningCallType = 'OPEN_DRIVE';
        } else if (belowOR > ext50 && aboveOR < ext * 0.3) {
          liveOpeningCallType = 'OPEN_DRIVE';
        } else if ((aboveOR > ext || belowOR > ext) && Math.abs(lastPx - (orH + orL) / 2) < orRng * 0.4) {
          liveOpeningCallType = 'OPEN_REJECTION_REVERSE';
        } else {
          liveOpeningCallType = 'OPEN_AUCTION';
        }
      }

      // Live open-vs-prior-value classification — replaces empty auction_reads.open_vs_prior_value
      const orMid = (orH != null && orL != null) ? (orH + orL) / 2 : null;
      const liveOpenVsPrior = (orMid != null && pdVAH != null && pdVAL != null)
        ? (orMid > pdVAH ? 'ABOVE_VALUE' : orMid < pdVAL ? 'BELOW_VALUE' : 'INSIDE_VALUE')
        : null;

      // ACD/C state for TRT and C detection
      const aUpFired   = !!acdRow.rows[0]?.a_up_fired;
      const aUpLevel   = acdRow.rows[0]?.a_up_level;
      const cUpConf    = !!acdRow.rows[0]?.c_up_confirmed;
      const aDownFired = !!acdRow.rows[0]?.a_down_fired;
      const aDownLevel = acdRow.rows[0]?.a_down_level;
      const cDownConf  = !!acdRow.rows[0]?.c_down_confirmed;
      const sessionHigh = sessionHiLoRow.rows[0]?.h;
      const sessionLow  = sessionHiLoRow.rows[0]?.l;

      // C already fired today? (prevents duplicate C_STANDALONE per day)
      const cFiredRow = await query(
        `SELECT 1 FROM active_setups WHERE trade_date=$1 AND setup_type LIKE 'C_%' LIMIT 1`,
        [todayET]
      ).catch(() => ({ rows: [] }));
      const hasCFiredToday = cFiredRow.rows.length > 0 || timelineEvents.some(e => e.startsWith('C '));

      // Helper: look up condition_memory win rate for current conditions
      const getHistory = async (structState) => {
        const nlBucket = nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING';
        const oc = openingCall || 'NO_SIGNAL';
        const r = await query(`
          SELECT occurrences, win_rate, avg_pnl, t1_hit_rate
          FROM condition_memory WHERE structural_state=$1 AND nl30_bucket=$2
            AND opening_call=$3 AND sufficient_data=true
          LIMIT 1
        `, [structState, nlBucket, oc]).catch(() => ({ rows: [] }));
        return r.rows[0] ? {
          occurrences: r.rows[0].occurrences,
          winRate: r.rows[0].win_rate != null ? parseFloat(r.rows[0].win_rate) : null,
          avgPnl: r.rows[0].avg_pnl != null ? parseFloat(r.rows[0].avg_pnl) : null,
          t1HitRate: r.rows[0].t1_hit_rate != null ? parseFloat(r.rows[0].t1_hit_rate) : null,
        } : null;
      };

      // Returns the nearest valid T1 candidate in the correct direction vs entry.
      // Candidates are checked in priority order; first valid one wins.
      // Returns null if no candidate is on the right side — prevents wrong-direction targets.
      const t1Guard = (direction, entry, ...candidates) => {
        const isLong = direction === 'LONG';
        for (const c of candidates) {
          if (c != null && isFinite(c) && (isLong ? c > entry : c < entry)) return Math.round(c);
        }
        return null;
      };

      // Same direction-guard as t1Guard, but candidates are { value, label } pairs
      // and the matching label travels with the chosen value — so the displayed
      // target and its label can never disagree about which structural level was used.
      // Used by the TRT family, where every candidate must be a REAL structural level
      // (no arbitrary price+multiple fallbacks) — falls through to NO_VIABLE_TARGET
      // rather than inventing an unanchored number.
      const t1GuardLabeled = (direction, entry, ...candidates) => {
        const isLong = direction === 'LONG';
        for (const cand of candidates) {
          const c = cand?.value;
          if (c != null && isFinite(c) && (isLong ? c > entry : c < entry)) {
            return { value: Math.round(c), label: cand.label };
          }
        }
        return { value: null, label: 'NO_VIABLE_TARGET' };
      };

      // ── SETUP 0a: TRT V2 (LONG) ──────────────────────────────────────────────
      // Early trigger: A Down fired, NO C confirmation in either direction, price crosses
      // back above OR Low. A Down sellers are trapped before any C fires — earlier entry
      // than classic TRT which requires C Down + C Up failure through OR High.
      let trtLongV2 = null;
      if (aDownFired && !cDownConf && !cUpConf && currentPrice && orL &&
          currentPrice > orL &&
          !timelineEvents.some(e => e === 'TRT_LONG_V2' || e === 'TRT_LONG')) {
        const trtLongV2Stop = +(aDownLevel - 12).toFixed(0);
        const trtLongV2T1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' },
        );
        trtLongV2 = {
          type: 'TRT_LONG_V2', label: 'TRT V2 — EARLY REVERSAL (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: trtLongV2Stop,
          target: trtLongV2T1.value,
          targetLabel: trtLongV2T1.label,
          keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (A Down trapped)',
          description: `A Down fired at ${aDownLevel?.toFixed(0)} but C Down never confirmed. Price reclaimed OR Low (${orL?.toFixed(0)}) — A Down sellers are trapped early. No C opposite required (earlier entry than classic TRT). Stop below A Down level (${trtLongV2Stop}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 0b: TRT V2 (SHORT) ─────────────────────────────────────────────
      // Early trigger: A Up fired, NO C confirmation in either direction, price drops
      // back below OR High. A Up buyers are trapped before any C fires.
      let trtShortV2 = null;
      if (aUpFired && !cUpConf && !cDownConf && currentPrice && orH &&
          currentPrice < orH &&
          !timelineEvents.some(e => e === 'TRT_SHORT_V2' || e === 'TRT_SHORT')) {
        const trtShortV2Stop = +(aUpLevel + 12).toFixed(0);
        const trtShortV2T1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' },
        );
        trtShortV2 = {
          type: 'TRT_SHORT_V2', label: 'TRT V2 — EARLY REVERSAL (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: trtShortV2Stop,
          target: trtShortV2T1.value,
          targetLabel: trtShortV2T1.label,
          keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (A Up trapped)',
          description: `A Up fired at ${aUpLevel?.toFixed(0)} but C Up never confirmed. Price fell back below OR High (${orH?.toFixed(0)}) — A Up buyers are trapped early. No C opposite required (earlier entry than classic TRT). Stop above A Up level (${trtShortV2Stop}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 0c: OPEN TEST DRIVE (OTD) ──────────────────────────────────────
      // Within first 15 bars (9:30–9:44): price probes one direction 10+ pts, then reverses
      // through OR in opposite direction with larger magnitude. Stop = probe extreme.
      let otdSetup = null;
      {
        const otdBars = ibBars.slice(0, 15);
        if (otdBars.length >= 3 && orH && orL && currentPrice &&
            !timelineEvents.some(e => e === 'OPEN_TEST_DRIVE_SHORT' || e === 'OPEN_TEST_DRIVE_LONG')) {
          const openPx    = otdBars[0].open;
          const upProbe   = Math.max(...otdBars.map(b => b.high)) - openPx;
          const downProbe = openPx - Math.min(...otdBars.map(b => b.low));
          const probeHigh = Math.max(...otdBars.map(b => b.high));
          const probeLow  = Math.min(...otdBars.map(b => b.low));

          const otdShortSignaled = upProbe >= 10 && otdBars.some(b => b.close < orL);
          const otdLongSignaled  = downProbe >= 10 && otdBars.some(b => b.close > orH);

          if (otdShortSignaled && currentPrice < orL) {
            otdSetup = {
              type: 'OPEN_TEST_DRIVE_SHORT', label: 'OPEN TEST DRIVE (SHORT)',
              direction: 'SHORT',
              entry: +currentPrice.toFixed(0),
              stop: +probeHigh.toFixed(0),
              target: t1Guard('SHORT', currentPrice, pdVAL, currentPrice - (orRange || 80) * 1.5),
              targetLabel: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Range Extension',
              keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (reversal confirmed)',
              description: `Open Test Drive short. Price probed up ${upProbe.toFixed(0)}pts to ${probeHigh.toFixed(0)} in the opening, then reversed through OR Low (${orL?.toFixed(0)}) — initiative sellers dominated. Stop above probe high (${probeHigh.toFixed(0)}).`,
              history: await getHistory('TRANSITIONAL'),
            };
          } else if (otdLongSignaled && currentPrice > orH) {
            otdSetup = {
              type: 'OPEN_TEST_DRIVE_LONG', label: 'OPEN TEST DRIVE (LONG)',
              direction: 'LONG',
              entry: +currentPrice.toFixed(0),
              stop: +probeLow.toFixed(0),
              target: t1Guard('LONG', currentPrice, pdVAH, currentPrice + (orRange || 80) * 1.5),
              targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'Composite VAH',
              keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (reversal confirmed)',
              description: `Open Test Drive long. Price probed down ${downProbe.toFixed(0)}pts to ${probeLow.toFixed(0)} in the opening, then reversed through OR High (${orH?.toFixed(0)}) — initiative buyers dominated. Stop below probe low (${probeLow.toFixed(0)}).`,
              history: await getHistory('TRANSITIONAL'),
            };
          }
        }
      }
      
      // ── SETUP 0d: A UP STRONG (LONG) ─────────────────────────────────────────
      let aUpStrong = null;
      if (aUpFired && nl30 >= -9 &&
          !timelineEvents.some(e => e === 'A_UP_STRONG' || e === 'A_UP_WEAK' || e === 'TRT_LONG' || e === 'TRT_LONG_V2')) {
        const aUpStrongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' }
        );
        aUpStrong = {
          type: 'A_UP_STRONG', label: 'A UP STRONG (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: orL ? +orL.toFixed(0) : null,
          target: aUpStrongT1.value,
          targetLabel: aUpStrongT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `A Up fired at ${aUpLevel?.toFixed(0)} under a supportive trend (NL30 is at +${nl30}). Bullish momentum holds above OR High. Stop below OR Low (${orL?.toFixed(0)}).`,
          history: await getHistory('TRENDING_UP'),
        };
      }

      // ── SETUP 0e: A DOWN STRONG (SHORT) ──────────────────────────────────────
      let aDownStrong = null;
      if (aDownFired && nl30 <= 9 &&
          !timelineEvents.some(e => e === 'A_DOWN_STRONG' || e === 'A_DOWN_WEAK' || e === 'TRT_SHORT' || e === 'TRT_SHORT_V2')) {
        const aDownStrongT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' }
        );
        aDownStrong = {
          type: 'A_DOWN_STRONG', label: 'A DOWN STRONG (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: orH ? +orH.toFixed(0) : null,
          target: aDownStrongT1.value,
          targetLabel: aDownStrongT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `A Down fired at ${aDownLevel?.toFixed(0)} under a supportive trend (NL30 is at ${nl30}). Bearish momentum holds below OR Low. Stop above OR High (${orH?.toFixed(0)}).`,
          history: await getHistory('TRENDING_DOWN'),
        };
      }

      // ── SETUP 0f: A UP WEAK (LONG) ───────────────────────────────────────────
      let aUpWeak = null;
      if (aUpFired && nl30 < -9 &&
          !timelineEvents.some(e => e === 'A_UP_STRONG' || e === 'A_UP_WEAK' || e === 'TRT_LONG' || e === 'TRT_LONG_V2')) {
        const aUpWeakT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange * 0.5 : null, label: 'OR Half Measured Move' }
        );
        aUpWeak = {
          type: 'A_UP_WEAK', label: 'A UP WEAK (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: orL ? +orL.toFixed(0) : null,
          target: aUpWeakT1.value,
          targetLabel: aUpWeakT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `A Up fired at ${aUpLevel?.toFixed(0)} but against a bearish trend (NL30 is at ${nl30}). High failure/reversal risk. Stop below OR Low (${orL?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 0g: A DOWN WEAK (SHORT) ────────────────────────────────────────
      let aDownWeak = null;
      if (aDownFired && nl30 > 9 &&
          !timelineEvents.some(e => e === 'A_DOWN_STRONG' || e === 'A_DOWN_WEAK' || e === 'TRT_SHORT' || e === 'TRT_SHORT_V2')) {
        const aDownWeakT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange * 0.5 : null, label: 'OR Half Measured Move' }
        );
        aDownWeak = {
          type: 'A_DOWN_WEAK', label: 'A DOWN WEAK (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: orH ? +orH.toFixed(0) : null,
          target: aDownWeakT1.value,
          targetLabel: aDownWeakT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `A Down fired at ${aDownLevel?.toFixed(0)} but against a bullish trend (NL30 is at +${nl30}). High failure/reversal risk. Stop above OR High (${orH?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 1: TRT + MAH ────────────────────────────────────────────────────
      // "Mad As Hell" — extended trend exhaustion: TRT conditions + NL30 extreme for 10+ sessions
      let trtMah = null;
      if (isMahBull || isMahBear) {
        if (isMahBull && aUpFired && cUpConf && currentPrice && orL && aUpLevel &&
            currentPrice < orL && currentPrice < aUpLevel) {
          const trtMahShortStop = +(aUpLevel + 12).toFixed(0);
          const trtMahShortT1 = t1GuardLabeled('SHORT', currentPrice,
            { value: pdVAL, label: 'Prior Day VAL' },
            { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' },
          );
          trtMah = {
            type: 'TRT_MAH_SHORT', label: 'TRT + MAH (SHORT)',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: trtMahShortStop,
            target: trtMahShortT1.value,
            targetLabel: trtMahShortT1.label,
            keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (failed support)',
            description: `A Up + C Up both failed. NL30 at +${nl30} with 10+ consecutive extreme sessions. MAH: trapped buyers fuel a larger-than-normal reversal. Price below OR Low (${orL?.toFixed(0)}) and A Up level (${aUpLevel?.toFixed(0)}).`,
            history: await getHistory('TRENDING_UP'),
          };
        } else if (isMahBear && aDownFired && cDownConf && currentPrice && orH && aDownLevel &&
                   currentPrice > orH && currentPrice > aDownLevel) {
          const trtMahLongStop = +(aDownLevel - 12).toFixed(0);
          const trtMahLongT1 = t1GuardLabeled('LONG', currentPrice,
            { value: pdVAH, label: 'Prior Day VAH' },
            { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' },
          );
          trtMah = {
            type: 'TRT_MAH_LONG', label: 'TRT + MAH (LONG)',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: trtMahLongStop,
            target: trtMahLongT1.value,
            targetLabel: trtMahLongT1.label,
            keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (failed resistance)',
            description: `A Down + C Down both failed. NL30 at ${nl30} with 10+ consecutive extreme sessions. MAH: trapped sellers fuel a larger-than-normal reversal. Price above OR High (${orH?.toFixed(0)}) and A Down level (${aDownLevel?.toFixed(0)}).`,
            history: await getHistory('TRENDING_DOWN'),
          };
        }
      }

      // ── SETUP 2: TRT ──────────────────────────────────────────────────────────
      // Trend Reversal Trade: A + C both failed, price confirms reversal through OR
      let trt = null;
      if (aUpFired && cUpConf && currentPrice && orL && aUpLevel &&
          currentPrice < orL && currentPrice < aUpLevel) {
        const trtShortStop = +(aUpLevel + 12).toFixed(0);
        const trtShortT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' },
        );
        trt = {
          type: 'TRT_SHORT', label: 'TRT — TREND REVERSAL (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: trtShortStop,
          target: trtShortT1.value,
          targetLabel: trtShortT1.label,
          keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (failed support)',
          description: `A Up + C Up both failed. Price is now below OR Low (${orL?.toFixed(0)}) and A Up level (${aUpLevel?.toFixed(0)}). Trapped longs fuel the reversal — stop above A Up level (${trtShortStop}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      } else if (aDownFired && cDownConf && currentPrice && orH && aDownLevel &&
                 currentPrice > orH && currentPrice > aDownLevel) {
        const trtLongStop = +(aDownLevel - 12).toFixed(0);
        const trtLongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' },
        );
        trt = {
          type: 'TRT_LONG', label: 'TRT — TREND REVERSAL (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: trtLongStop,
          target: trtLongT1.value,
          targetLabel: trtLongT1.label,
          keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (failed resistance)',
          description: `A Down + C Down both failed. Price is now above OR High (${orH?.toFixed(0)}) and A Down level (${aDownLevel?.toFixed(0)}). Trapped shorts fuel the reversal — stop below A Down level (${trtLongStop}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 3: IB CONFIRMATION ──────────────────────────────────────────────
      // Detect after 30-min IB period completes (after 10:00 AM ET)
      let ibSetup = null;
      if (etMin >= 10 * 60 && ibBars.length >= 3) {
        const ibHigh = Math.max(...ibBars.map(b => b.high));
        const ibLow  = Math.min(...ibBars.map(b => b.low));
        const ibMid  = (ibHigh + ibLow) / 2;
        const ibClose = ibBars[ibBars.length - 1].close;
        const totalAsk = ibBars.reduce((s, b) => s + b.ask_vol, 0);
        const totalBid = ibBars.reduce((s, b) => s + b.bid_vol, 0);
        const ibBullish = ibClose > ibMid && totalAsk > totalBid;
        const ibBearish = ibClose < ibMid && totalBid > totalAsk;
        if ((ibBullish || ibBearish) && currentPrice) {
          const isBull = ibBullish;
          const priceSide = isBull ? currentPrice > ibMid : currentPrice < ibMid;
          if (priceSide) {
            // Conflicting signal: A Up tested and failed (for bullish IB) or A Down tested and failed (for bearish IB)
            // Both aUpLevel/aDownLevel are from acd_daily_log; ibBars is the 9:30–10:00 window
            const aUpTestedInIB   = aUpLevel   && ibBars.some(b => b.high >= aUpLevel);
            const aDownTestedInIB = aDownLevel  && ibBars.some(b => b.low  <= aDownLevel);
            const conflicting = isBull ? (aUpTestedInIB && !aUpFired) : (aDownTestedInIB && !aDownFired);

            const stop = isBull ? +(ibLow - 2).toFixed(0) : +(ibHigh + 2).toFixed(0);
            const target = isBull
              ? (pdVAH && pdVAH > currentPrice ? Math.round(pdVAH) : Math.round(ibHigh + (orRange || 0) * 0.5))
              : (pdVAL && pdVAL < currentPrice ? Math.round(pdVAL) : Math.round(ibLow - (orRange || 0) * 0.5));
            ibSetup = {
              type: isBull ? 'IB_BULLISH' : 'IB_BEARISH',
              label: conflicting
                ? (isBull ? 'IB Bullish — A Up failed (reduced)' : 'IB Bearish — A Down failed (reduced)')
                : (isBull ? 'IB BULLISH' : 'IB BEARISH'),
              signalQuality: conflicting ? 'WEAK' : 'NORMAL',
              direction: isBull ? 'LONG' : 'SHORT',
              entry: +currentPrice.toFixed(0),
              stop,
              target,
              targetLabel: isBull ? (pdVAH && pdVAH > currentPrice ? 'Prior Day VAH' : 'IB Extension') : (pdVAL && pdVAL < currentPrice ? 'Prior Day VAL' : 'IB Extension'),
              keyLevel: +ibMid.toFixed(0),
              keyLevelLabel: 'IB Midpoint',
              description: conflicting
                ? (isBull
                  ? `IB closed bullish but A Up was tested and rejected before 10:00 — conflicting signals. Buyers showed up in the IB but couldn't sustain the A level. Half conviction only: smaller size, wider stop tolerance.`
                  : `IB closed bearish but A Down was tested and rejected before 10:00 — conflicting signals. Sellers showed up in the IB but couldn't sustain the A level. Half conviction only: smaller size, wider stop tolerance.`)
                : (isBull
                  ? `IB closed ${(ibClose - ibMid).toFixed(0)}pts above midpoint with ask volume dominating (${totalAsk.toLocaleString()} vs ${totalBid.toLocaleString()} bid). Buyers controlled the opening range. Lean long on pullbacks to IB midpoint.`
                  : `IB closed ${(ibMid - ibClose).toFixed(0)}pts below midpoint with bid volume dominating (${totalBid.toLocaleString()} vs ${totalAsk.toLocaleString()} ask). Sellers controlled the opening range. Lean short on rallies to IB midpoint.`),
              history: await getHistory(nl30State === 'BULLISH' ? 'TRENDING_UP' : nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE'),
            };
          }
        }
      }

      // ── SETUP 4: OPEN DRIVE ───────────────────────────────────────────────────
      let openDrive = null;
      if (liveOpeningCallType === 'OPEN_DRIVE' && orH && orL && currentPrice) {
        const nearOrHigh = Math.abs(currentPrice - orH) <= 15 && currentPrice >= orH - 15 && currentPrice <= orH + 5;
        const nearOrLow  = Math.abs(currentPrice - orL) <= 15 && currentPrice <= orL + 15 && currentPrice >= orL - 5;
        const isBull = nearOrHigh && nl30State !== 'BEARISH';
        const isBear = nearOrLow  && nl30State !== 'BULLISH';
        if (isBull || isBear) {
          openDrive = {
            type: isBull ? 'OPEN_DRIVE_LONG' : 'OPEN_DRIVE_SHORT',
            label: isBull ? 'OPEN DRIVE (LONG)' : 'OPEN DRIVE (SHORT)',
            direction: isBull ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: isBull ? +(orL - 2).toFixed(0) : +(orH + 2).toFixed(0),
            target: isBull
              ? t1Guard('LONG',  currentPrice, orH + (orRange || 0), currentPrice + (orRange || 80))
              : t1Guard('SHORT', currentPrice, orL - (orRange || 0), currentPrice - (orRange || 80)),
            targetLabel: 'OR Measured Move',
            keyLevel: +(isBull ? orH : orL).toFixed(0),
            keyLevelLabel: isBull ? 'OR High (support)' : 'OR Low (resistance)',
            description: isBull
              ? `Open Drive up confirmed. Pullback to near OR High (${orH?.toFixed(0)}) — first test of the breakout level. Buyers who missed the drive are entering here.`
              : `Open Drive down confirmed. Rally toward OR Low (${orL?.toFixed(0)}) — first test of the breakdown level. Sellers who missed the drive are entering here.`,
            history: await getHistory('TRENDING_UP'),
          };
        }
      }

      // ── SETUP 5a: C PAIRED (LONG) ────────────────────────────────────────────
      let cPairedLong = null;
      if (aUpFired && cUpConf && !timelineEvents.some(e => e === 'C_PAIRED_LONG')) {
        const cPairedLongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange * 1.5 : null, label: 'OR Measured Move 1.5x' }
        );
        cPairedLong = {
          type: 'C_PAIRED_LONG', label: 'C PAIRED (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: orL ? +orL.toFixed(0) : null,
          target: cPairedLongT1.value,
          targetLabel: cPairedLongT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `C Up confirmed after an A Up fired. Paired C confirms absorption of seller counter-moves. Hold for weekly extension. Stop below OR Low (${orL?.toFixed(0)}).`,
          history: await getHistory('TRENDING_UP'),
        };
      }

      // ── SETUP 5b: C PAIRED (SHORT) ───────────────────────────────────────────
      let cPairedShort = null;
      if (aDownFired && cDownConf && !timelineEvents.some(e => e === 'C_PAIRED_SHORT')) {
        const cPairedShortT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange * 1.5 : null, label: 'OR Measured Move 1.5x' }
        );
        cPairedShort = {
          type: 'C_PAIRED_SHORT', label: 'C PAIRED (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: orH ? +orH.toFixed(0) : null,
          target: cPairedShortT1.value,
          targetLabel: cPairedShortT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `C Down confirmed after an A Down fired. Paired C confirms absorption of buyer counter-moves. Hold for weekly extension. Stop above OR High (${orH?.toFixed(0)}).`,
          history: await getHistory('TRENDING_DOWN'),
        };
      }

      // ── SETUP 5c: C REVERSAL (LONG) ──────────────────────────────────────────
      let cReversalLong = null;
      if (aDownFired && cUpConf && !timelineEvents.some(e => e === 'C_REVERSAL_LONG')) {
        const cReversalLongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' }
        );
        cReversalLong = {
          type: 'C_REVERSAL_LONG', label: 'C REVERSAL (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: sessionLow ? +sessionLow.toFixed(0) : (orL ? +orL.toFixed(0) : null),
          target: cReversalLongT1.value,
          targetLabel: cReversalLongT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `C Up fires after a failed A Down signal, confirming that the initial bearish thesis reversed. Stop below session low (${sessionLow?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 5d: C REVERSAL (SHORT) ─────────────────────────────────────────
      let cReversalShort = null;
      if (aUpFired && cDownConf && !timelineEvents.some(e => e === 'C_REVERSAL_SHORT')) {
        const cReversalShortT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' }
        );
        cReversalShort = {
          type: 'C_REVERSAL_SHORT', label: 'C REVERSAL (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: sessionHigh ? +sessionHigh.toFixed(0) : (orH ? +orH.toFixed(0) : null),
          target: cReversalShortT1.value,
          targetLabel: cReversalShortT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `C Down fires after a failed A Up signal, confirming that the initial bullish thesis reversed. Stop above session high (${sessionHigh?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 6: FAILED AUCTION ───────────────────────────────────────────────
      let failedAuction = null;
      {
        const gLineLost      = timelineEvents.includes('G-Line lost');
        const gLineReclaimed = timelineEvents.includes('G-Line reclaimed');
        const pwHighTested   = timelineEvents.includes('PW High tested');
        const pwHighBroken   = timelineEvents.includes('PW High broken');
        const pwLowTested    = timelineEvents.includes('PW Low tested');
        const pwLowBroken    = timelineEvents.includes('PW Low broken');
        const lastBarVol     = latestBarRow.rows[0]?.volume || 0;
        const highVolume     = avgVol > 0 && lastBarVol > avgVol * 1.5;

        if (pwHighTested && !pwHighBroken && currentPrice && currentPrice < (orH || currentPrice + 50)) {
          failedAuction = {
            type: 'FAILED_AUCTION_SHORT', label: 'FAILED AUCTION — PRIOR WEEK HIGH',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice + (orRange || 50) * 0.3).toFixed(0),
            target: t1Guard('SHORT', currentPrice, pdVAL, currentPrice - (orRange || 50) * 0.5),
            targetLabel: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Extension',
            keyLevel: null, keyLevelLabel: 'Prior Week High',
            description: `Prior week high was tested but price failed to close above it — supply waiting. Bulls pushed to last week's extreme, found sellers, retreated. Fade the failed breakout.`,
            history: await getHistory('BALANCE'),
          };
        } else if (pwLowTested && !pwLowBroken && currentPrice && currentPrice > (orL || currentPrice - 50)) {
          failedAuction = {
            type: 'FAILED_AUCTION_LONG', label: 'FAILED AUCTION — PRIOR WEEK LOW',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice - (orRange || 50) * 0.3).toFixed(0),
            target: t1Guard('LONG', currentPrice, pdVAH, currentPrice + (orRange || 50) * 0.5),
            targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Extension',
            keyLevel: null, keyLevelLabel: 'Prior Week Low',
            description: `Prior week low tested but price failed to close below — buyers defended. Fade the failed breakdown toward prior day value area.`,
            history: await getHistory('BALANCE'),
          };
        } else if (gLineLost && gLineReclaimed && currentPrice) {
          failedAuction = {
            type: 'FAILED_AUCTION_LONG', label: 'FAILED AUCTION — G-LINE RECLAIM',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice - (orRange || 50) * 0.5).toFixed(0),
            target: t1Guard('LONG', currentPrice, pdVAH, currentPrice + (orRange || 50) * 0.5),
            targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Extension',
            keyLevel: null, keyLevelLabel: 'G-Line (weekly open)',
            description: `G-Line lost then reclaimed — bears failed to hold below weekly open. ${highVolume ? 'High volume on reclaim confirms conviction.' : ''} Long lean toward prior VAH.`,
            history: await getHistory('TRANSITIONAL'),
          };
        }
      }

      // ── SETUP 7: BRACKET BREAKOUT ─────────────────────────────────────────────
      let bracketBreakout = null;
      if (ltRow.rows.length >= 3 && orH && orL && currentPrice && pdVAH && pdVAL) {
        const priorHighs = ltRow.rows.map(r => r.or_high).filter(Boolean);
        const priorLows  = ltRow.rows.map(r => r.or_low).filter(Boolean);
        const bracketTop = priorHighs.length ? Math.max(...priorHighs) : null;
        const bracketBot = priorLows.length  ? Math.min(...priorLows)  : null;
        const breakingUp   = bracketTop && currentPrice > bracketTop + 5 && nl30State === 'BULLISH';
        const breakingDown = bracketBot && currentPrice < bracketBot - 5 && nl30State === 'BEARISH';
        if (breakingUp || breakingDown) {
          const isBull = breakingUp;
          bracketBreakout = {
            type: isBull ? 'BRACKET_BREAKOUT_LONG' : 'BRACKET_BREAKOUT_SHORT',
            label: isBull ? 'BRACKET BREAKOUT (LONG)' : 'BRACKET BREAKOUT (SHORT)',
            direction: isBull ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(isBull ? (bracketTop - 5) : (bracketBot + 5)).toFixed(0),
            target: isBull
              ? t1Guard('LONG',  currentPrice, pdVAH + (pdVAH - pdVAL), pdVAH, currentPrice + (orRange || 80))
              : t1Guard('SHORT', currentPrice, pdVAL - (pdVAH - pdVAL), pdVAL, currentPrice - (orRange || 80)),
            targetLabel: 'Value Area Extension',
            keyLevel: +(isBull ? bracketTop : bracketBot).toFixed(0),
            keyLevelLabel: isBull ? 'Prior Bracket Top' : 'Prior Bracket Bottom',
            description: isBull
              ? `5-session bracket top (${bracketTop?.toFixed(0)}) exceeded with NL30 +${nl30}. Prior bracket top becomes support — target: value area measured move.`
              : `5-session bracket bottom (${bracketBot?.toFixed(0)}) broken with NL30 ${nl30}. Prior bracket bottom becomes resistance.`,
            history: await getHistory(isBull ? 'TRENDING_UP' : 'TRENDING_DOWN'),
          };
        }
      }

      // ── SETUP 8: VALUE AREA RESPONSIVE ───────────────────────────────────────
      let valueAreaResp = null;
      if (liveOpenVsPrior === 'INSIDE_VALUE' && liveOpeningCallType !== 'OPEN_DRIVE' && currentPrice && pdVAH && pdVAL) {
        const nearVAH = Math.abs(currentPrice - pdVAH) <= 20;
        const nearVAL = Math.abs(currentPrice - pdVAL) <= 20;
        if (nearVAH || nearVAL) {
          const isFade = nearVAH;
          valueAreaResp = {
            type: isFade ? 'VALUE_AREA_RESPONSIVE_SHORT' : 'VALUE_AREA_RESPONSIVE_LONG',
            label: isFade ? 'VALUE AREA RESPONSIVE (SHORT)' : 'VALUE AREA RESPONSIVE (LONG)',
            direction: isFade ? 'SHORT' : 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(isFade ? (pdVAH + 8) : (pdVAL - 8)).toFixed(0),
            target: isFade
              ? t1Guard('SHORT', currentPrice, pdPOC, pdVAL, currentPrice - (orRange || 80) * 0.5)
              : t1Guard('LONG',  currentPrice, pdPOC, pdVAH, currentPrice + (orRange || 80) * 0.5),
            targetLabel: 'Prior Day POC',
            keyLevel: +(isFade ? pdVAH : pdVAL).toFixed(0),
            keyLevelLabel: isFade ? 'Prior Day VAH' : 'Prior Day VAL',
            description: isFade
              ? `Price opened inside prior value and is testing VAH (${pdVAH?.toFixed(0)}) with a non-drive open. Responsive sellers defend VAH — target POC (${pdPOC?.toFixed(0)}).`
              : `Price opened inside prior value and is testing VAL (${pdVAL?.toFixed(0)}). Responsive buyers defend VAL — target POC (${pdPOC?.toFixed(0)}).`,
            history: await getHistory('BALANCE'),
          };
        }
      }

      // ── SETUP 9: C STANDALONE ─────────────────────────────────────────────────
      // No A signal today — first C break of OR is the setup
      let cStandalone = null;
      if (!aUpFired && !aDownFired && !hasCFiredToday && currentPrice && orH && orL) {
        if (currentPrice > orH) {
          cStandalone = {
            type: 'C_STANDALONE_UP', label: 'C UP (STANDALONE)',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(orL - 4).toFixed(0),
            target: t1Guard('LONG', currentPrice, pdVAH, currentPrice + (orRange || 80)),
            targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Range Extension',
            keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High',
            description: `No A signal today. First C Up: price closing above OR High (${orH?.toFixed(0)}) with no prior A. Building data for standalone C setups.`,
            history: await getHistory('BALANCE'),
          };
        } else if (currentPrice < orL) {
          cStandalone = {
            type: 'C_STANDALONE_DOWN', label: 'C DOWN (STANDALONE)',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(orH + 4).toFixed(0),
            target: t1Guard('SHORT', currentPrice, pdVAL, currentPrice - (orRange || 80)),
            targetLabel: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Range Extension',
            keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low',
            description: `No A signal today. First C Down: price closing below OR Low (${orL?.toFixed(0)}) with no prior A. Building data for standalone C setups.`,
            history: await getHistory('BALANCE'),
          };
        }
      }

      // ── SETUP 10: GAP FILL ──────────────────────────────────────────────────
      let gapFill = null;
      {
        const rangesQ = await query(`
          SELECT d, rth_low, rth_high FROM (
            SELECT ts::date::text as d,
              MIN(low)::float as rth_low,
              MAX(high)::float as rth_high
            FROM price_bars_primary
            WHERE symbol='NQ'
              AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
              AND ts::date <= $1
            GROUP BY ts::date
            ORDER BY ts::date DESC
            LIMIT 40
          ) sub ORDER BY d ASC
        `, [todayET]);
        const sessions = rangesQ.rows;

        if (sessions.length >= 2 && currentPrice) {
          const gaps = [];
          for (let i = 1; i < sessions.length; i++) {
            const prev = sessions[i - 1];
            const curr = sessions[i];
            if (curr.rth_low > prev.rth_high) {
              gaps.push({ type: 'up', fromDate: prev.d, toDate: curr.d, gapLow: prev.rth_high, gapHigh: curr.rth_low });
            } else if (curr.rth_high < prev.rth_low) {
              gaps.push({ type: 'down', fromDate: prev.d, toDate: curr.d, gapLow: curr.rth_high, gapHigh: prev.rth_low });
            }
          }

          const openGaps = [];
          for (const gap of gaps) {
            const gapIdx = sessions.findIndex(s => s.d === gap.toDate);
            const gapSize = gap.gapHigh - gap.gapLow;
            let filled = false;
            for (let i = gapIdx + 1; i < sessions.length; i++) {
              const s = sessions[i];
              if (gap.type === 'up') {
                if (s.rth_low <= gap.gapLow) { filled = true; break; }
              } else {
                if (s.rth_high >= gap.gapHigh) { filled = true; break; }
              }
            }
            if (!filled) {
              openGaps.push({ ...gap, gapSize });
            }
          }

          for (const gap of openGaps) {
            if (currentPrice < gap.gapHigh && currentPrice > gap.gapLow) {
              if (gap.type === 'up') {
                gapFill = {
                  type: 'GAP_FILL_SHORT',
                  label: `GAP FILL SHORT (${gap.fromDate} to ${gap.toDate})`,
                  direction: 'SHORT',
                  entry: +currentPrice.toFixed(0),
                  stop: +Math.round(gap.gapHigh + 15),
                  target: t1Guard('SHORT', currentPrice, gap.gapLow),
                  targetLabel: 'Gap Floor',
                  keyLevel: +Math.round(gap.gapHigh),
                  keyLevelLabel: 'Gap Ceiling',
                  description: `NQ entered the unfilled up-gap zone from ${gap.fromDate} to ${gap.toDate} (${Math.round(gap.gapLow)}–${Math.round(gap.gapHigh)}). Expecting fast travel to complete the gap fill down to ${Math.round(gap.gapLow)}. Invalidation is 15 pts above gap ceiling.`,
                  history: await getHistory('TREND'),
                };
              } else {
                gapFill = {
                  type: 'GAP_FILL_LONG',
                  label: `GAP FILL LONG (${gap.fromDate} to ${gap.toDate})`,
                  direction: 'LONG',
                  entry: +currentPrice.toFixed(0),
                  stop: +Math.round(gap.gapLow - 15),
                  target: t1Guard('LONG', currentPrice, gap.gapHigh),
                  targetLabel: 'Gap Ceiling',
                  keyLevel: +Math.round(gap.gapLow),
                  keyLevelLabel: 'Gap Floor',
                  description: `NQ entered the unfilled down-gap zone from ${gap.fromDate} to ${gap.toDate} (${Math.round(gap.gapLow)}–${Math.round(gap.gapHigh)}). Expecting fast travel to complete the gap fill up to ${Math.round(gap.gapHigh)}. Invalidation is 15 pts below gap floor.`,
                  history: await getHistory('TREND'),
                };
              }
              break;
            }
          }
        }
      }

      // ── Priority selection (spec order) ──────────────────────────────────────
      // Integrity guard: a setup must not fire with the stop on the wrong side of
      // entry (non-positive risk — e.g. VALUE_AREA_RESPONSIVE's ±8pt buffer can land
      // past entry relative to where price already is vs the prior-day value area,
      // and OPEN_DRIVE's orL-2/orH+2 stop can do the same when price has already
      // drifted past the OR boundary by fire time). Such a setup is pre-invalidated
      // at the moment of detection — reject it and fall through to the next-priority
      // candidate rather than persisting a guaranteed-instant-stop "setup".
      const candidates = [
        trtMah,
        trtLongV2, trtShortV2,
        trt,
        gapFill,
        aUpStrong, aDownStrong,
        otdSetup,
        aUpWeak, aDownWeak,
        ibSetup,
        openDrive,
        cPairedLong, cPairedShort,
        cReversalLong, cReversalShort,
        failedAuction,
        bracketBreakout,
        valueAreaResp,
        cStandalone
      ];
      let active = null;
      for (const cand of candidates) {
        if (!cand) continue;
        const isLongCand = cand.direction === 'LONG';
        const riskOk = cand.stop == null || (isLongCand ? cand.stop < cand.entry : cand.stop > cand.entry);
        if (!riskOk) {
          console.error(`[setup-detection] REJECTED ${cand.type} — non-positive risk: stop ${cand.stop} vs entry ${cand.entry} (${cand.direction})`);
          continue;
        }
        active = cand;
        break;
      }
      if (!active) return res.json({ setup: null, noNewEntries: !!noNewEntries });

      // ── Persist first-detection to active_setups (source of truth) ───────────
      // fired_at = latest bar ts at first detection (bar-accurate, not poll wall-clock).
      // price_bars.ts stores ET times as TIMESTAMP WITHOUT TIME ZONE — pg returns them
      // as JS Dates where UTC fields equal the ET hours/minutes.
      const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const latestBarTs = latestBarRow.rows[0]?.ts; // ET time stored as UTC by pg driver
      const firedAtTs = latestBarTs
        ? latestBarTs.toISOString().replace('T', ' ').slice(0, 19)
        : etNow.toISOString().replace('T', ' ').slice(0, 19);
      const firedTimeStr = latestBarTs
        ? `${String(latestBarTs.getUTCHours()).padStart(2,'0')}:${String(latestBarTs.getUTCMinutes()).padStart(2,'0')}:00`
        : `${String(etNow.getHours()).padStart(2,'0')}:${String(etNow.getMinutes()).padStart(2,'0')}:00`;

      // Expiry per setup type (minutes from fired_at); null = no time expiry
      const EXPIRY_WINDOW = {
        TRT_SHORT: 50, TRT_LONG: 50, TRT_SHORT_V2: 50, TRT_LONG_V2: 50, TRT_MAH_SHORT: 50, TRT_MAH_LONG: 50,
        OPEN_TEST_DRIVE_SHORT: 45, OPEN_TEST_DRIVE_LONG: 45,
        IB_BULLISH: null, IB_BEARISH: null,
        OPEN_DRIVE_LONG: null, OPEN_DRIVE_SHORT: null,
        C_STANDALONE_UP: null, C_STANDALONE_DOWN: null,
        FAILED_AUCTION_SHORT: 30, FAILED_AUCTION_LONG: 30,
        VALUE_AREA_RESPONSIVE_SHORT: null, VALUE_AREA_RESPONSIVE_LONG: null,
        BRACKET_BREAKOUT_LONG: 960, BRACKET_BREAKOUT_SHORT: 960, // full session
        A_UP_STRONG: null, A_DOWN_STRONG: null,
        A_UP_WEAK: null, A_DOWN_WEAK: null,
        C_PAIRED_LONG: null, C_PAIRED_SHORT: null,
        C_REVERSAL_LONG: null, C_REVERSAL_SHORT: null,
        GAP_FILL_LONG: null, GAP_FILL_SHORT: null,
      };
      // Hard cap: 1:00 PM ET (session end). Use local (ET) time formatting so PostgreSQL
      // interprets the stored TIMESTAMP WITHOUT TZ correctly in its session timezone.
      const fmtETStr = (d) => {
        const y = d.getFullYear(), mo = String(d.getMonth()+1).padStart(2,'0'),
              day = String(d.getDate()).padStart(2,'0'),
              h = String(d.getHours()).padStart(2,'0'), m = String(d.getMinutes()).padStart(2,'0');
        return `${y}-${mo}-${day} ${h}:${m}:00`;
      };
      const sessionEndET = new Date(etNow); sessionEndET.setHours(13, 0, 0, 0);
      const computeExpiry = (type) => {
        if (type === 'BRACKET_BREAKOUT_LONG' || type === 'BRACKET_BREAKOUT_SHORT') {
          const eodET = new Date(etNow); eodET.setHours(16, 0, 0, 0);
          return fmtETStr(eodET);
        }
        const windowMins = EXPIRY_WINDOW[type];
        const byWindow = windowMins ? new Date(etNow.getTime() + windowMins * 60000) : sessionEndET;
        return fmtETStr(byWindow < sessionEndET ? byWindow : sessionEndET);
      };

      const existingSetup = await query(`
        SELECT id, fired_at::text as fired_at, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label
        FROM active_setups WHERE trade_date=$1 AND setup_type=$2
        ORDER BY fired_at DESC LIMIT 1
      `, [todayET, active.type]);

      // Safety guard: T1 must be above entry for LONG, below entry for SHORT.
      // If any target computation produced a wrong-direction value, null it out.
      let safeT1Level = active.target;
      let safeT1Label = active.targetLabel;
      if (safeT1Level != null) {
        const isLongSetup = active.direction === 'LONG';
        if ((isLongSetup && safeT1Level <= active.entry) || (!isLongSetup && safeT1Level >= active.entry)) {
          console.error(`[setup-detection] REJECTED T1 ${safeT1Level} for ${active.type} — wrong side of entry ${active.entry} (${active.direction})`);
          safeT1Level = null;
          safeT1Label = 'NO_VIABLE_TARGET';
        }
      }

      // The persisted active_setups row is the ONE canonical source for tradeable
      // levels (entry/stop/target). Once a setup is detected, those levels are frozen
      // for its lifetime — the live recompute above (`active.entry/stop/target`) only
      // feeds the INSERT on first detection; every subsequent poll must echo back the
      // persisted row so the card never shows a drifting, per-poll-recomputed target.
      let detectedAt, setupId, persistedLevels;
      if (existingSetup.rows.length) {
        const row = existingSetup.rows[0];
        detectedAt = row.fired_at.slice(11, 16); // HH:MM
        setupId    = row.id;
        persistedLevels = {
          entry: row.entry_zone_low != null ? +row.entry_zone_low : active.entry,
          stop: row.stop_level != null ? +row.stop_level : active.stop,
          target: row.t1_level != null ? +row.t1_level : null,
          targetLabel: row.t1_label || 'NO_VIABLE_TARGET',
        };
      } else {
        const hist = active.history || {};
        const ins = await query(`
          INSERT INTO active_setups (
            trade_date, setup_type, fired_at, expires_at, status,
            entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
            price_at_detection,
            historical_win_rate, historical_sessions, historical_avg_pnl, historical_t1_hit_rate,
            nl30_at_detection, structural_state_at_detection
          ) VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT DO NOTHING RETURNING id, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label
        `, [
          todayET, active.type, firedAtTs, computeExpiry(active.type),
          active.entry, active.entry, active.stop, safeT1Level, safeT1Label,
          active.entry,
          hist.winRate ?? null, hist.occurrences ?? null, hist.avgPnl ?? null, hist.t1HitRate ?? null,
          nl30, nl30State === 'BULLISH' ? 'TRENDING_UP' : nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE',
        ]);
        let row = ins.rows[0];
        if (!row) {
          // ON CONFLICT DO NOTHING — a concurrent poll won the race and persisted first.
          // Re-select so we still serve the canonical persisted row, not our live recompute.
          const won = await query(`
            SELECT id, fired_at::text as fired_at, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label
            FROM active_setups WHERE trade_date=$1 AND setup_type=$2
            ORDER BY fired_at DESC LIMIT 1
          `, [todayET, active.type]);
          row = won.rows[0];
          if (row) detectedAt = row.fired_at.slice(11, 16);
        }
        setupId    = row?.id;
        detectedAt = detectedAt || firedTimeStr.slice(0, 5);
        persistedLevels = row ? {
          entry: row.entry_zone_low != null ? +row.entry_zone_low : active.entry,
          stop: row.stop_level != null ? +row.stop_level : active.stop,
          target: row.t1_level != null ? +row.t1_level : null,
          targetLabel: row.t1_label || 'NO_VIABLE_TARGET',
        } : { entry: active.entry, stop: active.stop, target: safeT1Level, targetLabel: safeT1Label };
        // Backward compat: also write to acd_setup_events
        await query(`
          INSERT INTO acd_setup_events (trade_date, setup_type, fired_time, fired_price)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
        `, [todayET, active.type, firedTimeStr, active.entry || null]);
      }

      const expiresAt = computeExpiry(active.type);
      const minsRemaining = Math.max(0, Math.round((new Date(expiresAt) - etNow) / 60000));
      const isExpired = minsRemaining === 0;

      res.json({
        setup: {
          ...active,
          entry: persistedLevels.entry,
          stop: persistedLevels.stop,
          target: persistedLevels.target,
          targetLabel: persistedLevels.targetLabel,
          detectedAt, minsRemaining, isExpired, setupId,
        },
        noNewEntries: !!noNewEntries,
      });
    } catch(e) { console.error('setup-detection error:', e); res.status(500).json({ error: e.message }); }
  });

  // ── Replayed baseline stats (replaces hardcoded SETUP_BASELINES) ──────────
  // Source: setup_daytype_winrates, populated by scripts/replay_all_setups.js +
  // scripts/populate_setup_daytype_winrates.js — a full-history replay of the
  // CURRENT detection rules (incl. the negative-risk/zero-reward integrity guard),
  // resolved with the current price-vs-T1/stop logic. The 'OVERALL' row is the
  // blended (all day types) baseline; TREND/BALANCE/TURBULENT rows back the
  // conditional-edge display on setup cards.
  const getReplayBaseline = async (setupType) => {
    const r = await query(`
      SELECT day_type, n, decided_n, win_rate, limited_sample
      FROM setup_daytype_winrates
      WHERE setup_type=$1 AND computed_date = (SELECT MAX(computed_date) FROM setup_daytype_winrates)
    `, [setupType]).catch(() => ({ rows: [] }));
    const byDayType = {};
    for (const row of r.rows) {
      byDayType[row.day_type] = {
        n: row.n, decidedN: row.decided_n,
        winRate: row.win_rate != null ? parseFloat(row.win_rate) : null,
        limitedSample: row.limited_sample,
      };
    }
    return byDayType;
  };

  const MIN_SAMPLE = 5; // minimum resolved setups before live stats override baseline

  // Returns { allTime, d90, d60, d30 } each with { winRate, sessions, t1HitRate, avgPnl }
  const getSetupStats = async (setupType) => {
    const r = await query(`
      SELECT
        'all'  as tf, COUNT(*) FILTER (WHERE resolution='TARGET_HIT') as wins, COUNT(*) as total, AVG(actual_pnl) as avg_pnl
        FROM active_setups WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT')
      UNION ALL
      SELECT
        '90d', COUNT(*) FILTER (WHERE resolution='TARGET_HIT'), COUNT(*), AVG(actual_pnl)
        FROM active_setups WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND fired_at >= NOW() - INTERVAL '90 days'
      UNION ALL
      SELECT
        '60d', COUNT(*) FILTER (WHERE resolution='TARGET_HIT'), COUNT(*), AVG(actual_pnl)
        FROM active_setups WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND fired_at >= NOW() - INTERVAL '60 days'
      UNION ALL
      SELECT
        '30d', COUNT(*) FILTER (WHERE resolution='TARGET_HIT'), COUNT(*), AVG(actual_pnl)
        FROM active_setups WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND fired_at >= NOW() - INTERVAL '30 days'
    `, [setupType]).catch(() => ({ rows: [] }));

    const byDayType = await getReplayBaseline(setupType);
    const overall = byDayType.OVERALL || null;
    const fmt = (rows, tf) => {
      const row = rows.find(r => r.tf === tf);
      const n = row ? parseInt(row.total) : 0;
      if (n >= MIN_SAMPLE) {
        return {
          winRate: n > 0 ? parseFloat(row.wins) / n : null,
          sessions: n,
          t1HitRate: null,
          avgPnl: row.avg_pnl != null ? parseFloat(row.avg_pnl) : null,
        };
      }
      // Fall back to the full-history replay baseline for all-time; null for shorter windows
      if (tf === 'all' && overall?.winRate != null) {
        return { winRate: overall.winRate, sessions: overall.n, t1HitRate: null, avgPnl: null, isBaseline: true, limitedSample: overall.limitedSample };
      }
      return null;
    };

    return { allTime: fmt(r.rows, 'all'), d90: fmt(r.rows, '90d'), d60: fmt(r.rows, '60d'), d30: fmt(r.rows, '30d'), byDayType };
  };

  // ── GET /api/setups/active ─────────────────────────────────────────────────
  router.get('/setups/active', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const r = await query(`
        SELECT *, fired_at::text as fired_at_str, expires_at::text as expires_at_str
        FROM active_setups WHERE trade_date=$1 AND status='ACTIVE' ORDER BY fired_at DESC LIMIT 1
      `, [todayET]);
      if (!r.rows.length) return res.json({ setup: null });
      const s = r.rows[0];
      const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const minsRemaining = s.expires_at_str
        ? Math.max(0, Math.round((new Date(s.expires_at_str) - etNow) / 60000))
        : null;
      res.json({ setup: { ...s, minsRemaining } });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/setups/today ──────────────────────────────────────────────────
  router.get('/setups/today', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const r = await query(`
        SELECT *, fired_at::text as fired_at_str, expires_at::text as expires_at_str,
          resolved_at::text as resolved_at_str
        FROM active_setups WHERE trade_date=$1 ORDER BY fired_at
      `, [todayET]);
      res.json({ setups: r.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/setups/:id/outcome ───────────────────────────────────────────
  router.post('/setups/:id/outcome', async (req, res) => {
    try {
      const { id } = req.params;
      const { resolution, actualPnl, priceAtResolution } = req.body; // resolution: TARGET_HIT|STOP_HIT|INVALIDATED
      const r = await query(`
        UPDATE active_setups
        SET status='RESOLVED', resolution=$2, actual_pnl=$3, price_at_resolution=$4,
            resolved_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status='ACTIVE'
        RETURNING *
      `, [id, resolution, actualPnl ?? null, priceAtResolution ?? null]);
      if (!r.rows.length) return res.status(404).json({ error: 'setup not found or already resolved' });
      await dropToTimeline(r.rows[0]);
      io.emit('setup-resolved', { setupId: parseInt(id), resolution, setupType: r.rows[0].setup_type });
      res.json({ ok: true, setup: r.rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/setups/stats?type=IB_BULLISH ─────────────────────────────────
  router.get('/setups/stats', async (req, res) => {
    try {
      const { type } = req.query;
      if (!type) return res.status(400).json({ error: 'type required' });
      const stats = await getSetupStats(type);
      res.json(stats);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/timeline/today ────────────────────────────────────────────────
  const CONVICTION_KEY_BY_SETUP = {
    IB_BULLISH: 'ib_high', IB_BEARISH: 'ib_low',
    TRT_LONG: 'ib_low', TRT_SHORT: 'ib_high',
    TRT_LONG_V2: 'ib_low', TRT_SHORT_V2: 'ib_high',
    OPEN_DRIVE_LONG: 'ib_high', OPEN_DRIVE_SHORT: 'ib_low',
    C_STANDALONE_UP: 'ib_high', C_STANDALONE_DOWN: 'ib_low',
    BRACKET_BREAKOUT_LONG: 'bracket_high', BRACKET_BREAKOUT_SHORT: 'bracket_low',
    VALUE_AREA_RESPONSIVE_LONG: 'composite_val', VALUE_AREA_RESPONSIVE_SHORT: 'composite_vah',
    FAILED_AUCTION_LONG: 'bracket_low', FAILED_AUCTION_SHORT: 'bracket_high',
    A_UP_STRONG: 'ib_high', A_DOWN_STRONG: 'ib_low',
    A_UP_WEAK: 'ib_high', A_DOWN_WEAK: 'ib_low',
    C_PAIRED_LONG: 'ib_high', C_PAIRED_SHORT: 'ib_low',
    C_REVERSAL_LONG: 'ib_high', C_REVERSAL_SHORT: 'ib_low',
    GAP_FILL_LONG: 'bracket_high', GAP_FILL_SHORT: 'bracket_low',
  };

  router.get('/timeline/today', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const { filter = 'significant' } = req.query;
      const r = await query(`
        SELECT t.*, s.setup_type as parent_setup_type, s.status as parent_status,
          s.actual_pnl, s.price_at_resolution, s.invalidation_timing,
          ROUND(EXTRACT(EPOCH FROM (COALESCE(s.resolved_at, NOW()) - s.fired_at))/60::numeric, 0) as minutes_active,
          t.event_time::text as event_time_str,
          tr.pnl as matched_trade_pnl,
          EXTRACT(EPOCH FROM (tr.entry_time - t.event_time)) as match_offset_secs
        FROM trade_timeline_events t
        LEFT JOIN active_setups s ON t.setup_id = s.id
        LEFT JOIN LATERAL (
          SELECT pnl, entry_time FROM trades
          WHERE log_date = t.trade_date
            AND ABS(EXTRACT(EPOCH FROM (entry_time - t.event_time))) < 300
            AND pnl IS NOT NULL
          ORDER BY ABS(EXTRACT(EPOCH FROM (entry_time - t.event_time))) ASC
          LIMIT 1
        ) tr ON true
        WHERE t.trade_date = $1
          AND (
            $2 = 'all'
            OR (
              t.event_type = 'SETUP'
              AND (t.historical_sessions >= 20 OR t.historical_win_rate IS NOT NULL)
              AND (
                t.resolution IN ('TARGET_HIT','STOP_HIT')
                OR t.resolution IS NULL
                OR (t.resolution = 'INVALIDATED' AND s.invalidation_timing = 'POST_ENTRY')
              )
            )
          )
        ORDER BY t.event_time
      `, [todayET, filter]);

      // Augment rows with conviction_key and estimated pts
      const conviction = await getConvictionData().catch(() => null);
      let nl30 = 0, structuralState = null;
      const cnl = getCached(todayET, 'nl30');
      if (cnl) { nl30 = cnl.nl30; structuralState = cnl.nl30State === 'BULLISH' ? 'TRENDING_UP' : cnl.nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE'; }

      // Fetch MFE for POST_ENTRY invalidated setups: max favorable excursion from entry to invalidation
      // active_setups.fired_at and resolved_at store ET as TIMESTAMP WITHOUT TZ.
      // price_bars.ts stores UTC as TIMESTAMP WITHOUT TZ.
      // Use AT TIME ZONE to convert the ET timestamps to UTC before comparing.
      const postEntryInvalidated = r.rows.filter(
        ev => ev.resolution === 'INVALIDATED' && ev.invalidation_timing === 'POST_ENTRY' && ev.setup_id
      );
      const mfeBySetupId = {};
      if (postEntryInvalidated.length > 0) {
        const setupIds = postEntryInvalidated.map(ev => ev.setup_id);
        const setupTimes = await query(`
          SELECT id,
            fired_at::text as fired_at_str,
            resolved_at::text as resolved_at_str,
            entry_zone_low, setup_type
          FROM active_setups WHERE id = ANY($1)
        `, [setupIds]);
        for (const s of setupTimes.rows) {
          const isLong = (s.setup_type || '').includes('LONG') || (s.setup_type || '').includes('BULLISH');
          const entry = parseFloat(s.entry_zone_low) || null;
          if (!entry || !s.fired_at_str || !s.resolved_at_str) continue;
          try {
            // Cast text → timestamp AT TIME ZONE 'America/New_York' to get UTC-equivalent TIMESTAMPTZ,
            // then compare against price_bars.ts (UTC stored as TIMESTAMP WITHOUT TZ via session UTC).
            const mfeQ = await query(`
              SELECT ${isLong ? 'MAX(high)' : 'MIN(low)'}::float as mfe_price
              FROM price_bars_primary
              WHERE symbol='NQ'
                AND ts >= ($1::timestamp AT TIME ZONE 'America/New_York')::timestamp
                AND ts <= ($2::timestamp AT TIME ZONE 'America/New_York')::timestamp
            `, [s.fired_at_str, s.resolved_at_str]);
            const mfePrice = mfeQ.rows[0]?.mfe_price;
            if (mfePrice != null) {
              mfeBySetupId[s.id] = isLong
                ? Math.round(mfePrice - entry)
                : Math.round(entry - mfePrice);
            }
          } catch (_) {}
        }
      }

      const events = r.rows.map(ev => {
        const ck = CONVICTION_KEY_BY_SETUP[ev.setup_type] || null;
        const cvBase = ck && conviction ? conviction[ck] : null;
        const cvDynamic = cvBase ? computeDynamicConviction(cvBase, ck, { nl30, structuralState }) : null;
        const isLong = ev.direction === 'LONG';
        const entry = parseFloat(ev.entry_zone) || null;
        const t1 = parseFloat(ev.t1_level) || null;
        const stop = parseFloat(ev.stop_level) || null;
        const estimated_pts = (entry != null && t1 != null)
          ? Math.abs(t1 - entry)
          : null;
        const stop_pts = (entry != null && stop != null)
          ? Math.abs(stop - entry)
          : null;
        const mfe_pts = ev.setup_id ? (mfeBySetupId[ev.setup_id] ?? null) : null;
        return { ...ev, conviction_key: ck, conviction: cvDynamic || cvBase || null, estimated_pts, stop_pts, mfe_pts };
      });

      res.json({ events });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/setups/playbook-reference ────────────────────────────────────
  router.get('/setups/playbook-reference', async (req, res) => {
    try {
      // ACD backtest results — NL-aligned vs counter-trend for A signals
      const br = await query(`
        SELECT nl_aligned, win_rate::float, win_rate_nl_above_9::float,
          win_rate_nl_below_9::float, win_rate_nl_ranging::float,
          total_signals, filter_label
        FROM acd_backtest_results
        ORDER BY run_date DESC LIMIT 10
      `);
      const nlAligned    = br.rows.find(r => r.nl_aligned === true);
      const counterTrend = br.rows.find(r => r.nl_aligned === false);

      // Active setups win rates by type (from resolved setups with decisive outcomes)
      const sr = await query(`
        SELECT setup_type,
          COUNT(*) FILTER (WHERE resolution IN ('TARGET_HIT','STOP_HIT')) as decided,
          COUNT(*) FILTER (WHERE resolution = 'TARGET_HIT') as wins
        FROM active_setups
        WHERE resolution IN ('TARGET_HIT','STOP_HIT')
        GROUP BY setup_type
      `);
      const setupStats = {};
      for (const row of sr.rows) {
        const n = parseInt(row.decided);
        setupStats[row.setup_type] = {
          n,
          winRate: n > 0 ? Math.round(parseInt(row.wins) / n * 100) / 100 : null,
        };
      }

      res.json({
        aSignalAligned: nlAligned ? {
          winRate: nlAligned.win_rate,
          winRateNLAbove9: nlAligned.win_rate_nl_above_9,
          winRateNLRanging: nlAligned.win_rate_nl_ranging,
          totalSignals: nlAligned.total_signals,
        } : null,
        aSignalCounter: counterTrend ? {
          winRate: counterTrend.win_rate,
          winRateNLAbove9: counterTrend.win_rate_nl_above_9,
          winRateNLRanging: counterTrend.win_rate_nl_ranging,
          totalSignals: counterTrend.total_signals,
        } : null,
        setupStats,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
