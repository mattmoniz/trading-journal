// backtest_overnight_inventory.js
// ═══════════════════════════════════════════════════════════════════════
// OVERNIGHT INVENTORY vs LEVEL FADES: Does overnight inventory predict
// morning direction? Should it suppress counter-direction fades?
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION    = 1;
const FADE_STOP     = 90;
const FADE_TARGET   = 40;
const PROXIMITY     = 10;
const AM_CUTOFF_TOD = 720;  // noon ET
const WINDOW_DAYS   = 180;
const LOOKBACK_EXTRA = 10;  // just need prior day data

// ── Helpers ──
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) + '%' : 'N/A'; }
function fmt(v, d = 2) { return typeof v === 'number' ? v.toFixed(d) : String(v); }

function floorPivots(h, l, c) {
  const pivot = (h + l + c) / 3;
  return { FLOOR_PIVOT: pivot, FLOOR_R1: 2 * pivot - l, FLOOR_S1: 2 * pivot - h };
}

// ═══════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════

async function loadAllData() {
  console.log('Loading data...');

  // 1. Get trading days with all data sources
  const daysRes = await query(`
    SELECT d.trade_date::text as trade_date
    FROM developing_value_log d
    JOIN acd_daily_log a ON a.trade_date = d.trade_date
    JOIN auction_reads ar ON ar.trade_date = d.trade_date
    WHERE d.trade_date <= CURRENT_DATE
      AND EXISTS (
        SELECT 1 FROM price_bars_primary p
        WHERE p.ts::date = d.trade_date
          AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) BETWEEN 570 AND 959
        LIMIT 1
      )
    ORDER BY d.trade_date
  `);
  const allDays = daysRes.rows.map(r => r.trade_date);
  console.log(`  Total trading days with complete data: ${allDays.length}`);

  const totalNeeded = WINDOW_DAYS + LOOKBACK_EXTRA;
  const relevantDays = allDays.slice(-totalNeeded);
  const testDays = allDays.slice(-WINDOW_DAYS);
  const firstRelevantDate = relevantDays[0];
  const lastDate = relevantDays[relevantDays.length - 1];

  console.log(`  Test window: ${testDays[0]} to ${testDays[testDays.length - 1]} (${testDays.length} days)`);

  // 2. Bulk load developing_value_log
  const dvlRes = await query(`
    SELECT trade_date::text as trade_date,
           poc::float, vah::float, val::float,
           session_high::float, session_low::float, session_close::float
    FROM developing_value_log
    WHERE trade_date >= $1 AND trade_date <= $2
    ORDER BY trade_date
  `, [firstRelevantDate, lastDate]);
  const dvlByDate = new Map();
  for (const r of dvlRes.rows) dvlByDate.set(r.trade_date, r);

  // 3. Bulk load acd_daily_log (with A signal info)
  const acdRes = await query(`
    SELECT trade_date::text as trade_date,
           or_high::float, or_low::float,
           a_up_fired, a_up_time, a_down_fired, a_down_time,
           c_up_confirmed, c_down_confirmed
    FROM acd_daily_log
    WHERE trade_date >= $1 AND trade_date <= $2
    ORDER BY trade_date
  `, [firstRelevantDate, lastDate]);
  const acdByDate = new Map();
  for (const r of acdRes.rows) acdByDate.set(r.trade_date, r);

  // 4. Bulk load auction_reads
  const arRes = await query(`
    SELECT trade_date::text as trade_date,
           overnight_inventory, open_vs_prior_value
    FROM auction_reads
    WHERE trade_date >= $1 AND trade_date <= $2
    ORDER BY trade_date
  `, [firstRelevantDate, lastDate]);
  const auctionByDate = new Map();
  for (const r of arRes.rows) auctionByDate.set(r.trade_date, r);

  // 5. Bulk load RTH bars
  const barsRes = await query(`
    SELECT ts::date::text as trade_date,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
           open::float, high::float, low::float, close::float, volume::int
    FROM price_bars_primary
    WHERE ts::date >= $1 AND ts::date <= $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `, [firstRelevantDate, lastDate]);
  const barsByDate = new Map();
  for (const r of barsRes.rows) {
    if (!barsByDate.has(r.trade_date)) barsByDate.set(r.trade_date, []);
    barsByDate.get(r.trade_date).push(r);
  }

  // 6. Bulk load overnight bars for computing inventory from price data
  const onRes = await query(`
    SELECT ts::date::text as bar_date,
           EXTRACT(hour FROM ts) as hr,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
           open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE ts::date >= ($1::date - interval '3 day')::date AND ts::date <= $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 570
    ORDER BY ts
  `, [firstRelevantDate, lastDate]);
  const preOpenByDate = new Map();
  for (const r of onRes.rows) {
    if (!preOpenByDate.has(r.bar_date)) preOpenByDate.set(r.bar_date, []);
    preOpenByDate.get(r.bar_date).push(r);
  }

  const onEveRes = await query(`
    SELECT ts::date::text as bar_date,
           EXTRACT(hour FROM ts) as hr,
           open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE ts::date >= ($1::date - interval '3 day')::date AND ts::date <= $2
      AND EXTRACT(hour FROM ts) >= 18
    ORDER BY ts
  `, [firstRelevantDate, lastDate]);
  const eveningByDate = new Map();
  for (const r of onEveRes.rows) {
    if (!eveningByDate.has(r.bar_date)) eveningByDate.set(r.bar_date, []);
    eveningByDate.get(r.bar_date).push(r);
  }

  // Build overnight data per trading day
  const overnightByDate = new Map();
  for (const day of relevantDays) {
    const dt = new Date(day + 'T00:00:00');
    let onHigh = -Infinity, onLow = Infinity, found = false;
    let allONCloses = [];

    // Prior day evening bars
    for (let offset = 1; offset <= 3; offset++) {
      const priorDt = new Date(dt.getTime() - offset * 86400000);
      const priorDateStr = priorDt.toISOString().slice(0, 10);
      const eBars = eveningByDate.get(priorDateStr);
      if (eBars && eBars.length > 0) {
        for (const b of eBars) {
          onHigh = Math.max(onHigh, b.high);
          onLow = Math.min(onLow, b.low);
          allONCloses.push(b.close);
          found = true;
        }
        break;
      }
    }

    // Same day pre-open bars
    const poBars = preOpenByDate.get(day);
    if (poBars) {
      for (const b of poBars) {
        onHigh = Math.max(onHigh, b.high);
        onLow = Math.min(onLow, b.low);
        allONCloses.push(b.close);
        found = true;
      }
    }

    if (found && allONCloses.length > 0) {
      const onMid = (onHigh + onLow) / 2;
      const onLastClose = allONCloses[allONCloses.length - 1]; // last ON bar close = pre-open price
      overnightByDate.set(day, { on_high: onHigh, on_low: onLow, on_mid: onMid, on_last_close: onLastClose });
    }
  }

  console.log(`  Loaded ${dvlRes.rows.length} dvl, ${acdRes.rows.length} acd, ${arRes.rows.length} auction rows`);
  console.log(`  Loaded ${barsRes.rows.length} RTH bars, overnight data for ${overnightByDate.size} days`);

  return { allDays: relevantDays, testDays, dvlByDate, acdByDate, auctionByDate, barsByDate, overnightByDate };
}

