// backtest_delta_edge.js
// Does delta state at a level touch improve fade win rates?
// Scans 12+ months of 1-min NQ bars, computes key levels, detects touches,
// classifies delta state, tracks fade vs break outcomes.

import { query } from '../server/db.js';
import * as ss from 'simple-statistics';

// ── Constants ──────────────────────────────────────────────────────────────
const PNL_PER_POINT = 2;
const COMMISSION = 1;
const TOUCH_THRESHOLD = 10;    // within 10pts of level
const FADE_TARGET = 20;        // 20pt move = fade success
const BREAK_TARGET = 20;       // 20pt through = break
const OUTCOME_WINDOW = 30;     // bars to track after touch
const ROLLING_DELTA_BARS = 15; // recent delta momentum window
const DIVERGENCE_WINDOW = 30;  // bars for divergence detection
const COOLDOWN_BARS = 15;      // min bars between touches at same level
const RTH_START = 570;         // 9:30 ET in minutes
const RTH_END = 959;           // 15:59 ET in minutes
const OR_END = 575;            // 9:35 ET (first 5 min)
const IB_END = 630;            // 10:30 ET (first 60 min)

// Lookback for data
const LOOKBACK_MONTHS = 13;
const START_DATE = new Date();
START_DATE.setMonth(START_DATE.getMonth() - LOOKBACK_MONTHS);
const START_DATE_STR = START_DATE.toISOString().slice(0, 10);

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(n, d = 1) { return n == null ? 'N/A' : Number(n).toFixed(d); }
function pct(n, d = 1) { return n == null ? 'N/A' : (n * 100).toFixed(d) + '%'; }

function proportionZTest(a, b) {
  if (a.n < 5 || b.n < 5) return { z: 0, p: 1 };
  const p1 = a.wins / a.n;
  const p2 = b.wins / b.n;
  const pPool = (a.wins + b.wins) / (a.n + b.n);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.n + 1 / b.n));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  const p = 2 * (1 - ss.cumulativeStdNormalProbability(Math.abs(z)));
  return { z, p };
}

// ── Data Loading ───────────────────────────────────────────────────────────
async function loadAllBars() {
  console.log(`Loading 1-min bars from ${START_DATE_STR}...`);
  const res = await query(`
    SELECT ts, open::float, high::float, low::float, close::float,
           volume, bid_volume, ask_volume
    FROM price_bars_primary
    WHERE ts::date >= $1
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN $2 AND $3
    ORDER BY ts
  `, [START_DATE_STR, RTH_START, RTH_END]);
  console.log(`  Loaded ${res.rows.length} bars`);
  return res.rows;
}

async function loadValueLog() {
  const res = await query(`
    SELECT trade_date, poc::float, vah::float, val::float,
           session_high::float, session_low::float, session_close::float
    FROM developing_value_log
    WHERE trade_date >= $1::date - INTERVAL '2 days'
    ORDER BY trade_date
  `, [START_DATE_STR]);
  const map = {};
  for (const r of res.rows) map[r.trade_date] = r;
  return map;
}

async function loadACDLog() {
  const res = await query(`
    SELECT trade_date, or_high::float, or_low::float
    FROM acd_daily_log
    WHERE trade_date >= $1::date - INTERVAL '2 days'
    ORDER BY trade_date
  `, [START_DATE_STR]);
  const map = {};
  for (const r of res.rows) map[r.trade_date] = r;
  return map;
}

// ── Group bars by trading date ─────────────────────────────────────────────
function groupBarsByDate(bars) {
  const days = {};
  for (const b of bars) {
    const d = new Date(b.ts).toISOString().slice(0, 10);
    if (!days[d]) days[d] = [];
    days[d].push(b);
  }
  return days;
}

// ── Compute floor pivots from prior day H/L/C ─────────────────────────────
function floorPivots(h, l, c) {
  const pp = (h + l + c) / 3;
  return {
    PP: pp,
    R1: 2 * pp - l,
    S1: 2 * pp - h,
    R2: pp + (h - l),
    S2: pp - (h - l),
  };
}

// ── Compute IB from bars (first 60 min: 9:30-10:29) ───────────────────────
function computeIB(bars) {
  let ibHigh = -Infinity, ibLow = Infinity;
  for (const b of bars) {
    const min = new Date(b.ts).getHours() * 60 + new Date(b.ts).getMinutes();
    if (min < IB_END) {
      if (b.high > ibHigh) ibHigh = b.high;
      if (b.low < ibLow) ibLow = b.low;
    }
  }
  return ibHigh > 0 ? { ibHigh, ibLow } : null;
}

// ── Delta computations ─────────────────────────────────────────────────────
function barDelta(b) {
  return (b.ask_volume || 0) - (b.bid_volume || 0);
}

// Cumulative delta from open to bar index i
function cumDeltaAt(bars, i) {
  let cd = 0;
  for (let j = 0; j <= i; j++) cd += barDelta(bars[j]);
  return cd;
}

