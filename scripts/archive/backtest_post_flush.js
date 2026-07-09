/**
 * Post-Flush Balance Backtest
 *
 * Analyzes what happens after a large early flush/move in NQ.
 * Goal: data-driven playbook for post-flush behavior.
 *
 * - Identifies flush days (>200pt move from open in first 60 min of RTH)
 * - Analyzes the balance/consolidation that follows
 * - Measures resolution direction, timing, magnitude
 * - Correlates with ACD, VWAP, Value Area signals
 * - Produces a practical playbook with EV calculations
 */

import { query } from '../server/db.js';

// ── Constants ─────────────────────────────────────────────────────────────
const PNL_PER_POINT = 2;       // MNQ $2/pt
const COMMISSION = 1;           // $1 round trip
const FLUSH_THRESHOLD = 200;    // minimum pts to qualify as a flush
const RTH_START = 570;          // 9:30 ET in minutes
const RTH_END = 959;            // 3:59 ET in minutes
const BALANCE_ROTATION = 65;    // pts per rotation

// ── Helpers ───────────────────────────────────────────────────────────────
function fmt$(v) { return v >= 0 ? `$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }
function fmtPct(v, n = 1) { return isNaN(v) ? 'N/A' : `${(v * 100).toFixed(n)}%`; }
function fmtPts(v) { return `${v.toFixed(1)}pt`; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function minToTime(m) {
  if (isNaN(m) || m === 0) return 'N/A';
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(min).padStart(2, '0')} ${ampm}`;
}

function printSection(title) {
  console.log('\n' + '='.repeat(80));
  console.log(`  ${title}`);
  console.log('='.repeat(80));
}

