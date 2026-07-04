// backtest_full_system.js
// ═══════════════════════════════════════════════════════════════════════
// DEFINITIVE FULL-SYSTEM BACKTEST: Regime-adaptive level fade system
// Simulates the complete system day-by-day: regime detection, level
// ranking, trade execution with DLL constraints.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

// ── Constants ──
const DLL              = 400;   // daily loss limit (prop firm, fixed)
const WINDOW_DAYS      = 252;   // ~1 trading year
const FADE_STOP_BASE   = 39;    // base stop in points (DLL-capped at 5 MNQ)
const FADE_TARGET      = 40;    // 40pt target
const PROXIMITY        = 10;    // touch = within 10pt
const MAX_TRADES       = 3;     // max trades/day
const AM_CUTOFF_TOD    = 720;   // noon ET = 12:00 = 720 min
const STARTING_ACCOUNT = 2000;  // prop firm starting margin
const RISK_PCT         = parseFloat(process.env.RISK_PCT || '0.01'); // 1% default, override via env
const RISK_PER_CONTRACT = FADE_STOP_BASE * 2 + 1; // $79 per contract (39pt * $2 + $1 commission)
const MAX_CONTRACTS    = Math.floor(DLL / RISK_PER_CONTRACT); // DLL ceiling (~5)
const MIN_CONTRACTS    = parseInt(process.env.MIN_CONTRACTS || '3'); // floor (3 = start at operating size)

// Dynamic per-day sizing (computed in main loop, defaults for standalone use)
let CONTRACTS     = MIN_CONTRACTS;
let PNL_PER_POINT = 2 * CONTRACTS;
let COMMISSION    = 1 * CONTRACTS;
let FADE_STOP     = FADE_STOP_BASE;

function computeContracts(account) {
  const targetRisk = account * RISK_PCT;
  return Math.max(MIN_CONTRACTS, Math.min(MAX_CONTRACTS, Math.floor(targetRisk / RISK_PER_CONTRACT)));
}

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

// ═══════════════════════════════════════════════════════════════════════
// DATA LOADING (bulk pre-fetch for performance)
// ═══════════════════════════════════════════════════════════════════════