// Precompute cumulative delta array for efficiency
function buildCumDelta(bars) {
  const cd = new Array(bars.length);
  cd[0] = barDelta(bars[0]);
  for (let i = 1; i < bars.length; i++) cd[i] = cd[i - 1] + barDelta(bars[i]);
  return cd;
}

// Rolling delta over last N bars
function rollingDelta(cumDelta, i, n) {
  if (i < n - 1) return cumDelta[i]; // not enough history, use all
  return cumDelta[i] - (i >= n ? cumDelta[i - n] : 0);
}

// Delta-price divergence detection over a window
// Returns { hasDivergence, type } where type is 'BULLISH' or 'BEARISH'
// Bullish div: price making lower lows but delta making higher lows
// Bearish div: price making higher highs but delta making lower highs
function detectDivergence(bars, cumDelta, endIdx, windowSize) {
  const startIdx = Math.max(0, endIdx - windowSize + 1);
  if (endIdx - startIdx < 10) return { hasDivergence: false, type: null, stretch: 0 };

  const midIdx = Math.floor((startIdx + endIdx) / 2);

  // Find price and delta extremes in first half and second half
  let priceLow1 = Infinity, priceLow2 = Infinity;
  let priceHigh1 = -Infinity, priceHigh2 = -Infinity;
  let deltaLow1 = Infinity, deltaLow2 = Infinity;
  let deltaHigh1 = -Infinity, deltaHigh2 = -Infinity;

  for (let i = startIdx; i <= midIdx; i++) {
    if (bars[i].low < priceLow1) priceLow1 = bars[i].low;
    if (bars[i].high > priceHigh1) priceHigh1 = bars[i].high;
    if (cumDelta[i] < deltaLow1) deltaLow1 = cumDelta[i];
    if (cumDelta[i] > deltaHigh1) deltaHigh1 = cumDelta[i];
  }
  for (let i = midIdx + 1; i <= endIdx; i++) {
    if (bars[i].low < priceLow2) priceLow2 = bars[i].low;
    if (bars[i].high > priceHigh2) priceHigh2 = bars[i].high;
    if (cumDelta[i] < deltaLow2) deltaLow2 = cumDelta[i];
    if (cumDelta[i] > deltaHigh2) deltaHigh2 = cumDelta[i];
  }

  // Compute developing range at endIdx for % stretch
  let dayHigh = -Infinity, dayLow = Infinity;
  for (let i = 0; i <= endIdx; i++) {
    if (bars[i].high > dayHigh) dayHigh = bars[i].high;
    if (bars[i].low < dayLow) dayLow = bars[i].low;
  }
  const devRange = dayHigh - dayLow;

  // Bullish divergence: lower price lows, higher delta lows
  if (priceLow2 < priceLow1 && deltaLow2 > deltaLow1) {
    const stretch = devRange > 0 ? Math.abs(priceLow1 - priceLow2) / devRange : 0;
    return { hasDivergence: true, type: 'BULLISH', stretch };
  }
  // Bearish divergence: higher price highs, lower delta highs
  if (priceHigh2 > priceHigh1 && deltaHigh2 < deltaHigh1) {
    const stretch = devRange > 0 ? Math.abs(priceHigh2 - priceHigh1) / devRange : 0;
    return { hasDivergence: true, type: 'BEARISH', stretch };
  }

  return { hasDivergence: false, type: null, stretch: 0 };
}

// ── Classify delta state relative to a fade direction ──────────────────────
// fadeDir: 'LONG' (buying the fade at support) or 'SHORT' (selling the fade at resistance)
function classifyDelta(cumDelta, rollDelta, divergence, fadeDir) {
  // For a LONG fade (price at support, we want to buy):
  //   SUPPORTS = delta positive (buyers present) or bullish divergence
  //   OPPOSES  = delta strongly negative (sellers dominating)
  // For a SHORT fade (price at resistance, we want to sell):
  //   SUPPORTS = delta negative (sellers present) or bearish divergence
  //   OPPOSES  = delta strongly positive (buyers pushing through)

  const absRoll = Math.abs(rollDelta);
  const threshold = 200; // minimum rolling delta to be meaningful

  if (fadeDir === 'LONG') {
    if (divergence.hasDivergence && divergence.type === 'BULLISH') return 'DELTA_SUPPORTS_FADE';
    if (rollDelta > threshold) return 'DELTA_SUPPORTS_FADE';
    if (rollDelta < -threshold) return 'DELTA_OPPOSES_FADE';
    return 'DELTA_NEUTRAL';
  } else { // SHORT
    if (divergence.hasDivergence && divergence.type === 'BEARISH') return 'DELTA_SUPPORTS_FADE';
    if (rollDelta < -threshold) return 'DELTA_SUPPORTS_FADE';
    if (rollDelta > threshold) return 'DELTA_OPPOSES_FADE';
    return 'DELTA_NEUTRAL';
  }
}

