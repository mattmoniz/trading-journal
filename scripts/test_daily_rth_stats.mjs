// Equivalence check: daily_rth_stats vs the live view queries it replaces (getRollingATR in levelProximityService.js, getOpenGaps in caseEngine.js).
// Re-run after any change to either, and as the recheck for the table. Takes ~1.5 min (it includes a fail-soft drill that waits out the helper's 60 s cache).
//   node scripts/test_daily_rth_stats.mjs [datesToCheck=60]
import assert from 'node:assert/strict';
import { query } from '../server/db.js';
import { getRollingRthRange, getCompletedSessions } from '../server/services/dailyRthStats.js';
import { buildDailyRthStats } from './build_daily_rth_stats.mjs';
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
  const neu = await getRollingRthRange({ beforeDate: d, windowDays: 90, count: 20 });
  if (old.n !== neu.n || Math.abs((old.atr ?? 0) - (neu.atr ?? 0)) > 1e-6) { atrMismatch++; console.log('ATR mismatch', d, old, neu); }
  const oldG = (await query(`
    SELECT d, rth_low, rth_high FROM (SELECT ts::date::text as d, MIN(low)::float as rth_low, MAX(high)::float as rth_high FROM price_bars_primary
      WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959 AND ts::date < $1
      GROUP BY ts::date ORDER BY ts::date DESC LIMIT 39) sub ORDER BY d ASC`, [d])).rows;
  const newG = await getCompletedSessions({ beforeDate: d, limit: 39 });
  if (JSON.stringify(oldG) !== JSON.stringify(newG)) { gapMismatch++; console.log('gap-range mismatch', d, oldG.length, newG.length); }
  checked++;
}
// gap-fill composition used by acdCandidateBuilder (today's partial session + completed ones) vs the old single query, for today
{
  const todayET = (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;
  const oldQ = (await query(`SELECT d, rth_low, rth_high FROM (SELECT ts::date::text as d, MIN(low)::float as rth_low, MAX(high)::float as rth_high FROM price_bars_primary
    WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959 AND ts::date <= $1 GROUP BY ts::date ORDER BY ts::date DESC LIMIT 40) sub ORDER BY d ASC`, [todayET])).rows;
  const t = (await query(`SELECT MIN(low)::float lo, MAX(high)::float hi FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $1::date + 1
    AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959`, [todayET])).rows[0];
  const has = t.lo != null;
  const comp = await getCompletedSessions({ beforeDate: todayET, limit: has ? 39 : 40 });
  const newQ = has ? [...comp, { d: todayET, rth_low: t.lo, rth_high: t.hi }] : comp;
  if (JSON.stringify(oldQ) !== JSON.stringify(newQ)) { gapMismatch++; console.log('gap-fill composition mismatch for', todayET, oldQ.length, newQ.length); }
  else console.log(`gap-fill composition identical for ${todayET} (today has RTH bars: ${has}, ${newQ.length} sessions)`);
}
// fail-soft drill: remove the newest row, the helper must notice the table is behind, fall back, return the SAME answer, and repair the table
{
  const latest = (await query(`SELECT trade_date::text d FROM daily_rth_stats ORDER BY trade_date DESC LIMIT 1`)).rows[0].d;
  const before = await getCompletedSessions({ beforeDate: '2099-01-01', limit: 5 });
  await query(`DELETE FROM daily_rth_stats WHERE trade_date = $1`, [latest]);
  await new Promise(r => setTimeout(r, 61000)); // the helper caches the table's newest date for 60 s
  const during = await getCompletedSessions({ beforeDate: '2099-01-01', limit: 5 });
  if (JSON.stringify(before) !== JSON.stringify(during)) { gapMismatch++; console.log('fail-soft drill: fallback answer differs'); } else console.log('fail-soft drill: fallback returned the identical answer');
  await buildDailyRthStats({ days: 30 });
  const restored = (await query(`SELECT 1 FROM daily_rth_stats WHERE trade_date = $1`, [latest])).rowCount;
  if (!restored) { gapMismatch++; console.log('fail-soft drill: row not restored'); }
}
console.log(`checked ${checked} as-of dates: ATR mismatches=${atrMismatch}, gap-range mismatches=${gapMismatch}`);
assert.equal(atrMismatch + gapMismatch, 0);
process.exit(0);
