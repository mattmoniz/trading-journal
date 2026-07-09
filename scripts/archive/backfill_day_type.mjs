/**
 * Backfill acd_daily_log.day_type for rows where it's NULL.
 * Uses the same classifyGroundTruth formula as dayTypeReassessmentService.js
 * applied to EOD price data — this is the most accurate possible label.
 *
 * Run: node scripts/backfill_day_type.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';

function classifyGroundTruth({ range_ratio, close_pct, trend_str, close_outside_ib }) {
  if (
    (close_pct >= 0.80 || close_pct <= 0.20) &&
    trend_str >= 0.50 &&
    range_ratio >= 0.75 &&
    close_outside_ib
  ) return 'TREND';
  if (range_ratio >= 1.25) return 'TURBULENT';
  return 'BALANCE';
}

async function backfillDayType() {
  const missing = await query(`
    SELECT trade_date::text, or_high, or_low
    FROM acd_daily_log
    WHERE day_type IS NULL
    ORDER BY trade_date
  `);

  console.log(`Backfilling ${missing.rows.length} rows...`);
  let updated = 0;

  for (const row of missing.rows) {
    const { trade_date, or_high, or_low } = row;

    // Fetch RTH 1-min bars for this date (9:30–16:00 ET)
    const bars = await query(`
      SELECT
        EXTRACT(EPOCH FROM (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')
          - (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date) / 60 AS et_min,
        open, high, low, close
      FROM price_bars_primary
      WHERE (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date = $1::date
        AND EXTRACT(EPOCH FROM (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')
          - (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date) / 60 BETWEEN 570 AND 960
      ORDER BY ts
    `, [trade_date]);

    if (bars.rows.length < 10) {
      console.log(`  ${trade_date}: insufficient bars (${bars.rows.length}) — skipping`);
      continue;
    }

    const closes = bars.rows.map(b => parseFloat(b.close));
    const highs  = bars.rows.map(b => parseFloat(b.high));
    const lows   = bars.rows.map(b => parseFloat(b.low));

    const sessHigh = Math.max(...highs);
    const sessLow  = Math.min(...lows);
    const sessOpen = parseFloat(bars.rows[0].open);
    const sessClose = closes[closes.length - 1];
    const sessRange = sessHigh - sessLow;

    const ibHigh = parseFloat(or_high) || sessHigh;
    const ibLow  = parseFloat(or_low)  || sessLow;
    const ibRange = ibHigh - ibLow;

    if (ibRange <= 0 || sessRange <= 0) {
      console.log(`  ${trade_date}: zero range — skipping`);
      continue;
    }

    const range_ratio     = sessRange / ibRange;
    const close_pct       = (sessClose - sessLow) / sessRange;
    const trend_str       = Math.abs(sessClose - sessOpen) / sessRange;
    const close_outside_ib = sessClose > ibHigh || sessClose < ibLow;

    const day_type = classifyGroundTruth({ range_ratio, close_pct, trend_str, close_outside_ib });

    await query(`
      UPDATE acd_daily_log SET day_type = $1 WHERE trade_date = $2::date
    `, [day_type, trade_date]);

    console.log(`  ${trade_date}: ${day_type} (range_ratio=${range_ratio.toFixed(2)}, close_pct=${close_pct.toFixed(2)}, trend_str=${trend_str.toFixed(2)}, outside_ib=${close_outside_ib})`);
    updated++;
  }

  console.log(`Done — updated ${updated}/${missing.rows.length} rows`);
}

backfillDayType().catch(e => { console.error(e); process.exit(1); }).finally(() => pool.end());
