import fs from 'fs';
import { query } from '../server/db.js';
import { computeBalanceAndResolution, computeEntryPace } from '../server/services/flushMechanics.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';

const PT = 2; 
const COMM = 1; 

function computeIntradayATR(bars, currentIdx, window = 60) {
  const start = Math.max(1, currentIdx - window + 1);
  let sum = 0, count = 0;
  for (let i = start; i <= currentIdx; i++) {
    const b = bars[i], prev = bars[i - 1];
    if (!b || !prev) continue;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
    sum += tr; count++;
  }
  return count > 0 ? sum / count : null;
}

function aggregate5Min(bars) {
  const out = [];
  let current = null;
  for (const b of bars) {
    const m = Math.floor(new Date(b.ts).getTime() / 60000);
    const bucket = m - (m % 5);
    if (!current || current.bucket !== bucket) {
      if (current) out.push(current);
      current = { bucket, ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      current.high = Math.max(current.high, b.high);
      current.low = Math.min(current.low, b.low);
      current.close = b.close;
      current.volume += b.volume;
    }
  }
  if (current) out.push(current);
  return out;
}

async function getLiveTargets() {
  const { rows } = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, optimal_target::float as target, notes
    FROM performance_audit
    WHERE signal_type='OPTIMAL_STOP'
      AND signal_name IN ('RTH_FLUSH_LONG','RTH_FLUSH_SHORT','GLOBEX_FLUSH_LONG','GLOBEX_FLUSH_SHORT','GLOBEX_FLUSH_REVERSAL_LONG','GLOBEX_FLUSH_REVERSAL_SHORT')
    ORDER BY signal_name, run_date DESC
  `);
  const dict = {};
  for (const r of rows) {
    try {
      const n = JSON.parse(r.notes || '{}');
      dict[r.signal_name] = { target: r.target, ...n };
    } catch(e) {}
  }
  return dict;
}

async function evaluateTrade(t, baselinePts) {
  // Common eval info
  const bars = t.bars;
  const entryIdx = t.entryIdx;
  const entry = t.entryPrice;
  const stop = t.stopPrice;
  const dir = t.dir;
  const isLong = dir === 'UP';
  const baselineTgt = isLong ? entry + baselinePts : entry - baselinePts;
  
  // Track baseline trade
  let baselinePnl = null;
  let maxFav = 0;
  for (let i = entryIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    const fav = isLong ? b.high - entry : entry - b.low;
    if (fav > maxFav) maxFav = fav;
    
    const stopHit = isLong ? b.low <= stop : b.high >= stop;
    const tgtHit = isLong ? b.high >= baselineTgt : b.low <= baselineTgt;
    
    if (stopHit && tgtHit) { baselinePnl = -(entry - stop) * PT - COMM; break; }
    if (stopHit) { baselinePnl = -Math.abs(entry - stop) * PT - COMM; break; }
    if (tgtHit) { baselinePnl = Math.abs(baselineTgt - entry) * PT - COMM; break; }
  }
  if (baselinePnl === null) baselinePnl = 0; // expired
  
  t.mfe = maxFav;
  t.baselinePnl = baselinePnl;
  
  // Meaningful favorable move filter: if MFE < 20 pts, it's mostly noise
  t.meaningful = maxFav >= 20;

  // VWAP Slope Exit eval
  const postBars = bars.slice(entryIdx); 
  const fiveMinBars = aggregate5Min(postBars);
  if (fiveMinBars.length > 2) {
    const vwapSeries = computeRunningVwapSeries(fiveMinBars);
    const slopes = [];
    for (let i = 1; i < fiveMinBars.length; i++) {
      const rawSlope = vwapSeries[i] - vwapSeries[i-1];
      const signedSlope = isLong ? rawSlope : -rawSlope;
      const b1minIdx = bars.findIndex(b => b.ts === fiveMinBars[i].ts);
      const atr = b1minIdx !== -1 ? computeIntradayATR(bars, b1minIdx, 60) : null;
      slopes.push({ 
        fiveMinIdx: i, 
        val: signedSlope, 
        atrNorm: (atr && atr > 0) ? signedSlope / atr : null 
      });
    }
    t.slopes = slopes;
    t.fiveMinBars = fiveMinBars;
  }
  
  // Structural Exit eval
  t.structExitFoundAt = null;
  const l = t.levels;
  if (l) {
    const cands = [l['PD_VAH'], l['PD_VAL'], l['PD_POC'], l['ONH'], l['ONL'], l['IB_HIGH'], l['IB_LOW']].filter(x => x != null);
    if (cands.length > 0) {
      // nearest level in direction of travel
      let targetLev = null;
      if (isLong) {
        const aboves = cands.filter(x => x > entry + 5);
        if (aboves.length > 0) targetLev = Math.min(...aboves);
      } else {
        const belows = cands.filter(x => x < entry - 5);
        if (belows.length > 0) targetLev = Math.max(...belows);
      }
      
      if (targetLev) {
        t.structTargetLev = targetLev;
        // simulate structural trade
        for (let i = entryIdx + 1; i < bars.length; i++) {
          const b = bars[i];
          const stopHit = isLong ? b.low <= stop : b.high >= stop;
          const tgtHit = isLong ? b.high >= targetLev : b.low <= targetLev;
          if (stopHit && tgtHit) { t.structPnl = -(entry - stop) * PT - COMM; t.structExitFoundAt = i; break; }
          if (stopHit) { t.structPnl = -Math.abs(entry - stop) * PT - COMM; t.structExitFoundAt = i; break; }
          if (tgtHit) { t.structPnl = Math.abs(targetLev - entry) * PT - COMM; t.structExitFoundAt = i; break; }
        }
        if (t.structExitFoundAt === null) {
          t.structPnl = 0; 
        }
      }
    }
  }
}

async function main() {
  const calib = await getLiveTargets();
  const levelsQ = await query(`SELECT trade_date::text as d, level_name, price::float FROM level_prices WHERE trade_date >= '2023-01-01'`);
  const levels = new Map();
  for (const r of levelsQ.rows) {
    if (!levels.has(r.d)) levels.set(r.d, {});
    levels.get(r.d)[r.level_name] = r.price;
  }

  // To build IB_HIGH/IB_LOW daily map
  const ibQ = await query(`
    SELECT ts::date::text as d, MAX(high)::float as ib_high, MIN(low)::float as ib_low
    FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    GROUP BY ts::date
  `);
  for (const r of ibQ.rows) {
    if (!levels.has(r.d)) levels.set(r.d, {});
    levels.get(r.d)['IB_HIGH'] = r.ib_high;
    levels.get(r.d)['IB_LOW'] = r.ib_low;
  }

  const barsQ = await query(`
    SELECT ts, ts::date::text as d,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as mod,
           open::float, high::float, low::float, close::float,
           (COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::int as volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= '2023-01-01'
    ORDER BY ts
  `);
  const allBars = barsQ.rows;

  const rthDays = new Map();
  for (const b of allBars) {
    if (b.mod >= 570 && b.mod <= 959) {
      if (!rthDays.has(b.d)) rthDays.set(b.d, []);
      rthDays.get(b.d).push(b);
    }
  }

  const population = [];

  for (const [d, bars] of rthDays.entries()) {
    if (bars.length < 40) continue;
    const l = levels.get(d) || {};
    const ibHigh = l['IB_HIGH'], ibLow = l['IB_LOW'];
    const onh = l['ONH'], onl = l['ONL'];
    
    let triggerIdx = null;
    let trigSrc = null;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.mod >= 630 && ibHigh != null && (b.close > ibHigh || b.close < ibLow)) { triggerIdx = i; break; }
      if (b.mod >= 570 && onh != null && onl != null && (b.close > onh || b.close < onl)) { 
        if (triggerIdx === null || i < triggerIdx) { triggerIdx = i; trigSrc = 'ON'; }
      }
    }
    
    if (triggerIdx !== null) {
      const postBars = bars.slice(triggerIdx + 1);
      const res = computeBalanceAndResolution(postBars);
      if (res) {
        const setup = `RTH_FLUSH_${res.resolutionDir === 'UP' ? 'LONG' : 'SHORT'}`;
        const c = calib[setup];
        if (c) {
          // just use base target to simplify, since we are doing head to head on same trades
          population.push({
            date: d, window: 'RTH', dir: res.resolutionDir, mode: 'CONTINUATION', 
            entryIdx: triggerIdx + 1 + res.resolutionIdx, entryPrice: res.entryPrice, stopPrice: res.stopPrice,
            bars, levels: l, baselinePts: c.target
          });
        }
      }
    }
  }

  let currentGlobexDay = null;
  let currentGlobexBars = [];
  for (const b of allBars) {
    const isGlobex = b.mod >= 959 || b.mod < 570;
    if (!isGlobex) continue;
    let gDay = b.d;
    if (b.mod < 570) {
      const d = new Date(b.ts); d.setUTCDate(d.getUTCDate() - 1); gDay = d.toISOString().slice(0, 10);
    }
    if (currentGlobexDay !== gDay) {
      if (currentGlobexBars.length > 0 && currentGlobexDay) processGlobexDay(currentGlobexDay, currentGlobexBars, levels, calib, population);
      currentGlobexDay = gDay; currentGlobexBars = [];
    }
    currentGlobexBars.push(b);
  }
  if (currentGlobexBars.length > 0 && currentGlobexDay) processGlobexDay(currentGlobexDay, currentGlobexBars, levels, calib, population);

  console.log(`Evaluating ${population.length} entries...`);
  for (const t of population) await evaluateTrade(t, t.baselinePts);

  const meaningful = population.filter(t => t.meaningful);
  console.log(`Meaningful moves (MFE >= 20): ${meaningful.length} (out of ${population.length})`);

  function simulateVWAP(trade, thresh, isNorm, flatDurationBars) {
    if (!trade.slopes) return 0;
    let flatRun = 0;
    const isLong = trade.dir === 'UP';
    let pnl = null;
    let mfeAtExit = 0;
    for (const s of trade.slopes) {
      const val = isNorm ? s.atrNorm : s.val;
      if (val === null) continue;
      
      if (val < thresh) flatRun++;
      else flatRun = 0;
      
      // if flattened for duration, exit at close of that 5-min bar
      if (flatRun >= flatDurationBars) {
        const exitBar = trade.fiveMinBars[s.fiveMinIdx];
        const exitPrice = exitBar.close;
        const entry = trade.entryPrice;
        
        // ensure stop wasn't hit before this 5 min bar completed
        let stopHit = false;
        let pnlOverride = 0;
        const start1M = trade.entryIdx;
        const end1M = trade.bars.findIndex(b => b.ts === exitBar.ts) + 4; // approximate
        for (let i = start1M; i <= end1M && i < trade.bars.length; i++) {
          const bb = trade.bars[i];
          if ((isLong && bb.low <= trade.stopPrice) || (!isLong && bb.high >= trade.stopPrice)) {
            stopHit = true;
            pnlOverride = -(Math.abs(entry - trade.stopPrice)) * PT - COMM;
            break;
          }
        }
        
        if (stopHit) pnl = pnlOverride;
        else pnl = Math.abs(exitPrice - entry) * (isLong ? 1 : -1) * (entry < exitPrice ? (isLong?1:-1) : (isLong?-1:1)) * PT - COMM; 
        
        // wait, pnl logic:
        if (!stopHit) {
          pnl = isLong ? (exitPrice - entry)*PT - COMM : (entry - exitPrice)*PT - COMM;
        }
        break;
      }
    }
    
    // if never flattened, exited at end of session
    if (pnl === null) {
      const exitPrice = trade.bars[trade.bars.length-1].close;
      pnl = isLong ? (exitPrice - trade.entryPrice)*PT - COMM : (trade.entryPrice - exitPrice)*PT - COMM;
    }
    return pnl;
  }

  // Sweeps
  const thresholdsRaw = [0.1, 0.25, 0.5, 1.0, 2.0];
  const thresholdsNorm = [0.05, 0.1, 0.2, 0.5];
  const durations = [2, 3, 4]; // 10, 15, 20 mins

  const res = { rth_cont: [], rth_rev: [], glbx_cont: [], glbx_rev: [] };
  
  function getBucket(w, m) {
    if (w === 'RTH') return m === 'CONTINUATION' ? res.rth_cont : res.rth_rev;
    return m === 'CONTINUATION' ? res.glbx_cont : res.glbx_rev;
  }

  for (const t of meaningful) {
    getBucket(t.window, t.mode).push(t);
  }

  const out = {};
  for (const [key, list] of Object.entries(res)) {
    if (list.length < 5) continue;
    const basePnl = list.reduce((s,x)=>s+x.baselinePnl,0)/list.length;
    
    // Structural
    const hasStruct = list.filter(x=>x.structPnl !== undefined);
    const structPnl = hasStruct.length ? hasStruct.reduce((s,x)=>s+x.structPnl,0)/hasStruct.length : null;
    
    let bestVwap = { pnl: -999, conf: '' };
    for (const d of durations) {
      for (const th of thresholdsRaw) {
        const ev = list.reduce((s,x)=>s+simulateVWAP(x, th, false, d),0)/list.length;
        if (ev > bestVwap.pnl) bestVwap = { pnl: ev, conf: `RAW th=${th} d=${d}` };
      }
      for (const th of thresholdsNorm) {
        const ev = list.reduce((s,x)=>s+simulateVWAP(x, th, true, d),0)/list.length;
        if (ev > bestVwap.pnl) bestVwap = { pnl: ev, conf: `NORM th=${th} d=${d}` };
      }
    }
    
    // PNL differences paired
    let structBeatCount = 0;
    for (const t of hasStruct) if (t.structPnl > t.baselinePnl) structBeatCount++;

    // Rigor check on the structural exit's own P&L (day-clustering / chronological stability) --
    // imported but never actually called in the original pass, added per user follow-up request.
    const structRigor = hasStruct.length >= 10
      ? computeRigor(hasStruct, { dateField: 'date', pnlFn: (x) => x.structPnl })
      : null;

    out[key] = {
      n: list.length,
      baselineEv: basePnl,
      structEv: structPnl,
      structRigor: structRigor ? { clean: structRigor.clean, distinctDates: structRigor.distinctDates, top5DayPct: structRigor.top5DayPct, stable: structRigor.stable, clustered: structRigor.clustered } : null,
      structWinRateVsBase: hasStruct.length ? structBeatCount / hasStruct.length : 0,
      bestVwapEv: bestVwap.pnl,
      bestVwapConf: bestVwap.conf
    };
  }
  
  fs.writeFileSync('scratch/pilot_exits_out.json', JSON.stringify(out, null, 2));
}

function processGlobexDay(d, bars, levels, calib, population) {
  if (bars.length < 40) return;
  const l = levels.get(d) || {};
  const vah = l['PD_VAH'], val = l['PD_VAL'];
  if (vah == null || val == null) return;
  
  let triggerIdx = null; let triggerDir = null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].close > vah) { triggerIdx = i; triggerDir = 'UP'; break; }
    if (bars[i].close < val) { triggerIdx = i; triggerDir = 'DOWN'; break; }
  }
  
  if (triggerIdx !== null) {
    const postBars = bars.slice(triggerIdx + 1);
    const res = computeBalanceAndResolution(postBars);
    if (res) {
      const mode = triggerDir === res.resolutionDir ? 'CONTINUATION' : 'REVERSAL';
      const setup = mode === 'CONTINUATION' ? `GLOBEX_FLUSH_${res.resolutionDir === 'UP'?'LONG':'SHORT'}` : `GLOBEX_FLUSH_REVERSAL_${res.resolutionDir === 'UP'?'LONG':'SHORT'}`;
      const c = calib[setup];
      if (c && c.tierTargets) {
        population.push({
          date: d, window: 'GLOBEX', dir: res.resolutionDir, mode, 
          entryIdx: triggerIdx + 1 + res.resolutionIdx, entryPrice: res.entryPrice, stopPrice: res.stopPrice,
          bars, levels: l, baselinePts: c.tierTargets[0] // using score=0 target for baseline comparison conservative
        });
      }
    }
  }
}

main().catch(console.error);
