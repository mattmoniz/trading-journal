// backtest_monday_trend.js
// ═══════════════════════════════════════════════════════════════════════
// MONDAY TREND/BREAKOUT HYPOTHESIS TEST
//
// Prior finding: fading levels on Mondays system-wide = 40% WR (loses),
// but PD_POC fade specifically on Mondays = 88% WR. Theory: Monday is a
// TREND day (53/55 Mondays have >50pt weekend gaps, volume 17% lower =
// less resistance), and PD_POC works as a MAGNET (continuation target)
// not a WALL (reversal point). This script tests:
//   1. Gap-following: trade WITH the weekend gap direction at levels
//   2. OR breakout (classic, with-trend) on Monday vs Tue-Fri
//   3. IB breakout (with-trend) on Monday vs Tue-Fri
//   4. Trend-day classification via efficiency ratio (ER)
//   5. Head-to-head strategy comparison table
//   6. Final verdict + Monday playbook
//
// Full history: 2022-12-14 to present (861 trading days)
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION = 1;
const PROXIMITY = 10; // "touch" tolerance in points

// ── Helpers ──
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function fmt(v, d = 1) { return typeof v === 'number' && isFinite(v) ? v.toFixed(d) : 'N/A'; }
function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) + '%' : 'N/A'; }
function pad(s, w) { return String(s).padEnd(w); }
function rpad(s, w) { return String(s).padStart(w); }
function money(v) { return (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2); }
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function floorPivots(h, l, c) {
  const pivot = (h + l + c) / 3;
  return { FLOOR_PIVOT: pivot, FLOOR_R1: 2 * pivot - l, FLOOR_S1: 2 * pivot - h };
}

// ═══════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════

async function loadAllData() {
  console.log('Loading full history (2022-12-14 to present)...');

  const daysRes = await query(`
    SELECT d.trade_date::text as trade_date,
           EXTRACT(DOW FROM d.trade_date) as dow
    FROM developing_value_log d
    WHERE d.trade_date <= CURRENT_DATE
      AND EXISTS (
        SELECT 1 FROM price_bars_primary p
        WHERE p.ts::date = d.trade_date
          AND p.symbol = 'NQ'
          AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) BETWEEN 570 AND 959
        LIMIT 1
      )
    ORDER BY d.trade_date
  `);
  const allDays = daysRes.rows.map(r => ({ date: r.trade_date, dow: Number(r.dow) }));
  console.log(`  Total trading days: ${allDays.length} (${allDays[0].date} to ${allDays[allDays.length - 1].date})`);

  const firstDate = allDays[0].date;
  const lastDate = allDays[allDays.length - 1].date;

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

  const barsRes = await query(`
    SELECT ts::date::text as trade_date,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
           open::float, high::float, low::float, close::float,
           volume::int
    FROM price_bars_primary
    WHERE ts::date >= $1 AND ts::date <= $2
      AND symbol = 'NQ'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `, [firstDate, lastDate]);
  const barsByDate = new Map();
  for (const r of barsRes.rows) {
    if (!barsByDate.has(r.trade_date)) barsByDate.set(r.trade_date, []);
    barsByDate.get(r.trade_date).push(r);
  }
  console.log(`  Loaded ${barsRes.rows.length} RTH bars across ${barsByDate.size} days`);

  // Overnight bars for gap calc: prior eve 18:00+ through today's pre-open
  const onEveRes = await query(`
    SELECT ts::date::text as bar_date,
           EXTRACT(hour FROM ts) as hr,
           high::float, low::float, close::float, open::float
    FROM price_bars_primary
    WHERE ts::date >= ($1::date - interval '4 day')::date AND ts::date <= $2
      AND symbol = 'NQ'
      AND EXTRACT(hour FROM ts) >= 18
    ORDER BY ts
  `, [firstDate, lastDate]);
  const onPreRes = await query(`
    SELECT ts::date::text as bar_date,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
           high::float, low::float, close::float, open::float
    FROM price_bars_primary
    WHERE ts::date >= $1 AND ts::date <= $2
      AND symbol = 'NQ'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 570
    ORDER BY ts
  `, [firstDate, lastDate]);

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

  // Overnight H/L per day = evening bars from PRIOR calendar day(s) + pre-open bars of THIS day
  const overnightByDate = new Map();
  for (const dayObj of allDays) {
    const day = dayObj.date;
    const dayDate = new Date(day + 'T00:00:00Z');
    let onHigh = -Infinity, onLow = Infinity;
    // evening bars dated 1-3 calendar days prior (covers weekend gap for Monday)
    for (let back = 1; back <= 3; back++) {
      const priorDate = new Date(dayDate);
      priorDate.setUTCDate(priorDate.getUTCDate() - back);
      const priorStr = priorDate.toISOString().slice(0, 10);
      const eve = eveningBars.get(priorStr);
      if (eve) {
        for (const b of eve) {
          onHigh = Math.max(onHigh, b.high);
          onLow = Math.min(onLow, b.low);
        }
      }
    }
    const pre = preOpenBars.get(day);
    if (pre) {
      for (const b of pre) {
        onHigh = Math.max(onHigh, b.high);
        onLow = Math.min(onLow, b.low);
      }
    }
    if (onHigh > -Infinity) overnightByDate.set(day, { on_high: onHigh, on_low: onLow });
  }
  console.log(`  Computed overnight H/L for ${overnightByDate.size} days`);

  return { allDays, dvlByDate, acdByDate, barsByDate, overnightByDate };
}

