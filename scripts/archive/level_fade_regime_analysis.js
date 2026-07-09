// level_fade_regime_analysis.js
// Comprehensive level fade analysis: 10-day vs 180-day performance,
// day-by-day breakdown, day-type context, and regime check.

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION = 1;
const FADE_STOP = 90;   // stop loss in points
const FADE_TARGET_20 = 20;
const FADE_TARGET_40 = 40;
const MAE_MFE_WINDOW = 30; // bars
const TOUCH_THRESHOLD = 3; // points proximity for a "touch"

// ============================================================
// DATA LOADING
// ============================================================

async function getTradingDates(n) {
  const r = await query(`
    SELECT DISTINCT ts::date as d
    FROM price_bars_primary
    WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY d DESC LIMIT $1
  `, [n]);
  return r.rows.map(x => x.d).reverse();
}

async function getBarsForDate(date) {
  const r = await query(`
    SELECT ts, open::float, high::float, low::float, close::float, volume
    FROM price_bars_primary
    WHERE ts::date = $1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `, [date]);
  return r.rows;
}

async function getDVLForDate(date) {
  const r = await query(`
    SELECT poc::float, vah::float, val::float,
           session_high::float, session_low::float, session_close::float
    FROM developing_value_log
    WHERE trade_date = $1
  `, [date]);
  return r.rows[0] || null;
}

async function getACDForDate(date) {
  const r = await query(`
    SELECT or_high::float, or_low::float
    FROM acd_daily_log
    WHERE trade_date = $1
  `, [date]);
  return r.rows[0] || null;
}

// ============================================================
// LEVEL COMPUTATION
// ============================================================

function computeORFromBars(bars) {
  // OR = first 5 minutes (9:30-9:34)
  const orBars = bars.filter(b => {
    const d = new Date(b.ts);
    const min = d.getUTCHours() * 60 + d.getUTCMinutes();
    return min >= 570 && min < 575;
  });
  if (orBars.length === 0) return null;
  const high = Math.max(...orBars.map(b => b.high));
  const low = Math.min(...orBars.map(b => b.low));
  return { high, low, mid: (high + low) / 2 };
}

function computeIBFromBars(bars) {
  // IB = first 60 minutes (9:30-10:29)
  const ibBars = bars.filter(b => {
    const d = new Date(b.ts);
    const min = d.getUTCHours() * 60 + d.getUTCMinutes();
    return min >= 570 && min < 630;
  });
  if (ibBars.length === 0) return null;
  const high = Math.max(...ibBars.map(b => b.high));
  const low = Math.min(...ibBars.map(b => b.low));
  return { high, low, mid: (high + low) / 2 };
}

function computeFloorPivots(pdHigh, pdLow, pdClose) {
  const pivot = (pdHigh + pdLow + pdClose) / 3;
  const r1 = 2 * pivot - pdLow;
  const s1 = 2 * pivot - pdHigh;
  return { pivot, r1, s1 };
}

function computeSessionStats(bars) {
  if (bars.length === 0) return { high: 0, low: 0, close: 0, range: 0, netMove: 0 };
  const high = Math.max(...bars.map(b => b.high));
  const low = Math.min(...bars.map(b => b.low));
  const open = bars[0].open;
  const close = bars[bars.length - 1].close;
  return { high, low, open, close, range: high - low, netMove: close - open };
}

// ============================================================
// DAY TYPE CLASSIFICATION
// ============================================================

function classifyDayType(bars) {
  if (bars.length < 30) return 'UNKNOWN';

  const stats = computeSessionStats(bars);
  const { range, netMove, high, low } = stats;

  if (range === 0) return 'UNKNOWN';

  const absNetMove = Math.abs(netMove);
  const directionalRatio = absNetMove / range;

  // Count rotations (direction changes)
  let rotations = 0;
  let lastDir = 0;
  for (let i = 1; i < bars.length; i++) {
    const dir = bars[i].close > bars[i-1].close ? 1 : bars[i].close < bars[i-1].close ? -1 : 0;
    if (dir !== 0 && dir !== lastDir) {
      rotations++;
      lastDir = dir;
    }
  }

  // Count significant swings (>15 point reversals)
  let swings = 0;
  let swingHigh = bars[0].high;
  let swingLow = bars[0].low;
  let swingDir = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].high > swingHigh) {
      swingHigh = bars[i].high;
      if (swingDir === -1 && swingHigh - swingLow > 15) { swings++; swingDir = 1; swingLow = bars[i].low; }
      else swingDir = 1;
    }
    if (bars[i].low < swingLow) {
      swingLow = bars[i].low;
      if (swingDir === 1 && swingHigh - swingLow > 15) { swings++; swingDir = -1; swingHigh = bars[i].high; }
      else swingDir = -1;
    }
  }

  // Classify
  if (directionalRatio > 0.6 && range > 150) {
    return netMove > 0 ? 'TREND_UP' : 'TREND_DOWN';
  } else if (directionalRatio > 0.45 && range > 100) {
    return netMove > 0 ? 'TREND_UP' : 'TREND_DOWN';
  } else if (range < 80) {
    return 'CHOP';
  } else if (directionalRatio < 0.2 && swings >= 4) {
    return 'TURBULENT';
  } else if (directionalRatio < 0.3) {
    return 'BALANCE';
  } else {
    return 'BALANCE';
  }
}

