import { query } from '../server/db.js';
import * as ss from 'simple-statistics';
import { computeRigor, rigorContext } from '../server/services/rigorDiagnostics.js';
import fs from 'fs';

const PNL_PER_POINT = 2;
const COMMISSION    = 1;
const WINDOW_DAYS   = 180;
const LOOK_FORWARD  = 120;
const STOP_PT = 120;
const TARGET_PT = 30; // Matches ev30 convention from earlier script

async function getTradingDays() {
  const r = await query(`
    SELECT lp.trade_date::text as trade_date
    FROM level_prices lp
    WHERE lp.trade_date <= CURRENT_DATE
      AND EXISTS (
        SELECT 1 FROM price_bars_primary p
        WHERE p.ts::date = lp.trade_date
          AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) BETWEEN 570 AND 959
      )
    GROUP BY lp.trade_date
    HAVING COUNT(DISTINCT lp.level_name) >= 5
    ORDER BY lp.trade_date DESC
    LIMIT $1
  `, [WINDOW_DAYS]);
  return r.rows.map(r => r.trade_date).sort((a, b) => b.localeCompare(a)); // Descending
}

async function getLevelPrices(tradeDate) {
  const r = await query(`
    SELECT level_name, price::float FROM level_prices
    WHERE trade_date = $1 AND price IS NOT NULL
  `, [tradeDate]);
  const map = {};
  for (const row of r.rows) map[row.level_name] = row.price;
  return map;
}

async function getRTHBars(tradeDate) {
  const r = await query(`
    SELECT
      ts,
      (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod,
      open::float, high::float, low::float, close::float,
      volume::int, bid_volume::int, ask_volume::int
    FROM price_bars_primary
    WHERE ts::date = $1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) <= 960
    ORDER BY ts
  `, [tradeDate]);
  return r.rows;
}

function computeDevelopingPOC(bars, upToIdx) {
  const profile = new Map();
  for (let i = 0; i <= upToIdx; i++) {
    const b = bars[i];
    const lo = Math.floor(b.low);
    const hi = Math.ceil(b.high);
    const range = hi - lo || 1;
    const volPerLevel = b.volume / range;
    for (let p = lo; p <= hi; p++) {
      profile.set(p, (profile.get(p) || 0) + volPerLevel);
    }
  }
  let maxVol = 0, poc = 0;
  for (const [price, vol] of profile) {
    if (vol > maxVol) { maxVol = vol; poc = price; }
  }
  return poc;
}

function computeVWAP(bars, upToIdx) {
  let cumVP = 0, cumVol = 0;
  for (let i = 0; i <= upToIdx; i++) {
    const b = bars[i];
    const tp = (b.high + b.low + b.close) / 3;
    cumVP += tp * b.volume;
    cumVol += b.volume;
  }
  return cumVol > 0 ? cumVP / cumVol : 0;
}