// ═══════════════════════════════════════════════════════════════════════
// LEVEL COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

function computeLevels(dayIdx, allDays, dvlByDate, acdByDate, barsByDate) {
  const day = allDays[dayIdx].date;
  const levels = {};

  let priorDvl = null;
  for (let i = dayIdx - 1; i >= 0; i--) {
    priorDvl = dvlByDate.get(allDays[i].date);
    if (priorDvl) break;
  }
  if (!priorDvl) return null;

  levels.PD_POC = priorDvl.poc;
  levels.PD_VAH = priorDvl.vah;
  levels.PD_VAL = priorDvl.val;

  const pivots = floorPivots(priorDvl.session_high, priorDvl.session_low, priorDvl.session_close);
  levels.FLOOR_PIVOT = pivots.FLOOR_PIVOT;
  levels.FLOOR_R1 = pivots.FLOOR_R1;
  levels.FLOOR_S1 = pivots.FLOOR_S1;

  levels.PD_SESSION_MID = (priorDvl.session_high + priorDvl.session_low) / 2;

  const todayAcd = acdByDate.get(day);
  if (todayAcd && todayAcd.or_high != null && todayAcd.or_low != null) {
    levels.OR_HIGH = todayAcd.or_high;
    levels.OR_LOW = todayAcd.or_low;
    levels.OR_MID = (todayAcd.or_high + todayAcd.or_low) / 2;
  }

  return { levels, priorClose: priorDvl.session_close };
}

// ═══════════════════════════════════════════════════════════════════════
// DAY METRICS: gap, IB, OR, ER, volume
// ═══════════════════════════════════════════════════════════════════════