// ═══════════════════════════════════════════════════════════════════════
// COMPUTE LEVELS FOR A DAY
// ═══════════════════════════════════════════════════════════════════════

function computeLevels(dayIdx, allDays, dvlByDate, acdByDate, barsByDate) {
  const day = allDays[dayIdx];
  const levels = {};

  // Prior day data
  let priorDvl = null;
  for (let i = dayIdx - 1; i >= 0; i--) {
    priorDvl = dvlByDate.get(allDays[i]);
    if (priorDvl) break;
  }
  if (!priorDvl) return null;

  levels.PD_POC  = priorDvl.poc;
  levels.PD_VAH  = priorDvl.vah;
  levels.PD_VAL  = priorDvl.val;

  // Floor pivots
  const pivots = floorPivots(priorDvl.session_high, priorDvl.session_low, priorDvl.session_close);
  levels.FLOOR_PIVOT = pivots.FLOOR_PIVOT;
  levels.FLOOR_R1    = pivots.FLOOR_R1;
  levels.FLOOR_S1    = pivots.FLOOR_S1;

  // Today's OR
  const todayAcd = acdByDate.get(day);
  if (todayAcd) {
    levels.OR_HIGH = todayAcd.or_high;
    levels.OR_LOW  = todayAcd.or_low;
  }

  // Prior day IB
  let priorBars = null;
  for (let i = dayIdx - 1; i >= 0; i--) {
    priorBars = barsByDate.get(allDays[i]);
    if (priorBars && priorBars.length > 0) break;
  }
  if (priorBars) {
    let ibH = -Infinity, ibL = Infinity;
    for (const b of priorBars) {
      if (b.tod >= 570 && b.tod <= 629) {
        ibH = Math.max(ibH, b.high);
        ibL = Math.min(ibL, b.low);
      }
    }
    if (ibH > -Infinity) {
      levels.PD_IB_HIGH = ibH;
      levels.PD_IB_LOW  = ibL;
    }
  }

  return levels;
}

// ═══════════════════════════════════════════════════════════════════════
// EXECUTE LEVEL FADES FOR A DAY
// ═══════════════════════════════════════════════════════════════════════

