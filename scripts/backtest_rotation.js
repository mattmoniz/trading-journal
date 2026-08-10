import fs from 'fs';
import { query } from '../server/db.js';
import * as ss from 'simple-statistics';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

// KNOWN LIMITATION (flagged 2026-08-10, roadmap Phase 0 order-blind sweep): the EV
// simulation below (createTouch()'s mae/mfe, joint EV check at line ~175/248) is order-blind
// -- checks mae > stop / mfe >= target against pre-aggregated scalars with no notion of
// which happened first, the same defect class fixed elsewhere (see
// scripts/backtest_rth_calibration_genuine_holdout.mjs / precomputeCrossovers() in
// update_optimal_stops.mjs). NOT rewritten here: this script is a one-off, unscheduled
// research artifact (not cron'd, doesn't write to performance_audit) whose conclusion was
// already negative ("no tradeable Floor<->Camarilla rotation edge currently exists",
// docs/OPEN_THREADS_ARCHIVE.md) -- the confound biases EV toward flattering wider stops, so
// a corrected re-run could only make an already-negative finding harder to overturn, not
// easier. Fix this properly (reuse precomputeCrossovers()) before ever re-running it for a
// live decision.
const PNL_PER_POINT = 2;
const COMMISSION = 1;
const WINDOW_DAYS = 1000; // all-time — level_prices currently starts 2023-11-16 (~416 trading days), this comfortably covers it and future data
const LOOK_FORWARD = 30;
const PROXIMITY = 15;

