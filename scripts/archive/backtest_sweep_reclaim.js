// backtest_sweep_reclaim.js
// ──────────────────────────────────────────────────────────────────
// Comprehensive backtest: "Sweep and Reclaim" re-entry after stop-out
//
// For each trading day × key level, simulate a fade trade on first touch.
// If stopped out, check if price returns to level within 60 bars for re-entry.
// Compare first-touch vs re-entry performance.
// ──────────────────────────────────────────────────────────────────

import { query } from '../server/db.js';

const PNL_PER_POINT  = 2;
const COMMISSION     = 1;
const STOP_PTS       = 90;
const TARGET_PTS     = 40;
const PROXIMITY_PTS  = 10;      // "within 10pt" = touch
const REENTRY_WINDOW = 60;      // bars after stop-out to look for re-entry
const LOOKBACK_DAYS  = 180;

// RTH = 9:30–15:59 ET = minutes 570–959
const RTH_START = 570;
const RTH_END   = 959;

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────
function barMinute(ts) {
  const d = new Date(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes(); // ts stored as ET in UTC column
}

function fmt(n, d=1) { return n == null ? 'N/A' : Number(n).toFixed(d); }
function pct(n, d=1) { return n == null ? 'N/A' : (n * 100).toFixed(d) + '%'; }

// ──────────────────────────────────────────────────────────────────
// Fetch all required data
// ──────────────────────────────────────────────────────────────────
async function fetchData() {
  // Get last 180 trading days
  const datesRes = await query(`
    SELECT DISTINCT ts::date as trade_date
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND ${RTH_END}
    ORDER BY trade_date DESC
    LIMIT $1
  `, [LOOKBACK_DAYS]);

  const tradeDates = datesRes.rows.map(r => r.trade_date).reverse(); // oldest first
  const minDate = tradeDates[0];
  const maxDate = tradeDates[tradeDates.length - 1];

  console.log(`Date range: ${minDate} to ${maxDate} (${tradeDates.length} trading days)`);

  // Fetch all RTH bars in range (plus one day before for prior day data)
  const barsRes = await query(`
    SELECT ts, open::float, high::float, low::float, close::float, volume
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND ts::date >= ($1::date - INTERVAL '5 days')
      AND ts::date <= $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND ${RTH_END}
    ORDER BY ts
  `, [minDate, maxDate]);

  // Group bars by date
  const barsByDate = {};
  for (const b of barsRes.rows) {
    const d = new Date(b.ts).toISOString().slice(0, 10);
    if (!barsByDate[d]) barsByDate[d] = [];
    barsByDate[d].push(b);
  }

  // Fetch developing value log (prior day's VA levels)
  const vaRes = await query(`
    SELECT trade_date, poc::float, vah::float, val::float,
           session_high::float, session_low::float, session_close::float
    FROM developing_value_log
    WHERE trade_date >= ($1::date - INTERVAL '5 days') AND trade_date <= $2
    ORDER BY trade_date
  `, [minDate, maxDate]);

  const vaByDate = {};
  for (const r of vaRes.rows) vaByDate[r.trade_date] = r;

  // Fetch ACD data (OR high/low = IB in this context)
  const acdRes = await query(`
    SELECT trade_date, or_high::float, or_low::float
    FROM acd_daily_log
    WHERE trade_date >= $1 AND trade_date <= $2
    ORDER BY trade_date
  `, [minDate, maxDate]);

  const acdByDate = {};
  for (const r of acdRes.rows) acdByDate[r.trade_date] = r;

  return { tradeDates, barsByDate, vaByDate, acdByDate };
}

// ──────────────────────────────────────────────────────────────────
// Compute floor pivots from prior day's H/L/C
// ──────────────────────────────────────────────────────────────────
function floorPivots(h, l, c) {
  const pp = (h + l + c) / 3;
  return {
    FLOOR_PIVOT: Math.round(pp * 100) / 100,
    FLOOR_R1:    Math.round((2*pp - l) * 100) / 100,
    FLOOR_S1:    Math.round((2*pp - h) * 100) / 100,
  };
}

// ──────────────────────────────────────────────────────────────────
// Get IB high/low from first hour bars (minutes 570-629)
// ──────────────────────────────────────────────────────────────────
function computeIB(bars) {
  const ibBars = bars.filter(b => {
    const m = barMinute(b.ts);
    return m >= 570 && m <= 629;
  });
  if (ibBars.length === 0) return null;
  return {
    IB_HIGH: Math.max(...ibBars.map(b => b.high)),
    IB_LOW:  Math.min(...ibBars.map(b => b.low)),
  };
}

// ──────────────────────────────────────────────────────────────────
// Simulate a fade trade
// Returns { outcome, mae, mfe, barsHeld }
// direction: 'SHORT' (fading resistance) or 'LONG' (fading support)
// ──────────────────────────────────────────────────────────────────
function simulateFade(bars, entryIdx, level, direction, stopPts, targetPts) {
  const entryPrice = level; // fade entry at the level
  let mae = 0, mfe = 0;

  for (let i = entryIdx; i < bars.length; i++) {
    const bar = bars[i];
    const barsHeld = i - entryIdx;

    if (direction === 'SHORT') {
      // Short fade: stop above, target below
      const adverseExcursion = bar.high - entryPrice; // price going up is adverse
      const favorableExcursion = entryPrice - bar.low;  // price going down is favorable
      mae = Math.max(mae, adverseExcursion);
      mfe = Math.max(mfe, favorableExcursion);

      // Check stop first (conservative)
      if (bar.high >= entryPrice + stopPts) {
        return { outcome: 'STOP', pnl: -stopPts * PNL_PER_POINT - COMMISSION, mae, mfe, barsHeld };
      }
      // Check target
      if (bar.low <= entryPrice - targetPts) {
        return { outcome: 'TARGET', pnl: targetPts * PNL_PER_POINT - COMMISSION, mae, mfe, barsHeld };
      }
    } else {
      // Long fade: stop below, target above
      const adverseExcursion = entryPrice - bar.low;
      const favorableExcursion = bar.high - entryPrice;
      mae = Math.max(mae, adverseExcursion);
      mfe = Math.max(mfe, favorableExcursion);

      if (bar.low <= entryPrice - stopPts) {
        return { outcome: 'STOP', pnl: -stopPts * PNL_PER_POINT - COMMISSION, mae, mfe, barsHeld };
      }
      if (bar.high >= entryPrice + targetPts) {
        return { outcome: 'TARGET', pnl: targetPts * PNL_PER_POINT - COMMISSION, mae, mfe, barsHeld };
      }
    }
  }

  // Session ended without resolution — mark as EOD exit
  const lastBar = bars[bars.length - 1];
  const exitPrice = lastBar.close;
  const rawPnl = direction === 'SHORT'
    ? (entryPrice - exitPrice) * PNL_PER_POINT - COMMISSION
    : (exitPrice - entryPrice) * PNL_PER_POINT - COMMISSION;
  return { outcome: 'EOD', pnl: rawPnl, mae, mfe, barsHeld: bars.length - entryIdx };
}

// ──────────────────────────────────────────────────────────────────
// Detect first touch of a level
// Returns the bar index where price first comes within PROXIMITY_PTS
// ──────────────────────────────────────────────────────────────────
function findFirstTouch(bars, level, direction, startIdx = 0) {
  for (let i = startIdx; i < bars.length; i++) {
    const bar = bars[i];
    if (direction === 'SHORT') {
      // Fading resistance: price must come UP to the level
      if (bar.high >= level - PROXIMITY_PTS) return i;
    } else {
      // Fading support: price must come DOWN to the level
      if (bar.low <= level + PROXIMITY_PTS) return i;
    }
  }
  return -1;
}

// ──────────────────────────────────────────────────────────────────
// After a stop-out, find re-entry: price returning to within PROXIMITY_PTS of the level
// ──────────────────────────────────────────────────────────────────
function findReentry(bars, stopOutIdx, level, direction, window) {
  const endIdx = Math.min(stopOutIdx + window, bars.length);

  // After stop-out, price must first move AWAY then come BACK
  // (We just look for price returning to the level within the window)
  for (let i = stopOutIdx + 1; i < endIdx; i++) {
    const bar = bars[i];
    if (direction === 'SHORT') {
      // Price went above (stop-out), now must come BACK DOWN near the level
      // The level is resistance. Price blew through up. Now it needs to come back down near level.
      if (bar.low <= level + PROXIMITY_PTS && bar.high >= level - PROXIMITY_PTS) {
        return { idx: i, barsToReturn: i - stopOutIdx };
      }
    } else {
      // Price went below (stop-out), now must come BACK UP near the level
      if (bar.high >= level - PROXIMITY_PTS && bar.low <= level + PROXIMITY_PTS) {
        return { idx: i, barsToReturn: i - stopOutIdx };
      }
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Track how deep the stop-out was (max adverse excursion beyond stop)
// ──────────────────────────────────────────────────────────────────
function measureSweepDepth(bars, stopOutIdx, level, direction, window) {
  const endIdx = Math.min(stopOutIdx + window, bars.length);
  let maxBeyond = 0;

  for (let i = stopOutIdx; i < endIdx; i++) {
    const bar = bars[i];
    if (direction === 'SHORT') {
      // Price went above level + stop. How much further?
      const beyond = bar.high - (level + STOP_PTS);
      maxBeyond = Math.max(maxBeyond, beyond);
    } else {
      const beyond = (level - STOP_PTS) - bar.low;
      maxBeyond = Math.max(maxBeyond, beyond);
    }
  }
  return maxBeyond;
}

// ──────────────────────────────────────────────────────────────────
// Main analysis
// ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(80));
  console.log('SWEEP AND RECLAIM BACKTEST');
  console.log('='.repeat(80));
  console.log(`Stop: ${STOP_PTS}pt | Target: ${TARGET_PTS}pt | Proximity: ${PROXIMITY_PTS}pt | Re-entry window: ${REENTRY_WINDOW} bars`);
  console.log(`PNL/point: $${PNL_PER_POINT} | Commission: $${COMMISSION}`);
  console.log();

  const { tradeDates, barsByDate, vaByDate, acdByDate } = await fetchData();

  // Results accumulators
  const allFirstTouches = [];
  const allReentries = [];
  const reentryStopSweep = {}; // stop size -> results for optimal stop finding

  // Per-level accumulators
  const byLevel = {};

  // Time-to-reclaim tracking
  const reclaimTimes = [];

  // Sweep depth tracking
  const shallowReentries = []; // stop barely hit (sweep < 60pt beyond stop)
  const deepReentries = [];    // deep sweep (>= 60pt beyond stop)

  let daysProcessed = 0;
  let daysSkipped = 0;

  for (let di = 0; di < tradeDates.length; di++) {
    const dateStr = tradeDates[di];
    const bars = barsByDate[dateStr];
    if (!bars || bars.length < 30) { daysSkipped++; continue; }

    // Find prior trading day
    let priorDate = null;
    for (let pi = di - 1; pi >= 0; pi--) {
      const pd = tradeDates[pi];
      if (barsByDate[pd] && barsByDate[pd].length > 0) {
        priorDate = pd;
        break;
      }
    }
    // Also check dates not in our tradeDates array
    if (!priorDate) {
      // Look in barsByDate for dates before dateStr
      const allDates = Object.keys(barsByDate).sort();
      for (let i = allDates.length - 1; i >= 0; i--) {
        if (allDates[i] < dateStr && barsByDate[allDates[i]]?.length > 0) {
          priorDate = allDates[i];
          break;
        }
      }
    }

    // Build levels for this day
    const levels = [];

    // Prior day value area levels
    const pdVA = vaByDate[priorDate];
    if (pdVA) {
      if (pdVA.poc)  levels.push({ name: 'PD_POC', price: pdVA.poc, direction: null }); // direction determined by approach
      if (pdVA.vah)  levels.push({ name: 'PD_VAH', price: pdVA.vah, direction: 'SHORT' }); // resistance
      if (pdVA.val)  levels.push({ name: 'PD_VAL', price: pdVA.val, direction: 'LONG' });  // support
    }

    // Floor pivots from prior day H/L/C
    if (priorDate && barsByDate[priorDate]) {
      const priorBars = barsByDate[priorDate];
      const ph = Math.max(...priorBars.map(b => b.high));
      const pl = Math.min(...priorBars.map(b => b.low));
      const pc = priorBars[priorBars.length - 1].close;
      const pivots = floorPivots(ph, pl, pc);
      levels.push({ name: 'FLOOR_PIVOT', price: pivots.FLOOR_PIVOT, direction: null });
      levels.push({ name: 'FLOOR_R1',    price: pivots.FLOOR_R1,    direction: 'SHORT' });
      levels.push({ name: 'FLOOR_S1',    price: pivots.FLOOR_S1,    direction: 'LONG' });
    }

    // OR High/Low from acd_daily_log
    const acd = acdByDate[dateStr];
    if (acd?.or_high && acd?.or_low) {
      levels.push({ name: 'OR_HIGH', price: acd.or_high, direction: 'SHORT' });
      // OR_LOW not in the requested list, but we have it
    }

    // IB High/Low from bars
    const ib = computeIB(bars);
    if (ib) {
      levels.push({ name: 'IB_HIGH', price: ib.IB_HIGH, direction: 'SHORT' });
      levels.push({ name: 'IB_LOW',  price: ib.IB_LOW,  direction: 'LONG' });
    }

    // For each level, determine fade direction
    // POC and FLOOR_PIVOT: direction depends on where price approaches from
    for (const lvl of levels) {
      if (lvl.direction !== null) continue;

      // Determine direction from first bar: if open is below level, approach is from below (SHORT fade)
      const openPrice = bars[0].open;
      if (openPrice < lvl.price) {
        lvl.direction = 'SHORT'; // approaching from below = resistance = fade short
      } else {
        lvl.direction = 'LONG';  // approaching from above = support = fade long
      }
    }

    // For IB levels, only trade AFTER IB is established (bar index where minute >= 630)
    const ibCloseIdx = bars.findIndex(b => barMinute(b.ts) >= 630);

    // Process each level
    for (const lvl of levels) {
      const startIdx = (lvl.name === 'IB_HIGH' || lvl.name === 'IB_LOW') ? (ibCloseIdx >= 0 ? ibCloseIdx : bars.length) : 0;

      // Find first touch
      const touchIdx = findFirstTouch(bars, lvl.price, lvl.direction, startIdx);
      if (touchIdx < 0) continue; // never touched

      // Simulate fade trade
      const result = simulateFade(bars, touchIdx, lvl.price, lvl.direction, STOP_PTS, TARGET_PTS);

      const firstTouchRecord = {
        date: dateStr,
        level: lvl.name,
        price: lvl.price,
        direction: lvl.direction,
        touchBar: touchIdx,
        ...result,
      };
      allFirstTouches.push(firstTouchRecord);

      if (!byLevel[lvl.name]) byLevel[lvl.name] = { firstTouches: [], reentries: [] };
      byLevel[lvl.name].firstTouches.push(firstTouchRecord);

      // If stopped out, look for re-entry
      if (result.outcome === 'STOP') {
        const stopOutIdx = touchIdx + result.barsHeld;
        const sweepDepth = measureSweepDepth(bars, stopOutIdx, lvl.price, lvl.direction, REENTRY_WINDOW);

        const reentry = findReentry(bars, stopOutIdx, lvl.price, lvl.direction, REENTRY_WINDOW);

        if (reentry) {
          reclaimTimes.push(reentry.barsToReturn);

          // Simulate re-entry trade with standard stop/target
          const reResult = simulateFade(bars, reentry.idx, lvl.price, lvl.direction, STOP_PTS, TARGET_PTS);

          const reentryRecord = {
            date: dateStr,
            level: lvl.name,
            price: lvl.price,
            direction: lvl.direction,
            barsToReturn: reentry.barsToReturn,
            sweepDepth,
            ...reResult,
          };
          allReentries.push(reentryRecord);
          byLevel[lvl.name].reentries.push(reentryRecord);

          // Categorize by sweep depth
          if (sweepDepth < 60) {
            shallowReentries.push(reentryRecord);
          } else {
            deepReentries.push(reentryRecord);
          }

          // Sweep optimal stop sizes for re-entries
          for (let s = 30; s <= 120; s += 10) {
            const key = s;
            if (!reentryStopSweep[key]) reentryStopSweep[key] = [];
            const testResult = simulateFade(bars, reentry.idx, lvl.price, lvl.direction, s, TARGET_PTS);
            reentryStopSweep[key].push(testResult);
          }
        }
      }
    }

    daysProcessed++;
  }

  // ──────────────────────────────────────────────────────────────────
  // Analysis & Reporting
  // ──────────────────────────────────────────────────────────────────

  function stats(trades) {
    const n = trades.length;
    if (n === 0) return { n: 0, wr: 0, avgPnl: 0, totalPnl: 0, avgMAE: 0, avgMFE: 0, medMAE: 0, medMFE: 0 };
    const wins = trades.filter(t => t.outcome === 'TARGET').length;
    const stops = trades.filter(t => t.outcome === 'STOP').length;
    const eod = trades.filter(t => t.outcome === 'EOD').length;
    const wr = wins / n;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = totalPnl / n;
    const maes = trades.map(t => t.mae).sort((a,b) => a - b);
    const mfes = trades.map(t => t.mfe).sort((a,b) => a - b);
    const avgMAE = maes.reduce((s,v) => s+v, 0) / n;
    const avgMFE = mfes.reduce((s,v) => s+v, 0) / n;
    const medMAE = maes[Math.floor(n/2)];
    const medMFE = mfes[Math.floor(n/2)];
    return { n, wins, stops, eod, wr, totalPnl, avgPnl, avgMAE, avgMFE, medMAE, medMFE };
  }

  console.log(`\nProcessed ${daysProcessed} trading days, skipped ${daysSkipped}`);
  console.log(`Total first-touch trades: ${allFirstTouches.length}`);
  console.log(`Total first-touch stop-outs: ${allFirstTouches.filter(t => t.outcome === 'STOP').length}`);
  console.log(`Total re-entry opportunities: ${allReentries.length}`);

  // ── Section 1: Re-entry opportunity rate ──
  console.log('\n' + '='.repeat(80));
  console.log('1. RE-ENTRY OPPORTUNITY RATE');
  console.log('='.repeat(80));

  const firstStops = allFirstTouches.filter(t => t.outcome === 'STOP').length;
  const reentryCount = allReentries.length;
  console.log(`First-touch stop-outs:     ${firstStops}`);
  console.log(`Re-entry opportunities:    ${reentryCount}`);
  console.log(`Re-entry rate:             ${pct(firstStops > 0 ? reentryCount / firstStops : 0)}`);
  console.log(`(Of all stop-outs, ${pct(firstStops > 0 ? reentryCount / firstStops : 0)} see price return to the level within ${REENTRY_WINDOW} bars)`);

  // ── Section 2: First-touch vs Re-entry WR ──
  console.log('\n' + '='.repeat(80));
  console.log('2. FIRST TOUCH WR vs RE-ENTRY WR');
  console.log('='.repeat(80));

  const ftStats = stats(allFirstTouches);
  const reStats = stats(allReentries);

  console.log(`\n${'Metric'.padEnd(30)} ${'First Touch'.padStart(15)} ${'Re-Entry'.padStart(15)}`);
  console.log('-'.repeat(62));
  console.log(`${'N'.padEnd(30)} ${String(ftStats.n).padStart(15)} ${String(reStats.n).padStart(15)}`);
  console.log(`${'Wins'.padEnd(30)} ${String(ftStats.wins).padStart(15)} ${String(reStats.wins).padStart(15)}`);
  console.log(`${'Stops'.padEnd(30)} ${String(ftStats.stops).padStart(15)} ${String(reStats.stops).padStart(15)}`);
  console.log(`${'EOD'.padEnd(30)} ${String(ftStats.eod).padStart(15)} ${String(reStats.eod).padStart(15)}`);
  console.log(`${'Win Rate'.padEnd(30)} ${pct(ftStats.wr).padStart(15)} ${pct(reStats.wr).padStart(15)}`);
  console.log(`${'Avg PnL/trade'.padEnd(30)} ${('$'+fmt(ftStats.avgPnl,2)).padStart(15)} ${('$'+fmt(reStats.avgPnl,2)).padStart(15)}`);
  console.log(`${'Total PnL'.padEnd(30)} ${('$'+fmt(ftStats.totalPnl,2)).padStart(15)} ${('$'+fmt(reStats.totalPnl,2)).padStart(15)}`);

  // ── Section 3: MAE/MFE comparison ──
  console.log('\n' + '='.repeat(80));
  console.log('3. MAE / MFE COMPARISON');
  console.log('='.repeat(80));

  console.log(`\n${'Metric'.padEnd(30)} ${'First Touch'.padStart(15)} ${'Re-Entry'.padStart(15)}`);
  console.log('-'.repeat(62));
  console.log(`${'Avg MAE (pts)'.padEnd(30)} ${fmt(ftStats.avgMAE,1).padStart(15)} ${fmt(reStats.avgMAE,1).padStart(15)}`);
  console.log(`${'Median MAE (pts)'.padEnd(30)} ${fmt(ftStats.medMAE,1).padStart(15)} ${fmt(reStats.medMAE,1).padStart(15)}`);
  console.log(`${'Avg MFE (pts)'.padEnd(30)} ${fmt(ftStats.avgMFE,1).padStart(15)} ${fmt(reStats.avgMFE,1).padStart(15)}`);
  console.log(`${'Median MFE (pts)'.padEnd(30)} ${fmt(ftStats.medMFE,1).padStart(15)} ${fmt(reStats.medMFE,1).padStart(15)}`);

  if (reStats.avgMAE < ftStats.avgMAE) {
    console.log(`\n→ Re-entry MAE is ${fmt(ftStats.avgMAE - reStats.avgMAE)}pt TIGHTER (less adverse movement after sweep)`);
  } else {
    console.log(`\n→ Re-entry MAE is ${fmt(reStats.avgMAE - ftStats.avgMAE)}pt WIDER (more noise even after sweep)`);
  }

  // ── Section 4: Optimal re-entry stop/target ──
  console.log('\n' + '='.repeat(80));
  console.log('4. OPTIMAL RE-ENTRY STOP SIZE');
  console.log('='.repeat(80));

  console.log(`\n${'Stop(pt)'.padEnd(10)} ${'N'.padStart(6)} ${'WR'.padStart(8)} ${'AvgPnl'.padStart(10)} ${'TotalPnl'.padStart(12)} ${'AvgMAE'.padStart(10)} ${'EV/trade'.padStart(10)}`);
  console.log('-'.repeat(68));

  let bestStopEV = -Infinity, bestStopSize = 0;
  for (let s = 30; s <= 120; s += 10) {
    const trades = reentryStopSweep[s] || [];
    const st = stats(trades);
    const ev = st.avgPnl;
    if (ev > bestStopEV) { bestStopEV = ev; bestStopSize = s; }
    console.log(`${String(s).padEnd(10)} ${String(st.n).padStart(6)} ${pct(st.wr).padStart(8)} ${('$'+fmt(st.avgPnl,2)).padStart(10)} ${('$'+fmt(st.totalPnl,2)).padStart(12)} ${fmt(st.avgMAE,1).padStart(10)} ${('$'+fmt(ev,2)).padStart(10)}`);
  }
  console.log(`\n→ Best re-entry stop: ${bestStopSize}pt (EV: $${fmt(bestStopEV,2)}/trade)`);

  // ── Section 5: Per-level breakdown ──
  console.log('\n' + '='.repeat(80));
  console.log('5. PER-LEVEL BREAKDOWN');
  console.log('='.repeat(80));

  const levelNames = Object.keys(byLevel).sort();

  console.log(`\n${'Level'.padEnd(15)} ${'FT_N'.padStart(6)} ${'FT_WR'.padStart(8)} ${'FT_EV'.padStart(10)} ${'Stops'.padStart(7)} ${'RE_N'.padStart(6)} ${'RE_WR'.padStart(8)} ${'RE_EV'.padStart(10)} ${'Reclaim%'.padStart(10)}`);
  console.log('-'.repeat(82));

  for (const name of levelNames) {
    const ftS = stats(byLevel[name].firstTouches);
    const reS = stats(byLevel[name].reentries);
    const ftStops = byLevel[name].firstTouches.filter(t => t.outcome === 'STOP').length;
    const reclaimRate = ftStops > 0 ? reS.n / ftStops : 0;

    console.log(
      `${name.padEnd(15)} ${String(ftS.n).padStart(6)} ${pct(ftS.wr).padStart(8)} ${('$'+fmt(ftS.avgPnl,2)).padStart(10)}` +
      ` ${String(ftStops).padStart(7)} ${String(reS.n).padStart(6)} ${pct(reS.wr).padStart(8)} ${('$'+fmt(reS.avgPnl,2)).padStart(10)} ${pct(reclaimRate).padStart(10)}`
    );
  }

  // ── Section 6: Time to reclaim ──
  console.log('\n' + '='.repeat(80));
  console.log('6. TIME TO RECLAIM (bars after stop-out)');
  console.log('='.repeat(80));

  if (reclaimTimes.length > 0) {
    reclaimTimes.sort((a, b) => a - b);
    const avg = reclaimTimes.reduce((s, v) => s + v, 0) / reclaimTimes.length;
    const med = reclaimTimes[Math.floor(reclaimTimes.length / 2)];
    const p25 = reclaimTimes[Math.floor(reclaimTimes.length * 0.25)];
    const p75 = reclaimTimes[Math.floor(reclaimTimes.length * 0.75)];
    const p90 = reclaimTimes[Math.floor(reclaimTimes.length * 0.90)];

    console.log(`\nN = ${reclaimTimes.length} reclaims`);
    console.log(`Average:     ${fmt(avg, 1)} bars`);
    console.log(`Median:      ${med} bars`);
    console.log(`25th pctile: ${p25} bars`);
    console.log(`75th pctile: ${p75} bars`);
    console.log(`90th pctile: ${p90} bars`);
    console.log(`Min:         ${reclaimTimes[0]} bars`);
    console.log(`Max:         ${reclaimTimes[reclaimTimes.length - 1]} bars`);

    // Distribution buckets
    const buckets = [5, 10, 15, 20, 30, 45, 60];
    console.log(`\nCumulative distribution:`);
    for (const b of buckets) {
      const count = reclaimTimes.filter(t => t <= b).length;
      console.log(`  ≤${String(b).padStart(2)} bars: ${String(count).padStart(4)} (${pct(count / reclaimTimes.length)})`);
    }

    // "If not back in X bars, not coming back" analysis
    console.log(`\nReclaim probability by window size:`);
    for (const w of [10, 15, 20, 30, 45, 60]) {
      const inWindow = reclaimTimes.filter(t => t <= w).length;
      console.log(`  Within ${String(w).padStart(2)} bars: ${pct(inWindow / reclaimTimes.length)} of all reclaims have happened`);
    }
  }

  // ── Section 7: The money question ──
  console.log('\n' + '='.repeat(80));
  console.log('7. THE MONEY QUESTION — System Impact');
  console.log('='.repeat(80));

  const months = daysProcessed / 21; // ~21 trading days/month

  console.log(`\nAnalysis period: ${daysProcessed} trading days (~${fmt(months,1)} months)`);
  console.log();

  // First-touch system alone
  console.log('FIRST-TOUCH SYSTEM (existing):');
  console.log(`  Trades:       ${ftStats.n} total (${fmt(ftStats.n / months, 1)}/month)`);
  console.log(`  Win Rate:     ${pct(ftStats.wr)}`);
  console.log(`  Total PnL:    $${fmt(ftStats.totalPnl, 2)}`);
  console.log(`  PnL/month:    $${fmt(ftStats.totalPnl / months, 2)}`);
  console.log(`  EV/trade:     $${fmt(ftStats.avgPnl, 2)}`);

  console.log();
  console.log('RE-ENTRY SYSTEM (additive):');
  console.log(`  Trades:       ${reStats.n} total (${fmt(reStats.n / months, 1)}/month)`);
  console.log(`  Win Rate:     ${pct(reStats.wr)}`);
  console.log(`  Total PnL:    $${fmt(reStats.totalPnl, 2)}`);
  console.log(`  PnL/month:    $${fmt(reStats.totalPnl / months, 2)}`);
  console.log(`  EV/trade:     $${fmt(reStats.avgPnl, 2)}`);

  console.log();
  console.log('COMBINED SYSTEM:');
  const combinedPnl = ftStats.totalPnl + reStats.totalPnl;
  const combinedTrades = ftStats.n + reStats.n;
  console.log(`  Total Trades: ${combinedTrades} (${fmt(combinedTrades / months, 1)}/month)`);
  console.log(`  Total PnL:    $${fmt(combinedPnl, 2)}`);
  console.log(`  PnL/month:    $${fmt(combinedPnl / months, 2)}`);
  console.log(`  Lift from re-entries: $${fmt(reStats.totalPnl, 2)} (${pct(ftStats.totalPnl !== 0 ? reStats.totalPnl / ftStats.totalPnl : 0)} of base system)`);

  // Risk assessment
  console.log();
  console.log('RISK ASSESSMENT:');
  console.log(`  When entering re-entry, you already lost $${fmt(STOP_PTS * PNL_PER_POINT + COMMISSION, 2)} on the first touch.`);
  console.log(`  Net on successful re-entry (target hit after stop): $${fmt(TARGET_PTS * PNL_PER_POINT - COMMISSION - STOP_PTS * PNL_PER_POINT - COMMISSION, 2)}`);
  console.log(`  Net on failed re-entry (double stop): $${fmt(-2 * (STOP_PTS * PNL_PER_POINT + COMMISSION), 2)}`);

  // Re-entry only makes sense if EV > 0
  if (reStats.avgPnl > 0) {
    console.log(`\n→ RE-ENTRY HAS POSITIVE EV ($${fmt(reStats.avgPnl,2)}/trade) — worth adding to the system`);
  } else {
    console.log(`\n→ RE-ENTRY HAS NEGATIVE EV ($${fmt(reStats.avgPnl,2)}/trade) — does NOT justify the extra risk`);
  }

  // ── Section 8: Shallow vs Deep sweep ──
  console.log('\n' + '='.repeat(80));
  console.log('8. SHALLOW vs DEEP SWEEP RE-ENTRIES');
  console.log('='.repeat(80));

  const shStats = stats(shallowReentries);
  const dpStats = stats(deepReentries);

  console.log(`\n(Shallow = sweep < 60pt beyond stop | Deep = sweep >= 60pt beyond stop)`);
  console.log(`\n${'Metric'.padEnd(30)} ${'Shallow'.padStart(15)} ${'Deep'.padStart(15)}`);
  console.log('-'.repeat(62));
  console.log(`${'N'.padEnd(30)} ${String(shStats.n).padStart(15)} ${String(dpStats.n).padStart(15)}`);
  console.log(`${'Win Rate'.padEnd(30)} ${pct(shStats.wr).padStart(15)} ${pct(dpStats.wr).padStart(15)}`);
  console.log(`${'Avg PnL/trade'.padEnd(30)} ${('$'+fmt(shStats.avgPnl,2)).padStart(15)} ${('$'+fmt(dpStats.avgPnl,2)).padStart(15)}`);
  console.log(`${'Total PnL'.padEnd(30)} ${('$'+fmt(shStats.totalPnl,2)).padStart(15)} ${('$'+fmt(dpStats.totalPnl,2)).padStart(15)}`);
  console.log(`${'Avg MAE (pts)'.padEnd(30)} ${fmt(shStats.avgMAE,1).padStart(15)} ${fmt(dpStats.avgMAE,1).padStart(15)}`);
  console.log(`${'Avg MFE (pts)'.padEnd(30)} ${fmt(shStats.avgMFE,1).padStart(15)} ${fmt(dpStats.avgMFE,1).padStart(15)}`);

  // Additional sweep depth breakdown
  const depthBuckets = [
    { label: '0-20pt', min: 0, max: 20 },
    { label: '20-40pt', min: 20, max: 40 },
    { label: '40-60pt', min: 40, max: 60 },
    { label: '60-100pt', min: 60, max: 100 },
    { label: '100-150pt', min: 100, max: 150 },
    { label: '150pt+', min: 150, max: 9999 },
  ];

  console.log(`\nSweep depth breakdown:`);
  console.log(`${'Depth'.padEnd(12)} ${'N'.padStart(5)} ${'WR'.padStart(8)} ${'AvgPnl'.padStart(10)} ${'AvgMAE'.padStart(8)} ${'AvgMFE'.padStart(8)}`);
  console.log('-'.repeat(53));

  for (const bucket of depthBuckets) {
    const trades = allReentries.filter(t => t.sweepDepth >= bucket.min && t.sweepDepth < bucket.max);
    const st = stats(trades);
    if (st.n > 0) {
      console.log(`${bucket.label.padEnd(12)} ${String(st.n).padStart(5)} ${pct(st.wr).padStart(8)} ${('$'+fmt(st.avgPnl,2)).padStart(10)} ${fmt(st.avgMAE,1).padStart(8)} ${fmt(st.avgMFE,1).padStart(8)}`);
    }
  }

  // ── Summary callout ──
  console.log('\n' + '='.repeat(80));
  console.log('EXECUTIVE SUMMARY');
  console.log('='.repeat(80));

  console.log(`
KEY FINDINGS:
- First-touch system: ${ftStats.n} trades, ${pct(ftStats.wr)} WR, $${fmt(ftStats.avgPnl,2)} EV/trade
- Of ${firstStops} first-touch stop-outs, ${reentryCount} (${pct(firstStops > 0 ? reentryCount / firstStops : 0)}) got a re-entry within ${REENTRY_WINDOW} bars
- Re-entry system: ${reStats.n} trades, ${pct(reStats.wr)} WR, $${fmt(reStats.avgPnl,2)} EV/trade
- Re-entry avg MAE: ${fmt(reStats.avgMAE,1)}pt vs first-touch avg MAE: ${fmt(ftStats.avgMAE,1)}pt
- Median time to reclaim: ${reclaimTimes.length > 0 ? reclaimTimes[Math.floor(reclaimTimes.length/2)] : 'N/A'} bars
- Best re-entry stop: ${bestStopSize}pt
- Shallow sweep re-entry WR: ${pct(shStats.wr)} (N=${shStats.n}) vs Deep sweep: ${pct(dpStats.wr)} (N=${dpStats.n})
- Monthly re-entry lift: $${fmt(reStats.totalPnl / months, 2)} (${fmt(reStats.n / months, 1)} trades/month)
`);

  if (reStats.avgPnl > 0) {
    console.log('VERDICT: Sweep-and-reclaim re-entries are a POSITIVE addition to the system.');
    console.log(`Adding ~${fmt(reStats.n / months, 1)} trades/month with $${fmt(reStats.avgPnl,2)} EV each.`);
  } else {
    console.log('VERDICT: Sweep-and-reclaim re-entries have NEGATIVE EV.');
    console.log('The stop-out signals the level has failed — re-entry doubles down on a losing thesis.');
  }

  // Check if certain levels are worth re-entering even if overall is negative
  console.log('\nPer-level re-entry viability:');
  for (const name of levelNames) {
    const reS = stats(byLevel[name].reentries);
    if (reS.n >= 3) {
      const verdict = reS.avgPnl > 0 ? 'VIABLE' : 'AVOID';
      console.log(`  ${name.padEnd(15)} ${verdict} — ${reS.n} trades, ${pct(reS.wr)} WR, $${fmt(reS.avgPnl,2)} EV`);
    } else {
      console.log(`  ${name.padEnd(15)} INSUFFICIENT DATA (N=${reS.n})`);
    }
  }

  console.log('\n' + '='.repeat(80));
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
