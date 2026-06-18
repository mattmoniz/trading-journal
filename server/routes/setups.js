import express from 'express';
import { query, getClient } from '../db.js';
import { getStructuralLevels } from '../services/phaseChangeDetector.js';
import { runSetupBacktest, getBacktestEdge } from '../services/setupBacktestService.js';

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
    const isLong = setupType.includes('LONG') || setupType.includes('BULLISH') || setupType.includes('UP');

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

export default router;
