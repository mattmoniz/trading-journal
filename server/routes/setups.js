import express from 'express';
import { query, getClient } from '../db.js';
import { getStructuralLevels } from '../services/phaseChangeDetector.js';
import { runSetupBacktest, getBacktestEdge } from '../services/setupBacktestService.js';
import { inferDirection, STACK_VOL_THRESHOLDS, CONDITIONAL_VARIANTS } from '../config/setupTypes.js';
import { OTHER_SETUP_DEFINITIONS, GLOBEX_CAPABLE_TYPES, WINDOW_RULES, getLevelFadeDefinition, getSetupGroup } from '../config/setupDefinitions.js';
import { INSTRUMENTS } from '../config/instruments.js';
import { getDeltaConfirmationCategory } from '../services/deltaConfirmation.js';
import { REAL_TRADE_FILTER } from '../../scripts/backtest_setup_status.mjs';
import { MECHANISMS, MIN_REAL_N, evalBucket, modeOf } from '../../scripts/backtest_flush_post_entry_exit_signals_promotion.mjs';

const router = express.Router();

// Fallback medians from Key Level Analysis when sessions < 3
const FALLBACK_MEDIANS = {
  'IB_BEARISH': 34, 'IB_BULLISH': 34,
  'OPEN_DRIVE_LONG': 34, 'OPEN_DRIVE_SHORT': 34,
  'TRT_SHORT': 33, 'TRT_LONG': 33, 'TRT_MAH_SHORT': 33, 'TRT_MAH_LONG': 33,
  'FAILED_AUCTION_SHORT': 28, 'FAILED_AUCTION_LONG': 28,
  'VALUE_AREA_RESPONSIVE_LONG': 28, 'VALUE_AREA_RESPONSIVE_SHORT': 28,
  'BRACKET_BREAKOUT_LONG': 40, 'BRACKET_BREAKOUT_SHORT': 40,
  'GAP_FILL_LONG': 40, 'GAP_FILL_SHORT': 40,
};
const DEFAULT_FALLBACK = 32;
const getFallback = (setupType) => FALLBACK_MEDIANS[setupType] ?? DEFAULT_FALLBACK;

// Phase change backtest validated magnitudes for counter-trend setups (n=1622, ≥3 conditions)
const LEVEL_MAGNITUDES = {
  'BRACKET_LOW': 63, 'COMPOSITE_VAL': 56, 'PRIOR_DAY_VAL': 48,
  'BRACKET_HIGH': 55, 'COMPOSITE_POC': 49, 'PRIOR_DAY_POC': 38,
  'COMPOSITE_VAH': 38, 'PRIOR_DAY_VAH': 29,
};
const COUNTER_TREND_SETUPS = new Set([
  'TRT_SHORT','TRT_LONG','TRT_MAH_SHORT','TRT_MAH_LONG',
  'VALUE_AREA_RESPONSIVE_LONG','VALUE_AREA_RESPONSIVE_SHORT',
]);

// Weighting formula per spec
function calcWeightedTarget(levelDist, avg30, n30, avg90, n90, avgAll, nAll, modifier) {
  let base;
  if (n30 >= 10) {
    base = levelDist * 0.40 + avg30 * 0.35 + avg90 * 0.15 + avgAll * 0.10;
  } else if (n90 >= 10) {
    base = levelDist * 0.50 + avg90 * 0.35 + avgAll * 0.15;
  } else {
    base = levelDist * 0.60 + avgAll * 0.40;
  }
  return Math.round(base * modifier * 4) / 4;
}

