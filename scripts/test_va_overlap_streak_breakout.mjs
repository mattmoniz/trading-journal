// Market-behavior test (bar-level, not gated by which setup fired) for the user's question:
// does the prior day's (or prior few days') value area overlap streak predict TODAY resolving
// into continued balance vs a breakout? This project already has va_overlap_streak backfilled
// onto real active_setups rows (scripts/backfill_compression_metrics.mjs) but that population
// was too thin (186 real CONTINUATION trades) to resolve the question. Per this project's own
// "market behavior hypotheses go through bar-history first" convention, this tests it against
// ALL real trading days directly -- much larger N, no setup-gating, no lookahead (streak is
// built entirely from days strictly before the trade_date being classified).
//
// Reuses the exact vaOverlap()/computeProfile() logic from backfill_compression_metrics.mjs
// verbatim -- not reimplemented.
import { query } from '../server/db.js';
import { computeProfile } from '../server/services/developingValueService.js';

const RTH_START = 570, RTH_END = 960;
const TRAILING_WINDOW = 60;

function vaOverlap(a, b) {
  return a.val <= b.vah && a.vah >= b.val;
}

async function run() {
  console.log('Loading NQ RTH bars...');
  const barsQ = await query(`
    SELECT ts::date::text as d, ts,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      high::float as high, low::float as low, volume::float as volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN ${RTH_START} AND ${RTH_END - 1}
    ORDER BY ts ASC
  `);
  const barsByDay = new Map();
  for (const b of barsQ.rows) {
    if (!barsByDay.has(b.d)) barsByDay.set(b.d, []);
    barsByDay.get(b.d).push(b);
  }
  const tradingDays = [...barsByDay.keys()].sort();
  console.log(`${tradingDays.length} distinct NQ RTH trading days.`);

  console.log('Computing final value-area profile per day (reusing computeProfile())...');
  const profileByDay = new Map();
  const rangeByDay = new Map();
  for (const d of tradingDays) {
    const bars = barsByDay.get(d);
    if (bars.length < 10) continue;
    const profile = computeProfile(bars);
    if (profile) profileByDay.set(d, profile);
    const high = Math.max(...bars.map(b => b.high));
    const low = Math.min(...bars.map(b => b.low));
    rangeByDay.set(d, high - low);
  }

  // Real ground-truth day_type -- same source used for every other regime test this session.
  const dtRows = await query(`SELECT trade_date::text as trade_date, day_type FROM acd_daily_log WHERE day_type IN ('TREND','TURBULENT','BALANCE')`);
  const realDayTypes = {};
  for (const r of dtRows.rows) realDayTypes[r.trade_date] = r.day_type;

  console.log('Computing va_overlap_streak per day (no lookahead -- strictly prior days only)...');
  const streakByDay = new Map();
  for (let idx = 0; idx < tradingDays.length; idx++) {
    const d = tradingDays[idx];
    let streak = 0;
    let prev = idx - 1 >= 0 ? profileByDay.get(tradingDays[idx - 1]) : null;
    if (prev) {
      for (let back = 2; back <= TRAILING_WINDOW + 1 && idx - back >= 0; back++) {
        const cur = profileByDay.get(tradingDays[idx - back]);
        if (!cur || !vaOverlap(prev, cur)) break;
        streak++;
        prev = cur;
      }
    }
    streakByDay.set(d, streak);
  }

  // Raw-count bucketing, not a rolling percentile tercile -- the streak distribution is
  // heavily zero-inflated (median=0, ~52% of days) and discrete, so a percentile tercile
  // split collapses (confirmed: MID bucket came back N=0 on the first attempt). Bins chosen
  // from the raw distribution's own shape (0 / 1-2 / 3+), not an arbitrary a priori cutoff.
  const bucketByDay = new Map();
  for (const d of tradingDays) {
    const s = streakByDay.get(d);
    if (s == null) continue;
    let bucket;
    if (s === 0) bucket = 'NONE';
    else if (s <= 2) bucket = 'SHORT';
    else bucket = 'LONG';
    bucketByDay.set(d, bucket);
  }

  // Primary test: does the streak bucket predict real day-type?
  const BUCKETS = ['NONE', 'SHORT', 'LONG'];
  const dtCounts = { NONE: [], SHORT: [], LONG: [] };
  const rangeByBucket = { NONE: [], SHORT: [], LONG: [] };
  for (const d of tradingDays) {
    const bucket = bucketByDay.get(d);
    const rt = realDayTypes[d];
    if (!bucket) continue;
    if (rt) dtCounts[bucket].push(rt);
    const rng = rangeByDay.get(d);
    if (rng != null) rangeByBucket[bucket].push(rng);
  }

  console.log('\n--- va_overlap_streak bucket (NONE=0, SHORT=1-2, LONG=3+) vs REAL day-type ---');
  for (const b of BUCKETS) {
    const arr = dtCounts[b];
    const n = arr.length;
    if (n === 0) { console.log(`${b}: N=0`); continue; }
    const trend = arr.filter(x => x === 'TREND').length;
    const turb = arr.filter(x => x === 'TURBULENT').length;
    const bal = arr.filter(x => x === 'BALANCE').length;
    console.log(`${b.padEnd(5)}: N=${n}  TREND=${(trend/n*100).toFixed(1)}%  TURBULENT=${(turb/n*100).toFixed(1)}%  BALANCE=${(bal/n*100).toFixed(1)}%`);
  }

  console.log('\n--- va_overlap_streak bucket vs raw next-session RTH range (magnitude check) ---');
  for (const b of BUCKETS) {
    const arr = rangeByBucket[b];
    if (arr.length === 0) { console.log(`${b}: N=0`); continue; }
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    console.log(`${b.padEnd(5)}: N=${arr.length}  Mean RTH range=${mean.toFixed(2)}pts`);
  }

  // Report the raw streak distribution too, for context on what "LOW/MID/HIGH" actually means in streak-days.
  const allStreaks = [...streakByDay.values()];
  console.log('\n--- Raw streak distribution (context) ---');
  console.log('Median streak:', allStreaks.sort((a,b)=>a-b)[Math.floor(allStreaks.length/2)]);
  console.log('Max streak:', Math.max(...allStreaks));
  console.log('% of days with streak=0:', (allStreaks.filter(s=>s===0).length/allStreaks.length*100).toFixed(1)+'%');

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
