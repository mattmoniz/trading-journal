import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';

const LEVELS = ['3M_VAL', '3M_POC', 'WS1', 'PM_POC', 'PM_HIGH', 'DAILY_OPEN'];
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

  const results = {}; 
  for (const name of LEVELS) {
    results[`${name}_LONG_RTH`] = []; results[`${name}_LONG_WIDE`] = [];
    results[`${name}_SHORT_RTH`] = []; results[`${name}_SHORT_WIDE`] = [];
  }

  for (const d of dates) {
    const lv = levelsByDate.get(d);
    if (!lv) continue;
    const startIdx = firstIdxAtOrAfter(d, RTH_START);
    if (startIdx < 0 || startIdx === 0) continue;
    
    let rthEndIdx = allBars.length;
    for (let i = startIdx; i < allBars.length; i++) {
      if (allBars[i].d > d || (allBars[i].d === d && allBars[i].tod >= RTH_END)) { rthEndIdx = i; break; }
    }
    
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
      
      // For DAILY_OPEN, WIDE window must not start before RTH_START
      let currentWideStartIdx = wideStartIdx;
      if (name === 'DAILY_OPEN') {
        currentWideStartIdx = startIdx;
      }
      
      for (const [windowName, scanStartIdx, endIdx] of [['RTH', startIdx, rthEndIdx], ['WIDE', currentWideStartIdx, wideEndIdx]]) {
        let fired = false;
        for (let i = Math.max(scanStartIdx, 1) + 1; i < endIdx && !fired; i++) {
          const b = allBars[i], prev = allBars[i - 1];
          if (Math.abs(b.close - lvl) > 15) continue;
          const fromAbove = prev.close > lvl;
          const dir = fromAbove ? 'SHORT' : 'LONG';
          const entry = b.close;
          
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