function pct(arr) {
  if (!arr.length) return { p25: 0, p50: 0, p75: 0, p90: 0, mean: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    p25:  ss.quantileSorted(sorted, 0.25),
    p50:  ss.quantileSorted(sorted, 0.50),
    p75:  ss.quantileSorted(sorted, 0.75),
    p90:  ss.quantileSorted(sorted, 0.90),
    mean: ss.mean(sorted),
  };
}

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
  return r.rows.map(r => r.trade_date).sort();
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
      EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
      open::float, high::float, low::float, close::float,
      volume::int, bid_volume::int, ask_volume::int
    FROM price_bars_primary
    WHERE ts::date = $1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `, [tradeDate]);
  return r.rows;
}

function getFormationGate(levelName) {
  if (['OR_HIGH', 'OR_LOW'].includes(levelName)) return 575;
  if (['IB_HIGH', 'IB_LOW', 'IB_MID', 'OR_MID', 'PD_IB_HIGH', 'PD_IB_LOW'].includes(levelName)) return 630;
  return 570; // all prior-day derived levels, WEEKLY_VWAP, etc.
}

function createTouch(name, dir, bar, barIdx, bars, date) {
  const entryPrice = bar.close;
  let mfe = 0, mae = 0;
  for (let j = barIdx + 1; j <= Math.min(barIdx + LOOK_FORWARD, bars.length - 1); j++) {
    const pnl_high = dir === 'SHORT' ? entryPrice - bars[j].low : bars[j].high - entryPrice;
    const pnl_low  = dir === 'SHORT' ? entryPrice - bars[j].high : bars[j].low - entryPrice;
    mfe = Math.max(mfe, pnl_high);
    mae = Math.min(mae, pnl_low);
  }
  mae = Math.abs(mae);
  
  const endBar = bars[Math.min(barIdx + LOOK_FORWARD, bars.length - 1)];
  const actualPnlPts = dir === 'SHORT' ? entryPrice - endBar.close : endBar.close - entryPrice;

  return {
    levelName: name,
    direction: dir,
    barIdx,
    mae,
    mfe,
    actualPnlPts
  };
}

async function run() {
  console.log('=== LEVEL ROTATION BACKTEST ===');
  
  const tradingDays = await getTradingDays();
  console.log(`Found ${tradingDays.length} trading days`);

  const touchesByLevelDir = {}; 
  const allDayTouches = {}; 

  for (let di = 0; di < tradingDays.length; di++) {
    const date = tradingDays[di];
    if (di % 30 === 0) console.log(`Processing day ${di + 1}/${tradingDays.length}: ${date}`);

    const [levelPrices, bars] = await Promise.all([
      getLevelPrices(date),
      getRTHBars(date),
    ]);

    if (Object.keys(levelPrices).length < 5 || bars.length < 60) continue;

    const dayTouches = [];
    const touchedLevels = new Map(); 

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const tod = bar.tod;

      for (const [name, level] of Object.entries(levelPrices)) {
        if (level == null || !isFinite(level)) continue;
        if (tod < getFormationGate(name)) continue;

        const distToHigh = Math.abs(bar.high - level);
        const distToLow  = Math.abs(bar.low - level);

        // check short fade (high side touch)
        if (distToHigh <= PROXIMITY && bar.high >= level) {
          const key = `${name}_SHORT`;
          const lastTouch = touchedLevels.get(key);
          if (lastTouch === undefined || i - lastTouch >= 5) {
            touchedLevels.set(key, i);
            dayTouches.push(createTouch(name, 'SHORT', bar, i, bars, date));
          }
        }
        
        // check long fade (low side touch)
        if (distToLow <= PROXIMITY && bar.low <= level) {
          const key = `${name}_LONG`;
          const lastTouch = touchedLevels.get(key);
          if (lastTouch === undefined || i - lastTouch >= 5) {
            touchedLevels.set(key, i);
            dayTouches.push(createTouch(name, 'LONG', bar, i, bars, date));
          }
        }
      }
    }
    
    // Sort day touches by barIdx
    dayTouches.sort((a, b) => a.barIdx - b.barIdx);
    allDayTouches[date] = dayTouches;
    
    // Store for unconditional baselines
    for (const t of dayTouches) {
      const key = `${t.levelName}_${t.direction}`;
      if (!touchesByLevelDir[key]) touchesByLevelDir[key] = [];
      touchesByLevelDir[key].push(t);
    }
  }

  // Compute baselines for each level (by direction)
  const baselines = {};
  for (const [levelKey, touches] of Object.entries(touchesByLevelDir)) {
    if (touches.length < 20) continue; 
    const maeP75 = Math.round(pct(touches.map(t => t.mae)).p75) || 65; 
    const mfeP50 = Math.round(pct(touches.map(t => t.mfe)).p50) || 35;
    
    let evSum = 0;
    let wins = 0;
    for (const t of touches) {
      if (t.mae > maeP75) evSum += -maeP75 * PNL_PER_POINT - COMMISSION;
      else if (t.mfe >= mfeP50) {
        evSum += mfeP50 * PNL_PER_POINT - COMMISSION;
        wins++;
      }
      else evSum += t.actualPnlPts * PNL_PER_POINT - COMMISSION;
    }
    const ev = evSum / touches.length;
    const wr = wins / touches.length;

    baselines[levelKey] = {
      n: touches.length,
      stop: maeP75,
      target: mfeP50,
      ev,
      wr,
    };
  }

  console.log(`Found unconditional baselines for ${Object.keys(baselines).length} levels.`);

  // Find rotations: A -> B
  const pairs = {}; 

  for (const [date, touches] of Object.entries(allDayTouches)) {
    for (let j = 0; j < touches.length; j++) {
      const bTouch = touches[j];
      const bKey = `${bTouch.levelName}_${bTouch.direction}`;
      if (!baselines[bKey]) continue; 

      const seenA = new Set();
      // Look back for the MOST RECENT touch of A
      for (let k = j - 1; k >= 0; k--) {
        const aTouch = touches[k];
        const aKey = `${aTouch.levelName}_${aTouch.direction}`;
        if (aTouch.levelName === bTouch.levelName) continue; 
        if (seenA.has(aKey)) continue; 

        seenA.add(aKey);
        const gap = bTouch.barIdx - aTouch.barIdx;
        if (gap <= 0) continue; 

        const pairKey = `${aKey} -> ${bKey}`;
        if (!pairs[pairKey]) pairs[pairKey] = [];
        
        pairs[pairKey].push({
          date: date,
          gap: gap,
          bTouch: bTouch,
          aTouch: aTouch
        });
      }
    }
  }

  // Evaluate conditional performance
  const results = [];
  for (const [pairKey, events] of Object.entries(pairs)) {
    if (events.length < 20) continue;

    const [aKey, bKey] = pairKey.split(' -> ');
    const base = baselines[bKey];
    const aLevel = aKey.substring(0, aKey.lastIndexOf('_'));
    const bLevel = bKey.substring(0, bKey.lastIndexOf('_'));
    const stop = base.stop;
    const target = base.target;

    let evSum = 0;
    let wins = 0;
    let sumGap = 0;

    for (const e of events) {
      const t = e.bTouch;
      if (t.mae > stop) evSum += -stop * PNL_PER_POINT - COMMISSION;
      else if (t.mfe >= target) {
        evSum += target * PNL_PER_POINT - COMMISSION;
        wins++;
      }
      else evSum += t.actualPnlPts * PNL_PER_POINT - COMMISSION;
      sumGap += e.gap;
    }

    const condEV = evSum / events.length;
    const condWR = wins / events.length;
    const avgGap = sumGap / events.length;
    const deltaEV = condEV - base.ev;

    const rigor = computeRigor(events, {
      dateField: 'date',
      pnlFn: (e) => {
        const t = e.bTouch;
        if (t.mae > stop) return -stop * PNL_PER_POINT - COMMISSION;
        if (t.mfe >= target) return target * PNL_PER_POINT - COMMISSION;
        return t.actualPnlPts * PNL_PER_POINT - COMMISSION;
      }
    });

    const isFloorCam2 = (aLevel.includes('FLOOR') && bLevel.includes('CAM')) || (aLevel.includes('CAM') && bLevel.includes('FLOOR'));

    results.push({
      pair: pairKey,
      aLevel,
      bLevel,
      isFloorCam: isFloorCam2,
      n: events.length,
      avgGap,
      baseWR: base.wr,
      baseEV: base.ev,
      condWR,
      condEV,
      deltaEV,
      rigor,
      stop,
      target
    });
  }

  results.sort((a, b) => b.deltaEV - a.deltaEV);

  fs.writeFileSync('scratch/level_rotation_pairs.json', JSON.stringify(results, null, 2));

  let md = '# Level Rotation Backtest Results\n\n';
  md += 'This report identifies the conditional EV edge of touching Level A before Level B, compared to the unconditional baseline EV of Level B alone.\n';
  md += 'Evaluated using joint EV simulation: B’s p75 MAE as stop, B’s p50 MFE as target.\n\n';

  // Section 1: Floor <-> Camarilla pairs
  const floorCam = results.filter(r => r.isFloorCam);
  md += '## 1. Floor <-> Camarilla Rotations\n';
  if (floorCam.length === 0) md += 'No pairs found with N>=20.\n';
  else {
    md += '| Pair (A -> B) | N | Gap | Stop/Tgt | Base EV | Cond EV | Delta | Rigor |\n';
    md += '|---|---|---|---|---|---|---|---|\n';
    for (const r of floorCam) {
      const rigStr = `${r.rigor.clean ? 'CLEAN' : (r.rigor.clustered ? 'CLUST' : 'UNSTAB')}`;
      md += `| ${r.pair} | ${r.n} | ${r.avgGap.toFixed(1)} | ${r.stop}/${r.target} | $${r.baseEV.toFixed(2)} | $${r.condEV.toFixed(2)} | **$${r.deltaEV.toFixed(2)}** | ${rigStr} (${r.rigor.top5DayPct}%, [${r.rigor.thirds?.ev1}, ${r.rigor.thirds?.ev2}, ${r.rigor.thirds?.ev3}]) |\n`;
    }
  }
  md += '\n';

  // Section 2: Top Pairs overall
  md += '## 2. Top Overall Rotations (by Delta EV)\n';
  md += '| Pair (A -> B) | N | Gap | Stop/Tgt | Base EV | Cond EV | Delta | Rigor |\n';
  md += '|---|---|---|---|---|---|---|---|\n';
  for (let i = 0; i < Math.min(results.length, 50); i++) {
    const r = results[i];
    const rigStr = `${r.rigor.clean ? 'CLEAN' : (r.rigor.clustered ? 'CLUST' : 'UNSTAB')}`;
    md += `| ${r.pair} | ${r.n} | ${r.avgGap.toFixed(1)} | ${r.stop}/${r.target} | $${r.baseEV.toFixed(2)} | $${r.condEV.toFixed(2)} | **$${r.deltaEV.toFixed(2)}** | ${rigStr} (${r.rigor.top5DayPct}%, [${r.rigor.thirds?.ev1}, ${r.rigor.thirds?.ev2}, ${r.rigor.thirds?.ev3}]) |\n`;
  }

  fs.writeFileSync('scratch/antigravity_response.md', md);
  console.log('Results written to scratch/level_rotation_pairs.json and scratch/antigravity_response.md');
  process.exit(0);
}

run().catch(console.error);