// ============================================================
// TOUCH DETECTION & FADE SCORING
// ============================================================

function detectFirstTouch(bars, level, startIdx) {
  // Find first bar where price touches the level (comes within TOUCH_THRESHOLD)
  // startIdx = index in bars array to start searching from
  for (let i = startIdx; i < bars.length; i++) {
    const bar = bars[i];
    // Check if level is within the bar's range (touched from above or below)
    if (bar.low <= level + TOUCH_THRESHOLD && bar.high >= level - TOUCH_THRESHOLD) {
      return i;
    }
  }
  return -1;
}

function scoreFade(bars, touchIdx, level) {
  // After touching the level, measure what happens over next MAE_MFE_WINDOW bars
  // Fade = bet price moves AWAY from level
  // Determine approach direction: did price come from above or below?
  const touchBar = bars[touchIdx];
  const priorClose = touchIdx > 0 ? bars[touchIdx - 1].close : touchBar.open;
  const fromAbove = priorClose > level; // price came down to level → fade = go long
  const isLong = fromAbove; // fade direction: long if approaching from above, short if from below

  const entryPrice = level; // idealized entry at the level

  let mae = 0; // max adverse excursion (worst case against us)
  let mfe = 0; // max favorable excursion (best case for us)
  let hit20 = false, hit40 = false;
  let stopped = false;

  const endIdx = Math.min(touchIdx + MAE_MFE_WINDOW, bars.length);

  for (let i = touchIdx; i < endIdx; i++) {
    const bar = bars[i];
    if (isLong) {
      // Long fade: favorable = price goes up, adverse = price goes down
      const favorable = bar.high - entryPrice;
      const adverse = entryPrice - bar.low;
      mfe = Math.max(mfe, favorable);
      mae = Math.max(mae, adverse);
      // Check stop first (conservative: if both hit in same bar, stop wins)
      if (adverse >= FADE_STOP) { stopped = true; break; }
      if (favorable >= FADE_TARGET_20) hit20 = true;
      if (favorable >= FADE_TARGET_40) { hit40 = true; break; }
    } else {
      // Short fade: favorable = price goes down, adverse = price goes up
      const favorable = entryPrice - bar.low;
      const adverse = bar.high - entryPrice;
      mfe = Math.max(mfe, favorable);
      mae = Math.max(mae, adverse);
      // Check stop first (conservative: if both hit in same bar, stop wins)
      if (adverse >= FADE_STOP) { stopped = true; break; }
      if (favorable >= FADE_TARGET_20) hit20 = true;
      if (favorable >= FADE_TARGET_40) { hit40 = true; break; }
    }
  }

  // Compute simulated P&L with 90pt stop / 40pt target
  let fadePnl;
  if (stopped) {
    fadePnl = -FADE_STOP * PNL_PER_POINT - COMMISSION;
  } else if (hit40) {
    fadePnl = FADE_TARGET_40 * PNL_PER_POINT - COMMISSION;
  } else {
    // Neither stopped nor target hit within window — use close of last bar in window
    const lastBar = bars[Math.min(touchIdx + MAE_MFE_WINDOW - 1, bars.length - 1)];
    const exitPrice = lastBar.close;
    const rawPnl = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
    fadePnl = rawPnl * PNL_PER_POINT - COMMISSION;
  }

  return {
    isLong,
    mae: Math.round(mae * 100) / 100,
    mfe: Math.round(mfe * 100) / 100,
    hit20,
    hit40,
    stopped,
    fadePnl: Math.round(fadePnl * 100) / 100,
    touchBarIdx: touchIdx
  };
}

// ============================================================
// MAIN ANALYSIS
// ============================================================

