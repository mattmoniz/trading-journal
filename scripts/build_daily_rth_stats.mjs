#!/usr/bin/env node
// Fill / refresh daily_rth_stats from price_bars_primary (symbol NQ, RTH minute-of-day 570-959). Idempotent upsert, so it doubles as the repair path:
//   node scripts/build_daily_rth_stats.mjs [--days 400]
// Runs nightly from run_daily_calibration.sh right after the price-bar refresh. A session is only written once it is complete: today counts only after
// 16:05 ET, otherwise only dates before today. One range-bounded query (no per-date loop). Re-running overwrites a row if late bars changed it.
import { query } from '../server/db.js';
export async function buildDailyRthStats({ days = 400 } = {}) {
  const r = await query(`
    WITH bounds AS (
      SELECT (CASE WHEN localtime >= TIME '16:05' THEN CURRENT_DATE + 1 ELSE CURRENT_DATE END) AS end_excl,
             (CURRENT_DATE - $1::int) AS start_incl
    ), agg AS (
      SELECT p.ts::date AS d, MAX(p.high) AS h, MIN(p.low) AS l, COUNT(*)::int AS n
      FROM price_bars_primary p, bounds b
      WHERE p.symbol = 'NQ' AND p.ts >= b.start_incl AND p.ts < b.end_excl
        AND (EXTRACT(hour FROM p.ts)*60 + EXTRACT(minute FROM p.ts)) BETWEEN 570 AND 959
      GROUP BY p.ts::date
    )
    INSERT INTO daily_rth_stats (trade_date, rth_high, rth_low, rth_range, n_bars, built_at)
    SELECT d, h, l, h - l, n, now() FROM agg
    ON CONFLICT (trade_date) DO UPDATE SET rth_high = EXCLUDED.rth_high, rth_low = EXCLUDED.rth_low, rth_range = EXCLUDED.rth_range, n_bars = EXCLUDED.n_bars, built_at = now()
    RETURNING trade_date`, [days]);
  return r.rowCount;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--days');
  const n = await buildDailyRthStats({ days: i > 0 ? Number(process.argv[i + 1]) : 400 });
  console.log(`daily_rth_stats: upserted ${n} session rows`);
  process.exit(0);
}
