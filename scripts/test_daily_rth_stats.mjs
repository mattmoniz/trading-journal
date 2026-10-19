// Equivalence check: daily_rth_stats vs the live view queries it replaces (getRollingATR in levelProximityService.js, getOpenGaps in caseEngine.js).
// Re-run after any change to either, and as the recheck for the table (it is wired into test_invariants.mjs by the same name).
//   node scripts/test_daily_rth_stats.mjs [datesToCheck=60]
import assert from 'node:assert/strict';
import { query } from '../server/db.js';
const N = Number(process.argv[2]) || 60;
const dates = (await query(`SELECT trade_date::text d FROM daily_rth_stats ORDER BY trade_date DESC LIMIT $1`, [N + 25])).rows.map(r => r.d).slice(0, N);
let atrMismatch = 0, gapMismatch = 0, checked = 0;
for (const d of dates) {
  // the lookup is "as of d": strictly earlier sessions only
  const old = (await query(`
    SELECT AVG(range)::float as atr, COUNT(*)::int as n FROM (
      SELECT ts::date as dd, (MAX(high) - MIN(low)) as range FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= $1::date - INTERVAL '90 days'
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      GROUP BY ts::date ORDER BY dd DESC LIMIT 20) recent`, [d])).rows[0];
  const neu = (await query(`
    SELECT AVG(rth_range)::float as atr, COUNT(*)::int as n FROM (
      SELECT rth_range FROM daily_rth_stats WHERE trade_date < $1 AND trade_date >= $1::date - INTERVAL '90 days' ORDER BY trade_date DESC LIMIT 20) recent`, [d])).rows[0];
  if (old.n !== neu.n || Math.abs((old.atr ?? 0) - (neu.atr ?? 0)) > 1e-6) { atrMismatch++; console.log('ATR mismatch', d, old, neu); }
  const oldG = (await query(`
    SELECT d, rth_low, rth_high FROM (SELECT ts::date::text as d, MIN(low)::float as rth_low, MAX(high)::float as rth_high FROM price_bars_primary
      WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959 AND ts::date < $1
      GROUP BY ts::date ORDER BY ts::date DESC LIMIT 39) sub ORDER BY d ASC`, [d])).rows;
  const newG = (await query(`
    SELECT d, rth_low, rth_high FROM (SELECT trade_date::text as d, rth_low::float as rth_low, rth_high::float as rth_high FROM daily_rth_stats
      WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 39) sub ORDER BY d ASC`, [d])).rows;
  if (JSON.stringify(oldG) !== JSON.stringify(newG)) { gapMismatch++; console.log('gap-range mismatch', d, oldG.length, newG.length); }
  checked++;
}
console.log(`checked ${checked} as-of dates: ATR mismatches=${atrMismatch}, gap-range mismatches=${gapMismatch}`);
assert.equal(atrMismatch + gapMismatch, 0);
process.exit(0);
