// backtest_confluence.js
// Comprehensive confluence audit: does clustering of key levels improve
// fade WR, tighten MAE, increase MFE compared to single-level fades?
//
// Tests 20+ levels per day, confluence tiers (SINGLE/DOUBLE/TRIPLE+),
// specific level pairs, AM/PM, first-touch vs retest, delta exhaustion.

import { query } from '../server/db.js';
import * as ss from 'simple-statistics';

const PNL_PER_POINT = 2;   // NQ micro: $2/pt
const COMMISSION    = 1;    // $1 round-trip
const DLL           = 400;  // daily loss limit
const WINDOW_DAYS   = 180;
const LOOK_FORWARD  = 30;   // bars to evaluate after touch
const FADE_TARGETS  = [10, 20, 30, 40];
const SCALP_TARGETS = [15, 20, 25, 30];
const SCALP_STOPS   = [20, 30, 40, 50];
const FADE_STOP     = 90;

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
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

function fmt(v, decimals = 1) {
  return typeof v === 'number' ? v.toFixed(decimals) : String(v);
}

function proportionZTest(a, b) {
  if (a.n === 0 || b.n === 0) return { z: 0, p: 1 };
  const p1 = a.wins / a.n, p2 = b.wins / b.n;
  const pPool = (a.wins + b.wins) / (a.n + b.n);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.n + 1 / b.n));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  const p = 2 * (1 - ss.cumulativeStdNormalProbability(Math.abs(z)));
  return { z, p };
}

// ─────────────────────────────────────────────────────────────────
// Data loading
// ─────────────────────────────────────────────────────────────────

async function getTradingDays() {
  // Get the last WINDOW_DAYS trading days that have all 3 data sources
  const r = await query(`
    SELECT d.trade_date::text as trade_date
    FROM developing_value_log d
    JOIN acd_daily_log a ON a.trade_date = d.trade_date
    WHERE d.trade_date <= CURRENT_DATE
      AND EXISTS (
        SELECT 1 FROM price_bars_primary p
        WHERE p.ts::date = d.trade_date
          AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) BETWEEN 570 AND 959
      )
    GROUP BY d.trade_date
    ORDER BY d.trade_date DESC
    LIMIT $1
  `, [WINDOW_DAYS]);
  return r.rows.map(r => r.trade_date).sort();
}

async function getPriorDayData(tradeDate) {
  const r = await query(`
    SELECT
      poc::float, vah::float, val::float,
      session_high::float as pd_high, session_low::float as pd_low,
      session_close::float as pd_close
    FROM developing_value_log
    WHERE trade_date < $1
    ORDER BY trade_date DESC LIMIT 1
  `, [tradeDate]);
  return r.rows[0] || null;
}