function computeDayMetrics(bars, priorClose) {
  const sessionHigh = Math.max(...bars.map(b => b.high));
  const sessionLow = Math.min(...bars.map(b => b.low));
  const rthOpen = bars[0].open;
  const rthClose = bars[bars.length - 1].close;
  const totalVol = bars.reduce((s, b) => s + (b.volume || 0), 0);

  const gap = priorClose != null ? rthOpen - priorClose : null;

  // OR = first 5 min (9:30-9:35, tod 570-574)
  const orBars = bars.filter(b => b.tod >= 570 && b.tod <= 574);
  const orHigh = orBars.length ? Math.max(...orBars.map(b => b.high)) : null;
  const orLow = orBars.length ? Math.min(...orBars.map(b => b.low)) : null;

  // IB = first 60 min (9:30-10:30, tod 570-629)
  const ibBars = bars.filter(b => b.tod >= 570 && b.tod <= 629);
  const ibHigh = ibBars.length ? Math.max(...ibBars.map(b => b.high)) : null;
  const ibLow = ibBars.length ? Math.min(...ibBars.map(b => b.low)) : null;

  // First 15 min volume (9:30-9:45, tod 570-584)
  const first15 = bars.filter(b => b.tod >= 570 && b.tod <= 584);
  const first15Vol = first15.reduce((s, b) => s + (b.volume || 0), 0);

  // Efficiency ratio over AM session (9:30-12:00, tod 570-719):
  // net displacement / sum of |bar-to-bar moves|
  const amBars = bars.filter(b => b.tod >= 570 && b.tod <= 719);
  let er = null, erDirection = null;
  if (amBars.length > 1) {
    const netDisp = amBars[amBars.length - 1].close - amBars[0].open;
    let totalMove = 0;
    let prevClose = amBars[0].open;
    for (const b of amBars) {
      totalMove += Math.abs(b.close - prevClose);
      prevClose = b.close;
    }
    er = totalMove > 0 ? Math.abs(netDisp) / totalMove : 0;
    erDirection = netDisp >= 0 ? 'UP' : 'DOWN';
  }

  return {
    sessionHigh, sessionLow, rthOpen, rthClose, totalVol, gap,
    orHigh, orLow, ibHigh, ibLow, first15Vol, er, erDirection,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PART 1: GAP-FOLLOWING STRATEGY (trade WITH gap direction at levels)
// ═══════════════════════════════════════════════════════════════════════
// Entry: first touch of a level AFTER the open, trading in gap direction
//   gap UP -> only take LONG signals (bounce-and-continue off support-acting level)
//   gap DOWN -> only take SHORT signals (reject-and-continue off resistance-acting level)
// Target/stop: 40pt target / 90pt stop (same as fade system, for apples-to-apples),
// but ALSO test a trend-style asymmetric setup (60pt target / 40pt stop) since
// continuation trades should run further than fades.

function simulateGapFollow(bars, levels, gapDir, target, stop) {
  const trades = [];
  const touched = new Set();
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const pastOR = bar.tod >= 600;
    for (const [levelName, levelPrice] of Object.entries(levels)) {
      if (levelPrice == null || !isFinite(levelPrice)) continue;
      if (levelName.startsWith('OR_') && !pastOR) continue;
      if (touched.has(levelName)) continue;

      const touchesHigh = bar.high >= levelPrice - PROXIMITY && bar.high <= levelPrice + PROXIMITY;
      const touchesLow = bar.low >= levelPrice - PROXIMITY && bar.low <= levelPrice + PROXIMITY;
      if (!touchesHigh && !touchesLow) continue;

      // Direction is forced by gap direction (continuation logic), not by touch side:
      // gap UP: we want LONG entries on pullback DOWN to level (price dipped to touch it)
      // gap DOWN: we want SHORT entries on rally UP to level
      let direction = null;
      if (gapDir === 'UP' && touchesLow && bar.low <= levelPrice) direction = 'LONG';
      if (gapDir === 'DOWN' && touchesHigh && bar.high >= levelPrice) direction = 'SHORT';
      if (!direction) continue;

      touched.add(levelName);
      const entryPrice = levelPrice;
      let result = null, exitPrice = null;
      for (let j = i + 1; j < bars.length; j++) {
        const fb = bars[j];
        if (direction === 'LONG') {
          const adverse = entryPrice - fb.low;
          const favorable = fb.high - entryPrice;
          if (adverse >= stop) { result = 'L'; exitPrice = entryPrice - stop; break; }
          if (favorable >= target) { result = 'W'; exitPrice = entryPrice + target; break; }
        } else {
          const adverse = fb.high - entryPrice;
          const favorable = entryPrice - fb.low;
          if (adverse >= stop) { result = 'L'; exitPrice = entryPrice + stop; break; }
          if (favorable >= target) { result = 'W'; exitPrice = entryPrice - target; break; }
        }
      }
      if (result === null) {
        const lastBar = bars[bars.length - 1];
        exitPrice = lastBar.close;
        const pnl = direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
        result = pnl >= 0 ? 'W' : 'L';
      }
      const tradePnL = (direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice) * PNL_PER_POINT - COMMISSION;
      trades.push({ level: levelName, direction, entryPrice, exitPrice, result, pnl: tradePnL, tod: bar.tod });
    }
  }
  return trades;
}

// Fade version for comparison (existing system logic): direction opposite of gap-follow
function simulateFade(bars, levels, target, stop) {
  const trades = [];
  const touched = new Set();
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const pastOR = bar.tod >= 600;
    for (const [levelName, levelPrice] of Object.entries(levels)) {
      if (levelPrice == null || !isFinite(levelPrice)) continue;
      if (levelName.startsWith('OR_') && !pastOR) continue;
      if (touched.has(levelName)) continue;

      const touchesHigh = bar.high >= levelPrice - PROXIMITY && bar.high <= levelPrice + PROXIMITY;
      const touchesLow = bar.low >= levelPrice - PROXIMITY && bar.low <= levelPrice + PROXIMITY;
      if (!touchesHigh && !touchesLow) continue;

      let direction;
      if (touchesHigh && bar.high >= levelPrice) direction = 'SHORT';
      else if (touchesLow && bar.low <= levelPrice) direction = 'LONG';
      else continue;

      touched.add(levelName);
      const entryPrice = levelPrice;
      let result = null, exitPrice = null;
      for (let j = i + 1; j < bars.length; j++) {
        const fb = bars[j];
        if (direction === 'SHORT') {
          const adverse = fb.high - entryPrice;
          const favorable = entryPrice - fb.low;
          if (adverse >= stop) { result = 'L'; exitPrice = entryPrice + stop; break; }
          if (favorable >= target) { result = 'W'; exitPrice = entryPrice - target; break; }
        } else {
          const adverse = entryPrice - fb.low;
          const favorable = fb.high - entryPrice;
          if (adverse >= stop) { result = 'L'; exitPrice = entryPrice - stop; break; }
          if (favorable >= target) { result = 'W'; exitPrice = entryPrice + target; break; }
        }
      }
      if (result === null) {
        const lastBar = bars[bars.length - 1];
        exitPrice = lastBar.close;
        const pnl = direction === 'SHORT' ? entryPrice - exitPrice : exitPrice - entryPrice;
        result = pnl >= 0 ? 'W' : 'L';
      }
      const tradePnL = (direction === 'SHORT' ? entryPrice - exitPrice : exitPrice - entryPrice) * PNL_PER_POINT - COMMISSION;
      trades.push({ level: levelName, direction, entryPrice, exitPrice, result, pnl: tradePnL, tod: bar.tod });
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════
// PART 2 & 3: OR / IB BREAKOUT (with-trend)
// ═══════════════════════════════════════════════════════════════════════
// Entry: price breaks range high/low and HOLDS (close beyond range edge on
// a subsequent bar, i.e. confirmed breakout) within first 60 min after range forms.
// Stop: opposite side of the range. Target: measured move (range width) tested,
// and fixed-points target tested.

function simulateRangeBreakout(bars, rangeHigh, rangeLow, rangeEndTod, windowEndTod, targetMode, fixedTarget) {
  if (rangeHigh == null || rangeLow == null) return null;
  const rangeWidth = rangeHigh - rangeLow;
  if (rangeWidth <= 0) return null;

  // Find first confirmed breakout: a bar that closes beyond range edge,
  // within window [rangeEndTod, windowEndTod]
  let breakoutBar = null, direction = null;
  for (const b of bars) {
    if (b.tod < rangeEndTod || b.tod > windowEndTod) continue;
    if (b.close > rangeHigh) { breakoutBar = b; direction = 'LONG'; break; }
    if (b.close < rangeLow) { breakoutBar = b; direction = 'SHORT'; break; }
  }
  if (!breakoutBar) return null;

  const entryPrice = breakoutBar.close;
  const stopPrice = direction === 'LONG' ? rangeLow : rangeHigh;
  const stopDist = Math.abs(entryPrice - stopPrice);
  const target = targetMode === 'measured' ? rangeWidth : fixedTarget;

  let result = null, exitPrice = null;
  const entryIdx = bars.indexOf(breakoutBar);
  for (let j = entryIdx + 1; j < bars.length; j++) {
    const fb = bars[j];
    if (direction === 'LONG') {
      if (fb.low <= stopPrice) { result = 'L'; exitPrice = stopPrice; break; }
      if (fb.high >= entryPrice + target) { result = 'W'; exitPrice = entryPrice + target; break; }
    } else {
      if (fb.high >= stopPrice) { result = 'L'; exitPrice = stopPrice; break; }
      if (fb.low <= entryPrice - target) { result = 'W'; exitPrice = entryPrice - target; break; }
    }
  }
  if (result === null) {
    const lastBar = bars[bars.length - 1];
    exitPrice = lastBar.close;
    const pnl = direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
    result = pnl >= 0 ? 'W' : 'L';
  }
  const pnl = (direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice) * PNL_PER_POINT - COMMISSION;
  return { direction, entryPrice, exitPrice, stopDist, target, result, pnl, tod: breakoutBar.tod };
}

// ═══════════════════════════════════════════════════════════════════════
// AGGREGATION HELPERS
// ═══════════════════════════════════════════════════════════════════════

function aggStats(trades) {
  const n = trades.length;
  const wins = trades.filter(t => t.result === 'W').length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const avg = n ? total / n : 0;
  const wr = n ? wins / n : 0;
  const avgWin = mean(trades.filter(t => t.result === 'W').map(t => t.pnl));
  const avgLoss = mean(trades.filter(t => t.result === 'L').map(t => t.pnl));
  return { n, wins, wr, total, avg, avgWin, avgLoss };
}

function printRow(label, s, w1 = 28) {
  console.log(
    rpad(label, w1) + ' | ' +
    rpad(pct(s.wins, s.n), 7) + ' | ' +
    rpad(money(s.avg), 10) + ' | ' +
    rpad(s.n, 6) + ' | ' +
    rpad(money(s.total), 12)
  );
}

function header(w1 = 28) {
  console.log(
    rpad('Strategy', w1) + ' | ' +
    rpad('WR', 7) + ' | ' +
    rpad('EV/trade', 10) + ' | ' +
    rpad('N', 6) + ' | ' +
    rpad('Total P&L', 12)
  );
  console.log('-'.repeat(w1 + 55));
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('');
  console.log('================================================================================');
  console.log('   MONDAY TREND vs FADE HYPOTHESIS TEST — Full 861-day history');
  console.log('   2022-12-14 to present | PNL_PER_POINT=2, COMMISSION=1');
  console.log('================================================================================');

  const { allDays, dvlByDate, acdByDate, barsByDate } = await loadAllData();

  // Build per-day record with metrics + levels
  const dayRecords = [];
  for (let di = 1; di < allDays.length; di++) {
    const { date: day, dow } = allDays[di];
    const bars = barsByDate.get(day);
    if (!bars || bars.length < 30) continue;

    const lvlResult = computeLevels(di, allDays, dvlByDate, acdByDate, barsByDate);
    if (!lvlResult) continue;
    const { levels, priorClose } = lvlResult;

    const metrics = computeDayMetrics(bars, priorClose);
    dayRecords.push({ date: day, dow, bars, levels, metrics });
  }
  console.log(`\nBuilt ${dayRecords.length} day records.`);

  const mondays = dayRecords.filter(d => d.dow === 1);
  const nonMondays = dayRecords.filter(d => d.dow !== 1 && d.dow >= 1 && d.dow <= 5);
  console.log(`Mondays: ${mondays.length} | Tue-Fri: ${nonMondays.length}`);

  // ── Gap stats sanity check ──
  const mondaysWithGap = mondays.filter(m => m.metrics.gap != null);
  const bigGapMondays = mondaysWithGap.filter(m => Math.abs(m.metrics.gap) > 50);
  console.log(`\nMondays with gap data: ${mondaysWithGap.length}`);
  console.log(`Mondays with >50pt weekend gap: ${bigGapMondays.length} (${pct(bigGapMondays.length, mondaysWithGap.length)})`);
  console.log(`Avg Monday |gap|: ${fmt(mean(mondaysWithGap.map(m => Math.abs(m.metrics.gap))), 1)}pt`);
  const mondayVol = mean(mondays.map(m => m.metrics.totalVol));
  const otherVol = mean(nonMondays.map(m => m.metrics.totalVol));
  console.log(`Monday avg RTH volume: ${fmt(mondayVol, 0)} | Tue-Fri avg: ${fmt(otherVol, 0)} | Diff: ${pct(mondayVol - otherVol, otherVol)}`);

  // ═══════════════════════════════════════════════════════════════════
  // PART 1: GAP-FOLLOWING vs FADE on Mondays
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n\n================================================================================');
  console.log('PART 1: GAP-FOLLOWING STRATEGY (trade WITH weekend gap direction at levels)');
  console.log('================================================================================');

  const continuationLevels = ['PD_POC', 'PD_VAH', 'PD_VAL', 'OR_MID'];

  for (const targetCfg of [{ target: 40, stop: 90, label: '40T/90S (fade-style)' }, { target: 60, stop: 40, label: '60T/40S (trend-style)' }]) {
    console.log(`\n--- Target/Stop: ${targetCfg.label} ---`);
    header();

    let gapFollowAll = [], fadeAll = [];
    for (const m of mondaysWithGap) {
      if (Math.abs(m.metrics.gap) < 1) continue;
      const gapDir = m.metrics.gap > 0 ? 'UP' : 'DOWN';
      const lvlSubset = {};
      for (const k of continuationLevels) if (m.levels[k] != null) lvlSubset[k] = m.levels[k];

      const gf = simulateGapFollow(m.bars, { ...lvlSubset }, gapDir, targetCfg.target, targetCfg.stop);
      const fd = simulateFade(m.bars, { ...lvlSubset }, targetCfg.target, targetCfg.stop);
      gapFollowAll.push(...gf);
      fadeAll.push(...fd);
    }
    printRow('Gap-follow (continuation)', aggStats(gapFollowAll));
    printRow('Fade (reversal, same levels)', aggStats(fadeAll));

    // Break down gap-follow by level
    console.log('\n  Gap-follow by level:');
    for (const lvl of continuationLevels) {
      const sub = gapFollowAll.filter(t => t.level === lvl);
      if (sub.length) printRow('  ' + lvl, aggStats(sub));
    }
    console.log('\n  Fade by level:');
    for (const lvl of continuationLevels) {
      const sub = fadeAll.filter(t => t.level === lvl);
      if (sub.length) printRow('  ' + lvl, aggStats(sub));
    }

    // Split by gap size
    const bigGap = mondaysWithGap.filter(m => Math.abs(m.metrics.gap) > 100);
    const smallGap = mondaysWithGap.filter(m => Math.abs(m.metrics.gap) <= 100 && Math.abs(m.metrics.gap) >= 1);
    function runSet(set) {
      let gf = [], fd = [];
      for (const m of set) {
        const gapDir = m.metrics.gap > 0 ? 'UP' : 'DOWN';
        const lvlSubset = {};
        for (const k of continuationLevels) if (m.levels[k] != null) lvlSubset[k] = m.levels[k];
        gf.push(...simulateGapFollow(m.bars, { ...lvlSubset }, gapDir, targetCfg.target, targetCfg.stop));
        fd.push(...simulateFade(m.bars, { ...lvlSubset }, targetCfg.target, targetCfg.stop));
      }
      return { gf, fd };
    }
    const bigRes = runSet(bigGap);
    const smallRes = runSet(smallGap);
    console.log(`\n  By gap size (N days: big=${bigGap.length}, small=${smallGap.length}):`);
    printRow('  Big gap(>100) gap-follow', aggStats(bigRes.gf));
    printRow('  Big gap(>100) fade', aggStats(bigRes.fd));
    printRow('  Small gap(<=100) gap-follow', aggStats(smallRes.gf));
    printRow('  Small gap(<=100) fade', aggStats(smallRes.fd));
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 2: OPENING RANGE BREAKOUT — Monday vs Tue-Fri
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n\n================================================================================');
  console.log('PART 2: OPENING RANGE (OR, 9:30-9:35) BREAKOUT — Monday vs Tue-Fri');
  console.log('================================================================================');

  function runORBreakoutSet(days, targetMode, fixedTarget) {
    const trades = [];
    for (const d of days) {
      const t = simulateRangeBreakout(d.bars, d.metrics.orHigh, d.metrics.orLow, 575, 629, targetMode, fixedTarget);
      if (t) trades.push(t);
    }
    return trades;
  }

  for (const cfg of [{ mode: 'measured', fixed: null, label: 'Measured move (OR width)' }, { mode: 'fixed', fixed: 50, label: 'Fixed 50pt target' }, { mode: 'fixed', fixed: 100, label: 'Fixed 100pt target' }]) {
    console.log(`\n--- OR breakout target: ${cfg.label} ---`);
    header();
    const monTrades = runORBreakoutSet(mondays, cfg.mode, cfg.fixed);
    const otherTrades = runORBreakoutSet(nonMondays, cfg.mode, cfg.fixed);
    printRow('Monday OR breakout', aggStats(monTrades));
    printRow('Tue-Fri OR breakout', aggStats(otherTrades));
    console.log(`  Monday breakout occurrence rate: ${pct(monTrades.length, mondays.length)} of Mondays | Tue-Fri: ${pct(otherTrades.length, nonMondays.length)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 3: IB BREAKOUT — Monday vs Tue-Fri
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n\n================================================================================');
  console.log('PART 3: INITIAL BALANCE (IB, 9:30-10:30) BREAKOUT — Monday vs Tue-Fri');
  console.log('================================================================================');

  function runIBBreakoutSet(days, targetMode, fixedTarget) {
    const trades = [];
    for (const d of days) {
      const t = simulateRangeBreakout(d.bars, d.metrics.ibHigh, d.metrics.ibLow, 630, 719, targetMode, fixedTarget);
      if (t) trades.push(t);
    }
    return trades;
  }

  for (const cfg of [{ mode: 'measured', fixed: null, label: 'Measured move (IB width)' }, { mode: 'fixed', fixed: 50, label: 'Fixed 50pt target' }, { mode: 'fixed', fixed: 100, label: 'Fixed 100pt target' }]) {
    console.log(`\n--- IB breakout target: ${cfg.label} ---`);
    header();
    const monTrades = runIBBreakoutSet(mondays, cfg.mode, cfg.fixed);
    const otherTrades = runIBBreakoutSet(nonMondays, cfg.mode, cfg.fixed);
    printRow('Monday IB breakout', aggStats(monTrades));
    printRow('Tue-Fri IB breakout', aggStats(otherTrades));
    console.log(`  Monday breakout occurrence rate: ${pct(monTrades.length, mondays.length)} of Mondays | Tue-Fri: ${pct(otherTrades.length, nonMondays.length)}`);
  }

  // Best of OR vs IB for Monday specifically
  const monOR_measured = runORBreakoutSet(mondays, 'measured', null);
  const monIB_measured = runIBBreakoutSet(mondays, 'measured', null);
  console.log('\n--- OR vs IB breakout head-to-head (Monday, measured move target) ---');
  header();
  printRow('Monday OR breakout', aggStats(monOR_measured));
  printRow('Monday IB breakout', aggStats(monIB_measured));

  // ═══════════════════════════════════════════════════════════════════
  // PART 4: TREND-DAY CLASSIFICATION (efficiency ratio)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n\n================================================================================');
  console.log('PART 4: TREND-DAY CLASSIFICATION (Efficiency Ratio, AM session 9:30-12:00)');
  console.log('================================================================================');

  const mondaysWithER = mondays.filter(m => m.metrics.er != null);
  const otherWithER = nonMondays.filter(m => m.metrics.er != null);
  const allWithER = [...mondaysWithER, ...otherWithER];

  // NOTE: ER computed bar-to-bar on 1-min bars over a 150-min window produces
  // values far below the textbook 0.5 "trending" cutoff (path length dominated by
  // 1-min noise). Per project rule, thresholds must be derived from the data's own
  // distribution rather than a static literature value. We define "high-ER" as the
  // TOP TERCILE of the full (Monday + Tue-Fri) ER distribution, computed dynamically.
  const sortedER = [...allWithER.map(m => m.metrics.er)].sort((a, b) => a - b);
  function percentile(sorted, p) {
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
  }
  const erTopTercileCut = percentile(sortedER, 2 / 3); // top third = trending
  const erMedianCut = percentile(sortedER, 0.5);

  const highERMon = mondaysWithER.filter(m => m.metrics.er > erTopTercileCut);
  const lowERMon = mondaysWithER.filter(m => m.metrics.er <= erTopTercileCut);
  const highEROther = otherWithER.filter(m => m.metrics.er > erTopTercileCut);

  console.log(`\nMonday ER distribution: mean=${fmt(mean(mondaysWithER.map(m => m.metrics.er)), 3)}, median≈${fmt([...mondaysWithER.map(m => m.metrics.er)].sort((a, b) => a - b)[Math.floor(mondaysWithER.length / 2)], 3)}`);
  console.log(`Tue-Fri ER distribution: mean=${fmt(mean(otherWithER.map(m => m.metrics.er)), 3)}`);
  console.log(`Dynamic "trending" cutoff (top tercile of full ER distribution): ER > ${fmt(erTopTercileCut, 3)} (median=${fmt(erMedianCut, 3)})`);
  console.log(`\nHigh-ER (trending, top tercile) Mondays: ${highERMon.length} / ${mondaysWithER.length} (${pct(highERMon.length, mondaysWithER.length)})`);
  console.log(`High-ER (trending, top tercile) Tue-Fri: ${highEROther.length} / ${otherWithER.length} (${pct(highEROther.length, otherWithER.length)})`);

  // On high-ER Mondays: does trend-following (gap-follow PD_POC) beat fading?
  function runLevelSet(days, mode, target = 40, stop = 90) {
    let trades = [];
    for (const d of days) {
      if (d.metrics.gap == null || Math.abs(d.metrics.gap) < 1) continue;
      const lvlSubset = {};
      for (const k of continuationLevels) if (d.levels[k] != null) lvlSubset[k] = d.levels[k];
      if (mode === 'follow') {
        const gapDir = d.metrics.gap > 0 ? 'UP' : 'DOWN';
        trades.push(...simulateGapFollow(d.bars, { ...lvlSubset }, gapDir, target, stop));
      } else {
        trades.push(...simulateFade(d.bars, { ...lvlSubset }, target, stop));
      }
    }
    return trades;
  }

  console.log('\n--- High-ER Mondays (trending): trend-follow vs fade ---');
  header();
  printRow('Trend-follow (gap-follow levels)', aggStats(runLevelSet(highERMon, 'follow')));
  printRow('Fade (same levels)', aggStats(runLevelSet(highERMon, 'fade')));

  console.log('\n--- Low-ER Mondays (choppy): trend-follow vs fade ---');
  header();
  printRow('Trend-follow (gap-follow levels)', aggStats(runLevelSet(lowERMon, 'follow')));
  printRow('Fade (same levels)', aggStats(runLevelSet(lowERMon, 'fade')));

  // Predict ER at the open: correlate gap size, overnight range, first-15-min volume with ER
  console.log('\n--- Predicting trend vs chop AT THE OPEN (Monday only) ---');
  const predictors = mondaysWithER.filter(m => m.metrics.gap != null);
  function corr(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const mx = mean(xs), my = mean(ys);
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
    }
    return (dx2 > 0 && dy2 > 0) ? num / Math.sqrt(dx2 * dy2) : null;
  }
  const absGaps = predictors.map(m => Math.abs(m.metrics.gap));
  const ers = predictors.map(m => m.metrics.er);
  const vols = predictors.map(m => m.metrics.first15Vol);
  console.log(`  Correlation |gap| vs ER: r=${fmt(corr(absGaps, ers), 3)}`);
  console.log(`  Correlation first-15min volume vs ER: r=${fmt(corr(vols, ers), 3)}`);

  // Bucket by gap size -> mean ER, to see if bigger gap predicts more trend
  const gapBuckets = [
    { label: '<25pt', test: g => g < 25 },
    { label: '25-50pt', test: g => g >= 25 && g < 50 },
    { label: '50-100pt', test: g => g >= 50 && g < 100 },
    { label: '100-150pt', test: g => g >= 100 && g < 150 },
    { label: '>150pt', test: g => g >= 150 },
  ];
  console.log(`\n  Gap size bucket -> mean ER -> % high-ER (top-tercile, ER>${fmt(erTopTercileCut, 3)}):`);
  for (const b of gapBuckets) {
    const subset = predictors.filter(m => b.test(Math.abs(m.metrics.gap)));
    if (!subset.length) continue;
    const meanER = mean(subset.map(m => m.metrics.er));
    const highERPct = pct(subset.filter(m => m.metrics.er > erTopTercileCut).length, subset.length);
    console.log(`    ${pad(b.label, 12)} n=${rpad(subset.length, 4)} mean ER=${fmt(meanER, 3)} high-ER%=${highERPct}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 5: HEAD-TO-HEAD COMPARISON TABLE
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n\n================================================================================');
  console.log('PART 5: HEAD-TO-HEAD — Monday strategies, full history');
  console.log('================================================================================\n');

  // PD_POC fade (existing system, 40/90)
  const pdPocFade = [];
  for (const m of mondays) {
    if (m.levels.PD_POC == null) continue;
    pdPocFade.push(...simulateFade(m.bars, { PD_POC: m.levels.PD_POC }, 40, 90));
  }

  // PD_POC continuation (gap-follow, NOT fading) — only on days with gap data
  const pdPocCont = [];
  for (const m of mondaysWithGap) {
    if (m.levels.PD_POC == null || Math.abs(m.metrics.gap) < 1) continue;
    const gapDir = m.metrics.gap > 0 ? 'UP' : 'DOWN';
    pdPocCont.push(...simulateGapFollow(m.bars, { PD_POC: m.levels.PD_POC }, gapDir, 40, 90));
  }

  // OR breakout with-trend (measured move)
  const orBreakout = monOR_measured;

  // IB breakout with-trend (measured move)
  const ibBreakout = monIB_measured;

  // Combined: gap>100 -> breakout mode (IB breakout measured), gap<50 -> fade mode (PD_POC fade)
  const combinedTrades = [];
  for (const m of mondaysWithGap) {
    const absGap = Math.abs(m.metrics.gap);
    if (absGap > 100) {
      const t = simulateRangeBreakout(m.bars, m.metrics.ibHigh, m.metrics.ibLow, 630, 719, 'measured', null);
      if (t) combinedTrades.push(t);
    } else if (absGap < 50) {
      if (m.levels.PD_POC != null) {
        combinedTrades.push(...simulateFade(m.bars, { PD_POC: m.levels.PD_POC }, 40, 90));
      }
    }
    // gaps 50-100: no trade in this combined strategy (ambiguous zone)
  }

  header(34);
  printRow('PD_POC fade (existing)', aggStats(pdPocFade), 34);
  printRow('PD_POC continuation (gap-follow)', aggStats(pdPocCont), 34);
  printRow('OR breakout (with-trend)', aggStats(orBreakout), 34);
  printRow('IB breakout (with-trend)', aggStats(ibBreakout), 34);
  printRow('Combined (gap-size routed)', aggStats(combinedTrades), 34);

  // ═══════════════════════════════════════════════════════════════════
  // PART 6: THE ANSWER
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n\n================================================================================');
  console.log('PART 6: THE ANSWER');
  console.log('================================================================================\n');

  const allStrats = [
    { name: 'PD_POC fade (existing)', stats: aggStats(pdPocFade) },
    { name: 'PD_POC continuation (gap-follow)', stats: aggStats(pdPocCont) },
    { name: 'OR breakout (with-trend)', stats: aggStats(orBreakout) },
    { name: 'IB breakout (with-trend)', stats: aggStats(ibBreakout) },
    { name: 'Combined (gap-size routed)', stats: aggStats(combinedTrades) },
  ];
  const bestByTotal = [...allStrats].sort((a, b) => b.stats.total - a.stats.total)[0];
  const bestByEV = [...allStrats].sort((a, b) => b.stats.avg - a.stats.avg)[0];

  console.log(`1. Is Monday fundamentally a trend day mistreated as a fade day?`);
  console.log(`   - High-ER (top tercile, ER>${fmt(erTopTercileCut, 3)}, trending) Mondays: ${pct(highERMon.length, mondaysWithER.length)} of all Mondays`);
  console.log(`   - High-ER Tue-Fri: ${pct(highEROther.length, otherWithER.length)} of all Tue-Fri days`);
  console.log(`   - Monday trend-rate ${highERMon.length / mondaysWithER.length > highEROther.length / otherWithER.length ? 'EXCEEDS' : 'DOES NOT EXCEED'} Tue-Fri trend-rate.`);
  console.log(`   - PD_POC fade total P&L: ${money(aggStats(pdPocFade).total)} (N=${aggStats(pdPocFade).n}, WR=${pct(aggStats(pdPocFade).wins, aggStats(pdPocFade).n)})`);
  console.log(`   - PD_POC continuation total P&L: ${money(aggStats(pdPocCont).total)} (N=${aggStats(pdPocCont).n}, WR=${pct(aggStats(pdPocCont).wins, aggStats(pdPocCont).n)})`);
  console.log(`   - On high-ER Mondays specifically, trend-follow total P&L: ${money(aggStats(runLevelSet(highERMon, 'follow')).total)} vs fade: ${money(aggStats(runLevelSet(highERMon, 'fade')).total)}`);
  console.log(`   - On low-ER Mondays specifically, trend-follow total P&L: ${money(aggStats(runLevelSet(lowERMon, 'follow')).total)} vs fade: ${money(aggStats(runLevelSet(lowERMon, 'fade')).total)}`);

  console.log(`\n2. Single best Monday strategy by total P&L: ${bestByTotal.name}`);
  console.log(`   Total P&L: ${money(bestByTotal.stats.total)} | WR: ${pct(bestByTotal.stats.wins, bestByTotal.stats.n)} | N=${bestByTotal.stats.n} | EV/trade: ${money(bestByTotal.stats.avg)}`);
  console.log(`   Best by EV/trade: ${bestByEV.name} (${money(bestByEV.stats.avg)}/trade, N=${bestByEV.stats.n})`);

  console.log(`\n3. FINAL MONDAY PLAYBOOK (data-derived):`);
  console.log(`   - If |weekend gap| < 50pt: ${aggStats(pdPocFade).avg > 0 ? 'FADE PD_POC' : 'avoid PD_POC fade (unprofitable in this sample)'} (40pt target / 90pt stop)`);
  console.log(`   - If |weekend gap| > 100pt: ${aggStats(ibBreakout).avg > aggStats(orBreakout).avg ? 'IB breakout' : 'OR breakout'} with-trend, measured-move target`);
  console.log(`   - PD_POC continuation (gap-follow) EV/trade ${aggStats(pdPocCont).avg > aggStats(pdPocFade).avg ? 'BEATS' : 'DOES NOT BEAT'} PD_POC fade EV/trade on Mondays.`);
  console.log(`   - Recommendation rests on N=${bestByTotal.stats.n} trades for the winning strategy — treat as directional evidence, not statistical certainty if N<30.`);

  console.log('\n================================================================================');
  console.log('END OF REPORT');
  console.log('================================================================================\n');

  process.exit(0);
}

run().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
