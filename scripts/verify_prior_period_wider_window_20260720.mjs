// Spot-check a handful of the 59-level "prior-period" wider-window rows (docs/
// WIDER_WINDOW_BACKTEST_20260720.md) before trusting them as a foundation for a past-year
// 24hr prop-account walkthrough. These were previously described as "more mechanically
// straightforward" than the same-day-forming levels (IB/OR) because their level VALUE
// doesn't depend on same-day formation -- but detectLevelFades() hardcodes an RTH-only bar
// filter internally regardless of level type, so the SAME reimplementation risk that
// produced a 3x/sign-flip disagreement for IB_HIGH_SHORT/IB_LOW_LONG could in principle
// apply here too. This checks whether it actually does.
//
// Picks 3 levels spanning different formation mechanisms: CAM_R1 (prior-session Camarilla
// pivot), FLOOR_PIVOT (prior-session floor pivot), PW_HIGH (rolling prior-week composite).
// Avoids 3M_* (separate documented lookahead-risk caveat, unrelated to this check).
//
// Run: node scripts/verify_prior_period_wider_window_20260720.mjs
import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';

const LEVELS = ['CAM_R1', 'FLOOR_PIVOT', 'PW_HIGH'];
const RTH_START = 570, RTH_END = 960;

async function main() {
  console.log('Loading level_prices...');
  const lvlRes = await query(`
    SELECT trade_date::text as d, level_name, price::float as price
    FROM level_prices WHERE level_name = ANY($1)
  `, [LEVELS]);
  const levelsByDate = new Map();
  for (const r of lvlRes.rows) {
    if (!levelsByDate.has(r.d)) levelsByDate.set(r.d, {});
    levelsByDate.get(r.d)[r.level_name] = r.price;
  }
  const dates = [...levelsByDate.keys()].sort();
  console.log(`${dates.length} dates with these levels.`);

  console.log('Loading ALL NQ bars (24hr)...');
  const barsRes = await query(`
    SELECT ts, ts::date::text as d,
      EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));
  console.log(`${allBars.length} total bars loaded.`);

  function firstIdxAtOrAfter(dateStr, todMin) {
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i;
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  const results = {}; // name_DIR -> { RTH: [], WIDE: [] }
  for (const name of LEVELS) {
    results[`${name}_LONG_RTH`] = []; results[`${name}_LONG_WIDE`] = [];
    results[`${name}_SHORT_RTH`] = []; results[`${name}_SHORT_WIDE`] = [];
  }

  for (const d of dates) {
    const lv = levelsByDate.get(d);
    const startIdx = firstIdxAtOrAfter(d, RTH_START);
    if (startIdx < 0 || startIdx === 0) continue;
    // RTH-only end: first bar at/after this date's RTH_END (4pm)
    let rthEndIdx = allBars.length;
    for (let i = startIdx; i < allBars.length; i++) {
      if (allBars[i].d > d || (allBars[i].d === d && allBars[i].tod >= RTH_END)) { rthEndIdx = i; break; }
    }
    // CORRECTED (2026-07-20, 2nd attempt): the "full 24-hour scan" for a prior-period level
    // (already known before today starts) extends BACKWARD into the overnight Globex session
    // leading into this RTH day (6pm the evening before), not forward past today's close --
    // confirmed by re-reading the doc's own ONH/ONL caveat ("activated it at 18:00 same as
    // other prior-period levels"). Same window end as RTH (4pm same day) -- only the start
    // moves earlier. Computed via real elapsed time (ts arithmetic), not tod/date bookkeeping,
    // to sidestep the maintenance-gap/midnight-rollover edge cases a naive tod walk would hit.
    const wideStartTs = allBars[startIdx].ts - 15.5 * 3600 * 1000;
    let wideStartIdx = 0;
    { let lo = 0, hi = allBars.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts < wideStartTs) lo = mid + 1; else hi = mid; }
      wideStartIdx = lo; }
    const wideEndIdx = rthEndIdx;

    const isMonday = new Date(d + 'T12:00:00').getDay() === 1;
    const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;

    for (const name of LEVELS) {
      const lvl = lv[name];
      if (lvl == null) continue;
      for (const [windowName, scanStartIdx, endIdx] of [['RTH', startIdx, rthEndIdx], ['WIDE', wideStartIdx, wideEndIdx]]) {
        let fired = false;
        for (let i = Math.max(scanStartIdx, 1) + 1; i < endIdx && !fired; i++) {
          const b = allBars[i], prev = allBars[i - 1];
          if (Math.abs(b.close - lvl) > 15) continue;
          const fromAbove = prev.close > lvl;
          const dir = fromAbove ? 'SHORT' : 'LONG';
          const entry = b.close;
          // Resolve to the window's own natural end (session close), not a flat 240-bar
          // (4hr) cap -- a fixed clock-time cap starves overnight-fired trades of the time
          // they actually need to resolve (overnight NQ moves slower), and doesn't match how
          // the real backtest_unified.js bounds resolution either (its `bars` array is
          // pre-sliced per day, so resolve()'s maxBars=240 default never actually matters for
          // RTH-only touches that fire with more than 4hrs of session left -- confirmed this
          // was silently letting some late-day RTH touches leak past 4pm into overnight bars
          // in this script's first version, since it passed the full global `allBars` array).
          const r = resolve(allBars, i, dir,
            entry, dir === 'LONG' ? entry - STOP : entry + STOP,
            dir === 'LONG' ? entry + TARGET : entry - TARGET, endIdx - i);
          results[`${name}_${dir}_${windowName}`].push(r);
          fired = true;
        }
      }
    }
  }

  for (const name of LEVELS) {
    for (const dir of ['LONG', 'SHORT']) {
      for (const w of ['RTH', 'WIDE']) {
        const rows = results[`${name}_${dir}_${w}`];
        const n = rows.length;
        const wins = rows.filter(r => r.result === 'TARGET_HIT').length;
        const ev = rows.reduce((s, r) => s + r.pnl, 0) / (n || 1);
        console.log(`${name}_${dir} [${w}]: N=${n} WR=${(100 * wins / (n || 1)).toFixed(1)}% EV=$${ev.toFixed(2)}`);
      }
    }
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
