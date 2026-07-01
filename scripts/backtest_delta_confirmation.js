/**
 * Delta Confirmation Filter Backtest
 *
 * Cross-references every setup fire in active_setups with the delta state
 * at the moment of firing. Tests whether delta confirmation improves
 * existing setup win rates.
 *
 * For each setup with >=20 resolved fires:
 *   - Computes cumulative delta direction, 30-min delta trend, divergence
 *   - Classifies each fire: DELTA_CONFIRMS / NEUTRAL / OPPOSES / DIVERGENCE_CONFIRMS
 *   - Computes WR + avg PnL per classification
 *   - Cross-references with day type
 *   - Makes practical recommendations (GATE / SIZER / IGNORE)
 */

import { query } from '../server/db.js';

// ── CONFIG ──────────────────────────────────────────────────────────────────
const RTH_START = 570;   // 9:30 ET in minutes-of-day
const RTH_END   = 959;   // 15:59 ET
const DELTA_WINDOW = 30; // 30-min window for delta trend & divergence
const NEUTRAL_ZONE = 0.25; // within 25% of zero range = neutral
const PNL_PER_POINT = 2;
const COMMISSION = 1;
const MIN_FIRES = 20;

// Setup direction mapping
const SETUP_DIRECTION = {
  'C_STANDALONE_UP':             'LONG',
  'C_STANDALONE_DOWN':           'SHORT',
  'IB_BULLISH':                  'LONG',
  'IB_BEARISH':                  'SHORT',
  'OPEN_DRIVE_LONG':             'LONG',
  'OPEN_DRIVE_SHORT':            'SHORT',
  'OPEN_TEST_DRIVE_LONG':        'LONG',
  'OPEN_TEST_DRIVE_SHORT':       'SHORT',
  'VALUE_AREA_RESPONSIVE_LONG':  'LONG',
  'VALUE_AREA_RESPONSIVE_SHORT': 'SHORT',
  'BRACKET_BREAKOUT_LONG':       'LONG',
  'BRACKET_BREAKOUT_SHORT':      'SHORT',
  'TRT_LONG':                    'LONG',
  'TRT_SHORT':                   'SHORT',
};

// ── HELPERS ─────────────────────────────────────────────────────────────────
function fmt(n, d = 1) { return n == null || isNaN(n) ? 'N/A' : Number(n).toFixed(d); }
function pct(n, d = 1) { return n == null || isNaN(n) ? 'N/A' : (n * 100).toFixed(d) + '%'; }
function padR(s, w) { return String(s).padEnd(w); }
function padL(s, w) { return String(s).padStart(w); }

function minuteOfDay(ts) {
  return ts.getUTCHours() * 60 + ts.getUTCMinutes();
}

// ── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(110));
  console.log('  DELTA CONFIRMATION FILTER BACKTEST');
  console.log('  Does delta state at setup fire time improve win rates?');
  console.log('='.repeat(110));
  console.log();

  // ──────────────────────────────────────────────────────────────────────
  // 1. Load all resolved setup fires with >=20 fires per setup_type
  // ──────────────────────────────────────────────────────────────────────
  console.log('Loading resolved setup fires...');
  const setupsRes = await query(`
    SELECT
      id, setup_type, trade_date, fired_at, resolution,
      actual_pnl::float,
      entry_zone_low::float, entry_zone_high::float,
      stop_level::float, t1_level::float,
      price_at_detection::float
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND fired_at IS NOT NULL
      AND setup_type IN (
        SELECT setup_type FROM active_setups
        WHERE resolution IN ('TARGET_HIT', 'STOP_HIT')
        GROUP BY setup_type HAVING COUNT(*) >= ${MIN_FIRES}
      )
    ORDER BY fired_at
  `);

  const fires = setupsRes.rows;
  console.log(`  ${fires.length} resolved fires across ${[...new Set(fires.map(f => f.setup_type))].length} setup types`);

  // ──────────────────────────────────────────────────────────────────────
  // 2. Load day types
  // ──────────────────────────────────────────────────────────────────────
  console.log('Loading day types...');
  const dayTypeRes = await query(`
    SELECT trade_date, day_type
    FROM acd_daily_log
    WHERE day_type IS NOT NULL AND day_type != ''
  `);
  const dayTypeMap = new Map();
  for (const row of dayTypeRes.rows) {
    dayTypeMap.set(row.trade_date, row.day_type);
  }
  console.log(`  ${dayTypeMap.size} days with day-type classification`);

  // ──────────────────────────────────────────────────────────────────────
  // 3. Load price bars with delta data
  // ──────────────────────────────────────────────────────────────────────
  // Get the date range we need
  const minDate = fires.reduce((m, f) => f.fired_at < m ? f.fired_at : m, fires[0].fired_at);
  const maxDate = fires.reduce((m, f) => f.fired_at > m ? f.fired_at : m, fires[0].fired_at);
  const minDateStr = new Date(minDate).toISOString().slice(0, 10);
  const maxDateStr = new Date(maxDate).toISOString().slice(0, 10);

  console.log(`Loading price bars from ${minDateStr} to ${maxDateStr}...`);
  const barsRes = await query(`
    SELECT
      ts,
      ts::date AS trade_date,
      EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int AS min_of_day,
      open::float, high::float, low::float, close::float,
      volume::int,
      COALESCE(bid_volume, 0)::int AS bid_vol,
      COALESCE(ask_volume, 0)::int AS ask_vol
    FROM price_bars_primary
    WHERE ts::date >= $1::date AND ts::date <= $2::date
      AND EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int BETWEEN ${RTH_START} AND ${RTH_END}
      AND bid_volume IS NOT NULL AND ask_volume IS NOT NULL
    ORDER BY ts
  `, [minDateStr, maxDateStr]);

  console.log(`  ${barsRes.rows.length} RTH bars loaded`);

  // ──────────────────────────────────────────────────────────────────────
  // 4. Organize bars by date for fast lookup
  // ──────────────────────────────────────────────────────────────────────
  const barsByDate = new Map();
  for (const bar of barsRes.rows) {
    const dateKey = bar.trade_date;
    if (!barsByDate.has(dateKey)) barsByDate.set(dateKey, []);
    barsByDate.get(dateKey).push({
      ts: bar.ts,
      minOfDay: bar.min_of_day,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      bidVol: bar.bid_vol,
      askVol: bar.ask_vol,
      delta: bar.ask_vol - bar.bid_vol, // per-bar delta
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // 5. For each fire, compute delta state at the moment of firing
  // ──────────────────────────────────────────────────────────────────────
  console.log('Computing delta state for each fire...');

  const results = []; // { ...fire, deltaState, deltaCategory, dayType }

  let skippedNoBars = 0;
  let skippedNoDirection = 0;

  for (const fire of fires) {
    const direction = SETUP_DIRECTION[fire.setup_type];
    if (!direction) {
      skippedNoDirection++;
      continue;
    }

    const dateKey = fire.trade_date;
    const dayBars = barsByDate.get(dateKey);
    if (!dayBars || dayBars.length === 0) {
      skippedNoBars++;
      continue;
    }

    // Find the bar index closest to fired_at
    const firedAt = new Date(fire.fired_at);
    const firedMinOfDay = firedAt.getUTCHours() * 60 + firedAt.getUTCMinutes();

    // Get all bars up to and including fired_at
    let fireIdx = -1;
    for (let i = 0; i < dayBars.length; i++) {
      if (dayBars[i].minOfDay <= firedMinOfDay) {
        fireIdx = i;
      } else {
        break;
      }
    }

    if (fireIdx < 0) {
      skippedNoBars++;
      continue;
    }

    // Need at least 2*DELTA_WINDOW bars before this point for trend calculation
    const startIdx = Math.max(0, fireIdx - 2 * DELTA_WINDOW + 1);
    const barsUpToFire = dayBars.slice(startIdx, fireIdx + 1);

    if (barsUpToFire.length < DELTA_WINDOW) {
      // Not enough bars for meaningful delta analysis - still process but note it
      // We'll use whatever we have
    }

    // ── Compute cumulative delta from RTH open to fired_at ──
    const allBarsToFire = dayBars.slice(0, fireIdx + 1);
    const cumDelta = allBarsToFire.reduce((sum, b) => sum + b.delta, 0);

    // ── Compute 30-min delta windows ──
    // Recent window: last DELTA_WINDOW bars
    const recentStart = Math.max(0, allBarsToFire.length - DELTA_WINDOW);
    const recentBars = allBarsToFire.slice(recentStart);
    const recentDelta = recentBars.reduce((sum, b) => sum + b.delta, 0);

    // Prior window: DELTA_WINDOW bars before the recent window
    const priorEnd = recentStart;
    const priorStart = Math.max(0, priorEnd - DELTA_WINDOW);
    const priorBars = allBarsToFire.slice(priorStart, priorEnd);
    const priorDelta = priorBars.length > 0 ? priorBars.reduce((sum, b) => sum + b.delta, 0) : 0;

    // Delta trend: acceleration (recent - prior)
    const deltaTrend = recentDelta - priorDelta;

    // ── Compute price movement over the same windows ──
    const recentPriceMove = recentBars.length >= 2
      ? recentBars[recentBars.length - 1].close - recentBars[0].open
      : 0;
    const priorPriceMove = priorBars.length >= 2
      ? priorBars[priorBars.length - 1].close - priorBars[0].open
      : 0;

    // ── Developing range at this point ──
    const sessionHigh = Math.max(...allBarsToFire.map(b => b.high));
    const sessionLow = Math.min(...allBarsToFire.map(b => b.low));
    const devRange = sessionHigh - sessionLow;

    // ── Divergence detection ──
    // Price going one direction, delta going the opposite
    let hasDivergence = false;
    let divergenceType = null; // 'BULLISH' or 'BEARISH'
    let divergenceStretch = 0;

    if (recentBars.length >= 10 && devRange > 0) {
      const priceDirDown = recentPriceMove < -2; // price falling (more than noise)
      const priceDirUp = recentPriceMove > 2;    // price rising
      const deltaRising = recentDelta > 0;
      const deltaFalling = recentDelta < 0;

      if (priceDirDown && deltaRising) {
        // Price falling but delta rising = bullish divergence (absorption)
        hasDivergence = true;
        divergenceType = 'BULLISH';
        divergenceStretch = Math.abs(recentPriceMove) / devRange;
      } else if (priceDirUp && deltaFalling) {
        // Price rising but delta falling = bearish divergence (distribution)
        hasDivergence = true;
        divergenceType = 'BEARISH';
        divergenceStretch = Math.abs(recentPriceMove) / devRange;
      }
    }

    // ── Classify delta state ──
    // Total volume in window for normalization
    const totalVol = recentBars.reduce((sum, b) => sum + b.volume, 0);
    const normalizedDelta = totalVol > 0 ? Math.abs(recentDelta) / totalVol : 0;

    // Determine if delta is meaningfully directional or neutral
    // Use cumulative delta direction AND recent trend
    const isNeutral = normalizedDelta < 0.02; // less than 2% net = noise

    let deltaCategory;

    // Check divergence confirmation first (most specific)
    if (hasDivergence) {
      const divConfirmsLong = divergenceType === 'BULLISH' && direction === 'LONG';
      const divConfirmsShort = divergenceType === 'BEARISH' && direction === 'SHORT';
      if (divConfirmsLong || divConfirmsShort) {
        deltaCategory = 'DIVERGENCE_CONFIRMS';
      }
    }

    if (!deltaCategory) {
      if (isNeutral) {
        deltaCategory = 'DELTA_NEUTRAL';
      } else {
        // Delta direction: use combination of cumulative and recent trend
        const deltaIsPositive = cumDelta > 0 && recentDelta > 0;
        const deltaIsNegative = cumDelta < 0 && recentDelta < 0;
        const deltaRising = deltaTrend > 0 && recentDelta > 0;
        const deltaFalling = deltaTrend < 0 && recentDelta < 0;

        // For LONG setups: positive/rising delta confirms
        // For SHORT setups: negative/falling delta confirms
        if (direction === 'LONG') {
          if (deltaIsPositive || deltaRising) {
            deltaCategory = 'DELTA_CONFIRMS';
          } else if (deltaIsNegative || deltaFalling) {
            deltaCategory = 'DELTA_OPPOSES';
          } else {
            deltaCategory = 'DELTA_NEUTRAL';
          }
        } else { // SHORT
          if (deltaIsNegative || deltaFalling) {
            deltaCategory = 'DELTA_CONFIRMS';
          } else if (deltaIsPositive || deltaRising) {
            deltaCategory = 'DELTA_OPPOSES';
          } else {
            deltaCategory = 'DELTA_NEUTRAL';
          }
        }
      }
    }

    const dayType = dayTypeMap.get(dateKey) || 'UNKNOWN';

    results.push({
      id: fire.id,
      setupType: fire.setup_type,
      direction,
      tradeDate: fire.trade_date,
      firedAt: fire.fired_at,
      resolution: fire.resolution,
      actualPnl: fire.actual_pnl,
      entryPrice: fire.price_at_detection || ((fire.entry_zone_low + fire.entry_zone_high) / 2),
      stopLevel: fire.stop_level,
      t1Level: fire.t1_level,
      cumDelta,
      recentDelta,
      priorDelta,
      deltaTrend,
      recentPriceMove,
      devRange,
      hasDivergence,
      divergenceType,
      divergenceStretch,
      normalizedDelta,
      deltaCategory,
      dayType,
    });
  }

  console.log(`  ${results.length} fires analyzed, ${skippedNoBars} skipped (no bars), ${skippedNoDirection} skipped (no direction)`);
  console.log();

  // ──────────────────────────────────────────────────────────────────────
  // 6. Compute statistics per setup × delta category
  // ──────────────────────────────────────────────────────────────────────
  const setupTypes = [...new Set(results.map(r => r.setupType))].sort();

  // Compute PnL for each fire
  // Use actual_pnl if available, otherwise estimate from stop/t1 levels
  function computePnl(r) {
    if (r.actualPnl != null && !isNaN(r.actualPnl)) {
      return r.actualPnl;
    }
    // Estimate from levels
    if (r.resolution === 'TARGET_HIT' && r.t1Level && r.entryPrice) {
      return Math.abs(r.t1Level - r.entryPrice) * PNL_PER_POINT - COMMISSION;
    }
    if (r.resolution === 'STOP_HIT' && r.stopLevel && r.entryPrice) {
      return -(Math.abs(r.stopLevel - r.entryPrice) * PNL_PER_POINT + COMMISSION);
    }
    return 0;
  }

  function computeStats(fires) {
    if (fires.length === 0) return { n: 0, wins: 0, wr: 0, avgPnl: 0, totalPnl: 0 };
    const wins = fires.filter(f => f.resolution === 'TARGET_HIT').length;
    const pnls = fires.map(computePnl);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    return {
      n: fires.length,
      wins,
      wr: wins / fires.length,
      avgPnl: totalPnl / fires.length,
      totalPnl,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // 7. MAIN OUTPUT TABLE
  // ──────────────────────────────────────────────────────────────────────
  console.log('='.repeat(110));
  console.log('  SECTION 1: DELTA CONFIRMATION IMPACT BY SETUP TYPE');
  console.log('='.repeat(110));
  console.log();

  const categories = ['DELTA_CONFIRMS', 'DELTA_NEUTRAL', 'DELTA_OPPOSES', 'DIVERGENCE_CONFIRMS'];
  const catShort = { 'DELTA_CONFIRMS': 'Confirms', 'DELTA_NEUTRAL': 'Neutral', 'DELTA_OPPOSES': 'Opposes', 'DIVERGENCE_CONFIRMS': 'Div.Confirms' };

  // Header
  const hdr = padR('Setup', 30)
    + padL('Base WR', 10) + padL('N', 5)
    + ' | ' + padL('Confirms', 10) + padL('N', 5)
    + ' | ' + padL('Neutral', 10) + padL('N', 5)
    + ' | ' + padL('Opposes', 10) + padL('N', 5)
    + ' | ' + padL('Div.Conf', 10) + padL('N', 5)
    + ' | ' + padL('Lift', 8);
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  const setupSummaries = [];

  for (const st of setupTypes) {
    const stFires = results.filter(r => r.setupType === st);
    const baseline = computeStats(stFires);

    const byCat = {};
    for (const cat of categories) {
      const catFires = stFires.filter(r => r.deltaCategory === cat);
      byCat[cat] = computeStats(catFires);
    }

    const confirmLift = byCat['DELTA_CONFIRMS'].n >= 5
      ? (byCat['DELTA_CONFIRMS'].wr - baseline.wr) * 100
      : null;

    const row = padR(st, 30)
      + padL(pct(baseline.wr), 10) + padL(baseline.n, 5)
      + ' | ' + padL(byCat['DELTA_CONFIRMS'].n >= 3 ? pct(byCat['DELTA_CONFIRMS'].wr) : 'n<3', 10) + padL(byCat['DELTA_CONFIRMS'].n, 5)
      + ' | ' + padL(byCat['DELTA_NEUTRAL'].n >= 3 ? pct(byCat['DELTA_NEUTRAL'].wr) : 'n<3', 10) + padL(byCat['DELTA_NEUTRAL'].n, 5)
      + ' | ' + padL(byCat['DELTA_OPPOSES'].n >= 3 ? pct(byCat['DELTA_OPPOSES'].wr) : 'n<3', 10) + padL(byCat['DELTA_OPPOSES'].n, 5)
      + ' | ' + padL(byCat['DIVERGENCE_CONFIRMS'].n >= 3 ? pct(byCat['DIVERGENCE_CONFIRMS'].wr) : 'n<3', 10) + padL(byCat['DIVERGENCE_CONFIRMS'].n, 5)
      + ' | ' + padL(confirmLift != null ? (confirmLift >= 0 ? '+' : '') + fmt(confirmLift, 1) + 'pp' : 'n/a', 8);

    console.log(row);

    setupSummaries.push({ st, baseline, byCat, confirmLift, fires: stFires });
  }

  // ──────────────────────────────────────────────────────────────────────
  // 8. DETAILED PNL TABLE
  // ──────────────────────────────────────────────────────────────────────
  console.log();
  console.log('='.repeat(110));
  console.log('  SECTION 2: AVERAGE PNL BY DELTA STATE');
  console.log('='.repeat(110));
  console.log();

  const hdr2 = padR('Setup', 30)
    + padL('Base AvgPnL', 12)
    + ' | ' + padL('Conf PnL', 10) + padL('N', 5)
    + ' | ' + padL('Neut PnL', 10) + padL('N', 5)
    + ' | ' + padL('Opp PnL', 10) + padL('N', 5)
    + ' | ' + padL('Div.C PnL', 10) + padL('N', 5);
  console.log(hdr2);
  console.log('-'.repeat(hdr2.length));

  for (const { st, baseline, byCat } of setupSummaries) {
    const row = padR(st, 30)
      + padL('$' + fmt(baseline.avgPnl, 2), 12)
      + ' | ' + padL(byCat['DELTA_CONFIRMS'].n >= 3 ? '$' + fmt(byCat['DELTA_CONFIRMS'].avgPnl, 2) : 'n<3', 10)
      + padL(byCat['DELTA_CONFIRMS'].n, 5)
      + ' | ' + padL(byCat['DELTA_NEUTRAL'].n >= 3 ? '$' + fmt(byCat['DELTA_NEUTRAL'].avgPnl, 2) : 'n<3', 10)
      + padL(byCat['DELTA_NEUTRAL'].n, 5)
      + ' | ' + padL(byCat['DELTA_OPPOSES'].n >= 3 ? '$' + fmt(byCat['DELTA_OPPOSES'].avgPnl, 2) : 'n<3', 10)
      + padL(byCat['DELTA_OPPOSES'].n, 5)
      + ' | ' + padL(byCat['DIVERGENCE_CONFIRMS'].n >= 3 ? '$' + fmt(byCat['DIVERGENCE_CONFIRMS'].avgPnl, 2) : 'n<3', 10)
      + padL(byCat['DIVERGENCE_CONFIRMS'].n, 5);
    console.log(row);
  }

  // ──────────────────────────────────────────────────────────────────────
  // 9. CROSS-REFERENCE WITH DAY TYPE
  // ──────────────────────────────────────────────────────────────────────
  console.log();
  console.log('='.repeat(110));
  console.log('  SECTION 3: DELTA CONFIRMATION LIFT BY DAY TYPE');
  console.log('  Does delta confirmation matter more on certain day types?');
  console.log('='.repeat(110));
  console.log();

  const dayTypes = ['TREND', 'BALANCE', 'TURBULENT'];

  for (const dt of dayTypes) {
    console.log(`  --- ${dt} DAYS ---`);
    const dtHdr = padR('Setup', 30)
      + padL('Base WR', 10) + padL('N', 5)
      + ' | ' + padL('Conf WR', 10) + padL('N', 5)
      + ' | ' + padL('Opp WR', 10) + padL('N', 5)
      + ' | ' + padL('Lift', 8);
    console.log(dtHdr);
    console.log('-'.repeat(dtHdr.length));

    for (const { st } of setupSummaries) {
      const dtFires = results.filter(r => r.setupType === st && r.dayType === dt);
      if (dtFires.length < 5) continue;

      const dtBaseline = computeStats(dtFires);
      const dtConf = computeStats(dtFires.filter(r => r.deltaCategory === 'DELTA_CONFIRMS'));
      const dtOpp = computeStats(dtFires.filter(r => r.deltaCategory === 'DELTA_OPPOSES'));

      const lift = dtConf.n >= 3 ? (dtConf.wr - dtBaseline.wr) * 100 : null;

      const row = padR(st, 30)
        + padL(pct(dtBaseline.wr), 10) + padL(dtBaseline.n, 5)
        + ' | ' + padL(dtConf.n >= 3 ? pct(dtConf.wr) : 'n<3', 10) + padL(dtConf.n, 5)
        + ' | ' + padL(dtOpp.n >= 3 ? pct(dtOpp.wr) : 'n<3', 10) + padL(dtOpp.n, 5)
        + ' | ' + padL(lift != null ? (lift >= 0 ? '+' : '') + fmt(lift, 1) + 'pp' : 'n/a', 8);
      console.log(row);
    }
    console.log();
  }

  // ──────────────────────────────────────────────────────────────────────
  // 10. DIVERGENCE DEEP-DIVE
  // ──────────────────────────────────────────────────────────────────────
  console.log('='.repeat(110));
  console.log('  SECTION 4: DIVERGENCE DEEP-DIVE');
  console.log('  Fires where active delta-price divergence was detected');
  console.log('='.repeat(110));
  console.log();

  const divFires = results.filter(r => r.hasDivergence);
  console.log(`  Total fires with active divergence: ${divFires.length}`);
  console.log();

  // By divergence type
  for (const divType of ['BULLISH', 'BEARISH']) {
    const typeFires = divFires.filter(r => r.divergenceType === divType);
    if (typeFires.length === 0) continue;

    console.log(`  ${divType} DIVERGENCE (price moves ${divType === 'BULLISH' ? 'down' : 'up'}, delta moves opposite):`);

    // By stretch bucket
    const stretchBuckets = [
      { label: '<10%',  lo: 0, hi: 0.10 },
      { label: '10-20%', lo: 0.10, hi: 0.20 },
      { label: '20-30%', lo: 0.20, hi: 0.30 },
      { label: '30%+',   lo: 0.30, hi: Infinity },
    ];

    for (const bucket of stretchBuckets) {
      const bFires = typeFires.filter(r => r.divergenceStretch >= bucket.lo && r.divergenceStretch < bucket.hi);
      if (bFires.length === 0) continue;
      const stats = computeStats(bFires);
      // How many of these align with setup direction?
      const confirming = bFires.filter(r =>
        (divType === 'BULLISH' && r.direction === 'LONG') ||
        (divType === 'BEARISH' && r.direction === 'SHORT')
      );
      const confStats = computeStats(confirming);
      const opposing = bFires.filter(r =>
        (divType === 'BULLISH' && r.direction === 'SHORT') ||
        (divType === 'BEARISH' && r.direction === 'LONG')
      );
      const oppStats = computeStats(opposing);

      console.log(`    Stretch ${bucket.label}: N=${stats.n}, WR=${pct(stats.wr)}, AvgPnL=$${fmt(stats.avgPnl, 2)}`);
      if (confStats.n > 0) {
        console.log(`      Confirms setup dir: N=${confStats.n}, WR=${pct(confStats.wr)}, AvgPnL=$${fmt(confStats.avgPnl, 2)}`);
      }
      if (oppStats.n > 0) {
        console.log(`      Opposes setup dir:  N=${oppStats.n}, WR=${pct(oppStats.wr)}, AvgPnL=$${fmt(oppStats.avgPnl, 2)}`);
      }
    }
    console.log();
  }

  // ──────────────────────────────────────────────────────────────────────
  // 11. CONFIRMS vs OPPOSES: Statistical Significance
  // ──────────────────────────────────────────────────────────────────────
  console.log('='.repeat(110));
  console.log('  SECTION 5: STATISTICAL SIGNIFICANCE (Z-TEST)');
  console.log('  Two-proportion Z-test: Confirms WR vs Opposes WR');
  console.log('='.repeat(110));
  console.log();

  const sigHdr = padR('Setup', 30)
    + padL('Conf WR', 10) + padL('N', 5)
    + padL('Opp WR', 10) + padL('N', 5)
    + padL('Z-score', 10) + padL('p-value', 10) + padL('Sig?', 8);
  console.log(sigHdr);
  console.log('-'.repeat(sigHdr.length));

  for (const { st, byCat } of setupSummaries) {
    const conf = byCat['DELTA_CONFIRMS'];
    const opp = byCat['DELTA_OPPOSES'];
    if (conf.n < 5 || opp.n < 5) {
      console.log(padR(st, 30) + '  Insufficient samples for z-test');
      continue;
    }

    // Two-proportion z-test
    const p1 = conf.wr;
    const p2 = opp.wr;
    const n1 = conf.n;
    const n2 = opp.n;
    const pPool = (conf.wins + opp.wins) / (n1 + n2);
    const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
    const z = se > 0 ? (p1 - p2) / se : 0;
    // Approximate p-value from z using normal CDF approximation
    const pVal = 2 * (1 - normalCDF(Math.abs(z)));
    const sig = pVal < 0.05 ? 'YES *' : pVal < 0.10 ? 'MARGINAL' : 'NO';

    const row = padR(st, 30)
      + padL(pct(p1), 10) + padL(n1, 5)
      + padL(pct(p2), 10) + padL(n2, 5)
      + padL(fmt(z, 3), 10) + padL(fmt(pVal, 4), 10) + padL(sig, 8);
    console.log(row);
  }

  // ──────────────────────────────────────────────────────────────────────
  // 12. PRACTICAL RECOMMENDATIONS
  // ──────────────────────────────────────────────────────────────────────
  console.log();
  console.log('='.repeat(110));
  console.log('  SECTION 6: PRACTICAL RECOMMENDATIONS');
  console.log('='.repeat(110));
  console.log();

  for (const { st, baseline, byCat, confirmLift } of setupSummaries) {
    const conf = byCat['DELTA_CONFIRMS'];
    const opp = byCat['DELTA_OPPOSES'];
    const neut = byCat['DELTA_NEUTRAL'];
    const divConf = byCat['DIVERGENCE_CONFIRMS'];

    let recommendation = 'IGNORED';
    let reasoning = '';

    // Calculate lift metrics
    const confLift = conf.n >= 5 ? (conf.wr - baseline.wr) * 100 : null;
    const oppDrop = opp.n >= 5 ? (baseline.wr - opp.wr) * 100 : null;
    const confPnlLift = conf.n >= 5 ? conf.avgPnl - baseline.avgPnl : null;

    // Decision logic
    if (confLift != null && oppDrop != null) {
      if (confLift >= 10 && oppDrop >= 10) {
        recommendation = 'GATE';
        reasoning = `+${fmt(confLift, 1)}pp when confirms, -${fmt(oppDrop, 1)}pp when opposes. Strong differentiation — only take when delta confirms.`;
      } else if (confLift >= 5 || oppDrop >= 5) {
        recommendation = 'SIZER';
        reasoning = `Moderate edge: ${confLift != null ? (confLift >= 0 ? '+' : '') + fmt(confLift, 1) + 'pp confirm lift' : 'n/a'}, ${oppDrop != null ? fmt(oppDrop, 1) + 'pp oppose drop' : 'n/a'}. Full size on confirm, half on neutral, skip on oppose.`;
      } else if (Math.abs(confLift) < 5 && Math.abs(oppDrop) < 5) {
        recommendation = 'IGNORED';
        reasoning = `Delta state shows <5pp difference in either direction. Setup mechanics matter more than delta here.`;
      } else {
        recommendation = 'SIZER';
        reasoning = `Mixed signal: confirm lift ${confLift != null ? fmt(confLift, 1) : 'n/a'}pp, oppose drop ${oppDrop != null ? fmt(oppDrop, 1) : 'n/a'}pp. Use as sizing input.`;
      }
    } else {
      recommendation = 'IGNORED';
      reasoning = 'Insufficient samples in confirm/oppose buckets for reliable assessment.';
    }

    // Check if divergence adds extra edge
    let divNote = '';
    if (divConf.n >= 3) {
      const divLift = (divConf.wr - baseline.wr) * 100;
      if (divLift >= 10) {
        divNote = ` BONUS: Divergence confirmation adds +${fmt(divLift, 1)}pp (N=${divConf.n}).`;
      } else if (divLift >= 5) {
        divNote = ` Note: Divergence confirmation suggests +${fmt(divLift, 1)}pp edge (N=${divConf.n}, needs more data).`;
      }
    }

    console.log(`  ${padR(st, 30)} => ${recommendation}`);
    console.log(`    ${reasoning}${divNote}`);
    console.log(`    Base: ${pct(baseline.wr)} (N=${baseline.n}) | Confirms: ${conf.n >= 3 ? pct(conf.wr) : 'n<3'} (N=${conf.n}) | Opposes: ${opp.n >= 3 ? pct(opp.wr) : 'n<3'} (N=${opp.n})`);
    console.log();
  }

  // ──────────────────────────────────────────────────────────────────────
  // 13. AGGREGATE SUMMARY
  // ──────────────────────────────────────────────────────────────────────
  console.log('='.repeat(110));
  console.log('  SECTION 7: AGGREGATE PORTFOLIO-LEVEL IMPACT');
  console.log('='.repeat(110));
  console.log();

  // All fires combined
  const allBaseline = computeStats(results);
  const allConf = computeStats(results.filter(r => r.deltaCategory === 'DELTA_CONFIRMS'));
  const allOpp = computeStats(results.filter(r => r.deltaCategory === 'DELTA_OPPOSES'));
  const allNeut = computeStats(results.filter(r => r.deltaCategory === 'DELTA_NEUTRAL'));
  const allDiv = computeStats(results.filter(r => r.deltaCategory === 'DIVERGENCE_CONFIRMS'));

  console.log(`  All setups combined (N=${allBaseline.n}):`);
  console.log(`    Baseline:             WR=${pct(allBaseline.wr)}, AvgPnL=$${fmt(allBaseline.avgPnl, 2)}, TotalPnL=$${fmt(allBaseline.totalPnl, 2)}`);
  console.log(`    Delta Confirms:       WR=${pct(allConf.wr)}, AvgPnL=$${fmt(allConf.avgPnl, 2)}, N=${allConf.n} (${pct(allConf.n / allBaseline.n)} of fires)`);
  console.log(`    Delta Neutral:        WR=${pct(allNeut.wr)}, AvgPnL=$${fmt(allNeut.avgPnl, 2)}, N=${allNeut.n} (${pct(allNeut.n / allBaseline.n)} of fires)`);
  console.log(`    Delta Opposes:        WR=${pct(allOpp.wr)}, AvgPnL=$${fmt(allOpp.avgPnl, 2)}, N=${allOpp.n} (${pct(allOpp.n / allBaseline.n)} of fires)`);
  console.log(`    Div. Confirms:        WR=${pct(allDiv.wr)}, AvgPnL=$${fmt(allDiv.avgPnl, 2)}, N=${allDiv.n} (${pct(allDiv.n / allBaseline.n)} of fires)`);
  console.log();

  const portLift = (allConf.wr - allBaseline.wr) * 100;
  const portPnlLift = allConf.avgPnl - allBaseline.avgPnl;
  console.log(`  Portfolio-level delta confirmation lift: ${portLift >= 0 ? '+' : ''}${fmt(portLift, 1)}pp WR, ${portPnlLift >= 0 ? '+' : ''}$${fmt(portPnlLift, 2)}/trade`);

  // If only taking confirms, what's the trade reduction?
  const tradeReduction = ((allBaseline.n - allConf.n) / allBaseline.n) * 100;
  console.log(`  Trade count reduction if GATE: ${fmt(tradeReduction, 1)}% fewer trades (${allConf.n} of ${allBaseline.n})`);

  // Net PnL comparison: all trades vs confirms-only
  console.log(`  Total PnL all trades: $${fmt(allBaseline.totalPnl, 2)}`);
  console.log(`  Total PnL confirms-only: $${fmt(allConf.totalPnl, 2)}`);

  // ──────────────────────────────────────────────────────────────────────
  // 14. Delta distribution breakdown
  // ──────────────────────────────────────────────────────────────────────
  console.log();
  console.log('='.repeat(110));
  console.log('  SECTION 8: DELTA STATE DISTRIBUTION');
  console.log('='.repeat(110));
  console.log();

  for (const { st, fires } of setupSummaries) {
    const catCounts = {};
    for (const cat of categories) {
      catCounts[cat] = fires.filter(r => r.deltaCategory === cat).length;
    }
    const total = fires.length;
    const dist = categories.map(c => `${catShort[c]}=${catCounts[c]}(${pct(catCounts[c] / total)})`).join(', ');
    console.log(`  ${padR(st, 30)} ${dist}`);
  }

  console.log();
  console.log('='.repeat(110));
  console.log('  END OF REPORT');
  console.log('='.repeat(110));
}

// Normal CDF approximation (Abramowitz & Stegun)
function normalCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
}).then(() => {
  process.exit(0);
});
