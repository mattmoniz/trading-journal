// Alpha research queries — run once to inform implementation decisions.
// Covers: runner optimization, approach delta filter, level recency,
//         stacking WR, session timing, sequential failure, post-flush, overnight alignment EV.
// Results printed to stdout; nothing written to DB.

import { query } from '../server/db.js';

const section = (title) => console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`);
const row = (r) => Object.entries(r).map(([k,v]) => `${k}=${v}`).join('  ');

async function main() {

  // ── 1. RUNNER OPTIMIZATION ───────────────────────────────────────────────
  // When TARGET_HIT, how far did price continue past T1 (mfe vs t1 distance)?
  // Goal: find conditions where runners to 2×T1 are justified.
  section('1. RUNNER OPTIMIZATION — MFE vs T1 ratio on TARGET_HIT trades');
  const runner = await query(`
    SELECT
      setup_type,
      COUNT(*)::int                                                                  AS n,
      ROUND(AVG(mfe_points)::numeric, 1)                                            AS avg_mfe,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY mfe_points)::numeric, 1)   AS p50_mfe,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mfe_points)::numeric, 1)  AS p75_mfe,
      ROUND(AVG(
        mfe_points / NULLIF(ABS(t1_level - COALESCE(entry_zone_high, entry_zone_low)), 0)
      )::numeric, 2)                                                                AS avg_mfe_vs_t1_ratio
    FROM active_setups
    WHERE replay_resolution = 'TARGET_HIT'
      AND mfe_points IS NOT NULL
      AND t1_level IS NOT NULL
      AND entry_zone_low IS NOT NULL
      AND status = 'RESOLVED'
    GROUP BY setup_type
    HAVING COUNT(*) >= 10
    ORDER BY avg_mfe_vs_t1_ratio DESC
    LIMIT 20
  `);
  runner.rows.forEach(r => console.log(row(r)));

  // Runner by day type
  section('1b. RUNNER — MFE ratio by day type (TARGET_HIT only, N>=10)');
  const runnerDt = await query(`
    SELECT
      al.day_type,
      COUNT(*)::int AS n,
      ROUND(AVG(
        as2.mfe_points / NULLIF(ABS(as2.t1_level - COALESCE(as2.entry_zone_high, as2.entry_zone_low)), 0)
      )::numeric, 2) AS avg_mfe_vs_t1_ratio,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY as2.mfe_points)::numeric, 1) AS p75_mfe
    FROM active_setups as2
    JOIN acd_daily_log al ON al.trade_date = as2.trade_date
    WHERE as2.replay_resolution = 'TARGET_HIT'
      AND as2.mfe_points IS NOT NULL
      AND as2.t1_level IS NOT NULL
      AND as2.entry_zone_low IS NOT NULL
      AND as2.status = 'RESOLVED'
      AND al.day_type IS NOT NULL
    GROUP BY al.day_type
    HAVING COUNT(*) >= 10
    ORDER BY avg_mfe_vs_t1_ratio DESC
  `);
  runnerDt.rows.forEach(r => console.log(row(r)));

  // ── 2. APPROACH DELTA FILTER ─────────────────────────────────────────────
  // Do fades succeed more when the approach bars show selling at the level (for LONG fades)?
  // Net delta on 5 bars before fired_at: negative = sellers present (good for LONG fade)
  section('2. APPROACH DELTA FILTER — WR split by approach-bar delta alignment');
  const delta = await query(`
    WITH approach AS (
      SELECT
        a.id,
        a.setup_type,
        a.actual_pnl,
        a.replay_resolution,
        CASE WHEN a.setup_type LIKE '%_LONG' THEN 'LONG' ELSE 'SHORT' END AS direction,
        SUM(p.ask_volume::float - p.bid_volume::float)                     AS net_delta
      FROM active_setups a
      JOIN price_bars_primary p
        ON p.symbol = 'NQ'
        AND p.ts::date = a.trade_date
        AND p.ts >= a.fired_at - INTERVAL '6 minutes'
        AND p.ts <  a.fired_at + INTERVAL '1 minute'
      WHERE a.status = 'RESOLVED'
        AND a.actual_pnl IS NOT NULL
        AND a.fired_at IS NOT NULL
        AND a.setup_type LIKE '%FADE%'
        AND p.ask_volume IS NOT NULL
        AND p.bid_volume IS NOT NULL
      GROUP BY a.id, a.setup_type, a.actual_pnl, a.replay_resolution
    )
    SELECT
      direction,
      CASE
        WHEN direction = 'LONG'  AND net_delta < 0 THEN 'sellers_at_level (good)'
        WHEN direction = 'LONG'  AND net_delta > 0 THEN 'buyers_at_level (bad)'
        WHEN direction = 'SHORT' AND net_delta > 0 THEN 'buyers_at_level (good)'
        WHEN direction = 'SHORT' AND net_delta < 0 THEN 'sellers_at_level (bad)'
        ELSE 'neutral'
      END AS delta_alignment,
      COUNT(*)::int AS n,
      ROUND(100.0 * SUM(CASE WHEN actual_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct,
      ROUND(AVG(actual_pnl)::numeric, 0)                                            AS ev
    FROM approach
    GROUP BY direction, delta_alignment
    HAVING COUNT(*) >= 15
    ORDER BY direction, delta_alignment
  `);
  delta.rows.forEach(r => console.log(row(r)));

  // ── 3. LEVEL RECENCY ─────────────────────────────────────────────────────
  // Does WR differ based on how long since the level was last tested?
  section('3. LEVEL RECENCY — WR by days since last test of same base level');
  const recency = await query(`
    WITH base AS (
      SELECT
        REGEXP_REPLACE(setup_type, '_(LONG|SHORT)$', '') AS level_name,
        trade_date,
        actual_pnl,
        LAG(trade_date) OVER (
          PARTITION BY REGEXP_REPLACE(setup_type, '_(LONG|SHORT)$', '')
          ORDER BY trade_date
        ) AS prev_date
      FROM active_setups
      WHERE status = 'RESOLVED' AND actual_pnl IS NOT NULL
    )
    SELECT
      CASE
        WHEN trade_date - prev_date <= 2  THEN '1-2 days'
        WHEN trade_date - prev_date <= 5  THEN '3-5 days'
        WHEN trade_date - prev_date <= 10 THEN '6-10 days'
        WHEN trade_date - prev_date <= 20 THEN '11-20 days'
        ELSE '21+ days (fresh)'
      END AS recency_bucket,
      COUNT(*)::int AS n,
      ROUND(100.0 * SUM(CASE WHEN actual_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct,
      ROUND(AVG(actual_pnl)::numeric, 0) AS ev
    FROM base
    WHERE prev_date IS NOT NULL
    GROUP BY recency_bucket
    ORDER BY MIN(trade_date - prev_date)
  `);
  recency.rows.forEach(r => console.log(row(r)));

  // ── 4. STACKING / SAME-DIRECTION DAILY COUNT ─────────────────────────────
  // On days with multiple same-direction setups, does WR improve?
  section('4. STACKING — WR by count of same-direction setups per day');
  const stack = await query(`
    WITH daily AS (
      SELECT
        trade_date,
        CASE WHEN setup_type LIKE '%_LONG' OR setup_type LIKE '%_BULLISH' OR setup_type LIKE '%_UP' THEN 'LONG' ELSE 'SHORT' END AS dir,
        COUNT(*)::int                                                                AS n_setups,
        SUM(CASE WHEN actual_pnl > 0 THEN 1 ELSE 0 END)::int                       AS wins,
        ROUND(AVG(actual_pnl)::numeric, 0)                                         AS day_ev
      FROM active_setups
      WHERE status = 'RESOLVED' AND actual_pnl IS NOT NULL
      GROUP BY trade_date, dir
    )
    SELECT
      n_setups,
      COUNT(*)::int AS n_days,
      ROUND(100.0 * SUM(wins)::numeric / SUM(n_setups), 1) AS wr_pct,
      ROUND(AVG(day_ev)::numeric, 0) AS avg_day_ev
    FROM daily
    GROUP BY n_setups
    ORDER BY n_setups
  `);
  stack.rows.forEach(r => console.log(row(r)));

  // ── 5. SESSION TIMING — WR by 30-min bucket ──────────────────────────────
  section('5. SESSION TIMING — WR by time-of-day bucket (all setups, N>=15)');
  const timing = await query(`
    SELECT
      CASE
        WHEN EXTRACT(hour FROM fired_at AT TIME ZONE 'America/New_York')*60
           + EXTRACT(minute FROM fired_at AT TIME ZONE 'America/New_York') < 585  THEN '9:30-9:45'
        WHEN EXTRACT(hour FROM fired_at AT TIME ZONE 'America/New_York')*60
           + EXTRACT(minute FROM fired_at AT TIME ZONE 'America/New_York') < 600  THEN '9:45-10:00'
        WHEN EXTRACT(hour FROM fired_at AT TIME ZONE 'America/New_York')*60
           + EXTRACT(minute FROM fired_at AT TIME ZONE 'America/New_York') < 630  THEN '10:00-10:30'
        WHEN EXTRACT(hour FROM fired_at AT TIME ZONE 'America/New_York')*60
           + EXTRACT(minute FROM fired_at AT TIME ZONE 'America/New_York') < 690  THEN '10:30-11:30'
        ELSE '11:30+'
      END AS time_bucket,
      COUNT(*)::int AS n,
      ROUND(100.0 * SUM(CASE WHEN actual_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct,
      ROUND(AVG(actual_pnl)::numeric, 0) AS ev
    FROM active_setups
    WHERE status = 'RESOLVED'
      AND actual_pnl IS NOT NULL
      AND fired_at IS NOT NULL
      AND setup_type LIKE '%FADE%'
    GROUP BY time_bucket
    HAVING COUNT(*) >= 15
    ORDER BY MIN(EXTRACT(hour FROM fired_at AT TIME ZONE 'America/New_York')*60
               + EXTRACT(minute FROM fired_at AT TIME ZONE 'America/New_York'))
  `);
  timing.rows.forEach(r => console.log(row(r)));

  // ── 6. SEQUENTIAL FAILURE — WR after prior stop-out ──────────────────────
  section('6. SEQUENTIAL FAILURE — WR of setup N+1 after N was STOP_HIT');
  const seqFail = await query(`
    WITH ordered AS (
      SELECT
        trade_date,
        fired_at,
        actual_pnl,
        replay_resolution,
        LAG(replay_resolution) OVER (PARTITION BY trade_date ORDER BY fired_at) AS prev_res,
        LAG(actual_pnl)        OVER (PARTITION BY trade_date ORDER BY fired_at) AS prev_pnl
      FROM active_setups
      WHERE status = 'RESOLVED' AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL
    )
    SELECT
      CASE
        WHEN prev_res = 'STOP_HIT' THEN 'after_loss'
        WHEN prev_res = 'TARGET_HIT' THEN 'after_win'
        ELSE 'first_of_day'
      END AS context,
      COUNT(*)::int AS n,
      ROUND(100.0 * SUM(CASE WHEN actual_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct,
      ROUND(AVG(actual_pnl)::numeric, 0) AS ev
    FROM ordered
    GROUP BY context
    ORDER BY context
  `);
  seqFail.rows.forEach(r => console.log(row(r)));

  // ── 7. OVERNIGHT ALIGNMENT EV SPLIT ──────────────────────────────────────
  section('7. OVERNIGHT ALIGNMENT — actual EV split for level fades (aligned vs counter vs neutral)');
  const overnight = await query(`
    SELECT
      ar.overnight_inventory,
      ar.open_vs_prior_value,
      CASE
        WHEN (as2.setup_type LIKE '%_LONG'  AND (ar.overnight_inventory = 'SHORT_TRAPPED' OR ar.open_vs_prior_value = 'ABOVE_VALUE'))
          OR (as2.setup_type LIKE '%_SHORT' AND (ar.overnight_inventory = 'LONG_TRAPPED'  OR ar.open_vs_prior_value = 'BELOW_VALUE'))
        THEN 'ALIGNED'
        WHEN (as2.setup_type LIKE '%_LONG'  AND (ar.overnight_inventory = 'LONG_TRAPPED'  OR ar.open_vs_prior_value = 'BELOW_VALUE'))
          OR (as2.setup_type LIKE '%_SHORT' AND (ar.overnight_inventory = 'SHORT_TRAPPED' OR ar.open_vs_prior_value = 'ABOVE_VALUE'))
        THEN 'COUNTER'
        ELSE 'NEUTRAL'
      END AS alignment,
      COUNT(*)::int AS n,
      ROUND(100.0 * SUM(CASE WHEN as2.actual_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct,
      ROUND(AVG(as2.actual_pnl)::numeric, 0) AS ev
    FROM active_setups as2
    JOIN auction_reads ar ON ar.trade_date = as2.trade_date
    WHERE as2.status = 'RESOLVED'
      AND as2.actual_pnl IS NOT NULL
      AND as2.setup_type LIKE '%FADE%'
      AND ar.overnight_inventory IS NOT NULL
    GROUP BY ar.overnight_inventory, ar.open_vs_prior_value, alignment
    HAVING COUNT(*) >= 10
    ORDER BY alignment, ev DESC
    LIMIT 30
  `);
  overnight.rows.forEach(r => console.log(row(r)));

  // Summary alignment
  section('7b. OVERNIGHT ALIGNMENT — summary by alignment bucket');
  const overnightSummary = await query(`
    SELECT
      CASE
        WHEN (as2.setup_type LIKE '%_LONG'  AND (ar.overnight_inventory = 'SHORT_TRAPPED' OR ar.open_vs_prior_value = 'ABOVE_VALUE'))
          OR (as2.setup_type LIKE '%_SHORT' AND (ar.overnight_inventory = 'LONG_TRAPPED'  OR ar.open_vs_prior_value = 'BELOW_VALUE'))
        THEN 'ALIGNED'
        WHEN (as2.setup_type LIKE '%_LONG'  AND (ar.overnight_inventory = 'LONG_TRAPPED'  OR ar.open_vs_prior_value = 'BELOW_VALUE'))
          OR (as2.setup_type LIKE '%_SHORT' AND (ar.overnight_inventory = 'SHORT_TRAPPED' OR ar.open_vs_prior_value = 'ABOVE_VALUE'))
        THEN 'COUNTER'
        ELSE 'NEUTRAL'
      END AS alignment,
      COUNT(*)::int AS n,
      ROUND(100.0 * SUM(CASE WHEN as2.actual_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct,
      ROUND(AVG(as2.actual_pnl)::numeric, 0) AS ev
    FROM active_setups as2
    JOIN auction_reads ar ON ar.trade_date = as2.trade_date
    WHERE as2.status = 'RESOLVED'
      AND as2.actual_pnl IS NOT NULL
      AND as2.setup_type LIKE '%FADE%'
      AND ar.overnight_inventory IS NOT NULL
    GROUP BY alignment
    ORDER BY alignment
  `);
  overnightSummary.rows.forEach(r => console.log(row(r)));

  // ── 8. POST-FLUSH — cascade days vs normal days ───────────────────────────
  section('8. POST-FLUSH — WR on days with 3+ levels touched within 10 min vs normal');
  const flush = await query(`
    WITH level_touches AS (
      SELECT
        trade_date,
        fired_at,
        setup_type,
        actual_pnl,
        replay_resolution
      FROM active_setups
      WHERE status = 'RESOLVED' AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL
        AND setup_type LIKE '%FADE%'
    ),
    cascade_days AS (
      SELECT DISTINCT a.trade_date
      FROM level_touches a
      WHERE (
        SELECT COUNT(DISTINCT b.setup_type) FROM level_touches b
        WHERE b.trade_date = a.trade_date
          AND b.fired_at BETWEEN a.fired_at AND a.fired_at + INTERVAL '10 minutes'
      ) >= 3
    )
    SELECT
      CASE WHEN cd.trade_date IS NOT NULL THEN 'cascade_day (3+ levels/10min)' ELSE 'normal_day' END AS day_type,
      COUNT(lt.*)::int AS n,
      ROUND(100.0 * SUM(CASE WHEN lt.actual_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct,
      ROUND(AVG(lt.actual_pnl)::numeric, 0) AS ev
    FROM level_touches lt
    LEFT JOIN cascade_days cd ON cd.trade_date = lt.trade_date
    GROUP BY (cd.trade_date IS NOT NULL)
    ORDER BY day_type
  `);
  flush.rows.forEach(r => console.log(row(r)));

  // ── 9. TREND-JOIN CANDIDATES ─────────────────────────────────────────────
  // On TREND days: do fades WITH trend direction outperform counter-trend fades?
  // IB direction derived from IB_BULLISH/IB_BEARISH entries in active_setups.
  section('9. TREND-JOIN — TREND day fade performance by alignment with IB direction');
  const trend = await query(`
    WITH ib_days AS (
      SELECT trade_date,
        MAX(CASE WHEN setup_type = 'IB_BULLISH' THEN 'BULLISH'
                 WHEN setup_type = 'IB_BEARISH' THEN 'BEARISH' END) AS ib_dir
      FROM active_setups
      WHERE setup_type IN ('IB_BULLISH','IB_BEARISH')
      GROUP BY trade_date
    )
    SELECT
      al.day_type,
      ib.ib_dir,
      CASE
        WHEN (ib.ib_dir = 'BULLISH' AND as2.setup_type LIKE '%_LONG')
          OR (ib.ib_dir = 'BEARISH' AND as2.setup_type LIKE '%_SHORT')
        THEN 'WITH_TREND'
        WHEN (ib.ib_dir = 'BULLISH' AND as2.setup_type LIKE '%_SHORT')
          OR (ib.ib_dir = 'BEARISH' AND as2.setup_type LIKE '%_LONG')
        THEN 'COUNTER_TREND'
        ELSE 'IB_UNKNOWN'
      END AS trend_alignment,
      COUNT(*)::int AS n,
      ROUND(100.0 * SUM(CASE WHEN as2.actual_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct,
      ROUND(AVG(as2.actual_pnl)::numeric, 0) AS ev
    FROM active_setups as2
    JOIN acd_daily_log al ON al.trade_date = as2.trade_date
    LEFT JOIN ib_days ib ON ib.trade_date = as2.trade_date
    WHERE as2.status = 'RESOLVED'
      AND as2.actual_pnl IS NOT NULL
      AND as2.setup_type LIKE '%FADE%'
      AND al.day_type IS NOT NULL
    GROUP BY al.day_type, ib.ib_dir, trend_alignment
    HAVING COUNT(*) >= 15
    ORDER BY al.day_type, trend_alignment
  `);
  trend.rows.forEach(r => console.log(row(r)));

  console.log('\n✅ Research complete.\n');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