// ── Track outcome after touch ──────────────────────────────────────────────
// Returns { outcome, mfe, mae }
// outcome: 'FADE' if price moves FADE_TARGET pts in fade direction within window
//          'BREAK' if price moves BREAK_TARGET pts through the level
//          'NEUTRAL' if neither within window
function trackOutcome(bars, touchIdx, level, fadeDir) {
  let mfe = 0, mae = 0; // max favorable/adverse excursion in points

  for (let i = touchIdx + 1; i < Math.min(touchIdx + 1 + OUTCOME_WINDOW, bars.length); i++) {
    let fadeExcursion, breakExcursion;

    if (fadeDir === 'LONG') {
      // Fading DOWN at support: we want price to go UP
      fadeExcursion = bars[i].high - level;
      breakExcursion = level - bars[i].low;
    } else {
      // Fading UP at resistance: we want price to go DOWN
      fadeExcursion = level - bars[i].low;
      breakExcursion = bars[i].high - level;
    }

    if (fadeExcursion > mfe) mfe = fadeExcursion;
    if (breakExcursion > mae) mae = breakExcursion;
  }

  let outcome;
  if (mfe >= FADE_TARGET) outcome = 'FADE';
  else if (mae >= BREAK_TARGET) outcome = 'BREAK';
  else outcome = 'NEUTRAL';

  return { outcome, mfe, mae };
}

// ── Level definitions ──────────────────────────────────────────────────────
// Each level has: name, value, fadeDir ('LONG' at support, 'SHORT' at resistance)
// Some levels only valid after certain times (IB levels after IB close, etc.)
function getLevels(dayLevels) {
  const levels = [];
  if (dayLevels.pdPOC) levels.push({ name: 'PD_POC', value: dayLevels.pdPOC, fadeDir: null }); // both directions
  if (dayLevels.pdVAH) levels.push({ name: 'PD_VAH', value: dayLevels.pdVAH, fadeDir: 'SHORT' });
  if (dayLevels.pdVAL) levels.push({ name: 'PD_VAL', value: dayLevels.pdVAL, fadeDir: 'LONG' });
  if (dayLevels.orHigh) levels.push({ name: 'OR_HIGH', value: dayLevels.orHigh, fadeDir: 'SHORT', minBar: 6 }); // after OR close
  if (dayLevels.orLow) levels.push({ name: 'OR_LOW', value: dayLevels.orLow, fadeDir: 'LONG', minBar: 6 });
  if (dayLevels.ibHigh) levels.push({ name: 'IB_HIGH', value: dayLevels.ibHigh, fadeDir: 'SHORT', minBar: 60 }); // after IB close
  if (dayLevels.ibLow) levels.push({ name: 'IB_LOW', value: dayLevels.ibLow, fadeDir: 'LONG', minBar: 60 });
  if (dayLevels.PP) levels.push({ name: 'FLOOR_PP', value: dayLevels.PP, fadeDir: null });
  if (dayLevels.R1) levels.push({ name: 'FLOOR_R1', value: dayLevels.R1, fadeDir: 'SHORT' });
  if (dayLevels.S1) levels.push({ name: 'FLOOR_S1', value: dayLevels.S1, fadeDir: 'LONG' });
  if (dayLevels.R2) levels.push({ name: 'FLOOR_R2', value: dayLevels.R2, fadeDir: 'SHORT' });
  if (dayLevels.S2) levels.push({ name: 'FLOOR_S2', value: dayLevels.S2, fadeDir: 'LONG' });
  return levels;
}

// For bidirectional levels (POC, PP), determine fade direction from approach
function determineFadeDir(bars, idx, level) {
  // Look at last 3 bars to determine approach direction
  const lookback = Math.min(3, idx);
  let avgClose = 0;
  for (let i = idx - lookback; i < idx; i++) avgClose += bars[i].close;
  avgClose /= lookback || 1;

  if (avgClose > level + 2) return 'SHORT'; // approaching from above → fade short
  if (avgClose < level - 2) return 'LONG';  // approaching from below → fade long
  return bars[idx].close > level ? 'SHORT' : 'LONG'; // use current bar
}