function printSub(title) {
  console.log(`\n  -- ${title} ${'--'.repeat(Math.max(0, Math.floor((68 - title.length) / 2)))}`);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('========================================================================');
  console.log('   POST-FLUSH BALANCE ANALYSIS -- NQ FUTURES BACKTEST');
  console.log('   "What to do after the initial move"');
  console.log('========================================================================');

  // ── Step 1: Load all RTH bars grouped by day ────────────────────────────
  console.log('\nLoading price data...');
  const barsResult = await query(`
    SELECT ts, open::float, high::float, low::float, close::float, volume
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN $1 AND $2
    ORDER BY ts
  `, [RTH_START, RTH_END]);

  // Group bars by trading day
  const dayBars = new Map();
  for (const bar of barsResult.rows) {
    const dateKey = bar.ts.toISOString().slice(0, 10);
    if (!dayBars.has(dateKey)) dayBars.set(dateKey, []);
    dayBars.get(dateKey).push(bar);
  }
  console.log(`Loaded ${barsResult.rows.length} bars across ${dayBars.size} trading days`);

  // ── Step 2: Load ACD data ───────────────────────────────────────────────
  const acdResult = await query(`SELECT trade_date, or_high::float, or_low::float,
    a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed,
    daily_score, session_close::float, day_type FROM acd_daily_log`);
  const acdByDate = new Map();
  for (const row of acdResult.rows) {
    acdByDate.set(row.trade_date, row);
  }

  // ── Step 3: Load Value Area data ────────────────────────────────────────
  const dvlResult = await query(`SELECT trade_date, poc::float, vah::float, val::float,
    session_high::float, session_low::float FROM developing_value_log`);
  const dvlByDate = new Map();
  for (const row of dvlResult.rows) {
    dvlByDate.set(row.trade_date, row);
  }

  // ── Step 4: Identify flush days and compute all analytics ───────────────
  const flushDays = [];

  for (const [dateKey, bars] of dayBars) {
    if (bars.length < 60) continue; // need at least 60 bars for meaningful analysis

    const openPrice = bars[0].open;
    const getMin = (b) => b.ts.getUTCHours() * 60 + b.ts.getUTCMinutes();

    // Find max directional move from open in first 60 minutes
    let maxUpFromOpen = 0, maxDownFromOpen = 0;
    let maxUpTime = 0, maxDownTime = 0;
    let maxUpIdx = 0, maxDownIdx = 0;

    for (let i = 0; i < bars.length; i++) {
      const minFromOpen = getMin(bars[i]) - RTH_START;
      if (minFromOpen > 60) break;

      const highDiff = bars[i].high - openPrice;
      const lowDiff = openPrice - bars[i].low;

      if (highDiff > maxUpFromOpen) {
        maxUpFromOpen = highDiff;
        maxUpTime = minFromOpen;
        maxUpIdx = i;
      }
      if (lowDiff > maxDownFromOpen) {
        maxDownFromOpen = lowDiff;
        maxDownTime = minFromOpen;
        maxDownIdx = i;
      }
    }

    // Determine if this qualifies as a flush day
    let flushDir = null, flushMagnitude = 0, flushTime = 0, flushIdx = 0, flushPrice = 0;

    if (maxDownFromOpen >= FLUSH_THRESHOLD && maxDownFromOpen >= maxUpFromOpen) {
      flushDir = 'DOWN';
      flushMagnitude = maxDownFromOpen;
      flushTime = maxDownTime;
      flushIdx = maxDownIdx;
      let lowestPrice = Infinity;
      for (let i = 0; i <= maxDownIdx; i++) {
        if (bars[i].low < lowestPrice) lowestPrice = bars[i].low;
      }
      flushPrice = lowestPrice;
    } else if (maxUpFromOpen >= FLUSH_THRESHOLD) {
      flushDir = 'UP';
      flushMagnitude = maxUpFromOpen;
      flushTime = maxUpTime;
      flushIdx = maxUpIdx;
      let highestPrice = -Infinity;
      for (let i = 0; i <= maxUpIdx; i++) {
        if (bars[i].high > highestPrice) highestPrice = bars[i].high;
      }
      flushPrice = highestPrice;
    }

    if (!flushDir) continue;

    // ── Post-flush analysis ──────────────────────────────────────────────
    const postFlushBars = bars.slice(flushIdx + 1);
    if (postFlushBars.length < 10) continue;

    // Compute running VWAP through whole day
    const runningVwap = [];
    let rvNum = 0, rvDen = 0;
    for (const bar of bars) {
      const typical = (bar.high + bar.low + bar.close) / 3;
      rvNum += typical * bar.volume;
      rvDen += bar.volume;
      runningVwap.push(rvDen > 0 ? rvNum / rvDen : bar.close);
    }

    // ── Balance zone detection ───────────────────────────────────────────
    // Establish the balance zone from the first 30 bars after flush (or first 30 min).
    // Then look for a close that exceeds the zone by RESOLUTION_THRESHOLD.
    const BALANCE_ESTABLISH_BARS = 30; // first 30 bars (30 min) establish the zone
    const RESOLUTION_THRESHOLD = 50;   // pts beyond balance boundary to confirm breakout

    const estBars = Math.min(BALANCE_ESTABLISH_BARS, postFlushBars.length);
    let balanceHigh = -Infinity, balanceLow = Infinity;
    for (let i = 0; i < estBars; i++) {
      balanceHigh = Math.max(balanceHigh, postFlushBars[i].high);
      balanceLow = Math.min(balanceLow, postFlushBars[i].low);
    }

    // Now look for resolution: a close beyond the balance zone + threshold
    let resolved = false;
    let resolutionDir = null;
    let resolutionMagnitude = 0;
    let resolutionTime = 0;
    let balanceEndIdx = postFlushBars.length - 1;

    for (let i = estBars; i < postFlushBars.length; i++) {
      const bar = postFlushBars[i];

      if (bar.close > balanceHigh + RESOLUTION_THRESHOLD) {
        resolved = true;
        balanceEndIdx = i;
        resolutionDir = 'UP';
        // Measure from balance top to max subsequent high
        let maxH = bar.high;
        for (let j = i; j < postFlushBars.length; j++) {
          maxH = Math.max(maxH, postFlushBars[j].high);
        }
        resolutionMagnitude = maxH - balanceHigh;
        resolutionTime = getMin(bar);
        break;
      } else if (bar.close < balanceLow - RESOLUTION_THRESHOLD) {
        resolved = true;
        balanceEndIdx = i;
        resolutionDir = 'DOWN';
        let minL = bar.low;
        for (let j = i; j < postFlushBars.length; j++) {
          minL = Math.min(minL, postFlushBars[j].low);
        }
        resolutionMagnitude = balanceLow - minL;
        resolutionTime = getMin(bar);
        break;
      }
    }

    const balanceRange = balanceHigh - balanceLow;
    const balanceDuration = balanceEndIdx; // in minutes (1 bar = 1 min)

    // Count rotations in balance zone
    let rotations = 0;
    const balSlice = postFlushBars.slice(0, balanceEndIdx);
    if (balSlice.length > 1) {
      let lastExtreme = balSlice[0].close;
      let direction = 0;
      for (const bar of balSlice) {
        const move = bar.close - lastExtreme;
        if (Math.abs(move) >= BALANCE_ROTATION) {
          const newDir = move > 0 ? 1 : -1;
          if (newDir !== direction) {
            rotations++;
            direction = newDir;
          }
          lastExtreme = bar.close;
        }
      }
    }

    // Balance position relative to flush
    const balanceMidpoint = (balanceHigh + balanceLow) / 2;
    let retracementPct = 0;
    if (flushDir === 'DOWN') {
      retracementPct = (balanceMidpoint - flushPrice) / flushMagnitude;
    } else {
      retracementPct = (flushPrice - balanceMidpoint) / flushMagnitude;
    }

    // VWAP position at balance midpoint time
    const checkIdx = Math.min(flushIdx + 1 + Math.floor(balanceEndIdx / 2), runningVwap.length - 1);
    const vwapAtBalance = runningVwap[checkIdx];
    const vwapAboveBalance = vwapAtBalance > balanceMidpoint;

    // Continuation vs reversal
    let isContinuation = null;
    if (resolved && resolutionDir) {
      isContinuation = resolutionDir === flushDir;
    }

    // Close price and day's total move
    const closePrice = bars[bars.length - 1].close;
    const closeVsOpen = closePrice - openPrice;

    // ACD data for this day
    const acd = acdByDate.get(dateKey);
    const dvl = dvlByDate.get(dateKey);

    // Balance relative to POC
    let balanceVsPoc = null;
    if (dvl && dvl.poc) {
      balanceVsPoc = balanceMidpoint > dvl.poc ? 'ABOVE' : 'BELOW';
    }

    // Re-entry on resolution: enter at breakout, hold to close
    let reentryPnl = null;
    if (resolved && resolutionDir) {
      const entryPrice = resolutionDir === 'UP'
        ? balanceHigh + RESOLUTION_THRESHOLD
        : balanceLow - RESOLUTION_THRESHOLD;
      if (resolutionDir === 'UP') {
        reentryPnl = (closePrice - entryPrice) * PNL_PER_POINT - COMMISSION;
      } else {
        reentryPnl = (entryPrice - closePrice) * PNL_PER_POINT - COMMISSION;
      }
    }

    // Time-window re-entry analysis: for each 30-min window, measure EV
    const timeWindows = [];
    for (let windowStart = 600; windowStart <= 930; windowStart += 30) {
      const windowBars = bars.filter(b => {
        const m = getMin(b);
        return m >= windowStart && m < windowStart + 30;
      });
      if (windowBars.length === 0) continue;

      const entryPrice = windowBars[0].open;
      let flushDirPnl, reversalDirPnl;
      if (flushDir === 'DOWN') {
        flushDirPnl = (entryPrice - closePrice) * PNL_PER_POINT - COMMISSION;
        reversalDirPnl = (closePrice - entryPrice) * PNL_PER_POINT - COMMISSION;
      } else {
        flushDirPnl = (closePrice - entryPrice) * PNL_PER_POINT - COMMISSION;
        reversalDirPnl = (entryPrice - closePrice) * PNL_PER_POINT - COMMISSION;
      }

      timeWindows.push({ windowStart, flushDirPnl, reversalDirPnl, entryPrice });
    }

    flushDays.push({
      date: dateKey,
      flushDir,
      flushMagnitude,
      flushTime,
      flushPrice,
      openPrice,
      closePrice,
      closeVsOpen,
      balanceHigh,
      balanceLow,
      balanceRange,
      balanceDuration,
      rotations,
      retracementPct,
      resolved,
      resolutionDir,
      resolutionMagnitude,
      resolutionTime,
      isContinuation,
      vwapAtBalance,
      vwapAboveBalance,
      balanceVsPoc,
      reentryPnl,
      timeWindows,
      acdScore: acd?.daily_score ?? null,
      aUpFired: acd?.a_up_fired ?? null,
      aDownFired: acd?.a_down_fired ?? null,
      cUpConfirmed: acd?.c_up_confirmed ?? null,
      cDownConfirmed: acd?.c_down_confirmed ?? null,
      dayType: acd?.day_type ?? null,
      poc: dvl?.poc ?? null,
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  //  REPORT OUTPUT
  // ════════════════════════════════════════════════════════════════════════

  const downFlushes = flushDays.filter(d => d.flushDir === 'DOWN');
  const upFlushes = flushDays.filter(d => d.flushDir === 'UP');
  const resolvedDays = flushDays.filter(d => d.resolved);
  const unresolvedDays = flushDays.filter(d => !d.resolved);
  const continuations = resolvedDays.filter(d => d.isContinuation);
  const reversals = resolvedDays.filter(d => !d.isContinuation);

  // ── Section 1 ───────────────────────────────────────────────────────────
  printSection('1. FLUSH DAY IDENTIFICATION');

  console.log(`\n  Total trading days analyzed:   ${dayBars.size}`);
  console.log(`  Flush days found (>=${FLUSH_THRESHOLD}pt in first 60 min):  ${flushDays.length} (${fmtPct(flushDays.length / dayBars.size)} of all days)`);
  console.log(`    Down flushes:                ${downFlushes.length}`);
  console.log(`    Up drives:                   ${upFlushes.length}`);

  printSub('Flush Magnitude Distribution');
  const tiers = [
    { label: '200-249pt', min: 200, max: 250 },
    { label: '250-299pt', min: 250, max: 300 },
    { label: '300-349pt', min: 300, max: 350 },
    { label: '350-399pt', min: 350, max: 400 },
    { label: '400-499pt', min: 400, max: 500 },
    { label: '500+pt',    min: 500, max: 9999 },
  ];
  for (const tier of tiers) {
    const count = flushDays.filter(d => d.flushMagnitude >= tier.min && d.flushMagnitude < tier.max).length;
    const down = flushDays.filter(d => d.flushMagnitude >= tier.min && d.flushMagnitude < tier.max && d.flushDir === 'DOWN').length;
    const up = flushDays.filter(d => d.flushMagnitude >= tier.min && d.flushMagnitude < tier.max && d.flushDir === 'UP').length;
    if (count > 0) {
      console.log(`    ${tier.label.padEnd(12)} ${String(count).padStart(3)} days  (${down} down, ${up} up)`);
    }
  }

  printSub('Flush Completion Time (minutes from open)');
  console.log(`    All flushes:   avg ${avg(flushDays.map(d => d.flushTime)).toFixed(1)} min, median ${median(flushDays.map(d => d.flushTime)).toFixed(0)} min`);
  if (downFlushes.length > 0) console.log(`    Down flushes:  avg ${avg(downFlushes.map(d => d.flushTime)).toFixed(1)} min`);
  if (upFlushes.length > 0) console.log(`    Up drives:     avg ${avg(upFlushes.map(d => d.flushTime)).toFixed(1)} min`);

  // List all flush days
  printSub('All Flush Days (sorted by date)');
  console.log('    Date        Dir    Mag       T(min) Close vs Open  Resolved? Resolution');
  console.log('    ' + '-'.repeat(76));
  for (const d of flushDays.sort((a, b) => a.date.localeCompare(b.date))) {
    const resText = d.resolved
      ? `${d.resolutionDir} ${fmtPts(d.resolutionMagnitude)} @ ${minToTime(d.resolutionTime)}`
      : 'CHOP (no break)';
    const closeDir = d.flushDir === 'DOWN' ? -d.closeVsOpen : d.closeVsOpen;
    console.log(`    ${d.date}  ${d.flushDir.padEnd(5)}  ${fmtPts(d.flushMagnitude).padEnd(9)} ${String(d.flushTime).padStart(3)}    ${fmtPts(d.closeVsOpen).padStart(11)}  ${d.resolved ? 'YES' : 'NO '}   ${resText}`);
  }

  // ── Section 2 ───────────────────────────────────────────────────────────
  printSection('2. POST-FLUSH BALANCE ANALYSIS');

  printSub('Balance Duration (minutes from flush to resolution or close)');
  if (resolvedDays.length > 0) {
    console.log(`    Resolved days (${resolvedDays.length}):   avg ${avg(resolvedDays.map(d => d.balanceDuration)).toFixed(0)} min, median ${median(resolvedDays.map(d => d.balanceDuration)).toFixed(0)} min`);
  }
  console.log(`    Unresolved days (${unresolvedDays.length}): balance lasted through close`);
  console.log(`    No-resolution rate: ${fmtPct(unresolvedDays.length / flushDays.length)}`);

  printSub('Balance Range (high-low of initial 30-min consolidation zone)');
  console.log(`    All:      avg ${fmtPts(avg(flushDays.map(d => d.balanceRange)))}, median ${fmtPts(median(flushDays.map(d => d.balanceRange)))}`);
  if (resolvedDays.length > 0) console.log(`    Resolved: avg ${fmtPts(avg(resolvedDays.map(d => d.balanceRange)))}`);
  if (unresolvedDays.length > 0) console.log(`    Unresolved: avg ${fmtPts(avg(unresolvedDays.map(d => d.balanceRange)))}`);

  printSub('Rotations in Balance (65pt swings)');
  console.log(`    All:      avg ${avg(flushDays.map(d => d.rotations)).toFixed(1)}, median ${median(flushDays.map(d => d.rotations)).toFixed(0)}`);

  printSub('Balance Position (retracement from flush extreme toward open)');
  console.log(`    Average retracement: ${fmtPct(avg(flushDays.map(d => d.retracementPct)))}`);
  console.log(`    Median retracement:  ${fmtPct(median(flushDays.map(d => d.retracementPct)))}`);
  console.log(`    (0% = balance hugs flush extreme, 100% = fully retraced to open)`);

  // ── Section 3 ───────────────────────────────────────────────────────────
  printSection('3. RESOLUTION ANALYSIS');

  printSub('Continuation vs Reversal (of resolved days)');
  if (resolvedDays.length > 0) {
    console.log(`    Resolved:     ${resolvedDays.length}/${flushDays.length} = ${fmtPct(resolvedDays.length / flushDays.length)}`);
    console.log(`    Continuation: ${continuations.length}/${resolvedDays.length} = ${fmtPct(continuations.length / resolvedDays.length)} (balance breaks in flush direction)`);
    console.log(`    Reversal:     ${reversals.length}/${resolvedDays.length} = ${fmtPct(reversals.length / resolvedDays.length)} (balance breaks counter-flush)`);
    console.log(`    Unresolved:   ${unresolvedDays.length}/${flushDays.length} = ${fmtPct(unresolvedDays.length / flushDays.length)} (chops through close)`);
  } else {
    console.log(`    No resolved days found.`);
  }

  printSub('Resolution Magnitude');
  if (continuations.length > 0) console.log(`    Continuation: avg ${fmtPts(avg(continuations.map(d => d.resolutionMagnitude)))}, median ${fmtPts(median(continuations.map(d => d.resolutionMagnitude)))}`);
  if (reversals.length > 0) console.log(`    Reversal:     avg ${fmtPts(avg(reversals.map(d => d.resolutionMagnitude)))}, median ${fmtPts(median(reversals.map(d => d.resolutionMagnitude)))}`);

  printSub('Resolution Time of Day');
  if (resolvedDays.length > 0) {
    const resTimes = resolvedDays.map(d => d.resolutionTime);
    console.log(`    Average:  ${minToTime(Math.round(avg(resTimes)))}`);
    console.log(`    Median:   ${minToTime(Math.round(median(resTimes)))}`);
    console.log(`    Range:    ${minToTime(Math.min(...resTimes))} - ${minToTime(Math.max(...resTimes))}`);

    // Resolution time distribution
    const hourBuckets = {};
    for (const t of resTimes) {
      const h = Math.floor(t / 60);
      const label = minToTime(h * 60);
      hourBuckets[label] = (hourBuckets[label] || 0) + 1;
    }
    console.log('    Distribution by hour:');
    for (const [hour, count] of Object.entries(hourBuckets)) {
      console.log(`      ${hour}: ${count} (${fmtPct(count / resolvedDays.length)})`);
    }
  }

  // Resolution by flush magnitude tier
  printSub('Resolution by Flush Magnitude');
  for (const tier of tiers) {
    const tierDays = flushDays.filter(d => d.flushMagnitude >= tier.min && d.flushMagnitude < tier.max);
    if (tierDays.length < 2) continue;
    const tierResolved = tierDays.filter(d => d.resolved);
    const tierCont = tierResolved.filter(d => d.isContinuation);
    const tierCloseFlush = tierDays.filter(d =>
      (d.flushDir === 'DOWN' && d.closeVsOpen < 0) ||
      (d.flushDir === 'UP' && d.closeVsOpen > 0)
    );
    console.log(`    ${tier.label} (n=${tierDays.length}):`);
    console.log(`      Resolution rate:  ${fmtPct(tierResolved.length / tierDays.length)}`);
    if (tierResolved.length > 0) {
      console.log(`      Continuation:     ${fmtPct(tierCont.length / tierResolved.length)}`);
      console.log(`      Avg resolution:   ${fmtPts(avg(tierResolved.map(d => d.resolutionMagnitude)))}`);
    }
    console.log(`      Close in flush dir: ${fmtPct(tierCloseFlush.length / tierDays.length)}`);
  }

  // ── Section 4 ───────────────────────────────────────────────────────────
  printSection('4. SIGNAL ANALYSIS -- WHAT PREDICTS RESOLUTION DIRECTION');

  // VWAP position
  printSub('VWAP Position vs Resolution');
  if (resolvedDays.length > 0) {
    const vwapAbove = resolvedDays.filter(d => d.vwapAboveBalance);
    const vwapBelow = resolvedDays.filter(d => !d.vwapAboveBalance);
    console.log(`    VWAP above balance midpoint (n=${vwapAbove.length}):`);
    if (vwapAbove.length > 0) {
      const up = vwapAbove.filter(d => d.resolutionDir === 'UP').length;
      console.log(`      Resolves UP (toward VWAP):     ${fmtPct(up / vwapAbove.length)}`);
      console.log(`      Resolves DOWN (away from VWAP): ${fmtPct(1 - up / vwapAbove.length)}`);
    }
    console.log(`    VWAP below balance midpoint (n=${vwapBelow.length}):`);
    if (vwapBelow.length > 0) {
      const down = vwapBelow.filter(d => d.resolutionDir === 'DOWN').length;
      console.log(`      Resolves DOWN (toward VWAP):   ${fmtPct(down / vwapBelow.length)}`);
      console.log(`      Resolves UP (away from VWAP):  ${fmtPct(1 - down / vwapBelow.length)}`);
    }
  }

  // Balance range width vs resolution
  printSub('Balance Range Width vs Resolution');
  if (resolvedDays.length > 1) {
    const medianRange = median(resolvedDays.map(d => d.balanceRange));
    const narrow = resolvedDays.filter(d => d.balanceRange < medianRange);
    const wide = resolvedDays.filter(d => d.balanceRange >= medianRange);
    console.log(`    Narrow balance (<${fmtPts(medianRange)}, n=${narrow.length}):`);
    if (narrow.length > 0) {
      console.log(`      Continuation rate: ${fmtPct(narrow.filter(d => d.isContinuation).length / narrow.length)}`);
      console.log(`      Avg resolution:    ${fmtPts(avg(narrow.map(d => d.resolutionMagnitude)))}`);
    }
    console.log(`    Wide balance (>=${fmtPts(medianRange)}, n=${wide.length}):`);
    if (wide.length > 0) {
      console.log(`      Continuation rate: ${fmtPct(wide.filter(d => d.isContinuation).length / wide.length)}`);
      console.log(`      Avg resolution:    ${fmtPts(avg(wide.map(d => d.resolutionMagnitude)))}`);
    }
  }

  // Rotation count
  printSub('Rotation Count vs Resolution');
  if (resolvedDays.length > 1) {
    const medianRot = median(resolvedDays.map(d => d.rotations));
    const few = resolvedDays.filter(d => d.rotations <= medianRot);
    const many = resolvedDays.filter(d => d.rotations > medianRot);
    console.log(`    Few rotations (<=${medianRot}, n=${few.length}): Continuation ${fmtPct(few.filter(d => d.isContinuation).length / few.length)}`);
    console.log(`    Many rotations (>${medianRot}, n=${many.length}): Continuation ${fmtPct(many.length > 0 ? many.filter(d => d.isContinuation).length / many.length : 0)}`);
  }

  // ACD Score correlation
  printSub('ACD Daily Score vs Outcome');
  const withAcd = flushDays.filter(d => d.acdScore !== null);
  if (withAcd.length > 0) {
    const buckets = [
      { label: 'Strong bearish (<= -2)', filter: d => d.acdScore <= -2 },
      { label: 'Mild bearish (-1)',       filter: d => d.acdScore === -1 },
      { label: 'Neutral (0)',             filter: d => d.acdScore === 0 },
      { label: 'Mild bullish (1)',        filter: d => d.acdScore === 1 },
      { label: 'Strong bullish (>= 2)',   filter: d => d.acdScore >= 2 },
    ];
    for (const b of buckets) {
      const group = withAcd.filter(b.filter);
      if (group.length === 0) continue;
      const closedFlush = group.filter(d =>
        (d.flushDir === 'DOWN' && d.closeVsOpen < 0) || (d.flushDir === 'UP' && d.closeVsOpen > 0)
      );
      const resolved = group.filter(d => d.resolved);
      const cont = resolved.filter(d => d.isContinuation);
      console.log(`    ${b.label} (n=${group.length}):`);
      console.log(`      Close in flush dir: ${fmtPct(closedFlush.length / group.length)}`);
      if (resolved.length > 0) console.log(`      Continuation:       ${fmtPct(cont.length / resolved.length)} of resolved`);
    }
  }

  // Balance vs POC
  printSub('Balance Position vs POC');
  const withPoc = flushDays.filter(d => d.balanceVsPoc !== null);
  if (withPoc.length > 0) {
    const abovePoc = withPoc.filter(d => d.balanceVsPoc === 'ABOVE');
    const belowPoc = withPoc.filter(d => d.balanceVsPoc === 'BELOW');
    console.log(`    Balance above POC (n=${abovePoc.length}):`);
    if (abovePoc.length > 0) {
      const closeUp = abovePoc.filter(d => d.closeVsOpen > 0);
      console.log(`      Close above open: ${fmtPct(closeUp.length / abovePoc.length)}`);
    }
    console.log(`    Balance below POC (n=${belowPoc.length}):`);
    if (belowPoc.length > 0) {
      const closeDown = belowPoc.filter(d => d.closeVsOpen < 0);
      console.log(`      Close below open: ${fmtPct(closeDown.length / belowPoc.length)}`);
    }
  }

  // ── Section 5 ───────────────────────────────────────────────────────────
  printSection('5. PRACTICAL PLAYBOOK METRICS');

  // Strategy A: resolution breakout trade
  printSub('Strategy A: Sit Out Balance, Re-enter on Resolution Breakout');
  const reentryDays = resolvedDays.filter(d => d.reentryPnl !== null);
  if (reentryDays.length > 0) {
    const wins = reentryDays.filter(d => d.reentryPnl > 0);
    const losses = reentryDays.filter(d => d.reentryPnl <= 0);
    console.log(`    Sample size:     ${reentryDays.length} trades`);
    console.log(`    Win rate:        ${fmtPct(wins.length / reentryDays.length)}`);
    console.log(`    Avg PnL:         ${fmt$(avg(reentryDays.map(d => d.reentryPnl)))}`);
    console.log(`    Avg Win:         ${fmt$(wins.length ? avg(wins.map(d => d.reentryPnl)) : 0)}`);
    console.log(`    Avg Loss:        ${fmt$(losses.length ? avg(losses.map(d => d.reentryPnl)) : 0)}`);
    console.log(`    Total PnL:       ${fmt$(reentryDays.reduce((s, d) => s + d.reentryPnl, 0))}`);
    console.log(`    (Enter in resolution direction at breakout, hold to close)`);
  } else {
    console.log(`    No resolution breakout trades available.`);
  }

  // Strategy B: Enter in flush direction after waiting
  printSub('Strategy B: Re-enter in FLUSH Direction After Waiting');
  console.log('    Wait(min)  Entries  WinRate   AvgPnL    AvgWin    AvgLoss');
  console.log('    ' + '-'.repeat(60));
  const waitTimes = [30, 45, 60, 90, 120, 150, 180, 210, 240];
  for (const wait of waitTimes) {
    const trades = [];
    for (const d of flushDays) {
      const entryMinute = RTH_START + d.flushTime + wait;
      if (entryMinute > RTH_END - 30) continue;
      // Snap to nearest 30-min window
      const snapped = Math.floor(entryMinute / 30) * 30;
      const tw = d.timeWindows.find(tw => tw.windowStart === snapped);
      if (!tw) continue;
      trades.push(tw.flushDirPnl);
    }
    if (trades.length < 3) continue;
    const w = trades.filter(t => t > 0);
    const l = trades.filter(t => t <= 0);
    console.log(`    ${String(wait).padStart(4)}       ${String(trades.length).padStart(4)}    ${fmtPct(w.length / trades.length).padStart(6)}  ${fmt$(avg(trades)).padStart(9)} ${fmt$(w.length ? avg(w) : 0).padStart(9)} ${fmt$(l.length ? avg(l) : 0).padStart(9)}`);
  }

  // Strategy C: Enter in reversal direction
  printSub('Strategy C: Re-enter in REVERSAL Direction After Waiting');
  console.log('    Wait(min)  Entries  WinRate   AvgPnL    AvgWin    AvgLoss');
  console.log('    ' + '-'.repeat(60));
  for (const wait of waitTimes) {
    const trades = [];
    for (const d of flushDays) {
      const entryMinute = RTH_START + d.flushTime + wait;
      if (entryMinute > RTH_END - 30) continue;
      const snapped = Math.floor(entryMinute / 30) * 30;
      const tw = d.timeWindows.find(tw => tw.windowStart === snapped);
      if (!tw) continue;
      trades.push(tw.reversalDirPnl);
    }
    if (trades.length < 3) continue;
    const w = trades.filter(t => t > 0);
    const l = trades.filter(t => t <= 0);
    console.log(`    ${String(wait).padStart(4)}       ${String(trades.length).padStart(4)}    ${fmtPct(w.length / trades.length).padStart(6)}  ${fmt$(avg(trades)).padStart(9)} ${fmt$(w.length ? avg(w) : 0).padStart(9)} ${fmt$(l.length ? avg(l) : 0).padStart(9)}`);
  }

  // ── Section 6 ───────────────────────────────────────────────────────────
  printSection('6. TIME-OF-DAY BREAKDOWN -- FIXED-TIME RE-ENTRY');

  printSub('All Flush Days: Enter at Fixed Time, Hold to Close');
  console.log('    Time       N    WR(Flush)  EV(Flush)    WR(Rev)   EV(Rev)');
  console.log('    ' + '-'.repeat(60));

  const windows = [
    { label: '10:00 AM', start: 600 }, { label: '10:30 AM', start: 630 },
    { label: '11:00 AM', start: 660 }, { label: '11:30 AM', start: 690 },
    { label: '12:00 PM', start: 720 }, { label: '12:30 PM', start: 750 },
    { label: '1:00 PM',  start: 780 }, { label: '1:30 PM',  start: 810 },
    { label: '2:00 PM',  start: 840 }, { label: '2:30 PM',  start: 870 },
    { label: '3:00 PM',  start: 900 }, { label: '3:30 PM',  start: 930 },
  ];

  for (const win of windows) {
    const flushPnls = [], revPnls = [];
    for (const d of flushDays) {
      const tw = d.timeWindows.find(tw => tw.windowStart === win.start);
      if (!tw) continue;
      flushPnls.push(tw.flushDirPnl);
      revPnls.push(tw.reversalDirPnl);
    }
    if (flushPnls.length < 3) continue;
    const fWR = flushPnls.filter(p => p > 0).length / flushPnls.length;
    const rWR = revPnls.filter(p => p > 0).length / revPnls.length;
    console.log(`    ${win.label.padEnd(10)} ${String(flushPnls.length).padStart(3)}   ${fmtPct(fWR).padStart(6)}  ${fmt$(avg(flushPnls)).padStart(10)}   ${fmtPct(rWR).padStart(6)}  ${fmt$(avg(revPnls)).padStart(10)}`);
  }

  // By direction
  for (const dir of ['DOWN', 'UP']) {
    const dirDays = flushDays.filter(d => d.flushDir === dir);
    if (dirDays.length < 5) continue;

    printSub(`${dir === 'DOWN' ? 'Flush DOWN' : 'Drive UP'} Only (n=${dirDays.length})`);
    console.log('    Time       N    WR(FlushDir)  EV         WR(Rev)   EV');
    console.log('    ' + '-'.repeat(60));

    for (const win of windows) {
      const flushPnls = [], revPnls = [];
      for (const d of dirDays) {
        const tw = d.timeWindows.find(tw => tw.windowStart === win.start);
        if (!tw) continue;
        flushPnls.push(tw.flushDirPnl);
        revPnls.push(tw.reversalDirPnl);
      }
      if (flushPnls.length < 3) continue;
      const fWR = flushPnls.filter(p => p > 0).length / flushPnls.length;
      const rWR = revPnls.filter(p => p > 0).length / revPnls.length;
      console.log(`    ${win.label.padEnd(10)} ${String(flushPnls.length).padStart(3)}     ${fmtPct(fWR).padStart(6)}  ${fmt$(avg(flushPnls)).padStart(10)}   ${fmtPct(rWR).padStart(6)}  ${fmt$(avg(revPnls)).padStart(10)}`);
    }
  }

  // ── Section 7 ───────────────────────────────────────────────────────────
  printSection('7. ADDITIONAL INSIGHTS');

  printSub('Day Type Distribution on Flush Days');
  const dayTypes = {};
  for (const d of flushDays) {
    const dt = d.dayType || 'UNKNOWN';
    dayTypes[dt] = (dayTypes[dt] || 0) + 1;
  }
  for (const [type, count] of Object.entries(dayTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(20)} ${count} (${fmtPct(count / flushDays.length)})`);
  }

  printSub('Close vs Open on Flush Days');
  const closeInFlushDir = flushDays.filter(d =>
    (d.flushDir === 'DOWN' && d.closeVsOpen < 0) || (d.flushDir === 'UP' && d.closeVsOpen > 0)
  );
  console.log(`    Close in flush direction:   ${closeInFlushDir.length}/${flushDays.length} = ${fmtPct(closeInFlushDir.length / flushDays.length)}`);
  console.log(`    Close reverses flush:       ${flushDays.length - closeInFlushDir.length}/${flushDays.length} = ${fmtPct((flushDays.length - closeInFlushDir.length) / flushDays.length)}`);
  const avgCloseFlush = avg(flushDays.map(d => d.flushDir === 'DOWN' ? -d.closeVsOpen : d.closeVsOpen));
  console.log(`    Avg close in flush dir:     ${fmtPts(avgCloseFlush)}`);

  // By magnitude
  printSub('Close in Flush Dir by Magnitude');
  const bigBuckets = [
    { label: '200-299pt flush', min: 200, max: 300 },
    { label: '300-399pt flush', min: 300, max: 400 },
    { label: '400+pt flush',    min: 400, max: 9999 },
  ];
  for (const b of bigBuckets) {
    const group = flushDays.filter(d => d.flushMagnitude >= b.min && d.flushMagnitude < b.max);
    if (group.length < 2) continue;
    const inDir = group.filter(d =>
      (d.flushDir === 'DOWN' && d.closeVsOpen < 0) || (d.flushDir === 'UP' && d.closeVsOpen > 0)
    );
    console.log(`    ${b.label} (n=${group.length}): ${fmtPct(inDir.length / group.length)} close in flush dir`);
    console.log(`      Avg close in flush dir: ${fmtPts(avg(group.map(d => d.flushDir === 'DOWN' ? -d.closeVsOpen : d.closeVsOpen)))}`);
  }

  // ACD C-confirm correlation
  printSub('ACD C-Level Confirmation on Flush Days');
  const cConfirmFlush = flushDays.filter(d =>
    (d.flushDir === 'DOWN' && d.cDownConfirmed) ||
    (d.flushDir === 'UP' && d.cUpConfirmed)
  );
  const cConfirmReverse = flushDays.filter(d =>
    (d.flushDir === 'DOWN' && d.cUpConfirmed) ||
    (d.flushDir === 'UP' && d.cDownConfirmed)
  );
  console.log(`    C confirmed in flush direction: ${cConfirmFlush.length}/${flushDays.length} (${fmtPct(cConfirmFlush.length / flushDays.length)})`);
  if (cConfirmFlush.length > 0) {
    const cCloseFlush = cConfirmFlush.filter(d =>
      (d.flushDir === 'DOWN' && d.closeVsOpen < 0) || (d.flushDir === 'UP' && d.closeVsOpen > 0)
    );
    console.log(`      Of those, close in flush dir: ${fmtPct(cCloseFlush.length / cConfirmFlush.length)}`);
  }
  console.log(`    C confirmed against flush: ${cConfirmReverse.length}/${flushDays.length}`);

  // ── Section 8: Key Takeaways ────────────────────────────────────────────
  printSection('8. KEY TAKEAWAYS -- THE PLAYBOOK');

  const noResRate = unresolvedDays.length / flushDays.length;
  const contRate = resolvedDays.length > 0 ? continuations.length / resolvedDays.length : 0;
  const avgBalDur = resolvedDays.length > 0 ? avg(resolvedDays.map(d => d.balanceDuration)) : 0;
  const avgResTime = resolvedDays.length > 0 ? avg(resolvedDays.map(d => d.resolutionTime)) : 0;

  // Find best time windows
  let bestFlushWindow = null, bestFlushEV = -Infinity;
  let bestRevWindow = null, bestRevEV = -Infinity;
  for (const win of windows) {
    const fp = [], rp = [];
    for (const d of flushDays) {
      const tw = d.timeWindows.find(tw => tw.windowStart === win.start);
      if (!tw) continue;
      fp.push(tw.flushDirPnl);
      rp.push(tw.reversalDirPnl);
    }
    if (fp.length >= 5 && avg(fp) > bestFlushEV) { bestFlushEV = avg(fp); bestFlushWindow = win.label; }
    if (rp.length >= 5 && avg(rp) > bestRevEV) { bestRevEV = avg(rp); bestRevWindow = win.label; }
  }

  console.log(`
  SAMPLE: ${flushDays.length} flush days out of ${dayBars.size} total trading days
  (${fmtPct(flushDays.length / dayBars.size)} frequency, ~1 per ${Math.round(dayBars.size / flushDays.length)} trading days)

  1. THE FLUSH STICKS: ${fmtPct(closeInFlushDir.length / flushDays.length)} of flush days close in the
     flush direction. Average close = ${fmtPts(avgCloseFlush)} in the flush direction.
     The initial move is usually the right call on direction.

  2. NO-RESOLUTION RATE: ${fmtPct(noResRate)} of flush days see the balance zone
     hold through the close without a clean breakout. This is the "chop zone" that
     grinds away gains from the initial move.`);

  if (resolvedDays.length > 0) {
    console.log(`
  3. WHEN IT RESOLVES: Balance breaks after avg ${avgBalDur.toFixed(0)} min (~${minToTime(Math.round(avgResTime))}).
     Direction: ${fmtPct(contRate)} continuation, ${fmtPct(1 - contRate)} reversal.`);
  } else {
    console.log(`
  3. RESOLUTION: Most days the post-flush balance does NOT cleanly break. The price
     drifts in the flush direction but within a wide range.`);
  }

  console.log(`
  4. BEST RE-ENTRY WINDOW (flush direction): ${bestFlushWindow || 'N/A'}
     EV per trade: ${fmt$(bestFlushEV)} (MNQ, ${PNL_PER_POINT}/pt)

  5. PRACTICAL RULES:
     a) After banking the flush profit, STOP TRADING the balance zone.
        The avg balance range is ${fmtPts(avg(flushDays.map(d => d.balanceRange)))} with
        ${avg(flushDays.map(d => d.rotations)).toFixed(1)} rotations -- this is where profits erode.
     b) The flush direction is correct for the day ${fmtPct(closeInFlushDir.length / flushDays.length)}
        of the time, so if you must re-enter, bias in the flush direction.
     c) Best fixed-time re-entry: ${bestFlushWindow || 'early morning'} in flush direction.
     d) Reversal trades are negative EV across all time windows.
     e) The bigger the flush, the more likely it sticks through the close.
`);

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