async function analyzeDay(date, priorDVL, priorBars, rolling10IB) {
  const bars = await getBarsForDate(date);
  if (bars.length === 0) return null;

  const dvl = await getDVLForDate(date);
  const acd = await getACDForDate(date);
  const stats = computeSessionStats(bars);
  const dayType = classifyDayType(bars);
  const or = computeORFromBars(bars);
  const ib = computeIBFromBars(bars);

  // Build levels map
  const levels = {};

  // Prior day levels from DVL
  if (priorDVL) {
    levels['PD_POC'] = priorDVL.poc;
    levels['PD_VAH'] = priorDVL.vah;
    levels['PD_VAL'] = priorDVL.val;
    levels['PD_SESSION_MID'] = (priorDVL.session_high + priorDVL.session_low) / 2;
  }

  // Today's OR/IB
  if (or) {
    levels['OR_HIGH'] = or.high;
    levels['OR_LOW'] = or.low;
    levels['OR_MID'] = or.mid;
  } else if (acd) {
    levels['OR_HIGH'] = acd.or_high;
    levels['OR_LOW'] = acd.or_low;
    levels['OR_MID'] = (acd.or_high + acd.or_low) / 2;
  }

  if (ib) {
    levels['IB_HIGH'] = ib.high;
    levels['IB_LOW'] = ib.low;
    levels['IB_MID'] = ib.mid;
  }

  // Prior day IB/OR mid (from prior day bars)
  if (priorBars && priorBars.length > 0) {
    const pdOR = computeORFromBars(priorBars);
    const pdIB = computeIBFromBars(priorBars);
    if (pdOR) levels['PD_OR_MID'] = pdOR.mid;
    if (pdIB) levels['PD_IB_MID'] = pdIB.mid;
  }

  // Floor Pivots from prior day
  if (priorDVL) {
    const pivots = computeFloorPivots(priorDVL.session_high, priorDVL.session_low, priorDVL.session_close);
    levels['FLOOR_PIVOT'] = pivots.pivot;
    levels['FLOOR_R1'] = pivots.r1;
    levels['FLOOR_S1'] = pivots.s1;
  }

  // 10D IB MID (rolling composite)
  if (rolling10IB && rolling10IB.length > 0) {
    const avg = rolling10IB.reduce((s, x) => s + x, 0) / rolling10IB.length;
    levels['10D_IB_MID'] = Math.round(avg * 100) / 100;
  }

  // For today's OR/IB levels, only search AFTER they're established
  const orEndIdx = or ? bars.findIndex(b => {
    const d = new Date(b.ts);
    return d.getUTCHours() * 60 + d.getUTCMinutes() >= 575;
  }) : 0;

  const ibEndIdx = ib ? bars.findIndex(b => {
    const d = new Date(b.ts);
    return d.getUTCHours() * 60 + d.getUTCMinutes() >= 630;
  }) : 0;

  // Analyze each level
  const results = {};
  for (const [name, level] of Object.entries(levels)) {
    if (level == null || isNaN(level)) continue;

    // Determine start index for touch search
    let startIdx = 0;
    if (name.startsWith('OR_') && !name.startsWith('OR_MID')) startIdx = Math.max(orEndIdx, 0);
    else if (name === 'OR_MID') startIdx = Math.max(orEndIdx, 0);
    else if (name.startsWith('IB_') && !name.startsWith('IB_MID')) startIdx = Math.max(ibEndIdx, 0);
    else if (name === 'IB_MID') startIdx = Math.max(ibEndIdx, 0);

    // Check if level is within today's range (could realistically be touched)
    if (level > stats.high + 50 || level < stats.low - 50) {
      continue; // Level too far away, skip
    }

    const touchIdx = detectFirstTouch(bars, level, startIdx);
    if (touchIdx === -1) continue;

    const score = scoreFade(bars, touchIdx, level);
    results[name] = {
      level: Math.round(level * 100) / 100,
      ...score,
      touchTime: bars[touchIdx].ts,
    };
  }

  // Count rotations for regime analysis
  let rotations = 0;
  let lastDir = 0;
  for (let i = 1; i < bars.length; i++) {
    const move = bars[i].close - bars[i-1].close;
    const dir = move > 5 ? 1 : move < -5 ? -1 : 0;
    if (dir !== 0 && dir !== lastDir) { rotations++; lastDir = dir; }
  }

  return {
    date,
    dayType,
    stats,
    levels: results,
    or,
    ib,
    dvl,
    rotations,
    bars
  };
}

