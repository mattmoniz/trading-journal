// backtest_full_system.js
// ═══════════════════════════════════════════════════════════════════════
// DEFINITIVE FULL-SYSTEM BACKTEST: Regime-adaptive level fade system
// Simulates the complete system day-by-day: regime detection, level
// ranking, trade execution with DLL constraints.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

// ── Constants ──
const PNL_PER_POINT = 2;   // NQ micro: $2/pt
const COMMISSION    = 1;    // $1 round-trip
const DLL           = 400;  // daily loss limit
const WINDOW_DAYS   = 180;
const FADE_STOP     = 90;   // 90pt stop
const FADE_TARGET   = 40;   // 40pt target
const PROXIMITY     = 10;   // touch = within 10pt
const MAX_TRADES    = 3;    // DLL constraint
const AM_CUTOFF_TOD = 720;  // noon ET = 12:00 = 720 min

// Regime lookback
const ATR_SHORT     = 5;
const ATR_LONG      = 20;
const NL_PERIOD     = 10;
const ZSCORE_WINDOW = 60;

// ── Helpers ──
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function zscore(val, arr) {
  const s = std(arr);
  return s > 0 ? (val - mean(arr)) / s : 0;
}
function fmt(v, d = 1) { return typeof v === 'number' ? v.toFixed(d) : String(v); }
function pctStr(n, d) { return d > 0 ? (n / d * 100).toFixed(1) + '%' : 'N/A'; }