// GET /api/setups/tp-recommendation?setupType=TRT_SHORT[&setupId=123]
router.get('/setups/tp-recommendation', async (req, res) => {
  try {
    const { setupType, setupId } = req.query;
    if (!setupType) return res.status(400).json({ error: 'setupType required' });

    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const isLong = inferDirection(setupType) === 'LONG';

    // Find active setup for entry zone — by id, then ACTIVE status, then most recent
    let setupRow = null;
    if (setupId) {
      const sq = await query(`SELECT * FROM active_setups WHERE id = $1`, [parseInt(setupId)]);
      setupRow = sq.rows[0] || null;
    }
    if (!setupRow) {
      const sq = await query(
        `SELECT * FROM active_setups WHERE setup_type = $1 AND status = 'ACTIVE'
         ORDER BY fired_at DESC LIMIT 1`, [setupType]);
      setupRow = sq.rows[0] || null;
    }
    if (!setupRow) {
      const sq = await query(
        `SELECT * FROM active_setups WHERE setup_type = $1
         ORDER BY fired_at DESC LIMIT 1`, [setupType]);
      setupRow = sq.rows[0] || null;
    }

    const entryLow  = setupRow?.entry_zone_low  != null ? parseFloat(setupRow.entry_zone_low)  : null;
    const entryHigh = setupRow?.entry_zone_high != null ? parseFloat(setupRow.entry_zone_high) : null;
    const entryMidpoint = (entryLow != null && entryHigh != null) ? (entryLow + entryHigh) / 2 : null;

    // Structural levels (composite, prior day, bracket)
    const structLevels = await getStructuralLevels(todayET);

    // IB levels = today's OR high/low
    const orQ = await query(
      `SELECT or_high, or_low FROM acd_daily_log WHERE trade_date = $1`, [todayET]);
    const ibHigh = orQ.rows[0]?.or_high != null ? parseFloat(orQ.rows[0].or_high) : null;
    const ibLow  = orQ.rows[0]?.or_low  != null ? parseFloat(orQ.rows[0].or_low)  : null;

    // Overnight high/low from price_bars
    const prevDateQ = await query(
      `SELECT ts::date::text as d FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1
       AND EXTRACT(HOUR FROM ts) BETWEEN 9 AND 16
       ORDER BY ts::date DESC LIMIT 1`, [todayET]);
    let overnightHigh = null, overnightLow = null;
    const prevDate = prevDateQ.rows[0]?.d;
    if (prevDate) {
      const onQ = await query(`
        SELECT MAX(high)::float as h, MIN(low)::float as l
        FROM price_bars_primary WHERE symbol='NQ'
          AND ((ts::date::text = $1 AND EXTRACT(HOUR FROM ts) >= 16)
               OR (ts::date::text = $2 AND EXTRACT(HOUR FROM ts) < 10))
      `, [prevDate, todayET]);
      overnightHigh = onQ.rows[0]?.h || null;
      overnightLow  = onQ.rows[0]?.l || null;
    }

    // Build candidate levels for nearest relevant level in trade direction
    const longResistance = new Set(['COMPOSITE_VAH', 'PRIOR_DAY_VAH', 'BRACKET_HIGH']);
    const shortSupport   = new Set(['COMPOSITE_VAL', 'PRIOR_DAY_VAL', 'BRACKET_LOW']);
    let candidates = structLevels.filter(l => isLong ? longResistance.has(l.type) : shortSupport.has(l.type));
    if (ibHigh != null && isLong)        candidates.push({ type: 'IB_HIGH',        price: ibHigh });
    if (ibLow  != null && !isLong)       candidates.push({ type: 'IB_LOW',         price: ibLow  });
    if (overnightHigh != null && isLong) candidates.push({ type: 'OVERNIGHT_HIGH', price: overnightHigh });
    if (overnightLow  != null && !isLong)candidates.push({ type: 'OVERNIGHT_LOW',  price: overnightLow  });

    const MIN_LEVEL_DISTANCE = 15;
    let levelType = null, levelPrice = null, levelDistance = null, skippedLevelDistance = null;
    if (entryMidpoint != null && candidates.length > 0) {
      const directed = isLong
        ? candidates.filter(l => l.price > entryMidpoint)
        : candidates.filter(l => l.price < entryMidpoint);
      if (directed.length > 0) {
        // Sort by distance ascending, pick first with distance >= MIN_LEVEL_DISTANCE
        const sorted = directed.sort((a, b) =>
          Math.abs(a.price - entryMidpoint) - Math.abs(b.price - entryMidpoint));
        const tooClose = sorted.filter(l => Math.abs(l.price - entryMidpoint) < MIN_LEVEL_DISTANCE);
        if (tooClose.length > 0) skippedLevelDistance = Math.round(Math.abs(tooClose[0].price - entryMidpoint) * 100) / 100;
        const viable = sorted.find(l => Math.abs(l.price - entryMidpoint) >= MIN_LEVEL_DISTANCE);
        if (viable) {
          levelType     = viable.type;
          levelPrice    = viable.price;
          levelDistance = Math.abs(viable.price - entryMidpoint);
        }
      }
    }

    // Setup move stats (most recent calculated_date for this setup type)
    const statsQ = await query(
      `SELECT * FROM setup_move_stats WHERE setup_type = $1
       ORDER BY calculated_date DESC LIMIT 1`, [setupType]);
    const stats = statsQ.rows[0] || {};

    const avgMove30d     = stats.avg_move_30d     != null ? parseFloat(stats.avg_move_30d)     : null;
    const sessions30d    = stats.sessions_30d     || 0;
    const avgMove90d     = stats.avg_move_90d     != null ? parseFloat(stats.avg_move_90d)     : null;
    const sessions90d    = stats.sessions_90d     || 0;
    const avgMoveAllTime = stats.avg_move_alltime != null ? parseFloat(stats.avg_move_alltime) : null;
    const sessionsAllTime= stats.sessions_alltime || 0;

    // Counter-trend setups use backtest-validated level magnitudes; trend-aligned use setup-type medians
    const isCounterTrend = COUNTER_TREND_SETUPS.has(setupType);
    const levelMagnitudeFallback = (isCounterTrend && levelType && LEVEL_MAGNITUDES[levelType])
      ? LEVEL_MAGNITUDES[levelType]
      : getFallback(setupType);

    // Apply fallback when sessions < 3
    const eff30  = (sessions30d     >= 3 && avgMove30d     != null) ? avgMove30d     : levelMagnitudeFallback;
    const eff90  = (sessions90d     >= 3 && avgMove90d     != null) ? avgMove90d     : levelMagnitudeFallback;
    const effAll = (sessionsAllTime >= 3 && avgMoveAllTime != null) ? avgMoveAllTime : levelMagnitudeFallback;
    const effLevelDist = levelDistance ?? levelMagnitudeFallback;

    // ATR regime (10d vs 20d from price_bars)
    const atrQ = await query(`
      SELECT
        AVG(dr) FILTER (WHERE rn <= 10) as atr_10d,
        AVG(dr) FILTER (WHERE rn <= 20) as atr_20d
      FROM (
        SELECT MAX(high)::float - MIN(low)::float as dr,
               ROW_NUMBER() OVER (ORDER BY ts::date DESC) as rn
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date < CURRENT_DATE AND ts::date >= CURRENT_DATE-21
          AND EXTRACT(HOUR FROM ts) BETWEEN 9 AND 16
        GROUP BY ts::date
        LIMIT 20
      ) x
    `);
    const atr10 = parseFloat(atrQ.rows[0]?.atr_10d) || null;
    const atr20 = parseFloat(atrQ.rows[0]?.atr_20d) || null;
    let atrRegime = 'NORMAL', atrAdj = 0;
    if (atr10 != null && atr20 != null && atr20 > 0) {
      if (atr10 > atr20 * 1.15)      { atrRegime = 'EXPANDING';   atrAdj =  0.10; }
      else if (atr10 < atr20 * 0.85) { atrRegime = 'COMPRESSING'; atrAdj = -0.10; }
    }

    // NL30 and structural state for day type modifier
    const nlQ = await query(`
      SELECT SUM(daily_score) FILTER (WHERE trade_date > CURRENT_DATE-30 AND trade_date <= CURRENT_DATE) as nl30
      FROM acd_daily_log WHERE daily_score IS NOT NULL
    `);
    const nl30 = parseInt(nlQ.rows[0]?.nl30) || 0;

    const stateQ = await query(
      `SELECT structural_state FROM daily_performance_log ORDER BY trade_date DESC LIMIT 1`);
    const structuralState = stateQ.rows[0]?.structural_state || 'BRACKET';

    // OR volatility flag: today's OR range vs 20-day avg
    let orVolatilityFlag = 'NORMAL';
    if (ibHigh != null && ibLow != null) {
      const todayOrRange = ibHigh - ibLow;
      const avgOrQ = await query(`
        SELECT AVG(or_high - or_low) as avg_or
        FROM acd_daily_log
        WHERE trade_date >= CURRENT_DATE-20 AND trade_date < CURRENT_DATE
          AND or_high IS NOT NULL AND or_low IS NOT NULL
      `);
      const avgOrRange = parseFloat(avgOrQ.rows[0]?.avg_or) || null;
      if (avgOrRange && avgOrRange > 0) {
        if (todayOrRange > avgOrRange * 1.40)      orVolatilityFlag = 'HIGH';
        else if (todayOrRange > avgOrRange * 1.15) orVolatilityFlag = 'ELEVATED';
      }
    }

    // Day type modifier
    const isTrending = ['TRENDING_UP','TRENDING_DOWN'].includes(structuralState);
    const isBracket  = ['BRACKET','BRACKET_TILTING_UP','BRACKET_TILTING_DOWN'].includes(structuralState);
    const nlExtreme  = nl30 > 9 || nl30 < -9;
    let dayModifier = 1.00, modifierReason = 'STANDARD';

    if (isTrending && nlExtreme) {
      dayModifier = 1.20; modifierReason = 'TRENDING';
    } else if (orVolatilityFlag === 'HIGH' || (isBracket && !nlExtreme)) {
      dayModifier = 0.70; modifierReason = 'TIGHT';
    } else if (isBracket && (orVolatilityFlag === 'NORMAL' || orVolatilityFlag === 'ELEVATED')) {
      dayModifier = 0.85; modifierReason = 'BRACKET';
    }

    dayModifier = Math.round((dayModifier + atrAdj) * 100) / 100;

    // No viable target when all levels in the signal direction are < MIN_LEVEL_DISTANCE away
    const noViableTarget = levelDistance == null && entryMidpoint != null;
    let skipReason = null;
    if (noViableTarget) {
      const nearest = skippedLevelDistance != null ? `${skippedLevelDistance} pts` : 'unknown distance';
      skipReason = `Nearest level ${nearest} — insufficient for viable R:R on today's wide OR. No structural target available within viable range. Consider skipping this setup.`;
    }

    // Weighted TP calculation — null when no viable target
    const recommendedPoints = noViableTarget ? null : calcWeightedTarget(
      effLevelDist, eff30, sessions30d, eff90, sessions90d, effAll, sessionsAllTime, dayModifier
    );

    // Stop and R:R
    const stopPrice = isLong ? ibLow : ibHigh;
    const stopDistance = (entryMidpoint != null && stopPrice != null)
      ? Math.round(Math.abs(entryMidpoint - stopPrice) * 100) / 100
      : null;
    const riskReward = (recommendedPoints == null || stopDistance == null || stopDistance === 0) ? null
      : Math.round((recommendedPoints / stopDistance) * 100) / 100;
    const rrLabel = noViableTarget ? 'NO_VIABLE_TARGET'
      : riskReward == null ? 'UNKNOWN'
      : riskReward >= 2.0 ? 'GOOD'
      : riskReward >= 1.5 ? 'FAIR'
      : 'POOR';

    // T1 price
    const t1Price = (entryMidpoint != null && recommendedPoints != null)
      ? Math.round((entryMidpoint + (isLong ? recommendedPoints : -recommendedPoints)) * 4) / 4
      : null;

    // Data quality
    let dataQuality = 'STRONG', dataQualityReason = null;
    if (sessions30d < 10) {
      if (sessions90d >= 10) {
        dataQuality = 'MODERATE';
        dataQualityReason = '30d < 10 sessions — using 90d weights';
      } else {
        dataQuality = 'INSUFFICIENT';
        dataQualityReason = `< 10 sessions in 90d (${sessionsAllTime} all-time) — using level + fallback medians`;
      }
    }

    // Confluence score at detection
    const confluenceScore = setupRow?.confluence_score_at_detection ?? null;

    res.json({
      setupType,
      recommendedPoints,
      t1Price,
      confluenceScore,
      levelDistance: levelDistance != null ? Math.round(levelDistance * 100) / 100 : null,
      levelType,
      levelPrice,
      avgMove30d:     avgMove30d     != null ? Math.round(avgMove30d * 10)     / 10 : null,
      sessions30d,
      avgMove90d:     avgMove90d     != null ? Math.round(avgMove90d * 10)     / 10 : null,
      sessions90d,
      avgMoveAllTime: avgMoveAllTime != null ? Math.round(avgMoveAllTime * 10) / 10 : null,
      sessionsAllTime,
      dayModifier,
      modifierReason,
      atrRegime,
      stopDistance,
      stopPrice,
      riskReward,
      rrLabel,
      dataQuality,
      dataQualityReason,
      entryMidpoint,
      structuralState,
      nl30,
      orVolatilityFlag,
      isCounterTrend,
      fallbackSource: (isCounterTrend && levelType && LEVEL_MAGNITUDES[levelType])
        ? `BACKTEST_${levelType}`
        : `SETUP_MEDIAN_${setupType}`,
      fallbackUsed: levelMagnitudeFallback,
      skipReason,
      skippedLevelDistance,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/setups/best-by-date?startDate=2026-05-01&endDate=2026-05-31
// Returns up to 3 setups per day with stars >= 2, grouped by date.
// Stars derived from historical_win_rate (stored) or computed from resolved outcomes.
router.get('/setups/best-by-date', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });

    const result = await query(`
      WITH setup_win_rates AS (
        -- Compute win rates from resolved active_setups outcomes
        SELECT
          setup_type,
          ROUND(
            COUNT(*) FILTER (WHERE resolution = 'TARGET_HIT')::numeric /
            NULLIF(COUNT(*) FILTER (WHERE resolution IN ('TARGET_HIT', 'STOP_HIT')), 0),
            4
          ) as computed_win_rate
        FROM active_setups
        WHERE resolution IN ('TARGET_HIT', 'STOP_HIT')
        GROUP BY setup_type
      ),
      -- Backtest-measured win rates: T1-first / (T1-first + stop-hit) — min 10 resolved
      backtest_rates AS (
        SELECT
          setup_type,
          ROUND(
            COUNT(*) FILTER (WHERE hit_t1_first)::numeric /
            NULLIF(
              COUNT(*) FILTER (WHERE hit_t1_first OR (hit_stop AND NOT COALESCE(hit_t1_first,false))),
              0
            ), 4
          ) as measured_win_rate
        FROM setup_outcome_backtest
        GROUP BY setup_type
        HAVING COUNT(*) FILTER (WHERE hit_t1_first OR (hit_stop AND NOT COALESCE(hit_t1_first,false))) >= 10
      ),
      -- Replay-derived baseline rates used when no live data exists yet
      -- (replaces hardcoded ACD-methodology guesses with the full-history
      -- setup-detection replay, same source as acd.js's getReplayBaseline)
      acd_baseline AS (
        SELECT setup_type, win_rate::float as baseline_win_rate
        FROM setup_daytype_winrates
        WHERE day_type = 'OVERALL' AND computed_date = (SELECT MAX(computed_date) FROM setup_daytype_winrates)
      ),
      setups_with_stars AS (
        SELECT
          s.trade_date::text as trade_date,
          s.setup_type,
          TO_CHAR(s.fired_at, 'HH24:MI') as fired_time,
          s.fired_at,
          -- Priority: measured backtest rate > stored historical > live resolved > ACD baseline
          COALESCE(bt.measured_win_rate, s.historical_win_rate, w.computed_win_rate, b.baseline_win_rate) as win_rate,
          s.resolution,
          CASE
            WHEN COALESCE(bt.measured_win_rate, s.historical_win_rate, w.computed_win_rate, b.baseline_win_rate) >= 0.58 THEN 3
            WHEN COALESCE(bt.measured_win_rate, s.historical_win_rate, w.computed_win_rate, b.baseline_win_rate) >= 0.48 THEN 2
            WHEN COALESCE(bt.measured_win_rate, s.historical_win_rate, w.computed_win_rate, b.baseline_win_rate) >= 0.38 THEN 1
            ELSE 0
          END as stars
        FROM active_setups s
        LEFT JOIN setup_win_rates w  ON s.setup_type = w.setup_type
        LEFT JOIN backtest_rates  bt ON s.setup_type = bt.setup_type
        LEFT JOIN acd_baseline    b  ON s.setup_type = b.setup_type
        WHERE s.trade_date BETWEEN $1 AND $2
          AND s.resolution IS NOT NULL
          AND s.resolution != 'SESSION_CLOSED'
      )
      SELECT trade_date, setup_type, fired_time, fired_at,
             win_rate::float, resolution, stars
      FROM setups_with_stars
      WHERE stars >= 2
      ORDER BY
        trade_date,
        stars DESC,
        CASE resolution
          WHEN 'TARGET_HIT'   THEN 1
          WHEN 'STOP_HIT'     THEN 2
          WHEN 'TIME_EXPIRED' THEN 3
          WHEN 'EXPIRED'      THEN 3
          WHEN 'INVALIDATED'  THEN 4
          ELSE 5
        END,
        fired_at
    `, [startDate, endDate]);

    // Total setups per day (unfiltered by stars) — used so "+N more" reflects the
    // full active_setups count for the day, not just the stars>=2 subset above.
    const totalCounts = await query(`
      SELECT trade_date::text as trade_date, COUNT(*) as total
      FROM active_setups
      WHERE trade_date BETWEEN $1 AND $2
      GROUP BY trade_date
    `, [startDate, endDate]);
    const totalByDate = {};
    for (const row of totalCounts.rows) totalByDate[row.trade_date] = parseInt(row.total);

    // Group by date, compute confluence, cap at 3
    const rawByDate = {};
    for (const row of result.rows) {
      if (!rawByDate[row.trade_date]) rawByDate[row.trade_date] = [];
      rawByDate[row.trade_date].push(row);
    }

    const byDate = {};
    for (const [date, rows] of Object.entries(rawByDate)) {
      const total = totalByDate[date] ?? rows.length;
      const shown = rows.slice(0, 3);

      // Confluence: all shown setups fired within 5 minutes of each other
      let confluence = false;
      if (shown.length >= 2) {
        const times = shown.map(r => (r.fired_at instanceof Date ? r.fired_at : new Date(r.fired_at)).getTime());
        const span = Math.max(...times) - Math.min(...times);
        confluence = span <= 5 * 60 * 1000;
      }

      byDate[date] = {
        setups: shown.map(r => ({
          type: r.setup_type,
          time: r.fired_time,
          stars: parseInt(r.stars),
          resolution: r.resolution,
          win_rate: r.win_rate,
        })),
        confluence,
        moreCount: Math.max(0, total - shown.length),
      };
    }

    res.json(byDate);
  } catch (err) {
    console.error('[setups/best-by-date] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/setups/for-date?date=2026-05-26
// Returns all active_setups for a specific date with entry/stop/t1 levels and star ratings.
// Used by the IntradayChartSection in DayModal.
router.get('/setups/for-date', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    const result = await query(`
      WITH backtest_rates AS (
        SELECT
          setup_type,
          COUNT(*) FILTER (WHERE hit_t1_first OR (hit_stop AND NOT COALESCE(hit_t1_first,false))) as n,
          ROUND(
            COUNT(*) FILTER (WHERE hit_t1_first)::numeric /
            NULLIF(
              COUNT(*) FILTER (WHERE hit_t1_first OR (hit_stop AND NOT COALESCE(hit_t1_first,false))),
              0
            ), 4
          ) as measured_win_rate
        FROM setup_outcome_backtest
        GROUP BY setup_type
        HAVING COUNT(*) FILTER (WHERE hit_t1_first OR (hit_stop AND NOT COALESCE(hit_t1_first,false))) >= 10
      ),
      -- Replay-derived baseline rates used when no live data exists yet
      -- (replaces hardcoded ACD-methodology guesses with the full-history
      -- setup-detection replay, same source as acd.js's getReplayBaseline)
      acd_baseline AS (
        SELECT setup_type, win_rate::float as baseline_win_rate
        FROM setup_daytype_winrates
        WHERE day_type = 'OVERALL' AND computed_date = (SELECT MAX(computed_date) FROM setup_daytype_winrates)
      )
      SELECT
        s.id,
        s.setup_type,
        TO_CHAR(s.fired_at, 'HH24:MI') as fired_time,
        s.fired_at,
        s.entry_zone_low::float,
        s.entry_zone_high::float,
        s.stop_level::float,
        s.t1_level::float,
        s.t1_label,
        s.price_at_detection::float,
        s.resolution,
        s.status,
        COALESCE(bt.measured_win_rate, s.historical_win_rate, b.baseline_win_rate)::float as win_rate,
        COALESCE(bt.n, 0)::int as sample_n,
        CASE
          WHEN COALESCE(bt.measured_win_rate, s.historical_win_rate, b.baseline_win_rate) >= 0.58 THEN 3
          WHEN COALESCE(bt.measured_win_rate, s.historical_win_rate, b.baseline_win_rate) >= 0.48 THEN 2
          WHEN COALESCE(bt.measured_win_rate, s.historical_win_rate, b.baseline_win_rate) >= 0.38 THEN 1
          ELSE 0
        END as stars
      FROM active_setups s
      LEFT JOIN backtest_rates bt ON s.setup_type = bt.setup_type
      LEFT JOIN acd_baseline   b  ON s.setup_type = b.setup_type
      WHERE s.trade_date = $1
      ORDER BY s.fired_at
    `, [date]);

    res.json(result.rows.map(r => ({
      id: r.id,
      setup_type: r.setup_type,
      fired_time: r.fired_time,
      entry_zone_low: r.entry_zone_low,
      entry_zone_high: r.entry_zone_high,
      stop_level: r.stop_level,
      t1_level: r.t1_level,
      t1_label: r.t1_label,
      price_at_detection: r.price_at_detection,
      resolution: r.resolution,
      status: r.status,
      win_rate: r.win_rate,
      sample_n: r.sample_n,
      stars: parseInt(r.stars),
    })));
  } catch (err) {
    console.error('[setups/for-date] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== BACKTEST ROUTES ====================

// POST /api/setups/backtest/run — (re)run the outcome backtest for all setups
router.post('/setups/backtest/run', async (req, res) => {
  try {
    const { setupIds = null } = req.body || {};
    const result = await runSetupBacktest({ query }, { verbose: false, setupIds });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[setups/backtest/run]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/setups/backtest/edge?minSamples=1
// Returns validated edge combinations from the backtest table.
router.get('/setups/backtest/edge', async (req, res) => {
  try {
    const minSamples = parseInt(req.query.minSamples ?? '1', 10);
    const rows = await getBacktestEdge({ query }, { minSamples });
    res.json(rows);
  } catch (err) {
    console.error('[setups/backtest/edge]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/setups/backtest — summary statistics per setup type
router.get('/setups/backtest', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        setup_type,
        COUNT(*)                                                          as total,
        COUNT(*) FILTER (WHERE hit_t1_first)                             as wins,
        COUNT(*) FILTER (WHERE hit_stop AND NOT COALESCE(hit_t1_first,false)) as losses,
        COUNT(*) FILTER (WHERE NOT COALESCE(hit_t1,false) AND NOT COALESCE(hit_stop,false)) as no_exit,
        ROUND(
          COUNT(*) FILTER (WHERE hit_t1_first)::numeric /
          NULLIF(COUNT(*) FILTER (WHERE hit_t1_first OR (hit_stop AND NOT COALESCE(hit_t1_first,false))), 0) * 100, 1
        )                                                                as resolved_win_rate_pct,
        ROUND(AVG(mfe_points), 1)                                        as avg_mfe,
        ROUND(AVG(mae_points), 1)                                        as avg_mae,
        ROUND(AVG(computed_pnl_1contract), 2)                            as avg_pnl
      FROM setup_outcome_backtest
      GROUP BY setup_type
      ORDER BY total DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[setups/backtest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resolve a live setup_type string to its static definition (criteria/window/family) —
// checks OTHER_SETUP_DEFINITIONS first (exact match: conditional variants, day-type-
// conditional, momentum patterns — these don't fit the generic {BASE}_FADE_{DIR} shape),
// then falls back to parsing the standard level-fade naming convention. Returns null for
// anything genuinely undocumented — the endpoint still returns those rows (setup_type +
// live numbers, no criteria text) rather than silently hiding them, matching the
// "discoverable" requirement of this codebase's no-dead-ends convention.
function resolveDefinition(setupType) {
  if (OTHER_SETUP_DEFINITIONS[setupType]) {
    const def = OTHER_SETUP_DEFINITIONS[setupType];
    const rule = WINDOW_RULES[def.rule];
    return { ...def, ruleLabel: rule.label, windowDescription: rule.windowDescription, formationGate: def.formationGate ?? rule.formationGate ?? null };
  }
  const m = setupType.match(/^(.+)_FADE_(LONG|SHORT)$/);
  if (m) {
    const [, base, dir] = m;
    const def = getLevelFadeDefinition(base);
    if (def) return { ...def, direction: dir, globexCapable: GLOBEX_CAPABLE_TYPES.has(setupType) };
  }
  return null;
}

// "Misc" column (renamed 2026-07-28 from the STACK_VOL_BREAK_LIVE-only "Applied volZ" per
// direct user request: list EVERY live mechanism that actually controls each setup_type's
// firing, in-trade sizing, and exit -- not just volZ). Every scope check below is derived
// from reading the real gating code in server/routes/acd.js, not guessed:
// - Level-fade family test mirrors getDeltaConfirmationCategory()'s own FADE regex.
// - sizeMultiplier IIFE + the post-loss "Death Sequence" 0.5x cap only ever apply to
//   whichever setup wins selection into the `active` variable -- and the `candidates`
//   array that feeds `active` contains exactly two members: levelScalpSetup (the whole
//   level-fade family) and ibSetup (IB_BULLISH/IB_BEARISH). Every other live setup_type
//   (TRT, C_STANDALONE, OPEN_DRIVE, BRACKET_BREAKOUT, VALUE_AREA_RESPONSIVE, VWAP_MAGNET,
//   STOP_SWEEP, etc.) is inserted via the separate `shadowCandidates` path, which never
//   touches sizeMultiplier or hasLossToday at all -- confirmed by reading both insert
//   blocks directly, not assumed from SHADOW/ACTIVE status.
// - Confluence pair-bonus + S2/trend-counter-fade suppression are computed inside the
//   level-fade near-touch loop (keepLevelsAll) -- level-fade family only.
// - Bar-6 checkpoint/EXIT NOW and touch-quality both run inside resolveSetupsByPrice()'s
//   shared bar-by-bar walk -- everyone EXCEPT ABSORPTION_LONG/COIL_SURGE*, which resolve
//   via a separate current-price-snapshot branch that never reaches that walk.
const TRAIL_TYPES = new Set(Object.keys(CONDITIONAL_VARIANTS).filter(k => CONDITIONAL_VARIANTS[k].trailSignalName));
const GAP_CONDITIONAL_TYPES = new Set(Object.keys(CONDITIONAL_VARIANTS).filter(k => !CONDITIONAL_VARIANTS[k].trailSignalName));
const IB_MANAGED_TYPES = new Set(['IB_BULLISH', 'IB_BEARISH']);
const CUSTOM_RESOLVER_TYPES = (t) => t === 'ABSORPTION_LONG' || t.startsWith('COIL_SURGE');
const LEVEL_FADE_RE = /_FADE_(LONG|SHORT)(_TRAIL)?(_GAP_(UP|DOWN))?(_OVERNIGHT)?$/;

function computeMiscTags(setupType, { touchQualityTypes, optNotes }) {
  // GLOBEX_VWAP_MAGNET_LONG/SHORT and GLOBEX_VWAP_FADE_LONG/SHORT (both added 2026-07-28)
  // fire through detectGlobexSetup()'s candidates loop, NOT the RTH keepLevelsAll path --
  // same minimal pair-bonus-only sizeMultiplier, same fixed single-target exit as the
  // _OVERNIGHT fades, regardless of what LEVEL_FADE_RE would otherwise match. Checked and
  // excluded from isLevelFade FIRST, before the regex test, because GLOBEX_VWAP_FADE_LONG/
  // SHORT's name shape (ends in _FADE_LONG/SHORT) WOULD otherwise false-positive match
  // LEVEL_FADE_RE and get incorrectly tagged with the RTH-only sizeMultiplier stack.
  const isGlobexVwapMagnet = /^GLOBEX_VWAP_MAGNET_(LONG|SHORT)$/.test(setupType);
  const isGlobexVwapFade = /^GLOBEX_VWAP_FADE_(LONG|SHORT)$/.test(setupType);
  const isLevelFade = !isGlobexVwapFade && LEVEL_FADE_RE.test(setupType);
  const isOvernightFade = isLevelFade && setupType.endsWith('_OVERNIGHT');
  const isTrail = TRAIL_TYPES.has(setupType);
  const isStackVol = /^STACK_VOL_BREAK_LIVE_(LONG|SHORT)$/.test(setupType);
  const isIbManaged = IB_MANAGED_TYPES.has(setupType);
  const deltaCat = getDeltaConfirmationCategory(setupType);
  const tags = [];

  // Firing
  if (GAP_CONDITIONAL_TYPES.has(setupType)) tags.push(`Fires only when: ${CONDITIONAL_VARIANTS[setupType].condition}`);
  if (isStackVol) {
    const t = STACK_VOL_THRESHOLDS;
    tags.push(`Fires on RTH volZ≥${t.RTH.volZCutoff}/OSR≥${t.RTH.osrCutoff}/cluster≥${t.RTH.minClusterSize}, Globex volZ≥${t.GLOBEX.volZCutoff}/OSR≥${t.GLOBEX.osrCutoff}/cluster≥${t.GLOBEX.minClusterSize}`);
  }
  if (isGlobexVwapMagnet) tags.push('Fires on |price − running 24hr VWAP| ≥ 1.5σ (rolling 30-session std)');
  if (isGlobexVwapFade) tags.push('Fires on ordinary touch (within 15pt) of running 24hr VWAP, direction from current price side');
  if (isIbManaged) tags.push('Gated/suppressed per day-type (DAY_TYPE_ALPHA), not blended EV');
  if (isOvernightFade) tags.push('Globex-only window, wider stop/target than the RTH sibling (Mon 60/30pt, else 90/40pt)');

  // Sizing (in-trade) — the full ~20-factor sizeMultiplier IIFE is a property set only
  // when levelScalpSetup itself is constructed (server/routes/acd.js ~line 6058) --
  // ibSetup's object literal has no such property (confirmed by reading its construction
  // directly, ~line 4258), so IB only ever gets the shared post-selection Death-Sequence
  // ceiling (active.sizeMultiplier = hasLossToday ? min(existing, 0.5) : existing ?? 1.0,
  // the ONLY `.sizeMultiplier =` assignment in the file) starting from a plain 1.0, not
  // the full factor stack. detectGlobexSetup() is a third, separate, simpler function
  // with its own "minimal Globex sizeMultiplier" (just the pair-bonus factor) -- do not
  // conflate any of these three.
  if (isOvernightFade || isGlobexVwapMagnet || isGlobexVwapFade) {
    tags.push('Minimal Globex sizeMultiplier: confluence pair-bonus only (1.15x if paired, else 1.0x)');
  } else if (isLevelFade) {
    tags.push('sizeMultiplier factor stack (confluence, day-type significance, streaks, VWAP-extension, OR-bias, regime)');
    tags.push('Death-Sequence 0.5x size cap after a real loss today');
    tags.push('Confluence pair-bonus + S2/trend-counter-fade suppression');
  } else if (isIbManaged) {
    tags.push('Death-Sequence 0.5x size cap after a real loss today (no other sizing factors)');
  }

  // Exit
  if (isTrail) tags.push('Exit: breakeven-then-trail ratchet, not a fixed 2nd target');
  else if (isStackVol) tags.push('Exit: bank-vs-extend (10-25 bar grind extends target, else banks fixed T1)');
  else tags.push('Exit: fixed calibrated stop/target');
  let optN = null;
  try { optN = typeof optNotes === 'string' ? JSON.parse(optNotes) : optNotes; } catch (_) {}
  if (optN?.method === 'corrected-resim') tags.push('Target: corrected bar-walk calibration (widened past raw EV-sweep)');

  // Informational badges (never gate/size/exit, purely displayed)
  if (!CUSTOM_RESOLVER_TYPES(setupType)) tags.push('Bar-6 checkpoint + EXIT NOW badge');
  if (deltaCat) tags.push(`Cumulative-delta-confirmation badge (${deltaCat})`);
  if (touchQualityTypes.has(setupType)) tags.push('Touch-quality (order-flow) badge');

  return tags;
}

// GET /api/setups/reference — the setup definitions page: what each setup IS (criteria,
// detection window, family) joined against what it's ACTUALLY DOING right now (live
// N/WR/EV/status from SETUP_STATUS, real_n/rigor from the 2026-07-20 origin_status and
// rigor-diagnostics fixes). Criteria/window text is static (server/config/
// setupDefinitions.js); every number is live-queried, never hand-typed here.
router.get('/setups/reference', async (req, res) => {
  try {
    const [statusQ, optQ, touchQ, touchQualityQ] = await Promise.all([
      query(`
        SELECT DISTINCT ON (signal_name) signal_name, sample_size, win_rate::float,
          ev_per_trade::float, recommendation, notes, run_date
        FROM performance_audit WHERE signal_type='SETUP_STATUS'
        ORDER BY signal_name, run_date DESC
      `),
      query(`
        SELECT DISTINCT ON (signal_name) signal_name, optimal_stop::float, optimal_target::float, notes
        FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
        ORDER BY signal_name, run_date DESC
      `),
      // Key-Levels-style touch/MFE/MAE/P&L metrics, added 2026-07-28 per direct user
      // request ("keep the metrics you have but also add these columns from key levels
      // touches, mfe p50/p75, mae p50, average pnl, how much profit was left on table").
      // Computed twice per setup_type -- REAL (origin_status IN ACTIVE,SHADOW, genuinely
      // live-detected) and ALL (blended, includes BACKFILL) -- so the page can prefer the
      // real numbers when there's enough real N and fall back to blended with a visible
      // marker otherwise, same honesty convention as the Setup Log origin-breakdown fix
      // earlier this session (don't let a backfill-inflated count masquerade as real
      // experience). left_on_table is in POINTS (mfe_p50 minus realized favorable move in
      // points, avg_pnl converted via INSTRUMENTS.MNQ.dollarsPerPoint) -- same unit and
      // same "MFE minus what was actually captured" definition as the Key Levels table's
      // own "Left on table" column (BacktestView.jsx), not a new metric invented here.
      query(`
        SELECT setup_type,
          count(*)::int as touches_total,
          count(*) FILTER (WHERE trade_date >= date_trunc('week', CURRENT_DATE)::date)::int as touches_this_week,
          MAX(fired_at) as last_touch,
          count(*) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW'))::int as touches_real,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_mfe_p50,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_mfe_p75,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY mae_points) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_mae_p50,
          AVG(actual_pnl) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_avg_pnl,
          SUM(actual_pnl) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_total_pnl,
          count(*) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED') AND actual_pnl IS NOT NULL)::int as real_resolved_n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_mfe_p50,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_mfe_p75,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY mae_points) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_mae_p50,
          AVG(actual_pnl) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_avg_pnl,
          count(*) FILTER (WHERE status IN ('RESOLVED','EXPIRED') AND actual_pnl IS NOT NULL)::int as all_resolved_n
        FROM active_setups
        GROUP BY setup_type
      `),
      // Which setup_types currently have a live TOUCH_QUALITY calibration -- mirrors
      // getTouchQualityCalib()'s own query exactly (server/routes/acd.js) so the "Misc"
      // column's touch-quality tag reflects the same live gate the resolution loop
      // actually checks, not a guess.
      query(`
        SELECT DISTINCT signal_name FROM performance_audit
        WHERE signal_type='TOUCH_QUALITY' AND run_date=(SELECT MAX(run_date) FROM performance_audit WHERE signal_type='TOUCH_QUALITY')
      `),
    ]);
    const touchQualityTypes = new Set(touchQualityQ.rows.map(r => r.signal_name));
    const optByName = new Map(optQ.rows.map(r => [r.signal_name, r]));
    const touchByName = new Map(touchQ.rows.map(r => [r.setup_type, r]));
    const statusByName = new Map(statusQ.rows.map(r => [r.signal_name, r]));
    const DPP = INSTRUMENTS.MNQ.dollarsPerPoint;

    // Driven by the UNION of (has a SETUP_STATUS row) ∪ (has any active_setups touch,
    // even zero resolved) ∪ (known live-wired informational setup_types that haven't
    // fired even once yet, e.g. STACK_VOL_BREAK_LIVE_LONG/SHORT as of 2026-07-28) --
    // NOT just statusQ.rows alone. Matches CLAUDE.md's own item-11 lesson ("a level with
    // zero real touches ever is not automatically safe to omit -- an absent row is not
    // the same as a THIN_N row"), found live here: STACK_VOL_BREAK_LIVE_LONG/SHORT had
    // zero active_setups rows and no SETUP_STATUS row, so the old statusQ-only driver
    // silently omitted the exact setup_types this page's new "Applied volZ" column was
    // built to show.
    const allSetupTypes = new Set([
      ...statusQ.rows.map(r => r.signal_name),
      ...touchQ.rows.map(r => r.setup_type),
      'STACK_VOL_BREAK_LIVE_LONG', 'STACK_VOL_BREAK_LIVE_SHORT',
    ]);

    const results = [...allSetupTypes].map(setupType => {
      const row = statusByName.get(setupType) ?? {};
      let notes = null;
      try { notes = typeof row.notes === 'string' ? JSON.parse(row.notes) : row.notes; } catch (_) {}
      const opt = optByName.get(setupType);
      const def = resolveDefinition(setupType);
      const t = touchByName.get(setupType);
      // Prefer REAL (genuinely live-detected) aggregates once there's enough real N to
      // mean anything; below that, fall back to blended (incl. backfill) and flag it —
      // same REAL_N_FLOOR precedent as backtest_setup_status.mjs's PROMOTE_MIN_REAL_N,
      // reused here rather than a fresh arbitrary number.
      const REAL_N_FLOOR = 5;
      const useReal = (t?.real_resolved_n ?? 0) >= REAL_N_FLOOR;
      const mfeP50 = t ? (useReal ? t.real_mfe_p50 : t.all_mfe_p50) : null;
      const mfeP75 = t ? (useReal ? t.real_mfe_p75 : t.all_mfe_p75) : null;
      const maeP50 = t ? (useReal ? t.real_mae_p50 : t.all_mae_p50) : null;
      const avgPnl = t ? (useReal ? t.real_avg_pnl : t.all_avg_pnl) : null;
      const avgPnlPts = avgPnl != null ? Number(avgPnl) / DPP : null;
      const leftOnTablePts = (mfeP50 != null && avgPnlPts != null) ? Number(mfeP50) - avgPnlPts : null;
      const misc = computeMiscTags(setupType, { touchQualityTypes, optNotes: opt?.notes });
      return {
        setupType,
        displayName: def?.displayName || setupType.replace(/_/g, ' '),
        group: getSetupGroup(setupType),
        family: def?.ruleLabel || null,
        criteria: def?.criteria || null,
        windowDescription: def?.windowDescription || null,
        formationGate: def?.formationGate ?? null,
        globexCapable: def?.globexCapable ?? GLOBEX_CAPABLE_TYPES.has(setupType),
        documented: def != null,
        n: row.sample_size ?? null,
        realN: notes?.all_time_real_n ?? t?.touches_real ?? null,
        wr: row.win_rate ?? null,
        ev: row.ev_per_trade ?? null,
        recommendation: row.recommendation ?? (t ? 'NOT_YET_CALIBRATED' : null),
        stop: opt?.optimal_stop ?? null,
        target: opt?.optimal_target ?? null,
        rigorTrend: notes?.rigor?.trend ?? (notes?.rigor?.three_way_stable === true ? 'STABLE' : null),
        lastRunDate: row.run_date ?? null,
        // Key-Levels-style touch/MFE/MAE/P&L metrics (2026-07-28) — see the touchQ query
        // comment above for the real-vs-blended fallback rule and unit conventions.
        touchesTotal: t?.touches_total ?? 0,
        touchesThisWeek: t?.touches_this_week ?? 0,
        lastTouch: t?.last_touch ?? null,
        usingBlendedStats: t ? !useReal : null,
        mfeP50: mfeP50 != null ? +Number(mfeP50).toFixed(1) : null,
        mfeP75: mfeP75 != null ? +Number(mfeP75).toFixed(1) : null,
        maeP50: maeP50 != null ? +Number(maeP50).toFixed(1) : null,
        avgPnl: avgPnl != null ? +Number(avgPnl).toFixed(2) : null,
        leftOnTablePts: leftOnTablePts != null ? +leftOnTablePts.toFixed(1) : null,
        totalPnlRealAllTime: t?.real_total_pnl != null ? +Number(t.real_total_pnl).toFixed(2) : null,
        misc,
      };
    });

    results.sort((a, b) => (a.documented === b.documented ? 0 : a.documented ? -1 : 1) || (b.n || 0) - (a.n || 0));
    res.json({ total: results.length, undocumented: results.filter(r => !r.documented).length, setups: results });
  } catch (err) {
    console.error('[setups/reference]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/setups/reference/:setupType/detail — per-setup_type touch detail, ported from
// the Key Levels table's click-through drill-down (BacktestView.jsx's KlDetailPanel/
// KlMfeBar/KlHourBreakdown) so Setup Reference gets the same "click a row -> see the MFE/
// MAE distribution + touches-by-hour + per-day touch list -> click a date -> see the
// chart" flow. Added 2026-07-28 per direct user request ("move that whole functionality
// over to setup references"). Same real-vs-blended preference (real N>=5 floor) as the
// main /setups/reference endpoint above -- reused, not reinvented.
router.get('/setups/reference/:setupType/detail', async (req, res) => {
  try {
    const { setupType } = req.params;
    const REAL_N_FLOOR = 5;

    // By-regime breakdown (OPEN_DECISION build_regime_breakdown_setup_reference_panel,
    // user request 2026-08-02: "if I wanted to track the setups against all different
    // regimes, am I able to see that somewhere"). Real (ACTIVE/SHADOW) only, same reasoning
    // as byDay/byHour above -- a per-bucket breakdown has no meaningful blended fallback.
    // Deliberately an exploratory research view (thin data honestly labeled, not hidden),
    // NOT a live badge -- matches the user's own standing feedback against more passive
    // live badges. UNION ALL across all 7 REGIME_LOOKBACKS (10/20/30/45/60/90/180) so one
    // query returns every lookback's regime_label_Nd/actual_pnl in one round trip.
    const REGIME_LOOKBACKS = [10, 20, 30, 45, 60, 90, 180];
    const byRegimeSql = REGIME_LOOKBACKS.map(L => `
        SELECT ${L} as lookback, regime_label_${L}d as label, actual_pnl
        FROM active_setups
        WHERE setup_type = $1 AND origin_status IN ('ACTIVE','SHADOW')
          AND resolution IN ('TARGET_HIT','STOP_HIT') AND actual_pnl IS NOT NULL
          AND regime_label_${L}d IS NOT NULL
      `).join(' UNION ALL ') + ' ORDER BY lookback, label';

    const [distQ, byDayQ, byHourQ, byRegimeQ] = await Promise.all([
      // Full percentile bundle, real vs blended computed in parallel so we can pick
      // whichever has enough N without a second round-trip.
      query(`
        SELECT
          count(*) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED') AND actual_pnl IS NOT NULL)::int as real_resolved_n,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_mfe_p25,
          percentile_cont(0.5)  WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_mfe_p50,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_mfe_p75,
          percentile_cont(0.9)  WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_mfe_p90,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY mae_points) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_mae_p25,
          percentile_cont(0.5)  WITHIN GROUP (ORDER BY mae_points) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_mae_p50,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY mae_points) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_mae_p75,
          AVG(actual_pnl) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND status IN ('RESOLVED','EXPIRED')) as real_avg_pnl,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY bars_to_resolution) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution='TARGET_HIT') as real_bars_p25,
          percentile_cont(0.5)  WITHIN GROUP (ORDER BY bars_to_resolution) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution='TARGET_HIT') as real_bars_p50,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY bars_to_resolution) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution='TARGET_HIT') as real_bars_p75,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_mfe_p25,
          percentile_cont(0.5)  WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_mfe_p50,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_mfe_p75,
          percentile_cont(0.9)  WITHIN GROUP (ORDER BY mfe_points) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_mfe_p90,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY mae_points) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_mae_p25,
          percentile_cont(0.5)  WITHIN GROUP (ORDER BY mae_points) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_mae_p50,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY mae_points) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_mae_p75,
          AVG(actual_pnl) FILTER (WHERE status IN ('RESOLVED','EXPIRED')) as all_avg_pnl,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY bars_to_resolution) FILTER (WHERE resolution='TARGET_HIT') as all_bars_p25,
          percentile_cont(0.5)  WITHIN GROUP (ORDER BY bars_to_resolution) FILTER (WHERE resolution='TARGET_HIT') as all_bars_p50,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY bars_to_resolution) FILTER (WHERE resolution='TARGET_HIT') as all_bars_p75
        FROM active_setups WHERE setup_type = $1
      `, [setupType]),
      // Per-day touch list -- date/T(ouches)/R(espects=TARGET_HIT count)/entry price that
      // day -- same shape as the Key Levels detail panel's `details` array (date/touches/
      // respects/levelPrice), sourced from real (ACTIVE/SHADOW) rows only (a per-day list
      // is exactly the kind of thing that gets misleading fast if backfill rows silently
      // inflate it -- unlike the aggregate stats above, there's no meaningful blended
      // fallback for a literal day-by-day list, so real-only here, no fallback).
      query(`
        SELECT trade_date::text as date,
          count(*)::int as touches,
          count(*) FILTER (WHERE resolution='TARGET_HIT')::int as respects,
          AVG(price_at_detection)::float as level_price
        FROM active_setups
        WHERE setup_type = $1 AND origin_status IN ('ACTIVE','SHADOW')
        GROUP BY trade_date
        ORDER BY trade_date DESC
      `, [setupType]),
      // Touches by hour (ET wall-clock hour of fired_at) -- real-only, same reasoning as above.
      query(`
        SELECT EXTRACT(HOUR FROM fired_at)::int as hour,
          count(*)::int as touches,
          count(*) FILTER (WHERE resolution='TARGET_HIT')::int as respects,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY mfe_points) as mfe_p50
        FROM active_setups
        WHERE setup_type = $1 AND origin_status IN ('ACTIVE','SHADOW')
        GROUP BY EXTRACT(HOUR FROM fired_at)
        ORDER BY hour
      `, [setupType]),
      query(byRegimeSql, [setupType]),
    ]);

    const d = distQ.rows[0] || {};
    const useReal = (d.real_resolved_n ?? 0) >= REAL_N_FLOOR;
    const pick = (realKey, allKey) => {
      const v = useReal ? d[realKey] : d[allKey];
      return v != null ? +Number(v).toFixed(1) : null;
    };
    const mfe = { p25: pick('real_mfe_p25', 'all_mfe_p25'), p50: pick('real_mfe_p50', 'all_mfe_p50'), p75: pick('real_mfe_p75', 'all_mfe_p75'), p90: pick('real_mfe_p90', 'all_mfe_p90') };
    const mae = { p25: pick('real_mae_p25', 'all_mae_p25'), p50: pick('real_mae_p50', 'all_mae_p50'), p75: pick('real_mae_p75', 'all_mae_p75') };
    const timeToPeak = { p25: pick('real_bars_p25', 'all_bars_p25'), p50: pick('real_bars_p50', 'all_bars_p50'), p75: pick('real_bars_p75', 'all_bars_p75') };

    // Group the raw (lookback, label, actual_pnl) rows into n/avg_pnl/wr_pct per bucket --
    // done in JS rather than SQL GROUP BY since actual_pnl needs a real WR (>0 count), not
    // just AVG, and this keeps the query itself simple/auditable.
    const byRegimeMap = new Map();
    for (const r of byRegimeQ.rows) {
      const key = `${r.lookback}|${r.label}`;
      if (!byRegimeMap.has(key)) byRegimeMap.set(key, { lookback: r.lookback, label: r.label, n: 0, wins: 0, pnlSum: 0 });
      const b = byRegimeMap.get(key);
      b.n++;
      if (Number(r.actual_pnl) > 0) b.wins++;
      b.pnlSum += Number(r.actual_pnl);
    }
    const byRegime = [...byRegimeMap.values()]
      .map(b => ({
        lookback: b.lookback, label: b.label, n: b.n,
        wrPct: Math.round((b.wins / b.n) * 100),
        avgPnl: +(b.pnlSum / b.n).toFixed(2),
      }))
      .sort((a, b) => a.lookback - b.lookback || a.label.localeCompare(b.label));
    const avgPnl = useReal ? d.real_avg_pnl : d.all_avg_pnl;

    res.json({
      setupType,
      usingBlendedStats: !useReal,
      mfe, mae, timeToPeak,
      avgPnl: avgPnl != null ? +Number(avgPnl).toFixed(2) : null,
      byHour: byHourQ.rows.map(r => ({
        hour: r.hour, label: `${r.hour}:00`, touches: r.touches,
        respectRate: r.touches > 0 ? Math.round((r.respects / r.touches) * 100) : null,
        mfe_p50: r.mfe_p50 != null ? +Number(r.mfe_p50).toFixed(1) : null,
      })),
      details: byDayQ.rows.map(r => ({
        date: r.date, touches: r.touches, respects: r.respects,
        levelPrice: r.level_price != null ? Math.round(r.level_price) : null,
      })),
      byRegime,
    });
  } catch (err) {
    console.error('[setups/reference/detail]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/setups/performance-summary — dedicated page (quick-check.html link, per direct
// user request 2026-08-29: "a table... how each setup is doing in ev and a line chart...
// net day over day performance"). Real (origin_status IN ACTIVE,SHADOW) trades only, per
// this codebase's own real-vs-blended distinction -- the ~80%-synthetic BACKFILL population
// is excluded entirely, not just de-emphasized. Two pieces:
//  1. `setups`: one row per setup_type with real N/WR/EV, read from the LATEST SETUP_STATUS
//     row's notes (DISTINCT ON pattern, matching /setups/reference above) -- never
//     hand-computed here, per the "never hand-type a WR/N/$ literal" hard rule AND the
//     "single source of truth" rule (backtest_setup_status.mjs already computes this weekly).
//  2. `dailySeries`: real day-by-day SUM(actual_pnl) per (trade_date, setup_type,
//     origin_status), for the frontend to build cumulative curves from -- computed fresh
//     here since SETUP_STATUS doesn't persist a daily breakdown, only summary stats.
//     origin_status is included per row (not pre-summed) so the frontend can offer a
//     Live/All toggle -- FIXED 2026-08-29: the first version of this endpoint pooled
//     ACTIVE+SHADOW into one number with no way to separate them, which silently buried
//     the real "live" P&L (ACTIVE only, +$2,397.61) inside a much larger combined number
//     dominated by SHADOW background-tracking (-$6,016.47) -- caught live when the user
//     said "live still shows the original pnl" and it didn't match this page's default view.
router.get('/setups/performance-summary', async (req, res) => {
  try {
    // FIXED 2026-08-30 (DeepSeek code review, OPEN_DECISION
    // setups_performance_summary_three_disagreeing_populations): the chart (dailyQ) and table
    // (perStatusQ) queries below used two DIFFERENT ad hoc filters, and NEITHER matched this
    // codebase's own canonical REAL_TRADE_FILTER (scripts/backtest_setup_status.mjs) -- the
    // chart didn't restrict `resolution` at all (silently included MTM/RECOVERY_MTM rows), the
    // table restricted to STOP_HIT/TARGET_HIT only (silently EXCLUDED real TIME_EXPIRED
    // resolutions that got a genuine mark-to-market close, and never checked resolution_method
    // or ib_window_stale_basis at all). Result: 3 disagreeing ACTIVE P&L numbers on one page
    // ($2,397.61 chart / $2,112.11 table / $1,422.11 canonical). Both queries now use the exact
    // same population as every other real-N/real-EV computation in this codebase.
    const [statusQ, dailyQ] = await Promise.all([
      query(`
        SELECT DISTINCT ON (signal_name) signal_name, notes
        FROM performance_audit WHERE signal_type='SETUP_STATUS'
        ORDER BY signal_name, run_date DESC
      `),
      query(`
        SELECT trade_date::text as trade_date, setup_type, origin_status,
               SUM(actual_pnl)::float as pnl, COUNT(*)::int as n
        FROM active_setups
        WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
          AND actual_pnl IS NOT NULL AND ${REAL_TRADE_FILTER}
        GROUP BY trade_date, setup_type, origin_status
        ORDER BY trade_date ASC
      `),
    ]);

    // Live-computed N/WR/EV per (setup_type, origin_status) -- NOT read from SETUP_STATUS's
    // stored notes, because that "real_n"/"real_ev" already means ACTIVE+SHADOW combined
    // (excludes only synthetic BACKFILL), the same pooling that buried the real live number
    // in the chart above. Computed separately for 'ACTIVE' and 'ACTIVE,SHADOW' so the
    // frontend Live/All toggle controls the table the same way it controls the chart.
    const perStatusQ = await query(`
      SELECT setup_type, origin_status,
             COUNT(*)::int as n,
             (100.0 * COUNT(*) FILTER (WHERE resolution='TARGET_HIT') / NULLIF(COUNT(*),0))::float as wr,
             AVG(actual_pnl)::float as ev,
             SUM(actual_pnl)::float as total_pnl
      FROM active_setups
      WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
        AND actual_pnl IS NOT NULL AND ${REAL_TRADE_FILTER}
      GROUP BY setup_type, origin_status
    `);
    const rigorByType = new Map();
    for (const row of statusQ.rows) {
      let n; try { n = JSON.parse(row.notes); } catch (_) { continue; }
      rigorByType.set(row.signal_name, {
        rigor_trend: n?.rigor?.trend ?? null,
        rigor_stable: n?.rigor?.three_way_stable ?? null,
        top5_day_pct: n?.rigor?.top5_day_pct ?? null,
      });
    }
    const byType = new Map(); // setup_type -> { active: {n,wr,ev,total_pnl}, all: {...} }
    for (const row of perStatusQ.rows) {
      const cur = byType.get(row.setup_type) || { active: { n: 0, ev: 0, total_pnl: 0, wins: 0 }, all: { n: 0, ev: 0, total_pnl: 0, wins: 0 } };
      const wins = Math.round((row.wr ?? 0) / 100 * row.n);
      cur.all.n += row.n; cur.all.total_pnl += row.total_pnl; cur.all.wins += wins;
      if (row.origin_status === 'ACTIVE') { cur.active.n += row.n; cur.active.total_pnl += row.total_pnl; cur.active.wins += wins; }
      byType.set(row.setup_type, cur);
    }
    const setups = [];
    for (const [setupType, agg] of byType.entries()) {
      if (agg.all.n < 1) continue;
      const rigor = rigorByType.get(setupType) || {};
      setups.push({
        setup_type: setupType,
        active_n: agg.active.n, active_wr: agg.active.n ? +(100 * agg.active.wins / agg.active.n).toFixed(1) : null,
        active_ev: agg.active.n ? +(agg.active.total_pnl / agg.active.n).toFixed(2) : null, active_total_pnl: +agg.active.total_pnl.toFixed(2),
        all_n: agg.all.n, all_wr: agg.all.n ? +(100 * agg.all.wins / agg.all.n).toFixed(1) : null,
        all_ev: agg.all.n ? +(agg.all.total_pnl / agg.all.n).toFixed(2) : null, all_total_pnl: +agg.all.total_pnl.toFixed(2),
        ...rigor,
      });
    }
    setups.sort((a, b) => (b.all_ev ?? -Infinity) - (a.all_ev ?? -Infinity));

    res.json({ setups, dailySeries: dailyQ.rows });
  } catch (err) {
    console.error('[setups/performance-summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/setups/flush-exit-signals-summary — the ONE source of truth both monitoring
// surfaces from OPEN_DECISION wire_flush_post_entry_exit_signals_globex's part-3 monitoring
// requirement read from: quick-check.html's per-row tap popup (per-trade hypothetical + this
// mechanism's running cumulative) and setup-performance.html's cumulative ledger section.
// Reuses evalBucket()/modeOf()/MECHANISMS (scripts/backtest_flush_post_entry_exit_signals_
// promotion.mjs) unchanged -- the exact same aggregation the weekly promotion/retirement
// trigger uses, not a second hand-computed copy that could silently disagree with it.
router.get('/setups/flush-exit-signals-summary', async (req, res) => {
  try {
    const [firesQ, claimsQ] = await Promise.all([
      query(`
        SELECT setup_type, actual_pnl::float as actual_pnl, mfe_points::float as mfe_points,
               post_entry_exit_signals
        FROM active_setups
        WHERE setup_type LIKE 'GLOBEX_FLUSH%'
          AND origin_status IN ('ACTIVE','SHADOW')
          AND actual_pnl IS NOT NULL
          AND post_entry_exit_signals IS NOT NULL
      `),
      query(`
        SELECT DISTINCT ON (signal_name) signal_name, notes
        FROM performance_audit WHERE signal_type='RESEARCH_CLAIM'
          AND signal_name = ANY($1)
        ORDER BY signal_name, run_date DESC
      `, [MECHANISMS.flatMap(m => [m.claimSlug, `${m.claimSlug}_live_verdict`])]),
    ]);
    // status lives inside notes (JSON), not a dedicated column -- see record_claim.mjs.
    const claimStatus = new Map(claimsQ.rows.map(r => {
      let status = null;
      try { status = JSON.parse(r.notes).status; } catch (_) {}
      return [r.signal_name, status];
    }));

    const summary = [];
    for (const m of MECHANISMS) {
      for (const mode of m.modes) {
        const fires = firesQ.rows.filter(r => modeOf(r.setup_type) === mode && r.post_entry_exit_signals?.[m.key]);
        const withMfe = fires.filter(f => f.mfe_points != null);
        let bigMoveOnly = [];
        if (withMfe.length >= 3) {
          const sorted = [...withMfe].sort((a, b) => a.mfe_points - b.mfe_points);
          const tercileCut = sorted[Math.floor(sorted.length * 2 / 3)].mfe_points;
          bigMoveOnly = fires.filter(f => f.mfe_points != null && f.mfe_points >= tercileCut);
        }
        const all = evalBucket(fires, m.key);
        const big = evalBucket(bigMoveOnly, m.key);
        // A verdict (once N>=20 cleared it once) beats a still-PROVISIONAL claim's status --
        // prefer the live-verdict slug's recommendation, fall back to the original pilot claim.
        const status = claimStatus.get(`${m.claimSlug}_live_verdict`) ?? claimStatus.get(m.claimSlug) ?? 'PROVISIONAL';
        summary.push({
          mechanism: m.key, mode, minRealN: MIN_REAL_N, status,
          all: { n: all.n, avgDelta: all.avgDelta != null ? +all.avgDelta.toFixed(2) : null, thin: all.thin },
          bigMoveOnly: { n: big.n, avgDelta: big.avgDelta != null ? +big.avgDelta.toFixed(2) : null, thin: big.thin },
        });
      }
    }
    res.json({ summary });
  } catch (err) {
    console.error('[setups/flush-exit-signals-summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