// ── Touch Detection ────────────────────────────────────────────────────────
function detectTouches(bars, levels, cumDelta, dayDate) {
  const touches = [];
  const lastTouch = {}; // level name → last touch bar index (cooldown)

  for (let i = 1; i < bars.length; i++) {
    for (const level of levels) {
      // Skip if level requires minimum bar count
      if (level.minBar && i < level.minBar) continue;

      // Check cooldown
      const key = level.name;
      if (lastTouch[key] !== undefined && i - lastTouch[key] < COOLDOWN_BARS) continue;

      // Check if bar touches the level (price within threshold)
      const dist = Math.min(
        Math.abs(bars[i].high - level.value),
        Math.abs(bars[i].low - level.value),
        Math.abs(bars[i].close - level.value)
      );

      // More precise: did the bar actually reach the level?
      const barTouchesLevel = bars[i].low <= level.value + TOUCH_THRESHOLD &&
                              bars[i].high >= level.value - TOUCH_THRESHOLD;

      if (!barTouchesLevel) continue;

      // Determine fade direction
      let fadeDir = level.fadeDir;
      if (!fadeDir) fadeDir = determineFadeDir(bars, i, level.value);

      // Compute delta state
      const cd = cumDelta[i];
      const rd = rollingDelta(cumDelta, i, ROLLING_DELTA_BARS);
      const div = detectDivergence(bars, cumDelta, i, DIVERGENCE_WINDOW);
      const deltaClass = classifyDelta(cd, rd, div, fadeDir);

      // Track outcome
      const { outcome, mfe, mae } = trackOutcome(bars, i, level.value, fadeDir);

      // Determine day of week
      const dow = new Date(dayDate).getDay(); // 0=Sun, 4=Thu

      // Extract ET time from raw ts (stored as ET, but parsed as UTC by db.js Z-append)
      // Use the ISO string which preserves the original stored value
      const rawTs = bars[i].ts instanceof Date ? bars[i].ts.toISOString() : String(bars[i].ts);
      // The ISO string is like "2026-06-25T15:30:00.000Z" — the hours ARE the ET hours
      // because db.js appended Z to the raw ET value
      const etHour = parseInt(rawTs.slice(11, 13));
      const etMin = parseInt(rawTs.slice(14, 16));
      const etTime = `${String(etHour).padStart(2,'0')}:${String(etMin).padStart(2,'0')}`;

      touches.push({
        date: dayDate,
        levelName: level.name,
        levelValue: level.value,
        barIdx: i,
        time: etTime,
        etHour,
        fadeDir,
        cumDelta: cd,
        rollDelta: rd,
        divergence: div,
        deltaClass,
        outcome,
        mfe,
        mae,
        dow,
        isFade: outcome === 'FADE',
      });

      lastTouch[key] = i;
    }
  }

  return touches;
}

