import { query } from '../db.js';

// ═══════════════════════════════════════════════════════════════════
// MONTE CARLO V2 — Full spec implementation
// Three trade sources: pipeline setups, edge signals, level trades
// Daily block bootstrapping, MAE-aware stop override, triple stack
// ═══════════════════════════════════════════════════════════════════

function getDLL(balance) {
  if (balance >= 20000) return 2000;
  if (balance >= 10000) return 1200;
  if (balance >= 6000) return 800;
  if (balance >= 4000) return 600;
  return 400;
}

// ─── SIMULATION ENGINE ─────────────────────────────────────────────

function simulateRun(tradeDays, config, shuffle = true) {
  const { startingBalance, pointValue, commission, maxContracts, trailingDrawdown, drawdownFreezeProfit } = config.account;
  let balance = startingBalance, peak = startingBalance, ddFloor = startingBalance - trailingDrawdown;
  let ddFrozen = false, blown = false, maxDD = 0, tradesExec = 0, dllHits = 0;
  const equityCurve = [startingBalance];

  const days = shuffle ? [...tradeDays].sort(() => Math.random() - 0.5) : tradeDays;

  for (const dayTrades of days) {
    if (blown) break;
    let dayPnl = 0, prevLoss = false;
    const dll = getDLL(balance);

    for (const trade of dayTrades) {
      if (blown) break;
      if (dayPnl <= -dll) { dllHits++; break; }

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
      const dllRemaining = dll + dayPnl;
      if (contracts * riskPerCt > dllRemaining && dllRemaining > 0) contracts = Math.max(1, Math.floor(dllRemaining / riskPerCt));
      if (balance < 500) contracts = 1;

      let tradePnl;
      if (trade.win) {
        // MAE check: if stop override is tighter than actual MAE, this would have stopped out
        if (config.sizing.stopOverride && trade.mae && trade.mae > config.sizing.stopOverride) {
          tradePnl = -config.sizing.stopOverride * pointValue * contracts - commission * contracts;
          prevLoss = true;
        } else {
          tradePnl = trade.winPts * pointValue * contracts - commission * contracts;
          prevLoss = false;
        }
      } else {
        const lossPts = config.sizing.stopOverride ? Math.min(config.sizing.stopOverride, trade.lossPts) : trade.lossPts;
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
  }

  return { final: Math.round(balance), peak: Math.round(peak), maxDD: Math.round(maxDD), blown, ddFrozen, tradesExec, dllHits, equityCurve };
}

// ─── DATA LOADERS ───────────────────────────────────────────────────

export async function loadAndTagTrades(config) {
  const dateEnd = config.dateRange?.end || '2099-12-31';
  const dateStart = config.dateRange?.start || '2024-01-01';

  const [tradesQ, nlQ, arQ, vaQ, pd2Q, barsQ] = await Promise.all([
    query(`SELECT s.setup_type, s.resolution, s.actual_pnl::float as pnl, s.trade_date::text as d,
      s.entry_zone_low::float as entry, s.stop_level::float as stop, s.t1_level::float as t1,
      CASE WHEN s.setup_type LIKE '%LONG%' OR s.setup_type LIKE '%BULLISH%' OR s.setup_type LIKE '%_UP' THEN 'LONG' ELSE 'SHORT' END as dir,
      a.or_high::float - a.or_low::float as or_width, a.day_type, a.or_high::float as orH, a.or_low::float as orL,
      (EXTRACT(hour FROM s.fired_at)*60+EXTRACT(minute FROM s.fired_at))::int as fired_min
    FROM active_setups s LEFT JOIN acd_daily_log a ON a.trade_date=s.trade_date
    WHERE s.resolution IN ('TARGET_HIT','STOP_HIT') AND s.entry_zone_low IS NOT NULL
      AND s.trade_date BETWEEN $1 AND $2
    ORDER BY s.trade_date, s.fired_at`, [dateStart, dateEnd]),
    query(`SELECT trade_date::text as d, SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30 FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date`),
    query(`SELECT trade_date::text as d, overnight_inventory as inv, open_vs_prior_value as ovp FROM auction_reads`),
    query(`SELECT trade_date::text as d, migration_dir_vs_prior as mig, vah::float, val::float, poc::float FROM developing_value_log ORDER BY trade_date`),
    query(`SELECT trade_date::text as d, vah::float, val::float FROM developing_value_log ORDER BY trade_date`),
    query(`SELECT ts::date::text as d, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float, volume::bigint as vol
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date BETWEEN $1 AND $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      ORDER BY ts`, [dateStart, dateEnd]),
  ]);

  const nlMap = {}; for (const r of nlQ.rows) nlMap[r.d] = parseInt(r.nl30) || 0;
  const arMap = {}; for (const r of arQ.rows) arMap[r.d] = r;
  const vaMap = {}; const vaArr = vaQ.rows; const vaDates = [];
  const migMap = {};
  for (let i = 0; i < vaArr.length; i++) {
    vaMap[vaArr[i].d] = vaArr[i]; vaDates.push(vaArr[i].d);
    if (i >= 2 && vaArr[i-1].mig === vaArr[i].mig) migMap[vaArr[i].d] = vaArr[i].mig;
  }
  const pd2Map = {}; const pd2Arr = pd2Q.rows;
  for (let i = 2; i < pd2Arr.length; i++) pd2Map[pd2Arr[i].d] = { vah: pd2Arr[i-2].vah, val: pd2Arr[i-2].val };

  const barsByDate = {}; for (const b of barsQ.rows) (barsByDate[b.d] ??= []).push(b);
  const dates = Object.keys(barsByDate).sort();

  // Compute OR width σ thresholds dynamically from the dataset (no static 91.5/47.5)
  const allORWidths = tradesQ.rows.map(t => t.or_width).filter(w => w && w > 0);
  const orMean = allORWidths.length >= 20 ? allORWidths.reduce((s,v) => s+v, 0) / allORWidths.length : 65;
  const orStd = allORWidths.length >= 20 ? Math.sqrt(allORWidths.reduce((s,v) => s + (v - orMean)**2, 0) / allORWidths.length) : 20;
  const wideORThreshold = orMean + orStd;   // +1σ

  function tagTrade(t) {
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
    const wideOR = t.or_width && t.or_width > wideORThreshold;
    const doubleHeadwind = nl30Counter && overnightCounter;
    const align = overnightAligned ? 'ALIGNED' : overnightCounter ? 'COUNTER' : 'NEUTRAL';
    const isTurbulent = t.dayType === 'TURBULENT' || t.day_type === 'TURBULENT';

    let conviction = 'STANDARD';
    if (align === 'ALIGNED' && isTurbulent) conviction = 'MAXIMUM';
    else if (align === 'ALIGNED' && (t.dayType || t.day_type) === 'TREND') conviction = 'MODERATE';
    else if (align === 'ALIGNED' && (t.dayType || t.day_type) === 'BALANCE') conviction = 'MODERATE';
    else if (align === 'COUNTER' && (t.dayType || t.day_type) === 'BALANCE') conviction = 'LOW';
    else if (align === 'COUNTER' && (t.dayType || t.day_type) === 'TREND') conviction = 'LOW';

    const stopDist = t.stop ? Math.abs(t.entry - t.stop) : 50;
    const win = t.resolution === 'TARGET_HIT';
    const winPts = win ? Math.abs(t.pnl / 5) : 0;
    const lossPts = !win ? stopDist : 0;

    // Compute MAE from bars if available
    let mae = null;
    const dayBars = barsByDate[t.d];
    if (dayBars && t.fired_min && t.entry) {
      const after = dayBars.filter(b => b.et_min > (t.fired_min || 570) && b.et_min <= (t.fired_min || 570) + 60);
      if (after.length > 0) {
        mae = isLong
          ? t.entry - Math.min(...after.map(b => b.low))
          : Math.max(...after.map(b => b.high)) - t.entry;
      }
    }

    return {
      source: 'SETUP', setup_type: t.setup_type || t.type, d: t.d, dir: t.dir, win, winPts, lossPts, stopDist, pnl: t.pnl,
      mae, nl30Counter, overnightCounter, overnightAligned, pocCounter, nearPD2, wideOR, doubleHeadwind,
      align, isTurbulent, dayType: t.day_type || t.dayType, conviction, entry: t.entry,
    };
  }

  // ─── Source 1: Pipeline setups ─────────────────────────
  const pipelineTrades = tradesQ.rows.map(tagTrade);

  // ─── Source 2: Edge signals (bar replay) ───────────────
  const edgeTrades = [];
  if (config.sources?.edgeSignals !== false) {
    for (const date of dates) {
      const bars = barsByDate[date];
      if (!bars || bars.length < 60) continue;
      const dayType = tradesQ.rows.find(t => t.d === date)?.day_type || null;

      // EMA Snap-Back
      const fiveBk = {};
      for (const b of bars) { const bk = Math.floor(b.et_min / 5) * 5; if (!fiveBk[bk]) fiveBk[bk] = { high: b.high, low: b.low, close: b.close, et_min: bk }; else { fiveBk[bk].high = Math.max(fiveBk[bk].high, b.high); fiveBk[bk].low = Math.min(fiveBk[bk].low, b.low); fiveBk[bk].close = b.close; } }
      const fb = Object.values(fiveBk).sort((a, b) => a.et_min - b.et_min);
      if (fb.length >= 20) {
        const closes = fb.map(b => b.close);
        const ema = [closes[0]]; for (let i = 1; i < closes.length; i++) ema.push(ema[i-1] + (2/10) * (closes[i] - ema[i-1]));
        let sumTR = 0;
        for (let i = Math.max(1, fb.length - 14); i < fb.length; i++) sumTR += fb[i].high - fb[i].low;
        const atr = sumTR / Math.min(14, fb.length - 1);
        const last = fb.length - 1;
        const dev = Math.abs(closes[last] - ema[last]);
        if (dev >= 2.0 * atr && atr > 0) {
          const isLong = closes[last] < ema[last];
          const entry = closes[last];
          const stopDist = Math.round(atr);
          const target = isLong ? entry + stopDist : entry - stopDist;
          const afterBars = bars.filter(b => b.et_min > fb[last].et_min);
          let win = false, mae = 0;
          for (const b of afterBars.slice(0, 15)) {
            const adv = isLong ? entry - b.low : b.high - entry;
            if (adv > mae) mae = adv;
            if (isLong ? b.high >= target : b.low <= target) { win = true; break; }
            if (isLong ? b.low <= entry - stopDist : b.high >= entry + stopDist) break;
          }
          edgeTrades.push(tagTrade({ d: date, dir: isLong ? 'LONG' : 'SHORT', entry, stop: isLong ? entry - stopDist : entry + stopDist, resolution: win ? 'TARGET_HIT' : 'STOP_HIT', pnl: win ? stopDist * 5 : -stopDist * 5, setup_type: 'EMA_SNAPBACK', day_type: dayType, fired_min: fb[last].et_min }));
        }
      }

      // Absorption (2-min, BALANCE only)
      if (dayType === 'BALANCE') {
        const twoBk = {};
        for (const b of bars) { const bk = Math.floor(b.et_min / 2) * 2; if (!twoBk[bk]) twoBk[bk] = { high: b.high, low: b.low, close: b.close, open: b.open, et_min: bk }; else { twoBk[bk].high = Math.max(twoBk[bk].high, b.high); twoBk[bk].low = Math.min(twoBk[bk].low, b.low); twoBk[bk].close = b.close; } }
        const tb = Object.values(twoBk).sort((a, b) => a.et_min - b.et_min);
        if (tb.length >= 25) {
          const tc = tb.map(b => b.close);
          const rsi = new Array(tc.length).fill(null);
          let ag = 0, al = 0;
          for (let i = 1; i <= 14 && i < tc.length; i++) { const d = tc[i] - tc[i-1]; ag += d > 0 ? d : 0; al += d < 0 ? -d : 0; }
          if (tc.length > 14) { ag /= 14; al /= 14; rsi[14] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
          for (let i = 15; i < tc.length; i++) { const d = tc[i] - tc[i-1]; ag = (ag * 13 + (d > 0 ? d : 0)) / 14; al = (al * 13 + (d < 0 ? -d : 0)) / 14; rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } }
          const AW = 20, last = tc.length - 1;
          if (last >= AW + 5 && rsi[last] != null && rsi[last - AW] != null) {
            const wb = tb.slice(last - AW, last + 1);
            const wL = Math.min(...wb.map(b => b.low));
            const wRange = Math.max(...wb.map(b => b.high)) - wL;
            const rsiDrift = rsi[last] - rsi[last - AW];
            const priceFlat = Math.abs(tc[last] - tc[last - AW]) < wRange * 0.3;
            const lowCluster = wb.filter(b => Math.abs(b.low - wL) < 5).length;
            if (lowCluster >= 4 && rsiDrift > 4 && priceFlat) {
              const entry = tc[last], stopD = 25, targetD = 40;
              const afterBars = bars.filter(b => b.et_min > tb[last].et_min);
              let win = false, mae = 0;
              for (const b of afterBars.slice(0, 40)) {
                if (entry - b.low > mae) mae = entry - b.low;
                if (b.high >= entry + targetD) { win = true; break; }
                if (b.low <= entry - stopD) break;
              }
              edgeTrades.push(tagTrade({ d: date, dir: 'LONG', entry, stop: entry - stopD, resolution: win ? 'TARGET_HIT' : 'STOP_HIT', pnl: win ? targetD * 5 : -stopD * 5, setup_type: 'ABSORPTION', day_type: dayType, fired_min: tb[last].et_min }));
            }
          }
        }
      }
    }
  }

  // ─── Source 3: Level trades (bar replay) ───────────────
  const levelTrades = [];
  if (config.sources?.levelTrades !== false) {
    for (const date of dates) {
      const bars = barsByDate[date];
      if (!bars || bars.length < 50) continue;
      const dayType = tradesQ.rows.find(t => t.d === date)?.day_type || null;

      const di = vaDates.indexOf(date);
      if (di < 1) continue;
      const pd1VA = vaMap[vaDates[di - 1]];
      if (!pd1VA) continue;

      const orBars = bars.filter(b => b.et_min >= 570 && b.et_min < 575);
      const orMid = orBars.length >= 3 ? (Math.max(...orBars.map(b => b.high)) + Math.min(...orBars.map(b => b.low))) / 2 : null;

      const levels = [
        { name: 'PD1_VAH', price: pd1VA.vah, dir: 'SHORT' },
        { name: 'PD1_VAL', price: pd1VA.val, dir: 'LONG' },
        { name: 'PD1_POC', price: pd1VA.poc, dir: 'LONG' },
      ];
      if (orMid) levels.push({ name: 'OR_MID', price: orMid, dir: 'LONG' });

      const postOR = bars.filter(b => b.et_min >= 600 && b.et_min <= 900);
      const stopD = config.levels?.stopOverride || 20;
      const targetD = config.levels?.targetOverride || 20;

      for (const level of levels) {
        if (!level.price) continue;
        let touched = false;
        for (const b of postOR) {
          if (touched) break;
          const near = level.dir === 'LONG'
            ? (b.low <= level.price + 10 && b.close > level.price)
            : (b.high >= level.price - 10 && b.close < level.price);
          if (!near) continue;
          touched = true;

          const entry = b.close;
          const after = postOR.filter(ab => ab.et_min > b.et_min);
          let win = false, mae = 0;
          for (const ab of after.slice(0, 30)) {
            const adv = level.dir === 'LONG' ? entry - ab.low : ab.high - entry;
            if (adv > mae) mae = adv;
            const t1Hit = level.dir === 'LONG' ? ab.high >= entry + targetD : ab.low <= entry - targetD;
            const sHit = level.dir === 'LONG' ? ab.low <= entry - stopD : ab.high >= entry + stopD;
            if (t1Hit) { win = true; break; }
            if (sHit) break;
          }
          levelTrades.push(tagTrade({ d: date, dir: level.dir, entry, stop: level.dir === 'LONG' ? entry - stopD : entry + stopD, resolution: win ? 'TARGET_HIT' : 'STOP_HIT', pnl: win ? targetD * 5 : -stopD * 5, setup_type: `LEVEL_${level.name}`, day_type: dayType, fired_min: b.et_min }));
        }
      }
    }
  }

  return { pipelineTrades, edgeTrades, levelTrades, barsByDate, dates };
}

// ─── FILTER DEFINITIONS ─────────────────────────────────────────────

const FILTER_DEFS = {
  nl30Counter: t => !t.nl30Counter,
  doubleHeadwind: t => !t.doubleHeadwind,
  pocMigration: t => !t.pocCounter,
  pd2Gate: t => t.nearPD2,
  wideORSuppressTRT: t => !(t.wideOR && (t.setup_type === 'TRT_LONG' || t.setup_type === 'TRT_SHORT')),
  overnightCounter: t => !t.overnightCounter,
  turbulentOnly: t => t.isTurbulent,
  tripleStackAvoid: t => { if (t.align === 'COUNTER' && t.dayType === 'TREND') return false; if (t.align === 'COUNTER' && t.dayType === 'BALANCE' && t.wideOR) return false; return true; },
};

export function applyFilters(trades, filterConfig) {
  let filtered = [...trades];
  for (const [name, enabled] of Object.entries(filterConfig)) {
    if (enabled && FILTER_DEFS[name]) filtered = filtered.filter(FILTER_DEFS[name]);
  }
  return filtered;
}

// ─── GROUP TRADES INTO DAYS ─────────────────────────────────────────

function groupByDay(trades) {
  const byDay = {};
  for (const t of trades) (byDay[t.d] ??= []).push(t);
  return Object.values(byDay);
}

// ─── MAIN MONTE CARLO ──────────────────────────────────────────────

export async function runMonteCarlo(userConfig = {}) {
  const config = {
    account: { startingBalance: 2000, pointValue: 2, commission: 0.50, maxContracts: 20, trailingDrawdown: 1500, drawdownFreezeProfit: 3000, ...userConfig.account },
    sizing: { riskPctPerTrade: 0.015, maxRiskPct: 0.05, stopOverride: null, postLossReduction: 0.5, convictionScaling: true, ...userConfig.sizing },
    simulation: { runs: 5000, method: 'BOOTSTRAP', ...userConfig.simulation },
    dateRange: { start: '2025-06-18', end: null, ...userConfig.dateRange },
    setups: userConfig.setups || { mode: 'ALL' },
    filters: userConfig.filters || {},
    sources: { pipelineSetups: true, edgeSignals: true, levelTrades: true, ...userConfig.sources },
    levels: { stopOverride: 20, targetOverride: 20, ...userConfig.levels },
  };

  const { pipelineTrades, edgeTrades, levelTrades } = await loadAndTagTrades(config);

  let allTrades = [];
  if (config.sources.pipelineSetups) allTrades.push(...pipelineTrades);
  if (config.sources.edgeSignals) allTrades.push(...edgeTrades);
  if (config.sources.levelTrades) allTrades.push(...levelTrades);

  if (config.setups.mode === 'CUSTOM' && config.setups.include) {
    const includeSet = new Set(config.setups.include);
    allTrades = allTrades.filter(t => includeSet.has(t.setup_type));
  }

  allTrades = applyFilters(allTrades, config.filters);

  if (allTrades.length < 3) return { error: 'Not enough trades after filtering', total: allTrades.length };

  const tradeDays = groupByDay(allTrades);

  const results = [];
  for (let r = 0; r < config.simulation.runs; r++) {
    results.push(simulateRun(tradeDays, config, config.simulation.method === 'BOOTSTRAP'));
  }

  const finals = results.map(r => r.final).sort((a, b) => a - b);
  const maxDDs = results.map(r => r.maxDD).sort((a, b) => a - b);
  const blownCount = results.filter(r => r.blown).length;
  const pct = (p) => finals[Math.min(finals.length - 1, Math.floor(p / 100 * results.length))];
  const ddPct = (p) => maxDDs[Math.min(maxDDs.length - 1, Math.floor(p / 100 * results.length))];

  // Breakdowns
  const setupBreakdown = {};
  for (const t of allTrades) {
    const k = t.setup_type;
    if (!setupBreakdown[k]) setupBreakdown[k] = { n: 0, w: 0, pnl: 0, source: t.source };
    setupBreakdown[k].n++; if (t.win) setupBreakdown[k].w++;
    setupBreakdown[k].pnl += t.pnl / 5 * config.account.pointValue;
  }

  const convBreakdown = {};
  for (const t of allTrades) {
    if (!convBreakdown[t.conviction]) convBreakdown[t.conviction] = { n: 0, w: 0 };
    convBreakdown[t.conviction].n++; if (t.win) convBreakdown[t.conviction].w++;
  }

  const sourceBreakdown = { SETUP: { n: 0, w: 0, pnl: 0 }, EDGE: { n: 0, w: 0, pnl: 0 }, LEVEL: { n: 0, w: 0, pnl: 0 } };
  for (const t of allTrades) {
    const src = t.source === 'SETUP' ? 'SETUP' : t.setup_type.startsWith('LEVEL_') ? 'LEVEL' : 'EDGE';
    sourceBreakdown[src].n++; if (t.win) sourceBreakdown[src].w++;
    sourceBreakdown[src].pnl += t.pnl / 5 * config.account.pointValue;
  }

  const summary = {
    runs: config.simulation.runs, tradesInPool: allTrades.length, tradeDays: tradeDays.length,
    method: config.simulation.method, startingBalance: config.account.startingBalance,
    pipelineTrades: pipelineTrades.length, edgeTrades: edgeTrades.length, levelTrades: levelTrades.length,

    median: pct(50), mean: Math.round(finals.reduce((s, v) => s + v, 0) / finals.length),
    p1: pct(1), p5: pct(5), p10: pct(10), p25: pct(25), p75: pct(75), p90: pct(90), p95: pct(95), p99: pct(99),
    min: finals[0], max: finals[finals.length - 1],

    survivalRate: ((results.length - blownCount) / results.length * 100).toFixed(1),
    blowUpRate: (blownCount / results.length * 100).toFixed(1), blownCount,
    avgMaxDD: Math.round(maxDDs.reduce((s, v) => s + v, 0) / maxDDs.length),
    medianMaxDD: ddPct(50), p95MaxDD: ddPct(95),
    medianReturn: ((pct(50) / config.account.startingBalance - 1) * 100).toFixed(0),

    setupBreakdown, convBreakdown, sourceBreakdown,
  };

  const sampleCurves = results.slice(0, 15).map(r => r.equityCurve);

  return { config, summary, equityDistribution: finals, drawdownDistribution: maxDDs, sampleCurves };
}

// ─── OPTIMIZER ──────────────────────────────────────────────────────

export async function runOptimizer(userConfig = {}) {
  const config = {
    account: { startingBalance: 2000, pointValue: 2, commission: 0.50, ...userConfig.account },
    sizing: { stopOverride: null, ...userConfig.sizing },
    dateRange: { start: '2025-06-18', ...userConfig.dateRange },
    sources: { pipelineSetups: true, edgeSignals: true, levelTrades: true, ...userConfig.sources },
    levels: { stopOverride: 20, targetOverride: 20, ...userConfig.levels },
  };

  const { pipelineTrades, edgeTrades, levelTrades } = await loadAndTagTrades(config);
  const allTrades = [...pipelineTrades, ...edgeTrades, ...levelTrades];
  const setupTypes = [...new Set(allTrades.map(t => t.setup_type))].sort();
  const filterNames = Object.keys(FILTER_DEFS);

  const results = [];
  for (const type of setupTypes) {
    const typeTrades = allTrades.filter(t => t.setup_type === type);
    if (typeTrades.length < 3) continue;

    let bestNet = -Infinity, bestFilters = [], bestN = 0, bestWR = 0;
    for (let mask = 0; mask < (1 << filterNames.length); mask++) {
      let filtered = [...typeTrades];
      const active = [];
      for (let i = 0; i < filterNames.length; i++) {
        if (mask & (1 << i)) { active.push(filterNames[i]); filtered = filtered.filter(FILTER_DEFS[filterNames[i]]); }
      }
      if (filtered.length < 3) continue;
      const net = filtered.reduce((s, t) => s + t.pnl / 5 * config.account.pointValue, 0);
      if (net > bestNet) { bestNet = net; bestFilters = active; bestN = filtered.length; bestWR = filtered.filter(t => t.win).length / filtered.length; }
    }

    const source = typeTrades[0]?.source === 'SETUP' ? 'PIPELINE' : typeTrades[0]?.setup_type?.startsWith('LEVEL_') ? 'LEVEL' : 'EDGE';
    results.push({ setup: type, source, filters: bestFilters, n: bestN, wr: bestWR, netPnl: Math.round(bestNet), perTrade: Math.round(bestNet / bestN) });
  }

  results.sort((a, b) => b.netPnl - a.netPnl);
  return { setupTypes: setupTypes.length, totalTrades: allTrades.length, allConfigs: results, profitableConfigs: results.filter(r => r.netPnl > 0) };
}
