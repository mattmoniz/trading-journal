import { query } from '../db.js';

const DEFAULT_CONFIG = {
  account: { startingBalance: 2000, pointValue: 2, commission: 0.50, maxContracts: 20, dailyLossLimit: 400, trailingDrawdown: 1500, drawdownFreezeProfit: 3000 },
  sizing: { riskPctPerTrade: 0.015, maxRiskPct: 0.05, stopOverride: null, postLossReduction: 0.5, convictionScaling: true },
  simulation: { runs: 5000, method: 'BOOTSTRAP' },
  dateRange: { start: '2025-06-18', end: null },
};

function getDLL(balance) {
  if (balance >= 20000) return 2000;
  if (balance >= 10000) return 1200;
  if (balance >= 6000) return 800;
  if (balance >= 4000) return 600;
  return 400;
}

function simulateRun(tradePool, config) {
  const { startingBalance, pointValue, commission, maxContracts, trailingDrawdown, drawdownFreezeProfit } = config.account;
  let balance = startingBalance, peak = startingBalance, ddFloor = startingBalance - trailingDrawdown;
  let ddFrozen = false, blown = false, maxDD = 0, tradesExec = 0, dllHits = 0;
  let prevLoss = false, dayPnl = 0, currentDay = -1;
  const equityCurve = [startingBalance];

  const tradeCount = tradePool.length;
  for (let i = 0; i < tradeCount; i++) {
    const idx = config.simulation.method === 'BOOTSTRAP'
      ? Math.floor(Math.random() * tradePool.length)
      : i;
    const trade = tradePool[idx];

    const simDay = Math.floor(i / 3);
    if (simDay !== currentDay) { dayPnl = 0; currentDay = simDay; prevLoss = false; }

    const dll = getDLL(balance);
    if (dayPnl <= -dll) { dllHits++; continue; }

    const stopPts = config.sizing.stopOverride || trade.stopDist || 50;
    const riskPerCt = stopPts * pointValue + commission;
    let baseCts = Math.floor(Math.min(balance * config.sizing.riskPctPerTrade, Math.max(riskPerCt, (dll + dayPnl) * 0.6)) / riskPerCt);

    let multi = 1.0;
    if (prevLoss && config.sizing.postLossReduction) multi *= config.sizing.postLossReduction;
    if (config.sizing.convictionScaling && trade.conviction) {
      const convMulti = { MAXIMUM: 2.0, VERY_HIGH: 1.8, HIGH: 1.5, MODERATE: 1.0, STANDARD: 1.0, LOW: 0.5 };
      multi *= convMulti[trade.conviction] || 1.0;
    }

    let contracts = Math.max(1, Math.min(maxContracts, Math.round(baseCts * multi)));
    if (contracts * riskPerCt > balance * config.sizing.maxRiskPct) contracts = Math.max(1, Math.floor(balance * config.sizing.maxRiskPct / riskPerCt));
    if (balance < 500) contracts = 1;

    let tradePnl;
    if (trade.win) {
      tradePnl = trade.winPts * pointValue * contracts - commission * contracts;
      prevLoss = false;
    } else {
      const lossPts = config.sizing.stopOverride ? config.sizing.stopOverride : trade.lossPts;
      tradePnl = -lossPts * pointValue * contracts - commission * contracts;
      prevLoss = true;
    }

    balance += tradePnl;
    dayPnl += tradePnl;
    tradesExec++;

    if (balance > peak) peak = balance;
    if (!ddFrozen) {
      ddFloor = peak - trailingDrawdown;
      if (peak - startingBalance >= drawdownFreezeProfit) { ddFrozen = true; ddFloor = peak - trailingDrawdown; }
    }
    const dd = peak - balance;
    if (dd > maxDD) maxDD = dd;

    equityCurve.push(Math.round(balance));

    if (balance <= ddFloor) { blown = true; break; }
  }

  return { final: Math.round(balance), peak: Math.round(peak), maxDD: Math.round(maxDD), blown, ddFrozen, tradesExec, dllHits, equityCurve };
}