// ── Main Analysis ──────────────────────────────────────────────────────────
async function run() {
  console.log('='.repeat(80));
  console.log('DELTA STATE AT LEVEL TOUCHES — COMPREHENSIVE BACKTEST');
  console.log('='.repeat(80));
  console.log(`Period: ${START_DATE_STR} to present`);
  console.log(`Touch threshold: ${TOUCH_THRESHOLD}pts | Fade target: ${FADE_TARGET}pts | Window: ${OUTCOME_WINDOW} bars`);
  console.log(`Rolling delta: ${ROLLING_DELTA_BARS} bars | Divergence window: ${DIVERGENCE_WINDOW} bars`);
  console.log();

  // Load data
  const [bars, valueLog, acdLog] = await Promise.all([
    loadAllBars(),
    loadValueLog(),
    loadACDLog(),
  ]);

  const dayBars = groupBarsByDate(bars);
  const tradingDays = Object.keys(dayBars).sort();
  console.log(`Trading days: ${tradingDays.length}`);

  // Process each day
  const allTouches = [];
  let daysProcessed = 0;

  for (let di = 1; di < tradingDays.length; di++) {
    const today = tradingDays[di];
    const yesterday = tradingDays[di - 1];
    const barsToday = dayBars[today];
    const barsYesterday = dayBars[yesterday];

    if (!barsToday || barsToday.length < 60) continue;

    // Get prior day's value area from developing_value_log
    const pdValue = valueLog[yesterday];

    // Get OR from acd_daily_log (today's OR)
    const todayACD = acdLog[today];

    // Compute prior day H/L/C for floor pivots
    let pdHigh = -Infinity, pdLow = Infinity, pdClose = 0;
    for (const b of barsYesterday) {
      if (b.high > pdHigh) pdHigh = b.high;
      if (b.low < pdLow) pdLow = b.low;
    }
    pdClose = barsYesterday[barsYesterday.length - 1].close;

    const pivots = floorPivots(pdHigh, pdLow, pdClose);

    // Compute IB from today's bars
    const ib = computeIB(barsToday);

    // Build levels for today
    const dayLevels = {
      pdPOC: pdValue?.poc,
      pdVAH: pdValue?.vah,
      pdVAL: pdValue?.val,
      orHigh: todayACD?.or_high,
      orLow: todayACD?.or_low,
      ibHigh: ib?.ibHigh,
      ibLow: ib?.ibLow,
      ...pivots,
    };

    const levels = getLevels(dayLevels);
    if (levels.length === 0) continue;

    // Build cumulative delta for today
    const cumDelta = buildCumDelta(barsToday);

    // Detect touches
    const touches = detectTouches(barsToday, levels, cumDelta, today);
    allTouches.push(...touches);
    daysProcessed++;
  }

  console.log(`Days processed: ${daysProcessed}`);
  console.log(`Total level touches detected: ${allTouches.length}`);
  console.log();

  // ── Aggregate Results ────────────────────────────────────────────────────
  const levelNames = [...new Set(allTouches.map(t => t.levelName))].sort();

  // Helper to compute stats for a subset
  function computeStats(touches) {
    const n = touches.length;
    if (n === 0) return { n: 0, wins: 0, wr: 0, avgMFE: 0, avgMAE: 0, ev: 0 };
    const wins = touches.filter(t => t.isFade).length;
    const wr = wins / n;
    const avgMFE = touches.reduce((s, t) => s + t.mfe, 0) / n;
    const avgMAE = touches.reduce((s, t) => s + t.mae, 0) / n;
    // EV per trade: WR * avg_fade_profit - (1-WR) * avg_break_loss
    const faders = touches.filter(t => t.isFade);
    const breakers = touches.filter(t => !t.isFade);
    const avgWin = faders.length ? faders.reduce((s, t) => s + Math.min(t.mfe, FADE_TARGET), 0) / faders.length : FADE_TARGET;
    const avgLoss = breakers.length ? breakers.reduce((s, t) => s + Math.min(t.mae, BREAK_TARGET), 0) / breakers.length : BREAK_TARGET;
    const ev = wr * avgWin * PNL_PER_POINT - (1 - wr) * avgLoss * PNL_PER_POINT - COMMISSION;
    return { n, wins, wr, avgMFE, avgMAE, ev };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1: Per-Level Breakdown
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(80));
  console.log('SECTION 1: DELTA STATE IMPACT ON FADE WIN RATE BY LEVEL');
  console.log('='.repeat(80));

  for (const name of levelNames) {
    const lvlTouches = allTouches.filter(t => t.levelName === name);
    if (lvlTouches.length < 10) continue;

    const baseline = computeStats(lvlTouches);
    const supports = computeStats(lvlTouches.filter(t => t.deltaClass === 'DELTA_SUPPORTS_FADE'));
    const opposes = computeStats(lvlTouches.filter(t => t.deltaClass === 'DELTA_OPPOSES_FADE'));
    const neutral = computeStats(lvlTouches.filter(t => t.deltaClass === 'DELTA_NEUTRAL'));
    const divActive = computeStats(lvlTouches.filter(t => t.divergence.hasDivergence));

    const zTest = proportionZTest(
      { n: supports.n, wins: supports.wins },
      { n: opposes.n, wins: opposes.wins }
    );

    console.log(`\n--- ${name} ---`);
    console.log(`  Baseline:           N=${baseline.n.toString().padStart(4)}  WR=${pct(baseline.wr).padStart(7)}  avgMFE=${fmt(baseline.avgMFE).padStart(6)}  avgMAE=${fmt(baseline.avgMAE).padStart(6)}  EV=$${fmt(baseline.ev, 2)}`);
    console.log(`  Delta SUPPORTS:     N=${supports.n.toString().padStart(4)}  WR=${pct(supports.wr).padStart(7)}  avgMFE=${fmt(supports.avgMFE).padStart(6)}  avgMAE=${fmt(supports.avgMAE).padStart(6)}  EV=$${fmt(supports.ev, 2)}`);
    console.log(`  Delta OPPOSES:      N=${opposes.n.toString().padStart(4)}  WR=${pct(opposes.wr).padStart(7)}  avgMFE=${fmt(opposes.avgMFE).padStart(6)}  avgMAE=${fmt(opposes.avgMAE).padStart(6)}  EV=$${fmt(opposes.ev, 2)}`);
    console.log(`  Delta NEUTRAL:      N=${neutral.n.toString().padStart(4)}  WR=${pct(neutral.wr).padStart(7)}  avgMFE=${fmt(neutral.avgMFE).padStart(6)}  avgMAE=${fmt(neutral.avgMAE).padStart(6)}  EV=$${fmt(neutral.ev, 2)}`);
    console.log(`  Divergence active:  N=${divActive.n.toString().padStart(4)}  WR=${pct(divActive.wr).padStart(7)}  avgMFE=${fmt(divActive.avgMFE).padStart(6)}  avgMAE=${fmt(divActive.avgMAE).padStart(6)}  EV=$${fmt(divActive.ev, 2)}`);
    console.log(`  Z-test (supports vs opposes): z=${fmt(zTest.z, 3)}  p=${fmt(zTest.p, 4)}  ${zTest.p < 0.05 ? '*** SIGNIFICANT ***' : '(not significant)'}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2: PD_POC Deep Dive (The Money Question)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('SECTION 2: PD_POC DEEP DIVE — THE MONEY QUESTION');
  console.log('='.repeat(80));

  const pocTouches = allTouches.filter(t => t.levelName === 'PD_POC');
  if (pocTouches.length > 0) {
    // Overall
    const pocAll = computeStats(pocTouches);
    const pocSupports = computeStats(pocTouches.filter(t => t.deltaClass === 'DELTA_SUPPORTS_FADE'));
    const pocOpposes = computeStats(pocTouches.filter(t => t.deltaClass === 'DELTA_OPPOSES_FADE'));

    console.log(`\nPD_POC All touches:        N=${pocAll.n}  WR=${pct(pocAll.wr)}`);
    console.log(`PD_POC Delta supports:     N=${pocSupports.n}  WR=${pct(pocSupports.wr)}`);
    console.log(`PD_POC Delta opposes:      N=${pocOpposes.n}  WR=${pct(pocOpposes.wr)}`);

    // Thursday PD_POC
    const pocThursday = pocTouches.filter(t => t.dow === 4);
    const pocThuAll = computeStats(pocThursday);
    const pocThuSupports = computeStats(pocThursday.filter(t => t.deltaClass === 'DELTA_SUPPORTS_FADE'));
    console.log(`\nPD_POC Thursday:           N=${pocThuAll.n}  WR=${pct(pocThuAll.wr)}`);
    console.log(`PD_POC Thu + delta support: N=${pocThuSupports.n}  WR=${pct(pocThuSupports.wr)}`);

    // Does delta confirmation lift 64% to 70%+?
    console.log(`\n>>> Does delta confirmation lift PD_POC from baseline ${pct(pocAll.wr)} to 70%+?`);
    if (pocSupports.wr >= 0.70) {
      console.log(`    YES — Delta supports fade pushes WR to ${pct(pocSupports.wr)} (N=${pocSupports.n})`);
    } else {
      console.log(`    NO — Delta supports fade WR is ${pct(pocSupports.wr)} (N=${pocSupports.n})`);
    }

    // Post-flush days with bullish divergence at POC
    // "Post-flush" = prior day had large range (top quartile of daily ranges)
    const dailyRanges = {};
    for (const [date, dayBarsArr] of Object.entries(groupBarsByDate(bars))) {
      let hi = -Infinity, lo = Infinity;
      for (const b of dayBarsArr) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
      dailyRanges[date] = hi - lo;
    }
    const rangeValues = Object.values(dailyRanges).filter(v => v > 0).sort((a, b) => a - b);
    const p75 = rangeValues[Math.floor(rangeValues.length * 0.75)] || 200;

    const pocPostFlushBullDiv = pocTouches.filter(t => {
      const prevDay = tradingDays[tradingDays.indexOf(t.date) - 1];
      return prevDay && dailyRanges[prevDay] >= p75 &&
             t.divergence.hasDivergence && t.divergence.type === 'BULLISH' && t.fadeDir === 'LONG';
    });
    const pocPFBD = computeStats(pocPostFlushBullDiv);
    console.log(`\nPD_POC post-flush + bullish divergence (long fade):`);
    console.log(`    N=${pocPFBD.n}  WR=${pct(pocPFBD.wr)}  avgMFE=${fmt(pocPFBD.avgMFE)}  EV=$${fmt(pocPFBD.ev, 2)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3: Divergence Stretch Analysis
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('SECTION 3: DIVERGENCE STRETCH (% of developing range) vs FADE RELIABILITY');
  console.log('='.repeat(80));

  const divTouches = allTouches.filter(t => t.divergence.hasDivergence && t.divergence.stretch > 0);
  if (divTouches.length > 0) {
    // Bucket by stretch quartile
    const stretches = divTouches.map(t => t.divergence.stretch).sort((a, b) => a - b);
    const q25 = stretches[Math.floor(stretches.length * 0.25)];
    const q50 = stretches[Math.floor(stretches.length * 0.50)];
    const q75 = stretches[Math.floor(stretches.length * 0.75)];

    const buckets = [
      { label: `Q1 (stretch < ${pct(q25)})`, filter: t => t.divergence.stretch < q25 },
      { label: `Q2 (${pct(q25)} - ${pct(q50)})`, filter: t => t.divergence.stretch >= q25 && t.divergence.stretch < q50 },
      { label: `Q3 (${pct(q50)} - ${pct(q75)})`, filter: t => t.divergence.stretch >= q50 && t.divergence.stretch < q75 },
      { label: `Q4 (stretch >= ${pct(q75)})`, filter: t => t.divergence.stretch >= q75 },
    ];

    console.log(`\nTotal touches with divergence: ${divTouches.length}`);
    console.log(`Stretch quartiles: Q1<${pct(q25)} | Q2<${pct(q50)} | Q3<${pct(q75)} | Q4>=${pct(q75)}`);
    console.log();

    for (const bucket of buckets) {
      const bTouches = divTouches.filter(bucket.filter);
      const stats = computeStats(bTouches);
      console.log(`  ${bucket.label.padEnd(35)} N=${stats.n.toString().padStart(4)}  WR=${pct(stats.wr).padStart(7)}  avgMFE=${fmt(stats.avgMFE).padStart(6)}  EV=$${fmt(stats.ev, 2)}`);
    }

    // Also check: does bigger stretch = better across ALL levels?
    console.log('\n  Per-level divergence stretch (above-median vs below-median):');
    for (const name of levelNames) {
      const lvlDiv = divTouches.filter(t => t.levelName === name);
      if (lvlDiv.length < 10) continue;
      const lvlMedian = lvlDiv.map(t => t.divergence.stretch).sort((a, b) => a - b)[Math.floor(lvlDiv.length / 2)];
      const above = computeStats(lvlDiv.filter(t => t.divergence.stretch >= lvlMedian));
      const below = computeStats(lvlDiv.filter(t => t.divergence.stretch < lvlMedian));
      console.log(`    ${name.padEnd(15)} Below median: N=${below.n.toString().padStart(3)} WR=${pct(below.wr).padStart(7)} | Above median: N=${above.n.toString().padStart(3)} WR=${pct(above.wr).padStart(7)}  Δ=${pct(above.wr - below.wr).padStart(7)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4: Delta as Gate vs Sizer vs Ignore
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('SECTION 4: DELTA IMPACT SUMMARY — GATE / SIZER / IGNORE RECOMMENDATIONS');
  console.log('='.repeat(80));

  const recommendations = [];

  for (const name of levelNames) {
    const lvlTouches = allTouches.filter(t => t.levelName === name);
    if (lvlTouches.length < 20) continue;

    const baseline = computeStats(lvlTouches);
    const supports = computeStats(lvlTouches.filter(t => t.deltaClass === 'DELTA_SUPPORTS_FADE'));
    const opposes = computeStats(lvlTouches.filter(t => t.deltaClass === 'DELTA_OPPOSES_FADE'));

    const zTest = proportionZTest(
      { n: supports.n, wins: supports.wins },
      { n: opposes.n, wins: opposes.wins }
    );

    const wrDelta = supports.wr - opposes.wr;
    const evDelta = supports.ev - opposes.ev;

    let recommendation;
    if (zTest.p < 0.05 && wrDelta > 0.10) {
      recommendation = 'GATE';
    } else if (wrDelta > 0.05 && supports.n >= 15 && opposes.n >= 15) {
      recommendation = 'SIZER';
    } else {
      recommendation = 'IGNORE';
    }

    // Additional: can skipping "opposes" improve EV?
    const skipOpposesN = lvlTouches.filter(t => t.deltaClass !== 'DELTA_OPPOSES_FADE').length;
    const skipOpposesStats = computeStats(lvlTouches.filter(t => t.deltaClass !== 'DELTA_OPPOSES_FADE'));

    recommendations.push({
      name,
      baseline,
      supports,
      opposes,
      zTest,
      wrDelta,
      evDelta,
      recommendation,
      skipOpposesStats,
      skipOpposesN,
    });

    console.log(`\n${name}:`);
    console.log(`  Baseline WR: ${pct(baseline.wr)} (N=${baseline.n}) | EV: $${fmt(baseline.ev, 2)}/trade`);
    console.log(`  Supports WR: ${pct(supports.wr)} (N=${supports.n}) | Opposes WR: ${pct(opposes.wr)} (N=${opposes.n})`);
    console.log(`  WR uplift (supports - opposes): ${pct(wrDelta)} | EV uplift: $${fmt(evDelta, 2)}`);
    console.log(`  Z-test p-value: ${fmt(zTest.p, 4)} ${zTest.p < 0.05 ? '(significant)' : '(not significant)'}`);
    console.log(`  Skip "opposes" scenario: WR=${pct(skipOpposesStats.wr)} (N=${skipOpposesStats.n}) EV=$${fmt(skipOpposesStats.ev, 2)}`);
    console.log(`  >>> RECOMMENDATION: ${recommendation}`);
    if (recommendation === 'GATE') {
      console.log(`      Use delta as a hard filter. Skip trades when delta opposes the fade.`);
      console.log(`      Expected WR improvement: ${pct(baseline.wr)} → ${pct(skipOpposesStats.wr)}`);
    } else if (recommendation === 'SIZER') {
      console.log(`      Use delta for position sizing. Full size when supports, half when opposes.`);
    } else {
      console.log(`      Delta does not materially improve this level. Trade all touches.`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5: Summary Statistics Table
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('SECTION 5: SUMMARY TABLE');
  console.log('='.repeat(80));

  const header = ['Level', 'N', 'Base WR', 'Sup WR', 'Opp WR', 'Div WR', 'Sup-Opp', 'p-val', 'Rec'];
  const widths = [15, 6, 8, 8, 8, 8, 8, 8, 8];
  console.log('\n' + header.map((h, i) => h.padEnd(widths[i])).join(' | '));
  console.log('-'.repeat(header.reduce((s, _, i) => s + widths[i] + 3, 0)));

  for (const r of recommendations) {
    const divTch = allTouches.filter(t => t.levelName === r.name && t.divergence.hasDivergence);
    const divStats = computeStats(divTch);

    const row = [
      r.name.padEnd(widths[0]),
      r.baseline.n.toString().padStart(widths[1]),
      pct(r.baseline.wr).padStart(widths[2]),
      pct(r.supports.wr).padStart(widths[3]),
      pct(r.opposes.wr).padStart(widths[4]),
      pct(divStats.wr).padStart(widths[5]),
      pct(r.wrDelta).padStart(widths[6]),
      fmt(r.zTest.p, 4).padStart(widths[7]),
      r.recommendation.padStart(widths[8]),
    ];
    console.log(row.join(' | '));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6: Cross-Level Insights
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('SECTION 6: CROSS-LEVEL INSIGHTS');
  console.log('='.repeat(80));

  // Best delta-enhanced edges
  const significant = recommendations.filter(r => r.zTest.p < 0.10);
  if (significant.length > 0) {
    console.log('\nLevels where delta significantly (p<0.10) differentiates fade outcomes:');
    for (const r of significant.sort((a, b) => b.wrDelta - a.wrDelta)) {
      console.log(`  ${r.name}: WR spread = ${pct(r.wrDelta)}, p = ${fmt(r.zTest.p, 4)}`);
    }
  } else {
    console.log('\nNo levels showed statistically significant delta differentiation at p<0.10');
  }

  // Time-of-day effect on delta usefulness
  console.log('\nDelta impact by time of day:');
  // t.time was derived from JS Date which added 'Z' offset; use bar minute-of-day instead
  // We stored barIdx - compute from the original bars via the touch's time field
  // Actually, t.time was set from new Date(bars[i].ts) which has the Z offset issue
  // The bars are ET timestamps stored without tz. The DB parser adds Z.
  // So getHours() returns ET-shifted-to-UTC. We need to parse the raw ts string instead.
  // Since we have the touch time stored as HH:MM from JS Date (which is UTC due to Z),
  // we need to shift back. But simpler: just use the bar's minute-of-day from the SQL filter.
  // We know bars are between 570 (9:30) and 959 (15:59) in ET minutes.
  // Let's use the raw ts string instead.
  const amTouches = allTouches.filter(t => t.etHour < 12);
  const pmTouches = allTouches.filter(t => t.etHour >= 12);

  const amSup = computeStats(amTouches.filter(t => t.deltaClass === 'DELTA_SUPPORTS_FADE'));
  const amOpp = computeStats(amTouches.filter(t => t.deltaClass === 'DELTA_OPPOSES_FADE'));
  const pmSup = computeStats(pmTouches.filter(t => t.deltaClass === 'DELTA_SUPPORTS_FADE'));
  const pmOpp = computeStats(pmTouches.filter(t => t.deltaClass === 'DELTA_OPPOSES_FADE'));

  console.log(`  AM (before noon):  Supports WR=${pct(amSup.wr)} (N=${amSup.n})  Opposes WR=${pct(amOpp.wr)} (N=${amOpp.n})  Δ=${pct(amSup.wr - amOpp.wr)}`);
  console.log(`  PM (noon+):        Supports WR=${pct(pmSup.wr)} (N=${pmSup.n})  Opposes WR=${pct(pmOpp.wr)} (N=${pmOpp.n})  Δ=${pct(pmSup.wr - pmOpp.wr)}`);

  // Cumulative delta trend direction vs fade
  console.log('\nCumulative delta direction at touch (positive vs negative from open):');
  const cdPositive = allTouches.filter(t => t.cumDelta > 0);
  const cdNegative = allTouches.filter(t => t.cumDelta < 0);
  const cdPosLong = computeStats(cdPositive.filter(t => t.fadeDir === 'LONG'));
  const cdPosShort = computeStats(cdPositive.filter(t => t.fadeDir === 'SHORT'));
  const cdNegLong = computeStats(cdNegative.filter(t => t.fadeDir === 'LONG'));
  const cdNegShort = computeStats(cdNegative.filter(t => t.fadeDir === 'SHORT'));

  console.log(`  CumDelta > 0, Long fade:   WR=${pct(cdPosLong.wr)} (N=${cdPosLong.n})  — buying w/ buyers active`);
  console.log(`  CumDelta > 0, Short fade:  WR=${pct(cdPosShort.wr)} (N=${cdPosShort.n})  — selling against buyers`);
  console.log(`  CumDelta < 0, Long fade:   WR=${pct(cdNegLong.wr)} (N=${cdNegLong.n})  — buying against sellers`);
  console.log(`  CumDelta < 0, Short fade:  WR=${pct(cdNegShort.wr)} (N=${cdNegShort.n})  — selling w/ sellers active`);

  console.log('\n' + '='.repeat(80));
  console.log('BACKTEST COMPLETE');
  console.log('='.repeat(80));

  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