async function loadAllData() {
  console.log('Loading data...');

  // 1. Get trading days from level_prices (single source of truth)
  const daysRes = await query(`
    SELECT lp.trade_date::text as trade_date
    FROM level_prices lp
    WHERE lp.trade_date <= CURRENT_DATE
      AND EXISTS (
        SELECT 1 FROM price_bars_primary p
        WHERE p.ts::date = lp.trade_date
          AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) BETWEEN 570 AND 959
      )
    GROUP BY lp.trade_date
    HAVING COUNT(DISTINCT lp.level_name) >= 5
    ORDER BY lp.trade_date
  `);
  const allDays = daysRes.rows.map(r => r.trade_date);
  console.log(`  Total trading days with complete data: ${allDays.length}`);

  const LOOKBACK_EXTRA = 80;
  const totalNeeded = WINDOW_DAYS + LOOKBACK_EXTRA;
  const relevantDays = allDays.slice(-totalNeeded);
  const testDays = allDays.slice(-WINDOW_DAYS);
  const firstRelevantDate = relevantDays[0];
  const lastDate = relevantDays[relevantDays.length - 1];

  console.log(`  Test window: ${testDays[0]} to ${testDays[testDays.length - 1]} (${testDays.length} days)`);
  console.log(`  Lookback from: ${firstRelevantDate}`);

  // 2. Bulk load all level_prices rows (single query replaces 4 separate data queries)
  const lpRes = await query(`
    SELECT trade_date::text as trade_date, level_name, price::float
    FROM level_prices
    WHERE trade_date >= $1 AND trade_date <= $2 AND price IS NOT NULL
    ORDER BY trade_date
  `, [firstRelevantDate, lastDate]);
  const levelsByDate = new Map();
  for (const r of lpRes.rows) {
    if (!levelsByDate.has(r.trade_date)) levelsByDate.set(r.trade_date, {});
    levelsByDate.get(r.trade_date)[r.level_name] = r.price;
  }
  console.log(`  Loaded level_prices for ${levelsByDate.size} days`);

  // 3. Bulk load RTH bars (needed for bar simulation and session H/L/C for regime)
  const barsRes = await query(`
    SELECT ts::date::text as trade_date,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
           open::float, high::float, low::float, close::float,
           volume::int
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
  console.log(`  Loaded ${barsRes.rows.length} RTH bars across ${barsByDate.size} days`);

  // Derive session H/L/C from bars (for regime computation — no separate dvl query needed)
  const sessionByDate = new Map();
  for (const [date, bars] of barsByDate) {
    sessionByDate.set(date, {
      session_high:  Math.max(...bars.map(b => b.high)),
      session_low:   Math.min(...bars.map(b => b.low)),
      session_close: bars[bars.length - 1].close,
    });
  }

  return { allDays: relevantDays, testDays, levelsByDate, barsByDate, sessionByDate };
}

// ═══════════════════════════════════════════════════════════════════════
// REGIME CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════

function computeDailyATR(allDays, sessionByDate) {
  const trByDate = new Map();
  let prevClose = null;
  for (const day of allDays) {
    const s = sessionByDate.get(day);
    if (!s) continue;
    const hl = s.session_high - s.session_low;
    let tr = hl;
    if (prevClose != null) {
      tr = Math.max(hl, Math.abs(s.session_high - prevClose), Math.abs(s.session_low - prevClose));
    }
    trByDate.set(day, tr);
    prevClose = s.session_close;
  }
  return trByDate;
}

function classifyRegime(dayIdx, allDays, trByDate, sessionByDate) {
  // Volatility: ATR(5)/ATR(20) z-scored over trailing 60 days
  // Direction: Net Liquidation proxy = close z-scored over 10 days → NL(10) z-scored
  // Range: prior day range / ATR(20) z-scored

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
    const s = sessionByDate.get(allDays[i]);
    if (s?.session_close) closes.push(s.session_close);
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
// LEVEL LOOKUP (reads from level_prices via levelsByDate)
// ═══════════════════════════════════════════════════════════════════════

function computeLevels(date, levelsByDate) {
  const lp = levelsByDate.get(date);
  if (!lp || Object.keys(lp).length < 5) return null;
  // Exclude RTH_VWAP (end-of-session, lookahead in bar simulation)
  // Exclude today's IB levels — gated inline in executeTrades after tod 630
  const { RTH_VWAP: _v, IB_HIGH: _ih, IB_LOW: _il, IB_MID: _im, ...staticLevels } = lp;
  // Normalize overnight names
  if (staticLevels.ONH != null) { staticLevels.ON_HIGH = staticLevels.ONH; delete staticLevels.ONH; }
  if (staticLevels.ONL != null) { staticLevels.ON_LOW = staticLevels.ONL; delete staticLevels.ONL; }
  return staticLevels;
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

function executeTrades(bars, levels, rankings, regime, day, maxTrades, levelsByDate) {
  const trades = [];
  const touchedLevels = new Set(); // first touch only per level
  let dayPnL = 0;

  // Today's IB levels from level_prices are injected after IB close (tod >= 630)
  const lp = levelsByDate.get(day) || {};
  const todayIB = { IB_HIGH: lp.IB_HIGH, IB_LOW: lp.IB_LOW, IB_MID: lp.IB_MID };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // AM session only (before noon)
    if (bar.tod >= AM_CUTOFF_TOD) break;

    // DLL check: stop if we've hit the limit
    if (dayPnL <= -DLL) break;

    // Max trades check
    if (trades.length >= maxTrades) break;

    const pastIB = bar.tod >= 630;
    // Merge today's IB levels once IB has closed
    const activeIB = pastIB ? todayIB : {};
    const allLevels = pastIB ? { ...levels, ...activeIB } : levels;

    // Check each level for first touch
    for (const [levelName, levelPrice] of Object.entries(allLevels)) {
      if (levelPrice == null || !isFinite(levelPrice)) continue;

      // OR levels only available after OR close at 10:00 (tod >= 600)
      if ((levelName === 'OR_HIGH' || levelName === 'OR_LOW' || levelName === 'OR_MID') && bar.tod < 600) continue;

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
  console.log(`Parameters: ${FADE_TARGET}pt target, ${FADE_STOP_BASE}pt stop, ${PROXIMITY}pt proximity`);
  console.log(`Risk model: ${RISK_PCT*100}% of account per trade, starting at $${STARTING_ACCOUNT}`);
  console.log(`Risk model: ${RISK_PCT*100}% of account per trade, starting at $${STARTING_ACCOUNT}`);
  console.log(`Contract range: ${MIN_CONTRACTS}–${MAX_CONTRACTS} MNQ ($${RISK_PER_CONTRACT}/contract risk), DLL: $${DLL}`);
  console.log();

  const { allDays, testDays, levelsByDate, barsByDate, sessionByDate } = await loadAllData();

  // Pre-compute ATR data
  const trByDate = computeDailyATR(allDays, sessionByDate);

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
  let account = STARTING_ACCOUNT; // tracks total account for sizing

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
    const regime = classifyRegime(dayIdx, allDays, trByDate, sessionByDate);
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
    const levels = computeLevels(day, levelsByDate);
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

    // Dynamic position sizing: 1% of account, capped by DLL
    account = STARTING_ACCOUNT + cumPnL;
    CONTRACTS = computeContracts(account);
    PNL_PER_POINT = 2 * CONTRACTS;
    COMMISSION = 1 * CONTRACTS;
    FADE_STOP = FADE_STOP_BASE;

    // Step 4a: Execute trades WITH regime filter
    const { trades: dayTrades, dayPnL } = executeTrades(
      bars, { ...levels }, rankings, regime, day, MAX_TRADES, levelsByDate
    );

    // Step 4b: Execute trades WITHOUT regime filter (comparison)
    const noFilterRankings = new Map();
    const { trades: dayTradesNoFilter, dayPnL: dayPnLNoFilter } = executeTrades(
      bars, { ...levels }, noFilterRankings, regime, day, MAX_TRADES, levelsByDate
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