async function getACDData(tradeDate) {
  const r = await query(`
    SELECT or_high::float, or_low::float
    FROM acd_daily_log
    WHERE trade_date = $1
  `, [tradeDate]);
  return r.rows[0] || null;
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

async function getOvernightHighLow(tradeDate) {
  // Overnight = prior day 18:00 through current day 09:29
  const r = await query(`
    SELECT MAX(high::float) as on_high, MIN(low::float) as on_low
    FROM price_bars_primary
    WHERE (
      (ts::date = ($1::date - interval '1 day')::date AND EXTRACT(hour FROM ts) >= 18)
      OR
      (ts::date = $1::date AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 570)
    )
  `, [tradeDate]);
  return r.rows[0] || null;
}

async function getPriorWeekHighLow(tradeDate) {
  // Prior week = the calendar week before the week containing tradeDate
  // Get all RTH bars from the prior Monday through Friday
  const r = await query(`
    SELECT MAX(high::float) as pw_high, MIN(low::float) as pw_low
    FROM price_bars_primary
    WHERE ts::date >= ($1::date - (EXTRACT(DOW FROM $1::date)::int + 6) * interval '1 day')::date
      AND ts::date <  ($1::date - (EXTRACT(DOW FROM $1::date)::int - 1) * interval '1 day')::date
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
  `, [tradeDate]);
  return r.rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────
// Floor pivots from prior day H/L/C
// ─────────────────────────────────────────────────────────────────
function floorPivots(h, l, c) {
  const pivot = (h + l + c) / 3;
  return {
    FLOOR_PIVOT: pivot,
    FLOOR_R1: 2 * pivot - l,
    FLOOR_R2: pivot + (h - l),
    FLOOR_S1: 2 * pivot - h,
    FLOOR_S2: pivot - (h - l),
  };
}

// ─────────────────────────────────────────────────────────────────
// Developing POC from volume profile (mode of price buckets)
// ─────────────────────────────────────────────────────────────────
function computeDevelopingPOC(bars, upToIdx) {
  // Build volume profile from bars[0..upToIdx] using 1-point buckets
  const profile = new Map();
  for (let i = 0; i <= upToIdx; i++) {
    const b = bars[i];
    // Distribute volume across the bar's range
    const lo = Math.floor(b.low);
    const hi = Math.ceil(b.high);
    const range = hi - lo || 1;
    const volPerLevel = b.volume / range;
    for (let p = lo; p <= hi; p++) {
      profile.set(p, (profile.get(p) || 0) + volPerLevel);
    }
  }
  // Find the price with maximum volume
  let maxVol = 0, poc = 0;
  for (const [price, vol] of profile) {
    if (vol > maxVol) { maxVol = vol; poc = price; }
  }
  return poc;
}

// ─────────────────────────────────────────────────────────────────
// Developing VWAP
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// Main processing
// ─────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== CONFLUENCE AUDIT ===');
  console.log(`Window: ${WINDOW_DAYS} trading days, look-forward: ${LOOK_FORWARD} bars`);
  console.log(`PNL/pt: $${PNL_PER_POINT}, Commission: $${COMMISSION}, DLL: $${DLL}\n`);

  const tradingDays = await getTradingDays();
  console.log(`Found ${tradingDays.length} trading days with complete data\n`);

  // Collect all touch events across all days
  const allTouches = [];  // { date, barIdx, price, direction, confluenceCount, nearbyLevels, levelName, isFirstTouch, isAM, hasDeltaExhaustion, mae, mfe }

  let skippedDays = 0;

  for (let di = 0; di < tradingDays.length; di++) {
    const date = tradingDays[di];
    if (di % 30 === 0) console.log(`Processing day ${di + 1}/${tradingDays.length}: ${date}`);

    // Load all data for this day
    const [priorDay, acdData, bars, overnight, priorWeek] = await Promise.all([
      getPriorDayData(date),
      getACDData(date),
      getRTHBars(date),
      getOvernightHighLow(date),
      getPriorWeekHighLow(date),
    ]);

    if (!priorDay || !acdData || bars.length < 60) {
      skippedDays++;
      continue;
    }

    // ── Build static levels (known at open) ──
    const staticLevels = {};

    // Prior day levels
    staticLevels.PD_POC  = priorDay.poc;
    staticLevels.PD_VAH  = priorDay.vah;
    staticLevels.PD_VAL  = priorDay.val;
    staticLevels.PD_HIGH = priorDay.pd_high;
    staticLevels.PD_LOW  = priorDay.pd_low;
    staticLevels.PD_MID  = (priorDay.pd_high + priorDay.pd_low) / 2;

    // Floor pivots
    const pivots = floorPivots(priorDay.pd_high, priorDay.pd_low, priorDay.pd_close);
    Object.assign(staticLevels, pivots);

    // Overnight
    if (overnight && overnight.on_high && overnight.on_low) {
      staticLevels.ON_HIGH = overnight.on_high;
      staticLevels.ON_LOW  = overnight.on_low;
    }

    // Prior week
    if (priorWeek && priorWeek.pw_high && priorWeek.pw_low) {
      staticLevels.PW_HIGH = priorWeek.pw_high;
      staticLevels.PW_LOW  = priorWeek.pw_low;
    }

    // ── Compute IB and OR levels (from bars) ──
    // OR = first 30 min (9:30-9:59), OR from acd_daily_log
    staticLevels.OR_HIGH = acdData.or_high;
    staticLevels.OR_LOW  = acdData.or_low;
    staticLevels.OR_MID  = (acdData.or_high + acdData.or_low) / 2;

    // IB = first 60 min (9:30-10:29) = bars with tod 570..629
    let ibHigh = -Infinity, ibLow = Infinity;
    let ibBarCount = 0;
    for (const b of bars) {
      if (b.tod >= 570 && b.tod <= 629) {
        ibHigh = Math.max(ibHigh, b.high);
        ibLow  = Math.min(ibLow, b.low);
        ibBarCount++;
      }
    }
    if (ibBarCount > 0) {
      staticLevels.IB_HIGH = ibHigh;
      staticLevels.IB_LOW  = ibLow;
      staticLevels.IB_MID  = (ibHigh + ibLow) / 2;
    }

    // ── Process each RTH bar ──
    // Track which levels have been touched (for first-touch detection)
    const touchedLevels = new Set();
    // Track cumulative delta for exhaustion
    let cumDelta = 0;
    // Track developing range
    let devHigh = -Infinity, devLow = Infinity;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      devHigh = Math.max(devHigh, bar.high);
      devLow  = Math.min(devLow, bar.low);
      const devRange = devHigh - devLow;

      // Delta tracking
      const barDelta = (bar.ask_volume || 0) - (bar.bid_volume || 0);
      cumDelta += barDelta;

      // Skip first 60 min for IB levels (they're not defined yet)
      // But we can still test PD/OR/ON/PW levels in the first 60 min
      const pastIB = bar.tod >= 630; // after 10:30

      // Dynamic proximity = 5% of developing range (min 5pt, max 30pt)
      const proximity = Math.max(5, Math.min(30, devRange * 0.05));

      // Build the set of levels available at this bar
      const availableLevels = { ...staticLevels };
      // IB levels only available after IB close
      if (!pastIB) {
        delete availableLevels.IB_HIGH;
        delete availableLevels.IB_LOW;
        delete availableLevels.IB_MID;
      }

      // Add developing levels (computed up to current bar)
      availableLevels.VWAP = computeVWAP(bars, i);
      // Only compute developing POC every 10 bars (expensive)
      if (i % 10 === 0 || i === bars.length - 1) {
        availableLevels.DEV_POC = computeDevelopingPOC(bars, i);
      }

      // ── Check which levels the bar touches ──
      // A "touch" = bar low/high reaches within proximity of a level
      const nearbyLevelsHigh = []; // levels near bar high (potential short fade)
      const nearbyLevelsLow  = []; // levels near bar low (potential long fade)

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

      // ── Process high-side touches (short fades) ──
      if (nearbyLevelsHigh.length > 0 && i + LOOK_FORWARD < bars.length) {
        const confluenceCount = nearbyLevelsHigh.length;
        const primaryLevel = nearbyLevelsHigh.sort((a, b) => a.dist - b.dist)[0];
        const entryPrice = bar.close; // enter at close of touch bar

        // Compute MFE/MAE for short fade
        let mfe = 0, mae = 0;
        for (let j = i + 1; j <= Math.min(i + LOOK_FORWARD, bars.length - 1); j++) {
          const pnl_high = entryPrice - bars[j].low;   // best case for short
          const pnl_low  = entryPrice - bars[j].high;  // worst case for short (adverse)
          mfe = Math.max(mfe, pnl_high);
          mae = Math.min(mae, pnl_low);  // mae is negative for adverse
        }
        mae = Math.abs(mae); // convert to positive points

        // Check delta exhaustion: cumDelta > +500 at a high = exhausted buyers
        const hasDeltaExhaustion = cumDelta > 500;

        // First touch of primary level?
        const touchKey = `HIGH_${primaryLevel.name}`;
        const isFirstTouch = !touchedLevels.has(touchKey);
        touchedLevels.add(touchKey);

        // AM (before 12:00 = tod 720) or PM?
        const isAM = bar.tod < 720;

        allTouches.push({
          date,
          barIdx: i,
          tod: bar.tod,
          price: entryPrice,
          direction: 'SHORT',
          confluenceCount,
          nearbyLevelNames: nearbyLevelsHigh.map(l => l.name).sort(),
          primaryLevel: primaryLevel.name,
          isFirstTouch,
          isAM,
          hasDeltaExhaustion,
          mae,
          mfe,
          proximity,
        });
      }

      // ── Process low-side touches (long fades) ──
      if (nearbyLevelsLow.length > 0 && i + LOOK_FORWARD < bars.length) {
        const confluenceCount = nearbyLevelsLow.length;
        const primaryLevel = nearbyLevelsLow.sort((a, b) => a.dist - b.dist)[0];
        const entryPrice = bar.close;

        // Compute MFE/MAE for long fade
        let mfe = 0, mae = 0;
        for (let j = i + 1; j <= Math.min(i + LOOK_FORWARD, bars.length - 1); j++) {
          const pnl_high = bars[j].high - entryPrice;  // best case for long
          const pnl_low  = bars[j].low - entryPrice;   // worst case for long
          mfe = Math.max(mfe, pnl_high);
          mae = Math.min(mae, pnl_low);
        }
        mae = Math.abs(mae);

        // Delta exhaustion for longs: cumDelta < -500
        const hasDeltaExhaustion = cumDelta < -500;

        const touchKey = `LOW_${primaryLevel.name}`;
        const isFirstTouch = !touchedLevels.has(touchKey);
        touchedLevels.add(touchKey);

        const isAM = bar.tod < 720;

        allTouches.push({
          date,
          barIdx: i,
          tod: bar.tod,
          price: entryPrice,
          direction: 'LONG',
          confluenceCount,
          nearbyLevelNames: nearbyLevelsLow.map(l => l.name).sort(),
          primaryLevel: primaryLevel.name,
          isFirstTouch,
          isAM,
          hasDeltaExhaustion,
          mae,
          mfe,
          proximity,
        });
      }
    }
  }

  console.log(`\nSkipped ${skippedDays} days (missing data)`);
  console.log(`Total touch events: ${allTouches.length}\n`);

  // ─── Deduplicate: keep only 1 touch per level-cluster per 5 bars ───
  // Without this, a bar sitting on a level generates a touch every bar
  const deduped = [];
  const recentTouches = new Map(); // key -> last barIdx
  for (const t of allTouches) {
    const key = `${t.date}_${t.direction}_${t.nearbyLevelNames.join('+')}`;
    const last = recentTouches.get(key);
    if (last !== undefined && t.barIdx - last < 5) continue;
    recentTouches.set(key, t.barIdx);
    deduped.push(t);
  }
  console.log(`After dedup (5-bar spacing): ${deduped.length} touches\n`);

  // ═══════════════════════════════════════════════════════════════
  // ANALYSIS 1: Confluence Tiers
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('ANALYSIS 1: CONFLUENCE TIERS');
  console.log('═══════════════════════════════════════════════════════════\n');

  const tiers = {
    SINGLE:    deduped.filter(t => t.confluenceCount === 1),
    DOUBLE:    deduped.filter(t => t.confluenceCount === 2),
    TRIPLE:    deduped.filter(t => t.confluenceCount === 3),
    QUAD_PLUS: deduped.filter(t => t.confluenceCount >= 4),
  };

  for (const [tierName, touches] of Object.entries(tiers)) {
    if (touches.length === 0) { console.log(`${tierName}: 0 events\n`); continue; }

    const maes = touches.map(t => t.mae);
    const mfes = touches.map(t => t.mfe);
    const maeStats = pct(maes);
    const mfeStats = pct(mfes);

    // Fade WR at various targets (with 90pt stop)
    const fadeResults = {};
    for (const target of FADE_TARGETS) {
      const wins = touches.filter(t => t.mfe >= target && t.mae < FADE_STOP).length;
      fadeResults[target] = { wins, n: touches.length, wr: wins / touches.length };
    }

    // Optimal scalp: test all target/stop combos
    let bestScalpEV = -Infinity, bestScalp = {};
    for (const target of SCALP_TARGETS) {
      for (const stop of SCALP_STOPS) {
        const wins = touches.filter(t => t.mfe >= target && t.mae < stop).length;
        const losses = touches.filter(t => t.mae >= stop).length;
        const noTrigger = touches.length - wins - losses;
        const ev = (wins * (target * PNL_PER_POINT - COMMISSION) - losses * (stop * PNL_PER_POINT + COMMISSION)) / touches.length;
        if (ev > bestScalpEV) {
          bestScalpEV = ev;
          bestScalp = { target, stop, wins, losses, ev, wr: wins / touches.length };
        }
      }
    }

    // 90pt stop fade EV (using 30pt target as default)
    const fade90Wins = touches.filter(t => t.mfe >= 30 && t.mae < 90).length;
    const fade90Losses = touches.filter(t => t.mae >= 90).length;
    const fade90EV = (fade90Wins * (30 * PNL_PER_POINT - COMMISSION) - fade90Losses * (90 * PNL_PER_POINT + COMMISSION)) / touches.length;

    // DLL compatibility: how many consecutive losses to hit DLL?
    const maxLossPerTrade = bestScalp.stop ? bestScalp.stop * PNL_PER_POINT + COMMISSION : 91;
    const dllTrades = Math.floor(DLL / maxLossPerTrade);

    console.log(`── ${tierName} CONFLUENCE (N=${touches.length}) ──`);
    console.log(`  Fade WR (90pt stop):`);
    for (const [target, r] of Object.entries(fadeResults)) {
      console.log(`    ${target}pt target: ${(r.wr * 100).toFixed(1)}% (${r.wins}/${r.n})`);
    }
    console.log(`  MAE: P25=${fmt(maeStats.p25)} P50=${fmt(maeStats.p50)} P75=${fmt(maeStats.p75)} P90=${fmt(maeStats.p90)} Mean=${fmt(maeStats.mean)}`);
    console.log(`  MFE: P25=${fmt(mfeStats.p25)} P50=${fmt(mfeStats.p50)} P75=${fmt(mfeStats.p75)} P90=${fmt(mfeStats.p90)} Mean=${fmt(mfeStats.mean)}`);
    console.log(`  Optimal scalp: ${bestScalp.target}pt target / ${bestScalp.stop}pt stop → ${(bestScalp.wr * 100).toFixed(1)}% WR, $${fmt(bestScalp.ev, 2)} EV`);
    console.log(`  Fade 90pt stop (30pt target): ${(fade90Wins / touches.length * 100).toFixed(1)}% WR, $${fmt(fade90EV, 2)} EV`);
    console.log(`  DLL compat (${bestScalp.stop}pt stop): ${dllTrades} consecutive losses before DLL`);
    console.log();
  }

  // ── Statistical comparison: SINGLE vs DOUBLE, SINGLE vs TRIPLE ──
  console.log('── Statistical Tests ──');
  for (const target of [20, 30]) {
    const singleWins = tiers.SINGLE.filter(t => t.mfe >= target && t.mae < FADE_STOP).length;
    const doubleWins = tiers.DOUBLE.filter(t => t.mfe >= target && t.mae < FADE_STOP).length;
    const tripleWins = tiers.TRIPLE.filter(t => t.mfe >= target && t.mae < FADE_STOP).length;

    const sA = { n: tiers.SINGLE.length, wins: singleWins };
    const dA = { n: tiers.DOUBLE.length, wins: doubleWins };
    const tA = { n: tiers.TRIPLE.length, wins: tripleWins };

    if (sA.n && dA.n) {
      const { z, p } = proportionZTest(dA, sA);
      console.log(`  ${target}pt target: DOUBLE vs SINGLE → z=${fmt(z, 3)}, p=${fmt(p, 4)} (${dA.n > 0 ? ((dA.wins/dA.n - sA.wins/sA.n)*100).toFixed(1) : 0}% delta)`);
    }
    if (sA.n && tA.n) {
      const { z, p } = proportionZTest(tA, sA);
      console.log(`  ${target}pt target: TRIPLE vs SINGLE → z=${fmt(z, 3)}, p=${fmt(p, 4)} (${tA.n > 0 ? ((tA.wins/tA.n - sA.wins/sA.n)*100).toFixed(1) : 0}% delta)`);
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // ANALYSIS 2: Does confluence count linearly improve WR?
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('ANALYSIS 2: WR BY EXACT CONFLUENCE COUNT (linear test)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const maxConf = Math.max(...deduped.map(t => t.confluenceCount));
  console.log(`  Count | N      | 20pt WR  | 30pt WR  | MAE P50  | MFE P50  | EV(30/90)`);
  console.log(`  ------+--------+----------+----------+----------+----------+----------`);
  for (let c = 1; c <= Math.min(maxConf, 7); c++) {
    const group = deduped.filter(t => t.confluenceCount === c);
    if (group.length === 0) continue;
    const wr20 = group.filter(t => t.mfe >= 20 && t.mae < FADE_STOP).length / group.length;
    const wr30 = group.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / group.length;
    const maeP50 = pct(group.map(t => t.mae)).p50;
    const mfeP50 = pct(group.map(t => t.mfe)).p50;
    const w = group.filter(t => t.mfe >= 30 && t.mae < 90).length;
    const l = group.filter(t => t.mae >= 90).length;
    const ev = (w * (30 * PNL_PER_POINT - COMMISSION) - l * (90 * PNL_PER_POINT + COMMISSION)) / group.length;
    console.log(`  ${String(c).padStart(5)} | ${String(group.length).padStart(6)} | ${(wr20*100).toFixed(1).padStart(7)}% | ${(wr30*100).toFixed(1).padStart(7)}% | ${fmt(maeP50).padStart(8)} | ${fmt(mfeP50).padStart(8)} | $${fmt(ev, 2).padStart(7)}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // ANALYSIS 3: Level PAIRS
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('ANALYSIS 3: TOP LEVEL PAIRS BY EV');
  console.log('═══════════════════════════════════════════════════════════\n');

  // For each touch with >=2 levels, extract all level pairs
  const pairStats = new Map(); // "LEVEL_A+LEVEL_B" -> { touches: [...] }

  for (const t of deduped) {
    if (t.nearbyLevelNames.length >= 2) {
      const names = t.nearbyLevelNames;
      for (let a = 0; a < names.length; a++) {
        for (let b = a + 1; b < names.length; b++) {
          const pairKey = `${names[a]}+${names[b]}`;
          if (!pairStats.has(pairKey)) pairStats.set(pairKey, { touches: [] });
          pairStats.get(pairKey).touches.push(t);
        }
      }
    }
  }

  // Filter pairs with N >= 10
  const qualifiedPairs = [];
  for (const [pair, data] of pairStats) {
    if (data.touches.length < 10) continue;
    const t = data.touches;
    const wr30 = t.filter(x => x.mfe >= 30 && x.mae < FADE_STOP).length / t.length;
    const w = t.filter(x => x.mfe >= 30 && x.mae < 90).length;
    const l = t.filter(x => x.mae >= 90).length;
    const ev = (w * (30 * PNL_PER_POINT - COMMISSION) - l * (90 * PNL_PER_POINT + COMMISSION)) / t.length;
    const maeP50 = pct(t.map(x => x.mae)).p50;
    const mfeP50 = pct(t.map(x => x.mfe)).p50;
    qualifiedPairs.push({ pair, n: t.length, wr30, ev, maeP50, mfeP50, touches: t });
  }

  // Sort by EV descending
  qualifiedPairs.sort((a, b) => b.ev - a.ev);
  console.log(`  Qualified pairs (N>=10): ${qualifiedPairs.length}\n`);
  console.log(`  Rank | Pair                                    | N    | 30pt WR | MAE P50 | MFE P50 | EV(30/90)`);
  console.log(`  -----+-----------------------------------------+------+---------+---------+---------+----------`);
  for (let i = 0; i < Math.min(qualifiedPairs.length, 15); i++) {
    const p = qualifiedPairs[i];
    console.log(`  ${String(i + 1).padStart(4)} | ${p.pair.padEnd(39)} | ${String(p.n).padStart(4)} | ${(p.wr30*100).toFixed(1).padStart(6)}% | ${fmt(p.maeP50).padStart(7)} | ${fmt(p.mfeP50).padStart(7)} | $${fmt(p.ev, 2).padStart(7)}`);
  }

  // Compare pair WR vs single-level WR for the same levels
  console.log(`\n── Pair vs Single-Level Comparison ──`);
  for (let i = 0; i < Math.min(qualifiedPairs.length, 10); i++) {
    const p = qualifiedPairs[i];
    const [levelA, levelB] = p.pair.split('+');
    // Find single-level touches of either level
    const singleA = deduped.filter(t => t.confluenceCount === 1 && t.primaryLevel === levelA);
    const singleB = deduped.filter(t => t.confluenceCount === 1 && t.primaryLevel === levelB);
    const singleAll = [...singleA, ...singleB];
    if (singleAll.length >= 5) {
      const singleWR = singleAll.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / singleAll.length;
      const singleMAE = pct(singleAll.map(t => t.mae)).p50;
      console.log(`  ${p.pair}: Pair WR=${(p.wr30*100).toFixed(1)}% (N=${p.n}) vs Single WR=${(singleWR*100).toFixed(1)}% (N=${singleAll.length}) | Pair MAE=${fmt(p.maeP50)} vs Single MAE=${fmt(singleMAE)}`);
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // ANALYSIS 4: First Touch vs Retest
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('ANALYSIS 4: FIRST TOUCH vs RETEST');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const tier of ['SINGLE', 'DOUBLE', 'TRIPLE']) {
    const group = tier === 'SINGLE' ? tiers.SINGLE : tier === 'DOUBLE' ? tiers.DOUBLE : tiers.TRIPLE;
    if (group.length < 20) continue;
    const first = group.filter(t => t.isFirstTouch);
    const retest = group.filter(t => !t.isFirstTouch);

    const firstWR = first.length > 0 ? first.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / first.length : 0;
    const retestWR = retest.length > 0 ? retest.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / retest.length : 0;

    console.log(`  ${tier}:`);
    console.log(`    First touch: ${(firstWR*100).toFixed(1)}% WR (N=${first.length}), MAE P50=${fmt(pct(first.map(t=>t.mae)).p50)}`);
    console.log(`    Retest:      ${(retestWR*100).toFixed(1)}% WR (N=${retest.length}), MAE P50=${fmt(pct(retest.map(t=>t.mae)).p50)}`);
    if (first.length >= 10 && retest.length >= 10) {
      const { z, p } = proportionZTest(
        { n: first.length, wins: first.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length },
        { n: retest.length, wins: retest.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length }
      );
      console.log(`    z=${fmt(z,3)}, p=${fmt(p,4)}`);
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // ANALYSIS 5: AM vs PM
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('ANALYSIS 5: AM vs PM');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const tier of ['SINGLE', 'DOUBLE', 'TRIPLE']) {
    const group = tier === 'SINGLE' ? tiers.SINGLE : tier === 'DOUBLE' ? tiers.DOUBLE : tiers.TRIPLE;
    if (group.length < 20) continue;
    const am = group.filter(t => t.isAM);
    const pm = group.filter(t => !t.isAM);

    const amWR = am.length > 0 ? am.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / am.length : 0;
    const pmWR = pm.length > 0 ? pm.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / pm.length : 0;

    console.log(`  ${tier}:`);
    console.log(`    AM: ${(amWR*100).toFixed(1)}% WR (N=${am.length}), MAE P50=${fmt(pct(am.map(t=>t.mae)).p50)}, MFE P50=${fmt(pct(am.map(t=>t.mfe)).p50)}`);
    console.log(`    PM: ${(pmWR*100).toFixed(1)}% WR (N=${pm.length}), MAE P50=${fmt(pct(pm.map(t=>t.mae)).p50)}, MFE P50=${fmt(pct(pm.map(t=>t.mfe)).p50)}`);
    if (am.length >= 10 && pm.length >= 10) {
      const { z, p } = proportionZTest(
        { n: am.length, wins: am.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length },
        { n: pm.length, wins: pm.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length }
      );
      console.log(`    z=${fmt(z,3)}, p=${fmt(p,4)}`);
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // ANALYSIS 6: Delta Exhaustion + Confluence
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('ANALYSIS 6: DELTA EXHAUSTION + CONFLUENCE (the triple)');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const tier of ['ALL', 'SINGLE', 'DOUBLE', 'TRIPLE']) {
    const group = tier === 'ALL' ? deduped :
                  tier === 'SINGLE' ? tiers.SINGLE :
                  tier === 'DOUBLE' ? tiers.DOUBLE : tiers.TRIPLE;
    if (group.length < 20) continue;
    const withExh  = group.filter(t => t.hasDeltaExhaustion);
    const noExh    = group.filter(t => !t.hasDeltaExhaustion);

    const exhWR = withExh.length > 0 ? withExh.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / withExh.length : 0;
    const noExhWR = noExh.length > 0 ? noExh.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / noExh.length : 0;

    console.log(`  ${tier} (N=${group.length}):`);
    console.log(`    With delta exhaust: ${(exhWR*100).toFixed(1)}% WR (N=${withExh.length}), MAE P50=${fmt(pct(withExh.map(t=>t.mae)).p50)}`);
    console.log(`    No delta exhaust:   ${(noExhWR*100).toFixed(1)}% WR (N=${noExh.length}), MAE P50=${fmt(pct(noExh.map(t=>t.mae)).p50)}`);
    if (withExh.length >= 10 && noExh.length >= 10) {
      const { z, p } = proportionZTest(
        { n: withExh.length, wins: withExh.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length },
        { n: noExh.length, wins: noExh.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length }
      );
      console.log(`    z=${fmt(z,3)}, p=${fmt(p,4)}`);
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // ANALYSIS 7: Per-Level Performance (single-level baseline)
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('ANALYSIS 7: INDIVIDUAL LEVEL PERFORMANCE (single-level baseline)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const levelGroups = new Map();
  for (const t of deduped.filter(x => x.confluenceCount === 1)) {
    if (!levelGroups.has(t.primaryLevel)) levelGroups.set(t.primaryLevel, []);
    levelGroups.get(t.primaryLevel).push(t);
  }

  const levelResults = [];
  for (const [level, touches] of levelGroups) {
    if (touches.length < 10) continue;
    const wr30 = touches.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / touches.length;
    const w = touches.filter(t => t.mfe >= 30 && t.mae < 90).length;
    const l = touches.filter(t => t.mae >= 90).length;
    const ev = (w * (30 * PNL_PER_POINT - COMMISSION) - l * (90 * PNL_PER_POINT + COMMISSION)) / touches.length;
    const maeP50 = pct(touches.map(t => t.mae)).p50;
    const mfeP50 = pct(touches.map(t => t.mfe)).p50;
    levelResults.push({ level, n: touches.length, wr30, ev, maeP50, mfeP50 });
  }
  levelResults.sort((a, b) => b.ev - a.ev);

  console.log(`  Level            | N    | 30pt WR | MAE P50 | MFE P50 | EV(30/90)`);
  console.log(`  -----------------+------+---------+---------+---------+----------`);
  for (const r of levelResults) {
    console.log(`  ${r.level.padEnd(17)}| ${String(r.n).padStart(4)} | ${(r.wr30*100).toFixed(1).padStart(6)}% | ${fmt(r.maeP50).padStart(7)} | ${fmt(r.mfeP50).padStart(7)} | $${fmt(r.ev, 2).padStart(7)}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY & RECOMMENDATION
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('SUMMARY & RECOMMENDATION');
  console.log('═══════════════════════════════════════════════════════════\n');

  const singleN = tiers.SINGLE.length;
  const doubleN = tiers.DOUBLE.length;
  const tripleN = tiers.TRIPLE.length;
  const quadN   = tiers.QUAD_PLUS.length;

  const sWR = singleN > 0 ? tiers.SINGLE.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / singleN : 0;
  const dWR = doubleN > 0 ? tiers.DOUBLE.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / doubleN : 0;
  const tWR = tripleN > 0 ? tiers.TRIPLE.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / tripleN : 0;
  const qWR = quadN > 0   ? tiers.QUAD_PLUS.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / quadN : 0;

  const sMAE = singleN > 0 ? pct(tiers.SINGLE.map(t => t.mae)).p50 : 0;
  const dMAE = doubleN > 0 ? pct(tiers.DOUBLE.map(t => t.mae)).p50 : 0;
  const tMAE = tripleN > 0 ? pct(tiers.TRIPLE.map(t => t.mae)).p50 : 0;

  const computeEV = (group) => {
    if (group.length === 0) return 0;
    const w = group.filter(t => t.mfe >= 30 && t.mae < 90).length;
    const l = group.filter(t => t.mae >= 90).length;
    return (w * (30 * PNL_PER_POINT - COMMISSION) - l * (90 * PNL_PER_POINT + COMMISSION)) / group.length;
  };

  console.log(`  Single level: ${(sWR*100).toFixed(1)}% WR, ${fmt(sMAE)} pt MAE, $${fmt(computeEV(tiers.SINGLE), 2)} EV (N=${singleN})`);
  console.log(`  Double confluence: ${(dWR*100).toFixed(1)}% WR, ${fmt(dMAE)} pt MAE, $${fmt(computeEV(tiers.DOUBLE), 2)} EV (N=${doubleN})`);
  console.log(`  Triple confluence: ${(tWR*100).toFixed(1)}% WR, ${fmt(tMAE)} pt MAE, $${fmt(computeEV(tiers.TRIPLE), 2)} EV (N=${tripleN})`);
  if (quadN > 0) {
    console.log(`  Quad+ confluence: ${(qWR*100).toFixed(1)}% WR, ${fmt(pct(tiers.QUAD_PLUS.map(t=>t.mae)).p50)} pt MAE, $${fmt(computeEV(tiers.QUAD_PLUS), 2)} EV (N=${quadN})`);
  }
  console.log();

  // Does confluence improve WR?
  const wrImprovement = dWR - sWR;
  const maeImprovement = sMAE - dMAE;
  console.log(`  WR improvement (DOUBLE vs SINGLE): ${wrImprovement > 0 ? '+' : ''}${(wrImprovement*100).toFixed(1)}%`);
  console.log(`  MAE improvement (DOUBLE vs SINGLE): ${maeImprovement > 0 ? '' : '+'}${fmt(maeImprovement)} pt tighter`);
  if (tripleN > 0) {
    const wrImpTriple = tWR - sWR;
    const maeImpTriple = sMAE - tMAE;
    console.log(`  WR improvement (TRIPLE vs SINGLE): ${wrImpTriple > 0 ? '+' : ''}${(wrImpTriple*100).toFixed(1)}%`);
    console.log(`  MAE improvement (TRIPLE vs SINGLE): ${maeImpTriple > 0 ? '' : '+'}${fmt(maeImpTriple)} pt tighter`);
  }
  console.log();

  // Saturation test
  console.log(`  Saturation test (does 4+ levels = better than 3?):`);
  if (quadN >= 10 && tripleN >= 10) {
    const { z, p } = proportionZTest(
      { n: quadN, wins: tiers.QUAD_PLUS.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length },
      { n: tripleN, wins: tiers.TRIPLE.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length }
    );
    console.log(`    QUAD+ vs TRIPLE: z=${fmt(z,3)}, p=${fmt(p,4)} → ${p < 0.05 ? 'SIGNIFICANT' : 'not significant'}`);
  } else {
    console.log(`    Insufficient data (QUAD+: N=${quadN}, TRIPLE: N=${tripleN})`);
  }
  console.log();

  // DLL compatibility
  console.log(`  DLL compatibility ($${DLL}):`);
  for (const [tierName, group] of Object.entries(tiers)) {
    if (group.length === 0) continue;
    // Find optimal stop for this tier
    let bestStop = 90, bestEV = -Infinity;
    for (const stop of [20, 30, 40, 50, 60, 70, 80, 90]) {
      const w = group.filter(t => t.mfe >= 30 && t.mae < stop).length;
      const l = group.filter(t => t.mae >= stop).length;
      const ev = (w * (30 * PNL_PER_POINT - COMMISSION) - l * (stop * PNL_PER_POINT + COMMISSION)) / group.length;
      if (ev > bestEV) { bestEV = ev; bestStop = stop; }
    }
    const maxLoss = bestStop * PNL_PER_POINT + COMMISSION;
    const tradesBeforeDLL = Math.floor(DLL / maxLoss);
    console.log(`    ${tierName}: optimal stop=${bestStop}pt ($${fmt(maxLoss,0)}/loss) → ${tradesBeforeDLL} trades before DLL`);
  }
  console.log();

  // Final recommendation
  console.log(`  ┌─────────────────────────────────────────────────────┐`);
  if (wrImprovement > 0.05) {
    console.log(`  │ RECOMMENDATION: TRADE CONFLUENCE ONLY              │`);
    console.log(`  │ Double confluence adds >${(wrImprovement*100).toFixed(0)}% WR over single.     │`);
    console.log(`  │ Filter for 2+ levels within proximity.            │`);
  } else if (wrImprovement > 0.02) {
    console.log(`  │ RECOMMENDATION: PREFER CONFLUENCE, SINGLE OK      │`);
    console.log(`  │ Confluence adds modest edge but single still +EV. │`);
  } else {
    console.log(`  │ RECOMMENDATION: SINGLE LEVEL SUFFICIENT           │`);
    console.log(`  │ Confluence does not materially improve WR/MAE.    │`);
    console.log(`  │ Trade any qualified level touch.                   │`);
  }
  console.log(`  └─────────────────────────────────────────────────────┘`);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // Store results in performance_audit
  // ═══════════════════════════════════════════════════════════════
  console.log('Storing results in performance_audit...');

  // Delete old CONFLUENCE_AUDIT results
  await query(`DELETE FROM performance_audit WHERE signal_type = 'CONFLUENCE_AUDIT'`);

  for (const [tierName, group] of Object.entries(tiers)) {
    if (group.length === 0) continue;

    const maes = group.map(t => t.mae);
    const mfes = group.map(t => t.mfe);
    const maeS = pct(maes);
    const mfeS = pct(mfes);

    const wr = group.filter(t => t.mfe >= 30 && t.mae < FADE_STOP).length / group.length;
    const w = group.filter(t => t.mfe >= 30 && t.mae < 90).length;
    const l = group.filter(t => t.mae >= 90).length;
    const ev = (w * (30 * PNL_PER_POINT - COMMISSION) - l * (90 * PNL_PER_POINT + COMMISSION)) / group.length;

    // Find optimal scalp
    let bestScalpEV = -Infinity, bestTarget = 30, bestStop = 90;
    for (const target of SCALP_TARGETS) {
      for (const stop of SCALP_STOPS) {
        const sw = group.filter(t => t.mfe >= target && t.mae < stop).length;
        const sl = group.filter(t => t.mae >= stop).length;
        const sev = (sw * (target * PNL_PER_POINT - COMMISSION) - sl * (stop * PNL_PER_POINT + COMMISSION)) / group.length;
        if (sev > bestScalpEV) { bestScalpEV = sev; bestTarget = target; bestStop = stop; }
      }
    }

    const bestWR = group.filter(t => t.mfe >= bestTarget && t.mae < bestStop).length / group.length;

    await query(`
      INSERT INTO performance_audit (
        run_date, window_days, signal_type, signal_name, sample_size,
        win_rate, ev_per_trade, total_pnl,
        avg_mfe, p50_mfe, p75_mfe,
        avg_mae, p50_mae, p75_mae, p90_mae,
        current_stop, current_target,
        optimal_stop, optimal_target, optimal_ev,
        stop_blowthrough_pct,
        recommendation, notes
      ) VALUES (
        CURRENT_DATE, $1, 'CONFLUENCE_AUDIT', $2, $3,
        $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15,
        $16, $17, $18,
        $19,
        $20, $21
      )
    `, [
      WINDOW_DAYS, tierName, group.length,
      wr, ev, ev * group.length,
      mfeS.mean, mfeS.p50, mfeS.p75,
      maeS.mean, maeS.p50, maeS.p75, maeS.p90,
      FADE_STOP, 30,
      bestStop, bestTarget, bestScalpEV,
      l / group.length,
      wrImprovement > 0.05 ? 'TRADE_CONFLUENCE_ONLY' : wrImprovement > 0.02 ? 'PREFER_CONFLUENCE' : 'SINGLE_SUFFICIENT',
      `WR@30pt: ${(wr*100).toFixed(1)}%, MAE P50: ${fmt(maeS.p50)}, MFE P50: ${fmt(mfeS.p50)}, Optimal: ${bestTarget}/${bestStop}`
    ]);
  }

  // Also store top pairs
  for (let i = 0; i < Math.min(qualifiedPairs.length, 10); i++) {
    const p = qualifiedPairs[i];
    const maes = p.touches.map(t => t.mae);
    const mfes = p.touches.map(t => t.mfe);
    const maeS = pct(maes);
    const mfeS = pct(mfes);

    await query(`
      INSERT INTO performance_audit (
        run_date, window_days, signal_type, signal_name, sample_size,
        win_rate, ev_per_trade, total_pnl,
        avg_mfe, p50_mfe, p75_mfe,
        avg_mae, p50_mae, p75_mae, p90_mae,
        current_stop, current_target,
        recommendation, notes
      ) VALUES (
        CURRENT_DATE, $1, 'CONFLUENCE_AUDIT', $2, $3,
        $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15,
        $16, $17
      )
    `, [
      WINDOW_DAYS, `PAIR:${p.pair}`, p.n,
      p.wr30, p.ev, p.ev * p.n,
      mfeS.mean, mfeS.p50, mfeS.p75,
      maeS.mean, maeS.p50, maeS.p75, maeS.p90,
      FADE_STOP, 30,
      `TOP_PAIR_#${i + 1}`,
      `WR: ${(p.wr30*100).toFixed(1)}%, MAE P50: ${fmt(p.maeP50)}, MFE P50: ${fmt(p.mfeP50)}`
    ]);
  }

  console.log('Results stored successfully.');
  process.exit(0);
}

run().catch(err => {
  console.error('Confluence audit failed:', err);
  process.exit(1);
});
