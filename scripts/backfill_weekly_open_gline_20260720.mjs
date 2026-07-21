// Backfills WEEKLY_OPEN in level_prices with the corrected "G-Line" definition
// (first Globex bar at/after Sunday 6PM ET, not the old Monday-9:30am-RTH-open
// this used to compute) -- see scripts/compute_levels.js's weekOpenR query, fixed
// 2026-07-20, and docs/OPEN_THREADS.md for the full writeup. Backup taken first:
// level_prices_weekly_open_backup_20260720 (423 rows, the pre-fix values).
//
// Computes one G-Line value per calendar week (Sunday->Friday) across the full
// available NQ price_bars_primary history, then writes that same value to every
// weekday (Mon-Fri) trade_date row for that week, matching the existing one-row-
// per-weekday granularity already established for this level_name.
//
// Run: node scripts/backfill_weekly_open_gline_20260720.mjs
import { query } from '../server/db.js';

async function main() {
  const rangeRes = await query(`SELECT MIN(ts::date) as lo, MAX(ts::date) as hi FROM price_bars_primary WHERE symbol='NQ'`);
  const { lo, hi } = rangeRes.rows[0];
  console.log(`NQ data range: ${lo} to ${hi}`);

  // Every Monday in range, computed from the earliest Monday on/after `lo`.
  // BUG FIXED (caught via spot-check before this was trusted): date_trunc('week', d)
  // in Postgres ALREADY returns that week's Monday (ISO weeks start Monday) -- an
  // earlier version of this query added "+ interval '1 day'" on top of that, which
  // shifted every week's boundary forward by one day (Mon->Tue, so "sunday" below
  // became the real Monday and "friday" became the real Saturday). Confirmed via
  // direct SQL: date_trunc('week','2024-06-17'::date) = '2024-06-17' (correct,
  // already Monday) -- the +1 day made it '2024-06-18'. No +1 day needed.
  const mondaysRes = await query(`
    SELECT DISTINCT date_trunc('week', ts::date)::date::text as monday
    FROM price_bars_primary WHERE symbol='NQ'
    ORDER BY monday
  `);
  const mondays = mondaysRes.rows.map(r => r.monday);
  console.log(`${mondays.length} distinct weeks to process.`);

  let written = 0, noData = 0, skippedFutureOrPartial = 0;
  for (const mondayStr of mondays) {
    const monday = new Date(mondayStr + 'T12:00:00Z');
    const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() - 1);
    const friday = new Date(monday); friday.setUTCDate(monday.getUTCDate() + 4);
    const sunStr = sunday.toISOString().slice(0, 10);
    const friStr = friday.toISOString().slice(0, 10);

    const gLineRes = await query(`
      SELECT open::float AS o FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts::date BETWEEN $1 AND $2
        AND EXTRACT(hour FROM ts) >= 18
      ORDER BY ts LIMIT 1
    `, [sunStr, friStr]);
    const gLine = gLineRes.rows[0]?.o;
    if (gLine == null) { noData++; continue; }

    // Write to each weekday (Mon-Fri) that actually has SOME price_bars_primary
    // data that week -- skip weekdays with zero bars (holiday closures) rather
    // than writing a WEEKLY_OPEN row for a day that never traded.
    for (let d = 0; d < 5; d++) {
      const day = new Date(monday); day.setUTCDate(monday.getUTCDate() + d);
      const dayStr = day.toISOString().slice(0, 10);
      const hasData = await query(`SELECT 1 FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 LIMIT 1`, [dayStr]);
      if (!hasData.rows[0]) { skippedFutureOrPartial++; continue; }
      await query(`
        INSERT INTO level_prices (trade_date, level_name, price, category, computed_at)
        VALUES ($1, 'WEEKLY_OPEN', $2, 'OPENS', NOW())
        ON CONFLICT (trade_date, level_name) DO UPDATE SET price=$2, computed_at=NOW()
      `, [dayStr, gLine]);
      written++;
    }
  }
  console.log(`Done. ${written} weekday rows written/updated, ${noData} weeks had no Sunday-evening bar, ${skippedFutureOrPartial} weekdays skipped (no trading data that day).`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
