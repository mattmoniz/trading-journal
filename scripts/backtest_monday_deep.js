// backtest_monday_deep.js
// ═══════════════════════════════════════════════════════════════════════
// DEEP MONDAY ANALYSIS: Why Monday loses money, and where the edge hides
// 400+ day lookback across all level fades, time windows, gap impact,
// volume/range, skip-morning scenarios, and Friday carryover effects.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

// ── Constants ──
const PNL_PER_POINT = 2;   // NQ micro: $2/pt
const COMMISSION    = 1;    // $1 round-trip
const FADE_STOP     = 90;   // 90pt stop
const FADE_TARGET   = 40;   // 40pt target
const PROXIMITY     = 10;   // touch = within 10pt

// ── Helpers ──
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function fmt(v, d = 1) { return typeof v === 'number' ? v.toFixed(d) : String(v); }
function pctStr(n, d) { return d > 0 ? (n / d * 100).toFixed(1) + '%' : 'N/A'; }
function pad(s, w) { return String(s).padEnd(w); }
function rpad(s, w) { return String(s).padStart(w); }

function floorPivots(h, l, c) {
  const pivot = (h + l + c) / 3;
  return {
    FLOOR_PIVOT: pivot,
    FLOOR_R1: 2 * pivot - l,
    FLOOR_S1: 2 * pivot - h,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════

async function loadAllData() {
  console.log('Loading data...');

  // 1. Get all trading days with complete data
  const daysRes = await query(`
    SELECT d.trade_date::text as trade_date,
           EXTRACT(DOW FROM d.trade_date) as dow
    FROM developing_value_log d
    JOIN acd_daily_log a ON a.trade_date = d.trade_date
    WHERE d.trade_date <= CURRENT_DATE
      AND EXISTS (
        SELECT 1 FROM price_bars_primary p
        WHERE p.ts::date = d.trade_date
          AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) BETWEEN 570 AND 959
        LIMIT 1
      )
    ORDER BY d.trade_date
  `);
  const allDays = daysRes.rows.map(r => ({ date: r.trade_date, dow: Number(r.dow) }));
  console.log(`  Total trading days: ${allDays.length}`);

  const firstDate = allDays[0].date;
  const lastDate = allDays[allDays.length - 1].date;

  // 2. Developing value log
  const dvlRes = await query(`
    SELECT trade_date::text as trade_date,
           poc::float, vah::float, val::float,
           session_high::float, session_low::float, session_close::float
    FROM developing_value_log
    WHERE trade_date >= $1 AND trade_date <= $2
    ORDER BY trade_date
  `, [firstDate, lastDate]);
  const dvlByDate = new Map();
  for (const r of dvlRes.rows) dvlByDate.set(r.trade_date, r);

  // 3. ACD daily log
  const acdRes = await query(`
    SELECT trade_date::text as trade_date,
           or_high::float, or_low::float,
           a_up_fired, a_down_fired, daily_score
    FROM acd_daily_log
    WHERE trade_date >= $1 AND trade_date <= $2
    ORDER BY trade_date
  `, [firstDate, lastDate]);
  const acdByDate = new Map();
  for (const r of acdRes.rows) acdByDate.set(r.trade_date, r);

  // 4. RTH bars (bulk)
  const barsRes = await query(`
    SELECT ts::date::text as trade_date,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
           open::float, high::float, low::float, close::float,
           volume::int
    FROM price_bars_primary
    WHERE ts::date >= $1 AND ts::date <= $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `, [firstDate, lastDate]);
  const barsByDate = new Map();
  for (const r of barsRes.rows) {
    if (!barsByDate.has(r.trade_date)) barsByDate.set(r.trade_date, []);
    barsByDate.get(r.trade_date).push(r);
  }
  console.log(`  Loaded ${barsRes.rows.length} RTH bars across ${barsByDate.size} days`);

  // 5. Overnight bars (for gap calculation)
  // Overnight = prior calendar day 18:00+ through current calendar day <9:30
  const onEveRes = await query(`
    SELECT ts::date::text as bar_date,
           EXTRACT(hour FROM ts) as hr,
           high::float, low::float, close::float, open::float
    FROM price_bars_primary
    WHERE ts::date >= ($1::date - interval '4 day')::date AND ts::date <= $2
      AND EXTRACT(hour FROM ts) >= 18
    ORDER BY ts
  `, [firstDate, lastDate]);
  const onPreRes = await query(`
    SELECT ts::date::text as bar_date,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
           high::float, low::float, close::float, open::float
    FROM price_bars_primary
    WHERE ts::date >= $1 AND ts::date <= $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 570
    ORDER BY ts
  `, [firstDate, lastDate]);

  // Index evening/pre-open bars
  const eveningBars = new Map();
  for (const r of onEveRes.rows) {
    if (!eveningBars.has(r.bar_date)) eveningBars.set(r.bar_date, []);
    eveningBars.get(r.bar_date).push(r);
  }
  const preOpenBars = new Map();
  for (const r of onPreRes.rows) {
    if (!preOpenBars.has(r.bar_date)) preOpenBars.set(r.bar_date, []);
    preOpenBars.get(r.bar_date).push(r);
  }

  // Compute overnight H/L and RTH open for each day
  const overnightByDate = new Map();
  for (const dayObj of allDays) {
    const day = dayObj.date;
    const dt = new Date(day + 'T00:00:00');
    let onHigh = -Infinity, onLow = Infinity, found = false;
    // Look back up to 4 days for prior evening (weekends/holidays)
    for (let offset = 1; offset <= 4; offset++) {
      const priorDt = new Date(dt.getTime() - offset * 86400000);
      const priorDateStr = priorDt.toISOString().slice(0, 10);
      const eBars = eveningBars.get(priorDateStr);
      if (eBars && eBars.length > 0) {
        for (const b of eBars) {
          onHigh = Math.max(onHigh, b.high);
          onLow = Math.min(onLow, b.low);
          found = true;
        }
        break;
      }
    }
    const poBars = preOpenBars.get(day);
    if (poBars) {
      for (const b of poBars) {
        onHigh = Math.max(onHigh, b.high);
        onLow = Math.min(onLow, b.low);
        found = true;
      }
    }
    if (found) {
      overnightByDate.set(day, { on_high: onHigh, on_low: onLow });
    }
  }
  console.log(`  Computed overnight H/L for ${overnightByDate.size} days`);

  return { allDays, dvlByDate, acdByDate, barsByDate, overnightByDate };
}

// ═══════════════════════════════════════════════════════════════════════
// LEVEL COMPUTATION (same as full system)
// ═══════════════════════════════════════════════════════════════════════

function computeLevels(dayIdx, allDays, dvlByDate, acdByDate, barsByDate, overnightByDate) {
  const day = allDays[dayIdx].date;
  const levels = {};

  // Prior day levels
  let priorDvl = null;
  for (let i = dayIdx - 1; i >= 0; i--) {
    priorDvl = dvlByDate.get(allDays[i].date);
    if (priorDvl) break;
  }
  if (!priorDvl) return null;

  levels.PD_POC = priorDvl.poc;
  levels.PD_VAH = priorDvl.vah;
  levels.PD_VAL = priorDvl.val;

  // Floor pivots
  const pivots = floorPivots(priorDvl.session_high, priorDvl.session_low, priorDvl.session_close);
  levels.FLOOR_PIVOT = pivots.FLOOR_PIVOT;
  levels.FLOOR_R1 = pivots.FLOOR_R1;
  levels.FLOOR_S1 = pivots.FLOOR_S1;

  // Prior day IB
  let priorBars = null;
  for (let i = dayIdx - 1; i >= 0; i--) {
    priorBars = barsByDate.get(allDays[i].date);
    if (priorBars && priorBars.length > 0) break;
  }
  if (priorBars) {
    let pdIBHigh = -Infinity, pdIBLow = Infinity;
    for (const b of priorBars) {
      if (b.tod >= 570 && b.tod <= 629) {
        pdIBHigh = Math.max(pdIBHigh, b.high);
        pdIBLow = Math.min(pdIBLow, b.low);
      }
    }
    if (pdIBHigh > -Infinity) {
      levels.PD_IB_HIGH = pdIBHigh;
      levels.PD_IB_LOW = pdIBLow;
      levels.PD_IB_MID = (pdIBHigh + pdIBLow) / 2;
    }
  }

  // Overnight H/L
  const overnight = overnightByDate.get(day);
  if (overnight) {
    levels.ON_HIGH = overnight.on_high;
    levels.ON_LOW = overnight.on_low;
  }

  // Prior day session mid
  levels.PD_SESSION_MID = (priorDvl.session_high + priorDvl.session_low) / 2;

  // Today's OR (available after 10:00)
  const todayAcd = acdByDate.get(day);
  if (todayAcd) {
    levels.OR_HIGH = todayAcd.or_high;
    levels.OR_LOW = todayAcd.or_low;
    levels.OR_MID = (todayAcd.or_high + todayAcd.or_low) / 2;
  }

  return levels;
}

// ═══════════════════════════════════════════════════════════════════════
// TRADE SIMULATION — replays first-touch level fades
// ═══════════════════════════════════════════════════════════════════════

function simulateDay(bars, levels, todayAcd) {
  const trades = [];
  const touchedLevels = new Set();

  // Compute today's IB for IB_HIGH/IB_LOW levels
  let ibHigh = -Infinity, ibLow = Infinity;
  for (const b of bars) {
    if (b.tod >= 570 && b.tod <= 629) {
      ibHigh = Math.max(ibHigh, b.high);
      ibLow = Math.min(ibLow, b.low);
    }
  }
  if (ibHigh > -Infinity) {
    levels.IB_HIGH = ibHigh;
    levels.IB_LOW = ibLow;
    levels.IB_MID = (ibHigh + ibLow) / 2;
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Only allow IB levels after IB close (10:30 = tod 630)
    const pastIB = bar.tod >= 630;

    // Only allow OR levels after OR close (10:00 = tod 600)
    const pastOR = bar.tod >= 600;

    for (const [levelName, levelPrice] of Object.entries(levels)) {
      if (levelPrice == null || !isFinite(levelPrice)) continue;

      // Timing gates for intraday levels
      if ((levelName === 'IB_MID' || levelName === 'IB_HIGH' || levelName === 'IB_LOW') && !pastIB) continue;
      if ((levelName === 'OR_MID' || levelName === 'OR_HIGH' || levelName === 'OR_LOW') && !pastOR) continue;

      if (touchedLevels.has(levelName)) continue;

      // Touch check
      const touchesHigh = bar.high >= levelPrice - PROXIMITY && bar.high <= levelPrice + PROXIMITY;
      const touchesLow = bar.low >= levelPrice - PROXIMITY && bar.low <= levelPrice + PROXIMITY;
      if (!touchesHigh && !touchesLow) continue;

      // Determine fade direction
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
      let result = null, exitPrice = null, mae = 0, mfe = 0;

      for (let j = i + 1; j < bars.length; j++) {
        const fb = bars[j];
        if (direction === 'SHORT') {
          const adverse = fb.high - entryPrice;
          const favorable = entryPrice - fb.low;
          mae = Math.max(mae, adverse);
          mfe = Math.max(mfe, favorable);
          if (adverse >= FADE_STOP) { result = 'L'; exitPrice = entryPrice + FADE_STOP; break; }
          if (favorable >= FADE_TARGET) { result = 'W'; exitPrice = entryPrice - FADE_TARGET; break; }
        } else {
          const adverse = entryPrice - fb.low;
          const favorable = fb.high - entryPrice;
          mae = Math.max(mae, adverse);
          mfe = Math.max(mfe, favorable);
          if (adverse >= FADE_STOP) { result = 'L'; exitPrice = entryPrice - FADE_STOP; break; }
          if (favorable >= FADE_TARGET) { result = 'W'; exitPrice = entryPrice + FADE_TARGET; break; }
        }
      }

      if (result === null) {
        const lastBar = bars[bars.length - 1];
        if (direction === 'SHORT') {
          const pnl = entryPrice - lastBar.close;
          result = pnl >= 0 ? 'W' : 'L';
          exitPrice = lastBar.close;
        } else {
          const pnl = lastBar.close - entryPrice;
          result = pnl >= 0 ? 'W' : 'L';
          exitPrice = lastBar.close;
        }
      }

      let tradePnL;
      if (direction === 'SHORT') {
        tradePnL = (entryPrice - exitPrice) * PNL_PER_POINT - COMMISSION;
      } else {
        tradePnL = (exitPrice - entryPrice) * PNL_PER_POINT - COMMISSION;
      }

      trades.push({
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
// MAIN ANALYSIS
// ═══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('');
  console.log('================================================================');
  console.log('   DEEP MONDAY ANALYSIS: NQ Level Fade System');
  console.log('   40pt target / 90pt stop / first-touch / AM session');
  console.log('================================================================');
  console.log('');

  const { allDays, dvlByDate, acdByDate, barsByDate, overnightByDate } = await loadAllData();

  // ── Simulate every day ──
  const allResults = []; // { date, dow, trades[], dayPnL, gap, volume, range, ... }
  let skipped = 0;

  for (let di = 1; di < allDays.length; di++) {
    const dayObj = allDays[di];
    const day = dayObj.date;
    const dow = dayObj.dow; // 0=Sun, 1=Mon, ..., 5=Fri

    const levels = computeLevels(di, allDays, dvlByDate, acdByDate, barsByDate, overnightByDate);
    if (!levels) { skipped++; continue; }

    const bars = barsByDate.get(day);
    if (!bars || bars.length < 30) { skipped++; continue; }

    const todayAcd = acdByDate.get(day);
    const trades = simulateDay(bars, { ...levels }, todayAcd);

    // Compute gap: prior close vs today's open
    let priorDvl = null;
    for (let i = di - 1; i >= 0; i--) {
      priorDvl = dvlByDate.get(allDays[i].date);
      if (priorDvl) break;
    }
    const todayDvl = dvlByDate.get(day);
    const priorClose = priorDvl ? priorDvl.session_close : null;
    const rthOpen = bars[0].open;
    const gap = priorClose != null ? rthOpen - priorClose : null;
    const absGap = gap != null ? Math.abs(gap) : null;

    // Volume and range
    const totalVol = bars.reduce((s, b) => s + (b.volume || 0), 0);
    const sessionHigh = Math.max(...bars.map(b => b.high));
    const sessionLow = Math.min(...bars.map(b => b.low));
    const sessionRange = sessionHigh - sessionLow;

    // First-hour bars (9:30-10:30 = tod 570-629)
    const firstHourBars = bars.filter(b => b.tod >= 570 && b.tod <= 629);
    const firstHourHigh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null;
    const firstHourLow = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null;
    const firstHourRange = firstHourHigh != null ? firstHourHigh - firstHourLow : null;
    const firstHourVol = firstHourBars.reduce((s, b) => s + (b.volume || 0), 0);

    // Gap fill check: did price cross the prior close during RTH?
    let gapFilled = false;
    if (gap != null && priorClose != null) {
      if (gap > 0) {
        // Gap up: fills when price drops to/below prior close
        gapFilled = sessionLow <= priorClose;
      } else {
        // Gap down: fills when price rises to/above prior close
        gapFilled = sessionHigh >= priorClose;
      }
    }

    // Friday's data (for Part 6)
    let fridayData = null;
    // Find the most recent Friday before this Monday
    if (dow === 1) {
      for (let i = di - 1; i >= 0; i--) {
        if (allDays[i].dow === 5) {
          const fDay = allDays[i].date;
          const fDvl = dvlByDate.get(fDay);
          const fAcd = acdByDate.get(fDay);
          const fBars = barsByDate.get(fDay);
          if (fDvl && fBars && fBars.length > 0) {
            const fRange = fDvl.session_high - fDvl.session_low;
            const fVol = fBars.reduce((s, b) => s + (b.volume || 0), 0);
            // Determine if Friday was a trend day (range > 1.2x average)
            // We'll use simple heuristic: close near extreme
            const closeRelRange = fDvl.session_close != null ?
              (fDvl.session_close - fDvl.session_low) / (fDvl.session_high - fDvl.session_low) : 0.5;
            const isTrendUp = closeRelRange > 0.8;
            const isTrendDown = closeRelRange < 0.2;
            fridayData = {
              date: fDay,
              range: fRange,
              volume: fVol,
              closeRelRange,
              isTrendUp,
              isTrendDown,
              isBalance: !isTrendUp && !isTrendDown && closeRelRange >= 0.35 && closeRelRange <= 0.65,
              aDownFired: fAcd ? fAcd.a_down_fired : false,
              aUpFired: fAcd ? fAcd.a_up_fired : false,
            };
          }
          break;
        }
      }
    }

    // ACD status for the current day
    const aUpFired = todayAcd ? todayAcd.a_up_fired : false;
    const aDownFired = todayAcd ? todayAcd.a_down_fired : false;

    allResults.push({
      date: day,
      dow,
      trades,
      dayPnL: trades.reduce((s, t) => s + t.pnl, 0),
      gap,
      absGap,
      gapFilled,
      totalVol,
      sessionRange,
      firstHourRange,
      firstHourVol,
      priorClose,
      rthOpen,
      fridayData,
      aUpFired,
      aDownFired,
    });
  }

  console.log(`  Simulated ${allResults.length} days (${skipped} skipped)\n`);

  const mondays = allResults.filter(r => r.dow === 1);
  const nonMondays = allResults.filter(r => r.dow !== 1);
  const allDaysData = allResults;

  const mondayTrades = mondays.flatMap(r => r.trades);
  const nonMondayTrades = nonMondays.flatMap(r => r.trades);
  const allTrades = allResults.flatMap(r => r.trades);

  // ═══════════════════════════════════════════════════════════════════
  // BASELINE COMPARISON
  // ═══════════════════════════════════════════════════════════════════
  console.log('================================================================');
  console.log('   BASELINE: Monday vs Other Days');
  console.log('================================================================\n');

  function printDayStats(label, days, trades) {
    const wins = trades.filter(t => t.result === 'W');
    const losses = trades.filter(t => t.result === 'L');
    const avgPnL = trades.length ? mean(trades.map(t => t.pnl)) : 0;
    const avgDayPnL = days.length ? mean(days.map(d => d.dayPnL)) : 0;
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${label}:`);
    console.log(`    Days: ${days.length} | Trades: ${trades.length} (${fmt(trades.length / Math.max(days.length, 1), 1)}/day)`);
    console.log(`    WR: ${pctStr(wins.length, trades.length)} (${wins.length}W / ${losses.length}L)`);
    console.log(`    Avg P&L/trade: $${fmt(avgPnL, 2)} | Avg P&L/day: $${fmt(avgDayPnL, 2)}`);
    console.log(`    Total P&L: $${fmt(totalPnL, 2)}`);
    console.log('');
  }

  printDayStats('MONDAY', mondays, mondayTrades);
  printDayStats('NON-MONDAY', nonMondays, nonMondayTrades);
  printDayStats('ALL DAYS', allResults, allTrades);

  // Per-DOW breakdown
  console.log('  Per Day-of-Week:');
  console.log('  ' + pad('DOW', 12) + rpad('Days', 6) + rpad('Trades', 8) + rpad('WR', 8) + rpad('Avg$/trade', 12) + rpad('Avg$/day', 10) + rpad('Total$', 10));
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const d of [1, 2, 3, 4, 5]) {
    const dDays = allResults.filter(r => r.dow === d);
    const dTrades = dDays.flatMap(r => r.trades);
    const dWins = dTrades.filter(t => t.result === 'W').length;
    const dTotal = dTrades.reduce((s, t) => s + t.pnl, 0);
    console.log('  ' + pad(dowNames[d], 12) + rpad(dDays.length, 6) + rpad(dTrades.length, 8) +
      rpad(pctStr(dWins, dTrades.length), 8) +
      rpad('$' + fmt(dTrades.length ? mean(dTrades.map(t => t.pnl)) : 0, 2), 12) +
      rpad('$' + fmt(dDays.length ? mean(dDays.map(d => d.dayPnL)) : 0, 2), 10) +
      rpad('$' + fmt(dTotal, 2), 10));
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // PART 1: WHICH LEVELS ARE MONEY DESTROYERS ON MONDAY?
  // ═══════════════════════════════════════════════════════════════════
  console.log('================================================================');
  console.log('   PART 1: Level-by-Level Monday Performance');
  console.log('================================================================\n');

  // Collect all level names
  const levelNames = [...new Set(allTrades.map(t => t.level))].sort();

  console.log('  ' + pad('Level', 18) + rpad('Mon N', 7) + rpad('Mon WR', 8) + rpad('Mon $/tr', 10) +
    rpad('Mon Tot$', 10) + ' | ' + rpad('All N', 7) + rpad('All WR', 8) + rpad('All $/tr', 10) +
    rpad('Gap', 8));
  console.log('  ' + '-'.repeat(100));

  const levelMonday = new Map();
  for (const level of levelNames) {
    const monTrades = mondayTrades.filter(t => t.level === level);
    const allLevelTrades = allTrades.filter(t => t.level === level);
    const monWins = monTrades.filter(t => t.result === 'W').length;
    const allWins = allLevelTrades.filter(t => t.result === 'W').length;
    const monWR = monTrades.length ? monWins / monTrades.length : 0;
    const allWR = allLevelTrades.length ? allWins / allLevelTrades.length : 0;
    const gap = monWR - allWR;
    const monAvg = monTrades.length ? mean(monTrades.map(t => t.pnl)) : 0;
    const allAvg = allLevelTrades.length ? mean(allLevelTrades.map(t => t.pnl)) : 0;
    const monTotal = monTrades.reduce((s, t) => s + t.pnl, 0);

    levelMonday.set(level, { monWR, allWR, gap, monN: monTrades.length, monTotal, monAvg });

    console.log('  ' + pad(level, 18) +
      rpad(monTrades.length, 7) +
      rpad(pctStr(monWins, monTrades.length), 8) +
      rpad('$' + fmt(monAvg, 2), 10) +
      rpad('$' + fmt(monTotal, 2), 10) + ' | ' +
      rpad(allLevelTrades.length, 7) +
      rpad(pctStr(allWins, allLevelTrades.length), 8) +
      rpad('$' + fmt(allAvg, 2), 10) +
      rpad((gap >= 0 ? '+' : '') + fmt(gap * 100, 1) + '%', 8));
  }

  // Rank worst to best
  const sortedByGap = [...levelMonday.entries()].sort((a, b) => a[1].gap - b[1].gap);
  console.log('\n  WORST MONDAY LEVELS (biggest WR gap vs overall):');
  for (const [level, stats] of sortedByGap.slice(0, 5)) {
    if (stats.monN === 0) continue;
    console.log(`    ${pad(level, 18)} Monday WR ${pctStr(stats.monWR * 100, 100)} vs Overall ${pctStr(stats.allWR * 100, 100)} = ${(stats.gap * 100 >= 0 ? '+' : '') + fmt(stats.gap * 100, 1)}% gap | Monday P&L: $${fmt(stats.monTotal, 2)}`);
  }
  console.log('\n  BEST MONDAY LEVELS (smallest gap or positive):');
  for (const [level, stats] of sortedByGap.slice(-5).reverse()) {
    if (stats.monN === 0) continue;
    console.log(`    ${pad(level, 18)} Monday WR ${pctStr(stats.monWR * 100, 100)} vs Overall ${pctStr(stats.allWR * 100, 100)} = ${(stats.gap * 100 >= 0 ? '+' : '') + fmt(stats.gap * 100, 1)}% gap | Monday P&L: $${fmt(stats.monTotal, 2)}`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // PART 2: TIME WINDOWS ON MONDAY
  // ═══════════════════════════════════════════════════════════════════
  console.log('================================================================');
  console.log('   PART 2: Monday Time Windows');
  console.log('================================================================\n');

  const windows = [
    { label: '9:30-10:00', minTod: 570, maxTod: 599 },
    { label: '10:00-10:30', minTod: 600, maxTod: 629 },
    { label: '10:30-11:00', minTod: 630, maxTod: 659 },
    { label: '11:00-12:00', minTod: 660, maxTod: 719 },
    { label: '12:00+', minTod: 720, maxTod: 959 },
  ];

  console.log('  MONDAY:');
  console.log('  ' + pad('Window', 16) + rpad('N', 6) + rpad('WR', 8) + rpad('$/trade', 10) + rpad('Total$', 10) + rpad('Avg MAE', 10) + rpad('Avg MFE', 10));
  console.log('  ' + '-'.repeat(70));
  for (const w of windows) {
    const wTrades = mondayTrades.filter(t => t.tod >= w.minTod && t.tod <= w.maxTod);
    const wWins = wTrades.filter(t => t.result === 'W').length;
    const wPnL = wTrades.reduce((s, t) => s + t.pnl, 0);
    console.log('  ' + pad(w.label, 16) + rpad(wTrades.length, 6) +
      rpad(pctStr(wWins, wTrades.length), 8) +
      rpad('$' + fmt(wTrades.length ? mean(wTrades.map(t => t.pnl)) : 0, 2), 10) +
      rpad('$' + fmt(wPnL, 2), 10) +
      rpad(fmt(wTrades.length ? mean(wTrades.map(t => t.mae)) : 0, 1), 10) +
      rpad(fmt(wTrades.length ? mean(wTrades.map(t => t.mfe)) : 0, 1), 10));
  }

  console.log('\n  ALL DAYS (for comparison):');
  console.log('  ' + pad('Window', 16) + rpad('N', 6) + rpad('WR', 8) + rpad('$/trade', 10) + rpad('Total$', 10));
  console.log('  ' + '-'.repeat(50));
  for (const w of windows) {
    const wTrades = allTrades.filter(t => t.tod >= w.minTod && t.tod <= w.maxTod);
    const wWins = wTrades.filter(t => t.result === 'W').length;
    const wPnL = wTrades.reduce((s, t) => s + t.pnl, 0);
    console.log('  ' + pad(w.label, 16) + rpad(wTrades.length, 6) +
      rpad(pctStr(wWins, wTrades.length), 8) +
      rpad('$' + fmt(wTrades.length ? mean(wTrades.map(t => t.pnl)) : 0, 2), 10) +
      rpad('$' + fmt(wPnL, 2), 10));
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // PART 3: GAP IMPACT
  // ═══════════════════════════════════════════════════════════════════
  console.log('================================================================');
  console.log('   PART 3: Weekend Gap Impact on Monday Level Fades');
  console.log('================================================================\n');

  const mondaysWithGap = mondays.filter(m => m.gap != null);
  const bigGap = mondaysWithGap.filter(m => m.absGap > 100);
  const smallGap = mondaysWithGap.filter(m => m.absGap <= 100);
  const gapUp = mondaysWithGap.filter(m => m.gap > 0);
  const gapDown = mondaysWithGap.filter(m => m.gap < 0);

  console.log(`  Mondays with gap data: ${mondaysWithGap.length}`);
  console.log(`  Avg weekend gap: ${fmt(mean(mondaysWithGap.map(m => m.absGap)), 1)}pt`);
  console.log(`  Median weekend gap: ${fmt(median(mondaysWithGap.map(m => m.absGap)), 1)}pt`);
  console.log(`  Gap > 100pt: ${bigGap.length} days (${pctStr(bigGap.length, mondaysWithGap.length)})`);
  console.log(`  Gap <= 100pt: ${smallGap.length} days (${pctStr(smallGap.length, mondaysWithGap.length)})`);
  console.log('');

  function printGapBucket(label, days) {
    const trades = days.flatMap(d => d.trades);
    const wins = trades.filter(t => t.result === 'W').length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const avgDay = days.length ? mean(days.map(d => d.dayPnL)) : 0;
    console.log(`  ${pad(label, 25)} Days: ${rpad(days.length, 4)} | Trades: ${rpad(trades.length, 5)} | WR: ${rpad(pctStr(wins, trades.length), 7)} | $/day: $${rpad(fmt(avgDay, 2), 8)} | Total: $${fmt(total, 2)}`);
  }

  printGapBucket('Gap > 100pt', bigGap);
  printGapBucket('Gap <= 100pt', smallGap);
  printGapBucket('Gap UP', gapUp);
  printGapBucket('Gap DOWN', gapDown);
  printGapBucket('Big Gap UP (>100)', mondaysWithGap.filter(m => m.gap > 100));
  printGapBucket('Big Gap DOWN (>100)', mondaysWithGap.filter(m => m.gap < -100));
  printGapBucket('Small Gap UP (<=100)', mondaysWithGap.filter(m => m.gap > 0 && m.absGap <= 100));
  printGapBucket('Small Gap DOWN (<=100)', mondaysWithGap.filter(m => m.gap < 0 && m.absGap <= 100));
  console.log('');

  // Gap fill analysis
  const filled = mondaysWithGap.filter(m => m.gapFilled);
  const unfilled = mondaysWithGap.filter(m => !m.gapFilled);
  console.log(`  Gap Fill Rate: ${pctStr(filled.length, mondaysWithGap.length)} (${filled.length}/${mondaysWithGap.length})`);
  printGapBucket('Gap FILLED', filled);
  printGapBucket('Gap NOT FILLED', unfilled);
  console.log('');

  // Gap size buckets
  console.log('  Gap Size Buckets:');
  const gapBuckets = [
    { label: '0-50pt', min: 0, max: 50 },
    { label: '50-100pt', min: 50, max: 100 },
    { label: '100-150pt', min: 100, max: 150 },
    { label: '150-200pt', min: 150, max: 200 },
    { label: '200-300pt', min: 200, max: 300 },
    { label: '300+pt', min: 300, max: 99999 },
  ];
  for (const b of gapBuckets) {
    const bDays = mondaysWithGap.filter(m => m.absGap >= b.min && m.absGap < b.max);
    if (bDays.length > 0) printGapBucket(`  ${b.label}`, bDays);
  }
  console.log('');

  // After gap fill — do fades work better?
  // For each Monday where gap fills, check performance of trades BEFORE vs AFTER the fill
  console.log('  Fade Performance: Before vs After Gap Fill (on gap-filled Mondays):');
  let preGapFillTrades = [];
  let postGapFillTrades = [];
  for (const m of filled) {
    const bars = barsByDate.get(m.date);
    if (!bars || m.priorClose == null) continue;
    // Find the bar where gap fills
    let fillTod = null;
    for (const b of bars) {
      if (m.gap > 0 && b.low <= m.priorClose) { fillTod = b.tod; break; }
      if (m.gap < 0 && b.high >= m.priorClose) { fillTod = b.tod; break; }
    }
    if (fillTod == null) continue;
    for (const t of m.trades) {
      if (t.tod < fillTod) preGapFillTrades.push(t);
      else postGapFillTrades.push(t);
    }
  }
  if (preGapFillTrades.length > 0 || postGapFillTrades.length > 0) {
    const preW = preGapFillTrades.filter(t => t.result === 'W').length;
    const postW = postGapFillTrades.filter(t => t.result === 'W').length;
    console.log(`    Before fill: ${preGapFillTrades.length} trades, WR ${pctStr(preW, preGapFillTrades.length)}, Avg $${fmt(mean(preGapFillTrades.map(t => t.pnl)), 2)}`);
    console.log(`    After fill:  ${postGapFillTrades.length} trades, WR ${pctStr(postW, postGapFillTrades.length)}, Avg $${fmt(mean(postGapFillTrades.map(t => t.pnl)), 2)}`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // PART 4: VOLUME AND RANGE
  // ═══════════════════════════════════════════════════════════════════
  console.log('================================================================');
  console.log('   PART 4: Volume and Range Analysis');
  console.log('================================================================\n');

  function volRangeStats(label, days) {
    const vols = days.map(d => d.totalVol);
    const ranges = days.map(d => d.sessionRange);
    const fhRanges = days.map(d => d.firstHourRange).filter(r => r != null);
    const fhVols = days.map(d => d.firstHourVol);
    return {
      label,
      avgVol: mean(vols),
      medVol: median(vols),
      avgRange: mean(ranges),
      medRange: median(ranges),
      avgFHRange: mean(fhRanges),
      medFHRange: median(fhRanges),
      avgFHVol: mean(fhVols),
    };
  }

  const monStats = volRangeStats('Monday', mondays);
  const nonMonStats = volRangeStats('Non-Monday', nonMondays);
  const allStats = volRangeStats('All Days', allResults);

  console.log('  ' + pad('', 14) + rpad('Avg Vol', 12) + rpad('Med Vol', 12) + rpad('Avg Range', 12) + rpad('Med Range', 12) + rpad('Avg FH Rng', 12) + rpad('Avg FH Vol', 12));
  console.log('  ' + '-'.repeat(86));
  for (const s of [monStats, nonMonStats, allStats]) {
    console.log('  ' + pad(s.label, 14) +
      rpad(Math.round(s.avgVol).toLocaleString(), 12) +
      rpad(Math.round(s.medVol).toLocaleString(), 12) +
      rpad(fmt(s.avgRange, 1), 12) +
      rpad(fmt(s.medRange, 1), 12) +
      rpad(fmt(s.avgFHRange, 1), 12) +
      rpad(Math.round(s.avgFHVol).toLocaleString(), 12));
  }
  console.log('');

  // Does first-hour range predict Monday quality?
  const monFHRanges = mondays.filter(m => m.firstHourRange != null);
  const medianFHR = median(monFHRanges.map(m => m.firstHourRange));
  const narrowFH = monFHRanges.filter(m => m.firstHourRange <= medianFHR);
  const wideFH = monFHRanges.filter(m => m.firstHourRange > medianFHR);

  console.log(`  Monday First-Hour Range Median: ${fmt(medianFHR, 1)}pt`);
  console.log(`  Narrow 1st Hour (<= ${fmt(medianFHR, 1)}pt):`);
  const narrowTr = narrowFH.flatMap(d => d.trades);
  const narrowW = narrowTr.filter(t => t.result === 'W').length;
  console.log(`    ${narrowFH.length} days, ${narrowTr.length} trades, WR ${pctStr(narrowW, narrowTr.length)}, Avg $/day: $${fmt(mean(narrowFH.map(d => d.dayPnL)), 2)}`);

  console.log(`  Wide 1st Hour (> ${fmt(medianFHR, 1)}pt):`);
  const wideTr = wideFH.flatMap(d => d.trades);
  const wideW = wideTr.filter(t => t.result === 'W').length;
  console.log(`    ${wideFH.length} days, ${wideTr.length} trades, WR ${pctStr(wideW, wideTr.length)}, Avg $/day: $${fmt(mean(wideFH.map(d => d.dayPnL)), 2)}`);

  // Volume analysis: low vs high volume Mondays
  const medianVol = median(mondays.map(m => m.totalVol));
  const lowVolMon = mondays.filter(m => m.totalVol <= medianVol);
  const highVolMon = mondays.filter(m => m.totalVol > medianVol);
  console.log(`\n  Monday Volume Median: ${Math.round(medianVol).toLocaleString()}`);
  console.log(`  Low Volume Mondays (<= median):`);
  const lowTr = lowVolMon.flatMap(d => d.trades);
  const lowW = lowTr.filter(t => t.result === 'W').length;
  console.log(`    ${lowVolMon.length} days, ${lowTr.length} trades, WR ${pctStr(lowW, lowTr.length)}, Avg $/day: $${fmt(mean(lowVolMon.map(d => d.dayPnL)), 2)}`);
  console.log(`  High Volume Mondays (> median):`);
  const hiTr = highVolMon.flatMap(d => d.trades);
  const hiW = hiTr.filter(t => t.result === 'W').length;
  console.log(`    ${highVolMon.length} days, ${hiTr.length} trades, WR ${pctStr(hiW, hiTr.length)}, Avg $/day: $${fmt(mean(highVolMon.map(d => d.dayPnL)), 2)}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // PART 5: WHAT IF YOU WAITED?
  // ═══════════════════════════════════════════════════════════════════
  console.log('================================================================');
  console.log('   PART 5: Skip-Morning Scenarios (Monday Only)');
  console.log('================================================================\n');

  // Re-simulate Mondays with different start times
  function simulateMondayWithStartTime(startTod, label) {
    let totalTrades = 0, totalWins = 0, totalPnL = 0;
    let skippedTrades = 0, skippedPnL = 0, skippedWins = 0;
    const dayPnLs = [];

    for (const m of mondays) {
      const bars = barsByDate.get(m.date);
      if (!bars || bars.length < 30) continue;

      // All trades (full day, unconstrained)
      const fullTrades = m.trades;

      // Trades that would fire BEFORE the start time (skipped)
      const skippedT = fullTrades.filter(t => t.tod < startTod);
      const keptT = fullTrades.filter(t => t.tod >= startTod);

      totalTrades += keptT.length;
      totalWins += keptT.filter(t => t.result === 'W').length;
      const dayP = keptT.reduce((s, t) => s + t.pnl, 0);
      totalPnL += dayP;
      dayPnLs.push(dayP);

      skippedTrades += skippedT.length;
      skippedWins += skippedT.filter(t => t.result === 'W').length;
      skippedPnL += skippedT.reduce((s, t) => s + t.pnl, 0);
    }

    return { label, totalTrades, totalWins, totalPnL, dayPnLs, skippedTrades, skippedWins, skippedPnL };
  }

  // But we need to re-simulate properly because skipping early touches changes
  // which levels are still "first touch" later. Let me re-simulate from scratch.
  function reSimulateMondaysFromTod(startTod) {
    let totalTrades = 0, totalWins = 0, totalPnL = 0;
    let skippedTouchCount = 0;
    const dayPnLs = [];
    const keptTrades = [];

    for (const m of mondays) {
      const bars = barsByDate.get(m.date);
      if (!bars || bars.length < 30) continue;

      const dayObj = allDays.find(d => d.date === m.date);
      if (!dayObj) continue;
      const di = allDays.indexOf(dayObj);

      const levels = computeLevels(di, allDays, dvlByDate, acdByDate, barsByDate, overnightByDate);
      if (!levels) continue;

      const todayAcd = acdByDate.get(m.date);

      // Compute IB levels
      let ibHigh = -Infinity, ibLow = Infinity;
      for (const b of bars) {
        if (b.tod >= 570 && b.tod <= 629) {
          ibHigh = Math.max(ibHigh, b.high);
          ibLow = Math.min(ibLow, b.low);
        }
      }
      if (ibHigh > -Infinity) {
        levels.IB_HIGH = ibHigh;
        levels.IB_LOW = ibLow;
        levels.IB_MID = (ibHigh + ibLow) / 2;
      }

      if (todayAcd) {
        levels.OR_HIGH = todayAcd.or_high;
        levels.OR_LOW = todayAcd.or_low;
        levels.OR_MID = (todayAcd.or_high + todayAcd.or_low) / 2;
      }

      // Simulate from startTod onwards, but track touches before startTod
      // to know which levels were already "consumed"
      const touchedBefore = new Set();
      const touchedAfter = new Set();

      // Scan bars before startTod to find which levels got touched
      for (const bar of bars) {
        if (bar.tod >= startTod) break;
        for (const [levelName, levelPrice] of Object.entries(levels)) {
          if (levelPrice == null || !isFinite(levelPrice)) continue;
          if (touchedBefore.has(levelName)) continue;
          const touchesHigh = bar.high >= levelPrice - PROXIMITY && bar.high <= levelPrice + PROXIMITY;
          const touchesLow = bar.low >= levelPrice - PROXIMITY && bar.low <= levelPrice + PROXIMITY;
          if (touchesHigh || touchesLow) {
            touchedBefore.add(levelName);
            skippedTouchCount++;
          }
        }
      }

      // Now simulate from startTod — only untouched levels are valid
      const dayTrades = [];
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        if (bar.tod < startTod) continue;

        const pastIB = bar.tod >= 630;
        const pastOR = bar.tod >= 600;

        for (const [levelName, levelPrice] of Object.entries(levels)) {
          if (levelPrice == null || !isFinite(levelPrice)) continue;
          if ((levelName === 'IB_MID' || levelName === 'IB_HIGH' || levelName === 'IB_LOW') && !pastIB) continue;
          if ((levelName === 'OR_MID' || levelName === 'OR_HIGH' || levelName === 'OR_LOW') && !pastOR) continue;
          if (touchedBefore.has(levelName)) continue;
          if (touchedAfter.has(levelName)) continue;

          const touchesHigh = bar.high >= levelPrice - PROXIMITY && bar.high <= levelPrice + PROXIMITY;
          const touchesLow = bar.low >= levelPrice - PROXIMITY && bar.low <= levelPrice + PROXIMITY;
          if (!touchesHigh && !touchesLow) continue;

          let direction;
          if (touchesHigh && bar.high >= levelPrice) direction = 'SHORT';
          else if (touchesLow && bar.low <= levelPrice) direction = 'LONG';
          else continue;

          touchedAfter.add(levelName);

          const entryPrice = levelPrice;
          let result = null, exitPrice = null;
          for (let j = i + 1; j < bars.length; j++) {
            const fb = bars[j];
            if (direction === 'SHORT') {
              if (fb.high - entryPrice >= FADE_STOP) { result = 'L'; exitPrice = entryPrice + FADE_STOP; break; }
              if (entryPrice - fb.low >= FADE_TARGET) { result = 'W'; exitPrice = entryPrice - FADE_TARGET; break; }
            } else {
              if (entryPrice - fb.low >= FADE_STOP) { result = 'L'; exitPrice = entryPrice - FADE_STOP; break; }
              if (fb.high - entryPrice >= FADE_TARGET) { result = 'W'; exitPrice = entryPrice + FADE_TARGET; break; }
            }
          }
          if (result === null) {
            const lastBar = bars[bars.length - 1];
            if (direction === 'SHORT') {
              result = entryPrice - lastBar.close >= 0 ? 'W' : 'L';
              exitPrice = lastBar.close;
            } else {
              result = lastBar.close - entryPrice >= 0 ? 'W' : 'L';
              exitPrice = lastBar.close;
            }
          }

          let tradePnL = direction === 'SHORT'
            ? (entryPrice - exitPrice) * PNL_PER_POINT - COMMISSION
            : (exitPrice - entryPrice) * PNL_PER_POINT - COMMISSION;

          dayTrades.push({ level: levelName, result, pnl: tradePnL, tod: bar.tod });
        }
      }

      const dayP = dayTrades.reduce((s, t) => s + t.pnl, 0);
      totalTrades += dayTrades.length;
      totalWins += dayTrades.filter(t => t.result === 'W').length;
      totalPnL += dayP;
      dayPnLs.push(dayP);
      keptTrades.push(...dayTrades);
    }

    return { totalTrades, totalWins, totalPnL, dayPnLs, skippedTouchCount, keptTrades };
  }

  // Current: full day
  const fullDay = reSimulateMondaysFromTod(570);
  // Skip first 30 min (start at 10:00)
  const skip30 = reSimulateMondaysFromTod(600);
  // Skip to IB close (start at 10:30)
  const skipIB = reSimulateMondaysFromTod(630);
  // Skip to 11:00
  const skip90 = reSimulateMondaysFromTod(660);

  function printScenario(label, data) {
    const avgDay = data.dayPnLs.length ? mean(data.dayPnLs) : 0;
    console.log(`  ${pad(label, 28)} Trades: ${rpad(data.totalTrades, 5)} | WR: ${rpad(pctStr(data.totalWins, data.totalTrades), 7)} | Avg $/day: $${rpad(fmt(avgDay, 2), 8)} | Total: $${fmt(data.totalPnL, 2)}`);
  }

  printScenario('Full Day (9:30+)', fullDay);
  printScenario('Skip to 10:00', skip30);
  printScenario('Skip to IB Close (10:30)', skipIB);
  printScenario('Skip to 11:00', skip90);

  console.log('\n  Improvement vs Full Day:');
  for (const [label, data] of [['10:00 start', skip30], ['10:30 start', skipIB], ['11:00 start', skip90]]) {
    const wrDelta = (data.totalTrades > 0 ? data.totalWins / data.totalTrades : 0) -
                    (fullDay.totalTrades > 0 ? fullDay.totalWins / fullDay.totalTrades : 0);
    const pnlDelta = data.totalPnL - fullDay.totalPnL;
    const avgDelta = (data.dayPnLs.length ? mean(data.dayPnLs) : 0) -
                     (fullDay.dayPnLs.length ? mean(fullDay.dayPnLs) : 0);
    console.log(`    ${pad(label, 20)} WR: ${wrDelta >= 0 ? '+' : ''}${fmt(wrDelta * 100, 1)}% | P&L: ${pnlDelta >= 0 ? '+' : ''}$${fmt(pnlDelta, 2)} | Avg $/day: ${avgDelta >= 0 ? '+' : ''}$${fmt(avgDelta, 2)}`);
  }

  // What morning trades are being skipped?
  console.log('\n  Morning Trades Being Skipped (9:30-10:00 on Monday):');
  const morningTrades = mondayTrades.filter(t => t.tod >= 570 && t.tod < 600);
  const morningByLevel = new Map();
  for (const t of morningTrades) {
    if (!morningByLevel.has(t.level)) morningByLevel.set(t.level, []);
    morningByLevel.get(t.level).push(t);
  }
  console.log('  ' + pad('Level', 18) + rpad('N', 6) + rpad('WR', 8) + rpad('Avg$', 10) + rpad('Total$', 10));
  for (const [level, trades] of [...morningByLevel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const w = trades.filter(t => t.result === 'W').length;
    console.log('  ' + pad(level, 18) + rpad(trades.length, 6) +
      rpad(pctStr(w, trades.length), 8) +
      rpad('$' + fmt(mean(trades.map(t => t.pnl)), 2), 10) +
      rpad('$' + fmt(trades.reduce((s, t) => s + t.pnl, 0), 2), 10));
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // PART 6: MONDAY AFTER A BIG FRIDAY
  // ═══════════════════════════════════════════════════════════════════
  console.log('================================================================');
  console.log('   PART 6: Friday Carryover Effects on Monday');
  console.log('================================================================\n');

  const mondaysWithFriday = mondays.filter(m => m.fridayData != null);
  console.log(`  Mondays with prior Friday data: ${mondaysWithFriday.length}\n`);

  function printFridayBucket(label, days) {
    const trades = days.flatMap(d => d.trades);
    const wins = trades.filter(t => t.result === 'W').length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const avgDay = days.length ? mean(days.map(d => d.dayPnL)) : 0;
    console.log(`  ${pad(label, 30)} Days: ${rpad(days.length, 4)} | WR: ${rpad(pctStr(wins, trades.length), 7)} | Avg $/day: $${rpad(fmt(avgDay, 2), 8)} | Total: $${fmt(total, 2)}`);
  }

  // Friday was trend up
  printFridayBucket('Fri TREND UP', mondaysWithFriday.filter(m => m.fridayData.isTrendUp));
  printFridayBucket('Fri TREND DOWN', mondaysWithFriday.filter(m => m.fridayData.isTrendDown));
  printFridayBucket('Fri BALANCE', mondaysWithFriday.filter(m => m.fridayData.isBalance));
  printFridayBucket('Fri NEITHER (choppy)', mondaysWithFriday.filter(m => !m.fridayData.isTrendUp && !m.fridayData.isTrendDown && !m.fridayData.isBalance));

  console.log('');

  // Friday A signals
  printFridayBucket('Fri A Down fired', mondaysWithFriday.filter(m => m.fridayData.aDownFired));
  printFridayBucket('Fri A Up fired', mondaysWithFriday.filter(m => m.fridayData.aUpFired));
  printFridayBucket('Fri A Down + Trend Down', mondaysWithFriday.filter(m => m.fridayData.aDownFired && m.fridayData.isTrendDown));
  printFridayBucket('Fri no A signal', mondaysWithFriday.filter(m => !m.fridayData.aDownFired && !m.fridayData.aUpFired));

  console.log('');

  // Friday range
  const medFriRange = median(mondaysWithFriday.map(m => m.fridayData.range));
  const bigFriRange = mondaysWithFriday.filter(m => m.fridayData.range > 500);
  const normalFriRange = mondaysWithFriday.filter(m => m.fridayData.range <= 500);
  const wideFriRange = mondaysWithFriday.filter(m => m.fridayData.range > medFriRange);
  const narrowFriRange = mondaysWithFriday.filter(m => m.fridayData.range <= medFriRange);

  console.log(`  Friday range median: ${fmt(medFriRange, 1)}pt`);
  printFridayBucket('Fri Range > 500pt', bigFriRange);
  printFridayBucket('Fri Range <= 500pt', normalFriRange);
  printFridayBucket('Fri Wide Range (>median)', wideFriRange);
  printFridayBucket('Fri Narrow Range (<=med)', narrowFriRange);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // PART 7: THE MONDAY PLAYBOOK
  // ═══════════════════════════════════════════════════════════════════
  console.log('================================================================');
  console.log('   PART 7: OPTIMAL MONDAY PLAYBOOK');
  console.log('================================================================\n');

  // 1. Identify good and bad levels for Monday
  console.log('  RULE 1: LEVEL SELECTION');
  console.log('  -----------------------');

  const goodLevels = [];
  const badLevels = [];
  const neutralLevels = [];
  for (const [level, stats] of levelMonday.entries()) {
    if (stats.monN < 5) continue; // need sample size
    const wr = stats.monWR;
    const ev = stats.monAvg;
    // GOOD: WR >= 70% AND positive EV — genuine Monday edge
    if (wr >= 0.70 && ev > 0) {
      goodLevels.push({ level, ...stats });
    // BAD: WR < 55% OR heavily negative EV — money destroyers
    } else if (wr < 0.55 || ev < -20) {
      badLevels.push({ level, ...stats });
    } else {
      neutralLevels.push({ level, ...stats });
    }
  }

  console.log('  TRADE these levels on Monday (WR >= 50% or +EV):');
  for (const l of goodLevels.sort((a, b) => b.monWR - a.monWR)) {
    console.log(`    ${pad(l.level, 18)} WR: ${pctStr(l.monWR * 100, 100)} | $/trade: $${fmt(l.monAvg, 2)} | N=${l.monN}`);
  }
  console.log('  AVOID these levels on Monday (WR < 40% or heavily -EV):');
  for (const l of badLevels.sort((a, b) => a.monWR - b.monWR)) {
    console.log(`    ${pad(l.level, 18)} WR: ${pctStr(l.monWR * 100, 100)} | $/trade: $${fmt(l.monAvg, 2)} | N=${l.monN}`);
  }
  console.log('  NEUTRAL (marginal edge, proceed with caution):');
  for (const l of neutralLevels.sort((a, b) => b.monWR - a.monWR)) {
    console.log(`    ${pad(l.level, 18)} WR: ${pctStr(l.monWR * 100, 100)} | $/trade: $${fmt(l.monAvg, 2)} | N=${l.monN}`);
  }
  console.log('');

  // 2. Optimal start time
  console.log('  RULE 2: OPTIMAL START TIME');
  console.log('  --------------------------');
  const scenarios = [
    { label: '9:30 (full day)', data: fullDay },
    { label: '10:00', data: skip30 },
    { label: '10:30 (IB close)', data: skipIB },
    { label: '11:00', data: skip90 },
  ];
  let bestScenario = scenarios[0];
  for (const s of scenarios) {
    const avgDay = s.data.dayPnLs.length ? mean(s.data.dayPnLs) : 0;
    if (avgDay > (bestScenario.data.dayPnLs.length ? mean(bestScenario.data.dayPnLs) : 0)) {
      bestScenario = s;
    }
  }
  const bestAvg = bestScenario.data.dayPnLs.length ? mean(bestScenario.data.dayPnLs) : 0;
  const fullAvg = fullDay.dayPnLs.length ? mean(fullDay.dayPnLs) : 0;
  console.log(`  Best start time: ${bestScenario.label}`);
  console.log(`  Avg $/day at ${bestScenario.label}: $${fmt(bestAvg, 2)} vs full day: $${fmt(fullAvg, 2)}`);
  console.log(`  Improvement: $${fmt(bestAvg - fullAvg, 2)}/day`);
  console.log('');

  // 3. Stop/target adjustments
  console.log('  RULE 3: STOP/TARGET ADJUSTMENTS');
  console.log('  --------------------------------');
  const monMAE = mondayTrades.length ? mean(mondayTrades.map(t => t.mae)) : 0;
  const monMFE = mondayTrades.length ? mean(mondayTrades.map(t => t.mfe)) : 0;
  const allMAE = allTrades.length ? mean(allTrades.map(t => t.mae)) : 0;
  const allMFE = allTrades.length ? mean(allTrades.map(t => t.mfe)) : 0;
  const monMAEW = mondayTrades.filter(t => t.result === 'W');
  const monMAEL = mondayTrades.filter(t => t.result === 'L');
  console.log(`  Monday MAE: ${fmt(monMAE, 1)}pt (all days: ${fmt(allMAE, 1)}pt)`);
  console.log(`  Monday MFE: ${fmt(monMFE, 1)}pt (all days: ${fmt(allMFE, 1)}pt)`);
  if (monMAEW.length) console.log(`  Monday WINNERS: Avg MAE ${fmt(mean(monMAEW.map(t => t.mae)), 1)}pt, Avg MFE ${fmt(mean(monMAEW.map(t => t.mfe)), 1)}pt`);
  if (monMAEL.length) console.log(`  Monday LOSERS:  Avg MAE ${fmt(mean(monMAEL.map(t => t.mae)), 1)}pt, Avg MFE ${fmt(mean(monMAEL.map(t => t.mfe)), 1)}pt`);

  // Test alternative targets for Monday
  console.log('\n  Alternative Target/Stop Tests (Monday only, all levels):');
  const altConfigs = [
    { target: 30, stop: 90, label: '30pt T / 90pt S' },
    { target: 40, stop: 90, label: '40pt T / 90pt S (current)' },
    { target: 50, stop: 90, label: '50pt T / 90pt S' },
    { target: 40, stop: 60, label: '40pt T / 60pt S' },
    { target: 30, stop: 60, label: '30pt T / 60pt S' },
    { target: 25, stop: 50, label: '25pt T / 50pt S' },
  ];

  for (const cfg of altConfigs) {
    // Re-simulate Monday trades with different bracket
    let altWins = 0, altLosses = 0, altPnL = 0;
    for (const m of mondays) {
      const bars = barsByDate.get(m.date);
      if (!bars || bars.length < 30) continue;

      const dayObj = allDays.find(d => d.date === m.date);
      if (!dayObj) continue;
      const di = allDays.indexOf(dayObj);

      const levels = computeLevels(di, allDays, dvlByDate, acdByDate, barsByDate, overnightByDate);
      if (!levels) continue;
      const todayAcd = acdByDate.get(m.date);

      // Copy levels object
      const lvls = { ...levels };
      let ibH = -Infinity, ibL = Infinity;
      for (const b of bars) {
        if (b.tod >= 570 && b.tod <= 629) { ibH = Math.max(ibH, b.high); ibL = Math.min(ibL, b.low); }
      }
      if (ibH > -Infinity) { lvls.IB_HIGH = ibH; lvls.IB_LOW = ibL; lvls.IB_MID = (ibH + ibL) / 2; }
      if (todayAcd) { lvls.OR_HIGH = todayAcd.or_high; lvls.OR_LOW = todayAcd.or_low; lvls.OR_MID = (todayAcd.or_high + todayAcd.or_low) / 2; }

      const touched = new Set();
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        const pastIB = bar.tod >= 630;
        const pastOR = bar.tod >= 600;

        for (const [ln, lp] of Object.entries(lvls)) {
          if (lp == null || !isFinite(lp)) continue;
          if ((ln === 'IB_MID' || ln === 'IB_HIGH' || ln === 'IB_LOW') && !pastIB) continue;
          if ((ln === 'OR_MID' || ln === 'OR_HIGH' || ln === 'OR_LOW') && !pastOR) continue;
          if (touched.has(ln)) continue;

          const tH = bar.high >= lp - PROXIMITY && bar.high <= lp + PROXIMITY;
          const tL = bar.low >= lp - PROXIMITY && bar.low <= lp + PROXIMITY;
          if (!tH && !tL) continue;

          let dir;
          if (tH && bar.high >= lp) dir = 'SHORT';
          else if (tL && bar.low <= lp) dir = 'LONG';
          else continue;
          touched.add(ln);

          let res = null, exitP = null;
          for (let j = i + 1; j < bars.length; j++) {
            const fb = bars[j];
            if (dir === 'SHORT') {
              if (fb.high - lp >= cfg.stop) { res = 'L'; exitP = lp + cfg.stop; break; }
              if (lp - fb.low >= cfg.target) { res = 'W'; exitP = lp - cfg.target; break; }
            } else {
              if (lp - fb.low >= cfg.stop) { res = 'L'; exitP = lp - cfg.stop; break; }
              if (fb.high - lp >= cfg.target) { res = 'W'; exitP = lp + cfg.target; break; }
            }
          }
          if (res === null) {
            const lb = bars[bars.length - 1];
            res = dir === 'SHORT' ? (lp - lb.close >= 0 ? 'W' : 'L') : (lb.close - lp >= 0 ? 'W' : 'L');
            exitP = lb.close;
          }
          const pnl = dir === 'SHORT' ? (lp - exitP) * PNL_PER_POINT - COMMISSION : (exitP - lp) * PNL_PER_POINT - COMMISSION;
          if (res === 'W') altWins++;
          else altLosses++;
          altPnL += pnl;
        }
      }
    }

    const altN = altWins + altLosses;
    const altWR = altN > 0 ? altWins / altN : 0;
    const altAvg = altN > 0 ? altPnL / altN : 0;
    const evPerDay = mondays.length > 0 ? altPnL / mondays.length : 0;
    console.log(`  ${pad(cfg.label, 28)} N=${rpad(altN, 5)} WR=${rpad(pctStr(altWins, altN), 7)} $/tr=$${rpad(fmt(altAvg, 2), 8)} $/day=$${rpad(fmt(evPerDay, 2), 8)} Total=$${fmt(altPnL, 2)}`);
  }
  console.log('');

  // 4. Gap-specific rules
  console.log('  RULE 4: GAP-SPECIFIC RULES');
  console.log('  ---------------------------');
  if (bigGap.length > 0 && smallGap.length > 0) {
    const bigTr = bigGap.flatMap(d => d.trades);
    const smallTr = smallGap.flatMap(d => d.trades);
    const bigWR = bigTr.length ? bigTr.filter(t => t.result === 'W').length / bigTr.length : 0;
    const smallWR = smallTr.length ? smallTr.filter(t => t.result === 'W').length / smallTr.length : 0;
    console.log(`  Big gap (>100pt):   WR ${pctStr(bigWR * 100, 100)}, Avg $/day $${fmt(mean(bigGap.map(d => d.dayPnL)), 2)}`);
    console.log(`  Small gap (<=100pt): WR ${pctStr(smallWR * 100, 100)}, Avg $/day $${fmt(mean(smallGap.map(d => d.dayPnL)), 2)}`);
    if (bigWR < smallWR - 0.05) {
      console.log(`  --> Big gaps hurt WR by ${fmt((smallWR - bigWR) * 100, 1)}%. Consider extra patience on big-gap Mondays.`);
    }
  }
  console.log('');

  // 5. Optimal Monday P&L projection
  console.log('  RULE 5: PROJECTED MONDAY P&L');
  console.log('  ----------------------------');

  // Simulate "optimal Monday": best start time + only good levels
  const goodLevelSet = new Set(goodLevels.map(l => l.level));
  let optimalTrades = 0, optimalWins = 0, optimalPnL = 0;
  const optimalDayPnLs = [];

  // Use best start time
  const bestStartTod = bestScenario.label.includes('10:30') ? 630 :
                       bestScenario.label.includes('10:00') ? 600 :
                       bestScenario.label.includes('11:00') ? 660 : 570;

  for (const m of mondays) {
    const bars = barsByDate.get(m.date);
    if (!bars || bars.length < 30) continue;

    const dayObj = allDays.find(d => d.date === m.date);
    if (!dayObj) continue;
    const di = allDays.indexOf(dayObj);

    const levels = computeLevels(di, allDays, dvlByDate, acdByDate, barsByDate, overnightByDate);
    if (!levels) continue;
    const todayAcd = acdByDate.get(m.date);

    const lvls = { ...levels };
    let ibH = -Infinity, ibL = Infinity;
    for (const b of bars) {
      if (b.tod >= 570 && b.tod <= 629) { ibH = Math.max(ibH, b.high); ibL = Math.min(ibL, b.low); }
    }
    if (ibH > -Infinity) { lvls.IB_HIGH = ibH; lvls.IB_LOW = ibL; lvls.IB_MID = (ibH + ibL) / 2; }
    if (todayAcd) { lvls.OR_HIGH = todayAcd.or_high; lvls.OR_LOW = todayAcd.or_low; lvls.OR_MID = (todayAcd.or_high + todayAcd.or_low) / 2; }

    // Track touches before startTod
    const touchedBefore = new Set();
    for (const bar of bars) {
      if (bar.tod >= bestStartTod) break;
      for (const [ln, lp] of Object.entries(lvls)) {
        if (lp == null || !isFinite(lp)) continue;
        if (touchedBefore.has(ln)) continue;
        const tH = bar.high >= lp - PROXIMITY && bar.high <= lp + PROXIMITY;
        const tL = bar.low >= lp - PROXIMITY && bar.low <= lp + PROXIMITY;
        if (tH || tL) touchedBefore.add(ln);
      }
    }

    let dayP = 0;
    const touched = new Set();
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.tod < bestStartTod) continue;

      const pastIB = bar.tod >= 630;
      const pastOR = bar.tod >= 600;

      for (const [ln, lp] of Object.entries(lvls)) {
        if (lp == null || !isFinite(lp)) continue;
        // ONLY trade good levels
        if (!goodLevelSet.has(ln)) continue;
        if ((ln === 'IB_MID' || ln === 'IB_HIGH' || ln === 'IB_LOW') && !pastIB) continue;
        if ((ln === 'OR_MID' || ln === 'OR_HIGH' || ln === 'OR_LOW') && !pastOR) continue;
        if (touchedBefore.has(ln)) continue;
        if (touched.has(ln)) continue;

        const tH = bar.high >= lp - PROXIMITY && bar.high <= lp + PROXIMITY;
        const tL = bar.low >= lp - PROXIMITY && bar.low <= lp + PROXIMITY;
        if (!tH && !tL) continue;

        let dir;
        if (tH && bar.high >= lp) dir = 'SHORT';
        else if (tL && bar.low <= lp) dir = 'LONG';
        else continue;
        touched.add(ln);

        let res = null, exitP = null;
        for (let j = i + 1; j < bars.length; j++) {
          const fb = bars[j];
          if (dir === 'SHORT') {
            if (fb.high - lp >= FADE_STOP) { res = 'L'; exitP = lp + FADE_STOP; break; }
            if (lp - fb.low >= FADE_TARGET) { res = 'W'; exitP = lp - FADE_TARGET; break; }
          } else {
            if (lp - fb.low >= FADE_STOP) { res = 'L'; exitP = lp - FADE_STOP; break; }
            if (fb.high - lp >= FADE_TARGET) { res = 'W'; exitP = lp + FADE_TARGET; break; }
          }
        }
        if (res === null) {
          const lb = bars[bars.length - 1];
          res = dir === 'SHORT' ? (lp - lb.close >= 0 ? 'W' : 'L') : (lb.close - lp >= 0 ? 'W' : 'L');
          exitP = lb.close;
        }
        const pnl = dir === 'SHORT' ? (lp - exitP) * PNL_PER_POINT - COMMISSION : (exitP - lp) * PNL_PER_POINT - COMMISSION;
        if (res === 'W') optimalWins++;
        optimalTrades++;
        dayP += pnl;
        optimalPnL += pnl;
      }
    }
    optimalDayPnLs.push(dayP);
  }

  const optAvgDay = optimalDayPnLs.length ? mean(optimalDayPnLs) : 0;
  const optWR = optimalTrades > 0 ? optimalWins / optimalTrades : 0;

  console.log(`\n  OPTIMAL MONDAY (best start time + good levels only):`);
  console.log(`    Start time: ${bestScenario.label}`);
  console.log(`    Levels: ${goodLevels.map(l => l.level).join(', ')}`);
  console.log(`    Trades: ${optimalTrades} | WR: ${pctStr(optimalWins, optimalTrades)}`);
  console.log(`    Avg $/day: $${fmt(optAvgDay, 2)} | Total: $${fmt(optimalPnL, 2)}`);
  console.log(`    vs Current -$339/day: ${optAvgDay > -339 ? 'IMPROVEMENT' : 'STILL BAD'} of $${fmt(optAvgDay - (-339), 2)}/day`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  console.log('================================================================');
  console.log('   SUMMARY: WHY MONDAY LOSES MONEY');
  console.log('================================================================\n');

  // Find the biggest P&L destroyers
  const sortedByTotal = [...levelMonday.entries()]
    .filter(([_, s]) => s.monN >= 3)
    .sort((a, b) => a[1].monTotal - b[1].monTotal);

  console.log('  TOP MONEY DESTROYERS (by total Monday P&L):');
  for (const [level, stats] of sortedByTotal.slice(0, 5)) {
    console.log(`    ${pad(level, 18)} Total Monday P&L: $${fmt(stats.monTotal, 2)} | WR: ${pctStr(stats.monWR * 100, 100)} | N=${stats.monN}`);
  }

  console.log('\n  TOP MONEY MAKERS (by total Monday P&L):');
  for (const [level, stats] of sortedByTotal.slice(-5).reverse()) {
    console.log(`    ${pad(level, 18)} Total Monday P&L: $${fmt(stats.monTotal, 2)} | WR: ${pctStr(stats.monWR * 100, 100)} | N=${stats.monN}`);
  }

  // Time analysis summary
  const morningMonTr = mondayTrades.filter(t => t.tod < 600);
  const afterMorningMonTr = mondayTrades.filter(t => t.tod >= 600);
  const morningWR = morningMonTr.length ? morningMonTr.filter(t => t.result === 'W').length / morningMonTr.length : 0;
  const afterWR = afterMorningMonTr.length ? afterMorningMonTr.filter(t => t.result === 'W').length / afterMorningMonTr.length : 0;

  console.log(`\n  TIME FACTOR:`);
  console.log(`    9:30-10:00 (first 30 min): ${morningMonTr.length} trades, WR ${pctStr(morningWR * 100, 100)}, Total $${fmt(morningMonTr.reduce((s, t) => s + t.pnl, 0), 2)}`);
  console.log(`    10:00+ (rest of day):      ${afterMorningMonTr.length} trades, WR ${pctStr(afterWR * 100, 100)}, Total $${fmt(afterMorningMonTr.reduce((s, t) => s + t.pnl, 0), 2)}`);

  console.log(`\n  GAP FACTOR:`);
  if (bigGap.length > 0 && smallGap.length > 0) {
    console.log(`    Big gap (>100pt): ${bigGap.length} days, Avg $/day $${fmt(mean(bigGap.map(d => d.dayPnL)), 2)}`);
    console.log(`    Small gap (<=100pt): ${smallGap.length} days, Avg $/day $${fmt(mean(smallGap.map(d => d.dayPnL)), 2)}`);
  }

  console.log('\n================================================================');
  console.log('   END OF MONDAY ANALYSIS');
  console.log('================================================================\n');

  // Persist level-by-level Monday stats to performance_audit
  // signal_type='MON_BACKTEST' so the Monday overrides in acd.js have a queryable source
  console.log('Writing Monday results to performance_audit...');
  const today = new Date().toISOString().slice(0, 10);
  for (const [level, stats] of levelMonday.entries()) {
    if (stats.monN < 5) continue;
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl)
      VALUES ($1, $2, 'MON_BACKTEST', $3, $4, $5, $6, $7)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate,
        ev_per_trade=EXCLUDED.ev_per_trade, total_pnl=EXCLUDED.total_pnl
    `, [today, 365, `${level}_MONDAY`, stats.monN, stats.monWR, stats.monAvg, stats.monTotal]);
  }
  console.log(`Wrote ${[...levelMonday.values()].filter(s => s.monN >= 5).length} rows to performance_audit (signal_type='MON_BACKTEST').`);

  process.exit(0);
}

run().catch(err => {
  console.error('Monday analysis failed:', err);
  process.exit(1);
});
