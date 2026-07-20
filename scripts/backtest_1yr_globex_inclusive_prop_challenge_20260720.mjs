import { query } from '../server/db.js';
import { resolve } from '../scripts/backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { recordClaim } from '../scripts/record_claim.mjs';
import fs from 'fs';

const DLL_LEVELS = [200, 400, 600];
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;

async function run() {
  console.log('Starting 1-Year Globex-Inclusive Prop Challenge...');

  const maxDateRow = await query(`SELECT MAX(trade_date)::text as max_date FROM active_setups`);
  const maxDate = maxDateRow.rows[0].max_date;

  const daysQ = await query(`
    SELECT DISTINCT s.trade_date::text as trade_date, dl.day_type
    FROM active_setups s
    LEFT JOIN acd_daily_log dl ON dl.trade_date = s.trade_date
    WHERE s.trade_date >= $1::date - interval '365 days' AND s.trade_date <= $1::date
    ORDER BY trade_date ASC
  `, [maxDate]);
  const tradingDays = daysQ.rows;
  
  if (tradingDays.length === 0) {
    console.error("No trading days found");
    return;
  }
  
  const startDateStr = tradingDays[0].trade_date;
  console.log(`Window: ${startDateStr} to ${maxDate} (${tradingDays.length} days)`);

  // --- 1. RTH LEG: Load Setup Status & Trades ---
  console.log('Loading CURRENT_VALIDATED_ROSTER for RTH...');
  const rosterQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, recommendation
    FROM performance_audit 
    WHERE signal_type = 'SETUP_STATUS'
    ORDER BY signal_name, run_date DESC
  `);
  
  const currentRoster = new Set();
  for (const r of rosterQ.rows) {
    if (r.recommendation !== 'SUPPRESS' && r.recommendation !== 'THIN_N') {
      currentRoster.add(r.setup_type);
    }
  }

  console.log('Loading RTH Trades...');
  const rthTradesQ = await query(`
    SELECT s.trade_date::text as trade_date, s.setup_type, s.actual_pnl::float as actual_pnl,
           s.size_multiplier::float as size_multiplier, s.fired_at, dl.day_type,
           s.mae_points::float as mae_points, s.mfe_points::float as mfe_points,
           s.resolution, s.origin_status
    FROM active_setups s
    LEFT JOIN acd_daily_log dl ON s.trade_date = dl.trade_date
    WHERE s.actual_pnl IS NOT NULL AND s.resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND (s.mae_points IS NULL OR s.mae_points <= 300) AND (s.mfe_points IS NULL OR s.mfe_points <= 300)
    ORDER BY s.trade_date ASC, s.fired_at ASC
  `);
  const allRthTrades = rthTradesQ.rows;

  const DAY_TYPE_CONDITIONAL = new Set(['IB_BULLISH', 'IB_BEARISH']);
  
  // Need entire history for RTH rolling stats
  const rthTradesByDate = {};
  for (const t of allRthTrades) {
    if (!rthTradesByDate[t.trade_date]) rthTradesByDate[t.trade_date] = [];
    rthTradesByDate[t.trade_date].push(t);
  }
  
  const rthHistoryByDate = {};
  let currentRthHistory = [];
  const uniqueRthDates = [...new Set(allRthTrades.map(t => t.trade_date))].sort();
  for (const d of uniqueRthDates) {
    rthHistoryByDate[d] = [...currentRthHistory];
    currentRthHistory.push(...rthTradesByDate[d]);
  }
  const getRthHistoryForDate = (date) => {
    let latestBefore = null;
    for (const d of uniqueRthDates) {
      if (d < date) latestBefore = d; else break;
    }
    if (!latestBefore) return [];
    return rthHistoryByDate[latestBefore].concat(rthTradesByDate[latestBefore] || []);
  };

  const windowRthTrades = allRthTrades.filter(t => t.trade_date >= startDateStr && t.trade_date <= maxDate);
  
  // --- 2. GLOBEX LEG: Load Overnight Optimal Stops & Touch Simulation ---
  console.log('Loading OVERNIGHT_OPTIMAL_STOP calibrations...');
  const overnightCalibQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target
    FROM performance_audit
    WHERE signal_type = 'OVERNIGHT_OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const overnightCalibs = new Map();
  for (const r of overnightCalibQ.rows) {
    overnightCalibs.set(r.signal_name, { stop: r.optimal_stop, target: r.optimal_target });
  }

  console.log('Loading level and bar data for Globex simulation...');
  const lvlRes = await query(`
    SELECT trade_date::text as d, level_name, price::float as price 
    FROM level_prices 
    WHERE trade_date >= $1::date - interval '365 days' AND trade_date <= $1::date
  `, [maxDate]);
  
  const levelsByDate = new Map();
  for (const r of lvlRes.rows) {
    if (EXCLUDED.has(r.level_name)) continue;
    if (!levelsByDate.has(r.d)) levelsByDate.set(r.d, {});
    levelsByDate.get(r.d)[r.level_name] = r.price;
  }
  const levelNames = [...new Set(lvlRes.rows.map(r => r.level_name).filter(n => !EXCLUDED.has(n)))];
  const dates = [...levelsByDate.keys()].sort();
  
  const barsRes = await query(`
    SELECT ts, ts::date::text as d, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      high::float as high, low::float as low, close::float as close
    FROM price_bars_primary 
    WHERE symbol='NQ' AND ts >= $1::date - interval '367 days'
    ORDER BY ts ASC
  `, [maxDate]);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));

  function firstIdxAtOrAfter(dateStr, todMin) {
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i;
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  const dayInfo = [];
  for (const d of dates) {
    const startIdx = firstIdxAtOrAfter(d, RTH_START);
    if (startIdx <= 0) continue;
    let rthEndIdx = allBars.length;
    for (let i = startIdx; i < allBars.length; i++) {
      if (allBars[i].d > d || (allBars[i].d === d && allBars[i].tod >= RTH_END)) { rthEndIdx = i; break; }
    }
    const wideStartTs = allBars[startIdx].ts - 15.5 * 3600 * 1000;
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts < wideStartTs) lo = mid + 1; else hi = mid; }
    const wideStartIdx = Math.max(lo, 1);

    dayInfo.push({ d, startIdx, rthEndIdx, wideStartIdx });
  }

  console.log('Simulating overnight trades...');
  const allGlobexTrades = [];
  for (const x of dayInfo) {
    const lv = levelsByDate.get(x.d);
    if (!lv) continue;
    const isMonday = new Date(x.d + 'T12:00:00').getDay() === 1;
    const defaultStop = isMonday ? 60 : 90, defaultTarget = isMonday ? 30 : 40;

    for (const name of levelNames) {
      const lvl = lv[name];
      if (lvl == null) continue;
      for (let i = x.wideStartIdx + 1; i < x.startIdx; i++) {
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lvl) > 15) continue;
        const dir = prev.close > lvl ? 'SHORT' : 'LONG';
        const long = dir === 'LONG';
        const entry = b.close;
        const comboName = `${name}_${dir}`;
        
        let stopPts = defaultStop;
        let targetPts = defaultTarget;
        const calib = overnightCalibs.get(comboName);
        if (calib) {
          stopPts = calib.stop;
          targetPts = calib.target;
        }
        
        const stopPrice = long ? entry - stopPts : entry + stopPts;
        const targetPrice = long ? entry + targetPts : entry - targetPts;
        
        const r = resolve(allBars, i, dir, entry, stopPrice, targetPrice, x.rthEndIdx - i);
        const pnl = r.result === 'TARGET_HIT' ? targetPts * PNL_PER_POINT - COMMISSION
          : r.result === 'STOP_HIT' ? -(stopPts * PNL_PER_POINT + COMMISSION) : r.pnl;
        
        allGlobexTrades.push({
          trade_date: x.d,
          fired_at: new Date(b.ts),
          setup_type: comboName,
          actual_pnl: pnl,
          is_globex: true
        });
        break; 
      }
    }
  }
  
  const globexTradesByDate = {};
  for (const t of allGlobexTrades) {
    if (!globexTradesByDate[t.trade_date]) globexTradesByDate[t.trade_date] = [];
    globexTradesByDate[t.trade_date].push(t);
  }
  
  const globexHistoryByDate = {};
  let currentGlobexHistory = [];
  const uniqueGlobexDates = [...new Set(allGlobexTrades.map(t => t.trade_date))].sort();
  for (const d of uniqueGlobexDates) {
    globexHistoryByDate[d] = [...currentGlobexHistory];
    currentGlobexHistory.push(...globexTradesByDate[d]);
  }
  const getGlobexHistoryForDate = (date) => {
    let latestBefore = null;
    for (const d of uniqueGlobexDates) {
      if (d < date) latestBefore = d; else break;
    }
    if (!latestBefore) return [];
    return globexHistoryByDate[latestBefore].concat(globexTradesByDate[latestBefore] || []);
  };

  console.log(`Found ${windowRthTrades.length} RTH trades and ${allGlobexTrades.length} Globex trades in the 1-year window.`);

  const combinedTradesByDate = {};
  for (const dRow of tradingDays) {
    const d = dRow.trade_date;
    const rth = (rthTradesByDate[d] || []).filter(t => t.trade_date >= startDateStr);
    const globex = globexTradesByDate[d] || [];
    const combined = [...rth, ...globex];
    combined.sort((a, b) => new Date(a.fired_at).getTime() - new Date(b.fired_at).getTime());
    combinedTradesByDate[d] = combined;
  }

  // --- 3. Day Loop Simulation ---
  const createStats = () => ({
    totalPnl: 0, rthPnl: 0, globexPnl: 0,
    totalTrades: 0, rthTrades: 0, globexTrades: 0,
    lockoutDays: 0, maxDrawdown: 0, peakPnl: 0,
    rthWins: 0, globexWins: 0
  });

  const updateStats = (stats, t, sizedPnl) => {
    stats.totalPnl += sizedPnl;
    stats.totalTrades++;
    
    if (t.is_globex) {
      stats.globexPnl += sizedPnl;
      stats.globexTrades++;
      if (sizedPnl > 0) stats.globexWins++;
    } else {
      stats.rthPnl += sizedPnl;
      stats.rthTrades++;
      if (sizedPnl > 0) stats.rthWins++;
    }
    
    if (stats.totalPnl > stats.peakPnl) stats.peakPnl = stats.totalPnl;
    const dd = stats.peakPnl - stats.totalPnl;
    if (dd > stats.maxDrawdown) stats.maxDrawdown = dd;
  };

  const results = {};
  const runKeys = [];
  for (const scenario of ['LEGACY', 'ROSTER']) {
    for (const globexEnabled of [false, true]) {
      for (const dll of DLL_LEVELS) {
        const key = `${scenario}_GLOBEX_${globexEnabled ? 'IN' : 'OUT'}_${dll}`;
        results[key] = createStats();
        runKeys.push(key);
      }
    }
  }

  for (const dRow of tradingDays) {
    const todayStr = dRow.trade_date;
    const todayType = dRow.day_type;
    const rthHist = getRthHistoryForDate(todayStr);
    const globexHist = getGlobexHistoryForDate(todayStr);

    const rthStats = {};
    const rthDtStats = {};
    for (const t of rthHist) {
      if (!rthStats[t.setup_type]) rthStats[t.setup_type] = { n: 0, pnl: 0 };
      rthStats[t.setup_type].n++;
      rthStats[t.setup_type].pnl += t.actual_pnl;

      if (DAY_TYPE_CONDITIONAL.has(t.setup_type)) {
        if (!rthDtStats[t.setup_type]) rthDtStats[t.setup_type] = {};
        if (!rthDtStats[t.setup_type][t.day_type]) rthDtStats[t.setup_type][t.day_type] = { n: 0, pnl: 0 };
        rthDtStats[t.setup_type][t.day_type].n++;
        rthDtStats[t.setup_type][t.day_type].pnl += t.actual_pnl;
      }
    }
    const legacyEligibleSetups = new Set();
    for (const setup in rthStats) {
      if (DAY_TYPE_CONDITIONAL.has(setup)) {
        const buckets = rthDtStats[setup] || {};
        const validBuckets = Object.values(buckets).filter(b => b.n >= 20);
        const anyGoodBucket = validBuckets.some(b => (b.pnl / b.n) >= -5);
        if (validBuckets.length > 0 && !anyGoodBucket) continue;
        const tBucket = buckets[todayType];
        if (tBucket && tBucket.n >= 20 && (tBucket.pnl / tBucket.n) >= -5) legacyEligibleSetups.add(setup);
      } else {
        const n = rthStats[setup].n;
        const ev = rthStats[setup].pnl / n;
        if (n >= 20 && ev >= -5) legacyEligibleSetups.add(setup);
      }
    }

    const rosterEligibleSetups = new Set();
    for (const setup of currentRoster) {
      if (DAY_TYPE_CONDITIONAL.has(setup)) {
        if (legacyEligibleSetups.has(setup)) rosterEligibleSetups.add(setup);
      } else {
        rosterEligibleSetups.add(setup);
      }
    }

    const globexStats = {};
    for (const t of globexHist) {
      if (!globexStats[t.setup_type]) globexStats[t.setup_type] = { n: 0, pnl: 0 };
      globexStats[t.setup_type].n++;
      globexStats[t.setup_type].pnl += t.actual_pnl;
    }
    const globexEligibleSetups = new Set();
    for (const setup in globexStats) {
      const n = globexStats[setup].n;
      const ev = globexStats[setup].pnl / n;
      if (n >= 20 && ev >= -5) globexEligibleSetups.add(setup);
    }

    const todaysTrades = combinedTradesByDate[todayStr] || [];

    for (const rKey of runKeys) {
      const [scenario, , globexMode, dllStr] = rKey.split('_');
      const includeGlobex = globexMode === 'IN';
      const dll = parseInt(dllStr);
      
      let dayPnl = 0, isLocked = false;
      const stats = results[rKey];
      
      for (const t of todaysTrades) {
        if (isLocked) continue;
        
        let eligible = false;
        if (t.is_globex) {
          if (!includeGlobex) continue;
          if (globexEligibleSetups.has(t.setup_type)) eligible = true;
        } else {
          if (scenario === 'LEGACY' && legacyEligibleSetups.has(t.setup_type)) eligible = true;
          if (scenario === 'ROSTER' && rosterEligibleSetups.has(t.setup_type)) eligible = true;
        }
        
        if (!eligible) continue;

        const sizedPnl = t.actual_pnl * (t.is_globex ? 1.0 : (t.size_multiplier || 1.0));
        dayPnl += sizedPnl;
        updateStats(stats, t, sizedPnl);

        if (dayPnl <= -dll) {
          isLocked = true;
          stats.lockoutDays++;
        }
      }
    }
  }

  let report = `# 1-Year Globex-Inclusive Prop Challenge
**Window:** ${startDateStr} to ${maxDate} (${tradingDays.length} trading days)

> [!WARNING]
> This is a HYBRID result. The RTH leg reflects real historical trade outcomes (which are mostly BACKFILL-origin, with known caveats). The Globex leg is a pure bar-walk simulation that has NEVER fired live (except 4 thin setup types). The two are merged to test DLL interactions, but do not mistake the combined result for purely "real" trading history.

## Performance by Scenario & DLL

| RTH Scenario | Globex | DLL | Total P&L | Trades | Combined Win Rate | Max Drawdown | Lockout Days |
|---|---|---|---|---|---|---|---|
`;

  for (const rKey of runKeys) {
    const s = results[rKey];
    const [scenario, , globexMode, dllStr] = rKey.split('_');
    const name = scenario === 'LEGACY' ? 'LEGACY_ROLLING' : 'CURRENT_VALIDATED_ROSTER';
    const totalWr = s.totalTrades > 0 ? (s.rthWins + s.globexWins) / s.totalTrades * 100 : 0;
    report += `| ${name} | ${globexMode === 'IN' ? 'Included' : 'Excluded'} | $${dllStr} | $${s.totalPnl.toFixed(2)} | ${s.totalTrades} | ${totalWr.toFixed(1)}% | $${s.maxDrawdown.toFixed(2)} | ${s.lockoutDays} |\n`;
  }

  report += `\n## Component Breakdown (Globex Included Runs)\n\n`;
  report += `| Scenario | DLL | RTH P&L | RTH Trades | Globex P&L | Globex Trades | Globex Win Rate |\n|---|---|---|---|---|---|---|\n`;
  
  for (const rKey of runKeys) {
    if (rKey.includes('GLOBEX_OUT')) continue;
    const s = results[rKey];
    const [scenario, , , dllStr] = rKey.split('_');
    const name = scenario === 'LEGACY' ? 'LEGACY_ROLLING' : 'CURRENT_VALIDATED_ROSTER';
    const gWr = s.globexTrades > 0 ? s.globexWins / s.globexTrades * 100 : 0;
    report += `| ${name} | $${dllStr} | $${s.rthPnl.toFixed(2)} | ${s.rthTrades} | $${s.globexPnl.toFixed(2)} | ${s.globexTrades} | ${gWr.toFixed(1)}% |\n`;
  }

  fs.writeFileSync('scratch/backtest_1yr_globex_inclusive_prop_challenge_RESULTS.md', report);
  
  console.log('Results written to scratch/backtest_1yr_globex_inclusive_prop_challenge_RESULTS.md');
  
  const bestRun = results['ROSTER_GLOBEX_IN_400']; // Example benchmark
  
  await recordClaim({
    slug: 'GLOBEX_INCLUSIVE_1YR_PROP',
    claimText: `Combined 1-year prop simulation mixing real RTH history and simulated Globex (priced via OVERNIGHT_OPTIMAL_STOP). Globex leg adds independent P&L but shares daily DLL limit. See scratch/backtest_1yr_globex_inclusive_prop_challenge_RESULTS.md for full matrix.`,
    sourceFile: 'scripts/backtest_1yr_globex_inclusive_prop_challenge_20260720.mjs',
    sampleSize: bestRun.totalTrades,
    winRate: bestRun.totalTrades > 0 ? (bestRun.rthWins + bestRun.globexWins) / bestRun.totalTrades : null,
    evPerTrade: bestRun.totalTrades > 0 ? bestRun.totalPnl / bestRun.totalTrades : null
  });

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
