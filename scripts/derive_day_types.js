/**
 * derive_day_types.js
 *
 * Applies confirmed ground-truth derivation rules to every completed RTH session
 * and populates acd_daily_log.day_type. Idempotent — safe to re-run.
 *
 * Rules (confirmed 2026-06-06):
 *   TREND:     close_pct >= 0.80 OR <= 0.20  (outer 20% of session range)
 *              AND trend_str >= 0.50          (net O→C is ≥50% of total range)
 *              AND range_ratio >= 0.75        (not compressed/holiday)
 *              AND close_outside_ib = TRUE    (did not close back inside IB)
 *   TURBULENT: range_ratio >= 1.25 AND NOT TREND
 *   BALANCE:   everything else
 *
 * Only updates existing acd_daily_log rows. Never touches today's session.
 * Never modifies classifyDayType or any live classifier.
 */

import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

function classifyGroundTruth({ range_ratio, close_pct, trend_str, close_outside_ib }) {
  const isOutside = close_outside_ib === true;
  if (
    (close_pct >= 0.80 || close_pct <= 0.20) &&
    trend_str >= 0.50 &&
    range_ratio >= 0.75 &&
    isOutside
  ) return 'TREND';
  if (range_ratio >= 1.25) return 'TURBULENT';
  return 'BALANCE';
}

