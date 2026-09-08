import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { getVolumeBaseline, computeVolumeBuildingMeasures, classifyVolumeBuilding } from '../server/services/touchQuality.js';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const FIRED_AT_BAR_COUNT_CUTOFF = 4;
const MAX_WALK_BARS = 500;
const TARGET_MULT = 1.5;
const TRAIN_FRACTION = 0.6;

function pnlAt(entry, price, long) {
  const points = long ? price - entry : entry - price;
  return points * PNL_PER_POINT - COMMISSION;
}

function summarize(deltas) {
  const n = deltas.length;
  if (n === 0) return { n: 0, mean: 0, neg: 0 };
  const mean = deltas.reduce((a, b) => a + b, 0) / n;
  const neg = deltas.filter(d => d < 0).length;
  return { n, mean, neg };
}

function getImbalance(bar, long) {
  const totalVol = (bar.bid_volume || 0) + (bar.ask_volume || 0);
  if (totalVol === 0) return null;
  const favorable = long ? (bar.ask_volume || 0) : (bar.bid_volume || 0);
  const adverse = long ? (bar.bid_volume || 0) : (bar.ask_volume || 0);
  return (favorable - adverse) / totalVol;
}

function getSessOpenMod(ts) {
  const mod = ts.getHours() * 60 + ts.getMinutes();
  if (mod >= 17 * 60 || mod < 9 * 60 + 30) {
    // Globex (6 PM previous day to 9:30 AM)
    return 18 * 60; // 6 PM
  }
  return 9 * 60 + 30; // 9:30 AM RTH
}

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, trade_date::text as trade_date, fired_at,
      extract(epoch from fired_at)*1000 as fired_at_ms,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level, bars_to_resolution
    FROM active_setups
    WHERE resolution = 'TARGET_HIT' AND origin_status IN ('ACTIVE','SHADOW')
      AND entry_zone_low IS NOT NULL AND entry_zone_high IS NOT NULL
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND fired_at IS NOT NULL
      AND bars_to_resolution <= ${FIRED_AT_BAR_COUNT_CUTOFF}
    ORDER BY fired_at ASC
  `);
  const trades = tradesRes.rows.filter(t => inferDirection(t.setup_type) !== null);

  const barsRes = await query(`
    SELECT ts, high::float as high, low::float as low, close::float as close,
      COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({
    ts: new Date(b.ts),
    ts_ms: new Date(b.ts).getTime(),
    mod: new Date(b.ts).getHours() * 60 + new Date(b.ts).getMinutes(),
    high: b.high, low: b.low, close: b.close,
    bid_volume: b.bid_volume, ask_volume: b.ask_volume,
    volume: b.bid_volume + b.ask_volume
  }));

  const levelsRes = await query(`
    SELECT trade_date::text as trade_date, price::float as price, category
    FROM level_prices
    WHERE category IN ('PRIOR_DAY','PRIOR','WEEKLY','MONTHLY','QUARTERLY','YEARLY','PIVOT','CAMARILLA','WEEKLY_PIVOT','MONTHLY_PIVOT','OVERNIGHT')
  `);
  const levelsByDate = new Map();
  for (const r of levelsRes.rows) {
    if (!levelsByDate.has(r.trade_date)) levelsByDate.set(r.trade_date, []);
    levelsByDate.get(r.trade_date).push(r.price);
  }

  // Pre-fetch baselines for all dates
  const uniqueDates = [...new Set(trades.map(t => t.trade_date))];
  const baselinesByDate = new Map();
  for (const date of uniqueDates) {
    baselinesByDate.set(date, await getVolumeBaseline(query, date));
  }

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts_ms <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const processed = [];
  for (const trade of trades) {
    const direction = inferDirection(trade.setup_type);
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const stop = trade.stop_level;
    const t1 = trade.t1_level;

    const startIdx = firstIndexAfter(trade.fired_at_ms);
    let barCount = 0, t1TouchIdx = null, entryIdx = null;
    
    // Find entry bar (first bar at or after fired_at)
    entryIdx = startIdx;
    if (entryIdx >= allBars.length) continue;

    for (let i = startIdx; i < Math.min(allBars.length, startIdx + MAX_WALK_BARS); i++) {
      barCount++;
      const bar = allBars[i];
      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (t1Hit && stopHit) break; // invalidated
      if (t1Hit) { t1TouchIdx = i; break; }
      if (stopHit) break; // invalidated
    }
    if (t1TouchIdx === null || barCount > FIRED_AT_BAR_COUNT_CUTOFF) continue;
    if (t1TouchIdx < entryIdx) continue; // safety

    const baselinePnl = pnlAt(entry, t1, long);
    const origDistance = Math.abs(t1 - entry);
    const widerTarget = long ? entry + origDistance * TARGET_MULT : entry - origDistance * TARGET_MULT;
    
    let extendPnl = null;
    for (let i = t1TouchIdx + 1; i < Math.min(allBars.length, t1TouchIdx + 1 + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const widerHit = long ? bar.high >= widerTarget : bar.low <= widerTarget;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (widerHit && stopHit) { extendPnl = pnlAt(entry, stop, long); break; }
      if (widerHit) { extendPnl = pnlAt(entry, widerTarget, long); break; }
      if (stopHit) { extendPnl = pnlAt(entry, stop, long); break; }
    }
    if (extendPnl === null) {
      const lastBar = allBars[Math.min(allBars.length - 1, t1TouchIdx + MAX_WALK_BARS)];
      extendPnl = pnlAt(entry, lastBar.close, long);
    }

    const touchBar = allBars[t1TouchIdx];
    const dirImbalance = getImbalance(touchBar, long);
    if (dirImbalance === null) continue;

    // Angle 1: Freshness
    const entryBar = allBars[entryIdx];
    const entryImbalance = getImbalance(entryBar, long);
    const pressureDelta = entryImbalance !== null ? dirImbalance - entryImbalance : null;

    // Angle 2: Persistence (3-bar avg)
    let persistenceImb = null;
    if (t1TouchIdx >= 2) {
      const b0 = allBars[t1TouchIdx], b1 = allBars[t1TouchIdx-1], b2 = allBars[t1TouchIdx-2];
      const imb0 = getImbalance(b0, long), imb1 = getImbalance(b1, long), imb2 = getImbalance(b2, long);
      if (imb0 !== null && imb1 !== null && imb2 !== null) persistenceImb = (imb0 + imb1 + imb2) / 3;
    }

    // Angle 3: Volume-building
    const baseline = baselinesByDate.get(trade.trade_date);
    let volBuildMeasures = null;
    if (baseline) {
      // Find session bars
      const touchMod = touchBar.mod;
      let sessionStartIdx = t1TouchIdx;
      let isGlobex = (touchMod >= 18*60 || touchMod < 9*60+30);
      while (sessionStartIdx > 0) {
        const prevBar = allBars[sessionStartIdx - 1];
        const prevMod = prevBar.mod;
        if (prevBar.ts.getTime() < touchBar.ts.getTime() - 24*60*60*1000) break; // safety
        let prevIsGlobex = (prevMod >= 18*60 || prevMod < 9*60+30);
        if (isGlobex !== prevIsGlobex) break;
        if (!isGlobex && prevMod < 9*60+30) break; // crossover
        if (isGlobex && prevMod >= 9*60+30 && prevMod < 18*60) break;
        sessionStartIdx--;
      }
      const sessionBars = allBars.slice(sessionStartIdx, t1TouchIdx + 1);
      volBuildMeasures = computeVolumeBuildingMeasures(sessionBars, sessionBars.length - 1, baseline);
    }

    // Angle 4: Price-location
    const locWithinBar = (touchBar.high - touchBar.low > 0) ?
      (long ? (touchBar.close - touchBar.low) / (touchBar.high - touchBar.low) : (touchBar.high - touchBar.close) / (touchBar.high - touchBar.low)) : null;

    // Angle 5: Structural runway
    let runway = null;
    const levels = levelsByDate.get(trade.trade_date) || [];
    let nearestLevel = null;
    for (const lvl of levels) {
      if (long && lvl > widerTarget) {
        if (nearestLevel === null || lvl < nearestLevel) nearestLevel = lvl;
      } else if (!long && lvl < widerTarget) {
        if (nearestLevel === null || lvl > nearestLevel) nearestLevel = lvl;
      }
    }
    if (nearestLevel !== null) {
      runway = Math.abs(nearestLevel - widerTarget);
    }

    // Angle 6: RTH / Globex
    const isRTH = (touchBar.mod >= 9*60+30 && touchBar.mod < 16*60);

    processed.push({
      date: trade.trade_date,
      fired_at_ms: trade.fired_at_ms,
      baselinePnl, extendPnl, dirImbalance,
      pressureDelta, persistenceImb,
      volBuildMeasures, locWithinBar, runway, isRTH
    });
  }

  const sorted = [...processed].sort((a, b) => a.fired_at_ms - b.fired_at_ms);
  const cut = Math.floor(sorted.length * TRAIN_FRACTION);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);

  // Baseline threshold (raw 1-bar)
  const getTopTercile = (arr, fn) => {
    const vals = arr.map(fn).filter(v => v !== null && !isNaN(v)).sort((a,b)=>a-b);
    return vals.length > 0 ? vals[Math.floor(vals.length * 2 / 3)] : 0;
  };
  const getMedian = (arr, fn) => {
    const vals = arr.map(fn).filter(v => v !== null && !isNaN(v)).sort((a,b)=>a-b);
    return vals.length > 0 ? vals[Math.floor(vals.length / 2)] : 0;
  };

  const threshold = getTopTercile(train, r => r.dirImbalance);

  const reportTopDays = (subset, label) => {
    const byDay = new Map();
    for (const r of subset) {
      if (!byDay.has(r.date)) byDay.set(r.date, {n:0, d:0});
      byDay.get(r.date).n++;
      byDay.get(r.date).d += (r.extendPnl - r.baselinePnl);
    }
    const days = [...byDay.entries()].map(([date, st]) => ({date, ...st})).sort((a,b)=>b.d-a.d);
    const totalN = subset.length;
    const totalD = subset.reduce((a,b)=>a+(b.extendPnl-b.baselinePnl),0);
    const top5 = days.slice(0,5);
    const top5N = top5.reduce((a,b)=>a+b.n,0);
    const top5D = top5.reduce((a,b)=>a+b.d,0);
    console.log(`    [Top 5 days for ${label}] total delta=$${totalD.toFixed(2)} N=${totalN}. Top 5 days carried $${top5D.toFixed(2)} (${(top5D/totalD*100).toFixed(1)}%) with N=${top5N} (${(top5N/totalN*100).toFixed(1)}%).`);
    console.log(`    Top days: ${top5.map(d=>`${d.date}: $${d.d.toFixed(2)} (N=${d.n})`).join(', ')}`);
  };

  const evalArm = (subset, gateFn, label, baseMean) => {
    const deltas = subset.map(r => gateFn(r) ? (r.extendPnl - r.baselinePnl) : 0);
    const s = summarize(deltas);
    const extSubset = subset.filter(gateFn);
    const extCount = extSubset.length;
    
    console.log(`${label}: mean delta=$${s.mean.toFixed(2)}, neg=${s.neg}/${s.n} (${(s.neg/s.n*100).toFixed(1)}%), ext=${extCount}/${s.n} (${(extCount/s.n*100).toFixed(1)}%)`);
    if (extCount > 0) {
      const rigor = computeRigor(extSubset.map(r => ({ t: r.date, pnl: r.extendPnl - r.baselinePnl })), { dateField: 't', pnlFn: r => r.pnl });
      console.log(`  Rigor: stable=${rigor.stable} clustered=${rigor.clustered} clean=${rigor.clean}`);
      if (baseMean !== undefined && s.mean > baseMean + 0.5) { // meaningful margin ~0.5
        reportTopDays(extSubset, label);
      }
    }
    return { mean: s.mean, extCount };
  };

  console.log(`\n=== Baseline (Raw 1-bar dirImbalance) ===`);
  const neverDeltas = test.map(() => 0);
  const alwaysDeltas = test.map(r => r.extendPnl - r.baselinePnl);
  console.log(`NEVER: mean delta=$0.00, neg=0/${test.length} (0.0%)`);
  const sAlways = summarize(alwaysDeltas);
  console.log(`ALWAYS: mean delta=$${sAlways.mean.toFixed(2)}, neg=${sAlways.neg}/${sAlways.n} (${(sAlways.neg/sAlways.n*100).toFixed(1)}%)`);
  const baseRes = evalArm(test, r => r.dirImbalance >= threshold, 'GATED (Baseline)', sAlways.mean);

  // Angle 1: Freshness
  console.log(`\n=== Angle 1: Freshness (pressureDelta) ===`);
  const thrFresh = getTopTercile(train, r => r.pressureDelta);
  evalArm(test, r => r.pressureDelta !== null && r.pressureDelta >= thrFresh, 'GATED (Freshness)', baseRes.mean);

  // Angle 2: Persistence (3-bar avg)
  console.log(`\n=== Angle 2: Persistence (3-bar avg) ===`);
  const thrPers = getTopTercile(train, r => r.persistenceImb);
  evalArm(test, r => r.persistenceImb !== null && r.persistenceImb >= thrPers, 'GATED (Persistence)', baseRes.mean);

  // Angle 3: Volume-building strength
  console.log(`\n=== Angle 3: Volume-building ===`);
  const trainVol = train.map(r => r.volBuildMeasures).filter(v => v);
  const calib = {
    avgVolZMed: getMedian(trainVol, v => v.avgVolZ),
    volZTrendMed: getMedian(trainVol, v => v.volZTrend),
    avgDayVolZMed: getMedian(trainVol, v => v.avgDayVolZ),
    dayVolZTrendMed: getMedian(trainVol, v => v.dayVolZTrend),
    avgVolZP60: getTopTercile(trainVol, v => v.avgVolZ), // close enough to P60 for this
    volZTrendP60: getTopTercile(trainVol, v => v.volZTrend),
    avgDayVolZP60: getTopTercile(trainVol, v => v.avgDayVolZ),
    dayVolZTrendP60: getTopTercile(trainVol, v => v.dayVolZTrend),
  };
  evalArm(test, r => {
    if (r.dirImbalance < threshold) return false;
    if (!r.volBuildMeasures) return false;
    const cl = classifyVolumeBuilding(r.volBuildMeasures, calib);
    return cl.agreesMedian === true;
  }, 'GATED (Pressure + VolBuilding Median)', baseRes.mean);
  evalArm(test, r => {
    if (r.dirImbalance < threshold) return false;
    if (!r.volBuildMeasures) return false;
    const cl = classifyVolumeBuilding(r.volBuildMeasures, calib);
    return cl.agreesP60 === true;
  }, 'GATED (Pressure + VolBuilding P60)', baseRes.mean);

  // Angle 4: Price-location
  console.log(`\n=== Angle 4: Price-location ===`);
  evalArm(test, r => r.dirImbalance >= threshold && r.locWithinBar !== null && r.locWithinBar >= 0.5, 'GATED (Pressure + Loc>=0.5)', baseRes.mean);

  // Angle 5: Structural runway
  console.log(`\n=== Angle 5: Structural runway ===`);
  const extTest = test.filter(r => r.dirImbalance >= threshold && r.runway !== null);
  const extRunwayMed = getMedian(extTest, r => r.runway);
  const moreRunwaySubset = extTest.filter(r => r.runway >= extRunwayMed);
  const lessRunwaySubset = extTest.filter(r => r.runway < extRunwayMed);
  console.log(`Of ${extTest.length} baseline-extended TEST trades with runway, median runway=${extRunwayMed.toFixed(1)}pt`);
  if (moreRunwaySubset.length > 0) evalArm(moreRunwaySubset, r => true, 'MORE Runway (>= Median)', baseRes.mean);
  if (lessRunwaySubset.length > 0) evalArm(lessRunwaySubset, r => true, 'LESS Runway (< Median)', baseRes.mean);
  
  // Angle 6: RTH / Globex separate calibration
  console.log(`\n=== Angle 6: RTH / Globex Separate Calibration ===`);
  const trainRTH = train.filter(r => r.isRTH);
  const trainGlobex = train.filter(r => !r.isRTH);
  const testRTH = test.filter(r => r.isRTH);
  const testGlobex = test.filter(r => !r.isRTH);
  const thrRTH = getTopTercile(trainRTH, r => r.dirImbalance);
  const thrGlobex = getTopTercile(trainGlobex, r => r.dirImbalance);
  console.log(`RTH: Train N=${trainRTH.length}, Test N=${testRTH.length}. Separate threshold=${thrRTH.toFixed(3)} (Pooled was ${threshold.toFixed(3)})`);
  if (testRTH.length >= 20) {
    evalArm(testRTH, r => r.dirImbalance >= threshold, 'RTH with Pooled Threshold', undefined);
    evalArm(testRTH, r => r.dirImbalance >= thrRTH, 'RTH with Separate Threshold', undefined);
  } else {
    console.log("RTH test population too thin (<20).");
  }

  console.log(`\nGlobex: Train N=${trainGlobex.length}, Test N=${testGlobex.length}. Separate threshold=${thrGlobex.toFixed(3)} (Pooled was ${threshold.toFixed(3)})`);
  if (testGlobex.length >= 20) {
    evalArm(testGlobex, r => r.dirImbalance >= threshold, 'Globex with Pooled Threshold', undefined);
    evalArm(testGlobex, r => r.dirImbalance >= thrGlobex, 'Globex with Separate Threshold', undefined);
  } else {
    console.log("Globex test population too thin (<20).");
  }

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
