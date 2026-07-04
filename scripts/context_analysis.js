// scripts/context_analysis.js
// ═══════════════════════════════════════════════════════════════════════
// CONTEXTUAL EDGE ANALYSIS — computes WR/EV for all level-fade trades
// broken down by day-of-week, day-type, direction, confluence count, and
// time-of-day. Runs across 4 rolling windows (all-time / 1Y / 6M / 20D).
// Also computes per-pair confluence performance, pair × DOW, pair × TOD.
// Writes to performance_audit with signal_type='CONTEXT_ANALYSIS'.
//
// Run: node scripts/context_analysis.js
// Scheduled: weekly Sunday 6am via crontab (scripts/run_context_analysis.sh)
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import { writeFileSync } from 'fs';

const SIGNAL_TYPE = 'CONTEXT_ANALYSIS';
const PROXIMITY_PT = 15;

// Recommendation logic: stable edge = TRADE, breakeven = CONTEXT, loser = AVOID
function recommend(wr, avg) {
  if (wr >= 0.50 && avg >= 2)  return 'TRADE';
  if (wr >= 0.45 && avg >= 0)  return 'CONTEXT';
  if (wr < 0.38 || avg <= -10) return 'CUT';
  return 'AVOID';
}

async function run() {
  // --- 20-trading-day cutoff (dynamically computed each run) ---
  const cutoff20d = await query(
    `SELECT MIN(log_date) as cutoff FROM (
       SELECT DISTINCT log_date FROM trades ORDER BY log_date DESC LIMIT 20
     ) sub`
  );
  const d20 = cutoff20d.rows[0].cutoff;
  console.log(`20-day cutoff: ${d20}`);

  // --- Base CTE used by every query below ---
  const baseCTE = `
    WITH base AS (
      SELECT
        t.log_date,
        t.pnl,
        t.direction,
        t.entry_time,
        EXTRACT(DOW FROM t.log_date)::int AS dow,
        COALESCE(adl.day_type, 'UNKNOWN') AS day_type,
        (SELECT COUNT(*) FROM level_prices lp2
         WHERE lp2.trade_date = t.log_date
           AND ABS(t.entry_price - lp2.price) <= ${PROXIMITY_PT}
        ) AS nearby_levels
      FROM trades t
      LEFT JOIN acd_daily_log adl ON adl.trade_date = t.log_date
      WHERE t.pnl IS NOT NULL
        AND t.entry_price IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM level_prices lp
          WHERE lp.trade_date = t.log_date
            AND ABS(t.entry_price - lp.price) <= ${PROXIMITY_PT}
        )
    )
  `;

  // --- IB_MID-specific CTE ---
  const ibMidCTE = `
    WITH ibmid AS (
      SELECT
        t.log_date,
        t.pnl,
        t.direction,
        t.entry_time,
        EXTRACT(DOW FROM t.log_date)::int AS dow,
        COALESCE(adl.day_type, 'UNKNOWN') AS day_type
      FROM trades t
      LEFT JOIN acd_daily_log adl ON adl.trade_date = t.log_date
      WHERE t.pnl IS NOT NULL
        AND t.entry_price IS NOT NULL
        AND t.entry_time IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM level_prices lp
          WHERE lp.trade_date = t.log_date
            AND lp.level_name LIKE '%IB_MID%'
            AND ABS(t.entry_price - lp.price) <= ${PROXIMITY_PT}
        )
    )
  `;

  // Shorthand for window filter + aggregation
  const winAgg = (col, dateFilter) => `
    COUNT(*) FILTER (WHERE ${dateFilter}) AS n,
    ROUND(100.0 * COUNT(*) FILTER (WHERE ${dateFilter} AND ${col}.pnl > 0)
      / NULLIF(COUNT(*) FILTER (WHERE ${dateFilter}), 0), 1) AS wr,
    ROUND(AVG(${col}.pnl) FILTER (WHERE ${dateFilter})::numeric, 2) AS avg_pnl
  `;

  // ── Queries ──────────────────────────────────────────────────────────
  const queries = [
    // Day of week (all level fades)
    {
      prefix: 'DOW_',
      groupKey: 'dow_label',
      sql: `${baseCTE},
        agg AS (
          SELECT
            CASE dow WHEN 1 THEN 'MON' WHEN 2 THEN 'TUE' WHEN 3 THEN 'WED'
                     WHEN 4 THEN 'THU' WHEN 5 THEN 'FRI' END AS dow_label,
            log_date, pnl
          FROM base
        )
        SELECT dow_label AS segment,
          COUNT(*) FILTER (WHERE TRUE) AS n_all,
          ROUND(100.0*COUNT(*) FILTER (WHERE pnl>0)/NULLIF(COUNT(*),0),1) AS wr_all,
          ROUND(AVG(pnl)::numeric,2) AS avg_all,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval) AS n_1y,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval),0),1) AS wr_1y,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval)::numeric,2) AS avg_1y,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval) AS n_6m,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval),0),1) AS wr_6m,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval)::numeric,2) AS avg_6m,
          COUNT(*) FILTER (WHERE log_date >= $1) AS n_20d,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= $1 AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= $1),0),1) AS wr_20d,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= $1)::numeric,2) AS avg_20d
        FROM agg GROUP BY dow_label ORDER BY dow_label`,
    },
    // Day type (all level fades)
    {
      prefix: 'DAYTYPE_',
      groupKey: 'segment',
      sql: `${baseCTE}
        SELECT day_type AS segment,
          COUNT(*) AS n_all,
          ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
          ROUND(AVG(pnl)::numeric,2) AS avg_all,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval) AS n_1y,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval),0),1) AS wr_1y,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval)::numeric,2) AS avg_1y,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval) AS n_6m,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval),0),1) AS wr_6m,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval)::numeric,2) AS avg_6m,
          COUNT(*) FILTER (WHERE log_date >= $1) AS n_20d,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= $1 AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= $1),0),1) AS wr_20d,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= $1)::numeric,2) AS avg_20d
        FROM base GROUP BY day_type ORDER BY n_all DESC`,
    },
    // Direction (all level fades)
    {
      prefix: 'DIR_',
      groupKey: 'segment',
      sql: `${baseCTE}
        SELECT direction AS segment,
          COUNT(*) AS n_all,
          ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
          ROUND(AVG(pnl)::numeric,2) AS avg_all,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval) AS n_1y,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval),0),1) AS wr_1y,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval)::numeric,2) AS avg_1y,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval) AS n_6m,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval),0),1) AS wr_6m,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval)::numeric,2) AS avg_6m,
          COUNT(*) FILTER (WHERE log_date >= $1) AS n_20d,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= $1 AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= $1),0),1) AS wr_20d,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= $1)::numeric,2) AS avg_20d
        FROM base WHERE direction IN ('LONG','SHORT') GROUP BY direction`,
    },
    // Confluence bucket (all level fades)
    {
      prefix: 'CONFLUENCE_',
      groupKey: 'segment',
      sql: `${baseCTE},
        bucketed AS (
          SELECT log_date, pnl,
            CASE WHEN nearby_levels = 1 THEN 'SOLO'
                 WHEN nearby_levels = 2 THEN '2_LEVELS'
                 WHEN nearby_levels >= 3 THEN '3PLUS' END AS segment
          FROM base
        )
        SELECT segment,
          COUNT(*) AS n_all,
          ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
          ROUND(AVG(pnl)::numeric,2) AS avg_all,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval) AS n_1y,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval),0),1) AS wr_1y,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval)::numeric,2) AS avg_1y,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval) AS n_6m,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval),0),1) AS wr_6m,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval)::numeric,2) AS avg_6m,
          COUNT(*) FILTER (WHERE log_date >= $1) AS n_20d,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= $1 AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= $1),0),1) AS wr_20d,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= $1)::numeric,2) AS avg_20d
        FROM bucketed GROUP BY segment ORDER BY segment`,
    },
    // Time of day (all level fades)
    {
      prefix: 'TOD_',
      groupKey: 'segment',
      sql: `${baseCTE},
        toded AS (
          SELECT log_date, pnl,
            CASE
              WHEN entry_time::time < '10:00' THEN 'OPEN'
              WHEN entry_time::time < '10:30' THEN 'IB'
              WHEN entry_time::time < '11:30' THEN 'POST_IB'
              WHEN entry_time::time < '13:00' THEN 'MIDDAY'
              ELSE 'LATE'
            END AS segment
          FROM base WHERE entry_time IS NOT NULL
        )
        SELECT segment,
          COUNT(*) AS n_all,
          ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
          ROUND(AVG(pnl)::numeric,2) AS avg_all,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval) AS n_1y,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval),0),1) AS wr_1y,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval)::numeric,2) AS avg_1y,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval) AS n_6m,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval),0),1) AS wr_6m,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval)::numeric,2) AS avg_6m,
          COUNT(*) FILTER (WHERE log_date >= $1) AS n_20d,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= $1 AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= $1),0),1) AS wr_20d,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= $1)::numeric,2) AS avg_20d
        FROM toded GROUP BY segment ORDER BY segment`,
    },
    // IB_MID direction
    {
      prefix: 'IB_MID_DIR_',
      groupKey: 'segment',
      sql: `${ibMidCTE}
        SELECT direction AS segment,
          COUNT(*) AS n_all,
          ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
          ROUND(AVG(pnl)::numeric,2) AS avg_all,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval) AS n_1y,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval),0),1) AS wr_1y,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval)::numeric,2) AS avg_1y,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval) AS n_6m,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval),0),1) AS wr_6m,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval)::numeric,2) AS avg_6m,
          COUNT(*) FILTER (WHERE log_date >= $1) AS n_20d,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= $1 AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= $1),0),1) AS wr_20d,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= $1)::numeric,2) AS avg_20d
        FROM ibmid WHERE direction IN ('LONG','SHORT') GROUP BY direction`,
    },
    // IB_MID day type
    {
      prefix: 'IB_MID_DAYTYPE_',
      groupKey: 'segment',
      sql: `${ibMidCTE}
        SELECT day_type AS segment,
          COUNT(*) AS n_all,
          ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
          ROUND(AVG(pnl)::numeric,2) AS avg_all,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval) AS n_1y,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval),0),1) AS wr_1y,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval)::numeric,2) AS avg_1y,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval) AS n_6m,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval),0),1) AS wr_6m,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval)::numeric,2) AS avg_6m,
          COUNT(*) FILTER (WHERE log_date >= $1) AS n_20d,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= $1 AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= $1),0),1) AS wr_20d,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= $1)::numeric,2) AS avg_20d
        FROM ibmid GROUP BY day_type ORDER BY n_all DESC`,
    },
    // IB_MID day of week
    {
      prefix: 'IB_MID_DOW_',
      groupKey: 'segment',
      sql: `${ibMidCTE},
        named AS (
          SELECT log_date, pnl,
            CASE dow::int WHEN 1 THEN 'MON' WHEN 2 THEN 'TUE' WHEN 3 THEN 'WED'
                          WHEN 4 THEN 'THU' WHEN 5 THEN 'FRI' END AS segment
          FROM ibmid
        )
        SELECT segment,
          COUNT(*) AS n_all,
          ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
          ROUND(AVG(pnl)::numeric,2) AS avg_all,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval) AS n_1y,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval),0),1) AS wr_1y,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval)::numeric,2) AS avg_1y,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval) AS n_6m,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval),0),1) AS wr_6m,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval)::numeric,2) AS avg_6m,
          COUNT(*) FILTER (WHERE log_date >= $1) AS n_20d,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= $1 AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= $1),0),1) AS wr_20d,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= $1)::numeric,2) AS avg_20d
        FROM named GROUP BY segment ORDER BY segment`,
    },
    // IB_MID time of day
    {
      prefix: 'IB_MID_TOD_',
      groupKey: 'segment',
      sql: `${ibMidCTE},
        toded AS (
          SELECT log_date, pnl,
            CASE
              WHEN entry_time::time < '10:00' THEN 'OPEN'
              WHEN entry_time::time < '10:30' THEN 'IB'
              WHEN entry_time::time < '11:30' THEN 'POST_IB'
              ELSE 'LATE'
            END AS segment
          FROM ibmid
        )
        SELECT segment,
          COUNT(*) AS n_all,
          ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
          ROUND(AVG(pnl)::numeric,2) AS avg_all,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval) AS n_1y,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval),0),1) AS wr_1y,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval)::numeric,2) AS avg_1y,
          COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval) AS n_6m,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval),0),1) AS wr_6m,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval)::numeric,2) AS avg_6m,
          COUNT(*) FILTER (WHERE log_date >= $1) AS n_20d,
          ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= $1 AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= $1),0),1) AS wr_20d,
          ROUND(AVG(pnl) FILTER (WHERE log_date >= $1)::numeric,2) AS avg_20d
        FROM toded GROUP BY segment ORDER BY segment`,
    },
  ];

  // ── Window definitions for upsert rows ───────────────────────────────
  const WINDOWS = [
    { suffix: 'ALL', days: 9999 },
    { suffix: '1Y',  days: 365  },
    { suffix: '6M',  days: 182  },
    { suffix: '20D', days: 20   },
  ];

  let upserted = 0;

  for (const q of queries) {
    const res = await query(q.sql, [d20]);

    for (const row of res.rows) {
      const seg = (row.segment || 'UNKNOWN').toString().toUpperCase().replace(/\s+/g, '_');
      const signalName = `${q.prefix}${seg}`;

      // Build one upsert row per window
      const windowData = [
        { days: 9999, n: row.n_all, wr: row.wr_all, avg: row.avg_all },
        { days: 365,  n: row.n_1y,  wr: row.wr_1y,  avg: row.avg_1y  },
        { days: 182,  n: row.n_6m,  wr: row.wr_6m,  avg: row.avg_6m  },
        { days: 20,   n: row.n_20d, wr: row.wr_20d, avg: row.avg_20d },
      ];

      for (const w of windowData) {
        if (!w.n) continue;
        const wrDec = w.wr != null ? parseFloat(w.wr) / 100 : null;
        const rec   = wrDec != null ? recommend(wrDec, parseFloat(w.avg)) : null;

        await query(`
          INSERT INTO performance_audit
            (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation)
          VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (run_date, window_days, signal_type, signal_name)
          DO UPDATE SET
            sample_size  = EXCLUDED.sample_size,
            win_rate     = EXCLUDED.win_rate,
            ev_per_trade = EXCLUDED.ev_per_trade,
            recommendation = EXCLUDED.recommendation
        `, [w.days, SIGNAL_TYPE, signalName, w.n, wrDec, w.avg, rec]);

        upserted++;
      }

      // Console output (6M as the headline window)
      const tag = row.n_6m >= 20 ? '✓' : '~';
      console.log(
        `${tag} ${(q.prefix + seg).padEnd(40)}` +
        `  ALL: ${String(row.n_all).padStart(5)} ${String(row.wr_all).padStart(5)}% $${String(row.avg_all).padStart(7)}` +
        `  6M: ${String(row.n_6m).padStart(4)} ${String(row.wr_6m).padStart(5)}% $${String(row.avg_6m).padStart(7)}`
      );
    }
  }

  // ── Pair analysis ────────────────────────────────────────────────────
  const pairUpserted = await runPairAnalysis(d20);

  console.log(`\nDone. ${upserted + pairUpserted} rows upserted into performance_audit.`);
}