export async function loadAndTagTrades(config) {
  const dateEnd = config.dateRange?.end || '2099-12-31';
  const dateStart = config.dateRange?.start || '2024-01-01';

  const [tradesQ, nlQ, arQ, vaQ, pd2Q] = await Promise.all([
    query(`SELECT s.setup_type, s.resolution, s.actual_pnl::float as pnl, s.trade_date::text as d,
      s.entry_zone_low::float as entry, s.stop_level::float as stop,
      CASE WHEN s.setup_type LIKE '%LONG%' OR s.setup_type LIKE '%BULLISH%' OR s.setup_type LIKE '%_UP' THEN 'LONG' ELSE 'SHORT' END as dir,
      a.or_high::float - a.or_low::float as or_width, a.day_type
    FROM active_setups s LEFT JOIN acd_daily_log a ON a.trade_date=s.trade_date
    WHERE s.resolution IN ('TARGET_HIT','STOP_HIT') AND s.entry_zone_low IS NOT NULL
      AND s.trade_date BETWEEN $1 AND $2
    ORDER BY s.trade_date`, [dateStart, dateEnd]),
    query(`SELECT trade_date::text as d, SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30 FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date`),
    query(`SELECT trade_date::text as d, overnight_inventory as inv, open_vs_prior_value as ovp FROM auction_reads`),
    query(`SELECT trade_date::text as d, migration_dir_vs_prior as mig FROM developing_value_log ORDER BY trade_date`),
    query(`SELECT trade_date::text as d, vah::float, val::float FROM developing_value_log ORDER BY trade_date`),
  ]);

  const nlMap = {}; for (const r of nlQ.rows) nlMap[r.d] = parseInt(r.nl30) || 0;
  const arMap = {}; for (const r of arQ.rows) arMap[r.d] = r;
  const migMap = {}; const vaArr = vaQ.rows;
  for (let i = 2; i < vaArr.length; i++) { if (vaArr[i-1].mig === vaArr[i].mig) migMap[vaArr[i].d] = vaArr[i].mig; }
  const pd2Map = {}; const pd2Arr = pd2Q.rows;
  for (let i = 2; i < pd2Arr.length; i++) pd2Map[pd2Arr[i].d] = { vah: pd2Arr[i-2].vah, val: pd2Arr[i-2].val };

  return tradesQ.rows.map(t => {
    const nl = nlMap[t.d] || 0;
    const ar = arMap[t.d] || {};
    const isLong = t.dir === 'LONG';
    const nl30State = nl > 9 ? 'BULLISH' : nl < -9 ? 'BEARISH' : 'RANGING';
    const nl30Counter = (isLong && nl30State === 'BEARISH') || (!isLong && nl30State === 'BULLISH');
    const overnightCounter = (isLong && (ar.inv === 'LONG_TRAPPED' || ar.ovp === 'BELOW_VALUE')) || (!isLong && (ar.inv === 'SHORT_TRAPPED' || ar.ovp === 'ABOVE_VALUE'));
    const overnightAligned = (isLong && (ar.inv === 'SHORT_TRAPPED' || ar.ovp === 'ABOVE_VALUE')) || (!isLong && (ar.inv === 'LONG_TRAPPED' || ar.ovp === 'BELOW_VALUE'));
    const pocCounter = migMap[t.d] && ((isLong && migMap[t.d] === 'LOWER') || (!isLong && migMap[t.d] === 'HIGHER'));
    const pd2 = pd2Map[t.d];
    const nearPD2 = pd2 && t.entry && (Math.abs(t.entry - pd2.vah) <= 25 || Math.abs(t.entry - pd2.val) <= 25);
    const wideOR = t.or_width && t.or_width > 91.5;
    const doubleHeadwind = nl30Counter && overnightCounter;
    const align = overnightAligned ? 'ALIGNED' : overnightCounter ? 'COUNTER' : 'NEUTRAL';
    const isTurbulent = t.day_type === 'TURBULENT';

    let conviction = 'STANDARD';
    if (align === 'ALIGNED' && isTurbulent) conviction = 'MAXIMUM';
    else if (align === 'ALIGNED' && t.day_type === 'TREND') conviction = 'MODERATE';
    else if (align === 'ALIGNED' && t.day_type === 'BALANCE') conviction = 'MODERATE';
    else if (align === 'COUNTER' && t.day_type === 'BALANCE') conviction = 'LOW';
    else if (align === 'COUNTER' && t.day_type === 'TREND') conviction = 'LOW';

    const stopDist = t.stop ? Math.abs(t.entry - t.stop) : 50;
    const win = t.resolution === 'TARGET_HIT';
    const winPts = win ? Math.abs(t.pnl / 5) : 0;
    const lossPts = !win ? stopDist : 0;

    return {
      setup_type: t.setup_type, d: t.d, dir: t.dir, win, winPts, lossPts, stopDist, pnl: t.pnl,
      nl30Counter, overnightCounter, overnightAligned, pocCounter, nearPD2, wideOR, doubleHeadwind,
      align, isTurbulent, dayType: t.day_type, conviction,
    };
  });
}