async function run() {
  console.log('='.repeat(100));
  console.log('  LEVEL FADE REGIME ANALYSIS — 10-Day vs 180-Day Comparison');
  console.log('='.repeat(100));
  console.log();

  // Get date ranges
  const allDates = await getTradingDates(200); // get plenty to cover 180 trading days
  const last10Dates = allDates.slice(-10);
  const last180Dates = allDates.slice(-180);

  console.log(`Analysis window: ${last180Dates[0]} to ${last180Dates[last180Dates.length-1]}`);
  console.log(`Last 10 days: ${last10Dates[0]} to ${last10Dates[last10Dates.length-1]}`);
  console.log(`Total days available: ${allDates.length}`);
  console.log();

  // ============================================================
  // ANALYZE ALL 180 DAYS
  // ============================================================

  console.log('Analyzing 180 trading days...');

  const allResults = [];
  let prevDVL = null;
  let prevBars = null;
  const ibMidHistory = [];

  // We need one extra day before the window for prior-day data
  const extendedDates = allDates.slice(Math.max(0, allDates.indexOf(last180Dates[0]) - 1));

  // Pre-fetch prior day data for first date
  if (extendedDates.length > 0 && allDates.indexOf(last180Dates[0]) > 0) {
    const preDateIdx = allDates.indexOf(last180Dates[0]) - 1;
    const preDate = allDates[preDateIdx];
    prevDVL = await getDVLForDate(preDate);
    prevBars = await getBarsForDate(preDate);
    const preIB = computeIBFromBars(prevBars);
    if (preIB) ibMidHistory.push(preIB.mid);
  }

  for (let i = 0; i < last180Dates.length; i++) {
    const date = last180Dates[i];
    if (i % 30 === 0) process.stderr.write(`  Processing day ${i+1}/${last180Dates.length}...\r`);

    const rolling10IB = ibMidHistory.slice(-10);
    const result = await analyzeDay(date, prevDVL, prevBars, rolling10IB);

    if (result) {
      allResults.push(result);
      prevDVL = result.dvl;
      prevBars = result.bars;
      if (result.ib) ibMidHistory.push(result.ib.mid);
    }
  }

  console.log(`\nAnalyzed ${allResults.length} trading days successfully.\n`);

  // Separate last 10 and full 180
  const last10Results = allResults.slice(-10);
  const full180Results = allResults;

  // ============================================================
  // PART 1: 10-DAY vs 180-DAY COMPARISON TABLE
  // ============================================================

  console.log('='.repeat(100));
  console.log('  PART 1: LEVEL PERFORMANCE — LAST 10 DAYS vs FULL 180 DAYS');
  console.log('='.repeat(100));
  console.log();

  function aggregateLevelStats(results) {
    const levelStats = {};
    for (const day of results) {
      for (const [name, data] of Object.entries(day.levels)) {
        if (!levelStats[name]) levelStats[name] = { touches: 0, wins20: 0, wins40: 0, totalMae: 0, totalMfe: 0, totalPnl: 0, stopped: 0 };
        levelStats[name].touches++;
        if (data.hit20) levelStats[name].wins20++;
        if (data.hit40) levelStats[name].wins40++;
        levelStats[name].totalMae += data.mae;
        levelStats[name].totalMfe += data.mfe;
        levelStats[name].totalPnl += data.fadePnl;
        if (data.stopped) levelStats[name].stopped++;
      }
    }
    return levelStats;
  }

  const stats10 = aggregateLevelStats(last10Results);
  const stats180 = aggregateLevelStats(full180Results);

  // Get all level names
  const allLevelNames = [...new Set([...Object.keys(stats10), ...Object.keys(stats180)])].sort();

  // Header
  const header = 'Level'.padEnd(16) + '│' +
    ' 10D Touch'.padEnd(10) + ' 10D WR20'.padEnd(10) + ' 10D WR40'.padEnd(10) + ' 10D EV'.padEnd(10) + '│' +
    ' 180D Touch'.padEnd(11) + '180D WR20'.padEnd(10) + '180D WR40'.padEnd(10) + '180D EV'.padEnd(10) + '│' +
    ' Trend';

  console.log(header);
  console.log('─'.repeat(header.length + 5));

  const comparisonRows = [];

  for (const name of allLevelNames) {
    const s10 = stats10[name] || { touches: 0, wins20: 0, wins40: 0, totalPnl: 0, totalMae: 0, totalMfe: 0 };
    const s180 = stats180[name] || { touches: 0, wins20: 0, wins40: 0, totalPnl: 0, totalMae: 0, totalMfe: 0 };

    const wr20_10 = s10.touches > 0 ? (s10.wins20 / s10.touches * 100) : 0;
    const wr40_10 = s10.touches > 0 ? (s10.wins40 / s10.touches * 100) : 0;
    const ev10 = s10.touches > 0 ? (s10.totalPnl / s10.touches) : 0;

    const wr20_180 = s180.touches > 0 ? (s180.wins20 / s180.touches * 100) : 0;
    const wr40_180 = s180.touches > 0 ? (s180.wins40 / s180.touches * 100) : 0;
    const ev180 = s180.touches > 0 ? (s180.totalPnl / s180.touches) : 0;

    const wrDiff = wr40_10 - wr40_180;
    let trend = '  ---';
    if (s10.touches >= 2 && Math.abs(wrDiff) > 5) {
      trend = wrDiff > 0 ? '  ▲ OUTPERFORMING' : '  ▼ DEGRADING';
    } else if (s10.touches >= 2) {
      trend = '  ≈ STABLE';
    } else {
      trend = '  ? LOW SAMPLE';
    }

    const row = name.padEnd(16) + '│' +
      ` ${s10.touches}`.padEnd(10) +
      ` ${wr20_10.toFixed(0)}%`.padEnd(10) +
      ` ${wr40_10.toFixed(0)}%`.padEnd(10) +
      ` $${ev10.toFixed(0)}`.padEnd(10) + '│' +
      ` ${s180.touches}`.padEnd(11) +
      `${wr20_180.toFixed(0)}%`.padEnd(10) +
      `${wr40_180.toFixed(0)}%`.padEnd(10) +
      `$${ev180.toFixed(0)}`.padEnd(10) + '│' +
      trend;

    console.log(row);
    comparisonRows.push({ name, s10, s180, wr40_10, wr40_180, ev10, ev180, wrDiff, trend: trend.trim() });
  }

  console.log();

  // Summary of outperforming/degrading
  const outperforming = comparisonRows.filter(r => r.trend.includes('OUTPERFORMING'));
  const degrading = comparisonRows.filter(r => r.trend.includes('DEGRADING'));

  if (outperforming.length > 0) {
    console.log('OUTPERFORMING LEVELS (10d WR40 > 180d WR40 by >5%):');
    for (const r of outperforming) {
      console.log(`  ${r.name}: ${r.wr40_10.toFixed(0)}% vs ${r.wr40_180.toFixed(0)}% (+${r.wrDiff.toFixed(0)}pp)`);
    }
    console.log();
  }

  if (degrading.length > 0) {
    console.log('DEGRADING LEVELS (10d WR40 < 180d WR40 by >5%):');
    for (const r of degrading) {
      console.log(`  ${r.name}: ${r.wr40_10.toFixed(0)}% vs ${r.wr40_180.toFixed(0)}% (${r.wrDiff.toFixed(0)}pp)`);
    }
    console.log();
  }

  // MAE/MFE summary
  console.log('MAE/MFE SUMMARY (30-bar window):');
  console.log('Level'.padEnd(16) + '│' + ' 10D AvgMAE'.padEnd(12) + ' 10D AvgMFE'.padEnd(12) + '│' + ' 180D AvgMAE'.padEnd(13) + '180D AvgMFE');
  console.log('─'.repeat(70));
  for (const name of allLevelNames) {
    const s10 = stats10[name] || { touches: 0, totalMae: 0, totalMfe: 0 };
    const s180 = stats180[name] || { touches: 0, totalMae: 0, totalMfe: 0 };
    const avgMae10 = s10.touches > 0 ? s10.totalMae / s10.touches : 0;
    const avgMfe10 = s10.touches > 0 ? s10.totalMfe / s10.touches : 0;
    const avgMae180 = s180.touches > 0 ? s180.totalMae / s180.touches : 0;
    const avgMfe180 = s180.touches > 0 ? s180.totalMfe / s180.touches : 0;
    console.log(
      name.padEnd(16) + '│' +
      ` ${avgMae10.toFixed(1)}pt`.padEnd(12) +
      ` ${avgMfe10.toFixed(1)}pt`.padEnd(12) + '│' +
      ` ${avgMae180.toFixed(1)}pt`.padEnd(13) +
      `${avgMfe180.toFixed(1)}pt`
    );
  }

  // ============================================================
  // PART 2: DAY-BY-DAY BREAKDOWN (LAST 10 DAYS)
  // ============================================================

  console.log('\n' + '='.repeat(100));
  console.log('  PART 2: DAY-BY-DAY BREAKDOWN — LAST 10 TRADING DAYS');
  console.log('='.repeat(100));
  console.log();

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (const day of last10Results) {
    const dt = new Date(day.date + 'T12:00:00');
    const dayName = dayNames[dt.getDay()];

    console.log(`┌─── ${day.date} (${dayName}) ─── ${day.dayType} ─── Range: ${day.stats.range.toFixed(0)}pt ─── Net: ${day.stats.netMove >= 0 ? '+' : ''}${day.stats.netMove.toFixed(0)}pt ───┐`);

    const touchedLevels = Object.entries(day.levels);
    if (touchedLevels.length === 0) {
      console.log('│  No level touches detected');
    } else {
      // Sort by touch time
      touchedLevels.sort((a, b) => a[1].touchBarIdx - b[1].touchBarIdx);

      let dayPnl = 0;
      let wins = 0, losses = 0;

      for (const [name, data] of touchedLevels) {
        const touchTime = new Date(data.touchTime);
        const timeStr = touchTime.toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit',
          timeZone: 'UTC', hour12: false
        });

        const result = data.stopped ? 'STOPPED' : data.hit40 ? 'TARGET' : 'SCRATCH';
        const resultIcon = data.stopped ? 'X' : data.hit40 ? 'W' : '~';
        const dir = data.isLong ? 'LONG' : 'SHORT';

        if (data.hit40) wins++;
        if (data.stopped) losses++;
        dayPnl += data.fadePnl;

        console.log(`│  [${resultIcon}] ${timeStr} ET  ${name.padEnd(16)} @ ${data.level.toFixed(1).padStart(9)}  ${dir.padEnd(5)}  MAE=${data.mae.toFixed(0).padStart(3)}pt  MFE=${data.mfe.toFixed(0).padStart(3)}pt  ${result.padEnd(8)}  $${data.fadePnl >= 0 ? '+' : ''}${data.fadePnl.toFixed(0)}`);
      }

      console.log(`│  ──────────────────────────────────────────────────────────────────────────────────────`);
      console.log(`│  DAY TOTAL: ${touchedLevels.length} touches, ${wins}W/${losses}L, P&L = $${dayPnl >= 0 ? '+' : ''}${dayPnl.toFixed(0)}`);
    }

    console.log(`└${'─'.repeat(95)}┘`);
    console.log();
  }

  // 10-day summary
  let total10Pnl = 0;
  let total10Touches = 0;
  let total10Wins = 0;
  let total10Losses = 0;

  for (const day of last10Results) {
    for (const [, data] of Object.entries(day.levels)) {
      total10Touches++;
      total10Pnl += data.fadePnl;
      if (data.hit40) total10Wins++;
      if (data.stopped) total10Losses++;
    }
  }

  console.log('10-DAY AGGREGATE:');
  console.log(`  Total touches: ${total10Touches}`);
  console.log(`  Wins (40pt): ${total10Wins}  Losses (90pt stop): ${total10Losses}  Scratches: ${total10Touches - total10Wins - total10Losses}`);
  console.log(`  Win Rate (40pt): ${total10Touches > 0 ? (total10Wins / total10Touches * 100).toFixed(1) : 0}%`);
  console.log(`  Total P&L: $${total10Pnl >= 0 ? '+' : ''}${total10Pnl.toFixed(0)}`);
  console.log(`  Avg P&L/day: $${(total10Pnl / 10).toFixed(0)}`);

  // ============================================================
  // PART 3: DAY TYPE CONTEXT (from full 180 days)
  // ============================================================

  console.log('\n' + '='.repeat(100));
  console.log('  PART 3: LEVEL PERFORMANCE BY DAY TYPE — FULL 180 DAYS');
  console.log('='.repeat(100));
  console.log();

  const dayTypes = ['TREND_UP', 'TREND_DOWN', 'BALANCE', 'CHOP', 'TURBULENT'];

  for (const dt of dayTypes) {
    const daysOfType = full180Results.filter(d => d.dayType === dt);
    if (daysOfType.length === 0) {
      console.log(`${dt}: No days classified this type`);
      console.log();
      continue;
    }

    console.log(`┌─── ${dt} (${daysOfType.length} days) ───────────────────────────────────────┐`);

    const typeStats = aggregateLevelStats(daysOfType);

    // Sort by WR40 descending, filter levels with >= 3 touches
    const ranked = Object.entries(typeStats)
      .filter(([, s]) => s.touches >= 3)
      .map(([name, s]) => ({
        name,
        touches: s.touches,
        wr20: s.touches > 0 ? s.wins20 / s.touches * 100 : 0,
        wr40: s.touches > 0 ? s.wins40 / s.touches * 100 : 0,
        ev: s.touches > 0 ? s.totalPnl / s.touches : 0,
        avgMfe: s.touches > 0 ? s.totalMfe / s.touches : 0,
        stopRate: s.touches > 0 ? s.stopped / s.touches * 100 : 0,
      }))
      .sort((a, b) => b.wr40 - a.wr40);

    if (ranked.length === 0) {
      console.log(`│  Insufficient data (no levels with 3+ touches)`);
    } else {
      // Top 5
      console.log(`│  TOP 5 LEVELS BY FADE WR40:`);
      console.log(`│  ${'Level'.padEnd(16)} ${'Touches'.padEnd(9)} ${'WR20'.padEnd(7)} ${'WR40'.padEnd(7)} ${'EV'.padEnd(9)} ${'AvgMFE'.padEnd(9)} ${'StopRate'.padEnd(9)}`);
      console.log(`│  ${'─'.repeat(75)}`);

      for (const r of ranked.slice(0, 5)) {
        console.log(`│  ${r.name.padEnd(16)} ${String(r.touches).padEnd(9)} ${(r.wr20.toFixed(0) + '%').padEnd(7)} ${(r.wr40.toFixed(0) + '%').padEnd(7)} ${'$' + r.ev.toFixed(0).padStart(5)} ${(r.avgMfe.toFixed(0) + 'pt').padEnd(9)} ${(r.stopRate.toFixed(0) + '%').padEnd(9)}`);
      }

      // Worst performers (levels that specifically fail on this day type)
      const worst = ranked.filter(r => r.wr40 < 30 && r.touches >= 3).sort((a, b) => a.wr40 - b.wr40);
      if (worst.length > 0) {
        console.log(`│`);
        console.log(`│  WORST LEVELS (WR40 < 30%, avoid on ${dt} days):`);
        for (const r of worst.slice(0, 3)) {
          console.log(`│  !! ${r.name.padEnd(16)} WR40=${r.wr40.toFixed(0)}%  StopRate=${r.stopRate.toFixed(0)}%  EV=$${r.ev.toFixed(0)}  (${r.touches} touches)`);
        }
      }
    }

    console.log(`└${'─'.repeat(60)}┘`);
    console.log();
  }

  // Cross-day-type matrix
  console.log('CROSS-DAY-TYPE MATRIX (WR40 by level and day type, min 3 touches):');
  console.log();

  const matrixLevels = allLevelNames.filter(name => {
    const s = stats180[name];
    return s && s.touches >= 5;
  });

  // Header
  let matrixHeader = 'Level'.padEnd(16) + '│';
  for (const dt of dayTypes) {
    matrixHeader += ` ${dt.substring(0, 8).padEnd(9)}`;
  }
  matrixHeader += '│ OVERALL';
  console.log(matrixHeader);
  console.log('─'.repeat(matrixHeader.length + 3));

  for (const name of matrixLevels) {
    let row = name.padEnd(16) + '│';
    for (const dt of dayTypes) {
      const daysOfType = full180Results.filter(d => d.dayType === dt);
      const typeStats = aggregateLevelStats(daysOfType);
      const s = typeStats[name];
      if (s && s.touches >= 3) {
        const wr = (s.wins40 / s.touches * 100).toFixed(0);
        row += ` ${(wr + '%').padEnd(9)}`;
      } else if (s) {
        row += ` ${(s.touches + 'n').padEnd(9)}`;
      } else {
        row += ` ${'--'.padEnd(9)}`;
      }
    }
    const overall = stats180[name];
    const overallWr = overall && overall.touches > 0 ? (overall.wins40 / overall.touches * 100).toFixed(0) : '--';
    row += `│ ${overallWr}%`;
    console.log(row);
  }

  // ============================================================
  // PART 4: REGIME CHECK
  // ============================================================

  console.log('\n' + '='.repeat(100));
  console.log('  PART 4: REGIME CHECK — IS THE CURRENT ENVIRONMENT DIFFERENT?');
  console.log('='.repeat(100));
  console.log();

  // Average range
  const ranges180 = full180Results.map(d => d.stats.range);
  const ranges10 = last10Results.map(d => d.stats.range);
  const avgRange180 = ranges180.reduce((s, x) => s + x, 0) / ranges180.length;
  const avgRange10 = ranges10.reduce((s, x) => s + x, 0) / ranges10.length;

  // Average rotations
  const rotations180 = full180Results.map(d => d.rotations);
  const rotations10 = last10Results.map(d => d.rotations);
  const avgRotations180 = rotations180.reduce((s, x) => s + x, 0) / rotations180.length;
  const avgRotations10 = rotations10.reduce((s, x) => s + x, 0) / rotations10.length;

  // Average net move (absolute)
  const absNetMove180 = full180Results.map(d => Math.abs(d.stats.netMove));
  const absNetMove10 = last10Results.map(d => Math.abs(d.stats.netMove));
  const avgAbsNet180 = absNetMove180.reduce((s, x) => s + x, 0) / absNetMove180.length;
  const avgAbsNet10 = absNetMove10.reduce((s, x) => s + x, 0) / absNetMove10.length;

  // Day type distribution
  const dtDist180 = {};
  for (const d of full180Results) {
    dtDist180[d.dayType] = (dtDist180[d.dayType] || 0) + 1;
  }
  const dtDist10 = {};
  for (const d of last10Results) {
    dtDist10[d.dayType] = (dtDist10[d.dayType] || 0) + 1;
  }

  // Volatility trend (range of last 5 periods of 10 days)
  const rangePeriods = [];
  for (let i = full180Results.length - 50; i < full180Results.length; i += 10) {
    const period = full180Results.slice(Math.max(0, i), i + 10);
    const avgR = period.reduce((s, d) => s + d.stats.range, 0) / period.length;
    rangePeriods.push(avgR);
  }

  const volTrend = rangePeriods.length >= 2
    ? (rangePeriods[rangePeriods.length - 1] > rangePeriods[0] ? 'EXPANDING' : 'CONTRACTING')
    : 'UNKNOWN';

  console.log('MARKET REGIME METRICS:');
  console.log('─'.repeat(65));
  console.log(`${'Metric'.padEnd(25)} ${'Last 10D'.padEnd(15)} ${'180D Avg'.padEnd(15)} ${'Delta'.padEnd(15)}`);
  console.log('─'.repeat(65));

  const rangeDelta = ((avgRange10 / avgRange180 - 1) * 100);
  const rotDelta = ((avgRotations10 / avgRotations180 - 1) * 100);
  const netDelta = ((avgAbsNet10 / avgAbsNet180 - 1) * 100);

  console.log(`${'Avg Daily Range'.padEnd(25)} ${(avgRange10.toFixed(0) + 'pt').padEnd(15)} ${(avgRange180.toFixed(0) + 'pt').padEnd(15)} ${(rangeDelta >= 0 ? '+' : '') + rangeDelta.toFixed(0) + '%'}`);
  console.log(`${'Avg Rotations'.padEnd(25)} ${avgRotations10.toFixed(0).padEnd(15)} ${avgRotations180.toFixed(0).padEnd(15)} ${(rotDelta >= 0 ? '+' : '') + rotDelta.toFixed(0) + '%'}`);
  console.log(`${'Avg |Net Move|'.padEnd(25)} ${(avgAbsNet10.toFixed(0) + 'pt').padEnd(15)} ${(avgAbsNet180.toFixed(0) + 'pt').padEnd(15)} ${(netDelta >= 0 ? '+' : '') + netDelta.toFixed(0) + '%'}`);
  console.log(`${'Volatility Regime'.padEnd(25)} ${volTrend.padEnd(15)}`);

  console.log();
  console.log('VOLATILITY TREND (avg range per 10-day period, last 50 days):');
  for (let i = 0; i < rangePeriods.length; i++) {
    const bar = '#'.repeat(Math.round(rangePeriods[i] / 10));
    console.log(`  Period ${i + 1}: ${rangePeriods[i].toFixed(0)}pt  ${bar}`);
  }

  console.log();
  console.log('DAY TYPE DISTRIBUTION:');
  console.log(`${'Day Type'.padEnd(15)} ${'Last 10D'.padEnd(15)} ${'180D'.padEnd(15)}`);
  console.log('─'.repeat(45));
  for (const dt of [...dayTypes, 'UNKNOWN']) {
    const pct10 = ((dtDist10[dt] || 0) / last10Results.length * 100).toFixed(0);
    const pct180 = ((dtDist180[dt] || 0) / full180Results.length * 100).toFixed(0);
    if ((dtDist10[dt] || 0) > 0 || (dtDist180[dt] || 0) > 0) {
      console.log(`${dt.padEnd(15)} ${((dtDist10[dt] || 0) + ' (' + pct10 + '%)').padEnd(15)} ${((dtDist180[dt] || 0) + ' (' + pct180 + '%)').padEnd(15)}`);
    }
  }

  // ============================================================
  // REGIME IMPACT ON EDGES
  // ============================================================

  console.log();
  console.log('REGIME IMPACT ASSESSMENT:');
  console.log('─'.repeat(80));

  // Compare edge quality in different volatility regimes
  // Split 180 days into high-vol and low-vol (above/below median range)
  const medianRange = [...ranges180].sort((a, b) => a - b)[Math.floor(ranges180.length / 2)];

  const highVolDays = full180Results.filter(d => d.stats.range >= medianRange);
  const lowVolDays = full180Results.filter(d => d.stats.range < medianRange);

  const highVolStats = aggregateLevelStats(highVolDays);
  const lowVolStats = aggregateLevelStats(lowVolDays);

  console.log(`Median daily range: ${medianRange.toFixed(0)}pt`);
  console.log(`High-vol days (>= median): ${highVolDays.length}  |  Low-vol days (< median): ${lowVolDays.length}`);
  console.log(`Current 10D avg range: ${avgRange10.toFixed(0)}pt → ${avgRange10 >= medianRange ? 'HIGH-VOL regime' : 'LOW-VOL regime'}`);
  console.log();

  console.log(`${'Level'.padEnd(16)} ${'HighVol WR40'.padEnd(14)} ${'LowVol WR40'.padEnd(14)} ${'Diff'.padEnd(10)} ${'Implication'}`);
  console.log('─'.repeat(80));

  for (const name of matrixLevels) {
    const hv = highVolStats[name];
    const lv = lowVolStats[name];
    const hvWr = hv && hv.touches >= 3 ? (hv.wins40 / hv.touches * 100) : null;
    const lvWr = lv && lv.touches >= 3 ? (lv.wins40 / lv.touches * 100) : null;

    if (hvWr !== null && lvWr !== null) {
      const diff = hvWr - lvWr;
      let imp = '';
      if (Math.abs(diff) > 10) {
        imp = diff > 0 ? 'Better in high vol' : 'Better in low vol';
        if (avgRange10 >= medianRange && diff > 0) imp += ' <<< ACTIVE EDGE';
        if (avgRange10 < medianRange && diff < 0) imp += ' <<< ACTIVE EDGE';
        if (avgRange10 >= medianRange && diff < 0) imp += ' (DEGRADED in current regime)';
        if (avgRange10 < medianRange && diff > 0) imp += ' (DEGRADED in current regime)';
      }
      console.log(`${name.padEnd(16)} ${(hvWr.toFixed(0) + '%').padEnd(14)} ${(lvWr.toFixed(0) + '%').padEnd(14)} ${((diff >= 0 ? '+' : '') + diff.toFixed(0) + 'pp').padEnd(10)} ${imp}`);
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(100));
  console.log('  EXECUTIVE SUMMARY');
  console.log('='.repeat(100));
  console.log();

  // Total PnL comparison
  const totalPnl10 = Object.values(stats10).reduce((s, x) => s + x.totalPnl, 0);
  const avgDailyPnl10 = totalPnl10 / 10;
  const totalPnl180 = Object.values(stats180).reduce((s, x) => s + x.totalPnl, 0);
  const avgDailyPnl180 = totalPnl180 / full180Results.length;

  console.log(`Total Level Fade System P&L (all first touches, 90pt stop / 40pt target):`);
  console.log(`  Last 10 days:  $${totalPnl10 >= 0 ? '+' : ''}${totalPnl10.toFixed(0)} ($${avgDailyPnl10.toFixed(0)}/day)`);
  console.log(`  Full 180 days: $${totalPnl180 >= 0 ? '+' : ''}${totalPnl180.toFixed(0)} ($${avgDailyPnl180.toFixed(0)}/day)`);
  console.log();

  console.log(`Regime: ${volTrend} volatility. Range ${rangeDelta >= 0 ? 'up' : 'down'} ${Math.abs(rangeDelta).toFixed(0)}% vs 180d avg.`);

  if (outperforming.length > 0) {
    console.log(`\nLevels HEATING UP: ${outperforming.map(r => r.name).join(', ')}`);
  }
  if (degrading.length > 0) {
    console.log(`Levels COOLING DOWN: ${degrading.map(r => r.name).join(', ')}`);
  }

  // Best current edges
  const bestCurrent = comparisonRows
    .filter(r => r.s10.touches >= 2 && r.wr40_10 > 40)
    .sort((a, b) => b.ev10 - a.ev10);

  if (bestCurrent.length > 0) {
    console.log(`\nBest edges RIGHT NOW (by 10-day EV):`);
    for (const r of bestCurrent.slice(0, 5)) {
      console.log(`  ${r.name}: WR40=${r.wr40_10.toFixed(0)}%, EV=$${r.ev10.toFixed(0)}/trade`);
    }
  }

  console.log('\n' + '='.repeat(100));

  process.exit(0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