// ── Pair confluence analysis ──────────────────────────────────────────
// Double-joins level_prices to find ALL pairs of levels within PROXIMITY_PT
// of a trade's entry_price on the same date. Covers all 17k+ confluence
// trades vs ~5k from the old level_proximity JSONB approach.
async function runPairAnalysis(d20) {
  const pairCTE = `
    WITH pair_trades AS (
      SELECT
        t.log_date, t.pnl, t.entry_time,
        EXTRACT(DOW FROM t.log_date)::int AS dow,
        COALESCE(adl.day_type, 'UNKNOWN') AS day_type,
        lp1.level_name || '+' || lp2.level_name AS pair_name
      FROM trades t
      LEFT JOIN acd_daily_log adl ON adl.trade_date = t.log_date
      JOIN level_prices lp1
        ON lp1.trade_date = t.log_date
        AND ABS(t.entry_price - lp1.price) <= ${PROXIMITY_PT}
      JOIN level_prices lp2
        ON lp2.trade_date = t.log_date
        AND ABS(t.entry_price - lp2.price) <= ${PROXIMITY_PT}
        AND lp2.level_name > lp1.level_name
      WHERE t.pnl IS NOT NULL AND t.entry_price IS NOT NULL
    )
  `;

  let pairUpserted = 0;
  const topPairs = new Set();

  // ── 1. Per-pair performance across 4 windows (N≥10 all-time) ─────────
  console.log('\n--- Pair Analysis ---');
  const pairPerfRes = await query(`${pairCTE}
    SELECT pair_name AS segment,
      COUNT(*) AS n_all,
      ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
      ROUND(AVG(pnl)::numeric,2) AS avg_all,
      COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval) AS n_1y,
      ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval),0),1) AS wr_1y,
      ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'1 year'::interval)::numeric,2) AS avg_1y,
      COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval) AS n_6m,
      ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval),0),1) AS wr_6m,
      ROUND(AVG(pnl) FILTER (WHERE log_date >= CURRENT_DATE-'6 months'::interval)::numeric,2) AS avg_6m,
      COUNT(*) FILTER (WHERE log_date >= $1) AS n_20d,
      ROUND(100.0*COUNT(*) FILTER (WHERE log_date >= $1 AND pnl>0)/NULLIF(COUNT(*) FILTER (WHERE log_date >= $1),0),1) AS wr_20d,
      ROUND(AVG(pnl) FILTER (WHERE log_date >= $1)::numeric,2) AS avg_20d
    FROM pair_trades
    GROUP BY pair_name
    HAVING COUNT(*) >= 10 AND COUNT(DISTINCT log_date) >= 5
    ORDER BY avg_all DESC
  `, [d20]);

  for (const row of pairPerfRes.rows) {
    const signalName = `PAIR_${row.segment}`;
    topPairs.add(row.segment);

    const windowData = [
      { days: 9999, n: row.n_all, wr: row.wr_all, avg: row.avg_all },
      { days: 365,  n: row.n_1y,  wr: row.wr_1y,  avg: row.avg_1y  },
      { days: 182,  n: row.n_6m,  wr: row.wr_6m,  avg: row.avg_6m  },
      { days: 20,   n: row.n_20d, wr: row.wr_20d, avg: row.avg_20d },
    ];

    for (const w of windowData) {
      if (!w.n) continue;
      const wrDec = w.wr != null ? parseFloat(w.wr) / 100 : null;
      const rec   = wrDec != null ? recommend(wrDec, parseFloat(w.avg)) : null;

      await query(`
        INSERT INTO performance_audit
          (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation)
        VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (run_date, window_days, signal_type, signal_name)
        DO UPDATE SET
          sample_size  = EXCLUDED.sample_size,
          win_rate     = EXCLUDED.win_rate,
          ev_per_trade = EXCLUDED.ev_per_trade,
          recommendation = EXCLUDED.recommendation
      `, [w.days, SIGNAL_TYPE, signalName, w.n, wrDec, w.avg, rec]);
      pairUpserted++;
    }

    const tag = row.n_all >= 20 ? '✓' : '~';
    console.log(
      `${tag} ${'PAIR_' + row.segment}`.padEnd(48) +
      `  ALL: ${String(row.n_all).padStart(4)} ${String(row.wr_all).padStart(5)}% $${String(row.avg_all).padStart(7)}` +
      `  6M: ${String(row.n_6m || 0).padStart(3)} ${String(row.wr_6m || 'N/A').padStart(5)}% $${String(row.avg_6m || 'N/A').padStart(7)}`
    );
  }

  // ── 2. Pair × DOW (all-time only, N≥5 per cell, qualified pairs only) ─
  const topPairsArr = Array.from(topPairs);
  if (!topPairsArr.length) { console.log('No qualified pairs — skipping DOW/TOD/DT.'); return pairUpserted; }

  const pairDOWRes = await query(`${pairCTE}
    SELECT
      pair_name || '_DOW_' || CASE dow
        WHEN 1 THEN 'MON' WHEN 2 THEN 'TUE' WHEN 3 THEN 'WED'
        WHEN 4 THEN 'THU' WHEN 5 THEN 'FRI'
      END AS segment,
      COUNT(*) AS n_all,
      ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
      ROUND(AVG(pnl)::numeric,2) AS avg_all
    FROM pair_trades
    WHERE dow BETWEEN 1 AND 5 AND pair_name = ANY($1)
    GROUP BY pair_name, dow
    HAVING COUNT(*) >= 5
    ORDER BY pair_name, dow
  `, [topPairsArr]);

  for (const row of pairDOWRes.rows) {
    const signalName = `PAIR_${row.segment}`;
    const wrDec = row.wr_all != null ? parseFloat(row.wr_all) / 100 : null;
    const rec   = wrDec != null ? recommend(wrDec, parseFloat(row.avg_all)) : null;

    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation)
      VALUES (CURRENT_DATE, 9999, $1, $2, $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name)
      DO UPDATE SET
        sample_size  = EXCLUDED.sample_size,
        win_rate     = EXCLUDED.win_rate,
        ev_per_trade = EXCLUDED.ev_per_trade,
        recommendation = EXCLUDED.recommendation
    `, [SIGNAL_TYPE, signalName, row.n_all, wrDec, row.avg_all, rec]);
    pairUpserted++;
  }

  // ── 3. Pair × TOD (all-time only, N≥5 per cell, qualified pairs only) ──
  const pairTODRes = await query(`${pairCTE},
    toded AS (
      SELECT log_date, pnl,
        pair_name || '_TOD_' || CASE
          WHEN entry_time::time < '10:00' THEN 'OPEN'
          WHEN entry_time::time < '10:30' THEN 'IB'
          WHEN entry_time::time < '11:30' THEN 'POST_IB'
          WHEN entry_time::time < '13:00' THEN 'MIDDAY'
          ELSE 'LATE'
        END AS segment
      FROM pair_trades WHERE entry_time IS NOT NULL AND pair_name = ANY($1)
    )
    SELECT segment,
      COUNT(*) AS n_all,
      ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
      ROUND(AVG(pnl)::numeric,2) AS avg_all
    FROM toded
    GROUP BY segment
    HAVING COUNT(*) >= 5
    ORDER BY segment
  `, [topPairsArr]);

  for (const row of pairTODRes.rows) {
    const signalName = `PAIR_${row.segment}`;
    const wrDec = row.wr_all != null ? parseFloat(row.wr_all) / 100 : null;
    const rec   = wrDec != null ? recommend(wrDec, parseFloat(row.avg_all)) : null;

    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation)
      VALUES (CURRENT_DATE, 9999, $1, $2, $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name)
      DO UPDATE SET
        sample_size  = EXCLUDED.sample_size,
        win_rate     = EXCLUDED.win_rate,
        ev_per_trade = EXCLUDED.ev_per_trade,
        recommendation = EXCLUDED.recommendation
    `, [SIGNAL_TYPE, signalName, row.n_all, wrDec, row.avg_all, rec]);
    pairUpserted++;
  }

  // ── 4. Pair × Day Type (all-time only, N≥5, qualified pairs only) ───────
  const pairDTRes = await query(`${pairCTE}
    SELECT
      pair_name || '_DT_' || day_type AS segment,
      COUNT(*) AS n_all,
      ROUND(100.0*SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) AS wr_all,
      ROUND(AVG(pnl)::numeric,2) AS avg_all
    FROM pair_trades
    WHERE pair_name = ANY($1)
    GROUP BY pair_name, day_type
    HAVING COUNT(*) >= 5
    ORDER BY pair_name, day_type
  `, [topPairsArr]);

  for (const row of pairDTRes.rows) {
    const signalName = `PAIR_${row.segment}`;
    const wrDec = row.wr_all != null ? parseFloat(row.wr_all) / 100 : null;
    const rec   = wrDec != null ? recommend(wrDec, parseFloat(row.avg_all)) : null;

    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation)
      VALUES (CURRENT_DATE, 9999, $1, $2, $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name)
      DO UPDATE SET
        sample_size  = EXCLUDED.sample_size,
        win_rate     = EXCLUDED.win_rate,
        ev_per_trade = EXCLUDED.ev_per_trade,
        recommendation = EXCLUDED.recommendation
    `, [SIGNAL_TYPE, signalName, row.n_all, wrDec, row.avg_all, rec]);
    pairUpserted++;
  }

  console.log(`Pair analysis: ${pairUpserted} rows (${topPairs.size} pairs with N≥10).`);
  return pairUpserted;
}

async function exportPairsJSON() {
  const runDate = new Date().toISOString().slice(0, 10);
  const [baseQ, dowQ, todQ, dtQ, windowsQ] = await Promise.all([
    query(`SELECT DISTINCT ON (signal_name) signal_name, sample_size, ROUND(win_rate*100,2)::float AS wr_pct, ROUND(ev_per_trade::numeric,2)::float AS ev, recommendation FROM performance_audit WHERE signal_type='CONTEXT_ANALYSIS' AND signal_name LIKE 'PAIR_%' AND window_days=9999 AND signal_name NOT LIKE '%_DOW_%' AND signal_name NOT LIKE '%_TOD_%' AND signal_name NOT LIKE '%_DT_%' ORDER BY signal_name, run_date DESC`),
    query(`SELECT DISTINCT ON (signal_name) signal_name, sample_size, ROUND(win_rate*100,2)::float AS wr_pct, ROUND(ev_per_trade::numeric,2)::float AS ev, recommendation FROM performance_audit WHERE signal_type='CONTEXT_ANALYSIS' AND signal_name LIKE 'PAIR_%_DOW_%' AND window_days=9999 ORDER BY signal_name, run_date DESC`),
    query(`SELECT DISTINCT ON (signal_name) signal_name, sample_size, ROUND(win_rate*100,2)::float AS wr_pct, ROUND(ev_per_trade::numeric,2)::float AS ev, recommendation FROM performance_audit WHERE signal_type='CONTEXT_ANALYSIS' AND signal_name LIKE 'PAIR_%_TOD_%' AND window_days=9999 ORDER BY signal_name, run_date DESC`),
    query(`SELECT DISTINCT ON (signal_name) signal_name, sample_size, ROUND(win_rate*100,2)::float AS wr_pct, ROUND(ev_per_trade::numeric,2)::float AS ev, recommendation FROM performance_audit WHERE signal_type='CONTEXT_ANALYSIS' AND signal_name LIKE 'PAIR_%_DT_%' AND window_days=9999 ORDER BY signal_name, run_date DESC`),
    query(`SELECT DISTINCT ON (signal_name, window_days) signal_name, window_days, sample_size, ROUND(win_rate*100,2)::float AS wr_pct, ROUND(ev_per_trade::numeric,2)::float AS ev, recommendation FROM performance_audit WHERE signal_type='CONTEXT_ANALYSIS' AND signal_name LIKE 'PAIR_%' AND window_days IN (365,182,20) AND signal_name NOT LIKE '%_DOW_%' AND signal_name NOT LIKE '%_TOD_%' AND signal_name NOT LIKE '%_DT_%' ORDER BY signal_name, window_days, run_date DESC`),
  ]);

  const idx = (rows, keyFn, valFn) => { const out = {}; rows.forEach(r => { const k = keyFn(r); if (!out[k]) out[k] = []; out[k].push(valFn(r)); }); return out; };
  const dowByPair = idx(dowQ.rows, r => r.signal_name.replace(/_DOW_\w+$/, '').replace(/^PAIR_/, ''), r => ({ dow: r.signal_name.match(/_DOW_(\w+)$/)?.[1], n: r.sample_size, wr: r.wr_pct, ev: r.ev, rec: r.recommendation }));
  const todByPair = idx(todQ.rows, r => r.signal_name.replace(/_TOD_\w+$/, '').replace(/^PAIR_/, ''), r => ({ tod: r.signal_name.match(/_TOD_(\w+)$/)?.[1], n: r.sample_size, wr: r.wr_pct, ev: r.ev, rec: r.recommendation }));
  const dtByPair  = idx(dtQ.rows,  r => r.signal_name.replace(/_DT_\w+$/, '').replace(/^PAIR_/, ''),  r => ({ day_type: r.signal_name.match(/_DT_(\w+)$/)?.[1], n: r.sample_size, wr: r.wr_pct, ev: r.ev, rec: r.recommendation }));
  const winByPair = {};
  windowsQ.rows.forEach(r => { const b = r.signal_name.replace(/^PAIR_/, ''); if (!winByPair[b]) winByPair[b] = {}; winByPair[b][r.window_days] = { n: r.sample_size, wr: r.wr_pct, ev: r.ev, rec: r.recommendation }; });

  const pairs = baseQ.rows.map(r => {
    const base = r.signal_name.replace(/^PAIR_/, '');
    const [l1, l2] = base.split('+');
    const dows = (dowByPair[base] || []).sort((a, b) => b.ev - a.ev);
    const tods = (todByPair[base] || []).sort((a, b) => b.ev - a.ev);
    const dts  = (dtByPair[base]  || []).sort((a, b) => b.ev - a.ev);
    const wins = winByPair[base]  || {};
    return {
      pair: base, level1: l1, level2: l2,
      n_all: r.sample_size, wr_all: r.wr_pct, ev_all: r.ev, recommendation: r.recommendation,
      windows: { '1Y': wins[365]||null, '6M': wins[182]||null, '20D': wins[20]||null },
      best_dow: dows[0]||null, worst_dow: dows.length>1 ? dows[dows.length-1] : null,
      best_tod: tods[0]||null, worst_tod: tods.length>1 ? tods[tods.length-1] : null,
      best_dt:  dts[0]||null,  worst_dt:  dts.length>1  ? dts[dts.length-1]   : null,
      dow_breakdown: dows, tod_breakdown: tods, dt_breakdown: dts,
    };
  });

  const outPath = new URL('../scripts/output/confluence_pairs_latest.json', import.meta.url).pathname;
  writeFileSync(outPath, JSON.stringify({ generated: runDate, total_pairs: pairs.length, proximity_pt: PROXIMITY_PT, min_distinct_dates: 5, min_n: 10, pairs }, null, 2));
  console.log(`Pair export: ${pairs.length} pairs → scripts/output/confluence_pairs_latest.json`);
}

run().then(() => exportPairsJSON()).catch(e => { console.error(e); process.exit(1); });