async function main() {
  console.log('[derive_day_types] Computing ground-truth day types for all completed sessions...\n');

  // Pull all completed RTH sessions with IB and rolling avg
  const sessQ = await query(`
    WITH sessions AS (
      SELECT
        ts::date                                                              AS trade_date,
        (array_agg(open  ORDER BY ts))[1]::float                             AS sess_open,
        MAX(high)::float                                                      AS sess_high,
        MIN(low)::float                                                       AS sess_low,
        (array_agg(close ORDER BY ts DESC))[1]::float                        AS sess_close,
        MAX(high) FILTER (
          WHERE EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) < 630
        )::float                                                              AS ib_high,
        MIN(low) FILTER (
          WHERE EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) < 630
        )::float                                                              AS ib_low,
        COUNT(*)                                                              AS bars
      FROM price_bars
      WHERE symbol = 'NQ'
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        AND ts::date < CURRENT_DATE
      GROUP BY ts::date
      HAVING COUNT(*) >= 200
    ),
    with_avg AS (
      SELECT *,
        AVG(sess_high - sess_low) OVER (
          ORDER BY trade_date
          ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING
        ) AS avg_range_20
      FROM sessions
    )
    SELECT
      trade_date,
      sess_open, sess_high, sess_low, sess_close,
      ib_high, ib_low,
      ROUND((sess_high - sess_low)::numeric, 2)                                          AS sess_range,
      ROUND(avg_range_20::numeric, 2)                                                    AS avg_range_20,
      ROUND(((sess_high - sess_low) / NULLIF(avg_range_20, 0))::numeric, 4)             AS range_ratio,
      ROUND(((sess_close - sess_low)  / NULLIF(sess_high - sess_low, 0))::numeric, 4)   AS close_pct,
      ROUND((ABS(sess_close - sess_open) / NULLIF(sess_high - sess_low, 0))::numeric, 4) AS trend_str,
      (sess_close > ib_high OR sess_close < ib_low)                                      AS close_outside_ib
    FROM with_avg
    WHERE avg_range_20 IS NOT NULL
    ORDER BY trade_date
  `);

  const sessions = sessQ.rows;
  console.log(`Found ${sessions.length} completed sessions with enough history for avg_range_20.\n`);

  // Classify and collect
  const labeled = sessions.map(s => ({
    trade_date:      s.trade_date,
    sess_open:       parseFloat(s.sess_open),
    sess_high:       parseFloat(s.sess_high),
    sess_low:        parseFloat(s.sess_low),
    sess_close:      parseFloat(s.sess_close),
    sess_range:      parseFloat(s.sess_range),
    avg_range_20:    parseFloat(s.avg_range_20),
    range_ratio:     parseFloat(s.range_ratio),
    close_pct:       parseFloat(s.close_pct),
    trend_str:       parseFloat(s.trend_str),
    close_outside_ib: s.close_outside_ib,
    day_type: classifyGroundTruth({
      range_ratio:     parseFloat(s.range_ratio),
      close_pct:       parseFloat(s.close_pct),
      trend_str:       parseFloat(s.trend_str),
      close_outside_ib: s.close_outside_ib,
    }),
  }));

  // Upsert to acd_daily_log (UPDATE only — do not insert rows)
  let updated = 0, noRow = 0;
  for (const s of labeled) {
    const r = await query(
      `UPDATE acd_daily_log SET day_type = $1 WHERE trade_date = $2`,
      [s.day_type, s.trade_date]
    );
    if (r.rowCount > 0) updated++;
    else noRow++;
  }

  // ── REPORT ────────────────────────────────────────────────────────────────

  const trend     = labeled.filter(s => s.day_type === 'TREND');
  const turbulent = labeled.filter(s => s.day_type === 'TURBULENT');
  const balance   = labeled.filter(s => s.day_type === 'BALANCE');
  const total     = labeled.length;

  console.log('═══════════════════════════════════════════════════════');
  console.log('  DISTRIBUTION');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Total sessions labeled : ${total}`);
  console.log(`  TREND                  : ${trend.length} (${(trend.length/total*100).toFixed(1)}%)`);
  console.log(`  TURBULENT              : ${turbulent.length} (${(turbulent.length/total*100).toFixed(1)}%)`);
  console.log(`  BALANCE                : ${balance.length} (${(balance.length/total*100).toFixed(1)}%)`);
  console.log(`\n  acd_daily_log updated  : ${updated} rows`);
  console.log(`  No acd_daily_log row   : ${noRow} sessions (skipped)`);

  // ── Borderline: ts within 0.05 of the 0.50 cutoff ─────────────────────────
  const borderline = labeled.filter(s => s.trend_str >= 0.45 && s.trend_str <= 0.55);
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  BORDERLINE CASES (ts 0.45–0.55)   n=${borderline.length}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Date       |  ts   | range | net_disp | outside_ib | cp   | label');
  console.log('  -----------+-------+-------+----------+------------+------+----------');
  for (const s of borderline.sort((a, b) => a.trend_str - b.trend_str)) {
    const netDisp = Math.round(Math.abs(s.sess_close - s.sess_open));
    console.log(
      `  ${s.trade_date} | ${s.trend_str.toFixed(3)} | ${String(Math.round(s.sess_range)).padStart(5)} | ${String(netDisp + 'pts').padStart(8)} |` +
      `     ${s.close_outside_ib ? 'YES' : ' NO'}      | ${s.close_pct.toFixed(2)} | ${s.day_type}`
    );
  }

  // ── Top 5 highest-ts TURBULENT ─────────────────────────────────────────────
  const topTurbulent = [...turbulent].sort((a, b) => b.trend_str - a.trend_str).slice(0, 5);
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  TOP 5 HIGHEST-ts TURBULENT');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Date       |  ts   |  rr   |  cp   |  open   |  high   |  low    |  close');
  console.log('  -----------+-------+-------+-------+---------+---------+---------+--------');
  for (const s of topTurbulent) {
    console.log(
      `  ${s.trade_date} | ${s.trend_str.toFixed(3)} | ${s.range_ratio.toFixed(2)} | ${s.close_pct.toFixed(2)} |` +
      ` ${Math.round(s.sess_open)} | ${Math.round(s.sess_high)} | ${Math.round(s.sess_low)} | ${Math.round(s.sess_close)}`
    );
  }

  // ── Bottom 5 lowest-ts TREND ───────────────────────────────────────────────
  const bottomTrend = [...trend].sort((a, b) => a.trend_str - b.trend_str).slice(0, 5);
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  BOTTOM 5 LOWEST-ts TREND');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Date       |  ts   |  rr   |  cp   |  open   |  high   |  low    |  close');
  console.log('  -----------+-------+-------+-------+---------+---------+---------+--------');
  for (const s of bottomTrend) {
    console.log(
      `  ${s.trade_date} | ${s.trend_str.toFixed(3)} | ${s.range_ratio.toFixed(2)} | ${s.close_pct.toFixed(2)} |` +
      ` ${Math.round(s.sess_open)} | ${Math.round(s.sess_high)} | ${Math.round(s.sess_low)} | ${Math.round(s.sess_close)}`
    );
  }

  console.log('\n[derive_day_types] Done.\n');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