const FILTER_DEFS = {
  nl30Counter: t => !t.nl30Counter,
  doubleHeadwind: t => !t.doubleHeadwind,
  pocMigration: t => !t.pocCounter,
  pd2Gate: t => t.nearPD2,
  wideORSuppressTRT: t => !(t.wideOR && t.setup_type === 'TRT_LONG'),
  overnightCounter: t => !t.overnightCounter,
  turbulentOnly: t => t.isTurbulent,
  tripleStackAvoid: t => {
    if ((t.align === 'COUNTER') && (t.dayType === 'TREND')) return false;
    if ((t.align === 'COUNTER') && (t.dayType === 'BALANCE') && t.wideOR) return false;
    return true;
  },
};

export function applyFilters(trades, filterConfig) {
  let filtered = [...trades];
  for (const [name, enabled] of Object.entries(filterConfig)) {
    if (enabled && FILTER_DEFS[name]) {
      filtered = filtered.filter(FILTER_DEFS[name]);
    }
  }
  return filtered;
}

export async function runMonteCarlo(userConfig = {}) {
  const config = {
    account: { ...DEFAULT_CONFIG.account, ...userConfig.account },
    sizing: { ...DEFAULT_CONFIG.sizing, ...userConfig.sizing },
    simulation: { ...DEFAULT_CONFIG.simulation, ...userConfig.simulation },
    dateRange: { ...DEFAULT_CONFIG.dateRange, ...userConfig.dateRange },
    setups: userConfig.setups || { mode: 'ALL' },
    filters: userConfig.filters || {},
  };

  const allTrades = await loadAndTagTrades(config);

  let trades = allTrades;
  if (config.setups.mode === 'CUSTOM' && config.setups.include) {
    const includeSet = new Set(config.setups.include);
    trades = trades.filter(t => includeSet.has(t.setup_type));
  }

  trades = applyFilters(trades, config.filters);

  if (trades.length < 3) return { error: 'Not enough trades after filtering', tradesAvailable: allTrades.length, tradesAfterFilter: trades.length };

  if (config.simulation.method === 'SHUFFLE') {
    for (let i = trades.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [trades[i], trades[j]] = [trades[j], trades[i]];
    }
  }

  const results = [];
  for (let r = 0; r < config.simulation.runs; r++) {
    results.push(simulateRun(trades, config));
  }

  const finals = results.map(r => r.final).sort((a, b) => a - b);
  const maxDDs = results.map(r => r.maxDD).sort((a, b) => a - b);
  const blownCount = results.filter(r => r.blown).length;
  const pct = (p) => finals[Math.floor(p / 100 * results.length)] || 0;
  const ddPct = (p) => maxDDs[Math.floor(p / 100 * results.length)] || 0;

  const setupBreakdown = {};
  for (const t of trades) {
    if (!setupBreakdown[t.setup_type]) setupBreakdown[t.setup_type] = { n: 0, w: 0, pnl: 0 };
    setupBreakdown[t.setup_type].n++;
    if (t.win) setupBreakdown[t.setup_type].w++;
    setupBreakdown[t.setup_type].pnl += t.pnl / 5 * config.account.pointValue;
  }

  const convBreakdown = {};
  for (const t of trades) {
    if (!convBreakdown[t.conviction]) convBreakdown[t.conviction] = { n: 0, w: 0 };
    convBreakdown[t.conviction].n++;
    if (t.win) convBreakdown[t.conviction].w++;
  }

  const sampleCurves = results.slice(0, 20).map(r => r.equityCurve);

  const summary = {
    runs: config.simulation.runs,
    tradesInPool: trades.length,
    method: config.simulation.method,
    startingBalance: config.account.startingBalance,

    median: pct(50), mean: Math.round(finals.reduce((s, v) => s + v, 0) / finals.length),
    p1: pct(1), p5: pct(5), p10: pct(10), p25: pct(25), p75: pct(75), p90: pct(90), p95: pct(95), p99: pct(99),
    min: finals[0], max: finals[finals.length - 1],

    survivalRate: ((results.length - blownCount) / results.length * 100).toFixed(1),
    blowUpRate: (blownCount / results.length * 100).toFixed(1),
    blownCount,

    avgMaxDD: Math.round(maxDDs.reduce((s, v) => s + v, 0) / maxDDs.length),
    medianMaxDD: ddPct(50), p95MaxDD: ddPct(95),

    medianReturn: ((pct(50) / config.account.startingBalance - 1) * 100).toFixed(0),
    avgReturn: ((finals.reduce((s, v) => s + v, 0) / finals.length / config.account.startingBalance - 1) * 100).toFixed(0),

    setupBreakdown,
    convBreakdown,
  };

  return { config, summary, equityDistribution: finals, drawdownDistribution: maxDDs, sampleCurves };
}