async function main() {
  const tradingDays = await getTradingDays();
  console.log(`Found ${tradingDays.length} trading days`);

  const allTouches = [];
  const recentCutoffDate = tradingDays[Math.min(21, tradingDays.length - 1)]; // last 22 trading days (descending, so index 21)

  for (let di = 0; di < tradingDays.length; di++) {
    const date = tradingDays[di];
    const [levelPrices, bars] = await Promise.all([
      getLevelPrices(date),
      getRTHBars(date)
    ]);

    if (Object.keys(levelPrices).length < 5 || bars.length < 60) continue;

    const { RTH_VWAP: _excluded, ...staticLevels } = levelPrices;
    const touchedLevels = new Set();
    let devHigh = -Infinity, devLow = Infinity;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.mod < 570 || bar.mod > 959) continue;

      devHigh = Math.max(devHigh, bar.high);
      devLow  = Math.min(devLow, bar.low);

      const pastIB = bar.mod >= 630;
      const proximity = 15;

      const availableLevels = { ...staticLevels };
      if (!pastIB) {
        delete availableLevels.IB_HIGH;
        delete availableLevels.IB_LOW;
        delete availableLevels.IB_MID;
      }
      availableLevels.VWAP = computeVWAP(bars, i);
      if (i % 10 === 0 || i === bars.length - 1) {
        availableLevels.DEV_POC = computeDevelopingPOC(bars, i);
      }

      const nearbyLevelsHigh = [];
      const nearbyLevelsLow  = [];

      for (const [name, level] of Object.entries(availableLevels)) {
        if (level == null || !isFinite(level)) continue;
        const distToHigh = Math.abs(bar.high - level);
        const distToLow  = Math.abs(bar.low - level);
        if (distToHigh <= proximity && bar.high >= level) {
          nearbyLevelsHigh.push({ name, level, dist: distToHigh });
        }
        if (distToLow <= proximity && bar.low <= level) {
          nearbyLevelsLow.push({ name, level, dist: distToLow });
        }
      }

      if (nearbyLevelsHigh.length >= 3 && i + 1 < bars.length) {
        const primaryLevel = nearbyLevelsHigh.sort((a, b) => a.dist - b.dist)[0];
        const touchKey = `HIGH_${primaryLevel.name}`;
        if (!touchedLevels.has(touchKey)) {
          touchedLevels.add(touchKey);
          allTouches.push(createTouch(date, i, bars, 'SHORT', nearbyLevelsHigh, primaryLevel));
        }
      }

      if (nearbyLevelsLow.length >= 3 && i + 1 < bars.length) {
        const primaryLevel = nearbyLevelsLow.sort((a, b) => a.dist - b.dist)[0];
        const touchKey = `LOW_${primaryLevel.name}`;
        if (!touchedLevels.has(touchKey)) {
          touchedLevels.add(touchKey);
          allTouches.push(createTouch(date, i, bars, 'LONG', nearbyLevelsLow, primaryLevel));
        }
      }
    }
  }

  function createTouch(date, i, bars, direction, nearbyLevels, primaryLevel) {
    const entryPrice = bars[i].close;
    let mfe = 0, mae = 0;
    const maxIdx = Math.min(i + LOOK_FORWARD, bars.length - 1);
    
    for (let j = i + 1; j <= maxIdx; j++) {
      const pnl_high = direction === 'SHORT' ? entryPrice - bars[j].low : bars[j].high - entryPrice;
      const pnl_low  = direction === 'SHORT' ? entryPrice - bars[j].high : bars[j].low - entryPrice;
      mfe = Math.max(mfe, pnl_high);
      mae = Math.min(mae, pnl_low);
    }
    mae = Math.abs(mae);

    return {
      date,
      barIdx: i,
      mod: bars[i].mod,
      direction,
      entryPrice,
      primaryLevelLevel: primaryLevel.level,
      mae, mfe,
      isRecent: date >= recentCutoffDate
    };
  }

  // Dedup touches
  const deduped = [];
  const recentMap = new Map();
  for (const t of allTouches) {
    const key = `${t.date}_${t.direction}`;
    const last = recentMap.get(key);
    if (last !== undefined && Math.abs(t.barIdx - last) < 5) continue; // Deduplicate touches close to each other
    recentMap.set(key, t.barIdx);
    deduped.push(t);
  }

  // Sort deduped oldest to newest
  deduped.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.barIdx - b.barIdx;
  });

  // Evaluate memory
  for (let idx = 0; idx < deduped.length; idx++) {
    const t = deduped[idx];
    let priorTouch = null;
    
    for (let j = idx - 1; j >= 0; j--) {
      const p = deduped[j];
      if (p.date === t.date) continue; 
      
      const tDayIdx = tradingDays.indexOf(t.date);
      const pDayIdx = tradingDays.indexOf(p.date);
      if (pDayIdx - tDayIdx > 5) break; // Too old
      
      if (Math.abs(t.primaryLevelLevel - p.primaryLevelLevel) <= 25) {
        priorTouch = p;
        break;
      }
    }
    
    if (!priorTouch) {
      t.bucket = 'NO_PRIOR_TOUCH_IN_WINDOW';
    } else {
      const pIsDefended = priorTouch.mfe >= TARGET_PT && priorTouch.mae < STOP_PT;
      const pIsBroken = priorTouch.mae >= STOP_PT;
      if (pIsDefended) t.bucket = 'PRIOR_DEFENDED';
      else if (pIsBroken) t.bucket = 'PRIOR_BROKEN';
      else t.bucket = 'PRIOR_NEITHER'; 
    }
  }

  function calcStats(group) {
    let w = 0, l = 0;
    for (const t of group) {
      if (t.mfe >= TARGET_PT && t.mae < STOP_PT) w++;
      else if (t.mae >= STOP_PT) l++;
    }
    const ev = (w * (TARGET_PT * PNL_PER_POINT - COMMISSION) - l * (STOP_PT * PNL_PER_POINT + COMMISSION)) / group.length;
    
    return {
      n: group.length,
      winRate: w / group.length,
      ev,
      rigor: computeRigor(group, { dateField: 'date', pnlFn: t => (t.mfe >= TARGET_PT && t.mae < STOP_PT ? 1 : (t.mae >= STOP_PT ? -1 : 0)) })
    };
  }

  const buckets = ['PRIOR_DEFENDED', 'PRIOR_BROKEN', 'NO_PRIOR_TOUCH_IN_WINDOW'];
  
  const resultsAllTime = {};
  const resultsRecent = {};
  
  for (const b of buckets) {
    resultsAllTime[b] = calcStats(deduped.filter(t => t.bucket === b));
    resultsRecent[b] = calcStats(deduped.filter(t => t.bucket === b && t.isRecent));
  }

  const findings = {
    allTime: resultsAllTime,
    recent22: resultsRecent
  };

  fs.writeFileSync('scratch/confluence_zone_memory_findings.json', JSON.stringify(findings, null, 2));
  console.log("Findings written to scratch/confluence_zone_memory_findings.json");
  
  // Quick console report
  console.log("All-Time:");
  for (const b of buckets) console.log(`  ${b}: N=${resultsAllTime[b].n}, EV=$${(resultsAllTime[b].ev || 0).toFixed(2)}, WR=${(resultsAllTime[b].winRate || 0).toFixed(2)}`);
  
  console.log("Recent 22:");
  for (const b of buckets) console.log(`  ${b}: N=${resultsRecent[b].n}, EV=$${(resultsRecent[b].ev || 0).toFixed(2)}, WR=${(resultsRecent[b].winRate || 0).toFixed(2)}`);
}

main().catch(console.error);