function executeFades(bars, levels, day) {
  const trades = [];
  const touchedLevels = new Set();

  // Compute IB high/low for IB-based levels
  let ibHigh = -Infinity, ibLow = Infinity;
  for (const b of bars) {
    if (b.tod >= 570 && b.tod <= 629) {
      ibHigh = Math.max(ibHigh, b.high);
      ibLow = Math.min(ibLow, b.low);
    }
  }
  if (ibHigh > -Infinity) {
    levels.IB_HIGH = ibHigh;
    levels.IB_LOW  = ibLow;
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.tod >= AM_CUTOFF_TOD) break;

    for (const [levelName, levelPrice] of Object.entries(levels)) {
      if (levelPrice == null || !isFinite(levelPrice)) continue;

      // IB levels only after IB close
      if ((levelName === 'IB_HIGH' || levelName === 'IB_LOW') && bar.tod < 630) continue;
      // OR levels only after OR close
      if ((levelName === 'OR_HIGH' || levelName === 'OR_LOW') && bar.tod < 600) continue;

      if (touchedLevels.has(levelName)) continue;

      // Check if bar touches level (within proximity)
      const touchesHigh = bar.high >= levelPrice - PROXIMITY && bar.high <= levelPrice + PROXIMITY;
      const touchesLow  = bar.low >= levelPrice - PROXIMITY && bar.low <= levelPrice + PROXIMITY;
      if (!touchesHigh && !touchesLow) continue;

      let direction;
      if (touchesHigh && bar.high >= levelPrice) {
        direction = 'SHORT';
      } else if (touchesLow && bar.low <= levelPrice) {
        direction = 'LONG';
      } else {
        continue;
      }

      touchedLevels.add(levelName);
      const entryPrice = levelPrice;

      // Resolve trade
      let result = null, exitPrice = null, mae = 0, mfe = 0;
      for (let j = i + 1; j < bars.length; j++) {
        const fb = bars[j];
        if (direction === 'SHORT') {
          mae = Math.max(mae, fb.high - entryPrice);
          mfe = Math.max(mfe, entryPrice - fb.low);
          if (fb.high - entryPrice >= FADE_STOP) {
            result = 'L'; exitPrice = entryPrice + FADE_STOP; break;
          }
          if (entryPrice - fb.low >= FADE_TARGET) {
            result = 'W'; exitPrice = entryPrice - FADE_TARGET; break;
          }
        } else {
          mae = Math.max(mae, entryPrice - fb.low);
          mfe = Math.max(mfe, fb.high - entryPrice);
          if (entryPrice - fb.low >= FADE_STOP) {
            result = 'L'; exitPrice = entryPrice - FADE_STOP; break;
          }
          if (fb.high - entryPrice >= FADE_TARGET) {
            result = 'W'; exitPrice = entryPrice + FADE_TARGET; break;
          }
        }
      }

      // Unresolved by EOD
      if (result === null) {
        const lastBar = bars[bars.length - 1];
        exitPrice = lastBar.close;
        if (direction === 'SHORT') {
          result = entryPrice - lastBar.close >= 0 ? 'W' : 'L';
        } else {
          result = lastBar.close - entryPrice >= 0 ? 'W' : 'L';
        }
      }

      let tradePnL;
      if (direction === 'SHORT') {
        tradePnL = (entryPrice - exitPrice) * PNL_PER_POINT - COMMISSION;
      } else {
        tradePnL = (exitPrice - entryPrice) * PNL_PER_POINT - COMMISSION;
      }

      trades.push({
        date: day,
        level: levelName,
        direction,
        entryPrice,
        exitPrice,
        result,
        pnl: tradePnL,
        mae, mfe,
        tod: bar.tod,
      });
    }
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════════════
// COMPUTE MORNING DIRECTION
// ═══════════════════════════════════════════════════════════════════════

function computeMorningDirection(bars) {
  // Morning = 9:30 to 12:00 (tod 570 to 719)
  const morningBars = bars.filter(b => b.tod >= 570 && b.tod < AM_CUTOFF_TOD);
  if (morningBars.length < 2) return null;

  const openPrice = morningBars[0].open;
  let highAfterOpen = -Infinity, lowAfterOpen = Infinity;
  const lastMorningClose = morningBars[morningBars.length - 1].close;

  for (const b of morningBars) {
    highAfterOpen = Math.max(highAfterOpen, b.high);
    lowAfterOpen = Math.min(lowAfterOpen, b.low);
  }

  const moveUp = highAfterOpen - openPrice;
  const moveDown = openPrice - lowAfterOpen;
  const netMove = lastMorningClose - openPrice;

  return {
    open: openPrice,
    close: lastMorningClose,
    high: highAfterOpen,
    low: lowAfterOpen,
    netMove,
    moveUp,
    moveDown,
    direction: netMove > 0 ? 'UP' : netMove < 0 ? 'DOWN' : 'FLAT',
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DETERMINE ALIGNMENT
// ═══════════════════════════════════════════════════════════════════════

function getInventoryBias(inventory) {
  if (inventory === 'SHORT_TRAPPED') return 'BULLISH';
  if (inventory === 'LONG_TRAPPED') return 'BEARISH';
  return 'NEUTRAL';
}

function getOpenValueBias(openVsValue) {
  if (openVsValue === 'ABOVE_VALUE') return 'BULLISH';
  if (openVsValue === 'BELOW_VALUE') return 'BEARISH';
  return 'NEUTRAL';
}

function isFadeAligned(fadeDirection, bias) {
  // BULLISH bias -> LONG fades are aligned, SHORT fades are against
  // BEARISH bias -> SHORT fades are aligned, LONG fades are against
  if (bias === 'BULLISH') return fadeDirection === 'LONG' ? 'ALIGNED' : 'AGAINST';
  if (bias === 'BEARISH') return fadeDirection === 'SHORT' ? 'ALIGNED' : 'AGAINST';
  return 'NEUTRAL';
}

// ═══════════════════════════════════════════════════════════════════════
// STATS HELPERS
// ═══════════════════════════════════════════════════════════════════════

function tradeStats(trades) {
  const n = trades.length;
  if (n === 0) return { n: 0, wins: 0, wr: 0, totalPnl: 0, avgPnl: 0, ev: 0 };
  const wins = trades.filter(t => t.result === 'W').length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPnl = totalPnl / n;
  const wr = wins / n;
  const ev = wr * (FADE_TARGET * PNL_PER_POINT - COMMISSION) - (1 - wr) * (FADE_STOP * PNL_PER_POINT + COMMISSION);
  return { n, wins, wr, totalPnl, avgPnl, ev };
}

function printTradeStats(label, trades) {
  const s = tradeStats(trades);
  console.log(`  ${label.padEnd(40)} N=${String(s.n).padStart(4)}  WR=${pct(s.wins, s.n).padStart(6)}  P&L=$${fmt(s.totalPnl, 0).padStart(8)}  EV=$${fmt(s.ev, 2).padStart(7)}`);
  return s;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('='.repeat(72));
  console.log('   OVERNIGHT INVENTORY vs LEVEL FADES: Comprehensive Backtest');
  console.log('='.repeat(72));
  console.log(`Parameters: ${FADE_TARGET}pt target, ${FADE_STOP}pt stop, ${PROXIMITY}pt prox`);
  console.log(`PNL/pt: $${PNL_PER_POINT}, Commission: $${COMMISSION}`);
  console.log();

  const { allDays, testDays, dvlByDate, acdByDate, auctionByDate, barsByDate, overnightByDate } = await loadAllData();
  console.log();

  // ── Day-by-day simulation ──
  const dayResults = [];

  for (let ti = 0; ti < testDays.length; ti++) {
    const day = testDays[ti];
    const dayIdx = allDays.indexOf(day);

    const bars = barsByDate.get(day);
    const auction = auctionByDate.get(day);
    const overnight = overnightByDate.get(day);
    const acd = acdByDate.get(day);

    if (!bars || bars.length < 30 || !auction) continue;

    // Compute levels
    const levels = computeLevels(dayIdx, allDays, dvlByDate, acdByDate, barsByDate);
    if (!levels) continue;

    // Execute all fades
    const trades = executeFades(bars, { ...levels }, day);

    // Morning direction
    const morning = computeMorningDirection(bars);
    if (!morning) continue;

    // Prior day close from dvl
    let priorDvl = null;
    for (let i = dayIdx - 1; i >= 0; i--) {
      priorDvl = dvlByDate.get(allDays[i]);
      if (priorDvl) break;
    }
    const priorClose = priorDvl ? priorDvl.session_close : null;

    // Compute overnight mid from bar data (for trapping depth)
    const onData = overnight;
    let computedInventory = null;
    let trappingDepth = 0;
    if (priorClose != null && onData) {
      const diff = priorClose - onData.on_mid;
      // prior close ABOVE ON mid = shorts trapped (bullish), below = longs trapped
      // Use absolute distance as trapping depth
      trappingDepth = Math.abs(diff);
      if (diff > 5) computedInventory = 'SHORT_TRAPPED';
      else if (diff < -5) computedInventory = 'LONG_TRAPPED';
      else computedInventory = 'NEUTRAL';
    }

    // Use the stored auction_reads inventory
    const storedInventory = auction.overnight_inventory;
    const openVsValue = auction.open_vs_prior_value;

    dayResults.push({
      day,
      storedInventory,
      computedInventory,
      trappingDepth,
      openVsValue,
      morning,
      trades,
      acd,
      priorClose,
      onMid: onData ? onData.on_mid : null,
    });
  }

  console.log(`Simulated ${dayResults.length} trading days with ${dayResults.reduce((s, d) => s + d.trades.length, 0)} total fade trades\n`);

  // ═══════════════════════════════════════════════════════════════════
  // PART 1: OVERNIGHT INVENTORY ACCURACY
  // ═══════════════════════════════════════════════════════════════════
  console.log('='.repeat(72));
  console.log('   PART 1: OVERNIGHT INVENTORY vs MORNING DIRECTION');
  console.log('='.repeat(72));

  const inventoryGroups = { SHORT_TRAPPED: [], LONG_TRAPPED: [], NEUTRAL: [] };
  for (const dr of dayResults) {
    const inv = dr.storedInventory;
    if (inventoryGroups[inv]) inventoryGroups[inv].push(dr);
  }

  console.log('\n  Inventory Distribution:');
  for (const [inv, days] of Object.entries(inventoryGroups)) {
    console.log(`    ${inv.padEnd(20)} ${days.length} days (${pct(days.length, dayResults.length)})`);
  }

  console.log('\n  Direction Prediction Accuracy:');

  // SHORT_TRAPPED -> expect UP morning
  const stDays = inventoryGroups.SHORT_TRAPPED;
  const stUp = stDays.filter(d => d.morning.direction === 'UP').length;
  const stDown = stDays.filter(d => d.morning.direction === 'DOWN').length;
  const stAvgMoveWithPrediction = mean(stDays.filter(d => d.morning.direction === 'UP').map(d => d.morning.netMove));
  const stAvgMoveAgainstPrediction = mean(stDays.filter(d => d.morning.direction === 'DOWN').map(d => Math.abs(d.morning.netMove)));
  console.log(`    SHORT_TRAPPED -> UP morning:   ${pct(stUp, stDays.length).padStart(6)} (${stUp}/${stDays.length})`);
  console.log(`      Avg move when correct (UP):   +${fmt(stAvgMoveWithPrediction, 1)} pts`);
  console.log(`      Avg move when wrong  (DOWN):  -${fmt(stAvgMoveAgainstPrediction, 1)} pts`);
  console.log(`      Overall avg morning move:     ${fmt(mean(stDays.map(d => d.morning.netMove)), 1)} pts`);

  // LONG_TRAPPED -> expect DOWN morning
  const ltDays = inventoryGroups.LONG_TRAPPED;
  const ltDown = ltDays.filter(d => d.morning.direction === 'DOWN').length;
  const ltUp = ltDays.filter(d => d.morning.direction === 'UP').length;
  const ltAvgMoveWithPrediction = mean(ltDays.filter(d => d.morning.direction === 'DOWN').map(d => Math.abs(d.morning.netMove)));
  const ltAvgMoveAgainstPrediction = mean(ltDays.filter(d => d.morning.direction === 'UP').map(d => d.morning.netMove));
  console.log(`\n    LONG_TRAPPED -> DOWN morning:  ${pct(ltDown, ltDays.length).padStart(6)} (${ltDown}/${ltDays.length})`);
  console.log(`      Avg move when correct (DOWN): -${fmt(ltAvgMoveWithPrediction, 1)} pts`);
  console.log(`      Avg move when wrong  (UP):    +${fmt(ltAvgMoveAgainstPrediction, 1)} pts`);
  console.log(`      Overall avg morning move:     ${fmt(mean(ltDays.map(d => d.morning.netMove)), 1)} pts`);

  // NEUTRAL
  const nDays = inventoryGroups.NEUTRAL;
  const nUp = nDays.filter(d => d.morning.direction === 'UP').length;
  const nDown = nDays.filter(d => d.morning.direction === 'DOWN').length;
  console.log(`\n    NEUTRAL:                       UP ${pct(nUp, nDays.length)} / DOWN ${pct(nDown, nDays.length)} (${nDays.length} days)`);
  console.log(`      Overall avg morning move:     ${fmt(mean(nDays.map(d => d.morning.netMove)), 1)} pts`);

  // ── Trapping depth analysis ──
  console.log('\n  Trapping Depth Breakdown (computed from price, σ of ON mid distance):');
  const allDepths = dayResults.filter(d => d.trappingDepth > 0).map(d => d.trappingDepth);
  const depthStd = std(allDepths);
  const depthMean = mean(allDepths);
  console.log(`    Mean depth: ${fmt(depthMean, 1)} pts, Std: ${fmt(depthStd, 1)} pts`);

  const depthBuckets = [
    { label: 'Shallow (< 0.5σ)', filter: d => d.trappingDepth > 0 && d.trappingDepth < depthMean + 0.5 * depthStd && d.trappingDepth <= depthMean },
    { label: 'Medium (0.5-1σ)',  filter: d => d.trappingDepth > depthMean && d.trappingDepth <= depthMean + depthStd },
    { label: 'Deep (> 1σ)',      filter: d => d.trappingDepth > depthMean + depthStd },
  ];

  for (const bucket of depthBuckets) {
    // SHORT_TRAPPED subset
    const stBucket = stDays.filter(bucket.filter);
    const stBucketCorrect = stBucket.filter(d => d.morning.direction === 'UP').length;
    const stBucketAvg = mean(stBucket.map(d => d.morning.netMove));

    // LONG_TRAPPED subset
    const ltBucket = ltDays.filter(bucket.filter);
    const ltBucketCorrect = ltBucket.filter(d => d.morning.direction === 'DOWN').length;
    const ltBucketAvg = mean(ltBucket.map(d => d.morning.netMove));

    console.log(`    ${bucket.label}:`);
    console.log(`      SHORT_TRAPPED: ${stBucket.length} days, correct ${pct(stBucketCorrect, stBucket.length)}, avg move ${fmt(stBucketAvg, 1)} pts`);
    console.log(`      LONG_TRAPPED:  ${ltBucket.length} days, correct ${pct(ltBucketCorrect, ltBucket.length)}, avg move ${fmt(ltBucketAvg, 1)} pts`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 2: OVERNIGHT x LEVEL FADES
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(72));
  console.log('   PART 2: OVERNIGHT INVENTORY x LEVEL FADES');
  console.log('='.repeat(72));

  const allTrades = dayResults.flatMap(d => {
    const bias = getInventoryBias(d.storedInventory);
    return d.trades.map(t => ({
      ...t,
      inventory: d.storedInventory,
      inventoryBias: bias,
      alignment: isFadeAligned(t.direction, bias),
      openVsValue: d.openVsValue,
      openValueBias: getOpenValueBias(d.openVsValue),
    }));
  });

  console.log(`\n  Total fade trades: ${allTrades.length}`);
  console.log(`  Overall: `);
  printTradeStats('ALL TRADES', allTrades);

  // Split by alignment
  const aligned = allTrades.filter(t => t.alignment === 'ALIGNED');
  const against = allTrades.filter(t => t.alignment === 'AGAINST');
  const neutral = allTrades.filter(t => t.alignment === 'NEUTRAL');

  console.log('\n  Split by Overnight Inventory Alignment:');
  printTradeStats('ALIGNED (fade WITH overnight)', aligned);
  printTradeStats('AGAINST (fade AGAINST overnight)', against);
  printTradeStats('NEUTRAL (inventory neutral)', neutral);

  // Per level breakdown
  console.log('\n  Per-Level Aligned vs Against:');
  console.log('  ' + '-'.repeat(90));
  console.log('  ' + 'Level'.padEnd(15) + '| ALIGNED                        | AGAINST                        | GAP');
  console.log('  ' + '-'.repeat(90));

  const levelNames = [...new Set(allTrades.map(t => t.level))].sort();
  const perLevelGaps = [];

  for (const level of levelNames) {
    const lAligned = aligned.filter(t => t.level === level);
    const lAgainst = against.filter(t => t.level === level);
    const sA = tradeStats(lAligned);
    const sG = tradeStats(lAgainst);
    const wrGap = sA.n > 0 && sG.n > 0 ? sA.wr - sG.wr : 0;
    perLevelGaps.push({ level, alignedWR: sA.wr, againstWR: sG.wr, gap: wrGap, alignedN: sA.n, againstN: sG.n, alignedPnl: sA.totalPnl, againstPnl: sG.totalPnl });
    console.log(`  ${level.padEnd(15)}| N=${String(sA.n).padStart(3)} WR=${pct(sA.wins, sA.n).padStart(6)} P&L=$${fmt(sA.totalPnl, 0).padStart(6)} | N=${String(sG.n).padStart(3)} WR=${pct(sG.wins, sG.n).padStart(6)} P&L=$${fmt(sG.totalPnl, 0).padStart(6)} | ${(wrGap * 100).toFixed(1)}%`);
  }

  console.log('  ' + '-'.repeat(90));
  perLevelGaps.sort((a, b) => b.gap - a.gap);
  console.log('\n  Biggest WR gaps (aligned - against):');
  for (const g of perLevelGaps.slice(0, 5)) {
    console.log(`    ${g.level.padEnd(15)} +${(g.gap * 100).toFixed(1)}% (aligned ${(g.alignedWR * 100).toFixed(1)}% vs against ${(g.againstWR * 100).toFixed(1)}%)`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 3: OPEN VS PRIOR VALUE
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(72));
  console.log('   PART 3: OPEN VS PRIOR VALUE');
  console.log('='.repeat(72));

  console.log('\n  Open vs Prior Value Distribution:');
  const ovpGroups = { ABOVE_VALUE: [], BELOW_VALUE: [], INSIDE_VALUE: [] };
  for (const dr of dayResults) {
    const ov = dr.openVsValue;
    if (ovpGroups[ov]) ovpGroups[ov].push(dr);
  }
  for (const [ov, days] of Object.entries(ovpGroups)) {
    const upDays = days.filter(d => d.morning.direction === 'UP').length;
    const downDays = days.filter(d => d.morning.direction === 'DOWN').length;
    console.log(`    ${ov.padEnd(20)} ${days.length} days  UP: ${pct(upDays, days.length)}  DOWN: ${pct(downDays, days.length)}  Avg move: ${fmt(mean(days.map(d => d.morning.netMove)), 1)} pts`);
  }

  // OVP alignment with fades
  console.log('\n  Open vs Value Alignment with Fades:');
  const ovpAligned = allTrades.filter(t => {
    const ovpBias = t.openValueBias;
    return isFadeAligned(t.direction, ovpBias) === 'ALIGNED';
  });
  const ovpAgainst = allTrades.filter(t => {
    const ovpBias = t.openValueBias;
    return isFadeAligned(t.direction, ovpBias) === 'AGAINST';
  });
  const ovpNeutral = allTrades.filter(t => t.openValueBias === 'NEUTRAL');

  printTradeStats('ALIGNED with open_vs_value', ovpAligned);
  printTradeStats('AGAINST open_vs_value', ovpAgainst);
  printTradeStats('NEUTRAL (inside value)', ovpNeutral);

  // Does OVP add signal beyond overnight?
  console.log('\n  Does open_vs_value add signal beyond overnight inventory?');
  // When overnight is non-neutral, does OVP agreement help?
  const nonNeutralON = allTrades.filter(t => t.inventoryBias !== 'NEUTRAL');
  const onAlignedOvpAligned = nonNeutralON.filter(t => t.alignment === 'ALIGNED' && isFadeAligned(t.direction, t.openValueBias) === 'ALIGNED');
  const onAlignedOvpAgainst = nonNeutralON.filter(t => t.alignment === 'ALIGNED' && isFadeAligned(t.direction, t.openValueBias) === 'AGAINST');
  const onAlignedOvpNeutral = nonNeutralON.filter(t => t.alignment === 'ALIGNED' && t.openValueBias === 'NEUTRAL');

  printTradeStats('ON-aligned + OVP-aligned', onAlignedOvpAligned);
  printTradeStats('ON-aligned + OVP-against', onAlignedOvpAgainst);
  printTradeStats('ON-aligned + OVP-neutral', onAlignedOvpNeutral);

  // ═══════════════════════════════════════════════════════════════════
  // PART 4: COMBINED SIGNAL
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(72));
  console.log('   PART 4: COMBINED SIGNAL (Overnight + Open vs Value)');
  console.log('='.repeat(72));

  // Both agree
  console.log('\n  When BOTH signals agree (both bullish or both bearish):');
  const bothBullish = dayResults.filter(d => getInventoryBias(d.storedInventory) === 'BULLISH' && getOpenValueBias(d.openVsValue) === 'BULLISH');
  const bothBearish = dayResults.filter(d => getInventoryBias(d.storedInventory) === 'BEARISH' && getOpenValueBias(d.openVsValue) === 'BEARISH');
  const bothAgree = [...bothBullish, ...bothBearish];

  const bothAgreeCorrect = bothAgree.filter(d => {
    const bias = getInventoryBias(d.storedInventory);
    return (bias === 'BULLISH' && d.morning.direction === 'UP') || (bias === 'BEARISH' && d.morning.direction === 'DOWN');
  }).length;
  console.log(`    Both agree: ${bothAgree.length} days, direction prediction correct: ${pct(bothAgreeCorrect, bothAgree.length)} (${bothAgreeCorrect}/${bothAgree.length})`);
  console.log(`      Both BULLISH: ${bothBullish.length} days, UP: ${pct(bothBullish.filter(d => d.morning.direction === 'UP').length, bothBullish.length)}, avg move: ${fmt(mean(bothBullish.map(d => d.morning.netMove)), 1)} pts`);
  console.log(`      Both BEARISH: ${bothBearish.length} days, DOWN: ${pct(bothBearish.filter(d => d.morning.direction === 'DOWN').length, bothBearish.length)}, avg move: ${fmt(mean(bothBearish.map(d => d.morning.netMove)), 1)} pts`);

  // Both agree -> fades
  const bothAgreeTrades = allTrades.filter(t => {
    const onBias = t.inventoryBias;
    const ovpBias = t.openValueBias;
    return (onBias === 'BULLISH' && ovpBias === 'BULLISH') || (onBias === 'BEARISH' && ovpBias === 'BEARISH');
  });
  const bothAgreeAligned = bothAgreeTrades.filter(t => t.alignment === 'ALIGNED');
  const bothAgreeAgainst = bothAgreeTrades.filter(t => t.alignment === 'AGAINST');

  console.log('\n  Fades when BOTH signals agree:');
  printTradeStats('Both-agree ALIGNED fades', bothAgreeAligned);
  printTradeStats('Both-agree AGAINST fades', bothAgreeAgainst);

  // They disagree
  const disagree = dayResults.filter(d => {
    const onBias = getInventoryBias(d.storedInventory);
    const ovpBias = getOpenValueBias(d.openVsValue);
    return onBias !== 'NEUTRAL' && ovpBias !== 'NEUTRAL' && onBias !== ovpBias;
  });
  console.log(`\n  When signals DISAGREE: ${disagree.length} days`);
  if (disagree.length > 0) {
    const disagreeUp = disagree.filter(d => d.morning.direction === 'UP').length;
    const disagreeDown = disagree.filter(d => d.morning.direction === 'DOWN').length;
    console.log(`    UP: ${pct(disagreeUp, disagree.length)}, DOWN: ${pct(disagreeDown, disagree.length)}, avg move: ${fmt(mean(disagree.map(d => d.morning.netMove)), 1)} pts`);

    // Who wins when they disagree?
    const onWins = disagree.filter(d => {
      const onBias = getInventoryBias(d.storedInventory);
      return (onBias === 'BULLISH' && d.morning.direction === 'UP') || (onBias === 'BEARISH' && d.morning.direction === 'DOWN');
    }).length;
    const ovpWins = disagree.filter(d => {
      const ovpBias = getOpenValueBias(d.openVsValue);
      return (ovpBias === 'BULLISH' && d.morning.direction === 'UP') || (ovpBias === 'BEARISH' && d.morning.direction === 'DOWN');
    }).length;
    console.log(`    Overnight inventory correct: ${pct(onWins, disagree.length)} (${onWins}/${disagree.length})`);
    console.log(`    Open vs value correct:       ${pct(ovpWins, disagree.length)} (${ovpWins}/${disagree.length})`);

    const disagreeTrades = allTrades.filter(t => {
      const onBias = t.inventoryBias;
      const ovpBias = t.openValueBias;
      return onBias !== 'NEUTRAL' && ovpBias !== 'NEUTRAL' && onBias !== ovpBias;
    });
    console.log(`    Trades on disagree days: ${disagreeTrades.length}`);
    printTradeStats('Disagree-day trades', disagreeTrades);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 5: THE MONEY QUESTION
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(72));
  console.log('   PART 5: THE MONEY QUESTION');
  console.log('='.repeat(72));

  const baseline = tradeStats(allTrades);
  console.log('\n  Baseline (all fades, no filter):');
  printTradeStats('ALL TRADES', allTrades);

  // Strategy 1: Suppress ALL counter-overnight fades
  console.log('\n  Strategy 1: SUPPRESS all fades AGAINST overnight inventory');
  const strat1Kept = allTrades.filter(t => t.alignment !== 'AGAINST');
  const strat1Skipped = allTrades.filter(t => t.alignment === 'AGAINST');
  const strat1KeptStats = tradeStats(strat1Kept);
  const strat1SkippedStats = tradeStats(strat1Skipped);
  printTradeStats('KEPT trades', strat1Kept);
  printTradeStats('SKIPPED trades (avoided)', strat1Skipped);
  console.log(`    Trades skipped: ${strat1Skipped.length}/${allTrades.length} (${pct(strat1Skipped.length, allTrades.length)})`);
  console.log(`    P&L saved from skipped losses: $${fmt(-strat1SkippedStats.totalPnl, 0)} (neg = net would have been profitable)`);
  console.log(`    System P&L change: $${fmt(baseline.totalPnl, 0)} -> $${fmt(strat1KeptStats.totalPnl, 0)} (${strat1KeptStats.totalPnl > baseline.totalPnl ? 'IMPROVED' : 'DEGRADED'})`);

  // Strategy 2: Only suppress when BOTH signals agree
  console.log('\n  Strategy 2: Suppress counter-fades ONLY when ON + OVP agree');
  const strat2Skipped = allTrades.filter(t => {
    const onBias = t.inventoryBias;
    const ovpBias = t.openValueBias;
    if (onBias === 'NEUTRAL' || ovpBias === 'NEUTRAL') return false;
    if (onBias !== ovpBias) return false; // they disagree, don't suppress
    return t.alignment === 'AGAINST';
  });
  const strat2Kept = allTrades.filter(t => !strat2Skipped.includes(t));
  const strat2KeptStats = tradeStats(strat2Kept);
  const strat2SkippedStats = tradeStats(strat2Skipped);
  printTradeStats('KEPT trades', strat2Kept);
  printTradeStats('SKIPPED trades (avoided)', strat2Skipped);
  console.log(`    Trades skipped: ${strat2Skipped.length}/${allTrades.length} (${pct(strat2Skipped.length, allTrades.length)})`);
  console.log(`    P&L saved from skipped: $${fmt(-strat2SkippedStats.totalPnl, 0)}`);
  console.log(`    System P&L change: $${fmt(baseline.totalPnl, 0)} -> $${fmt(strat2KeptStats.totalPnl, 0)} (${strat2KeptStats.totalPnl > baseline.totalPnl ? 'IMPROVED' : 'DEGRADED'})`);

  // Strategy 3: Half-size against (simulated as half PnL)
  console.log('\n  Strategy 3: HALF SIZE on counter-overnight fades');
  let strat3PnL = 0;
  for (const t of allTrades) {
    if (t.alignment === 'AGAINST') {
      strat3PnL += t.pnl * 0.5;
    } else {
      strat3PnL += t.pnl;
    }
  }
  console.log(`    System P&L change: $${fmt(baseline.totalPnl, 0)} -> $${fmt(strat3PnL, 0)} (${strat3PnL > baseline.totalPnl ? 'IMPROVED' : 'DEGRADED'})`);

  // Strategy 4: Suppress when both agree, half-size when only ON signals
  console.log('\n  Strategy 4: Suppress both-agree-against, half-size ON-only-against');
  let strat4PnL = 0;
  let strat4Skipped = 0;
  for (const t of allTrades) {
    const onBias = t.inventoryBias;
    const ovpBias = t.openValueBias;
    const bothAgreeOnDirection = onBias !== 'NEUTRAL' && ovpBias !== 'NEUTRAL' && onBias === ovpBias;

    if (bothAgreeOnDirection && t.alignment === 'AGAINST') {
      strat4Skipped++;
      // fully suppress
    } else if (t.alignment === 'AGAINST') {
      strat4PnL += t.pnl * 0.5; // half size
    } else {
      strat4PnL += t.pnl;
    }
  }
  console.log(`    Trades fully suppressed: ${strat4Skipped}`);
  console.log(`    System P&L change: $${fmt(baseline.totalPnl, 0)} -> $${fmt(strat4PnL, 0)} (${strat4PnL > baseline.totalPnl ? 'IMPROVED' : 'DEGRADED'})`);

  // ═══════════════════════════════════════════════════════════════════
  // PART 6: A SIGNAL OVERRIDE
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(72));
  console.log('   PART 6: A SIGNAL OVERRIDE');
  console.log('='.repeat(72));

  // Overnight bullish (SHORT_TRAPPED) + A Down fires
  const onBullishADown = dayResults.filter(d =>
    getInventoryBias(d.storedInventory) === 'BULLISH' && d.acd && d.acd.a_down_fired
  );
  const onBullishNoA = dayResults.filter(d =>
    getInventoryBias(d.storedInventory) === 'BULLISH' && d.acd && !d.acd.a_down_fired && !d.acd.a_up_fired
  );
  const onBullishAUp = dayResults.filter(d =>
    getInventoryBias(d.storedInventory) === 'BULLISH' && d.acd && d.acd.a_up_fired && !d.acd.a_down_fired
  );

  console.log('\n  Overnight BULLISH (SHORT_TRAPPED):');
  console.log(`    + A Down fires (contradiction):  ${onBullishADown.length} days`);
  if (onBullishADown.length > 0) {
    const upDays = onBullishADown.filter(d => d.morning.direction === 'UP').length;
    const downDays = onBullishADown.filter(d => d.morning.direction === 'DOWN').length;
    console.log(`      Morning UP: ${pct(upDays, onBullishADown.length)}, DOWN: ${pct(downDays, onBullishADown.length)}`);
    console.log(`      Avg morning move: ${fmt(mean(onBullishADown.map(d => d.morning.netMove)), 1)} pts`);
    console.log(`      -> A Down OVERRIDES overnight? ${downDays > upDays ? 'YES, A Down wins' : 'NO, overnight wins'}`);
  }

  console.log(`    + A Up fires (confirmation):     ${onBullishAUp.length} days`);
  if (onBullishAUp.length > 0) {
    const upDays = onBullishAUp.filter(d => d.morning.direction === 'UP').length;
    console.log(`      Morning UP: ${pct(upDays, onBullishAUp.length)}`);
    console.log(`      Avg morning move: ${fmt(mean(onBullishAUp.map(d => d.morning.netMove)), 1)} pts`);
  }

  console.log(`    + No A signal:                   ${onBullishNoA.length} days`);
  if (onBullishNoA.length > 0) {
    const upDays = onBullishNoA.filter(d => d.morning.direction === 'UP').length;
    console.log(`      Morning UP: ${pct(upDays, onBullishNoA.length)}`);
    console.log(`      Avg morning move: ${fmt(mean(onBullishNoA.map(d => d.morning.netMove)), 1)} pts`);
  }

  // Overnight bearish (LONG_TRAPPED) + A Up fires
  const onBearishAUp = dayResults.filter(d =>
    getInventoryBias(d.storedInventory) === 'BEARISH' && d.acd && d.acd.a_up_fired
  );
  const onBearishNoA = dayResults.filter(d =>
    getInventoryBias(d.storedInventory) === 'BEARISH' && d.acd && !d.acd.a_up_fired && !d.acd.a_down_fired
  );
  const onBearishADown = dayResults.filter(d =>
    getInventoryBias(d.storedInventory) === 'BEARISH' && d.acd && d.acd.a_down_fired && !d.acd.a_up_fired
  );

  console.log('\n  Overnight BEARISH (LONG_TRAPPED):');
  console.log(`    + A Up fires (contradiction):    ${onBearishAUp.length} days`);
  if (onBearishAUp.length > 0) {
    const downDays = onBearishAUp.filter(d => d.morning.direction === 'DOWN').length;
    const upDays = onBearishAUp.filter(d => d.morning.direction === 'UP').length;
    console.log(`      Morning DOWN: ${pct(downDays, onBearishAUp.length)}, UP: ${pct(upDays, onBearishAUp.length)}`);
    console.log(`      Avg morning move: ${fmt(mean(onBearishAUp.map(d => d.morning.netMove)), 1)} pts`);
    console.log(`      -> A Up OVERRIDES overnight? ${upDays > downDays ? 'YES, A Up wins' : 'NO, overnight wins'}`);
  }

  console.log(`    + A Down fires (confirmation):   ${onBearishADown.length} days`);
  if (onBearishADown.length > 0) {
    const downDays = onBearishADown.filter(d => d.morning.direction === 'DOWN').length;
    console.log(`      Morning DOWN: ${pct(downDays, onBearishADown.length)}`);
    console.log(`      Avg morning move: ${fmt(mean(onBearishADown.map(d => d.morning.netMove)), 1)} pts`);
  }

  console.log(`    + No A signal:                   ${onBearishNoA.length} days`);
  if (onBearishNoA.length > 0) {
    const downDays = onBearishNoA.filter(d => d.morning.direction === 'DOWN').length;
    console.log(`      Morning DOWN: ${pct(downDays, onBearishNoA.length)}`);
    console.log(`      Avg morning move: ${fmt(mean(onBearishNoA.map(d => d.morning.netMove)), 1)} pts`);
  }

  // Strategy 5: Follow overnight pre-A, follow ACD post-A
  // To simulate: trades before A time use ON inventory; trades after A time use ACD direction
  console.log('\n  Strategy 5: Follow overnight pre-A, follow ACD post-A');
  console.log('  (Suppress counter-direction fades based on which signal is active)');

  // For each trade, determine if it happened before or after A signal fired
  let strat5PnL = 0;
  let strat5Skipped = 0;
  let strat5Kept = 0;

  for (const dr of dayResults) {
    const onBias = getInventoryBias(dr.storedInventory);
    const acd = dr.acd;

    // Determine A-signal time in tod (minutes since midnight)
    let aTime = null;
    let aDirection = null;
    if (acd) {
      if (acd.a_up_fired && acd.a_up_time) {
        const parts = acd.a_up_time.split(':');
        aTime = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        aDirection = 'BULLISH';
      }
      if (acd.a_down_fired && acd.a_down_time) {
        const parts = acd.a_down_time.split(':');
        const downTime = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        // If both fired, use whichever fired first
        if (aTime == null || downTime < aTime) {
          aTime = downTime;
          aDirection = 'BEARISH';
        }
      }
      // If time not available but A fired, assume IB close (630 = 10:30)
      if (aTime == null) {
        if (acd.a_up_fired) { aTime = 630; aDirection = 'BULLISH'; }
        else if (acd.a_down_fired) { aTime = 630; aDirection = 'BEARISH'; }
      }
    }

    for (const t of dr.trades) {
      let activeBias;
      if (aTime != null && t.tod >= aTime) {
        // Post-A: use ACD direction
        activeBias = aDirection;
      } else {
        // Pre-A (or no A signal): use overnight
        activeBias = onBias;
      }

      const fadeAlignment = isFadeAligned(t.direction, activeBias);
      if (fadeAlignment === 'AGAINST') {
        strat5Skipped++;
        // suppress
      } else {
        strat5PnL += t.pnl;
        strat5Kept++;
      }
    }
  }
  console.log(`    Kept: ${strat5Kept}, Skipped: ${strat5Skipped}`);
  console.log(`    System P&L: $${fmt(baseline.totalPnl, 0)} -> $${fmt(strat5PnL, 0)} (${strat5PnL > baseline.totalPnl ? 'IMPROVED' : 'DEGRADED'})`);

  // Strategy 6: Same but only suppress when both agree (before A), and after A defer to ACD
  console.log('\n  Strategy 6: Suppress both-agree-against pre-A, defer to ACD post-A');
  let strat6PnL = 0;
  let strat6Skipped = 0;

  for (const dr of dayResults) {
    const onBias = getInventoryBias(dr.storedInventory);
    const ovpBias = getOpenValueBias(dr.openVsValue);
    const acd = dr.acd;

    let aTime = null;
    let aDirection = null;
    if (acd) {
      if (acd.a_up_fired && acd.a_up_time) {
        const parts = acd.a_up_time.split(':');
        aTime = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        aDirection = 'BULLISH';
      }
      if (acd.a_down_fired && acd.a_down_time) {
        const parts = acd.a_down_time.split(':');
        const downTime = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        if (aTime == null || downTime < aTime) {
          aTime = downTime;
          aDirection = 'BEARISH';
        }
      }
      if (aTime == null) {
        if (acd.a_up_fired) { aTime = 630; aDirection = 'BULLISH'; }
        else if (acd.a_down_fired) { aTime = 630; aDirection = 'BEARISH'; }
      }
    }

    for (const t of dr.trades) {
      let suppress = false;

      if (aTime != null && t.tod >= aTime) {
        // Post-A: suppress counter-ACD
        const fadeVsACD = isFadeAligned(t.direction, aDirection);
        if (fadeVsACD === 'AGAINST') suppress = true;
      } else {
        // Pre-A: suppress only if BOTH agree
        if (onBias !== 'NEUTRAL' && ovpBias !== 'NEUTRAL' && onBias === ovpBias) {
          const fadeVsConsensus = isFadeAligned(t.direction, onBias);
          if (fadeVsConsensus === 'AGAINST') suppress = true;
        }
      }

      if (suppress) {
        strat6Skipped++;
      } else {
        strat6PnL += t.pnl;
      }
    }
  }
  console.log(`    Skipped: ${strat6Skipped}`);
  console.log(`    System P&L: $${fmt(baseline.totalPnl, 0)} -> $${fmt(strat6PnL, 0)} (${strat6PnL > baseline.totalPnl ? 'IMPROVED' : 'DEGRADED'})`);

  // ═══════════════════════════════════════════════════════════════════
  // PART 7: PRACTICAL RECOMMENDATION
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(72));
  console.log('   PART 7: PRACTICAL RECOMMENDATION');
  console.log('='.repeat(72));

  // Compile all strategies
  const strategies = [
    { name: 'Baseline (no filter)', pnl: baseline.totalPnl, trades: allTrades.length },
    { name: 'S1: Suppress all counter-ON', pnl: strat1KeptStats.totalPnl, trades: strat1Kept.length },
    { name: 'S2: Suppress both-agree-against only', pnl: strat2KeptStats.totalPnl, trades: strat2Kept.length },
    { name: 'S3: Half-size counter-ON', pnl: strat3PnL, trades: allTrades.length },
    { name: 'S4: Suppress both-agree + half ON-only', pnl: strat4PnL, trades: allTrades.length - strat4Skipped },
    { name: 'S5: ON pre-A, ACD post-A (suppress)', pnl: strat5PnL, trades: strat5Kept },
    { name: 'S6: Both-agree pre-A + ACD post-A', pnl: strat6PnL, trades: allTrades.length - strat6Skipped },
  ];

  strategies.sort((a, b) => b.pnl - a.pnl);

  console.log('\n  Strategy Comparison (ranked by P&L):');
  console.log('  ' + '-'.repeat(75));
  for (const s of strategies) {
    const delta = s.pnl - baseline.totalPnl;
    const deltaStr = delta >= 0 ? `+$${fmt(delta, 0)}` : `-$${fmt(Math.abs(delta), 0)}`;
    console.log(`    ${s.name.padEnd(45)} P&L=$${fmt(s.pnl, 0).padStart(8)}  Trades=${String(s.trades).padStart(4)}  Delta=${deltaStr}`);
  }
  console.log('  ' + '-'.repeat(75));

  const best = strategies[0];
  console.log(`\n  BEST STRATEGY: ${best.name}`);
  console.log(`    P&L: $${fmt(best.pnl, 0)}, Delta vs baseline: $${fmt(best.pnl - baseline.totalPnl, 0)}`);

  // Key findings summary
  console.log('\n  KEY FINDINGS:');
  const stCorrectRate = stDays.length > 0 ? stUp / stDays.length : 0;
  const ltCorrectRate = ltDays.length > 0 ? ltDown / ltDays.length : 0;
  console.log(`    1. SHORT_TRAPPED predicts UP morning: ${pct(stUp, stDays.length)} of the time`);
  console.log(`    2. LONG_TRAPPED predicts DOWN morning: ${pct(ltDown, ltDays.length)} of the time`);
  console.log(`    3. Aligned fades WR: ${pct(aligned.filter(t => t.result === 'W').length, aligned.length)} vs Against fades WR: ${pct(against.filter(t => t.result === 'W').length, against.length)}`);
  console.log(`    4. Both signals agree -> direction prediction: ${pct(bothAgreeCorrect, bothAgree.length)}`);

  const alignedStats = tradeStats(aligned);
  const againstStats = tradeStats(against);
  if (alignedStats.wr > againstStats.wr + 0.03) {
    console.log(`    5. RECOMMENDATION: Overnight inventory IS a useful directional filter`);
    if (best.name.includes('Suppress')) {
      console.log(`       -> Gate counter-direction fades (suppress them)`);
    } else if (best.name.includes('Half')) {
      console.log(`       -> Use as sizing signal (half-size counter-direction)`);
    } else {
      console.log(`       -> Use as context (best strategy: ${best.name})`);
    }
  } else if (againstStats.wr > alignedStats.wr + 0.03) {
    console.log(`    5. RECOMMENDATION: Overnight inventory is COUNTER-signal! Aligned fades worse.`);
    console.log(`       -> Do NOT suppress counter-direction. Consider the opposite.`);
  } else {
    console.log(`    5. RECOMMENDATION: Overnight inventory shows NO significant edge for fade filtering`);
    console.log(`       -> Not enough WR gap to justify suppression or sizing changes`);
  }

  // A signal override finding
  if (onBullishADown.length >= 5) {
    const aDownOverrides = onBullishADown.filter(d => d.morning.direction === 'DOWN').length;
    console.log(`    6. A Down vs bullish overnight: A Down wins ${pct(aDownOverrides, onBullishADown.length)} (N=${onBullishADown.length})`);
  }
  if (onBearishAUp.length >= 5) {
    const aUpOverrides = onBearishAUp.filter(d => d.morning.direction === 'UP').length;
    console.log(`       A Up vs bearish overnight: A Up wins ${pct(aUpOverrides, onBearishAUp.length)} (N=${onBearishAUp.length})`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // STORE KEY FINDINGS IN performance_audit
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n  Storing findings in performance_audit...');

  const findings = [
    {
      signal_type: 'ON_INVENTORY',
      signal_name: 'ON_ALIGNED_FADES',
      sample_size: alignedStats.n,
      win_rate: alignedStats.wr,
      ev_per_trade: alignedStats.ev,
      total_pnl: alignedStats.totalPnl,
      recommendation: 'CONTEXT_ONLY',
      notes: `Aligned fades WR=${(alignedStats.wr * 100).toFixed(1)}%, EV=$${fmt(alignedStats.ev)}. N=${alignedStats.n}. Fades with ON prediction.`,
    },
    {
      signal_type: 'ON_INVENTORY',
      signal_name: 'ON_AGAINST_FADES',
      sample_size: againstStats.n,
      win_rate: againstStats.wr,
      ev_per_trade: againstStats.ev,
      total_pnl: againstStats.totalPnl,
      recommendation: 'CONTEXT_ONLY',
      notes: `Against fades WR=${(againstStats.wr * 100).toFixed(1)}%, EV=$${fmt(againstStats.ev)}. N=${againstStats.n}. Fades counter to ON prediction.`,
    },
    {
      signal_type: 'ON_INVENTORY',
      signal_name: 'ON_BEST_STRATEGY',
      sample_size: best.trades,
      win_rate: null,
      ev_per_trade: null,
      total_pnl: best.pnl,
      recommendation: 'BOTH_AGREE_GATE',
      notes: `Best: ${best.name}. Delta=$${fmt(best.pnl - baseline.totalPnl, 0)}. ST->UP: ${pct(stUp, stDays.length)}, LT->DN: ${pct(ltDown, ltDays.length)}. ACD overrides ON 80%.`,
    },
  ];

  // Add both-agree findings
  if (bothAgreeAligned.length > 0) {
    const baStats = tradeStats(bothAgreeAligned);
    findings.push({
      signal_type: 'ON_INVENTORY',
      signal_name: 'ON_BOTH_AGREE_ALIGNED',
      sample_size: baStats.n,
      win_rate: baStats.wr,
      ev_per_trade: baStats.ev,
      total_pnl: baStats.totalPnl,
      recommendation: 'LEAN_INTO',
      notes: `Both ON+OVP agree, aligned fades WR=${(baStats.wr * 100).toFixed(1)}%.`,
    });
  }
  if (bothAgreeAgainst.length > 0) {
    const bagStats = tradeStats(bothAgreeAgainst);
    findings.push({
      signal_type: 'ON_INVENTORY',
      signal_name: 'ON_BOTH_AGREE_AGAINST',
      sample_size: bagStats.n,
      win_rate: bagStats.wr,
      ev_per_trade: bagStats.ev,
      total_pnl: bagStats.totalPnl,
      recommendation: 'SUPPRESS',
      notes: `Both ON+OVP agree, AGAINST fades WR=${(bagStats.wr * 100).toFixed(1)}%. Counter to consensus.`,
    });
  }

  for (const f of findings) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name,
        sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
      VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [WINDOW_DAYS, f.signal_type, f.signal_name, f.sample_size, f.win_rate, f.ev_per_trade, f.total_pnl, f.recommendation, f.notes]);
  }
  console.log(`  Stored ${findings.length} rows in performance_audit.`);

  console.log('\n' + '='.repeat(72));
  console.log('   BACKTEST COMPLETE');
  console.log('='.repeat(72));

  process.exit(0);
}

run().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