export async function runOptimizer(userConfig = {}) {
  const config = {
    account: { ...DEFAULT_CONFIG.account, ...userConfig.account },
    sizing: { ...DEFAULT_CONFIG.sizing, ...userConfig.sizing },
    simulation: { runs: 1000, method: 'BOOTSTRAP' },
    dateRange: { ...DEFAULT_CONFIG.dateRange, ...userConfig.dateRange },
  };

  const allTrades = await loadAndTagTrades(config);
  const setupTypes = [...new Set(allTrades.map(t => t.setup_type))];
  const filterNames = Object.keys(FILTER_DEFS);

  const results = [];

  for (const type of setupTypes) {
    const typeTrades = allTrades.filter(t => t.setup_type === type);
    if (typeTrades.length < 5) continue;

    let bestNet = -Infinity, bestFilters = {}, bestN = 0, bestWR = 0;

    for (let mask = 0; mask < (1 << filterNames.length); mask++) {
      const filterConfig = {};
      for (let i = 0; i < filterNames.length; i++) {
        filterConfig[filterNames[i]] = !!(mask & (1 << i));
      }

      let filtered = typeTrades;
      for (const [name, enabled] of Object.entries(filterConfig)) {
        if (enabled && FILTER_DEFS[name]) filtered = filtered.filter(FILTER_DEFS[name]);
      }
      if (filtered.length < 3) continue;

      const net = filtered.reduce((s, t) => s + t.pnl / 5 * config.account.pointValue, 0);
      if (net > bestNet) {
        bestNet = net;
        bestFilters = filterConfig;
        bestN = filtered.length;
        bestWR = filtered.filter(t => t.win).length / filtered.length;
      }
    }

    if (bestNet > 0 && bestN >= 3) {
      const activeFilters = Object.entries(bestFilters).filter(([, v]) => v).map(([k]) => k);
      results.push({ setup: type, filters: activeFilters, n: bestN, wr: bestWR, netPnl: Math.round(bestNet), perTrade: Math.round(bestNet / bestN) });
    }
  }

  results.sort((a, b) => b.netPnl - a.netPnl);
  return { setupTypes: setupTypes.length, totalTrades: allTrades.length, profitableConfigs: results };
}