// ── Floor pivots ──
function floorPivots(h, l, c) {
  const pivot = (h + l + c) / 3;
  return {
    FLOOR_PIVOT: pivot,
    FLOOR_R1: 2 * pivot - l,
    FLOOR_S1: 2 * pivot - h,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DATA LOADING (bulk pre-fetch for performance)
// ═══════════════════════════════════════════════════════════════════════

async function loadAllData() {
  console.log('Loading data...');

  // 1. Get trading days with all 3 data sources
  const daysRes = await query(`
    SELECT d.trade_date::text as trade_date
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
  const allDays = daysRes.rows.map(r => r.trade_date);
  console.log(`  Total trading days with complete data: ${allDays.length}`);

  // Take the last WINDOW_DAYS + enough lookback for regime (60 days ATR + 20 ATR_LONG)
  // We need ~80 extra days of lookback before our test window
  const LOOKBACK_EXTRA = 80;
  const totalNeeded = WINDOW_DAYS + LOOKBACK_EXTRA;
  const relevantDays = allDays.slice(-totalNeeded);
  const testDays = allDays.slice(-WINDOW_DAYS);
  const firstRelevantDate = relevantDays[0];
  const lastDate = relevantDays[relevantDays.length - 1];

  console.log(`  Test window: ${testDays[0]} to ${testDays[testDays.length - 1]} (${testDays.length} days)`);
  console.log(`  Lookback from: ${firstRelevantDate}`);

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
  console.log(`  Loaded ${dvlRes.rows.length} developing_value_log rows`);

  // 3. Bulk load acd_daily_log
  const acdRes = await query(`
    SELECT trade_date::text as trade_date,
           or_high::float, or_low::float
    FROM acd_daily_log
    WHERE trade_date >= $1 AND trade_date <= $2
    ORDER BY trade_date
  `, [firstRelevantDate, lastDate]);
  const acdByDate = new Map();
  for (const r of acdRes.rows) acdByDate.set(r.trade_date, r);
  console.log(`  Loaded ${acdRes.rows.length} acd_daily_log rows`);

  // 4. Bulk load RTH bars (the big one - only for test days + a bit of lookback for IB)
  const barsStartDate = relevantDays[0];
  const barsRes = await query(`
    SELECT ts::date::text as trade_date,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
           open::float, high::float, low::float, close::float,
           volume::int
    FROM price_bars_primary
    WHERE ts::date >= $1 AND ts::date <= $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `, [barsStartDate, lastDate]);

  const barsByDate = new Map();
  for (const r of barsRes.rows) {
    if (!barsByDate.has(r.trade_date)) barsByDate.set(r.trade_date, []);
    barsByDate.get(r.trade_date).push(r);
  }
  console.log(`  Loaded ${barsRes.rows.length} RTH bars across ${barsByDate.size} days`);

  // 5. Bulk load overnight bars
  const onRes = await query(`
    SELECT ts::date::text as bar_date,
           EXTRACT(hour FROM ts) as hr,
           high::float, low::float
    FROM price_bars_primary
    WHERE ts::date >= $1 AND ts::date <= $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 570
    ORDER BY ts
  `, [barsStartDate, lastDate]);
  // Also load prior-day evening bars
  const onEveRes = await query(`
    SELECT ts::date::text as bar_date,
           EXTRACT(hour FROM ts) as hr,
           high::float, low::float
    FROM price_bars_primary
    WHERE ts::date >= ($1::date - interval '3 day')::date AND ts::date <= $2
      AND EXTRACT(hour FROM ts) >= 18
    ORDER BY ts
  `, [barsStartDate, lastDate]);

  // Build overnight H/L per trade date
  // Overnight = prior calendar day 18:00+ through current calendar day <9:30
  const overnightByDate = new Map();

  // Index evening bars by their calendar date
  const eveningBars = new Map(); // date -> [{high, low}]
  for (const r of onEveRes.rows) {
    if (!eveningBars.has(r.bar_date)) eveningBars.set(r.bar_date, []);
    eveningBars.get(r.bar_date).push(r);
  }
  // Index pre-open bars by their calendar date
  const preOpenBars = new Map();
  for (const r of onRes.rows) {
    if (!preOpenBars.has(r.bar_date)) preOpenBars.set(r.bar_date, []);
    preOpenBars.get(r.bar_date).push(r);
  }

  // For each test day, find prior calendar day's evening + same day's pre-open
  for (const day of relevantDays) {
    const dt = new Date(day + 'T00:00:00');
    // Try up to 3 days back for prior evening (weekends)
    let onHigh = -Infinity, onLow = Infinity, found = false;
    for (let offset = 1; offset <= 3; offset++) {
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
    // Same day pre-open
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

  return { allDays: relevantDays, testDays, dvlByDate, acdByDate, barsByDate, overnightByDate };
}

// ═══════════════════════════════════════════════════════════════════════
// REGIME CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════

function computeDailyATR(allDays, dvlByDate) {
  // True Range per day = session_high - session_low (intraday range as proxy)
  // For proper ATR we'd use max(H-L, |H-prevC|, |L-prevC|) but session H/L suffices
  const trByDate = new Map();
  let prevClose = null;
  for (const day of allDays) {
    const dvl = dvlByDate.get(day);
    if (!dvl) continue;
    const hl = dvl.session_high - dvl.session_low;
    let tr = hl;
    if (prevClose != null) {
      tr = Math.max(hl, Math.abs(dvl.session_high - prevClose), Math.abs(dvl.session_low - prevClose));
    }
    trByDate.set(day, tr);
    prevClose = dvl.session_close;
  }
  return trByDate;
}

function classifyRegime(dayIdx, allDays, trByDate, dvlByDate) {
  // Volatility: ATR(5)/ATR(20) z-scored over trailing 60 days
  // Direction: Net Liquidation proxy = close z-scored over 10 days → NL(10) z-scored
  // Range: prior day range / ATR(20) z-scored

  const day = allDays[dayIdx];

  // Gather trailing TR values
  const trailingTRs = [];
  for (let i = dayIdx - 1; i >= 0 && trailingTRs.length < ZSCORE_WINDOW + ATR_LONG; i--) {
    const tr = trByDate.get(allDays[i]);
    if (tr != null) trailingTRs.push(tr);
  }
  if (trailingTRs.length < ATR_LONG + ZSCORE_WINDOW) return null;

  // ATR(5) and ATR(20) - most recent values
  const atr5 = mean(trailingTRs.slice(0, ATR_SHORT));
  const atr20 = mean(trailingTRs.slice(0, ATR_LONG));
  const atrRatio = atr20 > 0 ? atr5 / atr20 : 1;

  // Z-score the ATR ratio over trailing 60 days
  const atrRatios = [];
  for (let w = 0; w <= ZSCORE_WINDOW - 1 && w + ATR_LONG <= trailingTRs.length; w++) {
    const a5 = mean(trailingTRs.slice(w, w + ATR_SHORT));
    const a20 = mean(trailingTRs.slice(w, w + ATR_LONG));
    atrRatios.push(a20 > 0 ? a5 / a20 : 1);
  }
  const volZ = zscore(atrRatio, atrRatios);

  // Direction: close price net change over NL_PERIOD days, z-scored
  const closes = [];
  for (let i = dayIdx - 1; i >= 0 && closes.length < ZSCORE_WINDOW + NL_PERIOD; i--) {
    const dvl = dvlByDate.get(allDays[i]);
    if (dvl && dvl.session_close) closes.push(dvl.session_close);
  }
  let dirZ = 0;
  if (closes.length >= NL_PERIOD + ZSCORE_WINDOW) {
    const nlChanges = [];
    for (let w = 0; w <= ZSCORE_WINDOW - 1 && w + NL_PERIOD < closes.length; w++) {
      nlChanges.push(closes[w] - closes[w + NL_PERIOD]);
    }
    const currentNL = closes[0] - closes[NL_PERIOD];
    dirZ = zscore(currentNL, nlChanges);
  }

  // Range: prior day range / ATR(20), z-scored
  const priorDayRange = trailingTRs[0]; // most recent day
  const rangeRatio = atr20 > 0 ? priorDayRange / atr20 : 1;
  const rangeRatios = [];
  for (let w = 0; w < ZSCORE_WINDOW && w + ATR_LONG <= trailingTRs.length; w++) {
    const a20w = mean(trailingTRs.slice(w, w + ATR_LONG));
    rangeRatios.push(a20w > 0 ? trailingTRs[w] / a20w : 1);
  }
  const rangeZ = zscore(rangeRatio, rangeRatios);

  // Classify
  const volatility = volZ > 0.5 ? 'EXPANDING' : volZ < -0.5 ? 'CONTRACTING' : 'NORMAL';
  const direction = dirZ > 0.5 ? 'BULLISH' : dirZ < -0.5 ? 'BEARISH' : 'NEUTRAL';
  const range = rangeZ > 0.5 ? 'WIDE' : rangeZ < -0.5 ? 'NARROW' : 'NORMAL';

  return { volatility, direction, range, volZ, dirZ, rangeZ };
}

// ═══════════════════════════════════════════════════════════════════════
// LEVEL COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

function computeLevels(dayIdx, allDays, dvlByDate, acdByDate, barsByDate, overnightByDate) {
  const day = allDays[dayIdx];
  const levels = {};

  // ── Prior day levels (from developing_value_log of prior day) ──
  let priorDvl = null;
  for (let i = dayIdx - 1; i >= 0; i--) {
    priorDvl = dvlByDate.get(allDays[i]);
    if (priorDvl) break;
  }
  if (!priorDvl) return null;

  levels.PD_POC = priorDvl.poc;
  levels.PD_VAH = priorDvl.vah;
  levels.PD_VAL = priorDvl.val;

  // Floor pivots from prior day H/L/C
  const pivots = floorPivots(priorDvl.session_high, priorDvl.session_low, priorDvl.session_close);
  levels.FLOOR_PIVOT = pivots.FLOOR_PIVOT;
  levels.FLOOR_R1 = pivots.FLOOR_R1;
  levels.FLOOR_S1 = pivots.FLOOR_S1;

  // Prior day IB (from prior day's bars, tod 570-629)
  let priorBars = null;
  for (let i = dayIdx - 1; i >= 0; i--) {
    priorBars = barsByDate.get(allDays[i]);
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

  // Prior day midpoints
  levels.PD_SESSION_MID = (priorDvl.session_high + priorDvl.session_low) / 2;

  // Prior day OR midpoint (from acd_daily_log of prior day)
  let priorAcd = null;
  for (let i = dayIdx - 1; i >= 0; i--) {
    priorAcd = acdByDate.get(allDays[i]);
    if (priorAcd) break;
  }
  if (priorAcd) {
    levels.PD_OR_MID = (priorAcd.or_high + priorAcd.or_low) / 2;
  }

  // Today's OR from acd_daily_log (known after first 30 min)
  const todayAcd = acdByDate.get(day);
  if (todayAcd) {
    levels.OR_MID = (todayAcd.or_high + todayAcd.or_low) / 2;
  }

  // Today's IB will be computed inline during bar processing

  // ── Rolling composites ──
  // 10D_IB_MID: rolling 10-day IB composite midpoint
  const ibMids = [];
  for (let i = dayIdx - 1; i >= 0 && ibMids.length < 10; i--) {
    const bars = barsByDate.get(allDays[i]);
    if (!bars) continue;
    let ibH = -Infinity, ibL = Infinity;
    for (const b of bars) {
      if (b.tod >= 570 && b.tod <= 629) {
        ibH = Math.max(ibH, b.high);
        ibL = Math.min(ibL, b.low);
      }
    }
    if (ibH > -Infinity) ibMids.push((ibH + ibL) / 2);
  }
  if (ibMids.length >= 5) {
    levels['10D_IB_MID'] = mean(ibMids);
  }

  // 5D_OR_MID: rolling 5-day OR composite midpoint
  const orMids = [];
  for (let i = dayIdx - 1; i >= 0 && orMids.length < 5; i--) {
    const acd = acdByDate.get(allDays[i]);
    if (acd) orMids.push((acd.or_high + acd.or_low) / 2);
  }
  if (orMids.length >= 3) {
    levels['5D_OR_MID'] = mean(orMids);
  }

  return levels;
}

// ═══════════════════════════════════════════════════════════════════════
// REGIME-BASED LEVEL RANKING
// ═══════════════════════════════════════════════════════════════════════

function rankLevels(regime, tradeHistory) {
  // Look at all past trades for each level, compute overall WR and regime-specific WR
  // Use VOLATILITY as the primary regime dimension (3 buckets, not 27) for adequate sample size
  // Tag each level as LEAN_INTO, STANDARD, or AVOID
  const levelStats = new Map(); // levelName -> { overallWins, overallN, volWins, volN, dirWins, dirN }

  for (const t of tradeHistory) {
    const key = t.level;
    if (!levelStats.has(key)) levelStats.set(key, {
      overallWins: 0, overallN: 0,
      volWins: 0, volN: 0,
      dirWins: 0, dirN: 0,
    });
    const s = levelStats.get(key);
    s.overallN++;
    if (t.result === 'W') s.overallWins++;

    // Match on volatility regime (primary)
    if (t.regimeObj && t.regimeObj.volatility === regime.volatility) {
      s.volN++;
      if (t.result === 'W') s.volWins++;
    }
    // Match on direction regime (secondary)
    if (t.regimeObj && t.regimeObj.direction === regime.direction) {
      s.dirN++;
      if (t.result === 'W') s.dirWins++;
    }
  }

  const rankings = new Map();
  for (const [level, s] of levelStats) {
    const overallWR = s.overallN > 0 ? s.overallWins / s.overallN : 0.5;

    // Use volatility as primary filter (N >= 5 required)
    // If volatility has enough data, use it; else fall back to direction
    let regimeWR = overallWR;
    let hasRegimeData = false;

    if (s.volN >= 5) {
      regimeWR = s.volWins / s.volN;
      hasRegimeData = true;
    } else if (s.dirN >= 5) {
      regimeWR = s.dirWins / s.dirN;
      hasRegimeData = true;
    }

    if (hasRegimeData) {
      const diff = regimeWR - overallWR;
      if (diff > 0.05) {
        rankings.set(level, 'LEAN_INTO');
      } else if (diff < -0.05) {
        rankings.set(level, 'AVOID');
      } else {
        rankings.set(level, 'STANDARD');
      }
    } else {
      rankings.set(level, 'STANDARD');
    }
  }

  return rankings;
}

// ═══════════════════════════════════════════════════════════════════════
// TRADE EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════

function executeTrades(bars, levels, rankings, regime, day, maxTrades) {
  const trades = [];
  const touchedLevels = new Set(); // first touch only per level
  let dayPnL = 0;

  // Determine which bars represent the IB (first 60 min)
  let ibHigh = -Infinity, ibLow = Infinity;
  for (const b of bars) {
    if (b.tod >= 570 && b.tod <= 629) {
      ibHigh = Math.max(ibHigh, b.high);
      ibLow = Math.min(ibLow, b.low);
    }
  }
  // Add today's IB_MID as a level (available after IB close at tod 630)
  if (ibHigh > -Infinity) {
    levels.IB_MID = (ibHigh + ibLow) / 2;
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // AM session only (before noon)
    if (bar.tod >= AM_CUTOFF_TOD) break;

    // DLL check: stop if we've hit the limit
    if (dayPnL <= -DLL) break;

    // Max trades check
    if (trades.length >= maxTrades) break;

    // IB_MID only available after IB close
    const pastIB = bar.tod >= 630;

    // Check each level for first touch
    for (const [levelName, levelPrice] of Object.entries(levels)) {
      if (levelPrice == null || !isFinite(levelPrice)) continue;

      // Skip IB_MID before IB close, skip OR_MID before OR close
      if (levelName === 'IB_MID' && !pastIB) continue;
      if (levelName === 'OR_MID' && bar.tod < 600) continue; // OR forms by 10:00

      // Already touched?
      if (touchedLevels.has(levelName)) continue;

      // Check proximity: bar must reach within PROXIMITY of level
      const touchesHigh = bar.high >= levelPrice - PROXIMITY && bar.high <= levelPrice + PROXIMITY;
      const touchesLow = bar.low >= levelPrice - PROXIMITY && bar.low <= levelPrice + PROXIMITY;

      if (!touchesHigh && !touchesLow) continue;

      // Determine fade direction
      let direction;
      if (touchesHigh && bar.high >= levelPrice) {
        direction = 'SHORT'; // price reached up to level, fade short
      } else if (touchesLow && bar.low <= levelPrice) {
        direction = 'LONG'; // price reached down to level, fade long
      } else {
        continue;
      }

      // Mark as touched regardless of whether we take the trade
      touchedLevels.add(levelName);

      // Check regime ranking
      const ranking = rankings.get(levelName) || 'STANDARD';
      if (ranking === 'AVOID') continue; // Skip AVOID levels

      // DLL check before entering
      const maxLoss = FADE_STOP * PNL_PER_POINT + COMMISSION;
      if (dayPnL - maxLoss < -DLL) continue; // would exceed DLL

      // Max trades check
      if (trades.length >= maxTrades) break;

      // Entry price: level price (we're fading at the level)
      const entryPrice = levelPrice;

      // Resolve trade bar-by-bar from next bar
      let result = null, exitPrice = null, mae = 0, mfe = 0;

      for (let j = i + 1; j < bars.length; j++) {
        const futureBar = bars[j];

        if (direction === 'SHORT') {
          // MAE: how much price went against us (higher = worse for short)
          const adverse = futureBar.high - entryPrice;
          const favorable = entryPrice - futureBar.low;
          mae = Math.max(mae, adverse);
          mfe = Math.max(mfe, favorable);

          // Conservative: same bar where both stop and target hit → stop wins
          if (adverse >= FADE_STOP) {
            result = 'L';
            exitPrice = entryPrice + FADE_STOP;
            break;
          }
          if (favorable >= FADE_TARGET) {
            result = 'W';
            exitPrice = entryPrice - FADE_TARGET;
            break;
          }
        } else {
          // LONG
          const adverse = entryPrice - futureBar.low;
          const favorable = futureBar.high - entryPrice;
          mae = Math.max(mae, adverse);
          mfe = Math.max(mfe, favorable);

          if (adverse >= FADE_STOP) {
            result = 'L';
            exitPrice = entryPrice - FADE_STOP;
            break;
          }
          if (favorable >= FADE_TARGET) {
            result = 'W';
            exitPrice = entryPrice + FADE_TARGET;
            break;
          }
        }
      }

      // If trade didn't resolve by end of day, mark as exit at last close
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

      // Compute P&L
      let tradePnL;
      if (direction === 'SHORT') {
        tradePnL = (entryPrice - exitPrice) * PNL_PER_POINT - COMMISSION;
      } else {
        tradePnL = (exitPrice - entryPrice) * PNL_PER_POINT - COMMISSION;
      }

      dayPnL += tradePnL;

      trades.push({
        date: day,
        level: levelName,
        direction,
        regime: regime ? `${regime.volatility}/${regime.direction}/${regime.range}` : 'UNKNOWN',
        regimeObj: regime,
        ranking,
        entryPrice,
        exitPrice,
        result,
        pnl: tradePnL,
        mae,
        mfe,
        tod: bar.tod,
      });

      // Only take one trade per bar
      break;
    }
  }

  return { trades, dayPnL };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SIMULATION
// ═══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   FULL SYSTEM BACKTEST: Regime-Adaptive Level Fade System');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Parameters: ${FADE_TARGET}pt target, ${FADE_STOP}pt stop, ${PROXIMITY}pt proximity`);
  console.log(`PNL/pt: $${PNL_PER_POINT}, Commission: $${COMMISSION}, DLL: $${DLL}`);
  console.log(`Max trades/day: ${MAX_TRADES}, AM session only (before noon)`);
  console.log();

  const { allDays, testDays, dvlByDate, acdByDate, barsByDate, overnightByDate } = await loadAllData();

  // Pre-compute ATR data
  const trByDate = computeDailyATR(allDays, dvlByDate);

  // ── DAY-BY-DAY SIMULATION ──
  const allTrades = [];       // with regime filter
  const allTradesNoFilter = []; // without regime filter (comparison)
  const dailyResults = [];
  const dailyResultsNoFilter = [];
  let cumPnL = 0;
  let cumPnLNoFilter = 0;
  let peakPnL = 0;
  let peakPnLNoFilter = 0;
  let maxDD = 0;
  let maxDDNoFilter = 0;
  let skippedDays = 0;

  // Historical trades for regime ranking (no look-ahead)
  const tradeHistory = [];
  const tradeHistoryNoFilter = [];

  // Track regime transitions
  let prevRegime = null;

  for (let ti = 0; ti < testDays.length; ti++) {
    const day = testDays[ti];
    const dayIdx = allDays.indexOf(day);

    if (ti % 30 === 0) console.log(`  Simulating day ${ti + 1}/${testDays.length}: ${day}`);

    // Step 1: Classify regime
    const regime = classifyRegime(dayIdx, allDays, trByDate, dvlByDate);
    if (!regime) {
      skippedDays++;
      dailyResults.push({ date: day, pnl: 0, trades: 0, regime: null, isTransition: false });
      dailyResultsNoFilter.push({ date: day, pnl: 0, trades: 0, regime: null, isTransition: false });
      continue;
    }

    // Detect regime transition
    const isTransition = prevRegime != null && (
      prevRegime.volatility !== regime.volatility ||
      prevRegime.direction !== regime.direction
    );
    prevRegime = { ...regime };

    // Step 2: Compute levels
    const levels = computeLevels(dayIdx, allDays, dvlByDate, acdByDate, barsByDate, overnightByDate);
    if (!levels) {
      skippedDays++;
      dailyResults.push({ date: day, pnl: 0, trades: 0, regime, isTransition });
      dailyResultsNoFilter.push({ date: day, pnl: 0, trades: 0, regime, isTransition });
      continue;
    }

    // Get today's bars
    const bars = barsByDate.get(day);
    if (!bars || bars.length < 30) {
      skippedDays++;
      dailyResults.push({ date: day, pnl: 0, trades: 0, regime, isTransition });
      dailyResultsNoFilter.push({ date: day, pnl: 0, trades: 0, regime, isTransition });
      continue;
    }

    // Step 3: Rank levels by regime performance (using only historical trades)
    const rankings = rankLevels(regime, tradeHistory);

    // Step 4a: Execute trades WITH regime filter
    const levelsWithFilter = { ...levels };
    const { trades: dayTrades, dayPnL } = executeTrades(
      bars, levelsWithFilter, rankings, regime, day, MAX_TRADES
    );

    // Step 4b: Execute trades WITHOUT regime filter (comparison)
    const levelsNoFilter = { ...levels };
    const noFilterRankings = new Map(); // all STANDARD = no filtering
    const { trades: dayTradesNoFilter, dayPnL: dayPnLNoFilter } = executeTrades(
      bars, levelsNoFilter, noFilterRankings, regime, day, MAX_TRADES
    );

    // Record trades
    for (const t of dayTrades) {
      allTrades.push(t);
      tradeHistory.push(t);
    }
    for (const t of dayTradesNoFilter) {
      allTradesNoFilter.push(t);
      tradeHistoryNoFilter.push(t);
    }

    // Track daily results
    cumPnL += dayPnL;
    peakPnL = Math.max(peakPnL, cumPnL);
    const dd = peakPnL - cumPnL;
    maxDD = Math.max(maxDD, dd);

    cumPnLNoFilter += dayPnLNoFilter;
    peakPnLNoFilter = Math.max(peakPnLNoFilter, cumPnLNoFilter);
    const ddNF = peakPnLNoFilter - cumPnLNoFilter;
    maxDDNoFilter = Math.max(maxDDNoFilter, ddNF);

    dailyResults.push({
      date: day,
      pnl: dayPnL,
      trades: dayTrades.length,
      cumPnL,
      regime,
      isTransition,
    });
    dailyResultsNoFilter.push({
      date: day,
      pnl: dayPnLNoFilter,
      trades: dayTradesNoFilter.length,
      cumPnLNoFilter,
      regime,
      isTransition,
    });
  }

  console.log(`\nSimulation complete. Skipped ${skippedDays} days.\n`);

  // ═══════════════════════════════════════════════════════════════════
  // PART 1: EQUITY CURVE SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('PART 1: EQUITY CURVE SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const tradeDays = dailyResults.filter(d => d.trades > 0);
  const wins = allTrades.filter(t => t.result === 'W');
  const losses = allTrades.filter(t => t.result === 'L');
  const dailyPnLs = dailyResults.map(d => d.pnl);
  const avgDailyPnL = mean(dailyPnLs);
  const stdDailyPnL = std(dailyPnLs);
  const sharpe = stdDailyPnL > 0 ? avgDailyPnL / stdDailyPnL : 0;
  const bestDay = Math.max(...dailyPnLs);
  const worstDay = Math.min(...dailyPnLs);

  console.log(`  Starting equity:     $0`);
  console.log(`  Ending equity:       $${fmt(cumPnL, 2)}`);
  console.log(`  Total trades:        ${allTrades.length}`);
  console.log(`  Win rate:            ${pctStr(wins.length, allTrades.length)} (${wins.length}W / ${losses.length}L)`);
  console.log(`  Avg P&L/trade:       $${fmt(mean(allTrades.map(t => t.pnl)), 2)}`);
  console.log(`  Max drawdown:        $${fmt(maxDD, 2)} (${peakPnL > 0 ? fmt(maxDD / peakPnL * 100, 1) : 'N/A'}%)`);
  console.log(`  Avg daily P&L:       $${fmt(avgDailyPnL, 2)}`);
  console.log(`  Std daily P&L:       $${fmt(stdDailyPnL, 2)}`);
  console.log(`  Sharpe-like ratio:   ${fmt(sharpe, 3)}`);
  console.log(`  Best day:            $${fmt(bestDay, 2)}`);
  console.log(`  Worst day:           $${fmt(worstDay, 2)}`);
  console.log(`  Days with trades:    ${tradeDays.length} / ${dailyResults.length}`);
  console.log(`  Avg trades/day:      ${fmt(allTrades.length / dailyResults.length, 2)}`);

  // Monthly breakdown
  console.log(`\n  ── Monthly Breakdown ──`);
  const monthMap = new Map();
  for (const d of dailyResults) {
    const month = d.date.slice(0, 7);
    if (!monthMap.has(month)) monthMap.set(month, { pnl: 0, trades: 0, wins: 0, days: 0 });
    const m = monthMap.get(month);
    m.pnl += d.pnl;
    m.trades += d.trades;
    m.days++;
  }
  for (const t of allTrades) {
    const month = t.date.slice(0, 7);
    if (monthMap.has(month) && t.result === 'W') monthMap.get(month).wins++;
  }

  console.log(`  ${'Month'.padEnd(10)} ${'P&L'.padStart(10)} ${'Trades'.padStart(8)} ${'WR'.padStart(8)} ${'Days'.padStart(6)}`);
  console.log(`  ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(6)}`);
  for (const [month, m] of monthMap) {
    console.log(`  ${month.padEnd(10)} ${('$' + fmt(m.pnl, 2)).padStart(10)} ${String(m.trades).padStart(8)} ${pctStr(m.wins, m.trades).padStart(8)} ${String(m.days).padStart(6)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 2: PER-LEVEL PERFORMANCE
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('PART 2: PER-LEVEL PERFORMANCE WITHIN SYSTEM');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const levelMap = new Map();
  for (const t of allTrades) {
    if (!levelMap.has(t.level)) levelMap.set(t.level, { trades: 0, wins: 0, pnl: 0, pnls: [], maes: [], mfes: [] });
    const l = levelMap.get(t.level);
    l.trades++;
    if (t.result === 'W') l.wins++;
    l.pnl += t.pnl;
    l.pnls.push(t.pnl);
    l.maes.push(t.mae);
    l.mfes.push(t.mfe);
  }

  const sortedLevels = [...levelMap.entries()].sort((a, b) => b[1].pnl - a[1].pnl);

  console.log(`  ${'Level'.padEnd(18)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'Total P&L'.padStart(11)} ${'Avg EV'.padStart(9)} ${'Avg MAE'.padStart(9)} ${'Avg MFE'.padStart(9)} ${'% Total'.padStart(8)}`);
  console.log(`  ${'─'.repeat(18)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(11)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(8)}`);
  for (const [level, s] of sortedLevels) {
    const pctTotal = cumPnL !== 0 ? (s.pnl / Math.abs(cumPnL) * 100) : 0;
    console.log(`  ${level.padEnd(18)} ${String(s.trades).padStart(7)} ${pctStr(s.wins, s.trades).padStart(7)} ${('$' + fmt(s.pnl, 2)).padStart(11)} ${('$' + fmt(mean(s.pnls), 2)).padStart(9)} ${fmt(mean(s.maes), 1).padStart(9)} ${fmt(mean(s.mfes), 1).padStart(9)} ${(fmt(pctTotal, 1) + '%').padStart(8)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 3: REGIME IMPACT
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('PART 3: REGIME IMPACT (WITH vs WITHOUT FILTER)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const winsNF = allTradesNoFilter.filter(t => t.result === 'W');
  const dailyPnLsNF = dailyResultsNoFilter.map(d => d.pnl);
  const avgDailyNF = mean(dailyPnLsNF);
  const stdDailyNF = std(dailyPnLsNF);
  const sharpeNF = stdDailyNF > 0 ? avgDailyNF / stdDailyNF : 0;

  console.log(`  ${'Metric'.padEnd(25)} ${'WITH Filter'.padStart(15)} ${'WITHOUT Filter'.padStart(15)} ${'Difference'.padStart(12)}`);
  console.log(`  ${'─'.repeat(25)} ${'─'.repeat(15)} ${'─'.repeat(15)} ${'─'.repeat(12)}`);
  console.log(`  ${'Total P&L'.padEnd(25)} ${('$' + fmt(cumPnL, 2)).padStart(15)} ${('$' + fmt(cumPnLNoFilter, 2)).padStart(15)} ${('$' + fmt(cumPnL - cumPnLNoFilter, 2)).padStart(12)}`);
  console.log(`  ${'Total Trades'.padEnd(25)} ${String(allTrades.length).padStart(15)} ${String(allTradesNoFilter.length).padStart(15)} ${String(allTrades.length - allTradesNoFilter.length).padStart(12)}`);
  console.log(`  ${'Win Rate'.padEnd(25)} ${pctStr(wins.length, allTrades.length).padStart(15)} ${pctStr(winsNF.length, allTradesNoFilter.length).padStart(15)}`);
  console.log(`  ${'Max Drawdown'.padEnd(25)} ${('$' + fmt(maxDD, 2)).padStart(15)} ${('$' + fmt(maxDDNoFilter, 2)).padStart(15)} ${('$' + fmt(maxDD - maxDDNoFilter, 2)).padStart(12)}`);
  console.log(`  ${'Sharpe Ratio'.padEnd(25)} ${fmt(sharpe, 3).padStart(15)} ${fmt(sharpeNF, 3).padStart(15)} ${fmt(sharpe - sharpeNF, 3).padStart(12)}`);
  console.log(`  ${'Avg Daily P&L'.padEnd(25)} ${('$' + fmt(avgDailyPnL, 2)).padStart(15)} ${('$' + fmt(avgDailyNF, 2)).padStart(15)} ${('$' + fmt(avgDailyPnL - avgDailyNF, 2)).padStart(12)}`);

  // Show how many trades were avoided due to regime filter
  const avoidedTrades = allTradesNoFilter.length - allTrades.length;
  console.log(`\n  Trades avoided by regime filter: ${avoidedTrades}`);
  if (avoidedTrades > 0) {
    console.log(`  P&L of avoided trades: $${fmt(cumPnLNoFilter - cumPnL, 2)} (${cumPnLNoFilter - cumPnL > 0 ? 'LOST PROFIT' : 'SAVED LOSSES'})`);
  }

  // Regime distribution of trades
  console.log(`\n  ── Regime Distribution (WITH filter) ──`);
  const regimeCounts = new Map();
  for (const t of allTrades) {
    const key = t.regime;
    if (!regimeCounts.has(key)) regimeCounts.set(key, { n: 0, wins: 0, pnl: 0 });
    const r = regimeCounts.get(key);
    r.n++;
    if (t.result === 'W') r.wins++;
    r.pnl += t.pnl;
  }
  console.log(`  ${'Regime'.padEnd(35)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'P&L'.padStart(10)}`);
  console.log(`  ${'─'.repeat(35)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(10)}`);
  for (const [regime, r] of [...regimeCounts.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${regime.padEnd(35)} ${String(r.n).padStart(7)} ${pctStr(r.wins, r.n).padStart(7)} ${('$' + fmt(r.pnl, 2)).padStart(10)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 4: ROLLING COMPOSITE VS STANDARD LEVELS
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('PART 4: ROLLING COMPOSITE vs STANDARD LEVELS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const composites = ['10D_IB_MID', '5D_OR_MID'];
  const standards = ['PD_IB_MID', 'PD_OR_MID'];

  for (let ci = 0; ci < composites.length; ci++) {
    const comp = composites[ci];
    const std1 = standards[ci];
    const compStats = levelMap.get(comp);
    const stdStats = levelMap.get(std1);

    console.log(`  ${comp} vs ${std1}:`);
    if (compStats) {
      console.log(`    ${comp}: ${compStats.trades} trades, ${pctStr(compStats.wins, compStats.trades)} WR, $${fmt(compStats.pnl, 2)} P&L, $${fmt(mean(compStats.pnls), 2)} EV`);
    } else {
      console.log(`    ${comp}: 0 trades (no touches in range)`);
    }
    if (stdStats) {
      console.log(`    ${std1}: ${stdStats.trades} trades, ${pctStr(stdStats.wins, stdStats.trades)} WR, $${fmt(stdStats.pnl, 2)} P&L, $${fmt(mean(stdStats.pnls), 2)} EV`);
    } else {
      console.log(`    ${std1}: 0 trades (no touches in range)`);
    }
    if (compStats && stdStats) {
      const incrementalPnL = compStats.pnl - stdStats.pnl;
      console.log(`    Incremental P&L from composite: $${fmt(incrementalPnL, 2)} (${incrementalPnL > 0 ? 'ADDS VALUE' : 'DEAD WEIGHT'})`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 5: DLL COMPLIANCE
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('PART 5: DLL COMPLIANCE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const daysOver3 = dailyResults.filter(d => d.trades > 3).length;
  const daysHitDLL = dailyResults.filter(d => d.pnl <= -DLL).length;
  const daysNearDLL = dailyResults.filter(d => d.pnl <= -300 && d.pnl > -DLL).length;
  const worstDayPnL = Math.min(...dailyResults.map(d => d.pnl));
  const survived = dailyResults.every(d => d.pnl > -DLL);

  console.log(`  Max trades/day limit:     ${MAX_TRADES}`);
  console.log(`  Days exceeding 3 trades:  ${daysOver3}`);
  console.log(`  Days hitting $${DLL} DLL:   ${daysHitDLL}`);
  console.log(`  Days near DLL ($300-$400): ${daysNearDLL}`);
  console.log(`  Worst single day:         $${fmt(worstDayPnL, 2)}`);
  console.log(`  Survived every day?       ${survived ? 'YES' : 'NO'}`);

  // Distribution of daily P&L
  const pnlBuckets = { '<-300': 0, '-300 to -100': 0, '-100 to 0': 0, '0 to 100': 0, '100 to 300': 0, '>300': 0 };
  for (const d of dailyResults) {
    if (d.pnl < -300) pnlBuckets['<-300']++;
    else if (d.pnl < -100) pnlBuckets['-300 to -100']++;
    else if (d.pnl < 0) pnlBuckets['-100 to 0']++;
    else if (d.pnl < 100) pnlBuckets['0 to 100']++;
    else if (d.pnl < 300) pnlBuckets['100 to 300']++;
    else pnlBuckets['>300']++;
  }
  console.log(`\n  ── Daily P&L Distribution ──`);
  for (const [bucket, count] of Object.entries(pnlBuckets)) {
    const bar = '#'.repeat(Math.round(count / dailyResults.length * 50));
    console.log(`    ${bucket.padEnd(16)} ${String(count).padStart(4)} ${bar}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 6: REGIME TRANSITION ANALYSIS
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('PART 6: REGIME TRANSITION ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const transitionDays = dailyResults.filter(d => d.isTransition && d.trades > 0);
  const stableDays = dailyResults.filter(d => !d.isTransition && d.trades > 0);

  const transitionTrades = allTrades.filter(t => {
    const dayResult = dailyResults.find(d => d.date === t.date);
    return dayResult && dayResult.isTransition;
  });
  const stableTrades = allTrades.filter(t => {
    const dayResult = dailyResults.find(d => d.date === t.date);
    return dayResult && !dayResult.isTransition;
  });

  const transitionWins = transitionTrades.filter(t => t.result === 'W');
  const stableWins = stableTrades.filter(t => t.result === 'W');

  console.log(`  ${'Metric'.padEnd(25)} ${'Transitions'.padStart(15)} ${'Stable'.padStart(15)}`);
  console.log(`  ${'─'.repeat(25)} ${'─'.repeat(15)} ${'─'.repeat(15)}`);
  console.log(`  ${'Days'.padEnd(25)} ${String(transitionDays.length).padStart(15)} ${String(stableDays.length).padStart(15)}`);
  console.log(`  ${'Trades'.padEnd(25)} ${String(transitionTrades.length).padStart(15)} ${String(stableTrades.length).padStart(15)}`);
  console.log(`  ${'Win Rate'.padEnd(25)} ${pctStr(transitionWins.length, transitionTrades.length).padStart(15)} ${pctStr(stableWins.length, stableTrades.length).padStart(15)}`);
  console.log(`  ${'Total P&L'.padEnd(25)} ${('$' + fmt(transitionTrades.reduce((s, t) => s + t.pnl, 0), 2)).padStart(15)} ${('$' + fmt(stableTrades.reduce((s, t) => s + t.pnl, 0), 2)).padStart(15)}`);
  console.log(`  ${'Avg P&L/trade'.padEnd(25)} ${('$' + fmt(mean(transitionTrades.map(t => t.pnl)), 2)).padStart(15)} ${('$' + fmt(mean(stableTrades.map(t => t.pnl)), 2)).padStart(15)}`);
  console.log(`  ${'Avg daily P&L'.padEnd(25)} ${('$' + fmt(mean(transitionDays.map(d => d.pnl)), 2)).padStart(15)} ${('$' + fmt(mean(stableDays.map(d => d.pnl)), 2)).padStart(15)}`);

  const shouldReduceSize = mean(transitionTrades.map(t => t.pnl)) < mean(stableTrades.map(t => t.pnl)) * 0.5;
  console.log(`\n  Recommendation: ${shouldReduceSize ? 'YES, reduce size during regime transitions' : 'No strong evidence to reduce size during transitions'}`);

  // ── BONUS: Equity curve milestones ──
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('EQUITY CURVE MILESTONES');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let runCum = 0;
  const milestones = [500, 1000, 2000, 3000, 5000];
  const hitMilestones = new Set();
  let maxDDDate = '', maxDDVal = 0, maxDDPeak = 0;
  let runPeak = 0;

  for (const d of dailyResults) {
    runCum += d.pnl;
    if (runCum > runPeak) runPeak = runCum;
    const dd = runPeak - runCum;
    if (dd > maxDDVal) {
      maxDDVal = dd;
      maxDDDate = d.date;
      maxDDPeak = runPeak;
    }
    for (const m of milestones) {
      if (runCum >= m && !hitMilestones.has(m)) {
        hitMilestones.add(m);
        console.log(`  $${m.toLocaleString()} reached on ${d.date} (day ${dailyResults.indexOf(d) + 1})`);
      }
    }
  }
  console.log(`\n  Max drawdown of $${fmt(maxDDVal, 2)} occurred on ${maxDDDate} (peak was $${fmt(maxDDPeak, 2)})`);

  // Win/loss streaks
  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
  for (const t of allTrades) {
    if (t.result === 'W') { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
    else { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
  }
  console.log(`  Max win streak:  ${maxWinStreak}`);
  console.log(`  Max loss streak: ${maxLossStreak}`);

  // Profit factor
  const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  console.log(`  Profit factor:   ${grossLoss > 0 ? fmt(grossProfit / grossLoss, 2) : 'INF'}`);

  // Per-direction breakdown
  console.log('\n  ── Direction Breakdown ──');
  for (const dir of ['LONG', 'SHORT']) {
    const dt = allTrades.filter(t => t.direction === dir);
    const dw = dt.filter(t => t.result === 'W');
    console.log(`    ${dir}: ${dt.length} trades, ${pctStr(dw.length, dt.length)} WR, $${fmt(dt.reduce((s, t) => s + t.pnl, 0), 2)} P&L`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('BACKTEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

run().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
